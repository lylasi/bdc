// Independent second-review regressions. Fake keys and mock fetch only.
// These assertions describe the required behavior and currently fail.
import test from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Minimal browser globals
// ---------------------------------------------------------------------------
const store = new Map();
const localStorageShim = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
    removeItem: (key) => { store.delete(key); },
    key: (index) => [...store.keys()][index] || null,
    get length() { return store.size; }
};

class StubEmitter {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, callback) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type).add(callback);
    }
    removeEventListener(type, callback) {
        const set = this.listeners.get(type);
        if (set) set.delete(callback);
    }
    dispatchEvent(event) {
        const set = this.listeners.get(event && event.type);
        if (set) for (const callback of [...set]) callback(event);
        return true;
    }
}

globalThis.CustomEvent = class CustomEvent {
    constructor(type, init = {}) {
        this.type = type;
        this.detail = init && init.detail;
    }
};
const win = new StubEmitter();
win.localStorage = localStorageShim;
globalThis.window = win;
const doc = new StubEmitter();
doc.hidden = false;
doc.documentElement = {};
globalThis.document = doc;
globalThis.localStorage = localStorageShim;
globalThis.Audio = class {
    play() { return Promise.resolve(); }
    pause() {}
    addEventListener() {}
    removeEventListener() {}
};
// Test endpoint override: ai-config.js (private) is never inspected.
globalThis.__BDC_SYNC_ENDPOINT__ = 'https://worker.mock';

const WORKER = 'https://worker.mock';
const GUEST_SCOPE = { endpoint: WORKER, userId: '', guest: true, key: 'bdc_ai_profile_v1:device:guest' };

const auth = (await import('../../../modules/sync-cloudflare.js')).auth;
const authMod = await import('../../../modules/sync-cloudflare.js');
const profile = await import('../../../modules/ai-profile-storage.js');
const sync = await import('../../../modules/ai-credential-sync.js');
const catalog = await import('../../../modules/ai-catalog.js');

// ---------------------------------------------------------------------------
// Mock Worker
// ---------------------------------------------------------------------------
const BINDING = {
    formatVersion: 1,
    format: 'openai-chat',
    apiUrl: 'https://provider.mock/v1/chat/completions',
    modelsUrl: 'https://provider.mock/v1/models',
    authMode: 'bearer'
};
const PROVIDER_DEF = {
    label: 'Remote',
    enabled: true,
    format: 'openai-chat',
    baseUrl: 'https://provider.mock/v1',
    apiUrl: BINDING.apiUrl,
    modelsUrl: BINDING.modelsUrl,
    authMode: 'bearer',
    allowedModels: ['m1'],
    discoveredModels: [{ id: 'm1' }]
};

const fake = {
    tokens: new Map([['token-A', 'A'], ['token-B', 'B']]),
    remote: new Map(),      // providerId -> row meta
    keys: new Map(),        // providerId -> { apiKey, version }
    requests: [],
    catalogOfflineFor: ''   // user id whose /ai-catalog request fails
};

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}

let holdState = null;

function beginHold(path, method = 'PUT') {
    let release;
    const promise = new Promise((resolve) => { release = (response) => resolve(response); });
    const hold = { path, method, promise, started: false };
    holdState = hold;
    const releaseAndClear = (response) => {
        if (holdState === hold) holdState = null;
        release(response);
    };
    return {
        get started() { return hold.started; },
        releaseJson: (data, status = 200) => releaseAndClear(jsonResponse(data, status))
    };
}

globalThis.fetch = async (input, init = {}) => {
    const raw = typeof input === 'string' ? input : input.url;
    const url = new URL(raw);
    const method = String(init.method || 'GET').toUpperCase();
    const token = String((init.headers && init.headers.Authorization) || '').replace(/^Bearer\s+/i, '');
    const userId = fake.tokens.get(token) || '';
    fake.requests.push({ path: url.pathname, method, token, userId });

    if (url.hostname === 'provider.mock') {
        return jsonResponse({ data: [{ id: 'm1' }, { id: 'm2' }] });
    }
    if (url.hostname !== 'worker.mock') throw new TypeError(`unexpected host ${url.hostname}`);

    if (url.pathname === '/me') {
        if (!userId) return jsonResponse({ error: 'unauthorized', code: 'unauthorized' }, 401);
        return jsonResponse({ user_id: userId, label: userId, role: 'user' });
    }
    if (!userId) return jsonResponse({ error: 'unauthorized', code: 'unauthorized' }, 401);

    if (url.pathname === '/ai-credentials' && method === 'GET') {
        return jsonResponse({
            items: [...fake.remote.entries()].map(([providerId, row]) => ({
                providerId,
                version: row.version,
                deleted: row.deleted,
                binding: row.binding,
                lastMutationId: row.lastMutationId || '',
                updatedAt: row.updatedAt || '2026-10-17T00:00:00.000Z'
            }))
        });
    }
    const single = url.pathname.match(/^\/ai-credentials\/([^/]+)$/);
    if (single) {
        const providerId = decodeURIComponent(single[1]);
        if (holdState && holdState.path === providerId && holdState.method === method) {
            holdState.started = true;
            return holdState.promise;
        }
        const row = fake.remote.get(providerId) || null;
        if (method === 'GET') {
            if (!row || row.deleted) return jsonResponse({ error: 'credential_not_found' }, 404);
            const key = fake.keys.get(providerId);
            return jsonResponse({
                providerId,
                version: row.version,
                deleted: false,
                binding: row.binding,
                apiKey: key ? key.apiKey : '',
                credentialRevision: key ? key.version : 0,
                lastMutationId: row.lastMutationId || ''
            });
        }
        if (method === 'PUT') {
            const body = init.body ? JSON.parse(init.body) : {};
            const expected = row ? row.version : 0;
            if (body.expectedVersion !== expected) return jsonResponse({ error: 'version_conflict', version: expected }, 409);
            const version = expected + 1;
            fake.remote.set(providerId, {
                version,
                deleted: false,
                binding: body.binding,
                lastMutationId: body.mutationId || 'mut'
            });
            fake.keys.set(providerId, { apiKey: body.apiKey, version });
            return jsonResponse({ providerId, version, deleted: false, lastMutationId: body.mutationId || 'mut' });
        }
        if (method === 'DELETE') {
            const body = init.body ? JSON.parse(init.body) : {};
            const expected = row ? row.version : 0;
            if (!row || row.deleted) return jsonResponse({ error: 'credential_not_found' }, 404);
            if (body.expectedVersion !== expected) return jsonResponse({ error: 'version_conflict', version: expected }, 409);
            const version = expected + 1;
            fake.remote.set(providerId, { version, deleted: true, binding: row.binding, lastMutationId: body.mutationId || 'mut' });
            fake.keys.delete(providerId);
            return jsonResponse({ providerId, version, deleted: true, lastMutationId: body.mutationId || 'mut' });
        }
    }
    if (url.pathname === '/ai-catalog') {
        if (fake.catalogOfflineFor && fake.catalogOfflineFor === userId) {
            throw new TypeError('mock offline');
        }
        return jsonResponse({
            version: 1,
            providers: [{ id: 'managed-test', name: 'Test', enabled: true, ...BINDING, models: [{ id: 'm1' }] }],
            tasks: {},
            expiresAt: new Date(Date.now() + 3600000).toISOString()
        });
    }
    if (url.pathname.startsWith('/ai-catalog/providers/')) {
        return jsonResponse({ apiKey: 'shared-key', catalogVersion: 1, credentialRevision: 1, binding: BINDING });
    }
    return jsonResponse({ error: 'not_found' }, 404);
};

function waitUntil(predicate, timeoutMs = 2000) {
    const started = Date.now();
    return new Promise((resolve, reject) => {
        const tick = () => {
            let value = false;
            try { value = predicate(); } catch (_) { value = false; }
            if (value) return resolve(true);
            if (Date.now() - started > timeoutMs) return reject(new Error('timeout waiting for condition'));
            setTimeout(tick, 5);
        };
        tick();
    });
}

async function resetAll() {
    sync.stopCredentialSync();
    if (holdState) {
        try { holdState.releaseJson({}, 401); } catch (_) {}
        holdState = null;
    }
    fake.remote.clear();
    fake.keys.clear();
    fake.requests.length = 0;
    fake.catalogOfflineFor = '';
    store.clear();
    await auth.signOut();
    store.clear();
}

async function signIn(userId) {
    await auth.signInWithToken(`token-${userId}`);
}

/** Release a held PUT and record the row the server would have written. */
function commitHeldPut(providerId, { apiKey = '', version = 1, mutationId = 'held' } = {}) {
    fake.remote.set(providerId, { version, deleted: false, binding: BINDING, lastMutationId: mutationId });
    fake.keys.set(providerId, { apiKey, version });
    return { providerId, version, deleted: false, lastMutationId: mutationId };
}

function requestsFor(providerId, method = 'GET') {
    return fake.requests.filter((entry) => entry.path === `/ai-credentials/${providerId}` && entry.method === method);
}

async function saveCloudProvider(providerId, { apiKey = 'key-1', label = 'Upload', syncMode = 'cloud' } = {}) {
    await sync.savePersonalProvider({
        providerId,
        provider: { ...PROVIDER_DEF, label, id: providerId },
        apiKey,
        keyChanged: true,
        syncMode
    });
    sync.stopCredentialSync();
}

// ---------------------------------------------------------------------------

test('R1: removing the cloud copy must retain the local key', async () => {
    await resetAll();
    await signIn('A');
    await saveCloudProvider('personal-remove');
    await sync.syncCredentials();
    assert.equal(profile.loadAIProfile().credentials['personal-remove'].version, 1);
    sync.removeCloudKey('personal-remove');
    sync.stopCredentialSync();
    await sync.syncCredentials();
    const cred = profile.loadAIProfile().credentials['personal-remove'];
    console.log('R1 observed', JSON.stringify({cloudDeleted:fake.remote.get('personal-remove').deleted, localHasKey:!!cred.apiKey, mode:cred.syncMode}));
    assert.equal(cred.apiKey, 'key-1', 'remove cloud erased the local key');
});

async function setupConflict(id) {
    await saveCloudProvider(id);
    profile.updateAIProfile(draft => {
        draft.credentials[id].conflict = { remoteVersion: 2, remoteDeleted: false, detectedAt: new Date().toISOString() };
        return draft;
    });
}

test('R2: conflict resolution must not overwrite a key edited during download', async () => {
    await resetAll();
    await signIn('A');
    await setupConflict('personal-conflict');
    const hold = beginHold('personal-conflict', 'GET');
    const pending = sync.resolveCredentialConflict('personal-conflict', 'cloud');
    await waitUntil(() => hold.started);
    await saveCloudProvider('personal-conflict', { apiKey: 'new-local-key' });
    hold.releaseJson({apiKey:'old-cloud-key', binding:BINDING, version:2});
    await pending;
    const cred = profile.loadAIProfile().credentials['personal-conflict'];
    console.log('R2 observed', JSON.stringify({retainedNewKey:cred.apiKey === 'new-local-key', pending:!!cred.pending}));
    assert.equal(cred.apiKey, 'new-local-key', 'old conflict result overwrote newer local key');
});

test('R3: conflict resolution must discard a previous login session result', async () => {
    await resetAll();
    await signIn('A');
    sync.initAICredentialSync();
    sync.stopCredentialSync();
    await setupConflict('personal-session');
    const hold = beginHold('personal-session', 'GET');
    const pending = sync.resolveCredentialConflict('personal-session', 'cloud');
    await waitUntil(() => hold.started);
    await auth.signOut();
    await signIn('A');
    await saveCloudProvider('personal-session', { apiKey: 'new-session-key' });
    hold.releaseJson({apiKey:'old-session-cloud-key', binding:BINDING, version:2});
    await pending;
    sync.stopCredentialSync();
    const cred = profile.loadAIProfile().credentials['personal-session'];
    console.log('R3 observed', JSON.stringify({retainedNewSessionKey:cred.apiKey === 'new-session-key', pending:!!cred.pending}));
    assert.equal(cred.apiKey, 'new-session-key', 'old session wrote into new login profile');
});
test.after(() => { sync.stopCredentialSync(); catalog.destroyAICatalog(); });

// Release guide pipe must inspect the input or reject the unsupported path.
test('R4: static checker must not report clean when it has not inspected stdin', async () => {
    const { spawnSync } = await import('node:child_process');
    const checker = new URL('../../../scripts/check-ai-static-config.mjs', import.meta.url);
    const { fileURLToPath } = await import('node:url');
    const result = spawnSync(process.execPath, [fileURLToPath(checker), '--dir', '/dev/stdin', '--json'], {
        input: 'export const API_KEY = "test-placeholder-only";\n',
        encoding: 'utf8'
    });
    const report = JSON.parse(result.stdout);
    console.log('R4 observed', JSON.stringify({ exitCode: result.status, ok: report.ok, findingCount: report.findings.length }));
    assert.notEqual(result.status, 0, 'unsupported input path silently passed');
});
