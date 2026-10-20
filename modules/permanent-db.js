// 共同永久資料庫（bdc-articles）。
//
// 文章、學習條目、詞書、關聯、文章文件、會話與消息全部放在同一個
// IndexedDB 資料庫，才能讓「實體變更 + outbox」在同一次交易提交。
// article-store 與 reading-store 都透過這裡開庫，避免兩個模組用不同版本
// 開啟同一個資料庫而互相阻塞。
//
// 對外只提供低階交易與批次操作；業務規則留在 article-store / reading-store。

import { contentVersionOf } from '../shared/reading-protocol.mjs';

export const PERMANENT_DB_NAME = 'bdc-articles';
export const PERMANENT_DB_VERSION = 3;

export const STORE = {
    DOCS: 'docs',
    ARTICLE_SUMMARIES: 'article_summaries',
    OUTBOX: 'outbox',
    STATE: 'state',
    DRAFTS: 'drafts',
    READING_ITEMS: 'reading_items',
    ARTICLE_DOCUMENTS: 'article_documents',
    VOCAB_BOOKS: 'vocab_books',
    VOCAB_ENTRIES: 'vocab_entries',
    VOCAB_LINKS: 'vocab_links',
    CONVERSATIONS: 'conversations',
    MESSAGES: 'messages',
    READING_OUTBOX: 'reading_outbox',
    READING_STATE: 'reading_state',
    ARTICLE_VERSIONS: 'article_versions'
};

let dbPromise = null;

function createKeyedStore(db, name, indexes = []) {
    if (db.objectStoreNames.contains(name)) return null;
    const store = db.createObjectStore(name, { keyPath: 'key' });
    for (const [indexName, keyPath, options] of indexes) {
        try { store.createIndex(indexName, keyPath, options || { unique: false }); } catch (_) {}
    }
    return store;
}

/** 文章列表只需要的摘要；不得包含全文或完整分析。 */
export function summarizeArticleDoc(doc) {
    if (!doc || !doc.id) return null;
    const analysis = doc.analysis && typeof doc.analysis === 'object' ? doc.analysis : null;
    const paragraphs = Array.isArray(analysis?.paragraph_analysis) ? analysis.paragraph_analysis : [];
    let failedParagraphs = 0;
    for (const item of paragraphs) {
        if (!item || item.skipped) continue;
        if (item.failed === true || !String(item.chinese_translation || '').trim()) failedParagraphs += 1;
    }
    const body = String(doc.body || '');
    return {
        key: doc.key,
        scope: doc.scope,
        articleId: doc.id,
        title: doc.title || '',
        excerpt: body.replace(/\s+/g, ' ').trim().slice(0, 240),
        sourceType: doc.sourceType || 'paste',
        sourceUrl: doc.sourceUrl || '',
        revision: Number(doc.revision) || 0,
        createdAt: doc.createdAt || '',
        updatedAt: doc.updatedAt || '',
        lastOpenedAt: doc.lastOpenedAt || '',
        deletedAt: doc.deletedAt || '',
        dirty: !!doc.dirty,
        pending: !!doc.pending,
        conflict: doc.conflict || null,
        sizeBytes: Number(doc.sizeBytes) || 0,
        bodyChars: body.length,
        contentVersion: contentVersionOf(body),
        analysisChars: analysis ? JSON.stringify(analysis).length : 0,
        hasAnalysis: !!analysis,
        failedParagraphs,
        summaryOnly: true
    };
}

export function openPermanentDb() {
    if (typeof indexedDB === 'undefined') return Promise.resolve(null);
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
        let request;
        try {
            request = indexedDB.open(PERMANENT_DB_NAME, PERMANENT_DB_VERSION);
        } catch (_) {
            resolve(null);
            return;
        }
        request.onupgradeneeded = (event) => {
            const db = request.result;
            const oldVersion = Number(event.oldVersion) || 0;
            createKeyedStore(db, STORE.DOCS, [['scope', 'scope']]);
            const summaryStore = createKeyedStore(db, STORE.ARTICLE_SUMMARIES, [
                ['scope', 'scope'],
                ['scope_article', ['scope', 'articleId']]
            ]);
            if (summaryStore && oldVersion > 0 && db.objectStoreNames.contains(STORE.DOCS)) {
                // 舊版只有完整文章；升級時建立摘要索引，只搬必要欄位。
                const docs = request.transaction.objectStore(STORE.DOCS);
                const cursor = docs.openCursor();
                cursor.onsuccess = () => {
                    const row = cursor.result;
                    if (!row) return;
                    const summary = summarizeArticleDoc(row.value);
                    if (summary) summaryStore.put(summary);
                    row.continue();
                };
            }
            createKeyedStore(db, STORE.OUTBOX, [['scope', 'scope']]);
            if (!db.objectStoreNames.contains(STORE.STATE)) db.createObjectStore(STORE.STATE, { keyPath: 'scope' });
            if (!db.objectStoreNames.contains(STORE.DRAFTS)) db.createObjectStore(STORE.DRAFTS, { keyPath: 'scope' });
            createKeyedStore(db, STORE.READING_ITEMS, [
                ['scope', 'scope'],
                ['scope_article', ['scope', 'articleId']]
            ]);
            createKeyedStore(db, STORE.ARTICLE_DOCUMENTS, [
                ['scope', 'scope'],
                ['scope_article', ['scope', 'articleId']]
            ]);
            createKeyedStore(db, STORE.VOCAB_BOOKS, [['scope', 'scope']]);
            createKeyedStore(db, STORE.VOCAB_ENTRIES, [
                ['scope', 'scope'],
                ['scope_book', ['scope', 'bookId']]
            ]);
            createKeyedStore(db, STORE.VOCAB_LINKS, [
                ['scope', 'scope'],
                ['scope_item', ['scope', 'itemId']],
                ['scope_entry', ['scope', 'entryId']]
            ]);
            createKeyedStore(db, STORE.CONVERSATIONS, [
                ['scope', 'scope'],
                ['scope_article', ['scope', 'articleId']]
            ]);
            createKeyedStore(db, STORE.MESSAGES, [
                ['scope', 'scope'],
                ['conversation', 'conversationId'],
                ['scope_conversation', ['scope', 'conversationId']]
            ]);
            createKeyedStore(db, STORE.READING_OUTBOX, [['scope', 'scope']]);
            if (!db.objectStoreNames.contains(STORE.READING_STATE)) db.createObjectStore(STORE.READING_STATE, { keyPath: 'scope' });
            createKeyedStore(db, STORE.ARTICLE_VERSIONS, [
                ['scope', 'scope'],
                ['scope_article', ['scope', 'articleId']]
            ]);
        };
        request.onsuccess = () => {
            const db = request.result;
            try {
                db.onversionchange = () => {
                    try { db.close(); } catch (_) {}
                    if (dbPromise) dbPromise = null;
                };
                db.onclose = () => { if (dbPromise) dbPromise = null; };
            } catch (_) {}
            resolve(db);
        };
        request.onerror = () => {
            // 失敗不能永久快取一個 null 連線；下次呼叫要能重新嘗試。
            dbPromise = null;
            resolve(null);
        };
        request.onblocked = () => {
            dbPromise = null;
            resolve(null);
        };
    });
    return dbPromise;
}

function requestPromise(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('idb_request_failed'));
    });
}

export { requestPromise };

/**
 * 在一個交易中執行多個 store 操作。
 *
 * `work` 必須同步地發出所有 IDB request（可回傳 Promise 包裝的 request），
 * 交易完成後才解析。這正是「實體 + outbox 同交易」的基礎：任何一個
 * request 失敗或交易 abort，都不會留下只寫了一半的狀態。
 *
 * operations 形狀：`[{ store, type: 'put'|'delete', value, key }]`
 */
export async function runPermanentTransaction(storeNames, mode, work) {
    const db = await openPermanentDb();
    if (!db) return { ok: false, error: 'idb_unavailable' };
    const names = Array.from(new Set(storeNames));
    return new Promise((resolve) => {
        let tx;
        try {
            tx = db.transaction(names, mode);
        } catch (_) {
            resolve({ ok: false, error: 'idb_transaction_failed' });
            return;
        }
        const stores = {};
        for (const name of names) stores[name] = tx.objectStore(name);
        let pending;
        try {
            pending = work(stores, tx);
            // 交易 abort 時個別 request 會 reject；先掛 catch，避免瀏覽器
            // 把它當成未處理的 promise rejection（畫面會出現 AbortError）。
            // 工作 Promise 失敗時也要主動 abort，否則沒有 pending request 的
            // 交易可能先提交，留下「回報失敗但已寫入」或 value=null。
            if (pending && typeof pending.catch === 'function') {
                pending.catch(() => {
                    try { tx.abort(); } catch (_) {}
                });
            }
        } catch (error) {
            try { tx.abort(); } catch (_) {}
            resolve({ ok: false, error: 'idb_work_failed', detail: error && (error.name + ': ' + error.message) });
            return;
        }
        tx.oncomplete = async () => {
            let value = pending;
            if (pending && typeof pending.then === 'function') {
                try { value = await pending; } catch (_) { value = null; }
            }
            resolve({ ok: true, value });
        };
        tx.onerror = () => {
            if (pending && typeof pending.catch === 'function') pending.catch(() => {});
            resolve({ ok: false, error: 'idb_write_failed' });
        };
        tx.onabort = () => {
            if (pending && typeof pending.catch === 'function') pending.catch(() => {});
            resolve({ ok: false, error: 'idb_aborted' });
        };
    });
}

export async function applyPermanentOperations(operations, options = {}) {
    const list = Array.isArray(operations) ? operations.filter(Boolean) : [];
    if (!list.length) return { ok: true };
    const stores = Array.from(new Set(list.map((op) => op.store)));
    return runPermanentTransaction(stores, options.mode || 'readwrite', (handles, tx) => {
        const pending = [];
        let failure = null;
        for (const op of list) {
            const store = handles[op.store];
            if (!store) continue;
            try {
                const request = op.type === 'delete' ? store.delete(op.key) : store.put(op.value);
                const promise = requestPromise(request);
                // put 可能同步丟出 DataCloneError；已建立的 request 仍可能
                // 在 abort 時 reject，先掛 catch 避免 unhandled rejection。
                promise.catch(() => {});
                pending.push(promise);
            } catch (error) {
                failure = error;
                break;
            }
        }
        if (failure) {
            try { tx.abort(); } catch (_) {}
            throw failure;
        }
        return Promise.all(pending);
    });
}

export async function readStoreAll(storeName, scope = '') {
    const result = await runPermanentTransaction([storeName], 'readonly', (stores) => {
        const store = stores[storeName];
        if (scope && store.indexNames.contains('scope')) {
            return requestPromise(store.index('scope').getAll(scope));
        }
        return requestPromise(store.getAll());
    });
    if (!result.ok) return { ok: false, error: result.error, records: [] };
    const records = Array.isArray(result.value) ? result.value : [];
    return { ok: true, records: scope ? records.filter((item) => item && item.scope === scope) : records };
}

export async function readStoreOne(storeName, key) {
    const result = await runPermanentTransaction([storeName], 'readonly', (stores) => requestPromise(stores[storeName].get(key)));
    if (!result.ok) return { ok: false, error: result.error, value: null };
    return { ok: true, value: result.value || null };
}

export async function readStoreByIndex(storeName, indexName, value) {
    const result = await runPermanentTransaction([storeName], 'readonly', (stores) => {
        const store = stores[storeName];
        if (!store.indexNames.contains(indexName)) return Promise.resolve([]);
        return requestPromise(store.index(indexName).getAll(value));
    });
    if (!result.ok) return { ok: false, error: result.error, records: [] };
    return { ok: true, records: Array.isArray(result.value) ? result.value : [] };
}

export async function countStore(storeName, scope = '') {
    const result = await runPermanentTransaction([storeName], 'readonly', (stores) => {
        const store = stores[storeName];
        if (scope && store.indexNames.contains('scope')) {
            return requestPromise(store.index('scope').count(scope));
        }
        return requestPromise(store.count());
    });
    return result.ok ? Number(result.value) || 0 : 0;
}
