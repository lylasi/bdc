// Account-scoped local AI profile.
//
// One JSON document per (sync endpoint, user) plus a device/guest document:
//   bdc_ai_profile_v1:<encoded-endpoint>:<encoded-user>
//   bdc_ai_profile_v1:device:guest
//
// The profile holds personal provider definitions, per-task model selections,
// and this device's copy of personal keys + credential sync state. Managed
// (admin) shared keys are NEVER stored here. Legacy `pen_global_secrets`
// entries are migrated once, with keys kept local-only and providers disabled
// until the user confirms them.

import { SYNC } from '../ai-config.js';
import { touch as syncTouch } from './sync-signals.js';

export const AI_PROFILE_PREFIX = 'bdc_ai_profile_v1';
export const AI_PROFILE_SCHEMA_VERSION = 1;
export const GUEST_PROFILE_KEY = `${AI_PROFILE_PREFIX}:device:guest`;
export const AI_SYNC_MODES = ['cloud', 'local-only', 'cloud-removal-pending'];
// Account-level default for a *new* personal provider: follow the account
// (encrypted upload + automatic download elsewhere) or stay on this device.
export const AI_KEY_SYNC_DEFAULTS = ['cloud', 'local-only'];
export const AI_PROFILE_MIGRATION_KEY = 'bdc_ai_profile_migrated_v1';
export const AI_PROFILE_QUARANTINE_KEY = 'bdc_ai_profile_quarantine_v1';

const RESERVED_PROVIDER_IDS = new Set(['default', 'aiApiKey', '__proto__', 'prototype', 'constructor']);
const CREDENTIAL_QUERY_RE = /key|token|secret|auth|pass|sig/i;
const PROVIDER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const memoryState = { lastError: '' };

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nowIso() {
    return new Date().toISOString();
}

function clone(value) {
    try { return JSON.parse(JSON.stringify(value)); } catch (_) { return value; }
}

function safeParse(raw, fallback) {
    try { return raw ? JSON.parse(raw) : fallback; } catch (_) { return fallback; }
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

export function normalizeSyncEndpoint(endpoint) {
    const raw = String(endpoint || '').trim();
    if (!raw) return '';
    try {
        const url = new URL(raw);
        const path = url.pathname.replace(/\/+$/, '');
        return `${url.origin}${path}`;
    } catch (_) {
        return raw.replace(/\/+$/, '');
    }
}

export function getStoredSyncUserId() {
    try { return String(localStorage.getItem('sync_user_id') || '').trim(); } catch (_) { return ''; }
}

function configuredSyncEndpoint() {
    const override = (typeof globalThis !== 'undefined' && typeof globalThis.__BDC_SYNC_ENDPOINT__ === 'string')
        ? globalThis.__BDC_SYNC_ENDPOINT__
        : '';
    return normalizeSyncEndpoint(override || (SYNC && SYNC.endpoint) || '');
}

export function getActiveAIScope() {
    const endpoint = configuredSyncEndpoint();
    const userId = getStoredSyncUserId();
    if (!userId) {
        return { endpoint, userId: '', guest: true, key: GUEST_PROFILE_KEY };
    }
    return {
        endpoint,
        userId,
        guest: false,
        key: `${AI_PROFILE_PREFIX}:${encodeURIComponent(endpoint)}:${encodeURIComponent(userId)}`
    };
}

export function profileKeyForScope(scope) {
    const value = scope || getActiveAIScope();
    if (value.guest || !value.userId) return GUEST_PROFILE_KEY;
    const endpoint = normalizeSyncEndpoint(value.endpoint);
    return `${AI_PROFILE_PREFIX}:${encodeURIComponent(endpoint)}:${encodeURIComponent(value.userId)}`;
}

export function isManagedProviderId(id) {
    return String(id || '').startsWith('managed-');
}

export function isPersonalProviderId(id) {
    const value = String(id || '');
    return PROVIDER_ID_RE.test(value)
        && !RESERVED_PROVIDER_IDS.has(value)
        && !isManagedProviderId(value);
}

export function sanitizeStoredUrl(value) {
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

function normalizeCapabilities(value) {
    if (!isPlainObject(value)) return {};
    const out = {};
    for (const key of ['text', 'images', 'json', 'stream', 'models']) {
        const raw = String(value[key] || '').trim();
        if (raw === 'yes' || raw === 'no' || raw === 'unknown') out[key] = raw;
    }
    return out;
}

function normalizeDiscoveredModels(values) {
    if (!Array.isArray(values)) return [];
    const out = [];
    const seen = new Set();
    for (const item of values) {
        const id = String(typeof item === 'string' ? item : (item && (item.id || item.model)) || '').trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push({
            id,
            label: String((item && item.label) || id).slice(0, 200),
            capabilities: normalizeCapabilities(item && item.capabilities)
        });
    }
    return out;
}

function normalizeAllowedModels(values, providerId) {
    if (!Array.isArray(values)) return [];
    const prefix = `${providerId}:`;
    return uniqueStrings(values.map((value) => {
        const raw = String(value || '').trim();
        return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
    }));
}

export function normalizeStoredProvider(id, input) {
    if (!isPersonalProviderId(id) || !isPlainObject(input)) return null;
    const apiUrl = sanitizeStoredUrl(input.apiUrl);
    const modelsUrl = sanitizeStoredUrl(input.modelsUrl);
    const baseUrl = sanitizeStoredUrl(input.baseUrl);
    return {
        id,
        label: String(input.label || id).slice(0, 120),
        enabled: input.enabled !== false,
        format: String(input.format || 'openai-chat'),
        baseUrl,
        apiUrl,
        modelsUrl,
        authMode: ['bearer', 'x-api-key', 'google', 'none'].includes(input.authMode) ? input.authMode : 'bearer',
        allowCrossOriginModels: input.allowCrossOriginModels === true,
        allowedModels: normalizeAllowedModels(input.allowedModels, id),
        discoveredModels: normalizeDiscoveredModels(input.discoveredModels),
        lastDiscoveryAt: typeof input.lastDiscoveryAt === 'string' ? input.lastDiscoveryAt.slice(0, 40) : '',
        discoveryStatus: ['success', 'error'].includes(input.discoveryStatus) ? input.discoveryStatus : '',
        origin: typeof input.origin === 'string' ? input.origin.slice(0, 40) : 'personal',
        createdAt: typeof input.createdAt === 'string' ? input.createdAt : '',
        updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : ''
    };
}

export function normalizeTaskModelMap(input) {
    const out = {};
    if (!isPlainObject(input)) return out;
    for (const [task, value] of Object.entries(input)) {
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(task)) continue;
        let raw = '';
        if (typeof value === 'string') raw = value.trim();
        else if (isPlainObject(value)) {
            const provider = String(value.provider || value.providerId || value.profile || '').trim();
            const model = String(value.model || '').trim();
            if (provider && model) raw = `${provider}:${model}`;
            else if (model) raw = model;
        }
        if (!raw) continue;
        // Task-level endpoint/key overrides are never accepted.
        if (!/^[A-Za-z0-9_-]{1,64}:[^\s]{1,200}$/.test(raw) && !/^[^\s:]{1,200}$/.test(raw)) continue;
        out[task] = raw;
    }
    return out;
}

function normalizeBinding(input) {
    if (!isPlainObject(input)) return null;
    const apiUrl = sanitizeStoredUrl(input.apiUrl);
    if (!apiUrl) return null;
    return {
        formatVersion: Number(input.formatVersion || 1),
        format: String(input.format || 'openai-chat'),
        apiUrl,
        modelsUrl: sanitizeStoredUrl(input.modelsUrl),
        authMode: String(input.authMode || 'bearer')
    };
}

function normalizePending(input) {
    if (!isPlainObject(input)) return null;
    const type = input.type === 'delete' ? 'delete' : 'put';
    const mutationId = String(input.mutationId || '');
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(mutationId)) return null;
    return {
        type,
        mutationId,
        expectedVersion: Number(input.expectedVersion) || 0,
        apiKey: typeof input.apiKey === 'string' ? input.apiKey : '',
        binding: normalizeBinding(input.binding),
        // "Remove the cloud copy, keep this device" — the delete mutation must
        // not clear the local key that its own request is about to remove from
        // the server. A real delete (provider removal) leaves this false.
        keepLocalKey: input.keepLocalKey === true,
        createdAt: typeof input.createdAt === 'string' ? input.createdAt : nowIso()
    };
}

export function normalizeCredential(input) {
    if (!isPlainObject(input)) return null;
    return {
        apiKey: typeof input.apiKey === 'string' ? input.apiKey : '',
        binding: normalizeBinding(input.binding),
        version: Number(input.version) || 0,
        syncMode: AI_SYNC_MODES.includes(input.syncMode) ? input.syncMode : 'local-only',
        pending: normalizePending(input.pending),
        lastSyncedAt: typeof input.lastSyncedAt === 'string' ? input.lastSyncedAt : '',
        lastError: typeof input.lastError === 'string' ? input.lastError.slice(0, 80) : '',
        bindingVerified: input.bindingVerified !== false,
        keyStamp: typeof input.keyStamp === 'string' ? input.keyStamp.slice(0, 64) : '',
        conflict: isPlainObject(input.conflict) ? {
            remoteVersion: Number(input.conflict.remoteVersion) || 0,
            remoteDeleted: input.conflict.remoteDeleted === true,
            remoteLastMutationId: String(input.conflict.remoteLastMutationId || ''),
            detectedAt: String(input.conflict.detectedAt || nowIso())
        } : null
    };
}

export function emptyProfile(scope) {
    const value = scope || getActiveAIScope();
    return {
        schemaVersion: AI_PROFILE_SCHEMA_VERSION,
        revision: 1,
        updatedAt: '',
        scope: { endpoint: value.endpoint || '', userId: value.userId || '' },
        providers: {},
        taskModels: {},
        defaultModel: '',
        keySyncDefault: 'cloud',
        credentials: {}
    };
}

export function normalizeKeySyncDefault(value) {
    const mode = String(value || '');
    return AI_KEY_SYNC_DEFAULTS.includes(mode) ? mode : 'cloud';
}

export function normalizeProfile(input, scope) {
    const value = isPlainObject(input) ? input : {};
    const base = emptyProfile(scope);
    const providers = {};
    if (isPlainObject(value.providers)) {
        for (const [id, provider] of Object.entries(value.providers)) {
            const normalized = normalizeStoredProvider(id, provider);
            if (normalized) providers[id] = normalized;
        }
    }
    const credentials = {};
    if (isPlainObject(value.credentials)) {
        for (const [id, credential] of Object.entries(value.credentials)) {
            if (!isPersonalProviderId(id)) continue;
            const normalized = normalizeCredential(credential);
            if (normalized) credentials[id] = normalized;
        }
    }
    return {
        ...base,
        schemaVersion: AI_PROFILE_SCHEMA_VERSION,
        revision: Number(value.revision) >= 1 ? Number(value.revision) : 1,
        updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
        providers,
        taskModels: normalizeTaskModelMap(value.taskModels || value.models || value.tasks),
        defaultModel: typeof value.defaultModel === 'string' ? value.defaultModel.trim() : '',
        keySyncDefault: normalizeKeySyncDefault(value.keySyncDefault),
        credentials
    };
}

export function loadAIProfile(scope) {
    const key = profileKeyForScope(scope);
    try {
        const raw = localStorage.getItem(key);
        return normalizeProfile(raw ? JSON.parse(raw) : null, scope || getActiveAIScope());
    } catch (_) {
        return emptyProfile(scope || getActiveAIScope());
    }
}

/** Throws when the write cannot be confirmed. Never reports false success. */
export function saveAIProfile(profile, scope) {
    const key = profileKeyForScope(scope);
    const normalized = normalizeProfile(profile, scope || getActiveAIScope());
    normalized.revision = Math.max(1, Number(normalized.revision) || 1);
    const serialized = JSON.stringify(normalized);
    try {
        localStorage.setItem(key, serialized);
        const readBack = localStorage.getItem(key);
        if (!readBack) throw new Error('profile not persisted');
        const parsed = JSON.parse(readBack);
        if (Number(parsed.revision) !== normalized.revision) throw new Error('profile not persisted');
    } catch (error) {
        memoryState.lastError = 'ai_profile_save_failed';
        const err = new Error('ai_profile_save_failed');
        err.code = 'profile_save_failed';
        err.cause = error;
        throw err;
    }
    memoryState.lastError = '';
    return normalized;
}

/**
 * Read-modify-write in one synchronous block. The mutator may return a new
 * profile or mutate the draft in place. Throws if persistence fails.
 *
 * `touchUpdatedAt: false` keeps the existing `updatedAt`. The snapshot carries
 * the AI group with whole-group LWW against that value, so a write that only
 * touches this device's credential rows (downloading a key, confirming a
 * version, pausing on an error) must not claim the *definitions* are newer than
 * another device's — otherwise a device that merely downloaded a key could
 * overwrite newer provider definitions.
 */
export function updateAIProfile(mutator, scope, options = {}) {
    const touchUpdatedAt = !options || options.touchUpdatedAt !== false;
    const current = loadAIProfile(scope);
    const draft = clone(current);
    const result = typeof mutator === 'function' ? mutator(draft) : draft;
    const next = result && typeof result === 'object' ? result : draft;
    next.revision = (Number(current.revision) || 1) + 1;
    next.updatedAt = touchUpdatedAt ? nowIso() : (current.updatedAt || '');
    return saveAIProfile(next, scope);
}

export function deleteAIProfile(scope) {
    try { localStorage.removeItem(profileKeyForScope(scope)); } catch (_) {}
}

export function clearAccountAIProfiles(scope) {
    const value = scope || getActiveAIScope();
    if (value.guest) return;
    try { localStorage.removeItem(profileKeyForScope(value)); } catch (_) {}
}

export function listAIProfileKeys() {
    const keys = [];
    try {
        for (let i = 0; i < localStorage.length; i += 1) {
            const key = localStorage.key(i);
            if (key && key.startsWith(`${AI_PROFILE_PREFIX}:`)) keys.push(key);
        }
    } catch (_) {}
    return keys;
}

/** Non-secret view exposed through settings.js (`settings.ai`). */
export function getAIViewFromProfile(scope) {
    const profile = loadAIProfile(scope);
    const providers = {};
    for (const [id, provider] of Object.entries(profile.providers)) {
        providers[id] = {
            ...clone(provider),
            apiUrl: provider.apiUrl,
            modelsUrl: provider.modelsUrl
        };
    }
    return {
        apiUrl: '',
        providers,
        models: { ...profile.taskModels },
        tasks: { ...profile.taskModels },
        defaultModel: profile.defaultModel,
        keySyncDefault: normalizeKeySyncDefault(profile.keySyncDefault),
        updatedAt: profile.updatedAt || ''
    };
}

export function getAIProfileUpdatedAt(scope) {
    return loadAIProfile(scope).updatedAt || '';
}

/**
 * Apply an incoming snapshot AI group. Definitions for device-only providers
 * (credential syncMode `local-only`) are preserved; every other definition is
 * taken from the snapshot. Keys themselves never arrive through this path.
 */
/**
 * Explicitly import selected device/guest providers into the signed-in account.
 * Copies definitions and (optionally) schedules a key upload. The device copy
 * stays untouched, so the user can still use it when signed out.
 */
export function importGuestProviders(providerIds, { syncKeys = false, scope, includeSettings = true } = {}) {
    const activeScope = scope || getActiveAIScope();
    if (activeScope.guest) {
        const err = new Error('login required');
        err.code = 'managed_login_required';
        throw err;
    }
    const guestScope = {
        endpoint: configuredSyncEndpoint(),
        userId: '',
        guest: true,
        key: GUEST_PROFILE_KEY
    };
    const guest = loadAIProfile(guestScope);
    const ids = Array.isArray(providerIds) && providerIds.length
        ? providerIds
        : Object.keys(guest.providers);
    let imported = 0;
    let skipped = 0;
    const profile = updateAIProfile((draft) => {
        for (const id of ids) {
            const provider = guest.providers[id];
            if (!provider) { skipped += 1; continue; }
            if (draft.providers[id]) { skipped += 1; continue; }
            draft.providers[id] = {
                ...provider,
                origin: 'imported',
                updatedAt: nowIso()
            };
            const credential = guest.credentials[id];
            if (!credential) { imported += 1; continue; }
            const now = nowIso();
            const canSync = syncKeys && !!credential.apiKey && credential.binding;
            draft.credentials[id] = normalizeCredential({
                apiKey: credential.apiKey,
                binding: credential.binding,
                version: 0,
                syncMode: canSync ? 'cloud' : 'local-only',
                pending: canSync ? {
                    type: 'put',
                    mutationId: `import_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
                    expectedVersion: 0,
                    apiKey: credential.apiKey,
                    binding: credential.binding,
                    createdAt: now
                } : null,
                lastSyncedAt: '',
                conflict: null,
                lastError: ''
            });
            imported += 1;
        }
        if (includeSettings) {
            const available = (spec) => {
                const providerId = String(spec || '').split(':')[0];
                return !!draft.providers[providerId];
            };
            for (const [task, spec] of Object.entries(guest.taskModels || {})) {
                if (!draft.taskModels[task] && available(spec)) draft.taskModels[task] = spec;
            }
            if (!draft.defaultModel && available(guest.defaultModel)) draft.defaultModel = guest.defaultModel;
        }
        return draft;
    }, activeScope);
    try { syncTouch('aiSettings'); } catch (_) {}
    return { imported, skipped, profile };
}

export function applyRemoteAISettings(ai, updatedAt, scope) {
    const activeScope = scope || getActiveAIScope();
    const profile = loadAIProfile(activeScope);
    const localOnly = new Set(
        Object.entries(profile.credentials)
            .filter(([, credential]) => credential && credential.syncMode === 'local-only')
            .map(([id]) => id)
    );
    const remote = isPlainObject(ai) ? ai : {};
    const providers = {};
    if (isPlainObject(remote.providers)) {
        for (const [id, provider] of Object.entries(remote.providers)) {
            const normalized = normalizeStoredProvider(id, provider);
            if (normalized) providers[id] = normalized;
        }
    }
    for (const id of localOnly) {
        if (!providers[id] && profile.providers[id]) providers[id] = profile.providers[id];
    }
    profile.providers = providers;
    profile.taskModels = normalizeTaskModelMap(remote.models || remote.tasks);
    profile.defaultModel = typeof remote.defaultModel === 'string' ? remote.defaultModel.trim() : '';
    // Older snapshots have no policy field: keep this device's current value
    // instead of silently resetting it to the default.
    if (remote.keySyncDefault === 'cloud' || remote.keySyncDefault === 'local-only') {
        profile.keySyncDefault = remote.keySyncDefault;
    }
    profile.updatedAt = typeof updatedAt === 'string' && updatedAt ? updatedAt : nowIso();
    profile.revision = (Number(profile.revision) || 1) + 1;
    return saveAIProfile(profile, activeScope);
}

/**
 * Account-level "new keys follow the account" policy. It is part of the AI
 * definition group (it syncs through the snapshot); the caller is responsible
 * for `syncTouch('aiSettings')`.
 */
export function setAIKeySyncDefault(mode, scope) {
    const value = normalizeKeySyncDefault(mode);
    return updateAIProfile((profile) => {
        profile.keySyncDefault = value;
        return profile;
    }, scope);
}

/**
 * Compatibility path for `saveGlobalSettings({ ai: ... })`. Only non-secret
 * personal provider definitions, task mappings and the personal default are
 * applied; keys and sync state are untouched.
 */
export function applyAISettingsPatch(ai, scope) {
    if (!isPlainObject(ai)) return loadAIProfile(scope);
    return updateAIProfile((profile) => {
        if (isPlainObject(ai.providers)) {
            for (const [id, provider] of Object.entries(ai.providers)) {
                const normalized = normalizeStoredProvider(id, provider);
                if (!normalized) continue;
                const existing = profile.providers[id] || {};
                profile.providers[id] = {
                    ...normalized,
                    origin: existing.origin || normalized.origin,
                    createdAt: existing.createdAt || normalized.createdAt,
                    updatedAt: nowIso()
                };
            }
        }
        const hasMappings = Object.prototype.hasOwnProperty.call(ai, 'models')
            || Object.prototype.hasOwnProperty.call(ai, 'tasks');
        const mappings = normalizeTaskModelMap(ai.models || ai.tasks);
        if (hasMappings) profile.taskModels = mappings;
        if (typeof ai.defaultModel === 'string') profile.defaultModel = ai.defaultModel.trim();
        return profile;
    }, scope);
}

function readLegacyJson(key) {
    try { return safeParse(localStorage.getItem(key), {}); } catch (_) { return {}; }
}

function deriveChatEndpoints(baseUrl) {
    const base = String(baseUrl || '').replace(/\/+$/, '');
    if (!base) return { apiUrl: '', modelsUrl: '' };
    if (/\/v\d+[a-z0-9]*$/i.test(base)) {
        return { apiUrl: `${base}/chat/completions`, modelsUrl: `${base}/models` };
    }
    return { apiUrl: `${base}/v1/chat/completions`, modelsUrl: `${base}/v1/models` };
}

function inferLegacyBinding(provider) {
    const apiUrl = sanitizeStoredUrl(provider.apiUrl);
    const baseUrl = sanitizeStoredUrl(provider.baseUrl);
    const modelsUrl = sanitizeStoredUrl(provider.modelsUrl);
    if (apiUrl) {
        const format = /\/messages$/i.test(apiUrl) ? 'anthropic-messages' : 'openai-chat';
        return {
            format,
            baseUrl,
            apiUrl,
            modelsUrl,
            authMode: 'bearer'
        };
    }
    if (baseUrl) {
        const derived = deriveChatEndpoints(baseUrl);
        return {
            format: 'openai-chat',
            baseUrl,
            apiUrl: derived.apiUrl,
            modelsUrl: modelsUrl || derived.modelsUrl,
            authMode: 'bearer'
        };
    }
    return null;
}

function splitLegacySpec(spec) {
    if (typeof spec === 'string') {
        const raw = spec.trim();
        if (!raw) return { providerId: '', model: '' };
        const index = raw.indexOf(':');
        if (index === -1) return { providerId: '', model: raw };
        return { providerId: raw.slice(0, index).trim(), model: raw.slice(index + 1).trim() };
    }
    if (isPlainObject(spec)) {
        return {
            providerId: String(spec.provider || spec.providerId || spec.profile || '').trim(),
            model: String(spec.model || '').trim()
        };
    }
    return { providerId: '', model: '' };
}

/**
 * Carry the old per-task model choices over, but only references that point at
 * a personal provider definition we know locally. `default`/`managed-…`
 * references belong to the published catalog and must not be imported as a
 * personal definition, and a bare model name cannot be attributed to a provider.
 */
function migrateLegacyTaskModels(settings, profile) {
    // The old layout could carry the same mapping under `models` or `tasks`
    // (and occasionally both); `models` wins, exactly like the resolver.
    const legacy = {
        ...normalizeTaskModelMap(settings?.ai?.tasks),
        ...normalizeTaskModelMap(settings?.ai?.models)
    };
    const taskModels = {};
    const skipped = [];
    for (const [task, spec] of Object.entries(legacy)) {
        const { providerId, model } = splitLegacySpec(spec);
        const usable = providerId && model
            && !isManagedProviderId(providerId)
            && providerId !== 'default'
            && !!profile.providers[providerId];
        if (!usable) {
            skipped.push({ task, reason: providerId ? 'provider-not-migrated' : 'unattributed-model' });
            continue;
        }
        taskModels[task] = `${providerId}:${model}`;
    }
    return { taskModels, skipped };
}

/**
 * One-time migration from the previous `pen_global_settings.ai` +
 * `pen_global_secrets.aiProviders` layout.
 *
 * - Only non-`default` provider IDs with a user-entered key are migrated.
 * - Migrated providers start disabled (`origin: 'legacy'`) and the key is
 *   local-only, so the user confirms them before they are used or synced.
 * - The old `default`/`aiApiKey` values are quarantined as metadata only; the
 *   secret itself is removed rather than copied anywhere else.
 * - Old AI secrets are deleted only after the new profile is written and read
 *   back successfully.
 */
export function migrateLegacyAISettings() {
    let already = '';
    try { already = localStorage.getItem(AI_PROFILE_MIGRATION_KEY) || ''; } catch (_) {}
    if (already === 'done') return { migrated: false, reason: 'already-migrated' };

    const settings = readLegacyJson('pen_global_settings');
    const secrets = readLegacyJson('pen_global_secrets');
    const legacyProviders = isPlainObject(settings?.ai?.providers) ? settings.ai.providers : {};
    const legacyKeys = isPlainObject(secrets?.aiProviders) ? secrets.aiProviders : {};
    const legacyTaskModels = normalizeTaskModelMap(settings?.ai?.models || settings?.ai?.tasks);
    const hasLegacy = Object.keys(legacyProviders).length > 0
        || Object.keys(legacyKeys).length > 0
        || Object.keys(legacyTaskModels).length > 0
        || !!secrets?.aiApiKey
        || !!settings?.ai?.apiUrl;

    // Always migrate into the device/guest profile; an account import stays an
    // explicit user action.
    const guestScope = { endpoint: configuredSyncEndpoint(), userId: '', guest: true, key: GUEST_PROFILE_KEY };
    const profile = loadAIProfile(guestScope);
    const quarantined = [];
    const migratedIds = [];

    if (hasLegacy) {
        for (const [id, provider] of Object.entries(legacyProviders)) {
            if (!isPersonalProviderId(id)) {
                if (id === 'default') quarantined.push({ id, reason: 'legacy-default' });
                continue;
            }
            const apiKey = String(legacyKeys?.[id]?.apiKey || '').trim();
            const binding = inferLegacyBinding(provider);
            const existing = profile.providers[id];
            if (existing) continue;
            profile.providers[id] = normalizeStoredProvider(id, {
                ...provider,
                enabled: false,
                origin: 'legacy',
                createdAt: nowIso(),
                updatedAt: nowIso()
            });
            if (binding) {
                profile.credentials[id] = normalizeCredential({
                    apiKey,
                    binding: binding.apiUrl ? {
                        formatVersion: 1,
                        format: binding.format,
                        apiUrl: binding.apiUrl,
                        modelsUrl: binding.modelsUrl,
                        authMode: binding.authMode
                    } : null,
                    version: 0,
                    syncMode: 'local-only'
                });
            }
            migratedIds.push(id);
            if (!apiKey) quarantined.push({ id, reason: 'no-legacy-key' });
        }
        if (legacyKeys?.default || secrets?.aiApiKey || settings?.ai?.apiUrl) {
            quarantined.push({ id: 'default', reason: 'legacy-shared-key-removed' });
        }
    }

    if (!hasLegacy) {
        try { localStorage.setItem(AI_PROFILE_MIGRATION_KEY, 'done'); } catch (_) {}
        return { migrated: false, reason: 'nothing-to-migrate' };
    }

    // Per-task choices: keep references to providers that are now part of the
    // local profile; never import a managed/default definition from the file.
    const migratedTasks = migrateLegacyTaskModels(settings, profile);
    for (const [task, spec] of Object.entries(migratedTasks.taskModels)) {
        if (!profile.taskModels[task]) profile.taskModels[task] = spec;
    }
    const defaultCandidates = [
        settings?.ai?.defaultModel,
        settings?.ai?.models?.default,
        settings?.ai?.tasks?.default
    ].map(splitLegacySpec);
    const legacyDefault = defaultCandidates.find((item) => item.providerId && item.model) || { providerId: '', model: '' };
    if (!profile.defaultModel && legacyDefault.providerId && legacyDefault.model
        && !isManagedProviderId(legacyDefault.providerId)
        && profile.providers[legacyDefault.providerId]) {
        profile.defaultModel = `${legacyDefault.providerId}:${legacyDefault.model}`;
    }

    profile.updatedAt = nowIso();
    try {
        saveAIProfile(profile, guestScope);
    } catch (error) {
        return { migrated: false, reason: 'save-failed', error };
    }

    // Quarantine metadata only (no keys) so the user can review what was left out.
    if (quarantined.length || migratedTasks.skipped.length) {
        try {
            localStorage.setItem(AI_PROFILE_QUARANTINE_KEY, JSON.stringify({
                at: nowIso(),
                items: quarantined,
                taskModels: migratedTasks.skipped
            }));
        } catch (_) {}
    }

    // Confirm the read-back before deleting anything from the old storage: the
    // old task/模型 choices must not disappear if the new profile did not keep
    // them.
    let readBack;
    try {
        readBack = loadAIProfile(guestScope);
    } catch (_) {
        readBack = profile;
    }
    const notPersisted = Object.entries(migratedTasks.taskModels)
        .filter(([task, spec]) => readBack.taskModels[task] !== spec)
        .map(([task]) => task);
    if (notPersisted.length) {
        return {
            migrated: true,
            reason: 'task-models-not-persisted',
            migratedIds,
            quarantined,
            notPersisted
        };
    }

    // Confirmed write: now remove the old AI secrets / definitions while
    // keeping every non-AI field (TTS, language, etc.).
    try {
        const nextSettings = clone(settings || {});
        if (nextSettings && isPlainObject(nextSettings.ai)) {
            delete nextSettings.ai.providers;
            delete nextSettings.ai.models;
            delete nextSettings.ai.tasks;
            delete nextSettings.ai.apiUrl;
        }
        localStorage.setItem('pen_global_settings', JSON.stringify(nextSettings));
        const nextSecrets = clone(secrets || {});
        delete nextSecrets.aiProviders;
        delete nextSecrets.aiApiKey;
        localStorage.setItem('pen_global_secrets', JSON.stringify(nextSecrets));
        localStorage.setItem(AI_PROFILE_MIGRATION_KEY, 'done');
    } catch (_) {
        return { migrated: true, reason: 'cleanup-failed', migratedIds, quarantined };
    }

    return {
        migrated: true,
        migratedIds,
        quarantined,
        taskModels: migratedTasks.taskModels,
        skippedTaskModels: migratedTasks.skipped
    };
}
