/**
 * 獨立複查（非重跑全站審查）：只針對 F1/F2/F3/F5 修正與「英文一般/循環不受影響」。
 * 自建 fixture（含中文原文段、重複句、長頁面）與 mock speech；外部請求一律 abort 並計數。
 * 用法：
 *   PORT=8326 ARTIFACT_DIR=<dir> PLAYWRIGHT_MODULE=<path> node recheck-fixes.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const BASE = String(process.env.BASE_URL || `http://127.0.0.1:${process.env.PORT || 8326}`).replace(/\/+$/, '');
const OUT = process.env.ARTIFACT_DIR || path.join(__dirname);
fs.mkdirSync(OUT, { recursive: true });

const results = [];
let failures = 0;
function check(name, ok, detail) {
    results.push({ name, ok: !!ok, detail });
    if (!ok) failures += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name} :: ${detail === undefined ? '' : JSON.stringify(detail)}`);
}
function info(name, detail) {
    results.push({ name, ok: null, detail });
    console.log(`INFO ${name} :: ${detail === undefined ? '' : JSON.stringify(detail)}`);
}

// 合成文章：英文段 / 中文原文段 / 英文段（含重複句）/ 較長頁面（可捲動）
const EN = {
    p0: ['The reading room opens at eight.', 'Visitors sign the book at the door.'],
    p2: ['Morning light falls across the long wooden table.', 'Two students copy new words into their notebooks.'],
    p3: ['The reading room opens at eight.'],
    p4: ['A final sentence closes the article.']
};
const ZH_SOURCE = '这是一段中文原文，用来检查英文朗读功能的可用性。';
const filler = Array.from({ length: 7 }, (_, i) => [
    `Paragraph ${i + 1} keeps the page long enough to scroll.`,
    `Another line follows here for paragraph ${i + 1}.`
]);
const paragraphs = [
    EN.p0.join(' '), ZH_SOURCE, EN.p2.join(' '), EN.p3[0], EN.p4[0],
    ...filler.map((lines) => lines.join(' '))
];
const BODY = paragraphs.join('\n\n');
const analysis = paragraphs.map((text, index) => {
    const chinese = index === 1 ? text : '合成译文，仅供测试。';
    const sentences = index === 1 ? [{ en: text, zh: text }] : text.match(/[^.!?]+[.!?]*/g).map((en) => ({ en: en.trim(), zh: '合成译文。' }));
    return { chinese_translation: chinese, word_alignment: [], detailed_analysis: [], sentences };
});

async function setup(browser, locale, width = 1280, mobile = false) {
    const context = await browser.newContext({ viewport: { width, height: mobile ? 844 : 900 }, isMobile: mobile, hasTouch: mobile });
    const external = [];
    await context.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === '/ai-config.js') return route.fulfill({
            contentType: 'application/javascript',
            body: 'export const SYNC={endpoint:""}; export const TTS_CONFIG={}, AI_LIMITS={}, OCR_CONFIG={}, ARTICLE_IMPORT={}, SUPABASE={};'
        });
        if (url.origin !== BASE) {
            external.push(url.href);
            return route.abort();
        }
        return route.continue();
    });
    await context.addInitScript((locale) => {
        localStorage.setItem('pen_global_settings', JSON.stringify({ language: { interfaceLocale: locale } }));
        const speech = window.__speech = { calls: [], current: null };
        speech.finish = () => { const cur = speech.current; speech.current = null; cur?.onend?.(); };
        Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: class { constructor(text) { this.text = text; } } });
        Object.defineProperty(window, 'speechSynthesis', { value: {
            getVoices: () => [{ lang: 'en-US', name: 'Recheck English', voiceURI: 'recheck' }],
            addEventListener() {}, removeEventListener() {}, cancel() { speech.current = null; },
            speak(utterance) {
                speech.current = utterance;
                speech.calls.push({ text: utterance.text, at: Date.now(), rate: utterance.rate });
                queueMicrotask(() => utterance.onstart?.());
            }
        } });
    }, locale);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const booted = page.waitForEvent('console', { predicate: (m) => m.text().startsWith('应用程序已') });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await booted;
    await page.waitForFunction(() => !!document.getElementById('article-btn'));
    await page.evaluate(async ({ body, analysis }) => {
        const articles = await import('/modules/article-store.js');
        const reading = await import('/modules/reading-store.js');
        await articles.initArticleStore();
        await reading.initReadingStore();
        const saved = await articles.saveArticle({
            articleId: 'art_recheck_fixture', article: body, title: 'Recheck fixture', sourceType: 'paste',
            result: {
                chinese_translation: '合成译文。', word_alignment: [], detailed_analysis: [],
                paragraph_analysis: analysis, sentence_analysis: [], phrase_analysis: []
            }
        });
        if (!saved.ok) throw new Error(saved.error);
        document.querySelector('#app-modal .modal-close-btn')?.click();
        document.getElementById('article-btn').click();
        (await import('/modules/state.js')).setCurrentArticleId('art_recheck_fixture');
        await (await import('/features/article/article.js')).showCurrentArticleIfAvailable();
    }, { body: BODY, analysis });
    await page.waitForSelector('.sent-analyze-btn');
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
    return { page, context, errors, external };
}

const count = (page) => page.evaluate(() => window.__speech.calls.length);
const finish = (page) => page.evaluate(() => window.__speech.finish());
const last = (page) => page.evaluate(() => window.__speech.calls.at(-1)?.text);
const waitCount = (page, expected) => page.waitForFunction((n) => window.__speech.calls.length === n, expected);
async function shot(page, name) {
    await page.screenshot({ path: path.join(OUT, name) });
}
async function openMenu(page, index) {
    const trigger = page.locator('.sent-analyze-btn').nth(index);
    await trigger.scrollIntoViewIfNeeded();
    await trigger.click();
    await page.waitForTimeout(80);
    return trigger;
}
const zhTriggerIndex = async (page) => page.evaluate(() =>
    [...document.querySelectorAll('.sent-analyze-btn')].findIndex((btn) => btn.closest('.paragraph-pair')?.dataset.sourceLanguage === 'zh'));

// ---------- F1：中文原文段落 ----------
async function f1(browser, locale, width, mobile) {
    const tag = `F1 ${mobile ? `mobile ${width}` : 'desktop'} ${locale}`;
    const { page, context, errors, external } = await setup(browser, locale, width, mobile);
    try {
        const idx = await zhTriggerIndex(page);
        check(`${tag} fixture has Chinese-source paragraph`, idx >= 0, { zhTriggerIndex: idx });
        const trigger = page.locator('.sent-analyze-btn').nth(idx);
        await trigger.scrollIntoViewIfNeeded();
        if (mobile) await trigger.tap(); else await trigger.click();
        await page.waitForTimeout(120);
        const state = await page.evaluate(() => {
            const menu = document.getElementById('article-sentence-menu');
            const hint = menu.querySelector('.article-sentence-menu-hint');
            const byAction = {};
            menu.querySelectorAll('[data-sentence-action]').forEach((b) => {
                byAction[b.dataset.sentenceAction] = { disabled: b.disabled, text: b.querySelector('span').textContent, title: b.title };
            });
            const box = menu.getBoundingClientRect();
            return {
                hidden: menu.classList.contains('hidden'),
                byAction,
                hintVisible: !!hint && !hint.classList.contains('hidden') && hint.getBoundingClientRect().height > 0,
                hintText: hint?.textContent || '',
                box: { x: box.x, y: box.y, w: box.width, h: box.height },
                viewport: { w: innerWidth, h: innerHeight },
                overflowX: document.documentElement.scrollWidth > innerWidth,
                ariaExpanded: document.querySelectorAll('.sent-analyze-btn')[0]?.getAttribute('aria-expanded')
            };
        });
        const expectHint = await page.evaluate(async () => (await import('/modules/i18n.js')).t('article.englishSentenceOnly'));
        check(`${tag} menu opens on Chinese-source sentence`, !state.hidden, { box: state.box });
        check(`${tag} three reading actions disabled`, ['once', 'continue', 'loop'].every((m) => state.byAction[m].disabled), state.byAction);
        check(`${tag} analyze stays enabled`, state.byAction.analyze.disabled === false, state.byAction.analyze);
        check(`${tag} visible bilingual hint equals englishSentenceOnly`, state.hintVisible && state.hintText === expectHint, { hintText: state.hintText, expectHint });
        check(`${tag} disabled items carry the same reason title`, ['once', 'continue', 'loop'].every((m) => state.byAction[m].title === expectHint), state.byAction.once.title);
        check(`${tag} menu fits viewport / no horizontal overflow`, state.box.x >= 0 && state.box.x + state.box.w <= state.viewport.w + 0.5 && state.box.y >= 0 && state.box.y + state.box.h <= state.viewport.h + 0.5 && !state.overflowX, { box: state.box, viewport: state.viewport });
        await shot(page, `${mobile ? `m${width}` : 'desktop'}-${locale}-chinese-source-menu.png`);

        // disabled 的朗讀項即使被強制點擊也不得靜默或出聲（不把 disabled click timeout 當失敗）
        const before = await count(page);
        await page.locator('#article-sentence-menu [data-sentence-action="once"]').click({ force: true }).catch(() => {});
        await page.waitForTimeout(250);
        check(`${tag} forced click on disabled read makes no speech`, (await count(page)) === before, { before, after: await count(page) });
        info(`${tag} menu still open after forced click`, await page.evaluate(() => !document.getElementById('article-sentence-menu').classList.contains('hidden')));
        await page.keyboard.press('Escape');

        // 解析仍可用（不點擊，僅確認可聚焦/可命中，避免真的發 AI 請求）
        check(`${tag} analyze item clickable (enabled & focusable)`, await page.evaluate(() => {
            const b = document.querySelector('#article-sentence-menu [data-sentence-action="analyze"]');
            return !b.disabled && b.tabIndex >= 0;
        }));

        // 桌機懸停捷徑不得出現
        if (!mobile) {
            await trigger.hover();
            await page.waitForTimeout(300);
            check(`${tag} hover quick-read hidden on Chinese-source`, await page.locator('#article-sentence-quick-read').isVisible() === false,
                await page.locator('#article-sentence-quick-read').getAttribute('class'));
        }

        // 版本過期（stale）路徑不得退化：讀取 disabled + stale 原因，解析仍可用
        if (!mobile && locale === 'zh-CN') {
            await page.evaluate(() => {
                const input = document.getElementById('article-input');
                input.value = input.value + '\n\nStale marker paragraph.';
            });
            await page.locator('.sent-analyze-btn').nth(0).click();
            await page.waitForTimeout(150);
            const stale = await page.evaluate(async () => {
                const menu = document.getElementById('article-sentence-menu');
                const expire = {};
                menu.querySelectorAll('[data-sentence-action]').forEach((b) => { expire[b.dataset.sentenceAction] = b.disabled; });
                return {
                    expire,
                    hint: menu.querySelector('.article-sentence-menu-hint').textContent,
                    expected: (await import('/modules/i18n.js')).t('article.staleSentenceCard'),
                    hintVisible: !menu.querySelector('.article-sentence-menu-hint').classList.contains('hidden')
                };
            });
            check(`${tag} stale view disables reading with stale reason`, stale.expire.once && stale.expire.continue && stale.expire.loop && stale.hintVisible && stale.hint === stale.expected && stale.expire.analyze === false, stale);
            await page.keyboard.press('Escape');
            await page.evaluate(() => {
                const input = document.getElementById('article-input');
                input.value = input.value.replace(/\n\nStale marker paragraph\.$/, '');
            });
        }

        // 英文段不受影響
        const enState = await page.evaluate(() => {
            const btn = [...document.querySelectorAll('.sent-analyze-btn')].find((b) => b.closest('.paragraph-pair')?.dataset.sourceLanguage !== 'zh');
            btn.click();
            return null;
        }).then(() => page.evaluate(() => {
            const menu = document.getElementById('article-sentence-menu');
            const out = {};
            menu.querySelectorAll('[data-sentence-action]').forEach((b) => { out[b.dataset.sentenceAction] = b.disabled; });
            return { out, hintVisible: !menu.querySelector('.article-sentence-menu-hint').classList.contains('hidden') };
        }));
        check(`${tag} English sentence keeps reading actions enabled`, ['once', 'continue', 'loop'].every((m) => enState.out[m] === false) && enState.hintVisible === false, enState);
        await page.keyboard.press('Escape');
        check(`${tag} zero external requests`, external.length === 0, external.slice(0, 3));
        check(`${tag} no page errors`, errors.length === 0, errors);
        info(`${tag} zh trigger index`, idx);
    } finally { await context.close(); }
}

// ---------- F2：菜單在可見錨點捲動後保持可點，離屏才收 ----------
async function f2(browser) {
    const tag = 'F2 desktop zh-CN';
    const { page, context, errors } = await setup(browser, 'zh-CN', 1280, false);
    try {
        const idx = await page.evaluate(() => [...document.querySelectorAll('.sent-analyze-btn')]
            .findIndex((b) => b.closest('.paragraph-pair')?.dataset.sourceLanguage !== 'zh'));
        await openMenu(page, idx);
        const before = await page.evaluate(() => {
            const menu = document.getElementById('article-sentence-menu');
            const trigger = [...document.querySelectorAll('.sent-analyze-btn')][0];
            return null;
        });
        const geometry = (n) => page.evaluate((n) => {
            const menu = document.getElementById('article-sentence-menu');
            const trigger = [...document.querySelectorAll('.sent-analyze-btn')][n];
            const m = menu.getBoundingClientRect();
            const tRect = trigger.getBoundingClientRect();
            return {
                hidden: menu.classList.contains('hidden'),
                menu: { top: m.top, bottom: m.bottom, left: m.left, right: m.right },
                trigger: { top: tRect.top, bottom: tRect.bottom, left: tRect.left, right: tRect.right },
                gapBelow: m.top - tRect.bottom,
                gapAbove: tRect.top - m.bottom,
                scrollY
            };
        }, n);

        // 1px 合成 scroll 事件（原缺陷：任何 scroll 立即收）
        await page.evaluate(() => { window.scrollBy(0, 1); window.dispatchEvent(new Event('scroll')); });
        await page.waitForTimeout(120);
        let g = await geometry(idx);
        check(`${tag} 1px scroll keeps menu open`, !g.hidden, g);

        // 真實捲動：錨點仍在視窗內 → 保持開啟且貼齊錨點
        await page.mouse.move(640, 400);
        await page.mouse.wheel(0, 120);
        await page.waitForTimeout(250);
        g = await geometry(idx);
        const anchored = g.hidden ? false : (Math.abs(g.gapBelow - 8) <= 2 || Math.abs(g.gapAbove - 8) <= 2);
        check(`${tag} in-view scroll keeps menu open and anchored`, !g.hidden && anchored, g);
        check(`${tag} anchor still in viewport`, g.trigger.top >= 0 && g.trigger.bottom <= 900, g.trigger);

        // 應用自身平滑自捲（朗讀時 scrollIntoView smooth）也不得關閉菜單
        await page.evaluate(() => window.scrollBy({ top: 150, behavior: 'smooth' }));
        await page.waitForTimeout(600);
        g = await geometry(idx);
        check(`${tag} smooth auto-scroll keeps menu open`, !g.hidden, g);
        await shot(page, 'desktop-zh-CN-menu-after-scroll.png');

        // 捲動後仍可實際操作：點「朗讀本句」要發出該句
        const expect = await page.evaluate((n) => [...document.querySelectorAll('.sent-analyze-btn')][n].closest('.sentence-wrap').querySelector('.interactive-sentence').textContent.trim(), idx);
        await page.locator('#article-sentence-menu [data-sentence-action="once"]').click();
        await waitCount(page, 1);
        check(`${tag} menu remains clickable after scroll`, (await last(page)) === expect, { spoke: await last(page), expect });
        await finish(page);
        await page.waitForTimeout(650);
        check(`${tag} once stops after one utterance`, (await count(page)) === 1, { calls: await count(page) });

        // 離屏 → 收起（把錨點捲出視窗上方）
        await openMenu(page, idx);
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await page.waitForTimeout(350);
        g = await geometry(idx);
        const expanded = await page.evaluate((n) => [...document.querySelectorAll('.sent-analyze-btn')][n].getAttribute('aria-expanded'), idx);
        check(`${tag} anchor really off-screen before asserting`, g.trigger.bottom <= 0 || g.trigger.top >= 900, g.trigger);
        check(`${tag} off-screen anchor closes menu`, g.hidden && expanded === 'false', { hidden: g.hidden, expanded, trigger: g.trigger, scrollY: g.scrollY });

        // 錨點仍在但被移除（重繪）→ 收起
        await page.evaluate((n) => { window.scrollTo(0, 0); }, idx);
        await page.waitForTimeout(200);
        await openMenu(page, idx);
        await page.evaluate(() => { document.querySelector('.paragraph-pair .sentence-wrap')?.remove(); window.dispatchEvent(new Event('scroll')); });
        await page.waitForTimeout(250);
        info(`${tag} removed-anchor behaviour`, await page.evaluate(() => document.getElementById('article-sentence-menu').classList.contains('hidden')));

        // resize 仍收起（既有行為）
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForSelector('.sent-analyze-btn');
        await page.waitForTimeout(400);
        await openMenu(page, 0);
        await page.setViewportSize({ width: 1180, height: 900 });
        await page.waitForTimeout(200);
        check(`${tag} resize closes menu (existing behaviour)`, await page.evaluate(() => document.getElementById('article-sentence-menu').classList.contains('hidden')));
        check(`${tag} no page errors`, errors.length === 0, errors);
    } finally { await context.close(); }
}

// ---------- F3：Tab / Shift+Tab / Escape ----------
async function f3(browser, locale, mobile = false, width = 1280) {
    const tag = `F3 ${mobile ? 'mobile 320' : 'desktop'} ${locale}`;
    const { page, context, errors } = await setup(browser, locale, width, mobile);
    try {
        const idx = await page.evaluate(() => [...document.querySelectorAll('.sent-analyze-btn')]
            .findIndex((b) => b.closest('.paragraph-pair')?.dataset.sourceLanguage !== 'zh'));
        const trigger = page.locator('.sent-analyze-btn').nth(idx);
        await trigger.focus();
        // 原生 Tab 順序作為獨立對照組（菜單關閉時）
        await page.keyboard.press('Tab');
        const nativeNext = await page.evaluate(() => ({ tag: document.activeElement.tagName, cls: document.activeElement.className, id: document.activeElement.id }));
        await trigger.focus();
        await page.keyboard.press('Shift+Tab');
        const nativePrev = await page.evaluate(() => ({ tag: document.activeElement.tagName, cls: document.activeElement.className, id: document.activeElement.id }));

        await trigger.focus();
        await page.keyboard.press('ArrowDown');
        const opened = await page.evaluate(() => ({
            hidden: document.getElementById('article-sentence-menu').classList.contains('hidden'),
            focused: document.activeElement === document.querySelector('#article-sentence-menu button')
        }));
        check(`${tag} ArrowDown opens menu and focuses first item`, opened.hidden === false && opened.focused === true, opened);

        await page.keyboard.press('Tab');
        const menuTab = await page.evaluate(() => ({
            tag: document.activeElement.tagName, cls: document.activeElement.className, id: document.activeElement.id,
            hidden: document.getElementById('article-sentence-menu').classList.contains('hidden'),
            inArticle: !!document.activeElement.closest('#article-section'),
            fab: document.activeElement.id === 'assistant-fab'
        }));
        check(`${tag} Tab leaves menu`, menuTab.hidden === true, menuTab);
        check(`${tag} Tab lands on article control (not page-footer AI fab)`, menuTab.inArticle === true && menuTab.fab === false, menuTab);
        check(`${tag} Tab target matches native next-focusable`, menuTab.cls === nativeNext.cls && menuTab.tag === nativeNext.tag, { menuTab, nativeNext });

        await trigger.focus();
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Shift+Tab');
        const menuShiftTab = await page.evaluate(() => ({
            tag: document.activeElement.tagName, cls: document.activeElement.className, id: document.activeElement.id,
            hidden: document.getElementById('article-sentence-menu').classList.contains('hidden'),
            inArticle: !!document.activeElement.closest('#article-section'),
            fab: document.activeElement.id === 'assistant-fab'
        }));
        check(`${tag} Shift+Tab leaves menu`, menuShiftTab.hidden === true, menuShiftTab);
        check(`${tag} Shift+Tab lands on previous article control`, menuShiftTab.inArticle === true && menuShiftTab.fab === false, menuShiftTab);
        check(`${tag} Shift+Tab target matches native previous-focusable`, menuShiftTab.cls === nativePrev.cls && menuShiftTab.tag === nativePrev.tag, { menuShiftTab, nativePrev });

        await trigger.focus();
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Escape');
        const esc = await page.evaluate((n) => ({
            hidden: document.getElementById('article-sentence-menu').classList.contains('hidden'),
            focusBack: document.activeElement === [...document.querySelectorAll('.sent-analyze-btn')][n],
            expanded: [...document.querySelectorAll('.sent-analyze-btn')][n].getAttribute('aria-expanded')
        }), idx);
        check(`${tag} Escape closes menu and restores trigger focus`, esc.hidden && esc.focusBack && esc.expanded === 'false', esc);

        const pollution = await page.evaluate(() => {
            const sentence = document.querySelector('.interactive-sentence');
            return { text: sentence.textContent.trim(), hasMenuText: /句子解析|句子操作|朗读本句|朗讀本句/.test(sentence.textContent) };
        });
        check(`${tag} sentence textContent unpolluted by menu`, pollution.hasMenuText === false, pollution);
        check(`${tag} no page errors`, errors.length === 0, errors);
    } finally { await context.close(); }
}

// ---------- F5：zh-HK 文案 ----------
async function f5(browser) {
    const tag = 'F5 selection label';
    const { page, context, errors } = await setup(browser, 'zh-HK', 1280, false);
    try {
        const labels = await page.evaluate(async () => {
            const i18n = await import('/modules/i18n.js');
            const hk = i18n.t('article.readSelection');
            await i18n.setLocale('zh-CN');
            const cn = i18n.t('article.readSelection');
            await i18n.setLocale('zh-HK');
            return { hk, cn };
        });
        check(`${tag} zh-HK readSelection uses 選取`, labels.hk === '朗讀選取內容', labels);
        check(`${tag} zh-CN readSelection unchanged`, labels.cn === '朗读选中内容', labels);

        // 真實選取 → 工具列按鈕文字 → 朗讀內容為選取片段
        const readLabel = await page.evaluate(async () => {
            const word = document.querySelector('.paragraph-pair:not([data-source-language="zh"]) .interactive-word');
            const node = [...word.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim().length > 2);
            const range = document.createRange();
            range.selectNodeContents(node);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            document.dispatchEvent(new Event('selectionchange'));
            await new Promise((r) => setTimeout(r, 220));
            const bar = document.querySelector('.article-selection-bar.is-visible');
            const btn = bar?.querySelector('[data-act="read"]');
            return { word: node.textContent, visible: !!bar, text: btn?.textContent?.trim() || '', title: btn?.title || '', aria: btn?.getAttribute('aria-label') || '' };
        });
        check(`${tag} zh-HK selection toolbar shows 選取 wording`, readLabel.visible && /選取/.test(readLabel.text + readLabel.title + readLabel.aria), readLabel);
        await page.locator('.article-selection-bar.is-visible [data-act="read"]').click();
        await waitCount(page, 1);
        check(`${tag} selection read speaks the selected fragment once`, (await last(page)) === readLabel.word.trim(), { spoke: await last(page), word: readLabel.word });
        await finish(page);
        await page.waitForTimeout(600);
        check(`${tag} selection read stops after one utterance`, (await count(page)) === 1, { calls: await count(page) });
        await shot(page, 'desktop-zh-HK-selection.png');
        check(`${tag} no page errors`, errors.length === 0, errors);
    } finally { await context.close(); }
}

// ---------- 英文一般/循環不受影響 ----------
async function english(browser) {
    const tag = 'EN regression';
    const { page, context, errors, external } = await setup(browser, 'zh-CN', 1280, false);
    try {
        const idx = await page.evaluate(() => [...document.querySelectorAll('.sent-analyze-btn')]
            .findIndex((b) => b.closest('.paragraph-pair')?.dataset.sourceLanguage !== 'zh'));
        const expect = await page.evaluate((n) => [...document.querySelectorAll('.sent-analyze-btn')][n].closest('.sentence-wrap').querySelector('.interactive-sentence').textContent.trim(), idx);
        // 單句一次
        await openMenu(page, idx);
        await page.locator('#article-sentence-menu [data-sentence-action="once"]').click();
        await waitCount(page, 1);
        check(`${tag} once speaks the sentence`, (await last(page)) === expect, { spoke: await last(page), expect });
        await finish(page);
        await page.waitForTimeout(700);
        check(`${tag} once stops (no extra calls)`, (await count(page)) === 1, { calls: await count(page) });
        check(`${tag} stop button disabled after once`, await page.locator('#stop-read-article-btn').isDisabled());

        // 循環：間隔 >= 0.5s、同一句
        await openMenu(page, idx);
        await page.locator('#article-sentence-menu [data-sentence-action="loop"]').click();
        await waitCount(page, 2);
        let endedAt = await page.evaluate(() => { window.__speech.finish(); return Date.now(); });
        await waitCount(page, 3);
        const gap = await page.evaluate((endedAt) => window.__speech.calls.at(-1).at - endedAt, endedAt);
        endedAt = await page.evaluate(() => { window.__speech.finish(); return Date.now(); });
        await waitCount(page, 4);
        const gap2 = await page.evaluate((endedAt) => window.__speech.calls.at(-1).at - endedAt, endedAt);
        const sameText = (await last(page)) === expect;
        check(`${tag} loop repeats same sentence with >=500ms gaps`, sameText && gap >= 480 && gap2 >= 480, { gap, gap2, sameText });
        check(`${tag} loop mode exposes floating stop`, await page.evaluate(() => {
            const reader = document.querySelector('.floating-reader');
            return !!reader && reader.classList.contains('is-visible') && reader.getAttribute('data-reading-mode') === 'loop';
        }));
        await page.locator('.fr-stop').click();
        await page.evaluate(() => window.__speech.finish?.());
        const callsAfterStop = await count(page);
        await page.waitForTimeout(700);
        check(`${tag} floating stop halts loop`, (await count(page)) === callsAfterStop, { callsAfterStop, now: await count(page) });

        // 從指定句逐句：每句一次
        await openMenu(page, idx);
        await page.locator('#article-sentence-menu [data-sentence-action="continue"]').click();
        await page.evaluate(() => window.__speech.finish());
        const second = await last(page);
        await page.evaluate(() => window.__speech.finish());
        await page.waitForTimeout(300);
        const seq = await page.evaluate(() => window.__speech.calls.map((c) => c.text));
        check(`${tag} continue reads next sentence once each`, seq.length >= 3 && new Set(seq).size >= 2 && second !== expect, { seq });
        check(`${tag} zero external requests`, external.length === 0, external.slice(0, 3));
        check(`${tag} no page errors`, errors.length === 0, errors);
    } finally { await context.close(); }
}

(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
    try {
        await f1(browser, 'zh-CN', 1280, false);
        await f1(browser, 'zh-HK', 1280, false);
        await f1(browser, 'zh-CN', 320, true);
        await f1(browser, 'zh-HK', 390, true);
        await f2(browser);
        await f3(browser, 'zh-CN');
        await f3(browser, 'zh-HK');
        await f3(browser, 'zh-CN', true, 320);
        await f5(browser);
        await english(browser);
    } finally {
        await browser.close();
    }
    fs.writeFileSync(path.join(OUT, 'recheck-results.json'), JSON.stringify(results, null, 2));
    const passed = results.filter((r) => r.ok === true).length;
    console.log(`\n=== ${passed} pass / ${failures} fail / ${results.filter((r) => r.ok === null).length} info ===`);
    process.exitCode = failures ? 1 : 0;
})().catch((error) => { console.error(error); process.exitCode = 1; });
