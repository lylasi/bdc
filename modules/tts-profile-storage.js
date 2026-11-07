import { TTS_CONFIG } from '../ai-config.js';
import { getActiveAIScope, normalizeSyncEndpoint } from './ai-profile-storage.js';
import { touch } from './sync-signals.js';
import { mergeTTSSettings, sanitizeTTSSettings, sanitizeTTSGroup, ttsServiceUrl } from '../shared/tts-settings.mjs';

export const TTS_PROFILE_PREFIX = 'bdc_tts_profile_v1';
export const TTS_PROFILE_EVENT = 'bdc:tts-profile-change';
const MIGRATION_KEY = 'bdc_tts_profile_migration_v1';
const clone = (value) => JSON.parse(JSON.stringify(value));
const read = (key) => { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) { return null; } };

export function ttsProfileKey(scope = getActiveAIScope()) {
    return scope.guest || !scope.userId ? `${TTS_PROFILE_PREFIX}:device:guest`
        : `${TTS_PROFILE_PREFIX}:${encodeURIComponent(normalizeSyncEndpoint(scope.endpoint))}:${encodeURIComponent(scope.userId)}`;
}

function defaults() {
    return sanitizeTTSSettings({ tts: { use: TTS_CONFIG?.use || 'remote', baseUrl: TTS_CONFIG?.baseUrl || '',
        baseUrlRemote: TTS_CONFIG?.baseUrlRemote || TTS_CONFIG?.baseUrl || '', baseUrlLocal: TTS_CONFIG?.baseUrlLocal || '',
        baseUrlCustom: '', selectedVoices: { 'en-US': TTS_CONFIG?.voices?.english || '', 'en-GB': TTS_CONFIG?.voices?.english || '',
            'zh-HK': TTS_CONFIG?.voices?.cantonese || '', 'zh-CN': TTS_CONFIG?.voices?.chinese || '' } },
    reading: { englishVariant: 'en-GB', chineseVariant: 'zh-CN' } });
}

function empty() {
    const settings = defaults(), baseUrl = ttsServiceUrl(settings);
    return { schemaVersion: 1, revision: 0, settings, updatedAt: '', legacy: true, pending: false,
        credential: { apiKey: baseUrl ? String(TTS_CONFIG?.apiKey || '') : '', baseUrl, version: null, pending: null } };
}

function writeRaw(profile, scope) {
    const key = ttsProfileKey(scope), serialized = JSON.stringify(profile);
    localStorage.setItem(key, serialized);
    if (localStorage.getItem(key) !== serialized) throw Object.assign(new Error('tts_profile_save_failed'), { code: 'tts_profile_save_failed' });
    return profile;
}

function migrate() {
    if (read(MIGRATION_KEY)) return;
    const scope = getActiveAIScope(), legacy = read('pen_global_settings') || {}, secrets = read('pen_global_secrets') || {};
    const profile = empty();
    profile.settings = mergeTTSSettings(profile.settings, legacy);
    profile.updatedAt = typeof legacy.updatedAt === 'string' && Number.isFinite(Date.parse(legacy.updatedAt)) ? legacy.updatedAt : '';
    const selectedBase = ttsServiceUrl(profile.settings);
    profile.credential = { ...profile.credential, baseUrl: selectedBase,
        apiKey: typeof secrets.ttsApiKey === 'string' ? secrets.ttsApiKey
            : selectedBase === profile.credential.baseUrl ? profile.credential.apiKey : '' };
    writeRaw(profile, scope);
    if (!scope.guest) writeRaw(empty(), { guest: true });
    localStorage.setItem(MIGRATION_KEY, JSON.stringify({ claimed: !scope.guest }));
}

export function loadTTSProfile(scope = getActiveAIScope()) {
    migrate();
    const raw = read(ttsProfileKey(scope));
    if (!raw || raw.schemaVersion !== 1) return empty();
    return { ...empty(), ...raw, settings: mergeTTSSettings(defaults(), raw.settings),
        credential: { apiKey: '', baseUrl: '', version: null, pending: null, ...(raw.credential || {}) } };
}

export function updateTTSProfile(mutator, scope = getActiveAIScope(), reason = 'credential') {
    const current = loadTTSProfile(scope), next = clone(current);
    mutator(next);
    next.settings = sanitizeTTSSettings(next.settings);
    if (JSON.stringify(next) === JSON.stringify(current)) return current;
    next.revision = current.revision + 1;
    writeRaw(next, scope);
    try { window.dispatchEvent(new CustomEvent(TTS_PROFILE_EVENT, { detail: { key: ttsProfileKey(scope), reason } })); } catch (_) {}
    return next;
}

export function getTTSProfileView() {
    let profile;
    try { profile = loadTTSProfile(); } catch (_) { profile = empty(); }
    return { ...profile.settings, apiKey: profile.credential.baseUrl === ttsServiceUrl(profile.settings) ? profile.credential.apiKey || '' : '' };
}

export function saveTTSSettingsPatch(patch) {
    const clean = sanitizeTTSSettings(patch);
    if (!Object.keys(clean.tts).length && !Object.keys(clean.reading).length) return;
    const current = loadTTSProfile(), merged = mergeTTSSettings(current.settings, clean);
    if (JSON.stringify(merged) === JSON.stringify(current.settings)) return;
    updateTTSProfile((profile) => {
        const changedService = ttsServiceUrl(profile.settings) !== ttsServiceUrl(merged);
        profile.settings = merged;
        profile.updatedAt = new Date(Math.max(Date.now(), Date.parse(profile.updatedAt) + 1 || 0)).toISOString();
        profile.legacy = false; profile.pending = true;
        if (changedService) {
            profile.credential = { apiKey: '', baseUrl: ttsServiceUrl(merged), version: profile.credential.version, pending: null };
        }
    }, undefined, 'local');
    touch('ttsSettings');
}

export function saveTTSKey(apiKey) {
    const current = loadTTSProfile(), baseUrl = ttsServiceUrl(current.settings);
    const value = String(apiKey || '').trim();
    if (current.credential.apiKey === value && current.credential.baseUrl === baseUrl) return;
    updateTTSProfile((profile) => {
        profile.credential = { apiKey: value, baseUrl, version: profile.credential.version,
            pending: { type: value ? 'put' : 'delete', mutationId: globalThis.crypto?.randomUUID?.()
                || `tts_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`, expectedVersion: profile.credential.version } };
    }, undefined, 'local');
    touch('ttsSettings');
}

export function getTTSSettingsGroup(scope) {
    const profile = loadTTSProfile(scope);
    return profile.legacy ? null : sanitizeTTSGroup({ updatedAt: profile.updatedAt, settings: profile.settings });
}

export function applyRemoteTTSSettings(group, scope, { force = false } = {}) {
    const clean = sanitizeTTSGroup(group);
    if (!clean) return false;
    const profile = loadTTSProfile(scope);
    if (!force && !profile.legacy && clean.updatedAt <= profile.updatedAt) return false;
    updateTTSProfile((draft) => {
        const previousBase = ttsServiceUrl(draft.settings);
        draft.settings = mergeTTSSettings(defaults(), clean.settings);
        draft.updatedAt = clean.updatedAt; draft.legacy = false; draft.pending = false;
        if (previousBase !== ttsServiceUrl(draft.settings)) draft.credential = {
            apiKey: '', baseUrl: ttsServiceUrl(draft.settings), version: null, pending: null
        };
    }, scope, 'remote');
    return true;
}

export function prepareTTSAccount(scope, remoteExists) {
    let profile = loadTTSProfile(scope);
    const marker = read(MIGRATION_KEY) || {};
    if (!marker.claimed) {
        const guest = loadTTSProfile({ guest: true });
        if (!remoteExists && profile.legacy && ttsServiceUrl(guest.settings)) {
            profile = writeRaw(guest, scope);
        }
        // One legacy device profile can belong to the first account only.
        marker.claimed = true; localStorage.setItem(MIGRATION_KEY, JSON.stringify(marker));
        updateTTSProfile((draft) => { draft.credential = empty().credential; }, { guest: true });
    }
    if (!remoteExists && profile.legacy && ttsServiceUrl(profile.settings)) {
        updateTTSProfile((draft) => {
            draft.legacy = false; draft.pending = true;
            draft.updatedAt = new Date().toISOString();
        }, scope, 'seed');
    }
}

export function clearTTSAccount(scope) {
    if (scope?.guest) return;
    try { localStorage.removeItem(ttsProfileKey(scope)); } catch (_) {}
}

export function clearLegacyTTSCopy() {
    for (const [key, fields] of [['pen_global_secrets', ['ttsApiKey']], ['pen_global_settings', ['tts']]]) {
        const value = read(key);
        if (!value) continue;
        for (const field of fields) {
            if (field === 'tts') {
                const { extensionMode, deviceVoiceURI } = value.tts || {};
                value.tts = { ...(extensionMode ? { extensionMode } : {}), ...(deviceVoiceURI ? { deviceVoiceURI } : {}) };
            } else delete value[field];
        }
        localStorage.setItem(key, JSON.stringify(value));
    }
}
