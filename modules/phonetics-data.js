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

// 音標表（phonetic-chart/data.js 的 PHONEME_CARDS）實際收錄、且每個都有示範錄音的寫法。
// 用來約束 AI 只用示範得出來的符號；tests/phonetics.test.mjs 會比對兩邊是否一致。
export const PHONEME_SYMBOLS = {
    uk: [
        'iː', 'ɪ', 'e', 'æ', 'ʌ', 'ɑː', 'ɒ', 'ɔː', 'ʊ', 'uː', 'ə', 'ɜː',
        'eɪ', 'aɪ', 'ɔɪ', 'əʊ', 'aʊ', 'ɪə', 'eə', 'ʊə',
        'p', 'b', 't', 'd', 'k', 'ɡ', 'f', 'v', 'θ', 'ð', 's', 'z', 'ʃ', 'ʒ', 'h', 'tʃ', 'dʒ',
        'm', 'n', 'ŋ', 'l', 'r', 'w', 'j'
    ],
    us: [
        'iː', 'ɪ', 'e', 'æ', 'ʌ', 'ɑː', 'ɔː', 'ʊ', 'uː', 'ə', 'ɜːr', 'ər',
        'eɪ', 'aɪ', 'ɔɪ', 'oʊ', 'aʊ', 'ɪr', 'er', 'ʊr',
        'p', 'b', 't', 'd', 'k', 'ɡ', 'f', 'v', 'θ', 'ð', 's', 'z', 'ʃ', 'ʒ', 'h', 'tʃ', 'dʒ',
        'm', 'n', 'ŋ', 'l', 'r', 'w', 'j'
    ]
};
export const phonemeSymbols = accent => PHONEME_SYMBOLS[accent] || PHONEME_SYMBOLS.uk;

// 提示詞用的寫法說明：AI 常寫成 /ɛ/、/ɹ/、/ɝ/、/i/ 等，這些音其實都在表內，只是記法不同。
export const IPA_NOTATION_RULE = 'Write IPA only in this app\'s notation: /e/ (not /ɛ/), /r/ (not /ɹ/), '
    + '/ɡ/ (not g), /iː/ (not i), /uː/ (not u), /ɑː/ (not ɑ), /ɔː/ (not ɔ), /ɜː/ or /ɜːr/ (not ɜ or ɝ), '
    + '/ə/ or /ər/ (not ɚ), /tʃ/ and /dʒ/ (not ligatures). Stress marks ˈ ˌ and syllable dots are allowed.';

// Parenthesized sounds are optional, not extra mandatory sounds in the sequence.
export function practiceTokens(ipa, accent, word, tokenize) {
    return ipa.split(/(\([^()]*\))/u).filter(Boolean).flatMap(part => {
        const optional = part.startsWith('(') && part.endsWith(')');
        const value = optional ? part.slice(1, -1) : part;
        return tokenize(value, accent, word).map(token => ({...token, optional}));
    });
}
