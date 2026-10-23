// 交易語意回歸：fake IndexedDB 必須像真的 IndexedDB 一樣，abort 後不留下
// 任何已發出的寫入；否則「批次寫到一半失敗要整批回滾」的測試會假通過。
//
// Usage: node --test --test-timeout=180000 tests/fake-indexeddb.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeIndexedDB } from './helpers/fake-indexeddb.mjs';

function openDb(indexedDB) {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('tx-semantics', 1);
        request.onupgradeneeded = () => {
            const db = request.result;
            db.createObjectStore('items', { keyPath: 'key' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function run(db, names, mode, work) {
    return new Promise((resolve) => {
        const tx = db.transaction(names, mode);
        const stores = {};
        for (const name of names) stores[name] = tx.objectStore(name);
        let value;
        try {
            value = work(stores, tx);
        } catch (error) {
            try { tx.abort(); } catch (_) {}
            resolve({ aborted: true, error });
            return;
        }
        tx.oncomplete = async () => {
            let resolved = value;
            if (value && typeof value.then === 'function') {
                try { resolved = await value; } catch (_) { resolved = undefined; }
            }
            resolve({ ok: true, value: resolved });
        };
        tx.onabort = () => resolve({ aborted: true, error: tx.error });
        tx.onerror = () => {};
    });
}

function readAll(db, name = 'items') {
    return run(db, [name], 'readonly', (stores) => new Promise((resolve) => {
        const request = stores[name].getAll();
        request.onsuccess = () => resolve(request.result);
    }));
}

test('已寫入的資料在 abort 後不會提交，下一個交易讀不到', async () => {
    const indexedDB = createFakeIndexedDB();
    const db = await openDb(indexedDB);
    await run(db, ['items'], 'readwrite', (stores) => {
        stores.items.put({ key: 'a', value: 1 });
        // 真實 IndexedDB 允許在 request 完成前 abort；寫入必須整個丟棄。
        stores.items.transaction.abort();
    });
    const all = await readAll(db);
    assert.deepEqual(all.value, []);
});

test('後段寫入失敗會中止整個交易，先前成功的寫入一併回滾', async () => {
    const indexedDB = createFakeIndexedDB();
    const db = await openDb(indexedDB);
    await run(db, ['items'], 'readwrite', (stores) => {
        stores.items.put({ key: 'kept', value: 'before' });
    });
    const result = await run(db, ['items'], 'readwrite', (stores) => {
        stores.items.put({ key: 'a', value: 1 });
        stores.items.put({ key: 'b', value: 2 });
        // 第三筆同步失敗（模擬配額／DataClone 之類的錯誤）。
        stores.items.put({ key: 'c', get value() { throw new Error('injected write failure'); } });
    });
    assert.equal(result.aborted, true);
    const all = await readAll(db);
    assert.deepEqual(all.value, [{ key: 'kept', value: 'before' }], '交易失敗卻留下部分寫入');
});

test('交易內的非同步失敗會 abort 並回滾已完成的寫入', async () => {
    const indexedDB = createFakeIndexedDB();
    const db = await openDb(indexedDB);
    const result = await new Promise((resolve) => {
        const tx = db.transaction(['items'], 'readwrite');
        const store = tx.objectStore('items');
        store.put({ key: 'a', value: 1 });
        store.put({ key: 'b', value: 2 });
        // 還有 request 在排隊時從 microtask 主動 abort（等同 run() 的
        // promise 失敗路徑）；整個交易不得留下任何一筆。
        Promise.resolve().then(() => {
            try { tx.abort(); } catch (_) {}
        });
        tx.oncomplete = () => resolve({ ok: true });
        tx.onabort = () => resolve({ aborted: true });
    });
    assert.equal(result.aborted, true);
    assert.deepEqual((await readAll(db)).value, []);
});

test('同一交易內讀得到自己的未提交寫入，其他交易要等提交後才看得到', async () => {
    const indexedDB = createFakeIndexedDB();
    const db = await openDb(indexedDB);
    const order = [];
    const writer = run(db, ['items'], 'readwrite', (stores) => new Promise((resolve) => {
        stores.items.put({ key: 'a', value: 1 });
        const request = stores.items.get('a');
        request.onsuccess = () => {
            order.push(`self:${request.result.value}`);
            resolve();
        };
    }));
    const reader = run(db, ['items'], 'readonly', (stores) => new Promise((resolve) => {
        const request = stores.items.getAll();
        request.onsuccess = () => {
            order.push(`reader:${request.result.length}`);
            resolve();
        };
    }));
    await Promise.all([writer, reader]);
    assert.deepEqual(order, ['self:1', 'reader:1'], '重疊交易沒有依建立順序序列化');
});
