/**
 * 段落精簡刷新與單詞重新獲取：真實請求、快取更新、落盤及窄屏操作。
 * 先開 scripts/serve.py，再執行：
 * PORT=8313 PLAYWRIGHT_MODULE=<path-to-playwright> node tests/article-refresh-controls.cjs
 * 可用 ARTIFACT_DIR 保存截圖；所有外部服務均使用隔離 mock。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const mock = require('./helpers/article-mock.cjs');

const BASE = `http://127.0.0.1:${process.env.PORT || 8313}/`;
const ID = 'art_refresh_controls';
const SENTENCE = 'The reading room opens at eight.';
const BOOK_SENTENCE = 'Visitors sign the book at the door.';
const PARAGRAPHS = [
    `${SENTENCE} ${BOOK_SENTENCE}`,
    'A second paragraph keeps the archive quiet.',
    'The final paragraph needs another translation.'
];
const savedWord = (word, sentence, meaning) => ({ word, sentence, analysis: { meaning, pos: 'noun', phonetic: 'test', role: '主语' } });
const DOC = {
    id: ID, title: 'Reading together', body: PARAGRAPHS.join('\n\n'), sourceType: 'paste', revision: 0,
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', lastOpenedAt: '2026-10-01T00:00:00.000Z',
    analysis: {
        chinese_translation: '阅览室八点开门。', word_alignment: [],
        detailed_analysis: [savedWord('reading', SENTENCE, '旧释义'), savedWord('book', BOOK_SENTENCE, '保留的释义')],
        sentence_analysis: [], phrase_analysis: [],
        paragraph_analysis: [
            { chinese_translation: '阅览室八点开门。访客在门口签到。', word_alignment: [], detailed_analysis: [] },
            { chinese_translation: '第二段让档案馆保持安静。', word_alignment: [], detailed_analysis: [] },
            { chinese_translation: '', failed: true, errorCode: 'empty_response', word_alignment: [], detailed_analysis: [] }
        ]
    }
};
let checks = 0;
function check(name, condition, detail) {
    assert.ok(condition, `${name}: ${JSON.stringify(detail)}`);
    checks += 1;
    console.log(`PASS ${name}`);
}
const t = (page, key) => page.evaluate(async (value) => (await import('/modules/i18n.js')).t(value), key);
const tooltip = (page) => page.locator('#word-analysis-tooltip');
const word = (page, value) => page.locator(`.interactive-word[data-word="${value}"]`).first();
const refreshWord = (page) => tooltip(page).locator('.btn-refresh-word');
const closeWord = (page) => tooltip(page).locator('.tooltip-close').click();
const pair = (page, index) => page.locator(`.paragraph-pair[data-paragraph-index="${index}"]`);

async function openArticle(page) {
    await page.evaluate(async () => { await (await import('/modules/article-store.js')).reloadScope(); });
    await page.locator('#article-history-btn').click();
    await page.locator(`.ar-history-item[data-key="${ID}"] .ar-history-open`).click();
    await pair(page, 2).waitFor();
}

async function waitMeaning(page, meaning) {
    await page.waitForFunction((text) => document.querySelector('#word-analysis-tooltip .tooltip-meaning')?.textContent.includes(text), meaning);
}

async function waitSaved(page, meaning) {
    await page.waitForFunction(async ({ id, meaning }) => {
        const store = await import('/modules/article-store.js');
        return store.getRecord(id)?.result?.detailed_analysis?.some((entry) => entry.word === 'reading' && entry.analysis?.meaning === meaning);
    }, { id: ID, meaning });
}

async function screenshot(page, name) {
    if (!process.env.ARTIFACT_DIR) return;
    fs.mkdirSync(process.env.ARTIFACT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.ARTIFACT_DIR, name + '.png'), style: '#message-container { visibility: hidden !important; }' });
}

async function runLocale(browser, locale) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await mock.initScript(context, { locale });
    await context.addInitScript(() => {
        const settings = JSON.parse(localStorage.getItem('pen_global_settings') || '{}');
        settings.reading = { ...settings.reading, articleSidebarCollapsed: true, translationMask: false };
        localStorage.setItem('pen_global_settings', JSON.stringify(settings));
    });
    await context.route('**/*', (route) => {
        const host = new URL(route.request().url()).hostname;
        return ['127.0.0.1', 'localhost', 'provider.mock'].includes(host) ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    const ai = { wordCalls: 0, paragraphCalls: 0, empty: false, plainFallback: false, hold: null, release: null };
    await mock.installProviderRoutes(page, async ({ route, prompt }) => {
        if (/^Word: /m.test(prompt)) {
            ai.wordCalls += 1;
            return mock.jsonReply(route, '后备新释义');
        }
        if (/Target word:\s*"/.test(prompt)) {
            ai.wordCalls += 1;
            const serial = ai.wordCalls;
            const targetWord = (prompt.match(/Target word:\s*"([^"]+)"/) || [])[1] || 'word';
            if (ai.plainFallback) return mock.jsonReply(route, 'invalid JSON');
            const empty = ai.empty;
            if (ai.hold && targetWord === 'reading') await ai.hold;
            return mock.jsonReply(route, savedWord(targetWord, '', empty ? '' : `新释义 ${serial}`));
        }
        ai.paragraphCalls += 1;
        return mock.jsonReply(route, mock.translatedParagraphReply(prompt, `刷新段落 ${ai.paragraphCalls}：`));
    });
    const holdReading = () => { ai.hold = new Promise((resolve) => { ai.release = resolve; }); };
    const releaseReading = () => { ai.release(); ai.hold = null; ai.release = null; };

    try {
        await page.goto(BASE + '#a', { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.getElementById('article-sidebar-toggle')?.getAttribute('aria-expanded') === 'false');
        await page.evaluate(() => document.querySelector('#app-modal:not(.hidden) .modal-close-btn')?.click());
        await mock.seedDocs(page, [DOC]);
        await openArticle(page);

        const geometry = await pair(page, 0).evaluate((node) => {
            const english = node.querySelector('.paragraph-english');
            const chinese = node.querySelector('.paragraph-chinese');
            const action = node.querySelector('.retry-paragraph-btn');
            const box = node.getBoundingClientRect();
            const button = action.getBoundingClientRect();
            return {
                footerSpace: box.bottom - chinese.getBoundingClientRect().bottom,
                buttonInEnglish: button.top >= box.top && button.bottom <= english.getBoundingClientRect().bottom,
                textPadding: parseFloat(getComputedStyle(english).paddingRight),
                buttonWidth: button.width
            };
        });
        check(`${locale}：完成段落沒有多餘底欄`, geometry.footerSpace <= 2 && geometry.buttonInEnglish, geometry);
        check(`${locale}：刷新入口預留文字空間`, geometry.textPadding > geometry.buttonWidth + 8, geometry);
        check(`${locale}：段落刷新有翻譯標籤`, await pair(page, 0).locator('.retry-paragraph-btn').getAttribute('aria-label') === await t(page, 'article.refresh'));
        check(`${locale}：失敗段保留原因與重試`, await pair(page, 2).locator('.para-reason').isVisible() && await pair(page, 2).locator('.retry-paragraph-btn').isVisible());
        const secondTranslation = await pair(page, 1).locator('.paragraph-chinese').textContent();
        await screenshot(page, `paragraphs-${locale}`);

        await pair(page, 0).locator('.retry-paragraph-btn svg').click();
        await page.waitForFunction(() => document.querySelector('.paragraph-pair[data-paragraph-index="0"] .paragraph-chinese')?.textContent.includes('刷新段落'));
        check(`${locale}：點擊刷新圖示確實重新請求本段`, ai.paragraphCalls === 1);
        check(`${locale}：其餘段落保持原內容`, await pair(page, 1).locator('.paragraph-chinese').textContent() === secondTranslation);
        await pair(page, 2).locator('.retry-paragraph-btn').click();
        await pair(page, 2).locator('.para-status[data-status="done"] .retry-paragraph-btn svg').waitFor();
        check(`${locale}：失敗重試完成後恢復精簡入口`, ai.paragraphCalls === 2);

        await word(page, 'reading').click();
        await waitMeaning(page, '旧释义');
        check(`${locale}：已儲存詳解正常開啟且有刷新入口`, ai.wordCalls === 0 && await refreshWord(page).isVisible());
        check(`${locale}：單詞刷新有翻譯標籤`, await refreshWord(page).getAttribute('aria-label') === await t(page, 'article.refreshWord'));
        check(`${locale}：主要操作包含直接問 AI`, await tooltip(page).locator('.tooltip-primary-actions > button').count() === 4);

        // 先建立舊的持久快取：刷新必須真的再送一次 provider 請求。
        await page.evaluate(async (sentence) => (await import('/modules/api.js')).analyzeWordInSentence('reading', sentence), SENTENCE);
        check(`${locale}：已建立持久快取作為驗證基準`, ai.wordCalls === 1);
        holdReading();
        await refreshWord(page).locator('svg').click();
        await page.waitForFunction(() => document.querySelector('.btn-refresh-word')?.getAttribute('aria-busy') === 'true');
        await page.waitForTimeout(100);
        check(`${locale}：刷新略過舊快取且忙碌時禁止連點`, ai.wordCalls === 2 && await refreshWord(page).isDisabled());
        releaseReading();
        await waitMeaning(page, '新释义 2');
        await waitSaved(page, '新释义 2');
        const saved = await page.evaluate(async (id) => (await import('/modules/article-store.js')).getRecord(id).result.detailed_analysis, ID);
        check(`${locale}：新詳解替換舊項而保留其他單詞`, saved.filter((entry) => entry.word === 'reading').length === 1 && saved.find((entry) => entry.word === 'reading').analysis.meaning === '新释义 2' && saved.some((entry) => entry.word === 'book'));
        const cached = await page.evaluate(async (sentence) => (await import('/modules/api.js')).analyzeWordInSentence('reading', sentence), SENTENCE);
        check(`${locale}：持久快取也更新成新結果`, ai.wordCalls === 2 && cached.analysis.meaning === '新释义 2');
        await screenshot(page, `word-${locale}`);
        await closeWord(page);
        await word(page, 'reading').click();
        await waitMeaning(page, '新释义 2');
        check(`${locale}：重開單詞顯示更新結果`, ai.wordCalls === 2);
        await refreshWord(page).click();
        await waitMeaning(page, '新释义 3');
        check(`${locale}：再次刷新略過頁內已完成快取`, ai.wordCalls === 3);

        ai.empty = true;
        await refreshWord(page).click();
        await tooltip(page).locator('.btn-retry-word').waitFor();
        check(`${locale}：刷新失敗仍提供重試`, ai.wordCalls === 4 && await refreshWord(page).isEnabled());
        ai.empty = false;
        await tooltip(page).locator('.btn-retry-word').click();
        await waitMeaning(page, '新释义 5');
        check(`${locale}：錯誤重試重新請求而非返回舊詳解`, ai.wordCalls === 5);

        holdReading();
        await refreshWord(page).click();
        await page.waitForTimeout(100);
        await closeWord(page);
        await word(page, 'reading').click();
        await refreshWord(page).click();
        await page.waitForTimeout(100);
        check(`${locale}：關閉後重開刷新仍共用進行中的請求`, ai.wordCalls === 6 && await refreshWord(page).isDisabled());
        releaseReading();
        await waitMeaning(page, '新释义 6');

        holdReading();
        await refreshWord(page).click();
        await page.waitForTimeout(100);
        await word(page, 'book').click();
        await waitMeaning(page, '保留的释义');
        releaseReading();
        await waitSaved(page, '新释义 7');
        check(`${locale}：延遲刷新不覆蓋新選詞`, (await tooltip(page).locator('.tooltip-title').textContent()).includes('book') && (await tooltip(page).textContent()).includes('保留的释义'));
        await closeWord(page);
        await word(page, 'reading').click();
        await waitMeaning(page, '新释义 7');
        check(`${locale}：切換單詞後重開即顯示剛完成的刷新`, ai.wordCalls === 7);

        await page.evaluate(async (value) => (await import('/modules/i18n.js')).setLocale(value), locale === 'zh-CN' ? 'zh-HK' : 'zh-CN');
        check(`${locale}：切換語言同步更新單詞及段落刷新標籤`, await refreshWord(page).getAttribute('aria-label') === await t(page, 'article.refreshWord') && await pair(page, 0).locator('.retry-paragraph-btn').getAttribute('aria-label') === await t(page, 'article.refresh'));
        await closeWord(page);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.getElementById('article-sidebar-toggle')?.getAttribute('aria-expanded') === 'false');
        await page.evaluate(() => document.querySelector('#app-modal:not(.hidden) .modal-close-btn')?.click());
        await openArticle(page);
        await word(page, 'reading').click();
        await waitMeaning(page, '新释义 7');
        check(`${locale}：重新載入後保留刷新結果`, ai.wordCalls === 7);

        // 語言切換後先建立這個 locale 的舊快取，再驗純文字後備結果會取代它。
        await page.evaluate(async (sentence) => (await import('/modules/api.js')).analyzeWordInSentence('reading', sentence), SENTENCE);
        const beforeFallback = ai.wordCalls;
        ai.plainFallback = true;
        await refreshWord(page).click();
        await waitMeaning(page, '后备新释义');
        check(`${locale}：JSON 解析失敗可用純文字後備完成刷新`, ai.wordCalls >= beforeFallback + 2);
        const afterFallback = ai.wordCalls;
        const fallbackCached = await page.evaluate(async (sentence) => (await import('/modules/api.js')).analyzeWordInSentence('reading', sentence), SENTENCE);
        check(`${locale}：純文字後備結果取代舊持久快取`, ai.wordCalls === afterFallback && fallbackCached.analysis.meaning === '后备新释义');
        check(`${locale}：沒有頁面執行錯誤`, pageErrors.length === 0, pageErrors);
    } finally {
        if (ai.release) releaseReading();
        await context.close();
    }
}

async function runMobile(browser, locale) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    await mock.initScript(context, { locale });
    await context.route('**/*', (route) => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
    const page = await context.newPage();
    try {
        await page.goto(BASE + '#a', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(650);
        await page.evaluate(() => document.querySelector('#app-modal:not(.hidden) .modal-close-btn')?.click());
        await mock.seedDocs(page, [DOC]);
        await openArticle(page);
        if (await page.locator('#article-sidebar-toggle').getAttribute('aria-expanded') === 'true') await page.locator('#article-sidebar-toggle').click();
        await pair(page, 0).scrollIntoViewIfNeeded();
        const state = await pair(page, 0).evaluate((node) => {
            const button = node.querySelector('.retry-paragraph-btn');
            const rect = button.getBoundingClientRect();
            const english = node.querySelector('.paragraph-english');
            return {
                width: rect.width, height: rect.height,
                noOverflow: document.documentElement.scrollWidth <= window.innerWidth,
                inside: rect.right <= node.getBoundingClientRect().right,
                textPadding: parseFloat(getComputedStyle(english).paddingRight)
            };
        });
        check(`${locale} 手機：刷新易點且正文不溢出`, state.width >= 40 && state.height >= 40 && state.noOverflow && state.inside && state.textPadding > state.width + 8, state);
        await screenshot(page, `mobile-paragraphs-${locale}`);
        await word(page, 'reading').click();
        await waitMeaning(page, '旧释义');
        const rect = await refreshWord(page).boundingBox();
        check(`${locale} 手機：單詞刷新在可見面板內`, rect && rect.width >= 36 && rect.x >= 0 && rect.y + rect.height <= 844, rect);
        const actionsUncovered = await tooltip(page).locator('.tooltip-head-actions').evaluate((actions) => Array.from(actions.querySelectorAll('button')).every((button) => {
            const box = button.getBoundingClientRect();
            return button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
        }));
        check(`${locale} 手機：刷新與關閉均不被浮鈕遮擋`, actionsUncovered);
        await screenshot(page, `mobile-word-${locale}`);
    } finally { await context.close(); }
}

(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: mock.CHROME });
    try {
        for (const locale of ['zh-CN', 'zh-HK']) {
            await runLocale(browser, locale);
            await runMobile(browser, locale);
        }
        console.log(`\n${checks} checks passed`);
    } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
