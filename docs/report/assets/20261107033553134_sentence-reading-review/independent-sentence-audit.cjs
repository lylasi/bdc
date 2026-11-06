/**
 * 獨立審查腳本：文章詳解逐句朗讀（不呼叫真實 AI／TTS／帳號）。
 * PORT=8313 PLAYWRIGHT_MODULE=<pw> node independent-sentence-audit.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const BASE = `http://127.0.0.1:${process.env.PORT || 8313}`;
const OUT = process.env.ARTIFACT_DIR || '';
const SENT = [
    'Alpha sentence one.', 'Alpha sentence two.',
    'Beta sentence three carries a considerably longer run of words so that it wraps across several lines on a narrow phone screen, which is exactly what we want to measure.',
    'Gamma sentence four.', 'Gamma sentence four.',
    'Delta sentence five.', 'Delta sentence six.'
];
const ZH = ['甲句一。', '甲句二。', '乙句三。', '丙句四。', '丙句四。', '丁句五。', '丁句六。'];
const BODY = [SENT.slice(0, 2).join(' '), SENT[2], SENT.slice(3, 5).join(' '), SENT.slice(5).join(' ')].join('\n\n');
const LABELS = {
    'zh-CN': ['朗读本句', '从这里开始读', '循环读本句', '句子解析'],
    'zh-HK': ['朗讀本句', '從這裏開始讀', '循環讀本句', '句子解析']
};

const results = [];
function record(id, status, detail = '') {
    results.push({ id, status, detail });
    const tag = status === 'FAIL' ? 'FAIL' : status === 'INFO' ? 'INFO' : 'PASS';
    console.log(`${tag} ${id}${detail ? ' :: ' + detail : ''}`);
}
const ok = (id, cond, detail = '') => { record(id, cond ? 'PASS' : 'FAIL', cond ? (typeof detail === 'string' && !cond ? detail : '') : detail); return !!cond; };
const info = (id, detail) => record(id, 'INFO', detail);

async function setup(browser, locale, width = 1280, height = 960, mobile = false) {
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
        const speech = window.__speech = { calls: [], current: null, cancels: 0 };
        speech.finish = () => { const current = speech.current; speech.current = null; current?.onend?.(); };
        speech.error = (payload) => speech.current?.onerror?.(payload);
        Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: class { constructor(text) { this.text = text; } } });
        Object.defineProperty(window, 'speechSynthesis', { value: {
            getVoices: () => [{ lang: 'en-US', name: 'Test English', voiceURI: 'test' }],
            addEventListener() {}, removeEventListener() {},
            cancel() { speech.cancels += 1; speech.current = null; },
            speak(utterance) {
                speech.current = utterance;
                speech.calls.push({ text: utterance.text, at: Date.now(), rate: utterance.rate });
                queueMicrotask(() => utterance.onstart?.());
            }
        } });
    }, locale);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const booted = page.waitForEvent('console', { predicate: (m) => m.text().startsWith('应用程序已') });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await booted;
    await page.waitForFunction(() => !!document.getElementById('article-btn'));
    await page.evaluate(async ({ sent, zh, body }) => {
        const articles = await import('/modules/article-store.js');
        const reading = await import('/modules/reading-store.js');
        await articles.initArticleStore();
        await reading.initReadingStore();
        const paras = [[0, 2], [2, 3], [3, 5], [5, 7]].map(([from, to]) => ({
            chinese_translation: '合成译文，仅供测试。', word_alignment: [], detailed_analysis: [],
            sentences: sent.slice(from, to).map((en, i) => ({ en, zh: zh[from + i] }))
        }));
        const saved = await articles.saveArticle({
            articleId: 'art_independent_audit', article: body, title: 'Independent audit', sourceType: 'paste',
            result: { chinese_translation: '合成译文。', word_alignment: [], detailed_analysis: [], paragraph_analysis: paras, sentence_analysis: [], phrase_analysis: [] }
        });
        if (!saved.ok) throw new Error(saved.error);
        document.querySelector('#app-modal .modal-close-btn')?.click();
        document.getElementById('article-btn').click();
        const state = await import('/modules/state.js');
        state.setCurrentArticleId('art_independent_audit');
        const article = await import('/features/article/article.js');
        await article.showCurrentArticleIfAvailable();
    }, { sent: SENT, zh: ZH, body: BODY });
    await page.waitForSelector('.sent-analyze-btn');
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
    return { page, context, errors, external };
}

/* ---------- helpers ---------- */
const calls = (page) => page.evaluate(() => window.__speech.calls.map((c) => c.text));
const count = async (page) => (await calls(page)).length;
const last = async (page) => (await calls(page)).at(-1);
const finish = (page) => page.evaluate(() => window.__speech.finish());
const stopBtn = (page) => page.locator('#stop-read-article-btn').isDisabled();
async function openMenu(page, index, { tap = false, attempts = 4, quiet = false } = {}) {
    const trigger = page.locator('.sent-analyze-btn').nth(index);
    for (let tryNo = 1; tryNo <= attempts; tryNo += 1) {
        if (tap) await trigger.tap(); else await trigger.click();
        try {
            await page.locator('#article-sentence-menu').waitFor({ state: 'visible', timeout: 700 });
            if (tryNo > 1 && !quiet) info('menu needed retry', `sentence#${index} attempt ${tryNo}`);
            return tryNo;
        } catch (_) { /* 選單被捲動事件關掉 */ }
        await page.waitForTimeout(80);
    }
    throw new Error(`menu would not stay open: sentence#${index}`);
}
async function pick(page, mode, { tap = false, timeout = 2000 } = {}) {
    const item = page.locator(`#article-sentence-menu [data-sentence-action="${mode}"]`);
    if (tap) await item.tap({ timeout }); else await item.click({ timeout });
}
async function action(page, index, mode, opts = {}) {
    for (let tryNo = 1; tryNo <= 4; tryNo += 1) {
        await openMenu(page, index, { ...opts, quiet: tryNo > 1 });
        try { await pick(page, mode, opts); return; } catch (_) { /* 選單在點擊前被關 */ }
        await page.waitForTimeout(80);
    }
    throw new Error(`action ${mode} on sentence#${index} failed`);
}
async function hardStop(page) {
    if (await page.locator('.floating-reader.is-visible').count()) await page.locator('.fr-stop').click();
    await page.waitForTimeout(60);
}
async function shot(page, name) {
    if (!OUT) return;
    fs.mkdirSync(OUT, { recursive: true });
    await page.screenshot({ path: path.join(OUT, name) });
}
function log(...args) { console.log('   ', ...args); }

/* ---------- A. layout / occlusion / hit-testing ---------- */
async function layoutSuite(browser, locale, width, height, mobile) {
    const pad = `${mobile ? 'm' + width : 'desktop'}/${locale}`;
    const { page, context, errors } = await setup(browser, locale, width, height, mobile);
    try {
        const before = await page.locator('.paragraph-pair').first().boundingBox();
        await openMenu(page, 1, { tap: mobile });
        const menu = await page.locator('#article-sentence-menu').boundingBox();
        ok(`A1 menu in viewport ${pad}`, menu.x >= 0 && menu.y >= 0 && menu.x + menu.width <= width + 0.5 && menu.y + menu.height <= height + 0.5, JSON.stringify(menu));
        ok(`A2 no horizontal overflow ${pad}`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
        ok(`A3 no reflow ${pad}`, (await page.locator('.paragraph-pair').first().boundingBox()).height === before.height);
        const probes = await page.evaluate(() => [...document.querySelectorAll('#article-sentence-menu [data-sentence-action]')].map((button) => {
            const rect = button.getBoundingClientRect();
            const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
            return {
                action: button.dataset.sentenceAction,
                w: Math.round(rect.width), h: Math.round(rect.height),
                hit: hit ? (hit.closest('[data-sentence-action]')?.dataset?.sentenceAction || hit.tagName + '.' + hit.className) : 'null',
                overflow: button.scrollWidth > button.clientWidth + 1
            };
        }));
        ok(`A4 every item hit-testable ${pad}`, probes.every((p) => p.hit === p.action), JSON.stringify(probes));
        ok(`A5 item touch target >= 40px ${pad}`, probes.every((p) => p.h >= 40 && p.w >= 80), JSON.stringify(probes.map((p) => [p.w, p.h])));
        ok(`A6 no text clipped ${pad}`, probes.every((p) => !p.overflow), JSON.stringify(probes.filter((p) => p.overflow)));
        const labels = await page.locator('#article-sentence-menu span').allTextContents();
        ok(`A7 labels ${pad}`, JSON.stringify(labels) === JSON.stringify(LABELS[locale]), JSON.stringify(labels));
        await shot(page, `A-menu-${mobile ? width : 'desktop'}-${locale}.png`);
        await page.keyboard.press('Escape');

        // 底部句子：選單應翻到上方且完整可點
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await page.waitForTimeout(120);
        await openMenu(page, 6, { tap: mobile });
        const bottomBox = await page.locator('#article-sentence-menu').boundingBox();
        ok(`A8 bottom anchor menu in viewport ${pad}`, bottomBox.y + bottomBox.height <= height + 0.5 && bottomBox.y >= 0, JSON.stringify(bottomBox));
        const bottomHit = await page.evaluate(() => {
            const b = document.querySelector('#article-sentence-menu [data-sentence-action="analyze"]').getBoundingClientRect();
            const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
            return hit?.closest?.('[data-sentence-action]')?.dataset?.sentenceAction || (hit && (hit.tagName + '.' + hit.className));
        });
        ok(`A9 bottom anchor items clickable ${pad}`, bottomHit === 'analyze', String(bottomHit));
        await shot(page, `A-menu-bottom-${mobile ? width : 'desktop'}-${locale}.png`);
        await page.keyboard.press('Escape');

        // 頂部句子：貼著 sticky 標頭時仍要可點
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(120);
        await openMenu(page, 0, { tap: mobile });
        const topHit = await page.evaluate(() => [...document.querySelectorAll('#article-sentence-menu [data-sentence-action]')].map((button) => {
            const rect = button.getBoundingClientRect();
            const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
            return hit?.closest?.('[data-sentence-action]')?.dataset?.sentenceAction || (hit && (hit.tagName + '.' + hit.className));
        }));
        ok(`A10 top anchor items clickable ${pad}`, JSON.stringify(topHit) === JSON.stringify(['once', 'continue', 'loop', 'analyze']), JSON.stringify(topHit));
        await shot(page, `A-menu-top-${mobile ? width : 'desktop'}-${locale}.png`);
        await page.keyboard.press('Escape');

        // 觸控熱區：中心上下各 14px 仍要開啟選單
        if (mobile) {
            for (const dy of [-14, 14]) {
                await page.waitForTimeout(500);
                await page.locator('.sent-analyze-btn').nth(2).scrollIntoViewIfNeeded();
                await page.waitForTimeout(400);
                const box = await page.locator('.sent-analyze-btn').nth(2).boundingBox();
                await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2 + dy);
                await page.waitForTimeout(120);
                const opened = await page.locator('#article-sentence-menu:not(.hidden)').count() === 1;
                ok(`A11 touch target ±14px (${dy}) ${pad}`, opened, JSON.stringify(box));
                if (opened) {
                    await page.locator('#article-sentence-menu [data-sentence-action="once"]').tap();
                    await page.waitForTimeout(120);
                    await hardStop(page);
                    await page.waitForTimeout(400);
                }
            }
        }
        // 桌面：快捷朗讀在這句的譯文提示旁且不壓住提示
        if (!mobile) {
            await page.mouse.move(2, 2);
            await page.waitForTimeout(60);
            await page.locator('.sent-analyze-btn').first().hover();
            await page.locator('#article-sentence-quick-read').waitFor({ state: 'visible', timeout: 4000 });
            const merged = await page.evaluate(() => {
                const quick = document.getElementById('article-sentence-quick-read').getBoundingClientRect();
                const hint = document.querySelector('.sentence-hint')?.getBoundingClientRect();
                const hit = document.elementFromPoint(quick.left + quick.width / 2, quick.top + quick.height / 2);
                return {
                    hint: hint ? { x: hint.x, y: hint.y, w: hint.width, h: hint.height } : null,
                    quick: { x: quick.x, y: quick.y, w: quick.width, h: quick.height },
                    hitQuick: !!hit?.closest?.('#article-sentence-quick-read'),
                    hitName: hit ? (hit.id || hit.tagName) : 'null',
                    overlap: hint ? !(quick.right <= hint.left || quick.left >= hint.right || quick.bottom <= hint.top || quick.top >= hint.bottom) : null
                };
            });
            ok(`A12 quick-read clickable ${pad}`, merged.hitQuick, JSON.stringify(merged));
            ok(`A13 quick-read does not cover hint ${pad}`, merged.overlap !== true, JSON.stringify(merged));
            ok(`A14 inline buttons per sentence still 1 ${pad}`, (await page.locator('.sentence-wrap').first().locator('button').count()) === 1);
        }
        // 選單開啟期間只要頁面捲動（含 App 自己的平滑自動捲動）就會關閉
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(400);
        await openMenu(page, 2, { tap: mobile });
        const survivesOwnScroll = await page.evaluate(async () => {
            window.scrollTo({ top: 1, behavior: 'smooth' });
            await new Promise((r) => setTimeout(r, 350));
            return !document.getElementById('article-sentence-menu').classList.contains('hidden');
        });
        info(`A16 menu after 1px smooth scroll ${pad}`, JSON.stringify({ stillOpen: survivesOwnScroll }));
        await page.keyboard.press('Escape');
        await page.evaluate(() => window.scrollTo(0, 0));
        ok(`A15 no page errors ${pad}`, errors.length === 0, errors.join(' | '));
    } finally { await context.close(); }
}

/* ---------- B. keyboard ---------- */
async function keyboardSuite(browser, locale) {
    const { page, context, errors } = await setup(browser, locale, 1280, 960, false);
    try {
        await page.locator('.sent-analyze-btn').nth(1).focus();
        await page.keyboard.press('Enter');
        await page.locator('#article-sentence-menu:not(.hidden)').waitFor({ state: 'visible' });
        const firstFocus = await page.evaluate(() => document.activeElement?.dataset?.sentenceAction || document.activeElement?.id);
        ok('B1 Enter opens menu and focuses first item', firstFocus === 'once', String(firstFocus));
        await page.keyboard.press('ArrowDown');
        ok('B2 ArrowDown moves', await page.evaluate(() => document.activeElement?.dataset?.sentenceAction === 'continue'));
        await page.keyboard.press('End');
        ok('B3 End goes last', await page.evaluate(() => document.activeElement?.dataset?.sentenceAction === 'analyze'));
        await page.keyboard.press('ArrowDown');
        ok('B4 ArrowDown wraps', await page.evaluate(() => document.activeElement?.dataset?.sentenceAction === 'once'));
        await page.keyboard.press('ArrowUp');
        ok('B5 ArrowUp wraps', await page.evaluate(() => document.activeElement?.dataset?.sentenceAction === 'analyze'));
        await page.keyboard.press('Home');
        ok('B6 Home goes first', await page.evaluate(() => document.activeElement?.dataset?.sentenceAction === 'once'));
        await page.keyboard.press('Escape');
        ok('B7 Escape closes and restores focus', await page.evaluate(() => (document.getElementById('article-sentence-menu').classList.contains('hidden')) && document.activeElement?.classList?.contains('sent-analyze-btn')));
        // Space 也要能開
        await page.keyboard.press(' ');
        const spaceFocus = await page.evaluate(() => document.activeElement?.dataset?.sentenceAction || document.activeElement?.id);
        ok('B8 Space opens menu with focus', spaceFocus === 'once', String(spaceFocus));
        await page.keyboard.press('Escape');
        // Tab 從選單內離開：記錄落點
        await page.keyboard.press('Enter');
        await page.locator('#article-sentence-menu:not(.hidden)').waitFor({ state: 'visible' });
        await page.keyboard.press('Tab');
        const afterTab = await page.evaluate(() => {
            const el = document.activeElement;
            return {
                closed: document.getElementById('article-sentence-menu').classList.contains('hidden'),
                tag: el?.tagName, id: el?.id, cls: el?.className, label: el?.getAttribute?.('aria-label')?.slice(0, 40),
                inArticle: !!el?.closest?.('#article-analysis-container')
            };
        });
        info('B9 Tab from menu', JSON.stringify(afterTab));
        ok('B10 Tab closes menu', afterTab.closed);
        // 方向鍵在焦點不在選單時不應攔截
        await page.locator('.sent-analyze-btn').nth(1).focus();
        await page.keyboard.press('ArrowDown');
        ok('B11 ArrowDown on trigger opens menu', await page.locator('#article-sentence-menu:not(.hidden)').count() === 1);
        await page.keyboard.press('Escape');
        // Escape 不應在沒有選單時被攔截（句卡 modal 的 Escape 仍要能關）
        await page.locator('.sent-analyze-btn').nth(1).focus();
        await page.keyboard.press('Enter');
        await pick(page, 'analyze');
        await page.locator('#app-modal:not(.hidden) .sentence-card').waitFor({ timeout: 5000 }).catch(() => {});
        await page.keyboard.press('Escape');
        await page.waitForTimeout(150);
        info('B12 Escape after analyze', JSON.stringify(await page.evaluate(() => ({ modalHidden: document.getElementById('app-modal').classList.contains('hidden'), focus: document.activeElement?.className }))));
        ok('B13 no page errors (keyboard)', errors.length === 0, errors.join(' | '));
    } finally { await context.close(); }
}

/* ---------- C. playback semantics ---------- */
async function playbackSuite(browser, locale) {
    const { page, context, errors } = await setup(browser, locale, 1280, 960, false);
    try {
        await page.selectOption('#reading-mode', 'paragraph');
        await page.locator('#chunk-repeat-times').fill('3');

        // 單句一次
        await action(page, 1, 'once');
        await page.waitForTimeout(80);
        ok('C1 once plays exact sentence', (await last(page)) === SENT[1], String(await last(page)));
        await finish(page);
        await page.waitForTimeout(350);
        ok('C2 once plays one time only', (await count(page)) === 1, String(await count(page)));
        ok('C3 once stops playback', await stopBtn(page));
        ok('C4 sidebar settings untouched', (await page.inputValue('#reading-mode')) === 'paragraph' && (await page.inputValue('#chunk-repeat-times')) === '3');

        // 從這裏開始讀：由指定句逐句各一次到文末
        await action(page, 3, 'continue');
        for (let i = 0; i < 4; i += 1) { await page.waitForTimeout(60); await finish(page); }
        await page.waitForTimeout(250);
        ok('C5 continue reads to end once each', JSON.stringify(await calls(page)) === JSON.stringify([SENT[1], SENT[3], SENT[4], SENT[5], SENT[6]]), JSON.stringify(await calls(page)));
        ok('C6 continue stops at end', await stopBtn(page));
        await hardStop(page);

        // 最後一句：只讀一次即停
        const base = await count(page);
        await action(page, 6, 'continue');
        await page.waitForTimeout(60);
        await finish(page);
        await page.waitForTimeout(300);
        ok('C7 continue from last sentence reads once', (await count(page)) === base + 1, String((await count(page)) - base));
        ok('C8 continue from last stops', await stopBtn(page));

        // 循環：間隔 >= 450ms，手動停止後不得再有遲到呼叫
        const beforeLoop = await count(page);
        await action(page, 2, 'loop');
        await page.waitForTimeout(60);
        const firstAt = await page.evaluate(() => window.__speech.calls.at(-1).at);
        await finish(page);
        await page.waitForFunction((n) => window.__speech.calls.length === n, beforeLoop + 2, { timeout: 3000 });
        const gap = await page.evaluate((at) => window.__speech.calls.at(-1).at - at, firstAt);
        ok('C9 loop repeats with ~500ms gap', gap >= 450 && gap <= 1200, `${gap}ms`);
        ok('C10 loop repeats same sentence', (await last(page)) === SENT[2], String(await last(page)));
        await page.locator('.fr-stop').click();
        const afterStop = await count(page);
        await page.waitForTimeout(900);
        ok('C11 no late loop after stop', (await count(page)) === afterStop, `${(await count(page)) - afterStop} late call(s)`);

        // 循環途中暫停（間隔中）→ 不得繼續
        await action(page, 2, 'loop');
        await finish(page);
        await page.waitForTimeout(50);
        await page.locator('.fr-toggle').click();
        const pausedAt = await count(page);
        await page.waitForTimeout(900);
        ok('C12 pause during gap cancels pending loop', (await count(page)) === pausedAt, `${(await count(page)) - pausedAt} late call(s)`);
        await page.locator('.fr-toggle').click();
        await page.waitForTimeout(120);
        ok('C13 resume replays same sentence', (await last(page)) === SENT[2], String(await last(page)));
        await page.locator('.fr-stop').click();
        await page.waitForTimeout(500);

        // 換句：循環模式保留；前後句仍可切
        await action(page, 2, 'loop');
        await page.waitForTimeout(60);
        await page.locator('.fr-next').click();
        await page.waitForTimeout(120);
        ok('C14 next keeps loop mode', (await page.locator('.floating-reader').getAttribute('data-reading-mode')) === 'loop');
        ok('C15 next reads following sentence', (await last(page)) === SENT[3], String(await last(page)));
        await finish(page);
        await page.waitForFunction((n) => window.__speech.calls.length >= n, 0, { timeout: 100 }).catch(() => {});
        await page.waitForTimeout(800);
        ok('C16 loop continues on new sentence', (await last(page)) === SENT[3], String(await last(page)));
        await page.locator('.fr-prev').click();
        await page.waitForTimeout(120);
        ok('C17 prev returns and keeps looping', (await last(page)) === SENT[2], String(await last(page)));
        await page.locator('.fr-stop').click();
        await page.waitForTimeout(500);

        // 同句同模式再點 = 停止
        await action(page, 1, 'loop');
        await page.waitForTimeout(60);
        await openMenu(page, 1);
        const stopLabel = await page.locator('#article-sentence-menu [data-sentence-action="loop"] span').textContent();
        ok('C18 menu shows stop state', stopLabel.includes('停止'), stopLabel);
        await pick(page, 'loop');
        await page.waitForTimeout(120);
        ok('C19 same sentence same mode stops', await stopBtn(page));
        const stoppedAt = await count(page);
        await page.waitForTimeout(800);
        ok('C20 no audio after same-mode stop', (await count(page)) === stoppedAt);

        // 換模式：循環 → 單句，不得再循環
        await action(page, 1, 'loop');
        await finish(page);
        await page.waitForTimeout(60);
        await action(page, 1, 'once');
        await page.waitForTimeout(100);
        await finish(page);
        const afterModeSwitch = await count(page);
        await page.waitForTimeout(900);
        ok('C21 mode switch replaces loop', (await count(page)) === afterModeSwitch, `${(await count(page)) - afterModeSwitch} late call(s)`);
        ok('C22 mode switch leaves stopped state', await stopBtn(page));

        // 遲到循環競態：間隔期間立刻切到另一句
        await action(page, 1, 'loop');
        await finish(page);
        await page.waitForTimeout(40);
        await action(page, 4, 'once');
        await page.waitForTimeout(100);
        const raceLast = await last(page);
        await finish(page);
        const raceCount = await count(page);
        await page.waitForTimeout(900);
        ok('C23 no late loop when switching sentence in gap', raceLast === SENT[4] && (await count(page)) === raceCount, JSON.stringify({ raceLast, raceCount, now: await count(page) }));

        // 全文朗讀被取代後不得自動恢復
        await page.click('#read-article-btn');
        await page.waitForTimeout(900);
        const fullFirst = await last(page);
        await action(page, 5, 'once');
        await page.waitForTimeout(100);
        await finish(page);
        const replacedCount = await count(page);
        await page.waitForTimeout(900);
        ok('C24 full reading replaced, not resumed', (await count(page)) === replacedCount && await stopBtn(page), JSON.stringify({ fullFirst, replacedCount, now: await count(page) }));

        // 其他音訊中斷循環
        await action(page, 1, 'loop');
        await page.waitForTimeout(60);
        await finish(page);
        await page.waitForTimeout(80);
        await page.evaluate(async () => (await import('/modules/audio.js')).speakText('word', 'english', 0, null, null, { owner: 'word-test' }));
        const interrupted = await count(page);
        await page.waitForTimeout(900);
        ok('C25 other audio stops loop', (await count(page)) === interrupted, `${(await count(page)) - interrupted} late call(s)`);
        await page.locator('.fr-toggle').click();
        await page.waitForTimeout(120);
        ok('C26 resume after interruption replays once', (await last(page)) === SENT[1], String(await last(page)));
        await hardStop(page);

        // 語音錯誤不得無限重試
        await action(page, 1, 'loop');
        await page.evaluate(() => window.__speech.error?.({ error: 'audit-error' }));
        await page.waitForTimeout(900);
        ok('C27 error ends loop without retry', await stopBtn(page));

        // 播放中的自動捲動會不會把剛開的選單關掉
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await page.waitForTimeout(300);
        await action(page, 0, 'once');
        const menuSurvivedAutoScroll = await page.evaluate(async () => {
            const trigger = document.querySelector('.sent-analyze-btn');
            trigger.click();
            const openedNow = !document.getElementById('article-sentence-menu').classList.contains('hidden');
            await new Promise((r) => setTimeout(r, 500));
            return { openedNow, stillOpen: !document.getElementById('article-sentence-menu').classList.contains('hidden') };
        });
        info('C29 menu vs app auto-scroll', JSON.stringify(menuSurvivedAutoScroll));
        await page.keyboard.press('Escape');
        await hardStop(page);
        // 清空文章會停止循環
        await action(page, 1, 'loop');
        const beforeClear = await count(page);
        await page.evaluate(() => document.getElementById('clear-article-btn').click());
        await page.waitForTimeout(900);
        ok('C28 clearing article stops loop', (await count(page)) === beforeClear, `${(await count(page)) - beforeClear} late call(s)`);
        ok('C29 no page errors (playback)', errors.length === 0, errors.join(' | '));
    } finally { await context.close(); }
}

/* ---------- D. selection reading ---------- */
async function selectRange(page, selector, startOffset, endOffset) {
    return page.evaluate(({ selector, startOffset, endOffset }) => {
        const root = document.querySelector(selector);
        if (!root) return 'no-node';
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const nodes = [];
        let node = walker.nextNode();
        while (node) { nodes.push(node); node = walker.nextNode(); }
        let acc = 0, startNode = null, startIdx = 0, endNode = null, endIdx = 0;
        for (const n of nodes) {
            const len = n.nodeValue.length;
            if (!startNode && startOffset <= acc + len) { startNode = n; startIdx = startOffset - acc; }
            if (!endNode && endOffset <= acc + len) { endNode = n; endIdx = endOffset - acc; break; }
            acc += len;
        }
        if (!startNode || !endNode) return 'range-fail';
        const range = document.createRange();
        range.setStart(startNode, startIdx);
        range.setEnd(endNode, endIdx);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
        return sel.toString();
    }, { selector, startOffset, endOffset });
}

async function selectionSuite(browser, locale, width, mobile) {
    const pad = `${mobile ? 'm' + width : 'desktop'}/${locale}`;
    const { page, context, errors } = await setup(browser, locale, width, mobile ? 844 : 960, mobile);
    try {
        const selected = await selectRange(page, '.interactive-sentence', 0, 11);
        await page.waitForTimeout(150);
        await page.locator('.article-selection-bar.is-visible').waitFor({ timeout: 3000 }).catch(() => {});
        const visible = await page.locator('.article-selection-bar.is-visible').count() === 1;
        ok(`D1 selection toolbar appears ${pad}`, visible, String(selected));
        if (visible) {
            const box = await page.locator('.article-selection-bar').boundingBox();
            ok(`D2 toolbar inside viewport ${pad}`, box.x >= 0 && box.x + box.width <= width + 0.5 && box.y >= 0 && box.y + box.height <= (mobile ? 844 : 960) + 0.5, JSON.stringify(box));
            const hit = await page.evaluate(() => {
                const b = document.querySelector('.article-selection-bar [data-act="read"]').getBoundingClientRect();
                const el = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
                return { act: el?.closest?.('[data-act]')?.dataset?.act, w: Math.round(b.width), h: Math.round(b.height) };
            });
            ok(`D3 read button clickable ${pad}`, hit.act === 'read', JSON.stringify(hit));
            ok(`D4 read button target size ${pad}`, hit.w >= 28 && hit.h >= 28, JSON.stringify(hit));
            await shot(page, `D-selection-${mobile ? width : 'desktop'}-${locale}.png`);
            if (mobile) await page.locator('.article-selection-bar [data-act="read"]').tap();
            else await page.locator('.article-selection-bar [data-act="read"]').click();
            await page.waitForTimeout(150);
            ok(`D5 selection read plays selected text only ${pad}`, (await last(page)) === selected, `got=${await last(page)} want=${selected}`);
            await finish(page);
            const n = await count(page);
            await page.waitForTimeout(700);
            ok(`D6 selection read stops after once ${pad}`, (await count(page)) === n && await stopBtn(page));
            ok(`D7 toolbar hides after read ${pad}`, (await page.locator('.article-selection-bar.is-visible').count()) === 0);
        }
        // 中文譯文選取
        const zhSel = await selectRange(page, '.interactive-sentence-zh', 0, 3);
        await page.waitForTimeout(150);
        const zhBar = await page.locator('.article-selection-bar.is-visible').count();
        info(`D8 Chinese selection ${pad}`, JSON.stringify({ selected: zhSel, barShown: zhBar === 1 }));
        if (zhBar) {
            const hasRead = await page.locator('.article-selection-bar [data-act="read"]').count();
            await page.locator('.article-selection-bar [data-act="read"]').click();
            await page.waitForTimeout(150);
            const msgs = await page.evaluate(() => [...document.querySelectorAll('.message, .toast, #message-container *')].map((e) => e.textContent.trim()).filter(Boolean).slice(0, 3));
            info(`D9 Chinese selection read ${pad}`, JSON.stringify({ hasRead, speech: await count(page), messages: msgs }));
            await hardStop(page);
        }
        ok(`D10 no page errors (selection) ${pad}`, errors.length === 0, errors.join(' | '));
    } finally { await context.close(); }
}

/* ---------- E. AI lazy-load / locale switch ---------- */
async function aiAndLocaleSuite(browser, locale) {
    const other = locale === 'zh-CN' ? 'zh-HK' : 'zh-CN';
    const { page, context, errors, external } = await setup(browser, locale, 1280, 960, false);
    try {
        await openMenu(page, 1);
        await page.keyboard.press('Escape');
        await action(page, 1, 'once');
        await finish(page);
        await page.waitForTimeout(150);
        ok('E1 no external request for menu or read', external.length === 0, JSON.stringify(external.slice(0, 4)));
        ok('E2 AI not triggered by reading', (await page.locator('#app-modal:not(.hidden)').count()) === 0);

        // 播放中切換介面語言
        await action(page, 1, 'loop');
        await page.waitForTimeout(80);
        const beforeSwitch = await count(page);
        await page.evaluate(async (l) => (await import('/modules/i18n.js')).setLocale(l), other);
        await page.waitForTimeout(120);
        const readerLabel = await page.locator('.floating-reader').getAttribute('aria-label');
        ok('E3 floating reader carries mode label', !!readerLabel && readerLabel.includes(LABELS[other][2]), String(readerLabel));
        await finish(page);
        await page.waitForFunction((n) => window.__speech.calls.length > n, beforeSwitch, { timeout: 3000 }).catch(() => {});
        ok('E4 loop survives locale switch', (await count(page)) > beforeSwitch, `${beforeSwitch} -> ${await count(page)}`);
        await openMenu(page, 1);
        const labelsAfter = await page.locator('#article-sentence-menu span').allTextContents();
        ok('E5 menu labels follow locale', labelsAfter[0] === LABELS[other][0] && labelsAfter[3] === LABELS[other][3], JSON.stringify(labelsAfter));
        const triggerLabel = await page.locator('.sent-analyze-btn').nth(1).getAttribute('aria-label');
        ok('E6 trigger aria-label follows locale', triggerLabel.includes('句子操作'), String(triggerLabel));
        await page.keyboard.press('Escape');
        await hardStop(page);
        await page.evaluate(async (l) => (await import('/modules/i18n.js')).setLocale(l), locale);

        // 帳戶／範圍切換：循環必須停止
        await action(page, 1, 'loop');
        const beforeScope = await count(page);
        await page.evaluate(() => document.dispatchEvent(new CustomEvent('bdc:articles-scope-changed')));
        await page.waitForTimeout(900);
        ok('E7 account scope change stops loop', (await count(page)) === beforeScope, `${(await count(page)) - beforeScope} late call(s)`);
        ok('E8 menu closed after scope change', (await page.locator('#article-sentence-menu:not(.hidden)').count()) === 0);
        ok('E9 no page errors (ai/locale)', errors.length === 0, errors.join(' | '));
    } finally { await context.close(); }
}

/* ---------- F. cross-module navigation while looping ---------- */
async function navigationSuite(browser) {
    const { page, context, errors } = await setup(browser, 'zh-CN', 1280, 960, false);
    try {
        await action(page, 1, 'loop');
        await page.waitForTimeout(60);
        const before = await count(page);
        await page.evaluate(() => { window.location.hash = '#/phonetics'; });
        await page.waitForTimeout(1200);
        const after = await count(page);
        info('F1 loop after navigating to another module', JSON.stringify({ before, after, stillPlaying: after > before }));
        await page.evaluate(() => { window.location.hash = '#/article'; });
        await page.waitForTimeout(300);
        await hardStop(page);
        ok('F2 no page errors (navigation)', errors.length === 0, errors.join(' | '));
    } finally { await context.close(); }
}

(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
    try {
        for (const locale of Object.keys(LABELS)) {
            await layoutSuite(browser, locale, 1280, 960, false);
            await layoutSuite(browser, locale, 320, 844, true);
            await layoutSuite(browser, locale, 390, 844, true);
        }
        await keyboardSuite(browser, 'zh-CN');
        await keyboardSuite(browser, 'zh-HK');
        await playbackSuite(browser, 'zh-CN');
        await playbackSuite(browser, 'zh-HK');
        await selectionSuite(browser, 'zh-CN', 1280, false);
        await selectionSuite(browser, 'zh-CN', 320, true);
        await selectionSuite(browser, 'zh-HK', 320, true);
        await aiAndLocaleSuite(browser, 'zh-CN');
        await aiAndLocaleSuite(browser, 'zh-HK');
        await navigationSuite(browser);
    } finally { await browser.close(); }
    const fails = results.filter((r) => r.status === 'FAIL');
    console.log(`\n== ${results.filter((r) => r.status === 'PASS').length} pass, ${fails.length} fail, ${results.filter((r) => r.status === 'INFO').length} info ==`);
    if (OUT) fs.writeFileSync(path.join(OUT, 'audit-results.json'), JSON.stringify(results, null, 2));
    if (fails.length) { console.log('FAILURES:\n' + fails.map((f) => `- ${f.id} :: ${f.detail}`).join('\n')); process.exitCode = 1; }
})().catch((error) => { console.error(error); process.exitCode = 1; });
