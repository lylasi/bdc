// DeepSeek 獨立測試：擴充套件 0.3.0「網頁待傳佇列」前端 client
// （shared/workspace-client.mjs，經 modules/extension-workspace.js 接到現有 apiRequest）。
//
// 設計原則：不鏡像實作、不改寫演算法，只注入三種 adapter：
//   1. storage：模擬 chrome.storage.local（JSON 往返、物件鍵重排、可阻塞、可失敗）
//   2. session：模擬 sync-cloudflare 的 captureAuthSession／isAuthSessionCurrent
//      （generation＋token＋userId＋endpoint 四項比對；真實模組會拉入 ai-config.js 等私有設定，
//        依交辦限制不得讀取，因此以同語意的 adapter 取代）
//   3. request：真的送到 cloudflare-worker/src/worker.js（node:sqlite＋selfhost/d1-adapter.js），
//      並像 apiRequest 一樣「以目前設定的 endpoint 發送、token 取自呼叫端捕捉的 session」。
// 因此除了 AI 傳輸外，全部都是產品程式碼：client、Worker 路由、page-links、schema。
//
// 覆蓋範圍（對應交辦清單）：
//   A. 先持久化後發送／Chrome 鍵重排後的 canonical 比較
//   B. 跨帳戶、跨 endpoint 切換（含 storage.get 等待中與 hash 等待中）不得汙染新 endpoint
//   C. 只有有效回執才清 pending；畸形／外帳戶待傳不外洩內容且可單獨取消
//   D. 文章保存後 page-link 失敗可恢復；重送不覆蓋已編輯文章；不重複建立
//   E. 回應遺失（伺服器已套用）後重試的冪等性
//   F. 取消不刪雲端已保存內容；兩 client 併發送同一筆工作只建一次
//
// 本輪（定向複測）改寫的兩項，改為斷言修正後的「健康行為」：
//   C4  本機錯誤（capture_invalid_record／input／response、invalid_article…）跳過該筆並續送後續項目；
//       網路中斷與 401／429／5xx 仍會停止（C4b），避免無謂重試。
//   E3  pending 依 createdAt 排序（同時間以 key 穩定），retry 依同一順序送出。
// 兩者都以「明確不同的 createdAt」建立前提，不依賴同一毫秒內的 UUID 次序。

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';

import worker from '../cloudflare-worker/src/worker.js';
import { createD1Adapter, createSqliteDatabase } from '../selfhost/d1-adapter.js';
import { createWorkspaceClient } from '../shared/workspace-client.mjs';
import { pageStableId } from '../shared/page-protocol.mjs';

const ROOT = new URL('..', import.meta.url);
const SCHEMA = readFileSync(new URL('cloudflare-worker/schema.sql', ROOT), 'utf8');
const ORIGIN = 'chrome-extension://deepseek-workspace';
const ENDPOINT_A = 'https://sync-a.example';
const ENDPOINT_B = 'https://sync-b.example';
const PAGE = 'https://news.example/story/7?edition=hk';
const PAGE_WITH_FRAGMENT = 'https://news.example/story/7?edition=hk#comments';
const OTHER_PAGE = 'https://news.example/story/9';

const tick = () => new Promise((resolve) => { setTimeout(resolve, 0); });
const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex');
let userSeq = 0;

/* ------------------------------------------------------------------ *
 * 後端：真 schema + 真 D1 轉接層 + 真 Worker（每個 endpoint 一套獨立資料庫）
 * ------------------------------------------------------------------ */
function createBackend(endpoint, users) {
    const db = new DatabaseSync(':memory:');
    db.exec(SCHEMA);
    for (const user of users) {
        db.prepare('INSERT INTO users(token_hash,user_id,label,role) VALUES(?,?,?,?)')
            .run(sha256(user.token), user.userId, user.userId, 'user');
    }
    return { endpoint, db, env: { DB: createD1Adapter(createSqliteDatabase(db)), ALLOWED_ORIGINS: ORIGIN } };
}

/* ------------------------------------------------------------------ *
 * storage adapter：模擬 chrome.storage.local
 * - 值以 JSON 往返（和 Chrome 一樣會丟掉 undefined、Date 變字串）
 * - 回傳時物件鍵重排（Chrome 不保證鍵序，這正是先前修正過的 canonical 比較場景）
 * ------------------------------------------------------------------ */
function createStorage(timeline) {
    const data = new Map();
    const log = [];
    const failures = { get: 0, set: 0, remove: 0 };
    let blocked = null;
    const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
    const reorder = (value) => {
        if (Array.isArray(value)) return value.map(reorder);
        if (!value || typeof value !== 'object') return value;
        return Object.fromEntries(Object.keys(value).sort().reverse().map((key) => [key, reorder(value[key])]));
    };
    const gate = async (op) => {
        if (!blocked || blocked.op !== op) return;
        const pending = blocked;
        blocked = null;
        await pending.promise;
    };
    const storage = {
        data,
        log,
        blockNext(op) {
            let release;
            const promise = new Promise((resolve) => { release = resolve; });
            blocked = { op, promise };
            return () => release();
        },
        failNext(op) { failures[op] = (failures[op] || 0) + 1; },
        async get(keys) {
            log.push({ op: 'get', keys });
            timeline.push({ kind: 'storage', op: 'get' });
            await gate('get');
            if (failures.get) { failures.get -= 1; throw new Error('storage get failed'); }
            const all = {};
            for (const key of [...data.keys()].reverse()) all[key] = clone(data.get(key));
            if (keys === null || keys === undefined) return all;
            const wanted = Array.isArray(keys) ? keys : [keys];
            const picked = {};
            for (const key of wanted) if (data.has(key)) picked[key] = clone(data.get(key));
            return picked;
        },
        async set(items) {
            log.push({ op: 'set', keys: Object.keys(items), items: clone(items) });
            timeline.push({ kind: 'storage', op: 'set', keys: Object.keys(items) });
            await gate('set');
            if (failures.set) { failures.set -= 1; throw new Error('storage set failed'); }
            for (const [key, value] of Object.entries(items)) data.set(key, reorder(clone(value)));
        },
        async remove(keys) {
            const wanted = Array.isArray(keys) ? keys : [keys];
            log.push({ op: 'remove', keys: wanted });
            timeline.push({ kind: 'storage', op: 'remove', keys: wanted });
            await gate('remove');
            if (failures.remove) { failures.remove -= 1; throw new Error('storage remove failed'); }
            for (const key of wanted) data.delete(key);
        }
    };
    return storage;
}

/* ------------------------------------------------------------------ *
 * session adapter：同 sync-cloudflare 的 captureAuthSession／isAuthSessionCurrent 語意
 * ------------------------------------------------------------------ */
function createSessionState({ endpoint, userId, token }) {
    let current = { endpoint, userId, token, generation: 1, loggedIn: true };
    return {
        get: () => ({ ...current }),
        isCurrent(session) {
            return !!session && session.generation === current.generation && session.token === current.token
                && session.userId === current.userId && session.endpoint === current.endpoint;
        },
        currentEndpoint: () => current.endpoint,
        switchTo({ endpoint: nextEndpoint = current.endpoint, userId: nextUserId, token: nextToken }) {
            current = { endpoint: nextEndpoint, userId: nextUserId, token: nextToken, generation: current.generation + 1, loggedIn: true };
            return { ...current };
        },
        logout() {
            current = { ...current, userId: '', token: '', generation: current.generation + 1, loggedIn: false };
            return { ...current };
        }
    };
}

/* ------------------------------------------------------------------ *
 * transport adapter：真的走 worker.fetch；endpoint 取「目前設定」，token 取「呼叫端捕捉的 session」
 * hooks.plan(entry) 可模擬「伺服器已套用但回應遺失」與「伺服器回畸形回執」
 * hooks.afterResponse(entry, response) 可在回應交回 client 前插入時序（用於 hash 等待中切換）
 * ------------------------------------------------------------------ */
function createTransport({ backends, sessions, calls, timeline, hooks }) {
    return async (session, path, options = {}) => {
        const endpoint = sessions.currentEndpoint();
        const method = options.method || 'GET';
        const entry = { endpoint, token: session.token || '', userId: session.userId || '', path, method, body: options.body || '' };
        calls.push(entry);
        timeline.push({ kind: 'request', method, path, endpoint, token: entry.token });
        const backend = backends[endpoint];
        const plan = hooks.plan ? hooks.plan(entry) : null;
        const send = async () => {
            if (!backend) {
                return new Response(JSON.stringify({ code: 'endpoint_unreachable' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
            }
            const headers = { Origin: ORIGIN, 'Content-Type': 'application/json' };
            if (session.token) headers.Authorization = 'Bearer ' + session.token;
            return worker.fetch(new Request(endpoint + path, { method, headers, ...(options.body ? { body: options.body } : {}) }), backend.env);
        };
        if (plan?.kind === 'lose') {
            // 伺服器照常套用，但 client 只看到網路失敗（真正的「回應遺失」）。
            await send();
            throw Object.assign(new Error('sync unreachable'), { code: 'sync_unreachable' });
        }
        if (plan?.kind === 'network') {
            // 連線就失敗：連伺服器都沒碰到（沒有 HTTP status）。
            throw Object.assign(new Error('sync unreachable'), { code: 'sync_unreachable' });
        }
        if (plan?.kind === 'reply') {
            return new Response(JSON.stringify(plan.body), { status: plan.status || 200, headers: { 'Content-Type': 'application/json' } });
        }
        const response = await send();
        if (hooks.afterResponse) await hooks.afterResponse(entry, response);
        return response;
    };
}

/* ------------------------------------------------------------------ *
 * 世界：兩個 endpoint、三個身分、共用一份 storage
 * ------------------------------------------------------------------ */
function createWorld(t) {
    userSeq += 1;
    const alice = { userId: `alice-${userSeq}`, token: `alice-${userSeq}-${'a'.repeat(30)}` };
    const bob = { userId: `bob-${userSeq}`, token: `bob-${userSeq}-${'b'.repeat(30)}` };
    // 同一帳戶在另一台同步伺服器上會拿到另一把 token（不同伺服器簽發）。
    const aliceOnB = { userId: alice.userId, token: `alice-b-${userSeq}-${'c'.repeat(30)}` };
    const backends = {
        [ENDPOINT_A]: createBackend(ENDPOINT_A, [alice, bob]),
        [ENDPOINT_B]: createBackend(ENDPOINT_B, [aliceOnB])
    };
    t.after(() => { for (const backend of Object.values(backends)) backend.db.close(); });
    const timeline = [];
    const calls = [];
    const hooks = {};
    const storage = createStorage(timeline);
    const sessions = createSessionState({ endpoint: ENDPOINT_A, userId: alice.userId, token: alice.token });
    const world = {
        alice, bob, aliceOnB, backends, storage, sessions, calls, hooks, timeline,
        dbA: backends[ENDPOINT_A].db,
        dbB: backends[ENDPOINT_B].db,
        session: () => sessions.get(),
        tokenOf: (account) => account.token,
        client() {
            return createWorkspaceClient({
                storage,
                getSession: sessions.get,
                isSessionCurrent: sessions.isCurrent,
                request: createTransport({ backends, sessions, calls, timeline, hooks })
            });
        },
        paths: () => calls.map((entry) => `${entry.method} ${entry.path}`),
        books(userId = alice.userId) { return bookRows(world.dbA, userId); },
        articles(userId = alice.userId) { return articleRows(world.dbA, userId); }
    };
    return world;
}

function bookRows(db, userId) {
    return db.prepare("SELECT * FROM reading_entities WHERE owner_user_id=? AND entity_type='vocabularyBook' AND deleted_at IS NULL ORDER BY entity_id")
        .all(userId).map((row) => ({ ...JSON.parse(row.data_json || '{}'), id: row.entity_id, revision: Number(row.revision) }));
}

function articleRows(db, userId) {
    return db.prepare('SELECT * FROM articles WHERE owner_user_id=? AND deleted_at IS NULL ORDER BY id').all(userId);
}

const bookPayload = (overrides = {}) => ({ name: '网页生词', kind: 'page', sourceUrl: PAGE, makeDefault: false, ...overrides });
const articlePayload = (overrides = {}) => ({
    title: 'Major tech stocks plunge',
    body: '# Major tech stocks plunge\n\nMajor tech stocks plunge as investors worry.',
    sourceUrl: PAGE,
    sourceType: 'url',
    analysis: {
        summary: '市场波动',
        paragraph_analysis: [{ index: 1, original: 'Major tech stocks plunge', translation: '暴跌' }],
        vocabulary: [{ word: 'plunge', meaning: '暴跌' }]
    },
    ...overrides
});

async function pendingKeys(client, session) {
    return (await client.pending(session)).map((job) => job.key);
}

/** 讓 Worker 在 article 寫入成功後、關聯詞書時失敗（模擬 link 失敗）。 */
function blockReadingUpdates(db) {
    db.exec("CREATE TRIGGER ds_block_link BEFORE UPDATE OF data_json ON reading_entities BEGIN SELECT RAISE(ABORT, 'link blocked'); END");
}
function unblockReadingUpdates(db) {
    db.exec('DROP TRIGGER IF EXISTS ds_block_link');
}

/* ================================================================== *
 * A. 先持久化後發送、canonical 比較
 * ================================================================== */

test('A1 入列只寫 storage，不發任何請求；送出的請求一定在落盤之後', async (t) => {
    const world = createWorld(t);
    const session = world.session();
    const client = world.client();
    const job = await client.enqueue('book', bookPayload(), session);

    assert.deepEqual(world.calls, [], 'enqueue 階段不得發出網路請求');
    const stored = world.storage.data.get(job.key);
    assert.ok(stored, 'storage 內必須先有這筆待傳工作');
    assert.equal(stored.requestId, job.requestId);
    assert.equal(stored.endpoint, ENDPOINT_A);
    assert.equal(stored.userId, session.userId);
    assert.equal(stored.type, 'book');

    await client.send(job, session);
    const firstRequest = world.timeline.findIndex((event) => event.kind === 'request');
    const setIndex = world.timeline.findIndex((event) => event.kind === 'storage' && event.op === 'set');
    assert.ok(setIndex >= 0 && setIndex < firstRequest, 'storage.set 必須早於第一個請求');
    assert.equal(world.books().length, 1, '真 Worker 應建立一本書');
});

test('A2 Chrome 重排物件鍵後，重送仍視為同一筆 payload（canonical 比較）', async (t) => {
    const world = createWorld(t);
    const session = world.session();
    const client = world.client();
    const job = await client.enqueue('article', articlePayload(), session);
    const stored = world.storage.data.get(job.key);

    // 測試前提：storage 必須真的把「頂層與嵌套」鍵序都改掉，否則這條測試沒有意義。
    assert.notEqual(JSON.stringify(Object.keys(stored.payload)), JSON.stringify(Object.keys(job.payload)));
    assert.notEqual(JSON.stringify(Object.keys(stored.payload.analysis)), JSON.stringify(Object.keys(job.payload.analysis)));
    assert.deepEqual(stored.payload, job.payload, '內容必須完全相同，只有鍵序不同');

    const receipt = await client.send(job, session);
    assert.equal(receipt.ok, true);
    assert.equal(receipt.reused, false);
    assert.deepEqual(await pendingKeys(client, session), [], '成功回執後必須清掉待傳');
    assert.equal(world.articles().length, 1);
});

test('A3 storage 寫入失敗時回 capture_storage_failed，且完全沒有網路請求', async (t) => {
    const world = createWorld(t);
    const session = world.session();
    const client = world.client();
    world.storage.failNext('set');
    await assert.rejects(client.enqueue('book', bookPayload(), session), (error) => error.code === 'capture_storage_failed');
    assert.deepEqual(world.calls, [], '落盤失敗就不能發送');
    assert.deepEqual(await pendingKeys(client, session), []);
});

test('A4 落盤後被竄改的 payload 不得送出（capture_invalid_record）', async (t) => {
    const world = createWorld(t);
    const session = world.session();
    const client = world.client();
    const job = await client.enqueue('book', bookPayload({ name: '原來的名字' }), session);
    const stored = world.storage.data.get(job.key);
    stored.payload.name = '被改掉的名字';

    await assert.rejects(client.send(job, session), (error) => error.code === 'capture_invalid_record');
    assert.deepEqual(world.calls, [], '內容不一致時不得送出');
    assert.equal(world.books().length, 0);
    assert.deepEqual(await pendingKeys(client, session), [job.key], '待傳必須保留，讓使用者看得見');
});

/* ================================================================== *
 * B. 帳戶／endpoint 切換
 * ================================================================== */

test('B1 pending 只回目前帳戶的待傳，外帳戶內容完全不出現', async (t) => {
    const world = createWorld(t);
    const client = world.client();
    const aliceSession = world.session();
    const job = await client.enqueue('article', articlePayload({ title: 'alice 的文章' }), aliceSession);

    // 另一個帳戶的待傳直接寫進同一份 storage（模擬同裝置切帳戶後留下的佇列）。
    const bobSession = { endpoint: ENDPOINT_A, userId: world.bob.userId, token: world.bob.token, generation: aliceSession.generation, loggedIn: true };
    const bobKey = `bdc_workspace_outbox_v1:${encodeURIComponent(ENDPOINT_A)}:${encodeURIComponent(world.bob.userId)}:workspace_bob`;
    world.storage.data.set(bobKey, {
        type: 'article', requestId: 'workspace_bob', endpoint: ENDPOINT_A, userId: world.bob.userId,
        payload: articlePayload({ title: 'bob 的秘密標題' }), createdAt: new Date(0).toISOString()
    });

    const alicePending = await client.pending(aliceSession);
    assert.deepEqual(alicePending.map((item) => item.key), [job.key]);
    assert.ok(!JSON.stringify(alicePending).includes('bob 的秘密標題'), '不得回傳外帳戶內容');
    assert.deepEqual(await pendingKeys(client, bobSession), [bobKey], 'bob 只看得到自己的');
});

test('B2 切換帳戶後重送舊工作回 stale_session，且不發出任何請求', async (t) => {
    const world = createWorld(t);
    const client = world.client();
    const oldSession = world.session();
    const job = await client.enqueue('book', bookPayload(), oldSession);

    world.sessions.switchTo({ userId: world.bob.userId, token: world.bob.token });
    await assert.rejects(client.send(job, oldSession), (error) => error.code === 'stale_session');
    const results = await client.retry(oldSession);
    assert.ok(!results.some((result) => result.receipt), 'retry 不得用舊 token 送出舊工作');
    assert.deepEqual(world.calls, [], '切帳戶後不得用舊 token 發出任何請求');
    assert.equal(world.books(world.bob.userId).length, 0);
});

test('B3 切換 endpoint（同 userId）後舊工作不得送往新 endpoint', async (t) => {
    const world = createWorld(t);
    const client = world.client();
    const oldSession = world.session();
    const job = await client.enqueue('article', articlePayload(), oldSession);

    world.sessions.switchTo({ endpoint: ENDPOINT_B, userId: world.aliceOnB.userId, token: world.aliceOnB.token });
    await assert.rejects(client.send(job, oldSession), (error) => error.code === 'stale_session');
    assert.deepEqual(world.calls, [], '不得把 endpoint A 的 token／工作送到 endpoint B');

    // 切到 B 之後，B 自己的佇列照常可用（scope 以 endpoint+userId 隔離）。
    const newSession = world.session();
    assert.notEqual(newSession.endpoint, oldSession.endpoint);
    const fresh = await client.enqueue('book', bookPayload(), newSession);
    await client.send(fresh, newSession);
    assert.equal(bookRows(world.dbB, world.aliceOnB.userId).length, 1);
    assert.equal(world.books().length, 0, 'endpoint A 不應因 B 的操作而新增');
});

test('B4 pending 讀取（storage.get 未回）期間切換帳戶：enqueue 必須放棄寫入', async (t) => {
    const world = createWorld(t);
    const client = world.client();
    const oldSession = world.session();
    const release = world.storage.blockNext('get');
    const enqueued = client.enqueue('book', bookPayload(), oldSession);
    await tick();
    world.sessions.switchTo({ userId: world.bob.userId, token: world.bob.token });
    release();
    await assert.rejects(enqueued, (error) => error.code === 'stale_session');
    assert.equal(world.storage.data.size, 0, '切帳戶後不得留下新寫入');
    assert.deepEqual(world.calls, []);
});

test('B5 send 讀取 storage 期間切換帳戶：不得發出請求、舊待傳保留', async (t) => {
    const world = createWorld(t);
    const client = world.client();
    const oldSession = world.session();
    const job = await client.enqueue('book', bookPayload(), oldSession);
    const release = world.storage.blockNext('get');
    const sending = client.send(job, oldSession);
    await tick();
    world.sessions.switchTo({ userId: world.bob.userId, token: world.bob.token });
    release();
    await assert.rejects(sending, (error) => error.code === 'stale_session');
    assert.deepEqual(world.calls, []);
    assert.ok(world.storage.data.has(job.key), '舊帳戶的待傳必須保留');
});

test('B6 GET books 與 POST /articles 之間的 hash 等待中切換帳戶：不得建立文章', async (t) => {
    const world = createWorld(t);
    const client = world.client();
    const oldSession = world.session();
    const job = await client.enqueue('article', articlePayload(), oldSession);

    // 在 GET /vocabulary/books 的回應交回 client 後，攔住下一次 crypto.subtle.digest
    // （client 會用它算文章穩定 ID），製造真實的「hash await 途中」時間窗。
    let armDigest = false;
    let releaseDigest;
    const digestGate = new Promise((resolve) => { releaseDigest = resolve; });
    let digestHeld = false;
    world.hooks.afterResponse = () => { if (!digestHeld) { digestHeld = true; armDigest = true; } };
    const subtle = crypto.subtle;
    const originalDigest = subtle.digest;
    Object.defineProperty(subtle, 'digest', {
        configurable: true,
        writable: true,
        value: async function patchedDigest(...args) {
            const digest = await originalDigest.apply(subtle, args);
            if (armDigest) { armDigest = false; await digestGate; }
            return digest;
        }
    });
    try {
        const sending = client.send(job, oldSession);
        sending.catch(() => {});
        for (let attempt = 0; attempt < 50 && !digestHeld; attempt += 1) await tick();
        assert.ok(digestHeld, '測試前提：必須先完成 GET /vocabulary/books');
        await tick();
        world.sessions.switchTo({ userId: world.bob.userId, token: world.bob.token });
        releaseDigest();
        await assert.rejects(sending, (error) => error.code === 'stale_session');
    } finally {
        releaseDigest();
        delete subtle.digest;
    }
    assert.equal(Object.getOwnPropertyDescriptor(subtle, 'digest'), undefined, '測試不得留下全域補丁');
    assert.ok(!world.paths().includes('POST /articles'), 'hash 等待中切帳戶後不得建立文章');
    assert.ok(world.calls.every((entry) => entry.token === oldSession.token), '不得把新帳戶 token 用在舊工作上');
    assert.equal(world.articles().length, 0);
    assert.ok(world.storage.data.has(job.key), '待傳必須保留');
});

/* ================================================================== *
 * C. 畸形／外帳戶待傳、上限、回執驗證
 * ================================================================== */

test('C1 畸形待傳標成 invalid、不顯示外來內容、可單獨取消，健康項照常送出', async (t) => {
    const world = createWorld(t);
    const client = world.client();
    const session = world.session();
    const prefix = `bdc_workspace_outbox_v1:${encodeURIComponent(ENDPOINT_A)}:${encodeURIComponent(session.userId)}:`;
    // 損壞 1：payload 遺失；損壞 2：endpoint 欄位被改成陌生值（外來內容）
    world.storage.data.set(prefix + 'workspace_broken1', { type: 'article', requestId: 'workspace_broken1', endpoint: ENDPOINT_A, userId: session.userId, payload: null, createdAt: '2026-11-01T00:00:00Z' });
    world.storage.data.set(prefix + 'workspace_broken2', { type: 'book', requestId: 'workspace_broken2', endpoint: 'https://evil.example', userId: 'someone-else', payload: { name: '別人的書名' }, createdAt: '2026-11-01T00:00:01Z' });
    const healthy = await client.enqueue('book', bookPayload({ name: '健康項' }), session);

    const pending = await client.pending(session);
    const broken = pending.filter((job) => job.invalid);
    assert.equal(broken.length, 2);
    for (const job of broken) {
        assert.equal(job.type, 'invalid');
        assert.deepEqual(job.payload, {}, '損壞項不得帶出任何內容');
    }
    assert.ok(!JSON.stringify(pending).includes('別人的書名'), '不得顯示外來內容');

    // 可單獨取消其中一筆，另一筆與健康項不受影響。
    await client.cancel(broken[0], session);
    assert.ok(!world.storage.data.has(broken[0].key));
    assert.ok(world.storage.data.has(broken[1].key));

    const results = await client.retry(session);
    assert.equal(results.filter((result) => result.receipt).length, 1, '健康項必須被送出');
    assert.equal(world.books().length, 1);
    assert.deepEqual(await pendingKeys(client, session), [broken[1].key], '損壞項保留直到使用者取消');
    assert.ok(world.storage.data.has(healthy.key) === false);
});

test('C2 待傳上限 20 筆（含損壞項），第 21 筆回 capture_outbox_full', async (t) => {
    const world = createWorld(t);
    const client = world.client();
    const session = world.session();
    for (let index = 0; index < 20; index += 1) await client.enqueue('book', bookPayload({ name: '書 ' + index }), session);
    await assert.rejects(client.enqueue('book', bookPayload({ name: '多出來的' }), session), (error) => error.code === 'capture_outbox_full');
    assert.equal(world.storage.data.size, 20);
    assert.deepEqual(world.calls, []);
});

test('C3 retry：有 HTTP status 的失敗不會阻斷後續健康項', async (t) => {
    const world = createWorld(t);
    const client = world.client();
    const session = world.session();
    const failing = await client.enqueue('book', bookPayload({ name: '會被拒絕的書' }), session);
    const healthy = await client.enqueue('book', bookPayload({ name: '後面的書' }), session);
    world.hooks.plan = (entry) => (entry.method === 'POST' && entry.path === '/vocabulary/books'
        && entry.body.includes('會被拒絕的書') ? { kind: 'reply', status: 404, body: { code: 'capture_target_missing' } } : null);

    const results = await client.retry(session);
    const failed = results.find((result) => result.job.key === failing.key);
    const succeeded = results.find((result) => result.job.key === healthy.key);
    assert.equal(results.length, 2);
    assert.equal(failed.error, 'capture_target_missing');
    assert.ok(succeeded.receipt, '後續健康項必須照常送出');
    assert.deepEqual(await pendingKeys(client, session), [failing.key]);
    assert.equal(world.books().length, 1);
    assert.equal(world.storage.data.has(healthy.key), false);
});

test('C4 本機錯誤（capture_invalid_record／input／response）跳過該筆，續送後續健康項', async (t) => {
    const world = createWorld(t);
    const client = world.client();
    const session = world.session();
    const prefix = `bdc_workspace_outbox_v1:${encodeURIComponent(ENDPOINT_A)}:${encodeURIComponent(session.userId)}:`;
    // 三種只有舊版／外部竄改才可能產生的「本機錯誤」記錄，createdAt 都早於健康項。
    const malformedKey = prefix + 'workspace_broken_record';
    world.storage.data.set(malformedKey, { type: 'article', payload: { body: 'x' }, createdAt: '2026-11-01T00:00:00.000Z' });
    const badUrlKey = prefix + 'workspace_legacy_bad_url';
    world.storage.data.set(badUrlKey, {
        type: 'article', requestId: 'workspace_legacy_bad_url', endpoint: ENDPOINT_A, userId: session.userId,
        payload: articlePayload({ sourceUrl: 'javascript:alert(1)' }), createdAt: '2026-11-01T00:00:01.000Z'
    });
    const badReplyKey = prefix + 'workspace_bad_reply';
    world.storage.data.set(badReplyKey, {
        type: 'book', requestId: 'workspace_bad_reply', endpoint: ENDPOINT_A, userId: session.userId,
        payload: bookPayload({ name: '回執壞掉的書' }), createdAt: '2026-11-01T00:00:02.000Z'
    });
    // 兩筆健康項用不同網址，才分別建出兩本頁書（同網址的頁書在伺服器端是同一本）。
    const first = await client.enqueue('book', bookPayload({ name: '之後的書一', sourceUrl: OTHER_PAGE }), session);
    const second = await client.enqueue('book', bookPayload({ name: '之後的書二', sourceUrl: 'https://news.example/story/11' }), session);
    // 健康項的時間往後移，確保排在三筆壞記錄之後（不依賴同一毫秒內的 UUID 次序）。
    for (const [job, at] of [[first, '2026-11-01T00:00:03.000Z'], [second, '2026-11-01T00:00:04.000Z']]) {
        const { key, ...rest } = job;
        world.storage.data.set(key, { ...rest, createdAt: at });
    }
    world.hooks.plan = (entry) => (entry.method === 'POST' && entry.path === '/vocabulary/books' && entry.body.includes('回執壞掉的書')
        ? { kind: 'reply', status: 200, body: { ok: true, requestId: 'other-request', bookId: 'webbook_other', created: true } } : null);

    const results = await client.retry(session);
    assert.deepEqual(results.map((result) => result.job.key), [malformedKey, badUrlKey, badReplyKey, first.key, second.key],
        '必須依 createdAt 逐筆處理，且壞記錄不得中斷後續');
    assert.deepEqual(results.map((result) => result.error || 'ok'),
        ['capture_invalid_record', 'capture_invalid_input', 'capture_invalid_response', 'ok', 'ok']);
    assert.equal(world.books().length, 2, '後續健康項必須全部送出');
    assert.deepEqual(await pendingKeys(client, session), [malformedKey, badUrlKey, badReplyKey], '本機錯誤記錄保留，只能由使用者手動取消');
    assert.deepEqual(world.paths(), ['POST /vocabulary/books', 'POST /vocabulary/books', 'POST /vocabulary/books'],
        '三筆本機錯誤記錄都不得再送出任何請求（壞回執那筆的請求不算伺服器已套用）');
    assert.ok(world.calls.every((entry) => !entry.path.includes('javascript')), '不得把壞網址送到伺服器');
});

test('C4b 網路中斷與 429／5xx 仍會停止續送（不是「跳過」，等使用者處理）', async (t) => {
    const cases = [
        ['網路中斷（沒有 status）', () => ({ kind: 'network' }), 'sync_unreachable'],
        ['429', () => ({ kind: 'reply', status: 429, body: { code: 'rate_limited' } }), 'rate_limited'],
        ['503', () => ({ kind: 'reply', status: 503, body: { code: 'capture_failed' } }), 'capture_failed']
    ];
    for (const [label, plan, code] of cases) {
        const world = createWorld(t);
        const client = world.client();
        const session = world.session();
        const blocked = await client.enqueue('book', bookPayload({ name: '會被擋住的書', sourceUrl: OTHER_PAGE }), session);
        const healthy = await client.enqueue('book', bookPayload({ name: '後面的書', sourceUrl: 'https://news.example/story/11' }), session);
        // 明確拉開入列時間，避免同一毫秒內以 UUID 決勝（否則「哪一筆先被擋」不確定）。
        for (const [job, at] of [[blocked, '2026-11-01T00:00:01.000Z'], [healthy, '2026-11-01T00:00:02.000Z']]) {
            const { key, ...rest } = job;
            world.storage.data.set(key, { ...rest, createdAt: at });
        }
        world.hooks.plan = (entry) => (entry.body.includes('會被擋住的書') ? plan(entry) : null);
        const results = await client.retry(session);
        assert.equal(results.length, 1, `${label}：必須停在第一筆，不得續送後續項目`);
        assert.equal(results[0].error, code);
        assert.deepEqual(await pendingKeys(client, session), [blocked.key, healthy.key], `${label}：兩筆都必須保留`);
        assert.equal(world.calls.filter((entry) => entry.body.includes('後面的書')).length, 0, `${label}：不得送出後續項目`);
    }
});

test('C5 回執 requestId 不符不得清 pending', async (t) => {
    const world = createWorld(t);
    const client = world.client();
    const session = world.session();
    const job = await client.enqueue('book', bookPayload(), session);
    world.hooks.plan = (entry) => (entry.method === 'POST' && entry.path === '/vocabulary/books'
        ? { kind: 'reply', status: 200, body: { ok: true, requestId: 'other-request', bookId: 'webbook_x', created: true } } : null);
    await assert.rejects(client.send(job, session), (error) => error.code === 'capture_invalid_response');
    assert.deepEqual(await pendingKeys(client, session), [job.key]);
});

test('C6 回執 bookId 非法不得清 pending', async (t) => {
    const world = createWorld(t);
    const client = world.client();
    const session = world.session();
    const job = await client.enqueue('book', bookPayload(), session);
    world.hooks.plan = () => ({ kind: 'reply', status: 200, body: { ok: true, requestId: job.requestId, bookId: '../escape', created: true } });
    await assert.rejects(client.send(job, session), (error) => error.code === 'capture_invalid_response');
    assert.deepEqual(await pendingKeys(client, session), [job.key]);
    assert.equal(world.books().length, 0);
});

test('C7 401 不清 pending，且錯誤帶 status', async (t) => {
    const world = createWorld(t);
    const client = world.client();
    const session = world.session();
    const job = await client.enqueue('book', bookPayload(), session);
    // 伺服器已不認這把 token（session generation 尚未更新，等同過期 token 的當下）。
    const expired = world.sessions.switchTo({ userId: session.userId, token: 'not-a-real-token' });
    await assert.rejects(client.send(job, expired), (error) => error.code === 'unauthorized' && error.status === 401);
    assert.deepEqual(await pendingKeys(client, expired), [job.key]);
    assert.equal(world.books().length, 0);
});

test('C8 有效回執才清 pending（書）', async (t) => {
    const world = createWorld(t);
    const client = world.client();
    const session = world.session();
    const job = await client.enqueue('book', bookPayload({ makeDefault: true }), session);
    const receipt = await client.send(job, session);
    assert.equal(receipt.ok, true);
    assert.equal(receipt.requestId, job.requestId);
    assert.deepEqual(await pendingKeys(client, session), []);
    const books = world.books();
    assert.equal(books.length, 1);
    assert.equal(books[0].id, receipt.bookId);
    assert.equal(books[0].kind, undefined);
    assert.equal(books[0].name, '网页生词');
});

/* ================================================================== *
 * D. 文章路徑（真 Worker 路由）
 * ================================================================== */

test('D1 首次保存：GET sourceUrl → POST /articles → page-link，頁書被關聯', async (t) => {
    const world = createWorld(t);
    const client = world.client();
    const session = world.session();
    const bookJob = await client.enqueue('book', bookPayload(), session);
    const bookReceipt = await client.send(bookJob, session);
    assert.equal(world.books()[0].articleId, undefined, '尚無文章時頁書不應有 articleId');

    const articleJob = await client.enqueue('article', articlePayload(), session);
    const receipt = await client.send(articleJob, session);
    assert.deepEqual(world.paths(), ['POST /vocabulary/books', `GET /vocabulary/books?sourceUrl=${encodeURIComponent(PAGE)}`,
        'POST /articles', 'POST /vocabulary/page-link']);
    assert.equal(receipt.ok, true);
    assert.equal(receipt.reused, false);
    const articles = world.articles();
    assert.equal(articles.length, 1);
    assert.equal(articles[0].id, receipt.articleId);
    assert.equal(articles[0].source_url, PAGE);
    assert.equal(world.books()[0].articleId, receipt.articleId, '頁書應被關聯到新文章');
    assert.equal(world.books()[0].id, bookReceipt.bookId);
    assert.deepEqual(await pendingKeys(client, session), []);
});

test('D2 文章已存在：不再 POST /articles，改由 page-link 補關聯並回 reused', async (t) => {
    const world = createWorld(t);
    const client = world.client();
    const session = world.session();
    const bookJob = await client.enqueue('book', bookPayload(), session);
    await client.send(bookJob, session);
    // 主站（或先前的手機端）已建立同一網址的文章；建立時關聯失敗（模擬）。
    blockReadingUpdates(world.dbA);
    const stableId = await pageStableId('webart', PAGE);
    const created = await worker.fetch(new Request(ENDPOINT_A + '/articles', {
        method: 'POST',
        headers: { Origin: ORIGIN, 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.token },
        body: JSON.stringify({ id: stableId, title: '既有文章', body: '既有正文', sourceType: 'url', sourceUrl: PAGE, clientMutationId: 'seed-1' })
    }), world.backends[ENDPOINT_A].env);
    assert.equal(created.status, 500, '測試前提：文章建立成功但關聯失敗');
    unblockReadingUpdates(world.dbA);
    const original = articleRows(world.dbA, session.userId)[0];
    assert.ok(original, '文章必須存在');
    assert.equal(world.books()[0].articleId, undefined, '測試前提：頁書尚未關聯');

    world.calls.length = 0;
    const articleJob = await client.enqueue('article', articlePayload({ title: '本地新內容', body: '本地新正文' }), session);
    const receipt = await client.send(articleJob, session);
    assert.deepEqual(world.paths(), [`GET /vocabulary/books?sourceUrl=${encodeURIComponent(PAGE)}`, 'POST /vocabulary/page-link']);
    assert.equal(receipt.reused, true);
    assert.equal(receipt.articleId, original.id);
    assert.equal(world.books()[0].articleId, original.id, 'page-link 應補上關聯');
    assert.equal(articleRows(world.dbA, session.userId).length, 1);
    assert.equal(articleRows(world.dbA, session.userId)[0].body, '既有正文', '不得覆蓋既有文章內容');
});

test('D3 本次 POST /articles 成功但連結失敗（500）：pending 保留，重試可補關聯', async (t) => {
    const world = createWorld(t);
    const client = world.client();
    const session = world.session();
    await client.send(await client.enqueue('book', bookPayload(), session), session);

    blockReadingUpdates(world.dbA);
    const job = await client.enqueue('article', articlePayload(), session);
    const silent = () => {};
    const originalError = console.error;
    console.error = silent;
    try {
        await assert.rejects(client.send(job, session), (error) => error.code === 'internal_error' && error.status === 500);
    } finally {
        console.error = originalError;
    }
    assert.equal(articleRows(world.dbA, session.userId).length, 1, '文章其實已在雲端建立');
    assert.equal(world.books()[0].articleId, undefined, '關聯確實失敗');
    assert.deepEqual(await pendingKeys(client, session), [job.key], '失敗時必須保留待傳');

    unblockReadingUpdates(world.dbA);
    world.calls.length = 0;
    const results = await client.retry(session);
    assert.equal(results.filter((result) => result.receipt).length, 1);
    assert.ok(!world.paths().includes('POST /articles'), '重試時文章已存在，不應重複建立');
    assert.equal(articleRows(world.dbA, session.userId).length, 1);
    assert.equal(world.books()[0].articleId, results[0].receipt.articleId, 'page-link 應補上關聯');
    assert.deepEqual(await pendingKeys(client, session), []);
});

test('D4 回應遺失後重試：不重複建立、也不覆蓋雲端已編輯的內容', async (t) => {
    const world = createWorld(t);
    const client = world.client();
    const session = world.session();
    await client.send(await client.enqueue('book', bookPayload(), session), session);

    world.hooks.plan = (entry) => (entry.method === 'POST' && entry.path === '/articles' ? { kind: 'lose' } : null);
    const job = await client.enqueue('article', articlePayload(), session);
    await assert.rejects(client.send(job, session), (error) => error.code === 'sync_unreachable');
    assert.equal(articleRows(world.dbA, session.userId).length, 1, '伺服器其實已建立文章');
    assert.deepEqual(await pendingKeys(client, session), [job.key], '回應遺失時必須保留待傳');
    world.hooks.plan = null;

    // 使用者回到主站編輯這篇文章。
    const row = articleRows(world.dbA, session.userId)[0];
    const articleId = row.id;
    const edited = await worker.fetch(new Request(`${ENDPOINT_A}/articles/${encodeURIComponent(articleId)}`, {
        method: 'PUT',
        headers: { Origin: ORIGIN, 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.token },
        body: JSON.stringify({ title: '主站編輯後的標題', body: '主站編輯後的正文', sourceType: 'url', sourceUrl: PAGE, expectedRevision: Number(row.revision) })
    }), world.backends[ENDPOINT_A].env);
    assert.ok(edited.ok, '測試前提：主站編輯成功');
    assert.equal(articleRows(world.dbA, session.userId)[0].body, '主站編輯後的正文');

    const results = await client.retry(session);
    assert.equal(results.filter((result) => result.receipt).length, 1);
    assert.equal(results[0].receipt.articleId, articleId);
    assert.equal(results[0].receipt.reused, true);
    const articles = articleRows(world.dbA, session.userId);
    assert.equal(articles.length, 1, '不得重複建立');
    assert.equal(articles[0].body, '主站編輯後的正文', '重送不得覆蓋已編輯文章');
    assert.deepEqual(await pendingKeys(client, session), []);
    assert.equal(world.books()[0].articleId, articleId);
});

test('D5 現況：同網址再存一次（新 requestId）會沿用舊文章，本地新內容不會送出', async (t) => {
    const world = createWorld(t);
    const client = world.client();
    const session = world.session();
    await client.send(await client.enqueue('article', articlePayload({ body: '第一次的正文' }), session), session);

    world.calls.length = 0;
    const second = await client.enqueue('article', articlePayload({ title: '第二次的標題', body: '第二次的正文' }), session);
    const receipt = await client.send(second, session);
    assert.deepEqual(world.paths(), [`GET /vocabulary/books?sourceUrl=${encodeURIComponent(PAGE)}`, 'POST /vocabulary/page-link']);
    assert.equal(receipt.reused, true);
    assert.equal(articleRows(world.dbA, session.userId).length, 1);
    assert.equal(articleRows(world.dbA, session.userId)[0].body, '第一次的正文');
    assert.deepEqual(await pendingKeys(client, session), []);
});

test('D6 入列時就拒絕非法 sourceUrl 與非法文章內容（不落盤、不發請求）', async (t) => {
    const world = createWorld(t);
    const client = world.client();
    const session = world.session();
    await assert.rejects(client.enqueue('article', articlePayload({ sourceUrl: 'not a url' }), session),
        (error) => error.code === 'capture_invalid_input');
    await assert.rejects(client.enqueue('article', articlePayload({ sourceUrl: 'javascript:alert(1)' }), session),
        (error) => error.code === 'capture_invalid_input');
    await assert.rejects(client.enqueue('article', articlePayload({ body: '   ' }), session),
        (error) => error.code === 'invalid_article' && error.status === 422);
    assert.equal(world.storage.data.size, 0, '拒絕的輸入不得落盤');
    assert.deepEqual(world.calls, []);
});

test('D7 page-link 回執 articleId 非法時不得清 pending', async (t) => {
    const world = createWorld(t);
    const client = world.client();
    const session = world.session();
    await client.send(await client.enqueue('article', articlePayload(), session), session);
    const second = await client.enqueue('article', articlePayload(), session);
    world.hooks.plan = (entry) => (entry.path === '/vocabulary/page-link' ? { kind: 'reply', status: 200, body: { ok: true, articleId: 'bad id/../' } } : null);
    await assert.rejects(client.send(second, session), (error) => error.code === 'capture_invalid_response');
    assert.deepEqual(await pendingKeys(client, session), [second.key]);
});

test('D11 舊版後端對 page-link 回 404 時轉成 capture_server_update_required，業務 404 保留原錯誤碼', async (t) => {
    const world = createWorld(t);
    const client = world.client();
    const session = world.session();
    await client.send(await client.enqueue('article', articlePayload(), session), session);
    const second = await client.enqueue('article', articlePayload(), session);
    world.hooks.plan = (entry) => (entry.path === '/vocabulary/page-link' ? { kind: 'reply', status: 404, body: { code: 'not_found' } } : null);
    await assert.rejects(client.send(second, session),
        (error) => error.code === 'capture_server_update_required' && error.status === 404);
    assert.deepEqual(await pendingKeys(client, session), [second.key], '不可因為後端不支援就清掉待傳');
    world.hooks.plan = (entry) => (entry.path === '/vocabulary/page-link' ? { kind: 'reply', status: 404, body: { code: 'article_not_found' } } : null);
    await assert.rejects(client.send(second, session), (error) => error.code === 'article_not_found');
    assert.deepEqual(await pendingKeys(client, session), [second.key]);
});

test('D8 網址片段（#comments）不會被當成另一頁', async (t) => {
    const world = createWorld(t);
    const client = world.client();
    const session = world.session();
    const first = await client.enqueue('article', articlePayload(), session);
    const receipt = await client.send(first, session);
    world.calls.length = 0;
    const second = await client.enqueue('article', articlePayload({ sourceUrl: PAGE_WITH_FRAGMENT }), session);
    const secondReceipt = await client.send(second, session);
    assert.equal(secondReceipt.articleId, receipt.articleId, '尾端片段不應產生第二篇文章');
    assert.equal(articleRows(world.dbA, session.userId).length, 1);
    assert.ok(world.calls.every((entry) => !entry.path.includes('%23comments')), '送給伺服器的網址應正規化');
});

test('D9 不同網址會建立不同文章', async (t) => {
    const world = createWorld(t);
    const client = world.client();
    const session = world.session();
    const first = await client.send(await client.enqueue('article', articlePayload(), session), session);
    const second = await client.send(await client.enqueue('article', articlePayload({ sourceUrl: OTHER_PAGE }), session), session);
    assert.notEqual(first.articleId, second.articleId);
    assert.equal(articleRows(world.dbA, session.userId).length, 2);
});

test('D10 同網址文章已被刪除（墓碑）時改用新的穩定 ID 重建，不會卡住', async (t) => {
    const world = createWorld(t);
    const client = world.client();
    const session = world.session();
    const bookReceipt = await client.send(await client.enqueue('book', bookPayload(), session), session);
    const first = await client.send(await client.enqueue('article', articlePayload(), session), session);

    const row = articleRows(world.dbA, session.userId)[0];
    const deleted = await worker.fetch(new Request(`${ENDPOINT_A}/articles/${encodeURIComponent(first.articleId)}`, {
        method: 'DELETE',
        headers: { Origin: ORIGIN, 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.token },
        body: JSON.stringify({ expectedRevision: Number(row.revision), clientMutationId: 'seed-delete' })
    }), world.backends[ENDPOINT_A].env);
    assert.ok(deleted.ok, '測試前提：主站已刪除文章');
    assert.equal(articleRows(world.dbA, session.userId).length, 0);

    world.calls.length = 0;
    const rebuilt = await client.send(await client.enqueue('article', articlePayload({ body: '重建後的正文' }), session), session);
    assert.ok(world.paths().includes('POST /articles'), '應重新建立文章');
    assert.notEqual(rebuilt.articleId, first.articleId, '必須配置新的文章 ID，不能卡在墓碑');
    assert.equal(rebuilt.reused, false);
    const active = articleRows(world.dbA, session.userId);
    assert.equal(active.length, 1);
    assert.ok(active[0].body.includes('重建後的正文'));
    const books = world.books();
    assert.equal(books.find((book) => book.id === bookReceipt.bookId)?.articleId, rebuilt.articleId, '頁書應改為關聯重建後的文章');
    assert.deepEqual(await pendingKeys(client, session), []);
});

/* ================================================================== *
 * E. 併發與取消
 * ================================================================== */

test('E1 兩個 client 共用同一份 storage 併發送同一筆工作：只建立一次，兩邊回執都有效', async (t) => {
    const world = createWorld(t);
    const session = world.session();
    const popup = world.client();
    const inline = world.client();
    const job = await popup.enqueue('article', articlePayload(), session);
    const [first, second] = await Promise.all([popup.send(job, session), inline.send(job, session)]);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(first.articleId, second.articleId, '兩邊必須指向同一篇文章');
    assert.equal(articleRows(world.dbA, session.userId).length, 1);
    assert.deepEqual(await pendingKeys(popup, session), []);
});

test('E2 取消只刪本機待傳，不刪雲端已建立的文章與詞書關聯', async (t) => {
    const world = createWorld(t);
    const client = world.client();
    const session = world.session();
    await client.send(await client.enqueue('book', bookPayload(), session), session);
    blockReadingUpdates(world.dbA);
    const job = await client.enqueue('article', articlePayload(), session);
    const originalError = console.error;
    console.error = () => {};
    try {
        await assert.rejects(client.send(job, session), (error) => error.status === 500);
    } finally {
        console.error = originalError;
        unblockReadingUpdates(world.dbA);
    }
    assert.equal(articleRows(world.dbA, session.userId).length, 1);

    await client.cancel(job, session);
    assert.deepEqual(await pendingKeys(client, session), []);
    assert.equal(articleRows(world.dbA, session.userId).length, 1, '取消不得刪除雲端文章');
    assert.equal(world.books().length, 1, '取消不得刪除詞書');
    assert.equal(world.calls.filter((entry) => entry.method === 'DELETE').length, 0, '取消不得發出刪除請求');
});

test('E3 pending 依 createdAt 排序（同時間以 key 穩定），retry 也照此順序送出', async (t) => {
    const world = createWorld(t);
    const client = world.client();
    const session = world.session();
    const setCreatedAt = (job, createdAt) => {
        const { key, ...rest } = job;
        world.storage.data.set(key, { ...rest, createdAt });
    };
    // 入列次序刻意與時間次序相反；兩筆時間明確不同（不依賴同一毫秒內的 UUID 次序）。
    const later = await client.enqueue('book', bookPayload({ name: '後入列但時間較早' }), session);
    setCreatedAt(later, '2026-11-01T00:00:09.000Z');
    const earlier = await client.enqueue('article', articlePayload(), session);
    setCreatedAt(earlier, '2026-11-01T00:00:01.000Z');

    assert.deepEqual((await client.pending(session)).map((job) => job.key), [earlier.key, later.key],
        'pending 必須依 createdAt 排序，而不是 storage 鍵序／入列次序');

    // 同一時間的兩筆：以 key 穩定排序（同一份 storage 兩次呼叫結果一致）。
    const twinA = await client.enqueue('book', bookPayload({ name: '同時間 A' }), session);
    const twinB = await client.enqueue('book', bookPayload({ name: '同時間 B' }), session);
    for (const job of [twinA, twinB]) setCreatedAt(job, '2026-11-01T00:00:05.000Z');
    const tied = [twinA.key, twinB.key].sort();
    const firstRead = (await client.pending(session)).map((job) => job.key);
    const secondRead = (await client.pending(session)).map((job) => job.key);
    assert.deepEqual(firstRead, [earlier.key, ...tied, later.key], '同時間必須以 key 排序');
    assert.deepEqual(secondRead, firstRead, '同一份 storage 的排序必須穩定');

    // retry 依同一順序送出：先建書、再存文章（頁書在文章建立後被關聯）。
    world.calls.length = 0;
    const results = await client.retry(session);
    assert.deepEqual(results.map((result) => result.job.key), [earlier.key, ...tied, later.key]);
    assert.ok(results.every((result) => result.receipt), '四筆都應成功');
    assert.deepEqual(world.paths(), [
        'GET /vocabulary/books?sourceUrl=' + encodeURIComponent(PAGE), 'POST /articles', 'POST /vocabulary/page-link',
        'POST /vocabulary/books', 'POST /vocabulary/books', 'POST /vocabulary/books'
    ], '時間最早的（文章）必須先送出；同時間的三筆依 key 排序');
    assert.equal(world.articles().length, 1);
    assert.ok(world.books().some((book) => book.sourceUrl === PAGE && book.articleId === results[0].receipt.articleId),
        '較晚入列但同頁的詞書仍要在文章建立後被關聯');
    assert.deepEqual(await pendingKeys(client, session), []);
});

test('E4 同網址的兩筆文章工作併發送出：只建立一篇文章', async (t) => {
    const world = createWorld(t);
    const session = world.session();
    const popup = world.client();
    const inline = world.client();
    const first = await popup.enqueue('article', articlePayload({ title: '彈窗版本' }), session);
    const second = await inline.enqueue('article', articlePayload({ title: '浮窗版本' }), session);
    const receipts = await Promise.all([popup.send(first, session), inline.send(second, session)]);
    assert.equal(articleRows(world.dbA, session.userId).length, 1, '同網址只允許一篇文章');
    assert.equal(receipts[0].articleId, receipts[1].articleId);
    assert.deepEqual(await pendingKeys(popup, session), []);
});

test('E5 storage.remove 失敗後重試：不會重複建書（伺服器 ledger 冪等）', async (t) => {
    const world = createWorld(t);
    const client = world.client();
    const session = world.session();
    const job = await client.enqueue('book', bookPayload(), session);
    world.storage.failNext('remove');
    await assert.rejects(client.send(job, session), /storage remove failed/);
    assert.ok(world.storage.data.has(job.key), '清單未清掉時必須保留待傳');
    assert.equal(world.books().length, 1, '這一輪其實已在雲端建立');

    const results = await client.retry(session);
    assert.equal(results.filter((result) => result.receipt).length, 1);
    assert.equal(world.books().length, 1, '重試不得建出第二本');
    assert.equal(results[0].receipt.bookId, world.books()[0].id);
    assert.deepEqual(await pendingKeys(client, session), []);
});
