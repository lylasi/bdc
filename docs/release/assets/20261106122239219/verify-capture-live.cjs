// Real MV3, production Worker/D1, real managed AI and deployed BDC.
// Only the source article is a synthetic local fixture. No API is mocked.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fixture = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const OUT = __dirname;
const ROOT = path.resolve(OUT, '../../../..');
const checks = [];
const pageErrors = [];
const bookId = 'release-probe-book';
const bookName = 'BDC 發布驗證詞書';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-prod-capture-'));
let context, sourceServer;
let aiCalls = 0;
const captures = [];
const responses = [];

function check(name, value, detail) {
    checks.push({ name, ok: !!value, ...(detail ? { detail } : {}) });
    console.log(`${value ? 'PASS' : 'FAIL'} ${name}`);
    assert.ok(value, name);
}
async function api(route, body) {
    const response = await fetch(fixture.endpoint + route, {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${fixture.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000)
    });
    const data = await response.json();
    assert.equal(response.status, 200, route + ': ' + JSON.stringify(data));
    return data;
}
async function outbox(page) {
    return page.evaluate(async () => Object.keys(await chrome.storage.local.get(null)).filter((key) => key.startsWith('bdc_capture_outbox_v1:')).length);
}

(async () => {
    try {
        for (const route of ['/vocabulary/books', '/captures/capabilities']) {
            const res = await fetch(fixture.endpoint + route);
            check('未登入不可存取 ' + route, res.status === 401);
        }
        const capabilities = await api('/captures/capabilities');
        check('正式收藏協議與來源上限', capabilities.captureVersion === 1 && capabilities.maxSources === 100);
        const created = await api('/reading/mutations', { mutations: [{
            mutationId: 'release-create-book', entityType: 'vocabularyBook', entityId: bookId,
            op: 'upsert', expectedRevision: 0, patch: { name: bookName, createdAt: new Date().toISOString() }
        }] });
        check('透過正式 reading API 建立隔離詞書', created.results?.[0]?.status === 'ok');
        context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
            viewport: { width: 400, height: 950 }, args: [`--disable-extensions-except=${fixture.extensionRoot}`, `--load-extension=${fixture.extensionRoot}`] });
        context.on('page', (p) => p.on('pageerror', (e) => pageErrors.push(e.message)));
        context.on('request', (request) => {
            const url = new URL(request.url());
            if (request.method() === 'POST' && /chat\/completions|\/responses$|generateContent/.test(url.pathname)) aiCalls += 1;
            if (url.origin === fixture.endpoint && url.pathname === '/captures' && request.method() === 'POST') captures.push(request.postDataJSON());
        });
        context.on('response', (response) => {
            const url = new URL(response.url());
            if (url.origin === fixture.endpoint) responses.push({ path: url.pathname, method: response.request().method(), status: response.status() });
        });
        const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
        const extUrl = `chrome-extension://${new URL(worker.url()).host}/lookup.html`;
        const page = await context.newPage();
        await page.goto(extUrl);
        await page.waitForFunction(() => document.querySelector('#ext-account-status').textContent.trim().length > 0);
        await page.locator('#ext-endpoint-input').fill(fixture.endpoint);
        await page.locator('#ext-login-mode').selectOption('token');
        await page.locator('#ext-token-input').fill(fixture.token);
        await page.locator('#ext-connect-btn').click();
        await page.waitForFunction(() => !document.querySelector('#ext-connect-btn').disabled, null, { timeout: 60000 });
        await page.waitForFunction(() => document.querySelector('#ext-capture-book').options.length > 1);
        await page.locator('#ext-token-input').fill('');
        check('擴充套件連接正式帳戶且僅列隔離詞書', (await page.locator('#ext-capture-book option').allTextContents()).includes(bookName));
        check('首次選書須明確確認', await page.locator('#ext-capture-book').inputValue() === '');
        check('未查詞時不可收藏', await page.locator('#ext-capture-save').isDisabled());
        sourceServer = http.createServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<!doctype html><title>BDC synthetic release article</title><p id="article">Major tech stocks plunge as investors worry. Markets remain volatile.</p>');
        });
        await new Promise((r) => sourceServer.listen(0, '127.0.0.1', r));
        const sourceUrl = `http://127.0.0.1:${sourceServer.address().port}/release-probe`;
        const article = await context.newPage();
        await article.goto(sourceUrl);
        await article.evaluate(() => {
            const text = document.querySelector('#article').firstChild;
            const start = text.textContent.indexOf('plunge');
            const range = document.createRange(); range.setStart(text, start); range.setEnd(text, start + 6);
            const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
        });
        await article.bringToFront();
        await page.evaluate(() => document.querySelector('#ext-extract-btn').click());
        await page.waitForFunction(() => document.querySelector('#ext-word-input').value === 'plunge');
        check('真 MV3 擷取選詞及原句', (await page.locator('#ext-sentence-input').inputValue()).includes('Major tech stocks plunge'));
        await page.locator('#ext-capture-book').selectOption(bookId);
        await page.locator('#ext-lookup-btn').click();
        await page.waitForFunction(() => !document.querySelector('#ext-lookup-btn').disabled, null, { timeout: 120000 });
        await page.waitForFunction(() => !document.querySelector('#ext-capture-save').disabled, null, { timeout: 10000 });
        const meaning = (await page.locator('#ext-result-meaning').textContent()).replace(/^.*?[：:]\s*/, '');
        check('正式 managed catalog 真 AI 查詞成功', aiCalls === 1 && !!meaning);
        const beforeSaveCalls = aiCalls;
        const responseWait = page.waitForResponse((r) => r.url() === fixture.endpoint + '/captures' && r.request().method() === 'POST');
        await page.locator('#ext-capture-save').click();
        const response = await responseWait;
        const receipt = await response.json();
        await page.waitForFunction(() => /已加入/.test(document.querySelector('#ext-capture-save').textContent));
        check('正式 D1 收藏成功並返回有效回執', response.status() === 200 && receipt.ok && receipt.bookId === bookId);
        check('收藏直接保存展示意思，不再次呼叫 AI', aiCalls === beforeSaveCalls);
        check('成功後本機待傳清除', await outbox(page) === 0);
        const captured = captures[0];
        const replay = await api('/captures', captured);
        check('相同 requestId 正式重送保持同一回執', JSON.stringify(replay) === JSON.stringify(receipt));
        const batch = await api('/reading/batch', { keys: [{ entityType: 'vocabularyEntry', entityId: receipt.entryId }] });
        const entry = batch.entities?.[0];
        check('已保存原句、網址、定位及當次意思', entry?.sources?.length === 1 && entry.sources[0].sourceUrl === sourceUrl
            && entry.sources[0].sentence.includes('stocks plunge') && entry.sources[0].anchor.quote === 'plunge'
            && entry.sources[0].meaning === captured.meaning && entry.meaning === captured.meaning);
        const app = await context.newPage();
        await app.addInitScript(({ endpoint, token, userId }) => {
            window.__BDC_SYNC_ENDPOINT__ = endpoint;
            localStorage.setItem('sync_token', token); localStorage.setItem('sync_user_id', userId);
            localStorage.setItem('sync_label', 'BDC capture release probe'); localStorage.setItem('sync_role', 'user');
            localStorage.setItem('vocabImportPromptShown', '1');
            localStorage.setItem('pen_global_settings', JSON.stringify({ language: { interfaceLocale: 'zh-HK' } }));
        }, fixture);
        await app.goto(fixture.website + '/?module=vocabulary');
        await app.evaluate(async () => {
            await (await import('/modules/article-store.js')).initArticleStore();
            await (await import('/modules/reading-store.js')).initReadingStore();
            await (await import('/modules/reading-sync.js')).syncReading();
        });
        await app.locator('#vocab-book-list li').filter({ hasText: bookName }).first().click();
        await app.locator('.word-sources summary').first().click();
        check('149 主站同步並展示原句、來源及當次意思', await app.locator('.word-source a').first().getAttribute('href') === sourceUrl
            && (await app.locator('.word-sources').first().textContent()).includes('當時釋義'));
        await app.screenshot({ path: path.join(OUT, 'website-production-zh-HK.png'), fullPage: true });
        await api('/captures', { requestId: 'release-auto-refresh', bookId, word: 'gather', meaning: '收集（發布驗證）',
            source: { sourceUrl, sentence: 'People gather information.', locale: 'zh-HK' } });
        await app.evaluate(() => dispatchEvent(new Event('focus')));
        await app.waitForFunction(() => document.querySelector('#word-list')?.textContent.includes('gather'), null, { timeout: 45000 });
        check('返回主站可自動發現新收藏並刷新畫面', (await app.locator('#word-list').textContent()).includes('gather'));
        for (const [locale, label] of [['zh-HK', '加入詞書'], ['zh-CN', '加入词书']]) {
            await page.locator('#ext-locale-select').selectOption(locale);
            check(locale + ' 收藏介面與 400px 排版', (await page.locator('#ext-capture-heading').textContent()).length > 0
                && await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
            await page.screenshot({ path: path.join(OUT, 'extension-production-' + locale + '.png'), fullPage: true });
        }
        check('真 AI 請求全程僅一次', aiCalls === 1);
        check('無未捕獲頁面錯誤', pageErrors.length === 0, pageErrors);
    } catch (error) {
        checks.push({ name: 'execution', ok: false, detail: error.stack });
        console.error(error.stack);
        if (context) {
            const diagnostics = [];
            for (const p of context.pages().filter((p) => p.url().startsWith('chrome-extension://'))) {
                diagnostics.push(await p.evaluate(() => ({
                    account: document.querySelector('#ext-account-status')?.textContent,
                    accountNotice: document.querySelector('#ext-account-notice')?.textContent,
                    catalog: document.querySelector('#ext-catalog-status')?.textContent,
                    captureNotice: document.querySelector('#ext-capture-notice')?.textContent,
                    books: Array.from(document.querySelector('#ext-capture-book')?.options || []).map((o) => ({ value: o.value, text: o.textContent })),
                    endpoint: document.querySelector('#ext-endpoint-input')?.value,
                    loginMode: document.querySelector('#ext-login-mode')?.value
                })).catch((e) => ({ error: e.message })));
            }
            fs.writeFileSync(path.join(OUT, 'capture-diagnostics.json'), JSON.stringify({ diagnostics, responses }, null, 2) + '\n');
        }
        process.exitCode = 1;
    } finally {
        if (context) await context.close();
        if (sourceServer) await new Promise((r) => sourceServer.close(r));
        fs.rmSync(profile, { recursive: true, force: true });
        const result = { timestamp: new Date().toISOString(), checks, pageErrors, productionWorker: fixture.endpoint,
            deployedWebsite: fixture.website, aiMocked: false, articleSynthetic: true, aiRequests: aiCalls,
            realMV3: true, browserProfileRemoved: !fs.existsSync(profile) };
        fs.writeFileSync(path.join(OUT, 'capture-smoke-results.json'), JSON.stringify(result, null, 2) + '\n');
        console.log(JSON.stringify({ passed: checks.filter((c) => c.ok).length, failed: checks.filter((c) => !c.ok).length }));
    }
})();
