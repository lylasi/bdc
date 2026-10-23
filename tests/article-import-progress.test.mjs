// 舊文章匯入的續傳與舊回執：使用真實 article-store 持久化路徑（fake
// IndexedDB 仍保留跨交易／重新載入的資料），不是測試自己維護的 Set。
//
// Usage: node --test --test-timeout=180000 tests/article-import-progress.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeIndexedDB, FakeObjectStore } from './helpers/fake-indexeddb.mjs';

const storage = new Map();
globalThis.localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => { storage.set(key, String(value)); },
    removeItem: (key) => { storage.delete(key); }
};
globalThis.window = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
globalThis.document = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, hidden: false };
globalThis.CustomEvent = class CustomEvent {
    constructor(type, init = {}) { this.type = type; this.detail = init && init.detail; }
};
globalThis.Audio = class {
    play() { return Promise.resolve(); }
    pause() {}
    addEventListener() {}
    removeEventListener() {}
};
globalThis.indexedDB = createFakeIndexedDB();
globalThis.__BDC_SYNC_ENDPOINT__ = 'https://worker.mock';

const { syncArticles, articleContentKey } = await import('../modules/article-sync.js');
const store = await import('../modules/article-store.js');

const ENDPOINT = 'https://worker.mock';
const originalPut = FakeObjectStore.prototype.put;
let failDocIds = null;
let failStateWrites = false;

FakeObjectStore.prototype.put = function put(value, key) {
    if (this.name === 'state' && failStateWrites) {
        throw new Error('injected state write failure');
    }
    if (this.name === 'docs' && value && failDocIds && failDocIds.has(value.id)) {
        failDocIds.delete(value.id);
        // 在交易「執行時」失敗：前面 49 篇的寫入已排入，必須整批回滾。
        return this.injectFailure('injected docs write failure');
    }
    return originalPut.call(this, value, key);
};

function scopeFor(user) {
    return `${ENDPOINT}::${user}`;
}

async function startScope(user) {
    localStorage.setItem('sync_token', 'test-token');
    localStorage.setItem('sync_user_id', user);
    await store.reloadScope(scopeFor(user));
}

function legacyEntries(count, prefix = 'legacy') {
    return Array.from({ length: count }, (_, index) => ({
        articleId: `${prefix}-${index}`,
        title: `${prefix}-${index}`,
        article: `body ${prefix}-${index}`,
        result: null,
        sourceType: 'url',
        sourceUrl: `https://example.com/${prefix}-${index}`
    }));
}

function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}

test('內容指紋：稀疏陣列與 JSON 往返一致，不同順序仍不同', () => {
    const base = { title: 't', body: 'b', sourceType: 'paste', sourceUrl: '' };
    const sparse = Array(1);
    const roundTripped = JSON.parse(JSON.stringify({ analysis: sparse })).analysis;
    assert.deepEqual(roundTripped, [null]);
    assert.equal(
        articleContentKey({ ...base, analysis: sparse }),
        articleContentKey({ ...base, analysis: roundTripped }),
        'Array(1) 的指紋與 JSON 往返結果不同'
    );
    assert.equal(
        articleContentKey({ ...base, analysis: Array(3) }),
        articleContentKey({ ...base, analysis: [null, null, null] })
    );
    assert.notEqual(
        articleContentKey({ ...base, analysis: [1, 2] }),
        articleContentKey({ ...base, analysis: [2, 1] }),
        '不同陣列順序仍必須產生不同指紋'
    );
});

function createServer() {
    const state = {
        articles: new Map(),
        seq: 0,
        importCalls: 0,
        importPayloads: [],
        batchCalls: 0,
        finalCalls: 0,
        createCalls: 0,
        deleteCalls: 0,
        deletePayloads: [],
        failWrites: false,
        hooks: {}
    };
    const fetch = async (url, options = {}) => {
        const parsed = new URL(url);
        const path = parsed.pathname;
        const method = options.method || 'GET';
        const body = options.body ? JSON.parse(options.body) : null;
        if (path === '/articles/import' && method === 'POST') {
            state.importCalls += 1;
            if (Array.isArray(body?.articles) && body.articles.length) {
                state.importPayloads.push(body.articles.map((item) => item.legacyId));
                await state.hooks.beforeImport?.({ body });
            }
            const ids = [];
            let skipped = 0;
            const at = new Date().toISOString();
            for (const item of body?.articles || []) {
                const id = String(item.legacyId || item.id || '');
                if (state.articles.has(id)) { skipped += 1; continue; }
                state.seq += 1;
                state.articles.set(id, {
                    id,
                    title: item.title || '',
                    body: item.body || '',
                    analysis: item.analysis ?? null,
                    sourceType: item.sourceType || 'paste',
                    sourceUrl: item.sourceUrl || '',
                    revision: 1,
                    updatedAt: at,
                    deletedAt: ''
                });
                ids.push(id);
            }
            if (body?.final === true) state.finalCalls += 1;
            await state.hooks.afterImport?.({ body, ids });
            return jsonResponse({
                imported: ids.length,
                skipped,
                invalid: 0,
                ids,
                cursor: state.seq,
                legacyWriteBlocked: body?.final === true || state.finalCalls > 0
            });
        }
        if (path === '/articles/batch' && method === 'POST') {
            state.batchCalls += 1;
            const ids = body?.ids || [];
            // 查詢結果在請求當下就決定（與真實 Worker 一致）；hook 只延後
            // 「回應送達」，不會讓等待期間的遠端變更影響這次查詢結果。
            const articles = ids.map((id) => state.articles.get(id)).filter((doc) => doc && !doc.deletedAt);
            await state.hooks.batch?.({ ids, call: state.batchCalls, articles });
            return jsonResponse({ articles });
        }
        if (path === '/articles' && method === 'GET') {
            return jsonResponse({
                resetRequired: false,
                cursor: state.seq,
                serverCursor: state.seq,
                changes: [],
                hasMore: false
            });
        }
        if (path === '/articles' && method === 'POST') {
            state.createCalls += 1;
            if (state.failWrites) return jsonResponse({ code: 'temporary_failure' }, 503);
            const id = String(body?.id || '');
            if (state.articles.has(id)) return jsonResponse({ code: 'article_id_exists' }, 409);
            state.seq += 1;
            const at = new Date().toISOString();
            state.articles.set(id, {
                id,
                title: body.title || '',
                body: body.body || '',
                analysis: body.analysis ?? null,
                sourceType: body.sourceType || 'paste',
                sourceUrl: body.sourceUrl || '',
                revision: 1,
                updatedAt: at,
                deletedAt: ''
            });
            return jsonResponse({ article: state.articles.get(id) }, 201);
        }
        const single = path.match(/^\/articles\/([^/]+)$/);
        if (single) {
            const id = decodeURIComponent(single[1]);
            if (state.failWrites) return jsonResponse({ code: 'temporary_failure' }, 503);
            const existing = state.articles.get(id);
            if (!existing) return jsonResponse({ code: 'article_not_found' }, 404);
            if (method === 'PUT') {
                if (Number(body?.expectedRevision) !== Number(existing.revision)) {
                    return jsonResponse({ code: 'article_revision_conflict', current: existing }, 409);
                }
                state.seq += 1;
                const next = {
                    ...existing,
                    title: body.title ?? existing.title,
                    body: body.body ?? existing.body,
                    analysis: body.analysis ?? existing.analysis,
                    revision: existing.revision + 1,
                    updatedAt: new Date().toISOString()
                };
                state.articles.set(id, next);
                return jsonResponse({ article: next });
            }
            if (method === 'DELETE') {
                state.deleteCalls += 1;
                state.deletePayloads.push(body || {});
                // 與真實 Worker 一致：expectedRevision 必須是 >= 1 的整數。
                if (!Number.isInteger(Number(body?.expectedRevision)) || Number(body?.expectedRevision) < 1) {
                    return jsonResponse({ code: 'expected_revision_required' }, 400);
                }
                if (Number(body?.expectedRevision) !== Number(existing.revision)) {
                    return jsonResponse({ code: 'article_revision_conflict', current: existing }, 409);
                }
                state.seq += 1;
                const next = { ...existing, revision: existing.revision + 1, deletedAt: new Date().toISOString() };
                state.articles.set(id, next);
                return jsonResponse({ article: next });
            }
        }
        return jsonResponse({ code: 'not_found' }, 404);
    };
    return { state, fetch };
}

async function waitFor(predicate, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('waitFor timeout');
}

test('核對等待期間的正文／分析／刪除不被舊回執清除，下一輪才收斂', async () => {
    const server = createServer();
    globalThis.fetch = server.fetch;
    try {
        await startScope('old-receipt');
        await store.importLegacyArticles([
            { articleId: 'body-a', title: 'Body A', article: 'old body', sourceType: 'paste' },
            { articleId: 'analysis-a', title: 'Analysis A', article: 'analysis body', sourceType: 'paste' },
            { articleId: 'delete-a', title: 'Delete A', article: 'delete body', sourceType: 'paste' }
        ]);
        assert.equal((await store.listPending()).length, 3);

        let releaseBatch;
        let batchArrived;
        const batchGate = new Promise((resolve) => { releaseBatch = resolve; });
        const batchReady = new Promise((resolve) => { batchArrived = resolve; });
        server.state.hooks.batch = async ({ call }) => {
            if (call !== 1) return;
            batchArrived();
            await batchGate;
        };

        const firstSync = syncArticles();
        await batchReady;
        const saved = await store.saveArticle({ articleId: 'body-a', title: 'Body A', body: 'new body' });
        assert.equal(saved.ok, true, JSON.stringify(saved));
        const analyzed = await store.saveAnalysis('analysis-a', { chinese_translation: 'new analysis' });
        assert.equal(analyzed.ok, true, JSON.stringify(analyzed));
        const deleted = await store.deleteArticle('delete-a');
        assert.equal(deleted.ok, true, JSON.stringify(deleted));

        const pendingDuringVerify = await store.listPending();
        assert.equal(pendingDuringVerify.length, 3, JSON.stringify(pendingDuringVerify));
        // 舊回執還沒回來前，兩個修改仍是 legacy create（伺服器版本未知）；
        // 收到回執後才應被 rebase 成 update，且不能被清掉。
        assert.equal(store.getRecord('body-a')?.pending, true);
        assert.equal(store.getRecord('analysis-a')?.pending, true);

        // 讓核對後的逐篇上傳暫時失敗，才能觀察舊回執是否已誤清 outbox。
        server.state.failWrites = true;
        releaseBatch();
        const first = await firstSync;
        assert.equal(first.ok, true, JSON.stringify(first));
        assert.equal(server.state.finalCalls, 1);
        assert.equal(store.getConflicts().length, 0, JSON.stringify(store.getConflicts()));

        const pendingAfterReceipt = await store.listPending();
        assert.equal(pendingAfterReceipt.length, 3, '舊回執清掉了等待期間的新操作');
        assert.deepEqual(
            pendingAfterReceipt.map((op) => op.type).sort(),
            ['delete', 'update', 'update'],
            JSON.stringify(pendingAfterReceipt)
        );
        assert.equal(store.getRecord('body-a')?.article, 'new body');
        assert.equal(store.getRecord('body-a')?.revision, 1);
        assert.equal(store.getRecord('body-a')?.pending, true);
        assert.equal(store.getRecord('analysis-a')?.revision, 1);
        assert.equal(store.getRecord('delete-a')?.deletedAt !== '', true);

        // 重新載入後仍保留未完成操作，而不是只存在記憶體。
        await store.reloadScope(scopeFor('old-receipt'));
        assert.equal((await store.listPending()).length, 3);
        assert.equal(store.getGatePending(), false);

        server.state.failWrites = false;
        const second = await syncArticles();
        assert.equal(second.ok, true, JSON.stringify(second));
        assert.equal((await store.listPending()).length, 0, JSON.stringify(await store.listPending()));
        assert.equal(server.state.articles.get('body-a')?.body, 'new body');
        assert.deepEqual(server.state.articles.get('analysis-a')?.analysis, { chinese_translation: 'new analysis' });
        assert.equal(Boolean(server.state.articles.get('delete-a')?.deletedAt), true);
        assert.equal(store.getConflicts().length, 0);
    } finally {
        failDocIds = null;
        globalThis.fetch = undefined;
    }
});

test('第二個 50 篇核對在後段寫入失敗：整批回滾，重載後只處理未確認部分', async () => {
    const server = createServer();
    globalThis.fetch = server.fetch;
    try {
        await startScope('resume');
        await store.importLegacyArticles(legacyEntries(120));
        server.state.hooks.batch = ({ ids, call }) => {
            // 讓第二批（第 51～100 篇）的「最後一篇」失敗：前面的 49 篇已排入
            // 同一個交易，必須整批回滾，不能留下部分確認結果。
            if (call === 2) failDocIds = new Set([ids[ids.length - 1]]);
        };

        const first = await syncArticles();
        assert.equal(first.ok, false, JSON.stringify(first));
        assert.ok(['idb_aborted', 'idb_request_failed', 'idb_write_failed'].includes(first.error), JSON.stringify(first));
        assert.equal(server.state.finalCalls, 0, '核對失敗仍送出 final');
        assert.equal(store.getGatePending(), true, '核對失敗仍清掉 gatePending');
        assert.equal(server.state.importPayloads.length, 1);
        assert.equal(server.state.importPayloads[0].length, 100);
        assert.equal(server.state.batchCalls, 2);

        await store.reloadScope(scopeFor('resume'));
        assert.equal(store.getGatePending(), true);
        const pending = await store.listPending();
        assert.equal(pending.length, 70, JSON.stringify(pending));
        // 第二批整批回滾：不能有任何一篇被標成已確認。
        for (let index = 50; index < 100; index += 1) {
            const record = store.getRecord(`legacy-${index}`);
            assert.equal(Number(record?.revision) || 0, 0, `第 ${index} 篇留下部分確認結果`);
            assert.equal(record?.pending, true, `第 ${index} 篇被誤標成已同步`);
        }
        // 第一批 50 篇的進度必須保留。
        for (let index = 0; index < 50; index += 1) {
            const record = store.getRecord(`legacy-${index}`);
            assert.equal(Number(record?.revision), 1, `第 ${index} 篇進度遺失`);
            assert.equal(record?.pending, false, `第 ${index} 篇仍待同步`);
        }

        failDocIds = null;
        server.state.hooks.batch = null;
        const second = await syncArticles();
        assert.equal(second.ok, true, JSON.stringify(second));
        assert.equal(server.state.finalCalls, 1);
        assert.equal(server.state.importPayloads.length, 2);
        assert.equal(server.state.importPayloads[1].length, 70, '重試沒有只處理未確認部分');
        assert.equal(server.state.articles.size, 120);
        assert.equal(server.state.createCalls, 0, '核對失敗後改走逐篇建立');
        assert.equal((await store.listPending()).length, 0);
        assert.equal(store.getGatePending(), false);
    } finally {
        failDocIds = null;
        globalThis.fetch = undefined;
    }
});

test('伺服器已提交但 import 回應遺失：下一輪重新核對、不重複建立', async () => {
    const server = createServer();
    globalThis.fetch = server.fetch;
    try {
        await startScope('response-lost');
        await store.importLegacyArticles(legacyEntries(60, 'lost'));
        let lost = true;
        server.state.hooks.afterImport = ({ body }) => {
            if (!lost || !body?.articles?.length) return;
            lost = false;
            throw new Error('connection lost after commit');
        };

        await assert.rejects(() => syncArticles(), /sync_unreachable|connection lost/);
        assert.equal(server.state.articles.size, 60, '伺服器端應已提交');
        assert.equal(server.state.finalCalls, 0);
        assert.equal(store.getGatePending(), true);
        assert.equal((await store.listPending()).length, 60);

        const second = await syncArticles();
        assert.equal(second.ok, true, JSON.stringify(second));
        assert.equal(server.state.finalCalls, 1);
        assert.equal(server.state.articles.size, 60);
        assert.equal(server.state.createCalls, 0, '回應遺失後改走逐篇建立');
        assert.deepEqual(server.state.importPayloads.map((ids) => ids.length), [60, 60]);
        assert.equal((await store.listPending()).length, 0);
        assert.equal(store.getGatePending(), false);
    } finally {
        failDocIds = null;
        globalThis.fetch = undefined;
    }
});

test('回應遺失後修改分析／正文／刪除：先確認原匯入再 rebase，最新內容仍到達遠端', async () => {
    const server = createServer();
    globalThis.fetch = server.fetch;
    try {
        await startScope('lost-edit');
        await store.importLegacyArticles([
            { articleId: 'keep-a', title: 'Keep A', article: 'keep body', sourceType: 'paste' },
            { articleId: 'analysis-a', title: 'Analysis A', article: 'analysis body', sourceType: 'paste' },
            { articleId: 'body-a', title: 'Body A', article: 'old body', sourceType: 'paste' },
            { articleId: 'delete-a', title: 'Delete A', article: 'delete body', sourceType: 'paste' }
        ]);
        const originalOps = await store.listPending();
        const originalMutation = new Map(originalOps.map((op) => [op.articleId, op.clientMutationId]));

        let lost = true;
        server.state.hooks.afterImport = ({ body }) => {
            if (!lost || !body?.articles?.length) return;
            lost = false;
            throw new Error('connection lost after commit');
        };

        await assert.rejects(() => syncArticles(), /sync_unreachable|connection lost/);
        assert.equal(server.state.articles.size, 4, '伺服器端應已提交');
        assert.equal(server.state.finalCalls, 0);
        assert.equal(store.getGatePending(), true);
        assert.equal((await store.listPending()).length, 4);

        // 只改分析（正文不變）：舊版核對只比 title／body 就會把新操作誤判完成。
        assert.equal((await store.saveAnalysis('analysis-a', { chinese_translation: 'new analysis' })).ok, true);
        assert.equal((await store.saveArticle({ articleId: 'body-a', title: 'Body A', body: 'new body' })).ok, true);
        assert.equal((await store.deleteArticle('delete-a')).ok, true);
        await store.reloadScope(scopeFor('lost-edit'));

        // 這一輪讓逐篇寫入失敗，才能驗證核對是否已把等待中的新操作誤清。
        server.state.failWrites = true;
        const retry = await syncArticles();
        assert.equal(retry.ok, true, JSON.stringify(retry));
        assert.equal(server.state.finalCalls, 1);
        assert.equal(store.getGatePending(), false);
        assert.equal(store.getConflicts().length, 0, JSON.stringify(store.getConflicts()));
        const pending = await store.listPending();
        assert.equal(pending.length, 3, JSON.stringify(pending));
        assert.deepEqual(pending.map((op) => op.type).sort(), ['delete', 'update', 'update']);
        assert.ok(pending.every((op) => Number(op.expectedRevision) === 1), JSON.stringify(pending));
        assert.ok(pending.every((op) => !op.importSnapshot), JSON.stringify(pending));
        // 新修改還沒送出，但本機內容仍在、仍等待同步；伺服器仍是原匯入內容。
        assert.equal(server.state.articles.get('analysis-a').analysis, null);
        assert.deepEqual(store.getRecord('analysis-a')?.result, { chinese_translation: 'new analysis' });
        assert.equal(store.getRecord('analysis-a')?.pending, true);
        assert.equal(store.getRecord('body-a')?.article, 'new body');
        assert.equal(store.getRecord('delete-a')?.deletedAt !== '', true);

        // 重複的舊回執不得重新排入或清掉已 rebase 的操作。
        const duplicate = await store.markOpsDone([{
            articleId: 'analysis-a',
            revision: 1,
            clientMutationId: originalMutation.get('analysis-a')
        }]);
        assert.equal(duplicate.ok, true, JSON.stringify(duplicate));
        const afterDuplicate = await store.listPending();
        assert.equal(afterDuplicate.length, 3, JSON.stringify(afterDuplicate));
        assert.equal(afterDuplicate.find((op) => op.articleId === 'analysis-a')?.importSnapshot, undefined);
        assert.equal(store.getRecord('analysis-a')?.pending, true);

        server.state.failWrites = false;
        const done = await syncArticles();
        assert.equal(done.ok, true, JSON.stringify(done));
        assert.equal((await store.listPending()).length, 0);
        assert.equal(store.getConflicts().length, 0);
        assert.equal(server.state.createCalls, 0, '回應遺失後改走逐篇建立');
        assert.equal(server.state.articles.size, 4, '重複建立了文章');
        assert.deepEqual(server.state.articles.get('analysis-a').analysis, { chinese_translation: 'new analysis' });
        assert.equal(server.state.articles.get('body-a').body, 'new body');
        assert.equal(Boolean(server.state.articles.get('delete-a').deletedAt), true);
    } finally {
        failDocIds = null;
        failStateWrites = false;
        globalThis.fetch = undefined;
    }
});

test('遠端內容不同且衝突 metadata 寫入失敗：不得回報成功、不送 final、gate 保持 pending', async () => {
    const server = createServer();
    globalThis.fetch = server.fetch;
    const at = new Date().toISOString();
    try {
        await startScope('conflict-state');
        // 另一個裝置已用同一個 legacy ID 匯入不同內容。
        server.state.articles.set('conflict-a', {
            id: 'conflict-a',
            title: 'Remote',
            body: 'remote body',
            analysis: null,
            sourceType: 'paste',
            sourceUrl: '',
            revision: 1,
            updatedAt: at,
            deletedAt: ''
        });
        await store.importLegacyArticles([
            { articleId: 'conflict-a', title: 'Local', article: 'local body', sourceType: 'paste' }
        ]);
        assert.equal((await store.listPending()).length, 1);

        failStateWrites = true;
        const first = await syncArticles();
        assert.equal(first.ok, false, JSON.stringify(first));
        assert.ok(
            ['idb_aborted', 'idb_request_failed', 'idb_write_failed'].includes(first.error),
            JSON.stringify(first)
        );
        assert.equal(server.state.finalCalls, 0, '衝突 metadata 寫入失敗仍送出 final');
        assert.equal(store.getGatePending(), true, '衝突 metadata 寫入失敗仍清掉 gatePending');
        assert.equal(server.state.createCalls, 0, '衝突失敗後改走逐篇建立');
        assert.equal(server.state.articles.get('conflict-a').title, 'Remote', '本機內容覆寫了遠端');
        assert.equal((await store.listPending()).length, 1);
        assert.equal(store.getConflicts().length, 0, '記憶體留下未持久化的衝突');
        assert.equal(store.getRecord('conflict-a')?.pending, true);

        failStateWrites = false;
        const second = await syncArticles();
        assert.equal(second.ok, true, JSON.stringify(second));
        assert.equal(server.state.finalCalls, 1);
        assert.equal(store.getGatePending(), false);
        assert.equal(store.getConflicts().length, 1, JSON.stringify(store.getConflicts()));
        assert.equal((await store.listPending()).length, 1, '有衝突的操作不應被清掉');
        assert.equal(server.state.createCalls, 0);

        await store.reloadScope(scopeFor('conflict-state'));
        assert.equal(store.getConflicts().length, 1, '衝突重載後消失');
        assert.equal(store.getConflicts()[0].articleId, 'conflict-a');
    } finally {
        failDocIds = null;
        failStateWrites = false;
        globalThis.fetch = undefined;
    }
});

test('preflight 核對 A 期間修改 B／刪除 C：重新核對舊快照，不覆蓋成假衝突', async () => {
    const server = createServer();
    globalThis.fetch = server.fetch;
    try {
        await startScope('ab-preflight');
        await store.importLegacyArticles([
            { articleId: 'ab-analysis', title: 'AB analysis', article: 'analysis body', sourceType: 'paste' },
            { articleId: 'ab-body', title: 'AB body', article: 'old body', sourceType: 'paste' },
            { articleId: 'ab-delete', title: 'AB delete', article: 'delete body', sourceType: 'paste' }
        ]);
        let lost = true;
        server.state.hooks.afterImport = ({ body }) => {
            if (!lost || !body?.articles?.length) return;
            lost = false;
            throw new Error('connection lost after commit');
        };
        await assert.rejects(() => syncArticles(), /sync_unreachable|connection lost/);
        assert.equal(server.state.articles.size, 3, '伺服器端應已提交');
        assert.equal((await store.listPending()).length, 3);

        // 先修改 A：這一輪 preflight 只會把 A 當成需要核對的對象。
        assert.equal((await store.saveAnalysis('ab-analysis', { chinese_translation: 'A new' })).ok, true);

        let releaseBatch;
        let batchArrived;
        const batchGate = new Promise((resolve) => { releaseBatch = resolve; });
        const batchReady = new Promise((resolve) => { batchArrived = resolve; });
        server.state.hooks.batch = async ({ ids, call }) => {
            if (call !== 1) return;
            assert.deepEqual([...ids].sort(), ['ab-analysis']);
            batchArrived();
            await batchGate;
        };

        const sync = syncArticles();
        await batchReady;
        // 在核對 A 的等待期間才修改 B、刪除 C：它們的 import 快照都還沒核對。
        assert.equal((await store.saveArticle({ articleId: 'ab-body', title: 'AB body', body: 'new body' })).ok, true);
        assert.equal((await store.deleteArticle('ab-delete')).ok, true);
        const during = await store.listPending();
        assert.equal(during.length, 3, JSON.stringify(during));
        releaseBatch();

        const result = await sync;
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal(store.getConflicts().length, 0, JSON.stringify(store.getConflicts()));
        assert.equal((await store.listPending()).length, 0, JSON.stringify(await store.listPending()));
        assert.deepEqual(store.getRecord('ab-analysis')?.result, { chinese_translation: 'A new' });
        assert.equal(store.getRecord('ab-body')?.article, 'new body');
        assert.equal(Boolean(store.getRecord('ab-delete')?.deletedAt), true);
        assert.deepEqual(server.state.articles.get('ab-analysis').analysis, { chinese_translation: 'A new' });
        assert.equal(server.state.articles.get('ab-body').body, 'new body');
        assert.equal(Boolean(server.state.articles.get('ab-delete').deletedAt), true);
        assert.equal(server.state.importPayloads.length, 1, '重試不應重新匯入已確認的項目');
        assert.equal(server.state.createCalls, 0, '核對失敗後改走逐篇建立');
    } finally {
        failDocIds = null;
        globalThis.fetch = undefined;
    }
});

test('未核對的 import 快照不得被新內容覆蓋；確認伺服器缺失後才可清除', async () => {
    const server = createServer();
    globalThis.fetch = server.fetch;
    try {
        await startScope('snapshot-guard');
        await store.importLegacyArticles([
            { articleId: 'guard-a', title: 'Guard', article: 'first body', sourceType: 'paste' }
        ]);
        const op = (await store.listPending()).find((item) => item.articleId === 'guard-a');
        const first = {
            clientMutationId: op.clientMutationId,
            title: 'Guard',
            body: 'first body',
            analysis: null,
            sourceType: 'paste',
            sourceUrl: '',
            submittedAt: 'sent-1'
        };
        const recorded = await store.recordImportSubmission([{ articleId: 'guard-a', snapshot: first }]);
        assert.equal(recorded.ok, true, JSON.stringify(recorded));
        assert.deepEqual(recorded.deferred, []);

        // 另一份內容（新的 mutation）不能蓋掉尚未核對的舊快照。
        const second = {
            ...first,
            clientMutationId: 'm_other',
            body: 'second body',
            submittedAt: 'sent-2'
        };
        const blocked = await store.recordImportSubmission([{ articleId: 'guard-a', snapshot: second }]);
        assert.equal(blocked.ok, true, JSON.stringify(blocked));
        assert.deepEqual(blocked.deferred, ['guard-a']);
        let stored = (await store.listPending()).find((item) => item.articleId === 'guard-a');
        assert.equal(stored.importSnapshot.clientMutationId, op.clientMutationId);
        assert.equal(stored.importSnapshot.body, 'first body');

        // 同一份快照重試（時間戳不同）仍是幂等。
        const repeated = await store.recordImportSubmission([
            { articleId: 'guard-a', snapshot: { ...first, submittedAt: 'sent-3' } }
        ]);
        assert.equal(repeated.ok, true);
        assert.deepEqual(repeated.deferred, []);

        // 版本不符時不得清除。
        const wrong = await store.clearImportSnapshots([
            { articleId: 'guard-a', clientMutationId: 'm_unknown', submittedAt: 'sent-1' }
        ]);
        assert.equal(wrong.ok, true);
        assert.equal(wrong.cleared, 0);
        assert.deepEqual(wrong.deferred, ['guard-a']);

        // 確認伺服器沒有這篇後才清除；操作本身必須保留。
        const cleared = await store.clearImportSnapshots([
            { articleId: 'guard-a', clientMutationId: op.clientMutationId, submittedAt: 'sent-1' }
        ]);
        assert.equal(cleared.ok, true, JSON.stringify(cleared));
        assert.equal(cleared.cleared, 1);
        stored = (await store.listPending()).find((item) => item.articleId === 'guard-a');
        assert.equal(stored.importSnapshot, undefined);
        assert.equal(stored.type, 'create');
    } finally {
        globalThis.fetch = undefined;
    }
});

test('舊快照在伺服器不存在：核對後清除，再以目前內容匯入', async () => {
    const server = createServer();
    globalThis.fetch = server.fetch;
    try {
        await startScope('missing-snapshot');
        await store.importLegacyArticles([
            { articleId: 'ms-a', title: 'MS A', article: 'old body', sourceType: 'paste' }
        ]);
        const op = (await store.listPending())[0];
        const recorded = await store.recordImportSubmission([{
            articleId: 'ms-a',
            snapshot: {
                clientMutationId: op.clientMutationId,
                title: 'MS A',
                body: 'old body',
                analysis: null,
                sourceType: 'paste',
                sourceUrl: '',
                submittedAt: 'sent-before-missing'
            }
        }]);
        assert.equal(recorded.ok, true, JSON.stringify(recorded));
        // 回應遺失後又改了分析：舊快照與目前內容不同，且伺服器其實沒有這篇。
        assert.equal((await store.saveAnalysis('ms-a', { chinese_translation: 'fresh' })).ok, true);

        const result = await syncArticles();
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal(result.legacy.deferred, undefined, JSON.stringify(result.legacy));
        assert.equal(store.getConflicts().length, 0, JSON.stringify(store.getConflicts()));
        assert.deepEqual(server.state.articles.get('ms-a').analysis, { chinese_translation: 'fresh' });
        assert.equal((await store.listPending()).length, 0);
        assert.equal(store.getGatePending(), false);
    } finally {
        globalThis.fetch = undefined;
    }
});

test('文章儲存與 importSnapshot 提交交錯：快照不得被舊 outbox 覆蓋', async () => {
    const server = createServer();
    globalThis.fetch = server.fetch;
    const originalGet = FakeObjectStore.prototype.get;
    const originalGetAll = FakeObjectStore.prototype.getAll;
    let armed = null;
    let interleaves = [];
    const trigger = () => {
        if (!armed) return;
        const entry = armed;
        armed = null;
        interleaves.push(store.recordImportSubmission([entry], store.captureArticleContext()));
    };
    FakeObjectStore.prototype.getAll = function getAll() {
        const request = originalGetAll.call(this);
        if (this.name === 'outbox') trigger();
        return request;
    };
    FakeObjectStore.prototype.get = function get(key) {
        const request = originalGet.call(this, key);
        if (this.name === 'outbox' && armed && String(key).endsWith(`\u0000${armed.articleId}`)) trigger();
        return request;
    };
    try {
        await startScope('snapshot-save-race');
        await store.importLegacyArticles([
            { articleId: 'race-analysis', title: 'Race analysis', article: 'analysis body', sourceType: 'paste' },
            { articleId: 'race-delete', title: 'Race delete', article: 'delete body', sourceType: 'paste' }
        ]);
        const at = new Date().toISOString();
        for (const articleId of ['race-analysis', 'race-delete']) {
            const record = store.getRecord(articleId);
            // 模擬上一次 import 已提交、但回應遺失：伺服器有原內容。
            server.state.articles.set(articleId, {
                id: articleId,
                title: record.title,
                body: record.article,
                analysis: record.result ?? null,
                sourceType: record.sourceType,
                sourceUrl: record.sourceUrl,
                revision: 1,
                updatedAt: at,
                deletedAt: ''
            });
        }
        const ops = await store.listPending();
        const opById = new Map(ops.map((op) => [op.articleId, op]));
        const snapshotFor = (articleId, submittedAt) => {
            const op = opById.get(articleId);
            const record = store.getRecord(articleId);
            return {
                articleId,
                snapshot: {
                    clientMutationId: op.clientMutationId,
                    title: record.title || '',
                    body: record.article || '',
                    analysis: record.result === undefined ? null : record.result,
                    sourceType: record.sourceType || 'paste',
                    sourceUrl: record.sourceUrl || '',
                    submittedAt
                }
            };
        };

        // 修改分析：在儲存尚未提交 outbox 時插入快照提交。
        armed = snapshotFor('race-analysis', 'sent-analysis');
        const saved = await store.saveAnalysis('race-analysis', { chinese_translation: 'new analysis' });
        assert.equal(saved.ok, true, JSON.stringify(saved));
        await Promise.all(interleaves.splice(0));
        let pendingOp = (await store.listPending()).find((op) => op.articleId === 'race-analysis');
        assert.ok(pendingOp.importSnapshot, '剛提交的 import 快照被文章儲存覆蓋');
        assert.equal(pendingOp.importSnapshot.body, 'analysis body');
        assert.deepEqual(pendingOp.payload.analysis, { chinese_translation: 'new analysis' });
        assert.notEqual(pendingOp.clientMutationId, pendingOp.importSnapshot.clientMutationId);

        // 刪除：同樣在儲存提交前插入快照提交。
        armed = snapshotFor('race-delete', 'sent-delete');
        const deleted = await store.deleteArticle('race-delete');
        assert.equal(deleted.ok, true, JSON.stringify(deleted));
        await Promise.all(interleaves.splice(0));
        pendingOp = (await store.listPending()).find((op) => op.articleId === 'race-delete');
        assert.equal(pendingOp.type, 'delete');
        assert.ok(pendingOp.importSnapshot, '刪除操作丟失 import 快照');
        assert.equal(pendingOp.importSnapshot.body, 'delete body');

        // 重新載入後重試：先核對舊快照，再把最新分析與刪除送到遠端。
        await store.reloadScope(scopeFor('snapshot-save-race'));
        const result = await syncArticles();
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal(store.getConflicts().length, 0, JSON.stringify(store.getConflicts()));
        assert.equal((await store.listPending()).length, 0, JSON.stringify(await store.listPending()));
        assert.deepEqual(server.state.articles.get('race-analysis').analysis, { chinese_translation: 'new analysis' });
        assert.equal(Boolean(server.state.articles.get('race-delete').deletedAt), true);
        assert.equal(server.state.createCalls, 0);
    } finally {
        FakeObjectStore.prototype.get = originalGet;
        FakeObjectStore.prototype.getAll = originalGetAll;
        failDocIds = null;
        globalThis.fetch = undefined;
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 第五輪複審：同值新 mutation、核對期間的 delete、舊 missing 回應、404 重建
// ─────────────────────────────────────────────────────────────────────────────

function importLostResponseServer(server) {
    let lost = true;
    server.state.hooks.afterImport = ({ body }) => {
        if (!lost || !body?.articles?.length) return;
        lost = false;
        throw new Error('connection lost after commit');
    };
    return () => { server.state.hooks.afterImport = null; };
}

test('回應遺失後保存相同內容（新 mutation）：先核對舊快照，不持續 deferred', async () => {
    const server = createServer();
    globalThis.fetch = server.fetch;
    try {
        await startScope('same-value');
        await store.importLegacyArticles([
            { articleId: 'same-a', title: 'Same A', article: 'same body', sourceType: 'paste' },
            { articleId: 'other-b', title: 'Other B', article: 'other body', sourceType: 'paste' }
        ]);
        const clearHook = importLostResponseServer(server);
        await assert.rejects(() => syncArticles(), /sync_unreachable|connection lost/);
        clearHook();
        assert.equal(server.state.articles.size, 2, '伺服器端應已提交');
        assert.equal((await store.listPending()).length, 2);

        // 停止編輯後再保存一次完全相同的內容：操作換了新的 mutation ID，
        // 舊快照仍留在 outbox。若 preflight 只比內容就會一直 deferred。
        const saved = await store.saveArticle({ articleId: 'same-a', title: 'Same A', article: 'same body' });
        assert.equal(saved.ok, true, JSON.stringify(saved));
        const sameOp = (await store.listPending()).find((op) => op.articleId === 'same-a');
        assert.ok(sameOp.importSnapshot, JSON.stringify(sameOp));
        assert.equal(sameOp.payload.body, sameOp.importSnapshot.body);
        assert.notEqual(sameOp.clientMutationId, sameOp.importSnapshot.clientMutationId);

        // 同時還有另一篇真的改了內容：它不能被這篇的延後卡住。
        assert.equal((await store.saveArticle({ articleId: 'other-b', title: 'Other B', article: 'other new' })).ok, true);

        const result = await syncArticles();
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal(result.deferred, undefined, '同值保存後仍在 deferred');
        assert.equal(store.getConflicts().length, 0, JSON.stringify(store.getConflicts()));
        assert.equal((await store.listPending()).length, 0, JSON.stringify(await store.listPending()));
        assert.equal(store.getGatePending(), false, 'gate 未清除');
        assert.equal(server.state.createCalls, 0, '改走逐篇建立');
        assert.equal(server.state.articles.size, 2, '重複建立了文章');
        assert.equal(server.state.articles.get('same-a').body, 'same body');
        assert.equal(server.state.articles.get('other-b').body, 'other new');
        assert.equal(store.getRecord('same-a')?.revision, server.state.articles.get('same-a').revision);
        assert.equal(store.getRecord('same-a')?.pending, false);
        assert.equal(store.getRecord('other-b')?.revision, server.state.articles.get('other-b').revision);
        // 同值保存只會走一次 update，不會重新匯入。
        assert.equal(server.state.importPayloads.length, 1, '停止編輯後仍重新匯入');
    } finally {
        globalThis.fetch = undefined;
    }
});

test('內容 A→B→A 且快照停在 A：核對舊快照後以新 mutation 更新，不重複導入', async () => {
    const server = createServer();
    globalThis.fetch = server.fetch;
    try {
        await startScope('aba');
        await store.importLegacyArticles([
            { articleId: 'aba-a', title: 'ABA', article: 'A', sourceType: 'paste' }
        ]);
        const clearHook = importLostResponseServer(server);
        await assert.rejects(() => syncArticles(), /sync_unreachable|connection lost/);
        clearHook();
        assert.equal(server.state.articles.get('aba-a').body, 'A');

        assert.equal((await store.saveArticle({ articleId: 'aba-a', title: 'ABA', article: 'B' })).ok, true);
        assert.equal((await store.saveArticle({ articleId: 'aba-a', title: 'ABA', article: 'A' })).ok, true);
        const op = (await store.listPending()).find((item) => item.articleId === 'aba-a');
        assert.equal(op.payload.body, 'A');
        assert.equal(op.importSnapshot.body, 'A');
        assert.notEqual(op.clientMutationId, op.importSnapshot.clientMutationId);

        const result = await syncArticles();
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal(result.deferred, undefined, 'A→B→A 仍在 deferred');
        assert.equal(store.getConflicts().length, 0, JSON.stringify(store.getConflicts()));
        assert.equal((await store.listPending()).length, 0, JSON.stringify(await store.listPending()));
        assert.equal(store.getGatePending(), false);
        assert.equal(server.state.articles.size, 1, '重複建立了文章');
        assert.equal(server.state.createCalls, 0);
        assert.equal(server.state.importPayloads.length, 1, 'A→B→A 不應重新匯入');
        assert.equal(server.state.articles.get('aba-a').body, 'A');
        assert.equal(Number(server.state.articles.get('aba-a').revision), 2);
        assert.equal(store.getRecord('aba-a')?.revision, 2);
    } finally {
        globalThis.fetch = undefined;
    }
});

test('三輪核對期間修改 B／修改 C／刪除 D：當輪 deferred、不送 final、不發 DELETE', async () => {
    const server = createServer();
    globalThis.fetch = server.fetch;
    try {
        await startScope('chain-barrier');
        await store.importLegacyArticles([
            { articleId: 'chain-a', title: 'Chain A', article: 'a body', sourceType: 'paste' },
            { articleId: 'chain-b', title: 'Chain B', article: 'b body', sourceType: 'paste' },
            { articleId: 'chain-c', title: 'Chain C', article: 'c body', sourceType: 'paste' },
            { articleId: 'chain-d', title: 'Chain D', article: 'd body', sourceType: 'paste' }
        ]);
        const clearHook = importLostResponseServer(server);
        await assert.rejects(() => syncArticles(), /sync_unreachable|connection lost/);
        clearHook();
        assert.equal(server.state.articles.size, 4, '伺服器端應已提交');
        assert.equal((await store.listPending()).length, 4);

        // 先讓 A 需要核對，才能在三輪核對的等待期間依序修改 B、修改 C、刪除 D。
        assert.equal((await store.saveAnalysis('chain-a', { chinese_translation: 'A new' })).ok, true);

        const gates = Array.from({ length: 3 }, () => {
            let enter;
            let leave;
            const entered = new Promise((resolve) => { enter = resolve; });
            const wait = new Promise((resolve) => { leave = resolve; });
            return { entered, wait, enter, leave, ids: [] };
        });
        let batchIndex = 0;
        server.state.hooks.batch = async ({ ids }) => {
            const index = batchIndex;
            batchIndex += 1;
            if (index >= gates.length) return;
            gates[index].ids = ids;
            gates[index].enter();
            await gates[index].wait;
        };

        const sync = syncArticles();
        await gates[0].entered;
        assert.deepEqual([...gates[0].ids].sort(), ['chain-a']);
        assert.equal((await store.saveArticle({ articleId: 'chain-b', title: 'Chain B', article: 'b new' })).ok, true);
        gates[0].leave();

        await gates[1].entered;
        assert.deepEqual([...gates[1].ids].sort(), ['chain-b']);
        assert.equal((await store.saveAnalysis('chain-c', { chinese_translation: 'C new' })).ok, true);
        gates[1].leave();

        await gates[2].entered;
        assert.deepEqual([...gates[2].ids].sort(), ['chain-c']);
        assert.equal((await store.deleteArticle('chain-d')).ok, true);
        gates[2].leave();

        const first = await sync;
        assert.equal(first.ok, true, JSON.stringify(first));
        assert.equal(first.deferred, true, '未核對的 delete 沒有讓本輪 deferred');
        assert.equal(first.legacy?.deferred, true);
        assert.equal(server.state.finalCalls, 0, '三輪核對耗盡後仍送出 final');
        assert.equal(store.getGatePending(), true, '未核對的 delete 仍清掉 gatePending');
        assert.equal(server.state.deleteCalls, 0, JSON.stringify(server.state.deletePayloads));
        assert.equal(Boolean(server.state.articles.get('chain-d')?.deletedAt), false);
        const pending = await store.listPending();
        const deleteOp = pending.find((op) => op.articleId === 'chain-d');
        assert.equal(deleteOp?.type, 'delete', JSON.stringify(deleteOp));
        assert.ok(deleteOp.importSnapshot, '刪除操作丟失未核對的 import 快照');
        assert.equal(Number(deleteOp.expectedRevision), 0, JSON.stringify(deleteOp));
        assert.equal(store.getConflicts().length, 0, JSON.stringify(store.getConflicts()));

        // 下一輪：先核對 D 的舊快照（推進到伺服器 revision 1），才以正確的
        // expectedRevision 完成刪除。
        server.state.hooks.batch = null;
        const second = await syncArticles();
        assert.equal(second.ok, true, JSON.stringify(second));
        assert.equal(second.deferred, undefined, JSON.stringify(second));
        assert.equal(server.state.finalCalls, 1);
        assert.equal(store.getGatePending(), false);
        assert.equal(server.state.deleteCalls, 1, JSON.stringify(server.state.deletePayloads));
        assert.equal(Number(server.state.deletePayloads[0].expectedRevision), 1, JSON.stringify(server.state.deletePayloads));
        assert.equal(Boolean(server.state.articles.get('chain-d')?.deletedAt), true);
        assert.equal(server.state.articles.size, 4, '刪除沒有完成或重複建立了文章');
        assert.equal(server.state.createCalls, 0);
        assert.equal((await store.listPending()).length, 0, JSON.stringify(await store.listPending()));
        assert.equal(store.getConflicts().length, 0, JSON.stringify(store.getConflicts()));
        assert.deepEqual(server.state.articles.get('chain-a').analysis, { chinese_translation: 'A new' });
        assert.equal(server.state.articles.get('chain-b').body, 'b new');
        assert.deepEqual(server.state.articles.get('chain-c').analysis, { chinese_translation: 'C new' });
    } finally {
        globalThis.fetch = undefined;
    }
});

test('舊 missing 回應不得刪掉另一個分頁的新快照；下一輪核對 S2 後推送 S3', async () => {
    const server = createServer();
    globalThis.fetch = server.fetch;
    try {
        await startScope('stale-missing');
        await store.importLegacyArticles([
            { articleId: 'stale-a', title: 'Stale', article: 'v1', sourceType: 'paste' }
        ]);
        const original = (await store.listPending()).find((op) => op.articleId === 'stale-a');
        const s1 = {
            clientMutationId: original.clientMutationId,
            title: 'Stale',
            body: 'v1',
            analysis: null,
            sourceType: 'paste',
            sourceUrl: '',
            submittedAt: 'sent-s1'
        };
        assert.equal((await store.recordImportSubmission([{ articleId: 'stale-a', snapshot: s1 }])).ok, true);
        // 第一次送出其實沒到伺服器（伺服器沒有這篇），本機先改一版讓 preflight 去核對。
        assert.equal((await store.saveArticle({ articleId: 'stale-a', title: 'Stale', article: 'v2' })).ok, true);

        let releaseBatch;
        let batchArrived;
        const batchGate = new Promise((resolve) => { releaseBatch = resolve; });
        const batchReady = new Promise((resolve) => { batchArrived = resolve; });
        let held = false;
        server.state.hooks.batch = async () => {
            if (held) return;
            held = true;
            batchArrived();
            await batchGate;
        };

        const sync = syncArticles();
        await batchReady;

        // 等待 missing 回應期間，另一個分頁清掉 S1、提交 S2（伺服器已有 B2），
        // 本機再修改成 S3；S1 的 missing 回應此時才放行。
        const clearedByOther = await store.clearImportSnapshots([
            { articleId: 'stale-a', clientMutationId: s1.clientMutationId, submittedAt: s1.submittedAt }
        ]);
        assert.equal(clearedByOther.ok, true, JSON.stringify(clearedByOther));
        assert.equal(clearedByOther.cleared, 1, JSON.stringify(clearedByOther));
        assert.equal((await store.saveArticle({ articleId: 'stale-a', title: 'Stale', article: 'B2' })).ok, true);
        const otherOp = (await store.listPending()).find((op) => op.articleId === 'stale-a');
        const s2 = {
            clientMutationId: otherOp.clientMutationId,
            title: 'Stale',
            body: 'B2',
            analysis: null,
            sourceType: 'paste',
            sourceUrl: '',
            submittedAt: 'sent-s2'
        };
        assert.equal((await store.recordImportSubmission([{ articleId: 'stale-a', snapshot: s2 }])).ok, true);
        server.state.seq += 1;
        server.state.articles.set('stale-a', {
            id: 'stale-a',
            title: 'Stale',
            body: 'B2',
            analysis: null,
            sourceType: 'paste',
            sourceUrl: '',
            revision: 1,
            updatedAt: new Date().toISOString(),
            deletedAt: ''
        });
        assert.equal((await store.saveArticle({ articleId: 'stale-a', title: 'Stale', article: 'v3' })).ok, true);
        releaseBatch();

        const first = await sync;
        assert.equal(first.ok, true, JSON.stringify(first));
        assert.equal(first.deferred, true, '用舊 missing 結果誤判 S2 已可清除');
        assert.equal(server.state.finalCalls, 0);
        assert.equal(store.getGatePending(), true);
        const afterFirst = (await store.listPending()).find((op) => op.articleId === 'stale-a');
        assert.equal(afterFirst.importSnapshot?.clientMutationId, s2.clientMutationId, 'S2 被舊 missing 回應刪掉');
        assert.equal(afterFirst.payload.body, 'v3');
        assert.equal(server.state.articles.get('stale-a').body, 'B2');
        assert.equal(store.getConflicts().length, 0, JSON.stringify(store.getConflicts()));

        // 下一輪先核對 S2 再推送 S3：無假衝突、不重複建立。
        server.state.hooks.batch = null;
        const second = await syncArticles();
        assert.equal(second.ok, true, JSON.stringify(second));
        assert.equal(second.deferred, undefined, JSON.stringify(second));
        assert.equal(store.getConflicts().length, 0, JSON.stringify(store.getConflicts()));
        assert.equal((await store.listPending()).length, 0, JSON.stringify(await store.listPending()));
        assert.equal(store.getGatePending(), false);
        assert.equal(server.state.articles.size, 1, '重複建立了文章');
        assert.equal(server.state.articles.get('stale-a').body, 'v3');
        assert.equal(Number(server.state.articles.get('stale-a').revision), 2);
        assert.equal(store.getRecord('stale-a')?.revision, 2);
        assert.equal(server.state.importPayloads.length, 0, '核對後仍重新匯入');
        assert.equal(server.state.deleteCalls, 0);
    } finally {
        globalThis.fetch = undefined;
    }
});

test('revision 3 遠端 404：重建後版本基準歸零，後續更新成功', async () => {
    const server = createServer();
    globalThis.fetch = server.fetch;
    try {
        await startScope('rebuild-404');
        await store.importLegacyArticles([
            { articleId: 'rebuild-a', title: 'Rebuild', article: 'v1', sourceType: 'paste' }
        ]);
        const initial = await syncArticles();
        assert.equal(initial.ok, true, JSON.stringify(initial));
        assert.equal(server.state.articles.get('rebuild-a').revision, 1);

        // 推到 revision 3。
        for (const body of ['v2', 'v3']) {
            assert.equal((await store.saveArticle({ articleId: 'rebuild-a', title: 'Rebuild', article: body })).ok, true);
            const result = await syncArticles();
            assert.equal(result.ok, true, JSON.stringify(result));
        }
        assert.equal(server.state.articles.get('rebuild-a').revision, 3);
        assert.equal(store.getRecord('rebuild-a').revision, 3);

        // 遠端被清掉（例如在別的裝置刪除後清空），本機再更新收到 404。
        server.state.articles.delete('rebuild-a');
        assert.equal((await store.saveArticle({ articleId: 'rebuild-a', title: 'Rebuild', article: 'v4' })).ok, true);
        const updateOp = (await store.listPending()).find((op) => op.articleId === 'rebuild-a');
        assert.equal(Number(updateOp.expectedRevision), 3, JSON.stringify(updateOp));

        const firstRound = await syncArticles();
        assert.equal(firstRound.ok, true, JSON.stringify(firstRound));
        assert.equal(store.getRecord('rebuild-a').revision, 0, '404 重建後本機仍停在舊 revision');
        let pending = (await store.listPending()).find((op) => op.articleId === 'rebuild-a');
        assert.equal(pending?.type, 'create', JSON.stringify(pending));
        assert.equal(Number(pending?.expectedRevision), 0, JSON.stringify(pending));
        assert.equal(server.state.articles.has('rebuild-a'), false);

        // 重建前那一次更新的回執若遲到，不得把版本推回 3。
        const stale = await store.markOpsDone([{
            articleId: 'rebuild-a',
            revision: 3,
            clientMutationId: updateOp.clientMutationId
        }]);
        assert.equal(stale.ok, true, JSON.stringify(stale));
        assert.equal(store.getRecord('rebuild-a').revision, 0, '舊回執把重建的版本基準推回去了');
        pending = (await store.listPending()).find((op) => op.articleId === 'rebuild-a');
        assert.equal(Number(pending?.expectedRevision), 0, JSON.stringify(pending));

        // 下一輪建立成功：本機與遠端都是 revision 1。
        const createRound = await syncArticles();
        assert.equal(createRound.ok, true, JSON.stringify(createRound));
        assert.equal(server.state.articles.get('rebuild-a').revision, 1);
        assert.equal(store.getRecord('rebuild-a').revision, 1);
        assert.equal((await store.listPending()).length, 0);
        assert.equal(store.getConflicts().length, 0);

        // 再次修改：expectedRevision 1，不再 409。
        assert.equal((await store.saveArticle({ articleId: 'rebuild-a', title: 'Rebuild', article: 'v5' })).ok, true);
        const finalRound = await syncArticles();
        assert.equal(finalRound.ok, true, JSON.stringify(finalRound));
        assert.equal(store.getConflicts().length, 0, JSON.stringify(store.getConflicts()));
        assert.equal(server.state.articles.get('rebuild-a').body, 'v5');
        assert.equal(Number(server.state.articles.get('rebuild-a').revision), 2);
        assert.equal(store.getRecord('rebuild-a').revision, 2);
        assert.equal((await store.listPending()).length, 0);
    } finally {
        globalThis.fetch = undefined;
    }
});
