// 文章協議一致性測試：同一份情境分別跑在 Cloudflare Worker（真實 SQLite + D1 介面）
// 與 selfhost（真正啟動 server.mjs，SQLite 模式），兩邊都必須得到相同結果。
//
// 用法：node --test tests/articles-protocol.test.mjs
//
// 覆蓋：權限隔離、expectedRevision 原子檢查、游標增量同步、分頁、刪除與復原、
// 冪等重試、舊資料匯入、舊快照寫入閘門、容量限制與錯誤碼分流。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';

import worker from '../cloudflare-worker/src/worker.js';
import { createD1Adapter, createSqliteDatabase, readResponseBody } from '../selfhost/d1-adapter.js';
import { checkQuota, ARTICLE_LIMITS, snapshotCarriesArticles } from '../shared/article-protocol.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ALICE = 'a'.repeat(40);
const BOB = 'b'.repeat(40);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function seedUsers(db) {
    const insert = db.prepare('INSERT OR REPLACE INTO users (token_hash, user_id, label, recovery_hash, role) VALUES (?, ?, ?, NULL, ?)');
    insert.run(sha256(ALICE), 'alice', 'Alice', 'user');
    insert.run(sha256(BOB), 'bob', 'Bob', 'user');
}

function freshSqlite(schemaPath) {
    const dir = mkdtempSync(join(tmpdir(), 'bdc-articles-'));
    const file = join(dir, 'test.sqlite');
    const raw = new DatabaseSync(file);
    raw.exec(readFileSync(schemaPath, 'utf8'));
    seedUsers(raw);
    return { db: createSqliteDatabase(raw), raw, file, dir };
}

function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

async function startSelfhost(file) {
    const port = await freePort();
    const child = spawn(process.execPath, [join(ROOT, 'selfhost/server.mjs')], {
        env: {
            ...process.env,
            DB_DRIVER: 'sqlite',
            SQLITE_PATH: file,
            PORT: String(port),
            HOST: '127.0.0.1',
            ALLOWED_ORIGINS: '*'
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`selfhost 啟動逾時：${stderr}`)), 15000);
        child.stdout.on('data', (chunk) => {
            if (String(chunk).includes('listening on')) {
                clearTimeout(timer);
                resolve();
            }
        });
        child.once('exit', (code) => {
            clearTimeout(timer);
            reject(new Error(`selfhost 結束（${code}）：${stderr}`));
        });
    });
    return {
        base: `http://127.0.0.1:${port}`,
        stop: () => new Promise((resolve) => {
            child.once('exit', () => resolve());
            child.kill('SIGTERM');
        })
    };
}

/** 兩個後端都以同樣的方式被呼叫，回傳 { status, body }。 */
function workerApi(db) {
    const env = { DB: createD1Adapter(db), ALLOWED_ORIGINS: '*' };
    return {
        name: 'worker-d1',
        async call(path, { method = 'GET', token = ALICE, body } = {}) {
            const headers = { Origin: 'https://app.example' };
            if (token) headers.Authorization = `Bearer ${token}`;
            if (body !== undefined) headers['Content-Type'] = 'application/json';
            const request = new Request(`https://sync.example${path}`, {
                method,
                headers,
                body: body === undefined ? undefined : JSON.stringify(body)
            });
            const response = await worker.fetch(request, env);
            return { status: response.status, body: await readResponseBody(response) };
        }
    };
}

function httpApi(base) {
    return {
        name: 'selfhost-http',
        async call(path, { method = 'GET', token = ALICE, body } = {}) {
            const headers = { Origin: 'http://app.example' };
            if (token) headers.Authorization = `Bearer ${token}`;
            if (body !== undefined) headers['Content-Type'] = 'application/json';
            const response = await fetch(base + path, {
                method,
                headers,
                body: body === undefined ? undefined : JSON.stringify(body)
            });
            return { status: response.status, body: await readResponseBody(response) };
        }
    };
}

const DOC_A = {
    id: 'art_alpha',
    title: 'Alpha',
    body: 'First paragraph of alpha.\n\nSecond paragraph.',
    analysis: { chinese_translation: '甲', detailed_analysis: [{ word: 'alpha', sentence: 'First paragraph of alpha.' }] },
    sourceType: 'url',
    sourceUrl: 'https://example.com/alpha'
};

async function runScenario(api) {
    const results = {};
    const hit = (label, value) => { results[label] = value; return value; };

    // --- 未登入 ---
    hit('anonymous', await api.call('/articles', { token: '' }));

    // --- 建立（冪等） ---
    hit('create', await api.call('/articles', { method: 'POST', body: { ...DOC_A, clientMutationId: 'm1' } }));
    hit('createRetry', await api.call('/articles', { method: 'POST', body: { ...DOC_A, clientMutationId: 'm1' } }));
    hit('createConflict', await api.call('/articles', { method: 'POST', body: { ...DOC_A, clientMutationId: 'm2' } }));

    // --- 讀取與列表（列表不帶正文） ---
    hit('readOne', await api.call('/articles/art_alpha'));
    hit('listFull', await api.call('/articles?full=1'));

    // --- 跨帳戶隔離 ---
    hit('bobReadsAlice', await api.call('/articles/art_alpha', { token: BOB }));
    hit('bobUpdatesAlice', await api.call('/articles/art_alpha', { method: 'PUT', token: BOB, body: { title: 'hijack', expectedRevision: 1 } }));
    hit('bobDeletesAlice', await api.call('/articles/art_alpha', { method: 'DELETE', token: BOB, body: { expectedRevision: 1 } }));
    hit('bobCreateSameId', await api.call('/articles', {
        method: 'POST',
        token: BOB,
        body: { id: 'art_alpha', title: 'Bob copy', body: 'Bob body', sourceType: 'paste' }
    }));
    hit('bobReadOwn', await api.call('/articles/art_alpha', { token: BOB }));

    // --- 版本檢查 ---
    hit('updateNoRevision', await api.call('/articles/art_alpha', { method: 'PUT', body: { title: 'No rev' } }));
    hit('updateWrongRevision', await api.call('/articles/art_alpha', { method: 'PUT', body: { title: 'Stale', expectedRevision: 9 } }));
    hit('update', await api.call('/articles/art_alpha', {
        method: 'PUT',
        body: { title: 'Alpha renamed', expectedRevision: 1, clientMutationId: 'u1' }
    }));
    hit('updateRetry', await api.call('/articles/art_alpha', {
        method: 'PUT',
        body: { title: 'Alpha renamed', expectedRevision: 1, clientMutationId: 'u1' }
    }));
    hit('updateAgain', await api.call('/articles/art_alpha', {
        method: 'PUT',
        body: { title: 'Alpha renamed twice', expectedRevision: 2, clientMutationId: 'u2' }
    }));
    hit('updateStaleAfterRename', await api.call('/articles/art_alpha', {
        method: 'PUT',
        body: { title: 'Stale again', expectedRevision: 1 }
    }));

    // --- 增量游標 ---
    hit('deltaFromZero', await api.call('/articles?cursor=0&limit=100'));
    const cursor = results.deltaFromZero.body?.cursor;
    hit('deltaNoChange', await api.call(`/articles?cursor=${cursor}`));
    hit('deltaInvalid', await api.call('/articles?cursor=not-a-number'));

    // --- 批次讀取 ---
    hit('batch', await api.call('/articles/batch', { method: 'POST', body: { ids: ['art_alpha', 'missing', 'art_alpha'] } }));

    // --- 刪除 / 復原 ---
    hit('deleteWrongRevision', await api.call('/articles/art_alpha', { method: 'DELETE', body: { expectedRevision: 1 } }));
    hit('delete', await api.call('/articles/art_alpha', { method: 'DELETE', body: { expectedRevision: 3, clientMutationId: 'd1' } }));
    hit('deleteRetry', await api.call('/articles/art_alpha', { method: 'DELETE', body: { expectedRevision: 3, clientMutationId: 'd1' } }));
    hit('readDeleted', await api.call('/articles/art_alpha'));
    hit('listAfterDelete', await api.call('/articles?full=1'));
    hit('listIncludingDeleted', await api.call('/articles?full=1&includeDeleted=1'));
    hit('updateDeleted', await api.call('/articles/art_alpha', { method: 'PUT', body: { title: 'Zombie', expectedRevision: 4 } }));
    hit('restoreNotDeleted', await api.call('/articles/art_alpha/restore', { method: 'POST', body: { expectedRevision: 1 } }));
    hit('restore', await api.call('/articles/art_alpha/restore', { method: 'POST', body: { expectedRevision: 4, clientMutationId: 'r1' } }));
    hit('restoreRetry', await api.call('/articles/art_alpha/restore', { method: 'POST', body: { expectedRevision: 4, clientMutationId: 'r1' } }));
    hit('readRestored', await api.call('/articles/art_alpha'));
    hit('deltaAfterRestore', await api.call(`/articles?cursor=${cursor}`));

    // --- 容量：原文超過硬上限 ---
    const hugeBody = 'x'.repeat(ARTICLE_LIMITS.maxBodyChars + 1);
    hit('bodyTooLarge', await api.call('/articles', { method: 'POST', body: { title: 'huge', body: hugeBody } }));
    // 單篇 UTF-8 位元組超過 800KB（分析 JSON 內 90 萬 ASCII 字元）
    const heavyBody = 'y'.repeat(900 * 1024);
    hit('docTooLarge', await api.call('/articles', {
        method: 'POST',
        body: { title: 'heavy', body: 'ok', analysis: { blob: heavyBody } }
    }));
    hit('usage', await api.call('/articles/usage'));

    // --- 舊資料匯入與閘門 ---
    const legacy = [
        { legacyId: 'url:https%3A%2F%2Fexample.com%2Fold', title: 'Old A', body: 'Old body A', analysis: { chinese_translation: '舊甲' }, sourceType: 'url', sourceUrl: 'https://example.com/old' },
        { legacyId: 'local:abc123', title: 'Old B', body: 'Old body B', analysis: null, sourceType: 'paste' }
    ];
    hit('import', await api.call('/articles/import', { method: 'POST', body: { articles: legacy } }));
    hit('importRetry', await api.call('/articles/import', { method: 'POST', body: { articles: legacy } }));
    hit('importInvalid', await api.call('/articles/import', { method: 'POST', body: { articles: [{ id: 'x', title: '', body: '' }] } }));
    hit('importFinal', await api.call('/articles/import', { method: 'POST', body: { articles: [] } }));
    hit('importFinalGated', await api.call('/articles/import', { method: 'POST', body: { articles: [], final: true } }));

    hit('snapshotBlocked', await api.call('/snapshot', {
        method: 'POST',
        body: { expected_version: 0, payload: { articles: { analyzedArticles: [{ article: 'A', result: {} }], articleMetas: [] } } }
    }));
    hit('snapshotOtherGroups', await api.call('/snapshot', {
        method: 'POST',
        body: {
            expected_version: 0,
            payload: {
                vocabulary: { updatedAt: '2026-01-01T00:00:00.000Z', books: [{ id: 'b1', words: [] }], activeBookId: 'b1' },
                articles: { updatedAt: '2026-01-01T00:00:00.000Z', analyzedArticles: [], articleMetas: [] }
            }
        }
    }));
    hit('snapshotEmptyArticles', await api.call('/snapshot', {
        method: 'POST',
        body: {
            expected_version: 1,
            payload: {
                vocabulary: { updatedAt: '2026-01-02T00:00:00.000Z', books: [{ id: 'b1', words: [] }], activeBookId: 'b1' },
                articles: { updatedAt: '2026-01-02T00:00:00.000Z', analyzedArticles: [], articleMetas: [] }
            }
        }
    }));
    hit('snapshotRead', await api.call('/snapshot'));

    // --- 舊 ID 與新 ID 並存、完整列表順序 ---
    hit('fullAfterImport', await api.call('/articles?full=1'));
    return results;
}

function assertScenario(r) {
    // 未登入
    assert.equal(r.anonymous.status, 401);
    // 建立與冪等
    assert.equal(r.create.status, 201);
    assert.equal(r.create.body.article.revision, 1);
    assert.equal(r.create.body.article.body, DOC_A.body);
    assert.deepEqual(r.create.body.article.analysis, DOC_A.analysis);
    assert.equal(r.createRetry.status, 200);
    assert.equal(r.createRetry.body.idempotent, true);
    assert.equal(r.createRetry.body.article.revision, 1);
    assert.equal(r.createConflict.status, 409);
    assert.equal(r.createConflict.body.code, 'article_id_exists');
    // 單篇與列表
    assert.equal(r.readOne.status, 200);
    assert.equal(r.listFull.status, 200);
    assert.equal(r.listFull.body.articles.length, 1);
    assert.equal(r.listFull.body.articles[0].body, undefined, '列表不應回傳正文');
    assert.equal(r.listFull.body.articles[0].analysis, undefined, '列表不應回傳分析結果');
    // 跨帳戶
    assert.equal(r.bobReadsAlice.status, 404);
    assert.equal(r.bobUpdatesAlice.status, 404);
    assert.equal(r.bobDeletesAlice.status, 404);
    assert.equal(r.bobCreateSameId.status, 201, '文章 ID 以擁有人為範圍，不同帳戶可各自使用');
    assert.equal(r.bobReadOwn.body.article.body, 'Bob body');
    // 版本
    assert.equal(r.updateNoRevision.status, 400);
    assert.equal(r.updateNoRevision.body.code, 'expected_revision_required');
    assert.equal(r.updateWrongRevision.status, 409);
    assert.equal(r.updateWrongRevision.body.code, 'article_revision_conflict');
    assert.equal(r.updateWrongRevision.body.current.revision, 1);
    assert.equal(r.update.status, 200);
    assert.equal(r.update.body.article.revision, 2);
    assert.equal(r.updateRetry.status, 200);
    assert.equal(r.updateRetry.body.idempotent, true);
    assert.equal(r.updateRetry.body.article.revision, 2);
    assert.equal(r.updateAgain.body.article.revision, 3);
    assert.equal(r.updateStaleAfterRename.status, 409);
    // 游標
    assert.equal(r.deltaFromZero.status, 200);
    assert.equal(r.deltaFromZero.body.resetRequired, false);
    assert.ok(r.deltaFromZero.body.changes.length >= 1);
    assert.equal(r.deltaFromZero.body.changes.at(-1).title, 'Alpha renamed twice');
    assert.equal(r.deltaNoChange.body.changes.length, 0);
    assert.equal(r.deltaInvalid.body.resetRequired, true);
    // 批次
    assert.equal(r.batch.body.articles.length, 1, '重複 ID 只回一次，不存在的 ID 不回');
    // 刪除復原
    assert.equal(r.deleteWrongRevision.status, 409);
    assert.equal(r.delete.status, 200);
    assert.equal(r.delete.body.article.deletedAt.length > 0, true);
    assert.equal(r.deleteRetry.body.idempotent, true);
    assert.equal(r.readDeleted.status, 200);
    assert.equal(r.readDeleted.body.deleted, true);
    assert.equal(r.listAfterDelete.body.articles.length, 0);
    assert.equal(r.listIncludingDeleted.body.articles.length, 1);
    assert.equal(r.updateDeleted.status, 409);
    assert.equal(r.updateDeleted.body.code, 'article_already_deleted');
    assert.equal(r.restoreNotDeleted.status, 409);
    assert.equal(r.restore.status, 200);
    assert.equal(r.restore.body.article.deletedAt, '');
    assert.equal(r.restoreRetry.body.idempotent, true);
    assert.equal(r.readRestored.body.deleted, false);
    const ops = r.deltaAfterRestore.body.changes.map((c) => c.op);
    assert.deepEqual(ops.slice(-3), ['delete', 'restore'], `刪除／復原應留下變更事件，實際：${ops.join(',')}`);
    // 容量
    assert.equal(r.bodyTooLarge.status, 413);
    assert.equal(r.bodyTooLarge.body.code, 'article_too_large');
    assert.equal(r.docTooLarge.status, 413);
    assert.equal(r.usage.status, 200);
    assert.ok(r.usage.body.totalBytes > 0);
    assert.equal(r.usage.body.legacyWriteBlocked, false);
    // 匯入
    assert.equal(r.import.body.imported, 2);
    assert.equal(r.import.body.skipped, 0);
    assert.equal(r.importRetry.body.imported, 0);
    assert.equal(r.importRetry.body.skipped, 2, '重試不得重複新增');
    assert.equal(r.importInvalid.body.invalid, 1);
    assert.equal(r.importFinalGated.body.legacyWriteBlocked, true);
    // 舊閘門
    assert.equal(r.snapshotBlocked.status, 409);
    assert.equal(r.snapshotBlocked.body.code, 'articles_legacy_write_blocked');
    assert.equal(r.snapshotBlocked.body.upgradeRequired, true);
    assert.equal(r.snapshotOtherGroups.status, 200, '其他群組的快照同步必須照常');
    assert.equal(r.snapshotEmptyArticles.status, 200, '空文章群組不算舊資料寫入');
    assert.ok(r.snapshotRead.body.payload.vocabulary, '其他群組仍在快照中');
    assert.equal(r.snapshotRead.body.payload.articles, undefined, '遷移後快照不再回傳舊文章群組');
    // 匯入後完整列表：A 的 3 篇（1 篇刪除後復原＋2 篇舊資料）
    assert.equal(r.fullAfterImport.body.articles.length, 3);
    assert.ok(r.fullAfterImport.body.articles.every((item) => item.title && item.id));
}

test('Worker D1：文章協議與權限', async () => {
    const { db, raw, dir } = freshSqlite(join(ROOT, 'cloudflare-worker/schema.sql'));
    try {
        assertScenario(await runScenario(workerApi(db)));
    } finally {
        raw.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test('selfhost SQLite：文章協議與權限（與 Worker 一致）', async () => {
    const { raw, file, dir } = freshSqlite(join(ROOT, 'selfhost/schema.sql'));
    raw.close(); // 交給 server 自己開
    const server = await startSelfhost(file);
    try {
        assertScenario(await runScenario(httpApi(server.base)));
    } finally {
        await server.stop();
        rmSync(dir, { recursive: true, force: true });
    }
});

test('容量規則：單篇、總量與筆數', () => {
    const limits = ARTICLE_LIMITS;
    assert.equal(checkQuota({ usage: { count: 0, totalBytes: 0 }, nextSize: limits.maxArticleBytes + 1 }).error, 'article_too_large');
    assert.equal(checkQuota({ usage: { count: 0, totalBytes: 0 }, nextSize: 10 }).ok, true);
    assert.equal(checkQuota({
        usage: { count: 10, totalBytes: limits.maxUserBytes },
        nextSize: limits.maxArticleBytes,
        isCreate: true
    }).error, 'article_quota_exceeded');
    assert.equal(checkQuota({ usage: { count: limits.maxCount, totalBytes: 0 }, nextSize: 1, isCreate: true }).error, 'article_count_exceeded');
    // 更新既有文章時不重複計算它原本的大小
    const reused = checkQuota({
        usage: { count: 5, totalBytes: limits.maxUserBytes },
        nextSize: 1000,
        currentRow: { size_bytes: 2000 },
        isCreate: false
    });
    assert.equal(reused.ok, true);
    assert.equal(reused.totalBytes, limits.maxUserBytes - 1000);
});

test('舊快照判定：空群組不算舊文章寫入', () => {
    assert.equal(snapshotCarriesArticles({ articles: { analyzedArticles: [], articleMetas: [] } }), false);
    assert.equal(snapshotCarriesArticles({ articles: { analyzedArticles: [{ article: 'x' }] } }), true);
    assert.equal(snapshotCarriesArticles({ articles: { articleMetas: [{ id: 'a' }] } }), true);
    assert.equal(snapshotCarriesArticles({ vocabulary: {} }), false);
});

function seedLegacySnapshot(raw, payload, version = 1) {
    raw.prepare('INSERT OR REPLACE INTO snapshots (user_id, version, updated_at, payload) VALUES (?, ?, ?, ?)')
        .run('alice', version, '2026-01-01T00:00:00.000Z', JSON.stringify(payload));
}

async function runSnapshotGateScenario(api) {
    const before = await api.call('/snapshot');
    assert.equal(before.status, 200);
    assert.equal(before.body.version, 1);
    assert.ok(before.body.payload.articles, '測試前應有舊文章群組');

    const final = await api.call('/articles/import', { method: 'POST', body: { articles: [], final: true } });
    assert.equal(final.status, 200);
    assert.equal(final.body.legacyWriteBlocked, true);

    // 舊版本條件讀取必須拿到新版本與已移除的文章群組，不能回 notModified。
    const conditional = await api.call('/snapshot?version=1');
    assert.equal(conditional.status, 200);
    assert.equal(conditional.body.notModified, undefined);
    assert.equal(conditional.body.version, 2);
    assert.equal(conditional.body.payload.articles, undefined, '關閘後仍回傳舊文章群組');
    assert.ok(conditional.body.payload.vocabulary, '其他群組應保留');

    // 不帶 version 的舊客戶端也必須看到同一份有效內容。
    const legacyClient = await api.call('/snapshot');
    assert.equal(legacyClient.body.version, 2);
    assert.equal(legacyClient.body.payload.articles, undefined);
    assert.ok(legacyClient.body.payload.vocabulary);

    // 舊客戶端仍試圖寫回文章群組時必須被閘門擋下。
    const blocked = await api.call('/snapshot', {
        method: 'POST',
        body: { expected_version: 2, payload: { articles: { analyzedArticles: [{ article: 'old' }] } } }
    });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, 'articles_legacy_write_blocked');
}

test('Worker D1：文章關閘原子推進快照版本，舊版本條件讀取不再命中', async () => {
    const { db, raw, dir } = freshSqlite(join(ROOT, 'cloudflare-worker/schema.sql'));
    try {
        seedLegacySnapshot(raw, {
            articles: { analyzedArticles: [{ article: 'Old', result: {} }], articleMetas: [] },
            vocabulary: { updatedAt: '2026-01-01T00:00:00.000Z', books: [{ id: 'b1', words: [] }] }
        });
        await runSnapshotGateScenario(workerApi(db));
    } finally {
        raw.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test('selfhost SQLite：文章關閘快照版本契約與 Worker 一致', async () => {
    const { raw, file, dir } = freshSqlite(join(ROOT, 'selfhost/schema.sql'));
    seedLegacySnapshot(raw, {
        articles: { analyzedArticles: [{ article: 'Old', result: {} }], articleMetas: [] },
        vocabulary: { updatedAt: '2026-01-01T00:00:00.000Z', books: [{ id: 'b1', words: [] }] }
    });
    raw.close();
    const server = await startSelfhost(file);
    try {
        await runSnapshotGateScenario(httpApi(server.base));
    } finally {
        await server.stop();
        rmSync(dir, { recursive: true, force: true });
    }
});
