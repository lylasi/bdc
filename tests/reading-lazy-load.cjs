/**
 * 文章清單／學習記錄 lazy load 回歸：正常重載不得 hydrate 所有全文、文件或消息。
 *
 * 用法：
 *   PORT=8313 PLAYWRIGHT_MODULE=<path-to-playwright> node tests/reading-lazy-load.cjs
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
                    body: `export const SYNC={endpoint: "${BASE}/lazy-sync"}; export const TTS_CONFIG={}, AI_LIMITS={}, OCR_CONFIG={}, ARTICLE_IMPORT={}, SUPABASE={};`
                });
            }
            if (url.origin !== BASE) return route.abort();
            return route.continue();
        });
        const page = await context.newPage();
        await page.goto(`${BASE}/test-reading-blank.html`);
        const seeded = await page.evaluate(async () => {
            const art = await import('/modules/article-store.js');
            const rd = await import('/modules/reading-store.js');
            const { contentVersionOf } = await import('/shared/reading-protocol.mjs');
            await art.initArticleStore();
            await rd.initReadingStore();
            const longTail = 'This is a long body segment for lazy loading verification. '.repeat(220);
            for (let index = 0; index < 24; index += 1) {
                const articleId = index === 0 ? 'lazy-a' : (index === 1 ? 'lazy-b' : `lazy-${index}`);
                const body = `Article ${index} first sentence. ${longTail}`;
                await art.saveArticle({
                    articleId,
                    article: body,
                    title: `Lazy Article ${index}`,
                    sourceType: 'paste',
                    result: {
                        chinese_translation: '測試',
                        paragraph_analysis: [{ chinese_translation: '測試', sentences: [{ en: 'Article first sentence.', zh: '測試' }] }],
                        detailed_analysis: [], sentence_analysis: [], phrase_analysis: []
                    }
                });
                if (index < 2) {
                    await rd.upsertLearningItem({
                        articleId,
                        contentVersion: contentVersionOf(body),
                        kind: 'word',
                        anchor: { start: 0, end: 7, quote: 'Article' },
                        sentence: 'Article first sentence.',
                        explanation: { language: 'zh-CN', result: { analysis: { meaning: 'x'.repeat(18000) } }, generatedAt: new Date().toISOString(), provenance: {} }
                    }, { markViewed: true });
                    await rd.saveArticleDocument({
                        articleId,
                        kind: 'note',
                        title: 'Long note',
                        content: 'N'.repeat(50000),
                        contentVersion: contentVersionOf(body)
                    });
                }
            }
            const conv = await rd.ensureConversation({ id: 'lazy-conv-a', articleId: 'lazy-a', title: 'Lazy chat' });
            await rd.setConversationMessages(conv.conversation.id, Array.from({ length: 120 }, (_, index) => ({
                role: index % 2 === 0 ? 'user' : 'assistant',
                content: `long lazy message ${index + 1} ${'M'.repeat(2000)}`,
                ts: Date.now() + index
            })));
            return { scope: rd.getReadingScope() };
        });

        const data = await page.evaluate(async () => {
            const art = await import('/modules/article-store.js');
            const rd = await import('/modules/reading-store.js');
            const state = await import('/modules/state.js');
            const reads = [];
            const originalStoreGetAll = IDBObjectStore.prototype.getAll;
            const originalIndexGetAll = IDBIndex.prototype.getAll;
            IDBObjectStore.prototype.getAll = function getAll(...args) {
                const request = originalStoreGetAll.apply(this, args);
                request.addEventListener('success', () => reads.push({ kind: 'store', name: this.name, count: request.result?.length || 0 }));
                return request;
            };
            IDBIndex.prototype.getAll = function getAll(...args) {
                const request = originalIndexGetAll.apply(this, args);
                request.addEventListener('success', () => reads.push({ kind: 'index', name: this.name, count: request.result?.length || 0 }));
                return request;
            };
            await art.reloadScope();
            await rd.reloadReadingScope();
            const startup = {
                reads: reads.slice(),
                records: art.getRecords().length,
                allSummaryOnly: art.getRecords().every((record) => record.summaryOnly === true && !record.article && !record.result),
                stateSummaryOnly: state.analyzedArticles.every((record) => record.summaryOnly === true && !record.article),
                itemsA: rd.listLearningItems('lazy-a').length,
                itemsB: rd.listLearningItems('lazy-b').length
            };
            reads.length = 0;
            await art.ensureArticleLoaded('lazy-a');
            const articleA = art.getRecord('lazy-a');
            await rd.ensureArticleReadingLoaded('lazy-a');
            const hydrated = {
                reads: reads.slice(),
                bodyLength: articleA?.article?.length || 0,
                hasAnalysis: !!articleA?.result,
                itemsA: rd.listLearningItems('lazy-a').length,
                itemsB: rd.listLearningItems('lazy-b').length,
                summaryB: art.getRecord('lazy-b')
            };
            reads.length = 0;
            const messages = await rd.getMessages('lazy-conv-a');
            const messageLoad = { reads: reads.slice(), count: messages.length };
            IDBObjectStore.prototype.getAll = originalStoreGetAll;
            IDBIndex.prototype.getAll = originalIndexGetAll;
            return { startup, hydrated, messageLoad };
        });

        try {
            assert(data.startup.allSummaryOnly && data.startup.stateSummaryOnly, JSON.stringify(data.startup));
            assert.equal(data.startup.records, 24);
            assert.equal(data.startup.itemsA, 0);
            assert.equal(data.startup.itemsB, 0);
            assert(!data.startup.reads.some((read) => read.name === 'docs'), JSON.stringify(data.startup.reads));
            assert(!data.startup.reads.some((read) => read.name === 'reading_items'), JSON.stringify(data.startup.reads));
            assert(!data.startup.reads.some((read) => read.name === 'article_documents'), JSON.stringify(data.startup.reads));
            assert(!data.startup.reads.some((read) => read.name === 'messages' || read.name === 'scope_conversation'), JSON.stringify(data.startup.reads));
            results.push({ name: 'startup list reads summaries only (no docs/items/documents/messages)', ok: true });
        } catch (error) {
            results.push({ name: 'startup list reads summaries only (no docs/items/documents/messages)', ok: false, error: String(error) });
        }
        try {
            assert(data.hydrated.bodyLength > 10000, JSON.stringify(data.hydrated));
            assert.equal(data.hydrated.hasAnalysis, true);
            assert.equal(data.hydrated.itemsA, 1);
            assert.equal(data.hydrated.itemsB, 0);
            assert(data.hydrated.summaryB && data.hydrated.summaryB.summaryOnly === true && !data.hydrated.summaryB.article, JSON.stringify(data.hydrated.summaryB));
            assert(!data.hydrated.reads.some((read) => read.name === 'messages' || read.name === 'scope_conversation'), JSON.stringify(data.hydrated.reads));
            results.push({ name: 'opening one article hydrates only that article and no messages', ok: true });
        } catch (error) {
            results.push({ name: 'opening one article hydrates only that article and no messages', ok: false, error: String(error) });
        }
        try {
            assert.equal(data.messageLoad.count, 120, JSON.stringify(data.messageLoad));
            assert(data.messageLoad.reads.some((read) => read.name === 'scope_conversation'), JSON.stringify(data.messageLoad.reads));
            assert(!data.messageLoad.reads.some((read) => read.name === 'messages'), JSON.stringify(data.messageLoad.reads));
            results.push({ name: 'messages load by conversation index only when requested', ok: true });
        } catch (error) {
            results.push({ name: 'messages load by conversation index only when requested', ok: false, error: String(error) });
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
