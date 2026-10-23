// 第十五輪缺口 P1：localStorage 後備模式的匯出也不得「假成功」。
//
// `readDocsDetailed()`（文章）與 `exportAll()`（閱讀）原本用寬鬆的後備讀取，
// 讀取例外／JSON 損壞都會被轉成空資料，`exportDocumentsResult()`／`exportAll()`
// 仍回 `ok:true`。備份流程因此會存下一份殘缺備份、裁剪舊備份並更新自動備份
// 簽章，讓可用的舊備份永久消失。
//
// 這裡刻意不提供 IndexedDB（兩個 store 都走 localStorage 後備），驗證：
//   1. 後備桶損壞時 `exportDocumentsResult()`／`exportAll()` 回 `ok:false`；
//   2. `createBackup()` 因此不保存、不裁剪、不更新簽章；
//   3. 桶不存在（null／''）仍是合法空桶；
//   4. 桶恢復正常後備份成功（反向驗證）。
//
// Usage: node --test --test-timeout=120000 tests/local-backup-fallback-export.test.mjs

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
// 沒有 IndexedDB：article-store 與 reading-store 都必須切到 localStorage 後備，
// 才能重現「後備讀取失敗仍回報成功」的假成功。
globalThis.indexedDB = undefined;
globalThis.__BDC_SYNC_ENDPOINT__ = 'https://worker.mock';
globalThis.fetch = async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });

const articleStore = await import('../modules/article-store.js');
const readingStore = await import('../modules/reading-store.js');
const backup = await import('../modules/local-backup.js');

const ENDPOINT = 'https://worker.mock';
const USER = 'backup-fallback-user';
const SCOPE = `${ENDPOINT}::${USER}`;
const ARTICLE_BUCKET_KEY = `bdc:articles:fallback:v1:${SCOPE}`;
const READING_BUCKET_KEY = `bdc:reading:fallback:v1:${SCOPE}`;

const BACKUP_PREFIX = 'bdc:backup:v1:';
const INDEX_KEY = 'bdc:backup:index:v1';
const META_KEY = 'bdc:backup:meta:v1';
const SIGNATURE_KEY = 'bdc:backup:last-auto-signature:v1';
const SIGNATURE = 'signature-before-fallback-failure';

const EMPTY_ARTICLE_BUCKET = JSON.stringify({ docs: [], outbox: [], state: {}, generations: {} });

function backupKeys() {
    return [...storage.keys()].filter((key) => key.startsWith(BACKUP_PREFIX)).sort();
}

async function seedScope() {
    localStorage.setItem('sync_token', 'test-token');
    localStorage.setItem('sync_user_id', USER);
    const articleInit = await articleStore.initArticleStore();
    assert.equal(articleInit.fallbackMode, true, '測試前提：文章 store 必須在後備模式');
    const readingInit = await readingStore.initReadingStore(SCOPE);
    assert.equal(readingInit.fallbackMode, true, '測試前提：閱讀 store 必須在後備模式');
}

function seedExistingBackups() {
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

function prepareHealthyBuckets() {
    localStorage.removeItem(ARTICLE_BUCKET_KEY);
    localStorage.removeItem(READING_BUCKET_KEY);
}

test('桶不存在是合法空桶：文章與閱讀匯出都回 ok:true 的空資料', async () => {
    prepareHealthyBuckets();
    await seedScope();
    prepareHealthyBuckets();

    const articles = await articleStore.exportDocumentsResult();
    assert.equal(articles.ok, true, JSON.stringify(articles));
    assert.deepEqual(articles.documents, []);

    const reading = await readingStore.exportAll();
    assert.equal(reading.ok, true, JSON.stringify(reading));
    assert.deepEqual(reading.learningItems, []);
    assert.deepEqual(reading.messages, []);
});

test('文章後備桶損壞：exportDocumentsResult 回 ok:false，備份不保存、不裁剪、不更新簽章', async () => {
    prepareHealthyBuckets();
    await seedScope();
    seedExistingBackups();
    const before = snapshotState();
    // 無效 JSON：寬鬆的 fallbackRead() 會當成空桶，嚴格讀取必須回報 storage_corrupt。
    localStorage.setItem(ARTICLE_BUCKET_KEY, '{"docs":[');

    const exportResult = await articleStore.exportDocumentsResult();
    assert.equal(exportResult.ok, false, '損壞的後備桶仍回報匯出成功');
    assert.equal(exportResult.error, 'storage_corrupt');

    const result = await backup.createBackup('auto sync');
    assert.ok(result && result.error, '文章後備匯出失敗仍回報成功備份');
    assert.match(String(result.error.message), /article_export_failed:storage_corrupt/);
    assert.equal(result.id, undefined);

    const after = snapshotState();
    assert.deepEqual(after.keys, before.keys, '失敗的備份新增了檔案或刪掉了舊備份');
    assert.equal(after.index, before.index, '失敗的備份裁剪了備份索引');
    assert.equal(after.meta, before.meta, '失敗的備份改寫了備份中繼資料');
    assert.equal(after.signature, SIGNATURE, '失敗的備份更新了自動備份簽章，之後會跳過重建');
    // 損壞的桶沒有被覆寫（否則其他文章與待同步操作會消失）。
    assert.equal(localStorage.getItem(ARTICLE_BUCKET_KEY), '{"docs":[');
});

test('文章後備桶形狀損壞（docs 不是陣列）：同樣不得回報空資料成功', async () => {
    prepareHealthyBuckets();
    await seedScope();
    localStorage.setItem(ARTICLE_BUCKET_KEY, JSON.stringify({ docs: { broken: true }, outbox: [] }));

    const exportResult = await articleStore.exportDocumentsResult();
    assert.equal(exportResult.ok, false, JSON.stringify(exportResult));
    assert.equal(exportResult.error, 'storage_corrupt');
});

test('閱讀後備桶損壞：exportAll 回 ok:false，備份不保存、不裁剪、不更新簽章', async () => {
    prepareHealthyBuckets();
    await seedScope();
    seedExistingBackups();
    const before = snapshotState();
    // 先放一份合法文章桶，確保失敗真的來自閱讀匯出。
    localStorage.setItem(ARTICLE_BUCKET_KEY, EMPTY_ARTICLE_BUCKET);
    localStorage.setItem(READING_BUCKET_KEY, 'not-json');

    const exportResult = await readingStore.exportAll();
    assert.equal(exportResult.ok, false, '損壞的後備桶仍回報匯出成功');
    assert.ok(['storage_corrupt', 'storage_read_failed'].includes(exportResult.error), String(exportResult.error));

    const result = await backup.createBackup('auto sync');
    assert.ok(result && result.error, '閱讀後備匯出失敗仍回報成功備份');
    assert.match(String(result.error.message), /reading_export_failed:storage_corrupt/);

    const after = snapshotState();
    assert.deepEqual(after.keys, before.keys, '失敗的備份新增了檔案或刪掉了舊備份');
    assert.equal(after.index, before.index, '失敗的備份裁剪了備份索引');
    assert.equal(after.meta, before.meta, '失敗的備份改寫了備份中繼資料');
    assert.equal(after.signature, SIGNATURE, '失敗的備份更新了自動備份簽章');
    assert.equal(localStorage.getItem(READING_BUCKET_KEY), 'not-json');
});

test('閱讀後備桶清單欄位損壞（messages 不是陣列）：不得回報空資料成功', async () => {
    prepareHealthyBuckets();
    await seedScope();
    localStorage.setItem(READING_BUCKET_KEY, JSON.stringify({ items: [], messages: { broken: true } }));

    const exportResult = await readingStore.exportAll();
    assert.equal(exportResult.ok, false, JSON.stringify(exportResult));
    assert.equal(exportResult.error, 'storage_corrupt');
});

test('桶恢復正常後：備份建立成功並更新簽章（反向驗證）', async () => {
    prepareHealthyBuckets();
    await seedScope();
    seedExistingBackups();
    localStorage.setItem(ARTICLE_BUCKET_KEY, JSON.stringify({
        docs: [{
            id: 'fallback-article',
            key: `${SCOPE}\u0000fallback-article`,
            scope: SCOPE,
            title: 'Fallback article',
            body: 'body from fallback bucket',
            analysis: null,
            sourceType: 'paste',
            sourceUrl: '',
            revision: 1,
            generation: 0,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            lastOpenedAt: '2026-01-01T00:00:00.000Z',
            deletedAt: ''
        }],
        outbox: [],
        state: {},
        generations: {}
    }));
    localStorage.removeItem(READING_BUCKET_KEY);

    const result = await backup.createBackup('auto sync');
    assert.ok(result && result.id, JSON.stringify(result));
    assert.notEqual(localStorage.getItem(SIGNATURE_KEY), SIGNATURE, '成功備份沒有更新簽章');
    const payload = backup.loadBackupPayload(result.id);
    assert.equal(payload.articleDocuments.length, 1);
    assert.equal(payload.articleDocuments[0].body, 'body from fallback bucket');
    assert.ok(payload.reading && payload.reading.ok === true);
});
