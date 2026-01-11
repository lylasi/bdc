import * as state from './state.js';
import { touch as syncTouch } from './sync-signals.js';

// =================================
// 本地存儲管理 (LocalStorage)
// =================================

// 文章 metadata 存儲 key
const ARTICLE_METAS_KEY = 'articleMetas';

// --- ArticleMeta helpers ---

function generateArticleShareId() {
    return `art_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function readArticleMetasMap() {
    try {
        const raw = localStorage.getItem(ARTICLE_METAS_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        // 僅接受物件類型，避免舊資料污染
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) {
        return {};
    }
}

function writeArticleMetasMap(map) {
    try {
        localStorage.setItem(ARTICLE_METAS_KEY, JSON.stringify(map));
        try { syncTouch('articles'); } catch (_) {}
    } catch (_) {
        // 保守處理，避免因 localStorage 錯誤導致應用崩潰
    }
}

/**
 * 依 ID 取得單一文章 metadata。
 */
export function getArticleMetaById(articleId) {
    if (!articleId) return null;
    const map = readArticleMetasMap();
    const meta = map[articleId];
    return meta || null;
}

/**
 * 取得全部文章 metadata 列表。
 */
export function getAllArticleMetas() {
    const map = readArticleMetasMap();
    return Object.values(map);
}

/**
 * 新增或更新文章 metadata。
 */
export function saveArticleMeta(articleMeta) {
    if (!articleMeta || !articleMeta.id) return null;
    const map = readArticleMetasMap();
    const normalized = {
        ...articleMeta,
        createdAt: typeof articleMeta.createdAt === 'number'
            ? articleMeta.createdAt
            : Date.now()
    };
    if (!normalized.shareId) {
        normalized.shareId = generateArticleShareId();
    }
    map[normalized.id] = normalized;
    writeArticleMetasMap(map);
    return normalized;
}

/**
 * 依 URL 尋找文章 metadata（僅 sourceType = 'url'）。
 */
export function findArticleMetaByUrl(url) {
    if (!url) return null;
    const metas = getAllArticleMetas();
    const normalizedUrl = String(url).trim();
    return metas.find(m => m && m.sourceType === 'url' && m.sourceUrl === normalizedUrl) || null;
}

// --- 單詞本存儲 ---

/**
 * 將當前的單詞本數據保存到 localStorage。
 */
export function saveVocabularyBooks(options = {}) {
    // options: { preserveUpdatedAt?: boolean, updatedAtOverride?: string }
    localStorage.setItem('vocabularyBooks', JSON.stringify(state.vocabularyBooks));
    try {
        const key = 'vocabularyUpdatedAt';
        if (options && typeof options.updatedAtOverride === 'string' && options.updatedAtOverride) {
            localStorage.setItem(key, options.updatedAtOverride);
        } else if (!options || options.preserveUpdatedAt !== true) {
            localStorage.setItem(key, new Date().toISOString());
        }
    } catch (_) { /* ignore quota errors */ }
    try { syncTouch('vocabulary'); } catch (_) {}
}

/**
 * 從 localStorage 加載單詞本數據。
 * 注意：不再自動建立任何預設單詞本，保持為空以引導使用者自行「導入 / 新建」。
 * 同時包含一個數據遷移邏輯，用於清理舊數據格式。
 */
export function loadVocabularyBooks() {
    const saved = localStorage.getItem('vocabularyBooks');
    let books = saved ? JSON.parse(saved) : [];

    if (books.length > 0) {
        // 資料遷移和清理：遍歷所有單詞並標準化音標格式，同時補齊生詞本 metadata
        let dataWasModified = false;
        books.forEach(book => {
            if (book && typeof book === 'object') {
                // 若缺少來源類型，視為舊資料（legacy）
                if (!book.sourceType) {
                    book.sourceType = 'legacy';
                    dataWasModified = true;
                }
                // 若缺少建立時間，補上一個合理的預設值
                if (!book.createdAt) {
                    try {
                        book.createdAt = new Date().toISOString();
                        dataWasModified = true;
                    } catch (_) { /* ignore */ }
                }
                // 若缺少共享用唯一 ID，則補上一個
                if (!book.shareId) {
                    book.shareId = generateBookShareId();
                    dataWasModified = true;
                }
            }

            if (book.words && Array.isArray(book.words)) {
                book.words.forEach(word => {
                    if (word.phonetic && typeof word.phonetic === 'string') {
                        const originalPhonetic = word.phonetic;
                        const cleanedPhonetic = originalPhonetic.replace(/^\/+|\/+$/g, '');
                        if (originalPhonetic !== cleanedPhonetic) {
                            word.phonetic = cleanedPhonetic;
                            dataWasModified = true;
                        }
                    }
                });
            }
        });
        // 如果資料被修改過，就立即存回localStorage
        if (dataWasModified) {
            // 僅在資料被修正時才回寫，避免無謂的寫入
            localStorage.setItem('vocabularyBooks', JSON.stringify(books));
        }
    }

    state.setVocabularyBooks(books);
    loadAppState(); // 加載完書籍後，加載應用狀態（依賴書籍數據）
}

function generateBookShareId() {
    return `wb_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function ensureBookShareId(book) {
    if (!book || typeof book !== 'object') return book;
    if (!book.shareId) {
        book.shareId = generateBookShareId();
    }
    return book;
}

/**
 * 依 ID 取得生詞本。
 */
export function getWordbookById(wordbookId) {
    if (!wordbookId) return null;
    const book = state.vocabularyBooks.find(b => b.id === wordbookId) || null;
    return book ? ensureBookShareId(book) : null;
}

/**
 * 取得所有生詞本。
 */
export function getAllWordbooks() {
    const books = Array.isArray(state.vocabularyBooks) ? state.vocabularyBooks : [];
    return books.map(b => ensureBookShareId(b));
}

/**
 * 新增或更新生詞本，並持久化。
 */
export function saveWordbook(wordbook, options = {}) {
    if (!wordbook || !wordbook.id) return null;
    const normalizedBook = ensureBookShareId({ ...wordbook });
    const books = Array.isArray(state.vocabularyBooks) ? [...state.vocabularyBooks] : [];
    const index = books.findIndex(b => b.id === normalizedBook.id);
    if (index === -1) {
        books.push(normalizedBook);
    } else {
        books[index] = normalizedBook;
    }
    state.setVocabularyBooks(books);
    saveVocabularyBooks(options);
    return normalizedBook;
}

/**
 * 取得某個生詞本底下的所有單字。
 */
export function getWordsByWordbookId(wordbookId) {
    const book = getWordbookById(wordbookId);
    if (!book || !Array.isArray(book.words)) return [];
    return book.words;
}

function generateWordEntryId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 在指定生詞本底下新增單字。
 * wordPayload 不需要包含 id / wordbookId，會在此處補上。
 */
export function addWordToWordbook(wordbookId, wordPayload) {
    const book = getWordbookById(wordbookId);
    if (!book) {
        throw new Error(`找不到 ID 為 ${wordbookId} 的生詞本，無法新增單字。`);
    }
    const words = Array.isArray(book.words) ? [...book.words] : [];
    const id = wordPayload && wordPayload.id ? wordPayload.id : generateWordEntryId();
    const newWord = {
        ...wordPayload,
        id,
        wordbookId
    };
    words.push(newWord);
    const nextBook = { ...book, words };
    saveWordbook(nextBook);
    return newWord;
}

/**
 * 更新指定生詞本中的單字。
 */
export function updateWordInWordbook(wordbookId, wordEntry) {
    if (!wordEntry || !wordEntry.id) return null;
    const book = getWordbookById(wordbookId);
    if (!book || !Array.isArray(book.words)) return null;
    const words = [...book.words];
    const index = words.findIndex(w => w.id === wordEntry.id);
    if (index === -1) return null;
    words[index] = { ...words[index], ...wordEntry };
    const nextBook = { ...book, words };
    saveWordbook(nextBook);
    return words[index];
}

/**
 * 從生詞本刪除單字。
 */
export function removeWordFromWordbook(wordbookId, wordEntryId) {
    const book = getWordbookById(wordbookId);
    if (!book || !Array.isArray(book.words)) return;
    const words = book.words;
    const nextWords = words.filter(w => w.id !== wordEntryId);
    if (nextWords.length === words.length) return;
    const nextBook = { ...book, words: nextWords };
    saveWordbook(nextBook);
}

/**
 * 確保文章專屬生詞本存在：
 * - 生成或查找 ArticleMeta
 * - 生成或查找對應的生詞本（id = articleId）
 * - 更新當前文章 / 生詞本上下文
 * 回傳 { articleMeta, wordbook }
 */
export function getOrCreateArticleWordbook(articleMetaInput, options = {}) {
    const createWordbook = options.createWordbook !== false;
    if (!articleMetaInput || !articleMetaInput.title || !articleMetaInput.sourceType) {
        throw new Error('getOrCreateArticleWordbook 需要有效的 articleMetaInput（至少包含 title 與 sourceType）');
    }

    const sourceType = articleMetaInput.sourceType;
    const sourceUrl = articleMetaInput.sourceUrl;
    let articleMeta = null;

    // 1. 先處理 ID 與已有的 ArticleMeta
    if (articleMetaInput.id) {
        const existing = getArticleMetaById(articleMetaInput.id);
        articleMeta = {
            ...existing,
            ...articleMetaInput,
            id: articleMetaInput.id
        };
    } else if (sourceType === 'url' && sourceUrl) {
        // URL 來源：盡量重用既有 meta
        const existingByUrl = findArticleMetaByUrl(sourceUrl);
        if (existingByUrl) {
            articleMeta = {
                ...existingByUrl,
                ...articleMetaInput,
                id: existingByUrl.id
            };
        } else {
            const encoded = encodeURIComponent(String(sourceUrl).trim());
            articleMeta = {
                ...articleMetaInput,
                id: `url:${encoded}`
            };
        }
    } else {
        // 其他來源：生成 local: 開頭的 id
        const randomId = `local:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        articleMeta = {
            ...articleMetaInput,
            id: randomId
        };
    }

    if (typeof articleMeta.createdAt !== 'number') {
        articleMeta.createdAt = Date.now();
    }

    articleMeta = saveArticleMeta(articleMeta);

    // 2. 確保文章專屬生詞本存在（id = articleMeta.id）
    const wordbookId = articleMeta.id;
    const existingBook = getWordbookById(wordbookId);

    const nowIso = new Date().toISOString();
    let nextBook;

    if (existingBook) {
        nextBook = {
            ...existingBook,
            sourceType: existingBook.sourceType || 'article',
            articleId: existingBook.articleId || articleMeta.id,
            name: existingBook.name || articleMeta.title,
            createdAt: existingBook.createdAt || nowIso
        };
    } else if (createWordbook) {
        nextBook = {
            id: wordbookId,
            name: articleMeta.title || '未命名文章',
            words: [],
            sourceType: 'article',
            articleId: articleMeta.id,
            createdAt: nowIso
        };
    } else {
        nextBook = null;
    }

    const savedBook = nextBook ? saveWordbook(nextBook) : null;

    // 3. 更新當前上下文
    try {
        if (typeof state.setCurrentArticleId === 'function') {
            state.setCurrentArticleId(articleMeta.id);
        }
        if (typeof state.setCurrentWordbookId === 'function') {
            const wbId = (savedBook || existingBook || {}).id || null;
            state.setCurrentWordbookId(wbId);
        }
    } catch (_) { /* ignore */ }

    return { articleMeta, wordbook: savedBook || existingBook || null };
}

// --- 應用程序狀態存儲 ---

/**
 * 保存當前激活的單詞本ID。
 */
export function saveAppState(options = {}) {
    localStorage.setItem('activeBookId', state.activeBookId);
    // 變更當前書視為 vocabulary 分組的變更
    try {
        const key = 'vocabularyUpdatedAt';
        if (options && typeof options.updatedAtOverride === 'string' && options.updatedAtOverride) {
            localStorage.setItem(key, options.updatedAtOverride);
        } else if (!options || options.preserveUpdatedAt !== true) {
            localStorage.setItem(key, new Date().toISOString());
        }
    } catch (_) { /* ignore */ }
    try { syncTouch('vocabulary'); } catch (_) {}
}

/**
 * 加載上次激活的單詞本ID。
 * 如果找不到或無效，則默認選擇第一個單詞本。
 */
export function loadAppState() {
    const savedId = localStorage.getItem('activeBookId');
    if (savedId && state.vocabularyBooks.some(b => b.id === savedId)) {
        state.setActiveBookId(savedId);
    } else if (state.vocabularyBooks.length > 0) {
        state.setActiveBookId(state.vocabularyBooks[0].id);
    } else {
        state.setActiveBookId(null);
    }
}

// --- 文章分析歷史記錄存儲 ---

/**
 * 保存已分析的文章列表。
 */
export function saveAnalyzedArticles(options = {}) {
    localStorage.setItem('analyzedArticles', JSON.stringify(state.analyzedArticles));
    try {
        const key = 'articlesUpdatedAt';
        if (options && typeof options.updatedAtOverride === 'string' && options.updatedAtOverride) {
            localStorage.setItem(key, options.updatedAtOverride);
        } else if (!options || options.preserveUpdatedAt !== true) {
            localStorage.setItem(key, new Date().toISOString());
        }
    } catch (_) { /* ignore */ }
    try { syncTouch('articles'); } catch (_) {}
}

/**
 * 從 localStorage 加載已分析的文章列表。
 */
export function loadAnalyzedArticles() {
    const saved = localStorage.getItem('analyzedArticles');
    const articles = saved ? JSON.parse(saved) : [];
    state.setAnalyzedArticles(articles);
}

// --- 默寫 AI 批改歷史（LocalStorage） ---
const GRADING_HISTORY_KEY = 'dictationGradingHistory';

export function getGradingHistory() {
    try {
        const raw = localStorage.getItem(GRADING_HISTORY_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch (_) { return []; }
}

export function saveGradingRecord(record) {
    const list = getGradingHistory();
    // ensure id
    const id = record && record.id ? record.id : `${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    const createdAt = record && record.createdAt ? record.createdAt : new Date().toISOString();
    const normalized = { id, createdAt, ...record };
    list.unshift(normalized);
    try { localStorage.setItem(GRADING_HISTORY_KEY, JSON.stringify(list.slice(0, 200))); } catch (_) {}
    try { syncTouch('dictation'); } catch (_) {}
    return normalized;
}

export function deleteGradingRecord(id) {
    const list = getGradingHistory();
    const next = list.filter(x => x.id !== id);
    try { localStorage.setItem(GRADING_HISTORY_KEY, JSON.stringify(next)); } catch (_) {}
    try { syncTouch('dictation'); } catch (_) {}
}

export function clearGradingHistory() {
    try { localStorage.removeItem(GRADING_HISTORY_KEY); } catch (_) {}
    try { syncTouch('dictation'); } catch (_) {}
}

/**
 * 保存單個文章的分析結果。
 * 如果已存在，則更新；否則，新增。
 * @param {string} article - 文章原文
 * @param {object} result - 分析結果對象
 * @param {object} [extra] - 額外資訊（例如 { articleId }）
 */
export function saveAnalysisResult(article, result, extra = {}) {
    const articles = [...state.analyzedArticles];
    const articleId = extra && extra.articleId ? String(extra.articleId) : null;
    let existingIndex = -1;
    if (articleId) {
        existingIndex = articles.findIndex(item => item && item.articleId === articleId);
    }
    if (existingIndex === -1) {
        existingIndex = articles.findIndex(item => item && item.article === article);
    }

    const base = { article, result };
    if (articleId) {
        base.articleId = articleId;
    }

    if (existingIndex > -1) {
        articles[existingIndex] = { ...articles[existingIndex], ...base };
    } else {
        articles.push(base);
    }
    state.setAnalyzedArticles(articles);
    saveAnalyzedArticles(); // 持久化到localStorage（會觸發 articlesUpdatedAt）
    try { syncTouch('articles'); } catch (_) {}
}
