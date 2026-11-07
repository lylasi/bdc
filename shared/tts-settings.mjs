// Public TTS account settings only. API keys and device-specific voice URIs
// are never part of a learning-data snapshot.
export const TTS_CREDENTIAL_ID = ['bdc', 'tts', 'v1'].join('-');
const URL_FIELDS = ['baseUrl', 'baseUrlRemote', 'baseUrlLocal', 'baseUrlCustom'];
const VOICE_LOCALES = ['en-US', 'en-GB', 'zh-HK', 'zh-CN'];
const object = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

export function normalizeTTSUrl(value) {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (!raw || raw.length > 2048) return '';
    try {
        const url = new URL(raw);
        if (!/^https?:$/.test(url.protocol) || !url.href.startsWith(url.origin + '/') || url.search || url.hash) return '';
        if (/(^|\.)example\.(com|org|net)$/i.test(url.hostname) || /your-tts|yourtts|placeholder/i.test(raw)) return '';
        return url.href.replace(/\/+$/, '');
    } catch (_) { return ''; }
}

export function sanitizeTTSSettings(input) {
    const source = object(input) ? input : {};
    const tts = {}, reading = {};
    if (object(source.tts)) {
        if (['remote', 'local', 'custom'].includes(source.tts.use)) tts.use = source.tts.use;
        for (const field of URL_FIELDS) {
            if (typeof source.tts[field] === 'string') tts[field] = normalizeTTSUrl(source.tts[field]);
        }
        if (object(source.tts.selectedVoices)) {
            tts.selectedVoices = {};
            for (const locale of VOICE_LOCALES) {
                const voice = source.tts.selectedVoices[locale];
                if (typeof voice === 'string' && voice.length <= 240 && !/[\r\n\x00-\x1f]/.test(voice)) tts.selectedVoices[locale] = voice.trim();
            }
        }
    }
    if (object(source.reading)) {
        if (['en-US', 'en-GB'].includes(source.reading.englishVariant)) reading.englishVariant = source.reading.englishVariant;
        if (['zh-CN', 'zh-HK'].includes(source.reading.chineseVariant)) reading.chineseVariant = source.reading.chineseVariant;
    }
    return { tts, reading };
}

export function mergeTTSSettings(base, patch) {
    const a = sanitizeTTSSettings(base), b = sanitizeTTSSettings(patch);
    return { tts: { ...a.tts, ...b.tts, selectedVoices: { ...a.tts.selectedVoices, ...b.tts.selectedVoices } },
        reading: { ...a.reading, ...b.reading } };
}

export function ttsServiceUrl(settings) {
    const tts = settings?.tts || {};
    if (tts.use === 'custom') return normalizeTTSUrl(tts.baseUrlCustom);
    if (tts.use === 'local') return normalizeTTSUrl(tts.baseUrlLocal);
    return normalizeTTSUrl(tts.baseUrlRemote || tts.baseUrl);
}

export function sanitizeTTSGroup(group) {
    if (!object(group) || !object(group.settings) || typeof group.updatedAt !== 'string' || !Number.isFinite(Date.parse(group.updatedAt))) return null;
    return { updatedAt: new Date(group.updatedAt).toISOString(), settings: sanitizeTTSSettings(group.settings) };
}
