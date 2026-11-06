// Real MV3, production Worker/D1, managed AI and deployed website.
// The source page and disposable account are synthetic; no API is mocked.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fixture = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const checks = [], errors = [], apiResponses = [];
const OUT = __dirname;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-page-production-'));
let context, server, apiPage, aiCalls = 0;
function check(name, ok, detail) {
    checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
    fs.writeFileSync(path.join(OUT, 'page-smoke-progress.json'), JSON.stringify({ checks, aiCalls }, null, 2) + '\n');
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
    assert.ok(ok, name);
}
async function api(route, body, method = body ? 'POST' : 'GET') {
    const result = await apiPage.evaluate(async ({ url, token, body, method }) => {
        const response = await fetch(url, { method,
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
        return { status: response.status, data: await response.json() };
    }, { url: fixture.endpoint + route, token: fixture.token, body, method });
    const accepted = route === '/articles' && method === 'POST' ? [200, 201] : [200];
    assert.ok(accepted.includes(result.status), route + ': HTTP ' + result.status + ' ' + JSON.stringify(result.data));
    return result.data;
}
(async () => {
    try {
        context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
            viewport: { width: 1200, height: 900 }, args: [`--disable-extensions-except=${fixture.extensionRoot}`, `--load-extension=${fixture.extensionRoot}`] });
        context.on('page', (p) => p.on('pageerror', (e) => errors.push(e.message)));
        context.on('request', (request) => {
            if (request.method() === 'POST' && /chat\/completions|\/responses$|generateContent/.test(new URL(request.url()).pathname)) aiCalls += 1;
        });
        context.on('response', (response) => {
            const url = new URL(response.url());
            if (url.origin === fixture.endpoint) apiResponses.push({ path: url.pathname, method: response.request().method(), status: response.status() });
        });
        const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
        const extensionBase = `chrome-extension://${new URL(worker.url()).host}`;
        const popup = await context.newPage();
        apiPage = popup;
        await popup.goto(extensionBase + '/lookup.html');
        await popup.waitForFunction(() => !!document.querySelector('#ext-account-status').textContent);
        for (const [route, method] of [['/vocabulary/books', 'GET'], ['/vocabulary/books', 'POST'], ['/vocabulary/default', 'PUT'], ['/vocabulary/page-link', 'POST']]) {
            const status = await popup.evaluate(async ({ url, method }) => (await fetch(url, { method })).status, { url: fixture.endpoint + route, method });
            check(`未登入不可存取 ${method} ${route}`, status === 401);
        }
        await popup.locator('#ext-endpoint-input').fill(fixture.endpoint);
        await popup.locator('#ext-login-mode').selectOption('token');
        await popup.locator('#ext-token-input').fill(fixture.token);
        await popup.locator('#ext-connect-btn').click();
        await popup.waitForFunction(() => !document.querySelector('#ext-connect-btn').disabled && !document.querySelector('#ext-book-default-create').disabled, null, { timeout: 60000 });
        await popup.locator('#ext-token-input').fill('');
        check('真 MV3 連接隔離普通帳戶', (await api('/vocabulary/books')).books.length === 0);
        await popup.locator('#ext-book-default-create').click();
        await popup.waitForFunction(() => !!document.querySelector('#ext-capture-book').value, null, { timeout: 60000 });
        const defaultId = await popup.locator('#ext-capture-book').inputValue();
        check('無預設詞書時可直接建立並選用', (await api('/vocabulary/books')).defaultBookId === defaultId);
        server = http.createServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8',
                'Content-Security-Policy': "default-src 'self'; frame-src 'none'; script-src 'none'" });
            res.end('<!doctype html><meta charset="utf-8"><title>Major tech stocks plunge</title><article><h1>Major tech stocks plunge</h1><p id="article">Major tech stocks plunge as investors worry. Markets remain volatile.</p><h2>Outlook</h2><p>People gather information before making decisions.</p><form><input value="private-form-value"></form></article>');
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const sourceUrl = `http://127.0.0.1:${server.address().port}/release-article`;
        const article = await context.newPage();
        await article.goto(sourceUrl);
        const rect = await article.evaluate(() => {
            const text = document.querySelector('#article').firstChild;
            const start = text.textContent.indexOf('plunge');
            const range = document.createRange(); range.setStart(text, start); range.setEnd(text, start + 6);
            const r = range.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };
        });
        await article.mouse.move(rect.x + 1, rect.y + rect.height / 2); await article.mouse.down();
        await article.mouse.move(rect.x + rect.width - 1, rect.y + rect.height / 2, { steps: 8 }); await article.mouse.up();
        await article.mouse.click(rect.x + 26, rect.y + rect.height + 20);
        await article.waitForEvent('frameattached', { timeout: 1000 }).catch(() => {});
        let inline;
        for (let i = 0; i < 100; i += 1) {
            inline = article.frames().find((f) => f.url().startsWith(extensionBase + '/lookup.html'));
            if (inline) break;
            await article.waitForTimeout(100);
        }
        assert.ok(inline, 'inline frame attached');
        await inline.waitForFunction(() => !!document.querySelector('#ext-result-meaning').textContent, null, { timeout: 180000 });
        check('嚴格 CSP 原網頁可直接以正式 AI 查詞', (await inline.locator('#ext-result-word').textContent()) === 'plunge' && aiCalls >= 1);
        check('原網頁查詞自動沿用明確預設', await inline.locator('#ext-capture-book').inputValue() === defaultId);
        check('頁面無法讀取浮窗內容', await article.evaluate(() => document.querySelector('bdc-page-lookup').shadowRoot === null));
        await inline.locator('#ext-book-page').click();
        await inline.waitForFunction((id) => !!document.querySelector('#ext-capture-book').value && document.querySelector('#ext-capture-book').value !== id, defaultId, { timeout: 60000 });
        const pageBookId = await inline.locator('#ext-capture-book').inputValue();
        check('浮窗可直接建立本頁詞書', (await api('/vocabulary/books')).books.some((b) => b.id === pageBookId && b.sourceUrl === sourceUrl));
        const beforeCapture = aiCalls;
        await inline.locator('#ext-capture-save').click();
        await inline.waitForFunction(() => /已加入/.test(document.querySelector('#ext-capture-save').textContent), null, { timeout: 60000 });
        check('浮窗收藏已展示結果且不重跑 AI', aiCalls === beforeCapture);
        await article.screenshot({ path: path.join(OUT, 'inline-production-saved-zh-CN.png'), fullPage: true });
        await inline.locator('#ext-article-extract').click();
        await inline.locator('#ext-article-preview').waitFor({ state: 'visible', timeout: 180000 });
        const extracted = { title: await inline.locator('#ext-article-title').inputValue(), body: await inline.locator('#ext-article-body').inputValue() };
        check('正式 AI 擷取標題正文並保留章節', extracted.title.length > 0 && extracted.body.includes('## Outlook') && extracted.body.includes('People gather information'));
        check('網頁表單欄位未送入保存預覽', !extracted.body.includes('private-form-value'));
        await inline.locator('#ext-article-analyze').check();
        await inline.locator('#ext-article-save').click();
        await inline.locator('#ext-article-open').waitFor({ state: 'visible', timeout: 300000 });
        const listing = await api('/vocabulary/books?sourceUrl=' + encodeURIComponent(sourceUrl));
        const linkedBook = listing.books.find((b) => b.id === pageBookId);
        const saved = (await api('/articles/' + encodeURIComponent(listing.articleId))).article;
        check('先建立頁書再保存文章可自動關聯', !!listing.articleId && linkedBook.articleId === listing.articleId);
        check('正式文章保存完整正文及真 AI 逐段分析', saved.body.includes('## Outlook') && saved.analysis?.paragraph_analysis?.length >= 3);
        const beforeReuse = aiCalls;
        await inline.locator('#ext-article-extract').click();
        await inline.waitForFunction(() => /保留原内容/.test(document.querySelector('#ext-workspace-notice').textContent), null, { timeout: 60000 });
        check('已有文章時提供開啟入口且不再提取', aiCalls === beforeReuse && await inline.locator('#ext-article-preview').isHidden());
        check('成功後本機收藏和工作區待傳均清除', await popup.evaluate(async () => Object.keys(await chrome.storage.local.get(null)).filter((key) => key.startsWith('bdc_capture_outbox_v1:') || key.startsWith('bdc_workspace_outbox_v1:')).length === 0));
        const secondUrl = sourceUrl + '-second';
        const secondId = 'release-article-first';
        await api('/articles', { id: secondId, title: 'Article created first', body: 'A second synthetic article.', sourceUrl: secondUrl, sourceType: 'url', clientMutationId: 'release-article-first-create' });
        const secondBook = await api('/vocabulary/books', { requestId: 'release-book-after-article', kind: 'page', name: '先文章後建書', sourceUrl: secondUrl });
        const secondListing = await api('/vocabulary/books?sourceUrl=' + encodeURIComponent(secondUrl));
        check('先保存文章再建立頁書亦自動關聯', secondListing.books.find((b) => b.id === secondBook.bookId)?.articleId === secondId);
        const beforeReplayCalls = aiCalls;
        const replay = await api('/vocabulary/books', { requestId: 'release-book-after-article', kind: 'page', name: '先文章後建書', sourceUrl: secondUrl });
        check('正式建書重送不重複建立', replay.bookId === secondBook.bookId && aiCalls === beforeReplayCalls);
        await context.addInitScript(({ website, endpoint, token, userId }) => {
            if (location.origin !== new URL(website).origin) return;
            window.__BDC_SYNC_ENDPOINT__ = endpoint;
            for (const [key, value] of Object.entries({ sync_token: token, sync_user_id: userId, sync_label: 'BDC page release probe', sync_role: 'user', vocabImportPromptShown: '1' })) localStorage.setItem(key, value);
            localStorage.setItem('pen_global_settings', JSON.stringify({ language: { interfaceLocale: 'zh-HK' } }));
        }, fixture);
        await popup.locator('#ext-app-url').fill(fixture.website);
        await popup.locator('#ext-app-url').dispatchEvent('change');
        await inline.waitForFunction((url) => document.querySelector('#ext-app-url').value === url, fixture.website);
        const opened = context.waitForEvent('page'); await inline.locator('#ext-article-open').click();
        const app = await opened; await app.waitForURL('**/#a/**');
        await app.waitForFunction(() => !!document.querySelector('#article-input')?.value, null, { timeout: 60000 });
        check('可在已更新主站開啟同一篇文章詳解', app.url().includes(listing.articleId) && (await app.locator('#article-input').inputValue()).includes('People gather information'));
        const reuse = await app.evaluate(async ({ id, sourceUrl, title }) => {
            await (await import('/modules/reading-sync.js')).syncReading();
            const state = await import('/modules/state.js'); const storage = await import('/modules/storage.js');
            const before = state.vocabularyBooks.length;
            const result = storage.getOrCreateArticleWordbook({ id, title, sourceType: 'url', sourceUrl }, { createWordbook: true });
            return { before, after: state.vocabularyBooks.length, id: result.wordbook.id };
        }, { id: listing.articleId, sourceUrl, title: saved.title });
        check('正式主站沿用頁書不另建空白詞書', reuse.id === pageBookId && reuse.before === reuse.after);
        await app.screenshot({ path: path.join(OUT, 'website-production-imported-article.png'), fullPage: true });
        for (const locale of ['zh-HK', 'zh-CN']) {
            await inline.locator('#ext-locale-select').selectOption(locale, { force: true });
            check(locale + ' 原頁浮窗文字及版面正常', (await inline.locator('#ext-article-extract').textContent()).length > 0 && await inline.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
            await article.screenshot({ path: path.join(OUT, 'inline-production-' + locale + '.png'), fullPage: true });
        }
        check('正常正式聯調沒有未捕獲錯誤', errors.length === 0, errors);
    } catch (error) {
        checks.push({ name: 'execution', ok: false, detail: error.stack });
        console.error(error.stack); process.exitCode = 1;
    } finally {
        if (context) await context.close();
        if (server) await new Promise((resolve) => server.close(resolve));
        fs.rmSync(profile, { recursive: true, force: true });
        fs.writeFileSync(path.join(OUT, 'page-smoke-results.json'), JSON.stringify({ checks, errors, apiResponses, aiCalls,
            realMV3: true, realProductionD1: true, aiMocked: false, syntheticSource: true, browserProfileRemoved: !fs.existsSync(profile) }, null, 2) + '\n');
        console.log(JSON.stringify({ passed: checks.filter((c) => c.ok).length, failed: checks.filter((c) => !c.ok).length }));
    }
})();
