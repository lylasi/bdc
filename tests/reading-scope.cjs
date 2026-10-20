/**
 * 閱讀資料 scope／跨分頁回歸（真實 Chromium + 真實 IndexedDB）。
 *
 * 用法：
 *   PORT=8313 PLAYWRIGHT_MODULE=<path-to-playwright> node tests/reading-scope.cjs
 */
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const PORT = Number(process.env.PORT || 8313);
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: CHROME });
    const results = [];
    try {
        const context = await browser.newContext();
        await context.route('**/*', (route) => {
            const url = new URL(route.request().url());
            if (url.pathname.endsWith('/ai-config.js')) {
                return route.fulfill({
                    contentType: 'application/javascript',
                    body: `export const SYNC={endpoint: "${BASE}/review-sync"}; export const TTS_CONFIG={}, AI_LIMITS={}, OCR_CONFIG={}, ARTICLE_IMPORT={}, SUPABASE={};`
                });
            }
            if (url.origin !== BASE) return route.abort();
            return route.continue();
        });
        const page = await context.newPage();
        await page.goto(`${BASE}/test-reading-blank.html`);
        const scopeTest = await page.evaluate(async () => {
            const store = await import('/modules/reading-store.js');
            const db = await import('/modules/permanent-db.js');
            const art = await import('/modules/article-store.js');
            const a = 'review-scope::account-a';
            const b = 'review-scope::account-b';
            await art.reloadScope(b);
            await art.saveArticle({ id: 'private-article', body: 'test sentence', title: 'Shared article ID' });
            await art.reloadScope(a);
            await art.saveArticle({ id: 'private-article', body: 'test sentence', title: 'Shared article ID' });
            await store.initReadingStore(a);
            let release;
            let arrived;
            const held = new Promise((resolve) => { release = resolve; });
            const barrier = new Promise((resolve) => { arrived = resolve; });
            const originalGet = IDBObjectStore.prototype.get;
            let heldOnce = false;
            IDBObjectStore.prototype.get = function get(key) {
                const request = originalGet.call(this, key);
                if (!heldOnce && this.name === 'reading_outbox' && String(key).includes('scope-private-item')) {
                    heldOnce = true;
                    const proxy = { get result() { return request.result; }, get error() { return request.error; } };
                    request.onsuccess = async (event) => { arrived(); await held; proxy.onsuccess?.(event); };
                    request.onerror = (event) => proxy.onerror?.(event);
                    return proxy;
                }
                return request;
            };
            const pending = store.upsertLearningItem({
                id: 'scope-private-item',
                articleId: 'private-article',
                contentVersion: 'cv_scope',
                kind: 'word',
                anchor: { start: 0, end: 4, quote: 'test' },
                note: 'private note for account A'
            });
            await barrier;
            await art.reloadScope(b);
            await store.reloadReadingScope(b);
            release();
            const save = await pending;
            IDBObjectStore.prototype.get = originalGet;
            const rowsA = await db.readStoreAll(db.STORE.READING_ITEMS, a);
            const rowsB = await db.readStoreAll(db.STORE.READING_ITEMS, b);
            const opsB = await db.readStoreAll(db.STORE.READING_OUTBOX, b);
            return {
                save,
                rowsA: rowsA.records,
                rowsB: rowsB.records,
                opsB: opsB.records,
                currentScope: store.getReadingScope(),
                currentItems: store.listLearningItems('private-article')
            };
        });
        try {
            assert.equal(scopeTest.rowsB.length, 0, JSON.stringify(scopeTest));
            assert.equal(scopeTest.opsB.length, 0, JSON.stringify(scopeTest));
            assert.equal(scopeTest.currentItems.length, 0, JSON.stringify(scopeTest));
            results.push({ name: 'queued write during account switch stays in original scope or aborts', ok: true });
        } catch (error) {
            results.push({ name: 'queued write during account switch stays in original scope or aborts', ok: false, error: String(error) });
        }

        const page2 = await context.newPage();
        await page2.goto(`${BASE}/test-reading-blank.html`);
        await Promise.all([page, page2].map((item) => item.evaluate(async () => {
            const store = await import('/modules/reading-store.js');
            const art = await import('/modules/article-store.js');
            await art.reloadScope('review-scope::tabs');
            await art.saveArticle({ id: 'same-article', body: 'test sentence' });
            await store.reloadReadingScope('review-scope::tabs');
        })));
        const writes = await Promise.all([page, page2].map((item) => item.evaluate(async () => {
            const store = await import('/modules/reading-store.js');
            return store.upsertLearningItem({
                articleId: 'same-article',
                contentVersion: 'cv_tabs',
                kind: 'word',
                anchor: { start: 0, end: 4, quote: 'test' },
                sentence: 'test sentence'
            });
        })));
        const tabRows = await page.evaluate(async () => {
            const db = await import('/modules/permanent-db.js');
            return db.readStoreAll(db.STORE.READING_ITEMS, 'review-scope::tabs');
        });
        try {
            assert(writes.every((item) => item.ok), JSON.stringify(writes));
            assert.equal(tabRows.records.length, 1, JSON.stringify(tabRows));
            results.push({ name: 'same occurrence from two pages has one persistent item', ok: true });
        } catch (error) {
            results.push({ name: 'same occurrence from two pages has one persistent item', ok: false, error: String(error) });
        }

        // A→B→A：舊任務即使 scope 字串回到 A，也必須因 generation 改變而中止。
        const generationTest = await page.evaluate(async () => {
            const store = await import('/modules/reading-store.js');
            const art = await import('/modules/article-store.js');
            const db = await import('/modules/permanent-db.js');
            const a = 'review-scope::generation-a';
            const b = 'review-scope::generation-b';
            await art.reloadScope(a);
            await art.saveArticle({ id: 'generation-article', body: 'test sentence' });
            await store.initReadingStore(a);
            let release;
            let arrived;
            const held = new Promise((resolve) => { release = resolve; });
            const barrier = new Promise((resolve) => { arrived = resolve; });
            const originalGet = IDBObjectStore.prototype.get;
            let heldOnce = false;
            IDBObjectStore.prototype.get = function get(key) {
                const request = originalGet.call(this, key);
                if (!heldOnce && this.name === 'reading_outbox' && String(key).includes('generation-item')) {
                    heldOnce = true;
                    const proxy = { get result() { return request.result; }, get error() { return request.error; } };
                    request.onsuccess = async (event) => { arrived(); await held; proxy.onsuccess?.(event); };
                    request.onerror = (event) => proxy.onerror?.(event);
                    return proxy;
                }
                return request;
            };
            const pending = store.upsertLearningItem({
                id: 'generation-item',
                articleId: 'generation-article',
                contentVersion: 'cv_generation',
                kind: 'word',
                anchor: { start: 0, end: 4, quote: 'test' },
                note: 'old task must not pass'
            });
            await barrier;
            await art.reloadScope(b);
            await store.reloadReadingScope(b);
            await art.reloadScope(a);
            await store.reloadReadingScope(a);
            release();
            const save = await pending;
            IDBObjectStore.prototype.get = originalGet;
            const rowsA = await db.readStoreAll(db.STORE.READING_ITEMS, a);
            return { save, rowsA: rowsA.records.filter((item) => item.id === 'generation-item') };
        });
        try {
            assert.equal(generationTest.save.ok, false, JSON.stringify(generationTest));
            assert.equal(generationTest.rowsA.length, 0, JSON.stringify(generationTest));
            results.push({ name: 'A→B→A generation aborts stale queued write', ok: true });
        } catch (error) {
            results.push({ name: 'A→B→A generation aborts stale queued write', ok: false, error: String(error) });
        }
    } finally {
        await browser.close();
    }
    console.log(JSON.stringify(results, null, 2));
    process.exitCode = results.every((item) => item.ok) ? 0 : 1;
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
