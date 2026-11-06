// Actual MV3 + actual Worker/SQLite + website modules. Only AI transport is a mock.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const ROOT = path.resolve(__dirname, '..');
const stamp = new Date(Date.now() + 8 * 3600000).toISOString().replace(/\D/g, '').slice(0, 17);
const OUT = process.env.CAPTURE_E2E_OUTPUT || path.join(ROOT, 'docs/report/assets', stamp + '_extension-capture');
const ALICE = 'a'.repeat(43);
const BOB = 'b'.repeat(43);
const ADMIN = 'z'.repeat(43);
const AI_KEY = 'sk-capture-fixture-not-real';
const checks = [];

function check(name, condition, detail) {
    checks.push({ name, ok: !!condition, ...(detail ? { detail } : {}) });
    console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`);
    assert.ok(condition, name + (detail ? ': ' + JSON.stringify(detail) : ''));
}
async function listen(server) {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${server.address().port}`;
}

async function environment() {
    const worker = (await import(pathToFileURL(path.join(ROOT, 'cloudflare-worker/src/worker.js')))).default;
    const { createD1Adapter, createSqliteDatabase } = await import(pathToFileURL(path.join(ROOT, 'selfhost/d1-adapter.js')));
    const db = new DatabaseSync(':memory:');
    db.exec(fs.readFileSync(path.join(ROOT, 'cloudflare-worker/schema.sql'), 'utf8'));
    for (const [id, token, role] of [['alice', ALICE, 'user'], ['bob', BOB, 'user'], ['admin', ADMIN, 'admin']]) {
        db.prepare('INSERT INTO users(token_hash,user_id,label,role) VALUES(?,?,?,?)').run(createHash('sha256').update(token).digest('hex'), id, id, role);
    }
    for (const [owner, id, name] of [['alice', 'book', '单词本'], ['alice', 'book-2', 'Reading'], ['bob', 'bob-book', 'Bob only']]) {
        db.prepare('INSERT INTO reading_entities VALUES(?,?,?,?,?,?,?,?)').run(owner, 'vocabularyBook', id, 1, null, JSON.stringify({ name }), '2026-11-01', 'seed');
        db.prepare('INSERT INTO reading_state(owner_user_id,next_seq,updated_at) VALUES(?,?,?) ON CONFLICT(owner_user_id) DO UPDATE SET next_seq=next_seq+1').run(owner, 2, '2026-11-01');
        const seq = db.prepare('SELECT next_seq-1 AS seq FROM reading_state WHERE owner_user_id=?').get(owner).seq;
        db.prepare('INSERT INTO reading_changes VALUES(?,?,?,?,?,?,?)').run(owner, seq, 'vocabularyBook', id, 'upsert', 1, '2026-11-01');
    }
    const env = { DB: createD1Adapter(createSqliteDatabase(db)), ALLOWED_ORIGINS: '*',
        AI_CREDENTIAL_KEY_V1: Buffer.alloc(32, 7).toString('base64'), AI_CREDENTIAL_KEY_VERSION: '1', AI_CATALOG_DIGEST_KEY: 'catalog-test-digest-key-32-characters' };
    const state = { aiCalls: 0, captureCalls: [], failCaptures: false, loseNextReply: false };
    let base;
    const server = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url, base);
            let raw = '';
            for await (const chunk of req) raw += chunk;
            if (url.pathname === '/test-article') {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                return res.end('<title>Major tech stocks plunge</title><p id="article">Major tech stocks plunge as investors worry. Markets remain volatile.</p>');
            }
            if (url.pathname.startsWith('/mock-ai/')) {
                const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Content-Type': 'application/json' };
                if (req.method === 'OPTIONS') { res.writeHead(204, headers); return res.end(); }
                state.aiCalls += 1;
                const hk = raw.includes('香港繁體中文');
                res.writeHead(200, headers);
                return res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
                    word: 'plunge', analysis: { meaning: hk ? '急跌（語境）' : '暴跌（语境）', phonetic: 'plʌndʒ', pos: 'verb', role: hk ? '描述價格下跌' : '描述价格下跌' }
                }) } }] }));
            }
            if (url.pathname === '/captures' && req.method === 'POST') {
                state.captureCalls.push(JSON.parse(raw));
                if (state.failCaptures) {
                    res.writeHead(503, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
                    return res.end('{"code":"capture_failed"}');
                }
            }
            const response = await worker.fetch(new Request(url, {
                method: req.method, headers: req.headers,
                ...(['GET', 'HEAD'].includes(req.method) ? {} : { body: raw || undefined })
            }), env);
            if (url.pathname === '/captures' && state.loseNextReply) {
                state.loseNextReply = false;
                res.writeHead(503, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
                return res.end('{"code":"capture_failed"}');
            }
            res.writeHead(response.status, Object.fromEntries(response.headers));
            res.end(Buffer.from(await response.arrayBuffer()));
        } catch (error) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }
    });
    base = await listen(server);
    const tasks = Object.fromEntries(['wordAnalysis', 'articleWordTranslation', 'articlePhraseTranslation'].map((task) => [task, { providerId: 'managed-capture', model: 'capture-model' }]));
    const publish = await fetch(base + '/admin/ai-catalog/publish', {
        method: 'POST', headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseVersion: 0, mutationId: 'publish-capture-test', config: { schemaVersion: 1, providers: [{
            id: 'managed-capture', name: 'Capture Test', enabled: true, order: 0, format: 'openai-chat',
            apiUrl: base + '/mock-ai/v1/chat/completions', modelsUrl: base + '/mock-ai/v1/models', authMode: 'bearer', models: [{ id: 'capture-model' }]
        }], tasks }, keyOps: { 'managed-capture': { action: 'replace', apiKey: AI_KEY } } })
    });
    assert.equal(publish.status, 200, JSON.stringify(await publish.json()));
    const appServer = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://localhost');
        if (url.pathname === '/__capture-test.html') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            return res.end('<!doctype html><title>Capture module verification</title><body></body>');
        }
        let relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
        if (relative === 'ai-config.js') relative = 'ai-config.example.js';
        const file = path.resolve(ROOT, relative);
        if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end(); }
        fs.readFile(file, (error, bytes) => {
            if (error) { res.writeHead(404); return res.end(); }
            const type = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream';
            res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(bytes);
        });
    });
    const appBase = await listen(appServer);
    return { base, appBase, state, db, async close() { await Promise.all([new Promise((r) => server.close(r)), new Promise((r) => appServer.close(r))]); db.close(); } };
}

async function connect(page, endpoint, token = ALICE) {
    await page.locator('#ext-endpoint-input').fill(endpoint);
    await page.locator('#ext-login-mode').selectOption('token');
    await page.locator('#ext-token-input').fill(token);
    await page.locator('#ext-connect-btn').click();
    await page.waitForFunction(() => !document.querySelector('#ext-connect-btn').disabled);
    await page.waitForFunction(() => document.querySelector('#ext-capture-book').options.length > 1);
}
async function lookup(page, sentence) {
    await page.locator('#ext-word-input').fill('plunge');
    await page.locator('#ext-sentence-input').fill(sentence);
    await page.locator('#ext-lookup-btn').click();
    await page.waitForFunction(() => !document.querySelector('#ext-lookup-btn').disabled);
    assert.ok(await page.locator('#ext-result-meaning').textContent());
}
async function outbox(page) {
    return page.evaluate(async () => Object.values(await chrome.storage.local.get(null)).filter((value) => value?.payload?.requestId && value?.endpoint));
}
async function waitSaved(page) {
    await page.waitForFunction(() => /已加入/.test(document.querySelector('#ext-capture-save').textContent));
}

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    execFileSync(process.execPath, ['scripts/package-extension.mjs'], { cwd: ROOT, stdio: 'inherit' });
    let testEnv, context;
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-capture-e2e-'));
    const pageErrors = [];
    try {
        testEnv = await environment();
        const { base, appBase, state, db } = testEnv;
        const ext = path.join(ROOT, 'extension');
        context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, viewport: { width: 400, height: 1000 },
            args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
        context.on('page', (page) => page.on('pageerror', (error) => pageErrors.push(error.message)));
        const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
        const extUrl = `chrome-extension://${new URL(sw.url()).host}/lookup.html`;
        let page = await context.newPage();
        await page.goto(extUrl);
        await connect(page, base);
        check('真實 SQLite 詞書列表及帳戶隔離', await page.locator('#ext-capture-book option').allTextContents().then((values) => values.includes('Reading') && !values.includes('Bob only')));
        check('完成查詞前不能收藏', await page.locator('#ext-capture-save').isDisabled());
        check('無 BDC 主站分頁也可使用', context.pages().every((p) => !p.url().startsWith(appBase)));

        const article = await context.newPage();
        await article.goto(base + '/test-article');
        await article.evaluate(() => {
            const text = document.querySelector('#article').firstChild;
            const start = text.textContent.indexOf('plunge');
            const range = document.createRange(); range.setStart(text, start); range.setEnd(text, start + 6);
            const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
        });
        await article.bringToFront();
        await page.evaluate(() => document.querySelector('#ext-extract-btn').click());
        await page.waitForFunction(() => document.querySelector('#ext-word-input').value === 'plunge');
        await page.locator('#ext-capture-book').selectOption('book');
        await page.locator('#ext-lookup-btn').click();
        await page.waitForFunction(() => !document.querySelector('#ext-lookup-btn').disabled);
        await page.waitForFunction(() => !document.querySelector('#ext-capture-save').disabled);
        const calls = state.aiCalls;
        await page.locator('#ext-capture-save').click();
        await waitSaved(page);
        const first = db.prepare("SELECT * FROM reading_entities WHERE entity_type='vocabularyEntry' AND owner_user_id='alice'").get();
        const saved = JSON.parse(first.data_json);
        check('明確收藏後詞條與網頁來源已提交', saved.bookId === 'book' && saved.sources[0].sourceUrl === base + '/test-article' && saved.sources[0].pageTitle === 'Major tech stocks plunge');
        check('保存已展示的意思且不重新呼叫 AI', saved.meaning.includes('暴跌') && state.aiCalls === calls);
        check('保存選詞定位、原句及當次意思', saved.sources[0].anchor.start >= 0 && saved.sources[0].sentence.includes('stocks plunge') && saved.sources[0].meaning === saved.meaning);
        check('成功回執後待傳清除', (await outbox(page)).length === 0);

        await lookup(page, 'Stocks plunge again.');
        check('手動修改查詢清除舊來源網址', await page.locator('#ext-capture-source a').count() === 0);
        await page.locator('#ext-capture-book').selectOption('book-2');
        state.loseNextReply = true;
        await page.locator('#ext-capture-save').click();
        await page.waitForFunction(() => !document.querySelector('#ext-capture-save').textContent.includes('正在'));
        await page.waitForFunction(async () => Object.keys(await chrome.storage.local.get(null)).some((key) => key.startsWith('bdc_capture_outbox_v1:')));
        const pendingBefore = (await outbox(page))[0];
        check('提交後回應遺失仍保留原 requestId 待傳', !!pendingBefore && db.prepare('SELECT COUNT(*) AS n FROM vocabulary_captures').get().n === 2);
        await page.close();
        const replayResponse = context.waitForEvent('response', {
            predicate: (response) => new URL(response.url()).pathname === '/captures'
                && response.request().postDataJSON()?.requestId === pendingBefore.payload.requestId,
            timeout: 20000
        });
        page = await context.newPage(); await page.goto(extUrl);
        await replayResponse;
        await page.waitForFunction(async () => !Object.keys(await chrome.storage.local.get(null)).some((key) => key.startsWith('bdc_capture_outbox_v1:')));
        const replayCount = state.captureCalls.filter((call) => call.requestId === pendingBefore.payload.requestId).length;
        const receiptCount = db.prepare('SELECT COUNT(*) AS n FROM vocabulary_captures').get().n;
        const secondEntry = db.prepare("SELECT data_json FROM reading_entities WHERE entity_type='vocabularyEntry' AND owner_user_id='alice'").all()
            .map((row) => JSON.parse(row.data_json)).find((entry) => entry.bookId === 'book-2');
        check('重開面板使用原回執恢復，沒有重複來源', receiptCount === 2 && replayCount >= 2 && secondEntry?.sources.length === 1,
            { replayCount, receiptCount, sourceCount: secondEntry?.sources.length });

        state.failCaptures = true;
        await lookup(page, 'Prices plunge on Friday.');
        await page.locator('#ext-capture-book').selectOption('book');
        await page.locator('#ext-capture-save').click();
        await page.waitForFunction(() => !document.querySelector('#ext-capture-save').textContent.includes('正在'));
        check('服務暫時不可用時不誤報成功', (await outbox(page)).length === 1 && !(await page.locator('#ext-capture-save').textContent()).includes('已加入'));
        const queued = JSON.stringify(await outbox(page));
        check('本機待傳不保存登入 token 或 AI Key', !queued.includes(ALICE) && !queued.includes(AI_KEY));
        await page.close(); page = await context.newPage(); await page.goto(extUrl);
        await page.waitForFunction(() => document.querySelector('#ext-capture-book').options.length > 1);
        check('關閉再開仍保留待傳', (await outbox(page)).length === 1);
        state.failCaptures = false;
        await page.locator('#ext-capture-refresh').click();
        await page.waitForFunction(async () => !Object.keys(await chrome.storage.local.get(null)).some((key) => key.startsWith('bdc_capture_outbox_v1:')));
        check('恢復服務並重試後保存完成', JSON.parse(db.prepare('SELECT data_json FROM reading_entities WHERE entity_id=?').get(first.entity_id).data_json).sources.length === 2);

        state.failCaptures = true;
        await lookup(page, 'Shares plunge before the close.');
        await page.locator('#ext-capture-save').click();
        await page.waitForFunction(() => !document.querySelector('#ext-capture-save').textContent.includes('正在'));
        const callsBeforeSwitch = state.captureCalls.length;
        const receiptsBeforeSwitch = db.prepare('SELECT COUNT(*) AS n FROM vocabulary_captures').get().n;
        await page.locator('#ext-logout-btn').click();
        state.failCaptures = false;
        await connect(page, base, BOB);
        check('切換帳戶只顯示新帳戶詞書', await page.locator('#ext-capture-book option').allTextContents().then((values) => values.includes('Bob only') && !values.includes('Reading')));
        check('切換帳戶不傳送前帳戶的待傳', state.captureCalls.length === callsBeforeSwitch && db.prepare('SELECT COUNT(*) AS n FROM vocabulary_captures').get().n === receiptsBeforeSwitch);
        await page.locator('#ext-logout-btn').click();
        await connect(page, base, ALICE);
        await page.waitForFunction(async () => !Object.keys(await chrome.storage.local.get(null)).some((key) => key.startsWith('bdc_capture_outbox_v1:')));
        check('返回原帳戶才恢復其待傳', db.prepare('SELECT COUNT(*) AS n FROM vocabulary_captures').get().n === receiptsBeforeSwitch + 1);

        await lookup(page, 'Markets plunge after the announcement.');
        await page.locator('#ext-capture-book').selectOption('book-2');
        db.exec("UPDATE reading_entities SET deleted_at='2026-11-06',revision=revision+1 WHERE entity_id='book-2'");
        await page.locator('#ext-capture-save').click();
        await page.waitForFunction(() => !document.querySelector('#ext-capture-save').textContent.includes('正在'));
        check('目標詞書刪除後明確保留待傳並報錯', (await outbox(page)).length === 1 && /不存在|删除|刪除/.test(await page.locator('#ext-capture-notice').textContent()));
        await page.locator('#ext-capture-refresh').click();
        await page.waitForFunction(() => !Array.from(document.querySelector('#ext-capture-book').options).some((option) => option.value === 'book-2'));
        check('刪除目標不會悄悄改存另一個詞書', await page.locator('#ext-capture-book').inputValue() === '' && await page.locator('#ext-capture-save').isDisabled());
        await page.locator('#ext-capture-pending summary').click();
        await page.locator('#ext-capture-pending-list li button').nth(1).click();
        await page.waitForFunction(async () => !Object.keys(await chrome.storage.local.get(null)).some((key) => key.startsWith('bdc_capture_outbox_v1:')));
        check('可明確取消本機待傳', (await outbox(page)).length === 0);

        const app = await context.newPage();
        await app.addInitScript(({ endpoint, token }) => {
            window.__BDC_SYNC_ENDPOINT__ = endpoint;
            localStorage.setItem('sync_token', token); localStorage.setItem('sync_user_id', 'alice'); localStorage.setItem('sync_label', 'alice'); localStorage.setItem('sync_role', 'user');
            localStorage.setItem('vocabImportPromptShown', '1');
            localStorage.setItem('pen_global_settings', JSON.stringify({ language: { interfaceLocale: 'zh-HK' } }));
        }, { endpoint: base, token: ALICE });
        await app.goto(appBase + '/?module=vocabulary');
        const synced = await app.evaluate(async () => {
            const art = await import('/modules/article-store.js');
            const rd = await import('/modules/reading-store.js');
            await art.initArticleStore(); await rd.initReadingStore();
            const info = await (await import('/modules/reading-sync.js')).syncReading();
            const backup = await rd.exportAll();
            return { info, books: rd.vocabularyBooksForUi(), backup };
        });
        check('主站逐項同步看見新詞條', synced.books.find((book) => book.id === 'book')?.words.some((word) => word.word === 'plunge'));
        await app.locator('#vocab-book-list li').filter({ hasText: '单词本' }).first().click();
        await app.locator('.word-sources summary').first().click();
        check('主站顯示原網頁、原句及當次意思', await app.locator('.word-source a').first().getAttribute('href') === base + '/test-article'
            && (await app.locator('.word-sources').first().textContent()).includes('當時釋義'));
        fs.writeFileSync(path.join(OUT, 'reading-export-shape.json'), JSON.stringify({ keys: Object.keys(synced.backup), ok: synced.backup.ok }, null, 2));
        await app.screenshot({ path: path.join(OUT, 'website-source-zh-HK.png'), fullPage: true });

        const restoredContext = await context.browser().newContext();
        try {
            const restoredPage = await restoredContext.newPage();
            await restoredPage.addInitScript(({ endpoint, token }) => {
                window.__BDC_SYNC_ENDPOINT__ = endpoint;
                localStorage.setItem('sync_token', token); localStorage.setItem('sync_user_id', 'alice');
            }, { endpoint: base, token: ALICE });
            await restoredPage.goto(appBase + '/__capture-test.html');
            const restored = await restoredPage.evaluate(async (backup) => {
                const art = await import('/modules/article-store.js');
                const rd = await import('/modules/reading-store.js');
                await art.initArticleStore(); await rd.initReadingStore();
                const result = await rd.restoreAll(backup);
                return { result, entries: (await rd.exportAll()).vocabularyEntries };
            }, synced.backup);
            const restoredWord = restored.entries.find((entry) => entry.id === first.entity_id);
            check('空白瀏覽器備份還原保留來源網址及當次意思', restored.result.ok && restoredWord?.sources[0]?.sourceUrl === base + '/test-article'
                && restoredWord.sources[0].meaning === saved.meaning);
            const fullSources = await restoredPage.evaluate(async () => {
                const rd = await import('/modules/reading-store.js');
                const sources = Array.from({ length: 100 }, (_, i) => ({ sourceUrl: `https://limit.example/${i}`, sentence: 'Existing', meaning: 'Existing', anchor: { start: -1, end: -1, quote: 'limit' } }));
                const entry = { id: 'limit-entry', bookId: 'book', word: 'limit', meaning: 'Existing', sources };
                await rd.upsertVocabularyEntry(entry);
                const incoming = { ...entry, sources: [...sources, { sourceUrl: 'https://limit.example/new', sentence: 'New', meaning: 'New' }] };
                const single = await rd.upsertVocabularyEntry(incoming);
                const composite = await rd.addVocabularyEntryWithLink({ book: { id: 'book' }, entry: incoming });
                return { single, composite, sourceCount: rd.getVocabularyEntry('limit-entry').sources.length };
            });
            check('主站直接保存及複合交易均拒絕第101個來源', !fullSources.single.ok && !fullSources.composite.ok
                && fullSources.single.error === 'vocabulary_sources_full' && fullSources.composite.error === 'vocabulary_sources_full' && fullSources.sourceCount === 100, fullSources);
        } finally { await restoredContext.close(); }

        const pollPage = await context.newPage();
        await pollPage.addInitScript(({ endpoint, token }) => {
            window.__BDC_SYNC_ENDPOINT__ = endpoint;
            localStorage.setItem('sync_token', token); localStorage.setItem('sync_user_id', 'alice');
        }, { endpoint: base, token: ALICE });
        await pollPage.goto(appBase + '/__capture-test.html');
        await pollPage.evaluate(async () => {
            const art = await import('/modules/article-store.js');
            const rd = await import('/modules/reading-store.js');
            await art.initArticleStore(); await rd.initReadingStore();
            await (await import('/modules/reading-sync.js')).syncReading();
            window.__capturePollEvents = [];
            window.__capturePollChannel = (await import('/modules/sync-cloudflare.js')).subscribeSnapshotChanges('alice', (event) => window.__capturePollEvents.push(event));
        });
        const versionBefore = (await (await fetch(base + '/version', { headers: { Authorization: `Bearer ${ALICE}` } })).json()).version;
        const foregroundSave = await fetch(base + '/captures', {
            method: 'POST', headers: { Authorization: `Bearer ${ALICE}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ requestId: 'foreground-probe', bookId: 'book', word: 'gather', meaning: '收集' })
        });
        assert.equal(foregroundSave.status, 200);
        const versionAfter = (await (await fetch(base + '/version', { headers: { Authorization: `Bearer ${ALICE}` } })).json()).version;
        await pollPage.evaluate(() => dispatchEvent(new Event('focus')));
        await pollPage.waitForFunction(() => window.__capturePollEvents.some((event) => event.eventType === 'reading'));
        check('快照版本不變仍可於返回前景發現新收藏', versionBefore === versionAfter);
        await pollPage.evaluate(async () => (await import('/modules/sync-cloudflare.js')).unsubscribeChannel(window.__capturePollChannel));
        await pollPage.close();
        await app.evaluate(() => dispatchEvent(new Event('focus')));
        await app.waitForFunction(() => document.querySelector('#word-list')?.textContent.includes('gather'), null, { timeout: 35000 });
        check('返回實際主站自動同步並更新詞書畫面', (await app.locator('#word-list').textContent()).includes('gather'));

        await page.locator('#ext-locale-select').selectOption('zh-HK');
        check('香港繁體收藏介面及窄畫面', await page.locator('#ext-capture-save').textContent() === '加入詞書'
            && await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.screenshot({ path: path.join(OUT, 'extension-capture-zh-HK.png'), fullPage: true });
        await page.locator('#ext-locale-select').selectOption('zh-CN');
        check('簡體收藏介面及窄畫面', await page.locator('#ext-capture-save').textContent() === '加入词书'
            && await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.screenshot({ path: path.join(OUT, 'extension-capture-zh-CN.png'), fullPage: true });
        check('無未捕獲頁面錯誤', pageErrors.length === 0, pageErrors);
    } catch (error) {
        checks.push({ name: 'execution', ok: false, detail: error.stack });
        console.error(error.message); process.exitCode = 1;
        if (context) {
            const debug = [];
            for (const page of context.pages().filter((page) => page.url().startsWith('chrome-extension://'))) {
                debug.push(await page.evaluate(async () => {
                    const ready = globalThis.__bdcExtensionRuntime?.getExtensionReadiness();
                    const values = await chrome.storage.local.get(null);
                    return { loggedIn: ready?.loggedIn, userId: ready?.userId, endpoint: ready?.endpoint,
                        notice: document.querySelector('#ext-capture-notice')?.textContent,
                        operations: Object.entries(values).filter(([, value]) => value?.payload?.requestId).map(([key, value]) => ({ key, requestId: value.payload.requestId, endpoint: value.endpoint, userId: value.userId })) };
                }).catch((failure) => ({ failure: failure.message })));
            }
            fs.writeFileSync(path.join(OUT, 'debug.json'), JSON.stringify(debug, null, 2));
        }
    } finally {
        if (context) await context.close();
        if (testEnv) await testEnv.close();
        fs.rmSync(profile, { recursive: true, force: true });
        fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ timestamp: new Date().toISOString(), checks, pageErrors, realWorkerAndSQLite: true, aiMocked: true }, null, 2));
        console.log(JSON.stringify({ passed: checks.filter((c) => c.ok).length, failed: checks.filter((c) => !c.ok).length, output: OUT }));
    }
})();
