import * as state from './state.js';

// =================================
// 本地存儲管理 (LocalStorage)
// =================================

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
}

/**
 * 從 localStorage 加載單詞本數據。
 * 如果沒有數據，則創建一個默認的單詞本。
 * 同時包含一個數據遷移邏輯，用於清理舊數據格式。
 */
export function loadVocabularyBooks() {
    const saved = localStorage.getItem('vocabularyBooks');
    let books = saved ? JSON.parse(saved) : [];

    if (books.length === 0) {
        // 如果沒有數據，創建一個預設的
        books.push({
            id: Date.now().toString(),
            name: '我的第一個單詞本',
            words: []
        });
    } else {
        // 資料遷移和清理：遍歷所有單詞並標準化音標格式
        let dataWasModified = false;
        books.forEach(book => {
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
            localStorage.setItem('vocabularyBooks', JSON.stringify(books));
        }
    }

    state.setVocabularyBooks(books);
    loadAppState(); // 加載完書籍後，加載應用狀態（依賴書籍數據）
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
}

/**
 * 從 localStorage 加載已分析的文章列表。
 */
export function loadAnalyzedArticles() {
    const saved = localStorage.getItem('analyzedArticles');
    const articles = saved ? JSON.parse(saved) : [];
    state.setAnalyzedArticles(articles);
}

/**
 * 保存單個文章的分析結果。
 * 如果已存在，則更新；否則，新增。
 * @param {string} article - 文章原文
 * @param {object} result - 分析結果對象
 */
export function saveAnalysisResult(article, result) {
    const articles = [...state.analyzedArticles];
    const existingIndex = articles.findIndex(item => item.article === article);
    if (existingIndex > -1) {
        articles[existingIndex].result = result;
    } else {
        articles.push({ article, result });
    }
    state.setAnalyzedArticles(articles);
    saveAnalyzedArticles(); // 持久化到localStorage
}
