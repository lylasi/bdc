// 第十四輪缺口 B：備份匯出的必要群組失敗時不得存成「成功備份」。
//
// 舊版 `buildAndSaveBackup()` 用 try/catch 把文章匯出失敗轉成 `[]`、忽略
// `readingStore.exportAll()` 的 `ok:false`，之後照樣 `saveBackupPayload()`、
// 裁剪舊備份並寫入自動備份簽章。同一簽章會讓下一次自動備份跳過重建，等於用
// 一份沒有資料的備份永久覆蓋可用備份。
//
// 這裡讓 IndexedDB 讀取在指定 store 失敗，驗證：
//   1. 回傳 `{ error }`（不是 `{ id }`），沒有新增備份；
//   2. 既有備份索引／中繼資料不被裁剪；
//   3. 自動備份簽章維持原值（下一次仍會重建）。
//
// Usage: node --test --test-timeout=120000 tests/local-backup-export.test.mjs

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
const backup = await import('../modules/local-backup.js');

const ENDPOINT = 'https://worker.mock';
const USER = 'backup-user';
const SCOPE = `${ENDPOINT}::${USER}`;

const BACKUP_PREFIX = 'bdc:backup:v1:';
const INDEX_KEY = 'bdc:backup:index:v1';
const META_KEY = 'bdc:backup:meta:v1';
const SIGNATURE_KEY = 'bdc:backup:last-auto-signature:v1';
const SIGNATURE = 'signature-before-failure';

/** 讓指定 store 的下一次 getAll（直接呼叫或經 scope index）失敗。 */
function armStoreReadFailure(storeName, { viaIndex = false } = {}) {
    const originalGetAll = FakeObjectStore.prototype.getAll;
    const originalIndex = FakeObjectStore.prototype.index;
    const state = { active: false, hits: 0 };
    FakeObjectStore.prototype.getAll = function getAll(...args) {
        if (!viaIndex && state.active && this.name === storeName) {
            state.active = false;
            state.hits += 1;
            this.injectFailure('injected getAll failure');
        }
        return originalGetAll.apply(this, args);
    };
    FakeObjectStore.prototype.index = function index(name) {
        const target = originalIndex.call(this, name);
        if (viaIndex && state.active && this.name === storeName) {
            const realGetAll = target.getAll;
            target.getAll = (value) => {
                if (state.active) {
                    state.active = false;
                    state.hits += 1;
                    this.injectFailure('injected index getAll failure');
                }
                return realGetAll.call(target, value);
            };
        }
        return target;
    };
    state.restore = () => {
        FakeObjectStore.prototype.getAll = originalGetAll;
        FakeObjectStore.prototype.index = originalIndex;
    };
    return state;
}

function backupKeys() {
    return [...storage.keys()].filter((key) => key.startsWith(BACKUP_PREFIX)).sort();
}

function readJson(key) {
    return JSON.parse(storage.get(key));
}

async function seedScope() {
    localStorage.setItem('sync_token', 'test-token');
    localStorage.setItem('sync_user_id', USER);
    await articleStore.reloadScope(SCOPE);
    await readingStore.reloadReadingScope(SCOPE);
    const saved = await articleStore.saveArticle({
        articleId: 'backup-article',
        title: 'Backup article',
        article: 'body for backup',
        sourceType: 'paste'
    });
    assert.equal(saved.ok, true, JSON.stringify(saved));
}

function seedExistingBackups() {
    // 兩份既有自動備份（已達保留上限）：失敗的備份不得裁剪或覆蓋它們。
    for (const [id, note] of [[1000, 'auto seed 1'], [2000, 'auto seed 2']]) {
        localStorage.setItem(`${BACKUP_PREFIX}${id}`, JSON.stringify({
            ts: id,
            note,
            payload: { qa: { updatedAt: '2026-01-01T00:00:00.000Z', manifest: [], sets: {} } }
        }));
    }
    localStorage.setItem(INDEX_KEY, JSON.stringify([1000, 2000]));
    localStorage.setItem(META_KEY, JSON.stringify({
        1000: { ts: 1000, note: 'auto seed 1', manual: false },
        2000: { ts: 2000, note: 'auto seed 2', manual: false }
    }));
    localStorage.setItem(SIGNATURE_KEY, SIGNATURE);
}

function snapshotState() {
    return {
        keys: backupKeys(),
        index: localStorage.getItem(INDEX_KEY),
        meta: localStorage.getItem(META_KEY),
        signature: localStorage.getItem(SIGNATURE_KEY)
    };
}

test('文章匯出失敗：不產生備份、不裁剪舊備份、不更新自動備份簽章', async () => {
    await seedScope();
    seedExistingBackups();
    const before = snapshotState();

    const failing = armStoreReadFailure('docs');
    let result;
    try {
        failing.active = true;
        result = await backup.createBackup('auto sync');
    } finally {
        failing.active = false;
        failing.restore();
    }
    assert.equal(failing.hits, 1, '文章匯出失敗注入沒有生效');

    assert.ok(result && result.error, '文章匯出失敗仍回報成功備份');
    assert.match(String(result.error.message), /article_export_failed/);
    assert.equal(result.id, undefined);

    const after = snapshotState();
    assert.deepEqual(after.keys, before.keys, '失敗的備份新增了檔案或刪掉了舊備份');
    assert.equal(after.index, before.index, '失敗的備份裁剪了備份索引');
    assert.equal(after.meta, before.meta, '失敗的備份改寫了備份中繼資料');
    assert.equal(after.signature, SIGNATURE, '失敗的備份更新了自動備份簽章，之後會跳過重建');
    assert.equal(backup.listBackups().length, 2);
});

test('閱讀匯出失敗：同樣不保存、不裁剪、不更新簽章', async () => {
    await seedScope();
    seedExistingBackups();
    const before = snapshotState();

    // readingStore.exportAll() 以 scope 索引讀取 reading_items，失敗會讓整個
    // 匯出交易 abort 並回報 ok:false。
    const failing = armStoreReadFailure('reading_items', { viaIndex: true });
    let result;
    try {
        failing.active = true;
        result = await backup.createBackup('auto sync');
    } finally {
        failing.active = false;
        failing.restore();
    }
    assert.equal(failing.hits, 1, '閱讀匯出失敗注入沒有生效');

    assert.ok(result && result.error, '閱讀匯出失敗仍回報成功備份');
    assert.match(String(result.error.message), /reading_export_failed/);

    const after = snapshotState();
    assert.deepEqual(after.keys, before.keys, '失敗的備份新增了檔案或刪掉了舊備份');
    assert.equal(after.index, before.index, '失敗的備份裁剪了備份索引');
    assert.equal(after.meta, before.meta, '失敗的備份改寫了備份中繼資料');
    assert.equal(after.signature, SIGNATURE, '失敗的備份更新了自動備份簽章');
});

test('匯出恢復正常後：備份建立成功並更新簽章（反向驗證）', async () => {
    await seedScope();
    seedExistingBackups();

    const result = await backup.createBackup('auto sync');
    assert.ok(result && result.id, JSON.stringify(result));
    assert.notEqual(localStorage.getItem(SIGNATURE_KEY), SIGNATURE, '成功備份沒有更新簽章');
    const payload = backup.loadBackupPayload(result.id);
    assert.ok(Array.isArray(payload.articleDocuments), '成功備份缺少文章文件');
    assert.equal(payload.articleDocuments.length, 1);
    assert.equal(payload.articleDocuments[0].body, 'body for backup');
    assert.ok(payload.reading && payload.reading.ok === true);
});
