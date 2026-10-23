// 第十六輪 R1：含已刪除會話／消息的合法備份不得誤報還原失敗。
//
// `restoreAll()` 的核對迴圈原本用 `getMessages()` 比對，但 `getMessages()` 會
// 過濾 `deletedAt`，`exportAll()` 卻保留帶 `deletedAt` 的消息。因此含已刪除
// 會話／消息的備份全部寫入成功，仍會產生 `conversation_messages`／
// `message_mismatch`，`allowPartial:true` 時被 `partial_restore_failed` 判失敗。
//
// 這裡用 fake IndexedDB 播種「已刪除會話 + 已刪除消息」與「會話仍在但單則
// 消息已刪除」兩種合法備份，驗證：
//   1. `exportAll()` 保留刪除標記；
//   2. `restoreAll(payload, {allowPartial:true})` 回 `ok:true` 且 `verifyErrors`
//      為空；
//   3. 還原後的儲存記錄仍保留 `deletedAt`（沒有把 tombstone 復活）；
//   4. 反向驗證：核對邏輯若改回 `getMessages()` 會失敗（見報告）。
//
// Usage: node --test --test-timeout=120000 tests/reading-restore-deleted-records.test.mjs

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

const ENDPOINT = 'https://worker.mock';
const USER = 'restore-deleted-records-user';
const SCOPE = `${ENDPOINT}::${USER}`;
const OTHER_USER = 'restore-deleted-records-other';
const OTHER_SCOPE = `${ENDPOINT}::${OTHER_USER}`;
const ARTICLE_ID = 'deleted-records-article';

async function seedScope() {
    localStorage.setItem('sync_token', 'test-token');
    localStorage.setItem('sync_user_id', USER);
    await articleStore.reloadScope(SCOPE);
    if (!articleStore.getRecord(ARTICLE_ID)) {
        const saved = await articleStore.saveArticle({
            articleId: ARTICLE_ID,
            title: ARTICLE_ID,
            article: `body for ${ARTICLE_ID}`,
            sourceType: 'paste'
        });
        assert.equal(saved.ok, true, JSON.stringify(saved));
    }
    const init = await readingStore.initReadingStore(SCOPE);
    assert.equal(init.ok, true, JSON.stringify(init));
}

async function seedConversationWithMessages() {
    const conv = await readingStore.ensureConversation({ articleId: ARTICLE_ID, title: '含刪除標記的會話' });
    assert.equal(conv.ok, true, JSON.stringify(conv));
    const first = await readingStore.appendMessage({
        conversationId: conv.conversation.id,
        role: 'user',
        content: '第一則問題'
    });
    assert.equal(first.ok, true, JSON.stringify(first));
    const second = await readingStore.appendMessage({
        conversationId: conv.conversation.id,
        role: 'assistant',
        content: '第二則回答'
    });
    assert.equal(second.ok, true, JSON.stringify(second));
    return { conversation: conv.conversation, messages: [first.message, second.message] };
}

async function freshScope() {
    await readingStore.clearScopeForTests();
    await seedScope();
}

/** 直接讀原始 store（含 tombstone），測試端不能依賴會被過濾的 getMessages。 */
async function rawMessages(conversationId) {
    const result = await (await import('../modules/permanent-db.js'))
        .readStoreByIndex('messages', 'scope_conversation', [SCOPE, conversationId]);
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.records;
}

/**
 * 攔住「核對階段」的消息讀取。
 *
 * 寫入階段每寫一則消息前都會先 `getMessages()` 讀一次索引，所以不能看到第一次
 * 讀取就切帳戶。這裡在 `messages` store 累計 `expectPuts` 次 put（＝最後一則
 * 消息寫入）後才接手下一次 index.getAll 的 onsuccess；此時下一次讀取必定是
 * `restoreAll()` 核對迴圈的 `readStoredMessages()`。
 *
 * 被攔住的 request 仍然完成交易（fake IndexedDB 的完成條件與 onsuccess 無關），
 * 測試可在 promise 尚未解析時安全切換 scope，再放行 onsuccess 重現「await 後
 * 帳戶已切換」。
 */
function armVerifyReadHold(expectPuts) {
    const originalIndex = FakeObjectStore.prototype.index;
    const originalPut = FakeObjectStore.prototype.put;
    const state = { armed: false, puts: 0, hits: 0, released: false };
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    let arrived;
    const barrier = new Promise((resolve) => { arrived = resolve; });
    FakeObjectStore.prototype.put = function put(value, key) {
        const request = originalPut.call(this, value, key);
        if (this.name === 'messages' && value && value.id) {
            state.puts += 1;
            if (state.puts >= expectPuts) state.armed = true;
        }
        return request;
    };
    FakeObjectStore.prototype.index = function index(name) {
        const handle = originalIndex.call(this, name);
        if (this.name !== 'messages' || !state.armed) return handle;
        const originalGetAll = handle.getAll;
        return {
            count: handle.count,
            getAll: (value) => {
                const request = originalGetAll.call(handle, value);
                state.hits += 1;
                if (state.hits > 1) return request;
                let handler = null;
                return {
                    get result() { return request.result; },
                    get error() { return request.error; },
                    get onsuccess() { return handler; },
                    set onsuccess(fn) {
                        handler = fn;
                        request.onsuccess = (event) => {
                            arrived();
                            held.then(() => fn && fn(event));
                        };
                    },
                    get onerror() { return request.onerror; },
                    set onerror(fn) { request.onerror = fn; }
                };
            }
        };
    };
    return {
        arrived: barrier,
        hits: () => state.hits,
        release: () => { state.released = true; release(); },
        restore: () => {
            FakeObjectStore.prototype.index = originalIndex;
            FakeObjectStore.prototype.put = originalPut;
        }
    };
}

test('已刪除會話（含已刪除消息）的備份還原回 ok:true 且 verifyErrors 為空', async () => {
    await seedScope();
    await freshScope();
    const { conversation } = await seedConversationWithMessages();
    const deleted = await readingStore.deleteConversation(conversation.id);
    assert.equal(deleted.ok, true, JSON.stringify(deleted));

    const payload = await readingStore.exportAll();
    assert.equal(payload.ok, true, JSON.stringify(payload));
    // 備份必須保留刪除標記，否則後續核對就無從判斷。
    const backupConversation = payload.conversations.find((item) => item.id === conversation.id);
    assert.ok(backupConversation, JSON.stringify(payload.conversations));
    assert.ok(backupConversation.deletedAt, '備份未保留會話刪除標記');
    const backupMessages = payload.messages.filter((item) => item.conversationId === conversation.id);
    assert.equal(backupMessages.length, 2);
    assert.ok(backupMessages.every((item) => item.deletedAt), '備份未保留消息刪除標記');

    await freshScope();
    // 前提：新 scope 沒有任何消息快取，避免舊快取掩蓋問題。
    assert.deepEqual(await readingStore.getMessages(conversation.id), []);

    const result = await readingStore.restoreAll(payload, { allowPartial: true });
    assert.equal(result.ok, true, `含刪除標記的合法備份被誤判失敗：${JSON.stringify(result)}`);
    assert.deepEqual(result.verifyErrors, []);
    assert.equal(result.counts.conversations, 1);
    assert.equal(result.counts.messages, 2);

    // tombstone 不得被復活：一般查詢仍看不到已刪除資料。
    assert.deepEqual(await readingStore.getMessages(conversation.id), []);
    const stored = await rawMessages(conversation.id);
    assert.equal(stored.length, 2);
    assert.ok(stored.every((item) => item.deletedAt), JSON.stringify(stored));
});

test('會話仍在但單則消息已刪除：核對不得回 message_mismatch', async () => {
    await seedScope();
    await freshScope();
    const { conversation, messages } = await seedConversationWithMessages();
    const payload = await readingStore.exportAll();
    assert.equal(payload.ok, true, JSON.stringify(payload));
    // 合法備份可能來自「消息被遠端 tombstone，會話仍在」的裝置；
    // 這裡以備份內容標記單則消息已刪除來重現同一形狀。
    const deletedAt = new Date().toISOString();
    payload.messages = payload.messages.map((item) => (
        item.id === messages[0].id ? { ...item, deletedAt } : item
    ));
    // 讓還原目標只有會話與一則可見消息。
    payload.conversations = payload.conversations.filter((item) => item.id === conversation.id);
    payload.messages = payload.messages.filter((item) => item.conversationId === conversation.id);

    await freshScope();
    const result = await readingStore.restoreAll(payload, { allowPartial: true });
    assert.equal(result.ok, true, `單則已刪除消息令合法備份誤判失敗：${JSON.stringify(result)}`);
    assert.deepEqual(result.verifyErrors, []);

    const visible = await readingStore.getMessages(conversation.id);
    assert.deepEqual(visible.map((item) => item.id), [messages[1].id]);
    const stored = await rawMessages(conversation.id);
    assert.equal(stored.length, 2);
    const deletedRecord = stored.find((item) => item.id === messages[0].id);
    assert.equal(deletedRecord.deletedAt, deletedAt);
});

test('allowPartial:false 對含刪除標記的備份同樣回 ok:true', async () => {
    await seedScope();
    await freshScope();
    const { conversation } = await seedConversationWithMessages();
    assert.equal((await readingStore.deleteConversation(conversation.id)).ok, true);
    const payload = await readingStore.exportAll();
    assert.equal(payload.ok, true);

    await freshScope();
    const result = await readingStore.restoreAll(payload);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.verifyErrors, []);
});

test('核對讀取期間 A→B 切換：restoreAll 回 stale_scope，不得回 ok:true', async () => {
    await seedScope();
    await freshScope();
    const { conversation } = await seedConversationWithMessages();
    const payload = await readingStore.exportAll();
    assert.equal(payload.ok, true, JSON.stringify(payload));
    assert.equal(payload.messages.filter((item) => item.conversationId === conversation.id).length, 2);

    // 還原目標必須是空的 scope：寫入階段每則消息前的 `getMessages()` 都讀不到
    // 資料，才能確定測試攔到的是核對讀取，而不是寫入階段的查詢。
    await freshScope();

    const gate = armVerifyReadHold(2);
    try {
        const pending = readingStore.restoreAll(payload, { allowPartial: true });
        const hit = await Promise.race([gate.arrived.then(() => true), pending.then(() => false)]);
        assert.equal(hit, true, '沒有攔到核對階段的消息讀取，測試前提失效');
        assert.equal(gate.hits(), 1, '核對讀取被攔住的次數不符');
        // 讀取已回來、核對 promise 尚未解析：模擬此刻登入另一個帳戶。
        await articleStore.reloadScope(OTHER_SCOPE);
        await readingStore.reloadReadingScope(OTHER_SCOPE);
        gate.release();
        const result = await pending;
        assert.equal(result.ok, false, `核對期間切換帳戶仍回報成功：${JSON.stringify(result)}`);
        assert.equal(result.error, 'stale_scope', JSON.stringify(result));
    } finally {
        gate.release();
        gate.restore();
        await articleStore.reloadScope(SCOPE);
        await readingStore.reloadReadingScope(SCOPE);
    }
});
