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
const STORE_ARTICLE_GENERATIONS = STORE.ARTICLE_GENERATIONS;
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
// 真正由使用者開啟／按需載入過的文章。單次寫入或匯入也會進 loadedDocs，
// 但同 scope 重新整理只需保留這批常駐正文，不得把所有剛寫入的冷文章留下。
const residentArticleIds = new Set();
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
    return docMatchesSummary(doc, summary) ? doc : null;
}

/**
 * 已載入全文是否仍對應目前清單摘要。
 * revision 與 contentVersion 必須同時一致：只比正文版本會讓重新同步後
 * revision 已推進的舊文件被當成最新內容。
 */
function docMatchesSummary(doc, summary) {
    if (!doc || !summary || !doc.id || !summary.articleId) return false;
    if (doc.id !== summary.articleId) return false;
    if (!doc.scope || !summary.scope || doc.scope !== summary.scope) return false;
    if (doc.deletedAt || summary.deletedAt) return false;
    if (Number(doc.revision) !== Number(summary.revision)) return false;
    // 代際也要一致：重建（404 → create）後 revision 會從 0 重算，舊代際的
    // 快取文件即使 revision／正文碰巧相同，也不得被當成目前版本。
    if ((Number(doc.generation) || 0) !== (Number(summary.generation) || 0)) return false;
    return contentVersionOf(doc.body || '') === summary.contentVersion;
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

/** 把 IndexedDB request 包成 Promise，供同一個交易內平行發出多個讀取。 */
function requestValue(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('idb_request_failed'));
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// 本機備援（IndexedDB 不可用時）
// ─────────────────────────────────────────────────────────────────────────────

function fallbackKey(scope) {
    return FALLBACK_PREFIX + scope;
}

/** localStorage 備援桶裡的 per-article 代際 ledger（`{ [articleId]: generation }`）。 */
function fallbackGeneration(bucket, articleId) {
    const map = bucket && bucket.generations;
    if (!map || typeof map !== 'object') return 0;
    return Number(map[articleId]) || 0;
}

/** 代際只能前進；回傳是否有實際提高。 */
function rememberFallbackGeneration(bucket, articleId, generation) {
    const value = Number(generation) || 0;
    if (!articleId || value <= fallbackGeneration(bucket, articleId)) return false;
    const map = bucket.generations && typeof bucket.generations === 'object' ? bucket.generations : {};
    bucket.generations = { ...map, [articleId]: value };
    return true;
}

function fallbackRead(scope) {
    try {
        const raw = localStorage.getItem(fallbackKey(scope));
        const parsed = raw ? JSON.parse(raw) : null;
        if (parsed && Array.isArray(parsed.docs)) return parsed;
    } catch (_) {}
    return { docs: [], outbox: [], state: {} };
}

/**
 * 回執專用的嚴格讀取：必須分辨「合法空桶」與讀取／解析失敗。
 *
 * `fallbackRead()` 為了讓一般讀取路徑（第一次啟動、尚未有資料）維持可用，
 * 會把任何例外都當成空桶；但回執若也這樣做，會把「讀不到文件／outbox」
 * 誤判成「沒有需要確認的操作」，於是在資料其實還在的情況下回報推送成功。
 * 這裡只回報實際狀態，讓 markOpDone／markOpsDone 明確失敗並保留 outbox。
 */
function fallbackReadStrict(scope) {
    let raw;
    try {
        raw = localStorage.getItem(fallbackKey(scope));
    } catch (_) {
        return { ok: false, error: 'storage_read_failed' };
    }
    if (raw == null || raw === '') {
        return { ok: true, bucket: { docs: [], outbox: [], state: {} } };
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (_) {
        return { ok: false, error: 'storage_corrupt' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, error: 'storage_corrupt' };
    }
    // 一般後備桶一定帶 docs 陣列；形狀不對時不能當成「沒有待確認操作」。
    if (!Array.isArray(parsed.docs)) {
        return { ok: false, error: 'storage_corrupt' };
    }
    // 舊格式桶可能沒有 outbox（視為空）；一旦存在卻不是陣列，代表寫入端或
    // 儲存已被破壞，不能當成「沒有待確認操作」而在回執／同步收尾時把 outbox
    // 覆寫成 []（那會讓原本可以重試的 mutation 永久消失）。
    if (parsed.outbox != null && !Array.isArray(parsed.outbox)) {
        return { ok: false, error: 'storage_corrupt' };
    }
    return { ok: true, bucket: parsed };
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
        // 重建代際：舊資料沒有這個欄位就視為 0。
        generation: Number(summary.generation) || 0,
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
        generation: Number(doc.generation) || 0,
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
        // 重建代際（本機持久化欄位）：每次「伺服器確認不存在 → 建立」都會
        // 遞增，回執必須帶同一代際才能改動 revision／updatedAt。
        generation: Number(record.generation) || 0,
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

// 文章清單的 Map 索引：首次同步逐篇套用時，findRecord 不再每次掃描整個
// 陣列（1,000 篇會累積成 O(N²)）。state.setAnalyzedArticles 換新陣列後自動重建。
let recordIndexSource = null;
let recordIndex = new Map();

function ensureRecordIndex() {
    const list = state.analyzedArticles || [];
    if (recordIndexSource === list) return recordIndex;
    recordIndexSource = list;
    recordIndex = new Map();
    for (const item of list) {
        if (item && item.articleId) recordIndex.set(item.articleId, item);
    }
    return recordIndex;
}

function setRecordIndex(list, index) {
    recordIndexSource = list;
    recordIndex = index;
}

function findRecord(id) {
    return ensureRecordIndex().get(id) || null;
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
    // 讀改寫：讀不到／損壞時不得用「空桶 + 這篇」覆寫，否則其他文件與
    // 待同步操作會一起消失。只有 null／空字串（合法空桶）才視為沒有資料。
    const read = fallbackReadStrict(scope);
    if (!read.ok) {
        meta.persistenceError = read.error;
        return { ok: false, error: read.error };
    }
    const bucket = read.bucket;
    bucket.docs = (bucket.docs || []).filter((item) => item.id !== doc.id);
    bucket.docs.push(doc);
    // 代際 ledger 與文件一起寫：文件之後被移除，屏障仍然存在。
    rememberFallbackGeneration(bucket, doc.id, doc.generation);
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
    if (fallbackMode) {
        // 讀取失敗時不回寫：fallbackDocWrite 會用嚴格讀取再確認一次，這裡先
        // 拿到持久化文件才能採用它的代際／revision，所以也必須嚴格。
        const read = fallbackReadStrict(scope);
        if (!read.ok) {
            meta.persistenceError = read.error;
            return { ok: false, error: read.error };
        }
        const bucket = read.bucket;
        const storedDoc = (bucket.docs || []).find((item) => item && item.id === record.articleId) || null;
        const merged = adoptStoredGeneration(record, storedDoc, fallbackGeneration(bucket, record.articleId));
        record.revision = merged.revision;
        record.generation = merged.generation;
        const doc = toDoc(merged, scope);
        const written = fallbackDocWrite(scope, doc);
        if (written.ok) { dataEpoch += 1; cacheDoc(doc); loadedDocs.set(record.articleId, doc); }
        return written;
    }
    // docs 與 article_summaries 必須在同一個交易：callback 內若 store 不在
    // 交易 scope，會同步拋出 NotFoundError，交易 abort，不能只寫了一半。
    // 交易內先讀既有文件與代際 ledger：另一個分頁重建過、或文件被完整 pull
    // 移除後，就不能把舊代際的 revision／代際寫回去。
    const result = await idbRequest([STORE_DOCS, STORE_ARTICLE_SUMMARIES, STORE_ARTICLE_GENERATIONS], 'readwrite', (stores) => {
        return Promise.all([
            requestValue(stores[STORE_DOCS].get(docKey(scope, record.articleId))),
            requestValue(stores[STORE_ARTICLE_GENERATIONS].get(docKey(scope, record.articleId)))
        ]).then(([storedDoc, ledgerRow]) => {
            const merged = adoptStoredGeneration(record, storedDoc, ledgerRowGeneration(ledgerRow));
            record.revision = merged.revision;
            record.generation = merged.generation;
            const doc = toDoc(merged, scope);
            stores[STORE_DOCS].put(doc);
            const summary = summarizeArticleDoc(doc);
            if (summary) stores[STORE_ARTICLE_SUMMARIES].put(summary);
            if (ledgerRowGeneration(ledgerRow) < storedGenerationOf(doc)) {
                stores[STORE_ARTICLE_GENERATIONS].put(generationRow(scope, doc.id, doc.generation));
            }
            return doc;
        });
    }, ctx);
    if (result.ok) {
        dataEpoch += 1;
        const doc = result.value || toDoc(record, scope);
        loadedDocs.set(record.articleId, doc);
        meta.persistenceError = '';
        return { ok: true, doc };
    }
    if (result.error === 'idb_unavailable') {
        fallbackMode = true;
        return persistDoc(record, ctx);
    }
    // 一般交易錯誤只回報失敗，不切換權威來源。
    meta.persistenceError = result.error || 'idb_write_failed';
    return { ok: false, error: meta.persistenceError };
}

/**
 * 文件是否仍有本機未同步狀態。`onlyIfClean` 的移除（完整 pull）必須用
 * 交易內重新讀到的文件與 outbox 判斷，不能只看呼叫端記憶體：另一個分頁
 * 可能在 pull 期間剛保存新正文，本頁的 clean 記憶體已是舊版本。
 */
function docHasLocalPending(doc, pendingOp) {
    if (pendingOp) return true;
    return !!(doc && (doc.dirty || doc.pending));
}

/**
 * localStorage 後備的移除：與 IndexedDB 交易同樣的語意（同一段同步程式碼，
 * 中間沒有 await，讀取與寫入不會被另一個分頁插隊）。
 */
function fallbackRemoveDoc(scope, id, options = {}) {
    const memoryGeneration = Number(options.generation) || 0;
    // 讀不到時必須回報儲存失敗（呼叫端要能與 local_pending 的刻意跳過區分），
    // 更不能寫入：否則整桶會被空資料取代。
    const read = fallbackReadStrict(scope);
    if (!read.ok) {
        meta.persistenceError = read.error;
        return { ok: false, error: read.error };
    }
    const bucket = read.bucket;
    const storedDoc = (bucket.docs || []).find((item) => item && item.id === id) || null;
    const pendingOp = (bucket.outbox || []).find((op) => op && op.articleId === id) || null;
    if (options.onlyIfClean === true && docHasLocalPending(storedDoc, pendingOp)) {
        return { ok: false, skipped: true, reason: 'local_pending', doc: storedDoc };
    }
    let generation = Math.max(
        memoryGeneration,
        storedGenerationOf(storedDoc),
        fallbackGeneration(bucket, id)
    );
    // 遠端已沒有這篇：舊生命週期到此結束，ledger 前進一代。之後同 ID
    // 還原採用更高代際，上一代的延遲回執（含冪等重試後才回來的）無法匹配。
    if (options.retireGeneration === true && storedDoc) generation += 1;
    rememberFallbackGeneration(bucket, id, generation);
    bucket.docs = (bucket.docs || []).filter((item) => item.id !== id);
    const ok = fallbackWrite(scope, bucket);
    if (ok) { dataEpoch += 1; loadedDocs.delete(id); residentArticleIds.delete(id); }
    return ok ? { ok: true, fallback: true } : { ok: false, error: 'storage_full' };
}

/**
 * localStorage 後備的遠端墓碑：與 IndexedDB 版本相同的語意（同一段同步程式碼，
 * 讀取與寫入之間沒有 await）。遠端確認刪除代表這一條生命週期結束，代際前進
 * 一代，之後同 ID 還原（備份／復原）採用更高的代際，上一代延遲回來的回執
 * 便無法匹配。同一個墓碑重複送達（本地已是 tombstone）時不再推進代際。
 */
function fallbackApplyTombstones(scope, ids) {
    // 遠端墓碑會刪文件與 outbox：讀不到時絕不能當成空桶套用。
    const read = fallbackReadStrict(scope);
    if (!read.ok) return { ok: false, error: read.error, results: [], applied: [] };
    const bucket = read.bucket;
    const docs = Array.isArray(bucket.docs) ? bucket.docs.slice() : [];
    let outbox = Array.isArray(bucket.outbox) ? bucket.outbox.slice() : [];
    const at = nowIso();
    const applied = [];
    const results = [];
    let changed = false;
    for (const articleId of ids) {
        const index = docs.findIndex((item) => item && item.id === articleId);
        const localDoc = index >= 0 ? docs[index] : null;
        const pendingOp = outbox.find((op) => op && op.articleId === articleId) || null;
        if (!localDoc) {
            results.push({ id: articleId, applied: false, missing: true });
            continue;
        }
        // 本機仍有未同步內容（含使用者主動刪除的 delete outbox）時不改動任何東西：
        // 使用者主動刪除的代際必須與它的操作保持一致，不能被遠端墓碑退休。
        if (localDoc.dirty || localDoc.pending || pendingOp) {
            results.push({ id: articleId, applied: false, skippedLocalPending: true });
            continue;
        }
        if (localDoc.deletedAt) {
            results.push({ id: articleId, applied: false, alreadyDeleted: true });
            continue;
        }
        // 遠端墓碑＝舊生命週期結束：代際前進一代，建立新的屏障。
        const generation = Math.max(
            storedGenerationOf(localDoc),
            fallbackGeneration(bucket, articleId)
        ) + 1;
        const tombstone = { ...localDoc, deletedAt: at, dirty: false, pending: false, generation };
        docs[index] = tombstone;
        outbox = outbox.filter((op) => !op || op.articleId !== articleId);
        rememberFallbackGeneration(bucket, articleId, generation);
        applied.push({ articleId, tombstone });
        results.push({ id: articleId, applied: true, deletedAt: at, generation });
        changed = true;
    }
    if (!changed) return { ok: true, results, applied };
    bucket.docs = docs;
    bucket.outbox = outbox;
    if (!fallbackWrite(scope, bucket)) return { ok: false, error: 'storage_full', results: [], applied: [] };
    return { ok: true, results, applied };
}

async function deleteDoc(id, ctx = captureArticleContext(), options = {}) {
    if (!isArticleContextActive(ctx)) return staleResult();
    const scope = ctx.scope;
    // 文件被移除時，代際屏障必須留在 ledger：之後同 ID 還原（匯入／復原）
    // 仍要沿用較高的代際，不能從 0 重新開始。
    const memoryGeneration = Number(options.generation) || 0;
    const onlyIfClean = options.onlyIfClean === true;
    const retireGeneration = options.retireGeneration === true;
    if (fallbackMode) return fallbackRemoveDoc(scope, id, options);
    const result = await idbRequest([STORE_DOCS, STORE_ARTICLE_SUMMARIES, STORE_OUTBOX, STORE_ARTICLE_GENERATIONS], 'readwrite', (stores) => {
        return Promise.all([
            requestValue(stores[STORE_DOCS].get(docKey(scope, id))),
            requestValue(stores[STORE_ARTICLE_GENERATIONS].get(docKey(scope, id))),
            requestValue(stores[STORE_OUTBOX].get(docKey(scope, id)))
        ]).then(([storedDoc, ledgerRow, pendingOp]) => {
            if (onlyIfClean && docHasLocalPending(storedDoc, pendingOp)) {
                return { skipped: true, doc: storedDoc || null };
            }
            let generation = Math.max(
                memoryGeneration,
                storedGenerationOf(storedDoc),
                ledgerRowGeneration(ledgerRow)
            );
            // 遠端已沒有這篇：舊生命週期到此結束，ledger 前進一代。
            if (retireGeneration && storedDoc) generation += 1;
            if (generation > ledgerRowGeneration(ledgerRow)) {
                stores[STORE_ARTICLE_GENERATIONS].put(generationRow(scope, id, generation));
            }
            stores[STORE_DOCS].delete(docKey(scope, id));
            stores[STORE_ARTICLE_SUMMARIES].delete(docKey(scope, id));
            return { skipped: false };
        });
    }, ctx);
    if (result.ok) {
        const value = result.value || {};
        if (value.skipped) {
            return { ok: false, skipped: true, reason: 'local_pending', doc: value.doc };
        }
        dataEpoch += 1;
        loadedDocs.delete(id);
        residentArticleIds.delete(id);
        docCache.delete(docKey(scope, id));
        meta.persistenceError = '';
        return { ok: true };
    }
    if (result.error === 'idb_unavailable') {
        fallbackMode = true;
        return fallbackRemoveDoc(scope, id, options);
    }
    meta.persistenceError = result.error || 'idb_write_failed';
    return { ok: false, error: meta.persistenceError };
}

/**
 * 等待期間可能已完成舊回執（markOpsDone 推進 revision）或寫入 importSnapshot。
 * 交易內讀到的已提交文件版本是下限：不能用交易前的舊記憶體 revision 蓋回去，
 * 否則下一步的 expectedRevision 會落后， PUT 永遠 409。
 *
 * 例外一：伺服器確認 404 後的重建（`resetRevision`）必須把版本基準歸零。
 * 取最大值會讓重建後的建立（遠端 revision 1）仍帶著舊版本，下一次更新必定
 * 409；重建的原子性由 persistDocWithOp 在交易內核對操作身分來保護。
 * 重建的內容基準是「目前持久化文件」：處理 404 的分頁記憶體可能還停在
 * 上一個代際（舊正文），不能拿它覆蓋另一個分頁剛保存的最新內容。
 *
 * 例外二：代際比記憶體新（另一個分頁已經重建過，或文件被完整 pull 移除後
 * 由 ledger 接手），舊分頁的 `revision` 屬於上一個代際，不能合併回去，只能
 * 採用持久化文件的新基準。使用者的新正文仍然保留，只是版本基準跟著新代際走。
 */
function mergeStoredRevision(record, storedDoc, options = {}) {
    const ledgerGeneration = Number(options.ledgerGeneration) || 0;
    const storedGeneration = Math.max(storedGenerationOf(storedDoc), ledgerGeneration);
    const memoryGeneration = Number(record && record.generation) || 0;
    if (options.resetRevision === true) {
        // 代際只能前進：以「持久化文件的代際、ledger、被確認 404 的操作代際」
        // 的最高值 + 1 作為新代際。用記憶體 + 1 會讓第二次重建重用上一個代際
        // （stored 1 / memory 0 → max(1, 0 + 1) = 1），舊回執便重新生效。
        const operationGeneration = Number(options.operationGeneration) || 0;
        const base = storedDoc ? contentFromStoredDoc(storedDoc, record) : record;
        return {
            ...base,
            articleId: record.articleId,
            revision: 0,
            generation: Math.max(storedGeneration, memoryGeneration, operationGeneration) + 1
        };
    }
    // 重新建立（同 ID 文件已被移除、備份還原到沒有這份文件的地方）：
    // 本機沒有任何持久化文件、也沒有等待中的操作時，上一生命週期的遠端
    // revision 已經沒有意義，建立一定要從 0 開始。沿用備份裡的舊版本
    // （例如 gen1 / rev2）會讓建立成功後遠端停在 1、本機停在 2，下一次
    // 更新必定 409。新格式與沒有 generation 的舊備份都走這條規則。
    if (options.type === 'create' && !storedDoc && options.hasPendingOp !== true) {
        return {
            ...record,
            revision: 0,
            generation: Math.max(storedGeneration, memoryGeneration)
        };
    }
    if (storedGeneration > memoryGeneration) {
        return {
            ...record,
            revision: Number(storedDoc && storedDoc.revision) || 0,
            generation: storedGeneration
        };
    }
    const storedRevision = Number(storedDoc && storedDoc.revision) || 0;
    return {
        ...record,
        revision: Math.max(Number(record.revision) || 0, storedRevision),
        generation: Math.max(storedGeneration, memoryGeneration)
    };
}

/** 重建時以持久化文件的內容為準（保留另一個分頁剛保存的最新正文）。 */
function contentFromStoredDoc(storedDoc, fallback) {
    return {
        ...fallback,
        title: storedDoc.title || '',
        article: storedDoc.body || '',
        result: storedDoc.analysis === undefined ? null : storedDoc.analysis,
        sourceType: storedDoc.sourceType || fallback.sourceType,
        sourceUrl: storedDoc.sourceUrl || '',
        createdAt: storedDoc.createdAt || fallback.createdAt,
        lastOpenedAt: storedDoc.lastOpenedAt || fallback.lastOpenedAt,
        updatedAt: storedDoc.updatedAt || fallback.updatedAt,
        deletedAt: storedDoc.deletedAt || ''
    };
}

/**
 * 單純寫文件（最近開啟時間、接受伺服器版本）也要跟代際對齊：
 * 另一個分頁重建後，舊分頁的記憶體 revision 不能在這裡先被寫回去，
 * 否則下一次保存又會拿舊代際的版本去比對遠端。
 */
function adoptStoredGeneration(record, storedDoc, ledgerGeneration = 0) {
    const storedGeneration = Math.max(storedGenerationOf(storedDoc), Number(ledgerGeneration) || 0);
    const memoryGeneration = Number(record && record.generation) || 0;
    if (storedGeneration > memoryGeneration) {
        return {
            ...record,
            revision: Number(storedDoc && storedDoc.revision) || 0,
            generation: storedGeneration
        };
    }
    return { ...record, generation: memoryGeneration };
}

/**
 * 重建後，被取代的舊操作回執不得再把版本基準推回去。
 *
 * 自代際機制上線後，這裡只保留舊版寫在 outbox 上的 `supersededMutations`
 * （遷移前就已存在的操作）；新流程不再寫入這個欄位，因此它不會隨重建次數
 * 無界成長，實際防護由文件與操作的 `generation` 負責。
 *
 * 升級前遺留的清單必須「完整」保留與比對：截取末 N 筆會讓清單前半的舊回執
 * 重新生效（那些回執與文件同為 generation 0），等於直接拆掉屏障。
 */
function ignoresRebuiltReceipt(pending, clientMutationId) {
    if (!pending || !clientMutationId) return false;
    if (!Array.isArray(pending.supersededMutations)) return false;
    return pending.supersededMutations.includes(clientMutationId);
}

/**
 * 回執所屬代際是否仍等於持久化文件的代際。
 * 缺少代際（舊版資料／舊呼叫端）一律視為 0：只有文件也還在 0 代際時才適用，
 * 重建過的文章不會因為回執沒帶欄位就被當成目前代際。
 */
function receiptGenerationOf(entry) {
    return Number(entry && entry.generation) || 0;
}

function storedGenerationOf(doc) {
    return Number(doc && doc.generation) || 0;
}

function ledgerRowGeneration(row) {
    return Number(row && row.generation) || 0;
}

/** 文件可能已被完整 pull 移除，代際屏障由 ledger 接手。 */
function effectiveStoredGeneration(storedDoc, ledgerRow) {
    return Math.max(storedGenerationOf(storedDoc), ledgerRowGeneration(ledgerRow));
}

/** ledger 列（與文件同一個 key，scope + articleId）。 */
function generationRow(scope, articleId, generation) {
    return { key: docKey(scope, articleId), scope, articleId, generation: Number(generation) || 0 };
}

/**
 * 永久文件與待同步操作在同一個 IndexedDB 交易提交。
 *
 * outbox 的「讀取既有操作 → 合併快照／revision → 寫入」也必須在這個交易內：
 * 同步流程可能在文章儲存讀取之後才寫入 importSnapshot，若用交易外的舊快照
 * 覆蓋，剛提交的「實際送出證據」就會消失，回應遺失後重載只能產生假衝突。
 * 交易完成才回報成功；IndexedDB 不可用時退回單一 localStorage 桶（讀取、
 * 合併、寫入在同一個同步區段完成，中間沒有 await）。
 */
async function persistDocWithOp(record, type, options = {}) {
    const ctx = options.ctx || captureArticleContext();
    if (!isArticleContextActive(ctx)) return staleResult();
    const scope = ctx.scope;
    // 重建（404 → create）只能在交易內確認「目前仍是同一個待同步操作」才執行；
    // 等待期間若已有新的本機修改取代它，保留它的版本基準，下一輪重新處理。
    const resetFromMutationId = typeof options.resetFromMutationId === 'string' ? options.resetFromMutationId : '';
    const wantsReset = options.resetRevision === true;
    if (fallbackMode) {
        // localStorage 沒有交易語意：這段不能有 await，否則另一個同步工作
        // 可能在讀取與寫入之間提交快照，又被這份舊 outbox 覆蓋。
        // 讀取必須嚴格：讀不到時不能把「空桶 + 這次操作」寫回去。
        const read = fallbackReadStrict(scope);
        if (!read.ok) {
            meta.persistenceError = read.error;
            return { ok: false, error: read.error };
        }
        const bucket = read.bucket;
        const storedDoc = (bucket.docs || []).find((item) => item && item.id === record.articleId) || null;
        const existingOp = (bucket.outbox || []).find((op) => op && op.articleId === record.articleId) || null;
        if (wantsReset && resetFromMutationId && (!existingOp || existingOp.clientMutationId !== resetFromMutationId)) {
            return { ok: false, error: 'requeue_deferred', deferred: true };
        }
        const merged = mergeStoredRevision(record, storedDoc, {
            resetRevision: wantsReset,
            ledgerGeneration: fallbackGeneration(bucket, record.articleId),
            operationGeneration: Number(existingOp && existingOp.generation) || 0,
            type,
            hasPendingOp: !!existingOp
        });
        record.revision = merged.revision;
        record.generation = merged.generation;
        const doc = toDoc(merged, scope);
        // 交易內看到的持久化文件才是權威來源：記憶體誤以為還是普通文章、
        // 但持久化文件已是墓碑時（另一個分頁剛套用遠端墓碑），備份還原
        // 也要升級成 restore_update，而不是送出必被拒絕的 PUT。
        const effectiveType = restoreUpdateType(type, options, storedDoc);
        const op = options.skipOutbox
            ? null
            : createOutboxOp(merged, effectiveType, { ...options, resetRevision: wantsReset }, existingOp);
        const written = fallbackDocWrite(scope, doc, op ? { ...op, key: docKey(scope, op.articleId), scope } : null);
        if (written.ok) {
            dataEpoch += 1;
            loadedDocs.set(merged.articleId, doc);
        }
        return written;
    }
    // outbox 一律加入交易（即使 skipOutbox 不寫操作）：合併版本基準時要讀到
    // 既有操作，才知道這次 create 是否真的是「完全重新建立」。
    const storeNames = [STORE_DOCS, STORE_ARTICLE_SUMMARIES, STORE_OUTBOX, STORE_ARTICLE_GENERATIONS];
    // 交易內再核對入口 scope：A 儲存期間切到 B（或 A→B→A）都不得再寫。
    const result = await idbRequest(storeNames, 'readwrite', (stores) => {
        const reads = [
            requestValue(stores[STORE_DOCS].get(docKey(scope, record.articleId))),
            requestValue(stores[STORE_ARTICLE_GENERATIONS].get(docKey(scope, record.articleId)))
        ];
        if (stores[STORE_OUTBOX]) reads.push(requestValue(stores[STORE_OUTBOX].get(docKey(scope, record.articleId))));
        return Promise.all(reads).then(([storedDoc, ledgerRow, existingOp]) => {
            if (!isArticleContextActive(ctx)) {
                try { stores[STORE_DOCS].transaction.abort(); } catch (_) {}
                return { stale: true };
            }
            // 重建前在交易內核對操作身分：已被新的本機修改取代就放棄，
            // 不把它的版本基準歸零，也不覆蓋新的操作。
            if (wantsReset && resetFromMutationId
                && (!existingOp || existingOp.clientMutationId !== resetFromMutationId)) {
                return { deferred: true };
            }
            // 第二次重建：以持久化文件 + ledger + 被確認 404 的操作代際為基準，
            // 不能只用記憶體（舊分頁）推算，否則會重用上一個代際。
            const merged = mergeStoredRevision(record, storedDoc, {
                resetRevision: wantsReset,
                ledgerGeneration: ledgerRowGeneration(ledgerRow),
                operationGeneration: Number(existingOp && existingOp.generation) || 0,
                type,
                hasPendingOp: !!existingOp
            });
            const effectiveType = restoreUpdateType(type, options, storedDoc);
            const doc = toDoc(merged, scope);
            stores[STORE_DOCS].put(doc);
            const summary = summarizeArticleDoc(doc);
            if (summary) stores[STORE_ARTICLE_SUMMARIES].put(summary);
            if (ledgerRowGeneration(ledgerRow) < storedGenerationOf(doc)) {
                stores[STORE_ARTICLE_GENERATIONS].put(generationRow(scope, doc.id, doc.generation));
            }
            const op = (!options.skipOutbox && stores[STORE_OUTBOX])
                ? createOutboxOp(merged, effectiveType, { ...options, resetRevision: wantsReset }, existingOp || null)
                : null;
            if (op) stores[STORE_OUTBOX].put({ ...op, key: docKey(scope, op.articleId), scope });
            return { doc, op, revision: merged.revision, generation: merged.generation };
        });
    }, ctx);
    if (!isArticleContextActive(ctx)) return staleResult();
    if (!result.ok) {
        if (result.error === 'idb_unavailable') {
            fallbackMode = true;
            return persistDocWithOp(record, type, { ...options, ctx });
        }
        // 一般交易錯誤只回報失敗，不切換權威來源。
        meta.persistenceError = result.error || 'idb_write_failed';
        return { ok: false, error: meta.persistenceError };
    }
    const value = result.value || {};
    if (value.stale) return staleResult();
    if (value.deferred) return { ok: false, error: 'requeue_deferred', deferred: true };
    // 交易內合併後的 revision／代際也要寫回呼叫端的 record，後續 replaceRecord()
    // 才不會用交易前的舊版本蓋掉剛完成的確認。
    record.revision = Number(value.revision) || 0;
    record.generation = Number(value.generation) || 0;
    dataEpoch += 1;
    if (value.doc) {
        cacheDoc(value.doc);
        loadedDocs.set(record.articleId, value.doc);
    }
    meta.persistenceError = '';
    return { ok: true, doc: value.doc, op: value.op };
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

/**
 * 後備桶的 state 寫入（同步收尾、游標、錯誤記錄、衝突）。
 *
 * 這些路徑都是「讀桶 → 改 state → 寫回」；若把讀取失敗或損壞 JSON 當成
 * 空桶，寫回時就會把 docs／outbox 一起清掉 —— 使用者的待同步操作再也救不
 * 回來，而這一輪還可能被回報成同步成功。讀不到就明確失敗、不寫入，讓呼叫
 * 端保留原狀並在下一輪重試。
 */
function fallbackWriteState(scope, payload) {
    const read = fallbackReadStrict(scope);
    if (!read.ok) {
        meta.persistenceError = read.error;
        return { ok: false, error: read.error };
    }
    const bucket = read.bucket;
    bucket.state = payload;
    if (!Array.isArray(bucket.docs)) bucket.docs = [];
    if (!Array.isArray(bucket.outbox)) bucket.outbox = [];
    if (!fallbackWrite(scope, bucket)) {
        meta.persistenceError = 'storage_full';
        return { ok: false, error: 'storage_full' };
    }
    meta.persistenceError = '';
    return { ok: true };
}

async function persistMeta(ctx = captureArticleContext()) {
    if (!isArticleContextActive(ctx)) return staleResult();
    const scope = ctx.scope;
    const payload = { scope, ...serializeMeta() };
    if (fallbackMode) return fallbackWriteState(scope, payload);
    const result = await idbRequest(STORE_STATE, 'readwrite', (store) => { store.put(payload); return null; }, ctx);
    if (result.ok) return { ok: true };
    if (result.error === 'idb_unavailable') {
        fallbackMode = true;
        // 權威來源剛切到後備桶：桶若不可讀就不能用記憶體整包覆寫。
        return fallbackWriteState(scope, payload);
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

/** 後備桶的 outbox 一律當成陣列：形狀損壞時不會讓同步整輪拋錯。 */
function fallbackOutbox(bucket) {
    return Array.isArray(bucket && bucket.outbox) ? bucket.outbox : [];
}

async function readOutbox(scopeOrCtx = captureArticleContext()) {
    const ctx = typeof scopeOrCtx === 'string'
        ? { scope: scopeOrCtx, generation: scopeGeneration }
        : scopeOrCtx;
    const scope = ctx.scope;
    if (fallbackMode) {
        return fallbackOutbox(fallbackRead(scope)).filter((op) => op && op.scope === scope);
    }
    const result = await idbRequest(STORE_OUTBOX, 'readonly', (store) => readAll(store));
    if (result.ok) {
        return (result.value || []).filter((op) => op && op.scope === scope);
    }
    if (result.error === 'idb_unavailable') {
        fallbackMode = true;
        return fallbackOutbox(fallbackRead(scope)).filter((op) => op && op.scope === scope);
    }
    return [];
}

async function writeOutboxOp(op, ctx = captureArticleContext()) {
    if (!isArticleContextActive(ctx)) return staleResult();
    const scope = ctx.scope;
    const payload = { ...op, key: `${scope}\u0000${op.articleId}`, scope };
    if (fallbackMode) {
        const read = fallbackReadStrict(scope);
        if (!read.ok) return { ok: false, error: read.error };
        const bucket = read.bucket;
        bucket.outbox = (bucket.outbox || []).filter((item) => item.articleId !== op.articleId);
        bucket.outbox.push(payload);
        return fallbackWrite(scope, bucket) ? { ok: true } : { ok: false, error: 'storage_full' };
    }
    const result = await idbRequest(STORE_OUTBOX, 'readwrite', (store) => { store.put(payload); return null; }, ctx);
    if (result.ok) return { ok: true };
    if (result.error === 'idb_unavailable') {
        fallbackMode = true;
        const read = fallbackReadStrict(scope);
        if (!read.ok) return { ok: false, error: read.error };
        const bucket = read.bucket;
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
        const read = fallbackReadStrict(scope);
        if (!read.ok) return { ok: false, error: read.error };
        const bucket = read.bucket;
        bucket.outbox = (bucket.outbox || []).filter((item) => item.articleId !== articleId);
        return fallbackWrite(scope, bucket) ? { ok: true } : { ok: false, error: 'storage_full' };
    }
    const result = await idbRequest(STORE_OUTBOX, 'readwrite', (store) => { store.delete(docKey(scope, articleId)); return null; }, ctx);
    if (result.ok) return { ok: true };
    if (result.error === 'idb_unavailable') {
        fallbackMode = true;
        const read = fallbackReadStrict(scope);
        if (!read.ok) return { ok: false, error: read.error };
        const bucket = read.bucket;
        bucket.outbox = (bucket.outbox || []).filter((item) => item.articleId !== articleId);
        return fallbackWrite(scope, bucket) ? { ok: true } : { ok: false, error: 'storage_full' };
    }
    return { ok: false, error: result.error };
}

/**
 * 兩份 import 快照是否代表同一次送出。submittedAt 不參與比較：重試時會
 * 重新產生時間戳，但仍可能是同一個操作的同一份內容。
 */
function importSnapshotMatches(left, right) {
    if (!left || !right) return false;
    if (left.clientMutationId !== right.clientMutationId) return false;
    if (String(left.title || '') !== String(right.title || '')) return false;
    if (String(left.body || '') !== String(right.body || '')) return false;
    if (String(left.sourceType || '') !== String(right.sourceType || '')) return false;
    if (String(left.sourceUrl || '') !== String(right.sourceUrl || '')) return false;
    return JSON.stringify(left.analysis ?? null) === JSON.stringify(right.analysis ?? null);
}

/**
 * 決定能否把快照寫到目前操作上：
 *   * write：還沒有快照，或同一份快照重試（幂等）；
 *   * deferred：已經有另一份尚未核對的快照。新內容不能覆蓋它，這一輪
 *     先不要送出這篇；核對（或確認伺服器沒有）之後才允許替換。
 */
function importSnapshotAction(op, scope, snapshot) {
    if (!op || op.scope !== scope) return 'missing';
    if (op.legacy !== true || (op.type !== 'create' && op.type !== 'update')) return 'missing';
    if (!op.importSnapshot) return 'write';
    return importSnapshotMatches(op.importSnapshot, snapshot) ? 'keep' : 'deferred';
}

/**
 * 在送出 /articles/import 之前，把實際送出的內容與 mutation ID 寫進 outbox 操作。
 * 回應在網路遺失時，下一輪（甚至重新載入後）才有辦法確認「伺服器上的內容
 * 是不是我們送出的那一次」，而不是拿當下的新修改去比對。
 *
 * 只附加在仍在等待上傳的 legacy 操作上；操作已被刪除或已有另一份未核對的
 * 快照時不重建、不覆蓋，並在 `deferred` 回報，呼叫端必須跳過那些項目。
 */
export async function recordImportSubmission(entries, ctx = captureArticleContext()) {
    const list = (Array.isArray(entries) ? entries : [])
        .filter((entry) => entry && entry.articleId && entry.snapshot && entry.snapshot.clientMutationId)
        .map((entry) => ({
            articleId: String(entry.articleId),
            snapshot: { ...entry.snapshot }
        }));
    if (!list.length) return { ok: true, updated: 0, deferred: [] };
    if (!isArticleContextActive(ctx)) return { ...staleResult(), updated: 0, deferred: [] };
    const scope = ctx.scope;
    if (fallbackMode) {
        // 讀不到／損壞時不得把「空 outbox」寫回去（會清掉其他操作）。
        const read = fallbackReadStrict(scope);
        if (!read.ok) return { ok: false, error: read.error, updated: 0, deferred: [] };
        const bucket = read.bucket;
        const outbox = Array.isArray(bucket.outbox) ? bucket.outbox : [];
        let updated = 0;
        const deferred = [];
        for (const entry of list) {
            const index = outbox.findIndex((op) => op && op.articleId === entry.articleId && op.scope === scope);
            if (index < 0) continue;
            const action = importSnapshotAction(outbox[index], scope, entry.snapshot);
            if (action === 'deferred' || action === 'missing') {
                deferred.push(entry.articleId);
                continue;
            }
            if (action === 'write') {
                outbox[index] = { ...outbox[index], importSnapshot: entry.snapshot };
                updated += 1;
            }
        }
        if (!updated) return { ok: true, updated: 0, deferred };
        bucket.outbox = outbox;
        return fallbackWrite(scope, bucket)
            ? { ok: true, updated, deferred }
            : { ok: false, error: 'storage_full', updated: 0, deferred: [] };
    }
    const result = await idbRequest(STORE_OUTBOX, 'readwrite', (store) => {
        return Promise.all(list.map((entry) => requestValue(store.get(docKey(scope, entry.articleId)))))
            .then((ops) => {
                if (!isArticleContextActive(ctx)) {
                    try { store.transaction.abort(); } catch (_) {}
                    return { stale: true, updated: 0, deferred: [] };
                }
                let updated = 0;
                const deferred = [];
                for (let index = 0; index < ops.length; index += 1) {
                    const op = ops[index];
                    const entry = list[index];
                    const action = importSnapshotAction(op, scope, entry.snapshot);
                    if (action === 'deferred' || action === 'missing') {
                        deferred.push(entry.articleId);
                        continue;
                    }
                    if (action !== 'write') continue;
                    store.put({ ...op, importSnapshot: entry.snapshot });
                    updated += 1;
                }
                return { updated, deferred };
            });
    }, ctx);
    if (!isArticleContextActive(ctx)) return { ...staleResult(), updated: 0, deferred: [] };
    if (!result.ok) return { ok: false, error: result.error || 'idb_write_failed', updated: 0, deferred: [] };
    const value = result.value || {};
    if (value.stale) return { ...staleResult(), updated: 0, deferred: [] };
    return { ok: true, updated: Number(value.updated) || 0, deferred: value.deferred || [] };
}

/**
 * 清除「已核對伺服器不存在」的 import 快照。
 * 交易內必須仍是同一份快照（mutation ID，若呼叫端有帶 submittedAt 也比對）
 * 才清除；等待期間若又寫入新的快照，回報 deferred，不得把它一起清掉。
 */
export async function clearImportSnapshots(entries, ctx = captureArticleContext()) {
    const list = (Array.isArray(entries) ? entries : [])
        .filter((entry) => entry && entry.articleId && entry.clientMutationId)
        .map((entry) => ({
            articleId: String(entry.articleId),
            clientMutationId: String(entry.clientMutationId),
            submittedAt: entry.submittedAt || ''
        }));
    if (!list.length) return { ok: true, cleared: 0, deferred: [] };
    if (!isArticleContextActive(ctx)) return { ...staleResult(), cleared: 0, deferred: [] };
    const scope = ctx.scope;
    const matches = (op, entry) => !!op && op.scope === scope && !!op.importSnapshot
        && op.importSnapshot.clientMutationId === entry.clientMutationId
        && (!entry.submittedAt || op.importSnapshot.submittedAt === entry.submittedAt);
    if (fallbackMode) {
        // 同上：讀不到時若繼續，後續寫入會把整桶 outbox 換成空陣列。
        const read = fallbackReadStrict(scope);
        if (!read.ok) return { ok: false, error: read.error, cleared: 0, deferred: [] };
        const bucket = read.bucket;
        const outbox = Array.isArray(bucket.outbox) ? bucket.outbox : [];
        let cleared = 0;
        const deferred = [];
        for (const entry of list) {
            const index = outbox.findIndex((op) => op && op.articleId === entry.articleId && op.scope === scope);
            if (index < 0) continue;
            if (!matches(outbox[index], entry)) {
                if (outbox[index].importSnapshot) deferred.push(entry.articleId);
                continue;
            }
            const next = { ...outbox[index] };
            delete next.importSnapshot;
            outbox[index] = next;
            cleared += 1;
        }
        if (!cleared) return { ok: true, cleared: 0, deferred };
        bucket.outbox = outbox;
        return fallbackWrite(scope, bucket)
            ? { ok: true, cleared, deferred }
            : { ok: false, error: 'storage_full', cleared: 0, deferred: [] };
    }
    const result = await idbRequest(STORE_OUTBOX, 'readwrite', (store) => {
        return Promise.all(list.map((entry) => requestValue(store.get(docKey(scope, entry.articleId)))))
            .then((ops) => {
                if (!isArticleContextActive(ctx)) {
                    try { store.transaction.abort(); } catch (_) {}
                    return { stale: true, cleared: 0, deferred: [] };
                }
                let cleared = 0;
                const deferred = [];
                for (let index = 0; index < ops.length; index += 1) {
                    const op = ops[index];
                    const entry = list[index];
                    if (!op || op.scope !== scope) continue;
                    if (!matches(op, entry)) {
                        if (op.importSnapshot) deferred.push(entry.articleId);
                        continue;
                    }
                    const next = { ...op };
                    delete next.importSnapshot;
                    store.put(next);
                    cleared += 1;
                }
                return { cleared, deferred };
            });
    }, ctx);
    if (!isArticleContextActive(ctx)) return { ...staleResult(), cleared: 0, deferred: [] };
    if (!result.ok) return { ok: false, error: result.error || 'idb_write_failed', cleared: 0, deferred: [] };
    const value = result.value || {};
    if (value.stale) return { ...staleResult(), cleared: 0, deferred: [] };
    return { ok: true, cleared: Number(value.cleared) || 0, deferred: value.deferred || [] };
}

/**
 * 以已讀到的既有操作建立新操作（同步）。persistDocWithOp 在交易內讀取
 * existing 後直接呼叫這個函式，讓讀取與寫入共用同一個交易。
 *
 * 每篇文章最多保留一個待同步操作（後寫覆蓋先寫）。建立尚未上傳時仍是 create，
 * 之後的修改只更新內容，不會變成第二次建立。
 *
 * `importSnapshot` 是「已送給 /articles/import、但還沒看到回執」的內容與操作身分，
 * 必須跟著新的操作一起保留：回應遺失後使用者又改了分析／正文時，下一輪才能
 * 先確認真正送出過的操作，而不是用新操作去比對舊的遠端內容。
 *
 * 操作帶著它被建立時的文件代際（`generation`）；回執必須帶同一代際才能確認它。
 * 重建（404 → create）不只要把版本基準歸零，也會換代際，讓所有舊代際的
 * 回執（包含重建前就已送出、回應尚未回來的那一次）一律失效 —— 不再依賴
 * 「重建當下剛好還在 outbox 的那一個 mutation」。
 */
function createOutboxOp(record, type, options = {}, existing = null) {
    // 伺服器確認 404 後的重建：版本基準歸零、丟掉舊快照（伺服器已沒有這篇，
    // 該快照不可能再被核對為完成）。
    const reset = options.resetRevision === true;
    const generation = Number(record.generation) || 0;
    // 不同代際的既有操作是上一個世代的事：不能借用它的類型、基準版本或快照。
    const sameGeneration = !!existing && (Number(existing.generation) || 0) === generation;
    const inherited = sameGeneration ? existing : null;
    let opType = type;
    if (inherited && inherited.type === 'create') opType = 'create';
    if (type === 'delete' || type === 'restore' || type === 'restore_update') opType = type;
    if (inherited && inherited.type === 'delete' && type === 'update') opType = 'delete';
    // 備份還原覆蓋墓碑的復原意圖必須保留到 restore＋PUT 真正完成為止：
    // 還原後、上傳前的本機編輯只是更新 payload，不能降回普通 update，
    // 否則 PUT 會被遠端墓碑以 deleted_remote 拒絕。
    if (inherited && inherited.type === 'restore_update' && type === 'update') opType = 'restore_update';
    if (reset) opType = 'create';
    const op = {
        opId: nextOpId(),
        articleId: record.articleId,
        type: opType,
        // 等待期間可能已完成舊回執並推進 revision；基準版本只能前進。
        // 例外：重建後遠端會從 revision 1 重新開始，必須歸零。
        expectedRevision: reset ? 0 : Math.max(
            Number(record.revision) || 0,
            Number(inherited && inherited.expectedRevision) || 0
        ),
        // 回執必須帶同一代際，否則不得改動這筆操作或文件的版本基準。
        generation,
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
        legacy: options.legacy === true || (inherited ? inherited.legacy === true : false),
        lastError: options.lastError || ''
    };
    // 舊版用 supersededMutations 記錄被重建取代的操作；新流程改用代際，
    // 不再累積這個欄位（保留讀取只是為了升級前就留在 outbox 的舊操作）。
    // 升級前的清單必須完整繼承：截斷會讓清單前半的舊回執失去屏障。
    if (inherited && Array.isArray(inherited.supersededMutations) && inherited.supersededMutations.length) {
        op.supersededMutations = [...inherited.supersededMutations];
    }
    if (inherited && inherited.importSnapshot && !reset) op.importSnapshot = inherited.importSnapshot;
    if (opType === 'delete' || opType === 'restore') {
        op.payload = null;
    }
    return op;
}

/**
 * 備份還原覆蓋本機墓碑時，必須先向伺服器 restore 取得目前 revision，再用它
 * PUT 新正文（`restore_update`）。只有明確的備份還原（`restoreIntent`）會
 * 升級；一般編輯一篇被其他裝置刪除的文章仍走 update → deleted_remote 衝突，
 * 由使用者自己選擇要保留哪一份。
 */
function restoreUpdateType(type, options, storedDoc) {
    if (type === 'delete' || type === 'restore' || type === 'restore_update') return type;
    if (options && options.restoreIntent === true && storedDoc && storedDoc.deletedAt) {
        return 'restore_update';
    }
    return type;
}

async function buildOutboxOp(record, type, options = {}) {
    const scope = options.scope || (options.ctx && options.ctx.scope) || getArticleScope();
    const existing = (await readOutbox(scope)).find((op) => op.articleId === record.articleId) || null;
    return createOutboxOp(record, type, options, existing);
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

/**
 * `fallbackReadStrict()` 的結果轉成文件讀取結果。
 *
 * 後備桶讀取例外／JSON 損壞時不能回報「沒有文章」：完整匯出
 * （`exportDocumentsResult()` → `loadAllRecordsDetailed()`）若拿到空清單，
 * 備份流程會存下一份殘缺備份、裁剪舊備份並更新簽章。因此這裡必須把嚴格
 * 讀取的錯誤往上傳，桶不存在（null／''）仍是合法空桶。
 */
function fallbackDocsDetailed(scope) {
    const read = fallbackReadStrict(scope);
    if (!read.ok) {
        meta.persistenceError = read.error || 'storage_read_failed';
        return { ok: false, error: meta.persistenceError };
    }
    return { ok: true, docs: read.bucket.docs || [] };
}

async function readDocsDetailed(scope) {
    if (fallbackMode) return fallbackDocsDetailed(scope);
    const result = await idbRequest(STORE_DOCS, 'readonly', (store) => readAll(store));
    if (result.ok) {
        return { ok: true, docs: (result.value || []).filter((doc) => doc && doc.scope === scope) };
    }
    if (result.error === 'idb_unavailable') {
        fallbackMode = true;
        return fallbackDocsDetailed(scope);
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
    // 同一 scope 重新整理（例如初始化後同步、refreshScope）不得清掉目前
    // 已按需載入的正文；只有切換 scope 才還原其他 scope 的快取，且絕不
    // 預先載入冷文章。冷啟動仍只讀摘要。
    const sameScope = !!previousScope && previousScope === next;
    const restoreCachedDocs = !!previousScope && previousScope !== next;
    if (currentScope && currentScope !== next) scopeGeneration += 1;
    else if (!currentScope) scopeGeneration += 1;
    const generation = scopeGeneration;
    currentScope = next;
    if (!sameScope) {
        loadedDocs.clear();
        loadingDocs.clear();
        residentArticleIds.clear();
    }
    let records = [];
    const restoredDocs = new Map();
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
        // 先重建本次要保留的全文，最後才整體替換 loadedDocs；讀取期間若
        // 有 in-flight 載入完成，它已寫入 loadedDocs 並更新畫面，不會被舊摘要蓋回。
        restoredDocs.clear();
        records = summaries
            .map((summary) => {
                const record = toSummaryRecord(summary);
                if (!record) return null;
                const keepBody = residentArticleIds.has(record.articleId)
                    // 使用者剛儲存、畫面仍停留的文章即使尚未經過 ensure，也不得在重整時失去正文。
                    || state.currentArticleId === record.articleId;
                const candidate = sameScope
                    ? (keepBody ? loadedDocs.get(record.articleId) : null)
                    : (restoreCachedDocs ? cachedDoc(next, summary) : null);
                if (!candidate || !docMatchesSummary(candidate, summary)) return record;
                restoredDocs.set(record.articleId, candidate);
                return { ...record, article: candidate.body, result: candidate.analysis, summaryOnly: false };
            })
            .filter(Boolean)
            .sort((a, b) => String(b.lastOpenedAt || b.updatedAt || '').localeCompare(String(a.lastOpenedAt || a.updatedAt || '')));
        break;
    }
    loadedDocs.clear();
    residentArticleIds.clear();
    for (const [articleId, doc] of restoredDocs) {
        loadedDocs.set(articleId, doc);
        residentArticleIds.add(articleId);
        // 同一 scope 的持久化路徑不一定會補 docCache；這裡補上，切換帳戶
        // 再切回時仍可還原同一篇已讀文章，但不會因此載入其他冷文章。
        cacheDoc(doc);
    }
    state.setAnalyzedArticles(records);
    emitChange();
    return records;
}

/**
 * 按需載入單篇文章全文與分析（明確結果版）。文章清單只保留摘要，這是
 * 正常補全文入口。
 *
 * 必須分辨「真的沒有這篇」（`{ ok:true, doc:null }`）與「讀取失敗」
 * （`{ ok:false, error }`）：同步推送若把讀取失敗當成文章不存在，就會用
 * skip 回執清掉 outbox，實際內容卻從未上傳。
 */
export async function ensureArticleLoadedDetailed(articleId, ctx = captureArticleContext()) {
    if (!articleId) return { ok: true, doc: null };
    if (!isArticleContextActive(ctx)) return staleResult();
    const summary = findRecord(articleId);
    if (!summary) return { ok: true, doc: null };
    if (loadedDocs.has(articleId)) {
        // 已被開啟流程要求過全文：標記為常駐，後續同 scope 重整不得降回摘要。
        residentArticleIds.add(articleId);
        return { ok: true, doc: findRecord(articleId) };
    }
    const key = `${ctx.scope}\u0000${articleId}\u0000${ctx.generation}`;
    if (loadingDocs.has(key)) return loadingDocs.get(key);
    const loadFromFallback = () => {
        // localStorage 備援：這裡沒有 idbRequest，但載入語意（常駐、更新記憶體）
        // 必須與 IndexedDB 路徑一致，否則後備模式下刪除／編輯會找不到全文。
        // 讀取必須嚴格：`fallbackRead()` 會把例外／損壞當成空桶，與「沒有這篇」
        // 無法區分，會讓失敗的推送被誤認為已完成。
        const read = fallbackReadStrict(ctx.scope);
        if (!read.ok) {
            meta.persistenceError = read.error;
            return { ok: false, error: read.error };
        }
        const doc = (read.bucket.docs || []).find((item) => item && item.id === articleId) || null;
        if (!isArticleContextActive(ctx)) return staleResult();
        if (!doc || doc.scope !== ctx.scope || doc.id !== articleId) return { ok: true, doc: null };
        cacheDoc(doc);
        loadedDocs.set(articleId, doc);
        residentArticleIds.add(articleId);
        replaceRecord(toRecord(doc));
        return { ok: true, doc: findRecord(articleId) };
    };
    const task = (async () => {
        if (fallbackMode) return loadFromFallback();
        // requestValue 會把 request 失敗往上拋，讓 idbRequest 回報 ok:false；
        // readOne 會把 onerror 吞成 null，正是「讀取失敗＝不存在」的來源。
        const result = await idbRequest(
            STORE_DOCS,
            'readonly',
            (store) => requestValue(store.get(docKey(ctx.scope, articleId))),
            ctx
        );
        if (!isArticleContextActive(ctx)) return staleResult();
        if (!result.ok) {
            if (result.error === 'idb_unavailable') {
                fallbackMode = true;
                return loadFromFallback();
            }
            meta.persistenceError = result.error || 'idb_read_failed';
            return { ok: false, error: meta.persistenceError };
        }
        const doc = result.value || null;
        if (!doc || doc.scope !== ctx.scope || doc.id !== articleId) return { ok: true, doc: null };
        cacheDoc(doc);
        loadedDocs.set(articleId, doc);
        residentArticleIds.add(articleId);
        replaceRecord(toRecord(doc));
        return { ok: true, doc: findRecord(articleId) };
    })();
    loadingDocs.set(key, task);
    try {
        return await task;
    } finally {
        loadingDocs.delete(key);
    }
}

/**
 * 相容包裝：既有呼叫端只需要全文或 null。同步推送等必須分辨讀取失敗的
 * 流程請改用 `ensureArticleLoadedDetailed()`，不得再從 null 推論「不存在」。
 */
export async function ensureArticleLoaded(articleId, ctx = captureArticleContext()) {
    const result = await ensureArticleLoadedDetailed(articleId, ctx);
    return result && result.ok === true ? (result.doc || null) : null;
}

async function loadAllRecordsDetailed(ctx = captureArticleContext(), options = {}) {
    if (!isArticleContextActive(ctx)) return staleResult();
    const read = await readDocsDetailed(ctx.scope);
    if (!isArticleContextActive(ctx)) return staleResult();
    if (!read.ok) return { ok: false, error: read.error || 'idb_read_failed' };
    const records = read.docs
        .map(toRecord)
        .filter(Boolean)
        .sort((a, b) => String(b.lastOpenedAt || b.updatedAt || '').localeCompare(String(a.lastOpenedAt || a.updatedAt || '')));
    // 備份在同步鎖外執行：只讀取，不以較早的讀取結果覆寫同步剛更新的記憶體。
    if (options.hydrate !== false) {
        loadedDocs.clear();
        for (const doc of read.docs) loadedDocs.set(doc.id, doc);
        state.setAnalyzedArticles(records);
        emitChange();
    }
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
        // 記憶體代際必須一併帶上，交易內才分得出「同代際的正常保存」與
        // 「另一分頁重建後的舊代際」。
        generation: Number(existing?.generation) || 0,
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
    if (!persisted.ok) {
        // checkpoint／分析保存失敗：不得把未落盤的結果放進記憶體。
        // 否則切走再打開會顯示「已保存」的進度，但磁碟上其實沒有（F4）。
        // 呼叫端仍可從回傳的 record 取得這次嘗試的內容用於除錯／重試。
        return { ok: false, error: persisted.error, record: next };
    }
    replaceRecord(next);
    // P3-T1：逐段 checkpoint 只需更新記憶體與持久層，不必每次重繪歷史列。
    if (!options.silent) emitChange();
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
 * 尚未上傳的 create 被刪除時可直接撤掉待同步操作（不需要送 DELETE）。
 * 但必須用「目前持久化文件 + 目前 outbox + ledger」判斷：另一個分頁可能
 * 已經重建過（代際前進），舊分頁記憶體的 tombstone 不能把代際寫回去。
 * 回傳 null 代表不適用捷徑，呼叫端改走一般刪除流程。
 */
function pendingCreateTombstone(storedDoc, pending, ledgerGeneration, at) {
    if (!storedDoc) return null;
    if (!pending || pending.type !== 'create' || pending.legacy === true) return null;
    if ((Number(storedDoc.revision) || 0) !== 0) return null;
    const generation = Math.max(storedGenerationOf(storedDoc), Number(ledgerGeneration) || 0);
    // 操作必須屬於目前代際，才代表「這一版建立還沒送出」。
    if ((Number(pending.generation) || 0) !== generation) return null;
    return {
        ...contentFromStoredDoc(storedDoc, {}),
        articleId: storedDoc.id,
        revision: 0,
        generation,
        deletedAt: at,
        updatedAt: at,
        dirty: true,
        pending: true,
        conflict: null
    };
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
        // legacy create 正在（或已經）由 /articles/import 上傳，不能只因本機
        // revision 還是 0 就撤掉 outbox：伺服器可能已經有這篇，刪除必須留下
        // 待同步操作，核對回執才能把它推進到正確的基準 revision。
        const scope = ctx.scope;
        const at = nowIso();
        const applyFallback = () => {
            // 讀改寫：讀不到時不得直接寫回（會把其他文件與 outbox 清掉）。
            const read = fallbackReadStrict(scope);
            if (!read.ok) return { ok: false, error: read.error };
            const bucket = read.bucket;
            const storedDoc = (bucket.docs || []).find((item) => item && item.id === articleId) || null;
            const pending = (bucket.outbox || []).find((op) => op && op.articleId === articleId) || null;
            const revoked = pendingCreateTombstone(storedDoc, pending, fallbackGeneration(bucket, articleId), at);
            if (!revoked) return null;
            const doc = toDoc(revoked, scope);
            bucket.docs = (bucket.docs || []).filter((item) => item.id !== articleId);
            bucket.docs.push(doc);
            rememberFallbackGeneration(bucket, articleId, doc.generation);
            bucket.outbox = (bucket.outbox || []).filter((item) => item.articleId !== articleId);
            bucket.state = { ...(bucket.state || {}), ...serializeMeta() };
            if (!fallbackWrite(scope, bucket)) return { ok: false, error: 'storage_full' };
            dataEpoch += 1;
            cacheDoc(doc);
            loadedDocs.set(articleId, doc);
            const replaced = replaceRecord(toRecord(doc));
            emitChange();
            return { ok: true, record: replaced || toRecord(doc), fallback: true };
        };
        if (fallbackMode) {
            const revoked = applyFallback();
            if (revoked) return revoked;
        } else {
            const result = await idbRequest(
                [STORE_DOCS, STORE_ARTICLE_SUMMARIES, STORE_OUTBOX, STORE_ARTICLE_GENERATIONS],
                'readwrite',
                (stores) => {
                    return Promise.all([
                        requestValue(stores[STORE_DOCS].get(docKey(scope, articleId))),
                        requestValue(stores[STORE_OUTBOX].get(docKey(scope, articleId))),
                        requestValue(stores[STORE_ARTICLE_GENERATIONS].get(docKey(scope, articleId)))
                    ]).then(([storedDoc, pending, ledgerRow]) => {
                        if (!isArticleContextActive(ctx)) {
                            try { stores[STORE_DOCS].transaction.abort(); } catch (_) {}
                            return { stale: true };
                        }
                        const revoked = pendingCreateTombstone(
                            storedDoc,
                            pending,
                            ledgerRowGeneration(ledgerRow),
                            at
                        );
                        if (!revoked) return { revoked: false };
                        const doc = toDoc(revoked, scope);
                        // 這個分支同樣要維護摘要，否則列表重新整理後仍會看到已刪文章。
                        stores[STORE_DOCS].put(doc);
                        stores[STORE_ARTICLE_SUMMARIES].put(summarizeArticleDoc(doc));
                        stores[STORE_OUTBOX].delete(docKey(scope, articleId));
                        if (ledgerRowGeneration(ledgerRow) < storedGenerationOf(doc)) {
                            stores[STORE_ARTICLE_GENERATIONS].put(generationRow(scope, articleId, doc.generation));
                        }
                        return { revoked: true, doc };
                    });
                },
                ctx
            );
            if (!isArticleContextActive(ctx)) return { ...staleResult(), record: tombstone };
            if (result.ok) {
                const value = result.value || {};
                if (value.stale) return { ...staleResult(), record: tombstone };
                if (value.revoked) {
                    dataEpoch += 1;
                    cacheDoc(value.doc);
                    loadedDocs.set(articleId, value.doc);
                    const replaced = replaceRecord(toRecord(value.doc));
                    emitChange();
                    return { ok: true, record: replaced || tombstone };
                }
            } else if (result.error === 'idb_unavailable') {
                fallbackMode = true;
                const revoked = applyFallback();
                if (revoked) return revoked;
            } else {
                return { ok: false, error: result.error };
            }
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
        const read = fallbackReadStrict(scope);
        if (!read.ok) return { ok: false, error: read.error };
        const bucket = read.bucket;
        bucket.draft = payload;
        return fallbackWrite(scope, bucket) ? { ok: true, draft: payload } : { ok: false, error: 'storage_full' };
    }
    const result = await idbRequest(STORE_DRAFTS, 'readwrite', (store) => { store.put(payload); return null; }, ctx);
    if (result.ok) return { ok: true, draft: payload };
    if (result.error === 'idb_unavailable') {
        fallbackMode = true;
        const read = fallbackReadStrict(scope);
        if (!read.ok) return { ok: false, error: read.error };
        const bucket = read.bucket;
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
        const read = fallbackReadStrict(scope);
        if (!read.ok) return { ok: false, error: read.error };
        const bucket = read.bucket;
        delete bucket.draft;
        return fallbackWrite(scope, bucket) ? { ok: true } : { ok: false, error: 'storage_full' };
    }
    const result = await idbRequest(STORE_DRAFTS, 'readwrite', (store) => { store.delete(scope); return null; }, ctx);
    if (result.ok) return { ok: true };
    if (result.error === 'idb_unavailable') {
        fallbackMode = true;
        const read = fallbackReadStrict(scope);
        if (!read.ok) return { ok: false, error: read.error };
        const bucket = read.bucket;
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
 * 目前持久化的操作是否就是呼叫端正在處理的那一筆。
 *
 * restore 成功後要推進版本基準，但等待期間使用者又改了正文或另一個分頁
 * 重建了這篇時，舊操作的基準不能拿去改新的操作（更不能改重建後的版本），
 * 因此必須同時核對 mutation ID 與代際。
 */
function operationBaseMatches(pending, mutationId, generation) {
    if (!pending || !mutationId) return false;
    if (pending.clientMutationId !== mutationId) return false;
    return (Number(pending.generation) || 0) === generation;
}

/**
 * 推進「目前這筆待同步操作」已確認的版本基準。
 *
 * 用在 restore 已成功、但後續 PUT 失敗的情況：restore 已把遠端推到新
 * revision，若不把這個事實落地，重試 PUT 或使用者刪除都會拿著過期 revision
 * 送出，被遠端以 409 拒絕，變成使用者要處理的假衝突。
 *
 * 這裡只推進版本基準：outbox 保留、`dirty`／`pending` 不變、衝突不動，
 * 不能視為操作完成。文件、摘要、outbox（與代際 ledger 的核對）都在同一個
 * 交易內完成；後備桶則在同一個同步區塊內讀改寫。
 *
 * 回傳 `applied:false` 代表目前的操作已被取代／代際不符，原狀完全不動。
 *
 * 例外（`applied:false, rebased:true`）：同一代際、持久化文件代際也相符，
 * 但 pending 已換成另一筆新操作（例如使用者在 restore 回應回來前刪除）。
 * 這種情況仍要把已確認的 revision 交接給目前持久化文件與新操作的
 * `expectedRevision`（只向前），否則下一輪會拿舊 revision 送出而被 409
 * 誤判成使用者衝突。只改版本基準，不覆寫新操作的正文／mutation／pending
 * 狀態；pending 已不存在或代際不符時維持完全不動。
 */
export async function advanceOperationBase(articleId, revision, options = {}) {
    const ctx = options.ctx || captureArticleContext();
    if (!isArticleContextActive(ctx)) return staleResult();
    const id = String(articleId || '');
    if (!id) return { ok: false, error: 'record_missing' };
    const nextRevision = Number(revision) || 0;
    if (nextRevision <= 0) return { ok: false, error: 'revision_invalid' };
    const mutationId = String(options.clientMutationId || '');
    const generation = Number(options.generation) || 0;
    const scope = ctx.scope;
    if (fallbackMode) {
        const read = fallbackReadStrict(scope);
        if (!read.ok) return { ok: false, error: read.error };
        const bucket = read.bucket;
        const docs = Array.isArray(bucket.docs) ? bucket.docs.slice() : [];
        const outbox = Array.isArray(bucket.outbox) ? bucket.outbox.slice() : [];
        const opIndex = outbox.findIndex((op) => op && op.articleId === id);
        const pending = opIndex >= 0 ? outbox[opIndex] : null;
        const docIndex = docs.findIndex((item) => item && item.id === id);
        const storedDoc = docIndex >= 0 ? docs[docIndex] : null;
        const storedGeneration = Math.max(
            storedGenerationOf(storedDoc),
            fallbackGeneration(bucket, id)
        );
        const sameGeneration = !storedDoc || storedGeneration === generation;
        if (!operationBaseMatches(pending, mutationId, generation)) {
            // 同代際的新操作已接手（clientMutationId 不同）：把已確認的
            // revision 交接給它，只向前推進、不改內容。
            if (!pending || !sameGeneration || (Number(pending.generation) || 0) !== generation) {
                return { ok: true, applied: false };
            }
            let rebasedDoc = storedDoc;
            let changed = false;
            if (storedDoc && nextRevision > (Number(storedDoc.revision) || 0)) {
                rebasedDoc = { ...storedDoc, revision: nextRevision };
                docs[docIndex] = rebasedDoc;
                changed = true;
            }
            if (nextRevision > (Number(pending.expectedRevision) || 0)) {
                outbox[opIndex] = { ...pending, expectedRevision: nextRevision };
                changed = true;
            }
            if (!changed) return { ok: true, applied: false, rebased: true };
            bucket.docs = docs;
            bucket.outbox = outbox;
            if (!fallbackWrite(scope, bucket)) return { ok: false, error: 'storage_full' };
            dataEpoch += 1;
            if (rebasedDoc) {
                cacheDoc(rebasedDoc);
                loadedDocs.set(id, rebasedDoc);
                replaceRecord(toRecord(rebasedDoc));
            }
            emitChange();
            return { ok: true, applied: false, rebased: true, revision: nextRevision, doc: rebasedDoc };
        }
        if (storedDoc && !sameGeneration) {
            return { ok: true, applied: false };
        }
        let nextDoc = storedDoc;
        if (storedDoc && nextRevision > (Number(storedDoc.revision) || 0)) {
            nextDoc = { ...storedDoc, revision: nextRevision };
            docs[docIndex] = nextDoc;
        }
        if (nextRevision > (Number(pending && pending.expectedRevision) || 0)) {
            outbox[opIndex] = { ...pending, expectedRevision: nextRevision };
        }
        bucket.docs = docs;
        bucket.outbox = outbox;
        if (!fallbackWrite(scope, bucket)) return { ok: false, error: 'storage_full' };
        dataEpoch += 1;
        if (nextDoc) {
            cacheDoc(nextDoc);
            loadedDocs.set(id, nextDoc);
            replaceRecord(toRecord(nextDoc));
        }
        emitChange();
        return { ok: true, applied: true, revision: nextRevision, doc: nextDoc };
    }
    const result = await idbRequest(
        [STORE_DOCS, STORE_ARTICLE_SUMMARIES, STORE_OUTBOX, STORE_ARTICLE_GENERATIONS],
        'readwrite',
        (stores) => {
            return Promise.all([
                requestValue(stores[STORE_DOCS].get(docKey(scope, id))),
                requestValue(stores[STORE_OUTBOX].get(docKey(scope, id))),
                requestValue(stores[STORE_ARTICLE_GENERATIONS].get(docKey(scope, id)))
            ]).then(([storedDoc, pending, ledgerRow]) => {
                if (!isArticleContextActive(ctx)) {
                    try { stores[STORE_DOCS].transaction.abort(); } catch (_) {}
                    return { stale: true, applied: false };
                }
                // 只改「呼叫端正在處理的那一筆」：被新的本機修改取代、或已換代際
                // （重建／遠端墓碑）時完全不動。
                const storedGeneration = storedDoc
                    ? effectiveStoredGeneration(storedDoc, ledgerRow)
                    : 0;
                const sameGeneration = !storedDoc || storedGeneration === generation;
                if (!operationBaseMatches(pending, mutationId, generation)) {
                    // 同代際的新操作已接手：交接已確認的 revision（與後備桶一致）。
                    if (!pending || !sameGeneration || (Number(pending.generation) || 0) !== generation) {
                        return { applied: false };
                    }
                    let rebasedDoc = storedDoc || null;
                    let changed = false;
                    if (rebasedDoc && nextRevision > (Number(rebasedDoc.revision) || 0)) {
                        rebasedDoc = { ...rebasedDoc, revision: nextRevision };
                        stores[STORE_DOCS].put(rebasedDoc);
                        const summary = summarizeArticleDoc(rebasedDoc);
                        if (summary) stores[STORE_ARTICLE_SUMMARIES].put(summary);
                        changed = true;
                    }
                    if (nextRevision > (Number(pending.expectedRevision) || 0)) {
                        stores[STORE_OUTBOX].put({ ...pending, expectedRevision: nextRevision });
                        changed = true;
                    }
                    return { applied: false, rebased: true, changed, doc: rebasedDoc, revision: nextRevision };
                }
                if (storedDoc && !sameGeneration) {
                    return { applied: false };
                }
                let nextDoc = storedDoc || null;
                if (nextDoc && nextRevision > (Number(nextDoc.revision) || 0)) {
                    nextDoc = { ...nextDoc, revision: nextRevision };
                    stores[STORE_DOCS].put(nextDoc);
                    const summary = summarizeArticleDoc(nextDoc);
                    if (summary) stores[STORE_ARTICLE_SUMMARIES].put(summary);
                }
                if (nextRevision > (Number(pending.expectedRevision) || 0)) {
                    stores[STORE_OUTBOX].put({ ...pending, expectedRevision: nextRevision });
                }
                return { applied: true, doc: nextDoc, revision: nextRevision };
            });
        },
        ctx
    );
    if (!isArticleContextActive(ctx)) return staleResult();
    if (!result.ok) {
        if (result.error === 'idb_unavailable') {
            fallbackMode = true;
            return advanceOperationBase(id, nextRevision, { ...options, ctx });
        }
        meta.persistenceError = result.error || 'idb_write_failed';
        return { ok: false, error: meta.persistenceError };
    }
    const value = result.value || {};
    if (value.stale) return staleResult();
    if (value.rebased) {
        if (value.changed) {
            dataEpoch += 1;
            if (value.doc) {
                cacheDoc(value.doc);
                loadedDocs.set(id, value.doc);
                replaceRecord(toRecord(value.doc));
            }
            emitChange();
        }
        return {
            ok: true,
            applied: false,
            rebased: true,
            revision: Number(value.revision) || nextRevision,
            doc: value.doc || null
        };
    }
    if (!value.applied) return { ok: true, applied: false };
    dataEpoch += 1;
    if (value.doc) {
        cacheDoc(value.doc);
        loadedDocs.set(id, value.doc);
        replaceRecord(toRecord(value.doc));
    }
    emitChange();
    return { ok: true, applied: true, revision: Number(value.revision) || nextRevision, doc: value.doc || null };
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
        // 新 ID 是新的文章，不繼承原篇的重建代際。
        generation: 0,
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

function recordFromRemoteDoc(doc) {
    return {
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
}

/** 把批次結果合併回記憶體清單：只重建一次陣列與索引（O(N)）。 */
function mergeRecordsIntoMemory(records) {
    const byId = new Map();
    for (const record of records) {
        if (record && record.articleId) byId.set(record.articleId, record);
    }
    if (!byId.size) return;
    const current = state.analyzedArticles || [];
    const next = [];
    const seen = new Set();
    for (const item of current) {
        if (!item || !item.articleId) continue;
        const replacement = byId.get(item.articleId);
        if (replacement) {
            next.push({ ...item, ...replacement });
            seen.add(item.articleId);
        } else {
            next.push(item);
        }
    }
    const index = new Map();
    for (const item of next) {
        if (item && item.articleId) index.set(item.articleId, item);
    }
    for (const [id, record] of byId) {
        if (seen.has(id)) continue;
        next.push(record);
        index.set(id, record);
    }
    state.setAnalyzedArticles(next);
    setRecordIndex(next, index);
}

/**
 * 批次套用遠端文件：一批文章在同一個 IndexedDB 交易內讀寫，記憶體清單只重建一次。
 * 逐篇開交易會讓首次下載 1,000 篇變成 1,000 次交易，而且每次都要掃描整個清單。
 */
export async function applyRemoteDocs(docs, ctx = captureArticleContext()) {
    const list = (Array.isArray(docs) ? docs : []).filter((doc) => doc && doc.id);
    if (!list.length) return { ok: true, results: [] };
    if (!isArticleContextActive(ctx)) return { ...staleResult(), results: [] };
    const scope = ctx.scope;
    // 在交易內重新讀取本機文件、outbox 與代際 ledger，才不會用「網路請求
    // 開始前」的 pending 判斷覆蓋掉請求期間的新編輯。
    const result = await idbRequest([STORE_DOCS, STORE_ARTICLE_SUMMARIES, STORE_OUTBOX, STORE_ARTICLE_GENERATIONS], 'readwrite', (stores) => {
        return Promise.all(list.map((doc) => Promise.all([
            requestValue(stores[STORE_DOCS].get(docKey(scope, doc.id))),
            requestValue(stores[STORE_OUTBOX].get(docKey(scope, doc.id))),
            requestValue(stores[STORE_ARTICLE_GENERATIONS].get(docKey(scope, doc.id)))
        ]))).then((pairs) => {
            if (!isArticleContextActive(ctx)) {
                try { stores[STORE_DOCS].transaction.abort(); } catch (_) {}
                return { stale: true, results: [], applied: [] };
            }
            const applied = [];
            const results = list.map((doc, index) => {
                const [localDoc, pendingOp, ledgerRow] = pairs[index];
                if ((localDoc && (localDoc.dirty || localDoc.pending)) || pendingOp) {
                    return { id: doc.id, applied: false, skippedLocalPending: true };
                }
                const record = recordFromRemoteDoc(doc);
                // 代際是本機欄位：套用遠端文件不得把它歸零，否則重建前送出的
                // 舊回執會重新變成「目前代際」而改動版本。文件已被完整 pull
                // 移除時，屏障仍在 ledger，同 ID 重新下載也要沿用較高的代際。
                record.generation = Math.max(
                    Number(localDoc && localDoc.generation) || 0,
                    ledgerRowGeneration(ledgerRow)
                );
                const remoteDoc = toDoc(record, scope);
                stores[STORE_DOCS].put(remoteDoc);
                const summary = summarizeArticleDoc(remoteDoc);
                if (summary) stores[STORE_ARTICLE_SUMMARIES].put(summary);
                if (ledgerRowGeneration(ledgerRow) < storedGenerationOf(remoteDoc)) {
                    stores[STORE_ARTICLE_GENERATIONS].put(generationRow(scope, doc.id, remoteDoc.generation));
                }
                applied.push({ articleId: doc.id, record, doc: remoteDoc });
                return { id: doc.id, applied: true, record };
            });
            return { results, applied };
        });
    }, ctx);
    if (!isArticleContextActive(ctx)) return { ...staleResult(), results: [] };
    if (!result.ok) {
        if (result.error === 'idb_unavailable') return { ok: false, error: 'idb_unavailable', results: [] };
        meta.persistenceError = result.error || 'idb_write_failed';
        return { ok: false, error: meta.persistenceError, results: [] };
    }
    const value = result.value || {};
    if (value.stale) return { ...staleResult(), results: [] };
    const applied = Array.isArray(value.applied) ? value.applied : [];
    if (applied.length) {
        dataEpoch += 1;
        for (const item of applied) {
            cacheDoc(item.doc);
            loadedDocs.set(item.articleId, item.doc);
        }
        mergeRecordsIntoMemory(applied.map((item) => item.record));
        emitChange();
    }
    return { ok: true, results: value.results || [] };
}

export async function applyRemoteDoc(doc, ctx = captureArticleContext()) {
    if (!doc || !doc.id) return { ok: false, error: 'invalid_document' };
    const batch = await applyRemoteDocs([doc], ctx);
    if (!batch.ok) return batch;
    const result = batch.results[0] || { id: doc.id, applied: false };
    if (result.skippedLocalPending) {
        return { ok: true, applied: false, skippedLocalPending: true, record: findRecord(doc.id) };
    }
    return { ok: true, applied: !!result.applied, record: result.record || null };
}

/**
 * 遠端墓碑套用後的記憶體同步（IndexedDB 與後備路徑共用）。
 * 文件的代際也一併更新：後續保存／刪除／復原都以這份代際為起點。
 */
function finishRemoteTombstones(outcome, ctx) {
    if (!outcome || outcome.ok !== true) {
        return { ok: false, error: (outcome && outcome.error) || 'storage_full', results: [] };
    }
    const applied = Array.isArray(outcome.applied) ? outcome.applied : [];
    if (applied.length && isArticleContextActive(ctx)) {
        dataEpoch += 1;
        const byId = new Map();
        for (const item of applied) {
            cacheDoc(item.tombstone);
            loadedDocs.delete(item.articleId);
            residentArticleIds.delete(item.articleId);
            byId.set(item.articleId, {
                deletedAt: item.tombstone.deletedAt,
                generation: Number(item.tombstone.generation) || 0,
                revision: Number(item.tombstone.revision) || 0,
                dirty: false,
                pending: false
            });
        }
        mergeRecordsIntoMemory(Array.from(byId, ([articleId, patch]) => ({ articleId, ...patch }))
            .filter((record) => !!findRecord(record.articleId)));
        emitChange();
    }
    return { ok: true, results: outcome.results || [] };
}

/** 批次遠端墓碑：同一個交易完成所有讀寫，避免逐篇交易。 */
export async function applyRemoteTombstones(articleIds, ctx = captureArticleContext()) {
    const ids = Array.from(new Set((Array.isArray(articleIds) ? articleIds : []).filter(Boolean)));
    if (!ids.length) return { ok: true, results: [] };
    if (!isArticleContextActive(ctx)) return { ...staleResult(), results: [] };
    const scope = ctx.scope;
    if (fallbackMode) return finishRemoteTombstones(fallbackApplyTombstones(scope, ids), ctx);
    const result = await idbRequest([STORE_DOCS, STORE_ARTICLE_SUMMARIES, STORE_OUTBOX, STORE_ARTICLE_GENERATIONS], 'readwrite', (stores) => {
        return Promise.all(ids.map((articleId) => Promise.all([
            requestValue(stores[STORE_DOCS].get(docKey(scope, articleId))),
            requestValue(stores[STORE_OUTBOX].get(docKey(scope, articleId))),
            requestValue(stores[STORE_ARTICLE_GENERATIONS].get(docKey(scope, articleId)))
        ]))).then((pairs) => {
            if (!isArticleContextActive(ctx)) {
                try { stores[STORE_DOCS].transaction.abort(); } catch (_) {}
                return { stale: true, results: [], applied: [] };
            }
            const applied = [];
            const results = ids.map((articleId, index) => {
                const [localDoc, pendingOp, ledgerRow] = pairs[index];
                if (!localDoc) return { id: articleId, applied: false, missing: true };
                // 本機仍有未同步內容（含使用者主動刪除的 delete outbox）時不改動任何東西：
                // 使用者主動刪除的代際必須與它的操作保持一致，不能被遠端墓碑退休。
                if (localDoc.dirty || localDoc.pending || pendingOp) {
                    return { id: articleId, applied: false, skippedLocalPending: true };
                }
                // 同一個遠端墓碑重複送達（本地已是 tombstone）：不再推進代際。
                if (localDoc.deletedAt) {
                    if (ledgerRowGeneration(ledgerRow) < storedGenerationOf(localDoc)) {
                        stores[STORE_ARTICLE_GENERATIONS].put(
                            generationRow(scope, articleId, storedGenerationOf(localDoc))
                        );
                    }
                    return { id: articleId, applied: false, alreadyDeleted: true };
                }
                // 遠端墓碑＝這一條生命週期結束：代際前進一代（仍為交易內最高值 + 1），
                // 之後同 ID 還原採用更高代際，墓碑前送出、延遲回來的回執全部失效。
                const generation = effectiveStoredGeneration(localDoc, ledgerRow) + 1;
                const tombstone = { ...localDoc, deletedAt: nowIso(), dirty: false, pending: false, generation };
                stores[STORE_DOCS].put(tombstone);
                const summary = summarizeArticleDoc(tombstone);
                if (summary) stores[STORE_ARTICLE_SUMMARIES].put(summary);
                stores[STORE_OUTBOX].delete(docKey(scope, articleId));
                stores[STORE_ARTICLE_GENERATIONS].put(generationRow(scope, articleId, generation));
                applied.push({ articleId, tombstone });
                return { id: articleId, applied: true, deletedAt: tombstone.deletedAt, generation };
            });
            return { results, applied };
        });
    }, ctx);
    if (!isArticleContextActive(ctx)) return { ...staleResult(), results: [] };
    if (!result.ok) {
        if (result.error === 'idb_unavailable') {
            fallbackMode = true;
            return finishRemoteTombstones(fallbackApplyTombstones(scope, ids), ctx);
        }
        return { ok: false, error: result.error || 'idb_write_failed', results: [] };
    }
    const value = result.value || {};
    if (value.stale) return { ...staleResult(), results: [] };
    return finishRemoteTombstones({ ok: true, results: value.results, applied: value.applied }, ctx);
}

export async function applyRemoteTombstone(articleId, ctx = captureArticleContext()) {
    if (!isArticleContextActive(ctx)) return staleResult();
    const batch = await applyRemoteTombstones([articleId], ctx);
    if (!batch.ok) return { ok: false, error: batch.error || 'idb_write_failed' };
    const result = batch.results[0] || { id: articleId, applied: false };
    if (result.skippedLocalPending) {
        return { ok: true, applied: false, skippedLocalPending: true, record: findRecord(articleId) };
    }
    return { ok: true, applied: !!result.applied };
}

/**
 * 伺服器要求完整重同步時，移除本機已不存在的遠端文章（保留本機未上傳者）。
 *
 * 回傳 `{ ok, removed, error }`。`onlyIfClean` 的 `local_pending` 是「刻意
 * 跳過」，不算失敗；但儲存讀取／寫入失敗（storage_read_failed／
 * storage_corrupt／storage_full）必須停止並往上回報，不能靜默 continue：
 * 那一輪的完整清單其實沒有真的套用，同步層不得回報成功。
 */
export async function reconcileFullList(serverIds, ctx = captureArticleContext()) {
    if (!isArticleContextActive(ctx)) return { ...staleResult(), removed: [] };
    const ids = new Set(serverIds);
    const removed = [];
    let refreshed = false;
    for (const record of (state.analyzedArticles || []).slice()) {
        if (!record || !record.articleId) continue;
        if (ids.has(record.articleId)) continue;
        if (record.dirty || record.pending) continue;
        if (!isArticleContextActive(ctx)) return { ...staleResult(), removed };
        // 記憶體可能是 pull 開始前的舊版本：另一個分頁在等待期間保存的新正文
        // 只反映在持久化文件與 outbox。移除判斷必須在交易內重新核對，不能
        // 只看這份 clean 的記憶體，否則會刪掉還沒上傳的內容。
        // 遠端已沒有這篇時代際一併前進：舊生命週期的回執不得在之後的同 ID
        // 還原（備份／復原）上生效。
        const deleted = await deleteDoc(record.articleId, ctx, {
            generation: record.generation,
            onlyIfClean: true,
            retireGeneration: true
        });
        if (!isArticleContextActive(ctx)) return { ...staleResult(), removed };
        if (!deleted.ok) {
            // 本機仍有未同步修改：保留文件與 outbox，並把最新的持久化內容補回
            // 記憶體，下一輪推送才會送出那一份正文。
            if (deleted.skipped && deleted.doc) {
                mergeRecordsIntoMemory([toRecord(deleted.doc)]);
                refreshed = true;
                continue;
            }
            // 儲存失敗：這篇沒有被處理（也不會被當成已移除），整輪必須失敗。
            if (removed.length || refreshed) emitChange();
            return { ok: false, error: deleted.error || 'storage_read_failed', removed };
        }
        dropRecord(record.articleId);
        removed.push(record.articleId);
    }
    if (removed.length || refreshed) emitChange();
    return { ok: true, removed };
}

// ─────────────────────────────────────────────────────────────────────────────
// outbox 結果處理
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 舊回執只確認它對應的那一次操作。若 outbox 已被更新的操作取代，保留新操作
 * 並把它的基準 revision 推進到伺服器剛回報的版本；尚未上傳的 create 在伺服器
 * 已有文件後要改成 update，否則下一輪會用同一個 ID 再建立而永遠 409。
 *
 * 確認的是先前送出的 import 快照時，清掉快照（已確認），但保留目前操作。
 *
 * `epoch`：`{ stored, receipt }` 是持久化文件與回執各自的代際。三者（回執、
 * 待同步操作、文件）都必須在同一代際才能推進基準；重建前送出的回執若遲到，
 * 不得把新代際的待建立操作改成 update／推高 expectedRevision。
 */
function rebasePendingOutbox(pending, revision, confirmedMutationId = '', epoch = {}) {
    if (!pending) return null;
    const stored = Number(epoch.stored) || 0;
    const receipt = Number(epoch.receipt) || 0;
    if (receipt !== stored) return null;
    if ((Number(pending.generation) || 0) !== stored) return null;
    // 重建前的舊操作回執不得把版本基準推回已不存在的遠端版本。
    if (ignoresRebuiltReceipt(pending, confirmedMutationId)) return null;
    const current = Number(pending.expectedRevision) || 0;
    const next = Number.isFinite(revision) ? Math.max(current, Number(revision)) : current;
    const nextType = pending.type === 'create' && next > 0 ? 'update' : pending.type;
    const snapshot = pending.importSnapshot || null;
    const confirmedSnapshot = !!snapshot && !!confirmedMutationId
        && snapshot.clientMutationId === confirmedMutationId;
    if (nextType === pending.type && next === current && !confirmedSnapshot) return null;
    const rebased = { ...pending, type: nextType, expectedRevision: next };
    if (confirmedSnapshot) delete rebased.importSnapshot;
    return rebased;
}

/** 同一個交易內把 state 的衝突清單換成指定內容；讀不到 state 時沿用記憶體版本。 */
function readStateForConflictUpdate(stores, scope) {
    return requestValue(stores[STORE_STATE].get(scope)).then((row) => row || null);
}

function statePayloadWithConflicts(row, scope, conflicts) {
    return { ...(row && typeof row === 'object' ? row : {}), scope, conflicts };
}

/**
 * localStorage 後備的單筆／批次回執：判斷規則與 IndexedDB 版本完全相同
 * （回執代際必須等於持久化文件的代際、mutation ID 必須相符、舊代際只忽略、
 * 同代際只 rebase 不清除），但讀取（文件、outbox、ledger、state）與寫入都在
 * 同一個同步區塊內完成，中間沒有 await，不會被另一個分頁插入半完成的狀態。
 */
function fallbackApplyReceipts(scope, entries) {
    // 讀不到或解析不了就明確失敗：不能把「讀取失敗」當成「沒有待確認操作」。
    const read = fallbackReadStrict(scope);
    if (!read.ok) return { ok: false, error: read.error, results: [], updated: [] };
    const bucket = read.bucket;
    const docs = Array.isArray(bucket.docs) ? bucket.docs.slice() : [];
    let outbox = Array.isArray(bucket.outbox) ? bucket.outbox.slice() : [];
    const matched = [];
    const updated = [];
    const results = [];
    let changed = false;
    for (const entry of entries) {
        const docIndex = docs.findIndex((item) => item && item.id === entry.articleId);
        const storedDoc = docIndex >= 0 ? docs[docIndex] : null;
        const opIndex = outbox.findIndex((op) => op && op.articleId === entry.articleId);
        const pending = opIndex >= 0 ? outbox[opIndex] : null;
        // 文件可能已被完整 pull 移除／被遠端墓碑接手，代際屏障由 ledger 接手。
        const storedGeneration = Math.max(
            storedGenerationOf(storedDoc),
            fallbackGeneration(bucket, entry.articleId)
        );
        if (storedDoc && storedGenerationOf(storedDoc) > fallbackGeneration(bucket, entry.articleId)) {
            rememberFallbackGeneration(bucket, entry.articleId, storedGenerationOf(storedDoc));
        }
        // 回執代際必須等於持久化文件的代際；重建／遠端墓碑後的舊代際回執一律忽略。
        const sameGeneration = receiptGenerationOf(entry) === storedGeneration;
        const matches = sameGeneration && !!entry.clientMutationId && !!pending
            && pending.clientMutationId === entry.clientMutationId;
        const rebuilt = !sameGeneration || ignoresRebuiltReceipt(pending, entry.clientMutationId);
        if (matches) {
            outbox = outbox.filter((op) => !op || op.articleId !== entry.articleId);
            changed = true;
        } else if (pending) {
            const rebased = rebasePendingOutbox(pending, entry.revision, entry.clientMutationId, {
                stored: storedGeneration,
                receipt: receiptGenerationOf(entry)
            });
            if (rebased) {
                outbox[opIndex] = rebased;
                changed = true;
            }
        }
        if (storedDoc) {
            const record = toRecord(storedDoc);
            const next = {
                ...record,
                revision: Number.isFinite(entry.revision) && !rebuilt
                    ? Math.max(Number(record.revision) || 0, Number(entry.revision))
                    : record.revision,
                updatedAt: rebuilt ? record.updatedAt : (entry.serverUpdatedAt || record.updatedAt),
                // 舊回執（outbox 已被新修改取代或已不存在）只推進 revision，
                // 不得把已同步狀態重新標成 pending。
                dirty: matches ? false : !!record.dirty,
                pending: matches ? false : !!record.pending,
                conflict: matches ? null : record.conflict
            };
            const nextDoc = toDoc(next, scope);
            docs[docIndex] = nextDoc;
            updated.push({ articleId: entry.articleId, record: next, doc: nextDoc });
            changed = true;
        }
        if (matches) matched.push(entry.articleId);
        results.push({ articleId: entry.articleId, matches });
    }
    let statePayload = null;
    if (matched.length) {
        // 完成確認與衝突移除必須一起寫入；否則重載後衝突又回來。
        // 只更新持久化 state 的相關欄位：不能用呼叫端記憶體的 serializeMeta()
        // 整包覆蓋，否則另一個實例剛寫入的 cursor／migrated／gatePending／
        // lastSyncAt 或其他文章的衝突都會被這份過期記憶體蓋回去。
        const persistedState = bucket.state && typeof bucket.state === 'object' ? bucket.state : {};
        const conflicts = { ...(persistedState.conflicts || meta.conflicts || {}) };
        for (const articleId of matched) delete conflicts[articleId];
        statePayload = statePayloadWithConflicts(persistedState, scope, conflicts);
        bucket.state = statePayload;
        changed = true;
    }
    if (!changed) return { ok: true, results, updated, state: null };
    bucket.docs = docs;
    bucket.outbox = outbox;
    if (!fallbackWrite(scope, bucket)) return { ok: false, error: 'storage_full', results: [], updated: [] };
    return { ok: true, results, updated, state: statePayload };
}

/** 套用後備回執並同步記憶體；單筆查詢回傳 `stale`，批次回傳逐筆結果。 */
function applyFallbackReceipts(scope, entries, options = {}) {
    const outcome = fallbackApplyReceipts(scope, entries);
    if (!outcome.ok) return { ok: false, error: outcome.error || 'storage_full' };
    const updated = Array.isArray(outcome.updated) ? outcome.updated : [];
    if (updated.length) {
        dataEpoch += 1;
        for (const item of updated) {
            cacheDoc(item.doc);
            loadedDocs.set(item.articleId, item.doc);
        }
        mergeRecordsIntoMemory(updated.map((item) => item.record));
    }
    if (outcome.state) meta.conflicts = outcome.state.conflicts || {};
    if (updated.length || outcome.state) emitChange();
    if (options.single === true) {
        const result = (outcome.results && outcome.results[0]) || { matches: false };
        return { ok: true, stale: !result.matches };
    }
    return { ok: true, results: outcome.results || [] };
}

export async function markOpDone(articleId, { revision, serverUpdatedAt, clientMutationId, generation } = {}, ctx = captureArticleContext()) {
    if (!isArticleContextActive(ctx)) return staleResult();
    const scope = ctx.scope;
    const receipt = { revision, serverUpdatedAt, clientMutationId, generation };
    // 後備模式與 IndexedDB 走同一套判斷；確認必須真的寫進持久化儲存才算完成。
    if (fallbackMode) {
        return applyFallbackReceipts(scope, [{ ...receipt, articleId: String(articleId) }], { single: true });
    }
    // 讀 outbox、文件、代際 ledger 與 state 都在同一交易；舊回執不能清掉上傳
    // 期間新寫的 outbox，完成確認與衝突移除也不能只成功一半。
    const result = await idbRequest([STORE_DOCS, STORE_ARTICLE_SUMMARIES, STORE_OUTBOX, STORE_STATE, STORE_ARTICLE_GENERATIONS], 'readwrite', (stores) => {
        return Promise.all([
            requestValue(stores[STORE_DOCS].get(docKey(scope, articleId))),
            requestValue(stores[STORE_OUTBOX].get(docKey(scope, articleId))),
            requestValue(stores[STORE_ARTICLE_GENERATIONS].get(docKey(scope, articleId)))
        ]).then(([storedDocResult, pendingResult, ledgerRow]) => {
            if (!isArticleContextActive(ctx)) {
                try { stores[STORE_DOCS].transaction.abort(); } catch (_) {}
                return { stale: true };
            }
            const storedDoc = storedDocResult || null;
            const pending = pendingResult || null;
            // 文件可能已被完整 pull 移除，代際屏障由 ledger 接手；兩者取高者。
            const storedGeneration = effectiveStoredGeneration(storedDoc, ledgerRow);
            if (storedDoc && storedGeneration > ledgerRowGeneration(ledgerRow)) {
                stores[STORE_ARTICLE_GENERATIONS].put(generationRow(scope, articleId, storedGeneration));
            }
            // 回執代際必須等於持久化文件的代際。重建（404 → create）
            // 之後，任何舊代際的回執（含重建前就送出、回應遲到的）都
            // 不得改動版本、時間或操作。
            const sameGeneration = receiptGenerationOf(receipt) === storedGeneration;
            // 沒有 mutation ID 的回執不得視為匹配；否則上傳期間的新修改
            // 會被舊回執直接清掉。
            const matches = sameGeneration && !!clientMutationId && !!pending
                && pending.clientMutationId === clientMutationId;
            // 舊代際（或被重建取代）的回執只能被忽略。
            const rebuilt = !sameGeneration || ignoresRebuiltReceipt(pending, clientMutationId);
            if (matches && pending) {
                stores[STORE_OUTBOX].delete(docKey(scope, articleId));
            } else if (pending) {
                const rebased = rebasePendingOutbox(pending, revision, clientMutationId, {
                    stored: storedGeneration,
                    receipt: receiptGenerationOf(receipt)
                });
                if (rebased) stores[STORE_OUTBOX].put(rebased);
            }
            let record = null;
            let nextDoc = null;
            if (storedDoc) {
                record = toRecord(storedDoc);
                const next = {
                    ...record,
                    revision: Number.isFinite(revision) && !rebuilt
                        ? Math.max(Number(record.revision) || 0, Number(revision))
                        : record.revision,
                    updatedAt: rebuilt ? record.updatedAt : (serverUpdatedAt || record.updatedAt),
                    // 舊回執（outbox 已被新修改取代或已不存在）只推進 revision，
                    // 不得把已同步狀態重新標成 pending。
                    dirty: matches ? false : !!record.dirty,
                    pending: matches ? false : !!record.pending,
                    conflict: matches ? null : record.conflict
                };
                record = next;
                nextDoc = toDoc(next, scope);
                stores[STORE_DOCS].put(nextDoc);
                stores[STORE_ARTICLE_SUMMARIES].put(summarizeArticleDoc(nextDoc));
            }
            if (!matches) return { matches, record, doc: nextDoc, state: null };
            return readStateForConflictUpdate(stores, scope).then((row) => {
                if (!isArticleContextActive(ctx)) {
                    try { stores[STORE_DOCS].transaction.abort(); } catch (_) {}
                    return { stale: true };
                }
                const conflicts = { ...((row && row.conflicts) || meta.conflicts || {}) };
                delete conflicts[articleId];
                const payload = statePayloadWithConflicts(row, scope, conflicts);
                stores[STORE_STATE].put(payload);
                return { matches, record, doc: nextDoc, state: payload };
            });
        });
    }, ctx);
    if (!isArticleContextActive(ctx)) return { ...staleResult(), stale: true };
    // 交易本身失敗時不得改寫後備桶：文件與 outbox 都在 IndexedDB 裡，
    // 後備桶找不到它們會被誤判成「已完成」。呼叫端保留 outbox 下一輪重試。
    if (!result.ok) return { ok: false, error: result.error || 'idb_write_failed' };
    const value = result.value || {};
    if (value.stale) return { ...staleResult(), stale: true };
    if (value.doc) {
        dataEpoch += 1;
        cacheDoc(value.doc);
        loadedDocs.set(articleId, value.doc);
        replaceRecord(value.record);
    }
    if (value.state) meta.conflicts = value.state.conflicts || {};
    emitChange();
    return { ok: true, stale: !value.matches };
}

/**
 * 批次完成 outbox：舊資料匯入後核對 100 篇時，不用開 100 次交易。
 * entries: [{ articleId, revision, serverUpdatedAt, clientMutationId, generation }]
 */
export async function markOpsDone(entries, ctx = captureArticleContext()) {
    const list = (Array.isArray(entries) ? entries : [])
        .filter((entry) => entry && entry.articleId)
        .map((entry) => ({
            articleId: String(entry.articleId),
            revision: entry.revision,
            serverUpdatedAt: entry.serverUpdatedAt,
            clientMutationId: entry.clientMutationId,
            generation: entry.generation
        }));
    if (!list.length) return { ok: true, results: [] };
    if (!isArticleContextActive(ctx)) return { ...staleResult(), results: [] };
    const scope = ctx.scope;
    // 後備模式與 IndexedDB 走同一套判斷；確認必須真的寫進持久化儲存才算完成。
    if (fallbackMode) return applyFallbackReceipts(scope, list);
    const result = await idbRequest([STORE_DOCS, STORE_ARTICLE_SUMMARIES, STORE_OUTBOX, STORE_STATE, STORE_ARTICLE_GENERATIONS], 'readwrite', (stores) => {
        return Promise.all(list.map((entry) => Promise.all([
            requestValue(stores[STORE_DOCS].get(docKey(scope, entry.articleId))),
            requestValue(stores[STORE_OUTBOX].get(docKey(scope, entry.articleId))),
            requestValue(stores[STORE_ARTICLE_GENERATIONS].get(docKey(scope, entry.articleId)))
        ]))).then((pairs) => {
            if (!isArticleContextActive(ctx)) {
                try { stores[STORE_DOCS].transaction.abort(); } catch (_) {}
                return { stale: true, results: [], updated: [] };
            }
            const updated = [];
            const results = list.map((entry, index) => {
                const [storedDoc, pending, ledgerRow] = pairs[index];
                // 文件可能已被完整 pull 移除，代際屏障由 ledger 接手；取兩者較高值。
                const storedGeneration = effectiveStoredGeneration(storedDoc, ledgerRow);
                if (storedDoc && storedGenerationOf(storedDoc) > ledgerRowGeneration(ledgerRow)) {
                    stores[STORE_ARTICLE_GENERATIONS].put(
                        generationRow(scope, entry.articleId, storedGenerationOf(storedDoc))
                    );
                }
                // 回執代際必須等於持久化文件的代際；重建後的舊代際回執一律
                // 不得改動版本、時間、類型與基準版本。
                const sameGeneration = receiptGenerationOf(entry) === storedGeneration;
                // 核對必須帶實際送出操作的 mutation ID；缺少 ID 時一律不匹配，
                // 避免匯入核對的舊回執清掉等待期間的新修改／刪除。
                const matches = sameGeneration && !!entry.clientMutationId && !!pending
                    && pending.clientMutationId === entry.clientMutationId;
                // 舊代際（或被重建取代）的回執只能被忽略。
                const rebuilt = !sameGeneration || ignoresRebuiltReceipt(pending, entry.clientMutationId);
                if (matches && pending) {
                    stores[STORE_OUTBOX].delete(docKey(scope, entry.articleId));
                } else if (pending) {
                    const rebased = rebasePendingOutbox(pending, entry.revision, entry.clientMutationId, {
                        stored: storedGeneration,
                        receipt: receiptGenerationOf(entry)
                    });
                    if (rebased) stores[STORE_OUTBOX].put(rebased);
                }
                if (!storedDoc) return { articleId: entry.articleId, matches, record: null };
                const record = toRecord(storedDoc);
                const next = {
                    ...record,
                    revision: Number.isFinite(entry.revision) && !rebuilt
                        ? Math.max(Number(record.revision) || 0, Number(entry.revision))
                        : record.revision,
                    updatedAt: rebuilt ? record.updatedAt : (entry.serverUpdatedAt || record.updatedAt),
                    // 舊回執（outbox 已被新修改取代或已不存在）只推進 revision，
                    // 不得把已同步狀態重新標成 pending。
                    dirty: matches ? false : !!record.dirty,
                    pending: matches ? false : !!record.pending,
                    conflict: matches ? null : record.conflict
                };
                const nextDoc = toDoc(next, scope);
                stores[STORE_DOCS].put(nextDoc);
                stores[STORE_ARTICLE_SUMMARIES].put(summarizeArticleDoc(nextDoc));
                updated.push({ articleId: entry.articleId, record: next, doc: nextDoc });
                return { articleId: entry.articleId, matches, record: next };
            });
            const matched = results.filter((item) => item.matches).map((item) => item.articleId);
            if (!matched.length) return { results, updated, state: null };
            // 完成確認與衝突移除必須在同一個交易；state 寫失敗就整批回滾，
            // 不能留下「已回報成功、重載後衝突又回來」的半套狀態。
            return readStateForConflictUpdate(stores, scope).then((row) => {
                if (!isArticleContextActive(ctx)) {
                    try { stores[STORE_DOCS].transaction.abort(); } catch (_) {}
                    return { stale: true, results: [], updated: [] };
                }
                const conflicts = { ...((row && row.conflicts) || meta.conflicts || {}) };
                for (const articleId of matched) delete conflicts[articleId];
                const payload = statePayloadWithConflicts(row, scope, conflicts);
                stores[STORE_STATE].put(payload);
                return { results, updated, state: payload };
            });
        });
    }, ctx);
    if (!isArticleContextActive(ctx)) return { ...staleResult(), results: [] };
    // 同上：交易失敗時不改寫後備桶（文件與 outbox 都在 IndexedDB 裡）。
    if (!result.ok) return { ok: false, error: result.error || 'idb_write_failed', results: [] };
    const value = result.value || {};
    if (value.stale) return { ...staleResult(), results: [] };
    const updated = Array.isArray(value.updated) ? value.updated : [];
    if (updated.length) {
        dataEpoch += 1;
        for (const item of updated) {
            cacheDoc(item.doc);
            loadedDocs.set(item.articleId, item.doc);
        }
        mergeRecordsIntoMemory(updated.map((item) => item.record));
    }
    if (value.state) meta.conflicts = value.state.conflicts || {};
    if (updated.length || value.state) emitChange();
    return { ok: true, results: value.results || [] };
}

export function getDataEpoch() {
    return dataEpoch;
}

/**
 * 文章寫入 + 同步狀態（lastError／衝突）在同一個交易提交。
 * 任何一部分失敗都不更新記憶體，避免持久化失敗卻留下成功狀態。
 */
async function persistDocWithMeta(record, metaPatch, ctx = captureArticleContext()) {
    if (!isArticleContextActive(ctx)) return staleResult();
    const scope = ctx.scope;
    const statePayload = { scope, ...serializeMeta(), ...metaPatch };
    if (fallbackMode) {
        // 錯誤記錄（markOpFailed）也是讀改寫：讀不到桶時不得用「空桶 + 這篇」
        // 覆寫，否則其他文件與待同步操作會一起消失。
        const read = fallbackReadStrict(scope);
        if (!read.ok) {
            meta.persistenceError = read.error;
            return { ok: false, error: read.error };
        }
        const bucket = read.bucket;
        const storedDoc = (bucket.docs || []).find((item) => item && item.id === record.articleId) || null;
        const merged = adoptStoredGeneration(record, storedDoc, fallbackGeneration(bucket, record.articleId));
        record.revision = merged.revision;
        record.generation = merged.generation;
        const doc = toDoc(merged, scope);
        bucket.docs = (bucket.docs || []).filter((item) => item.id !== doc.id);
        bucket.docs.push(doc);
        rememberFallbackGeneration(bucket, doc.id, doc.generation);
        bucket.state = statePayload;
        if (!fallbackWrite(scope, bucket)) {
            meta.persistenceError = 'storage_full';
            return { ok: false, error: 'storage_full' };
        }
        meta.persistenceError = '';
        dataEpoch += 1;
        cacheDoc(doc);
        loadedDocs.set(record.articleId, doc);
        return { ok: true, doc };
    }
    const result = await idbRequest([STORE_DOCS, STORE_ARTICLE_SUMMARIES, STORE_STATE, STORE_ARTICLE_GENERATIONS], 'readwrite', (stores) => {
        // 交易內先讀既有文件與 ledger：代際只能前進，不能因為舊分頁寫入而倒退。
        return Promise.all([
            requestValue(stores[STORE_DOCS].get(docKey(scope, record.articleId))),
            requestValue(stores[STORE_ARTICLE_GENERATIONS].get(docKey(scope, record.articleId)))
        ]).then(([storedDoc, ledgerRow]) => {
            const merged = adoptStoredGeneration(record, storedDoc, ledgerRowGeneration(ledgerRow));
            record.revision = merged.revision;
            record.generation = merged.generation;
            const doc = toDoc(merged, scope);
            stores[STORE_DOCS].put(doc);
            stores[STORE_ARTICLE_SUMMARIES].put(summarizeArticleDoc(doc));
            if (ledgerRowGeneration(ledgerRow) < storedGenerationOf(doc)) {
                stores[STORE_ARTICLE_GENERATIONS].put(generationRow(scope, doc.id, doc.generation));
            }
            stores[STORE_STATE].put(statePayload);
            return doc;
        });
    }, ctx);
    if (result.ok) {
        dataEpoch += 1;
        const doc = result.value || toDoc(record, scope);
        cacheDoc(doc);
        loadedDocs.set(record.articleId, doc);
        meta.persistenceError = '';
        return { ok: true, doc };
    }
    if (result.error === 'idb_unavailable') {
        fallbackMode = true;
        return persistDocWithMeta(record, metaPatch, ctx);
    }
    meta.persistenceError = result.error || 'idb_write_failed';
    return { ok: false, error: meta.persistenceError };
}

export async function markOpFailed(articleId, error, options = {}) {
    const ctx = options.ctx || captureArticleContext();
    if (!isArticleContextActive(ctx)) return staleResult();
    let record = findRecord(articleId);
    if (record?.summaryOnly) record = await ensureArticleLoaded(articleId, ctx);
    if (!isArticleContextActive(ctx)) return staleResult();
    if (!record) return { ok: false, error: 'record_missing' };
    const next = { ...record, dirty: true, pending: true };
    const nextError = error ? String(error) : String(meta.lastError || '');
    const nextConflicts = options.conflict
        ? { ...(meta.conflicts || {}), [articleId]: { articleId, at: nowIso(), ...options.conflict } }
        : (meta.conflicts || {});
    const persisted = await persistDocWithMeta(next, { lastError: nextError, conflicts: nextConflicts }, ctx);
    if (!isArticleContextActive(ctx)) return staleResult();
    if (!persisted.ok) return { ok: false, error: persisted.error || 'persist_failed' };
    meta.lastError = nextError;
    meta.conflicts = nextConflicts;
    // persistDocWithMeta 會把交易內採用的代際／版本寫回 next，直接沿用即可。
    replaceRecord(next);
    emitChange();
    return { ok: true };
}

/** 伺服器已沒有這篇（例如在別的裝置刪除後又被清空）：把待同步操作改成建立。 */
export async function requeueAsCreate(articleId, ctx = captureArticleContext(), options = {}) {
    if (!isArticleContextActive(ctx)) return staleResult();
    let record = findRecord(articleId);
    if (record?.summaryOnly) record = await ensureArticleLoaded(articleId, ctx);
    if (!isArticleContextActive(ctx)) return staleResult();
    if (!record) return { ok: false, error: 'record_missing' };
    const next = { ...record, revision: 0, deletedAt: '', dirty: true, pending: true };
    const result = await persistDocWithOp(next, 'create', {
        ctx,
        // 只有「伺服器確認不存在」的重建才能把版本基準歸零；交易內會再核對
        // 目前操作仍是呼叫端看到的那一個（fromMutationId）。
        resetRevision: true,
        resetFromMutationId: options.fromMutationId || ''
    });
    if (!isArticleContextActive(ctx)) return staleResult();
    if (!result.ok) {
        // 交易內發現操作已被新的本機修改取代：保留它的版本基準，下一輪重新處理。
        return { ok: false, error: result.error || 'requeue_failed', deferred: result.deferred === true };
    }
    replaceRecord(result.doc ? toRecord(result.doc) : next);
    emitChange();
    return { ok: true };
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
        // 代際也是備份資料：新備份還原後屏障不會倒退；舊備份沒有這個欄位時
        // 由還原端以 ledger 的較高代際接手。
        generation: Number(item.generation) || 0,
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
export async function exportDocumentsResult(ctx = captureArticleContext(), options = {}) {
    if (!isArticleContextActive(ctx)) return staleResult();
    const loaded = await loadAllRecordsDetailed(ctx, options);
    if (!loaded.ok) return loaded;
    if (!isArticleContextActive(ctx)) return staleResult();
    return {
        ok: true,
        scope: loaded.scope,
        generation: loaded.generation,
        documents: loaded.records.filter((item) => item && item.articleId).map(toExportDocument)
    };
}

export async function exportDocuments(ctx = captureArticleContext(), options = {}) {
    const result = await exportDocumentsResult(ctx, options);
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
            // 沒有代際的舊備份交給 persistDocWithOp：交易內會採用 ledger 中
            // 較高的代際，同 ID 還原不會重新接受已過期的回執。
            generation: Number(raw.generation) || Number(existing?.generation) || 0,
            createdAt: raw.createdAt || existing?.createdAt || nowIso(),
            updatedAt: raw.updatedAt || existing?.updatedAt || nowIso(),
            lastOpenedAt: raw.lastOpenedAt || existing?.lastOpenedAt || '',
            deletedAt: raw.deletedAt || '',
            dirty: true,
            pending: true,
            conflict: null
        };
        // 明確的備份還原覆蓋本機墓碑：先 restore 再 PUT 新正文。記憶體可能
        // 落後另一個分頁剛套用的遠端墓碑，transaction 內會再用持久化文件的
        // deletedAt 補判（restoreIntent）。一般編輯不會帶這個旗標。
        const restoringTombstone = !!(existing && existing.deletedAt) && !record.deletedAt;
        const type = restoringTombstone ? 'restore_update' : (existing ? 'update' : 'create');
        const persisted = await persistDocWithOp(record, type, {
            ctx,
            restoreIntent: options.replace === true && !record.deletedAt
        });
        if (!isArticleContextActive(ctx)) return staleResult();
        if (!persisted.ok) return { ok: false, error: persisted.error, imported, skipped };
        // 用交易內實際寫入的文件（可能已採用 ledger 的代際）更新記憶體。
        if (!record.deletedAt) replaceRecord(persisted.doc ? toRecord(persisted.doc) : record);
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
