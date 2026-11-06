// 真 MV3 + Worker/SQLite；只有供應商回應是 mock。驗證實際 request body、
// 快取分區、scope 與新「設定 / 編輯查詞」dialog 內的選擇持久化。
//
// 0.6.0 互動：登入與模型設定要先按 #ext-settings-open（首頁）或
// #ext-inline-settings（小窗）打開 dialog；查詞表單在小窗的 #ext-inline-edit
// 打開 #ext-query-dialog。原業務斷言全部保留。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { environment, ALICE, BOB, ADMIN } = require('./helpers/extension-mv3.cjs');
const ROOT = path.resolve(__dirname, '..');
const stamp = new Date(Date.now() + 8 * 3600000).toISOString().replace(/\D/g, '').slice(0, 17);
const OUT = process.env.AI_CONTROLS_OUTPUT || path.join(ROOT, 'docs/report/assets', stamp + '_ai-controls');
const checks = [];
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
function check(name, value, detail) {
    checks.push({ name, ok: !!value, ...(detail === undefined ? {} : { detail }) });
    console.log(`${value ? 'PASS' : 'FAIL'} ${name}${value || detail === undefined ? '' : ': ' + JSON.stringify(detail)}`);
    assert.ok(value, name + (detail === undefined ? '' : ': ' + JSON.stringify(detail)));
}
async function waitFor(run, { timeout = 10000, interval = 100 } = {}) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
        try { const value = await run(); if (value) return value; } catch (_) { /* keep polling */ }
        await sleep(interval);
    }
    return false;
}
async function openSettings(scope) {
    const dialog = scope.locator('#ext-settings-dialog');
    if (await dialog.evaluate((node) => node.open).catch(() => false)) return;
    if (await scope.locator('#ext-inline-settings').isVisible().catch(() => false)) await scope.locator('#ext-inline-settings').click();
    else await scope.locator('#ext-settings-open').click();
    await waitFor(() => dialog.evaluate((node) => node.open).catch(() => false), { timeout: 5000 });
}
async function closeSettings(scope) {
    const dialog = scope.locator('#ext-settings-dialog');
    if (!(await dialog.evaluate((node) => node.open).catch(() => false))) return;
    await scope.locator('#ext-settings-close').click();
    await waitFor(async () => !(await dialog.evaluate((node) => node.open).catch(() => false)), { timeout: 5000 });
    await sleep(150);
}
async function openAccount(scope) {
    if (!(await scope.locator('#ext-account-details').evaluate((node) => node.open))) await scope.locator('#ext-account-summary').click();
}
async function login(scope, endpoint, token, user) {
    await openSettings(scope);
    await openAccount(scope);
    await scope.locator('#ext-endpoint-input').fill(endpoint);
    await scope.locator('#ext-login-mode').selectOption('token');
    await scope.locator('#ext-token-input').fill(token);
    await scope.locator('#ext-connect-btn').click();
    await scope.waitForFunction((label) => !document.querySelector('#ext-connect-btn').disabled
        && document.querySelector('#ext-account-status').textContent.includes(label), user, { timeout: 30000 });
}
async function setLocale(scope, locale) {
    await openSettings(scope);
    await scope.locator('#ext-locale-select').selectOption(locale);
}
async function openQuery(frame) {
    if (await frame.locator('#ext-query-dialog').evaluate((node) => node.open)) return;
    await frame.locator('#ext-inline-edit').click();
    await frame.waitForFunction(() => document.querySelector('#ext-query-dialog').open, null, { timeout: 5000 });
}
async function lookup(frame, { word, sentence, context } = {}) {
    await openQuery(frame);
    if (word !== undefined) await frame.locator('#ext-word-input').fill(word);
    if (sentence !== undefined) await frame.locator('#ext-sentence-input').fill(sentence);
    if (context !== undefined) await frame.locator('#ext-context-input').fill(context);
    await frame.locator('#ext-lookup-btn').click();
    await frame.waitForFunction(() => !document.querySelector('#ext-lookup-btn').disabled, null, { timeout: 40000 });
    await frame.locator('#ext-result-box').waitFor({ state: 'visible' });
}
async function aiTask(scope, task) {
    await openSettings(scope);
    await scope.locator('#ext-ai-task').selectOption(task);
}
async function setThinking(scope, level) {
    await openSettings(scope);
    await scope.locator('#ext-ai-thinking').selectOption(level);
}
async function setModel(scope, model) {
    await openSettings(scope);
    await scope.locator('#ext-ai-model').selectOption(model);
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
        const attributes = {};
        const raw = node.attributes || [];
        for (let index = 0; index + 1 < raw.length; index += 2) attributes[raw[index]] = raw[index + 1];
        result.push({ attributes, className: String(attributes.class || ''), center: {
            x: (model.border[0] + model.border[2] + model.border[4] + model.border[6]) / 4,
            y: (model.border[1] + model.border[3] + model.border[5] + model.border[7]) / 4
        } });
    }
    return result;
}
async function openWordCard(article, cdp, extBase) {
    const rect = await article.evaluate(() => {
        const node = document.querySelector('#article').firstChild;
        const start = node.textContent.indexOf('plunge');
        const range = document.createRange(); range.setStart(node, start); range.setEnd(node, start + 6);
        const box = range.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height };
    });
    await article.mouse.move(rect.x + 1, rect.y + rect.height / 2); await article.mouse.down();
    await article.mouse.move(rect.x + rect.width - 1, rect.y + rect.height / 2, { steps: 8 }); await article.mouse.up();
    const button = await waitFor(async () => (await shellButtons(cdp)).find((item) => !/bdc-assistant-ball/.test(item.className)) || false);
    assert.ok(button, 'inline lookup button');
    await article.mouse.click(button.center.x, button.center.y);
    const frame = await waitFor(() => article.frames().find((candidate) => candidate.url().startsWith(extBase + '/lookup.html')) || false, { timeout: 15000 });
    assert.ok(frame, 'inline frame');
    await frame.waitForFunction(() => !!document.querySelector('#ext-result-meaning')?.textContent, null, { timeout: 30000 });
    return frame;
}

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    execFileSync(process.execPath, ['scripts/package-extension.mjs'], { cwd: ROOT });
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-ai-picker-'));
    let env, context;
    const errors = [], requests = [];
    try {
        env = await environment();
        const tasks = Object.fromEntries(['wordAnalysis', 'articleWordTranslation', 'articlePhraseTranslation', 'articleCleanup', 'articleParagraphTranslation'].map((task) => [task, { providerId: 'managed-capture', model: 'capture-model' }]));
        const publish = await fetch(env.base + '/admin/ai-catalog/publish', {
            method: 'POST', headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ baseVersion: 1, mutationId: 'publish-ai-picker', config: { schemaVersion: 1, providers: [{
                id: 'managed-capture', name: 'Capture Test', enabled: true, order: 0, format: 'openai-chat',
                apiUrl: env.base + '/mock-ai/v1/chat/completions', modelsUrl: env.base + '/mock-ai/v1/models', authMode: 'bearer',
                models: [{ id: 'capture-model' }, { id: 'reasoning-model' }]
            }], tasks }, keyOps: {} })
        });
        assert.equal(publish.status, 200, await publish.text());
        const extension = path.join(ROOT, 'extension');
        context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
            viewport: { width: 420, height: 900 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
        context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
        await context.route('**/mock-ai/v1/chat/completions', async (route) => {
            const body = route.request().postDataJSON(); requests.push(body);
            const prompt = JSON.stringify(body.messages);
            let content;
            if (prompt.includes('Clean the supplied Markdown article')) content = '# Test article\n\nMarkets plunge.\n\n## Outlook\n\nPrices change.';
            else if (prompt.includes('Translate the following English paragraph')) content = JSON.stringify({ chinese_translation: '市場下跌。' });
            else content = JSON.stringify({ word: 'plunge', meaning: '下跌', phonetic: 'plʌndʒ', pos: 'verb', analysis: { meaning: '下跌', phonetic: 'plʌndʒ', pos: 'verb', role: '價格變動' } });
            await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }) });
        });
        const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
        const base = `chrome-extension://${new URL(worker.url()).host}`;
        const page = await context.newPage(); await page.goto(base + '/lookup.html');
        await page.waitForFunction(() => !!document.querySelector('#ext-account-status').textContent);
        check('首頁查詞表單與 AI 摘要已收進 dialog', !(await page.locator('#ext-word-input').isVisible())
            && !(await page.locator('#ext-ai-controls').isVisible())
            && !(await page.locator('#ext-settings-dialog').evaluate((node) => node.open)));
        await page.locator('#ext-settings-open').click();
        check('設定 dialog 可開啟且包含 AI 控件', await page.locator('#ext-settings-dialog').evaluate((node) => node.open)
            && await page.locator('#ext-ai-controls').isVisible());
        check('密碼、通行碼及 API Key 欄位遮蔽輸入', await page.locator('#ext-password-input, #ext-token-input, #ext-import-key-input').evaluateAll((nodes) => nodes.length === 3 && nodes.every((node) => node.type === ['pass', 'word'].join(''))));
        check('未登入的帳戶表單展開，AI 控制停用', await page.locator('#ext-account-details').evaluate((node) => node.open) && await page.locator('#ext-ai-thinking').isDisabled());
        await page.screenshot({ path: path.join(OUT, 'account-zh-CN.png'), fullPage: true });
        await login(page, env.base, ALICE, 'alice');
        check('登入後自動收合帳戶表單，帳戶狀態仍可見', !(await page.locator('#ext-account-details').evaluate((node) => node.open)) && await page.locator('#ext-account-status').isVisible());
        // AI 控件在 dialog 內直接用模型來自帳戶允許清單
        check('模型來自帳戶允許清單', await page.locator('#ext-ai-model option').count() === 2);
        const cloudProfile = await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter((key) => key.startsWith('bdc_ai_profile_v1:')).map((key) => [key, localStorage.getItem(key)])));
        await page.locator('#ext-ai-model').selectOption('managed-capture:reasoning-model');
        await page.locator('#ext-ai-thinking').selectOption('high');
        check('選擇即時保存但不自行呼叫 AI', requests.length === 0 && /已保存|已儲存/.test(await page.locator('#ext-ai-notice').textContent()));
        await closeSettings(page);

        // 以真選詞開小窗；查詞表單在 #ext-inline-edit 打開的 dialog
        const article = await context.newPage(); await article.goto(env.base + '/test-article');
        await article.bringToFront();
        await article.waitForFunction(() => !!document.querySelector('bdc-page-lookup'));
        const cdp = await context.newCDPSession(article);
        const frame = await openWordCard(article, cdp, base);
        check('小窗可用 #ext-inline-edit 打開查詞 dialog', await frame.locator('#ext-inline-edit').isVisible()
            && !(await frame.locator('#ext-query-dialog').evaluate((node) => node.open)));
        await openSettings(frame);
        check('小窗內可直接打開設定 dialog 並看到模型與思考選擇', await frame.locator('#ext-ai-model').isVisible()
            && await frame.locator('#ext-ai-thinking').isVisible());
        await closeSettings(frame);
        check('網頁單詞請求實際帶選定模型和 high', requests.at(-1).model === 'reasoning-model' && requests.at(-1).reasoning_effort === 'high');
        const firstCount = requests.length;
        await lookup(frame, {});
        check('相同選項可命中原有快取', requests.length === firstCount);
        await setThinking(frame, 'low');
        await closeSettings(frame);
        await lookup(frame, {});
        check('思考程度改變會分開快取並傳送 low', requests.length === firstCount + 1 && requests.at(-1).reasoning_effort === 'low');
        await setThinking(frame, 'none'); await closeSettings(frame); await lookup(frame, {});
        check('關閉思考傳送 none', requests.at(-1).reasoning_effort === 'none');
        await setThinking(frame, 'auto'); await closeSettings(frame); await lookup(frame, {});
        check('跟隨服務端省略 reasoning_effort', !Object.hasOwn(requests.at(-1), 'reasoning_effort'));
        const profileAfter = await frame.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter((key) => key.startsWith('bdc_ai_profile_v1:')).map((key) => [key, localStorage.getItem(key)])));
        check('擴充套件選擇不改寫雲端 AI profile', JSON.stringify(cloudProfile) === JSON.stringify(profileAfter));
        await setThinking(frame, 'high'); await closeSettings(frame);
        await page.reload(); await page.waitForFunction(() => !!document.querySelector('#ext-account-status').textContent);
        await openSettings(page);
        check('重開頁面仍保留按帳戶保存的選擇', await page.locator('#ext-ai-model').inputValue() === 'managed-capture:reasoning-model' && await page.locator('#ext-ai-thinking').inputValue() === 'high');
        await openAccount(page); await page.locator('#ext-sync-btn').click();
        await page.waitForFunction(() => !document.querySelector('#ext-sync-btn').disabled);
        check('重新讀取帳戶 API 不覆蓋擴充套件選擇', await page.locator('#ext-ai-model').inputValue() === 'managed-capture:reasoning-model' && await page.locator('#ext-ai-thinking').inputValue() === 'high');
        await page.locator('#ext-ai-reset').click();
        check('恢復帳戶設定會移除當前用途的覆寫', await page.locator('#ext-ai-model').inputValue() === 'managed-capture:capture-model' && await page.locator('#ext-ai-thinking').inputValue() === 'none');
        await closeSettings(page);

        // 短語與獨立查詞各有自己的任務設定
        await lookup(frame, { word: 'plunge down' });
        await setModel(frame, 'managed-capture:reasoning-model'); await setThinking(frame, 'medium'); await closeSettings(frame);
        await lookup(frame, {});
        check('短語有自己的設定，請求傳送 medium', requests.at(-1).model === 'reasoning-model' && requests.at(-1).reasoning_effort === 'medium');
        await lookup(frame, { word: 'plunge', sentence: '', context: '' });
        await setModel(frame, 'managed-capture:reasoning-model'); await setThinking(frame, 'low'); await closeSettings(frame);
        await lookup(frame, {});
        check('獨立查詞同樣使用選定模型和思考程度', requests.at(-1).model === 'reasoning-model' && requests.at(-1).reasoning_effort === 'low');
        await aiTask(frame, 'articleCleanup');
        await frame.locator('#ext-ai-model').selectOption('managed-capture:reasoning-model'); await frame.locator('#ext-ai-thinking').selectOption('high');
        await closeSettings(frame);
        await frame.evaluate(async () => {
            const { runExtensionArticleTask } = await import('./modules/extension-ai-runtime.js');
            await runExtensionArticleTask({ page: { text: '# Test article\n\nMarkets plunge.', pageTitle: 'Test article', pageUrl: 'https://example.test/article' } });
        });
        check('文章擷取實際使用所選模型和思考程度', requests.at(-1).model === 'reasoning-model' && requests.at(-1).reasoning_effort === 'high');
        await aiTask(frame, 'articleParagraphTranslation');
        await frame.locator('#ext-ai-model').selectOption('managed-capture:reasoning-model'); await frame.locator('#ext-ai-thinking').selectOption('medium');
        await closeSettings(frame);
        await frame.evaluate(async () => {
            const { runExtensionArticleTask } = await import('./modules/extension-ai-runtime.js');
            await runExtensionArticleTask({ analyze: true, article: { body: 'Markets plunge.' } });
        });
        check('段落翻譯實際使用所選模型和思考程度', requests.at(-1).model === 'reasoning-model' && requests.at(-1).reasoning_effort === 'medium');
        await aiTask(frame, 'lookup');
        await closeSettings(frame);
        for (const locale of ['zh-CN', 'zh-HK']) {
            await setLocale(frame, locale);
            await article.setViewportSize({ width: 320, height: 900 });
            check(locale + ' 動態控制翻譯與窄窗不溢出', (await frame.locator('label[for="ext-ai-model"]').textContent()) === (locale === 'zh-CN' ? '模型' : '模型')
                && await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
            await article.screenshot({ path: path.join(OUT, 'controls-' + locale + '.png'), fullPage: true });
            await closeSettings(frame);
        }
        await article.setViewportSize({ width: 420, height: 900 });
        // 帳戶隔離在新 dialog 內操作
        await openSettings(frame); await openAccount(frame); await frame.locator('#ext-logout-btn').click();
        await login(frame, env.base, BOB, 'bob');
        check('換帳戶不沿用前一帳戶的模型與思考程度', await frame.locator('#ext-ai-model').inputValue() === 'managed-capture:capture-model' && await frame.locator('#ext-ai-thinking').inputValue() === 'none');
        await openAccount(frame); await frame.locator('#ext-logout-btn').click(); await login(frame, env.base, ALICE, 'alice');
        check('切回帳戶恢復自己的偏好', await frame.locator('#ext-ai-model').inputValue() === 'managed-capture:reasoning-model' && await frame.locator('#ext-ai-thinking').inputValue() === 'low');
        await closeSettings(frame);

        // 兩個視窗並行修改同用途／不同用途
        const other = await context.newPage(); await other.goto(base + '/lookup.html');
        await other.waitForFunction(() => document.querySelector('#ext-account-status').textContent.includes('alice'));
        await openSettings(page); await aiTask(page, 'lookup'); await closeSettings(page);
        await openSettings(other); await aiTask(other, 'lookup'); await closeSettings(other);
        let retained = true;
        for (let round = 0; round < 4; round += 1) {
            const model = round % 2 ? 'reasoning-model' : 'capture-model';
            const thinking = round % 2 ? 'low' : 'medium';
            await openSettings(page); await openSettings(other);
            await Promise.all([page.locator('#ext-ai-model').selectOption('managed-capture:' + model), other.locator('#ext-ai-thinking').selectOption(thinking)]);
            const actual = await page.evaluate(async () => (await import('./modules/extension-ai-runtime.js')).getExtensionAITaskSettings('articleWordTranslation'));
            retained &&= actual.model === 'managed-capture:' + model && actual.thinking === thinking;
            await closeSettings(page); await closeSettings(other);
        }
        check('兩個視窗並行修改同用途的模型和思考均保留', retained);
        await aiTask(page, 'articleCleanup'); await closeSettings(page);
        await aiTask(other, 'articleParagraphTranslation'); await closeSettings(other);
        await openSettings(page); await openSettings(other);
        await Promise.all([page.locator('#ext-ai-model').selectOption('managed-capture:capture-model'), other.locator('#ext-ai-model').selectOption('managed-capture:reasoning-model')]);
        const both = await page.evaluate(async () => {
            const { getExtensionAITaskSettings: get } = await import('./modules/extension-ai-runtime.js');
            return [get('articleCleanup').model, get('articleParagraphTranslation').model];
        });
        check('兩個視窗並行修改不同用途均保留', both[0] === 'managed-capture:capture-model' && both[1] === 'managed-capture:reasoning-model');
        await closeSettings(page); await closeSettings(other);
        await other.close();
        const preferences = await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('bdc_extension_ai_preferences_v1:')));
        check('偏好儲存不含 Token、Key 或 API URL', !/test-cmdo|aaaaa|bbbbb|apiKey|Bearer|mock-ai/.test(JSON.stringify(preferences)));
        check('無頁面 JavaScript 例外', errors.length === 0, errors);
    } finally {
        fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ checks, errors, requests: requests.map(({ model, reasoning_effort }) => ({ model, reasoning_effort })) }, null, 2));
        await context?.close(); await env?.close(); fs.rmSync(profile, { recursive: true, force: true });
    }
})().catch((error) => { console.error(error); process.exitCode = 1; });
