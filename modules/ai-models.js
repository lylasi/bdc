// AI provider registry, task resolution and model discovery.
//
// Two sources only:
//   1. personal providers + keys from the account/device AI profile
//   2. the admin-published managed catalog (shared keys stay in memory)
//
// There is no static provider/task fallback any more. A named provider never
// borrows another provider's URL or key.

import {
    loadAIProfile,
    updateAIProfile,
    isManagedProviderId,
    isPersonalProviderId
} from './ai-profile-storage.js';
import {
    getManagedProviders,
    getManagedProvider,
    getManagedCredential,
    getManagedTaskSpec,
    peekManagedCredential,
    isManagedUsable,
    getCatalogState
} from './ai-catalog.js';
import {
    getAdapter,
    deriveProviderEndpoints,
    fetchProviderModels,
    describeDetectionError,
    adapterCapabilities
} from './ai-protocols/index.js';
import { getCached, setCached } from './cache.js';
import { t } from './i18n.js';
import { touch as syncTouch } from './sync-signals.js';

export const MODEL_DISCOVERY_TTL_MS = 24 * 60 * 60 * 1000;

const TASK_ALIASES = {
    qaCheck: 'qaChecking',
    answerChecking: 'qaChecking',
    ocr: 'imageOCR'
};

const TASK_CAPABILITY = {
    imageOCR: 'images'
};

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function firstNonEmptyString(...vals) {
    for (const val of vals) {
        if (typeof val === 'string' && val.trim()) return val.trim();
    }
    return '';
}

export function stringifyModelSpec(spec) {
    if (!spec) return '';
    if (typeof spec === 'object') {
        const provider = firstNonEmptyString(spec.provider, spec.providerId, spec.profile);
        const model = firstNonEmptyString(spec.model);
        return provider ? `${provider}:${model}` : model;
    }
    return String(spec || '').trim();
}

export function normalizeTaskName(taskName = 'default') {
    const raw = String(taskName || 'default').trim() || 'default';
    return TASK_ALIASES[raw] || raw;
}

export function getTaskLookupKeys(taskName = 'default') {
    const canonical = normalizeTaskName(taskName);
    const keys = [canonical];
    if (canonical === 'qaChecking') keys.push('qaCheck', 'answerChecking');
    if (canonical === 'imageOCR') keys.push('ocr');
    return keys;
}

export function hasModelSpec(spec) {
    if (!spec) return false;
    if (typeof spec === 'string') return !!spec.trim();
    if (typeof spec === 'object') return !!String(spec.model || '').trim();
    return false;
}

function uniqueStrings(values = []) {
    const out = [];
    const seen = new Set();
    for (const value of values) {
        const raw = String(value || '').trim();
        if (!raw || seen.has(raw)) continue;
        seen.add(raw);
        out.push(raw);
    }
    return out;
}

function modelError(code, message, extra = {}) {
    const err = new Error(message || code);
    err.code = code;
    Object.assign(err, extra);
    return err;
}

function normalizeProviderModels(provider) {
    const allowed = Array.isArray(provider.allowedModels) ? uniqueStrings(provider.allowedModels) : [];
    const discovered = Array.isArray(provider.discoveredModels)
        ? provider.discoveredModels.map((item) => (typeof item === 'string' ? item : item && item.id)).filter(Boolean)
        : [];
    return { allowed, discovered };
}

function capabilityForTask(taskName) {
    return TASK_CAPABILITY[normalizeTaskName(taskName)] || 'text';
}

function providerSupports(provider, capability) {
    const caps = provider && provider.capabilities ? provider.capabilities : adapterCapabilities(provider?.format);
    if (!caps || !caps[capability]) return true;
    return caps[capability] !== 'no';
}

function modelCapabilityState(provider, modelId, capability) {
    const models = Array.isArray(provider?.models) ? provider.models : [];
    const entry = models.find((item) => item.id === modelId);
    const state = entry?.capabilities?.[capability];
    if (state === 'yes' || state === 'no') return state;
    const discovered = Array.isArray(provider?.discoveredModels) ? provider.discoveredModels : [];
    const disc = discovered.find((item) => item.id === modelId || item === modelId);
    if (disc && disc.capabilities && (disc.capabilities[capability] === 'yes' || disc.capabilities[capability] === 'no')) {
        return disc.capabilities[capability];
    }
    return 'unknown';
}

function isModelAllowedForProvider(provider, modelId) {
    const id = String(modelId || '').trim();
    if (!id) return false;
    if (provider.source === 'managed') {
        const models = Array.isArray(provider.models) ? provider.models : [];
        return models.some((model) => model.id === id);
    }
    const { allowed, discovered } = normalizeProviderModels(provider);
    if (allowed.length) return allowed.includes(id);
    if (discovered.length) return discovered.includes(id);
    return true;
}

function isModelUsableForTask(provider, modelId, taskName) {
    const capability = capabilityForTask(taskName);
    if (!providerSupports(provider, capability)) return false;
    const state = modelCapabilityState(provider, modelId, capability);
    return state !== 'no';
}

function personalProviders(profile) {
    const out = {};
    for (const [id, provider] of Object.entries(profile.providers)) {
        if (!isPersonalProviderId(id) || provider.enabled === false) continue;
        const credential = profile.credentials[id] || null;
        out[id] = {
            ...provider,
            id,
            source: 'personal',
            apiKey: credential && credential.apiKey ? credential.apiKey : '',
            credential: credential ? {
                version: credential.version,
                syncMode: credential.syncMode,
                binding: credential.binding,
                conflict: credential.conflict,
                pending: credential.pending,
                keyStamp: credential.keyStamp || ''
            } : null,
            binding: credential ? credential.binding : null,
            capabilities: adapterCapabilities(provider.format)
        };
    }
    return out;
}

function managedProviders() {
    const out = {};
    for (const provider of getManagedProviders({ includeDisabled: false })) {
        const cached = peekManagedCredential(provider.id);
        out[provider.id] = {
            ...provider,
            apiKey: cached && cached.apiKey ? cached.apiKey : '',
            allowedModels: provider.allowedModels || [],
            discoveredModels: (provider.models || []).map((model) => ({ id: model.id, label: model.label, capabilities: model.capabilities })),
            capabilities: adapterCapabilities(provider.format)
        };
    }
    return out;
}

export function getAIProviderRegistry() {
    const profile = loadAIProfile();
    return {
        ...personalProviders(profile),
        ...managedProviders()
    };
}

export function listAIProviders({ includeDisabled = false } = {}) {
    const registry = getAIProviderRegistry();
    const profile = loadAIProfile();
    const managedAll = includeDisabled ? getManagedProviders({ includeDisabled: true }) : [];
    const items = [];
    for (const [id, provider] of Object.entries(registry)) {
        if (includeDisabled || provider.enabled !== false) items.push(provider);
    }
    for (const provider of managedAll) {
        if (!items.some((item) => item.id === provider.id)) {
            items.push({
                ...provider,
                source: 'managed',
                apiKey: '',
                capabilities: adapterCapabilities(provider.format),
                allowedModels: provider.allowedModels || []
            });
        }
    }
    for (const [id, provider] of Object.entries(profile.providers)) {
        if (includeDisabled && !items.some((item) => item.id === id)) {
            items.push({ ...provider, source: 'personal', apiKey: '', allowedModels: provider.allowedModels || [] });
        }
    }
    return items.sort((a, b) => {
        if (a.source !== b.source) return a.source === 'personal' ? -1 : 1;
        return String(a.label || a.name || a.id).localeCompare(String(b.label || b.name || b.id));
    });
}

export function getProviderConnection(providerId) {
    const pid = firstNonEmptyString(providerId);
    const registry = getAIProviderRegistry();
    const provider = registry[pid];
    if (!provider) {
        return {
            provider: pid,
            profile: pid,
            baseUrl: '',
            apiUrl: '',
            apiKey: '',
            modelsUrl: '',
            format: '',
            authMode: '',
            source: '',
            missing: true
        };
    }
    return {
        provider: pid,
        profile: pid,
        baseUrl: provider.baseUrl || '',
        apiUrl: provider.apiUrl || '',
        apiKey: provider.apiKey || '',
        modelsUrl: provider.modelsUrl || '',
        format: provider.format || 'openai-chat',
        authMode: provider.authMode || 'bearer',
        source: provider.source || '',
        label: provider.label || provider.name || pid,
        missing: false
    };
}

function getStoredMapping(taskName, settings) {
    const profile = loadAIProfile();
    for (const key of getTaskLookupKeys(taskName)) {
        if (Object.prototype.hasOwnProperty.call(profile.taskModels, key)) {
            const value = profile.taskModels[key];
            if (hasModelSpec(value)) return value;
        }
    }
    // Settings mirror is accepted for compatibility, but profile is authoritative.
    const mirror = settings && isPlainObject(settings.ai) ? settings.ai : null;
    if (mirror) {
        const models = isPlainObject(mirror.models) ? mirror.models : {};
        const tasks = isPlainObject(mirror.tasks) ? mirror.tasks : {};
        for (const key of getTaskLookupKeys(taskName)) {
            if (hasModelSpec(models[key])) return models[key];
            if (hasModelSpec(tasks[key])) return tasks[key];
        }
    }
    return '';
}

export function getStoredTaskModel(taskName = 'default', { settings } = {}) {
    return getStoredMapping(taskName, settings);
}

function getPersonalDefaultSpec() {
    const profile = loadAIProfile();
    const spec = String(profile.defaultModel || '').trim();
    if (!spec) return '';
    const resolution = splitSpec(spec);
    const provider = profile.providers[resolution.providerId];
    if (!provider || provider.enabled === false) return '';
    if (!isModelAllowedForProvider({ ...provider, source: 'personal' }, resolution.model)) return '';
    return spec;
}

function getManagedTaskSpecSafe(taskName) {
    if (!isManagedUsable()) return '';
    return getManagedTaskSpec(normalizeTaskName(taskName));
}

/**
 * Explicit task selection > personal default > admin task default.
 * An explicit selection is never silently replaced when it becomes unavailable.
 */
export function resolveAITaskSpec(taskName = 'default', { settings } = {}) {
    const stored = getStoredMapping(taskName, settings);
    if (hasModelSpec(stored)) {
        const resolution = splitSpec(stringifyModelSpec(stored));
        if (resolution.providerId === 'default') {
            return getManagedTaskSpecSafe(taskName) || stored;
        }
        return stored;
    }
    const personal = getPersonalDefaultSpec();
    if (personal && isModelUsableForTask(getAIProviderRegistry()[splitSpec(personal).providerId] || {}, splitSpec(personal).model, taskName)) {
        return personal;
    }
    return getManagedTaskSpecSafe(taskName);
}

export function getPreferredTaskSpec(taskNames = [], { settings, override } = {}) {
    if (hasModelSpec(override)) return override;
    for (const taskName of taskNames) {
        const stored = getStoredMapping(taskName, settings);
        if (hasModelSpec(stored)) {
            const resolution = splitSpec(stringifyModelSpec(stored));
            if (resolution.providerId === 'default') {
                const managed = getManagedTaskSpecSafe(taskName);
                if (managed) return managed;
                continue;
            }
            return stored;
        }
    }
    const personal = getPersonalDefaultSpec();
    if (personal) return personal;
    for (const taskName of taskNames) {
        const managed = getManagedTaskSpecSafe(taskName);
        if (managed) return managed;
    }
    return '';
}

function splitSpec(spec) {
    if (spec && typeof spec === 'object') {
        return {
            providerId: firstNonEmptyString(spec.provider, spec.providerId, spec.profile),
            model: firstNonEmptyString(spec.model)
        };
    }
    const raw = String(spec || '').trim();
    const index = raw.indexOf(':');
    if (index === -1) return { providerId: '', model: raw };
    return {
        providerId: raw.slice(0, index).trim(),
        model: raw.slice(index + 1).trim()
    };
}

function findProviderForModel(model) {
    const id = String(model || '').trim();
    if (!id) return '';
    const profile = loadAIProfile();
    const personalDefault = splitSpec(profile.defaultModel || '');
    if (personalDefault.model === id && profile.providers[personalDefault.providerId]?.enabled !== false) {
        return personalDefault.providerId;
    }
    const candidates = Object.entries(profile.providers)
        .filter(([, provider]) => provider.enabled !== false && isModelAllowedForProvider({ ...provider, source: 'personal' }, id))
        .map(([providerId]) => providerId);
    if (candidates.length === 1) return candidates[0];
    return '';
}

function bindingMatchesProvider(credential, provider) {
    if (!credential || !credential.binding) return false;
    const binding = credential.binding;
    return String(binding.format || '') === String(provider.format || '')
        && String(binding.apiUrl || '') === String(provider.apiUrl || '')
        && String(binding.modelsUrl || '') === String(provider.modelsUrl || '')
        && String(binding.authMode || '') === String(provider.authMode || '');
}

export function normalizeModelSpec(spec, { task = 'default' } = {}) {
    const split = splitSpec(spec);
    let providerId = split.providerId;
    const model = split.model;
    if (providerId === 'default') {
        const managed = getManagedTaskSpecSafe(task);
        providerId = splitSpec(managed).providerId;
    }
    if (!providerId) providerId = findProviderForModel(model);
    const provider = getAIProviderRegistry()[providerId] || null;
    return {
        model,
        apiUrl: provider ? provider.apiUrl : '',
        apiKey: provider ? (provider.apiKey || '') : '',
        provider: providerId || 'default',
        profile: providerId || 'default',
        source: provider ? provider.source : '',
        format: provider ? provider.format : '',
        authMode: provider ? provider.authMode : '',
        missingProvider: !provider
    };
}

/**
 * Synchronous resolution for UI / cache keys. Managed shared keys are fetched
 * asynchronously by resolveAIRequestConfigAsync; this function never returns a
 * shared key it does not already have in memory.
 */
export function resolveAIRequestConfig({ task = 'default', model, apiUrl, apiKey, provider, profile, settings } = {}) {
    const canonicalTask = normalizeTaskName(task);
    const chosenSpec = hasModelSpec(model) ? model : resolveAITaskSpec(canonicalTask, { settings });
    if (!hasModelSpec(chosenSpec)) throw modelError('model_not_selected', 'no model selected');
    const split = splitSpec(chosenSpec);
    let providerId = firstNonEmptyString(provider, profile, split.providerId);
    if (providerId === 'default') providerId = splitSpec(getManagedTaskSpecSafe(canonicalTask)).providerId;
    if (!providerId) providerId = findProviderForModel(split.model);
    if (!providerId) throw modelError('model_provider_missing', 'no provider for model', { model: split.model });

    const registry = getAIProviderRegistry();
    const record = registry[providerId];
    if (!record || record.enabled === false) {
        const known = loadAIProfile().providers[providerId] || getManagedProvider(providerId);
        throw modelError(known ? 'provider_disabled' : 'provider_missing', 'provider unavailable', { providerId });
    }
    if (!isModelAllowedForProvider(record, split.model)) {
        throw modelError('model_not_allowed', 'model not allowed for provider', { providerId, model: split.model });
    }
    if (!isModelUsableForTask(record, split.model, canonicalTask)) {
        throw modelError('model_not_capable', 'model lacks required capability', { providerId, model: split.model });
    }
    if (!record.apiUrl) throw modelError('provider_endpoint_missing', 'provider endpoint missing', { providerId });

    // Task-level URL/key overrides are rejected: they could send a shared key
    // to an arbitrary host.
    if (firstNonEmptyString(apiUrl) && firstNonEmptyString(apiUrl) !== record.apiUrl) {
        throw modelError('task_override_rejected', 'endpoint override rejected', { providerId });
    }
    if (firstNonEmptyString(apiKey) && firstNonEmptyString(apiKey) !== record.apiKey) {
        throw modelError('task_override_rejected', 'key override rejected', { providerId });
    }

    let resolvedKey = record.apiKey || '';
    const requiresAuth = record.authMode && record.authMode !== 'none';
    if (record.source === 'personal' && requiresAuth) {
        const credential = record.credential;
        if (!credential || !record.apiKey) {
            throw modelError('ai_key_missing', 'personal key missing', { providerId });
        }
        if (credential.bindingVerified === false || !bindingMatchesProvider(credential, record)) {
            throw modelError('ai_key_binding_mismatch', 'credential binding mismatch', { providerId });
        }
        resolvedKey = record.apiKey;
    }
    if (record.source === 'managed') {
        if (!isManagedUsable()) {
            throw modelError(
                getCatalogState().status === 'expired' ? 'managed_session_expired' : 'managed_login_required',
                'managed session unavailable',
                { providerId }
            );
        }
        if (!record.apiUrl) throw modelError('managed_provider_unavailable', 'managed provider unavailable', { providerId });
    }

    return {
        task: canonicalTask,
        spec: chosenSpec,
        model: split.model,
        provider: providerId,
        profile: providerId,
        apiUrl: record.apiUrl,
        apiKey: resolvedKey,
        modelsUrl: record.modelsUrl || '',
        authMode: record.authMode || 'bearer',
        format: record.format || 'openai-chat',
        source: record.source,
        label: record.label || record.name || providerId,
        binding: record.source === 'personal' ? (record.credential ? record.credential.binding : null) : null,
        requiresManagedCredential: record.source === 'managed' && requiresAuth
    };
}

/** Async resolution used by every AI request: fetches a managed key on demand. */
export async function resolveAIRequestConfigAsync(options = {}) {
    const config = resolveAIRequestConfig(options);
    if (!config.requiresManagedCredential) return config;
    const credential = await getManagedCredential(config.provider);
    const expected = {
        format: config.format,
        apiUrl: config.apiUrl,
        modelsUrl: config.modelsUrl,
        authMode: config.authMode
    };
    if (credential.binding && (
        credential.binding.format !== expected.format
        || credential.binding.apiUrl !== expected.apiUrl
        || credential.binding.modelsUrl !== expected.modelsUrl
        || credential.binding.authMode !== expected.authMode
    )) {
        throw modelError('managed_binding_mismatch', 'managed credential binding mismatch', { providerId: config.provider });
    }
    return { ...config, apiKey: credential.apiKey, credentialRevision: credential.credentialRevision };
}

export function normalizeModelEntry(raw, { providerId = '' } = {}) {
    if (!raw) return null;
    if (typeof raw === 'string') {
        const value = raw.trim();
        if (!value) return null;
        if (value.includes(':')) {
            const index = value.indexOf(':');
            const pid = value.slice(0, index).trim();
            const id = value.slice(index + 1).trim();
            if (!id) return null;
            return { id, providerId: pid, value: `${pid}:${id}`, label: id, ownedBy: '', raw };
        }
        return { id: value, providerId, value: providerId ? `${providerId}:${value}` : value, label: value, ownedBy: '', raw };
    }
    if (!isPlainObject(raw)) return null;
    const id = firstNonEmptyString(raw.id, raw.model, raw.name, raw.slug, raw.key);
    if (!id) return null;
    const pid = firstNonEmptyString(raw.providerId, raw.provider, raw.profile, providerId);
    return {
        id,
        providerId: pid,
        value: pid ? `${pid}:${id}` : id,
        label: firstNonEmptyString(raw.label, raw.display_name, raw.displayName, raw.name, id),
        ownedBy: firstNonEmptyString(raw.owned_by, raw.ownedBy),
        created: raw.created,
        contextWindow: raw.context_window || raw.contextWindow || raw.max_context_length,
        capabilities: isPlainObject(raw.capabilities) ? raw.capabilities : {},
        raw
    };
}

export function getAllowedModelOptions({ providerId } = {}) {
    const registry = getAIProviderRegistry();
    const out = [];
    const seen = new Set();
    for (const provider of Object.values(registry)) {
        if (providerId && provider.id !== providerId) continue;
        if (provider.enabled === false) continue;
        const { allowed, discovered } = normalizeProviderModels(provider);
        const ids = provider.source === 'managed'
            ? (provider.models || []).map((model) => model.id)
            : (allowed.length ? allowed : discovered);
        for (const id of ids) {
            const value = `${provider.id}:${id}`;
            if (!id || seen.has(value)) continue;
            seen.add(value);
            out.push({
                value,
                label: `${provider.label || provider.name || provider.id} · ${id}`,
                providerId: provider.id,
                model: id,
                source: provider.source,
                allowed: true
            });
        }
    }
    return out;
}

export function getTaskModelSelection(taskName, { currentValue, preferredCandidates = [], includeCurrent = true } = {}) {
    const canonical = normalizeTaskName(taskName);
    const registry = getAIProviderRegistry();
    const options = getAllowedModelOptions().filter((option) => {
        if (option.source === 'managed' && !isManagedUsable()) return false;
        const provider = registry[option.providerId];
        return provider && isModelUsableForTask(provider, option.model, canonical);
    });
    const optionValues = new Set(options.map((option) => option.value));
    const storedValue = stringifyModelSpec(getStoredMapping(canonical));
    const fallbackCurrent = stringifyModelSpec(currentValue);
    const effectiveCurrent = storedValue || fallbackCurrent;
    const managedDefault = getManagedTaskSpecSafe(canonical);
    const personalDefault = getPersonalDefaultSpec();
    const candidates = uniqueStrings([
        storedValue,
        includeCurrent ? fallbackCurrent : '',
        ...preferredCandidates.map((value) => stringifyModelSpec(value)),
        personalDefault,
        managedDefault,
        ...options.map((option) => option.value)
    ]);

    let value = '';
    for (const candidate of candidates) {
        if (!candidate) continue;
        if (optionValues.has(candidate)) { value = candidate; break; }
        if (includeCurrent && candidate === effectiveCurrent) { value = candidate; break; }
    }
    if (!value) value = options[0]?.value || '';

    const unavailableCurrent = !!(value && !optionValues.has(value));
    const placeholder = options.length ? [] : [{ value: '', label: t('settings.aiNoProviderConfigured'), unavailable: true }];
    const finalOptions = unavailableCurrent
        ? [{ value, label: t('settings.aiModelUnavailable', { value }), unavailable: true }, ...options]
        : (options.length ? options : placeholder);

    return {
        value,
        options: finalOptions,
        allowedValues: [...optionValues],
        disabled: options.length === 0,
        unavailableCurrent
    };
}

export function saveTaskModelSelection(taskName, value) {
    const canonical = normalizeTaskName(taskName);
    const normalized = stringifyModelSpec(value);
    const profile = updateAIProfile((draft) => {
        for (const key of getTaskLookupKeys(taskName)) {
            if (key !== canonical) delete draft.taskModels[key];
        }
        if (normalized) draft.taskModels[canonical] = normalized;
        else delete draft.taskModels[canonical];
        return draft;
    });
    try { syncTouch('aiSettings'); } catch (_) {}
    return profile;
}

export function setPersonalDefaultModel(spec) {
    const normalized = stringifyModelSpec(spec);
    const profile = updateAIProfile((draft) => {
        draft.defaultModel = normalized;
        return draft;
    });
    try { syncTouch('aiSettings'); } catch (_) {}
    return profile;
}

export function getPersonalDefaultModel() {
    return loadAIProfile().defaultModel || '';
}

function scopeCacheToken() {
    const scope = loadAIProfile().scope || {};
    return `${scope.endpoint || ''}|${scope.userId || 'device'}`;
}

function discoveryErrorText(code) {
    if (!code) return t('errors.modelListFailed');
    return describeDetectionError(code);
}

export async function discoverProviderModels(providerId, { refresh = false, signal, ttlMs = MODEL_DISCOVERY_TTL_MS } = {}) {
    const id = firstNonEmptyString(providerId);
    const provider = getAIProviderRegistry()[id];
    if (!provider) {
        return { ok: false, source: 'none', models: [], updatedAt: 0, providerId: id, error: t('errors.modelsUrlMissing') };
    }
    if (!provider.modelsUrl) {
        return { ok: false, source: 'none', models: [], updatedAt: 0, providerId: id, error: t('errors.modelsUrlMissing') };
    }
    const catalogState = getCatalogState();
    const cacheKey = {
        schema: 'v2',
        scope: scopeCacheToken(),
        providerId: id,
        source: provider.source,
        format: provider.format,
        apiUrl: provider.apiUrl,
        modelsUrl: provider.modelsUrl,
        catalogVersion: provider.source === 'managed' ? catalogState.version : 0,
        credentialVersion: provider.credential ? provider.credential.version : 0,
        keyStamp: provider.credential ? (provider.credential.keyStamp || '') : ''
    };
    const cached = await getCached('aiProviderModels', cacheKey);
    const cachedModels = Array.isArray(cached?.models) ? cached.models : [];
    const cachedUpdatedAt = Number(cached?.updatedAt || 0);
    const fresh = !!(cachedUpdatedAt && Date.now() - cachedUpdatedAt < ttlMs);
    if (!refresh && cachedModels.length && fresh) {
        return { ok: true, source: 'cache', models: cachedModels, updatedAt: cachedUpdatedAt, providerId: id, error: '' };
    }

    let apiKey = provider.apiKey || '';
    if (provider.source === 'managed') {
        try {
            const credential = await getManagedCredential(id);
            apiKey = credential.apiKey || '';
        } catch (error) {
            return {
                ok: false,
                source: cachedModels.length ? 'stale-cache' : 'none',
                models: cachedModels,
                updatedAt: cachedUpdatedAt,
                providerId: id,
                error: error && error.code ? describeDetectionError(error.code) : t('errors.modelListFailed')
            };
        }
    }

    const result = await fetchProviderModels({
        provider,
        apiKey,
        signal,
        allowCrossOrigin: provider.source === 'managed' || provider.allowCrossOriginModels === true
    });
    if (!result.ok) {
        return {
            ok: false,
            source: cachedModels.length ? 'stale-cache' : 'error',
            models: cachedModels,
            updatedAt: cachedUpdatedAt,
            providerId: id,
            error: discoveryErrorText(result.errorCode)
        };
    }
    const models = result.models.map((item) => normalizeModelEntry(item, { providerId: id })).filter(Boolean);
    await setCached('aiProviderModels', cacheKey, { updatedAt: Date.now(), models }, 0);
    return { ok: true, source: 'network', models, updatedAt: Date.now(), providerId: id, error: '' };
}

// Compatibility shims: static AI configuration no longer exists.
export function getStaticProviderRegistry() {
    return {};
}

export function getStaticAITasks() {
    return {};
}

export function getStaticLegacyAIModels() {
    return {};
}

export function extractBaseUrlFromApiUrl(apiUrl = '') {
    const raw = String(apiUrl || '').trim();
    if (!raw) return '';
    return raw.replace(/\/+$/, '').replace(/\/chat\/completions$/i, '') || raw;
}

export function deriveApiUrl(provider = {}) {
    try {
        return deriveProviderEndpoints({
            format: provider.format || 'openai-chat',
            baseUrl: provider.baseUrl,
            apiUrl: provider.apiUrl,
            modelsUrl: provider.modelsUrl
        }).apiUrl;
    } catch (_) {
        return firstNonEmptyString(provider.apiUrl);
    }
}

export function deriveModelsUrl(provider = {}) {
    try {
        return deriveProviderEndpoints({
            format: provider.format || 'openai-chat',
            baseUrl: provider.baseUrl,
            apiUrl: provider.apiUrl,
            modelsUrl: provider.modelsUrl
        }).modelsUrl;
    } catch (_) {
        return firstNonEmptyString(provider.modelsUrl);
    }
}

export function getProviderFormatInfo(format) {
    const adapter = getAdapter(format);
    return adapter ? { id: adapter.id, capabilities: { ...adapter.capabilities }, authModes: [...adapter.authModes], defaultAuthMode: adapter.defaultAuthMode } : null;
}

export { isManagedProviderId, isPersonalProviderId };
