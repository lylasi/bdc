/**
 * 文章閱讀檔案：桌面／手機 UI、遷移、備份還原、快取隔離與舊 ack 回歸。
 *
 * 用法：
 *   PORT=8313 PLAYWRIGHT_MODULE=<path-to-playwright> node tests/reading-files.cjs
 *   ASSET_DIR=<dir> 時會把桌面／手機截圖與 Markdown 樣本寫到該目錄。
 *
 * 全部使用獨立瀏覽器 context 的合成文章，不讀取使用者既有資料或正式帳號。
 */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8313);
const BASE = `http://127.0.0.1:${PORT}/`;
const ENDPOINT = process.env.TEST_SYNC_ENDPOINT || 'http://127.0.0.1:19999/test-endpoint';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ASSET_DIR = process.env.ASSET_DIR || '';

const failures = [];
function check(name, condition, detail) {
    if (condition) { console.log(`  ok   ${name}`); return true; }
    failures.push({ name, detail: detail === undefined ? '' : String(detail).slice(0, 600) });
    console.log(`  FAIL ${name}${detail !== undefined ? ' -- ' + String(detail).slice(0, 400) : ''}`);
    return false;
}

const ARTICLE = {
    id: 'art_reading_preview',
    title: 'Meeting Follow-up',
    body: 'We look forward to meeting you.\n\nPlease review the attached document before Friday.',
    sentence: 'We look forward to meeting you.',
    result: {
        chinese_translation: '我們期待與你見面。\n\n請在星期五前查看附件文件。',
        word_alignment: [],
        detailed_analysis: [
            { word: 'look', sentence: 'We look forward to meeting you.', analysis: { phonetic: 'lʊk', pos: 'v.', meaning: '看；期待', role: '動詞' } }
        ],
        paragraph_analysis: [
            { chinese_translation: '我們期待與你見面。', sentences: [{ en: 'We look forward to meeting you.', zh: '我們期待與你見面。' }] },
            { chinese_translation: '請在星期五前查看附件文件。', sentences: [{ en: 'Please review the attached document before Friday.', zh: '請在星期五前查看附件文件。' }] }
        ],
        sentence_analysis: [],
        phrase_analysis: []
    }
};

async function newPage(browser, { locale = 'zh-CN', viewport = { width: 1440, height: 960 }, mobile = false } = {}) {
    const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 });
    await context.addInitScript(({ endpoint, locale }) => {
        window.__BDC_SYNC_ENDPOINT__ = endpoint;
        try {
            const raw = localStorage.getItem('pen_global_settings');
            const parsed = raw ? JSON.parse(raw) : {};
            parsed.language = { ...(parsed.language || {}), interfaceLocale: locale };
            localStorage.setItem('pen_global_settings', JSON.stringify(parsed));
        } catch (_) {}
    }, { endpoint: ENDPOINT, locale });
    const page = await context.newPage();
    const errors = [];
    page.on('console', (m) => {
        if (m.type() !== 'error') return;
        const text = m.text();
        if (/401|501|Not Implemented|ai-credentials|ai-catalog|sync_endpoint_missing|ERR_CONNECTION_REFUSED|ERR_UNSAFE_PORT|尚未选择模型|尚未選擇模型|Error analyzing word|Failed to load resource: the server responded with a status of 404|File not found/i.test(text)) return;
        errors.push(text.slice(0, 240));
    });
    page.on('pageerror', (e) => errors.push('PAGEERROR ' + String(e && e.stack ? e.stack.split('\n')[0] : e)));
    return { context, page, errors };
}

async function dismissStartup(page) {
    await page.evaluate(() => {
        const modal = document.getElementById('app-modal');
        if (modal && !modal.classList.contains('hidden')) modal.querySelector('.modal-close-btn')?.click();
    });
    await page.waitForTimeout(150);
}

async function seedReadingFixture(page, { articleId = ARTICLE.id } = {}) {
    return page.evaluate(async ({ article, articleId }) => {
        const art = await import('/modules/article-store.js');
        const rd = await import('/modules/reading-store.js');
        const { contentVersionOf } = await import('/shared/reading-protocol.mjs');
        await art.initArticleStore();
        await rd.initReadingStore();
        const saved = await art.saveArticle({
            articleId,
            article: article.body,
            title: article.title,
            sourceType: 'paste',
            result: article.result
        });
        if (!saved.ok) throw new Error('save article ' + saved.error);
        const version = contentVersionOf(article.body);
        const phrase = await rd.upsertLearningItem({
            articleId,
            contentVersion: version,
            kind: 'phrase',
            anchor: { start: 3, end: 23, quote: 'look forward to', prefix: 'We ', suffix: ' meeting' },
            sentence: article.sentence,
            explanation: {
                language: 'zh-CN',
                result: { selection: 'look forward to', analysis: { meaning: '期待', usage: '後接名詞或動名詞' } },
                generatedAt: new Date().toISOString(),
                provenance: { source: 'synthetic' }
            },
            note: '後面接名詞或動名詞。',
            marked: true,
            understanding: 'needs_review'
        }, { markViewed: true });
        const word = await rd.upsertLearningItem({
            articleId,
            contentVersion: version,
            kind: 'word',
            anchor: { start: 3, end: 7, quote: 'look', prefix: 'We ', suffix: ' forward' },
            sentence: article.sentence,
            explanation: { language: 'zh-CN', result: { word: 'look', analysis: { meaning: '看；期待' } }, generatedAt: new Date().toISOString(), provenance: {} },
            note: '',
            marked: false,
            understanding: 'understood'
        }, { markViewed: true });
        const book = { id: 'book_preview', name: '本文生詞本', sourceType: 'article', createdAt: new Date().toISOString() };
        const entry = { id: 'entry_look', bookId: 'book_preview', word: 'look forward to', meaning: '期待', phonetic: '', examples: [], sources: [], addedAt: new Date().toISOString() };
        const link = { id: 'link_look', itemId: phrase.entity.id, bookId: book.id, entryId: entry.id, addedAt: new Date().toISOString() };
        const added = await rd.addVocabularyEntryWithLink({ book, entry, item: null, link });
        if (!added.ok) throw new Error('add vocabulary ' + added.error);
        await rd.saveArticleDocument({
            articleId,
            kind: 'ai',
            title: 'AI 片語補充',
            content: 'look forward to + 名詞／動名詞，表示期待某事。',
            sourceItemIds: [phrase.entity.id],
            sourceMessageIds: ['msg_synthetic'],
            contentVersion: version
        });
        await rd.saveArticleDocument({
            articleId,
            kind: 'note',
            title: '全篇心得',
            content: '這封郵件語氣禮貌，重點是確認見面時間與附件。',
            contentVersion: version
        });
        const st = await import('/modules/state.js');
        st.setCurrentArticleId(articleId);
        st.setCurrentWordbookId(articleId);
        return { phraseId: phrase.entity.id, wordId: word.entity.id, version };
    }, { article: ARTICLE, articleId });
}

async function openArticle(page, articleId = ARTICLE.id) {
    if (!(await page.locator('#article-btn').isVisible())) {
        await page.click('#nav-more-btn').catch(() => {});
        await page.waitForTimeout(150);
    }
    await page.click('#article-btn');
    await page.waitForTimeout(250);
    await page.evaluate(async (id) => {
        const st = await import('/modules/state.js');
        st.setCurrentArticleId(id);
        const art = await import('/features/article/article.js');
        await art.showCurrentArticleIfAvailable();
    }, articleId);
    await page.waitForTimeout(900);
}

async function runDesktop(browser) {
    console.log('\n[桌面 1440：標記、面板、筆記與匯出]');
    const { context, page, errors } = await newPage(browser, { locale: 'zh-CN', viewport: { width: 1440, height: 960 } });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    await dismissStartup(page);
    const ids = await seedReadingFixture(page);
    await openArticle(page);

    check('正文只為主動標記顯示統一底線', await page.locator('.reading-mark-active').count() > 0
        && await page.locator('.reading-mark-needs, .reading-mark-viewed, .reading-mark-saved').count() === 0);
    check('學習記錄入口可見', await page.locator('#article-reading-records-btn').isVisible());
    await page.click('#article-reading-records-btn');
    await page.waitForTimeout(350);
    check('桌面面板開啟', await page.locator('#article-reading-panel:not(.hidden)').count() === 1);
    check('面板列出學習條目與 AI 資料', await page.locator('.reading-item').count() >= 2 && await page.locator('.reading-doc').count() >= 1);
    check('標記篩選存在且不再有三態理解篩選', await page.locator('[data-filter="marked"]').count() === 1
        && await page.locator('[data-filter="needs"]').count() === 0
        && await page.locator('.reading-understanding').count() === 0);
    await page.click('[data-filter="notes"]');
    await page.waitForTimeout(200);
    check('筆記篩選只顯示 note 類文件', await page.locator('.reading-doc').filter({ hasText: '全篇心得' }).count() === 1
        && await page.locator('.reading-doc').filter({ hasText: 'AI 片語補充' }).count() === 0);
    await page.click('[data-filter="ai"]');
    await page.waitForTimeout(200);
    check('AI 篩選只顯示 AI 類文件', await page.locator('.reading-doc').filter({ hasText: 'AI 片語補充' }).count() === 1
        && await page.locator('.reading-doc').filter({ hasText: '全篇心得' }).count() === 0);
    await page.click('[data-filter="all"]');
    await page.waitForTimeout(200);
    await page.click('#reading-article-note');
    await page.waitForTimeout(200);
    await page.fill('#reading-article-note-input', '全篇心得：這封郵件確認見面與附件。');
    await page.click('#reading-article-note-save');
    await page.waitForTimeout(350);
    const articleNote = await page.evaluate(async () => {
        const rd = await import('/modules/reading-store.js');
        return rd.listArticleDocuments('art_reading_preview', { withContent: true }).filter((doc) => doc.kind === 'note').map((doc) => doc.content);
    });
    check('全篇閱讀筆記可獨立編輯保存', articleNote.some((content) => content.includes('確認見面與附件')), JSON.stringify(articleNote));

    // 筆記自動保存
    const note = page.locator(`[data-note-id="${ids.phraseId}"]`);
    await note.fill('更新後的個人筆記：接名詞或動名詞。');
    await page.waitForTimeout(900);
    const noteState = await page.evaluate(async (id) => {
        const rd = await import('/modules/reading-store.js');
        const item = rd.getLearningItem(id);
        return item ? item.note : '';
    }, ids.phraseId);
    check('個人筆記自動保存到永久層', noteState.includes('更新後的個人筆記'), noteState);
    await note.fill('關閉前最後輸入的筆記');
    await page.click('.reading-panel-close');
    await page.waitForTimeout(450);
    const closedNote = await page.evaluate(async (id) => (await import('/modules/reading-store.js')).getLearningItem(id)?.note, ids.phraseId);
    check('關閉面板時立即 flush 最後輸入的筆記', String(closedNote).includes('關閉前最後輸入'), closedNote);
    await page.click('#article-reading-records-btn');
    await page.waitForTimeout(300);

    // 單一標記切換；寫筆記不得改變標記
    const markButton = page.locator(`.reading-item[data-item-id="${ids.phraseId}"] [data-mark-toggle]`);
    await markButton.click();
    await page.waitForTimeout(300);
    let markState = await page.evaluate(async (id) => {
        const item = (await import('/modules/reading-store.js')).getLearningItem(id);
        return { marked: item?.marked, note: item?.note };
    }, ids.phraseId);
    check('閱讀記錄可取消標記，筆記與詞書關聯保留', markState.marked === false
        && String(markState.note).includes('關閉前最後輸入')
        && await page.evaluate(async (id) => (await import('/modules/reading-store.js')).isItemSaved(id), ids.phraseId), JSON.stringify(markState));
    const noteWhileUnmarked = page.locator(`[data-note-id="${ids.phraseId}"]`);
    await noteWhileUnmarked.fill('取消標記後仍可寫的筆記');
    await page.waitForTimeout(800);
    markState = await page.evaluate(async (id) => {
        const item = (await import('/modules/reading-store.js')).getLearningItem(id);
        return { marked: item?.marked, note: item?.note };
    }, ids.phraseId);
    check('寫筆記不改變標記狀態', markState.marked === false && markState.note === '取消標記後仍可寫的筆記', JSON.stringify(markState));
    await markButton.click();
    await page.waitForTimeout(300);
    markState = await page.evaluate(async (id) => (await import('/modules/reading-store.js')).getLearningItem(id)?.marked, ids.phraseId);
    check('再次標記可恢復', markState === true, String(markState));

    // 標記開關只影響呈現
    await page.uncheck('#article-reading-marks-toggle');
    await page.waitForTimeout(200);
    check('關閉標記後正文不再顯示學習線', await page.locator('.reading-mark-active').count() === 0);
    await page.check('#article-reading-marks-toggle');
    await page.waitForTimeout(200);
    check('重新開啟標記後恢復', await page.locator('.reading-mark-active').count() > 0);

    // Markdown 匯出（實際按鈕、實際下載）
    const downloadPromise = page.waitForEvent('download', { timeout: 15000 });
    await page.click('#reading-export-md');
    const download = await downloadPromise;
    const samplePath = path.join('/tmp', `bdc-reading-sample-${Date.now()}.md`);
    await download.saveAs(samplePath);
    const markdown = fs.readFileSync(samplePath, 'utf8');
    check('Markdown 匯出含原文版本與筆記', /原文版本|cv1_/.test(markdown) && /取消標記後仍可寫的筆記/.test(markdown), markdown.slice(0, 300));
    check('Markdown 匯出以標記取代理解程度', /標記：已標記|標記: 已标记|## 標記|## 标记/.test(markdown)
        && !/待弄懂|已理解|理解狀態/.test(markdown), markdown.slice(0, 600));
    check('Markdown 匯出含 AI 資料與來源', /AI 片語補充/.test(markdown) && /訊息|msg_synthetic/.test(markdown));
    if (ASSET_DIR) {
        fs.mkdirSync(ASSET_DIR, { recursive: true });
        fs.copyFileSync(samplePath, path.join(ASSET_DIR, 'reading-notes-sample-zh-CN.md'));
        await page.screenshot({ path: path.join(ASSET_DIR, 'desktop-zh-CN.png') });
    }
    const preserved = await page.evaluate(async () => {
        const article = await import('/features/article/article.js');
        const previous = { sentence_analysis: [{ sentence: 'old' }], phrase_analysis: [{ selection: 'look forward to' }] };
        const same = article.mergePreservedReadingAnalysis(previous, { sentence_analysis: [], phrase_analysis: [] }, true);
        const changed = article.mergePreservedReadingAnalysis(previous, { sentence_analysis: [], phrase_analysis: [] }, false);
        return { same, changed };
    });
    check('重分析同原文保留句子／短語解析，改原文則不誤用', preserved.same.sentence_analysis.length === 1
        && preserved.same.phrase_analysis.length === 1
        && preserved.changed.sentence_analysis.length === 0, JSON.stringify(preserved));
    check('桌面流程沒有 console/page 錯誤', errors.length === 0, errors.join('\n'));
    await context.close();
    return { samplePath };
}

async function runDesktopHk(browser) {
    console.log('\n[桌面 zh-HK：雙語文案]');
    const { context, page, errors } = await newPage(browser, { locale: 'zh-HK', viewport: { width: 1440, height: 960 } });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    await dismissStartup(page);
    await seedReadingFixture(page);
    await openArticle(page);
    await page.click('#article-reading-records-btn');
    await page.waitForTimeout(300);
    const text = await page.locator('#article-reading-panel').innerText();
    check('zh-HK 使用香港書面中文（學習記錄／筆記／匯出）', /本文學習記錄/.test(text) && /個人筆記/.test(text) && /匯出閱讀筆記/.test(text), text.slice(0, 200));
    if (ASSET_DIR) await page.screenshot({ path: path.join(ASSET_DIR, 'desktop-zh-HK.png') });
    check('zh-HK 流程沒有 console/page 錯誤', errors.length === 0, errors.join('\n'));
    await context.close();
}

async function runMobile(browser) {
    console.log('\n[手機 390×844：點首末詞選短語、保存與筆記]');
    const { context, page, errors } = await newPage(browser, { locale: 'zh-CN', viewport: { width: 390, height: 844 }, mobile: true });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    await dismissStartup(page);
    await page.evaluate(async () => {
        const art = await import('/modules/article-store.js');
        const rd = await import('/modules/reading-store.js');
        await art.initArticleStore(); await rd.initReadingStore();
        await art.saveArticle({
            articleId: 'art_mobile_preview',
            article: 'We look forward to meeting you.',
            title: 'Mobile Phrase',
            sourceType: 'paste',
            result: {
                chinese_translation: '我們期待與你見面。',
                word_alignment: [],
                detailed_analysis: [{ word: 'look', sentence: 'We look forward to meeting you.', analysis: { phonetic: 'lʊk', pos: 'v.', meaning: '看；期待', role: '動詞' } }],
                paragraph_analysis: [{ chinese_translation: '我們期待與你見面。', sentences: [{ en: 'We look forward to meeting you.', zh: '我們期待與你見面。' }] }],
                sentence_analysis: [], phrase_analysis: []
            }
        });
        const st = await import('/modules/state.js');
        st.setCurrentArticleId('art_mobile_preview');
    });
    await openArticle(page, 'art_mobile_preview');
    await page.locator('.interactive-word[data-word="look"]').first().click();
    await page.waitForTimeout(250);
    await page.locator('#word-analysis-tooltip .btn-pick-phrase').click();
    await page.waitForTimeout(350);
    check('手機短語面板開啟', await page.locator('#phrase-picker:not(.hidden)').count() === 1);
    check('起詞 look 已預選', await page.locator('.phrase-token.is-start').count() === 1);
    await page.locator('.phrase-token').nth(3).click();
    const preview = await page.locator('#phrase-picker-preview').innerText();
    check('點末詞後預覽完整短語與原句', preview.includes('look forward to') && preview.includes('We look forward to meeting you.'), preview);
    if (ASSET_DIR) await page.screenshot({ path: path.join(ASSET_DIR, 'mobile-phrase-zh-CN.png') });
    await page.click('#phrase-picker-add');
    await page.waitForTimeout(800);
    const saved = await page.evaluate(async () => {
        const rd = await import('/modules/reading-store.js');
        const item = rd.findPhraseItem('art_mobile_preview', 'look forward to', 'We look forward to meeting you.');
        return { itemId: item?.id || '', saved: item ? rd.isItemSaved(item.id) : false, entries: rd.listVocabularyEntries().length, links: rd.listVocabularyLinks().length };
    });
    check('短語已保存並建立詞書來源關聯', saved.saved && saved.entries >= 1 && saved.links >= 1, JSON.stringify(saved));
    await page.click('#phrase-picker-mark');
    await page.waitForTimeout(350);
    const markedMobile = await page.evaluate(async (id) => (await import('/modules/reading-store.js')).getLearningItem(id)?.marked, saved.itemId);
    check('手機短語選擇器可切換標記', markedMobile === false, String(markedMobile));
    await page.click('#phrase-picker-mark');
    await page.waitForTimeout(350);
    const remarkedMobile = await page.evaluate(async (id) => (await import('/modules/reading-store.js')).getLearningItem(id)?.marked, saved.itemId);
    check('手機短語選擇器可再次標記', remarkedMobile === true, String(remarkedMobile));
    await page.locator('#phrase-picker-note').click();
    await page.fill('#phrase-picker-note-input', '手機筆記：to 後面接動名詞。');
    await page.waitForTimeout(750);
    const note = await page.evaluate(async (id) => (await import('/modules/reading-store.js')).getLearningItem(id)?.note, saved.itemId);
    check('手機短語筆記自動保存', String(note).includes('手機筆記'), note);
    if (ASSET_DIR) await page.screenshot({ path: path.join(ASSET_DIR, 'mobile-phrase-saved-zh-CN.png') });
    await page.locator('.phrase-picker-close').click();
    await page.waitForTimeout(200);
    await page.click('#article-reading-records-btn');
    await page.waitForTimeout(350);
    check('手機本文記錄以底部面板呈現', await page.locator('#article-reading-panel:not(.hidden)').count() === 1);
    if (ASSET_DIR) await page.screenshot({ path: path.join(ASSET_DIR, 'mobile-panel-zh-CN.png') });
    // 重新載入後仍保留
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1400);
    const persisted = await page.evaluate(async (id) => {
        const rd = await import('/modules/reading-store.js');
        await rd.ensureArticleReadingLoaded('art_mobile_preview');
        return rd.getLearningItem(id);
    }, saved.itemId);
    check('重新載入後短語、標記與筆記仍在', persisted && persisted.marked === true && String(persisted.note).includes('手機筆記'));
    check('手機流程沒有 console/page 錯誤', errors.length === 0, errors.join('\n'));
    await context.close();
}

async function runDuplicatePosition(browser) {
    console.log('\n[同句重複詞／重複句：精確位置與即時事件]');
    const { context, page, errors } = await newPage(browser, { locale: 'zh-CN', viewport: { width: 1440, height: 960 } });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    await dismissStartup(page);
    const ids = await page.evaluate(async () => {
        const art = await import('/modules/article-store.js');
        const rd = await import('/modules/reading-store.js');
        const { contentVersionOf } = await import('/shared/reading-protocol.mjs');
        await art.initArticleStore(); await rd.initReadingStore();
        const sentence = 'A test and another test.';
        const body = `${sentence}\n\n${sentence}`;
        await art.saveArticle({
            articleId: 'art_duplicate',
            article: body,
            title: 'Duplicate',
            sourceType: 'paste',
            result: {
                chinese_translation: '測試。\n\n測試。',
                word_alignment: [], detailed_analysis: [],
                paragraph_analysis: [
                    { chinese_translation: '測試。', sentences: [{ en: sentence, zh: '測試。' }] },
                    { chinese_translation: '測試。', sentences: [{ en: sentence, zh: '測試。' }] }
                ]
            }
        });
        const secondStart = body.lastIndexOf('test');
        const item = await rd.upsertLearningItem({
            articleId: 'art_duplicate',
            contentVersion: contentVersionOf(body),
            kind: 'word',
            anchor: { start: secondStart, end: secondStart + 4, quote: 'test', prefix: 'A test and another ', suffix: '.' },
            sentence,
            note: 'second occurrence',
            marked: true,
            understanding: 'needs_review'
        }, { markViewed: true });
        const st = await import('/modules/state.js');
        st.setCurrentArticleId('art_duplicate');
        st.setCurrentWordbookId('art_duplicate');
        return { itemId: item.entity.id, secondStart };
    });
    await openArticle(page, 'art_duplicate');
    const mark = await page.evaluate(() => {
        const marks = Array.from(document.querySelectorAll('.reading-mark-active'));
        return marks.map((el) => ({
            text: el.textContent,
            paragraph: el.closest('.paragraph-pair')?.getAttribute('data-paragraph-index')
        }));
    });
    check('重複句只標記精確的第二段第二個 test', mark.length === 1 && mark[0].text === 'test' && mark[0].paragraph === '1', JSON.stringify(mark));
    const eventUpdate = await page.evaluate(async (id) => {
        const rd = await import('/modules/reading-store.js');
        await rd.patchLearningItem(id, { marked: false });
        await new Promise((resolve) => setTimeout(resolve, 250));
        const cleared = document.querySelectorAll('.reading-mark-active').length;
        await rd.patchLearningItem(id, { marked: true });
        await new Promise((resolve) => setTimeout(resolve, 250));
        return {
            cleared,
            restored: document.querySelectorAll('.reading-mark-active').length
        };
    }, ids.itemId);
    check('永久層變更事件即時更新正文標記', eventUpdate.cleared === 0 && eventUpdate.restored === 1, JSON.stringify(eventUpdate));
    // 未預置解析、無 AI 設定的單詞也必須能直接選短語／收藏。
    const secondWord = page.locator('.paragraph-pair[data-paragraph-index="1"] .interactive-word[data-word="test"]').nth(1);
    await secondWord.click();
    await page.waitForTimeout(350);
    check('未查過的單詞仍顯示選短語與收藏', await page.locator('#word-analysis-tooltip .btn-pick-phrase').count() === 1
        && await page.locator('#word-analysis-tooltip .btn-add-to-book').count() === 1);
    await page.locator('#word-analysis-tooltip .btn-pick-phrase').click();
    await page.waitForTimeout(250);
    const selectedToken = await page.locator('.phrase-token.is-start').innerText().catch(() => '');
    const selectedIndex = await page.locator('.phrase-token').evaluateAll((nodes) => nodes.findIndex((node) => node.classList.contains('is-start')));
    check('點第二個同字詞時短語面板選對 occurrence', selectedToken === 'test' && selectedIndex === 4, `${selectedToken}/${selectedIndex}`);
    await page.locator('.phrase-picker-close').click().catch(() => {});
    check('重複位置流程沒有 console/page 錯誤', errors.length === 0, errors.join('\n'));
    await context.close();
}

async function runMigrationAndBackup(browser) {
    console.log('\n[遷移、超過 50 條聊天、完整備份還原、清快取與舊 ack]');
    const { context, page, errors } = await newPage(browser, { locale: 'zh-CN', viewport: { width: 1280, height: 900 } });
    // 先用空白文件建立同源頁面，在 main.js 載入前寫入舊資料。
    await page.goto(BASE + 'test-reading-blank.html', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.evaluate(async ({ article }) => {
        const text = article.body;
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ namespace: 'assistant-article', payload: text })));
        const hash = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
        const articleKey = `bdc:cache:v1:assistant-article:${hash}`;
        localStorage.setItem('analyzedArticles', JSON.stringify([{ articleId: article.id, article: article.body, result: article.result }]));
        localStorage.setItem('articleMetas', JSON.stringify({
            [article.id]: { id: article.id, title: article.title, sourceType: 'paste', createdAt: Date.now() - 86400000 }
        }));
        localStorage.setItem('vocabularyBooks', JSON.stringify([{
            id: article.id,
            name: 'Legacy Book',
            sourceType: 'article',
            articleId: article.id,
            createdAt: new Date().toISOString(),
            words: [{ id: 'legacy_word', word: 'look forward to', meaning: '期待', context: article.sentence, sourceArticleId: article.id }]
        }]));
        const messages = Array.from({ length: 72 }, (_, i) => ({
            role: i % 2 === 0 ? 'user' : 'assistant',
            content: `legacy message ${i + 1}`,
            ts: Date.now() + i
        }));
        localStorage.setItem('assistantConvIndex', JSON.stringify([{ id: 'legacy_conv', articleKey, title: 'Legacy Chat', updatedAt: new Date().toISOString() }]));
        // 直接寫入舊 bdc-cache/kv
        const db = await new Promise((resolve, reject) => {
            const req = indexedDB.open('bdc-cache', 1);
            req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains('kv')) req.result.createObjectStore('kv', { keyPath: 'key' }); };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        await new Promise((resolve, reject) => {
            const tx = db.transaction('kv', 'readwrite');
            tx.objectStore('kv').put({ key: 'assistant:conv:legacy_conv', v: 1, expiresAt: 0, value: { messages } });
            tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
        });
        db.close();
        window.__legacyKey = articleKey;
    }, { article: ARTICLE });

    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1700);
    await dismissStartup(page);
    const migrated = await page.evaluate(async () => {
        const rd = await import('/modules/reading-store.js');
        const msgs = await rd.getMessages('legacy_conv');
        return {
            complete: rd.isReadingMigrated(),
            books: rd.listVocabularyBooks().length,
            entries: rd.listVocabularyEntries().length,
            links: rd.listVocabularyLinks().length,
            conversations: rd.listConversations().length,
            messages: msgs.length,
            articleId: rd.getConversation('legacy_conv')?.articleId || ''
        };
    });
    check('舊詞書與聊天遷移完成', migrated.complete && migrated.books === 1 && migrated.entries === 1, JSON.stringify(migrated));
    check('聊天超過 50 條全部遷移', migrated.messages === 72, JSON.stringify(migrated));
    check('舊聊天以唯一原文 hash 對應穩定 articleId', migrated.articleId === ARTICLE.id, migrated.articleId);
    check('舊詞書能定位時建立來源關聯', migrated.links >= 1, JSON.stringify(migrated));

    const legacyParse = await page.evaluate(async (articleId) => {
        const rd = await import('/modules/reading-store.js');
        const imported = await rd.importLegacyItemsForArticle(articleId);
        const items = rd.listLearningItems(articleId);
        return {
            imported,
            items: items.map((item) => ({ kind: item.kind, quote: item.anchor?.quote, viewed: item.firstViewedAt, marked: item.marked }))
        };
    }, ARTICLE.id);
    check('舊文章解析按需導入條目，但不偽造查閱時間', legacyParse.imported.ok
        && legacyParse.items.some((item) => item.quote === 'look')
        && legacyParse.items.filter((item) => item.quote === 'look').every((item) => !item.viewed && item.marked === false), JSON.stringify(legacyParse));

    const backup = await page.evaluate(async () => {
        const rd = await import('/modules/reading-store.js');
        const backupTool = await import('/modules/local-backup.js');
        const before = await rd.exportAll();
        const created = await backupTool.createBackup('manual');
        const payload = backupTool.loadBackupPayload(created.id);
        const outboxBefore = (await rd.exportAll()).messages.length;
        await rd.clearScopeForTests();
        const cleared = (await rd.exportAll()).messages.length;
        const restored = await rd.restoreAll(before);
        const after = await rd.exportAll();
        return {
            createdOk: !!created.id,
            backupMessages: payload?.reading?.messages?.length || 0,
            outboxBefore,
            cleared,
            restored,
            afterMessages: after.messages.length,
            afterConvs: after.conversations.length,
            afterLinks: after.vocabularyLinks.length
        };
    });
    check('本機備份包含全部 72 條消息', backup.createdOk && backup.backupMessages === 72, JSON.stringify(backup));
    check('完整備份可還原全部消息與關聯', backup.restored.ok && backup.afterMessages === 72 && backup.afterConvs >= 1, JSON.stringify(backup));

    const cacheResult = await page.evaluate(async () => {
        const rd = await import('/modules/reading-store.js');
        const cache = await import('/modules/cache.js');
        await cache.setItem('bdc:cache:v1:rebuildable-test', { value: 'x' });
        const before = await rd.permanentEntityCounts();
        await cache.clearRebuildable();
        const after = await rd.permanentEntityCounts();
        return { before, after, cacheLeft: await cache.getItem('bdc:cache:v1:rebuildable-test') };
    });
    check('清快取不影響永久消息／詞書／關聯', cacheResult.after.messages === cacheResult.before.messages
        && cacheResult.after.vocabularyEntries === cacheResult.before.vocabularyEntries
        && cacheResult.after.vocabularyLinks === cacheResult.before.vocabularyLinks
        && cacheResult.cacheLeft === null, JSON.stringify(cacheResult));

    const oldAck = await page.evaluate(async ({ article }) => {
        const rd = await import('/modules/reading-store.js');
        const { contentVersionOf } = await import('/shared/reading-protocol.mjs');
        const created = await rd.upsertLearningItem({
            articleId: article.id,
            contentVersion: contentVersionOf(article.body),
            kind: 'word',
            anchor: { start: 3, end: 7, quote: 'look', prefix: 'We ', suffix: ' forward' },
            sentence: article.sentence,
            understanding: 'unmarked',
            note: 'first'
        }, { markViewed: true });
        const firstOp = (await rd.listOutbox()).find((op) => op.entityId === created.entity.id);
        await rd.patchLearningItem(created.entity.id, { note: 'second edit' });
        await rd.markOutboxAcknowledged('learningItem', created.entity.id, { mutationId: firstOp.mutationId, revision: 1 });
        const outbox = (await rd.listOutbox()).find((op) => op.entityId === created.entity.id);
        const item = rd.getLearningItem(created.entity.id);
        const art = await import('/modules/article-store.js');
        await art.saveArticle({ articleId: 'art_ack_race', article: 'first body', title: 'Ack Race', sourceType: 'paste', result: { chinese_translation: 'x', paragraph_analysis: [{ chinese_translation: 'x' }] } });
        const firstArticleOp = (await art.listPending()).find((op) => op.articleId === 'art_ack_race');
        await art.saveArticle({ articleId: 'art_ack_race', article: 'second body', title: 'Ack Race', sourceType: 'paste', result: { chinese_translation: 'y', paragraph_analysis: [{ chinese_translation: 'y' }] } });
        await art.markOpDone('art_ack_race', { clientMutationId: firstArticleOp.clientMutationId, revision: 1 });
        const articlePending = (await art.listPending()).find((op) => op.articleId === 'art_ack_race');
        const articleRecord = art.getRecord('art_ack_race');
        const conv = await rd.ensureConversation({ id: 'conv_ack_test', articleId: article.id, title: 'Ack' });
        const sent = await rd.appendMessage({ conversationId: conv.conversation.id, role: 'user', content: 'ack message', articleId: article.id });
        const msgOp = (await rd.listOutbox()).find((op) => op.entityType === 'message' && op.entityId === sent.message.id);
        await rd.markOutboxAcknowledged('message', sent.message.id, { mutationId: msgOp.mutationId, revision: 1 });
        const message = (await rd.getMessages(conv.conversation.id)).find((m) => m.id === sent.message.id);
        await rd.markOutboxAcknowledged('message', sent.message.id, { mutationId: 'old-ack', revision: 0 });
        const messageAfterOldAck = (await rd.getMessages(conv.conversation.id)).find((m) => m.id === sent.message.id);
        return {
            pendingStill: !!outbox,
            mutationChanged: outbox && outbox.mutationId !== firstOp.mutationId,
            note: item?.note,
            revision: item?.revision,
            messageRevision: message?.revision,
            messagePending: message?.pending,
            oldAckRevision: messageAfterOldAck?.revision,
            articlePending: !!articlePending,
            articleMutationChanged: articlePending && articlePending.clientMutationId !== firstArticleOp.clientMutationId,
            articlePendingFlag: articleRecord?.pending,
            articleBody: articleRecord?.article
        };
    }, { article: ARTICLE });
    check('舊 ack 不會清掉上傳期間的新編輯', oldAck.pendingStill && oldAck.mutationChanged && oldAck.note === 'second edit', JSON.stringify(oldAck));
    check('消息 ack 更新 revision／pending，舊 ack 不降低 revision', oldAck.messageRevision === 1
        && oldAck.messagePending === false && oldAck.oldAckRevision === 1, JSON.stringify(oldAck));
    check('文章舊 ack 不清掉上傳期間的新修改', oldAck.articlePending && oldAck.articleMutationChanged
        && oldAck.articlePendingFlag === true && oldAck.articleBody === 'second body', JSON.stringify(oldAck));
    const concurrent = await page.evaluate(async () => {
        const rd = await import('/modules/reading-store.js');
        const { contentVersionOf } = await import('/shared/reading-protocol.mjs');
        const articleId = 'art_concurrent';
        const body = 'A test and another test.';
        const art = await import('/modules/article-store.js');
        await art.saveArticle({ articleId, article: body, title: 'Concurrent', sourceType: 'paste', result: { chinese_translation: 'x', paragraph_analysis: [{ chinese_translation: 'x' }] } });
        const payload = {
            articleId,
            contentVersion: contentVersionOf(body),
            kind: 'word',
            anchor: { start: 2, end: 6, quote: 'test', prefix: 'A ', suffix: ' and' },
            sentence: body,
            note: 'base',
            marked: false,
            understanding: 'unmarked'
        };
        const [first, second] = await Promise.all([
            rd.upsertLearningItem(payload, { markViewed: true }),
            rd.upsertLearningItem(payload, { markViewed: true })
        ]);
        const items = rd.listLearningItems(articleId);
        const id = first.entity.id;
        await Promise.all([
            rd.patchLearningItem(id, { note: 'note from A' }),
            rd.patchLearningItem(id, { marked: true })
        ]);
        await rd.patchLearningItem(id, { note: 'keep this note', marked: true });
        const actions = await import('/modules/reading-actions.js');
        await actions.ensureItem({
            articleId,
            kind: 'word',
            quote: 'test',
            sentence: body,
            anchor: payload.anchor
        });
        const after = rd.getLearningItem(id);
        return {
            sameId: first.entity.id === second.entity.id,
            count: items.length,
            note: after.note,
            marked: after.marked
        };
    });
    check('同一引用同時 upsert 不增生，並行不同欄位 patch 不互相覆蓋', concurrent.sameId && concurrent.count === 1 && concurrent.note === 'keep this note' && concurrent.marked === true, JSON.stringify(concurrent));

    const reanchor = await page.evaluate(async () => {
        const art = await import('/modules/article-store.js');
        const rd = await import('/modules/reading-store.js');
        const { contentVersionOf } = await import('/shared/reading-protocol.mjs');
        const firstBody = 'We look forward to meeting you.';
        await art.saveArticle({ articleId: 'art_reanchor', article: firstBody, title: 'Reanchor', sourceType: 'paste', result: { chinese_translation: 'x', paragraph_analysis: [{ chinese_translation: 'x' }] } });
        const item = await rd.upsertLearningItem({
            articleId: 'art_reanchor',
            contentVersion: contentVersionOf(firstBody),
            kind: 'phrase',
            anchor: { start: 3, end: 23, quote: 'look forward to', prefix: 'We ', suffix: ' meeting' },
            sentence: 'We look forward to meeting you.',
            note: 'keep me',
            marked: true,
            understanding: 'understood'
        }, { markViewed: true });
        await art.saveArticle({ articleId: 'art_reanchor', article: 'Intro. We look forward to meeting you soon.', title: 'Reanchor', sourceType: 'paste', result: { chinese_translation: 'y', paragraph_analysis: [{ chinese_translation: 'y' }] } });
        const moved = rd.getLearningItem(item.entity.id);
        await art.saveArticle({ articleId: 'art_reanchor', article: 'We look forward to it. We look forward to it again.', title: 'Reanchor', sourceType: 'paste', result: { chinese_translation: 'z', paragraph_analysis: [{ chinese_translation: 'z' }] } });
        const ambiguous = rd.getLearningItem(item.entity.id);
        const versions = await rd.listArticleVersions('art_reanchor');
        return {
            moved: { start: moved.anchor.start, sourceVersion: moved.sourceContentVersion, contentVersion: moved.contentVersion, note: moved.note, marked: moved.marked },
            ambiguous: { uncertain: ambiguous.positionUncertain, contentVersion: ambiguous.contentVersion, note: ambiguous.note, marked: ambiguous.marked },
            versions: versions.length
        };
    });
    check('原文變更唯一匹配時重新定位並保留筆記／標記', reanchor.moved.start > 0 && reanchor.moved.note === 'keep me' && reanchor.moved.marked === true && reanchor.moved.sourceVersion !== '', JSON.stringify(reanchor));
    check('歧義時標為位置待確認，不貼到第一個同詞且保留舊版本', reanchor.ambiguous.uncertain === true && reanchor.ambiguous.note === 'keep me' && reanchor.versions >= 1, JSON.stringify(reanchor));

    const aiTrace = await page.evaluate(async () => {
        const rd = await import('/modules/reading-store.js');
        const actions = await import('/modules/reading-actions.js');
        const saved = await actions.saveAiAnswerAsDocument({
            articleId: 'art_reading_preview',
            conversationId: 'legacy_conv',
            messageId: 'legacy-msg-1',
            content: '保留的 AI 解釋內容。'
        });
        const itemBefore = rd.listLearningItems('art_reading_preview').map((item) => ({ id: item.id, note: item.note, marked: item.marked }));
        const generated = await actions.generateReadingDocument({ articleId: 'art_reading_preview', mode: 'notes' });
        const itemAfter = rd.listLearningItems('art_reading_preview').map((item) => ({ id: item.id, note: item.note, marked: item.marked }));
        return {
            saved: saved.ok,
            doc: saved.ok ? saved.entity : null,
            generated,
            unchanged: JSON.stringify(itemBefore) === JSON.stringify(itemAfter)
        };
    });
    check('AI 回答可保留為可追溯文件', aiTrace.saved && aiTrace.doc.sourceMessageIds.includes('legacy-msg-1'), JSON.stringify(aiTrace.doc));
    check('未配置 AI 時明確失敗且不改標記／筆記', aiTrace.generated.ok === false && aiTrace.generated.error === 'ai_not_configured' && aiTrace.unchanged, JSON.stringify(aiTrace.generated));
    const crossAccount = await page.evaluate(async () => {
        const art = await import('/modules/article-store.js');
        const rd = await import('/modules/reading-store.js');
        localStorage.setItem('sync_token', 'b'.repeat(40));
        localStorage.setItem('sync_user_id', 'review_account_b');
        localStorage.setItem('sync_label', 'Review B');
        await art.refreshScope();
        await rd.reloadReadingScope();
        const migration = await rd.migrateLegacyReadingData();
        return {
            migration,
            books: rd.listVocabularyBooks().length,
            entries: rd.listVocabularyEntries().length,
            conversations: rd.listConversations().length
        };
    });
    check('無範圍舊資料只被第一個帳戶認領，第二帳戶不串資料', crossAccount.migration.claimedElsewhere === true
        && crossAccount.books === 0 && crossAccount.entries === 0 && crossAccount.conversations === 0, JSON.stringify(crossAccount));
    const guestAdopt = await page.evaluate(async () => {
        const rd = await import('/modules/reading-store.js');
        const counts = await rd.guestReadingCounts();
        const result = await rd.adoptGuestReadingData();
        return {
            counts,
            result,
            books: rd.listVocabularyBooks().length,
            conversations: rd.listConversations().length,
            messages: (await rd.getMessages('legacy_conv')).length
        };
    });
    check('使用者明確選擇後可把訪客閱讀資料帶入目前帳戶', guestAdopt.counts.books >= 1
        && guestAdopt.result.ok && guestAdopt.books >= 1 && guestAdopt.messages === 72, JSON.stringify(guestAdopt));

    check('遷移／備份流程沒有 console/page 錯誤', errors.length === 0, errors.join('\n'));
    await context.close();
}

(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: CHROME });
    try {
        const desktop = await runDesktop(browser);
        await runDesktopHk(browser);
        await runMobile(browser);
        await runDuplicatePosition(browser);
        await runMigrationAndBackup(browser);
        console.log(`\nMarkdown 樣本：${desktop.samplePath}`);
    } finally {
        await browser.close();
    }
    if (failures.length) {
        console.error(`\n${failures.length} 項失敗`);
        for (const failure of failures) console.error(`- ${failure.name}: ${failure.detail}`);
        process.exit(1);
    }
    console.log('\n全部閱讀檔案測試通過');
})();
