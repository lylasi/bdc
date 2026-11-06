// Real browser regression: JSON export/import retains article provenance and
// replacing a named book preserves the ID used by existing deep links.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = 'http://127.0.0.1:' + (process.env.PORT || 8313);
(async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        for (const locale of ['zh-CN', 'zh-HK']) {
            const context = await browser.newContext({ acceptDownloads: true });
            await context.addInitScript((language) => {
                localStorage.setItem('vocabImportPromptShown', '1');
                localStorage.setItem('pen_global_settings', JSON.stringify({ language: { interfaceLocale: language } }));
            }, locale);
            await context.route('**/ai-config.js', (route) => route.fulfill({ contentType: 'application/javascript',
                body: 'export const SYNC={endpoint:""},TTS_CONFIG={},AI_LIMITS={},OCR_CONFIG={},ARTICLE_IMPORT={},SUPABASE={};' }));
            const page = await context.newPage();
            const ready = page.waitForEvent('console', { predicate: (message) => message.text().startsWith('应用程序已') });
            await page.goto(base + '/#v'); await ready;
            await page.evaluate(async () => {
                const ui = await import('/modules/ui.js'); ui.closeModal();
                const state = await import('/modules/state.js');
                state.setVocabularyBooks([{ id: 'transfer-book', name: 'Transfer original', sourceType: 'article', articleId: 'art_transfer',
                    sourceUrl: 'https://example.com/article', words: [{ id: 'word_one', word: 'hello', meaning: '你好', phonetic: 'həˈləʊ', examples: [] }] }]);
                const saved = await (await import('/modules/storage.js')).saveVocabularyBooks();
                if (!saved.ok) throw new Error(saved.error);
                (await import('/features/vocabulary/vocabulary.js')).selectVocabularyBook('transfer-book', { updateRoute: true });
            });
            const downloading = page.waitForEvent('download').catch(() => null);
            await page.locator('#export-vocab-book-btn').click({ timeout: 5000 });
            const download = await downloading;
            assert.ok(download, 'export creates a downloadable JSON file');
            const exported = JSON.parse(await fs.readFile(await download.path(), 'utf8'));
            assert.equal(exported.sourceUrl, 'https://example.com/article');
            assert.equal(exported.articleId, 'art_transfer');
            assert.ok(typeof exported.words[0] === 'string' && exported.words[0].startsWith('hello'));
            assert.ok(exported.words[0].includes('你好'));
            async function importBook(value, overwrite = false) {
                await page.locator('#import-vocab-book-btn').click();
                await page.locator('#modal-import-file').setInputFiles({ name: 'book.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)) });
                await page.locator('#app-modal .save-btn').click();
                if (overwrite) await page.locator('#confirm-btn').click();
                await page.locator('#app-modal').waitFor({ state: 'hidden' });
                return page.evaluate(async (name) => (await import('/modules/state.js')).vocabularyBooks.find((book) => book.name === name), value.name);
            }
            const copy = await importBook({ ...exported, name: 'Transfer copy' });
            assert.equal(copy.articleId, exported.articleId);
            assert.equal(copy.sourceUrl, exported.sourceUrl);
            assert.equal(copy.words[0].word, 'hello');
            const legacy = await importBook({ name: 'Transfer copy', words: [] }, true);
            assert.equal(legacy.id, copy.id);
            assert.equal(legacy.articleId, copy.articleId);
            assert.equal(legacy.sourceUrl, copy.sourceUrl);
            const replaced = await importBook({ name: 'Transfer copy', words: [], sourceUrl: 'https://example.com/another' }, true);
            assert.equal(replaced.id, copy.id);
            assert.equal(replaced.articleId || '', '');
            assert.equal(replaced.sourceUrl, 'https://example.com/another');
            const unsafe = await importBook({ name: 'Unsafe source', words: [], sourceUrl: 'javascript:alert(1)', articleId: '<bad>' });
            assert.equal(unsafe.sourceUrl || '', '');
            assert.equal(unsafe.articleId || '', '');
            console.log('PASS ' + locale + ': export source and legacy words; import provenance; overwrite stable ID; changed/invalid source');
            await context.close();
        }
    } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
