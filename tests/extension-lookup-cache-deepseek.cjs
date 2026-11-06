// 獨立驗收（DeepSeek）：0.6.3 本機查詞快取直讀 + 常駐重查圖示。
//
// 真 MV3 擴充（chromium --load-extension）、真 Worker + SQLite
// （tests/helpers/extension-mv3.cjs），只有 AI 傳輸與外部網頁是本地 mock。
// 不修改任何產品檔或他人測試；只斷言下列六個重點：
//   1. 關窗再開／頁面刷新時，同步／詞書請求被按住仍先顯示本機答案，AI 次數不增。
//   2. managed 頁重開（無 memory 共享 Key）可讀舊答案；cacheOnly 不得授權傳輸、
//      不得繞過 catalog／binding 驗證、不得持久化共享 Key。
//   3. 同詞但 sentence／context／thinking／model／上游 URL／帳戶／locale 不共用快取。
//   4. 登出／401／切帳戶與遲到的回應不顯示前一帳戶的結果。
//   5. 重查圖示在成功／失敗後都留在原位可點；強制一次 AI，下一次普通查詞回到新快取。
//   6. zh-CN／zh-HK 文案、320px 幾何、aria label，加入按鈕仍保存當前意思。
//
// 執行：PLAYWRIGHT_MODULE=<path-to-playwright> node tests/extension-lookup-cache-deepseek.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { environment, ALICE, BOB, ADMIN } = require('./helpers/extension-mv3.cjs');

const ROOT = path.resolve(__dirname, '..');
const STAMP = process.env.LOOKUP_DEEPSEEK_STAMP || '20261107020359525';
const OUT = path.join(ROOT, 'docs/report/assets', STAMP + '_lookup-cache-deepseek');
// 與 helpers/extension-mv3.cjs 發佈到 managed catalog 的共享 Key 相同；
// 只用來證明它沒有被擴充持久化，不會出現在任何斷言輸出。
const MANAGED_KEY = 'test-only-extension-key';
const checks = [];
const errors = [];
const timings = [];
const notes = [];

function check(name, value, detail) {
    checks.push({ name, ok: !!value, ...(detail === undefined ? {} : { detail }) });
    console.log(`${value ? 'PASS' : 'FAIL'} ${name}`);
    assert.ok(value, name + (detail === undefined ? '' : ': ' + JSON.stringify(detail)));
}
function note(text) {
    notes.push(text);
    console.log('NOTE ' + text);
}
const since = (start) => Date.now() - start;

async function openCard(page, base, word = 'plunge', timing = null) {
    await page.bringToFront();
    await page.waitForSelector('bdc-page-lookup');
    const rect = await page.evaluate((word) => {
        getSelection().removeAllRanges();
        const node = document.querySelector('#article').firstChild;
        const start = node.textContent.indexOf(word);
        const range = document.createRange(); range.setStart(node, start); range.setEnd(node, start + word.length);
        const r = range.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
    }, word);
    await page.mouse.move(rect.x + 1, rect.y + rect.height / 2); await page.mouse.down();
    await page.mouse.move(rect.x + rect.width - 1, rect.y + rect.height / 2, { steps: 8 }); await page.mouse.up();
    const cdp = await page.context().newCDPSession(page);
    let buttonBox;
    for (let attempt = 0; attempt < 80 && !buttonBox; attempt += 1) {
        const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
        const candidates = [];
        function visit(node) {
            if (node.nodeName === 'BUTTON' && !node.attributes?.includes('bdc-assistant-ball')) candidates.push(node);
            for (const child of [...node.children || [], ...node.shadowRoots || []]) visit(child);
        }
        visit(root);
        for (const node of candidates) {
            const model = await cdp.send('DOM.getBoxModel', { backendNodeId: node.backendNodeId }).catch(() => null);
            if (model?.model.width > 8 && model.model.height > 8) { buttonBox = model.model.border; break; }
        }
        if (!buttonBox) await page.waitForTimeout(40);
    }
    assert.ok(buttonBox, 'actual selection button exists in closed shadow root');
    await page.mouse.click((buttonBox[0] + buttonBox[4]) / 2, (buttonBox[1] + buttonBox[5]) / 2);
    await cdp.detach();
    for (let n = 0; n < 120; n += 1) {
        const frame = page.frames().find((f) => f.url().startsWith(base + '/lookup.html'));
        if (frame) {
            if (timing) timing.appearedAt = Date.now();
            return frame;
        }
        await page.waitForTimeout(40);
    }
    throw new Error('No actual extension frame');
}
async function waitForResult(frame, timeout = 20000) {
    await frame.waitForFunction(() => {
        const box = document.querySelector('#ext-result-box');
        const meaning = document.querySelector('#ext-result-meaning')?.textContent?.trim();
        return !!meaning && box && !box.classList.contains('hidden');
    }, null, { timeout });
    return (await frame.locator('#ext-result-meaning').textContent()).trim();
}
async function waitForNoResult(frame, timeout = 8000) {
    await frame.waitForFunction(() => {
        const box = document.querySelector('#ext-result-box');
        const meaning = document.querySelector('#ext-result-meaning')?.textContent?.trim();
        return !meaning || (box && box.classList.contains('hidden'));
    }, null, { timeout });
}
async function closeCard(page, base) {
    const frame = page.frames().find((f) => f.url().startsWith(base + '/lookup.html'));
    if (!frame) return;
    await frame.locator('#ext-inline-close').click().catch(() => {});
    for (let n = 0; n < 150 && page.frames().some((f) => f.url().startsWith(base + '/lookup.html')); n += 1) await page.waitForTimeout(20);
    assert.ok(!page.frames().some((f) => f.url().startsWith(base + '/lookup.html')), 'inline frame closed');
}

// 測試側觀察器：記錄重查狀態機與帳戶／儲存事件，用於定位「點了卻沒有任何反應」。
async function armTrace(frame) {
    await frame.evaluate(() => {
        window.__trace = [];
        const record = (label) => window.__trace.push([Math.round(performance.now()), label,
            document.querySelector('#ext-inline-retry').disabled,
            document.querySelector('#ext-inline-retry').getAttribute('aria-busy'),
            document.querySelector('#ext-result-box').classList.contains('hidden') ? 'box-hidden' : 'box-open']);
        const options = { attributes: true, childList: true, subtree: true, characterData: true };
        new MutationObserver(() => record('retry')).observe(document.querySelector('#ext-inline-retry'), options);
        new MutationObserver(() => record('box')).observe(document.querySelector('#ext-result-box'), options);
        new MutationObserver(() => record('meaning')).observe(document.querySelector('#ext-result-meaning'), options);
        new MutationObserver(() => record('notice')).observe(document.querySelector('#ext-lookup-notice'), options);
        window.addEventListener('bdc:auth-change', (event) => record('auth:' + (event?.detail?.event || '')));
        window.addEventListener('storage', (event) => record('storage:' + event.key));
        document.addEventListener('bdc:locale-change', () => record('locale-change'));
        record('arm');
    });
}
const readTrace = (frame) => frame.evaluate(() => window.__trace);

// 詞卡外殼會在小窗／彈窗模式切換後重新量測高度並移動 iframe；若在移動完成前
// 用座標點擊，點擊會落到 iframe 之外。測試側等外框連續兩次量測一致再點。
// 外殼使用 CLOSED shadow root，頁面層 locator 取不到 iframe；改用 frame.frameElement()。
async function settleFrame(page) {
    const frame = page.frames().find((item) => item !== page.mainFrame() && item.url().includes('/lookup.html'));
    if (!frame) return null;
    const iframe = await frame.frameElement();
    let previous = '';
    let stable = 0;
    for (let i = 0; i < 80; i += 1) {
        const box = await iframe.boundingBox().catch(() => null);
        const current = JSON.stringify(box);
        stable = box && current === previous ? stable + 1 : 0;
        if (stable >= 3) { await page.waitForTimeout(120); return box; }
        previous = current;
        await page.waitForTimeout(70);
    }
    return null;
}
// 真滑鼠點擊常駐重查圖示；若外殼在點擊瞬間仍在移動 iframe 而錯過，
// trace 不會出現任何新紀錄，重新量測後再點（不會重複觸發查詞）。
async function clickRetry(page, frame) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        await settleFrame(page);
        await armTrace(frame);
        await frame.locator('#ext-inline-retry').click();
        const fired = await frame.waitForFunction(() => window.__trace.length > 1, null, { timeout: 2500 })
            .then(() => true).catch(() => false);
        if (fired) return true;
        note('重查圖示點擊落空（外殼移動中），重新量測後再點一次');
    }
    return false;
}
const frameBox = async (page) => {
    const frame = page.frames().find((item) => item !== page.mainFrame() && item.url().includes('/lookup.html'));
    return frame ? (await frame.frameElement()).boundingBox().catch(() => null) : null;
};

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    execFileSync(process.execPath, ['scripts/package-extension.mjs'], { cwd: ROOT });
    const env = await environment();
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-lookup-deepseek-'));
    let context, popup;
    // --- network instrumentation -------------------------------------------------
    let hold = false;                 // hold every non-AI request (sync/catalog/books/captures)
    let holdAi = false;               // hold AI responses (late-response scenario)
    let failAi = false;               // every AI request fails at transport until cleared
    let failNextAi = false;           // next AI request fails at transport
    let credential401Once = false;    // next managed credential download answers 401
    let breakBindingOnce = false;     // next managed credential download has a wrong binding
    const releases = new Set();
    const aiReleases = new Set();
    const heldPaths = new Set();
    let heldCount = 0;
    let aiAttempts = 0;
    let aiHeld = 0;
    const net = { credential: 0, catalog: 0, heldDuringCacheRead: 0, credentialDuringCacheRead: 0, alt: [], capture: 0 };
    let credentialMark = 0, catalogMark = 0, aiMark = 0;
    function releaseAll() { hold = false; for (const release of releases) release(); releases.clear(); }
    function releaseAi() { holdAi = false; for (const release of aiReleases) release(); aiReleases.clear(); }
    function markNetwork() { credentialMark = net.credential; catalogMark = net.catalog; aiMark = env.state.aiCalls; heldCount = 0; heldPaths.clear(); }

    const aiPayload = (meaning) => JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ word: 'x', analysis: { meaning, phonetic: 'plʌndʒ', pos: 'verb', role: 'mock' } }) } }] });

    try {
        context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
            viewport: { width: 1100, height: 800 },
            args: [`--disable-extensions-except=${ROOT}/extension`, `--load-extension=${ROOT}/extension`] });
        context.on('page', (p) => p.on('pageerror', (e) => errors.push(e.message)));
        await context.route(env.base + '/**', async (route) => {
            const url = new URL(route.request().url());
            const p = url.pathname;
            if (p.startsWith('/mock-ai/') || p.startsWith('/mock-ai-alt/')) {
                aiAttempts += 1;
                if (holdAi) { aiHeld += 1; await new Promise((resolve) => aiReleases.add(resolve)); }
                if (failAi || failNextAi) { failNextAi = false; return route.fulfill({ status: 503, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: '{"error":{"message":"mock AI failure"}}' }); }
                if (p.startsWith('/mock-ai-alt/')) {
                    net.alt.push(url.href);
                    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
                        body: aiPayload('upstream-alt-answer-' + net.alt.length) });
                }
                const response = await route.fetch();
                const data = await response.json();
                const content = data?.choices?.[0]?.message?.content;
                if (typeof content === 'string') {
                    try {
                        const parsed = JSON.parse(content);
                        const meaning = 'deepseek-answer-' + env.state.aiCalls;
                        if (parsed.analysis) parsed.analysis.meaning = meaning;
                        if (parsed.meaning) parsed.meaning = meaning;
                        data.choices[0].message.content = JSON.stringify(parsed);
                    } catch (_) {}
                }
                return route.fulfill({ response, json: data });
            }
            if (/^\/ai-catalog\/providers\/[^/]+\/credential$/.test(p)) {
                net.credential += 1;
                if (credential401Once) {
                    credential401Once = false;
                    return route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"unauthorized"}' });
                }
                if (breakBindingOnce) {
                    breakBindingOnce = false;
                    const response = await route.fetch();
                    const data = await response.json();
                    if (data?.binding) data.binding = { ...data.binding, apiUrl: 'https://evil.invalid/v1' };
                    return route.fulfill({ response, json: data });
                }
            }
            if (p === '/ai-catalog') net.catalog += 1;
            if (p === '/captures') net.capture += 1;
            if (hold) { heldCount += 1; heldPaths.add(p); await new Promise((resolve) => releases.add(resolve)); }
            return route.continue().catch(() => {});
        });
        const articleHtml = '<!doctype html><title>Lookup cache article</title><article><h1>Lookup cache article</h1><p id="article">Major tech stocks plunge as investors worry. Markets remain volatile.</p></article>';
        await context.route('https://lookup-deepseek-*.example/**', (route) => route.fulfill({ contentType: 'text/html', body: articleHtml }));
        const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
        const base = 'chrome-extension://' + new URL(worker.url()).host;

        // --- popup: login alice -------------------------------------------------
        async function openPopup() {
            const page = await context.newPage();
            await page.goto(base + '/lookup.html');
            await page.waitForFunction(() => !!document.querySelector('#ext-account-status')?.textContent);
            return page;
        }
        // 等擴充自己的初始化（含 catalog 驗證）完成，才在頁面內呼叫 runtime；
        // 這段等待不會下載 managed 共享 Key（快取讀取與傳輸驗證是分開的）。
        async function readyPopup() {
            const page = await openPopup();
            await page.waitForFunction(() => globalThis.__bdcExtensionRuntime?.getExtensionReadiness?.().taskResolution.status === 'ready',
                null, { timeout: 30000 });
            return page;
        }
        async function openSettings(p) {
            if (!await p.locator('#ext-settings-dialog').evaluate((node) => node.open)) await p.locator('#ext-settings-open').click();
            await p.waitForFunction(() => document.querySelector('#ext-settings-dialog')?.open);
        }
        async function closeSettings(p) {
            await p.locator('#ext-settings-close').click();
            await p.waitForFunction(() => !document.querySelector('#ext-settings-dialog')?.open);
        }
        async function openAccount(p) {
            const open = await p.locator('#ext-account-details').evaluate((node) => node.open);
            if (!open) await p.locator('#ext-account-summary').click();
            await p.waitForFunction(() => document.querySelector('#ext-account-details')?.open === true);
        }
        async function login(p, token, expected) {
            await openSettings(p);
            await openAccount(p);
            await p.locator('#ext-endpoint-input').fill(env.base);
            await p.locator('#ext-login-mode').selectOption('token');
            await p.locator('#ext-token-input').fill(token);
            await p.locator('#ext-connect-btn').click();
            await p.waitForFunction((expected) => !document.querySelector('#ext-connect-btn').disabled
                && document.querySelector('#ext-account-status').textContent.includes(expected), expected, { timeout: 30000 });
            await p.waitForFunction(() => globalThis.__bdcExtensionRuntime?.getExtensionReadiness?.().taskResolution.status === 'ready',
                null, { timeout: 30000 });
            await closeSettings(p);
        }

        popup = await openPopup();
        await popup.evaluate(() => chrome.storage.local.set({ bdc_extension_assistant_enabled: false }));
        await login(popup, ALICE, 'alice');

        // =========================================================================
        // (1) 關窗再開 / 頁面刷新：同步請求被按住仍先顯示本機答案，AI 次數不增
        // =========================================================================
        const article = await context.newPage();
        await article.goto('https://lookup-deepseek-one.example/article');
        let frame = await openCard(article, base);
        let firstMeaning = await waitForResult(frame);
        const cardQuery = await frame.evaluate(() => ({
            text: document.querySelector('#ext-word-input')?.value || '',
            sentence: document.querySelector('#ext-sentence-input')?.value || '',
            context: document.querySelector('#ext-context-input')?.value || ''
        }));
        const firstAiCalls = env.state.aiCalls;
        check('(1) 首次查詞真的呼叫一次 AI、結果未標成快取', firstAiCalls === 1 && await frame.locator('#ext-result-cache').isHidden(),
            { aiCalls: env.state.aiCalls, meaning: firstMeaning });
        check('(1) 首次結果出現後常駐重查圖示可見且可點', await frame.locator('#ext-inline-retry').isVisible()
            && !await frame.locator('#ext-inline-retry').isDisabled());
        await closeCard(article, base);

        // 重開前先把 popup 關掉：詞卡是新的 iframe 文件，模組記憶體（含共享 Key 快取）全清。
        await popup.close();
        popup = null;
        hold = true; markNetwork();
        let started = Date.now();
        const reopenTiming = {};
        frame = await openCard(article, base, 'plunge', reopenTiming);
        firstMeaning = await waitForResult(frame, 5000);
        const reopenElapsed = since(started);
        const reopenLocal = Date.now() - reopenTiming.appearedAt;
        timings.push({ scenario: 'reopen-held-network', totalMs: reopenElapsed, frameToResultMs: reopenLocal,
            held: heldCount, heldPaths: [...heldPaths], holdStillActive: hold });
        const reopenBadge = await frame.locator('#ext-result-cache').isVisible();
        const reopenHeld = heldCount;
        const reopenPaths = [...heldPaths];
        check('(1) 關窗後重開：同步／詞書請求仍被按住時，詞卡出現後 1.5 秒內已顯示本機結果',
            hold && reopenLocal < 1500 && reopenBadge, timings.at(-1));
        check('(1) 關窗後重開命中：真的按住了非 AI 請求，AI 次數不變', reopenHeld > 0 && hold && env.state.aiCalls === firstAiCalls,
            { held: reopenHeld, paths: reopenPaths, aiCalls: env.state.aiCalls, holdStillActive: hold });
        net.heldDuringCacheRead = reopenHeld;
        net.credentialDuringCacheRead = net.credential - credentialMark;
        const catalogDelta = net.catalog - catalogMark;
        // 命中後會「背景」同步帳戶（可能重拉 catalog），但必須仍在被按住的狀態下就已顯示答案。
        check('(1) 命中期間沒有下載 managed Key；背景同步仍在被按住時答案已顯示',
            net.credentialDuringCacheRead === 0 && hold && (catalogDelta === 0 || reopenPaths.includes('/ai-catalog')),
            { credential: net.credentialDuringCacheRead, catalogDelta, heldPaths: reopenPaths, holdStillActive: hold });
        note(`命中後背景同步：catalog 請求 ${catalogDelta} 次（${catalogDelta && reopenPaths.includes('/ai-catalog') ? '已送出但被按住' : '未送出'}），共享 Key 下載 0 次`);
        check('(1) 命中內容就是第一次的成功結果（非空、非錯誤）', firstMeaning.startsWith('deepseek-answer-1'), { meaning: firstMeaning });
        releaseAll();
        await closeCard(article, base);

        // 刷新原網頁（content script 與 iframe 全部重建）
        await article.reload();
        hold = true; markNetwork();
        started = Date.now();
        const reloadTiming = {};
        frame = await openCard(article, base, 'plunge', reloadTiming);
        const reloadMeaning = await waitForResult(frame, 5000);
        const reloadLocal = Date.now() - reloadTiming.appearedAt;
        timings.push({ scenario: 'reload-held-network', totalMs: since(started), frameToResultMs: reloadLocal,
            held: heldCount, heldPaths: [...heldPaths], holdStillActive: hold });
        check('(1) 頁面刷新後仍在網絡被按住時直讀本機、沒有重跑 AI', hold && reloadLocal < 1500
            && await frame.locator('#ext-result-cache').isVisible()
            && env.state.aiCalls === firstAiCalls && reloadMeaning === firstMeaning, timings.at(-1));
        releaseAll();

        // =========================================================================
        // (2) managed 頁重開無 memory 共享 Key；cacheOnly 不授權傳輸、不繞過驗證
        // =========================================================================
        const probe = await (async () => {
            const p = await readyPopup();
            const value = await p.evaluate(async ({ MANAGED_KEY, cardQuery }) => {
                const models = await import('./modules/ai-models.js');
                const api = await import('./modules/api.js');
                const spec = 'managed-capture:capture-model';
                let syncError = '';
                let sync = null;
                try { sync = models.resolveAIRequestConfig({ task: 'articleWordTranslation', model: spec, cacheOnly: true }); }
                catch (error) { syncError = error.code || error.message; }
                const asyncCfg = await models.resolveAIRequestConfigAsync({ task: 'articleWordTranslation', model: spec, cacheOnly: true });
                const real = await api.getCachedLookupSelection({ ...cardQuery });
                const guessed = await api.getCachedLookupSelection({ text: 'plunge', sentence: 'Major tech stocks plunge as investors worry.' });
                return {
                    syncError,
                    syncApiKey: sync?.apiKey ?? null,
                    syncRequiresManagedCredential: sync?.requiresManagedCredential ?? null,
                    asyncApiKeyIsSharedKey: asyncCfg.apiKey === MANAGED_KEY,
                    asyncRequiresManagedCredential: asyncCfg.requiresManagedCredential,
                    cacheReadWorks: !!real,
                    cacheReadFromCache: real?.fromCache === true,
                    cacheReadMeaning: real?.meaning || null,
                    guessedInputHit: !!guessed,
                    cardQuery
                };
            }, { MANAGED_KEY, cardQuery }).catch((error) => ({ error: error.message }));
            await p.close();
            return value;
        })();
        note('詞卡實際查詞輸入：' + JSON.stringify(cardQuery));
        check('(2) cacheOnly 只讀公開 metadata：不返回共享 Key、不聲稱需要憑證',
            probe.syncApiKey === '' && probe.syncRequiresManagedCredential === false, probe);
        check('(2) resolveAIRequestConfigAsync 強制 cacheOnly:false，傳輸前仍取得並驗證共享 Key',
            probe.asyncApiKeyIsSharedKey === true && probe.asyncRequiresManagedCredential === true, probe);
        check('(2) 新頁面（無 memory 共享 Key）仍能從本機讀到舊答案',
            probe.cacheReadWorks && probe.cacheReadFromCache && probe.cacheReadMeaning === firstMeaning, probe);

        const persisted = await (async () => {
            const p = await readyPopup();
            const value = await p.evaluate(async (MANAGED_KEY) => {
                const hits = [];
                const local = await chrome.storage.local.get(null);
                if (JSON.stringify(local).includes(MANAGED_KEY)) hits.push('chrome.storage.local');
                const session = await chrome.storage.session.get(null);
                if (JSON.stringify(session).includes(MANAGED_KEY)) hits.push('chrome.storage.session');
                if (JSON.stringify(Object.fromEntries(Object.entries(localStorage))).includes(MANAGED_KEY)) hits.push('localStorage');
                if (JSON.stringify(Object.fromEntries(Object.entries(sessionStorage))).includes(MANAGED_KEY)) hits.push('sessionStorage');
                const databases = await indexedDB.databases();
                for (const info of databases) {
                    const records = await new Promise((resolve) => {
                        const request = indexedDB.open(info.name);
                        request.onerror = () => resolve([]);
                        request.onsuccess = () => {
                            const db = request.result;
                            const names = [...db.objectStoreNames];
                            if (!names.length) { db.close(); return resolve([]); }
                            const tx = db.transaction(names, 'readonly');
                            const out = [];
                            let left = names.length;
                            for (const name of names) {
                                const all = tx.objectStore(name).getAll();
                                all.onsuccess = () => { out.push(...all.result); if (--left === 0) resolve(out); };
                                all.onerror = () => { if (--left === 0) resolve(out); };
                            }
                        };
                    });
                    if (JSON.stringify(records).includes(MANAGED_KEY)) hits.push('idb:' + info.name);
                }
                return { hits, databases: databases.map((info) => info.name) };
            }, MANAGED_KEY).catch((error) => ({ error: error.message }));
            await p.close();
            return value;
        })();
        check('(2) 共享 Key 沒有被擴充持久化（storage / localStorage / IndexedDB 均無）',
            Array.isArray(persisted.hits) && persisted.hits.length === 0, persisted);
        note('擴充可見的 IndexedDB：' + JSON.stringify(persisted.databases || []));

        // 強制重查：仍要下載並驗證共享憑證，binding 不符則不得發出 AI 請求
        const credentialBeforeForce = net.credential;
        const aiBeforeForce = env.state.aiCalls;
        await (async () => {
            const p = await readyPopup();
            breakBindingOnce = true;
            // 真正走擴充 runtime 的傳輸路徑：cacheOnly 不得讓它跳過憑證／binding 驗證
            const result = await p.evaluate(async () => {
                const runtime = globalThis.__bdcExtensionRuntime;
                try {
                    await runtime.runExtensionLookup({ text: 'plunge', sentence: 'Major tech stocks plunge as investors worry.', noCache: true });
                    return { ok: true };
                } catch (error) { return { ok: false, code: error.code, message: error.message }; }
            }).catch((error) => ({ ok: false, code: 'evaluate_failed', message: error.message }));
            await p.close();
            check('(2) 共享憑證 binding 不符時，強制查詞被拒且不發出 AI 請求',
                result.ok === false && result.code === 'managed_binding_mismatch' && net.credential > credentialBeforeForce
                && env.state.aiCalls === aiBeforeForce, { result, credentialDelta: net.credential - credentialBeforeForce, aiCalls: env.state.aiCalls });
        })();

        // =========================================================================
        // (5) 重查圖示成功／失敗後常駐；強制一次 AI，下一次普通查詞回到新快取
        // =========================================================================
        await closeCard(article, base);
        frame = await openCard(article, base);
        const hitMeaning = await waitForResult(frame);
        const hitBadge = await frame.locator('#ext-result-cache').isVisible();
        failAi = true;
        const aiBeforeFailure = env.state.aiCalls;
        const failedClick = await clickRetry(article, frame);
        const noticeShown = await frame.waitForFunction(() => {
            const notice = document.querySelector('#ext-lookup-notice');
            const inlineNotice = document.querySelector('#ext-inline-lookup-notice');
            return (notice && !notice.classList.contains('hidden') && !!notice.textContent.trim())
                || (inlineNotice && !inlineNotice.hidden && !!inlineNotice.textContent.trim());
        }, null, { timeout: 25000 }).then(() => true).catch(() => false);
        const failedState = await frame.evaluate(() => ({
            meaning: document.querySelector('#ext-result-meaning')?.textContent?.trim() || '',
            boxHidden: document.querySelector('#ext-result-box')?.classList.contains('hidden') ?? true,
            retryVisible: !document.querySelector('#ext-inline-retry').hidden,
            retryDisabled: document.querySelector('#ext-inline-retry').disabled,
            cacheBadgeHidden: document.querySelector('#ext-result-cache').hidden,
            lookupNotice: document.querySelector('#ext-lookup-notice')?.textContent?.trim() || '',
            lookupNoticeHidden: document.querySelector('#ext-lookup-notice')?.classList.contains('hidden'),
            inlineNotice: document.querySelector('#ext-inline-lookup-notice')?.textContent?.trim() || '',
            inlineNoticeHidden: document.querySelector('#ext-inline-lookup-notice')?.hidden,
            status: document.querySelector('#ext-inline-status')?.textContent?.trim() || '',
            busy: document.querySelector('#ext-inline-retry')?.getAttribute('aria-busy')
        }));
        failAi = false;
        const failureNotice = failedState.lookupNotice || failedState.inlineNotice;
        note('重查失敗狀態：' + JSON.stringify({ noticeShown, failedState, aiAttempts }));
        const failedBadgeVisible = await frame.locator('#ext-result-cache').isVisible();
        check('(5) 重查失敗：顯示錯誤、清空舊結果，重查圖示仍留在原位可點',
            failedClick && noticeShown && hitBadge && failedState.retryVisible && !failedState.retryDisabled && failedState.boxHidden
            && failedState.meaning === '' && !failedBadgeVisible && env.state.aiCalls === aiBeforeFailure,
            { hitMeaning, failureNotice, failedState, failedBadgeVisible, aiCalls: env.state.aiCalls, aiAttempts });
        const beforeRetry = env.state.aiCalls;
        const retryClick = await clickRetry(article, frame);
        const retryMeaning = await waitForResult(frame);
        check('(5) 重查圖示成功後強制發出一次 AI 並更新結果',
            retryClick && env.state.aiCalls === beforeRetry + 1 && retryMeaning !== hitMeaning && retryMeaning.startsWith('deepseek-answer-'),
            { aiCalls: env.state.aiCalls, hitMeaning, retryMeaning });
        const forceCheckboxGone = await frame.locator('#ext-force-refresh').count() === 0;
        check('(5) 重查成功後圖示仍在，且沒有把預設查詞改成永久略過快取',
            await frame.locator('#ext-inline-retry').isVisible()
            && (forceCheckboxGone || !await frame.locator('#ext-force-refresh').isChecked()), { forceCheckboxGone });
        await closeCard(article, base);
        frame = await openCard(article, base);
        const afterRetryMeaning = await waitForResult(frame);
        check('(5) 下一次普通查詞回到強制重查後的新快取（AI 次數不增）',
            env.state.aiCalls === beforeRetry + 1 && afterRetryMeaning === retryMeaning && await frame.locator('#ext-result-cache').isVisible(),
            { aiCalls: env.state.aiCalls, meaning: afterRetryMeaning });

        // =========================================================================
        // (6) zh-CN / zh-HK、320px 幾何、aria label、加入按鈕保存當前意思
        // =========================================================================
        await article.setViewportSize({ width: 320, height: 650 });
        const geometry = {};
        for (const locale of ['zh-HK', 'zh-CN']) {
            const aiBefore = env.state.aiCalls;
            // 語系切換必須在詞卡自己的設定彈窗內完成：popup 改語系不會即時傳進既有 iframe。
            await frame.locator('#ext-inline-settings').click();
            await frame.waitForFunction(() => document.querySelector('#ext-settings-dialog')?.open);
            await frame.locator('#ext-locale-select').selectOption(locale);
            await frame.locator('#ext-settings-close').click();
            await frame.waitForFunction(() => !document.querySelector('#ext-settings-dialog')?.open);
            await frame.waitForFunction(() => !document.querySelector('#ext-inline-retry').disabled, null, { timeout: 15000 });
            const attemptsBefore = aiAttempts;
            const boxBefore = await frameBox(article);
            const clicked = await clickRetry(article, frame);
            const boxAfter = await frameBox(article);
            if (JSON.stringify(boxBefore) !== JSON.stringify(boxAfter)) note(`locale ${locale} 點擊前後 iframe 位移：` + JSON.stringify({ boxBefore, boxAfter }));
            const meaning = await waitForResult(frame, 25000).catch(async (error) => {
                note(`locale ${locale} trace：` + JSON.stringify(await readTrace(frame)));
                const diag = await frame.evaluate(() => ({
                    lang: document.documentElement.lang,
                    bodyClass: document.body.className,
                    retryHidden: document.querySelector('#ext-inline-retry').hidden,
                    retryDisabled: document.querySelector('#ext-inline-retry').disabled,
                    retryBusy: document.querySelector('#ext-inline-retry').getAttribute('aria-busy'),
                    settingsOpen: !!document.querySelector('#ext-settings-dialog')?.open,
                    notice: document.querySelector('#ext-lookup-notice')?.textContent?.trim() || '',
                    inlineNotice: document.querySelector('#ext-inline-lookup-notice')?.textContent?.trim() || '',
                    status: document.querySelector('#ext-inline-status')?.textContent?.trim() || '',
                    empty: document.querySelector('#ext-result-empty')?.textContent?.trim() || '',
                    word: document.querySelector('#ext-word-input')?.value || ''
                }));
                note(`locale ${locale} 重查無結果：` + JSON.stringify({ diag, aiAttemptsDelta: aiAttempts - attemptsBefore, error: error.message }));
                return '';
            });
            // 外殼要等詞卡回報高度才會把 iframe 撐開；記錄追上內容所需時間。
            const fitStart = Date.now();
            const fitted = await frame.waitForFunction(() => {
                const retry = document.querySelector('#ext-inline-retry').getBoundingClientRect();
                return retry.bottom <= window.innerHeight + 1;
            }, null, { timeout: 3000 }).then(() => true).catch(() => false);
            const fitMs = Date.now() - fitStart;
            const measure = await frame.evaluate(() => {
                const ids = ['ext-capture-save', 'ext-book-settings', 'ext-inline-retry'];
                return {
                    width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
                    innerHeight, bodyHeight: Math.ceil(document.body.getBoundingClientRect().height),
                    buttons: ids.map((id) => {
                        const node = document.getElementById(id);
                        const rect = node.getBoundingClientRect();
                        return { id, x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height),
                            bottom: Math.round(rect.bottom), clipped: rect.bottom > innerHeight + 1,
                            label: node.getAttribute('aria-label'), title: node.title, text: node.textContent.trim(), visible: !node.hidden && !node.disabled };
                    }),
                    badge: document.querySelector('#ext-result-cache')?.textContent?.trim()
                };
            });
            geometry[locale] = { ...measure, meaning, aiDelta: env.state.aiCalls - aiBefore };
            const sameRow = Math.max(...measure.buttons.map((b) => b.y)) - Math.min(...measure.buttons.map((b) => b.y)) < 3;
            const nothingClipped = fitted && measure.buttons.every((button) => !button.clipped);
            geometry[locale].fit = { fitted, fitMs };
            check(`(6) ${locale}：收藏列三顆控制項同一行、加入為短按鈕、320px 無水平溢出且不被裁切`,
                sameRow && measure.buttons[0].width < 100 && measure.scrollWidth <= measure.width && nothingClipped,
                { sameRow, nothingClipped, fitted, fitMs, save: measure.buttons[0], source: measure.buttons[1], retry: measure.buttons[2],
                    scroll: [measure.scrollWidth, measure.width], heights: [measure.innerHeight, measure.bodyHeight] });
            const expectedRetryLabel = locale === 'zh-HK' ? '重新查詞（略過快取）' : '重新查词（跳过缓存）';
            const expectedSaveLabel = locale === 'zh-HK' ? '加入詞書' : '加入词书';
            const expectedAddText = '加入';
            check(`(6) ${locale}：重查圖示有本地化 aria label，加入按鈕保留完整 aria label`,
                measure.buttons[2].label === expectedRetryLabel && measure.buttons[2].title === expectedRetryLabel
                && measure.buttons[0].label === expectedSaveLabel && measure.buttons[0].text === expectedAddText,
                { retryLabel: measure.buttons[2].label, saveLabel: measure.buttons[0].label, saveText: measure.buttons[0].text });
            const badgeVisibleAfterForce = await frame.locator('#ext-result-cache').isVisible();
            check(`(6) ${locale}：強制重查得到新結果（未標成快取），命中標記文案已本地化`,
                clicked && meaning.length > 0 && !badgeVisibleAfterForce
                && measure.badge === (locale === 'zh-HK' ? '本機快取' : '本机缓存'),
                { meaning, badge: measure.badge, badgeVisibleAfterForce });
            await settleFrame(article);
            await article.waitForTimeout(400);
            await article.screenshot({ path: path.join(OUT, `compact-320-${locale}.png`) });
            // 同語系重開詞卡：應命中剛才產生的快取，標記顯示且不再呼叫 AI
            await closeCard(article, base);
            frame = await openCard(article, base);
            const reopenMeaning = await waitForResult(frame);
            check(`(6) ${locale}：重開詞卡命中該語系快取、命中標記顯示、AI 次數不增`,
                reopenMeaning === meaning && await frame.locator('#ext-result-cache').isVisible()
                && env.state.aiCalls === aiBefore + 1,
                { meaning, reopenMeaning, aiCalls: env.state.aiCalls, aiBefore });
        }
        // 加入按鈕保存當前意思（zh-CN 最後一輪）
        const capturedMeaning = geometry['zh-CN'].meaning;
        const capturesBefore = env.state.captureCalls.length;
        await frame.waitForFunction(() => !document.querySelector('#ext-capture-save').disabled);
        await frame.locator('#ext-capture-save').click();
        await frame.waitForFunction(() => {
            const button = document.querySelector('#ext-capture-save');
            return button.textContent.trim() === '已加入';
        }, null, { timeout: 25000 });
        const savedEntry = env.db.prepare("SELECT entity_id, data_json FROM reading_entities WHERE owner_user_id='alice' AND entity_type='vocabularyEntry'").all();
        check('(6) 加入按鈕保存的是當前顯示的意思',
            env.state.captureCalls.length === capturesBefore + 1 && savedEntry.length > 0
            && savedEntry.some((row) => String(row.data_json).includes(capturedMeaning)),
            { capturedMeaning, entries: savedEntry.length, lastCapture: env.state.captureCalls.at(-1)?.word || null });
        await article.setViewportSize({ width: 1100, height: 800 });
        await closeCard(article, base);

        // =========================================================================
        // (3) 同詞不同 sentence / context / thinking / model / 上游 / locale / 帳戶
        // =========================================================================
        const isolation = await (async () => {
            const p = await readyPopup();
            const value = await p.evaluate(async () => {
                const api = await import('./modules/api.js');
                const base = { text: 'volatile', sentence: 'Markets remain volatile today.', context: 'finance' };
                const first = await api.lookupSelection({ ...base });
                const same = await api.getCachedLookupSelection({ ...base });
                const otherSentence = await api.getCachedLookupSelection({ ...base, sentence: 'Markets remain volatile tomorrow.' });
                const otherContext = await api.getCachedLookupSelection({ ...base, context: 'weather' });
                const otherLocale = await api.getCachedLookupSelection({ ...base, locale: 'zh-HK' });
                const otherThinking = await api.getCachedLookupSelection({ ...base, thinking: 'high' });
                const thinkingLookup = await api.lookupSelection({ ...base, thinking: 'high' });
                const thinkingHit = await api.getCachedLookupSelection({ ...base, thinking: 'high' });
                const originalAgain = await api.getCachedLookupSelection({ ...base });
                const noSentence = await api.getCachedLookupSelection({ text: 'volatile' });
                return {
                    first: { meaning: first.meaning, fromCache: first.fromCache, thinking: first.thinking, provider: first.provider, model: first.model },
                    same: { meaning: same?.meaning, fromCache: same?.fromCache },
                    otherSentence: otherSentence?.meaning ?? null,
                    otherContext: otherContext?.meaning ?? null,
                    otherLocale: otherLocale?.meaning ?? null,
                    otherThinking: otherThinking?.meaning ?? null,
                    thinkingLookup: { meaning: thinkingLookup.meaning, thinking: thinkingLookup.thinking },
                    thinkingHit: thinkingHit?.meaning ?? null,
                    originalAgain: originalAgain?.meaning ?? null,
                    noSentence: noSentence?.meaning ?? null
                };
            }).catch((error) => ({ error: error.message, stack: error.stack }));
            await p.close();
            return value;
        })();
        check('(3) 完全相同的輸入命中同一筆快取', isolation.first?.fromCache === false
            && isolation.same?.fromCache === true && isolation.same?.meaning === isolation.first?.meaning, isolation);
        check('(3) 同詞不同 sentence / context / thinking 都不串快取',
            isolation.otherSentence === null && isolation.otherContext === null && isolation.otherThinking === null
            && isolation.thinkingHit === isolation.thinkingLookup?.meaning
            && isolation.thinkingHit !== isolation.first?.meaning
            && isolation.originalAgain === isolation.first?.meaning, isolation);
        check('(3) 同詞不同 locale 與無原句（不同 task 鏈）不串快取',
            isolation.otherLocale === null && isolation.noSentence === null, isolation);

        // 上游 URL／模型：發佈第二版 catalog（同供應商同模型、不同 apiUrl；另加第二個模型）
        const current = await (await fetch(env.base + '/ai-catalog', { headers: { Authorization: 'Bearer ' + ALICE } })).json();
        const tasks = Object.fromEntries(['wordAnalysis', 'articleWordTranslation', 'articlePhraseTranslation', 'articleCleanup', 'articleParagraphTranslation', 'assistant']
            .map((task) => [task, { providerId: 'managed-capture', model: 'capture-model' }]));
        const publish = await fetch(env.base + '/admin/ai-catalog/publish', {
            method: 'POST', headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ baseVersion: Number(current.version) || 0, mutationId: 'deepseek-upstream-change', config: { schemaVersion: 1, providers: [{
                id: 'managed-capture', name: 'Capture Test', enabled: true, order: 0, format: 'openai-chat',
                apiUrl: env.base + '/mock-ai-alt/v1/chat/completions', modelsUrl: env.base + '/mock-ai-alt/v1/models',
                authMode: 'bearer', models: [{ id: 'capture-model' }, { id: 'capture-model-2' }]
            }], tasks }, keyOps: { 'managed-capture': { action: 'replace', apiKey: MANAGED_KEY } } })
        });
        const published = await publish.json();
        check('(3) 第二版 catalog（同模型不同上游 URL）發佈成功', publish.status === 200 && Number(published.version) > Number(current.version), published);

        const upstream = await (async () => {
            const p = await readyPopup();
            const value = await p.evaluate(async () => {
                const runtime = globalThis.__bdcExtensionRuntime;
                const api = await import('./modules/api.js');
                await runtime.syncExtensionAccountAI();
                const base = { text: 'volatile', sentence: 'Markets remain volatile today.', context: 'finance' };
                const stale = await api.getCachedLookupSelection({ ...base });
                const otherModelCache = await api.getCachedLookupSelection({ ...base, model: 'managed-capture:capture-model-2' });
                const refreshed = await api.lookupSelection({ ...base });
                const otherModel = await api.lookupSelection({ ...base, model: 'managed-capture:capture-model-2' });
                const otherModelHit = await api.getCachedLookupSelection({ ...base, model: 'managed-capture:capture-model-2' });
                return {
                    stale: stale?.meaning ?? null,
                    otherModelCache: otherModelCache?.meaning ?? null,
                    refreshed: { meaning: refreshed.meaning, model: refreshed.model, provider: refreshed.provider },
                    otherModel: { meaning: otherModel.meaning, model: otherModel.model },
                    otherModelHit: otherModelHit?.meaning ?? null
                };
            }).catch((error) => ({ error: error.message }));
            await p.close();
            return value;
        })();
        check('(3) 換上游 URL（同 provider/模型）後舊答案不再命中，並改打新上游',
            upstream.stale === null && /^upstream-alt-answer-/.test(upstream.refreshed?.meaning || '') && net.alt.length >= 1,
            { upstream, altCalls: net.alt.length });
        check('(3) 同供應商另一個模型不共用快取', upstream.otherModelCache === null
            && upstream.otherModelHit === upstream.otherModel?.meaning, upstream);

        // =========================================================================
        // (4) 登出、401、切換帳戶與遲到回應不顯示前一帳戶結果
        // =========================================================================
        const lateFramePage = await context.newPage();
        await lateFramePage.goto('https://lookup-deepseek-two.example/article');
        frame = await openCard(lateFramePage, base);
        const beforeLate = await waitForResult(frame);
        const latePopup = await openPopup();
        holdAi = true;
        aiHeld = 0;
        const lateClicked = await clickRetry(lateFramePage, frame);
        for (let n = 0; n < 200 && aiHeld === 0; n += 1) await lateFramePage.waitForTimeout(50);
        note('遲到回應場景：AI 請求是否被按住 = ' + aiHeld);
        if (aiHeld === 0) note('遲到回應場景診斷：' + JSON.stringify({
            state: await frame.evaluate(() => ({
                notice: document.querySelector('#ext-lookup-notice')?.textContent?.trim() || '',
                retryDisabled: document.querySelector('#ext-inline-retry').disabled,
                status: document.querySelector('#ext-inline-status')?.textContent?.trim() || '',
                readiness: globalThis.__bdcExtensionRuntime?.getExtensionReadiness?.()?.taskResolution
            })),
            trace: await readTrace(frame)
        }));
        const inFlight = aiHeld > 0;
        await openSettings(latePopup);
        await openAccount(latePopup);
        await latePopup.locator('#ext-logout-btn').click();
        await latePopup.waitForFunction(() => /未|not|登录|登入/i.test(document.querySelector('#ext-account-status').textContent) || document.querySelector('#ext-account-status').textContent.trim() === '', null, { timeout: 20000 }).catch(() => {});
        releaseAi();
        await lateFramePage.waitForTimeout(1500);
        const lateState = await frame.evaluate(() => ({
            meaning: document.querySelector('#ext-result-meaning')?.textContent?.trim() || '',
            boxHidden: document.querySelector('#ext-result-box')?.classList.contains('hidden') ?? true,
            notice: document.querySelector('#ext-lookup-notice')?.textContent?.trim() || '',
            status: document.querySelector('#ext-inline-status')?.textContent?.trim() || ''
        }));
        check('(4) 查詞途中登出，遲到的回應不會顯示前一帳戶結果',
            lateClicked && inFlight && lateState.meaning === '' && lateState.boxHidden, { lateState, beforeLate, inFlight });
        const aiAfterLogout = env.state.aiCalls;
        await closeSettings(latePopup).catch(() => {});
        await latePopup.close();
        await closeCard(lateFramePage, base);
        // 登出後即使本機仍有舊答案，也不得直接顯示
        const loggedOut = await openCard(lateFramePage, base);
        await loggedOut.waitForFunction(() => {
            const status = document.querySelector('#ext-inline-status');
            return (status && !status.hidden && status.textContent.trim()) || document.querySelector('#ext-result-meaning')?.textContent?.trim();
        }, null, { timeout: 15000 }).catch(() => {});
        const loggedOutState = await loggedOut.evaluate(() => ({
            meaning: document.querySelector('#ext-result-meaning')?.textContent?.trim() || '',
            status: document.querySelector('#ext-inline-status')?.textContent?.trim() || '',
            statusHidden: document.querySelector('#ext-inline-status')?.hidden ?? true
        }));
        check('(4) 登出後重開詞卡不會從本機讀出前一帳戶答案，也沒有新增 AI 請求',
            loggedOutState.meaning === '' && env.state.aiCalls === aiAfterLogout, { loggedOutState, aiCalls: env.state.aiCalls });
        await closeCard(lateFramePage, base);

        // 切換帳戶（alice → bob）：同詞不得沿用 alice 的答案
        const bob = await openPopup();
        await login(bob, BOB, 'bob');
        const bobIsolation = await (async () => {
            const value = await bob.evaluate(async () => {
                const api = await import('./modules/api.js');
                const base = { text: 'volatile', sentence: 'Markets remain volatile today.', context: 'finance' };
                const cached = await api.getCachedLookupSelection({ ...base });
                const fresh = await api.lookupSelection({ ...base });
                return { cached: cached?.meaning ?? null, fresh: fresh.meaning, fromCache: fresh.fromCache };
            }).catch((error) => ({ error: error.message }));
            return value;
        })();
        check('(4) 切換帳戶後同一詞不串前一帳戶快取，重新查得新答案',
            bobIsolation.cached === null && bobIsolation.fromCache === false && bobIsolation.fresh !== isolation.first?.meaning,
            { bobIsolation, alice: isolation.first?.meaning });

        // 401：共享憑證下載被服務端拒絕
        const authPage = await context.newPage();
        await authPage.goto('https://lookup-deepseek-three.example/article');
        frame = await openCard(authPage, base);
        const bobMeaning = await waitForResult(frame);
        // 換一個乾淨的文件（記憶體憑證全清），先用本機快取命中，再讓強制重查遇到 401。
        await closeCard(authPage, base);
        await authPage.reload();
        credential401Once = true;
        frame = await openCard(authPage, base);
        const bobCached = await waitForResult(frame);
        const bobCachedBadge = await frame.locator('#ext-result-cache').isVisible();
        const aiBefore401 = env.state.aiCalls;
        const authClicked = await clickRetry(authPage, frame);
        const notice401 = await frame.waitForFunction(() => {
            const notice = document.querySelector('#ext-lookup-notice');
            return notice && !notice.classList.contains('hidden') && !!notice.textContent.trim();
        }, null, { timeout: 20000 }).then(() => true).catch(() => false);
        await frame.waitForTimeout(300);
        const after401 = await frame.evaluate(() => ({
            meaning: document.querySelector('#ext-result-meaning')?.textContent?.trim() || '',
            notice: document.querySelector('#ext-lookup-notice')?.textContent?.trim() || '',
            inlineNotice: document.querySelector('#ext-inline-lookup-notice')?.textContent?.trim() || '',
            inlineNoticeHidden: document.querySelector('#ext-inline-lookup-notice')?.hidden ?? true,
            status: document.querySelector('#ext-inline-status')?.textContent?.trim() || '',
            statusHidden: document.querySelector('#ext-inline-status')?.hidden ?? true,
            boxHidden: document.querySelector('#ext-result-box')?.classList.contains('hidden') ?? true
        }));
        const visibleHint401 = !!(after401.notice || (!after401.inlineNoticeHidden && after401.inlineNotice)
            || (!after401.statusHidden && after401.status));
        check('(4) 共享憑證 401 時不顯示舊答案、不發出 AI 請求，且有可見提示',
            authClicked && after401.meaning === '' && after401.boxHidden && env.state.aiCalls === aiBefore401 && visibleHint401,
            { after401, notice401, visibleHint401, authClicked, aiCalls: env.state.aiCalls, bobMeaning, bobCached, bobCachedBadge });
        note('401 後的提示來源：' + JSON.stringify({ notice: after401.notice, inlineNotice: after401.inlineNotice,
            inlineNoticeHidden: after401.inlineNoticeHidden, status: after401.status, statusHidden: after401.statusHidden }));
        check('(4) 401 之前的本機命中不需要憑證下載',
            bobCached === bobMeaning && bobCachedBadge, { bobCached, bobMeaning, bobCachedBadge });
        await closeCard(authPage, base);

        await bob.close();
        await authPage.close();

        check('(0) 整個流程沒有未捕獲的 JavaScript 例外', errors.length === 0, errors);
    } finally {
        releaseAll(); releaseAi();
        try {
            fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ stamp: STAMP, engine: 'chromium MV3', checks, timings, notes, errors,
                aiCalls: env?.state?.aiCalls, credentialDownloads: net.credential, catalogFetches: net.catalog,
                alternates: net.alt, heldDuringCacheRead: net.heldDuringCacheRead }, null, 2));
        } catch (error) { console.error('write results failed', error); }
        await context?.close().catch(() => {});
        await env?.close().catch(() => {});
        fs.rmSync(profile, { recursive: true, force: true });
    }
})().catch((error) => { console.error(error); process.exitCode = 1; });
