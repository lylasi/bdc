// Run against deployed assets in isolated contexts; AI and sync stay mocked.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../../../..');
const mock = require(path.join(root, 'tests/helpers/article-mock.cjs'));
const base = (process.env.BASE_URL || 'https://bdc.a4a4.qzz.io').replace(/\/$/, '');
const release = '3d9ab3f1165f';
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const checks = [];
const resources = [];
const viewportFilter = Number(process.env.VIEWPORT_FILTER || 0);
const articleId = 'art_production_reading_smoke';
const sentence = 'A leader can also listen.';
const doc = {
    id: articleId, title: 'Reading deployment check', sourceType: 'paste', revision: 0,
    body: `${sentence}\n\nThe reading room opens at eight.`,
    createdAt: '2026-10-28T00:00:00.000Z', updatedAt: '2026-10-28T00:00:00.000Z',
    analysis: {
        chinese_translation: '領導者也會聆聽。\n\n閱覽室八點開門。',
        word_alignment: [], sentence_analysis: [], phrase_analysis: [],
        detailed_analysis: [{ word: 'leader', sentence, analysis: {
            meaning: '帶領團隊的人', phonetic: 'ˈliːdə', pos: 'noun', role: '主語'
        } }],
        paragraph_analysis: [
            { chinese_translation: '領導者也會聆聽。', word_alignment: [], detailed_analysis: [] },
            { chinese_translation: '閱覽室八點開門。', word_alignment: [], detailed_analysis: [] }
        ]
    }
};
function check(name, pass, detail) {
    checks.push({ name, pass: !!pass, detail });
    console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`);
    assert.ok(pass, `${name}: ${JSON.stringify(detail)}`);
}
async function activateAction(page, selector, width) {
    const action = page.locator(selector);
    if (!await action.isVisible()) {
        const more = page.locator('#article-reader-more-toggle');
        await more.waitFor({ state: 'visible' });
        if (width < 500) await more.tap(); else await more.click();
    }
    if (width < 500) await action.tap(); else await action.click();
}
(async () => {
    const browser = await chromium.launch({ executablePath: mock.CHROME, headless: true });
    try {
        for (const [locale, width] of [['zh-CN', 1280], ['zh-HK', 390], ['zh-CN', 320]]) {
            if (viewportFilter && width !== viewportFilter) continue;
            const prefix = `${locale}-${width}`;
            const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 500, isMobile: width < 500 });
            await mock.initScript(context, { locale });
            await context.addInitScript(() => {
                const settings = JSON.parse(localStorage.getItem('pen_global_settings'));
                settings.reading = { ...settings.reading, articleSidebarCollapsed: true, translationMask: false };
                settings.assistant = { ...settings.assistant, stream: false, panelMode: 'floating' };
                localStorage.setItem('pen_global_settings', JSON.stringify(settings));
            });
            await context.route('**/*', (route) => {
                const url = new URL(route.request().url());
                if (url.pathname === '/ai-config.js') return route.fulfill({
                    contentType: 'application/javascript',
                    body: `export const SYNC={endpoint:${JSON.stringify(mock.ENDPOINT)}}; export const TTS_CONFIG={},AI_LIMITS={},OCR_CONFIG={},ARTICLE_IMPORT={},SUPABASE={};`
                });
                if (url.origin !== base) return route.abort();
                return route.continue();
            });
            const page = await context.newPage();
            const pageErrors = [];
            const responseChecks = [];
            page.on('pageerror', (error) => pageErrors.push(error.message));
            page.on('response', (response) => {
                const url = new URL(response.url());
                if (url.origin !== base || !(/^\/(modules|features|locales|shared)\/.*\.(js|mjs)$/.test(url.pathname)
                    || ['/main.js', '/styles.css', '/'].includes(url.pathname))) return;
                responseChecks.push((async () => {
                    const body = await response.body();
                    const local = path.join(root, url.pathname.slice(1) || 'index.html');
                    return { viewport: prefix, path: url.pathname, query: url.search,
                        status: response.status(), sha256: digest(body), expected: digest(fs.readFileSync(local)) };
                })().catch((error) => ({ viewport: prefix, path: url.pathname, error: error.message })));
            });
            await mock.installProviderRoutes(page, ({ route }) => mock.jsonReply(route, 'DEPLOY-SMOKE-OK'));
            await page.route(mock.ENDPOINT + '/**', (route) => route.fulfill({ status: 401, body: '{}' }));
            await page.goto(base + '/#a', { waitUntil: 'domcontentloaded' });
            try {
                await page.waitForFunction(() => !!window.__assistant?.openWord, null, { timeout: 60000 });
            } catch (error) {
                console.error('Startup diagnostics', JSON.stringify({ viewport: prefix, pageErrors, responses: await Promise.all(responseChecks) }));
                throw error;
            }
            await page.evaluate(() => document.querySelector('#app-modal:not(.hidden) .modal-close-btn')?.click());
            await mock.seedDocs(page, [doc]);
            await page.evaluate(async () => (await import('/modules/article-store.js')).reloadScope());
            await activateAction(page, '#article-history-btn', width);
            await page.locator(`.ar-history-item[data-key="${articleId}"] .ar-history-open`).click();
            await page.locator('.paragraph-pair[data-paragraph-index="1"]').waitFor();
            check(`${prefix} compact toolbar and collapsed sidebar`,
                !await page.locator('#article-sidebar').isVisible() && await page.locator('#article-compact-controls').isVisible());
            await activateAction(page, '#article-input-toggle', width);
            check(`${prefix} input expands from toolbar`, await page.locator('#article-input').isVisible());
            await page.locator('#article-input-close').click();
            await page.locator('#article-compact-speed-toggle').click();
            await page.locator('#article-compact-speed-panel > span').first().click();
            check(`${prefix} speed panel remains open after click`, await page.locator('#article-compact-speed-panel').isVisible());
            await page.locator('#article-compact-speed').press('End');
            check(`${prefix} speed updates`, await page.locator('#article-compact-speed-value').innerText() === 'x1.5');
            await page.keyboard.press('Escape');
            const geometry = await page.locator('.paragraph-pair').first().evaluate((node) => {
                const english = node.querySelector('.paragraph-english').getBoundingClientRect();
                const chinese = node.querySelector('.paragraph-chinese').getBoundingClientRect();
                const refresh = node.querySelector('.retry-paragraph-btn').getBoundingClientRect();
                return { footer: node.getBoundingClientRect().bottom - chinese.bottom,
                    refreshInside: refresh.top >= chinese.top && refresh.bottom <= chinese.bottom,
                    englishPadding: parseFloat(getComputedStyle(node.querySelector('.paragraph-english')).paddingRight),
                    hit: node.querySelector('.retry-paragraph-btn').contains(document.elementFromPoint(refresh.x + refresh.width / 2, refresh.y + refresh.height / 2)) };
            });
            check(`${prefix} compact paragraph refresh`, geometry.footer <= 2 && geometry.refreshInside && geometry.englishPadding < 32 && geometry.hit, geometry);
            const toolbar = await page.locator('#article-reader-head').boundingBox();
            check(`${prefix} toolbar remains one row`, toolbar.height <= 64, toolbar);
            if (width < 500) {
                await page.locator('#article-reader-more-toggle').tap();
                check(`${prefix} overflow menu opens on touch`, await page.locator('#article-reader-menu').isVisible());
                await page.screenshot({ path: path.join(__dirname, `${prefix}-toolbar-more.png`),
                    style: '#message-container { visibility: hidden !important; }' });
                await page.locator('#import-article-btn').tap();
                await page.locator('#app-modal .import-tabbar').waitFor();
                check(`${prefix} overflow import responds to touch`, !await page.locator('#article-reader-menu').isVisible());
                await page.locator('#app-modal .modal-close-btn').tap();
            } else {
                check(`${prefix} wide toolbar shows all actions`, !await page.locator('#article-reader-more-toggle').isVisible());
            }
            await page.screenshot({ path: path.join(__dirname, `${prefix}-reading.png`),
                style: '#message-container { visibility: hidden !important; }' });
            await page.locator('.interactive-word[data-word="leader"]').click();
            const tooltip = page.locator('#word-analysis-tooltip');
            await tooltip.locator('.tooltip-meaning').waitFor();
            check(`${prefix} word refresh remains available`, await tooltip.locator('.btn-refresh-word').isVisible());
            const actions = await tooltip.locator('.tooltip-primary-actions > button, .tooltip-more > summary').evaluateAll((nodes) =>
                nodes.map((node) => ({ top: node.getBoundingClientRect().top, label: node.getAttribute('aria-label') })));
            check(`${prefix} five labeled actions in one row`, actions.length === 5
                && actions.every((item) => !!item.label && Math.abs(item.top - actions[0].top) < 1), actions);
            await tooltip.locator('.tooltip-more > summary').click();
            await tooltip.locator('.tooltip-more-body:popover-open').waitFor();
            check(`${prefix} note and phrase menu`, await tooltip.locator('.btn-note-item').isVisible()
                && await tooltip.locator('.btn-pick-phrase').isVisible());
            await page.screenshot({ path: path.join(__dirname, `${prefix}-menu.png`),
                style: '#message-container { visibility: hidden !important; }' });
            await page.keyboard.press('Escape');
            await tooltip.locator('.btn-ask-word-ai').click();
            const chat = tooltip.locator('.word-chat');
            await chat.waitFor();
            await page.waitForFunction(() => document.querySelector('.word-chat-send')?.disabled === false);
            check(`${prefix} AI expands inside word card`, await tooltip.isVisible() && !await page.locator('#assistant-panel').isVisible());
            await chat.locator('[data-assistant-input]').fill('Explain this word in context.');
            await chat.locator('[data-assistant-input]').press('Enter');
            await chat.locator('.assistant-assistant').filter({ hasText: 'DEPLOY-SMOKE-OK' }).waitFor();
            await page.waitForFunction(() => document.querySelector('.word-chat .assistant-assistant')?.dataset.messageStatus === 'complete');
            check(`${prefix} inline AI round trip with mock provider`, true);
            check(`${prefix} no horizontal page overflow`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
            await page.screenshot({ path: path.join(__dirname, `${prefix}-inline-ai.png`),
                style: '#message-container { visibility: hidden !important; }' });
            const loaded = await Promise.all(responseChecks);
            resources.push(...loaded);
            const bad = loaded.filter((item) => item.error || item.status !== 200 || item.sha256 !== item.expected
                || (item.path !== '/' && item.query !== `?v=${release}`));
            check(`${prefix} browser-loaded resources match release`, loaded.length > 60 && !bad.length, { count: loaded.length, bad });
            check(`${prefix} no page errors`, pageErrors.length === 0, pageErrors);
            await context.close();
        }
    } finally {
        await browser.close();
        fs.writeFileSync(path.join(__dirname, `browser-checks${viewportFilter ? '-' + viewportFilter : ''}.json`),
            JSON.stringify({ base, checks, resources }, null, 2) + '\n');
    }
    console.log(`PASS ${checks.length} production browser checks; ${resources.length} resource responses`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
