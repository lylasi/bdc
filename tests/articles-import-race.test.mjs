// /articles/import 併發競態：預讀後別的請求先插入相同 ID／legacy ID 時，
// 必須重新讀取並安全重試，不能整批回滾或產生對不上的 change log。
//
// Usage: node --test --test-timeout=180000 tests/articles-import-race.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import worker from '../cloudflare-worker/src/worker.js';
import { createD1Adapter, createSqliteDatabase, readResponseBody } from '../selfhost/d1-adapter.js';
import { ARTICLE_ERRORS, ARTICLE_LIMITS } from '../shared/article-protocol.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const ALICE = 'r'.repeat(40);

function makeEnv() {
    const raw = new DatabaseSync(':memory:');
    raw.exec(readFileSync(ROOT + 'cloudflare-worker/schema.sql', 'utf8'));
    raw.prepare('INSERT INTO users (token_hash,user_id,label,role) VALUES (?,?,?,?)')
        .run(createHash('sha256').update(ALICE).digest('hex'), 'alice', 'Alice', 'user');
    const sqlite = createSqliteDatabase(raw);
    const adapter = createD1Adapter(sqlite);
    return { raw, sqlite, adapter, env: { DB: adapter, ALLOWED_ORIGINS: '*' } };
}

function call(env, path, body) {
    return worker.fetch(new Request('https://sync.example' + path, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ALICE}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    }), env).then(async (response) => ({ status: response.status, body: await readResponseBody(response) }));
}

function article(id, prefix, legacyId = id) {
    return {
        legacyId,
        title: `${prefix}-${id}`,
        body: `${prefix} body ${id}`,
        analysis: { chinese_translation: `${prefix}-${id}` },
        sourceType: 'url',
        sourceUrl: `https://example.com/${prefix}-${id}`
    };
}

function seedArticles(raw, count, { size = 10, prefix = 'seed' } = {}) {
    const insert = raw.prepare('INSERT INTO articles '
        + '(owner_user_id, id, title, body, analysis_json, source_type, source_url, revision, created_at, updated_at, deleted_at, legacy_article_id, last_mutation_id, size_bytes) '
        + 'VALUES (?, ?, ?, ?, NULL, ?, NULL, 1, ?, ?, NULL, NULL, NULL, ?)');
    const at = new Date().toISOString();
    raw.exec('BEGIN');
    try {
        for (let index = 0; index < count; index += 1) {
            const id = `${prefix}-${index}`;
            insert.run('alice', id, id, `body ${id}`, 'paste', at, at, size);
        }
        raw.exec('COMMIT');
    } catch (error) {
        try { raw.exec('ROLLBACK'); } catch (_) {}
        throw error;
    }
}

test('兩請求屏障：預讀後先插入的內容不被覆寫，change 與計數對應實際寫入', async () => {
    const { raw, sqlite, adapter, env } = makeEnv();
    try {
        const originalAll = sqlite.all;
        const originalBatch = adapter.batch;
        let preReads = 0;
        let releaseBarrier;
        const barrier = new Promise((resolve) => { releaseBarrier = resolve; });
        sqlite.all = async (sql, params) => {
            const result = await originalAll(sql, params);
            if (/^SELECT (id|legacy_article_id) FROM articles WHERE owner_user_id = \?/.test(sql)) {
                preReads += 1;
                if (preReads === 4) releaseBarrier();
                await barrier;
            }
            return result;
        };
        const originalGet = sqlite.get;
        let releaseUsage;
        const usageBarrier = new Promise((resolve) => { releaseUsage = resolve; });
        let usageReads = 0;
        sqlite.get = async (sql, params) => {
            const row = await originalGet(sql, params);
            if (/COUNT\(\*\) AS article_count/.test(sql)) {
                usageReads += 1;
                if (usageReads === 2) releaseUsage();
                await usageBarrier;
            }
            return row;
        };
        let releaseABatch;
        const aBatchDone = new Promise((resolve) => { releaseABatch = resolve; });
        const commitOrder = [];
        adapter.batch = async (statements) => {
            // adapter 傳給 selfhost batch 的是 D1 statement 物件，綁定值在
            // __args；用 params 會讓屏障永遠看不到 A/B 而失效。
            const paramsText = JSON.stringify(statements.map((statement) => statement.__args || []));
            const isA = paramsText.includes('A-') && !paramsText.includes('B-');
            const isB = paramsText.includes('B-');
            if (isB) await aBatchDone;
            const result = await originalBatch(statements);
            if (isA) { commitOrder.push('A'); releaseABatch(); }
            if (isB) commitOrder.push('B');
            return result;
        };

        const aItems = Array.from({ length: 8 }, (_, index) => article(`race-${index}`, 'A'));
        const bItems = Array.from({ length: 16 }, (_, index) => article(`race-${index}`, 'B'));
        const [aResponse, bResponse] = await Promise.all([
            call(env, '/articles/import', { articles: aItems }),
            call(env, '/articles/import', { articles: bItems })
        ]);
        assert.equal(aResponse.status, 200, JSON.stringify(aResponse.body));
        assert.equal(bResponse.status, 200, JSON.stringify(bResponse.body));
        assert.equal(aResponse.body.imported, 8, JSON.stringify(aResponse.body));
        assert.equal(bResponse.body.imported, 8, JSON.stringify(bResponse.body));
        assert.equal(bResponse.body.skipped, 8, JSON.stringify(bResponse.body));
        assert.equal(bResponse.body.ids.length, 8);
        assert.deepEqual(commitOrder, ['A', 'B'], '屏障沒有真的讓 A 先提交');

        const rows = raw.prepare('SELECT id, title, body FROM articles ORDER BY id').all();
        assert.equal(rows.length, 16);
        for (let index = 0; index < 8; index += 1) {
            const row = rows.find((item) => item.id === `race-${index}`);
            assert.equal(row.title, `A-race-${index}`, '後到的請求覆寫了先插入的內容');
            assert.equal(row.body, `A body race-${index}`);
        }

        const changes = raw.prepare('SELECT article_id, COUNT(*) AS total FROM article_changes WHERE op = ? GROUP BY article_id').all('create');
        assert.equal(changes.length, 16);
        assert.ok(changes.every((item) => Number(item.total) === 1), JSON.stringify(changes));

        const retry = await call(env, '/articles/import', { articles: bItems });
        assert.equal(retry.status, 200);
        assert.equal(retry.body.imported, 0);
        assert.equal(retry.body.skipped, 16);
        assert.equal(raw.prepare('SELECT COUNT(*) AS total FROM articles').get().total, 16);
        assert.equal(raw.prepare('SELECT COUNT(*) AS total FROM article_changes WHERE op = ?').get('create').total, 16);
    } finally {
        raw.close();
    }
});

test('legacy ID 衝突：重讀後跳過，不產生重複 create change', async () => {
    const { raw, sqlite, adapter, env } = makeEnv();
    try {
        const legacyId = 'url:https%3A%2F%2Fexample.com%2Flegacy-race';
        const bItem = article('legacy-race-b', 'B', legacyId);
        const aItem = article('legacy-race-a', 'A', legacyId);

        const originalAll = sqlite.all;
        let holdReads = true;
        let releaseRead;
        let resolveHeld;
        const readBarrier = new Promise((resolve) => { releaseRead = resolve; });
        const heldRead = new Promise((resolve) => { resolveHeld = resolve; });
        sqlite.all = async (sql, params) => {
            const result = await originalAll(sql, params);
            if (holdReads && /^SELECT legacy_article_id FROM articles WHERE owner_user_id = \?/.test(sql)) {
                holdReads = false;
                resolveHeld();
                await readBarrier;
            }
            return result;
        };

        const bPending = call(env, '/articles/import', { articles: [bItem] });
        // 等 B 的預讀完成（結果為空）後，讓 A 先插入同一個 legacy ID。
        await heldRead;
        const aResponse = await call(env, '/articles/import', { articles: [aItem] });
        assert.equal(aResponse.status, 200, JSON.stringify(aResponse.body));
        assert.equal(aResponse.body.imported, 1);
        releaseRead();
        const bResponse = await bPending;
        assert.equal(bResponse.status, 200, JSON.stringify(bResponse.body));
        assert.equal(bResponse.body.imported, 0, JSON.stringify(bResponse.body));
        assert.equal(bResponse.body.skipped, 1, JSON.stringify(bResponse.body));

        const rows = raw.prepare('SELECT id, title, body, legacy_article_id FROM articles').all();
        assert.equal(rows.length, 1);
        assert.equal(rows[0].legacy_article_id, legacyId);
        assert.equal(rows[0].title, 'A-legacy-race-a', '後到請求覆寫了 legacy ID 內容');
        assert.equal(rows[0].body, 'A body legacy-race-a');
        const changes = raw.prepare('SELECT COUNT(*) AS total FROM article_changes WHERE op = ?').get('create');
        assert.equal(Number(changes.total), 1);

        const retry = await call(env, '/articles/import', { articles: [bItem] });
        assert.equal(retry.status, 200);
        assert.equal(retry.body.imported, 0);
        assert.equal(retry.body.skipped, 1);
        assert.equal(raw.prepare('SELECT COUNT(*) AS total FROM articles').get().total, 1);
        assert.equal(Number(raw.prepare('SELECT COUNT(*) AS total FROM article_changes WHERE op = ?').get('create').total), 1);
    } finally {
        raw.close();
    }
});

test('992 篇時並行匯入不得突破 1000 篇上限；重試用量依已提交資料重算', async () => {
    const { raw, sqlite, adapter, env } = makeEnv();
    try {
        seedArticles(raw, 992);
        const originalAll = sqlite.all;
        const originalGet = sqlite.get;
        const originalBatch = adapter.batch;
        let preReads = 0;
        let releasePreReads;
        const preReadBarrier = new Promise((resolve) => { releasePreReads = resolve; });
        sqlite.all = async (sql, params) => {
            const result = await originalAll(sql, params);
            if (/^SELECT (id|legacy_article_id) FROM articles WHERE owner_user_id = \?/.test(sql)) {
                preReads += 1;
                if (preReads === 4) releasePreReads();
                await preReadBarrier;
            }
            return result;
        };
        let usageReads = 0;
        let releaseUsage;
        const usageBarrier = new Promise((resolve) => { releaseUsage = resolve; });
        sqlite.get = async (sql, params) => {
            const row = await originalGet(sql, params);
            if (/COUNT\(\*\) AS article_count/.test(sql)) {
                usageReads += 1;
                if (usageReads === 2) releaseUsage();
                await usageBarrier;
            }
            return row;
        };
        let releaseABatch;
        const aBatchDone = new Promise((resolve) => { releaseABatch = resolve; });
        const commitOrder = [];
        adapter.batch = async (statements) => {
            const paramsText = JSON.stringify(statements.map((statement) => statement.__args || []));
            const isA = paramsText.includes('A-') && !paramsText.includes('B-');
            const isB = paramsText.includes('B-');
            if (isB) await aBatchDone;
            const result = await originalBatch(statements);
            if (isA) { commitOrder.push('A'); releaseABatch(); }
            if (isB) commitOrder.push('B');
            return result;
        };

        const aItems = Array.from({ length: 8 }, (_, index) => article(`race-${index}`, 'A'));
        // B 的前 8 篇與 A 同 ID 但內容大小不同；重試跳過時不能沿用舊的暫記用量。
        const bItems = Array.from({ length: 16 }, (_, index) => {
            const item = article(`race-${index}`, 'B');
            return index < 8 ? { ...item, body: `B-large-${index}-`.repeat(40) } : item;
        });
        const [aResponse, bResponse] = await Promise.all([
            call(env, '/articles/import', { articles: aItems }),
            call(env, '/articles/import', { articles: bItems })
        ]);
        assert.deepEqual(commitOrder, ['A', 'B'], '屏障沒有真的讓 A 先提交');
        assert.equal(aResponse.status, 200, JSON.stringify(aResponse.body));
        assert.equal(aResponse.body.imported, 8, JSON.stringify(aResponse.body));
        assert.equal(bResponse.status, 409, JSON.stringify(bResponse.body));
        assert.equal(bResponse.body.code, ARTICLE_ERRORS.countExceeded, JSON.stringify(bResponse.body));
        assert.equal(bResponse.body.imported, 0, JSON.stringify(bResponse.body));
        assert.equal(bResponse.body.skipped, 8, JSON.stringify(bResponse.body));
        assert.equal(bResponse.body.ids.length, 0);

        assert.equal(raw.prepare('SELECT COUNT(*) AS total FROM articles').get().total, 1000);
        assert.equal(raw.prepare('SELECT COUNT(*) AS total FROM article_changes WHERE op = ?').get('create').total, 8);
        assert.equal(raw.prepare('SELECT next_seq FROM article_state WHERE owner_user_id = ?').get('alice').next_seq, 9);

        const beforeRetry = raw.prepare('SELECT COUNT(*) AS total FROM article_changes').get().total;
        const retry = await call(env, '/articles/import', { articles: bItems });
        assert.equal(retry.status, 409, JSON.stringify(retry.body));
        assert.equal(retry.body.code, ARTICLE_ERRORS.countExceeded, JSON.stringify(retry.body));
        assert.equal(retry.body.imported, 0);
        assert.equal(retry.body.skipped, 8);
        assert.equal(raw.prepare('SELECT COUNT(*) AS total FROM articles').get().total, 1000);
        assert.equal(raw.prepare('SELECT COUNT(*) AS total FROM article_changes').get().total, beforeRetry);
    } finally {
        raw.close();
    }
});

test('50 MiB 邊界：過期用量下仍由交易內原子配額擋下，重送冪等', async () => {
    const { raw, sqlite, env } = makeEnv();
    try {
        seedArticles(raw, 1, { size: ARTICLE_LIMITS.maxUserBytes - 100 });
        const originalGet = sqlite.get;
        let staleUsage = true;
        sqlite.get = async (sql, params) => {
            if (staleUsage && /COUNT\(\*\) AS article_count/.test(sql)) {
                staleUsage = false;
                return { article_count: 0, total_bytes: 0 };
            }
            return originalGet(sql, params);
        };
        const items = [
            { legacyId: 'quota-a', title: 'A', body: 'a'.repeat(100), analysis: null, sourceType: 'paste' },
            { legacyId: 'quota-b', title: 'B', body: 'b'.repeat(200), analysis: null, sourceType: 'paste' }
        ];
        const response = await call(env, '/articles/import', { articles: items });
        assert.equal(response.status, 409, JSON.stringify(response.body));
        assert.equal(response.body.code, ARTICLE_ERRORS.quotaExceeded, JSON.stringify(response.body));
        assert.equal(response.body.imported, 1, JSON.stringify(response.body));
        assert.deepEqual(response.body.ids, ['quota-a']);
        const rows = raw.prepare('SELECT id, size_bytes FROM articles ORDER BY id').all();
        assert.equal(rows.length, 2);
        assert.equal(Number(rows.find((row) => row.id === 'quota-a').size_bytes), 100);
        assert.equal(rows.reduce((sum, row) => sum + Number(row.size_bytes), 0), ARTICLE_LIMITS.maxUserBytes);
        assert.equal(raw.prepare('SELECT COUNT(*) AS total FROM article_changes WHERE op = ?').get('create').total, 1);
        assert.equal(raw.prepare('SELECT next_seq FROM article_state WHERE owner_user_id = ?').get('alice').next_seq, 2);

        const retry = await call(env, '/articles/import', { articles: items });
        assert.equal(retry.status, 409, JSON.stringify(retry.body));
        assert.equal(retry.body.imported, 0, JSON.stringify(retry.body));
        assert.equal(retry.body.skipped, 1, JSON.stringify(retry.body));
        assert.equal(raw.prepare('SELECT COUNT(*) AS total FROM articles').get().total, 2);
        assert.equal(raw.prepare('SELECT COUNT(*) AS total FROM article_changes').get().total, 1);
        assert.equal(raw.prepare('SELECT next_seq FROM article_state WHERE owner_user_id = ?').get('alice').next_seq, 2);
    } finally {
        raw.close();
    }
});

function callWith(env, path, { method = 'POST', body } = {}) {
    const init = {
        method,
        headers: { Authorization: `Bearer ${ALICE}`, 'Content-Type': 'application/json' }
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    return worker.fetch(new Request('https://sync.example' + path, init), env)
        .then(async (response) => ({ status: response.status, body: await readResponseBody(response) }));
}

/**
 * 建立「兩邊都讀完用量後才提交」的屏障：先讓 create 或 import 提交，再放行另一個。
 * 回傳目前提交順序，測試直接斷言屏障真的生效。
 */
function installWriteRace({ sqlite, adapter }, { first, createId, importLegacyId }) {
    const originalGet = sqlite.get;
    const originalBatch = adapter.batch;
    let usageReads = 0;
    let releaseUsage;
    const usageBarrier = new Promise((resolve) => { releaseUsage = resolve; });
    sqlite.get = async (sql, params) => {
        const row = await originalGet(sql, params);
        if (/COUNT\(\*\) AS article_count/.test(sql)) {
            usageReads += 1;
            if (usageReads >= 2) releaseUsage();
            await usageBarrier;
        }
        return row;
    };
    let releaseFirst;
    const firstDone = new Promise((resolve) => { releaseFirst = resolve; });
    const commitOrder = [];
    adapter.batch = async (statements) => {
        const text = JSON.stringify(statements.map((statement) => statement.__args || []));
        const isCreate = text.includes(createId);
        const isImport = text.includes(importLegacyId);
        if (isImport && first === 'create') await firstDone;
        if (isCreate && first === 'import') await firstDone;
        const result = await originalBatch(statements);
        if (isCreate && first === 'create') { commitOrder.push('create'); releaseFirst(); }
        if (isImport && first === 'import') { commitOrder.push('import'); releaseFirst(); }
        if (isCreate && first === 'import') commitOrder.push('create');
        if (isImport && first === 'create') commitOrder.push('import');
        return result;
    };
    return { commitOrder };
}

test('50 MiB 邊界：兩個匯入並行時只有一邊能提交', async () => {
    const { raw, sqlite, adapter, env } = makeEnv();
    try {
        seedArticles(raw, 1, { size: ARTICLE_LIMITS.maxUserBytes - 100, prefix: 'seed' });
        const originalAll = sqlite.all;
        const originalGet = sqlite.get;
        const originalBatch = adapter.batch;
        let preReads = 0;
        let releasePreReads;
        const preReadBarrier = new Promise((resolve) => { releasePreReads = resolve; });
        sqlite.all = async (sql, params) => {
            const result = await originalAll(sql, params);
            if (/^SELECT (id|legacy_article_id) FROM articles WHERE owner_user_id = \?/.test(sql)) {
                preReads += 1;
                if (preReads === 4) releasePreReads();
                await preReadBarrier;
            }
            return result;
        };
        let usageReads = 0;
        let releaseUsage;
        const usageBarrier = new Promise((resolve) => { releaseUsage = resolve; });
        sqlite.get = async (sql, params) => {
            const row = await originalGet(sql, params);
            if (/COUNT\(\*\) AS article_count/.test(sql)) {
                usageReads += 1;
                if (usageReads === 2) releaseUsage();
                await usageBarrier;
            }
            return row;
        };
        let releaseABatch;
        const aBatchDone = new Promise((resolve) => { releaseABatch = resolve; });
        const commitOrder = [];
        adapter.batch = async (statements) => {
            const text = JSON.stringify(statements.map((statement) => statement.__args || []));
            const isA = text.includes('A-') && !text.includes('B-');
            const isB = text.includes('B-');
            if (isB) await aBatchDone;
            const result = await originalBatch(statements);
            if (isA) { commitOrder.push('A'); releaseABatch(); }
            if (isB) commitOrder.push('B');
            return result;
        };
        const items = (prefix) => [{
            legacyId: `${prefix.toLowerCase()}-bytes-race`,
            title: `${prefix}-bytes-race`,
            body: `${prefix}-`.padEnd(100, 'x'),
            analysis: null,
            sourceType: 'paste'
        }];
        const [aResponse, bResponse] = await Promise.all([
            call(env, '/articles/import', { articles: items('A') }),
            call(env, '/articles/import', { articles: items('B') })
        ]);
        assert.deepEqual(commitOrder, ['A', 'B'], '屏障沒有真的讓 A 先提交');
        assert.equal(aResponse.status, 200, JSON.stringify(aResponse.body));
        assert.equal(aResponse.body.imported, 1);
        assert.equal(bResponse.status, 409, JSON.stringify(bResponse.body));
        assert.equal(bResponse.body.code, ARTICLE_ERRORS.quotaExceeded, JSON.stringify(bResponse.body));
        assert.equal(bResponse.body.imported, 0, JSON.stringify(bResponse.body));
        assert.equal(bResponse.body.skipped, 0);
        const total = raw.prepare('SELECT COALESCE(SUM(size_bytes), 0) AS total FROM articles WHERE deleted_at IS NULL').get().total;
        assert.equal(Number(total), ARTICLE_LIMITS.maxUserBytes);
        assert.equal(raw.prepare('SELECT COUNT(*) AS total FROM article_changes WHERE op = ?').get('create').total, 1);
        assert.equal(raw.prepare('SELECT next_seq FROM article_state WHERE owner_user_id = ?').get('alice').next_seq, 2);
    } finally {
        raw.close();
    }
});

test('999 篇時建立先提交：並行匯入不得突破 1000 篇，change 只記實際寫入', async () => {
    const context = makeEnv();
    const { raw, adapter, env } = context;
    try {
        seedArticles(raw, 999);
        const race = installWriteRace(context, {
            first: 'create',
            createId: 'single-new',
            importLegacyId: 'imp-new'
        });
        const [created, imported] = await Promise.all([
            callWith(env, '/articles', {
                body: {
                    id: 'single-new',
                    title: 'single-new',
                    body: 'single body',
                    sourceType: 'paste',
                    clientMutationId: 'm-single-new'
                }
            }),
            call(env, '/articles/import', { articles: [article('imp-new', 'I')] })
        ]);
        assert.equal(created.status, 201, JSON.stringify(created.body));
        assert.equal(imported.status, 409, JSON.stringify(imported.body));
        assert.equal(imported.body.code, ARTICLE_ERRORS.countExceeded, JSON.stringify(imported.body));
        assert.equal(imported.body.imported, 0);
        assert.deepEqual(race.commitOrder, ['create', 'import'], '屏障沒有讓建立先提交');
        assert.equal(raw.prepare('SELECT COUNT(*) AS total FROM articles').get().total, 1000);
        assert.equal(raw.prepare('SELECT COUNT(*) AS total FROM article_changes WHERE op = ?').get('create').total, 1);
        assert.equal(raw.prepare('SELECT next_seq FROM article_state WHERE owner_user_id = ?').get('alice').next_seq, 2);
    } finally {
        raw.close();
    }
});

test('999 篇時匯入先提交：並行單篇建立不得突破 1000 篇', async () => {
    const context = makeEnv();
    const { raw, adapter, env } = context;
    try {
        seedArticles(raw, 999);
        const race = installWriteRace(context, {
            first: 'import',
            createId: 'single-new',
            importLegacyId: 'imp-new'
        });
        const [imported, created] = await Promise.all([
            call(env, '/articles/import', { articles: [article('imp-new', 'I')] }),
            callWith(env, '/articles', {
                body: {
                    id: 'single-new',
                    title: 'single-new',
                    body: 'single body',
                    sourceType: 'paste',
                    clientMutationId: 'm-single-new'
                }
            })
        ]);
        assert.equal(imported.status, 200, JSON.stringify(imported.body));
        assert.equal(imported.body.imported, 1);
        assert.equal(created.status, 409, JSON.stringify(created.body));
        assert.equal(created.body.code, ARTICLE_ERRORS.countExceeded, JSON.stringify(created.body));
        assert.deepEqual(race.commitOrder, ['import', 'create'], '屏障沒有讓匯入先提交');
        const rows = raw.prepare('SELECT id FROM articles WHERE id IN (?, ?)').all('imp-new', 'single-new');
        assert.deepEqual(rows.map((row) => row.id), ['imp-new']);
        assert.equal(raw.prepare('SELECT COUNT(*) AS total FROM articles').get().total, 1000);
        assert.equal(raw.prepare('SELECT COUNT(*) AS total FROM article_changes WHERE op = ?').get('create').total, 1);
        assert.equal(raw.prepare('SELECT next_seq FROM article_state WHERE owner_user_id = ?').get('alice').next_seq, 2);
    } finally {
        raw.close();
    }
});

test('50 MiB 邊界：建立先提交時，並行匯入不得超額', async () => {
    const context = makeEnv();
    const { raw, env } = context;
    try {
        // 只剩 100 bytes；兩邊都先讀到「還有 100 bytes」才提交，只有一邊能成功。
        seedArticles(raw, 1, { size: ARTICLE_LIMITS.maxUserBytes - 100, prefix: 'seed' });
        const race = installWriteRace(context, {
            first: 'create',
            createId: 'single-bytes',
            importLegacyId: 'imp-bytes'
        });
        const [created, imported] = await Promise.all([
            callWith(env, '/articles', {
                body: {
                    id: 'single-bytes',
                    title: 'single-bytes',
                    body: 'x'.repeat(100),
                    sourceType: 'paste',
                    clientMutationId: 'm-single-bytes'
                }
            }),
            call(env, '/articles/import', {
                articles: [{ legacyId: 'imp-bytes', title: 'imp-bytes', body: 'y'.repeat(100), analysis: null, sourceType: 'paste' }]
            })
        ]);
        assert.equal(created.status, 201, JSON.stringify(created.body));
        assert.equal(imported.status, 409, JSON.stringify(imported.body));
        assert.equal(imported.body.code, ARTICLE_ERRORS.quotaExceeded, JSON.stringify(imported.body));
        assert.equal(imported.body.imported, 0);
        assert.deepEqual(race.commitOrder, ['create', 'import'], '屏障沒有讓建立先提交');
        const total = raw.prepare('SELECT COALESCE(SUM(size_bytes), 0) AS total FROM articles WHERE deleted_at IS NULL').get().total;
        assert.equal(Number(total), ARTICLE_LIMITS.maxUserBytes);
        assert.equal(raw.prepare('SELECT COUNT(*) AS total FROM article_changes WHERE op = ?').get('create').total, 1);
        assert.equal(raw.prepare('SELECT next_seq FROM article_state WHERE owner_user_id = ?').get('alice').next_seq, 2);
    } finally {
        raw.close();
    }
});

test('50 MiB 邊界：匯入先提交時，並行單篇建立不得超額', async () => {
    const context = makeEnv();
    const { raw, env } = context;
    try {
        seedArticles(raw, 1, { size: ARTICLE_LIMITS.maxUserBytes - 100, prefix: 'seed' });
        const race = installWriteRace(context, {
            first: 'import',
            createId: 'single-bytes',
            importLegacyId: 'imp-bytes'
        });
        const [imported, created] = await Promise.all([
            call(env, '/articles/import', {
                articles: [{ legacyId: 'imp-bytes', title: 'imp-bytes', body: 'y'.repeat(100), analysis: null, sourceType: 'paste' }]
            }),
            callWith(env, '/articles', {
                body: {
                    id: 'single-bytes',
                    title: 'single-bytes',
                    body: 'x'.repeat(100),
                    sourceType: 'paste',
                    clientMutationId: 'm-single-bytes'
                }
            })
        ]);
        assert.equal(imported.status, 200, JSON.stringify(imported.body));
        assert.equal(imported.body.imported, 1);
        assert.equal(created.status, 409, JSON.stringify(created.body));
        assert.equal(created.body.code, ARTICLE_ERRORS.quotaExceeded, JSON.stringify(created.body));
        assert.deepEqual(race.commitOrder, ['import', 'create'], '屏障沒有讓匯入先提交');
        const total = raw.prepare('SELECT COALESCE(SUM(size_bytes), 0) AS total FROM articles WHERE deleted_at IS NULL').get().total;
        assert.equal(Number(total), ARTICLE_LIMITS.maxUserBytes);
        assert.equal(raw.prepare('SELECT COUNT(*) AS total FROM article_changes WHERE op = ?').get('create').total, 1);
        assert.equal(raw.prepare('SELECT next_seq FROM article_state WHERE owner_user_id = ?').get('alice').next_seq, 2);
    } finally {
        raw.close();
    }
});

test('首批全成重複項目時重算用量：後續新項目不得被過期預占額度誤拒', async () => {
    const { raw, sqlite, adapter, env } = makeEnv();
    try {
        // 實際只剩 12,000 bytes；A 先匯入 8 篇小文章（每篇 100 bytes）。
        seedArticles(raw, 1, { size: ARTICLE_LIMITS.maxUserBytes - 12000, prefix: 'seed' });
        const originalAll = sqlite.all;
        const originalGet = sqlite.get;
        const originalBatch = adapter.batch;
        let preReads = 0;
        let releasePreReads;
        const preReadBarrier = new Promise((resolve) => { releasePreReads = resolve; });
        sqlite.all = async (sql, params) => {
            const result = await originalAll(sql, params);
            if (/^SELECT (id|legacy_article_id) FROM articles WHERE owner_user_id = \?/.test(sql)) {
                preReads += 1;
                if (preReads === 4) releasePreReads();
                await preReadBarrier;
            }
            return result;
        };
        let usageReads = 0;
        let releaseUsage;
        const usageBarrier = new Promise((resolve) => { releaseUsage = resolve; });
        sqlite.get = async (sql, params) => {
            const row = await originalGet(sql, params);
            if (/COUNT\(\*\) AS article_count/.test(sql)) {
                usageReads += 1;
                if (usageReads === 2) releaseUsage();
                await usageBarrier;
            }
            return row;
        };
        let releaseABatch;
        const aBatchDone = new Promise((resolve) => { releaseABatch = resolve; });
        const commitOrder = [];
        adapter.batch = async (statements) => {
            const text = JSON.stringify(statements.map((statement) => statement.__args || []));
            const isA = text.includes('A-') && !text.includes('B-');
            const isB = text.includes('B-');
            if (isB) await aBatchDone;
            const result = await originalBatch(statements);
            if (isA) { commitOrder.push('A'); releaseABatch(); }
            if (isB) commitOrder.push('B');
            return result;
        };

        const dupId = (index) => `dup-${index}`;
        const aItems = Array.from({ length: 8 }, (_, index) => ({
            legacyId: dupId(index),
            title: `A-${index}`,
            body: `A-${index}-`.padEnd(100, 'a'),
            analysis: null,
            sourceType: 'paste'
        }));
        // B 以為 8 篇重複項目還不存在，先用較大的版本預占 11,200 bytes；
        // A 先提交後它們全成 skipped，B 仍要能用實際用量匯入後面 4 篇。
        const bItems = [
            ...Array.from({ length: 8 }, (_, index) => ({
                legacyId: dupId(index),
                title: `B-${index}`,
                body: `B-${index}-`.padEnd(1400, 'b'),
                analysis: null,
                sourceType: 'paste'
            })),
            ...Array.from({ length: 4 }, (_, index) => ({
                legacyId: `new-${index}`,
                title: `B-new-${index}`,
                body: `B-new-${index}-`.padEnd(1000, 'c'),
                analysis: null,
                sourceType: 'paste'
            }))
        ];
        const [aResponse, bResponse] = await Promise.all([
            call(env, '/articles/import', { articles: aItems }),
            call(env, '/articles/import', { articles: bItems })
        ]);
        assert.deepEqual(commitOrder, ['A', 'B'], '屏障沒有真的讓 A 先提交');
        assert.equal(aResponse.status, 200, JSON.stringify(aResponse.body));
        assert.equal(aResponse.body.imported, 8);
        assert.equal(bResponse.status, 200, JSON.stringify(bResponse.body));
        assert.equal(bResponse.body.imported, 4, JSON.stringify(bResponse.body));
        assert.equal(bResponse.body.skipped, 8, JSON.stringify(bResponse.body));
        assert.equal(bResponse.body.ids.length, 4);
        assert.equal(raw.prepare('SELECT COUNT(*) AS total FROM articles WHERE deleted_at IS NULL').get().total, 13);
        const total = raw.prepare('SELECT COALESCE(SUM(size_bytes), 0) AS total FROM articles WHERE deleted_at IS NULL').get().total;
        assert.ok(Number(total) <= ARTICLE_LIMITS.maxUserBytes, String(total));
        assert.equal(raw.prepare('SELECT COUNT(*) AS total FROM article_changes WHERE op = ?').get('create').total, 12);
        assert.equal(raw.prepare('SELECT next_seq FROM article_state WHERE owner_user_id = ?').get('alice').next_seq, 13);
        const retry = await call(env, '/articles/import', { articles: bItems });
        assert.equal(retry.status, 200, JSON.stringify(retry.body));
        assert.equal(retry.body.imported, 0);
        assert.equal(retry.body.skipped, 12);
        assert.equal(raw.prepare('SELECT COUNT(*) AS total FROM articles').get().total, 13);
        assert.equal(raw.prepare('SELECT COUNT(*) AS total FROM article_changes').get().total, 12);
    } finally {
        raw.close();
    }
});

test('更新放大內容與匯入並行：50 MiB 邊界不得超額', async () => {
    const { raw, sqlite, adapter, env } = makeEnv();
    try {
        // 單篇上限是 100,000 字元；用中日韓字元讓每篇約 300,000 bytes。
        // 實際只剩 700,000 bytes；更新 +200,000、匯入 2×300,000，兩者各自
        // 都過得了預檢，但加起來一定超額，只有一邊能提交。
        const articleBytes = 300000;
        seedArticles(raw, 172, { size: articleBytes, prefix: 'bulk' });
        seedArticles(raw, 1, { size: 28800, prefix: 'filler' });
        const at = new Date().toISOString();
        raw.prepare('INSERT INTO articles (owner_user_id, id, title, body, analysis_json, source_type, source_url, revision, created_at, updated_at, deleted_at, legacy_article_id, last_mutation_id, size_bytes) '
            + 'VALUES (?, ?, ?, ?, NULL, ?, NULL, 1, ?, ?, NULL, NULL, NULL, ?)')
            .run('alice', 'target', 'target', 'target body', 'paste', at, at, 100000);

        const originalBatch = adapter.batch;
        const originalGet = sqlite.get;
        let usageReads = 0;
        let releaseUsage;
        const usageBarrier = new Promise((resolve) => { releaseUsage = resolve; });
        sqlite.get = async (sql, params) => {
            const row = await originalGet(sql, params);
            if (/COUNT\(\*\) AS article_count/.test(sql)) {
                usageReads += 1;
                if (usageReads >= 2) releaseUsage();
                await usageBarrier;
            }
            return row;
        };
        let releaseUpdate;
        const updateDone = new Promise((resolve) => { releaseUpdate = resolve; });
        const commitOrder = [];
        adapter.batch = async (statements) => {
            const text = JSON.stringify(statements.map((statement) => statement.__args || []));
            const isUpdate = text.includes('m-update-target');
            const isImport = text.includes('imp-grow');
            if (isImport) await updateDone;
            const result = await originalBatch(statements);
            if (isUpdate) { commitOrder.push('update'); releaseUpdate(); }
            if (isImport) commitOrder.push('import');
            return result;
        };

        const [updated, imported] = await Promise.all([
            callWith(env, '/articles/target', {
                method: 'PUT',
                body: {
                    expectedRevision: 1,
                    clientMutationId: 'm-update-target',
                    title: 'target',
                    body: '中'.repeat(100000),
                    sourceType: 'paste'
                }
            }),
            call(env, '/articles/import', {
                articles: [
                    { legacyId: 'imp-grow-a', title: 'grow-a', body: '甲'.repeat(100000), analysis: null, sourceType: 'paste' },
                    { legacyId: 'imp-grow-b', title: 'grow-b', body: '乙'.repeat(100000), analysis: null, sourceType: 'paste' }
                ]
            })
        ]);
        assert.equal(updated.status, 200, JSON.stringify(updated.body));
        assert.equal(imported.status, 409, JSON.stringify(imported.body));
        assert.equal(imported.body.code, ARTICLE_ERRORS.quotaExceeded, JSON.stringify(imported.body));
        // 更新先提交後只剩 500,000 bytes：匯入只能再放進第一篇，第二篇被擋。
        assert.equal(imported.body.imported, 1, JSON.stringify(imported.body));
        assert.equal(imported.body.ids.length, 1);
        assert.deepEqual(commitOrder, ['update', 'import'], '屏障沒有讓更新先提交');
        const total = raw.prepare('SELECT COALESCE(SUM(size_bytes), 0) AS total FROM articles WHERE deleted_at IS NULL').get().total;
        assert.ok(Number(total) <= ARTICLE_LIMITS.maxUserBytes, String(total));
        assert.equal(raw.prepare('SELECT COUNT(*) AS total FROM article_changes WHERE op = ?').get('create').total, 1);
        // 1 筆 update + 1 筆 create change，序號只前進這兩筆。
        assert.equal(raw.prepare('SELECT next_seq FROM article_state WHERE owner_user_id = ?').get('alice').next_seq, 3);
    } finally {
        raw.close();
    }
});

test('還原與建立並行：1000 篇邊界不得超額', async () => {
    const { raw, sqlite, adapter, env } = makeEnv();
    try {
        seedArticles(raw, 999);
        const at = new Date().toISOString();
        raw.prepare('INSERT INTO articles (owner_user_id, id, title, body, analysis_json, source_type, source_url, revision, created_at, updated_at, deleted_at, legacy_article_id, last_mutation_id, size_bytes) '
            + 'VALUES (?, ?, ?, ?, NULL, ?, NULL, 2, ?, ?, ?, NULL, NULL, ?)')
            .run('alice', 'restore-a', 'restore-a', 'restore body', 'paste', at, at, at, 10);

        const originalBatch = adapter.batch;
        const originalGet = sqlite.get;
        let usageReads = 0;
        let releaseUsage;
        const usageBarrier = new Promise((resolve) => { releaseUsage = resolve; });
        sqlite.get = async (sql, params) => {
            const row = await originalGet(sql, params);
            if (/COUNT\(\*\) AS article_count/.test(sql)) {
                usageReads += 1;
                if (usageReads >= 2) releaseUsage();
                await usageBarrier;
            }
            return row;
        };
        let releaseRestore;
        const restoreDone = new Promise((resolve) => { releaseRestore = resolve; });
        const commitOrder = [];
        adapter.batch = async (statements) => {
            const text = JSON.stringify(statements.map((statement) => statement.__args || []));
            const isRestore = text.includes('m-restore-a');
            const isCreate = text.includes('single-new');
            if (isCreate) await restoreDone;
            const result = await originalBatch(statements);
            if (isRestore) { commitOrder.push('restore'); releaseRestore(); }
            if (isCreate) commitOrder.push('create');
            return result;
        };

        const [restored, created] = await Promise.all([
            callWith(env, '/articles/restore-a/restore', {
                body: { expectedRevision: 2, clientMutationId: 'm-restore-a' }
            }),
            callWith(env, '/articles', {
                body: {
                    id: 'single-new',
                    title: 'single-new',
                    body: 'single body',
                    sourceType: 'paste',
                    clientMutationId: 'm-single-new'
                }
            })
        ]);
        assert.equal(restored.status, 200, JSON.stringify(restored.body));
        assert.equal(created.status, 409, JSON.stringify(created.body));
        assert.equal(created.body.code, ARTICLE_ERRORS.countExceeded, JSON.stringify(created.body));
        assert.deepEqual(commitOrder, ['restore', 'create'], '屏障沒有讓還原先提交');
        assert.equal(raw.prepare('SELECT COUNT(*) AS total FROM articles WHERE deleted_at IS NULL').get().total, 1000);
        assert.equal(raw.prepare('SELECT COUNT(*) AS total FROM article_changes WHERE op = ?').get('create').total, 0);
    } finally {
        raw.close();
    }
});

test('flush 釋放 skipped 的預占容量後，同一請求以最新用量繼續匯入', async () => {
    const { raw, sqlite, adapter, env } = makeEnv();
    try {
        // 實際只剩 1,000 bytes。
        seedArticles(raw, 1, { size: ARTICLE_LIMITS.maxUserBytes - 1000, prefix: 'seed' });
        const originalBatch = adapter.batch;
        let injected = false;
        adapter.batch = async (statements) => {
            const text = JSON.stringify(statements.map((statement) => statement.__args || []));
            // B 的第一個批次是 900-byte 的重複項目；在它送出前讓另一個請求
            // 先建立同 ID（body 只有 1 byte）。
            if (!injected && text.includes('B-dup')) {
                injected = true;
                const other = await call(env, '/articles/import', {
                    articles: [{
                        legacyId: 'dup-0',
                        title: 'other-0',
                        body: 'x',
                        analysis: null,
                        sourceType: 'paste'
                    }]
                });
                assert.equal(other.status, 200, JSON.stringify(other.body));
                assert.equal(other.body.imported, 1, JSON.stringify(other.body));
            }
            return originalBatch(statements);
        };

        const response = await call(env, '/articles/import', {
            articles: [
                {
                    legacyId: 'dup-0',
                    title: 'B-dup-0',
                    body: 'd'.repeat(900),
                    analysis: null,
                    sourceType: 'paste'
                },
                {
                    legacyId: 'new-0',
                    title: 'B-new-0',
                    body: 'n'.repeat(200),
                    analysis: null,
                    sourceType: 'paste'
                }
            ]
        });
        // 舊版：flush 跳過重複項目後仍回傳 flush 前的 409，新文章沒有匯入。
        assert.equal(response.status, 200, JSON.stringify(response.body));
        assert.equal(response.body.imported, 1, JSON.stringify(response.body));
        assert.equal(response.body.skipped, 1, JSON.stringify(response.body));
        assert.deepEqual(response.body.ids, ['new-0']);
        assert.equal(raw.prepare('SELECT body FROM articles WHERE id = ?').get('new-0').body, 'n'.repeat(200));
        assert.equal(raw.prepare('SELECT title FROM articles WHERE id = ?').get('dup-0').title, 'other-0');

        const total = raw.prepare('SELECT COALESCE(SUM(size_bytes), 0) AS total FROM articles WHERE deleted_at IS NULL').get().total;
        assert.equal(Number(total), ARTICLE_LIMITS.maxUserBytes - 1000 + 1 + 200);
        assert.equal(raw.prepare('SELECT COUNT(*) AS total FROM article_changes WHERE op = ?').get('create').total, 2);
        assert.equal(raw.prepare('SELECT next_seq FROM article_state WHERE owner_user_id = ?').get('alice').next_seq, 3);

        const retry = await call(env, '/articles/import', {
            articles: [
                { legacyId: 'dup-0', title: 'B-dup-0', body: 'd'.repeat(900), analysis: null, sourceType: 'paste' },
                { legacyId: 'new-0', title: 'B-new-0', body: 'n'.repeat(200), analysis: null, sourceType: 'paste' }
            ]
        });
        assert.equal(retry.status, 200, JSON.stringify(retry.body));
        assert.equal(retry.body.imported, 0);
        assert.equal(retry.body.skipped, 2);
        assert.equal(raw.prepare('SELECT COUNT(*) AS total FROM articles').get().total, 3);
        assert.equal(raw.prepare('SELECT COUNT(*) AS total FROM article_changes').get().total, 2);
    } finally {
        raw.close();
    }
});
