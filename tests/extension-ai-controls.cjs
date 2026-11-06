// Real MV3 + Worker/SQLite; only the provider response is mocked. Verifies the
// actual request body, cache partition, scope and persistence of picker choices.
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
function check(name, value) { checks.push({ name, ok: !!value }); console.log(`${value ? 'PASS' : 'FAIL'} ${name}`); assert.ok(value, name); }
async function openAccount(page) {
    if (!(await page.locator('#ext-account-details').evaluate((node) => node.open))) await page.locator('#ext-account-summary').click();
}
async function login(page, endpoint, token, user) {
    await openAccount(page);
    await page.locator('#ext-endpoint-input').fill(endpoint);
    await page.locator('#ext-login-mode').selectOption('token');
    await page.locator('#ext-token-input').fill(token);
    await page.locator('#ext-connect-btn').click();
    await page.waitForFunction((label) => !document.querySelector('#ext-connect-btn').disabled && document.querySelector('#ext-account-status').textContent.includes(label), user);
}
async function openAI(page) {
    if (!(await page.locator('#ext-ai-controls').evaluate((node) => node.open))) await page.locator('#ext-ai-controls > summary').click();
}
async function lookup(page) {
    await page.locator('#ext-lookup-btn').click();
    await page.waitForFunction(() => !document.querySelector('#ext-lookup-btn').disabled);
    await page.locator('#ext-result-box').waitFor({ state: 'visible' });
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
        check('密碼、通行碼及 API Key 欄位遮蔽輸入', await page.locator('#ext-password-input, #ext-token-input, #ext-import-key-input').evaluateAll((nodes) => nodes.length === 3 && nodes.every((node) => node.type === ['pass', 'word'].join(''))));
        check('未登入的帳戶表單展開，AI 控制停用', await page.locator('#ext-account-details').evaluate((node) => node.open) && await page.locator('#ext-ai-thinking').isDisabled());
        await page.screenshot({ path: path.join(OUT, 'account-zh-CN.png'), fullPage: true });
        await login(page, env.base, ALICE, 'alice');
        check('登入後自動收合帳戶表單，帳戶狀態仍可見', !(await page.locator('#ext-account-details').evaluate((node) => node.open)) && await page.locator('#ext-account-status').isVisible());
        await page.locator('#ext-word-input').fill('plunge'); await page.locator('#ext-sentence-input').fill('Markets plunge.');
        await openAI(page);
        check('模型來自帳戶允許清單', await page.locator('#ext-ai-model option').count() === 2);
        const cloudProfile = await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter((key) => key.startsWith('bdc_ai_profile_v1:')).map((key) => [key, localStorage.getItem(key)])));
        await page.locator('#ext-ai-model').selectOption('managed-capture:reasoning-model');
        await page.locator('#ext-ai-thinking').selectOption('high');
        check('選擇即時保存但不自行呼叫 AI', requests.length === 0 && /已保存/.test(await page.locator('#ext-ai-notice').textContent()));
        await lookup(page);
        check('網頁單詞請求實際帶選定模型和 high', requests.at(-1).model === 'reasoning-model' && requests.at(-1).reasoning_effort === 'high');
        const firstCount = requests.length; await lookup(page);
        check('相同選項可命中原有快取', requests.length === firstCount);
        await page.locator('#ext-ai-thinking').selectOption('low'); await lookup(page);
        check('思考程度改變會分開快取並傳送 low', requests.length === firstCount + 1 && requests.at(-1).reasoning_effort === 'low');
        await page.locator('#ext-ai-thinking').selectOption('none'); await lookup(page);
        check('關閉思考傳送 none', requests.at(-1).reasoning_effort === 'none');
        await page.locator('#ext-ai-thinking').selectOption('auto'); await lookup(page);
        check('跟隨服務端省略 reasoning_effort', !Object.hasOwn(requests.at(-1), 'reasoning_effort'));
        const profileAfter = await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter((key) => key.startsWith('bdc_ai_profile_v1:')).map((key) => [key, localStorage.getItem(key)])));
        check('擴充套件選擇不改寫雲端 AI profile', JSON.stringify(cloudProfile) === JSON.stringify(profileAfter));
        await page.locator('#ext-ai-thinking').selectOption('high');
        await page.reload(); await page.waitForFunction(() => !!document.querySelector('#ext-account-status').textContent);
        await page.locator('#ext-word-input').fill('plunge'); await page.locator('#ext-sentence-input').fill('Markets plunge.'); await openAI(page);
        check('重開頁面仍保留按帳戶保存的選擇', await page.locator('#ext-ai-model').inputValue() === 'managed-capture:reasoning-model' && await page.locator('#ext-ai-thinking').inputValue() === 'high');
        await openAccount(page); await page.locator('#ext-sync-btn').click();
        await page.waitForFunction(() => !document.querySelector('#ext-sync-btn').disabled);
        check('重新讀取帳戶 API 不覆蓋擴充套件選擇', await page.locator('#ext-ai-model').inputValue() === 'managed-capture:reasoning-model' && await page.locator('#ext-ai-thinking').inputValue() === 'high');
        await page.locator('#ext-ai-reset').click();
        check('恢復帳戶設定會移除當前用途的覆寫', await page.locator('#ext-ai-model').inputValue() === 'managed-capture:capture-model' && await page.locator('#ext-ai-thinking').inputValue() === 'none');
        await page.locator('#ext-word-input').fill('plunge down');
        await page.locator('#ext-ai-model').selectOption('managed-capture:reasoning-model'); await page.locator('#ext-ai-thinking').selectOption('medium'); await lookup(page);
        check('短語有自己的設定，請求傳送 medium', requests.at(-1).model === 'reasoning-model' && requests.at(-1).reasoning_effort === 'medium');
        await page.locator('#ext-sentence-input').fill(''); await page.locator('#ext-word-input').fill('plunge');
        await page.locator('#ext-ai-model').selectOption('managed-capture:reasoning-model'); await page.locator('#ext-ai-thinking').selectOption('low'); await lookup(page);
        check('獨立查詞同樣使用選定模型和思考程度', requests.at(-1).model === 'reasoning-model' && requests.at(-1).reasoning_effort === 'low');
        await page.locator('#ext-ai-task').selectOption('articleCleanup'); await page.locator('#ext-ai-model').selectOption('managed-capture:reasoning-model'); await page.locator('#ext-ai-thinking').selectOption('high');
        await page.evaluate(async () => {
            const { runExtensionArticleTask } = await import('./modules/extension-ai-runtime.js');
            await runExtensionArticleTask({ page: { text: '# Test article\n\nMarkets plunge.', pageTitle: 'Test article', pageUrl: 'https://example.test/article' } });
        });
        check('文章擷取實際使用所選模型和思考程度', requests.at(-1).model === 'reasoning-model' && requests.at(-1).reasoning_effort === 'high');
        await page.locator('#ext-ai-task').selectOption('articleParagraphTranslation'); await page.locator('#ext-ai-model').selectOption('managed-capture:reasoning-model'); await page.locator('#ext-ai-thinking').selectOption('medium');
        await page.evaluate(async () => {
            const { runExtensionArticleTask } = await import('./modules/extension-ai-runtime.js');
            await runExtensionArticleTask({ analyze: true, article: { body: 'Markets plunge.' } });
        });
        check('段落翻譯實際使用所選模型和思考程度', requests.at(-1).model === 'reasoning-model' && requests.at(-1).reasoning_effort === 'medium');
        await page.locator('#ext-ai-task').selectOption('lookup');
        for (const locale of ['zh-CN', 'zh-HK']) {
            await page.locator('#ext-locale-select').selectOption(locale);
            await page.setViewportSize({ width: 320, height: 900 });
            check(locale + ' 動態控制翻譯與窄窗不溢出', (await page.locator('label[for="ext-ai-model"]').textContent()) === '模型' && await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
            await page.screenshot({ path: path.join(OUT, 'controls-' + locale + '.png'), fullPage: true });
        }
        await page.setViewportSize({ width: 420, height: 900 });
        await openAccount(page); await page.locator('#ext-logout-btn').click();
        await login(page, env.base, BOB, 'bob'); await openAI(page);
        check('換帳戶不沿用前一帳戶的模型與思考程度', await page.locator('#ext-ai-model').inputValue() === 'managed-capture:capture-model' && await page.locator('#ext-ai-thinking').inputValue() === 'none');
        await openAccount(page); await page.locator('#ext-logout-btn').click(); await login(page, env.base, ALICE, 'alice');
        await page.locator('#ext-word-input').fill('plunge'); await page.locator('#ext-sentence-input').fill(''); await openAI(page);
        check('切回帳戶恢復自己的偏好', await page.locator('#ext-ai-model').inputValue() === 'managed-capture:reasoning-model' && await page.locator('#ext-ai-thinking').inputValue() === 'low');
        const other = await context.newPage(); await other.goto(base + '/lookup.html');
        await other.waitForFunction(() => document.querySelector('#ext-account-status').textContent.includes('alice'));
        await other.locator('#ext-word-input').fill('plunge'); await openAI(other);
        let retained = true;
        for (let round = 0; round < 4; round += 1) {
            const model = round % 2 ? 'reasoning-model' : 'capture-model';
            const thinking = round % 2 ? 'low' : 'medium';
            await Promise.all([page.locator('#ext-ai-model').selectOption('managed-capture:' + model), other.locator('#ext-ai-thinking').selectOption(thinking)]);
            const actual = await page.evaluate(async () => (await import('./modules/extension-ai-runtime.js')).getExtensionAITaskSettings('wordAnalysis'));
            retained &&= actual.model === 'managed-capture:' + model && actual.thinking === thinking;
        }
        check('兩個視窗並行修改同用途的模型和思考均保留', retained);
        await page.locator('#ext-ai-task').selectOption('articleCleanup'); await other.locator('#ext-ai-task').selectOption('articleParagraphTranslation');
        await Promise.all([page.locator('#ext-ai-model').selectOption('managed-capture:capture-model'), other.locator('#ext-ai-model').selectOption('managed-capture:reasoning-model')]);
        const both = await page.evaluate(async () => {
            const { getExtensionAITaskSettings: get } = await import('./modules/extension-ai-runtime.js');
            return [get('articleCleanup').model, get('articleParagraphTranslation').model];
        });
        check('兩個視窗並行修改不同用途均保留', both[0] === 'managed-capture:capture-model' && both[1] === 'managed-capture:reasoning-model');
        await other.close();
        const article = await context.newPage(); await article.goto(env.base + '/test-article');
        const rect = await article.evaluate(() => {
            const text = document.querySelector('#article').firstChild;
            const start = text.textContent.indexOf('plunge');
            const range = document.createRange(); range.setStart(text, start); range.setEnd(text, start + 6);
            const box = range.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height };
        });
        await article.mouse.move(rect.x + 1, rect.y + rect.height / 2); await article.mouse.down();
        await article.mouse.move(rect.x + rect.width - 1, rect.y + rect.height / 2, { steps: 8 }); await article.mouse.up();
        await article.mouse.click(rect.x + 24, rect.y + rect.height + 20);
        await article.waitForFunction(() => !!document.querySelector('bdc-page-lookup'));
        let inline;
        for (let attempt = 0; attempt < 50; attempt += 1) {
            inline = article.frames().find((frame) => frame.url().startsWith(base + '/lookup.html'));
            if (inline) break;
            await article.waitForTimeout(100);
        }
        assert.ok(inline, 'inline frame opened by a real selection and click');
        await inline.locator('#ext-result-box').waitFor({ state: 'visible' });
        await openAI(inline);
        check('選詞旁真實 iframe 內可直接展開模型及思考選擇', await inline.locator('#ext-ai-model').isVisible() && await inline.locator('#ext-ai-thinking').isVisible());
        await inline.locator('#ext-ai-model').selectOption('managed-capture:reasoning-model'); await inline.locator('#ext-ai-thinking').selectOption('high');
        const beforeInline = requests.length;
        await inline.locator('#ext-ai-requery').click();
        await inline.waitForFunction(() => !document.querySelector('#ext-lookup-btn').disabled && !document.querySelector('#ext-result-box').classList.contains('hidden'));
        check('選詞旁小窗重新查詞實際套用模型及思考程度', requests.length > beforeInline && requests.at(-1).model === 'reasoning-model' && requests.at(-1).reasoning_effort === 'high');
        await inline.locator('#ext-ai-controls > summary').click();
        await article.screenshot({ path: path.join(OUT, 'inline-model-choice.png'), fullPage: true });
        const preferences = await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('bdc_extension_ai_preferences_v1:')));
        check('偏好儲存不含 Token、Key 或 API URL', !/test-cmdo|aaaaa|bbbbb|apiKey|Bearer|mock-ai/.test(JSON.stringify(preferences)));
        check('無頁面 JavaScript 例外', errors.length === 0);
    } finally {
        fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ checks, errors, requests: requests.map(({ model, reasoning_effort }) => ({ model, reasoning_effort })) }, null, 2));
        await context?.close(); await env?.close(); fs.rmSync(profile, { recursive: true, force: true });
    }
})().catch((error) => { console.error(error); process.exitCode = 1; });
