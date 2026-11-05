// DeepSeek independent verification: contextual cache identity and provider/model
// metadata of the shared lookupSelection() entry point.
//
// Desired behaviour (what this file asserts):
//   1. The contextual cache must be invalidated when the SAME provider id keeps the
//      SAME model but changes its apiUrl (a different upstream server must not be
//      served from the previous server's cached answer).
//   2. When the fallback model actually answers, the provider/model reported to the
//      caller must be the answering pair, not the primary pair.
//
// Run: node --test tests/extension-ai-cache-scope.test.mjs
// These regressions capture the original review findings and must pass after repair.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';

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
        removeEventListener(type, fn) { listenerMap.get(type)?.delete(fn); },
        dispatchEvent(event) {
            const set = listenerMap.get(event.type);
            if (!set) return true;
            for (const fn of Array.from(set)) { try { fn(event); } catch (_) {} }
            return true;
        }
    };
}

class CustomEventShim {
    constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
}

globalThis.localStorage = storage;
globalThis.Audio = class {};
globalThis.CustomEvent = CustomEventShim;
globalThis.window = {
    ...makeEventTarget(winListeners),
    location: { href: 'chrome-extension://cachetest1234/lookup.html', origin: 'chrome-extension://cachetest1234' }
};
globalThis.document = {
    ...makeEventTarget(docListeners),
    hidden: false,
    documentElement: { lang: 'zh-CN' },
    querySelectorAll() { return []; }
};
globalThis.chrome = {
    storage: {
        local: {
            async get(key) {
                if (typeof key === 'string') return { [key]: chromeStorageMap.get(key) };
                return Object.fromEntries(chromeStorageMap.entries());
            },
            async set(obj) { for (const [k, v] of Object.entries(obj || {})) chromeStorageMap.set(k, JSON.parse(JSON.stringify(v))); }
        }
    }
};

function jsonRes(body, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const SYNC_ORIGIN = 'https://sync.cache.test';
const P1 = 'https://p1.cache.test/v1/chat/completions';
const P2 = 'https://p2.cache.test/v1/chat/completions';
const PFAIL = 'https://pfail.cache.test/v1/chat/completions';
const POK = 'https://pok.cache.test/v1/chat/completions';

const state = {
    providerCalls: [],
    personalCredentials: {},
    failPrimaryProvider: false
};

function providerRoute(url) {
    if (url === P1) return 'p1';
    if (url === P2) return 'p2';
    if (url === PFAIL) return 'pfail';
    if (url === POK) return 'pok';
    return 'unknown';
}

globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = String(init.method || 'GET').toUpperCase();
    const headers = init.headers || {};
    const bodyText = typeof init.body === 'string' ? init.body : '';
    const parsedBody = bodyText ? (() => { try { return JSON.parse(bodyText); } catch (_) { return null; } })() : null;

    if (url.startsWith(SYNC_ORIGIN)) {
        const p = new URL(url).pathname;
        const bearer = String(headers.Authorization || headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
        if (p === '/login' && method === 'POST') {
            if (parsedBody?.username === 'alice' && parsedBody?.password === 'pwd-cache-1') {
                return jsonRes({ token: 'C'.repeat(40), user_id: 'alice', label: 'Alice', role: 'user' });
            }
            return jsonRes({ error: 'invalid_credentials' }, 401);
        }
        if (bearer !== 'C'.repeat(40)) return jsonRes({ error: 'unauthorized' }, 401);
        if (p === '/me') return jsonRes({ user_id: 'alice', label: 'Alice', role: 'user' });
        if (p === '/snapshot') return jsonRes(state.snapshot || { version: 1, payload: {} });
        if (p === '/ai-catalog') {
            return jsonRes({ version: 1, providers: [], tasks: {}, publishedAt: '2026-11-06T00:00:00.000Z', expiresAt: new Date(Date.now() + 3600_000).toISOString() });
        }
        if (p === '/ai-credentials') {
            const items = Object.entries(state.personalCredentials).map(([providerId, row]) => ({
                providerId, version: row.version, deleted: false, lastMutationId: '', binding: row.binding, updatedAt: '2026-11-06T00:00:00.000Z'
            }));
            return jsonRes({ items });
        }
        const credMatch = p.match(/^\/ai-credentials\/([^/]+)$/);
        if (credMatch && method === 'GET') {
            const pid = decodeURIComponent(credMatch[1]);
            const row = state.personalCredentials[pid];
            if (!row) return jsonRes({ error: 'not_found' }, 404);
            return jsonRes({ providerId: pid, version: row.version, deleted: false, apiKey: row.apiKey, binding: row.binding, lastMutationId: '' });
        }
        return jsonRes({ error: 'not_found' }, 404);
    }

    const route = providerRoute(url);
    state.providerCalls.push({ route, url, auth: headers.Authorization || headers.authorization || '' });
    if (route === 'pfail') return jsonRes({ error: 'boom' }, 500);
    const prompt = (parsedBody?.messages || []).map((m) => m.content).join('\n');
    const wordMatch = prompt.match(/Target word:\s*"([^"]*)"/);
    const sentenceMatch = prompt.match(/Sentence:\s*"([^"]*)"/);
    return jsonRes({
        choices: [{
            finish_reason: 'stop',
            message: {
                content: JSON.stringify({
                    word: wordMatch ? wordMatch[1] : 'charge',
                    sentence: sentenceMatch ? sentenceMatch[1] : '',
                    analysis: { phonetic: 'tʃɑːdʒ', pos: 'v.', meaning: `from-${route}`, role: 'v.' }
                })
            }
        }]
    });
};

const { packageExtension } = await import('../scripts/package-extension.mjs');
packageExtension();
const runtime = await import('../extension/modules/extension-ai-runtime.js');
const { setLocale } = await import('../extension/modules/i18n.js');
const cache = await import('../extension/modules/cache.js');

function providerBinding(apiUrl) {
    return { formatVersion: 1, format: 'openai-chat', apiUrl, modelsUrl: apiUrl.replace('/chat/completions', '/models'), authMode: 'bearer' };
}

function aliceSnapshot({ providerId, apiUrl, model, fallback = null }) {
    const spec = `${providerId}:${model}`;
    const tasks = { wordAnalysis: spec, articleWordTranslation: spec, articleWordTooltip: spec };
    const models = { wordAnalysis: spec, articleWordTranslation: spec, articleWordTooltip: spec };
    const providers = {
        [providerId]: {
            id: providerId, label: 'Alice Provider', enabled: true, format: 'openai-chat',
            apiUrl, modelsUrl: apiUrl.replace('/chat/completions', '/models'), authMode: 'bearer', allowedModels: [model]
        }
    };
    if (fallback) {
        providers[fallback.providerId] = {
            id: fallback.providerId, label: 'Alice Fallback', enabled: true, format: 'openai-chat',
            apiUrl: fallback.apiUrl, modelsUrl: fallback.apiUrl.replace('/chat/completions', '/models'), authMode: 'bearer', allowedModels: [fallback.model]
        };
        const fbSpec = `${fallback.providerId}:${fallback.model}`;
        tasks.articleWordTranslationFallback = fbSpec;
        models.articleWordTranslationFallback = fbSpec;
    }
    return {
        version: 1,
        payload: {
            aiSettings: {
                updatedAt: '2026-11-06T00:00:00.000Z',
                settings: { providers, models, tasks, defaultModel: '', keySyncDefault: 'cloud' }
            }
        }
    };
}

async function resetAll() {
    try { await runtime.disconnectExtensionAccount(); } catch (_) {}
    storage.clear();
    chromeStorageMap.clear();
    state.providerCalls = [];
    state.personalCredentials = {};
    await cache.clearRebuildable().catch(() => {});
    setLocale('zh-CN', { persist: true });
    await runtime.restoreTrustedSessionState();
}

async function login() {
    return runtime.connectExtensionAccount({
        endpoint: SYNC_ORIGIN,
        mode: 'password',
        username: 'alice',
        password: 'pwd-cache-1'
    });
}

test('C1 同一個 provider id 只改 apiUrl（模型不變）時，查詞快取不得沿用舊上游的回答', async () => {
    await resetAll();
    state.snapshot = aliceSnapshot({ providerId: 'personal-a', apiUrl: P1, model: 'model-1' });
    state.personalCredentials['personal-a'] = { version: 1, apiKey: 'sk-cache-scope-1', binding: providerBinding(P1) };
    await login();

    const first = await runtime.runExtensionLookup({
        text: 'charge',
        sentence: 'They charge £10 for admission.',
        context: 'Museum guide.',
        locale: 'zh-CN'
    });
    assert.equal(first.meaning, 'from-p1');
    assert.equal(state.providerCalls.filter((c) => c.route === 'p1').length, 1);

    // Same provider id + same model, only the upstream apiUrl changed.
    state.snapshot = aliceSnapshot({ providerId: 'personal-a', apiUrl: P2, model: 'model-1' });
    state.personalCredentials['personal-a'] = { version: 2, apiKey: 'sk-cache-scope-1', binding: providerBinding(P2) };
    await runtime.syncExtensionAccountAI();

    const second = await runtime.runExtensionLookup({
        text: 'charge',
        sentence: 'They charge £10 for admission.',
        context: 'Museum guide.',
        locale: 'zh-CN'
    });
    const p1Calls = state.providerCalls.filter((c) => c.route === 'p1').length;
    const p2Calls = state.providerCalls.filter((c) => c.route === 'p2').length;
    assert.equal(
        p2Calls,
        1,
        `apiUrl 變更後應重新請求新上游；實際 p1=${p1Calls} p2=${p2Calls} 回傳=${second.meaning}`
    );
    assert.equal(second.meaning, 'from-p2');
});

test('C2 fallback 模型實際回應時，回傳的 provider/model 必須是實際應答的模型', async () => {
    await resetAll();
    state.snapshot = aliceSnapshot({
        providerId: 'personal-primary',
        apiUrl: PFAIL,
        model: 'primary-model',
        fallback: { providerId: 'personal-fallback', apiUrl: POK, model: 'fallback-model' }
    });
    state.personalCredentials['personal-primary'] = { version: 1, apiKey: 'sk-primary', binding: providerBinding(PFAIL) };
    state.personalCredentials['personal-fallback'] = { version: 1, apiKey: 'sk-fallback', binding: providerBinding(POK) };
    await login();

    const result = await runtime.runExtensionLookup({
        text: 'charge',
        sentence: 'They charge £10 for admission.',
        context: 'Museum guide.',
        locale: 'zh-CN',
        noCache: true
    });

    assert.equal(result.meaning, 'from-pok', '前提：由 fallback 上游實際回答');
    assert.equal(state.providerCalls.filter((c) => c.route === 'pok').length, 1);
    assert.equal(
        `${result.provider}:${result.model}`,
        'personal-fallback:fallback-model',
        `回傳的 provider/model 必須是實際應答者；實際=${result.provider}:${result.model}`
    );
    const callsBeforeCache = state.providerCalls.length;
    const cached = await runtime.runExtensionLookup({ text: 'charge', sentence: 'They charge £10 for admission.', context: 'Museum guide.', locale: 'zh-CN' });
    assert.equal(`${cached.provider}:${cached.model}`, 'personal-fallback:fallback-model');
    assert.equal(state.providerCalls.length, callsBeforeCache);
});

test('C3 憑證 binding 與供應商定義不一致時必須拒絕使用，且不得靜默改用其他供應商', async () => {
    await resetAll();
    state.snapshot = aliceSnapshot({ providerId: 'personal-b', apiUrl: P1, model: 'model-1' });
    // Credential was stored for a DIFFERENT apiUrl than the provider now declares.
    state.personalCredentials['personal-b'] = { version: 1, apiKey: 'sk-mismatched-key', binding: providerBinding(P2) };
    await login();

    const callsBefore = state.providerCalls.length;
    let caught = null;
    try {
        await runtime.runExtensionLookup({
            text: 'charge',
            sentence: 'They charge £10 for admission.',
            context: 'Museum guide.',
            locale: 'zh-CN',
            noCache: true
        });
    } catch (error) {
        caught = error;
    }
    const calls = state.providerCalls.slice(callsBefore);
    assert.ok(caught, 'binding 不一致時查詞必須失敗，不得靜默成功');
    assert.ok(
        /binding|key_missing|ai_key/i.test(String(caught.code || '') + ' ' + String(caught.message || '')),
        `錯誤應指向金鑰/binding 問題；實際 code=${caught.code} message=${caught.message}`
    );
    assert.equal(calls.length, 0, `binding 不一致時不得向上游發出請求；實際=${JSON.stringify(calls.map((c) => c.route))}`);
});

after(() => {
    runtime.stopExtensionRuntimeTimers();
});
