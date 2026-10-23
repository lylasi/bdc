// PostgreSQL 配額競態：READ COMMITTED 下，兩個交易可能各自通過 COUNT／SUM
// 條件；這支測試讓第一個交易在「已插入、尚未提交」時停住，第二個交易此時
// 才開始。有使用者範圍的列鎖時，第二個交易會卡在鎖上，等第一個提交後才
// 看得到最新用量並被配額擋下；沒有鎖時它會在空窗期插入，總量超額。
//
// 需要可用的 PostgreSQL：
//   BDC_TEST_PG_URL=postgres://user:pass@127.0.0.1:5432/bdc \
//     node --test --test-timeout=180000 tests/articles-quota-postgres.test.mjs
// 未設定（或未安裝 pg）時整組測試 skip；一般 Node 測試不需要 PostgreSQL。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { handleArticlesRoute } from '../cloudflare-worker/src/articles.js';
import { createD1Adapter, readResponseBody } from '../selfhost/d1-adapter.js';
import { ARTICLE_ERRORS, ARTICLE_LIMITS } from '../shared/article-protocol.mjs';

const PG_URL = String(process.env.BDC_TEST_PG_URL || '');
const hasUrl = !!PG_URL;

let pgModule = null;
if (hasUrl) {
    // 先從 selfhost/package.json 解析（pg 是那裡的依賴），再看一般 node_modules；
    // 兩者都沒有就 skip，不讓一般 Node 測試因缺少 PostgreSQL 而失敗。
    try {
        const { createRequire } = await import('node:module');
        const requireFromSelfhost = createRequire(new URL('../selfhost/package.json', import.meta.url));
        pgModule = requireFromSelfhost('pg');
    } catch (_) {
        try {
            pgModule = await import('pg');
        } catch (_) {
            pgModule = null;
        }
    }
}
const skip = !hasUrl ? 'BDC_TEST_PG_URL 未設定' : (!pgModule ? 'pg 套件未安裝（cd selfhost && npm install）' : false);

const SCHEMA = readFileSync(new URL('../selfhost/schema.sql', import.meta.url), 'utf8');

function convertSql(sql) {
    let index = 0;
    return sql.replace(/\?/g, () => `$${(index += 1)}`);
}

async function createPgContext() {
    const Pool = pgModule.Pool || (pgModule.default && pgModule.default.Pool);
    const pool = new Pool({ connectionString: PG_URL, max: 6 });
    await pool.query(SCHEMA);
    const userId = `pg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await pool.query('INSERT INTO users (token_hash, user_id, label, role) VALUES ($1, $2, $3, $4)', [
        `hash-${userId}`,
        userId,
        'PG test',
        'user'
    ]);
    // 先建立 article_state，讓 ensureState 只做 SELECT；這樣競態一定發生在
    // 配額語句（而不是被 upsert 的列鎖偶然擋住）。
    await pool.query(
        'INSERT INTO article_state (owner_user_id, next_seq, legacy_write_blocked, updated_at) VALUES ($1, 1, 0, $2) ON CONFLICT (owner_user_id) DO NOTHING',
        [userId, new Date().toISOString()]
    );
    const hooks = { beforeCommit: null };
    const db = {
        driver: 'postgres',
        all: async (sql, params = []) => (await pool.query(convertSql(sql), params)).rows,
        get: async (sql, params = []) => (await pool.query(convertSql(sql), params)).rows[0],
        run: async (sql, params = []) => {
            const result = await pool.query(convertSql(sql), params);
            return { changes: result.rowCount };
        },
        batch: async (statements = []) => {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const results = [];
                for (const statement of statements) {
                    const result = await client.query(convertSql(statement.sql), statement.params || []);
                    results.push({ changes: result.rowCount });
                }
                if (hooks.beforeCommit) await hooks.beforeCommit(statements, client);
                await client.query('COMMIT');
                return results;
            } catch (error) {
                try { await client.query('ROLLBACK'); } catch (_) {}
                throw error;
            } finally {
                client.release();
            }
        },
        close: async () => pool.end()
    };
    const env = { DB: createD1Adapter(db), ALLOWED_ORIGINS: '*' };
    return { pool, hooks, env, userId };
}

async function dropPgContext(context) {
    const { pool, userId } = context;
    await pool.query('DELETE FROM article_changes WHERE owner_user_id = $1', [userId]);
    await pool.query('DELETE FROM articles WHERE owner_user_id = $1', [userId]);
    await pool.query('DELETE FROM article_state WHERE owner_user_id = $1', [userId]);
    await pool.query('DELETE FROM users WHERE user_id = $1', [userId]);
    await pool.end();
}

async function seedArticles(pool, userId, count, size, prefix = 'seed') {
    const at = new Date().toISOString();
    await pool.query(
        'INSERT INTO articles (owner_user_id, id, title, body, analysis_json, source_type, source_url, revision, created_at, updated_at, deleted_at, legacy_article_id, last_mutation_id, size_bytes) '
        + "SELECT $1, $2 || g, $2 || g, 'body ' || $2 || g, NULL, 'paste', NULL, 1, $3, $3, NULL, NULL, NULL, $4 "
        + 'FROM generate_series(0, $5::int - 1) AS g',
        [userId, prefix, at, size, count]
    );
}

function callPg(env, userId, path, body) {
    const request = new Request('https://pg.example' + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    return handleArticlesRoute({
        request,
        env,
        url: new URL(request.url),
        user: { user_id: userId },
        rest: path.slice('/articles'.length)
    }).then(async (response) => ({ status: response.status, body: await readResponseBody(response) }));
}

function importItem(legacyId, prefix, size) {
    return {
        legacyId,
        title: `${prefix}-${legacyId}`,
        body: `${prefix}-${legacyId}-`.padEnd(size, 'x'),
        analysis: null,
        sourceType: 'paste'
    };
}

/**
 * 第一個交易插入後停在 COMMIT 前；第二個交易此時才開始，因此它的配額語句
 * 會與第一個的未提交寫入重疊。`seen` 用來斷言兩個交易真的都進到 batch。
 */
async function runOverlapRace(context, {
    seedCount = 0,
    seedSize = 10,
    first = 'create',
    createId = 'pg-single',
    createSize = 100,
    importId = 'pg-import',
    importPrefix = 'PG-I',
    importSize = 100
} = {}) {
    const { pool, hooks, env, userId } = context;
    if (seedCount) await seedArticles(pool, userId, seedCount, seedSize);
    let releaseFirst;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    let signalFirst;
    const firstInserted = new Promise((resolve) => { signalFirst = resolve; });
    const order = [];
    hooks.beforeCommit = async (statements) => {
        const text = JSON.stringify(statements.map((statement) => statement.params || []));
        const isCreate = text.includes(createId);
        const isImport = text.includes(importId);
        const isFirst = (first === 'create' && isCreate) || (first === 'import' && isImport);
        if (isFirst) {
            order.push(first);
            signalFirst();
            // 讓第二個交易有時間 BEGIN、執行到配額語句；鎖會讓它等到這裡提交。
            setTimeout(releaseFirst, 300);
            await firstGate;
        } else if (isCreate) {
            order.push('create');
        } else if (isImport) {
            order.push('import');
        }
    };
    const createCall = () => callPg(env, userId, '/articles', {
        id: createId,
        title: createId,
        body: 'x'.repeat(createSize),
        sourceType: 'paste',
        clientMutationId: `m-${createId}`
    });
    const importCall = () => callPg(env, userId, '/articles/import', {
        articles: [importItem(importId, importPrefix, importSize)]
    });
    const firstPromise = first === 'create' ? createCall() : importCall();
    await firstInserted;
    const secondPromise = first === 'create' ? importCall() : createCall();
    const [firstResult, secondResult] = await Promise.all([firstPromise, secondPromise]);
    const createResult = first === 'create' ? firstResult : secondResult;
    const importResult = first === 'create' ? secondResult : firstResult;
    return { order, createResult, importResult };
}

async function usageOf(pool, userId) {
    const result = await pool.query(
        'SELECT COUNT(*)::int AS article_count, COALESCE(SUM(size_bytes), 0)::bigint AS total_bytes FROM articles WHERE owner_user_id = $1 AND deleted_at IS NULL',
        [userId]
    );
    return { count: Number(result.rows[0].article_count), totalBytes: Number(result.rows[0].total_bytes) };
}

async function changesOf(pool, userId) {
    const result = await pool.query('SELECT COUNT(*)::int AS total FROM article_changes WHERE owner_user_id = $1 AND op = $2', [userId, 'create']);
    const state = await pool.query('SELECT next_seq FROM article_state WHERE owner_user_id = $1', [userId]);
    return { creates: Number(result.rows[0].total), nextSeq: Number(state.rows[0]?.next_seq || 1) };
}

for (const first of ['create', 'import']) {
    test(`PostgreSQL 1000 篇邊界：${first === 'create' ? '單篇建立' : '匯入'}先插入、另一邊不得超額`, { skip }, async () => {
        const context = await createPgContext();
        try {
            const { order, createResult, importResult } = await runOverlapRace(context, {
                seedCount: 999,
                first,
                createId: `pg-count-${first}`,
                importId: `pg-count-imp-${first}`
            });
            // create 先插入時，import 的 ensureState 會先等到列鎖釋放，可能在
            // 前置 checkQuota 就被擋下；匯入先插入時 create 會進到 batch 才被擋。
            assert.equal(order[0], first, JSON.stringify(order));
            if (first === 'import') assert.ok(order.includes('create'), JSON.stringify(order));
            if (first === 'create') {
                assert.equal(createResult.status, 201, JSON.stringify(createResult.body));
                assert.equal(importResult.status, 409, JSON.stringify(importResult.body));
                assert.equal(importResult.body.code, ARTICLE_ERRORS.countExceeded, JSON.stringify(importResult.body));
                assert.equal(importResult.body.imported, 0);
            } else {
                assert.equal(importResult.status, 200, JSON.stringify(importResult.body));
                assert.equal(importResult.body.imported, 1);
                assert.equal(createResult.status, 409, JSON.stringify(createResult.body));
                assert.equal(createResult.body.code, ARTICLE_ERRORS.countExceeded, JSON.stringify(createResult.body));
            }
            const usage = await usageOf(context.pool, context.userId);
            assert.equal(usage.count, 1000);
            const changes = await changesOf(context.pool, context.userId);
            assert.equal(changes.creates, 1, 'change log 沒有只記實際提交');
            assert.equal(changes.nextSeq, 2);
        } finally {
            await dropPgContext(context);
        }
    });

    test(`PostgreSQL 50 MiB 邊界：${first === 'create' ? '單篇建立' : '匯入'}先插入、另一邊不得超額`, { skip }, async () => {
        const context = await createPgContext();
        try {
            const { order, createResult, importResult } = await runOverlapRace(context, {
                seedCount: 1,
                seedSize: ARTICLE_LIMITS.maxUserBytes - 100,
                first,
                createId: `pg-bytes-${first}`,
                createSize: 100,
                importId: `pg-bytes-imp-${first}`,
                importSize: 100
            });
            assert.equal(order[0], first, JSON.stringify(order));
            if (first === 'import') assert.ok(order.includes('create'), JSON.stringify(order));
            const usage = await usageOf(context.pool, context.userId);
            assert.equal(usage.totalBytes, ARTICLE_LIMITS.maxUserBytes, '總量超過 50 MiB');
            if (first === 'create') {
                assert.equal(createResult.status, 201, JSON.stringify(createResult.body));
                assert.equal(importResult.status, 409, JSON.stringify(importResult.body));
                assert.equal(importResult.body.code, ARTICLE_ERRORS.quotaExceeded, JSON.stringify(importResult.body));
            } else {
                assert.equal(importResult.status, 200, JSON.stringify(importResult.body));
                assert.equal(importResult.body.imported, 1);
                assert.equal(createResult.status, 409, JSON.stringify(createResult.body));
                assert.equal(createResult.body.code, ARTICLE_ERRORS.quotaExceeded, JSON.stringify(createResult.body));
            }
            const changes = await changesOf(context.pool, context.userId);
            assert.equal(changes.creates, 1);
            assert.equal(changes.nextSeq, 2);
        } finally {
            await dropPgContext(context);
        }
    });
}

test('PostgreSQL import ↔ import：未提交重疊時不得突破 1000 篇', { skip }, async () => {
    const context = await createPgContext();
    try {
        const { pool, hooks, env, userId } = context;
        await seedArticles(pool, userId, 999, 10);
        let releaseFirst;
        const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
        let signalFirst;
        const firstInserted = new Promise((resolve) => { signalFirst = resolve; });
        hooks.beforeCommit = async (statements) => {
            const text = JSON.stringify(statements.map((statement) => statement.params || []));
            if (!text.includes('PG-A-')) return;
            signalFirst();
            setTimeout(releaseFirst, 300);
            await firstGate;
        };
        const first = callPg(env, userId, '/articles/import', { articles: [importItem('pg-a', 'PG-A', 100)] });
        await firstInserted;
        const second = callPg(env, userId, '/articles/import', { articles: [importItem('pg-b', 'PG-B', 100)] });
        const [a, b] = await Promise.all([first, second]);
        assert.equal(a.status, 200, JSON.stringify(a.body));
        assert.equal(a.body.imported, 1);
        assert.equal(b.status, 409, JSON.stringify(b.body));
        assert.equal(b.body.code, ARTICLE_ERRORS.countExceeded, JSON.stringify(b.body));
        assert.equal(b.body.imported, 0);
        const usage = await usageOf(pool, userId);
        assert.equal(usage.count, 1000);
        const changes = await changesOf(pool, userId);
        assert.equal(changes.creates, 1);
        assert.equal(changes.nextSeq, 2);
    } finally {
        await dropPgContext(context);
    }
});

test('PostgreSQL import ↔ import：50 MiB 邊界不得超額', { skip }, async () => {
    const context = await createPgContext();
    try {
        const { pool, hooks, env, userId } = context;
        await seedArticles(pool, userId, 1, ARTICLE_LIMITS.maxUserBytes - 100);
        let releaseFirst;
        const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
        let signalFirst;
        const firstInserted = new Promise((resolve) => { signalFirst = resolve; });
        hooks.beforeCommit = async (statements) => {
            const text = JSON.stringify(statements.map((statement) => statement.params || []));
            if (!text.includes('PG-A-')) return;
            signalFirst();
            setTimeout(releaseFirst, 300);
            await firstGate;
        };
        const first = callPg(env, userId, '/articles/import', { articles: [importItem('pg-bytes-a', 'PG-A', 100)] });
        await firstInserted;
        const second = callPg(env, userId, '/articles/import', { articles: [importItem('pg-bytes-b', 'PG-B', 100)] });
        const [a, b] = await Promise.all([first, second]);
        assert.equal(a.status, 200, JSON.stringify(a.body));
        assert.equal(a.body.imported, 1);
        assert.equal(b.status, 409, JSON.stringify(b.body));
        assert.equal(b.body.code, ARTICLE_ERRORS.quotaExceeded, JSON.stringify(b.body));
        assert.equal(b.body.imported, 0);
        const usage = await usageOf(pool, userId);
        assert.equal(usage.totalBytes, ARTICLE_LIMITS.maxUserBytes);
        const changes = await changesOf(pool, userId);
        assert.equal(changes.creates, 1);
        assert.equal(changes.nextSeq, 2);
    } finally {
        await dropPgContext(context);
    }
});
