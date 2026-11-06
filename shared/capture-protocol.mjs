import { isPlainObject, isValidEntityId, normalizeAnchor } from './reading-protocol.mjs';
import { normalizeVocabularyWordKey, publicSourceUrl } from './vocabulary-source.mjs';

export const CAPTURE_MAX_BYTES = 128 * 1024;

function inputError(code = 'capture_invalid_input') {
    return Object.assign(new Error(code), { code, status: 400 });
}

function field(raw, name, limit, { required = false } = {}) {
    if (raw[name] != null && typeof raw[name] !== 'string') throw inputError();
    const value = String(raw[name] || '').trim();
    if (value.length > limit || (required && !value)) throw inputError();
    return value;
}

export function validateCapture(raw) {
    if (!isPlainObject(raw)) throw inputError();
    const requestId = field(raw, 'requestId', 120, { required: true });
    const bookId = field(raw, 'bookId', 160, { required: true });
    if (!isValidEntityId(requestId) || !isValidEntityId(bookId)) throw inputError();
    const word = field(raw, 'word', 400, { required: true }).replace(/\s+/g, ' ');
    if (!normalizeVocabularyWordKey(word)) throw inputError();
    const result = {
        requestId, bookId, word,
        meaning: field(raw, 'meaning', 4000, { required: true }),
        phonetic: field(raw, 'phonetic', 200),
        pos: field(raw, 'pos', 200)
    };
    if (raw.source != null) {
        if (!isPlainObject(raw.source)) throw inputError();
        const source = raw.source;
        const sourceUrl = field(source, 'sourceUrl', 4096);
        if (sourceUrl && !publicSourceUrl(sourceUrl)) throw inputError('capture_invalid_url');
        if (source.anchor != null && !isPlainObject(source.anchor)) throw inputError();
        if (source.anchor?.quote != null && (typeof source.anchor.quote !== 'string' || source.anchor.quote.length > 2000)) throw inputError();
        if (['prefix', 'suffix'].some((name) => source.anchor?.[name] != null
            && (typeof source.anchor[name] !== 'string' || source.anchor[name].length > 120))) throw inputError();
        for (const name of ['start', 'end']) {
            const position = source.anchor?.[name];
            if (position != null && (typeof position !== 'number' || !Number.isSafeInteger(position) || position < -1)) throw inputError();
        }
        if (source.anchor?.start >= 0 && source.anchor?.end >= 0 && source.anchor.end < source.anchor.start) throw inputError();
        result.source = {
            sourceUrl,
            pageTitle: field(source, 'pageTitle', 300),
            sentence: field(source, 'sentence', 4000),
            context: field(source, 'context', 8000),
            meaning: result.meaning,
            locale: field(source, 'locale', 20),
            anchor: normalizeAnchor(source.anchor || { quote: word })
        };
    }
    return result;
}

export function captureFingerprint(capture) {
    // Validation gives a deterministic field order and strips non-semantic data.
    return JSON.stringify(validateCapture(capture));
}
