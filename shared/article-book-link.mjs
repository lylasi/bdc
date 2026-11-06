// 文章 ↔ 詞書來源關聯的純解析規則。
//
// 這個檔案只處理身份與來源，不碰 DOM、localStorage、IndexedDB 或網路：
//   * 先沿用既存的 articleId／storageId／linkedBookId／sourceUrl；
//   * 只在同一頁（pageUrlKey）時用來源網址補關聯；
//   * 不以標題／詞書名稱猜測，避免把同名文章與詞書錯綁。
// 主站與擴充套件可以共用同一組判斷，後端不需要新增協議欄位。

import { publicSourceUrl } from './vocabulary-source.mjs';
import { pageUrlKey } from './page-protocol.mjs';

const MAX_ENTITY_ID = 160;
const MATCH_NAMES = { 1: 'sourceUrl', 2: 'articleId', 3: 'articleId', 4: 'linkedBookId' };

function identity(value) {
    const text = String(value == null ? '' : value).trim();
    return text && text.length <= MAX_ENTITY_ID ? text : '';
}

function identityList(values) {
    const out = new Set();
    for (const value of values) {
        const id = identity(value);
        if (id) out.add(id);
    }
    return out;
}

function candidateTime(value) {
    const time = Date.parse(String(value || ''));
    return Number.isFinite(time) ? time : 0;
}

function compareCandidates(left, right) {
    if (left.tier !== right.tier) return right.tier - left.tier;
    const leftTime = candidateTime(left.article?.createdAt || left.book?.createdAt);
    const rightTime = candidateTime(right.article?.createdAt || right.book?.createdAt);
    if (leftTime !== rightTime) return leftTime - rightTime;
    const leftId = identity(left.book?.id || left.article?.articleId || left.article?.id);
    const rightId = identity(right.book?.id || right.article?.articleId || right.article?.id);
    return leftId.localeCompare(rightId);
}

function resultFromCandidates(candidates) {
    const sorted = candidates.slice().sort(compareCandidates);
    const best = sorted[0] || null;
    const bestTier = best ? best.tier : 0;
    return {
        book: best?.book || null,
        article: best?.article || null,
        articleId: best?.article ? identity(best.article.articleId || best.article.id) : '',
        match: best ? MATCH_NAMES[best.tier] || 'none' : 'none',
        ambiguous: sorted.filter((item) => item.tier === bestTier).length > 1,
        candidates: sorted
    };
}

/** 一篇文章的所有已知身份：公開 ID、內部 storage ID、呼叫端提供的別名。 */
export function articleIdentityIds(article = {}) {
    const referenceIds = Array.isArray(article?.referenceIds) ? article.referenceIds : [];
    return identityList([
        article?.articleId,
        article?.id,
        article?.storageId,
        ...referenceIds
    ]);
}

/** 詞書上用來回指文章的身份（目前協議只有 articleId）。 */
export function vocabularyBookArticleId(book = {}) {
    return identity(book?.articleId);
}

/** 安全且可對外的 http(s) 來源；跳過 javascript:、帳密網址與過長內容。 */
export function safeHttpSourceUrl(...values) {
    for (const value of values) {
        const url = publicSourceUrl(value);
        if (url) return url;
    }
    return '';
}

/**
 * 從文章找對應詞書。
 *
 * 優先序（高到低）：
 *   1. 呼叫端／meta 明確記錄的 linkedBookId
 *   2. 詞書 ID 就是文章的任何已知身份（舊資料常用同一個 ID）
 *   3. 詞書的 articleId 指向文章的任何已知身份（含 storage ID 別名）
 *   4. 同一頁來源網址（pageUrlKey，hash 路由保留、一般 fragment 忽略）
 *
 * 不使用名稱比對；同分候選仍會回傳 deterministic 的第一筆，並標記 ambiguous。
 */
export function matchVocabularyBookForArticle(article = {}, books = [], options = {}) {
    const ids = articleIdentityIds(article);
    const preferredBookId = identity(options.linkedBookId || article?.linkedBookId || article?.bookId);
    const articlePageKey = pageUrlKey(article?.sourceUrl);
    const candidates = [];

    for (const book of Array.isArray(books) ? books : []) {
        if (!book || book.deletedAt) continue;
        const bookId = identity(book.id);
        if (!bookId) continue;
        const bookArticleId = vocabularyBookArticleId(book);
        let tier = 0;
        if (preferredBookId && bookId === preferredBookId) tier = 4;
        else if (ids.has(bookId)) tier = 3;
        else if (bookArticleId && ids.has(bookArticleId)) tier = 2;
        else if (articlePageKey && pageUrlKey(book.sourceUrl) === articlePageKey) tier = 1;
        if (!tier) continue;
        candidates.push({ book, tier });
    }

    return resultFromCandidates(candidates);
}

function candidateKey(article = {}) {
    const id = identity(article.articleId || article.id || article.storageId);
    if (id) return `id:${id}`;
    const url = pageUrlKey(article.sourceUrl);
    return url ? `url:${url}` : '';
}

function addArticleCandidate(map, article, tier, kind) {
    if (!article || article.deletedAt) return;
    const key = candidateKey(article);
    if (!key) return;
    const existing = map.get(key);
    if (!existing) {
        map.set(key, { article, tier, kind });
        return;
    }
    if (tier > existing.tier || (tier === existing.tier && kind === 'record' && existing.kind !== 'record')) {
        map.set(key, { article, tier, kind });
    }
}

/**
 * 從詞書找對應文章。
 *
 * 先看詞書的 articleId 與文章身份（含 storage ID 別名），再看同一頁來源；
 * 也接受文章 meta 上的 linkedBookId 明確反向指向。不以名稱猜測。
 */
export function matchArticleForVocabularyBook(book = {}, { articles = [], metas = [] } = {}) {
    const bookId = identity(book?.id);
    const articleId = vocabularyBookArticleId(book);
    const bookPageKey = pageUrlKey(book?.sourceUrl);
    const map = new Map();

    const consider = (article, kind) => {
        if (!article) return;
        const ids = articleIdentityIds(article);
        const linkedBookId = identity(article.linkedBookId || article.bookId);
        let tier = 0;
        if (bookId && linkedBookId === bookId) tier = 4;
        else if (articleId && ids.has(articleId)) tier = 3;
        else if (bookId && ids.has(bookId)) tier = 3;
        else if (bookPageKey && pageUrlKey(article.sourceUrl) === bookPageKey) tier = 1;
        if (tier) addArticleCandidate(map, article, tier, kind);
    };

    for (const article of Array.isArray(articles) ? articles : []) consider(article, 'record');
    for (const meta of Array.isArray(metas) ? metas : []) consider(meta, 'meta');

    return resultFromCandidates(Array.from(map.values()));
}
