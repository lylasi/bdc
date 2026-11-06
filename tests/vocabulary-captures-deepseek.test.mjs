// DeepSeek 獨立補測：加入詞書後端（真實 SQLite + selfhost D1 adapter + Worker 路由）。
//
// 目的不是重跑 tests/vocabulary-captures.test.mjs 的斷言，而是針對下列風險補有鑑別力的覆蓋：
//   1. 交易原子性（entity／change／cursor／回執必須同進同退，失敗不得留下半套狀態）
//   2. 重播（同 requestId 併發、跨刪除、跨復活、改內容）仍必須逐欄回原回執
//   3. 並發（相同 payload、不同詞）不重複建詞條、不重複推進 cursor、seq 不重複
//   4. 讀取後被使用者編輯／刪除的中間狀態
//   5. 來源去重與 100 筆上限（含 legacy 超量資料不得被靜默裁切）
//   6. 驗證、限流與帳戶隔離
//   7. 新 migration 冪等，且在真 SQLite 上可執行收藏
//
// 每個測試使用獨立的 :memory: 資料庫與獨立使用者，避免 http.js 的 in-isolate
// 限流桶（模組層級 Map）互相污染；所有帳號都由測試自建。

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../cloudflare-worker/src/worker.js';
import { validateCapture } from '../shared/capture-protocol.mjs';
import { createD1Adapter, createSqliteDatabase } from '../selfhost/d1-adapter.js';

const root = new URL('..', import.meta.url);
const ORIGIN = 'chrome-extension://probe';
let userSeq = 0;

function schemaSql(name = 'cloudflare-worker/schema.sql') {
    return readFileSync(new URL(name, root), 'utf8');
}

/** 真 SQLite + 真 D1 adapter + 真實 Worker 路由；回傳可獨立操作的 env/call。 */
function setup(t, { books = [{ id: 'book', name: '单词本' }], extraUsers = [] } = {}) {
    userSeq += 1;
    const userId = `ds${userSeq}`;
    const token = `deepseek-token-${userSeq}-${'x'.repeat(20)}`;
    const db = new DatabaseSync(':memory:');
    db.exec(schemaSql());
    const users = [[userId, token], ...extraUsers.map(([id, tk]) => [id, tk])];
    for (const [id, tk] of users) {
        db.prepare('INSERT INTO users(token_hash,user_id,role) VALUES(?,?,?)')
            .run(createHash('sha256').update(tk).digest('hex'), id, 'user');
    }
    for (const book of books) entity(db, userId, 'vocabularyBook', book.id, { name: book.name });
    const env = { DB: createD1Adapter(createSqliteDatabase(db)), ALLOWED_ORIGINS: ORIGIN };
    t.after(() => db.close());
    return { db, env, userId, token, call: (path, body, as) => call(env, path, body, as || token) };
}

function entity(db, owner, type, id, data, revision = 1, deleted = null) {
    db.prepare('INSERT OR REPLACE INTO reading_entities VALUES(?,?,?,?,?,?,?,?)')
        .run(owner, type, id, revision, deleted, JSON.stringify(data), '2026-11-01T00:00:00Z', 'seed');
}

async function call(env, path, body, token) {
    const response = await worker.fetch(new Request('https://sync.example' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Origin: ORIGIN, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }), env);
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
}

function input(overrides = {}) {
    return {
        requestId: 'request-1', bookId: 'book', word: 'plunge', meaning: '暴跌',
        phonetic: 'plʌndʒ', pos: 'verb',
        source: {
            sourceUrl: 'https://news.example/article?edition=hk#headline', pageTitle: 'Stocks plunge',
            sentence: 'Major tech stocks plunge.', context: 'Major tech stocks plunge. Markets are volatile.',
            locale: 'zh-HK', anchor: { start: 18, end: 24, quote: 'plunge' }
        },
        ...overrides
    };
}

const rows = (db, table, where = '', ...args) => db.prepare(`SELECT * FROM ${table} ${where}`).all(...args);
const entryRow = (db, id, owner) => db.prepare(
    "SELECT * FROM reading_entities WHERE owner_user_id=? AND entity_type='vocabularyEntry' AND entity_id=?"
).get(owner || 'ds1', id);
const entryCount = (db, owner) => db.prepare(
    "SELECT count(*) c FROM reading_entities WHERE owner_user_id=? AND entity_type='vocabularyEntry'"
).get(owner).c;
const cursor = (db, owner) => db.prepare('SELECT next_seq FROM reading_state WHERE owner_user_id=?').get(owner)?.next_seq ?? 1;

// ── 1. 詞書列表 ──────────────────────────────────────────────────────────────

test('詞書列表：只回本人未刪除的詞書，且不靠名稱／字典序猜預設', async (t) => {
    const [bobId, bobToken] = ['bob-books', 'bob-token-books'];
    const { db, call, userId } = setup(t, {
        books: [{ id: 'zz-plain', name: 'My words' }, { id: 'aa-preferred', name: '生字簿' }],
        extraUsers: [[bobId, bobToken]]
    });
    entity(db, bobId, 'vocabularyBook', 'bob-book', { name: '单词本' }, 9);
    entity(db, userId, 'vocabularyBook', 'gone', { name: 'Removed' }, 4, '2026-11-02');
    const result = await call('/vocabulary/books');
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.books.map((book) => book.id), ['aa-preferred', 'zz-plain'], '只回自己的、未刪除的詞書');
    assert.equal(result.body.defaultBookId, '', '帳號模型沒有明確預設：不得按名稱或 entity_id 猜一本');
    assert.deepEqual(Object.keys(result.body.books[0]).sort(), ['id', 'name', 'revision'], '不得夾帶他人或內部欄位');

    const bob = await call('/vocabulary/books', undefined, bobToken);
    assert.deepEqual(bob.body.books.map((book) => book.id), ['bob-book']);
    assert.equal(bob.body.defaultBookId, '', '別的帳戶也一樣沒有預設');

    entity(db, userId, 'vocabularyBook', 'aa-preferred', { name: '生字簿' }, 5, '2026-11-03');
    const afterDelete = await call('/vocabulary/books');
    assert.deepEqual(afterDelete.body.books.map((book) => book.id), ['zz-plain'], '墓碑不得出現在清單');
    assert.equal(afterDelete.body.defaultBookId, '', '刪掉一本之後仍然不會自動接管成預設');
});

test('能力端點與方法限制：未發布前不得把收藏當成已可用', async (t) => {
    const { call } = setup(t);
    const caps = await call('/captures/capabilities');
    assert.deepEqual(caps.body, { captureVersion: 1, maxSources: 100 });
    assert.equal((await call('/vocabulary/books', {})).status, 405);
    assert.equal((await call('/captures')).status, 405, 'GET /captures 不是收藏入口');
    const anon = await worker.fetch(new Request('https://sync.example/captures/capabilities', { headers: { Origin: ORIGIN } }), { DB: { prepare() {} } });
    assert.equal(anon.status, 401);
});

// ── 2. 交易原子性 ────────────────────────────────────────────────────────────

test('詞條寫入失敗時回執／change／cursor 全不落地，修正後同 requestId 重試只 +1 revision', async (t) => {
    const { db, env, call, userId } = setup(t);
    entity(db, userId, 'vocabularyEntry', 'pre-existing', { bookId: 'book', word: 'plunge', meaning: '原有', sources: [] }, 4);
    db.exec("CREATE TRIGGER deny_update BEFORE UPDATE ON reading_entities WHEN NEW.entity_type='vocabularyEntry' "
        + "BEGIN SELECT RAISE(ABORT,'test deny entry'); END");
    db.exec("CREATE TRIGGER deny_insert BEFORE INSERT ON reading_entities WHEN NEW.entity_type='vocabularyEntry' "
        + "BEGIN SELECT RAISE(ABORT,'test deny entry'); END");
    const failed = await call('/captures', input());
    assert.equal(failed.status, 500);
    assert.equal(failed.body.code, 'capture_failed');
    assert.equal(rows(db, 'vocabulary_captures').length, 0, '不得留下 claim 或回執');
    assert.equal(entryCount(db, userId), 1);
    assert.equal(entryRow(db, 'pre-existing', userId).revision, 4, '詞條不得被偷偷改版');
    assert.equal(rows(db, 'reading_changes').length, 0);
    assert.equal(cursor(db, userId), 1, 'cursor 不得前進');

    db.exec('DROP TRIGGER deny_update');
    db.exec('DROP TRIGGER deny_insert');
    const retried = await call('/captures', input());
    assert.equal(retried.status, 200, JSON.stringify(retried));
    assert.equal(retried.body.entryId, 'pre-existing');
    assert.equal(retried.body.revision, 5, '只前進一版');
    assert.equal(rows(db, 'vocabulary_captures').length, 1);
    assert.equal(JSON.parse(entryRow(db, 'pre-existing', userId).data_json).meaning, '原有');
    assert.equal(JSON.parse(entryRow(db, 'pre-existing', userId).data_json).sources.length, 1);
});

test('回執寫入失敗（回執表被擋）時不得留下詞條或 change', async (t) => {
    const { db, env, call, userId } = setup(t);
    db.exec("CREATE TRIGGER deny_receipt BEFORE INSERT ON vocabulary_captures BEGIN SELECT RAISE(ABORT,'no receipt'); END");
    const result = await call('/captures', input());
    assert.equal(result.status, 500);
    assert.equal(entryCount(db, userId), 0, '沒有回執就不能有詞條（否則重播會重複追加來源）');
    assert.equal(rows(db, 'reading_changes').length, 0);
    db.exec('DROP TRIGGER deny_receipt');
    const ok = await call('/captures', input());
    assert.equal(ok.status, 200);
    assert.equal(rows(db, 'vocabulary_captures').length, 1);
});

// ── 3. 重播與並發 ────────────────────────────────────────────────────────────

test('同 requestId 併發三連送：全數 200 且回執完全相同，只寫一次', async (t) => {
    const { db, call, userId } = setup(t);
    const results = await Promise.all([1, 2, 3].map(() => call('/captures', input())));
    assert.deepEqual(results.map((r) => r.status), [200, 200, 200], JSON.stringify(results));
    assert.deepEqual(results[1].body, results[0].body);
    assert.deepEqual(results[2].body, results[0].body);
    assert.equal(entryCount(db, userId), 1);
    assert.equal(rows(db, 'vocabulary_captures').length, 1);
    assert.equal(rows(db, 'reading_changes').length, 1);
    assert.equal(cursor(db, userId), 2, '重播不得推進 cursor');
});

test('併發四個不同詞：seq 連續不重複、cursor 恰好前進四次', async (t) => {
    const { db, env, call, userId } = setup(t);
    const words = ['alpha', 'bravo', 'charlie', 'delta'];
    const results = await Promise.all(words.map((word, index) => call('/captures', input({
        requestId: `concurrent-${index}`, word,
        source: { ...input().source, anchor: { start: index, end: index + word.length, quote: word } }
    }))));
    assert.deepEqual(results.map((r) => r.status), [200, 200, 200, 200], JSON.stringify(results));
    assert.equal(entryCount(db, userId), 4);
    const seqs = rows(db, 'reading_changes', 'ORDER BY seq').map((row) => row.seq);
    assert.deepEqual(seqs, [1, 2, 3, 4], 'reading_changes 主鍵必須連續且無重複');
    assert.equal(cursor(db, userId), 5);
    const changes = await call('/reading/changes?cursor=0');
    assert.equal(changes.body.changes.length, 4);
    assert.equal(changes.body.hasMore, false);
});

test('同詞不同來源併發：只建一個詞條，兩筆來源都保存且各記一次 change', async (t) => {
    const { db, call, userId } = setup(t);
    const results = await Promise.all(['https://a.example/x', 'https://b.example/y'].map((sourceUrl, index) => call(
        '/captures',
        input({ requestId: `pair-${index}`, source: { ...input().source, sourceUrl, anchor: { start: index * 10, end: index * 10 + 6, quote: 'plunge' } } })
    )));
    assert.deepEqual(results.map((r) => r.status), [200, 200]);
    assert.equal(results[0].body.entryId, results[1].body.entryId);
    const saved = JSON.parse(entryRow(db, results[0].body.entryId, userId).data_json);
    assert.equal(saved.sources.length, 2);
    assert.equal(new Set(saved.sources.map((s) => s.sourceUrl)).size, 2);
    assert.equal(rows(db, 'reading_changes').length, 2);
    assert.equal(cursor(db, userId), 3);
});

test('已刪除的詞書不得靜默成功：404 且不留回執、詞條或 change', async (t) => {
    const { db, call, userId } = setup(t);
    entity(db, userId, 'vocabularyBook', 'dead-book', { name: 'Dead' }, 3, '2026-11-02');
    const result = await call('/captures', input({ bookId: 'dead-book' }));
    assert.equal(result.status, 404, JSON.stringify(result));
    assert.equal(result.body.code, 'capture_target_missing');
    assert.equal(rows(db, 'vocabulary_captures').length, 0);
    assert.equal(entryCount(db, userId), 0);
    assert.equal(rows(db, 'reading_changes').length, 0);
});

test('讀取後詞書被刪除：交易條件擋下，不會留下半套資料', async (t) => {
    const { db, env, call, userId } = setup(t);
    const original = env.DB.batch;
    let once = false;
    env.DB.batch = async (statements) => {
        if (!once) {
            once = true;
            db.exec("UPDATE reading_entities SET deleted_at='2026-11-06', revision=revision+1 WHERE entity_type='vocabularyBook'");
        }
        return original(statements);
    };
    const result = await call('/captures', input());
    assert.notEqual(result.status, 200, '詞書已刪除就不得回報成功');
    assert.equal(rows(db, 'vocabulary_captures').length, 0, '不得留下回執');
    assert.equal(entryCount(db, userId), 0, '不得留下孤兒詞條');
    assert.equal(rows(db, 'reading_changes').length, 0);
});

test('同 requestId 改詞書或改字：409 且不產生第二筆寫入', async (t) => {
    const { db, call, userId } = setup(t);
    const first = await call('/captures', input());
    assert.equal(first.status, 200);
    for (const changed of [{ bookId: 'missing' }, { word: 'rise' }, { meaning: '上升' }, { source: undefined }]) {
        const result = await call('/captures', input(changed));
        assert.equal(result.status, 409, JSON.stringify(changed));
        assert.equal(result.body.code, 'capture_request_mismatch');
    }
    assert.equal(entryCount(db, userId), 1);
    assert.equal(rows(db, 'reading_changes').length, 1);
});

// ── 4. 讀取後的中間狀態（已編輯／已刪除）─────────────────────────────────────

test('讀取後使用者改了釋義：重試後保留使用者釋義與例句，只追加來源', async (t) => {
    const { db, env, call, userId } = setup(t);
    const first = await call('/captures', input());
    const original = env.DB.batch;
    let once = false;
    env.DB.batch = async (statements) => {
        if (!once) {
            once = true;
            const row = entryRow(db, first.body.entryId, userId);
            const data = JSON.parse(row.data_json);
            data.meaning = '使用者改寫的釋義';
            data.examples = [{ en: 'Prices plunge.', zh: '價格暴跌。' }];
            db.prepare('UPDATE reading_entities SET data_json=?, revision=revision+1 WHERE entity_id=?')
                .run(JSON.stringify(data), first.body.entryId);
        }
        return original(statements);
    };
    const second = await call('/captures', input({
        requestId: 'request-2', source: { ...input().source, sourceUrl: 'https://second.example/page' }
    }));
    assert.equal(second.status, 200, JSON.stringify(second));
    const saved = JSON.parse(entryRow(db, first.body.entryId, userId).data_json);
    assert.equal(saved.meaning, '使用者改寫的釋義', '不得覆蓋使用者編輯');
    assert.deepEqual(saved.examples, [{ en: 'Prices plunge.', zh: '價格暴跌。' }]);
    assert.equal(saved.sources.length, 2);
    assert.equal(entryRow(db, first.body.entryId, userId).revision, 3, '衝突後只再前進一版');
    assert.equal(rows(db, 'reading_changes').length, 2);
    assert.equal(cursor(db, userId), 3);
});

test('讀取後使用者刪除詞條：不產生第二個詞條，重試不會撞主鍵', async (t) => {
    const { db, env, call, userId } = setup(t);
    const first = await call('/captures', input());
    const original = env.DB.batch;
    let once = false;
    env.DB.batch = async (statements) => {
        if (!once) {
            once = true;
            db.prepare("UPDATE reading_entities SET deleted_at='2026-11-06', revision=revision+1 WHERE entity_id=?")
                .run(first.body.entryId);
        }
        return original(statements);
    };
    const second = await call('/captures', input({ requestId: 'request-2' }));
    assert.equal(second.status, 200, JSON.stringify(second));
    assert.equal(entryCount(db, userId), 1, '不得出現兩個同詞詞條');
    const row = entryRow(db, first.body.entryId, userId);
    assert.equal(row.deleted_at, null, '現行語意：新 requestId 會復活同 ID 詞條');
    assert.equal(row.revision, 3);
});

test('刪除後以新 requestId 重新收藏：復活同一詞條，舊 requestId 仍回原始回執', async (t) => {
    const { db, env, call, userId } = setup(t);
    const first = await call('/captures', input());
    db.prepare("UPDATE reading_entities SET deleted_at='2026-11-06', revision=revision+1 WHERE entity_id=?")
        .run(first.body.entryId);
    const second = await call('/captures', input({ requestId: 'request-2' }));
    assert.equal(second.status, 200, JSON.stringify(second));
    assert.equal(second.body.entryId, first.body.entryId);
    assert.equal(entryCount(db, userId), 1);
    const replay = await call('/captures', input());
    assert.deepEqual(replay.body, first.body, '回執不可變：即使詞條已復活並改版');
    assert.equal(entryRow(db, first.body.entryId, userId).deleted_at, null);
});

// ── 5. 主站可發現性 ──────────────────────────────────────────────────────────

test('收藏只走 reading 串流：主站可從 changes/capabilities 發現，snapshot 完全不變', async (t) => {
    const { db, env, call, userId } = setup(t);
    db.prepare('INSERT INTO snapshots(user_id,version,payload,updated_at) VALUES(?,?,?,?)')
        .run(userId, 11, '{"vocabulary":{"books":[]}}', '2026-11-01T00:00:00Z');
    const before = (await call('/reading/capabilities')).body.cursor;
    const result = await call('/captures', input());
    assert.equal(result.status, 200);
    const caps = await call('/reading/capabilities');
    assert.equal(caps.body.cursor, before + 1, '前景 poll 靠 cursor 發現，不靠 snapshot version');
    const changes = await call(`/reading/changes?cursor=${before}`);
    assert.deepEqual(changes.body.changes.map((c) => [c.entityType, c.entityId, c.op, c.revision]),
        [['vocabularyEntry', result.body.entryId, 'upsert', 1]]);
    const batch = await call('/reading/batch', { keys: [{ entityType: 'vocabularyEntry', entityId: result.body.entryId }] });
    const wired = batch.body.entities[0];
    assert.equal(wired.sources[0].sourceUrl, input().source.sourceUrl);
    assert.equal(wired.sources[0].meaning, '暴跌');
    assert.equal(wired.sources[0].pageTitle, 'Stocks plunge');
    assert.equal(wired.meaning, '暴跌');
    const snapshot = rows(db, 'snapshots', 'WHERE user_id=?', userId)[0];
    assert.equal(snapshot.version, 11, 'snapshot 版本不得因收藏而改變');
    assert.equal(snapshot.payload, '{"vocabulary":{"books":[]}}');
});

// ── 6. 來源去重與上限 ────────────────────────────────────────────────────────

test('來源上限邊界：99→100 成功，100→101 明確 422 且不留回執；同意思重送仍 200、不同意義不得靜默忽略', async (t) => {
    const { db, call, userId } = setup(t);
    const sources = Array.from({ length: 99 }, (_, i) => ({
        sourceUrl: `https://example.com/${i}`, sentence: 'Existing', meaning: '暴跌', anchor: { start: -1, end: -1, quote: 'plunge' }
    }));
    entity(db, userId, 'vocabularyEntry', 'edge', { bookId: 'book', word: 'plunge', meaning: 'Keep', sources }, 3);
    const add = await call('/captures', input());
    assert.equal(add.status, 200);
    assert.equal(add.body.sourceAdded, true);
    assert.equal(JSON.parse(entryRow(db, 'edge', userId).data_json).sources.length, 100);

    const overflow = await call('/captures', input({
        requestId: 'request-2', source: { ...input().source, sourceUrl: 'https://overflow.example/' }
    }));
    assert.equal(overflow.status, 422);
    assert.equal(overflow.body.code, 'capture_sources_full');
    assert.equal(rows(db, 'vocabulary_captures').length, 1, '被拒絕的收藏不得留下回執');
    assert.equal(JSON.parse(entryRow(db, 'edge', userId).data_json).sources.length, 100);
    assert.equal(rows(db, 'reading_changes').length, 1);

    // 已存在且「意思完全相同」的來源重送：不是新來源，所以不算溢出。
    const replaySource = await call('/captures', input({
        requestId: 'request-3', source: { ...sources[7] }
    }));
    assert.equal(replaySource.status, 200, '既有來源（含相同當次意思）重送不算溢出');
    assert.equal(replaySource.body.sourceAdded, false);
    assert.equal(replaySource.body.revision, add.body.revision);

    // 同一位置但不同「當次意思」是真正的第 101 筆：必須 422，不得回 200 卻什麼都沒存。
    const otherSense = await call('/captures', input({
        requestId: 'request-4', meaning: '突然下跌', source: { ...sources[7], sentence: input().source.sentence }
    }));
    assert.equal(otherSense.status, 422, '滿 100 筆時新的當次意思必須明確拒絕，不可靜默忽略');
    assert.equal(otherSense.body.code, 'capture_sources_full');
    assert.equal(rows(db, 'vocabulary_captures').length, 2, '被拒絕的不同意思不得留下回執');
    assert.equal(JSON.parse(entryRow(db, 'edge', userId).data_json).sources.length, 100);
});

test('既有資料超過上限（legacy 120）不得被靜默裁切；新來源與新意思都拒絕、完全相同的來源可用', async (t) => {
    const { db, call, userId } = setup(t);
    const sources = Array.from({ length: 120 }, (_, i) => ({
        sourceUrl: `https://legacy.example/${i}`, sentence: 'E', meaning: '暴跌', anchor: { start: -1, end: -1, quote: 'plunge' }
    }));
    entity(db, userId, 'vocabularyEntry', 'legacy', {
        bookId: 'book', word: 'plunge', meaning: 'K', phonetic: 'plʌndʒ', pos: 'verb', sources
    }, 3);
    const fresh = await call('/captures', input({ source: { ...input().source, sourceUrl: 'https://new.example/' } }));
    assert.equal(fresh.status, 422);
    const duplicate = await call('/captures', input({ requestId: 'dup', source: sources[30] }));
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.sourceAdded, false);
    assert.equal(duplicate.body.revision, 3, '重複來源不推進 revision');
    assert.equal(JSON.parse(entryRow(db, 'legacy', userId).data_json).sources.length, 120, '不得寫回被 slice 成 100 的陣列');
    const otherSense = await call('/captures', input({ requestId: 'sense', meaning: '傾倒', source: sources[30] }));
    assert.equal(otherSense.status, 422, '同一位置的不同意思也是新來源，超量時必須拒絕而不是靜默丟棄');
    assert.equal(JSON.parse(entryRow(db, 'legacy', userId).data_json).sources.length, 120);
    assert.equal(rows(db, 'vocabulary_captures').length, 1, '被拒絕的請求不得留下回執');
});

test('同一原句同一錨點的不同「當次意思」另存來源；詞條既有（含使用者改過的）意思不被覆蓋', async (t) => {
    const { db, call, userId } = setup(t);
    const first = await call('/captures', input());
    const second = await call('/captures', input({ requestId: 'request-2', meaning: '另一義' }));
    assert.equal(second.status, 200);
    assert.equal(second.body.sourceAdded, true, '同位置不同意思必須是新來源，不可回成功卻沒存');
    assert.equal(second.body.revision, first.body.revision + 1, '新來源必須推進 revision，主站才看得到');
    const saved = JSON.parse(entryRow(db, first.body.entryId, userId).data_json);
    assert.equal(saved.sources.length, 2);
    assert.deepEqual(saved.sources.map((source) => source.meaning), ['暴跌', '另一義']);
    assert.equal(saved.meaning, '暴跌', '詞條釋義不得被第二次收藏覆蓋');
    assert.equal(rows(db, 'reading_changes').length, 2);

    // 使用者已在主站改過釋義：再收藏第三種意思也不能蓋掉他的編輯。
    const edited = { ...saved, meaning: '使用者改寫的釋義' };
    db.prepare('UPDATE reading_entities SET data_json=?, revision=revision+1 WHERE entity_id=?')
        .run(JSON.stringify(edited), first.body.entryId);
    const third = await call('/captures', input({ requestId: 'request-3', meaning: '第三義' }));
    assert.equal(third.status, 200, JSON.stringify(third));
    const after = JSON.parse(entryRow(db, first.body.entryId, userId).data_json);
    assert.equal(after.meaning, '使用者改寫的釋義', '詞條已編輯的意思不得被收藏改掉');
    assert.deepEqual(after.sources.map((source) => source.meaning), ['暴跌', '另一義', '第三義']);
});

// ── 7. 驗證、限流與帳戶隔離 ──────────────────────────────────────────────────

test('輸入驗證：欄位上限、格式與白名單在寫入前就擋下', async (t) => {
    const { db, env, call, token } = setup(t);
    const cases = [
        [{ requestId: 'a b!' }, 'capture_invalid_input'],
        [{ requestId: '' }, 'capture_invalid_input'],
        [{ bookId: '' }, 'capture_invalid_input'],
        [{ word: '   ' }, 'capture_invalid_input'],
        [{ word: 'a'.repeat(401) }, 'capture_invalid_input'],
        [{ meaning: '' }, 'capture_invalid_input'],
        [{ meaning: 'x'.repeat(4001) }, 'capture_invalid_input'],
        [{ phonetic: 'p'.repeat(201) }, 'capture_invalid_input'],
        [{ source: { locale: 'l'.repeat(21) } }, 'capture_invalid_input'],
        [{ source: { pageTitle: 't'.repeat(301) } }, 'capture_invalid_input'],
        [{ source: { context: 'c'.repeat(8001) } }, 'capture_invalid_input'],
        [{ source: { anchor: { quote: 'q'.repeat(2001) } } }, 'capture_invalid_input'],
        [{ source: { anchor: { prefix: 'p'.repeat(121) } } }, 'capture_invalid_input'],
        [{ source: { sourceUrl: 'https://user@example.com/x' } }, 'capture_invalid_url'],
        [{ source: { sourceUrl: 'javascript:alert(1)' } }, 'capture_invalid_url'],
        [{ source: { sourceUrl: 'file:///tmp/x' } }, 'capture_invalid_url'],
        [{ source: { sourceUrl: 'ftp://example.com/x' } }, 'capture_invalid_url'],
        [{ source: { sourceUrl: `https://example.com/${'x'.repeat(4100)}` } }, 'capture_invalid_input']
    ];
    for (const [override, code] of cases) {
        const result = await call('/captures', input(override));
        assert.equal(result.status, 400, JSON.stringify(override).slice(0, 120));
        assert.equal(result.body.code, code, JSON.stringify(override).slice(0, 120));
    }
    assert.equal(rows(db, 'vocabulary_captures').length, 0);
    const badJson = await worker.fetch(new Request('https://sync.example/captures', {
        method: 'POST', headers: { Origin: ORIGIN, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{oops'
    }), env);
    assert.equal(badJson.status, 400);
    assert.equal((await badJson.json()).code, 'bad_json');
    const otherOrigin = await worker.fetch(new Request('https://sync.example/captures', {
        method: 'POST', headers: { Origin: 'https://evil.example', Authorization: `Bearer ${token}` }, body: JSON.stringify(input())
    }), env);
    assert.equal(otherOrigin.status, 403, 'CORS 白名單在收藏前生效');
});

test('超量 body 走 413；巨大釋義不會落庫', async (t) => {
    const { db, call, userId } = setup(t);
    const result = await call('/captures', input({ meaning: 'x'.repeat(200000) }));
    assert.equal(result.status, 413);
    assert.equal(result.body.code, 'payload_too_large');
    assert.equal(rows(db, 'vocabulary_captures').length, 0);
    assert.equal(entryCount(db, userId), 0);
    assert.equal((await call('/captures', input({ meaning: 'x'.repeat(5000) }))).status, 400);
});

test('錨點驗證：只接受安全整數與 start ≤ end，壞錨點在寫入前就 400', async (t) => {
    const { db, call, userId } = setup(t);
    const bad = [
        [{ start: 1.5, end: 4 }, '小數'],
        [{ start: 2, end: 1 }, 'end 小於 start'],
        [{ start: '4', end: 6 }, '字串型別'],
        [{ start: Number.MAX_SAFE_INTEGER + 2, end: 6 }, '超過安全整數'],
        [{ start: -2, end: 4 }, '小於 -1']
    ];
    for (const [anchor, label] of bad) {
        const result = await call('/captures', input({ source: { ...input().source, anchor: { ...input().source.anchor, ...anchor } } }));
        assert.equal(result.status, 400, `${label} 必須拒絕：${JSON.stringify(result.body)}`);
        assert.equal(result.body.code, 'capture_invalid_input', label);
    }
    assert.equal(rows(db, 'vocabulary_captures').length, 0, '壞錨點不得留下回執');
    assert.equal(entryCount(db, userId), 0, '壞錨點不得留下詞條');

    // NaN／Infinity 會在 JSON 傳輸時變成 null，必須在協議層直接擋下（本機送出前就驗證）。
    for (const anchor of [{ start: NaN, end: 4 }, { start: 4, end: Infinity }, { start: 0.5, end: 4 }]) {
        assert.throws(() => validateCapture(input({ source: { ...input().source, anchor } })), { code: 'capture_invalid_input' },
            `協議層必須拒絕 ${JSON.stringify(anchor)}`);
    }

    const missing = await call('/captures', input({ source: { ...input().source, anchor: undefined } }));
    assert.equal(missing.status, 200, '沒有錨點時用 quote 補預設位置');
    const saved = JSON.parse(entryRow(db, missing.body.entryId, userId).data_json);
    assert.deepEqual(saved.sources[0].anchor, { start: -1, end: -1, quote: 'plunge', prefix: '', suffix: '' });
});

test('帳戶隔離：同 requestId 各自回執、他人詞書 404、cursor 與 changes 互不可見', async (t) => {
    const [bobId, bobToken] = ['bob-iso', 'bob-token-iso'];
    const { db, call, userId } = setup(t, { extraUsers: [[bobId, bobToken]] });
    entity(db, bobId, 'vocabularyBook', 'bob-book', { name: '生詞本' });
    const alice = await call('/captures', input());
    const bob = await call('/captures', input({ bookId: 'bob-book', word: 'rise', meaning: '上升' }), bobToken);
    assert.equal(alice.status, 200);
    assert.equal(bob.status, 200);
    assert.notEqual(alice.body.entryId, bob.body.entryId);
    assert.equal(rows(db, 'vocabulary_captures').length, 2, '同 requestId 不同帳戶各自一筆回執');
    assert.equal(entryCount(db, userId), 1);
    assert.equal(entryCount(db, bobId), 1);

    assert.equal((await call('/captures', input({ requestId: 'cross-1' }), bobToken)).status, 404, '不得寫進他人詞書');
    assert.equal((await call('/captures', input({ bookId: 'bob-book' }), bobToken)).status, 409, '他人的 requestId 不可被解讀成自己的回執');
    const aliceChanges = await call('/reading/changes?cursor=0');
    const bobChanges = await call('/reading/changes?cursor=0', undefined, bobToken);
    assert.deepEqual(aliceChanges.body.changes.map((c) => c.entityId), [alice.body.entryId]);
    assert.deepEqual(bobChanges.body.changes.map((c) => c.entityId), [bob.body.entryId]);
    assert.equal((await call('/reading/capabilities', undefined, bobToken)).body.cursor, 1);
});

// ── 8. migration 冪等 ───────────────────────────────────────────────────────

test('migration 007 可重複套用，且套用後才能在真 SQLite 完成收藏', async (t) => {
    userSeq += 1;
    const userId = `mig${userSeq}`;
    const token = `migration-token-${userSeq}`;
    const db = new DatabaseSync(':memory:');
    db.exec(schemaSql());
    db.exec('DROP TABLE vocabulary_captures', '舊庫沒有 007 的表');
    db.exec(readFileSync(new URL('cloudflare-worker/migrations/007_vocabulary_captures.sql', root), 'utf8'));
    db.exec(readFileSync(new URL('cloudflare-worker/migrations/007_vocabulary_captures.sql', root), 'utf8'));
    db.exec(readFileSync(new URL('selfhost/migrations/003_vocabulary_captures.sql', root), 'utf8'));
    db.prepare('INSERT INTO users(token_hash,user_id,role) VALUES(?,?,?)')
        .run(createHash('sha256').update(token).digest('hex'), userId, 'user');
    entity(db, userId, 'vocabularyBook', 'book', { name: '单词本' });
    const env = { DB: createD1Adapter(createSqliteDatabase(db)), ALLOWED_ORIGINS: ORIGIN };
    t.after(() => db.close());
    const result = await call(env, '/captures', input(), token);
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal(db.prepare('SELECT count(*) c FROM vocabulary_captures').get().c, 1);
    const columns = db.prepare('PRAGMA table_info(vocabulary_captures)').all().map((column) => column.name);
    assert.deepEqual(columns, ['owner_user_id', 'request_id', 'fingerprint', 'result_json', 'created_at']);
});

test('自建 schema.sql 與 migration 的 vocabulary_captures 定義一致', () => {
    const normalize = (sql) => sql.replace(/--[^\n]*/g, '')
        .match(/CREATE TABLE IF NOT EXISTS vocabulary_captures[\s\S]*?\);/)[0]
        .replace(/\s+/g, ' ').trim();
    const worker = normalize(schemaSql());
    const selfhost = normalize(schemaSql('selfhost/schema.sql'));
    const migration = normalize(readFileSync(new URL('cloudflare-worker/migrations/007_vocabulary_captures.sql', root), 'utf8'));
    const selfhostMigration = normalize(readFileSync(new URL('selfhost/migrations/003_vocabulary_captures.sql', root), 'utf8'));
    assert.equal(worker, migration);
    assert.equal(selfhost, selfhostMigration);
    assert.equal(worker, selfhost);
});

// ── 9. selfhost 真實 HTTP（同一份 handler 在自建服務上的接線）────────────────

test('selfhost 自建服務：同一份收藏 handler 走真 HTTP 也能完成收藏', async (t) => {
    userSeq += 1;
    const userId = `self${userSeq}`;
    const token = `selfhost-token-${userSeq}-${'y'.repeat(20)}`;
    const dir = mkdtempSync(join(tmpdir(), 'bdc-selfhost-'));
    const file = join(dir, 'sync.sqlite');
    const db = new DatabaseSync(file);
    db.exec(schemaSql('selfhost/schema.sql'));
    db.prepare('INSERT INTO users(token_hash,user_id,role) VALUES(?,?,?)')
        .run(createHash('sha256').update(token).digest('hex'), userId, 'user');
    entity(db, userId, 'vocabularyBook', 'book', { name: '单词本' });
    db.close();

    const child = spawn(process.execPath, [fileURLToPath(new URL('selfhost/server.mjs', root))], {
        env: { ...process.env, SQLITE_PATH: file, PORT: '0', HOST: '127.0.0.1', DB_DRIVER: 'sqlite', ALLOWED_ORIGINS: ORIGIN },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let log = '';
    const port = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`selfhost 未啟動：${log.slice(-400)}`)), 15000);
        child.stdout.on('data', (chunk) => {
            log += String(chunk);
            const match = log.match(/listening on http:\/\/[^:]+:(\d+)/);
            if (match) { clearTimeout(timer); resolve(Number(match[1])); }
        });
        child.stderr.on('data', (chunk) => { log += String(chunk); });
        child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`selfhost 結束（${code}）：${log.slice(-400)}`)); });
    });
    t.after(async () => {
        child.kill('SIGTERM');
        await new Promise((resolve) => child.once('exit', resolve));
        rmSync(dir, { recursive: true, force: true });
    });

    const base = `http://127.0.0.1:${port}`;
    const post = async (body, headers = {}) => {
        const response = await fetch(base + '/captures', {
            method: 'POST',
            headers: { Origin: ORIGIN, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify(body)
        });
        return { status: response.status, body: await response.json().catch(() => null) };
    };
    const books = await fetch(base + '/vocabulary/books', { headers: { Origin: ORIGIN, Authorization: `Bearer ${token}` } });
    assert.equal(books.status, 200);
    const bookList = await books.json();
    assert.deepEqual(bookList.books.map((book) => book.id), ['book']);
    assert.equal(bookList.defaultBookId, '', 'selfhost 與 Worker 共用同一份「沒有明確預設」語意');

    const created = await post(input());
    assert.equal(created.status, 200, JSON.stringify(created));
    assert.equal(created.body.sourceAdded, true);
    const replay = await post(input());
    assert.deepEqual(replay.body, created.body, 'selfhost 走的是同一份重播規則');
    assert.equal((await post(input(), { Authorization: '' })).status, 401);
    assert.equal((await post(input(), { Origin: 'https://evil.example' })).status, 403);
    const changes = await fetch(base + '/reading/changes?cursor=0', { headers: { Origin: ORIGIN, Authorization: `Bearer ${token}` } });
    const payload = await changes.json();
    assert.deepEqual(payload.changes.map((c) => c.entityId), [created.body.entryId]);

    const reopen = new DatabaseSync(file, { readOnly: true });
    t.after(() => reopen.close());
    const rowsStored = reopen.prepare("SELECT revision, data_json FROM reading_entities WHERE entity_type='vocabularyEntry'").all();
    assert.equal(rowsStored.length, 1);
    assert.equal(rowsStored[0].revision, 1, '重播不得推進 revision');
    assert.equal(JSON.parse(rowsStored[0].data_json).sources.length, 1);
});
