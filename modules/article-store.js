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

const DB_NAME = 'bdc-articles';
const DB_VERSION = 1;
const STORE_DOCS = 'docs';
const STORE_OUTBOX = 'outbox';
const STORE_STATE = 'state';
const STORE_DRAFTS = 'drafts';
const FALLBACK_PREFIX = 'bdc:articles:fallback:v1:';
const MIGRATION_MARKER_PREFIX = 'bdc:articles:migrated:v1:';
const TOKEN_KEY = 'sync_token';
const USER_ID_KEY = 'sync_user_id';

let dbPromise = null;
let fallbackMode = false;
let currentScope = '';
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

export function isGuestScope() {
    return !storedUser();
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
    if (typeof indexedDB === 'undefined') return Promise.resolve(null);
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
        let request;
        try {
            request = indexedDB.open(DB_NAME, DB_VERSION);
        } catch (_) {
            resolve(null);
            return;
        }
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_DOCS)) {
                const docs = db.createObjectStore(STORE_DOCS, { keyPath: 'key' });
                docs.createIndex('scope', 'scope', { unique: false });
            }
            if (!db.objectStoreNames.contains(STORE_OUTBOX)) {
                const outbox = db.createObjectStore(STORE_OUTBOX, { keyPath: 'key' });
                outbox.createIndex('scope', 'scope', { unique: false });
            }
            if (!db.objectStoreNames.contains(STORE_STATE)) {
                db.createObjectStore(STORE_STATE, { keyPath: 'scope' });
            }
            if (!db.objectStoreNames.contains(STORE_DRAFTS)) {
                db.createObjectStore(STORE_DRAFTS, { keyPath: 'scope' });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
        request.onblocked = () => resolve(null);
    });
    return dbPromise;
}

/**
 * 在指定 object store 上執行一次交易。
 * `run(store)` 可以回傳 null（寫入）或一個 Promise（讀取），交易完成後才解析，
 * 因此「寫入成功」代表資料真的落到 IndexedDB，而不是只排進佇列。
 */
async function idbRequest(storeName, mode, run) {
    const db = await openDb();
    if (!db) return { ok: false, error: 'idb_unavailable' };
    return new Promise((resolve) => {
        let tx;
        try {
            tx = db.transaction(storeName, mode);
        } catch (error) {
            resolve({ ok: false, error: 'idb_transaction_failed' });
            return;
        }
        const store = tx.objectStore(storeName);
        let pending;
        try {
            pending = run(store);
        } catch (error) {
            resolve({ ok: false, error: 'idb_request_failed' });
            return;
        }
        tx.oncomplete = async () => {
            let value = pending;
            if (pending && typeof pending.then === 'function') {
                try { value = await pending; } catch (_) { value = null; }
            }
            resolve({ ok: true, value });
        };
        tx.onerror = () => resolve({ ok: false, error: 'idb_write_failed' });
        tx.onabort = () => resolve({ ok: false, error: 'idb_aborted' });
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
        sizeBytes: Number(doc.sizeBytes) || 0
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

async function persistDoc(record) {
    const scope = getArticleScope();
    const doc = toDoc(record, scope);
    const result = await idbRequest(STORE_DOCS, 'readwrite', (store) => { store.put(doc); return null; });
    if (result.ok) return { ok: true, doc };
    // 退回 localStorage（容量有限但不可靜默丟資料）
    const bucket = fallbackRead(scope);
    bucket.docs = bucket.docs.filter((item) => item.id !== record.articleId);
    bucket.docs.push(doc);
    bucket.state = { ...(bucket.state || {}), ...serializeMeta() };
    if (!fallbackWrite(scope, bucket)) {
        meta.persistenceError = 'storage_full';
        return { ok: false, error: 'storage_full' };
    }
    meta.persistenceError = '';
    return { ok: true, doc, fallback: true };
}

async function deleteDoc(id) {
    const scope = getArticleScope();
    const result = await idbRequest(STORE_DOCS, 'readwrite', (store) => { store.delete(docKey(scope, id)); return null; });
    if (result.ok) return { ok: true };
    const bucket = fallbackRead(scope);
    bucket.docs = bucket.docs.filter((item) => item.id !== id);
    return fallbackWrite(scope, bucket) ? { ok: true, fallback: true } : { ok: false, error: 'storage_full' };
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

async function persistMeta() {
    const scope = getArticleScope();
    const payload = { scope, ...serializeMeta() };
    const result = await idbRequest(STORE_STATE, 'readwrite', (store) => { store.put(payload); return null; });
    if (result.ok) return { ok: true };
    const bucket = fallbackRead(scope);
    bucket.state = payload;
    return fallbackWrite(scope, bucket) ? { ok: true } : { ok: false, error: 'storage_full' };
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

async function readOutbox() {
    const scope = getArticleScope();
    const result = await idbRequest(STORE_OUTBOX, 'readonly', (store) => readAll(store));
    if (result.ok) {
        return (result.value || []).filter((op) => op && op.scope === scope);
    }
    const bucket = fallbackRead(scope);
    return (bucket.outbox || []).filter((op) => op && op.scope === scope);
}

async function writeOutboxOp(op) {
    const scope = getArticleScope();
    const payload = { ...op, key: `${scope}\u0000${op.articleId}`, scope };
    const result = await idbRequest(STORE_OUTBOX, 'readwrite', (store) => { store.put(payload); return null; });
    if (result.ok) return { ok: true };
    const bucket = fallbackRead(scope);
    bucket.outbox = (bucket.outbox || []).filter((item) => item.articleId !== op.articleId);
    bucket.outbox.push(payload);
    return fallbackWrite(scope, bucket) ? { ok: true } : { ok: false, error: 'storage_full' };
}

async function removeOutboxOp(articleId) {
    const scope = getArticleScope();
    const result = await idbRequest(STORE_OUTBOX, 'readwrite', (store) => { store.delete(docKey(scope, articleId)); return null; });
    if (result.ok) return { ok: true };
    const bucket = fallbackRead(scope);
    bucket.outbox = (bucket.outbox || []).filter((item) => item.articleId !== articleId);
    return fallbackWrite(scope, bucket) ? { ok: true } : { ok: false, error: 'storage_full' };
}

/**
 * 每篇文章最多保留一個待同步操作（後寫覆蓋先寫）。建立尚未上傳時仍是 create，
 * 之後的修改只更新內容，不會變成第二次建立。
 */
async function enqueue(record, type, options = {}) {
    const existing = (await readOutbox()).find((op) => op.articleId === record.articleId);
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
    return writeOutboxOp(op);
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

async function readDocs(scope) {
    const result = await idbRequest(STORE_DOCS, 'readonly', (store) => readAll(store));
    if (result.ok) return (result.value || []).filter((doc) => doc && doc.scope === scope);
    const bucket = fallbackRead(scope);
    fallbackMode = true;
    return bucket.docs || [];
}

async function readState(scope) {
    const result = await idbRequest(STORE_STATE, 'readonly', (store) => readOne(store, scope));
    if (result.ok && result.value) return result.value;
    const bucket = fallbackRead(scope);
    return bucket.state || null;
}

export async function reloadScope(scope = getArticleScope()) {
    currentScope = scope;
    const docs = await readDocs(scope);
    const storedState = await readState(scope);
    meta = {
        cursor: Number(storedState?.cursor) || 0,
        migrated: storedState?.migrated === true,
        migratedAt: storedState?.migratedAt || '',
        lastSyncAt: storedState?.lastSyncAt || '',
        lastError: storedState?.lastError || '',
        conflicts: storedState?.conflicts && typeof storedState.conflicts === 'object' ? storedState.conflicts : {},
        gatePending: storedState?.gatePending === true,
        persistenceError: ''
    };
    const records = docs
        .map(toRecord)
        .filter(Boolean)
        .sort((a, b) => String(b.lastOpenedAt || b.updatedAt || '').localeCompare(String(a.lastOpenedAt || a.updatedAt || '')));
    state.setAnalyzedArticles(records);
    emitChange();
    return records;
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

export async function pendingCount() {
    return (await readOutbox()).length;
}

export async function listPending() {
    return readOutbox();
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
    const body = String(input?.article ?? input?.body ?? '');
    if (!body.trim()) return { ok: false, error: 'empty_body' };
    const id = String(input?.articleId || input?.id || '') || newArticleId();
    const existing = findRecord(id);
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
    const persisted = await persistDoc(record);
    if (!persisted.ok) {
        // 記憶體仍保留內容，讓使用者可以匯出；但明確回報未持久化。
        replaceRecord(record);
        emitChange();
        return { ok: false, error: persisted.error, record };
    }
    replaceRecord(record);
    if (!options.skipOutbox) {
        await enqueue(record, existing ? 'update' : 'create', { clientMutationId: options.clientMutationId });
    }
    if (options.touch !== false) await touchOpened(id, { silent: true });
    emitChange();
    return { ok: true, record: findRecord(id) };
}

/** 只更新分析結果（詞／句／片語詳解），不改變閱讀順序以外的內容。 */
export async function saveAnalysis(articleId, result, options = {}) {
    const record = findRecord(articleId);
    if (!record) return { ok: false, error: 'record_missing' };
    const next = { ...record, result, updatedAt: nowIso(), dirty: true, pending: true };
    const persisted = await persistDoc(next);
    replaceRecord(next);
    if (!persisted.ok) return { ok: false, error: persisted.error, record: next };
    if (!options.skipOutbox) await enqueue(next, 'update');
    emitChange();
    return { ok: true, record: findRecord(articleId) };
}

export async function renameArticle(articleId, title) {
    const record = findRecord(articleId);
    if (!record) return { ok: false, error: 'record_missing' };
    const clean = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!clean) return { ok: false, error: 'empty_title' };
    const next = { ...record, title: clean, updatedAt: nowIso(), dirty: true, pending: true };
    const persisted = await persistDoc(next);
    replaceRecord(next);
    if (!persisted.ok) return { ok: false, error: persisted.error };
    await enqueue(next, 'update');
    emitChange();
    return { ok: true, record: findRecord(articleId) };
}

/**
 * 軟刪除：本機與伺服器都保留可復原的 tombstone。生詞本不在這裡處理，
 * 由呼叫端決定保留（文章專屬生詞本以 articleId 命名，刪除後仍存在）。
 */
export async function deleteArticle(articleId, options = {}) {
    const record = findRecord(articleId);
    if (!record) return { ok: false, error: 'record_missing' };
    const tombstone = { ...record, deletedAt: nowIso(), updatedAt: nowIso(), dirty: true, pending: true };
    const persisted = await persistDoc(tombstone);
    // 保留 tombstone 在記憶體裡（列表與搜尋會排除），否則待同步的刪除操作
    // 會找不到記錄而被誤判為已完成，伺服器永遠收不到刪除。
    replaceRecord(tombstone);
    if (!persisted.ok) return { ok: false, error: persisted.error };
    if (!options.skipOutbox) {
        // 還沒上傳過的建立：直接撤掉待同步的建立即可，不需要送刪除
        const pending = (await readOutbox()).find((op) => op.articleId === articleId);
        if (pending && pending.type === 'create' && !Number(record.revision)) {
            await removeOutboxOp(articleId);
        } else {
            await enqueue(tombstone, 'delete');
        }
    }
    emitChange();
    return { ok: true, record: tombstone };
}

export async function restoreArticle(snapshot) {
    if (!snapshot || !snapshot.articleId) return { ok: false, error: 'invalid_snapshot' };
    const record = {
        ...snapshot,
        deletedAt: '',
        updatedAt: snapshot.updatedAt || nowIso(),
        lastOpenedAt: snapshot.lastOpenedAt || nowIso(),
        dirty: true,
        pending: true,
        conflict: null
    };
    const persisted = await persistDoc(record);
    if (!persisted.ok) return { ok: false, error: persisted.error };
    replaceRecord(record);
    // 從未上傳過的文章（revision 0）復原後就是一次建立
    await enqueue(record, Number(record.revision) ? 'restore' : 'create');
    emitChange();
    return { ok: true, record: findRecord(record.articleId) };
}

/** 最近閱讀：只改本機 lastOpenedAt，不動文章 revision、不觸發同步。 */
export async function touchOpened(articleId, options = {}) {
    const record = findRecord(articleId);
    if (!record) return { ok: false, error: 'record_missing' };
    const next = { ...record, lastOpenedAt: nowIso() };
    const persisted = await persistDoc(next);
    replaceRecord(next);
    if (!persisted.ok) return { ok: false, error: persisted.error };
    if (!options.silent) emitChange();
    return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// 草稿
// ─────────────────────────────────────────────────────────────────────────────

const EMPTY_DRAFT = { text: '', sourceType: '', sourceUrl: '', title: '', recordId: '', savedAt: '' };

export async function saveDraft(draft) {
    const scope = getArticleScope();
    const payload = {
        scope,
        text: String(draft?.text || ''),
        sourceType: draft?.sourceType || 'paste',
        sourceUrl: draft?.sourceUrl || '',
        title: draft?.title || '',
        recordId: draft?.recordId || '',
        savedAt: nowIso()
    };
    if (!payload.text.trim()) return clearDraft();
    const result = await idbRequest(STORE_DRAFTS, 'readwrite', (store) => { store.put(payload); return null; });
    if (result.ok) return { ok: true, draft: payload };
    const bucket = fallbackRead(scope);
    bucket.draft = payload;
    return fallbackWrite(scope, bucket) ? { ok: true, draft: payload } : { ok: false, error: 'storage_full' };
}

export async function readDraft() {
    const scope = getArticleScope();
    const result = await idbRequest(STORE_DRAFTS, 'readonly', (store) => readOne(store, scope));
    if (result.ok) return result.value || null;
    const bucket = fallbackRead(scope);
    return bucket.draft || null;
}

export async function clearDraft() {
    const scope = getArticleScope();
    const result = await idbRequest(STORE_DRAFTS, 'readwrite', (store) => { store.delete(scope); return null; });
    if (result.ok) return { ok: true };
    const bucket = fallbackRead(scope);
    delete bucket.draft;
    return fallbackWrite(scope, bucket) ? { ok: true } : { ok: false, error: 'storage_full' };
}

/** 接受伺服器目前版本號但不改本機內容（用於「保留本機修改並重新套用」）。 */
export async function setBaseRevision(articleId, revision) {
    const record = findRecord(articleId);
    if (!record) return { ok: false, error: 'record_missing' };
    const next = { ...record, revision: Number(revision) || 0 };
    const persisted = await persistDoc(next);
    replaceRecord(next);
    return persisted.ok ? { ok: true } : { ok: false, error: persisted.error };
}

/**
 * 把本機內容複製成一篇新文章（衝突時「另存副本」）。回傳新文章的 ID。
 */
export async function duplicateArticle(articleId, titleSuffix = '') {
    const record = findRecord(articleId);
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
    const persisted = await persistDoc(copy);
    if (!persisted.ok) return { ok: false, error: persisted.error };
    replaceRecord(copy);
    await enqueue(copy, 'create');
    emitChange();
    return { ok: true, articleId: id };
}

// ─────────────────────────────────────────────────────────────────────────────
// 同步狀態（游標、衝突）
// ─────────────────────────────────────────────────────────────────────────────

export function getCursor() {
    return Number(meta.cursor) || 0;
}

export async function setCursor(cursor) {
    meta.cursor = Number(cursor) || 0;
    await persistMeta();
}

export async function markSynced(at = nowIso()) {
    meta.lastSyncAt = at;
    meta.lastError = '';
    await persistMeta();
}

export async function markSyncError(code) {
    meta.lastError = String(code || '');
    await persistMeta();
}

export function getConflicts() {
    return Object.values(meta.conflicts || {});
}

export async function setConflict(articleId, info) {
    meta.conflicts = { ...(meta.conflicts || {}), [articleId]: { articleId, at: nowIso(), ...info } };
    await persistMeta();
    emitChange();
}

export async function clearConflict(articleId) {
    if (!meta.conflicts || !meta.conflicts[articleId]) return;
    const next = { ...meta.conflicts };
    delete next[articleId];
    meta.conflicts = next;
    await persistMeta();
    emitChange();
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

export async function applyRemoteDoc(doc) {
    if (!doc || !doc.id) return { ok: false, error: 'invalid_document' };
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
    const persisted = await persistDoc(record);
    replaceRecord(record);
    emitChange();
    return persisted.ok ? { ok: true, record } : { ok: false, error: persisted.error };
}

export async function applyRemoteTombstone(articleId) {
    const record = findRecord(articleId);
    if (!record) return { ok: true };
    const next = { ...record, deletedAt: nowIso(), dirty: false, pending: false };
    await persistDoc(next);
    replaceRecord(next);
    await removeOutboxOp(articleId);
    emitChange();
    return { ok: true };
}

/** 伺服器要求完整重同步時，移除本機已不存在的遠端文章（保留本機未上傳者）。 */
export async function reconcileFullList(serverIds) {
    const ids = new Set(serverIds);
    const removed = [];
    for (const record of (state.analyzedArticles || []).slice()) {
        if (!record || !record.articleId) continue;
        if (ids.has(record.articleId)) continue;
        if (record.dirty || record.pending) continue;
        await deleteDoc(record.articleId);
        dropRecord(record.articleId);
        removed.push(record.articleId);
    }
    if (removed.length) emitChange();
    return removed;
}

// ─────────────────────────────────────────────────────────────────────────────
// outbox 結果處理
// ─────────────────────────────────────────────────────────────────────────────

export async function markOpDone(articleId, { revision, serverUpdatedAt } = {}) {
    const record = findRecord(articleId);
    await removeOutboxOp(articleId);
    if (!record) return;
    const next = {
        ...record,
        revision: Number.isFinite(revision) ? Number(revision) : record.revision,
        updatedAt: serverUpdatedAt || record.updatedAt,
        dirty: false,
        pending: false,
        conflict: null
    };
    await persistDoc(next);
    replaceRecord(next);
    await clearConflict(articleId);
    emitChange();
}

export async function markOpFailed(articleId, error, options = {}) {
    const record = findRecord(articleId);
    if (!record) return;
    const next = { ...record, dirty: true, pending: true };
    await persistDoc(next);
    replaceRecord(next);
    if (error) await markSyncError(error);
    if (options.conflict) await setConflict(articleId, options.conflict);
    emitChange();
}

/** 伺服器已沒有這篇（例如在別的裝置刪除後又被清空）：把待同步操作改成建立。 */
export async function requeueAsCreate(articleId) {
    const record = findRecord(articleId);
    if (!record) return { ok: false, error: 'record_missing' };
    const next = { ...record, revision: 0, deletedAt: '', dirty: true, pending: true };
    await persistDoc(next);
    replaceRecord(next);
    const result = await enqueue(next, 'create');
    emitChange();
    return result.ok ? { ok: true } : { ok: false, error: result.error };
}

/** 衝突處理後重新排入上傳（保留本機內容）。 */
export async function enqueueForRetry(articleId) {
    const record = findRecord(articleId);
    if (!record) return { ok: false, error: 'record_missing' };
    const next = { ...record, dirty: true, pending: true };
    await persistDoc(next);
    replaceRecord(next);
    const type = record.deletedAt ? 'delete' : 'update';
    const result = await enqueue(next, type);
    emitChange();
    return result.ok ? { ok: true } : { ok: false, error: result.error };
}

/** 丟掉某篇文章的待同步操作（改用伺服器版本時）。 */
export async function discardPending(articleId) {
    return removeOutboxOp(articleId);
}

export function getGatePending() {
    return meta.gatePending === true;
}

export async function setGatePending(value) {
    meta.gatePending = value === true;
    await persistMeta();
}

// ─────────────────────────────────────────────────────────────────────────────
// 匯出／匯入（完整內容，可離線還原）
// ─────────────────────────────────────────────────────────────────────────────

export function exportDocuments() {
    return (state.analyzedArticles || [])
        .filter((item) => item && item.articleId)
        .map((item) => ({
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
        }));
}

/**
 * 從備份還原文章。已存在且本機較新的記錄不覆蓋；`replace` 為 true 時以備份為準。
 */
export async function importDocuments(documents, options = {}) {
    const list = Array.isArray(documents) ? documents : [];
    let imported = 0;
    let skipped = 0;
    for (const raw of list) {
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
        const persisted = await persistDoc(record);
        if (!persisted.ok) return { ok: false, error: persisted.error, imported, skipped };
        if (!record.deletedAt) replaceRecord(record);
        await enqueue(record, existing ? 'update' : 'create');
        imported += 1;
    }
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
export async function migrateLegacyLocalData() {
    if (getMigrationMarker()?.verified) return { ok: true, skipped: true };
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
        scope: getArticleScope(),
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
        const persisted = await persistDoc(record);
        if (!persisted.ok) return { ok: false, error: persisted.error, migrated };
        replaceRecord(record);
        await enqueue(record, 'create', { legacy: true });
        existingIds.add(id);
        migrated += 1;
    }

    // 3. 回讀驗證：數量、原文、分析、來源都必須一致
    const verifyList = await readDocs(getArticleScope());
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
    const marker = { verified: true, at: nowIso(), count: migrated, backupKey };
    try { localStorage.setItem(migrationMarkerKey(getArticleScope()), JSON.stringify(marker)); } catch (_) {}
    meta.migrated = true;
    meta.migratedAt = marker.at;
    if (migrated > 0) meta.gatePending = true;
    await persistMeta();
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
export async function adoptGuestArticles() {
    const guestScope = `${endpoint() || 'local'}::guest`;
    if (guestScope === getArticleScope()) return { ok: true, imported: 0 };
    const docs = await readDocs(guestScope);
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
    return importDocuments(documents, { replace: false });
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
export async function importLegacyArticles(entries) {
    const list = Array.isArray(entries) ? entries : [];
    const existing = new Set((state.analyzedArticles || []).map((item) => item && item.articleId));
    let imported = 0;
    for (const raw of list) {
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
        const persisted = await persistDoc(record);
        if (!persisted.ok) return { ok: false, error: persisted.error, imported };
        replaceRecord(record);
        await enqueue(record, 'create', { legacy: true });
        existing.add(id);
        imported += 1;
    }
    if (imported > 0) {
        meta.gatePending = true;
        meta.migrated = true;
        await persistMeta();
        emitChange();
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
