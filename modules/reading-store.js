// 文章閱讀檔案的本機永久儲存。
//
// 負責：學習條目、文章文件、詞書／詞條／來源關聯、會話與消息、原文版本、
// 逐項 outbox 與遷移。所有「永久實體 + 待同步操作」都經過同一個
// IndexedDB 交易；交易完成才回報保存成功。
//
// 記憶體只是目前 scope 的視圖；IndexedDB（或明確標示的 localStorage
// 後備）才是權威來源。任何寫入失敗都會回傳 `{ ok:false, error }`。

import * as state from './state.js';
import * as articleStore from './article-store.js';
import * as cache from './cache.js';
import {
    STORE,
    applyPermanentOperations,
    runPermanentTransaction,
    readStoreAll,
    readStoreOne,
    readStoreByIndex,
    countStore,
    openPermanentDb,
    requestPromise
} from './permanent-db.js';
import {
    READING_LIMITS,
    contentVersionOf,
    generateReadingId,
    mergeReadingEntity,
    normalizeAnchor,
    normalizeReadingPatch,
    wireReadingEntity,
    locateTextAnchor
} from '../shared/reading-protocol.mjs';

const FALLBACK_PREFIX = 'bdc:reading:fallback:v1:';
const MIGRATION_BACKUP_PREFIX = 'bdc:reading:migration-backup:v1:';
const LEGACY_CLAIM_KEY = 'bdc:reading:legacy-claimed:v1';
const LEGACY_ASSISTANT_INDEX = 'assistantConvIndex';
const LEGACY_ASSISTANT_KEY = 'assistantConversations';

let currentScope = '';
let fallbackMode = false;
let initialized = false;
let scopeGeneration = 0;
// 同一頁的讀取／修改／寫入必須序列化；否則兩個同引用 upsert 會各自讀到
// 「不存在」而建立兩筆，兩個不同欄位 patch 也可能互相覆蓋。
let writeChain = Promise.resolve();
// 本 scope 的資料變更世代：備份等功能用它跳過沒有變更的重建。
let dataEpoch = 0;

function serializeWrite(work) {
    const run = writeChain.then(work, work);
    writeChain = run.catch(() => {});
    return run;
}

function articleGeneration() {
    try { return typeof articleStore.getScopeGeneration === 'function' ? articleStore.getScopeGeneration() : 0; } catch (_) { return 0; }
}

/** 在公開操作入口同步捕捉 scope 與世代；所有 await 後都只能使用這份上下文。 */
export function captureReadingContext(extra = {}) {
    return {
        scope: currentScope || articleStore.getArticleScope(),
        generation: scopeGeneration,
        articleScope: articleStore.getArticleScope(),
        articleGeneration: articleGeneration(),
        ...extra
    };
}

export function isReadingContextActive(ctx) {
    if (!ctx || !ctx.scope) return false;
    const activeScope = currentScope || articleStore.getArticleScope();
    return ctx.scope === activeScope
        && ctx.generation === scopeGeneration
        && ctx.articleScope === articleStore.getArticleScope()
        && ctx.articleGeneration === articleGeneration();
}

function staleResult() {
    return { ok: false, error: 'stale_scope' };
}

/** 捕捉入口上下文並排入單頁序列；真正執行時若已切換帳戶就安全中止。 */
function runCaptured(work) {
    const ctx = captureReadingContext();
    return serializeWrite(async () => {
        if (!isReadingContextActive(ctx)) return staleResult();
        return work(ctx);
    });
}

/**
 * 只捕捉上下文、不佔用單頁寫入序列。供「會再呼叫其他公開寫入 API」的
 * 複合流程（遷移、還原）使用；否則巢狀排隊會互相等待。
 */
function runCapturedComposite(work) {
    const ctx = captureReadingContext();
    if (!isReadingContextActive(ctx)) return Promise.resolve(staleResult());
    return Promise.resolve().then(() => work(ctx));
}

let meta = emptyMeta();
const itemsById = new Map();
const documentsById = new Map();
const booksById = new Map();
const entriesById = new Map();
const linksById = new Map();
const conversationsById = new Map();
const messagesByConversation = new Map();
const messagesById = new Map();

function emptyMeta() {
    return {
        cursor: 0,
        lastSyncAt: '',
        lastError: '',
        conflicts: {},
        migrationComplete: false,
        migratedAt: '',
        legacyVocabularyMigrated: false,
        legacyAssistantMigrated: false,
        legacyItemArticles: {},
        migration: {},
        legacySnapshotAdopted: false,
        persistenceError: ''
    };
}

function nowIso() {
    return new Date().toISOString();
}

function scope() {
    return currentScope || articleStore.getArticleScope();
}

function entityKey(id, recordScope = scope()) {
    return `${recordScope}\u0000${id}`;
}

function messageKey(conversationId, id, recordScope = scope()) {
    return `${recordScope}\u0000${conversationId}\u0000${id}`;
}

function outboxKey(entityType, entityId, recordScope = scope()) {
    return `${recordScope}\u0000${entityType}\u0000${entityId}`;
}

function emitChange(detail = {}) {
    try {
        const ctx = detail.ctx || null;
        const eventScope = ctx ? ctx.scope : scope();
        const rest = { ...detail };
        delete rest.ctx;
        document.dispatchEvent(new CustomEvent('bdc:reading-change', { detail: { scope: eventScope, ...rest } }));
    } catch (_) {}
}

// ─────────────────────────────────────────────────────────────────────────────
// localStorage 後備（IndexedDB 不可用時）
// ─────────────────────────────────────────────────────────────────────────────

function fallbackKey(recordScope = scope()) {
    return FALLBACK_PREFIX + recordScope;
}

function emptyBucket() {
    return {
        items: [], documents: [], books: [], entries: [], links: [],
        conversations: [], messages: [], outbox: [], versions: [], state: null
    };
}

function readBucket(recordScope = scope()) {
    try {
        const raw = localStorage.getItem(fallbackKey(recordScope));
        const parsed = raw ? JSON.parse(raw) : null;
        if (parsed && typeof parsed === 'object') return { ...emptyBucket(), ...parsed };
    } catch (_) {}
    return emptyBucket();
}

/**
 * 嚴格版本的後備桶讀取：必須分辨「合法空桶」與讀取／解析失敗。
 *
 * `readBucket()` 是給一般讀取用的：它把例外／損壞當成空桶，讓沒有備份的
 * 裝置可以正常啟動。完整備份匯出（`exportAll()`）不能這樣做，否則讀不到
 * 桶時會回報 `ok:true` 的空快照，備份流程就存下一份殘缺備份、裁剪舊備份並
 * 更新簽章，讓原本可用的備份永久消失。
 */
function readBucketStrict(recordScope = scope()) {
    let raw;
    try {
        raw = localStorage.getItem(fallbackKey(recordScope));
    } catch (_) {
        return { ok: false, error: 'storage_read_failed' };
    }
    if (raw == null || raw === '') return { ok: true, bucket: emptyBucket() };
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (_) {
        return { ok: false, error: 'storage_corrupt' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, error: 'storage_corrupt' };
    }
    const bucket = { ...emptyBucket(), ...parsed };
    // 桶裡的清單一旦存在卻不是陣列，代表寫入端或儲存已損壞；當成空清單會
    // 讓匯出結果看起來「成功但沒有資料」，因此一律回報損壞。
    for (const name of ['items', 'documents', 'books', 'entries', 'links', 'conversations', 'messages', 'outbox', 'versions']) {
        const value = parsed[name];
        if (value != null && !Array.isArray(value)) return { ok: false, error: 'storage_corrupt' };
    }
    if (parsed.state != null && (typeof parsed.state !== 'object' || Array.isArray(parsed.state))) {
        return { ok: false, error: 'storage_corrupt' };
    }
    return { ok: true, bucket };
}

function writeBucket(bucket, recordScope = scope()) {
    try {
        localStorage.setItem(fallbackKey(recordScope), JSON.stringify(bucket));
        fallbackMode = true;
        return true;
    } catch (_) {
        return false;
    }
}

function bucketArray(name, recordScope = scope()) {
    const bucket = readBucket(recordScope);
    return Array.isArray(bucket[name]) ? bucket[name] : [];
}

function bucketWrite(name, records, recordScope = scope()) {
    const bucket = readBucket(recordScope);
    bucket[name] = records;
    return writeBucket(bucket, recordScope);
}

function useFallback() {
    fallbackMode = true;
}

// ─────────────────────────────────────────────────────────────────────────────
// 載入
// ─────────────────────────────────────────────────────────────────────────────

function replaceMap(target, records, recordScope = scope()) {
    target.clear();
    for (const record of records) {
        if (!record || !record.id) continue;
        if (record.scope && record.scope !== recordScope) continue;
        target.set(record.id, record);
    }
}

async function loadAll(storeName, listName, recordScope = scope()) {
    if (fallbackMode) return bucketArray(listName, recordScope);
    const result = await readStoreAll(storeName, recordScope);
    if (result.ok) return result.records;
    // 單次交易／讀取失敗不代表 IDB 不可用；不要讓啟動清單的容錯讀取
    // 把後續文章載入、marked 遷移與匯出永久導向可能不存在的後備桶。
    // 真正使用過後備儲存的模式仍保留，避免忽略已寫入的後備資料。
    if (result.error === 'idb_unavailable') useFallback();
    return bucketArray(listName, recordScope);
}

const loadedArticleIds = new Set();
const articleLoadPromises = new Map();

function clearArticleLoadState() {
    loadedArticleIds.clear();
    articleLoadPromises.clear();
}

/**
 * 只載入指定文章的學習條目與文件。啟動清單不讀所有文章全文，也不讀所有
 * 學習條目的長解釋；切換文章時才按 `scope_article` 索引批次補齊。
 */
export async function ensureArticleReadingLoaded(articleId, ctx = captureReadingContext()) {
    if (!articleId) return { ok: true, skipped: true };
    if (!isReadingContextActive(ctx)) return staleResult();
    if (loadedArticleIds.has(articleId)) return { ok: true };
    const promiseKey = `${ctx.scope}\u0000${articleId}\u0000${ctx.generation}\u0000${ctx.articleScope}\u0000${ctx.articleGeneration}`;
    if (articleLoadPromises.has(promiseKey)) {
        const result = await articleLoadPromises.get(promiseKey);
        return isReadingContextActive(ctx) ? result : staleResult();
    }
    const task = (async () => {
        let items = [];
        let documents = [];
        if (!fallbackMode) {
            const [itemRead, documentRead] = await Promise.all([
                readStoreByIndex(STORE.READING_ITEMS, 'scope_article', [ctx.scope, articleId]),
                readStoreByIndex(STORE.ARTICLE_DOCUMENTS, 'scope_article', [ctx.scope, articleId])
            ]);
            if (!isReadingContextActive(ctx)) return staleResult();
            if (!itemRead.ok || !documentRead.ok) {
                if (itemRead.error !== 'idb_unavailable' || documentRead.error !== 'idb_unavailable') {
                    return { ok: false, error: itemRead.error || documentRead.error || 'idb_read_failed' };
                }
                useFallback();
            } else {
                items = itemRead.records;
                documents = documentRead.records;
            }
        }
        if (fallbackMode) {
            const read = readBucketStrict(ctx.scope);
            if (!read.ok) return read;
            items = read.bucket.items || [];
            documents = read.bucket.documents || [];
        }
        const belongs = record => record && record.id && record.scope === ctx.scope && record.articleId === articleId;
        items = items.filter(belongs);
        documents = documents.filter(belongs);
        for (const record of items) itemsById.set(record.id, record);
        for (const record of documents) documentsById.set(record.id, record);
        // 舊資料沒有 marked：只在交易內、仍缺少布林值時補一次；
        // 已有 true／false 一律不動，明確取消不會被重新標記。
        // 遷移失敗必須回報並保留重試機會：只有全部成功才把文章標記為已載入，
        // 否則下一次載入會直接回 ok 而永遠不再補遷移。
        const migrated = await migrateArticleMarkedItems(articleId, ctx);
        if (!isReadingContextActive(ctx)) return staleResult();
        if (migrated && migrated.ok === false) {
            return { ok: false, error: migrated.error || 'marked_migration_failed', items: items.length, documents: documents.length };
        }
        loadedArticleIds.add(articleId);
        return { ok: true, items: items.length, documents: documents.length };
    })();
    articleLoadPromises.set(promiseKey, task);
    try {
        const result = await task;
        return isReadingContextActive(ctx) ? result : staleResult();
    } finally {
        if (articleLoadPromises.get(promiseKey) === task) articleLoadPromises.delete(promiseKey);
    }
}

function contextBase(recordScope, generation) {
    return {
        scope: recordScope,
        generation,
        articleScope: articleStore.getArticleScope(),
        articleGeneration: articleGeneration()
    };
}

export async function initReadingStore(explicitScope = '') {
    const next = String(explicitScope || articleStore.getArticleScope());
    if (!initialized || (currentScope && currentScope !== next)) scopeGeneration += 1;
    currentScope = next;
    const generation = scopeGeneration;
    const ctx = contextBase(next, generation);
    const db = await openPermanentDb();
    if (!db) useFallback();
    if (generation !== scopeGeneration) return staleResult();

    const [books, entries, links, conversations] = await Promise.all([
        loadAll(STORE.VOCAB_BOOKS, 'books', next),
        loadAll(STORE.VOCAB_ENTRIES, 'entries', next),
        loadAll(STORE.VOCAB_LINKS, 'links', next),
        loadAll(STORE.CONVERSATIONS, 'conversations', next)
    ]);
    if (generation !== scopeGeneration) return staleResult();
    replaceMap(booksById, books, next);
    replaceMap(entriesById, entries, next);
    replaceMap(linksById, links, next);
    replaceMap(conversationsById, conversations, next);
    itemsById.clear();
    documentsById.clear();
    clearArticleLoadState();
    messagesByConversation.clear();
    messagesById.clear();

    const stateResult = await readStoreOne(STORE.READING_STATE, next);
    if (generation !== scopeGeneration) return staleResult();
    const stored = stateResult.ok ? stateResult.value : readBucket(next).state;
    meta = { ...emptyMeta(), ...(stored || {}) };
    meta.conflicts = stored && stored.conflicts && typeof stored.conflicts === 'object' ? stored.conflicts : {};
    meta.legacyItemArticles = stored && stored.legacyItemArticles && typeof stored.legacyItemArticles === 'object'
        ? stored.legacyItemArticles : {};
    initialized = true;
    emitChange({ reason: 'loaded', ctx });
    return { ok: true, scope: next, generation, fallbackMode };
}

/** 登入／登出／換帳戶後重新載入；不會把舊 scope 的資料帶進新 scope。 */
export async function reloadReadingScope(nextScope = articleStore.getArticleScope()) {
    const next = String(nextScope || articleStore.getArticleScope());
    if (next === currentScope && initialized) {
        await loadScopeIntoMemory();
        return { changed: false, scope: next, generation: scopeGeneration };
    }
    const result = await initReadingStore(next);
    return { changed: true, scope: next, generation: scopeGeneration, ...result };
}

async function loadScopeIntoMemory() {
    const ctx = captureReadingContext();
    const [books, entries, links, conversations] = await Promise.all([
        loadAll(STORE.VOCAB_BOOKS, 'books', ctx.scope),
        loadAll(STORE.VOCAB_ENTRIES, 'entries', ctx.scope),
        loadAll(STORE.VOCAB_LINKS, 'links', ctx.scope),
        loadAll(STORE.CONVERSATIONS, 'conversations', ctx.scope)
    ]);
    if (!isReadingContextActive(ctx)) return staleResult();
    replaceMap(booksById, books, ctx.scope);
    replaceMap(entriesById, entries, ctx.scope);
    replaceMap(linksById, links, ctx.scope);
    replaceMap(conversationsById, conversations, ctx.scope);
    itemsById.clear();
    documentsById.clear();
    clearArticleLoadState();
    messagesByConversation.clear();
    messagesById.clear();
    const stateResult = await readStoreOne(STORE.READING_STATE, ctx.scope);
    if (!isReadingContextActive(ctx)) return staleResult();
    const stored = stateResult.ok ? stateResult.value : readBucket(ctx.scope).state;
    meta = { ...emptyMeta(), ...(stored || {}) };
    meta.legacyItemArticles = meta.legacyItemArticles || {};
    emitChange({ reason: 'scope-reloaded', ctx });
    return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// 交易與寫入
// ─────────────────────────────────────────────────────────────────────────────

function storeForType(entityType) {
    switch (entityType) {
        case 'learningItem': return STORE.READING_ITEMS;
        case 'articleDocument': return STORE.ARTICLE_DOCUMENTS;
        case 'vocabularyBook': return STORE.VOCAB_BOOKS;
        case 'vocabularyEntry': return STORE.VOCAB_ENTRIES;
        case 'vocabularyLink': return STORE.VOCAB_LINKS;
        case 'conversation': return STORE.CONVERSATIONS;
        case 'message': return STORE.MESSAGES;
        default: return '';
    }
}

function mapForType(entityType) {
    switch (entityType) {
        case 'learningItem': return itemsById;
        case 'articleDocument': return documentsById;
        case 'vocabularyBook': return booksById;
        case 'vocabularyEntry': return entriesById;
        case 'vocabularyLink': return linksById;
        case 'conversation': return conversationsById;
        default: return null;
    }
}

function listForBucket(entityType) {
    switch (entityType) {
        case 'learningItem': return 'items';
        case 'articleDocument': return 'documents';
        case 'vocabularyBook': return 'books';
        case 'vocabularyEntry': return 'entries';
        case 'vocabularyLink': return 'links';
        case 'conversation': return 'conversations';
        case 'message': return 'messages';
        default: return '';
    }
}

function recordKeyFor(entityType, entity, recordScope = scope()) {
    if (!entity || !entity.id) return '';
    if (entityType === 'message') return messageKey(entity.conversationId, entity.id, recordScope);
    return entityKey(entity.id, recordScope);
}

function hydrateEntity(entityType, record) {
    if (!record || !record.id) return null;
    if (entityType === 'learningItem') {
        if (!record.anchor || typeof record.anchor !== 'object') record.anchor = normalizeAnchor(record.anchor);
        if (!Array.isArray(record.kind) && !['word', 'phrase', 'sentence'].includes(record.kind)) record.kind = 'word';
        if (!['unmarked', 'needs_review', 'understood'].includes(record.understanding)) record.understanding = 'unmarked';
        if (typeof record.note !== 'string') record.note = '';
        if (record.explanation === undefined) record.explanation = null;
    }
    if (entityType === 'articleDocument') {
        if (!Array.isArray(record.sourceItemIds)) record.sourceItemIds = [];
        if (!Array.isArray(record.sourceMessageIds)) record.sourceMessageIds = [];
        if (typeof record.content !== 'string') record.content = '';
    }
    if (entityType === 'message') {
        if (typeof record.content !== 'string') record.content = '';
        if (!record.conversationId) record.conversationId = '';
    }
    if (entityType === 'vocabularyEntry') {
        if (!Array.isArray(record.examples)) record.examples = [];
        if (!Array.isArray(record.sources)) record.sources = [];
    }
    return record;
}

function rememberEntity(entityType, entity, ctx = null) {
    if (ctx && !isReadingContextActive(ctx)) return;
    const map = mapForType(entityType);
    if (map && entity) map.set(entity.id, entity);
    dataEpoch += 1;
}

/** 同步路徑的記憶體更新：message 沒有 mapForType，另有 messagesById 快取。 */
function rememberAppliedEntity(entityType, record, ctx) {
    rememberEntity(entityType, record, ctx);
    if (entityType === 'message' && isReadingContextActive(ctx)) {
        messagesByConversation.delete(`${ctx.scope}\u0000${record.conversationId}`);
        messagesById.set(record.id, record);
    }
}

export function getDataEpoch() {
    return dataEpoch;
}

function forgetEntity(entityType, entityId) {
    const map = mapForType(entityType);
    if (map) map.delete(entityId);
}

function upsertInList(list, entity) {
    const next = list.filter((item) => item && item.id !== entity.id);
    next.push(entity);
    return next;
}

function baseFromEntity(entity) {
    return entity ? wireReadingEntity(entity) : null;
}

function buildPendingEntity(entityType, input, existing, { keepBase = false, ctx = captureReadingContext() } = {}) {
    const timestamp = nowIso();
    const revision = Number(existing?.revision) || Number(input?.revision) || 0;
    const entity = {
        ...(existing || {}),
        ...normalizeReadingPatch(entityType, input),
        id: existing?.id || input.id,
        scope: ctx.scope,
        revision,
        pending: true,
        dirty: true,
        updatedAt: input.updatedAt || timestamp,
        createdAt: existing?.createdAt || input.createdAt || timestamp
    };
    if (entityType === 'learningItem') {
        if (!entity.anchor) entity.anchor = normalizeAnchor(input.anchor);
        if (!entity.understanding) entity.understanding = 'unmarked';
        if (typeof entity.note !== 'string') entity.note = '';
        if (entity.explanation === undefined) entity.explanation = null;
    }
    return { entity, keepBase };
}

async function readOutboxRecord(entityType, entityId, ctx = captureReadingContext()) {
    if (fallbackMode) {
        const list = bucketArray('outbox', ctx.scope);
        return list.find((op) => op && op.entityType === entityType && op.entityId === entityId) || null;
    }
    const result = await readStoreOne(STORE.READING_OUTBOX, outboxKey(entityType, entityId, ctx.scope));
    if (!result.ok) return null;
    return result.value || null;
}

async function readOutboxAll(ctx = captureReadingContext()) {
    if (fallbackMode) return bucketArray('outbox', ctx.scope);
    const result = await readStoreAll(STORE.READING_OUTBOX, ctx.scope);
    return result.ok ? result.records : [];
}

function buildOutboxMutation(entityType, entity, existing, op, baseEntity = null, ctx = captureReadingContext(), previousOutbox = undefined) {
    const timestamp = nowIso();
    const previous = previousOutbox !== undefined
        ? previousOutbox
        : (existing || null);
    const base = previous?.base || (baseEntity ? baseFromEntity(baseEntity) : null);
    const expectedRevision = Number(previous?.expectedRevision ?? entity.revision) || 0;
    return {
        key: outboxKey(entityType, entity.id, ctx.scope),
        scope: ctx.scope,
        mutationId: generateReadingId('m'),
        entityType,
        entityId: entity.id,
        op,
        expectedRevision,
        patch: op === 'delete' ? null : normalizeReadingPatch(entityType, wireReadingEntity(entity)),
        base: op === 'delete' ? null : base,
        createdAt: timestamp,
        attempts: 0,
        lastError: ''
    };
}

function mutationToRecord(mutation) {
    return {
        mutationId: mutation.mutationId,
        entityType: mutation.entityType,
        entityId: mutation.entityId,
        op: mutation.op,
        expectedRevision: mutation.expectedRevision,
        patch: mutation.patch,
        clientUpdatedAt: mutation.clientUpdatedAt || nowIso()
    };
}

/**
 * 寫入一個實體並同步排入 outbox（同一交易）。`existing` 由呼叫端傳入，
 * 讓函式能在交易前決定 revision / base。
 */
async function writeEntity(entityType, input, { op = 'upsert', existing = null, extraOperations = [], ctx = captureReadingContext() } = {}) {
    const storeName = storeForType(entityType);
    if (!storeName) return { ok: false, error: 'invalid_entity_type' };
    if (!isReadingContextActive(ctx)) return staleResult();
    const { entity } = buildPendingEntity(entityType, input, existing, { ctx });
    const outboxExisting = await readOutboxRecord(entityType, entity.id, ctx);
    if (!isReadingContextActive(ctx)) return staleResult();
    const outbox = buildOutboxMutation(entityType, entity, existing, op, existing, ctx, outboxExisting);
    const operations = [...extraOperations];
    if (op === 'delete') {
        operations.push({ store: storeName, type: 'put', value: { ...entity, deletedAt: entity.deletedAt || nowIso(), pending: true, dirty: true, key: recordKeyFor(entityType, entity, ctx.scope) } });
    } else {
        operations.push({ store: storeName, type: 'put', value: { ...entity, key: recordKeyFor(entityType, entity, ctx.scope) } });
    }
    operations.push({ store: STORE.READING_OUTBOX, type: 'put', value: outbox });
    const result = await applyPermanentOperations(operations);
    if (!result.ok) {
        if (result.error === 'idb_unavailable') return writeEntityFallback(entityType, entity, outbox, op, extraOperations, ctx);
        if (isReadingContextActive(ctx)) meta.persistenceError = result.error || 'idb_write_failed';
        return { ok: false, error: result.error || 'idb_write_failed' };
    }
    if (isReadingContextActive(ctx)) meta.persistenceError = '';
    const stored = { ...entity, key: recordKeyFor(entityType, entity, ctx.scope) };
    rememberEntity(entityType, stored, ctx);
    if (entityType === 'message' && isReadingContextActive(ctx)) {
        messagesByConversation.delete(`${ctx.scope}\u0000${entity.conversationId}`);
        messagesById.set(stored.id, stored);
    }
    return { ok: true, entity: stored, outbox };
}

function writeEntityFallback(entityType, entity, outbox, op, extraOperations, ctx = captureReadingContext()) {
    const bucket = readBucket(ctx.scope);
    const listName = listForBucket(entityType);
    if (!listName) return { ok: false, error: 'invalid_entity_type' };
    const stored = {
        ...entity,
        key: recordKeyFor(entityType, entity, ctx.scope),
        deletedAt: op === 'delete' ? (entity.deletedAt || nowIso()) : entity.deletedAt,
        pending: true,
        dirty: true
    };
    bucket[listName] = upsertInList(bucket[listName] || [], stored);
    bucket.outbox = (bucket.outbox || []).filter((item) => !(item.entityType === entityType && item.entityId === entity.id));
    bucket.outbox.push(outbox);
    for (const extra of extraOperations) {
        // 後備模式只支援同一種 keyed store 的 put/delete；呼叫端若需要多實體
        // 原子性，會把資料先放進 entity 的 extraRecords。
        if (extra && extra.value && extra.store === STORE.READING_ITEMS) {
            bucket.items = upsertInList(bucket.items || [], extra.value);
        }
        if (extra && extra.value && extra.store === STORE.VOCAB_ENTRIES) {
            bucket.entries = upsertInList(bucket.entries || [], extra.value);
        }
        if (extra && extra.value && extra.store === STORE.VOCAB_BOOKS) {
            bucket.books = upsertInList(bucket.books || [], extra.value);
        }
        if (extra && extra.value && extra.store === STORE.VOCAB_LINKS) {
            bucket.links = upsertInList(bucket.links || [], extra.value);
        }
    }
    if (!writeBucket(bucket, ctx.scope)) return { ok: false, error: 'storage_full' };
    // 後備寫入與 IDB 寫入一樣要讓消息快取失效：還原到空會話時，寫入前的
    // `getMessages()` 可能已快取空陣列，只更新實體 map 會讓後續核對仍讀到
    // 舊快取，成功的還原被誤判成 `message_mismatch`。
    rememberAppliedEntity(entityType, stored, ctx);
    return { ok: true, entity: stored, outbox, fallback: true };
}

/** 寫入多個實體；任何一筆失敗都會整批回滾。 */
async function writeEntitiesAtomically(entries, ctx = captureReadingContext()) {
    const operations = [];
    const remembered = [];
    const fallbackRecords = [];
    if (!isReadingContextActive(ctx)) return staleResult();
    for (const entry of entries) {
        const { entityType, input, op = 'upsert', extra = [] } = entry;
        const storeName = storeForType(entityType);
        if (!storeName) return { ok: false, error: 'invalid_entity_type' };
        const existing = entry.existing || getEntitySync(entityType, input.id);
        const { entity } = buildPendingEntity(entityType, input, existing, { ctx });
        const outboxExisting = await readOutboxRecord(entityType, entity.id, ctx);
        if (!isReadingContextActive(ctx)) return staleResult();
        const outbox = buildOutboxMutation(entityType, entity, existing, op, existing, ctx, outboxExisting);
        operations.push(...extra);
        operations.push({
            store: storeName,
            type: 'put',
            value: { ...entity, key: recordKeyFor(entityType, entity, ctx.scope), ...(op === 'delete' ? { deletedAt: entity.deletedAt || nowIso(), pending: true, dirty: true } : {}) }
        });
        operations.push({ store: STORE.READING_OUTBOX, type: 'put', value: outbox });
        const storedEntity = { ...entity, key: recordKeyFor(entityType, entity, ctx.scope) };
        remembered.push({ entityType, entity: storedEntity });
        fallbackRecords.push({ entityType, entity: storedEntity, outbox });
    }
    const result = await applyPermanentOperations(operations);
    if (!result.ok) {
        if (result.error === 'idb_unavailable') {
            // localStorage 後備必須一次寫完整個 bucket，不能逐筆假裝原子。
            const bucket = readBucket(ctx.scope);
            for (const item of fallbackRecords) {
                const listName = listForBucket(item.entityType);
                if (!listName) return { ok: false, error: 'invalid_entity_type' };
                bucket[listName] = upsertInList(bucket[listName] || [], item.entity);
                bucket.outbox = (bucket.outbox || []).filter((op) => !(op.entityType === item.entityType && op.entityId === item.entity.id));
                if (item.outbox) bucket.outbox.push(item.outbox);
            }
            if (!writeBucket(bucket, ctx.scope)) return { ok: false, error: 'storage_full' };
            for (const item of remembered) rememberAppliedEntity(item.entityType, item.entity, ctx);
            return { ok: true, fallback: true };
        }
        return { ok: false, error: result.error };
    }
    for (const item of remembered) {
        rememberEntity(item.entityType, item.entity, ctx);
        if (item.entityType === 'message' && isReadingContextActive(ctx)) {
            messagesByConversation.delete(`${ctx.scope}\u0000${item.entity.conversationId}`);
            messagesById.set(item.entity.id, item.entity);
        }
    }
    return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// 學習條目
// ─────────────────────────────────────────────────────────────────────────────

export function listLearningItems(articleId) {
    const list = Array.from(itemsById.values())
        .filter((item) => item && item.articleId === articleId)
        .sort((a, b) => {
            const av = Number(a.anchor?.start);
            const bv = Number(b.anchor?.start);
            if (av !== bv) return av - bv;
            return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
        });
    return list;
}

export function getLearningItem(itemId) {
    return itemsById.get(itemId) || null;
}

function sameRange(item, kind, anchor, contentVersion, includeDeleted = false) {
    if (!item || item.kind !== kind) return false;
    if (item.deletedAt && !includeDeleted) return false;
    if (contentVersion && item.contentVersion && item.contentVersion !== contentVersion) return false;
    const a = item.anchor || {};
    if (anchor.start >= 0 && anchor.end >= 0 && a.start >= 0 && a.end >= 0) {
        return Number(a.start) === anchor.start && Number(a.end) === anchor.end;
    }
    return String(a.quote || '') === String(anchor.quote || '')
        && String(item.sentence || '') === String(anchor.sentence || '');
}

export function findLearningItem(articleId, kind, anchor, contentVersion = '') {
    const normalized = normalizeAnchor(anchor);
    return listLearningItems(articleId).find((item) => sameRange(item, kind, normalized, contentVersion)) || null;
}

export function findSentenceItem(articleId, sentence, contentVersion = '') {
    return listLearningItems(articleId).find((item) => (
        item.kind === 'sentence'
        && !item.deletedAt
        && String(item.sentence || '') === String(sentence || '')
        && (!contentVersion || !item.contentVersion || item.contentVersion === contentVersion)
    )) || null;
}

export function findPhraseItem(articleId, quote, sentence, contentVersion = '') {
    return listLearningItems(articleId).find((item) => (
        (item.kind === 'phrase' || item.kind === 'word')
        && !item.deletedAt
        && String(item.anchor?.quote || '') === String(quote || '')
        && String(item.sentence || '') === String(sentence || '')
        && (!contentVersion || !item.contentVersion || item.contentVersion === contentVersion)
    )) || null;
}

/**
 * 只找「位置未知」（舊資料 start < 0）的條目。擁有精確 offset 的呼叫端不得
 * 用這個函式退回文字比對，否則同詞不同位置會拿到另一處的標記狀態。
 */
export function findUnpositionedItem(articleId, kind, quote, sentence = '', contentVersion = '') {
    return listLearningItems(articleId).find((item) => (
        !item.deletedAt
        && item.kind === kind
        && Number(item.anchor?.start) < 0
        && String(item.anchor?.quote || '') === String(quote || '')
        && (!sentence || String(item.sentence || '') === String(sentence || ''))
        && (!contentVersion || !item.contentVersion || item.contentVersion === contentVersion)
    )) || null;
}

export function getOccurrenceCount(articleId, quote) {
    const list = listLearningItems(articleId).filter((item) => !item.deletedAt && item.anchor?.quote === quote);
    return list.length;
}

function stableOccurrenceId(articleId, contentVersion, kind, anchor, sentence) {
    const normalized = normalizeAnchor(anchor);
    const identity = normalized.start >= 0 && normalized.end >= 0
        ? `${articleId}\u0001${contentVersion}\u0001${kind}\u0001${normalized.start}:${normalized.end}:${normalized.quote}`
        : `${articleId}\u0001${contentVersion}\u0001${kind}\u0001${normalized.quote}\u0001${sentence || ''}`;
    // 穩定 ID 讓兩個分頁在尚未看到對方寫入時，仍會落到同一個 key；
    // 這是跨分頁去重的第一道保證，交易內的讀改寫則是第二道。
    return `li_${contentVersionOf(identity)}`;
}

/** 供加入詞書等外部入口在交易前算出同一個 occurrence ID。 */
export function stableLearningItemId({ articleId = '', contentVersion = '', kind = 'word', anchor = null, sentence = '' } = {}) {
    return stableOccurrenceId(String(articleId || ''), String(contentVersion || ''), kind, anchor, sentence);
}

function learningEntityFrom(base, input, { markViewed = false, timestamp = nowIso() } = {}) {
    const explicit = normalizeReadingPatch('learningItem', input) || {};
    const anchor = explicit.anchor || base?.anchor || normalizeAnchor(input.anchor);
    const kind = explicit.kind || base?.kind || (['word', 'phrase', 'sentence'].includes(input.kind) ? input.kind : 'word');
    const contentVersion = input.contentVersion !== undefined
        ? String(input.contentVersion || '')
        : (base?.contentVersion || '');
    const entity = {
        ...(base || {}),
        ...explicit,
        id: base?.id || input.id,
        scope: base?.scope || input.scope || '',
        articleId: explicit.articleId !== undefined ? explicit.articleId : (base?.articleId || input.articleId || ''),
        contentVersion,
        kind,
        anchor,
        sentence: input.sentence !== undefined ? String(input.sentence || '') : (base?.sentence || ''),
        explanation: explicit.explanation !== undefined ? explicit.explanation : (base?.explanation ?? null),
        firstViewedAt: base?.firstViewedAt || (markViewed ? timestamp : (base?.firstViewedAt || null)),
        lastViewedAt: markViewed ? timestamp : (base?.lastViewedAt || null),
        understanding: explicit.understanding !== undefined ? explicit.understanding : (base?.understanding || 'unmarked'),
        // 查閱、AI 回應或舊資料補寫都不得改變標記；只有明確 marked 或
        // 既有布林值才保留，其他一律視為未標記。
        marked: explicit.marked !== undefined ? explicit.marked : (typeof base?.marked === 'boolean' ? base.marked : false),
        note: explicit.note !== undefined ? String(explicit.note) : (base?.note || ''),
        positionUncertain: explicit.positionUncertain !== undefined ? explicit.positionUncertain : (base?.positionUncertain === true),
        sourceContentVersion: explicit.sourceContentVersion !== undefined
            ? explicit.sourceContentVersion
            : (base?.sourceContentVersion || ''),
        createdAt: base?.createdAt || explicit.createdAt || timestamp,
        updatedAt: explicit.updatedAt || timestamp,
        deletedAt: explicit.deletedAt !== undefined ? explicit.deletedAt : (base?.deletedAt || ''),
        revision: Number(base?.revision) || 0,
        pending: true,
        dirty: true
    };
    return entity;
}

/**
 * 真正的事務內讀改寫：讀取目前持久實體、套用這次明確欄位、寫入實體與
 * outbox。兩個分頁同時編輯同一 occurrence 的不同欄位時，第二個交易會先
 * 讀到第一個已提交的內容，不會用自己過期的記憶體整筆覆蓋。
 */
async function writeLearningItemAtomic({ id, input, markViewed = false, restoreDeleted = false, restoreAfter = '', ctx }) {
    const patchFor = base => ({
        ...input,
        ...(restoreDeleted && (!base?.deletedAt || !restoreAfter || restoreAfter > base.deletedAt) ? { deletedAt: '' } : {})
    });
    const storeName = STORE.READING_ITEMS;
    const itemKey = entityKey(id, ctx.scope);
    const transaction = await runPermanentTransaction([storeName, STORE.READING_OUTBOX], 'readwrite', (stores, tx) => {
        if (!isReadingContextActive(ctx)) return { error: 'stale_scope' };
        const itemStore = stores[storeName];
        const outboxStore = stores[STORE.READING_OUTBOX];
        return new Promise((resolve, reject) => {
            const itemRequest = itemStore.get(itemKey);
            itemRequest.onerror = () => reject(itemRequest.error || new Error('idb_read_failed'));
            itemRequest.onsuccess = () => {
                const base = itemRequest.result || null;
                const entity = learningEntityFrom(base, { ...patchFor(base), id: base?.id || id }, { markViewed });
                entity.scope = ctx.scope;
                const outboxRequest = outboxStore.get(outboxKey('learningItem', entity.id, ctx.scope));
                outboxRequest.onerror = () => reject(outboxRequest.error || new Error('outbox_read_failed'));
                outboxRequest.onsuccess = () => {
                    try {
                        const previousOutbox = outboxRequest.result || null;
                        const outbox = buildOutboxMutation('learningItem', entity, base, entity.deletedAt ? 'delete' : 'upsert', base, ctx, previousOutbox);
                        itemStore.put({ ...entity, key: entityKey(entity.id, ctx.scope) });
                        outboxStore.put(outbox);
                        resolve({ entity, outbox, created: !base });
                    } catch (error) {
                        try { tx.abort(); } catch (_) {}
                        reject(error);
                    }
                };
            };
        });
    });
    if (!transaction.ok) {
        if (transaction.error === 'idb_unavailable') {
            // 後備模式仍以「整桶一次寫入」維持實體＋outbox 的原子性。
            const bucket = readBucket(ctx.scope);
            const hint = (bucket.items || []).find(item => item.id === id) || getLearningItem(id);
            const entity = learningEntityFrom(hint, { ...patchFor(hint), id: hint?.id || id }, { markViewed });
            entity.scope = ctx.scope;
            const previous = (bucket.outbox || []).find(op => op.entityType === 'learningItem' && op.entityId === id) || null;
            const outbox = buildOutboxMutation('learningItem', entity, hint, entity.deletedAt ? 'delete' : 'upsert', hint, ctx, previous);
            return writeEntityFallback('learningItem', entity, outbox, 'upsert', [], ctx);
        }
        if (isReadingContextActive(ctx)) meta.persistenceError = transaction.error || 'idb_write_failed';
        return { ok: false, error: transaction.error || 'idb_write_failed' };
    }
    const value = transaction.value || {};
    if (value.error) return { ok: false, error: value.error };
    if (!value.entity) return { ok: false, error: 'atomic_missing_entity', detail: JSON.stringify(transaction) };
    const stored = { ...value.entity, key: entityKey(value.entity.id, ctx.scope) };
    if (isReadingContextActive(ctx)) meta.persistenceError = '';
    rememberEntity('learningItem', stored, ctx);
    return { ok: true, entity: stored, outbox: value.outbox };
}

/** 舊三態或詞書關聯只用來決定「缺少 marked 的舊記錄」一次；明確 false 優先。 */
function legacyMarkedFor(item, hasVocabularyLink) {
    if (typeof item?.marked === 'boolean') return item.marked;
    if (item?.understanding === 'needs_review' || item?.understanding === 'understood') return true;
    if (hasVocabularyLink) return true;
    return false;
}

/**
 * 在真實交易內補 marked：先讀最新條目與有效詞書關聯，只有仍是缺欄位時才寫。
 * 兩個分頁同時載入舊文章時，後到的交易會看到第一個已寫入的布林值而跳過，
 * 不會把使用者剛取消的標記重新打開。
 */
function migrateLearningItemMarkedFallback(itemId, ctx) {
    if (!isReadingContextActive(ctx)) return staleResult();
    const read = readBucketStrict(ctx.scope);
    if (!read.ok) return read;
    const bucket = read.bucket;
    const base = (bucket.items || []).find(item => item && item.scope === ctx.scope && item.id === itemId);
    if (!base || base.deletedAt || typeof base.marked === 'boolean') return { ok: true, migrated: false };
    const linked = (bucket.links || []).some(link => link && link.scope === ctx.scope
        && link.itemId === itemId && !link.deletedAt && !link.removedAt);
    const entity = learningEntityFrom(base, { id: base.id, marked: legacyMarkedFor(base, linked) });
    const previous = (bucket.outbox || []).find(op => op && op.scope === ctx.scope
        && op.entityType === 'learningItem' && op.entityId === itemId) || null;
    const outbox = buildOutboxMutation('learningItem', entity, base, 'upsert', base, ctx, previous);
    const stored = { ...entity, key: entityKey(itemId, ctx.scope) };
    bucket.items = bucket.items.map(item => item === base ? stored : item);
    bucket.outbox = (bucket.outbox || []).filter(op => !(op && op.scope === ctx.scope
        && op.entityType === 'learningItem' && op.entityId === itemId));
    bucket.outbox.push(outbox);
    if (!isReadingContextActive(ctx)) return staleResult();
    if (!writeBucket(bucket, ctx.scope)) return { ok: false, error: 'storage_full' };
    rememberEntity('learningItem', stored, ctx);
    return { ok: true, migrated: true };
}

async function migrateLearningItemMarkedAtomic(itemId, ctx) {
    if (!isReadingContextActive(ctx)) return staleResult();
    if (fallbackMode) return migrateLearningItemMarkedFallback(itemId, ctx);
    const transaction = await runPermanentTransaction(
        [STORE.READING_ITEMS, STORE.VOCAB_LINKS, STORE.READING_OUTBOX],
        'readwrite',
        (stores, tx) => new Promise((resolve, reject) => {
            if (!isReadingContextActive(ctx)) { resolve({ error: 'stale_scope' }); return; }
            const itemStore = stores[STORE.READING_ITEMS];
            const linkStore = stores[STORE.VOCAB_LINKS];
            const outboxStore = stores[STORE.READING_OUTBOX];
            const itemRequest = itemStore.get(entityKey(itemId, ctx.scope));
            itemRequest.onerror = () => reject(itemRequest.error || new Error('idb_read_failed'));
            itemRequest.onsuccess = () => {
                if (!isReadingContextActive(ctx)) { resolve({ error: 'stale_scope' }); return; }
                const base = itemRequest.result || null;
                if (!base || base.deletedAt) { resolve({ migrated: false, missing: true }); return; }
                if (typeof base.marked === 'boolean') { resolve({ migrated: false, already: true }); return; }
                const linksRequest = linkStore.indexNames.contains('scope_item')
                    ? linkStore.index('scope_item').getAll([ctx.scope, itemId])
                    : linkStore.getAll();
                linksRequest.onerror = () => reject(linksRequest.error || new Error('idb_read_failed'));
                linksRequest.onsuccess = () => {
                    if (!isReadingContextActive(ctx)) { resolve({ error: 'stale_scope' }); return; }
                    const links = (linksRequest.result || []).filter((link) => link
                        && link.scope === ctx.scope && link.itemId === itemId
                        && !link.deletedAt && !link.removedAt);
                    try {
                        const entity = learningEntityFrom(base, {
                            id: base.id,
                            marked: legacyMarkedFor(base, links.length > 0)
                        }, {});
                        entity.scope = ctx.scope;
                        const outboxRequest = outboxStore.get(outboxKey('learningItem', entity.id, ctx.scope));
                        outboxRequest.onerror = () => reject(outboxRequest.error || new Error('outbox_read_failed'));
                        outboxRequest.onsuccess = () => {
                            if (!isReadingContextActive(ctx)) { resolve({ error: 'stale_scope' }); return; }
                            try {
                                const previousOutbox = outboxRequest.result || null;
                                const outbox = buildOutboxMutation('learningItem', entity, base, 'upsert', base, ctx, previousOutbox);
                                itemStore.put({ ...entity, key: entityKey(entity.id, ctx.scope) });
                                outboxStore.put(outbox);
                                resolve({ migrated: true, item: entity });
                            } catch (error) {
                                try { tx.abort(); } catch (_) {}
                                reject(error);
                            }
                        };
                    } catch (error) {
                        try { tx.abort(); } catch (_) {}
                        reject(error);
                    }
                };
            };
        })
    );
    if (!isReadingContextActive(ctx)) return staleResult();
    if (!transaction.ok) {
        if (transaction.error === 'idb_unavailable') return migrateLearningItemMarkedFallback(itemId, ctx);
        meta.persistenceError = transaction.error || 'idb_write_failed';
        return { ok: false, error: transaction.error || 'idb_write_failed' };
    }
    const value = transaction.value || {};
    if (value.error) return { ok: false, error: value.error };
    if (value.item) {
        rememberEntity('learningItem', { ...value.item, key: entityKey(value.item.id, ctx.scope) }, ctx);
    }
    return { ok: true, migrated: !!value.migrated };
}

async function migrateArticleMarkedItems(articleId, ctx) {
    if (!articleId || !isReadingContextActive(ctx)) return { ok: true, migrated: 0 };
    const candidates = listLearningItems(articleId)
        .filter((item) => item && !item.deletedAt && typeof item.marked !== 'boolean');
    let migrated = 0;
    for (const item of candidates) {
        if (!isReadingContextActive(ctx)) return staleResult();
        const result = await migrateLearningItemMarkedAtomic(item.id, ctx);
        if (!isReadingContextActive(ctx)) return staleResult();
        if (result.ok === false) return result;
        if (result.migrated) migrated += 1;
    }
    if (migrated) emitChange({ articleId, reason: 'marked-migrated', ctx });
    return { ok: true, migrated };
}

/**
 * 建立或更新同一文章版本＋類型＋引用範圍的學習條目。
 * `markViewed` 只在解釋真的呈現給使用者時為 true；舊資料匯入一律 false。
 */
async function upsertLearningItemInner(input, options, ctx) {
    if (!input || !input.articleId) return { ok: false, error: 'article_required' };
    if (!articleStore.getRecord(input.articleId)) return { ok: false, error: 'stale_scope' };
    const kind = ['word', 'phrase', 'sentence'].includes(input.kind) ? input.kind : 'word';
    const anchor = normalizeAnchor(input.anchor);
    if (!anchor.quote && !input.sentence) return { ok: false, error: 'anchor_required' };
    const contentVersion = String(input.contentVersion || '');
    const loaded = await ensureArticleReadingLoaded(input.articleId, ctx);
    if (!loaded.ok) return loaded;
    let existing = findLearningItem(input.articleId, kind, anchor, contentVersion)
        || listLearningItems(input.articleId).find(item => item.deletedAt
            && sameRange(item, kind, { ...anchor, sentence: input.sentence || '' }, contentVersion, true));
    if (!existing && anchor.start < 0) {
        existing = listLearningItems(input.articleId).find((item) => item.kind === kind
            && String(item.anchor?.quote || '') === anchor.quote
            && String(item.sentence || '') === String(input.sentence || '')
            && (!contentVersion || !item.contentVersion || item.contentVersion === contentVersion)) || null;
    }
    const stableId = stableOccurrenceId(input.articleId, contentVersion || existing?.contentVersion || '', kind, anchor, input.sentence || existing?.sentence || '');
    const id = existing?.id || input.id || stableId;
    const result = await writeLearningItemAtomic({
        id,
        input: {
            ...input,
            articleId: input.articleId,
            contentVersion,
            kind,
            anchor
        },
        markViewed: options.markViewed === true,
        restoreDeleted: options.restoreDeleted === true,
        restoreAfter: options.restoreAfter || '',
        ctx
    });
    if (result.ok && isReadingContextActive(ctx)) {
        emitChange({ articleId: result.entity.articleId, entityType: 'learningItem', entityId: result.entity.id, ctx });
    }
    return result;
}

async function markLearningItemViewedInner(itemId, explanation, ctx) {
    const existing = getLearningItem(itemId);
    if (!existing) return { ok: false, error: 'not_found' };
    const input = { id: itemId, articleId: existing.articleId };
    if (explanation !== undefined) input.explanation = explanation;
    const result = await writeLearningItemAtomic({ id: itemId, input, markViewed: true, ctx });
    if (result.ok && isReadingContextActive(ctx)) {
        emitChange({ articleId: result.entity.articleId, entityType: 'learningItem', entityId: result.entity.id, ctx });
    }
    return result;
}

async function patchLearningItemInner(itemId, patch, ctx) {
    const existing = getLearningItem(itemId);
    if (!existing) return { ok: false, error: 'not_found' };
    const result = await writeLearningItemAtomic({ id: itemId, input: { id: itemId, ...patch }, ctx });
    if (result.ok && isReadingContextActive(ctx)) {
        emitChange({ articleId: result.entity.articleId, entityType: 'learningItem', entityId: result.entity.id, ctx });
    }
    return result;
}

async function updateLearningItemPositionInner(itemId, { anchor, sentence, contentVersion, positionUncertain = false }, ctx) {
    const existing = getLearningItem(itemId);
    if (!existing) return { ok: false, error: 'not_found' };
    const input = {
        id: itemId,
        anchor: normalizeAnchor(anchor),
        positionUncertain: positionUncertain === true
    };
    if (sentence !== undefined) input.sentence = String(sentence);
    if (contentVersion) input.contentVersion = contentVersion;
    const result = await writeLearningItemAtomic({ id: itemId, input, ctx });
    if (result.ok && isReadingContextActive(ctx)) {
        emitChange({ articleId: result.entity.articleId, entityType: 'learningItem', entityId: result.entity.id, ctx });
    }
    return result;
}

async function deleteLearningItemInner(itemId, ctx) {
    const existing = getLearningItem(itemId);
    if (!existing) return { ok: false, error: 'not_found' };
    const timestamp = nowIso();
    const result = await writeLearningItemAtomic({
        id: itemId,
        input: { id: itemId, deletedAt: timestamp, updatedAt: timestamp },
        ctx
    });
    if (result.ok && isReadingContextActive(ctx)) {
        emitChange({ articleId: result.entity.articleId, entityType: 'learningItem', entityId: result.entity.id, ctx });
    }
    return result;
}

export function upsertLearningItem(input, options = {}) {
    return runCaptured((ctx) => upsertLearningItemInner(input, options, ctx));
}

export function markLearningItemViewed(itemId, explanation = undefined) {
    return runCaptured((ctx) => markLearningItemViewedInner(itemId, explanation, ctx));
}

export function patchLearningItem(itemId, patch = {}) {
    return runCaptured((ctx) => patchLearningItemInner(itemId, patch, ctx));
}

export function updateLearningItemPosition(itemId, position) {
    return runCaptured((ctx) => updateLearningItemPositionInner(itemId, position, ctx));
}

export function deleteLearningItem(itemId) {
    return runCaptured((ctx) => deleteLearningItemInner(itemId, ctx));
}

/** 撤銷須在同一交易核對最新墓碑，不能只相信本分頁的記憶體版本。 */
async function restoreDeletedEntity(entityType, id, expectedDeletedAt, ctx) {
    const storeName = storeForType(entityType);
    const restore = (base, previousOutbox) => {
        if (!base?.deletedAt) return { error: 'not_deleted' };
        if (base.deletedAt !== expectedDeletedAt) return { error: 'stale_delete' };
        const entity = buildPendingEntity(entityType, { id, deletedAt: '', updatedAt: nowIso() }, base, { ctx }).entity;
        const outbox = buildOutboxMutation(entityType, entity, base, 'upsert', base, ctx, previousOutbox);
        return { entity, outbox };
    };
    const transaction = await runPermanentTransaction([storeName, STORE.READING_OUTBOX], 'readwrite', stores => {
        if (!isReadingContextActive(ctx)) return { error: 'stale_scope' };
        return new Promise((resolve, reject) => {
            const request = stores[storeName].get(entityKey(id, ctx.scope));
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const base = request.result;
                const pending = stores[STORE.READING_OUTBOX].get(outboxKey(entityType, id, ctx.scope));
                pending.onerror = () => reject(pending.error);
                pending.onsuccess = () => {
                    const result = restore(base, pending.result || null);
                    if (result.entity) {
                        stores[storeName].put({ ...result.entity, key: entityKey(id, ctx.scope) });
                        stores[STORE.READING_OUTBOX].put(result.outbox);
                    }
                    resolve(result);
                };
            };
        });
    });
    if (!transaction.ok) {
        if (transaction.error !== 'idb_unavailable') return { ok: false, error: transaction.error };
        if (!isReadingContextActive(ctx)) return staleResult();
        const bucket = readBucket(ctx.scope);
        const base = (bucket[listForBucket(entityType)] || []).find(entity => entity.id === id);
        const previous = (bucket.outbox || []).find(op => op.entityType === entityType && op.entityId === id);
        const result = restore(base, previous || null);
        if (result.error) return { ok: false, error: result.error };
        return writeEntityFallback(entityType, result.entity, result.outbox, 'upsert', [], ctx);
    }
    const result = transaction.value;
    if (!result?.entity) return { ok: false, error: result?.error || 'restore_failed' };
    rememberEntity(entityType, { ...result.entity, key: entityKey(id, ctx.scope) }, ctx);
    return { ok: true, ...result };
}

export function restoreLearningItem(itemId, expectedDeletedAt) {
    return runCaptured(async ctx => {
        const result = await restoreDeletedEntity('learningItem', itemId, expectedDeletedAt, ctx);
        if (result.ok) emitChange({ articleId: result.entity.articleId, entityType: 'learningItem', entityId: itemId, ctx });
        return result;
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// 詞書／詞條／來源關聯
// ─────────────────────────────────────────────────────────────────────────────

export function listVocabularyBooks() {
    return Array.from(booksById.values()).filter((book) => book && !book.deletedAt);
}

export function listVocabularyEntries(bookId = '') {
    return Array.from(entriesById.values()).filter((entry) => entry && !entry.deletedAt && (!bookId || entry.bookId === bookId));
}

export function listVocabularyLinks({ itemId = '', entryId = '' } = {}) {
    return Array.from(linksById.values()).filter((link) => {
        if (!link || link.deletedAt || link.removedAt) return false;
        if (itemId && link.itemId !== itemId) return false;
        if (entryId && link.entryId !== entryId) return false;
        return true;
    });
}

export function isItemSaved(itemId) {
    return listVocabularyLinks({ itemId }).length > 0;
}

export function getVocabularyEntry(entryId) {
    return entriesById.get(entryId) || null;
}

export function getVocabularyBook(bookId) {
    return booksById.get(bookId) || null;
}

export function upsertVocabularyBook(book) {
    return runCaptured(async (ctx) => {
    const existing = booksById.get(book.id) || null;
    const result = await writeEntity('vocabularyBook', book, { existing, ctx });
    if (result.ok) emitChange({ entityType: 'vocabularyBook', entityId: book.id, ctx });
    return result;
    });
}

export function upsertVocabularyEntry(entry) {
    return runCaptured(async (ctx) => {
    const existing = entriesById.get(entry.id) || null;
    const result = await writeEntity('vocabularyEntry', entry, { existing, ctx });
    if (result.ok) emitChange({ entityType: 'vocabularyEntry', entityId: entry.id, ctx });
    return result;
    });
}

export function addVocabularyLink(link) {
    return runCaptured(async (ctx) => {
    const id = link.id || generateReadingId('vl');
    const existing = linksById.get(id) || null;
    const record = { ...link, id, addedAt: link.addedAt || nowIso() };
    const result = await writeEntity('vocabularyLink', record, { existing, ctx });
    if (result.ok) emitChange({ entityType: 'vocabularyLink', entityId: id, ctx });
    return result;
    });
}

export function removeVocabularyLink(linkId) {
    return runCaptured(async (ctx) => {
    const existing = linksById.get(linkId);
    if (!existing) return { ok: false, error: 'not_found' };
    const record = { ...existing, removedAt: nowIso(), updatedAt: nowIso() };
    const result = await writeEntity('vocabularyLink', record, { existing, ctx });
    if (result.ok) emitChange({ entityType: 'vocabularyLink', entityId: linkId, ctx });
    return result;
    });
}

export function removeVocabularyEntry(entryId) {
    return runCaptured(async (ctx) => {
    const entry = entriesById.get(entryId);
    if (!entry) return { ok: false, error: 'not_found' };
    const timestamp = nowIso();
    const links = listVocabularyLinks({ entryId });
    const entries = [{ entityType: 'vocabularyEntry', input: { ...entry, deletedAt: timestamp, updatedAt: timestamp }, op: 'delete', existing: entry }];
    for (const link of links) {
        entries.push({
            entityType: 'vocabularyLink',
            input: { ...link, removedAt: timestamp, updatedAt: timestamp },
            existing: link,
            op: 'upsert'
        });
    }
    const result = await writeEntitiesAtomically(entries, ctx);
    if (result.ok) emitChange({ entityType: 'vocabularyEntry', entityId: entryId, ctx });
    return result;
    });
}

/**
 * 新增詞條＋來源關聯（可同時建立學習條目），整批同交易提交。
 * 這是文章「加入詞書」的主路徑：先保存，再背景補 AI 解釋。
 */
function mergeVocabularySources(existingSources, incomingSources) {
    const sources = Array.isArray(existingSources) ? existingSources.map((source) => ({ ...source })) : [];
    for (const source of Array.isArray(incomingSources) ? incomingSources : []) {
        if (!source) continue;
        const exists = sources.some((item) => item
            && item.articleId === source.articleId
            && item.sentence === source.sentence
            && item.anchor?.start === source.anchor?.start
            && item.anchor?.quote === source.anchor?.quote);
        if (!exists) sources.push({ ...source });
    }
    return sources;
}

function linkInputForTransaction(entry, item, link, ctx) {
    return {
        ...normalizeReadingPatch('vocabularyLink', {
            ...link,
            itemId: item?.id || link.itemId,
            entryId: entry?.id || link.entryId,
            bookId: entry?.bookId || link.bookId
        }),
        id: link.id,
        scope: ctx.scope,
        key: entityKey(link.id, ctx.scope),
        pending: true,
        dirty: true
    };
}

/**
 * 新增詞條＋來源關聯＋標記，全部在同一個讀改寫交易完成。
 *
 * 關鍵：學習條目以交易內讀到的最新版本為 base，只補 marked: true、缺少的
 * 精確位置或解釋；絕不用呼叫端記憶體整筆覆蓋另一個分頁剛寫入的筆記。
 */
async function addVocabularyEntryWithLinkInner({ book, entry, item = null, link = null }, ctx) {
    if (!book || !entry || !entry.id) return { ok: false, error: 'invalid_vocabulary' };
    const articleId = item?.articleId || entry?.sourceArticleId || '';
    if (articleId && !articleStore.getRecord(articleId)) return { ok: false, error: 'stale_scope' };
    if (item?.articleId) {
        const loaded = await ensureArticleReadingLoaded(item.articleId, ctx);
        if (!loaded.ok) return loaded;
    }
    const transaction = await runPermanentTransaction([
        STORE.READING_ITEMS, STORE.VOCAB_BOOKS, STORE.VOCAB_ENTRIES, STORE.VOCAB_LINKS, STORE.READING_OUTBOX
    ], 'readwrite', (stores, tx) => new Promise((resolve, reject) => {
        const specs = [];
        if (book?.id) {
            specs.push({ name: 'book', store: STORE.VOCAB_BOOKS, key: entityKey(book.id, ctx.scope) });
            specs.push({ name: 'bookOutbox', store: STORE.READING_OUTBOX, key: outboxKey('vocabularyBook', book.id, ctx.scope) });
        }
        if (entry?.id) {
            specs.push({ name: 'entry', store: STORE.VOCAB_ENTRIES, key: entityKey(entry.id, ctx.scope) });
            specs.push({ name: 'entryOutbox', store: STORE.READING_OUTBOX, key: outboxKey('vocabularyEntry', entry.id, ctx.scope) });
        }
        const linkedItemId = item?.id || (link && link.itemId) || '';
        if (linkedItemId) {
            specs.push({ name: 'item', store: STORE.READING_ITEMS, key: entityKey(linkedItemId, ctx.scope) });
            specs.push({ name: 'itemOutbox', store: STORE.READING_OUTBOX, key: outboxKey('learningItem', linkedItemId, ctx.scope) });
        }
        if (link?.id) {
            specs.push({ name: 'link', store: STORE.VOCAB_LINKS, key: entityKey(link.id, ctx.scope) });
            specs.push({ name: 'linkOutbox', store: STORE.READING_OUTBOX, key: outboxKey('vocabularyLink', link.id, ctx.scope) });
        }
        const results = {};
        let remaining = specs.length;
        const fail = (error) => {
            try { tx.abort(); } catch (_) {}
            reject(error);
        };
        const finish = () => {
            try {
                const timestamp = nowIso();
                const operations = [];
                let bookEntity = null;
                if (book?.id) {
                    bookEntity = results.book || {
                        id: book.id,
                        name: book.name || '',
                        sourceType: book.sourceType || 'article',
                        articleId: book.articleId || '',
                        sourceUrl: book.sourceUrl || '',
                        shareId: book.shareId || '',
                        createdAt: book.createdAt || timestamp,
                        deletedAt: '',
                        revision: 0,
                        scope: ctx.scope,
                        key: entityKey(book.id, ctx.scope),
                        updatedAt: timestamp,
                        pending: true,
                        dirty: true
                    };
                    if (!results.book) {
                        operations.push({ store: STORE.VOCAB_BOOKS, value: bookEntity });
                        operations.push({
                            store: STORE.READING_OUTBOX,
                            value: buildOutboxMutation('vocabularyBook', bookEntity, null, 'upsert', null, ctx, results.bookOutbox || null)
                        });
                    }
                }
                let entryEntity = null;
                if (entry?.id) {
                    const existing = results.entry || null;
                    const incoming = { ...entry, id: entry.id, bookId: entry.bookId || book?.id || existing?.bookId || '' };
                    entryEntity = {
                        ...(existing || {}),
                        ...incoming,
                        id: entry.id,
                        scope: ctx.scope,
                        key: entityKey(entry.id, ctx.scope),
                        examples: Array.isArray(incoming.examples) ? incoming.examples : (existing?.examples || []),
                        sources: mergeVocabularySources(existing?.sources, incoming.sources),
                        addedAt: existing?.addedAt || incoming.addedAt || timestamp,
                        createdAt: existing?.createdAt || incoming.createdAt || timestamp,
                        updatedAt: timestamp,
                        deletedAt: '',
                        revision: Number(existing?.revision) || 0,
                        pending: true,
                        dirty: true
                    };
                    // 空白的提示值不得蓋掉另一分頁已補齊的詞義／音標。
                    if (!incoming.meaning && existing?.meaning) entryEntity.meaning = existing.meaning;
                    if (!incoming.phonetic && existing?.phonetic) entryEntity.phonetic = existing.phonetic;
                    if (!incoming.pos && existing?.pos) entryEntity.pos = existing.pos;
                    operations.push({ store: STORE.VOCAB_ENTRIES, value: entryEntity });
                    operations.push({
                        store: STORE.READING_OUTBOX,
                        value: buildOutboxMutation('vocabularyEntry', entryEntity, existing, 'upsert', existing, ctx, results.entryOutbox || null)
                    });
                }
                let itemEntity = null;
                const linkedItemId = item?.id || (link && link.itemId) || '';
                if (linkedItemId) {
                    const base = results.item || null;
                    if (base) {
                        // 交易內讀到的最新條目才是權威：加入詞書只明確設定
                        // marked，其他筆記／狀態欄位保留另一個分頁剛寫入的值。
                        const patch = { id: base.id, marked: true };
                        if (item) {
                            if (base.explanation === null || base.explanation === undefined) {
                                if (item.explanation) patch.explanation = item.explanation;
                            }
                            if (!String(base.sentence || '').trim() && item.sentence) patch.sentence = item.sentence;
                            const baseStart = Number(base.anchor?.start);
                            const incomingStart = Number(item.anchor?.start);
                            if ((!base.anchor || baseStart < 0) && item.anchor && incomingStart >= 0) {
                                patch.anchor = normalizeAnchor(item.anchor);
                                patch.positionUncertain = false;
                                if (item.contentVersion) patch.contentVersion = item.contentVersion;
                            }
                        }
                        itemEntity = learningEntityFrom(base, patch, {});
                    } else if (item?.id && item.articleId) {
                        itemEntity = learningEntityFrom(null, { ...item, marked: true }, {});
                    }
                    if (itemEntity) {
                        itemEntity.scope = ctx.scope;
                        itemEntity.marked = true;
                        operations.push({ store: STORE.READING_ITEMS, value: { ...itemEntity, key: entityKey(itemEntity.id, ctx.scope) } });
                        operations.push({
                            store: STORE.READING_OUTBOX,
                            value: buildOutboxMutation('learningItem', itemEntity, base, 'upsert', base, ctx, results.itemOutbox || null)
                        });
                    }
                }
                let linkEntity = null;
                if (link?.id && itemEntity) {
                    const existing = results.link || null;
                    linkEntity = {
                        ...(existing || {}),
                        ...linkInputForTransaction(entryEntity || entry, itemEntity, link, ctx),
                        addedAt: existing?.addedAt || link.addedAt || timestamp,
                        removedAt: '',
                        updatedAt: timestamp,
                        deletedAt: '',
                        revision: Number(existing?.revision) || 0
                    };
                    operations.push({ store: STORE.VOCAB_LINKS, value: linkEntity });
                    operations.push({
                        store: STORE.READING_OUTBOX,
                        value: buildOutboxMutation('vocabularyLink', linkEntity, existing, 'upsert', existing, ctx, results.linkOutbox || null)
                    });
                }
                for (const operation of operations) stores[operation.store].put(operation.value);
                resolve({ bookEntity, entryEntity, linkEntity, itemEntity });
            } catch (error) {
                fail(error);
            }
        };
        if (!specs.length) { finish(); return; }
        for (const spec of specs) {
            let request;
            try { request = stores[spec.store].get(spec.key); } catch (error) { fail(error); return; }
            request.onerror = () => fail(request.error || new Error('idb_read_failed'));
            request.onsuccess = () => {
                results[spec.name] = request.result || null;
                remaining -= 1;
                if (remaining === 0) finish();
            };
        }
    }));
    if (!transaction.ok) {
        if (transaction.error !== 'idb_unavailable') return { ok: false, error: transaction.error || 'idb_write_failed' };
        // localStorage 後備沒有跨分頁交易，但仍一次性寫完整個 bucket。
        const existingItem = item?.id ? (findLearningItem(item.articleId, item.kind, item.anchor || {}, item.contentVersion) || itemsById.get(item.id)) : null;
        const itemInput = item ? {
            id: item.id,
            articleId: item.articleId,
            contentVersion: item.contentVersion,
            kind: item.kind,
            anchor: item.anchor,
            sentence: item.sentence,
            explanation: item.explanation,
            createdAt: item.createdAt,
            marked: true
        } : null;
        const entries = [];
        if (!booksById.has(book.id)) entries.push({ entityType: 'vocabularyBook', input: book, existing: null });
        if (itemInput) entries.push({ entityType: 'learningItem', input: itemInput, existing: existingItem });
        entries.push({ entityType: 'vocabularyEntry', input: entry, existing: entriesById.get(entry.id) || null });
        if (link) entries.push({ entityType: 'vocabularyLink', input: link, existing: linksById.get(link.id) || null });
        const fallback = await writeEntitiesAtomically(entries, ctx);
        if (fallback.ok && itemInput) {
            const saved = itemsById.get(itemInput.id);
            if (saved) saved.marked = true;
        }
        if (fallback.ok) emitChange({ entityType: 'vocabularyEntry', entityId: entry.id, articleId: item?.articleId || '', ctx });
        return fallback;
    }
    const value = transaction.value || {};
    for (const [entityType, entity] of [
        ['vocabularyBook', value.bookEntity],
        ['vocabularyEntry', value.entryEntity],
        ['learningItem', value.itemEntity],
        ['vocabularyLink', value.linkEntity]
    ]) {
        if (!entity) continue;
        rememberEntity(entityType, { ...entity, key: entityKey(entity.id, ctx.scope) }, ctx);
    }
    emitChange({ entityType: 'vocabularyEntry', entityId: entry.id, articleId: item?.articleId || '', ctx });
    return {
        ok: true,
        book: value.bookEntity,
        entry: value.entryEntity,
        item: value.itemEntity,
        link: value.linkEntity,
        linkId: value.linkEntity?.id || '',
        itemId: value.itemEntity?.id || ''
    };
}

export function addVocabularyEntryWithLink(payload) {
    return runCaptured((ctx) => addVocabularyEntryWithLinkInner(payload, ctx));
}

/**
 * 以記憶體中的詞書（UI 目前格式）同步永久詞書層。
 * 供 `modules/storage.js` 的既有同步 API 使用；一般新增文章詞條走上面的
 * addVocabularyEntryWithLink，兩者最終都寫同一個永久來源。
 */
export function syncVocabularyFromMemory(books, options = {}) {
    return runCaptured(async (ctx) => {
    const list = Array.isArray(books) ? books : [];
    const entries = [];
    const seenBooks = new Set();
    const seenEntries = new Set();
    const timestamp = nowIso();
    for (const book of list) {
        if (!book || !book.id) continue;
        seenBooks.add(book.id);
        const existingBook = booksById.get(book.id) || null;
        const nextBook = {
            ...(existingBook || {}),
            id: book.id,
            name: book.name || '',
            sourceType: book.sourceType || 'legacy',
            articleId: book.articleId || '',
            sourceUrl: book.sourceUrl || existingBook?.sourceUrl || '',
            shareId: book.shareId || existingBook?.shareId || '',
            createdAt: existingBook?.createdAt || book.createdAt || timestamp,
            updatedAt: timestamp
        };
        if (!existingBook || existingBook.name !== nextBook.name || existingBook.sourceType !== nextBook.sourceType) {
            entries.push({ entityType: 'vocabularyBook', input: nextBook, existing: existingBook });
        }
        const words = Array.isArray(book.words) ? book.words : [];
        for (const word of words) {
            if (!word || !word.id) continue;
            seenEntries.add(word.id);
            const existingEntry = entriesById.get(word.id) || null;
            const nextEntry = {
                ...existingEntry,
                ...word,
                id: word.id,
                bookId: book.id,
                examples: Array.isArray(word.examples) ? word.examples : [],
                sources: Array.isArray(word.sources) ? word.sources : (existingEntry?.sources || []),
                createdAt: existingEntry?.createdAt || word.addedAt || timestamp,
                updatedAt: timestamp
            };
            if (!existingEntry || JSON.stringify(wireReadingEntity(existingEntry)) !== JSON.stringify(wireReadingEntity(nextEntry))) {
                entries.push({ entityType: 'vocabularyEntry', input: nextEntry, existing: existingEntry });
            }
        }
    }
    if (options.prune !== false) {
        for (const book of booksById.values()) {
            if (!book.deletedAt && !seenBooks.has(book.id)) {
                entries.push({ entityType: 'vocabularyBook', input: { ...book, deletedAt: timestamp, updatedAt: timestamp }, existing: book, op: 'delete' });
            }
        }
        for (const entry of entriesById.values()) {
            if (!entry.deletedAt && !seenEntries.has(entry.id)) {
                entries.push({ entityType: 'vocabularyEntry', input: { ...entry, deletedAt: timestamp, updatedAt: timestamp }, existing: entry, op: 'delete' });
            }
        }
    }
    if (!entries.length) return { ok: true, changed: 0 };
    const result = await writeEntitiesAtomically(entries, ctx);
    if (result.ok) emitChange({ entityType: 'vocabularyBook', entityId: '', ctx });
    return { ...result, changed: entries.length };
    });
}

/** 把永久詞書轉回功能層目前使用的 `vocabularyBooks` 形狀。 */
export function vocabularyBooksForUi() {
    return listVocabularyBooks().map((book) => ({
        ...book,
        words: listVocabularyEntries(book.id).map((entry) => {
            const out = { ...entry };
            delete out.scope;
            delete out.key;
            delete out.pending;
            delete out.dirty;
            delete out.updatedAt;
            delete out.deletedAt;
            delete out.revision;
            return out;
        })
    }));
}

// ─────────────────────────────────────────────────────────────────────────────
// 文章文件
// ─────────────────────────────────────────────────────────────────────────────

export function listArticleDocuments(articleId = '', { withContent = false } = {}) {
    return Array.from(documentsById.values())
        .filter((doc) => doc && !doc.deletedAt && (!articleId || doc.articleId === articleId))
        .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
        .map((doc) => (withContent ? { ...doc } : { ...doc, content: '' }));
}

export function getArticleDocument(docId, { withContent = true } = {}) {
    const doc = documentsById.get(docId);
    if (!doc) return null;
    return withContent ? { ...doc } : { ...doc, content: '' };
}

export function saveArticleDocument(input) {
    return runCaptured(async (ctx) => {
    if (input.articleId && !articleStore.getRecord(input.articleId)) return { ok: false, error: 'stale_scope' };
    if (input.articleId) {
        const loaded = await ensureArticleReadingLoaded(input.articleId, ctx);
        if (!loaded.ok) return loaded;
    }
    const existing = input.id ? documentsById.get(input.id) : null;
    const timestamp = nowIso();
    const doc = {
        id: input.id || generateReadingId('doc'),
        articleId: input.articleId || '',
        kind: input.kind === 'ai' ? 'ai' : 'note',
        title: String(input.title || '').slice(0, READING_LIMITS.maxTitleChars),
        content: String(input.content || ''),
        sourceItemIds: Array.isArray(input.sourceItemIds) ? input.sourceItemIds : [],
        sourceMessageIds: Array.isArray(input.sourceMessageIds) ? input.sourceMessageIds : [],
        contentVersion: input.contentVersion || '',
        createdAt: existing?.createdAt || input.createdAt || timestamp,
        updatedAt: timestamp,
        deletedAt: '',
        revision: Number(existing?.revision) || 0
    };
    if (doc.content.length > READING_LIMITS.maxDocumentChars) return { ok: false, error: 'document_too_large' };
    const result = await writeEntity('articleDocument', doc, { existing, ctx });
    if (result.ok) emitChange({ articleId: doc.articleId, entityType: 'articleDocument', entityId: doc.id, ctx });
    return result;
    });
}

export function deleteArticleDocument(docId) {
    return runCaptured(async (ctx) => {
    const existing = documentsById.get(docId);
    if (!existing) return { ok: false, error: 'not_found' };
    const doc = { ...existing, deletedAt: nowIso(), updatedAt: nowIso() };
    const result = await writeEntity('articleDocument', doc, { existing, op: 'delete', ctx });
    if (result.ok) emitChange({ articleId: doc.articleId, entityType: 'articleDocument', entityId: doc.id, ctx });
    return result;
    });
}

/** 復原文件仍經過原有 outbox，與同步端的 revision 衝突規則一致。 */
export function restoreArticleDocument(docId, expectedDeletedAt) {
    return runCaptured(async ctx => {
        const result = await restoreDeletedEntity('articleDocument', docId, expectedDeletedAt, ctx);
        if (result.ok) emitChange({ articleId: result.entity.articleId, entityType: 'articleDocument', entityId: docId, ctx });
        return result;
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// 會話與消息
// ─────────────────────────────────────────────────────────────────────────────

export function listConversations(articleId = '') {
    return Array.from(conversationsById.values())
        .filter((conv) => conv && !conv.deletedAt && (!articleId || conv.articleId === articleId))
        .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

export function getConversation(convId) {
    return conversationsById.get(convId) || null;
}

export function ensureConversation({ articleId = '', articleKey = '', title = '', id = '' } = {}) {
    return runCaptured(async (ctx) => {
    const existing = id ? conversationsById.get(id) : null;
    if (existing) return { ok: true, conversation: existing };
    const timestamp = nowIso();
    const conversation = {
        id: id || generateReadingId('conv'),
        articleId: String(articleId || ''),
        legacyArticleKey: String(articleKey || ''),
        title: String(title || '').slice(0, READING_LIMITS.maxTitleChars),
        createdAt: timestamp,
        updatedAt: timestamp,
        deletedAt: '',
        revision: 0
    };
    const result = await writeEntity('conversation', conversation, { existing: null, ctx });
    if (result.ok) emitChange({ articleId: conversation.articleId, entityType: 'conversation', entityId: conversation.id, ctx });
    return result.ok ? { ok: true, conversation: result.entity } : result;
    });
}

export async function getMessages(conversationId, ctx = captureReadingContext()) {
    if (!conversationId) return [];
    const cacheKey = `${ctx.scope}\u0000${conversationId}`;
    if (messagesByConversation.has(cacheKey) && isReadingContextActive(ctx)) return messagesByConversation.get(cacheKey);
    let records = [];
    if (fallbackMode) {
        records = bucketArray('messages', ctx.scope);
    } else {
        const result = await readStoreByIndex(STORE.MESSAGES, 'scope_conversation', [ctx.scope, conversationId]);
        records = result.ok ? result.records : [];
    }
    if (!isReadingContextActive(ctx)) return [];
    const list = records
        .filter((msg) => msg && msg.conversationId === conversationId && !msg.deletedAt)
        .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || String(a.id).localeCompare(String(b.id)));
    for (const msg of list) messagesById.set(msg.id, msg);
    messagesByConversation.set(cacheKey, list);
    return list;
}

/**
 * 還原核對專用的消息讀取：回傳含刪除標記（tombstone）的實際儲存記錄。
 *
 * `getMessages()` 是介面查詢，會過濾 `deletedAt`；但 `exportAll()` 保留刪除
 * 標記。核對含已刪除會話／消息的合法備份時若用 `getMessages()`，全部寫入
 * 成功仍會產生 `conversation_messages`／`message_mismatch`，被
 * `partial_restore_failed` 判失敗。
 *
 * 讀取是 `await`：回來時帳戶可能已切換（A→B）。此時 A 的記錄不能當成 B 的
 * 核對結果，回傳 `null` 讓呼叫端立刻以 `stale_scope` 中止。
 */
async function readStoredMessages(conversationId, ctx = captureReadingContext()) {
    if (!conversationId) return [];
    if (!isReadingContextActive(ctx)) return null;
    let records = [];
    if (fallbackMode) {
        records = bucketArray('messages', ctx.scope);
    } else {
        const result = await readStoreByIndex(STORE.MESSAGES, 'scope_conversation', [ctx.scope, conversationId]);
        records = result.ok ? result.records : [];
    }
    // 與 `getMessages()` 一致：await 後一定要再確認上下文仍有效，否則切換
    // 帳戶後仍會把舊 scope 的記錄當成核對通過。
    if (!isReadingContextActive(ctx)) return null;
    return records.filter((msg) => msg && msg.conversationId === conversationId);
}

export function appendMessage(input) {
    return runCaptured(async (ctx) => {
    if (!input || !input.conversationId) return { ok: false, error: 'conversation_required' };
    const timestamp = nowIso();
    const conversation = conversationsById.get(input.conversationId);
    const message = {
        id: input.id || generateReadingId('msg'),
        conversationId: input.conversationId,
        role: ['user', 'assistant', 'system'].includes(input.role) ? input.role : 'user',
        content: String(input.content || '').slice(0, READING_LIMITS.maxMessageChars),
        status: input.status || 'complete',
        learningItemId: input.learningItemId || '',
        anchor: input.anchor ? normalizeAnchor(input.anchor) : null,
        contentVersion: input.contentVersion || '',
        createdAt: input.createdAt || timestamp,
        updatedAt: timestamp,
        deletedAt: '',
        revision: 0
    };
    if (!conversation) return { ok: false, error: 'conversation_not_found' };
    const entries = [
        { entityType: 'message', input: message, existing: null },
        {
            entityType: 'conversation',
            input: { ...conversation, updatedAt: timestamp, articleId: conversation.articleId || input.articleId || '' },
            existing: conversation
        }
    ];
    // 消息本體與會話 updatedAt 同交易；任一失敗都不會只留下消息。
    const written = await writeEntitiesAtomically(entries, ctx);
    if (!written.ok) return written;
    const storedMessage = messagesById.get(message.id) || { ...message, scope: ctx.scope, pending: true };
    messagesByConversation.delete(`${ctx.scope}\u0000${input.conversationId}`);
    messagesById.set(message.id, storedMessage);
    emitChange({ articleId: conversation?.articleId || input.articleId || '', entityType: 'message', entityId: message.id, ctx });
    return { ok: true, message: storedMessage };
    });
}

export function renameConversation(conversationId, title) {
    return runCaptured(async (ctx) => {
    const conversation = conversationsById.get(conversationId);
    if (!conversation) return { ok: false, error: 'not_found' };
    const next = { ...conversation, title: String(title || '').slice(0, READING_LIMITS.maxTitleChars), updatedAt: nowIso() };
    return writeEntity('conversation', next, { existing: conversation, ctx });
    });
}

export function deleteConversation(conversationId) {
    return runCaptured(async (ctx) => {
    const conversation = conversationsById.get(conversationId);
    if (!conversation) return { ok: false, error: 'not_found' };
    const messages = await getMessages(conversationId, ctx);
    if (!isReadingContextActive(ctx)) return staleResult();
    const timestamp = nowIso();
    const entries = [{
        entityType: 'conversation',
        input: { ...conversation, deletedAt: timestamp, updatedAt: timestamp },
        existing: conversation,
        op: 'delete'
    }];
    for (const message of messages) {
        entries.push({
            entityType: 'message',
            input: { ...message, deletedAt: timestamp, updatedAt: timestamp },
            existing: message,
            op: 'delete'
        });
    }
    const result = await writeEntitiesAtomically(entries, ctx);
    if (result.ok) {
        messagesByConversation.delete(`${ctx.scope}\u0000${conversationId}`);
        for (const message of messages) messagesById.delete(message.id);
        emitChange({ articleId: conversation.articleId, entityType: 'conversation', entityId: conversationId, ctx });
    }
    return result;
    });
}

/** 舊版遷移專用：以既有消息清單覆寫會話。 */
export function setConversationMessages(conversationId, messages) {
    return runCapturedComposite(async (ctx) => {
    const conversation = conversationsById.get(conversationId);
    if (!conversation) return { ok: false, error: 'not_found' };
    const existing = await getMessages(conversationId, ctx);
    if (!isReadingContextActive(ctx)) return staleResult();
    const list = Array.isArray(messages) ? messages : [];
    if (existing.length >= list.length) return { ok: true, skipped: existing.length };
    // 舊遷移可能只完成一部分：從既有數量接續補齊，重跑不會重複。
    let count = 0;
    for (let index = existing.length; index < list.length; index += 1) {
        const raw = list[index];
        const result = await appendMessage({
            conversationId,
            role: raw?.role,
            content: raw?.content,
            createdAt: raw?.ts ? new Date(Number(raw.ts) || raw.ts).toISOString() : undefined
        });
        if (!result.ok) return { ok: false, error: result.error, count };
        count += 1;
    }
    return { ok: true, count };
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// 原文版本
// ─────────────────────────────────────────────────────────────────────────────

export function saveArticleVersion(articleId, body, version) {
    return runCaptured(async (ctx) => {
    if (!articleId || !version) return { ok: false, error: 'invalid_version' };
    const key = `${ctx.scope}\u0000${articleId}\u0000${version}`;
    const record = { id: key, key, scope: ctx.scope, articleId, version, body: String(body || ''), createdAt: nowIso() };
    if (fallbackMode) {
        const list = bucketArray('versions', ctx.scope);
        if (list.some((item) => item.id === key)) return { ok: true, skipped: true };
        list.push(record);
        return bucketWrite('versions', list, ctx.scope) ? { ok: true } : { ok: false, error: 'storage_full' };
    }
    const existing = await readStoreOne(STORE.ARTICLE_VERSIONS, key);
    if (!isReadingContextActive(ctx)) return staleResult();
    if (existing.ok && existing.value) return { ok: true, skipped: true };
    const result = await applyPermanentOperations([{ store: STORE.ARTICLE_VERSIONS, type: 'put', value: record }]);
    return result.ok ? { ok: true } : { ok: false, error: result.error };
    });
}

export async function getArticleVersion(articleId, version) {
    const ctx = captureReadingContext();
    const key = `${ctx.scope}\u0000${articleId}\u0000${version}`;
    if (fallbackMode) return bucketArray('versions', ctx.scope).find((item) => item.id === key) || null;
    const result = await readStoreOne(STORE.ARTICLE_VERSIONS, key);
    return result.ok ? result.value || null : null;
}

export async function listArticleVersions(articleId) {
    const ctx = captureReadingContext();
    if (fallbackMode) return bucketArray('versions', ctx.scope).filter((item) => item.articleId === articleId);
    const result = await readStoreAll(STORE.ARTICLE_VERSIONS, ctx.scope);
    return result.ok ? result.records.filter((item) => item.articleId === articleId) : [];
}

// ─────────────────────────────────────────────────────────────────────────────
// 讀取／合併（同步用）
// ─────────────────────────────────────────────────────────────────────────────

export function getEntitySync(entityType, entityId) {
    if (entityType === 'message') return messagesById.get(entityId) || null;
    const map = mapForType(entityType);
    return map ? (map.get(entityId) || null) : null;
}

export async function getEntity(entityType, entityId, ctx = captureReadingContext()) {
    const memory = getEntitySync(entityType, entityId);
    if (memory) return memory;
    if (entityType === 'message') {
        const cached = messagesById.get(entityId);
        if (cached) return cached;
        const all = fallbackMode ? bucketArray('messages', ctx.scope) : ((await readStoreAll(STORE.MESSAGES, ctx.scope)).records || []);
        if (!isReadingContextActive(ctx)) return null;
        for (const msg of all) if (msg && msg.id) messagesById.set(msg.id, msg);
        return messagesById.get(entityId) || null;
    }
    const storeName = storeForType(entityType);
    if (!storeName) return null;
    if (fallbackMode) {
        const listName = listForBucket(entityType);
        return bucketArray(listName, ctx.scope).find((item) => item && item.id === entityId) || null;
    }
    const result = await readStoreOne(storeName, entityKey(entityId, ctx.scope));
    if (!isReadingContextActive(ctx)) return null;
    return result.ok ? result.value || null : null;
}

/** 把遠端記錄直接寫成本機非待同步狀態（無 pending）。 */
export async function persistRemoteEntity(entityType, remote, ctx = captureReadingContext()) {
    const storeName = storeForType(entityType);
    if (!storeName || !remote || !remote.id) return { ok: false, error: 'invalid_entity' };
    if (!isReadingContextActive(ctx)) return staleResult();
    const record = {
        ...remote,
        scope: ctx.scope,
        key: recordKeyFor(entityType, remote, ctx.scope),
        pending: false,
        dirty: false,
        conflict: null
    };
    if (entityType === 'learningItem' && typeof record.marked !== 'boolean') {
        // 舊後端或舊備份沒有 marked：不可把本機明確的 true／false 洗掉；
        // 本機也沒有時才留缺欄位，交給文章載入時的冪等遷移補齊。
        const local = itemsById.get(remote.id);
        if (local && typeof local.marked === 'boolean') record.marked = local.marked;
    }
    const result = await applyPermanentOperations([{ store: storeName, type: 'put', value: record }]);
    if (!result.ok) {
        if (result.error === 'idb_unavailable') {
            const bucket = readBucket(ctx.scope);
            const listName = listForBucket(entityType);
            bucket[listName] = upsertInList(bucket[listName] || [], record);
            if (!writeBucket(bucket, ctx.scope)) return { ok: false, error: 'storage_full' };
        } else {
            return result;
        }
    }
    rememberEntity(entityType, record, ctx);
    if (entityType === 'message' && isReadingContextActive(ctx)) {
        messagesByConversation.delete(`${ctx.scope}\u0000${remote.conversationId}`);
        messagesById.set(record.id, record);
    }
    return { ok: true, record };
}

function buildRemoteRecord(entityType, remote, recordScope, local = null) {
    const record = {
        ...remote,
        scope: recordScope,
        key: recordKeyFor(entityType, remote, recordScope),
        pending: false,
        dirty: false,
        conflict: null
    };
    if (entityType === 'learningItem' && typeof record.marked !== 'boolean') {
        // 舊後端或舊備份沒有 marked：不可把本機明確的 true／false 洗掉；
        // 本機也沒有時才留缺欄位，交給文章載入時的冪等遷移補齊。
        const fallback = local || itemsById.get(remote.id);
        if (fallback && typeof fallback.marked === 'boolean') record.marked = fallback.marked;
    }
    return record;
}

/**
 * 決定一筆遠端變更要寫入什麼。純函式，IndexedDB 與 localStorage 後備共用
 * 同一套版本／三方合併規則，避免兩條路徑行為分叉。
 */
function planRemoteChange(entityType, { local = null, outbox = null, remote = null, tombstone = false, recordScope = scope() } = {}) {
    const timestamp = nowIso();
    if (tombstone) {
        if (!local) return { action: 'skip', applied: false };
        if (!outbox) {
            return {
                action: 'persist',
                applied: true,
                record: {
                    ...local,
                    deletedAt: timestamp,
                    pending: false,
                    dirty: false,
                    conflict: null,
                    scope: recordScope,
                    key: recordKeyFor(entityType, local, recordScope)
                }
            };
        }
        // 有本機待同步操作時走一般合併，保留「雲端刪除 vs 本機編輯」衝突。
        return planRemoteChange(entityType, {
            local,
            outbox,
            remote: { ...local, deletedAt: timestamp, revision: (Number(local.revision) || 0) + 1 },
            recordScope
        });
    }
    if (!remote || !remote.id) return { action: 'skip', applied: false };
    if (!local) {
        return { action: 'persist', applied: true, record: buildRemoteRecord(entityType, remote, recordScope) };
    }
    if (!outbox) {
        const localRevision = Number(local.revision) || 0;
        const remoteRevision = Number(remote.revision) || 0;
        if (remoteRevision > localRevision || (remote.deletedAt && !local.deletedAt)) {
            return {
                action: 'persist',
                applied: true,
                record: buildRemoteRecord(entityType, remote, recordScope, local)
            };
        }
        return { action: 'skip', applied: false };
    }
    const baseRevision = Number(outbox.base?.revision) || Number(outbox.expectedRevision) || 0;
    const remoteRevision = Number(remote.revision) || 0;
    // 已經以同一版本為 base 合併過（包含墓碑）就不再重套；否則第二次拉取
    // 同一墓碑會把第一次產生的刪改衝突清掉。
    if (remoteRevision <= baseRevision) return { action: 'stale', applied: false };
    const merged = mergeReadingEntity(entityType, { base: outbox.base, local, remote });
    const entity = {
        ...merged.record,
        scope: recordScope,
        revision: remoteRevision || Number(merged.record.revision) || 0,
        pending: true,
        dirty: true,
        key: recordKeyFor(entityType, merged.record, recordScope)
    };
    const nextOutbox = {
        key: outboxKey(entityType, entity.id, recordScope),
        scope: recordScope,
        mutationId: generateReadingId('m'),
        entityType,
        entityId: entity.id,
        op: entity.deletedAt ? 'delete' : 'upsert',
        expectedRevision: remoteRevision,
        patch: entity.deletedAt ? null : normalizeReadingPatch(entityType, wireReadingEntity(entity)),
        base: wireReadingEntity(remote),
        createdAt: timestamp,
        attempts: 0,
        lastError: ''
    };
    return {
        action: 'merge',
        applied: true,
        record: entity,
        outbox: nextOutbox,
        conflicts: merged.conflicts.length
            ? {
                fields: merged.conflicts.map((item) => item.field),
                local: wireReadingEntity(merged.record),
                remote: wireReadingEntity(remote)
            }
            : null
    };
}

/** 補讀不在記憶體的實體（readonly 預取）。不回寫任何全域記憶體；合併用的
 * 本機值仍會在寫入交易內重新讀取，呼叫端不得使用這裡的結果做決策。 */
async function loadMissingEntities(missing, ctx) {
    const keysByStore = new Map();
    let needMessages = false;
    for (const item of missing) {
        if (item.entityType === 'message') { needMessages = true; continue; }
        const storeName = storeForType(item.entityType);
        if (!storeName) return { ok: false, error: 'invalid_entity_type' };
        if (!keysByStore.has(storeName)) keysByStore.set(storeName, []);
        keysByStore.get(storeName).push({
            key: recordKeyFor(item.entityType, { id: item.entityId }, ctx.scope)
        });
    }
    if (needMessages) {
        // 消息的 key 需要 conversationId，而墓碑只有 entityId；先確認整個
        // message store 可讀，真正的值仍由稍後的 readwrite 交易讀取。
        const result = await readStoreAll(STORE.MESSAGES, ctx.scope);
        if (!result.ok) return { ok: false, error: result.error };
    }
    if (!keysByStore.size) return { ok: true };
    const names = Array.from(keysByStore.keys());
    const result = await runPermanentTransaction(names, 'readonly', (stores) => {
        const requests = [];
        for (const [storeName, entries] of keysByStore) {
            for (const entry of entries) {
                requests.push(requestPromise(stores[storeName].get(entry.key)));
            }
        }
        return Promise.all(requests);
    });
    if (!result.ok) return { ok: false, error: result.error };
    return { ok: true };
}

/**
 * 批次套用遠端記錄（下載主路徑）。
 * 一批變更只開一次 IndexedDB 交易，後備模式只讀寫一次整個 bucket；
 * 逐項套用會讓首次同步變成 N 次交易與 O(N × bucket) 的 localStorage I/O。
 *
 * entries: [{ entityType, entityId, remote }] 或 [{ entityType, entityId, tombstone: true }]
 */
export async function applyRemoteEntities(entries, ctx = captureReadingContext()) {
    const list = [];
    for (const entry of Array.isArray(entries) ? entries : []) {
        if (!entry || !entry.entityType) continue;
        const remote = entry.remote || null;
        const entityId = String(entry.entityId || (remote && remote.id) || '');
        if (!entityId) continue;
        list.push({ entityType: entry.entityType, entityId, remote, tombstone: entry.tombstone === true, local: null });
    }
    if (!list.length) return { ok: true, results: [], applied: 0, conflicts: 0 };
    if (!isReadingContextActive(ctx)) return { ...staleResult(), results: [] };
    if (!fallbackMode) {
        // 先補讀缺失實體（readonly，不佔用單頁寫入序列）。這一步只為 message
        // 記憶體快取與相容既有行為；下面的 readwrite 交易會重新讀取最新值，
        // 因此在補讀期間完成的本機修改不會被舊值覆寫。
        const missing = list.filter((item) => !getEntitySync(item.entityType, item.entityId));
        if (missing.length) {
            const loaded = await loadMissingEntities(missing, ctx);
            if (!loaded.ok && loaded.error !== 'idb_unavailable') {
                return { ok: false, error: loaded.error, results: [] };
            }
            if (!isReadingContextActive(ctx)) return { ...staleResult(), results: [] };
            if (loaded.error === 'idb_unavailable') useFallback();
        }
    }
    // 最新 entity／outbox 的讀取、合併與寫入必須在同一個 readwrite 交易內，
    // 並與本頁其他寫入共用序列：否則等待缺失記錄期間的本機修改會被舊值覆寫。
    return serializeWrite(async () => {
        if (!isReadingContextActive(ctx)) return { ...staleResult(), results: [] };
        if (fallbackMode) return applyRemoteEntitiesFallback(list, ctx);
        return applyRemoteEntitiesInTransaction(list, ctx);
    });
}

function safeRequest(request) {
    const promise = requestPromise(request);
    // 交易 abort 時個別 request 會 reject；先掛 catch，避免同步失敗
    // 讓已建立但還沒進入 Promise.all 的 request 變成 unhandled rejection。
    promise.catch(() => {});
    return promise;
}

function readStoreByScope(store, recordScope) {
    if (store.indexNames.contains('scope')) {
        return safeRequest(store.index('scope').getAll(recordScope));
    }
    return safeRequest(store.getAll()).then((records) => (
        Array.isArray(records) ? records.filter((record) => !record.scope || record.scope === recordScope) : []
    ));
}

/** 在單一 readwrite 交易內讀取最新本機實體／outbox、合併後寫入。 */
async function applyRemoteEntitiesInTransaction(list, ctx) {
    // 衝突 metadata 必須和 entity／outbox 在同一個 readwrite 交易提交，
    // 所以交易一開始就把 reading_state 納入。
    const storeNames = new Set([STORE.READING_OUTBOX, STORE.READING_STATE]);
    for (const item of list) {
        const storeName = storeForType(item.entityType);
        if (!storeName) return { ok: false, error: 'invalid_entity_type', results: [] };
        storeNames.add(storeName);
    }
    let hasMessages = false;
    for (const item of list) if (item.entityType === 'message') hasMessages = true;
    if (hasMessages) storeNames.add(STORE.MESSAGES);

    const result = await runPermanentTransaction(Array.from(storeNames), 'readwrite', (stores) => {
        const outboxPromise = readStoreByScope(stores[STORE.READING_OUTBOX], ctx.scope);
        const statePromise = safeRequest(stores[STORE.READING_STATE].get(ctx.scope));
        const messagesPromise = hasMessages
            ? readStoreByScope(stores[STORE.MESSAGES], ctx.scope)
            : Promise.resolve([]);
        const localPromises = list.map((item) => {
            if (item.entityType === 'message') {
                return messagesPromise.then((records) => (
                    (records || []).find((record) => record && record.id === item.entityId) || null
                ));
            }
            return safeRequest(stores[storeForType(item.entityType)].get(entityKey(item.entityId, ctx.scope)));
        });
        return Promise.all([outboxPromise, statePromise, ...localPromises]).then(([outboxAll, storedState, ...locals]) => {
            const outboxByKey = new Map((outboxAll || []).map((op) => [
                outboxKey(op.entityType, op.entityId, ctx.scope), op
            ]));
            const operations = [];
            const remembered = [];
            const results = [];
            const conflictUpdates = [];
            let applied = 0;
            let conflicts = 0;
            list.forEach((item, index) => {
                const local = locals[index] || null;
                const outbox = outboxByKey.get(outboxKey(item.entityType, item.entityId, ctx.scope)) || null;
                const plan = planRemoteChange(item.entityType, {
                    local,
                    outbox,
                    remote: item.remote,
                    tombstone: item.tombstone,
                    recordScope: ctx.scope
                });
                if (plan.record) {
                    operations.push({ store: storeForType(item.entityType), type: 'put', value: plan.record });
                    if (plan.outbox) operations.push({ store: STORE.READING_OUTBOX, type: 'put', value: plan.outbox });
                    remembered.push({ entityType: item.entityType, record: plan.record });
                    applied += 1;
                    // 同一批若有重複 key，後續項目要看到前面剛算出的結果。
                    locals[index] = plan.record;
                    if (plan.outbox) outboxByKey.set(plan.outbox.key, plan.outbox);
                }
                if (plan.conflicts) {
                    conflicts += 1;
                    conflictUpdates.push({ entityType: item.entityType, entityId: item.entityId, info: plan.conflicts });
                }
                results.push({
                    entityType: item.entityType,
                    entityId: item.entityId,
                    action: plan.action,
                    applied: !!plan.applied,
                    conflict: !!plan.conflicts,
                    fields: plan.conflicts ? plan.conflicts.fields : []
                });
            });
            const value = { results, applied, conflicts, remembered, conflictUpdates, committedConflicts: null };
            if (conflictUpdates.length) {
                // 以交易內讀到的最新 state 為基準合併衝突，不能只用交易外的
                // 記憶體；寫入和 entity／outbox 一起提交，失敗則全部回滾。
                const nextConflicts = mergeConflictUpdates(storedState?.conflicts, conflictUpdates);
                value.committedConflicts = nextConflicts;
                operations.push({
                    store: STORE.READING_STATE,
                    type: 'put',
                    value: buildStatePayload(ctx.scope, nextConflicts)
                });
            }
            if (!operations.length) return value;
            const writes = [];
            for (const op of operations) {
                writes.push(safeRequest(
                    op.type === 'delete' ? stores[op.store].delete(op.key) : stores[op.store].put(op.value)
                ));
            }
            return Promise.all(writes).then(() => value);
        });
    });

    if (!result.ok) {
        if (result.error === 'idb_unavailable') {
            useFallback();
            return applyRemoteEntitiesFallback(list, ctx);
        }
        return { ok: false, error: result.error || 'idb_write_failed', results: [] };
    }
    const value = result.value || { results: [], applied: 0, conflicts: 0, remembered: [], conflictUpdates: [] };
    if (value.remembered.length && isReadingContextActive(ctx)) {
        for (const item of value.remembered) rememberAppliedEntity(item.entityType, item.record, ctx);
    }
    if (value.committedConflicts && isReadingContextActive(ctx)) {
        // 交易提交成功後才更新記憶體，失敗路徑不會留下半套衝突標記。
        meta.conflicts = value.committedConflicts;
    }
    if (isReadingContextActive(ctx) && (value.remembered.length || value.conflictUpdates.length)) {
        emitChange({ reason: 'remote-applied', ctx });
    }
    return { ok: true, results: value.results, applied: value.applied, conflicts: value.conflicts };
}

async function applyRemoteEntitiesFallback(list, ctx) {
    const bucket = readBucket(ctx.scope);
    let outboxList = Array.isArray(bucket.outbox) ? bucket.outbox.slice() : [];
    const results = [];
    const remembered = [];
    const conflictUpdates = [];
    let applied = 0;
    let conflicts = 0;
    let changed = false;
    let committedConflicts = null;
    for (const item of list) {
        const listName = listForBucket(item.entityType);
        if (!listName) return { ok: false, error: 'invalid_entity_type', results };
        const records = Array.isArray(bucket[listName]) ? bucket[listName] : [];
        const local = records.find((record) => record && record.id === item.entityId) || null;
        const outboxIndex = outboxList.findIndex((op) => op && op.entityType === item.entityType && op.entityId === item.entityId);
        const outbox = outboxIndex >= 0 ? outboxList[outboxIndex] : null;
        const plan = planRemoteChange(item.entityType, {
            local,
            outbox,
            remote: item.remote,
            tombstone: item.tombstone,
            recordScope: ctx.scope
        });
        if (plan.record) {
            bucket[listName] = upsertInList(records, plan.record);
            if (plan.outbox) {
                if (outboxIndex >= 0) outboxList[outboxIndex] = plan.outbox;
                else outboxList.push(plan.outbox);
            }
            remembered.push({ entityType: item.entityType, record: plan.record });
            applied += 1;
            changed = true;
        }
        if (plan.conflicts) {
            conflicts += 1;
            conflictUpdates.push({ entityType: item.entityType, entityId: item.entityId, info: plan.conflicts });
        }
        results.push({
            entityType: item.entityType,
            entityId: item.entityId,
            action: plan.action,
            applied: !!plan.applied,
            conflict: !!plan.conflicts,
            fields: plan.conflicts ? plan.conflicts.fields : []
        });
    }
    if (conflictUpdates.length) {
        committedConflicts = mergeConflictUpdates(bucket.state?.conflicts, conflictUpdates);
        bucket.state = buildStatePayload(ctx.scope, committedConflicts, bucket.state);
        changed = true;
    }
    if (changed) {
        // 實體、outbox 與 state 一次寫入同一個 bucket；任何失敗都不更新記憶體。
        bucket.outbox = outboxList;
        if (!writeBucket(bucket, ctx.scope)) return { ok: false, error: 'storage_full', results };
    }
    for (const item of remembered) rememberAppliedEntity(item.entityType, item.record, ctx);
    if (committedConflicts) meta.conflicts = committedConflicts;
    if (changed || conflictUpdates.length) emitChange({ reason: 'remote-applied', ctx });
    return { ok: true, results, applied, conflicts };
}

function mergeConflictUpdates(base, updates) {
    const next = { ...(base && typeof base === 'object' ? base : {}) };
    for (const item of updates) {
        next[`${item.entityType}:${item.entityId}`] = {
            entityType: item.entityType,
            entityId: item.entityId,
            at: nowIso(),
            ...item.info
        };
    }
    return next;
}

/** 完整 state payload；衝突由呼叫端給定，其餘欄位沿用目前記憶體視圖。 */
function buildStatePayload(recordScope, conflicts, base = meta) {
    return {
        ...(base && typeof base === 'object' ? base : {}),
        ...meta,
        scope: recordScope,
        conflicts: conflicts || {},
        legacyItemArticles: (base && base.legacyItemArticles) || meta.legacyItemArticles || {}
    };
}

/**
 * 套用一筆遠端記錄。
 * 若有本機待同步操作，使用 outbox.base 作三方合併；同欄位矛盾保留本機值，
 * 並把遠端值存入 conflicts 供 UI 選擇，不會靜默丟棄。
 */
export async function applyRemoteEntity(entityType, remote, ctx = captureReadingContext()) {
    if (!remote || !remote.id) return { ok: false, error: 'invalid_entity' };
    const batch = await applyRemoteEntities([{ entityType, remote }], ctx);
    if (!batch.ok) return batch;
    const result = batch.results[0] || { applied: false, conflict: false };
    return {
        ok: true,
        applied: !!result.applied,
        conflict: !!result.conflict,
        stale: result.action === 'stale',
        fields: result.fields || []
    };
}

/** 遠端墓碑：沒有本機待同步時直接套用；有 pending 時走一般合併（保留衝突）。 */
export async function applyRemoteTombstone(entityType, entityId, ctx = captureReadingContext()) {
    const batch = await applyRemoteEntities([{ entityType, entityId, tombstone: true }], ctx);
    if (!batch.ok) return { ok: false, error: batch.error || 'idb_write_failed' };
    const result = batch.results[0] || { applied: false };
    return { ok: true, applied: !!result.applied };
}

export async function markOutboxAcknowledged(entityType, entityId, { mutationId, revision, serverRecord = null } = {}, ctx = captureReadingContext()) {
    if (!isReadingContextActive(ctx)) return staleResult();
    const outbox = await readOutboxRecord(entityType, entityId, ctx);
    if (!isReadingContextActive(ctx)) return staleResult();
    const loadedLocal = getEntitySync(entityType, entityId) || await getEntity(entityType, entityId, ctx);
    if (!isReadingContextActive(ctx)) return staleResult();
    if (!outbox || outbox.mutationId !== mutationId) {
        // 上傳期間又有新編輯：保留新 outbox，只推進本機 revision 與基準，
        // 讓下一輪用伺服器新版本重送新 patch，而不是被舊 ack 清掉。
        if (loadedLocal && Number.isFinite(revision)) {
            const next = { ...loadedLocal, revision: Math.max(Number(loadedLocal.revision) || 0, Number(revision)) };
            const storeName = storeForType(entityType);
            const operations = [];
            if (storeName) {
                operations.push({ store: storeName, type: 'put', value: { ...next, scope: ctx.scope, key: recordKeyFor(entityType, next, ctx.scope) } });
            }
            if (outbox) {
                const base = serverRecord ? wireReadingEntity(serverRecord) : outbox.base;
                operations.push({
                    store: STORE.READING_OUTBOX,
                    type: 'put',
                    value: { ...outbox, expectedRevision: Math.max(Number(outbox.expectedRevision) || 0, Number(revision) || 0), base }
                });
            }
            if (operations.length) {
                const persisted = await applyPermanentOperations(operations);
                if (!persisted.ok) return { ok: false, error: persisted.error };
            }
            rememberEntity(entityType, next, ctx);
        }
        return { ok: true, stale: true };
    }
    if (!loadedLocal) {
        // 找不到實體時不能只刪 outbox：那會留下「已同步」假象並丟失回執。
        return { ok: false, error: 'entity_missing' };
    }
    const next = {
        ...loadedLocal,
        scope: ctx.scope,
        revision: Number.isFinite(revision) ? Math.max(Number(loadedLocal.revision) || 0, Number(revision)) : loadedLocal.revision,
        pending: false,
        dirty: false,
        conflict: null,
        updatedAt: serverRecord?.updatedAt || loadedLocal.updatedAt
    };
    const result = await applyPermanentOperations([
        { store: storeForType(entityType), type: 'put', value: { ...next, key: recordKeyFor(entityType, next, ctx.scope) } },
        { store: STORE.READING_OUTBOX, type: 'delete', key: outbox.key }
    ]);
    if (result.ok) {
        rememberEntity(entityType, next, ctx);
        if (entityType === 'message' && isReadingContextActive(ctx)) {
            messagesByConversation.delete(`${ctx.scope}\u0000${next.conversationId}`);
            messagesById.set(next.id, next);
        }
        await clearReadingConflict(entityType, entityId, ctx);
    }
    return result;
}

export async function markOutboxFailed(entityType, entityId, error, ctx = captureReadingContext()) {
    const outbox = await readOutboxRecord(entityType, entityId, ctx);
    if (!outbox || !isReadingContextActive(ctx)) return { ok: false, error: 'stale_scope' };
    const next = { ...outbox, attempts: (Number(outbox.attempts) || 0) + 1, lastError: String(error || '') };
    return applyPermanentOperations([{ store: STORE.READING_OUTBOX, type: 'put', value: next }]);
}

export async function listOutbox(ctx = captureReadingContext()) {
    const list = await readOutboxAll(ctx);
    return list.slice().sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
}

export async function countOutbox(ctx = captureReadingContext()) {
    return (await listOutbox(ctx)).length;
}

export async function discardOutbox(entityType, entityId, ctx = captureReadingContext()) {
    const key = outboxKey(entityType, entityId, ctx.scope);
    if (fallbackMode) {
        const list = bucketArray('outbox', ctx.scope).filter((item) => !(item.entityType === entityType && item.entityId === entityId));
        return bucketWrite('outbox', list, ctx.scope) ? { ok: true } : { ok: false, error: 'storage_full' };
    }
    if (!isReadingContextActive(ctx)) return staleResult();
    return applyPermanentOperations([{ store: STORE.READING_OUTBOX, type: 'delete', key }]);
}

// ─────────────────────────────────────────────────────────────────────────────
// 同步狀態／衝突
// ─────────────────────────────────────────────────────────────────────────────

export function getReadingScope() {
    return scope();
}

export function duplicateEntityForConflict(entityType, entity) {
    return runCaptured(async (ctx) => {
    if (!entity || !entity.id) return { ok: false, error: 'invalid_entity' };
    const copy = {
        ...entity,
        id: generateReadingId(entityType === 'articleDocument' ? 'doc' : 'li'),
        title: entity.title ? `${entity.title} (copy)` : entity.title,
        revision: 0,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        deletedAt: '',
        pending: true,
        dirty: true
    };
    return writeEntity(entityType, copy, { existing: null, ctx });
    });
}

export async function markLegacySnapshotAdopted() {
    return runCaptured(async (ctx) => {
    meta.legacySnapshotAdopted = true;
    return persistMeta(ctx);
    });
}

export function getReadingMeta() {
    return {
        ...meta,
        conflicts: { ...(meta.conflicts || {}) },
        legacyItemArticles: { ...(meta.legacyItemArticles || {}) }
    };
}

export function getReadingCursor() {
    return Number(meta.cursor) || 0;
}

async function persistMeta(ctx = captureReadingContext()) {
    if (!isReadingContextActive(ctx)) return staleResult();
    const payload = buildStatePayload(ctx.scope, meta.conflicts);
    if (fallbackMode) {
        const bucket = readBucket(ctx.scope);
        bucket.state = payload;
        return writeBucket(bucket, ctx.scope) ? { ok: true } : { ok: false, error: 'storage_full' };
    }
    const result = await applyPermanentOperations([{ store: STORE.READING_STATE, type: 'put', value: payload }]);
    if (!result.ok && result.error === 'idb_unavailable') {
        const bucket = readBucket(ctx.scope);
        bucket.state = payload;
        return writeBucket(bucket, ctx.scope) ? { ok: true } : { ok: false, error: 'storage_full' };
    }
    return result;
}

export async function setReadingCursor(cursor, ctx = captureReadingContext()) {
    if (!isReadingContextActive(ctx)) return staleResult();
    meta.cursor = Number(cursor) || 0;
    return persistMeta(ctx);
}

export async function markReadingSynced(at = nowIso(), ctx = captureReadingContext()) {
    if (!isReadingContextActive(ctx)) return staleResult();
    meta.lastSyncAt = at;
    meta.lastError = '';
    return persistMeta(ctx);
}

export async function markReadingSyncError(code, ctx = captureReadingContext()) {
    if (!isReadingContextActive(ctx) && ctx.scope !== currentScope) return staleResult();
    meta.lastError = String(code || '');
    return persistMeta(ctx);
}

export function getReadingConflicts() {
    return Object.values(meta.conflicts || {});
}

export async function setReadingConflict(entityType, entityId, info, ctx = captureReadingContext()) {
    if (!isReadingContextActive(ctx)) return staleResult();
    const key = `${entityType}:${entityId}`;
    meta.conflicts = {
        ...(meta.conflicts || {}),
        [key]: { entityType, entityId, at: nowIso(), ...info }
    };
    const result = await persistMeta(ctx);
    emitChange({ entityType, entityId, conflict: true, ctx });
    return result;
}

export async function clearReadingConflict(entityType, entityId, ctx = captureReadingContext()) {
    if (!isReadingContextActive(ctx)) return staleResult();
    const key = `${entityType}:${entityId}`;
    if (!meta.conflicts || !meta.conflicts[key]) return { ok: true };
    const next = { ...meta.conflicts };
    delete next[key];
    meta.conflicts = next;
    const result = await persistMeta(ctx);
    emitChange({ entityType, entityId, ctx });
    return result;
}

export function isLegacyReadingWriteBlocked() {
    return meta.migrationComplete === true;
}

export function isReadingMigrated() {
    return meta.migrationComplete === true;
}

// ─────────────────────────────────────────────────────────────────────────────
// 匯出／還原
// ─────────────────────────────────────────────────────────────────────────────

function allVersions() {
    if (fallbackMode) return bucketArray('versions');
    return [];
}

async function snapshotScopeStores(ctx, storeNames) {
    const names = Array.from(new Set(storeNames));
    const result = await runPermanentTransaction(names, 'readonly', (stores) => {
        const requests = names.map((name) => {
            const store = stores[name];
            const request = store.indexNames.contains('scope')
                ? store.index('scope').getAll(ctx.scope)
                : store.getAll();
            return new Promise((resolve, reject) => {
                request.onsuccess = () => resolve(request.result || []);
                request.onerror = () => reject(request.error || new Error('idb_read_failed'));
            });
        });
        return Promise.all(requests);
    });
    if (!result.ok) return { ok: false, error: result.error || 'idb_read_failed' };
    const out = {};
    names.forEach((name, index) => { out[name] = result.value[index] || []; });
    return { ok: true, stores: out };
}

function readArticleBucketStrict(recordScope) {
    let raw;
    try {
        raw = localStorage.getItem(`bdc:articles:fallback:v1:${recordScope}`);
    } catch (_) {
        return { ok: false, error: 'storage_read_failed' };
    }
    if (raw == null || raw === '') return { ok: true, bucket: { docs: [], outbox: [], state: null } };
    let bucket;
    try {
        bucket = JSON.parse(raw);
    } catch (_) {
        return { ok: false, error: 'storage_corrupt' };
    }
    if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)
        || !Array.isArray(bucket.docs)
        || (bucket.outbox != null && !Array.isArray(bucket.outbox))
        || (bucket.state != null && (typeof bucket.state !== 'object' || Array.isArray(bucket.state)))) {
        return { ok: false, error: 'storage_corrupt' };
    }
    return { ok: true, bucket };
}

/** 共用持久快照投影；IDB 與後備模式必須套用相同的文章／有效關聯邊界。 */
function articleReadingSnapshot(articleId, ctx, data) {
    const inScope = entity => entity && entity.scope === ctx.scope;
    const belongs = entity => inScope(entity) && entity.articleId === articleId && !entity.deletedAt;
    const items = (data.items || []).filter(belongs);
    const documents = (data.documents || []).filter(belongs);
    const conversations = (data.conversations || []).filter(belongs);
    const itemIds = new Set(items.map(item => item.id));
    const conversationIds = new Set(conversations.map(conv => conv.id));
    const messages = (data.messages || []).filter(message => inScope(message)
        && conversationIds.has(message.conversationId) && !message.deletedAt).map(wireReadingEntity);
    const byConversation = new Map();
    for (const message of messages) {
        if (!byConversation.has(message.conversationId)) byConversation.set(message.conversationId, []);
        byConversation.get(message.conversationId).push(message);
    }
    const links = (data.links || []).filter(link => inScope(link)
        && itemIds.has(link.itemId) && !link.deletedAt && !link.removedAt);
    const entryIds = new Set(links.map(link => link.entryId));
    const bookIds = new Set(links.map(link => link.bookId));
    // links 的次序不一定與 items 相同；每個詞條仍採 items 中首個有效關聯，
    // 只掃描一次關聯，避免每個跨文章詞條再做 items.find + links.some。
    const itemOrder = new Map(items.map((item, index) => [item.id, index]));
    const firstItemByEntry = new Map();
    for (const link of links) {
        const index = itemOrder.get(link.itemId);
        const first = firstItemByEntry.get(link.entryId);
        if (first === undefined || index < first) firstItemByEntry.set(link.entryId, index);
    }
    const entries = (data.entries || []).filter(entry => inScope(entry) && entryIds.has(entry.id) && !entry.deletedAt)
        .map(entry => {
            const projected = wireReadingEntity(entry);
            // 共用詞條可能先在別篇文章建立；保留詞義，來源與語境只帶目前文章。
            if (Array.isArray(entry.sources)) {
                projected.sources = entry.sources.filter(source => source && source.articleId === articleId);
            }
            if ((entry.sourceArticleId && entry.sourceArticleId !== articleId)
                || (Array.isArray(entry.sources) && entry.sources.some(source => source?.articleId && source.articleId !== articleId))) {
                const source = projected.sources?.[0];
                projected.context = source?.sentence || source?.context
                    || items[firstItemByEntry.get(entry.id)]?.sentence || '';
                projected.sourceArticleId = source ? articleId : '';
            }
            return projected;
        });
    const books = (data.books || []).filter(book => inScope(book) && bookIds.has(book.id) && !book.deletedAt)
        .map(book => {
            const projected = wireReadingEntity(book);
            if (book.articleId && book.articleId !== articleId) {
                projected.articleId = '';
                projected.sourceUrl = '';
            }
            return projected;
        });
    const readingEntityKeys = new Set();
    for (const [type, entities] of [
        ['learningItem', items], ['articleDocument', documents], ['conversation', conversations],
        ['message', messages], ['vocabularyBook', books], ['vocabularyEntry', entries], ['vocabularyLink', links]
    ]) {
        for (const entity of entities) readingEntityKeys.add(`${type}:${entity.id}`);
    }
    const projectState = (state, articleState = false) => {
        if (!state || (state.scope && state.scope !== ctx.scope)) return null;
        const projected = { ...state };
        if (state.conflicts && typeof state.conflicts === 'object') {
            projected.conflicts = Object.fromEntries(Object.entries(state.conflicts).filter(([key]) => (
                articleState ? key === articleId : readingEntityKeys.has(key)
            )));
        }
        if (state.legacyItemArticles && typeof state.legacyItemArticles === 'object') {
            projected.legacyItemArticles = Object.fromEntries(Object.entries(state.legacyItemArticles)
                .filter(([id]) => id === articleId));
        }
        return projected;
    };
    return {
        ok: true,
        scope: ctx.scope,
        articleId,
        articleDoc: data.articleDoc && inScope(data.articleDoc) && data.articleDoc.id === articleId ? data.articleDoc : null,
        learningItems: items.map(wireReadingEntity),
        articleDocuments: documents.map(wireReadingEntity),
        conversations: conversations.map(wireReadingEntity),
        messages,
        messagesByConversation: byConversation,
        vocabularyBooks: books,
        vocabularyEntries: entries,
        vocabularyLinks: links.map(wireReadingEntity),
        articleOutboxCount: (data.articleOutbox || []).filter(inScope).length,
        readingOutboxCount: (data.readingOutbox || []).filter(inScope).length,
        readingState: projectState(data.readingState),
        articleState: projectState(data.articleState, true)
    };
}

/**
 * 匯出單篇文章的一致快照：同一 readonly 交易讀取該文章條目、文件、會話與
 * 全部消息。後備模式同步讀取兩個持久桶，不使用可變的記憶體文章／詞書。
 */
export async function exportArticleReading(articleId, ctx = captureReadingContext()) {
    if (!articleId) return { ok: false, error: 'article_required' };
    if (!isReadingContextActive(ctx)) return staleResult();
    const loaded = await ensureArticleReadingLoaded(articleId, ctx);
    if (!isReadingContextActive(ctx)) return staleResult();
    if (!loaded.ok) return loaded;
    if (fallbackMode) {
        const readingRead = readBucketStrict(ctx.scope);
        if (!readingRead.ok) return readingRead;
        const articleRead = readArticleBucketStrict(ctx.scope);
        if (!articleRead.ok) return articleRead;
        if (!isReadingContextActive(ctx)) return staleResult();
        const bucket = readingRead.bucket;
        const articleBucket = articleRead.bucket;
        const articleDoc = articleBucket.docs.find(doc => doc && doc.scope === ctx.scope && doc.id === articleId);
        if (!articleDoc) return { ok: false, error: 'article_not_found' };
        return articleReadingSnapshot(articleId, ctx, {
            ...bucket,
            articleDoc,
            articleOutbox: articleBucket.outbox,
            readingOutbox: bucket.outbox,
            articleState: articleBucket.state,
            readingState: bucket.state
        });
    }
    // 匯出筆記需要文章、詞書／詞條／關聯、同步狀態與全部閱讀資料。
    // 全部放進同一個 readonly 交易，格式化階段才不會再讀可變的全域 Map。
    const result = await runPermanentTransaction([
        STORE.DOCS, STORE.OUTBOX, STORE.STATE,
        STORE.READING_ITEMS, STORE.ARTICLE_DOCUMENTS, STORE.CONVERSATIONS, STORE.MESSAGES,
        STORE.VOCAB_BOOKS, STORE.VOCAB_ENTRIES, STORE.VOCAB_LINKS,
        STORE.READING_OUTBOX, STORE.READING_STATE
    ], 'readonly', (stores) => {
        if (!isReadingContextActive(ctx)) return staleResult();
        const readAllIndex = (store, indexName, value) => new Promise((resolve, reject) => {
            if (!store.indexNames.contains(indexName)) { resolve([]); return; }
            const request = store.index(indexName).getAll(value);
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error || new Error('idb_read_failed'));
        });
        const readOne = (store, key) => new Promise((resolve, reject) => {
            const request = store.get(key);
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error || new Error('idb_read_failed'));
        });
        return (async () => {
            const [articleDoc, articleOutbox, articleState, items, documents, conversations, books, entries, links, readingOutbox, readingState] = await Promise.all([
                readOne(stores[STORE.DOCS], `${ctx.scope}\u0000${articleId}`),
                readAllIndex(stores[STORE.OUTBOX], 'scope', ctx.scope),
                readOne(stores[STORE.STATE], ctx.scope),
                readAllIndex(stores[STORE.READING_ITEMS], 'scope_article', [ctx.scope, articleId]),
                readAllIndex(stores[STORE.ARTICLE_DOCUMENTS], 'scope_article', [ctx.scope, articleId]),
                readAllIndex(stores[STORE.CONVERSATIONS], 'scope_article', [ctx.scope, articleId]),
                readAllIndex(stores[STORE.VOCAB_BOOKS], 'scope', ctx.scope),
                readAllIndex(stores[STORE.VOCAB_ENTRIES], 'scope', ctx.scope),
                readAllIndex(stores[STORE.VOCAB_LINKS], 'scope', ctx.scope),
                readAllIndex(stores[STORE.READING_OUTBOX], 'scope', ctx.scope),
                readOne(stores[STORE.READING_STATE], ctx.scope)
            ]);
            if (!isReadingContextActive(ctx)) return staleResult();
            const liveConversations = conversations.filter(conv => conv && conv.scope === ctx.scope
                && conv.articleId === articleId && !conv.deletedAt);
            const messageLists = await Promise.all(liveConversations.map((conv) => readAllIndex(
                stores[STORE.MESSAGES], 'scope_conversation', [ctx.scope, conv.id]
            )));
            if (!isReadingContextActive(ctx)) return staleResult();
            return {
                articleDoc, articleOutbox, articleState, items, documents, conversations,
                messages: messageLists.flat(), books, entries, links, readingOutbox, readingState
            };
        })();
    });
    if (!isReadingContextActive(ctx)) return staleResult();
    if (!result.ok) return { ok: false, error: result.error || 'idb_read_failed' };
    if (!result.value) return { ok: false, error: 'idb_read_failed' };
    if (result.value.ok === false) return result.value;
    return articleReadingSnapshot(articleId, ctx, result.value);
}

export async function exportAll(ctx = captureReadingContext(), options = {}) {
    if (!isReadingContextActive(ctx)) return staleResult();
    if (fallbackMode) {
        const read = readBucketStrict(ctx.scope);
        if (!read.ok) {
            meta.persistenceError = read.error;
            return { ok: false, error: read.error };
        }
        const bucket = read.bucket;
        return {
            ok: true,
            schemaVersion: 1,
            exportedAt: nowIso(),
            scope: ctx.scope,
            learningItems: (bucket.items || []).map(wireReadingEntity),
            articleDocuments: (bucket.documents || []).map(wireReadingEntity),
            vocabularyBooks: (bucket.books || []).map(wireReadingEntity),
            vocabularyEntries: (bucket.entries || []).map(wireReadingEntity),
            vocabularyLinks: (bucket.links || []).map(wireReadingEntity),
            conversations: (bucket.conversations || []).map(wireReadingEntity),
            messages: (bucket.messages || []).map(wireReadingEntity),
            articleVersions: (bucket.versions || []).map((item) => ({ ...item, key: undefined, scope: undefined })),
            meta: { migratedAt: meta.migratedAt, migrationComplete: meta.migrationComplete }
        };
    }
    const snapshot = await snapshotScopeStores(ctx, [
        STORE.READING_ITEMS, STORE.ARTICLE_DOCUMENTS, STORE.VOCAB_BOOKS,
        STORE.VOCAB_ENTRIES, STORE.VOCAB_LINKS, STORE.CONVERSATIONS,
        STORE.MESSAGES, STORE.ARTICLE_VERSIONS
    ]);
    if (!snapshot.ok) return snapshot;
    if (!isReadingContextActive(ctx)) return staleResult();
    const data = snapshot.stores;
    // 備份是明確允許讀取全部內容的流程；把資料留在記憶體可讓後續 restore
    // 核對使用同一份 ID，但不影響正常啟動的 lazy load。備份在同步鎖外執行時
    // 傳入 hydrate:false，避免用較早的讀取結果覆寫同步剛寫入的記憶體。
    if (options.hydrate !== false) {
        replaceMap(itemsById, data[STORE.READING_ITEMS], ctx.scope);
        replaceMap(documentsById, data[STORE.ARTICLE_DOCUMENTS], ctx.scope);
        replaceMap(booksById, data[STORE.VOCAB_BOOKS], ctx.scope);
        replaceMap(entriesById, data[STORE.VOCAB_ENTRIES], ctx.scope);
        replaceMap(linksById, data[STORE.VOCAB_LINKS], ctx.scope);
        replaceMap(conversationsById, data[STORE.CONVERSATIONS], ctx.scope);
    }
    return {
        ok: true,
        schemaVersion: 1,
        exportedAt: nowIso(),
        scope: ctx.scope,
        learningItems: data[STORE.READING_ITEMS].map(wireReadingEntity),
        articleDocuments: data[STORE.ARTICLE_DOCUMENTS].map(wireReadingEntity),
        vocabularyBooks: data[STORE.VOCAB_BOOKS].map(wireReadingEntity),
        vocabularyEntries: data[STORE.VOCAB_ENTRIES].map(wireReadingEntity),
        vocabularyLinks: data[STORE.VOCAB_LINKS].map(wireReadingEntity),
        conversations: data[STORE.CONVERSATIONS].map(wireReadingEntity),
        messages: data[STORE.MESSAGES].map(wireReadingEntity),
        articleVersions: data[STORE.ARTICLE_VERSIONS].map((item) => ({ ...item, key: undefined, scope: undefined })),
        meta: {
            migratedAt: meta.migratedAt,
            migrationComplete: meta.migrationComplete
        }
    };
}

function pickArray(payload, key) {
    return Array.isArray(payload?.[key]) ? payload[key] : [];
}

/**
 * 從完整備份還原；保留原 ID 並標記待同步。寫入後核對數量與引用。
 * 同一份備份重複還原不會重複建立（以 entity id 為鍵）。
 */
export function restoreAll(payload, options = {}) {
    return runCapturedComposite(async (ctx) => {
    if (!payload || typeof payload !== 'object') return { ok: false, error: 'invalid_payload' };
    // 先讀目前完整資料，還原時才能正確判斷既有 ID 並核對結果。
    const current = await exportAll(ctx);
    if (!current.ok) return current;
    const counts = {
        learningItems: 0,
        articleDocuments: 0,
        vocabularyBooks: 0,
        vocabularyEntries: 0,
        vocabularyLinks: 0,
        conversations: 0,
        messages: 0,
        articleVersions: 0
    };
    // 舊備份沒有 marked：用備份內的舊三態與有效詞書關聯補一次；
    // 新備份的明確 true／false 原樣保留。
    const backupActiveLinkItemIds = new Set(pickArray(payload, 'vocabularyLinks')
        .filter((link) => link && !link.deletedAt && !link.removedAt)
        .map((link) => link.itemId)
        .filter(Boolean));
    const expectedMarkedForBackup = (item) => (typeof item?.marked === 'boolean'
        ? item.marked
        : (item?.understanding === 'needs_review'
            || item?.understanding === 'understood'
            || backupActiveLinkItemIds.has(item?.id)));
    const failures = [];
    // `allowPartial` 只表示「單一項目失敗仍要繼續還原其餘項目」，不代表可以
    // 回報成功：寫入失敗或核對不符都必須讓呼叫端（備份還原、訪客資料併入）
    // 看到 `ok:false`，否則 UI 會顯示還原成功、實際上資料缺了一半。
    const recordFailure = (entity, id, result) => {
        failures.push({ entity, id: String(id || ''), error: (result && result.error) || 'write_failed' });
    };
    for (const item of pickArray(payload, 'vocabularyBooks')) {
        if (!item || !item.id) continue;
        const existing = booksById.get(item.id) || null;
        const result = await writeEntity('vocabularyBook', { ...item, deletedAt: item.deletedAt || '' }, { existing, ctx });
        if (result.ok) counts.vocabularyBooks += 1;
        else recordFailure('vocabularyBook', item.id, result);
    }
    for (const item of pickArray(payload, 'vocabularyEntries')) {
        if (!item || !item.id) continue;
        const existing = entriesById.get(item.id) || null;
        const result = await writeEntity('vocabularyEntry', { ...item, deletedAt: item.deletedAt || '' }, { existing, ctx });
        if (result.ok) counts.vocabularyEntries += 1;
        else recordFailure('vocabularyEntry', item.id, result);
    }
    for (const item of pickArray(payload, 'learningItems')) {
        if (!item || !item.id) continue;
        const existing = itemsById.get(item.id) || null;
        const result = await writeEntity('learningItem', {
            ...item,
            marked: expectedMarkedForBackup(item),
            deletedAt: item.deletedAt || ''
        }, { existing, ctx });
        if (result.ok) counts.learningItems += 1;
        else recordFailure('learningItem', item.id, result);
    }
    for (const item of pickArray(payload, 'vocabularyLinks')) {
        if (!item || !item.id) continue;
        const existing = linksById.get(item.id) || null;
        const result = await writeEntity('vocabularyLink', { ...item, deletedAt: item.deletedAt || '' }, { existing, ctx });
        if (result.ok) counts.vocabularyLinks += 1;
        else recordFailure('vocabularyLink', item.id, result);
    }
    for (const item of pickArray(payload, 'articleDocuments')) {
        if (!item || !item.id) continue;
        const existing = documentsById.get(item.id) || null;
        const result = await writeEntity('articleDocument', { ...item, deletedAt: item.deletedAt || '' }, { existing, ctx });
        if (result.ok) counts.articleDocuments += 1;
        else recordFailure('articleDocument', item.id, result);
    }
    for (const item of pickArray(payload, 'conversations')) {
        if (!item || !item.id) continue;
        const existing = conversationsById.get(item.id) || null;
        const result = await writeEntity('conversation', { ...item, deletedAt: item.deletedAt || '' }, { existing, ctx });
        if (result.ok) counts.conversations += 1;
        else recordFailure('conversation', item.id, result);
    }
    const messages = pickArray(payload, 'messages');
    const byConversation = new Map();
    for (const item of messages) {
        if (!item || !item.id || !item.conversationId) continue;
        byConversation.set(item.conversationId, (byConversation.get(item.conversationId) || 0) + 1);
    }
    for (const item of messages) {
        if (!item || !item.id || !item.conversationId) continue;
        const existing = (await getMessages(item.conversationId, ctx)).find((msg) => msg.id === item.id) || null;
        const result = await writeEntity('message', { ...item, deletedAt: item.deletedAt || '' }, { existing, ctx });
        if (result.ok) counts.messages += 1;
        else recordFailure('message', item.id, result);
    }
    for (const item of pickArray(payload, 'articleVersions')) {
        if (!item || !item.articleId || !item.version) continue;
        const result = await saveArticleVersion(item.articleId, item.body, item.version);
        if (result.ok) counts.articleVersions += 1;
        // 版本以 articleId+version 為鍵，id 只放可讀的組合值。
        else recordFailure('articleVersion', `${item.articleId}:${item.version}`, result);
    }
    // 寫入階段有多個 await（writeEntity／saveArticleVersion／getMessages）；
    // 期間若切換帳戶，後續核對與回報都只會是舊 scope 的結果。這裡先中止，
    // 不讓 `{ok:true}` 或 `partial_restore_failed` 蓋掉 `stale_scope`。
    if (!isReadingContextActive(ctx)) return staleResult();
    // 核對：備份中每則消息都應存在，且關聯的會話／條目不憑空消失。
    let verifyErrors = [];
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    for (const raw of pickArray(payload, 'learningItems')) {
        if (!raw || !raw.id) continue;
        const restored = getLearningItem(raw.id);
        if (!restored) { verifyErrors.push(`missing_item:${raw.id}`); continue; }
        if (restored.articleId !== raw.articleId || restored.kind !== raw.kind
            || restored.note !== (raw.note || '')
            || restored.marked !== expectedMarkedForBackup(raw)
            || restored.understanding !== (raw.understanding || 'unmarked')
            || !same(restored.anchor, raw.anchor)
            || !same(restored.explanation, raw.explanation ?? null)) {
            verifyErrors.push(`item_mismatch:${raw.id}`);
        }
    }
    for (const raw of pickArray(payload, 'vocabularyEntries')) {
        if (!raw || !raw.id) continue;
        const restored = getVocabularyEntry(raw.id);
        if (!restored) { verifyErrors.push(`missing_entry:${raw.id}`); continue; }
        if (restored.word !== raw.word || restored.meaning !== (raw.meaning || '')
            || restored.bookId !== raw.bookId) verifyErrors.push(`entry_mismatch:${raw.id}`);
    }
    for (const raw of pickArray(payload, 'vocabularyLinks')) {
        if (!raw || !raw.id) continue;
        const restored = linksById.get(raw.id);
        if (!restored) { verifyErrors.push(`missing_link:${raw.id}`); continue; }
        if (restored.itemId !== raw.itemId || restored.entryId !== raw.entryId || restored.bookId !== raw.bookId) {
            verifyErrors.push(`link_mismatch:${raw.id}`);
        }
    }
    for (const raw of pickArray(payload, 'articleDocuments')) {
        if (!raw || !raw.id) continue;
        const restored = getArticleDocument(raw.id);
        if (!restored) { verifyErrors.push(`missing_document:${raw.id}`); continue; }
        if (restored.content !== (raw.content || '') || restored.sourceMessageIds.join(',') !== (raw.sourceMessageIds || []).join(',')) {
            verifyErrors.push(`document_mismatch:${raw.id}`);
        }
    }
    for (const [convId, expected] of byConversation.entries()) {
        const actual = await readStoredMessages(convId, ctx);
        // 核對讀取期間切換帳戶：A 的記錄不能當成 B 的核對結果，也不能因為
        // `actual` 被視為空而只留下 `conversation_messages`（allowPartial 時
        // 還會變成 partial 失敗）。直接回 stale，介面才不會誤報還原成功。
        if (actual === null) return staleResult();
        if (actual.length < expected) verifyErrors.push(`conversation_messages:${convId}`);
        const byId = new Map(actual.map((message) => [message.id, message]));
        for (const raw of messages.filter((message) => message && message.conversationId === convId)) {
            const restored = byId.get(raw.id);
            if (!restored || restored.content !== raw.content || restored.role !== raw.role) {
                verifyErrors.push(`message_mismatch:${raw.id}`);
            }
        }
    }
    // 核對期間也可能切換帳戶（最後一次 await 之後），回成功前要再確認。
    if (!isReadingContextActive(ctx)) return staleResult();
    if (verifyErrors.length && !options.allowPartial) {
        return { ok: false, error: 'verify_failed', details: verifyErrors, counts };
    }
    // 部分還原仍要回報失敗：呼叫端（備份還原／訪客資料併入）必須知道有項目
    // 沒寫進去或核對不符，不能只看到「已繼續處理其餘項目」就當成成功。
    if (failures.length || verifyErrors.length) {
        return { ok: false, error: 'partial_restore_failed', failures, verifyErrors, counts };
    }
    return { ok: true, counts, verifyErrors };
    });
}/** 刪除目前 scope 的所有永久資料（只用於明確的測試／重置流程）。 */
export async function guestReadingCounts() {
    const guestScope = articleStore.getGuestScope();
    if (guestScope === scope()) return { books: 0, entries: 0, conversations: 0, messages: 0, items: 0, documents: 0 };
    const [books, entries, conversations, messages, items, documents] = await Promise.all([
        readStoreAll(STORE.VOCAB_BOOKS, guestScope),
        readStoreAll(STORE.VOCAB_ENTRIES, guestScope),
        readStoreAll(STORE.CONVERSATIONS, guestScope),
        readStoreAll(STORE.MESSAGES, guestScope),
        readStoreAll(STORE.READING_ITEMS, guestScope),
        readStoreAll(STORE.ARTICLE_DOCUMENTS, guestScope)
    ]);
    return {
        books: books.records.filter((item) => !item.deletedAt).length,
        entries: entries.records.filter((item) => !item.deletedAt).length,
        conversations: conversations.records.filter((item) => !item.deletedAt).length,
        messages: messages.records.filter((item) => !item.deletedAt).length,
        items: items.records.filter((item) => !item.deletedAt).length,
        documents: documents.records.filter((item) => !item.deletedAt).length
    };
}

/** 明確的「訪客閱讀資料帶入目前帳戶」流程；不刪除訪客資料。 */
export async function adoptGuestReadingData() {
    const current = scope();
    const guestScope = articleStore.getGuestScope();
    if (current === guestScope) return { ok: true, skipped: true };
    let payload = null;
    // 不論訪客匯出成功或失敗，都必須切回目前 scope；否則失敗後整個 store
    // 會停在訪客資料上，後續寫入全部進到錯誤的 scope。
    try {
        await initReadingStore(guestScope);
        payload = await exportAll();
    } finally {
        await initReadingStore(current);
    }
    // 匯出失敗（例如後備桶損壞）沒有陣列可讀：直接回傳錯誤，不要讀
    // `payload.learningItems.length` 拋 TypeError。
    if (!payload || payload.ok !== true) {
        return { ok: false, error: (payload && payload.error) || 'export_failed' };
    }
    const total = pickArray(payload, 'learningItems').length + pickArray(payload, 'vocabularyBooks').length
        + pickArray(payload, 'vocabularyEntries').length + pickArray(payload, 'conversations').length
        + pickArray(payload, 'messages').length;
    if (!total) return { ok: true, skipped: true };
    const result = await restoreAll(payload, { allowPartial: true });
    return { ...result, imported: total };
}

export async function clearScopeForTests() {
    const stores = [
        STORE.READING_ITEMS, STORE.ARTICLE_DOCUMENTS, STORE.VOCAB_BOOKS,
        STORE.VOCAB_ENTRIES, STORE.VOCAB_LINKS, STORE.CONVERSATIONS,
        STORE.MESSAGES, STORE.READING_OUTBOX, STORE.ARTICLE_VERSIONS
    ];
    for (const storeName of stores) {
        const { records } = await readStoreAll(storeName, scope());
        const operations = records.map((record) => ({ store: storeName, type: 'delete', key: record.key }));
        if (operations.length) await applyPermanentOperations(operations);
    }
    const stateResult = await readStoreOne(STORE.READING_STATE, scope());
    if (stateResult.ok && stateResult.value) {
        await applyPermanentOperations([{ store: STORE.READING_STATE, type: 'delete', key: scope() }]);
    }
    await initReadingStore();
}

// ─────────────────────────────────────────────────────────────────────────────
// 舊資料遷移
// ─────────────────────────────────────────────────────────────────────────────

function readLegacyBooks() {
    try {
        const raw = localStorage.getItem('vocabularyBooks');
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch (_) { return []; }
}

function readLegacyAssistantIndex() {
    try {
        const raw = localStorage.getItem(LEGACY_ASSISTANT_INDEX);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch (_) { return []; }
}

async function readLegacyConversation(convId) {
    try {
        const rec = await cache.getItem(`assistant:conv:${convId}`);
        if (rec && Array.isArray(rec.messages)) return rec.messages;
    } catch (_) {}
    try {
        const raw = localStorage.getItem(LEGACY_ASSISTANT_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        const conv = (parsed?.conversations || []).find((item) => item && item.id === convId);
        return Array.isArray(conv?.messages) ? conv.messages : [];
    } catch (_) { return []; }
}

async function legacyArticleKeyMap(records) {
    const map = new Map();
    for (const record of records) {
        if (!record || !record.article) continue;
        try {
            const key = await cache.makeKey('assistant-article', record.article);
            if (!map.has(key)) map.set(key, []);
            map.get(key).push(record.articleId);
        } catch (_) {}
    }
    return map;
}

function locateAnchorInBody(body, quote, sentence = '') {
    return locateTextAnchor(body, quote, sentence);
}

function migrationBackupKey(recordScope = scope()) {
    return `${MIGRATION_BACKUP_PREFIX}${recordScope}`;
}

async function saveMigrationBackup(ctx) {
    const index = readLegacyAssistantIndex();
    const conversations = [];
    for (const metaItem of index) {
        if (!metaItem || !metaItem.id) continue;
        conversations.push({ ...metaItem, messages: await readLegacyConversation(metaItem.id) });
    }
    const backup = {
        at: nowIso(),
        scope: ctx.scope,
        vocabularyBooks: readLegacyBooks(),
        assistantIndex: index,
        assistantConversations: conversations
    };
    try {
        localStorage.setItem(migrationBackupKey(ctx.scope), JSON.stringify(backup));
        const verify = JSON.parse(localStorage.getItem(migrationBackupKey(ctx.scope)) || 'null');
        if (!verify || verify.vocabularyBooks.length !== backup.vocabularyBooks.length
            || verify.assistantConversations.length !== backup.assistantConversations.length) {
            return { ok: false, error: 'backup_verify_failed' };
        }
        return { ok: true, backup };
    } catch (_) {
        return { ok: false, error: 'backup_failed' };
    }
}

async function migrateLegacyVocabulary(backup, ctx) {
    if (meta.legacyVocabularyMigrated) return { ok: true, skipped: true, books: 0, entries: 0, links: 0 };
    const books = backup.vocabularyBooks || [];
    let bookCount = 0;
    let entryCount = 0;
    for (const book of books) {
        if (!book || !book.id) continue;
        if (!isReadingContextActive(ctx)) return staleResult();
        const bookResult = await upsertVocabularyBook({
            id: book.id,
            name: book.name || '',
            sourceType: book.sourceType || 'legacy',
            articleId: book.articleId || '',
            createdAt: book.createdAt || nowIso(),
            deletedAt: ''
        });
        if (!bookResult.ok) return { ok: false, error: bookResult.error };
        bookCount += 1;
        for (const word of Array.isArray(book.words) ? book.words : []) {
            if (!word || !word.id) continue;
            if (!isReadingContextActive(ctx)) return staleResult();
            const entryResult = await upsertVocabularyEntry({
                ...word,
                id: word.id,
                bookId: book.id,
                examples: Array.isArray(word.examples) ? word.examples : [],
                sources: Array.isArray(word.sources) ? word.sources : [],
                createdAt: word.addedAt || nowIso(),
                deletedAt: ''
            });
            if (!entryResult.ok) return { ok: false, error: entryResult.error };
            entryCount += 1;
        }
    }
    // 精確來源關聯：只有詞條帶 sourceArticleId、文章存在且引用可唯一定位才建立。
    let links = 0;
    for (const entry of entriesById.values()) {
        if (!isReadingContextActive(ctx)) return staleResult();
        if (!entry || entry.deletedAt) continue;
        const articleId = entry.sourceArticleId || '';
        if (!articleId) continue;
        const record = articleStore.getRecord(articleId);
        if (!record || !record.article) continue;
        const located = locateAnchorInBody(record.article, entry.word, entry.context || '');
        const itemKey = located.anchor.quote;
        if (!itemKey) continue;
        if (!isReadingContextActive(ctx)) return staleResult();
        const itemResult = await upsertLearningItem({
            articleId,
            contentVersion: contentVersionOf(record.article),
            kind: /\s/.test(entry.word) ? 'phrase' : 'word',
            anchor: located.anchor,
            sentence: entry.context || '',
            explanation: entry.meaning ? { language: '', result: { meaning: entry.meaning, phonetic: entry.phonetic || '' }, generatedAt: entry.addedAt || '', provenance: { legacy: true } } : null,
            note: '',
            // 舊詞書關聯是有效的收藏：新模型下等於主動標記。
            marked: true,
            understanding: 'unmarked'
        }, { markViewed: false });
        if (!itemResult.ok) continue;
        const item = itemResult.entity;
        const linkId = `vl_legacy_${entry.id}`;
        if (linksById.has(linkId)) continue;
        if (!isReadingContextActive(ctx)) return staleResult();
        const linkResult = await addVocabularyLink({
            id: linkId,
            itemId: item.id,
            bookId: bookForEntry(entry.id),
            entryId: entry.id,
            addedAt: entry.addedAt || nowIso(),
            positionUnknown: !located.unique
        });
        if (linkResult.ok) links += 1;
    }
    // 回讀核對
    const storedBooks = listVocabularyBooks().length;
    const storedEntries = listVocabularyEntries().length;
    if (storedBooks < bookCount || storedEntries < entryCount) {
        return { ok: false, error: 'verify_vocabulary_failed', books: storedBooks, entries: storedEntries };
    }
    meta.legacyVocabularyMigrated = true;
    meta.migration = { ...(meta.migration || {}), vocabulary: { books: bookCount, entries: entryCount, links, at: nowIso() } };
    await persistMeta(ctx);
    return { ok: true, books: bookCount, entries: entryCount, links };
}

function bookForEntry(entryId) {
    const entry = entriesById.get(entryId);
    return entry?.bookId || '';
}

async function migrateLegacyAssistant(backup, ctx) {
    if (meta.legacyAssistantMigrated) return { ok: true, skipped: true, conversations: 0, messages: 0 };
    // 舊聊天用原文 hash 比對 articleId；這個明確遷移流程允許讀取全部原文。
    const records = await articleStore.loadAllRecords();
    const keyMap = await legacyArticleKeyMap(records);
    const index = backup.assistantIndex || [];
    let conversationCount = 0;
    let messageCount = 0;
    for (const metaItem of index) {
        if (!metaItem || !metaItem.id) continue;
        const matches = keyMap.get(metaItem.articleKey) || [];
        const articleId = matches.length === 1 ? matches[0] : '';
        const existing = conversationsById.get(metaItem.id) || null;
        if (!isReadingContextActive(ctx)) return staleResult();
        const convResult = await ensureConversation({
            id: metaItem.id,
            articleId,
            articleKey: articleId ? '' : (metaItem.articleKey || ''),
            title: metaItem.title || ''
        });
        if (!convResult.ok) return { ok: false, error: convResult.error };
        conversationCount += 1;
        const stored = backup.assistantConversations.find((item) => item && item.id === metaItem.id);
        const messages = Array.isArray(stored?.messages) ? stored.messages : [];
        if (!existing || (await getMessages(metaItem.id)).length === 0) {
            if (!isReadingContextActive(ctx)) return staleResult();
            const result = await setConversationMessages(metaItem.id, messages);
            if (!result.ok) return { ok: false, error: result.error, messages: messageCount };
            messageCount += result.count || 0;
        }
    }
    // 核對每段會話的消息數不少於備份
    for (const conv of backup.assistantConversations) {
        if (!isReadingContextActive(ctx)) return staleResult();
        if (!conv || !conv.id) continue;
        const expected = Array.isArray(conv.messages) ? conv.messages.length : 0;
        const actual = (await getMessages(conv.id, ctx)).length;
        if (actual < expected) {
            return { ok: false, error: 'verify_messages_failed', conversationId: conv.id, expected, actual };
        }
    }
    meta.legacyAssistantMigrated = true;
    meta.migration = { ...(meta.migration || {}), assistant: { conversations: conversationCount, messages: messageCount, at: nowIso() } };
    await persistMeta(ctx);
    return { ok: true, conversations: conversationCount, messages: messageCount };
}

/**
 * 版本化、冪等的舊資料遷移。先備份、再逐項寫入、回讀核對，全部成功才設
 * migrationComplete。失敗時不切換權威讀寫，重啟可重試；已成功的子項會跳過。
 */
export function migrateLegacyReadingData() {
    return runCapturedComposite(async (ctx) => {
    if (meta.migrationComplete) return { ok: true, skipped: true };
    const legacyBooks = readLegacyBooks();
    const legacyIndex = readLegacyAssistantIndex();
    let claimedScope = '';
    try { claimedScope = localStorage.getItem(LEGACY_CLAIM_KEY) || ''; } catch (_) {}
    if ((legacyBooks.length || legacyIndex.length) && claimedScope && claimedScope !== ctx.scope) {
        // 無範圍舊資料只能被一個 scope 認領；其他帳戶不可自動複製同一份私有詞書／聊天。
        meta.migrationComplete = true;
        meta.migratedAt = nowIso();
        meta.migration = {
            ...(meta.migration || {}),
            complete: { at: meta.migratedAt, skipped: 'legacy_claimed_elsewhere', claimedScope }
        };
        await persistMeta(ctx);
        return { ok: true, skipped: true, claimedElsewhere: true, claimedScope };
    }
    const backupResult = await saveMigrationBackup(ctx);
    if (!backupResult.ok) return backupResult;
    if (!isReadingContextActive(ctx)) return staleResult();
    const backup = backupResult.backup;
    const vocab = await migrateLegacyVocabulary(backup, ctx);
    if (!vocab.ok) return { ok: false, error: vocab.error, stage: 'vocabulary', ...vocab };
    if (!isReadingContextActive(ctx)) return staleResult();
    const assistant = await migrateLegacyAssistant(backup, ctx);
    if (!assistant.ok) return { ok: false, error: assistant.error, stage: 'assistant', ...assistant };
    if (!isReadingContextActive(ctx)) return staleResult();
    meta.migrationComplete = true;
    meta.migratedAt = nowIso();
    meta.migration = {
        ...(meta.migration || {}),
        complete: { at: meta.migratedAt, vocabulary: vocab, assistant }
    };
    await persistMeta(ctx);
    try {
        if (readLegacyBooks().length || readLegacyAssistantIndex().length) {
            localStorage.setItem(LEGACY_CLAIM_KEY, ctx.scope);
        }
    } catch (_) {}
    emitChange({ reason: 'migration-complete', ctx });
    return { ok: true, vocabulary: vocab, assistant, backupKey: migrationBackupKey(ctx.scope) };
    });
}

export function readReadingMigrationBackup() {
    try {
        const raw = localStorage.getItem(migrationBackupKey(scope()));
        return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
}

/**
 * 舊文章內的解析按需導入學習條目：不偽造查閱時間，標記依舊狀態遷移。
 * 同文章只做一次，版本記錄在 reading_state；失敗可重試。
 */
export async function importLegacyItemsForArticle(articleId) {
    if (!articleId) return { ok: false, error: 'article_required' };
    if (meta.legacyItemArticles[articleId]) return { ok: true, skipped: true };
    const record = await articleStore.ensureArticleLoaded(articleId);
    await ensureArticleReadingLoaded(articleId);
    if (!record || !record.article || !record.result) return { ok: true, skipped: true };
    const body = record.article;
    const version = contentVersionOf(body);
    const result = record.result || {};
    let created = 0;
    const add = async (kind, quote, sentence, analysis) => {
        const text = String(quote || '').trim();
        if (!text) return;
        const located = locateAnchorInBody(body, text, sentence || '');
        // 位置不確定時仍保留解析，但標為 positionUncertain，不假裝精確定位。
        const existing = findLearningItem(articleId, kind, located.anchor, version);
        if (existing) return;
        const saved = await upsertLearningItem({
            articleId,
            contentVersion: version,
            kind,
            anchor: located.anchor,
            sentence: sentence || '',
            explanation: analysis ? {
                language: '',
                result: analysis,
                generatedAt: analysis.updatedAt || '',
                provenance: { legacy: true }
            } : null,
            positionUncertain: !located.unique,
            note: '',
            // 舊解析若曾標為待弄懂／已理解，遷移後視為主動標記；
            // 只有查閱的舊資料維持未標記。
            marked: analysis?.marked === true
                || analysis?.understanding === 'needs_review'
                || analysis?.understanding === 'understood',
            understanding: 'unmarked'
        }, { markViewed: false });
        if (saved.ok) created += 1;
    };
    for (const item of Array.isArray(result.detailed_analysis) ? result.detailed_analysis : []) {
        if (!item || !item.word) continue;
        await add('word', item.word, item.sentence || '', item.analysis || item);
    }
    for (const item of Array.isArray(result.phrase_analysis) ? result.phrase_analysis : []) {
        if (!item) continue;
        await add('phrase', item.selection || item.phrase || '', item.sentence || '', item);
    }
    for (const item of Array.isArray(result.sentence_analysis) ? result.sentence_analysis : []) {
        if (!item) continue;
        await add('sentence', item.sentence || '', item.sentence || '', item);
    }
    meta.legacyItemArticles = { ...(meta.legacyItemArticles || {}), [articleId]: { at: nowIso(), created, version } };
    await persistMeta();
    emitChange({ articleId, reason: 'legacy-items-imported' });
    return { ok: true, created };
}

export async function reanchorArticle({ articleId, oldBody, newBody, oldVersion, newVersion }) {
    if (!articleId || oldBody === newBody) return { ok: true, changed: 0 };
    const items = listLearningItems(articleId).filter((item) => !item.deletedAt && item.contentVersion === oldVersion);
    let changed = 0;
    for (const item of items) {
        if (item.kind === 'sentence') {
            const located = locateAnchorInBody(newBody, item.anchor?.quote || item.sentence, item.sentence);
            if (located.unique) {
                const result = await updateLearningItemPosition(item.id, {
                    anchor: located.anchor,
                    contentVersion: newVersion,
                    positionUncertain: false
                });
                if (result.ok) {
                    const entity = getLearningItem(item.id);
                    if (entity) await writeEntity('learningItem', { ...entity, sourceContentVersion: oldVersion }, { existing: entity });
                    changed += 1;
                }
            } else {
                await updateLearningItemPosition(item.id, { anchor: item.anchor, contentVersion: oldVersion, positionUncertain: true });
            }
            continue;
        }
        const located = locateAnchorInBody(newBody, item.anchor?.quote, item.sentence);
        if (located.unique) {
            const result = await updateLearningItemPosition(item.id, {
                anchor: located.anchor,
                contentVersion: newVersion,
                positionUncertain: false
            });
            if (result.ok) {
                const entity = getLearningItem(item.id);
                if (entity) await writeEntity('learningItem', { ...entity, sourceContentVersion: oldVersion }, { existing: entity });
                changed += 1;
            }
        } else {
            await updateLearningItemPosition(item.id, {
                anchor: item.anchor,
                contentVersion: oldVersion,
                positionUncertain: true
            });
        }
    }
    if (changed) emitChange({ articleId, reason: 'reanchored' });
    return { ok: true, changed, total: items.length };
}

// 清快取時只重建可重建結果，不碰永久資料。這個函式保留給測試確認不會誤刪。
export async function permanentEntityCounts() {
    const ctx = captureReadingContext();
    return {
        learningItems: await countStore(STORE.READING_ITEMS, ctx.scope),
        articleDocuments: await countStore(STORE.ARTICLE_DOCUMENTS, ctx.scope),
        vocabularyBooks: await countStore(STORE.VOCAB_BOOKS, ctx.scope),
        vocabularyEntries: await countStore(STORE.VOCAB_ENTRIES, ctx.scope),
        vocabularyLinks: await countStore(STORE.VOCAB_LINKS, ctx.scope),
        conversations: await countStore(STORE.CONVERSATIONS, ctx.scope),
        messages: await countStore(STORE.MESSAGES, ctx.scope),
        outbox: (await listOutbox(ctx)).length
    };
}

/**
 * 新裝置遇到尚未支援逐項同步的舊後端時，允許把「本機永久層仍為空」的
 * 舊快照詞書／聊天匯入一次；已有本機資料時不覆蓋。匯入後仍走逐項 outbox，
 * 等服務端更新即可上傳。
 */
export async function adoptLegacyVocabularySnapshot(books) {
    const ctx = captureReadingContext();
    if (!isReadingContextActive(ctx)) return staleResult();
    const list = Array.isArray(books) ? books : [];
    let booksImported = 0;
    let entriesImported = 0;
    for (const book of list) {
        if (!book || !book.id) continue;
        const existingBook = booksById.get(book.id) || null;
        if (!existingBook) {
            if (!isReadingContextActive(ctx)) return staleResult();
        const bookResult = await upsertVocabularyBook({
                id: book.id,
                name: book.name || '',
                sourceType: book.sourceType || 'legacy',
                articleId: book.articleId || '',
                sourceUrl: book.sourceUrl || '',
                shareId: book.shareId || '',
                createdAt: book.createdAt || nowIso(),
                deletedAt: ''
            });
            if (!bookResult.ok) return { ok: false, error: bookResult.error, booksImported, entriesImported };
            booksImported += 1;
        }
        for (const word of Array.isArray(book.words) ? book.words : []) {
            if (!word || !word.id) continue;
            if (entriesById.has(word.id) && !entriesById.get(word.id).deletedAt) continue;
            if (!isReadingContextActive(ctx)) return staleResult();
            const entryResult = await upsertVocabularyEntry({
                ...word,
                id: word.id,
                bookId: book.id,
                examples: Array.isArray(word.examples) ? word.examples : [],
                sources: Array.isArray(word.sources) ? word.sources : [],
                createdAt: word.addedAt || nowIso(),
                deletedAt: ''
            });
            if (!entryResult.ok) return { ok: false, error: entryResult.error, booksImported, entriesImported };
            entriesImported += 1;
        }
    }
    if (booksImported) emitChange({ reason: 'legacy-vocabulary-adopted' });
    return { ok: true, books: booksImported, entries: entriesImported };
}

export async function adoptLegacyAssistantSnapshot(payload) {
    const conversations = Array.isArray(payload?.conversations) ? payload.conversations : [];
    if (!conversations.length) return { ok: true, skipped: true };
    const keyMap = await legacyArticleKeyMap(await articleStore.loadAllRecords());
    let convCount = 0;
    let messageCount = 0;
    for (const raw of conversations) {
        if (!raw || !raw.id) continue;
        const matches = keyMap.get(raw.articleKey) || [];
        const articleId = matches.length === 1 ? matches[0] : '';
        const existing = conversationsById.get(raw.id);
        const result = existing ? { ok: true } : await ensureConversation({
            id: raw.id,
            articleId,
            articleKey: articleId ? '' : (raw.articleKey || ''),
            title: raw.title || ''
        });
        if (!result.ok) return { ok: false, error: result.error, conversations: convCount, messages: messageCount };
        if (!existing) convCount += 1;
        const messages = Array.isArray(raw.messages) ? raw.messages : [];
        if (messages.length) {
            const appended = await setConversationMessages(raw.id, messages);
            if (!appended.ok) return { ok: false, error: appended.error, conversations: convCount, messages: messageCount };
            messageCount += appended.count || 0;
        }
    }
    if (convCount) emitChange({ reason: 'legacy-assistant-adopted' });
    return { ok: true, conversations: convCount, messages: messageCount };
}
