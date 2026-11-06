/**
 * Sentence actions, playback and mobile layout. Uses isolated synthetic data and
 * manually completed system speech, with no real AI, TTS or account requests.
 * PORT=8313 PLAYWRIGHT_MODULE=<path-to-playwright> node tests/article-sentence-reading.cjs
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const BASE = String(process.env.BASE_URL || `http://127.0.0.1:${process.env.PORT || 8313}`).replace(/\/+$/, '');
const OUTPUT = process.env.ARTIFACT_DIR;
const SENTENCES = [
    'The reading room opens at eight.',
    'Visitors sign the book at the door.',
    'The reading room opens at eight.',
    'A final sentence closes the article.'
];
const BODY = SENTENCES.slice(0, 2).join(' ') + '\n\n' + SENTENCES.slice(2).join(' ');
const LABELS = {
    'zh-CN': ['朗读本句', '从这里开始读', '循环读本句', '句子解析'],
    'zh-HK': ['朗讀本句', '從這裏開始讀', '循環讀本句', '句子解析']
};

async function setup(browser, locale, width = 1280, mobile = false) {
    const context = await browser.newContext({ viewport: { width, height: mobile ? 844 : 960 }, isMobile: mobile, hasTouch: mobile });
    await context.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === '/ai-config.js') return route.fulfill({
            contentType: 'application/javascript',
            body: 'export const SYNC={endpoint:""}; export const TTS_CONFIG={}, AI_LIMITS={}, OCR_CONFIG={}, ARTICLE_IMPORT={}, SUPABASE={};'
        });
        return url.origin === BASE ? route.continue() : route.abort();
    });
    await context.addInitScript((locale) => {
        window.__BDC_SYNC_ENDPOINT__ = 'http://127.0.0.1:19999/sentence-reading-test';
        localStorage.setItem('pen_global_settings', JSON.stringify({ language: { interfaceLocale: locale } }));
        const speech = window.__speech = { calls: [], current: null };
        speech.finish = () => {
            const current = speech.current;
            speech.current = null;
            current?.onend?.();
        };
        Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: class {
            constructor(text) { this.text = text; }
        } });
        Object.defineProperty(window, 'speechSynthesis', { value: {
            getVoices: () => [{ lang: 'en-US', name: 'Test English', voiceURI: 'test' }],
            addEventListener() {},
            removeEventListener() {},
            cancel() { speech.current = null; },
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
    const booted = page.waitForEvent('console', { predicate: (message) => message.text().startsWith('应用程序已') });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await booted;
    await page.waitForFunction(() => !!document.getElementById('article-btn'));
    await page.evaluate(async ({ body, sentences }) => {
        const articles = await import('/modules/article-store.js');
        const reading = await import('/modules/reading-store.js');
        await articles.initArticleStore();
        await reading.initReadingStore();
        const saved = await articles.saveArticle({
            articleId: 'art_sentence_reading_test', article: body, title: 'Sentence reading', sourceType: 'paste',
            result: {
                chinese_translation: '阅览室八点开门。访客在门口签到。', word_alignment: [], detailed_analysis: [],
                paragraph_analysis: [0, 2].map((start) => ({
                    chinese_translation: '合成译文，仅供测试。', word_alignment: [], detailed_analysis: [],
                    sentences: sentences.slice(start, start + 2).map((en) => ({ en, zh: '合成译文。' }))
                })), sentence_analysis: [], phrase_analysis: []
            }
        });
        if (!saved.ok) throw new Error(saved.error);
        document.querySelector('#app-modal .modal-close-btn')?.click();
        document.getElementById('article-btn').click();
        const state = await import('/modules/state.js');
        state.setCurrentArticleId('art_sentence_reading_test');
        const article = await import('/features/article/article.js');
        await article.showCurrentArticleIfAvailable();
    }, { body: BODY, sentences: SENTENCES });
    await page.waitForSelector('.sent-analyze-btn');
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(450);
    assert.equal(await page.locator('.sent-analyze-btn').count(), 4);
    return { page, context, errors };
}

const count = (page) => page.evaluate(() => window.__speech.calls.length);
const finish = (page) => page.evaluate(() => window.__speech.finish());
const last = (page) => page.evaluate(() => window.__speech.calls.at(-1)?.text);
const waitCount = (page, expected) => page.waitForFunction((expected) => window.__speech.calls.length === expected, expected);
async function action(page, index, mode) {
    await page.locator('.sent-analyze-btn').nth(index).click();
    await page.locator(`#article-sentence-menu [data-sentence-action="${mode}"]`).click();
}
async function stop(page) {
    if (await page.locator('.floating-reader.is-visible').count()) await page.locator('.fr-stop').click();
}
async function screenshot(page, name) {
    if (OUTPUT) {
        fs.mkdirSync(OUTPUT, { recursive: true });
        await page.screenshot({ path: path.join(OUTPUT, name) });
    }
}

async function desktop(browser, locale) {
    const { page, context, errors } = await setup(browser, locale);
    try {
        // A menu must be usable before AI has produced any sentence analysis.
        const before = await page.locator('.paragraph-pair').first().boundingBox();
        await page.locator('.sent-analyze-btn').nth(1).click();
        assert.deepEqual(await page.locator('#article-sentence-menu span').allTextContents(), LABELS[locale]);
        assert.ok(await page.locator('#app-modal').evaluate((el) => el.classList.contains('hidden')));
        assert.equal(await count(page), 0);
        assert.equal((await page.locator('.paragraph-pair').first().boundingBox()).height, before.height);
        await screenshot(page, `desktop-${locale}-menu.png`);
        const otherLocale = locale === 'zh-CN' ? 'zh-HK' : 'zh-CN';
        await page.evaluate(async (locale) => (await import('/modules/i18n.js')).setLocale(locale), otherLocale);
        assert.deepEqual(await page.locator('#article-sentence-menu span').allTextContents(), LABELS[otherLocale]);
        await page.evaluate(async (locale) => (await import('/modules/i18n.js')).setLocale(locale), locale);
        assert.deepEqual(await page.locator('#article-sentence-menu span').allTextContents(), LABELS[locale]);
        await page.evaluate(() => { window.scrollBy(0, 24); window.dispatchEvent(new Event('scroll')); });
        await page.waitForTimeout(80);
        assert.ok(await page.locator('#article-sentence-menu').isVisible());
        await page.keyboard.press('Escape');
        assert.ok(await page.locator('.sent-analyze-btn').nth(1).evaluate((el) => el === document.activeElement));
        await page.keyboard.press('ArrowDown');
        assert.ok(await page.locator('#article-sentence-menu button').first().evaluate((el) => el === document.activeElement), JSON.stringify(await page.evaluate(() => ({
            active: document.activeElement?.outerHTML?.slice(0, 500),
            menu: document.getElementById('article-sentence-menu').className,
            expanded: [...document.querySelectorAll('.sent-analyze-btn')].map((el) => el.getAttribute('aria-expanded')),
            scroll: [scrollX, scrollY]
        }))));
        await page.keyboard.press('End');
        assert.ok(await page.locator('#article-sentence-menu button').last().evaluate((el) => el === document.activeElement));
        await page.keyboard.press('Tab');
        assert.ok(await page.locator('.paragraph-pair').first().locator('.retry-paragraph-btn').evaluate((el) => el === document.activeElement),
            await page.evaluate(() => document.activeElement?.outerHTML));
        await page.locator('.sent-analyze-btn').nth(1).focus();
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Shift+Tab');
        assert.ok(await page.locator('.interactive-sentence').nth(1).evaluate((el) => el === document.activeElement));
        await page.locator('.sent-analyze-btn').nth(1).focus();
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Escape');

        // These deliberately incompatible sidebar settings must remain intact.
        await page.selectOption('#reading-mode', 'paragraph');
        await page.locator('#chunk-repeat-times').fill('3');
        await action(page, 1, 'once');
        assert.equal(await last(page), SENTENCES[1]);
        await finish(page);
        await page.waitForTimeout(650);
        assert.equal(await count(page), 1);
        assert.ok(await page.locator('#stop-read-article-btn').isDisabled());
        assert.equal(await page.inputValue('#reading-mode'), 'paragraph');
        assert.equal(await page.inputValue('#chunk-repeat-times'), '3');

        // The third sentence is a duplicate of the first: identify the occurrence by DOM.
        await action(page, 2, 'continue');
        await finish(page);
        assert.equal(await last(page), SENTENCES[3]);
        await finish(page);
        assert.ok(await page.locator('#stop-read-article-btn').isDisabled());
        assert.equal(await count(page), 3);

        await action(page, 1, 'loop');
        await page.locator('.sent-analyze-btn').nth(1).click();
        await page.evaluate(async (locale) => (await import('/modules/i18n.js')).setLocale(locale), otherLocale);
        const stopLoopLabel = await page.evaluate(async () => (await import('/modules/i18n.js')).t('article.stopLoopSentence'));
        assert.equal(await page.locator('#article-sentence-menu [data-sentence-action="loop"] span').textContent(), stopLoopLabel);
        assert.ok((await page.locator('.fr-toggle').getAttribute('aria-label')).includes(LABELS[otherLocale][2]));
        assert.equal(await last(page), SENTENCES[1]);
        await page.evaluate(async (locale) => (await import('/modules/i18n.js')).setLocale(locale), locale);
        await page.keyboard.press('Escape');
        let calls = await count(page);
        const endedAt = await page.evaluate(() => { window.__speech.finish(); return Date.now(); });
        await page.waitForTimeout(250);
        assert.equal(await count(page), calls);
        await waitCount(page, calls + 1);
        assert.equal(await last(page), SENTENCES[1]);
        assert.ok(await page.evaluate((endedAt) => window.__speech.calls.at(-1).at - endedAt >= 480, endedAt));
        assert.equal(await page.locator('.floating-reader').getAttribute('data-reading-mode'), 'loop');

        // Pause and stop during the 500 ms gap must cancel the pending repetition.
        await finish(page);
        await page.locator('.fr-toggle').click();
        calls = await count(page);
        await page.waitForTimeout(650);
        assert.equal(await count(page), calls);
        await page.locator('.fr-toggle').click();
        assert.equal(await last(page), SENTENCES[1]);
        await page.locator('.fr-next').click();
        assert.equal(await last(page), SENTENCES[2]);
        assert.equal(await page.locator('.floating-reader').getAttribute('data-reading-mode'), 'loop');
        await finish(page);
        await stop(page);
        calls = await count(page);
        await page.waitForTimeout(650);
        assert.equal(await count(page), calls);

        // Re-selecting the active action stops it; switching mode replaces it.
        await action(page, 1, 'loop');
        await action(page, 1, 'loop');
        assert.ok(await page.locator('#stop-read-article-btn').isDisabled());
        await action(page, 1, 'loop');
        await finish(page);
        await action(page, 2, 'once');
        await finish(page);
        calls = await count(page);
        await page.waitForTimeout(650);
        assert.equal(await count(page), calls);

        // Word pronunciation interrupts a pending loop without resuming it.
        await action(page, 1, 'loop');
        await finish(page);
        await page.evaluate(async () => (await import('/modules/audio.js')).speakText('word', 'english', 0, null, null, { owner: 'word-test' }));
        calls = await count(page);
        await page.waitForTimeout(650);
        assert.equal(await count(page), calls);
        await page.locator('.fr-toggle').click();
        assert.equal(await last(page), SENTENCES[1]);
        await stop(page);

        // One selected fragment, using the existing toolbar and shared player.
        await page.evaluate(() => {
            const sentence = document.querySelector('.interactive-sentence');
            const walker = document.createTreeWalker(sentence, NodeFilter.SHOW_TEXT);
            const node = walker.nextNode();
            const range = document.createRange();
            range.setStart(node, 0);
            range.setEnd(node, 3);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            document.dispatchEvent(new Event('selectionchange'));
        });
        await page.locator('.article-selection-bar.is-visible [data-act="read"]').click();
        assert.equal(await last(page), 'The');
        await finish(page);
        assert.ok(await page.locator('#stop-read-article-btn').isDisabled());

        // Hover shortcut must not change paragraph height or add inline buttons.
        await page.locator('.sent-analyze-btn').first().hover();
        await page.locator('#article-sentence-quick-read').waitFor({ state: 'visible' });
        assert.equal(await page.locator('.sentence-hint.is-shown').count(), 1);
        assert.equal(await page.locator('.sentence-linked').count(), 2);
        const hint = await page.locator('.sentence-hint').boundingBox();
        const quick = await page.locator('#article-sentence-quick-read').boundingBox();
        assert.ok(quick.x + quick.width <= hint.x || quick.x >= hint.x + hint.width
            || quick.y + quick.height <= hint.y || quick.y >= hint.y + hint.height);
        await screenshot(page, `desktop-${locale}-hover.png`);
        await page.locator('#article-sentence-quick-read').click();
        assert.equal(await last(page), SENTENCES[0]);
        await finish(page);
        assert.equal(await page.locator('.sentence-wrap button').count(), 4);
        assert.equal((await page.locator('.paragraph-pair').first().boundingBox()).height, before.height);

        // A system speech error ends a loop instead of retrying forever.
        await action(page, 0, 'loop');
        await page.evaluate(() => window.__speech.current?.onerror?.({ error: 'test-error' }));
        calls = await count(page);
        await page.waitForTimeout(650);
        assert.equal(await count(page), calls);
        assert.ok(await page.locator('#stop-read-article-btn').isDisabled());

        // Opening analysis still follows the existing lazy analysis path.
        await action(page, 0, 'analyze');
        await page.locator('#app-modal:not(.hidden) .sentence-card').waitFor();
        assert.deepEqual(errors, []);
        console.log(`PASS desktop ${locale}: menu, keyboard, once, continue, loop, pause, navigation, stop, interruption, selection, hover, error, analysis`);
    } finally { await context.close(); }
}

async function mobile(browser, locale, width) {
    const { page, context, errors } = await setup(browser, locale, width, true);
    try {
        const before = await page.locator('.paragraph-pair').first().boundingBox();
        await page.locator('.sent-analyze-btn').first().tap();
        const menu = await page.locator('#article-sentence-menu').boundingBox();
        assert.ok(menu.x >= 0 && menu.x + menu.width <= width);
        assert.ok(menu.y >= 0 && menu.y + menu.height <= 844);
        assert.deepEqual(await page.locator('#article-sentence-menu span').allTextContents(), LABELS[locale]);
        assert.equal((await page.locator('.paragraph-pair').first().boundingBox()).height, before.height);
        assert.equal(await page.locator('.sentence-wrap button').count(), 4);
        assert.equal(await page.locator('#article-sentence-quick-read').isVisible(), false);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await screenshot(page, `mobile-${width}-${locale}-menu.png`);
        await page.locator('#article-sentence-menu [data-sentence-action="loop"]').tap();
        await finish(page);
        const calls = await count(page);
        await waitCount(page, calls + 1);
        assert.equal(await last(page), SENTENCES[0]);
        await stop(page);
        assert.deepEqual(errors, []);
        console.log(`PASS mobile ${width} ${locale}: one inline button, no reflow/overflow, menu fits, touch playback and stop`);
    } finally { await context.close(); }
}

async function chineseSource(browser, locale, mobile = false) {
    const { page, context, errors } = await setup(browser, locale, mobile ? 320 : 1280, mobile);
    try {
        await page.evaluate(async () => {
            const text = '这是一段中文原文，用来检查英文朗读功能的可用性。';
            const articles = await import('/modules/article-store.js');
            const saved = await articles.saveArticle({
                articleId: 'art_sentence_chinese_source', article: text, title: 'Chinese source', sourceType: 'paste',
                result: { chinese_translation: text, word_alignment: [], detailed_analysis: [],
                    paragraph_analysis: [{ chinese_translation: text, sentences: [{ en: text, zh: text }] }],
                    sentence_analysis: [], phrase_analysis: [] }
            });
            if (!saved.ok) throw new Error(saved.error);
            (await import('/modules/state.js')).setCurrentArticleId('art_sentence_chinese_source');
            await (await import('/features/article/article.js')).showCurrentArticleIfAvailable();
        });
        const trigger = page.locator('.paragraph-pair[data-source-language="zh"] .sent-analyze-btn').first();
        await trigger.click();
        for (const mode of ['once', 'continue', 'loop']) {
            assert.ok(await page.locator(`#article-sentence-menu [data-sentence-action="${mode}"]`).isDisabled());
        }
        assert.ok(await page.locator('#article-sentence-menu [data-sentence-action="analyze"]').isEnabled());
        assert.ok(await page.locator('.article-sentence-menu-hint').isVisible());
        assert.equal(await page.locator('.article-sentence-menu-hint').textContent(),
            await page.evaluate(async () => (await import('/modules/i18n.js')).t('article.englishSentenceOnly')));
        await screenshot(page, `${mobile ? 'mobile-320' : 'desktop'}-${locale}-chinese-source.png`);
        await page.keyboard.press('Escape');
        if (!mobile) {
            await trigger.hover();
            assert.equal(await page.locator('#article-sentence-quick-read').isVisible(), false);
        }
        assert.equal(await count(page), 0);
        assert.deepEqual(errors, []);
        console.log(`PASS Chinese source ${mobile ? 'mobile 320' : 'desktop'} ${locale}: disabled reading with explanation, analysis available, no dead shortcut`);
    } finally { await context.close(); }
}

(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
    try {
        for (const locale of Object.keys(LABELS)) {
            await desktop(browser, locale);
            for (const width of [320, 390]) await mobile(browser, locale, width);
            await chineseSource(browser, locale);
            await chineseSource(browser, locale, true);
        }
    } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
