/**
 * 獨立審查第四輪：真實模組切換時，循環是否停止、是否仍可停止。
 * PORT=8313 PLAYWRIGHT_MODULE=<pw> node independent-sentence-audit4.cjs
 */
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const BASE = `http://127.0.0.1:${process.env.PORT || 8313}`;
const OUT = process.env.ARTIFACT_DIR || '';
const SENT = ['Alpha sentence one.', 'Alpha sentence two.', 'Beta sentence three.', 'Beta sentence four.'];
const ZH = ['甲句一。', '甲句二。', '乙句三。', '乙句四。'];
const BODY = SENT.slice(0, 2).join(' ') + '\n\n' + SENT.slice(2).join(' ');
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
            articleId: 'art_audit_four', article: body, title: 'Audit four', sourceType: 'paste',
            result: { chinese_translation: '合成译文。', word_alignment: [], detailed_analysis: [], paragraph_analysis: paras, sentence_analysis: [], phrase_analysis: [] }
        });
        if (!saved.ok) throw new Error(saved.error);
        document.querySelector('#app-modal .modal-close-btn')?.click();
        document.getElementById('article-btn').click();
        const state = await import('/modules/state.js');
        state.setCurrentArticleId('art_audit_four');
        const article = await import('/features/article/article.js');
        await article.showCurrentArticleIfAvailable();
    }, { sent: SENT, zh: ZH, body: BODY });
    await page.waitForSelector('.sent-analyze-btn');
    await page.waitForTimeout(400);
    const count = async () => page.evaluate(() => window.__speech.calls.length);
    const finish = () => page.evaluate(() => window.__speech.finish());
    async function action(index, mode) {
        for (let i = 0; i < 4; i += 1) {
            await page.locator('.sent-analyze-btn').nth(index).click();
            try { await page.locator('#article-sentence-menu').waitFor({ state: 'visible', timeout: 700 }); } catch (_) { continue; }
            try { await page.locator(`#article-sentence-menu [data-sentence-action="${mode}"]`).click({ timeout: 1500 }); return; } catch (_) { /* retry */ }
        }
        throw new Error('action failed');
    }
    try {
        await action(1, 'loop');
        await page.waitForTimeout(80);
        await finish();
        const before = await count();
        // 真實的模組切換：按底部導覽
        await page.click('#vocabulary-btn');
        await page.waitForTimeout(1200);
        const state = await page.evaluate(() => {
            const reader = document.querySelector('.floating-reader');
            const stop = document.querySelector('.floating-reader .fr-stop');
            const rect = stop?.getBoundingClientRect();
            const hit = rect ? document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) : null;
            return {
                calls: window.__speech.calls.length,
                last: window.__speech.calls.at(-1)?.text,
                module: document.body.dataset.module,
                articleActive: document.getElementById('article-section').classList.contains('active'),
                readerVisible: !!reader?.classList.contains('is-visible'),
                stopHit: hit ? (hit.closest('.fr-stop') ? 'fr-stop' : hit.className || hit.tagName) : null,
                stopRect: rect ? { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) } : null
            };
        });
        info('I1 loop after switching module', JSON.stringify({ before, ...state, lateCalls: state.calls - before }));
        if (OUT) { fs.mkdirSync(OUT, { recursive: true }); await page.screenshot({ path: path.join(OUT, 'I-module-switch-loop.png') }); }
        if (state.readerVisible) {
            await page.locator('.fr-stop').click({ timeout: 3000 }).catch((e) => info('I2 stop click failed', e.message));
            await page.waitForTimeout(900);
            info('I2 stopped from other module', JSON.stringify({ calls: await count() }));
        } else {
            info('I2 no visible stop control on other module', 'loop continues without any UI to stop it');
        }
        ok('I3 no page errors', errors.length === 0, errors.join(' | '));
    } finally {
        await context.close();
        await browser.close();
    }
    const fails = results.filter((r) => r.status === 'FAIL');
    console.log(`\n== ${results.filter((r) => r.status === 'PASS').length} pass, ${fails.length} fail ==`);
    if (fails.length) process.exitCode = 1;
})().catch((error) => { console.error(error); process.exitCode = 1; });
