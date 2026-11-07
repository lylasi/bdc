import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createD1Adapter, createSqliteDatabase } from '../selfhost/d1-adapter.js';
import worker from '../cloudflare-worker/src/worker.js';
import { TTS_CREDENTIAL_ID, sanitizeTTSSettings } from '../shared/tts-settings.mjs';

const store = new Map(), ENDPOINT = 'https://worker.test', A = 'a'.repeat(43), B = 'b'.repeat(43);
const KEY = ['fixture', 'speech', 'credential'].join('-'), URL_A = 'https://speech.test', URL_B = 'https://other-speech.test';
globalThis.localStorage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key), key: (index) => [...store.keys()][index] || null, get length() { return store.size; } };
globalThis.window = new EventTarget(); window.location = { href: 'https://app.test' }; window.localStorage = localStorage;
globalThis.document = new EventTarget(); document.documentElement = {}; document.hidden = false;
globalThis.CustomEvent = class extends Event { constructor(type, init = {}) { super(type); this.detail = init.detail; } };
globalThis.Audio = class { play() { return Promise.resolve(); } pause() {} addEventListener() {} removeEventListener() {} };
globalThis.__BDC_SYNC_ENDPOINT__ = ENDPOINT;
const db = new DatabaseSync(':memory:'); db.exec(fs.readFileSync(new URL('../cloudflare-worker/schema.sql', import.meta.url), 'utf8'));
for (const [id, token] of [['alice', A], ['bob', B]]) {
    db.prepare('INSERT INTO users(token_hash,user_id,label,role) VALUES(?,?,?,?)')
        .run(createHash('sha256').update(token).digest('hex'), id, id, 'user');
}
const env = { DB: createD1Adapter(createSqliteDatabase(db)), ALLOWED_ORIGINS: '*',
    AI_CREDENTIAL_KEY_VERSION: '1', AI_CREDENTIAL_KEY_V1: Buffer.alloc(32, 11).toString('base64') };
const transport = async (url, init) => worker.fetch(new Request(url, init), env, {});
globalThis.fetch = transport;
const authMod = await import('../modules/sync-cloudflare.js');
const settings = await import('../modules/settings.js');
const profile = await import('../modules/tts-profile-storage.js');
const sync = await import('../modules/tts-account-sync.js');
const ai = await import('../modules/ai-profile-storage.js');
const core = await import('../modules/sync-core.js');
const audio = await import('../modules/audio.js');
const login = (token = A) => authMod.auth.signInWithToken(token);
const json = (path, token = A, init = {}) => transport(ENDPOINT + path, {
    ...init, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    ...(init.body && typeof init.body !== 'string' ? { body: JSON.stringify(init.body) } : {})
});
const snapshot = async (token = A) => (await json('/snapshot', token)).json();
const credential = async (token = A) => (await json('/ai-credentials/' + TTS_CREDENTIAL_ID, token)).json();
function configure(url = URL_A, key = KEY) {
    settings.saveGlobalSettings({ tts: { use: 'custom', baseUrlCustom: url, selectedVoices: { 'en-US': 'en-US-JennyNeural' } },
        reading: { englishVariant: 'en-US' } });
    settings.saveGlobalSecrets({ ttsApiKey: key });
}
async function seed() { await login(); configure(); assert.equal((await sync.syncTTSAccount()).state, 'synced'); }
function gate() { let release, reached; const ready = new Promise((r) => { reached = r; });
    const wait = new Promise((r) => { release = r; }); return { ready, wait, reached, release }; }

beforeEach(() => {
    store.clear(); db.exec('DELETE FROM snapshots; DELETE FROM user_ai_credentials;');
    globalThis.fetch = transport; globalThis.__BDC_SYNC_ENDPOINT__ = ENDPOINT;
});
after(() => { db.close(); });

test('public settings whitelist excludes keys, device preferences, credentials in URLs and malformed groups', () => {
    const clean = sanitizeTTSSettings({ tts: { use: 'custom', baseUrlCustom: URL_A, apiKey: KEY,
        baseUrlRemote: 'https://speech.test/?api_key=private', deviceVoiceURI: 'device-only', extensionMode: 'device',
        selectedVoices: { 'en-US': 'voice', unknown: KEY } }, reading: { englishVariant: 'en-US', other: KEY } });
    assert.equal(clean.tts.baseUrlCustom, URL_A); assert.equal(clean.tts.baseUrlRemote, '');
    assert.ok(!JSON.stringify(clean).includes(KEY)); assert.ok(!JSON.stringify(clean).includes('device-only'));
    assert.equal(ai.isPersonalProviderId(TTS_CREDENTIAL_ID), false);
});

test('account save preserves other snapshot groups, keeps keys out of snapshots and stores AES-GCM ciphertext', async () => {
    await json('/snapshot', A, { method: 'POST', body: { expected_version: 0, payload: { qa: { updatedAt: '2026-01-01', sentinel: 'keep' } } } });
    await seed();
    const data = await snapshot();
    assert.equal(data.payload.qa.sentinel, 'keep');
    assert.equal(data.payload.ttsSettings.settings.tts.baseUrlCustom, URL_A);
    assert.equal(data.payload.ttsSettings.settings.reading.englishVariant, 'en-US');
    assert.ok(!JSON.stringify(data).includes(KEY));
    const row = db.prepare('SELECT key_ciphertext,nonce FROM user_ai_credentials WHERE user_id=? AND provider_id=?').get('alice', TTS_CREDENTIAL_ID);
    assert.ok(row.key_ciphertext && row.nonce); assert.ok(!row.key_ciphertext.includes(KEY));
    assert.equal((await credential()).apiKey, KEY);
    assert.equal((await core.buildLocalSnapshot()).payload.ttsSettings.settings.tts.baseUrlCustom, URL_A);
    const merged = core.lwwMerge({}, data.payload); assert.deepEqual(merged.ttsSettings, data.payload.ttsSettings);
});

test('a new extension/device downloads the server, voices and key without overwriting the cloud snapshot', async () => {
    await seed(); const version = (await snapshot()).version;
    store.clear(); await login();
    assert.equal((await sync.syncTTSAccount()).state, 'synced');
    assert.equal(settings.loadGlobalSettings().tts.baseUrlCustom, URL_A);
    assert.equal(settings.loadGlobalSettings().tts.selectedVoices['en-US'], 'en-US-JennyNeural');
    assert.equal(settings.loadGlobalSettings().reading.englishVariant, 'en-US');
    assert.equal(settings.loadGlobalSecrets().ttsApiKey, KEY);
    assert.equal((await snapshot()).version, version);
});

test('switching account or endpoint never reuses the previous account server or key', async () => {
    await seed(); await login(B);
    assert.equal(settings.loadGlobalSettings().tts.baseUrlCustom, '');
    assert.equal(settings.loadGlobalSecrets().ttsApiKey, '');
    assert.equal((await sync.syncTTSAccount()).state, 'empty');
    await login(); assert.equal(settings.loadGlobalSecrets().ttsApiKey, KEY);
    globalThis.__BDC_SYNC_ENDPOINT__ = 'https://another-worker.test';
    assert.equal(settings.loadGlobalSecrets().ttsApiKey, '');
    assert.equal(settings.loadGlobalSettings().tts.baseUrlCustom, '');
});

test('changing the service URL prevents transmitting the old service key', async () => {
    await seed(); settings.saveGlobalSettings({ tts: { baseUrlCustom: URL_B } });
    assert.equal(settings.loadGlobalSecrets().ttsApiKey, '');
    assert.equal(new URL(audio.buildTTSUrl('hello')).searchParams.get('api_key'), '');
    const result = await sync.syncTTSAccount();
    assert.equal(result.code, 'tts_key_binding_mismatch');
    assert.equal((await credential()).apiKey, KEY);
});

test('clearing a personal key deletes its cloud ciphertext and a new device sees the tombstone', async () => {
    await seed(); settings.saveGlobalSecrets({ ttsApiKey: '' });
    assert.equal((await sync.syncTTSAccount()).state, 'synced');
    const remote = await credential(); assert.equal(remote.deleted, true); assert.equal(remote.apiKey, null);
    const row = db.prepare('SELECT key_ciphertext FROM user_ai_credentials WHERE user_id=? AND provider_id=?').get('alice', TTS_CREDENTIAL_ID);
    assert.ok(!row.key_ciphertext);
    store.clear(); await login(); await sync.syncTTSAccount(); assert.equal(settings.loadGlobalSecrets().ttsApiKey, '');
});

test('legacy local settings migrate to the first account only, while existing cloud settings take precedence', async () => {
    await seed(); store.clear();
    localStorage.setItem('pen_global_settings', JSON.stringify({ tts: { use: 'custom', baseUrlCustom: URL_B } }));
    localStorage.setItem('pen_global_secrets', JSON.stringify({ ttsApiKey: 'old-device-key' }));
    settings.loadGlobalSettings(); await login(); await sync.syncTTSAccount();
    assert.equal(settings.loadGlobalSettings().tts.baseUrlCustom, URL_A);
    assert.equal(settings.loadGlobalSecrets().ttsApiKey, KEY);
    await login(B); await sync.syncTTSAccount();
    assert.equal(settings.loadGlobalSecrets().ttsApiKey, '');
    assert.equal(settings.loadGlobalSettings().tts.baseUrlCustom, '');
});

test('legacy guest settings can seed an empty account and are not copied to its next account', async () => {
    localStorage.setItem('pen_global_settings', JSON.stringify({ tts: { use: 'custom', baseUrlCustom: URL_A } }));
    localStorage.setItem('pen_global_secrets', JSON.stringify({ ttsApiKey: KEY }));
    settings.loadGlobalSettings(); await login(); await sync.syncTTSAccount();
    assert.equal((await credential()).apiKey, KEY);
    assert.equal((await snapshot()).payload.ttsSettings.settings.tts.baseUrlCustom, URL_A);
    await login(B); await sync.syncTTSAccount(); assert.equal(settings.loadGlobalSecrets().ttsApiKey, '');
});

test('first migration in an already logged-in account preserves that account legacy custom service', async () => {
    await login();
    localStorage.setItem('pen_global_settings', JSON.stringify({ tts: { use: 'custom', baseUrlCustom: URL_A } }));
    localStorage.setItem('pen_global_secrets', JSON.stringify({ ttsApiKey: KEY }));
    assert.equal((await sync.syncTTSAccount()).state, 'synced');
    assert.equal((await snapshot()).payload.ttsSettings.settings.tts.baseUrlCustom, URL_A);
    assert.equal((await credential()).apiKey, KEY);
});

test('a stale vault 401 cannot sign out or modify the new account', async () => {
    await seed(); const g = gate();
    globalThis.fetch = async (url, init) => {
        if (String(url).endsWith('/ai-credentials/' + TTS_CREDENTIAL_ID)) { g.reached(); await g.wait; return new Response('{}', { status: 401 }); }
        return transport(url, init);
    };
    const old = sync.syncTTSAccount(); await g.ready; await login(B); g.release();
    assert.equal((await old).state, 'stale');
    assert.equal(authMod.getAuthSnapshot().userId, 'bob'); assert.equal(authMod.getAuthSnapshot().loggedIn, true);
    assert.equal(settings.loadGlobalSecrets().ttsApiKey, '');
});

test('editing a key during upload preserves the new edit and advances only the successful CAS base', async () => {
    await seed(); settings.saveGlobalSecrets({ ttsApiKey: 'first-edit' }); const g = gate();
    globalThis.fetch = async (url, init) => {
        if (init.method === 'PUT') { g.reached(); await g.wait; }
        return transport(url, init);
    };
    const work = sync.syncTTSAccount(); await g.ready; settings.saveGlobalSecrets({ ttsApiKey: 'latest-edit' }); g.release(); await work;
    assert.equal(settings.loadGlobalSecrets().ttsApiKey, 'latest-edit');
    assert.ok(profile.loadTTSProfile().credential.pending);
    globalThis.fetch = transport; await sync.syncTTSAccount();
    assert.equal((await credential()).apiKey, 'latest-edit');
});

test('a remote key conflict keeps the local edit and requires an explicit retry to replace the remote version', async () => {
    await seed(); const row = await credential();
    await json('/ai-credentials/' + TTS_CREDENTIAL_ID, A, { method: 'PUT', body: {
        expectedVersion: row.version, mutationId: 'remote-device-edit', binding: row.binding, apiKey: 'remote-edit'
    } });
    settings.saveGlobalSecrets({ ttsApiKey: 'local-edit' });
    assert.equal((await sync.syncTTSAccount()).state, 'conflict');
    assert.equal(settings.loadGlobalSecrets().ttsApiKey, 'local-edit'); assert.equal((await credential()).apiKey, 'remote-edit');
    assert.equal((await sync.syncTTSAccount({ force: true })).state, 'synced');
    assert.equal((await credential()).apiKey, 'local-edit');
});

test('a lost key-upload reply is confirmed by mutation id without duplicate writes', async () => {
    await seed(); settings.saveGlobalSecrets({ ttsApiKey: 'retry-edit' }); let puts = 0;
    globalThis.fetch = async (url, init) => {
        const response = await transport(url, init);
        if (init.method === 'PUT') { puts += 1; throw new TypeError('fixture lost reply'); }
        return response;
    };
    assert.equal((await sync.syncTTSAccount()).state, 'error');
    globalThis.fetch = transport; assert.equal((await sync.syncTTSAccount()).state, 'synced');
    assert.equal(puts, 1); assert.equal((await credential()).apiKey, 'retry-edit');
});

test('offline settings remain pending and retry succeeds; a backend without a vault reports key-local-only', async () => {
    await login(); configure();
    globalThis.fetch = async () => { throw new TypeError('fixture offline'); };
    assert.equal((await sync.syncTTSAccount()).state, 'error'); assert.ok(profile.loadTTSProfile().pending);
    globalThis.fetch = async (url, init) => String(url).includes('/ai-credentials/') ? new Response('{}', { status: 501 }) : transport(url, init);
    assert.equal((await sync.syncTTSAccount()).state, 'key-local-only');
    assert.ok(!(await snapshot()).payload.ttsSettings.settings.tts.apiKey);
    globalThis.fetch = transport; assert.equal((await sync.syncTTSAccount()).state, 'synced');
});

test('device-only preferences do not alter the public account settings or upload the device voice URI', async () => {
    await seed(); const before = (await snapshot()).version;
    settings.saveGlobalSettings({ tts: { extensionMode: 'device', deviceVoiceURI: 'private-device-name' } });
    await sync.syncTTSAccount();
    assert.equal((await snapshot()).version, before);
    assert.ok(!JSON.stringify((await core.buildLocalSnapshot()).payload).includes('private-device-name'));
});

test('snapshot sanitizer strips a modified client key and rejects credential-bearing TTS URLs', async () => {
    const response = await json('/snapshot', A, { method: 'POST', body: { expected_version: 0, payload: {
        ttsApiKey: KEY, ttsSettings: { updatedAt: new Date().toISOString(), apiKey: KEY,
            settings: { tts: { use: 'custom', baseUrlCustom: 'https://speech.test/?api_key=hidden', apiKey: KEY, deviceVoiceURI: KEY } } }
    } } });
    assert.equal(response.status, 200); const data = await snapshot();
    assert.ok(!JSON.stringify(data).includes(KEY)); assert.equal(data.payload.ttsSettings.settings.tts.baseUrlCustom, '');
});

test('a failed account-profile write cannot be reported as a persisted TTS key', async () => {
    await seed(); const original = localStorage.setItem;
    localStorage.setItem = (key, value) => {
        if (key.startsWith(profile.TTS_PROFILE_PREFIX + ':')) throw new Error('fixture quota');
        original(key, value);
    };
    try {
        const result = settings.saveGlobalSecrets({ ttsApiKey: 'not-persisted' });
        assert.equal(result.ttsApiKey, KEY); assert.equal(settings.loadGlobalSecrets().ttsApiKey, KEY);
        assert.equal((await credential()).apiKey, KEY);
    } finally { localStorage.setItem = original; }
});

test('snapshot CAS retry preserves another writer learning group', async () => {
    await login(); configure(); let injected = false;
    globalThis.fetch = async (url, init) => {
        if (!injected && String(url).endsWith('/snapshot') && init.method === 'POST') {
            injected = true;
            await json('/snapshot', A, { method: 'POST', body: { expected_version: 0, payload: { qa: { sentinel: 'concurrent-learning' } } } });
        }
        return transport(url, init);
    };
    assert.equal((await sync.syncTTSAccount()).state, 'synced');
    assert.equal((await snapshot()).payload.qa.sentinel, 'concurrent-learning');
});

test('repeated settings CAS conflicts retain the local draft and do not claim a key conflict', async () => {
    await login(); configure();
    globalThis.fetch = async (url, init) => String(url).endsWith('/snapshot') && init.method === 'POST'
        ? new Response('{}', { status: 409 }) : transport(url, init);
    const result = await sync.syncTTSAccount();
    assert.equal(result.state, 'conflict'); assert.equal(result.code, 'tts_settings_conflict');
    assert.equal(sync.ttsAccountStatusKey(), 'settings.ttsAccountSettingsConflict');
    assert.ok(profile.loadTTSProfile().pending); assert.equal(settings.loadGlobalSecrets().ttsApiKey, KEY);
});

test('an explicitly cleared service is saved account data, and an empty new device respects that choice', async () => {
    await seed(); settings.saveGlobalSettings({ tts: { use: 'custom', baseUrlCustom: '' } });
    assert.equal((await sync.syncTTSAccount()).state, 'synced');
    store.clear(); await login(); assert.equal((await sync.syncTTSAccount()).state, 'synced');
    assert.equal(settings.loadGlobalSettings().tts.baseUrlCustom, '');
    assert.equal(settings.loadGlobalSecrets().ttsApiKey, '');
    assert.equal(audio.isRemoteTtsConfigured(), false);
});
