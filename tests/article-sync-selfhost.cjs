/**
 * 文章逐篇同步端到端驗收（真實 selfhost SQLite 後端）。
 *
 * 用法：
 *   PLAYWRIGHT_MODULE=<path-to-playwright> node tests/article-sync-selfhost.cjs
 *
 * 覆蓋：
 *   1. 本機舊資料（analyzedArticles + articleMetas）遷移後上傳，保留原文章 ID
 *   2. 遷移完成後伺服器擋下舊快照的文章群組，其他群組照常
 *   3. 第二台裝置同步取得全部文章（含分析結果）
 *   4. 同篇衝突：後同步的裝置保留本機內容，可選擇保留本機或另存副本
 *   5. 刪除／復原同步到另一台裝置
 *   6. 帳戶 A / B 隔離（含相同的文章來源）
 */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { createHash } = require('node:crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const APP_PORT = Number(process.env.PORT || 8313);
const APP = `http://127.0.0.1:${APP_PORT}/`;

const TOKENS = { alice: 'a'.repeat(40), bob: 'b'.repeat(40) };
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const failures = [];
function check(name, condition, detail) {
    if (condition) { console.log(`  ok   ${name}`); return true; }
    failures.push({ name, detail: detail === undefined ? '' : String(detail).slice(0, 400) });
    console.log(`  FAIL ${name}${detail !== undefined ? ' -- ' + String(detail).slice(0, 300) : ''}`);
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
    const insert = db.prepare('INSERT OR REPLACE INTO users (token_hash, user_id, label, recovery_hash, role) VALUES (?, ?, ?, NULL, ?)');
    insert.run(sha256(TOKENS.alice), 'alice', 'Alice', 'user');
    insert.run(sha256(TOKENS.bob), 'bob', 'Bob', 'user');
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

async function api(base, token, apiPath, options = {}) {
    const res = await fetch(base + apiPath, {
        method: options.method || 'GET',
        headers: {
            Authorization: `Bearer ${TOKENS[token]}`,
            'Content-Type': 'application/json'
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    let body = null;
    try { body = await res.json(); } catch (_) {}
    return { status: res.status, body };
}

async function waitFor(fn, { timeoutMs = 15000, interval = 300 } = {}) {
    const started = Date.now();
    let last;
    while (Date.now() - started < timeoutMs) {
        last = await fn();
        if (last) return last;
        await new Promise((r) => setTimeout(r, interval));
    }
    return last;
}

const LEGACY_TOKEN = 'Alice body one sentence.';

async function newPage(browser, { endpoint, user = '', extraSettings = {} }) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(({ endpoint, user, token, extraSettings }) => {
        window.__BDC_SYNC_ENDPOINT__ = endpoint;
        try {
            if (user) {
                localStorage.setItem('sync_token', token);
                localStorage.setItem('sync_user_id', user);
                localStorage.setItem('sync_label', user);
                localStorage.setItem('sync_role', 'user');
            }
            const raw = localStorage.getItem('pen_global_settings');
            const parsed = raw ? JSON.parse(raw) : {};
            parsed.language = { ...(parsed.language || {}), interfaceLocale: 'zh-CN' };
            localStorage.setItem('pen_global_settings', JSON.stringify(parsed));
            if (extraSettings) Object.assign(window.__BDC_EXTRA__ || {}, extraSettings);
        } catch (_) {}
    }, { endpoint, user, token: TOKENS[user] || '', extraSettings });
    const page = await context.newPage();
    const errors = [];
    page.on('console', (m) => {
        const text = m.text();
        // selfhost 不提供 AI 憑證／目錄接口，501 是預期行為
        // 501：selfhost 沒有 AI 憑證接口；409：本測試刻意製造的版本衝突
        if (m.type() === 'error' && !/501|Not Implemented|409|Conflict|401|Unauthorized|ai-credentials|ai-catalog/i.test(text)) errors.push(text.slice(0, 200));
    });
    page.on('pageerror', (e) => errors.push('PAGEERROR ' + String(e && e.stack ? e.stack.split('\n')[0] : e)));
    return { context, page, errors };
}

async function seedLegacyLocal(page) {
    return page.evaluate((body) => {
        localStorage.setItem('analyzedArticles', JSON.stringify([{ articleId: 'url:legacy-alpha', article: body, result: { chinese_translation: '舊甲', paragraph_analysis: [{ chinese_translation: '舊甲一' }] } }]));
        localStorage.setItem('articleMetas', JSON.stringify({
            'url:legacy-alpha': { id: 'url:legacy-alpha', title: 'Legacy Alpha', sourceType: 'url', sourceUrl: 'https://example.com/legacy-alpha', createdAt: Date.now() - 86400000 }
        }));
        localStorage.setItem('vocabularyBooks', JSON.stringify([{
            id: 'url:legacy-alpha', name: 'Legacy Alpha', sourceType: 'article', articleId: 'url:legacy-alpha',
            createdAt: new Date().toISOString(), words: [{ id: 'w1', word: 'legacy', meaning: '舊的' }]
        }]));
        return true;
    }, LEGACY_TOKEN);
}

async function dismissStartupModal(page) {
    await page.evaluate(() => {
        const modal = document.getElementById('app-modal');
        if (modal && !modal.classList.contains('hidden')) {
            modal.querySelector('.modal-close-btn')?.click();
        }
    });
    await page.waitForTimeout(250);
}

async function syncNow(page) {
    await page.evaluate(() => { document.getElementById('app-gear-btn')?.click(); });
    await page.waitForFunction(() => !!document.getElementById('gm-sync'), null, { timeout: 5000 });
    await page.evaluate(() => {
        const item = document.getElementById('gm-sync');
        if (item) item.click();
    });
    await page.waitForTimeout(1800);
}

async function records(page) {
    return page.evaluate(async ({ endpoint, userId }) => {
        const scope = `${endpoint}::${userId || 'guest'}`;
        const db = await new Promise((resolve) => { const req = indexedDB.open('bdc-articles'); req.onsuccess = () => resolve(req.result); });
        const docs = await new Promise((resolve) => {
            const tx = db.transaction('docs', 'readonly');
            const rq = tx.objectStore('docs').getAll();
            rq.onsuccess = () => resolve(rq.result || []);
        });
        db.close();
        return docs.filter((d) => d.scope === scope && !d.deletedAt).map((d) => ({ id: d.id, title: d.title, body: d.body, revision: d.revision, dirty: !!d.dirty }));
    }, { endpoint: page.__endpoint, userId: page.__user });
}

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-sync-e2e-'));
    const file = path.join(dir, 'sync.sqlite');
    seedUsers(file);
    const server = await startServer(file);
    console.log('selfhost:', server.base);

    const browser = await chromium.launch({ headless: true, executablePath: CHROME });
    try {
        // ── 裝置 1：alice，帶舊資料 ───────────────────────────────────────────
        console.log('\n[裝置 1] 舊資料遷移與上傳');
        const d1 = await newPage(browser, { endpoint: server.base, user: 'alice' });
        d1.page.__endpoint = server.base; d1.page.__user = 'alice';
        await d1.page.goto(APP + '#a', { waitUntil: 'domcontentloaded' });
        await d1.page.waitForTimeout(1200);
        await dismissStartupModal(d1.page);
        await seedLegacyLocal(d1.page);
        await d1.page.reload({ waitUntil: 'domcontentloaded' });
        await d1.page.waitForTimeout(1600);

        const migrated = await records(d1.page);
        check('舊資料已遷移到逐篇儲存（保留原 ID）', migrated.length === 1 && migrated[0].id === 'url:legacy-alpha', JSON.stringify(migrated));
        check('舊資料分析結果一併保留', /舊甲/.test(JSON.stringify(await d1.page.evaluate(async () => {
            const db = await new Promise((resolve) => { const req = indexedDB.open('bdc-articles'); req.onsuccess = () => resolve(req.result); });
            const docs = await new Promise((resolve) => { const tx = db.transaction('docs', 'readonly'); const rq = tx.objectStore('docs').getAll(); rq.onsuccess = () => resolve(rq.result || []); });
            db.close();
            return docs.map((doc) => doc.analysis);
        }))));

        const wordbooks = await d1.page.evaluate(() => JSON.parse(localStorage.getItem('vocabularyBooks') || '[]'));
        check('文章專屬生詞本連結仍保留', wordbooks.some((book) => book.id === 'url:legacy-alpha' && book.words?.[0]?.word === 'legacy'), JSON.stringify(wordbooks.map((b) => ({ id: b.id, words: b.words?.length }))));

        await syncNow(d1.page);
        const serverArticles = await waitFor(async () => {
            const res = await api(server.base, 'alice', '/articles?full=1');
            return res.body && res.body.articles && res.body.articles.length ? res.body : null;
        });
        check('文章已同步到伺服器', !!serverArticles && serverArticles.articles.length === 1, JSON.stringify(serverArticles));
        check('伺服器保留原文章 ID', serverArticles?.articles?.[0]?.id === 'url:legacy-alpha', JSON.stringify(serverArticles?.articles));
        const usage = await api(server.base, 'alice', '/articles/usage');
        check('帳戶已開啟文章寫入閘門', usage.body?.legacyWriteBlocked === true, JSON.stringify(usage.body));

        const snapshotBefore = await api(server.base, 'alice', '/snapshot');
        const currentVersion = snapshotBefore.body?.version || 0;
        const gated = await api(server.base, 'alice', '/snapshot', {
            method: 'POST',
            body: { expected_version: currentVersion, payload: { articles: { analyzedArticles: [{ article: 'x', result: {} }] } } }
        });
        check('舊快照文章群組被擋下（409）', gated.status === 409 && gated.body?.code === 'articles_legacy_write_blocked', JSON.stringify(gated));
        const otherGroups = await api(server.base, 'alice', '/snapshot', {
            method: 'POST',
            body: { expected_version: currentVersion, payload: { vocabulary: { updatedAt: '2026-01-01T00:00:00.000Z', books: [] } } }
        });
        check('其他群組仍可同步', otherGroups.status === 200, JSON.stringify(otherGroups));

        // ── 裝置 2：同一帳戶，空白本機 ───────────────────────────────────────
        console.log('\n[裝置 2] 另一台裝置取得文章');
        const d2 = await newPage(browser, { endpoint: server.base, user: 'alice' });
        d2.page.__endpoint = server.base; d2.page.__user = 'alice';
        await d2.page.goto(APP + '#a', { waitUntil: 'domcontentloaded' });
        await d2.page.waitForTimeout(1400);
        await dismissStartupModal(d2.page);
        const beforePull = await records(d2.page);
        check('新裝置本機沒有文章', beforePull.length === 0, JSON.stringify(beforePull));
        await syncNow(d2.page);
        const pulled = await waitFor(async () => {
            const list = await records(d2.page);
            return list.length ? list : null;
        });
        check('新裝置同步後取得文章', !!pulled && pulled.length === 1 && pulled[0].id === 'url:legacy-alpha', JSON.stringify(pulled));
        check('新裝置取得完整原文', pulled?.[0]?.body === LEGACY_TOKEN, pulled?.[0]?.body);

        // ── 同篇衝突 ────────────────────────────────────────────────────────
        console.log('\n[衝突] 兩台裝置先後改名');
        const rename = (page, title) => page.evaluate(async ({ title }) => {
            const mod = await import('/modules/article-store.js');
            return mod.renameArticle('url:legacy-alpha', title);
        }, { title });
        check('裝置 1 改名成功', (await rename(d1.page, 'Renamed on device 1')).ok === true);
        await syncNow(d1.page);
        await waitFor(async () => {
            const res = await api(server.base, 'alice', '/articles/url%3Alegacy-alpha');
            return res.body?.article?.title === 'Renamed on device 1' ? res : null;
        });
        const d1Server = await api(server.base, 'alice', '/articles/url%3Alegacy-alpha');
        check('裝置 1 的改名已上傳', d1Server.body?.article?.title === 'Renamed on device 1', JSON.stringify(d1Server.body?.article?.title));

        // 裝置 2 看不到裝置 1 的改名（尚未拉取）就直接改自己的 → 會用舊 revision 上傳而衝突
        check('裝置 2 改名成功（本機）', (await rename(d2.page, 'Renamed on device 2')).ok === true);
        await syncNow(d2.page);
        const conflictState = await waitFor(async () => {
            const res = await d2.page.evaluate(async () => {
                const mod = await import('/modules/article-store.js');
                return { conflicts: mod.getConflicts(), record: mod.getRecord('url:legacy-alpha') };
            });
            return res.conflicts.length ? res : null;
        });
        check('同篇衝突被記錄（不是靜默覆蓋）', !!conflictState && conflictState.conflicts.length === 1, JSON.stringify(conflictState?.conflicts));
        check('衝突時保留本機內容', conflictState?.record?.title === 'Renamed on device 2', conflictState?.record?.title);
        const stillRemote = await api(server.base, 'alice', '/articles/url%3Alegacy-alpha');
        check('衝突當下伺服器內容未被覆蓋', stillRemote.body?.article?.title === 'Renamed on device 1', stillRemote.body?.article?.title);

        // 使用者選擇「保留本機修改」
        await waitFor(async () => {
            const res = await d2.page.evaluate(async () => {
                const mod = await import('/modules/article-sync.js');
                await mod.resolveKeepMine('url:legacy-alpha');
                return true;
            });
            return res;
        }, { timeoutMs: 20000 });
        const afterResolve = await waitFor(async () => {
            const res = await api(server.base, 'alice', '/articles/url%3Alegacy-alpha');
            return res.body?.article?.title === 'Renamed on device 2' ? res : null;
        }, { timeoutMs: 12000 });
        check('選擇保留本機後伺服器更新為本機內容', !!afterResolve, JSON.stringify(afterResolve?.body?.article?.title));

        // ── 刪除／復原跨裝置 ────────────────────────────────────────────────
        console.log('\n[刪除／復原] 跨裝置同步');
        // 裝置 1 尚未拉取裝置 2 的更新就以舊 revision 刪除 → 必須是衝突，不能靜默刪掉
        await d1.page.evaluate(async () => {
            const mod = await import('/modules/article-store.js');
            await mod.deleteArticle('url:legacy-alpha');
        });
        await syncNow(d1.page);
        const staleDelete = await waitFor(async () => {
            const res = await d1.page.evaluate(async () => {
                const mod = await import('/modules/article-store.js');
                return mod.getConflicts();
            });
            return res.length ? res : null;
        });
        check('以舊版本刪除會被擋成衝突（不是覆蓋）', !!staleDelete && staleDelete[0].kind === 'revision', JSON.stringify(staleDelete));
        const beforeResolve = await api(server.base, 'alice', '/articles?full=1&includeDeleted=1');
        check('衝突期間伺服器上的文章仍在', !beforeResolve.body?.articles?.[0]?.deletedAt, JSON.stringify(beforeResolve.body?.articles));

        // 使用者選擇「保留本機修改」→ 以最新版本重送刪除
        await d1.page.evaluate(async () => {
            const mod = await import('/modules/article-sync.js');
            await mod.resolveKeepMine('url:legacy-alpha');
        });
        const tombstone = await waitFor(async () => {
            const res = await api(server.base, 'alice', '/articles?full=1&includeDeleted=1');
            const row = res.body?.articles?.find((item) => item.id === 'url:legacy-alpha');
            return row && row.deletedAt ? row : null;
        }, { timeoutMs: 20000 });
        check('解決衝突後刪除以 tombstone 同步', !!tombstone, JSON.stringify(tombstone));

        await syncNow(d2.page);
        const d2AfterDelete = await waitFor(async () => {
            const list = await records(d2.page);
            return list.length === 0 ? list : null;
        });
        check('另一台裝置同步後文章消失', Array.isArray(d2AfterDelete) && d2AfterDelete.length === 0, JSON.stringify(d2AfterDelete));

        // 裝置 1 復原刪除 → 另一台裝置重新取得
        await d1.page.evaluate(async () => {
            const mod = await import('/modules/article-store.js');
            const record = mod.getRecord('url:legacy-alpha');
            await mod.restoreArticle(record);
        });
        await syncNow(d1.page);
        const restoredOnServer = await waitFor(async () => {
            const res = await api(server.base, 'alice', '/articles?full=1&includeDeleted=1');
            const row = res.body?.articles?.find((item) => item.id === 'url:legacy-alpha');
            return row && !row.deletedAt ? row : null;
        }, { timeoutMs: 20000 });
        check('復原同步回伺服器', !!restoredOnServer, JSON.stringify(restoredOnServer));
        await syncNow(d2.page);
        const d2Restored = await waitFor(async () => {
            const list = await records(d2.page);
            return list.length === 1 ? list : null;
        }, { timeoutMs: 20000 });
        check('復原同步到另一台裝置', Array.isArray(d2Restored) && d2Restored.length === 1 && d2Restored[0].id === 'url:legacy-alpha', JSON.stringify(d2Restored));

        // ── 帳戶隔離 ────────────────────────────────────────────────────────
        console.log('\n[隔離] 帳戶 B 看不到帳戶 A 的文章');
        const b = await newPage(browser, { endpoint: server.base, user: 'bob' });
        b.page.__endpoint = server.base; b.page.__user = 'bob';
        await b.page.goto(APP + '#a', { waitUntil: 'domcontentloaded' });
        await b.page.waitForTimeout(1400);
        await dismissStartupModal(b.page);
        await b.page.evaluate(async () => {
            const mod = await import('/modules/article-store.js');
            await mod.saveArticle({ articleId: 'art_bob', article: 'Bob own article.', title: 'Bob Article', sourceType: 'paste' });
        });
        await syncNow(b.page);
        const bobList = await waitFor(async () => {
            const res = await api(server.base, 'bob', '/articles?full=1');
            return res.body?.articles?.length ? res.body : null;
        });
        check('帳戶 B 只看到自己的文章', !!bobList && bobList.articles.length === 1 && bobList.articles[0].id === 'art_bob', JSON.stringify(bobList?.articles));
        const bobReadsAlice = await api(server.base, 'bob', '/articles/url%3Alegacy-alpha');
        check('帳戶 B 無法讀取帳戶 A 的文章', bobReadsAlice.status === 404, JSON.stringify(bobReadsAlice));
        const aliceList = await api(server.base, 'alice', '/articles?full=1&includeDeleted=1');
        check('帳戶 A 的文章不受帳戶 B 影響', aliceList.body?.articles?.some((item) => item.id === 'url:legacy-alpha'), JSON.stringify(aliceList.body?.articles?.map((a) => a.id)));

        check('裝置 1 無 console 錯誤', d1.errors.length === 0, JSON.stringify(d1.errors.slice(0, 5)));
        check('裝置 2 無 console 錯誤', d2.errors.length === 0, JSON.stringify(d2.errors.slice(0, 5)));

        await d1.context.close();
        await d2.context.close();
        await b.context.close();
    } finally {
        await browser.close();
        await server.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    }

    console.log(`\n=== 結果：${failures.length ? failures.length + ' 項失敗' : '全部通過'} ===`);
    if (failures.length) {
        for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
        process.exit(1);
    }
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
