/**
 * 閱讀筆記／完整備份的 scope 隔離與內容回歸（真實 Chromium + IndexedDB）。
 *
 * 覆蓋：
 *   1. A 匯出期間切到 B：不得混入 B 的私有詞書；結果必須是 stale_scope
 *   2. 完整 JSON 備份在切帳戶後不得輸出混合 scope 資料
 *   3. 相同 quote 的不同 occurrence／版本不得被去重丟掉
 *
 * 用法：
 *   PORT=8313 PLAYWRIGHT_MODULE=<path-to-playwright> node tests/reading-export-scope.cjs
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
        await page.goto(`${BASE}/test-reading-blank.html`);

        const exportTest = await page.evaluate(async () => {
            const a = await import('/modules/article-store.js');
            const r = await import('/modules/reading-store.js');
            const e = await import('/modules/reading-export.js');
            const scopeA = 'export-scope::A';
            const scopeB = 'export-scope::B';
            for (const [scope, name] of [[scopeB, 'PRIVATE_B_BOOK'], [scopeA, 'A_BOOK']]) {
                await a.reloadScope(scope);
                await r.reloadReadingScope(scope);
                await a.saveArticle({ id: 'same_article', title: scope === scopeA ? 'ARTICLE_A' : 'ARTICLE_B', body: 'Test word.' });
                const saved = await r.upsertLearningItem({
                    id: 'same_item',
                    articleId: 'same_article',
                    kind: 'word',
                    contentVersion: 'cv1',
                    anchor: { start: 0, end: 4, quote: 'Test' },
                    note: scope === scopeA ? 'A_NOTE' : 'B_NOTE'
                });
                const linked = await r.addVocabularyEntryWithLink({
                    book: { id: 'same_book', name },
                    entry: { id: 'same_entry', bookId: 'same_book', word: 'Test' },
                    link: { id: 'same_link', itemId: saved.entity.id, bookId: 'same_book', entryId: 'same_entry' }
                });
                if (!linked.ok) throw new Error(JSON.stringify(linked));
            }
            let release;
            let arrived;
            const held = new Promise((resolve) => { release = resolve; });
            const barrier = new Promise((resolve) => { arrived = resolve; });
            const originalGetAll = IDBIndex.prototype.getAll;
            let heldOnce = false;
            IDBIndex.prototype.getAll = function getAll(...args) {
                const request = originalGetAll.apply(this, args);
                if (!heldOnce && this.objectStore.name === 'reading_outbox') {
                    heldOnce = true;
                    const proxy = { get result() { return request.result; }, get error() { return request.error; } };
                    request.onsuccess = async (event) => { arrived(); await held; proxy.onsuccess?.(event); };
                    request.onerror = (event) => proxy.onerror?.(event);
                    return proxy;
                }
                return request;
            };
            const exporting = e.buildReadingNoteMarkdown({ articleId: 'same_article', includeFullText: true });
            const hit = await Promise.race([barrier.then(() => true), exporting.then(() => false)]);
            if (hit) {
                await a.reloadScope(scopeB);
                await r.reloadReadingScope(scopeB);
                release();
            }
            const output = await exporting;
            IDBIndex.prototype.getAll = originalGetAll;
            return {
                hit,
                ok: output.ok,
                error: output.error,
                containsA: output.markdown?.includes('ARTICLE_A'),
                containsPrivateB: output.markdown?.includes('PRIVATE_B_BOOK'),
                markdown: output.markdown
            };
        });
        try {
            assert.equal(exportTest.hit, true, JSON.stringify(exportTest));
            assert.equal(exportTest.ok, false, JSON.stringify(exportTest));
            assert.equal(exportTest.error, 'stale_scope', JSON.stringify(exportTest));
            assert.ok(!exportTest.containsPrivateB, JSON.stringify(exportTest));
            results.push({ name: 'Markdown export aborts with stale_scope instead of mixing account B vocabulary', ok: true });
        } catch (error) {
            results.push({ name: 'Markdown export aborts with stale_scope instead of mixing account B vocabulary', ok: false, error: String(error) });
        }

        const backupTest = await page.evaluate(async () => {
            const a = await import('/modules/article-store.js');
            const r = await import('/modules/reading-store.js');
            const e = await import('/modules/reading-export.js');
            const scopeA = 'export-scope::backup-A';
            const scopeB = 'export-scope::backup-B';
            for (const [scope, name] of [[scopeB, 'BACKUP_PRIVATE_B'], [scopeA, 'BACKUP_A']]) {
                await a.reloadScope(scope);
                await r.reloadReadingScope(scope);
                await a.saveArticle({ id: 'backup_article', title: name, body: 'Backup body.' });
                await r.upsertVocabularyBook({ id: 'backup_book', name });
                await r.upsertLearningItem({
                    id: 'backup_item',
                    articleId: 'backup_article',
                    kind: 'word',
                    contentVersion: 'cv1',
                    anchor: { start: 0, end: 6, quote: 'Backup' }
                });
            }
            let release;
            let arrived;
            const held = new Promise((resolve) => { release = resolve; });
            const barrier = new Promise((resolve) => { arrived = resolve; });
            const originalGetAll = IDBIndex.prototype.getAll;
            let heldOnce = false;
            IDBIndex.prototype.getAll = function getAll(...args) {
                const request = originalGetAll.apply(this, args);
                if (!heldOnce && this.objectStore.name === 'reading_items') {
                    heldOnce = true;
                    const proxy = { get result() { return request.result; }, get error() { return request.error; } };
                    request.onsuccess = async (event) => { arrived(); await held; proxy.onsuccess?.(event); };
                    request.onerror = (event) => proxy.onerror?.(event);
                    return proxy;
                }
                return request;
            };
            const building = e.buildFullBackup();
            const hit = await Promise.race([barrier.then(() => true), building.then(() => false)]);
            if (hit) {
                await a.reloadScope(scopeB);
                await r.reloadReadingScope(scopeB);
                release();
            }
            const backup = await building;
            IDBIndex.prototype.getAll = originalGetAll;
            return {
                hit,
                ok: backup.ok,
                error: backup.error,
                scope: backup.scope,
                text: JSON.stringify(backup)
            };
        });
        try {
            assert.equal(backupTest.hit, true, JSON.stringify(backupTest));
            assert.equal(backupTest.ok, false, JSON.stringify(backupTest));
            assert.equal(backupTest.error, 'stale_scope', JSON.stringify(backupTest));
            assert.equal(backupTest.text.includes('BACKUP_PRIVATE_B'), false, JSON.stringify(backupTest));
            results.push({ name: 'full JSON backup aborts with stale_scope after account switch', ok: true });
        } catch (error) {
            results.push({ name: 'full JSON backup aborts with stale_scope after account switch', ok: false, error: String(error) });
        }

        const generationTest = await page.evaluate(async () => {
            const a = await import('/modules/article-store.js');
            const r = await import('/modules/reading-store.js');
            const e = await import('/modules/reading-export.js');
            const scope = 'export-scope::generations';
            const other = 'export-scope::generations-other';
            await a.reloadScope(scope);
            await r.reloadReadingScope(scope);
            await a.saveArticle({
                id: 'generation_article',
                title: 'GENERATION_ARTICLE',
                body: 'Different generations must still export.',
                result: { chinese_translation: '世代不同仍須完整匯出。' }
            });
            await r.upsertLearningItem({
                id: 'generation_item',
                articleId: 'generation_article',
                kind: 'word',
                contentVersion: 'cv1',
                anchor: { start: 0, end: 9, quote: 'Different' },
                note: 'GENERATION_NOTE'
            });
            // 正常情況下閱讀與文章的 generation 各自遞增，數值本來就會不同。
            // 這裡讓閱讀世代先繞一圈，重現舊版把閱讀 ctx 傳給文章層而得到空陣列。
            await r.reloadReadingScope(other);
            await r.reloadReadingScope(scope);
            const readingCtx = r.captureReadingContext();
            const articleCtx = a.captureArticleContext();
            const backup = await e.buildFullBackup();
            return {
                readingGeneration: readingCtx.generation,
                articleGeneration: articleCtx.generation,
                ok: backup.ok,
                error: backup.error,
                articles: backup.payload?.articleDocuments || [],
                readingArticles: backup.payload?.reading?.articleDocuments || [],
                items: backup.payload?.reading?.learningItems || []
            };
        });
        try {
            assert.notEqual(generationTest.readingGeneration, generationTest.articleGeneration, JSON.stringify(generationTest));
            assert.equal(generationTest.ok, true, JSON.stringify(generationTest));
            assert.equal(generationTest.articles.length, 1, JSON.stringify(generationTest));
            assert.equal(generationTest.articles[0].id, 'generation_article');
            assert.equal(generationTest.articles[0].title, 'GENERATION_ARTICLE');
            assert.equal(generationTest.articles[0].body, 'Different generations must still export.');
            assert.equal(generationTest.articles[0].analysis?.chinese_translation, '世代不同仍須完整匯出。');
            assert.equal(generationTest.readingArticles.length, 0);
            assert.equal(generationTest.items.length, 1);
            results.push({ name: 'full backup exports articles even when reading/article generations differ', ok: true });
        } catch (error) {
            results.push({ name: 'full backup exports articles even when reading/article generations differ', ok: false, error: String(error) });
        }

        const articleStaleTest = await page.evaluate(async () => {
            const a = await import('/modules/article-store.js');
            const r = await import('/modules/reading-store.js');
            const e = await import('/modules/reading-export.js');
            const scopeA = 'export-scope::article-stale-A';
            const scopeB = 'export-scope::article-stale-B';
            await a.reloadScope(scopeA);
            await r.reloadReadingScope(scopeA);
            await a.saveArticle({ id: 'stale_article', title: 'STALE_ARTICLE', body: 'Stale article body.' });
            await r.upsertLearningItem({
                id: 'stale_item',
                articleId: 'stale_article',
                kind: 'word',
                contentVersion: 'cv1',
                anchor: { start: 0, end: 5, quote: 'Stale' }
            });
            let release;
            let arrived;
            const held = new Promise((resolve) => { release = resolve; });
            const barrier = new Promise((resolve) => { arrived = resolve; });
            const originalGetAll = IDBObjectStore.prototype.getAll;
            let heldOnce = false;
            IDBObjectStore.prototype.getAll = function getAll(...args) {
                const request = originalGetAll.apply(this, args);
                if (!heldOnce && this.name === 'docs') {
                    heldOnce = true;
                    const proxy = { get result() { return request.result; }, get error() { return request.error; } };
                    request.onsuccess = async (event) => { arrived(); await held; proxy.onsuccess?.(event); };
                    request.onerror = (event) => proxy.onerror?.(event);
                    return proxy;
                }
                return request;
            };
            const building = e.buildFullBackup();
            const hit = await Promise.race([barrier.then(() => true), building.then(() => false)]);
            if (hit) {
                // 只切閱讀 scope：文章本身仍有效，但整體備份已跨世代，必須失敗。
                await r.reloadReadingScope(scopeB);
                release();
            }
            const backup = await building;
            IDBObjectStore.prototype.getAll = originalGetAll;
            await r.reloadReadingScope(scopeA);
            return { hit, ok: backup.ok, error: backup.error, text: JSON.stringify(backup) };
        });
        try {
            assert.equal(articleStaleTest.hit, true, JSON.stringify(articleStaleTest));
            assert.equal(articleStaleTest.ok, false, JSON.stringify(articleStaleTest));
            assert.equal(articleStaleTest.error, 'stale_scope', JSON.stringify(articleStaleTest));
            assert.equal(articleStaleTest.text.includes('STALE_ARTICLE'), false, JSON.stringify(articleStaleTest));
            results.push({ name: 'full backup fails instead of returning empty articles when scope changes during article export', ok: true });
        } catch (error) {
            results.push({ name: 'full backup fails instead of returning empty articles when scope changes during article export', ok: false, error: String(error) });
        }

        const occurrenceTest = await page.evaluate(async () => {
            const a = await import('/modules/article-store.js');
            const r = await import('/modules/reading-store.js');
            const e = await import('/modules/reading-export.js');
            const scope = 'export-scope::occurrence';
            await a.reloadScope(scope);
            await r.reloadReadingScope(scope);
            await a.saveArticle({ id: 'occ_article', title: 'OCCURRENCES', body: 'Test test test.' });
            await r.upsertLearningItem({
                id: 'occ_first', articleId: 'occ_article', kind: 'word', contentVersion: 'cv1',
                anchor: { start: 0, end: 4, quote: 'Test' }, note: 'FIRST_OCCURRENCE'
            });
            await r.upsertLearningItem({
                id: 'occ_second', articleId: 'occ_article', kind: 'word', contentVersion: 'cv1',
                anchor: { start: 5, end: 9, quote: 'Test' }, note: 'SECOND_OCCURRENCE'
            });
            await r.upsertLearningItem({
                id: 'occ_version2', articleId: 'occ_article', kind: 'word', contentVersion: 'cv2',
                anchor: { start: 10, end: 14, quote: 'Test' }, note: 'THIRD_VERSION'
            });
            const output = await e.buildReadingNoteMarkdown({ articleId: 'occ_article' });
            return {
                ok: output.ok,
                hasFirst: output.markdown?.includes('FIRST_OCCURRENCE'),
                hasSecond: output.markdown?.includes('SECOND_OCCURRENCE'),
                hasThird: output.markdown?.includes('THIRD_VERSION')
            };
        });
        try {
            assert.equal(occurrenceTest.ok, true, JSON.stringify(occurrenceTest));
            assert.equal(occurrenceTest.hasFirst, true, JSON.stringify(occurrenceTest));
            assert.equal(occurrenceTest.hasSecond, true, JSON.stringify(occurrenceTest));
            assert.equal(occurrenceTest.hasThird, true, JSON.stringify(occurrenceTest));
            results.push({ name: 'same quote across occurrences/versions is not deduplicated away', ok: true });
        } catch (error) {
            results.push({ name: 'same quote across occurrences/versions is not deduplicated away', ok: false, error: String(error) });
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
