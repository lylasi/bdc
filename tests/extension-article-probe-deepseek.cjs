// DeepSeek 定向診斷：擴充套件 0.5.0「AI 提取本頁文章」被前置查詢整段阻塞的現場重建。
//
// 真 MV3（真 Chromium 載入 extension/）＋真 Worker 路由＋真 SQLite（tests/helpers/extension-mv3.cjs），
// 只有 AI transport 是 mock。唯一注入點是「既有文章預查」那一個請求：
//     GET /vocabulary/books?sourceUrl=<目前網頁>
// 也就是使用者回報的紅色請求 books?sourceUrl=https%3A...
//
// 想回答三個問題：
//   1. 這個預查失敗時，「AI 提取」還會不會跑？（env.state.aiCalls 有沒有增加）
//   2. 不同失敗形態（連線失敗／後端 500／邊緣 502 HTML／舊版 Worker 404／超過 10 秒／page-link 競態）
//      在 workspaceNotice 上分別顯示什麼？截圖那句「無法連線到同步服務」是哪一種？
//   3. 同一時間 /ai-credentials 與不帶 sourceUrl 的 GET /vocabulary/books 是否仍然正常？
//      （若正常，畫面卻說「連不上同步服務」，那就是錯誤分類問題，不是網路問題）
//
// 不改產品檔、不改既有測試、不連正式 Worker。輸出寫到 docs/report/assets/<時間戳>_article-probe-deepseek/。
//
// 注意：本檔是「基準 5b20535（0.5.0）」的現場重建，斷言的是舊的阻塞行為；
// 在 0.5.1 工作樹上跑會 FAIL（＝舊故障已不再重現），這是預期結果。
// 0.5.1 的新行為驗收請跑 tests/extension-article-compact-deepseek.cjs。
//
// 執行：PLAYWRIGHT_MODULE=<playwright> node tests/extension-article-probe-deepseek.cjs

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { environment, ALICE } = require('./helpers/extension-mv3.cjs');

const ROOT = path.resolve(__dirname, '..');
const stamp = new Date(Date.now() + 8 * 3600000).toISOString().replace(/\D/g, '').slice(0, 17);
const OUT = process.env.ARTICLE_PROBE_OUTPUT || path.join(ROOT, 'docs/report/assets', stamp + '_article-probe-deepseek');

// 產品文案（locales/zh-CN.js，預設介面語言）——直接對照截圖那句。
const CANNOT_REACH_SYNC = '无法连接到同步服务';
const AI_TIMEOUT = 'AI 请求超时';
const WORKSPACE_FAILED = '操作未完成，已提交的待传项目可在下方重试。';
const EXTRACT_PROGRESS = '正在读取网页并提取正文…';
const PREVIEW_READY = '提取完成，请检查标题与正文后保存。';
const CORS_ALL = { 'Access-Control-Allow-Origin': '*' };

const TESTED_FILES = [
    'extension/workspace-ui.js', 'modules/extension-workspace.js', 'modules/sync-cloudflare.js',
    'modules/api.js', 'shared/workspace-client.mjs', 'shared/page-protocol.mjs',
    'cloudflare-worker/src/worker.js', 'cloudflare-worker/src/captures.js',
    'cloudflare-worker/src/capture-books.js', 'cloudflare-worker/src/page-links.js', 'cloudflare-worker/src/http.js',
    'locales/zh-CN.js', 'tests/helpers/extension-mv3.cjs'
];

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const checks = [];
const scenarios = [];
function check(name, ok, detail) {
    checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ': ' + JSON.stringify(detail)}`);
}
function productHashes() {
    return Object.fromEntries(TESTED_FILES.map((file) => {
        const bytes = fs.readFileSync(path.join(ROOT, file));
        return [file, createHash('sha256').update(bytes).digest('hex').slice(0, 16)];
    }));
}

const isPreCheck = (url) => url.pathname === '/vocabulary/books' && url.searchParams.has('sourceUrl');

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    execFileSync(process.execPath, ['scripts/package-extension.mjs'], { cwd: ROOT });
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-article-probe-'));
    const traffic = [];
    const failures = [];
    const pageErrors = [];
    let env;
    let context;
    try {
        env = await environment();
        const extension = path.join(ROOT, 'extension');
        context = await chromium.launchPersistentContext(profile, {
            channel: 'chromium', headless: true, viewport: { width: 1280, height: 900 },
            args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
        });
        context.on('page', (page) => page.on('pageerror', (error) => pageErrors.push(error.message)));
        // 只記錄送到測試同步伺服器的請求；這是 DevTools Network 面板的等價證據。
        context.on('request', (request) => {
            const address = request.url();
            if (!address.startsWith(env.base)) return;
            traffic.push({ method: request.method(), path: address.slice(env.base.length) });
        });
        context.on('requestfailed', (request) => {
            const address = request.url();
            if (!address.startsWith(env.base)) return;
            failures.push({ path: address.slice(env.base.length), error: request.failure()?.errorText || '' });
        });
        const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
        const base = `chrome-extension://${new URL(worker.url()).host}`;

        const popup = await context.newPage();
        await popup.goto(base + '/lookup.html');
        await popup.waitForFunction(() => !!document.querySelector('#ext-account-status').textContent);
        await popup.locator('#ext-endpoint-input').fill(env.base);
        await popup.locator('#ext-login-mode').selectOption('token');
        await popup.locator('#ext-token-input').fill(ALICE);
        await popup.locator('#ext-connect-btn').click();
        await popup.waitForFunction(() => /已连接账户/.test(document.querySelector('#ext-account-status').textContent), null, { timeout: 30000 });
        check('基線：擴充套件頁面連上測試帳戶並載入 managed AI 設定', true);

        const article = await context.newPage();
        await article.goto(env.base + '/test-article');

        const workspaceState = () => popup.evaluate(() => ({
            notice: (document.querySelector('#ext-workspace-notice')?.textContent || '').trim(),
            noticeHidden: document.querySelector('#ext-workspace-notice')?.hidden !== false,
            previewHidden: document.querySelector('#ext-article-preview')?.hidden !== false,
            title: document.querySelector('#ext-article-title')?.value || '',
            bodyLength: (document.querySelector('#ext-article-body')?.value || '').length,
            extractDisabled: document.querySelector('#ext-article-extract')?.disabled !== false
        }));

        /**
         * 重開面板 → 等乾淨狀態 → 按「AI 提取本頁文章」→ 等這次擷取結束。
         * inject(context) 可註冊任何 route；每個情境開始前先清掉上一個情境的注入。
         */
        async function runExtract({ inject = null } = {}) {
            await context.unrouteAll({ behavior: 'ignoreErrors' });
            if (inject) await inject(context);
            await popup.reload();
            await popup.waitForFunction(() => /已连接账户/.test(document.querySelector('#ext-account-status')?.textContent || ''), null, { timeout: 30000 });
            await popup.waitForFunction(() => document.querySelector('#ext-workspace-notice')?.hidden !== false
                && document.querySelector('#ext-article-extract')?.disabled === false, null, { timeout: 30000 });
            const mark = traffic.length;
            const aiBefore = env.state.aiCalls;
            await article.bringToFront();
            await popup.locator('#ext-article-extract').click();
            await popup.waitForFunction((progress) => {
                const notice = document.querySelector('#ext-workspace-notice');
                const extract = document.querySelector('#ext-article-extract');
                return !!notice && !notice.hidden && !(notice.textContent || '').includes(progress) && extract && !extract.disabled;
            }, EXTRACT_PROGRESS, { timeout: 60000 });
            await sleep(300);
            return { state: await workspaceState(), requests: traffic.slice(mark), aiCalls: env.state.aiCalls - aiBefore };
        }

        /* ---------- S0 對照：不注入，擷取應該真的跑到 AI ---------- */
        const baseline = await runExtract();
        scenarios.push({ id: 'S0', title: '對照：不注入任何故障', ...baseline });
        check('S0 對照組：預查成功後 AI 真的被呼叫', baseline.aiCalls > 0 && !baseline.state.previewHidden, baseline.state);
        check('S0 對照組：畫面顯示「提取完成」', baseline.state.notice === PREVIEW_READY, { notice: baseline.state.notice });
        check('S0 對照組：預查請求真的帶 sourceUrl 參數',
            baseline.requests.some((entry) => entry.method === 'GET' && entry.path.startsWith('/vocabulary/books?sourceUrl=')),
            baseline.requests);

        /* ---------- S1 傳輸層失敗（等同截圖的紅色請求） ---------- */
        const transport = await runExtract({
            inject: (ctx) => ctx.route(isPreCheck, (route) => route.abort('failed'))
        });
        scenarios.push({ id: 'S1', title: '預查請求連線失敗（route.abort / net::ERR_FAILED）', ...transport });
        check('S1 預查連線失敗：畫面顯示「无法连接到同步服务」（＝截圖那句）',
            transport.state.notice === CANNOT_REACH_SYNC, { notice: transport.state.notice });
        check('S1 預查連線失敗：AI 完全沒有被呼叫（擷取整段被阻塞）', transport.aiCalls === 0, { aiCalls: transport.aiCalls });
        check('S1 預查連線失敗：沒有產生任何預覽', transport.state.previewHidden === true);

        /* ---------- S2 後端 500 JSON（Worker／D1 出錯） ---------- */
        const backend500 = await runExtract({
            inject: (ctx) => ctx.route(isPreCheck, (route) => route.fulfill({ status: 500, contentType: 'application/json', headers: CORS_ALL, body: '{"error":"capture_failed","code":"capture_failed"}' }))
        });
        scenarios.push({ id: 'S2', title: '預查回 500 capture_failed（後端／D1 錯誤）', ...backend500 });
        check('S2 後端 500：AI 一樣沒有被呼叫', backend500.aiCalls === 0, { aiCalls: backend500.aiCalls });
        check('S2 後端 500：畫面不是「無法連線到同步服務」而是通用失敗訊息（HTTP 錯誤沒被當成網路錯誤，但真正原因被吃掉）',
            backend500.state.notice === WORKSPACE_FAILED, { notice: backend500.state.notice });

        /* ---------- S3 邊緣 502 HTML 且沒有 CORS 標頭（Cloudflare 錯誤頁形態） ---------- */
        const edge502 = await runExtract({
            inject: (ctx) => ctx.route(isPreCheck, (route) => route.fulfill({ status: 502, contentType: 'text/html', body: '<html><body>Bad gateway</body></html>' }))
        });
        scenarios.push({ id: 'S3', title: '邊緣 502 HTML、無 Access-Control-Allow-Origin（Cloudflare 錯誤頁）', ...edge502 });
        check('S3 邊緣 502 無 CORS：AI 沒有被呼叫', edge502.aiCalls === 0, { aiCalls: edge502.aiCalls });
        check('S3 邊緣 502 無 CORS：畫面不是「提取完成」', edge502.state.notice !== PREVIEW_READY, { notice: edge502.state.notice });

        /* ---------- S4 舊版 Worker：路由不存在（404 JSON） ---------- */
        const stale404 = await runExtract({
            inject: (ctx) => ctx.route(isPreCheck, (route) => route.fulfill({ status: 404, contentType: 'application/json', headers: CORS_ALL, body: '{"error":"not_found","code":"not_found"}' }))
        });
        scenarios.push({ id: 'S4', title: '舊版 Worker／路由不存在（404 not_found）', ...stale404 });
        check('S4 404：AI 沒有被呼叫', stale404.aiCalls === 0, { aiCalls: stale404.aiCalls });
        check('S4 404：顯示通用失敗訊息（沒有提示「請更新服務端」）',
            stale404.state.notice === WORKSPACE_FAILED, { notice: stale404.state.notice });

        /* ---------- S5 逾時：預查自己的 10 秒上限 ---------- */
        const timeout = await runExtract({
            inject: (ctx) => ctx.route(isPreCheck, async (route) => {
                await sleep(11500);
                await route.abort('timedout').catch(() => {});
            })
        });
        scenarios.push({ id: 'S5', title: '預查超過 findExistingPageArticle 的 10 秒預設逾時', ...timeout });
        check('S5 逾時：AI 沒有被呼叫', timeout.aiCalls === 0, { aiCalls: timeout.aiCalls });
        check('S5 逾時：顯示「AI 请求超时」（與 workspace-client 的 30 秒不一致）',
            timeout.state.notice === AI_TIMEOUT, { notice: timeout.state.notice });

        /* ---------- S6 page-link 競態：GET 說有文章，POST page-link 404 ---------- */
        const linkRace = await runExtract({
            inject: async (ctx) => {
                await ctx.route(isPreCheck, (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: CORS_ALL,
                    body: '{"books":[],"defaultBookId":"","pageBookId":"","articleId":"art_race_probe"}' }));
                await ctx.route((url) => url.pathname === '/vocabulary/page-link', (route) => route.fulfill({ status: 404, contentType: 'application/json', headers: CORS_ALL,
                    body: '{"error":"article_not_found","code":"article_not_found"}' }));
            }
        });
        scenarios.push({ id: 'S6', title: '預查第二步 page-link 回 404 article_not_found', ...linkRace });
        check('S6 page-link 404：AI 沒有被呼叫', linkRace.aiCalls === 0, { aiCalls: linkRace.aiCalls });
        check('S6 page-link 404：顯示通用失敗訊息', linkRace.state.notice === WORKSPACE_FAILED, { notice: linkRace.state.notice });

        /* ---------- S7a 對照：預查壞掉的同一刻，同步服務其實是好的 ---------- */
        await context.unrouteAll({ behavior: 'ignoreErrors' });
        await popup.reload();
        await popup.waitForFunction(() => /已连接账户/.test(document.querySelector('#ext-account-status')?.textContent || ''), null, { timeout: 30000 });
        await popup.waitForFunction(() => document.querySelector('#ext-workspace-notice')?.hidden !== false
            && document.querySelector('#ext-article-extract')?.disabled === false, null, { timeout: 30000 });
        await context.route(isPreCheck, (route) => route.abort('failed'));
        // 登入後帳戶區塊會自動收起；展開才有「重新同步配置」可按。
        await popup.evaluate(() => { const details = document.getElementById('ext-account-details'); if (details) details.open = true; });
        const syncMark = traffic.length;
        const failedMark = failures.length;
        await popup.locator('#ext-sync-btn').click();
        await popup.waitForFunction(() => document.querySelector('#ext-sync-btn')?.disabled === false, null, { timeout: 90000 });
        const syncTraffic = traffic.slice(syncMark);
        const syncFailures = failures.slice(failedMark);
        const aiCredentialHits = syncTraffic.filter((entry) => entry.path.startsWith('/ai-credentials'));
        const snapshotHits = syncTraffic.filter((entry) => entry.path === '/snapshot');
        scenarios.push({ id: 'S7a', title: '預查仍失敗時按「重新同步配置」：同步服務本身正常', syncTraffic, syncFailures });
        check('S7a 預查失敗的同時，/ai-credentials 仍被正常呼叫（正是回報的「ai-credentials仍200」）',
            aiCredentialHits.length > 0 && !syncFailures.some((entry) => entry.path.startsWith('/ai-credentials')),
            { aiCredentialHits, syncFailures });
        check('S7a 預查失敗的同時，/snapshot 與帳戶狀態都正常（同步服務可達、token 有效）',
            snapshotHits.length > 0 && /已连接账户/.test(await popup.locator('#ext-account-status').textContent()),
            { snapshotHits, status: await popup.locator('#ext-account-status').textContent() });

        /* ---------- S7b 同一刻再擷取：畫面卻說「连不上同步服务」 ---------- */
        const juxtaposed = await runExtract({ inject: (ctx) => ctx.route(isPreCheck, (route) => route.abort('failed')) });
        scenarios.push({ id: 'S7b', title: '同一 session：同步正常但預查失敗 → 顯示的仍是「无法连接到同步服务」', ...juxtaposed });
        check('S7b 同步服務正常、預查失敗時畫面仍顯示「无法连接到同步服务」（誤導性結論的直接證據）',
            juxtaposed.state.notice === CANNOT_REACH_SYNC && juxtaposed.aiCalls === 0, { notice: juxtaposed.state.notice, aiCalls: juxtaposed.aiCalls });

        /* ---------- S7c 解除注入：擷取恢復 ---------- */
        const markRecover = traffic.length;
        const recovered = await runExtract();
        const duringRecover = traffic.slice(markRecover);
        const plainBookHits = duringRecover.filter((entry) => entry.method === 'GET' && entry.path === '/vocabulary/books');
        scenarios.push({ id: 'S7c', title: '對照：解除注入後同一 session 內恢復', ...recovered, duringRecover });
        check('S7c 解除注入後擷取恢復（AI 有跑、預覽出現）', recovered.aiCalls > 0 && !recovered.state.previewHidden, recovered.state);
        check('S7c 不帶 sourceUrl 的詞書清單一直正常（故障只在 sourceUrl 分支）',
            plainBookHits.length > 0, { requests: duringRecover.filter((entry) => entry.path.startsWith('/vocabulary/books')) });

        /* ---------- 總結 ---------- */
        const blockedScenarios = scenarios.filter((entry) => !['S0', 'S7a', 'S7c'].includes(entry.id));
        check('總結：預查的各種故障形態全部讓 AI 一次都沒跑（不是 AI 供應商問題）',
            blockedScenarios.every((entry) => entry.aiCalls === 0), blockedScenarios.map((entry) => ({ id: entry.id, aiCalls: entry.aiCalls })));
        check('總結：只有「連線失敗」會顯示截圖那句「无法连接到同步服务」',
            scenarios.filter((entry) => entry.state?.notice === CANNOT_REACH_SYNC).map((entry) => entry.id).join(',') === 'S1,S7b',
            scenarios.map((entry) => ({ id: entry.id, notice: entry.state?.notice })));
        check('總結：沒有任何失敗形態提示「請更新同步服務」或指出真正的後端錯誤',
            blockedScenarios.every((entry) => !/更新服务端|更新服務端|Worker|502|500/i.test(entry.state?.notice || '')));
    } catch (error) {
        pageErrors.push(String((error && error.stack) || error));
        check('測試流程未拋出例外', false, String((error && error.message) || error));
    } finally {
        try {
            const result = {
                stamp, generatedAt: new Date().toISOString(), baselineCommit: '5b20535',
                testedFiles: productHashes(), scenarios, checks,
                requestFailures: failures,
                summary: {
                    pass: checks.filter((entry) => entry.ok).length,
                    fail: checks.filter((entry) => !entry.ok).length,
                    notices: scenarios.map((entry) => ({ id: entry.id, aiCalls: entry.aiCalls, notice: entry.state?.notice }))
                }
            };
            fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(result, null, 2));
            fs.writeFileSync(path.join(OUT, 'traffic.log'), JSON.stringify({ failures, pageErrors }, null, 2));
            console.log('[probe] artifact: ' + path.join(OUT, 'results.json'));
        } catch (writeError) { console.error('artifact 寫入失敗：' + writeError.message); }
        if (context) await context.close().catch(() => {});
        if (env) await env.close().catch(() => {});
        fs.rmSync(profile, { recursive: true, force: true });
        console.log(`[probe] ${checks.filter((entry) => entry.ok).length}/${checks.length} checks passed`);
    }
})();
