// 快照條件讀取不得被前一帳戶的延遲回應污染。
//
// Usage: node --test --test-timeout=120000 tests/snapshot-session-cache.test.mjs
//
// A 的 /snapshot 尚未完成時切到 B；A 的回應完成後不能以 B 為快取鍵寫入。
// 兩帳戶刻意使用相同 snapshot version，讓「只比版本」的錯誤實作會把 A 的
// payload 當成 B 的快取內容。A→B→A 也必須因 generation 改變而中止。

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
globalThis.__BDC_SYNC_ENDPOINT__ = 'https://worker.mock';

const sync = await import('../modules/sync-cloudflare.js');

const A_PAYLOAD = { marker: 'A', qa: { updatedAt: '2026-01-01T00:00:00.000Z', manifest: [{ id: 'a' }] } };
const B_PAYLOAD = {};
const requests = [];
let hold = null;

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}

function beginHold(account) {
    let release;
    const promise = new Promise((resolve) => { release = resolve; });
    const entry = { account, promise, started: false };
    hold = entry;
    return {
        get started() { return entry.started; },
        release: () => {
            if (hold === entry) hold = null;
            release();
        }
    };
}

async function waitUntil(fn, timeoutMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (fn()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('waitUntil timeout');
}

globalThis.fetch = async (input, init = {}) => {
    const raw = typeof input === 'string' ? input : input.url;
    const url = new URL(raw);
    const method = init.method || 'GET';
    const auth = (init.headers && init.headers.Authorization) || '';
    const token = auth.replace(/^Bearer\s+/i, '');
    const account = token === 'token-A' ? 'A' : token === 'token-B' ? 'B' : '';
    requests.push({ path: url.pathname + url.search, method, token });
    if (url.pathname !== '/snapshot') return jsonResponse({}, 404);
    const current = hold;
    if (current && current.account === account) {
        current.started = true;
        await current.promise;
    }
    if (url.searchParams.get('version') !== null) {
        return jsonResponse({ version: 5, updated_at: '2026-01-02T00:00:00.000Z', notModified: true });
    }
    return jsonResponse({
        version: 5,
        updated_at: '2026-01-02T00:00:00.000Z',
        payload: account === 'A' ? A_PAYLOAD : B_PAYLOAD
    });
};

function switchSession(token, userId) {
    localStorage.setItem('sync_token', token);
    localStorage.setItem('sync_user_id', userId);
    window.dispatchEvent({ type: 'storage', key: 'sync_token' });
}

test('A→B: 遲到的 A 回應不得回填 B 的快取', async () => {
    sync.resetSnapshotCache();
    requests.length = 0;
    switchSession('token-A', 'A');
    const held = beginHold('A');
    const pending = sync.pullSnapshot();
    await waitUntil(() => held.started);
    switchSession('token-B', 'B');
    held.release();
    await assert.rejects(pending, (error) => error && error.code === 'stale_session');

    requests.length = 0;
    const first = await sync.pullSnapshot();
    assert.deepEqual(first.payload, B_PAYLOAD, 'B 取得 A 的 payload');
    assert.equal(first.notModified, false);
    assert.equal(requests[0].path, '/snapshot', 'B 不應使用 A 的版本做條件讀取');

    const second = await sync.pullSnapshot();
    assert.deepEqual(second.payload, B_PAYLOAD, 'B 的快取被 A 的 payload 污染');
    assert.equal(second.notModified, true);
    assert.match(requests[1].path, /^\/snapshot\?version=5$/);

    // 真正走一次 B 的同步：本機與遠端相同時不得上傳任何內容。
    const applied = [];
    const info = await sync.syncNow(
        async () => ({ payload: B_PAYLOAD, updatedAt: '2026-01-02T00:00:00.000Z' }),
        async (snapshot) => { applied.push(snapshot.payload); }
    );
    assert.equal(info.version, 5);
    assert.equal(applied.length, 0);
    assert.equal(requests.filter((item) => item.method === 'POST').length, 0, 'B 上傳了不屬於自己的 payload');
});

test('A→B→A: generation 改變後仍不得接受舊 A 回應或舊快取', async () => {
    sync.resetSnapshotCache();
    requests.length = 0;
    switchSession('token-A', 'A');
    const held = beginHold('A');
    const pending = sync.pullSnapshot();
    await waitUntil(() => held.started);
    switchSession('token-B', 'B');
    switchSession('token-A', 'A');
    held.release();
    await assert.rejects(pending, (error) => error && error.code === 'stale_session');

    requests.length = 0;
    const first = await sync.pullSnapshot();
    assert.deepEqual(first.payload, A_PAYLOAD, '回到 A 後拿到錯誤的 payload');
    assert.equal(first.notModified, false);
    assert.equal(requests[0].path, '/snapshot', 'A→B→A 後不應沿用舊 generation 的快取');

    const second = await sync.pullSnapshot();
    assert.deepEqual(second.payload, A_PAYLOAD);
    assert.equal(second.notModified, true);
    assert.match(requests[1].path, /^\/snapshot\?version=5$/);
    assert.equal(requests.filter((item) => item.method === 'POST').length, 0);
});
