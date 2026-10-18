// Snapshot sanitisation for personal AI settings.
//
// Snapshots may only carry personal provider *definitions* (no keys), user task
// selections and the personal default model. Managed provider definitions can
// never arrive through a snapshot; only references to `managed-...` IDs/models
// are allowed.

import { isPersonalProviderId, sanitizeStoredUrl } from './ai-profile-storage.js';

const FORMATS = new Set(['openai-chat', 'anthropic-messages', 'gemini']);
const AUTH_MODES = new Set(['bearer', 'x-api-key', 'google', 'none']);
const CAPABILITY_KEYS = ['text', 'images', 'json', 'stream', 'models'];

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
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

export function sanitizeDiscoveredModels(values) {
    if (!Array.isArray(values)) return [];
    const out = [];
    const seen = new Set();
    for (const item of values) {
        const id = String(typeof item === 'string' ? item : (item && (item.id || item.model)) || '').trim();
        if (!id || seen.has(id) || id.length > 200) continue;
        seen.add(id);
        const entry = { id, label: String((item && item.label) || id).slice(0, 200) };
        if (isPlainObject(item && item.capabilities)) {
            const capabilities = {};
            for (const key of CAPABILITY_KEYS) {
                const value = String(item.capabilities[key] || '');
                if (value === 'yes' || value === 'no' || value === 'unknown') capabilities[key] = value;
            }
            if (Object.keys(capabilities).length) entry.capabilities = capabilities;
        }
        out.push(entry);
    }
    return out;
}

export function sanitizePersonalProvider(id, input) {
    if (!isPersonalProviderId(id) || !isPlainObject(input)) return null;
    const prefix = `${id}:`;
    const allowedModels = uniqueStrings((Array.isArray(input.allowedModels) ? input.allowedModels : [])
        .map((value) => {
            const raw = String(value || '').trim();
            return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
        }));
    return {
        label: String(input.label || id).slice(0, 120),
        enabled: input.enabled !== false,
        format: FORMATS.has(input.format) ? input.format : 'openai-chat',
        baseUrl: sanitizeStoredUrl(input.baseUrl),
        apiUrl: sanitizeStoredUrl(input.apiUrl),
        modelsUrl: sanitizeStoredUrl(input.modelsUrl),
        authMode: AUTH_MODES.has(input.authMode) ? input.authMode : 'bearer',
        allowCrossOriginModels: input.allowCrossOriginModels === true,
        allowedModels,
        discoveredModels: sanitizeDiscoveredModels(input.discoveredModels),
        lastDiscoveryAt: typeof input.lastDiscoveryAt === 'string' ? input.lastDiscoveryAt.slice(0, 40) : '',
        discoveryStatus: ['success', 'error'].includes(input.discoveryStatus) ? input.discoveryStatus : ''
    };
}

export function sanitizeTaskMappings(record) {
    if (!isPlainObject(record)) return {};
    const out = {};
    for (const [key, value] of Object.entries(record)) {
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(key)) continue;
        let spec = '';
        if (typeof value === 'string') {
            spec = value.trim();
        } else if (isPlainObject(value)) {
            const provider = String(value.provider || value.providerId || value.profile || '').trim();
            const model = String(value.model || '').trim();
            // Endpoint/key overrides in task mappings are rejected outright.
            if (provider && model) spec = `${provider}:${model}`;
            else if (model) spec = model;
        }
        if (!spec || spec.length > 240) continue;
        if (/\s/.test(spec)) continue;
        out[key] = spec;
    }
    return out;
}

export function sanitizeAISettings(ai) {
    const source = isPlainObject(ai) ? ai : {};
    const providers = {};
    if (isPlainObject(source.providers)) {
        for (const [id, provider] of Object.entries(source.providers)) {
            const normalized = sanitizePersonalProvider(id, provider);
            if (normalized) providers[id] = normalized;
        }
    }
    const models = sanitizeTaskMappings(source.models);
    const tasks = sanitizeTaskMappings(source.tasks);
    return {
        apiUrl: '',
        providers,
        models,
        tasks: { ...models, ...tasks },
        defaultModel: typeof source.defaultModel === 'string' ? source.defaultModel.trim().slice(0, 240) : ''
    };
}
