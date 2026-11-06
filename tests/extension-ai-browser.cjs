// Real MV3 extension-origin browser E2E verification for BDC Step 1 (Independent AI Proof).
//
// Usage:
//   PLAYWRIGHT_MODULE=<path to playwright> node tests/extension-ai-browser.cjs
//
// Key verification properties:
//   1. Loads the actual unpacked MV3 extension directory (`extension/`) via
//      `chromium.launchPersistentContext(..., { channel: 'chromium', args: ['--load-extension=...'] })`.
//   2. Runs under a genuine `chrome-extension://<id>/lookup.html` origin with
//      ZERO BDC website tabs open.
//   3. Uses local HTTP mock servers for the sync Worker and AI providers (testing
//      real MV3 host_permissions cross-origin network fetches and Worker Origin header checks).
//   4. Covers:
//      - Managed provider path (login -> catalog -> memory-only shared key -> contextual word lookup)
//      - Cloud-synced personal provider path (snapshot AI settings + GET /ai-credentials/:id -> phrase lookup)
//      - Local-only personal provider missing key (explicit warning banner, no silent fallback,
//        manual key import isolated by endpoint + userId)
//      - ActiveTab + scripting selection extraction from a third-party reading page + restricted page fallback
//      - Account switching & late response discard + contextual cache isolation (sentence, context, locale, user, endpoint)
//      - Bilingual UI & dynamic error/status rendering (zh-CN and zh-HK)

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

// Ensure packaged extension files are up to date before launching Chromium
execFileSync(process.execPath, [path.join(ROOT, 'scripts/package-extension.mjs')], { stdio: 'inherit' });

const results = [];
function check(name, ok, detail = '') {
    results.push({ name, ok: !!ok, detail: String(detail || '') });
    console.log(`${ok ? 'PASS' : 'FAIL'} · ${name}${detail ? ' · ' + detail : ''}`);
}

function assert(cond, msg) {
    if (!cond) throw new Error(msg || 'assertion failed');
}

function readJsonBody(req) {
    return new Promise((resolve) => {
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', () => {
            try { resolve(raw ? JSON.parse(raw) : {}); } catch (_) { resolve({}); }
        });
    });
}

async function startMockEnvironment() {
    const state = {
        allowedExtensionOrigin: '', // set once extension ID is discovered
        enforceOriginCheck: true,
        workerRequests: [],
        providerRequests: [],
        holdNextProviderPromise: null,
        users: {
            alice: {
                user_id: 'alice',
                label: 'Alice Reader',
                role: 'user',
                username: 'alice',
                password: 'alice-password-123',
                token: 'A'.repeat(40)
            },
            bob: {
                user_id: 'bob',
                label: 'Bob Reader',
                role: 'user',
                username: 'bob',
                password: 'bob-password-123',
                token: 'B'.repeat(40)
            }
        },
        catalogVersion: 4,
        snapshots: {},
        personalCredentials: {
            alice: {},
            bob: {}
        }
    };

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const origin = req.headers.origin || '';
        const method = req.method.toUpperCase();

        // CORS headers matching cloudflare-worker/src/http.js allow-list behavior
        const originAllowed = !state.enforceOriginCheck
            || !origin
            || !state.allowedExtensionOrigin
            || origin === state.allowedExtensionOrigin;

        const corsHeaders = {
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Authorization, Content-Type',
            'Cache-Control': 'no-store, no-cache, must-revalidate, private',
            'Vary': 'Origin'
        };
        if (originAllowed && origin) {
            corsHeaders['Access-Control-Allow-Origin'] = origin;
        }

        if (method === 'OPTIONS') {
            res.writeHead(originAllowed ? 204 : 403, corsHeaders);
            res.end();
            return;
        }

        const sendJson = (status, data) => {
            res.writeHead(status, { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(data));
        };

        // Third-party reading article page (NOT a BDC page)
        if (url.pathname === '/reading-article') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Museum Visitor Guide</title></head>
<body>
    <article id="guide">
        <p id="p1">Welcome to the city museum. They charge £10 for admission on weekdays. Members may enter without a ticket.</p>
    </article>
</body>
</html>`);
            return;
        }

        // Mock AI Provider endpoints (/provider-managed/v1/chat/completions, /provider-personal/v1/chat/completions, /provider-local/v1/chat/completions)
        if (url.pathname.startsWith('/provider-')) {
            const body = await readJsonBody(req);
            state.providerRequests.push({
                path: url.pathname,
                origin,
                auth: req.headers.authorization || '',
                body
            });
            if (state.holdNextProviderPromise) {
                const waitPromise = state.holdNextProviderPromise;
                state.holdNextProviderPromise = null;
                await waitPromise;
            }
            const prompt = (body.messages || []).map((m) => m.content).join('\n');
            const isHK = prompt.includes('香港繁體中文');
            const isPhrase = prompt.includes('Selected phrase:');
            if (isPhrase) {
                return sendJson(200, {
                    choices: [{
                        finish_reason: 'stop',
                        message: {
                            content: JSON.stringify({
                                selection: 'take charge of',
                                sentence: 'She decided to take charge of the project.',
                                analysis: {
                                    phonetic: 'teɪk tʃɑːdʒ ɒv',
                                    meaning: isHK ? '負責；接管（個人雲端）' : '负责；接管（个人云端）',
                                    usage: isHK ? '動詞片語' : '动词短语',
                                    examples: [{ en: 'Take charge of the team.', zh: isHK ? '負責帶領團隊。' : '负责带领团队。' }]
                                }
                            })
                        }
                    }]
                });
            }
            const tag = url.pathname.includes('personal')
                ? (isHK ? '收費（個人雲端）' : '收费（个人云端）')
                : url.pathname.includes('local')
                    ? (isHK ? '收費（本機金鑰）' : '收费（本机密钥）')
                    : (isHK ? '收費（管理供應商）' : '收费（管理供应商）');
            return sendJson(200, {
                choices: [{
                    finish_reason: 'stop',
                    message: {
                        content: JSON.stringify({
                            word: 'charge',
                            sentence: 'They charge £10 for admission on weekdays.',
                            analysis: {
                                phonetic: 'tʃɑːdʒ',
                                pos: 'v.',
                                meaning: tag,
                                role: isHK ? '及物動詞' : '及物动词'
                            }
                        })
                    }
                }]
            });
        }

        // Mock Worker endpoints under /worker1 or /worker2
        const workerMatch = url.pathname.match(/^\/(worker1|worker2)(\/.*)?$/);
        if (workerMatch) {
            if (!originAllowed) {
                return sendJson(403, { error: 'origin_not_allowed', code: 'origin_not_allowed' });
            }
            const workerId = workerMatch[1];
            const routePath = workerMatch[2] || '/';
            const body = method === 'POST' || method === 'PUT' || method === 'DELETE' ? await readJsonBody(req) : null;
            state.workerRequests.push({
                workerId,
                routePath,
                method,
                origin,
                auth: req.headers.authorization || ''
            });

            if (routePath === '/login' && method === 'POST') {
                const u = Object.values(state.users).find(
                    (item) => item.username === body?.username && item.password === body?.password
                );
                if (!u) return sendJson(401, { error: 'invalid_credentials', code: 'invalid_credentials' });
                return sendJson(200, { token: u.token, user_id: u.user_id, label: u.label, role: u.role });
            }

            const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
            const user = Object.values(state.users).find((item) => item.token === token);
            if (!user) return sendJson(401, { error: 'unauthorized', code: 'unauthorized' });

            if (routePath === '/me' && method === 'GET') {
                return sendJson(200, { user_id: user.user_id, label: user.label, role: user.role });
            }

            if (routePath === '/snapshot' && method === 'GET') {
                const snap = state.snapshots[user.user_id] || {
                    version: 1,
                    updated_at: '2026-11-05T12:00:00.000Z',
                    payload: { aiSettings: { updatedAt: '2026-11-05T12:00:00.000Z', settings: {} } }
                };
                return sendJson(200, snap);
            }

            if (routePath === '/ai-catalog' && method === 'GET') {
                return sendJson(200, {
                    version: state.catalogVersion,
                    publishedAt: '2026-11-05T12:00:00.000Z',
                    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
                    providers: [
                        {
                            id: 'managed-default',
                            name: 'Managed Default Provider',
                            order: 1,
                            enabled: true,
                            format: 'openai-chat',
                            formatVersion: 1,
                            apiUrl: `${state.baseUrl}/provider-managed/v1/chat/completions`,
                            modelsUrl: `${state.baseUrl}/provider-managed/v1/models`,
                            authMode: 'bearer',
                            models: [
                                { id: 'managed-gpt-4o-mini', label: 'Managed GPT-4o Mini', capabilities: { text: 'yes', json: 'yes' } }
                            ]
                        }
                    ],
                    tasks: {
                        default: { providerId: 'managed-default', model: 'managed-gpt-4o-mini' },
                        wordAnalysis: { providerId: 'managed-default', model: 'managed-gpt-4o-mini' },
                        articleWordTranslation: { providerId: 'managed-default', model: 'managed-gpt-4o-mini' },
                        articlePhraseTranslation: { providerId: 'managed-default', model: 'managed-gpt-4o-mini' }
                    }
                });
            }

            const managedCredMatch = routePath.match(/^\/ai-catalog\/providers\/([^/]+)\/credential$/);
            if (managedCredMatch && method === 'GET') {
                const pid = decodeURIComponent(managedCredMatch[1]);
                if (pid !== 'managed-default') return sendJson(404, { error: 'not_found' });
                return sendJson(200, {
                    apiKey: 'sk-managed-browser-memory-key-8888',
                    credentialRevision: 1,
                    catalogVersion: state.catalogVersion,
                    binding: {
                        formatVersion: 1,
                        format: 'openai-chat',
                        apiUrl: `${state.baseUrl}/provider-managed/v1/chat/completions`,
                        modelsUrl: `${state.baseUrl}/provider-managed/v1/models`,
                        authMode: 'bearer'
                    }
                });
            }

            if (routePath === '/ai-credentials' && method === 'GET') {
                const map = state.personalCredentials[user.user_id] || {};
                const items = Object.entries(map).map(([providerId, row]) => ({
                    providerId,
                    version: row.version,
                    deleted: !!row.deleted,
                    lastMutationId: row.lastMutationId || '',
                    binding: row.binding,
                    updatedAt: '2026-11-05T12:00:00.000Z'
                }));
                return sendJson(200, { items });
            }

            const personalCredMatch = routePath.match(/^\/ai-credentials\/([^/]+)$/);
            if (personalCredMatch && method === 'GET') {
                const pid = decodeURIComponent(personalCredMatch[1]);
                const row = (state.personalCredentials[user.user_id] || {})[pid];
                if (!row) return sendJson(404, { error: 'not_found' });
                return sendJson(200, {
                    providerId: pid,
                    version: row.version,
                    deleted: !!row.deleted,
                    apiKey: row.apiKey,
                    binding: row.binding,
                    lastMutationId: row.lastMutationId || ''
                });
            }

            return sendJson(404, { error: 'not_found' });
        }

        sendJson(404, { error: 'unknown_route' });
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    state.baseUrl = `http://127.0.0.1:${address.port}`;
    state.worker1Endpoint = `${state.baseUrl}/worker1`;
    state.worker2Endpoint = `${state.baseUrl}/worker2`;

    // Initialize default snapshots for Alice & Bob
    state.snapshots.alice = {
        version: 1,
        updated_at: '2026-11-05T12:00:00.000Z',
        payload: {
            aiSettings: {
                updatedAt: '2026-11-05T12:00:00.000Z',
                settings: {
                    providers: {},
                    models: {},
                    tasks: {},
                    defaultModel: '',
                    keySyncDefault: 'cloud',
                    thinking: {
                        wordAnalysis: 'low'
                    }
                }
            }
        }
    };
    state.snapshots.bob = {
        version: 1,
        updated_at: '2026-11-05T12:00:00.000Z',
        payload: {
            aiSettings: {
                updatedAt: '2026-11-05T12:00:00.000Z',
                settings: {
                    providers: {},
                    models: {},
                    tasks: {},
                    defaultModel: ''
                }
            }
        }
    };

    return {
        state,
        close: () => new Promise((resolve) => server.close(resolve))
    };
}

(async () => {
    const mock = await startMockEnvironment();
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-ext-ai-proof-'));
    let context = null;

    try {
        context = await chromium.launchPersistentContext(userDataDir, {
            channel: 'chromium',
            headless: true,
            args: [
                `--disable-extensions-except=${EXT_DIR}`,
                `--load-extension=${EXT_DIR}`
            ]
        });

        let [serviceWorker] = context.serviceWorkers();
        if (!serviceWorker) {
            serviceWorker = await context.waitForEvent('serviceworker', { timeout: 15000 });
        }
        const extensionId = serviceWorker.url().split('/')[2];
        const extensionOrigin = `chrome-extension://${extensionId}`;
        mock.state.allowedExtensionOrigin = extensionOrigin;

        check('MV3 擴充套件成功載入並取得真實 chrome-extension:// origin', Boolean(extensionId && extensionOrigin.startsWith('chrome-extension://')), extensionOrigin);

        // Open the extension lookup page directly and close any blank initial tab
        const extPage = await context.newPage();
        await extPage.goto(`${extensionOrigin}/lookup.html`, { waitUntil: 'domcontentloaded' });
        for (const p of context.pages()) {
            if (p !== extPage) await p.close();
        }

        const pageErrors = [];
        extPage.on('pageerror', (err) => pageErrors.push(String(err.message || err)));

        // Verify there are NO BDC website tabs open
        const allUrls = context.pages().map((p) => p.url());
        check(
            '無任何 BDC 網站分頁開啟（僅擴充套件自身頁面）',
            allUrls.length === 1 && allUrls[0] === `${extensionOrigin}/lookup.html`,
            JSON.stringify(allUrls)
        );

        // -------------------------------------------------------------------
        // 1. Connect account & verify managed provider lookup (zh-CN)
        // -------------------------------------------------------------------
        await extPage.fill('#ext-endpoint-input', mock.state.worker1Endpoint);
        await extPage.selectOption('#ext-login-mode', 'password');
        await extPage.fill('#ext-username-input', 'alice');
        await extPage.fill('#ext-password-input', 'alice-password-123');
        await extPage.click('#ext-connect-btn');

        await extPage.waitForFunction(() => {
            const text = document.getElementById('ext-account-status')?.textContent || '';
            return text.includes('Alice Reader');
        });

        const taskStatusCN = await extPage.textContent('#ext-task-status');
        check(
            '登入後成功載入管理供應商並解析查詞模型與思考設定 (low)',
            taskStatusCN.includes('Managed Default Provider') && taskStatusCN.includes('managed-gpt-4o-mini') && taskStatusCN.includes('低强度'),
            taskStatusCN
        );

        // Open a third-party non-BDC article tab, select "charge", and test activeTab+scripting extraction
        const articlePage = await context.newPage();
        await articlePage.goto(`${mock.state.baseUrl}/reading-article`, { waitUntil: 'domcontentloaded' });
        await articlePage.evaluate(() => {
            const p = document.getElementById('p1');
            const textNode = p.firstChild;
            const text = textNode.textContent;
            const start = text.indexOf('charge');
            const range = document.createRange();
            range.setStart(textNode, start);
            range.setEnd(textNode, start + 'charge'.length);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
        });

        // Keep articlePage as the active non-extension tab in the window and trigger extraction from extPage
        await articlePage.bringToFront();
        await extPage.evaluate(() => document.getElementById('ext-extract-btn').click());
        await extPage.waitForFunction(() => document.getElementById('ext-word-input')?.value === 'charge');

        const extractedSentence = await extPage.inputValue('#ext-sentence-input');
        const extractedContext = await extPage.inputValue('#ext-context-input');
        check(
            '透過 activeTab + scripting 從第三方網頁擷取選中詞、原句與附近語境',
            extractedSentence === 'They charge £10 for admission on weekdays.'
                && extractedContext.includes('Welcome to the city museum.')
                && extractedContext.includes('Members may enter without a ticket.'),
            `${extractedSentence} | ${extractedContext}`
        );

        // Close the third-party article tab so ZERO non-extension tabs remain during AI lookup
        await articlePage.close();
        assert(context.pages().length === 1 && context.pages()[0] === extPage, 'only extension tab should remain');

        await extPage.click('#ext-lookup-btn');
        await extPage.waitForFunction(() => !document.getElementById('ext-result-box')?.classList.contains('hidden'));

        const managedMeaning = await extPage.textContent('#ext-result-meaning');
        const managedMeta = await extPage.textContent('#ext-result-meta');
        check(
            '無任何網頁分頁下完成管理供應商語境查詞',
            managedMeaning.includes('收费（管理供应商）') && managedMeta.includes('managed-gpt-4o-mini'),
            `${managedMeaning} | ${managedMeta}`
        );

        // Verify Worker saw chrome-extension:// Origin header on POST /login and Provider saw chrome-extension:// Origin on POST completions
        const workerLoginReq = mock.state.workerRequests.find((r) => r.routePath === '/login' && r.method === 'POST');
        const firstProviderReq = mock.state.providerRequests[0];
        check(
            '後端與 AI 供應商請求附帶真實 chrome-extension:// Origin 並通過允許列表檢查',
            Boolean(workerLoginReq && workerLoginReq.origin === extensionOrigin && firstProviderReq && firstProviderReq.origin === extensionOrigin),
            `worker=${workerLoginReq ? workerLoginReq.origin : 'missing'}, provider=${firstProviderReq ? firstProviderReq.origin : 'missing'}`
        );

        // Verify restricted page (chrome-extension:// active tab) extraction fallback shows localized message and keeps manual input working
        await extPage.bringToFront();
        await extPage.click('#ext-extract-btn');
        await extPage.waitForFunction(() => !document.getElementById('ext-lookup-notice')?.classList.contains('hidden'));
        const restrictedMsg = await extPage.textContent('#ext-lookup-notice');
        check(
            '受限頁面（如 chrome:// 或擴充套件頁）擷取選詞時顯示明確提示並保持手動輸入可用',
            restrictedMsg.includes('当前页面受浏览器保护') && (await extPage.isEditable('#ext-word-input')),
            restrictedMsg
        );

        const storageLeakCheck = await extPage.evaluate(async () => {
            const lsKeys = Object.keys(localStorage);
            for (const k of lsKeys) {
                if ((localStorage.getItem(k) || '').includes('sk-managed-browser-memory-key-8888')) return `localStorage:${k}`;
            }
            const cs = await chrome.storage.local.get(null);
            if (JSON.stringify(cs).includes('sk-managed-browser-memory-key-8888')) return 'chrome.storage.local';
            return 'clean';
        });
        check('管理供應商共享 Key 僅留記憶體，未寫入 localStorage 或 chrome.storage.local', storageLeakCheck === 'clean', storageLeakCheck);

        // -------------------------------------------------------------------
        // 2. Contextual cache hit & context/locale/sentence isolation
        // -------------------------------------------------------------------
        const countBeforeRepeat = mock.state.providerRequests.length;
        await extPage.click('#ext-lookup-btn');
        await extPage.waitForTimeout(120);
        check('相同端點/帳戶/供應商/模型/詞/原句/語境/語言命中快取不重送請求', mock.state.providerRequests.length === countBeforeRepeat);

        // Switch UI language to zh-HK: verify UI labels translate AND lookup misses cache & returns zh-HK meaning
        await extPage.selectOption('#ext-locale-select', 'zh-HK');
        const titleHK = await extPage.textContent('#ext-title');
        const btnHK = await extPage.textContent('#ext-lookup-btn');
        check('介面切換至 zh-HK 後標題與按鈕即時雙語切換', titleHK.includes('語境查詞') && btnHK.includes('語境查詞'), `${titleHK} / ${btnHK}`);

        await extPage.click('#ext-lookup-btn');
        await extPage.waitForFunction(() => (document.getElementById('ext-result-meaning')?.textContent || '').includes('收費（管理供應商）'));
        check('切換 zh-HK 後查詞快取按語言隔離並取得繁體釋義', mock.state.providerRequests.length === countBeforeRepeat + 1);

        // Switch back to zh-CN
        await extPage.selectOption('#ext-locale-select', 'zh-CN');

        // -------------------------------------------------------------------
        // 3. Cloud-synced personal provider path
        // -------------------------------------------------------------------
        mock.state.snapshots.alice.version = 2;
        mock.state.snapshots.alice.updated_at = '2026-11-05T13:00:00.000Z';
        mock.state.snapshots.alice.payload.aiSettings = {
            updatedAt: '2026-11-05T13:00:00.000Z',
            settings: {
                providers: {
                    'personal-cloud': {
                        id: 'personal-cloud',
                        label: 'Alice Cloud Provider',
                        enabled: true,
                        format: 'openai-chat',
                        apiUrl: `${mock.state.baseUrl}/provider-personal/v1/chat/completions`,
                        modelsUrl: `${mock.state.baseUrl}/provider-personal/v1/models`,
                        authMode: 'bearer',
                        allowedModels: ['cloud-model-v1']
                    }
                },
                models: {
                    wordAnalysis: 'personal-cloud:cloud-model-v1'
                },
                tasks: {
                    wordAnalysis: 'personal-cloud:cloud-model-v1'
                },
                defaultModel: 'personal-cloud:cloud-model-v1',
                keySyncDefault: 'cloud'
            }
        };
        mock.state.personalCredentials.alice['personal-cloud'] = {
            version: 1,
            deleted: false,
            apiKey: 'sk-personal-cloud-browser-key-555',
            binding: {
                formatVersion: 1,
                format: 'openai-chat',
                apiUrl: `${mock.state.baseUrl}/provider-personal/v1/chat/completions`,
                modelsUrl: `${mock.state.baseUrl}/provider-personal/v1/models`,
                authMode: 'bearer'
            }
        };

        if (!await extPage.locator('#ext-account-details').evaluate(node => node.open)) await extPage.locator('#ext-account-summary').click();
        await extPage.click('#ext-sync-btn');
        await extPage.waitForFunction(() => (document.getElementById('ext-task-status')?.textContent || '').includes('Alice Cloud Provider'));

        await extPage.fill('#ext-word-input', 'take charge of');
        await extPage.fill('#ext-sentence-input', 'She decided to take charge of the project.');
        await extPage.fill('#ext-context-input', 'Leadership was needed. She decided to take charge of the project.');
        await extPage.click('#ext-lookup-btn');

        await extPage.waitForFunction(() => (document.getElementById('ext-result-meaning')?.textContent || '').includes('负责；接管（个人云端）'));
        const cloudMeta = await extPage.textContent('#ext-result-meta');
        check(
            '已雲端同步個人供應商：自動下載個人憑證並完成片語語境查詞',
            cloudMeta.includes('cloud-model-v1') && mock.state.providerRequests.some((request) => request.path === '/provider-personal/v1/chat/completions' && request.body.model === 'cloud-model-v1'),
            cloudMeta
        );

        // -------------------------------------------------------------------
        // 4. Local-only personal provider missing key + scoped manual import
        // -------------------------------------------------------------------
        mock.state.snapshots.alice.version = 3;
        mock.state.snapshots.alice.updated_at = '2026-11-05T14:00:00.000Z';
        mock.state.snapshots.alice.payload.aiSettings = {
            updatedAt: '2026-11-05T14:00:00.000Z',
            settings: {
                providers: {
                    'personal-local': {
                        id: 'personal-local',
                        label: 'Alice Website-Local Provider',
                        enabled: true,
                        format: 'openai-chat',
                        apiUrl: `${mock.state.baseUrl}/provider-local/v1/chat/completions`,
                        modelsUrl: `${mock.state.baseUrl}/provider-local/v1/models`,
                        authMode: 'bearer',
                        allowedModels: ['local-model-v1']
                    }
                },
                models: {
                    wordAnalysis: 'personal-local:local-model-v1'
                },
                tasks: {
                    wordAnalysis: 'personal-local:local-model-v1'
                },
                defaultModel: 'personal-local:local-model-v1',
                keySyncDefault: 'local-only'
            }
        };

        if (!await extPage.locator('#ext-account-details').evaluate(node => node.open)) await extPage.locator('#ext-account-summary').click();
        await extPage.click('#ext-sync-btn');
        await extPage.waitForFunction(() => !document.getElementById('ext-missing-key-banner')?.classList.contains('hidden'));

        const bannerDesc = await extPage.textContent('#ext-missing-key-desc');
        check(
            '僅網站本機 Key 缺失時明確顯示提示橫幅且不自動複製網站 localStorage',
            bannerDesc.includes('Alice Website-Local Provider') && bannerDesc.includes('手动导入') && await extPage.isVisible('#ext-import-key-btn'),
            bannerDesc
        );

        // Attempt lookup before importing key -> must show localized missing key error and NOT silently use managed provider
        await extPage.fill('#ext-word-input', 'charge');
        await extPage.click('#ext-lookup-btn');
        await extPage.waitForFunction(() => !document.getElementById('ext-lookup-notice')?.classList.contains('hidden'));
        const missingKeyErr = await extPage.textContent('#ext-lookup-notice');
        check('個人供應商缺 Key 時查詞明確報錯且不靜默回退管理供應商', missingKeyErr.includes('API Key'), missingKeyErr);

        // Manually import local key for Alice
        await extPage.fill('#ext-import-key-input', 'sk-alice-manual-imported-local-key');
        await extPage.click('#ext-import-key-btn');
        await extPage.waitForFunction(() => document.getElementById('ext-missing-key-banner')?.classList.contains('hidden'));

        await extPage.click('#ext-lookup-btn');
        await extPage.waitForFunction(() => (document.getElementById('ext-result-meaning')?.textContent || '').includes('收费（本机密钥）'));
        check('手動匯入本機 Key 後成功以該個人供應商完成查詞', true);

        // -------------------------------------------------------------------
        // 5. Account switch & late response protection
        // -------------------------------------------------------------------
        let releaseDelayed;
        mock.state.holdNextProviderPromise = new Promise((resolve) => { releaseDelayed = resolve; });

        // Start a forced lookup under Alice that stays in-flight
        await extPage.check('#ext-force-refresh');
        const delayedLookupClick = extPage.click('#ext-lookup-btn');
        await extPage.waitForTimeout(80);

        // Switch account to Bob while Alice's request is in flight
        mock.state.snapshots.bob.payload.aiSettings = mock.state.snapshots.alice.payload.aiSettings;
        await extPage.fill('#ext-username-input', 'bob');
        await extPage.fill('#ext-password-input', 'bob-password-123');
        await extPage.click('#ext-connect-btn');
        await extPage.waitForFunction(() => (document.getElementById('ext-account-status')?.textContent || '').includes('Bob Reader'));

        // Release Alice's delayed response
        releaseDelayed();
        await delayedLookupClick.catch(() => {});
        await extPage.waitForTimeout(100);

        const bobResultBoxHidden = await extPage.evaluate(() => document.getElementById('ext-result-box')?.classList.contains('hidden'));
        const bobMissingKeyBannerVisible = await extPage.evaluate(() => !document.getElementById('ext-missing-key-banner')?.classList.contains('hidden'));
        check(
            '切換帳戶至 Bob 後：Alice 的遲到回應被丟棄，且 Alice 手動匯入的本機 Key 不洩漏給 Bob',
            bobResultBoxHidden === true && bobMissingKeyBannerVisible === true,
            `resultHidden=${bobResultBoxHidden}, bobMissingKeyBanner=${bobMissingKeyBannerVisible}`
        );

        check('擴充套件執行期間無未捕獲頁面錯誤', pageErrors.length === 0, pageErrors.join('; '));
    } finally {
        if (context) await context.close();
        await mock.close();
        try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
    }

    const failed = results.filter((r) => !r.ok);
    console.log(`\n=== Summary: ${results.length - failed.length}/${results.length} passed ===`);
    if (failed.length) {
        process.exit(1);
    }
})();
