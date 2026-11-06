// DeepSeek 獨立補測：shared/capture-client.mjs（擴充套件與主站共用的收藏 outbox）。
//
// 關注的不是「有沒有呼叫 API」，而是下列不可回退的性質：
//   1. 保存先於網路：沒有耐久保存就不得送出；送出的內容必須與保存的內容一致
//   2. 重開（新 client、同 storage）後仍能重試，且重播只會得到同一筆回執
//   3. 取消只影響目標操作，且不會誤刪其他 scope
//   4. 遲到回應（帳戶已切換、401 遲到、回執不合法）不得誤報成功或清掉別人的待傳
//   5. 單筆損壞資料不得被當成「沒有待傳」而靜默丟棄

import test from 'node:test';
import assert from 'node:assert/strict';
import { createCaptureClient, captureScopeKey } from '../shared/capture-client.mjs';

const input = {
    bookId: 'book', word: 'plunge', meaning: '暴跌',
    source: { sourceUrl: 'https://news.example/a', sentence: 'Stocks plunge.', anchor: { start: 1, end: 7, quote: 'plunge' } }
};
const base = { loggedIn: true, endpoint: 'https://sync.example', userId: 'alice', token: 'tok-alice-1', generation: 1 };

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

function harness({ response, delaySet = false } = {}) {
    let session = { ...base };
    let counter = 0;
    const values = {};
    const requests = [];
    const state = {
        values, requests,
        setGate: delaySet ? deferred() : null,
        setCalls: 0,
        respond: response || null,
        responseGate: null,
        failure: null,
        unauthorized: 0,
        calls: []
    };
    state.storage = {
        async get(key) {
            state.calls.push(['get', key]);
            if (key === null) return structuredClone(values);
            return key in values ? structuredClone({ [key]: values[key] }) : {};
        },
        async set(items) {
            state.calls.push(['set', Object.keys(items)]);
            state.setCalls += 1;
            if (state.setGate) await state.setGate.promise;
            Object.assign(values, structuredClone(items));
        },
        async remove(key) {
            state.calls.push(['remove', key]);
            delete values[key];
        }
    };
    state.setSession = (next) => { session = next ? { ...next } : null; };
    state.current = () => ({ ...session });
    state.client = () => createCaptureClient({
        storage: state.storage,
        getSession: () => (session ? { ...session } : { loggedIn: false }),
        isSessionCurrent: (captured) => !!session && JSON.stringify(captured) === JSON.stringify(session),
        randomUUID: () => `req-${++counter}`,
        onUnauthorized: () => { state.unauthorized += 1; },
        request: async (captured, path, options) => {
            const payload = options.body ? JSON.parse(options.body) : null;
            requests.push({ endpoint: captured.endpoint, userId: captured.userId, path, payload });
            if (state.failure) throw state.failure;
            if (state.responseGate) return state.responseGate.promise;
            return state.respond
                ? state.respond(path, payload)
                : Response.json(path === '/vocabulary/books'
                    ? { books: [{ id: 'book', name: 'Book' }], defaultBookId: 'book' }
                    : { ok: true, requestId: payload.requestId, bookId: payload.bookId, entryId: 'entry-1', revision: 1 });
        }
    });
    state.outbox = () => Object.entries(values)
        .filter(([key]) => key.startsWith('bdc_capture_outbox_v1:'))
        .map(([key, record]) => ({ key, ...record }));
    return state;
}

// ── 1. 保存先於網路 ─────────────────────────────────────────────────────────

test('耐久保存完成前不得送出；送出內容必須與保存內容逐欄一致', async (t) => {
    const state = harness({ delaySet: true });
    const client = state.client();
    const pendingEnqueue = client.enqueue(input);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(state.requests.length, 0, 'storage.set 尚未完成就送出收藏');
    state.setGate.resolve();
    const operation = await pendingEnqueue;
    assert.equal(state.requests.length, 0, 'enqueue 本身不該送出');
    const stored = state.values[operation.key];
    assert.deepEqual(stored.payload, operation.payload);
    assert.equal(stored.payload.requestId, operation.payload.requestId);
    assert.ok(!JSON.stringify(state.values).includes(base.token), 'outbox 不得保存帳戶 token');
    const receipt = await client.send(operation);
    assert.equal(state.requests.length, 1);
    assert.deepEqual(state.requests[0].payload, stored.payload, '送出的 payload 必須就是已保存的那份');
    assert.equal(receipt.entryId, 'entry-1');
    assert.deepEqual(state.outbox(), [], '成功後才移除待傳');
});

test('storage.set 失敗：不送、不留待傳、不誤報成功', async (t) => {
    const state = harness();
    state.storage.set = async () => { throw new Error('quota'); };
    const client = state.client();
    await assert.rejects(client.enqueue(input), { code: 'capture_storage_failed' });
    assert.equal(state.requests.length, 0);
    assert.deepEqual(state.outbox(), []);
});

test('送出前若待傳被外部改寫（指紋不符）就不得送出', async (t) => {
    const state = harness();
    const client = state.client();
    const operation = await client.enqueue(input);
    state.values[operation.key].payload.meaning = '被別人改過';
    await assert.rejects(client.send(operation), { code: 'capture_storage_failed' });
    assert.equal(state.requests.length, 0);
    assert.equal(state.outbox().length, 1, '不得因此丟掉待傳');
});

test('送出前若待傳已被移除（例如另一分頁送出並清掉）就不得再送一次', async (t) => {
    const state = harness();
    const client = state.client();
    const operation = await client.enqueue(input);
    delete state.values[operation.key];
    await assert.rejects(client.send(operation), { code: 'capture_storage_failed' });
    assert.equal(state.requests.length, 0);
});

// ── 2. 重開後重試與重播 ─────────────────────────────────────────────────────

test('重開（新 client 同 storage）後重試：沿用原 requestId，成功後清空待傳', async (t) => {
    const state = harness();
    const first = state.client();
    const operation = await first.enqueue(input);
    state.failure = new TypeError('offline');
    await assert.rejects(first.send(operation));
    assert.equal(state.outbox().length, 1, '斷線必須保留待傳');

    const reopened = state.client();
    state.failure = null;
    const results = await reopened.retry();
    assert.equal(results.length, 1);
    assert.equal(results[0].error, undefined);
    assert.equal(state.requests.at(-1).payload.requestId, operation.payload.requestId, '重試必須沿用原 requestId');
    assert.deepEqual(state.outbox(), []);
});

test('兩個面板同時重試同一筆：兩次請求、同一回執，詞書只會有一筆', async (t) => {
    const state = harness();
    const operation = await state.client().enqueue(input);
    const [a, b] = await Promise.all([state.client().retry(), state.client().retry()]);
    assert.equal(state.requests.length, 2, '不同 client 各自送出，但 requestId 相同');
    assert.equal(new Set(state.requests.map((r) => r.payload.requestId)).size, 1);
    assert.equal(a[0].receipt.entryId, b[0].receipt.entryId);
    assert.deepEqual(state.outbox(), []);
});

test('同一 client 併發送出同一筆只會發一次請求', async (t) => {
    const state = harness();
    const client = state.client();
    const operation = await client.enqueue(input);
    const [a, b] = await Promise.all([client.send(operation), client.send(operation)]);
    assert.equal(state.requests.length, 1);
    assert.deepEqual(a, b);
});

test('重試順序按建立時間；遇到傳輸錯誤立刻停止，遇到業務錯誤繼續下一筆', async (t) => {
    const state = harness();
    const client = state.client();
    const firstOp = await client.enqueue({ ...input, word: 'alpha' });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const secondOp = await client.enqueue({ ...input, word: 'bravo' });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const thirdOp = await client.enqueue({ ...input, word: 'charlie' });
    state.respond = (path, payload) => payload.word === 'alpha'
        ? Response.json({ code: 'capture_sources_full', error: 'capture_sources_full' }, { status: 422 })
        : Response.json({ ok: true, requestId: payload.requestId, bookId: payload.bookId, entryId: `entry-${payload.word}`, revision: 1 });
    const results = await client.retry();
    assert.deepEqual(results.map((r) => r.operation.payload.word), ['alpha', 'bravo', 'charlie'], '業務錯誤不得中斷整批');
    assert.equal(results[0].error, 'capture_sources_full');
    assert.deepEqual(state.outbox().map((r) => r.payload.word), ['alpha'], '成功的不再待傳，失敗的保留');

    state.respond = null;
    state.failure = new TypeError('offline');
    const after = await state.client().retry();
    assert.equal(after.length, 1, '傳輸錯誤後停止，不再嘗試後續項目');
    assert.equal(after[0].error, 'capture_pending', '沒有 HTTP status 的失敗以 capture_pending 回報');
    assert.equal(state.outbox().length, 1, '傳輸錯誤後保留');
    assert.ok(firstOp.key && secondOp.key && thirdOp.key);
});

// ── 3. 取消 ────────────────────────────────────────────────────────────────

test('取消只移除指定操作，其他待傳與其他帳戶都不受影響', async (t) => {
    const state = harness();
    const client = state.client();
    const keep = await client.enqueue({ ...input, word: 'alpha' });
    const drop = await client.enqueue({ ...input, word: 'bravo' });
    state.setSession({ ...base, userId: 'bob', token: 'tok-bob', generation: 2 });
    const bobOp = await state.client().enqueue({ ...input, word: 'charlie' });
    state.setSession(base);
    await client.cancel(drop);
    assert.deepEqual(state.outbox().map((r) => r.payload.word).sort(), ['alpha', 'charlie']);
    assert.ok(state.values[keep.key]);
    assert.ok(state.values[bobOp.key], '取消 A 的操作不得動到 B 的待傳');
});

test('取消他帳戶／已被換 scope 的操作會被拒絕且不刪除任何資料', async (t) => {
    const state = harness();
    const operation = await state.client().enqueue(input);
    state.setSession({ ...base, userId: 'bob', token: 'tok-bob', generation: 2 });
    await assert.rejects(state.client().cancel(operation), { code: 'stale_session' });
    assert.equal(state.outbox().length, 1, '不得因為 stale 就刪掉別人的待傳');
    state.setSession(base);
    assert.equal((await state.client().pending()).length, 1);
});

test('取消後再重試不得把已取消的操作送出', async (t) => {
    const state = harness();
    const client = state.client();
    const operation = await client.enqueue(input);
    await client.cancel(operation);
    const results = await client.retry();
    assert.deepEqual(results, []);
    assert.equal(state.requests.length, 0);
    assert.equal((await client.pending()).length, 0);
});

// ── 4. 遲到回應 ────────────────────────────────────────────────────────────

test('送出途中換帳戶：遲到的成功回執只結束原帳戶的待傳，不動新帳戶', async (t) => {
    const state = harness();
    const client = state.client();
    const aliceOp = await client.enqueue(input);
    state.setSession({ ...base, userId: 'bob', token: 'tok-bob', generation: 2 });
    const bobOp = await state.client().enqueue({ ...input, word: 'rise' });
    state.setSession(base);
    state.responseGate = deferred();
    const sending = client.send(aliceOp);
    await new Promise((resolve) => setTimeout(resolve, 2));
    state.setSession({ ...base, userId: 'bob', token: 'tok-bob', generation: 2 });
    state.responseGate.resolve(Response.json({ ok: true, requestId: aliceOp.payload.requestId, bookId: 'book', entryId: 'entry-a', revision: 1 }));
    const receipt = await sending;
    assert.equal(receipt.entryId, 'entry-a');
    assert.ok(state.values[bobOp.key], '不得動到新帳戶的待傳');
    assert.equal(state.values[aliceOp.key], undefined, '原帳戶的待傳應結束');
    const bobPending = await state.client().pending();
    assert.deepEqual(bobPending.map((r) => r.payload.requestId), [bobOp.payload.requestId]);
});

test('舊帳戶遲到的 401 不得登出新帳戶', async (t) => {
    const state = harness();
    const client = state.client();
    const operation = await client.enqueue(input);
    state.responseGate = deferred();
    const sending = client.send(operation);
    await new Promise((resolve) => setTimeout(resolve, 2));
    state.setSession({ ...base, userId: 'bob', token: 'tok-bob', generation: 2 });
    state.responseGate.resolve(Response.json({ code: 'unauthorized', error: 'unauthorized' }, { status: 401 }));
    await assert.rejects(sending);
    assert.equal(state.unauthorized, 0, '遲到的 401 只能影響發出它的 session');
    assert.equal(state.outbox().length, 1, '待傳不得因為 401 消失');
});

test('目前帳戶的 401 只通知失效，不把待傳當成功', async (t) => {
    const state = harness();
    const client = state.client();
    await client.enqueue(input);
    state.respond = () => Response.json({ code: 'unauthorized' }, { status: 401 });
    const results = await client.retry();
    assert.equal(results[0].status, 401);
    assert.equal(state.unauthorized, 1);
    assert.equal(state.outbox().length, 1);
});

test('不合法回執（ok 非 true／revision 0／entryId 不合法／bookId 不符）都不得清掉待傳', async (t) => {
    const bad = [
        { ok: 'true', requestId: 'REQ', bookId: 'book', entryId: 'entry-1', revision: 1 },
        { ok: true, requestId: 'REQ', bookId: 'book', entryId: 'entry-1', revision: 0 },
        { ok: true, requestId: 'REQ', bookId: 'book', entryId: 'bad id!', revision: 2 },
        { ok: true, requestId: 'REQ', bookId: 'other-book', entryId: 'entry-1', revision: 2 },
        { ok: true, requestId: 'REQ', bookId: 'book', entryId: 'entry-1' }
    ];
    for (const payload of bad) {
        const state = harness();
        const client = state.client();
        const operation = await client.enqueue(input);
        state.respond = () => Response.json({ ...payload, requestId: operation.payload.requestId });
        await assert.rejects(client.send(operation), { code: 'capture_invalid_response' }, JSON.stringify(payload));
        assert.equal(state.outbox().length, 1, JSON.stringify(payload));
    }
});

test('後端 404 區分「服務未更新」與「詞書不存在」，兩者都保留待傳', async (t) => {
    const state = harness();
    const client = state.client();
    const operation = await client.enqueue(input);
    state.respond = () => Response.json({ code: 'capture_target_missing' }, { status: 404 });
    const business = await client.retry();
    assert.equal(business[0].error, 'capture_target_missing');
    state.respond = () => Response.json({ code: 'not_found' }, { status: 404 });
    const outdated = await client.retry();
    assert.equal(outdated[0].error, 'capture_server_update_required');
    assert.equal(state.outbox().length, 1);
    assert.ok(state.values[operation.key]);
});

// ── 5. 損壞資料與儲存失敗 ──────────────────────────────────────────────────

test('單筆損壞記錄：要看得見（invalid）且不毒化 outbox：新收藏可排隊、重試跳過它繼續送健康的', async (t) => {
    const state = harness();
    const client = state.client();
    const good = await client.enqueue({ ...input, word: 'alpha' });
    const brokenKey = `bdc_capture_outbox_v1:${captureScopeKey(base)}:req-broken`;
    state.values[brokenKey] = {
        endpoint: base.endpoint, userId: base.userId, createdAt: '2026-11-06T00:00:00.000Z',
        payload: { requestId: 'req-broken', bookId: 'book', word: '', meaning: '' }
    };
    const listed = await client.pending();
    assert.equal(listed.length, 2, '壞記錄必須顯示出來，不可回空陣列假裝沒有待傳');
    const broken = listed.find((record) => record.key === brokenKey);
    assert.equal(broken.invalid, true, '壞記錄要以 invalid 標記，讓 UI 能提供取消');
    assert.equal(broken.payload.requestId, 'req-broken');
    assert.equal(state.requests.length, 0, '讀取待傳不得觸發任何請求');

    const added = await client.enqueue({ ...input, word: 'delta' });
    assert.ok(added.key, '單筆壞記錄不得擋住新的收藏');
    assert.equal((await client.pending()).length, 3);

    const results = await client.retry();
    assert.deepEqual(results.filter((result) => result.receipt).map((result) => result.operation.payload.word).sort(),
        ['alpha', 'delta'], '健康記錄必須照常送出');
    const skipped = results.find((result) => result.error);
    assert.equal(skipped.error, 'capture_invalid_record');
    assert.equal(skipped.status, 422, '壞記錄以 422 回報，屬於業務錯誤，不得中斷後續項目');
    assert.equal(skipped.operation.invalid, true);
    assert.deepEqual((await client.pending()).map((record) => record.key), [brokenKey], '壞記錄留在本機等人工取消');
    assert.equal(state.values[good.key], undefined, '健康記錄送出後才移除');

    await client.cancel((await client.pending())[0]);
    assert.deepEqual(await client.pending(), [], '壞記錄必須能直接被取消');
    assert.equal(state.values[brokenKey], undefined);

    state.setSession({ ...base, userId: 'bob', token: 'tok-bob', generation: 2 });
    assert.deepEqual(await state.client().pending(), [], '其他帳戶本來就不受影響');
});

test('壞記錄若指向別的帳戶（標頭不符）：不得顯示 foreign 字詞，且可直接取消而動不到健康記錄', async (t) => {
    const state = harness();
    const client = state.client();
    const good = await client.enqueue({ ...input, word: 'alpha' });
    const foreignKey = `bdc_capture_outbox_v1:${captureScopeKey(base)}:req-foreign`;
    state.values[foreignKey] = {
        endpoint: 'https://other.example', userId: 'bob', createdAt: '',
        payload: { requestId: 'req-foreign', bookId: 'bob-book', word: 'ForeignWord', meaning: 'ForeignMeaning' }
    };
    const foreign = (await client.pending()).find((record) => record.key === foreignKey);
    assert.equal(foreign.invalid, true);
    assert.equal(foreign.payload.word, '', '不得把別的帳戶的字詞帶到 UI');
    assert.equal(foreign.payload.bookId, '', '不得帶出別的帳戶的詞書 id');
    assert.ok(!JSON.stringify(foreign).includes('Foreign'), '整個 pending 條目都不得含 foreign payload 內容');
    assert.equal(foreign.endpoint, base.endpoint, '顯示用標頭一律是目前的 scope');

    await client.cancel(foreign);
    assert.equal(state.values[foreignKey], undefined, '壞記錄必須能取消');
    assert.ok(state.values[good.key], '取消壞記錄不得波及健康記錄');
    assert.equal((await client.pending()).length, 1);
});

test('取消操作的 key 必須屬於目前 scope：偽造標頭或錯位 key 都不得刪掉別人的待傳', async (t) => {
    const state = harness();
    const client = state.client();
    const aliceOp = await client.enqueue(input);
    state.setSession({ ...base, userId: 'bob', token: 'tok-bob', generation: 2 });
    const bobOp = await state.client().enqueue({ ...input, word: 'rise' });
    state.setSession(base);
    const forged = { ...bobOp, endpoint: base.endpoint, userId: base.userId };
    await assert.rejects(client.cancel(forged), { code: 'stale_session' }, '標頭改成本人也不得刪別人的 key');
    assert.ok(state.values[bobOp.key], '不得靠偽造標頭刪掉別人的待傳');
    const misaligned = { ...aliceOp, key: aliceOp.key.replace(aliceOp.payload.requestId, 'someone-else') };
    await assert.rejects(client.cancel(misaligned), { code: 'stale_session' }, '前綴內但 key 與 requestId 錯位也要拒絕');
    assert.ok(state.values[aliceOp.key]);
    assert.ok(state.values[bobOp.key]);
});

test('storage.get 失敗不得被當成空 outbox，且要回報成儲存失敗而不是 undefined', async (t) => {
    const state = harness();
    const client = state.client();
    await client.enqueue(input);
    state.storage.get = async () => { throw new Error('idb broken'); };
    await assert.rejects(client.pending(), { code: 'capture_storage_failed' }, '讀本機佇列失敗要明確回報，UI 才不會顯示「未能完成操作」');
    await assert.rejects(client.retry(), { code: 'capture_storage_failed' });
    assert.equal(state.requests.length, 0);
});

test('待傳上限 200：滿了要明確拒絕，且不得覆寫既有待傳', async (t) => {
    const state = harness();
    const client = state.client();
    const scope = captureScopeKey(base);
    for (let i = 0; i < 200; i += 1) {
        state.values[`bdc_capture_outbox_v1:${scope}:bulk-${i}`] = {
            endpoint: base.endpoint, userId: base.userId, createdAt: `2026-11-06T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
            payload: { ...input, requestId: `bulk-${i}` }
        };
    }
    const keysBefore = Object.keys(state.values).length;
    await assert.rejects(client.enqueue(input), { code: 'capture_outbox_full' });
    assert.equal(Object.keys(state.values).length, keysBefore, '滿了不得寫入或覆寫');
    assert.equal(state.requests.length, 0);
});

// ── 6. 帳戶／端點隔離與詞書列表 ────────────────────────────────────────────

test('只換 endpoint（同帳號）也要完全隔離，不得互相送出', async (t) => {
    const state = harness();
    const operation = await state.client().enqueue(input);
    state.setSession({ ...base, endpoint: 'https://other.example', generation: 2 });
    assert.deepEqual(await state.client().pending(), []);
    await assert.rejects(state.client().send(operation), { code: 'stale_session' });
    assert.equal(state.requests.length, 0);
    state.setSession({ ...base, endpoint: 'https://other.example/', generation: 2 });
    assert.deepEqual(await state.client().pending(), [], '結尾斜線不得讓不同端點共用同一桶');
});

test('未登入時不讀 storage、不排隊、不送', async (t) => {
    const state = harness();
    state.setSession({ loggedIn: false, endpoint: '', userId: '', token: '', generation: 0 });
    const client = state.client();
    assert.deepEqual(await client.pending(), []);
    await assert.rejects(client.enqueue(input), { code: 'stale_session' });
    assert.equal(state.setCalls, 0);
    assert.equal(state.requests.length, 0);
});

test('詞書列表：過濾不合法 id；伺服器沒有明確合法預設時不得回退第一本', async (t) => {
    const state = harness();
    state.respond = () => Response.json({
        books: [{ id: 'book-2', name: 'B' }, { id: 'bad id', name: 'X' }, { id: 'book-1' }, { name: 'no id' }],
        defaultBookId: 'missing-book'
    });
    const result = await state.client().books();
    assert.deepEqual(result.books, [{ id: 'book-2', name: 'B' }]);
    assert.equal(result.defaultBookId, '', '預設值不在清單內就只能是空的，不可挑第一本頂替');

    state.respond = () => Response.json({ books: [{ id: 'only', name: 'Words' }], defaultBookId: 'only' });
    assert.equal((await state.client().books()).defaultBookId, 'only', '伺服器明確給的合法預設仍要沿用');

    state.respond = () => Response.json({ books: [{ id: 'only', name: 'Words' }] });
    assert.equal((await state.client().books()).defaultBookId, '', '沒有 defaultBookId 欄位時不得自己猜第一本');

    state.respond = () => new Response('not json', { status: 200 });
    await assert.rejects(state.client().books(), { code: 'capture_invalid_response' });
    state.respond = () => Response.json({ books: [] }, { status: 200 });
    assert.deepEqual(await state.client().books(), { books: [], defaultBookId: '' });
});

test('不同帳戶的詞書快取與待傳互不相通', async (t) => {
    const state = harness();
    await state.client().enqueue(input);
    state.setSession({ ...base, userId: 'bob', token: 'tok-bob', generation: 2 });
    assert.deepEqual(await state.client().pending(), []);
    await state.client().enqueue({ ...input, word: 'rise' });
    state.setSession(base);
    const alicePending = await state.client().pending();
    assert.equal(alicePending.length, 1);
    assert.equal(alicePending[0].payload.word, 'plunge');
});
