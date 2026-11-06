// Pure vocabulary/source identity shared by the website, extension and server.
export const MAX_VOCABULARY_SOURCES = 100;

export function normalizeVocabularyWordKey(value) {
    return String(value || '').replace(/\s+/g, ' ').trim()
        .replace(/^[\s"'“”‘’()\[\]{}<>，。！？；：,.!?;:]+/, '')
        .replace(/[\s"'“”‘’()\[\]{}<>，。！？；：,.!?;:]+$/, '')
        .replace(/\s+/g, ' ').trim().toLowerCase();
}

export function publicSourceUrl(value) {
    const raw = String(value || '').trim();
    if (!raw || raw.length > 4096) return '';
    try {
        const url = new URL(raw);
        return /^(https?:)$/.test(url.protocol) && !url.username && !/^https?:\/\/[^/]*@/i.test(url.href) ? url.href : '';
    } catch (_) { return ''; }
}

export function vocabularySourceKey(source = {}) {
    return JSON.stringify([
        publicSourceUrl(source.sourceUrl), String(source.articleId || ''),
        String(source.sentence || ''), Number(source.anchor?.start ?? -1),
        Number(source.anchor?.end ?? -1), String(source.anchor?.quote || ''), String(source.meaning || '')
    ]);
}

export function normalizeVocabularySource(source, { cleanString, normalizeAnchor, maxEntityId, maxContentVersion }) {
    const result = {
        sentence: cleanString(source.sentence, 4000),
        context: cleanString(source.context, 8000),
        articleId: cleanString(source.articleId, maxEntityId),
        contentVersion: cleanString(source.contentVersion, maxContentVersion),
        anchor: normalizeAnchor(source.anchor),
        addedAt: cleanString(source.addedAt, 40)
    };
    // Keep the old shape for article-only sources, including old backups.
    for (const [key, limit] of [['sourceUrl', 4096], ['pageTitle', 300], ['meaning', 4000], ['locale', 20]]) {
        if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
        result[key] = key === 'sourceUrl'
            ? (publicSourceUrl(source[key]) ? cleanString(source[key], limit) : '')
            : cleanString(source[key], limit);
    }
    return result;
}
