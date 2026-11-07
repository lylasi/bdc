// Real MV3 runtime + Worker/SQLite, deterministic local provider latency.
// SPEED_BASELINE=1 records the old runtime without requiring the new behaviour.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { environment, ALICE, BOB } = require('./helpers/extension-mv3.cjs');
const ROOT = path.resolve(__dirname, '..');
const OUT = process.env.ARTICLE_SPEED_OUTPUT || path.join(os.tmpdir(), 'bdc-article-speed');
const baseline = process.env.SPEED_BASELINE === '1';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const checks = [], calls = [], errors = [], metrics = {};
function check(name, ok, detail) {
    checks.push({ name, ok: !!ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
    assert.ok(ok, detail ? name + ': ' + JSON.stringify(detail) : name);
}
async function until(run) {
    for (let n = 0; n < 400; n++) { const value = await run(); if (value) return value; await pause(25); }
    throw new Error('Timed out waiting for state');
}
(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const extension = process.env.SPEED_EXTENSION_PATH || path.join(ROOT, 'extension');
    if (!process.env.SPEED_EXTENSION_PATH) execFileSync(process.execPath, ['scripts/package-extension.mjs'], { cwd: ROOT });
    const env = await environment();
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-article-speed-'));
    let context, mode = 'normal', active = 0, peak = 0;
    try {
        context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
            args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension] });
        context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
        await context.route(env.base + '/mock-ai/**', async (route) => {
            const req = route.request();
            if (req.method() !== 'POST') return route.continue();
            const body = req.postDataJSON();
            const prompt = (body.messages || []).map((message) => message.content).join('\n');
            const slot = prompt.match(/([A-Z]+)_SLOT_(\d+)/);
            if (!slot) return route.continue();
            const prefix = slot[1], index = Number(slot[2]);
            const requestMode = mode;
            const call = { prefix, index, started: performance.now(), mode: requestMode, maxTokens: body.max_tokens };
            calls.push(call); active++; peak = Math.max(peak, active);
            const delays = [1800, 700, 1000, 1200, 800, 1500, 900, 1100];
            const delay = ['SPEED', 'CLEAN'].includes(prefix) ? delays[index] : ['CANCEL', 'LOCALE', 'ACCOUNT', 'CATALOG'].includes(prefix) ? 1800 : 600;
            try {
                if (requestMode === 'rate-limit') {
                    await route.fulfill({ status: 429, headers: { 'Access-Control-Allow-Origin': '*', 'Retry-After': '10' },
                        contentType: 'application/json', body: '{"error":{"message":"test rate limit"}}' });
                } else {
                    await pause(delay);
                    const fallback = requestMode === 'fallback';
                    const failed = (requestMode === 'fail' && prefix === 'FAIL' && index === 2) || (fallback && !!body.response_format);
                    const truncated = requestMode === 'truncate';
                    await route.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*' }, contentType: 'application/json',
                        body: JSON.stringify({ choices: [{ finish_reason: truncated ? 'length' : 'stop', message: {
                            content: prefix === 'CLEAN' ? `# CLEAN_SLOT_${index}\n\nCleaned original English segment ${index}.`
                                : fallback && !failed ? `譯文 ${prefix} ${index}` : JSON.stringify(failed ? {} : { chinese_translation: `譯文 ${prefix} ${index}` })
                        } }] }) });
                }
                call.fulfilled = performance.now();
            } catch (_) { call.canceled = true; }
            finally { active--; }
        });
        const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
        const base = 'chrome-extension://' + new URL(worker.url()).host;
        const page = await context.newPage(); await page.goto(base + '/lookup.html');
        await page.waitForFunction(() => !!document.querySelector('#ext-account-status').textContent);
        await page.locator('#ext-settings-open').click();
        await page.locator('#ext-endpoint-input').fill(env.base); await page.locator('#ext-login-mode').selectOption('token');
        await page.locator('#ext-token-input').fill(ALICE); await page.locator('#ext-connect-btn').click();
        await page.waitForFunction(() => !document.querySelector('#ext-connect-btn').disabled && document.querySelector('#ext-account-status').textContent.includes('alice'));
        await page.locator('#ext-settings-close').click();
        const body = (prefix, count = 8) => Array.from({ length: count }, (_, n) => (n ? '' : '# ') + `${prefix}_SLOT_${n} Original paragraph ${n}.`).join('\n\n');
        async function run(text) {
            return page.evaluate(async (body) => {
                const runtime = await import('./modules/extension-ai-runtime.js');
                const progress = [], start = performance.now();
                try {
                    const result = await runtime.runExtensionArticleTask({ article: { body }, analyze: true,
                        onProgress: (done, total) => progress.push({ done, total, time: performance.now() - start }) });
                    return { result, progress, ms: performance.now() - start };
                } catch (error) { return { error: { name: error.name, code: error.code }, progress, ms: performance.now() - start }; }
            }, text);
        }
        const measured = await run(body('SPEED'));
        metrics.cold = { ms: measured.ms, peak, requests: calls.filter((call) => call.prefix === 'SPEED').length, progress: measured.progress };
        check('延遲供應商仍按原文順序組合全部段落', measured.result?.paragraph_analysis?.length === 8 && measured.result.paragraph_analysis.every((part, i) => part.chinese_translation === `譯文 SPEED ${i}`));
        check('實際請求並行不超過兩個', peak <= 2, metrics.cold);
        const cleanup = await page.evaluate(async (text) => {
            const api = await import('./modules/api.js');
            const progress = [], start = performance.now();
            const result = await api.aiCleanArticleMarkdown(text, { onProgress: (done, total) => progress.push({ done, total }) });
            return { text: result, progress, ms: performance.now() - start };
        }, Array.from({ length: 3 }, (_, i) => `CLEAN_SLOT_${i} ` + 'Original English source text. '.repeat(112)).join('\n\n'));
        const cleanupCalls = calls.filter((call) => call.prefix === 'CLEAN');
        const cleanupPeak = Math.max(...cleanupCalls.map((call) => cleanupCalls.filter((other) => other.started <= call.started && other.fulfilled > call.started).length));
        metrics.cleanup = { ms: cleanup.ms, peak: cleanupPeak, requests: cleanupCalls.length, progress: cleanup.progress };
        check('多塊清洗維持原始順序及全部段落', cleanupCalls.length === 3 && cleanup.text.indexOf('CLEAN_SLOT_0') < cleanup.text.indexOf('CLEAN_SLOT_1')
            && cleanup.text.indexOf('CLEAN_SLOT_1') < cleanup.text.indexOf('CLEAN_SLOT_2'));
        if (baseline) { console.log(JSON.stringify(metrics)); return; }
        check('清洗最多兩塊並行，完成進度由零開始', cleanupPeak === 2 && cleanup.progress[0]?.done === 0 && cleanup.progress.at(-1)?.done === 3, metrics.cleanup);
        check('確認後能同時處理兩段', metrics.cold.peak === 2, metrics.cold);
        const starts = calls.filter((call) => call.prefix === 'SPEED').map((call) => call.started);
        check('並行仍保留設定的請求開始間隔', starts.every((time, i) => i === 0 || time - starts[i - 1] >= 450), starts);
        check('完成進度從零開始且單調遞增', measured.progress[0]?.done === 0 && measured.progress.at(-1)?.done === 8
            && measured.progress.every((item, i, all) => item.total === 8 && (i === 0 || item.done >= all[i - 1].done)), measured.progress);
        check('最後一段完成後才顯示全數完成', measured.progress.at(-1).time >= Math.max(...calls.filter((call) => call.prefix === 'SPEED').map((call) => call.fulfilled - calls.find((entry) => entry.prefix === 'SPEED').started)) - 50);
        const countBeforeCache = calls.length;
        const cached = await run(body('SPEED'));
        metrics.cached = { ms: cached.ms, requests: calls.length - countBeforeCache };
        check('重做同一文章直接復用成功段落，不再翻譯', cached.result?.paragraph_analysis?.length === 8 && calls.length === countBeforeCache, metrics.cached);
        const duplicate = await run('# DUP_SLOT_0 Title.\n\nDUP_SLOT_1 Repeated paragraph.\n\nDUP_SLOT_1 Repeated paragraph.\n\nDUP_SLOT_2 Last paragraph.');
        check('同一文章相同段落只請求一次，保留全部位置', calls.filter((call) => call.prefix === 'DUP').length === 3
            && duplicate.result?.paragraph_analysis?.length === 4 && duplicate.result.paragraph_analysis[1].chinese_translation === duplicate.result.paragraph_analysis[2].chinese_translation);
        await page.evaluate(async () => { (await import('./ai-config.js')).AI_LIMITS.articleParagraphTranslation.maxConcurrency = 1; });
        const limited = await run(body('LIMIT', 3));
        const limitCalls = calls.filter((call) => call.prefix === 'LIMIT');
        check('配置限制為一個時仍逐個傳輸', !!limited.result && limitCalls.length === 3
            && limitCalls.every((call, index) => index === 0 || call.started >= limitCalls[index - 1].fulfilled - 10), limitCalls);
        await page.evaluate(async () => { (await import('./ai-config.js')).AI_LIMITS.articleParagraphTranslation.maxConcurrency = 2; });
        mode = 'fail';
        const failed = await run(body('FAIL', 6));
        check('失敗時不返回半份文章，不報完成百分百', failed.error?.code === 'page_analysis_failed' && failed.progress.at(-1)?.done < 6);
        const completedBefore = calls.filter((call) => call.prefix === 'FAIL' && call.index < 2).length;
        mode = 'normal';
        const retried = await run(body('FAIL', 6));
        check('重試復用已成功段落，只補未完成的段落', retried.result?.paragraph_analysis?.length === 6
            && calls.filter((call) => call.prefix === 'FAIL' && call.index < 2).length === completedBefore);
        async function begin(text) {
            await page.evaluate(async (body) => {
                const runtime = await import('./modules/extension-ai-runtime.js');
                window.speedController = new AbortController();
                window.speedResult = null;
                window.speedJob = runtime.runExtensionArticleTask({ article: { body }, analyze: true, signal: window.speedController.signal })
                    .then((result) => { window.speedResult = { result }; }, (error) => { window.speedResult = { name: error.name, code: error.code }; });
            }, text);
        }
        await page.evaluate(async () => { (await import('./ai-config.js')).AI_LIMITS.articleParagraphTranslation.maxConcurrency = 1; });
        await begin(body('CANCEL'));
        await until(() => calls.some((call) => call.prefix === 'CANCEL'));
        const cancelStart = performance.now();
        await page.evaluate(() => window.speedController.abort());
        const canceled = await until(() => page.evaluate(() => window.speedResult));
        metrics.cancelMs = performance.now() - cancelStart;
        check('停止能快速結束在途與排隊工作', canceled.name === 'AbortError' && metrics.cancelMs < 800 && calls.filter((call) => call.prefix === 'CANCEL').length === 1, { canceled, ms: metrics.cancelMs });
        await page.evaluate(async () => { (await import('./ai-config.js')).AI_LIMITS.articleParagraphTranslation.maxConcurrency = 2; });
        await pause(1900);
        mode = 'rate-limit';
        await begin(body('BACKOFF'));
        await until(() => calls.some((call) => call.prefix === 'BACKOFF' && call.fulfilled));
        const backoffStart = performance.now(); await page.evaluate(() => window.speedController.abort());
        const stoppedBackoff = await until(() => page.evaluate(() => window.speedResult));
        metrics.backoffCancelMs = performance.now() - backoffStart;
        check('429 退避期間停止不必等待 Retry-After', stoppedBackoff.name === 'AbortError' && metrics.backoffCancelMs < 800, metrics.backoffCancelMs);
        mode = 'normal';
        await begin(body('CATALOG', 2));
        await until(() => calls.some((call) => call.prefix === 'CATALOG'));
        const refreshed = await page.evaluate(async () => {
            const catalog = await import('./modules/ai-catalog.js');
            const before = catalog.getCatalogState().version;
            await catalog.refreshAICatalog({ force: true, reason: 'speed-test' });
            return { before, after: catalog.getCatalogState().version };
        });
        const afterRefresh = await until(() => page.evaluate(() => window.speedResult));
        check('同版本供應商列表刷新不會誤停翻譯', refreshed.before === refreshed.after && afterRefresh.result?.paragraph_analysis?.length === 2, { refreshed, result: afterRefresh.code });
        await begin(body('LOCALE'));
        await until(() => calls.some((call) => call.prefix === 'LOCALE'));
        await page.evaluate(async () => (await import('./modules/i18n.js')).setLocale('zh-HK'));
        const localeChange = await until(() => page.evaluate(() => window.speedResult));
        check('更換語言中止舊任務，不組合混合語言文章', localeChange.code === 'article_context_changed' && !localeChange.result, localeChange);
        await pause(1900);
        mode = 'truncate';
        const truncated = await run(body('TRUNCATE', 1));
        check('連續截斷的非空回應不被當作完整翻譯保存', truncated.error?.code === 'page_analysis_failed', truncated);
        const beforeTruncationRetry = calls.filter((call) => call.prefix === 'TRUNCATE').length;
        mode = 'normal';
        const complete = await run(body('TRUNCATE', 1));
        check('截斷結果不寫成功快取，之後可正常重試', !!complete.result && calls.filter((call) => call.prefix === 'TRUNCATE').length > beforeTruncationRetry);
        mode = 'fallback';
        const fallback = await run(body('FALLBACK', 2));
        const fallbackCalls = calls.filter((call) => call.prefix === 'FALLBACK').length;
        check('JSON 後備路徑仍能取得完整翻譯', fallback.result?.paragraph_analysis?.length === 2 && fallbackCalls === 4);
        const repeatedFallback = await run(body('FALLBACK', 2));
        check('成功的純文字後備也能復用快取', !!repeatedFallback.result && calls.filter((call) => call.prefix === 'FALLBACK').length === fallbackCalls);
        mode = 'normal';
        await run(body('SCOPE', 2));
        const aliceScopeCalls = calls.filter((call) => call.prefix === 'SCOPE').length;
        await begin(body('ACCOUNT'));
        await until(() => calls.some((call) => call.prefix === 'ACCOUNT'));
        await page.evaluate(async () => (await import('./modules/extension-ai-runtime.js')).disconnectExtensionAccount());
        const signedOut = await until(() => page.evaluate(() => window.speedResult));
        check('登出會收束舊帳戶任務，沒有遲到文章結果', !signedOut.result && (signedOut.name === 'AbortError' || signedOut.code === 'stale_session'), signedOut);
        await page.evaluate(async ({ endpoint, token }) => (await import('./modules/extension-ai-runtime.js')).connectExtensionAccount({ endpoint, mode: 'token', token }), { endpoint: env.base, token: BOB });
        const bob = await run(body('SCOPE', 2));
        check('另一帳戶不命中前一帳戶的段落快取', !!bob.result && calls.filter((call) => call.prefix === 'SCOPE').length === aliceScopeCalls + 2);
        check('沒有意外頁面錯誤或文章寫入', errors.length === 0 && env.db.prepare("SELECT COUNT(*) AS n FROM articles").get().n === 0, errors);
        console.log(JSON.stringify(metrics));
    } finally {
        fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ baseline, checks, metrics, calls, errors }, null, 2));
        await context?.close(); await env.close(); fs.rmSync(profile, { recursive: true, force: true });
    }
})().catch((error) => { console.error(error); process.exitCode = 1; });
