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
        for (const [locale, width, height] of [['zh-CN', 1440, 960], ['zh-HK', 390, 844], ['zh-CN', 320, 844]]) {
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
            const words = page.locator('.interactive-word[data-word="look"]');
            check(`${prefix} two repeated words visible`, await words.count() === 2);
            await words.nth(1).click();
            await page.waitForTimeout(150);
            const mark = page.locator('#word-analysis-tooltip .btn-toggle-mark');
            check(`${prefix} lookup alone does not underline`, await page.locator('.reading-mark-active').count() === 0);
            await mark.click();
            await page.waitForTimeout(300);
            const underlined = await words.evaluateAll(els => els.map(el => el.classList.contains('reading-mark-active')));
            check(`${prefix} manual mark is exact second occurrence`, underlined[0] === false && underlined[1] === true, underlined);
            await page.mouse.click(8, height - 100);
            await words.nth(0).click();
            await page.waitForTimeout(200);
            await page.mouse.click(8, height - 100);
            await words.nth(1).click();
            await page.waitForTimeout(150);
            check(`${prefix} reopened second popup displays Cancel mark`, await mark.getAttribute('aria-pressed') === 'true', await mark.textContent());
            await page.locator('#word-analysis-tooltip .btn-note-item').click();
            await page.waitForTimeout(300);
            const focus = await page.evaluate(() => ({ tag: document.activeElement?.tagName, id: document.activeElement?.getAttribute('data-note-id') }));
            check(`${prefix} write-note focuses exact note field`, focus.tag === 'TEXTAREA' && !!focus.id, focus);
            const note = page.locator(`textarea[data-note-id="${focus.id}"]`);
            if (focus.id) {
                await note.fill(locale === 'zh-HK' ? '這裏記錄用法：look forward to 後接動名詞。' : '这里记录用法：look forward to 后接动名词。');
                await page.waitForTimeout(700);
                await page.locator(`.reading-item[data-item-id="${focus.id}"] [data-mark-toggle]`).click();
                await page.waitForTimeout(250);
                const item = await page.evaluate(id => window.review.rd.getLearningItem(id), focus.id);
                check(`${prefix} unmark preserves typed note`, item.marked === false && item.note.includes('look forward to'));
            }
            check(`${prefix} old understanding controls removed`, await page.locator('[data-understanding], [data-filter="needs"]').count() === 0);
            const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
            check(`${prefix} page has no horizontal overflow`, !overflow);
            if (process.env.ASSET_DIR) {
                fs.mkdirSync(process.env.ASSET_DIR, { recursive: true });
                await page.screenshot({ path: path.join(process.env.ASSET_DIR, `${prefix}-retained-note.png`) });
            }
            await ctx.close();
        }
    } finally {
        await browser.close();
        if (process.env.ASSET_DIR) fs.writeFileSync(path.join(process.env.ASSET_DIR, 'independent-ui-review.json'), JSON.stringify(checks, null, 2));
    }
    if (checks.some(x => !x.pass)) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
