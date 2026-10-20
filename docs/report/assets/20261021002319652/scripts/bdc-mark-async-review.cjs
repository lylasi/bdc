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
            await ctx.route('**/*', async route => {
                const url = new URL(route.request().url());
                if (url.pathname.endsWith('/ai-config.js')) return route.fulfill({ contentType: 'application/javascript', body: 'export const SYNC={endpoint:""};export const TTS_CONFIG={},AI_LIMITS={},OCR_CONFIG={},ARTICLE_IMPORT={},SUPABASE={};' });
                if (url.pathname === '/modules/api.js') {
                    const response = await route.fetch();
                    const body = (await response.text()).replace('export async function analyzeWordInSentence(', 'export async function originalAnalyzeWordInSentence(');
                    return route.fulfill({ response, body: body + '\nexport function analyzeWordInSentence(word, sentence) { window.__pendingReplies ||= {}; return new Promise((resolve, reject) => { window.__pendingReplies[word] = { resolve, reject, sentence }; }); }' });
                }
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
                        detailed_analysis: [{ word: 'forward', sentence: a.sentence, analysis: { phonetic: '', pos: 'adv.', meaning: '向前', role: '副词' } }],
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
            await page.locator('.interactive-word[data-word="look"]').first().click();
            await page.waitForFunction(() => !!window.__pendingReplies?.look);
            await page.mouse.click(8, height - 100);
            await page.locator('.interactive-word[data-word="forward"]').first().click();
            await page.waitForTimeout(200);
            await page.evaluate(() => window.__pendingReplies.look.resolve({word:'look', analysis:{meaning:'看', pos:'v.', role:'动词',phonetic:''}}));
            await page.waitForTimeout(400);
            const title = await page.locator('#word-analysis-tooltip .tooltip-title').textContent();
            check('late word response cannot replace newer selected word', title.includes('forward'), title);
            await page.mouse.click(8, height - 100);
            await page.locator('.interactive-word[data-word="meeting"]').first().click();
            await page.waitForFunction(() => !!window.__pendingReplies?.meeting);
            const originalVersion = await page.evaluate(() => window.review.act.articleVersion('art_mark_ui_review'));
            await page.evaluate(async a => {
                await window.review.art.saveArticle({articleId:a.id, article:'A changed version. '+a.body,title:a.title});
                window.__pendingReplies.meeting.resolve({word:'meeting',analysis:{meaning:'见面',pos:'v.',role:'动名词',phonetic:''}});
            }, article);
            await page.waitForTimeout(400);
            const meetingItems = await page.evaluate(() => window.review.rd.listLearningItems('art_mark_ui_review').filter(x=>x.anchor.quote==='meeting'));
            check('late response retains original version or is ignored', meetingItems.every(x=>x.contentVersion===originalVersion),meetingItems.map(x=>({version:x.contentVersion,start:x.anchor.start})));
            await page.mouse.click(8, height - 100);
            await page.locator('.interactive-word[data-word="We"]').first().click();
            await page.waitForFunction(() => !!window.__pendingReplies?.We);
            const switched = await page.evaluate(async a => {
                await window.review.art.reloadScope('mark-review::new-account');
                await window.review.rd.reloadReadingScope('mark-review::new-account');
                await window.review.art.saveArticle({articleId:a.id,article:a.body,title:'Other account'});
                window.__pendingReplies.We.resolve({word:'We',analysis:{meaning:'我们',pos:'pron.',role:'代词',phonetic:''}});
            },article);
            await page.waitForTimeout(400);
            const newScopeItems = await page.evaluate(() => window.review.rd.listLearningItems('art_mark_ui_review'));
            check('late response cannot write into switched account with same article ID',newScopeItems.length===0,newScopeItems.map(x=>x.anchor.quote));
            await ctx.close();
        }
    } finally {
        await browser.close();
        if (process.env.ASSET_DIR) fs.writeFileSync(path.join(process.env.ASSET_DIR, 'independent-async-review.json'), JSON.stringify(checks, null, 2));
    }
    if (checks.some(x => !x.pass)) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
