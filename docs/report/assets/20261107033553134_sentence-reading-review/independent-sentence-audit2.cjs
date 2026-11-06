/**
 * 獨立審查第二輪：換文章／換模組／右鍵／收合側欄／無譯文句／跨句選區。
 * PORT=8313 PLAYWRIGHT_MODULE=<pw> node independent-sentence-audit2.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const BASE = `http://127.0.0.1:${process.env.PORT || 8313}`;
const OUT = process.env.ARTIFACT_DIR || '';
const SENT = ['Alpha sentence one.', 'Alpha sentence two.', 'Beta sentence three.', 'Beta sentence four.'];
const ZH = ['甲句一。', '甲句二。', '乙句三。', '乙句四。'];
const BODY = SENT.slice(0, 2).join(' ') + '\n\n' + SENT.slice(2).join(' ');
const SENT_B = ['Second article sentence one.', 'Second article sentence two.'];
const BODY_B = SENT_B.join(' ');

const results = [];
function record(id, status, detail = '') {
    results.push({ id, status, detail });
    const tag = status === 'FAIL' ? 'FAIL' : status === 'INFO' ? 'INFO' : 'PASS';
    console.log(`${tag} ${id}${detail ? ' :: ' + detail : ''}`);
}
const ok = (id, cond, detail = '') => { record(id, cond ? 'PASS' : 'FAIL', cond ? '' : detail); return !!cond; };
const info = (id, detail) => record(id, 'INFO', detail);

async function setup(browser, { locale = 'zh-CN', width = 1280, height = 960, mobile = false, sentences = SENT, zh = ZH, body = BODY, articleId = 'art_audit_two' } = {}) {
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
            speak(u) { speech.current = u; speech.calls.push({ text: u.text, at: Date.now() }); queueMicrotask(() => u.onstart?.()); }
        } });
    }, locale);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const booted = page.waitForEvent('console', { predicate: (m) => m.text().startsWith('应用程序已') });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await booted;
    await page.waitForFunction(() => !!document.getElementById('article-btn'));
    await page.evaluate(async ({ sentences, zh, body, articleId }) => {
        const articles = await import('/modules/article-store.js');
        const reading = await import('/modules/reading-store.js');
        await articles.initArticleStore();
        await reading.initReadingStore();
        const paras = [[0, 2], [2, 4]].map(([from, to]) => ({
            chinese_translation: '合成译文，仅供测试。', word_alignment: [], detailed_analysis: [],
            sentences: sentences.slice(from, to).map((en, i) => ({ en, zh: zh[from + i] }))
        }));
        const saved = await articles.saveArticle({
            articleId, article: body, title: 'Audit two', sourceType: 'paste',
            result: { chinese_translation: '合成译文。', word_alignment: [], detailed_analysis: [], paragraph_analysis: paras, sentence_analysis: [], phrase_analysis: [] }
        });
        if (!saved.ok) throw new Error(saved.error);
        document.querySelector('#app-modal .modal-close-btn')?.click();
        document.getElementById('article-btn').click();
        const state = await import('/modules/state.js');
        state.setCurrentArticleId(articleId);
        const article = await import('/features/article/article.js');
        await article.showCurrentArticleIfAvailable();
    }, { sentences, zh, body, articleId });
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
        try { await page.locator('#article-sentence-menu').waitFor({ state: 'visible', timeout: 700 }); return; } catch (_) { /* scroll closed */ }
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
        /* G1 換模組時的待決循環 */
        {
            const { page, context, errors } = await setup(browser, {});
            try {
                await action(page, 1, 'loop');
                await page.waitForTimeout(80);
                await finish(page);
                const before = await count(page);
                await page.evaluate(() => { window.location.hash = '#/phonetics'; });
                await page.waitForTimeout(1200);
                const after = await count(page);
                info('G1 pending loop at module change', JSON.stringify({ before, after, lateCalls: after - before }));
                ok('G2 no page errors (module change)', errors.length === 0, errors.join(' | '));
            } finally { await context.close(); }
        }

        /* G3 換文章（文章庫開另一篇） */
        {
            const { page, context, errors } = await setup(browser, {});
            try {
                await page.evaluate(async ({ s, z, b }) => {
                    const articles = await import('/modules/article-store.js');
                    await articles.saveArticle({
                        articleId: 'art_audit_two_b', article: b, title: 'Audit two B', sourceType: 'paste',
                        result: { chinese_translation: '合成译文。', word_alignment: [], detailed_analysis: [], paragraph_analysis: [{ chinese_translation: '乙。', word_alignment: [], detailed_analysis: [], sentences: s.map((en, i) => ({ en, zh: z[i] })) }], sentence_analysis: [], phrase_analysis: [] }
                    });
                }, { s: SENT_B, z: ['第二篇一。', '第二篇二。'], b: BODY_B });
                await action(page, 1, 'loop');
                await page.waitForTimeout(80);
                await finish(page);
                const before = await count(page);
                // 由文章庫切換到另一篇
                await page.evaluate(async () => {
                    const article = await import('/features/article/article.js');
                    const state = await import('/modules/state.js');
                    state.setCurrentArticleId('art_audit_two_b');
                    await article.showCurrentArticleIfAvailable();
                });
                await page.waitForTimeout(1200);
                const after = await count(page);
                info('G3 pending loop at article switch', JSON.stringify({ before, after, lateCalls: after - before, last: await page.evaluate(() => window.__speech.calls.at(-1)?.text) }));
                ok('G4 no page errors (article switch)', errors.length === 0, errors.join(' | '));
            } finally { await context.close(); }
        }

        /* G5 右鍵與長按保留原生 */
        {
            const { page, context, errors } = await setup(browser, {});
            try {
                const trigger = await page.locator('.sent-analyze-btn').first().boundingBox();
                await page.mouse.click(trigger.x + trigger.width / 2, trigger.y + trigger.height / 2, { button: 'right' });
                await page.waitForTimeout(150);
                const afterRight = await page.evaluate(() => ({
                    menuOpen: !document.getElementById('article-sentence-menu').classList.contains('hidden'),
                    modalOpen: !document.getElementById('app-modal').classList.contains('hidden')
                }));
                ok('G5 right-click does not open menu', !afterRight.menuOpen && !afterRight.modalOpen, JSON.stringify(afterRight));
                const prevented = await page.evaluate(() => new Promise((resolve) => {
                    const el = document.querySelector('.sent-analyze-btn');
                    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
                    el.dispatchEvent(event);
                    resolve(event.defaultPrevented);
                }));
                ok('G6 contextmenu default not prevented', prevented === false, String(prevented));
            } finally { await context.close(); }
        }

        /* G7 收合側欄（compact controls）+ 320 */
        {
            const { page, context, errors } = await setup(browser, { width: 320, height: 844, mobile: true });
            try {
                await page.locator('#article-sidebar-toggle').click();
                await page.waitForTimeout(300);
                await openMenu(page, 1, { tap: true });
                const box = await page.locator('#article-sentence-menu').boundingBox();
                ok('G7 menu fits collapsed sidebar 320', box.x >= 0 && box.x + box.width <= 320.5 && box.y >= 0 && box.y + box.height <= 844.5, JSON.stringify(box));
                await page.locator('#article-sentence-menu [data-sentence-action="loop"]').tap();
                await page.waitForTimeout(150);
                const reader = await page.evaluate(() => {
                    const el = document.querySelector('.floating-reader');
                    if (!el) return null;
                    const r = el.getBoundingClientRect();
                    return { visible: el.classList.contains('is-visible'), mode: el.dataset.readingMode, w: Math.round(r.width), x: Math.round(r.x), right: Math.round(r.right) };
                });
                ok('G8 floating reader inside viewport 320', !!reader && reader.visible && reader.x >= 0 && reader.right <= 321, JSON.stringify(reader));
                await shot(page, `G-compact-320.png`);
                await page.locator('.fr-stop').tap();
                await page.waitForTimeout(150);
            } finally { await context.close(); }
        }

        /* G9 沒有中文譯文的句子 */
        {
            const { page, context, errors } = await setup(browser, { sentences: SENT, zh: ['', '', '', ''] });
            try {
                await page.mouse.move(2, 2);
                await page.locator('.sent-analyze-btn').first().hover();
                await page.locator('#article-sentence-quick-read').waitFor({ state: 'visible', timeout: 4000 }).catch(() => {});
                const hover = await page.evaluate(() => {
                    const quick = document.getElementById('article-sentence-quick-read');
                    const hint = document.querySelector('.sentence-hint');
                    return {
                        quickVisible: !quick.classList.contains('hidden'),
                        hintShown: !!hint?.classList.contains('is-shown'),
                        hintText: hint?.querySelector('.sentence-hint-text')?.textContent,
                        quick: quick.getBoundingClientRect().toJSON(),
                        hint: hint ? hint.getBoundingClientRect().toJSON() : null
                    };
                });
                ok('G9 quick-read still usable without translation', hover.quickVisible === true, JSON.stringify(hover.sentenceHint || hover));
                info('G10 hint text without translation', JSON.stringify({ hintShown: hover.hintShown, text: hover.hintText }));
                await shot(page, 'G-hover-no-translation.png');
                await page.locator('#article-sentence-quick-read').click();
                await page.waitForTimeout(120);
                ok('G11 quick-read plays even without translation', (await page.evaluate(() => window.__speech.calls.at(-1)?.text)) === SENT[0]);
            } finally { await context.close(); }
        }

        /* G12 跨句選區 */
        {
            const { page, context } = await setup(browser, {});
            try {
                const selected = await page.evaluate(() => {
                    const first = document.querySelectorAll('.interactive-sentence')[0];
                    const second = document.querySelectorAll('.interactive-sentence')[1];
                    const a = document.createTreeWalker(first, NodeFilter.SHOW_TEXT).nextNode();
                    const walker = document.createTreeWalker(second, NodeFilter.SHOW_TEXT);
                    let last = walker.nextNode();
                    while (walker.nextNode()) last = walker.currentNode;
                    const range = document.createRange();
                    range.setStart(a, 0);
                    range.setEnd(last, last.nodeValue.length);
                    const sel = window.getSelection();
                    sel.removeAllRanges();
                    sel.addRange(range);
                    document.dispatchEvent(new Event('selectionchange'));
                    return sel.toString().slice(0, 40);
                });
                await page.waitForTimeout(200);
                const barShown = await page.locator('.article-selection-bar.is-visible').count();
                info('G12 cross-sentence selection', JSON.stringify({ selected, barShown }));
            } finally { await context.close(); }
        }

        /* G13 外部請求（排除同步端點） */
        {
            const { page, context, external } = await setup(browser, {});
            try {
                const baseline = external.length;
                await openMenu(page, 1);
                await page.keyboard.press('Escape');
                await action(page, 1, 'once');
                await page.waitForTimeout(120);
                await finish(page);
                await action(page, 2, 'loop');
                await page.waitForTimeout(700);
                await page.locator('.fr-stop').click();
                const added = external.slice(baseline).filter((u) => !u.includes('19999'));
                ok('G13 reading triggers no AI/TTS request', added.length === 0, JSON.stringify(added));
                info('G14 baseline external requests', JSON.stringify(external.slice(0, baseline)));
            } finally { await context.close(); }
        }
    } finally { await browser.close(); }
    const fails = results.filter((r) => r.status === 'FAIL');
    console.log(`\n== ${results.filter((r) => r.status === 'PASS').length} pass, ${fails.length} fail, ${results.filter((r) => r.status === 'INFO').length} info ==`);
    if (OUT) fs.writeFileSync(path.join(OUT, 'audit2-results.json'), JSON.stringify(results, null, 2));
    if (fails.length) process.exitCode = 1;
})().catch((error) => { console.error(error); process.exitCode = 1; });
