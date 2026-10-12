// No settings, DOM or network access: validation shared by the dialog and AI adapter.
export const normalizePronunciationText = value => String(value || '').trim().toLowerCase().replace(/\s+/gu, ' ').replace(/’/gu, "'");
export const validWord = value => typeof value === 'string' && value.length <= 80 && /^[a-z]+(?:['-][a-z]+)*(?: +[a-z]+(?:['-][a-z]+)*)*$/i.test(value);
export const cleanIPA = value => typeof value === 'string' ? value.trim().replace(/^\/(.*)\/$/u, '$1').replace(/^\[(.*)\]$/u, '$1').normalize('NFC') : '';
export const validIPA = value => typeof value === 'string' && value.length > 0 && value.length <= 160 && !/^(error|unknown|undefined|null|n\/?a)$/i.test(value) && /^[a-zæøðθβŋɐ-ʯˈˌːˑ. ()ɡ\u0300-\u036f]+$/u.test(value) && /[a-zæøðθβŋɐ-ʯ]/u.test(value);
export function validatePronunciations(data, word, accent) {
    if (!data || data.word !== word || data.accent !== accent || !['uk', 'us'].includes(accent) || !Array.isArray(data.readings) || data.readings.length > 6) return [];
    const seen = new Set();
    return data.readings.flatMap(item => {
        const ipa = cleanIPA(item?.ipa);
        if (!validIPA(ipa) || seen.has(ipa)) return [];
        seen.add(ipa);
        return [{ipa, accent, source: 'ai', pos: typeof item.pos === 'string' ? item.pos.slice(0, 80) : '', meaning: typeof item.meaning === 'string' ? item.meaning.slice(0, 240) : ''}];
    });
}
export function entryQuery(entry, preferredAccent = 'uk') {
    const word = normalizePronunciationText(entry?.word);
    const params = new URLSearchParams({word, accent: preferredAccent});
    const ipa = cleanIPA(entry?.phonetic);
    const explicitAccent = entry?.phoneticAccent || entry?.accent;
    if (validIPA(ipa)) {
        if (['uk', 'us'].includes(explicitAccent)) {
            params.set('accent', explicitAccent);
            params.set('ipa', ipa);
            params.set('source', entry?.phoneticSource === 'ai' ? 'ai' : 'provided');
        } else params.set('referenceIPA', ipa);
    }
    return params;
}
export function voiceForAccent(settings, accent) {
    if (!['uk', 'us'].includes(accent)) throw new Error('Invalid accent');
    const locale = accent === 'uk' ? 'en-GB' : 'en-US';
    const selected = settings?.tts?.selectedVoices?.[locale];
    if (selected && !selected.startsWith(locale + '-')) throw new Error('Voice accent mismatch');
    return selected || (accent === 'uk' ? 'en-GB-AbbiNeural' : 'en-US-JennyNeural');
}

// Parenthesized sounds are optional, not extra mandatory sounds in the sequence.
export function practiceTokens(ipa, accent, word, tokenize) {
    return ipa.split(/(\([^()]*\))/u).filter(Boolean).flatMap(part => {
        const optional = part.startsWith('(') && part.endsWith(')');
        const value = optional ? part.slice(1, -1) : part;
        return tokenize(value, accent, word).map(token => ({...token, optional}));
    });
}
