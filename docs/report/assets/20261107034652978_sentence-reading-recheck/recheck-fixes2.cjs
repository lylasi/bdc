/**
 * 複查補充：F2 手機（觸控）捲動、F3 首句/末句邊界。
 * 用法：PORT=8326 ARTIFACT_DIR=<dir> PLAYWRIGHT_MODULE=<path> node recheck-fixes2.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const BASE = String(process.env.BASE_URL || `http://127.0.0.1:${process.env.PORT || 8326}`).replace(/\/+$/, '');
const OUT = process.env.ARTIFACT_DIR || __dirname;
fs.mkdirSync(OUT, { recursive: true });
const results = [];
let failures = 0;
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name} :: ${JSON.stringify(detail)}`); };
const info = (name, detail) => { results.push({ name, ok: null, detail }); console.log(`INFO ${name} :: ${JSON.stringify(detail)}`); };

const paragraphs = [
    'The reading room opens at eight. Visitors sign the book at the door.',
    '这是一段中文原文，用来检查英文朗读功能的可用性。',
    'Morning light falls across the long wooden table. Two students copy new words into their notebooks.',
    'The reading room opens at eight.',
    'A final sentence closes the article.',
    ...Array.from({ length: 7 }, (_, i) => `Paragraph ${i + 1} keeps the page long enough to scroll. Another line follows here for paragraph ${i + 1}.`)
];
const analysis = paragraphs.map((text, index) => ({
    chinese_translation: index === 1 ? text : '合成译文，仅供测试。',
    word_alignment: [], detailed_analysis: [],
    sentences: (index === 1 ? [text] : text.match(/[^.!?]+[.!?]*/g).map((s) => s.trim())).map((en) => ({ en, zh: '合成译文。' }))
}));

async function setup(browser, locale, width, mobile) {
    const context = await browser.newContext({ viewport: { width, height: mobile ? 844 : 900 }, isMobile: mobile, hasTouch: mobile });
    await context.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === '/ai-config.js') return route.fulfill({ contentType: 'application/javascript', body: 'export const SYNC={endpoint:""}; export const TTS_CONFIG={}, AI_LIMITS={}, OCR_CONFIG={}, ARTICLE_IMPORT={}, SUPABASE={};' });
        return url.origin === BASE ? route.continue() : route.abort();
    });
    await context.addInitScript((locale) => {
        localStorage.setItem('pen_global_settings', JSON.stringify({ language: { interfaceLocale: locale } }));
        const speech = window.__speech = { calls: [], current: null };
        speech.finish = () => { const cur = speech.current; speech.current = null; cur?.onend?.(); };
        Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: class { constructor(t) { this.text = t; } } });
        Object.defineProperty(window, 'speechSynthesis', { value: {
            getVoices: () => [{ lang: 'en-US', name: 'x', voiceURI: 'x' }], addEventListener() {}, removeEventListener() {}, cancel() { speech.current = null; },
            speak(u) { speech.current = u; speech.calls.push({ text: u.text }); queueMicrotask(() => u.onstart?.()); }
        } });
    }, locale);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const booted = page.waitForEvent('console', { predicate: (m) => m.text().startsWith('应用程序已') });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await booted;
    await page.waitForFunction(() => !!document.getElementById('article-btn'));
    await page.evaluate(async ({ paragraphs, analysis }) => {
        const articles = await import('/modules/article-store.js');
        await articles.initArticleStore();
        const saved = await articles.saveArticle({ articleId: 'art_recheck_fixture2', article: paragraphs.join('\n\n'), title: 'Recheck fixture 2', sourceType: 'paste', result: { chinese_translation: '合成译文。', word_alignment: [], detailed_analysis: [], paragraph_analysis: analysis, sentence_analysis: [], phrase_analysis: [] } });
        if (!saved.ok) throw new Error(saved.error);
        document.querySelector('#app-modal .modal-close-btn')?.click();
        document.getElementById('article-btn').click();
        (await import('/modules/state.js')).setCurrentArticleId('art_recheck_fixture2');
        await (await import('/features/article/article.js')).showCurrentArticleIfAvailable();
    }, { paragraphs, analysis });
    await page.waitForSelector('.sent-analyze-btn');
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
    return { page, context, errors };
}

async function mobileScroll(browser) {
    const tag = 'F2 mobile 390 zh-CN';
    const { page, context, errors } = await setup(browser, 'zh-CN', 390, true);
    try {
        const box = (n) => page.evaluate((n) => {
            const menu = document.getElementById('article-sentence-menu');
            const trigger = [...document.querySelectorAll('.sent-analyze-btn')][n];
            const m = menu.getBoundingClientRect();
            const t = trigger.getBoundingClientRect();
            return { hidden: menu.classList.contains('hidden'), menu: { top: m.top, bottom: m.bottom, left: m.left, right: m.right }, trigger: { top: t.top, bottom: t.bottom }, gapBelow: m.top - t.bottom, gapAbove: t.top - m.bottom, scrollY, innerHeight, innerWidth };
        }, n);
        const trigger = page.locator('.sent-analyze-btn').nth(0);
        await trigger.scrollIntoViewIfNeeded();
        await trigger.tap();
        await page.waitForTimeout(120);
        let b = await box(0);
        check(`${tag} menu opens by tap`, !b.hidden, b);
        // 觸控捲動（等效手指上推）
        await page.evaluate(() => window.scrollBy(0, 140));
        await page.waitForTimeout(250);
        b = await box(0);
        const anchored = !b.hidden && (Math.abs(b.gapBelow - 8) <= 2 || Math.abs(b.gapAbove - 8) <= 2);
        check(`${tag} scroll keeps menu open and anchored`, anchored, b);
        check(`${tag} menu stays inside viewport`, b.menu.top >= 0 && b.menu.bottom <= b.innerHeight + 0.5 && b.menu.left >= 0 && b.menu.right <= b.innerWidth + 0.5, b);
        await page.screenshot({ path: path.join(OUT, 'm390-zh-CN-menu-after-scroll.png') });
        // 捲動後仍可點（點項 → 出聲）
        await page.locator('#article-sentence-menu [data-sentence-action="once"]').tap();
        await page.waitForFunction(() => window.__speech.calls.length === 1);
        check(`${tag} tap on item after scroll still plays`, (await page.evaluate(() => window.__speech.calls[0].text)) === 'The reading room opens at eight.', await page.evaluate(() => window.__speech.calls[0].text));
        await page.evaluate(() => window.__speech.finish());
        await page.waitForTimeout(200);
        // 離屏收起
        await trigger.scrollIntoViewIfNeeded();
        await trigger.tap();
        await page.waitForTimeout(120);
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await page.waitForTimeout(350);
        b = await box(0);
        check(`${tag} off-screen anchor closes menu on mobile`, b.hidden && (b.trigger.bottom <= 0 || b.trigger.top >= b.innerHeight), b);
        check(`${tag} no page errors`, errors.length === 0, errors);
    } finally { await context.close(); }
}

async function tabEdges(browser, locale) {
    const tag = `F3 edges ${locale}`;
    const { page, context, errors } = await setup(browser, locale, 1280, false);
    try {
        const last = await page.evaluate(() => document.querySelectorAll('.sent-analyze-btn').length - 1);
        const probe = async (n, shift) => {
            const t = page.locator('.sent-analyze-btn').nth(n);
            await t.scrollIntoViewIfNeeded();
            await t.focus();
            await page.keyboard.press(shift ? 'Shift+Tab' : 'Tab');
            const native = await page.evaluate(() => ({ tag: document.activeElement.tagName, cls: document.activeElement.className, id: document.activeElement.id, inArticle: !!document.activeElement.closest('#article-section'), fab: document.activeElement.id === 'assistant-fab' }));
            await t.focus();
            await page.keyboard.press('ArrowDown');
            await page.keyboard.press(shift ? 'Shift+Tab' : 'Tab');
            const menu = await page.evaluate(() => ({ tag: document.activeElement.tagName, cls: document.activeElement.className, id: document.activeElement.id, inArticle: !!document.activeElement.closest('#article-section'), fab: document.activeElement.id === 'assistant-fab', hidden: document.getElementById('article-sentence-menu').classList.contains('hidden') }));
            return { native, menu };
        };
        const lastTab = await probe(last, false);
        info(`${tag} last sentence Tab`, lastTab);
        check(`${tag} last sentence Tab: menu closed`, lastTab.menu.hidden === true, lastTab.menu);
        check(`${tag} last sentence Tab: not the page-footer AI fab`, lastTab.menu.fab === false, lastTab.menu);
        const firstShift = await probe(0, true);
        info(`${tag} first sentence Shift+Tab`, firstShift);
        check(`${tag} first sentence Shift+Tab: menu closed`, firstShift.menu.hidden === true, firstShift.menu);
        check(`${tag} first sentence Shift+Tab: not the page-footer AI fab`, firstShift.menu.fab === false, firstShift.menu);
        check(`${tag} no page errors`, errors.length === 0, errors);
    } finally { await context.close(); }
}

(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
    try {
        await mobileScroll(browser);
        await tabEdges(browser, 'zh-CN');
        await tabEdges(browser, 'zh-HK');
    } finally { await browser.close(); }
    fs.writeFileSync(path.join(OUT, 'recheck2-results.json'), JSON.stringify(results, null, 2));
    console.log(`\n=== ${results.filter((r) => r.ok === true).length} pass / ${failures} fail / ${results.filter((r) => r.ok === null).length} info ===`);
    process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
