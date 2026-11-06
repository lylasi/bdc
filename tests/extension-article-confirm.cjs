// Real MV3 popup + Worker/SQLite. AI transport is mocked; confirmation is
// exercised through real visible buttons, with requests and durable jobs checked.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { environment, ALICE } = require('./helpers/extension-mv3.cjs');
const ROOT = path.resolve(__dirname, '..');
const stamp = new Date(Date.now() + 8 * 3600000).toISOString().replace(/\D/g, '').slice(0, 17);
const OUT = process.env.ARTICLE_CONFIRM_OUTPUT || path.join(ROOT, 'docs/report/assets', stamp + '_article-confirm');
const checks = [];
function check(name, condition, detail) {
    checks.push({ name, ok: !!condition, detail });
    console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`);
    assert.ok(condition, detail ? `${name}: ${JSON.stringify(detail)}` : name);
}
async function settings(page) {
    if (!(await page.locator('#ext-settings-dialog').evaluate((node) => node.open))) await page.locator('#ext-settings-open').click();
}
(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    execFileSync(process.execPath, ['scripts/package-extension.mjs'], { cwd: ROOT });
    const env = await environment();
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-article-confirm-'));
    const errors = [], translations = [], writes = [];
    let context;
    const count = () => env.db.prepare("SELECT COUNT(*) AS n FROM articles WHERE owner_user_id='alice' AND deleted_at IS NULL").get().n;
    try {
        context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
            viewport: { width: 1100, height: 900 }, args: ['--disable-extensions-except=' + ROOT + '/extension', '--load-extension=' + ROOT + '/extension'] });
        context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
        const prompt = (request) => {
            try { return (request.postDataJSON()?.messages || []).map((message) => message.content).join('\n'); } catch (_) { return ''; }
        };
        context.on('request', (request) => {
            if (request.url().startsWith(env.base + '/mock-ai/') && request.method() === 'POST' && prompt(request).includes('Translate the following English paragraph')) translations.push(prompt(request));
            if (request.url() === env.base + '/articles' && request.method() === 'POST') writes.push(request.postDataJSON());
        });
        const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
        const base = 'chrome-extension://' + new URL(worker.url()).host;
        const popup = await context.newPage(); await popup.goto(base + '/lookup.html');
        await popup.waitForFunction(() => !!document.querySelector('#ext-account-status').textContent);
        await settings(popup);
        await popup.locator('#ext-endpoint-input').fill(env.base); await popup.locator('#ext-login-mode').selectOption('token');
        await popup.locator('#ext-token-input').fill(ALICE); await popup.locator('#ext-connect-btn').click();
        await popup.waitForFunction(() => !document.querySelector('#ext-connect-btn').disabled && document.querySelector('#ext-account-status').textContent.includes('alice'));
        await popup.locator('#ext-settings-close').click();
        const pendingArticles = () => popup.evaluate(async () => Object.values(await chrome.storage.local.get(null)).filter((value) => value?.type === 'article' && value?.requestId).length);
        async function preview(locale, suffix) {
            await settings(popup); await popup.locator('#ext-locale-select').selectOption(locale); await popup.locator('#ext-settings-close').click();
            const source = await context.newPage(); await source.goto(env.base + '/test-article?confirm=' + suffix); await source.bringToFront();
            const opening = context.waitForEvent('page');
            const result = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'BDC_OPEN_WINDOW', view: 'article', autoImport: true }));
            assert.ok(result.ok);
            const page = await opening;
            await page.locator('#ext-article-preview').waitFor({ state: 'visible', timeout: 30000 });
            await page.waitForFunction(() => !document.querySelector('#ext-article-save').disabled && document.querySelector('#ext-article-cancel').hidden);
            return { page, source };
        }
        for (const locale of ['zh-CN', 'zh-HK']) {
            const before = { translations: translations.length, writes: writes.length, articles: count() };
            const { page, source } = await preview(locale, locale);
            check(locale + ' 右鍵等價入口停在獨立正文預覽', page.url().startsWith(base + '/lookup.html')
                && (await page.evaluate(() => chrome.windows.getCurrent())).type === 'popup'
                && (await page.locator('#ext-article-body').inputValue()).includes('## Outlook'));
            check(locale + ' 確認前沒有翻譯、文章寫入或待傳', translations.length === before.translations && writes.length === before.writes && count() === before.articles && await pendingArticles() === 0);
            check(locale + ' 預設確認後分析，按鈕與提示清楚', await page.locator('#ext-article-analyze').isChecked()
                && (await page.locator('#ext-article-save').textContent()) === (locale === 'zh-HK' ? '確認並分析匯入' : '确认并分析导入')
                && (await page.locator('#ext-workspace-notice').textContent()).includes(locale === 'zh-HK' ? '尚未分析或匯入' : '尚未分析或导入'));
            const title = 'Reviewed article ' + locale;
            const body = (await page.locator('#ext-article-body').inputValue()) + '\n\nReviewed paragraph with verified details.';
            await page.locator('#ext-article-title').fill(title); await page.locator('#ext-article-body').fill(body);
            check(locale + ' 編輯預覽不觸發分析或保存', translations.length === before.translations && count() === before.articles);
            await page.screenshot({ path: path.join(OUT, 'preview-' + locale + '.png'), fullPage: true });
            if (locale === 'zh-CN') {
                await page.close();
                check('關閉未確認預覽不建立文章或待傳', count() === before.articles && writes.length === before.writes && await pendingArticles() === 0);
            } else {
                await page.locator('#ext-article-body').fill(''); await page.locator('#ext-article-save').click();
                await page.waitForFunction(() => !document.querySelector('#ext-article-save').disabled && document.querySelector('#ext-workspace-notice').classList.contains('ext-notice-error'));
                check('空正文確認時先驗證，沒有翻譯或寫入', translations.length === before.translations && count() === before.articles);
                await page.locator('#ext-article-body').fill(body);
                const failAnalysis = async (route) => prompt(route.request()).includes('Translate the following English paragraph')
                    ? route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{}' } }] }) }) : route.continue();
                await context.route(env.base + '/mock-ai/**', failAnalysis);
                await page.locator('#ext-article-save').click();
                await page.waitForFunction(() => !document.querySelector('#ext-article-save').disabled && document.querySelector('#ext-workspace-notice').classList.contains('ext-notice-error'), null, { timeout: 30000 });
                check('分析失敗保留修改後正文，沒有半成品文章', (await page.locator('#ext-article-body').inputValue()) === body && count() === before.articles && await pendingArticles() === 0);
                await context.unroute(env.base + '/mock-ai/**', failAnalysis);
                await page.locator('#ext-article-save').click();
                await page.locator('#ext-article-open').waitFor({ state: 'visible', timeout: 30000 });
                const row = env.db.prepare("SELECT * FROM articles WHERE owner_user_id='alice' AND source_url=?").get(source.url());
                const analysis = row?.analysis_json && JSON.parse(row.analysis_json);
                check('確認後將修改的標題、正文及原文網址存入記錄', row?.title === title && row?.body === '# ' + title + '\n\n' + body && row?.source_url === source.url());
                check('分析使用檢查後正文，結果附在同一篇文章', translations.some((text) => text.includes('Reviewed paragraph with verified details.')) && analysis?.paragraph_analysis?.length >= 3 && count() === before.articles + 1);
                check('確認完成停留在原彈窗，可自行開啟文章', page.url().startsWith(base + '/lookup.html') && await pendingArticles() === 0);
                await page.screenshot({ path: path.join(OUT, 'confirmed-zh-HK.png'), fullPage: true });
                await page.close();
            }
            await source.close();
        }
        const { page, source } = await preview('zh-CN', 'body-only');
        const before = translations.length;
        await page.locator('#ext-article-analyze').uncheck();
        check('可明確選擇只導入正文，按鈕同步說明', await page.locator('#ext-article-save').textContent() === '确认并导入正文');
        await page.locator('#ext-article-save').click();
        await page.locator('#ext-article-open').waitFor({ state: 'visible', timeout: 30000 });
        const plain = env.db.prepare("SELECT * FROM articles WHERE owner_user_id='alice' AND source_url=?").get(source.url());
        check('只導入正文仍須確認且不發送翻譯請求', !!plain && !plain.analysis_json && translations.length === before);
        await page.close();
        await source.close();
        // Preserve the deployed optional-preflight fallback while retaining the
        // newer explicit preview/confirmation flow, including non-JSON errors.
        for (const [locale, status] of [['zh-CN', 503], ['zh-HK', 502]]) {
            const beforeFailure = { translations: translations.length, writes: writes.length, articles: count() };
            const pattern = env.base + '/vocabulary/books?**';
            const unavailable = async (route) => new URL(route.request().url()).searchParams.has('sourceUrl')
                ? route.fulfill({ status, contentType: status === 502 ? 'text/html' : 'application/json',
                    headers: { 'Access-Control-Allow-Origin': '*' }, body: status === 502 ? '<h1>Bad gateway</h1>' : '{"code":"temporary_sync_failure"}' })
                : route.continue();
            await context.route(pattern, unavailable);
            try {
                const deferred = await preview(locale, 'deferred-' + locale);
                check(locale + ' 預查暫時失敗仍顯示可編輯正文與稍後重試提示',
                    (await deferred.page.locator('#ext-workspace-notice').textContent()).includes(locale === 'zh-HK' ? '儲存時會重試' : '保存时会重试')
                    && await deferred.page.locator('#ext-article-analyze').isChecked()
                    && (await deferred.page.locator('#ext-article-body').inputValue()).includes('## Outlook'));
                check(locale + ' 降級預覽仍不自行翻譯、保存或建立待傳',
                    translations.length === beforeFailure.translations && writes.length === beforeFailure.writes
                    && count() === beforeFailure.articles && await pendingArticles() === 0);
                await deferred.page.close();
                await deferred.source.close();
            } finally { await context.unroute(pattern, unavailable); }
        }
        check('所有流程沒有未捕獲頁面錯誤', errors.length === 0, errors);
    } finally {
        fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ checks, errors, translationRequests: translations.length, articleWrites: writes.length }, null, 2));
        await context?.close(); await env.close(); fs.rmSync(profile, { recursive: true, force: true });
    }
    console.log(`${checks.length}/${checks.length} checks passed; ${OUT}`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
