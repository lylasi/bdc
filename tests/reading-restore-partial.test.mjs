// 第十五輪缺口 P2：閱讀還原部分寫入失敗不得回報成功。
//
// `restoreAll(..., { allowPartial:true })` 原本只累計成功數，`writeEntity()`／
// `saveArticleVersion()` 的 `{ok:false}` 被忽略，`allowPartial:true` 時連
// `verifyErrors` 也一起丟掉，最後仍回 `{ok:true}`。備份還原因此會在資料缺一半
// 的情況下顯示成功，`adoptGuestReadingData()` 也會把失敗當成已併入。
//
// 這裡用 fake IndexedDB 在 `reading_items` 的 put 注入同步例外（等同配額／
// DataClone 失敗），驗證：
//   1. 其餘項目仍會被處理（partial 語意），但結果是 `ok:false` +
//      `partial_restore_failed`，並帶 `failures`／`verifyErrors`／`counts`；
//   2. `restoreSnapshotLocally()` 因此拋 `snapshot_restore_failed`；
//   3. `adoptGuestReadingData()` 也會看到失敗（不再回報 ok:true）；
//   4. `allowPartial:false` 維持既有 `verify_failed` 行為；
//   5. 移除注入後還原成功（反向驗證）。
//
// Usage: node --test --test-timeout=120000 tests/reading-restore-partial.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeIndexedDB, FakeObjectStore } from './helpers/fake-indexeddb.mjs';

const storage = new Map();
const localStorageShim = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => { storage.set(key, String(value)); },
    removeItem: (key) => { storage.delete(key); },
    key: (index) => [...storage.keys()][index] || null,
    get length() { return storage.size; }
};

class StubEmitter {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, callback) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type).add(callback);
    }
    removeEventListener(type, callback) {
        const set = this.listeners.get(type);
        if (set) set.delete(callback);
    }
    dispatchEvent(event) {
        const set = this.listeners.get(event && event.type);
        if (set) for (const callback of [...set]) callback(event);
        return true;
    }
}

globalThis.CustomEvent = class CustomEvent {
    constructor(type, init = {}) {
        this.type = type;
        this.detail = init && init.detail;
    }
};
const win = new StubEmitter();
win.localStorage = localStorageShim;
globalThis.window = win;
const doc = new StubEmitter();
doc.hidden = false;
globalThis.document = doc;
globalThis.localStorage = localStorageShim;
globalThis.Audio = class {
    play() { return Promise.resolve(); }
    pause() {}
    addEventListener() {}
    removeEventListener() {}
};
globalThis.indexedDB = createFakeIndexedDB();
globalThis.__BDC_SYNC_ENDPOINT__ = 'https://worker.mock';
globalThis.fetch = async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });

const articleStore = await import('../modules/article-store.js');
const readingStore = await import('../modules/reading-store.js');
const syncCore = await import('../modules/sync-core.js');

const ENDPOINT = 'https://worker.mock';
const USER = 'restore-partial-user';
const SCOPE = `${ENDPOINT}::${USER}`;
const ARTICLE_A = 'partial-article-a';
const ARTICLE_B = 'partial-article-b';

/**
 * 在指定 store、指定 id 的 put 注入同步例外（等同配額爆掉或 DataCloneError）。
 * `state.armed` 讓測試可以在播種資料後才啟用注入。
 */
function armWriteFailure(storeName, id) {
    const originalPut = FakeObjectStore.prototype.put;
    const state = { armed: false, hits: 0 };
    FakeObjectStore.prototype.put = function put(value, key) {
        if (state.armed && this.name === storeName && value && value.id === id) {
            state.armed = false;
            state.hits += 1;
            throw new Error('injected write failure');
        }
        return originalPut.call(this, value, key);
    };
    state.restore = () => { FakeObjectStore.prototype.put = originalPut; };
    return state;
}

async function seedScope() {
    localStorage.setItem('sync_token', 'test-token');
    localStorage.setItem('sync_user_id', USER);
    await articleStore.reloadScope(SCOPE);
    // 學習條目必須屬於已存在的文章：`upsertLearningItem()` 對不存在的文章
    // 會回 stale_scope。這裡只播種文章清單，不動閱讀資料。
    for (const articleId of [ARTICLE_A, ARTICLE_B]) {
        const existing = articleStore.getRecord(articleId);
        if (existing) continue;
        const saved = await articleStore.saveArticle({
            articleId,
            title: articleId,
            article: `body for ${articleId}`,
            sourceType: 'paste'
        });
        assert.equal(saved.ok, true, JSON.stringify(saved));
    }
    const init = await readingStore.initReadingStore(SCOPE);
    assert.equal(init.ok, true, JSON.stringify(init));
}

async function seedItems() {
    const a = await readingStore.upsertLearningItem({
        articleId: ARTICLE_A,
        kind: 'word',
        anchor: { start: 0, end: 5, quote: 'alpha' },
        note: '第一則'
    });
    assert.equal(a.ok, true, JSON.stringify(a));
    const b = await readingStore.upsertLearningItem({
        articleId: ARTICLE_B,
        kind: 'word',
        anchor: { start: 0, end: 5, quote: 'bravo' },
        note: '第二則'
    });
    assert.equal(b.ok, true, JSON.stringify(b));
    return { itemA: a.entity, itemB: b.entity };
}

async function resetStore() {
    await seedScope();
    await readingStore.clearScopeForTests();
    await seedScope();
}

test('writeEntity 失敗（allowPartial）：其餘項目照做，但回報 partial_restore_failed', async () => {
    await resetStore();
    const { itemA, itemB } = await seedItems();
    const payload = await readingStore.exportAll();
    assert.equal(payload.ok, true, JSON.stringify(payload));
    assert.equal(payload.learningItems.length, 2);

    await readingStore.clearScopeForTests();
    await seedScope();

    const failing = armWriteFailure('reading_items', itemA.id);
    let result;
    try {
        failing.armed = true;
        result = await readingStore.restoreAll(payload, { allowPartial: true });
    } finally {
        failing.armed = false;
        failing.restore();
    }
    assert.equal(failing.hits, 1, '寫入失敗注入沒有生效');

    assert.equal(result.ok, false, `部分寫入失敗仍回報成功：${JSON.stringify(result)}`);
    assert.equal(result.error, 'partial_restore_failed');
    assert.equal(result.counts.learningItems, 1, 'partial 語意要求其餘項目仍要寫入');
    assert.equal(result.failures.length, 1, JSON.stringify(result.failures));
    assert.equal(result.failures[0].entity, 'learningItem');
    assert.equal(result.failures[0].id, itemA.id);
    assert.equal(result.failures[0].error, 'idb_work_failed', JSON.stringify(result.failures[0]));
    assert.ok(result.verifyErrors.includes(`missing_item:${itemA.id}`), JSON.stringify(result.verifyErrors));

    // 其餘項目真的寫進去了。
    assert.equal(readingStore.getLearningItem(itemB.id)?.note, '第二則');
    assert.equal(readingStore.getLearningItem(itemA.id), null);
});

test('allowPartial:false 維持 verify_failed（不被新錯誤碼取代）', async () => {
    await resetStore();
    const { itemA } = await seedItems();
    const payload = await readingStore.exportAll();
    assert.equal(payload.ok, true);

    await readingStore.clearScopeForTests();
    await seedScope();

    const failing = armWriteFailure('reading_items', itemA.id);
    let result;
    try {
        failing.armed = true;
        result = await readingStore.restoreAll(payload, { allowPartial: false });
    } finally {
        failing.armed = false;
        failing.restore();
    }
    assert.equal(failing.hits, 1, '寫入失敗注入沒有生效');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'verify_failed');
    assert.ok(result.details.includes(`missing_item:${itemA.id}`), JSON.stringify(result.details));
});

test('restoreSnapshotLocally 遇到閱讀 partial 失敗必須拋 snapshot_restore_failed', async () => {
    await resetStore();
    const { itemA } = await seedItems();
    const payload = await readingStore.exportAll();
    assert.equal(payload.ok, true);

    await readingStore.clearScopeForTests();
    await seedScope();

    const failing = armWriteFailure('reading_items', itemA.id);
    try {
        failing.armed = true;
        await assert.rejects(
            () => syncCore.restoreSnapshotLocally({ reading: payload }),
            (error) => {
                assert.equal(error.code, 'snapshot_restore_failed', String(error && error.code));
                assert.match(String(error.message), /reading:partial_restore_failed/);
                const failure = (error.errors || []).find((item) => item.group === 'reading');
                assert.ok(failure, JSON.stringify(error.errors));
                assert.equal(failure.error, 'partial_restore_failed');
                return true;
            }
        );
    } finally {
        failing.armed = false;
        failing.restore();
    }
    assert.equal(failing.hits, 1, '寫入失敗注入沒有生效');
});

test('adoptGuestReadingData 的 partial 失敗會回 ok:false（不再被丟棄）', async () => {
    await resetStore();
    const guestScope = articleStore.getGuestScope();
    await readingStore.initReadingStore(guestScope);
    // 詞書不需要先有文章，適合用來驗證跨 scope 併入時的寫入失敗。
    const saved = await readingStore.upsertVocabularyBook({ id: 'guest-book', name: '訪客詞書' });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    await readingStore.initReadingStore(SCOPE);

    await readingStore.initReadingStore(SCOPE);
    const failing = armWriteFailure('vocab_books', 'guest-book');
    let result;
    try {
        failing.armed = true;
        result = await readingStore.adoptGuestReadingData();
    } finally {
        failing.armed = false;
        failing.restore();
    }
    assert.equal(failing.hits, 1, '寫入失敗注入沒有生效');
    assert.equal(result.ok, false, `訪客資料併入失敗仍回報成功：${JSON.stringify(result)}`);
    assert.equal(result.error, 'partial_restore_failed');
    assert.equal(result.imported, 1);
    assert.equal(result.failures[0].entity, 'vocabularyBook');
});

test('移除注入後還原成功（反向驗證）', async () => {
    await resetStore();
    const { itemA, itemB } = await seedItems();
    const payload = await readingStore.exportAll();
    assert.equal(payload.ok, true);

    await readingStore.clearScopeForTests();
    await seedScope();

    const result = await readingStore.restoreAll(payload, { allowPartial: true });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.counts.learningItems, 2);
    assert.equal(readingStore.getLearningItem(itemA.id)?.note, '第一則');
    assert.equal(readingStore.getLearningItem(itemB.id)?.note, '第二則');

    const snapshot = await syncCore.restoreSnapshotLocally({ reading: payload });
    assert.equal(snapshot.ok, true, JSON.stringify(snapshot));
});
