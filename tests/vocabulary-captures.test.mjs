import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import worker from '../cloudflare-worker/src/worker.js';
import { createD1Adapter, createSqliteDatabase } from '../selfhost/d1-adapter.js';
import { normalizeReadingPatch, patchSize, validateReadingMutation } from '../shared/reading-protocol.mjs';

const token = 'c'.repeat(43);
const root = new URL('..', import.meta.url);

function setup(t) {
    const db = new DatabaseSync(':memory:');
    db.exec(readFileSync(new URL('cloudflare-worker/schema.sql', root), 'utf8'));
    for (const [user, key] of [['alice', token], ['bob', 'b'.repeat(43)]]) {
        db.prepare('INSERT INTO users(token_hash,user_id,role) VALUES(?,?,?)')
            .run(createHash('sha256').update(key).digest('hex'), user, 'user');
    }
    const env = { DB: createD1Adapter(createSqliteDatabase(db)), ALLOWED_ORIGINS: 'chrome-extension://probe' };
    t.after(() => db.close());
    function entity(type, id, data, owner = 'alice', revision = 1, deleted = null) {
        db.prepare('INSERT OR REPLACE INTO reading_entities VALUES(?,?,?,?,?,?,?,?)')
            .run(owner, type, id, revision, deleted, JSON.stringify(data), '2026-11-01T00:00:00Z', 'seed');
    }
    entity('vocabularyBook', 'book', { name: '单词本' });
    return { db, env, entity };
}

function input(overrides = {}) {
    return { requestId: 'request-1', bookId: 'book', word: 'plunge', meaning: '暴跌', phonetic: 'plʌndʒ', pos: 'verb',
        source: { sourceUrl: 'https://news.example/article?edition=hk#headline', pageTitle: 'Stocks plunge', sentence: 'Major tech stocks plunge.', context: 'Major tech stocks plunge. Markets are volatile.', locale: 'zh-HK', anchor: { start: 18, end: 24, quote: 'plunge' } },
        ...overrides };
}

async function call(env, path = '/captures', body, options = {}) {
    const headers = { Origin: 'chrome-extension://probe', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...options.headers };
    const response = await worker.fetch(new Request('https://sync.example' + path, {
        method: body === undefined ? 'GET' : 'POST', headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }), env);
    return { status: response.status, body: await response.json() };
}

function rows(db, table, where = '') {
    return db.prepare(`SELECT * FROM ${table} ${where}`).all();
}

function entry(db, id) {
    const row = db.prepare("SELECT * FROM reading_entities WHERE owner_user_id='alice' AND entity_type='vocabularyEntry' AND entity_id=?").get(id);
    return row ? { ...JSON.parse(row.data_json), revision: row.revision, deleted: row.deleted_at } : null;
}

test('詞書列表按帳戶隔離、排除墓碑，不以名稱猜測預設', async (t) => {
    const { env, entity } = setup(t);
    entity('vocabularyBook', 'foreign', { name: 'Bob' }, 'bob');
    entity('vocabularyBook', 'removed', { name: 'Removed' }, 'alice', 2, '2026-11-02');
    const result = await call(env, '/vocabulary/books');
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { books: [{ id: 'book', name: '单词本', revision: 1, sourceUrl: '', articleId: '' }], defaultBookId: '', pageBookId: '', articleId: '' });
});

test('收藏回執、詞條、來源及 reading cursor 一起提交；不改快照', async (t) => {
    const { db, env } = setup(t);
    db.prepare('INSERT INTO snapshots(user_id,version,payload) VALUES(?,?,?)').run('alice', 7, '{"qa":{"sets":[]}}');
    const result = await call(env, '/captures', input());
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal(result.body.sourceAdded, true);
    assert.equal(result.body.duplicate, false);
    const saved = entry(db, result.body.entryId);
    assert.equal(saved.meaning, '暴跌');
    assert.equal(saved.sources[0].sourceUrl, input().source.sourceUrl);
    assert.equal(saved.sources[0].meaning, '暴跌');
    assert.equal(saved.sources[0].pageTitle, 'Stocks plunge');
    assert.equal(rows(db, 'vocabulary_captures').length, 1);
    assert.equal(rows(db, 'reading_changes').length, 1);
    assert.equal(rows(db, 'reading_state')[0].next_seq, 2);
    assert.equal(rows(db, 'snapshots')[0].version, 7);
    const wire = await call(env, '/reading/batch', { keys: [{ entityType: 'vocabularyEntry', entityId: result.body.entryId }] });
    assert.equal(wire.body.entities[0].sources[0].sourceUrl, input().source.sourceUrl);
});

test('同詞新來源追加，保留使用者的意思及音標', async (t) => {
    const { db, env, entity } = setup(t);
    entity('vocabularyEntry', 'user-entry', { bookId: 'book', word: 'Plunge', meaning: '我的筆記', phonetic: 'custom', note: 'not in contract', sources: [] });
    const first = await call(env, '/captures', input());
    const second = await call(env, '/captures', input({ requestId: 'request-2', source: { ...input().source, sourceUrl: 'https://other.example/a' } }));
    assert.equal(first.body.entryId, 'user-entry');
    assert.equal(second.body.duplicate, true);
    const saved = entry(db, 'user-entry');
    assert.equal(saved.sources.length, 2);
    assert.equal(saved.meaning, '我的筆記');
    assert.equal(saved.phonetic, 'custom');
    assert.equal(saved.sources[1].meaning, '暴跌');
});

test('同 URL／位置／原句的來源去重；再點收藏不推進 revision', async (t) => {
    const { db, env } = setup(t);
    const first = await call(env, '/captures', input());
    const second = await call(env, '/captures', input({ requestId: 'request-2', word: 'PLUNGE' }));
    assert.equal(second.body.entryId, first.body.entryId);
    assert.equal(second.body.sourceAdded, false);
    assert.equal(second.body.revision, first.body.revision);
    assert.equal(entry(db, first.body.entryId).sources.length, 1);
    assert.equal(rows(db, 'reading_changes').length, 1);
});

test('相同 requestId 回應遺失重送，逐欄回原回執；刪除後不復活', async (t) => {
    const { db, env } = setup(t);
    const first = await call(env, '/captures', input());
    db.prepare('UPDATE reading_entities SET deleted_at=?, revision=revision+1 WHERE entity_id=?').run('2026-11-06', first.body.entryId);
    const replay = await call(env, '/captures', input());
    assert.deepEqual(replay, first);
    assert.equal(entry(db, first.body.entryId).deleted, '2026-11-06');
    assert.equal(rows(db, 'reading_changes').length, 1);
});

test('相同 requestId 改內容衝突，不新增其他詞條', async (t) => {
    const { db, env } = setup(t);
    await call(env, '/captures', input());
    const result = await call(env, '/captures', input({ word: 'rise' }));
    assert.equal(result.status, 409);
    assert.equal(result.body.code, 'capture_request_mismatch');
    assert.equal(rows(db, 'reading_entities', "WHERE entity_type='vocabularyEntry'").length, 1);
});

test('同一原句同一錨點的新釋義另存來源，保留詞條既有意思', async (t) => {
    const { db, env } = setup(t);
    const first = await call(env, '/captures', input());
    const second = await call(env, '/captures', input({ requestId: 'another-sense', meaning: '突然下降' }));
    assert.equal(second.body.sourceAdded, true);
    const saved = entry(db, first.body.entryId);
    assert.equal(saved.meaning, '暴跌');
    assert.deepEqual(saved.sources.map((source) => source.meaning), ['暴跌', '突然下降']);
});

test('目標詞書不存在／已刪除／屬其他帳戶均拒絕，無回執', async (t) => {
    const { db, env, entity } = setup(t);
    entity('vocabularyBook', 'foreign', { name: 'Bob' }, 'bob');
    entity('vocabularyBook', 'removed', { name: 'Removed' }, 'alice', 2, '2026-11-02');
    for (const bookId of ['missing', 'removed', 'foreign']) {
        assert.equal((await call(env, '/captures', input({ bookId }))).status, 404);
    }
    assert.equal(rows(db, 'vocabulary_captures').length, 0);
});

test('讀取後詞書被刪除，原子條件阻止收藏', async (t) => {
    const { db, env } = setup(t);
    const original = env.DB.batch;
    let once = false;
    env.DB.batch = async (statements) => {
        if (!once) {
            once = true;
            db.exec("UPDATE reading_entities SET deleted_at='2026-11-06',revision=revision+1 WHERE entity_type='vocabularyBook'");
        }
        return original(statements);
    };
    const result = await call(env, '/captures', input());
    assert.equal(result.status, 404);
    assert.equal(rows(db, 'vocabulary_captures').length, 0);
    assert.equal(rows(db, 'reading_entities', "WHERE entity_type='vocabularyEntry'").length, 0);
});

test('兩個並發 requestId 同詞不同來源，只建一個詞條且來源皆保留', async (t) => {
    const { db, env } = setup(t);
    const results = await Promise.all([
        call(env, '/captures', input()),
        call(env, '/captures', input({ requestId: 'request-2', source: { ...input().source, sourceUrl: 'https://second.example/' } }))
    ]);
    assert.ok(results.every((r) => r.status === 200), JSON.stringify(results));
    assert.equal(results[0].body.entryId, results[1].body.entryId);
    assert.equal(entry(db, results[0].body.entryId).sources.length, 2);
    assert.equal(rows(db, 'reading_changes').length, 2);
});

test('並發相同 requestId 不同 payload，只有一個成功', async (t) => {
    const { db, env } = setup(t);
    const results = await Promise.all([call(env, '/captures', input()), call(env, '/captures', input({ word: 'rise' }))]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.equal(rows(db, 'vocabulary_captures').length, 1);
    assert.equal(rows(db, 'reading_changes').length, 1);
});

test('變更紀錄寫入失敗時，詞條與回執全部回滾', async (t) => {
    const { db, env } = setup(t);
    db.exec("CREATE TRIGGER deny_capture BEFORE INSERT ON reading_changes BEGIN SELECT RAISE(ABORT,'test rollback'); END");
    const result = await call(env, '/captures', input());
    assert.equal(result.status, 500);
    assert.equal(rows(db, 'vocabulary_captures').length, 0);
    assert.equal(rows(db, 'reading_entities', "WHERE entity_type='vocabularyEntry'").length, 0);
    assert.equal(rows(db, 'reading_state')[0].next_seq, 1);
});

test('來源達上限時明確拒絕新來源，現有來源重送仍成功', async (t) => {
    const { db, env, entity } = setup(t);
    const sources = Array.from({ length: 100 }, (_, i) => ({ sourceUrl: `https://example.com/${i}`, sentence: 'Existing', meaning: '暴跌', anchor: { start: -1, end: -1, quote: 'plunge' } }));
    entity('vocabularyEntry', 'full', { bookId: 'book', word: 'plunge', meaning: 'Keep', phonetic: 'custom', pos: 'verb', sources });
    assert.equal((await call(env, '/captures', input())).status, 422);
    const replaySource = await call(env, '/captures', input({ requestId: 'existing-source', source: sources[0] }));
    assert.equal(replaySource.status, 200);
    assert.equal(replaySource.body.sourceAdded, false);
    assert.equal(entry(db, 'full').sources.length, 100);
});

test('雜湊 ID 的原詞條已被使用者改字或搬書時，另建詞條並保留編輯', async (t) => {
    const { db, env } = setup(t);
    const first = await call(env, '/captures', input());
    const edited = { ...entry(db, first.body.entryId), word: 'fall', meaning: 'User edit' };
    db.prepare('UPDATE reading_entities SET data_json=?,revision=revision+1 WHERE entity_id=?').run(JSON.stringify(edited), first.body.entryId);
    const second = await call(env, '/captures', input({ requestId: 'request-2' }));
    assert.equal(second.status, 200);
    assert.notEqual(second.body.entryId, first.body.entryId);
    assert.equal(entry(db, first.body.entryId).word, 'fall');
    assert.equal(entry(db, first.body.entryId).meaning, 'User edit');
});

test('不同詞書各自收藏，無網址手動查詞可保存', async (t) => {
    const { db, env, entity } = setup(t);
    entity('vocabularyBook', 'book-2', { name: 'Another' });
    const a = await call(env, '/captures', input({ source: undefined }));
    const b = await call(env, '/captures', input({ requestId: 'request-2', bookId: 'book-2', source: undefined }));
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.notEqual(a.body.entryId, b.body.entryId);
    assert.deepEqual(entry(db, a.body.entryId).sources, []);
});

test('來源白名單保留網址／標題／當次意思，阻擋非 HTTP 連結', () => {
    const patch = normalizeReadingPatch('vocabularyEntry', { sources: [{ ...input().source, meaning: '暴跌', addedAt: '2026-11-06', privateField: 'ignored' }] });
    assert.equal(patch.sources[0].pageTitle, 'Stocks plunge');
    assert.equal(patch.sources[0].meaning, '暴跌');
    assert.equal(patch.sources[0].privateField, undefined);
    assert.equal(normalizeReadingPatch('vocabularyEntry', { sources: [{ sourceUrl: 'javascript:alert(1)' }] }).sources[0].sourceUrl, '');
});

test('來源表示不靜默裁切，逐項寫入明確拒絕第101筆', () => {
    const sources = Array.from({ length: 101 }, (_, i) => ({ sourceUrl: `https://example.com/${i}`, meaning: 'Keep' }));
    assert.equal(normalizeReadingPatch('vocabularyEntry', { sources }).sources.length, 101);
    const result = validateReadingMutation({ mutationId: 'overflow', entityId: 'entry', entityType: 'vocabularyEntry', op: 'upsert', expectedRevision: 1, patch: { sources } });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'vocabulary_sources_full');
});

test('累積內容超過逐項同步1MB上限時原子拒絕，不建立無法同步的詞條', async (t) => {
    const { db, env, entity } = setup(t);
    const source = { sourceUrl: 'https://limit.example/', sentence: 'a'.repeat(100), context: 'a'.repeat(8000), meaning: 'a'.repeat(4000), anchor: { start: -1, end: -1, quote: 'plunge' } };
    const sources = Array.from({ length: 85 }, (_, i) => ({ ...source, sourceUrl: `https://limit.example/${i}` }));
    const existing = normalizeReadingPatch('vocabularyEntry', { bookId: 'book', word: 'plunge', meaning: 'Keep', sources });
    assert.ok(patchSize(existing) < 1024 * 1024);
    entity('vocabularyEntry', 'large', existing);
    const result = await call(env, '/captures', input({ meaning: source.meaning, source: { ...source, sourceUrl: 'https://limit.example/new' } }));
    assert.equal(result.status, 422);
    assert.equal(result.body.code, 'capture_entry_too_large');
    assert.equal(entry(db, 'large').sources.length, 85);
    assert.equal(rows(db, 'vocabulary_captures').length, 0);
});

test('認證、來源、輸入與大小檢查在收藏前生效', async (t) => {
    const { db, env } = setup(t);
    assert.equal((await call(env, '/captures', input(), { headers: { Authorization: '' } })).status, 401);
    assert.equal((await call(env, '/captures', input(), { headers: { Origin: 'https://evil.example' } })).status, 403);
    for (const sourceUrl of ['javascript:alert(1)', 'https://user:password@example.com/', 'file:///tmp/page']) {
        const result = await call(env, '/captures', input({ source: { sourceUrl } }));
        assert.equal(result.status, 400);
        assert.equal(result.body.code, 'capture_invalid_url');
    }
    assert.equal((await call(env, '/captures', input({ meaning: '' }))).status, 400);
    assert.equal((await call(env, '/captures', input({ word: 'a'.repeat(401) }))).status, 400);
    assert.equal(rows(db, 'vocabulary_captures').length, 0);
});
