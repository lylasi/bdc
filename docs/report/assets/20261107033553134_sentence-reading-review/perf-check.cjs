const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const BASE = `http://127.0.0.1:${process.env.PORT || 8313}`;
const PARA = Array.from({ length: 6 }, (_, i) => Array.from({ length: 8 }, (_, j) => `Sentence ${i}-${j} keeps a reasonable length for vertical rhythm.`).join(' ')).join('\n\n');
(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
    const context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
    await context.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === '/ai-config.js') return route.fulfill({ contentType: 'application/javascript', body: 'export const SYNC={endpoint:""}; export const TTS_CONFIG={}, AI_LIMITS={}, OCR_CONFIG={}, ARTICLE_IMPORT={}, SUPABASE={};' });
        if (url.origin !== BASE) return route.abort();
        return route.continue();
    });
    await context.addInitScript(() => {
        window.__BDC_SYNC_ENDPOINT__ = 'http://127.0.0.1:19999/independent-audit';
        localStorage.setItem('pen_global_settings', JSON.stringify({ language: { interfaceLocale: 'zh-CN' } }));
        const speech = window.__speech = { calls: [], current: null };
        Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: class { constructor(text) { this.text = text; } } });
        Object.defineProperty(window, 'speechSynthesis', { value: { getVoices: () => [{ lang: 'en-US', name: 'T', voiceURI: 't' }], addEventListener() {}, removeEventListener() {}, cancel() {}, speak(u) { speech.current = u; speech.calls.push({ text: u.text }); queueMicrotask(() => u.onstart?.()); } } });
    });
    const page = await context.newPage();
    const booted = page.waitForEvent('console', { predicate: (m) => m.text().startsWith('应用程序已') });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await booted;
    await page.waitForFunction(() => !!document.getElementById('article-btn'));
    await page.evaluate(async ({ para }) => {
        const articles = await import('/modules/article-store.js');
        const reading = await import('/modules/reading-store.js');
        await articles.initArticleStore();
        await reading.initReadingStore();
        const paragraphs = para.split('\n\n');
        const saved = await articles.saveArticle({
            articleId: 'art_perf', article: para, title: 'Perf', sourceType: 'paste',
            result: { chinese_translation: 'x', word_alignment: [], detailed_analysis: [], sentence_analysis: [], phrase_analysis: [],
                paragraph_analysis: paragraphs.map((p) => ({ chinese_translation: '譯文。', word_alignment: [], detailed_analysis: [], sentences: p.match(/[^.!?]+[.!?]*/g).map((s) => ({ en: s.trim(), zh: '譯文。' })) })) }
        });
        if (!saved.ok) throw new Error(saved.error);
        document.querySelector('#app-modal .modal-close-btn')?.click();
        document.getElementById('article-btn').click();
        const state = await import('/modules/state.js');
        state.setCurrentArticleId('art_perf');
        const article = await import('/features/article/article.js');
        await article.showCurrentArticleIfAvailable();
    }, { para: PARA });
    await page.waitForSelector('.sent-analyze-btn');
    await page.waitForTimeout(500);
    const stats = await page.evaluate(async () => {
        const proto = await import('/shared/reading-protocol.mjs');
        const input = document.getElementById('article-input').value;
        const t0 = performance.now();
        for (let i = 0; i < 200; i += 1) proto.contentVersionOf(input);
        const hashMs = (performance.now() - t0) / 200;
        // 量測滑過一段文字（大量 mouseover）時的總耗時
        const wrap = document.querySelectorAll('.sentence-wrap')[10];
        const t1 = performance.now();
        for (let i = 0; i < 40; i += 1) {
            const target = wrap.querySelectorAll('.interactive-word')[i % 3] || wrap;
            wrap.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, target }));
        }
        const hoverMs = (performance.now() - t1) / 40;
        // 量測開啟選單耗時
        const trigger = document.querySelectorAll('.sent-analyze-btn')[10];
        const t2 = performance.now();
        for (let i = 0; i < 20; i += 1) { trigger.click(); trigger.click(); }
        const menuMs = (performance.now() - t2) / 40;
        return { textLength: input.length, sentenceCount: document.querySelectorAll('.interactive-sentence').length, hashMs, hoverMs, menuMs };
    });
    console.log(JSON.stringify(stats, null, 2));
    await context.close(); await browser.close();
})();
