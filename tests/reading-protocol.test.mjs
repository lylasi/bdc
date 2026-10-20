// 閱讀資料協議：共用驗證、三方合併，以及 Cloudflare Worker / selfhost 的
// 逐項同步路由一致性。
//
// 用法：node --test tests/reading-protocol.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';

import worker from '../cloudflare-worker/src/worker.js';
import { createD1Adapter, createSqliteDatabase, readResponseBody } from '../selfhost/d1-adapter.js';
import {
    contentVersionOf,
    locateTextAnchor,
    mergeReadingEntity,
    validateReadingMutation
} from '../shared/reading-protocol.mjs';

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
    const dir = mkdtempSync(join(tmpdir(), 'bdc-reading-protocol-'));
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

function mutation({ id = 'm1', entityId = 'li_1', revision = 0, patch } = {}) {
    return {
        mutationId: id,
        entityType: 'learningItem',
        entityId,
        op: 'upsert',
        expectedRevision: revision,
        patch: patch || {
            articleId: 'art_1',
            contentVersion: contentVersionOf('We look forward to meeting you.'),
            kind: 'phrase',
            anchor: { start: 3, end: 23, quote: 'look forward to', prefix: 'We ', suffix: ' meeting' },
            sentence: 'We look forward to meeting you.',
            marked: false,
            understanding: 'unmarked',
            note: ''
        }
    };
}

async function exercise(api) {
    const caps = await api.call('/reading/capabilities');
    assert.equal(caps.status, 200);
    assert.equal(caps.body.learningItemMarked, true);

    const created = await api.call('/reading/mutations', { method: 'POST', body: { mutations: [mutation()] } });
    assert.equal(created.status, 200);
    assert.equal(created.body.results[0].status, 'ok');
    assert.equal(created.body.results[0].revision, 1);

    const idempotent = await api.call('/reading/mutations', { method: 'POST', body: { mutations: [mutation()] } });
    assert.equal(idempotent.body.results[0].status, 'ok');
    assert.equal(idempotent.body.results[0].idempotent, true);
    assert.equal(idempotent.body.results[0].revision, 1);

    const stale = await api.call('/reading/mutations', { method: 'POST', body: { mutations: [mutation({ id: 'm2', revision: 0, patch: { ...mutation().patch, note: 'stale' } })] } });
    assert.equal(stale.body.results[0].status, 'conflict');
    assert.equal(stale.body.results[0].current.revision, 1);

    const updated = await api.call('/reading/mutations', { method: 'POST', body: { mutations: [mutation({ id: 'm3', revision: 1, patch: { ...mutation().patch, marked: true, understanding: 'needs_review', note: '後面接名詞' } })], final: true } });
    assert.equal(updated.body.results[0].status, 'ok');
    assert.equal(updated.body.results[0].revision, 2);
    assert.equal(updated.body.results[0].record.marked, true);
    assert.equal(updated.body.legacyWriteBlocked, true);

    // 同一個 mutationId 換 payload：不可當成冪等成功。
    const mismatch = await api.call('/reading/mutations', { method: 'POST', body: { mutations: [mutation({ id: 'm3', revision: 1, patch: { ...mutation().patch, note: 'different payload' } })] } });
    assert.equal(mismatch.body.results[0].status, 'conflict');
    assert.equal(mismatch.body.results[0].code, 'reading_mutation_mismatch');

    // 兩個請求同時以 revision=2 提交：只能一個成功，ledger / change 都只能一筆。
    const raceA = mutation({ id: 'race-a', revision: 2, patch: { ...mutation().patch, marked: true, understanding: 'needs_review', note: 'race A' } });
    const raceB = mutation({ id: 'race-b', revision: 2, patch: { ...mutation().patch, marked: true, understanding: 'needs_review', note: 'race B' } });
    const raced = await Promise.all([
        api.call('/reading/mutations', { method: 'POST', body: { mutations: [raceA] } }),
        api.call('/reading/mutations', { method: 'POST', body: { mutations: [raceB] } })
    ]);
    const statuses = raced.map((item) => item.body.results[0].status).sort();
    assert.deepEqual(statuses, ['conflict', 'ok']);

    const changes = await api.call('/reading/changes?cursor=0');
    assert.equal(changes.body.changes.length, 3);
    assert.equal(changes.body.changes[1].revision, 2);
    assert.equal(changes.body.legacyWriteBlocked, true);

    const batch = await api.call('/reading/batch', { method: 'POST', body: { keys: [{ entityType: 'learningItem', entityId: 'li_1' }] } });
    assert.equal(batch.body.entities.length, 1);
    assert.equal(batch.body.entities[0].understanding, 'needs_review');
    assert.equal(batch.body.entities[0].marked, true);

    const bob = await api.call('/reading/batch', { method: 'POST', token: BOB, body: { keys: [{ entityType: 'learningItem', entityId: 'li_1' }] } });
    assert.equal(bob.body.entities.length, 0);

    const removed = await api.call('/reading/mutations', {
        method: 'POST',
        body: { mutations: [{ mutationId: 'm4', entityType: 'learningItem', entityId: 'li_1', op: 'delete', expectedRevision: 3 }] }
    });
    assert.equal(removed.body.results[0].status, 'ok');
    assert.equal(removed.body.results[0].revision, 4);
    assert.ok(removed.body.results[0].record.deletedAt);

    const deletedBatch = await api.call('/reading/batch', { method: 'POST', body: { keys: [{ entityType: 'learningItem', entityId: 'li_1' }] } });
    assert.equal(deletedBatch.body.entities[0].deletedAt !== '', true);

    const resurrect = await api.call('/reading/mutations', {
        method: 'POST',
        body: { mutations: [mutation({ id: 'm5', revision: 4, patch: { ...mutation().patch, understanding: 'needs_review', note: 'explicit restore' } })] }
    });
    assert.equal(resurrect.body.results[0].status, 'ok');
    assert.equal(resurrect.body.results[0].record.deletedAt, '');
    assert.equal(resurrect.body.results[0].revision, 5);

    const staleResurrect = await api.call('/reading/mutations', {
        method: 'POST',
        body: { mutations: [{ ...mutation({ id: 'm6', revision: 3, patch: { ...mutation().patch, note: 'stale' } }), op: 'upsert' }] }
    });
    assert.equal(staleResurrect.body.results[0].status, 'conflict');

    // 舊快照不得再整組寫入詞書／聊天。
    const snap = await api.call('/snapshot', {
        method: 'POST',
        body: { expected_version: 0, payload: { vocabulary: { books: [{ id: 'b', words: [] }] } } }
    });
    assert.equal(snap.status, 409);
    assert.equal(snap.body.code, 'reading_legacy_write_blocked');

    // 別的帳戶仍可正常寫入。
    const bobCreate = await api.call('/reading/mutations', {
        method: 'POST',
        token: BOB,
        body: { mutations: [mutation({ id: 'bm1', entityId: 'li_bob', patch: { ...mutation().patch, articleId: 'art_bob' } })] }
    });
    assert.equal(bobCreate.body.results[0].status, 'ok');
}

test('共用三方合併：不同欄位可合併、同欄位保留衝突', () => {
    const base = {
        id: 'li_1',
        articleId: 'art_1',
        contentVersion: 'v1',
        kind: 'phrase',
        anchor: { start: 0, end: 4, quote: 'look', prefix: '', suffix: '' },
        sentence: 'look forward',
        note: 'base',
        understanding: 'unmarked',
        firstViewedAt: '2026-10-01T00:00:00.000Z',
        lastViewedAt: '2026-10-02T00:00:00.000Z',
        revision: 1
    };
    const different = mergeReadingEntity('learningItem', {
        base,
        local: { ...base, note: 'local note', revision: 1 },
        remote: { ...base, understanding: 'needs_review', revision: 2 }
    });
    assert.equal(different.conflicts.length, 0);
    assert.equal(different.record.note, 'local note');
    assert.equal(different.record.understanding, 'needs_review');
    assert.equal(different.record.lastViewedAt, '2026-10-02T00:00:00.000Z');

    const same = mergeReadingEntity('learningItem', {
        base,
        local: { ...base, note: 'local note', revision: 1 },
        remote: { ...base, note: 'remote note', revision: 2 }
    });
    assert.equal(same.conflicts.length, 1);
    assert.equal(same.conflicts[0].field, 'note');
    assert.equal(same.record.note, 'local note');

    const deleted = mergeReadingEntity('learningItem', {
        base,
        local: { ...base, note: 'local edit', revision: 1 },
        remote: { ...base, deletedAt: '2026-10-10T00:00:00.000Z', revision: 2 }
    });
    assert.equal(deleted.conflicts.length, 1);
    assert.equal(deleted.conflicts[0].field, 'deletedAt');
    assert.equal(deleted.record.deletedAt, '');
    assert.equal(deleted.record.note, 'local edit');

    const viewed = mergeReadingEntity('learningItem', {
        base,
        local: { ...base, firstViewedAt: '2026-10-05T00:00:00.000Z', lastViewedAt: '2026-10-05T00:00:00.000Z' },
        remote: { ...base, firstViewedAt: '2026-10-03T00:00:00.000Z', lastViewedAt: '2026-10-09T00:00:00.000Z' }
    });
    assert.equal(viewed.record.firstViewedAt, '2026-10-03T00:00:00.000Z');
    assert.equal(viewed.record.lastViewedAt, '2026-10-09T00:00:00.000Z');

    // 舊後端缺少 marked 時，本機明確 false 不得被洗掉（取消標記不可復活）。
    const markedMissing = mergeReadingEntity('learningItem', {
        base: { ...base, marked: false },
        local: { ...base, marked: false, revision: 1 },
        remote: { ...base, note: 'remote without marked', revision: 2 }
    });
    assert.equal(Object.prototype.hasOwnProperty.call(markedMissing.record, 'marked'), true);
    assert.equal(markedMissing.record.marked, false);

    // 新版遠端明確改變標記時照常採用。
    const markedRemote = mergeReadingEntity('learningItem', {
        base: { ...base, marked: false },
        local: { ...base, marked: false, revision: 1 },
        remote: { ...base, marked: true, revision: 2 }
    });
    assert.equal(markedRemote.record.marked, true);
    assert.equal(markedRemote.conflicts.length, 0);

    // 兩邊明確改成不同值：保留本機並留下衝突，交使用者選擇。
    const markedConflict = mergeReadingEntity('learningItem', {
        base,
        local: { ...base, marked: true, revision: 1 },
        remote: { ...base, marked: false, revision: 2 }
    });
    assert.equal(markedConflict.conflicts.length, 1);
    assert.equal(markedConflict.conflicts[0].field, 'marked');
    assert.equal(markedConflict.record.marked, true);
});

test('引用定位：唯一匹配才回傳精確位置，歧義保留待確認', () => {
    const text = 'We look forward to it. They look forward to it too.';
    const ambiguous = locateTextAnchor(text, 'look forward to', 'We look forward to it.');
    assert.equal(ambiguous.candidates, 2);
    assert.equal(ambiguous.unique, true);
    assert.equal(ambiguous.anchor.start, 3);
    const repeated = locateTextAnchor('bank and bank', 'bank');
    assert.equal(repeated.unique, false);
    assert.equal(repeated.anchor.start, -1);
});

test('mutation 驗證拒絕未知型別與超大 patch', () => {
    const invalidType = validateReadingMutation({ mutationId: 'm', entityType: 'unknown', entityId: 'x', op: 'upsert', expectedRevision: 0, patch: {} });
    assert.equal(invalidType.ok, false);
    const invalidPatch = validateReadingMutation({ mutationId: 'm', entityType: 'learningItem', entityId: 'x', op: 'upsert', expectedRevision: 0, patch: null });
    assert.equal(invalidPatch.ok, false);
});

test('Worker D1 與 selfhost HTTP 的逐項同步行為一致', async () => {
    const stack = freshSqlite(join(ROOT, 'cloudflare-worker/schema.sql'));
    const self = freshSqlite(join(ROOT, 'selfhost/schema.sql'));
    const server = await startSelfhost(self.file);
    try {
        await exercise(workerApi(stack.db));
        await exercise(httpApi(server.base));
    } finally {
        await server.stop();
        stack.raw.close();
        self.raw.close();
        rmSync(stack.dir, { recursive: true, force: true });
        rmSync(self.dir, { recursive: true, force: true });
    }
});
