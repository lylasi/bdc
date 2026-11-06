const path = require('node:path');
const { chromium } = require('/Users/linus/.local/share/fnm/node-versions/v24.20.0/installation/lib/node_modules/@playwright/cli/node_modules/playwright');
const BASE = 'http://127.0.0.1:8326';
const OUT = process.argv[2];
(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
    for (const [locale, width, mobile] of [['zh-HK', 1280, false], ['zh-CN', 1280, false], ['zh-HK', 390, true]]) {
        const context = await browser.newContext({ viewport: { width, height: mobile ? 844 : 900 }, isMobile: mobile, hasTouch: mobile });
        await context.route('**/*', (route) => {
            const url = new URL(route.request().url());
            if (url.pathname === '/ai-config.js') return route.fulfill({ contentType: 'application/javascript', body: 'export const SYNC={endpoint:""}; export const TTS_CONFIG={}, AI_LIMITS={}, OCR_CONFIG={}, ARTICLE_IMPORT={}, SUPABASE={};' });
            return url.origin === BASE ? route.continue() : route.abort();
        });
        await context.addInitScript((locale) => {
            localStorage.setItem('pen_global_settings', JSON.stringify({ language: { interfaceLocale: locale } }));
            Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: class { constructor(t) { this.text = t; } } });
            Object.defineProperty(window, 'speechSynthesis', { value: { getVoices: () => [{ lang: 'en-US', name: 'x', voiceURI: 'x' }], addEventListener() {}, removeEventListener() {}, cancel() {}, speak(u) { window.__spoke = u.text; queueMicrotask(() => u.onstart?.()); } } });
        }, locale);
        const page = await context.newPage();
        const booted = page.waitForEvent('console', { predicate: (m) => m.text().startsWith('应用程序已') });
        await page.goto(BASE, { waitUntil: 'domcontentloaded' });
        await booted;
        await page.waitForFunction(() => !!document.getElementById('article-btn'));
        await page.evaluate(async () => {
            const articles = await import('/modules/article-store.js');
            await articles.initArticleStore();
            const saved = await articles.saveArticle({ articleId: 'art_sel_shot', article: 'The reading room opens at eight.', title: 'Selection', sourceType: 'paste', result: { chinese_translation: '阅览室八点开门。', word_alignment: [], detailed_analysis: [], paragraph_analysis: [{ chinese_translation: '阅览室八点开门。', sentences: [{ en: 'The reading room opens at eight.', zh: '阅览室八点开门。' }] }], sentence_analysis: [], phrase_analysis: [] } });
            if (!saved.ok) throw new Error(saved.error);
            document.querySelector('#app-modal .modal-close-btn')?.click();
            document.getElementById('article-btn').click();
            (await import('/modules/state.js')).setCurrentArticleId('art_sel_shot');
            await (await import('/features/article/article.js')).showCurrentArticleIfAvailable();
        });
        await page.waitForSelector('.interactive-word');
        await page.waitForTimeout(400);
        const label = await page.evaluate(async () => {
            const word = document.querySelector('.interactive-word');
            const node = [...word.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim().length > 2);
            const range = document.createRange();
            range.selectNodeContents(node);
            const sel = window.getSelection();
            sel.removeAllRanges(); sel.addRange(range);
            document.dispatchEvent(new Event('selectionchange'));
            await new Promise((r) => setTimeout(r, 250));
            const btn = document.querySelector('.article-selection-bar.is-visible [data-act="read"]');
            return { title: btn?.title, aria: btn?.getAttribute('aria-label') };
        });
        await page.screenshot({ path: path.join(OUT, `selection-${mobile ? '390' : 'desktop'}-${locale}.png`) });
        console.log(locale, mobile ? 390 : 'desktop', JSON.stringify(label));
        await context.close();
    }
    await browser.close();
})();
