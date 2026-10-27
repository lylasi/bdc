/**
 * 文章詳解 P2-T2（單詞詳解）＋P2-T3（句級鍵盤入口／逐詞模式）驗收。
 *
 * 覆蓋：
 *   - 375×667／390×844／橫屏／200% 文字縮放：長詳解可捲動、關閉鈕可見且在視窗內
 *   - 詳解資訊層級：意思在作用之前；常用操作單列；「更多」選單可開筆記／短語
 *   - 載入中仍可發音、加入詞書、標記、關閉，且顯示載入文字
 *   - Escape 關閉詳解後焦點回到原詞
 *   - 純鍵盤：開句卡 → 逐詞檢視 → 方向鍵 → Enter 查詞 → Escape 回詞 → Escape 回句
 *   - 100 段文章按 Tab 不會逐詞停留
 *   - 句卡關閉後詞的 tabindex 全部移除
 *   - zh-CN／zh-HK 各跑一次動態文案與 locale 重畫
 *
 * 用法：
 *   PORT=8313 PLAYWRIGHT_MODULE=<path-to-playwright> node tests/article-keyboard-tooltip.cjs
 *
 * 不連真實 AI／TTS／同步端點；TTS 一律 mock 成失敗後落本機語音。
 */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const mock = require('./helpers/article-mock.cjs');

const PORT = Number(process.env.PORT || 8313);
const BASE = `http://127.0.0.1:${PORT}/`;

const BODY = 'The reading room opens at eight. Visitors sign the book at the door.\n\nA second paragraph keeps the archive quiet.';
const ANALYSIS = {
    chinese_translation: '阅览室八点开门。访客在门口签到。',
    word_alignment: [],
    detailed_analysis: [],
    paragraph_analysis: [
        { chinese_translation: '阅览室八点开门。访客在门口签到。', word_alignment: [], detailed_analysis: [] },
        { chinese_translation: '第二段让档案馆保持安静。', word_alignment: [], detailed_analysis: [] }
    ],
    sentence_analysis: [],
    phrase_analysis: []
};

const LONG_MEANING = '很长的释义，用来确认面板在窄屏与放大文字时可以内部滚动。'.repeat(24);
const LONG_ROLE = '在本句中作主语中心词，修饰语与介词短语都依附在它后面；这里刻意写长以撑高面板。'.repeat(6);

const HUNDRED_BODY = Array.from({ length: 100 }, (_, i) => (
    `Paragraph ${i + 1} keeps a quiet archive of reading notes.`
)).join('\n\n');
const HUNDRED_ANALYSIS = {
    chinese_translation: '一百段。',
    word_alignment: [],
    detailed_analysis: [],
    paragraph_analysis: Array.from({ length: 100 }, (_, i) => ({
        chinese_translation: `第 ${i + 1} 段译文。`,
        word_alignment: [],
        detailed_analysis: []
    })),
    sentence_analysis: [],
    phrase_analysis: []
};

const { check, finish } = mock.createReporter('文章鍵盤與單詞詳解（P2-T2／P2-T3）');
// 除錯用：ONLY=viewport|hierarchy|loading|keyboard|tab|locale 只跑單一情境。
const ONLY = String(process.env.ONLY || '').trim();
const wanted = (name) => !ONLY || ONLY === name;

const TTS_NOOP = `
    window.__spoken = [];
    try {
        Object.defineProperty(window, 'speechSynthesis', {
            configurable: true,
            value: {
                getVoices: () => [],
                cancel: () => {},
                pause: () => {},
                resume: () => {},
                speak: (utterance) => {
                    window.__spoken.push(String(utterance && utterance.text || ''));
                    try { if (utterance && utterance.onstart) utterance.onstart(); } catch (_) {}
                }
            }
        });
    } catch (_) {}
    try {
        window.SpeechSynthesisUtterance = function (text) { this.text = String(text || ''); };
    } catch (_) {}
`;

function recordDoc(id, body, analysis) {
    return {
        id,
        title: id === 'art_keyboard' ? 'Keyboard article' : 'Many paragraphs',
        body,
        analysis,
        sourceType: 'paste',
        revision: 0,
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
        lastOpenedAt: '2026-10-18T08:00:00.000Z'
    };
}

async function makePage(browser, { viewport = { width: 1280, height: 900 }, locale = 'zh-CN', hasTouch = false } = {}) {
    const context = await browser.newContext({ viewport, hasTouch });
    await mock.initScript(context, { locale });
    await context.addInitScript(TTS_NOOP);
    const page = await context.newPage();
    const state = { wordDelay: 0, wordCalls: 0 };
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error && error.message ? error.message : error)));

    await page.route('https://tts1.141455.xyz/**', (route) => route.fulfill({ status: 500, body: '' }));
    await mock.installProviderRoutes(page, async ({ route, prompt }) => {
        if (/Target word:\s*"/.test(prompt)) {
            state.wordCalls += 1;
            if (state.wordDelay) await new Promise((resolve) => setTimeout(resolve, state.wordDelay));
            const word = (prompt.match(/Target word:\s*"([^"]+)"/) || [])[1] || 'word';
            return mock.jsonReply(route, {
                word,
                sentence: '',
                analysis: { phonetic: 'ˈriːdɪŋ', pos: 'noun', meaning: LONG_MEANING, role: LONG_ROLE }
            });
        }
        return mock.jsonReply(route, mock.translatedParagraphReply(prompt));
    });

    await page.goto(BASE + '#a', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
        const modal = document.getElementById('app-modal');
        if (modal && !modal.classList.contains('hidden')) modal.querySelector('.modal-close-btn')?.click();
    });
    return { context, page, state, pageErrors };
}

async function openArticle(page, docs, id) {
    await mock.seedDocs(page, docs);
    // 文章清單現在只讀 article_summaries；測試直接寫 docs 後要重建摘要清單。
    // 初始載入可能與 seed 交錯，重試到清單真的看得到這篇。
    for (let attempt = 0; attempt < 6; attempt += 1) {
        const count = await page.evaluate(async (articleId) => {
            const store = await import('/modules/article-store.js');
            const list = await store.reloadScope();
            return list.filter((item) => item.articleId === articleId).length;
        }, id);
        if (count > 0) break;
        await page.waitForTimeout(300);
    }
    await page.evaluate(() => document.getElementById('article-history-btn').click());
    await page.waitForSelector(`.ar-history-item[data-key="${id}"] .ar-history-open`, { timeout: 15000 });
    // 小視窗（橫屏）下歷史列會被分組標題／底部列蓋住，Playwright 的 hit-test 會拒絕點擊；
    // 開文章不是本測試的對象，直接觸發列上的開啟按鈕。
    await page.evaluate((articleId) => {
        document.querySelector(`.ar-history-item[data-key="${articleId}"] .ar-history-open`)?.click();
    }, id);
    await page.waitForSelector(`.paragraph-pair[data-paragraph-index="0"]`, { timeout: 15000 });
}

const tInPage = (page, key, params) => page.evaluate(async ({ key, params }) => {
    const mod = await import('/modules/i18n.js');
    return mod.t(key, params);
}, { key, params });

const setLocale = (page, locale) => page.evaluate(async (loc) => {
    const mod = await import('/modules/i18n.js');
    mod.setLocale(loc);
}, locale);

const clickWord = (page, word) => page.evaluate((value) => {
    const el = Array.from(document.querySelectorAll('#article-analysis-container .paragraph-english .interactive-word'))
        .find((node) => node.getAttribute('data-word') === value);
    if (!el) throw new Error('word not found: ' + value);
    el.click();
}, word);

const tooltipState = (page) => page.evaluate(() => {
    const el = document.getElementById('word-analysis-tooltip');
    const close = el?.querySelector('.tooltip-close');
    const details = el?.querySelector('details.tooltip-more');
    const primary = el ? Array.from(el.querySelectorAll('.tooltip-primary-actions > button')) : [];
    const rect = el ? el.getBoundingClientRect() : null;
    return {
        display: el ? el.style.display : 'missing',
        sheet: !!el && el.classList.contains('tooltip-sheet'),
        text: el ? el.textContent.replace(/\s+/g, ' ').trim() : '',
        rect: rect ? { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, height: rect.height, width: rect.width } : null,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        overflowY: el ? getComputedStyle(el).overflowY : '',
        scrollHeight: el ? el.scrollHeight : 0,
        clientHeight: el ? el.clientHeight : 0,
        close: close ? {
            visible: close.getBoundingClientRect().width > 0 && close.getBoundingClientRect().height > 0,
            label: close.getAttribute('aria-label') || '',
            rect: (() => { const r = close.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; })()
        } : null,
        primaryCount: primary.length,
        detailsOpen: !!(details && details.open),
        hasPlay: !!el?.querySelector('.btn-play-word'),
        hasAdd: !!el?.querySelector('.btn-add-to-book'),
        hasMark: !!el?.querySelector('.btn-toggle-mark'),
        hasNote: !!el?.querySelector('details.tooltip-more .btn-note-item'),
        hasPick: !!el?.querySelector('details.tooltip-more .btn-pick-phrase'),
        hasAskAi: !!el?.querySelector('.tooltip-primary-actions > .btn-ask-word-ai'),
        hasOldPhraseActions: !!el?.querySelector('.btn-analyze-phrase, .btn-analyze-phrase-custom'),
        roleId: el ? el.getAttribute('role') : '',
        ariaModal: el ? el.getAttribute('aria-modal') : '',
        labelledBy: el ? el.getAttribute('aria-labelledby') : '',
        tabindex: el ? el.getAttribute('tabindex') : '',
        titleFocusable: !!el?.querySelector('#word-tooltip-title[tabindex="-1"]'),
        activeId: document.activeElement ? document.activeElement.id : '',
        activeClass: document.activeElement ? document.activeElement.className : '',
        contentLabels: el ? Array.from(el.querySelectorAll('.tooltip-content p strong')).map((n) => n.textContent.trim()) : []
    };
});

async function waitTooltip(page, { timeout = 15000 } = {}) {
    await page.waitForFunction(() => {
        const el = document.getElementById('word-analysis-tooltip');
        return el && el.style.display === 'block';
    }, null, { timeout });
}

(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: mock.CHROME });

    // ── 1. 視窗矩陣：長詳解不越界、可捲動、有可見關閉鈕 ──────────────
    console.log('\n[情境 1] 375×667／390×844／橫屏／200% 縮放');
    if (wanted('viewport')) {
    const viewports = [
        { name: '375×667', viewport: { width: 375, height: 667 }, zoomText: false },
        { name: '390×844', viewport: { width: 390, height: 844 }, zoomText: false },
        { name: '橫屏 667×375', viewport: { width: 667, height: 375 }, zoomText: false },
        { name: '375×667 + 200% 文字', viewport: { width: 375, height: 667 }, zoomText: true }
    ];
    for (const scenario of viewports) {
        const { context, page, pageErrors } = await makePage(browser, { viewport: scenario.viewport });
        if (scenario.zoomText) {
            await page.evaluate(() => { document.documentElement.style.fontSize = '32px'; });
        }
        await openArticle(page, [recordDoc('art_keyboard', BODY, ANALYSIS)], 'art_keyboard');
        await clickWord(page, 'reading');
        await waitTooltip(page);
        await page.waitForTimeout(250);
        const state = await tooltipState(page);
        const closeLabel = await tInPage(page, 'article.close');
        const withinX = state.rect && state.rect.left >= -1 && state.rect.right <= state.viewport.width + 1;
        const withinY = state.rect && state.rect.top >= -1 && state.rect.bottom <= state.viewport.height + 1;
        check(`${scenario.name}：詳解在視窗內`, !!withinX && !!withinY, JSON.stringify({ rect: state.rect, viewport: state.viewport }));
        check(`${scenario.name}：長內容可內捲`, state.scrollHeight > state.clientHeight && /auto|scroll/.test(state.overflowY), JSON.stringify({ scrollHeight: state.scrollHeight, clientHeight: state.clientHeight, overflowY: state.overflowY }));
        check(`${scenario.name}：關閉鈕可見且在視窗內`, !!state.close && state.close.visible && state.close.rect.bottom <= state.viewport.height + 1 && state.close.rect.top >= -1, JSON.stringify(state.close));
        check(`${scenario.name}：關閉鈕 aria-label 走翻譯`, state.close && state.close.label === closeLabel, JSON.stringify({ label: state.close && state.close.label, closeLabel }));
        check(`${scenario.name}：窄屏使用底部 sheet`, scenario.viewport.width <= 640 ? state.sheet : !state.sheet, String(state.sheet));
        const scrolled = await page.evaluate(() => {
            const el = document.getElementById('word-analysis-tooltip');
            el.scrollTop = 60;
            return el.scrollTop;
        });
        check(`${scenario.name}：面板內可實際捲動`, scrolled > 0, String(scrolled));
        check(`${scenario.name}：無頁面錯誤`, pageErrors.length === 0, pageErrors.join(' | '));
        await context.close();
    }
    }

    // ── 2. 資訊層級、主要操作與「更多」 ────────────────────────────
    console.log('\n[情境 2] 資訊層級與操作分層');
    if (wanted('hierarchy')) {
        const { context, page, pageErrors } = await makePage(browser);
        await openArticle(page, [recordDoc('art_keyboard', BODY, ANALYSIS)], 'art_keyboard');
        await clickWord(page, 'reading');
        await waitTooltip(page);
        await page.waitForTimeout(250);
        const state = await tooltipState(page);
        const meaningLabel = (await tInPage(page, 'article.meaningLabel')).replace(/[：:]\s*$/, '').trim();
        const roleLabel = (await tInPage(page, 'article.roleLabel')).replace(/[：:]\s*$/, '').trim();
        const order = state.contentLabels.map((label) => label.replace(/[：:]\s*$/, '').trim());
        check('意思是第一個內容層級', order[0] === meaningLabel, JSON.stringify(order));
        check('句中角色在意思之後', order.indexOf(roleLabel) > order.indexOf(meaningLabel), JSON.stringify(order));
        check('預設四個常用操作', state.primaryCount === 4, String(state.primaryCount));
        check('主要操作有發音／加入詞書／標記／AI', state.hasPlay && state.hasAdd && state.hasMark && state.hasAskAi, JSON.stringify(state));
        check('更多操作預設收起', state.detailsOpen === false, String(state.detailsOpen));
        check('更多內有筆記／選短語並移除舊分析入口', state.hasNote && state.hasPick && !state.hasOldPhraseActions, JSON.stringify(state));
        const moreLabel = await tInPage(page, 'article.moreActions');
        await page.click('#word-analysis-tooltip details.tooltip-more > summary');
        await page.waitForSelector('#word-analysis-tooltip .tooltip-more-body:popover-open', { state: 'visible' });
        const afterOpen = await tooltipState(page);
        const moreVisible = await page.evaluate(() => {
            const btn = document.querySelector('#word-analysis-tooltip details.tooltip-more .btn-note-item');
            return !!btn && btn.getBoundingClientRect().height > 0;
        });
        check('更多操作可展開', afterOpen.detailsOpen === true, String(afterOpen.detailsOpen));
        check('展開後筆記按鈕可見', moreVisible, String(moreVisible));
        check('更多圖示有完整翻譯標籤', await page.getAttribute('#word-analysis-tooltip details.tooltip-more > summary', 'aria-label') === moreLabel);
        await page.keyboard.press('ArrowDown');
        check('更多選單方向鍵可移到選短語', await page.locator('#word-analysis-tooltip .btn-pick-phrase').evaluate((el) => el === document.activeElement));
        await page.keyboard.press('ArrowUp');
        check('更多選單方向鍵可回到寫筆記', await page.locator('#word-analysis-tooltip .btn-note-item').evaluate((el) => el === document.activeElement));
        await page.keyboard.press('Escape');
        const afterMenuEscape = await tooltipState(page);
        check('Escape 只收選單並聚焦省略號', afterMenuEscape.display === 'block' && !afterMenuEscape.detailsOpen
            && await page.locator('#word-analysis-tooltip .tooltip-more > summary').evaluate((el) => el === document.activeElement));
        await page.keyboard.press('Enter');
        await page.waitForSelector('#word-analysis-tooltip .tooltip-more-body:popover-open', { state: 'visible' });
        await page.click('#word-tooltip-title');
        check('點擊詞卡內其他區域收選單並保留詞卡', !(await tooltipState(page)).detailsOpen && (await tooltipState(page)).display === 'block');
        await page.click('#word-analysis-tooltip .btn-toggle-mark svg');
        await page.waitForSelector('#word-analysis-tooltip .btn-toggle-mark[aria-pressed="true"]');
        check('標記後保留圖示及完整取消標記標籤', await page.locator('#word-analysis-tooltip .btn-toggle-mark svg').count() === 1
            && await page.getAttribute('#word-analysis-tooltip .btn-toggle-mark', 'aria-label') === await tInPage(page, 'article.unmarkThis'));
        await page.click('#word-analysis-tooltip .btn-toggle-mark');
        await page.waitForSelector('#word-analysis-tooltip .btn-toggle-mark[aria-pressed="false"]');
        check('取消標記後保留圖示及完整標籤', await page.locator('#word-analysis-tooltip .btn-toggle-mark svg').count() === 1
            && await page.getAttribute('#word-analysis-tooltip .btn-toggle-mark', 'aria-label') === await tInPage(page, 'article.markThis'));
        check('詳解具 dialog 語義但不鎖背景', state.roleId === 'dialog' && state.ariaModal === 'false' && state.labelledBy === 'word-tooltip-title' && state.tabindex === '-1', JSON.stringify({ role: state.roleId, modal: state.ariaModal, labelledBy: state.labelledBy, tabindex: state.tabindex }));
        check('標題可程式聚焦', state.titleFocusable, String(state.titleFocusable));
        const analyzeBtn = await page.evaluate(() => {
            const btn = document.querySelector('#article-analysis-container .sent-analyze-btn.icon-only');
            if (!btn) return null;
            const after = getComputedStyle(btn, '::after');
            return { w: parseFloat(after.width), h: parseFloat(after.height), opacity: parseFloat(getComputedStyle(btn).opacity) };
        });
        check('句末解析鍵點擊區 ≥28×28', !!analyzeBtn && analyzeBtn.w >= 28 && analyzeBtn.h >= 28, JSON.stringify(analyzeBtn));
        check('句末解析鍵預設可見度 0.55', !!analyzeBtn && Math.abs(analyzeBtn.opacity - 0.55) < 0.02, JSON.stringify(analyzeBtn));
        // 外部點擊仍由 ui.initTooltip 收起，article 同步清 session（之後晚到的回應不得重開）。
        await page.click('#article-input');
        await page.waitForTimeout(150);
        const outside = await tooltipState(page);
        check('外部點擊收起詳解', outside.display === 'none', outside.display);
        check('無頁面錯誤', pageErrors.length === 0, pageErrors.join(' | '));
        await context.close();
    }

    // ── 2b. 觸控裝置的句解析鍵點擊區 ──────────────────────────────
    console.log('\n[情境 2b] 觸控點擊區');
    if (wanted('touch')) {
        const { context, page } = await makePage(browser, { viewport: { width: 375, height: 667 }, hasTouch: true });
        await openArticle(page, [recordDoc('art_keyboard', BODY, ANALYSIS)], 'art_keyboard');
        const size = await page.evaluate(() => {
            const btn = document.querySelector('#article-analysis-container .sent-analyze-btn.icon-only');
            if (!btn) return null;
            const after = getComputedStyle(btn, '::after');
            return { w: parseFloat(after.width), h: parseFloat(after.height), coarse: matchMedia('(pointer: coarse)').matches };
        });
        check('觸控裝置句解析鍵點擊區 ≥32×32', !!size && size.w >= 32 && size.h >= 32, JSON.stringify(size));
        check('觸控媒體查詢生效', !!size && size.coarse === true, JSON.stringify(size));
        await context.close();
    }

    // ── 3. 載入中仍可發音／加入詞書／關閉 ─────────────────────────
    console.log('\n[情境 3] 載入中操作');
    if (wanted('loading')) {
        const { context, page, state: mockState, pageErrors } = await makePage(browser);
        await openArticle(page, [recordDoc('art_keyboard', BODY, ANALYSIS)], 'art_keyboard');
        mockState.wordDelay = 2500;
        await clickWord(page, 'room');
        await waitTooltip(page, { timeout: 3000 });
        const loading = await tooltipState(page);
        const loadingLabel = await tInPage(page, 'article.loading');
        check('載入中顯示載入文字', loading.text.includes(loadingLabel), loading.text.slice(0, 120));
        check('載入中保留發音／加入詞書／標記／關閉', loading.hasPlay && loading.hasAdd && loading.hasMark && !!loading.close, JSON.stringify({ play: loading.hasPlay, add: loading.hasAdd, mark: loading.hasMark, close: !!loading.close }));
        await page.click('#word-analysis-tooltip .btn-play-word');
        await page.waitForTimeout(600);
        const spoken = await page.evaluate(() => window.__spoken.slice());
        check('載入中按發音有聲音', spoken.some((text) => text.toLowerCase() === 'room'), JSON.stringify(spoken));
        const originalAdd = await page.textContent('#word-analysis-tooltip .btn-add-to-book');
        await page.click('#word-analysis-tooltip .btn-add-to-book');
        await page.waitForTimeout(700);
        const addFeedback = await page.evaluate(async () => {
            const btn = document.querySelector('#word-analysis-tooltip .btn-add-to-book');
            const mod = await import('/modules/i18n.js');
            return {
                text: btn ? btn.textContent.trim() : '',
                busy: btn ? btn.getAttribute('aria-busy') : '',
                toasts: Array.from(document.querySelectorAll('.message-toast__text')).map((el) => el.textContent.trim()),
                added: mod.t('qa.added'),
                exists: mod.t('qa.exists'),
                failed: mod.t('qa.failed')
            };
        });
        const hasFeedback = addFeedback.text !== originalAdd
            || addFeedback.busy === 'true'
            || addFeedback.toasts.length > 0
            || [addFeedback.added, addFeedback.exists, addFeedback.failed].includes(addFeedback.text);
        check('載入中按加入詞書有回饋', hasFeedback, JSON.stringify(addFeedback));
        check('加入詞書回饋保留圖示', await page.locator('#word-analysis-tooltip .btn-add-to-book svg').count() === 1);
        await page.click('#word-analysis-tooltip .tooltip-close');
        await page.waitForTimeout(120);
        const closed = await tooltipState(page);
        check('載入中按關閉立即收起', closed.display === 'none', closed.display);
        // 關閉後才回來的詳解不得把面板重新打開。
        await page.waitForTimeout(2800);
        const late = await tooltipState(page);
        check('關閉後晚到的回應不會重開詳解', late.display === 'none', late.display);
        check('無頁面錯誤', pageErrors.length === 0, pageErrors.join(' | '));
        await context.close();
    }

    // ── 4. 純鍵盤：開句卡 → 逐詞 → 查詞 → 關閉 → 回句 ──────────────
    console.log('\n[情境 4] 純鍵盤流程');
    if (wanted('keyboard')) {
        const { context, page, pageErrors } = await makePage(browser);
        await openArticle(page, [recordDoc('art_keyboard', BODY, ANALYSIS)], 'art_keyboard');
        const wordModeLabel = await tInPage(page, 'article.wordMode');
        const wordModeHint = await tInPage(page, 'article.wordModeHint');
        const sentenceLabel = await tInPage(page, 'article.sentenceAnalysis');

        await page.evaluate(() => {
            const sentence = document.querySelector('#article-analysis-container .interactive-sentence');
            sentence.focus();
        });
        const sentenceAttrs = await page.evaluate(() => {
            const el = document.activeElement;
            return {
                tag: el.tagName,
                role: el.getAttribute('role'),
                tabindex: el.getAttribute('tabindex'),
                expanded: el.getAttribute('aria-expanded'),
                label: el.getAttribute('aria-label') || '',
                wordTabindex: Array.from(el.querySelectorAll('.interactive-word')).map((w) => w.getAttribute('tabindex'))
            };
        });
        check('句子可聚焦且是 button 語義', sentenceAttrs.tag === 'SPAN' && sentenceAttrs.role === 'button' && sentenceAttrs.tabindex === '0', JSON.stringify(sentenceAttrs));
        check('句子 aria-expanded 初始為 false', sentenceAttrs.expanded === 'false', String(sentenceAttrs.expanded));
        check('句子 aria-label 含句首片段與句子解析', sentenceAttrs.label.includes('The reading room') && sentenceAttrs.label.includes(sentenceLabel), sentenceAttrs.label);
        check('未進逐詞模式時詞不可 Tab', sentenceAttrs.wordTabindex.every((value) => value === null), JSON.stringify(sentenceAttrs.wordTabindex));

        await page.keyboard.press('Enter');
        await page.waitForSelector('#app-modal:not(.hidden) .sentence-card', { timeout: 15000 });
        const opened = await page.evaluate(() => ({
            expanded: document.querySelector('#article-analysis-container .interactive-sentence').getAttribute('aria-expanded'),
            activeClass: document.activeElement.className,
            activeText: document.activeElement.textContent.trim(),
            modalHidden: document.getElementById('app-modal').classList.contains('hidden')
        }));
        check('Enter 開啟句卡並更新 aria-expanded', opened.expanded === 'true' && !opened.modalHidden, JSON.stringify(opened));
        await page.waitForFunction(() => document.activeElement && document.activeElement.classList.contains('sent-word-mode'), null, { timeout: 15000 }).catch(() => {});
        const focusedAfterOpen = await page.evaluate(() => ({ cls: document.activeElement.className, text: document.activeElement.textContent.trim() }));
        check('鍵盤開卡後焦點在卡片第一個操作（逐詞檢視）', focusedAfterOpen.cls.includes('sent-word-mode') && focusedAfterOpen.text === wordModeLabel, JSON.stringify(focusedAfterOpen));

        await page.keyboard.press('Enter');
        await page.waitForTimeout(200);
        const wordMode = await page.evaluate(() => {
            const sentence = document.querySelector('#article-analysis-container .interactive-sentence');
            const words = Array.from(sentence.querySelectorAll('.interactive-word'));
            const hint = sentence.parentElement.querySelector('.word-mode-hint');
            return {
                modalHidden: document.getElementById('app-modal').classList.contains('hidden'),
                expanded: sentence.getAttribute('aria-expanded'),
                tabindex: words.map((w) => w.getAttribute('tabindex')),
                hint: hint ? hint.textContent.trim() : '',
                activeWord: document.activeElement.getAttribute && document.activeElement.getAttribute('data-word'),
                activeClass: document.activeElement.className
            };
        });
        check('逐詞檢視收起句卡並更新 aria-expanded', wordMode.modalHidden === true && wordMode.expanded === 'false', JSON.stringify({ modal: wordMode.modalHidden, expanded: wordMode.expanded }));
        check('逐詞模式只讓本句詞可 Tab', wordMode.tabindex.length > 1 && wordMode.tabindex.every((value) => value === '0'), JSON.stringify(wordMode.tabindex));
        check('焦點在句子的第一個詞', wordMode.activeClass.includes('interactive-word'), JSON.stringify({ cls: wordMode.activeClass, word: wordMode.activeWord }));
        check('顯示逐詞提示', wordMode.hint === wordModeHint, JSON.stringify({ hint: wordMode.hint, expected: wordModeHint }));

        const firstWord = wordMode.activeWord;
        await page.keyboard.press('ArrowRight');
        const secondWord = await page.evaluate(() => document.activeElement.getAttribute('data-word'));
        check('左右方向鍵在詞間移動', !!secondWord && secondWord !== firstWord, JSON.stringify({ firstWord, secondWord }));

        await page.keyboard.press('Enter');
        await waitTooltip(page);
        await page.waitForTimeout(250);
        const tooltip = await tooltipState(page);
        check('Enter 在逐詞模式開啟詳解', tooltip.display === 'block', tooltip.display);
        check('鍵盤開啟時焦點在詳解標題', tooltip.activeId === 'word-tooltip-title', JSON.stringify({ activeId: tooltip.activeId, activeClass: tooltip.activeClass }));

        await page.keyboard.press('Escape');
        await page.waitForTimeout(150);
        const afterEscape = await page.evaluate(() => ({
            display: document.getElementById('word-analysis-tooltip').style.display,
            word: document.activeElement.getAttribute && document.activeElement.getAttribute('data-word'),
            cls: document.activeElement.className,
            isWord: document.activeElement.classList.contains('interactive-word')
        }));
        check('Escape 關閉詳解', afterEscape.display === 'none', afterEscape.display);
        check('Escape 後焦點回到原詞', afterEscape.isWord && afterEscape.word === secondWord, JSON.stringify(afterEscape));

        await page.keyboard.press('Escape');
        await page.waitForTimeout(150);
        const afterWordMode = await page.evaluate(() => {
            const sentence = document.querySelector('#article-analysis-container .interactive-sentence');
            const words = Array.from(sentence.querySelectorAll('.interactive-word'));
            return {
                tabindex: words.map((w) => w.getAttribute('tabindex')),
                hint: !!sentence.parentElement.querySelector('.word-mode-hint'),
                focusedSentence: document.activeElement === sentence,
                expanded: sentence.getAttribute('aria-expanded')
            };
        });
        check('Escape 離開逐詞模式並清除 tabindex', afterWordMode.tabindex.every((value) => value === null), JSON.stringify(afterWordMode.tabindex));
        check('Escape 離開逐詞模式後焦點回句子', afterWordMode.focusedSentence, JSON.stringify(afterWordMode));
        check('逐詞提示已移除', afterWordMode.hint === false, String(afterWordMode.hint));

        await page.keyboard.press('Enter');
        await page.waitForSelector('#app-modal:not(.hidden) .sentence-card', { timeout: 15000 });
        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);
        const closedByEscape = await page.evaluate(() => {
            const sentence = document.querySelector('#article-analysis-container .interactive-sentence');
            return {
                modalHidden: document.getElementById('app-modal').classList.contains('hidden'),
                expanded: sentence.getAttribute('aria-expanded'),
                focusedSentence: document.activeElement === sentence,
                tabindexes: Array.from(sentence.querySelectorAll('.interactive-word')).map((w) => w.getAttribute('tabindex'))
            };
        });
        check('Escape 收起句卡', closedByEscape.modalHidden === true, JSON.stringify(closedByEscape));
        check('句卡關閉後 aria-expanded 還原', closedByEscape.expanded === 'false', String(closedByEscape.expanded));
        check('句卡關閉後焦點回句子', closedByEscape.focusedSentence, JSON.stringify(closedByEscape));
        check('句卡關閉後詞的 tabindex 清除', closedByEscape.tabindexes.every((value) => value === null), JSON.stringify(closedByEscape.tabindexes));
        check('無頁面錯誤', pageErrors.length === 0, pageErrors.join(' | '));
        await context.close();
    }

    // ── 5. 100 段 Tab 不逐詞停留 ──────────────────────────────────
    console.log('\n[情境 5] 100 段 Tab 順序');
    if (wanted('tab')) {
        const { context, page, pageErrors } = await makePage(browser);
        await openArticle(page, [recordDoc('art_hundred', HUNDRED_BODY, HUNDRED_ANALYSIS)], 'art_hundred');
        const sentenceCount = await page.evaluate(() => document.querySelectorAll('#article-analysis-container .interactive-sentence').length);
        check('100 段文章已渲染', sentenceCount === 100, String(sentenceCount));
        await page.focus('#article-input');
        const visited = [];
        for (let i = 0; i < 100; i += 1) {
            await page.keyboard.press('Tab');
            visited.push(await page.evaluate(() => ({
                tag: document.activeElement?.tagName || '',
                cls: document.activeElement?.className || '',
                word: document.activeElement?.getAttribute?.('data-word') || ''
            })));
        }
        const wordStops = visited.filter((item) => /(^|\s)interactive-word(\s|$)/.test(item.cls));
        const sentenceStops = visited.filter((item) => /(^|\s)interactive-sentence(\s|$)/.test(item.cls));
        check('Tab 不會逐詞停留', wordStops.length === 0, JSON.stringify(wordStops.slice(0, 5)));
        check('Tab 仍可停在句子', sentenceStops.length > 0, JSON.stringify({ sentenceStops: sentenceStops.length, sample: visited.slice(0, 8) }));
        check('無頁面錯誤', pageErrors.length === 0, pageErrors.join(' | '));
        await context.close();
    }

    // ── 6. zh-CN／zh-HK 各一次（含 locale 重畫與觸發詞移除） ──────
    console.log('\n[情境 6] zh-CN／zh-HK');
    if (wanted('locale')) for (const locale of ['zh-CN', 'zh-HK']) {
        const { context, page, pageErrors } = await makePage(browser, { locale });
        await openArticle(page, [recordDoc('art_keyboard', BODY, ANALYSIS)], 'art_keyboard');
        await clickWord(page, 'reading');
        await waitTooltip(page);
        await page.waitForTimeout(200);
        const state = await tooltipState(page);
        const moreLabel = await tInPage(page, 'article.moreActions');
        const wordModeLabel = await tInPage(page, 'article.wordMode');
        const wordModeHint = await tInPage(page, 'article.wordModeHint');
        const localized = await page.evaluate(() => ({
            meaning: document.querySelector('#word-analysis-tooltip .tooltip-content p strong')?.textContent.trim() || '',
            more: document.querySelector('#word-analysis-tooltip details.tooltip-more > summary')?.getAttribute('aria-label') || ''
        }));
        check(`${locale}：詳解文案使用目前語言`, localized.more === moreLabel && state.text.includes(localized.meaning), JSON.stringify(localized));
        check(`${locale}：逐詞鍵文案`, wordModeLabel === (locale === 'zh-CN' ? '逐词检视' : '逐詞檢視'), wordModeLabel);
        check(`${locale}：逐詞提示文案`, wordModeHint === (locale === 'zh-CN' ? '用方向键选词，Enter 查看详解，Esc 返回句子' : '用方向鍵選詞，Enter 查看詳解，Esc 返回句子'), wordModeHint);

        // 切換語言時，可見中的詳解要用新語言重畫，且不關閉。
        const otherLocale = locale === 'zh-CN' ? 'zh-HK' : 'zh-CN';
        await setLocale(page, otherLocale);
        await page.waitForTimeout(300);
        const rerendered = await tooltipState(page);
        const otherMore = await tInPage(page, 'article.moreActions');
        const rerenderedMore = await page.getAttribute('#word-analysis-tooltip details.tooltip-more > summary', 'aria-label').catch(() => '');
        check(`${locale}→${otherLocale}：詳解可見時切語言會重畫`, rerendered.display === 'block' && rerenderedMore.trim() === otherMore, JSON.stringify({ display: rerendered.display, rerenderedMore, otherMore }));
        await setLocale(page, locale);
        await page.waitForTimeout(200);

        // 觸發詞被重畫移除後，locale 變更必須關閉詳解並清除狀態。
        await page.evaluate(() => {
            const word = document.querySelector('#article-analysis-container .paragraph-english .interactive-word[data-word="reading"]');
            if (word) word.remove();
        });
        await setLocale(page, otherLocale);
        await page.waitForTimeout(300);
        const afterRemoved = await tooltipState(page);
        check(`${locale}：觸發詞不在 DOM 時切語言會關閉詳解`, afterRemoved.display === 'none', afterRemoved.display);
        check(`${locale}：無頁面錯誤`, pageErrors.length === 0, pageErrors.join(' | '));
        await context.close();
    }

    await browser.close();
    process.exitCode = finish() ? 1 : 0;
})().catch(async (error) => {
    console.error(error);
    process.exitCode = 1;
    process.exit(1);
});
