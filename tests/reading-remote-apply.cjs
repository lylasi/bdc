/**
 * 遠端批次套用與本機寫入的競態（真實 Chromium + 真實 IndexedDB）。
 *
 * Usage:
 *   PORT=8313 PLAYWRIGHT_MODULE=<path-to-playwright> node tests/reading-remote-apply.cjs
 *
 * 覆蓋：
 *   1. 暫停缺失 A 的補讀時修改既有 B 的筆記；遠端批次套用後，B 的實體與
 *      outbox 都必須保留新筆記，同時合併遠端其他欄位。
 *   2. 注入交易寫入失敗；永久資料、outbox 與記憶體都不能部分更新。
 */
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const PORT = Number(process.env.PORT || 8313);
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const results = [];
function record(name, fn) {
    return Promise.resolve().then(fn).then(
        () => results.push({ name, ok: true }),
        (error) => results.push({ name, ok: false, error: String(error && error.stack ? error.stack : error) })
    );
}

(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: CHROME });
    try {
        const context = await browser.newContext();
        await context.route('**/*', (route) => {
            const url = new URL(route.request().url());
            if (url.pathname.endsWith('/ai-config.js')) {
                return route.fulfill({
                    contentType: 'application/javascript',
                    body: `export const SYNC={endpoint: "${BASE}/review-sync"}; export const TTS_CONFIG={}, AI_LIMITS={}, OCR_CONFIG={}, ARTICLE_IMPORT={}, SUPABASE={};`
                });
            }
            if (url.origin !== BASE) return route.abort();
            return route.continue();
        });
        const page = await context.newPage();
        await page.goto(`${BASE}/test-reading-blank.html`);

        await record('暫停補讀期間的本機修改不被遠端批次覆寫', async () => {
            const outcome = await page.evaluate(async () => {
                const store = await import('/modules/reading-store.js');
                const art = await import('/modules/article-store.js');
                const db = await import('/modules/permanent-db.js');
                const scope = 'review-remote-apply::merge';
                await art.reloadScope(scope);
                await store.initReadingStore(scope);
                const ctx = store.captureReadingContext();
                const base = {
                    articleId: 'article-merge',
                    contentVersion: 'cv_merge',
                    kind: 'word',
                    anchor: { start: 0, end: 4, quote: 'test' },
                    sentence: 'test sentence',
                    marked: false,
                    understanding: 'unmarked',
                    revision: 1
                };
                const seeded = await store.persistRemoteEntity('learningItem', {
                    ...base,
                    id: 'item-b',
                    note: 'old local note'
                }, ctx);
                if (!seeded.ok) return { setupError: seeded.error };

                let release;
                let arrived;
                const held = new Promise((resolve) => { release = resolve; });
                const barrier = new Promise((resolve) => { arrived = resolve; });
                const originalGet = IDBObjectStore.prototype.get;
                let heldOnce = false;
                IDBObjectStore.prototype.get = function get(key) {
                    const request = originalGet.call(this, key);
                    if (!heldOnce && this.name === 'reading_items' && String(key).includes('item-a')) {
                        heldOnce = true;
                        const proxy = { get result() { return request.result; }, get error() { return request.error; } };
                        request.onsuccess = async (event) => {
                            arrived();
                            await held;
                            proxy.onsuccess?.(event);
                        };
                        request.onerror = (event) => proxy.onerror?.(event);
                        return proxy;
                    }
                    return request;
                };

                const remote = store.applyRemoteEntities([
                    {
                        entityType: 'learningItem',
                        entityId: 'item-a',
                        remote: { ...base, id: 'item-a', note: 'remote A', revision: 1 }
                    },
                    {
                        entityType: 'learningItem',
                        entityId: 'item-b',
                        remote: { ...base, id: 'item-b', note: 'remote note', sentence: 'remote sentence', revision: 2 }
                    }
                ], ctx);
                await barrier;
                const patched = await store.patchLearningItem('item-b', { note: 'new local note' });
                release();
                const applied = await remote;
                IDBObjectStore.prototype.get = originalGet;

                const rows = await db.readStoreAll(db.STORE.READING_ITEMS, scope);
                const outbox = await store.listOutbox(ctx);
                const memory = store.getLearningItem('item-b');
                return {
                    patched,
                    applied,
                    persistentB: rows.records.find((item) => item.id === 'item-b') || null,
                    persistentA: rows.records.find((item) => item.id === 'item-a') || null,
                    outbox,
                    memory
                };
            });
            assert.equal(outcome.setupError, undefined, outcome.setupError);
            assert.equal(outcome.patched.ok, true, JSON.stringify(outcome.patched));
            assert.equal(outcome.applied.ok, true, JSON.stringify(outcome.applied));
            assert.equal(outcome.persistentA?.note, 'remote A');
            assert.equal(outcome.persistentB?.note, 'new local note', '遠端批次用舊筆記覆寫了本機修改');
            assert.equal(outcome.persistentB?.sentence, 'remote sentence', '遠端其他欄位沒有合併');
            assert.equal(outcome.memory?.note, 'new local note', '記憶體被舊筆記覆寫');
            assert.equal(outcome.outbox.length, 1, JSON.stringify(outcome.outbox));
            assert.equal(outcome.outbox[0].entityId, 'item-b');
            assert.equal(outcome.outbox[0].patch.note, 'new local note', 'outbox 被舊筆記覆寫');
            assert.equal(outcome.outbox[0].patch.sentence, 'remote sentence', 'outbox 沒有合併遠端欄位');
        });

        await record('交易失敗時實體、outbox 與記憶體都不部分更新', async () => {
            const outcome = await page.evaluate(async () => {
                const store = await import('/modules/reading-store.js');
                const art = await import('/modules/article-store.js');
                const db = await import('/modules/permanent-db.js');
                const scope = 'review-remote-apply::failure';
                await art.reloadScope(scope);
                await store.initReadingStore(scope);
                const ctx = store.captureReadingContext();
                const base = {
                    articleId: 'article-failure',
                    contentVersion: 'cv_failure',
                    kind: 'word',
                    anchor: { start: 0, end: 4, quote: 'test' },
                    sentence: 'test sentence',
                    marked: false,
                    understanding: 'unmarked',
                    revision: 1
                };
                const seeded = await store.persistRemoteEntity('learningItem', {
                    ...base,
                    id: 'item-b',
                    note: 'old local note'
                }, ctx);
                if (!seeded.ok) return { setupError: seeded.error };

                const originalPut = IDBObjectStore.prototype.put;
                IDBObjectStore.prototype.put = function put(value, key) {
                    if (this.name === 'reading_items' && value && value.id === 'item-b') {
                        throw new DOMException('injected write failure', 'DataError');
                    }
                    return originalPut.call(this, value, key);
                };
                let applied;
                try {
                    applied = await store.applyRemoteEntities([
                        {
                            entityType: 'learningItem',
                            entityId: 'item-a',
                            remote: { ...base, id: 'item-a', note: 'remote A', revision: 1 }
                        },
                        {
                            entityType: 'learningItem',
                            entityId: 'item-b',
                            remote: { ...base, id: 'item-b', note: 'remote note', revision: 2 }
                        }
                    ], ctx);
                } finally {
                    IDBObjectStore.prototype.put = originalPut;
                }
                const rows = await db.readStoreAll(db.STORE.READING_ITEMS, scope);
                const outbox = await store.listOutbox(ctx);
                return {
                    applied,
                    persistentB: rows.records.find((item) => item.id === 'item-b') || null,
                    persistentA: rows.records.find((item) => item.id === 'item-a') || null,
                    outbox,
                    memory: store.getLearningItem('item-b')
                };
            });
            assert.equal(outcome.setupError, undefined, outcome.setupError);
            assert.equal(outcome.applied.ok, false, JSON.stringify(outcome.applied));
            assert.equal(outcome.persistentB?.note, 'old local note');
            assert.equal(outcome.persistentB?.revision, 1);
            assert.equal(outcome.persistentA, null, '交易失敗仍留下部分寫入');
            assert.equal(outcome.outbox.length, 0, JSON.stringify(outcome.outbox));
            assert.equal(outcome.memory?.note, 'old local note');
            assert.equal(outcome.memory?.revision, 1);
        });

        await record('reading_outbox 寫入失敗時實體、outbox 與記憶體都不部分更新', async () => {
            const outcome = await page.evaluate(async () => {
                const store = await import('/modules/reading-store.js');
                const art = await import('/modules/article-store.js');
                const db = await import('/modules/permanent-db.js');
                const scope = 'review-remote-apply::outbox-failure';
                await art.reloadScope(scope);
                await store.initReadingStore(scope);
                const ctx = store.captureReadingContext();
                const base = {
                    articleId: 'article-outbox-failure',
                    contentVersion: 'cv_outbox_failure',
                    kind: 'word',
                    anchor: { start: 0, end: 4, quote: 'test' },
                    sentence: 'test sentence',
                    marked: false,
                    understanding: 'unmarked',
                    revision: 1
                };
                const seeded = await store.persistRemoteEntity('learningItem', {
                    ...base,
                    id: 'item-d',
                    note: 'old local note'
                }, ctx);
                if (!seeded.ok) return { setupError: seeded.error };
                const patched = await store.patchLearningItem('item-d', { note: 'local note' });
                if (!patched.ok) return { setupError: patched.error };
                const before = (await store.listOutbox(ctx))[0];

                const originalPut = IDBObjectStore.prototype.put;
                IDBObjectStore.prototype.put = function put(value, key) {
                    if (this.name === 'reading_outbox') {
                        throw new DOMException('injected outbox failure', 'DataError');
                    }
                    return originalPut.call(this, value, key);
                };
                let applied;
                try {
                    applied = await store.applyRemoteEntities([
                        {
                            entityType: 'learningItem',
                            entityId: 'item-d',
                            remote: {
                                ...base,
                                id: 'item-d',
                                note: 'remote note',
                                sentence: 'remote sentence',
                                revision: 2
                            }
                        }
                    ], ctx);
                } finally {
                    IDBObjectStore.prototype.put = originalPut;
                }
                const rows = await db.readStoreAll(db.STORE.READING_ITEMS, scope);
                const outbox = await store.listOutbox(ctx);
                const state = await db.readStoreOne(db.STORE.READING_STATE, scope);
                return {
                    applied,
                    before,
                    persistent: rows.records.find((item) => item.id === 'item-d') || null,
                    outbox,
                    state,
                    memory: store.getLearningItem('item-d'),
                    conflicts: store.getReadingConflicts()
                };
            });
            assert.equal(outcome.setupError, undefined, outcome.setupError);
            assert.equal(outcome.applied.ok, false, JSON.stringify(outcome.applied));
            assert.equal(outcome.persistent?.note, 'local note');
            assert.equal(outcome.persistent?.revision, 1);
            assert.equal(outcome.persistent?.sentence, 'test sentence');
            assert.equal(outcome.outbox.length, 1, JSON.stringify(outcome.outbox));
            assert.equal(outcome.outbox[0].mutationId, outcome.before.mutationId, 'outbox 被部分更新');
            assert.equal(outcome.outbox[0].patch.note, 'local note');
            assert.equal(outcome.memory?.note, 'local note');
            assert.equal(outcome.memory?.revision, 1);
            assert.deepEqual(outcome.conflicts, []);
            assert.equal(outcome.state.value, null, 'state 在失敗交易中被寫入');
        });

        await record('reading_state 寫入失敗：衝突與 entity／outbox 一起回滾，重試後仍受保護', async () => {
            const outcome = await page.evaluate(async () => {
                const store = await import('/modules/reading-store.js');
                const art = await import('/modules/article-store.js');
                const db = await import('/modules/permanent-db.js');
                const scope = 'review-remote-apply::state-failure';
                await art.reloadScope(scope);
                await store.initReadingStore(scope);
                const ctx = store.captureReadingContext();
                const base = {
                    articleId: 'article-state-failure',
                    contentVersion: 'cv_state_failure',
                    kind: 'word',
                    anchor: { start: 0, end: 4, quote: 'test' },
                    sentence: 'test sentence',
                    marked: false,
                    understanding: 'unmarked',
                    revision: 1
                };
                const seeded = await store.persistRemoteEntity('learningItem', {
                    ...base,
                    id: 'item-e',
                    note: 'old local note'
                }, ctx);
                if (!seeded.ok) return { setupError: seeded.error };
                const patched = await store.patchLearningItem('item-e', { note: 'local note' });
                if (!patched.ok) return { setupError: patched.error };
                const before = (await store.listOutbox(ctx))[0];
                const remote = {
                    ...base,
                    id: 'item-e',
                    note: 'remote note',
                    sentence: 'remote sentence',
                    revision: 2
                };

                const originalPut = IDBObjectStore.prototype.put;
                IDBObjectStore.prototype.put = function put(value, key) {
                    if (this.name === 'reading_state') {
                        throw new DOMException('injected state failure', 'DataError');
                    }
                    return originalPut.call(this, value, key);
                };
                let failed;
                try {
                    failed = await store.applyRemoteEntities([
                        { entityType: 'learningItem', entityId: 'item-e', remote }
                    ], ctx);
                } finally {
                    IDBObjectStore.prototype.put = originalPut;
                }
                const failedRows = await db.readStoreAll(db.STORE.READING_ITEMS, scope);
                const failedOutbox = await store.listOutbox(ctx);
                const failedState = await db.readStoreOne(db.STORE.READING_STATE, scope);
                const failedMemory = store.getLearningItem('item-e');
                const failedConflicts = store.getReadingConflicts();

                // 重試：沒有注入時應成功合併，且衝突標記要持久化。
                const retried = await store.applyRemoteEntities([
                    { entityType: 'learningItem', entityId: 'item-e', remote }
                ], ctx);
                const retriedState = await db.readStoreOne(db.STORE.READING_STATE, scope);
                await store.reloadReadingScope(scope);
                const reloadedConflicts = store.getReadingConflicts();
                await store.ensureArticleReadingLoaded('article-state-failure');
                const reloadedItem = store.getLearningItem('item-e');
                // 同一個遠端 revision 重套不得把衝突標記清掉。
                const reapplied = await store.applyRemoteEntities([
                    { entityType: 'learningItem', entityId: 'item-e', remote }
                ], ctx);
                return {
                    before,
                    failed,
                    failedPersistent: failedRows.records.find((item) => item.id === 'item-e') || null,
                    failedOutbox,
                    failedState,
                    failedMemory,
                    failedConflicts,
                    retried,
                    retriedState,
                    reloadedConflicts,
                    reloadedItem,
                    reapplied,
                    finalConflicts: store.getReadingConflicts()
                };
            });
            assert.equal(outcome.setupError, undefined, outcome.setupError);
            assert.equal(outcome.failed.ok, false, JSON.stringify(outcome.failed));
            assert.equal(outcome.failedPersistent?.note, 'local note');
            assert.equal(outcome.failedPersistent?.revision, 1);
            assert.equal(outcome.failedOutbox.length, 1, JSON.stringify(outcome.failedOutbox));
            assert.equal(outcome.failedOutbox[0].mutationId, outcome.before.mutationId, 'state 失敗仍換掉 outbox');
            assert.equal(outcome.failedMemory?.note, 'local note');
            assert.equal(outcome.failedMemory?.revision, 1);
            assert.deepEqual(outcome.failedConflicts, []);
            assert.equal(outcome.failedState.value, null, '失敗交易寫入了 reading_state');

            assert.equal(outcome.retried.ok, true, JSON.stringify(outcome.retried));
            assert.equal(outcome.retried.conflicts, 1, JSON.stringify(outcome.retried));
            assert.equal(outcome.retriedState.value?.conflicts?.['learningItem:item-e']?.fields?.includes('note'), true,
                JSON.stringify(outcome.retriedState.value));
            assert.equal(outcome.reloadedConflicts.length, 1, JSON.stringify(outcome.reloadedConflicts));
            assert.equal(outcome.reloadedItem?.note, 'local note');
            assert.equal(outcome.reloadedItem?.sentence, 'remote sentence');
            assert.equal(outcome.reapplied.ok, true, JSON.stringify(outcome.reapplied));
            assert.equal(outcome.finalConflicts.length, 1, '重套遠端 revision 2 清掉了衝突標記');
        });

    } finally {
        await browser.close();
    }

    console.log(JSON.stringify(results, null, 2));
    process.exitCode = results.every((item) => item.ok) ? 0 : 1;
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
