// 大量閱讀筆記使用真實 Worker／SQLite 路由，限制每次請求的 D1 呼叫數與
// UTF-8 body 大小；瀏覽器端仍使用真正 reading-store + outbox。
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import worker from '../cloudflare-worker/src/worker.js';
import { createD1Adapter, createSqliteDatabase } from '../selfhost/d1-adapter.js';
import { createFakeIndexedDB } from './helpers/fake-indexeddb.mjs';
import { READING_LIMITS } from '../shared/reading-protocol.mjs';

const storage = new Map();
globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
    key: (index) => [...storage.keys()][index] || null,
    get length() { return storage.size; }
};
globalThis.window = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
globalThis.document = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, hidden: false };
globalThis.CustomEvent = class {
    constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
};
globalThis.Audio = class {
    play() { return Promise.resolve(); }
    pause() {}
    addEventListener() {}
    removeEventListener() {}
};
globalThis.indexedDB = createFakeIndexedDB();
globalThis.__BDC_SYNC_ENDPOINT__ = 'https://worker.mock';

const articles = await import('../modules/article-store.js');
const reading = await import('../modules/reading-store.js');
const { syncReading } = await import('../modules/reading-sync.js');
const TOKEN = 'reading-batching-token'.repeat(2);

function json(body, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function fixture(name, { maxQueries = Infinity } = {}) {
    const db = new DatabaseSync(':memory:');
    db.exec(readFileSync(new URL('../cloudflare-worker/schema.sql', import.meta.url), 'utf8'));
    db.prepare('INSERT INTO users (token_hash, user_id, label, role) VALUES (?, ?, ?, ?)')
        .run(createHash('sha256').update(TOKEN).digest('hex'), name, name, 'user');
    const adapter = createD1Adapter(createSqliteDatabase(db));
    const requests = [];
    const failures = [];
    const scope = `https://worker.mock::${name}`;
    let unavailable = false;
    globalThis.fetch = async (url, options = {}) => {
        const path = new URL(url).pathname;
        const record = { path, bytes: Buffer.byteLength(options.body || ''), queries: 0 };
        requests.push(record);
        if (record.bytes > READING_LIMITS.requestMaxBytes) return json({ code: 'payload_too_large' }, 413);
        if (unavailable && path === '/reading/mutations') return json({ code: 'temporary_failure' }, 503);
        const count = () => {
            record.queries += 1;
            if (record.queries > maxQueries) throw new Error('Too many API requests by single Worker invocation');
        };
        const limitedDb = {
            prepare(sql) {
                const statement = adapter.prepare(sql);
                const wrapped = {
                    bind(...values) { statement.bind(...values); return wrapped; },
                    async first() { count(); return statement.first(); },
                    async all() { count(); return statement.all(); },
                    async run() { count(); return statement.run(); }
                };
                return wrapped;
            },
            // D1 的每個 batch 計一次 API 呼叫，交易中的 SQL 不另計。
            async batch(statements) { count(); return adapter.batch(statements); }
        };
        // batch 需要原始 D1 statement 的 SQL 與參數；保留它們供 adapter 使用。
        const prepare = limitedDb.prepare;
        limitedDb.prepare = (sql) => {
            const wrapped = prepare(sql);
            wrapped.__sql = sql;
            wrapped.__args = [];
            const bind = wrapped.bind;
            wrapped.bind = (...values) => { wrapped.__args = values; return bind(...values); };
            return wrapped;
        };
        try {
            return await worker.fetch(new Request(url, options), { DB: limitedDb, ALLOWED_ORIGINS: '*' });
        } catch (error) {
            failures.push(error.message);
            return json({ code: 'internal_error' }, 500);
        }
    };
    localStorage.setItem('sync_token', TOKEN);
    localStorage.setItem('sync_user_id', name);
    await articles.reloadScope(scope);
    await reading.initReadingStore(scope);
    const saved = await articles.saveArticle({ articleId: 'batch-article', article: 'Reading notes', title: name });
    assert.equal(saved.ok, true);
    return { db, requests, failures, setUnavailable: (value) => { unavailable = value; } };
}

async function seedNotes(count) {
    for (let index = 0; index < count; index += 1) {
        const result = await reading.upsertLearningItem({
            articleId: 'batch-article',
            kind: 'word',
            anchor: { start: index * 5, end: index * 5 + 4, quote: `word${index}` },
            note: `第 ${index + 1} 則閱讀筆記`
        });
        assert.equal(result.ok, true);
    }
}

test('100 則筆記在每次請求最多 50 次 D1 呼叫下全部同步，重試不重複寫入', async () => {
    const f = await fixture('many-notes', { maxQueries: 50 });
    try {
        await seedNotes(100);
        const result = await syncReading();
        assert.equal(result.pending, 0, JSON.stringify({ result, failures: f.failures }));
        assert.equal(result.failed, 0);
        assert.equal(f.failures.length, 0);
        assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM reading_entities').get().n, 100);
        assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM reading_changes').get().n, 100);
        assert.ok(f.requests.every((request) => request.queries <= 50));
        const repeat = await syncReading();
        assert.equal(repeat.pending, 0);
        assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM reading_changes').get().n, 100);
    } finally { f.db.close(); }
});

test('多份大型中文筆記按 UTF-8 大小拆批，不超出 4 MiB 請求上限', async () => {
    const f = await fixture('large-notes');
    try {
        for (let index = 0; index < 10; index += 1) {
            const result = await reading.saveArticleDocument({
                articleId: 'batch-article', kind: 'note', title: `筆記 ${index}`,
                content: '閱讀筆記'.repeat(50000)
            });
            assert.equal(result.ok, true);
        }
        const result = await syncReading();
        assert.equal(result.pending, 0, JSON.stringify(result));
        assert.equal(result.failed, 0);
        assert.ok(f.requests.every((request) => request.bytes <= READING_LIMITS.requestMaxBytes));
        const rows = f.db.prepare('SELECT data_json FROM reading_entities').all();
        assert.equal(rows.length, 10);
        assert.ok(rows.every((row) => JSON.parse(row.data_json).content === '閱讀筆記'.repeat(50000)));
    } finally { f.db.close(); }
});

test('服務暫時失敗保留本機筆記、outbox 與錯誤，恢復後可補送', async () => {
    const f = await fixture('retry-notes');
    try {
        await seedNotes(3);
        f.setUnavailable(true);
        const failed = await syncReading();
        assert.equal(failed.ok, false, JSON.stringify(failed));
        assert.equal(failed.pending, 3);
        assert.equal((await reading.listOutbox()).length, 3);
        assert.equal(reading.getReadingMeta().lastError, 'temporary_failure');
        assert.equal(reading.listLearningItems('batch-article').length, 3);
        f.setUnavailable(false);
        const success = await syncReading();
        assert.equal(success.ok, true);
        assert.equal(success.pending, 0);
        assert.equal(reading.getReadingMeta().lastError, '');
        assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM reading_entities').get().n, 3);
    } finally { f.db.close(); }
});
