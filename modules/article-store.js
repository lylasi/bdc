// 文章逐篇文章儲存（IndexedDB，local-first）。
//
// 資料邊界：
//   * 每篇文章一份文件，不再放在同一個大 JSON 裡。
//   * 所有資料以 `同步端點 + user_id` 隔離，訪客另用 `guest` 範圍；換帳戶時
//     舊範圍的文件與待同步操作都不會被上傳給新帳戶。
//   * 本機修改立刻生效並寫入 outbox，同步失敗不會回捲使用者已看到的內容。
//
// 對外契約：
//   - `state.analyzedArticles` 仍是功能模組唯一讀取的清單（沿用舊欄位
//     `articleId` / `article` / `result`），啟動時由這裡一次 hydrate。
//   - 寫入一律經過本模組，並同步維護 outbox 與 revision。
//   - 讀寫失敗會回報 `{ ok: false, error }`，不得假裝成功。

import * as state from './state.js';
import { SYNC } from '../ai-config.js';
import {
    ARTICLE_LIMITS,
    articleSizeBytes,
    generateArticleId,
    normalizeSourceType,
    parseAnalysis
} from '../shared/article-protocol.mjs';
import { contentVersionOf } from '../shared/reading-protocol.mjs';
import {
    openPermanentDb,
    applyPermanentOperations,
    summarizeArticleDoc,
    STORE
} from './permanent-db.js';

const STORE_DOCS = STORE.DOCS;
const STORE_ARTICLE_SUMMARIES = STORE.ARTICLE_SUMMARIES;
const STORE_OUTBOX = STORE.OUTBOX;
const STORE_STATE = STORE.STATE;
const STORE_DRAFTS = STORE.DRAFTS;
const FALLBACK_PREFIX = 'bdc:articles:fallback:v1:';
const MIGRATION_MARKER_PREFIX = 'bdc:articles:migrated:v1:';
const TOKEN_KEY = 'sync_token';
const USER_ID_KEY = 'sync_user_id';

let dbPromise = null;
let fallbackMode = false;
let currentScope = '';
// 每次真正切換 scope 就遞增；非同步工作完成後必須同時核對 scope 與世代，
// 才能避免 A→B→A 時舊任務誤以為仍在原本帳戶。
let scopeGeneration = 0;
let meta = {
    cursor: 0,
    migrated: false,
    migratedAt: '',
    lastSyncAt: '',
    lastError: '',
    conflicts: {},
    gatePending: false,
    persistenceError: ''
};
let opSeq = 0;
// 每次本機寫入提交就遞增；同一 scope 的 reload 若在讀取期間有新寫入，
// 必須重新讀一次，不能用較早的摘要覆蓋剛保存的內容。
let dataEpoch = 0;
// 目前 scope 已載入全文的文章；正常啟動只有清單摘要，開文章才補這一篇。
const loadedDocs = new Map();
const loadingDocs = new Map();
// 已載入過的全文依 scope 快取。切帳戶再切回來時可還原已讀文章，
// 但不預先讀取其他文章；只有 contentVersion 仍一致才使用。
const docCache = new Map();
const DOC_CACHE_LIMIT = 60;

function cacheDoc(doc) {
    if (!doc || !doc.scope || !doc.id) return;
    const key = docKey(doc.scope, doc.id);
    docCache.delete(key);
    docCache.set(key, doc);
    while (docCache.size > DOC_CACHE_LIMIT) {
        const oldest = docCache.keys().next().value;
        docCache.delete(oldest);
    }
}

function cachedDoc(scope, summary) {
    if (!summary || !summary.articleId) return null;
    const doc = docCache.get(docKey(scope, summary.articleId));
    if (!doc || doc.deletedAt) return null;
    if (contentVersionOf(doc.body || '') !== summary.contentVersion) return null;
    return doc;
}

// ─────────────────────────────────────────────────────────────────────────────
// 範圍（endpoint + user）
// ─────────────────────────────────────────────────────────────────────────────

function endpoint() {
    const override = (typeof globalThis !== 'undefined' && typeof globalThis.__BDC_SYNC_ENDPOINT__ === 'string')
        ? globalThis.__BDC_SYNC_ENDPOINT__
        : '';
    const url = override || ((SYNC && SYNC.endpoint) ? String(SYNC.endpoint) : '');
    return url.replace(/\/+$/, '');
}

function storedUser() {
    try { return localStorage.getItem(USER_ID_KEY) || ''; } catch (_) { return ''; }
}

export function getArticleScope() {
    return currentScope || `${endpoint() || 'local'}::${storedUser() || 'guest'}`;
}

export function getScopeGeneration() {
    return scopeGeneration;
}

/** 非同步入口同步捕捉 scope 與世代；所有 await 後只能使用這份上下文。 */
export function captureArticleContext(extra = {}) {
    return { scope: getArticleScope(), generation: scopeGeneration, ...extra };
}

export function isArticleContextActive(ctx) {
    if (!ctx || !ctx.scope) return false;
    return ctx.scope === getArticleScope() && ctx.generation === scopeGeneration;
}

function staleResult(extra = {}) {
    return { ok: false, error: 'stale_scope', staleScope: true, ...extra };
}

export function isGuestScope() {
    return !storedUser();
}

export function getGuestScope() {
    return `${endpoint() || 'local'}::guest`;
}

function scopeIsLoggedIn() {
    try { return !!(localStorage.getItem(TOKEN_KEY) && localStorage.getItem(USER_ID_KEY)); } catch (_) { return false; }
}

function migrationMarkerKey(scope) {
    return `${MIGRATION_MARKER_PREFIX}${scope}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// IndexedDB
// ─────────────────────────────────────────────────────────────────────────────

function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = openPermanentDb();
    return dbPromise;
}

/**
 * 在指定 object store（可多個）上執行一次交易。
 * `run(storeOrStores)` 可以回傳 null（寫入）或一個 Promise（讀取／讀改寫），
 * 交易完成後才解析；同步丟出的例外會主動 abort，不留下半套寫入。
 * 傳入 guard 時，交易建立／發出 request 前會再核對 scope 與世代。
 */
async function idbRequest(storeNames, mode, run, guard = null) {
    const db = await openDb();
    if (!db) return { ok: false, error: 'idb_unavailable' };
    if (guard && !isArticleContextActive(guard)) return staleResult();
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    return new Promise((resolve) => {
        let tx;
        try {
            tx = db.transaction(names, mode);
        } catch (error) {
            resolve({ ok: false, error: 'idb_transaction_failed' });
            return;
        }
        const stores = {};
        for (const name of names) stores[name] = tx.objectStore(name);
        // 交易建立後、真正發出 request 前再核對一次；切帳戶後舊工作不得
        // 用新 scope 的 key 寫入。
        if (guard && !isArticleContextActive(guard)) {
            try { tx.abort(); } catch (_) {}
            resolve(staleResult());
            return;
        }
        let pending;
        try {
            pending = run(Array.isArray(storeNames) ? stores : stores[names[0]], tx);
        } catch (error) {
            try { tx.abort(); } catch (_) {}
            resolve({ ok: false, error: 'idb_request_failed', detail: error && (error.name + ': ' + error.message) });
            return;
        }
        if (pending && typeof pending.catch === 'function') {
            // 讀改寫失敗時 abort，不能讓先前的 put 獨自提交。
            pending.catch(() => { try { tx.abort(); } catch (_) {} });
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

function readAll(store) {
    return new Promise((resolve) => {
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => resolve([]);
    });
}

function readOne(store, key) {
    return new Promise((resolve) => {
        const request = store.get(key);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => resolve(null);
    });
}

function docKey(scope, id) {
    return `${scope}\u0000${id}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 本機備援（IndexedDB 不可用時）
// ─────────────────────────────────────────────────────────────────────────────

function fallbackKey(scope) {
    return FALLBACK_PREFIX + scope;
}

function fallbackRead(scope) {
    try {
        const raw = localStorage.getItem(fallbackKey(scope));
        const parsed = raw ? JSON.parse(raw) : null;
        if (parsed && Array.isArray(parsed.docs)) return parsed;
    } catch (_) {}
    return { docs: [], outbox: [], state: {} };
}

function fallbackWrite(scope, data) {
    try {
        localStorage.setItem(fallbackKey(scope), JSON.stringify(data));
        fallbackMode = true;
        return true;
    } catch (_) {
        return false;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 記錄（記憶體 ↔ 儲存）
// ─────────────────────────────────────────────────────────────────────────────

function emitChange() {
    try {
        window.dispatchEvent(new CustomEvent('bdc:articles-change'));
    } catch (_) {}
}

function toSummaryRecord(summary) {
    if (!summary || !summary.articleId) return null;
    return {
        articleId: summary.articleId,
        article: '',
        result: null,
        title: summary.title || '',
        sourceType: summary.sourceType || 'paste',
        sourceUrl: summary.sourceUrl || '',
        revision: Number(summary.revision) || 0,
        createdAt: summary.createdAt || '',
        updatedAt: summary.updatedAt || '',
        lastOpenedAt: summary.lastOpenedAt || '',
        deletedAt: summary.deletedAt || '',
        dirty: !!summary.dirty,
        pending: !!summary.pending,
        conflict: summary.conflict || null,
        sizeBytes: Number(summary.sizeBytes) || 0,
        excerpt: summary.excerpt || '',
        bodyChars: Number(summary.bodyChars) || 0,
        contentVersion: summary.contentVersion || '',
        analysisChars: Number(summary.analysisChars) || 0,
        hasAnalysis: summary.hasAnalysis === true,
        failedParagraphs: Number(summary.failedParagraphs) || 0,
        summaryOnly: true
    };
}

function toRecord(doc) {
    if (!doc) return null;
    return {
        articleId: doc.id,
        article: doc.body,
        result: doc.analysis === undefined ? null : doc.analysis,
        title: doc.title || '',
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
        summaryOnly: false
    };
}

function toDoc(record, scope) {
    return {
        key: docKey(scope, record.articleId),
        scope,
        id: record.articleId,
        title: record.title || '',
        body: record.article || '',
        analysis: record.result === undefined ? null : record.result,
        sourceType: normalizeSourceType(record.sourceType),
        sourceUrl: record.sourceUrl || '',
        revision: Number(record.revision) || 0,
        createdAt: record.createdAt || '',
        updatedAt: record.updatedAt || '',
        lastOpenedAt: record.lastOpenedAt || '',
        deletedAt: record.deletedAt || '',
        dirty: !!record.dirty,
        pending: !!record.pending,
        conflict: record.conflict || null,
        sizeBytes: articleSizeBytes({ body: record.article || '', analysis: record.result })
    };
}

function findRecord(id) {
    return (state.analyzedArticles || []).find((item) => item && item.articleId === id) || null;
}

function replaceRecord(record) {
    const list = [...(state.analyzedArticles || [])];
    const index = list.findIndex((item) => item && item.articleId === record.articleId);
    if (index >= 0) list[index] = { ...list[index], ...record };
    else list.push(record);
    state.setAnalyzedArticles(list);
    return findRecord(record.articleId);
}

function dropRecord(id) {
    const list = (state.analyzedArticles || []).filter((item) => item && item.articleId !== id);
    state.setAnalyzedArticles(list);
}

function fallbackDocWrite(scope, doc, outboxOp = null) {
    const bucket = fallbackRead(scope);
    bucket.docs = (bucket.docs || []).filter((item) => item.id !== doc.id);
    bucket.docs.push(doc);
    if (outboxOp) {
        bucket.outbox = (bucket.outbox || []).filter((item) => item.articleId !== outboxOp.articleId);
        bucket.outbox.push(outboxOp);
    }
    bucket.state = { ...(bucket.state || {}), ...serializeMeta() };
    if (!fallbackWrite(scope, bucket)) {
        meta.persistenceError = 'storage_full';
        return { ok: false, error: 'storage_full' };
    }
    meta.persistenceError = '';
    return { ok: true, doc, ...(outboxOp ? { op: outboxOp } : {}), fallback: true };
}

async function persistDoc(record, ctx = captureArticleContext()) {
    if (!isArticleContextActive(ctx)) return staleResult();
    const scope = ctx.scope;
    const doc = toDoc(record, scope);
    if (fallbackMode) {
        const written = fallbackDocWrite(scope, doc);
        if (written.ok) { dataEpoch += 1; cacheDoc(doc); loadedDocs.set(record.articleId, doc); }
        return written;
    }
    // docs 與 article_summaries 必須在同一個交易：callback 內若 store 不在
    // 交易 scope，會同步拋出 NotFoundError，交易 abort，不能只寫了一半。
    const result = await idbRequest([STORE_DOCS, STORE_ARTICLE_SUMMARIES], 'readwrite', (stores) => {
        stores[STORE_DOCS].put(doc);
        const summary = summarizeArticleDoc(doc);
        if (summary) stores[STORE_ARTICLE_SUMMARIES].put(summary);
        return null;
    }, ctx);
    if (result.ok) {
        dataEpoch += 1;
        loadedDocs.set(record.articleId, doc);
        meta.persistenceError = '';
        return { ok: true, doc };
    }
    if (result.error === 'idb_unavailable') {
        fallbackMode = true;
        const written = fallbackDocWrite(scope, doc);
        if (written.ok) { dataEpoch += 1; loadedDocs.set(record.articleId, doc); }
        return written;
    }
    // 一般交易錯誤只回報失敗，不切換權威來源。
    meta.persistenceError = result.error || 'idb_write_failed';
    return { ok: false, error: meta.persistenceError };
}

async function deleteDoc(id, ctx = captureArticleContext()) {
    if (!isArticleContextActive(ctx)) return staleResult();
    const scope = ctx.scope;
    if (fallbackMode) {
        const bucket = fallbackRead(scope);
        bucket.docs = (bucket.docs || []).filter((item) => item.id !== id);
        const ok = fallbackWrite(scope, bucket);
        if (ok) { dataEpoch += 1; loadedDocs.delete(id); }
        return ok ? { ok: true, fallback: true } : { ok: false, error: 'storage_full' };
    }
    const result = await idbRequest([STORE_DOCS, STORE_ARTICLE_SUMMARIES], 'readwrite', (stores) => {
        stores[STORE_DOCS].delete(docKey(scope, id));
        stores[STORE_ARTICLE_SUMMARIES].delete(docKey(scope, id));
        return null;
    }, ctx);
    if (result.ok) {
        dataEpoch += 1;
        loadedDocs.delete(id);
        docCache.delete(docKey(scope, id));
        meta.persistenceError = '';
        return { ok: true };
    }
    if (result.error === 'idb_unavailable') {
        fallbackMode = true;
        const bucket = fallbackRead(scope);
        bucket.docs = (bucket.docs || []).filter((item) => item.id !== id);
        const ok = fallbackWrite(scope, bucket);
        if (ok) { dataEpoch += 1; loadedDocs.delete(id); }
        return ok ? { ok: true, fallback: true } : { ok: false, error: 'storage_full' };
    }
    meta.persistenceError = result.error || 'idb_write_failed';
    return { ok: false, error: meta.persistenceError };
}

/**
 * 永久文件與待同步操作在同一個 IndexedDB 交易提交。
 * 交易完成才回報成功；IndexedDB 不可用時退回單一 localStorage 桶，
 * 仍是一次寫入（不會出現文件已存、outbox 沒寫的半套狀態）。
 */
async function persistDocWithOp(record, type, options = {}) {
    const ctx = options.ctx || captureArticleContext();
    if (!isArticleContextActive(ctx)) return staleResult();
    const scope = ctx.scope;
    const doc = toDoc(record, scope);
    const op = options.skipOutbox ? null : await buildOutboxOp(record, type, { ...options, scope });
    if (!isArticleContextActive(ctx)) return staleResult();
    if (fallbackMode) {
        const written = fallbackDocWrite(scope, doc, op ? { ...op, key: `${scope}\u0000${op.articleId}`, scope } : null);
        if (written.ok) { dataEpoch += 1; loadedDocs.set(record.articleId, doc); }
        return written;
    }
    const operations = [
        { store: STORE_DOCS, type: 'put', value: doc },
        { store: STORE_ARTICLE_SUMMARIES, type: 'put', value: summarizeArticleDoc(doc) }
    ];
    if (op) {
        operations.push({
            store: STORE_OUTBOX,
            type: 'put',
            value: { ...op, key: `${scope}\u0000${op.articleId}`, scope }
        });
    }
    // 交易內再核對入口 scope：A 儲存期間切到 B（或 A→B→A）都不得再寫。
    const result = await idbRequest(
        Array.from(new Set(operations.map((item) => item.store))),
        'readwrite',
        (stores) => {
            for (const operation of operations) {
                if (operation.type === 'delete') stores[operation.store].delete(operation.key);
                else stores[operation.store].put(operation.value);
            }
            return null;
        },
        ctx
    );
    if (result.ok) {
        dataEpoch += 1;
        cacheDoc(doc);
        loadedDocs.set(record.articleId, doc);
        meta.persistenceError = '';
        return { ok: true, doc, op };
    }
    if (result.error === 'idb_unavailable') {
        fallbackMode = true;
        const payload = op ? { ...op, key: `${scope}\u0000${op.articleId}`, scope } : null;
        const written = fallbackDocWrite(scope, doc, payload);
        if (written.ok) { dataEpoch += 1; cacheDoc(doc); loadedDocs.set(record.articleId, doc); }
        return written;
    }
    meta.persistenceError = result.error || 'idb_write_failed';
    return { ok: false, error: meta.persistenceError };
}

function serializeMeta() {
    return {
        cursor: meta.cursor,
        migrated: meta.migrated,
        migratedAt: meta.migratedAt,
        lastSyncAt: meta.lastSyncAt,
        lastError: meta.lastError,
        conflicts: meta.conflicts,
        gatePending: meta.gatePending
    };
}

async function persistMeta(ctx = captureArticleContext()) {
    if (!isArticleContextActive(ctx)) return staleResult();
    const scope = ctx.scope;
    const payload = { scope, ...serializeMeta() };
    if (fallbackMode) {
        const bucket = fallbackRead(scope);
        bucket.state = payload;
        return fallbackWrite(scope, bucket) ? { ok: true } : { ok: false, error: 'storage_full' };
    }
    const result = await idbRequest(STORE_STATE, 'readwrite', (store) => { store.put(payload); return null; }, ctx);
    if (result.ok) return { ok: true };
    if (result.error === 'idb_unavailable') {
        fallbackMode = true;
        const bucket = fallbackRead(scope);
        bucket.state = payload;
        return fallbackWrite(scope, bucket) ? { ok: true } : { ok: false, error: 'storage_full' };
    }
    return { ok: false, error: result.error };
}

// ─────────────────────────────────────────────────────────────────────────────
// outbox（待同步操作）
// ─────────────────────────────────────────────────────────────────────────────

function nextOpId() {
    opSeq += 1;
    return `${Date.now().toString(36)}-${opSeq.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function makeMutationId() {
    return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

async function readOutbox(scopeOrCtx = captureArticleContext()) {
    const ctx = typeof scopeOrCtx === 'string'
        ? { scope: scopeOrCtx, generation: scopeGeneration }
        : scopeOrCtx;
    const scope = ctx.scope;
    if (fallbackMode) {
        const bucket = fallbackRead(scope);
        return (bucket.outbox || []).filter((op) => op && op.scope === scope);
    }
    const result = await idbRequest(STORE_OUTBOX, 'readonly', (store) => readAll(store));
    if (result.ok) {
        return (result.value || []).filter((op) => op && op.scope === scope);
    }
    if (result.error === 'idb_unavailable') {
        fallbackMode = true;
        const bucket = fallbackRead(scope);
        return (bucket.outbox || []).filter((op) => op && op.scope === scope);
    }
    return [];
}

async function writeOutboxOp(op, ctx = captureArticleContext()) {
    if (!isArticleContextActive(ctx)) return staleResult();
    const scope = ctx.scope;
    const payload = { ...op, key: `${scope}\u0000${op.articleId}`, scope };
    if (fallbackMode) {
        const bucket = fallbackRead(scope);
        bucket.outbox = (bucket.outbox || []).filter((item) => item.articleId !== op.articleId);
        bucket.outbox.push(payload);
        return fallbackWrite(scope, bucket) ? { ok: true } : { ok: false, error: 'storage_full' };
    }
    const result = await idbRequest(STORE_OUTBOX, 'readwrite', (store) => { store.put(payload); return null; }, ctx);
    if (result.ok) return { ok: true };
    if (result.error === 'idb_unavailable') {
        fallbackMode = true;
        const bucket = fallbackRead(scope);
        bucket.outbox = (bucket.outbox || []).filter((item) => item.articleId !== op.articleId);
        bucket.outbox.push(payload);
        return fallbackWrite(scope, bucket) ? { ok: true } : { ok: false, error: 'storage_full' };
    }
    return { ok: false, error: result.error };
}

async function removeOutboxOp(articleId, ctx = captureArticleContext()) {
    if (!isArticleContextActive(ctx)) return staleResult();
    const scope = ctx.scope;
    if (fallbackMode) {
        const bucket = fallbackRead(scope);
        bucket.outbox = (bucket.outbox || []).filter((item) => item.articleId !== articleId);
        return fallbackWrite(scope, bucket) ? { ok: true } : { ok: false, error: 'storage_full' };
    }
    const result = await idbRequest(STORE_OUTBOX, 'readwrite', (store) => { store.delete(docKey(scope, articleId)); return null; }, ctx);
    if (result.ok) return { ok: true };
    if (result.error === 'idb_unavailable') {
        fallbackMode = true;
        const bucket = fallbackRead(scope);
        bucket.outbox = (bucket.outbox || []).filter((item) => item.articleId !== articleId);
        return fallbackWrite(scope, bucket) ? { ok: true } : { ok: false, error: 'storage_full' };
    }
    return { ok: false, error: result.error };
}

/**
 * 每篇文章最多保留一個待同步操作（後寫覆蓋先寫）。建立尚未上傳時仍是 create，
 * 之後的修改只更新內容，不會變成第二次建立。
 */
async function buildOutboxOp(record, type, options = {}) {
    const scope = options.scope || (options.ctx && options.ctx.scope) || getArticleScope();
    const existing = (await readOutbox(scope)).find((op) => op.articleId === record.articleId);
    let opType = type;
    if (existing && existing.type === 'create') opType = 'create';
    if (type === 'delete' || type === 'restore') opType = type;
    if (existing && existing.type === 'delete' && type === 'update') opType = 'delete';
    const op = {
        opId: nextOpId(),
        articleId: record.articleId,
        type: opType,
        expectedRevision: Number(record.revision) || 0,
        clientMutationId: options.clientMutationId || makeMutationId(),
        payload: {
            title: record.title || '',
            body: record.article || '',
            analysis: record.result === undefined ? null : record.result,
            sourceType: record.sourceType || 'paste',
            sourceUrl: record.sourceUrl || ''
        },
        createdAt: new Date().toISOString(),
        attempts: 0,
        legacy: options.legacy === true || (existing ? existing.legacy === true : false),
        lastError: options.lastError || ''
    };
    if (opType === 'delete' || opType === 'restore') {
        op.payload = null;
    }
    return op;
}

async function enqueue(record, type, options = {}) {
    const ctx = options.ctx || captureArticleContext();
    const op = await buildOutboxOp(record, type, { ...options, scope: ctx.scope });
    return writeOutboxOp(op, ctx);
}

// ─────────────────────────────────────────────────────────────────────────────
// 載入與範圍切換
// ─────────────────────────────────────────────────────────────────────────────

export async function initArticleStore() {
    const scope = getArticleScope();
    currentScope = scope;
    const db = await openDb();
    if (!db) fallbackMode = true;
    await reloadScope(scope);
    return { scope, fallbackMode };
}

async function readDocsDetailed(scope) {
    if (fallbackMode) return { ok: true, docs: fallbackRead(scope).docs || [] };
    const result = await idbRequest(STORE_DOCS, 'readonly', (store) => readAll(store));
    if (result.ok) {
        return { ok: true, docs: (result.value || []).filter((doc) => doc && doc.scope === scope) };
    }
    if (result.error === 'idb_unavailable') {
        fallbackMode = true;
        return { ok: true, docs: fallbackRead(scope).docs || [] };
    }
    meta.persistenceError = result.error || 'idb_read_failed';
    return { ok: false, error: meta.persistenceError };
}

async function readDocs(scope) {
    const result = await readDocsDetailed(scope);
    return result.ok ? result.docs : [];
}

async function readSummaries(scope) {
    if (fallbackMode) return (fallbackRead(scope).docs || []).map((doc) => summarizeArticleDoc(doc)).filter(Boolean);
    const result = await idbRequest(STORE_ARTICLE_SUMMARIES, 'readonly', (store) => readAll(store));
    if (result.ok) return (result.value || []).filter((summary) => summary && summary.scope === scope);
    if (result.error === 'idb_unavailable') {
        fallbackMode = true;
        return (fallbackRead(scope).docs || []).map((doc) => summarizeArticleDoc(doc)).filter(Boolean);
    }
    meta.persistenceError = result.error || 'idb_read_failed';
    return null;
}

async function readState(scope) {
    if (fallbackMode) return fallbackRead(scope).state || null;
    const result = await idbRequest(STORE_STATE, 'readonly', (store) => readOne(store, scope));
    if (result.ok) return result.value || null;
    if (result.error === 'idb_unavailable') {
        fallbackMode = true;
        return fallbackRead(scope).state || null;
    }
    meta.persistenceError = result.error || 'idb_read_failed';
    return null;
}

export async function reloadScope(scope = getArticleScope()) {
    const next = String(scope || getArticleScope());
    const previousScope = currentScope;
    // 只有切換 scope 才還原已載入全文；同一 scope 的重新整理必須維持摘要，
    // 避免正常啟動或同步後把所有文章全文 hydrate 回記憶體。
    const restoreCachedDocs = !!previousScope && previousScope !== next;
    if (currentScope && currentScope !== next) scopeGeneration += 1;
    else if (!currentScope) scopeGeneration += 1;
    const generation = scopeGeneration;
    currentScope = next;
    loadedDocs.clear();
    loadingDocs.clear();
    let records = [];
    const cachedDocForReload = new Map();
    // 同一 scope 重新載入時，若讀取期間有本機寫入提交（dataEpoch 改變），
    // 必須重讀，不能用較早的摘要蓋掉剛保存的新修改。
    for (let attempt = 0; attempt < 4; attempt += 1) {
        const epochAtStart = dataEpoch;
        let summaries = await readSummaries(next);
        if (generation !== scopeGeneration) return [];
        if (summaries === null) {
            // 讀取失敗不切換權威、也不清空目前畫面；保留錯誤供 UI 顯示。
            return (state.analyzedArticles || []).filter((item) => item && item.articleId);
        }
        if (!summaries.length) {
            // 升級前的資料尚未建立摘要：只在這個一次性情況讀完整文件補摘要。
            const docs = await readDocs(next);
            if (generation !== scopeGeneration) return [];
            summaries = docs.map((doc) => summarizeArticleDoc(doc)).filter(Boolean);
            if (docs.length && !fallbackMode) {
                await applyPermanentOperations(summaries.map((summary) => ({ store: STORE_ARTICLE_SUMMARIES, type: 'put', value: summary })));
            }
        }
        const storedState = await readState(next);
        if (generation !== scopeGeneration) return [];
        if (epochAtStart !== dataEpoch && attempt < 3) continue;
        meta = {
            cursor: Number(storedState?.cursor) || 0,
            migrated: storedState?.migrated === true,
            migratedAt: storedState?.migratedAt || '',
            lastSyncAt: storedState?.lastSyncAt || '',
            lastError: storedState?.lastError || '',
            conflicts: storedState?.conflicts && typeof storedState.conflicts === 'object' ? storedState.conflicts : {},
            gatePending: storedState?.gatePending === true,
            persistenceError: meta.persistenceError || ''
        };
        records = summaries
            .map((summary) => {
                const record = toSummaryRecord(summary);
                const cached = record && restoreCachedDocs ? cachedDoc(next, summary) : null;
                if (!cached) return record;
                cachedDocForReload.set(record.articleId, cached);
                return { ...record, article: cached.body, result: cached.analysis, summaryOnly: false };
            })
            .filter(Boolean)
            .sort((a, b) => String(b.lastOpenedAt || b.updatedAt || '').localeCompare(String(a.lastOpenedAt || a.updatedAt || '')));
        break;
    }
    loadedDocs.clear();
    for (const [articleId, doc] of cachedDocForReload) loadedDocs.set(articleId, doc);
    state.setAnalyzedArticles(records);
    emitChange();
    return records;
}

/**
 * 按需載入單篇文章全文與分析。文章清單只保留摘要，這是正常補全文入口。
 */
export async function ensureArticleLoaded(articleId, ctx = captureArticleContext()) {
    if (!articleId) return null;
    if (!isArticleContextActive(ctx)) return null;
    const summary = findRecord(articleId);
    if (!summary) return null;
    if (loadedDocs.has(articleId)) return findRecord(articleId);
    const key = `${ctx.scope}\u0000${articleId}\u0000${ctx.generation}`;
    if (loadingDocs.has(key)) return loadingDocs.get(key);
    const task = (async () => {
        const result = await idbRequest(STORE_DOCS, 'readonly', (store) => readOne(store, docKey(ctx.scope, articleId)));
        if (!isArticleContextActive(ctx)) return null;
        const doc = result.ok ? result.value : null;
        if (!doc || doc.scope !== ctx.scope || doc.id !== articleId) return null;
        cacheDoc(doc);
        loadedDocs.set(articleId, doc);
        replaceRecord(toRecord(doc));
        return findRecord(articleId);
    })();
    loadingDocs.set(key, task);
    try {
        return await task;
    } finally {
        loadingDocs.delete(key);
    }
}

async function loadAllRecordsDetailed(ctx = captureArticleContext()) {
    if (!isArticleContextActive(ctx)) return staleResult();
    const read = await readDocsDetailed(ctx.scope);
    if (!isArticleContextActive(ctx)) return staleResult();
    if (!read.ok) return { ok: false, error: read.error || 'idb_read_failed' };
    loadedDocs.clear();
    for (const doc of read.docs) loadedDocs.set(doc.id, doc);
    const records = read.docs
        .map(toRecord)
        .filter(Boolean)
        .sort((a, b) => String(b.lastOpenedAt || b.updatedAt || '').localeCompare(String(a.lastOpenedAt || a.updatedAt || '')));
    state.setAnalyzedArticles(records);
    emitChange();
    return { ok: true, records, scope: ctx.scope, generation: ctx.generation };
}

/** 明確需要全部文章的流程（遷移、完整匯出）才使用。 */
export async function loadAllRecords(ctx = captureArticleContext()) {
    const result = await loadAllRecordsDetailed(ctx);
    return result.ok ? result.records : [];
}

/** 登入／登出／換帳戶後呼叫；換範圍不會把舊範圍的資料帶到新範圍。 */
export async function refreshScope() {
    const next = `${endpoint() || 'local'}::${storedUser() || 'guest'}`;
    if (next === currentScope) {
        await reloadScope(next);
        return { changed: false, scope: next };
    }
    await reloadScope(next);
    return { changed: true, scope: next };
}

// ─────────────────────────────────────────────────────────────────────────────
// 讀取
// ─────────────────────────────────────────────────────────────────────────────

export function getRecords() {
    return (state.analyzedArticles || []).filter((item) => item && item.articleId && !item.deletedAt);
}

export function getRecord(id) {
    return findRecord(id);
}

export function getAnalysis(id) {
    const record = findRecord(id);
    return record ? record.result : null;
}

export function getMeta() {
    return { ...meta, conflicts: { ...meta.conflicts } };
}

export function getPersistenceError() {
    return meta.persistenceError;
}

export async function pendingCount(ctx = captureArticleContext()) {
    return (await readOutbox(ctx)).length;
}

export async function listPending(ctx = captureArticleContext()) {
    return readOutbox(ctx);
}

export async function usage() {
    const records = (state.analyzedArticles || []).filter((item) => item && !item.deletedAt);
    const totalBytes = records.reduce((sum, item) => sum + (Number(item.sizeBytes) || articleSizeBytes(item)), 0);
    return {
        count: records.length,
        totalBytes,
        limits: ARTICLE_LIMITS,
        warn: records.length > ARTICLE_LIMITS.warnCount || totalBytes > ARTICLE_LIMITS.maxUserBytes * 0.8
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// 寫入
// ─────────────────────────────────────────────────────────────────────────────

function nowIso() {
    return new Date().toISOString();
}

export function newArticleId() {
    return generateArticleId();
}

/**
 * 建立或更新一篇本機文章。
 * `origin`: 'analysis' | 'rename' | 'manual'
 */
export async function saveArticle(input, options = {}) {
    const ctx = options.ctx || captureArticleContext();
    if (!isArticleContextActive(ctx)) return staleResult();
    const body = String(input?.article ?? input?.body ?? '');
    if (!body.trim()) return { ok: false, error: 'empty_body' };
    const id = String(input?.articleId || input?.id || '') || newArticleId();
    let existing = findRecord(id);
    if (existing?.summaryOnly) existing = await ensureArticleLoaded(id, ctx);
    if (!isArticleContextActive(ctx)) return staleResult();
    const updatedAt = nowIso();
    const record = {
        articleId: id,
        article: body,
        result: input?.result !== undefined ? input.result : (existing ? existing.result : null),
        title: String(input?.title || existing?.title || '').trim(),
        sourceType: normalizeSourceType(input?.sourceType || existing?.sourceType),
        sourceUrl: input?.sourceUrl !== undefined ? input.sourceUrl : (existing?.sourceUrl || ''),
        revision: Number(existing?.revision) || 0,
        createdAt: existing?.createdAt || updatedAt,
        updatedAt,
        lastOpenedAt: existing?.lastOpenedAt || updatedAt,
        deletedAt: '',
        dirty: true,
        pending: true,
        conflict: null
    };
    if (!record.title) {
        record.title = body.split('\n').map((line) => line.trim()).find(Boolean)?.slice(0, 200) || '';
    }
    if (articleSizeBytes(record) > ARTICLE_LIMITS.maxArticleBytes) {
        return { ok: false, error: 'article_too_large' };
    }
    const persisted = await persistDocWithOp(record, existing ? 'update' : 'create', {
        skipOutbox: options.skipOutbox,
        clientMutationId: options.clientMutationId,
        ctx
    });
    // 儲存期間切換了 scope／generation：交易若尚未開始，已中止；若已完成，
    // 也只會寫在原本 scope。兩種情況都不得再改目前帳戶的記憶體。
    if (!isArticleContextActive(ctx)) {
        return { ...staleResult(), persisted: persisted.ok, record };
    }
    if (!persisted.ok) {
        // 記憶體仍保留內容，讓使用者可以匯出；但明確回報未持久化。
        replaceRecord(record);
        emitChange();
        return { ok: false, error: persisted.error, record };
    }
    replaceRecord(record);
    if (options.touch !== false) await touchOpened(id, { silent: true, ctx });
    if (!isArticleContextActive(ctx)) return { ...staleResult(), record: findRecord(id) || record };
    // 原文真的變更：保留被引用舊版本，並嘗試唯一重新定位學習條目。
    if (existing && String(existing.article || '') !== body) {
        try {
            const readingStore = await import('./reading-store.js');
            if (!isArticleContextActive(ctx)) return { ...staleResult(), record };
            const oldVersion = contentVersionOf(existing.article || '');
            const newVersion = contentVersionOf(body);
            const referenced = readingStore.listLearningItems(id).some((item) => !item.deletedAt && item.contentVersion === oldVersion);
            if (referenced) await readingStore.saveArticleVersion(id, existing.article || '', oldVersion);
            if (!isArticleContextActive(ctx)) return { ...staleResult(), record };
            await readingStore.reanchorArticle({ articleId: id, oldBody: existing.article || '', newBody: body, oldVersion, newVersion });
        } catch (error) {
            console.warn('[article-store] 原文位置更新失敗:', error && error.message ? error.message : 'unknown');
        }
    }
    if (!isArticleContextActive(ctx)) return { ...staleResult(), record };
    emitChange();
    return { ok: true, record: findRecord(id) };
}

/**
 * 只更新分析結果（詞／句／片語詳解），不改變閱讀順序以外的內容。
 * `expectContentVersion`：非同步請求必須帶入「請求開始時」的內文版本；
 * 內文已被改寫時拒絕合併，避免舊版詳解寫進新正文。
 */
export async function saveAnalysis(articleId, result, options = {}) {
    const ctx = options.ctx || captureArticleContext();
    if (!isArticleContextActive(ctx)) return staleResult();
    let record = findRecord(articleId);
    if (record?.summaryOnly) record = await ensureArticleLoaded(articleId, ctx);
    if (!isArticleContextActive(ctx)) return staleResult();
    if (!record) return { ok: false, error: 'record_missing' };
    if (options.expectContentVersion !== undefined && options.expectContentVersion !== null
        && contentVersionOf(record.article || '') !== String(options.expectContentVersion)) {
        return { ok: false, error: 'stale_version', staleVersion: true, record };
    }
    if (articleSizeBytes({ body: record.article || '', analysis: result }) > ARTICLE_LIMITS.maxArticleBytes) {
        return { ok: false, error: 'article_too_large', record };
    }
    const next = { ...record, result, updatedAt: nowIso(), dirty: true, pending: true };
    const persisted = await persistDocWithOp(next, 'update', { skipOutbox: options.skipOutbox, ctx });
    if (!isArticleContextActive(ctx)) return { ...staleResult(), record: next };
    replaceRecord(next);
    if (!persisted.ok) return { ok: false, error: persisted.error, record: next };
    emitChange();
    return { ok: true, record: findRecord(articleId) };
}

export async function renameArticle(articleId, title, options = {}) {
    const ctx = options.ctx || captureArticleContext();
    if (!isArticleContextActive(ctx)) return staleResult();
    let record = findRecord(articleId);
    if (record?.summaryOnly) record = await ensureArticleLoaded(articleId, ctx);
    if (!isArticleContextActive(ctx)) return staleResult();
    if (!record) return { ok: false, error: 'record_missing' };
    const clean = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!clean) return { ok: false, error: 'empty_title' };
    const next = { ...record, title: clean, updatedAt: nowIso(), dirty: true, pending: true };
    const persisted = await persistDocWithOp(next, 'update', { ctx });
    if (!isArticleContextActive(ctx)) return { ...staleResult(), record: next };
    replaceRecord(next);
    if (!persisted.ok) return { ok: false, error: persisted.error };
    emitChange();
    return { ok: true, record: findRecord(articleId) };
}

/**
 * 軟刪除：本機與伺服器都保留可復原的 tombstone。生詞本不在這裡處理，
 * 由呼叫端決定保留（文章專屬生詞本以 articleId 命名，刪除後仍存在）。
 */
export async function deleteArticle(articleId, options = {}) {
    const ctx = options.ctx || captureArticleContext();
    if (!isArticleContextActive(ctx)) return staleResult();
    let record = findRecord(articleId);
    if (record?.summaryOnly) record = await ensureArticleLoaded(articleId, ctx);
    if (!isArticleContextActive(ctx)) return staleResult();
    if (!record) return { ok: false, error: 'record_missing' };
    const tombstone = { ...record, deletedAt: nowIso(), updatedAt: nowIso(), dirty: true, pending: true };
    if (!options.skipOutbox) {
        // 還沒上傳過的建立：直接撤掉待同步的建立即可，不需要送刪除。
        const pending = (await readOutbox(ctx)).find((op) => op.articleId === articleId);
        if (!isArticleContextActive(ctx)) return staleResult();
        if (pending && pending.type === 'create' && !Number(record.revision)) {
            const scope = ctx.scope;
            const doc = toDoc(tombstone, scope);
            // 這個分支同樣要維護摘要，否則列表重新整理後仍會看到已刪文章。
            const result = await idbRequest([STORE_DOCS, STORE_ARTICLE_SUMMARIES, STORE_OUTBOX], 'readwrite', (stores) => {
                stores[STORE_DOCS].put(doc);
                stores[STORE_ARTICLE_SUMMARIES].put(summarizeArticleDoc(doc));
                stores[STORE_OUTBOX].delete(docKey(scope, articleId));
                return null;
            }, ctx);
            if (!isArticleContextActive(ctx)) return { ...staleResult(), record: tombstone };
            if (!result.ok && result.error === 'idb_unavailable') {
                fallbackMode = true;
                const writable = fallbackDocWrite(scope, doc);
                if (!writable.ok) return { ok: false, error: writable.error };
                const bucket = fallbackRead(scope);
                bucket.outbox = (bucket.outbox || []).filter((item) => item.articleId !== articleId);
                if (!fallbackWrite(scope, bucket)) return { ok: false, error: 'storage_full' };
            } else if (!result.ok) {
                return { ok: false, error: result.error };
            }
            dataEpoch += 1;
            replaceRecord(tombstone);
            emitChange();
            return { ok: true, record: tombstone };
        }
    }
    const persisted = await persistDocWithOp(tombstone, options.skipOutbox ? 'update' : 'delete', { skipOutbox: options.skipOutbox, ctx });
    if (!isArticleContextActive(ctx)) return { ...staleResult(), record: tombstone };
    // 保留 tombstone 在記憶體裡（列表與搜尋會排除），否則待同步的刪除操作
    // 會找不到記錄而被誤判為已完成，伺服器永遠收不到刪除。
    replaceRecord(tombstone);
    if (!persisted.ok) return { ok: false, error: persisted.error };
    emitChange();
    return { ok: true, record: tombstone };
}

export async function restoreArticle(snapshot, options = {}) {
    const ctx = options.ctx || captureArticleContext();
    if (!isArticleContextActive(ctx)) return staleResult();
    if (!snapshot || !snapshot.articleId) return { ok: false, error: 'invalid_snapshot' };
    if (snapshot.summaryOnly) {
        const full = await ensureArticleLoaded(snapshot.articleId, ctx);
        if (!isArticleContextActive(ctx)) return staleResult();
        if (full) snapshot = { ...snapshot, article: full.article, result: full.result };
    }
    const record = {
        ...snapshot,
        deletedAt: '',
        updatedAt: snapshot.updatedAt || nowIso(),
        lastOpenedAt: snapshot.lastOpenedAt || nowIso(),
        dirty: true,
        pending: true,
        conflict: null
    };
    // 從未上傳過的文章（revision 0）復原後就是一次建立
    const persisted = await persistDocWithOp(record, Number(record.revision) ? 'restore' : 'create', { ctx });
    if (!isArticleContextActive(ctx)) return { ...staleResult(), record };
    if (!persisted.ok) return { ok: false, error: persisted.error };
    replaceRecord(record);
    emitChange();
    return { ok: true, record: findRecord(record.articleId) };
}

/** 最近閱讀：只改本機 lastOpenedAt，不動文章 revision、不觸發同步。 */
export async function touchOpened(articleId, options = {}) {
    const ctx = options.ctx || captureArticleContext();
    if (!isArticleContextActive(ctx)) return staleResult();
    let record = findRecord(articleId);
    if (record?.summaryOnly) record = await ensureArticleLoaded(articleId, ctx);
    if (!isArticleContextActive(ctx)) return staleResult();
    if (!record) return { ok: false, error: 'record_missing' };
    const next = { ...record, lastOpenedAt: nowIso() };
    const persisted = await persistDoc(next, ctx);
    if (!isArticleContextActive(ctx)) return staleResult();
    replaceRecord(next);
    if (!persisted.ok) return { ok: false, error: persisted.error };
    if (!options.silent) emitChange();
    return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// 草稿
// ─────────────────────────────────────────────────────────────────────────────

const EMPTY_DRAFT = { text: '', sourceType: '', sourceUrl: '', title: '', recordId: '', savedAt: '' };

export async function saveDraft(draft, options = {}) {
    const ctx = options.ctx || captureArticleContext();
    if (!isArticleContextActive(ctx)) return staleResult();
    const scope = ctx.scope;
    const payload = {
        scope,
        text: String(draft?.text || ''),
        sourceType: draft?.sourceType || 'paste',
        sourceUrl: draft?.sourceUrl || '',
        title: draft?.title || '',
        recordId: draft?.recordId || '',
        savedAt: nowIso()
    };
    if (!payload.text.trim()) return clearDraft({ ctx });
    if (fallbackMode) {
        const bucket = fallbackRead(scope);
        bucket.draft = payload;
        return fallbackWrite(scope, bucket) ? { ok: true, draft: payload } : { ok: false, error: 'storage_full' };
    }
    const result = await idbRequest(STORE_DRAFTS, 'readwrite', (store) => { store.put(payload); return null; }, ctx);
    if (result.ok) return { ok: true, draft: payload };
    if (result.error === 'idb_unavailable') {
        fallbackMode = true;
        const bucket = fallbackRead(scope);
        bucket.draft = payload;
        return fallbackWrite(scope, bucket) ? { ok: true, draft: payload } : { ok: false, error: 'storage_full' };
    }
    return { ok: false, error: result.error };
}

export async function readDraft(options = {}) {
    const ctx = options.ctx || captureArticleContext();
    const scope = ctx.scope;
    if (fallbackMode) return fallbackRead(scope).draft || null;
    const result = await idbRequest(STORE_DRAFTS, 'readonly', (store) => readOne(store, scope));
    if (result.ok) return result.value || null;
    if (result.error === 'idb_unavailable') {
        fallbackMode = true;
        return fallbackRead(scope).draft || null;
    }
    return null;
}

export async function clearDraft(options = {}) {
    const ctx = options.ctx || captureArticleContext();
    if (!isArticleContextActive(ctx)) return staleResult();
    const scope = ctx.scope;
    if (fallbackMode) {
        const bucket = fallbackRead(scope);
        delete bucket.draft;
        return fallbackWrite(scope, bucket) ? { ok: true } : { ok: false, error: 'storage_full' };
    }
    const result = await idbRequest(STORE_DRAFTS, 'readwrite', (store) => { store.delete(scope); return null; }, ctx);
    if (result.ok) return { ok: true };
    if (result.error === 'idb_unavailable') {
        fallbackMode = true;
        const bucket = fallbackRead(scope);
        delete bucket.draft;
        return fallbackWrite(scope, bucket) ? { ok: true } : { ok: false, error: 'storage_full' };
    }
    return { ok: false, error: result.error };
}

/** 接受伺服器目前版本號但不改本機內容（用於「保留本機修改並重新套用」）。 */
export async function setBaseRevision(articleId, revision, options = {}) {
    const ctx = options.ctx || captureArticleContext();
    if (!isArticleContextActive(ctx)) return staleResult();
    let record = findRecord(articleId);
    if (record?.summaryOnly) record = await ensureArticleLoaded(articleId, ctx);
    if (!isArticleContextActive(ctx)) return staleResult();
    if (!record) return { ok: false, error: 'record_missing' };
    const next = { ...record, revision: Number(revision) || 0 };
    const persisted = await persistDoc(next, ctx);
    if (!isArticleContextActive(ctx)) return staleResult();
    replaceRecord(next);
    return persisted.ok ? { ok: true } : { ok: false, error: persisted.error };
}

/**
 * 把本機內容複製成一篇新文章（衝突時「另存副本」）。回傳新文章的 ID。
 */
export async function duplicateArticle(articleId, titleSuffix = '', options = {}) {
    const ctx = options.ctx || captureArticleContext();
    if (!isArticleContextActive(ctx)) return staleResult();
    let record = findRecord(articleId);
    if (record?.summaryOnly) record = await ensureArticleLoaded(articleId, ctx);
    if (!isArticleContextActive(ctx)) return staleResult();
    if (!record) return { ok: false, error: 'record_missing' };
    const id = newArticleId();
    const copy = {
        ...record,
        articleId: id,
        title: `${record.title || record.article.slice(0, 40)}${titleSuffix}`.trim(),
        revision: 0,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        lastOpenedAt: nowIso(),
        dirty: true,
        pending: true,
        conflict: null
    };
    const persisted = await persistDocWithOp(copy, 'create', { ctx });
    if (!isArticleContextActive(ctx)) return { ...staleResult(), articleId: id };
    if (!persisted.ok) return { ok: false, error: persisted.error };
    replaceRecord(copy);
    emitChange();
    return { ok: true, articleId: id };
}

// ─────────────────────────────────────────────────────────────────────────────
// 同步狀態（游標、衝突）
// ─────────────────────────────────────────────────────────────────────────────

export function getCursor() {
    return Number(meta.cursor) || 0;
}

export async function setCursor(cursor, ctx = captureArticleContext()) {
    if (!isArticleContextActive(ctx)) return staleResult();
    meta.cursor = Number(cursor) || 0;
    return persistMeta(ctx);
}

export async function markSynced(at = nowIso(), ctx = captureArticleContext()) {
    if (!isArticleContextActive(ctx)) return staleResult();
    meta.lastSyncAt = at;
    meta.lastError = '';
    return persistMeta(ctx);
}

export async function markSyncError(code, ctx = captureArticleContext()) {
    if (!isArticleContextActive(ctx)) return staleResult();
    meta.lastError = String(code || '');
    return persistMeta(ctx);
}

export function getConflicts() {
    return Object.values(meta.conflicts || {});
}

export async function setConflict(articleId, info, ctx = captureArticleContext()) {
    if (!isArticleContextActive(ctx)) return staleResult();
    meta.conflicts = { ...(meta.conflicts || {}), [articleId]: { articleId, at: nowIso(), ...info } };
    const persisted = await persistMeta(ctx);
    if (isArticleContextActive(ctx)) emitChange();
    return persisted;
}

export async function clearConflict(articleId, ctx = captureArticleContext()) {
    if (!isArticleContextActive(ctx)) return staleResult();
    if (!meta.conflicts || !meta.conflicts[articleId]) return { ok: true };
    const next = { ...meta.conflicts };
    delete next[articleId];
    meta.conflicts = next;
    const persisted = await persistMeta(ctx);
    if (isArticleContextActive(ctx)) emitChange();
    return persisted;
}

// ─────────────────────────────────────────────────────────────────────────────
// 套用遠端變更
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 套用遠端 metadata（不含正文）。回傳需要下載正文的 ID 清單：
 *   * 本機沒有這篇 → 需要下載
 *   * 遠端 revision 比本機新且本機沒有未上傳修改 → 需要下載
 *   * 本機有未上傳修改 → 保留本機內容，不覆蓋
 */
export function planRemote(metaList) {
    const needDocs = [];
    const tombstones = [];
    for (const item of Array.isArray(metaList) ? metaList : []) {
        if (!item || !item.id) continue;
        const record = findRecord(item.id);
        if (item.deletedAt) {
            if (record && !record.dirty) tombstones.push(item.id);
            continue;
        }
        if (!record) {
            needDocs.push(item.id);
            continue;
        }
        if (record.dirty || record.pending) continue; // 本機修改優先，衝突由 push 階段處理
        if (Number(item.revision) > Number(record.revision)) needDocs.push(item.id);
    }
    return { needDocs, tombstones };
}

export async function applyRemoteDoc(doc, ctx = captureArticleContext()) {
    if (!doc || !doc.id) return { ok: false, error: 'invalid_document' };
    if (!isArticleContextActive(ctx)) return staleResult();
    const scope = ctx.scope;
    const record = {
        articleId: doc.id,
        article: doc.body || '',
        result: parseAnalysis(doc.analysis),
        title: doc.title || '',
        sourceType: normalizeSourceType(doc.sourceType),
        sourceUrl: doc.sourceUrl || '',
        revision: Number(doc.revision) || 0,
        createdAt: doc.createdAt || '',
        updatedAt: doc.updatedAt || '',
        lastOpenedAt: doc.updatedAt || '',
        deletedAt: doc.deletedAt || '',
        dirty: false,
        pending: false,
        conflict: null
    };
    const remoteDoc = toDoc(record, scope);
    // 在交易內重新讀取本機文件與 outbox，才不會用「網路請求開始前」的
    // pending 判斷覆蓋掉請求期間的新編輯。
    const result = await idbRequest([STORE_DOCS, STORE_ARTICLE_SUMMARIES, STORE_OUTBOX], 'readwrite', (stores) => {
        return new Promise((resolve, reject) => {
            const docRequest = stores[STORE_DOCS].get(docKey(scope, doc.id));
            docRequest.onerror = () => reject(docRequest.error || new Error('idb_read_failed'));
            docRequest.onsuccess = () => {
                const localDoc = docRequest.result || null;
                const outboxRequest = stores[STORE_OUTBOX].get(docKey(scope, doc.id));
                outboxRequest.onerror = () => reject(outboxRequest.error || new Error('outbox_read_failed'));
                outboxRequest.onsuccess = () => {
                    if (!isArticleContextActive(ctx)) {
                        try { stores[STORE_DOCS].transaction.abort(); } catch (_) {}
                        resolve({ applied: false, stale: true });
                        return;
                    }
                    const pendingOp = outboxRequest.result || null;
                    if ((localDoc && (localDoc.dirty || localDoc.pending)) || pendingOp) {
                        resolve({ applied: false, skippedLocalPending: true });
                        return;
                    }
                    stores[STORE_DOCS].put(remoteDoc);
                    const summary = summarizeArticleDoc(remoteDoc);
                    if (summary) stores[STORE_ARTICLE_SUMMARIES].put(summary);
                    resolve({ applied: true });
                };
            };
        });
    }, ctx);
    if (!isArticleContextActive(ctx)) return staleResult();
    if (!result.ok) {
        if (result.error === 'idb_unavailable') return { ok: false, error: 'idb_unavailable' };
        meta.persistenceError = result.error || 'idb_write_failed';
        return { ok: false, error: meta.persistenceError };
    }
    const value = result.value || {};
    if (value.stale) return staleResult();
    if (value.skippedLocalPending) {
        return { ok: true, applied: false, skippedLocalPending: true, record: findRecord(doc.id) };
    }
    dataEpoch += 1;
    cacheDoc(remoteDoc);
    loadedDocs.set(doc.id, remoteDoc);
    replaceRecord(record);
    emitChange();
    return { ok: true, applied: true, record };
}

export async function applyRemoteTombstone(articleId, ctx = captureArticleContext()) {
    if (!isArticleContextActive(ctx)) return staleResult();
    const scope = ctx.scope;
    const result = await idbRequest([STORE_DOCS, STORE_ARTICLE_SUMMARIES, STORE_OUTBOX], 'readwrite', (stores) => {
        return new Promise((resolve, reject) => {
            const docRequest = stores[STORE_DOCS].get(docKey(scope, articleId));
            docRequest.onerror = () => reject(docRequest.error || new Error('idb_read_failed'));
            docRequest.onsuccess = () => {
                const localDoc = docRequest.result || null;
                const outboxRequest = stores[STORE_OUTBOX].get(docKey(scope, articleId));
                outboxRequest.onerror = () => reject(outboxRequest.error || new Error('outbox_read_failed'));
                outboxRequest.onsuccess = () => {
                    if (!isArticleContextActive(ctx)) {
                        try { stores[STORE_DOCS].transaction.abort(); } catch (_) {}
                        resolve({ applied: false, stale: true });
                        return;
                    }
                    const pendingOp = outboxRequest.result || null;
                    if (!localDoc) { resolve({ applied: false, missing: true }); return; }
                    if (localDoc.dirty || localDoc.pending || pendingOp) {
                        resolve({ applied: false, skippedLocalPending: true });
                        return;
                    }
                    const tombstone = { ...localDoc, deletedAt: nowIso(), dirty: false, pending: false };
                    stores[STORE_DOCS].put(tombstone);
                    stores[STORE_ARTICLE_SUMMARIES].put(summarizeArticleDoc(tombstone));
                    stores[STORE_OUTBOX].delete(docKey(scope, articleId));
                    resolve({ applied: true, tombstone });
                };
            };
        });
    }, ctx);
    if (!isArticleContextActive(ctx)) return staleResult();
    if (!result.ok) return { ok: false, error: result.error || 'idb_write_failed' };
    const value = result.value || {};
    if (value.stale) return staleResult();
    if (value.skippedLocalPending) {
        return { ok: true, applied: false, skippedLocalPending: true, record: findRecord(articleId) };
    }
    if (value.applied) {
        dataEpoch += 1;
        if (value.tombstone) cacheDoc(value.tombstone);
        loadedDocs.delete(articleId);
        const record = findRecord(articleId);
        if (record) {
            const next = { ...record, deletedAt: nowIso(), dirty: false, pending: false };
            replaceRecord(next);
        }
        emitChange();
    }
    return { ok: true, applied: !!value.applied };
}

/** 伺服器要求完整重同步時，移除本機已不存在的遠端文章（保留本機未上傳者）。 */
export async function reconcileFullList(serverIds, ctx = captureArticleContext()) {
    if (!isArticleContextActive(ctx)) return [];
    const ids = new Set(serverIds);
    const removed = [];
    for (const record of (state.analyzedArticles || []).slice()) {
        if (!record || !record.articleId) continue;
        if (ids.has(record.articleId)) continue;
        if (record.dirty || record.pending) continue;
        if (!isArticleContextActive(ctx)) return removed;
        const deleted = await deleteDoc(record.articleId, ctx);
        if (!isArticleContextActive(ctx)) return removed;
        if (!deleted.ok) continue;
        dropRecord(record.articleId);
        removed.push(record.articleId);
    }
    if (removed.length) emitChange();
    return removed;
}

// ─────────────────────────────────────────────────────────────────────────────
// outbox 結果處理
// ─────────────────────────────────────────────────────────────────────────────

export async function markOpDone(articleId, { revision, serverUpdatedAt, clientMutationId } = {}, ctx = captureArticleContext()) {
    if (!isArticleContextActive(ctx)) return staleResult();
    const scope = ctx.scope;
    // 讀 outbox 與文件都在同一交易；舊回執不能清掉上傳期間新寫的 outbox。
    const result = await idbRequest([STORE_DOCS, STORE_ARTICLE_SUMMARIES, STORE_OUTBOX], 'readwrite', (stores) => {
        return new Promise((resolve, reject) => {
            const docRequest = stores[STORE_DOCS].get(docKey(scope, articleId));
            docRequest.onerror = () => reject(docRequest.error || new Error('idb_read_failed'));
            docRequest.onsuccess = () => {
                const storedDoc = docRequest.result || null;
                const outboxRequest = stores[STORE_OUTBOX].get(docKey(scope, articleId));
                outboxRequest.onerror = () => reject(outboxRequest.error || new Error('outbox_read_failed'));
                outboxRequest.onsuccess = () => {
                    if (!isArticleContextActive(ctx)) {
                        try { stores[STORE_DOCS].transaction.abort(); } catch (_) {}
                        resolve({ stale: true });
                        return;
                    }
                    const pending = outboxRequest.result || null;
                    const matches = !clientMutationId || (pending && pending.clientMutationId === clientMutationId);
                    if (matches && pending) stores[STORE_OUTBOX].delete(docKey(scope, articleId));
                    if (!storedDoc) { resolve({ matches, record: null }); return; }
                    const record = toRecord(storedDoc);
                    const next = {
                        ...record,
                        revision: Number.isFinite(revision) ? Math.max(Number(record.revision) || 0, Number(revision)) : record.revision,
                        updatedAt: serverUpdatedAt || record.updatedAt,
                        // 舊回執（outbox 已被新修改取代或已不存在）只推進 revision，
                        // 不得把已同步狀態重新標成 pending。
                        dirty: matches ? false : !!record.dirty,
                        pending: matches ? false : !!record.pending,
                        conflict: matches ? null : record.conflict
                    };
                    const nextDoc = toDoc(next, scope);
                    stores[STORE_DOCS].put(nextDoc);
                    stores[STORE_ARTICLE_SUMMARIES].put(summarizeArticleDoc(nextDoc));
                    resolve({ matches, record: next, doc: nextDoc });
                };
            };
        });
    }, ctx);
    if (!isArticleContextActive(ctx)) return { ...staleResult(), stale: true };
    if (!result.ok) return { ok: false, error: result.error || 'idb_write_failed' };
    const value = result.value || {};
    if (value.stale) return { ...staleResult(), stale: true };
    if (value.doc) {
        dataEpoch += 1;
        cacheDoc(value.doc);
        loadedDocs.set(articleId, value.doc);
        replaceRecord(value.record);
    }
    if (value.matches) await clearConflict(articleId, ctx);
    emitChange();
    return { ok: true, stale: !value.matches };
}

export async function markOpFailed(articleId, error, options = {}) {
    const ctx = options.ctx || captureArticleContext();
    if (!isArticleContextActive(ctx)) return staleResult();
    let record = findRecord(articleId);
    if (record?.summaryOnly) record = await ensureArticleLoaded(articleId, ctx);
    if (!isArticleContextActive(ctx)) return staleResult();
    if (!record) return;
    const next = { ...record, dirty: true, pending: true };
    const persisted = await persistDoc(next, ctx);
    if (!isArticleContextActive(ctx)) return staleResult();
    if (!persisted.ok) return persisted;
    replaceRecord(next);
    if (error) await markSyncError(error, ctx);
    if (options.conflict) await setConflict(articleId, options.conflict, ctx);
    emitChange();
    return { ok: true };
}

/** 伺服器已沒有這篇（例如在別的裝置刪除後又被清空）：把待同步操作改成建立。 */
export async function requeueAsCreate(articleId, ctx = captureArticleContext()) {
    if (!isArticleContextActive(ctx)) return staleResult();
    let record = findRecord(articleId);
    if (record?.summaryOnly) record = await ensureArticleLoaded(articleId, ctx);
    if (!isArticleContextActive(ctx)) return staleResult();
    if (!record) return { ok: false, error: 'record_missing' };
    const next = { ...record, revision: 0, deletedAt: '', dirty: true, pending: true };
    const result = await persistDocWithOp(next, 'create', { ctx });
    if (!isArticleContextActive(ctx)) return staleResult();
    replaceRecord(next);
    emitChange();
    return result.ok ? { ok: true } : { ok: false, error: result.error };
}

/** 衝突處理後重新排入上傳（保留本機內容）。 */
export async function enqueueForRetry(articleId, ctx = captureArticleContext()) {
    if (!isArticleContextActive(ctx)) return staleResult();
    let record = findRecord(articleId);
    if (record?.summaryOnly) record = await ensureArticleLoaded(articleId, ctx);
    if (!isArticleContextActive(ctx)) return staleResult();
    if (!record) return { ok: false, error: 'record_missing' };
    const next = { ...record, dirty: true, pending: true };
    const type = record.deletedAt ? 'delete' : 'update';
    const result = await persistDocWithOp(next, type, { ctx });
    if (!isArticleContextActive(ctx)) return staleResult();
    replaceRecord(next);
    emitChange();
    return result.ok ? { ok: true } : { ok: false, error: result.error };
}

/** 丟掉某篇文章的待同步操作（改用伺服器版本時）。 */
export async function discardPending(articleId, ctx = captureArticleContext()) {
    return removeOutboxOp(articleId, ctx);
}

export function getGatePending() {
    return meta.gatePending === true;
}

export async function setGatePending(value, ctx = captureArticleContext()) {
    if (!isArticleContextActive(ctx)) return staleResult();
    meta.gatePending = value === true;
    return persistMeta(ctx);
}

// ─────────────────────────────────────────────────────────────────────────────
// 匯出／匯入（完整內容，可離線還原）
// ─────────────────────────────────────────────────────────────────────────────

function toExportDocument(item) {
    return {
        id: item.articleId,
        title: item.title || '',
        body: item.article || '',
        analysis: item.result === undefined ? null : item.result,
        sourceType: item.sourceType || 'paste',
        sourceUrl: item.sourceUrl || '',
        revision: Number(item.revision) || 0,
        createdAt: item.createdAt || '',
        updatedAt: item.updatedAt || '',
        lastOpenedAt: item.lastOpenedAt || '',
        deletedAt: item.deletedAt || ''
    };
}

/**
 * 明確結果版本的匯出：stale scope 或讀取失敗都回 ok=false，呼叫方不能把
 * 「沒有文章」誤當成成功空備份。既有 `exportDocuments()` 仍回陣列。
 */
export async function exportDocumentsResult(ctx = captureArticleContext()) {
    if (!isArticleContextActive(ctx)) return staleResult();
    const loaded = await loadAllRecordsDetailed(ctx);
    if (!loaded.ok) return loaded;
    if (!isArticleContextActive(ctx)) return staleResult();
    return {
        ok: true,
        scope: loaded.scope,
        generation: loaded.generation,
        documents: loaded.records.filter((item) => item && item.articleId).map(toExportDocument)
    };
}

export async function exportDocuments(ctx = captureArticleContext()) {
    const result = await exportDocumentsResult(ctx);
    return result.ok ? result.documents : [];
}

/**
 * 從備份還原文章。已存在且本機較新的記錄不覆蓋；`replace` 為 true 時以備份為準。
 */
export async function importDocuments(documents, options = {}) {
    const ctx = options.ctx || captureArticleContext();
    if (!isArticleContextActive(ctx)) return staleResult();
    const list = Array.isArray(documents) ? documents : [];
    let imported = 0;
    let skipped = 0;
    for (const raw of list) {
        if (!isArticleContextActive(ctx)) return staleResult();
        if (!raw) continue;
        const id = String(raw.id || raw.articleId || '');
        const body = String(raw.body ?? raw.article ?? '');
        if (!id || !body.trim()) { skipped += 1; continue; }
        const existing = findRecord(id);
        if (existing && !options.replace) {
            skipped += 1;
            continue;
        }
        const record = {
            articleId: id,
            article: body,
            result: raw.analysis !== undefined ? raw.analysis : (raw.result !== undefined ? raw.result : null),
            title: raw.title || existing?.title || '',
            sourceType: normalizeSourceType(raw.sourceType || existing?.sourceType),
            sourceUrl: raw.sourceUrl || existing?.sourceUrl || '',
            revision: Number(raw.revision) || Number(existing?.revision) || 0,
            createdAt: raw.createdAt || existing?.createdAt || nowIso(),
            updatedAt: raw.updatedAt || existing?.updatedAt || nowIso(),
            lastOpenedAt: raw.lastOpenedAt || existing?.lastOpenedAt || '',
            deletedAt: raw.deletedAt || '',
            dirty: true,
            pending: true,
            conflict: null
        };
        const persisted = await persistDocWithOp(record, existing ? 'update' : 'create', { ctx });
        if (!isArticleContextActive(ctx)) return staleResult();
        if (!persisted.ok) return { ok: false, error: persisted.error, imported, skipped };
        if (!record.deletedAt) replaceRecord(record);
        imported += 1;
    }
    if (!isArticleContextActive(ctx)) return staleResult();
    emitChange();
    return { ok: true, imported, skipped };
}

// ─────────────────────────────────────────────────────────────────────────────
// 舊資料遷移（analyzedArticles + articleMetas）
// ─────────────────────────────────────────────────────────────────────────────

function readLegacyArticles() {
    let articles = [];
    let metas = {};
    try {
        const raw = localStorage.getItem('analyzedArticles');
        const parsed = raw ? JSON.parse(raw) : [];
        if (Array.isArray(parsed)) articles = parsed;
    } catch (_) {}
    try {
        const raw = localStorage.getItem('articleMetas');
        const parsed = raw ? JSON.parse(raw) : {};
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) metas = parsed;
    } catch (_) {}
    return { articles, metas };
}

export function getMigrationMarker() {
    try {
        const raw = localStorage.getItem(migrationMarkerKey(getArticleScope()));
        return raw ? JSON.parse(raw) : null;
    } catch (_) {
        return null;
    }
}

/**
 * 一次性的本機遷移：
 *   1. 先把原始 localStorage 內容完整備份到 `bdc:articles:migration-backup:v1`
 *   2. 逐篇寫入 IndexedDB 並回讀驗證（原文、分析、來源、ID）
 *   3. 驗證通過才寫入遷移標記，最後才釋放舊的 localStorage 鍵
 *   任何一步失敗都保留原資料，不標記成功。
 */
export async function migrateLegacyLocalData(options = {}) {
    const ctx = options.ctx || captureArticleContext();
    if (!isArticleContextActive(ctx)) return staleResult();
    const markerKey = migrationMarkerKey(ctx.scope);
    let marker = null;
    try { marker = JSON.parse(localStorage.getItem(markerKey) || 'null'); } catch (_) {}
    if (marker?.verified) return { ok: true, skipped: true };
    const legacy = readLegacyArticles();
    if (!legacy.articles.length && !Object.keys(legacy.metas).length) {
        // 不要為「目前沒有舊資料」寫入成功標記：舊分頁或別台裝置稍後可能才寫入
        // 舊格式資料，那時仍必須遷移一次。只有真的搬過或確認過才標記。
        return { ok: true, skipped: true, count: 0 };
    }

    // 1. 完整備份（寫入前）
    const backupKey = 'bdc:articles:migration-backup:v1';
    const backup = {
        at: nowIso(),
        scope: ctx.scope,
        analyzedArticles: legacy.articles,
        articleMetas: legacy.metas
    };
    try {
        localStorage.setItem(backupKey, JSON.stringify(backup));
        const verifyRaw = localStorage.getItem(backupKey);
        const verify = verifyRaw ? JSON.parse(verifyRaw) : null;
        if (!verify || verify.analyzedArticles.length !== legacy.articles.length) {
            return { ok: false, error: 'backup_verify_failed' };
        }
    } catch (_) {
        return { ok: false, error: 'backup_failed' };
    }

    // 2. 逐篇寫入
    const existingIds = new Set((state.analyzedArticles || []).map((item) => item && item.articleId));
    let migrated = 0;
    for (let index = 0; index < legacy.articles.length; index += 1) {
        if (!isArticleContextActive(ctx)) return staleResult();
        const item = legacy.articles[index];
        if (!item || typeof item.article !== 'string' || !item.article.trim()) continue;
        const metaForArticle = item.articleId ? legacy.metas[item.articleId] : null;
        const id = String(item.articleId || metaForArticle?.id || '') || newArticleId();
        if (existingIds.has(id)) continue;
        const record = {
            articleId: id,
            article: item.article,
            result: item.result === undefined ? null : item.result,
            title: metaForArticle?.title || item.title || '',
            sourceType: normalizeSourceType(metaForArticle?.sourceType || item.sourceType),
            sourceUrl: metaForArticle?.sourceUrl || item.sourceUrl || '',
            revision: 0,
            createdAt: new Date(Number(metaForArticle?.createdAt) || Date.now()).toISOString(),
            updatedAt: item.result?.updatedAt || metaForArticle?.updatedAt || nowIso(),
            lastOpenedAt: '',
            deletedAt: '',
            dirty: true,
            pending: true,
            conflict: null
        };
        const persisted = await persistDocWithOp(record, 'create', { legacy: true, ctx });
        if (!isArticleContextActive(ctx)) return staleResult();
        if (!persisted.ok) return { ok: false, error: persisted.error, migrated };
        replaceRecord(record);
        existingIds.add(id);
        migrated += 1;
    }

    // 3. 回讀驗證：數量、原文、分析、來源都必須一致
    const verifyList = await readDocs(ctx.scope);
    if (!isArticleContextActive(ctx)) return staleResult();
    const byId = new Map(verifyList.map((doc) => [doc.id, doc]));
    for (const item of legacy.articles) {
        if (!item || typeof item.article !== 'string' || !item.article.trim()) continue;
        const metaForArticle = item.articleId ? legacy.metas[item.articleId] : null;
        const id = String(item.articleId || metaForArticle?.id || '');
        if (!id) continue;
        const doc = byId.get(id);
        if (!doc) return { ok: false, error: 'verify_missing', articleId: id };
        if (doc.body !== item.article) return { ok: false, error: 'verify_body_mismatch', articleId: id };
        const expectedAnalysis = item.result === undefined ? null : item.result;
        if (JSON.stringify(doc.analysis) !== JSON.stringify(expectedAnalysis)) {
            return { ok: false, error: 'verify_analysis_mismatch', articleId: id };
        }
        if (metaForArticle?.sourceType && doc.sourceType !== normalizeSourceType(metaForArticle.sourceType)) {
            return { ok: false, error: 'verify_source_mismatch', articleId: id };
        }
    }

    // 4. 標記成功，最後才釋放舊鍵（備份仍保留）
    if (!isArticleContextActive(ctx)) return staleResult();
    const nextMarker = { verified: true, at: nowIso(), count: migrated, backupKey };
    try { localStorage.setItem(markerKey, JSON.stringify(nextMarker)); } catch (_) {}
    meta.migrated = true;
    meta.migratedAt = nextMarker.at;
    if (migrated > 0) meta.gatePending = true;
    await persistMeta(ctx);
    if (!isArticleContextActive(ctx)) return staleResult();
    try {
        localStorage.removeItem('analyzedArticles');
        localStorage.removeItem('articleMetas');
    } catch (_) {}
    emitChange();
    return { ok: true, migrated, count: migrated };
}

/** 訪客範圍內的文章數（用來判斷登入時是否需要詢問是否帶入帳戶）。 */
export async function guestArticleCount() {
    const guestScope = `${endpoint() || 'local'}::guest`;
    if (guestScope === getArticleScope()) return 0;
    const docs = await readDocs(guestScope);
    return docs.filter((doc) => doc && !doc.deletedAt).length;
}

/**
 * 明確的「訪客文章帶入目前帳戶」流程：只有使用者確認後才呼叫。
 * 訪客範圍的資料不會被刪除，帳戶範圍取得可同步的副本。
 */
export async function adoptGuestArticles(options = {}) {
    const ctx = options.ctx || captureArticleContext();
    if (!isArticleContextActive(ctx)) return staleResult();
    const guestScope = `${endpoint() || 'local'}::guest`;
    if (guestScope === getArticleScope()) return { ok: true, imported: 0 };
    const docs = await readDocs(guestScope);
    if (!isArticleContextActive(ctx)) return staleResult();
    const documents = docs
        .filter((doc) => doc && !doc.deletedAt && doc.body)
        .map((doc) => ({
            id: doc.id,
            title: doc.title,
            body: doc.body,
            analysis: doc.analysis,
            sourceType: doc.sourceType,
            sourceUrl: doc.sourceUrl,
            createdAt: doc.createdAt,
            updatedAt: doc.updatedAt,
            lastOpenedAt: doc.lastOpenedAt
        }));
    if (!documents.length) return { ok: true, imported: 0 };
    return importDocuments(documents, { replace: false, ctx });
}

/** 文章資料是否已從舊格式遷移完成（同一範圍）。 */
export function isMigrated() {
    return meta.migrated === true;
}

/**
 * 從舊快照匯入文章（雲端舊資料或別台裝置的補傳）。
 * 只補本機沒有的 ID；已存在的以本機為準，不覆蓋使用者改過的內容。
 * 匯入的記錄標記為 legacy，會走 /articles/import 保留原 ID 並開啟寫入閘門。
 */
export async function importLegacyArticles(entries, options = {}) {
    const ctx = options.ctx || captureArticleContext();
    if (!isArticleContextActive(ctx)) return staleResult();
    const list = Array.isArray(entries) ? entries : [];
    const existing = new Set((state.analyzedArticles || []).map((item) => item && item.articleId));
    let imported = 0;
    for (const raw of list) {
        if (!isArticleContextActive(ctx)) return staleResult();
        if (!raw) continue;
        const id = String(raw.articleId || raw.id || '');
        const body = String(raw.article ?? raw.body ?? '');
        if (!id || !body.trim() || existing.has(id)) continue;
        const record = {
            articleId: id,
            article: body,
            result: raw.result !== undefined ? raw.result : (raw.analysis !== undefined ? raw.analysis : null),
            title: raw.title || '',
            sourceType: normalizeSourceType(raw.sourceType),
            sourceUrl: raw.sourceUrl || '',
            revision: 0,
            createdAt: raw.createdAt ? new Date(Number(raw.createdAt) || raw.createdAt).toISOString() : nowIso(),
            updatedAt: raw.updatedAt || nowIso(),
            lastOpenedAt: raw.lastOpenedAt || '',
            deletedAt: '',
            dirty: true,
            pending: true,
            conflict: null
        };
        const persisted = await persistDocWithOp(record, 'create', { legacy: true, ctx });
        if (!isArticleContextActive(ctx)) return staleResult();
        if (!persisted.ok) return { ok: false, error: persisted.error, imported };
        replaceRecord(record);
        existing.add(id);
        imported += 1;
    }
    if (imported > 0) {
        meta.gatePending = true;
        meta.migrated = true;
        await persistMeta(ctx);
        if (isArticleContextActive(ctx)) emitChange();
    }
    return { ok: true, imported };
}

/**
 * 遷移失敗時的唯讀後備：把舊 localStorage 清單撐上畫面，讓使用者仍能閱讀與匯出。
 * 這些記錄不會寫回 IndexedDB，也不會排入 outbox；下次啟動會再試一次遷移。
 */
export function hydrateLegacyFallback() {
    const legacy = readLegacyArticles();
    if (!legacy.articles.length) return 0;
    const records = legacy.articles
        .filter((item) => item && typeof item.article === 'string' && item.article.trim())
        .map((item, index) => {
            const meta = item.articleId ? legacy.metas[item.articleId] : null;
            const id = String(item.articleId || meta?.id || `legacy:${index}`);
            return {
                articleId: id,
                article: item.article,
                result: item.result === undefined ? null : item.result,
                title: meta?.title || item.title || '',
                sourceType: normalizeSourceType(meta?.sourceType || item.sourceType),
                sourceUrl: meta?.sourceUrl || item.sourceUrl || '',
                revision: 0,
                createdAt: meta?.createdAt ? new Date(Number(meta.createdAt) || meta.createdAt).toISOString() : '',
                updatedAt: item.result?.updatedAt || '',
                lastOpenedAt: '',
                deletedAt: '',
                dirty: false,
                pending: false,
                conflict: null,
                legacyFallback: true
            };
        });
    state.setAnalyzedArticles(records);
    emitChange();
    return records.length;
}

export function readMigrationBackup() {
    try {
        const raw = localStorage.getItem('bdc:articles:migration-backup:v1');
        return raw ? JSON.parse(raw) : null;
    } catch (_) {
        return null;
    }
}
