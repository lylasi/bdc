/**
 * 文章本機儲存 scope 隔離與交易根因回歸（真實 Chromium + IndexedDB）。
 *
 * 覆蓋：
 *   1. touchOpened 等 persistDoc 路徑必須同時更新摘要，reload 不得回讀舊資料
 *   2. A 儲存期間切到 B：B 的記憶體與永久 docs 不得被 A 正文覆蓋
 *   3. A→B→A：舊 A 任務因 generation 失效，不得再寫入 A
 *   4. 未上傳 create 的刪除分支也必須維護摘要（不可只刪 docs）
 *
 * 用法：
 *   PORT=8313 PLAYWRIGHT_MODULE=<path-to-playwright> node tests/article-scope.cjs
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
                return route.fulfill({ contentType: 'application/javascript', body: 'export const SYNC={endpoint: ""}; export const TTS_CONFIG={}, AI_LIMITS={}, OCR_CONFIG={}, ARTICLE_IMPORT={}, SUPABASE={};' });
            }
            if (url.origin !== BASE) return route.abort();
            return route.continue();
        });
        const page = await context.newPage();
        page.on('pageerror', (error) => results.push({ name: 'pageerror', ok: false, error: String(error) }));
        await page.goto(`${BASE}/test-reading-blank.html`);

        // ── 1. persistDoc 的 docs+summaries 同交易 ──────────────────────────
        const summaryTest = await page.evaluate(async () => {
            const a = await import('/modules/article-store.js');
            const db = await import('/modules/permanent-db.js');
            const scope = 'article-scope::summary';
            await a.reloadScope(scope);
            await a.saveArticle({ id: 'summary-article', article: 'first body', title: 'FIRST' }, { touch: false });
            const renamed = await a.renameArticle('summary-article', 'RENAMED');
            const touched = await a.touchOpened('summary-article');
            const beforeReload = a.getRecord('summary-article');
            await a.reloadScope(scope);
            const afterReload = a.getRecord('summary-article');
            const summaries = await db.readStoreAll(db.STORE.ARTICLE_SUMMARIES, scope);
            const docs = await db.readStoreAll(db.STORE.DOCS, scope);
            return {
                renamed, touched,
                beforeTitle: beforeReload?.title,
                afterTitle: afterReload?.title,
                summaryTitle: summaries.records.find((row) => row.articleId === 'summary-article')?.title,
                docTitle: docs.records.find((row) => row.id === 'summary-article')?.title,
                persistenceError: a.getPersistenceError()
            };
        });
        try {
            assert.equal(summaryTest.renamed.ok, true, JSON.stringify(summaryTest));
            assert.equal(summaryTest.touched.ok, true, JSON.stringify(summaryTest));
            assert.equal(summaryTest.beforeTitle, 'RENAMED', JSON.stringify(summaryTest));
            assert.equal(summaryTest.afterTitle, 'RENAMED', JSON.stringify(summaryTest));
            assert.equal(summaryTest.summaryTitle, 'RENAMED', JSON.stringify(summaryTest));
            assert.equal(summaryTest.docTitle, 'RENAMED', JSON.stringify(summaryTest));
            assert.equal(summaryTest.persistenceError, '', JSON.stringify(summaryTest));
            results.push({ name: 'persistDoc writes docs+summaries in one transaction', ok: true });
        } catch (error) {
            results.push({ name: 'persistDoc writes docs+summaries in one transaction', ok: false, error: String(error) });
        }

        // ── 2. A 儲存期間切 B：B 記憶體／永久 docs 不得被覆蓋 ──────────────
        const crossScope = await page.evaluate(async () => {
            const a = await import('/modules/article-store.js');
            const db = await import('/modules/permanent-db.js');
            const scopeA = 'article-scope::A';
            const scopeB = 'article-scope::B';
            await a.reloadScope(scopeB);
            await a.saveArticle({ id: 'same', title: 'B_TITLE', body: 'B private body.' }, { touch: false });
            await a.reloadScope(scopeA);
            await a.saveArticle({ id: 'same', title: 'A_TITLE', body: 'A private body.' }, { touch: false });

            let release;
            let arrived;
            const held = new Promise((resolve) => { release = resolve; });
            const barrier = new Promise((resolve) => { arrived = resolve; });
            const originalGet = IDBObjectStore.prototype.get;
            let heldOnce = false;
            IDBObjectStore.prototype.get = function get(...args) {
                const request = originalGet.apply(this, args);
                if (!heldOnce && this.name === 'outbox') {
                    heldOnce = true;
                    const proxy = { get result() { return request.result; }, get error() { return request.error; } };
                    request.onsuccess = async (event) => { arrived(); await held; proxy.onsuccess?.(event); };
                    request.onerror = (event) => proxy.onerror?.(event);
                    return proxy;
                }
                return request;
            };
            const saving = a.saveArticle({ id: 'same', title: 'A_EDIT', body: 'A NEW PRIVATE BODY.' });
            const hit = await Promise.race([
                barrier.then(() => true), saving.then(() => false),
                new Promise((_, reject) => setTimeout(() => reject(new Error('outbox get barrier timed out')), 5000))
            ]);
            if (hit) {
                await a.reloadScope(scopeB);
                await a.ensureArticleLoaded('same');
            }
            release();
            const save = await saving;
            IDBObjectStore.prototype.get = originalGet;
            const rowsA = await db.readStoreAll(db.STORE.DOCS, scopeA);
            const rowsB = await db.readStoreAll(db.STORE.DOCS, scopeB);
            return {
                hit,
                save,
                currentScope: a.getArticleScope(),
                memory: a.getRecord('same'),
                rowsA: rowsA.records,
                rowsB: rowsB.records
            };
        });
        try {
            assert.equal(crossScope.hit, true, JSON.stringify(crossScope));
            assert.equal(crossScope.currentScope, 'article-scope::B', JSON.stringify(crossScope));
            assert.equal(crossScope.memory?.article, 'B private body.', JSON.stringify(crossScope.memory));
            assert.equal(crossScope.rowsB.find((row) => row.id === 'same')?.body, 'B private body.', JSON.stringify(crossScope.rowsB));
            assert.equal(crossScope.rowsA.find((row) => row.id === 'same')?.body, 'A private body.', JSON.stringify(crossScope.rowsA));
            results.push({ name: 'A save during switch does not contaminate B memory or docs', ok: true });
        } catch (error) {
            results.push({ name: 'A save during switch does not contaminate B memory or docs', ok: false, error: String(error) });
        }

        // ── 3. A→B→A：generation 失效後不得再寫 A ──────────────────────────
        const generationTest = await page.evaluate(async () => {
            const a = await import('/modules/article-store.js');
            const db = await import('/modules/permanent-db.js');
            const scopeA = 'article-scope::gen-A';
            const scopeB = 'article-scope::gen-B';
            await a.reloadScope(scopeA);
            await a.saveArticle({ id: 'gen', title: 'ORIGINAL', body: 'original body' }, { touch: false });
            let release;
            let arrived;
            const held = new Promise((resolve) => { release = resolve; });
            const barrier = new Promise((resolve) => { arrived = resolve; });
            const originalGet = IDBObjectStore.prototype.get;
            let heldOnce = false;
            IDBObjectStore.prototype.get = function get(...args) {
                const request = originalGet.apply(this, args);
                if (!heldOnce && this.name === 'outbox') {
                    heldOnce = true;
                    const proxy = { get result() { return request.result; }, get error() { return request.error; } };
                    request.onsuccess = async (event) => { arrived(); await held; proxy.onsuccess?.(event); };
                    request.onerror = (event) => proxy.onerror?.(event);
                    return proxy;
                }
                return request;
            };
            const saving = a.saveArticle({ id: 'gen', title: 'STALE EDIT', body: 'stale edit body' });
            await Promise.race([
                barrier,
                saving.then(() => { throw new Error('save did not reach outbox get barrier'); }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('outbox get barrier timed out')), 5000))
            ]);
            await a.reloadScope(scopeB);
            await a.reloadScope(scopeA);
            release();
            const save = await saving;
            IDBObjectStore.prototype.get = originalGet;
            const rowsA = await db.readStoreAll(db.STORE.DOCS, scopeA);
            const memory = a.getRecord('gen');
            return { save, memory, rowsA: rowsA.records };
        });
        try {
            assert.equal(generationTest.save.ok, false, JSON.stringify(generationTest.save));
            assert.equal(generationTest.save.error, 'stale_scope', JSON.stringify(generationTest.save));
            assert.equal(generationTest.memory?.title, 'ORIGINAL', JSON.stringify(generationTest.memory));
            assert.equal(generationTest.rowsA.find((row) => row.id === 'gen')?.title, 'ORIGINAL', JSON.stringify(generationTest.rowsA));
            results.push({ name: 'A→B→A stale save aborts without writing A', ok: true });
        } catch (error) {
            results.push({ name: 'A→B→A stale save aborts without writing A', ok: false, error: String(error) });
        }

        // ── 4. 未上傳 create 刪除分支仍需更新摘要 ──────────────────────────
        const deleteTest = await page.evaluate(async () => {
            const a = await import('/modules/article-store.js');
            const db = await import('/modules/permanent-db.js');
            const scope = 'article-scope::delete';
            await a.reloadScope(scope);
            await a.saveArticle({ id: 'fresh', title: 'FRESH', body: 'fresh article' });
            const before = await db.readStoreAll(db.STORE.ARTICLE_SUMMARIES, scope);
            const deleted = await a.deleteArticle('fresh');
            const after = await db.readStoreAll(db.STORE.ARTICLE_SUMMARIES, scope);
            const docs = await db.readStoreAll(db.STORE.DOCS, scope);
            await a.reloadScope(scope);
            return {
                deleted,
                summaryBefore: before.records.filter((row) => row.articleId === 'fresh').length,
                summaryAfter: after.records.find((row) => row.articleId === 'fresh') || null,
                doc: docs.records.find((row) => row.id === 'fresh') || null,
                visible: a.getRecords().some((row) => row.articleId === 'fresh')
            };
        });
        try {
            assert.equal(deleteTest.summaryBefore, 1, JSON.stringify(deleteTest));
            assert.equal(deleteTest.deleted.ok, true, JSON.stringify(deleteTest.deleted));
            assert.equal(Boolean(deleteTest.summaryAfter?.deletedAt), true, JSON.stringify(deleteTest.summaryAfter));
            assert.equal(Boolean(deleteTest.doc?.deletedAt), true, JSON.stringify(deleteTest.doc));
            assert.equal(deleteTest.visible, false, JSON.stringify(deleteTest));
            results.push({ name: 'delete of unuploaded create updates summary tombstone', ok: true });
        } catch (error) {
            results.push({ name: 'delete of unuploaded create updates summary tombstone', ok: false, error: String(error) });
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
