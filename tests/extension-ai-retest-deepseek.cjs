// DeepSeek 復測（第二輪）：針對 Codex 修復後仍未覆蓋的關鍵路徑。
//
// 這支腳本不取代 tests/extension-ai-browser.cjs 與 tests/extension-ai-verify-browser.cjs，
// 只補上第一輪驗證與開發者自檢都沒有覆蓋到的行為：
//
//   N1  巢狀行內標記（<em>/<strong>）中重複單詞的真實 DOM Range 選句（P1-1 的邊界）
//   N2  查詢進行中由「另一個擴充頁」切換端點：舊回應不得渲染、按鈕必須恢復（跨頁 stale UI）
//   N3  查詢進行中由「另一個擴充頁」切換帳戶：不得渲染前一個帳戶的答案（跨頁 stale UI）
//   N4  只輸入單詞（無原句、無語境）時走 wordAnalysis 並可命中快取（使用者主要用法之一）
//   N5  個人憑證下載 500 → 如實回報、可重試、200 後恢復（UI 層，不是 node 層）
//   N6  結構合法但 meaning 為空的回應不得當成釋義、也不得寫入快取
//
// 用法：
//   PLAYWRIGHT_MODULE=<playwright 路徑> node tests/extension-ai-retest-deepseek.cjs
//
// 全程使用隨機連接埠的隔離 mock Worker／供應商與臨時 Chromium profile，
// 不使用真實帳戶、真實 Key，也不讀私有 ai-config.js。

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

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

// Nested inline markup: the 2nd "charge" lives inside <strong>, the 1st inside <em>.
const ARTICLE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Nested Markup Guide</title></head>
<body><article id="guide">
<p id="p1">They <em>charge</em> £10 for admission. Remember to <strong>charge</strong> the battery.</p>
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
        emptyMeaning: false,
        users: {
            alice: { user_id: 'alice', label: 'Alice Reader', role: 'user', username: 'alice', password: 'pwd-alice-771', token: 'A'.repeat(40) },
            bob: { user_id: 'bob', label: 'Bob Reader', role: 'user', username: 'bob', password: 'pwd-bob-882', token: 'B'.repeat(40) }
        },
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
            const phraseMatch = prompt.match(/Selected phrase:\s*"([^"]*)"/);
            const wordMatch = prompt.match(/Target word:\s*"([^"]*)"/);
            const sentenceMatch = prompt.match(/Sentence:\s*"([^"]*)"/);
            const dictMatch = prompt.match(/Analyze the English word "([^"]*)"/);
            const isHK = prompt.includes('香港繁體中文');
            const word = phraseMatch ? phraseMatch[1] : (wordMatch ? wordMatch[1] : (dictMatch ? dictMatch[1] : 'unknown'));
            const sentence = sentenceMatch ? sentenceMatch[1] : '';
            const meaning = phraseMatch
                ? `释义[${url.pathname}#${word}]`
                : `释义[${url.pathname}#${word}@${sentence.slice(0, 22)}]`;
            if (state.emptyMeaning) {
                return sendJson(200, {
                    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ word, sentence, analysis: { meaning: '   ' } }) } }]
                });
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
            if (!sentence) {
                // dictionary.wordAnalysis prompt: flat schema, no sentence.
                return sendJson(200, {
                    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ phonetic: 'tʃɑːdʒ', pos: 'v.', meaning }) } }]
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
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-ext-retest-'));
    let context = null;
    const pageErrors = [];

    const resultState = async (page) => page.evaluate(() => {
        const box = document.getElementById('ext-result-box');
        return {
            hidden: box ? box.classList.contains('hidden') : true,
            meaning: document.getElementById('ext-result-meaning')?.textContent || '',
            meta: document.getElementById('ext-result-meta')?.textContent || ''
        };
    });
    const lookupBtnState = async (page) => page.evaluate(() => {
        const btn = document.getElementById('ext-lookup-btn');
        return { disabled: !!btn.disabled, text: btn.textContent || '' };
    });
    const noticeState = async (page) => page.evaluate(() => {
        const el = document.getElementById('ext-lookup-notice');
        return { hidden: el ? el.classList.contains('hidden') : true, text: el?.textContent || '' };
    });
    const accountNotice = async (page) => page.evaluate(() => {
        const el = document.getElementById('ext-account-notice');
        return { hidden: el ? el.classList.contains('hidden') : true, text: el?.textContent || '' };
    });

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

        const extPage = await context.newPage();
        extPage.on('pageerror', (err) => pageErrors.push(String(err.message || err)));
        await extPage.goto(`${extensionOrigin}/lookup.html`, { waitUntil: 'domcontentloaded' });
        for (const p of context.pages()) if (p !== extPage) await p.close();

        const connectAlice = async (page, endpoint) => {
            await page.fill('#ext-endpoint-input', endpoint);
            await page.selectOption('#ext-login-mode', 'password');
            await page.fill('#ext-username-input', 'alice');
            await page.fill('#ext-password-input', 'pwd-alice-771');
            await page.click('#ext-connect-btn');
            await page.waitForFunction(() => (document.getElementById('ext-account-status')?.textContent || '').includes('Alice Reader'), null, { timeout: 20000 });
        };

        const setLookupInputs = async (page, { word = '', sentence = '', context = '' } = {}) => {
            await page.fill('#ext-word-input', word);
            await page.fill('#ext-sentence-input', sentence);
            await page.fill('#ext-context-input', context);
            await page.uncheck('#ext-force-refresh').catch(() => {});
        };

        await connectAlice(extPage, mock.state.worker1Endpoint);
        await extPage.selectOption('#ext-locale-select', 'zh-CN').catch(() => {});
        await extPage.waitForFunction(() => /managed-gpt/.test(document.getElementById('ext-task-status')?.textContent || ''), null, { timeout: 15000 }).catch(() => {});

        // ===============================================================
        // N1/N1b. Real DOM Range inside nested inline markup
        // ===============================================================
        const articlePage = await context.newPage();
        await articlePage.goto(`${mock.state.baseUrl}/reading-article`, { waitUntil: 'domcontentloaded' });
        const selectOccurrence = async (tag, expectedSentence) => {
            await articlePage.evaluate((sel) => {
                const node = document.querySelector(`#p1 ${sel}`).firstChild;
                const start = node.textContent.indexOf('charge');
                const range = document.createRange();
                range.setStart(node, start);
                range.setEnd(node, start + 'charge'.length);
                const s = window.getSelection();
                s.removeAllRanges();
                s.addRange(range);
            }, tag);
            await articlePage.bringToFront();
            await extPage.evaluate(() => document.getElementById('ext-extract-btn').click());
            // Wait for THIS extraction to land (the word field already reads "charge").
            await extPage.waitForFunction(
                (exp) => (document.getElementById('ext-sentence-input')?.value || '') === exp,
                expectedSentence,
                { timeout: 8000 }
            ).catch(() => {});
            return {
                sentence: await extPage.inputValue('#ext-sentence-input'),
                context: await extPage.inputValue('#ext-context-input'),
                startContainer: await articlePage.evaluate(() => {
                    const s = window.getSelection();
                    const r = s.rangeCount ? s.getRangeAt(0) : null;
                    return r ? { node: r.startContainer.nodeType === 3 ? r.startContainer.parentElement?.tagName : r.startContainer.nodeName, offset: r.startOffset } : null;
                })
            };
        };
        const secondOccurrence = await selectOccurrence('strong', 'Remember to charge the battery.');
        check(
            'N1 巢狀 <strong> 內選取第二個 charge：原句必須是第二句（Range 位移穿過行內標記仍正確）',
            secondOccurrence.sentence === 'Remember to charge the battery.'
            && secondOccurrence.context.includes('They charge £10 for admission.'),
            `startContainer=${JSON.stringify(secondOccurrence.startContainer)} 擷取=${JSON.stringify({ sentence: secondOccurrence.sentence })}`
        );
        const firstOccurrence = await selectOccurrence('em', 'They charge £10 for admission.');
        check(
            'N1b 巢狀 <em> 內選取第一個 charge：原句必須是第一句',
            firstOccurrence.sentence === 'They charge £10 for admission.',
            `startContainer=${JSON.stringify(firstOccurrence.startContainer)} sentence=${firstOccurrence.sentence}`
        );
        await articlePage.close();

        // ===============================================================
        // N2. Cross-page endpoint switch while a lookup is in flight
        // ===============================================================
        const setReady = async () => {
            await setLookupInputs(extPage, { word: 'charge', sentence: 'They charge £10 for admission.', context: 'Museum guide for N2.' });
            const task = await extPage.evaluate(() => document.getElementById('ext-task-status')?.textContent || '');
            return /managed-gpt/.test(task);
        };
        const n2Ready = await setReady();
        const releaseN2 = holdProvider(mock);
        await extPage.click('#ext-lookup-btn');
        const n2InFlight = await extPage.waitForFunction(() => document.getElementById('ext-lookup-btn')?.disabled === true, null, { timeout: 5000 }).then(() => true).catch(() => false);

        const secondPage = await context.newPage();
        secondPage.on('pageerror', (err) => pageErrors.push('second-page: ' + String(err.message || err)));
        await secondPage.goto(`${extensionOrigin}/lookup.html`, { waitUntil: 'domcontentloaded' });
        await secondPage.waitForFunction(() => (document.getElementById('ext-account-status')?.textContent || '').length > 0, null, { timeout: 15000 });
        await secondPage.fill('#ext-endpoint-input', mock.state.worker2Endpoint);
        await secondPage.evaluate(() => document.getElementById('ext-endpoint-input').dispatchEvent(new Event('change', { bubbles: true })));
        await secondPage.waitForTimeout(900);
        const pageAEndpointAfterSwitch = await extPage.evaluate(() => localStorage.getItem('bdc_ext_sync_endpoint_v1') || '');
        releaseN2();
        await extPage.waitForTimeout(1200);
        const n2Result = await resultState(extPage);
        const n2Btn = await lookupBtnState(extPage);
        check(
            'N2 查詢進行中由另一個擴充頁切換端點：舊回應不得渲染，且查詢按鈕必須恢復（跨頁 stale UI）',
            n2Ready && n2InFlight && n2Result.hidden === true && n2Btn.disabled === false
            && pageAEndpointAfterSwitch === mock.state.worker2Endpoint,
            `inFlight=${n2InFlight} 端點已跨頁同步=${pageAEndpointAfterSwitch} 結果=${JSON.stringify(n2Result)} 按鈕=${JSON.stringify(n2Btn)}`
        );
        await secondPage.close();
        // Back to worker1 (endpoint change signs this page out by design).
        await connectAlice(extPage, mock.state.worker1Endpoint);

        // ===============================================================
        // N3. Cross-page account switch while a lookup is in flight
        // ===============================================================
        const n3Ready = await setReady();
        const releaseN3 = holdProvider(mock);
        await extPage.click('#ext-lookup-btn');
        const n3InFlight = await extPage.waitForFunction(() => document.getElementById('ext-lookup-btn')?.disabled === true, null, { timeout: 5000 }).then(() => true).catch(() => false);
        const thirdPage = await context.newPage();
        thirdPage.on('pageerror', (err) => pageErrors.push('third-page: ' + String(err.message || err)));
        await thirdPage.goto(`${extensionOrigin}/lookup.html`, { waitUntil: 'domcontentloaded' });
        await thirdPage.waitForFunction(() => (document.getElementById('ext-account-status')?.textContent || '').length > 0, null, { timeout: 15000 });
        await thirdPage.fill('#ext-endpoint-input', mock.state.worker1Endpoint);
        await thirdPage.selectOption('#ext-login-mode', 'password');
        await thirdPage.fill('#ext-username-input', 'bob');
        await thirdPage.fill('#ext-password-input', 'pwd-bob-882');
        await thirdPage.click('#ext-connect-btn');
        const bobConnected = await thirdPage.waitForFunction(() => (document.getElementById('ext-account-status')?.textContent || '').includes('Bob Reader'), null, { timeout: 20000 }).then(() => true).catch(() => false);
        await extPage.waitForTimeout(900);
        releaseN3();
        await extPage.waitForTimeout(1200);
        const n3Result = await resultState(extPage);
        const n3Account = await extPage.evaluate(() => document.getElementById('ext-account-status')?.textContent || '');
        check(
            'N3 查詢進行中由另一個擴充頁切換帳戶：不得渲染前一個帳戶的答案，頁面必須跟隨新帳戶',
            n3Ready && n3InFlight && bobConnected && n3Result.hidden === true && n3Account.includes('Bob Reader'),
            `inFlight=${n3InFlight} bob已連線=${bobConnected} 帳戶列=${n3Account} 結果=${JSON.stringify(n3Result)}`
        );
        await thirdPage.close();
        await connectAlice(extPage, mock.state.worker1Endpoint);

        // ===============================================================
        // N4. Bare word (no sentence, no context) through the real UI
        // ===============================================================
        await extPage.waitForFunction(() => /managed-gpt/.test(document.getElementById('ext-task-status')?.textContent || ''), null, { timeout: 20000 }).catch(() => {});
        await setLookupInputs(extPage, { word: 'admission' });
        const n4Task = await extPage.evaluate(() => document.getElementById('ext-task-status')?.textContent || '');
        const n4CallsBefore = mock.state.providerRequests.length;
        await extPage.click('#ext-lookup-btn');
        await extPage.waitForFunction(() => !document.getElementById('ext-result-box')?.classList.contains('hidden')
            || (!document.getElementById('ext-lookup-notice')?.classList.contains('hidden')), null, { timeout: 25000 }).catch(() => {});
        await extPage.waitForTimeout(400);
        const n4Result = await resultState(extPage);
        const n4CallsAfter = mock.state.providerRequests.length;
        const n4Notice = await noticeState(extPage);
        await extPage.click('#ext-lookup-btn');
        await extPage.waitForTimeout(1200);
        const n4CachedCalls = mock.state.providerRequests.length;
        check(
            'N4 只輸入單詞（無原句／語境）時可完成查詞，且第二次查詢命中快取',
            n4Result.hidden === false
            && /admission/.test(n4Result.meaning)
            && /wordAnalysis/.test(n4Result.meta)
            && n4CallsAfter === n4CallsBefore + 1
            && n4CachedCalls === n4CallsAfter,
            `任務列=${n4Task} 結果=${JSON.stringify(n4Result)} 提示=${JSON.stringify(n4Notice)} provider呼叫=${n4CallsAfter - n4CallsBefore}/${n4CachedCalls - n4CallsAfter}`
        );

        // ===============================================================
        // N5. Personal credential download 500 -> truthful, retryable, recovers
        // ===============================================================
        const localApiUrl = `${mock.state.baseUrl}/provider-local/v1/chat/completions`;
        const localBinding = {
            formatVersion: 1, format: 'openai-chat', apiUrl: localApiUrl,
            modelsUrl: `${mock.state.baseUrl}/provider-local/v1/models`, authMode: 'bearer'
        };
        mock.state.snapshots.alice.payload.aiSettings.settings = {
            providers: {
                'personal-local': {
                    id: 'personal-local', label: 'Alice Personal Provider', enabled: true,
                    format: 'openai-chat', apiUrl: localApiUrl,
                    modelsUrl: `${mock.state.baseUrl}/provider-local/v1/models`,
                    authMode: 'bearer', allowedModels: ['local-model-v1']
                }
            },
            models: { wordAnalysis: 'personal-local:local-model-v1' },
            tasks: { wordAnalysis: 'personal-local:local-model-v1', articleWordTranslation: 'personal-local:local-model-v1' },
            defaultModel: 'personal-local:local-model-v1',
            keySyncDefault: 'cloud'
        };
        // Single source of truth for the fixture key used by N5b/N5c.
        const LOCAL_KEY = 'probe-local-key-0001';
        mock.state.personalCredentials.alice = {
            'personal-local': { version: 1, apiKey: LOCAL_KEY, binding: localBinding }
        };
        mock.state.personalCredStatus = 500;
        await extPage.click('#ext-sync-btn');
        await extPage.waitForTimeout(1600);
        const n5Fail = await extPage.evaluate(() => {
            const r = globalThis.__bdcExtensionRuntime.getExtensionReadiness();
            const key = Object.keys(localStorage).find((k) => k.startsWith('bdc_ai_profile_v1'));
            let credential = null;
            try { credential = JSON.parse(localStorage.getItem(key) || '{}').credentials?.['personal-local'] || null; } catch (_) {}
            return {
                notice: document.getElementById('ext-account-notice')?.textContent || '',
                banner: document.getElementById('ext-missing-key-desc')?.textContent || '',
                credentialSync: r.credentialSync,
                hasKey: r.providers.find((p) => p.id === 'personal-local')?.hasKey,
                credentialState: r.providers.find((p) => p.id === 'personal-local')?.credentialState,
                stored: credential
            };
        });
        check(
            'N5a 下載 500 時必須如實顯示失敗（不得稱僅存於網站本機、不得回報同步完成），並保留可重試錯誤',
            /下載失敗|下载失败/.test(n5Fail.notice)
            && !/僅存於網站本機|仅存于网站本机/.test(`${n5Fail.notice} ${n5Fail.banner}`)
            && n5Fail.credentialSync.status !== 'synced'
            && /download_failed:500/.test(n5Fail.credentialSync.error)
            && n5Fail.stored?.lastError === 'download_failed:500'
            && n5Fail.hasKey === false,
            JSON.stringify(n5Fail)
        );

        mock.state.personalCredStatus = 200;
        await extPage.click('#ext-sync-btn');
        await extPage.waitForTimeout(1600);
        const n5Recovered = await extPage.evaluate(() => {
            const r = globalThis.__bdcExtensionRuntime.getExtensionReadiness();
            return {
                notice: document.getElementById('ext-account-notice')?.textContent || '',
                bannerHidden: document.getElementById('ext-missing-key-banner')?.classList.contains('hidden'),
                credentialSync: r.credentialSync,
                hasKey: r.providers.find((p) => p.id === 'personal-local')?.hasKey,
                credentialState: r.providers.find((p) => p.id === 'personal-local')?.credentialState,
                missing: r.missingLocalKeyProviders.map((p) => p.id)
            };
        });
        check(
            'N5b 改回 200 後重新同步必須恢復：金鑰下載成功、錯誤清除、橫幅收起',
            n5Recovered.hasKey === true
            && n5Recovered.credentialSync.status === 'synced'
            && n5Recovered.credentialSync.error === ''
            && n5Recovered.credentialState === 'available'
            && n5Recovered.missing.length === 0,
            JSON.stringify(n5Recovered)
        );

        // The recovered personal provider must actually be usable for a lookup.
        await setLookupInputs(extPage, { word: 'charge', sentence: 'They charge £10 for admission.', context: 'Provider recovery check.' });
        const n5CallsBefore = mock.state.providerRequests.length;
        await extPage.click('#ext-lookup-btn');
        await extPage.waitForFunction(() => !document.getElementById('ext-result-box')?.classList.contains('hidden')
            || (!document.getElementById('ext-lookup-notice')?.classList.contains('hidden')), null, { timeout: 25000 }).catch(() => {});
        await extPage.waitForTimeout(400);
        const n5Lookup = await resultState(extPage);
        const n5ProviderCalls = mock.state.providerRequests.slice(n5CallsBefore);
        check(
            'N5c 恢復後能以該個人供應商實際查詞（金鑰真的可用，而不是只改狀態文字）',
            n5Lookup.hidden === false
            && /personal-local/.test(n5Lookup.meta)
            && n5ProviderCalls.some((c) => c.path.startsWith('/provider-local') && c.auth === `Bearer ${LOCAL_KEY}`),
            `結果=${JSON.stringify(n5Lookup)} 供應商呼叫=${JSON.stringify(n5ProviderCalls.map((c) => ({ path: c.path, auth: c.auth.slice(0, 18) })))}`
        );

        // ===============================================================
        // N6. Schema-valid but empty meaning must fail and must not be cached
        // ===============================================================
        mock.state.emptyMeaning = true;
        await setLookupInputs(extPage, { word: 'battery', sentence: 'The battery died on the long trip.', context: 'Empty meaning check.' });
        await extPage.check('#ext-force-refresh');
        await extPage.click('#ext-lookup-btn');
        await extPage.waitForFunction(() => !document.getElementById('ext-lookup-notice')?.classList.contains('hidden'), null, { timeout: 25000 }).catch(() => {});
        await extPage.waitForTimeout(400);
        const n6First = await resultState(extPage);
        const n6Notice = await noticeState(extPage);
        const n6Calls = mock.state.providerRequests.length;
        await extPage.uncheck('#ext-force-refresh').catch(() => {});
        await extPage.click('#ext-lookup-btn');
        await extPage.waitForTimeout(1600);
        const n6Second = await resultState(extPage);
        const n6CallsAfter = mock.state.providerRequests.length;
        mock.state.emptyMeaning = false;
        check(
            'N6 空 meaning 的合法 JSON 不得當成釋義顯示，也不得寫入快取（第二次仍會實際請求）',
            n6First.hidden === true
            && n6Notice.hidden === false
            && !/[A-Za-z]{4,}\s+[A-Za-z]{4,}/.test(n6Notice.text)
            && n6Second.hidden === true
            && n6CallsAfter > n6Calls,
            `首次結果=${JSON.stringify(n6First)} 提示=${JSON.stringify(n6Notice)} 第二次結果=${JSON.stringify(n6Second)} provider呼叫=${n6CallsAfter - n6Calls}`
        );

        // ===============================================================
        // N7. Credential binding mismatch must not be described as a retryable download failure
        //     （第一輪驗證要求區分「雲端沒有 Key」／「下載失敗可重試」／「binding 不符」）
        // ===============================================================
        await extPage.click('#ext-logout-btn');
        await extPage.waitForTimeout(900);
        mock.state.personalCredentials.alice['personal-local'] = {
            version: 2,
            apiKey: 'probe-local-key-0001',
            binding: { ...localBinding, apiUrl: `${mock.state.baseUrl}/provider-local-v2/v1/chat/completions` }
        };
        await connectAlice(extPage, mock.state.worker1Endpoint);
        await extPage.waitForTimeout(900);
        const n7 = await extPage.evaluate(() => {
            const r = globalThis.__bdcExtensionRuntime.getExtensionReadiness();
            const entry = r.providers.find((p) => p.id === 'personal-local') || {};
            return {
                credentialSync: r.credentialSync,
                lastError: entry.lastError,
                credentialState: entry.credentialState,
                banner: document.getElementById('ext-missing-key-desc')?.textContent || '',
                bannerHidden: document.getElementById('ext-missing-key-banner')?.classList.contains('hidden'),
                task: document.getElementById('ext-task-status')?.textContent || ''
            };
        });
        check(
            'N7 憑證 binding 不符（雲端金鑰綁定到另一個上游網址）時，介面必須與「下載失敗可重試」區分，不得叫人重試同步',
            n7.lastError === 'binding_mismatch'
            && n7.credentialState === 'binding-mismatch'
            && !/下載失敗|下载失败/.test(n7.banner),
            JSON.stringify(n7)
        );

        check('全域：本次復測期間擴充套件頁面無未捕獲例外', pageErrors.length === 0, pageErrors.join('; '));
    } finally {
        if (context) await context.close();
        await mock.close();
        try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
    }

    const failed = results.filter((r) => !r.ok);
    console.log(`\n=== DeepSeek retest summary: ${results.length - failed.length}/${results.length} checks hold ===`);
    if (failed.length) {
        console.log('Reproduced defects:');
        for (const f of failed) console.log(` - ${f.name}`);
        process.exitCode = 1;
    }
})().catch((error) => {
    console.error('harness error:', error);
    process.exitCode = 2;
});
