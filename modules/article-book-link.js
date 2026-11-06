// 主站文章／詞書來源關聯的瀏覽器層解析。
//
// 純身份規則在 shared/article-book-link.mjs；這裡只負責把目前的文章 store、
// 舊 ArticleMeta 與 UI 詞書清單接起來，讓功能模組不用各自重寫查找。
// 不改寫任何資料：解析結果只用於導航與顯示來源。

import * as state from './state.js';
import * as storage from './storage.js';
import * as articleStore from './article-store.js';
import { isValidArticleReference } from '../shared/article-protocol.mjs';
import {
    safeHttpSourceUrl,
    matchVocabularyBookForArticle,
    matchArticleForVocabularyBook
} from '../shared/article-book-link.mjs';

function text(value) {
    return String(value == null ? '' : value).trim();
}

function safeMeta(articleId) {
    if (!articleId) return null;
    try { return storage.getArticleMetaById(articleId) || null; } catch (_) { return null; }
}

function safeRecord(articleId) {
    if (!articleId) return null;
    try { return articleStore.getRecord(articleId) || null; } catch (_) { return null; }
}

function safeReferenceIds(articleId) {
    if (!articleId) return [];
    try { return articleStore.articleReferenceIds(articleId) || []; } catch (_) { return []; }
}

/**
 * 把 articleId／文章記錄／舊 meta 整理成共用身份物件。
 * 文章記錄優先（來源與標題已由文章 store 校正），缺記錄時才用 meta 或呼叫端資料。
 */
function articleLookup(idOrRecord) {
    const input = idOrRecord && typeof idOrRecord === 'object' ? idOrRecord : null;
    const requestedId = text(typeof idOrRecord === 'string' ? idOrRecord
        : input?.articleId || input?.id || input?.storageId || '');
    const record = safeRecord(requestedId);
    const canonicalId = text(record?.articleId || requestedId);
    const meta = safeMeta(canonicalId)
        || safeMeta(record?.storageId)
        || safeMeta(requestedId)
        || (input ? safeMeta(input.articleId || input.id || input.storageId) : null);
    const referenceIds = new Set();
    for (const id of [
        requestedId,
        canonicalId,
        record?.storageId,
        meta?.id,
        meta?.storageId,
        ...(Array.isArray(input?.referenceIds) ? input.referenceIds : []),
        ...safeReferenceIds(canonicalId || requestedId)
    ]) {
        const value = text(id);
        if (value) referenceIds.add(value);
    }
    const base = record || input || {};
    return {
        record,
        meta,
        article: {
            id: canonicalId || requestedId,
            articleId: canonicalId || requestedId,
            storageId: text(record?.storageId || base.storageId || meta?.storageId || ''),
            referenceIds: Array.from(referenceIds),
            title: text(record?.title || base.title || meta?.title || ''),
            sourceType: text(record?.sourceType || base.sourceType || meta?.sourceType || ''),
            sourceUrl: text(record?.sourceUrl || base.sourceUrl || meta?.sourceUrl || ''),
            linkedBookId: text(base.linkedBookId || record?.linkedBookId || meta?.linkedBookId || ''),
            deletedAt: text(record?.deletedAt || base.deletedAt || '')
        }
    };
}

/**
 * 文章 → 詞書。
 * @param {string|object} articleIdOrRecord 文章 ID（公開或 storage 別名）或文章記錄。
 * @param {{books?: object[]}} options 可注入詞書清單；預設使用目前 UI 詞書。
 */
export function resolveVocabularyBookForArticle(articleIdOrRecord, options = {}) {
    const { record, meta, article } = articleLookup(articleIdOrRecord);
    const books = Array.isArray(options.books)
        ? options.books
        : (Array.isArray(state.vocabularyBooks) ? state.vocabularyBooks : []);
    const match = matchVocabularyBookForArticle(article, books, { linkedBookId: article.linkedBookId });
    return {
        article,
        articleId: article.articleId,
        record,
        articleMeta: meta,
        sourceUrl: safeHttpSourceUrl(article.sourceUrl, meta?.sourceUrl),
        book: match.book,
        bookId: text(match.book?.id),
        match: match.match,
        ambiguous: match.ambiguous,
        candidates: match.candidates,
        hasBook: !!match.book
    };
}

/**
 * 詞書 → 文章與安全原文來源。
 * - articleId 指向 storage ID（舊版網址文章）時會換回公開 ID；
 * - 沒有 articleId 的舊詞書，只接受「同一頁來源」作為補救，不看名稱；
 * - canOpenArticle 為 false 時 UI 不要顯示回文章按鈕。
 */
export function resolveArticleForVocabularyBook(book) {
    if (!book || typeof book !== 'object') {
        return { bookId: '', articleId: '', article: null, articleMeta: null, canOpenArticle: false,
            sourceUrl: '', match: 'none', ambiguous: false, candidates: [] };
    }
    let records = [];
    let metas = [];
    try { records = articleStore.getRecords() || []; } catch (_) { records = []; }
    try { metas = storage.getAllArticleMetas() || []; } catch (_) { metas = []; }

    const match = matchArticleForVocabularyBook(book, { articles: records, metas });
    const requestedId = text(book.articleId || '');
    // 詞書明確記錄的 articleId 優先；只有沒有 articleId 的舊資料才允許
    // 改用同頁來源補關聯，避免把遠端文章換成本機另一個同網址記錄。
    const directRecord = requestedId ? safeRecord(requestedId) : null;
    const directId = text(directRecord?.articleId
        || (requestedId && isValidArticleReference(requestedId) ? requestedId : ''));
    const selected = match.article || null;
    const useDirect = !!directId;
    const articleId = useDirect
        ? directId
        : text(selected?.articleId || selected?.id || match.articleId || '');
    const record = directRecord || (articleId ? safeRecord(articleId) : null);
    const meta = safeMeta(articleId) || safeMeta(requestedId) || (selected ? safeMeta(selected.id) : null);
    const deleted = !!(record?.deletedAt || (!useDirect && selected?.deletedAt) || meta?.deletedAt);
    const validArticleId = !!articleId && isValidArticleReference(articleId);
    const sourceUrl = safeHttpSourceUrl(book.sourceUrl, meta?.sourceUrl, record?.sourceUrl,
        !useDirect ? selected?.sourceUrl : '');
    const title = text(record?.title || (!useDirect ? selected?.title : '') || meta?.title || book.name || '');
    const sourceType = text(record?.sourceType || (!useDirect ? selected?.sourceType : '') || meta?.sourceType
        || (sourceUrl ? 'url' : ''));

    return {
        bookId: text(book.id),
        articleId: validArticleId ? articleId : '',
        article: validArticleId ? {
            id: articleId,
            articleId,
            title,
            sourceType,
            sourceUrl,
            deletedAt: deleted ? text(record?.deletedAt || selected?.deletedAt || meta?.deletedAt) : ''
        } : null,
        articleMeta: meta,
        canOpenArticle: validArticleId && !deleted,
        deleted,
        sourceUrl,
        match: match.match,
        ambiguous: match.ambiguous,
        candidates: match.candidates
    };
}
