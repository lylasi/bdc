/**
 * 文章閱讀檔案的可重現預覽：
 *   - 使用獨立瀏覽器 context 與合成文章，不讀取使用者既有資料或正式帳號
 *   - 攔截 ai-config.js 為合成設定，並阻斷所有外部網路
 *   - 操作實際產品 UI（文章模組、本文學習記錄面板、手機短語面板）
 *   - 產出桌面 1440／手機 390×844／窄 320、zh-CN／zh-HK 截圖
 *   - 產出實際 Markdown 匯出、完整備份，並逐項核對往返的 ID／內容／關聯
 *
 * 用法：
 *   PORT=8313 PLAYWRIGHT_MODULE=<path-to-playwright> node tests/reading-preview.cjs
 *   ASSET_DIR=docs/report/assets/<timestamp> ...
 */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8313);
const BASE = `http://127.0.0.1:${PORT}`;
const ENDPOINT = process.env.TEST_SYNC_ENDPOINT || 'http://127.0.0.1:19999/test-endpoint';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 17);
const ASSET_DIR = path.resolve(process.env.ASSET_DIR || path.join('docs/report/assets', stamp));

const FIXTURE = {
    articleId: 'art_reading_preview',
    title: 'Meeting Follow-up',
    body: 'We look forward to meeting you.\n\nThe attached document summarizes the project timeline and the next steps.\n\nPlease let us know if you have any questions before Friday.',
    result: {
        chinese_translation: '我們期待與你見面。\n\n附件文件總結了項目時間表和下一步。\n\n如有任何問題，請在星期五前告訴我們。',
        word_alignment: [],
        detailed_analysis: [
            { word: 'look', sentence: 'We look forward to meeting you.', analysis: { phonetic: 'lʊk', pos: 'v.', meaning: '看；期待', role: '動詞' } }
        ],
        paragraph_analysis: [
            { chinese_translation: '我們期待與你見面。', sentences: [{ en: 'We look forward to meeting you.', zh: '我們期待與你見面。' }] },
            { chinese_translation: '附件文件總結了項目時間表和下一步。', sentences: [{ en: 'The attached document summarizes the project timeline and the next steps.', zh: '附件文件總結了項目時間表和下一步。' }] },
            { chinese_translation: '如有任何問題，請在星期五前告訴我們。', sentences: [{ en: 'Please let us know if you have any questions before Friday.', zh: '如有任何問題，請在星期五前告訴我們。' }] }
        ],
        sentence_analysis: [],
        phrase_analysis: []
    }
};

const AI_CONFIG_STUB = `export const SYNC={endpoint:""};
export const TTS_CONFIG={}, AI_LIMITS={}, OCR_CONFIG={}, ARTICLE_IMPORT={}, SUPABASE={};`;

function asset(name) {
    return path.join(ASSET_DIR, name);
}

async function newPage(browser, locale, viewport, mobile = false) {
    const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 });
    // 獨立 context；ai-config.js 一律回合成設定，任何外部請求直接阻斷，
    // 不讀取真實私有配置或憑證。
    await context.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith('/ai-config.js')) {
            return route.fulfill({ contentType: 'application/javascript', body: AI_CONFIG_STUB });
        }
        if (url.origin !== BASE) return route.abort();
        return route.continue();
    });
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
    page.on('pageerror', (e) => { errors.push(e.message); console.log('  pageerror:', e.message); });
    page.on('console', (m) => {
        if (m.type() !== 'error') return;
        const text = m.text();
        if (/Failed to load resource|ERR_CONNECTION_REFUSED|ERR_UNSAFE_PORT|ERR_FAILED|401|404|501|尚未选择模型|Error analyzing word/i.test(text)) return;
        errors.push(text);
        console.log('  console:', text.slice(0, 200));
    });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1300);
    await page.evaluate(() => {
        const modal = document.getElementById('app-modal');
        if (modal && !modal.classList.contains('hidden')) modal.querySelector('.modal-close-btn')?.click();
    });
    return { context, page, errors };
}

async function seed(page) {
    return page.evaluate(async ({ article }) => {
        const art = await import('/modules/article-store.js');
        const rd = await import('/modules/reading-store.js');
        const { contentVersionOf, locateTextAnchor } = await import('/shared/reading-protocol.mjs');
        await art.initArticleStore();
        await rd.initReadingStore();
        const saved = await art.saveArticle({
            articleId: article.articleId,
            article: article.body,
            title: article.title,
            sourceType: 'paste',
            result: article.result
        });
        if (!saved.ok) throw new Error(saved.error);
        const version = contentVersionOf(article.body);
        const phraseAnchor = locateTextAnchor(article.body, 'look forward to', 'We look forward to meeting you.').anchor;
        const wordAnchor = locateTextAnchor(article.body, 'look', 'We look forward to meeting you.').anchor;
        const sentenceAnchor = locateTextAnchor(article.body, 'The attached document summarizes the project timeline and the next steps.').anchor;
        const phrase = await rd.upsertLearningItem({
            articleId: article.articleId,
            contentVersion: version,
            kind: 'phrase',
            anchor: phraseAnchor,
            sentence: 'We look forward to meeting you.',
            explanation: {
                language: 'zh-CN',
                result: { selection: 'look forward to', analysis: { meaning: '期待；盼望', usage: '後接名詞或動名詞，表示期待某事發生。' } },
                generatedAt: new Date().toISOString(),
                provenance: { source: 'preview' }
            },
            note: '後面接名詞或動名詞，不能接動詞原形。',
            marked: true,
            understanding: 'needs_review'
        }, { markViewed: true });
        const word = await rd.upsertLearningItem({
            articleId: article.articleId,
            contentVersion: version,
            kind: 'word',
            anchor: wordAnchor,
            sentence: 'We look forward to meeting you.',
            explanation: { language: 'zh-CN', result: { word: 'look', analysis: { meaning: '看；期待' } }, generatedAt: new Date().toISOString(), provenance: {} },
            marked: false,
            understanding: 'understood'
        }, { markViewed: true });
        const sentence = await rd.upsertLearningItem({
            articleId: article.articleId,
            contentVersion: version,
            kind: 'sentence',
            anchor: sentenceAnchor,
            sentence: 'The attached document summarizes the project timeline and the next steps.',
            explanation: {
                language: 'zh-CN',
                result: { translation: '附件文件總結了項目時間表和下一步。', chunks: [{ text: 'summarizes', role: '動詞', note: '總結' }] },
                generatedAt: new Date().toISOString(),
                provenance: {}
            },
            note: 'summarize 的主語是 document。',
            marked: true,
            understanding: 'understood'
        }, { markViewed: true });
        const book = { id: 'book_preview', name: '本文生詞本', sourceType: 'article', createdAt: new Date().toISOString() };
        const entry = { id: 'entry_look', bookId: 'book_preview', word: 'look forward to', meaning: '期待；盼望', phonetic: '', examples: [], sources: [], addedAt: new Date().toISOString() };
        await rd.addVocabularyEntryWithLink({
            book,
            entry,
            link: { id: 'link_look', itemId: phrase.entity.id, bookId: book.id, entryId: entry.id, addedAt: new Date().toISOString() }
        });
        const conv = await rd.ensureConversation({ id: 'conv_preview', articleId: article.articleId, title: 'Preview Chat' });
        const seededMessages = await rd.setConversationMessages(conv.conversation.id, Array.from({ length: 70 }, (_, index) => ({
            role: index % 2 === 0 ? 'user' : 'assistant',
            content: `preview chat message ${index + 1}`,
            ts: Date.now() + index
        })));
        if (!seededMessages.ok) throw new Error(seededMessages.error);
        const messages = await rd.getMessages(conv.conversation.id);
        const sourceMessageIds = [messages[0].id, messages[34].id, messages[69].id];
        const aiDoc = await rd.saveArticleDocument({
            articleId: article.articleId,
            kind: 'ai',
            title: 'AI 片語補充',
            content: 'look forward to + 名詞／動名詞，表示期待某事發生。\n\n例：We look forward to hearing from you.',
            sourceItemIds: [phrase.entity.id],
            sourceMessageIds,
            contentVersion: version
        });
        if (!aiDoc.ok) throw new Error(aiDoc.error);
        await rd.saveArticleDocument({
            articleId: article.articleId,
            kind: 'note',
            title: '全篇心得',
            content: '這封郵件語氣禮貌，重點是確認見面時間與附件。',
            contentVersion: version
        });
        const st = await import('/modules/state.js');
        st.setCurrentArticleId(article.articleId);
        st.setCurrentWordbookId(article.articleId);
        return {
            phraseId: phrase.entity.id,
            wordId: word.entity.id,
            sentenceId: sentence.entity.id,
            aiDocId: aiDoc.entity.id,
            conversationId: conv.conversation.id,
            sourceMessageIds,
            messageCount: messages.length,
            version
        };
    }, { article: FIXTURE });
}

async function waitForToastsGone(page) {
    await page.waitForFunction(() => !document.querySelector('.message-toast.is-shown'), null, { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(120);
}

async function openArticle(page, articleId = FIXTURE.articleId) {
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

async function runMobileFlow(browser, { locale, viewport, prefix, screenshots }) {
    const { context, page, errors } = await newPage(browser, locale, viewport, true);
    const seeded = await seed(page);
    await openArticle(page);
    await page.locator('.interactive-word[data-word="look"]').first().click();
    await page.waitForTimeout(250);
    await page.locator('#word-analysis-tooltip .btn-pick-phrase').click();
    await page.waitForTimeout(350);
    await page.locator('.phrase-token').nth(3).click();
    await page.screenshot({ path: asset(screenshots.picker) });
    await page.click('#phrase-picker-add');
    await page.waitForTimeout(700);
    if (await page.getAttribute('#phrase-picker-mark', 'aria-pressed') !== 'true') {
        await page.click('#phrase-picker-mark');
        await page.waitForTimeout(300);
    }
    await page.locator('#phrase-picker-note').click();
    await page.fill('#phrase-picker-note-input', locale === 'zh-HK'
        ? '手機筆記：to 後面接動名詞，不能接動詞原形。'
        : '手机笔记：to 后面接动名词，不能接动词原形。');
    await page.waitForTimeout(900);
    await waitForToastsGone(page);
    await page.screenshot({ path: asset(screenshots.saved) });
    await page.locator('.phrase-picker-close').click();
    await page.waitForTimeout(300);
    await page.click('#article-reading-records-btn');
    await page.waitForTimeout(350);
    await waitForToastsGone(page);
    const layout = await page.evaluate(() => {
        const sheet = document.querySelector('.reading-panel-sheet');
        return {
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
            sheetWidth: sheet ? Math.round(sheet.getBoundingClientRect().width) : null,
            overflowX: document.documentElement.scrollWidth > window.innerWidth,
            filtersVisible: !!document.querySelector('.reading-panel-filters')
                && document.querySelector('.reading-panel-filters').getBoundingClientRect().height > 20,
            noteStatus: document.querySelector('[data-note-status]')?.textContent?.trim() || ''
        };
    });
    await page.screenshot({ path: asset(screenshots.panel) });
    await context.close();
    if (layout.overflowX) throw new Error(`手機 ${viewport.width} 出現水平溢出：` + JSON.stringify(layout));
    if (!layout.filtersVisible) throw new Error(`手機 ${viewport.width} 篩選列被壓扁：` + JSON.stringify(layout));
    return { seeded, errors, layout };
}

(async () => {
    fs.mkdirSync(ASSET_DIR, { recursive: true });
    const browser = await chromium.launch({ headless: true, executablePath: CHROME });
    const manifest = { createdAt: new Date().toISOString(), fixture: FIXTURE, assets: [] };
    try {
        // 桌面 zh-CN：標記 + 本文記錄側欄
        const cn = await newPage(browser, 'zh-CN', { width: 1440, height: 960 });
        const cnIds = await seed(cn.page);
        await openArticle(cn.page);
        await cn.page.click('#article-reading-records-btn');
        await cn.page.waitForTimeout(400);
        // 桌面側欄不得蓋住正文：實際量測每句右界是否越過面板起點。
        const desktopLayout = await cn.page.evaluate(() => {
            const panelEl = document.getElementById('article-reading-panel');
            const sheet = document.querySelector('.reading-panel-sheet');
            const panelX = panelEl && !panelEl.classList.contains('hidden') && sheet
                ? Math.round(sheet.getBoundingClientRect().x)
                : null;
            const sentences = [...document.querySelectorAll('.interactive-sentence')].map((el) => {
                const rect = el.getBoundingClientRect();
                return { left: Math.round(rect.left), right: Math.round(rect.right), text: el.textContent.trim().slice(0, 40) };
            });
            return {
                viewportWidth: window.innerWidth,
                panelX,
                sentenceCount: sentences.length,
                covered: panelX == null ? [] : sentences.filter((item) => item.right > panelX),
                overflowX: document.documentElement.scrollWidth > window.innerWidth
            };
        });
        manifest.desktopLayout = desktopLayout;
        if (!desktopLayout.panelX || desktopLayout.sentenceCount < 3 || desktopLayout.covered.length || desktopLayout.overflowX) {
            throw new Error('桌面本文學習記錄側欄遮住正文或造成水平溢出：' + JSON.stringify(desktopLayout));
        }
        await cn.page.screenshot({ path: asset('desktop-1440-zh-CN-marks-and-panel.png') });
        manifest.assets.push('desktop-1440-zh-CN-marks-and-panel.png');

        const downloadPromise = cn.page.waitForEvent('download');
        await cn.page.click('#reading-export-md');
        const download = await downloadPromise;
        const mdPath = asset('reading-notes-zh-CN.md');
        await download.saveAs(mdPath);
        manifest.assets.push('reading-notes-zh-CN.md');

        const backup = await cn.page.evaluate(async () => {
            const exporter = await import('/modules/reading-export.js');
            const rd = await import('/modules/reading-store.js');
            const art = await import('/modules/article-store.js');
            const sync = await import('/modules/sync-core.js');
            const pick = (list, fields) => list.map((item) => {
                const out = { id: item.id };
                for (const field of fields) out[field] = item[field];
                return out;
            }).sort((a, b) => String(a.id).localeCompare(String(b.id)));
            const pickArticles = (list) => list.map((item) => ({
                id: item.id,
                title: item.title,
                body: item.body,
                analysis: item.analysis,
                sourceType: item.sourceType,
                sourceUrl: item.sourceUrl
            })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
            const readingFields = {
                items: ['articleId', 'kind', 'contentVersion', 'anchor', 'sentence', 'note', 'marked', 'understanding', 'firstViewedAt', 'lastViewedAt'],
                documents: ['articleId', 'kind', 'title', 'content', 'sourceItemIds', 'sourceMessageIds', 'contentVersion'],
                conversations: ['articleId', 'title'],
                messages: ['conversationId', 'role', 'content', 'createdAt', 'learningItemId', 'contentVersion', 'anchor'],
                books: ['name', 'sourceType'],
                entries: ['bookId', 'word', 'meaning'],
                links: ['itemId', 'bookId', 'entryId'],
                versions: ['articleId', 'version', 'body']
            };
            const readingSources = {
                items: 'learningItems',
                documents: 'articleDocuments',
                conversations: 'conversations',
                messages: 'messages',
                books: 'vocabularyBooks',
                entries: 'vocabularyEntries',
                links: 'vocabularyLinks',
                versions: 'articleVersions'
            };
            const pickReading = (data) => Object.fromEntries(Object.entries(readingFields)
                .map(([key, fields]) => [key, pick(data[readingSources[key]] || [], fields)]));
            // 先固定目前資料，之後的還原只從真正的備份 JSON 取內容。
            const before = await rd.exportAll();
            const beforeData = pickReading(before);
            const articlesBefore = await art.exportDocuments();
            const articlesBeforeData = pickArticles(articlesBefore);
            const full = await exporter.buildFullBackup();
            // 驗證必須從實際下載／序列化的 JSON 還原，不能另讀一份記憶體資料。
            const serialized = JSON.stringify(full);
            const parsed = JSON.parse(serialized);
            const backupReadingData = pickReading(parsed.payload?.reading || {});
            const backupArticlesData = pickArticles(parsed.payload?.articleDocuments || []);
            const knownItem = before.learningItems.find((item) => item.note && item.anchor?.quote === 'look forward to');
            const knownDoc = before.articleDocuments.find((doc) => doc.kind === 'ai');
            const knownMessage = before.messages[34];
            const backupDoc = parsed.ok && parsed.payload?.reading?.articleDocuments?.find((doc) => doc.id === knownDoc?.id);
            const backupArticle = parsed.ok && parsed.payload?.articleDocuments?.find((doc) => doc.id === 'art_reading_preview');
            // 清空文章底層，確保後面讀到的原文／分析真的來自備份 JSON。
            await new Promise((resolve, reject) => {
                const request = indexedDB.open('bdc-articles');
                request.onerror = () => reject(request.error);
                request.onsuccess = () => {
                    const db = request.result;
                    const tx = db.transaction(['docs', 'article_summaries'], 'readwrite');
                    tx.objectStore('docs').clear();
                    tx.objectStore('article_summaries').clear();
                    tx.oncomplete = () => { db.close(); resolve(); };
                    tx.onerror = () => { db.close(); reject(tx.error); };
                    tx.onabort = () => { db.close(); reject(tx.error); };
                };
            });
            await art.reloadScope();
            const articlesCleared = (await art.exportDocuments()).length;
            await rd.clearScopeForTests();
            const cleared = (await rd.exportAll()).messages.length;
            // 與產品備份面板相同：從解析後的 payload 還原文章文件與閱讀資料。
            await sync.restoreSnapshotLocally(parsed.payload);
            const after = await rd.exportAll();
            const articlesAfter = await art.exportDocuments();
            const afterData = pickReading(after);
            const articlesAfterData = pickArticles(articlesAfter);
            const restoredItem = after.learningItems.find((item) => item.id === knownItem?.id);
            const restoredDoc = after.articleDocuments.find((doc) => doc.id === knownDoc?.id);
            const restoredMessage = after.messages.find((msg) => msg.id === knownMessage?.id);
            return {
                full,
                roundtrip: {
                    beforeOk: before.ok,
                    beforeError: before.error || '',
                    beforeCounts: Object.fromEntries(Object.keys(readingFields).map((key) => [key, (before[readingSources[key]] || []).length])),
                    backupCounts: Object.fromEntries(Object.keys(readingFields).map((key) => [key, (parsed.payload?.reading?.[readingSources[key]] || []).length])),
                    afterCounts: Object.fromEntries(Object.keys(readingFields).map((key) => [key, (after[readingSources[key]] || []).length])),
                    restored: {
                        ok: articlesAfterData.length === 1 && after.messages.length === before.messages.length
                    },
                    scope: before.scope,
                    messagesBefore: before.messages.length,
                    messagesCleared: cleared,
                    messagesAfter: after.messages.length,
                    articlesBefore: articlesBeforeData,
                    articlesAfter: articlesAfterData,
                    articlesCleared,
                    articleCount: articlesAfterData.length,
                    articleRestored: JSON.stringify(articlesBeforeData) === JSON.stringify(articlesAfterData),
                    articleBackupMatches: !!backupArticle
                        && backupArticle.id === articlesBeforeData[0]?.id
                        && backupArticle.title === articlesBeforeData[0]?.title
                        && backupArticle.body === articlesBeforeData[0]?.body
                        && JSON.stringify(backupArticle.analysis) === JSON.stringify(articlesBeforeData[0]?.analysis)
                        && backupArticle.sourceType === articlesBeforeData[0]?.sourceType
                        && backupArticle.sourceUrl === articlesBeforeData[0]?.sourceUrl,
                    idsMatch: JSON.stringify(beforeData) === JSON.stringify(afterData)
                        && JSON.stringify(backupReadingData) === JSON.stringify(afterData),
                    backupDataMatches: JSON.stringify(backupReadingData) === JSON.stringify(afterData),
                    beforeData,
                    backupReadingData,
                    afterData,
                    sourceReferences: {
                        backupDocSourceItemIds: backupDoc?.sourceItemIds || [],
                        backupDocSourceMessageIds: backupDoc?.sourceMessageIds || [],
                        restoredSourceItemIds: restoredDoc?.sourceItemIds || [],
                        restoredSourceMessageIds: restoredDoc?.sourceMessageIds || [],
                        matches: JSON.stringify(backupDoc?.sourceItemIds || []) === JSON.stringify(restoredDoc?.sourceItemIds || [])
                            && JSON.stringify(backupDoc?.sourceMessageIds || []) === JSON.stringify(restoredDoc?.sourceMessageIds || [])
                    },
                    contentMatch: {
                        itemNote: restoredItem?.note === knownItem?.note
                            && restoredItem?.anchor?.quote === knownItem?.anchor?.quote
                            && restoredItem?.understanding === knownItem?.understanding
                            && restoredItem?.marked === knownItem?.marked,
                        document: restoredDoc?.content === knownDoc?.content
                            && restoredDoc?.title === knownDoc?.title
                            && JSON.stringify(restoredDoc?.sourceItemIds) === JSON.stringify(knownDoc?.sourceItemIds)
                            && JSON.stringify(restoredDoc?.sourceMessageIds) === JSON.stringify(knownDoc?.sourceMessageIds),
                        message: restoredMessage?.content === knownMessage?.content
                            && restoredMessage?.role === knownMessage?.role
                            && restoredMessage?.conversationId === knownMessage?.conversationId
                    }
                }
            };
        });
        fs.writeFileSync(asset('full-backup-sample.json'), JSON.stringify(backup.full, null, 2), 'utf8');
        fs.writeFileSync(asset('full-backup-roundtrip.json'), JSON.stringify(backup.roundtrip, null, 2), 'utf8');
        manifest.assets.push('full-backup-sample.json', 'full-backup-roundtrip.json');
        manifest.roundtrip = backup.roundtrip;
        manifest.seeded = cnIds;
        const rt = backup.roundtrip;
        const expectedArticle = {
            id: FIXTURE.articleId,
            title: FIXTURE.title,
            body: FIXTURE.body,
            analysis: FIXTURE.result,
            sourceType: 'paste',
            sourceUrl: ''
        };
        const fixtureArticleMatch = JSON.stringify(rt.articlesBefore) === JSON.stringify([expectedArticle])
            && JSON.stringify(rt.articlesAfter) === JSON.stringify([expectedArticle]);
        manifest.fixtureArticleMatch = fixtureArticleMatch;
        const roundtripOk = !!backup.full?.ok
            && backup.full.payload?.articleDocuments?.length === 1
            && backup.full.payload.articleDocuments[0].id === FIXTURE.articleId
            && rt.restored?.ok === true
            && rt.idsMatch === true
            && rt.backupDataMatches === true
            && rt.articleRestored === true
            && rt.articleBackupMatches === true
            && rt.articlesCleared === 0
            && rt.articleCount === 1
            && fixtureArticleMatch
            && rt.messagesBefore === 70
            && rt.messagesAfter === 70
            && rt.contentMatch.itemNote
            && rt.contentMatch.document
            && rt.contentMatch.message
            && rt.sourceReferences.matches
            && rt.sourceReferences.restoredSourceMessageIds.length === 3;
        if (!roundtripOk) throw new Error('完整備份往返核對失敗：' + JSON.stringify(rt).slice(0, 1500));
        await cn.context.close();

        // 桌面 zh-HK
        const hk = await newPage(browser, 'zh-HK', { width: 1440, height: 960 });
        await seed(hk.page);
        await openArticle(hk.page);
        await hk.page.click('#article-reading-records-btn');
        await hk.page.waitForTimeout(400);
        const hkLayout = await hk.page.evaluate(() => {
            const sheet = document.querySelector('.reading-panel-sheet');
            const panelX = sheet ? Math.round(sheet.getBoundingClientRect().x) : null;
            const sentences = [...document.querySelectorAll('.interactive-sentence')].map((el) => Math.round(el.getBoundingClientRect().right));
            return { panelX, sentenceCount: sentences.length, covered: panelX == null ? 0 : sentences.filter((right) => right > panelX).length };
        });
        manifest.desktopLayoutHk = hkLayout;
        if (!hkLayout.panelX || hkLayout.sentenceCount < 3 || hkLayout.covered) {
            throw new Error('zh-HK 桌面側欄遮住正文：' + JSON.stringify(hkLayout));
        }
        await hk.page.screenshot({ path: asset('desktop-1440-zh-HK-marks-and-panel.png') });
        manifest.assets.push('desktop-1440-zh-HK-marks-and-panel.png');
        const hkMd = await hk.page.evaluate(async (articleId) => {
            const exporter = await import('/modules/reading-export.js');
            const result = await exporter.buildReadingNoteMarkdown({ articleId, includeFullText: true });
            return result.ok ? result.markdown : '';
        }, FIXTURE.articleId);
        if (!hkMd.includes('本文學習記錄') && !hkMd.includes('生詞')) {
            throw new Error('zh-HK Markdown 匯出缺少香港中文文案');
        }
        fs.writeFileSync(asset('reading-notes-zh-HK.md'), hkMd, 'utf8');
        manifest.assets.push('reading-notes-zh-HK.md');
        await hk.context.close();

        // 手機 390×844：兩語言都實際操作 look → to 並保存筆記
        const mobileCn = await runMobileFlow(browser, {
            locale: 'zh-CN',
            viewport: { width: 390, height: 844 },
            prefix: 'mobile-390x844',
            screenshots: {
                picker: 'mobile-390x844-zh-CN-phrase-picker.png',
                saved: 'mobile-390x844-zh-CN-phrase-saved.png',
                panel: 'mobile-390x844-zh-CN-reading-panel.png'
            }
        });
        manifest.assets.push(
            'mobile-390x844-zh-CN-phrase-picker.png',
            'mobile-390x844-zh-CN-phrase-saved.png',
            'mobile-390x844-zh-CN-reading-panel.png'
        );
        manifest.mobile = { zhCN: { ...mobileCn.seeded, layout: mobileCn.layout } };
        const mobileHk = await runMobileFlow(browser, {
            locale: 'zh-HK',
            viewport: { width: 390, height: 844 },
            prefix: 'mobile-390x844',
            screenshots: {
                picker: 'mobile-390x844-zh-HK-phrase-picker.png',
                saved: 'mobile-390x844-zh-HK-phrase-saved.png',
                panel: 'mobile-390x844-zh-HK-reading-panel.png'
            }
        });
        manifest.assets.push(
            'mobile-390x844-zh-HK-phrase-picker.png',
            'mobile-390x844-zh-HK-phrase-saved.png',
            'mobile-390x844-zh-HK-reading-panel.png'
        );
        manifest.mobile.zhHK = { ...mobileHk.seeded, layout: mobileHk.layout };

        // 窄 320：兩語言短語面板（實際點詞、選 to）
        const narrowCn = await runMobileFlow(browser, {
            locale: 'zh-CN',
            viewport: { width: 320, height: 720 },
            prefix: 'mobile-320',
            screenshots: {
                picker: 'mobile-320-zh-CN-phrase-picker.png',
                saved: 'mobile-320-zh-CN-phrase-saved.png',
                panel: 'mobile-320-zh-CN-reading-panel.png'
            }
        });
        manifest.assets.push(
            'mobile-320-zh-CN-phrase-picker.png',
            'mobile-320-zh-CN-phrase-saved.png',
            'mobile-320-zh-CN-reading-panel.png'
        );
        const narrowHk = await runMobileFlow(browser, {
            locale: 'zh-HK',
            viewport: { width: 320, height: 720 },
            prefix: 'mobile-320',
            screenshots: {
                picker: 'mobile-320-zh-HK-phrase-picker.png',
                saved: 'mobile-320-zh-HK-phrase-saved.png',
                panel: 'mobile-320-zh-HK-reading-panel.png'
            }
        });
        manifest.assets.push(
            'mobile-320-zh-HK-phrase-picker.png',
            'mobile-320-zh-HK-phrase-saved.png',
            'mobile-320-zh-HK-reading-panel.png'
        );
        manifest.narrow = {
            zhCN: { ...narrowCn.seeded, layout: narrowCn.layout },
            zhHK: { ...narrowHk.seeded, layout: narrowHk.layout }
        };

        // fixture 與啟動說明
        fs.writeFileSync(asset('fixture.json'), JSON.stringify(FIXTURE, null, 2), 'utf8');
        fs.writeFileSync(asset('PREVIEW.md'), [
            '# 文章閱讀檔案預覽',
            '',
            '此目錄的截圖與匯出檔由 `tests/reading-preview.cjs` 使用獨立瀏覽器 context 與合成資料產生。',
            '不會讀取使用者既有瀏覽器資料、正式帳號或 `ai-config.js` 金鑰；所有外部網路請求会被阻斷。',
            '',
            '重現方式：',
            '',
            '```bash',
            `python3 scripts/serve.py --port ${PORT}`,
            `PORT=${PORT} PLAYWRIGHT_MODULE=<path-to-playwright> ASSET_DIR=${ASSET_DIR} node tests/reading-preview.cjs`,
            '```',
            '',
            'fixture：`fixture.json`。文章為 Meeting Follow-up；已查短語 look forward to、單詞 look、句子，含筆記、詞書關聯、70 條消息與引用真實消息 ID 的 AI 文件。',
            '',
            '注意：這是合成資料的本機 UI，不代表任何正式帳號的雲端內容。'
        ].join('\n'), 'utf8');
        manifest.assets.push('fixture.json', 'PREVIEW.md');
        fs.writeFileSync(asset('manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    } finally {
        await browser.close();
    }
    console.log('ASSET_DIR=' + ASSET_DIR);
    console.log(JSON.stringify(manifest.roundtrip || {}, null, 2));
})();
