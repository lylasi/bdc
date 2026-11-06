// DeepSeek independent functional audit: extension model / thinking picker (0.5.0).
//
// Real MV3 extension (packaged from source), real Worker + SQLite account
// service, real account snapshot / catalog / credential paths. Only the AI
// provider itself is a local recorder so the exact wire body can be inspected.
//
// This suite is deliberately independent of tests/extension-ai-controls.cjs:
// it seeds a *personal* provider through the account snapshot and imports its
// key through the product UI, exercises all five thinking levels on two wire
// formats, per-level thinking-rejection memory, cache partitioning, per-task
// boundaries, freeze-during-multi-block, save failures, catalog removal,
// cross-tab refresh, endpoint/user/guest scope isolation and a late 401.
//
// Re-test round (2026-11-06): storage moved to one key per task+field, the
// remote applier merges `tasks`/`models`, and the panel now surfaces thinking
// fallbacks. Every choice read therefore goes through the product runtime
// (`getExtensionAITaskSettings`) instead of indexing raw localStorage, D64 is a
// pass/fail cross-page concurrency check, and D70-D73 pin the fallback notice.
//
// Usage:
//   PLAYWRIGHT_MODULE=<path-to-playwright> node tests/extension-ai-controls-deepseek.cjs

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { environment, ALICE, BOB, ADMIN } = require('./helpers/extension-mv3.cjs');

const ROOT = path.resolve(__dirname, '..');
const STAMP = new Date(Date.now() + 8 * 3600000).toISOString().replace(/\D/g, '').slice(0, 17);
const OUT = process.env.DEEPSEEK_AI_CONTROLS_OUTPUT || path.join(ROOT, 'docs/report/assets', STAMP + '_ai-controls-deepseek');
const MANAGED_KEY = 'ds-managed-provider-key-5f4a';
const LAB_KEY = 'ds-personal-lab-key-9c1e';
const ANTH_KEY = 'ds-personal-anth-key-77b2';
const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, anthropic-version, anthropic-dangerous-direct-browser-access',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Content-Type': 'application/json'
};

const checks = [];
const notes = [];
function check(id, name, ok, detail) {
    const record = { id, name, ok: !!ok, ...(detail === undefined ? {} : { detail }) };
    checks.push(record);
    console.log(`${ok ? 'PASS' : 'FAIL'} [${id}] ${name}${ok || detail === undefined ? '' : ' :: ' + JSON.stringify(detail)}`);
}
function must(name, ok, detail) {
    if (!ok) {
        const error = new Error('setup failed: ' + name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)));
        error.setup = true;
        throw error;
    }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function sha256(value) { return createHash('sha256').update(String(value)).digest('hex'); }

// ---------------------------------------------------------------- provider mock
function promptTag(body) {
    const text = JSON.stringify(body.messages || body.content || '');
    if (text.includes('Clean the supplied Markdown article')) return 'cleanup';
    if (text.includes('Translate the following English paragraph')) return 'paragraph';
    if (text.includes('Analyze the selected English phrase')) return 'phrase';
    if (text.includes('Analyze the target English word')) return 'wordInSentence';
    if (text.includes('Analyze the English word')) return 'word';
    return 'other';
}

function answerFor(tag) {
    if (tag === 'cleanup') return '# Probe Article\n\nMarkets plunge as investors worry.\n\n## Outlook\n\nPrices change slowly.\n\n## Detail\n\nPeople gather information.';
    if (tag === 'paragraph') return JSON.stringify({ chinese_translation: '市場下跌。' });
    if (tag === 'phrase') return JSON.stringify({ selection: 'plunge down', sentence: 'Markets plunge down.', meaning: '暴跌', analysis: { phonetic: 'plʌndʒ daʊn', meaning: '暴跌', usage: '動詞短語', examples: [] } });
    // The standalone dictionary path reads top-level fields; the in-sentence
    // path reads analysis.*; a real model answers the requested schema, and the
    // stricter standalone path requires the flat shape.
    return JSON.stringify({
        word: 'plunge', sentence: 'Markets plunge.', meaning: '暴跌', translation: '暴跌',
        phonetic: 'plʌndʒ', pos: 'verb', role: '謂語',
        analysis: { phonetic: 'plʌndʒ', pos: 'verb', meaning: '暴跌', role: '謂語' }
    });
}

function createWire() {
    const state = {
        requests: [],
        rejectEffort: '',     // the only level this provider refuses (400)
        rejectAll: null,      // generic 400 for the next requests
        delayMs: 0,
        auth403: false
    };
    function providerOf(url) {
        const pathname = new URL(url).pathname;
        if (pathname.startsWith('/probe-main/')) return 'managed-main';
        if (pathname.startsWith('/probe-backup/')) return 'managed-backup';
        if (pathname.startsWith('/probe-personal/')) return 'personal-lab';
        if (pathname.startsWith('/probe-anth/')) return 'personal-anth';
        return 'unknown';
    }
    async function handler(route) {
        const request = route.request();
        if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS, body: '' });
        const body = request.postDataJSON() || {};
        const headers = request.headers();
        const entry = {
            provider: providerOf(request.url()),
            url: request.url(),
            model: body.model || '',
            effort: Object.prototype.hasOwnProperty.call(body, 'reasoning_effort') ? body.reasoning_effort : null,
            thinking: body.thinking || null,
            maxTokens: body.max_tokens == null ? null : body.max_tokens,
            temperature: body.temperature == null ? null : body.temperature,
            auth: headers['authorization'] || '',
            apiKeyHeader: headers['x-api-key'] || '',
            tag: promptTag(body),
            at: Date.now()
        };
        state.requests.push(entry);
        if (state.delayMs) await sleep(state.delayMs);
        if (state.rejectAll && state.rejectAll.count > 0) {
            state.rejectAll.count -= 1;
            return route.fulfill({ status: 400, headers: CORS, body: JSON.stringify({ error: { message: 'request rejected by provider' } }) });
        }
        if (state.rejectEffort && entry.effort === state.rejectEffort) {
            return route.fulfill({
                status: 400, headers: CORS,
                body: JSON.stringify({ error: { message: "Unsupported parameter: 'reasoning_effort' is not supported with this model.", type: 'invalid_request_error', param: 'reasoning_effort' } })
            });
        }
        if (state.auth403) return route.fulfill({ status: 403, headers: CORS, body: '{"error":{"message":"forbidden"}}' });
        const content = answerFor(entry.tag);
        if (entry.provider === 'personal-anth') {
            return route.fulfill({ status: 200, headers: CORS, body: JSON.stringify({ type: 'message', stop_reason: 'end_turn', content: [{ type: 'text', text: content }] }) });
        }
        return route.fulfill({ status: 200, headers: CORS, body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }) });
    }
    return {
        state,
        handler,
        reset() { state.requests.length = 0; state.rejectEffort = ''; state.rejectAll = null; state.delayMs = 0; state.auth403 = false; },
        count(predicate = () => true) { return state.requests.filter(predicate).length; },
        last() { return state.requests[state.requests.length - 1]; }
    };
}

// ---------------------------------------------------------------- catalog/snapshot
async function publishCatalog(base, baseVersion, providers, tasks, keyOps, mutationId) {
    const response = await fetch(base + '/admin/ai-catalog/publish', {
        method: 'POST',
        headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseVersion, mutationId: mutationId || `deepseek-ai-controls-${baseVersion}`, config: { schemaVersion: 1, providers, tasks }, keyOps })
    });
    const text = await response.text();
    must('catalog publish ' + baseVersion, response.status === 200, { status: response.status, text: text.slice(0, 300) });
    return JSON.parse(text);
}

function providersFor(base) {
    return [
        {
            id: 'managed-main', name: 'Main', enabled: true, order: 0, format: 'openai-chat',
            apiUrl: base + '/probe-main/v1/chat/completions', modelsUrl: base + '/probe-main/v1/models',
            authMode: 'bearer', models: [{ id: 'main-model' }, { id: 'shared-model' }]
        },
        {
            id: 'managed-backup', name: 'Backup', enabled: true, order: 1, format: 'openai-chat',
            apiUrl: base + '/probe-backup/v1/chat/completions', modelsUrl: base + '/probe-backup/v1/models',
            authMode: 'bearer', models: [{ id: 'shared-model' }, { id: 'alt-model' }]
        }
    ];
}

function tasksFor(providerId, model) {
    return Object.fromEntries(['wordAnalysis', 'articleWordTranslation', 'articlePhraseTranslation', 'articleCleanup', 'articleParagraphTranslation', 'articleAnalysis']
        .map((task) => [task, { providerId, model }]));
}

async function seedAccountAISettings(base, token, settings, expectedVersion = 0) {
    const tasks = { ...settings.tasks };
    const payload = {
        aiSettings: {
            updatedAt: '2026-11-06T00:00:00.000Z',
            // Real clients mirror taskModels into both models and tasks.
            settings: { providers: settings.providers, models: tasks, tasks, thinking: settings.thinking, defaultModel: settings.defaultModel || '' }
        }
    };
    const response = await fetch(base + '/snapshot', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expected_version: expectedVersion, payload })
    });
    const text = await response.text();
    must('snapshot seed', response.status === 200, { status: response.status, text: text.slice(0, 300) });
    return JSON.parse(text);
}

// ---------------------------------------------------------------- page helpers
async function openAccount(page) {
    if (!(await page.locator('#ext-account-details').evaluate((node) => node.open))) await page.locator('#ext-account-summary').click();
}
async function login(page, endpoint, token, userLabel) {
    await openAccount(page);
    await page.locator('#ext-endpoint-input').fill(endpoint);
    await page.locator('#ext-endpoint-input').dispatchEvent('change');
    await page.waitForTimeout(120);
    await page.locator('#ext-login-mode').selectOption('token');
    await page.locator('#ext-token-input').fill(token);
    await page.locator('#ext-connect-btn').click();
    await page.waitForFunction((label) => !document.querySelector('#ext-connect-btn').disabled
        && document.querySelector('#ext-account-status').textContent.includes(label), userLabel, { timeout: 30000 });
}
async function logout(page) {
    await openAccount(page);
    await page.locator('#ext-logout-btn').click();
    await page.waitForFunction(() => document.querySelector('#ext-account-status').textContent
        && !document.querySelector('#ext-account-status').textContent.includes('alice'), null, { timeout: 20000 }).catch(() => {});
    await page.waitForFunction(() => document.querySelector('#ext-logout-btn').disabled, null, { timeout: 20000 });
}
async function openAI(page) {
    const open = await page.locator('#ext-ai-controls').evaluate((node) => node.open);
    if (!open) await page.locator('#ext-ai-controls > summary').click();
}
async function controls(page) {
    return page.evaluate(() => {
        const notice = document.querySelector('#ext-ai-notice');
        return {
            task: document.querySelector('#ext-ai-task').value,
            tasks: [...document.querySelectorAll('#ext-ai-task option')].map((option) => option.value),
            model: document.querySelector('#ext-ai-model').value,
            modelOptions: [...document.querySelectorAll('#ext-ai-model option')].map((option) => ({ value: option.value, label: option.textContent, disabled: option.disabled })),
            thinking: document.querySelector('#ext-ai-thinking').value,
            thinkingOptions: [...document.querySelectorAll('#ext-ai-thinking option')].map((option) => option.value),
            notice: notice && !notice.hidden ? notice.textContent : '',
            noticeError: notice ? notice.classList.contains('ext-notice-error') : false,
            summary: document.querySelector('#ext-ai-controls summary').textContent,
            resetDisabled: document.querySelector('#ext-ai-reset').disabled,
            requeryDisabled: document.querySelector('#ext-ai-requery').disabled,
            requeryHidden: document.querySelector('#ext-ai-requery').hidden,
            modelDisabled: document.querySelector('#ext-ai-model').disabled,
            thinkingDisabled: document.querySelector('#ext-ai-thinking').disabled,
            taskDisabled: document.querySelector('#ext-ai-task').disabled,
            labels: {
                task: document.querySelector('label[for="ext-ai-task"]')?.textContent || '',
                model: document.querySelector('label[for="ext-ai-model"]')?.textContent || '',
                thinking: document.querySelector('label[for="ext-ai-thinking"]')?.textContent || ''
            },
            accountStatus: document.querySelector('#ext-account-status').textContent,
            lookupNotice: document.querySelector('#ext-lookup-notice')?.classList.contains('hidden') ? '' : document.querySelector('#ext-lookup-notice').textContent,
            resultVisible: !document.querySelector('#ext-result-box').classList.contains('hidden'),
            resultMeaning: document.querySelector('#ext-result-meaning').textContent
        };
    });
}
async function selectModel(page, value) {
    await page.locator('#ext-ai-model').selectOption(value);
    await page.waitForTimeout(80);
}
async function selectThinking(page, value) {
    await page.locator('#ext-ai-thinking').selectOption(value);
    await page.waitForTimeout(80);
}
async function selectTask(page, value) {
    await page.locator('#ext-ai-task').selectOption(value);
    await page.waitForTimeout(80);
}
async function setQuery(page, { text = '', sentence = '', context = '' }) {
    await page.locator('#ext-word-input').fill(text);
    await page.locator('#ext-sentence-input').fill(sentence);
    await page.locator('#ext-context-input').fill(context);
    await page.waitForTimeout(80);
}
async function setForceRefresh(page, on) {
    await page.locator('#ext-force-refresh').evaluate((node, value) => { node.checked = value; }, !!on);
}
async function lookup(page) {
    await page.locator('#ext-lookup-btn').click();
    await page.waitForFunction(() => !document.querySelector('#ext-lookup-btn').disabled, null, { timeout: 40000 });
    await page.waitForTimeout(120);
    return page.evaluate(() => ({
        visible: !document.querySelector('#ext-result-box').classList.contains('hidden'),
        meaning: document.querySelector('#ext-result-meaning').textContent,
        notice: document.querySelector('#ext-lookup-notice').classList.contains('hidden') ? '' : document.querySelector('#ext-lookup-notice').textContent
    }));
}
async function importKey(page, providerId, key) {
    await page.locator('#ext-import-provider-select').selectOption(providerId);
    await page.locator('#ext-import-key-input').fill(key);
    await page.locator('#ext-import-key-btn').click();
    await page.waitForTimeout(400);
}
async function prefs(page) {
    return page.evaluate(() => Object.fromEntries(Object.entries(localStorage)
        .filter(([key]) => key.startsWith('bdc_extension_ai_preferences_v1:'))
        .map(([key, value]) => [key, (() => { try { return JSON.parse(value); } catch (_) { return value; } })()])));
}
async function profile(page) {
    return page.evaluate(() => {
        const out = {};
        for (const [key, value] of Object.entries(localStorage)) {
            if (!key.startsWith('bdc_ai_profile_v1:')) continue;
            try { out[key] = JSON.parse(value); } catch (_) { out[key] = value; }
        }
        return out;
    });
}
async function taskSettings(page, task) {
    return page.evaluate(async (taskName) => {
        const module = await import('./modules/extension-ai-runtime.js');
        return module.getExtensionAITaskSettings(taskName);
    }, task);
}
async function callRuntime(page, fn, ...args) {
    return page.evaluate(async ({ fn, args }) => {
        const module = await import('./modules/extension-ai-runtime.js');
        try {
            const value = await module[fn](...args);
            return { ok: true, value };
        } catch (error) {
            return { ok: false, code: error?.code || '', message: String(error?.message || '') };
        }
    }, { fn, args });
}
async function callPreferences(page, fn, ...args) {
    return page.evaluate(async ({ fn, args }) => {
        const module = await import('./modules/extension-ai-preferences.js');
        try {
            const value = await module[fn](...args);
            return { ok: true, value };
        } catch (error) {
            return { ok: false, code: error?.code || '', message: String(error?.message || '') };
        }
    }, { fn, args });
}
// The authoritative read of the *current* scope's extension choices. Raw
// localStorage inspection cannot tell scopes apart (two endpoints, two
// accounts, one field per key), so behaviour checks resolve through the
// product's own runtime instead.
async function scopePreferences(page) {
    return page.evaluate(async () => {
        const module = await import('./modules/extension-ai-preferences.js');
        return module.getExtensionAIPreferences();
    });
}
// `bdc_extension_ai_preferences_v1:["<endpoint>","<user>"]` optionally
// followed by `:<task>:<field>`; the scope is everything up to the last `]`.
function scopeKeys(prefsObject) {
    return [...new Set(Object.keys(prefsObject).map((key) => key.slice(0, key.lastIndexOf(']') + 1)))];
}
async function fallbackNotice(page) {
    return page.evaluate(() => {
        const node = document.querySelector('#ext-ai-fallback');
        const details = document.querySelector('#ext-ai-controls');
        const style = node ? getComputedStyle(node) : null;
        return {
            exists: !!node,
            visible: !!node && !node.hidden && style.display !== 'none' && node.getBoundingClientRect().height > 0,
            text: node ? node.textContent : '',
            outsideDetails: !!node && !node.closest('details') && (!details || !details.contains(node)),
            detailsOpen: details ? details.open : null,
            error: node ? node.classList.contains('ext-notice-error') : null
        };
    });
}
async function closeAI(page) {
    if (await page.locator('#ext-ai-controls').evaluate((node) => node.open)) await page.locator('#ext-ai-controls > summary').click();
}

// ---------------------------------------------------------------- suite
(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const packaging = execFileSync(process.execPath, ['scripts/package-extension.mjs'], { cwd: ROOT, encoding: 'utf8' });
    notes.push('package: ' + packaging.trim().split('\n').join(' | '));

    const wire = createWire();
    const consoleErrors = [];
    const pageErrors = [];
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-deepseek-ai-controls-'));
    let env = await environment();
    let envB = null;
    let context = null;
    let summary = { ok: false };

    try {
        // Managed catalog: two providers sharing a model id on purpose, so a
        // silent provider substitution after removal would be observable.
        await publishCatalog(env.base, 1, providersFor(env.base), tasksFor('managed-main', 'main-model'),
            { 'managed-main': { action: 'replace', apiKey: MANAGED_KEY }, 'managed-backup': { action: 'replace', apiKey: MANAGED_KEY } });

        // ALICE's account profile: a personal OpenAI-compatible provider mapped
        // to standalone word lookup plus a personal thinking choice, and a
        // second personal provider in the Anthropic wire format.
        await seedAccountAISettings(env.base, ALICE, {
            providers: {
                'personal-lab': {
                    label: 'Lab', enabled: true, format: 'openai-chat', authMode: 'bearer',
                    apiUrl: env.base + '/probe-personal/v1/chat/completions',
                    modelsUrl: env.base + '/probe-personal/v1/models',
                    allowedModels: ['lab-model']
                },
                'personal-anth': {
                    label: 'Anthropic Lab', enabled: true, format: 'anthropic-messages', authMode: 'x-api-key',
                    apiUrl: env.base + '/probe-anth/v1/messages',
                    modelsUrl: env.base + '/probe-anth/v1/models',
                    allowedModels: ['anth-model']
                }
            },
            tasks: { wordAnalysis: 'personal-lab:lab-model' },
            thinking: { wordAnalysis: 'low' }
        });

        const extension = path.join(ROOT, 'extension');
        context = await chromium.launchPersistentContext(profileDir, {
            channel: 'chromium', headless: true, viewport: { width: 430, height: 940 },
            args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
        });
        context.on('page', (page) => page.on('pageerror', (error) => pageErrors.push(String(error && error.message || error))));
        await context.route('**/probe-*/**', wire.handler);
        const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
        const base = `chrome-extension://${new URL(worker.url()).host}`;
        const page = await context.newPage();
        await page.goto(base + '/lookup.html');
        await page.waitForFunction(() => !!document.querySelector('#ext-account-status').textContent);
        await openAI(page);
        await page.waitForTimeout(200);

        // ---------------------------------------------------------- D01-D03 guest
        let state = await controls(page);
        check('D01', '未登入時三個選擇器與恢復按鈕皆停用', state.taskDisabled && state.modelDisabled && state.thinkingDisabled && state.resetDisabled, state);
        check('D02', '未登入時用途清單為 3 項、思考清單為五檔、標籤文字可辨識',
            state.tasks.length === 3 && state.labels.model.trim().length > 0
            && JSON.stringify(state.thinkingOptions) === JSON.stringify(['auto', 'none', 'low', 'medium', 'high']),
            { tasks: state.tasks, thinking: state.thinkingOptions });
        const guestSettings = await callRuntime(page, 'getExtensionAITaskSettings', 'wordAnalysis');
        const guestSave = await callRuntime(page, 'setExtensionAITaskSettings', 'wordAnalysis', { model: 'managed-main:main-model' });
        const guestWrite = await callPreferences(page, 'saveExtensionAIChoice', 'wordAnalysis', { model: 'managed-main:main-model' });
        check('D03', '未登入（guest）保存被拒（stale_session / model_not_allowed），且不會建立偏好鍵',
            guestSave.ok === false && ['stale_session', 'model_not_allowed'].includes(guestSave.code)
            && guestWrite.ok === false && guestWrite.code === 'stale_session'
            && Object.keys(await prefs(page)).length === 0,
            { guestSave, guestWrite, prefs: await prefs(page), guestModel: guestSettings.ok && guestSettings.value.model });
        await page.screenshot({ path: path.join(OUT, 'guest-disabled.png'), fullPage: true });

        // ---------------------------------------------------------- D04-D07 login + personal key
        await login(page, env.base, ALICE, 'alice');
        await page.waitForTimeout(400);
        await openAI(page);
        state = await controls(page);
        const optionValues = state.modelOptions.map((option) => option.value);
        check('D04', '登入後模型清單同時包含個人與 managed 模型，且無重複',
            optionValues.includes('personal-lab:lab-model') && optionValues.includes('personal-anth:anth-model')
            && optionValues.includes('managed-main:main-model') && optionValues.includes('managed-backup:alt-model')
            && new Set(optionValues).size === optionValues.length, optionValues);
        const banner = await page.evaluate(() => ({
            visible: !document.querySelector('#ext-missing-key-banner').classList.contains('hidden'),
            providers: [...document.querySelectorAll('#ext-import-provider-select option')].map((option) => option.value)
        }));
        check('D05', '個人供應商缺少本機金鑰時顯示匯入橫幅且列出兩個供應商',
            banner.visible && banner.providers.includes('personal-lab') && banner.providers.includes('personal-anth'), banner);
        state = await controls(page);
        check('D06', '帳戶查詞設定（個人模型 + 低強度思考）成為獨立查詞的預設值',
            state.model === 'personal-lab:lab-model' && state.thinking === 'low', { model: state.model, thinking: state.thinking });

        await importKey(page, 'personal-lab', LAB_KEY);
        const afterLab = await page.evaluate(() => ({
            hidden: document.querySelector('#ext-missing-key-banner').classList.contains('hidden'),
            providers: [...document.querySelectorAll('#ext-import-provider-select option')].map((option) => option.value),
            notice: document.querySelector('#ext-account-notice').textContent
        }));
        await importKey(page, 'personal-anth', ANTH_KEY);
        const afterAnth = await page.evaluate(() => ({
            hidden: document.querySelector('#ext-missing-key-banner').classList.contains('hidden'),
            notice: document.querySelector('#ext-account-notice').textContent
        }));
        check('D07', '逐一匯入本機金鑰後橫幅只移除已匯入者，全部匯入後收合',
            !afterLab.hidden && !afterLab.providers.includes('personal-lab') && afterAnth.hidden, { afterLab, afterAnth });

        // ---------------------------------------------------------- D08 personal lookup
        await setQuery(page, { text: 'plunge', sentence: '' });
        wire.reset();
        let result = await lookup(page);
        let request = wire.last();
        const storedLabKey = (await profile(page))[Object.keys(await profile(page)).find((key) => key.includes(encodeURIComponent('alice')))]?.credentials?.['personal-lab']?.apiKey;
        check('D08', '獨立查詞實際走個人供應商：模型、低強度思考、本機金鑰與可用結果',
            request && request.provider === 'personal-lab' && request.model === 'lab-model' && request.effort === 'low'
            && request.tag === 'word' && request.auth === `Bearer ${LAB_KEY}` && storedLabKey === LAB_KEY
            && result.visible && result.meaning.length > 0,
            { request: request && { provider: request.provider, model: request.model, effort: request.effort, tag: request.tag, hasAuth: !!request.auth }, keyMatches: storedLabKey === LAB_KEY, result });

        // ---------------------------------------------------------- D09-D13 overrides + cache
        await openAI(page);
        const requestsBeforeSelection = wire.count();
        await selectModel(page, 'managed-main:shared-model');
        await selectThinking(page, 'high');
        state = await controls(page);
        const savedLookupChoice = await taskSettings(page, 'wordAnalysis');
        const savedScopePrefs = await scopePreferences(page);
        check('D09', '變更模型/思考立即保存、顯示成功提示，且不會自行發出 AI 請求',
            wire.count() === requestsBeforeSelection && /已保存/.test(state.notice) && state.noticeError === false
            && savedLookupChoice.model === 'managed-main:shared-model' && savedLookupChoice.modelOverride === 'managed-main:shared-model'
            && savedLookupChoice.thinking === 'high' && savedLookupChoice.thinkingOverride === 'high'
            && savedScopePrefs.wordAnalysis?.model === 'managed-main:shared-model'
            && savedScopePrefs.wordAnalysis?.thinking === 'high',
            { notice: state.notice, choice: { model: savedLookupChoice.model, thinking: savedLookupChoice.thinking }, scope: savedScopePrefs });

        wire.reset();
        result = await lookup(page);
        request = wire.last();
        check('D10', '選定模型與 high 實際送到 managed 供應商，並使用 managed 金鑰',
            request && request.provider === 'managed-main' && request.model === 'shared-model' && request.effort === 'high'
            && request.auth === `Bearer ${MANAGED_KEY}` && result.visible,
            { request: request && { provider: request.provider, model: request.model, effort: request.effort, hasAuth: !!request.auth }, result });

        const countAfterFirst = wire.count();
        await lookup(page);
        check('D11', '相同模型與相同思考程度命中快取（不再呼叫供應商）', wire.count() === countAfterFirst, { before: countAfterFirst, after: wire.count() });

        await selectThinking(page, 'medium');
        await lookup(page);
        const mediumCount = wire.count();
        await selectThinking(page, 'high');
        await lookup(page);
        const backToHighCount = wire.count();
        await selectModel(page, 'managed-backup:alt-model');
        await lookup(page);
        const altCount = wire.count();
        await selectModel(page, 'managed-main:shared-model');
        await lookup(page);
        const backToMainCount = wire.count();
        check('D12', '快取依思考程度與模型分區：換檔重查、換回原值命中快取',
            mediumCount === countAfterFirst + 1 && backToHighCount === mediumCount
            && altCount === mediumCount + 1 && backToMainCount === altCount,
            { countAfterFirst, mediumCount, backToHighCount, altCount, backToMainCount });

        await setForceRefresh(page, true);
        const forcedBefore = wire.count();
        await lookup(page);
        await setForceRefresh(page, false);
        check('D13', '強制重新整理會繞過快取並使用當前選擇', wire.count() === forcedBefore + 1 && wire.last().model === 'shared-model', { before: forcedBefore, after: wire.count() });

        // ---------------------------------------------------------- D14 five levels (openai-chat)
        await setForceRefresh(page, true);
        const levelWire = {};
        for (const level of ['auto', 'none', 'low', 'medium', 'high']) {
            await selectThinking(page, level);
            const before = wire.count();
            await lookup(page);
            levelWire[level] = wire.count() === before + 1 ? wire.last() : null;
        }
        await setForceRefresh(page, false);
        check('D14', '五檔思考在 chat-completions 線上路徑正確（auto 省略，其餘原樣）',
            levelWire.auto && levelWire.auto.effort === null
            && levelWire.none.effort === 'none' && levelWire.low.effort === 'low'
            && levelWire.medium.effort === 'medium' && levelWire.high.effort === 'high',
            Object.fromEntries(Object.entries(levelWire).map(([level, entry]) => [level, entry && entry.effort])));
        check('D15', '高強度思考提高輸出預算（thinking token floor），auto 不提高',
            !!levelWire.high && levelWire.high.maxTokens >= 5000 && !!levelWire.auto && (levelWire.auto.maxTokens || 0) < 5000,
            { high: levelWire.high.maxTokens, auto: levelWire.auto.maxTokens });

        // ---------------------------------------------------------- D16-D18 rejection memory
        await selectModel(page, 'managed-backup:alt-model');
        await selectThinking(page, 'high');
        wire.state.rejectEffort = 'high';
        await setForceRefresh(page, true);
        await page.evaluate(() => {
            window.__fallbackEvents = [];
            window.addEventListener('bdc:ai-thinking-fallback', (event) => window.__fallbackEvents.push(event.detail));
        });
        // Collapse the picker: the degradation hint must be readable without
        // opening the AI panel that the fallback concerns.
        await closeAI(page);
        let before = wire.count();
        result = await lookup(page);
        const rejectedRun = wire.state.requests.slice(before);
        const fallbackEvents = await page.evaluate(() => window.__fallbackEvents || []);
        const panelAfterFallback = await controls(page);
        check('D16', '供應商拒絕 reasoning_effort=high 時自動重試一次並成功，並發出降級事件',
            rejectedRun.length === 2 && rejectedRun[0].effort === 'high' && rejectedRun[1].effort === null
            && result.visible && !result.notice
            && fallbackEvents.length === 1 && fallbackEvents[0].level === 'high' && fallbackEvents[0].model === 'alt-model'
            && panelAfterFallback.thinking === 'high',
            { run: rejectedRun.map((entry) => ({ effort: entry.effort, model: entry.model })), result, fallbackEvents, panelShowsLevel: panelAfterFallback.thinking });

        // ---------------------------------------------------------- D70-D71 (O2) fallback notice
        const cnFallback = await fallbackNotice(page);
        check('D70', '思考被供應商拒絕後，面板收合時仍在詳情外顯示一次性提示（簡體中文）',
            cnFallback.exists && cnFallback.visible && cnFallback.outsideDetails && cnFallback.detailsOpen === false
            && cnFallback.error === false && /alt-model/.test(cnFallback.text)
            && /未接受思考参数/.test(cnFallback.text) && !/undefined/.test(cnFallback.text),
            cnFallback);
        await page.locator('#ext-locale-select').selectOption('zh-HK');
        await page.waitForTimeout(350);
        const hkFallback = await fallbackNotice(page);
        check('D71', '同一降級提示切換到香港繁體後仍可見且使用港繁文案',
            hkFallback.visible && hkFallback.detailsOpen === false && /alt-model/.test(hkFallback.text)
            && /未接受思考參數/.test(hkFallback.text) && /服務端預設設定/.test(hkFallback.text) && !/undefined/.test(hkFallback.text),
            hkFallback);
        await page.locator('#ext-locale-select').selectOption('zh-CN');
        await page.waitForTimeout(350);

        before = wire.count();
        await lookup(page);
        const rememberedRun = wire.state.requests.slice(before);
        check('D17', '記住被拒的層級後，同層級重查直接省略參數（不再送出注定失敗的請求）',
            rememberedRun.length === 1 && rememberedRun[0].effort === null,
            rememberedRun.map((entry) => ({ effort: entry.effort, model: entry.model })));
        const afterNextRequest = await fallbackNotice(page);
        const fallbackEventCount = await page.evaluate(() => (window.__fallbackEvents || []).length);
        check('D72', '下一次請求會清除降級提示，且未再降級時不會重新出現',
            afterNextRequest.visible === false && afterNextRequest.text === '' && fallbackEventCount === 1,
            { visible: afterNextRequest.visible, text: afterNextRequest.text, fallbackEventCount });

        await openAI(page);
        await selectThinking(page, 'low');
        before = wire.count();
        await lookup(page);
        const lowRun = wire.state.requests.slice(before);
        check('D18', '被拒記憶依層級隔離：同一供應商的 low 仍會送出 reasoning_effort',
            lowRun.length === 1 && lowRun[0].effort === 'low',
            lowRun.map((entry) => ({ effort: entry.effort, model: entry.model })));
        wire.state.rejectEffort = '';
        await setForceRefresh(page, false);

        // ---------------------------------------------------------- D19-D20 anthropic personal provider
        await selectModel(page, 'personal-anth:anth-model');
        await selectThinking(page, 'medium');
        await setForceRefresh(page, true);
        before = wire.count();
        result = await lookup(page);
        request = wire.last();
        check('D19', '個人 Anthropic 供應商：medium 轉為 thinking budget 4096、temperature 1、x-api-key 認證',
            wire.count() === before + 1 && request.provider === 'personal-anth' && request.model === 'anth-model'
            && request.thinking && request.thinking.type === 'enabled' && request.thinking.budget_tokens === 4096
            && request.temperature === 1 && request.maxTokens >= 4096 + 1024
            && request.apiKeyHeader === ANTH_KEY && result.visible,
            { request: request && { provider: request.provider, thinking: request.thinking, temperature: request.temperature, maxTokens: request.maxTokens, hasKey: !!request.apiKeyHeader }, result });

        await selectThinking(page, 'none');
        before = wire.count();
        await lookup(page);
        request = wire.last();
        const noneThinking = request && request.thinking;
        await selectThinking(page, 'auto');
        before = wire.count();
        await lookup(page);
        request = wire.last();
        await setForceRefresh(page, false);
        check('D20', 'Anthropic 的 none 與 auto 都不帶 thinking 欄位，且溫度回到一般值',
            noneThinking === null && request && request.thinking === null && request.temperature !== 1,
            { noneThinking, autoThinking: request && request.thinking, autoTemperature: request && request.temperature });

        // ---------------------------------------------------------- D21-D23 task boundaries
        await selectModel(page, 'managed-main:shared-model');
        await selectThinking(page, 'high');
        await setQuery(page, { text: 'plunge down', sentence: '' });
        await openAI(page);
        state = await controls(page);
        const phraseSummaryTask = await page.evaluate(async () => {
            const module = await import('./modules/extension-ai-runtime.js');
            return module.getExtensionLookupTask({ text: 'plunge down' });
        });
        wire.reset();
        await lookup(page);
        request = wire.last();
        check('D21', '短語查詞沒有自己的設定時，依設計沿用帳戶 wordAnalysis 的模型與思考',
            phraseSummaryTask === 'articlePhraseTranslation' && request && request.tag === 'phrase'
            && request.model === 'lab-model' && request.effort === 'low',
            { task: phraseSummaryTask, request: request && { tag: request.tag, model: request.model, effort: request.effort } });

        await selectModel(page, 'managed-backup:shared-model');
        await selectThinking(page, 'low');
        await lookup(page);
        request = wire.last();
        const phraseChoice = await taskSettings(page, 'articlePhraseTranslation');
        const lookupChoiceAfterPhrase = await taskSettings(page, 'wordAnalysis');
        check('D22', '短語覆寫只寫入 articlePhraseTranslation，獨立查詞覆寫保持原樣',
            request && request.provider === 'managed-backup' && request.model === 'shared-model' && request.effort === 'low'
            && phraseChoice.model === 'managed-backup:shared-model' && phraseChoice.modelOverride === 'managed-backup:shared-model'
            && phraseChoice.thinking === 'low' && phraseChoice.thinkingOverride === 'low'
            && lookupChoiceAfterPhrase.modelOverride === 'managed-main:shared-model' && lookupChoiceAfterPhrase.thinkingOverride === 'high',
            { request: request && { provider: request.provider, model: request.model, effort: request.effort }, phrase: { model: phraseChoice.model, thinking: phraseChoice.thinking }, lookup: { model: lookupChoiceAfterPhrase.model, thinking: lookupChoiceAfterPhrase.thinking } });

        await setQuery(page, { text: 'plunge', sentence: 'Markets plunge today.' });
        await openAI(page);
        state = await controls(page);
        await selectModel(page, 'managed-backup:alt-model');
        await selectThinking(page, 'medium');
        wire.reset();
        await lookup(page);
        request = wire.last();
        const wordChoice = await taskSettings(page, 'articleWordTranslation');
        const phraseChoiceAfterWord = await taskSettings(page, 'articlePhraseTranslation');
        const lookupChoiceAfterWord = await taskSettings(page, 'wordAnalysis');
        check('D23', '句中查詞的覆寫獨立保存並套用，短語與獨立查詞的覆寫不受影響',
            request && request.tag === 'wordInSentence' && request.provider === 'managed-backup'
            && request.model === 'alt-model' && request.effort === 'medium'
            && wordChoice.model === 'managed-backup:alt-model' && wordChoice.modelOverride === 'managed-backup:alt-model'
            && wordChoice.thinking === 'medium' && wordChoice.thinkingOverride === 'medium'
            && phraseChoiceAfterWord.modelOverride === 'managed-backup:shared-model'
            && lookupChoiceAfterWord.modelOverride === 'managed-main:shared-model',
            { request: request && { tag: request.tag, provider: request.provider, model: request.model, effort: request.effort }, word: { model: wordChoice.model, thinking: wordChoice.thinking }, phrase: phraseChoiceAfterWord.modelOverride, lookup: lookupChoiceAfterWord.modelOverride });

        // ---------------------------------------------------------- D24-D26 article tasks
        await selectTask(page, 'articleCleanup');
        state = await controls(page);
        await selectModel(page, 'managed-main:shared-model');
        await selectThinking(page, 'high');
        wire.reset();
        const cleanup = await page.evaluate(async () => {
            const module = await import('./modules/extension-ai-runtime.js');
            return module.runExtensionArticleTask({ page: { text: 'Markets plunge as investors worry.', pageTitle: 'Probe Article', pageUrl: 'https://example.test/a' } });
        });
        request = wire.last();
        check('D24', '文章擷取（articleCleanup）使用自己的模型與思考，並回傳清理後文章',
            request && request.tag === 'cleanup' && request.model === 'shared-model' && request.effort === 'high'
            && cleanup && /Probe Article/.test(cleanup.title || '') && (cleanup.body || '').length > 0,
            { request: request && { tag: request.tag, model: request.model, effort: request.effort }, title: cleanup && cleanup.title });

        await selectTask(page, 'articleParagraphTranslation');
        await selectModel(page, 'managed-backup:alt-model');
        await selectThinking(page, 'medium');
        wire.reset();
        const paragraphs = await page.evaluate(async () => {
            const module = await import('./modules/extension-ai-runtime.js');
            return module.runExtensionArticleTask({ analyze: true, article: { body: 'First block.\n\nSecond block.' } });
        });
        const paragraphRequests = wire.state.requests.filter((entry) => entry.tag === 'paragraph');
        check('D25', '逐段翻譯每個段落都使用所選模型與思考程度',
            paragraphRequests.length === 2 && paragraphRequests.every((entry) => entry.model === 'alt-model' && entry.effort === 'medium')
            && paragraphs && paragraphs.paragraph_analysis && paragraphs.paragraph_analysis.length === 2,
            { requests: paragraphRequests.map((entry) => ({ model: entry.model, effort: entry.effort })), blocks: paragraphs && paragraphs.paragraph_analysis && paragraphs.paragraph_analysis.length });

        wire.state.delayMs = 450;
        wire.reset();
        await page.evaluate(() => {
            globalThis.__freezeRun = (async () => {
                const module = await import('./modules/extension-ai-runtime.js');
                return module.runExtensionArticleTask({ analyze: true, article: { body: 'Alpha block.\n\nBeta block.' } });
            })();
        });
        await page.waitForFunction(() => true);
        // Wait until the first paragraph request is in flight, then change the
        // stored choice before the second block is sent.
        for (let i = 0; i < 60 && wire.state.requests.filter((entry) => entry.tag === 'paragraph').length < 1; i += 1) await sleep(50);
        await page.evaluate(async () => {
            const module = await import('./modules/extension-ai-runtime.js');
            module.setExtensionAITaskSettings('articleParagraphTranslation', { model: 'managed-main:main-model', thinking: 'none' });
        });
        await page.evaluate(() => globalThis.__freezeRun);
        wire.state.delayMs = 0;
        const frozen = wire.state.requests.filter((entry) => entry.tag === 'paragraph');
        const afterFreeze = await taskSettings(page, 'articleParagraphTranslation');
        check('D26', '多段操作期間變更選擇不會影響本次請求：整批仍用開始時的模型與思考',
            frozen.length === 2 && frozen.every((entry) => entry.model === 'alt-model' && entry.effort === 'medium')
            && afterFreeze.model === 'managed-main:main-model' && afterFreeze.thinking === 'none',
            { requests: frozen.map((entry) => ({ model: entry.model, effort: entry.effort })), next: { model: afterFreeze.model, thinking: afterFreeze.thinking } });

        // ---------------------------------------------------------- D27-D29 reset
        await selectTask(page, 'lookup');
        await setQuery(page, { text: 'plunge', sentence: '' });
        await openAI(page);
        await selectTask(page, 'articleCleanup');
        await page.waitForTimeout(80);
        await page.locator('#ext-ai-reset').click();
        await page.waitForTimeout(120);
        const cleanupReset = await controls(page);
        const cleanupResetChoice = await taskSettings(page, 'articleCleanup');
        const paragraphAfterReset = await taskSettings(page, 'articleParagraphTranslation');
        check('D27', '恢復文章擷取的帳戶設定：移除該用途覆寫，其他用途覆寫保留',
            cleanupReset.model === 'personal-lab:lab-model' && cleanupReset.thinking === 'auto'
            && cleanupReset.resetDisabled === true && /已恢复/.test(cleanupReset.notice)
            && cleanupResetChoice.hasOverride === false && cleanupResetChoice.modelOverride === '' && cleanupResetChoice.thinkingOverride === ''
            && paragraphAfterReset.modelOverride === 'managed-main:main-model',
            { after: { model: cleanupReset.model, thinking: cleanupReset.thinking, notice: cleanupReset.notice }, cleanup: cleanupResetChoice.modelOverride, paragraph: paragraphAfterReset.modelOverride });

        await page.locator('#ext-ai-task').selectOption('lookup');
        await page.waitForTimeout(80);
        await selectModel(page, 'managed-main:shared-model');
        await selectThinking(page, 'high');
        await page.locator('#ext-ai-reset').click();
        await page.waitForTimeout(150);
        state = await controls(page);
        check('D28', '恢復查詞設定會回到帳戶的個人模型與帳戶思考程度（而非寫死預設）',
            state.model === 'personal-lab:lab-model' && state.thinking === 'low',
            { model: state.model, thinking: state.thinking });

        wire.reset();
        await setForceRefresh(page, true);
        await lookup(page);
        await setForceRefresh(page, false);
        request = wire.last();
        check('D29', '恢復後下一次查詞實際使用帳戶設定（個人供應商、low）',
            request && request.provider === 'personal-lab' && request.model === 'lab-model' && request.effort === 'low',
            request && { provider: request.provider, model: request.model, effort: request.effort });

        // ---------------------------------------------------------- D30-D31 displayed result untouched
        await selectModel(page, 'managed-main:shared-model');
        await selectThinking(page, 'high');
        await lookup(page);
        const shown = await controls(page);
        const requestsAfterLookup = wire.count();
        await selectModel(page, 'managed-backup:alt-model');
        await selectThinking(page, 'low');
        await page.waitForTimeout(250);
        const afterChange = await controls(page);
        check('D30', '變更選擇不會自動重查，也不改寫已展示的結果',
            wire.count() === requestsAfterLookup && afterChange.resultVisible === shown.resultVisible
            && afterChange.resultMeaning === shown.resultMeaning && afterChange.resultMeaning.length > 0,
            { before: shown.resultMeaning, after: afterChange.resultMeaning, requests: wire.count() - requestsAfterLookup });

        wire.reset();
        await setForceRefresh(page, true);
        await page.locator('#ext-ai-requery').click();
        await page.waitForFunction(() => !document.querySelector('#ext-ai-requery').disabled && !document.querySelector('#ext-lookup-btn').disabled, null, { timeout: 30000 });
        await page.waitForTimeout(200);
        await setForceRefresh(page, false);
        request = wire.last();
        check('D31', '「用此設定重新查詞」才會以新選擇重新請求', request && request.provider === 'managed-backup' && request.effort === 'low', request && { provider: request.provider, model: request.model, effort: request.effort });

        // ---------------------------------------------------------- D31A/D31B write boundaries
        const snapshotResponse = await fetch(env.base + '/snapshot', { headers: { Authorization: `Bearer ${ALICE}` } });
        const snapshotJson = await snapshotResponse.json();
        const snapshotMapping = snapshotJson?.payload?.aiSettings?.settings?.tasks?.wordAnalysis;
        const profileBlob = await profile(page);
        const profileText = JSON.stringify(profileBlob);
        check('D31A', '擴充套件的模型/思考選擇不會寫回雲端 snapshot，也不會改寫帳戶 profile 的用途對應',
            snapshotJson?.version === 1 && snapshotMapping === 'personal-lab:lab-model'
            && Object.values(profileBlob).some((entry) => entry.taskModels?.wordAnalysis === 'personal-lab:lab-model')
            && !profileText.includes('bdc_extension_ai_preferences'),
            { version: snapshotJson?.version, snapshotMapping, profileHasTaskMapping: Object.values(profileBlob).some((entry) => entry.taskModels?.wordAnalysis === 'personal-lab:lab-model') });

        const chromeStorage = await page.evaluate(() => new Promise((resolve) => chrome.storage.local.get(null, resolve)));
        const chromeText = JSON.stringify(chromeStorage);
        check('D31B', 'chrome.storage.local 不保存偏好、AI 金鑰或帳號 token',
            !/bdc_extension_ai_preferences|bdc_ai_profile_v1|apiKey|api_key/.test(chromeText)
            && ![ALICE, BOB, MANAGED_KEY, LAB_KEY, ANTH_KEY].some((secret) => chromeText.includes(secret)),
            Object.keys(chromeStorage));

        // ---------------------------------------------------------- D32-D34 save failures
        await openAI(page);
        await selectTask(page, 'lookup');
        await page.waitForTimeout(80);
        await page.locator('#ext-ai-model').selectOption('managed-main:main-model');
        await page.waitForTimeout(120);
        const savedModel = (await controls(page)).model;
        const savedChoiceBeforeFailure = await taskSettings(page, 'wordAnalysis');
        await page.evaluate(() => {
            const key = Object.keys(localStorage).find((name) => name.startsWith('bdc_extension_ai_preferences_v1:'));
            globalThis.__originalSetItem = Storage.prototype.setItem;
            globalThis.__prefsKey = key || '';
            Storage.prototype.setItem = function (name, value) {
                if (name.startsWith('bdc_extension_ai_preferences_v1:')) throw new DOMException('quota', 'QuotaExceededError');
                return globalThis.__originalSetItem.call(this, name, value);
            };
        });
        await page.locator('#ext-ai-model').selectOption('managed-backup:alt-model');
        await page.waitForTimeout(150);
        const throwingState = await controls(page);
        const throwingChoice = await taskSettings(page, 'wordAnalysis');
        await page.evaluate(() => {
            Storage.prototype.setItem = function (name, value) {
                if (name.startsWith('bdc_extension_ai_preferences_v1:')) return;
                return globalThis.__originalSetItem.call(this, name, value);
            };
        });
        await page.locator('#ext-ai-model').selectOption('managed-main:shared-model');
        await page.waitForTimeout(150);
        const silentState = await controls(page);
        const silentChoice = await taskSettings(page, 'wordAnalysis');
        await page.evaluate(() => { Storage.prototype.setItem = globalThis.__originalSetItem; });
        await page.locator('#ext-ai-model').selectOption('managed-main:main-model');
        await page.waitForTimeout(150);
        const recoveredState = await controls(page);
        check('D32', '寫入拋錯時顯示失敗、不顯示成功，選單回到已保存值',
            /未能保存/.test(throwingState.notice) && throwingState.noticeError === true
            && !/已保存/.test(throwingState.notice) && throwingState.model === savedModel
            && savedChoiceBeforeFailure.model === savedModel
            && throwingChoice.model === savedModel && throwingChoice.modelOverride === savedModel,
            { notice: throwingState.notice, model: throwingState.model, saved: savedModel, choice: { model: throwingChoice.model, override: throwingChoice.modelOverride } });
        check('D33', '寫入被吞掉（無異常也未落盤）同樣判定失敗，不假成功',
            /未能保存/.test(silentState.notice) && silentState.noticeError === true && silentState.model === savedModel
            && silentChoice.model === savedModel && silentChoice.modelOverride === savedModel,
            { notice: silentState.notice, model: silentState.model, choice: { model: silentChoice.model, override: silentChoice.modelOverride } });
        check('D34', '儲存恢復正常後可重新保存並顯示成功（使用者可自救）',
            recoveredState.model === 'managed-main:main-model' && /已保存/.test(recoveredState.notice) && recoveredState.noticeError === false,
            { model: recoveredState.model, notice: recoveredState.notice });

        // ---------------------------------------------------------- D35-D36 busy / async state
        wire.reset();
        wire.state.delayMs = 1100;
        await selectThinking(page, 'high');
        await page.waitForTimeout(120);
        await page.locator('#ext-lookup-btn').click();
        await page.waitForTimeout(150);
        const busy = await controls(page);
        await selectThinking(page, 'low');
        await page.waitForFunction(() => !document.querySelector('#ext-lookup-btn').disabled, null, { timeout: 30000 });
        await page.waitForTimeout(150);
        const inFlight = wire.state.requests[0];
        const afterBusy = await controls(page);
        wire.state.delayMs = 0;
        check('D35', '查詞進行中：重新查詞按鈕停用、恢復按鈕可用，控制項仍可操作',
            busy.requeryDisabled === true && busy.resetDisabled === false && busy.thinking === 'high', busy);
        check('D36', '進行中的請求沿用送出當下的思考程度，完成後才以新選擇重查',
            inFlight && inFlight.effort === 'high' && wire.count() === 1 && afterBusy.thinking === 'low' && inFlight.tag === 'word',
            { inFlight: inFlight && { tag: inFlight.tag, effort: inFlight.effort }, count: wire.count(), now: afterBusy.thinking });
        await lookup(page);
        check('D37', '完成後的下一次查詞使用新的思考程度', wire.last().effort === 'low', wire.last() && wire.last().effort);

        // ---------------------------------------------------------- D38-D39 cross tab storage
        const tab2 = await context.newPage();
        await tab2.goto(base + '/lookup.html');
        await tab2.waitForFunction(() => !!document.querySelector('#ext-account-status').textContent, null, { timeout: 20000 });
        await tab2.evaluate(async () => {
            const module = await import('./modules/extension-ai-runtime.js');
            await module.syncExtensionAccountAI();
        });
        await tab2.waitForTimeout(300);
        await tab2.locator('#ext-word-input').fill('plunge');
        await tab2.waitForTimeout(200);
        await openAI(tab2);
        await page.bringToFront();
        await openAI(page);
        await selectModel(page, 'managed-backup:alt-model');
        await selectThinking(page, 'medium');
        await page.waitForTimeout(400);
        const tab2State = await controls(tab2);
        check('D38', '另一分頁未重新載入也會經 storage 事件同步模型與思考',
            tab2State.model === 'managed-backup:alt-model' && tab2State.thinking === 'medium', { model: tab2State.model, thinking: tab2State.thinking });

        await selectTask(tab2, 'articleCleanup');
        await tab2.waitForTimeout(120);
        await tab2.locator('#ext-ai-model').selectOption('managed-main:main-model');
        await tab2.waitForTimeout(400);
        const tab1State = await controls(page);
        const mergedLookup = await taskSettings(page, 'wordAnalysis');
        const mergedCleanupOnTab1 = await taskSettings(page, 'articleCleanup');
        const mergedCleanupOnTab2 = await taskSettings(tab2, 'articleCleanup');
        check('D39', '兩個分頁分別修改不同用途時以讀改寫合併，不丟失彼此的覆寫',
            mergedLookup.model === 'managed-backup:alt-model' && mergedLookup.thinking === 'medium'
            && mergedLookup.modelOverride === 'managed-backup:alt-model' && mergedLookup.thinkingOverride === 'medium'
            && mergedCleanupOnTab2.modelOverride === 'managed-main:main-model'
            && mergedCleanupOnTab1.modelOverride === 'managed-main:main-model'
            && tab1State.model === 'managed-backup:alt-model' && tab1State.thinking === 'medium',
            { tab1: { model: tab1State.model, thinking: tab1State.thinking }, lookup: mergedLookup.modelOverride, cleanupTab1: mergedCleanupOnTab1.modelOverride, cleanupTab2: mergedCleanupOnTab2.modelOverride });
        await tab2.close();

        // ---------------------------------------------------------- D40 logout mid-flight
        wire.reset();
        wire.state.delayMs = 1000;
        await page.locator('#ext-lookup-btn').click();
        await page.waitForTimeout(150);
        await openAccount(page);
        await page.locator('#ext-logout-btn').click();
        await page.waitForTimeout(1500);
        wire.state.delayMs = 0;
        const afterLogout = await controls(page);
        check('D40', '查詞途中登出：遲到的結果被丟棄、不顯示內容，控制項回到停用',
            afterLogout.resultVisible === false && afterLogout.thinkingDisabled === true
            && /未登录|未連接|未连接/.test(afterLogout.accountStatus) && wire.count() >= 1,
            { resultVisible: afterLogout.resultVisible, status: afterLogout.accountStatus, requests: wire.count() });

        // ---------------------------------------------------------- D41-D43 account isolation
        await login(page, env.base, BOB, 'bob');
        await page.waitForTimeout(400);
        await openAI(page);
        state = await controls(page);
        const bobDefaults = { model: state.model, thinking: state.thinking };
        await selectModel(page, 'managed-backup:shared-model');
        await selectThinking(page, 'auto');
        await page.waitForTimeout(150);
        const bobPrefs = await prefs(page);
        const aliceScopes = scopeKeys(bobPrefs).filter((key) => key.includes('alice'));
        const bobScopes = scopeKeys(bobPrefs).filter((key) => key.includes('bob'));
        const bobChoice = await taskSettings(page, 'wordAnalysis');
        check('D41', '切換到另一個帳戶：不沿用前一帳戶的模型與思考，且偏好以帳戶分鍵',
            bobDefaults.model === 'managed-main:main-model' && bobDefaults.thinking === 'none'
            && aliceScopes.length === 1 && bobScopes.length === 1 && aliceScopes[0] !== bobScopes[0]
            && bobChoice.modelOverride === 'managed-backup:shared-model' && bobChoice.thinkingOverride === 'auto',
            { bobDefaults, aliceScopes, bobScopes, bobChoice: { model: bobChoice.modelOverride, thinking: bobChoice.thinkingOverride } });
        await logout(page);
        await login(page, env.base, ALICE, 'alice');
        await page.waitForTimeout(400);
        await openAI(page);
        await setQuery(page, { text: 'plunge', sentence: '' });
        state = await controls(page);
        check('D42', '切回原帳戶恢復自己的覆寫，未套用其他帳戶的選擇',
            state.model === 'managed-backup:alt-model' && state.thinking === 'medium',
            { model: state.model, thinking: state.thinking });

        const rejection = await callRuntime(page, 'setExtensionAITaskSettings', 'wordAnalysis', { model: 'managed-main:not-in-allowlist' });
        const invalidThinking = await callRuntime(page, 'setExtensionAITaskSettings', 'wordAnalysis', { thinking: 'extreme' });
        const invalidTask = await callRuntime(page, 'getExtensionAITaskSettings', 'tokenBudget');
        check('D43', '模組層面拒絕不在允許清單的模型、非法思考值與未知用途',
            rejection.ok === false && rejection.code === 'model_not_allowed'
            && invalidThinking.ok === false && invalidThinking.code === 'invalid_thinking'
            && invalidTask.ok === false && invalidTask.code === 'invalid_task',
            { rejection, invalidThinking, invalidTask });

        // ---------------------------------------------------------- D44 endpoint scope isolation
        // A second real Worker/SQLite endpoint with its own catalog. Same ALICE
        // token and user id, different endpoint: choices must not leak.
        envB = await environment();
        await publishCatalog(envB.base, 1, [{
            id: 'managed-other', name: 'Other', enabled: true, order: 0, format: 'openai-chat',
            apiUrl: envB.base + '/probe-main/v1/chat/completions', modelsUrl: envB.base + '/probe-main/v1/models',
            authMode: 'bearer', models: [{ id: 'other-model' }]
        }], tasksFor('managed-other', 'other-model'), { 'managed-other': { action: 'replace', apiKey: MANAGED_KEY } });
        await logout(page);
        // Trailing slash on purpose: the scope key must normalise the endpoint.
        await login(page, envB.base + '/', ALICE, 'alice');
        await page.waitForTimeout(500);
        await openAI(page);
        await setQuery(page, { text: 'plunge', sentence: '' });
        const endpointB = await controls(page);
        await selectModel(page, 'managed-other:other-model');
        await selectThinking(page, 'high');
        await page.waitForTimeout(150);
        const prefsB = await prefs(page);
        const aliceScopesB = scopeKeys(prefsB).filter((key) => key.includes('alice'));
        const endpointScopes = aliceScopesB.map((key) => JSON.parse(key.slice(key.indexOf('['), key.lastIndexOf(']') + 1))[0]).sort();
        check('D44', '同一帳戶在不同 endpoint 不共用偏好，預設回到該 endpoint 的目錄設定',
            endpointB.model === 'managed-other:other-model' && endpointB.thinking !== 'medium'
            && aliceScopesB.length === 2 && JSON.stringify(endpointScopes) === JSON.stringify([env.base, envB.base].sort()),
            { model: endpointB.model, thinking: endpointB.thinking, endpointScopes });

        await logout(page);
        await login(page, env.base, ALICE, 'alice');
        await page.waitForTimeout(600);
        await openAI(page);
        await setQuery(page, { text: 'plunge', sentence: '' });
        state = await controls(page);
        check('D45', '回到原 endpoint 後自己的偏好仍在，且未混入另一 endpoint 的設定',
            state.model === 'managed-backup:alt-model' && state.thinking === 'medium',
            { model: state.model, thinking: state.thinking });

        // ---------------------------------------------------------- D46-D48 catalog removal
        await selectModel(page, 'managed-main:shared-model');
        await selectThinking(page, 'high');
        wire.reset();
        await setForceRefresh(page, true);
        result = await lookup(page);
        await setForceRefresh(page, false);
        request = wire.last();
        check('D46', '移除供應商前：覆寫的 managed 模型可正常查詞', request && request.provider === 'managed-main' && request.model === 'shared-model' && result.visible,
            request && { provider: request.provider, model: request.model });

        // managed-main disappears; managed-backup keeps the same model id.
        await publishCatalog(env.base, 2, [providersFor(env.base)[1]], tasksFor('managed-backup', 'shared-model'),
            { 'managed-backup': { action: 'replace', apiKey: MANAGED_KEY } }, 'deepseek-ai-controls-remove-main');
        await openAccount(page);
        await page.locator('#ext-sync-btn').click();
        await page.waitForFunction(() => !document.querySelector('#ext-sync-btn').disabled, null, { timeout: 30000 });
        await page.waitForTimeout(500);
        await openAI(page);
        state = await controls(page);
        const unavailableOption = state.modelOptions.find((option) => option.value === 'managed-main:shared-model');
        const removedChoice = await taskSettings(page, 'wordAnalysis');
        check('D47', '模型被管理員移除後，選擇器標示為不可用且不改寫已保存的選擇（不靜默換供應商）',
            state.model === 'managed-main:shared-model' && unavailableOption && unavailableOption.disabled
            && /不可用|无法使用/.test(unavailableOption.label)
            && removedChoice.model === 'managed-main:shared-model' && removedChoice.modelOverride === 'managed-main:shared-model',
            { model: state.model, unavailable: unavailableOption, choice: { model: removedChoice.model, override: removedChoice.modelOverride } });

        wire.reset();
        const unavailableResult = await lookup(page);
        check('D48', '已移除的模型查詞時明確報錯，且不會把同名的另一供應商模型當成後備',
            wire.count() === 0 && /不存在|停用|不可用/.test(unavailableResult.notice) && unavailableResult.visible === false,
            { requests: wire.count(), notice: unavailableResult.notice });

        await selectModel(page, 'managed-backup:shared-model');
        wire.reset();
        const recoveredResult = await lookup(page);
        request = wire.last();
        check('D49', '使用者改選仍可用的模型後可繼續查詞（錯誤可自救）',
            request && request.provider === 'managed-backup' && request.model === 'shared-model' && recoveredResult.visible,
            { request: request && { provider: request.provider, model: request.model }, result: recoveredResult.visible });

        // ---------------------------------------------------------- D50-D51 late 401
        const snapshotRoute = async (route) => {
            await sleep(700);
            await route.fulfill({ status: 401, headers: CORS, body: '{"error":"unauthorized","code":"unauthorized"}' });
        };
        await context.route('**/snapshot', snapshotRoute);
        await openAccount(page);
        const prefsBeforeLate401 = Object.keys(await prefs(page)).sort();
        await page.locator('#ext-sync-btn').click();
        await page.waitForTimeout(120);
        await page.locator('#ext-logout-btn').click();
        await page.waitForTimeout(1500);
        await context.unroute('**/snapshot', snapshotRoute);
        const afterLate401 = await controls(page);
        const prefsAfterLate401 = await prefs(page);
        const late401Keys = Object.keys(prefsAfterLate401).sort();
        check('D50', '登出後遲到的 401 不會恢復登入狀態、不會寫入偏好，也不會拋出頁面錯誤',
            /未登录|未連接|未连接/.test(afterLate401.accountStatus) && afterLate401.thinkingDisabled === true
            && pageErrors.length === 0
            && JSON.stringify(late401Keys) === JSON.stringify(prefsBeforeLate401)
            && !late401Keys.some((key) => key.includes('device:guest')),
            { status: afterLate401.accountStatus, pageErrors, keysUnchanged: JSON.stringify(late401Keys) === JSON.stringify(prefsBeforeLate401) });

        await login(page, env.base, ALICE, 'alice');
        await page.waitForTimeout(500);
        await openAI(page);
        await setQuery(page, { text: 'plunge', sentence: '' });
        state = await controls(page);
        check('D51', '遲到 401 之後可重新登入並取回先前的偏好（可自救）',
            state.model === 'managed-backup:shared-model' && state.thinking === 'high',
            { model: state.model, thinking: state.thinking });

        // ---------------------------------------------------------- D56 no silent fallback
        await setQuery(page, { text: 'volatile', sentence: '' });
        await openAI(page);
        await selectModel(page, 'managed-backup:alt-model');
        await selectThinking(page, 'high');
        wire.reset();
        wire.state.rejectAll = { count: 5 };
        result = await lookup(page);
        const explicitFailRun = wire.state.requests.slice();
        check('D56', '明確選定模型失敗時直接報錯，不會改用其他模型或供應商（無靜默 fallback）',
            explicitFailRun.length === 1 && explicitFailRun[0].provider === 'managed-backup'
            && explicitFailRun.every((entry) => entry.model === 'alt-model')
            && result.visible === false && result.notice.length > 0,
            { requests: explicitFailRun.map((entry) => ({ provider: entry.provider, model: entry.model })), notice: result.notice });
        wire.state.rejectAll = null;

        // ---------------------------------------------------------- D57 cache is per account
        await logout(page);
        await login(page, env.base, BOB, 'bob');
        await page.waitForTimeout(400);
        await page.locator('#ext-word-input').fill('plunge');
        await page.waitForTimeout(120);
        await openAI(page);
        await selectModel(page, 'managed-backup:shared-model');
        await selectThinking(page, 'high');
        wire.reset();
        await lookup(page);
        const bobFirst = wire.count();
        await lookup(page);
        const bobSecond = wire.count();
        check('D57', '快取不跨帳戶：同字同模型同思考在另一帳戶仍會重新請求，之後才命中自己的快取',
            bobFirst === 1 && bobSecond === 1,
            { bobFirst, bobSecond });
        await logout(page);
        await login(page, env.base, ALICE, 'alice');
        await page.waitForTimeout(400);
        await openAI(page);
        await setQuery(page, { text: 'plunge', sentence: '' });
        await selectModel(page, 'managed-backup:shared-model');
        await selectThinking(page, 'high');
        await page.waitForTimeout(150);

        // ---------------------------------------------------------- D58 account change + reset
        await seedAccountAISettings(env.base, ALICE, {
            providers: {
                'personal-lab': {
                    label: 'Lab', enabled: true, format: 'openai-chat', authMode: 'bearer',
                    apiUrl: env.base + '/probe-personal/v1/chat/completions',
                    modelsUrl: env.base + '/probe-personal/v1/models',
                    allowedModels: ['lab-model']
                },
                'personal-anth': {
                    label: 'Anthropic Lab', enabled: true, format: 'anthropic-messages', authMode: 'x-api-key',
                    apiUrl: env.base + '/probe-anth/v1/messages',
                    modelsUrl: env.base + '/probe-anth/v1/models',
                    allowedModels: ['anth-model']
                }
            },
            tasks: { wordAnalysis: 'managed-backup:alt-model' },
            thinking: { wordAnalysis: 'medium', articleCleanup: 'high' }
        }, 1);
        wire.reset();
        await openAccount(page);
        await page.locator('#ext-sync-btn').click();
        await page.waitForFunction(() => !document.querySelector('#ext-sync-btn').disabled, null, { timeout: 30000 });
        await page.waitForTimeout(500);
        await openAI(page);
        state = await controls(page);
        const syncedOverride = { model: state.model, thinking: state.thinking };
        check('D58', '重新同步帳戶資料不會覆蓋擴充套件已保存的選擇',
            syncedOverride.model === 'managed-backup:shared-model' && syncedOverride.thinking === 'high' && wire.count() === 0,
            { after: syncedOverride, requests: wire.count() });

        await page.locator('#ext-ai-reset').click();
        await page.waitForTimeout(200);
        state = await controls(page);
        check('D59', '恢復帳戶設定會跟上帳戶最新變更（模型與思考都採用帳戶新值）',
            state.model === 'managed-backup:alt-model' && state.thinking === 'medium',
            { model: state.model, thinking: state.thinking });
        wire.reset();
        await setForceRefresh(page, true);
        await lookup(page);
        await setForceRefresh(page, false);
        request = wire.last();
        check('D60', '跟上帳戶後下一次請求實際使用新的帳戶模型與思考程度',
            request && request.provider === 'managed-backup' && request.model === 'alt-model' && request.effort === 'medium',
            request && { provider: request.provider, model: request.model, effort: request.effort });

        // ---------------------------------------------------------- D61 stale article override after removal
        await selectTask(page, 'articleCleanup');
        const staleCleanupSettings = await taskSettings(page, 'articleCleanup');
        wire.reset();
        const staleCleanup = await page.evaluate(async () => {
            const module = await import('./modules/extension-ai-runtime.js');
            try {
                await module.runExtensionArticleTask({ page: { text: 'Markets plunge as investors worry.', pageTitle: 'Probe Article', pageUrl: 'https://example.test/b' } });
                return { ok: true };
            } catch (error) {
                return { ok: false, code: error?.code || '', message: String(error?.message || '') };
            }
        });
        check('D61', '文章擷取沿用了已被移除的供應商設定時明確失敗，不會改用其他供應商',
            staleCleanupSettings.model === 'managed-main:main-model' && staleCleanup.ok === false
            && /provider_missing|model_not_allowed/.test(staleCleanup.code) && wire.count() === 0,
            { model: staleCleanupSettings.model, error: staleCleanup, requests: wire.count() });

        await page.locator('#ext-ai-reset').click();
        await page.waitForTimeout(200);
        const cleanupAccountSettings = await controls(page);
        wire.reset();
        const cleanupAfterReset = await page.evaluate(async () => {
            const module = await import('./modules/extension-ai-runtime.js');
            return module.runExtensionArticleTask({ page: { text: 'Markets plunge as investors worry.', pageTitle: 'Probe Article', pageUrl: 'https://example.test/b' } });
        });
        request = wire.last();
        check('D62', '恢復帳戶設定後文章擷取可繼續，並套用帳戶的 articleCleanup 思考程度',
            cleanupAccountSettings.thinking === 'high' && request && request.tag === 'cleanup'
            && request.model === 'alt-model' && request.effort === 'high' && cleanupAfterReset && /Probe Article/.test(cleanupAfterReset.title || ''),
            { thinking: cleanupAccountSettings.thinking, request: request && { tag: request.tag, model: request.model, effort: request.effort } });

        // ---------------------------------------------------------- D63 reload retention
        await selectTask(page, 'lookup');
        await page.waitForTimeout(120);
        await page.locator('#ext-ai-model').selectOption('managed-backup:shared-model');
        await page.waitForTimeout(100);
        await page.locator('#ext-ai-thinking').selectOption('low');
        await page.waitForTimeout(150);
        const beforeReload = await controls(page);
        wire.reset();
        await page.reload();
        await page.waitForFunction(() => !!document.querySelector('#ext-account-status').textContent && document.querySelector('#ext-account-status').textContent.includes('alice'), null, { timeout: 30000 });
        await page.waitForTimeout(500);
        await page.locator('#ext-word-input').fill('plunge');
        await page.waitForTimeout(150);
        await openAI(page);
        state = await controls(page);
        check('D63', '重新開啟頁面仍保留按帳戶保存的模型與思考，且不會因此發出請求',
            state.model === beforeReload.model && state.thinking === beforeReload.thinking && wire.count() === 0,
            { model: state.model, thinking: state.thinking, requests: wire.count() });

        // ---------------------------------------------------------- D64 cross-page concurrency (O1)
        // Choices are stored one localStorage key per task+field, so two browser
        // pages editing unrelated tasks - or unrelated fields of the same task -
        // at the same instant must both survive. Every read goes through the
        // product runtime of each page: raw localStorage cannot tell scopes
        // apart, and the previous `Object.values(prefs)[0]` read could land on a
        // different endpoint's group and prove nothing about the real loss.
        const raceTab = await context.newPage();
        await raceTab.goto(base + '/lookup.html');
        await raceTab.waitForFunction(() => !!document.querySelector('#ext-account-status').textContent && document.querySelector('#ext-account-status').textContent.includes('alice'), null, { timeout: 30000 });
        await raceTab.evaluate(async () => { const module = await import('./modules/extension-ai-runtime.js'); await module.syncExtensionAccountAI(); });
        await raceTab.waitForTimeout(300);
        await openAI(page);
        await openAI(raceTab);
        const raceBaseline = await taskSettings(page, 'wordAnalysis');
        const crossTaskRounds = 4;
        const sameTaskRounds = 4;
        let lostCrossTask = 0, lostSameTask = 0, bothClaimedSaved = 0;
        const raceRounds = [];
        for (let round = 0; round < crossTaskRounds; round += 1) {
            await selectTask(page, 'articleCleanup');
            await selectTask(raceTab, 'articleParagraphTranslation');
            const cleanupModel = round % 2 === 0 ? 'managed-backup:shared-model' : 'managed-backup:alt-model';
            const paragraphModel = round % 2 === 0 ? 'managed-backup:alt-model' : 'managed-backup:shared-model';
            await Promise.all([selectModel(page, cleanupModel), selectModel(raceTab, paragraphModel)]);
            await page.waitForTimeout(300);
            const onPage = await Promise.all([taskSettings(page, 'articleCleanup'), taskSettings(page, 'articleParagraphTranslation')]);
            const onTab = await Promise.all([taskSettings(raceTab, 'articleCleanup'), taskSettings(raceTab, 'articleParagraphTranslation')]);
            const ok = onPage[0].modelOverride === cleanupModel && onTab[0].modelOverride === cleanupModel
                && onPage[1].modelOverride === paragraphModel && onTab[1].modelOverride === paragraphModel;
            if (!ok) lostCrossTask += 1;
            const notices = [await controls(page), await controls(raceTab)];
            if (/已保存|已儲存/.test(notices[0].notice) && /已保存|已儲存/.test(notices[1].notice)) bothClaimedSaved += 1;
            raceRounds.push({ round: 'cross-task ' + round, ok, cleanup: [onPage[0].modelOverride, onTab[0].modelOverride], paragraph: [onPage[1].modelOverride, onTab[1].modelOverride] });
        }
        for (let round = 0; round < sameTaskRounds; round += 1) {
            await selectTask(page, 'articleCleanup');
            await selectTask(raceTab, 'articleCleanup');
            const model = round % 2 === 0 ? 'managed-backup:shared-model' : 'managed-backup:alt-model';
            const thinking = round % 2 === 0 ? 'medium' : 'low';
            await Promise.all([selectModel(page, model), selectThinking(raceTab, thinking)]);
            await page.waitForTimeout(300);
            const onPage = await taskSettings(page, 'articleCleanup');
            const onTab = await taskSettings(raceTab, 'articleCleanup');
            const ok = onPage.modelOverride === model && onPage.thinkingOverride === thinking
                && onTab.modelOverride === model && onTab.thinkingOverride === thinking;
            if (!ok) lostSameTask += 1;
            const notices = [await controls(page), await controls(raceTab)];
            if (/已保存|已儲存/.test(notices[0].notice) && /已保存|已儲存/.test(notices[1].notice)) bothClaimedSaved += 1;
            raceRounds.push({ round: 'same-task ' + round, ok, model: [onPage.modelOverride, onTab.modelOverride], thinking: [onPage.thinkingOverride, onTab.thinkingOverride] });
        }
        const racePrefs = await prefs(page);
        const raceAliceScopes = scopeKeys(racePrefs).filter((key) => key.includes('alice'));
        const otherScope = raceAliceScopes.find((key) => key.includes(envB.base)) || '';
        const otherScopeFields = Object.keys(racePrefs).filter((key) => key.startsWith(otherScope)).map((key) => key.slice(otherScope.length));
        const raceAfter = await taskSettings(page, 'wordAnalysis');
        const lookupUnchanged = raceAfter.modelOverride === raceBaseline.modelOverride && raceAfter.thinkingOverride === raceBaseline.thinkingOverride;
        const splitKeys = Object.keys(racePrefs).some((key) => key.includes(':articleCleanup:model'));
        check('D64', '兩頁並行修改（不同用途、同用途不同欄位）都保留另一頁的選擇，且兩頁都顯示已保存',
            lostCrossTask === 0 && lostSameTask === 0 && lookupUnchanged && splitKeys
            && bothClaimedSaved === crossTaskRounds + sameTaskRounds
            && otherScopeFields.every((suffix) => !suffix.includes('article')),
            {
                rounds: { crossTaskRounds, sameTaskRounds, lostCrossTask, lostSameTask, bothClaimedSaved },
                lookupUnchanged, splitKeys, raceAliceScopes,
                otherScopeKeysUntouched: otherScopeFields.every((suffix) => !suffix.includes('article')),
                lost: raceRounds.filter((round) => !round.ok)
            });
        await raceTab.close();
        notes.push('cross-page concurrent write: ' + lostCrossTask + '/' + crossTaskRounds + ' cross-task rounds lost a choice, '
            + lostSameTask + '/' + sameTaskRounds + ' same-task different-field rounds lost a choice; both pages showed the saved notice in '
            + bothClaimedSaved + '/' + (crossTaskRounds + sameTaskRounds) + ' rounds; split per task/field keys present: ' + splitKeys
            + '; other endpoint scope untouched: ' + otherScopeFields.every((suffix) => !suffix.includes('article')));
        await selectTask(page, 'lookup');
        await page.waitForTimeout(100);

        // ---------------------------------------------------------- D65-D68 persistence hygiene + i18n
        const hygiene = await page.evaluate(() => {
            const entries = Object.fromEntries(Object.entries(localStorage));
            return entries;
        });
        const prefsValues = Object.entries(hygiene).filter(([key]) => key.startsWith('bdc_extension_ai_preferences_v1:'));
        const managedKeyPersisted = Object.values(hygiene).some((value) => String(value).includes(MANAGED_KEY));
        const shapeOk = prefsValues.every(([, value]) => {
            const parsed = JSON.parse(value);
            return Object.values(parsed).every((entry) => entry && typeof entry === 'object'
                && Object.keys(entry).every((field) => field === 'model' || field === 'thinking')
                && (entry.model === undefined || typeof entry.model === 'string'));
        });
        const secretsInPrefs = prefsValues.some(([, value]) => [ALICE, BOB, MANAGED_KEY, LAB_KEY, ANTH_KEY, 'Bearer', 'http://127.0.0.1', 'apiKey']
            .some((needle) => String(value).includes(needle)));
        check('D65', '偏好只保存 model/thinking，不含 token、金鑰或網址；managed 金鑰不落盤',
            !managedKeyPersisted && shapeOk && !secretsInPrefs && prefsValues.length > 0,
            { prefsCount: prefsValues.length, managedKeyPersisted, shapeOk, secretsInPrefs });
        check('D66', '偏好未建立 guest 範圍的鍵（登出狀態不會被當成可保存範圍）',
            !Object.keys(hygiene).some((key) => key.startsWith('bdc_extension_ai_preferences_v1:device:guest') || key.startsWith('bdc_extension_ai_preferences_v1:"')),
            Object.keys(hygiene).filter((key) => key.startsWith('bdc_extension_ai_preferences_v1:')));

        await page.locator('#ext-locale-select').selectOption('zh-HK');
        await page.waitForTimeout(350);
        await openAI(page);
        const hk = await controls(page);
        await page.screenshot({ path: path.join(OUT, 'controls-zh-HK.png'), fullPage: true });
        await selectThinking(page, 'medium');
        const hkNotice = (await controls(page)).notice;
        await page.locator('#ext-locale-select').selectOption('zh-CN');
        await page.waitForTimeout(350);
        await openAI(page);
        const cn = await controls(page);
        await page.screenshot({ path: path.join(OUT, 'controls-zh-CN.png'), fullPage: true });
        check('D67', '動態產生的控制項文案在 zh-CN / zh-HK 都有翻譯且隨語言切換（無 undefined）',
            hk.labels.model.length > 0 && hk.labels.task.length > 0
            && hk.summary.includes('AI 設定') && /已儲存/.test(hkNotice)
            && cn.summary.includes('AI 设置') && /已保存/.test(cn.notice)
            && !/undefined/.test(hk.summary + hkNotice + cn.summary + cn.notice),
            { hkSummary: hk.summary, hkNotice, cnSummary: cn.summary, cnNotice: cn.notice });

        // ---------------------------------------------------------- D69 tasks-only snapshot
        // A snapshot whose AI group carries the task mapping only under `tasks`
        // (no `models` mirror) must still yield the account's default. The
        // worker sanitizer always writes both keys, so this pins the applier's
        // handling of the shape that older/hand-written clients produce.
        await logout(page);
        const tasksOnlySeed = await fetch(env.base + '/snapshot', {
            method: 'POST',
            headers: { Authorization: `Bearer ${BOB}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                expected_version: 0,
                payload: {
                    aiSettings: {
                        updatedAt: '2026-11-06T01:00:00.000Z',
                        // Only the `tasks` key: no `models` mirror. The worker
                        // sanitizer fills `models` with {} for this shape.
                        settings: { providers: {}, tasks: { wordAnalysis: 'managed-backup:alt-model' }, thinking: { wordAnalysis: 'medium' } }
                    }
                }
            })
        });
        must('tasks-only snapshot seed', tasksOnlySeed.status === 200, { status: tasksOnlySeed.status, text: (await tasksOnlySeed.text()).slice(0, 200) });
        const tasksOnlyStored = await (await fetch(env.base + '/snapshot', { headers: { Authorization: `Bearer ${BOB}` } })).json();
        notes.push('tasks-only snapshot as stored by the worker: ' + JSON.stringify(tasksOnlyStored?.payload?.aiSettings?.settings || null).slice(0, 300));
        await login(page, env.base, BOB, 'bob');
        await page.waitForTimeout(500);
        await page.locator('#ext-word-input').fill('plunge');
        await page.waitForTimeout(150);
        await openAI(page);
        // Clear BOB's own earlier override so only the account snapshot remains.
        await page.locator('#ext-ai-reset').click();
        await page.waitForTimeout(250);
        const tasksOnly = await taskSettings(page, 'wordAnalysis');
        const tasksOnlyPrefs = await prefs(page);
        check('D69', '帳戶 snapshot 只帶 tasks 對應時，用途預設仍應套用帳戶的模型與思考',
            tasksOnly.model === 'managed-backup:alt-model' && tasksOnly.thinking === 'medium',
            { model: tasksOnly.model, thinking: tasksOnly.thinking, hasOverride: tasksOnly.hasOverride, prefs: tasksOnlyPrefs });

        // ---------------------------------------------------------- D73 (O2) account switch clears the hint
        // A fresh real rejection at a level this session never rejected (`low`),
        // so the hint is on screen right before the account changes.
        // `wire.reset()` must run before the rejection flag: it clears it.
        wire.reset();
        await selectThinking(page, 'low');
        wire.state.rejectEffort = 'low';
        await setForceRefresh(page, true);
        await closeAI(page);
        await lookup(page);
        const defaultScopeFallback = await fallbackNotice(page);
        const rejectRun = wire.state.requests.slice();
        await logout(page);
        await page.waitForTimeout(300);
        const afterLogoutFallback = await fallbackNotice(page);
        await setForceRefresh(page, false);
        wire.state.rejectEffort = '';
        check('D73', '登出／切換帳戶後降級提示立即清除，不會殘留誤導下一個帳戶',
            rejectRun.length === 2 && rejectRun[0].effort === 'low' && rejectRun[1].effort === null
            && defaultScopeFallback.visible && afterLogoutFallback.visible === false && afterLogoutFallback.text === '',
            { requests: rejectRun.map((entry) => entry.effort), before: { visible: defaultScopeFallback.visible, text: defaultScopeFallback.text }, after: { visible: afterLogoutFallback.visible, text: afterLogoutFallback.text } });
        check('D68', '全程沒有未捕捉的頁面錯誤', pageErrors.length === 0, pageErrors.slice(0, 5));

    } catch (error) {
        if (error && error.setup) {
            check('S00', '測試環境建置（必須先通過才能評估其餘項目）', false, { message: error.message });
        } else {
            console.error(error);
            check('S99', '測試腳本本身執行完成', false, { message: String(error && error.message || error), stack: String(error && error.stack || '').split('\n').slice(0, 4) });
        }
    } finally {
        const passed = checks.filter((item) => item.ok).length;
        summary = {
            ok: checks.length > 0 && passed === checks.length,
            stamp: STAMP,
            extensionVersion: JSON.parse(fs.readFileSync(path.join(ROOT, 'extension/manifest.json'), 'utf8')).version,
            featureBaseCommit: '03ce6b3',
            productRevision: (() => {
                const gitEnv = { ...process.env };
                delete gitEnv.GIT_CONFIG_COUNT;
                delete gitEnv.GIT_CONFIG_KEY_0;
                delete gitEnv.GIT_CONFIG_VALUE_0;
                try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', env: gitEnv }).trim(); }
                catch (_) { return ''; }
            })(),
            environment: { node: process.version, playwright: require(process.env.PLAYWRIGHT_MODULE
                ? path.join(process.env.PLAYWRIGHT_MODULE, 'package.json') : 'playwright').version },
            checks,
            totals: { total: checks.length, passed, failed: checks.length - passed },
            pageErrors,
            requests: wire.state.requests.map(({ provider, model, effort, thinking, maxTokens, tag, at }) => ({ provider, model, effort, thinking, maxTokens, tag, at })),
            fingerprints: {
                product: Object.fromEntries(['modules/extension-ai-preferences.js', 'extension/ai-controls.js', 'modules/extension-ai-runtime.js', 'modules/api.js', 'extension/modules/extension-ai-preferences.js']
                    .filter((file) => fs.existsSync(path.join(ROOT, file)))
                    .map((file) => [file, sha256(fs.readFileSync(path.join(ROOT, file)))])),
                suite: sha256(fs.readFileSync(__filename)),
                results: sha256(JSON.stringify(checks))
            },
            notes
        };
        fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(summary, null, 2));
        console.log(`\n${summary.ok ? 'ALL PASS' : 'FAILURES'} ${passed}/${checks.length} -> ${OUT}/results.json`);
        try { await context?.close(); } catch (_) {}
        try { await env?.close(); } catch (_) {}
        try { await envB?.close(); } catch (_) {}
        fs.rmSync(profileDir, { recursive: true, force: true });
    }
    if (!summary.ok) process.exitCode = 1;
})().catch((error) => { console.error(error); process.exitCode = 1; });
