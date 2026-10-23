// P3-T2 可重建快取治理：TTL 過期要同時離開 IDB 與 localStorage；
// prune 只能碰 `bdc:cache:v1:`，不得刪文章、閱讀或任何永久資料。
//
// Usage: node --test tests/cache-governance.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeIndexedDB } from './helpers/fake-indexeddb.mjs';

class MemoryStorage {
    constructor() {
        Object.defineProperty(this, '_data', { value: new Map(), enumerable: false });
    }
    getItem(key) {
        return this._data.has(key) ? this._data.get(key) : null;
    }
    setItem(key, value) {
        const text = String(value);
        this._data.set(key, text);
        // cache.js 以 Object.keys(localStorage) 掃描前綴，資料鍵必須可列舉。
        this[key] = text;
    }
    removeItem(key) {
        this._data.delete(key);
        delete this[key];
    }
    clear() {
        for (const key of [...this._data.keys()]) this.removeItem(key);
    }
}

globalThis.localStorage = new MemoryStorage();
globalThis.indexedDB = createFakeIndexedDB();
if (!globalThis.crypto) globalThis.crypto = globalThis.nodeCrypto;

const cache = await import('../modules/cache.js');

const PREFIX = 'bdc:cache:v1:';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function openCacheDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('bdc-cache', 1);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'key' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function idbGetRaw(key) {
    return openCacheDb().then((db) => new Promise((resolve, reject) => {
        const request = db.transaction('kv', 'readonly').objectStore('kv').get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    }));
}

function idbPutRaw(record) {
    return openCacheDb().then((db) => new Promise((resolve, reject) => {
        const request = db.transaction('kv', 'readwrite').objectStore('kv').put(record);
        request.onsuccess = () => resolve(true);
        request.onerror = () => reject(request.error);
    }));
}

function reset() {
    localStorage.clear();
    return cache.clearRebuildable();
}

test('TTL 過期：getItem 回 null，且 IDB 與 localStorage 都不再留下該 key', async () => {
    await reset();
    const key = PREFIX + 'ttl-short';
    await cache.setItem(key, { text: 'short' }, 20);
    assert.ok(await idbGetRaw(key), '寫入後 IDB 應有記錄');
    await sleep(40);
    assert.equal(await cache.getItem(key), null);
    assert.ok(!(await idbGetRaw(key)), '過期項目必須同時從 IDB 刪除');
    assert.equal(localStorage.getItem(key), null, '過期項目必須同時從 localStorage 刪除');
});

test('prune 只清前綴：文章與閱讀等永久資料不動，過期項目被移除', async () => {
    await reset();
    await idbPutRaw({ key: 'bdc-articles:permanent', value: { body: 'keep' }, expiresAt: 0 });
    await idbPutRaw({ key: 'bdc-reading:permanent', value: { note: 'keep' }, expiresAt: 0 });
    localStorage.setItem('bdc-articles', JSON.stringify([{ id: 'keep' }]));
    localStorage.setItem('bdc-reading', JSON.stringify([{ id: 'keep' }]));

    await cache.setItem(PREFIX + 'fresh', { ok: 1 });
    await cache.setItem(PREFIX + 'expired', { ok: 2 }, 10);
    await sleep(30);

    const result = await cache.pruneCache();
    assert.equal(result.ok, true);
    assert.ok(result.removed >= 1);
    assert.ok(!(await idbGetRaw(PREFIX + 'expired')));
    assert.ok(await idbGetRaw(PREFIX + 'fresh'), '未過期且未超限的項目應保留');
    assert.ok(await idbGetRaw('bdc-articles:permanent'));
    assert.ok(await idbGetRaw('bdc-reading:permanent'));
    assert.equal(localStorage.getItem('bdc-articles'), JSON.stringify([{ id: 'keep' }]));
    assert.equal(localStorage.getItem('bdc-reading'), JSON.stringify([{ id: 'keep' }]));
});

test('同一 key 的舊 local 過期副本不得把 IDB 新副本一起判成過期', async () => {
    await reset();
    const key = PREFIX + 'mixed-layers';
    await cache.setItem(key, { fresh: true });
    // 模擬舊版只寫 localStorage 的過期副本；IDB 才是目前有效資料。
    localStorage.setItem(key, JSON.stringify({
        v: 1,
        storedAt: 1,
        expiresAt: Date.now() - 60_000,
        value: { stale: true }
    }));
    const result = await cache.pruneCache({ maxAgeMs: 0, maxEntries: 100 });
    assert.equal(result.removed, 0);
    assert.ok(await idbGetRaw(key), 'IDB 的無期限新副本必須保留');
});

test('maxEntries：超限時移除最舊項目，且回傳實際移除數', async () => {
    await reset();
    for (let index = 0; index < 5; index += 1) {
        await cache.setItem(PREFIX + 'entry-' + index, { index });
        await sleep(2);
    }
    const result = await cache.pruneCache({ maxEntries: 2, maxBytes: 1024 * 1024, maxAgeMs: 0 });
    assert.equal(result.kept, 2);
    assert.equal(result.removed, 3);
    assert.ok(!(await idbGetRaw(PREFIX + 'entry-0')));
    assert.ok(!(await idbGetRaw(PREFIX + 'entry-1')));
    assert.ok(!(await idbGetRaw(PREFIX + 'entry-2')));
    assert.ok(await idbGetRaw(PREFIX + 'entry-3'));
    assert.ok(await idbGetRaw(PREFIX + 'entry-4'));
});

test('maxBytes：總量超限時由最舊開始移除，至少保留一筆', async () => {
    await reset();
    const big = 'x'.repeat(2048);
    for (let index = 0; index < 4; index += 1) {
        await cache.setItem(PREFIX + 'big-' + index, { big });
        await sleep(2);
    }
    const result = await cache.pruneCache({ maxEntries: 100, maxBytes: 4096, maxAgeMs: 0 });
    assert.ok(result.kept >= 1);
    assert.ok(result.removed >= 1);
    const remaining = [];
    for (let index = 0; index < 4; index += 1) {
        if (await idbGetRaw(PREFIX + 'big-' + index)) remaining.push(index);
    }
    assert.equal(remaining.length, result.kept);
    assert.ok(remaining.includes(3), '最新項目應保留');
});

test('pruneCacheIfDue：24 小時內跳過，超過後執行並更新 lastPrune', async () => {
    await reset();
    const first = await cache.pruneCacheIfDue({ nowMs: 1_000_000 });
    assert.equal(first.skipped, false);
    assert.equal(localStorage.getItem('bdc:cache:lastPrune'), '1000000');

    const second = await cache.pruneCacheIfDue({ nowMs: 1_000_000 + 60_000 });
    assert.equal(second.skipped, true);
    assert.equal(second.removed, 0);

    const third = await cache.pruneCacheIfDue({
        nowMs: 1_000_000 + cache.CACHE_PRUNE_INTERVAL_MS + 1
    });
    assert.equal(third.skipped, false);
    assert.equal(localStorage.getItem('bdc:cache:lastPrune'), String(1_000_000 + cache.CACHE_PRUNE_INTERVAL_MS + 1));
});

test('IDB 刪除失敗：prune 不得謊報 removed，也不得更新 lastPrune', async () => {
    await reset();
    localStorage.removeItem('bdc:cache:lastPrune');
    const restores = globalThis.indexedDB;
    const stuckKey = PREFIX + 'stuck';
    // 最小 IDB 替身：scan 走 getAll（沒有 openCursor），readwrite 交易必定 abort。
    const failingDb = {
        objectStoreNames: { contains: () => true },
        createObjectStore: () => {},
        transaction: () => {
            const tx = { oncomplete: null, onerror: null, onabort: null, error: new Error('aborted') };
            const store = {
                getAll: () => {
                    const request = { result: [{ key: stuckKey, expiresAt: 0, storedAt: 1, value: {} }], onsuccess: null, onerror: null };
                    queueMicrotask(() => request.onsuccess?.());
                    return request;
                },
                delete: () => { queueMicrotask(() => tx.onabort?.()); }
            };
            tx.objectStore = () => store;
            return tx;
        },
        close: () => {}
    };
    globalThis.indexedDB = {
        open: () => {
            const request = { result: failingDb, onsuccess: null, onerror: null, onupgradeneeded: null };
            queueMicrotask(() => request.onsuccess?.());
            return request;
        }
    };
    try {
        // 以 query 建立獨立模組實例，避免共用上一個成功開啟的 DB 連線。
        const failingCache = await import('../modules/cache.js?failing-delete=1');
        const result = await failingCache.pruneCache({ maxEntries: 0, maxBytes: 1024, maxAgeMs: 0 });
        assert.equal(result.ok, false);
        assert.equal(result.removed, 0);
        assert.ok(result.pendingRemoval >= 1);
        const due = await failingCache.pruneCacheIfDue({ nowMs: 2_000_000 });
        assert.equal(due.ok, false);
        assert.equal(localStorage.getItem('bdc:cache:lastPrune'), null, '刪除失敗不得寫入 lastPrune');
    } finally {
        globalThis.indexedDB = restores;
    }
});

test('clearRebuildable 只清快取前綴，永久資料保留', async () => {
    await reset();
    await cache.setItem(PREFIX + 'clear-me', { ok: true });
    await idbPutRaw({ key: 'bdc-articles:permanent', value: { body: 'keep' }, expiresAt: 0 });
    await cache.clearRebuildable();
    assert.equal(await cache.getItem(PREFIX + 'clear-me'), null);
    assert.ok(await idbGetRaw('bdc-articles:permanent'));
});
