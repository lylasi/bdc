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
    stringifyModelSpec,
    getTaskModelSelection,
    resolveAIRequestConfig,
    resolveThinkingLevel
} from './ai-models.js';
import { isThinkingLevel } from './ai-thinking.js';
import { EXTENSION_AI_TASKS, getExtensionAIChoice, saveExtensionAIChoice } from './extension-ai-preferences.js';
import { lookupSelection, getCachedLookupSelection, generateLookupExamples, resetThinkingFallbackMemory, extractPageArticle, analyzeParagraph, streamAIResponse } from './api.js';
import { sanitizeAISettings } from './ai-settings-sanitize.js';
import { getLocale, t } from './i18n.js';
import { initTTSAccountSync, syncTTSAccount } from './tts-account-sync.js';

export const EXTENSION_ENDPOINT_STORAGE_KEY = 'bdc_ext_sync_endpoint_v1';
export const EXTENSION_SESSION_BACKUP_KEY = 'bdc_ext_trusted_session_v1';

let runtimeInitialized = false;
let pendingTTSSync = Promise.resolve();

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
        initTTSAccountSync({ auto: false });
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
    pendingTTSSync = syncTTSAccount({ snapshot: data });
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
export async function syncExtensionAccountAI({ forceCatalog = true, waitForTTS = true } = {}) {
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
        refreshAICatalog({ force: forceCatalog, reason: 'extension-sync' }),
        syncCredentials({ reason: 'extension-sync' }),
        // Text lookup does not need a separate speech-service credential round trip.
        ...(waitForTTS ? [pendingTTSSync] : [])
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
export function getExtensionLookupTask({ text = '', sentence = '', context = '' } = {}) {
    if (/\s/.test(String(text || '').trim())) return 'articlePhraseTranslation';
    return String(text || '').trim() && !String(sentence || context || '').trim() ? 'wordAnalysis' : 'articleWordTranslation';
}

function taskChain(task) {
    return ({
        wordAnalysis: ['wordAnalysis'],
        articleWordTranslation: ['articleWordTranslation', 'articleWordTooltip', 'wordAnalysis'],
        articlePhraseTranslation: ['articlePhraseTranslation', 'articlePhraseAnalysis', 'wordAnalysis'],
        articleCleanup: ['articleCleanup', 'articleAnalysis', 'wordAnalysis'],
        articleParagraphTranslation: ['articleParagraphTranslation', 'articleAnalysis', 'wordAnalysis'],
        assistant: ['assistant', 'articleAnalysis', 'wordAnalysis']
    })[task] || [];
}

/** Sanitized choices for the trusted picker; no keys or connection objects. */
export function getExtensionAITaskSettings(task) {
    if (!EXTENSION_AI_TASKS.includes(task)) throw Object.assign(new Error('invalid_task'), { code: 'invalid_task' });
    const choice = getExtensionAIChoice(task);
    const model = stringifyModelSpec(getPreferredTaskSpec(taskChain(task), { override: choice.model }));
    const thinking = resolveThinkingLevel(task, { override: choice.thinking }).level;
    const selection = getTaskModelSelection(task, { includeCurrent: false });
    const options = selection.options.filter((option) => selection.allowedValues.includes(option.value));
    if (model && !selection.allowedValues.includes(model)) {
        options.unshift({ value: model, label: t('settings.aiModelUnavailable', { value: model }), unavailable: true });
    }
    if (!model) options.unshift({ value: '', label: t(options.length ? 'extension.aiChooseModel' : 'settings.aiNoProviderConfigured'), unavailable: true });
    return {
        task, model, thinking, options, allowedValues: selection.allowedValues,
        loggedIn: getAuthSnapshot().loggedIn,
        hasOverride: Object.keys(choice).length > 0,
        modelOverride: choice.model || '', thinkingOverride: choice.thinking || ''
    };
}

export function setExtensionAITaskSettings(task, { model, thinking } = {}) {
    const state = getExtensionAITaskSettings(task);
    const patch = {};
    if (model !== undefined) {
        if (!state.allowedValues.includes(model)) throw Object.assign(new Error('model_not_allowed'), { code: 'model_not_allowed' });
        patch.model = model;
    }
    if (thinking !== undefined) {
        if (!isThinkingLevel(thinking)) throw Object.assign(new Error('invalid_thinking'), { code: 'invalid_thinking' });
        patch.thinking = thinking;
    }
    saveExtensionAIChoice(task, patch);
    return getExtensionAITaskSettings(task);
}

export function resetExtensionAITaskSettings(task) {
    saveExtensionAIChoice(task, null);
    return getExtensionAITaskSettings(task);
}

export function getExtensionReadiness({ text = '', sentence = '', context = '' } = {}) {
    const authSnap = getAuthSnapshot();
    const endpoint = getExtensionSyncEndpoint();
    const scope = getActiveAIScope();
    const profile = loadAIProfile(scope);
    const catalog = getCatalogState();
    const credSync = getCredentialSyncState();
    const primaryTask = getExtensionLookupTask({ text, sentence, context });
    const choice = getExtensionAIChoice(primaryTask);
    const chosenSpec = getPreferredTaskSpec(taskChain(primaryTask), { override: choice.model });
    const normalized = normalizeModelSpec(chosenSpec);
    const thinking = resolveThinkingLevel(primaryTask, { override: choice.thinking }).level;

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
export async function readExtensionLookupCache(input = {}) {
    const session = captureAuthSession();
    const scopeKey = getActiveAIScope().key;
    if (!session.loggedIn || input.noCache) return null;
    input.signal?.throwIfAborted();
    const choice = getExtensionAIChoice(getExtensionLookupTask(input));
    const result = await getCachedLookupSelection({ ...input, includeExamples: false,
        locale: input.locale || getLocale(), model: choice.model, thinking: choice.thinking });
    input.signal?.throwIfAborted();
    if (!isAuthSessionCurrent(session) || getActiveAIScope().key !== scopeKey) {
        throw Object.assign(new Error(t('extension.staleLookupDiscarded')), { code: 'stale_session' });
    }
    return result;
}

async function withLookupSession(signal, run) {
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
        const result = await run(ac.signal, capturedScope);
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

export async function runExtensionLookup({
    text = '',
    sentence = '',
    context = '',
    locale,
    signal,
    noCache = false
} = {}) {
    return await withLookupSession(signal, async (lookupSignal) => {
        if (getExtensionReadiness({ text, sentence, context }).taskResolution.errorCode === 'ai_key_binding_mismatch') {
            throw Object.assign(new Error(t('errors.aiKeyBindingMismatch')), { code: 'ai_key_binding_mismatch' });
        }
        const choice = getExtensionAIChoice(getExtensionLookupTask({ text, sentence, context }));
        return await lookupSelection({
            text, sentence, context, locale: locale || getLocale(),
            signal: lookupSignal, noCache, includeExamples: false,
            model: choice.model, thinking: choice.thinking
        });
    });
}

export async function runExtensionLookupExamples(result, { signal } = {}) {
    return await withLookupSession(signal, async (lookupSignal, scope) => {
        if (!getAuthSnapshot().loggedIn || result?.scope?.endpoint !== (scope.endpoint || '')
            || result?.scope?.userId !== (scope.userId || '')) {
            throw Object.assign(new Error(t('extension.staleLookupDiscarded')), { code: 'stale_session' });
        }
        return await generateLookupExamples({
            text: result.text, sentence: result.sentence, context: result.context,
            meaning: result.meaning, locale: result.locale,
            model: { provider: result.provider, model: result.model }, thinking: result.thinking,
            signal: lookupSignal
        });
    });
}

export async function runExtensionArticleTask({ page, article, analyze = false, signal, onProgress } = {}) {
    const session = captureAuthSession();
    const scope = getActiveAIScope();
    if (!session.loggedIn) throw Object.assign(new Error('stale_session'), { code: 'stale_session' });
    const controller = new AbortController();
    const task = analyze ? 'articleParagraphTranslation' : 'articleCleanup';
    const locale = getLocale();
    const choice = getExtensionAIChoice(task);
    const contextSnapshot = () => {
        const profile = loadAIProfile(scope);
        return {
            choice: getExtensionAIChoice(task),
            profileConfig: { providers: profile.providers, taskModels: profile.taskModels,
                taskThinking: profile.taskThinking, defaultModel: profile.defaultModel },
            catalogVersion: getCatalogState().version,
            catalogConfig: { providers: getCatalogState().providers, tasks: getCatalogState().tasks }
        };
    };
    const context = contextSnapshot();
    const contextKey = JSON.stringify(context);
    const cacheContext = JSON.stringify(context);
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const assertCurrent = () => {
        controller.signal.throwIfAborted();
        if (!isAuthSessionCurrent(session) || getActiveAIScope().key !== scope.key) throw Object.assign(new Error('stale_session'), { code: 'stale_session' });
        if (getLocale() !== locale || JSON.stringify(contextSnapshot()) !== contextKey) {
            throw Object.assign(new Error('article_context_changed'), { code: 'article_context_changed' });
        }
    };
    const contextChanged = () => {
        try { assertCurrent(); } catch (error) { controller.abort(error); }
    };
    const contextEvents = [AUTH_EVENT, 'storage', 'bdc:ai-catalog-change', 'bdc:ai-settings-applied', 'bdc:extension-endpoint-change'];
    for (const event of contextEvents) window.addEventListener(event, contextChanged);
    document.addEventListener('bdc:locale-change', contextChanged);
    try {
        assertCurrent();
        let result;
        // Freeze preferences for this operation, including multi-block articles.
        if (!analyze) result = await extractPageArticle(structuredClone(page), { ...choice, signal: controller.signal, onProgress });
        else {
            const blocks = String(article.body || '').split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean);
            const paragraphs = new Array(blocks.length);
            const unique = new Map();
            blocks.forEach((block, index) => {
                const text = index === 0 ? block.replace(/^#\s+/, '') : block;
                if (!unique.has(text)) unique.set(text, { text, indices: [] });
                unique.get(text).indices.push(index);
            });
            const jobs = [...unique.values()];
            let next = 0, completed = 0, failure = null;
            const failedIndexes = [];
            let causeCode = '';
            onProgress?.(0, blocks.length);
            const run = async () => {
                try {
                    while (next < jobs.length && !failure) {
                        assertCurrent();
                        const job = jobs[next++];
                        const paragraph = await analyzeParagraph(job.text, { ...choice, level: 'quick', locale,
                            cacheScope: scope.key, cacheContext, signal: controller.signal });
                        assertCurrent();
                        if (paragraph.failed || !String(paragraph.chinese_translation || '').trim()) {
                            const code = paragraph.errorCode || 'empty_translation';
                            failedIndexes.push(...job.indices);
                            causeCode ||= code;
                            // Keep useful work when one paragraph has a content
                            // error. Provider/session failures still stop the batch.
                            if (['empty_translation', 'empty_response', 'provider_error', 'paragraph_translation_truncated'].includes(code)) continue;
                            throw Object.assign(new Error('page_analysis_failed'), { code: 'page_analysis_failed', causeCode: code });
                        }
                        for (const index of job.indices) paragraphs[index] = structuredClone(paragraph);
                        completed += job.indices.length;
                        onProgress?.(completed, blocks.length);
                    }
                } catch (error) {
                    if (!failure) failure = error;
                    controller.abort(error);
                }
            };
            // Keep only two paragraph jobs alive. The shared API queue still
            // applies the configured provider/model/task limit and spacing.
            await Promise.allSettled(Array.from({ length: Math.min(2, jobs.length) }, run));
            if (failure) throw failure;
            if (failedIndexes.length) throw Object.assign(new Error('page_analysis_failed'), { code: 'page_analysis_failed', failedIndexes, causeCode });
            result = { chinese_translation: paragraphs.map((paragraph) => paragraph.chinese_translation).join('\n\n'),
                paragraph_analysis: paragraphs, word_alignment: [], detailed_analysis: [], updatedAt: new Date().toISOString() };
        }
        assertCurrent();
        return result;
    } finally {
        signal?.removeEventListener('abort', abort);
        for (const event of contextEvents) window.removeEventListener(event, contextChanged);
        document.removeEventListener('bdc:locale-change', contextChanged);
    }
}

// Freeze the selected model/thinking before sending, and gate every streamed
// chunk on the captured account, just as one-shot extension tasks do.
export async function runExtensionAssistant({ messages, model, thinking, signal, onDelta, onReasoning } = {}) {
    const session = captureAuthSession();
    const scope = getActiveAIScope().key;
    if (!session.loggedIn) throw Object.assign(new Error('unauthorized'), { code: 'unauthorized' });
    const controller = new AbortController();
    const abort = () => controller.abort();
    const current = () => isAuthSessionCurrent(session) && getActiveAIScope().key === scope;
    const authChanged = () => { if (!current()) abort(); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    window.addEventListener(AUTH_EVENT, authChanged);
    try {
        controller.signal.throwIfAborted();
        const settings = getExtensionAITaskSettings('assistant');
        const result = await streamAIResponse({ messages, model: model ?? settings.model,
            thinking: thinking ?? settings.thinking, taskType: 'assistant', maxTokens: 4096,
            signal: controller.signal,
            onDelta: (text) => { if (current() && !controller.signal.aborted) onDelta?.(text); },
            onReasoning: (text) => { if (current() && !controller.signal.aborted) onReasoning?.(text); } });
        controller.signal.throwIfAborted();
        if (!current()) throw Object.assign(new Error('stale_session'), { code: 'stale_session' });
        return result;
    } finally {
        signal?.removeEventListener('abort', abort);
        window.removeEventListener(AUTH_EVENT, authChanged);
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
