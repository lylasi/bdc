// 跨分頁的「404 重建代際」回歸：
//
// 每個「分頁」都是獨立的模組實例（article-store／article-sync／state 各自一份
// 記憶體狀態），但共用同一個 fake IndexedDB 與 localStorage —— 這正是兩個瀏覽
// 器分頁的真實情況：資料是共用的，記憶體與 in-flight 請求不是。
//
// 覆蓋兩個複審缺口：
//   1. 重建前送出的 PUT 回執（回應遲到）不得在重建後把 revision／updatedAt
//      推回去，也不得把待建立的 create 改成 update。
//   2. 另一個分頁保存時不得把重建前（舊代際）的記憶體 revision 合併回來。
//
// Usage: node --test --test-timeout=120000 tests/article-rebuild-generation.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import module from 'node:module';
import { createFakeIndexedDB, FakeObjectStore } from './helpers/fake-indexeddb.mjs';
import { createArticleSyncServer } from './helpers/article-sync-server.mjs';

const storage = new Map();
globalThis.localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => { storage.set(key, String(value)); },
    removeItem: (key) => { storage.delete(key); }
};
globalThis.window = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
globalThis.document = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, hidden: false };
globalThis.CustomEvent = class CustomEvent {
    constructor(type, init = {}) { this.type = type; this.detail = init && init.detail; }
};
globalThis.Audio = class {
    play() { return Promise.resolve(); }
    pause() {}
    addEventListener() {}
    removeEventListener() {}
};
globalThis.indexedDB = createFakeIndexedDB();
globalThis.__BDC_SYNC_ENDPOINT__ = 'https://worker.mock';

const ENDPOINT = 'https://worker.mock';
const DB_NAME = 'bdc-articles';

// ─────────────────────────────────────────────────────────────────────────────
// 每個分頁一份模組實例（真正的分頁語意：記憶體分開、儲存共用）
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = new URL('../', import.meta.url);
const TESTS_ROOT = new URL('tests/', ROOT).href;
const TAB_QUERY = /\?tab=([a-z0-9]+)$/;
let pendingTab = '';

// Node 的模組快取以解析後的 URL 為鍵：替專案內的模組加上 `?tab=` 就能讓
// 每個分頁取得獨立的模組圖（含 state.js／permanent-db.js 的模組層狀態）。
// 子模組沿用父模組的 tab，執行期動態 import 才不會拿到另一個分頁的實例。
module.registerHooks({
    resolve(specifier, context, nextResolve) {
        const result = nextResolve(specifier, context);
        if (!result.url.startsWith(ROOT.href) || result.url.startsWith(TESTS_ROOT)) return result;
        if (TAB_QUERY.test(result.url)) return result;
        const parentTab = context.parentURL ? context.parentURL.match(TAB_QUERY) : null;
        const tab = parentTab ? parentTab[1] : pendingTab;
        if (!tab) return result;
        return { ...result, url: `${result.url}?tab=${tab}` };
    }
});

async function bootTab(tab) {
    pendingTab = tab;
    try {
        // 依序載入：article-sync 會靜態 import article-store，兩者必須是同一個
        // 分頁實例（父 URL 已帶 ?tab=）。
        const store = await import('../modules/article-store.js');
        const sync = await import('../modules/article-sync.js');
        const state = await import('../modules/state.js');
        return { tab, store, sync, state };
    } finally {
        pendingTab = '';
    }
}

const tabA = await bootTab('a');
const tabB = await bootTab('b');
assert.notEqual(tabA.store, tabB.store, '兩個分頁必須是不同的模組實例');

// ─────────────────────────────────────────────────────────────────────────────
// 共用儲存（兩個分頁看同一份 IndexedDB）
// ─────────────────────────────────────────────────────────────────────────────

let sharedDbPromise = null;

function sharedDb() {
    if (sharedDbPromise) return sharedDbPromise;
    sharedDbPromise = new Promise((resolve, reject) => {
        // 不指定版本：由模組自己決定 schema（新增 ledger store 時測試不需同步改常數）。
        const request = globalThis.indexedDB.open(DB_NAME);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('open_failed'));
    });
    return sharedDbPromise;
}

async function rowsOf(storeName) {
    const db = await sharedDb();
    return new Promise((resolve, reject) => {
        let tx;
        try { tx = db.transaction([storeName], 'readonly'); } catch (error) { reject(error); return; }
        const request = tx.objectStore(storeName).getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error || new Error('read_failed'));
    });
}

async function docRow(scope, articleId) {
    const rows = await rowsOf('docs');
    return rows.find((row) => row && row.scope === scope && row.id === articleId) || null;
}

async function summaryRow(scope, articleId) {
    const rows = await rowsOf('article_summaries');
    return rows.find((row) => row && row.scope === scope && row.articleId === articleId) || null;
}

async function outboxRow(scope, articleId) {
    const rows = await rowsOf('outbox');
    return rows.find((row) => row && row.scope === scope && row.articleId === articleId) || null;
}

async function ledgerRow(scope, articleId) {
    const rows = await rowsOf('article_generations');
    return rows.find((row) => row && row.scope === scope && row.articleId === articleId) || null;
}

async function ledgerGeneration(scope, articleId) {
    return Number((await ledgerRow(scope, articleId))?.generation) || 0;
}

/** 測試注入：直接改寫 outbox 列（模擬升級前就存在的 legacy 資料）。 */
async function writeOutboxRow(row) {
    const db = await sharedDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(['outbox'], 'readwrite');
        tx.objectStore('outbox').put(row);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('write_failed'));
        tx.onabort = () => reject(tx.error || new Error('write_aborted'));
    });
}

function fallbackBucket(scope) {
    const raw = localStorage.getItem(`bdc:articles:fallback:v1:${scope}`);
    return raw ? JSON.parse(raw) : { docs: [], outbox: [], state: {}, generations: {} };
}

function scopeFor(user) {
    return `${ENDPOINT}::${user}`;
}

function startScope(user) {
    localStorage.setItem('sync_token', 'test-token');
    localStorage.setItem('sync_user_id', user);
}

// ─────────────────────────────────────────────────────────────────────────────
// 共用流程
// ─────────────────────────────────────────────────────────────────────────────

/** 讓兩個分頁都載入同一篇文章，並把遠端推到 revision 3。 */
async function seedRevision3(context, articleId, bodies = ['v1', 'v2', 'v3']) {
    const { server, user } = context;
    startScope(user);
    const scope = scopeFor(user);
    await tabA.store.reloadScope(scope);
    await tabB.store.reloadScope(scope);
    for (let index = 0; index < bodies.length; index += 1) {
        const saved = await tabA.store.saveArticle({ articleId, title: `Title ${articleId}`, article: bodies[index], sourceType: 'paste' });
        assert.equal(saved.ok, true, JSON.stringify(saved));
        const synced = await tabA.sync.syncArticles();
        assert.equal(synced.ok, true, JSON.stringify(synced));
        assert.equal(server.state.articles.get(articleId).revision, index + 1);
    }
    // 分頁 B 在重建前已載入 revision 3 的清單，之後不再重新載入。
    await tabB.store.reloadScope(scope);
    assert.equal(Number(tabA.store.getRecord(articleId).revision), 3);
    assert.equal(Number(tabB.store.getRecord(articleId).revision), 3);
    return scope;
}

/** 只建立 scope（不經過同步），給不需要遠端參與的回歸測試使用。 */
async function seedScopeOnly(context) {
    const { user } = context;
    startScope(user);
    const scope = scopeFor(user);
    await tabA.store.reloadScope(scope);
    await tabB.store.reloadScope(scope);
    return scope;
}

function newContext(name) {
    const server = createArticleSyncServer();
    globalThis.fetch = server.fetch;
    return { server, user: name };
}

// ─────────────────────────────────────────────────────────────────────────────
// 缺口 2：另一分頁保存時，舊記憶體 revision 不得復活
// ─────────────────────────────────────────────────────────────────────────────

test('另一分頁在「重設後」保存：文件／摘要／outbox 都採新代際，正文保留', async () => {
    const context = newContext('tab-reset-save');
    const { server } = context;
    const articleId = 'cross-reset';
    try {
        const scope = await seedRevision3(context, articleId);

        // 分頁 A：遠端被清掉 → PUT 404 → 重建（revision 0、新代際）。
        server.state.articles.delete(articleId);
        assert.equal((await tabA.store.saveArticle({ articleId, title: 'Title', article: 'a-v4' })).ok, true);
        const rebuildRound = await tabA.sync.syncArticles();
        assert.equal(rebuildRound.ok, true, JSON.stringify(rebuildRound));
        const rebuiltDoc = await docRow(scope, articleId);
        assert.equal(Number(rebuiltDoc.revision), 0, '重建後持久化文件仍停在舊 revision');
        assert.equal(Number(rebuiltDoc.generation), 1, '重建沒有換代際');
        assert.equal((await outboxRow(scope, articleId)).type, 'create');

        // 分頁 B 沒有重新載入（記憶體仍是舊代際的 revision 3）就保存新正文。
        const saved = await tabB.store.saveArticle({ articleId, title: 'Title', article: 'b-v5' });
        assert.equal(saved.ok, true, JSON.stringify(saved));

        const doc = await docRow(scope, articleId);
        assert.equal(doc.body, 'b-v5', '使用者的新正文必須保留');
        assert.equal(Number(doc.revision), 0, '舊代際的 revision 被合併回新代際');
        assert.equal(Number(doc.generation), 1, '保存後代際倒退');
        const summary = await summaryRow(scope, articleId);
        assert.equal(summary.bodyChars, 'b-v5'.length);
        assert.equal(Number(summary.revision), 0, '摘要沒有跟文件用同一代際基準');
        assert.equal(Number(summary.generation), 1);
        const op = await outboxRow(scope, articleId);
        assert.equal(op.type, 'create', JSON.stringify(op));
        assert.equal(Number(op.expectedRevision), 0, JSON.stringify(op));
        assert.equal(Number(op.generation), 1, JSON.stringify(op));
        assert.equal(op.payload.body, 'b-v5');
        assert.equal(tabB.store.getRecord(articleId).generation, 1, '記憶體沒有採用交易內的代際');

        // 建立成功 → 遠端與本機都是 revision 1；後續修改不再 409。
        const createRound = await tabB.sync.syncArticles();
        assert.equal(createRound.ok, true, JSON.stringify(createRound));
        assert.equal(server.state.articles.get(articleId).revision, 1);
        assert.equal(server.state.articles.get(articleId).body, 'b-v5');
        assert.equal(tabB.store.getRecord(articleId).revision, 1);
        assert.equal(tabB.store.getConflicts().length, 0, JSON.stringify(tabB.store.getConflicts()));

        assert.equal((await tabB.store.saveArticle({ articleId, title: 'Title', article: 'b-v6' })).ok, true);
        const updateRound = await tabB.sync.syncArticles();
        assert.equal(updateRound.ok, true, JSON.stringify(updateRound));
        assert.equal(updateRound.pushed.conflicts, 0, JSON.stringify(updateRound.pushed));
        assert.equal(server.state.articles.get(articleId).body, 'b-v6');
        assert.equal(server.state.articles.get(articleId).revision, 2);
        assert.equal(tabB.store.getRecord(articleId).revision, 2);
        assert.equal((await outboxRow(scope, articleId)), null);
    } finally {
        globalThis.fetch = undefined;
    }
});

test('另一分頁在「重建完成、outbox 已清」後保存：仍採新代際，無假衝突', async () => {
    const context = newContext('tab-completed-save');
    const { server } = context;
    const articleId = 'cross-completed';
    try {
        const scope = await seedRevision3(context, articleId);

        // 分頁 A：404 重建 → 同一輪建立成功（outbox 清空、遠端 revision 1）。
        server.state.articles.delete(articleId);
        assert.equal((await tabA.store.saveArticle({ articleId, title: 'Title', article: 'a-v4' })).ok, true);
        assert.equal((await tabA.sync.syncArticles()).ok, true);
        assert.equal((await tabA.sync.syncArticles()).ok, true);
        assert.equal(server.state.articles.get(articleId).revision, 1);
        assert.equal(await outboxRow(scope, articleId), null);

        // 分頁 B 仍停在舊代際的 revision 3。
        assert.equal(Number(tabB.store.getRecord(articleId).revision), 3);
        assert.equal((await tabB.store.saveArticle({ articleId, title: 'Title', article: 'b-v5' })).ok, true);

        const doc = await docRow(scope, articleId);
        assert.equal(doc.body, 'b-v5');
        assert.equal(Number(doc.revision), 1, '把舊代際的 revision 3 合併回來了');
        assert.equal(Number(doc.generation), 1);
        const op = await outboxRow(scope, articleId);
        assert.equal(op.type, 'update', JSON.stringify(op));
        assert.equal(Number(op.expectedRevision), 1, JSON.stringify(op));
        assert.equal(Number(op.generation), 1, JSON.stringify(op));
        assert.equal(Number((await summaryRow(scope, articleId)).revision), 1);

        const round = await tabB.sync.syncArticles();
        assert.equal(round.ok, true, JSON.stringify(round));
        assert.equal(round.pushed.conflicts, 0, JSON.stringify(round.pushed));
        assert.equal(server.state.articles.get(articleId).body, 'b-v5');
        assert.equal(server.state.articles.get(articleId).revision, 2);
        assert.equal(tabB.store.getConflicts().length, 0, JSON.stringify(tabB.store.getConflicts()));
        assert.equal(await outboxRow(scope, articleId), null);
    } finally {
        globalThis.fetch = undefined;
    }
});

test('重新載入後代際仍在：舊資料沒有 generation 視為 0，不會每次都被判定過期', async () => {
    const context = newContext('tab-reload-generation');
    const { server } = context;
    const articleId = 'cross-reload';
    try {
        const scope = await seedRevision3(context, articleId);
        assert.equal(Number((await docRow(scope, articleId)).generation), 0, '一般保存不應該產生代際');

        server.state.articles.delete(articleId);
        assert.equal((await tabA.store.saveArticle({ articleId, title: 'Title', article: 'a-v4' })).ok, true);
        assert.equal((await tabA.sync.syncArticles()).ok, true);
        assert.equal(Number((await docRow(scope, articleId)).generation), 1);

        // 模擬重新整理：重載清單後代際仍在，下一輪保存沿用同一個代際基準。
        await tabA.store.reloadScope(scope);
        assert.equal(Number(tabA.store.getRecord(articleId).generation), 1);
        assert.equal(Number(tabA.store.getRecord(articleId).revision), 0);
        assert.equal((await tabA.store.saveArticle({ articleId, title: 'Title', article: 'a-v5' })).ok, true);
        const doc = await docRow(scope, articleId);
        assert.equal(Number(doc.generation), 1, '重載後代際被重置');
        assert.equal(Number(doc.revision), 0, '重載後把舊 revision 寫回去');
        assert.equal(Number((await outboxRow(scope, articleId)).expectedRevision), 0);

        const round = await tabA.sync.syncArticles();
        assert.equal(round.ok, true, JSON.stringify(round));
        assert.equal(server.state.articles.get(articleId).revision, 1);
        assert.equal(server.state.articles.get(articleId).body, 'a-v5');
        assert.equal(tabA.store.getConflicts().length, 0, JSON.stringify(tabA.store.getConflicts()));
    } finally {
        globalThis.fetch = undefined;
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 缺口 1：重建前送出的回執遲到（markOpDone／markOpsDone）
// ─────────────────────────────────────────────────────────────────────────────

test('重建前送出的 PUT 回執在重建後才回來（markOpDone）：不得改動新代際', async (t) => {
    const context = newContext('tab-stale-receipt-before');
    const { server } = context;
    const articleId = 'cross-stale-before';
    try {
        const scope = await seedRevision3(context, articleId);

        // 分頁 B 送出 v4：伺服器已提交（遠端 revision 4），但回應暫扣。
        let releasePut;
        let putArrived;
        const putGate = new Promise((resolve) => { releasePut = resolve; });
        const putReady = new Promise((resolve) => { putArrived = resolve; });
        // 斷言失敗時也要放行暫扣的回應，否則測試會以逾時收尾（看不出真正原因）。
        t.after(() => releasePut());
        server.state.hooks.afterPut = async ({ id }) => {
            if (id !== articleId) return;
            putArrived();
            await putGate;
        };
        assert.equal((await tabB.store.saveArticle({ articleId, title: 'Title', article: 'b-v4' })).ok, true);
        const staleOp = await outboxRow(scope, articleId);
        assert.equal(Number(staleOp.generation), 0, JSON.stringify(staleOp));
        const bSync = tabB.sync.syncArticles();
        // 斷言失敗後才放行的同步會 reject，避免變成未處理的 rejection。
        bSync.catch(() => {});
        await putReady;
        assert.equal(server.state.articles.get(articleId).revision, 4);
        const staleUpdatedAt = server.state.articles.get(articleId).updatedAt;

        // 分頁 A：遠端文章被清掉 → 保存 v5 → PUT 404 → 重建（新代際、revision 0）。
        server.state.articles.delete(articleId);
        assert.equal((await tabA.store.saveArticle({ articleId, title: 'Title', article: 'a-v5' })).ok, true);
        const rebuildRound = await tabA.sync.syncArticles();
        assert.equal(rebuildRound.ok, true, JSON.stringify(rebuildRound));
        const rebuilt = await docRow(scope, articleId);
        assert.equal(Number(rebuilt.revision), 0);
        assert.equal(Number(rebuilt.generation), 1);
        const rebuiltUpdatedAt = rebuilt.updatedAt;

        // 同一筆舊回執先用批次核對（markOpsDone）投遞一次：同樣不得改動
        // revision／updatedAt／type／expectedRevision。
        const staleBatch = await tabA.store.markOpsDone([{
            articleId,
            revision: 4,
            serverUpdatedAt: staleUpdatedAt,
            clientMutationId: staleOp.clientMutationId,
            generation: staleOp.generation
        }]);
        assert.equal(staleBatch.ok, true, JSON.stringify(staleBatch));
        const afterBatch = await docRow(scope, articleId);
        assert.equal(Number(afterBatch.revision), 0, 'markOpsDone 把重建後的版本基準推回去了');
        assert.equal(afterBatch.updatedAt, rebuiltUpdatedAt, 'markOpsDone 改寫了 updatedAt');
        assert.equal(Number(afterBatch.generation), 1);
        const pendingAfterBatch = await outboxRow(scope, articleId);
        assert.equal(pendingAfterBatch.type, 'create', 'markOpsDone 把待建立操作改成 update');
        assert.equal(Number(pendingAfterBatch.expectedRevision), 0, JSON.stringify(pendingAfterBatch));

        // 放行 B 的舊回執（markOpDone 路徑）：它屬於重建前的代際，不得改動任何版本資訊。
        releasePut();
        const bRound = await bSync;
        assert.equal(bRound.ok, true, JSON.stringify(bRound));
        const afterReceipt = await docRow(scope, articleId);
        assert.equal(Number(afterReceipt.revision), 0, '舊回執把重建後的版本基準推回去了');
        assert.equal(afterReceipt.updatedAt, rebuiltUpdatedAt, '舊回執改寫了 updatedAt');
        assert.equal(Number(afterReceipt.generation), 1);
        const pending = await outboxRow(scope, articleId);
        assert.equal(pending.type, 'create', '待建立操作被舊回執改成 update');
        assert.equal(Number(pending.expectedRevision), 0, JSON.stringify(pending));
        assert.equal(Number(pending.generation), 1);
        assert.equal(tabB.store.getRecord(articleId).revision, 0, '記憶體被舊回執推回舊版本');

        // 合法的新回執仍可完成確認：建立成功，後續修改到 revision 2。
        const createRound = await tabB.sync.syncArticles();
        assert.equal(createRound.ok, true, JSON.stringify(createRound));
        assert.equal(server.state.articles.get(articleId).revision, 1);
        assert.equal(tabB.store.getRecord(articleId).revision, 1);
        assert.equal(tabB.store.getRecord(articleId).generation, 1);
        assert.equal(await outboxRow(scope, articleId), null);

        assert.equal((await tabB.store.saveArticle({ articleId, title: 'Title', article: 'b-v6' })).ok, true);
        const finalRound = await tabB.sync.syncArticles();
        assert.equal(finalRound.ok, true, JSON.stringify(finalRound));
        assert.equal(finalRound.pushed.conflicts, 0, JSON.stringify(finalRound.pushed));
        assert.equal(server.state.articles.get(articleId).body, 'b-v6');
        assert.equal(server.state.articles.get(articleId).revision, 2);
        assert.equal(tabB.store.getRecord(articleId).revision, 2);
        assert.equal(tabB.store.getConflicts().length, 0, JSON.stringify(tabB.store.getConflicts()));
        assert.notEqual(server.state.articles.get(articleId).updatedAt, staleUpdatedAt);
    } finally {
        server.state.hooks.afterPut = null;
        globalThis.fetch = undefined;
    }
});

test('重建完成、outbox 已清後才回來的舊回執（markOpsDone）：不得復活舊版本', async (t) => {
    const context = newContext('tab-stale-receipt-after');
    const { server } = context;
    const articleId = 'cross-stale-after';
    try {
        const scope = await seedRevision3(context, articleId);

        // 分頁 B 送出 v4：伺服器提交成 revision 4，回應暫扣。
        let releasePut;
        let putArrived;
        const putGate = new Promise((resolve) => { releasePut = resolve; });
        const putReady = new Promise((resolve) => { putArrived = resolve; });
        // 斷言失敗時也要放行暫扣的回應，否則測試會以逾時收尾（看不出真正原因）。
        t.after(() => releasePut());
        server.state.hooks.afterPut = async ({ id }) => {
            if (id !== articleId) return;
            putArrived();
            await putGate;
        };
        assert.equal((await tabB.store.saveArticle({ articleId, title: 'Title', article: 'b-v4' })).ok, true);
        const staleOp = await outboxRow(scope, articleId);
        assert.equal(Number(staleOp.generation), 0, JSON.stringify(staleOp));
        const bSync = tabB.sync.syncArticles();
        // 斷言失敗後才放行的同步會 reject，避免變成未處理的 rejection。
        bSync.catch(() => {});
        await putReady;
        const staleUpdatedAt = server.state.articles.get(articleId).updatedAt;
        assert.equal(Number(staleUpdatedAt ? 4 : 0), 4);

        // 分頁 A：404 重建，並在同一輪建立成功（outbox 已清、遠端 revision 1）。
        server.state.articles.delete(articleId);
        assert.equal((await tabA.store.saveArticle({ articleId, title: 'Title', article: 'a-v5' })).ok, true);
        assert.equal((await tabA.sync.syncArticles()).ok, true);
        assert.equal((await tabA.sync.syncArticles()).ok, true);
        assert.equal(await outboxRow(scope, articleId), null);
        assert.equal(server.state.articles.get(articleId).revision, 1);
        const completed = await docRow(scope, articleId);
        assert.equal(Number(completed.revision), 1);
        assert.equal(Number(completed.generation), 1);
        const completedUpdatedAt = completed.updatedAt;

        // 舊回執（批次核對）在重建完成、outbox 已清後才回來。
        const stale = await tabB.store.markOpsDone([{
            articleId,
            revision: 4,
            serverUpdatedAt: staleUpdatedAt,
            clientMutationId: staleOp.clientMutationId,
            generation: staleOp.generation
        }]);
        assert.equal(stale.ok, true, JSON.stringify(stale));
        const afterBatch = await docRow(scope, articleId);
        assert.equal(Number(afterBatch.revision), 1, 'outbox 清空後舊回執仍復活舊 revision');
        assert.equal(afterBatch.updatedAt, completedUpdatedAt, '舊回執改寫了 updatedAt');
        assert.equal(Number(afterBatch.generation), 1);
        assert.equal(await outboxRow(scope, articleId), null, '舊回執復活了已完成的 outbox');

        // 真正的分頁 B 回應此時才放行（走 markOpDone）：同樣必須被忽略。
        releasePut();
        const bRound = await bSync;
        assert.equal(bRound.ok, true, JSON.stringify(bRound));
        const afterRelease = await docRow(scope, articleId);
        assert.equal(Number(afterRelease.revision), 1, '遲到的 markOpDone 把 revision 推回 4');
        assert.equal(afterRelease.updatedAt, completedUpdatedAt);
        assert.equal(Number(afterRelease.generation), 1);

        // 下一次保存仍然用 revision 1 當基準：不再假衝突。
        assert.equal((await tabB.store.saveArticle({ articleId, title: 'Title', article: 'b-v6' })).ok, true);
        assert.equal(Number((await outboxRow(scope, articleId)).expectedRevision), 1);
        const round = await tabB.sync.syncArticles();
        assert.equal(round.ok, true, JSON.stringify(round));
        assert.equal(round.pushed.conflicts, 0, JSON.stringify(round.pushed));
        assert.equal(server.state.articles.get(articleId).body, 'b-v6');
        assert.equal(server.state.articles.get(articleId).revision, 2);
        assert.equal(tabB.store.getRecord(articleId).revision, 2);
        assert.equal(tabB.store.getConflicts().length, 0, JSON.stringify(tabB.store.getConflicts()));
    } finally {
        server.state.hooks.afterPut = null;
        globalThis.fetch = undefined;
    }
});

test('同代際的合法舊回執仍會確認先前提交並 rebase 新修改', async (t) => {
    const context = newContext('tab-same-generation-rebase');
    const { server } = context;
    const articleId = 'cross-same-generation';
    try {
        const scope = await seedRevision3(context, articleId);

        // 分頁 B 送出 v4（回應暫扣），等待期間在同一代際再保存 v5。
        let releasePut;
        let putArrived;
        const putGate = new Promise((resolve) => { releasePut = resolve; });
        const putReady = new Promise((resolve) => { putArrived = resolve; });
        // 斷言失敗時也要放行暫扣的回應，否則測試會以逾時收尾（看不出真正原因）。
        t.after(() => releasePut());
        server.state.hooks.afterPut = async ({ id }) => {
            if (id !== articleId) return;
            putArrived();
            await putGate;
        };
        assert.equal((await tabB.store.saveArticle({ articleId, title: 'Title', article: 'b-v4' })).ok, true);
        const bSync = tabB.sync.syncArticles();
        // 斷言失敗後才放行的同步會 reject，避免變成未處理的 rejection。
        bSync.catch(() => {});
        await putReady;
        assert.equal((await tabB.store.saveArticle({ articleId, title: 'Title', article: 'b-v5' })).ok, true);
        releasePut();
        assert.equal((await bSync).ok, true);

        // 同代際的舊回執必須保留新操作，並把基準推進到伺服器版本（4）。
        const rebased = await outboxRow(scope, articleId);
        assert.equal(rebased.type, 'update', JSON.stringify(rebased));
        assert.equal(Number(rebased.expectedRevision), 4, JSON.stringify(rebased));
        assert.equal(Number(rebased.generation), 0);
        assert.equal(rebased.payload.body, 'b-v5');
        assert.equal(server.state.articles.get(articleId).revision, 4);

        const round = await tabB.sync.syncArticles();
        assert.equal(round.ok, true, JSON.stringify(round));
        assert.equal(round.pushed.conflicts, 0, JSON.stringify(round.pushed));
        assert.equal(server.state.articles.get(articleId).body, 'b-v5');
        assert.equal(server.state.articles.get(articleId).revision, 5);
        assert.equal(tabB.store.getRecord(articleId).revision, 5);
        assert.equal(await outboxRow(scope, articleId), null);
    } finally {
        server.state.hooks.afterPut = null;
        globalThis.fetch = undefined;
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 第七輪缺口 1：第二次重建不得重用上一個代際
// ─────────────────────────────────────────────────────────────────────────────

test('第二次重建：以持久化文件與 404 操作代際換到 generation 2，舊回執失效', async (t) => {
    const context = newContext('tab-second-rebuild');
    const { server } = context;
    const articleId = 'cross-second-rebuild';
    try {
        const scope = await seedRevision3(context, articleId);

        // 分頁 B 保存後開始同步，但停在 pull 等待（記憶體仍是 generation 0 / revision 3）。
        let releasePull;
        let pullArrived;
        const pullGate = new Promise((resolve) => { releasePull = resolve; });
        const pullReady = new Promise((resolve) => { pullArrived = resolve; });
        // 斷言失敗時也要放行暫扣的回應，否則測試會以逾時收尾。
        t.after(() => releasePull());
        let blockNextPull = true;
        server.state.hooks.beforePull = async () => {
            if (!blockNextPull) return;
            blockNextPull = false;
            pullArrived();
            await pullGate;
        };
        assert.equal((await tabB.store.saveArticle({ articleId, title: 'Title', article: 'b-v4' })).ok, true);
        const bSync = tabB.sync.syncArticles();
        bSync.catch(() => {});
        await pullReady;

        // 分頁 A：第一次重建（generation 1）→ 建立成功 → 保存更新正文 → PUT
        // 已提交但回應暫扣（它的回執屬於 generation 1）。
        server.state.articles.delete(articleId);
        assert.equal((await tabA.store.saveArticle({ articleId, title: 'Title', article: 'a-v5' })).ok, true);
        assert.equal((await tabA.sync.syncArticles()).ok, true);
        assert.equal((await tabA.sync.syncArticles()).ok, true);
        assert.equal(server.state.articles.get(articleId).revision, 1);
        assert.equal(Number((await docRow(scope, articleId)).generation), 1);
        assert.equal(await outboxRow(scope, articleId), null);

        let releasePut;
        let putArrived;
        const putGate = new Promise((resolve) => { releasePut = resolve; });
        const putReady = new Promise((resolve) => { putArrived = resolve; });
        t.after(() => releasePut());
        server.state.hooks.afterPut = async ({ id }) => {
            if (id !== articleId) return;
            putArrived();
            await putGate;
        };
        assert.equal((await tabA.store.saveArticle({ articleId, title: 'Title', article: 'a-v6' })).ok, true);
        const staleOp = await outboxRow(scope, articleId);
        assert.equal(Number(staleOp.generation), 1, JSON.stringify(staleOp));
        const aSync = tabA.sync.syncArticles();
        aSync.catch(() => {});
        await putReady;
        // 暫扣只針對 B 這一個 PUT；後續 restore 流程的 PUT 不能再被同一個 gate 擋住。
        server.state.hooks.afterPut = null;
        assert.equal(server.state.articles.get(articleId).revision, 2);
        const staleUpdatedAt = server.state.articles.get(articleId).updatedAt;

        // 遠端再次消失後才放行 B（B 仍在舊記憶體上處理這次 404）。
        server.state.articles.delete(articleId);
        server.state.hooks.beforePull = null;
        releasePull();
        assert.equal((await bSync).ok, true);

        const secondRebuild = await docRow(scope, articleId);
        assert.equal(Number(secondRebuild.generation), 2, '第二次重建重用了上一個代際');
        assert.equal(Number(secondRebuild.revision), 0);
        assert.equal(secondRebuild.body, 'a-v6', '第二次重建把正文退回舊分頁的內容');
        assert.equal(Number((await summaryRow(scope, articleId)).generation), 2);
        const secondOp = await outboxRow(scope, articleId);
        assert.equal(secondOp.type, 'create', JSON.stringify(secondOp));
        assert.equal(Number(secondOp.expectedRevision), 0, JSON.stringify(secondOp));
        assert.equal(Number(secondOp.generation), 2, JSON.stringify(secondOp));
        assert.equal(secondOp.payload.body, 'a-v6');

        // 兩種確認 API 都不能讓 generation 1 的回執改動文件或 outbox。
        const receipt = {
            articleId,
            revision: 2,
            serverUpdatedAt: staleUpdatedAt,
            clientMutationId: staleOp.clientMutationId,
            generation: 1
        };
        const batch = await tabA.store.markOpsDone([receipt]);
        assert.equal(batch.ok, true, JSON.stringify(batch));
        let current = await docRow(scope, articleId);
        assert.equal(Number(current.revision), 0, 'markOpsDone 把第二次重建的版本推回去了');
        assert.equal(current.updatedAt, secondRebuild.updatedAt, 'markOpsDone 改寫了 updatedAt');
        assert.equal(Number(current.generation), 2);
        let pending = await outboxRow(scope, articleId);
        assert.equal(pending.type, 'create', 'markOpsDone 把待建立操作改成 update');
        assert.equal(Number(pending.expectedRevision), 0, JSON.stringify(pending));

        const single = await tabA.store.markOpDone(articleId, receipt);
        assert.equal(single.ok, true, JSON.stringify(single));
        current = await docRow(scope, articleId);
        assert.equal(Number(current.revision), 0, 'markOpDone 把第二次重建的版本推回去了');
        assert.equal(current.updatedAt, secondRebuild.updatedAt);
        assert.equal(Number(current.generation), 2);
        pending = await outboxRow(scope, articleId);
        assert.equal(pending.type, 'create');
        assert.equal(Number(pending.expectedRevision), 0);

        // 真正的舊 PUT 回應此時才放行：同樣必須被忽略。
        releasePut();
        assert.equal((await aSync).ok, true);
        current = await docRow(scope, articleId);
        assert.equal(Number(current.revision), 0);
        assert.equal(current.updatedAt, secondRebuild.updatedAt);
        assert.equal(Number(current.generation), 2);

        // 後續建立、更新都要成功。
        const createRound = await tabB.sync.syncArticles();
        assert.equal(createRound.ok, true, JSON.stringify(createRound));
        assert.equal(createRound.pushed.conflicts, 0, JSON.stringify(createRound.pushed));
        assert.equal(server.state.articles.get(articleId).revision, 1);
        assert.equal(server.state.articles.get(articleId).body, 'a-v6');
        assert.equal(tabB.store.getRecord(articleId).generation, 2);
        assert.equal(tabB.store.getRecord(articleId).revision, 1);
        assert.equal(await outboxRow(scope, articleId), null);

        assert.equal((await tabB.store.saveArticle({ articleId, title: 'Title', article: 'b-v7' })).ok, true);
        const updateRound = await tabB.sync.syncArticles();
        assert.equal(updateRound.ok, true, JSON.stringify(updateRound));
        assert.equal(updateRound.pushed.conflicts, 0, JSON.stringify(updateRound.pushed));
        assert.equal(server.state.articles.get(articleId).revision, 2);
        assert.equal(server.state.articles.get(articleId).body, 'b-v7');
        assert.equal(tabB.store.getConflicts().length, 0, JSON.stringify(tabB.store.getConflicts()));
    } finally {
        server.state.hooks.beforePull = null;
        server.state.hooks.afterPut = null;
        globalThis.fetch = undefined;
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 第七輪缺口 2：刪除待建立文章的捷徑不得倒退代際
// ─────────────────────────────────────────────────────────────────────────────

test('刪除待建立的舊代際文章：交易內採用持久化代際，舊回執不再生效', async () => {
    const context = newContext('tab-delete-pending-create');
    const { server } = context;
    const articleId = 'cross-delete-create';
    try {
        const scope = await seedRevision3(context, articleId);

        // 分頁 A 第一次重建（generation 1 / revision 0），分頁 B 重新載入並保持全文
        // 記錄（已開啟過文章；刪除時不會再從儲存補全文）。
        server.state.articles.delete(articleId);
        assert.equal((await tabA.store.saveArticle({ articleId, title: 'Title', article: 'a-v4' })).ok, true);
        assert.equal((await tabA.sync.syncArticles()).ok, true);
        await tabB.store.reloadScope(scope);
        await tabB.store.ensureArticleLoaded(articleId);
        assert.equal(tabB.store.getRecord(articleId).summaryOnly, false);
        assert.equal(Number(tabB.store.getRecord(articleId).generation), 1);
        assert.equal(Number(tabB.store.getRecord(articleId).revision), 0);

        // 分頁 A 完成建立（generation 1 / revision 1），然後再次重建。
        assert.equal((await tabA.sync.syncArticles()).ok, true);
        assert.equal(server.state.articles.get(articleId).revision, 1);

        // 分頁 A 再次重建：持久化三處已到 generation 2（建立尚未送出）。
        server.state.articles.delete(articleId);
        assert.equal((await tabA.store.saveArticle({ articleId, title: 'Title', article: 'a-v5' })).ok, true);
        const staleOp = await outboxRow(scope, articleId);
        assert.equal(Number(staleOp.generation), 1, JSON.stringify(staleOp));
        const rebuildRound = await tabA.sync.syncArticles();
        assert.equal(rebuildRound.ok, true, JSON.stringify(rebuildRound));
        const rebuilt = await docRow(scope, articleId);
        assert.equal(Number(rebuilt.generation), 2, '第二次重建沒有前進代際');
        assert.equal(Number(rebuilt.revision), 0);
        assert.equal(Number((await summaryRow(scope, articleId)).generation), 2);
        const pendingCreate = await outboxRow(scope, articleId);
        assert.equal(pendingCreate.type, 'create');
        assert.equal(Number(pendingCreate.generation), 2);
        assert.equal(Number(await ledgerGeneration(scope, articleId)), 2);

        // 分頁 B 不重新載入（記憶體仍是 generation 1 / revision 0）直接刪除。
        const deleted = await tabB.store.deleteArticle(articleId);
        assert.equal(deleted.ok, true, JSON.stringify(deleted));
        const afterDelete = await docRow(scope, articleId);
        assert.equal(Number(afterDelete.generation), 2, '刪除捷徑把代際寫回舊記憶體版本');
        assert.equal(Number(afterDelete.revision), 0);
        assert.ok(afterDelete.deletedAt);
        assert.equal(Number((await summaryRow(scope, articleId)).generation), 2);
        assert.equal(await outboxRow(scope, articleId), null, '刪除捷徑沒有撤掉目前的 create');
        assert.equal(Number(await ledgerGeneration(scope, articleId)), 2);

        // 舊代際回執（單筆與批次）都不得改動 tombstone。
        const receipt = {
            articleId,
            revision: 4,
            serverUpdatedAt: '2020-01-01T00:00:00.000Z',
            clientMutationId: staleOp.clientMutationId,
            generation: 1
        };
        const batch = await tabA.store.markOpsDone([receipt]);
        assert.equal(batch.ok, true, JSON.stringify(batch));
        const single = await tabA.store.markOpDone(articleId, receipt);
        assert.equal(single.ok, true, JSON.stringify(single));
        const afterReceipt = await docRow(scope, articleId);
        assert.equal(Number(afterReceipt.revision), 0, '舊回執把 tombstone 的版本推高了');
        assert.equal(afterReceipt.updatedAt, afterDelete.updatedAt, '舊回執改寫了 tombstone 時間');
        assert.equal(Number(afterReceipt.generation), 2);
        assert.equal(await outboxRow(scope, articleId), null);

        // 復原與後續同步都要正常（create → update）。
        const restored = await tabB.store.restoreArticle(tabB.store.getRecord(articleId));
        assert.equal(restored.ok, true, JSON.stringify(restored));
        assert.equal(Number((await docRow(scope, articleId)).generation), 2);
        const createOp = await outboxRow(scope, articleId);
        assert.equal(createOp.type, 'create');
        assert.equal(Number(createOp.generation), 2);
        const createRound = await tabB.sync.syncArticles();
        assert.equal(createRound.ok, true, JSON.stringify(createRound));
        assert.equal(createRound.pushed.conflicts, 0, JSON.stringify(createRound.pushed));
        assert.equal(server.state.articles.get(articleId).revision, 1);
        assert.equal(server.state.articles.get(articleId).body, 'a-v5');
        assert.equal(await outboxRow(scope, articleId), null);

        assert.equal((await tabB.store.saveArticle({ articleId, title: 'Title', article: 'b-v6' })).ok, true);
        const updateRound = await tabB.sync.syncArticles();
        assert.equal(updateRound.ok, true, JSON.stringify(updateRound));
        assert.equal(updateRound.pushed.conflicts, 0, JSON.stringify(updateRound.pushed));
        assert.equal(server.state.articles.get(articleId).revision, 2);
        assert.equal(server.state.articles.get(articleId).body, 'b-v6');
        assert.equal(tabB.store.getConflicts().length, 0, JSON.stringify(tabB.store.getConflicts()));
    } finally {
        globalThis.fetch = undefined;
    }
});

test('localStorage 後備：刪除待建立文章同樣遵守持久化代際', async () => {
    const user = 'tab-fallback-delete';
    const scope = scopeFor(user);
    startScope(user);
    const articleId = 'fallback-delete-create';
    const savedIndexedDB = globalThis.indexedDB;
    let f1;
    let f2;
    try {
        globalThis.indexedDB = undefined;
        f1 = await bootTab('f1');
        f2 = await bootTab('f2');
        await f1.store.reloadScope(scope);
        await f2.store.reloadScope(scope);
    } finally {
        globalThis.indexedDB = savedIndexedDB;
    }

    assert.equal((await f1.store.saveArticle({ articleId, title: 'Title', article: 'f-v1' })).ok, true);
    assert.equal((await f1.store.setBaseRevision(articleId, 3)).ok, true);

    // 第一次「404 重建」→ generation 1，B 重新載入後停在 generation 1 / revision 0。
    assert.equal((await f1.store.requeueAsCreate(articleId)).ok, true);
    await f2.store.reloadScope(scope);
    await f2.store.ensureArticleLoaded(articleId);
    assert.equal(f2.store.getRecord(articleId).summaryOnly, false);
    assert.equal(Number(f2.store.getRecord(articleId).generation), 1);
    assert.equal(Number(f2.store.getRecord(articleId).revision), 0);

    // 第二次重建 → 文件、ledger 都是 generation 2。
    assert.equal((await f1.store.requeueAsCreate(articleId)).ok, true);
    let bucket = fallbackBucket(scope);
    assert.equal(Number(bucket.docs.find((item) => item.id === articleId).generation), 2);
    assert.equal(Number((bucket.generations || {})[articleId]), 2);

    // 分頁 B 用舊記憶體（generation 1）刪除：tombstone 與 ledger 必須維持 2。
    const deleted = await f2.store.deleteArticle(articleId);
    assert.equal(deleted.ok, true, JSON.stringify(deleted));
    bucket = fallbackBucket(scope);
    const doc = bucket.docs.find((item) => item.id === articleId);
    assert.ok(doc.deletedAt);
    assert.equal(Number(doc.generation), 2, '後備刪除把代際寫回舊記憶體版本');
    assert.equal(Number(doc.revision), 0);
    assert.equal(bucket.outbox.filter((op) => op.articleId === articleId).length, 0);
    assert.equal(Number((bucket.generations || {})[articleId]), 2);

    // 重新載入（後備模式）後代際仍是 2，不會回退。
    await f2.store.reloadScope(scope);
    assert.equal(Number(f2.store.getRecord(articleId).generation), 2);
    assert.equal(Number(f2.store.getRecord(articleId).revision), 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 第七輪缺口 3：代際屏障必須跨越文件移除與同 ID 還原
// ─────────────────────────────────────────────────────────────────────────────

function stripGeneration(documents) {
    return documents.map(({ generation, ...rest }) => rest);
}

test('完整 pull 移除文件後以舊備份還原：代際由 ledger 接手，延遲回執失效', async (t) => {
    const context = newContext('tab-ledger-restore');
    const { server } = context;
    const articleId = 'cross-ledger-restore';
    try {
        const scope = await seedRevision3(context, articleId);

        // 分頁 B 送出 v4：伺服器已提交 revision 4，回應暫扣（generation 0 回執）。
        let releasePut;
        let putArrived;
        const putGate = new Promise((resolve) => { releasePut = resolve; });
        const putReady = new Promise((resolve) => { putArrived = resolve; });
        t.after(() => releasePut());
        server.state.hooks.afterPut = async ({ id }) => {
            if (id !== articleId) return;
            putArrived();
            await putGate;
        };
        assert.equal((await tabB.store.saveArticle({ articleId, title: 'Title', article: 'b-v4' })).ok, true);
        const staleOp = await outboxRow(scope, articleId);
        assert.equal(Number(staleOp.generation), 0);
        const bSync = tabB.sync.syncArticles();
        bSync.catch(() => {});
        await putReady;
        const staleUpdatedAt = server.state.articles.get(articleId).updatedAt;
        assert.equal(server.state.articles.get(articleId).revision, 4);

        // 分頁 A：第一次重建 gen 1 → 建立成功（遠端 revision 1）。
        server.state.articles.delete(articleId);
        assert.equal((await tabA.store.saveArticle({ articleId, title: 'Title', article: 'a-v5' })).ok, true);
        assert.equal((await tabA.sync.syncArticles()).ok, true);
        assert.equal((await tabA.sync.syncArticles()).ok, true);
        assert.equal(server.state.articles.get(articleId).revision, 1);
        const rebuildDoc = await docRow(scope, articleId);
        assert.equal(Number(rebuildDoc.generation), 1);
        assert.equal(Number(await ledgerGeneration(scope, articleId)), 1);

        // 匯出一份「沒有 generation」的舊格式備份。
        const backup = stripGeneration(await tabA.store.exportDocuments());
        assert.equal(backup.length, 1);
        assert.equal(backup[0].generation, undefined);

        // 遠端再次清空 → resetRequired → 完整 pull 移除本機文件。
        // 遠端已沒有這篇：ledger 保留屏障並前進一代（1 → 2），舊生命週期的
        // 回執因此無法匹配任何之後的同 ID 還原。
        server.state.articles.clear();
        server.state.resetRequired = true;
        assert.equal((await tabA.sync.syncArticles()).ok, true);
        server.state.resetRequired = false;
        assert.equal(await docRow(scope, articleId), null, '完整 pull 沒有移除文件');
        assert.equal(Number(await ledgerGeneration(scope, articleId)), 2, '文件移除時沒有保留並推進 ledger');

        // 用舊備份還原同一 ID：必須採用 ledger 的 generation 2。
        const imported = await tabA.store.importDocuments(backup);
        assert.equal(imported.ok, true, JSON.stringify(imported));
        const restored = await docRow(scope, articleId);
        assert.equal(Number(restored.generation), 2, '還原後代際從 0 重新開始');
        assert.equal(Number(restored.revision), 0);
        assert.equal(restored.body, 'a-v5');
        assert.equal(Number((await summaryRow(scope, articleId)).generation), 2);
        const restoreOp = await outboxRow(scope, articleId);
        assert.equal(restoreOp.type, 'create', JSON.stringify(restoreOp));
        assert.equal(Number(restoreOp.generation), 2);
        assert.equal(Number(restoreOp.expectedRevision), 0);

        // 重建前暫扣的 generation 0 回執：單筆與批次都不得改動還原後的文件。
        const staleReceipt = {
            articleId,
            revision: 4,
            serverUpdatedAt: staleUpdatedAt,
            clientMutationId: staleOp.clientMutationId,
            generation: 0
        };
        const batch = await tabA.store.markOpsDone([staleReceipt]);
        assert.equal(batch.ok, true, JSON.stringify(batch));
        const single = await tabA.store.markOpDone(articleId, staleReceipt);
        assert.equal(single.ok, true, JSON.stringify(single));
        let afterReceipt = await docRow(scope, articleId);
        assert.equal(Number(afterReceipt.revision), 0, '舊回執把還原後的版本推高了');
        assert.equal(Number(afterReceipt.generation), 2);
        let pending = await outboxRow(scope, articleId);
        assert.equal(pending.type, 'create', '舊回執把還原後的建立改成 update');
        assert.equal(Number(pending.expectedRevision), 0, JSON.stringify(pending));

        // 放行 B 真正的舊 PUT 回應（也是 generation 0）。
        releasePut();
        assert.equal((await bSync).ok, true);
        afterReceipt = await docRow(scope, articleId);
        assert.equal(Number(afterReceipt.revision), 0);
        assert.equal(Number(afterReceipt.generation), 2);

        // 還原後建立成功，後續更新也成功。
        const createRound = await tabA.sync.syncArticles();
        assert.equal(createRound.ok, true, JSON.stringify(createRound));
        assert.equal(createRound.pushed.conflicts, 0, JSON.stringify(createRound.pushed));
        assert.equal(server.state.articles.get(articleId).revision, 1);
        assert.equal(server.state.articles.get(articleId).body, 'a-v5');
        assert.equal(await outboxRow(scope, articleId), null);

        assert.equal((await tabA.store.saveArticle({ articleId, title: 'Title', article: 'a-v6' })).ok, true);
        const updateRound = await tabA.sync.syncArticles();
        assert.equal(updateRound.ok, true, JSON.stringify(updateRound));
        assert.equal(updateRound.pushed.conflicts, 0, JSON.stringify(updateRound.pushed));
        assert.equal(server.state.articles.get(articleId).revision, 2);

        // 第二次重建 → generation 3，建立成功後再移除文件並以舊格式備份還原。
        server.state.articles.delete(articleId);
        assert.equal((await tabA.store.saveArticle({ articleId, title: 'Title', article: 'a-v7' })).ok, true);
        assert.equal((await tabA.sync.syncArticles()).ok, true);
        const secondRebuild = await docRow(scope, articleId);
        assert.equal(Number(secondRebuild.generation), 3);
        assert.equal(Number(secondRebuild.revision), 0);
        assert.equal((await tabA.sync.syncArticles()).ok, true);
        assert.equal(server.state.articles.get(articleId).revision, 1);
        const secondBackup = stripGeneration(await tabA.store.exportDocuments());
        assert.equal(secondBackup[0].generation, undefined);

        server.state.articles.clear();
        server.state.resetRequired = true;
        assert.equal((await tabA.sync.syncArticles()).ok, true);
        server.state.resetRequired = false;
        assert.equal(await docRow(scope, articleId), null);
        assert.equal(Number(await ledgerGeneration(scope, articleId)), 4);

        const reimported = await tabA.store.importDocuments(secondBackup);
        assert.equal(reimported.ok, true, JSON.stringify(reimported));
        const restoredAgain = await docRow(scope, articleId);
        assert.equal(Number(restoredAgain.generation), 4, '第二次還原採用了較低的代際');
        assert.equal(Number(restoredAgain.revision), 0);
        const ledgerOp = await outboxRow(scope, articleId);
        assert.equal(ledgerOp.type, 'create');
        assert.equal(Number(ledgerOp.generation), 4);

        // 上一代際（generation 1）的回執同樣不得生效。
        const oldReceipt = {
            articleId,
            revision: 1,
            serverUpdatedAt: secondRebuild.updatedAt,
            clientMutationId: restoreOp.clientMutationId,
            generation: 1
        };
        const oldBatch = await tabA.store.markOpsDone([oldReceipt]);
        assert.equal(oldBatch.ok, true, JSON.stringify(oldBatch));
        const oldSingle = await tabA.store.markOpDone(articleId, oldReceipt);
        assert.equal(oldSingle.ok, true, JSON.stringify(oldSingle));
        const finalDoc = await docRow(scope, articleId);
        assert.equal(Number(finalDoc.revision), 0);
        assert.equal(Number(finalDoc.generation), 4);
        pending = await outboxRow(scope, articleId);
        assert.equal(pending.type, 'create');
        assert.equal(Number(pending.expectedRevision), 0);

        const finalRound = await tabA.sync.syncArticles();
        assert.equal(finalRound.ok, true, JSON.stringify(finalRound));
        assert.equal(finalRound.pushed.conflicts, 0, JSON.stringify(finalRound.pushed));
        assert.equal(server.state.articles.get(articleId).revision, 1);
        assert.equal(server.state.articles.get(articleId).body, 'a-v7');
    } finally {
        server.state.hooks.afterPut = null;
        server.state.resetRequired = false;
        globalThis.fetch = undefined;
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 第七輪缺口 4：升級前的 supersededMutations 不得截斷
// ─────────────────────────────────────────────────────────────────────────────

test('升級前的 supersededMutations 完整保留：單筆與批次確認都不得復活舊版本', async () => {
    const context = newContext('tab-legacy-superseded');
    const articleId = 'cross-legacy-superseded';
    try {
        const scope = await seedScopeOnly(context);
        assert.equal((await tabA.store.saveArticle({ articleId, title: 'Title', article: 'legacy-v1' })).ok, true);
        const seedOp = await outboxRow(scope, articleId);
        const superseded = Array.from({ length: 9 }, (_, index) => `legacy-mutation-${index + 1}`);
        // 模擬升級前就已存在的 outbox：文件與操作都是 generation 0，清單有 9 筆。
        await writeOutboxRow({
            ...seedOp,
            type: 'create',
            expectedRevision: 0,
            generation: 0,
            supersededMutations: superseded
        });
        const before = await docRow(scope, articleId);
        assert.equal(Number(before.revision), 0);

        // 清單第一筆不在「末 8 筆」內：截斷實作會讓它重新生效。
        const receipt = {
            articleId,
            revision: 40,
            serverUpdatedAt: '2020-01-01T00:00:00.000Z',
            clientMutationId: superseded[0],
            generation: 0
        };
        const single = await tabA.store.markOpDone(articleId, receipt);
        assert.equal(single.ok, true, JSON.stringify(single));
        let doc = await docRow(scope, articleId);
        assert.equal(Number(doc.revision), 0, '被列入黑名單的舊回執把版本推高了');
        assert.equal(doc.updatedAt, before.updatedAt);
        let pending = await outboxRow(scope, articleId);
        assert.equal(pending.type, 'create', JSON.stringify(pending));
        assert.equal(Number(pending.expectedRevision), 0, JSON.stringify(pending));

        // 新流程保存時必須完整繼承清單，且不再累加。
        assert.equal((await tabA.store.saveArticle({ articleId, title: 'Title', article: 'legacy-v2' })).ok, true);
        let saved = await outboxRow(scope, articleId);
        assert.equal(saved.supersededMutations.length, 9, '保存時截掉了升級前的舊操作');
        assert.deepEqual(saved.supersededMutations, superseded);
        doc = await docRow(scope, articleId);
        assert.equal(doc.body, 'legacy-v2');
        const savedAt = doc.updatedAt;

        // 批次確認（單筆與多筆）都必須完整比對整份清單。
        const batch = await tabA.store.markOpsDone([
            { ...receipt, clientMutationId: superseded[0] },
            { ...receipt, clientMutationId: superseded[1] }
        ]);
        assert.equal(batch.ok, true, JSON.stringify(batch));
        doc = await docRow(scope, articleId);
        assert.equal(Number(doc.revision), 0, '批次確認把版本推高了');
        assert.equal(doc.updatedAt, savedAt);
        pending = await outboxRow(scope, articleId);
        assert.equal(pending.type, 'create');
        assert.equal(Number(pending.expectedRevision), 0);
        assert.equal(pending.supersededMutations.length, 9);

        // 再保存一次仍不累加、不截斷。
        assert.equal((await tabA.store.saveArticle({ articleId, title: 'Title', article: 'legacy-v3' })).ok, true);
        saved = await outboxRow(scope, articleId);
        assert.equal(saved.supersededMutations.length, 9);
        assert.deepEqual(saved.supersededMutations, superseded);
    } finally {
        globalThis.fetch = undefined;
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 第八輪缺口 1：遠端移除必須結束上一個生命週期（ledger 前進）
// ─────────────────────────────────────────────────────────────────────────────

function patchFallbackBucket(scope, mutate) {
    const bucket = fallbackBucket(scope);
    mutate(bucket);
    localStorage.setItem(`bdc:articles:fallback:v1:${scope}`, JSON.stringify(bucket));
}

test('遠端移除後以新格式備份還原：代際前進，延遲回執（單筆／批次）不得改動還原文件', async (t) => {
    const context = newContext('tab-retire-generation');
    const { server } = context;
    const articleId = 'cross-retire-generation';
    try {
        const scope = await seedRevision3(context, articleId);

        // 分頁 A：404 重建到 generation 1，再建立成功（遠端 revision 1）。
        server.state.articles.delete(articleId);
        assert.equal((await tabA.store.saveArticle({ articleId, title: 'Title', article: 'a-v4' })).ok, true);
        assert.equal((await tabA.sync.syncArticles()).ok, true);
        assert.equal((await tabA.sync.syncArticles()).ok, true);
        assert.equal(server.state.articles.get(articleId).revision, 1);
        assert.equal(Number((await docRow(scope, articleId)).generation), 1);

        // 分頁 B：保存後送出 PUT（伺服器提交成 revision 2），但回應暫扣。
        let releasePut;
        let putArrived;
        const putGate = new Promise((resolve) => { releasePut = resolve; });
        const putReady = new Promise((resolve) => { putArrived = resolve; });
        t.after(() => releasePut());
        server.state.hooks.afterPut = async ({ id }) => {
            if (id !== articleId) return;
            putArrived();
            await putGate;
        };
        assert.equal((await tabB.store.saveArticle({ articleId, title: 'Title', article: 'b-v5' })).ok, true);
        const staleOp = await outboxRow(scope, articleId);
        assert.equal(Number(staleOp.generation), 1, JSON.stringify(staleOp));
        const bSync = tabB.sync.syncArticles();
        bSync.catch(() => {});
        await putReady;
        // 暫扣只針對 B 這一個 PUT；後續 restore 流程的 PUT 不能再被同一個 gate 擋住。
        server.state.hooks.afterPut = null;
        assert.equal(server.state.articles.get(articleId).revision, 2);
        assert.equal(server.state.articles.get(articleId).body, 'b-v5');
        const staleUpdatedAt = server.state.articles.get(articleId).updatedAt;

        // 分頁 A 重試同一個 mutation：伺服器以冪等成功回應（版本不變），
        // A 因此把 outbox 清掉。這正是複審時序：回應暫扣的 PUT 已提交。
        const retryRound = await tabA.sync.syncArticles();
        assert.equal(retryRound.ok, true, JSON.stringify(retryRound));
        assert.equal(server.state.articles.get(articleId).revision, 2);
        assert.equal(await outboxRow(scope, articleId), null, '冪等重試沒有清掉 outbox');
        const settled = await docRow(scope, articleId);
        assert.equal(Number(settled.revision), 2);
        assert.equal(settled.body, 'b-v5', '冪等重試用舊正文覆蓋了另一分頁的內容');

        // 匯出本版本備份（generation 1 / revision 2）。
        const backup = await tabA.store.exportDocuments();
        assert.equal(Number(backup[0].generation), 1);
        assert.equal(Number(backup[0].revision), 2);
        assert.equal(backup[0].body, 'b-v5');

        // 遠端清空 → resetRequired → 完整 pull 移除本機文件：代際必須前進。
        server.state.articles.clear();
        server.state.resetRequired = true;
        assert.equal((await tabA.sync.syncArticles()).ok, true);
        server.state.resetRequired = false;
        assert.equal(await docRow(scope, articleId), null, '完整 pull 沒有移除文件');
        assert.equal(Number(await ledgerGeneration(scope, articleId)), 2, '遠端移除沒有結束上一個生命週期');

        // 以同 ID 還原：採用更高的 generation，revision 必須從 0 開始。
        const imported = await tabA.store.importDocuments(backup);
        assert.equal(imported.ok, true, JSON.stringify(imported));
        const restored = await docRow(scope, articleId);
        assert.equal(Number(restored.generation), 2, '還原採用了上一個生命週期的代際');
        assert.equal(Number(restored.revision), 0, '還原繼承了上一個生命週期的 revision');
        assert.equal(restored.body, 'b-v5');
        assert.equal(Number((await summaryRow(scope, articleId)).generation), 2);
        const restoreOp = await outboxRow(scope, articleId);
        assert.equal(restoreOp.type, 'create', JSON.stringify(restoreOp));
        assert.equal(Number(restoreOp.generation), 2, JSON.stringify(restoreOp));
        assert.equal(Number(restoreOp.expectedRevision), 0, JSON.stringify(restoreOp));

        // 舊代際（generation 1 / revision 2）的回執：單筆與批次都不得改動
        // revision、updatedAt、outbox。
        const staleReceipt = {
            articleId,
            revision: 2,
            serverUpdatedAt: staleUpdatedAt,
            clientMutationId: staleOp.clientMutationId,
            generation: 1
        };
        const batch = await tabA.store.markOpsDone([staleReceipt]);
        assert.equal(batch.ok, true, JSON.stringify(batch));
        const single = await tabA.store.markOpDone(articleId, staleReceipt);
        assert.equal(single.ok, true, JSON.stringify(single));
        let afterReceipt = await docRow(scope, articleId);
        assert.equal(Number(afterReceipt.revision), 0, '舊回執把還原後的版本推高了');
        assert.equal(afterReceipt.updatedAt, restored.updatedAt, '舊回執改寫了還原文件的時間');
        assert.equal(Number(afterReceipt.generation), 2);
        let pending = await outboxRow(scope, articleId);
        assert.equal(pending.type, 'create', '舊回執把還原後的建立改成 update');
        assert.equal(Number(pending.expectedRevision), 0, JSON.stringify(pending));

        // 放行 B 暫扣的真正 PUT 回應（也是 generation 1）：同樣不得生效。
        releasePut();
        assert.equal((await bSync).ok, true);
        afterReceipt = await docRow(scope, articleId);
        assert.equal(Number(afterReceipt.revision), 0, '遲到的 markOpDone 把 revision 推回 2');
        assert.equal(afterReceipt.updatedAt, restored.updatedAt);
        assert.equal(Number(afterReceipt.generation), 2);
        pending = await outboxRow(scope, articleId);
        assert.equal(pending.type, 'create');
        assert.equal(Number(pending.expectedRevision), 0);

        // 還原後建立成功（遠端 revision 1），再更新到 revision 2。
        assert.equal((await tabA.sync.syncArticles()).ok, true);
        assert.equal(server.state.articles.get(articleId).revision, 1);
        assert.equal(server.state.articles.get(articleId).body, 'b-v5');
        assert.equal(tabA.store.getRecord(articleId).revision, 1);
        assert.equal(await outboxRow(scope, articleId), null);

        assert.equal((await tabA.store.saveArticle({ articleId, title: 'Title', article: 'b-v6' })).ok, true);
        const updateRound = await tabA.sync.syncArticles();
        assert.equal(updateRound.ok, true, JSON.stringify(updateRound));
        assert.equal(updateRound.pushed.conflicts, 0, JSON.stringify(updateRound.pushed));
        assert.equal(server.state.articles.get(articleId).revision, 2);
        assert.equal(server.state.articles.get(articleId).body, 'b-v6');
        assert.equal(tabA.store.getConflicts().length, 0, JSON.stringify(tabA.store.getConflicts()));
    } finally {
        server.state.hooks.afterPut = null;
        server.state.resetRequired = false;
        globalThis.fetch = undefined;
    }
});

test('localStorage 後備：遠端移除會前進代際，同 ID 還原從 revision 0 建立', async () => {
    const user = 'tab-fallback-retire';
    const scope = scopeFor(user);
    const articleId = 'fallback-retire';
    startScope(user);
    const savedIndexedDB = globalThis.indexedDB;
    let f1;
    let f2;
    try {
        globalThis.indexedDB = undefined;
        f1 = await bootTab('g1');
        f2 = await bootTab('g2');
        await f1.store.reloadScope(scope);
        await f2.store.reloadScope(scope);
    } finally {
        globalThis.indexedDB = savedIndexedDB;
    }

    // 重建前的生命週期：文件最後同步到 rev2，然後 404 重建到 generation 1。
    assert.equal((await f1.store.saveArticle({ articleId, title: 'Title', article: 'f-v2' })).ok, true);
    assert.equal((await f1.store.setBaseRevision(articleId, 2)).ok, true);
    assert.equal((await f1.store.requeueAsCreate(articleId)).ok, true);
    let bucket = fallbackBucket(scope);
    assert.equal(Number((bucket.generations || {})[articleId]), 1);
    const staleOp = bucket.outbox.find((op) => op.articleId === articleId) || null;
    assert.equal(Number(staleOp.generation), 1, JSON.stringify(staleOp));

    // 伺服器已確認這次建立（後備模式沒有 markOpDone 實作，直接寫回已確認狀態）：
    // 文件 gen1 / rev2、dirty 清除、outbox 清空。
    assert.equal((await f1.store.discardPending(articleId)).ok, true);
    patchFallbackBucket(scope, (current) => {
        const doc = current.docs.find((item) => item.id === articleId);
        doc.revision = 2;
        doc.dirty = false;
        doc.pending = false;
        current.outbox = current.outbox.filter((op) => op.articleId !== articleId);
    });
    const backup = await f1.store.exportDocuments();
    assert.equal(Number(backup[0].generation), 1);
    assert.equal(Number(backup[0].revision), 2);

    // 重新載入讓 f1 的記憶體也拿到「已確認」的 clean 文件。
    await f1.store.reloadScope(scope);
    assert.equal(f1.store.getRecord(articleId).dirty, false);

    // 遠端已沒有這篇：完整 pull 清單移除文件，ledger 必須保留並前進一代。
    const reconciled = await f1.store.reconcileFullList([]);
    assert.equal(reconciled.ok, true, JSON.stringify(reconciled));
    bucket = fallbackBucket(scope);
    assert.equal(bucket.docs.find((item) => item.id === articleId), undefined, '後備文件沒有被移除');
    assert.equal(Number((bucket.generations || {})[articleId]), 2, '後備移除沒有前進代際');

    // 另一個分頁（f2）用同一份備份還原：採用 ledger 的 generation 2、revision 0。
    const imported = await f2.store.importDocuments(backup);
    assert.equal(imported.ok, true, JSON.stringify(imported));
    bucket = fallbackBucket(scope);
    const doc = bucket.docs.find((item) => item.id === articleId);
    assert.equal(Number(doc.generation), 2, '後備還原採用了上一個生命週期的代際');
    assert.equal(Number(doc.revision), 0, '後備還原繼承了上一個生命週期的 revision');
    const op = bucket.outbox.find((item) => item.articleId === articleId);
    assert.equal(op.type, 'create', JSON.stringify(op));
    assert.equal(Number(op.generation), 2, JSON.stringify(op));
    assert.equal(Number(op.expectedRevision), 0, JSON.stringify(op));
    // 上一個生命週期的操作代際與目前文件代際不同：回執無法匹配。
    assert.notEqual(Number(staleOp.generation), Number(doc.generation));
});

// ─────────────────────────────────────────────────────────────────────────────
// 第八輪缺口 2：同 ID 重新建立不得繼承上一生命週期的 revision
// ─────────────────────────────────────────────────────────────────────────────

/** 在來源裝置留下「gen1 / rev2」的備份（重建 → 建立 → 更新）。 */
async function seedRebuiltBackup(context, articleId) {
    const { server } = context;
    const scope = await seedRevision3(context, articleId);
    server.state.articles.delete(articleId);
    assert.equal((await tabA.store.saveArticle({ articleId, title: 'Title', article: 'a-v4' })).ok, true);
    assert.equal((await tabA.sync.syncArticles()).ok, true);
    assert.equal((await tabA.sync.syncArticles()).ok, true);
    assert.equal((await tabA.store.saveArticle({ articleId, title: 'Title', article: 'a-v5' })).ok, true);
    const round = await tabA.sync.syncArticles();
    assert.equal(round.ok, true, JSON.stringify(round));
    assert.equal(round.pushed.conflicts, 0, JSON.stringify(round.pushed));
    assert.equal(server.state.articles.get(articleId).revision, 2);
    const backup = await tabA.store.exportDocuments();
    assert.equal(Number(backup[0].generation), 1);
    assert.equal(Number(backup[0].revision), 2);
    return { scope, backup };
}

test('新格式備份還原到沒有 ledger 的裝置：重新建立從 revision 0 開始，首次更新無衝突', async () => {
    const context = newContext('tab-backup-new-format');
    const { server } = context;
    const articleId = 'cross-backup-new';
    try {
        const { backup } = await seedRebuiltBackup(context, articleId);

        // 另一部裝置／新的本機範圍：沒有這份文件，也沒有 ledger；遠端這篇亦已不存在。
        server.state.articles.clear();
        startScope('device-two-new');
        const freshScope = scopeFor('device-two-new');
        await tabB.store.reloadScope(freshScope);
        assert.equal(tabB.store.getRecord(articleId), null);

        const imported = await tabB.store.importDocuments(backup);
        assert.equal(imported.ok, true, JSON.stringify(imported));
        const doc = await docRow(freshScope, articleId);
        assert.equal(Number(doc.revision), 0, '還原繼承了上一生命週期的 revision');
        assert.equal(Number(doc.generation), 1);
        const op = await outboxRow(freshScope, articleId);
        assert.equal(op.type, 'create', JSON.stringify(op));
        assert.equal(Number(op.expectedRevision), 0, JSON.stringify(op));

        // 建立 → 遠端 revision 1；本機必須同步跟上，否則下一次更新會 409。
        const createRound = await tabB.sync.syncArticles();
        assert.equal(createRound.ok, true, JSON.stringify(createRound));
        assert.equal(server.state.articles.get(articleId).revision, 1);
        assert.equal(tabB.store.getRecord(articleId).revision, 1);
        assert.equal(await outboxRow(freshScope, articleId), null);

        assert.equal((await tabB.store.saveArticle({ articleId, title: 'Title', article: 'b-v6' })).ok, true);
        const updateRound = await tabB.sync.syncArticles();
        assert.equal(updateRound.ok, true, JSON.stringify(updateRound));
        assert.equal(updateRound.pushed.conflicts, 0, JSON.stringify(updateRound.pushed));
        assert.equal(server.state.articles.get(articleId).revision, 2);
        assert.equal(server.state.articles.get(articleId).body, 'b-v6');
        assert.equal(tabB.store.getConflicts().length, 0, JSON.stringify(tabB.store.getConflicts()));
    } finally {
        globalThis.fetch = undefined;
    }
});

test('無 generation 的舊備份還原到沒有 ledger 的裝置：同樣從 revision 0 建立', async () => {
    const context = newContext('tab-backup-old-format');
    const { server } = context;
    const articleId = 'cross-backup-old';
    try {
        await seedRebuiltBackup(context, articleId);
        const backup = stripGeneration(await tabA.store.exportDocuments());
        assert.equal(backup[0].generation, undefined);
        assert.equal(Number(backup[0].revision), 2);

        server.state.articles.clear();
        startScope('device-two-old');
        const freshScope = scopeFor('device-two-old');
        await tabB.store.reloadScope(freshScope);
        assert.equal(tabB.store.getRecord(articleId), null);

        const imported = await tabB.store.importDocuments(backup);
        assert.equal(imported.ok, true, JSON.stringify(imported));
        const doc = await docRow(freshScope, articleId);
        assert.equal(Number(doc.revision), 0, '舊備份還原繼承了上一生命週期的 revision');
        assert.equal(Number(doc.generation), 0);
        const op = await outboxRow(freshScope, articleId);
        assert.equal(op.type, 'create', JSON.stringify(op));
        assert.equal(Number(op.expectedRevision), 0, JSON.stringify(op));

        assert.equal((await tabB.sync.syncArticles()).ok, true);
        assert.equal(server.state.articles.get(articleId).revision, 1);
        assert.equal(tabB.store.getRecord(articleId).revision, 1);

        assert.equal((await tabB.store.saveArticle({ articleId, title: 'Title', article: 'b-v7' })).ok, true);
        const updateRound = await tabB.sync.syncArticles();
        assert.equal(updateRound.ok, true, JSON.stringify(updateRound));
        assert.equal(updateRound.pushed.conflicts, 0, JSON.stringify(updateRound.pushed));
        assert.equal(server.state.articles.get(articleId).revision, 2);
        assert.equal(server.state.articles.get(articleId).body, 'b-v7');
        assert.equal(tabB.store.getConflicts().length, 0, JSON.stringify(tabB.store.getConflicts()));
    } finally {
        globalThis.fetch = undefined;
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 第八輪既有 High：完整 pull 不得刪掉另一分頁剛保存的未同步正文
// ─────────────────────────────────────────────────────────────────────────────

test('完整 pull 期間另一分頁保存：文件／摘要／outbox 必須保留並可繼續推送', async (t) => {
    const context = newContext('tab-pull-concurrent-save');
    const { server } = context;
    const articleId = 'cross-pull-concurrent';
    try {
        const scope = await seedRevision3(context, articleId);

        // 遠端清空 → 分頁 A 的同步進入完整 pull，並暫扣完整清單回應。
        server.state.articles.clear();
        server.state.resetRequired = true;
        let releaseFull;
        let fullArrived;
        const fullGate = new Promise((resolve) => { releaseFull = resolve; });
        const fullReady = new Promise((resolve) => { fullArrived = resolve; });
        t.after(() => releaseFull());
        server.state.hooks.beforePull = async ({ full }) => {
            if (!full) return;
            server.state.hooks.beforePull = null;
            fullArrived();
            await fullGate;
        };
        const aSync = tabA.sync.syncArticles();
        aSync.catch(() => {});
        await fullReady;

        // 分頁 B 在等待期間保存新正文：持久化文件已 dirty，且有 outbox。
        assert.equal((await tabB.store.saveArticle({ articleId, title: 'Title', article: 'b-v4' })).ok, true);
        const persisted = await docRow(scope, articleId);
        assert.equal(persisted.body, 'b-v4');
        assert.equal(persisted.dirty, true);
        // 分頁 A 的記憶體仍是 pull 開始前的 clean 版本。
        assert.equal(tabA.store.getRecord(articleId).dirty, false);
        assert.equal(tabA.store.getRecord(articleId).article, 'v3');

        releaseFull();
        const aRound = await aSync;
        assert.equal(aRound.ok, true, JSON.stringify(aRound));

        // 文件、摘要、outbox 都不能被這次完整清單刪掉。
        const doc = await docRow(scope, articleId);
        assert.ok(doc, '完整 pull 刪掉了另一分頁剛保存的文件');
        assert.equal(doc.body, 'b-v4');
        assert.equal(doc.dirty, true);
        const summary = await summaryRow(scope, articleId);
        assert.ok(summary, '完整 pull 刪掉了摘要');
        assert.equal(summary.bodyChars, 'b-v4'.length);
        const op = await outboxRow(scope, articleId);
        assert.ok(op, '完整 pull 刪掉了待同步操作');
        assert.equal(op.payload.body, 'b-v4');
        assert.equal(Number(aRound.pushed.pushed), 0, '找不到文件的操作被當成完成（pushed 1）');
        // 記憶體必須補回持久化內容，推送才不會送出舊正文（這一輪的 PUT 404
        // 已把操作重建為 create，正文取自持久化文件）。
        assert.equal(tabA.store.getRecord(articleId).article, 'b-v4');
        assert.equal(tabA.store.getRecord(articleId).revision, 0);
        const rebuilt = await outboxRow(scope, articleId);
        assert.equal(rebuilt.type, 'create', JSON.stringify(rebuilt));
        assert.equal(rebuilt.payload.body, 'b-v4');
        assert.equal(Number(rebuilt.expectedRevision), 0);

        // 下一輪建立成功，正文是 B 剛保存的內容。
        server.state.resetRequired = false;
        const createRound = await tabA.sync.syncArticles();
        assert.equal(createRound.ok, true, JSON.stringify(createRound));
        assert.equal(createRound.pushed.conflicts, 0, JSON.stringify(createRound.pushed));
        assert.equal(server.state.articles.get(articleId).revision, 1);
        assert.equal(server.state.articles.get(articleId).body, 'b-v4');
        assert.equal(await outboxRow(scope, articleId), null);
        assert.equal(tabA.store.getConflicts().length, 0, JSON.stringify(tabA.store.getConflicts()));
    } finally {
        server.state.hooks.beforePull = null;
        server.state.resetRequired = false;
        globalThis.fetch = undefined;
    }
});

// 使用者主動刪除的 tombstone／delete outbox 不能被完整 pull 的退出語意影響：
// 代際不變，操作與文件仍同一個世代。
test('完整 pull 不得刪掉另一分頁剛建立的刪除 tombstone（delete outbox 保留）', async () => {
    const context = newContext('tab-pull-tombstone');
    const { server } = context;
    const articleId = 'cross-pull-tombstone';
    try {
        const scope = await seedRevision3(context, articleId);
        // 分頁 B 先在本機刪除（尚未上傳）。
        assert.equal((await tabB.store.deleteArticle(articleId)).ok, true);
        const tombstone = await docRow(scope, articleId);
        assert.ok(tombstone.deletedAt);
        const deleteOp = await outboxRow(scope, articleId);
        assert.equal(deleteOp.type, 'delete', JSON.stringify(deleteOp));
        assert.equal(Number(deleteOp.expectedRevision), 3);
        const generationBefore = Number(await ledgerGeneration(scope, articleId));

        // 分頁 A 的記憶體仍是 clean 的舊版本；完整清單已沒有這篇。
        assert.equal(tabA.store.getRecord(articleId).deletedAt, '');
        const reconciled = await tabA.store.reconcileFullList([]);
        assert.equal(reconciled.ok, true, JSON.stringify(reconciled));
        assert.deepEqual(reconciled.removed, [], '完整 pull 移除了待同步的刪除');
        const kept = await docRow(scope, articleId);
        assert.ok(kept && kept.deletedAt, '完整 pull 把 tombstone 刪掉了');
        assert.equal(Number(kept.revision), 3);
        const keptOp = await outboxRow(scope, articleId);
        assert.ok(keptOp, '完整 pull 把待同步的刪除操作刪掉了');
        assert.equal(keptOp.type, 'delete');
        assert.equal(Number(keptOp.expectedRevision), 3);
        assert.equal(Number(keptOp.generation), generationBefore, '刪除操作的代際被改動');
        assert.equal(Number(await ledgerGeneration(scope, articleId)), generationBefore, '刪除路徑的代際被前進');

        // 待同步的刪除仍能正常送出（伺服器保留 tombstone）。
        const round = await tabB.sync.syncArticles();
        assert.equal(round.ok, true, JSON.stringify(round));
        assert.equal(round.pushed.conflicts, 0, JSON.stringify(round.pushed));
        assert.equal(server.state.articles.get(articleId).deletedAt !== '', true);
        assert.equal(server.state.articles.get(articleId).revision, 4);
        assert.equal(await outboxRow(scope, articleId), null);
        assert.equal(tabB.store.getConflicts().length, 0, JSON.stringify(tabB.store.getConflicts()));
    } finally {
        globalThis.fetch = undefined;
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 第九輪缺口 1：delta 墓碑必須結束上一條生命週期（文件、摘要、ledger、記憶體）
// ─────────────────────────────────────────────────────────────────────────────

test('delta 墓碑後同 ID 還原：代際前進，墓碑前的延遲回執（批次／單筆／延遲 PUT）不得改動還原文件', async (t) => {
    const context = newContext('tab-delta-tombstone');
    const { server } = context;
    const articleId = 'cross-delta-tombstone';
    try {
        const scope = await seedRevision3(context, articleId);

        // 分頁 A：404 重建到 generation 1，建立成功（遠端 revision 1）。
        server.state.articles.delete(articleId);
        assert.equal((await tabA.store.saveArticle({ articleId, title: 'Title', article: 'a-v4' })).ok, true);
        assert.equal((await tabA.sync.syncArticles()).ok, true);
        assert.equal((await tabA.sync.syncArticles()).ok, true);
        assert.equal(server.state.articles.get(articleId).revision, 1);
        assert.equal(Number((await docRow(scope, articleId)).generation), 1);

        // 分頁 B：保存 b-v5 並送出 PUT（伺服器提交 revision 2），回應暫扣。
        let releasePut;
        let putArrived;
        const putGate = new Promise((resolve) => { releasePut = resolve; });
        const putReady = new Promise((resolve) => { putArrived = resolve; });
        t.after(() => releasePut());
        server.state.hooks.afterPut = async ({ id }) => {
            if (id !== articleId) return;
            putArrived();
            await putGate;
        };
        assert.equal((await tabB.store.saveArticle({ articleId, title: 'Title', article: 'b-v5' })).ok, true);
        const staleOp = await outboxRow(scope, articleId);
        assert.equal(Number(staleOp.generation), 1, JSON.stringify(staleOp));
        const bSync = tabB.sync.syncArticles();
        bSync.catch(() => {});
        await putReady;
        // 暫扣只針對 B 這一個 PUT；後續 restore 流程的 PUT 不能再被同一個 gate 擋住。
        server.state.hooks.afterPut = null;
        assert.equal(server.state.articles.get(articleId).revision, 2);
        assert.equal(server.state.articles.get(articleId).body, 'b-v5');
        const staleUpdatedAt = server.state.articles.get(articleId).updatedAt;

        // 分頁 A 重試同一個 mutation：伺服器以冪等成功回應，A 把 outbox 清掉。
        assert.equal((await tabA.sync.syncArticles()).ok, true);
        assert.equal(server.state.articles.get(articleId).revision, 2);
        assert.equal(await outboxRow(scope, articleId), null);
        const backup = await tabA.store.exportDocuments();
        assert.equal(Number(backup[0].generation), 1);
        assert.equal(Number(backup[0].revision), 2);
        assert.equal(backup[0].body, 'b-v5');

        // 遠端墓碑（delta）：pullDelta 就是走 applyRemoteTombstones。
        const tombstoned = await tabA.store.applyRemoteTombstone(articleId);
        assert.equal(tombstoned.ok, true, JSON.stringify(tombstoned));
        assert.equal(tombstoned.applied, true, JSON.stringify(tombstoned));
        let doc = await docRow(scope, articleId);
        assert.ok(doc.deletedAt, 'delta 墓碑沒有標記刪除');
        assert.equal(Number(doc.generation), 2, '遠端墓碑沒有結束上一條生命週期');
        assert.equal(Number(await ledgerGeneration(scope, articleId)), 2, '遠端墓碑沒有推進 ledger');
        assert.equal(Number((await summaryRow(scope, articleId)).generation), 2, '摘要沒有跟文件同代際');
        assert.equal(Number(tabA.store.getRecord(articleId).generation), 2, '記憶體沒有採用墓碑的新代際');

        // 同一個墓碑重複送達：不得反覆推進代際。
        const repeated = await tabA.store.applyRemoteTombstone(articleId);
        assert.equal(repeated.ok, true, JSON.stringify(repeated));
        assert.equal(repeated.applied, false, JSON.stringify(repeated));
        doc = await docRow(scope, articleId);
        assert.equal(Number(doc.generation), 2, '重複套用同一個墓碑又推進了一代');
        assert.equal(Number(await ledgerGeneration(scope, articleId)), 2);

        // 以同 ID 備份還原（覆蓋墓碑），再正常保存新正文。
        const imported = await tabA.store.importDocuments(backup, { replace: true });
        assert.equal(imported.ok, true, JSON.stringify(imported));
        doc = await docRow(scope, articleId);
        assert.equal(Number(doc.generation), 2, '還原採用了墓碑前（舊）的代際');
        assert.equal(doc.deletedAt, '');
        assert.equal((await tabA.store.saveArticle({ articleId, title: 'Title', article: 'a-v7' })).ok, true);
        doc = await docRow(scope, articleId);
        const savedAt = doc.updatedAt;
        const savedRevision = Number(doc.revision);
        assert.notEqual(savedAt, staleUpdatedAt);
        assert.equal(Number((await summaryRow(scope, articleId)).bodyChars), 'a-v7'.length);

        // 墓碑前送出的回執（generation 1）：批次與單筆都不得改動任何版本資訊。
        const staleReceipt = {
            articleId,
            revision: 2,
            serverUpdatedAt: staleUpdatedAt,
            clientMutationId: staleOp.clientMutationId,
            generation: 1
        };
        const batch = await tabA.store.markOpsDone([staleReceipt]);
        assert.equal(batch.ok, true, JSON.stringify(batch));
        const single = await tabA.store.markOpDone(articleId, staleReceipt);
        assert.equal(single.ok, true, JSON.stringify(single));
        let after = await docRow(scope, articleId);
        assert.equal(Number(after.revision), savedRevision, '舊回執把還原文件的版本推高了');
        assert.equal(after.updatedAt, savedAt, '舊回執改寫了還原文件的時間');
        assert.equal(Number(after.generation), 2);
        let pending = await outboxRow(scope, articleId);
        assert.equal(pending.payload.body, 'a-v7', '舊回執把待同步操作改回舊內容');
        assert.equal(Number(pending.expectedRevision), savedRevision, JSON.stringify(pending));
        assert.equal(Number(pending.generation), 2, JSON.stringify(pending));

        // 放行 B 暫扣的真正 PUT 回應（也是 generation 1）：同樣不得生效。
        releasePut();
        assert.equal((await bSync).ok, true);
        after = await docRow(scope, articleId);
        assert.equal(Number(after.revision), savedRevision, '遲到的 markOpDone 把 revision 推回 2');
        assert.equal(after.updatedAt, savedAt, '遲到的 markOpDone 改寫了還原文件的時間');
        assert.equal(Number(after.generation), 2);
        pending = await outboxRow(scope, articleId);
        assert.equal(pending.payload.body, 'a-v7');
        assert.equal(Number(pending.generation), 2);
    } finally {
        server.state.hooks.afterPut = null;
        globalThis.fetch = undefined;
    }
});

test('delta 墓碑後收到同 ID 的新遠端文件：沿用 ledger 代際，舊回執不得推高版本', async () => {
    const context = newContext('tab-tombstone-remote-doc');
    const { server } = context;
    const articleId = 'cross-tombstone-remote-doc';
    try {
        const scope = await seedRevision3(context, articleId);
        const staleUpdatedAt = server.state.articles.get(articleId).updatedAt;

        // 遠端刪除 → delta 墓碑：代際前進一代。
        const tombstoned = await tabA.store.applyRemoteTombstone(articleId);
        assert.equal(tombstoned.ok, true, JSON.stringify(tombstoned));
        assert.equal(tombstoned.applied, true, JSON.stringify(tombstoned));
        assert.equal(Number(await ledgerGeneration(scope, articleId)), 1);

        // 之後遠端出現同 ID 的新文件（例如別台裝置以備份重新建立，revision 1）。
        const remote = {
            id: articleId,
            title: 'Fresh',
            body: 'fresh-v1',
            analysis: null,
            sourceType: 'paste',
            sourceUrl: '',
            revision: 1,
            createdAt: '2026-02-02T00:00:00.000Z',
            updatedAt: '2026-02-02T00:00:03.000Z',
            deletedAt: ''
        };
        server.state.articles.set(articleId, { ...remote, lastMutationId: '' });
        const applied = await tabA.store.applyRemoteDoc(remote);
        assert.equal(applied.ok, true, JSON.stringify(applied));
        let doc = await docRow(scope, articleId);
        assert.equal(Number(doc.revision), 1);
        assert.equal(Number(doc.generation), 1, '新遠端文件沒有沿用 ledger 的代際');

        // 墓碑前送出的舊回執（generation 0，遠端 revision 4）不得改動新文件。
        const single = await tabA.store.markOpDone(articleId, {
            revision: 4,
            serverUpdatedAt: staleUpdatedAt,
            clientMutationId: 'stale-before-tombstone',
            generation: 0
        });
        assert.equal(single.ok, true, JSON.stringify(single));
        doc = await docRow(scope, articleId);
        assert.equal(Number(doc.revision), 1, '舊回執把新遠端文件的版本推高了');
        assert.equal(doc.updatedAt, remote.updatedAt, '舊回執改寫了新遠端文件的時間');
        assert.equal(Number(doc.generation), 1);

        // 後續更新仍以遠端 revision 當基準：不產生假衝突。
        assert.equal((await tabA.store.saveArticle({ articleId, title: 'Fresh', article: 'fresh-v2' })).ok, true);
        assert.equal(Number((await outboxRow(scope, articleId)).expectedRevision), 1);
        const round = await tabA.sync.syncArticles();
        assert.equal(round.ok, true, JSON.stringify(round));
        assert.equal(round.pushed.conflicts, 0, JSON.stringify(round.pushed));
        assert.equal(server.state.articles.get(articleId).revision, 2);
        assert.equal(server.state.articles.get(articleId).body, 'fresh-v2');
        assert.equal(tabA.store.getConflicts().length, 0, JSON.stringify(tabA.store.getConflicts()));
        assert.equal(await outboxRow(scope, articleId), null);
    } finally {
        globalThis.fetch = undefined;
    }
});

test('使用者主動刪除與復原：代際不被退休，delete／restore 回執都能完成同步', async () => {
    const context = newContext('tab-user-delete-restore');
    const { server } = context;
    const articleId = 'cross-user-delete-restore';
    try {
        const scope = await seedRevision3(context, articleId);

        // 分頁 A 主動刪除：tombstone 與 delete outbox 同一個代際。
        assert.equal((await tabA.store.deleteArticle(articleId)).ok, true);
        let doc = await docRow(scope, articleId);
        assert.ok(doc.deletedAt);
        assert.equal(Number(doc.generation), 0, '使用者主動刪除被當成遠端墓碑退休');
        assert.equal(Number(await ledgerGeneration(scope, articleId)), 0);
        let op = await outboxRow(scope, articleId);
        assert.equal(op.type, 'delete', JSON.stringify(op));
        assert.equal(Number(op.generation), 0);

        const deleteRound = await tabA.sync.syncArticles();
        assert.equal(deleteRound.ok, true, JSON.stringify(deleteRound));
        assert.equal(deleteRound.pushed.conflicts, 0, JSON.stringify(deleteRound.pushed));
        assert.equal(server.state.articles.get(articleId).deletedAt !== '', true);
        doc = await docRow(scope, articleId);
        assert.equal(Number(doc.generation), 0);
        assert.equal(Number(doc.revision), 4);
        assert.equal(doc.dirty, false);
        assert.equal(await outboxRow(scope, articleId), null);

        // 已同步完成的 tombstone 再收到遠端墓碑（delta／完整 pull 都會送）：
        // 不得推進代際。
        const repeated = await tabA.store.applyRemoteTombstones([articleId]);
        assert.equal(repeated.ok, true, JSON.stringify(repeated));
        assert.equal(repeated.results[0].applied, false, JSON.stringify(repeated.results[0]));
        assert.equal(Number(await ledgerGeneration(scope, articleId)), 0, '已刪除文件的遠端墓碑推進了代際');

        // 復原：同代際的 restore 操作，伺服器確認後完成同步。
        await tabA.store.reloadScope(scope);
        const restored = await tabA.store.restoreArticle(tabA.store.getRecord(articleId));
        assert.equal(restored.ok, true, JSON.stringify(restored));
        doc = await docRow(scope, articleId);
        assert.equal(Number(doc.generation), 0);
        assert.equal(doc.deletedAt, '');
        op = await outboxRow(scope, articleId);
        assert.equal(op.type, 'restore', JSON.stringify(op));
        assert.equal(Number(op.expectedRevision), 4, JSON.stringify(op));
        const restoreRound = await tabA.sync.syncArticles();
        assert.equal(restoreRound.ok, true, JSON.stringify(restoreRound));
        assert.equal(restoreRound.pushed.conflicts, 0, JSON.stringify(restoreRound.pushed));
        assert.equal(server.state.articles.get(articleId).deletedAt, '');
        assert.equal(server.state.articles.get(articleId).revision, 5);
        doc = await docRow(scope, articleId);
        assert.equal(Number(doc.revision), 5);
        assert.equal(doc.deletedAt, '');
        assert.equal(doc.dirty, false);
        assert.equal(await outboxRow(scope, articleId), null);
        assert.equal(tabA.store.getConflicts().length, 0, JSON.stringify(tabA.store.getConflicts()));
    } finally {
        globalThis.fetch = undefined;
    }
});

test('localStorage 後備：delta 墓碑前進代際、重複墓碑不再推進、還原後舊回執不得改動', async () => {
    const user = 'tab-fallback-tombstone';
    const scope = scopeFor(user);
    const articleId = 'fallback-tombstone';
    startScope(user);
    const savedIndexedDB = globalThis.indexedDB;
    let f1;
    let f2;
    try {
        globalThis.indexedDB = undefined;
        f1 = await bootTab('i1');
        f2 = await bootTab('i2');
        await f1.store.reloadScope(scope);
        await f2.store.reloadScope(scope);
    } finally {
        globalThis.indexedDB = savedIndexedDB;
    }

    // 後備模式建立並確認一次同步（回執必須有後備實作）。
    assert.equal((await f1.store.saveArticle({ articleId, title: 'Title', article: 'f-v1' })).ok, true);
    let bucket = fallbackBucket(scope);
    const staleOp = bucket.outbox.find((op) => op.articleId === articleId) || null;
    assert.ok(staleOp);
    const firstAck = await f1.store.markOpDone(articleId, {
        revision: 2,
        serverUpdatedAt: '2026-03-03T00:00:00.000Z',
        clientMutationId: staleOp.clientMutationId,
        generation: staleOp.generation
    });
    assert.equal(firstAck.ok, true, JSON.stringify(firstAck));
    assert.equal(firstAck.stale, false, JSON.stringify(firstAck));
    bucket = fallbackBucket(scope);
    let doc = bucket.docs.find((item) => item.id === articleId);
    assert.equal(Number(doc.revision), 2, '後備回執沒有推進本機版本');
    assert.equal(doc.dirty, false);
    assert.equal(bucket.outbox.filter((op) => op.articleId === articleId).length, 0, '後備回執沒有清掉 outbox');

    // 另一個分頁套用 delta 墓碑：代際前進一代。
    const tombstoned = await f2.store.applyRemoteTombstone(articleId);
    assert.equal(tombstoned.ok, true, JSON.stringify(tombstoned));
    assert.equal(tombstoned.applied, true, JSON.stringify(tombstoned));
    bucket = fallbackBucket(scope);
    doc = bucket.docs.find((item) => item.id === articleId);
    assert.ok(doc.deletedAt);
    assert.equal(Number(doc.generation), 1, '後備墓碑沒有結束上一條生命週期');
    assert.equal(Number((bucket.generations || {})[articleId]), 1, '後備墓碑沒有推進 ledger');

    // 同一個墓碑重複送達：不再推進代際。
    const repeated = await f2.store.applyRemoteTombstone(articleId);
    assert.equal(repeated.ok, true, JSON.stringify(repeated));
    assert.equal(repeated.applied, false, JSON.stringify(repeated));
    bucket = fallbackBucket(scope);
    assert.equal(Number(bucket.docs.find((item) => item.id === articleId).generation), 1);

    // 分頁 f1 的記憶體仍是舊代際：復原必須採用 ledger 的代際。
    const restored = await f1.store.restoreArticle(f1.store.getRecord(articleId));
    assert.equal(restored.ok, true, JSON.stringify(restored));
    bucket = fallbackBucket(scope);
    doc = bucket.docs.find((item) => item.id === articleId);
    assert.equal(Number(doc.generation), 1, '後備還原採用了墓碑前的代際');
    assert.equal(doc.deletedAt, '');
    assert.equal(Number(doc.revision), 2);

    // 墓碑前送出的回執（generation 0）不得改動還原文件。
    const stale = await f1.store.markOpDone(articleId, {
        revision: 2,
        serverUpdatedAt: '2026-03-03T00:00:05.000Z',
        clientMutationId: staleOp.clientMutationId,
        generation: 0
    });
    assert.equal(stale.ok, true, JSON.stringify(stale));
    bucket = fallbackBucket(scope);
    doc = bucket.docs.find((item) => item.id === articleId);
    assert.equal(Number(doc.revision), 2, '舊回執把後備還原的版本推高了');
    assert.notEqual(doc.updatedAt, '2026-03-03T00:00:05.000Z', '舊回執改寫了後備還原的時間');
    const restoredOp = bucket.outbox.find((op) => op.articleId === articleId) || null;
    assert.equal(restoredOp.type, 'restore', JSON.stringify(restoredOp));
    assert.equal(Number(restoredOp.generation), 1, JSON.stringify(restoredOp));

    // 同代際的正式回執仍可完成確認（復原照常同步）。
    const ack = await f1.store.markOpDone(articleId, {
        revision: 3,
        serverUpdatedAt: '2026-03-03T00:00:09.000Z',
        clientMutationId: restoredOp.clientMutationId,
        generation: restoredOp.generation
    });
    assert.equal(ack.ok, true, JSON.stringify(ack));
    assert.equal(ack.stale, false, JSON.stringify(ack));
    bucket = fallbackBucket(scope);
    doc = bucket.docs.find((item) => item.id === articleId);
    assert.equal(Number(doc.revision), 3);
    assert.equal(doc.dirty, false);
    assert.equal(doc.pending, false);
    assert.equal(bucket.outbox.filter((op) => op.articleId === articleId).length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 第九輪缺口 2：後備模式的回執必須真的落地，確認失敗不得誤報成功
// ─────────────────────────────────────────────────────────────────────────────

test('localStorage 後備：rev0 → rev1 → rev2 完成同步，outbox 清除、衝突 0', async () => {
    const context = newContext('tab-fallback-e2e');
    const { server } = context;
    const user = 'tab-fallback-e2e';
    const scope = scopeFor(user);
    const articleId = 'fallback-e2e';
    startScope(user);
    const savedIndexedDB = globalThis.indexedDB;
    let f1;
    let f2;
    try {
        globalThis.indexedDB = undefined;
        f1 = await bootTab('j1');
        f2 = await bootTab('j2');
        await f1.store.reloadScope(scope);
        await f2.store.reloadScope(scope);
    } finally {
        globalThis.indexedDB = savedIndexedDB;
    }

    assert.equal((await f1.store.saveArticle({ articleId, title: 'Title', article: 'f-v1' })).ok, true);
    const createRound = await f1.sync.syncArticles();
    assert.equal(createRound.ok, true, JSON.stringify(createRound));
    assert.equal(createRound.pushed.pushed, 1, JSON.stringify(createRound.pushed));
    assert.equal(createRound.pushed.conflicts, 0, JSON.stringify(createRound.pushed));
    assert.equal(createRound.pushed.failed, 0, JSON.stringify(createRound.pushed));
    assert.equal(server.state.articles.get(articleId).revision, 1);
    assert.equal(server.state.articles.get(articleId).body, 'f-v1');
    let bucket = fallbackBucket(scope);
    let doc = bucket.docs.find((item) => item.id === articleId);
    assert.equal(Number(doc.revision), 1, '後備模式的建立回執沒有落地');
    assert.equal(doc.dirty, false);
    assert.equal(bucket.outbox.filter((op) => op.articleId === articleId).length, 0);

    // 另一個分頁先重新載入（真實分頁會看到 f1 刚建立的文章），再保存 → 更新。
    await f2.store.reloadScope(scope);
    assert.equal((await f2.store.saveArticle({ articleId, title: 'Title', article: 'f-v2' })).ok, true);
    const updateRound = await f2.sync.syncArticles();
    assert.equal(updateRound.ok, true, JSON.stringify(updateRound));
    assert.equal(updateRound.pushed.pushed, 1, JSON.stringify(updateRound.pushed));
    assert.equal(updateRound.pushed.conflicts, 0, JSON.stringify(updateRound.pushed));
    assert.equal(updateRound.pushed.failed, 0, JSON.stringify(updateRound.pushed));
    assert.equal(server.state.articles.get(articleId).revision, 2);
    assert.equal(server.state.articles.get(articleId).body, 'f-v2');
    bucket = fallbackBucket(scope);
    doc = bucket.docs.find((item) => item.id === articleId);
    assert.equal(Number(doc.revision), 2, '後備模式的更新回執沒有落地');
    assert.equal(doc.dirty, false);
    assert.equal(bucket.outbox.filter((op) => op.articleId === articleId).length, 0);
    assert.equal(f2.store.getConflicts().length, 0, JSON.stringify(f2.store.getConflicts()));
});

test('localStorage 後備：回執確認失敗不得計為成功，outbox 保留供下一輪重試', async (t) => {
    const context = newContext('tab-fallback-receipt-failure');
    const { server } = context;
    const user = 'tab-fallback-receipt-failure';
    const scope = scopeFor(user);
    const articleId = 'fallback-receipt-failure';
    startScope(user);
    const savedIndexedDB = globalThis.indexedDB;
    let f1;
    try {
        globalThis.indexedDB = undefined;
        f1 = await bootTab('k1');
        await f1.store.reloadScope(scope);
    } finally {
        globalThis.indexedDB = savedIndexedDB;
    }

    assert.equal((await f1.store.saveArticle({ articleId, title: 'Title', article: 'f-v1' })).ok, true);

    // 模擬 localStorage 額度不足／寫入被拒：回執無法落地。
    const originalSetItem = globalThis.localStorage.setItem;
    let blocked = true;
    globalThis.localStorage.setItem = (key, value) => {
        if (blocked && String(key).startsWith('bdc:articles:fallback:v1:')) {
            throw new Error('QuotaExceededError');
        }
        return originalSetItem.call(globalThis.localStorage, key, value);
    };
    t.after(() => { globalThis.localStorage.setItem = originalSetItem; });

    const failedRound = await f1.sync.syncArticles();
    // 回執與收尾（markSynced）都寫不進後備桶：這一輪沒有真正完成收尾，
    // 不得回報同步成功（第十一輪 F1）；但不得把桶當成空的覆寫掉。
    assert.equal(failedRound.ok, false, JSON.stringify(failedRound));
    assert.equal(failedRound.error, 'storage_full', JSON.stringify(failedRound));
    assert.equal(failedRound.pushed.pushed, 0, '確認失敗卻計為成功');
    assert.equal(failedRound.pushed.failed, 1, JSON.stringify(failedRound.pushed));
    assert.equal(failedRound.pushed.conflicts, 0, '確認失敗被誤判成衝突');
    assert.equal(server.state.articles.get(articleId).revision, 1);
    let bucket = fallbackBucket(scope);
    assert.equal(Number(bucket.docs.find((item) => item.id === articleId).revision), 0, '確認失敗卻推進了本機版本');
    assert.equal(bucket.outbox.filter((op) => op.articleId === articleId).length, 1, '確認失敗卻清掉了 outbox');
    assert.equal(f1.store.getConflicts().length, 0, JSON.stringify(f1.store.getConflicts()));

    // 恢復寫入後重試：伺服器以同一個 mutation 回應冪等結果，最終完成。
    blocked = false;
    const retryRound = await f1.sync.syncArticles();
    assert.equal(retryRound.ok, true, JSON.stringify(retryRound));
    assert.equal(retryRound.pushed.pushed, 1, JSON.stringify(retryRound.pushed));
    assert.equal(retryRound.pushed.failed, 0, JSON.stringify(retryRound.pushed));
    assert.equal(retryRound.pushed.conflicts, 0, JSON.stringify(retryRound.pushed));
    assert.equal(server.state.articles.get(articleId).revision, 1);
    bucket = fallbackBucket(scope);
    assert.equal(Number(bucket.docs.find((item) => item.id === articleId).revision), 1);
    assert.equal(bucket.outbox.filter((op) => op.articleId === articleId).length, 0);
    assert.equal(f1.store.getConflicts().length, 0, JSON.stringify(f1.store.getConflicts()));
});

// ─────────────────────────────────────────────────────────────────────────────
// 第十輪缺口 1：後備回執只更新相關 conflict，不得用呼叫端記憶體整包覆寫 state
// ─────────────────────────────────────────────────────────────────────────────

test('localStorage 後備：過期實例的單筆回執不得覆蓋另一實例的 cursor／migrated／gate／lastSyncAt／其他衝突', async () => {
    const user = 'tab-fallback-receipt-state-single';
    const scope = scopeFor(user);
    const mine = 'fallback-state-single-mine';
    const other = 'fallback-state-single-other';
    startScope(user);
    const savedIndexedDB = globalThis.indexedDB;
    let f1;
    let f2;
    try {
        globalThis.indexedDB = undefined;
        f1 = await bootTab('l1');
        f2 = await bootTab('l2');
        await f1.store.reloadScope(scope);
        await f2.store.reloadScope(scope);
    } finally {
        globalThis.indexedDB = savedIndexedDB;
    }

    // f1 的記憶體停留在舊 metadata（cursor 0）；f2 建立另一篇舊文章，
    // 並把較新的同步狀態寫進共用的 localStorage 桶。
    assert.equal((await f1.store.saveArticle({ articleId: mine, title: 'Mine', article: 'm-v1' })).ok, true);
    assert.equal((await f2.store.saveArticle({ articleId: other, title: 'Other', article: 'o-v1' })).ok, true);
    assert.equal((await f2.store.setCursor(73)).ok, true);
    assert.equal((await f2.store.markSynced('2026-10-22T10:00:00.000Z')).ok, true);
    assert.equal((await f2.store.setGatePending(true)).ok, true);
    let bucket = fallbackBucket(scope);
    bucket.state = {
        ...bucket.state,
        // migrated 沒有公開 setter；直接寫入持久化 state 模擬另一個實例完成的遷移。
        migrated: true,
        migratedAt: '2026-10-22T09:59:00.000Z',
        conflicts: {
            [mine]: { articleId: mine, kind: 'revision' },
            [other]: { articleId: other, kind: 'deleted_remote' }
        }
    };
    localStorage.setItem(`bdc:articles:fallback:v1:${scope}`, JSON.stringify(bucket));
    assert.equal(f1.store.getCursor(), 0, 'f1 記憶體必須仍是舊 metadata，才能重現覆寫');

    const op = bucket.outbox.find((item) => item.articleId === mine);
    assert.ok(op, '缺少待同步操作');
    const ack = await f1.store.markOpDone(mine, {
        revision: 1,
        serverUpdatedAt: '2026-10-22T10:00:05.000Z',
        clientMutationId: op.clientMutationId,
        generation: op.generation
    });
    assert.equal(ack.ok, true, JSON.stringify(ack));
    assert.equal(ack.stale, false, JSON.stringify(ack));

    bucket = fallbackBucket(scope);
    assert.equal(Number(bucket.state.cursor), 73, '過期實例把 cursor 蓋回 0');
    assert.equal(bucket.state.migrated, true, '過期實例清掉了 migrated');
    assert.equal(bucket.state.migratedAt, '2026-10-22T09:59:00.000Z');
    assert.equal(bucket.state.gatePending, true, '過期實例清掉了 gatePending');
    assert.equal(bucket.state.lastSyncAt, '2026-10-22T10:00:00.000Z', '過期實例清掉了 lastSyncAt');
    assert.equal(bucket.state.conflicts[mine], undefined, '自己的衝突沒有清掉');
    assert.ok(bucket.state.conflicts[other], '另一篇文章的衝突被清掉了');
    assert.equal(bucket.outbox.filter((item) => item.articleId === mine).length, 0);
    assert.equal(bucket.outbox.filter((item) => item.articleId === other).length, 1, '另一篇的 outbox 被動到');
    const doc = bucket.docs.find((item) => item.id === mine);
    assert.equal(Number(doc.revision), 1);
    assert.equal(doc.dirty, false);
});

test('localStorage 後備：過期實例的批次回執同樣只清匹配的 outbox／衝突，保留較新的 state', async () => {
    const user = 'tab-fallback-receipt-state-batch';
    const scope = scopeFor(user);
    const mineA = 'fallback-state-batch-a';
    const mineB = 'fallback-state-batch-b';
    const other = 'fallback-state-batch-other';
    startScope(user);
    const savedIndexedDB = globalThis.indexedDB;
    let f1;
    let f2;
    try {
        globalThis.indexedDB = undefined;
        f1 = await bootTab('m1');
        f2 = await bootTab('m2');
        await f1.store.reloadScope(scope);
        await f2.store.reloadScope(scope);
    } finally {
        globalThis.indexedDB = savedIndexedDB;
    }

    assert.equal((await f1.store.saveArticle({ articleId: mineA, title: 'A', article: 'a-v1' })).ok, true);
    assert.equal((await f1.store.saveArticle({ articleId: mineB, title: 'B', article: 'b-v1' })).ok, true);
    assert.equal((await f2.store.saveArticle({ articleId: other, title: 'Other', article: 'o-v1' })).ok, true);
    assert.equal((await f2.store.setCursor(91)).ok, true);
    assert.equal((await f2.store.markSynced('2026-10-22T12:00:00.000Z')).ok, true);
    assert.equal((await f2.store.setGatePending(true)).ok, true);
    let bucket = fallbackBucket(scope);
    bucket.state = {
        ...bucket.state,
        migrated: true,
        migratedAt: '2026-10-22T11:59:00.000Z',
        lastError: 'keep-me',
        conflicts: {
            [mineA]: { articleId: mineA, kind: 'revision' },
            [mineB]: { articleId: mineB, kind: 'revision' },
            [other]: { articleId: other, kind: 'deleted_remote' }
        }
    };
    localStorage.setItem(`bdc:articles:fallback:v1:${scope}`, JSON.stringify(bucket));
    assert.equal(f1.store.getCursor(), 0);

    const receipts = [mineA, mineB].map((articleId) => {
        const op = bucket.outbox.find((item) => item.articleId === articleId);
        assert.ok(op, `缺少 ${articleId} 的待同步操作`);
        return {
            articleId,
            revision: 1,
            serverUpdatedAt: '2026-10-22T12:00:05.000Z',
            clientMutationId: op.clientMutationId,
            generation: op.generation
        };
    });
    const ack = await f1.store.markOpsDone(receipts);
    assert.equal(ack.ok, true, JSON.stringify(ack));
    for (const item of ack.results || []) assert.equal(item.matches, true, JSON.stringify(item));

    bucket = fallbackBucket(scope);
    assert.equal(Number(bucket.state.cursor), 91, '批次回執把 cursor 蓋回 0');
    assert.equal(bucket.state.migrated, true, '批次回執清掉了 migrated');
    assert.equal(bucket.state.gatePending, true, '批次回執清掉了 gatePending');
    assert.equal(bucket.state.lastSyncAt, '2026-10-22T12:00:00.000Z');
    assert.equal(bucket.state.lastError, 'keep-me', '批次回執清掉了 lastError');
    assert.equal(bucket.state.conflicts[mineA], undefined);
    assert.equal(bucket.state.conflicts[mineB], undefined);
    assert.ok(bucket.state.conflicts[other], '批次回執清掉了其他文章的衝突');
    assert.equal(bucket.outbox.filter((item) => item.articleId === mineA).length, 0);
    assert.equal(bucket.outbox.filter((item) => item.articleId === mineB).length, 0);
    assert.equal(bucket.outbox.filter((item) => item.articleId === other).length, 1, '批次回執動到了其他 outbox');
});

// ─────────────────────────────────────────────────────────────────────────────
// 第十輪缺口 2：後備儲存讀不到時不得誤報推送成功
// ─────────────────────────────────────────────────────────────────────────────

test('localStorage 後備：回執讀取例外不得計為推送成功，恢復後同 mutation 重試成功且無衝突', async (t) => {
    const context = newContext('tab-fallback-receipt-read');
    const { server } = context;
    const user = 'tab-fallback-receipt-read';
    const scope = scopeFor(user);
    const articleId = 'fallback-receipt-read';
    startScope(user);
    const savedIndexedDB = globalThis.indexedDB;
    let f1;
    try {
        globalThis.indexedDB = undefined;
        f1 = await bootTab('n1');
        await f1.store.reloadScope(scope);
    } finally {
        globalThis.indexedDB = savedIndexedDB;
    }

    assert.equal((await f1.store.saveArticle({ articleId, title: 'Title', article: 'f-v1' })).ok, true);

    const baseFetch = globalThis.fetch;
    const originalGetItem = globalThis.localStorage.getItem;
    let failReads = 0;
    let armed = false;
    globalThis.localStorage.getItem = (key) => {
        if (failReads > 0 && String(key).startsWith('bdc:articles:fallback:v1:')) {
            failReads -= 1;
            throw new Error('SecurityError');
        }
        return originalGetItem.call(globalThis.localStorage, key);
    };
    globalThis.fetch = async (url, init = {}) => {
        const response = await baseFetch(url, init);
        const method = String(init.method || 'GET').toUpperCase();
        if (!armed && method === 'POST' && new URL(url).pathname === '/articles') {
            armed = true;
            // 伺服器已提交 rev1；回應回到 pushOne 後才讓回執讀取失敗。
            failReads = 1;
        }
        return response;
    };
    t.after(() => {
        globalThis.localStorage.getItem = originalGetItem;
        globalThis.fetch = undefined;
    });

    const failedRound = await f1.sync.syncArticles();
    assert.equal(failedRound.ok, true, JSON.stringify(failedRound));
    assert.equal(failedRound.pushed.pushed, 0, '回執讀取失敗卻計為推送成功');
    assert.equal(failedRound.pushed.failed, 1, JSON.stringify(failedRound.pushed));
    assert.equal(failedRound.pushed.conflicts, 0, '回執讀取失敗被誤判成衝突');
    assert.equal(server.state.articles.get(articleId).revision, 1);
    let bucket = fallbackBucket(scope);
    let doc = bucket.docs.find((item) => item.id === articleId);
    assert.equal(Number(doc.revision), 0, '回執讀取失敗卻推進了本機版本');
    assert.equal(doc.dirty, true);
    assert.equal(bucket.outbox.filter((op) => op.articleId === articleId).length, 1, '回執讀取失敗卻清掉了 outbox');
    assert.equal(f1.store.getConflicts().length, 0, JSON.stringify(f1.store.getConflicts()));

    // 恢復讀取後重試：伺服器以同一個 mutation 回應冪等結果，最終完成。
    const retryRound = await f1.sync.syncArticles();
    assert.equal(retryRound.ok, true, JSON.stringify(retryRound));
    assert.equal(retryRound.pushed.pushed, 1, JSON.stringify(retryRound.pushed));
    assert.equal(retryRound.pushed.failed, 0, JSON.stringify(retryRound.pushed));
    assert.equal(retryRound.pushed.conflicts, 0, JSON.stringify(retryRound.pushed));
    assert.equal(server.state.articles.get(articleId).revision, 1);
    bucket = fallbackBucket(scope);
    doc = bucket.docs.find((item) => item.id === articleId);
    assert.equal(Number(doc.revision), 1);
    assert.equal(doc.dirty, false);
    assert.equal(bucket.outbox.filter((op) => op.articleId === articleId).length, 0);
    assert.equal(f1.store.getConflicts().length, 0, JSON.stringify(f1.store.getConflicts()));
});

test('localStorage 後備：損壞 JSON 與批次讀取例外都不得清 outbox／改文件，修復後可重試', async () => {
    const user = 'tab-fallback-receipt-corrupt';
    const scope = scopeFor(user);
    const articleA = 'fallback-corrupt-a';
    const articleB = 'fallback-corrupt-b';
    const key = `bdc:articles:fallback:v1:${scope}`;
    startScope(user);
    const savedIndexedDB = globalThis.indexedDB;
    let f1;
    try {
        globalThis.indexedDB = undefined;
        f1 = await bootTab('o1');
        await f1.store.reloadScope(scope);
    } finally {
        globalThis.indexedDB = savedIndexedDB;
    }

    assert.equal((await f1.store.saveArticle({ articleId: articleA, title: 'A', article: 'a-v1' })).ok, true);
    assert.equal((await f1.store.saveArticle({ articleId: articleB, title: 'B', article: 'b-v1' })).ok, true);
    const validRaw = localStorage.getItem(key);
    let bucket = JSON.parse(validRaw);
    const receipts = [articleA, articleB].map((articleId) => {
        const op = bucket.outbox.find((item) => item.articleId === articleId);
        assert.ok(op, `缺少 ${articleId} 的待同步操作`);
        return {
            articleId,
            revision: 1,
            serverUpdatedAt: '2026-10-22T13:00:00.000Z',
            clientMutationId: op.clientMutationId,
            generation: op.generation
        };
    });

    // 損壞 JSON：單筆與批次都必須明確失敗，且不得覆寫（破壞）桶。
    localStorage.setItem(key, '{not-json');
    const singleCorrupt = await f1.store.markOpDone(articleA, receipts[0]);
    assert.equal(singleCorrupt.ok, false, JSON.stringify(singleCorrupt));
    assert.equal(singleCorrupt.error, 'storage_corrupt');
    const batchCorrupt = await f1.store.markOpsDone([receipts[1]]);
    assert.equal(batchCorrupt.ok, false, JSON.stringify(batchCorrupt));
    assert.equal(batchCorrupt.error, 'storage_corrupt');
    assert.equal(localStorage.getItem(key), '{not-json', '回執失敗卻改寫了損壞的桶');

    // 還原合法桶後，批次讀取本身拋錯：同樣不得改動任何資料。
    localStorage.setItem(key, validRaw);
    const originalGetItem = globalThis.localStorage.getItem;
    let failReads = 0;
    globalThis.localStorage.getItem = (readKey) => {
        if (failReads > 0 && String(readKey).startsWith('bdc:articles:fallback:v1:')) {
            failReads -= 1;
            throw new Error('SecurityError');
        }
        return originalGetItem.call(globalThis.localStorage, readKey);
    };
    try {
        failReads = 1;
        const batchReadError = await f1.store.markOpsDone([receipts[1]]);
        assert.equal(batchReadError.ok, false, JSON.stringify(batchReadError));
        assert.equal(batchReadError.error, 'storage_read_failed');
    } finally {
        globalThis.localStorage.getItem = originalGetItem;
    }
    bucket = fallbackBucket(scope);
    assert.equal(Number(bucket.docs.find((item) => item.id === articleA).revision), 0);
    assert.equal(Number(bucket.docs.find((item) => item.id === articleB).revision), 0);
    assert.equal(bucket.outbox.filter((op) => op.articleId === articleA).length, 1);
    assert.equal(bucket.outbox.filter((op) => op.articleId === articleB).length, 1);

    // 修復後同一批 mutation 可完成確認，沒有衝突。
    const singleRetry = await f1.store.markOpDone(articleA, receipts[0]);
    assert.equal(singleRetry.ok, true, JSON.stringify(singleRetry));
    assert.equal(singleRetry.stale, false, JSON.stringify(singleRetry));
    const batchRetry = await f1.store.markOpsDone([receipts[1]]);
    assert.equal(batchRetry.ok, true, JSON.stringify(batchRetry));
    assert.equal(batchRetry.results[0].matches, true, JSON.stringify(batchRetry));
    bucket = fallbackBucket(scope);
    assert.equal(Number(bucket.docs.find((item) => item.id === articleA).revision), 1);
    assert.equal(Number(bucket.docs.find((item) => item.id === articleB).revision), 1);
    assert.equal(bucket.outbox.filter((op) => op.articleId === articleA).length, 0);
    assert.equal(bucket.outbox.filter((op) => op.articleId === articleB).length, 0);
    assert.equal(f1.store.getConflicts().length, 0, JSON.stringify(f1.store.getConflicts()));
});

// ─────────────────────────────────────────────────────────────────────────────
// 第十輪缺口 3：備份還原覆蓋墓碑後，先 restore 再上傳新正文
// ─────────────────────────────────────────────────────────────────────────────

test('備份還原覆蓋 delta 墓碑：先 restore 再以新 revision PUT 新正文，無衝突且 outbox 清空', async (t) => {
    const context = newContext('tab-restore-tombstone');
    const { server } = context;
    const articleId = 'cross-restore-tombstone';
    let bSync = null;
    try {
        const scope = await seedRevision3(context, articleId);

        // A：404 重建到 generation 1，建立成功（遠端 revision 1）。
        server.state.articles.delete(articleId);
        assert.equal((await tabA.store.saveArticle({ articleId, title: 'Title', article: 'a-v4' })).ok, true);
        assert.equal((await tabA.sync.syncArticles()).ok, true);
        assert.equal((await tabA.sync.syncArticles()).ok, true);
        assert.equal(server.state.articles.get(articleId).revision, 1);
        assert.equal(Number((await docRow(scope, articleId)).generation), 1);

        // B：保存 b-v5 並送出 PUT（伺服器提交 revision 2），回應暫扣。
        let releasePut;
        let putArrived;
        const putGate = new Promise((resolve) => { releasePut = resolve; });
        const putReady = new Promise((resolve) => { putArrived = resolve; });
        t.after(() => releasePut());
        server.state.hooks.afterPut = async ({ id }) => {
            if (id !== articleId) return;
            putArrived();
            await putGate;
        };
        assert.equal((await tabB.store.saveArticle({ articleId, title: 'Title', article: 'b-v5' })).ok, true);
        bSync = tabB.sync.syncArticles();
        bSync.catch(() => {});
        await putReady;
        // 暫扣只針對 B 這一個 PUT；後續 restore 流程的 PUT 不能再被同一個 gate 擋住。
        server.state.hooks.afterPut = null;
        assert.equal(server.state.articles.get(articleId).revision, 2);
        assert.equal(server.state.articles.get(articleId).body, 'b-v5');

        // A 冪等重試同一個 mutation：伺服器回應成功，outbox 清空。
        assert.equal((await tabA.sync.syncArticles()).ok, true);
        assert.equal(server.state.articles.get(articleId).revision, 2);
        assert.equal(await outboxRow(scope, articleId), null);
        const backup = await tabA.store.exportDocuments();
        assert.equal(backup[0].body, 'b-v5');
        assert.equal(Number(backup[0].revision), 2);
        assert.equal(Number(backup[0].generation), 1);

        // 遠端刪除至 revision 3，A 收到 delta 墓碑（代際 2）。
        const beforeDelete = server.state.articles.get(articleId);
        server.state.articles.set(articleId, {
            ...beforeDelete,
            revision: 3,
            updatedAt: '2026-10-22T11:00:00.000Z',
            deletedAt: '2026-10-22T11:00:00.000Z',
            lastMutationId: ''
        });
        const tombstoned = await tabA.store.applyRemoteTombstone(articleId);
        assert.equal(tombstoned.ok, true, JSON.stringify(tombstoned));
        assert.equal(tombstoned.applied, true, JSON.stringify(tombstoned));
        assert.equal(Number((await docRow(scope, articleId)).generation), 2);
        assert.equal(Number(await ledgerGeneration(scope, articleId)), 2);

        // 備份覆蓋墓碑 + 保存新正文：outbox 必須保留明確的復原意圖。
        const imported = await tabA.store.importDocuments(backup, { replace: true });
        assert.equal(imported.ok, true, JSON.stringify(imported));
        let op = await outboxRow(scope, articleId);
        assert.equal(op.type, 'restore_update', JSON.stringify(op));
        assert.equal(Number(op.generation), 2, JSON.stringify(op));
        assert.equal((await docRow(scope, articleId)).deletedAt, '');

        assert.equal((await tabA.store.saveArticle({ articleId, title: 'Title', article: 'a-v7' })).ok, true);
        op = await outboxRow(scope, articleId);
        assert.equal(op.type, 'restore_update', '還原後的新正文把操作降回普通 update');
        assert.equal(op.payload.body, 'a-v7', JSON.stringify(op));
        assert.equal(Number(op.generation), 2, JSON.stringify(op));

        const restoreCallsBefore = server.state.restoreCalls;
        const round = await tabA.sync.syncArticles();
        assert.equal(round.ok, true, JSON.stringify(round));
        assert.equal(round.pushed.pushed, 1, JSON.stringify(round.pushed));
        assert.equal(round.pushed.conflicts, 0, JSON.stringify(round.pushed));
        assert.equal(round.pushed.failed, 0, JSON.stringify(round.pushed));
        assert.ok(server.state.restoreCalls > restoreCallsBefore, '沒有呼叫 restore');
        const remote = server.state.articles.get(articleId);
        assert.equal(remote.deletedAt, '');
        assert.equal(remote.body, 'a-v7');
        assert.equal(remote.revision, 5, 'restore（rev4）+ PUT（rev5）');
        let doc = await docRow(scope, articleId);
        assert.equal(doc.body, 'a-v7');
        assert.equal(Number(doc.revision), 5);
        assert.equal(Number(doc.generation), 2);
        assert.equal(doc.dirty, false);
        assert.equal(doc.pending, false);
        assert.equal(await outboxRow(scope, articleId), null);
        assert.equal(tabA.store.getConflicts().length, 0, JSON.stringify(tabA.store.getConflicts()));

        // 墓碑前 generation 1 的延遲回執仍不得改動完成 restore 後的文件。
        releasePut();
        assert.equal((await bSync).ok, true);
        doc = await docRow(scope, articleId);
        assert.equal(Number(doc.revision), 5, '遲到的舊回執把 restore 後的版本推回去了');
        assert.equal(doc.body, 'a-v7');
        assert.equal(Number(doc.generation), 2);
        assert.equal(await outboxRow(scope, articleId), null);
    } finally {
        server.state.hooks.afterPut = null;
        if (bSync) bSync.catch(() => {});
        globalThis.fetch = undefined;
    }
});

test('一般編輯一篇被其他裝置刪除的文章仍走 deleted_remote 衝突，不自動 restore', async () => {
    const context = newContext('tab-edit-deleted-conflict');
    const { server } = context;
    const articleId = 'cross-edit-deleted-conflict';
    try {
        const scope = await seedRevision3(context, articleId);

        // B 刪除並同步：遠端 revision 4 tombstone。
        assert.equal((await tabB.store.deleteArticle(articleId)).ok, true);
        const deleteRound = await tabB.sync.syncArticles();
        assert.equal(deleteRound.ok, true, JSON.stringify(deleteRound));
        assert.equal(deleteRound.pushed.conflicts, 0, JSON.stringify(deleteRound.pushed));
        assert.ok(server.state.articles.get(articleId).deletedAt);
        assert.equal(server.state.articles.get(articleId).revision, 4);

        // A 的記憶體仍是刪除前的 live 文件：這是一般編輯，不是備份還原。
        assert.equal(tabA.store.getRecord(articleId).deletedAt, '');
        assert.equal((await tabA.store.saveArticle({ articleId, title: 'Title', article: 'a-v4' })).ok, true);
        const op = await outboxRow(scope, articleId);
        assert.equal(op.type, 'update', JSON.stringify(op));

        const restoreCallsBefore = server.state.restoreCalls;
        const round = await tabA.sync.syncArticles();
        assert.equal(round.ok, true, JSON.stringify(round));
        assert.equal(round.pushed.pushed, 0, JSON.stringify(round.pushed));
        assert.equal(round.pushed.conflicts, 1, JSON.stringify(round.pushed));
        const conflict = tabA.store.getConflicts().find((item) => item.articleId === articleId);
        assert.equal(conflict && conflict.kind, 'deleted_remote', JSON.stringify(conflict));
        assert.equal(server.state.restoreCalls, restoreCallsBefore, '一般編輯不應自動 restore');
        assert.ok(server.state.articles.get(articleId).deletedAt);
        assert.equal(server.state.articles.get(articleId).revision, 4);
        const doc = await docRow(scope, articleId);
        assert.equal(doc.body, 'a-v4', '衝突時必須保留本機正文讓使用者選擇');
        assert.equal(doc.dirty, true);
        assert.ok(await outboxRow(scope, articleId));
    } finally {
        globalThis.fetch = undefined;
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 第十一輪缺口 1：回執被拒後，同步收尾不得把不可讀／損壞桶當成空桶覆寫
// ─────────────────────────────────────────────────────────────────────────────

/** 讓後備桶在「create 已提交、回應交回 pushOne」之後才開始讀取失敗／損壞。 */
function armFallbackBucketAfterCreate(key, mode) {
    const baseFetch = globalThis.fetch;
    const originalGetItem = globalThis.localStorage.getItem;
    const originalSetItem = globalThis.localStorage.setItem;
    const isBucketKey = (value) => String(value).startsWith('bdc:articles:fallback:v1:');
    let armed = false;
    const state = { readFails: false };
    globalThis.localStorage.getItem = (readKey) => {
        if (state.readFails && isBucketKey(readKey)) throw new Error('SecurityError');
        return originalGetItem.call(globalThis.localStorage, readKey);
    };
    globalThis.fetch = async (url, init = {}) => {
        const response = await baseFetch(url, init);
        const method = String(init.method || 'GET').toUpperCase();
        if (!armed && method === 'POST' && new URL(url).pathname === '/articles') {
            armed = true;
            // 伺服器已提交 rev1；pushOne 之後才會讀桶，先把桶變成不可讀／損壞。
            if (mode === 'corrupt') originalSetItem.call(globalThis.localStorage, key, '{not-json');
            else state.readFails = true;
        }
        return response;
    };
    return {
        state,
        restore() {
            globalThis.localStorage.getItem = originalGetItem;
            globalThis.localStorage.setItem = originalSetItem;
            globalThis.fetch = undefined;
        }
    };
}

test('localStorage 後備：持續讀取例外時同步收尾不得覆寫後備桶，恢復後同 mutation 完成同步', async (t) => {
    const context = newContext('tab-fallback-finish-read');
    const { server } = context;
    const user = 'tab-fallback-finish-read';
    const scope = scopeFor(user);
    const articleId = 'fallback-finish-read';
    const key = `bdc:articles:fallback:v1:${scope}`;
    startScope(user);
    const savedIndexedDB = globalThis.indexedDB;
    let f1;
    try {
        globalThis.indexedDB = undefined;
        f1 = await bootTab('p1');
        await f1.store.reloadScope(scope);
    } finally {
        globalThis.indexedDB = savedIndexedDB;
    }

    assert.equal((await f1.store.saveArticle({ articleId, title: 'Title', article: 'f-v1' })).ok, true);
    const beforeRaw = localStorage.getItem(key);
    const armed = armFallbackBucketAfterCreate(key, 'read');
    t.after(() => armed.restore());

    const failedRound = await f1.sync.syncArticles();
    assert.equal(server.state.articles.get(articleId).revision, 1, '伺服器必須已提交 rev1');
    assert.equal(failedRound.ok, false, JSON.stringify(failedRound));
    assert.equal(failedRound.error, 'storage_read_failed', JSON.stringify(failedRound));
    assert.equal(failedRound.pushed.pushed, 0, '回執讀取失敗卻計為推送成功');
    assert.equal(failedRound.pushed.failed, 1, JSON.stringify(failedRound.pushed));
    assert.equal(failedRound.pushed.conflicts, 0, JSON.stringify(failedRound.pushed));
    // 恢復讀取後才能比對桶內容：拉取階段合法寫入的 cursor 可以變，
    // 但文件與 outbox 必須原封不動（不可讀時不得被當成空桶覆寫）。
    armed.state.readFails = false;
    const afterBucket = JSON.parse(localStorage.getItem(key));
    const beforeBucket = JSON.parse(beforeRaw);
    assert.deepEqual(afterBucket.docs, beforeBucket.docs, '同步收尾覆寫了文件');
    assert.deepEqual(afterBucket.outbox, beforeBucket.outbox, '同步收尾覆寫了 outbox');
    assert.equal(afterBucket.state.lastSyncAt, '', '收尾失敗卻寫入了 lastSyncAt');

    // 恢復讀取後仍保有原 mutation：下一輪重試即可完成，且沒有假衝突。
    const retryRound = await f1.sync.syncArticles();
    assert.equal(retryRound.ok, true, JSON.stringify(retryRound));
    assert.equal(retryRound.pushed.pushed, 1, JSON.stringify(retryRound.pushed));
    assert.equal(retryRound.pushed.failed, 0, JSON.stringify(retryRound.pushed));
    assert.equal(retryRound.pushed.conflicts, 0, JSON.stringify(retryRound.pushed));
    assert.equal(server.state.articles.get(articleId).revision, 1);
    const bucket = fallbackBucket(scope);
    const doc = bucket.docs.find((item) => item.id === articleId);
    assert.equal(Number(doc.revision), 1);
    assert.equal(doc.dirty, false);
    assert.equal(bucket.outbox.filter((op) => op.articleId === articleId).length, 0);
    assert.equal(f1.store.getConflicts().length, 0, JSON.stringify(f1.store.getConflicts()));
});

test('localStorage 後備：桶在收尾時損壞（非法 JSON）也不得被覆寫成空桶', async (t) => {
    const context = newContext('tab-fallback-finish-corrupt');
    const { server } = context;
    const user = 'tab-fallback-finish-corrupt';
    const scope = scopeFor(user);
    const articleId = 'fallback-finish-corrupt';
    const key = `bdc:articles:fallback:v1:${scope}`;
    startScope(user);
    const savedIndexedDB = globalThis.indexedDB;
    let f1;
    try {
        globalThis.indexedDB = undefined;
        f1 = await bootTab('p2');
        await f1.store.reloadScope(scope);
    } finally {
        globalThis.indexedDB = savedIndexedDB;
    }

    assert.equal((await f1.store.saveArticle({ articleId, title: 'Title', article: 'f-v1' })).ok, true);
    const beforeRaw = localStorage.getItem(key);
    const armed = armFallbackBucketAfterCreate(key, 'corrupt');
    t.after(() => armed.restore());

    const failedRound = await f1.sync.syncArticles();
    assert.equal(server.state.articles.get(articleId).revision, 1);
    assert.equal(failedRound.ok, false, JSON.stringify(failedRound));
    assert.equal(failedRound.error, 'storage_corrupt', JSON.stringify(failedRound));
    assert.equal(failedRound.pushed.pushed, 0, '損壞桶卻計為推送成功');
    assert.equal(failedRound.pushed.failed, 1, JSON.stringify(failedRound.pushed));
    assert.equal(localStorage.getItem(key), '{not-json', '同步收尾覆寫了損壞的桶');

    // 修復桶之後，原 mutation 仍在，可以完成同步。
    localStorage.setItem(key, beforeRaw);
    const retryRound = await f1.sync.syncArticles();
    assert.equal(retryRound.ok, true, JSON.stringify(retryRound));
    assert.equal(retryRound.pushed.pushed, 1, JSON.stringify(retryRound.pushed));
    assert.equal(retryRound.pushed.conflicts, 0, JSON.stringify(retryRound.pushed));
    assert.equal(server.state.articles.get(articleId).revision, 1);
    const bucket = fallbackBucket(scope);
    assert.equal(Number(bucket.docs.find((item) => item.id === articleId).revision), 1);
    assert.equal(bucket.outbox.filter((op) => op.articleId === articleId).length, 0);
    assert.equal(f1.store.getConflicts().length, 0, JSON.stringify(f1.store.getConflicts()));
});

// ─────────────────────────────────────────────────────────────────────────────
// 第十一輪缺口 2：outbox 形狀損壞不得被當成空 outbox
// ─────────────────────────────────────────────────────────────────────────────

test('localStorage 後備：outbox 不是陣列時單筆／批次／完整同步都不得接受或計入 pushed', async (t) => {
    const context = newContext('tab-fallback-outbox-shape');
    const { server } = context;
    const user = 'tab-fallback-outbox-shape';
    const scope = scopeFor(user);
    const articleA = 'fallback-outbox-shape-a';
    const articleB = 'fallback-outbox-shape-b';
    const key = `bdc:articles:fallback:v1:${scope}`;
    startScope(user);
    const savedIndexedDB = globalThis.indexedDB;
    let f1;
    try {
        globalThis.indexedDB = undefined;
        f1 = await bootTab('p3');
        await f1.store.reloadScope(scope);
    } finally {
        globalThis.indexedDB = savedIndexedDB;
    }
    t.after(() => { globalThis.fetch = undefined; });

    assert.equal((await f1.store.saveArticle({ articleId: articleA, title: 'A', article: 'a-v1' })).ok, true);
    assert.equal((await f1.store.saveArticle({ articleId: articleB, title: 'B', article: 'b-v1' })).ok, true);
    const validRaw = localStorage.getItem(key);
    const validBucket = JSON.parse(validRaw);
    const receipts = [articleA, articleB].map((articleId) => {
        const op = validBucket.outbox.find((item) => item.articleId === articleId);
        assert.ok(op, `缺少 ${articleId} 的待同步操作`);
        return {
            articleId,
            revision: 1,
            serverUpdatedAt: '2026-10-22T14:00:00.000Z',
            clientMutationId: op.clientMutationId,
            generation: op.generation
        };
    });

    // 合法 docs + 損壞的 outbox：不得當成「沒有待確認操作」。
    const damagedRaw = JSON.stringify({ ...validBucket, outbox: { damaged: true } });
    localStorage.setItem(key, damagedRaw);
    const single = await f1.store.markOpDone(articleA, receipts[0]);
    assert.equal(single.ok, false, JSON.stringify(single));
    assert.equal(single.error, 'storage_corrupt', JSON.stringify(single));
    assert.equal(localStorage.getItem(key), damagedRaw, '單筆回執把損壞的 outbox 覆寫成 []');
    const batch = await f1.store.markOpsDone([receipts[1]]);
    assert.equal(batch.ok, false, JSON.stringify(batch));
    assert.equal(batch.error, 'storage_corrupt', JSON.stringify(batch));
    assert.equal(localStorage.getItem(key), damagedRaw, '批次回執把損壞的 outbox 覆寫成 []');

    // 完整同步：不得把損壞的 outbox 當成空 outbox 送出，也不得回報成功。
    const round = await f1.sync.syncArticles();
    assert.equal(round.ok, false, JSON.stringify(round));
    assert.equal(round.pushed.pushed, 0, '損壞 outbox 卻計入 pushed');
    assert.equal(round.pushed.conflicts, 0, JSON.stringify(round.pushed));
    assert.equal(server.state.createCalls + server.state.putCalls, 0, '損壞 outbox 仍送出寫入');
    assert.equal(localStorage.getItem(key), damagedRaw, '同步把損壞的 outbox 覆寫成 []');
    const damagedBucket = JSON.parse(localStorage.getItem(key));
    assert.equal(damagedBucket.docs.find((item) => item.id === articleA).dirty, true);
    assert.equal(damagedBucket.docs.find((item) => item.id === articleA).pending, true);

    // 缺省 outbox（舊格式）與 null 仍視為合法空 outbox；null／空字串桶也是合法空桶。
    for (const legacyOutbox of [undefined, null]) {
        const legacyBucket = { ...validBucket };
        if (legacyOutbox === undefined) delete legacyBucket.outbox;
        else legacyBucket.outbox = legacyOutbox;
        localStorage.setItem(key, JSON.stringify(legacyBucket));
        const legacy = await f1.store.markOpDone(articleA, receipts[0]);
        assert.equal(legacy.ok, true, JSON.stringify(legacy));
        assert.equal(legacy.stale, true, JSON.stringify(legacy));
    }
    localStorage.removeItem(key);
    const nullBucket = await f1.store.markOpDone(articleA, receipts[0]);
    assert.equal(nullBucket.ok, true, JSON.stringify(nullBucket));
    assert.equal(nullBucket.stale, true, JSON.stringify(nullBucket));
    localStorage.setItem(key, '');
    const emptyBucket = await f1.store.markOpsDone([receipts[0]]);
    assert.equal(emptyBucket.ok, true, JSON.stringify(emptyBucket));
    assert.equal(emptyBucket.results[0].matches, false, JSON.stringify(emptyBucket));

    // 還原合法桶後，原本的操作仍可完成確認（資料沒有被前一輪清掉）。
    localStorage.setItem(key, validRaw);
    const retried = await f1.store.markOpsDone(receipts);
    assert.equal(retried.ok, true, JSON.stringify(retried));
    for (const item of retried.results || []) assert.equal(item.matches, true, JSON.stringify(item));
    const bucket = fallbackBucket(scope);
    assert.equal(Number(bucket.docs.find((item) => item.id === articleA).revision), 1);
    assert.equal(Number(bucket.docs.find((item) => item.id === articleB).revision), 1);
    assert.equal(bucket.outbox.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 第十一輪缺口 3：restore 成功、PUT 失敗後，後續操作必須用已確認的 revision
// ─────────────────────────────────────────────────────────────────────────────

/** 準備「備份還原覆蓋 delta 墓碑 + 新正文」的狀態（outbox 為 restore_update）。 */
async function seedRestoreUpdate(context, articleId) {
    const { server } = context;
    const scope = await seedRevision3(context, articleId);
    const backup = await tabA.store.exportDocuments();
    const beforeDelete = server.state.articles.get(articleId);
    server.state.articles.set(articleId, {
        ...beforeDelete,
        revision: 4,
        updatedAt: '2026-10-22T11:00:00.000Z',
        deletedAt: '2026-10-22T11:00:00.000Z',
        lastMutationId: ''
    });
    const tombstoned = await tabA.store.applyRemoteTombstone(articleId);
    assert.equal(tombstoned.ok, true, JSON.stringify(tombstoned));
    assert.equal(tombstoned.applied, true, JSON.stringify(tombstoned));
    const imported = await tabA.store.importDocuments(backup, { replace: true });
    assert.equal(imported.ok, true, JSON.stringify(imported));
    assert.equal((await outboxRow(scope, articleId)).type, 'restore_update');
    assert.equal((await tabA.store.saveArticle({ articleId, title: 'Title', article: 'a-v7' })).ok, true);
    assert.equal((await outboxRow(scope, articleId)).payload.body, 'a-v7');
    return scope;
}

/** 只讓下一次 PUT 回 503（restore 已成功），模擬 restore 與 PUT 之間的暫時性失敗。 */
function failNextPut(server, articleId) {
    const state = { remaining: 1 };
    server.state.hooks.beforePut = ({ id }) => {
        if (id !== articleId || state.remaining <= 0) return null;
        state.remaining -= 1;
        return new Response(JSON.stringify({ code: 'temporary_failure' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' }
        });
    };
    return state;
}

test('restore 成功、PUT 503 後：文件與 outbox 都採用已確認 revision，刪除不再 409', async () => {
    const context = newContext('tab-restore-put-then-delete');
    const { server } = context;
    const articleId = 'cross-restore-put-then-delete';
    try {
        const scope = await seedRestoreUpdate(context, articleId);
        const putState = failNextPut(server, articleId);

        const failedRound = await tabA.sync.syncArticles();
        assert.equal(putState.remaining, 0, 'PUT 失敗注入沒有生效');
        assert.equal(failedRound.ok, true, JSON.stringify(failedRound));
        assert.equal(failedRound.pushed.pushed, 0, JSON.stringify(failedRound.pushed));
        assert.equal(failedRound.pushed.conflicts, 0, '暫時性 PUT 失敗被誤判成衝突');
        assert.equal(failedRound.pushed.failed, 1, JSON.stringify(failedRound.pushed));

        // restore（墓碑 rev4 → rev5）已成功；PUT 失敗，正文仍是遠端舊版。
        const remote = server.state.articles.get(articleId);
        assert.equal(remote.deletedAt, '', 'restore 應該已清掉墓碑');
        assert.equal(remote.revision, 5, JSON.stringify(remote));
        assert.equal(remote.body, 'v3');

        let doc = await docRow(scope, articleId);
        assert.equal(Number(doc.revision), 5, 'restore 已確認的 revision 沒有落地到文件');
        assert.equal(doc.body, 'a-v7', '未完成的正文必須保留');
        assert.equal(doc.dirty, true);
        assert.equal(doc.pending, true);
        let op = await outboxRow(scope, articleId);
        assert.equal(op.type, 'restore_update', JSON.stringify(op));
        assert.equal(Number(op.expectedRevision), 5, 'outbox 的版本基準沒有推進到 restore 後的 revision');
        assert.equal(op.payload.body, 'a-v7');
        assert.equal(tabA.store.getConflicts().length, 0, JSON.stringify(tabA.store.getConflicts()));

        // 使用者直接刪除：必須用 rev5，不能用 restore 前的 rev3。
        assert.equal((await tabA.store.deleteArticle(articleId)).ok, true);
        op = await outboxRow(scope, articleId);
        assert.equal(op.type, 'delete', JSON.stringify(op));
        assert.equal(Number(op.expectedRevision), 5, 'DELETE 用了 restore 前的過期 revision');

        const deleteRound = await tabA.sync.syncArticles();
        assert.equal(deleteRound.ok, true, JSON.stringify(deleteRound));
        assert.equal(deleteRound.pushed.pushed, 1, JSON.stringify(deleteRound.pushed));
        assert.equal(deleteRound.pushed.conflicts, 0, '沒有其他裝置修改卻產生 409 假衝突');
        assert.equal(deleteRound.pushed.failed, 0, JSON.stringify(deleteRound.pushed));
        const deleted = server.state.articles.get(articleId);
        assert.ok(deleted.deletedAt, '遠端沒有被刪除');
        assert.equal(deleted.revision, 6, JSON.stringify(deleted));
        assert.equal(tabA.store.getConflicts().length, 0, JSON.stringify(tabA.store.getConflicts()));
        assert.equal(await outboxRow(scope, articleId), null);
        assert.equal(Number((await docRow(scope, articleId)).revision), 6);
    } finally {
        server.state.hooks.beforePut = null;
        globalThis.fetch = undefined;
    }
});

test('restore 成功、PUT 503 後：重載／舊代際回執都安全，重試 PUT 以新 revision 成功', async () => {
    const context = newContext('tab-restore-put-retry');
    const { server } = context;
    const articleId = 'cross-restore-put-retry';
    try {
        const scope = await seedRestoreUpdate(context, articleId);
        const putState = failNextPut(server, articleId);
        const failedRound = await tabA.sync.syncArticles();
        assert.equal(putState.remaining, 0);
        assert.equal(failedRound.pushed.failed, 1, JSON.stringify(failedRound.pushed));

        const op = await outboxRow(scope, articleId);
        assert.equal(Number(op.expectedRevision), 5, JSON.stringify(op));
        assert.equal(Number((await docRow(scope, articleId)).revision), 5);

        // 墓碑前代際（重建前 gen0）的回執不得改動 restore 後的文件與操作。
        const staleReceipt = await tabA.store.markOpDone(articleId, {
            revision: 99,
            serverUpdatedAt: '2026-10-22T12:00:00.000Z',
            clientMutationId: op.clientMutationId,
            generation: 0
        });
        assert.equal(staleReceipt.ok, true, JSON.stringify(staleReceipt));
        assert.equal(staleReceipt.stale, true, JSON.stringify(staleReceipt));
        let doc = await docRow(scope, articleId);
        assert.equal(Number(doc.revision), 5, '舊代際回執推進了版本');
        assert.equal(doc.body, 'a-v7');
        assert.equal(doc.dirty, true);
        assert.ok(await outboxRow(scope, articleId), '舊代際回執清掉了 outbox');

        // 重新載入（模擬重新整理）後版本基準仍在。
        await tabA.store.reloadScope(scope);
        assert.equal(Number(tabA.store.getRecord(articleId).revision), 5);

        const retryRound = await tabA.sync.syncArticles();
        assert.equal(retryRound.ok, true, JSON.stringify(retryRound));
        assert.equal(retryRound.pushed.pushed, 1, JSON.stringify(retryRound.pushed));
        assert.equal(retryRound.pushed.conflicts, 0, JSON.stringify(retryRound.pushed));
        assert.equal(retryRound.pushed.failed, 0, JSON.stringify(retryRound.pushed));
        const remote = server.state.articles.get(articleId);
        assert.equal(remote.deletedAt, '');
        assert.equal(remote.body, 'a-v7');
        assert.equal(remote.revision, 6, JSON.stringify(remote));
        doc = await docRow(scope, articleId);
        assert.equal(Number(doc.revision), 6);
        assert.equal(doc.dirty, false);
        assert.equal(doc.pending, false);
        assert.equal(await outboxRow(scope, articleId), null);
        assert.equal(tabA.store.getConflicts().length, 0, JSON.stringify(tabA.store.getConflicts()));
    } finally {
        server.state.hooks.beforePut = null;
        globalThis.fetch = undefined;
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 第十三輪缺口 1（R1）：restore 回應遲到、別的分頁已完成 → applied:false
// 不得 markOpFailed（會留下沒有 outbox 的孤兒 pending，並把較新的 revision
// 回寫成記憶體裡的舊版本）。
// ─────────────────────────────────────────────────────────────────────────────

async function waitFor(condition, label = 'condition', timeoutMs = 5000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        if (await condition()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`waitFor 逾時：${label}`);
}

test('跨分頁：A 的 restore 回應遲到、B 已完成 → A 只回報 superseded，文件維持 clean 且 revision 最新', async () => {
    const context = newContext('tab-restore-superseded');
    const { server } = context;
    const articleId = 'cross-restore-superseded';
    let releaseA = null;
    let aRoundPromise = null;
    try {
        const scope = await seedRestoreUpdate(context, articleId);
        const aOp = await outboxRow(scope, articleId);
        assert.equal(aOp.type, 'restore_update', JSON.stringify(aOp));
        const aMutationId = aOp.clientMutationId;

        // 分頁 A 的 restore 已在伺服器完成，但回應暫扣在 hook 裡。
        const held = new Promise((resolve) => { releaseA = resolve; });
        let heldOnce = false;
        server.state.hooks.afterRestore = async ({ body }) => {
            if (body?.clientMutationId !== `${aMutationId}:restore` || heldOnce) return;
            heldOnce = true;
            await held;
        };
        aRoundPromise = tabA.sync.syncArticles();
        await waitFor(
            () => server.state.articles.get(articleId).deletedAt === ''
                && Number(server.state.articles.get(articleId).revision) === 5,
            'A 的 restore 尚未在伺服器完成'
        );

        // 等待期間：分頁 B 重新載入（看到墓碑與待還原正文）並完整同步。
        await tabB.store.reloadScope(scope);
        assert.equal(Number(tabB.store.getRecord(articleId).revision), 3);
        assert.equal(tabB.store.getRecord(articleId).pending, true);
        assert.equal(tabB.store.getRecord(articleId).deletedAt, '');
        const bRound = await tabB.sync.syncArticles();
        assert.equal(bRound.ok, true, JSON.stringify(bRound));
        assert.equal(bRound.pushed.pushed, 1, JSON.stringify(bRound.pushed));
        assert.equal(bRound.pushed.conflicts, 0, JSON.stringify(bRound.pushed));
        assert.equal(await outboxRow(scope, articleId), null, 'B 沒有清掉 outbox');
        const afterB = server.state.articles.get(articleId);
        assert.equal(afterB.deletedAt, '');
        assert.equal(afterB.body, 'a-v7', JSON.stringify(afterB));
        assert.equal(afterB.revision, 6, JSON.stringify(afterB));

        // A 的回應這時才送達：advanceOperationBase 會回 applied:false。
        releaseA();
        releaseA = null;
        const aRound = await aRoundPromise;
        aRoundPromise = null;
        assert.equal(aRound.ok, true, JSON.stringify(aRound));
        assert.equal(aRound.pushed.conflicts, 0, '被取代的操作被記成使用者衝突');
        assert.equal(aRound.pushed.failed, 0, JSON.stringify(aRound.pushed));
        assert.equal(tabA.store.getConflicts().length, 0, JSON.stringify(tabA.store.getConflicts()));

        // 持久化文件必須維持 B 完成後的狀態：clean、revision 最新、沒有孤兒 pending。
        const doc = await docRow(scope, articleId);
        assert.equal(Number(doc.revision), 6, 'A 用記憶體把較新的 revision 回寫成舊版本');
        assert.equal(doc.body, 'a-v7');
        assert.equal(doc.dirty, false, 'A 把已完成的操作重新標成 dirty');
        assert.equal(doc.pending, false, 'A 把已完成的操作重新標成 pending');
        assert.equal(doc.generation, 1, '墓碑後的代際被改動');
        assert.equal(await outboxRow(scope, articleId), null, 'A 留下了沒有 outbox 的孤兒 pending');
        assert.equal(Number((await summaryRow(scope, articleId)).revision), 6);

        // A 的記憶體只能由持久化資料重新載入，不能由記憶體回寫。
        await tabA.store.reloadScope(scope);
        assert.equal(Number(tabA.store.getRecord(articleId).revision), 6);
        assert.equal(tabA.store.getRecord(articleId).dirty, false);
        assert.equal(tabA.store.getRecord(articleId).pending, false);

        // 下一輪同步不會重送、也不會產生新的孤兒狀態。
        const nextRound = await tabA.sync.syncArticles();
        assert.equal(nextRound.ok, true, JSON.stringify(nextRound));
        assert.equal(nextRound.pushed.pushed, 0, JSON.stringify(nextRound.pushed));
        assert.equal(nextRound.pushed.conflicts, 0, JSON.stringify(nextRound.pushed));
        assert.equal(nextRound.pushed.failed, 0, JSON.stringify(nextRound.pushed));
        assert.equal(server.state.articles.get(articleId).revision, 6);
        assert.equal(await outboxRow(scope, articleId), null);
    } finally {
        if (releaseA) releaseA();
        if (aRoundPromise) await aRoundPromise.catch(() => {});
        server.state.hooks.afterRestore = null;
        globalThis.fetch = undefined;
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 第十三輪缺口 2（R2）：後備桶損壞／讀取失敗時，「讀改寫」入口一律不得覆寫
// ─────────────────────────────────────────────────────────────────────────────

/** 讓後備桶在指定前綴內讀取失敗（模擬 localStorage 例外）。 */
function armFallbackReadFailure(prefixes) {
    const original = globalThis.localStorage.getItem;
    const scopePrefixes = Array.isArray(prefixes) ? prefixes : [prefixes];
    const state = { active: false };
    globalThis.localStorage.getItem = (key) => {
        if (state.active && scopePrefixes.some((prefix) => String(key).startsWith(prefix))) {
            throw new Error('storage_read_failed');
        }
        return original.call(globalThis.localStorage, key);
    };
    state.restore = () => { globalThis.localStorage.getItem = original; };
    return state;
}

test('後備桶 outbox 損壞（物件）時：遠端墓碑／全量拉取／備份匯入都不得改寫桶並回報 storage_corrupt', async () => {
    const context = newContext('tab-fallback-corrupt-writes');
    const { server } = context;
    const user = 'tab-fallback-corrupt-writes';
    const scope = scopeFor(user);
    const articleId = 'fallback-corrupt-writes';
    const otherId = 'fallback-corrupt-writes-other';
    const key = `bdc:articles:fallback:v1:${scope}`;
    startScope(user);
    const savedIndexedDB = globalThis.indexedDB;
    let f1;
    try {
        globalThis.indexedDB = undefined;
        f1 = await bootTab('k1');
        await f1.store.reloadScope(scope);
    } finally {
        globalThis.indexedDB = savedIndexedDB;
    }

    try {
        // 兩篇都已建立；articleId 已確認同步（clean），otherId 保留待同步操作。
        assert.equal((await f1.store.saveArticle({ articleId, title: 'Title', article: 'k-v1' })).ok, true);
        assert.equal((await f1.store.saveArticle({ articleId: otherId, title: 'Title', article: 'o-v1' })).ok, true);
        const op = fallbackBucket(scope).outbox.find((item) => item.articleId === articleId);
        const ack = await f1.store.markOpDone(articleId, {
            revision: 2,
            serverUpdatedAt: '2026-04-04T00:00:00.000Z',
            clientMutationId: op.clientMutationId,
            generation: op.generation
        });
        assert.equal(ack.ok, true, JSON.stringify(ack));
        const validBucket = fallbackBucket(scope);
        assert.equal(validBucket.docs.find((item) => item.id === articleId).dirty, false);
        assert.ok(validBucket.outbox.find((item) => item.articleId === otherId), '缺少 otherId 的待同步操作');
        const backup = await f1.store.exportDocuments();

        // outbox 被寫成物件（損壞）：任何讀改寫入口都不得把它覆寫成陣列／空桶。
        const damagedRaw = JSON.stringify({ ...validBucket, outbox: { damaged: true } });
        localStorage.setItem(key, damagedRaw);

        // 1) 遠端墓碑
        const tombstone = await f1.store.applyRemoteTombstone(articleId);
        assert.equal(tombstone.ok, false, JSON.stringify(tombstone));
        assert.equal(tombstone.error, 'storage_corrupt', JSON.stringify(tombstone));
        assert.equal(localStorage.getItem(key), damagedRaw, '遠端墓碑把損壞的桶覆寫了');

        // 2) 全量拉取移除
        const reconciled = await f1.store.reconcileFullList([]);
        assert.equal(reconciled.ok, false, JSON.stringify(reconciled));
        assert.equal(reconciled.error, 'storage_corrupt', JSON.stringify(reconciled));
        assert.deepEqual(reconciled.removed, [], '讀取失敗卻回報已移除文件');
        assert.equal(localStorage.getItem(key), damagedRaw, '全量拉取把損壞的桶覆寫了');

        // 3) 備份匯入
        const imported = await f1.store.importDocuments(backup, { replace: true });
        assert.equal(imported.ok, false, JSON.stringify(imported));
        assert.equal(imported.error, 'storage_corrupt', JSON.stringify(imported));
        assert.equal(localStorage.getItem(key), damagedRaw, '備份匯入把損壞的桶覆寫了');

        // 同步層也要回報失敗，而不是把損壞的 outbox 當成空 outbox。
        const round = await f1.sync.syncArticles();
        assert.equal(round.ok, false, JSON.stringify(round));
        assert.equal(round.error, 'storage_corrupt', JSON.stringify(round));
        assert.equal(localStorage.getItem(key), damagedRaw, '同步把損壞的桶覆寫了');

        // 恢復成合法桶後，下一輪可以正常同步（資料沒有被前一輪清掉）。
        localStorage.setItem(key, JSON.stringify(validBucket));
        const recovered = await f1.sync.syncArticles();
        assert.equal(recovered.ok, true, JSON.stringify(recovered));
        assert.equal(recovered.pushed.pushed, 1, JSON.stringify(recovered.pushed));
        assert.equal(recovered.pushed.conflicts, 0, JSON.stringify(recovered.pushed));
        const bucket = fallbackBucket(scope);
        assert.equal(bucket.outbox.length, 0, '合法桶恢復後仍留有 outbox');
        assert.ok(bucket.docs.find((item) => item.id === articleId), '恢復後文件消失');
        assert.ok(bucket.docs.find((item) => item.id === otherId), '恢復後文件消失');
        assert.equal(server.state.articles.get(otherId).body, 'o-v1');
    } finally {
        globalThis.fetch = undefined;
    }
});

test('reconcileFullList 在 getItem 丟錯時回報 storage_read_failed，且不刪除任何文件與 outbox', async () => {
    newContext('tab-fallback-reconcile-read-fail');
    const user = 'tab-fallback-reconcile-read-fail';
    const scope = scopeFor(user);
    const articleId = 'fallback-reconcile-clean';
    const pendingId = 'fallback-reconcile-pending';
    const key = `bdc:articles:fallback:v1:${scope}`;
    startScope(user);
    const savedIndexedDB = globalThis.indexedDB;
    let f1;
    try {
        globalThis.indexedDB = undefined;
        f1 = await bootTab('k2');
        await f1.store.reloadScope(scope);
    } finally {
        globalThis.indexedDB = savedIndexedDB;
    }

    try {
        assert.equal((await f1.store.saveArticle({ articleId, title: 'Title', article: 'r-v1' })).ok, true);
        assert.equal((await f1.store.saveArticle({ articleId: pendingId, title: 'Title', article: 'p-v1' })).ok, true);
        const op = fallbackBucket(scope).outbox.find((item) => item.articleId === articleId);
        const ack = await f1.store.markOpDone(articleId, {
            revision: 2,
            serverUpdatedAt: '2026-05-05T00:00:00.000Z',
            clientMutationId: op.clientMutationId,
            generation: op.generation
        });
        assert.equal(ack.ok, true, JSON.stringify(ack));
        const before = localStorage.getItem(key);

        // getItem 從現在開始丟錯：記憶體是 clean 的，全量清單為空（會嘗試移除）。
        const failing = armFallbackReadFailure('bdc:articles:fallback:v1:');
        let reconciled;
        try {
            failing.active = true;
            reconciled = await f1.store.reconcileFullList([]);
        } finally {
            failing.active = false;
            failing.restore();
        }
        assert.equal(reconciled.ok, false, JSON.stringify(reconciled));
        assert.equal(reconciled.error, 'storage_read_failed', JSON.stringify(reconciled));
        assert.deepEqual(reconciled.removed, [], '讀取失敗卻回報已移除文件');
        assert.equal(localStorage.getItem(key), before, '讀取失敗時改寫了後備桶');

        // 讀取恢復正常後：兩篇文件與待同步操作都還在，下一輪仍可推送。
        const bucket = fallbackBucket(scope);
        assert.ok(bucket.docs.find((item) => item.id === articleId), '讀取失敗把 clean 文件刪掉了');
        assert.ok(bucket.docs.find((item) => item.id === pendingId), '讀取失敗把待同步文件刪掉了');
        assert.ok(bucket.outbox.find((item) => item.articleId === pendingId), '讀取失敗把 outbox 清掉了');
        const round = await f1.sync.syncArticles();
        assert.equal(round.ok, true, JSON.stringify(round));
        assert.equal(round.pushed.pushed, 1, JSON.stringify(round.pushed));
        const after = fallbackBucket(scope);
        assert.equal(after.outbox.length, 0);
        assert.ok(after.docs.find((item) => item.id === articleId));
        assert.ok(after.docs.find((item) => item.id === pendingId));
    } finally {
        globalThis.fetch = undefined;
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 第十四輪缺口 A：summaryOnly 全文載入失敗不得被當成「文章不存在」
//
// ensureArticleLoaded() 舊版在 IDB get 失敗或後備桶讀取失敗時回 null，與「真的
// 沒有這篇」不可區分；pushOne() 因此走 skip 分支 confirmReceipt()，把文件標成
// clean、清掉 outbox，實際內容從未送出。ensureArticleLoadedDetailed() 必須把
// 讀取失敗往上回報，pushOne() 不 confirm、不清 op，讀取恢復後下一輪正常上傳。
// ─────────────────────────────────────────────────────────────────────────────

/** 讓下一次對指定 docs key 的 IDB get 失敗（模擬 request／讀取例外）。 */
function armDocGetFailure(scope, articleId) {
    const original = FakeObjectStore.prototype.get;
    const key = `${scope}\u0000${articleId}`;
    const state = { active: false, hits: 0 };
    FakeObjectStore.prototype.get = function get(lookupKey) {
        if (state.active && this.name === 'docs' && String(lookupKey) === key) {
            state.active = false;
            state.hits += 1;
            this.injectFailure('injected docs get failure');
        }
        return original.call(this, lookupKey);
    };
    state.restore = () => { FakeObjectStore.prototype.get = original; };
    return state;
}

test('summaryOnly 文件在 IDB get 失敗時不得 confirm／清 outbox，恢復後下一輪正常上傳', async () => {
    const context = newContext('summary-load-failure');
    const { server } = context;
    const articleId = 'summary-load-failure';
    try {
        const scope = await seedRevision3(context, articleId);
        assert.equal((await tabA.store.saveArticle({ articleId, title: 'Title', article: 'a-v4' })).ok, true);
        const pending = await outboxRow(scope, articleId);
        assert.equal(pending.type, 'update', JSON.stringify(pending));
        assert.equal(Number(pending.expectedRevision), 3, JSON.stringify(pending));

        // 新分頁（相當於重新整理／另一個分頁開啟）只載入摘要，全文按需補。
        const fresh = await bootTab('k3');
        await fresh.store.reloadScope(scope);
        assert.equal(fresh.store.getRecord(articleId).summaryOnly, true, '測試前提：記錄必須是 summaryOnly');

        const failing = armDocGetFailure(scope, articleId);
        let round;
        try {
            failing.active = true;
            round = await fresh.sync.syncArticles();
        } finally {
            failing.active = false;
            failing.restore();
        }
        assert.equal(failing.hits, 1, '全文讀取失敗注入沒有生效');

        // 讀取失敗：這一筆不得算成功，也不能清 outbox／把文件標 clean。
        assert.equal(round.ok, true, JSON.stringify(round));
        assert.equal(round.pushed.pushed, 0, JSON.stringify(round.pushed));
        assert.equal(round.pushed.failed, 1, JSON.stringify(round.pushed));
        assert.equal(round.pushed.conflicts, 0, '讀取失敗被誤判成使用者衝突');
        assert.ok(round.pushed.errors && round.pushed.errors.length === 1, JSON.stringify(round.pushed));
        assert.equal(round.pushed.errors[0].articleId, articleId, JSON.stringify(round.pushed.errors));
        assert.ok(round.pushed.errors[0].error, JSON.stringify(round.pushed.errors));

        const keptOp = await outboxRow(scope, articleId);
        assert.ok(keptOp, '讀取失敗卻把 outbox 清掉了');
        assert.equal(keptOp.clientMutationId, pending.clientMutationId);
        assert.equal(Number(keptOp.expectedRevision), 3, JSON.stringify(keptOp));
        const remote = server.state.articles.get(articleId);
        assert.equal(remote.body, 'v3', '實際上沒有送出，遠端不該被改寫');
        assert.equal(remote.revision, 3, JSON.stringify(remote));
        const doc = await docRow(scope, articleId);
        assert.equal(doc.body, 'a-v4', '本機正文不得被跳過確認改寫');
        assert.equal(doc.dirty, true);
        assert.equal(doc.pending, true);

        // 讀取恢復後：下一輪以同一筆操作正常上傳。
        const recovered = await fresh.sync.syncArticles();
        assert.equal(recovered.ok, true, JSON.stringify(recovered));
        assert.equal(recovered.pushed.pushed, 1, JSON.stringify(recovered.pushed));
        assert.equal(recovered.pushed.failed, 0, JSON.stringify(recovered.pushed));
        const updated = server.state.articles.get(articleId);
        assert.equal(updated.body, 'a-v4');
        assert.equal(updated.revision, 4, JSON.stringify(updated));
        assert.equal(await outboxRow(scope, articleId), null);
        const finalDoc = await docRow(scope, articleId);
        assert.equal(finalDoc.dirty, false);
        assert.equal(finalDoc.pending, false);
        assert.equal(Number(finalDoc.revision), 4);
    } finally {
        globalThis.fetch = undefined;
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 第十四輪缺口 C：同代際新 DELETE 接手時，restore 已確認的 revision 必須交接
// ─────────────────────────────────────────────────────────────────────────────

test('跨操作：restore 回應遲到、使用者 DELETE 接手 → 新 op 的 expectedRevision 被推進，下一輪刪除不再 409', async () => {
    const context = newContext('tab-restore-then-delete');
    const { server } = context;
    const articleId = 'cross-restore-then-delete';
    let releaseA = null;
    let aRoundPromise = null;
    try {
        const scope = await seedRestoreUpdate(context, articleId);
        const restoreOp = await outboxRow(scope, articleId);
        assert.equal(restoreOp.type, 'restore_update', JSON.stringify(restoreOp));
        const restoreMutationId = restoreOp.clientMutationId;

        // A 的 restore 已在伺服器提交（rev5），但回應暫扣。
        const held = new Promise((resolve) => { releaseA = resolve; });
        let heldOnce = false;
        server.state.hooks.afterRestore = async ({ body }) => {
            if (body?.clientMutationId !== `${restoreMutationId}:restore` || heldOnce) return;
            heldOnce = true;
            await held;
        };
        aRoundPromise = tabA.sync.syncArticles();
        await waitFor(
            () => server.state.articles.get(articleId).deletedAt === ''
                && Number(server.state.articles.get(articleId).revision) === 5,
            'A 的 restore 尚未在伺服器完成'
        );

        // 等待期間使用者直接刪除：outbox 換成新的 delete 操作（仍是 rev3 基準）。
        const deleted = await tabA.store.deleteArticle(articleId);
        assert.equal(deleted.ok, true, JSON.stringify(deleted));
        const deleteOpBefore = await outboxRow(scope, articleId);
        assert.equal(deleteOpBefore.type, 'delete', JSON.stringify(deleteOpBefore));
        assert.equal(Number(deleteOpBefore.expectedRevision), 3, '測試前提：DELETE 仍用 restore 前的 revision');
        assert.notEqual(deleteOpBefore.clientMutationId, restoreMutationId);

        // restore 回應這時才送達：必須把已確認的 rev5 交接給新的 delete op。
        releaseA();
        releaseA = null;
        const aRound = await aRoundPromise;
        aRoundPromise = null;
        assert.equal(aRound.ok, true, JSON.stringify(aRound));
        assert.equal(aRound.pushed.pushed, 0, JSON.stringify(aRound.pushed));
        assert.equal(aRound.pushed.failed, 0, JSON.stringify(aRound.pushed));
        assert.equal(aRound.pushed.conflicts, 0, '交接被記成使用者衝突');

        const doc = await docRow(scope, articleId);
        assert.equal(Number(doc.revision), 5, 'restore 已確認的 revision 沒有交接給持久化文件');
        assert.ok(doc.deletedAt, '使用者刪除的 tombstone 被改寫');
        assert.equal(doc.body, 'a-v7', '使用者刪除前的正文不得被 restore 的舊內容覆寫');
        assert.equal(Number(doc.generation), 1, '交接不得換代際');

        const deleteOpAfter = await outboxRow(scope, articleId);
        assert.equal(deleteOpAfter.type, 'delete', '交接把新操作改成 restore_update');
        assert.equal(deleteOpAfter.clientMutationId, deleteOpBefore.clientMutationId, '交接改寫了新操作的 mutation');
        assert.equal(Number(deleteOpAfter.expectedRevision), 5, '新操作的 expectedRevision 沒有推進到伺服器版本');
        assert.deepEqual(deleteOpAfter.payload, deleteOpBefore.payload, '交接改寫了新操作的內容');
        assert.equal(deleteOpAfter.createdAt, deleteOpBefore.createdAt, '交接重建了新操作');
        assert.equal(tabA.store.getConflicts().length, 0, JSON.stringify(tabA.store.getConflicts()));

        // 下一輪 DELETE 以 rev5 送出：不再 409，正常刪除。
        const deleteRound = await tabA.sync.syncArticles();
        assert.equal(deleteRound.ok, true, JSON.stringify(deleteRound));
        assert.equal(deleteRound.pushed.pushed, 1, JSON.stringify(deleteRound.pushed));
        assert.equal(deleteRound.pushed.conflicts, 0, '沒有其他裝置修改卻產生 409 假衝突');
        assert.equal(deleteRound.pushed.failed, 0, JSON.stringify(deleteRound.pushed));
        const remote = server.state.articles.get(articleId);
        assert.ok(remote.deletedAt, '遠端沒有被刪除');
        assert.equal(remote.revision, 6, JSON.stringify(remote));
        assert.equal(await outboxRow(scope, articleId), null);
        assert.equal(Number((await docRow(scope, articleId)).revision), 6);
        assert.equal(tabA.store.getConflicts().length, 0, JSON.stringify(tabA.store.getConflicts()));
    } finally {
        if (releaseA) releaseA();
        if (aRoundPromise) await aRoundPromise.catch(() => {});
        server.state.hooks.afterRestore = null;
        globalThis.fetch = undefined;
    }
});

test('後備桶：同代際新操作接手時 advanceOperationBase 同樣只交接 revision（pending 為 null／代際不符則不動）', async () => {
    const user = 'tab-fallback-rebase';
    startScope(user);
    const scope = scopeFor(user);
    const articleId = 'fallback-rebase';
    const key = `bdc:articles:fallback:v1:${scope}`;
    const savedIndexedDB = globalThis.indexedDB;
    let f1;
    try {
        globalThis.indexedDB = undefined;
        f1 = await bootTab('k5');
        await f1.store.reloadScope(scope);
    } finally {
        globalThis.indexedDB = savedIndexedDB;
    }

    const baseDoc = {
        key: `${scope}\u0000${articleId}`,
        scope,
        id: articleId,
        title: 'Title',
        body: 'a-v7',
        analysis: null,
        sourceType: 'paste',
        sourceUrl: '',
        revision: 3,
        generation: 0,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        lastOpenedAt: '',
        deletedAt: '2026-01-02T00:00:00.000Z',
        dirty: true,
        pending: true,
        conflict: null,
        sizeBytes: 4
    };
    const newOp = {
        articleId,
        type: 'delete',
        clientMutationId: 'mutation-delete',
        expectedRevision: 3,
        generation: 0,
        payload: { title: 'Title', body: 'a-v7', analysis: null, sourceType: 'paste', sourceUrl: '' },
        createdAt: '2026-01-03T00:00:00.000Z'
    };
    const writeBucket = (docs, outbox) => localStorage.setItem(key, JSON.stringify({
        docs, outbox, state: {}, generations: {}
    }));

    try {
        // 同代際、pending 已是另一筆操作：只推進 revision／expectedRevision。
        writeBucket([{ ...baseDoc }], [{ ...newOp }]);
        const rebased = await f1.store.advanceOperationBase(articleId, 5, {
            clientMutationId: 'mutation-restore',
            generation: 0
        });
        assert.equal(rebased.ok, true, JSON.stringify(rebased));
        assert.equal(rebased.applied, false, JSON.stringify(rebased));
        assert.equal(rebased.rebased, true, JSON.stringify(rebased));
        let bucket = fallbackBucket(scope);
        assert.equal(Number(bucket.docs[0].revision), 5, JSON.stringify(bucket.docs[0]));
        assert.equal(bucket.docs[0].body, 'a-v7');
        assert.equal(bucket.docs[0].deletedAt, baseDoc.deletedAt);
        assert.equal(bucket.outbox[0].clientMutationId, 'mutation-delete');
        assert.equal(bucket.outbox[0].type, 'delete');
        assert.equal(Number(bucket.outbox[0].expectedRevision), 5, JSON.stringify(bucket.outbox[0]));
        assert.equal(bucket.outbox[0].payload.body, 'a-v7');

        // pending 為 null（別的分頁已完成）：完全不動。
        writeBucket([{ ...baseDoc, revision: 5 }], []);
        const noPending = await f1.store.advanceOperationBase(articleId, 6, {
            clientMutationId: 'mutation-restore',
            generation: 0
        });
        assert.equal(noPending.ok, true, JSON.stringify(noPending));
        assert.equal(noPending.applied, false);
        assert.notEqual(noPending.rebased, true);
        bucket = fallbackBucket(scope);
        assert.equal(Number(bucket.docs[0].revision), 5, 'pending 為 null 時仍改動了版本基準');

        // 代際不符：完全不動。
        writeBucket([{ ...baseDoc }], [{ ...newOp, generation: 1, expectedRevision: 3 }]);
        const wrongGeneration = await f1.store.advanceOperationBase(articleId, 7, {
            clientMutationId: 'mutation-restore',
            generation: 1
        });
        assert.equal(wrongGeneration.ok, true, JSON.stringify(wrongGeneration));
        assert.equal(wrongGeneration.applied, false);
        assert.notEqual(wrongGeneration.rebased, true);
        bucket = fallbackBucket(scope);
        assert.equal(Number(bucket.docs[0].revision), 3, '代際不符時仍改動了版本基準');
        assert.equal(Number(bucket.outbox[0].expectedRevision), 3);
    } finally {
        globalThis.fetch = undefined;
    }
});
