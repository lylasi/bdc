/**
 * 文章統一標記與筆記：核心行為回歸。
 *
 * 覆蓋：
 *   1. 查閱只保存解釋，不標記；加入詞書才標記且位置精確
 *   2. 取消標記後重查、重載、舊後端缺欄位同步都不復活
 *   3. 舊三態／詞書關聯遷移只補缺少的 marked，明確 false 優先
 *   4. 重疊標記取消一個後其他仍顯示
 *   5. 兩個分頁並發：一個寫筆記、一個加入詞書，互不覆蓋
 *   6. 從詞書移除保留文章標記與筆記
 *   7. 舊備份／新備份 marked 往返
 *   8. 單詞彈窗與原生選區提供標記／筆記入口
 *
 * 用法：
 *   PORT=8313 PLAYWRIGHT_MODULE=<path-to-playwright> node tests/reading-marks.cjs
 */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const PORT = Number(process.env.PORT || 8313);
const BASE = `http://127.0.0.1:${PORT}/`;
const ENDPOINT = process.env.TEST_SYNC_ENDPOINT || 'http://127.0.0.1:19999/test-endpoint';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const failures = [];
function check(name, condition, detail) {
    if (condition) { console.log(`  ok   ${name}`); return true; }
    failures.push({ name, detail: detail === undefined ? '' : String(detail).slice(0, 800) });
    console.log(`  FAIL ${name}${detail !== undefined ? ' -- ' + String(detail).slice(0, 500) : ''}`);
    return false;
}

const ARTICLE = {
    id: 'art_marks_core',
    title: 'Marks Core',
    body: 'We look forward to meeting you.\n\nBank one is here. Bank two is there.',
    result: {
        chinese_translation: '我們期待與你見面。\n\n銀行一在這裡。銀行二在那裡。',
        word_alignment: [],
        detailed_analysis: [],
        paragraph_analysis: [
            { chinese_translation: '我們期待與你見面。', sentences: [{ en: 'We look forward to meeting you.', zh: '我們期待與你見面。' }] },
            { chinese_translation: '銀行一在這裡。', sentences: [{ en: 'Bank one is here.', zh: '銀行一在這裡。' }, { en: 'Bank two is there.', zh: '銀行二在那裡。' }] }
        ],
        sentence_analysis: [],
        phrase_analysis: []
    }
};

// 完全相同的句子出現兩次：同詞不同位置必須各自管理標記與彈窗狀態。
const DUP_ARTICLE = {
    id: 'art_marks_duplicate',
    title: 'Duplicate Sentences',
    body: 'We look forward to meeting you.\n\nWe look forward to meeting you.',
    result: {
        chinese_translation: '我們期待與你見面。\n\n我們期待與你見面。',
        word_alignment: [],
        detailed_analysis: [
            { word: 'look', sentence: 'We look forward to meeting you.', analysis: { phonetic: 'lʊk', pos: 'v.', meaning: '看；期待', role: '動詞' } }
        ],
        paragraph_analysis: [0, 1].map(() => ({
            chinese_translation: '我們期待與你見面。',
            sentences: [{ en: 'We look forward to meeting you.', zh: '我們期待與你見面。' }]
        })),
        sentence_analysis: [],
        phrase_analysis: []
    }
};

// 延遲回應隔離：只留必要句境；`forward` 先給既有詳解，讓新選詞能立即顯示標題。
const ASYNC_ARTICLE = {
    id: 'art_marks_async',
    title: 'Async Isolation',
    body: 'We look forward to meeting you.',
    result: {
        chinese_translation: '我們期待與你見面。',
        word_alignment: [],
        detailed_analysis: [
            { word: 'forward', sentence: 'We look forward to meeting you.', analysis: { phonetic: '', pos: 'adv.', meaning: '向前', role: '副詞' } }
        ],
        paragraph_analysis: [
            { chinese_translation: '我們期待與你見面。', sentences: [{ en: 'We look forward to meeting you.', zh: '我們期待與你見面。' }] }
        ],
        sentence_analysis: [],
        phrase_analysis: []
    }
};

async function newPage(browser) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    await context.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith('/ai-config.js')) {
            return route.fulfill({ contentType: 'application/javascript', body: 'export const SYNC={endpoint: ""}; export const TTS_CONFIG={}, AI_LIMITS={}, OCR_CONFIG={}, ARTICLE_IMPORT={}, SUPABASE={};' });
        }
        if (url.origin !== `http://127.0.0.1:${PORT}`) return route.abort();
        return route.continue();
    });
    await context.addInitScript(({ endpoint }) => {
        window.__BDC_SYNC_ENDPOINT__ = endpoint;
        try {
            const raw = localStorage.getItem('pen_global_settings');
            const parsed = raw ? JSON.parse(raw) : {};
            parsed.language = { ...(parsed.language || {}), interfaceLocale: 'zh-CN' };
            localStorage.setItem('pen_global_settings', JSON.stringify(parsed));
        } catch (_) {}
    }, { endpoint: ENDPOINT });
    const page = await context.newPage();
    const errors = [];
    page.on('console', (m) => {
        if (m.type() !== 'error') return;
        const text = m.text();
        if (/401|404|501|Not Implemented|ai-credentials|ai-catalog|sync_endpoint_missing|ERR_CONNECTION_REFUSED|ERR_UNSAFE_PORT|尚未选择模型|尚未選擇模型|Error analyzing word|Failed to load resource/i.test(text)) return;
        errors.push(text.slice(0, 260));
    });
    page.on('pageerror', (e) => errors.push('PAGEERROR ' + String(e && e.stack ? e.stack.split('\n')[0] : e)));
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    await page.evaluate(() => {
        const modal = document.getElementById('app-modal');
        if (modal && !modal.classList.contains('hidden')) modal.querySelector('.modal-close-btn')?.click();
    });
    return { context, page, errors };
}

async function seedArticle(page, article = ARTICLE) {
    return page.evaluate(async (article) => {
        const art = await import('/modules/article-store.js');
        const rd = await import('/modules/reading-store.js');
        const actions = await import('/modules/reading-actions.js');
        await art.initArticleStore();
        await rd.initReadingStore();
        const saved = await art.saveArticle({
            articleId: article.id,
            article: article.body,
            title: article.title,
            sourceType: 'paste',
            result: article.result
        });
        if (!saved.ok) throw new Error(saved.error);
        const st = await import('/modules/state.js');
        st.setCurrentArticleId(article.id);
        st.setCurrentWordbookId(article.id);
        window.__marksReview = { art, rd, actions };
        return { scope: rd.getReadingScope(), articleId: article.id };
    }, article);
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
    await page.waitForTimeout(1000);
}

async function lookupAndBook(page, articleId) {
    console.log('\n[查閱不標記；加入詞書才標記並補精確位置]');
    const result = await page.evaluate(async (articleId) => {
        const actions = await import('/modules/reading-actions.js');
        const rd = await import('/modules/reading-store.js');
        const { contentVersionOf } = await import('/shared/reading-protocol.mjs');
        const art = await import('/modules/article-store.js');
        const body = art.getRecord(articleId).article;
        const start = body.indexOf('look');
        const lookup = await actions.recordExplanation({
            articleId,
            kind: 'word',
            quote: 'look',
            sentence: 'We look forward to meeting you.',
            context: 'We look forward to meeting you.',
            data: { word: 'look', analysis: { meaning: '看；期待', phonetic: 'lʊk', pos: 'v.' } },
            markViewed: true,
            anchor: { start, end: start + 4, quote: 'look' }
        });
        const afterLookup = rd.getLearningItem(lookup.entity.id);
        const ensured = await actions.ensureItem({
            articleId,
            kind: 'word',
            quote: 'look',
            sentence: 'We look forward to meeting you.',
            anchor: { start, end: start + 4, quote: 'look' }
        });
        const afterEnsure = rd.getLearningItem(ensured.entity.id);
        const added = await actions.addItemToVocabulary(ensured.entity, { context: 'We look forward to meeting you.' });
        const afterAdd = rd.getLearningItem(ensured.entity.id);
        const link = rd.listVocabularyLinks({ itemId: ensured.entity.id })[0];
        await new Promise((resolve) => setTimeout(resolve, 150));
        const bodyMarkedAfterAdd = document.querySelectorAll('.reading-mark-active').length;
        // 重新查一次（模擬重查）不得重新標記。
        await actions.setMarked(ensured.entity.id, false);
        await actions.recordExplanation({
            articleId,
            kind: 'word',
            quote: 'look',
            sentence: 'We look forward to meeting you.',
            data: { word: 'look', analysis: { meaning: '看；期待' } },
            markViewed: true,
            anchor: { start, end: start + 4, quote: 'look' }
        });
        const afterRelookup = rd.getLearningItem(ensured.entity.id);
        return {
            itemId: ensured.entity.id,
            contentVersion: contentVersionOf(body),
            lookup: { marked: afterLookup?.marked, viewed: !!afterLookup?.firstViewedAt },
            ensure: { marked: afterEnsure?.marked },
            add: { ok: added.ok, marked: afterAdd?.marked, saved: rd.isItemSaved(ensured.entity.id) },
            bodyMarkedAfterAdd,
            linkAnchor: link?.anchor || null,
            linkPositionUnknown: link?.positionUnknown,
            itemAnchor: afterAdd?.anchor,
            relookupMarked: afterRelookup?.marked,
            entrySources: rd.listVocabularyEntries().find((entry) => entry.id === added.id)?.sources || []
        };
    }, articleId);
    check('查閱保存解釋與查閱時間但不標記', result.lookup.marked === false && result.lookup.viewed === true, JSON.stringify(result));
    check('再次確保條目（重查前）仍不標記', result.ensure.marked === false, JSON.stringify(result.ensure));
    check('加入詞書後標記為 true 並建立關聯', result.add.ok && result.add.marked === true && result.add.saved === true, JSON.stringify(result.add));
    return result;
}

async function overlayAndUnmark(browser, articleId) {
    console.log('\n[重疊標記與取消其中一個]');
    const ids = await pageEval(browser, async (articleId) => {
        const rd = await import('/modules/reading-store.js');
        const { contentVersionOf } = await import('/shared/reading-protocol.mjs');
        const art = await import('/modules/article-store.js');
        const body = art.getRecord(articleId).article;
        const version = contentVersionOf(body);
        const forwardStart = body.indexOf('forward');
        const toStart = body.indexOf('to', forwardStart);
        const a = await rd.upsertLearningItem({
            articleId,
            contentVersion: version,
            kind: 'phrase',
            anchor: { start: body.indexOf('look forward'), end: body.indexOf('look forward') + 'look forward'.length, quote: 'look forward' },
            sentence: 'We look forward to meeting you.',
            marked: true
        }, { markViewed: true });
        const b = await rd.upsertLearningItem({
            articleId,
            contentVersion: version,
            kind: 'phrase',
            anchor: { start: forwardStart, end: toStart + 2, quote: 'forward to' },
            sentence: 'We look forward to meeting you.',
            marked: true
        }, { markViewed: true });
        return { a: a.entity.id, b: b.entity.id };
    }, articleId);
    return ids;
}

async function modify(browser, fn, arg) {
    return pageEval(browser, fn, arg);
}

let sharedPage = null;
async function pageEval(browser, fn, arg) {
    if (!sharedPage) throw new Error('shared page missing');
    return sharedPage.evaluate(fn, arg);
}

(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: CHROME });
    try {
        const { context, page, errors } = await newPage(browser);
        sharedPage = page;
        await seedArticle(page);
        await openArticle(page);
        check('正文初始沒有標記線', await page.locator('.reading-mark-active').count() === 0);

        const book = await lookupAndBook(page, ARTICLE.id);
        check('加入詞書補齊精確位置並保留 anchor', book.itemAnchor?.start >= 0
            && book.linkPositionUnknown === false, JSON.stringify({ itemAnchor: book.itemAnchor, linkPositionUnknown: book.linkPositionUnknown }));
        check('加入詞書後正文出現標記線', book.bodyMarkedAfterAdd > 0, String(book.bodyMarkedAfterAdd));
        check('取消標記後重查不復活', book.relookupMarked === false, String(book.relookupMarked));

        // 整頁重新載入後仍維持取消；舊資料遷移不得把明確 false 重新打開。
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1300);
        await openArticle(page, ARTICLE.id);
        const afterReload = await page.evaluate(async ({ itemId, articleId }) => {
            const rd = await import('/modules/reading-store.js');
            await rd.ensureArticleReadingLoaded(articleId);
            return rd.getLearningItem(itemId)?.marked;
        }, { itemId: book.itemId, articleId: ARTICLE.id });
        check('刷新後取消標記仍保持取消', afterReload === false, String(afterReload));

        const ids = await overlayAndUnmark(browser, ARTICLE.id);
        await page.waitForTimeout(200);
        const overlayInitial = await page.evaluate(() => Array.from(document.querySelectorAll('.interactive-word.reading-mark-active')).map((el) => el.textContent.toLowerCase()));
        check('重疊標記會覆蓋聯集', overlayInitial.includes('look') && overlayInitial.includes('forward') && overlayInitial.includes('to'), JSON.stringify(overlayInitial));
        await page.evaluate(async (id) => {
            const actions = await import('/modules/reading-actions.js');
            await actions.setMarked(id, false);
        }, ids.a);
        await page.waitForTimeout(250);
        const afterOverlayRemove = await page.evaluate(() => Array.from(document.querySelectorAll('.interactive-word.reading-mark-active')).map((el) => el.textContent.toLowerCase()));
        check('取消一個重疊標記後另一個仍顯示', !afterOverlayRemove.includes('look') && afterOverlayRemove.includes('forward') && afterOverlayRemove.includes('to'), JSON.stringify(afterOverlayRemove));

        console.log('\n[兩個分頁並發：筆記 vs 加入詞書]');
        const tabB = await context.newPage();
        await tabB.goto(BASE, { waitUntil: 'domcontentloaded' });
        await tabB.waitForTimeout(1200);
        await tabB.evaluate(async () => {
            const art = await import('/modules/article-store.js');
            const rd = await import('/modules/reading-store.js');
            await art.initArticleStore();
            await rd.initReadingStore();
        });
        const concurrent = await Promise.all([
            page.evaluate(async ({ articleId, itemId }) => {
                const rd = await import('/modules/reading-store.js');
                await new Promise((resolve) => setTimeout(resolve, 30));
                return rd.patchLearningItem(itemId, { note: 'note from tab A' });
            }, { articleId: ARTICLE.id, itemId: ids.b }),
            tabB.evaluate(async ({ articleId }) => {
                const rd = await import('/modules/reading-store.js');
                const { contentVersionOf } = await import('/shared/reading-protocol.mjs');
                const art = await import('/modules/article-store.js');
                await art.ensureArticleLoaded(articleId);
                const body = art.getRecord(articleId).article;
                const start = body.indexOf('forward');
                const anchor = { start, end: start + 'forward to'.length, quote: 'forward to', prefix: 'look ', suffix: ' meeting' };
                const itemId = rd.stableLearningItemId({
                    articleId,
                    contentVersion: contentVersionOf(body),
                    kind: 'phrase',
                    anchor,
                    sentence: 'We look forward to meeting you.'
                });
                const addResult = await rd.addVocabularyEntryWithLink({
                    book: { id: 'book_cross_tab', name: 'Cross Tab', sourceType: 'article' },
                    entry: {
                        id: 'entry_cross_tab', bookId: 'book_cross_tab', word: 'forward to',
                        meaning: '期待', examples: [], sources: [], addedAt: new Date().toISOString()
                    },
                    item: {
                        id: itemId,
                        articleId,
                        contentVersion: contentVersionOf(body),
                        kind: 'phrase',
                        anchor,
                        sentence: 'We look forward to meeting you.'
                    },
                    link: {
                        id: 'vl_cross_tab_link',
                        itemId, bookId: 'book_cross_tab', entryId: 'entry_cross_tab',
                        addedAt: new Date().toISOString()
                    }
                });
                return { addResult, itemId, anchor, bodyLength: body.length, contentVersion: contentVersionOf(body) };
            }, { articleId: ARTICLE.id })
        ]);
        const crossTab = await page.evaluate(async (itemId) => {
            const rd = await import('/modules/reading-store.js');
            const item = rd.getLearningItem(itemId);
            return { note: item?.note, marked: item?.marked, add: null };
        }, ids.b);
        check('並發寫筆記與加入詞書不互相覆蓋', crossTab.note === 'note from tab A' && crossTab.marked === true, JSON.stringify(crossTab));
        check('並發加入詞書本身成功', concurrent[1]?.addResult?.ok === true, JSON.stringify(concurrent[1]));
        await tabB.close();

        console.log('\n[從詞書移除保留文章標記與筆記]');
        const removed = await page.evaluate(async ({ itemId, entryId, articleId }) => {
            const rd = await import('/modules/reading-store.js');
            await rd.reloadReadingScope();
            await rd.ensureArticleReadingLoaded(articleId);
            const before = rd.getLearningItem(itemId);
            const beforeSnapshot = {
                marked: before?.marked,
                note: before?.note,
                saved: rd.isItemSaved(itemId),
                links: rd.listVocabularyLinks().map((link) => ({ itemId: link.itemId, entryId: link.entryId, removedAt: link.removedAt })),
                entries: rd.listVocabularyEntries().map((entry) => entry.id)
            };
            const result = await rd.removeVocabularyEntry(entryId);
            const after = rd.getLearningItem(itemId);
            return {
                result,
                before: beforeSnapshot,
                after: { marked: after?.marked, note: after?.note, saved: rd.isItemSaved(itemId) }
            };
        }, { itemId: ids.b, entryId: 'entry_cross_tab', articleId: ARTICLE.id });
        removed.expectedItemId = ids.b;
        check('從詞書移除後文章標記、筆記與來源關聯仍在', removed.result.ok
            && removed.before.saved === true
            && removed.after.marked === true && removed.after.note === 'note from tab A'
            && removed.after.saved === false, JSON.stringify(removed));

        console.log('\n[舊資料遷移：只補缺少的 marked，明確 false 優先]');
        const migration = await page.evaluate(async (articleId) => {
            const rd = await import('/modules/reading-store.js');
            const art = await import('/modules/article-store.js');
            const { contentVersionOf } = await import('/shared/reading-protocol.mjs');
            const scope = rd.getReadingScope();
            const body = art.getRecord(articleId).article;
            const version = contentVersionOf(body);
            const sentence = 'We look forward to meeting you.';
            const mk = (id, extra) => ({
                id,
                key: `${scope}\u0000${id}`,
                scope,
                articleId,
                contentVersion: version,
                kind: 'word',
                anchor: { start: 3, end: 7, quote: 'look', prefix: 'We ', suffix: ' forward' },
                sentence,
                note: '',
                firstViewedAt: null,
                lastViewedAt: null,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                deletedAt: '',
                revision: 0,
                ...extra
            });
            const records = [
                mk('old_needs_review', { understanding: 'needs_review' }),
                mk('old_understood', { understanding: 'understood' }),
                mk('old_lookup_only', { understanding: 'unmarked' }),
                mk('explicit_false', { understanding: 'needs_review', marked: false }),
                mk('old_with_link', { understanding: 'unmarked' })
            ];
            const db = await new Promise((resolve, reject) => {
                const request = indexedDB.open('bdc-articles');
                request.onerror = () => reject(request.error);
                request.onsuccess = () => resolve(request.result);
            });
            await new Promise((resolve, reject) => {
                const tx = db.transaction(['reading_items', 'vocab_links', 'vocab_books', 'vocab_entries', 'reading_outbox'], 'readwrite');
                const items = tx.objectStore('reading_items');
                records.forEach((record) => items.put(record));
                tx.objectStore('vocab_links').put({
                    id: 'legacy_link', key: `${scope}\u0000legacy_link`, scope,
                    itemId: 'old_with_link', bookId: 'legacy_book', entryId: 'legacy_entry',
                    addedAt: new Date().toISOString(), removedAt: '', deletedAt: '', revision: 0
                });
                tx.oncomplete = () => { db.close(); resolve(); };
                tx.onerror = () => { db.close(); reject(tx.error); };
            });
            await rd.reloadReadingScope();
            await rd.ensureArticleReadingLoaded(articleId);
            const read = (id) => {
                const item = rd.getLearningItem(id);
                return item ? { marked: item.marked, hasMarked: typeof item.marked === 'boolean' } : null;
            };
            return {
                needs: read('old_needs_review'),
                understood: read('old_understood'),
                lookup: read('old_lookup_only'),
                explicit: read('explicit_false'),
                link: read('old_with_link')
            };
        }, ARTICLE.id);
        check('舊 needs_review／understood 遷移為已標記', migration.needs?.marked === true && migration.understood?.marked === true, JSON.stringify(migration));
        check('僅查閱遷移為未標記', migration.lookup?.marked === false, JSON.stringify(migration.lookup));
        check('舊記錄的明確 false 優先，不被理解狀態覆寫', migration.explicit?.marked === false && migration.explicit?.hasMarked === true, JSON.stringify(migration.explicit));
        check('缺少 marked 但有有效詞書關聯時遷移為已標記', migration.link?.marked === true, JSON.stringify(migration.link));

        const missingRemote = await page.evaluate(async (itemId) => {
            const rd = await import('/modules/reading-store.js');
            const item = rd.getLearningItem(itemId);
            const outbox = (await rd.listOutbox()).find((op) => op.entityType === 'learningItem' && op.entityId === itemId);
            if (outbox) {
                await rd.markOutboxAcknowledged('learningItem', itemId, { mutationId: outbox.mutationId, revision: Number(item.revision) || 0 });
            }
            const afterAck = rd.getLearningItem(itemId);
            const remote = { ...afterAck, revision: (Number(afterAck.revision) || 0) + 1, updatedAt: new Date().toISOString() };
            delete remote.marked;
            await rd.applyRemoteEntity('learningItem', remote);
            return rd.getLearningItem(itemId);
        }, 'explicit_false');
        check('舊後端缺 marked 的回應不會把明確取消復活', missingRemote?.marked === false, JSON.stringify(missingRemote));

        console.log('\n[舊備份與新備份 marked 往返]');
        const backup = await page.evaluate(async () => {
            const rd = await import('/modules/reading-store.js');
            const payload = {
                vocabularyBooks: [],
                vocabularyEntries: [],
                vocabularyLinks: [{
                    id: 'backup_link', itemId: 'backup_old_item', bookId: 'b', entryId: 'e',
                    addedAt: new Date().toISOString(), removedAt: '', deletedAt: ''
                }],
                learningItems: [
                    {
                        id: 'backup_old_item', articleId: 'art_marks_core', kind: 'word', contentVersion: 'cv1',
                        anchor: { start: 3, end: 7, quote: 'look', prefix: 'We ', suffix: ' forward' }, sentence: 'We look forward to meeting you.',
                        note: 'old backup note', understanding: 'understood', revision: 0
                    },
                    {
                        id: 'backup_explicit_false', articleId: 'art_marks_core', kind: 'word', contentVersion: 'cv1',
                        anchor: { start: 8, end: 15, quote: 'forward', prefix: 'look ', suffix: ' to' }, sentence: 'We look forward to meeting you.',
                        note: 'explicit false', understanding: 'needs_review', marked: false, revision: 0
                    }
                ],
                articleDocuments: [], conversations: [], messages: [], articleVersions: []
            };
            const restored = await rd.restoreAll(payload);
            const oldItem = rd.getLearningItem('backup_old_item');
            const explicitItem = rd.getLearningItem('backup_explicit_false');
            const snapshot = await rd.exportAll();
            const before = snapshot.learningItems
                .filter((item) => ['backup_old_item', 'backup_explicit_false'].includes(item.id))
                .map((item) => ({ id: item.id, marked: item.marked }))
                .sort((a, b) => a.id.localeCompare(b.id));
            await rd.clearScopeForTests();
            const roundtrip = await rd.restoreAll(snapshot);
            const after = (await rd.exportAll()).learningItems
                .filter((item) => ['backup_old_item', 'backup_explicit_false'].includes(item.id))
                .map((item) => ({ id: item.id, marked: item.marked }))
                .sort((a, b) => a.id.localeCompare(b.id));
            return {
                restored,
                oldMarked: oldItem?.marked,
                explicitMarked: explicitItem?.marked,
                before,
                roundtrip,
                after
            };
        });
        check('舊備份按舊狀態／關聯補 marked', backup.restored.ok && backup.oldMarked === true && backup.explicitMarked === false, JSON.stringify(backup));
        check('新備份 marked 往返一致', backup.roundtrip.ok && JSON.stringify(backup.before) === JSON.stringify(backup.after), JSON.stringify({ before: backup.before, after: backup.after }));

        console.log('\n[單詞彈窗與原生選區的標記／筆記入口]');
        await openArticle(page);
        const secondBank = page.locator('.interactive-word[data-word="Bank"]').nth(1);
        await secondBank.click();
        await page.waitForTimeout(300);
        check('單詞彈窗提供標記與寫筆記', await page.locator('#word-analysis-tooltip .btn-toggle-mark').count() === 1
            && await page.locator('#word-analysis-tooltip .btn-note-item').count() === 1);
        await page.locator('#word-analysis-tooltip .btn-toggle-mark').click();
        await page.waitForTimeout(400);
        const bankItem = await page.evaluate(async () => {
            const rd = await import('/modules/reading-store.js');
            const art = await import('/modules/article-store.js');
            const body = art.getRecord('art_marks_core')?.article || '';
            const start = body.lastIndexOf('Bank');
            const item = rd.listLearningItems('art_marks_core').find((entry) => entry.anchor?.quote === 'Bank' && entry.anchor?.start === start);
            return item ? { id: item.id, marked: item.marked, start: item.anchor.start, note: item.note } : null;
        });
        check('彈窗標記套用到第二個 Bank 的精確位置', bankItem?.marked === true && bankItem.start === ARTICLE.body.lastIndexOf('Bank'), JSON.stringify(bankItem));
        await page.locator('#word-analysis-tooltip .btn-note-item').click();
        await page.waitForTimeout(500);
        const focused = await page.evaluate(() => ({
            panel: !document.getElementById('article-reading-panel')?.classList.contains('hidden'),
            noteId: document.activeElement?.getAttribute?.('data-note-id') || ''
        }));
        check('彈窗寫筆記會打開面板並聚焦對應筆記框', focused.panel && focused.noteId === bankItem?.id, JSON.stringify(focused));
        await page.fill(`[data-note-id="${bankItem.id}"]`, 'Bank 第二處的筆記');
        await page.waitForTimeout(800);
        const noteWhileMarked = await page.evaluate(async (id) => {
            const item = (await import('/modules/reading-store.js')).getLearningItem(id);
            return { marked: item?.marked, note: item?.note };
        }, bankItem.id);
        check('寫筆記不改標記且保存成功', noteWhileMarked.marked === true && noteWhileMarked.note === 'Bank 第二處的筆記', JSON.stringify(noteWhileMarked));
        await page.click('.reading-panel-close');
        await page.waitForTimeout(300);

        // 取消標記後，筆記仍可在「有筆記」篩選找到。
        await page.evaluate(async (id) => {
            const actions = await import('/modules/reading-actions.js');
            await actions.setMarked(id, false);
        }, bankItem.id);
        await page.click('#article-reading-records-btn');
        await page.waitForTimeout(350);
        await page.click('[data-filter="notes"]');
        await page.waitForTimeout(250);
        const unmarkedNote = await page.evaluate((id) => {
            const card = document.querySelector(`.reading-item[data-item-id="${id}"]`);
            return {
                visible: !!card,
                note: card?.querySelector('.reading-note')?.value || '',
                pressed: card?.querySelector('[data-mark-toggle]')?.getAttribute('aria-pressed') || ''
            };
        }, bankItem.id);
        check('取消標記後筆記仍可從筆記篩選找到', unmarkedNote.visible
            && unmarkedNote.note === 'Bank 第二處的筆記' && unmarkedNote.pressed === 'false', JSON.stringify(unmarkedNote));
        await page.click('.reading-panel-close');
        await page.waitForTimeout(250);

        // 原生選區：選取第二段的 Bank 後按工具列標記。
        const selectionReady = await page.evaluate(() => {
            const words = Array.from(document.querySelectorAll('.interactive-word[data-word="Bank"]'));
            const target = words[0];
            if (!target || !target.firstChild) return false;
            const range = document.createRange();
            range.setStart(target.firstChild, 0);
            range.setEnd(target.firstChild, 4);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            document.dispatchEvent(new Event('selectionchange'));
            return true;
        });
        await page.waitForTimeout(300);
        check('原生選區工具列出現', selectionReady && await page.locator('.article-selection-bar.is-visible').count() === 1);
        await page.locator('.article-selection-bar [data-act="mark"]').click();
        await page.waitForTimeout(500);
        const selectionMark = await page.evaluate(async () => {
            const rd = await import('/modules/reading-store.js');
            const items = rd.listLearningItems('art_marks_core').filter((item) => item.anchor?.quote === 'Bank' && item.anchor?.start > 32);
            return items.map((item) => ({ id: item.id, marked: item.marked }));
        });
        check('原生選區可標記已捕捉範圍', selectionMark.length >= 2 && selectionMark[0].marked === true, JSON.stringify(selectionMark));
        const selectionNoteButton = await page.locator('.article-selection-bar [data-act="note"]').count();
        check('原生選區工具列提供寫筆記', selectionNoteButton === 1, String(selectionNoteButton));

        // 查詞彈窗加入詞書：使用點擊當下的精確 anchor，不落到第一個同字。
        await page.evaluate(() => window.getSelection()?.removeAllRanges());
        await page.waitForTimeout(150);
        await page.locator('.interactive-word[data-word="here"]').first().click();
        await page.waitForTimeout(300);
        await page.locator('#word-analysis-tooltip .btn-add-to-book').click();
        await page.waitForTimeout(700);
        const tooltipAdd = await page.evaluate(async () => {
            const rd = await import('/modules/reading-store.js');
            const art = await import('/modules/article-store.js');
            const body = art.getRecord('art_marks_core')?.article || '';
            const item = rd.listLearningItems('art_marks_core').find((entry) => entry.anchor?.quote === 'here');
            const link = item ? rd.listVocabularyLinks({ itemId: item.id })[0] : null;
            return {
                bodyStart: body.indexOf('here'),
                item: item ? { id: item.id, start: item.anchor?.start, marked: item.marked, saved: rd.isItemSaved(item.id) } : null,
                link: link ? { positionUnknown: link.positionUnknown, entryId: link.entryId } : null
            };
        });
        check('查詞彈窗加入詞書使用精確位置並標記', tooltipAdd.item?.start === tooltipAdd.bodyStart
            && tooltipAdd.item?.marked === true && tooltipAdd.item?.saved === true
            && tooltipAdd.link?.positionUnknown === false, JSON.stringify(tooltipAdd));

        // 詞書已有同詞時，第二次收藏仍建立本次 occurrence 的關聯並標記。
        const repeatBook = await page.evaluate(async () => {
            const vocab = await import('/modules/vocab.js');
            const rd = await import('/modules/reading-store.js');
            const actions = await import('/modules/reading-actions.js');
            const art = await import('/modules/article-store.js');
            const body = art.getRecord('art_marks_core').article;
            const version = actions.articleVersion('art_marks_core');
            const firstStart = body.indexOf('Bank');
            const secondStart = body.lastIndexOf('Bank');
            const first = await vocab.addWordToCurrentArticleBook('Bank', {
                articleId: 'art_marks_core', contentVersion: version, kind: 'word',
                sentence: 'Bank one is here.',
                anchor: { start: firstStart, end: firstStart + 4, quote: 'Bank' }
            });
            const second = await vocab.addWordToCurrentArticleBook('Bank', {
                articleId: 'art_marks_core', contentVersion: version, kind: 'word',
                sentence: 'Bank two is there.',
                anchor: { start: secondStart, end: secondStart + 4, quote: 'Bank' }
            });
            const items = rd.listLearningItems('art_marks_core').filter((item) => item.anchor?.quote === 'Bank');
            const links = rd.listVocabularyLinks().filter((link) => items.some((item) => item.id === link.itemId));
            const entry = rd.listVocabularyEntries().find((item) => item.word === 'Bank');
            return {
                first, second,
                items: items.map((item) => ({ start: item.anchor?.start, marked: item.marked })),
                links: links.map((link) => ({ itemId: link.itemId })),
                sourceCount: entry?.sources?.length || 0,
                starts: [firstStart, secondStart]
            };
        });
        check('詞書已有同詞時仍按精確 occurrence 收藏並標記', repeatBook.first.ok
            && repeatBook.second.reason === 'duplicate'
            && repeatBook.items.length === 2
            && repeatBook.items.every((item) => item.marked === true)
            && repeatBook.items.map((item) => item.start).sort((a, b) => a - b).join(',') === repeatBook.starts.join(',')
            && repeatBook.links.length === 2 && repeatBook.sourceCount === 2, JSON.stringify(repeatBook));

        // ── 相同詞句：彈窗與原生選區只能認自己那一個 occurrence ──
        console.log('\n[相同詞句重複：彈窗與原生選區的精確狀態]');
        await seedArticle(page, DUP_ARTICLE);
        await openArticle(page, DUP_ARTICLE.id);
        const dupWords = page.locator('.interactive-word[data-word="look"]');
        check('重複句子產生兩個 look', await dupWords.count() === 2, String(await dupWords.count()));
        await dupWords.nth(1).click();
        await page.waitForTimeout(350);
        await page.locator('#word-analysis-tooltip .btn-toggle-mark').click();
        await page.waitForTimeout(450);
        const dupMarked = await page.evaluate((articleId) => {
            return window.__marksReview.rd.listLearningItems(articleId)
                .filter((item) => item.anchor?.quote === 'look' && Number(item.anchor?.start) >= 0)
                .map((item) => ({ start: item.anchor?.start, marked: item.marked }));
        }, DUP_ARTICLE.id);
        check('只標記第二次出現的位置', dupMarked.length === 1
            && dupMarked[0].marked === true
            && dupMarked[0].start === DUP_ARTICLE.body.lastIndexOf('look'), JSON.stringify(dupMarked));

        await page.mouse.click(8, 900);
        await dupWords.nth(0).click();
        await page.waitForTimeout(350);
        const firstPopup = await page.evaluate(() => {
            const button = document.querySelector('#word-analysis-tooltip .btn-toggle-mark');
            return { pressed: button?.getAttribute('aria-pressed'), text: button?.textContent || '', start: button?.getAttribute('data-anchor-start') };
        });
        check('第一處重開彈窗顯示未標記', firstPopup.pressed === 'false' && Number(firstPopup.start) === DUP_ARTICLE.body.indexOf('look'), JSON.stringify(firstPopup));

        await page.mouse.click(8, 900);
        await dupWords.nth(1).click();
        await page.waitForTimeout(350);
        const secondPopup = await page.evaluate(() => {
            const button = document.querySelector('#word-analysis-tooltip .btn-toggle-mark');
            return { pressed: button?.getAttribute('aria-pressed'), text: button?.textContent || '', start: button?.getAttribute('data-anchor-start') };
        });
        check('第二處重開彈窗顯示取消標記', secondPopup.pressed === 'true' && Number(secondPopup.start) === DUP_ARTICLE.body.lastIndexOf('look'), JSON.stringify(secondPopup));

        const selectOccurrence = (word, index) => page.evaluate(({ word, index }) => {
            const target = document.querySelectorAll(`.interactive-word[data-word="${word}"]`)[index];
            if (!target || !target.firstChild) return false;
            const range = document.createRange();
            range.setStart(target.firstChild, 0);
            range.setEnd(target.firstChild, word.length);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            document.dispatchEvent(new Event('selectionchange'));
            return true;
        }, { word, index });
        const barState = () => page.evaluate(() => {
            const button = document.querySelector('.article-selection-bar [data-act="mark"]');
            return { pressed: button?.getAttribute('aria-pressed'), text: button?.textContent || '', visible: !!document.querySelector('.article-selection-bar.is-visible') };
        });

        await page.mouse.click(8, 900);
        await selectOccurrence('look', 0);
        await page.waitForTimeout(350);
        const barFirst = await barState();
        check('原生選區第一處顯示未標記', barFirst.visible && barFirst.pressed === 'false', JSON.stringify(barFirst));
        await page.mouse.click(8, 900);
        await selectOccurrence('look', 1);
        await page.waitForTimeout(350);
        const barSecond = await barState();
        check('原生選區第二處顯示已標記', barSecond.visible && barSecond.pressed === 'true', JSON.stringify(barSecond));
        await page.locator('.article-selection-bar [data-act="mark"]').click();
        await page.waitForTimeout(450);
        const afterBarUnmark = await page.evaluate((articleId) => {
            return window.__marksReview.rd.listLearningItems(articleId)
                .filter((item) => item.anchor?.quote === 'look' && Number(item.anchor?.start) >= 0)
                .map((item) => ({ start: item.anchor?.start, marked: item.marked }));
        }, DUP_ARTICLE.id);
        check('原生選區切換只改第二處且保留第一處未標記', afterBarUnmark.length === 2
            && afterBarUnmark.every((item) => item.marked === false)
            && afterBarUnmark.map((item) => item.start).sort((a, b) => a - b).join(',') === [DUP_ARTICLE.body.indexOf('look'), DUP_ARTICLE.body.lastIndexOf('look')].join(','), JSON.stringify(afterBarUnmark));

        // 短語選擇器同樣要用打開時的內文與版本，不能落到第一處。
        const secondSentenceStart = DUP_ARTICLE.body.indexOf('We look forward to meeting you.', 1);
        await page.evaluate(async ({ articleId, sentence, sentenceStart }) => {
            const picker = await import('/features/article/phrase-picker.js');
            window.__marksPhrasePicker = picker;
            picker.openPhrasePicker({
                articleId,
                sentence,
                context: sentence,
                initialQuote: 'look',
                sentenceStart,
                startOffset: 3
            });
        }, { articleId: DUP_ARTICLE.id, sentence: 'We look forward to meeting you.', sentenceStart: secondSentenceStart });
        await page.waitForTimeout(350);
        const pickerBefore = await page.evaluate(() => {
            const button = document.querySelector('#phrase-picker-mark');
            return { hidden: document.getElementById('phrase-picker')?.classList.contains('hidden'), pressed: button?.getAttribute('aria-pressed') };
        });
        check('短語選擇器第二處開啟顯示未標記', pickerBefore.hidden === false && pickerBefore.pressed === 'false', JSON.stringify(pickerBefore));
        await page.click('#phrase-picker-mark');
        await page.waitForTimeout(450);
        const pickerMarked = await page.evaluate((articleId) => {
            return window.__marksReview.rd.listLearningItems(articleId)
                .filter((item) => item.anchor?.quote === 'look' && Number(item.anchor?.start) >= 0)
                .map((item) => ({ start: item.anchor?.start, marked: item.marked }))
                .sort((a, b) => a.start - b.start);
        }, DUP_ARTICLE.id);
        check('短語選擇器只標記第二處', pickerMarked.length === 2
            && pickerMarked[0].marked === false && pickerMarked[1].marked === true
            && pickerMarked[1].start === DUP_ARTICLE.body.lastIndexOf('look'), JSON.stringify(pickerMarked));
        await page.evaluate(async () => { await window.__marksPhrasePicker.closePhrasePicker(); });
        await page.waitForTimeout(250);

        // ── 舊資料遷移失敗：必須回報，下一次載入真的重試 ──
        console.log('\n[舊資料遷移失敗可回報並重試]');
        const migrationRetry = await page.evaluate(async (articleId) => {
            const { art, rd, actions } = window.__marksReview;
            const permanent = await import('/modules/permanent-db.js');
            const body = art.getRecord(articleId).article;
            const version = actions.articleVersion(articleId);
            const scope = rd.getReadingScope();
            const start = body.indexOf('meeting');
            const legacyId = 'legacy_migration_retry';
            const legacy = {
                id: legacyId,
                key: `${scope}\u0000${legacyId}`,
                scope,
                articleId,
                contentVersion: version,
                kind: 'word',
                anchor: { start, end: start + 'meeting'.length, quote: 'meeting', prefix: 'to ', suffix: ' you' },
                sentence: 'We look forward to meeting you.',
                note: '',
                understanding: 'understood',
                firstViewedAt: null,
                lastViewedAt: null,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                deletedAt: '',
                revision: 0
            };
            await permanent.applyPermanentOperations([{ store: permanent.STORE.READING_ITEMS, type: 'put', value: legacy }]);
            await rd.initReadingStore();
            const originalPut = IDBObjectStore.prototype.put;
            IDBObjectStore.prototype.put = function (value, ...rest) {
                if (this.name === permanent.STORE.READING_ITEMS && value && value.id === legacyId && typeof value.marked === 'boolean') {
                    throw new DOMException('Injected migration failure', 'QuotaExceededError');
                }
                return originalPut.call(this, value, ...rest);
            };
            let failed;
            try {
                failed = await rd.ensureArticleReadingLoaded(articleId);
            } finally {
                IDBObjectStore.prototype.put = originalPut;
            }
            const retried = await rd.ensureArticleReadingLoaded(articleId);
            const item = rd.getLearningItem(legacyId);
            return { failed, retried, marked: item?.marked };
        }, ARTICLE.id);
        check('遷移失敗回報 ok:false 且下一次載入重試成功', migrationRetry.failed?.ok === false
            && migrationRetry.retried?.ok === true
            && migrationRetry.marked === true, JSON.stringify(migrationRetry.failed) + ' / ' + JSON.stringify(migrationRetry.retried) + ' marked=' + migrationRetry.marked);

        // ── 非同步隔離：延遲回應不得覆寫新選詞／新版本／新帳戶 ──
        console.log('\n[延遲回應：選詞、版本與帳戶隔離]');
        const asyncContext = await browser.newContext({ viewport: { width: 1440, height: 960 } });
        await asyncContext.route('**/*', async (route) => {
            const url = new URL(route.request().url());
            if (url.pathname.endsWith('/ai-config.js')) {
                return route.fulfill({ contentType: 'application/javascript', body: 'export const SYNC={endpoint: ""}; export const TTS_CONFIG={}, AI_LIMITS={}, OCR_CONFIG={}, ARTICLE_IMPORT={}, SUPABASE={};' });
            }
            if (url.pathname === '/modules/api.js') {
                const response = await route.fetch();
                const body = (await response.text()).replace('export async function analyzeWordInSentence(', 'export async function originalAnalyzeWordInSentence(');
                return route.fulfill({ response, body: body + '\nexport function analyzeWordInSentence(word) { window.__pendingReplies ||= {}; return new Promise((resolve, reject) => { window.__pendingReplies[word] = { resolve, reject }; }); }' });
            }
            if (url.origin !== `http://127.0.0.1:${PORT}`) return route.abort();
            return route.continue();
        });
        const asyncPage = await asyncContext.newPage();
        const asyncErrors = [];
        asyncPage.on('pageerror', (error) => asyncErrors.push(String(error)));
        await asyncPage.goto(BASE, { waitUntil: 'domcontentloaded' });
        await asyncPage.waitForTimeout(1200);
        await asyncPage.evaluate(() => {
            const modal = document.getElementById('app-modal');
            if (modal && !modal.classList.contains('hidden')) modal.querySelector('.modal-close-btn')?.click();
        });
        await seedArticle(asyncPage, ASYNC_ARTICLE);
        await openArticle(asyncPage, ASYNC_ARTICLE.id);

        await asyncPage.locator('.interactive-word[data-word="look"]').first().click();
        await asyncPage.waitForFunction(() => !!window.__pendingReplies?.look);
        await asyncPage.mouse.click(8, 900);
        await asyncPage.locator('.interactive-word[data-word="forward"]').first().click();
        await asyncPage.waitForTimeout(250);
        await asyncPage.evaluate(() => window.__pendingReplies.look.resolve({ word: 'look', analysis: { meaning: '看', pos: 'v.', role: '動詞', phonetic: '' } }));
        await asyncPage.waitForTimeout(450);
        const lateTitle = await asyncPage.locator('#word-analysis-tooltip .tooltip-title').textContent();
        check('延遲詞典回應不覆寫較新的選詞', String(lateTitle).includes('forward'), String(lateTitle));

        await asyncPage.mouse.click(8, 900);
        await asyncPage.locator('.interactive-word[data-word="look"]').first().click();
        await asyncPage.waitForTimeout(350);
        const cacheHit = await asyncPage.evaluate(() => {
            const button = document.querySelector('#word-analysis-tooltip .btn-toggle-mark');
            return {
                sentence: button?.getAttribute('data-sentence') || '',
                context: button?.getAttribute('data-context') || '',
                anchorStart: Number(button?.getAttribute('data-anchor-start'))
            };
        });
        check('快取命中的彈窗仍帶完整句子、上下文與精確錨點', cacheHit.sentence.length > 0
            && cacheHit.context.length > 0 && cacheHit.anchorStart >= 0, JSON.stringify(cacheHit));

        await asyncPage.evaluate(() => window.getSelection()?.removeAllRanges());
        await asyncPage.mouse.click(8, 900);
        await asyncPage.locator('.interactive-word[data-word="meeting"]').first().click();
        await asyncPage.waitForFunction(() => !!window.__pendingReplies?.meeting);
        const versionProbe = await asyncPage.evaluate(async () => {
            const { art, actions } = window.__marksReview;
            const before = actions.articleVersion('art_marks_core');
            await art.saveArticle({ articleId: 'art_marks_core', article: 'A changed version. ' + (art.getRecord('art_marks_core')?.article || ''), title: 'Marks Core' });
            const after = actions.articleVersion('art_marks_core');
            window.__pendingReplies.meeting.resolve({ word: 'meeting', analysis: { meaning: '見面', pos: 'v.', role: '動名詞', phonetic: '' } });
            return { before, after };
        });
        await asyncPage.waitForTimeout(450);
        const meetingItems = await asyncPage.evaluate(() => window.__marksReview.rd.listLearningItems('art_marks_core')
            .filter((item) => item.anchor?.quote === 'meeting')
            .map((item) => ({ version: item.contentVersion, start: item.anchor?.start })));
        check('延遲回應只保存成原版本或直接丟棄，不會記成新版本', versionProbe.before !== versionProbe.after
            && meetingItems.every((item) => item.version === versionProbe.before), JSON.stringify({ versionProbe, meetingItems }));

        await asyncPage.evaluate(() => window.getSelection()?.removeAllRanges());
        await asyncPage.mouse.click(8, 900);
        await asyncPage.locator('.interactive-word[data-word="We"]').first().click();
        await asyncPage.waitForFunction(() => !!window.__pendingReplies?.We);
        await asyncPage.evaluate(async (article) => {
            const { art, rd } = window.__marksReview;
            await art.reloadScope('marks-review::other-account');
            await rd.reloadReadingScope('marks-review::other-account');
            await art.saveArticle({ articleId: article.id, article: article.body, title: 'Other account', result: article.result });
            window.__pendingReplies.We.resolve({ word: 'We', analysis: { meaning: '我們', pos: 'pron.', role: '代詞', phonetic: '' } });
        }, ARTICLE);
        await asyncPage.waitForTimeout(450);
        const otherScopeItems = await asyncPage.evaluate(() => window.__marksReview.rd.listLearningItems('art_marks_core'));
        check('延遲回應不寫進切換後的帳戶', otherScopeItems.length === 0, JSON.stringify(otherScopeItems.map((item) => item.anchor?.quote)));
        const otherScopeArticle = await asyncPage.evaluate(() => {
            const record = window.__marksReview.art.getRecord('art_marks_core');
            return (record?.result?.detailed_analysis || []).map((entry) => String(entry.word || '').toLowerCase());
        });
        check('延遲回應不把詞詳解寫進切換後的帳戶文章', !otherScopeArticle.includes('we'), JSON.stringify(otherScopeArticle));
        check('非同步隔離流程沒有 page error', asyncErrors.length === 0, asyncErrors.join('\n'));
        await asyncContext.close();

        check('核心標記流程沒有 console/page 錯誤', errors.length === 0, errors.join('\n'));
        await context.close();
    } finally {
        await browser.close();
    }
    if (failures.length) {
        console.error(`\n${failures.length} 項失敗`);
        for (const failure of failures) console.error(`- ${failure.name}: ${failure.detail}`);
        process.exit(1);
    }
    console.log('\n全部統一標記核心測試通過');
})();
