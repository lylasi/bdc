/**
 * 分享網址／閱讀記錄刪除的本機診斷。
 * PORT=8313 PLAYWRIGHT_MODULE=<path-to-playwright> node <this-file>
 * 使用隔離 Chromium context、合成帳戶及臨時 SQLite，沒有正式資料寫入。
 */
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const ROOT = path.resolve(__dirname, '../../../..');
const BASE = `http://127.0.0.1:${Number(process.env.PORT || 8313)}`;
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const TOKENS = { alice: 'a'.repeat(40), bob: 'b'.repeat(40) };
const DOC = {
    id: 'art_delete_verification', title: 'Article from account A',
    body: 'We look forward to meeting you. Please keep this article.',
    sourceType: 'paste',
    analysis: { chinese_translation: '合成驗證文章。', paragraph_analysis: [{ chinese_translation: '合成驗證文章。' }] }
};
const results = [];
const requests = [];

async function check(name, work) {
    const detail = await work();
    results.push({ name, ok: true, detail });
    console.log(`ok ${results.length} - ${name}`);
}

async function until(work, timeout = 20000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const result = await work();
        if (result) return result;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Condition timed out: ${work.toString()}`);
}

async function freePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}

async function main() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-delete-verification-'));
    const file = path.join(dir, 'sync.sqlite');
    const db = new DatabaseSync(file);
    db.exec(fs.readFileSync(path.join(ROOT, 'selfhost/schema.sql'), 'utf8'));
    const insert = db.prepare('INSERT INTO users (token_hash, user_id, label, recovery_hash, role) VALUES (?, ?, ?, NULL, ?)');
    for (const [user, token] of Object.entries(TOKENS)) {
        insert.run(createHash('sha256').update(token).digest('hex'), user, user, 'user');
    }
    db.close();
    const port = await freePort();
    const endpoint = `http://127.0.0.1:${port}`;
    const server = spawn(process.execPath, [path.join(ROOT, 'selfhost/server.mjs')], {
        env: { ...process.env, DB_DRIVER: 'sqlite', SQLITE_PATH: file, PORT: String(port), HOST: '127.0.0.1', ALLOWED_ORIGINS: '*' },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let serverErrors = '';
    server.stderr.on('data', data => { serverErrors += String(data); });
    let browser;
    const errors = [];
    const contexts = [];
    async function api(user, route, method = 'GET', body) {
        const response = await fetch(endpoint + route, {
            method,
            headers: { Authorization: `Bearer ${TOKENS[user]}`, 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        return { status: response.status, body: await response.json() };
    }
    async function open(user, locale, hash = '#a/' + DOC.id) {
        const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
        contexts.push(context);
        await context.addInitScript(({ endpoint, user, token, locale }) => {
            window.__BDC_SYNC_ENDPOINT__ = endpoint;
            localStorage.setItem('sync_token', token);
            localStorage.setItem('sync_user_id', user);
            localStorage.setItem('sync_label', user);
            localStorage.setItem('sync_role', 'user');
            const settings = JSON.parse(localStorage.getItem('pen_global_settings') || '{}');
            settings.language = { ...settings.language, interfaceLocale: locale };
            localStorage.setItem('pen_global_settings', JSON.stringify(settings));
        }, { endpoint, user, token: TOKENS[user], locale });
        await context.route('**/*', route => {
            const url = new URL(route.request().url());
            if (url.pathname.endsWith('/ai-config.js')) return route.fulfill({ contentType: 'application/javascript',
                body: 'export const SYNC={endpoint:""},TTS_CONFIG={},AI_LIMITS={},OCR_CONFIG={},ARTICLE_IMPORT={},SUPABASE={};' });
            if (![BASE, endpoint].includes(url.origin)) return route.abort();
            return route.continue();
        });
        const page = await context.newPage();
        page.on('pageerror', error => errors.push({ user, locale, message: error.message }));
        page.on('response', response => {
            const url = new URL(response.url());
            if (url.origin === endpoint && url.pathname.startsWith('/articles')) {
                requests.push({ user, locale, method: response.request().method(), path: url.pathname + url.search, status: response.status() });
            }
        });
        await load(page, hash);
        return page;
    }
    async function load(page, hash) {
        const initialized = page.waitForEvent('console', { predicate: message => message.text().startsWith('应用程序已'), timeout: 20000 });
        if (hash === null) await page.reload({ waitUntil: 'domcontentloaded' });
        else await page.goto(BASE + '/' + hash, { waitUntil: 'domcontentloaded' });
        await initialized;
        await page.evaluate(async () => { (await import('/modules/ui.js')).closeModal(); });
    }
    async function expectArticle(page, body) {
        await until(() => page.evaluate(async ({ id, body }) => {
            const state = await import('/modules/state.js');
            return state.currentArticleId === id && document.getElementById('article-input').value === body;
        }, { id: DOC.id, body }));
        await page.locator('#article-btn.active').waitFor();
        await page.locator('#article-analysis-container .paragraph-pair').first().waitFor({ state: 'visible' });
    }
    async function sync(page) {
        await page.evaluate(async () => {
            const sync = await import('/modules/article-sync.js');
            await sync.syncArticles();
        });
    }
    try {
        await until(async () => {
            try { return (await fetch(endpoint + '/health')).ok; } catch (_) { return false; }
        });
        browser = await chromium.launch({ headless: true, executablePath: CHROME });
        for (const locale of ['zh-CN', 'zh-HK']) {
            DOC.id = 'art_delete_verification_' + locale.toLowerCase();
            assert.equal((await api('alice', '/articles', 'POST', { ...DOC, clientMutationId: 'create-alice-' + locale })).status, 201);
            const alice = await open('alice', locale);
            const bob = await open('bob', locale);
            await check(`${locale}: A can open their private article URL`, async () => {
                await expectArticle(alice, DOC.body);
                return { hash: new URL(alice.url()).hash };
            });
            await check(`${locale}: B opening A's URL cannot read A's article`, async () => {
                await until(() => bob.locator('#article-route-message').innerText().then(text => /找不到|無法找到/.test(text)));
                assert.equal(await bob.locator('#article-input').inputValue(), '');
                const result = await api('bob', '/articles/' + DOC.id);
                assert.equal(result.status, 404);
                return { apiStatus: result.status, message: await bob.locator('#article-route-message').innerText() };
            });
            await check(`${locale}: B cannot delete A's article with the same ID`, async () => {
                const result = await api('bob', '/articles/' + DOC.id, 'DELETE', { expectedRevision: 1, clientMutationId: 'unauthorized-' + locale });
                assert.equal(result.status, 404);
                assert.equal((await api('alice', '/articles/' + DOC.id)).body.article.body, DOC.body);
                return { apiStatus: result.status };
            });
            const bobDoc = { ...DOC, title: 'Independent copy owned by B', clientMutationId: 'create-bob-' + locale };
            assert.equal((await api('bob', '/articles', 'POST', bobDoc)).status, 201);
            await load(bob, null);
            await expectArticle(bob, DOC.body);
            const bobSecond = await open('bob', locale);
            await expectArticle(bobSecond, DOC.body);
            await check(`${locale}: B can have an independent copy with exactly the same ID`, async () => {
                const a = (await api('alice', '/articles/' + DOC.id)).body.article;
                const b = (await api('bob', '/articles/' + DOC.id)).body.article;
                assert.equal(a.title, DOC.title);
                assert.equal(b.title, bobDoc.title);
                return { aliceTitle: a.title, bobTitle: b.title };
            });
            await bob.locator('#article-history-btn').click();
            const row = bob.locator(`.ar-history-item[data-key="${DOC.id}"]`);
            await row.locator('.ar-history-more').click();
            const deleteButton = row.locator('[data-act="delete"]');
            const deleteLabel = await deleteButton.innerText();
            await deleteButton.click();
            await check(`${locale}: deleting B's reading record removes B's saved article`, async () => {
                await row.waitFor({ state: 'detached' });
                const article = await until(async () => {
                    await sync(bob);
                    const response = await api('bob', '/articles/' + DOC.id);
                    return response.body.article?.deletedAt ? response.body.article : null;
                });
                assert.ok(article.deletedAt);
                return { deleteLabel, deletedAt: article.deletedAt, revision: article.revision };
            });
            await bob.screenshot({ path: path.join(__dirname, `${locale}-bob-after-delete.png`) });
            await check(`${locale}: A's article and URL remain available after B deletes the record`, async () => {
                const response = await api('alice', '/articles/' + DOC.id);
                assert.equal(response.status, 200);
                assert.equal(response.body.article.deletedAt, '');
                assert.equal(response.body.article.body, DOC.body);
                assert.equal(response.body.article.revision, 1);
                await load(alice, null);
                await expectArticle(alice, DOC.body);
                await alice.screenshot({ path: path.join(__dirname, `${locale}-alice-after-b-delete.png`), animations: 'disabled' });
                return { status: response.status, revision: response.body.article.revision, deletedAt: response.body.article.deletedAt };
            });
            await check(`${locale}: B's other device receives the deletion`, async () => {
                await sync(bobSecond);
                await until(() => bobSecond.evaluate(async id => Boolean((await import('/modules/article-store.js')).getRecord(id)?.deletedAt), DOC.id));
                return { sameAccount: 'bob', deletionSynced: true };
            });
            await check(`${locale}: undo restores B's article without modifying A`, async () => {
                await bob.locator('.ar-history-undo .article-history-undo-btn').click();
                await row.waitFor();
                await until(async () => {
                    await sync(bob);
                    const response = await api('bob', '/articles/' + DOC.id);
                    return response.body.article && !response.body.article.deletedAt;
                });
                const a = (await api('alice', '/articles/' + DOC.id)).body.article;
                assert.equal(a.revision, 1);
                assert.equal(a.deletedAt, '');
                return { restored: true, aliceRevision: a.revision };
            });
            await check(`${locale}: B's private link works again after undo`, async () => {
                await bob.evaluate(id => { location.hash = '#a/' + id; }, DOC.id);
                await expectArticle(bob, DOC.body);
                await load(bob, null);
                await expectArticle(bob, DOC.body);
                return { hash: new URL(bob.url()).hash, refreshed: true };
            });
            await alice.context().close();
            await bob.context().close();
            await bobSecond.context().close();
        }
        assert.deepEqual(errors, []);
        console.log(`PASS ${results.length} checks; no page execution errors.`);
    } finally {
        fs.writeFileSync(path.join(__dirname, 'results.json'), JSON.stringify({ results, errors, requests, serverErrors }, null, 2) + '\n');
        if (browser) await browser.close();
        await new Promise(resolve => { if (server.exitCode !== null) resolve(); else { server.once('exit', resolve); server.kill('SIGTERM'); } });
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
