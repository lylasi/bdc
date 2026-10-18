// Managed default-provider catalog client.
//
// - The catalog (non-secret metadata) is cached per sync endpoint for display.
// - Shared keys live ONLY in this module's memory, are fetched on demand for
//   the current catalog version, and are dropped on logout / 401 / expiry.
// - A page session can use managed providers for at most 60 minutes after a
//   successful online verification. Every AI request checks this locally; it
//   never queries D1 per request.

import {
    apiRequest,
    auth,
    getAuthSnapshot,
    verifySession,
    captureAuthSession,
    isAuthSessionCurrent,
    AUTH_EVENT
} from './sync-cloudflare.js';
import { normalizeSyncEndpoint, getActiveAIScope } from './ai-profile-storage.js';

export const CATALOG_SESSION_TTL_MS = 60 * 60 * 1000;
export const CATALOG_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const CATALOG_REFRESH_MIN_GAP_MS = 60 * 1000;
const CATALOG_META_PREFIX = 'bdc_ai_catalog_meta_v1';

const credentialCache = new Map();
const listeners = new Set();

const state = {
    status: 'idle', // idle | unauthenticated | verified | offline | expired | error | weak-passcode
    endpoint: '',
    userId: '',
    role: '',
    version: 0,
    providers: [],
    tasks: {},
    publishedAt: null,
    verifiedAt: 0,
    expiresAt: 0,
    error: '',
    generation: 0
};

let initialized = false;
let refreshTimer = null;
let expiryTimer = null;
let inFlight = null;
let lastRefreshAt = 0;

function metaKey(endpoint) {
    return `${CATALOG_META_PREFIX}:${encodeURIComponent(normalizeSyncEndpoint(endpoint))}`;
}

/**
 * A request may only change catalog state while it still belongs to the same
 * account, endpoint and auth generation it started in, and while no catalog
 * update has happened in between. 401/403 handlers *must* check this first:
 * a late 401 from account A must never sign out account B.
 */
function captureCatalogSession() {
    return { session: captureAuthSession(), stateGeneration: state.generation };
}

function catalogSessionStale(captured) {
    if (!captured) return true;
    if (captured.stateGeneration !== state.generation) return true;
    return !isAuthSessionCurrent(captured.session);
}

function sessionIdentityChanged(snapshot) {
    const endpoint = normalizeSyncEndpoint(snapshot.endpoint);
    return snapshot.userId !== state.userId || endpoint !== state.endpoint;
}

/** Drop every shared key + session window and forget the previous catalog. */
function resetForIdentityChange(snapshot) {
    state.version = 0;
    state.providers = [];
    state.tasks = {};
    state.publishedAt = null;
    state.endpoint = normalizeSyncEndpoint(snapshot.endpoint);
    state.userId = snapshot.userId;
    lockManagedCatalog(snapshot.loggedIn ? 'offline' : 'unauthenticated', '');
    if (snapshot.loggedIn) loadCachedMeta();
    state.status = snapshot.loggedIn ? 'offline' : 'unauthenticated';
    notify();
}

function readMeta(endpoint) {
    try {
        const raw = localStorage.getItem(metaKey(endpoint));
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        return parsed;
    } catch (_) {
        return null;
    }
}

function writeMeta(endpoint, value) {
    try { localStorage.setItem(metaKey(endpoint), JSON.stringify(value)); } catch (_) {}
}

function notify() {
    const snapshot = getCatalogState();
    for (const cb of listeners) {
        try { cb(snapshot); } catch (_) {}
    }
    try {
        window.dispatchEvent(new CustomEvent('bdc:ai-catalog-change', { detail: snapshot }));
    } catch (_) {}
}

function clearExpiryTimer() {
    if (expiryTimer) {
        clearTimeout(expiryTimer);
        expiryTimer = null;
    }
}

function scheduleExpiry() {
    clearExpiryTimer();
    if (!state.expiresAt) return;
    const delay = Math.max(0, state.expiresAt - Date.now()) + 25;
    expiryTimer = setTimeout(() => {
        if (!state.expiresAt || Date.now() < state.expiresAt) return;
        clearManagedKeys({ reason: 'expired' });
        state.status = getAuthSnapshot().loggedIn ? 'expired' : 'unauthenticated';
        notify();
    }, delay);
}

export function getCatalogState() {
    const usable = isManagedUsable();
    return {
        status: state.status,
        usable,
        endpoint: state.endpoint,
        userId: state.userId,
        role: state.role,
        version: state.version,
        providers: state.providers,
        tasks: state.tasks,
        publishedAt: state.publishedAt,
        verifiedAt: state.verifiedAt,
        expiresAt: state.expiresAt,
        error: state.error,
        generation: state.generation,
        loggedIn: getAuthSnapshot().loggedIn
    };
}

export function subscribeAICatalog(callback) {
    if (typeof callback === 'function') listeners.add(callback);
    return () => listeners.delete(callback);
}

export function getManagedProviders({ includeDisabled = false } = {}) {
    const providers = Array.isArray(state.providers) ? state.providers : [];
    return providers
        .filter((provider) => includeDisabled || provider.enabled !== false)
        .sort((a, b) => Number(a.order || 0) - Number(b.order || 0))
        .map((provider) => ({
            ...provider,
            id: provider.id,
            label: provider.name || provider.id,
            source: 'managed',
            enabled: provider.enabled !== false,
            apiUrl: provider.apiUrl,
            modelsUrl: provider.modelsUrl,
            allowedModels: (provider.models || []).map((model) => model.id)
        }));
}

export function getManagedProvider(providerId) {
    const id = String(providerId || '');
    if (!id) return null;
    return (state.providers || []).find((provider) => provider.id === id) || null;
}

export function getManagedTaskSpec(taskName) {
    const spec = state.tasks && state.tasks[taskName];
    if (!spec || !spec.providerId || !spec.model) return '';
    return `${spec.providerId}:${spec.model}`;
}

export function isManagedUsable() {
    return state.status === 'verified'
        && !!getAuthSnapshot().loggedIn
        && state.expiresAt > Date.now();
}

export function getManagedSessionRemainingMs() {
    return Math.max(0, state.expiresAt - Date.now());
}

export function clearManagedKeys() {
    credentialCache.clear();
    state.generation += 1;
}

/** Drop every shared key and mark the catalog locked, keeping metadata for display. */
export function lockManagedCatalog(status = 'unauthenticated', error = '') {
    clearManagedKeys();
    clearExpiryTimer();
    state.status = status;
    state.error = error;
    state.verifiedAt = 0;
    state.expiresAt = 0;
    notify();
}

function loadCachedMeta() {
    const scope = getActiveAIScope();
    const meta = readMeta(scope.endpoint);
    if (!meta) return;
    state.version = Number(meta.version) || 0;
    state.providers = Array.isArray(meta.providers) ? meta.providers : [];
    state.tasks = meta.tasks && typeof meta.tasks === 'object' ? meta.tasks : {};
    state.publishedAt = meta.publishedAt || null;
}

function pruneCredentialCache() {
    for (const [providerId, entry] of credentialCache) {
        const provider = getManagedProvider(providerId);
        if (!provider || provider.enabled === false || entry.catalogVersion !== state.version) {
            credentialCache.delete(providerId);
            continue;
        }
        if (provider.authMode !== 'none' && provider.authMode !== entry.binding?.authMode) {
            credentialCache.delete(providerId);
        }
    }
}

function bindingForProvider(provider) {
    return {
        formatVersion: provider.formatVersion || 1,
        format: provider.format,
        apiUrl: provider.apiUrl,
        modelsUrl: provider.modelsUrl,
        authMode: provider.authMode
    };
}

function bindingsEqual(a, b) {
    return !!a && !!b
        && String(a.format || '') === String(b.format || '')
        && String(a.apiUrl || '') === String(b.apiUrl || '')
        && String(a.modelsUrl || '') === String(b.modelsUrl || '')
        && String(a.authMode || '') === String(b.authMode || '');
}

/**
 * Fetch (or reuse) a shared key for one managed provider. The key is only kept
 * in memory and only returned when the caller is still in the same session.
 */
export async function getManagedCredential(providerId, { force = false } = {}) {
    const provider = getManagedProvider(providerId);
    if (!provider || provider.enabled === false) {
        const err = new Error('managed provider unavailable');
        err.code = 'managed_provider_unavailable';
        throw err;
    }
    if (!getAuthSnapshot().loggedIn) {
        const err = new Error('login required');
        err.code = 'managed_login_required';
        throw err;
    }
    if (!isManagedUsable()) {
        const err = new Error('managed session expired');
        err.code = state.status === 'expired' ? 'managed_session_expired' : 'managed_login_required';
        throw err;
    }
    if (provider.authMode === 'none') {
        return { apiKey: null, binding: bindingForProvider(provider), credentialRevision: 0 };
    }
    const cached = credentialCache.get(providerId);
    if (!force && cached && cached.catalogVersion === state.version) return cached;

    const captured = captureCatalogSession();
    const snapshot = getAuthSnapshot();
    let res;
    try {
        res = await apiRequest(
            `/ai-catalog/providers/${encodeURIComponent(providerId)}/credential?catalogVersion=${encodeURIComponent(state.version)}`,
            { method: 'GET' },
            { timeoutMs: 10000, token: snapshot.token }
        );
    } catch (error) {
        if (catalogSessionStale(captured)) throw staleSessionError();
        throw error;
    }
    if (res.status === 401) {
        if (catalogSessionStale(captured)) throw staleSessionError();
        await auth.invalidateSession();
        lockManagedCatalog('unauthenticated', 'unauthorized');
        const err = new Error('login required');
        err.code = 'managed_login_required';
        throw err;
    }
    if (res.status === 403) {
        if (catalogSessionStale(captured)) throw staleSessionError();
        lockManagedCatalog('weak-passcode', 'passcode_upgrade_required');
        const err = new Error('passcode upgrade required');
        err.code = 'passcode_upgrade_required';
        throw err;
    }
    if (res.status === 409) {
        const data = await res.json().catch(() => ({}));
        const err = new Error('catalog version changed');
        err.code = 'catalog_version_conflict';
        err.version = Number(data.version) || 0;
        if (!catalogSessionStale(captured)) {
            refreshAICatalog({ force: true, reason: 'version-conflict' }).catch(() => {});
        }
        throw err;
    }
    if (res.status === 404) {
        if (catalogSessionStale(captured)) throw staleSessionError();
        const err = new Error('credential missing');
        err.code = 'managed_credential_missing';
        throw err;
    }
    if (!res.ok) {
        if (catalogSessionStale(captured)) throw staleSessionError();
        const err = new Error('credential download failed');
        err.code = res.status === 503 ? 'credential_unavailable' : 'managed_credential_failed';
        err.status = res.status;
        throw err;
    }
    const data = await res.json().catch(() => null);
    if (!data || typeof data.apiKey !== 'string' || !data.apiKey) {
        if (catalogSessionStale(captured)) throw staleSessionError();
        const err = new Error('credential malformed');
        err.code = 'managed_credential_missing';
        throw err;
    }
    // Discard downloads that finished after logout / account / endpoint /
    // catalog changes, before looking at their contents.
    if (catalogSessionStale(captured) || !getAuthSnapshot().loggedIn || !isManagedUsable()) {
        throw staleSessionError();
    }
    if (Number(data.catalogVersion) !== Number(state.version)) {
        const err = new Error('catalog version changed');
        err.code = 'catalog_version_conflict';
        throw err;
    }
    const expected = bindingForProvider(provider);
    if (!bindingsEqual(data.binding, expected)) {
        const err = new Error('credential binding mismatch');
        err.code = 'managed_binding_mismatch';
        throw err;
    }
    const entry = {
        apiKey: data.apiKey,
        binding: data.binding,
        credentialRevision: Number(data.credentialRevision) || 0,
        catalogVersion: Number(data.catalogVersion),
        fetchedAt: Date.now()
    };
    credentialCache.set(providerId, entry);
    return entry;
}

function staleSessionError() {
    const err = new Error('stale credential download');
    err.code = 'stale_session';
    return err;
}

export function peekManagedCredential(providerId) {
    const entry = credentialCache.get(providerId);
    return entry && entry.catalogVersion === state.version ? entry : null;
}

function applyCatalogData(data, captured) {
    if (catalogSessionStale(captured)) return;
    if (!getAuthSnapshot().loggedIn) return;
    const version = Number(data.version) || 0;
    const providers = (Array.isArray(data.providers) ? data.providers : []).map((provider) => ({
        id: String(provider.id || ''),
        name: String(provider.name || provider.id || ''),
        order: Number(provider.order) || 0,
        enabled: provider.enabled !== false,
        format: String(provider.format || ''),
        formatVersion: Number(provider.formatVersion) || 1,
        apiUrl: String(provider.apiUrl || ''),
        modelsUrl: String(provider.modelsUrl || ''),
        authMode: String(provider.authMode || 'bearer'),
        models: Array.isArray(provider.models) ? provider.models.map((model) => ({
            id: String(model.id || ''),
            label: String(model.label || model.id || ''),
            capabilities: model.capabilities || {}
        })).filter((model) => model.id) : []
    })).filter((provider) => provider.id.startsWith('managed-'));
    state.version = version;
    state.providers = providers;
    state.tasks = data.tasks && typeof data.tasks === 'object' ? data.tasks : {};
    state.publishedAt = data.publishedAt || null;
    state.verifiedAt = Date.now();
    const serverExpiry = Date.parse(data.expiresAt || '') || 0;
    state.expiresAt = Math.min(
        Date.now() + CATALOG_SESSION_TTL_MS,
        serverExpiry > Date.now() ? serverExpiry : Date.now() + CATALOG_SESSION_TTL_MS
    );
    state.status = 'verified';
    state.error = '';
    state.generation += 1;
    pruneCredentialCache();
    writeMeta(state.endpoint, {
        version,
        providers,
        tasks: state.tasks,
        publishedAt: state.publishedAt,
        fetchedAt: Date.now()
    });
    scheduleExpiry();
    notify();
}

async function refreshInternal(reason) {
    const snapshot = getAuthSnapshot();
    if (!snapshot.loggedIn) {
        lockManagedCatalog('unauthenticated', '');
        return getCatalogState();
    }
    const captured = captureCatalogSession();
    const res = await apiRequest('/ai-catalog', { method: 'GET' }, { timeoutMs: 10000, token: snapshot.token });
    if (catalogSessionStale(captured)) return getCatalogState();
    if (res.status === 401) {
        // Only the session that issued this request may be signed out.
        await auth.invalidateSession();
        lockManagedCatalog('unauthenticated', 'unauthorized');
        return getCatalogState();
    }
    if (res.status === 403) {
        const data = await res.json().catch(() => ({}));
        lockManagedCatalog('weak-passcode', data.code || 'passcode_upgrade_required');
        return getCatalogState();
    }
    if (!res.ok) {
        // Keep a still-valid session alive on server errors; never extend it.
        state.status = isManagedUsable() ? 'verified' : 'error';
        state.error = `HTTP ${res.status}`;
        notify();
        return getCatalogState();
    }
    const data = await res.json().catch(() => null);
    if (!data) {
        if (catalogSessionStale(captured)) return getCatalogState();
        state.error = 'bad_catalog';
        notify();
        return getCatalogState();
    }
    applyCatalogData(data, captured);
    return getCatalogState();
}

export async function refreshAICatalog({ force = false, reason = 'manual' } = {}) {
    if (!initialized) initAICatalog();
    const snapshot = getAuthSnapshot();
    if (sessionIdentityChanged(snapshot)) {
        // Cross-tab or otherwise event-less identity change: lock before doing
        // anything else so a previous account's window/key never stays usable.
        resetForIdentityChange(snapshot);
    }
    state.endpoint = normalizeSyncEndpoint(snapshot.endpoint);
    state.userId = snapshot.userId;
    state.role = snapshot.role;
    if (!snapshot.loggedIn) {
        lockManagedCatalog('unauthenticated', '');
        return getCatalogState();
    }
    if (inFlight) {
        if (!force) return inFlight;
        return inFlight.then(() => refreshAICatalog({ force: true, reason }));
    }
    if (!force && Date.now() - lastRefreshAt < CATALOG_REFRESH_MIN_GAP_MS) return getCatalogState();
    lastRefreshAt = Date.now();
    const captured = captureCatalogSession();
    inFlight = (async () => {
        try {
            return await refreshInternal(reason);
        } catch (error) {
            if (catalogSessionStale(captured)) return getCatalogState();
            if (error && error.code === 'sync_endpoint_missing') {
                lockManagedCatalog('error', 'sync_endpoint_missing');
                return getCatalogState();
            }
            if (error && error.code === 'stale_session') return getCatalogState();
            state.status = isManagedUsable() ? 'verified' : 'offline';
            state.error = error && error.code ? error.code : 'offline';
            notify();
            return getCatalogState();
        } finally {
            inFlight = null;
        }
    })();
    return inFlight;
}

function handleAuthEvent(event) {
    const detail = event && event.detail ? event.detail : {};
    const snapshot = getAuthSnapshot();
    state.role = snapshot.role;
    if (detail.event === 'SIGNED_OUT') {
        try { localStorage.removeItem(metaKey(state.endpoint)); } catch (_) {}
        state.version = 0;
        state.providers = [];
        state.tasks = {};
        state.publishedAt = null;
        state.userId = '';
        state.endpoint = normalizeSyncEndpoint(snapshot.endpoint);
        lockManagedCatalog('unauthenticated', '');
        return;
    }
    if (detail.event === 'SESSION_INVALID' || !snapshot.loggedIn) {
        // Keep non-secret metadata for display, but drop every shared key.
        state.userId = '';
        lockManagedCatalog('unauthenticated', 'unauthorized');
        return;
    }
    if (detail.event === 'ACCOUNT_CHANGED' || sessionIdentityChanged(snapshot)) {
        // Switching accounts (or endpoints) locks managed providers at once:
        // clear the shared keys, the session window and the previous catalog
        // version. Only a successful verification for the new account may
        // unlock them again.
        resetForIdentityChange(snapshot);
    }
    refreshAICatalog({ force: true, reason: 'auth' }).catch(() => {});
}

function scheduleForegroundRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
        if (typeof document !== 'undefined' && document.hidden) return;
        refreshAICatalog({ reason: 'interval' }).catch(() => {});
    }, CATALOG_REFRESH_INTERVAL_MS);
}

function onVisible() {
    if (typeof document !== 'undefined' && document.hidden) return;
    refreshAICatalog({ reason: 'focus' }).catch(() => {});
}

export function initAICatalog() {
    if (initialized) return;
    initialized = true;
    const snapshot = getAuthSnapshot();
    state.endpoint = normalizeSyncEndpoint(snapshot.endpoint);
    state.userId = snapshot.userId;
    state.role = snapshot.role;
    loadCachedMeta();
    state.status = snapshot.loggedIn ? 'offline' : 'unauthenticated';
    try { window.addEventListener(AUTH_EVENT, handleAuthEvent); } catch (_) {}
    try { window.addEventListener('online', () => refreshAICatalog({ force: true, reason: 'online' }).catch(() => {})); } catch (_) {}
    try { window.addEventListener('focus', onVisible); } catch (_) {}
    try { document.addEventListener('visibilitychange', onVisible); } catch (_) {}
    scheduleForegroundRefresh();
    // Online verification also refreshes the role shown in the UI. It never
    // authorises anything by itself; the Worker checks the role per request.
    const verifyCaptured = captureCatalogSession();
    verifySession().then(({ role }) => {
        if (!isAuthSessionCurrent(verifyCaptured.session)) return;
        state.role = role;
        notify();
    }).catch((error) => {
        if (!isAuthSessionCurrent(verifyCaptured.session)) return;
        if (error && error.code === 'unauthorized') {
            auth.invalidateSession().catch(() => {});
            lockManagedCatalog('unauthenticated', 'unauthorized');
        }
    });
    refreshAICatalog({ reason: 'init' }).catch(() => {});
    notify();
}

export function destroyAICatalog() {
    if (refreshTimer) clearInterval(refreshTimer);
    clearExpiryTimer();
    initialized = false;
}
