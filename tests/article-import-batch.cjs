/**
 * 舊文章匯入後核對與快照條件讀取的回歸驗收（真實 selfhost SQLite 後端）。
 *
 * 用法：
 *   PORT=8313 PLAYWRIGHT_MODULE=<path-to-playwright> node tests/article-import-batch.cjs
 *
 * 覆蓋：
 *   1. importMax(100) > batchMax(50) 時，匯入後仍分批核對全部記錄，
 *      後半段不會留在 outbox 被逐篇重送（POST /articles 應為 0 次）
 *   2. 100 篇以上的本機遷移，在一次同步內完成並清空 outbox
 *   3. 後續同步使用 /snapshot?version= 條件讀取，未變更時不再下載整包
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
const TOKEN = 'd'.repeat(40);
const LEGACY_COUNT = 120;
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

async function api(base, apiPath) {
    const res = await fetch(base + apiPath, {
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }
    });
    let body = null;
    try { body = await res.json(); } catch (_) {}
    return { status: res.status, body };
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

async function waitFor(fn, { timeoutMs = 60000, interval = 500 } = {}) {
    const started = Date.now();
    let last;
    while (Date.now() - started < timeoutMs) {
        last = await fn();
        if (last) return last;
        await new Promise((resolve) => setTimeout(resolve, interval));
    }
    return null;
}

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-import-batch-'));
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
        let conflictResponses = 0;
        page.on('pageerror', (error) => errors.push('PAGEERROR ' + String(error && error.message ? error.message : error)));
        page.on('console', (message) => {
            if (message.type() === 'error' && !/501|Not Implemented|401|ai-credentials|ai-catalog/i.test(message.text())) {
                errors.push(message.text().slice(0, 200));
            }
        });
        page.on('request', (request) => {
            const url = request.url();
            if (!url.startsWith(server.base)) return;
            requests.push({ method: request.method(), path: url.slice(server.base.length) });
        });
        page.on('response', (response) => {
            const url = response.url();
            if (url.startsWith(server.base) && url.includes('/articles') && response.status() === 409) conflictResponses += 1;
        });

        await page.goto(APP + '#a', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1400);
        await dismissStartupModal(page);

        console.log('\n[準備] 本機 120 篇舊文章');
        await page.evaluate((count) => {
            const articles = [];
            const metas = {};
            for (let i = 0; i < count; i += 1) {
                const id = `url:import-${i}`;
                articles.push({
                    articleId: id,
                    article: `Legacy article ${i} ${'lorem ipsum '.repeat(40)}`,
                    result: { chinese_translation: `舊${i}`, paragraph_analysis: [{ chinese_translation: '段落' }] }
                });
                metas[id] = {
                    id,
                    title: `Import ${i}`,
                    sourceType: 'url',
                    sourceUrl: `https://example.com/${i}`,
                    createdAt: Date.now() - 86400000
                };
            }
            localStorage.setItem('analyzedArticles', JSON.stringify(articles));
            localStorage.setItem('articleMetas', JSON.stringify(metas));
        }, LEGACY_COUNT);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1800);
        requests.length = 0;

        console.log('\n[同步] 一次同步完成匯入與核對');
        await triggerSync(page);
        const completed = await waitFor(async () => {
            const usage = await api(server.base, '/articles/usage');
            if (Number(usage.body?.count) !== LEGACY_COUNT) return null;
            const pending = await outboxCount(page);
            return pending === 0 ? { usage: usage.body, pending } : null;
        });
        check('伺服器收到全部 120 篇', !!completed && completed.usage.count === LEGACY_COUNT, completed && completed.usage);
        check('同步結束後本機 outbox 已清空', !!completed && completed.pending === 0, completed && completed.pending);

        const importCalls = requests.filter((item) => item.path === '/articles/import');
        const batchCalls = requests.filter((item) => item.path === '/articles/batch');
        const singleCreates = requests.filter((item) => item.method === 'POST' && item.path === '/articles');
        console.log('  requests:', JSON.stringify({
            import: importCalls.length,
            batch: batchCalls.length,
            singleCreates: singleCreates.length,
            conflicts: conflictResponses
        }));
        check('import 分兩批 + final（3 次）', importCalls.length === 3, importCalls);
        check('匯入後按 batchMax 核對全部記錄（100→2 次、20→1 次）', batchCalls.length === 3, batchCalls);
        check('沒有逐篇重送 create / 讀回 409', singleCreates.length === 0 && conflictResponses === 0, { singleCreates, conflictResponses });

        console.log('\n[快照] 後續同步走條件讀取');
        for (let round = 0; round < 2; round += 1) {
            await triggerSync(page);
            await page.waitForTimeout(2000);
        }
        const snapshots = requests.filter((item) => item.path.startsWith('/snapshot'));
        const conditionalReads = snapshots.filter((item) => item.path.includes('version='));
        check('後續同步使用 ?version= 條件讀取', conditionalReads.length > 0, snapshots.map((item) => item.path));

        const records = await page.evaluate(async ({ endpoint }) => {
            const scope = `${endpoint}::alice`;
            const db = await new Promise((resolve) => {
                const req = indexedDB.open('bdc-articles');
                req.onsuccess = () => resolve(req.result);
            });
            const docs = await new Promise((resolve) => {
                const tx = db.transaction('docs', 'readonly');
                const rq = tx.objectStore('docs').getAll();
                rq.onsuccess = () => resolve(rq.result || []);
            });
            db.close();
            return docs.filter((doc) => doc.scope === scope && !doc.deletedAt);
        }, { endpoint: server.base });
        check('本機保留全部 120 篇（含分析）', records.length === LEGACY_COUNT
            && String(records[0]?.analysis?.chinese_translation || '').startsWith('舊'), { count: records.length });
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
