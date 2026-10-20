// 閱讀逐項同步的資料可靠性：真實 SQLite + D1 adapter 的並發冪等、
// 重試時間不造成假衝突，以及 patch 欄位不被裁切。
import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import worker from '../cloudflare-worker/src/worker.js';
import { createD1Adapter, createSqliteDatabase } from '../selfhost/d1-adapter.js';
import {
    normalizeReadingPatch,
    readingMutationFingerprint
} from '../shared/reading-protocol.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const TOKEN = 'r'.repeat(40);

function makeEnv(db) {
    db.exec(readFileSync(ROOT + 'cloudflare-worker/schema.sql', 'utf8'));
    db.prepare('INSERT INTO users(token_hash,user_id,label,role) VALUES(?,?,?,?)')
        .run(createHash('sha256').update(TOKEN).digest('hex'), 'reliability-user', 'Reliability', 'user');
    const adapter = createSqliteDatabase(db);
    return { env: { DB: createD1Adapter(adapter), ALLOWED_ORIGINS: '*' }, adapter };
}

async function call(env, mutation) {
    const response = await worker.fetch(new Request('https://sync.example/reading/mutations', {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mutations: [mutation] })
    }), env);
    return { http: response.status, ...(await response.json()) };
}

function baseMutation(overrides = {}) {
    return {
        mutationId: 'shared-mutation',
        entityType: 'learningItem',
        entityId: 'same-entity',
        op: 'upsert',
        expectedRevision: 0,
        patch: {
            articleId: 'article',
            contentVersion: 'cv_test',
            kind: 'word',
            anchor: { start: 0, end: 4, quote: 'test' },
            note: 'Alice'
        },
        ...overrides
    };
}

async function concurrentScenario({ second, verify }) {
    const db = new DatabaseSync(':memory:');
    const { env, adapter } = makeEnv(db);
    let arrivals = 0;
    let release;
    const barrier = new Promise((resolve) => { release = resolve; });
    const originalGet = adapter.get;
    adapter.get = async (sql, params) => {
        const row = await originalGet(sql, params);
        if (sql.startsWith('SELECT * FROM reading_entities') && arrivals < 2) {
            arrivals += 1;
            if (arrivals === 2) release();
            await barrier;
        }
        return row;
    };
    try {
        const responses = await Promise.all([call(env, baseMutation()), call(env, baseMutation(second))]);
        const entities = db.prepare('SELECT entity_id, revision, data_json FROM reading_entities').all();
        const changes = db.prepare('SELECT seq, entity_id FROM reading_changes').all();
        verify(responses, entities, changes);
    } finally {
        db.close();
    }
}

test('同一 mutation 同 payload 並發：第二個回執仍有完整 revision/record', async () => {
    await concurrentScenario({
        second: {},
        verify: (responses, entities, changes) => {
            assert(responses.every((response) => response.results[0].status === 'ok'), JSON.stringify(responses));
            assert(responses.every((response) => response.results[0].revision === 1
                && response.results[0].record?.id === 'same-entity'), JSON.stringify(responses));
            assert.equal(entities.length, 1);
            assert.equal(changes.length, 1);
        }
    });
});

test('同一 mutation 不同 payload 並發：只有一個成功且只寫一筆', async () => {
    await concurrentScenario({
        second: { patch: { ...baseMutation().patch, note: 'Bob' } },
        verify: (responses, entities, changes) => {
            assert.equal(responses.filter((response) => response.results[0].status === 'ok').length, 1, JSON.stringify(responses));
            assert.equal(entities.length, 1);
            assert.equal(changes.length, 1);
        }
    });
});

test('同一 mutation 不同 entityId 並發：不得新增第二個實體或 change', async () => {
    await concurrentScenario({
        second: { entityId: 'other-entity' },
        verify: (responses, entities, changes) => {
            assert.equal(responses.filter((response) => response.results[0].status === 'ok').length, 1, JSON.stringify(responses));
            assert.equal(entities.length, 1, JSON.stringify(entities));
            assert.equal(changes.length, 1);
        }
    });
});

test('重試只改傳輸時間不回報 mutation mismatch，且保留完整回執', async () => {
    const db = new DatabaseSync(':memory:');
    const { env } = makeEnv(db);
    try {
        const first = baseMutation({
            mutationId: 'retry-mutation',
            entityId: 'retry-entity',
            patch: { ...baseMutation().patch, note: 'retry value' },
            clientUpdatedAt: '2026-10-19T10:00:00.000Z'
        });
        const firstResponse = await call(env, first);
        assert.equal(firstResponse.results[0].status, 'ok');
        assert.equal(firstResponse.results[0].revision, 1);
        const secondResponse = await call(env, { ...first, clientUpdatedAt: '2026-10-19T10:00:05.000Z' });
        assert.equal(secondResponse.results[0].status, 'ok', JSON.stringify(secondResponse));
        assert.equal(secondResponse.results[0].idempotent, true);
        assert.equal(secondResponse.results[0].revision, 1);
        assert.equal(secondResponse.results[0].record?.id, 'retry-entity');
    } finally {
        db.close();
    }
});

test('業務指紋忽略鍵順序與傳輸時間，但不忽略 payload / entity', () => {
    const first = baseMutation();
    const reordered = {
        ...first,
        clientUpdatedAt: '2026-10-19T11:00:00.000Z',
        patch: {
            note: 'Alice',
            anchor: { quote: 'test', end: 4, start: 0 },
            kind: 'word',
            contentVersion: 'cv_test',
            articleId: 'article'
        }
    };
    assert.equal(readingMutationFingerprint(first), readingMutationFingerprint(reordered));
    assert.notEqual(readingMutationFingerprint(first), readingMutationFingerprint({ ...first, entityId: 'other' }));
    assert.notEqual(readingMutationFingerprint(first), readingMutationFingerprint({ ...first, patch: { ...first.patch, note: 'Bob' } }));
});

test('AI 來源與詞書來源欄位不被裁切', () => {
    const docPatch = normalizeReadingPatch('articleDocument', {
        sourceItemIds: ['item_x'],
        sourceMessageIds: ['message_y']
    });
    assert.deepEqual(docPatch.sourceItemIds, ['item_x']);
    assert.deepEqual(docPatch.sourceMessageIds, ['message_y']);
    const bookPatch = normalizeReadingPatch('vocabularyBook', {
        name: 'book',
        sourceUrl: 'https://example.com/book',
        shareId: 'share_x'
    });
    assert.equal(bookPatch.sourceUrl, 'https://example.com/book');
    assert.equal(bookPatch.shareId, 'share_x');
    const entryPatch = normalizeReadingPatch('vocabularyEntry', {
        bookId: 'b', word: 'look', sourceArticleId: 'a1', context: 'We look forward.'
    });
    assert.equal(entryPatch.sourceArticleId, 'a1');
    assert.equal(entryPatch.context, 'We look forward.');
});

test('marked 是明確布林值：true 與 false 都不被裁切', () => {
    const on = normalizeReadingPatch('learningItem', { marked: true, note: 'kept' });
    const off = normalizeReadingPatch('learningItem', { marked: false, note: 'kept' });
    assert.equal(on.marked, true);
    assert.equal(off.marked, false);
    assert.equal(Object.prototype.hasOwnProperty.call(off, 'marked'), true);
    assert.equal(normalizeReadingPatch('learningItem', { marked: 'yes' }).marked, false);
});
