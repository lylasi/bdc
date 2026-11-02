// 使用真正 Worker、SQLite 與前端 outbox，覆蓋舊 URL ID 被內部 ID 取代的情況。
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import worker from '../cloudflare-worker/src/worker.js';
import { createD1Adapter, createSqliteDatabase } from '../selfhost/d1-adapter.js';
import { createFakeIndexedDB } from './helpers/fake-indexeddb.mjs';

const storage = new Map();
globalThis.localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key),
    key: index => [...storage.keys()][index] || null,
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
globalThis.__BDC_SYNC_ENDPOINT__ = 'https://legacy.mock';

const articles = await import('../modules/article-store.js');
const reading = await import('../modules/reading-store.js');
const { syncArticles, loadArticleForNavigation } = await import('../modules/article-sync.js');
const { syncReading } = await import('../modules/reading-sync.js');
const { readArticleRoute, articleHash } = await import('../modules/article-route.js');
const TOKEN = 'legacy-identity-token'.repeat(3);
const LEGACY_ID = 'url:' + encodeURIComponent('https://example.org/news?story=reading&lang=en');
const DOC = { articleId: LEGACY_ID, article: 'Reading notes stay with their original article.', title: 'Original', result: { meaning: '原文' }, sourceType: 'url', sourceUrl: 'https://example.org/news?story=reading&lang=en' };

async function fixture(name) {
    const db = new DatabaseSync(':memory:');
    db.exec(readFileSync(new URL('../cloudflare-worker/schema.sql', import.meta.url), 'utf8'));
    db.prepare('INSERT INTO users (token_hash, user_id, label, role) VALUES (?, ?, ?, ?)')
        .run(createHash('sha256').update(TOKEN).digest('hex'), name, name, 'user');
    const env = { DB: createD1Adapter(createSqliteDatabase(db)), ALLOWED_ORIGINS: '*' };
    const hooks = {};
    const requests = [];
    const remote = async (path, body) => worker.fetch(new Request('https://legacy.mock' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
    }), env);
    globalThis.fetch = async (url, options = {}) => {
        const path = new URL(url).pathname;
        requests.push({ path, body: options.body && JSON.parse(options.body) });
        const response = await worker.fetch(new Request(url, options), env);
        if (path === '/articles/batch') await hooks.batch?.();
        if (path === '/articles/import' && options.body && JSON.parse(options.body).articles?.length) {
            await hooks.imported?.();
        }
        return response;
    };
    localStorage.setItem('sync_token', TOKEN);
    localStorage.setItem('sync_user_id', name);
    const scope = `https://legacy.mock::${name}`;
    await articles.reloadScope(scope);
    await reading.initReadingStore(scope);
    return { db, env, hooks, requests, remote };
}

async function seedReading(articleId) {
    const item = await reading.upsertLearningItem({ articleId, kind: 'word', anchor: { start: 0, end: 7, quote: 'Reading' }, note: '需要保留的筆記' });
    assert.equal(item.ok, true);
    assert.equal((await reading.saveArticleDocument({ articleId, kind: 'note', title: '心得', content: '完整閱讀心得' })).ok, true);
    const conversation = await reading.ensureConversation({ articleId, title: '文章討論' });
    assert.equal(conversation.ok, true);
    return item;
}

async function seedOldClient(f) {
    const res = await f.remote('/articles/import', { articles: [{ ...DOC, legacyId: LEGACY_ID, body: DOC.article, analysis: DOC.result }] });
    const imported = await res.json();
    const storageId = imported.ids[0];
    await articles.applyRemoteDoc({ id: storageId, body: DOC.article, title: DOC.title, analysis: DOC.result, sourceType: DOC.sourceType, sourceUrl: DOC.sourceUrl, revision: 1 });
    await articles.setCursor(imported.cursor);
    await seedReading(storageId);
    assert.equal((await syncReading()).pending, 0);
    return storageId;
}

test('舊 URL 匯入、核對及後續同步保留原 ID，閱讀資料不斷開也不重複', async () => {
    const f = await fixture('legacy-fresh');
    try {
        assert.equal((await articles.importLegacyArticles([DOC])).ok, true);
        await seedReading(LEGACY_ID);
        const result = await syncArticles();
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal((await articles.listPending()).length, 0);
        assert.equal(articles.getGatePending(), false);
        assert.deepEqual(articles.getRecords().map(record => record.articleId), [LEGACY_ID]);
        assert.equal(reading.listLearningItems(LEGACY_ID)[0].note, '需要保留的筆記');
        assert.equal(reading.listArticleDocuments(LEGACY_ID).length, 1);
        assert.equal(reading.listConversations(LEGACY_ID).length, 1);
        assert.equal((await syncReading()).pending, 0);
        assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM articles').get().n, 1);
        assert.ok(f.db.prepare('SELECT data_json FROM reading_entities').all().every(row => JSON.parse(row.data_json).articleId === LEGACY_ID));
        const saved = await articles.saveArticle({ ...DOC, title: 'Changed after import' });
        assert.equal(saved.ok, true);
        const update = await syncArticles();
        assert.equal(update.pushed.failed, 0, JSON.stringify(update));
        assert.equal(f.db.prepare('SELECT title FROM articles').get().title, 'Changed after import');
        assert.equal((await articles.listPending()).length, 0);
        await syncArticles();
        assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM articles').get().n, 1);
        assert.deepEqual(readArticleRoute(articleHash(LEGACY_ID)), { id: LEGACY_ID, invalid: false });
    } finally { f.db.close(); }
});

test('已匯入但回應遺失後修改文章，重試核對舊快照並把新修改推到同一篇', async () => {
    const f = await fixture('legacy-lost');
    try {
        await articles.importLegacyArticles([DOC]);
        let lost = true;
        f.hooks.imported = async () => {
            if (!lost) return;
            lost = false;
            throw new Error('response lost after commit');
        };
        await assert.rejects(syncArticles());
        assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM articles').get().n, 1);
        assert.equal((await articles.listPending()).length, 1);
        await articles.saveArticle({ ...DOC, title: 'Edit after lost response' });
        const result = await syncArticles();
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal(result.pushed.failed, 0, JSON.stringify(result));
        assert.equal((await articles.listPending()).length, 0);
        assert.equal(f.db.prepare('SELECT title FROM articles').get().title, 'Edit after lost response');
        assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM articles').get().n, 1);
    } finally { f.db.close(); }
});

test('已在雲端的舊文章被 skip 時仍可確認，保留同步期間的新修改', async () => {
    const f = await fixture('legacy-skipped');
    try {
        const res = await f.remote('/articles/import', { articles: [{ ...DOC, legacyId: LEGACY_ID, body: DOC.article, analysis: DOC.result }] });
        assert.equal(res.status, 200);
        await articles.importLegacyArticles([DOC]);
        let edited = false;
        f.hooks.imported = async () => {
            if (edited) return;
            edited = true;
            await articles.saveArticle({ ...DOC, title: 'Edit while verifying skipped import' });
        };
        const result = await syncArticles();
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal(result.legacy.skipped, 1);
        assert.equal((await articles.listPending()).length, 0);
        assert.equal(f.db.prepare('SELECT title FROM articles').get().title, 'Edit while verifying skipped import');
        assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM articles').get().n, 1);
    } finally { f.db.close(); }
});

test('舊內部 ID 書籤仍能開啟原文章', async () => {
    const f = await fixture('legacy-bookmark');
    try {
        const res = await f.remote('/articles/import', { articles: [{ ...DOC, legacyId: LEGACY_ID, body: DOC.article, analysis: DOC.result }] });
        const body = await res.json();
        const result = await loadArticleForNavigation(body.ids[0]);
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal(result.record.articleId, LEGACY_ID);
        assert.equal(result.record.article, DOC.article);
    } finally { f.db.close(); }
});

test('已下載新 ID 的舊裝置升級後保留原有筆記、文件、會話及詞書來源', async () => {
    const f = await fixture('legacy-upgrade');
    try {
        const storageId = await seedOldClient(f);
        await reading.upsertVocabularyBook({ id: 'old-book', name: '生詞', sourceType: 'article', articleId: storageId });
        await reading.upsertVocabularyEntry({ id: 'old-entry', bookId: 'old-book', word: 'Reading', sourceArticleId: storageId, sources: [{ articleId: storageId, sentence: DOC.article }] });
        await reading.addVocabularyLink({ id: 'old-link', itemId: reading.listLearningItems(storageId)[0].id, bookId: 'old-book', entryId: 'old-entry' });
        assert.equal((await syncArticles()).ok, true);
        assert.deepEqual(articles.getRecords().map(record => record.articleId), [LEGACY_ID]);
        assert.equal(articles.getRecord(storageId).articleId, LEGACY_ID);
        assert.equal(articles.getMeta().identityVersion, 1);
        // 模擬冷啟動，從持久摘要恢復 ID 對應；筆記必須按兩個 ID 的索引載入。
        const scope = articles.captureArticleContext().scope;
        await articles.reloadScope(scope);
        await reading.initReadingStore(scope);
        assert.equal((await reading.ensureArticleReadingLoaded(LEGACY_ID)).ok, true);
        assert.equal(reading.listLearningItems(LEGACY_ID)[0].articleId, storageId);
        assert.equal(reading.listArticleDocuments(LEGACY_ID).length, 1);
        assert.equal(reading.listConversations(LEGACY_ID).length, 1);
        const item = reading.listLearningItems(LEGACY_ID)[0];
        const update = await reading.upsertLearningItem({ ...item, articleId: LEGACY_ID, note: '升級後繼續修改筆記' });
        assert.equal(update.entity.articleId, storageId, '既有實體的不可變外鍵必須保留');
        const document = reading.listArticleDocuments(LEGACY_ID, { withContent: true })[0];
        await reading.saveArticleDocument({ ...document, articleId: LEGACY_ID, content: '升級後繼續修改心得' });
        const pushed = await syncReading();
        assert.equal(pushed.pending, 0, JSON.stringify(pushed));
        const snapshot = await reading.exportArticleReading(LEGACY_ID);
        assert.equal(snapshot.ok, true, JSON.stringify(snapshot));
        assert.equal(snapshot.learningItems.length, 1);
        assert.equal(snapshot.articleDocuments.length, 1);
        assert.equal(snapshot.conversations.length, 1);
        assert.equal(snapshot.vocabularyEntries.length, 1);
        assert.equal(snapshot.vocabularyEntries[0].sources[0].articleId, storageId);
        assert.equal(snapshot.vocabularyBooks[0].articleId, storageId);
        assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM articles').get().n, 1);
        await articles.reloadScope('https://legacy.mock::other-user');
        await reading.initReadingStore('https://legacy.mock::other-user');
        assert.equal(articles.sameArticleReference(storageId, LEGACY_ID), false);
        assert.equal(articles.getRecord(storageId), null);
        assert.deepEqual(reading.listLearningItems(LEGACY_ID), []);
    } finally { f.db.close(); }
});

test('舊裝置尚未上傳的新 ID 修改先保留，推送後才清理別名副本', async () => {
    const f = await fixture('legacy-dirty-upgrade');
    try {
        const storageId = await seedOldClient(f);
        await articles.saveArticle({ ...DOC, articleId: storageId, title: '不可丟失的新修改' });
        const result = await syncArticles();
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal(result.pushed.failed, 0);
        assert.equal(f.db.prepare('SELECT title FROM articles').get().title, '不可丟失的新修改');
        assert.equal((await articles.listPending()).length, 0);
        await syncArticles();
        assert.deepEqual(articles.getRecords().map(record => record.articleId), [LEGACY_ID]);
        assert.equal(articles.getMeta().identityVersion, 1);
        assert.equal(reading.listLearningItems(LEGACY_ID)[0].note, '需要保留的筆記');
    } finally { f.db.close(); }
});

test('身份修復的全文下載中斷時，保留原本離線可讀的文章及筆記', async () => {
    const f = await fixture('legacy-upgrade-download-failure');
    try {
        const storageId = await seedOldClient(f);
        f.hooks.batch = async () => { throw new Error('download unavailable'); };
        await assert.rejects(syncArticles());
        const original = await articles.ensureArticleLoaded(storageId);
        assert.equal(original.article, DOC.article);
        assert.equal(reading.listLearningItems(storageId)[0].note, '需要保留的筆記');
        assert.equal(articles.getMeta().identityVersion, 0);
        delete f.hooks.batch;
        assert.equal((await syncArticles()).ok, true);
        assert.deepEqual(articles.getRecords().map(record => record.articleId), [LEGACY_ID]);
        assert.equal(articles.getMeta().identityVersion, 1);
    } finally { f.db.close(); }
});
