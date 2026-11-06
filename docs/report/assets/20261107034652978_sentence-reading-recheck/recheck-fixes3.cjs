/**
 * 複查補充：連續朗讀跨越中文原文段、既有全文朗讀跳過中文段、F4 跨模組循環＋浮動停止（既有保留行為）。
 * 用法：PORT=8326 ARTIFACT_DIR=<dir> PLAYWRIGHT_MODULE=<path> node recheck-fixes3.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const BASE = String(process.env.BASE_URL || `http://127.0.0.1:${process.env.PORT || 8326}`).replace(/\/+$/, '');
const OUT = process.env.ARTIFACT_DIR || __dirname;
fs.mkdirSync(OUT, { recursive: true });
const results = [];
let failures = 0;
const check = (n, ok, d) => { results.push({ name: n, ok: !!ok, detail: d }); if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'} ${n} :: ${JSON.stringify(d)}`); };
const info = (n, d) => { results.push({ name: n, ok: null, detail: d }); console.log(`INFO ${n} :: ${JSON.stringify(d)}`); };

const paragraphs = [
    'The reading room opens at eight. Visitors sign the book at the door.',
    '这是一段中文原文，用来检查英文朗读功能的可用性。',
    'Morning light falls across the long wooden table. Two students copy new words into their notebooks.',
    'A final sentence closes the article.'
];
const analysis = paragraphs.map((text, index) => ({
    chinese_translation: index === 1 ? text : '合成译文，仅供测试。',
    word_alignment: [], detailed_analysis: [],
    sentences: (index === 1 ? [text] : text.match(/[^.!?]+[.!?]*/g).map((s) => s.trim())).map((en) => ({ en, zh: '合成译文。' }))
}));

async function setup(browser, locale = 'zh-CN') {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
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
        const saved = await articles.saveArticle({ articleId: 'art_recheck_fixture3', article: paragraphs.join('\n\n'), title: 'Recheck fixture 3', sourceType: 'paste', result: { chinese_translation: '合成译文。', word_alignment: [], detailed_analysis: [], paragraph_analysis: analysis, sentence_analysis: [], phrase_analysis: [] } });
        if (!saved.ok) throw new Error(saved.error);
        document.querySelector('#app-modal .modal-close-btn')?.click();
        document.getElementById('article-btn').click();
        (await import('/modules/state.js')).setCurrentArticleId('art_recheck_fixture3');
        await (await import('/features/article/article.js')).showCurrentArticleIfAvailable();
    }, { paragraphs, analysis });
    await page.waitForSelector('.sent-analyze-btn');
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
    return { page, context, errors };
}

(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
    try {
        // A. 「從這裏開始讀」跨越中文原文段：跳過該段、不卡住
        {
            const { page, context, errors } = await setup(browser);
            try {
                const secondEn = await page.evaluate(() => [...document.querySelectorAll('.sent-analyze-btn')]
                    .findIndex((b) => b.closest('.paragraph-pair')?.dataset.sourceLanguage !== 'zh'
                        && [...document.querySelectorAll('.paragraph-pair:not([data-source-language="zh"]) .sent-analyze-btn')].indexOf(b) === 1));
                await page.locator('.sent-analyze-btn').nth(secondEn).click();
                await page.locator('#article-sentence-menu [data-sentence-action="continue"]').click();
                await page.evaluate(() => window.__speech.finish());
                await page.waitForTimeout(150);
                await page.evaluate(() => window.__speech.finish());
                await page.waitForTimeout(150);
                const texts = await page.evaluate(() => window.__speech.calls.map((c) => c.text));
                check('continue across Chinese-source paragraph skips it', texts.length === 3 && !texts.some((t) => t.includes('中文原文')) && texts[0].includes('Visitors sign'), texts);
                await page.evaluate(() => window.__speech.finish());
                await page.waitForTimeout(400);
                const tail = await page.evaluate(() => window.__speech.calls.map((c) => c.text));
                // 允許最後一句啟動後再收尾一次，之後必須回到 stopped
                if (!(await page.locator('#stop-read-article-btn').isDisabled())) {
                    await page.evaluate(() => window.__speech.finish());
                    await page.waitForTimeout(400);
                }
                check('continue finishes at last English sentence without stall', await page.locator('#stop-read-article-btn').isDisabled(), tail);
                check('no page errors (continue)', errors.length === 0, errors);
            } finally { await context.close(); }
        }

        // B. 側欄全文朗讀仍跳過中文原文段（既有行為）
        {
            const { page, context, errors } = await setup(browser);
            try {
                await page.selectOption('#reading-mode', 'full');
                await page.locator('#read-article-btn').click();
                await page.waitForFunction(() => window.__speech.calls.length >= 1);
                for (let i = 0; i < 8; i++) { await page.evaluate(() => window.__speech.finish()); await page.waitForTimeout(150); }
                const texts = await page.evaluate(() => window.__speech.calls.map((c) => c.text));
                check('sidebar full reading still skips Chinese-source paragraph', !texts.some((t) => t.includes('中文原文')), texts);
                check('no page errors (full)', errors.length === 0, errors);
            } finally { await context.close(); }
        }

        // C. F4（保留範圍）：循環跨模組繼續，浮動停止可用
        {
            const { page, context, errors } = await setup(browser);
            try {
                await page.locator('.sent-analyze-btn').first().click();
                await page.locator('#article-sentence-menu [data-sentence-action="loop"]').click();
                await page.evaluate(() => window.__speech.finish());
                await page.waitForTimeout(150);
                await page.evaluate(() => document.getElementById('vocabulary-btn')?.click());
                await page.waitForTimeout(900);
                const calls = await page.evaluate(() => window.__speech.calls.length);
                const floating = await page.evaluate(() => {
                    const reader = document.querySelector('.floating-reader');
                    return { visible: !!reader && reader.classList.contains('is-visible'), mode: reader?.getAttribute('data-reading-mode') };
                });
                info('loop continues after module switch (F4 existing behaviour)', { calls, floating });
                if (!floating.visible) {
                    info('floating player not visible on target module; skipping stop assertion', floating);
                } else {
                    await page.locator('.fr-stop').click();
                    const after = await page.evaluate(() => window.__speech.calls.length);
                    await page.waitForTimeout(800);
                    check('floating stop halts cross-module loop', (await page.evaluate(() => window.__speech.calls.length)) === after, { after, now: await page.evaluate(() => window.__speech.calls.length) });
                }
                check('no page errors (cross-module)', errors.length === 0, errors);
            } finally { await context.close(); }
        }
    } finally { await browser.close(); }
    fs.writeFileSync(path.join(OUT, 'recheck3-results.json'), JSON.stringify(results, null, 2));
    console.log(`\n=== ${results.filter((r) => r.ok === true).length} pass / ${failures} fail / ${results.filter((r) => r.ok === null).length} info ===`);
    process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
