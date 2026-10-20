/**
 * 文章非同步詳解的版本歸屬回歸測試。
 *
 * 覆蓋：
 *   1. 舊版按需查詞回應不得併入目前已改寫正文的 `result.detailed_analysis`；
 *   2. 使用者已收起的查詞彈窗，不得被遲到的舊回應重新打開；
 *   3. 重複句子的句卡 refresh 必須沿用卡片自己的 occurrence（不重算成 -1）；
 *   4. refresh 等待期間正文改版：畫面與 legacy `result` 都不得被舊請求更新；
 *   5. 正文先改版再點舊句卡 refresh：不得再發請求，也不得建立新版 -1 條目或污染新版 result；
 *   6. 首次句子分析等待期間改版：遲到回應不得重繪新版本，也不得寫入新版 result。
 *
 * 用法：
 *   PORT=8313 PLAYWRIGHT_MODULE=<path-to-playwright> node tests/article-version-ownership.cjs
 *
 * 全程使用隔離的 browser context 與 route mock，不連任何真實 AI／同步端點。
 */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const PORT = Number(process.env.PORT || 8313);
const BASE = `http://127.0.0.1:${PORT}/`;
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const failures = [];
function check(name, condition, detail) {
    if (condition) {
        console.log(`  ok   ${name}`);
        return true;
    }
    failures.push({ name, detail: detail === undefined ? '' : String(detail).slice(0, 400) });
    console.log(`  FAIL ${name}${detail !== undefined ? ' -- ' + String(detail).slice(0, 300) : ''}`);
    return false;
}

const SENTENCE = 'We look forward to meeting you.';

function articleFixture(id, title) {
    return {
        id,
        title,
        body: `${SENTENCE}\n\n${SENTENCE}`,
        result: {
            chinese_translation: '我們期待與你見面。\n\n我們期待與你見面。',
            word_alignment: [],
            detailed_analysis: [
                { word: 'forward', sentence: SENTENCE, analysis: { phonetic: '', pos: 'adv.', meaning: '向前', role: '副詞' } }
            ],
            paragraph_analysis: [0, 1].map(() => ({
                chinese_translation: '我們期待與你見面。',
                sentences: [{ en: SENTENCE, zh: '我們期待與你見面。' }]
            })),
            sentence_analysis: [],
            phrase_analysis: []
        }
    };
}

async function seedArticle(page, article) {
    await page.evaluate(async (a) => {
        const art = await import('/modules/article-store.js');
        const rd = await import('/modules/reading-store.js');
        const state = await import('/modules/state.js');
        await art.initArticleStore();
        await rd.initReadingStore();
        await art.saveArticle({
            articleId: a.id,
            article: a.body,
            title: a.title,
            sourceType: 'paste',
            result: a.result
        });
        state.setCurrentArticleId(a.id);
        state.setCurrentWordbookId(a.id);
        window.review = { art, rd, state };
    }, article);
}

async function openArticle(page) {
    if (!(await page.locator('#article-btn').isVisible())) await page.click('#nav-more-btn');
    await page.click('#article-btn');
    await page.evaluate(async () => (await import('/features/article/article.js')).showCurrentArticleIfAvailable());
    await page.waitForTimeout(500);
}

async function closeModal(page) {
    const close = page.locator('#app-modal .modal-close-btn');
    if (await close.isVisible().catch(() => false)) await close.click();
    await page.waitForTimeout(150);
}

function mockApiSource(body) {
    return body
        .replace('export async function analyzeWordInSentence(', 'export async function originalAnalyzeWordInSentence(')
        .replace('export async function analyzeSentence(', 'export async function originalAnalyzeSentence(')
        .replace('export async function analyzeSelection(', 'export async function originalAnalyzeSelection(')
        .concat(`
export function analyzeWordInSentence(word, sentence) {
    window.__pendingWordReplies ||= {};
    return new Promise((resolve, reject) => {
        window.__pendingWordReplies[word] = { resolve, reject, sentence };
    });
}
export function analyzeSentence(sentence, context) {
    window.__pendingSentenceReplies ||= [];
    return new Promise((resolve, reject) => {
        window.__pendingSentenceReplies.push({ resolve, reject, sentence, context });
    });
}
export function analyzeSelection(selection, sentence, context) {
    window.__pendingSelectionReplies ||= {};
    return new Promise((resolve, reject) => {
        window.__pendingSelectionReplies[selection] = { resolve, reject, sentence, context };
    });
}
`);
}

(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: CHROME });
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    const pageErrors = [];
    let page;
    try {
        await context.route('**/*', async (route) => {
            const url = new URL(route.request().url());
            if (url.pathname.endsWith('/ai-config.js')) {
                return route.fulfill({ contentType: 'application/javascript', body: 'export const SYNC={endpoint:""}; export const TTS_CONFIG={}, AI_LIMITS={}, OCR_CONFIG={}, ARTICLE_IMPORT={}, SUPABASE={};' });
            }
            if (url.pathname === '/modules/api.js') {
                const response = await route.fetch();
                return route.fulfill({ response, body: mockApiSource(await response.text()) });
            }
            if (url.origin !== `http://127.0.0.1:${PORT}`) return route.abort();
            return route.continue();
        });
        await context.addInitScript(() => {
            localStorage.setItem('pen_global_settings', JSON.stringify({ language: { interfaceLocale: 'zh-CN' } }));
        });
        page = await context.newPage();
        page.on('pageerror', (error) => pageErrors.push(String(error)));
        await page.goto(BASE);
        await page.waitForTimeout(900);
        await page.evaluate(() => {
            const modal = document.getElementById('app-modal');
            if (modal && !modal.classList.contains('hidden')) modal.querySelector('.modal-close-btn')?.click();
        });

        const article = articleFixture('art_version_ownership', 'Version ownership');
        await seedArticle(page, article);
        await openArticle(page);

        // ── 1. 已收起的彈窗不得被舊回應重新打開 ──
        console.log('\n[延遲回應不重開已收起的彈窗]');
        await page.locator('.interactive-word[data-word="look"]').first().click();
        await page.waitForFunction(() => !!window.__pendingWordReplies?.look);
        await page.mouse.click(8, 900);
        const hiddenBeforeResolve = await page.evaluate(() => getComputedStyle(document.getElementById('word-analysis-tooltip')).display === 'none');
        await page.evaluate(() => window.__pendingWordReplies.look.resolve({ word: 'look', analysis: { meaning: '看', pos: 'v.', role: '動詞', phonetic: '' } }));
        await page.waitForTimeout(400);
        const hiddenAfterResolve = await page.evaluate(() => getComputedStyle(document.getElementById('word-analysis-tooltip')).display === 'none');
        check('收起後遲到回應不重開彈窗', hiddenBeforeResolve && hiddenAfterResolve, { hiddenBeforeResolve, hiddenAfterResolve });

        // ── 2. 重複句的句卡 refresh 必須保留自己的 occurrence ──
        console.log('\n[句卡 refresh 保留重複句的精確 occurrence]');
        await closeModal(page);
        await page.evaluate(() => document.querySelectorAll('.sentence-wrap')[0].click());
        await page.waitForFunction(() => (window.__pendingSentenceReplies || []).length === 1);
        const firstCardAnchor = await page.evaluate(() => {
            const card = document.querySelector('#modal-body .sentence-card.is-modal');
            return { start: card?.dataset.anchorStart, end: card?.dataset.anchorEnd };
        });
        check('第一處句卡凍結自己的 occurrence', firstCardAnchor.start === '0' && firstCardAnchor.end === String(SENTENCE.length), firstCardAnchor);
        await page.evaluate(() => window.__pendingSentenceReplies[0].resolve({ translation: '初次譯文', chunks: [], key_points: [], phrase_alignment: [] }));
        await page.waitForTimeout(400);
        await page.locator('#app-modal .sentence-card.is-modal .sent-refresh').click();
        await page.waitForFunction(() => (window.__pendingSentenceReplies || []).length === 2);
        await page.evaluate(() => window.__pendingSentenceReplies[1].resolve({
            translation: '刷新譯文-標記',
            chunks: [{ text: 'look forward', role: 'phrase', note: '期待' }],
            key_points: [],
            phrase_alignment: []
        }));
        await page.waitForTimeout(500);
        const refreshProbe = await page.evaluate(async () => {
            const { art, rd } = window.review;
            const items = rd.listLearningItems('art_version_ownership')
                .filter((item) => item.kind === 'sentence')
                .map((item) => ({ start: item.anchor?.start, end: item.anchor?.end, version: item.contentVersion }));
            const record = art.getRecord('art_version_ownership');
            const saved = (record?.result?.sentence_analysis || []).map((entry) => entry.translation);
            const cardText = document.querySelector('#modal-body .sentence-card.is-modal')?.textContent || '';
            return { items, saved, cardText };
        });
        check('refresh 保存到卡片自己的 occurrence（不是 -1／另一處）', refreshProbe.items.length === 1
            && refreshProbe.items.every((item) => item.start === 0 && item.end === SENTENCE.length), JSON.stringify(refreshProbe.items));
        check('refresh 更新原卡片與 sentence_analysis', refreshProbe.saved.includes('刷新譯文-標記')
            && refreshProbe.cardText.includes('刷新譯文-標記'), JSON.stringify(refreshProbe.saved));

        // ── 3. 舊版片語回應不得寫進新正文（句卡 chunk 詳解走 persistPhraseAnalysis）──
        console.log('\n[舊版片語回應不污染新正文]');
        await page.locator('#app-modal .sentence-card.is-modal .chunk-explain').first().click();
        await page.waitForFunction(() => !!window.__pendingSelectionReplies?.['look forward']);
        const phraseVersion = await page.evaluate(async () => {
            const actions = await import('/modules/reading-actions.js');
            return actions.articleVersion('art_version_ownership');
        });
        await page.evaluate(async (a) => {
            await window.review.art.saveArticle({ articleId: a.id, article: 'A changed version. ' + a.body, title: a.title });
            window.__pendingSelectionReplies['look forward'].resolve({ selection: 'look forward', analysis: { meaning: '期待-舊版回應', usage: '', examples: [] } });
        }, article);
        await page.waitForTimeout(500);
        const phraseProbe = await page.evaluate(async (a) => {
            const { art } = window.review;
            const record = art.getRecord(a.id);
            const actions = await import('/modules/reading-actions.js');
            return {
                phraseAnalysis: record?.result?.phrase_analysis || [],
                currentVersion: actions.articleVersion(a.id)
            };
        }, article);
        check('片語舊回應未併入目前正文', phraseVersion !== phraseProbe.currentVersion
            && !phraseProbe.phraseAnalysis.some((entry) => entry.analysis?.meaning === '期待-舊版回應'), JSON.stringify({ phraseVersion, currentVersion: phraseProbe.currentVersion, phraseAnalysis: phraseProbe.phraseAnalysis }));
        await closeModal(page);
        await page.mouse.click(8, 900);

        // ── 4. 舊版查詞回應不得污染目前正文，也不得重新顯示 ──
        console.log('\n[舊版查詞回應不污染目前正文]');
        await page.locator('.interactive-word[data-word="meeting"]').first().click();
        await page.waitForFunction(() => !!window.__pendingWordReplies?.meeting);
        const meetingProbe = await page.evaluate(async () => {
            const actions = await import('/modules/reading-actions.js');
            return actions.articleVersion('art_version_ownership');
        });
        await page.evaluate(async (a) => {
            await window.review.art.saveArticle({ articleId: a.id, article: 'B changed version. ' + a.body, title: a.title });
            window.__pendingWordReplies.meeting.resolve({ word: 'meeting', sentence: 'We look forward to meeting you.', analysis: { meaning: '見面', pos: 'v.', role: '動名詞', phonetic: '' } });
        }, article);
        await page.waitForTimeout(600);
        const lateWordProbe = await page.evaluate(() => {
            const { art, rd } = window.review;
            const record = art.getRecord('art_version_ownership');
            const items = rd.listLearningItems('art_version_ownership')
                .filter((item) => item.anchor?.quote === 'meeting')
                .map((item) => ({ version: item.contentVersion, start: item.anchor?.start }));
            return {
                analysis: (record?.result?.detailed_analysis || []).map((entry) => entry.word),
                items,
                tooltipTitle: document.querySelector('#word-analysis-tooltip .tooltip-title')?.textContent || ''
            };
        });
        check('舊版查詞不污染目前 result.detailed_analysis', !lateWordProbe.analysis.includes('meeting'), JSON.stringify(lateWordProbe.analysis));
        check('查詞解釋仍只保存成原版本', lateWordProbe.items.length > 0
            && lateWordProbe.items.every((item) => item.version === meetingProbe), JSON.stringify(lateWordProbe.items));
        check('改版後舊回應不重新顯示彈窗', !lateWordProbe.tooltipTitle.includes('meeting'), lateWordProbe.tooltipTitle);
        await page.mouse.click(8, 900);

        // ── 5. refresh 等待期間改版：畫面與 legacy result 都不得更新 ──
        console.log('\n[refresh 等待期間改版則丟棄結果]');
        await closeModal(page);
        const lateArticle = articleFixture('art_version_late_refresh', 'Late refresh');
        await seedArticle(page, lateArticle);
        await page.evaluate(async () => {
            const state = await import('/modules/state.js');
            state.setCurrentArticleId('art_version_late_refresh');
            state.setCurrentWordbookId('art_version_late_refresh');
        });
        await openArticle(page);
        await page.evaluate(() => document.querySelectorAll('.sentence-wrap')[0].click());
        await page.waitForFunction(() => (window.__pendingSentenceReplies || []).length === 3);
        await page.evaluate(() => window.__pendingSentenceReplies[2].resolve({ translation: '改版前譯文', chunks: [], key_points: [], phrase_alignment: [] }));
        await page.waitForTimeout(450);
        await page.locator('#app-modal .sentence-card.is-modal .sent-refresh').click();
        await page.waitForFunction(() => (window.__pendingSentenceReplies || []).length === 4);
        const lateRefreshVersion = await page.evaluate(async () => {
            const actions = await import('/modules/reading-actions.js');
            return actions.articleVersion('art_version_late_refresh');
        });
        await page.evaluate(async (a) => {
            await window.review.art.saveArticle({ articleId: a.id, article: 'Changed while refreshing. ' + a.body, title: a.title });
            window.__pendingSentenceReplies[3].resolve({ translation: '延遲刷新標記', chunks: [], key_points: [], phrase_alignment: [] });
        }, lateArticle);
        await page.waitForTimeout(600);
        const delayedProbe = await page.evaluate(async () => {
            const { art } = window.review;
            const record = art.getRecord('art_version_late_refresh');
            const actions = await import('/modules/reading-actions.js');
            return {
                saved: (record?.result?.sentence_analysis || []).map((entry) => entry.translation),
                cardText: document.querySelector('#modal-body .sentence-card.is-modal')?.textContent || '',
                currentVersion: actions.articleVersion('art_version_late_refresh'),
                errorToasts: Array.from(document.querySelectorAll('#message-container .message-error')).map((el) => el.textContent || '')
            };
        });
        check('改版後 refresh 不寫入 legacy sentence_analysis', lateRefreshVersion !== delayedProbe.currentVersion
            && !delayedProbe.saved.includes('延遲刷新標記'), JSON.stringify({ lateRefreshVersion, currentVersion: delayedProbe.currentVersion, saved: delayedProbe.saved }));
        check('改版後 refresh 不更新原卡片', !delayedProbe.cardText.includes('延遲刷新標記'), delayedProbe.cardText.slice(0, 200));
        check('競態不顯示多餘的儲存失敗訊息', delayedProbe.errorToasts.length === 0, JSON.stringify(delayedProbe.errorToasts));

        // ── 6. 正文先改版，再點舊句卡的 refresh：必須直接阻止，不發請求 ──
        console.log('\n[正文已改版後點舊句卡 refresh 必須被阻止]');
        await closeModal(page);
        const staleCardArticle = articleFixture('art_stale_card_refresh', 'Stale card refresh');
        await seedArticle(page, staleCardArticle);
        await openArticle(page);
        const beforeStaleCard = await page.evaluate(() => (window.__pendingSentenceReplies || []).length);
        await page.evaluate(() => document.querySelectorAll('.sentence-wrap')[0].click());
        await page.waitForFunction((n) => (window.__pendingSentenceReplies || []).length === n + 1, beforeStaleCard);
        await page.evaluate((n) => window.__pendingSentenceReplies[n].resolve({ translation: '改版前初次譯文', chunks: [], key_points: [], phrase_alignment: [] }), beforeStaleCard);
        await page.waitForTimeout(450);
        const staleCardVersion = await page.evaluate(async () => (await import('/modules/reading-actions.js')).articleVersion('art_stale_card_refresh'));
        await page.evaluate(async (a) => {
            await window.review.art.saveArticle({ articleId: a.id, article: 'Changed before refresh. ' + a.body, title: a.title });
        }, staleCardArticle);
        const pendingBeforeStaleClick = await page.evaluate(() => (window.__pendingSentenceReplies || []).length);
        await page.locator('#app-modal .sentence-card.is-modal .sent-refresh').click();
        await page.waitForTimeout(500);
        const staleCardProbe = await page.evaluate(async () => {
            const { art, rd } = window.review;
            const actions = await import('/modules/reading-actions.js');
            return {
                pending: (window.__pendingSentenceReplies || []).length,
                currentVersion: actions.articleVersion('art_stale_card_refresh'),
                items: rd.listLearningItems('art_stale_card_refresh')
                    .filter((item) => item.kind === 'sentence')
                    .map((item) => ({ version: item.contentVersion, start: item.anchor?.start })),
                saved: (art.getRecord('art_stale_card_refresh')?.result?.sentence_analysis || []).map((entry) => entry.translation)
            };
        });
        check('改版後點 refresh 不再發送新請求', staleCardProbe.pending === pendingBeforeStaleClick, JSON.stringify({ pendingBeforeStaleClick, pending: staleCardProbe.pending }));
        check('舊卡 refresh 不在新版本建立 -1 條目', staleCardProbe.currentVersion !== staleCardVersion
            && staleCardProbe.items.length > 0
            && staleCardProbe.items.every((item) => item.version === staleCardVersion && item.start >= 0), JSON.stringify({ staleCardVersion, ...staleCardProbe }));
        check('舊卡 refresh 不污染新版 sentence_analysis', !staleCardProbe.saved.includes('stale-card-refresh'), JSON.stringify(staleCardProbe.saved));

        // ── 7. 首次句子回應延遲跨版本：不得重繪新正文 ──
        console.log('\n[首次句子回應延遲跨版本不得重繪新正文]');
        await closeModal(page);
        const lateFirstArticle = articleFixture('art_first_sentence_late', 'Late first sentence');
        await seedArticle(page, lateFirstArticle);
        await openArticle(page);
        const beforeLateFirst = await page.evaluate(() => (window.__pendingSentenceReplies || []).length);
        await page.evaluate(() => document.querySelectorAll('.sentence-wrap')[0].click());
        await page.waitForFunction((n) => (window.__pendingSentenceReplies || []).length === n + 1, beforeLateFirst);
        const lateFirstVersion = await page.evaluate(async () => (await import('/modules/reading-actions.js')).articleVersion('art_first_sentence_late'));
        await page.evaluate(async (a) => {
            await window.review.art.saveArticle({ articleId: a.id, article: 'Changed while first sentence pending. ' + a.body, title: a.title });
        }, lateFirstArticle);
        await page.evaluate((n) => window.__pendingSentenceReplies[n].resolve({ translation: '首次延遲譯文', chunks: [], key_points: [], phrase_alignment: [] }), beforeLateFirst);
        await page.waitForTimeout(600);
        const lateFirstProbe = await page.evaluate(async () => {
            const { art, rd } = window.review;
            const actions = await import('/modules/reading-actions.js');
            return {
                currentVersion: actions.articleVersion('art_first_sentence_late'),
                items: rd.listLearningItems('art_first_sentence_late')
                    .filter((item) => item.kind === 'sentence')
                    .map((item) => ({ version: item.contentVersion, start: item.anchor?.start })),
                saved: (art.getRecord('art_first_sentence_late')?.result?.sentence_analysis || []).map((entry) => entry.translation),
                cardText: document.querySelector('#modal-body .sentence-card.is-modal')?.textContent || ''
            };
        });
        check('首次句子延遲回應不寫入新版 sentence_analysis', lateFirstProbe.currentVersion !== lateFirstVersion
            && !lateFirstProbe.saved.includes('首次延遲譯文'), JSON.stringify({ lateFirstVersion, ...lateFirstProbe }));
        check('首次句子延遲回應不重繪新版本卡片', !lateFirstProbe.cardText.includes('首次延遲譯文'), lateFirstProbe.cardText.slice(0, 200));
        check('首次句子延遲回應只保留原版本條目', lateFirstProbe.items.length > 0
            && lateFirstProbe.items.every((item) => item.version === lateFirstVersion && item.start >= 0), JSON.stringify(lateFirstProbe.items));

        check('流程沒有 page error', pageErrors.length === 0, pageErrors.join('\n'));
    } finally {
        if (page) await page.close().catch(() => {});
        await context.close().catch(() => {});
        await browser.close();
    }
    if (failures.length) {
        console.error(`\n${failures.length} 項失敗`);
        for (const failure of failures) console.error(`- ${failure.name}: ${failure.detail}`);
        process.exit(1);
    }
    console.log('\n文章版本歸屬回歸測試全部通過');
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
