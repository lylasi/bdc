// DeepSeek independent verification harness for the BDC MV3 extension (Step 1 proof).
//
// This file is NOT a replacement for tests/extension-ai-browser.cjs. It targets the
// specific regressions the controller asked to be proved independently, and it drives
// the REAL extension popup/options page (`chrome-extension://<id>/lookup.html`) with
// real DOM events (fill / selectOption / click) instead of globalThis helpers.
//
// Usage:
//   PLAYWRIGHT_MODULE=<path to playwright> node tests/extension-ai-verify-browser.cjs
//
// Each check states the DESIRED behaviour. A check that prints FAIL is a reproduced
// defect, not a harness failure. Exit code 1 means at least one defect was reproduced.
//
// Isolation: mock Worker + mock AI provider on a random 127.0.0.1 port, throwaway
// Chromium profile, no real account, no real API key, no private ai-config.js.

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { chromium } = require(
    process.env.PLAYWRIGHT_MODULE
    || 'playwright'
);

const ROOT = path.resolve(__dirname, '..');
const EXT_DIR = path.join(ROOT, 'extension');

execFileSync(process.execPath, [path.join(ROOT, 'scripts/package-extension.mjs')], { stdio: 'inherit' });

const results = [];
function check(name, ok, detail = '') {
    results.push({ name, ok: !!ok, detail: String(detail || '') });
    console.log(`${ok ? 'PASS' : 'FAIL'} · ${name}${detail ? '\n        ↳ ' + detail : ''}`);
}

function readJsonBody(req) {
    return new Promise((resolve) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (_) { resolve({}); } });
    });
}

const ARTICLE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Museum Visitor Guide</title></head>
<body><article id="guide">
<p id="p1">They charge £10 for admission. Remember to charge the battery.</p>
<p id="p2">Battery life matters on a long trip.</p>
</article></body></html>`;

async function startMockEnvironment() {
    const state = {
        allowedExtensionOrigin: '',
        baseUrl: '',
        workerRequests: [],
        providerRequests: [],
        holdNext: null,
        personalCredStatus: 200,
        badProviderJson: false,
        emptyProviderContent: false,
        snapshot401: false,
        users: {
            alice: { user_id: 'alice', label: 'Alice Reader', role: 'user', username: 'alice', password: 'pwd-alice-771', token: 'A'.repeat(40) },
            bob: { user_id: 'bob', label: 'Bob Reader', role: 'user', username: 'bob', password: 'pwd-bob-882', token: 'B'.repeat(40) }
        },
        // worker2 issues a DIFFERENT token for the same logical user so that sending a
        // worker2 token to worker1 is visible in the request log.
        worker2Tokens: { alice: 'A2'.repeat(20), bob: 'B2'.repeat(20) },
        snapshots: {},
        personalCredentials: { alice: {}, bob: {} }
    };

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const origin = req.headers.origin || '';
        const method = req.method.toUpperCase();

        const originAllowed = !state.allowedExtensionOrigin || !origin || origin === state.allowedExtensionOrigin;
        const corsHeaders = {
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Authorization, Content-Type',
            'Cache-Control': 'no-store'
        };
        if (origin && originAllowed) corsHeaders['Access-Control-Allow-Origin'] = origin;
        if (method === 'OPTIONS') { res.writeHead(originAllowed ? 204 : 403, corsHeaders); res.end(); return; }

        const sendJson = (status, data) => {
            res.writeHead(status, { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(data));
        };

        if (url.pathname === '/reading-article') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(ARTICLE_HTML);
            return;
        }

        if (url.pathname.startsWith('/provider')) {
            const body = await readJsonBody(req);
            const prompt = (body.messages || []).map((m) => m.content).join('\n');
            state.providerRequests.push({ path: url.pathname, auth: req.headers.authorization || '', prompt, origin });
            if (state.holdNext) {
                const gate = state.holdNext;
                state.holdNext = null;
                await gate;
            }
            const wordMatch = prompt.match(/Target word:\s*"([^"]*)"/);
            const sentenceMatch = prompt.match(/Sentence:\s*"([^"]*)"/);
            const phraseMatch = prompt.match(/Selected phrase:\s*"([^"]*)"/);
            const word = wordMatch ? wordMatch[1] : (phraseMatch ? phraseMatch[1] : 'unknown');
            const sentence = sentenceMatch ? sentenceMatch[1] : '';
            const isHK = prompt.includes('香港繁體中文');
            // Meaning encodes WHAT the answered request actually carried, so a stale render is visible.
            const meaning = `释义[${url.pathname}#${word}@${sentence.slice(0, 22)}]`;
            if (state.badProviderJson) {
                return sendJson(200, { choices: [{ finish_reason: 'stop', message: { content: 'not-json-at-all' } }] });
            }
            if (state.emptyProviderContent) {
                return sendJson(200, { choices: [{ finish_reason: 'stop', message: { content: '' } }] });
            }
            if (phraseMatch) {
                return sendJson(200, {
                    choices: [{
                        finish_reason: 'stop',
                        message: {
                            content: JSON.stringify({
                                selection: word,
                                sentence,
                                analysis: { phonetic: 'teɪk tʃɑːdʒ', meaning, usage: isHK ? '動詞片語' : '动词短语', examples: [] }
                            })
                        }
                    }]
                });
            }
            return sendJson(200, {
                choices: [{
                    finish_reason: 'stop',
                    message: {
                        content: JSON.stringify({
                            word,
                            sentence,
                            analysis: { phonetic: 'tʃɑːdʒ', pos: 'v.', meaning, role: isHK ? '及物動詞' : '及物动词' }
                        })
                    }
                }]
            });
        }

        const workerMatch = url.pathname.match(/^\/(worker1|worker2)(\/.*)?$/);
        if (workerMatch) {
            if (!originAllowed) return sendJson(403, { error: 'origin_not_allowed' });
            const workerId = workerMatch[1];
            const routePath = workerMatch[2] || '/';
            const body = method === 'POST' ? await readJsonBody(req) : null;
            state.workerRequests.push({ workerId, routePath, method, origin, auth: req.headers.authorization || '' });

            const tokenFor = (u) => (workerId === 'worker2' ? state.worker2Tokens[u.user_id] : u.token);
            const findUser = (token) => Object.values(state.users).find((u) => u.token === token || state.worker2Tokens[u.user_id] === token);

            if (routePath === '/login' && method === 'POST') {
                const u = Object.values(state.users).find((x) => x.username === body?.username && x.password === body?.password);
                if (!u) return sendJson(401, { error: 'invalid_credentials' });
                return sendJson(200, { token: tokenFor(u), user_id: u.user_id, label: u.label, role: u.role });
            }

            const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
            const user = findUser(bearer);
            if (!user) return sendJson(401, { error: 'unauthorized' });

            if (state.snapshot401 && routePath === '/snapshot') return sendJson(401, { error: 'unauthorized', code: 'unauthorized' });
            if (routePath === '/me') return sendJson(200, { user_id: user.user_id, label: user.label, role: user.role });
            if (routePath === '/snapshot') return sendJson(200, state.snapshots[user.user_id] || { version: 1, payload: {} });
            if (routePath === '/ai-catalog') {
                return sendJson(200, {
                    version: 9,
                    publishedAt: '2026-11-06T00:00:00.000Z',
                    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
                    providers: [{
                        id: 'managed-default',
                        name: 'Managed Default Provider',
                        order: 1,
                        enabled: true,
                        format: 'openai-chat',
                        formatVersion: 1,
                        apiUrl: `${state.baseUrl}/provider-managed/v1/chat/completions`,
                        modelsUrl: `${state.baseUrl}/provider-managed/v1/models`,
                        authMode: 'bearer',
                        models: [{ id: 'managed-gpt', label: 'Managed GPT', capabilities: { text: 'yes', json: 'yes' } }]
                    }],
                    tasks: {
                        default: { providerId: 'managed-default', model: 'managed-gpt' },
                        wordAnalysis: { providerId: 'managed-default', model: 'managed-gpt' },
                        articleWordTranslation: { providerId: 'managed-default', model: 'managed-gpt' },
                        articlePhraseTranslation: { providerId: 'managed-default', model: 'managed-gpt' }
                    }
                });
            }
            if (/^\/ai-catalog\/providers\/[^/]+\/credential$/.test(routePath)) {
                return sendJson(200, {
                    apiKey: 'sk-mock-managed-0000',
                    credentialRevision: 1,
                    catalogVersion: 9,
                    binding: {
                        formatVersion: 1,
                        format: 'openai-chat',
                        apiUrl: `${state.baseUrl}/provider-managed/v1/chat/completions`,
                        modelsUrl: `${state.baseUrl}/provider-managed/v1/models`,
                        authMode: 'bearer'
                    }
                });
            }
            if (routePath === '/ai-credentials') {
                const rows = Object.entries(state.personalCredentials[user.user_id] || {}).map(([providerId, row]) => ({
                    providerId, version: row.version, deleted: !!row.deleted, lastMutationId: '', binding: row.binding, updatedAt: '2026-11-06T00:00:00.000Z'
                }));
                return sendJson(200, { items: rows });
            }
            const personalMatch = routePath.match(/^\/ai-credentials\/([^/]+)$/);
            if (personalMatch) {
                if (state.personalCredStatus !== 200) return sendJson(state.personalCredStatus, { error: 'boom' });
                const pid = decodeURIComponent(personalMatch[1]);
                const row = (state.personalCredentials[user.user_id] || {})[pid];
                if (!row) return sendJson(404, { error: 'not_found' });
                return sendJson(200, { providerId: pid, version: row.version, deleted: !!row.deleted, apiKey: row.apiKey, binding: row.binding, lastMutationId: '' });
            }
            return sendJson(404, { error: 'not_found' });
        }

        sendJson(404, { error: 'unknown_route' });
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    state.baseUrl = `http://127.0.0.1:${server.address().port}`;
    state.worker1Endpoint = `${state.baseUrl}/worker1`;
    state.worker2Endpoint = `${state.baseUrl}/worker2`;

    state.snapshots.alice = {
        version: 1,
        payload: { aiSettings: { updatedAt: '2026-11-06T00:00:00.000Z', settings: { providers: {}, models: {}, tasks: {}, defaultModel: '', keySyncDefault: 'cloud', thinking: { wordAnalysis: 'low' } } } }
    };
    state.snapshots.bob = {
        version: 1,
        payload: { aiSettings: { updatedAt: '2026-11-06T00:00:00.000Z', settings: { providers: {}, models: {}, tasks: {}, defaultModel: '' } } }
    };

    return { state, close: () => new Promise((resolve) => server.close(resolve)) };
}

function holdProvider(mock) {
    let release;
    mock.state.holdNext = new Promise((resolve) => { release = resolve; });
    return () => release();
}

(async () => {
    const mock = await startMockEnvironment();
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-ext-verify-'));
    let context = null;
    let extPage = null;
    const pageErrors = [];

    const lookupBtnState = async (page) => page.evaluate(() => {
        const btn = document.getElementById('ext-lookup-btn');
        return { disabled: !!btn.disabled, text: btn.textContent || '' };
    });

    const resultState = async (page) => page.evaluate(() => {
        const box = document.getElementById('ext-result-box');
        return {
            hidden: box ? box.classList.contains('hidden') : true,
            meaning: document.getElementById('ext-result-meaning')?.textContent || '',
            meta: document.getElementById('ext-result-meta')?.textContent || ''
        };
    });

    const noticeState = async (page) => page.evaluate(() => {
        const el = document.getElementById('ext-lookup-notice');
        return { hidden: el ? el.classList.contains('hidden') : true, text: el?.textContent || '' };
    });

    const accountText = async (page) => page.evaluate(() => document.getElementById('ext-account-status')?.textContent || '');
    const taskText = async (page) => page.evaluate(() => document.getElementById('ext-task-status')?.textContent || '');

    // Recover a usable UI state through real user actions only (reload + sync).
    async function prepareLookupState({ word = 'charge', sentence = 'They charge £10 for admission.', context = 'Museum guide.' } = {}) {
        let ready = false;
        for (let attempt = 0; attempt < 3 && !ready; attempt += 1) {
            await extPage.waitForFunction(() => (document.getElementById('ext-account-status')?.textContent || '').length > 0, null, { timeout: 15000 }).catch(() => {});
            const btn = await lookupBtnState(extPage);
            const task = await taskText(extPage);
            if (!btn.disabled && /managed-gpt/.test(task)) { ready = true; break; }
            await extPage.click('#ext-sync-btn', { timeout: 5000 }).catch(() => {});
            await extPage.waitForTimeout(600);
            const task2 = await taskText(extPage);
            if (!(await lookupBtnState(extPage)).disabled && /managed-gpt/.test(task2)) { ready = true; break; }
            await extPage.reload({ waitUntil: 'domcontentloaded' });
            await extPage.waitForTimeout(600);
        }
        if (await extPage.$('#ext-locale-select')) await extPage.selectOption('#ext-locale-select', 'zh-CN').catch(() => {});
        await extPage.uncheck('#ext-force-refresh').catch(() => {});
        await extPage.fill('#ext-word-input', word);
        await extPage.fill('#ext-sentence-input', sentence);
        await extPage.fill('#ext-context-input', context);
        return ready;
    }

    async function startHeldLookup() {
        const release = holdProvider(mock);
        await extPage.click('#ext-lookup-btn');
        const inFlight = await extPage
            .waitForFunction(() => document.getElementById('ext-lookup-btn')?.disabled === true, null, { timeout: 5000 })
            .then(() => true)
            .catch(() => false);
        return { release, inFlight };
    }

    try {
        context = await chromium.launchPersistentContext(userDataDir, {
            channel: 'chromium',
            headless: true,
            args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`]
        });
        let [sw] = context.serviceWorkers();
        if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
        const extensionId = sw.url().split('/')[2];
        const extensionOrigin = `chrome-extension://${extensionId}`;
        mock.state.allowedExtensionOrigin = extensionOrigin;

        extPage = await context.newPage();
        extPage.on('pageerror', (err) => pageErrors.push(String(err.message || err)));
        await extPage.goto(`${extensionOrigin}/lookup.html`, { waitUntil: 'domcontentloaded' });
        for (const p of context.pages()) if (p !== extPage) await p.close();

        const connectAlice = async (endpoint) => {
            await extPage.fill('#ext-endpoint-input', endpoint);
            await extPage.selectOption('#ext-login-mode', 'password');
            await extPage.fill('#ext-username-input', 'alice');
            await extPage.fill('#ext-password-input', 'pwd-alice-771');
            await extPage.click('#ext-connect-btn');
            await extPage.waitForFunction(() => (document.getElementById('ext-account-status')?.textContent || '').includes('Alice Reader'), null, { timeout: 20000 });
        };

        // ---------------------------------------------------------------
        // Baseline connection (managed provider, zh-CN)
        // ---------------------------------------------------------------
        await connectAlice(mock.state.worker1Endpoint);
        check('前置：連線帳戶並解析查詞模型成功', /managed-gpt/.test(await taskText(extPage)), await taskText(extPage));

        // ===============================================================
        // A. Real DOM Range selection on the SECOND occurrence of "charge"
        // ===============================================================
        const articlePage = await context.newPage();
        await articlePage.goto(`${mock.state.baseUrl}/reading-article`, { waitUntil: 'domcontentloaded' });
        await articlePage.evaluate(() => {
            const p = document.getElementById('p1');
            const node = p.firstChild;
            const start = node.textContent.lastIndexOf('charge');
            const range = document.createRange();
            range.setStart(node, start);
            range.setEnd(node, start + 'charge'.length);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
        });
        const domSelection = await articlePage.evaluate(() => {
            const sel = window.getSelection();
            const r = sel.rangeCount ? sel.getRangeAt(0) : null;
            return {
                selected: sel.toString(),
                startOffset: r ? r.startOffset : -1,
                paragraph: document.getElementById('p1').textContent
            };
        });
        await articlePage.bringToFront();
        await extPage.evaluate(() => document.getElementById('ext-extract-btn').click());
        await extPage.waitForFunction(() => (document.getElementById('ext-word-input')?.value || '') === 'charge', null, { timeout: 8000 });
        const extracted = {
            word: await extPage.inputValue('#ext-word-input'),
            sentence: await extPage.inputValue('#ext-sentence-input'),
            context: await extPage.inputValue('#ext-context-input')
        };
        check(
            'A1 真 DOM Range 選取第二個 charge：原句應為 "Remember to charge the battery."',
            extracted.sentence === 'Remember to charge the battery.',
            `DOM選取=${JSON.stringify(domSelection)} 擷取=${JSON.stringify(extracted)}`
        );

        // Control: the FIRST occurrence must resolve to sentence 1.
        await articlePage.bringToFront();
        await articlePage.evaluate(() => {
            const p = document.getElementById('p1');
            const node = p.firstChild;
            const start = node.textContent.indexOf('charge');
            const range = document.createRange();
            range.setStart(node, start);
            range.setEnd(node, start + 'charge'.length);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await extPage.evaluate(() => document.getElementById('ext-extract-btn').click());
        await extPage.waitForTimeout(400);
        const firstOccurrence = await extPage.inputValue('#ext-sentence-input');
        check('A2 對照：選取第一個 charge 時原句為第一句', firstOccurrence === 'They charge £10 for admission.', firstOccurrence);
        await articlePage.close();

        // ===============================================================
        // B. Cancellation / stale result / button restore while looking up
        // ===============================================================
        // B1: word field changed while in flight
        const b1Ready = await prepareLookupState();
        const b1 = await startHeldLookup();
        check('B1 前置：查詢已進入進行中狀態（按鈕 disabled）', b1Ready && b1.inFlight, `ready=${b1Ready} inFlight=${b1.inFlight}`);
        await extPage.fill('#ext-word-input', 'battery');
        b1.release();
        await extPage.waitForTimeout(1000);
        const b1State = await lookupBtnState(extPage);
        check(
            'B1 查詢進行中輸入新 word 後，舊請求結束時查詢按鈕必須恢復可用',
            b1State.disabled === false,
            `按鈕=${JSON.stringify(b1State)} 結果=${JSON.stringify(await resultState(extPage))}`
        );
        let b1Clickable = true;
        try {
            await extPage.click('#ext-lookup-btn', { timeout: 1500 });
        } catch (_) {
            b1Clickable = false;
        }
        check('B1b 上述情境後使用者仍可實際點擊查詢按鈕（不可永久卡住）', b1Clickable, b1Clickable ? '可點擊' : 'Playwright 等待按鈕可用逾時 → 永久 disabled');

        // B2: sentence changed while in flight
        const b2Ready = await prepareLookupState();
        const b2 = await startHeldLookup();
        check('B2 前置：查詢進行中', b2Ready && b2.inFlight, `ready=${b2Ready} inFlight=${b2.inFlight}`);
        await extPage.fill('#ext-sentence-input', 'The cavalry led the charge at dawn.');
        b2.release();
        await extPage.waitForTimeout(1000);
        const b2Result = await resultState(extPage);
        check(
            'B2 查詢進行中修改 sentence，舊回應不得套用到新原句',
            b2Result.hidden === true || b2Result.meaning.includes('cavalry'),
            `目前原句欄=${await extPage.inputValue('#ext-sentence-input')} 顯示結果=${JSON.stringify(b2Result)}`
        );

        // B3: context changed while in flight
        const b3Ready = await prepareLookupState();
        const b3 = await startHeldLookup();
        check('B3 前置：查詢進行中', b3Ready && b3.inFlight, `ready=${b3Ready} inFlight=${b3.inFlight}`);
        await extPage.fill('#ext-context-input', 'Completely different paragraph about batteries.');
        b3.release();
        await extPage.waitForTimeout(1000);
        const b3Result = await resultState(extPage);
        check('B3 查詢進行中修改 context，舊回應不得套用', b3Result.hidden === true, `顯示結果=${JSON.stringify(b3Result)}`);

        // B4: locale switched while in flight
        const b4Ready = await prepareLookupState();
        const b4 = await startHeldLookup();
        check('B4 前置：查詢進行中', b4Ready && b4.inFlight, `ready=${b4Ready} inFlight=${b4.inFlight}`);
        await extPage.selectOption('#ext-locale-select', 'zh-HK');
        b4.release();
        await extPage.waitForTimeout(1000);
        const b4Result = await resultState(extPage);
        check('B4 查詢進行中切換 locale，舊語言結果不得顯示', b4Result.hidden === true, `顯示結果=${JSON.stringify(b4Result)}`);
        await extPage.selectOption('#ext-locale-select', 'zh-CN').catch(() => {});

        // B5: new selection extracted while in flight
        const b5Ready = await prepareLookupState();
        const articlePage2 = await context.newPage();
        await articlePage2.goto(`${mock.state.baseUrl}/reading-article`, { waitUntil: 'domcontentloaded' });
        await articlePage2.evaluate(() => {
            const p = document.getElementById('p2');
            const node = p.firstChild;
            const start = node.textContent.indexOf('Battery');
            const range = document.createRange();
            range.setStart(node, start);
            range.setEnd(node, start + 'Battery'.length);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
        });
        const b5 = await startHeldLookup();
        check('B5 前置：查詢進行中', b5Ready && b5.inFlight, `ready=${b5Ready} inFlight=${b5.inFlight}`);
        await articlePage2.bringToFront();
        await extPage.evaluate(() => document.getElementById('ext-extract-btn').click());
        await extPage.waitForFunction(() => (document.getElementById('ext-word-input')?.value || '') === 'Battery', null, { timeout: 8000 }).catch(() => {});
        b5.release();
        await extPage.waitForTimeout(1000);
        const b5Result = await resultState(extPage);
        check(
            'B5 查詢進行中擷取新選詞（charge → Battery）後，舊 charge 結果不得顯示',
            b5Result.hidden === true || b5Result.meaning.includes('Battery'),
            `word欄=${await extPage.inputValue('#ext-word-input')} 顯示結果=${JSON.stringify(b5Result)} 按鈕=${JSON.stringify(await lookupBtnState(extPage))}`
        );
        await articlePage2.close();

        // B6: account switched while in flight
        const b6Ready = await prepareLookupState();
        const b6 = await startHeldLookup();
        check('B6 前置：查詢進行中', b6Ready && b6.inFlight, `ready=${b6Ready} inFlight=${b6.inFlight}`);
        await extPage.fill('#ext-username-input', 'bob');
        await extPage.fill('#ext-password-input', 'pwd-bob-882');
        await extPage.click('#ext-connect-btn');
        await extPage.waitForFunction(() => (document.getElementById('ext-account-status')?.textContent || '').includes('Bob Reader'), null, { timeout: 20000 });
        b6.release();
        await extPage.waitForTimeout(1000);
        const b6State = await lookupBtnState(extPage);
        const b6Notice = await noticeState(extPage);
        check('B6 查詢進行中切換帳戶後，查詢按鈕必須恢復可用', b6State.disabled === false, `按鈕=${JSON.stringify(b6State)} 提示=${JSON.stringify(b6Notice)}`);

        // B7: locale switched AFTER a result was rendered (answer language vs labels)
        await prepareLookupState({ context: 'Museum guide for B7.' });
        await extPage.selectOption('#ext-locale-select', 'zh-CN');
        await extPage.click('#ext-lookup-btn');
        await extPage.waitForFunction(() => !document.getElementById('ext-result-box')?.classList.contains('hidden'), null, { timeout: 20000 }).catch(() => {});
        const b7Before = await resultState(extPage);
        await extPage.selectOption('#ext-locale-select', 'zh-HK');
        await extPage.waitForTimeout(600);
        const b7After = await resultState(extPage);
        const answerPart = (text) => String(text || '').replace(/^[^：:]*[：:]/, '');
        check(
            'B7 已完成結果在切換 locale 後：結果應作廢或重新取得，不得只換標籤而沿用舊語言答案',
            b7After.hidden === true || answerPart(b7After.meaning) !== answerPart(b7Before.meaning),
            `切換前=${JSON.stringify(b7Before)} 切換後=${JSON.stringify(b7After)}`
        );
        await extPage.selectOption('#ext-locale-select', 'zh-CN').catch(() => {});

        // Reconnect Alice for the remaining checks
        await connectAlice(mock.state.worker1Endpoint);
        await extPage.waitForTimeout(400);

        // ===============================================================
        // D3. Endpoint switch performed in a SECOND extension page
        // ===============================================================
        const secondPage = await context.newPage();
        secondPage.on('pageerror', (err) => pageErrors.push('second-page: ' + String(err.message || err)));
        await secondPage.goto(`${extensionOrigin}/lookup.html`, { waitUntil: 'domcontentloaded' });
        await secondPage.waitForFunction(() => (document.getElementById('ext-account-status')?.textContent || '').length > 0, null, { timeout: 15000 });
        await secondPage.fill('#ext-endpoint-input', mock.state.worker2Endpoint);
        await secondPage.fill('#ext-username-input', 'alice');
        await secondPage.fill('#ext-password-input', 'pwd-alice-771');
        await secondPage.click('#ext-connect-btn');
        const secondConnected = await secondPage
            .waitForFunction(() => (document.getElementById('ext-account-status')?.textContent || '').includes('Alice Reader'), null, { timeout: 20000 })
            .then(() => true)
            .catch(() => false);
        const secondDiag = await secondPage.evaluate(() => ({
            account: document.getElementById('ext-account-status')?.textContent || '',
            notice: document.getElementById('ext-account-notice')?.textContent || ''
        }));
        check('D3 前置：第二個擴充頁在另一個端點連上同一帳戶', secondConnected, JSON.stringify(secondDiag));
        await secondPage.waitForTimeout(800);

        const markBefore = mock.state.workerRequests.length;
        await extPage.bringToFront();
        await extPage.waitForTimeout(200);
        const syncEnabled = await extPage.evaluate(() => !document.getElementById('ext-sync-btn')?.disabled);
        if (syncEnabled) {
            await extPage.click('#ext-sync-btn');
            await extPage.waitForTimeout(1800);
        }
        const afterSync = mock.state.workerRequests.slice(markBefore);
        const d3 = await extPage.evaluate(() => ({
            inMemory: globalThis.__BDC_SYNC_ENDPOINT__ || '',
            stored: localStorage.getItem('bdc_ext_sync_endpoint_v1') || '',
            tokenPrefix: (localStorage.getItem('sync_token') || '').slice(0, 4),
            account: document.getElementById('ext-account-status')?.textContent || ''
        }));
        const crossEndpointToken = afterSync.some((r) => r.workerId === 'worker1' && r.auth.includes('A2A2'));
        check(
            'D3a 第二個擴充頁切換端點後，第一個頁面不得把新端點簽發的 token 送到舊端點',
            syncEnabled && afterSync.length > 0 && !crossEndpointToken,
            `sync按鈕可用=${syncEnabled} 頁面記憶端點=${d3.inMemory} localStorage端點=${d3.stored} tokenPrefix=${d3.tokenPrefix} 帳戶列=${d3.account} 請求=${JSON.stringify(afterSync.map((r) => ({ worker: r.workerId, path: r.routePath, auth: r.auth.slice(0, 18) })))}`
        );
        check(
            'D3b 端點切換後第一個頁面應同步到新端點（不得同時存在兩個端點狀態）',
            d3.inMemory === d3.stored,
            `記憶=${d3.inMemory} localStorage=${d3.stored}`
        );
        await secondPage.close();

        // ===============================================================
        // D1/D2. Reload restore and logout replay
        // ===============================================================
        const expectedEndpointBeforeReload = await extPage.evaluate(() => localStorage.getItem('bdc_ext_sync_endpoint_v1') || '');
        await extPage.reload({ waitUntil: 'domcontentloaded' });
        await extPage.waitForFunction(() => (document.getElementById('ext-account-status')?.textContent || '').length > 0, null, { timeout: 15000 });
        const d1 = await extPage.evaluate(() => ({
            status: document.getElementById('ext-account-status')?.textContent || '',
            token: localStorage.getItem('sync_token') || '',
            endpoint: localStorage.getItem('bdc_ext_sync_endpoint_v1') || ''
        }));
        check(
            'D1 重新載入後仍回復同一帳戶，且端點與 localStorage 一致',
            d1.status.includes('Alice Reader') && d1.token.length > 0 && d1.endpoint === expectedEndpointBeforeReload,
            JSON.stringify({ status: d1.status, endpoint: d1.endpoint, storedBeforeReload: expectedEndpointBeforeReload })
        );

        // D4: can an injected (isolated-world) script read the session backup?
        const probePage = await context.newPage();
        await probePage.goto(`${mock.state.baseUrl}/reading-article`, { waitUntil: 'domcontentloaded' });
        const d4 = await extPage.evaluate(async () => {
            const tabs = await chrome.tabs.query({});
            const target = tabs.find((t) => String(t.url || '').startsWith('http'));
            if (!target) return { error: 'no-http-tab' };
            const injected = await chrome.scripting.executeScript({
                target: { tabId: target.id },
                func: () => (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local
                    ? chrome.storage.local.get(null)
                    : 'no-chrome-storage')
            });
            const value = injected && injected[0] ? injected[0].result : null;
            const text = JSON.stringify(value || null);
            return {
                tabUrl: target.url,
                canAccessChromeStorage: text.includes('no-chrome-storage') === false,
                hasTokenField: /"token":"[^"]+"/.test(text),
                keys: value && typeof value === 'object' ? Object.keys(value) : []
            };
        });
        await probePage.close();
        check(
            'D4 注入到一般網頁的指令碼不得取得工作階段 token（chrome.storage.local 備份應限於受信任環境）',
            d4.canAccessChromeStorage === false || d4.hasTokenField === false,
            JSON.stringify(d4)
        );

        await extPage.click('#ext-logout-btn');
        await extPage.waitForTimeout(700);
        await extPage.reload({ waitUntil: 'domcontentloaded' });
        await extPage.waitForTimeout(1000);
        const d2 = await extPage.evaluate(async () => ({
            token: localStorage.getItem('sync_token') || '',
            userId: localStorage.getItem('sync_user_id') || '',
            backup: JSON.stringify(await chrome.storage.local.get(null))
        }));
        check(
            'D2 登出後重載不得重放舊 token（localStorage 與 chrome.storage 備份都應清空）',
            !d2.token && !d2.userId && !/"token":"[^"]+"/.test(d2.backup),
            `localStorage.token="${d2.token}" localStorage.userId="${d2.userId}" backupHasToken=${/"token":"[^"]+"/.test(d2.backup)}`
        );

        // Endpoint must go back to worker1 for the remaining checks
        await extPage.fill('#ext-endpoint-input', mock.state.worker1Endpoint);
        await connectAlice(mock.state.worker1Endpoint);

        // ===============================================================
        // F. Managed key 401 cleanup + scoped profile hygiene on logout
        // ===============================================================
        await prepareLookupState();
        const providerBefore401 = mock.state.providerRequests.length;
        mock.state.snapshot401 = true;
        await extPage.click('#ext-sync-btn');
        await extPage.waitForTimeout(1500);
        const f2 = await extPage.evaluate(() => ({
            account: document.getElementById('ext-account-status')?.textContent || '',
            catalog: document.getElementById('ext-catalog-status')?.textContent || '',
            notice: document.getElementById('ext-account-notice')?.textContent || '',
            token: localStorage.getItem('sync_token') || ''
        }));
        check(
            'F2 同步取得 401 後必須清除工作階段與管理供應商共享 Key（不得仍顯示已連線）',
            !f2.account.includes('Alice') && !f2.token,
            JSON.stringify(f2)
        );
        await extPage.fill('#ext-word-input', 'charge');
        await extPage.fill('#ext-sentence-input', 'They charge £10 for admission.');
        await extPage.click('#ext-lookup-btn');
        await extPage.waitForTimeout(1500);
        check(
            'F3 401 之後不得再用管理供應商共享 Key 發出供應商請求',
            mock.state.providerRequests.length === providerBefore401,
            `provider 請求數 before=${providerBefore401} after=${mock.state.providerRequests.length} 提示=${JSON.stringify(await noticeState(extPage))}`
        );
        mock.state.snapshot401 = false;

        // Scoped profile keys must not survive an explicit logout
        await connectAlice(mock.state.worker1Endpoint);
        await prepareLookupState();
        const f4 = await extPage.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('bdc_ai_profile_v1')));
        check('F4 前置：登入後存在本機 AI profile 作用域鍵', f4.length > 0, JSON.stringify(f4));
        await extPage.click('#ext-logout-btn');
        await extPage.waitForTimeout(900);
        const f5 = await extPage.evaluate(() => ({
            profiles: Object.keys(localStorage).filter((k) => k.startsWith('bdc_ai_profile_v1')),
            token: localStorage.getItem('sync_token') || '',
            catalog: document.getElementById('ext-catalog-status')?.textContent || ''
        }));
        check(
            'F5 登出後本機 AI profile 與工作階段必須清除（不得殘留可用 Key）',
            f5.profiles.length === 0 && !f5.token,
            JSON.stringify(f5)
        );

        // ===============================================================
        // E. Localization / failure-path wording
        // ===============================================================
        await connectAlice(mock.state.worker1Endpoint);
        // E1: unresolved task must not print a raw machine code
        mock.state.snapshots.alice.payload.aiSettings.settings = {
            providers: {
                'personal-local': {
                    id: 'personal-local', label: 'Alice Website-Local Provider', enabled: true,
                    format: 'openai-chat', apiUrl: `${mock.state.baseUrl}/provider-local/v1/chat/completions`,
                    modelsUrl: `${mock.state.baseUrl}/provider-local/v1/models`, authMode: 'bearer', allowedModels: ['local-model-v1']
                }
            },
            models: { wordAnalysis: 'personal-local:local-model-v1' },
            tasks: { wordAnalysis: 'personal-local:local-model-v1', articleWordTranslation: 'personal-local:local-model-v1' },
            defaultModel: 'personal-local:local-model-v1',
            keySyncDefault: 'local-only'
        };
        mock.state.personalCredentials.alice = {};
        await extPage.selectOption('#ext-locale-select', 'zh-HK');
        await extPage.click('#ext-sync-btn');
        await extPage.waitForFunction(() => !document.getElementById('ext-missing-key-banner')?.classList.contains('hidden'), null, { timeout: 20000 }).catch(() => {});
        const e1Task = await taskText(extPage);
        check(
            'E1 zh-HK 未解析模型的狀態列不得顯示原始 machine code（如 ai_key_missing）',
            !/ai_key_missing|model_not_selected|provider_missing/.test(e1Task),
            `狀態列=${e1Task}`
        );

        // E2: credential DOWNLOAD failure must not be described as "website-local key only"
        mock.state.personalCredentials.alice['personal-local'] = {
            version: 1,
            apiKey: 'sk-cloud-personal-should-download',
            binding: {
                formatVersion: 1, format: 'openai-chat',
                apiUrl: `${mock.state.baseUrl}/provider-local/v1/chat/completions`,
                modelsUrl: `${mock.state.baseUrl}/provider-local/v1/models`,
                authMode: 'bearer'
            }
        };
        mock.state.personalCredStatus = 500;
        await extPage.click('#ext-sync-btn');
        await extPage.waitForTimeout(1500);
        const e2 = await extPage.evaluate(() => ({
            bannerHidden: document.getElementById('ext-missing-key-banner')?.classList.contains('hidden'),
            banner: document.getElementById('ext-missing-key-desc')?.textContent || '',
            notice: document.getElementById('ext-account-notice')?.textContent || '',
            // diagnostics only: what the runtime knows about the failed download
            credentialSync: (() => {
                try { return globalThis.__bdcExtensionRuntime.getExtensionReadiness().credentialSync; } catch (_) { return null; }
            })(),
            missingKeyProviders: (() => {
                try { return globalThis.__bdcExtensionRuntime.getExtensionReadiness().missingLocalKeyProviders.map((p) => p.id); } catch (_) { return null; }
            })(),
            storedCredential: (() => {
                const key = Object.keys(localStorage).find((k) => k.startsWith('bdc_ai_profile_v1'));
                if (!key) return null;
                try {
                    const profile = JSON.parse(localStorage.getItem(key) || '{}');
                    return { providers: Object.keys(profile.providers || {}), credentials: profile.credentials || null };
                } catch (_) { return 'parse-failed'; }
            })()
        }));
        check(
            'E2 個人憑證下載失敗（HTTP 500）時不得宣稱「未開啟雲端同步或僅存於網站本機」',
            e2.bannerHidden === true || !/僅存於網站本機|仅存于网站本机/.test(e2.banner),
            `bannerHidden=${e2.bannerHidden} banner="${e2.banner}" notice="${e2.notice}" credentialSync=${JSON.stringify(e2.credentialSync)} missing=${JSON.stringify(e2.missingKeyProviders)} storedCredential=${JSON.stringify(e2.storedCredential)}`
        );
        mock.state.personalCredStatus = 200;

        // E3: unknown failure must not surface raw English text in zh-HK
        mock.state.snapshots.alice.payload.aiSettings.settings = {
            providers: {}, models: {}, tasks: {}, defaultModel: '', keySyncDefault: 'cloud', thinking: { wordAnalysis: 'low' }
        };
        mock.state.personalCredentials.alice = {};
        await extPage.selectOption('#ext-locale-select', 'zh-HK');
        await extPage.click('#ext-sync-btn');
        await extPage.waitForFunction(() => /managed-gpt/.test(document.getElementById('ext-task-status')?.textContent || ''), null, { timeout: 20000 }).catch(() => {});
        mock.state.badProviderJson = true;
        await extPage.check('#ext-force-refresh');
        await extPage.fill('#ext-word-input', 'battery');
        await extPage.fill('#ext-sentence-input', 'The battery died on the long trip.');
        await extPage.fill('#ext-context-input', 'Travel diary paragraph.');
        const e3ProvidersBefore = mock.state.providerRequests.length;
        await extPage.click('#ext-lookup-btn');
        await extPage.waitForFunction(() => !document.getElementById('ext-lookup-notice')?.classList.contains('hidden'), null, { timeout: 25000 }).catch(() => {});
        await extPage.waitForTimeout(500);
        const e3Notice = await noticeState(extPage);
        const e3Result = await resultState(extPage);
        const e3VisibleText = `${e3Notice.text} ${e3Result.meaning} ${e3Result.meta}`;
        check(
            'E3 zh-HK 失敗路徑不得直接顯示原始英文錯誤（如 JSON parse failed / Schema validation failed）',
            mock.state.providerRequests.length > e3ProvidersBefore
                && !/parse failed|validation failed|fallback failed|session changed|aborted|not-json-at-all/i.test(e3VisibleText),
            `provider呼叫=${mock.state.providerRequests.length - e3ProvidersBefore} 提示=${JSON.stringify(e3Notice)} 結果=${JSON.stringify(e3Result)}`
        );
        // E3b: the same (garbage) answer is reused from cache for 30 days
        const e3bCallsBefore = mock.state.providerRequests.length;
        await extPage.uncheck('#ext-force-refresh').catch(() => {});
        await extPage.click('#ext-lookup-btn');
        await extPage.waitForTimeout(1500);
        const e3bResult = await resultState(extPage);
        check(
            'E3b 非 JSON 的供應商回應不得被當成釋義寫入 30 天快取',
            mock.state.providerRequests.length !== e3bCallsBefore || !/not-json-at-all/.test(e3bResult.meaning),
            `第二次查詢 provider 呼叫=${mock.state.providerRequests.length - e3bCallsBefore} 顯示結果=${JSON.stringify(e3bResult)}`
        );
        mock.state.badProviderJson = false;

        // E4: empty provider content -> raw English fallback error text must not reach the UI
        mock.state.emptyProviderContent = true;
        await extPage.check('#ext-force-refresh');
        await extPage.fill('#ext-word-input', 'admission');
        await extPage.fill('#ext-sentence-input', 'They charge £10 for admission.');
        await extPage.click('#ext-lookup-btn');
        await extPage.waitForFunction(() => !document.getElementById('ext-lookup-notice')?.classList.contains('hidden'), null, { timeout: 25000 }).catch(() => {});
        await extPage.waitForTimeout(400);
        const e4Notice = await noticeState(extPage);
        check(
            'E4 zh-HK 失敗路徑不得顯示原始英文內部錯誤字串',
            e4Notice.hidden === false && !/[A-Za-z]{3,}\s+[A-Za-z]{3,}/.test(e4Notice.text),
            `提示=${JSON.stringify(e4Notice)} 結果=${JSON.stringify(await resultState(extPage))}`
        );
        mock.state.emptyProviderContent = false;
        await extPage.uncheck('#ext-force-refresh').catch(() => {});

        check('全域：擴充套件頁面無未捕獲例外', pageErrors.length === 0, pageErrors.join('; '));
    } finally {
        if (context) await context.close();
        await mock.close();
        try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
    }

    const failed = results.filter((r) => !r.ok);
    console.log(`\n=== verification summary: ${results.length - failed.length}/${results.length} desired behaviours hold ===`);
    if (failed.length) {
        console.log('Reproduced defects:');
        for (const f of failed) console.log(` - ${f.name}`);
        process.exitCode = 1;
    }
})();
