// DeepSeek 獨立驗收：0.5.1「文章擷取前置查詢容錯」與「收藏列精簡」。
//
// 真 MV3（真 Chromium 載入 extension/）＋真 Worker 路由＋真 SQLite（tests/helpers/extension-mv3.cjs），
// 只有 AI transport 是 mock。所有故障都注入在本機測試同步伺服器之前（context.route），
// 不連正式服務、不讀私有設定、不改產品檔、不改既有測試。
//
// 驗收面（對應交辦）：
//   A 非認證類預查故障不得阻擋 AI：斷線／503 非 JSON／500 JSON／404／200 畸形 JSON／6 秒逾時／
//     GET 說有文章而 page-link 回 404 article_not_found（競態被刪）
//   B 認證類必須阻擋 AI：401 JSON／401 非 JSON body（證明 status 未被 JSON 解析吃掉）／403／登出／切帳戶
//   C 預查仍在連線時取消：不啟動 AI
//   D 既有雲端文章正常時：AI 0 次、直接沿用並可按「在 BDC 打开」
//   E 保存：仍去重（含預查失敗後保存才發現既有文章）、失敗入待傳並鎖定、恢復後重試不重跑 AI、
//     真回執＋頁書關聯、不宣稱假成功
//   F 收藏列：select＋加入＋⋯ 同一行；⋯ 內可新建／設預設／更新詞書；關閉時不佔高
//   G 0 詞書：仍可 quickcreate（新建並加入）完成收藏
//   H 幾何：320／340／420 兩語同一行且無溢出；完整面板按內容自然高度且固定右上；
//     窄窗草稿確認可點、不被 adaptive height 剪裁
//   I 收藏列提示邊界（工作樹修正：restoreChoice／change handler 只清 captureTargetMissing）：
//     I1 建頁書時舊快取書單先套用（暫時 targetMissing）→ 網路回應補上新書後必須清除且成功選中
//     I2 詞書真的被刪除（雲端 soft delete）→ 重新拉書單後仍必須提示 targetMissing
//     I3 手動改選其他有效詞書 → 舊 targetMissing 必須清除、選取寫回本機
//     I4 與書單無關的待傳／錯誤提示，不得因改選或書單刷新被無差別清空
//     I5 待傳在服務恢復後可重試成功（真收據、待傳清空）
//
// 執行：PLAYWRIGHT_MODULE=<playwright> node tests/extension-article-compact-deepseek.cjs
// 只跑 I 階段（定向複測，約 30 秒）：加 DSH_BOOK_NOTICE_ONLY=1
// 對修正前的擴充套件跑同一支腳本（baseline，預期失敗）：
//   cp -R extension /tmp/bdc-prefix-ext && git show <pre-fix>:extension/capture-ui.js > /tmp/bdc-prefix-ext/capture-ui.js
//   ARTICLE_COMPACT_EXT_DIR=/tmp/bdc-prefix-ext DSH_BOOK_NOTICE_ONLY=1 node tests/extension-article-compact-deepseek.cjs

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { environment, ALICE, BOB } = require('./helpers/extension-mv3.cjs');

const ROOT = path.resolve(__dirname, '..');
// ARTICLE_COMPACT_EXT_DIR：載入工作區外的 extension 副本（baseline 對照用，不碰產品檔）
const EXT_DIR = process.env.ARTICLE_COMPACT_EXT_DIR ? path.resolve(process.env.ARTICLE_COMPACT_EXT_DIR) : path.join(ROOT, 'extension');
// DSH_BOOK_NOTICE_ONLY=1：只跑 I 階段（收藏列提示邊界）的定向複測
const NOTICE_ONLY = process.env.DSH_BOOK_NOTICE_ONLY === '1';
const stamp = process.env.ARTICLE_COMPACT_DSH_STAMP
    || new Date(Date.now() + 8 * 3600000).toISOString().replace(/\D/g, '').slice(0, 17);
const OUT = process.env.ARTICLE_COMPACT_DSH_OUTPUT || path.join(ROOT, 'docs/report/assets', stamp + '_article-compact-deepseek');
const CORS = { 'Access-Control-Allow-Origin': '*' };

// 產品文案（預設介面語言 zh-CN）——直接對照使用者看到的字。
const TEXT = {
    extracting: '正在读取网页并提取正文…',
    ready: '提取完成，请检查标题与正文后保存。',
    deferred: '已提取，可先预览；暂时未能检查已保存的文章，保存时会重试。',
    reused: '这篇网页已有文章，已沿用原记录并保留原内容。',
    saved: '已保存到文章详解，同页词书已关联。返回 BDC 同步后可阅读。',
    stopped: '已停止，可重新提取或保存。',
    failed: '操作未完成，已提交的待传项目可在下方重试。',
    cannotReach: '无法连接到同步服务',
    aiTimeout: 'AI 请求超时',
    disconnected: '未登录账户',
    addShort: '加入',
    addedShort: '已加入',
    quickAdd: '新建并加入',
    bookCreated: '已选择《',
    defaultSaved: '已保存默认词书，新网页可直接使用。',
    targetMissing: '目标词书不存在或已删除，请选择其他词书后重新加入。',
    capturePending: '尚未确认收藏结果，已保留在本机待传，请重试。',
    captureSaved: '已加入词书'
};

const PRODUCT_FILES = [
    'extension/workspace-ui.js', 'extension/capture-ui.js', 'extension/inline-panel.js', 'extension/lookup.html',
    'extension/lookup.css', 'extension/page-lookup.js', 'extension/manifest.json',
    'modules/extension-workspace.js', 'modules/sync-cloudflare.js', 'modules/api.js', 'modules/i18n.js',
    'shared/workspace-client.mjs', 'shared/page-protocol.mjs', 'shared/capture-client.mjs',
    'cloudflare-worker/src/worker.js', 'cloudflare-worker/src/captures.js',
    'cloudflare-worker/src/capture-books.js', 'cloudflare-worker/src/page-links.js', 'cloudflare-worker/src/http.js',
    'locales/zh-CN.js', 'locales/zh-HK.js', 'tests/helpers/extension-mv3.cjs'
];

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const checks = [];
const scenarios = [];
function check(name, ok, detail) {
    checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ': ' + JSON.stringify(detail)}`);
}
function productHashes() {
    return Object.fromEntries(PRODUCT_FILES.map((file) => [file, hashFile(path.join(ROOT, file)).slice(0, 16)]));
}
function hashFile(file) {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/* ------------------------------------------------------------------ 故障注入 */
// 只有「帶 sourceUrl 的 GET /vocabulary/books」與 page-link／articles 會被改寫；
// limit > 0 時只讓前 limit 次命中（用來做「預查失敗、保存時才查到既有文章」）。
const fault = { mode: 'none', used: 0, limit: 0 };
function setFault(mode, limit = 0) {
    fault.mode = mode;
    fault.used = 0;
    fault.limit = limit;
}
function consume() {
    if (fault.mode === 'none') return false;
    if (fault.limit > 0) {
        if (fault.used >= fault.limit) return false;
        fault.used += 1;
    }
    return true;
}

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    if (!process.env.ARTICLE_COMPACT_EXT_DIR) execFileSync(process.execPath, ['scripts/package-extension.mjs'], { cwd: ROOT });
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-article-compact-dsh-'));
    const traffic = [];
    const failures = [];
    const pageErrors = [];
    let env;
    let context;
    let popup;
    let articlePage;
    let releaseHold = null;
    let held = false;
    // 書單閘門（I 階段用）：把「不帶 sourceUrl 的 GET /vocabulary/books」按住，
    // 用來重現「storage 快取的舊書單先套用、網路回應還沒回來」的那一瞬間。
    const booksGate = { active: false, hits: 0, waiters: new Set(), urls: [] };
    const releaseBooksGate = () => {
        booksGate.active = false;
        for (const release of booksGate.waiters) release();
        booksGate.waiters.clear();
    };

    try {
        env = await environment();
        const extension = EXT_DIR;
        context = await chromium.launchPersistentContext(profile, {
            channel: 'chromium', headless: true, viewport: { width: 1280, height: 900 },
            args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
        });
        context.on('page', (page) => page.on('pageerror', (error) => pageErrors.push(error.message)));
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

        /* 預查（GET + sourceUrl）與 page-link／articles 的注入點 */
        await context.route('**/vocabulary/books?*', async (route) => {
            const request = route.request();
            let url;
            try { url = new URL(request.url()); } catch (_) { return route.continue(); }
            if (request.method() !== 'GET' || !url.searchParams.has('sourceUrl')) return route.continue();
            if (!consume()) return route.continue();
            if (fault.mode === 'network') return route.abort('failed').catch(() => {});
            if (fault.mode === 'html503') return route.fulfill({ status: 503, contentType: 'text/html', body: '<!doctype html><title>503</title><h1>Service Unavailable</h1>' }).catch(() => {});
            if (fault.mode === 'json500') return route.fulfill({ status: 500, contentType: 'application/json', headers: CORS, body: '{"code":"capture_failed"}' }).catch(() => {});
            if (fault.mode === 'json404') return route.fulfill({ status: 404, contentType: 'application/json', headers: CORS, body: '{"code":"not_found"}' }).catch(() => {});
            if (fault.mode === 'badjson') return route.fulfill({ status: 200, contentType: 'text/html', headers: CORS, body: '<!doctype html><title>cached shell</title>' }).catch(() => {});
            if (fault.mode === 'auth401') return route.fulfill({ status: 401, contentType: 'application/json', body: '{"code":"unauthorized"}' }).catch(() => {});
            if (fault.mode === 'auth401html') return route.fulfill({ status: 401, contentType: 'text/html', body: '<h1>Unauthorized</h1>' }).catch(() => {});
            if (fault.mode === 'forbidden403') return route.fulfill({ status: 403, contentType: 'text/html', body: '<h1>Forbidden</h1>' }).catch(() => {});
            if (fault.mode === 'race') return route.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify({ books: [], defaultBookId: '', pageBookId: '', articleId: 'art_race_probe' }) }).catch(() => {});
            if (fault.mode === 'timeout') { await sleep(11000); return route.abort('timedout').catch(() => {}); }
            if (fault.mode === 'hold') { held = true; await new Promise((resolve) => { releaseHold = resolve; }); return route.abort('failed').catch(() => {}); }
            return route.continue();
        });
        await context.route('**/vocabulary/page-link', (route) => {
            if (fault.mode === 'race') return route.fulfill({ status: 404, contentType: 'application/json', headers: CORS, body: '{"code":"article_not_found"}' }).catch(() => {});
            return route.continue();
        });
        await context.route('**/articles', (route) => {
            if (route.request().method() === 'POST' && fault.mode === 'saveFail') {
                return route.fulfill({ status: 503, contentType: 'application/json', headers: CORS, body: '{"code":"capture_failed"}' }).catch(() => {});
            }
            return route.continue();
        });
        /* 書單閘門（booksGate）：按住的請求由 releaseBooksGate() 放行 */
        await context.route((url) => url.pathname === '/vocabulary/books' && !url.searchParams.has('sourceUrl'), async (route) => {
            if (!booksGate.active) return route.continue().catch(() => {});
            booksGate.hits += 1;
            booksGate.urls.push(new URL(route.request().url()).pathname);
            // 20 秒保險：即使測試中途失敗，被按住的請求也不會永遠掛著
            await new Promise((resolve) => {
                booksGate.waiters.add(resolve);
                setTimeout(resolve, 20000);
            });
            return route.continue().catch(() => {});
        });

        const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
        const base = `chrome-extension://${new URL(worker.url()).host}`;

        /* ------------------------------------------------------------ 面板工具 */
        const popupState = () => popup.evaluate(() => {
            const text = (selector) => (document.querySelector(selector)?.textContent || '').trim();
            const hidden = (selector) => document.querySelector(selector)?.hidden !== false;
            return {
                notice: text('#ext-workspace-notice'), noticeHidden: hidden('#ext-workspace-notice'),
                noticeError: document.querySelector('#ext-workspace-notice')?.classList.contains('ext-notice-error') === true,
                previewHidden: hidden('#ext-article-preview'), title: document.querySelector('#ext-article-title')?.value || '',
                body: document.querySelector('#ext-article-body')?.value || '', bodyDisabled: document.querySelector('#ext-article-body')?.disabled === true,
                extractDisabled: document.querySelector('#ext-article-extract')?.disabled !== false,
                cancelHidden: hidden('#ext-article-cancel'), openHidden: hidden('#ext-article-open'),
                pendingHidden: hidden('#ext-workspace-pending'), pendingText: text('#ext-workspace-pending'),
                captureNotice: text('#ext-capture-notice'), captureSave: text('#ext-capture-save'),
                captureNoticeHidden: hidden('#ext-capture-notice'),
                captureNoticeError: document.querySelector('#ext-capture-notice')?.classList.contains('ext-notice-error') === true,
                capturePendingHidden: hidden('#ext-capture-pending'), capturePendingText: text('#ext-capture-pending'),
                account: text('#ext-account-status'),
                books: Array.from(document.querySelectorAll('#ext-capture-book option')).map((option) => option.value),
                selectedBook: document.querySelector('#ext-capture-book')?.value || ''
            };
        });

        async function reloadPopup({ connected = true } = {}) {
            await popup.reload();
            await popup.waitForFunction(() => !!document.querySelector('#ext-account-status')?.textContent, null, { timeout: 30000 });
            if (!connected) return;
            await popup.waitForFunction(() => /已连接账户/.test(document.querySelector('#ext-account-status')?.textContent || ''), null, { timeout: 30000 });
            await popup.waitForFunction(() => document.querySelector('#ext-workspace-notice')?.hidden !== false
                && document.querySelector('#ext-article-extract')?.disabled === false, null, { timeout: 30000 });
        }
        async function login(token, pattern) {
            await popup.evaluate(() => { const details = document.querySelector('#ext-account-details'); if (details) details.open = true; });
            await popup.locator('#ext-endpoint-input').fill(env.base);
            await popup.locator('#ext-login-mode').selectOption('token');
            await popup.locator('#ext-token-input').fill(token);
            await popup.locator('#ext-connect-btn').click();
            await popup.waitForFunction((regexp) => new RegExp(regexp).test(document.querySelector('#ext-account-status')?.textContent || ''), pattern, { timeout: 30000 });
            await popup.waitForFunction(() => document.querySelector('#ext-article-extract')?.disabled === false, null, { timeout: 30000 });
        }
        async function logout() {
            await popup.evaluate(() => { const details = document.querySelector('#ext-account-details'); if (details) details.open = true; });
            await popup.locator('#ext-logout-btn').click();
            await popup.waitForFunction(() => /未登录账户/.test(document.querySelector('#ext-account-status')?.textContent || ''), null, { timeout: 30000 });
        }
        /** 等這次工作結束（busy 由取消鈕的可見性觀察）。 */
        async function waitIdle() {
            await popup.waitForFunction(() => document.querySelector('#ext-article-cancel')?.hidden === false, null, { timeout: 5000 }).catch(() => {});
            await popup.waitForFunction(() => document.querySelector('#ext-article-cancel')?.hidden === true, null, { timeout: 60000 });
            await sleep(250);
        }
        async function clickExtract() {
            await articlePage.bringToFront();
            const aiBefore = env.state.aiCalls, mark = traffic.length, failMark = failures.length, started = Date.now();
            await popup.locator('#ext-article-extract').click();
            await waitIdle();
            return { elapsed: Date.now() - started, aiCalls: env.state.aiCalls - aiBefore, state: await popupState(),
                requests: traffic.slice(mark), failures: failures.slice(failMark) };
        }
        async function clickSave() {
            const aiBefore = env.state.aiCalls, mark = traffic.length;
            await popup.locator('#ext-article-save').click();
            await waitIdle();
            return { aiCalls: env.state.aiCalls - aiBefore, state: await popupState(), requests: traffic.slice(mark) };
        }
        const aliceArticleCount = () => env.db.prepare("SELECT COUNT(*) AS n FROM articles WHERE owner_user_id='alice'").get().n;
        const bobArticleCount = () => env.db.prepare("SELECT COUNT(*) AS n FROM articles WHERE owner_user_id='bob'").get().n;

        /* ------------------------------------------------------------ 幾何工具 */
        async function openFrame(tag) {
            const page = await context.newPage();
            await page.goto(env.base + '/test-article?case=' + tag);
            const rect = await page.evaluate(() => {
                const node = document.querySelector('#article').firstChild;
                const start = node.textContent.indexOf('plunge');
                const range = document.createRange();
                range.setStart(node, start); range.setEnd(node, start + 6);
                const box = range.getBoundingClientRect();
                return { x: box.x, y: box.y, width: box.width, height: box.height };
            });
            await page.mouse.move(rect.x + 1, rect.y + rect.height / 2);
            await page.mouse.down();
            await page.mouse.move(rect.x + rect.width - 1, rect.y + rect.height / 2, { steps: 8 });
            await page.mouse.up();
            // 選取後浮出的「查詞」按鈕就在選取範圍下方，點它才會開小窗。
            await page.mouse.click(rect.x + 24, rect.y + rect.height + 20);
            let frame;
            for (let i = 0; i < 100 && !frame; i += 1) {
                frame = page.frames().find((candidate) => candidate.url().startsWith(base + '/lookup.html'));
                if (!frame) await page.waitForTimeout(100);
            }
            if (!frame) throw new Error('inline frame did not open');
            await frame.locator('#ext-result-box').waitFor({ state: 'visible', timeout: 20000 });
            return { page, frame };
        }
        const frameMetrics = (frame) => frame.evaluate(() => {
            const box = (selector) => {
                const element = document.querySelector(selector);
                if (!element) return null;
                const rect = element.getBoundingClientRect();
                return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom };
            };
            const text = (selector) => (document.querySelector(selector)?.textContent || '').trim();
            return {
                innerWidth: window.innerWidth, innerHeight: window.innerHeight,
                scrollWidth: document.documentElement.scrollWidth, bodyHeight: document.body.getBoundingClientRect().height,
                compact: document.body.classList.contains('ext-compact'),
                book: box('#ext-capture-book'), add: box('#ext-capture-save'), quick: box('#ext-quick-capture'),
                section: box('#ext-capture-section'), more: box('#ext-book-options > summary'),
                optionsOpen: document.querySelector('#ext-book-options')?.open === true,
                formHidden: document.querySelector('#ext-book-form')?.hidden !== false,
                selectedBook: document.querySelector('#ext-capture-book')?.value || '',
                saveText: text('#ext-capture-save'), notice: text('#ext-capture-notice'),
                confirmHidden: document.querySelector('#ext-inline-confirm')?.hidden !== false,
                keep: box('#ext-inline-keep'), discard: box('#ext-inline-discard'),
                previewHidden: document.querySelector('#ext-article-preview')?.hidden !== false,
                workspaceNotice: text('#ext-workspace-notice'),
                articleSection: box('#ext-page-article-section')
            };
        });
        const frameBox = async (frame) => (await frame.frameElement()).boundingBox();

        /* ================================================================ 前置 */
        popup = await context.newPage();
        await popup.goto(base + '/lookup.html');
        await popup.waitForFunction(() => !!document.querySelector('#ext-account-status').textContent);
        await login(ALICE, '已连接账户');
        check('基線：擴充套件連上測試帳戶（真 Worker＋真 SQLite，AI 為 mock）', true);

        // 「在 BDC 打开」指向本機測試伺服器，避免任何正式站台請求。
        await popup.evaluate((local) => { const input = document.querySelector('#ext-app-url'); input.value = local; input.dispatchEvent(new Event('change')); }, env.base + '/');
        articlePage = await context.newPage();
        await articlePage.goto(env.base + '/test-article?case=base');

        // DSH_UI_ONLY=1 只跑 UI 幾何與 0 詞書階段（開發時縮短迭代，正式驗收請跑全套）
        // DSH_BOOK_NOTICE_ONLY=1 只跑 I 階段（收藏列提示邊界）
        let countBeforeQueue = 0;
        if (!process.env.DSH_UI_ONLY && !NOTICE_ONLY) {
            /* ==================================== A/D/E 主線：提取→保存→沿用→去重 */
            const base0 = await clickExtract();
            scenarios.push({ id: 'A0', title: '對照：預查正常，提取成功', ...base0 });
            check('A0 預查正常時 AI 被呼叫並且有預覽、正文含章節', base0.aiCalls > 0 && !base0.state.previewHidden && base0.state.body.includes('## Outlook'), base0.state);
            check('A0 正常路徑顯示「提取完成」', base0.state.notice === TEXT.ready, { notice: base0.state.notice });
            check('A0 預查請求確實是帶 sourceUrl 的 GET',
                base0.requests.some((entry) => entry.method === 'GET' && entry.path.startsWith('/vocabulary/books?sourceUrl=')), base0.requests);
            await popup.screenshot({ path: path.join(OUT, '01-preview-ready.png') });

            const countBeforeSave = aliceArticleCount();
            const saved = await clickSave();
            const baseArticle = env.db.prepare("SELECT id, body, source_url FROM articles WHERE owner_user_id='alice' AND source_url LIKE '%case=base%'").get();
            scenarios.push({ id: 'A1', title: '保存文章：真回執與雲端落地', aiCalls: saved.aiCalls, state: saved.state, article: baseArticle?.id });
            check('A1 保存後拿到真回執：文章落地、預覽收起、「在 BDC 打开」出現',
                !!baseArticle && saved.state.previewHidden && !saved.state.openHidden && saved.state.notice === TEXT.saved, { article: baseArticle?.id, state: saved.state });
            check('A1 保存不重跑 AI、只新增一篇文章', saved.aiCalls === 0 && aliceArticleCount() === countBeforeSave + 1, { aiCalls: saved.aiCalls, count: aliceArticleCount() });

            const openTabPromise = context.waitForEvent('page');
            await popup.locator('#ext-article-open').click();
            const opened = await openTabPromise;
            await opened.waitForLoadState('domcontentloaded').catch(() => {});
            const openedUrl = opened.url();
            await opened.close();
            check('A1 「在 BDC 打开」帶到既有文章（#a/<articleId>）', openedUrl.includes('#a/' + encodeURIComponent(baseArticle.id)), { openedUrl });

            const reuse = await (async () => { await reloadPopup(); return clickExtract(); })();
            scenarios.push({ id: 'D1', title: '既有雲端文章正常：直接沿用、不呼叫 AI', ...reuse });
            check('D1 既有文章時 AI 0 次、顯示「已有文章，已沿用」、沒有新預覽',
                reuse.aiCalls === 0 && reuse.state.notice === TEXT.reused && reuse.state.previewHidden, reuse.state);
            check('D1 沿用時仍提供「在 BDC 打开」，且文章數不變', !reuse.state.openHidden && aliceArticleCount() === countBeforeSave + 1, { open: reuse.state.openHidden, count: aliceArticleCount() });
            await popup.screenshot({ path: path.join(OUT, '02-reused-open.png') });

            // E1：預查失敗（只失敗一次）→ 先出預覽；保存時才查到既有文章 → 仍去重。
            await reloadPopup();
            setFault('network', 1);
            const deferred = await clickExtract();
            check('A1 非認證預查斷線：仍取得 AI 預覽並提示「保存時會重試」',
                deferred.aiCalls > 0 && !deferred.state.previewHidden && deferred.state.notice === TEXT.deferred, deferred.state);
            const dedupeSave = await clickSave();
            scenarios.push({ id: 'E1', title: '預查失敗→保存時查到既有文章（去重）', aiCalls: dedupeSave.aiCalls, state: dedupeSave.state, requests: dedupeSave.requests });
            check('E1 保存路徑仍去重：沿用既有文章、不新增第二篇、不再呼叫 AI',
                dedupeSave.state.notice === TEXT.reused && aliceArticleCount() === countBeforeSave + 1 && dedupeSave.aiCalls === 0, { state: dedupeSave.state, count: aliceArticleCount() });
            check('E1 保存時的預查確實重跑過（GET + sourceUrl）',
                dedupeSave.requests.some((entry) => entry.method === 'GET' && entry.path.startsWith('/vocabulary/books?sourceUrl=')), dedupeSave.requests);
            setFault('none');

            /* ============================== A 非認證故障矩陣（每一種都不得阻擋 AI） */
            const matrix = [
                ['A-斷線', 'network', 'net::ERR_FAILED（等同截圖的紅色請求）'],
                ['A-503非JSON', 'html503', 'HTTP 503 HTML（邊緣錯誤頁形態，無 CORS）'],
                ['A-500JSON', 'json500', 'HTTP 500 capture_failed（後端／D1 錯誤）'],
                ['A-404', 'json404', 'HTTP 404 not_found（舊版 Worker／路由缺失）'],
                ['A-畸形JSON', 'badjson', 'HTTP 200 但 body 不是 JSON'],
                ['A-競態', 'race', 'GET 說有文章、POST page-link 回 404 article_not_found']
            ];
            for (const [id, mode, title] of matrix) {
                await reloadPopup();
                setFault(mode);
                const run = await clickExtract();
                scenarios.push({ id, title, mode, ...run });
                const networkFailed = run.failures.length > 0;
                check(`${id}（${title}）：AI 仍被呼叫並取得預覽`, run.aiCalls > 0 && !run.state.previewHidden, { aiCalls: run.aiCalls, state: run.state });
                const expectedNotice = mode === 'race' ? TEXT.ready : TEXT.deferred;
                check(`${id}：文案為「${expectedNotice === TEXT.ready ? '提取完成' : '已提取，可先预览'}」而非連線／逾時誤導`,
                    run.state.notice === expectedNotice, { notice: run.state.notice });
                if (mode !== 'network') {
                    check(`${id}：HTTP 有回應（沒有被冒充成 network 失敗）`, !networkFailed, run.failures);
                } else {
                    check(`${id}：確實是連線層失敗（requestfailed 有記錄）`, networkFailed, run.failures);
                }
            }

            // A-逾時：預查自己的 6 秒上限（不是舊的 10 秒）
            await reloadPopup();
            setFault('timeout');
            const timeoutRun = await clickExtract();
            scenarios.push({ id: 'A-逾時', title: '預查 6 秒逾時', ...timeoutRun });
            check('A-逾時：6 秒左右就降級（實測 < 9.5 秒，證明不是舊的 10 秒預設）',
                timeoutRun.elapsed > 5000 && timeoutRun.elapsed < 9500, { elapsedMs: timeoutRun.elapsed });
            check('A-逾時：仍取得 AI 預覽，且不再顯示「AI 请求超时」',
                timeoutRun.aiCalls > 0 && timeoutRun.state.notice === TEXT.deferred && !timeoutRun.state.notice.includes(TEXT.aiTimeout), { state: timeoutRun.state });
            setFault('none');

            /* ================================= B/C 認證阻塞與取消（頁面 C：尚無文章） */
            await articlePage.goto(env.base + '/test-article?case=auth');
            await reloadPopup();

            // C 取消：預查仍在連線時按取消
            setFault('hold');
            held = false;
            await articlePage.bringToFront();
            const aiBeforeCancel = env.state.aiCalls;
            await popup.locator('#ext-article-extract').click();
            for (let i = 0; i < 60 && !held; i += 1) await sleep(100);
            await popup.locator('#ext-article-cancel').click();
            await popup.waitForFunction((stopped) => (document.querySelector('#ext-workspace-notice')?.textContent || '').trim() === stopped, TEXT.stopped, { timeout: 15000 });
            const cancelled = await popupState();
            scenarios.push({ id: 'C1', title: '預查仍在連線時取消', state: cancelled, aiCalls: env.state.aiCalls - aiBeforeCancel });
            check('C1 取消：不啟動 AI、沒有預覽、顯示「已停止」',
                env.state.aiCalls === aiBeforeCancel && cancelled.previewHidden && cancelled.notice === TEXT.stopped, cancelled);
            if (releaseHold) releaseHold();
            releaseHold = null;
            setFault('none');

            // B1 401 JSON（含清舊預覽）
            const preview401 = await clickExtract();
            check('B0 前置：先在頁面 C 取得一份預覽（供 401 清預覽對照）', preview401.aiCalls > 0 && !preview401.state.previewHidden, preview401.state);
            setFault('auth401');
            const aiBefore401 = env.state.aiCalls;
            await articlePage.bringToFront();
            await popup.locator('#ext-article-extract').click();
            await popup.waitForFunction(() => /未登录账户/.test(document.querySelector('#ext-account-status')?.textContent || ''), null, { timeout: 20000 });
            await waitIdle();
            const after401 = await popupState();
            scenarios.push({ id: 'B1', title: '401 JSON unauthorized', state: after401, aiCalls: env.state.aiCalls - aiBefore401 });
            check('B1 401：不啟動 AI、舊預覽被清掉、登出帳戶、提取鈕停用',
                env.state.aiCalls === aiBefore401 && after401.previewHidden && after401.account === TEXT.disconnected && after401.extractDisabled, after401);
            setFault('none');

            // B2 401 非 JSON body：status 必須被保留，不能當成 network / 可忽略錯誤
            await login(ALICE, '已连接账户');
            await reloadPopup();
            const preview401html = await clickExtract();
            check('B2 前置：重新登入後再取得一份預覽', preview401html.aiCalls > 0 && !preview401html.state.previewHidden, preview401html.state);
            setFault('auth401html');
            const aiBefore401html = env.state.aiCalls;
            await articlePage.bringToFront();
            await popup.locator('#ext-article-extract').click();
            await popup.waitForFunction(() => /未登录账户/.test(document.querySelector('#ext-account-status')?.textContent || ''), null, { timeout: 20000 });
            await waitIdle();
            const after401html = await popupState();
            scenarios.push({ id: 'B2', title: '401 非 JSON body（HTML）', state: after401html, aiCalls: env.state.aiCalls - aiBefore401html });
            check('B2 401 但 body 不是 JSON：仍判為認證失敗（不冒充 network、不降級），AI 0 次且清預覽',
                env.state.aiCalls === aiBefore401html && after401html.previewHidden && after401html.account === TEXT.disconnected, after401html);
            setFault('none');

            // B3 403：同樣不得被降級
            await login(ALICE, '已连接账户');
            await reloadPopup();
            const preview403 = await clickExtract();
            check('B3 前置：取得一份預覽後注入 403', preview403.aiCalls > 0 && !preview403.state.previewHidden, preview403.state);
            setFault('forbidden403');
            const aiBefore403 = env.state.aiCalls;
            await articlePage.bringToFront();
            await popup.locator('#ext-article-extract').click();
            await waitIdle();
            const after403 = await popupState();
            scenarios.push({ id: 'B3', title: '403（例如邊緣 WAF 拒絕）', state: after403, aiCalls: env.state.aiCalls - aiBefore403 });
            check('B3 403：不啟動 AI、顯示失敗而非成功',
                env.state.aiCalls === aiBefore403 && after403.notice !== TEXT.ready && after403.notice !== TEXT.deferred, after403);
            await popup.screenshot({ path: path.join(OUT, '03-403-blocked.png') });
            setFault('none');

            // B4 登出：不得再呼叫 AI
            await logout();
            const afterLogout = await popupState();
            scenarios.push({ id: 'B4', title: '登出後', state: afterLogout });
            check('B4 登出後：提取鈕停用（不可再呼叫 AI）且沒有殘留預覽',
                afterLogout.extractDisabled && afterLogout.previewHidden, afterLogout);
            await popup.screenshot({ path: path.join(OUT, '04-logged-out.png') });
            await login(ALICE, '已连接账户');
            await reloadPopup();

            /* ================== E 保存失敗 → 待傳鎖定 → 恢復後重試（頁面 B） */
            await articlePage.goto(env.base + '/test-article?case=queue');
            await reloadPopup();
            const queuePreview = await clickExtract();
            check('E0 前置：頁面 B 取得預覽', queuePreview.aiCalls > 0 && !queuePreview.state.previewHidden, queuePreview.state);
            // 先建立本頁詞書，稍後驗證 page-link 關聯
            await popup.evaluate(() => { document.querySelector('#ext-book-options').open = true; });
            await popup.locator('#ext-book-page').click();
            await popup.waitForFunction(() => (document.querySelector('#ext-capture-book')?.value || '').startsWith('webbook_'), null, { timeout: 30000 });
            const pageBookId = await popup.locator('#ext-capture-book').inputValue();

            countBeforeQueue = aliceArticleCount();
            setFault('saveFail');
            const failedSave = await clickSave();
            scenarios.push({ id: 'E2', title: '保存失敗：入待傳並鎖定', state: failedSave.state, aiCalls: failedSave.aiCalls });
            check('E2 保存失敗：不宣稱成功（沒有已保存文案、沒有「在 BDC 打开」）',
                failedSave.state.openHidden && failedSave.state.notice !== TEXT.saved && failedSave.state.noticeError, failedSave.state);
            check('E2 保存失敗：入待傳、預覽被鎖定、雲端沒有新增文章',
                !failedSave.state.pendingHidden && failedSave.state.bodyDisabled && aliceArticleCount() === countBeforeQueue, { state: failedSave.state, count: aliceArticleCount() });
            check('E2 保存失敗：仍是同一份 AI 結果，不重跑 AI', failedSave.aiCalls === 0, { aiCalls: failedSave.aiCalls });
            await popup.screenshot({ path: path.join(OUT, '05-save-pending-locked.png') });

            setFault('none');
            const aiBeforeRetry = env.state.aiCalls;
            await popup.evaluate(() => { document.querySelector('#ext-workspace-pending').open = true; });
            await popup.locator('#ext-workspace-pending-list li button').first().click();
            await popup.waitForFunction(() => document.querySelector('#ext-article-open')?.hidden === false, null, { timeout: 30000 });
            await sleep(300);
            const retried = await popupState();
            const queueArticle = env.db.prepare("SELECT id, body, source_url FROM articles WHERE owner_user_id='alice' AND source_url LIKE '%case=queue%'").get();
            const pageBook = env.db.prepare("SELECT data_json FROM reading_entities WHERE owner_user_id='alice' AND entity_type='vocabularyBook' AND entity_id=?").get(pageBookId);
            const pageBookData = pageBook ? JSON.parse(pageBook.data_json) : {};
            scenarios.push({ id: 'E3', title: '恢復後重試：真回執＋頁書關聯', state: retried, article: queueArticle?.id, pageBook: pageBookData });
            check('E3 重試成功：真回執（雲端有文章、正文含章節、待傳清空）',
                !!queueArticle && queueArticle.body.includes('## Outlook') && retried.pendingHidden && aliceArticleCount() === countBeforeQueue + 1,
                { article: queueArticle?.id, state: retried, count: aliceArticleCount() });
            check('E3 重試不重跑 AI', env.state.aiCalls === aiBeforeRetry, { aiCalls: env.state.aiCalls - aiBeforeRetry });
            check('E3 重試後仍建立頁書關聯（page-link）', pageBookData.articleId === queueArticle?.id && pageBookData.sourceType === 'article', pageBookData);
        }

        /* ================== I 收藏列提示邊界：captureTargetMissing 只清它自己 */
        // 修正點（extension/capture-ui.js）：restoreChoice() 成功選中有效詞書時只清 captureTargetMissing；
        // change handler 選中有效詞書後同樣只清這一則。下面四種情境都在真 MV3＋真 Worker／SQLite 上量。
        const NOTICE_PAGE = env.base + '/test-article?case=notice';
        const pageBookRow = () => env.db.prepare("SELECT entity_id, data_json, deleted_at FROM reading_entities "
            + "WHERE owner_user_id='alice' AND entity_type='vocabularyBook' AND data_json LIKE '%case=notice%'").get();
        const captureEntryCount = () => env.db.prepare("SELECT COUNT(*) AS n FROM reading_entities "
            + "WHERE owner_user_id='alice' AND entity_type='vocabularyEntry'").get().n;
        const choiceStore = () => popup.evaluate(async () => {
            const all = await chrome.storage.local.get(null);
            return Object.fromEntries(Object.entries(all).filter(([key]) => key.startsWith('bdc_capture_book_v1:')));
        });
        const openOptions = async () => popup.evaluate(() => { document.querySelector('#ext-book-options').open = true; });

        async function runNoticePhase() {
            await articlePage.goto(NOTICE_PAGE);
            await reloadPopup();
            const setup = await clickExtract();
            scenarios.push({ id: 'I0', title: '提示邊界前置：取得預覽、書單已快取', state: setup.state, aiCalls: setup.aiCalls });
            check('I0 前置：頁面 D 取得預覽，收藏列沒有任何殘留提示（乾淨起點）',
                setup.aiCalls > 0 && !setup.state.previewHidden && setup.state.captureNotice === '' && setup.state.captureNoticeHidden, setup.state);

            /* ---- I1：建立本頁詞書。storage 快取書單還沒有這本新書，網路回應才有。 ---- */
            // 先確定初始書單已落地（select 有選項），再開閘門，避免按住啟動時的前置請求。
            await popup.waitForFunction(() => document.querySelectorAll('#ext-capture-book option').length > 1, null, { timeout: 30000 });
            booksGate.active = true;
            booksGate.hits = 0;
            booksGate.urls = [];
            await openOptions();
            await popup.locator('#ext-book-page').click();
            await popup.waitForFunction((text) => document.querySelector('#ext-capture-notice')?.hidden === false
                && (document.querySelector('#ext-capture-notice')?.textContent || '').trim() === text, TEXT.targetMissing, { timeout: 30000 });
            const duringHold = await popupState();
            const createdBook = pageBookRow();
            await popup.screenshot({ path: path.join(OUT, '13-page-book-transient-zh-CN.png') });
            scenarios.push({ id: 'I1-during', title: '建頁書途中：舊快取書單先套用（網路未回）', state: duringHold,
                book: createdBook?.entity_id, gateHits: booksGate.hits, gateUrls: booksGate.urls.slice() });
            check('I1 建頁書途中確實重現舊行為：書單仍是舊快取（不含新書），暫時提示「目标词书不存在…」',
                !!createdBook && duringHold.captureNotice === TEXT.targetMissing && duringHold.captureNoticeError
                && !duringHold.books.includes(createdBook.entity_id) && duringHold.selectedBook !== createdBook.entity_id,
                { state: duringHold, book: createdBook?.entity_id, gateHits: booksGate.hits });

            releaseBooksGate();
            // 網路回應補上新書後：選取成功、舊提示必須消失（修正前會殘留紅字）
            await popup.waitForFunction(() => document.querySelector('#ext-capture-notice')?.hidden !== false, null, { timeout: 30000 }).catch(() => {});
            await popup.waitForFunction((id) => (document.querySelector('#ext-capture-book')?.value || '') === id, createdBook.entity_id, { timeout: 30000 }).catch(() => {});
            await sleep(300);
            const afterNetwork = await popupState();
            scenarios.push({ id: 'I1', title: '建頁書：網路回應含新書後成功選中', state: afterNetwork, book: createdBook?.entity_id });
            check('I1 網路回應補上新書後：成功選中且 targetMissing 已清除（不再殘留紅字）',
                afterNetwork.selectedBook === createdBook.entity_id && afterNetwork.captureNotice === ''
                && afterNetwork.captureNoticeHidden, afterNetwork);
            check('I1 建頁書本身成功（工作區提示「已选择《…》」、雲端詞書帶本頁來源）',
                afterNetwork.notice.startsWith(TEXT.bookCreated) && !!createdBook && String(createdBook.data_json).includes('case=notice'),
                { notice: afterNetwork.notice, book: createdBook });
            await popup.screenshot({ path: path.join(OUT, '14-page-book-selected-no-notice-zh-CN.png') });

            /* ---- I2：目標詞書真的不存在（雲端刪除後重拉書單）→ 仍必須提示 ---- */
            env.db.prepare("UPDATE reading_entities SET deleted_at=? WHERE owner_user_id='alice' AND entity_type='vocabularyBook' AND entity_id=?")
                .run(new Date().toISOString(), createdBook.entity_id);
            await openOptions();
            await popup.locator('#ext-capture-refresh').click();
            await popup.waitForFunction((text) => (document.querySelector('#ext-capture-notice')?.textContent || '').trim() === text, TEXT.targetMissing, { timeout: 30000 });
            await sleep(400);
            const realMissing = await popupState();
            scenarios.push({ id: 'I2', title: '詞書在雲端被刪除（soft delete）後重拉書單', state: realMissing, deleted: createdBook.entity_id });
            check('I2 目標詞書真的不存在時仍然提示 targetMissing（修正沒有把真錯誤一起吞掉）',
                realMissing.captureNotice === TEXT.targetMissing && realMissing.captureNoticeError
                && !realMissing.books.includes(createdBook.entity_id) && realMissing.selectedBook === '', realMissing);
            await popup.screenshot({ path: path.join(OUT, '15-target-missing-real-zh-CN.png') });

            /* ---- I3：手動選中另一本有效詞書 → 只清 targetMissing ---- */
            await popup.locator('#ext-capture-book').selectOption('book');
            await sleep(400);
            const manual = await popupState();
            const choices = await choiceStore();
            scenarios.push({ id: 'I3', title: '手動改選其他有效詞書', state: manual, choices });
            check('I3 手動選中另一本有效詞書後：舊 targetMissing 被清掉、選取生效',
                manual.captureNotice === '' && manual.captureNoticeHidden && manual.selectedBook === 'book', manual);
            check('I3 選取寫回本機詞書選擇（真 chrome.storage），不再指向已刪除的書',
                Object.values(choices).includes('book') && !Object.values(choices).includes(createdBook.entity_id), choices);

            /* ---- I4：與書單無關的待傳／錯誤提示不得被無差別清空 ---- */
            // popup 的「加入」需要一份單詞結果（displayed），先在手動查詞區查一次。
            const entriesBefore = captureEntryCount();
            await popup.locator('#ext-word-input').fill('plunge');
            await popup.locator('#ext-sentence-input').fill('Major tech stocks plunge as investors worry.');
            await popup.locator('#ext-context-input').fill('Major tech stocks plunge as investors worry. Markets remain volatile.');
            await popup.locator('#ext-lookup-btn').click();
            await popup.locator('#ext-capture-book').selectOption('book');
            await popup.waitForFunction(() => document.querySelector('#ext-capture-save')?.disabled === false, null, { timeout: 30000 });
            env.state.failCaptures = true;
            await popup.locator('#ext-capture-save').click();
            await popup.waitForFunction((text) => (document.querySelector('#ext-capture-notice')?.textContent || '').trim() === text, TEXT.capturePending, { timeout: 30000 });
            env.state.failCaptures = false;
            await sleep(400);
            const queued = await popupState();
            scenarios.push({ id: 'I4a', title: '收藏失敗：留下待傳提示與待傳項目', state: queued });
            check('I4 收藏真的失敗時留下待傳提示（不是靜靜清空、也不是假成功）',
                queued.captureNotice === TEXT.capturePending && queued.captureNoticeError && !queued.capturePendingHidden, queued);

            await popup.locator('#ext-capture-book').selectOption('book-2');
            await sleep(400);
            const queuedAfterSelect = await popupState();
            scenarios.push({ id: 'I4b', title: '有待傳提示時手動改選有效詞書', state: queuedAfterSelect });
            check('I4 手動改選有效詞書後，待傳提示仍保留（change handler 只清 targetMissing）',
                queuedAfterSelect.captureNotice === TEXT.capturePending && queuedAfterSelect.captureNoticeError
                && !queuedAfterSelect.capturePendingHidden, queuedAfterSelect);

            /* ---- I4c：純書單刷新（文章保存成功 → workspace applyReceipt → captureUI.refreshBooks()），
                   不是「按更新」那種會主動清提示的路徑。待傳提示必須活下來。 ---- */
            const refreshMark = traffic.length;
            const articlesBefore = aliceArticleCount();
            const articleSave = await clickSave();
            for (let i = 0; i < 60 && !traffic.slice(refreshMark).some((entry) => entry.method === 'GET' && entry.path === '/vocabulary/books'); i += 1) await sleep(100);
            await sleep(400);
            const refreshRequests = traffic.slice(refreshMark);
            const queuedAfterRefresh = await popupState();
            scenarios.push({ id: 'I4c', title: '純書單刷新（文章保存觸發 refreshBooks）', state: queuedAfterRefresh,
                requests: refreshRequests, aiCalls: articleSave.aiCalls });
            check('I4 書單刷新（選取仍有效）後，待傳提示仍保留（只有 targetMissing 會被清）',
                queuedAfterRefresh.captureNotice === TEXT.capturePending && queuedAfterRefresh.captureNoticeError
                && !queuedAfterRefresh.capturePendingHidden && queuedAfterRefresh.selectedBook === 'book-2', queuedAfterRefresh);
            check('I4 這次刷新確實重拉書單，且文章保存本身成功（真 Worker／真 SQLite）',
                refreshRequests.some((entry) => entry.method === 'GET' && entry.path === '/vocabulary/books')
                && articleSave.state.notice === TEXT.saved && aliceArticleCount() === articlesBefore + 1,
                { requests: refreshRequests, notice: articleSave.state.notice, articles: aliceArticleCount() - articlesBefore });

            /* ---- I4d（觀察，不設通過門檻）：有待傳提示時建立詞書，
                   量「快取 pass 這一刻」舊提示會不會被暫時的 targetMissing 取代、以及最終是否還在 ---- */
            await openOptions();
            // 不勾「連結本頁」可避免讀取作用中分頁，建立流程與作用中分頁無關
            await popup.evaluate(() => {
                const link = document.querySelector('#ext-book-link-page');
                link.checked = false; link.dispatchEvent(new Event('input', { bubbles: true }));
            });
            booksGate.active = true;
            booksGate.hits = 0;
            await popup.locator('#ext-book-new').click();
            await popup.waitForFunction(() => document.querySelector('#ext-book-form')?.hidden === false, null, { timeout: 5000 });
            await popup.locator('#ext-book-name').fill('提示观察');
            await popup.locator('#ext-book-submit').click();
            for (let i = 0; i < 120 && booksGate.hits === 0; i += 1) await sleep(50);
            await sleep(200);
            const duringCreate = await popupState();
            releaseBooksGate();
            await popup.waitForFunction(() => /已选择《提示观察》/.test(document.querySelector('#ext-workspace-notice')?.textContent || ''), null, { timeout: 30000 }).catch(() => {});
            await sleep(400);
            const afterCreate = await popupState();
            scenarios.push({ id: 'I4-觀察', title: '有待傳提示時建立詞書（快取 pass 與網路回應後的收藏列提示）',
                duringCachePass: duringCreate, afterNetwork: afterCreate, gateHits: booksGate.hits });

            /* ---- I5：待傳在服務恢復後可重試成功（真收據），並把狀態清乾淨 ---- */
            const captureMark = env.state.captureCalls.length;
            await popup.evaluate(() => { document.querySelector('#ext-capture-pending').open = true; });
            await popup.locator('#ext-capture-pending-list li button').first().click();
            await popup.waitForFunction(() => document.querySelector('#ext-capture-pending')?.hidden !== false, null, { timeout: 30000 });
            await sleep(400);
            const recovered = await popupState();
            const lastCapture = env.state.captureCalls[env.state.captureCalls.length - 1] || {};
            scenarios.push({ id: 'I5', title: '服務恢復後重試待傳', state: recovered, capture: lastCapture });
            check('I5 待傳在服務恢復後重試成功（真收據、待傳清空、詞條落地）',
                env.state.captureCalls.length === captureMark + 1 && recovered.capturePendingHidden
                && recovered.captureNotice === TEXT.captureSaved && captureEntryCount() === entriesBefore + 1,
                { state: recovered, captures: env.state.captureCalls.length - captureMark, entries: captureEntryCount() - entriesBefore });

            // 清場：提示與待傳都回到乾淨狀態，避免影響後續幾何量測
            await openOptions();
            await popup.locator('#ext-capture-refresh').click();
            await popup.waitForFunction(() => document.querySelector('#ext-capture-notice')?.hidden !== false, null, { timeout: 30000 }).catch(() => {});
            await popup.locator('#ext-capture-book').selectOption('book');
            await popup.evaluate(() => { document.querySelector('#ext-book-options').open = false; });
            await sleep(400);
        }

        if (!process.env.DSH_UI_ONLY) await runNoticePhase();

        /* ============================ F/H 收藏列精簡與幾何（真 MV3 浮窗 iframe） */
        for (const locale of (NOTICE_ONLY ? [] : ['zh-CN', 'zh-HK'])) {
            await popup.locator('#ext-locale-select').selectOption(locale);
            await popup.waitForTimeout(150);
            const { page, frame } = await openFrame('geom-' + locale);
            await frame.locator('#ext-capture-book').selectOption('book');
            await page.waitForTimeout(150);
            const closed = await frameMetrics(frame);
            for (const width of [320, 340, 420]) {
                await page.setViewportSize({ width, height: 700 });
                await page.waitForTimeout(200);
                const metrics = await frameMetrics(frame);
                check(`${locale} ${width}px：select 與加入同一行、收藏列 ≤ 50px`,
                    Math.abs(metrics.book.y - metrics.add.y) <= 2 && metrics.section.height <= 50, metrics);
                check(`${locale} ${width}px：無橫向溢出、⋯ 不與按鈕重疊`,
                    metrics.scrollWidth <= metrics.innerWidth && metrics.add.right <= metrics.more.x + 0.5, metrics);
                if (width === 320) await page.screenshot({ path: path.join(OUT, `06-compact-320-${locale}.png`) });
            }
            await page.setViewportSize({ width: 340, height: 700 });
            await page.waitForTimeout(200);
            check(`${locale}：省略選單預設關閉，關閉時收藏列不佔高（來源／提示不露在行外）`,
                closed.optionsOpen === false && closed.section.height <= 50, closed);

            // ⋯ 內：更新／新建／設預設
            await frame.locator('#ext-book-options > summary').click();
            await page.waitForTimeout(200);
            const opened = await frameMetrics(frame);
            check(`${locale}：開啟省略選單後才佔用高度，且更新／新建／設預設都在裡面`,
                opened.optionsOpen === true && opened.section.height > closed.section.height + 20, opened);
            if (locale === 'zh-CN') {
                await frame.locator('#ext-book-new').click();
                await frame.waitForFunction(() => document.querySelector('#ext-book-form')?.hidden === false, null, { timeout: 5000 });
                check('zh-CN ⋯：按「新建词书」直接展開表單（不需再開一次選單）', (await frameMetrics(frame)).optionsOpen === true);
                await frame.locator('#ext-book-name').fill('考題整理');
                await frame.locator('#ext-book-submit').click();
                // bookCreated／bookDefaultSaved 是工作區提示（文章區塊旁的狀態列），不是收藏列提示。
                await frame.waitForFunction(() => /已选择《考題整理》/.test(document.querySelector('#ext-workspace-notice')?.textContent || ''), null, { timeout: 30000 });
                const created = await frameMetrics(frame);
                check('zh-CN ⋯：建立詞書後自動選取（不需離開面板）', created.selectedBook.startsWith('webbook_'), created);
                await frame.locator('#ext-book-set-default').click();
                await frame.waitForFunction((text) => (document.querySelector('#ext-workspace-notice')?.textContent || '').trim() === text, TEXT.defaultSaved, { timeout: 30000 });
                check('zh-CN ⋯：設為預設詞書成功', true);
                await page.screenshot({ path: path.join(OUT, '07-more-menu-zh-CN.png') });
                await frame.locator('#ext-capture-book').selectOption('book');
                const refreshMark = traffic.length;
                await frame.locator('#ext-capture-refresh').click();
                await frame.waitForTimeout(600);
                check('zh-CN ⋯：更新詞書會重新向同步服務拉清單',
                    traffic.slice(refreshMark).some((entry) => entry.method === 'GET' && entry.path === '/vocabulary/books'), traffic.slice(refreshMark));
                await frame.locator('#ext-book-options > summary').click();
                await page.waitForTimeout(200);
                const reclosed = await frameMetrics(frame);
                check('zh-CN ⋯：再次收起後收藏列回到一行（≤ 50px）', reclosed.optionsOpen === false && reclosed.section.height <= 50, reclosed);
            } else {
                await page.screenshot({ path: path.join(OUT, '08-more-menu-zh-HK.png') });
                await frame.locator('#ext-book-options > summary').click();
                await page.waitForTimeout(200);
            }

            // 完整面板：自然高度、固定右上、不佔滿
            await page.setViewportSize({ width: 1280, height: 1000 });
            await page.waitForTimeout(200);
            await frame.locator('#ext-inline-more').click();
            await page.waitForTimeout(400);
            const expandedFrame = await frameBox(frame);
            const expandedMetrics = await frameMetrics(frame);
            const expectedHeight = Math.min(Math.max(160, expandedMetrics.bodyHeight + 2), 1000 - 24);
            check(`${locale}：完整面板按內容自然高度（不是固定全高）`,
                Math.abs(expandedFrame.height - expectedHeight) <= 3 && expandedFrame.height <= 1000 - 24 - 40,
                { frame: expandedFrame, bodyHeight: expandedMetrics.bodyHeight, expectedHeight });
            check(`${locale}：完整面板仍固定在右上`,
                Math.abs(expandedFrame.y - 12) <= 2 && Math.abs(expandedFrame.x + expandedFrame.width - (1280 - 12)) <= 2, expandedFrame);
            check(`${locale}：完整面板沒有多餘空白（內容不被裁切）`,
                expandedMetrics.scrollWidth <= expandedMetrics.innerWidth && expandedMetrics.bodyHeight <= expandedFrame.height,
                { frame: expandedFrame, metrics: expandedMetrics });
            // 文章按鈕在小標題列，且不再有長駐說明（兩語都檢查）
            const head = await frame.evaluate(() => {
                const section = document.querySelector('#ext-page-article-section');
                const title = document.querySelector('#ext-page-article-heading')?.getBoundingClientRect();
                const button = document.querySelector('#ext-article-extract');
                const rect = button?.getBoundingClientRect();
                const hint = document.querySelector('#ext-page-article-hint');
                return { title: title && { y: title.y, x: title.x }, button: rect && { y: rect.y, x: rect.x },
                    buttonText: (button?.textContent || '').trim(),
                    hintVisible: hint ? hint.getBoundingClientRect().height > 2 : false,
                    sectionText: (section?.textContent || '').trim().slice(0, 200) };
            });
            check(`${locale}：文章標題與提取按鈕在同一小標題列、長駐說明已移除、按鈕文字合語系`,
                Math.abs(head.title.y - head.button.y) < 24 && head.button.x > head.title.x && head.hintVisible === false
                && head.buttonText === (locale === 'zh-CN' ? '提取文章' : '擷取文章'), head);
            if (locale === 'zh-CN') {
                // 完整面板內擷取 → 草稿 → 點面板外 → 仍保留並要求確認
                const aiBeforeDraft = env.state.aiCalls;
                await frame.locator('#ext-article-extract').click();
                await frame.locator('#ext-article-preview').waitFor({ state: 'visible', timeout: 30000 });
                await page.waitForTimeout(300);
                check('zh-CN：完整面板內擷取成功並出現預覽', env.state.aiCalls === aiBeforeDraft + 1, { aiBeforeDraft, after: env.state.aiCalls });
                await page.screenshot({ path: path.join(OUT, '09-expanded-preview.png') });
                await page.mouse.click(10, 300);
                await page.waitForTimeout(400);
                const afterOutside = await frameMetrics(frame);
                check('zh-CN：完整面板有草稿時，點面板外不會關閉也不會遺失草稿',
                    afterOutside.confirmHidden === true && afterOutside.previewHidden === false && !!(await frameBox(frame)), afterOutside);
                await frame.locator('#ext-inline-close').click();
                await frame.locator('#ext-inline-confirm').waitFor({ state: 'visible', timeout: 5000 });
                check('zh-CN：有草稿時按關閉會要求確認（不直接關閉）', true);
                await frame.locator('#ext-inline-keep').click();
                await page.waitForTimeout(300);
                const stillOpen = await frameBox(frame);
                const keptMetrics = await frameMetrics(frame);
                check('zh-CN：按「继续编辑」後面板仍在右上、草稿仍在',
                    !!stillOpen && Math.abs(stillOpen.y - 12) <= 2 && keptMetrics.previewHidden === false, { stillOpen, keptMetrics });
                await frame.locator('#ext-inline-back').click();
                await frame.locator('#ext-inline-confirm').waitFor({ state: 'visible', timeout: 5000 });
                check('zh-CN：返回小窗遇到草稿也要求確認', true);
                await frame.locator('#ext-inline-discard').click();
                await page.waitForTimeout(500);
                check('zh-CN：放棄編輯後回到精簡模式', (await frameMetrics(frame)).compact === true);
            } else {
                // zh-HK 沒有草稿，直接退回精簡模式（不需要確認）
                await frame.locator('#ext-inline-back').click();
                await page.waitForTimeout(400);
            }

            // 窄窗草稿確認：可點、不被 adaptive height 剪裁
            await page.waitForTimeout(300);
            await page.setViewportSize({ width: 320, height: 480 });
            await page.waitForTimeout(250);
            // 窄窗下的草稿：⋯ → 新建詞書 → 輸入名稱（不送出），這是精簡模式的真實草稿路徑
            await frame.locator('#ext-book-options > summary').click();
            await frame.locator('#ext-book-new').click();
            await frame.waitForFunction(() => document.querySelector('#ext-book-form')?.hidden === false, null, { timeout: 5000 });
            await frame.locator('#ext-book-name').fill('窄窗草稿');
            await page.waitForTimeout(300);
            await frame.locator('#ext-inline-close').click();
            await frame.locator('#ext-inline-confirm').waitFor({ state: 'visible', timeout: 5000 });
            const narrow = await frameMetrics(frame);
            const narrowFrame = await frameBox(frame);
            const inside = (box) => box && box.y >= 0 && box.bottom <= narrowFrame.height - 1 && box.x >= 0 && box.right <= narrowFrame.width - 1;
            check(`${locale} 320x480：草稿確認出現且完整顯示在 adaptive height 內（未被剪裁）`,
                narrow.confirmHidden === false && inside(narrow.keep) && inside(narrow.discard),
                { frame: narrowFrame, keep: narrow.keep, discard: narrow.discard });
            if (narrow.confirmHidden === false) {
                await page.screenshot({ path: path.join(OUT, `10-narrow-draft-confirm-${locale}.png`) });
                await frame.locator('#ext-inline-keep').click();
                await page.waitForTimeout(300);
                check(`${locale} 320x480：草稿確認按鈕可點（继续编辑生效、面板仍在）`,
                    (await frameMetrics(frame)).confirmHidden === true, await frameBox(frame));
                await page.screenshot({ path: path.join(OUT, `10b-narrow-kept-${locale}.png`) });
            }
            await page.close();
        }
        await popup.locator('#ext-locale-select').selectOption('zh-CN');

        /* ======================= G 切帳戶 + 0 詞書 quickcreate（同一個擴充套件 profile） */
        if (!NOTICE_ONLY) {
            env.db.prepare("DELETE FROM reading_entities WHERE owner_user_id='bob'").run();
            env.db.prepare("DELETE FROM reading_changes WHERE owner_user_id='bob'").run();
            env.db.prepare("DELETE FROM vocabulary_capture_settings WHERE owner_user_id='bob'").run();

            await popup.evaluate(() => { const details = document.querySelector('#ext-account-details'); if (details) details.open = true; });
            await logout();
            await login(BOB, '已连接账户');
            if (!process.env.DSH_UI_ONLY) {
                await articlePage.goto(env.base + '/test-article?case=base');
                await reloadPopup();
                const bobExtract = await clickExtract();
                scenarios.push({ id: 'B5', title: '切換帳戶後不得沿用別人的文章', aiCalls: bobExtract.aiCalls, state: bobExtract.state });
                check('B5 切到 BOB 後同一頁仍會呼叫 AI（不沿用 ALICE 的文章）', bobExtract.aiCalls > 0 && !bobExtract.state.previewHidden, bobExtract.state);
                const aliceBeforeBob = aliceArticleCount();
                const bobSave = await clickSave();
                check('B5 BOB 保存後只新增 BOB 自己的文章，ALICE 不受影響',
                    bobSave.aiCalls === 0 && bobArticleCount() === 1 && aliceArticleCount() === aliceBeforeBob,
                    { bob: bobArticleCount(), alice: aliceArticleCount(), aliceBeforeBob });
            }

            // G：0 詞書 → quickcreate（新建並加入）
            const quick = await openFrame('quick-' + 'bob');
            const quickBefore = await frameMetrics(quick.frame);
            check('G0 前置：BOB 沒有任何詞書（選單只有提示、quickcreate 出現）',
                quickBefore.quick && quickBefore.quick.height > 0 && quickBefore.selectedBook === '' && quickBefore.quick.width > 0,
                { quick: quickBefore.quick, selected: quickBefore.selectedBook });
            check('G0 0 詞書時 select 與「新建并加入」仍在同一行、收藏列 ≤ 50px',
                Math.abs(quickBefore.book.y - quickBefore.quick.y) <= 2 && quickBefore.section.height <= 50, quickBefore);
            await quick.page.screenshot({ path: path.join(OUT, '11-zero-books-quick-zh-CN.png') });
            const capturesBefore = env.state.captureCalls.length;
            await quick.frame.locator('#ext-quick-capture').click();
            await quick.frame.waitForFunction(() => document.querySelector('#ext-capture-save')?.textContent === '已加入', null, { timeout: 30000 });
            const quickAfter = await frameMetrics(quick.frame);
            const bobBook = env.db.prepare("SELECT entity_id, data_json FROM reading_entities WHERE owner_user_id='bob' AND entity_type='vocabularyBook'").get();
            const bobBookData = bobBook ? JSON.parse(bobBook.data_json) : {};
            const lastCapture = env.state.captureCalls[env.state.captureCalls.length - 1] || {};
            scenarios.push({ id: 'G1', title: '0 詞書 quickcreate', state: quickAfter, book: bobBookData, capture: lastCapture });
            check('G1 quickcreate：建立本頁詞書並自動選取', quickAfter.selectedBook.startsWith('webbook_') && !!bobBook, { selected: quickAfter.selectedBook, book: bobBookData });
            check('G1 quickcreate：真的收藏成功（按鈕變「已加入」、/captures 收到該詞）',
                quickAfter.saveText === TEXT.addedShort && env.state.captureCalls.length === capturesBefore + 1
                && lastCapture.word === 'plunge' && lastCapture.bookId === quickAfter.selectedBook, { state: quickAfter, capture: lastCapture });
            check('G1 quickcreate：詞書帶本頁來源（可關聯原文）', bobBookData.sourceUrl && bobBookData.sourceUrl.includes('/test-article'), bobBookData);
            await quick.page.screenshot({ path: path.join(OUT, '12-zero-books-added-zh-CN.png') });
            await quick.page.close();
        }

        check('全程沒有未捕捉的 JS 例外', pageErrors.length === 0, pageErrors.slice(0, 5));
    } catch (error) {
        pageErrors.push(String((error && error.stack) || error));
        check('測試流程未拋出例外', false, String((error && error.message) || error));
    } finally {
        try {
            const result = {
                stamp, generatedAt: new Date().toISOString(), baselineCommit: '5b20535', productVersion: '0.5.1',
                mode: { noticeOnly: NOTICE_ONLY, uiOnly: !!process.env.DSH_UI_ONLY, extensionDir: EXT_DIR },
                loadedCaptureUi: hashFile(path.join(EXT_DIR, 'capture-ui.js')),
                testedFiles: productHashes(), checks, scenarios,
                requestFailures: failures, pageErrors,
                summary: { pass: checks.filter((entry) => entry.ok).length, fail: checks.filter((entry) => !entry.ok).length }
            };
            fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(result, null, 2));
            fs.writeFileSync(path.join(OUT, 'traffic.log'), JSON.stringify({ failures, pageErrors }, null, 2));
            console.log('[acceptance] artifact: ' + path.join(OUT, 'results.json'));
        } catch (writeError) { console.error('artifact 寫入失敗：' + writeError.message); }
        if (releaseHold) releaseHold();
        releaseBooksGate();
        if (context) await context.close().catch(() => {});
        if (env) await env.close().catch(() => {});
        fs.rmSync(profile, { recursive: true, force: true });
        console.log(`[acceptance] ${checks.filter((entry) => entry.ok).length}/${checks.length} checks passed`);
        if (checks.some((entry) => !entry.ok)) process.exitCode = 1;
    }
})();
