// Regression tests for the six issues found by the independent review of the
// "D1 per-user AI provider sync" plan.
//
// Usage: node --test tests/ai-sync-regressions.test.mjs
//
// F1  new device downloads credentials that only exist on the server
// F2  a sync in flight never reverts a provider saved / re-keyed / deleted or a
//     task model changed while the request was waiting
// F3  a late 401 from an older account/session must not sign out the new one
// F4  switching accounts immediately locks managed providers and drops keys
// F6  legacy per-task model choices survive the migration
//
// F5 (admin model discovery must not widen the published whitelist) and the
// admin simplified add form are covered by the browser regression script
// tests/ai-review-regressions.mjs, because they live in the DOM.
//
// Everything runs against a mock Worker; no real service, key or D1 is touched.

import test, { after } from 'node:test';
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

const auth = (await import('../modules/sync-cloudflare.js')).auth;
const authMod = await import('../modules/sync-cloudflare.js');
const profile = await import('../modules/ai-profile-storage.js');
const sync = await import('../modules/ai-credential-sync.js');
const catalog = await import('../modules/ai-catalog.js');
const sanitizeMod = await import('../modules/ai-settings-sanitize.js');

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
// F1 — new device
// ---------------------------------------------------------------------------
test('F1: a new device downloads the key that only exists on the server', async () => {
    await resetAll();
    await signIn('A');
    fake.remote.set('personal-test', { version: 1, deleted: false, binding: BINDING, lastMutationId: 'remote1' });
    fake.keys.set('personal-test', { apiKey: 'remote-key', version: 1 });

    // Provider definitions arrive through the ordinary snapshot; no credentials.
    profile.applyRemoteAISettings({
        providers: { 'personal-test': PROVIDER_DEF },
        models: { assistant: 'personal-test:m1' }
    }, new Date().toISOString());
    assert.equal(Object.keys(profile.loadAIProfile().credentials).length, 0, 'expected an empty credential map');

    const state = await sync.syncCredentials({ reason: 'cold-device' });
    const loaded = profile.loadAIProfile();
    const credential = loaded.credentials['personal-test'];
    assert.ok(credential, 'credential row was not created');
    assert.equal(credential.apiKey, 'remote-key');
    assert.equal(credential.version, 1);
    assert.equal(credential.syncMode, 'cloud');
    assert.equal(credential.pending, null);
    assert.equal(credential.bindingVerified, true);
    assert.equal(requestsFor('personal-test').length, 1, 'the key was not downloaded');
    assert.notEqual(state.status, 'unauthorized');
    sync.stopCredentialSync();
});

test('F1: an explicit local-only key is never replaced by the cloud copy', async () => {
    await resetAll();
    await signIn('A');
    fake.remote.set('personal-keep', { version: 4, deleted: false, binding: BINDING, lastMutationId: 'remote4' });
    fake.keys.set('personal-keep', { apiKey: 'cloud-key', version: 4 });
    profile.saveAIProfile({
        providers: { 'personal-keep': PROVIDER_DEF },
        credentials: {
            'personal-keep': {
                apiKey: 'local-only-key',
                binding: BINDING,
                version: 0,
                syncMode: 'local-only'
            }
        }
    }, profile.getActiveAIScope());

    await sync.syncCredentials({ reason: 'local-only' });
    const credential = profile.loadAIProfile().credentials['personal-keep'];
    assert.equal(credential.apiKey, 'local-only-key');
    assert.equal(credential.syncMode, 'local-only');
    assert.equal(requestsFor('personal-keep').length, 0, 'local-only provider must not be downloaded');
    sync.stopCredentialSync();
});

test('F1: a cloud row bound to another endpoint is not downloaded', async () => {
    await resetAll();
    await signIn('A');
    fake.remote.set('personal-mismatch', {
        version: 2,
        deleted: false,
        binding: { ...BINDING, apiUrl: 'https://other.mock/v1/chat/completions' },
        lastMutationId: 'remote2'
    });
    profile.applyRemoteAISettings({
        providers: { 'personal-mismatch': PROVIDER_DEF },
        models: {}
    }, new Date().toISOString());

    await sync.syncCredentials({ reason: 'binding-mismatch' });
    const credential = profile.loadAIProfile().credentials['personal-mismatch'];
    assert.ok(credential, 'a paused credential row should be recorded');
    assert.equal(credential.apiKey, '', 'a key bound elsewhere must not be stored');
    assert.equal(credential.bindingVerified, false);
    assert.equal(credential.lastError, 'binding_mismatch');
    assert.equal(requestsFor('personal-mismatch').length, 0, 'the key must not even be requested');
    sync.stopCredentialSync();
});

test('F1: a remote delete tombstone never creates a local key', async () => {
    await resetAll();
    await signIn('A');
    fake.remote.set('personal-gone', { version: 3, deleted: true, binding: BINDING, lastMutationId: 'del3' });
    profile.applyRemoteAISettings({
        providers: { 'personal-gone': PROVIDER_DEF },
        models: {}
    }, new Date().toISOString());

    await sync.syncCredentials({ reason: 'tombstone' });
    const credential = profile.loadAIProfile().credentials['personal-gone'];
    assert.ok(!credential || credential.apiKey === '', 'a deleted row must not yield a key');
    assert.equal(requestsFor('personal-gone').length, 0);
    sync.stopCredentialSync();
});

// ---------------------------------------------------------------------------
// F2 — concurrent local edits during a sync
// ---------------------------------------------------------------------------
test('F2: a provider saved while an upload is in flight survives the sync', async () => {
    await resetAll();
    await signIn('A');
    await saveCloudProvider('personal-a', { apiKey: 'key-a' });
    const hold = beginHold('personal-a', 'PUT');
    const running = sync.syncCredentials({ reason: 'concurrent-save' });
    await waitUntil(() => hold.started);

    // The user adds another provider while the upload is waiting.
    await sync.savePersonalProvider({
        providerId: 'personal-b',
        provider: { ...PROVIDER_DEF, label: 'Added during sync', id: 'personal-b' },
        apiKey: 'key-b',
        keyChanged: true,
        syncMode: 'local-only'
    });
    hold.releaseJson(commitHeldPut('personal-a', { apiKey: 'key-a' }));
    await running;
    sync.stopCredentialSync();

    const loaded = profile.loadAIProfile();
    assert.ok(loaded.providers['personal-b'], 'the provider saved during the sync was reverted');
    assert.equal(loaded.credentials['personal-b'].apiKey, 'key-b');
    assert.equal(loaded.credentials['personal-a'].version, 1);
    assert.equal(loaded.credentials['personal-a'].pending, null);
});

test('F2: a key changed while its upload is in flight is kept as a new pending upload', async () => {
    await resetAll();
    await signIn('A');
    await saveCloudProvider('personal-a', { apiKey: 'key-old' });
    const hold = beginHold('personal-a', 'PUT');
    const running = sync.syncCredentials({ reason: 'rekey' });
    await waitUntil(() => hold.started);

    await saveCloudProvider('personal-a', { apiKey: 'key-new', label: 'Re-keyed' });
    hold.releaseJson(commitHeldPut('personal-a', { apiKey: 'key-old', mutationId: 'first' }));
    await running;
    sync.stopCredentialSync();

    let credential = profile.loadAIProfile().credentials['personal-a'];
    assert.equal(credential.apiKey, 'key-new', 'the newer key was overwritten by the finished sync');
    assert.ok(credential.pending, 'the newer key lost its pending upload');
    assert.equal(credential.pending.apiKey, 'key-new');
    // The confirmed version becomes the base of the newer mutation instead of
    // producing an immediate bogus conflict.
    assert.equal(credential.version, 1);
    assert.equal(credential.pending.expectedVersion, 1);

    // A following sync uploads the newer key without a conflict.
    await sync.syncCredentials({ reason: 'rekey-followup' });

    sync.stopCredentialSync();
    credential = profile.loadAIProfile().credentials['personal-a'];
    assert.equal(credential.apiKey, 'key-new');
    assert.equal(credential.pending, null);
    assert.equal(credential.conflict, null);
    assert.equal(fake.keys.get('personal-a').apiKey, 'key-new');
});

test('F2: deleting a provider during its upload keeps the delete', async () => {
    await resetAll();
    await signIn('A');
    await saveCloudProvider('personal-a', { apiKey: 'key-a' });
    const hold = beginHold('personal-a', 'PUT');
    const running = sync.syncCredentials({ reason: 'delete-race' });
    await waitUntil(() => hold.started);

    sync.deletePersonalProvider('personal-a', { removeCloud: true });
    sync.stopCredentialSync();
    hold.releaseJson(commitHeldPut('personal-a', { apiKey: 'key-a' }));
    await running;
    sync.stopCredentialSync();

    const loaded = profile.loadAIProfile();
    assert.equal(loaded.providers['personal-a'], undefined, 'the deleted provider came back');
    assert.equal(loaded.credentials['personal-a'].apiKey, '');
    assert.equal(loaded.credentials['personal-a'].pending.type, 'delete');
    assert.equal(loaded.credentials['personal-a'].pending.expectedVersion, 1);

    await sync.syncCredentials({ reason: 'delete-followup' });
    sync.stopCredentialSync();
    const after = profile.loadAIProfile().credentials['personal-a'];
    assert.equal(after.pending, null);
    assert.equal(fake.remote.get('personal-a').deleted, true, 'the cloud row was not deleted');
});

test('F2: task model changes made during a sync are preserved', async () => {
    await resetAll();
    await signIn('A');
    await saveCloudProvider('personal-a', { apiKey: 'key-a' });
    const hold = beginHold('personal-a', 'PUT');
    const running = sync.syncCredentials({ reason: 'task-race' });
    await waitUntil(() => hold.started);

    profile.updateAIProfile((draft) => {
        draft.taskModels.assistant = 'personal-a:m1';
        return draft;
    }, profile.getActiveAIScope());
    hold.releaseJson(commitHeldPut('personal-a', { apiKey: 'key-a' }));
    await running;
    sync.stopCredentialSync();

    const loaded = profile.loadAIProfile();
    assert.equal(loaded.taskModels.assistant, 'personal-a:m1', 'a per-task choice was lost');
    assert.equal(loaded.credentials['personal-a'].version, 1);
});

// ---------------------------------------------------------------------------
// R1 — "remove the cloud copy, keep this device" must never clear the local key
// ---------------------------------------------------------------------------
test('R1: removing the cloud copy keeps the local key and goes local-only', async () => {
    await resetAll();
    await signIn('A');
    await saveCloudProvider('personal-remove');
    await sync.syncCredentials({ reason: 'seed' });
    assert.equal(profile.loadAIProfile().credentials['personal-remove'].version, 1);

    sync.removeCloudKey('personal-remove');
    sync.stopCredentialSync();
    const pending = profile.loadAIProfile().credentials['personal-remove'].pending;
    assert.equal(pending.type, 'delete');
    assert.equal(pending.keepLocalKey, true, 'the delete mutation lost its keep-local intent');

    await sync.syncCredentials({ reason: 'remove-cloud' });
    sync.stopCredentialSync();
    const credential = profile.loadAIProfile().credentials['personal-remove'];
    assert.equal(fake.remote.get('personal-remove').deleted, true, 'the cloud row was not deleted');
    assert.equal(credential.apiKey, 'key-1', 'remove cloud erased the local key');
    assert.equal(credential.syncMode, 'local-only');
    assert.equal(credential.pending, null);
    assert.equal(credential.version, 2);
});

test('R1: remove-cloud against an already deleted cloud row keeps the local key', async () => {
    await resetAll();
    await signIn('A');
    await saveCloudProvider('personal-remove404');
    await sync.syncCredentials({ reason: 'seed' });
    sync.removeCloudKey('personal-remove404');
    sync.stopCredentialSync();
    // Someone else already removed the row: DELETE answers 404.
    fake.remote.set('personal-remove404', {
        version: 1,
        deleted: true,
        binding: BINDING,
        lastMutationId: 'deleted-elsewhere'
    });

    await sync.syncCredentials({ reason: 'remove-cloud-404' });
    sync.stopCredentialSync();
    const credential = profile.loadAIProfile().credentials['personal-remove404'];
    assert.equal(requestsFor('personal-remove404', 'DELETE').length, 1, 'the delete was not attempted');
    assert.equal(credential.apiKey, 'key-1', 'a 404 removed the key the user asked to keep');
    assert.equal(credential.syncMode, 'local-only');
    assert.equal(credential.pending, null);
});

test('R1: a lost remove-cloud response is confirmed by its tombstone without clearing the key', async () => {
    await resetAll();
    await signIn('A');
    await saveCloudProvider('personal-lost');
    await sync.syncCredentials({ reason: 'seed' });
    sync.removeCloudKey('personal-lost');
    sync.stopCredentialSync();
    const pending = profile.loadAIProfile().credentials['personal-lost'].pending;
    // The DELETE reached the server, the response never reached this device.
    fake.remote.set('personal-lost', {
        version: 2,
        deleted: true,
        binding: BINDING,
        lastMutationId: pending.mutationId
    });

    await sync.syncCredentials({ reason: 'confirm-tombstone' });
    sync.stopCredentialSync();
    const credential = profile.loadAIProfile().credentials['personal-lost'];
    assert.equal(credential.apiKey, 'key-1', 'the tombstone of our own delete cleared the key');
    assert.equal(credential.syncMode, 'local-only');
    assert.equal(credential.pending, null);
    assert.equal(credential.version, 2);
});

test('R1: deleting the provider still removes the key everywhere', async () => {
    await resetAll();
    await signIn('A');
    await saveCloudProvider('personal-gone');
    await sync.syncCredentials({ reason: 'seed' });

    sync.deletePersonalProvider('personal-gone', { removeCloud: true });
    sync.stopCredentialSync();
    await sync.syncCredentials({ reason: 'delete-provider' });
    sync.stopCredentialSync();
    const credential = profile.loadAIProfile().credentials['personal-gone'];
    assert.equal(fake.remote.get('personal-gone').deleted, true);
    assert.equal(credential.apiKey, '', 'a real delete must clear the key');
    assert.equal(credential.syncMode, 'local-only');
    assert.equal(profile.loadAIProfile().providers['personal-gone'], undefined);
});

test('R1: a tombstone this device never asked for still clears the local copy', async () => {
    await resetAll();
    await signIn('A');
    await saveCloudProvider('personal-other-device');
    await sync.syncCredentials({ reason: 'seed' });
    // Another device deleted the credential while this one was offline.
    fake.remote.set('personal-other-device', {
        version: 2,
        deleted: true,
        binding: BINDING,
        lastMutationId: 'other-device-delete'
    });

    await sync.syncCredentials({ reason: 'remote-tombstone' });
    sync.stopCredentialSync();
    const credential = profile.loadAIProfile().credentials['personal-other-device'];
    assert.equal(credential.apiKey, '', 'a remote delete must still clear the key');
    assert.equal(credential.syncMode, 'local-only');
});

// ---------------------------------------------------------------------------
// R2 — resolving a conflict is an async task and must not write a stale answer
// ---------------------------------------------------------------------------
async function setupConflict(id, apiKey = 'key-1') {
    await saveCloudProvider(id, { apiKey });
    profile.updateAIProfile((draft) => {
        draft.credentials[id].conflict = {
            remoteVersion: 2,
            remoteDeleted: false,
            detectedAt: new Date().toISOString()
        };
        return draft;
    });
}

test('R2: a key saved during the conflict download is not overwritten', async () => {
    await resetAll();
    await signIn('A');
    await setupConflict('personal-race');
    const hold = beginHold('personal-race', 'GET');
    const resolving = sync.resolveCredentialConflict('personal-race', 'cloud');
    await waitUntil(() => hold.started);

    await saveCloudProvider('personal-race', { apiKey: 'new-local-key' });
    hold.releaseJson({ apiKey: 'old-cloud-key', binding: BINDING, version: 2 });
    assert.equal(await resolving, false, 'a stale result must be reported as not applied');

    const credential = profile.loadAIProfile().credentials['personal-race'];
    assert.equal(credential.apiKey, 'new-local-key', 'the old conflict result overwrote a newer key');
    assert.equal(credential.pending.type, 'put', 'the newer pending upload was cleared');
    assert.equal(credential.pending.apiKey, 'new-local-key');
});

test('R2: a conflict result of a previous login session is discarded', async () => {
    await resetAll();
    await signIn('A');
    await setupConflict('personal-session');
    const hold = beginHold('personal-session', 'GET');
    const resolving = sync.resolveCredentialConflict('personal-session', 'cloud');
    await waitUntil(() => hold.started);

    await auth.signOut();
    await signIn('A');
    await saveCloudProvider('personal-session', { apiKey: 'new-session-key' });
    hold.releaseJson({ apiKey: 'old-session-cloud-key', binding: BINDING, version: 2 });
    assert.equal(await resolving, false);

    sync.stopCredentialSync();
    const credential = profile.loadAIProfile().credentials['personal-session'];
    assert.equal(credential.apiKey, 'new-session-key', 'a previous session wrote into the new login profile');
    assert.equal(credential.pending.type, 'put');
});

test('R2: adopting the cloud version replaces the key when nothing changed meanwhile', async () => {
    await resetAll();
    await signIn('A');
    await setupConflict('personal-adopt');
    fake.remote.set('personal-adopt', {
        version: 2,
        deleted: false,
        binding: BINDING,
        lastMutationId: 'remote-2'
    });
    fake.keys.set('personal-adopt', { apiKey: 'cloud-key-2', version: 2 });

    assert.equal(await sync.resolveCredentialConflict('personal-adopt', 'cloud'), true);
    sync.stopCredentialSync();
    const credential = profile.loadAIProfile().credentials['personal-adopt'];
    assert.equal(credential.apiKey, 'cloud-key-2');
    assert.equal(credential.version, 2);
    assert.equal(credential.pending, null);
    assert.equal(credential.conflict, null);
    assert.equal(credential.bindingVerified, true);
});

test('R2: a downloaded conflict answer older than the conflict is rejected', async () => {
    await resetAll();
    await signIn('A');
    await setupConflict('personal-old-answer');
    const hold = beginHold('personal-old-answer', 'GET');
    const resolving = sync.resolveCredentialConflict('personal-old-answer', 'cloud');
    await waitUntil(() => hold.started);
    hold.releaseJson({ apiKey: 'cloud-key-1', binding: BINDING, version: 1 });

    await assert.rejects(resolving, (error) => error.code === 'conflict_download_stale');
    const credential = profile.loadAIProfile().credentials['personal-old-answer'];
    assert.equal(credential.apiKey, 'key-1', 'an outdated answer replaced the local key');
    assert.ok(credential.conflict, 'the conflict must stay open');
});

test('R2: a downloaded key bound to another endpoint is not stored', async () => {
    await resetAll();
    await signIn('A');
    await setupConflict('personal-rebind');
    const hold = beginHold('personal-rebind', 'GET');
    const resolving = sync.resolveCredentialConflict('personal-rebind', 'cloud');
    await waitUntil(() => hold.started);
    hold.releaseJson({
        apiKey: 'key-for-other-endpoint',
        binding: { ...BINDING, apiUrl: 'https://other.mock/v1/chat/completions' },
        version: 2
    });

    await assert.rejects(resolving, (error) => error.code === 'binding_mismatch');
    const credential = profile.loadAIProfile().credentials['personal-rebind'];
    assert.equal(credential.apiKey, 'key-1', 'a key bound elsewhere was stored');
    assert.equal(credential.bindingVerified, false);
    assert.equal(credential.lastError, 'binding_mismatch');
});

test('R2: adopting a cloud copy that was deleted meanwhile drops the key', async () => {
    await resetAll();
    await signIn('A');
    await setupConflict('personal-deleted-conflict');
    const hold = beginHold('personal-deleted-conflict', 'GET');
    const resolving = sync.resolveCredentialConflict('personal-deleted-conflict', 'cloud');
    await waitUntil(() => hold.started);
    hold.releaseJson({ deleted: true, version: 3, apiKey: '', binding: BINDING });

    assert.equal(await resolving, true);
    const credential = profile.loadAIProfile().credentials['personal-deleted-conflict'];
    assert.equal(credential.apiKey, '');
    assert.equal(credential.syncMode, 'local-only');
    assert.equal(credential.version, 3);
    assert.equal(credential.conflict, null);
});

test('R2: resolving with the local version uploads against the conflicted version', async () => {
    await resetAll();
    await signIn('A');
    await setupConflict('personal-keep-local');
    profile.updateAIProfile((draft) => {
        draft.credentials['personal-keep-local'].apiKey = 'my-local-key';
        return draft;
    });
    assert.equal(await sync.resolveCredentialConflict('personal-keep-local', 'local'), true);
    sync.stopCredentialSync();
    const pending = profile.loadAIProfile().credentials['personal-keep-local'].pending;
    assert.equal(pending.type, 'put');
    assert.equal(pending.apiKey, 'my-local-key');
    assert.equal(pending.expectedVersion, 2, 'the upload must be versioned against the conflicted row');
    assert.equal(pending.keepLocalKey, false);
});

// ---------------------------------------------------------------------------
// F3 — stale 401
// ---------------------------------------------------------------------------
test('F3: a 401 from an older account does not sign out the new one', async () => {
    await resetAll();
    await signIn('A');
    await saveCloudProvider('personal-a', { apiKey: 'key-a' });
    const hold = beginHold('personal-a', 'PUT');
    const running = sync.syncCredentials({ reason: 'stale-401' });
    await waitUntil(() => hold.started);

    await auth.signOut();
    await signIn('B');
    const before = authMod.getAuthSnapshot();
    assert.equal(before.loggedIn, true);
    assert.equal(before.userId, 'B');

    hold.releaseJson({ error: 'unauthorized', code: 'unauthorized' }, 401);
    await running;
    sync.stopCredentialSync();

    const after = authMod.getAuthSnapshot();
    assert.equal(after.loggedIn, true, 'the stale 401 signed out the new account');
    assert.equal(after.userId, 'B');
    assert.equal(sync.getCredentialSyncState().status, 'idle');
});

test('F3: a real 401 in the current session still ends the session', async () => {
    await resetAll();
    await signIn('A');
    await saveCloudProvider('personal-a', { apiKey: 'key-a' });
    const hold = beginHold('personal-a', 'PUT');
    const running = sync.syncCredentials({ reason: 'real-401' });
    await waitUntil(() => hold.started);
    hold.releaseJson({ error: 'unauthorized', code: 'unauthorized' }, 401);
    await running;
    sync.stopCredentialSync();

    const snapshot = authMod.getAuthSnapshot();
    assert.equal(snapshot.loggedIn, false, 'a genuine 401 must still end the session');
    assert.equal(snapshot.userId, 'A', 'the account profile must stay usable');
    const kept = profile.loadAIProfile({ endpoint: WORKER, userId: 'A' });
    assert.equal(kept.credentials['personal-a'].apiKey, 'key-a', 'personal keys must survive a 401');
});

// ---------------------------------------------------------------------------
// F4 — account switch and the managed catalog
// ---------------------------------------------------------------------------
test('F4: switching accounts without signing out locks shared keys', async () => {
    await resetAll();
    await signIn('A');
    catalog.destroyAICatalog();
    await catalog.refreshAICatalog({ force: true, reason: 'test' });
    assert.equal(catalog.getCatalogState().status, 'verified');
    const first = await catalog.getManagedCredential('managed-test');
    assert.equal(first.apiKey, 'shared-key');
    assert.ok(catalog.getCatalogState().expiresAt > Date.now(), 'expected a session window');

    // The new account cannot reach the catalog for now (the review scenario).
    fake.catalogOfflineFor = 'B';
    // Direct switch: no sign-out in between.
    await signIn('B');
    const state = catalog.getCatalogState();
    assert.equal(state.userId, 'B');
    assert.notEqual(state.status, 'verified', 'the previous account stayed verified');
    assert.equal(state.expiresAt, 0, 'the previous session window survived the switch');
    assert.equal(catalog.isManagedUsable(), false);
    assert.equal(catalog.peekManagedCredential('managed-test'), null, 'the previous shared key was kept');

    await assert.rejects(
        () => catalog.getManagedCredential('managed-test'),
        (error) => error.code === 'managed_login_required' || error.code === 'stale_session'
    );
    await waitUntil(() => catalog.getCatalogState().status === 'offline');
    assert.equal(catalog.isManagedUsable(), false, 'a failed verification unlocked managed providers');

    // After the new account verifies, managed providers work again.
    fake.catalogOfflineFor = '';
    await catalog.refreshAICatalog({ force: true, reason: 'test' });
    assert.equal(catalog.getCatalogState().status, 'verified');
    const second = await catalog.getManagedCredential('managed-test');
    assert.equal(second.apiKey, 'shared-key');
    catalog.destroyAICatalog();
});

test('F3: a 401 credential download from the previous account cannot sign out the new one', async () => {
    await resetAll();
    await signIn('A');
    catalog.destroyAICatalog();
    await catalog.refreshAICatalog({ force: true, reason: 'test' });
    let releaseDownload;
    const heldPromise = new Promise((resolve) => {
        releaseDownload = (response) => resolve(response);
    });
    holdState = { path: '/ai-catalog/providers/managed-test/credential', method: 'GET', promise: heldPromise, started: false };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init = {}) => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        if (url.pathname === '/ai-catalog/providers/managed-test/credential' && holdState) {
            holdState.started = true;
            return heldPromise;
        }
        return originalFetch(input, init);
    };
    const pending = catalog.getManagedCredential('managed-test', { force: true }).catch((error) => error.code);
    await waitUntil(() => holdState && holdState.started);

    await auth.signOut();
    await signIn('B');
    releaseDownload(jsonResponse({ error: 'unauthorized', code: 'unauthorized' }, 401));
    const code = await pending;
    globalThis.fetch = originalFetch;
    holdState = null;

    const snapshot = authMod.getAuthSnapshot();
    assert.equal(snapshot.loggedIn, true, 'the stale managed 401 signed out the new account');
    assert.equal(snapshot.userId, 'B');
    assert.equal(code, 'stale_session');
    catalog.destroyAICatalog();
});

test('F4: a cross-tab account change also locks the shared keys', async () => {
    await resetAll();
    await signIn('A');
    catalog.destroyAICatalog();
    await catalog.refreshAICatalog({ force: true, reason: 'test' });
    assert.equal(catalog.getCatalogState().status, 'verified');
    await catalog.getManagedCredential('managed-test');
    assert.ok(catalog.peekManagedCredential('managed-test'));

    // Another tab signs in as B: the stored token and user id change without
    // this document doing anything itself.
    fake.catalogOfflineFor = 'B';
    localStorage.setItem('sync_token', 'token-B');
    localStorage.setItem('sync_user_id', 'B');
    window.dispatchEvent({ type: 'storage', key: 'sync_token' });
    await waitUntil(() => catalog.getCatalogState().userId === 'B');

    const state = catalog.getCatalogState();
    assert.equal(state.userId, 'B');
    assert.notEqual(state.status, 'verified', 'the previous account stayed verified across tabs');
    assert.equal(state.expiresAt, 0);
    assert.equal(catalog.peekManagedCredential('managed-test'), null, 'the previous shared key survived the cross-tab switch');
    assert.equal(catalog.isManagedUsable(), false);
    fake.catalogOfflineFor = '';
    catalog.destroyAICatalog();
});

// ---------------------------------------------------------------------------
// F6 — legacy migration keeps per-task model choices
// ---------------------------------------------------------------------------
test('F6: legacy per-task model choices survive the migration', async () => {
    await resetAll();
    localStorage.setItem('pen_global_settings', JSON.stringify({
        ai: {
            providers: {
                mine: {
                    baseUrl: 'https://provider.mock/v1',
                    apiUrl: 'https://provider.mock/v1/chat/completions',
                    allowedModels: ['m1']
                }
            },
            models: { assistant: 'mine:m1', qaChecking: 'mine:m1' },
            tasks: { articleAnalysis: 'mine:m2', default: 'mine:m1', imageOCR: 'managed-evil:m9' }
        },
        tts: { use: 'remote' }
    }));
    localStorage.setItem('pen_global_secrets', JSON.stringify({
        aiProviders: { mine: { apiKey: 'legacy-key' } },
        ttsApiKey: 'tts-key'
    }));

    const result = profile.migrateLegacyAISettings();
    assert.equal(result.migrated, true);
    assert.equal(result.reason, undefined);

    const guest = profile.loadAIProfile(GUEST_SCOPE);
    assert.ok(guest.providers.mine, 'legacy provider missing');
    assert.equal(guest.taskModels.assistant, 'mine:m1');
    assert.equal(guest.taskModels.qaChecking, 'mine:m1');
    assert.equal(guest.taskModels.articleAnalysis, 'mine:m2');
    assert.equal(guest.taskModels.default, 'mine:m1');
    assert.equal(guest.defaultModel, 'mine:m1');
    assert.equal(guest.taskModels.imageOCR, undefined, 'a managed reference must not be imported');
    assert.ok(result.skippedTaskModels.some((item) => item.task === 'imageOCR'));

    // Old fields are gone only after the new profile kept the choices.
    const legacySettings = JSON.parse(localStorage.getItem('pen_global_settings'));
    assert.equal(legacySettings.ai.models, undefined);
    assert.equal(legacySettings.ai.tasks, undefined);
    assert.equal(legacySettings.ai.providers, undefined);
    assert.deepEqual(legacySettings.tts, { use: 'remote' });
    const legacySecrets = JSON.parse(localStorage.getItem('pen_global_secrets'));
    assert.equal(legacySecrets.aiProviders, undefined);
    assert.equal(legacySecrets.ttsApiKey, 'tts-key');
});

test('F6: a failed profile write keeps the old task choices', async () => {
    await resetAll();
    localStorage.setItem('pen_global_settings', JSON.stringify({
        ai: {
            providers: { mine: { baseUrl: 'https://provider.mock/v1' } },
            models: { assistant: 'mine:m1' }
        }
    }));
    localStorage.setItem('pen_global_secrets', JSON.stringify({ aiProviders: { mine: { apiKey: 'legacy-key' } } }));

    const originalSetItem = localStorage.setItem;
    localStorage.setItem = function patchedSetItem(key, value) {
        if (String(key).startsWith('bdc_ai_profile_v1')) throw new Error('quota exceeded');
        return originalSetItem.call(this, key, value);
    };
    let result;
    try {
        result = profile.migrateLegacyAISettings();
    } finally {
        localStorage.setItem = originalSetItem;
    }
    assert.equal(result.migrated, false);
    assert.equal(result.reason, 'save-failed');

    const legacy = JSON.parse(localStorage.getItem('pen_global_settings'));
    assert.deepEqual(legacy.ai.models, { assistant: 'mine:m1' }, 'old task choices were deleted without a confirmed save');
    assert.equal(JSON.parse(localStorage.getItem('pen_global_secrets')).aiProviders.mine.apiKey, 'legacy-key');
});

// ---------------------------------------------------------------------------
// P1 — account-level key policy and split timestamps (docs/plan/2026101904351*)
// ---------------------------------------------------------------------------
test('P1: the account key policy defaults to cloud and travels in the snapshot', async () => {
    await resetAll();
    await signIn('A');
    assert.equal(profile.loadAIProfile().keySyncDefault, 'cloud', 'the default policy is not "cloud"');

    profile.setAIKeySyncDefault('local-only');
    assert.equal(profile.loadAIProfile().keySyncDefault, 'local-only');
    assert.equal(profile.getAIViewFromProfile().keySyncDefault, 'local-only');
    assert.equal(
        sanitizeMod.sanitizeAISettings(profile.getAIViewFromProfile()).keySyncDefault,
        'local-only',
        'the sanitiser drops the account key policy'
    );
    // An older snapshot has no policy field: keep this device's value instead
    // of silently resetting the account to the default.
    profile.applyRemoteAISettings({ providers: {}, models: {} }, new Date().toISOString());
    assert.equal(profile.loadAIProfile().keySyncDefault, 'local-only');
    // It belongs to the AI definition group: a newer snapshot with an explicit
    // policy replaces it.
    profile.applyRemoteAISettings({ providers: {}, models: {}, keySyncDefault: 'cloud' }, new Date().toISOString());
    assert.equal(profile.loadAIProfile().keySyncDefault, 'cloud');
    sync.stopCredentialSync();
});

test('P2: downloading a key does not move the AI definition timestamp', async () => {
    await resetAll();
    await signIn('A');
    const stamp = '2026-10-18T01:02:03.000Z';
    profile.applyRemoteAISettings({ providers: { 'personal-ts': PROVIDER_DEF }, models: {} }, stamp);
    assert.equal(profile.getAIProfileUpdatedAt(), stamp);
    fake.remote.set('personal-ts', { version: 1, deleted: false, binding: BINDING, lastMutationId: 'remote-ts' });
    fake.keys.set('personal-ts', { apiKey: 'remote-ts-key', version: 1 });

    await sync.syncCredentials({ reason: 'credential-only' });
    sync.stopCredentialSync();

    const credential = profile.loadAIProfile().credentials['personal-ts'];
    assert.equal(credential.apiKey, 'remote-ts-key', 'the key was not downloaded');
    assert.equal(credential.version, 1);
    assert.equal(
        profile.getAIProfileUpdatedAt(),
        stamp,
        'a credential-only write pushed the AI definition timestamp forward'
    );
});

test('P2: switching the key sync mode does not move the AI definition timestamp', async () => {
    await resetAll();
    await signIn('A');
    await saveCloudProvider('personal-mode', { apiKey: 'key-mode' });
    await sync.syncCredentials({ reason: 'seed' });
    sync.stopCredentialSync();
    const before = profile.getAIProfileUpdatedAt();
    assert.ok(before, 'expected a definition timestamp');

    sync.setProviderKeySyncMode('personal-mode', 'local-only');
    sync.stopCredentialSync();

    assert.equal(profile.loadAIProfile().credentials['personal-mode'].syncMode, 'local-only');
    assert.equal(profile.getAIProfileUpdatedAt(), before, 'switching the sync mode moved the AI definition timestamp');
});

// ---------------------------------------------------------------------------
// P0 — the cold-start race: credential sync ran before the snapshot landed
//
// This test installs the real module listeners, so it runs last: after
// `initAICredentialSync()` every sign-in schedules its own sync.
// ---------------------------------------------------------------------------
test('P0: applying remote AI settings triggers the credential download that was missed', async () => {
    await resetAll();
    // Not logged in yet, so init schedules nothing.
    sync.initAICredentialSync();
    await signIn('A');
    // Drop the sign-in's own scheduled sync: this test drives the first one.
    sync.stopCredentialSync();

    fake.remote.set('personal-cold', { version: 1, deleted: false, binding: BINDING, lastMutationId: 'remote-cold' });
    fake.keys.set('personal-cold', { apiKey: 'remote-cold-key', version: 1 });

    // Cold device: the credential sync runs before the snapshot created the
    // provider definition, so it has no download target and reports success.
    await sync.syncCredentials({ reason: 'cold-start' });
    assert.equal(requestsFor('personal-cold').length, 0, 'a key was downloaded without a provider definition');
    assert.equal(profile.loadAIProfile().credentials['personal-cold'], undefined);
    assert.equal(sync.getCredentialSyncState().status, 'synced');

    // The snapshot now applies the definitions and announces it.
    profile.applyRemoteAISettings({
        providers: { 'personal-cold': PROVIDER_DEF },
        models: {}
    }, new Date().toISOString());
    window.dispatchEvent(new CustomEvent('bdc:ai-settings-applied'));

    await waitUntil(() => {
        const credential = profile.loadAIProfile().credentials['personal-cold'];
        return !!credential && credential.apiKey === 'remote-cold-key';
    });
    sync.stopCredentialSync();

    const credential = profile.loadAIProfile().credentials['personal-cold'];
    assert.equal(credential.syncMode, 'cloud');
    assert.equal(credential.pending, null);
    assert.equal(requestsFor('personal-cold').length, 1, 'the announced settings did not start exactly one download');
});

// The managed-catalog tests above install the catalog module's auth listener,
// which starts a 5-minute foreground refresh interval on every sign-in. The
// account-scoped tests below sign in again, so the interval is destroyed once
// here; otherwise this process could not exit after the last test.
after(() => {
    sync.stopCredentialSync();
    catalog.destroyAICatalog();
});
