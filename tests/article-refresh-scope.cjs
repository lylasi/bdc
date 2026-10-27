/**
 * 同 scope 刷新保留已載入文章正文的回歸測試。
 *
 * 覆蓋：
 *   1. 冷啟動仍只讀摘要（不得因為 reloadScope／refreshScope 而 hydrate 全部文章）
 *   2. 同 scope 刷新保留目前文章的正文、分析與 contentVersion；冷文章仍是摘要
 *   3. 按需載入與 reloadScope 並發：載入完成後正文不得被較早的摘要蓋掉
 *   4. 文章開啟後 refreshScope + reloadReadingScope，第二次出現的詞仍能正確
 *      標記、寫筆記、取消，按鈕 contentVersion／anchor 與實際正文一致
 *   5. loaded 文件的 revision 與清單摘要不一致時不得沿用舊正文，需重新按需載入
 *   6. 換帳戶不洩漏舊帳戶正文；切回原帳戶仍可還原已讀文章
 *
 * 用法：
 *   PORT=8313 PLAYWRIGHT_MODULE=<path-to-playwright> node tests/article-refresh-scope.cjs
 */
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const PORT = Number(process.env.PORT || 8313);
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const ARTICLE_ID = 'article-refresh-opened';
const COLD_ID = 'article-refresh-cold';
const SENTENCE = 'We look forward to meeting you.';
const BODY = `${SENTENCE}\n\n${SENTENCE}`;
const COLD_BODY = 'This cold article should stay lazy until opened.';
const RESULT = {
    chinese_translation: '我們期待與你見面。\n\n我們期待與你見面。',
    word_alignment: [],
    detailed_analysis: [],
    paragraph_analysis: [0, 1].map(() => ({
        chinese_translation: '我們期待與你見面。',
        sentences: [{ en: SENTENCE, zh: '我們期待與你見面。' }]
    })),
    sentence_analysis: [],
    phrase_analysis: []
};

async function closeModal(page) {
    const modal = page.locator('#app-modal');
    if (!(await modal.isVisible().catch(() => false))) return;
    await modal.locator('.modal-close-btn').first().click().catch(() => {});
    await page.waitForTimeout(100);
}

async function openArticle(page, articleId) {
    if (!(await page.locator('#article-btn').isVisible().catch(() => false))) {
        await page.click('#nav-more-btn').catch(() => {});
        await page.waitForTimeout(150);
    }
    await page.click('#article-btn');
    await page.waitForTimeout(200);
    await page.evaluate(async (id) => {
        const state = await import('/modules/state.js');
        state.setCurrentArticleId(id);
        const article = await import('/features/article/article.js');
        await article.showCurrentArticleIfAvailable();
    }, articleId);
    await page.waitForTimeout(500);
}

// P2-T2：「寫筆記」收進 details.tooltip-more（預設收起），直接操作前必須先展開。
async function openTooltipMore(page) {
    await page.waitForSelector('#word-analysis-tooltip details.tooltip-more', { timeout: 5000 });
    await page.evaluate(() => {
        const details = document.querySelector('#word-analysis-tooltip details.tooltip-more');
        if (details && !details.open) details.open = true;
    });
    await page.waitForSelector('#word-analysis-tooltip details.tooltip-more[open] .btn-note-item', { state: 'visible', timeout: 5000 });
}

(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: CHROME });
    const results = [];
    try {
        const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
        await context.route('**/*', (route) => {
            const url = new URL(route.request().url());
            if (url.pathname.endsWith('/ai-config.js')) {
                return route.fulfill({
                    contentType: 'application/javascript',
                    body: 'export const SYNC={endpoint:""}; export const TTS_CONFIG={}, AI_LIMITS={}, OCR_CONFIG={}, ARTICLE_IMPORT={}, SUPABASE={};'
                });
            }
            if (url.origin !== BASE) return route.abort();
            return route.continue();
        });
        await context.addInitScript(() => {
            try {
                const raw = localStorage.getItem('pen_global_settings');
                const parsed = raw ? JSON.parse(raw) : {};
                parsed.language = { ...(parsed.language || {}), interfaceLocale: 'zh-CN' };
                localStorage.setItem('pen_global_settings', JSON.stringify(parsed));
            } catch (_) {}
        });
        const page = await context.newPage();
        const pageErrors = [];
        page.on('pageerror', (error) => pageErrors.push(String(error && error.stack ? error.stack.split('\n')[0] : error)));
        await page.goto(BASE, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1200);
        await closeModal(page);

        // 先寫入兩篇：一篇之後會開啟，另一篇必須保持冷摘要。
        const seeded = await page.evaluate(async ({ articleId, body, result, coldId, coldBody }) => {
            const art = await import('/modules/article-store.js');
            const rd = await import('/modules/reading-store.js');
            await art.initArticleStore();
            await rd.initReadingStore();
            const opened = await art.saveArticle({
                articleId,
                article: body,
                title: 'Refresh scope article',
                sourceType: 'paste',
                result
            });
            const cold = await art.saveArticle({
                articleId: coldId,
                article: coldBody,
                title: 'Refresh cold article',
                sourceType: 'paste'
            });
            return { opened, cold, scope: art.getArticleScope() };
        }, { articleId: ARTICLE_ID, body: BODY, result: RESULT, coldId: COLD_ID, coldBody: COLD_BODY });
        assert(seeded.opened.ok && seeded.cold.ok, JSON.stringify(seeded));

        // 整頁重載，模擬真正的冷啟動（記憶體 loadedDocs 已清空）。
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1400);
        await closeModal(page);

        // 1. 冷啟動 + 同 scope 重新整理只讀摘要。
        const lazy = await page.evaluate(async ({ articleId, coldId }) => {
            const art = await import('/modules/article-store.js');
            const reads = [];
            const originalGetAll = IDBObjectStore.prototype.getAll;
            IDBObjectStore.prototype.getAll = function getAll(...args) {
                const request = originalGetAll.apply(this, args);
                request.addEventListener('success', () => reads.push(this.name));
                return request;
            };
            await art.reloadScope();
            IDBObjectStore.prototype.getAll = originalGetAll;
            const opened = art.getRecord(articleId);
            const cold = art.getRecord(coldId);
            return {
                reads,
                opened: opened && { body: opened.article, summaryOnly: opened.summaryOnly },
                cold: cold && { body: cold.article, summaryOnly: cold.summaryOnly }
            };
        }, { articleId: ARTICLE_ID, coldId: COLD_ID });
        try {
            assert.equal(lazy.opened.summaryOnly, true, JSON.stringify(lazy));
            assert.equal(lazy.opened.body, '', JSON.stringify(lazy));
            assert.equal(lazy.cold.summaryOnly, true, JSON.stringify(lazy));
            assert(!lazy.reads.includes('docs'), JSON.stringify(lazy.reads));
            results.push({ name: 'cold startup and same-scope reload read summaries only', ok: true });
        } catch (error) {
            results.push({ name: 'cold startup and same-scope reload read summaries only', ok: false, error: String(error) });
        }

        // 2. 按需載入與同 scope 重新整理並發：載入完成後不得被摘要蓋回。
        const concurrent = await page.evaluate(async (articleId) => {
            const art = await import('/modules/article-store.js');
            let release;
            let arrived;
            const held = new Promise((resolve) => { release = resolve; });
            const barrier = new Promise((resolve) => { arrived = resolve; });
            const originalGet = IDBObjectStore.prototype.get;
            let heldOnce = false;
            IDBObjectStore.prototype.get = function get(...args) {
                const request = originalGet.apply(this, args);
                if (!heldOnce && this.name === 'docs') {
                    heldOnce = true;
                    const proxy = {
                        get result() { return request.result; },
                        get error() { return request.error; }
                    };
                    request.onsuccess = async (event) => {
                        arrived();
                        await held;
                        proxy.onsuccess?.(event);
                    };
                    request.onerror = (event) => proxy.onerror?.(event);
                    return proxy;
                }
                return request;
            };
            const loading = art.ensureArticleLoaded(articleId);
            await barrier;
            await art.reloadScope();
            const during = art.getRecord(articleId);
            release();
            const loaded = await loading;
            IDBObjectStore.prototype.get = originalGet;
            const after = art.getRecord(articleId);
            return {
                during: during && { body: during.article, summaryOnly: during.summaryOnly },
                loaded: loaded && { body: loaded.article, summaryOnly: loaded.summaryOnly, revision: loaded.revision },
                after: after && { body: after.article, summaryOnly: after.summaryOnly, revision: after.revision }
            };
        }, ARTICLE_ID);
        try {
            assert.equal(concurrent.loaded.body, BODY, JSON.stringify(concurrent));
            assert.equal(concurrent.loaded.summaryOnly, false, JSON.stringify(concurrent));
            assert.equal(concurrent.after.body, BODY, JSON.stringify(concurrent));
            assert.equal(concurrent.after.summaryOnly, false, JSON.stringify(concurrent));
            results.push({ name: 'in-flight article load survives a same-scope reload', ok: true });
        } catch (error) {
            results.push({ name: 'in-flight article load survives a same-scope reload', ok: false, error: String(error) });
        }

        // 3. 使用者開啟文章後，同步路徑的 refreshScope + reloadReadingScope。
        await openArticle(page, ARTICLE_ID);
        const refreshed = await page.evaluate(async ({ articleId, coldId }) => {
            const art = await import('/modules/article-store.js');
            const rd = await import('/modules/reading-store.js');
            const { contentVersionOf } = await import('/shared/reading-protocol.mjs');
            const before = art.getRecord(articleId);
            const reads = [];
            const originalGetAll = IDBObjectStore.prototype.getAll;
            IDBObjectStore.prototype.getAll = function getAll(...args) {
                const request = originalGetAll.apply(this, args);
                request.addEventListener('success', () => reads.push(this.name));
                return request;
            };
            await art.refreshScope();
            await rd.reloadReadingScope();
            IDBObjectStore.prototype.getAll = originalGetAll;
            const opened = art.getRecord(articleId);
            const cold = art.getRecord(coldId);
            return {
                reads,
                before: before && { body: before.article, version: contentVersionOf(before.article) },
                opened: opened && {
                    body: opened.article,
                    version: contentVersionOf(opened.article),
                    summaryOnly: opened.summaryOnly,
                    hasAnalysis: !!opened.result
                },
                cold: cold && { body: cold.article, summaryOnly: cold.summaryOnly }
            };
        }, { articleId: ARTICLE_ID, coldId: COLD_ID });
        try {
            assert.equal(refreshed.before.body, BODY, JSON.stringify(refreshed));
            assert.equal(refreshed.opened.body, BODY, JSON.stringify(refreshed));
            assert.equal(refreshed.opened.summaryOnly, false, JSON.stringify(refreshed));
            assert.equal(refreshed.opened.version, refreshed.before.version, JSON.stringify(refreshed));
            assert.equal(refreshed.opened.hasAnalysis, true, JSON.stringify(refreshed));
            assert.equal(refreshed.cold.summaryOnly, true, JSON.stringify(refreshed));
            assert.equal(refreshed.cold.body, '', JSON.stringify(refreshed));
            assert(!refreshed.reads.includes('docs'), JSON.stringify(refreshed.reads));
            results.push({ name: 'refreshScope keeps the opened article full and cold articles lazy', ok: true });
        } catch (error) {
            results.push({ name: 'refreshScope keeps the opened article full and cold articles lazy', ok: false, error: String(error) });
        }

        // 4. 第二次出現的 look：按鈕版本／錨點、標記、筆記、取消。
        const lookCount = await page.locator('.interactive-word[data-word="look"]').count();
        const secondLookStart = BODY.lastIndexOf('look');
        const secondSentenceStart = BODY.lastIndexOf(SENTENCE);
        const expectedVersion = await page.evaluate(async (id) => {
            const actions = await import('/modules/reading-actions.js');
            return actions.articleVersion(id);
        }, ARTICLE_ID);

        try {
            assert.equal(lookCount, 2, `look count=${lookCount}`);
            await page.locator('.interactive-word[data-word="look"]').nth(1).click();
            await page.waitForTimeout(200);
            const attrs = await page.evaluate(() => {
                const button = document.querySelector('#word-analysis-tooltip .btn-toggle-mark');
                return button ? {
                    version: button.getAttribute('data-content-version'),
                    anchorStart: Number(button.getAttribute('data-anchor-start')),
                    anchorEnd: Number(button.getAttribute('data-anchor-end')),
                    sentenceStart: Number(button.getAttribute('data-sentence-start')),
                    sentence: button.getAttribute('data-sentence')
                } : null;
            });
            assert(attrs, 'missing mark button');
            assert.equal(attrs.version, expectedVersion, JSON.stringify(attrs));
            assert.equal(attrs.anchorStart, secondLookStart, JSON.stringify(attrs));
            assert.equal(attrs.anchorEnd, secondLookStart + 'look'.length, JSON.stringify(attrs));
            assert.equal(attrs.sentenceStart, secondSentenceStart, JSON.stringify(attrs));
            assert.equal(attrs.sentence, SENTENCE, JSON.stringify(attrs));
            results.push({ name: 'second word tooltip carries current contentVersion and exact anchor', ok: true });
        } catch (error) {
            results.push({ name: 'second word tooltip carries current contentVersion and exact anchor', ok: false, error: String(error) });
        }

        try {
            await page.locator('#word-analysis-tooltip .btn-toggle-mark').click();
            await page.waitForFunction(() => {
                const button = document.querySelector('#word-analysis-tooltip .btn-toggle-mark');
                return button?.getAttribute('aria-pressed') === 'true';
            }, null, { timeout: 5000 });
            const marked = await page.evaluate(async ({ articleId, expectedVersion, secondLookStart }) => {
                const rd = await import('/modules/reading-store.js');
                const items = rd.listLearningItems(articleId).filter((item) => !item.deletedAt && item.anchor?.quote === 'look');
                const active = Array.from(document.querySelectorAll('.interactive-word[data-word="look"]'))
                    .map((element) => element.classList.contains('reading-mark-active'));
                return {
                    items: items.map((item) => ({
                        marked: item.marked,
                        version: item.contentVersion,
                        start: item.anchor?.start,
                        end: item.anchor?.end
                    })),
                    active
                };
            }, { articleId: ARTICLE_ID, expectedVersion, secondLookStart });
            assert.equal(marked.items.length, 1, JSON.stringify(marked));
            assert.equal(marked.items[0].marked, true, JSON.stringify(marked));
            assert.equal(marked.items[0].version, expectedVersion, JSON.stringify(marked));
            assert.equal(marked.items[0].start, secondLookStart, JSON.stringify(marked));
            assert.equal(marked.items[0].end, secondLookStart + 'look'.length, JSON.stringify(marked));
            assert.deepEqual(marked.active, [false, true], JSON.stringify(marked));
            results.push({ name: 'second occurrence can be marked with the correct underline', ok: true });
        } catch (error) {
            results.push({ name: 'second occurrence can be marked with the correct underline', ok: false, error: String(error) });
        }

        try {
            await openTooltipMore(page);
            await page.locator('#word-analysis-tooltip .btn-note-item').click();
            await page.waitForSelector('#article-reading-panel:not(.hidden) [data-note-id]', { timeout: 5000 });
            const noteText = '第二處 look 的筆記';
            const noteBox = page.locator('#article-reading-panel [data-note-id]').first();
            await noteBox.fill(noteText);
            await noteBox.blur();
            await page.waitForFunction(async (text) => {
                const rd = await import('/modules/reading-store.js');
                return rd.listLearningItems('article-refresh-opened').some((item) => item.note === text && item.marked === true);
            }, noteText, { timeout: 5000 });
            const noted = await page.evaluate(async () => {
                const rd = await import('/modules/reading-store.js');
                const item = rd.listLearningItems('article-refresh-opened').find((row) => row.anchor?.quote === 'look' && !row.deletedAt);
                return { note: item?.note, marked: item?.marked };
            });
            assert.equal(noted.note, noteText, JSON.stringify(noted));
            assert.equal(noted.marked, true, JSON.stringify(noted));
            results.push({ name: 'note can be written and saved for the second occurrence', ok: true });
        } catch (error) {
            results.push({ name: 'note can be written and saved for the second occurrence', ok: false, error: String(error) });
        }

        try {
            await page.locator('#article-reading-panel .reading-panel-close').click();
            await page.waitForFunction(() => document.getElementById('article-reading-panel')?.classList.contains('hidden'), null, { timeout: 5000 });
            await page.locator('.interactive-word[data-word="look"]').nth(1).click();
            await page.waitForTimeout(200);
            const beforeUnmark = await page.evaluate(() => {
                const button = document.querySelector('#word-analysis-tooltip .btn-toggle-mark');
                return button ? {
                    pressed: button.getAttribute('aria-pressed'),
                    version: button.getAttribute('data-content-version'),
                    anchorStart: Number(button.getAttribute('data-anchor-start'))
                } : null;
            });
            assert(beforeUnmark, 'missing mark button before unmark');
            assert.equal(beforeUnmark.pressed, 'true', JSON.stringify(beforeUnmark));
            assert.equal(beforeUnmark.version, expectedVersion, JSON.stringify(beforeUnmark));
            assert.equal(beforeUnmark.anchorStart, secondLookStart, JSON.stringify(beforeUnmark));
            await page.locator('#word-analysis-tooltip .btn-toggle-mark').click();
            await page.waitForFunction(() => {
                const button = document.querySelector('#word-analysis-tooltip .btn-toggle-mark');
                return button?.getAttribute('aria-pressed') === 'false';
            }, null, { timeout: 5000 });
            const unmarked = await page.evaluate(async () => {
                const rd = await import('/modules/reading-store.js');
                const item = rd.listLearningItems('article-refresh-opened').find((row) => row.anchor?.quote === 'look' && !row.deletedAt);
                const active = Array.from(document.querySelectorAll('.interactive-word[data-word="look"]'))
                    .map((element) => element.classList.contains('reading-mark-active'));
                return { marked: item?.marked, note: item?.note, active };
            });
            assert.equal(unmarked.marked, false, JSON.stringify(unmarked));
            assert.equal(unmarked.note, '第二處 look 的筆記', JSON.stringify(unmarked));
            assert.deepEqual(unmarked.active, [false, false], JSON.stringify(unmarked));
            results.push({ name: 'second occurrence can be unmarked without losing its note', ok: true });
        } catch (error) {
            results.push({ name: 'second occurrence can be unmarked without losing its note', ok: false, error: String(error) });
        }

        // 5. 摘要 revision 已更新但 loaded 文件仍是舊 revision：不得沿用舊正文。
        const revisionMismatch = await page.evaluate(async (articleId) => {
            const art = await import('/modules/article-store.js');
            const db = await import('/modules/permanent-db.js');
            const scope = art.getArticleScope();
            const docs = await db.readStoreAll(db.STORE.DOCS, scope);
            const doc = docs.records.find((row) => row.id === articleId);
            if (!doc) return { error: 'doc_missing' };
            const bumped = { ...doc, revision: Number(doc.revision) + 1 };
            await db.applyPermanentOperations([
                { store: db.STORE.DOCS, type: 'put', value: bumped },
                { store: db.STORE.ARTICLE_SUMMARIES, type: 'put', value: db.summarizeArticleDoc(bumped) }
            ]);
            await art.reloadScope();
            const afterReload = art.getRecord(articleId);
            const loaded = await art.ensureArticleLoaded(articleId);
            return {
                revision: bumped.revision,
                reload: afterReload && { body: afterReload.article, summaryOnly: afterReload.summaryOnly, revision: afterReload.revision },
                loaded: loaded && { body: loaded.article, summaryOnly: loaded.summaryOnly, revision: loaded.revision }
            };
        }, ARTICLE_ID);
        try {
            assert(!revisionMismatch.error, JSON.stringify(revisionMismatch));
            assert.equal(revisionMismatch.reload.body, '', JSON.stringify(revisionMismatch));
            assert.equal(revisionMismatch.reload.summaryOnly, true, JSON.stringify(revisionMismatch));
            assert.equal(revisionMismatch.loaded.body, BODY, JSON.stringify(revisionMismatch));
            assert.equal(revisionMismatch.loaded.summaryOnly, false, JSON.stringify(revisionMismatch));
            assert.equal(revisionMismatch.loaded.revision, revisionMismatch.revision, JSON.stringify(revisionMismatch));
            results.push({ name: 'loaded document must match summary revision before reuse', ok: true });
        } catch (error) {
            results.push({ name: 'loaded document must match summary revision before reuse', ok: false, error: String(error) });
        }

        // 6. 換帳戶不得看到／沿用上一個帳戶的正文；切回仍保留自己的已讀文章。
        const isolation = await page.evaluate(async ({ articleId, body }) => {
            const art = await import('/modules/article-store.js');
            const scopeA = art.getArticleScope();
            await art.reloadScope('article-refresh::account-b');
            const leaked = art.getRecord(articleId);
            await art.saveArticle({ articleId, article: 'Account B private body.', title: 'Account B' });
            // 換 scope 會清除原帳戶的目前文章身份；明確讀過 B 才應保留 B 的全文。
            await art.ensureArticleLoaded(articleId);
            await art.reloadScope('article-refresh::account-b');
            const bAfterRefresh = art.getRecord(articleId);
            await art.reloadScope(scopeA);
            const aRestored = art.getRecord(articleId);
            return {
                scopeA,
                leaked: leaked && { body: leaked.article, summaryOnly: leaked.summaryOnly },
                b: bAfterRefresh && { body: bAfterRefresh.article, summaryOnly: bAfterRefresh.summaryOnly },
                a: aRestored && { body: aRestored.article, summaryOnly: aRestored.summaryOnly }
            };
        }, { articleId: ARTICLE_ID, body: BODY });
        try {
            assert.equal(isolation.leaked, null, JSON.stringify(isolation));
            assert.equal(isolation.b.body, 'Account B private body.', JSON.stringify(isolation));
            assert.equal(isolation.b.summaryOnly, false, JSON.stringify(isolation));
            assert.equal(isolation.a.body, BODY, JSON.stringify(isolation));
            assert.equal(isolation.a.summaryOnly, false, JSON.stringify(isolation));
            results.push({ name: 'scope switch keeps account bodies isolated and restores own article', ok: true });
        } catch (error) {
            results.push({ name: 'scope switch keeps account bodies isolated and restores own article', ok: false, error: String(error) });
        }

        try {
            assert.equal(pageErrors.length, 0, pageErrors.join('\n'));
            results.push({ name: 'no page errors', ok: true });
        } catch (error) {
            results.push({ name: 'no page errors', ok: false, error: String(error) });
        }
        await context.close();
    } finally {
        await browser.close();
    }
    console.log(JSON.stringify(results, null, 2));
    process.exitCode = results.every((item) => item.ok) ? 0 : 1;
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
