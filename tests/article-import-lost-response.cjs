/**
 * 匯入回應遺失後修改分析／正文／刪除，重載後重試不得靜默清掉新操作。
 *
 * 用法：
 *   PORT=8313 PLAYWRIGHT_MODULE=<path-to-playwright> node tests/article-import-lost-response.cjs
 *
 * 重現路徑（真實 Chromium IndexedDB + selfhost SQLite）：
 *   1. 舊文章匯入已在伺服器提交，但回應被中斷（route 先轉送再 abort）。
 *   2. 使用者只修改分析（正文不變）／修改正文／刪除文章。
 *   3. 重新載入後重試同步。
 *
 * 舊版缺陷：核對只比 title／body，會用目前操作的 mutation ID 把「只改分析」
 * 的操作誤判完成 → outbox 清空、gate 關閉，但伺服器分析仍是 null。修正後
 * 必須先確認真正送出過的快照，再把新修改 rebase 成 update／delete 送出。
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
const TOKEN = 'l'.repeat(40);
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
    db.prepare('INSERT OR REPLACE INTO users (token_hash, user_id, label, recovery_hash, role) VALUES (?, ?, ?, NULL, ?)')
        .run(sha256(TOKEN), 'alice', 'Alice', 'user');
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

async function api(base, apiPath, method = 'GET', body) {
    const res = await fetch(base + apiPath, {
        method,
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    let parsed = null;
    try { parsed = await res.json(); } catch (_) {}
    return { status: res.status, body: parsed };
}

async function dismissStartupModal(page) {
    await page.evaluate(() => {
        const modal = document.getElementById('app-modal');
        if (modal && !modal.classList.contains('hidden')) modal.querySelector('.modal-close-btn')?.click();
    });
    await page.waitForTimeout(250);
}

async function triggerSync(page) {
    await page.evaluate(() => { document.getElementById('app-gear-btn')?.click(); });
    await page.waitForFunction(() => !!document.getElementById('gm-sync'), null, { timeout: 5000 });
    await page.evaluate(() => document.getElementById('gm-sync')?.click());
}

async function outboxCount(page) {
    return page.evaluate(async () => {
        const db = await new Promise((resolve) => {
            const req = indexedDB.open('bdc-articles');
            req.onsuccess = () => resolve(req.result);
        });
        const rows = await new Promise((resolve) => {
            const tx = db.transaction('outbox', 'readonly');
            const rq = tx.objectStore('outbox').getAll();
            rq.onsuccess = () => resolve(rq.result || []);
        });
        db.close();
        return rows.length;
    });
}

async function waitFor(fn, { timeoutMs = 60000, interval = 300 } = {}) {
    const started = Date.now();
    let last;
    while (Date.now() - started < timeoutMs) {
        last = await fn();
        if (last) return last;
        await new Promise((resolve) => setTimeout(resolve, interval));
    }
    return null;
}

const IDS = ['url:lost-0', 'url:lost-1', 'url:lost-2', 'url:lost-3'];

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-import-lost-'));
    const file = path.join(dir, 'sync.sqlite');
    seedUsers(file);
    const server = await startServer(file);
    console.log('selfhost:', server.base);

    const browser = await chromium.launch({ headless: true, executablePath: CHROME });
    try {
        const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
        await context.addInitScript(({ endpoint, token }) => {
            window.__BDC_SYNC_ENDPOINT__ = endpoint;
            localStorage.setItem('sync_token', token);
            localStorage.setItem('sync_user_id', 'alice');
            localStorage.setItem('sync_label', 'alice');
            localStorage.setItem('sync_role', 'user');
            try {
                const raw = localStorage.getItem('pen_global_settings');
                const parsed = raw ? JSON.parse(raw) : {};
                parsed.language = { ...(parsed.language || {}), interfaceLocale: 'zh-CN' };
                localStorage.setItem('pen_global_settings', JSON.stringify(parsed));
            } catch (_) {}
        }, { endpoint: server.base, token: TOKEN });
        const page = await context.newPage();
        const errors = [];
        const requests = [];
        let dropImport = true;
        let droppedImports = 0;
        page.on('pageerror', (error) => errors.push('PAGEERROR ' + String(error && error.message ? error.message : error)));
        page.on('console', (message) => {
            // ERR_CONNECTION_RESET 是本測試刻意中斷的回應，不是產品錯誤。
            if (message.type() === 'error' && !/501|Not Implemented|401|ai-credentials|ai-catalog|Failed to fetch|ERR_FAILED|ERR_CONNECTION_RESET/i.test(message.text())) {
                errors.push(message.text().slice(0, 200));
            }
        });
        page.on('request', (request) => {
            const url = request.url();
            if (!url.startsWith(server.base)) return;
            requests.push({ method: request.method(), path: url.slice(server.base.length) });
        });
        await page.route('**/articles/import', async (route) => {
            const request = route.request();
            let hasArticles = false;
            try {
                const body = JSON.parse(request.postData() || '{}');
                hasArticles = Array.isArray(body.articles) && body.articles.length > 0;
            } catch (_) {}
            if (dropImport && request.method() === 'POST' && hasArticles) {
                // 先讓伺服器提交，再中斷回應：等同「已寫入但回應遺失」。
                await route.fetch();
                droppedImports += 1;
                await route.abort('connectionreset');
                return;
            }
            await route.continue();
        });

        await page.goto(APP + '#a', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1500);
        await dismissStartupModal(page);

        console.log('\n[準備] 本機 4 篇舊文章');
        await page.evaluate((ids) => {
            const articles = ids.map((id, index) => ({
                articleId: id,
                article: `Legacy article ${index} ${'lorem ipsum '.repeat(20)}`,
                result: { chinese_translation: `舊${index}`, paragraph_analysis: [] }
            }));
            const metas = {};
            ids.forEach((id, index) => {
                metas[id] = {
                    id,
                    title: `Import ${index}`,
                    sourceType: 'url',
                    sourceUrl: `https://example.com/${index}`,
                    createdAt: Date.now() - 86400000
                };
            });
            localStorage.setItem('analyzedArticles', JSON.stringify(articles));
            localStorage.setItem('articleMetas', JSON.stringify(metas));
        }, IDS);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1600);
        await dismissStartupModal(page);

        console.log('\n[第一輪] 匯入已提交、回應遺失');
        // 重新載入後自動同步或手動同步都可以；等到伺服器真的收到 4 篇。
        if (!(await waitFor(async () => (await api(server.base, '/articles/usage')).body?.count === IDS.length, { timeoutMs: 12000 }))) {
            await triggerSync(page);
        }
        const imported = await waitFor(async () => {
            const usage = await api(server.base, '/articles/usage');
            return Number(usage.body?.count) === IDS.length ? usage.body : null;
        }, { timeoutMs: 60000 });
        check('伺服器已收到 4 篇（回應被中斷）', !!imported && droppedImports > 0, { usage: imported, droppedImports });

        console.log('\n[修改] 分析／正文／刪除（重載前）');
        const modified = await page.evaluate(async () => {
            const store = await import('/modules/article-store.js');
            const ctx = store.captureArticleContext();
            const analysis = await store.saveAnalysis('url:lost-1', { chinese_translation: 'new analysis', paragraph_analysis: [] }, { ctx });
            const body = await store.saveArticle({ articleId: 'url:lost-2', title: 'Import 2', body: 'new body after lost response' }, { ctx });
            const deleted = await store.deleteArticle('url:lost-3', { ctx });
            return { analysis: analysis.ok, body: body.ok, deleted: deleted.ok };
        });
        check('修改分析／正文／刪除都成功', modified.analysis && modified.body && modified.deleted, modified);

        // 之後的同步恢復正常回應。
        dropImport = false;
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1600);
        await dismissStartupModal(page);
        await triggerSync(page);

        const converged = await waitFor(async () => {
            const pending = await outboxCount(page);
            const usage = await api(server.base, '/articles/usage');
            // 刪除一篇後有效文章是 3 篇；墓碑仍占同一個 ID，不會多出重複文章。
            return pending === 0 && Number(usage.body?.count) === IDS.length - 1
                ? { pending, usage: usage.body }
                : null;
        }, { timeoutMs: 60000 });
        check('重試後 outbox 清空、有效文章 3 篇（沒有重複建立）', !!converged, converged);

        const batch = await api(server.base, '/articles/batch', 'POST', { ids: ['url:lost-1', 'url:lost-2'] });
        const byId = new Map((batch.body?.articles || []).map((doc) => [doc.id, doc]));
        check('最新分析已到達遠端', JSON.stringify(byId.get('url:lost-1')?.analysis) === JSON.stringify({
            chinese_translation: 'new analysis',
            paragraph_analysis: []
        }), byId.get('url:lost-1')?.analysis);
        check('最新正文已到達遠端', byId.get('url:lost-2')?.body === 'new body after lost response', byId.get('url:lost-2')?.body);
        const deletedDoc = await api(server.base, '/articles/' + encodeURIComponent('url:lost-3'));
        check('刪除已到達遠端', Boolean(deletedDoc.body?.article?.deletedAt) || deletedDoc.body?.deleted === true, deletedDoc.body);
        const untouched = await api(server.base, '/articles/' + encodeURIComponent('url:lost-0'));
        check('未修改的文章仍是原本內容', String(untouched.body?.article?.body || '').startsWith('Legacy article 0'), untouched.body?.article?.body);

        const singleCreates = requests.filter((item) => item.method === 'POST' && item.path === '/articles');
        check('沒有逐篇重送 create', singleCreates.length === 0, singleCreates);
        check('流程沒有 console/page 錯誤', errors.length === 0, errors);
    } finally {
        await browser.close();
        await server.stop();
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }

    if (failures.length) {
        console.log(`\n=== 失敗 ${failures.length} 項 ===`);
        for (const item of failures) console.log(` - ${item.name}: ${item.detail}`);
        process.exit(1);
    }
    console.log('\n=== 結果：全部通過 ===');
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
