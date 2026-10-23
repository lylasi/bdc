// 第十四輪缺口 D：本機備份還原不得忽略文章匯入失敗。
//
// 舊版 `applySnapshotPayload()` 用 try/catch 吞掉 `articleStore.importDocuments()`
// 的例外，也沒檢查 `{ok:false,error}`，`restoreSnapshotLocally()` 因此正常結束，
// 畫面顯示「還原成功」，實際上文章完全沒有寫回。
//
// 這裡讓文章 store 處於 localStorage 後備模式，並放入損壞的後備桶（outbox 是
// 物件而不是陣列），importDocuments() 會回報 storage_corrupt。驗證：
//   1. restoreSnapshotLocally() 拋出帶 code／訊息的錯誤（UI 會顯示 restoreFailed）；
//   2. applyMergedSnapshot() 不拋出，但回傳 ok:false 供除錯；
//   3. 損壞的桶沒有被覆寫，文章也真的沒有被當成匯入成功。
//
// Usage: node --test --test-timeout=120000 tests/snapshot-restore-errors.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

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
// 沒有 IndexedDB：article-store 會切到 localStorage 後備，才能模擬損壞的桶。
globalThis.indexedDB = undefined;
globalThis.__BDC_SYNC_ENDPOINT__ = 'https://worker.mock';

const articleStore = await import('../modules/article-store.js');
const syncCore = await import('../modules/sync-core.js');

const ENDPOINT = 'https://worker.mock';
const USER = 'restore-user';
const SCOPE = `${ENDPOINT}::${USER}`;
const ARTICLE_ID = 'restored-article';
const FALLBACK_KEY = `bdc:articles:fallback:v1:${SCOPE}`;
const CORRUPT_BUCKET = JSON.stringify({
    docs: [],
    // outbox 應該是陣列；物件代表桶已損壞，嚴格讀取必須回報 storage_corrupt。
    outbox: { broken: true },
    state: {},
    generations: {}
});

const PAYLOAD = {
    articleDocuments: [{
        id: ARTICLE_ID,
        title: 'Restored',
        body: 'restored body',
        analysis: { translation: '還原內容' },
        sourceType: 'paste',
        sourceUrl: '',
        revision: 3,
        generation: 0
    }]
};

function prepare() {
    localStorage.setItem('sync_token', 'test-token');
    localStorage.setItem('sync_user_id', USER);
    localStorage.setItem(FALLBACK_KEY, CORRUPT_BUCKET);
}

test('備份含損壞後備桶：restoreSnapshotLocally 必須拋錯，importDocuments 不得被當成功', async () => {
    prepare();
    const before = localStorage.getItem(FALLBACK_KEY);

    await assert.rejects(
        () => syncCore.restoreSnapshotLocally(PAYLOAD),
        (error) => {
            assert.equal(error.code, 'snapshot_restore_failed', String(error && error.code));
            assert.match(String(error.message), /articleDocuments/);
            assert.ok(Array.isArray(error.errors), '錯誤沒有帶出群組明細');
            const failure = error.errors.find((item) => item.group === 'articleDocuments');
            assert.ok(failure, JSON.stringify(error.errors));
            assert.equal(failure.error, 'storage_corrupt', JSON.stringify(failure));
            return true;
        }
    );

    // 損壞的桶沒有被覆寫（否則其他文章與待同步操作會消失）。
    assert.equal(localStorage.getItem(FALLBACK_KEY), before, '還原失敗卻改寫了後備桶');
    // 文章沒有被當成匯入成功。
    assert.equal(articleStore.getRecord(ARTICLE_ID), null, '還原失敗卻留下已匯入的文章記錄');
    const bucket = JSON.parse(localStorage.getItem(FALLBACK_KEY));
    assert.equal((bucket.docs || []).length, 0, '還原失敗卻寫入了文件');
});

test('applyMergedSnapshot 不拋出，但回傳 ok:false 供除錯', async () => {
    prepare();
    const result = await syncCore.applyMergedSnapshot({ payload: PAYLOAD });
    assert.equal(result.ok, false, JSON.stringify(result));
    const failure = (result.errors || []).find((item) => item.group === 'articleDocuments');
    assert.ok(failure, JSON.stringify(result.errors));
    assert.equal(failure.error, 'storage_corrupt');
    assert.equal(articleStore.getRecord(ARTICLE_ID), null);
});

test('桶恢復正常後：restoreSnapshotLocally 會把文章寫回（反向驗證）', async () => {
    prepare();
    localStorage.setItem(FALLBACK_KEY, JSON.stringify({ docs: [], outbox: [], state: {}, generations: {} }));
    const result = await syncCore.restoreSnapshotLocally(PAYLOAD);
    assert.equal(result.ok, true, JSON.stringify(result));
    const record = articleStore.getRecord(ARTICLE_ID);
    assert.ok(record, '還原成功卻找不到文章');
    assert.equal(record.article, 'restored body');
    const bucket = JSON.parse(localStorage.getItem(FALLBACK_KEY));
    const stored = (bucket.docs || []).find((item) => item && item.id === ARTICLE_ID);
    assert.ok(stored, '還原成功卻沒有寫入後備桶');
    assert.equal(stored.body, 'restored body');
});
