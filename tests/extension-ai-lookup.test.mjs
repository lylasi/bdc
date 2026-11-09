// Unit & integration tests for the independent extension AI runtime and shared
// lookupSelection() boundary (Step 1: Independent AI proof).

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeStorage() {
    const map = new Map();
    return {
        get length() { return map.size; },
        key(index) { return Array.from(map.keys())[index] ?? null; },
        getItem(k) { return map.has(k) ? map.get(k) : null; },
        setItem(k, v) { map.set(String(k), String(v)); },
        removeItem(k) { map.delete(String(k)); },
        clear() { map.clear(); }
    };
}

const storage = makeStorage();
const chromeStorageMap = new Map();
const winListeners = new Map();
const docListeners = new Map();

function makeEventTarget(listenerMap) {
    return {
        addEventListener(type, fn) {
            if (!listenerMap.has(type)) listenerMap.set(type, new Set());
            listenerMap.get(type).add(fn);
        },
        removeEventListener(type, fn) {
            listenerMap.get(type)?.delete(fn);
        },
        dispatchEvent(event) {
            const set = listenerMap.get(event.type);
            if (!set) return true;
            for (const fn of Array.from(set)) {
                try { fn(event); } catch (_) {}
            }
            return true;
        }
    };
}

class CustomEventShim {
    constructor(type, init = {}) {
        this.type = type;
        this.detail = init.detail;
    }
}

globalThis.localStorage = storage;
globalThis.Audio = class {};
globalThis.CustomEvent = CustomEventShim;
const winTarget = makeEventTarget(winListeners);
const docTarget = makeEventTarget(docListeners);
globalThis.window = {
    ...winTarget,
    location: { href: 'chrome-extension://testext123456/lookup.html', origin: 'chrome-extension://testext123456' }
};
globalThis.document = {
    ...docTarget,
    hidden: false,
    documentElement: { lang: 'zh-CN' },
    querySelectorAll() { return []; }
};
globalThis.chrome = {
    storage: {
        local: {
            async get(key) {
                if (typeof key === 'string') {
                    return { [key]: chromeStorageMap.get(key) };
                }
                return Object.fromEntries(chromeStorageMap.entries());
            },
            async set(obj) {
                for (const [k, v] of Object.entries(obj || {})) {
                    chromeStorageMap.set(k, JSON.parse(JSON.stringify(v)));
                }
            }
        }
    }
};

// Mock fetch router
let fetchLog = [];
let mockState = null;

function resetMockState() {
    fetchLog = [];
    mockState = {
        users: {
            alice: {
                user_id: 'alice',
                label: 'Alice',
                role: 'user',
                username: 'alice',
                password: 'password-alice-123',
                token: 'T'.repeat(40)
            },
            bob: {
                user_id: 'bob',
                label: 'Bob',
                role: 'user',
                username: 'bob',
                password: 'password-bob-123',
                token: 'B'.repeat(40)
            }
        },
        catalog: {
            version: 3,
            publishedAt: '2026-11-05T12:00:00.000Z',
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
            providers: [
                {
                    id: 'managed-main',
                    name: 'Managed Main AI',
                    order: 1,
                    enabled: true,
                    format: 'openai-chat',
                    formatVersion: 1,
                    apiUrl: 'https://ai.mock.test/v1/chat/completions',
                    modelsUrl: 'https://ai.mock.test/v1/models',
                    authMode: 'bearer',
                    models: [
                        { id: 'gpt-managed-fast', label: 'Managed Fast', capabilities: { text: 'yes', json: 'yes' } }
                    ]
                }
            ],
            tasks: {
                default: { providerId: 'managed-main', model: 'gpt-managed-fast' },
                wordAnalysis: { providerId: 'managed-main', model: 'gpt-managed-fast' },
                articleWordTranslation: { providerId: 'managed-main', model: 'gpt-managed-fast' },
                articlePhraseTranslation: { providerId: 'managed-main', model: 'gpt-managed-fast' }
            },
            credentials: {
                'managed-main': {
                    apiKey: 'sk-managed-secret-memory-only-9999',
                    credentialRevision: 2,
                    catalogVersion: 3,
                    binding: {
                        formatVersion: 1,
                        format: 'openai-chat',
                        apiUrl: 'https://ai.mock.test/v1/chat/completions',
                        modelsUrl: 'https://ai.mock.test/v1/models',
                        authMode: 'bearer'
                    }
                }
            }
        },
        snapshots: {
            alice: {
                version: 5,
                updated_at: '2026-11-05T12:10:00.000Z',
                payload: {
                    aiSettings: {
                        updatedAt: '2026-11-05T12:10:00.000Z',
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
            },
            bob: {
                version: 2,
                updated_at: '2026-11-05T12:15:00.000Z',
                payload: {
                    aiSettings: {
                        updatedAt: '2026-11-05T12:15:00.000Z',
                        settings: {
                            providers: {},
                            models: {},
                            tasks: {},
                            defaultModel: ''
                        }
                    }
                }
            }
        },
        personalCredentials: {
            alice: {},
            bob: {}
        },
        providerHandler: null
    };
}

function userByToken(authHeader) {
    const token = String(authHeader || '').replace(/^Bearer\s+/i, '').trim();
    if (!token) return null;
    for (const u of Object.values(mockState.users)) {
        if (u.token === token) return u;
    }
    return null;
}

function jsonRes(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}

globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = String(init.method || 'GET').toUpperCase();
    const headers = init.headers || {};
    const authHeader = headers.Authorization || headers.authorization || '';
    const bodyText = typeof init.body === 'string' ? init.body : '';
    const parsedBody = bodyText ? (() => { try { return JSON.parse(bodyText); } catch (_) { return null; } })() : null;

    fetchLog.push({ url, method, headers, body: parsedBody });

    const parsedUrl = new URL(url);
    if (parsedUrl.origin === 'https://sync.mock.test' || parsedUrl.origin === 'https://sync-two.mock.test') {
        const p = parsedUrl.pathname;
        if (p === '/pair' && method === 'POST' && parsedBody?.code === '23456789ABCDEFGH') {
            const user = mockState.users.alice;
            return jsonRes({ token: user.token, user_id: user.user_id, label: user.label, role: user.role });
        }
        if (p === '/login' && method === 'POST') {
            const u = Object.values(mockState.users).find(
                (item) => item.username === parsedBody?.username && item.password === parsedBody?.password
            );
            if (!u) return jsonRes({ error: 'invalid_credentials' }, 401);
            return jsonRes({ token: u.token, user_id: u.user_id, label: u.label, role: u.role });
        }
        const user = userByToken(authHeader);
        if (!user) return jsonRes({ error: 'unauthorized' }, 401);
        if (p === '/me' && method === 'GET') {
            return jsonRes({ user_id: user.user_id, label: user.label, role: user.role });
        }
        if (p === '/snapshot' && method === 'GET') {
            return jsonRes(mockState.snapshots[user.user_id] || { version: 0, payload: {} });
        }
        if (p === '/ai-catalog' && method === 'GET') {
            return jsonRes({
                version: mockState.catalog.version,
                providers: mockState.catalog.providers,
                tasks: mockState.catalog.tasks,
                publishedAt: mockState.catalog.publishedAt,
                expiresAt: mockState.catalog.expiresAt
            });
        }
        const managedCredMatch = p.match(/^\/ai-catalog\/providers\/([^/]+)\/credential$/);
        if (managedCredMatch && method === 'GET') {
            const providerId = decodeURIComponent(managedCredMatch[1]);
            const cred = mockState.catalog.credentials[providerId];
            if (!cred) return jsonRes({ error: 'not_found' }, 404);
            return jsonRes(cred);
        }
        if (p === '/ai-credentials' && method === 'GET') {
            const map = mockState.personalCredentials[user.user_id] || {};
            const items = Object.entries(map).map(([providerId, row]) => ({
                providerId,
                version: row.version,
                deleted: !!row.deleted,
                lastMutationId: row.lastMutationId || '',
                binding: row.binding,
                updatedAt: row.updatedAt || '2026-11-05T12:00:00.000Z'
            }));
            return jsonRes({ items });
        }
        if (p.startsWith('/ai-credentials/') && method === 'GET') {
            const providerId = decodeURIComponent(p.slice('/ai-credentials/'.length));
            const row = (mockState.personalCredentials[user.user_id] || {})[providerId];
            if (!row) return jsonRes({ error: 'not_found' }, 404);
            return jsonRes({
                providerId,
                version: row.version,
                deleted: !!row.deleted,
                apiKey: row.apiKey,
                binding: row.binding,
                lastMutationId: row.lastMutationId || ''
            });
        }
        return jsonRes({ error: 'not_found' }, 404);
    }

    if (typeof mockState.providerHandler === 'function') {
        return await mockState.providerHandler({ url, method, headers, body: parsedBody, signal: init.signal });
    }

    // Default AI provider response
    const promptText = parsedBody?.messages?.map((m) => m.content).join('\n') || '';
    const isPhrase = promptText.includes('Selected phrase:');
    const isHK = promptText.includes('香港繁體中文');
    if (promptText.includes('Analyze the English word "')) {
        return jsonRes({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ phonetic: 'tʃɑːdʒ', pos: 'v.', meaning: isHK ? '收費' : '收费' }) } }] });
    }
    if (isPhrase) {
        return jsonRes({
            choices: [{
                finish_reason: 'stop',
                message: {
                    content: JSON.stringify({
                        selection: 'take charge of',
                        sentence: 'She decided to take charge of the project.',
                        analysis: {
                            phonetic: 'teɪk tʃɑːdʒ ɒv',
                            meaning: isHK ? '負責；接管' : '负责；接管',
                            usage: isHK ? '動詞片語' : '动词短语',
                            examples: [{ en: 'Take charge of your life.', zh: isHK ? '掌握自己的生活。' : '掌握自己的生活。' }]
                        }
                    })
                }
            }]
        });
    }
    return jsonRes({
        choices: [{
            finish_reason: 'stop',
            message: {
                content: JSON.stringify({
                    word: 'charge',
                    sentence: 'They charge £10 for admission.',
                    analysis: {
                        phonetic: 'tʃɑːdʒ',
                        pos: 'v.',
                        meaning: isHK ? '收費' : '收费',
                        role: isHK ? '及物動詞' : '及物动词'
                    }
                })
            }
        }]
    });
};

const { packageExtension } = await import('../scripts/package-extension.mjs');
packageExtension();
const runtime = await import('../extension/modules/extension-ai-runtime.js');
const { setLocale } = await import('../extension/modules/i18n.js');
const { extractSentenceAndContextFromText } = await import('../extension/selection-extractor.js');

function resetStorageAndRuntime() {
    storage.clear();
    chromeStorageMap.clear();
    resetMockState();
    setLocale('zh-CN', { persist: true });
}

test('1. managed provider path: connects account, downloads shared key into memory only, resolves task/thinking, and runs contextual lookup', async () => {
    resetStorageAndRuntime();
    await runtime.restoreTrustedSessionState();

    const readiness = await runtime.connectExtensionAccount({
        endpoint: 'https://sync.mock.test',
        mode: 'password',
        username: 'alice',
        password: 'password-alice-123'
    });

    assert.equal(readiness.loggedIn, true);
    assert.equal(readiness.userId, 'alice');
    assert.equal(readiness.catalog.usable, true);
    assert.equal(readiness.taskResolution.provider, 'managed-main');
    assert.equal(readiness.taskResolution.model, 'gpt-managed-fast');
    // Alice's snapshot sets thinking.wordAnalysis = 'low', which articleWordTranslation inherits
    assert.equal(readiness.taskResolution.thinking, 'low');

    const result = await runtime.runExtensionLookup({
        text: 'charge',
        sentence: 'They charge £10 for admission.',
        context: 'Museum visitor guide. They charge £10 for admission. Children enter free.',
        locale: 'zh-CN'
    });

    assert.equal(result.kind, 'word');
    assert.equal(result.task, 'articleWordTranslation');
    assert.equal(result.meaning, '收费');
    assert.equal(result.phonetic, 'tʃɑːdʒ');
    assert.equal(result.pos, 'v.');
    assert.equal(result.provider, 'managed-main');
    assert.equal(result.model, 'gpt-managed-fast');
    assert.equal(result.thinking, 'low');

    // Verify the outbound provider request carried the contextual prompt, reasoning_effort='low', and managed bearer key
    const providerCall = fetchLog.find((item) => item.url === 'https://ai.mock.test/v1/chat/completions');
    assert.ok(providerCall, 'expected provider fetch');
    assert.equal(providerCall.headers.Authorization, 'Bearer sk-managed-secret-memory-only-9999');
    assert.equal(providerCall.body.reasoning_effort, 'low');
    const userPrompt = providerCall.body.messages[0].content;
    assert.ok(userPrompt.includes('Target word: "charge"'));
    assert.ok(userPrompt.includes('Sentence: "They charge £10 for admission."'));
    assert.ok(userPrompt.includes('Context: "Museum visitor guide. They charge £10 for admission. Children enter free."'));

    // Verify managed shared key is NEVER persisted in localStorage or chrome.storage.local
    for (let i = 0; i < storage.length; i += 1) {
        const k = storage.key(i);
        const v = storage.getItem(k) || '';
        assert.ok(!v.includes('sk-managed-secret-memory-only-9999'), `managed key leaked into localStorage key ${k}`);
    }
    for (const [k, v] of chromeStorageMap.entries()) {
        assert.ok(!JSON.stringify(v).includes('sk-managed-secret-memory-only-9999'), `managed key leaked into chrome.storage key ${k}`);
    }
});

test('2. cloud-synced personal provider path: pulls snapshot AI settings + downloads personal credential and prioritizes explicit task choice over managed default', async () => {
    resetStorageAndRuntime();
    mockState.snapshots.alice.payload.aiSettings.settings = {
        providers: {
            'personal-cloud': {
                id: 'personal-cloud',
                label: 'Alice Cloud OpenAI',
                enabled: true,
                format: 'openai-chat',
                apiUrl: 'https://personal.mock.test/v1/chat/completions',
                modelsUrl: 'https://personal.mock.test/v1/models',
                authMode: 'bearer',
                allowedModels: ['gpt-personal-pro']
            }
        },
        models: {
            wordAnalysis: 'personal-cloud:gpt-personal-pro'
        },
        tasks: {
            wordAnalysis: 'personal-cloud:gpt-personal-pro'
        },
        defaultModel: 'personal-cloud:gpt-personal-pro',
        keySyncDefault: 'cloud',
        thinking: {
            articleWordTranslation: 'high'
        }
    };
    mockState.personalCredentials.alice['personal-cloud'] = {
        version: 1,
        deleted: false,
        apiKey: 'sk-personal-cloud-alice-777',
        binding: {
            formatVersion: 1,
            format: 'openai-chat',
            apiUrl: 'https://personal.mock.test/v1/chat/completions',
            modelsUrl: 'https://personal.mock.test/v1/models',
            authMode: 'bearer'
        }
    };

    const readiness = await runtime.connectExtensionAccount({
        endpoint: 'https://sync.mock.test',
        mode: 'password',
        username: 'alice',
        password: 'password-alice-123'
    });

    assert.equal(readiness.taskResolution.status, 'ready');
    assert.equal(readiness.taskResolution.provider, 'personal-cloud');
    assert.equal(readiness.taskResolution.model, 'gpt-personal-pro');
    assert.equal(readiness.taskResolution.thinking, 'high');
    assert.equal(readiness.missingLocalKeyProviders.length, 0);

    const res = await runtime.runExtensionLookup({
        text: 'take charge of',
        sentence: 'She decided to take charge of the project.',
        context: 'The team needed leadership. She decided to take charge of the project.',
        locale: 'zh-HK'
    });

    assert.equal(res.kind, 'phrase');
    assert.equal(res.task, 'articlePhraseTranslation');
    assert.equal(res.provider, 'personal-cloud');
    assert.equal(res.model, 'gpt-personal-pro');
    assert.equal(res.meaning, '負責；接管');

    const providerCall = fetchLog.find((item) => item.url === 'https://personal.mock.test/v1/chat/completions');
    assert.ok(providerCall, 'expected personal provider call');
    assert.equal(providerCall.headers.Authorization, 'Bearer sk-personal-cloud-alice-777');
});

test('3. local-only personal provider missing key: never silently falls back to managed provider, surfaces missing key, and isolates manual key import by endpoint + userId', async () => {
    resetStorageAndRuntime();
    mockState.snapshots.alice.payload.aiSettings.settings = {
        providers: {
            'personal-local': {
                id: 'personal-local',
                label: 'Alice Local-Only Provider',
                enabled: true,
                format: 'openai-chat',
                apiUrl: 'https://localonly.mock.test/v1/chat/completions',
                modelsUrl: 'https://localonly.mock.test/v1/models',
                authMode: 'bearer',
                allowedModels: ['local-model-1']
            }
        },
        models: {
            wordAnalysis: 'personal-local:local-model-1'
        },
        tasks: {
            wordAnalysis: 'personal-local:local-model-1'
        },
        defaultModel: 'personal-local:local-model-1',
        keySyncDefault: 'local-only'
    };
    // No cloud credential exists for personal-local

    const readiness = await runtime.connectExtensionAccount({
        endpoint: 'https://sync.mock.test',
        mode: 'password',
        username: 'alice',
        password: 'password-alice-123'
    });

    assert.equal(readiness.taskResolution.status, 'error');
    assert.equal(readiness.taskResolution.errorCode, 'ai_key_missing');
    assert.equal(readiness.taskResolution.selectedPersonalMissingKey, true);
    assert.equal(readiness.missingLocalKeyProviders.length, 1);
    assert.equal(readiness.missingLocalKeyProviders[0].id, 'personal-local');

    // Attempting lookup must fail with ai_key_missing and NEVER silently call managed-main
    await assert.rejects(
        () => runtime.runExtensionLookup({
            text: 'charge',
            sentence: 'They charge £10 for admission.'
        }),
        (err) => err && err.code === 'ai_key_missing'
    );
    assert.equal(fetchLog.some((item) => item.url === 'https://ai.mock.test/v1/chat/completions'), false);

    // Manually import local key for Alice on https://sync.mock.test
    const imported = runtime.importScopedLocalProviderKey({
        providerId: 'personal-local',
        apiKey: 'sk-alice-manual-local-12345'
    });
    assert.equal(imported.ok, true);
    assert.deepEqual(imported.scope, { endpoint: 'https://sync.mock.test', userId: 'alice' });

    const afterImport = runtime.getExtensionReadiness({ text: 'charge' });
    assert.equal(afterImport.taskResolution.status, 'ready');
    assert.equal(afterImport.missingLocalKeyProviders.length, 0);

    const lookupRes = await runtime.runExtensionLookup({
        text: 'charge',
        sentence: 'They charge £10 for admission.'
    });
    assert.equal(lookupRes.meaning, '收费');
    assert.equal(lookupRes.provider, 'personal-local');

    // Switch to Bob on the same endpoint: Bob must NOT inherit Alice's imported local key
    mockState.snapshots.bob.payload.aiSettings.settings = mockState.snapshots.alice.payload.aiSettings.settings;
    const bobReadiness = await runtime.connectExtensionAccount({
        endpoint: 'https://sync.mock.test',
        mode: 'password',
        username: 'bob',
        password: 'password-bob-123'
    });
    assert.equal(bobReadiness.userId, 'bob');
    assert.equal(bobReadiness.taskResolution.status, 'error');
    assert.equal(bobReadiness.taskResolution.errorCode, 'ai_key_missing');
    assert.equal(bobReadiness.missingLocalKeyProviders.length, 1);
});

test('4. contextual cache isolation: partitions by endpoint, userId, provider:model, word, sentence, context, locale, promptVersion, and thinking', async () => {
    resetStorageAndRuntime();
    await runtime.connectExtensionAccount({
        endpoint: 'https://sync.mock.test',
        mode: 'password',
        username: 'alice',
        password: 'password-alice-123'
    });

    const providerCalls = () => fetchLog.filter((item) => item.url === 'https://ai.mock.test/v1/chat/completions').length;
    assert.equal(providerCalls(), 0);

    // 1st call: cache miss -> hits provider
    await runtime.runExtensionLookup({
        text: 'charge',
        sentence: 'They charge £10 for admission.',
        context: 'Context A',
        locale: 'zh-CN'
    });
    assert.equal(providerCalls(), 1);

    // Identical call: cache hit -> no new provider request
    await runtime.runExtensionLookup({
        text: 'charge',
        sentence: 'They charge £10 for admission.',
        context: 'Context A',
        locale: 'zh-CN'
    });
    assert.equal(providerCalls(), 1);

    // Different nearby context: cache miss -> hits provider
    await runtime.runExtensionLookup({
        text: 'charge',
        sentence: 'They charge £10 for admission.',
        context: 'Context B (different paragraph)',
        locale: 'zh-CN'
    });
    assert.equal(providerCalls(), 2);

    // Different sentence: cache miss -> hits provider
    await runtime.runExtensionLookup({
        text: 'charge',
        sentence: 'The cavalry led the charge.',
        context: 'Context A',
        locale: 'zh-CN'
    });
    assert.equal(providerCalls(), 3);

    // Different locale (zh-HK): cache miss -> hits provider
    await runtime.runExtensionLookup({
        text: 'charge',
        sentence: 'They charge £10 for admission.',
        context: 'Context A',
        locale: 'zh-HK'
    });
    assert.equal(providerCalls(), 4);

    // Switch account to Bob: Bob's lookup for identical text/sentence/context/locale must NOT reuse Alice's cache
    await runtime.connectExtensionAccount({
        endpoint: 'https://sync.mock.test',
        mode: 'password',
        username: 'bob',
        password: 'password-bob-123'
    });
    await runtime.runExtensionLookup({
        text: 'charge',
        sentence: 'They charge £10 for admission.',
        context: 'Context A',
        locale: 'zh-CN'
    });
    assert.equal(providerCalls(), 5);

    // Switch endpoint to sync-two.mock.test for Bob: must NOT reuse sync.mock.test cache
    await runtime.connectExtensionAccount({
        endpoint: 'https://sync-two.mock.test',
        mode: 'password',
        username: 'bob',
        password: 'password-bob-123'
    });
    await runtime.runExtensionLookup({
        text: 'charge',
        sentence: 'They charge £10 for admission.',
        context: 'Context A',
        locale: 'zh-CN'
    });
    assert.equal(providerCalls(), 6);
});

test('5. account switch / logout / late response guard: aborts or discards stale lookup responses', async () => {
    resetStorageAndRuntime();
    await runtime.connectExtensionAccount({
        endpoint: 'https://sync.mock.test',
        mode: 'password',
        username: 'alice',
        password: 'password-alice-123'
    });

    let releaseProvider;
    const gate = new Promise((resolve) => { releaseProvider = resolve; });
    mockState.providerHandler = async () => {
        await gate;
        return jsonRes({
            choices: [{
                finish_reason: 'stop',
                message: {
                    content: JSON.stringify({
                        word: 'charge',
                        sentence: 'They charge £10 for admission.',
                        analysis: { phonetic: 'tʃɑːdʒ', pos: 'v.', meaning: 'Alice 延迟响应', role: 'v.' }
                    })
                }
            }]
        });
    };

    const inFlight = runtime.runExtensionLookup({
        text: 'charge',
        sentence: 'They charge £10 for admission.'
    });

    // Switch account to Bob while Alice's lookup is still in flight
    await runtime.connectExtensionAccount({
        endpoint: 'https://sync.mock.test',
        mode: 'password',
        username: 'bob',
        password: 'password-bob-123'
    });
    releaseProvider();

    await assert.rejects(
        () => inFlight,
        (err) => err && (err.code === 'stale_session' || err.name === 'AbortError' || /session|切换|切換|abort/i.test(String(err.message || '')))
    );
});

test('6. selection extractor and deterministic extension packager verify relative imports and secret-free ai-config.js', () => {
    const extracted = extractSentenceAndContextFromText(
        'First introductory sentence. They charge £10 for admission at the gate. Visitors can also buy an annual pass.',
        'charge'
    );
    assert.equal(extracted.text, 'charge');
    assert.equal(extracted.sentence, 'They charge £10 for admission at the gate.');
    assert.ok(extracted.context.includes('First introductory sentence.'));
    assert.ok(extracted.context.includes('Visitors can also buy an annual pass.'));

    const repeated = 'They charge £10 for admission. Remember to charge the battery.';
    assert.equal(extractSentenceAndContextFromText(repeated, 'charge', repeated.lastIndexOf('charge')).sentence, 'Remember to charge the battery.');

    const pkg = packageExtension();
    assert.ok(pkg.copiedCount >= 40);
    const extConfig = fs.readFileSync(path.join(ROOT, 'extension/ai-config.js'), 'utf8');
    const exampleConfig = fs.readFileSync(path.join(ROOT, 'ai-config.example.js'), 'utf8');
    assert.equal(extConfig, exampleConfig);
});

test('7. token and login-code modes use the existing account APIs', async () => {
    resetStorageAndRuntime();
    let readiness = await runtime.connectExtensionAccount({ endpoint: 'https://sync.mock.test', mode: 'token', token: mockState.users.alice.token });
    assert.equal(readiness.userId, 'alice');
    assert.equal(readiness.taskResolution.model, 'gpt-managed-fast');
    await runtime.disconnectExtensionAccount();
    readiness = await runtime.connectExtensionAccount({ endpoint: 'https://sync.mock.test', mode: 'code', loginCode: '23456789ABCDEFGH' });
    assert.equal(readiness.userId, 'alice');
    assert.ok(fetchLog.some((call) => call.url.endsWith('/pair') && call.body.code === '23456789ABCDEFGH'));
});

test('8. failed cloud credential downloads retain diagnostics and recover on retry', async () => {
    resetStorageAndRuntime();
    const binding = { format: 'openai-chat', apiUrl: 'https://personal.mock.test/v1/chat/completions', modelsUrl: 'https://personal.mock.test/v1/models', authMode: 'bearer' };
    mockState.snapshots.alice.payload.aiSettings.settings = {
        providers: { 'personal-retry': { ...binding, label: 'Retry provider', enabled: true, allowedModels: ['retry-model'] } },
        tasks: { wordAnalysis: 'personal-retry:retry-model' }, models: { wordAnalysis: 'personal-retry:retry-model' }
    };
    mockState.personalCredentials.alice['personal-retry'] = { version: 1, deleted: false, apiKey: 'fixture-retry-key', binding };
    const originalFetch = globalThis.fetch;
    let failing = true;
    globalThis.fetch = (input, init) => failing && String(input).endsWith('/ai-credentials/personal-retry')
        ? Promise.resolve(jsonRes({ error: 'provider_unavailable' }, 500)) : originalFetch(input, init);
    try {
        const readiness = await runtime.connectExtensionAccount({ endpoint: 'https://sync.mock.test', mode: 'password', username: 'alice', password: mockState.users.alice.password });
        assert.notEqual(readiness.credentialSync.status, 'synced');
        assert.equal(readiness.credentialSync.error, 'download_failed:500');
        assert.equal(readiness.missingLocalKeyProviders[0].lastError, 'download_failed:500');
        failing = false;
        const recovered = await runtime.syncExtensionAccountAI();
        assert.equal(recovered.credentialSync.status, 'synced');
        assert.equal(recovered.credentialSync.error, '');
        assert.equal(recovered.missingLocalKeyProviders.length, 0);
    } finally { globalThis.fetch = originalFetch; }
});

test('9. standalone word lookup validates structured meanings before caching', async () => {
    resetStorageAndRuntime();
    await runtime.connectExtensionAccount({ endpoint: 'https://sync.mock.test', mode: 'password', username: 'alice', password: mockState.users.alice.password });
    const result = await runtime.runExtensionLookup({ text: 'charge' });
    assert.equal(result.task, 'wordAnalysis');
    assert.equal(result.meaning, '收费');
    const count = fetchLog.length;
    assert.equal((await runtime.runExtensionLookup({ text: 'charge' })).meaning, '收费');
    assert.equal(fetchLog.length, count);
    mockState.providerHandler = async () => jsonRes({ choices: [{ finish_reason: 'stop', message: { content: '{"meaning":123}' } }] });
    await assert.rejects(runtime.runExtensionLookup({ text: 'battery' }), { code: 'invalid_response' });
    mockState.providerHandler = async () => jsonRes({ choices: [{ finish_reason: 'stop', message: { content: '{"phonetic":"","pos":"n.","meaning":"电池"}' } }] });
    assert.equal((await runtime.runExtensionLookup({ text: 'battery' })).meaning, '电池');
});

test('10. tasks-only account snapshots and mixed patches preserve task model mappings', async () => {
    resetStorageAndRuntime();
    mockState.catalog.providers[0].models.push({ id: 'gpt-managed-alt' });
    mockState.snapshots.alice.payload.aiSettings.settings = {
        providers: {}, models: {}, tasks: { wordAnalysis: 'managed-main:gpt-managed-alt' }, thinking: { wordAnalysis: 'medium' }
    };
    await runtime.connectExtensionAccount({ endpoint: 'https://sync.mock.test', mode: 'token', token: mockState.users.alice.token });
    assert.equal(runtime.getExtensionAITaskSettings('wordAnalysis').model, 'managed-main:gpt-managed-alt');
    assert.equal(runtime.getExtensionAITaskSettings('wordAnalysis').thinking, 'medium');
    const { applyAISettingsPatch } = await import('../extension/modules/ai-profile-storage.js');
    const profile = applyAISettingsPatch({
        tasks: { wordAnalysis: 'managed-main:gpt-managed-alt', articleCleanup: 'managed-main:gpt-managed-alt' },
        models: { wordAnalysis: 'managed-main:gpt-managed-fast' }
    });
    assert.equal(profile.taskModels.wordAnalysis, 'managed-main:gpt-managed-fast');
    assert.equal(profile.taskModels.articleCleanup, 'managed-main:gpt-managed-alt');
});

test('11. extension phrase lookups omit examples while full details and older full caches remain usable', async () => {
    resetStorageAndRuntime();
    await runtime.connectExtensionAccount({ endpoint: 'https://sync.mock.test', mode: 'token', token: mockState.users.alice.token });
    const examples = [{ en: 'She took charge of the team.', zh: '她接管了團隊。' }, { en: 'He took charge of the project.', zh: '他接管了項目。' }];
    const requests = [];
    mockState.providerHandler = async ({ body }) => {
        requests.push(body);
        const concise = body.messages[0].content.includes('Do not generate examples');
        return jsonRes({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
            phonetic: 'teɪk tʃɑːdʒ ɒv', meaning: '接管', usage: '動詞短語', ...(concise ? {} : { examples })
        }) } }] });
    };
    const input = { text: 'take charge of', sentence: 'She took charge of the team.' };
    const concise = await runtime.runExtensionLookup(input);
    assert.equal(concise.meaning, '接管');
    assert.deepEqual(concise.examples, []);
    assert.equal(requests.length, 1);
    assert.ok(!requests[0].messages[0].content.includes('"examples"'));
    assert.equal(requests[0].reasoning_effort, 'low');
    const full = await runtime.lookupSelection(input);
    assert.deepEqual(full.examples, examples);
    assert.equal(requests.length, 2, 'concise cache must not satisfy a full-details request');
    assert.equal((await runtime.runExtensionLookup(input)).fromCache, true);
    assert.equal(requests.length, 2);
    const older = { text: 'take control of', sentence: 'She took control of the team.' };
    await runtime.lookupSelection(older);
    assert.deepEqual((await runtime.runExtensionLookup(older)).examples, examples);
    assert.equal(requests.length, 3, 'complete older cache can satisfy extension lookup without another request');
});

test('12. on-demand examples follow the completed meaning/model/thinking and cache independently by context and language', async () => {
    resetStorageAndRuntime();
    await runtime.connectExtensionAccount({ endpoint: 'https://sync.mock.test', mode: 'token', token: mockState.users.alice.token });
    const result = await runtime.runExtensionLookup({ text: 'charge', sentence: 'They charge £10 for admission.', context: 'Museum guide.' });
    const requests = [];
    const examples = [{ en: 'They charge a small fee.', zh: '他們收取少量費用。' }, { en: 'We charge ten pounds.', zh: '我們收取十英鎊。' }];
    mockState.providerHandler = async ({ body }) => {
        requests.push(body);
        return jsonRes({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ examples }) } }] });
    };
    assert.equal(requests.length, 0);
    assert.deepEqual(await runtime.runExtensionLookupExamples(result), examples);
    const prompt = requests[0].messages[0].content;
    assert.ok(prompt.includes(JSON.stringify(result.meaning)));
    assert.ok(prompt.includes('Museum guide.'));
    assert.ok(prompt.includes('exactly 2'));
    assert.equal(requests[0].model, result.model);
    assert.equal(requests[0].reasoning_effort, result.thinking);
    assert.deepEqual(await runtime.runExtensionLookupExamples(result), examples);
    assert.equal(requests.length, 1);
    await runtime.runExtensionLookupExamples({ ...result, meaning: '指控' });
    await runtime.runExtensionLookupExamples({ ...result, context: 'Battery instructions.' });
    await runtime.runExtensionLookupExamples({ ...result, locale: 'zh-HK' });
    assert.equal(requests.length, 4, 'meaning, nearby context and locale each isolate the examples cache');
    assert.ok(requests[3].messages[0].content.includes('香港繁體中文'));
});

test('13. malformed examples are retryable and logout discards delayed examples and rejects the previous account result', async () => {
    resetStorageAndRuntime();
    await runtime.connectExtensionAccount({ endpoint: 'https://sync.mock.test', mode: 'token', token: mockState.users.alice.token });
    const result = await runtime.runExtensionLookup({ text: 'charge', sentence: 'They charge admission.' });
    let requests = 0, valid = false;
    const examples = [{ en: 'They charge admission.', zh: '他們收取入場費。' }, { en: 'We charge a fee.', zh: '我們收取費用。' }];
    mockState.providerHandler = async () => {
        requests += 1;
        return jsonRes({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ examples: valid ? examples : [{ en: 'Incomplete.' }] }) } }] });
    };
    await assert.rejects(runtime.runExtensionLookupExamples(result), { code: 'invalid_response' });
    valid = true;
    assert.deepEqual(await runtime.runExtensionLookupExamples(result), examples);
    assert.equal(requests, 2, 'a failed response must not poison the cache');
    let release, started;
    const gate = new Promise((resolve) => { release = resolve; });
    const ready = new Promise((resolve) => { started = resolve; });
    mockState.providerHandler = async () => {
        started();
        await gate;
        return jsonRes({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ examples }) } }] });
    };
    const pending = runtime.runExtensionLookupExamples({ ...result, meaning: '新釋義' });
    const rejection = assert.rejects(pending, (error) => error.code === 'stale_session' || error.name === 'AbortError');
    await ready;
    await runtime.disconnectExtensionAccount();
    release();
    await rejection;
    await runtime.connectExtensionAccount({ endpoint: 'https://sync.mock.test', mode: 'token', token: mockState.users.bob.token });
    await assert.rejects(runtime.runExtensionLookupExamples(result), { code: 'stale_session' });
});

after(() => {
    runtime.stopExtensionRuntimeTimers();
});
