import test from 'node:test';
import assert from 'node:assert/strict';
import { createCaptureClient } from '../shared/capture-client.mjs';

const input = { bookId: 'book', word: 'plunge', meaning: '暴跌', source: { sourceUrl: 'https://news.example/', sentence: 'Stocks plunge.' } };
const initial = { loggedIn: true, endpoint: 'https://sync.example', userId: 'alice', token: 'private-alice-token', generation: 1 };

function setup() {
    let session = { ...initial };
    let counter = 0;
    const values = {};
    const requests = [];
    const storage = {
        async get(key) { return structuredClone(key === null ? values : { [key]: values[key] }); },
        async set(items) { Object.assign(values, structuredClone(items)); },
        async remove(key) { delete values[key]; }
    };
    const state = {
        values, requests, storage,
        setSession(next) { session = { ...next }; },
        failure: null, response: null, unauthorized: 0
    };
    state.client = () => createCaptureClient({
        storage, getSession: () => ({ ...session }),
        isSessionCurrent: (captured) => JSON.stringify(captured) === JSON.stringify(session),
        randomUUID: () => `request-${++counter}`,
        onUnauthorized: () => { state.unauthorized += 1; },
        request: async (captured, path, options) => {
            if (state.failure) throw state.failure;
            const payload = options.body ? JSON.parse(options.body) : null;
            if (payload) assert.ok(Object.values(values).some((record) => record.payload?.requestId === payload.requestId), 'persist before network');
            requests.push({ endpoint: captured.endpoint, userId: captured.userId, path, payload });
            return state.response || Response.json(path === '/vocabulary/books'
                ? { books: [{ id: 'book', name: 'Book' }], defaultBookId: 'book' }
                : { ok: true, requestId: payload.requestId, bookId: payload.bookId, entryId: 'entry', revision: 1 });
        }
    });
    return state;
}

test('先持久化不可變操作再傳送；儲存中沒有登入 token', async () => {
    const state = setup();
    const client = state.client();
    const operation = await client.enqueue(input);
    assert.equal(state.requests.length, 0);
    assert.ok(!JSON.stringify(state.values).includes(initial.token));
    input.meaning = '修改後';
    assert.equal(operation.payload.meaning, '暴跌');
    const receipt = await client.send(operation);
    assert.equal(receipt.entryId, 'entry');
    assert.equal((await client.pending()).length, 0);
    input.meaning = '暴跌';
});

test('儲存失敗不得傳送或回報已收藏', async () => {
    const state = setup();
    state.storage.set = async () => { throw new Error('quota'); };
    const client = state.client();
    await assert.rejects(client.enqueue(input), { code: 'capture_storage_failed' });
    assert.equal(state.requests.length, 0);
});

test('斷線保留操作；重新建立 client 後用原 requestId 重試', async () => {
    const state = setup();
    const client = state.client();
    const operation = await client.enqueue(input);
    state.failure = new TypeError('offline');
    await assert.rejects(client.send(operation));
    state.failure = null;
    const recovered = state.client();
    const result = await recovered.retry();
    assert.equal(result[0].receipt.requestId, operation.payload.requestId);
    assert.equal((await recovered.pending()).length, 0);
});

test('不同 client 同時加入操作不覆寫彼此', async () => {
    const state = setup();
    await Promise.all([state.client().enqueue(input), state.client().enqueue({ ...input, word: 'rise' })]);
    assert.equal((await state.client().pending()).length, 2);
});

test('帳戶／端點切換隔離待傳，舊操作不得發到新端點', async () => {
    const state = setup();
    const client = state.client();
    const operation = await client.enqueue(input);
    state.setSession({ ...initial, userId: 'bob', token: 'bob-token', endpoint: 'https://other.example', generation: 2 });
    assert.deepEqual(await client.pending(), []);
    await assert.rejects(client.send(operation), { code: 'stale_session' });
    assert.equal(state.requests.length, 0);
    state.setSession(initial);
    assert.equal((await client.pending()).length, 1);
});

test('只有有效且相符的回執可移除待傳', async () => {
    const state = setup();
    const client = state.client();
    const operation = await client.enqueue(input);
    state.response = Response.json({ ok: true, requestId: 'wrong', bookId: 'book', entryId: 'entry', revision: 1 });
    await assert.rejects(client.send(operation), { code: 'capture_invalid_response' });
    assert.equal((await client.pending()).length, 1);
});

test('詞書刪除／超限等業務錯誤仍保留待傳，使用者可明確取消', async () => {
    const state = setup();
    const client = state.client();
    const operation = await client.enqueue(input);
    state.response = Response.json({ code: 'capture_target_missing' }, { status: 404 });
    const results = await client.retry();
    assert.equal(results[0].error, 'capture_target_missing');
    assert.equal((await client.pending()).length, 1);
    await client.cancel(operation);
    assert.equal((await client.pending()).length, 0);
});

test('401 不把待傳當成功，僅通知目前 session 失效', async () => {
    const state = setup();
    const client = state.client();
    await client.enqueue(input);
    state.response = Response.json({ code: 'unauthorized' }, { status: 401 });
    const result = await client.retry();
    assert.equal(result[0].status, 401);
    assert.equal(state.unauthorized, 1);
    assert.equal((await client.pending()).length, 1);
});

test('不支援收藏的舊服務明確回報需要更新', async () => {
    const state = setup();
    state.response = Response.json({ code: 'not_found' }, { status: 404 });
    await assert.rejects(state.client().books(), { code: 'capture_server_update_required' });
});

test('壞記錄保留並可取消，健康記錄與新收藏仍能傳送', async () => {
    const state = setup();
    const client = state.client();
    const good = await client.enqueue(input);
    const badKey = good.key.replace(good.payload.requestId, 'broken');
    state.values[badKey] = { endpoint: initial.endpoint, userId: initial.userId, payload: { requestId: 'broken' } };
    const pending = await client.pending();
    assert.equal(pending.length, 2);
    assert.equal(pending.find((record) => record.key === badKey).invalid, true);
    await client.enqueue({ ...input, word: 'rise' });
    const retried = await client.retry();
    assert.equal(retried.filter((result) => result.receipt).length, 2);
    assert.equal((await client.pending()).length, 1);
    await client.cancel((await client.pending())[0]);
    assert.equal((await client.pending()).length, 0);
});
