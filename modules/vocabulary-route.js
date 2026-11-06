import { isValidArticleReference } from '../shared/article-protocol.mjs';
import { isValidEntityId } from '../shared/reading-protocol.mjs';

/** 詞書深連結沿用主站 hash 路由；接受 #v、#vocab、#vocabulary。 */
export function readVocabularyRoute(hash = typeof window !== 'undefined' ? window.location.hash : '') {
    const match = String(hash).match(/^#\/?(?:v|vocab|vocabulary)(?:\/(.*))?$/i);
    if (!match) return null;
    if (match[1] === undefined || match[1] === '') return { id: '', invalid: false };
    try {
        const id = decodeURIComponent(match[1]);
        return { id, invalid: !isValidVocabularyBookId(id) };
    } catch (_) {
        return { id: '', invalid: true };
    }
}

/**
 * 詞書 ID 可能是舊文章 ID（url:...）或一般實體 ID。
 * 這兩種都是既有資料會出現的合法身份，不能只接受其中一種。
 */
export function isValidVocabularyBookId(id) {
    const value = String(id == null ? '' : id);
    return isValidEntityId(value) || isValidArticleReference(value);
}

export function vocabBookHash(id = '') {
    return id ? `#v/${encodeURIComponent(id)}` : '#v';
}

export function writeVocabularyRoute(id = '', { replace = false } = {}) {
    const hash = vocabBookHash(id);
    const url = new URL(window.location.href);
    ['module', 'tab', 'page'].forEach((key) => url.searchParams.delete(key));
    url.hash = hash;
    if (url.href !== window.location.href) history[replace ? 'replaceState' : 'pushState'](null, '', url);
}
