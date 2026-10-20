/**
 * 逐項閱讀資料同步端到端驗收（真實 selfhost SQLite 後端 + 實際前端模組）。
 *
 * 用法：
 *   PORT=8313 PLAYWRIGHT_MODULE=<path-to-playwright> node tests/reading-sync-selfhost.cjs
 *
 * 覆蓋：
 *   1. 學習條目、詞書、關聯、會話、消息逐項上傳與另一裝置拉取
 *   2. 同條目不同欄位三方合併
 *   3. 同欄位衝突保留雙方、阻擋自動覆蓋，使用者選擇後才重送
 *   4. 刪除 tombstone 同步，離線裝置不把舊內容復活
 *   5. 帳戶 A / B 隔離
 *   6. 遷移完成後舊快照的詞書／聊天群組被伺服器擋下
 */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { createHash } = require('node:crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const ROOT = path.resolve(__dirname, '..');
const APP_PORT = Number(process.env.PORT || 8313);
const BASE = `http://127.0.0.1:${APP_PORT}/`;
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const TOKENS = { alice: 'a'.repeat(40), bob: 'b'.repeat(40), carol: 'c'.repeat(40) };

const failures = [];
function check(name, condition, detail) {
    if (condition) { console.log(`  ok   ${name}`); return true; }
    failures.push({ name, detail: detail === undefined ? '' : String(detail).slice(0, 600) });
    console.log(`  FAIL ${name}${detail !== undefined ? ' -- ' + String(detail).slice(0, 400) : ''}`);
    return false;
}

function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

function seedUsers(file) {
    const db = new DatabaseSync(file);
    db.exec(fs.readFileSync(path.join(ROOT, 'selfhost/schema.sql'), 'utf8'));
    const insert = db.prepare('INSERT OR REPLACE INTO users (token_hash, user_id, label, role) VALUES (?, ?, ?, ?)');
    insert.run(createHash('sha256').update(TOKENS.alice).digest('hex'), 'alice', 'Alice', 'user');
    insert.run(createHash('sha256').update(TOKENS.bob).digest('hex'), 'bob', 'Bob', 'user');
    insert.run(createHash('sha256').update(TOKENS.carol).digest('hex'), 'carol', 'Carol', 'user');
    db.close();
}

async function startServer(file) {
    const port = await freePort();
    const child = spawn(process.execPath, [path.join(ROOT, 'selfhost/server.mjs')], {
        env: { ...process.env, DB_DRIVER: 'sqlite', SQLITE_PATH: file, PORT: String(port), HOST: '127.0.0.1', ALLOWED_ORIGINS: '*' },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`selfhost 啟動逾時：${stderr}`)), 15000);
        child.stdout.on('data', (chunk) => {
            if (String(chunk).includes('listening on')) { clearTimeout(timer); resolve(); }
        });
        child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`selfhost 結束（${code}）：${stderr}`)); });
    });
    return {
        base: `http://127.0.0.1:${port}`,
        stop: () => new Promise((resolve) => { child.once('exit', () => resolve()); child.kill('SIGTERM'); })
    };
}

async function newPage(browser, endpoint, user = 'alice') {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(({ endpoint, user, token }) => {
        window.__BDC_SYNC_ENDPOINT__ = endpoint;
        try {
            localStorage.setItem('sync_token', token);
            localStorage.setItem('sync_user_id', user);
            localStorage.setItem('sync_label', user);
            localStorage.setItem('sync_role', 'user');
            const raw = localStorage.getItem('pen_global_settings');
            const parsed = raw ? JSON.parse(raw) : {};
            parsed.language = { ...(parsed.language || {}), interfaceLocale: 'zh-CN' };
            localStorage.setItem('pen_global_settings', JSON.stringify(parsed));
        } catch (_) {}
    }, { endpoint, user, token: TOKENS[user] });
    const page = await context.newPage();
    const errors = [];
    page.on('console', (m) => {
        if (m.type() !== 'error') return;
        const text = m.text();
        if (/401|404|501|Not Implemented|ai-credentials|ai-catalog|connection refused|ERR_CONNECTION_REFUSED|尚未选择模型|Error analyzing word/i.test(text)) return;
        errors.push(text.slice(0, 240));
    });
    page.on('pageerror', (e) => errors.push('PAGEERROR ' + String(e && e.stack ? e.stack.split('\n')[0] : e)));
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    await page.evaluate(() => {
        const modal = document.getElementById('app-modal');
        if (modal && !modal.classList.contains('hidden')) modal.querySelector('.modal-close-btn')?.click();
    });
    return { context, page, errors };
}

async function seedInitial(page, label) {
    return page.evaluate(async (label) => {
        const art = await import('/modules/article-store.js');
        const rd = await import('/modules/reading-store.js');
        const sync = await import('/modules/reading-sync.js');
        const { contentVersionOf } = await import('/shared/reading-protocol.mjs');
        await art.initArticleStore();
        await rd.initReadingStore();
        const body = `We look forward to meeting you. ${label}`;
        await art.saveArticle({
            articleId: `art_${label}`,
            article: body,
            title: `Article ${label}`,
            sourceType: 'paste',
            result: { chinese_translation: '期待見面', word_alignment: [], detailed_analysis: [], paragraph_analysis: [{ chinese_translation: '期待見面' }] }
        });
        const item = await rd.upsertLearningItem({
            articleId: `art_${label}`,
            contentVersion: contentVersionOf(body),
            kind: 'phrase',
            anchor: { start: 3, end: 23, quote: 'look forward to', prefix: 'We ', suffix: ' meeting' },
            sentence: 'We look forward to meeting you.',
            explanation: { language: 'zh-CN', result: { analysis: { meaning: '期待' } }, generatedAt: new Date().toISOString(), provenance: {} },
            note: 'base',
            marked: false,
            understanding: 'unmarked'
        }, { markViewed: true });
        const book = { id: `book_${label}`, name: `Book ${label}`, sourceType: 'article', createdAt: new Date().toISOString() };
        const entry = { id: `entry_${label}`, bookId: `book_${label}`, word: 'look forward to', meaning: '期待', examples: [], sources: [], addedAt: new Date().toISOString() };
        await rd.addVocabularyEntryWithLink({
            book,
            entry,
            link: { id: `link_${label}`, itemId: item.entity.id, bookId: book.id, entryId: entry.id, addedAt: new Date().toISOString() }
        });
        const conv = await rd.ensureConversation({ id: `conv_${label}`, articleId: `art_${label}`, title: `Chat ${label}` });
        await rd.appendMessage({ conversationId: conv.conversation.id, role: 'user', content: 'question '.repeat(60) });
        await rd.appendMessage({ conversationId: conv.conversation.id, role: 'assistant', content: 'answer' });
        const out = await sync.syncReading();
        return { itemId: item.entity.id, out, counts: await rd.permanentEntityCounts() };
    }, label);
}

async function sync(page) {
    return page.evaluate(async () => (await import('/modules/reading-sync.js')).syncReading());
}

async function snapshotLocal(page) {
    return page.evaluate(async () => {
        const rd = await import('/modules/reading-store.js');
        return {
            items: rd.listLearningItems('art_alice').map((item) => ({ id: item.id, note: item.note, marked: item.marked, deletedAt: item.deletedAt, revision: item.revision })),
            books: rd.listVocabularyBooks().length,
            entries: rd.listVocabularyEntries().length,
            links: rd.listVocabularyLinks().length,
            conversations: rd.listConversations().length,
            messages: (await rd.getMessages('conv_alice')).length,
            conflicts: rd.getReadingConflicts().map((item) => ({ type: item.entityType, id: item.entityId, fields: item.fields })),
            pending: (await rd.listOutbox()).length
        };
    });
}

async function api(endpoint, token, apiPath, options = {}) {
    const res = await fetch(endpoint + apiPath, {
        method: options.method || 'GET',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    let body = null;
    try { body = await res.json(); } catch (_) {}
    return { status: res.status, body };
}

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-reading-e2e-'));
    const file = path.join(dir, 'sync.sqlite');
    seedUsers(file);
    const server = await startServer(file);
    const browser = await chromium.launch({ headless: true, executablePath: CHROME });
    try {
        console.log('\n[帳戶 A：首次逐項上傳]');
        const a = await newPage(browser, server.base, 'alice');
        const first = await seedInitial(a.page, 'alice');
        check('首次同步完成且 outbox 清空', first.out.ok && first.out.pending === 0, JSON.stringify(first));
        check('首次上傳 7 個實體（條目／詞書／詞條／關聯／會話／2 消息）', first.out.pushed === 7, JSON.stringify(first.counts));

        console.log('\n[帳戶 A 第二裝置：拉取]');
        const b = await newPage(browser, server.base, 'alice');
        const pulled = await sync(b.page);
        const bState = await snapshotLocal(b.page);
        check('第二裝置拉到條目、詞書、關聯、會話與消息', pulled.ok && bState.items.length === 1 && bState.books === 1 && bState.links === 1 && bState.conversations === 1 && bState.messages === 2, JSON.stringify(bState));

        console.log('\n[不同欄位：A 改筆記、B 改標記]');
        await a.page.evaluate(async (id) => {
            const rd = await import('/modules/reading-store.js');
            await rd.patchLearningItem(id, { note: 'A note' });
        }, first.itemId);
        await sync(a.page);
        await b.page.evaluate(async (id) => {
            const rd = await import('/modules/reading-store.js');
            await rd.patchLearningItem(id, { marked: true });
        }, first.itemId);
        const merged = await sync(b.page);
        const mergedState = await snapshotLocal(b.page);
        check('不同欄位合併，不產生衝突', merged.ok && mergedState.items.find((item) => item.id === first.itemId)?.note === 'A note' && mergedState.items.find((item) => item.id === first.itemId)?.marked === true && mergedState.conflicts.length === 0, JSON.stringify(mergedState));

        console.log('\n[刪除 vs 修改：保留雙方可見，使用者選擇後復活]');
        const secondItem = await a.page.evaluate(async () => {
            const rd = await import('/modules/reading-store.js');
            const { contentVersionOf } = await import('/shared/reading-protocol.mjs');
            const record = (await import('/modules/article-store.js')).getRecord('art_alice');
            const item = await rd.upsertLearningItem({
                articleId: 'art_alice',
                contentVersion: contentVersionOf(record.article),
                kind: 'word',
                anchor: { start: 0, end: 2, quote: 'We', prefix: '', suffix: ' look' },
                sentence: record.article.split('.')[0] + '.',
                note: 'second item',
                marked: false,
                understanding: 'unmarked'
            }, { markViewed: true });
            return item.entity.id;
        });
        await sync(a.page);
        await sync(b.page);
        await a.page.evaluate(async (id) => {
            const rd = await import('/modules/reading-store.js');
            await rd.deleteLearningItem(id);
        }, secondItem);
        await sync(a.page);
        // B 還沒拉刪除，直接改筆記；拉取時應形成 delete-vs-edit 衝突而不是默默消失。
        await b.page.evaluate(async (id) => {
            const rd = await import('/modules/reading-store.js');
            await rd.patchLearningItem(id, { note: 'edit before seeing delete' });
        }, secondItem);
        const tombstoneConflict = await sync(b.page);
        const tombstoneState = await b.page.evaluate(async (id) => {
            const rd = await import('/modules/reading-store.js');
            const item = rd.getLearningItem(id);
            return { item, conflicts: rd.getReadingConflicts().map((c) => c.fields) };
        }, secondItem);
        check('遠端刪除與本機編輯形成衝突且本機內容仍可見', tombstoneConflict.ok
            && tombstoneState.item && tombstoneState.item.deletedAt === ''
            && tombstoneState.item.note === 'edit before seeing delete'
            && tombstoneState.conflicts.length === 1, JSON.stringify(tombstoneState));
        await b.page.evaluate(async (id) => {
            const syncMod = await import('/modules/reading-sync.js');
            await syncMod.resolveReadingConflict('learningItem', id, 'keep-local');
        }, secondItem);
        const restoredSecond = await api(server.base, TOKENS.alice, '/reading/batch', { method: 'POST', body: { keys: [{ entityType: 'learningItem', entityId: secondItem }] } });
        check('使用者選擇保留本機後，明確復活且保留筆記', restoredSecond.body.entities[0].deletedAt === ''
            && restoredSecond.body.entities[0].note === 'edit before seeing delete', JSON.stringify(restoredSecond.body.entities[0]));

        console.log('\n[同欄位：A 改筆記、B 同時改筆記]');
        await a.page.evaluate(async (id) => {
            const rd = await import('/modules/reading-store.js');
            await rd.patchLearningItem(id, { note: 'A2' });
        }, first.itemId);
        await sync(a.page);
        await b.page.evaluate(async (id) => {
            const rd = await import('/modules/reading-store.js');
            await rd.patchLearningItem(id, { note: 'B2' });
        }, first.itemId);
        const conflict = await sync(b.page);
        const conflictState = await snapshotLocal(b.page);
        check('同欄位矛盾保留本機值與衝突記錄，且不自動覆蓋', conflictState.items.find((item) => item.id === first.itemId)?.note === 'B2' && conflictState.conflicts.length === 1 && conflictState.conflicts[0].fields.includes('note'), JSON.stringify(conflictState));
        const serverBefore = await api(server.base, TOKENS.alice, '/reading/batch', { method: 'POST', body: { keys: [{ entityType: 'learningItem', entityId: first.itemId }] } });
        check('衝突未處理前伺服器仍是另一版本', serverBefore.body.entities[0].note === 'A2', JSON.stringify(serverBefore.body.entities[0]));

        await b.page.evaluate(async (id) => {
            const syncMod = await import('/modules/reading-sync.js');
            await syncMod.resolveReadingConflict('learningItem', id, 'keep-local');
        }, first.itemId);
        const serverAfter = await api(server.base, TOKENS.alice, '/reading/batch', { method: 'POST', body: { keys: [{ entityType: 'learningItem', entityId: first.itemId }] } });
        check('使用者選擇保留本機後才重送並成功', serverAfter.body.entities[0].note === 'B2' && serverAfter.body.entities[0].marked === true, JSON.stringify(serverAfter.body.entities[0]));

        console.log('\n[刪除 tombstone 與離線裝置復活]');
        // A 先拉取 B 剛才的版本，才不會用舊 revision 刪除而產生另一個衝突。
        await sync(a.page);
        await a.page.evaluate(async (id) => {
            const rd = await import('/modules/reading-store.js');
            await rd.deleteLearningItem(id);
        }, first.itemId);
        await sync(a.page);
        await sync(b.page);
        const deletedState = await snapshotLocal(b.page);
        check('刪除同步到另一裝置並保留 tombstone', deletedState.items.find((item) => item.id === first.itemId)?.deletedAt !== '', JSON.stringify(deletedState.items));
        await b.page.evaluate(async (id) => {
            const rd = await import('/modules/reading-store.js');
            await rd.patchLearningItem(id, { note: 'offline revive?' }).catch(() => {});
        }, first.itemId);
        await sync(b.page);
        const afterSync = await snapshotLocal(b.page);
        check('離線舊內容不會讓已刪條目復活', afterSync.items.find((item) => item.id === first.itemId)?.deletedAt !== '', JSON.stringify(afterSync.items));

        console.log('\n[舊後端能力閘門：缺 learningItemMarked 時保留 outbox]');
        await a.context.route('**/reading/capabilities', (route) => route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ supported: true, legacyWriteBlocked: true, cursor: 0 })
        }));
        await a.page.evaluate(async (id) => {
            const rd = await import('/modules/reading-store.js');
            await rd.patchLearningItem(id, { note: 'gated local change', marked: true });
        }, secondItem);
        const gated = await sync(a.page);
        const gatedState = await snapshotLocal(a.page);
        const serverDuringGate = await api(server.base, TOKENS.alice, '/reading/batch', { method: 'POST', body: { keys: [{ entityType: 'learningItem', entityId: secondItem }] } });
        check('能力不足時同步停止並保留待同步修改', gated.ok === false
            && gated.error === 'server_update_required'
            && gatedState.pending >= 1
            && serverDuringGate.body.entities[0].note !== 'gated local change', JSON.stringify({ gated, gatedState, server: serverDuringGate.body.entities[0] }));
        await a.context.unroute('**/reading/capabilities');
        const afterGateSync = await sync(a.page);
        const serverAfterGate = await api(server.base, TOKENS.alice, '/reading/batch', { method: 'POST', body: { keys: [{ entityType: 'learningItem', entityId: secondItem }] } });
        check('後端支援後同一筆 outbox 可正常補送', afterGateSync.ok && serverAfterGate.body.entities[0].note === 'gated local change' && serverAfterGate.body.entities[0].marked === true, JSON.stringify(serverAfterGate.body.entities[0]));

        console.log('\n[帳戶隔離]');
        const c = await newPage(browser, server.base, 'bob');
        const bobSync = await sync(c.page);
        const bobState = await snapshotLocal(c.page);
        check('Bob 不會看到 Alice 的條目／詞書／聊天', bobSync.ok && bobState.items.length === 0 && bobState.books === 0 && bobState.conversations === 0, JSON.stringify(bobState));

        console.log('\n[舊 snapshot 在關閘前移交]');
        const legacyMessages = Array.from({ length: 60 }, (_, index) => ({
            role: index % 2 === 0 ? 'user' : 'assistant',
            content: `legacy snapshot message ${index + 1}`,
            ts: Date.now() + index
        }));
        const seededSnapshot = await api(server.base, TOKENS.carol, '/snapshot', {
            method: 'POST',
            body: {
                expected_version: 0,
                payload: {
                    vocabulary: {
                        books: [{
                            id: 'legacy_carol_book',
                            name: 'Legacy Carol',
                            sourceType: 'article',
                            createdAt: new Date().toISOString(),
                            words: [{ id: 'legacy_carol_word', word: 'look forward to', meaning: '期待', addedAt: new Date().toISOString() }]
                        }]
                    },
                    assistant: {
                        conversations: [{ id: 'legacy_carol_conv', articleKey: 'legacy-hash', title: 'Legacy Carol Chat', messages: legacyMessages }]
                    }
                }
            }
        });
        check('舊 snapshot 已建立', seededSnapshot.status === 200, JSON.stringify(seededSnapshot));
        const carol = await newPage(browser, server.base, 'carol');
        const carolSync = await sync(carol.page);
        const carolState = await carol.page.evaluate(async () => {
            const rd = await import('/modules/reading-store.js');
            const syncMod = await import('/modules/reading-sync.js');
            const caps = await syncMod.getReadingCapabilities();
            return {
                books: rd.listVocabularyBooks().map((book) => book.id),
                entries: rd.listVocabularyEntries().length,
                conversations: rd.listConversations().length,
                messages: (await rd.getMessages('legacy_carol_conv')).length,
                gate: !!caps.legacyWriteBlocked
            };
        });
        check('新裝置先移交舊 snapshot 詞書／聊天再關閘', carolSync.ok && carolState.books.includes('legacy_carol_book')
            && carolState.entries >= 1 && carolState.messages === 60 && carolState.gate === true, JSON.stringify(carolState));
        const snapshotAfterGate = await api(server.base, TOKENS.carol, '/snapshot', { method: 'GET' });
        check('關閘後舊 snapshot 不再回傳詞書／聊天群組', snapshotAfterGate.status === 200
            && !snapshotAfterGate.body?.payload?.vocabulary && !snapshotAfterGate.body?.payload?.assistant, JSON.stringify(snapshotAfterGate.body));
        console.log('\n[舊快照閘門]');
        const legacySnapshot = await api(server.base, TOKENS.alice, '/snapshot', {
            method: 'POST',
            body: { expected_version: 0, payload: { vocabulary: { books: [{ id: 'old', words: [] }] }, assistant: { conversations: [{ id: 'old', messages: [] }] } } }
        });
        check('遷移後的舊快照詞書／聊天寫入被拒', legacySnapshot.status === 409 && legacySnapshot.body.code === 'reading_legacy_write_blocked', JSON.stringify(legacySnapshot));

        const allErrors = [...a.errors, ...b.errors, ...c.errors, ...carol.errors];
        check('同步流程沒有 console/page 錯誤', allErrors.length === 0, allErrors.join('\n'));
    } finally {
        await browser.close();
        await server.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    }
    if (failures.length) {
        console.error(`\n${failures.length} 項失敗`);
        for (const failure of failures) console.error(`- ${failure.name}: ${failure.detail}`);
        process.exit(1);
    }
    console.log('\n全部逐項同步測試通過');
})();
