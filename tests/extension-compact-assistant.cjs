// 擴充 0.6.0「精簡首頁 + 文章 AI 助手 + 文章獨立視窗」獨立整合驗收。
//
// 真 MV3：真 Chromium 載入 extension/、真 Worker 路由＋SQLite（tests/helpers/extension-mv3.cjs），
// 只有 AI transport 是 mock（assistant 走真正的 SSE，stream:true）。
//
// 覆蓋：
//   1. 首頁無常駐單詞／原句表單與 AI 摘要；設定圖示具無障礙名稱；dialog 顯示與即時儲存；zh-CN／zh-HK。
//   2. 懸浮球預設顯示；#ext-assistant-enabled 可關閉／重開，已開啟的網頁即時反映。
//   3. 無選字點球 → iframe view=assistant、開啟時不呼叫 AI；文章原文／URL 上下文、連續提問、
//      停止／失敗重試、草稿重開、收放同 frame、帳戶切換不混結果。
//   4. 詞卡 #ext-inline-ai 帶上詞與原句，返回後原收藏狀態不遺失。
//   5. 背景 contextMenu 有 bdc-import-article；以可信 lookup frame 的等價入口觸發
//      BDC_OPEN_WINDOW {view:'article',autoImport:true}，驗證獨立 popup、ticket 綁定來源。
//      0.6.2 起 autoImport 只做 extract：先停在可編輯正文預覽；確認前 DB 無新文章、
//      沒有逐段翻譯請求（只允許正文清洗）；使用者按確認才分析並保存編輯後正文，
//      再按「在 BDC 打開」於同一個 popup 導航 #a/<id>。
//      （headless 無法點擊瀏覽器原生右鍵選單；以「選單 id 存在 + 同一個 openWorkspace 入口」驗證，
//        邊界見報告。）
//   6. 收藏列只留 #ext-capture-save 與 #ext-book-settings；詞書選擇在 dialog 內；
//      #ext-open-book → BDC #v/<id>；原文連結可開啟原網頁。
//   7. 320px／桌面無橫向溢出，兩語核心 UI 截圖。
//
// 用法：
//   PLAYWRIGHT_MODULE=<playwright> node tests/extension-compact-assistant.cjs
//
// 所有帳號與資料由測試自建；不連正式 Worker／AI／D1，不讀私有 ai-config.js。
// 輸出寫到 docs/report/assets/<時間戳>_extension-compact-assistant/。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { environment, ALICE, BOB } = require('./helpers/extension-mv3.cjs');

const ROOT = path.resolve(__dirname, '..');
const stamp = process.env.EXT_COMPACT_STAMP || new Date(Date.now() + 8 * 3600000).toISOString().replace(/\D/g, '').slice(0, 17);
const OUT = process.env.EXT_COMPACT_OUTPUT || path.join(ROOT, 'docs/report/assets', stamp + '_extension-compact-assistant');
const checks = [];
const shots = [];
const consoleErrors = [];
const pageErrors = [];
const debug = { assistant: {}, article: {}, wordCard: {} };
// 0.6.2 confirm gate：直接監聽真正送往 mock AI 的請求內容，區分正文清洗
// （articleCleanup，允許）與逐段翻譯（articleParagraphTranslation，確認後才允許）。
const aiPromptRequests = [];
const promptCount = (needle) => aiPromptRequests.filter((item) => item.postData.includes(needle)).length;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function check(name, condition, detail) {
    checks.push({ name, ok: !!condition, ...(detail === undefined ? {} : { detail }) });
    console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${condition || detail === undefined ? '' : ': ' + JSON.stringify(detail)}`);
    return !!condition;
}
async function waitFor(run, { timeout = 15000, interval = 100 } = {}) {
    const started = Date.now();
    let last;
    while (Date.now() - started < timeout) {
        try { last = await run(); if (last) return last; } catch (_) { /* keep polling */ }
        await sleep(interval);
    }
    return last;
}
async function shot(target, name, fullPage = false) {
    try {
        if (typeof target.screenshot === 'function') {
            await target.screenshot({ path: path.join(OUT, name + '.png'), fullPage });
        } else {
            const element = await target.frameElement();
            if (!element) throw new Error('frame has no frameElement');
            await element.screenshot({ path: path.join(OUT, name + '.png') });
        }
        shots.push(name + '.png');
    } catch (error) { debug.shots = [...(debug.shots || []), { name, error: error.message }]; }
}

/* ---------- closed shadow root 內的真按鈕：CDP pierce + 真滑鼠 ---------- */
function attributesOf(node) {
    const attributes = {};
    const raw = node.attributes || [];
    for (let index = 0; index + 1 < raw.length; index += 2) attributes[raw[index]] = raw[index + 1];
    return attributes;
}
async function shellButtons(cdp) {
    let root;
    try { ({ root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true })); } catch (_) { return []; }
    const nodes = [];
    const walk = (node) => {
        if (node.nodeName === 'BUTTON') nodes.push(node);
        for (const child of node.children || []) walk(child);
        for (const shadow of node.shadowRoots || []) walk(shadow);
    };
    walk(root);
    const result = [];
    for (const node of nodes) {
        const model = await cdp.send('DOM.getBoxModel', { backendNodeId: node.backendNodeId }).then((value) => value.model).catch(() => null);
        if (!model || model.width < 8 || model.height < 8) continue;
        const attributes = attributesOf(node);
        result.push({
            attributes,
            className: String(attributes.class || ''),
            title: String(attributes.title || ''),
            ariaLabel: String(attributes['aria-label'] || ''),
            center: {
                x: (model.border[0] + model.border[2] + model.border[4] + model.border[6]) / 4,
                y: (model.border[1] + model.border[3] + model.border[5] + model.border[7]) / 4
            },
            box: { x: model.border[0], y: model.border[1], width: model.width, height: model.height }
        });
    }
    return result;
}
const isBall = (button) => /bdc-assistant-ball/.test(button.className);
async function waitBall(cdp, { visible = true, timeout = 12000 } = {}) {
    return waitFor(async () => {
        const ball = (await shellButtons(cdp)).find(isBall);
        return visible ? (ball || false) : (!ball ? true : false);
    }, { timeout });
}
async function clickBall(page, cdp) {
    const ball = await waitBall(cdp);
    if (!ball) return false;
    await page.mouse.click(ball.center.x, ball.center.y);
    return true;
}
async function clickLookupButton(page, cdp, rect) {
    const buttons = await waitFor(async () => {
        const list = (await shellButtons(cdp)).filter((button) => !isBall(button));
        return list.length ? list : false;
    }, { timeout: 10000 });
    if (!buttons) return false;
    const anchorX = rect.x + Math.min(rect.width / 2, 40);
    const anchorY = rect.y + rect.height + 18;
    const chosen = buttons.map((button) => ({ ...button, distance: Math.hypot(button.center.x - anchorX, button.center.y - anchorY) }))
        .sort((left, right) => left.distance - right.distance)[0];
    await page.mouse.click(chosen.center.x, chosen.center.y);
    return true;
}
async function selectWord(page, word = 'plunge') {
    const rect = await page.evaluate((needle) => {
        const node = document.querySelector('#article').firstChild;
        const start = node.textContent.indexOf(needle);
        const range = document.createRange();
        range.setStart(node, start); range.setEnd(node, start + needle.length);
        const box = range.getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, height: box.height };
    }, word);
    await page.mouse.move(rect.x + 1, rect.y + rect.height / 2);
    await page.mouse.down();
    await page.mouse.move(rect.x + rect.width - 1, rect.y + rect.height / 2, { steps: 8 });
    await page.mouse.up();
    return rect;
}

/* ---------- extension pages ---------- */
async function openSettings(scope) {
    const dialog = scope.locator('#ext-settings-dialog');
    const opened = () => dialog.evaluate((node) => node.open).catch(() => false);
    if (await opened()) return;
    const inline = scope.locator('#ext-inline-settings');
    await (await inline.isVisible().catch(() => false) ? inline : scope.locator('#ext-settings-open')).click();
    if (!(await waitFor(opened, { timeout: 3000 }))) {
        // Dialog close events restore the previous inline mode; a second real
        // click is the user-visible retry when the first lands during that handoff.
        await (await inline.isVisible().catch(() => false) ? inline : scope.locator('#ext-settings-open')).click();
        await waitFor(opened, { timeout: 5000 });
    }
}
async function closeSettings(scope) {
    const dialog = scope.locator('#ext-settings-dialog');
    if (!(await dialog.evaluate((node) => node.open).catch(() => false))) return;
    await scope.locator('#ext-settings-close').click();
    await waitFor(async () => !(await dialog.evaluate((node) => node.open).catch(() => false)), { timeout: 5000 });
    await sleep(250);
}
/* 0.6.1：詞書下拉、重整與建書都在 #ext-book-settings 打開的原生 dialog。 */
async function openBookDialog(scope) {
    const dialog = scope.locator('#ext-book-dialog');
    const opened = () => dialog.evaluate((node) => node.open).catch(() => false);
    if (await opened()) return;
    // 上一個原生 dialog 的 close 事件會還原 inline 模式；先等交接完成。
    await scope.waitForFunction(() => !document.querySelector('dialog[open]')
        && !document.body.classList.contains('ext-modal-open'), null, { timeout: 5000 }).catch(() => {});
    await scope.locator('#ext-book-settings').click();
    if (!(await waitFor(opened, { timeout: 3000 }))) await scope.locator('#ext-book-settings').click();
    if (!(await waitFor(opened, { timeout: 5000 }))) throw new Error('book dialog did not open');
}
async function closeBookDialog(scope) {
    const dialog = scope.locator('#ext-book-dialog');
    const opened = () => dialog.evaluate((node) => node.open).catch(() => false);
    if (!(await opened())) return;
    await scope.locator('#ext-book-close').click();
    await waitFor(async () => !(await opened())
        && !(await scope.evaluate(() => document.body.classList.contains('ext-modal-open')).catch(() => true)), { timeout: 5000 });
    await sleep(100);
}
async function selectCaptureBook(scope, id) {
    await openBookDialog(scope);
    await scope.locator('#ext-capture-book').selectOption(id);
    await closeBookDialog(scope);
}
async function login(scope, endpoint, token, label) {
    await openSettings(scope);
    await scope.locator('#ext-endpoint-input').fill(endpoint);
    await scope.locator('#ext-login-mode').selectOption('token');
    await scope.locator('#ext-token-input').fill(token);
    await scope.locator('#ext-connect-btn').click();
    return waitFor(async () => {
        const text = await scope.locator('#ext-account-status').textContent().catch(() => '');
        const disabled = await scope.locator('#ext-connect-btn').isDisabled().catch(() => true);
        return !disabled && text.includes(label) ? text : false;
    }, { timeout: 30000 });
}
async function setLocale(scope, locale) {
    await openSettings(scope);
    await scope.locator('#ext-locale-select').selectOption(locale);
    return waitFor(async () => (await scope.evaluate((value) => new Promise((resolve) => chrome.storage.local.get('bdc_extension_ui_locale', (item) => resolve(item.bdc_extension_ui_locale === value))), locale).catch(() => false)), { timeout: 5000 });
}
async function setAppUrl(popup, value) {
    await openSettings(popup);
    if (!(await popup.locator('#ext-account-details').evaluate((node) => node.open))) await popup.locator('#ext-account-summary').click();
    await popup.locator('#ext-app-url').fill(value);
    await popup.locator('#ext-app-url').dispatchEvent('change');
    await waitFor(() => popup.evaluate((expected) => new Promise((resolve) => chrome.storage.local.get('bdc_extension_app_url', (item) => resolve(item.bdc_extension_app_url === expected))), value), { timeout: 5000 });
}
async function inlineFrame(article, base, predicate = () => true, timeout = 15000) {
    return waitFor(() => article.frames().find((frame) => frame.url().startsWith(base + '/lookup.html') && predicate(frame)) || false, { timeout, interval: 100 });
}
async function closeWindowOf(page) {
    try { await page.close(); } catch (_) { /* already closed */ }
}

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    execFileSync(process.execPath, ['scripts/package-extension.mjs'], { cwd: ROOT, stdio: 'inherit' });
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-compact-assistant-'));
    let env;
    let context;
    try {
        env = await environment();
        const extension = path.join(ROOT, 'extension');
        context = await chromium.launchPersistentContext(profile, {
            channel: 'chromium', headless: true, viewport: { width: 1000, height: 900 },
            args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
        });
        context.on('page', (page) => {
            page.on('pageerror', (error) => pageErrors.push({ url: page.url().slice(0, 120), message: error.message }));
            page.on('console', (message) => {
                if (message.type() === 'error') consoleErrors.push({ url: page.url().slice(0, 120), text: message.text().slice(0, 300) });
            });
        });
        context.on('request', (request) => {
            if (!request.url().includes('/mock-ai/')) return;
            const postData = request.postData();
            if (postData) aiPromptRequests.push({ url: request.url(), postData });
        });
        // BDC 主站以真 token 載入；擴充只使用測試自建 Worker。
        await context.addInitScript(({ endpoint, token, appBase }) => {
            if (!String(location.origin).startsWith(appBase)) return;
            window.__BDC_SYNC_ENDPOINT__ = endpoint;
            localStorage.setItem('sync_token', token);
            localStorage.setItem('sync_user_id', 'alice');
            localStorage.setItem('sync_label', 'alice');
            localStorage.setItem('sync_role', 'user');
            localStorage.setItem('vocabImportPromptShown', '1');
        }, { endpoint: env.base, token: ALICE, appBase: env.appBase });

        const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
        const extBase = `chrome-extension://${new URL(worker.url()).host}`;
        const popup = await context.newPage();
        await popup.goto(extBase + '/lookup.html');
        await popup.waitForFunction(() => !!document.querySelector('#ext-account-status')?.textContent);

        /* ================= 1. 首頁精簡、dialog、兩語 ================= */
        check('首頁顯示三個快捷入口', await popup.locator('#ext-home-assistant, #ext-home-article, #ext-home-book').count() === 3
            && await popup.locator('#ext-home-section').isVisible());
        check('首頁沒有常駐單詞／原句／上文表單', !(await popup.locator('#ext-word-input').isVisible())
            && !(await popup.locator('#ext-sentence-input').isVisible())
            && !(await popup.locator('#ext-context-input').isVisible())
            && !(await popup.locator('#ext-query-dialog').evaluate((node) => node.open)));
        check('首頁沒有常駐 AI 摘要與結果／收藏區', !(await popup.locator('#ext-ai-controls').isVisible())
            && !(await popup.locator('#ext-result-section').isVisible())
            && !(await popup.locator('#ext-capture-section').isVisible())
            && !(await popup.locator('#ext-assistant-section').isVisible()));
        check('首頁沒有常駐文章擷取區', !(await popup.locator('#ext-article-extract').isVisible()));
        const settingsButton = popup.locator('#ext-settings-open');
        check('設定圖示具可見文字以外的無障礙名稱', await settingsButton.getAttribute('title') === '打开设置'
            && await settingsButton.getAttribute('aria-label') === '打开设置');
        check('設定 dialog 初始關閉', !(await popup.locator('#ext-settings-dialog').evaluate((node) => node.open)));
        await settingsButton.click();
        check('設定圖示可開啟 dialog，AI 設定位於 dialog 內', await popup.locator('#ext-settings-dialog').evaluate((node) => node.open)
            && await popup.locator('#ext-ai-controls').isVisible()
            && await popup.locator('#ext-locale-select').isVisible());
        const loggedIn = await login(popup, env.base, ALICE, 'alice');
        check('登入可在設定 dialog 完成', !!loggedIn, { loggedIn });
        await setAppUrl(popup, env.appBase);
        await setLocale(popup, 'zh-HK');
        check('切換 zh-HK 立即寫入 extension storage 並即時翻譯', await popup.locator('#ext-settings-title').textContent() === '設定'
            && await popup.locator('#ext-home-article span').textContent() === '文章詳解'
            && await popup.locator('#ext-settings-open').getAttribute('aria-label') === '開啟設定');
        await popup.locator('#ext-ai-thinking').selectOption('high');
        const thinkingState = await waitFor(() => popup.evaluate(async () => {
            const { getExtensionAITaskSettings } = await import('./modules/extension-ai-runtime.js');
            const tasks = ['wordAnalysis', 'articleWordTranslation', 'articlePhraseTranslation'];
            return tasks.map((task) => [task, getExtensionAITaskSettings(task).thinking]);
        }).then((state) => state.some(([, thinking]) => thinking === 'high') ? state : false), { timeout: 5000 });
        const thinkingNotice = await popup.locator('#ext-ai-notice').textContent();
        check('AI 思考程度即時儲存，無需儲存按鈕', /已保存|已儲存/.test(thinkingNotice), { thinkingState, thinkingNotice });
        await popup.setViewportSize({ width: 320, height: 860 });
        await sleep(300);
        await shot(popup, 'settings-zh-HK-320');
        await closeSettings(popup);
        check('zh-HK 首頁 320px 無橫向溢出', await popup.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await shot(popup, 'home-zh-HK-320', true);
        await setLocale(popup, 'zh-CN');
        check('切回 zh-CN 即時翻譯', await popup.locator('#ext-settings-title').textContent() === '设置'
            && await popup.locator('#ext-home-article span').textContent() === '文章详解'
            && await popup.locator('#ext-settings-open').getAttribute('aria-label') === '打开设置');
        await shot(popup, 'settings-zh-CN-320');
        await closeSettings(popup);
        check('zh-CN 首頁 320px 無橫向溢出', await popup.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await popup.evaluate(() => document.querySelector('#ext-assistant-enabled').checked = true);
        await shot(popup, 'home-zh-CN-320', true);
        await popup.setViewportSize({ width: 1000, height: 900 });
        await sleep(300);
        check('zh-CN 首頁桌面無橫向溢出', await popup.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await shot(popup, 'home-zh-CN-desktop', true);
        await setLocale(popup, 'zh-HK');
        await closeSettings(popup);
        await shot(popup, 'home-zh-HK-desktop', true);
        await setLocale(popup, 'zh-CN');
        await closeSettings(popup);
        await popup.reload();
        await popup.waitForFunction(() => !!document.querySelector('#ext-account-status')?.textContent);
        const persisted = await waitFor(() => popup.evaluate(async () => {
            if (document.querySelector('#ext-locale-select').value !== 'zh-CN') return false;
            const { getExtensionAITaskSettings } = await import('./modules/extension-ai-runtime.js');
            return ['wordAnalysis', 'articleWordTranslation', 'articlePhraseTranslation'].some((task) => getExtensionAITaskSettings(task).thinking === 'high');
        }), { timeout: 10000 });
        check('重開首頁仍保留語言與 AI 設定', !!persisted);
        check('重開後仍為已登入且 dialog 保持關閉', (await popup.locator('#ext-account-status').textContent()).includes('alice')
            && !(await popup.locator('#ext-settings-dialog').evaluate((node) => node.open)));

        /* ================= 2. 懸浮球預設、可關閉／重開 ================= */
        const ballArticle = await context.newPage();
        await ballArticle.goto(env.base + '/test-article?ball=1');
        await ballArticle.bringToFront();
        await ballArticle.waitForFunction(() => !!document.querySelector('bdc-page-lookup'), null, { timeout: 15000 });
        const ballCdp = await context.newCDPSession(ballArticle);
        await ballArticle.evaluate(() => getSelection().removeAllRanges());
        let ball = await waitBall(ballCdp);
        check('未選字時懸浮球預設顯示', !!ball, { ball: ball && { title: ball.title, aria: ball.ariaLabel } });
        check('懸浮球具可讀的無障礙名稱', ball?.title === '打开文章 AI 助手' && ball?.ariaLabel === '打开文章 AI 助手');
        check('懸浮球開關預設勾選', await popup.locator('#ext-assistant-enabled').isChecked());
        await popup.locator('label.ext-switch[for="ext-assistant-enabled"]').click();
        const storedOff = await waitFor(() => popup.evaluate(() => new Promise((resolve) => chrome.storage.local.get('bdc_extension_assistant_enabled', (item) => resolve(item.bdc_extension_assistant_enabled === false)))), { timeout: 5000 });
        const hiddenLive = await waitBall(ballCdp, { visible: false, timeout: 8000 });
        check('關閉懸浮球會即時寫入 storage', !!storedOff);
        check('已開啟的網頁即時隱藏懸浮球', !!hiddenLive);
        await popup.locator('label.ext-switch[for="ext-assistant-enabled"]').click();
        const storedOn = await waitFor(() => popup.evaluate(() => new Promise((resolve) => chrome.storage.local.get('bdc_extension_assistant_enabled', (item) => resolve(item.bdc_extension_assistant_enabled === true)))), { timeout: 5000 });
        const shownLive = await waitBall(ballCdp, { visible: true, timeout: 8000 });
        check('重開懸浮球即時寫入 storage', !!storedOn);
        check('已開啟的網頁即時恢復懸浮球', !!shownLive);
        await setLocale(popup, 'zh-HK');
        await closeSettings(popup);
        const hkBall = await waitFor(async () => {
            const current = (await shellButtons(ballCdp)).find(isBall);
            return current && current.title === '開啟文章 AI 助手' ? current : false;
        }, { timeout: 8000 });
        check('切換語言後懸浮球無障礙名稱即時更新', !!hkBall, { title: hkBall?.title });
        await setLocale(popup, 'zh-CN');
        await closeSettings(popup);

        /* ================= 4. 詞卡助手入口與收藏保留 ================= */
        await ballArticle.bringToFront();
        const wordRect = await selectWord(ballArticle, 'plunge');
        await ballArticle.waitForFunction(() => !!document.querySelector('bdc-page-lookup'));
        const clickedLookup = await clickLookupButton(ballArticle, ballCdp, wordRect);
        check('選字旁可點真實查詞按鈕', clickedLookup);
        const wordFrame = await inlineFrame(ballArticle, extBase, (frame) => new URL(frame.url()).searchParams.has('ticket'));
        check('選字可開啟內嵌詞卡', !!wordFrame, { frames: ballArticle.frames().map((frame) => frame.url().slice(0, 100)) });
        if (!wordFrame) throw new Error('inline word card did not open');
        await wordFrame.waitForFunction(() => !!document.querySelector('#ext-result-meaning')?.textContent, null, { timeout: 30000 });
        check('詞卡保留詞義與收藏區', (await wordFrame.locator('#ext-result-word').textContent()) === 'plunge'
            && await wordFrame.locator('#ext-result-box').isVisible()
            && await wordFrame.locator('#ext-capture-save').isVisible()
            && await wordFrame.locator('#ext-book-settings').isVisible()
            && !(await wordFrame.locator('#ext-capture-book').isVisible())
            && (await wordFrame.locator('#ext-quick-capture').count()) === 0);
        check('緊湊詞卡把查詞表單收進 dialog，工具列可編輯查詞', await wordFrame.locator('#ext-inline-edit').isVisible()
            && !(await wordFrame.locator('#ext-word-input').isVisible())
            && !(await wordFrame.locator('#ext-query-dialog').evaluate((node) => node.open)));
        // 收藏列只留「加入詞書」與詞書設定；選書與查看所在詞書都要先開 dialog。
        await openBookDialog(wordFrame);
        check('精簡詞卡可從收藏列開啟詞書 dialog 選書', await wordFrame.locator('#ext-book-dialog').evaluate((node) => node.open)
            && await wordFrame.locator('#ext-capture-book').isVisible()
            && await wordFrame.locator('#ext-open-book').isVisible());
        await closeBookDialog(wordFrame);
        const originalMeaning = await wordFrame.locator('#ext-result-meaning').textContent();
        const callsBeforeEdit = env.state.aiCalls;
        await wordFrame.locator('#ext-inline-edit').click();
        await wordFrame.locator('#ext-word-input').fill('temporary-edit');
        await wordFrame.locator('#ext-query-close').click();
        await wordFrame.waitForFunction(() => !document.querySelector('#ext-query-dialog').open && document.querySelector('#ext-result-word').textContent === 'plunge');
        check('取消編輯會恢復詞卡及原網頁來源，不重新呼叫 AI',
            (await wordFrame.locator('#ext-result-meaning').textContent()) === originalMeaning
            && (await wordFrame.locator('#ext-word-input').inputValue()) === 'plunge'
            && env.state.aiCalls === callsBeforeEdit);
        const inlineAiCalls = env.state.aiCalls;
        await wordFrame.locator('#ext-inline-ai').click();
        await wordFrame.locator('#ext-assistant-section').waitFor({ state: 'visible', timeout: 15000 });
        await wordFrame.waitForFunction(() => document.querySelector('#ext-assistant-reference-text')?.textContent?.length > 0, null, { timeout: 15000 });
        const reference = await wordFrame.locator('#ext-assistant-reference-text').textContent();
        check('詞卡助手入口帶上原詞與原句', reference.includes('plunge') && reference.includes('Major tech stocks plunge'),
            { reference });
        check('從詞卡開助手不預先呼叫 AI', env.state.aiCalls === inlineAiCalls && env.state.assistant.calls === 0);
        await wordFrame.locator('#ext-inline-back').click();
        await wordFrame.waitForFunction(() => document.querySelector('#ext-assistant-section').hidden && !document.querySelector('#ext-result-box').classList.contains('hidden'), null, { timeout: 10000 });
        check('返回後原詞卡結果仍保留', (await wordFrame.locator('#ext-result-word').textContent()) === 'plunge'
            && (await wordFrame.locator('#ext-result-meaning').textContent()).length > 0);
        const beforeFavorite = env.state.aiCalls;
        // 選書先開 dialog，選好關閉後再按收藏列保存。
        await selectCaptureBook(wordFrame, 'book');
        await wordFrame.locator('#ext-capture-save').click();
        const savedWord = await waitFor(() => env.db.prepare("SELECT data_json FROM reading_entities WHERE owner_user_id='alice' AND entity_type='vocabularyEntry'").all().map((row) => JSON.parse(row.data_json)).find((entry) => entry.word === 'plunge' && entry.bookId === 'book'), { timeout: 15000 });
        check('返回原詞卡後仍可加入原詞書', !!savedWord && savedWord.meaning?.length > 0, savedWord && { word: savedWord.word, bookId: savedWord.bookId });
        check('收藏沿用詞卡結果，不再呼叫 AI', env.state.aiCalls === beforeFavorite);
        check('收藏保留原句與原文來源', savedWord?.sources?.[0]?.sentence?.includes('Major tech stocks plunge')
            && savedWord.sources[0].sourceUrl.startsWith(env.base + '/test-article?ball=1'));
        check('詞卡顯示原文連結', await wordFrame.locator('#ext-capture-source a').getAttribute('href') === ballArticle.url());
        debug.wordCard = { reference, source: await wordFrame.locator('#ext-capture-source a').textContent() };
        await shot(ballArticle, 'word-card-zh-CN-compact');

        // 展開完整面板：文章擷取已移出，只剩詞書設定與原文入口
        await wordFrame.locator('#ext-inline-more').click();
        await wordFrame.waitForFunction(() => document.body.classList.contains('ext-expanded'), null, { timeout: 8000 });
        check('展開詞卡後仍不提供文章擷取', !(await wordFrame.locator('#ext-article-extract').isVisible()));
        check('展開後收藏列仍提供詞書設定與原文連結', await wordFrame.locator('#ext-book-settings').isVisible()
            && await wordFrame.locator('#ext-capture-source a').isVisible()
            && !(await wordFrame.locator('#ext-open-book').isVisible()));
        await openBookDialog(wordFrame);
        check('詞書 dialog 可查看目前所在詞書', await wordFrame.locator('#ext-capture-book').isVisible()
            && await wordFrame.locator('#ext-capture-book').inputValue() === 'book'
            && await wordFrame.locator('#ext-open-book').isVisible()
            && !(await wordFrame.locator('#ext-open-book').isDisabled()));

        // #ext-open-book（dialog 內）→ BDC #v/<id>
        const bookOpened = context.waitForEvent('page');
        await wordFrame.locator('#ext-open-book').click();
        const bookPage = await bookOpened;
        const bookUrl = await waitFor(() => bookPage.url().includes('#v/') ? bookPage.url() : false, { timeout: 15000 });
        check('查看所在詞書導向 BDC #v/<id>', !!bookUrl && bookUrl.includes('#v/book'), { bookUrl });
        await bookPage.waitForFunction(() => document.body.innerText.length > 0, null, { timeout: 15000 }).catch(() => {});
        await closeWindowOf(bookPage);
        await closeBookDialog(wordFrame);
        const sourceOpened = context.waitForEvent('page');
        await wordFrame.locator('#ext-capture-source a').click();
        const sourcePage = await sourceOpened;
        const sourceUrl = await waitFor(() => sourcePage.url().startsWith(env.base + '/test-article?ball=1') ? sourcePage.url() : false, { timeout: 10000 });
        check('原文連結開啟原網頁', !!sourceUrl, { sourceUrl });
        await closeWindowOf(sourcePage);
        await wordFrame.locator('#ext-inline-back').click();
        await wordFrame.waitForFunction(() => document.body.classList.contains('ext-compact'), null, { timeout: 8000 });

        // 320px 兩語詞卡
        await ballArticle.setViewportSize({ width: 320, height: 800 });
        await sleep(500);
        check('詞卡 320px 內無橫向溢出', await wordFrame.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await setLocale(wordFrame, 'zh-HK');
        await closeSettings(wordFrame);
        await shot(ballArticle, 'word-card-zh-HK-320');
        await setLocale(wordFrame, 'zh-CN');
        await closeSettings(wordFrame);
        await shot(ballArticle, 'word-card-zh-CN-320');
        await ballArticle.setViewportSize({ width: 1000, height: 900 });

        /* ================= 5. contextMenu 等價入口與文章獨立視窗 ================= */
        const menuReady = await waitFor(() => worker.evaluate(async (id) => {
            try { await chrome.contextMenus.update(id, {}); return true; } catch (_) { return false; }
        }, 'bdc-import-article'), { timeout: 10000 });
        check('背景已註冊 bdc-import-article contextMenu', !!menuReady);
        // 首頁文章入口（無 ticket，作用於 active http tab）
        const importArticle = await context.newPage();
        await importArticle.goto(env.base + '/test-article?import=1');
        await importArticle.bringToFront();
        const homeArticleOpened = context.waitForEvent('page');
        await popup.evaluate(() => document.querySelector('#ext-home-article').click());
        const homeArticleWindow = await homeArticleOpened;
        const homeArticleUrl = await waitFor(() => homeArticleWindow.url().includes('view=article') ? homeArticleWindow.url() : false, { timeout: 15000 });
        await homeArticleWindow.locator('#ext-page-article-section').waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
        const homeArticleVisible = await homeArticleWindow.locator('#ext-page-article-section').isVisible().catch(() => false);
        check('#ext-home-article 開啟獨立文章 popup（不經下拉／inline 更多）', !!homeArticleUrl
            && new URL(homeArticleUrl).searchParams.get('view') === 'article'
            && !new URL(homeArticleUrl).searchParams.has('import')
            && homeArticleVisible, { homeArticleUrl, homeArticleVisible });
        const homeArticlePopups = await popup.evaluate(async () => {
            const windows = await chrome.windows.getAll({ populate: true });
            return { main: (await chrome.windows.getCurrent()).id,
                popups: windows.filter((window) => window.type === 'popup').map((window) => window.id) };
        });
        check('文章 popup 是獨立視窗而非主視窗分頁', homeArticlePopups.popups.length >= 1
            && !homeArticlePopups.popups.includes(homeArticlePopups.main), homeArticlePopups);
        check('首頁文章區不再常駐，inline 更多也看不到文章擷取', !(await wordFrame.locator('#ext-article-extract').isVisible()));
        await closeWindowOf(homeArticleWindow);

        // 等價右鍵流程：先開 assistant popup 取得 ticket，再把另一個分頁帶到前景，
        // 證明 BDC_OPEN_WINDOW 使用 ticket 綁定的來源，而非 active tab。
        await importArticle.bringToFront();
        const assistantOpened = context.waitForEvent('page');
        await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'BDC_OPEN_WINDOW', view: 'assistant' }));
        const sourceWindow = await assistantOpened;
        const sourceWindowUrl = await waitFor(() => sourceWindow.url().includes('view=assistant') ? sourceWindow.url() : false, { timeout: 15000 });
        check('可開啟助手獨立 popup 作為可信用 ticket 來源', !!sourceWindowUrl);
        const sourceTicket = sourceWindowUrl ? new URL(sourceWindowUrl).searchParams.get('windowTicket') : '';
        const sourcePopups = await popup.evaluate(async () => {
            const windows = await chrome.windows.getAll({ populate: true });
            return windows.filter((window) => window.type === 'popup').map((window) => window.id);
        });
        const decoy = await context.newPage();
        await decoy.goto(env.base + '/test-article?decoy=1');
        await decoy.bringToFront();
        const articleCount = () => env.db.prepare("SELECT COUNT(*) AS n FROM articles WHERE owner_user_id='alice'").get().n;
        const importSource = env.base + '/test-article?import=1';
        const articlesBefore = articleCount();
        const translationsBefore = promptCount('Translate the following English paragraph');
        const cleanupsBefore = promptCount('Clean the supplied Markdown article');
        const importOpened = context.waitForEvent('page');
        const openResult = await sourceWindow.evaluate((ticket) => chrome.runtime.sendMessage({ type: 'BDC_OPEN_WINDOW', view: 'article', autoImport: true, ticket }), sourceTicket);
        check('可信 frame 可發送 BDC_OPEN_WINDOW autoImport', openResult?.ok === true, openResult);
        const importWindow = await importOpened;
        const navigations = [];
        importWindow.on('framenavigated', (frame) => { if (frame === importWindow.mainFrame()) navigations.push(frame.url()); });
        const importLookupUrl = await waitFor(() => navigations.find((url) => url.includes('lookup.html') && url.includes('windowTicket=')) || false, { timeout: 15000 });
        check('autoImport 產生 view=article&import=1 的 lookup popup', !!importLookupUrl
            && new URL(importLookupUrl).searchParams.get('view') === 'article'
            && new URL(importLookupUrl).searchParams.get('import') === '1'
            && /^[0-9a-f-]{32,}$/.test(new URL(importLookupUrl).searchParams.get('windowTicket') || '')
            && new URL(importLookupUrl).searchParams.get('windowTicket') !== sourceTicket,
        { importLookupUrl, sourceTicket });

        // 0.6.2 confirm gate：autoImport 只做 extract，先停在可編輯正文預覽；
        // 確認前不得分析、翻譯、寫入文章或導航主站。
        await importWindow.locator('#ext-article-preview').waitFor({ state: 'visible', timeout: 60000 });
        const previewTitle = await importWindow.locator('#ext-article-title').inputValue();
        const previewBody = await importWindow.locator('#ext-article-body').inputValue();
        const previewState = await importWindow.evaluate(() => ({
            analyze: document.querySelector('#ext-article-analyze').checked,
            saveLabel: document.querySelector('#ext-article-save').textContent.trim(),
            bodyRows: document.querySelector('#ext-article-body').getAttribute('rows'),
            bodyDisabled: document.querySelector('#ext-article-body').disabled,
            openVisible: !document.querySelector('#ext-article-open').hidden
        }));
        check('autoImport 先停在可編輯正文預覽，不自動分析或跳轉',
            previewTitle === 'Major tech stocks plunge'
            && previewBody.includes('## Outlook')
            && !previewBody.includes('private-form-value')
            && previewState.bodyRows === '14' && previewState.bodyDisabled === false
            && previewState.analyze === true
            && previewState.saveLabel === '确认并分析导入'
            && !previewState.openVisible
            && importWindow.url().includes('lookup.html'),
        { previewTitle, previewBody: previewBody.slice(0, 120), previewState, url: importWindow.url() });
        check('提取階段只允許正文清洗 AI，不送逐段翻譯',
            promptCount('Clean the supplied Markdown article') === cleanupsBefore + 1
            && promptCount('Translate the following English paragraph') === translationsBefore,
        { cleanupsBefore, cleanupsAfter: promptCount('Clean the supplied Markdown article'), translationsBefore });
        const articlesAtPreview = articleCount();
        check('確認前資料庫沒有新增文章', articlesAtPreview === articlesBefore, { articlesBefore, articlesAtPreview });
        const translationsAtPreview = promptCount('Translate the following English paragraph');
        check('確認前沒有送出逐段翻譯／分析請求', translationsAtPreview === translationsBefore,
            { translationsBefore, translationsAtPreview });

        // 分析勾選文案是確認內容的一部分：取消後只匯入正文，重新勾選恢復分析。
        await importWindow.locator('#ext-article-analyze').uncheck();
        const saveOnlyLabel = (await importWindow.locator('#ext-article-save').textContent()).trim();
        check('取消分析勾選後按鈕改為僅匯入正文', saveOnlyLabel === '确认并导入正文', { saveOnlyLabel });
        await importWindow.locator('#ext-article-analyze').check();
        check('重新勾選分析恢復預設按鈕文案', (await importWindow.locator('#ext-article-save').textContent()).trim() === '确认并分析导入');

        const editedTitle = 'Major tech stocks plunge (confirmed preview)';
        const editedMarker = 'Markets remain volatile after explicit confirmation.';
        const editedBody = previewBody.replace('Markets remain volatile.', editedMarker);
        await importWindow.locator('#ext-article-title').fill(editedTitle);
        await importWindow.locator('#ext-article-body').fill(editedBody);
        await sleep(300);
        const articlesAfterEdit = articleCount();
        check('預覽標題與正文可編輯，確認前任何輸入都不寫入',
            (await importWindow.locator('#ext-article-title').inputValue()) === editedTitle
            && (await importWindow.locator('#ext-article-body').inputValue()).includes(editedMarker)
            && !(await importWindow.locator('#ext-article-save').isDisabled())
            && articlesAfterEdit === articlesBefore,
        { articlesAfterEdit, editedMarker });

        await importWindow.locator('#ext-article-save').click();
        await importWindow.locator('#ext-article-open').waitFor({ state: 'visible', timeout: 90000 });
        const articlesAfterSave = articleCount();
        const translationsAfterSave = promptCount('Translate the following English paragraph');
        check('按確認後才逐段翻譯、分析並保存文章', articlesAfterSave === articlesBefore + 1
            && translationsAfterSave >= translationsAtPreview + 3
            && importWindow.url().includes('lookup.html'),
        { articlesAfterSave, translationsAtPreview, translationsAfterSave });
        const savedRow = env.db.prepare("SELECT * FROM articles WHERE owner_user_id='alice' AND source_url=? ORDER BY created_at DESC").get(importSource);
        check('保存的是編輯後的標題與正文', savedRow?.title === editedTitle && savedRow?.body?.includes(editedMarker),
            { title: savedRow?.title, editedMarkerSaved: savedRow?.body?.includes(editedMarker) });
        check('文章保存原文來源 URL（ticket 綁定，不是前景 decoy）', savedRow?.source_url === importSource,
            { sourceUrl: savedRow?.source_url });
        check('文章正文含標題、章節，且不含網頁表單私有值', savedRow?.body?.includes('Major tech stocks plunge')
            && savedRow?.body?.includes('## Outlook')
            && !savedRow?.body?.includes('private-form-value'));
        const analysis = savedRow?.analysis_json ? JSON.parse(savedRow.analysis_json) : null;
        check('確認保存後完成逐段分析', Array.isArray(analysis?.paragraph_analysis) && analysis.paragraph_analysis.length >= 3,
            { paragraphs: analysis?.paragraph_analysis?.length });
        check('成功後仍停在文章 popup，等待使用者按「在 BDC 打開」',
            await importWindow.locator('#ext-article-open').isVisible()
            && (await importWindow.locator('#ext-article-open').textContent()).trim() === '在 BDC 打开'
            && importWindow.url().includes('lookup.html'));

        await importWindow.locator('#ext-article-open').click();
        const finalUrl = await waitFor(() => importWindow.url().startsWith(env.appBase) && importWindow.url().includes('#a/') ? importWindow.url() : false, { timeout: 60000 });
        check('導入完成後同 popup 導航 BDC 原站 #a/<id>', !!finalUrl
            && decodeURIComponent(finalUrl.split('#a/')[1]) === savedRow?.id, { finalUrl, navigations, articleId: savedRow?.id });
        const articleRow = finalUrl ? env.db.prepare("SELECT * FROM articles WHERE owner_user_id='alice' AND id=? ORDER BY created_at DESC").get(decodeURIComponent(finalUrl.split('#a/')[1])) : null;
        check('BDC 導向的文章與確認保存的是同一篇', articleRow?.id === savedRow?.id && articleRow?.body?.includes(editedMarker),
            { articleId: articleRow?.id });
        await importWindow.waitForFunction(() => !!document.querySelector('#article-input')?.value, null, { timeout: 30000 }).catch(() => {});
        check('BDC 文章頁載入同一篇正文', (await importWindow.locator('#article-input').inputValue().catch(() => '')).includes('People gather information'));
        const importWindows = await popup.evaluate(async () => {
            const windows = await chrome.windows.getAll({ populate: true });
            return { main: (await chrome.windows.getCurrent()).id,
                popups: windows.filter((window) => window.type === 'popup').map((window) => window.id) };
        });
        check('autoImport 完成於獨立 popup 視窗', importWindows.popups.some((id) => !sourcePopups.includes(id)
            && id !== importWindows.main), { sourcePopups, importWindows });
        debug.article = { navigations, sourceTicket, finalUrl, sourceUrl: savedRow?.source_url, previewTitle, previewState,
            translationsBefore, translationsAtPreview, translationsAfterSave, editedTitle, editedMarker };
        await shot(importWindow, 'article-window-zh-CN');
        await closeWindowOf(importWindow);
        await closeWindowOf(decoy);
        await closeWindowOf(sourceWindow);

        /* ================= 3. 文章 AI 助手 ================= */
        const assistantArticle = await context.newPage();
        await assistantArticle.goto(env.base + '/test-article?assistant=1');
        await assistantArticle.bringToFront();
        await assistantArticle.waitForFunction(() => !!document.querySelector('bdc-page-lookup'), null, { timeout: 15000 });
        const assistantCdp = await context.newCDPSession(assistantArticle);
        await assistantArticle.evaluate(() => getSelection().removeAllRanges());
        const aiBeforeOpen = env.state.aiCalls;
        const assistantCallsBeforeOpen = env.state.assistant.calls;
        const ballClicked = await clickBall(assistantArticle, assistantCdp);
        check('無選字仍可點擊懸浮球', !!ballClicked);
        let assistantPage = await inlineFrame(assistantArticle, extBase, (frame) => new URL(frame.url()).searchParams.get('view') === 'assistant', 8000);
        let assistantEmbedded = !!assistantPage;
        if (assistantPage) {
            check('點球產生 iframe view=assistant', new URL(assistantPage.url()).searchParams.get('view') === 'assistant'
                && new URL(assistantPage.url()).searchParams.has('ticket'), { url: assistantPage.url() });
        } else {
            check('點球產生 iframe view=assistant', false, {
                frames: assistantArticle.frames().map((frame) => frame.url()),
                note: '球點擊後 iframe 未保留；以下助手流程改用 BDC_OPEN_WINDOW view=assistant 取得可重現證據',
                assistantCalls: env.state.assistant.calls
            });
            const opened = context.waitForEvent('page');
            await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'BDC_OPEN_WINDOW', view: 'assistant' }));
            assistantPage = await opened;
            await waitFor(() => assistantPage.url().includes('view=assistant') ? assistantPage : false, { timeout: 15000 });
        }
        await assistantPage.locator('#ext-assistant-section').waitFor({ state: 'visible', timeout: 20000 });
        check('助手開啟時不預先呼叫 AI', env.state.aiCalls === aiBeforeOpen && env.state.assistant.calls === assistantCallsBeforeOpen);
        const contextLoaded = await waitFor(() => assistantPage.locator('#ext-assistant-context').textContent().then((text) => text && text !== '正在读取当前文章…' && text !== '正在讀取目前文章…' ? text : false), { timeout: 20000 });
        check('助手讀到目前文章標題與 URL 上下文', contextLoaded === 'Major tech stocks plunge'
            && (await assistantPage.locator('#ext-assistant-context').getAttribute('title')) === assistantArticle.url(),
        { contextLoaded, title: await assistantPage.locator('#ext-assistant-context').getAttribute('title') });
        check('助手初始顯示空狀態', /可以就当前网页提问|可以就目前網頁提問/.test(await assistantPage.locator('#ext-assistant-messages').textContent()));
        let assistantInput = assistantPage.locator('#ext-assistant-input');
        let assistantSend = assistantPage.locator('#ext-assistant-send');
        let assistantStop = assistantPage.locator('#ext-assistant-stop');
        let assistantRetry = assistantPage.locator('#ext-assistant-retry');
        let assistantMessages = assistantPage.locator('#ext-assistant-messages');
        let assistantNotice = assistantPage.locator('#ext-assistant-notice');
        const alive = () => assistantPage.evaluate(() => !!document.querySelector('#ext-assistant-section')).catch(() => false);
        const waitComplete = () => assistantPage.waitForFunction(() => document.querySelector('#ext-assistant-stop').hidden
            && document.querySelector('#ext-assistant-retry').hidden, null, { timeout: 40000 });
        async function ask(question) {
            await assistantInput.fill(question);
            await assistantSend.click();
            await waitComplete();
        }

        await ask('第一问：文章主旨是什么？');
        const firstMessages = await assistantMessages.innerText();
        check('助手串流顯示使用者問題與回答', firstMessages.includes('第一问') && firstMessages.includes('mock 完成'));
        const firstRequest = env.state.assistant.requests.at(-1);
        check('助手請求使用真 stream:true 與 SSE 回應', firstRequest?.stream === true && env.state.assistant.calls === assistantCallsBeforeOpen + 1);
        const requestText = JSON.stringify(firstRequest?.messages || []);
        check('助手請求帶文章原文與 URL 上下文', requestText.includes('People gather information before making decisions.')
            && requestText.includes('/test-article?assistant=1'));
        check('助手請求包含系統提示與目前問題', (firstRequest?.messages || []).some((message) => message.role === 'system')
            && (firstRequest?.messages || []).some((message) => message.role === 'user' && String(message.content).includes('第一问')));

        await ask('第二问：有哪些风险？');
        const secondMessages = await assistantMessages.innerText();
        const secondRequest = env.state.assistant.requests.at(-1);
        const secondRequestText = JSON.stringify(secondRequest?.messages || []);
        check('連續提問在 UI 累積兩輪', (secondMessages.match(/第一问/g) || []).length >= 1
            && (secondMessages.match(/第二问/g) || []).length >= 1
            && (secondMessages.match(/mock 完成/g) || []).length >= 2);
        check('連續提問把前一輪問答帶進上下文', secondRequestText.includes('第一问') && secondRequestText.includes('助手回答：第一问'));

        // 停止 → 重試
        env.state.assistant.mode = 'hang';
        await assistantInput.fill('停止测试问题');
        await assistantSend.click();
        await assistantStop.waitFor({ state: 'visible', timeout: 15000 });
        const callsAtStop = env.state.assistant.calls;
        await sleep(300);
        await assistantStop.click();
        await assistantRetry.waitFor({ state: 'visible', timeout: 15000 });
        check('停止串流後顯示已停止並提供重試', /已停止/.test(await assistantNotice.textContent()) && await assistantStop.isHidden(),
            { notice: await assistantNotice.textContent() });
        env.state.assistant.mode = 'ok';
        await assistantRetry.click();
        await waitComplete();
        const afterStopRetry = await assistantMessages.innerText();
        check('停止後重試沿用中斷的問題並完成', env.state.assistant.calls >= callsAtStop + 1
            && afterStopRetry.includes('停止测试问题') && afterStopRetry.includes('mock 完成'));

        // 失敗 → 重試
        env.state.assistant.mode = 'fail';
        await assistantInput.fill('失败重试问题');
        await assistantSend.click();
        await assistantRetry.waitFor({ state: 'visible', timeout: 20000 });
        check('助手失敗顯示錯誤並提供重試', /暂时出错|暫時出錯|请求失败|請求失敗/.test(await assistantNotice.textContent()));
        env.state.assistant.mode = 'ok';
        const callsAtFailure = env.state.assistant.calls;
        await assistantRetry.click();
        await waitComplete();
        const afterFailureRetry = await assistantMessages.innerText();
        check('助手失敗後重試成功且不新增重複問題', env.state.assistant.calls === callsAtFailure + 1
            && afterFailureRetry.includes('失败重试问题') && afterFailureRetry.includes('mock 完成'));

        // 草稿重開
        const historyBeforeDraft = await assistantMessages.innerText();
        await assistantInput.fill('草稿：尚未送出的问题');
        await sleep(600);
        if (assistantEmbedded) {
            await assistantPage.locator('#ext-inline-close').click();
            await assistantPage.locator('#ext-inline-confirm').waitFor({ state: 'visible', timeout: 8000 });
            check('內嵌助手有草稿時關閉會確認', /尚未送出|草稿|保留|放弃|放棄/.test(await assistantPage.locator('#ext-inline-confirm-text').textContent()));
            await assistantPage.locator('#ext-inline-discard').click();
            await waitFor(() => assistantArticle.frames().none((frame) => frame.url().startsWith(extBase + '/lookup.html')), { timeout: 15000 });
            const reopened = await clickBall(assistantArticle, assistantCdp);
            check('回收小窗後可再點懸浮球重開', !!reopened);
            assistantPage = await inlineFrame(assistantArticle, extBase, (frame) => new URL(frame.url()).searchParams.get('view') === 'assistant', 10000);
            check('重開助手仍在同一個 iframe 入口', !!assistantPage);
            if (assistantPage) {
                assistantInput = assistantPage.locator('#ext-assistant-input');
                assistantSend = assistantPage.locator('#ext-assistant-send');
                assistantStop = assistantPage.locator('#ext-assistant-stop');
                assistantRetry = assistantPage.locator('#ext-assistant-retry');
                assistantMessages = assistantPage.locator('#ext-assistant-messages');
                assistantNotice = assistantPage.locator('#ext-assistant-notice');
            }
        } else {
            await assistantPage.close();
            await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'BDC_OPEN_WINDOW', view: 'assistant' }));
            assistantPage = await waitFor(() => context.pages().find((page) => page.url().includes('view=assistant')) || false, { timeout: 15000 });
            check('回收助手 popup 後可再開', !!assistantPage);
            await assistantPage.locator('#ext-assistant-section').waitFor({ state: 'visible', timeout: 20000 });
            assistantInput = assistantPage.locator('#ext-assistant-input');
            assistantSend = assistantPage.locator('#ext-assistant-send');
            assistantStop = assistantPage.locator('#ext-assistant-stop');
            assistantRetry = assistantPage.locator('#ext-assistant-retry');
            assistantMessages = assistantPage.locator('#ext-assistant-messages');
            assistantNotice = assistantPage.locator('#ext-assistant-notice');
        }
        await assistantPage.waitForFunction(() => document.querySelector('#ext-assistant-context')?.textContent?.length > 0, null, { timeout: 20000 });
        const restoredDraft = await waitFor(async () => {
            const value = await assistantPage.locator('#ext-assistant-input').inputValue();
            return value === '草稿：尚未送出的问题' ? value : false;
        }, { timeout: 10000 });
        check('重開助手恢復未送出的草稿', !!restoredDraft, { restoredDraft });
        check('重開助手恢復既有對話', (await assistantPage.locator('#ext-assistant-messages').innerText()).includes('第一问'));

        // 收放同一 frame
        const expand = assistantPage.locator('#ext-assistant-expand');
        if (assistantEmbedded) {
            const beforeBox = await assistantPage.frameElement().then((element) => element.boundingBox());
            const beforeUrl = assistantPage.url();
            await expand.click();
            await waitFor(async () => (await expand.getAttribute('aria-pressed')) === 'true', { timeout: 8000 });
            await sleep(600);
            const afterBox = await assistantPage.frameElement().then((element) => element.boundingBox());
            check('展開助手為側欄並保持同一個 frame', !assistantPage.isDetached()
                && assistantPage.url() === beforeUrl
                && afterBox && beforeBox && afterBox.height > beforeBox.height + 80,
            { beforeBox, afterBox });
            await expand.click();
            await waitFor(async () => (await expand.getAttribute('aria-pressed')) === 'false', { timeout: 8000 });
            await sleep(600);
            const collapsedBox = await assistantPage.frameElement().then((element) => element.boundingBox());
            check('收回助手回到小窗且仍是同一個 frame', !assistantPage.isDetached()
                && assistantPage.url() === beforeUrl
                && collapsedBox && Math.abs(collapsedBox.height - beforeBox.height) < 40,
            { beforeBox, collapsedBox });
        } else {
            const beforeUrl = assistantPage.url();
            await expand.click();
            await waitFor(async () => (await expand.getAttribute('aria-pressed')) === 'true', { timeout: 8000 });
            check('助手 popup 可切換展開狀態且保持同一文件', assistantPage.url() === beforeUrl);
            await expand.click();
            await waitFor(async () => (await expand.getAttribute('aria-pressed')) === 'false', { timeout: 8000 });
        }

        // 320px 兩語助手
        const resizeAssistant = async (width) => {
            if (assistantEmbedded) await assistantArticle.setViewportSize({ width, height: 900 });
            else await assistantPage.setViewportSize({ width, height: 800 });
            await sleep(500);
        };
        await resizeAssistant(320);
        check('助手 320px 無橫向溢出', await assistantPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        const lifecycle = { afterResize320: await alive() };
        await setLocale(assistantPage, 'zh-HK');
        await closeSettings(assistantPage);
        lifecycle.afterHk320 = await alive();
        await shot(assistantPage, 'assistant-zh-HK-320');
        await setLocale(assistantPage, 'zh-CN');
        await closeSettings(assistantPage);
        lifecycle.afterCn320 = await alive();
        await shot(assistantPage, 'assistant-zh-CN-320');
        await resizeAssistant(assistantEmbedded ? 1000 : 900);
        lifecycle.afterResizeDesktop = await alive();
        check('助手桌面無橫向溢出', await assistantPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await setLocale(assistantPage, 'zh-HK');
        await closeSettings(assistantPage);
        lifecycle.afterHkDesktop = await alive();
        await shot(assistantPage, 'assistant-zh-HK-desktop');
        await setLocale(assistantPage, 'zh-CN');
        await closeSettings(assistantPage);
        lifecycle.afterCnDesktop = await alive();
        debug.assistantLifecycle = lifecycle;
        const survivedLocaleResize = await alive();
        check('調整視窗與語言後助手仍存活', !!survivedLocaleResize, lifecycle);
        if (!survivedLocaleResize && assistantEmbedded) {
            const reopened = await clickBall(assistantArticle, assistantCdp);
            assistantPage = await inlineFrame(assistantArticle, extBase, (frame) => new URL(frame.url()).searchParams.get('view') === 'assistant', 10000);
            check('語言切換掉 frame 後仍可重新開啟助手（僅為了後續帳戶切換取證）', !!reopened && !!assistantPage);
            await assistantPage?.locator('#ext-assistant-section').waitFor({ state: 'visible', timeout: 20000 });
            await assistantPage?.waitForFunction(() => document.querySelector('#ext-assistant-context')?.textContent?.length > 0, null, { timeout: 20000 });
            assistantInput = assistantPage.locator('#ext-assistant-input');
            assistantSend = assistantPage.locator('#ext-assistant-send');
            assistantStop = assistantPage.locator('#ext-assistant-stop');
            assistantRetry = assistantPage.locator('#ext-assistant-retry');
            assistantMessages = assistantPage.locator('#ext-assistant-messages');
            assistantNotice = assistantPage.locator('#ext-assistant-notice');
        }

        // 帳戶切換不混結果
        const aliceMessages = await assistantMessages.innerText();
        await openSettings(assistantPage);
        if (!(await assistantPage.locator('#ext-account-details').evaluate((node) => node.open))) await assistantPage.locator('#ext-account-summary').click();
        await assistantPage.locator('#ext-logout-btn').click();
        await assistantPage.waitForFunction(() => /未登录|未登錄/.test(document.querySelector('#ext-account-status').textContent), null, { timeout: 20000 });
        const afterLogout = await assistantMessages.innerText();
        check('切換帳戶前登出會清空助手對話與草稿', !afterLogout.includes('第一问')
            && (await assistantInput.inputValue()) === '', { afterLogout });
        if (!(await assistantPage.locator('#ext-account-details').evaluate((node) => node.open))) await assistantPage.locator('#ext-account-summary').click();
        await assistantPage.locator('#ext-endpoint-input').fill(env.base);
        await assistantPage.locator('#ext-login-mode').selectOption('token');
        await assistantPage.locator('#ext-token-input').fill(BOB);
        await assistantPage.locator('#ext-connect-btn').click();
        await waitFor(async () => (await assistantPage.locator('#ext-account-status').textContent()).includes('bob'), { timeout: 30000 });
        await closeSettings(assistantPage);
        await assistantInput.fill('Bob 的新问题');
        await assistantSend.click();
        await waitComplete();
        const bobMessages = await assistantMessages.innerText();
        const bobRequest = JSON.stringify(env.state.assistant.requests.at(-1)?.messages || []);
        check('切換 Bob 後不顯示 Alice 的對話', !bobMessages.includes('第一问') && !bobMessages.includes('alice') && bobMessages.includes('Bob 的新问题'));
        check('切換 Bob 後請求上下文不含 Alice 對話', !bobRequest.includes('第一问') && !bobRequest.includes(aliceMessages.slice(0, 20)));
        check('切換 Bob 後仍使用同一篇文章上下文', bobRequest.includes('/test-article?assistant=1') && bobRequest.includes('People gather information'));

        debug.assistant = { embedded: assistantEmbedded, contextLoaded, firstRequest: {
            stream: firstRequest?.stream,
            roles: (firstRequest?.messages || []).map((message) => message.role)
        }, bobRequestRoles: (env.state.assistant.requests.at(-1)?.messages || []).map((message) => message.role) };

        check('整個流程沒有未捕獲頁面錯誤', pageErrors.length === 0, pageErrors.slice(0, 5));
    } catch (error) {
        checks.push({ name: 'execution', ok: false, detail: String(error && error.stack || error).slice(0, 3000) });
        console.error(error.stack || error);
        process.exitCode = 1;
        if (context) {
            for (const page of context.pages()) {
                try {
                    debug.pages = [...(debug.pages || []), {
                        url: page.url(),
                        assistant: await page.locator('#ext-assistant-section').isVisible().catch(() => false),
                        notice: await page.locator('#ext-assistant-notice').textContent().catch(() => ''),
                        account: await page.locator('#ext-account-status').textContent().catch(() => '')
                    }];
                } catch (_) { /* ignore */ }
            }
        }
    } finally {
        if (context) await context.close();
        if (env) await env.close();
        fs.rmSync(profile, { recursive: true, force: true });
        const failed = checks.filter((item) => !item.ok);
        if (failed.length) process.exitCode = 1;
        fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({
            timestamp: new Date().toISOString(), stamp, checks, shots, pageErrors, consoleErrors, debug,
            realMV3: true, realWorkerSQLite: true, aiMocked: true, assistantStreaming: true
        }, null, 2));
        console.log(JSON.stringify({ passed: checks.length - failed.length, failed: failed.length, output: OUT }));
    }
})();
