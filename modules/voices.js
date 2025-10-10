// Voice list fetcher and categorizer for TTS
// - Normalizes various provider payloads into a common shape
// - Filters into EN-US (美音), EN-GB (英音), ZH-HK (廣東話), ZH-CN (普通話)

import { TTS_CONFIG } from '../ai-config.js';
import { loadGlobalSettings } from './settings.js';

// Local bundled static voices file (same-origin, no CORS). Update via scripts/update-voices.sh
const STATIC_VOICES_PATH = '/voices.json';

const LS_KEY = 'pen_tts_voices_cache_v1';

function readCache() {
    try { const raw = localStorage.getItem(LS_KEY); return raw ? JSON.parse(raw) : null; } catch(_) { return null; }
}
function writeCache(list) {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ updatedAt: Date.now(), list })); } catch(_) {}
}
export function getCachedVoicesList() {
    const c = readCache();
    return { list: Array.isArray(c?.list) ? c.list : [], updatedAt: c?.updatedAt || 0 };
}

// Normalize one raw voice entry from different providers
function normalizeVoice(raw) {
    if (!raw || typeof raw !== 'object') return null;
    // Common fields across providers
    // Prefer provider short code first (works with most /tts backends)
    const id = raw.short_name || raw.ShortName || raw.shortName || raw.Name || raw.name || raw.VoiceId || raw.Id || raw.id || raw.voice || raw.Code;
    const locale = raw.locale || raw.Locale || raw.lang || raw.language || raw.languageCode || raw.Language || '';
    const gender = raw.gender || raw.Gender || '';
    const localName = raw.local_name || raw.LocalName || raw.localName || '';
    const displayName = raw.display_name || raw.DisplayName || raw.displayName || raw.FriendlyName || '';
    const style = raw.StyleList || raw.styleList || raw.Style || raw.style || undefined;
    if (!id) return null;
    return {
        id: String(id),
        locale: String(locale || ''),
        gender: gender ? String(gender) : '',
        localName: localName ? String(localName) : '',
        displayName: displayName ? String(displayName) : '',
        raw
    };
}

export function formatVoiceLabel(v) {
    if (!v) return '';
    const parts = [];
    // Prefer a readable local/display name
    const nm = v.localName || v.displayName || '';
    if (nm) parts.push(nm);
    // Always show the short id
    parts.push(v.id);
    if (v.gender) parts.push(`[${v.gender}]`);
    if (v.locale) parts.push(`(${v.locale})`);
    return parts.join(' ');
}

// Try both configured voicesUrl and baseUrl/voices
export async function fetchVoicesList({ signal, refresh = false, allowCache = true, overrideUse, overrideBaseUrls, ttlMs = 24*60*60*1000 } = {}) {
    const s = loadGlobalSettings();
    const explicit = (TTS_CONFIG && TTS_CONFIG.voicesUrl) ? String(TTS_CONFIG.voicesUrl).trim() : '';
    const use = overrideUse || (s?.tts && s.tts.use) || 'remote';
    const baseLocal = (overrideBaseUrls?.local && String(overrideBaseUrls.local).trim())
        || (s?.tts?.baseUrlLocal && String(s.tts.baseUrlLocal).trim())
        || (TTS_CONFIG && TTS_CONFIG.baseUrlLocal) || '';
    const baseRemote = (overrideBaseUrls?.remote && String(overrideBaseUrls.remote).trim())
        || (s?.tts?.baseUrlRemote && String(s.tts.baseUrlRemote).trim())
        || (TTS_CONFIG && (TTS_CONFIG.baseUrlRemote || TTS_CONFIG.baseUrl)) || '';
    const baseCustom = (overrideBaseUrls?.custom && String(overrideBaseUrls.custom).trim())
        || (s?.tts?.baseUrlCustom && String(s.tts.baseUrlCustom).trim()) || '';
    const candidates = [];
    if (use === 'custom') {
        if (baseCustom) candidates.push(baseCustom.replace(/\/?$/, '') + '/voices');
        if (baseRemote) candidates.push(baseRemote.replace(/\/?$/, '') + '/voices');
        if (baseLocal) candidates.push(baseLocal.replace(/\/?$/, '') + '/voices');
        if (explicit) candidates.push(explicit);
    } else if (use === 'local') {
        if (baseLocal) candidates.push(baseLocal.replace(/\/?$/, '') + '/voices');
        if (baseRemote) candidates.push(baseRemote.replace(/\/?$/, '') + '/voices');
        if (explicit) candidates.push(explicit);
    } else {
        if (baseRemote) candidates.push(baseRemote.replace(/\/?$/, '') + '/voices');
        if (baseLocal) candidates.push(baseLocal.replace(/\/?$/, '') + '/voices');
        if (explicit) candidates.push(explicit);
    }

    let lastErr = null;

    // 1) 直接讀取本地靜態 voices（同源、無 CORS，且可由腳本更新），作為權威來源
    try {
        const resp = await fetch(STATIC_VOICES_PATH, { signal, cache: refresh ? 'no-store' : 'default' });
        if (resp.ok) {
            const data = await resp.json();
            const arr = Array.isArray(data) ? data : (Array.isArray(data?.voices) ? data.voices : []);
            const normalized = arr.map(normalizeVoice).filter(Boolean);
            if (normalized.length) { writeCache(normalized); return normalized; }
        }
    } catch(_) {}

    // 2) 快取優先（非強制刷新時）：命中且未過期則直接返回
    if (!refresh && allowCache) {
        try {
            const cached = getCachedVoicesList();
            if (cached.list && cached.list.length && (Date.now() - (cached.updatedAt||0) < ttlMs)) {
                return cached.list;
            }
        } catch(_) {}
    }
    if (!refresh) {
        for (const url of candidates) {
            try {
                const resp = await fetch(url, { signal });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const data = await resp.json();
                // Accept array or object { voices: [...] }
                const arr = Array.isArray(data) ? data : (Array.isArray(data?.voices) ? data.voices : []);
                const normalized = arr.map(normalizeVoice).filter(Boolean);
                // Some payloads include nested providers { azure:[...], gcloud:[...] }
                if (!normalized.length) {
                    const buckets = [];
                    for (const k of Object.keys(data||{})) {
                        const v = data[k];
                        if (Array.isArray(v)) buckets.push(...v);
                    }
                    const norm2 = buckets.map(normalizeVoice).filter(Boolean);
                    if (norm2.length) { writeCache(norm2); return norm2; }
                }
                writeCache(normalized);
                return normalized;
            } catch (e) {
                lastErr = e;
                // try next candidate
            }
        }
    } else {
        // 3) refresh=true 且本地靜態不可用：允許遠端抓取一次以回寫快取（可選）。
        for (const url of candidates) {
            try {
                const resp = await fetch(url, { signal, cache: 'no-store' });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const data = await resp.json();
                const arr = Array.isArray(data) ? data : (Array.isArray(data?.voices) ? data.voices : []);
                const normalized = arr.map(normalizeVoice).filter(Boolean);
                if (!normalized.length) {
                    const buckets = [];
                    for (const k of Object.keys(data||{})) { const v = data[k]; if (Array.isArray(v)) buckets.push(...v); }
                    const norm2 = buckets.map(normalizeVoice).filter(Boolean);
                    if (norm2.length) { writeCache(norm2); return norm2; }
                }
                writeCache(normalized);
                return normalized;
            } catch (e) {
                lastErr = e;
            }
        }
    }

    // Fallback: localStorage cache（即使過期亦可作為最後回退）
    if (allowCache) {
        const cached = getCachedVoicesList();
        if (cached.list.length) return cached.list;
    }

    throw lastErr || new Error('Failed to fetch voices (remote + cache all failed)');
}

// Group into desired categories
export function groupVoices(voices) {
    const groups = { 'en-US': [], 'en-GB': [], 'zh-HK': [], 'zh-CN': [] };
    const isCantonese = (v) => {
        const l = (v.locale || '').toLowerCase();
        const id = (v.id || '').toLowerCase();
        // Some providers use yue-HK for Cantonese; zh-HK often indicates Cantonese voices
        return l.startsWith('zh-hk') || l.startsWith('yue') || id.includes('yue') || /cantonese|粤語|粵語|廣東話/i.test(v.localName || v.displayName || '');
    };
    const isMandarin = (v) => {
        const l = (v.locale || '').toLowerCase();
        // Accept Mainland first; some services use zh-TW for TW Mandarin (optional)
        return l.startsWith('zh-cn') || l.startsWith('cmn-') || /普通话|普通話|國語|国语|Mandarin/i.test(v.localName || v.displayName || '');
    };
    voices.forEach(v => {
        const l = (v.locale || '').toLowerCase();
        if (l.startsWith('en-us')) { groups['en-US'].push(v); return; }
        if (l.startsWith('en-gb')) { groups['en-GB'].push(v); return; }
        if (isCantonese(v)) { groups['zh-HK'].push(v); return; }
        if (isMandarin(v) || l.startsWith('zh-cn')) { groups['zh-CN'].push(v); return; }
        // As a fallback: if zh-TW present and no zh-CN voices found yet, treat as Mandarin
        if (l.startsWith('zh-tw')) { groups['zh-CN'].push(v); return; }
    });
    // Stable sort by id for determinism
    for (const k of Object.keys(groups)) {
        groups[k].sort((a, b) => String(a.id).localeCompare(String(b.id)));
    }
    return groups;
}

// Resolve a best-default voice id for a group if none is selected
export function pickDefaultVoiceId(group) {
    if (!Array.isArray(group) || !group.length) return '';
    // Prefer a Neural female voice if present; else first
    const pref = group.find(v => /neural/i.test(v.id) && /female/i.test(v.gender||''));
    return (pref || group[0]).id;
}
