// 真 MV3 + 真 Worker/SQLite；只有供應商 transport 是 mock。
//
// 文章翻譯速度優化（0.6.x）的迴歸套件：
//   1. 長文清洗切成 3 塊時仍最多兩塊並行；回應亂序完成也要按原文順序組合。
//   2. 只有同版本的 managed catalog refresh 不得中止進行中的文章任務（舊版用
//      catalogGeneration 會誤判成設定變更）。
//   3. 多段翻譯中少數段落內容失敗時，保留已完成結果並回報 failedIndexes；
//      再次確認只補失敗段落，成功段落直接命中快取。
//   4. 清洗部分失敗時保留該塊完整原文、回傳 cleanupIncomplete，UI 顯示保留原文警告。
//   5. 確認前不得 POST /articles 或 /vocabulary/page-link，也不得送出逐段翻譯。
//   6. 停止在途清洗要立即結束，不再啟動後續塊。
//   7. 回應遺失留下待傳後，主按鈕「重試匯入」只重送原 payload：不重跑 AI、
//      不新增文章；重試成功後再提取同一頁只做唯讀 GET，明確按「在 BDC 打開」
//      才補 page-link。
//
// 用法：
//   PLAYWRIGHT_MODULE=<path-to-playwright> node tests/extension-article-optimization.cjs
// 輸出預設 /tmp/bdc-speed-article-optimization；可用 ARTICLE_OPTIMIZATION_OUTPUT 覆寫。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { environment, ALICE } = require('./helpers/extension-mv3.cjs');

const ROOT = path.resolve(__dirname, '..');
const OUT = process.env.ARTICLE_OPTIMIZATION_OUTPUT || '/tmp/bdc-speed-article-optimization';
const checks = [];
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function check(name, condition, detail) {
    checks.push({ name, ok: !!condition, ...(detail === undefined ? {} : { detail }) });
    console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${condition || detail === undefined ? '' : ': ' + JSON.stringify(detail)}`);
}

async function waitFor(run, { timeout = 15000, interval = 100 } = {}) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
        try { const value = await run(); if (value) return value; } catch (_) { /* keep polling */ }
        await sleep(interval);
    }
    return false;
}

// 「伺服器已套用，但回應遺失」：先讓 Worker 真的寫入，再回 503 給瀏覽器。
function applyThenFail(context, env, token, pathname) {
    return context.route('**' + pathname, async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        try {
            await fetch(env.base + pathname, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
                body: route.request().postData() || ''
            });
        } catch (_) { /* 套用失敗時用戶端仍應看到失敗 */ }
        await route.fulfill({ status: 503, contentType: 'application/json', body: '{"code":"capture_failed"}' });
    });
}

// 真的可被擴充套件注入／擷取的長文章頁：三塊都超過 splitMarkdownForCleanup 的 3500 字上限。
async function longArticleServer() {
    const server = http.createServer((request, response) => {
        const url = new URL(request.url || '/', 'http://127.0.0.1');
        const marker = url.searchParams.get('mode') === 'retry' ? 'RETRYSLOT' : 'UISLOT';
        const paragraph = (index, letter) => `<p>${marker}${index} ${letter.repeat(1800)}</p>`;
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(`<!doctype html><html><head><meta charset="utf-8"><title>Long article</title></head>`
            + `<body><article><h1>Long article</h1>${paragraph(0, 'A')}${paragraph(1, 'B')}${paragraph(2, 'C')}</article></body></html>`);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    return { url: base + '/article', close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }) };
}

const cleanupText = (prefix) => Array.from({ length: 3 }, (_, index) => `${prefix}${index} ${'原文段落內容 '.repeat(260)}`).join('\n\n');
const paragraphArticle = (prefix, count, failed = []) => ({
    body: Array.from({ length: count }, (_, index) => `${prefix}${index} 第 ${index} 段的英文內容。`).join('\n\n'),
    __failed: failed
});

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    execFileSync(process.execPath, ['scripts/package-extension.mjs'], { cwd: ROOT });
    const env = await environment();
    const articleServer = await longArticleServer();
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-article-optimization-'));
    const errors = [];
    const consoles = [];
    const aiCalls = [];
    const requestLog = [];
    let cleanupActive = 0;
    let cleanupPeak = 0;
    let paragraphFailures = true;
    let uiMode = 'normal';
    let cleanupHold = false;
    let context;
    let workspace = null;

    try {
        context = await chromium.launchPersistentContext(profile, {
            channel: 'chromium', headless: true, viewport: { width: 1200, height: 900 },
            args: ['--disable-extensions-except=' + path.join(ROOT, 'extension'), '--load-extension=' + path.join(ROOT, 'extension')]
        });
        context.on('page', (page) => {
            page.on('pageerror', (error) => errors.push(error.message));
            page.on('console', (message) => { if (message.type() === 'error') consoles.push(message.text()); });
        });
        context.on('request', (request) => {
            const address = request.url();
            if (address.startsWith(env.base)) requestLog.push({ method: request.method(), path: address.slice(env.base.length) });
        });
        const requestsSince = (mark) => requestLog.slice(mark);
        const writesSince = (mark, pathname) => requestsSince(mark)
            .filter((entry) => entry.method !== 'GET' && entry.path.split('?')[0] === pathname).length;
        const catalogReads = () => requestLog.filter((entry) => entry.method === 'GET' && entry.path.split('?')[0] === '/ai-catalog').length;

        // 決定性 provider：以文章中的標記辨識請求；可控制延遲、部分失敗與中止。
        await context.route(env.base + '/mock-ai/**', async (route) => {
            const request = route.request();
            if (request.method() !== 'POST') return route.continue();
            let body;
            try { body = request.postDataJSON(); } catch (_) { return route.continue(); }
            const prompt = (body.messages || []).map((message) => typeof message.content === 'string' ? message.content : '').join('\n');
            const cleanup = prompt.includes('Clean the supplied Markdown article');
            const paragraph = prompt.includes('Translate the following English paragraph');
            if (!cleanup && !paragraph) return route.continue();
            const matched = prompt.match(/([A-Z]+SLOT\d+)/);
            const marker = matched ? matched[1] : '';
            const suffix = marker.match(/SLOT(\d+)$/);
            const index = suffix ? Number(suffix[1]) : -1;
            const prefix = marker.replace(/SLOT\d+$/, '');
            const call = { kind: cleanup ? 'cleanup' : 'paragraph', marker, prefix, index, started: performance.now(), maxTokens: body.max_tokens };
            aiCalls.push(call);
            if (cleanup) { cleanupActive += 1; cleanupPeak = Math.max(cleanupPeak, cleanupActive); }
            try {
                let delay = 120;
                if (cleanup) {
                    if (uiMode === 'stop' || cleanupHold) delay = 1500;
                    else if (uiMode === 'partial') delay = [250, 900, 200][index] ?? 120;
                    else if (prefix === 'CLEAN') delay = [900, 500, 100][index] ?? 120;
                } else if (prefix === 'PCAT') delay = 1200;
                await sleep(delay);
                let content;
                if (cleanup) {
                    content = uiMode === 'partial' && index === 1
                        ? '' // 空清洗結果：呼叫端必須保留該塊完整原文，不能寫成空白。
                        : `# Long article\n\nCLEANED_${marker || 'CHUNK'} ${'整理後段落。'.repeat(12)}`;
                } else if (paragraphFailures && prefix === 'PFAIL' && [1, 3].includes(index)) {
                    content = '{}'; // 標準與後備都拿不到逐段譯文。
                } else {
                    content = JSON.stringify({ chinese_translation: `譯文 ${marker || '段落'}` });
                }
                await route.fulfill({
                    status: 200,
                    headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
                    body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] })
                });
                call.fulfilled = performance.now();
            } catch (_) {
                call.canceled = true;
            } finally {
                if (cleanup) cleanupActive -= 1;
            }
        });

        const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
        const extensionBase = 'chrome-extension://' + new URL(worker.url()).host;
        const popup = await context.newPage();
        await popup.goto(extensionBase + '/lookup.html');
        await popup.waitForFunction(() => !!document.querySelector('#ext-account-status').textContent);
        await popup.locator('#ext-settings-open').click();
        if (!(await popup.locator('#ext-account-details').evaluate((node) => node.open))) await popup.locator('#ext-account-summary').click();
        await popup.locator('#ext-endpoint-input').fill(env.base);
        await popup.locator('#ext-login-mode').selectOption('token');
        await popup.locator('#ext-token-input').fill(ALICE);
        await popup.locator('#ext-connect-btn').click();
        await popup.waitForFunction(() => !document.querySelector('#ext-connect-btn').disabled
            && document.querySelector('#ext-account-status').textContent.includes('alice'), null, { timeout: 30000 });
        await popup.locator('#ext-settings-close').click();

        const article = await context.newPage();
        await article.goto(articleServer.url);
        await article.bringToFront();

        /* ---------- 1. 三塊清洗：亂序回應仍保序、最多兩塊並行 ---------- */
        const cleanupPage = { pageUrl: 'https://example.test/long-cleanup', pageTitle: 'Long article', text: cleanupText('CLEANSLOT') };
        const cleaned = await popup.evaluate(async (page) => {
            const runtime = await import('./modules/extension-ai-runtime.js');
            const started = performance.now();
            try {
                return { result: await runtime.runExtensionArticleTask({ page, analyze: false }), ms: performance.now() - started };
            } catch (error) {
                return { error: { name: error.name, code: error.code, causeCode: error.causeCode }, ms: performance.now() - started };
            }
        }, cleanupPage);
        const cleanupCalls = aiCalls.filter((call) => call.kind === 'cleanup' && call.prefix === 'CLEAN');
        const body = cleaned.result?.body || '';
        check('長文清洗切成三塊並全部完成', cleanupCalls.length === 3 && !!cleaned.result && !cleaned.error,
            { requests: cleanupCalls.length, error: cleaned.error, bodyLength: body.length });
        check('清洗回應亂序完成仍按原文順序組合', body.indexOf('CLEANED_CLEANSLOT0') >= 0
            && body.indexOf('CLEANED_CLEANSLOT0') < body.indexOf('CLEANED_CLEANSLOT1')
            && body.indexOf('CLEANED_CLEANSLOT1') < body.indexOf('CLEANED_CLEANSLOT2'),
            { order: ['CLEANED_CLEANSLOT0', 'CLEANED_CLEANSLOT1', 'CLEANED_CLEANSLOT2'].map((needle) => body.indexOf(needle)) });
        check('清洗並行不超過兩塊', cleanupPeak <= 2 && cleanupPeak === 2, { peak: cleanupPeak });
        const cleanupOrder = cleanupCalls.slice().sort((a, b) => a.fulfilled - b.fulfilled).map((call) => call.index);
        check('此案例確實以非原序完成（保序斷言有鑑別力）', cleanupOrder.join(',') !== '0,1,2', { completionOrder: cleanupOrder });

        /* ---------- 2. 同版本 catalog refresh 不得中止任務 ---------- */
        const catalogArticle = paragraphArticle('PCATSLOT', 4);
        await popup.evaluate(async (article) => {
            const runtime = await import('./modules/extension-ai-runtime.js');
            window.catalogTask = runtime.runExtensionArticleTask({ article, analyze: true })
                .then((result) => ({ result }), (error) => ({ error: { name: error.name, code: error.code } }));
        }, catalogArticle);
        await waitFor(() => aiCalls.some((call) => call.kind === 'paragraph' && call.prefix === 'PCAT'));
        const catalogBefore = catalogReads();
        const refresh = await popup.evaluate(async () => {
            const catalog = await import('./modules/ai-catalog.js');
            const before = catalog.getCatalogState();
            await catalog.refreshAICatalog({ force: true });
            const after = catalog.getCatalogState();
            return { beforeVersion: before.version, afterVersion: after.version,
                beforeGeneration: before.generation, afterGeneration: after.generation };
        });
        const catalogOutcome = await popup.evaluate(() => window.catalogTask);
        check('同版本 catalog refresh 確實執行（generation 增加、版本不變）',
            refresh.afterVersion === refresh.beforeVersion && refresh.afterGeneration > refresh.beforeGeneration
            && catalogReads() > catalogBefore, { refresh, catalogReads: catalogReads() - catalogBefore });
        check('同版本 catalog refresh 不中止文章任務，也不報設定變更',
            !!catalogOutcome.result && !catalogOutcome.error
            && catalogOutcome.result.paragraph_analysis?.length === 4
            && catalogOutcome.result.paragraph_analysis[3].chinese_translation === '譯文 PCATSLOT3',
            { outcome: catalogOutcome.error || { parts: catalogOutcome.result?.paragraph_analysis?.length } });

        /* ---------- 3. 多段失敗：只標記失敗段，重試只補失敗段 ---------- */
        paragraphFailures = true;
        const failArticle = paragraphArticle('PFAILSLOT', 5);
        const failedRun = await popup.evaluate(async (article) => {
            const runtime = await import('./modules/extension-ai-runtime.js');
            const progress = [];
            try {
                const result = await runtime.runExtensionArticleTask({ article, analyze: true,
                    onProgress: (done, total) => progress.push({ done, total }) });
                return { result, progress };
            } catch (error) {
                return { error: { name: error.name, code: error.code, causeCode: error.causeCode, failedIndexes: error.failedIndexes }, progress };
            }
        }, failArticle);
        const failedIndexes = (failedRun.error?.failedIndexes || []).slice().sort((a, b) => a - b);
        check('內容類失敗不中止其他段，錯誤帶 failedIndexes 與 causeCode',
            failedRun.error?.code === 'page_analysis_failed' && failedIndexes.join(',') === '1,3'
            && failedRun.error.causeCode === 'empty_translation' && !failedRun.result,
            failedRun.error);
        check('失敗時進度停在未完成段落，不報全數完成',
            failedRun.progress[0]?.done === 0 && failedRun.progress.at(-1)?.done === 3 && failedRun.progress.at(-1)?.total === 5,
            failedRun.progress);
        const pFailCalls = () => aiCalls.filter((call) => call.kind === 'paragraph' && call.prefix === 'PFAIL');
        const firstRunCounts = Array.from({ length: 5 }, (_, index) => pFailCalls().filter((call) => call.index === index).length);
        check('成功段只請求一次，失敗段走完標準與後備', firstRunCounts[0] === 1 && firstRunCounts[2] === 1
            && firstRunCounts[4] === 1 && firstRunCounts[1] === 2 && firstRunCounts[3] === 2, firstRunCounts);

        paragraphFailures = false;
        const retriedRun = await popup.evaluate(async (article) => {
            const runtime = await import('./modules/extension-ai-runtime.js');
            const progress = [];
            try {
                const result = await runtime.runExtensionArticleTask({ article, analyze: true,
                    onProgress: (done, total) => progress.push({ done, total }) });
                return { result, progress };
            } catch (error) {
                return { error: { name: error.name, code: error.code, failedIndexes: error.failedIndexes }, progress };
            }
        }, failArticle);
        const secondRunCounts = Array.from({ length: 5 }, (_, index) => pFailCalls().filter((call) => call.index === index).length);
        check('重試只補失敗段，成功段直接復用快取',
            !!retriedRun.result && retriedRun.result.paragraph_analysis?.length === 5
            && retriedRun.result.paragraph_analysis[4].chinese_translation === '譯文 PFAILSLOT4'
            && secondRunCounts[0] === firstRunCounts[0] && secondRunCounts[2] === firstRunCounts[2]
            && secondRunCounts[4] === firstRunCounts[4]
            && secondRunCounts[1] === firstRunCounts[1] + 1 && secondRunCounts[3] === firstRunCounts[3] + 1,
            { firstRunCounts, secondRunCounts, error: retriedRun.error });
        check('重試完成後進度才到全數完成', retriedRun.progress.at(-1)?.done === 5 && retriedRun.progress.at(-1)?.total === 5, retriedRun.progress);

        /* ---------- 4. 停止：不再啟動後續塊，立即結束 ---------- */
        cleanupHold = true;
        const abortPage = { pageUrl: 'https://example.test/abort-cleanup', pageTitle: 'Long article', text: cleanupText('ABORTSLOT') };
        await popup.evaluate(async (page) => {
            const runtime = await import('./modules/extension-ai-runtime.js');
            window.stopController = new AbortController();
            window.stopOutcome = runtime.runExtensionArticleTask({ page, analyze: false, signal: window.stopController.signal })
                .then((result) => ({ result }), (error) => ({ error: { name: error.name, code: error.code } }));
        }, abortPage);
        await waitFor(() => aiCalls.filter((call) => call.kind === 'cleanup' && call.prefix === 'ABORT').length >= 2);
        const abortCallsBefore = aiCalls.filter((call) => call.kind === 'cleanup' && call.prefix === 'ABORT').length;
        const abortStarted = performance.now();
        await popup.evaluate(() => window.stopController.abort());
        const stopped = await popup.evaluate(() => window.stopOutcome);
        const abortMs = performance.now() - abortStarted;
        const abortCallsAfter = aiCalls.filter((call) => call.kind === 'cleanup' && call.prefix === 'ABORT').length;
        check('停止會快速結束在途清洗', stopped.error?.name === 'AbortError' && abortMs < 1000, { error: stopped.error, ms: abortMs });
        check('停止後不再啟動第三塊', abortCallsBefore === 2 && abortCallsAfter === abortCallsBefore,
            { abortCallsBefore, abortCallsAfter });
        cleanupHold = false;

        /* ---------- 5. UI：清洗部分失敗保留原文、顯示警告、確認前零寫入 ---------- */
        const articleRows = () => env.db.prepare("SELECT * FROM articles WHERE owner_user_id='alice' AND deleted_at IS NULL ORDER BY created_at").all();
        const articleIds = () => articleRows().map((row) => row.legacy_article_id || row.id);
        const pendingArticles = () => workspace.evaluate(async () => Object.values(await chrome.storage.local.get(null))
            .filter((value) => value?.type === 'article' && value?.requestId).length);
        const noticeText = () => workspace.evaluate(() => (document.querySelector('#ext-workspace-notice')?.textContent || '').trim());
        const openWorkspace = async () => {
            await article.bringToFront();
            const opened = context.waitForEvent('page');
            await popup.evaluate(() => document.querySelector('#ext-home-article').click());
            const page = await opened;
            await page.waitForURL(/view=article/, { timeout: 15000 });
            await page.locator('#ext-page-article-section').waitFor({ state: 'visible', timeout: 20000 });
            await page.waitForFunction(() => !!document.querySelector('#ext-account-status').textContent, null, { timeout: 30000 });
            return page;
        };
        const reopenWorkspace = async () => {
            if (workspace && !workspace.isClosed()) await workspace.close();
            workspace = await openWorkspace();
            return workspace;
        };

        workspace = await openWorkspace();
        uiMode = 'partial';
        const markPartial = requestLog.length;
        const translationsBeforePartial = aiCalls.filter((call) => call.kind === 'paragraph').length;
        const articlesBeforePartial = articleRows().length;
        await workspace.locator('#ext-article-extract').click();
        await workspace.locator('#ext-article-preview').waitFor({ state: 'visible', timeout: 60000 });
        const partialNotice = await waitFor(async () => {
            const text = await noticeText();
            return /保留原文/.test(text) ? text : false;
        }, { timeout: 20000 });
        const partialNoticeRaw = await noticeText();
        check('部分清洗失敗時 UI 明確提示保留原文與塊數',
            /1 (块|段)正文未能完整整理/.test(partialNotice) && /保留原文/.test(partialNotice),
            { notice: partialNotice, raw: partialNoticeRaw });
        const partialBody = await workspace.locator('#ext-article-body').inputValue();
        check('部分清洗失敗保留該塊完整原文，其餘塊仍用清洗結果並保序',
            partialBody.includes('UISLOT1') && partialBody.includes('CLEANED_UISLOT0') && partialBody.includes('CLEANED_UISLOT2')
            && partialBody.indexOf('CLEANED_UISLOT0') < partialBody.indexOf('UISLOT1')
            && partialBody.indexOf('UISLOT1') < partialBody.indexOf('CLEANED_UISLOT2'),
            { length: partialBody.length, positions: ['CLEANED_UISLOT0', 'UISLOT1', 'CLEANED_UISLOT2'].map((needle) => partialBody.indexOf(needle)) });
        await sleep(400);
        check('確認前沒有 POST /articles 或 page-link',
            writesSince(markPartial, '/articles') === 0 && writesSince(markPartial, '/vocabulary/page-link') === 0,
            requestsSince(markPartial));
        check('確認前沒有送出逐段翻譯或建立文章',
            aiCalls.filter((call) => call.kind === 'paragraph').length === translationsBeforePartial
            && articleRows().length === articlesBeforePartial,
            { translations: aiCalls.filter((call) => call.kind === 'paragraph').length - translationsBeforePartial,
                articles: articleRows().length - articlesBeforePartial });

        /* ---------- 6. UI：手動停止擷取 ---------- */
        uiMode = 'stop';
        const markStop = requestLog.length;
        await workspace.locator('#ext-article-extract').click();
        await workspace.locator('#ext-article-cancel').waitFor({ state: 'visible', timeout: 15000 });
        const stopStarted = performance.now();
        await workspace.locator('#ext-article-cancel').click();
        const stopNotice = await waitFor(async () => {
            const text = await noticeText();
            return /已停止/.test(text) ? text : false;
        }, { timeout: 10000 });
        const stopMs = performance.now() - stopStarted;
        check('手動停止會立即回到可操作狀態', !!stopNotice && stopMs < 1500, { ms: stopMs, notice: stopNotice });
        check('停止後沒有寫入文章或 page-link',
            writesSince(markStop, '/articles') === 0 && writesSince(markStop, '/vocabulary/page-link') === 0,
            requestsSince(markStop));
        uiMode = 'normal';

        /* ---------- 7. 主按鈕重試：不重跑 AI、不新增文章；既有文章唯讀 ---------- */
        await article.goto(articleServer.url + '?mode=retry');
        await article.bringToFront();
        workspace = await reopenWorkspace();
        const markRetryPreview = requestLog.length;
        await workspace.locator('#ext-article-extract').click();
        await workspace.locator('#ext-article-preview').waitFor({ state: 'visible', timeout: 60000 });
        await workspace.waitForFunction(() => !document.querySelector('#ext-article-save').disabled, null, { timeout: 30000 });
        check('新頁面擷取完成，預設勾選分析且尚未寫入',
            await workspace.locator('#ext-article-analyze').isChecked()
            && writesSince(markRetryPreview, '/articles') === 0
            && writesSince(markRetryPreview, '/vocabulary/page-link') === 0,
            requestsSince(markRetryPreview));

        applyThenFail(context, env, ALICE, '/articles');
        const articlesBeforeAttempt = articleRows().length;
        const translationsBeforeAttempt = aiCalls.filter((call) => call.kind === 'paragraph').length;
        await workspace.locator('#ext-article-save').click();
        await workspace.waitForFunction(() => document.querySelectorAll('#ext-workspace-pending-list li').length === 1, null, { timeout: 60000 });
        await workspace.waitForFunction(() => !document.querySelector('#ext-article-save').disabled, null, { timeout: 30000 });
        const frozen = await workspace.evaluate(() => ({
            titleDisabled: document.querySelector('#ext-article-title').disabled,
            bodyDisabled: document.querySelector('#ext-article-body').disabled,
            analyzeDisabled: document.querySelector('#ext-article-analyze').disabled,
            extractDisabled: document.querySelector('#ext-article-extract').disabled,
            saveDisabled: document.querySelector('#ext-article-save').disabled,
            saveText: document.querySelector('#ext-article-save').textContent,
            pendingItems: document.querySelectorAll('#ext-workspace-pending-list li').length,
            pendingHidden: document.querySelector('#ext-workspace-pending').hidden
        }));
        check('回應遺失後留下待傳並凍結內容／分析／擷取',
            frozen.pendingItems === 1 && frozen.pendingHidden === false
            && frozen.titleDisabled && frozen.bodyDisabled && frozen.analyzeDisabled && frozen.extractDisabled, frozen);
        check('凍結時主按鈕改為重試匯入且可點',
            frozen.saveDisabled === false && /重试导入|重試匯入/.test(frozen.saveText), frozen);
        check('第一次確認其實已建立文章（回應遺失情境成立）',
            articleRows().length === articlesBeforeAttempt + 1, { before: articlesBeforeAttempt, after: articleRows().length });
        check('第一次確認有送出逐段翻譯', aiCalls.filter((call) => call.kind === 'paragraph').length > translationsBeforeAttempt);
        const firstIds = articleIds();
        const articlesAfterAttempt = articleRows().length;
        const aiAfterAttempt = aiCalls.length;
        const translationsAfterAttempt = aiCalls.filter((call) => call.kind === 'paragraph').length;

        await context.unroute('**/articles');
        const markRetryClick = requestLog.length;
        await workspace.locator('#ext-article-save').click();
        await workspace.locator('#ext-article-open').waitFor({ state: 'visible', timeout: 60000 });
        await waitFor(async () => (await pendingArticles()) === 0, { timeout: 20000 });
        check('主按鈕重試成功後清空待傳', (await pendingArticles()) === 0);
        check('主按鈕重試不新增文章、文章 ID 不變',
            articleRows().length === articlesAfterAttempt && JSON.stringify(articleIds()) === JSON.stringify(firstIds),
            { ids: articleIds(), firstIds });
        check('主按鈕重試不重跑 AI', aiCalls.length === aiAfterAttempt
            && aiCalls.filter((call) => call.kind === 'paragraph').length === translationsAfterAttempt,
            { aiCalls: aiCalls.length - aiAfterAttempt, translations: aiCalls.filter((call) => call.kind === 'paragraph').length - translationsAfterAttempt });
        check('主按鈕重試不重送 POST /articles，只重用既有文章', writesSince(markRetryClick, '/articles') === 0,
            requestsSince(markRetryClick));
        check('重試成功不是靜默完成（提示沿用既有文章）', /沿用/.test(await noticeText()), { notice: await noticeText() });

        // 再次提取：已存在文章只做唯讀 GET；確認前不能補 page-link。
        await waitFor(async () => !(await workspace.locator('#ext-article-extract').isDisabled()));
        const markExisting = requestLog.length;
        const aiBeforeExisting = aiCalls.length;
        await workspace.locator('#ext-article-extract').click();
        const existingRequest = await waitFor(() => requestsSince(markExisting)
            .some((entry) => entry.method === 'GET' && entry.path.startsWith('/vocabulary/books?sourceUrl=')), { timeout: 20000 });
        await waitFor(async () => !(await workspace.locator('#ext-article-extract').isDisabled()), { timeout: 20000 });
        check('已存在文章提取只做唯讀 GET，不寫 page-link、不重送文章',
            !!existingRequest && writesSince(markExisting, '/vocabulary/page-link') === 0
            && writesSince(markExisting, '/articles') === 0 && aiCalls.length === aiBeforeExisting,
            requestsSince(markExisting));
        check('已存在文章顯示沿用入口與說明',
            await workspace.locator('#ext-article-open').isVisible() && /沿用/.test(await noticeText()),
            { notice: await noticeText() });

        // 只有明確「在 BDC 打開」才補 page-link。
        await popup.evaluate((appBase) => chrome.storage.local.set({ bdc_extension_app_url: appBase }), env.appBase);
        const markOpen = requestLog.length;
        await workspace.locator('#ext-article-open').click();
        await waitFor(() => writesSince(markOpen, '/vocabulary/page-link') === 1, { timeout: 15000 });
        const openedApp = await waitFor(() => workspace.url().startsWith(env.appBase) ? workspace.url() : false, { timeout: 15000 });
        check('只有明確「在 BDC 打開」才補 page-link', writesSince(markOpen, '/vocabulary/page-link') === 1, requestsSince(markOpen));
        check('開啟既有文章不重送文章、不重跑 AI',
            writesSince(markOpen, '/articles') === 0 && aiCalls.length === aiBeforeExisting, requestsSince(markOpen));
        check('開啟既有文章後導向 BDC 文章路由', !!openedApp, { url: workspace.url() });

        check('流程中沒有未捕獲頁面錯誤', errors.length === 0, { errors, consoles });
    } catch (error) {
        process.exitCode = 1;
        checks.push({ name: 'execution', ok: false, detail: error.stack });
        console.error(error.stack);
    } finally {
        fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({
            checks, errors, consoles, aiCalls, requestLog, cleanupPeak, realMV3: true, realWorkerSQLite: true, aiMocked: true
        }, null, 2));
        if (context) await context.close().catch(() => {});
        await env.close();
        await articleServer.close();
        fs.rmSync(profile, { recursive: true, force: true });
        const failed = checks.filter((item) => !item.ok).length;
        if (failed) process.exitCode = 1;
        console.log(JSON.stringify({ passed: checks.length - failed, failed, output: OUT }));
    }
})();
