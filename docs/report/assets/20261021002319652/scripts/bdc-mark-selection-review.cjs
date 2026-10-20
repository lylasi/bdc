const { chromium } = require('/Users/linus/.npm/_npx/e41f203b7505f1fb/node_modules/playwright');
const fs = require('node:fs');
const path = require('node:path');
const BASE = 'http://127.0.0.1:8313';
const checks = [];
const check = (name, pass, detail) => {
    checks.push({ name, pass: !!pass, detail });
    console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`, detail === undefined ? '' : JSON.stringify(detail));
};
const article = {
    id: 'art_mark_ui_review',
    title: 'Meeting follow-up',
    sentence: 'We look forward to meeting you.',
    body: 'We look forward to meeting you.\n\nWe look forward to meeting you.'
};
(async () => {
    const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
    try {
        for (const [locale, width, height] of [['zh-CN', 1440, 960]]) {
            const prefix = `${locale}-${width}`;
            const ctx = await browser.newContext({ viewport: { width, height }, isMobile: width < 500, hasTouch: width < 500 });
            await ctx.route('**/*', route => {
                const url = new URL(route.request().url());
                if (url.pathname.endsWith('/ai-config.js')) return route.fulfill({ contentType: 'application/javascript', body: 'export const SYNC={endpoint:""};export const TTS_CONFIG={},AI_LIMITS={},OCR_CONFIG={},ARTICLE_IMPORT={},SUPABASE={};' });
                if (url.origin !== BASE) return route.abort();
                return route.continue();
            });
            await ctx.addInitScript(locale => localStorage.setItem('pen_global_settings', JSON.stringify({ language: { interfaceLocale: locale } })), locale);
            const page = await ctx.newPage();
            await page.goto(BASE);
            await page.waitForTimeout(1000);
            await page.evaluate(async a => {
                document.querySelector('#app-modal .modal-close-btn')?.click();
                const art = await import('/modules/article-store.js');
                const rd = await import('/modules/reading-store.js');
                const act = await import('/modules/reading-actions.js');
                const state = await import('/modules/state.js');
                await art.initArticleStore();
                await rd.initReadingStore();
                await art.saveArticle({
                    articleId: a.id, article: a.body, title: a.title, sourceType: 'paste',
                    result: {
                        chinese_translation: '我们期待与你见面。\n\n我们期待与你见面。',
                        detailed_analysis: [{ word: 'look', sentence: a.sentence, analysis: { phonetic: 'lʊk', pos: 'v.', meaning: '看；期待', role: '动词' } }],
                        paragraph_analysis: [0, 1].map(() => ({ chinese_translation: '我们期待与你见面。', sentences: [{ en: a.sentence, zh: '我们期待与你见面。' }] })),
                        word_alignment: [], sentence_analysis: [], phrase_analysis: []
                    }
                });
                state.setCurrentArticleId(a.id);
                state.setCurrentWordbookId(a.id);
                window.review = { art, rd, act, state };
            }, article);
            if (!(await page.locator('#article-btn').isVisible())) await page.click('#nav-more-btn');
            await page.click('#article-btn');
            await page.evaluate(async () => (await import('/features/article/article.js')).showCurrentArticleIfAvailable());
            await page.waitForTimeout(500);
            async function selectWord(index) {
                await page.evaluate(i => {
                    const words = document.querySelectorAll('.interactive-word[data-word="look"]');
                    const range = document.createRange(); range.selectNodeContents(words[i]);
                    const sel=window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
                    document.dispatchEvent(new Event('selectionchange'));
                }, index);
                await page.waitForTimeout(200);
            }
            await selectWord(1);
            const mark = page.locator('.article-selection-bar [data-act="mark"]');
            await mark.click();
            await page.waitForTimeout(200);
            check('native selection marks second occurrence',await page.locator('.interactive-word[data-word="look"]').nth(1).evaluate(el=>el.classList.contains('reading-mark-active')));
            await selectWord(0);
            check('new unmarked selection resets button state',await mark.getAttribute('aria-pressed')==='false',await mark.textContent());
            await page.mouse.click(8,height-100);
            await selectWord(1);
            check('marked selection displays cancel',await mark.getAttribute('aria-pressed')==='true',await mark.textContent());
            await ctx.close();
        }
    } finally {
        await browser.close();
        if (process.env.ASSET_DIR) fs.writeFileSync(path.join(process.env.ASSET_DIR, 'independent-selection-review.json'), JSON.stringify(checks, null, 2));
    }
    if (checks.some(x => !x.pass)) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
