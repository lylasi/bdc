import { apiRequest, auth, captureAuthSession, isAuthSessionCurrent, AUTH_EVENT } from './sync-cloudflare.js';
import { getActiveAIScope } from './ai-profile-storage.js';
import { loadTTSProfile, updateTTSProfile, ttsProfileKey, prepareTTSAccount, getTTSSettingsGroup,
    applyRemoteTTSSettings, clearTTSAccount, clearLegacyTTSCopy, TTS_PROFILE_EVENT } from './tts-profile-storage.js';
import { TTS_CREDENTIAL_ID, normalizeTTSUrl, sanitizeTTSGroup, ttsServiceUrl } from '../shared/tts-settings.mjs';

export const TTS_SYNC_EVENT = 'bdc:tts-sync-state';
export function ttsAccountStatusKey() {
    const { state, code } = getTTSAccountSyncState();
    if (code === 'tts_key_binding_mismatch') return 'settings.ttsAccountBinding';
    if (code === 'tts_settings_conflict') return 'settings.ttsAccountSettingsConflict';
    return { guest: 'settings.ttsAccountGuest', pending: 'settings.ttsAccountPending', syncing: 'settings.ttsAccountSyncing',
        synced: 'settings.ttsAccountSynced', empty: 'settings.ttsAccountEmpty', error: 'settings.ttsAccountError',
        conflict: 'settings.ttsAccountConflict', 'key-local-only': 'settings.ttsAccountKeyLocal' }[state] || 'settings.ttsAccountPending';
}
let initialized = false, autoPull = true, active = null, timer, previousScope;
const states = new Map();
const failure = (code) => Object.assign(new Error(code), { code });
const fingerprint = (credential) => JSON.stringify(credential);
const uuid = () => globalThis.crypto?.randomUUID?.() || `tts_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;

function emit(state, code = '', scope = getActiveAIScope()) {
    const value = { state, code, key: ttsProfileKey(scope) };
    states.set(value.key, value);
    try { window.dispatchEvent(new CustomEvent(TTS_SYNC_EVENT, { detail: value })); } catch (_) {}
    return value;
}

export function getTTSAccountSyncState() {
    const scope = getActiveAIScope();
    if (!captureAuthSession().loggedIn) return { state: 'guest', code: '', key: ttsProfileKey(scope) };
    return states.get(ttsProfileKey(scope)) || { state: 'pending', code: '', key: ttsProfileKey(scope) };
}

async function request(path, init, session) {
    if (!isAuthSessionCurrent(session)) throw failure('stale_session');
    const response = await apiRequest(path, init, { token: session.token, timeoutMs: 10000 });
    if (!isAuthSessionCurrent(session)) throw failure('stale_session');
    if (response.status === 401) {
        await auth.invalidateSession();
        throw failure('unauthorized');
    }
    return response;
}

async function body(response, session) {
    const data = await response.json().catch(() => ({}));
    if (!isAuthSessionCurrent(session)) throw failure('stale_session');
    return data;
}

function snapshotData(data) {
    let payload = data?.payload || {};
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch (_) { payload = {}; } }
    return { version: Number(data?.version) || 0, payload: payload && typeof payload === 'object' ? payload : {} };
}

async function readSnapshot(session) {
    const response = await request('/snapshot', { method: 'GET' }, session);
    if (!response.ok) throw failure('tts_snapshot_read_failed');
    return snapshotData(await body(response, session));
}

async function syncSettings(scope, session, supplied) {
    let remote = supplied ? snapshotData(supplied) : await readSnapshot(session);
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const remoteGroup = sanitizeTTSGroup(remote.payload.ttsSettings);
        applyRemoteTTSSettings(remoteGroup, scope);
        prepareTTSAccount(scope, !!remoteGroup);
        const profile = loadTTSProfile(scope), group = getTTSSettingsGroup(scope);
        if (!profile.pending || !group) return;
        if (JSON.stringify(remoteGroup) === JSON.stringify(group)) {
            updateTTSProfile((draft) => { if (draft.updatedAt === group.updatedAt) draft.pending = false; }, scope, 'confirmed');
            return;
        }
        // Modify only this account-settings group; never build an extension's
        // empty vocabulary/article stores into a replacement learning snapshot.
        const response = await request('/snapshot', { method: 'POST', body: JSON.stringify({
            expected_version: remote.version, payload: { ...remote.payload, ttsSettings: group }
        }) }, session);
        if (response.status === 409) { remote = await readSnapshot(session); continue; }
        if (!response.ok) throw failure('tts_snapshot_write_failed');
        await body(response, session);
        updateTTSProfile((draft) => {
            if (draft.updatedAt === group.updatedAt) draft.pending = false;
        }, scope, 'confirmed');
        return;
    }
    throw failure('tts_settings_conflict');
}

function vaultBinding(baseUrl) {
    // The deployed encrypted personal vault has a historical AI-shaped wire
    // binding. Reuse its opaque-secret CAS/AES-GCM storage for a reserved TTS
    // slot, bound to /tts. This slot is excluded from AI provider definitions.
    return { formatVersion: 1, format: 'openai-chat', apiUrl: baseUrl + '/tts', modelsUrl: '', authMode: 'bearer' };
}

async function syncKey(scope, session, force) {
    let profile = loadTTSProfile(scope), baseUrl = ttsServiceUrl(profile.settings);
    if (!baseUrl && !profile.credential.pending) return;
    const before = fingerprint(profile.credential);
    const path = '/ai-credentials/' + TTS_CREDENTIAL_ID;
    const response = await request(path, { method: 'GET' }, session);
    if (response.status === 501) throw failure('tts_key_sync_unsupported');
    if (response.status !== 404 && !response.ok) throw failure('tts_key_read_failed');
    const row = response.status === 404 ? null : await body(response, session);
    if (row && !row.deleted && (!String(row.binding?.apiUrl || '').endsWith('/tts') || row.binding?.modelsUrl)) {
        throw failure('tts_vault_slot_occupied');
    }
    profile = loadTTSProfile(scope);
    if (fingerprint(profile.credential) !== before || ttsServiceUrl(profile.settings) !== baseUrl) return;
    let pending = profile.credential.pending;
    const version = Number(row?.version) || 0;
    if (!pending && !row && profile.credential.apiKey && baseUrl && profile.credential.baseUrl === baseUrl) {
        updateTTSProfile((draft) => {
            draft.credential.pending = { type: 'put', mutationId: uuid(), expectedVersion: 0 };
        }, scope);
        profile = loadTTSProfile(scope); pending = profile.credential.pending;
    }
    if (pending) {
        if (pending.type === 'put' && profile.credential.baseUrl !== baseUrl) throw failure('tts_key_binding_mismatch');
        // A lost reply to our own mutation is a confirmation, not a conflict.
        if (row?.lastMutationId === pending.mutationId) {
            updateTTSProfile((draft) => { draft.credential.version = version; draft.credential.pending = null; }, scope);
            return;
        }
        if (pending.expectedVersion !== null && Number(pending.expectedVersion) !== version && !force) throw failure('tts_key_conflict');
        if (pending.type === 'delete' && (!row || row.deleted)) {
            updateTTSProfile((draft) => { draft.credential.version = version; draft.credential.pending = null; }, scope);
            return;
        }
        if (pending.type === 'put' && !baseUrl) throw failure('tts_service_required');
        const expected = version, sent = fingerprint(profile.credential);
        const mutation = await request(path, { method: pending.type === 'delete' ? 'DELETE' : 'PUT', body: JSON.stringify({
            expectedVersion: expected, mutationId: pending.mutationId,
            ...(pending.type === 'put' ? { apiKey: profile.credential.apiKey, binding: vaultBinding(baseUrl) } : {})
        }) }, session);
        if (mutation.status === 409) throw failure('tts_key_conflict');
        if (!mutation.ok) throw failure('tts_key_write_failed');
        const result = await body(mutation, session);
        updateTTSProfile((draft) => {
            if (fingerprint(draft.credential) === sent) {
                draft.credential.version = Number(result.version) || expected + 1;
                draft.credential.pending = null;
            } else if (draft.credential.pending) {
                // An edit made while this request waited stays pending. Advance
                // only the CAS base of our own successfully committed mutation.
                draft.credential.version = Number(result.version) || expected + 1;
                draft.credential.pending.expectedVersion = draft.credential.version;
            }
        }, scope);
        return;
    }
    if (!row) return;
    if (Number(profile.credential.version) > version) throw failure('tts_key_rollback');
    if (!row.deleted && normalizeTTSUrl(String(row.binding?.apiUrl || '').replace(/\/tts\/?$/, '')) !== baseUrl) {
        throw failure('tts_key_binding_mismatch');
    }
    updateTTSProfile((draft) => {
        if (fingerprint(draft.credential) !== before) return;
        draft.credential = { apiKey: row.deleted ? '' : String(row.apiKey || ''), baseUrl, version, pending: null };
    }, scope);
}

export function syncTTSAccount({ snapshot, force = false } = {}) {
    const session = captureAuthSession(), scope = getActiveAIScope();
    if (!session.loggedIn) return Promise.resolve(emit('guest'));
    if (active && isAuthSessionCurrent(active.session)) return active.promise;
    const work = { session };
    emit('syncing');
    work.promise = (async () => {
        try {
            await syncSettings(scope, session, snapshot);
            await syncKey(scope, session, force);
            if (!isAuthSessionCurrent(session)) throw failure('stale_session');
            const profile = loadTTSProfile(scope);
            return emit(profile.pending || profile.credential.pending ? 'pending' : getTTSSettingsGroup(scope) ? 'synced' : 'empty', '', scope);
        } catch (error) {
            if (!isAuthSessionCurrent(session) || error?.code === 'stale_session') return { state: 'stale', code: 'stale_session' };
            const code = error?.code || 'tts_sync_failed';
            return emit(code === 'tts_key_conflict' || code === 'tts_settings_conflict' ? 'conflict'
                : code === 'tts_key_sync_unsupported' ? 'key-local-only' : 'error', code, scope);
        } finally {
            if (active === work) active = null;
        }
    })();
    active = work;
    return work.promise;
}

function schedule() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
        if (active && isAuthSessionCurrent(active.session)) await active.promise;
        await syncTTSAccount();
    }, 500);
}

export function initTTSAccountSync({ auto = true } = {}) {
    if (initialized) return;
    initialized = true; autoPull = auto; previousScope = getActiveAIScope();
    try { loadTTSProfile(); } catch (_) { emit('error', 'tts_profile_save_failed'); }
    window.addEventListener(AUTH_EVENT, () => {
        const next = getActiveAIScope();
        if (ttsProfileKey(previousScope) !== ttsProfileKey(next)) {
            if (!previousScope.guest) clearTTSAccount(previousScope);
            try { clearLegacyTTSCopy(); } catch (_) { /* Scoped reads still prevent inheriting another account's values. */ }
        }
        previousScope = next;
        emit(captureAuthSession().loggedIn ? 'pending' : 'guest');
        if (autoPull) schedule();
    });
    window.addEventListener('bdc:data-changed', (event) => {
        if (event.detail?.group === 'ttsSettings') { emit(captureAuthSession().loggedIn ? 'pending' : 'guest'); schedule(); }
    });
    window.addEventListener(TTS_PROFILE_EVENT, (event) => { if (autoPull && event.detail?.reason === 'remote') schedule(); });
    window.addEventListener('online', schedule);
    window.addEventListener('focus', () => { if (autoPull) schedule(); });
    window.addEventListener('storage', (event) => {
        if (event.key === ttsProfileKey()) { emit('pending'); schedule(); }
    });
    if (autoPull) schedule();
}
