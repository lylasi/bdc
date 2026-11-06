/**
 * 獨立審查第六輪：懸停聯動、句尾入口實際熱區尺寸。
 * PORT=8313 PLAYWRIGHT_MODULE=<pw> node independent-sentence-audit6.cjs
 */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const BASE = `http://127.0.0.1:${process.env.PORT || 8313}`;
const SENT = ['Alpha sentence one.', 'Alpha sentence two.', 'Beta sentence three.'];
const ZH = ['甲句一。', '甲句二。', '乙句三。'];
const BODY = SENT.slice(0, 2).join(' ') + '\n\n' + SENT[2];
const results = [];
const record = (id, status, detail = '') => { results.push({ id, status, detail }); console.log(`${status} ${id}${detail ? ' :: ' + detail : ''}`); };
const ok = (id, cond, detail = '') => { record(id, cond ? 'PASS' : 'FAIL', cond ? '' : detail); return !!cond; };
const info = (id, detail) => record(id, 'INFO', detail);

async function boot(browser, width, mobile) {
    const context = await browser.newContext({ viewport: { width, height: mobile ? 844 : 900 }, isMobile: mobile, hasTouch: mobile });
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
        const paras = [[0, 2], [2, 3]].map(([from, to]) => ({
            chinese_translation: '合成译文，仅供测试。', word_alignment: [], detailed_analysis: [],
            sentences: sent.slice(from, to).map((en, i) => ({ en, zh: zh[from + i] }))
        }));
        const saved = await articles.saveArticle({
            articleId: 'art_audit_six', article: body, title: 'Audit six', sourceType: 'paste',
            result: { chinese_translation: '合成译文。', word_alignment: [], detailed_analysis: [], paragraph_analysis: paras, sentence_analysis: [], phrase_analysis: [] }
        });
        if (!saved.ok) throw new Error(saved.error);
        document.querySelector('#app-modal .modal-close-btn')?.click();
        document.getElementById('article-btn').click();
        const state = await import('/modules/state.js');
        state.setCurrentArticleId('art_audit_six');
        const article = await import('/features/article/article.js');
        await article.showCurrentArticleIfAvailable();
    }, { sent: SENT, zh: ZH, body: BODY });
    await page.waitForSelector('.sent-analyze-btn');
    await page.waitForTimeout(400);
    return { page, context, errors };
}

(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
    try {
        {
            const { page, context, errors } = await boot(browser, 1280, false);
            try {
                await page.locator('.sent-analyze-btn').first().hover();
                await page.waitForTimeout(120);
                const linked = await page.evaluate(() => ({
                    eng: document.querySelectorAll('.interactive-sentence.sentence-linked').length,
                    zh: document.querySelectorAll('.interactive-sentence-zh.sentence-linked').length,
                    hint: !!document.querySelector('.sentence-hint.is-shown')
                }));
                ok('K1 hover keeps sentence link highlight', linked.eng === 1 && linked.zh === 1 && linked.hint, JSON.stringify(linked));
                // 入口熱區：中心上下各 10px 仍可命中
                const box = await page.locator('.sent-analyze-btn').first().boundingBox();
                const probes = await page.evaluate(({ x, y }) => {
                    const at = (dx, dy) => {
                        const el = document.elementFromPoint(x + dx, y + dy);
                        return el ? (el.closest('.sent-analyze-btn') ? 'trigger' : (el.className || el.tagName)) : 'null';
                    };
                    return { up: at(0, -10), down: at(0, 10), left: at(-10, 0), right: at(10, 0), style: getComputedStyle(document.querySelector('.sent-analyze-btn'), '::after').width };
                }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
                info('K2 trigger hit area (desktop)', JSON.stringify({ box, ...probes }));
                ok('K3 trigger hit area >= 24px', probes.up === 'trigger' && probes.down === 'trigger' && probes.left === 'trigger' && probes.right === 'trigger', JSON.stringify(probes));
                ok('K4 no page errors', errors.length === 0, errors.join(' | '));
            } finally { await context.close(); }
        }
        {
            const { page, context, errors } = await boot(browser, 320, true);
            try {
                await page.locator('.sent-analyze-btn').first().scrollIntoViewIfNeeded();
                await page.waitForTimeout(400);
                const box = await page.locator('.sent-analyze-btn').first().boundingBox();
                const probes = await page.evaluate(({ x, y }) => {
                    const at = (dx, dy) => {
                        const el = document.elementFromPoint(x + dx, y + dy);
                        return el ? (el.closest('.sent-analyze-btn') ? 'trigger' : (el.className || el.tagName)) : 'null';
                    };
                    return { up15: at(0, -15), down15: at(0, 15), left15: at(-15, 0), right15: at(15, 0) };
                }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
                info('K5 trigger hit area (320 coarse)', JSON.stringify({ box, ...probes }));
                ok('K6 mobile trigger hit area >= 30px', Object.values(probes).every((v) => v === 'trigger'), JSON.stringify(probes));
                ok('K7 no page errors (mobile)', errors.length === 0, errors.join(' | '));
            } finally { await context.close(); }
        }
    } finally { await browser.close(); }
    const fails = results.filter((r) => r.status === 'FAIL');
    console.log(`\n== ${results.filter((r) => r.status === 'PASS').length} pass, ${fails.length} fail ==`);
    if (fails.length) process.exitCode = 1;
})().catch((error) => { console.error(error); process.exitCode = 1; });
