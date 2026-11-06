/**
 * 獨立審查第三輪：語速沿用、過期正文、離開 route 後的停止能力、aria 狀態、循環間隔分布。
 * PORT=8313 PLAYWRIGHT_MODULE=<pw> node independent-sentence-audit3.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const BASE = `http://127.0.0.1:${process.env.PORT || 8313}`;
const OUT = process.env.ARTIFACT_DIR || '';
const SENT = ['Alpha sentence one.', 'Alpha sentence two.', 'Beta sentence three.', 'Beta sentence four.'];
const ZH = ['甲句一。', '甲句二。', '乙句三。', '乙句四。'];
const BODY = SENT.slice(0, 2).join(' ') + '\n\n' + SENT.slice(2).join(' ');

const results = [];
function record(id, status, detail = '') {
    results.push({ id, status, detail });
    console.log(`${status} ${id}${detail ? ' :: ' + detail : ''}`);
}
const ok = (id, cond, detail = '') => { record(id, cond ? 'PASS' : 'FAIL', cond ? '' : detail); return !!cond; };
const info = (id, detail) => record(id, 'INFO', detail);

async function setup(browser, { locale = 'zh-CN', width = 1280, height = 960, mobile = false } = {}) {
    const context = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile });
    const external = [];
    await context.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === '/ai-config.js') return route.fulfill({
            contentType: 'application/javascript',
            body: 'export const SYNC={endpoint:""}; export const TTS_CONFIG={}, AI_LIMITS={}, OCR_CONFIG={}, ARTICLE_IMPORT={}, SUPABASE={};'
        });
        if (url.origin !== BASE) { external.push(route.request().url()); return route.abort(); }
        return route.continue();
    });
    await context.addInitScript((locale) => {
        window.__BDC_SYNC_ENDPOINT__ = 'http://127.0.0.1:19999/independent-audit';
        localStorage.setItem('pen_global_settings', JSON.stringify({ language: { interfaceLocale: locale } }));
        const speech = window.__speech = { calls: [], current: null };
        speech.finish = () => { const c = speech.current; speech.current = null; c?.onend?.(); };
        Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: class { constructor(text) { this.text = text; } } });
        Object.defineProperty(window, 'speechSynthesis', { value: {
            getVoices: () => [{ lang: 'en-US', name: 'Test English', voiceURI: 'test' }],
            addEventListener() {}, removeEventListener() {},
            cancel() { speech.current = null; },
            speak(u) { speech.current = u; speech.calls.push({ text: u.text, at: Date.now(), rate: u.rate, lang: u.lang }); queueMicrotask(() => u.onstart?.()); }
        } });
    }, locale);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const booted = page.waitForEvent('console', { predicate: (m) => m.text().startsWith('应用程序已') });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await booted;
    await page.waitForFunction(() => !!document.getElementById('article-btn'));
    await page.evaluate(async ({ sent, zh, body }) => {
        const articles = await import('/modules/article-store.js');
        const reading = await import('/modules/reading-store.js');
        await articles.initArticleStore();
        await reading.initReadingStore();
        const paras = [[0, 2], [2, 4]].map(([from, to]) => ({
            chinese_translation: '合成译文，仅供测试。', word_alignment: [], detailed_analysis: [],
            sentences: sent.slice(from, to).map((en, i) => ({ en, zh: zh[from + i] }))
        }));
        const saved = await articles.saveArticle({
            articleId: 'art_audit_three', article: body, title: 'Audit three', sourceType: 'paste',
            result: { chinese_translation: '合成译文。', word_alignment: [], detailed_analysis: [], paragraph_analysis: paras, sentence_analysis: [], phrase_analysis: [] }
        });
        if (!saved.ok) throw new Error(saved.error);
        document.querySelector('#app-modal .modal-close-btn')?.click();
        document.getElementById('article-btn').click();
        const state = await import('/modules/state.js');
        state.setCurrentArticleId('art_audit_three');
        const article = await import('/features/article/article.js');
        await article.showCurrentArticleIfAvailable();
    }, { sent: SENT, zh: ZH, body: BODY });
    await page.waitForSelector('.sent-analyze-btn');
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
    return { page, context, errors, external };
}

const count = async (page) => page.evaluate(() => window.__speech.calls.length);
const finish = (page) => page.evaluate(() => window.__speech.finish());
async function openMenu(page, index, { tap = false } = {}) {
    const trigger = page.locator('.sent-analyze-btn').nth(index);
    for (let attempt = 1; attempt <= 4; attempt += 1) {
        if (tap) await trigger.tap(); else await trigger.click();
        try { await page.locator('#article-sentence-menu').waitFor({ state: 'visible', timeout: 700 }); return; } catch (_) { /* closed by scroll */ }
    }
    throw new Error('menu would not stay open');
}
async function action(page, index, mode, opts = {}) {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
        await openMenu(page, index, opts);
        const item = page.locator(`#article-sentence-menu [data-sentence-action="${mode}"]`);
        try { if (opts.tap) await item.tap({ timeout: 1500 }); else await item.click({ timeout: 1500 }); return; } catch (_) { /* retry */ }
    }
    throw new Error('action failed');
}
async function shot(page, name) {
    if (!OUT) return;
    fs.mkdirSync(OUT, { recursive: true });
    await page.screenshot({ path: path.join(OUT, name) });
}

(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
    try {
        /* H1 語速沿用（句尾朗讀 vs 全文朗讀） */
        {
            const { page, context, errors } = await setup(browser, {});
            try {
                await page.evaluate(() => {
                    const btn = document.querySelector('#speed-control-group .speed-btn[data-speed="50"]');
                    btn?.click();
                });
                await page.waitForTimeout(150);
                await action(page, 1, 'once');
                await page.waitForTimeout(120);
                const sentenceRate = await page.evaluate(() => window.__speech.calls.at(-1)?.rate);
                await finish(page);
                await page.waitForTimeout(200);
                await page.click('#read-article-btn');
                await page.waitForTimeout(200);
                const fullRate = await page.evaluate(() => window.__speech.calls.at(-1)?.rate);
                ok('H1 sentence read reuses selected speed', sentenceRate === fullRate && sentenceRate > 1, JSON.stringify({ sentenceRate, fullRate }));
                await page.locator('.fr-stop').click();
                await page.waitForTimeout(150);
                ok('H2 no page errors (speed)', errors.length === 0, errors.join(' | '));
            } finally { await context.close(); }
        }

        /* H3 正文過期時的三個朗讀項要停用，解析仍可用 */
        {
            const { page, context, errors } = await setup(browser, {});
            try {
                await page.evaluate(() => {
                    const input = document.getElementById('article-input');
                    input.value = `${input.value}\n\nEdited later.`;
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                });
                await page.waitForTimeout(200);
                await openMenu(page, 1);
                const state = await page.evaluate(() => [...document.querySelectorAll('#article-sentence-menu [data-sentence-action]')].map((b) => ({
                    action: b.dataset.sentenceAction, disabled: b.disabled, title: b.title
                })));
                const readDisabled = state.filter((s) => s.action !== 'analyze').every((s) => s.disabled);
                const analyzeEnabled = state.find((s) => s.action === 'analyze')?.disabled === false;
                ok('H3 stale view disables read actions', readDisabled, JSON.stringify(state));
                ok('H4 stale view keeps analyze enabled', analyzeEnabled, JSON.stringify(state));
                info('H5 stale tooltip', JSON.stringify(state[0]?.title));
                await shot(page, 'H-stale-menu.png');
                await page.keyboard.press('Escape');
                await page.waitForTimeout(100);
                const playedBefore = await count(page);
                await page.evaluate(() => document.querySelector('.sent-analyze-btn').click());
                await page.waitForTimeout(150);
                ok('H6 disabled read cannot be triggered', (await count(page)) === playedBefore);
                ok('H7 no page errors (stale)', errors.length === 0, errors.join(' | '));
            } finally { await context.close(); }
        }

        /* H8 離開 article route 後仍可停止循環嗎 */
        {
            const { page, context } = await setup(browser, {});
            try {
                await action(page, 1, 'loop');
                await page.waitForTimeout(80);
                await finish(page);
                await page.evaluate(() => { window.location.hash = '#/phonetics'; });
                await page.waitForTimeout(1000);
                const after = await page.evaluate(() => ({
                    calls: window.__speech.calls.length,
                    text: window.__speech.calls.at(-1)?.text,
                    readerVisible: !!document.querySelector('.floating-reader.is-visible'),
                    articleVisible: document.getElementById('article-section').classList.contains('active'),
                    stopVisible: (() => {
                        const el = document.querySelector('.floating-reader .fr-stop');
                        if (!el) return null;
                        const r = el.getBoundingClientRect();
                        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), top: document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.className };
                    })()
                }));
                info('H8 loop keeps running after route change', JSON.stringify(after));
                if (after.readerVisible) {
                    await page.locator('.fr-stop').click({ timeout: 3000 }).catch((error) => info('H9 stop click failed', error.message));
                    await page.waitForTimeout(900);
                    info('H9 stopped from another module', JSON.stringify({ calls: await count(page) }));
                }
                await shot(page, 'H-after-route-change.png');
            } finally { await context.close(); }
        }

        /* H10 aria-expanded 在捲動關閉後要復原；H11 循環間隔分布 */
        {
            const { page, context, errors } = await setup(browser, {});
            try {
                await openMenu(page, 1);
                ok('H10 trigger aria-expanded true when open', await page.locator('.sent-analyze-btn').nth(1).getAttribute('aria-expanded') === 'true');
                await page.evaluate(() => window.scrollBy(0, 40));
                await page.waitForTimeout(200);
                ok('H11 aria-expanded false after scroll close', await page.locator('.sent-analyze-btn').nth(1).getAttribute('aria-expanded') === 'false');

                await action(page, 1, 'loop');
                for (let i = 0; i < 3; i += 1) { await page.waitForTimeout(60); await finish(page); await page.waitForTimeout(700); }
                const times = await page.evaluate(() => window.__speech.calls.map((c) => c.at));
                const gaps = times.slice(1).map((t, i) => t - times[i]);
                info('H12 loop gaps', JSON.stringify(gaps));
                ok('H13 loop gaps >= 450ms', gaps.every((g) => g >= 450), JSON.stringify(gaps));
                await page.locator('.fr-stop').click();
                await page.waitForTimeout(300);
                ok('H14 no page errors (aria/gap)', errors.length === 0, errors.join(' | '));
            } finally { await context.close(); }
        }

        /* H15 連續模式中途前進時，原句選單不再顯示停止（設計確認） */
        {
            const { page, context } = await setup(browser, {});
            try {
                await action(page, 0, 'continue');
                await page.waitForTimeout(80);
                await finish(page);
                await page.waitForTimeout(150);
                await openMenu(page, 0);
                const labels = await page.locator('#article-sentence-menu span').allTextContents();
                info('H15 continue-mode menu on first sentence after advancing', JSON.stringify({ labels, current: await page.evaluate(() => window.__speech.calls.at(-1)?.text) }));
                await page.keyboard.press('Escape');
                await page.locator('.fr-stop').click();
            } finally { await context.close(); }
        }
    } finally { await browser.close(); }
    const fails = results.filter((r) => r.status === 'FAIL');
    console.log(`\n== ${results.filter((r) => r.status === 'PASS').length} pass, ${fails.length} fail, ${results.filter((r) => r.status === 'INFO').length} info ==`);
    if (OUT) fs.writeFileSync(path.join(OUT, 'audit3-results.json'), JSON.stringify(results, null, 2));
    if (fails.length) process.exitCode = 1;
})().catch((error) => { console.error(error); process.exitCode = 1; });
