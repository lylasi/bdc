// Personal AI credential sync.
//
// - Non-secret settings still travel through the existing snapshot; keys travel
//   through /ai-credentials with per-provider versions and idempotent mutations.
// - Local-only providers never upload or download automatically.
// - Conflicts are surfaced to the UI; there is no unconditional "force" write.
// - All async work captures (endpoint, userId, session generation) and checks it
//   again before writing, so a late response can never land in another account.

import {
    apiRequest,
    auth,
    getAuthSnapshot,
    captureAuthSession,
    isAuthSessionCurrent,
    AUTH_EVENT
} from './sync-cloudflare.js';
import { touch as syncTouch } from './sync-signals.js';
import {
    loadAIProfile,
    updateAIProfile,
    getActiveAIScope,
    profileKeyForScope,
    normalizeCredential,
    normalizeStoredProvider,
    isPersonalProviderId,
    clearAccountAIProfiles,
    AI_PROFILE_PREFIX
} from './ai-profile-storage.js';

export const CREDENTIAL_RETRY_DELAYS_MS = [5000, 15000, 60000];
export const CREDENTIAL_REQUEST_TIMEOUT_MS = 10000;

const listeners = new Set();
const state = {
    status: 'idle', // idle | syncing | synced | offline | error | unauthorized | weak-passcode | conflict
    lastSyncAt: 0,
    error: '',
    conflicts: [],
    pending: [],
    generation: 0
};

let initialized = false;
let lastKnownScope = getActiveAIScope();
let syncTimer = null;
let retryTimer = null;
let retryAttempt = 0;
let inFlight = null;
let lastRunAt = 0;

function notify() {
    const snapshot = getCredentialSyncState();
    for (const callback of listeners) {
        try { callback(snapshot); } catch (_) {}
    }
    try {
        window.dispatchEvent(new CustomEvent('bdc:ai-credential-sync', { detail: snapshot }));
    } catch (_) {}
}

export function getCredentialSyncState() {
    try { markSyncMeta(); } catch (_) {}
    return {
        status: state.status,
        lastSyncAt: state.lastSyncAt,
        error: state.error,
        conflicts: [...state.conflicts],
        pending: [...state.pending],
        loggedIn: getAuthSnapshot().loggedIn
    };
}

export function subscribeCredentialSync(callback) {
    if (typeof callback === 'function') listeners.add(callback);
    return () => listeners.delete(callback);
}

function newMutationId() {
    try {
        if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    } catch (_) {}
    return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

function bindingsEqual(a, b) {
    return !!a && !!b
        && String(a.format || '') === String(b.format || '')
        && String(a.apiUrl || '') === String(b.apiUrl || '')
        && String(a.modelsUrl || '') === String(b.modelsUrl || '')
        && String(a.authMode || '') === String(b.authMode || '');
}

export function bindingForProvider(provider) {
    if (!provider) return null;
    return {
        formatVersion: 1,
        format: provider.format || 'openai-chat',
        apiUrl: provider.apiUrl || '',
        modelsUrl: provider.modelsUrl || '',
        authMode: provider.authMode || 'bearer'
    };
}

/**
 * Pure sync decision table. `local` describes one local credential,
 * `remote` one row from GET /ai-credentials (or null when absent).
 *
 * Returns: 'upload-pending' | 'confirm-pending' | 'download' |
 *          'apply-remote-delete' | 'conflict' | 'rollback' | 'noop'
 */
export function decideCredentialAction(local, remote) {
    const cred = local || {};
    const row = remote || null;
    const pending = cred.pending || null;
    if (cred.syncMode === 'local-only' && !pending) return 'noop';
    if (pending) {
        if (!row) {
            if (Number(pending.expectedVersion) === 0) return 'upload-pending';
            return 'rollback';
        }
        if (row.lastMutationId && row.lastMutationId === pending.mutationId) return 'confirm-pending';
        if (Number(row.version) === Number(pending.expectedVersion)) return 'upload-pending';
        if (Number(row.version) > Number(pending.expectedVersion)) return 'conflict';
        return 'rollback';
    }
    if (!row) return 'noop';
    if (Number(row.version) > Number(cred.version || 0)) {
        return row.deleted ? 'apply-remote-delete' : 'download';
    }
    if (Number(row.version) < Number(cred.version || 0)) return 'rollback';
    return 'noop';
}

function readRemoteMeta(item) {
    if (!item) return null;
    return {
        version: Number(item.version) || 0,
        deleted: item.deleted === true,
        lastMutationId: String(item.lastMutationId || ''),
        binding: item.binding || null,
        updatedAt: item.updatedAt || ''
    };
}

/**
 * Identity of the *local, user-owned* part of a credential. Two credentials
 * with the same fingerprint are interchangeable from the sync's point of view;
 * if it changed between the moment the sync read the profile and the moment it
 * commits, the user edited (or deleted) the provider meanwhile and the sync
 * result must not overwrite it.
 */
function credentialFingerprint(credential) {
    if (!credential) return 'absent';
    const pending = credential.pending || null;
    return JSON.stringify([
        String(credential.apiKey || ''),
        String(credential.syncMode || ''),
        credential.binding || null,
        pending ? [pending.type, pending.mutationId, Number(pending.expectedVersion) || 0] : null
    ]);
}

/** Whole-row identity, used to notice that the sync changed anything at all. */
function credentialIdentity(credential) {
    if (!credential) return 'absent';
    return JSON.stringify(credential);
}

/**
 * Exact row state a manual conflict resolution was computed from: the local,
 * user-owned part plus the version, sync mode and the remote conflict row the
 * user was shown. If any of it changed before the operation commits, the user
 * (or another sync) already moved on and this result must be dropped.
 */
function conflictBaseline(credential) {
    if (!credential) return 'absent';
    const conflict = credential.conflict || null;
    return JSON.stringify([
        credentialFingerprint(credential),
        Number(credential.version) || 0,
        String(credential.syncMode || ''),
        conflict
            ? [Number(conflict.remoteVersion) || 0, conflict.remoteDeleted === true, String(conflict.remoteLastMutationId || '')]
            : null
    ]);
}

function cloneProfile(profile) {
    try { return JSON.parse(JSON.stringify(profile)); } catch (_) { return profile; }
}

/**
 * Seed local *download targets* for credentials that only exist remotely.
 *
 * A new device learns provider definitions from the ordinary snapshot but has
 * no credential rows at all, so the sync loop would never fetch the keys. For
 * every remote row of a provider we know locally (and whose local definition is
 * not key-less), create a `cloud` credential at version 0 so the normal decision
 * table downloads it. An existing local credential — in particular an explicit
 * `local-only` one — is never replaced.
 */
function addDownloadTargets(profile, remoteMap) {
    const ids = new Set(Object.keys(profile.credentials));
    for (const [id, remote] of remoteMap) {
        if (!remote || remote.deleted || Number(remote.version) < 1) continue;
        if (profile.credentials[id]) continue;
        const provider = profile.providers[id];
        if (!provider) continue;
        if (provider.authMode === 'none') continue;
        profile.credentials[id] = normalizeCredential({
            apiKey: '',
            binding: bindingForProvider(provider),
            version: 0,
            syncMode: 'cloud',
            pending: null,
            bindingVerified: false,
            lastSyncedAt: ''
        });
        ids.add(id);
    }
    return ids;
}

function applyConflict(profile, providerId, row) {
    const credential = profile.credentials[providerId];
    if (!credential) return;
    credential.conflict = {
        remoteVersion: Number(row && row.version) || 0,
        remoteDeleted: !!(row && row.deleted),
        remoteLastMutationId: String((row && row.lastMutationId) || ''),
        detectedAt: new Date().toISOString()
    };
}

function setCredentialError(profile, providerId, code) {
    const credential = profile.credentials[providerId];
    if (credential) credential.lastError = String(code || '').slice(0, 80);
}

function clearCredentialError(profile, providerId) {
    const credential = profile.credentials[providerId];
    if (credential) credential.lastError = '';
}

function markSyncMeta() {
    const profile = loadAIProfile();
    const conflicts = [];
    const pending = [];
    for (const [id, credential] of Object.entries(profile.credentials)) {
        if (credential.conflict) conflicts.push(id);
        if (credential.pending) pending.push(id);
    }
    state.conflicts = conflicts;
    state.pending = pending;
}

function scheduleRetry() {
    if (retryTimer) clearTimeout(retryTimer);
    const delay = CREDENTIAL_RETRY_DELAYS_MS[Math.min(retryAttempt, CREDENTIAL_RETRY_DELAYS_MS.length - 1)];
    retryAttempt += 1;
    retryTimer = setTimeout(() => {
        retryTimer = null;
        runCredentialSync({ reason: 'retry' }).catch(() => {});
    }, delay + Math.floor(Math.random() * 1000));
}

/**
 * Guard for one sync run: the account, endpoint, token, auth generation and
 * local profile scope captured when the run started must all still match before
 * a response may change local state or end the session.
 */
function createSessionGuard(session, scopeKey) {
    return function sessionIsCurrent() {
        if (!isAuthSessionCurrent(session)) return false;
        if (!getAuthSnapshot().loggedIn) return false;
        return profileKeyForScope(getActiveAIScope()) === scopeKey;
    };
}

async function withProfileLock(runner) {
    if (typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function') {
        return navigator.locks.request('bdc-ai-profile', runner);
    }
    // No Web Locks: still run, but every write re-reads the profile and the
    // server version check prevents silent overwrites from another tab.
    return runner();
}

/**
 * Commit only the credential rows this run actually changed, on top of the
 * latest local profile.
 *
 * The sync used to save a whole profile that was read before its network round
 * trips, so a provider saved (or a key changed / provider deleted / task model
 * changed) while a request was in flight was silently reverted. Now:
 *   - every id this run touched is compared with the fingerprint captured when
 *     the run read the profile;
 *   - at commit time the profile is re-read synchronously (single-threaded
 *     localStorage read-modify-write), and a row is only replaced when its
 *     local fingerprint is still the one the sync based its work on;
 *   - anything the user changed is left untouched; provider definitions and
 *     task models are never written by the sync at all.
 */
function commitCredentialChanges(baseProfile, working, ids, scope) {
    const changes = [];
    for (const id of ids) {
        const baseCredential = baseProfile.credentials[id] || null;
        const before = credentialFingerprint(baseCredential);
        const afterCredential = working.credentials[id] || null;
        // Nothing at all changed for this row (version, conflict, error, key,
        // pending) — leave it alone.
        if (credentialIdentity(afterCredential) === credentialIdentity(baseCredential)) continue;
        changes.push({
            id,
            before,
            credential: afterCredential,
            basePending: (baseCredential && baseCredential.pending) || null
        });
    }
    if (!changes.length) return { applied: 0, skipped: 0, adjusted: 0 };
    let applied = 0;
    let skipped = 0;
    let adjusted = 0;
    try {
        updateAIProfile((draft) => {
            for (const change of changes) {
                const currentCredential = draft.credentials[change.id] || null;
                const current = credentialFingerprint(currentCredential);
                if (current === change.before) {
                    if (!change.credential) delete draft.credentials[change.id];
                    else draft.credentials[change.id] = change.credential;
                    applied += 1;
                    continue;
                }
                // The user edited this provider while the sync was waiting. Keep
                // the newer local state, but let its pending operation build on
                // the version this run confirmed *for that same mutation*, so a
                // fresh edit does not immediately look like a cloud conflict.
                if (advanceConfirmedBase(currentCredential, change)) {
                    adjusted += 1;
                    continue;
                }
                skipped += 1;
            }
            return draft;
        }, scope);
    } catch (error) {
        return { error: error && error.code ? error.code : 'profile_save_failed', applied, skipped, adjusted };
    }
    return { applied, skipped, adjusted };
}

/**
 * When the sync confirmed (or deleted) a pending mutation that the user has
 * since replaced with a newer one, move the new pending operation onto the
 * confirmed version. Only applies to mutations that this run itself saw
 * completed — a remote change made by another device never advances the base.
 */
function advanceConfirmedBase(currentCredential, change) {
    if (!currentCredential || !change.basePending || !change.credential) return false;
    const committed = change.credential;
    if (committed.pending) return false;
    if (committed.conflict) return false;
    const currentPending = currentCredential.pending;
    if (!currentPending) return false;
    if (Number(currentPending.expectedVersion) !== Number(change.basePending.expectedVersion)) return false;
    const nextVersion = Number(committed.version) || 0;
    if (nextVersion <= Number(change.basePending.expectedVersion)) return false;
    currentCredential.version = nextVersion;
    currentPending.expectedVersion = nextVersion;
    return true;
}

async function uploadPending(profile, providerId, credential, sessionIsCurrent) {
    const pending = credential.pending;
    if (!pending) return null;
    if (!sessionIsCurrent()) return null;

    if (pending.type === 'delete') {
        const res = await apiRequest(`/ai-credentials/${encodeURIComponent(providerId)}`, {
            method: 'DELETE',
            body: JSON.stringify({ expectedVersion: pending.expectedVersion, mutationId: pending.mutationId })
        }, { timeoutMs: CREDENTIAL_REQUEST_TIMEOUT_MS });
        if (res.status === 404) {
            // Never treat 404 as a bulk delete; this mutation simply has no row.
            return { kind: 'delete-not-found' };
        }
        if (res.status === 409) {
            const data = await res.json().catch(() => ({}));
            return { kind: 'conflict', row: readRemoteMeta(data) };
        }
        if (res.status === 401) return { kind: 'unauthorized' };
        if (res.status === 403) return { kind: 'forbidden', code: (await res.json().catch(() => ({}))).code };
        if (res.status === 429) return { kind: 'retry' };
        if (!res.ok) return { kind: 'error', status: res.status };
        const data = await res.json().catch(() => ({}));
        return { kind: 'delete-ok', row: readRemoteMeta(data) };
    }

    const res = await apiRequest(`/ai-credentials/${encodeURIComponent(providerId)}`, {
        method: 'PUT',
        body: JSON.stringify({
            expectedVersion: pending.expectedVersion,
            mutationId: pending.mutationId,
            binding: pending.binding,
            apiKey: pending.apiKey
        })
    }, { timeoutMs: CREDENTIAL_REQUEST_TIMEOUT_MS });
    if (res.status === 409) {
        const data = await res.json().catch(() => ({}));
        return { kind: 'conflict', row: readRemoteMeta(data) };
    }
    if (res.status === 401) return { kind: 'unauthorized' };
    if (res.status === 403) return { kind: 'forbidden', code: (await res.json().catch(() => ({}))).code };
    if (res.status === 404) return { kind: 'error', status: 404, code: 'old_worker' };
    if (res.status === 429) return { kind: 'retry' };
    if (!res.ok) return { kind: 'error', status: res.status };
    const data = await res.json().catch(() => ({}));
    return { kind: 'put-ok', row: readRemoteMeta(data) };
}

async function downloadOne(providerId) {
    const res = await apiRequest(`/ai-credentials/${encodeURIComponent(providerId)}`, { method: 'GET' }, { timeoutMs: CREDENTIAL_REQUEST_TIMEOUT_MS });
    if (res.status === 401) return { kind: 'unauthorized' };
    if (res.status === 403) return { kind: 'forbidden', code: (await res.json().catch(() => ({}))).code };
    if (res.status === 404) return { kind: 'missing' };
    if (!res.ok) return { kind: 'error', status: res.status };
    const data = await res.json().catch(() => null);
    if (!data) return { kind: 'error', status: 0 };
    return { kind: 'ok', data };
}

async function processCredential(profile, providerId, remote, sessionIsCurrent) {
    const credential = profile.credentials[providerId];
    if (!credential) return { retry: false, stop: false };
    const provider = profile.providers[providerId];
    const action = decideCredentialAction({
        version: credential.version,
        hasKey: !!credential.apiKey,
        syncMode: credential.syncMode,
        pending: credential.pending
    }, remote);

    if (action === 'noop') return { retry: false, stop: false };

    if (action === 'rollback') {
        setCredentialError(profile, providerId, 'remote_version_rollback');
        return { retry: false, stop: false };
    }

    if (action === 'conflict') {
        applyConflict(profile, providerId, remote);
        return { retry: false, stop: false };
    }

    if (action === 'confirm-pending') {
        // The mutation this run uploaded is already recorded server-side; a
        // tombstone therefore means *this* delete landed. Keep the local key
        // when the delete was only meant to remove the cloud copy.
        const keepLocalKey = !!(credential.pending && credential.pending.keepLocalKey);
        credential.version = Number(remote.version) || credential.version;
        credential.pending = null;
        credential.conflict = null;
        credential.lastSyncedAt = new Date().toISOString();
        if (remote.deleted) {
            credential.syncMode = 'local-only';
            if (!keepLocalKey) credential.apiKey = '';
        }
        return { retry: false, stop: false };
    }

    if (action === 'apply-remote-delete') {
        // A tombstone this device never asked for: another device deleted the
        // credential, so the local copy goes too. This is not the
        // remove-cloud-only case above.
        credential.apiKey = '';
        credential.version = Number(remote.version) || credential.version;
        credential.pending = null;
        credential.conflict = null;
        credential.syncMode = 'local-only';
        credential.lastSyncedAt = new Date().toISOString();
        clearCredentialError(profile, providerId);
        return { retry: false, stop: false };
    }

    if (action === 'download') {
        if (!provider) return { retry: false, stop: false };
        const localBinding = bindingForProvider(provider);
        if (remote && remote.binding && !bindingsEqual(remote.binding, localBinding)) {
            // The cloud row was written for a different endpoint/format than the
            // provider definition we know locally. Never download a key that
            // would then be sent to a destination it was not bound to.
            credential.lastError = 'binding_mismatch';
            credential.bindingVerified = false;
            return { retry: false, stop: false };
        }
        const result = await downloadOne(providerId);
        if (result.kind === 'unauthorized') return { retry: false, stop: true, unauthorized: true };
        if (result.kind === 'forbidden') return { retry: false, stop: true, forbidden: result.code };
        if (result.kind === 'missing') return { retry: false, stop: false };
        if (result.kind !== 'ok') return { retry: true, stop: false };
        if (!sessionIsCurrent()) return { retry: false, stop: true };
        const data = result.data;
        if (data.deleted) {
            // No local pending mutation exists on this path, so the tombstone
            // was written by another device: the key really is gone.
            credential.apiKey = '';
            credential.version = Number(data.version) || credential.version;
            credential.syncMode = 'local-only';
            credential.lastSyncedAt = new Date().toISOString();
            return { retry: false, stop: false };
        }
        if (!data.apiKey) return { retry: false, stop: false };
        if (!bindingsEqual(data.binding, localBinding)) {
            // Endpoint/format changed on the other device: pause this provider
            // instead of sending the key to a new destination.
            credential.lastError = 'binding_mismatch';
            credential.conflict = {
                remoteVersion: Number(data.version) || 0,
                remoteDeleted: false,
                remoteLastMutationId: String(data.lastMutationId || ''),
                detectedAt: new Date().toISOString()
            };
            return { retry: false, stop: false };
        }
        credential.apiKey = data.apiKey;
        credential.binding = localBinding;
        credential.bindingVerified = true;
        credential.keyStamp = credential.keyStamp || newMutationId();
        credential.version = Number(data.version) || credential.version;
        credential.pending = null;
        credential.conflict = null;
        credential.lastSyncedAt = new Date().toISOString();
        clearCredentialError(profile, providerId);
        return { retry: false, stop: false };
    }

    if (action === 'upload-pending') {
        // The mutation this run is about to send; its `keepLocalKey` intent
        // survives every outcome of the request.
        const pending = credential.pending;
        const result = await uploadPending(profile, providerId, credential, sessionIsCurrent);
        if (!result) return { retry: false, stop: true };
        if (result.kind === 'unauthorized') return { retry: false, stop: true, unauthorized: true };
        if (result.kind === 'forbidden') return { retry: false, stop: true, forbidden: result.code };
        if (result.kind === 'retry') return { retry: true, stop: true };
        if (result.kind === 'error') {
            if (result.status === 404) setCredentialError(profile, providerId, 'old_worker');
            return { retry: result.status >= 500 || !result.status, stop: false };
        }
        if (result.kind === 'conflict') {
            applyConflict(profile, providerId, result.row);
            return { retry: false, stop: false };
        }
        if (result.kind === 'delete-not-found') {
            // The cloud row is already gone. Honour the same intent as a
            // successful DELETE: remove-cloud keeps this device's key.
            credential.pending = null;
            credential.syncMode = 'local-only';
            credential.lastSyncedAt = new Date().toISOString();
            if (!pending.keepLocalKey) credential.apiKey = '';
            return { retry: false, stop: false };
        }
        const row = result.row || {};
        credential.pending = null;
        credential.conflict = null;
        credential.version = Number(row.version) || credential.version;
        credential.lastSyncedAt = new Date().toISOString();
        if (result.kind === 'delete-ok') {
            credential.syncMode = 'local-only';
            if (!pending.keepLocalKey) credential.apiKey = '';
        } else {
            // A confirmed upload proves the key works for this binding.
            credential.bindingVerified = true;
        }
        clearCredentialError(profile, providerId);
        return { retry: false, stop: false };
    }

    return { retry: false, stop: false };
}

async function runCredentialSync({ reason = 'manual' } = {}) {
    if (inFlight) return inFlight;
    const snapshot = getAuthSnapshot();
    if (!snapshot.loggedIn) {
        state.status = 'idle';
        state.pending = [];
        state.conflicts = [];
        notify();
        return getCredentialSyncState();
    }
    state.status = 'syncing';
    state.error = '';
    notify();
    const session = captureAuthSession();
    const scope = getActiveAIScope();
    const scopeKey = profileKeyForScope(scope);
    const sessionIsCurrent = createSessionGuard(session, scopeKey);

    inFlight = withProfileLock(async () => {
        let list;
        try {
            const res = await apiRequest('/ai-credentials', { method: 'GET' }, { timeoutMs: CREDENTIAL_REQUEST_TIMEOUT_MS });
            if (!sessionIsCurrent()) return { stale: true };
            if (res.status === 401) return { unauthorized: true, stale: false };
            if (res.status === 403) {
                const data = await res.json().catch(() => ({}));
                return { forbidden: data.code || 'forbidden' };
            }
            if (!res.ok) return { error: `HTTP ${res.status}`, retryable: res.status >= 500 };
            list = await res.json().catch(() => null);
        } catch (error) {
            if (!sessionIsCurrent()) return { stale: true };
            return { error: error && error.code ? error.code : 'offline', retryable: true };
        }
        if (!sessionIsCurrent()) return { stale: true };
        if (!list || !Array.isArray(list.items)) return { error: 'bad_list', retryable: false };

        const remoteMap = new Map();
        for (const item of list.items) {
            if (item && item.providerId) remoteMap.set(String(item.providerId), readRemoteMeta(item));
        }

        // Work on a private copy: the live profile may be edited (new provider,
        // changed key, delete, task change) while requests are in flight, and
        // only the credential changes we actually made are committed at the end.
        const baseProfile = loadAIProfile(scope);
        const profile = cloneProfile(baseProfile);
        let needRetry = false;
        let stop = false;
        let unauthorized = false;
        let forbidden = '';
        const ids = addDownloadTargets(profile, remoteMap);
        for (const id of ids) {
            if (stop) break;
            const credential = profile.credentials[id];
            if (!credential) continue;
            if (credential.syncMode === 'local-only' && !credential.pending) continue;
            const result = await processCredential(profile, id, remoteMap.get(id) || null, sessionIsCurrent);
            if (result.unauthorized) { unauthorized = true; stop = true; }
            if (result.forbidden) { forbidden = result.forbidden; stop = true; }
            if (result.retry) needRetry = true;
            if (result.stop) stop = true;
        }

        if (!sessionIsCurrent()) return { stale: true };
        const commit = commitCredentialChanges(baseProfile, profile, ids, scope);
        if (commit.error) return { error: 'profile_save_failed', retryable: false, code: commit.error, applied: commit.applied, skipped: commit.skipped };
        return {
            ok: true,
            needRetry,
            unauthorized,
            forbidden,
            applied: commit.applied,
            adjusted: commit.adjusted,
            skipped: commit.skipped
        };
    });

    try {
        let result;
        try {
            result = await inFlight;
        } catch (error) {
            result = { error: error && error.code ? error.code : 'sync_failed', retryable: false };
        }
        lastRunAt = Date.now();
        const stillCurrent = sessionIsCurrent();
        if (!stillCurrent) {
            result = { stale: true };
        }
        if (result.unauthorized) {
            state.status = 'unauthorized';
            state.error = 'unauthorized';
            // The passcode is no longer valid: clear the login token, keep the
            // local AI profile so personal providers keep working. A 401 from a
            // request issued for an older account/session must never end the
            // session that is current now.
            if (sessionIsCurrent()) auth.invalidateSession().catch(() => {});
        } else if (result.forbidden) {
            state.status = result.forbidden === 'passcode_upgrade_required' ? 'weak-passcode' : 'error';
            state.error = result.forbidden;
        } else if (result.stale) {
            state.status = 'idle';
        } else if (result.error) {
            state.status = result.retryable ? 'offline' : 'error';
            state.error = result.error;
            if (result.retryable) scheduleRetry();
        } else {
            state.status = 'synced';
            state.lastSyncAt = Date.now();
            state.error = '';
            retryAttempt = 0;
            if (result.needRetry) scheduleRetry();
        }
        markSyncMeta();
        if (state.conflicts.length && state.status !== 'unauthorized' && state.status !== 'weak-passcode') {
            state.status = 'conflict';
        }
        notify();
        return getCredentialSyncState();
    } finally {
        inFlight = null;
    }
}

export function syncCredentials({ reason = 'manual' } = {}) {
    return runCredentialSync({ reason });
}

export function scheduleCredentialSync(delayMs = 800) {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
        syncTimer = null;
        runCredentialSync({ reason: 'schedule' }).catch(() => {});
    }, Math.max(0, delayMs));
}

/** Persist a personal provider and its key in one atomic local write. */
export async function savePersonalProvider({
    providerId,
    provider,
    apiKey,
    keyChanged = false,
    clearKey = false,
    syncMode = 'local-only',
    scope
}) {
    const id = String(providerId || '');
    if (!isPersonalProviderId(id)) {
        const err = new Error('invalid provider id');
        err.code = 'invalid_provider_id';
        throw err;
    }
    const activeScope = scope || getActiveAIScope();
    const normalizedProvider = normalizeStoredProvider(id, provider);
    if (!normalizedProvider) {
        const err = new Error('invalid provider');
        err.code = 'invalid_provider';
        throw err;
    }
    const newBinding = bindingForProvider(normalizedProvider);
    let savedProfile = null;
    savedProfile = updateAIProfile((profile) => {
        const existing = profile.credentials[id];
        const existingBinding = existing && existing.binding;
        const bindingChanged = !!existing && !bindingsEqual(existingBinding, newBinding);
        profile.providers[id] = normalizedProvider;
        const now = new Date().toISOString();
        profile.providers[id].updatedAt = now;

        if (normalizedProvider.authMode === 'none') {
            if (existing) {
                if (existing.syncMode !== 'local-only' || existing.version > 0) {
                    profile.credentials[id] = normalizeCredential({
                        ...existing,
                        apiKey: '',
                        binding: newBinding,
                        syncMode: existing.version > 0 ? 'cloud-removal-pending' : 'local-only',
                        pending: existing.version > 0 ? {
                            type: 'delete',
                            mutationId: existing.pending && existing.pending.type === 'delete' ? existing.pending.mutationId : newMutationId(),
                            expectedVersion: existing.version,
                            apiKey: '',
                            binding: existing.binding || newBinding,
                            keepLocalKey: false,
                            createdAt: now
                        } : null
                    });
                } else {
                    delete profile.credentials[id];
                }
            }
            return profile;
        }

        const nextKey = clearKey ? '' : (keyChanged ? String(apiKey || '') : (existing?.apiKey || ''));
        if (!nextKey && clearKey) {
            if (existing && (existing.syncMode !== 'local-only' || existing.version > 0)) {
                profile.credentials[id] = normalizeCredential({
                    ...existing,
                    apiKey: '',
                    binding: newBinding,
                    syncMode: existing.version > 0 ? 'cloud-removal-pending' : 'local-only',
                    pending: existing.version > 0 ? {
                        type: 'delete',
                        mutationId: newMutationId(),
                        expectedVersion: existing.version,
                        apiKey: '',
                        binding: existing.binding || newBinding,
                        keepLocalKey: false,
                        createdAt: now
                    } : null
                });
            } else {
                delete profile.credentials[id];
            }
            return profile;
        }
        if (!nextKey) {
            const err = new Error('api key required');
            err.code = 'api_key_required';
            throw err;
        }
        if (bindingChanged && !keyChanged && syncMode === 'cloud') {
            const err = new Error('endpoint changed; confirm the key');
            err.code = 'binding_changed_requires_key';
            throw err;
        }
        const bindingVerified = keyChanged
            ? true
            : (bindingChanged ? false : (existing?.bindingVerified !== false));
        const baseVersion = existing ? existing.version : 0;
        const mode = syncMode === 'cloud' ? 'cloud' : 'local-only';
        const unchangedCloud = mode === 'cloud'
            && !!existing
            && existing.syncMode === 'cloud'
            && !!existing.apiKey
            && !keyChanged
            && !bindingChanged;
        const pending = mode !== 'cloud'
            ? null
            : (unchangedCloud
                ? (existing?.pending || null)
                : {
                    type: 'put',
                    mutationId: newMutationId(),
                    expectedVersion: baseVersion,
                    apiKey: nextKey,
                    binding: newBinding,
                    createdAt: now
                });
        profile.credentials[id] = normalizeCredential({
            apiKey: nextKey,
            binding: newBinding,
            keyStamp: keyChanged ? newMutationId() : (existing?.keyStamp || ''),
            version: baseVersion,
            syncMode: mode,
            pending,
            lastSyncedAt: existing?.lastSyncedAt || '',
            conflict: null,
            lastError: '',
            bindingVerified
        });
        return profile;
    }, activeScope);

    if (savedProfile) {
        try { syncTouch('aiSettings'); } catch (_) {}
        scheduleCredentialSync(500);
    }
    return savedProfile;
}

/** Delete a provider and (optionally) its cloud key. */
export function deletePersonalProvider(providerId, { removeCloud = true, scope } = {}) {
    const id = String(providerId || '');
    const activeScope = scope || getActiveAIScope();
    const saved = updateAIProfile((profile) => {
        const existing = profile.credentials[id];
        delete profile.providers[id];
        for (const key of Object.keys(profile.taskModels)) {
            const value = String(profile.taskModels[key] || '');
            if (value.startsWith(`${id}:`)) delete profile.taskModels[key];
        }
        if (profile.defaultModel && String(profile.defaultModel).startsWith(`${id}:`)) profile.defaultModel = '';
        if (!existing) return profile;
        if (removeCloud && (existing.version > 0 || existing.syncMode === 'cloud')) {
            const now = new Date().toISOString();
            profile.credentials[id] = normalizeCredential({
                ...existing,
                apiKey: '',
                syncMode: 'cloud-removal-pending',
                pending: {
                    type: 'delete',
                    mutationId: newMutationId(),
                    expectedVersion: existing.version,
                    apiKey: '',
                    binding: existing.binding,
                    keepLocalKey: false,
                    createdAt: now
                }
            });
        } else {
            delete profile.credentials[id];
        }
        return profile;
    }, activeScope);
    try { syncTouch('aiSettings'); } catch (_) {}
    scheduleCredentialSync(500);
    return saved;
}

export function setProviderKeySyncMode(providerId, mode, { scope } = {}) {
    const id = String(providerId || '');
    const activeScope = scope || getActiveAIScope();
    const saved = updateAIProfile((profile) => {
        const existing = profile.credentials[id];
        if (!existing) {
            const err = new Error('credential missing');
            err.code = 'credential_missing';
            throw err;
        }
        const now = new Date().toISOString();
        if (mode === 'local-only') {
            existing.pending = null;
            existing.syncMode = 'local-only';
            existing.conflict = null;
            existing.lastError = '';
        } else if (mode === 'cloud') {
            if (!existing.apiKey) {
                const err = new Error('key missing');
                err.code = 'api_key_required';
                throw err;
            }
            if (existing.bindingVerified === false) {
                const err = new Error('endpoint changed; confirm the key');
                err.code = 'binding_changed_requires_key';
                throw err;
            }
            existing.syncMode = 'cloud';
            existing.conflict = null;
            existing.pending = {
                type: 'put',
                mutationId: newMutationId(),
                expectedVersion: existing.version,
                apiKey: existing.apiKey,
                binding: existing.binding,
                createdAt: now
            };
        } else if (mode === 'remove-cloud') {
            if (existing.version < 1) {
                existing.syncMode = 'local-only';
                existing.pending = null;
            } else {
                // "Remove the cloud copy, keep this device": flag the delete so
                // no confirmation path (success, 404, or tombstone after a lost
                // response) clears the key the user asked to keep.
                existing.syncMode = 'cloud-removal-pending';
                existing.pending = {
                    type: 'delete',
                    mutationId: newMutationId(),
                    expectedVersion: existing.version,
                    apiKey: '',
                    binding: existing.binding,
                    keepLocalKey: true,
                    createdAt: now
                };
            }
        } else {
            const err = new Error('invalid sync mode');
            err.code = 'invalid_sync_mode';
            throw err;
        }
        return profile;
    }, activeScope);
    scheduleCredentialSync(500);
    return saved;
}

/**
 * Resolve a credential conflict.
 * choice: 'cloud' (adopt remote), 'local' (overwrite cloud with local), 'later'.
 *
 * Adopting the cloud copy needs a key download, so the whole operation is an
 * async task: it captures the login session and the credential row it started
 * from, and writes nothing unless both are still current when the answer
 * arrives. A late answer must never clear a newer pending upload, overwrite a
 * key saved meanwhile, or revive a row of a previous login session.
 */
export async function resolveCredentialConflict(providerId, choice, { scope } = {}) {
    const id = String(providerId || '');
    const activeScope = scope || getActiveAIScope();
    const scopeKey = profileKeyForScope(activeScope);
    const profile = loadAIProfile(activeScope);
    const credential = profile.credentials[id];
    if (!credential || !credential.conflict) return false;
    const conflict = credential.conflict;
    if (choice === 'later') return true;

    const session = captureAuthSession();
    const baseline = conflictBaseline(credential);

    /** The logged-in account/endpoint and the row must still be the ones we read. */
    function operationIsCurrent() {
        if (!isAuthSessionCurrent(session)) return false;
        if (!getAuthSnapshot().loggedIn) return false;
        if (profileKeyForScope(getActiveAIScope()) !== scopeKey) return false;
        return conflictBaseline(loadAIProfile(activeScope).credentials[id]) === baseline;
    }

    /** Conditional write: applies only while the row still matches `baseline`. */
    function guardedWrite(apply) {
        let applied = false;
        updateAIProfile((draft) => {
            const cred = draft.credentials[id];
            if (!cred || conflictBaseline(cred) !== baseline) return draft;
            apply(cred);
            applied = true;
            return draft;
        }, activeScope);
        if (applied) notify();
        return applied;
    }

    if (choice === 'cloud') {
        if (conflict.remoteDeleted) {
            return guardedWrite((cred) => {
                cred.apiKey = '';
                cred.version = conflict.remoteVersion;
                cred.pending = null;
                cred.conflict = null;
                cred.syncMode = 'local-only';
            });
        }
        const result = await downloadOne(id);
        // Nothing has been written yet: drop the answer rather than let it land
        // in a row (or an account) that has changed since the user chose.
        if (!operationIsCurrent()) return false;
        if (result.kind !== 'ok' || !result.data) {
            const err = new Error('download failed');
            err.code = result.kind === 'unauthorized' ? 'unauthorized' : 'conflict_download_failed';
            throw err;
        }
        const data = result.data;
        const remoteVersion = Number(data.version) || 0;
        if (remoteVersion < (Number(conflict.remoteVersion) || 0)) {
            // The row is behind the version that produced the conflict: the
            // answer cannot be the version the user agreed to adopt.
            const err = new Error('conflict download is outdated');
            err.code = 'conflict_download_stale';
            throw err;
        }
        if (data.deleted) {
            // The cloud copy was deleted while the answer was in flight; the
            // user asked to adopt the cloud version, which no longer has a key.
            return guardedWrite((cred) => {
                cred.apiKey = '';
                cred.version = remoteVersion || conflict.remoteVersion;
                cred.pending = null;
                cred.conflict = null;
                cred.syncMode = 'local-only';
            });
        }
        if (!data.apiKey) {
            const err = new Error('download failed');
            err.code = 'conflict_download_failed';
            throw err;
        }
        const provider = profile.providers[id];
        const localBinding = provider ? bindingForProvider(provider) : null;
        if (localBinding && data.binding && !bindingsEqual(data.binding, localBinding)) {
            // Never store a key that would then be sent to another destination.
            guardedWrite((cred) => {
                cred.bindingVerified = false;
                cred.lastError = 'binding_mismatch';
            });
            const err = new Error('endpoint changed; the cloud key is bound elsewhere');
            err.code = 'binding_mismatch';
            throw err;
        }
        return guardedWrite((cred) => {
            cred.apiKey = data.apiKey;
            cred.binding = localBinding || data.binding;
            cred.bindingVerified = true;
            cred.keyStamp = cred.keyStamp || newMutationId();
            cred.version = remoteVersion || conflict.remoteVersion;
            cred.pending = null;
            cred.conflict = null;
            cred.lastError = '';
            cred.lastSyncedAt = new Date().toISOString();
        });
    }
    if (choice === 'local') {
        const applied = guardedWrite((cred) => {
            cred.pending = {
                type: cred.apiKey ? 'put' : 'delete',
                mutationId: newMutationId(),
                expectedVersion: conflict.remoteVersion,
                apiKey: cred.apiKey,
                binding: cred.binding,
                keepLocalKey: false,
                createdAt: new Date().toISOString()
            };
            cred.syncMode = cred.apiKey ? 'cloud' : 'cloud-removal-pending';
            cred.conflict = null;
        });
        if (applied) scheduleCredentialSync(300);
        return applied;
    }
    return false;
}

/** Remove the cloud copy but keep this device's key. */
export function removeCloudKey(providerId, { scope } = {}) {
    return setProviderKeySyncMode(providerId, 'remove-cloud', { scope });
}

export function getProviderKeyStatus(providerId) {
    const profile = loadAIProfile();
    const credential = profile.credentials[String(providerId || '')];
    if (!credential) return { mode: 'none', hasKey: false, version: 0, pending: null, conflict: null, lastSyncedAt: '', lastError: '' };
    return {
        mode: credential.syncMode,
        hasKey: !!credential.apiKey,
        bindingVerified: credential.bindingVerified !== false,
        version: credential.version,
        pending: credential.pending ? credential.pending.type : '',
        conflict: credential.conflict,
        lastSyncedAt: credential.lastSyncedAt,
        lastError: credential.lastError
    };
}

function clearScheduledWork() {
    if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    retryAttempt = 0;
}

/** Stop pending sync/retry timers (used on logout and by tests). */
export function stopCredentialSync() {
    clearScheduledWork();
}

function sameScopeAsCurrent(scope) {
    if (!scope) return false;
    return profileKeyForScope(scope) === profileKeyForScope(getActiveAIScope());
}

function handleAuthEvent(event) {
    const detail = event && event.detail ? event.detail : {};
    if (detail.event === 'SIGNED_OUT') {
        // Explicit logout: remove this account's local AI profile and keys.
        clearScheduledWork();
        try { clearAccountAIProfiles(lastKnownScope); } catch (_) {}
        lastKnownScope = getActiveAIScope();
        state.status = 'idle';
        state.conflicts = [];
        state.pending = [];
        notify();
        return;
    }
    if (detail.event === 'SESSION_INVALID') {
        // Keep the account profile and personal keys; only stop syncing.
        clearScheduledWork();
        state.status = 'unauthorized';
        state.error = 'unauthorized';
        notify();
        return;
    }
    if (detail.event === 'ACCOUNT_CHANGED') {
        clearScheduledWork();
        // Only drop the profile of the account we are leaving. If the identity
        // did not actually move to another profile (e.g. a token refresh), the
        // current account's keys must survive.
        if (lastKnownScope && !sameScopeAsCurrent(lastKnownScope)) {
            try { clearAccountAIProfiles(lastKnownScope); } catch (_) {}
        }
        state.status = 'idle';
        state.error = '';
        state.conflicts = [];
        state.pending = [];
    }
    lastKnownScope = getActiveAIScope();
    scheduleCredentialSync(400);
}

function onOnline() {
    retryAttempt = 0;
    scheduleCredentialSync(300);
}

function onVisible() {
    if (typeof document !== 'undefined' && document.hidden) return;
    if (Date.now() - lastRunAt < 90000) return;
    scheduleCredentialSync(500);
}

function onStorage(event) {
    if (!event || !event.key || !String(event.key).startsWith(`${AI_PROFILE_PREFIX}:`)) return;
    markSyncMeta();
    notify();
}

export function initAICredentialSync() {
    if (initialized) return;
    initialized = true;
    try { window.addEventListener(AUTH_EVENT, handleAuthEvent); } catch (_) {}
    try { window.addEventListener('online', onOnline); } catch (_) {}
    try { window.addEventListener('focus', onVisible); } catch (_) {}
    try { document.addEventListener('visibilitychange', onVisible); } catch (_) {}
    try { window.addEventListener('storage', onStorage); } catch (_) {}
    markSyncMeta();
    lastKnownScope = getActiveAIScope();
    if (getAuthSnapshot().loggedIn) scheduleCredentialSync(1000);
}
