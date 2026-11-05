// Trusted extension AI runtime adapter.
//
// Bridges BDC's existing sync/auth, AI profile storage, managed catalog,
// personal credential sync, and shared lookupSelection() entry point inside an
// extension-origin page (popup / options / standalone extension tab).
//
// Security boundaries:
//   - Only runs in trusted extension pages (chrome-extension://).
//   - Managed provider keys stay strictly in modules/ai-catalog.js memory and
//     are never persisted to localStorage or chrome.storage.local.
//   - Personal provider keys with syncMode='local-only' on the BDC website are
//     not automatically copied; missing keys are surfaced explicitly and any
//     manual local key import is strictly isolated by (endpoint, userId).
//   - All async operations verify captured session identity (endpoint, userId,
//     token, generation) before committing state or reacting to 401.

import {
    auth,
    apiRequest,
    getAuthSnapshot,
    captureAuthSession,
    isAuthSessionCurrent,
    verifySession,
    AUTH_EVENT
} from './sync-cloudflare.js';
import {
    normalizeSyncEndpoint,
    getActiveAIScope,
    profileKeyForScope,
    loadAIProfile,
    updateAIProfile,
    applyRemoteAISettings,
    clearAccountAIProfiles,
    normalizeCredential,
    isPersonalProviderId
} from './ai-profile-storage.js';
import {
    initAICatalog,
    destroyAICatalog,
    refreshAICatalog,
    getCatalogState,
    clearManagedKeys
} from './ai-catalog.js';
import {
    initAICredentialSync,
    stopCredentialSync,
    syncCredentials,
    getCredentialSyncState,
    getProviderKeyStatus,
    bindingForProvider
} from './ai-credential-sync.js';
import {
    getPreferredTaskSpec,
    normalizeModelSpec,
    resolveAIRequestConfig,
    resolveThinkingLevel
} from './ai-models.js';
import { lookupSelection, resetThinkingFallbackMemory } from './api.js';
import { sanitizeAISettings } from './ai-settings-sanitize.js';
import { getLocale, t } from './i18n.js';

export const EXTENSION_ENDPOINT_STORAGE_KEY = 'bdc_ext_sync_endpoint_v1';
export const EXTENSION_SESSION_BACKUP_KEY = 'bdc_ext_trusted_session_v1';

let runtimeInitialized = false;

// Endpoint reads remain synchronous across extension pages. Both existing auth
// and AI profile modules use this hook; a per-page cached string can pair a new
// page's token with another page's old endpoint.
export function getExtensionSyncEndpoint() {
    try { return normalizeSyncEndpoint(localStorage.getItem(EXTENSION_ENDPOINT_STORAGE_KEY) || ''); }
    catch (_) { return ''; }
}

Object.defineProperty(globalThis, '__BDC_SYNC_ENDPOINT__', {
    configurable: true,
    get: getExtensionSyncEndpoint,
    set(value) {
        const next = normalizeSyncEndpoint(value);
        if (getAuthSnapshot().loggedIn && next !== getExtensionSyncEndpoint()) {
            throw Object.assign(new Error(t('extension.staleLookupDiscarded')), { code: 'stale_session' });
        }
        localStorage.setItem(EXTENSION_ENDPOINT_STORAGE_KEY, next);
    }
});

async function clearLegacySessionBackup() {
    // Auth already persists in extension-origin localStorage, inaccessible to
    // content scripts. Do not keep a second, independently restorable token.
    const storage = globalThis.chrome?.storage?.local;
    if (!storage) return;
    if (storage.setAccessLevel) await storage.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    if (storage.remove) await storage.remove(EXTENSION_SESSION_BACKUP_KEY);
    else if (storage.set) await storage.set({ [EXTENSION_SESSION_BACKUP_KEY]: {} });
}

export async function setExtensionSyncEndpoint(endpoint) {
    const next = normalizeSyncEndpoint(endpoint);
    if (getExtensionSyncEndpoint() !== next) {
        await auth.signOut();
        clearManagedKeys();
        resetThinkingFallbackMemory();
        localStorage.setItem(EXTENSION_ENDPOINT_STORAGE_KEY, next);
        try { window.dispatchEvent(new CustomEvent('bdc:extension-endpoint-change')); } catch (_) {}
    }
    await clearLegacySessionBackup();
    return next;
}

export async function restoreTrustedSessionState() {
    await clearLegacySessionBackup();
    if (!runtimeInitialized) {
        runtimeInitialized = true;
        initAICatalog();
        initAICredentialSync();
    }
    return getAuthSnapshot();
}

/**
 * Pull ONLY the AI settings group from GET /snapshot without touching main-site
 * article/reading/vocabulary stores. Validates session identity before applying.
 */
export async function pullExtensionAISettings() {
    const session = captureAuthSession();
    if (!session.loggedIn) {
        const err = new Error(t('errors.aiLoginRequired'));
        err.code = 'unauthorized';
        throw err;
    }
    const res = await apiRequest('/snapshot', { method: 'GET' }, { timeoutMs: 15000, token: session.token });
    if (!isAuthSessionCurrent(session)) {
        const err = new Error('session changed');
        err.code = 'stale_session';
        throw err;
    }
    if (res.status === 401) {
        await auth.invalidateSession();
        clearManagedKeys({ reason: 'unauthorized' });
        const err = new Error(t('errors.loginExpired'));
        err.code = 'unauthorized';
        throw err;
    }
    if (!res.ok) {
        const err = new Error(t('errors.cloudReadFailed', { status: res.status }));
        err.code = 'snapshot_read_failed';
        err.status = res.status;
        throw err;
    }
    const data = await res.json().catch(() => ({}));
    if (!isAuthSessionCurrent(session)) {
        const err = new Error('session changed');
        err.code = 'stale_session';
        throw err;
    }
    let payload = data?.payload;
    if (typeof payload === 'string') {
        try { payload = JSON.parse(payload); } catch (_) { payload = {}; }
    }
    const aiGroup = payload && typeof payload === 'object' ? payload.aiSettings : null;
    const rawSettings = aiGroup && typeof aiGroup === 'object' ? aiGroup.settings : null;
    const updatedAt = aiGroup && typeof aiGroup.updatedAt === 'string' ? aiGroup.updatedAt : (data?.updated_at || '');
    const scope = {
        endpoint: normalizeSyncEndpoint(session.endpoint),
        userId: session.userId,
        guest: false,
        key: profileKeyForScope({ endpoint: session.endpoint, userId: session.userId, guest: false })
    };
    if (rawSettings && typeof rawSettings === 'object') {
        const clean = sanitizeAISettings(rawSettings);
        applyRemoteAISettings(clean, updatedAt, scope);
        try {
            window.dispatchEvent(new CustomEvent('bdc:ai-settings-applied', { detail: { updatedAt } }));
        } catch (_) {}
    }
    return loadAIProfile(scope);
}

/**
 * Synchronize AI configuration for the currently authenticated account:
 *   1. Pulls AI settings from GET /snapshot (`payload.aiSettings.settings`)
 *   2. Refreshes managed catalog from GET /ai-catalog
 *   3. Syncs cloud personal credentials from GET /ai-credentials & /:id
 * Every step checks session currency so an account switch or logout mid-flight
 * drops stale responses cleanly.
 */
export async function syncExtensionAccountAI() {
    const session = captureAuthSession();
    if (!session.loggedIn) {
        return getExtensionReadiness();
    }
    await pullExtensionAISettings();
    if (!isAuthSessionCurrent(session)) {
        const err = new Error('session changed');
        err.code = 'stale_session';
        throw err;
    }
    await Promise.all([
        refreshAICatalog({ force: true, reason: 'extension-sync' }),
        syncCredentials({ reason: 'extension-sync' })
    ]);
    if (!isAuthSessionCurrent(session)) {
        const err = new Error('session changed');
        err.code = 'stale_session';
        throw err;
    }
    return getExtensionReadiness();
}

/**
 * Connect account via username+password, passcode token, or one-time login code,
 * then immediately load AI settings, managed catalog, and cloud personal credentials.
 */
export async function connectExtensionAccount({
    endpoint,
    mode = 'password',
    username = '',
    password = '',
    token = '',
    loginCode = ''
} = {}) {
    const requestedEndpoint = normalizeSyncEndpoint(endpoint || getExtensionSyncEndpoint());
    await setExtensionSyncEndpoint(requestedEndpoint);
    const activeEndpoint = getExtensionSyncEndpoint();
    if (activeEndpoint !== requestedEndpoint) {
        throw Object.assign(new Error(t('extension.staleLookupDiscarded')), { code: 'stale_session' });
    }
    if (!activeEndpoint) {
        const err = new Error(t('errors.syncEndpointMissing'));
        err.code = 'sync_endpoint_missing';
        throw err;
    }
    const prevScope = getActiveAIScope();
    if (mode === 'password') {
        await auth.signInWithPassword(username, password);
    } else if (mode === 'token') {
        await auth.signInWithToken(token);
    } else if (mode === 'code') {
        await auth.signInWithLoginCode(loginCode);
    } else {
        const err = new Error(t('extension.invalidLoginMode'));
        err.code = 'invalid_login_mode';
        throw err;
    }
    const nextScope = getActiveAIScope();
    if (!prevScope.guest && prevScope.key !== nextScope.key) {
        try { clearAccountAIProfiles(prevScope); } catch (_) {}
    }
    await clearLegacySessionBackup();
    return await syncExtensionAccountAI();
}

export async function disconnectExtensionAccount() {
    const scope = getActiveAIScope();
    clearManagedKeys({ reason: 'logout' });
    resetThinkingFallbackMemory();
    await auth.signOut();
    if (!scope.guest) {
        try { clearAccountAIProfiles(scope); } catch (_) {}
    }
    await clearLegacySessionBackup();
    return getExtensionReadiness();
}

/**
 * Explicitly import a personal provider API key into the current (endpoint, userId)
 * scope as `local-only`. Never copies keys from website localStorage automatically,
 * and never leaks the imported key to another endpoint or user.
 */
export function importScopedLocalProviderKey({ providerId, apiKey, scope } = {}) {
    const id = String(providerId || '').trim();
    const keyVal = String(apiKey || '').trim();
    if (!isPersonalProviderId(id)) {
        const err = new Error(t('extension.invalidProviderId'));
        err.code = 'invalid_provider_id';
        throw err;
    }
    if (!keyVal) {
        const err = new Error(t('extension.keyRequired'));
        err.code = 'api_key_required';
        throw err;
    }
    const activeScope = scope || getActiveAIScope();
    if (activeScope.guest || !activeScope.endpoint || !activeScope.userId) {
        const err = new Error(t('errors.aiLoginRequired'));
        err.code = 'managed_login_required';
        throw err;
    }
    const currentProfile = loadAIProfile(activeScope);
    const provider = currentProfile.providers[id];
    if (!provider) {
        const err = new Error(t('errors.aiProviderUnavailable'));
        err.code = 'provider_missing';
        throw err;
    }
    const binding = bindingForProvider(provider);
    const updated = updateAIProfile((draft) => {
        const existing = draft.credentials[id];
        draft.credentials[id] = normalizeCredential({
            ...(existing || {}),
            apiKey: keyVal,
            binding,
            version: existing ? Number(existing.version) || 0 : 0,
            syncMode: 'local-only',
            pending: null,
            conflict: null,
            lastError: '',
            bindingVerified: true
        });
        return draft;
    }, activeScope, { touchUpdatedAt: false });
    return {
        ok: true,
        providerId: id,
        scope: { endpoint: activeScope.endpoint, userId: activeScope.userId },
        hasKey: !!updated.credentials[id]?.apiKey
    };
}

/**
 * Inspect current account, active AI scope, resolved lookup task model,
 * and whether any personal provider is missing a local-only key.
 */
export function getExtensionReadiness({ text = '', sentence = '', context = '' } = {}) {
    const authSnap = getAuthSnapshot();
    const endpoint = getExtensionSyncEndpoint();
    const scope = getActiveAIScope();
    const profile = loadAIProfile(scope);
    const catalog = getCatalogState();
    const credSync = getCredentialSyncState();
    const isPhrase = /\s/.test(String(text || '').trim());
    const standalone = !!String(text || '').trim() && !isPhrase && !String(sentence || context || '').trim();
    const taskChain = isPhrase
        ? ['articlePhraseTranslation', 'articlePhraseAnalysis', 'wordAnalysis']
        : (standalone ? ['wordAnalysis'] : ['articleWordTranslation', 'articleWordTooltip', 'wordAnalysis']);
    const primaryTask = isPhrase ? 'articlePhraseTranslation' : (standalone ? 'wordAnalysis' : 'articleWordTranslation');
    const chosenSpec = getPreferredTaskSpec(taskChain);
    const normalized = normalizeModelSpec(chosenSpec);
    const thinking = resolveThinkingLevel(primaryTask).level;

    let resolutionStatus = 'ready';
    let resolutionErrorCode = '';
    let resolvedProvider = null;

    try {
        resolvedProvider = resolveAIRequestConfig({ task: primaryTask, model: chosenSpec });
    } catch (err) {
        resolutionStatus = 'error';
        resolutionErrorCode = err?.code || 'model_not_selected';
    }

    const providers = [];
    const missingLocalKeyProviders = [];
    for (const [id, prov] of Object.entries(profile.providers || {})) {
        if (prov.enabled === false) continue;
        const keyStatus = getProviderKeyStatus(id);
        const requiresAuth = prov.authMode && prov.authMode !== 'none';
        const missingKey = requiresAuth && !keyStatus.hasKey;
        const entry = {
            id,
            label: prov.label || prov.name || id,
            source: 'personal',
            format: prov.format || 'openai-chat',
            apiUrl: prov.apiUrl || '',
            syncMode: keyStatus.mode,
            hasKey: keyStatus.hasKey,
            missingKey,
            credentialState: keyStatus.lastError === 'binding_mismatch' ? 'binding-mismatch'
                : (keyStatus.lastError?.startsWith('download_failed:') ? 'download-failed'
                    : (keyStatus.hasKey ? 'available' : 'missing')),
            lastError: keyStatus.lastError || ''
        };
        providers.push(entry);
        if (missingKey) missingLocalKeyProviders.push(entry);
    }

    for (const mProv of catalog.providers || []) {
        if (mProv.enabled === false) continue;
        providers.push({
            id: mProv.id,
            label: mProv.name || mProv.id,
            source: 'managed',
            format: mProv.format || 'openai-chat',
            apiUrl: mProv.apiUrl || '',
            syncMode: 'managed-memory',
            hasKey: false,
            missingKey: false
        });
    }

    const selectedPersonalMissingKey = !!(
        normalized.provider
        && profile.providers[normalized.provider]
        && !getProviderKeyStatus(normalized.provider).hasKey
        && (profile.providers[normalized.provider].authMode || 'bearer') !== 'none'
    );
    if (resolutionErrorCode === 'ai_key_missing'
        && getProviderKeyStatus(normalized.provider).lastError === 'binding_mismatch') {
        resolutionErrorCode = 'ai_key_binding_mismatch';
    }

    return {
        endpoint,
        loggedIn: authSnap.loggedIn,
        userId: authSnap.userId || '',
        label: authSnap.label || authSnap.userId || '',
        role: authSnap.role || '',
        generation: authSnap.generation,
        scope: {
            endpoint: scope.endpoint,
            userId: scope.userId,
            guest: scope.guest,
            key: scope.key
        },
        catalog: {
            status: catalog.status,
            usable: catalog.usable,
            version: catalog.version,
            providerCount: (catalog.providers || []).length
        },
        credentialSync: {
            status: credSync.status,
            error: credSync.error
        },
        taskResolution: {
            task: primaryTask,
            spec: chosenSpec,
            provider: resolvedProvider?.provider || normalized.provider || '',
            providerLabel: resolvedProvider?.label || normalized.provider || '',
            source: resolvedProvider?.source || '',
            model: resolvedProvider?.model || normalized.model || '',
            thinking,
            status: resolutionStatus,
            errorCode: resolutionErrorCode,
            selectedPersonalMissingKey
        },
        providers,
        missingLocalKeyProviders
    };
}

/**
 * Execute contextual lookup in the trusted extension context while guarding
 * against account switches / logout / endpoint changes during the in-flight request.
 */
export async function runExtensionLookup({
    text = '',
    sentence = '',
    context = '',
    locale,
    signal,
    noCache = false
} = {}) {
    const capturedSession = captureAuthSession();
    const capturedScope = getActiveAIScope();
    const ac = new AbortController();
    const onAbort = () => ac.abort(signal && signal.reason);
    if (signal) {
        if (signal.aborted) ac.abort(signal.reason);
        else signal.addEventListener('abort', onAbort, { once: true });
    }
    const onAuthChange = () => {
        if (!isAuthSessionCurrent(capturedSession)) {
            try { ac.abort(new DOMException('Session changed', 'AbortError')); } catch (_) { ac.abort(); }
        }
    };
    try {
        if (typeof window !== 'undefined') window.addEventListener(AUTH_EVENT, onAuthChange);
        if (getExtensionReadiness({ text, sentence, context }).taskResolution.errorCode === 'ai_key_binding_mismatch') {
            throw Object.assign(new Error(t('errors.aiKeyBindingMismatch')), { code: 'ai_key_binding_mismatch' });
        }
        const result = await lookupSelection({
            text,
            sentence,
            context,
            locale: locale || getLocale(),
            signal: ac.signal,
            noCache
        });
        if (!isAuthSessionCurrent(capturedSession) || profileKeyForScope(getActiveAIScope()) !== capturedScope.key) {
            const err = new Error(t('extension.staleLookupDiscarded'));
            err.code = 'stale_session';
            throw err;
        }
        return result;
    } finally {
        if (signal) signal.removeEventListener('abort', onAbort);
        try {
            if (typeof window !== 'undefined') window.removeEventListener(AUTH_EVENT, onAuthChange);
        } catch (_) {}
    }
}

export {
    lookupSelection,
    verifySession,
    getAuthSnapshot,
    captureAuthSession,
    isAuthSessionCurrent
};

export function stopExtensionRuntimeTimers() {
    try { destroyAICatalog(); } catch (_) {}
    try { stopCredentialSync(); } catch (_) {}
    runtimeInitialized = false;
}
