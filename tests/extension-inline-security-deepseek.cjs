// DeepSeek 獨立測試：擴充套件 0.3.0 網頁浮窗（iframe）與待傳 UI 的邊界。
//
// 真 MV3：真 Chromium 載入 extension/、真 Worker 路由＋SQLite（tests/helpers/extension-mv3.cjs），
// 只有 AI transport 是 mock。受測檔：extension/background.js、extension/page-lookup.js、
// extension/lookup.js、extension/workspace-ui.js、extension/modules/extension-workspace.js、
// shared/workspace-client.mjs（由 scripts/package-extension.mjs 打包進 extension/shared/）。
//
// 覆蓋範圍：
//   1. 正常浮窗基線（嚴格 CSP 網頁上可查詞，證明後面的「不應發生」是有對照的）
//   2. ticket 錯誤／空白／不存在 → 浮窗顯示不可用，不得初始化帳戶或呼叫 AI
//   3. ticket 重播（同 tab 第二次、關閉後再一次）與跨 tab 重播一律拒絕
//   4. 網頁偽造 postMessage／合成滑鼠事件不得開浮窗、關浮窗、查詞或寫入
//   5. 網頁世界讀不到 chrome.storage（TRUSTED_CONTEXTS），也沒有 token／AI Key
//   6. 待傳 UI（F1 回歸）：保存失敗後預覽鎖定；重開面板後再由本頁擷取必須「從待傳還原原稿並鎖定」，
//      不可產生第二份可編輯新稿；只能由待傳列重試／取消；雲端保留第一次正文、不重跑 AI、不重建文章。
//      另驗證「本頁沒有待傳但雲端已有文章」時直接顯示既有文章入口（GET ?sourceUrl → page-link）。
//   7. 登出／帳戶切換：導航到新 query URL 取得真新頁預覽，再驗證取消 AI、清預覽、殘留內容與跨帳戶隔離
//
// 所有帳號與資料由測試自建；不連正式 Worker、不讀私有設定。輸出寫到 docs/report/assets/<時間戳>_inline-security/。

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { environment, ALICE, BOB } = require('./helpers/extension-mv3.cjs');

const ROOT = path.resolve(__dirname, '..');
const stamp = new Date(Date.now() + 8 * 3600000).toISOString().replace(/\D/g, '').slice(0, 17);
const OUT = process.env.INLINE_SECURITY_OUTPUT || path.join(ROOT, 'docs/report/assets', stamp + '_inline-security');
const INLINE_UNAVAILABLE_ZH_CN = '无法在此页面打开查词，请回到普通网页重新选词。';
const checks = [];
function check(name, condition, detail) {
    checks.push({ name, ok: !!condition, ...(detail === undefined ? {} : { detail }) });
    console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${condition || detail === undefined ? '' : ': ' + JSON.stringify(detail)}`);
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// 受測檔快照：產品仍在開發，報告與 artifact 必須能對回同一組內容。
const TESTED_FILES = [
    'extension/background.js', 'extension/page-lookup.js', 'extension/lookup.js', 'extension/workspace-ui.js',
    'extension/modules/extension-workspace.js', 'extension/modules/extension-ai-runtime.js',
    'extension/modules/sync-cloudflare.js', 'extension/manifest.json',
    'modules/extension-workspace.js', 'shared/workspace-client.mjs', 'shared/page-protocol.mjs',
    'cloudflare-worker/src/capture-books.js', 'cloudflare-worker/src/page-links.js',
    'scripts/package-extension.mjs', 'tests/helpers/extension-mv3.cjs',
    'tests/extension-inline-security-deepseek.cjs', 'tests/extension-workspace-client-deepseek.test.mjs'
];
function productHashes() {
    return Object.fromEntries(TESTED_FILES.map((file) => {
        const absolute = path.join(ROOT, file);
        const stat = fs.statSync(absolute);
        return [file, {
            sha256_16: createHash('sha256').update(fs.readFileSync(absolute)).digest('hex').slice(0, 16),
            mtime: new Date(stat.mtimeMs + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19)
        }];
    }));
}

async function waitForFrame(page, prefix, timeout = 15000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
        const frame = page.frames().find((candidate) => candidate.url().startsWith(prefix));
        if (frame) return frame;
        await sleep(100);
    }
    return null;
}

async function openEmbedded(page, url, marker) {
    const source = url + (url.includes('?') ? '&' : '?') + 'probe=' + encodeURIComponent(marker);
    await page.evaluate((address) => {
        const frame = document.createElement('iframe');
        frame.src = address;
        frame.id = 'ds-probe-' + Math.random().toString(36).slice(2);
        frame.width = '400';
        frame.height = '600';
        document.body.appendChild(frame);
    }, source);
    return waitForFrame(page, source);
}

async function frameSnapshot(frame) {
    return frame.evaluate(() => ({
        text: (document.body.textContent || '').trim(),
        status: document.querySelector('#ext-account-status') ? document.querySelector('#ext-account-status').textContent : null,
        task: document.querySelector('#ext-task-status') ? document.querySelector('#ext-task-status').textContent : null,
        inline: document.body.classList.contains('ext-inline'),
        notice: document.querySelector('#ext-workspace-notice') ? document.querySelector('#ext-workspace-notice').textContent : null
    })).catch((error) => ({ error: String(error && error.message || error) }));
}

async function articleRowCount(env) {
    return env.db.prepare("SELECT COUNT(*) AS count FROM articles WHERE owner_user_id='alice' AND deleted_at IS NULL").get().count;
}

async function bookCount(env) {
    return env.db.prepare("SELECT COUNT(*) AS count FROM reading_entities WHERE owner_user_id='alice' AND entity_type='vocabularyBook' AND deleted_at IS NULL").get().count;
}

async function pendingCount(popup) {
    const stored = await popup.evaluate(() => chrome.storage.local.get(null));
    return Object.keys(stored || {}).filter((key) => key.startsWith('bdc_workspace_outbox_v1:')).length;
}

async function pendingKeys(popup) {
    const stored = await popup.evaluate(() => chrome.storage.local.get(null));
    return Object.fromEntries(Object.entries(stored || {})
        .filter(([key]) => key.startsWith('bdc_workspace_outbox_v1:'))
        .map(([key, value]) => [key.slice(-12), { type: value?.type, requestId: value?.requestId, keys: Object.keys(value?.payload || {}) }]));
}

async function noticeText(popup) {
    return popup.evaluate(() => (document.querySelector('#ext-workspace-notice')?.textContent || '').trim());
}

async function articleBody(env) {
    const row = env.db.prepare("SELECT body FROM articles WHERE owner_user_id='alice' AND deleted_at IS NULL ORDER BY created_at LIMIT 1").get();
    return row ? row.body : '';
}

async function articleIds(env) {
    return env.db.prepare("SELECT COALESCE(legacy_article_id, id) AS id FROM articles WHERE owner_user_id='alice' AND deleted_at IS NULL ORDER BY created_at")
        .all().map((row) => row.id);
}

/**
 * 「伺服器已套用，但回應遺失」：測試端先把同一個請求真的送進 Worker（等它寫完），再讓瀏覽器看到 503。
 * 不用 route.fetch()：它的完成時機在本輪曾出現 1 次時序差，讓「伺服器其實已建立」的斷言偶發失敗；
 * 這裡改成「先套用、後失敗」，前提本身就是確定的，用戶端看到的仍然是失敗。
 */
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

async function connect(popup, base, env, token) {
    await popup.locator('#ext-endpoint-input').fill(env.base);
    await popup.locator('#ext-login-mode').selectOption('token');
    await popup.locator('#ext-token-input').fill(token);
    await popup.locator('#ext-connect-btn').click();
    await popup.waitForFunction(() => !document.querySelector('#ext-connect-btn').disabled
        && /已连接账户/.test(document.querySelector('#ext-account-status').textContent), null, { timeout: 30000 });
}

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    execFileSync(process.execPath, ['scripts/package-extension.mjs'], { cwd: ROOT });
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-inline-ds-'));
    let env;
    let context;
    const errors = [];
    const consoles = [];
    const debug = [];
    const badResponses = [];
    const requestLog = [];
    const hashes = productHashes();
    try {
        env = await environment();
        const extension = path.join(ROOT, 'extension');
        context = await chromium.launchPersistentContext(profile, {
            channel: 'chromium', headless: true, viewport: { width: 1280, height: 900 },
            args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
        });
        context.on('page', (page) => {
            page.on('pageerror', (error) => errors.push(error.message));
            page.on('console', (message) => {
                if (message.type() === 'error') {
                    const location = message.location();
                    consoles.push({ text: message.text(), url: String(location?.url || '').slice(0, 120), page: String(page.url()).slice(0, 90) });
                }
            });
        });
        context.on('response', (response) => {
            if (response.status() >= 400) badResponses.push({ status: response.status(), url: response.url().replace(/ticket=[^&]*/, 'ticket=<redacted>') });
        });
        // 只記錄送到測試同步伺服器（含 AI mock）的請求：用來證明「沒有重跑 AI／沒有重建文章」。
        context.on('request', (request) => {
            const address = request.url();
            if (address.startsWith(env.base)) requestLog.push({ method: request.method(), path: address.slice(env.base.length) });
        });
        const requestsSince = (mark) => requestLog.slice(mark);
        const aiRequestsSince = (mark) => requestsSince(mark).filter((entry) => entry.path.startsWith('/mock-ai/')).length;
        const writesSince = (mark, pathname) => requestsSince(mark)
            .filter((entry) => entry.method !== 'GET' && entry.path.split('?')[0] === pathname).length;
        const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
        const base = `chrome-extension://${new URL(worker.url()).host}`;

        /* ---------- 基線：連上帳戶 ---------- */
        const popup = await context.newPage();
        const popupErrors = [];
        popup.on('pageerror', (error) => popupErrors.push(error.message));
        await popup.goto(base + '/lookup.html');
        await popup.waitForFunction(() => !!document.querySelector('#ext-account-status').textContent);
        await connect(popup, base, env, ALICE);
        check('可信擴充套件頁面可連上測試帳戶', (await popup.locator('#ext-account-status').textContent()).includes('alice'));
        check('擴充套件頁面可以讀 chrome.storage', (await popup.evaluate(() => chrome.storage.local.get(null).then(() => true).catch(() => false))) === true);

        const article = await context.newPage();
        await article.goto(env.base + '/test-article?strict=1');
        await article.bringToFront();

        const selectWord = async () => {
            const rect = await article.evaluate(() => {
                const node = document.querySelector('#article').firstChild;
                const start = node.textContent.indexOf('plunge');
                const range = document.createRange();
                range.setStart(node, start);
                range.setEnd(node, start + 6);
                const box = range.getBoundingClientRect();
                return { x: box.x, y: box.y, width: box.width, height: box.height };
            });
            await article.mouse.move(rect.x + 1, rect.y + rect.height / 2);
            await article.mouse.down();
            await article.mouse.move(rect.x + rect.width - 1, rect.y + rect.height / 2, { steps: 8 });
            await article.mouse.up();
            await article.mouse.click(rect.x + 26, rect.y + rect.height + 20);
            return rect;
        };

        /* ---------- 1. 正常浮窗基線 ---------- */
        await selectWord();
        await article.waitForFunction(() => !!document.querySelector('bdc-page-lookup'));
        let panel = null;
        for (let attempt = 0; attempt < 60 && !panel; attempt += 1) {
            panel = article.frames().find((frame) => frame.url().startsWith(base + '/lookup.html'));
            if (!panel) await sleep(100);
        }
        check('選字後可在嚴格 CSP 網頁開啟浮窗', !!panel);
        await panel.waitForFunction(() => !!document.querySelector('#ext-result-meaning')?.textContent, null, { timeout: 30000 });
        const aiAfterBaseline = env.state.aiCalls;
        check('正常浮窗會初始化帳戶並完成查詞', (await frameSnapshot(panel)).status?.includes('alice') === true && aiAfterBaseline > 0);
        check('正常浮窗帶 ticket 且已標記內嵌模式', (await frameSnapshot(panel)).inline === true);
        const ticket = new URL(panel.url()).searchParams.get('ticket') || '';
        check('浮窗 ticket 不是空值', ticket.length >= 32, { length: ticket.length });
        const articlesBefore = await articleRowCount(env);
        const booksBefore = await bookCount(env);

        /* ---------- 2. ticket 錯誤不得初始化 ---------- */
        const badCases = [
            { name: '偽造 ticket', url: base + '/lookup.html?embedded=1&ticket=' + 'f'.repeat(36) },
            { name: '空白 ticket', url: base + '/lookup.html?embedded=1&ticket=' },
            { name: '缺 ticket', url: base + '/lookup.html?embedded=1' }
        ];
        for (const [index, entry] of badCases.entries()) {
            const frame = await openEmbedded(article, entry.url, 'bad' + index);
            await frame?.waitForLoadState().catch(() => {});
            const snapshot = frame ? await frameSnapshot(frame) : { error: 'frame missing' };
            check(`${entry.name}：顯示不可用且不初始化`, snapshot.text === INLINE_UNAVAILABLE_ZH_CN && snapshot.status === null, snapshot);
            await frame?.evaluate(() => document.querySelector('iframe')?.remove());
        }
        // 頂層分頁（即使帶著真 ticket）不得以內嵌模式初始化。
        const topLevel = await context.newPage();
        await topLevel.goto(base + '/lookup.html?embedded=1&ticket=' + encodeURIComponent(ticket)).catch(() => {});
        await topLevel.waitForFunction(() => !!document.body.textContent.trim(), null, { timeout: 15000 }).catch(() => {});
        const topLevelText = (await topLevel.evaluate(() => document.body.textContent.trim())).slice(0, 200);
        check('頂層分頁帶真 ticket 也不得用內嵌模式初始化', topLevelText === INLINE_UNAVAILABLE_ZH_CN, { topLevelText });
        await topLevel.goto(base + '/lookup.html?embedded=1').catch(() => {});
        await topLevel.waitForFunction(() => !!document.body.textContent.trim(), null, { timeout: 15000 }).catch(() => {});
        check('頂層分頁帶 embedded 參數也不得開內嵌模式',
            (await topLevel.evaluate(() => document.body.textContent.trim())) === INLINE_UNAVAILABLE_ZH_CN);
        await topLevel.close();
        check('偽造 ticket 未啟動任何 AI 呼叫', env.state.aiCalls === aiAfterBaseline, { aiCalls: env.state.aiCalls });
        check('偽造 ticket 沒有任何文章／詞書寫入', (await articleRowCount(env)) === articlesBefore && (await bookCount(env)) === booksBefore);

        /* ---------- 3. 重播與跨 tab ---------- */
        const replaySameTab = await openEmbedded(article, base + '/lookup.html?embedded=1&ticket=' + encodeURIComponent(ticket), 'replay-same');
        await replaySameTab?.waitForLoadState().catch(() => {});
        const replaySnapshot = replaySameTab ? await frameSnapshot(replaySameTab) : { error: 'frame missing' };
        check('同 tab 重播 ticket：拒絕（第二次文件不得頂替原浮窗）', replaySnapshot.text === INLINE_UNAVAILABLE_ZH_CN, replaySnapshot);
        check('原浮窗仍是原本的文件（未被重播取代）', panel.isDetached() === false && (await frameSnapshot(panel)).status?.includes('alice') === true);
        await replaySameTab?.evaluate(() => document.querySelector('iframe')?.remove());

        const otherTab = await context.newPage();
        await otherTab.goto(env.base + '/test-article?strict=1');
        const crossTab = await openEmbedded(otherTab, base + '/lookup.html?embedded=1&ticket=' + encodeURIComponent(ticket), 'replay-cross');
        await crossTab?.waitForLoadState().catch(() => {});
        const crossSnapshot = crossTab ? await frameSnapshot(crossTab) : { error: 'frame missing' };
        check('跨 tab 重播 ticket：拒絕', crossSnapshot.text === INLINE_UNAVAILABLE_ZH_CN, crossSnapshot);
        await otherTab.close();

        /* ---------- 4. 網頁偽造訊息與合成事件 ---------- */
        const framesBeforeForge = article.frames().length;
        await article.evaluate(() => {
            const forged = [
                { type: 'BDC_OPEN_INLINE' }, { type: 'BDC_READ_PAGE' }, { type: 'BDC_INLINE_CONTEXT', ticket: '' },
                { type: 'BDC_CLOSE_INLINE', ticket: '' }, { type: 'BDC_INLINE_LABELS' }, { type: 'BDC_ENABLE_INLINE' }
            ];
            for (const message of forged) window.postMessage(message, '*');
            for (let index = 0; index < window.length; index += 1) {
                for (const message of forged) {
                    try { window.frames[index].postMessage(message, '*'); } catch (_) { /* cross-origin 保護 */ }
                }
            }
            for (const type of ['mouseup', 'mousedown', 'click', 'mouseover']) {
                document.dispatchEvent(new MouseEvent(type, { bubbles: true, composed: true, clientX: 20, clientY: 20 }));
                document.querySelector('bdc-page-lookup')?.dispatchEvent(new MouseEvent(type, { bubbles: true, composed: true }));
            }
        });
        await sleep(800);
        const afterForgeSnapshot = await frameSnapshot(panel);
        check('偽造 postMessage 後浮窗仍存活且結果未變', article.frames().includes(panel)
            && afterForgeSnapshot.status?.includes('alice') === true, { frames: article.frames().length, snapshot: afterForgeSnapshot });
        check('偽造 postMessage 沒有開啟新浮窗', article.frames().length === framesBeforeForge, { before: framesBeforeForge, after: article.frames().length });
        check('偽造 postMessage／合成滑鼠事件沒有新增 AI 呼叫', env.state.aiCalls === aiAfterBaseline);
        check('網站寫著假 ticket 的 iframe 被拒絕、沒有寫入', (await articleRowCount(env)) === articlesBefore && (await bookCount(env)) === booksBefore);
        check('網頁看不到浮窗內容（closed shadow root）', await article.evaluate(() => document.querySelector('bdc-page-lookup')?.shadowRoot === null));
        check('網頁無法列出浮窗網址', await article.evaluate(() => {
            try { return !String(window.frames[0]?.location?.href || '').includes('/lookup.html'); } catch (_) { return true; }
        }));

        /* ---------- 5. 網頁世界沒有 storage／token ---------- */
        const storageProbe = await popup.evaluate(async () => {
            const tabs = await chrome.tabs.query({});
            const target = tabs.find((tab) => /\/test-article/.test(tab.url || ''));
            if (!target) return { ok: false, message: 'article tab missing' };
            const [result] = await chrome.scripting.executeScript({
                target: { tabId: target.id },
                func: async () => {
                    const outcome = { runtime: !!(window.chrome && window.chrome.runtime && window.chrome.runtime.id) };
                    try { await chrome.storage.local.get(null); outcome.storage = 'readable'; }
                    catch (error) { outcome.storage = 'denied: ' + String(error && error.message || error); }
                    return outcome;
                }
            });
            return result.result;
        });
        check('內容腳本世界讀不到 chrome.storage（TRUSTED_CONTEXTS）', typeof storageProbe?.storage === 'string' && storageProbe.storage.startsWith('denied'), storageProbe);
        const pageWorldLeak = await article.evaluate(() => ({
            localStorage: JSON.stringify({ ...localStorage }),
            sessionStorage: JSON.stringify({ ...sessionStorage }),
            runtimeId: !!(window.chrome && window.chrome.runtime && window.chrome.runtime.id)
        }));
        check('網頁 localStorage／sessionStorage 沒有 ticket 或 token', !pageWorldLeak.localStorage.includes('a'.repeat(43))
            && !pageWorldLeak.sessionStorage.includes('a'.repeat(43)) && !pageWorldLeak.sessionStorage.includes('ticket'), pageWorldLeak);
        check('網頁世界沒有 chrome.runtime', pageWorldLeak.runtimeId === false);

        /* ---------- 6. 待傳 UI（F1 回歸） ---------- */
        const editedBody = '使用者編輯後的正文（第一次）';
        const blockedEdit = '待傳存在時嘗試改寫的正文（不得進入雲端）';
        await article.bringToFront();
        await popup.locator('#ext-article-extract').click();
        await popup.locator('#ext-article-preview').waitFor({ state: 'visible', timeout: 60000 });
        const firstTitle = await popup.locator('#ext-article-title').inputValue();
        check('面板可從目前分頁擷取文章並預覽', firstTitle.length > 0);
        await popup.locator('#ext-article-body').fill(editedBody);
        await popup.locator('#ext-article-analyze').check();

        // 文章已寫入伺服器，但回應被換成 503（等同「回應遺失」）。
        await applyThenFail(context, env, ALICE, '/articles');
        const aiBeforeSave = env.state.aiCalls;
        await popup.locator('#ext-article-save').click();
        await popup.waitForFunction(() => document.querySelectorAll('#ext-workspace-pending-list li').length > 0, null, { timeout: 30000 });
        await popup.waitForFunction(() => !document.querySelector('#ext-workspace-notice').hidden, null, { timeout: 30000 });
        const aiAfterSave = env.state.aiCalls;
        const lockedNow = await popup.evaluate(() => document.querySelector('#ext-article-body').disabled
            && document.querySelector('#ext-article-title').disabled && document.querySelector('#ext-article-analyze').disabled);
        check('保存失敗後待傳出現且預覽立即鎖定', lockedNow && (await pendingCount(popup)) === 1);
        check('勾選逐段分析時保存會跑一次 AI 分析', aiAfterSave > aiBeforeSave, { aiBeforeSave, aiAfterSave });
        const savedArticleCount = await articleRowCount(env);
        const savedArticleBody = await articleBody(env);
        check('伺服器其實已建立文章（回應遺失情境成立）', savedArticleCount === articlesBefore + 1, { articlesBefore, savedArticleCount });
        check('雲端文章正文是使用者編輯後的內容', savedArticleBody.includes(editedBody), { body: savedArticleBody.slice(0, 120) });
        const firstArticleIds = await articleIds(env);

        // 重開面板：page-link 也被擋，自動重試失敗 → 待傳仍在（F1 的現場）。
        await context.route('**/vocabulary/page-link', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"code":"capture_failed"}' }));
        await popup.reload();
        await popup.waitForFunction(() => !!document.querySelector('#ext-account-status').textContent, null, { timeout: 30000 });
        await popup.waitForFunction(() => document.querySelectorAll('#ext-workspace-pending-list li').length > 0, null, { timeout: 30000 });
        debug.push({ step: 'after-reload-1', pending: await pendingKeys(popup), notice: await noticeText(popup), aiCalls: env.state.aiCalls });
        check('重開面板後待傳仍在（重試失敗保留）', (await pendingCount(popup)) === 1, await pendingKeys(popup));
        check('重試失敗不會重跑 AI', env.state.aiCalls === aiAfterSave, { aiAfterSave, aiCalls: env.state.aiCalls });

        // F1：重開面板後再按「擷取本頁文章」時，必須從待傳還原原稿並鎖定，
        //     而不是產生第二份可編輯的新稿（那樣的編輯會被「沿用」靜默丟棄）。
        const markRestore = requestLog.length;
        await article.bringToFront();
        await popup.locator('#ext-article-extract').click();
        await popup.locator('#ext-article-preview').waitFor({ state: 'visible', timeout: 60000 });
        await popup.waitForFunction(() => !document.querySelector('#ext-workspace-notice').hidden, null, { timeout: 30000 });
        const lockState = await popup.evaluate(() => ({
            title: document.querySelector('#ext-article-title').value,
            body: document.querySelector('#ext-article-body').value,
            analyzeChecked: document.querySelector('#ext-article-analyze').checked,
            titleDisabled: document.querySelector('#ext-article-title').disabled,
            bodyDisabled: document.querySelector('#ext-article-body').disabled,
            analyzeDisabled: document.querySelector('#ext-article-analyze').disabled,
            saveDisabled: document.querySelector('#ext-article-save').disabled,
            extractDisabled: document.querySelector('#ext-article-extract').disabled,
            pendingHidden: document.querySelector('#ext-workspace-pending').hidden,
            pendingOpen: document.querySelector('#ext-workspace-pending').open,
            pendingItems: document.querySelectorAll('#ext-workspace-pending-list li').length,
            notice: document.querySelector('#ext-workspace-notice').textContent
        }));
        debug.push({ step: 'after-pending-restore', lockState, aiCalls: env.state.aiCalls, requests: requestsSince(markRestore) });
        check('F1：重開面板後仍有待傳時，預覽必須鎖定（標題／正文／分析／儲存都不可用）',
            lockState.titleDisabled && lockState.bodyDisabled && lockState.analyzeDisabled && lockState.saveDisabled && lockState.extractDisabled, lockState);
        check('F1：鎖定時顯示待傳提示（pagePendingLocked 實際可達）', /待传队列/.test(lockState.notice), { notice: lockState.notice });
        check('F1：待傳清單自動展開且仍只有一筆',
            lockState.pendingHidden === false && lockState.pendingOpen === true && lockState.pendingItems === 1, lockState);
        check('F1：還原的是待傳原稿（標題／正文／分析勾選），不是第二份 AI 新稿',
            lockState.title === firstTitle && lockState.body === editedBody && lockState.analyzeChecked === true,
            { title: lockState.title, bodyLength: lockState.body.length, analyzeChecked: lockState.analyzeChecked });
        check('F1：還原待傳時沒有重跑 AI、沒有新增待傳',
            env.state.aiCalls === aiAfterSave && aiRequestsSince(markRestore) === 0 && (await pendingCount(popup)) === 1,
            { aiCalls: env.state.aiCalls, aiRequests: aiRequestsSince(markRestore) });
        // 原流程在此直接 fill 一個 disabled 的 textarea（會 timeout）；改成驗證輸入真的被拒絕。
        const bodyEditable = await popup.locator('#ext-article-body').fill(blockedEdit, { timeout: 1500 }).then(() => true).catch(() => false);
        check('F1：待傳鎖定時輸入框不可編輯（輸入被拒絕，不會出現第二份新稿）', bodyEditable === false
            && (await popup.locator('#ext-article-body').inputValue()) === editedBody);

        // 待傳清單的「取消本機待傳」不得刪掉雲端已保存的內容。
        await applyThenFail(context, env, ALICE, '/vocabulary/books');
        const booksBeforeCancel = await bookCount(env);
        await popup.locator('#ext-book-page').click();
        await popup.waitForFunction(() => document.querySelectorAll('#ext-workspace-pending-list li').length === 2, null, { timeout: 30000 });
        check('建立本頁詞書的回應遺失時也會留下待傳', (await pendingCount(popup)) === 2, await pendingKeys(popup));
        check('伺服器其實已建立本頁詞書', (await bookCount(env)) === booksBeforeCancel + 1, { booksBeforeCancel, now: await bookCount(env) });
        await popup.evaluate(() => { document.querySelector('#ext-workspace-pending').open = true; });
        await popup.locator('#ext-workspace-pending-list li').filter({ hasText: '待建立词书' }).locator('button').last().click();
        await popup.waitForFunction(() => document.querySelectorAll('#ext-workspace-pending-list li').length === 1, null, { timeout: 30000 });
        check('取消待傳只刪本機那一筆', (await pendingCount(popup)) === 1, await pendingKeys(popup));
        check('取消待傳不刪雲端已建立的詞書', (await bookCount(env)) === booksBeforeCancel + 1);
        await context.unroute('**/vocabulary/books');

        // 由待傳列重試：雲端必須保留第一次的正文，且不重跑 AI、不重建文章。
        await context.unroute('**/vocabulary/page-link');
        await context.unroute('**/articles');
        const markRetry = requestLog.length;
        const aiBeforeRetry = env.state.aiCalls;
        await popup.evaluate(() => { document.querySelector('#ext-workspace-pending').open = true; });
        await popup.locator('#ext-workspace-pending-list li').filter({ hasText: '待保存文章' }).locator('button').first().click();
        await popup.waitForFunction(() => document.querySelectorAll('#ext-workspace-pending-list li').length === 0, null, { timeout: 30000 });
        debug.push({ step: 'after-pending-retry', pending: await pendingKeys(popup), notice: await noticeText(popup), aiCalls: env.state.aiCalls, requests: requestsSince(markRetry), body: await articleBody(env) });
        check('由待傳列重試成功後清掉該筆待傳', (await pendingCount(popup)) === 0, await pendingKeys(popup));
        check('重試後雲端保留第一次的正文（第二次編輯沒有蓋掉雲端）',
            (await articleBody(env)).includes(editedBody) && !(await articleBody(env)).includes(blockedEdit));
        check('重試沒有重建文章（仍只有一篇、文章 ID 不變）',
            (await articleRowCount(env)) === articlesBefore + 1 && JSON.stringify(await articleIds(env)) === JSON.stringify(firstArticleIds),
            { ids: await articleIds(env), firstArticleIds });
        check('重試沒有再送 POST /articles', writesSince(markRetry, '/articles') === 0, requestsSince(markRetry));
        check('重試沒有重跑 AI', env.state.aiCalls === aiBeforeRetry && aiRequestsSince(markRetry) === 0,
            { aiBeforeRetry, aiCalls: env.state.aiCalls, aiRequests: aiRequestsSince(markRetry) });
        check('重試走的是 GET ?sourceUrl 與 page-link 補關聯',
            requestsSince(markRetry).some((entry) => entry.method === 'GET' && entry.path.startsWith('/vocabulary/books?sourceUrl='))
            && writesSince(markRetry, '/vocabulary/page-link') === 1, requestsSince(markRetry));
        check('重試成功時介面有提示（沿用既有文章，不是靜默成功）', /沿用/.test(await noticeText(popup)), { notice: await noticeText(popup) });

        // 本頁已無待傳、雲端已有文章：直接顯示既有文章的開啟入口，不再產生「可編輯但存不進去」的預覽。
        const markExisting = requestLog.length;
        const aiBeforeExisting = env.state.aiCalls;
        await article.bringToFront();
        await popup.locator('#ext-article-extract').click();
        // 「開啟入口」在待傳重試成功後就已顯示，因此用「請求序列＋擷取按鈕恢復可用」確認這次擷取真的跑完。
        for (let attempt = 0; attempt < 100; attempt += 1) {
            const seen = requestsSince(markExisting);
            if (seen.some((entry) => entry.method === 'GET' && entry.path.startsWith('/vocabulary/books?sourceUrl='))
                && writesSince(markExisting, '/vocabulary/page-link') === 1
                && await popup.evaluate(() => !document.querySelector('#ext-article-extract').disabled)) break;
            await sleep(100);
        }
        const entryState = await popup.evaluate(() => ({
            previewHidden: document.querySelector('#ext-article-preview').hidden,
            openHidden: document.querySelector('#ext-article-open').hidden,
            openText: document.querySelector('#ext-article-open').textContent,
            notice: document.querySelector('#ext-workspace-notice').textContent
        }));
        debug.push({ step: 'after-existing-article', entryState, aiCalls: env.state.aiCalls, requests: requestsSince(markExisting) });
        check('雲端已有文章時直接顯示既有文章入口（不再產生可編輯預覽）',
            entryState.previewHidden === true && entryState.openHidden === false, entryState);
        check('既有文章入口會說明「已沿用原記錄」', /沿用/.test(entryState.notice), { notice: entryState.notice });
        check('既有文章入口先查 GET ?sourceUrl 再用 page-link 補關聯',
            requestsSince(markExisting).some((entry) => entry.method === 'GET' && entry.path.startsWith('/vocabulary/books?sourceUrl='))
            && writesSince(markExisting, '/vocabulary/page-link') === 1, requestsSince(markExisting));
        check('既有文章入口不跑 AI、不建立文章、不改內容',
            env.state.aiCalls === aiBeforeExisting && aiRequestsSince(markExisting) === 0
            && writesSince(markExisting, '/articles') === 0 && (await articleRowCount(env)) === articlesBefore + 1
            && (await articleBody(env)).includes(editedBody));

        // 觀察（只記錄、不列入需求斷言）：另一個分頁／外部寫入的「同頁待傳」出現時，
        // 目前會不會覆蓋使用者正在編輯、尚未保存的預覽？屬於 F1 的鏡像情境，留給產品決策。
        try {
            const probeUrl = env.base + '/test-article?crossTabProbe=1';
            await article.goto(probeUrl);
            await article.bringToFront();
            await popup.locator('#ext-article-extract').click();
            await popup.locator('#ext-article-preview').waitFor({ state: 'visible', timeout: 60000 });
            await popup.locator('#ext-article-body').fill('正在編輯但尚未保存的正文');
            const injected = await popup.evaluate(async (sourceUrl) => {
                const { captureAuthSession } = await import('./modules/sync-cloudflare.js');
                const { captureScopeKey } = await import('./shared/capture-client.mjs');
                const session = captureAuthSession();
                const requestId = 'workspace_probe_' + crypto.randomUUID();
                const key = 'bdc_workspace_outbox_v1:' + captureScopeKey(session) + ':' + requestId;
                await chrome.storage.local.set({ [key]: {
                    type: 'article', requestId, endpoint: session.endpoint, userId: session.userId,
                    createdAt: new Date().toISOString(),
                    payload: { title: '另一個分頁的標題', body: '# 另一個分頁的標題\n\n另一個分頁的正文', sourceUrl, sourceType: 'url' }
                } });
                return { key: key.slice(-14) };
            }, probeUrl);
            await sleep(1200);
            const probeState = await popup.evaluate(() => ({
                body: document.querySelector('#ext-article-body').value,
                bodyDisabled: document.querySelector('#ext-article-body').disabled,
                notice: document.querySelector('#ext-workspace-notice').textContent,
                pendingItems: document.querySelectorAll('#ext-workspace-pending-list li').length
            }));
            debug.push({ step: 'cross-tab-pending-probe', injected, probeState, aiCalls: env.state.aiCalls });
            // 清掉這筆注入的待傳（走 UI 的「取消本機待傳」）。
            await popup.evaluate(() => { document.querySelector('#ext-workspace-pending').open = true; });
            await popup.locator('#ext-workspace-pending-list li').filter({ hasText: '待保存文章' }).locator('button').last().click();
            await popup.waitForFunction(() => document.querySelectorAll('#ext-workspace-pending-list li').length === 0, null, { timeout: 30000 });
            debug.push({ step: 'cross-tab-pending-probe-cleanup', pending: await pendingCount(popup) });
        } catch (error) {
            debug.push({ step: 'cross-tab-pending-probe', error: String((error && error.message) || error) });
        }

        // 另一筆健康待傳（自訂詞書的回應遺失）：重開面板要能自動重試並清掉，且不重複建立。
        await applyThenFail(context, env, ALICE, '/vocabulary/books');
        const booksBeforeAutoRetry = await bookCount(env);
        await popup.locator('#ext-book-new').click();
        await popup.locator('#ext-book-link-page').uncheck();
        await popup.locator('#ext-book-name').fill('自動重試用的詞書');
        await popup.locator('#ext-book-submit').click();
        await popup.waitForFunction(() => document.querySelectorAll('#ext-workspace-pending-list li').length === 1, null, { timeout: 30000 });
        check('自訂詞書的回應遺失也會留下待傳', (await pendingCount(popup)) === 1, await pendingKeys(popup));
        check('伺服器其實已建立自訂詞書', (await bookCount(env)) === booksBeforeAutoRetry + 1, { booksBeforeAutoRetry, now: await bookCount(env) });
        await context.unroute('**/vocabulary/books');

        // 再重開一次：剩下的待傳會自動重試並清掉。
        await popup.reload();
        await popup.waitForFunction(() => !!document.querySelector('#ext-account-status').textContent, null, { timeout: 30000 });
        let pendingAfterRetry = null;
        for (let attempt = 0; attempt < 60; attempt += 1) {
            pendingAfterRetry = await pendingCount(popup);
            if (pendingAfterRetry === 0) break;
            await sleep(250);
        }
        debug.push({ step: 'after-reload-2', pending: await pendingKeys(popup), notice: await noticeText(popup), aiCalls: env.state.aiCalls, items: await popup.evaluate(() => document.querySelector('#ext-workspace-pending-list').textContent) });
        check('重開面板會自動重試並清掉待傳', pendingAfterRetry === 0, { pendingAfterRetry, debug: debug[debug.length - 1] });
        check('自動重試沒有把詞書建成兩本', (await bookCount(env)) === booksBeforeAutoRetry + 1, { books: await bookCount(env) });
        check('自動重試後文章仍只有一篇、內容不變', (await articleRowCount(env)) === articlesBefore + 1 && (await articleBody(env)).includes(editedBody));

        /* ---------- 7. 登出／帳戶切換 ---------- */
        // 導航到新的 query URL：這才是「真的新頁面」（沒有待傳、雲端也沒有文章），可用來驗證取消 AI。
        await article.goto(env.base + '/test-article?logoutProbe=1');
        check('登出前：分頁已換到新 query URL（真新頁面）', new URL(article.url()).searchParams.get('logoutProbe') === '1', { url: article.url() });
        await article.bringToFront();
        await popup.locator('#ext-article-extract').click();
        await popup.locator('#ext-article-preview').waitFor({ state: 'visible', timeout: 60000 });
        check('換頁後可建立新的可編輯預覽（登出前置條件成立）', (await popup.locator('#ext-article-body').inputValue()).length > 0);
        await popup.locator('#ext-article-body').fill('登出前留在輸入框的內容');
        // 讓 AI 慢下來，才能觀察「登出時取消 AI」。
        await context.route('**/mock-ai/**', async (route) => {
            await sleep(1200);
            await route.continue().catch(() => {});
        });
        const markLogout = requestLog.length;
        await popup.locator('#ext-article-extract').click();
        await popup.waitForFunction(() => !document.querySelector('#ext-article-cancel').hidden, null, { timeout: 30000 }).catch(() => {});
        await sleep(200);
        await popup.locator('#ext-logout-btn').click();
        await popup.waitForFunction(() => /未登录账户/.test(document.querySelector('#ext-account-status').textContent), null, { timeout: 30000 });
        await sleep(2500);
        const afterLogout = await popup.evaluate(() => ({
            previewHidden: document.querySelector('#ext-article-preview').hidden,
            cancelHidden: document.querySelector('#ext-article-cancel').hidden,
            bodyResidue: document.querySelector('#ext-article-body').value,
            notice: document.querySelector('#ext-workspace-notice').textContent,
            noticeHidden: document.querySelector('#ext-workspace-notice').hidden,
            pendingHidden: document.querySelector('#ext-workspace-pending').hidden
        }));
        debug.push({ step: 'after-logout', afterLogout, requests: requestsSince(markLogout) });
        check('登出後隱藏文章預覽', afterLogout.previewHidden === true);
        check('登出後沒有殘留的進行中任務（取消按鈕消失）', afterLogout.cancelHidden === true);
        check('登出後不顯示取消造成的錯誤', !/分析失败|請求失敗|请求失败/.test(afterLogout.notice), { notice: afterLogout.notice });
        check('登出後清空輸入框（不殘留上一個帳戶的文章）', afterLogout.bodyResidue.length === 0, { length: afterLogout.bodyResidue.length });
        check('登出後清掉待傳清單顯示', afterLogout.pendingHidden === true);
        check('登出時的取消 AI 沒有在雲端留下文章', (await articleRowCount(env)) === articlesBefore + 1, { articles: await articleRowCount(env) });
        await context.unroute('**/mock-ai/**');

        // 登入另一個帳戶：不得看到前一個帳戶的預覽或待傳。
        await connect(popup, base, env, BOB);
        await popup.waitForFunction(() => document.querySelector('#ext-account-status').textContent.includes('bob'), null, { timeout: 30000 });
        const afterSwitch = await popup.evaluate(() => ({
            previewHidden: document.querySelector('#ext-article-preview').hidden,
            bodyResidue: document.querySelector('#ext-article-body').value,
            pendingHidden: document.querySelector('#ext-workspace-pending').hidden,
            pendingItems: document.querySelectorAll('#ext-workspace-pending-list li').length
        }));
        check('切換帳戶後預覽仍為隱藏', afterSwitch.previewHidden === true);
        check('切換帳戶後看不到上一個帳戶的待傳', afterSwitch.pendingHidden === true && afterSwitch.pendingItems === 0, afterSwitch);
        check('切換帳戶後輸入框仍是空的', afterSwitch.bodyResidue.length === 0, { length: afterSwitch.bodyResidue.length });
        check('流程中沒有未捕獲的擴充套件頁面錯誤', popupErrors.length === 0, popupErrors);

        // 原分頁換頁後，舊 ticket 必須失效（不得再讀取新頁面）。
        await article.goto(env.base + '/test-article?other=1');
        const stale = await openEmbedded(article, base + '/lookup.html?embedded=1&ticket=' + encodeURIComponent(ticket), 'after-nav');
        await stale?.waitForLoadState().catch(() => {});
        const staleSnapshot = stale ? await frameSnapshot(stale) : { error: 'frame missing' };
        check('原分頁換頁後舊 ticket 失效', staleSnapshot.text === INLINE_UNAVAILABLE_ZH_CN, staleSnapshot);
        await article.screenshot({ path: path.join(OUT, 'article-page.png'), fullPage: false });
    } catch (error) {
        process.exitCode = 1;
        checks.push({ name: 'execution', ok: false, detail: error.stack });
        console.error(error.stack);
    } finally {
        if (context) await context.close();
        if (env) await env.close();
        fs.rmSync(profile, { recursive: true, force: true });
        fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({
            checks, errors, consoles, badResponses, debug, hashes, realMV3: true, realWorkerSQLite: true, aiMocked: true, stamp
        }, null, 2));
        console.log(JSON.stringify({ passed: checks.filter((item) => item.ok).length, failed: checks.filter((item) => !item.ok).length, output: OUT }));
    }
})();
