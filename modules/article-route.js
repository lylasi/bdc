import { isValidArticleId } from '../shared/article-protocol.mjs';

/** Hash 路由適用於靜態託管；舊有 local:／url: ID 仍使用原身份。 */
export function readArticleRoute(hash = window.location.hash) {
    const match = String(hash).match(/^#\/?(?:a|article)(?:\/(.*))?$/i);
    if (!match) return null;
    if (match[1] === undefined || match[1] === '') return { id: '', invalid: false };
    try {
        const id = decodeURIComponent(match[1]);
        return { id, invalid: !isValidArticleId(id) };
    } catch (_) {
        return { id: '', invalid: true };
    }
}

export function articleHash(id = '') {
    return id ? `#a/${encodeURIComponent(id)}` : '#a';
}

export function writeArticleRoute(id = '', { replace = false } = {}) {
    const hash = articleHash(id);
    const url = new URL(window.location.href);
    ['module', 'tab', 'page'].forEach((key) => url.searchParams.delete(key));
    url.hash = hash;
    if (url.href !== window.location.href) history[replace ? 'replaceState' : 'pushState'](null, '', url);
}
