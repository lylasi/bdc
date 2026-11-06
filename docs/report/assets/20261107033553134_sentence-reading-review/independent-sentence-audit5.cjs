/**
 * 獨立審查第五輪：原文已是中文的段落，句尾朗讀是否有回饋。
 * PORT=8313 PLAYWRIGHT_MODULE=<pw> node independent-sentence-audit5.cjs
 */
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const BASE = `http://127.0.0.1:${process.env.PORT || 8313}`;
const OUT = process.env.ARTIFACT_DIR || '';
const PARA = [
    'Alpha sentence one. Alpha sentence two.',
    '這是一段以中文為主的原文段落，用來檢查朗讀入口是不是會靜靜地沒有反應。',
    'Beta sentence three.'
];
const BODY = PARA.join('\n\n');
const results = [];
const record = (id, status, detail = '') => { results.push({ id, status, detail }); console.log(`${status} ${id}${detail ? ' :: ' + detail : ''}`); };
const ok = (id, cond, detail = '') => { record(id, cond ? 'PASS' : 'FAIL', cond ? '' : detail); return !!cond; };
const info = (id, detail) => record(id, 'INFO', detail);

(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
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
        speech.finish = () => { const c = speech.current; speech.current = null; c?.onend?.(); };
        Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: class { constructor(text) { this.text = text; } } });
        Object.defineProperty(window, 'speechSynthesis', { value: {
            getVoices: () => [{ lang: 'en-US', name: 'Test English', voiceURI: 'test' }],
            addEventListener() {}, removeEventListener() {}, cancel() { speech.current = null; },
            speak(u) { speech.current = u; speech.calls.push({ text: u.text, at: Date.now() }); queueMicrotask(() => u.onstart?.()); }
        } });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const booted = page.waitForEvent('console', { predicate: (m) => m.text().startsWith('应用程序已') });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await booted;
    await page.waitForFunction(() => !!document.getElementById('article-btn'));
    await page.evaluate(async ({ body }) => {
        const articles = await import('/modules/article-store.js');
        const reading = await import('/modules/reading-store.js');
        await articles.initArticleStore();
        await reading.initReadingStore();
        const saved = await articles.saveArticle({
            articleId: 'art_audit_five', article: body, title: 'Audit five', sourceType: 'paste',
            result: {
                chinese_translation: '合成译文。', word_alignment: [], detailed_analysis: [],
                paragraph_analysis: [
                    { chinese_translation: '甲。', word_alignment: [], detailed_analysis: [], sentences: [{ en: 'Alpha sentence one.', zh: '甲句一。' }, { en: 'Alpha sentence two.', zh: '甲句二。' }] },
                    { chinese_translation: '中文段落。', word_alignment: [], detailed_analysis: [], sentences: [] },
                    { chinese_translation: '乙。', word_alignment: [], detailed_analysis: [], sentences: [{ en: 'Beta sentence three.', zh: '乙句三。' }] }
                ],
                sentence_analysis: [], phrase_analysis: []
            }
        });
        if (!saved.ok) throw new Error(saved.error);
        document.querySelector('#app-modal .modal-close-btn')?.click();
        document.getElementById('article-btn').click();
        const state = await import('/modules/state.js');
        state.setCurrentArticleId('art_audit_five');
        const article = await import('/features/article/article.js');
        await article.showCurrentArticleIfAvailable();
    }, { body: BODY });
    await page.waitForSelector('.sent-analyze-btn');
    await page.waitForTimeout(400);
    try {
        const triggers = await page.locator('.sent-analyze-btn').count();
        const paragraphs = await page.evaluate(() => [...document.querySelectorAll('.paragraph-pair')].map((p) => ({
            zhSource: p.dataset.sourceLanguage === 'zh',
            buttons: p.querySelectorAll('.sent-analyze-btn').length
        })));
        info('J1 fixture', JSON.stringify({ triggers, paragraphs }));
        const zhIndex = paragraphs.findIndex((p) => p.zhSource);
        ok('J2 Chinese-source paragraph still renders a read trigger', zhIndex < 0 || paragraphs[zhIndex].buttons > 0, JSON.stringify(paragraphs));
        if (zhIndex >= 0) {
            const before = await page.evaluate(() => window.__speech.calls.length);
            const messages = [];
            page.on('console', (m) => { if (m.type() === 'error') messages.push(m.text()); });
            await page.locator('.paragraph-pair').nth(zhIndex).locator('.sent-analyze-btn').first().click();
            await page.waitForTimeout(150);
            const menuOpen = await page.locator('#article-sentence-menu:not(.hidden)').count() === 1;
            await page.locator('#article-sentence-menu [data-sentence-action="once"]').click({ timeout: 2000 }).catch((e) => info('J3 click failed', e.message));
            await page.waitForTimeout(500);
            const after = await page.evaluate(() => window.__speech.calls.length);
            const feedback = await page.evaluate(() => {
                const container = document.querySelector('#article-analysis-container');
                return [...document.querySelectorAll('.message, .toast, .ui-message, [data-message]')].map((e) => e.textContent.trim()).filter(Boolean).slice(0, 2)
                    .concat(container?.querySelector('.message') ? [container.querySelector('.message').textContent] : []);
            });
            info('J3 Chinese-source sentence read', JSON.stringify({ menuOpen, before, after, feedback }));
            ok('J4 Chinese-source sentence read gives feedback', after > before || feedback.length > 0, JSON.stringify({ after, feedback }));
            if (OUT) { fs.mkdirSync(OUT, { recursive: true }); await page.screenshot({ path: path.join(OUT, 'J-chinese-source-sentence.png') }); }
            // 從前一句接續時是否跳過中文段落
            const beforeContinue = await page.evaluate(() => window.__speech.calls.length);
            await page.locator('.sent-analyze-btn').first().click();
            await page.locator('#article-sentence-menu [data-sentence-action="continue"]').click({ timeout: 2000 }).catch(() => {});
            await page.waitForTimeout(100);
            await page.evaluate(() => window.__speech.finish());
            await page.waitForTimeout(200);
            await page.evaluate(() => window.__speech.finish());
            await page.waitForTimeout(200);
            const texts = await page.evaluate(() => window.__speech.calls.slice(-3).map((c) => c.text));
            info('J5 continue across Chinese paragraph', JSON.stringify({ beforeContinue, texts }));
        }
        ok('J6 no page errors', errors.length === 0, errors.join(' | '));
    } finally {
        await context.close();
        await browser.close();
    }
    const fails = results.filter((r) => r.status === 'FAIL');
    console.log(`\n== ${results.filter((r) => r.status === 'PASS').length} pass, ${fails.length} fail ==`);
    if (fails.length) process.exitCode = 1;
})().catch((error) => { console.error(error); process.exitCode = 1; });
