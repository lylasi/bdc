import {
    API_URL,
    API_KEY,
    AI_PROVIDERS as __AI_PROVIDERS__,
    AI_PROFILES as __AI_PROFILES__,
    AI_TASKS as __AI_TASKS__,
    AI_MODELS as __AI_MODELS__,
    OCR_CONFIG,
    ARTICLE_IMPORT,
    QA_CHECK,
    ASSISTANT as __ASSISTANT__
} from '../ai-config.js';
import {
    loadGlobalSettings,
    loadGlobalSecrets,
    saveGlobalSettings
} from './settings.js';
import { getCached, setCached } from './cache.js';

const STATIC_AI_PROVIDERS = (__AI_PROVIDERS__ && typeof __AI_PROVIDERS__ === 'object')
    ? __AI_PROVIDERS__
    : ((__AI_PROFILES__ && typeof __AI_PROFILES__ === 'object') ? __AI_PROFILES__ : {});
const STATIC_LEGACY_AI_MODELS = (__AI_MODELS__ && typeof __AI_MODELS__ === 'object') ? __AI_MODELS__ : {};
const STATIC_AI_TASKS = (__AI_TASKS__ && typeof __AI_TASKS__ === 'object') ? __AI_TASKS__ : STATIC_LEGACY_AI_MODELS;
const ASSISTANT = __ASSISTANT__ || {};

const TASK_ALIASES = {
    qaCheck: 'qaChecking',
    answerChecking: 'qaChecking',
    ocr: 'imageOCR'
};

export const MODEL_DISCOVERY_TTL_MS = 24 * 60 * 60 * 1000;

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
        const provider = firstNonEmptyString(spec.provider, spec.profile);
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

function getTaskMappingValue(record, taskName) {
    if (!isPlainObject(record)) return undefined;
    for (const key of getTaskLookupKeys(taskName)) {
        if (Object.prototype.hasOwnProperty.call(record, key) && hasModelSpec(record[key])) {
            return record[key];
        }
    }
    return undefined;
}

function uniqStrings(values = []) {
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

function trimTrailingSlash(url = '') {
    return String(url || '').trim().replace(/\/+$/, '');
}

function joinUrl(baseUrl = '', suffix = '') {
    const base = trimTrailingSlash(baseUrl);
    if (!base) return '';
    return `${base}${suffix}`;
}

export function extractBaseUrlFromApiUrl(apiUrl = '') {
    const raw = String(apiUrl || '').trim();
    if (!raw) return '';
    const normalized = raw.replace(/\/+$/, '');
    return normalized.replace(/\/(v\d+\/)?chat\/completions$/i, '') || normalized;
}

export function deriveApiUrl(provider = {}) {
    const explicit = firstNonEmptyString(provider.apiUrl);
    if (explicit) return explicit;
    const base = firstNonEmptyString(provider.baseUrl, extractBaseUrlFromApiUrl(provider.apiUrl));
    return base ? joinUrl(base, '/chat/completions') : '';
}

export function deriveModelsUrl(provider = {}) {
    const explicit = firstNonEmptyString(provider.modelsUrl);
    if (explicit) return explicit;
    const base = firstNonEmptyString(provider.baseUrl, extractBaseUrlFromApiUrl(provider.apiUrl));
    return base ? joinUrl(base, '/v1/models') : '';
}

function normalizeAllowedModelValue(value, providerId = 'default') {
    const raw = stringifyModelSpec(value);
    if (!raw) return '';
    if (raw.includes(':')) return raw;
    return `${providerId || 'default'}:${raw}`;
}

function normalizeAllowedModels(values, providerId = 'default') {
    if (!Array.isArray(values)) return [];
    return uniqStrings(values.map((value) => normalizeAllowedModelValue(value, providerId)).filter(Boolean));
}

function normalizeDiscoveredModels(values, providerId = 'default') {
    if (!Array.isArray(values)) return [];
    return values
        .map((value) => normalizeModelEntry(value, { providerId }))
        .filter(Boolean);
}

export function getStaticProviderRegistry() {
    return {
        default: { apiUrl: API_URL, apiKey: API_KEY },
        ...STATIC_AI_PROVIDERS
    };
}

export function getStaticAITasks() {
    return { ...STATIC_AI_TASKS };
}

export function getStaticLegacyAIModels() {
    return { ...STATIC_LEGACY_AI_MODELS };
}

function normalizeProviderRecord(id, providerValue, secretValue, fallbackDefault = {}) {
    const provider = isPlainObject(providerValue) ? providerValue : {};
    const secret = isPlainObject(secretValue) ? secretValue : {};
    const merged = { ...provider, ...secret };
    const baseUrl = firstNonEmptyString(
        merged.baseUrl,
        extractBaseUrlFromApiUrl(merged.apiUrl),
        id === 'default' ? fallbackDefault.baseUrl : ''
    );
    const apiUrl = firstNonEmptyString(merged.apiUrl, deriveApiUrl({ baseUrl }), id === 'default' ? fallbackDefault.apiUrl : '');
    const modelsUrl = firstNonEmptyString(merged.modelsUrl, deriveModelsUrl({ baseUrl }), id === 'default' ? fallbackDefault.modelsUrl : '');
    const allowedModels = normalizeAllowedModels(merged.allowedModels, id);
    const discoveredModels = normalizeDiscoveredModels(merged.discoveredModels, id);
    return {
        ...merged,
        id,
        label: firstNonEmptyString(merged.label, id === 'default' ? 'default' : id),
        enabled: merged.enabled !== false,
        baseUrl,
        apiUrl,
        modelsUrl,
        apiKey: firstNonEmptyString(merged.apiKey, id === 'default' ? fallbackDefault.apiKey : ''),
        allowedModels,
        discoveredModels,
        lastDiscoveryAt: firstNonEmptyString(merged.lastDiscoveryAt),
        discoveryStatus: firstNonEmptyString(merged.discoveryStatus),
        discoveryError: typeof merged.discoveryError === 'string' ? merged.discoveryError : ''
    };
}

export function getAIProviderRegistry({ settings, secrets } = {}) {
    const s = settings || loadGlobalSettings();
    const sec = secrets || loadGlobalSecrets();
    const staticProviders = getStaticProviderRegistry();
    const localProviders = isPlainObject(s?.ai?.providers) ? s.ai.providers : {};
    const secretProviders = isPlainObject(sec?.aiProviders) ? sec.aiProviders : {};
    const defaultSeed = {
        ...(isPlainObject(staticProviders.default) ? staticProviders.default : {}),
        ...(isPlainObject(localProviders.default) ? localProviders.default : {}),
        ...(isPlainObject(secretProviders.default) ? secretProviders.default : {}),
        apiUrl: firstNonEmptyString(localProviders?.default?.apiUrl, s?.ai?.apiUrl, staticProviders.default?.apiUrl, API_URL),
        apiKey: firstNonEmptyString(secretProviders?.default?.apiKey, sec?.aiApiKey, staticProviders.default?.apiKey, API_KEY)
    };
    const fallbackDefault = normalizeProviderRecord('default', defaultSeed, defaultSeed, {
        baseUrl: extractBaseUrlFromApiUrl(defaultSeed.apiUrl),
        apiUrl: defaultSeed.apiUrl,
        apiKey: defaultSeed.apiKey,
        modelsUrl: deriveModelsUrl(defaultSeed)
    });
    const providerIds = new Set([
        'default',
        ...Object.keys(staticProviders),
        ...Object.keys(localProviders),
        ...Object.keys(secretProviders)
    ]);
    const providers = {};
    for (const id of providerIds) {
        const seed = {
            ...(isPlainObject(staticProviders[id]) ? staticProviders[id] : {}),
            ...(isPlainObject(localProviders[id]) ? localProviders[id] : {})
        };
        const secret = isPlainObject(secretProviders[id]) ? secretProviders[id] : {};
        providers[id] = normalizeProviderRecord(id, seed, secret, fallbackDefault);
    }
    providers.default = normalizeProviderRecord('default', defaultSeed, defaultSeed, fallbackDefault);
    return providers;
}

export function listAIProviders({ settings, secrets, includeDisabled = true } = {}) {
    const providers = Object.values(getAIProviderRegistry({ settings, secrets }));
    const filtered = includeDisabled ? providers : providers.filter((provider) => provider.enabled !== false);
    return filtered.sort((a, b) => {
        if (a.id === 'default') return -1;
        if (b.id === 'default') return 1;
        return String(a.label || a.id).localeCompare(String(b.label || b.id));
    });
}

export function getProviderConnection(providerId, { settings, secrets } = {}) {
    const providers = getAIProviderRegistry({ settings, secrets });
    const pid = firstNonEmptyString(providerId) || 'default';
    const provider = isPlainObject(providers[pid]) ? providers[pid] : {};
    const fallback = isPlainObject(providers.default) ? providers.default : {};
    return {
        provider: pid,
        profile: pid,
        baseUrl: firstNonEmptyString(provider.baseUrl, pid === 'default' ? '' : fallback.baseUrl),
        apiUrl: firstNonEmptyString(provider.apiUrl, pid === 'default' ? '' : fallback.apiUrl, API_URL),
        apiKey: firstNonEmptyString(provider.apiKey, pid === 'default' ? '' : fallback.apiKey, API_KEY),
        modelsUrl: firstNonEmptyString(provider.modelsUrl, pid === 'default' ? '' : fallback.modelsUrl)
    };
}

function getLocalTaskMappingValue(taskName = 'default', settings) {
    const s = settings || loadGlobalSettings();
    const localModels = isPlainObject(s?.ai?.models) ? s.ai.models : {};
    const localTasks = isPlainObject(s?.ai?.tasks) ? s.ai.tasks : {};
    return getTaskMappingValue(localModels, taskName)
        ?? getTaskMappingValue(localTasks, taskName);
}

function getStaticTaskMappingValue(taskName = 'default') {
    return getTaskMappingValue(STATIC_AI_TASKS, taskName)
        ?? getTaskMappingValue(STATIC_LEGACY_AI_MODELS, taskName);
}

export function getStoredTaskModel(taskName = 'default', { settings } = {}) {
    return getLocalTaskMappingValue(taskName, settings) ?? '';
}

export function resolveAITaskSpec(taskName = 'default', { settings, override } = {}) {
    if (hasModelSpec(override)) return override;
    return getLocalTaskMappingValue(taskName, settings)
        ?? getStaticTaskMappingValue(taskName)
        ?? '';
}

export function getPreferredTaskSpec(taskNames = [], { settings, override } = {}) {
    if (hasModelSpec(override)) return override;
    const s = settings || loadGlobalSettings();
    for (const taskName of taskNames) {
        const spec = getLocalTaskMappingValue(taskName, s);
        if (hasModelSpec(spec)) return spec;
    }
    for (const taskName of taskNames) {
        const spec = getStaticTaskMappingValue(taskName);
        if (hasModelSpec(spec)) return spec;
    }
    return '';
}

export function normalizeModelSpec(spec, { settings, secrets } = {}) {
    const s = settings || loadGlobalSettings();
    const sec = secrets || loadGlobalSecrets();
    if (spec && typeof spec === 'object') {
        const providerId = firstNonEmptyString(spec.provider, spec.profile);
        const provider = getProviderConnection(providerId, { settings: s, secrets: sec });
        return {
            model: firstNonEmptyString(spec.model),
            apiUrl: firstNonEmptyString(spec.apiUrl, provider.apiUrl),
            apiKey: firstNonEmptyString(spec.apiKey, provider.apiKey),
            provider: providerId || provider.provider || 'default',
            profile: providerId || provider.provider || 'default'
        };
    }
    const raw = stringifyModelSpec(spec);
    const hasPrefix = raw.includes(':');
    const providerId = hasPrefix ? raw.slice(0, raw.indexOf(':')) : null;
    const provider = getProviderConnection(providerId, { settings: s, secrets: sec });
    return {
        model: hasPrefix ? raw.slice(raw.indexOf(':') + 1) : raw,
        apiUrl: provider.apiUrl,
        apiKey: provider.apiKey,
        provider: providerId || provider.provider || 'default',
        profile: providerId || provider.provider || 'default'
    };
}

export function resolveAIRequestConfig({ task = 'default', model, apiUrl, apiKey, provider, profile, settings, secrets } = {}) {
    const s = settings || loadGlobalSettings();
    const sec = secrets || loadGlobalSecrets();
    const chosenSpec = hasModelSpec(model) ? model : resolveAITaskSpec(task, { settings: s });
    const explicitProvider = firstNonEmptyString(provider, profile, chosenSpec && typeof chosenSpec === 'object' ? firstNonEmptyString(chosenSpec.provider, chosenSpec.profile) : '');
    const resolvedModel = normalizeModelSpec(chosenSpec, { settings: s, secrets: sec });
    const resolvedProvider = explicitProvider ? getProviderConnection(explicitProvider, { settings: s, secrets: sec }) : null;
    return {
        task: normalizeTaskName(task),
        spec: chosenSpec,
        model: resolvedModel.model,
        provider: explicitProvider || resolvedModel.provider || 'default',
        profile: explicitProvider || resolvedModel.provider || 'default',
        apiUrl: firstNonEmptyString(apiUrl, resolvedProvider?.apiUrl, resolvedModel.apiUrl),
        apiKey: firstNonEmptyString(apiKey, resolvedProvider?.apiKey, resolvedModel.apiKey)
    };
}

export function normalizeModelEntry(raw, { providerId = 'default' } = {}) {
    if (!raw) return null;

    const parseValue = (value, fallbackProviderId) => {
        const spec = String(value || '').trim();
        if (!spec) return null;
        if (!spec.includes(':')) {
            return {
                providerId: fallbackProviderId || 'default',
                id: spec,
                value: `${fallbackProviderId || 'default'}:${spec}`
            };
        }
        const idx = spec.indexOf(':');
        const parsedProviderId = spec.slice(0, idx).trim() || fallbackProviderId || 'default';
        const parsedId = spec.slice(idx + 1).trim();
        if (!parsedId) return null;
        return {
            providerId: parsedProviderId,
            id: parsedId,
            value: `${parsedProviderId}:${parsedId}`
        };
    };

    if (typeof raw === 'string') {
        const parsed = parseValue(raw, providerId);
        if (!parsed) return null;
        return {
            id: parsed.id,
            providerId: parsed.providerId,
            value: parsed.value,
            label: parsed.id,
            ownedBy: '',
            raw
        };
    }
    if (!isPlainObject(raw)) return null;

    const explicitProviderId = firstNonEmptyString(raw.providerId, raw.provider, raw.profile, providerId);
    const parsedValue = parseValue(firstNonEmptyString(raw.value), explicitProviderId);
    const parsedId = parseValue(firstNonEmptyString(raw.id, raw.model, raw.name, raw.slug, raw.key), explicitProviderId);
    const resolved = parsedValue || parsedId;
    if (!resolved) return null;

    return {
        id: resolved.id,
        providerId: resolved.providerId,
        value: resolved.value,
        label: firstNonEmptyString(raw.label, raw.display_name, raw.displayName, raw.name, resolved.id),
        ownedBy: firstNonEmptyString(raw.owned_by, raw.ownedBy),
        created: raw.created,
        contextWindow: raw.context_window || raw.contextWindow || raw.max_context_length,
        raw
    };
}

function normalizeModelDiscoveryPayload(payload, { providerId = 'default' } = {}) {
    let items = [];
    if (Array.isArray(payload)) {
        items = payload;
    } else if (Array.isArray(payload?.data)) {
        items = payload.data;
    } else if (Array.isArray(payload?.models)) {
        items = payload.models;
    } else if (isPlainObject(payload)) {
        for (const value of Object.values(payload)) {
            if (Array.isArray(value)) items.push(...value);
        }
    }
    const seen = new Set();
    const out = [];
    for (const item of items) {
        const normalized = normalizeModelEntry(item, { providerId });
        if (!normalized || seen.has(normalized.value)) continue;
        seen.add(normalized.value);
        out.push(normalized);
    }
    return out;
}

async function readModelDiscoveryCache(cacheKey) {
    const cached = await getCached('aiProviderModels', cacheKey);
    return isPlainObject(cached) ? cached : null;
}

async function writeModelDiscoveryCache(cacheKey, models = []) {
    await setCached('aiProviderModels', cacheKey, {
        updatedAt: Date.now(),
        models
    }, 0);
}

function buildModelDiscoveryHeaders(apiKey = '') {
    const headers = { Accept: 'application/json' };
    const key = firstNonEmptyString(apiKey);
    if (!key) return headers;
    headers.Authorization = `Bearer ${key}`;
    headers['x-api-key'] = key;
    return headers;
}

function describeDiscoveryError(error) {
    if (!error) return '模型清單抓取失敗';
    if (error.name === 'AbortError') return '模型清單抓取已取消';
    if (error instanceof SyntaxError) return '模型清單回傳格式無法解析';
    if (typeof error.message === 'string' && error.message.trim()) return error.message.trim();
    return '模型清單抓取失敗';
}

export async function discoverProviderModels(providerId, { settings, secrets, refresh = false, signal, ttlMs = MODEL_DISCOVERY_TTL_MS } = {}) {
    const s = settings || loadGlobalSettings();
    const sec = secrets || loadGlobalSecrets();
    const provider = getProviderConnection(providerId, { settings: s, secrets: sec });
    const cacheKey = {
        providerId: provider.provider,
        modelsUrl: provider.modelsUrl,
        apiUrl: provider.apiUrl,
        schema: 'v1'
    };
    const cached = await readModelDiscoveryCache(cacheKey);
    const cachedModels = Array.isArray(cached?.models) ? cached.models : [];
    const cachedUpdatedAt = Number(cached?.updatedAt || 0);
    const isFresh = !!(cachedUpdatedAt && (Date.now() - cachedUpdatedAt) < ttlMs);

    if (!refresh && cachedModels.length && isFresh) {
        return {
            ok: true,
            source: 'cache',
            models: cachedModels,
            updatedAt: cachedUpdatedAt,
            providerId: provider.provider,
            error: ''
        };
    }

    if (!provider.modelsUrl) {
        return {
            ok: false,
            source: cachedModels.length ? 'stale-cache' : 'none',
            models: cachedModels,
            updatedAt: cachedUpdatedAt,
            providerId: provider.provider,
            error: '尚未設定可用的 modelsUrl'
        };
    }

    try {
        const resp = await fetch(provider.modelsUrl, {
            method: 'GET',
            signal,
            cache: refresh ? 'no-store' : 'default',
            headers: buildModelDiscoveryHeaders(provider.apiKey)
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const payload = await resp.json();
        const models = normalizeModelDiscoveryPayload(payload, { providerId: provider.provider });
        if (!models.length) throw new Error('模型清單為空');
        await writeModelDiscoveryCache(cacheKey, models);
        return {
            ok: true,
            source: 'network',
            models,
            updatedAt: Date.now(),
            providerId: provider.provider,
            error: ''
        };
    } catch (error) {
        return {
            ok: false,
            source: cachedModels.length ? 'stale-cache' : 'error',
            models: cachedModels,
            updatedAt: cachedUpdatedAt,
            providerId: provider.provider,
            error: describeDiscoveryError(error)
        };
    }
}

export function getAllowedModelOptions({ settings, secrets, providerId, includeDisabledProviders = false } = {}) {
    const providers = listAIProviders({ settings, secrets, includeDisabled: true });
    const out = [];
    const seen = new Set();
    for (const provider of providers) {
        if (providerId && provider.id !== providerId) continue;
        if (!includeDisabledProviders && provider.enabled === false) continue;
        const allowedModels = normalizeAllowedModels(provider.allowedModels, provider.id);
        for (const value of allowedModels) {
            if (!value || seen.has(value)) continue;
            seen.add(value);
            const model = value.includes(':') ? value.slice(value.indexOf(':') + 1) : value;
            out.push({
                value,
                label: value,
                providerId: provider.id,
                model,
                allowed: true
            });
        }
    }
    return out;
}

function getTaskSpecificDefaultCandidates(taskName = 'default') {
    const canonical = normalizeTaskName(taskName);
    const values = [];
    const push = (value) => {
        const raw = stringifyModelSpec(value);
        if (raw) values.push(raw);
    };
    switch (canonical) {
    case 'imageOCR':
        push(OCR_CONFIG?.DEFAULT_MODEL);
        push(OCR_CONFIG?.MODEL);
        push(STATIC_AI_TASKS?.imageOCR);
        push(STATIC_AI_TASKS?.articleAnalysis);
        push(STATIC_LEGACY_AI_MODELS?.imageOCR);
        break;
    case 'qaChecking':
        push(QA_CHECK?.DEFAULT_MODEL);
        push(QA_CHECK?.MODEL);
        push(STATIC_AI_TASKS?.qaChecking);
        push(STATIC_LEGACY_AI_MODELS?.answerChecking);
        push(STATIC_LEGACY_AI_MODELS?.sentenceChecking);
        break;
    case 'assistant':
        if (Array.isArray(ASSISTANT?.MODELS)) ASSISTANT.MODELS.forEach(push);
        push(ASSISTANT?.DEFAULT_MODEL);
        push(ASSISTANT?.MODEL);
        push(STATIC_AI_TASKS?.assistant);
        push(STATIC_LEGACY_AI_MODELS?.assistant);
        push(STATIC_LEGACY_AI_MODELS?.articleAnalysis);
        break;
    case 'articleCleanup':
        if (Array.isArray(ARTICLE_IMPORT?.MODELS)) ARTICLE_IMPORT.MODELS.forEach(push);
        push(ARTICLE_IMPORT?.DEFAULT_MODEL);
        push(ARTICLE_IMPORT?.MODEL);
        push(STATIC_AI_TASKS?.articleCleanup);
        push(STATIC_AI_TASKS?.articleAnalysis);
        break;
    default:
        push(resolveAITaskSpec(canonical));
        break;
    }
    return uniqStrings(values);
}

export function getTaskModelSelection(taskName, { settings, secrets, currentValue, preferredCandidates = [], includeCurrent = true } = {}) {
    const allowedOptions = getAllowedModelOptions({ settings, secrets });
    const allowedValues = allowedOptions.map((option) => option.value);
    const allowedSet = new Set(allowedValues);
    const storedValue = getStoredTaskModel(taskName, { settings });
    const fallbackCurrent = stringifyModelSpec(currentValue);
    const effectiveCurrent = storedValue || fallbackCurrent;
    const candidates = uniqStrings([
        storedValue,
        includeCurrent ? fallbackCurrent : '',
        ...preferredCandidates.map((value) => stringifyModelSpec(value)),
        ...getTaskSpecificDefaultCandidates(taskName),
        ...allowedValues
    ]);

    let value = '';
    for (const candidate of candidates) {
        if (!candidate) continue;
        if (allowedSet.has(candidate)) {
            value = candidate;
            break;
        }
        if (includeCurrent && candidate === effectiveCurrent) {
            value = candidate;
            break;
        }
    }
    if (!value) value = allowedValues[0] || '';

    const unavailableCurrent = !!(value && !allowedSet.has(value));
    const options = unavailableCurrent
        ? [{ value, label: `${value}（目前值，未在允許清單）`, unavailable: true }, ...allowedOptions]
        : allowedOptions;

    return {
        value,
        options,
        allowedValues,
        disabled: allowedOptions.length === 0,
        unavailableCurrent
    };
}

export function saveTaskModelSelection(taskName, value, { settings } = {}) {
    const s = settings || loadGlobalSettings();
    const canonical = normalizeTaskName(taskName);
    const models = { ...(s?.ai?.models || {}) };
    const tasks = { ...(s?.ai?.tasks || {}) };
    for (const key of getTaskLookupKeys(taskName)) {
        delete models[key];
        delete tasks[key];
    }
    const normalized = stringifyModelSpec(value);
    if (normalized) {
        models[canonical] = normalized;
        tasks[canonical] = normalized;
    }
    return saveGlobalSettings({ ai: { models, tasks } });
}
