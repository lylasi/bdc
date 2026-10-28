const mock = require('./article-mock.cjs');

const PORT = Number(process.env.PORT || 8313);
const BASE = (process.env.BASE_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, '') + '/';
const ARTICLE_ID = 'art_reading_panel_improvements';

async function createReadingPanelFixture(browser, { locale = 'zh-CN', mobile = false } = {}) {
    const context = await browser.newContext({
        viewport: { width: mobile ? 390 : 1440, height: 844 },
        isMobile: mobile,
        hasTouch: mobile
    });
    await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith('/ai-config.js')) return route.fulfill({
            contentType: 'application/javascript',
            body: 'export const SYNC={endpoint:""}; export const TTS_CONFIG={}, AI_LIMITS={}, OCR_CONFIG={}, ARTICLE_IMPORT={}, SUPABASE={};'
        });
        return url.origin === BASE.slice(0, -1) ? route.continue() : route.abort();
    });
    await mock.initScript(context, { locale });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    await page.evaluate(() => document.querySelector('#app-modal:not(.hidden) .modal-close-btn')?.click());
    const fixture = await page.evaluate(async articleId => {
        const art = await import('/modules/article-store.js');
        const rd = await import('/modules/reading-store.js');
        const { contentVersionOf, locateTextAnchor } = await import('/shared/reading-protocol.mjs');
        await art.initArticleStore();
        await rd.initReadingStore();
        const sentences = [
            'We look forward to meeting you.',
            'The attached document summarizes the project timeline and the next steps.',
            'Please review the attached document before Friday.',
            'The team will discuss the budget and confirm the final schedule tomorrow.',
            'We appreciate your patience and look forward to your feedback.',
            'Please contact the coordinator if you need additional information.'
        ];
        const body = sentences.join('\n\n');
        const result = {
            chinese_translation: '合成文章譯文。',
            word_alignment: [],
            detailed_analysis: [{ word: 'look', sentence: sentences[0], analysis: { meaning: '看；期待' } }],
            paragraph_analysis: sentences.map((en, index) => ({ chinese_translation: `合成譯文 ${index + 1}`, sentences: [{ en, zh: `合成譯文 ${index + 1}` }] })),
            sentence_analysis: [],
            phrase_analysis: []
        };
        const article = await art.saveArticle({ articleId, article: body, title: 'Reading Panel Fixture', sourceType: 'paste', result });
        if (!article.ok) throw new Error(article.error);
        const version = contentVersionOf(body);
        const specs = [
            ['phrase', 'look forward to', 0, '期待；盼望', 'to 後面接名詞或動名詞。', true],
            ['word', 'look', 0, '看；期待', '', false],
            ['sentence', sentences[1], 1, '附件文件總結了項目時間表和下一步。', '句子的主語是 document。', true],
            ['word', 'review', 2, '查看；複習', '', false],
            ['word', 'document', 2, '文件', '', false],
            ['word', 'budget', 3, '預算', '', false],
            ['word', 'schedule', 3, '日程', '', false],
            ['word', 'patience', 4, '耐心', '', false],
            ['word', 'feedback', 4, '反饋', '', false],
            ['word', 'coordinator', 5, '協調人', '', false],
            ['phrase', 'additional information', 5, '補充資料', '', false]
        ];
        const ids = [];
        for (const [kind, quote, sentenceIndex, meaning, note, marked] of specs) {
            const saved = await rd.upsertLearningItem({
                articleId, contentVersion: version, kind,
                anchor: locateTextAnchor(body, quote, sentences[sentenceIndex]).anchor,
                sentence: sentences[sentenceIndex],
                explanation: { language: 'zh-HK', result: kind === 'sentence' ? { translation: meaning } : { analysis: { meaning } }, generatedAt: new Date().toISOString() },
                note, marked
            }, { markViewed: true });
            if (!saved.ok) throw new Error(saved.error);
            ids.push(saved.entity.id);
        }
        await rd.addVocabularyEntryWithLink({
            book: { id: 'book_panel', name: '合成生字簿', sourceType: 'article', createdAt: new Date().toISOString() },
            entry: { id: 'entry_panel', bookId: 'book_panel', word: 'look forward to', meaning: '期待', phonetic: '', examples: [], sources: [], addedAt: new Date().toISOString() },
            link: { id: 'link_panel', itemId: ids[0], bookId: 'book_panel', entryId: 'entry_panel', addedAt: new Date().toISOString() }
        });
        const conversation = await rd.ensureConversation({ articleId, title: 'Synthetic source conversation', id: 'conv_panel' });
        if (!conversation.ok) throw new Error(conversation.error);
        await rd.appendMessage({ id: 'msg_panel', articleId, conversationId: 'conv_panel', role: 'assistant', content: 'Synthetic saved explanation.' });
        const ai = await rd.saveArticleDocument({
            articleId, kind: 'ai', title: 'AI 短語補充',
            content: '## 用法\n\n**look forward to** 後面接名詞或動名詞。\n\n- Example: We look forward to hearing from you.\n\n<script>window.__unsafeReadingMarkdown = true</script>',
            sourceItemIds: [ids[0]], sourceMessageIds: ['msg_panel'], contentVersion: version
        });
        const note = await rd.saveArticleDocument({ articleId, kind: 'note', title: '全篇閱讀心得（合成）', content: '這封郵件需要確認會面安排、預算和附件。', contentVersion: version });
        const st = await import('/modules/state.js');
        st.setCurrentArticleId(articleId);
        st.setCurrentWordbookId(articleId);
        window.__readingPanelFixture = { articleId, ids, aiId: ai.entity.id, noteId: note.entity.id, version };
        return window.__readingPanelFixture;
    }, ARTICLE_ID);
    if (!await page.locator('#article-btn').isVisible()) await page.locator('#nav-more-btn').click();
    await page.locator('#article-btn').click();
    await page.evaluate(async articleId => {
        (await import('/modules/state.js')).setCurrentArticleId(articleId);
        await (await import('/features/article/article.js')).showCurrentArticleIfAvailable();
    }, ARTICLE_ID);
    await page.locator('.interactive-sentence').first().waitFor();
    await page.locator('#article-reading-records-btn').click();
    await page.locator('.reading-item').first().waitFor();
    return { context, page, fixture, errors };
}

module.exports = { createReadingPanelFixture, BASE };
