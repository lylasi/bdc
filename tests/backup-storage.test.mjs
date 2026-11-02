import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeIndexedDB, FakeObjectStore } from './helpers/fake-indexeddb.mjs';

let run = 0;
async function fixture({ idb = true, quota = Infinity } = {}) {
    const values = new Map();
    globalThis.localStorage = {
        getItem: key => values.get(key) ?? null,
        setItem(key, value) {
            value = String(value);
            const entries = new Map(values).set(key, value);
            const size = [...entries].reduce((sum, [k, v]) => sum + k.length + v.length, 0);
            if (size > quota) throw new DOMException('storage quota exceeded', 'QuotaExceededError');
            values.set(key, value);
        },
        removeItem: key => values.delete(key),
        key: index => [...values.keys()][index] || null,
        get length() { return values.size; }
    };
    globalThis.indexedDB = idb ? createFakeIndexedDB() : undefined;
    const store = await import(`../modules/backup-store.js?test=${++run}`);
    return { store, values };
}

function legacy(id, note = 'manual legacy', content = '筆記'.repeat(100)) {
    const raw = JSON.stringify({ ts: Number(id), note, payload: { reading: { note: content } } });
    localStorage.setItem('bdc:backup:v1:' + id, raw);
    return raw;
}

test('localStorage 已滿仍可搬移舊備份及建立大型備份，保留所有手動備份', async () => {
    const { store, values } = await fixture({ quota: 1800 });
    for (const id of [1000, 2000, 3000]) legacy(id);
    localStorage.setItem('sync_token', 'kept-login');
    localStorage.setItem('pen_global_settings', '{"theme":"teal"}');
    for (let i = 0; ; i += 1) {
        try { localStorage.setItem('padding', 'x'.repeat(i * 10)); } catch (_) { break; }
    }
    assert.throws(() => legacy(4000), { name: 'QuotaExceededError' });
    const saved = await store.saveBackupRecord({ articleDocuments: [{ body: '中文筆記'.repeat(500000) }] }, 'manual new');
    assert.ok(saved.id, String(saved.error));
    assert.equal((await store.listBackupRecords()).length, 4);
    for (const id of [1000, 2000, 3000]) assert.equal((await store.loadBackupRecord(id)).reading.note, '筆記'.repeat(100));
    assert.equal((await store.loadBackupRecord(saved.id)).articleDocuments[0].body.length, 2000000);
    assert.equal([...values.keys()].filter(key => key.startsWith('bdc:backup:v1:')).length, 0);
    assert.equal(localStorage.getItem('sync_token'), 'kept-login');
    assert.equal(localStorage.getItem('pen_global_settings'), '{"theme":"teal"}');
    localStorage.setItem('article-sync-state', 'now enough room');
});

test('搬移寫入失敗保留原件，舊索引遺失的備份也能列出及匯出', async () => {
    const { store } = await fixture();
    const raw = legacy(1000);
    const original = FakeObjectStore.prototype.put;
    FakeObjectStore.prototype.put = function(value, key) {
        if (this.name === 'payloads') throw new Error('injected backup failure');
        return original.call(this, value, key);
    };
    try {
        await store.prepareBackupStorage();
        assert.equal(localStorage.getItem('bdc:backup:v1:1000'), raw);
        assert.equal((await store.listBackupRecords()).length, 1);
        assert.equal((await store.loadBackupRecord('1000')).reading.note, '筆記'.repeat(100));
    } finally { FakeObjectStore.prototype.put = original; }
    await store.prepareBackupStorage();
    assert.equal(localStorage.getItem('bdc:backup:v1:1000'), null);
    assert.equal((await store.listBackupRecords()).length, 1);
});

test('新備份交易失敗不會裁剪舊自動備份，成功後保留兩份自動及全部手動', async () => {
    const { store } = await fixture();
    const manual = await store.saveBackupRecord({ content: 'manual' }, 'manual');
    const a = await store.saveBackupRecord({ content: 'auto a' }, 'auto');
    const b = await store.saveBackupRecord({ content: 'auto b' }, 'auto');
    const original = FakeObjectStore.prototype.put;
    FakeObjectStore.prototype.put = function(value, key) {
        if (this.name === 'metadata' && value.id !== manual.id) throw new Error('injected metadata failure');
        return original.call(this, value, key);
    };
    let failed;
    try { failed = await store.saveBackupRecord({ content: 'auto failed' }, 'auto'); }
    finally { FakeObjectStore.prototype.put = original; }
    assert.ok(failed.error);
    assert.equal((await store.listBackupRecords()).length, 3);
    assert.equal((await store.loadBackupRecord(a.id)).content, 'auto a');
    assert.equal((await store.loadBackupRecord(b.id)).content, 'auto b');
    const c = await store.saveBackupRecord({ content: 'auto c' }, 'auto');
    assert.ok(c.id);
    const kept = await store.listBackupRecords();
    assert.equal(kept.length, 3);
    assert.ok(kept.some(item => item.id === c.id));
    assert.ok(kept.some(item => item.id === manual.id));
    await store.deleteBackupRecord(c.id);
    assert.equal(await store.loadBackupRecord(c.id), null);
});

test('相同 ID 的兩份不同備份不互相覆寫，舊手動旗標保留', async () => {
    const { store } = await fixture();
    const saved = await store.saveBackupRecord({ content: 'new database copy' }, 'manual');
    localStorage.setItem('bdc:backup:v1:' + saved.id, JSON.stringify({ ts: 1, note: 'custom', payload: { content: 'legacy copy' } }));
    localStorage.setItem('bdc:backup:meta:v1', JSON.stringify({ [saved.id]: { manual: true } }));
    await store.prepareBackupStorage();
    const items = await store.listBackupRecords();
    assert.equal(items.length, 2);
    assert.ok(items.every(item => item.manual));
    const copies = await Promise.all(items.map(item => store.loadBackupRecord(item.id)));
    assert.deepEqual(new Set(copies.map(item => item.content)), new Set(['new database copy', 'legacy copy']));
});

test('IndexedDB 不可用且 localStorage 已滿，失敗不刪除既有備份', async () => {
    const { store } = await fixture({ idb: false, quota: 800 });
    const raw = legacy(1000);
    const result = await store.saveBackupRecord({ content: 'x'.repeat(1000) }, 'manual');
    assert.equal(result.error?.name, 'QuotaExceededError');
    assert.equal(localStorage.getItem('bdc:backup:v1:1000'), raw);
    assert.equal((await store.loadBackupRecord('1000')).reading.note, '筆記'.repeat(100));
});
