// Server-side snapshot sanitisation for the AI settings group.
// Mirrors cloudflare-worker/src/snapshot-sanitize.js; keep both in sync.
//
// Defense in depth: even if a client is modified, a snapshot can never store
// shared (managed) provider definitions, API keys, endpoint overrides at task
// level, or URLs carrying credentials. The same rules are enforced in the
// browser before a push and after a pull.

const FORMATS = new Set(['openai-chat', 'anthropic-messages', 'gemini']);
const AUTH_MODES = new Set(['bearer', 'x-api-key', 'google', 'none']);
const CAPABILITY_KEYS = ['text', 'images', 'json', 'stream', 'models'];
const CREDENTIAL_QUERY_RE = /key|token|secret|auth|pass|sig/i;

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isValidPersonalProviderId(id) {
    const value = String(id || '');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) return false;
    if (value === 'default' || value.startsWith('managed-')) return false;
    return !['__proto__', 'prototype', 'constructor', 'aiApiKey'].includes(value);
}

function sanitizeUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
        const url = new URL(raw);
        if (!/^https?:$/.test(url.protocol)) return '';
        if (url.username || url.password) return '';
        url.hash = '';
        for (const key of Array.from(url.searchParams.keys())) {
            if (CREDENTIAL_QUERY_RE.test(key)) return '';
        }
        return url.toString();
    } catch (_) {
        return '';
    }
}

function uniqueStrings(values) {
    const out = [];
    const seen = new Set();
    for (const value of Array.isArray(values) ? values : []) {
        const raw = String(value || '').trim();
        if (!raw || seen.has(raw)) continue;
        seen.add(raw);
        out.push(raw.slice(0, 240));
    }
    return out;
}

function sanitizeModels(models) {
    const out = [];
    const seen = new Set();
    for (const model of Array.isArray(models) ? models : []) {
        const id = String(typeof model === 'string' ? model : (model && (model.id || model.model)) || '').trim();
        if (!id || seen.has(id) || id.length > 200) continue;
        seen.add(id);
        const entry = { id, label: String((model && model.label) || id).slice(0, 200) };
        if (model && isPlainObject(model.capabilities)) {
            const capabilities = {};
            for (const key of CAPABILITY_KEYS) {
                const value = String(model.capabilities[key] || '');
                if (value === 'yes' || value === 'no' || value === 'unknown') capabilities[key] = value;
            }
            if (Object.keys(capabilities).length) entry.capabilities = capabilities;
        }
        out.push(entry);
    }
    return out;
}

export function sanitizeSnapshotTaskMappings(record) {
    if (!isPlainObject(record)) return {};
    const out = {};
    for (const [task, value] of Object.entries(record)) {
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(task)) continue;
        let spec = '';
        if (typeof value === 'string') spec = value.trim();
        else if (isPlainObject(value)) {
            const provider = String(value.provider || value.providerId || value.profile || '').trim();
            const model = String(value.model || '').trim();
            if (provider && model) spec = `${provider}:${model}`;
            else if (model) spec = model;
        }
        if (!spec || spec.length > 240 || /\s/.test(spec)) continue;
        out[task] = spec;
    }
    return out;
}

export function sanitizeSnapshotAISettings(ai) {
    const source = isPlainObject(ai) ? ai : {};
    const providers = {};
    if (isPlainObject(source.providers)) {
        for (const [id, provider] of Object.entries(source.providers)) {
            if (!isValidPersonalProviderId(id) || !isPlainObject(provider)) continue;
            const prefix = `${id}:`;
            providers[id] = {
                label: String(provider.label || id).slice(0, 120),
                enabled: provider.enabled !== false,
                format: FORMATS.has(provider.format) ? provider.format : 'openai-chat',
                baseUrl: sanitizeUrl(provider.baseUrl),
                apiUrl: sanitizeUrl(provider.apiUrl),
                modelsUrl: sanitizeUrl(provider.modelsUrl),
                authMode: AUTH_MODES.has(provider.authMode) ? provider.authMode : 'bearer',
                allowCrossOriginModels: provider.allowCrossOriginModels === true,
                allowedModels: uniqueStrings(provider.allowedModels).map((value) => (value.startsWith(prefix) ? value.slice(prefix.length) : value)),
                discoveredModels: sanitizeModels(provider.discoveredModels),
                lastDiscoveryAt: typeof provider.lastDiscoveryAt === 'string' ? provider.lastDiscoveryAt.slice(0, 40) : '',
                discoveryStatus: ['success', 'error'].includes(provider.discoveryStatus) ? provider.discoveryStatus : ''
            };
        }
    }
    const models = sanitizeSnapshotTaskMappings(source.models);
    const tasks = sanitizeSnapshotTaskMappings(source.tasks);
    const settings = {
        apiUrl: '',
        providers,
        models,
        tasks: { ...models, ...tasks },
        defaultModel: typeof source.defaultModel === 'string' ? source.defaultModel.trim().slice(0, 240) : ''
    };
    // Account-level default for new provider keys. Leave it absent when the
    // client did not send a valid value so older snapshots do not reset a
    // newer client's policy.
    if (source.keySyncDefault === 'cloud' || source.keySyncDefault === 'local-only') {
        settings.keySyncDefault = source.keySyncDefault;
    }
    return settings;
}

/** Sanitise the AI group of a full snapshot payload, leaving other groups intact. */
export function sanitizeSnapshotPayload(payload) {
    if (!isPlainObject(payload)) return payload;
    const next = { ...payload };
    if (isPlainObject(next.aiSettings)) {
        next.aiSettings = {
            ...next.aiSettings,
            settings: sanitizeSnapshotAISettings(next.aiSettings.settings)
        };
        delete next.aiSettings.apiKey;
        delete next.aiSettings.apiProviders;
    }
    // Never carry legacy top-level AI secrets through a snapshot response.
    delete next.aiApiKey;
    delete next.aiProviders;
    return next;
}
