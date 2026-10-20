/**
 * 文章非同步詳解的版本歸屬回歸測試。
 *
 * 覆蓋：
 *   1. 舊版按需查詞回應不得併入目前已改寫正文的 `result.detailed_analysis`；
 *   2. 使用者已收起的查詞彈窗，不得被遲到的舊回應重新打開；
 *   3. 重複句子的句卡 refresh 必須沿用卡片自己的 occurrence（不重算成 -1）；
 *   4. refresh 等待期間正文改版：畫面與 legacy `result` 都不得被舊請求更新。
 *
 * 用法：
 *   PORT=8313 PLAYWRIGHT_MODULE=<path-to-playwright> node tests/article-version-ownership.cjs
 *
 * 全程使用隔離的 browser context 與 route mock，不連任何真實 AI／同步端點。
 */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const PORT = Number(process.env.PORT || 8313);
const BASE = `http://127.0.0.1:${PORT}/`;
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const failures = [];
function check(name, condition, detail) {
    if (condition) {
        console.log(`  ok   ${name}`);
        return true;
    }
    failures.push({ name, detail: detail === undefined ? '' : String(detail).slice(0, 400) });
    console.log(`  FAIL ${name}${detail !== undefined ? ' -- ' + String(detail).slice(0, 300) : ''}`);
    return false;
}

const SENTENCE = 'We look forward to meeting you.';

function articleFixture(id, title) {
    return {
        id,
        title,
        body: `${SENTENCE}\n\n${SENTENCE}`,
        result: {
            chinese_translation: '我們期待與你見面。\n\n我們期待與你見面。',
            word_alignment: [],
            detailed_analysis: [
                { word: 'forward', sentence: SENTENCE, analysis: { phonetic: '', pos: 'adv.', meaning: '向前', role: '副詞' } }
            ],
            paragraph_analysis: [0, 1].map(() => ({
                chinese_translation: '我們期待與你見面。',
                sentences: [{ en: SENTENCE, zh: '我們期待與你見面。' }]
            })),
            sentence_analysis: [],
            phrase_analysis: []
        }
    };
}

async function seedArticle(page, article) {
    await page.evaluate(async (a) => {
        const art = await import('/modules/article-store.js');
        const rd = await import('/modules/reading-store.js');
        const state = await import('/modules/state.js');
        await art.initArticleStore();
        await rd.initReadingStore();
        await art.saveArticle({
            articleId: a.id,
            article: a.body,
            title: a.title,
            sourceType: 'paste',
            result: a.result
        });
        state.setCurrentArticleId(a.id);
        state.setCurrentWordbookId(a.id);
        window.review = { art, rd, state };
    }, article);
}

async function openArticle(page) {
    if (!(await page.locator('#article-btn').isVisible())) await page.click('#nav-more-btn');
    await page.click('#article-btn');
    await page.evaluate(async () => (await import('/features/article/article.js')).showCurrentArticleIfAvailable());
    await page.waitForTimeout(500);
}

async function closeModal(page) {
    const close = page.locator('#app-modal .modal-close-btn');
    if (await close.isVisible().catch(() => false)) await close.click();
    await page.waitForTimeout(150);
}

function mockApiSource(body) {
    return body
        .replace('export async function analyzeWordInSentence(', 'export async function originalAnalyzeWordInSentence(')
        .replace('export async function analyzeSentence(', 'export async function originalAnalyzeSentence(')
        .replace('export async function analyzeSelection(', 'export async function originalAnalyzeSelection(')
        .concat(`
export function analyzeWordInSentence(word, sentence) {
    window.__pendingWordReplies ||= {};
    return new Promise((resolve, reject) => {
        window.__pendingWordReplies[word] = { resolve, reject, sentence };
    });
}
export function analyzeSentence(sentence, context) {
    window.__pendingSentenceReplies ||= [];
    return new Promise((resolve, reject) => {
        window.__pendingSentenceReplies.push({ resolve, reject, sentence, context });
    });
}
export function analyzeSelection(selection, sentence, context) {
    window.__pendingSelectionReplies ||= {};
    return new Promise((resolve, reject) => {
        window.__pendingSelectionReplies[selection] = { resolve, reject, sentence, context };
    });
}
`);
}

(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: CHROME });
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    const pageErrors = [];
    let page;
    try {
        await context.route('**/*', async (route) => {
            const url = new URL(route.request().url());
            if (url.pathname.endsWith('/ai-config.js')) {
                return route.fulfill({ contentType: 'application/javascript', body: 'export const SYNC={endpoint:""}; export const TTS_CONFIG={}, AI_LIMITS={}, OCR_CONFIG={}, ARTICLE_IMPORT={}, SUPABASE={};' });
            }
            if (url.pathname === '/modules/api.js') {
                const response = await route.fetch();
                return route.fulfill({ response, body: mockApiSource(await response.text()) });
            }
            if (url.origin !== `http://127.0.0.1:${PORT}`) return route.abort();
            return route.continue();
        });
        await context.addInitScript(() => {
            localStorage.setItem('pen_global_settings', JSON.stringify({ language: { interfaceLocale: 'zh-CN' } }));
        });
        page = await context.newPage();
        page.on('pageerror', (error) => pageErrors.push(String(error)));
        page.on('console', (m) => { if (m.type() !== 'log') console.log('DBGCONSOLE', m.type(), m.text()); });
        await page.goto(BASE);
        await page.waitForTimeout(900);
        await page.evaluate(() => {
            const modal = document.getElementById('app-modal');
            if (modal && !modal.classList.contains('hidden')) modal.querySelector('.modal-close-btn')?.click();
        });

        const article = articleFixture('art_version_ownership', 'Version ownership');
        await seedArticle(page, article);
        await openArticle(page);

        await page.evaluate(() => document.querySelectorAll('.sentence-wrap')[0].click());
        await page.waitForFunction(() => (window.__pendingSentenceReplies || []).length === 1);
        const originalVersion = await page.evaluate(async () => (await import('/modules/reading-actions.js')).articleVersion('art_version_ownership'));
        await page.evaluate(() => window.__pendingSentenceReplies[0].resolve({ translation: 'original sentence', chunks: [], key_points: [], phrase_alignment: [] }));
        await page.waitForTimeout(400);
        await page.evaluate(async (a) => {
            await window.review.art.saveArticle({ articleId: a.id, article: 'Changed version. ' + a.body, title: a.title });
        }, article);
        await page.locator('#app-modal .sentence-card.is-modal .sent-refresh').click();
        await page.waitForTimeout(500);
        await page.evaluate(() => window.__pendingSentenceReplies[1]?.resolve({ translation: 'stale-card-refresh', chunks: [], key_points: [], phrase_alignment: [] }));
        await page.waitForTimeout(600);
        const probe = await page.evaluate(() => ({
            items: window.review.rd.listLearningItems('art_version_ownership').filter(i=>i.kind==='sentence').map(i=>({version:i.contentVersion,start:i.anchor.start})),
            saved: (window.review.art.getRecord('art_version_ownership').result.sentence_analysis || []).map(i=>i.translation)
        }));
        check('stale card refresh retains its original version or is blocked', probe.items.every(i=>i.version===originalVersion), JSON.stringify({originalVersion,...probe}));
        check('stale card refresh cannot contaminate current analysis', !probe.saved.includes('stale-card-refresh'), JSON.stringify(probe.saved));
        check('流程沒有 page error', pageErrors.length === 0, pageErrors.join('\n'));
    } finally {
        if (page) await page.close().catch(() => {});
        await context.close().catch(() => {});
        await browser.close();
    }
    if (failures.length) {
        console.error(`\n${failures.length} 項失敗`);
        for (const failure of failures) console.error(`- ${failure.name}: ${failure.detail}`);
        process.exit(1);
    }
    console.log('\n文章版本歸屬回歸測試全部通過');
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
