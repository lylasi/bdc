#!/usr/bin/env node
/**
 * V4 補測：320×400 / 320×260 這種「入口需要先捲動才看得到」的尺寸，真實使用者能否開啟「更多」選單。
 *
 * 背景：定案版本在 openWordPanelMenu 註冊了 window scroll → closeWordPanelMenu。
 *       Playwright 的 page.click 會自動把元素捲進視窗（scroll 事件可能在開啟後才派發），
 *       因此腳本改用「先自己捲到入口、等捲動事件沉澱、再按螢幕座標點擊」的人類操作順序，
 *       用來區分「產品真的開不起來」與「測試工具自動捲動造成的假象」。
 *
 * 只量測；不改正式程式碼。
 */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = '/Users/linus/CODE/bdc';
const PORT = Number(process.env.PORT || 8313);
const BASE = `http://127.0.0.1:${PORT}/`;
const ASSET_DIR = __dirname;
const SHOTS = path.join(ASSET_DIR, 'shots');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const MOCK = `export const AI_LIMITS={default:{maxConcurrency:1,minIntervalMs:400}};
export const TTS_CONFIG={baseUrl:'',baseUrlRemote:'',baseUrlLocal:'',use:'remote',voicesUrl:'',apiKey:'',voices:{}};
export const OCR_CONFIG={DEFAULT_MODEL:''};
export const ARTICLE_IMPORT={FEED_URL:'',PROXY_URL:'',SOURCES:[]};
export const SYNC={};export const SUPABASE={};`;
const EN_ARTICLE = "Mike: Some volunteers help sell flags in the street. There are some other volunteers who help online. I'm one of them. Last month, I filmed a video to encourage people to donate money and posted it online. Although it took time, it was meaningful.";

const STATE = () => {
    const menu = document.getElementById('word-panel-menu');
    const more = document.getElementById('word-panel-more-btn');
    const br = document.querySelector('.app-bar').getBoundingClientRect();
    const nr = document.querySelector('.app-nav').getBoundingClientRect();
    const cs = getComputedStyle(menu);
    const r = menu.getBoundingClientRect();
    const round = (n) => +n.toFixed(1);
    const items = Array.from(menu.querySelectorAll('.menu-item')).map((el) => {
        const rr = el.getBoundingClientRect();
        const cx = rr.x + rr.width / 2;
        const cy = rr.y + rr.height / 2;
        // 只有「完整落在選單框內」才可能是『被遮住』；超出選單框＝需要捲動，不算
        const fullyInside = rr.top >= r.top - 0.5 && rr.bottom <= r.bottom + 0.5;
        const top = (fullyInside && cy > 0 && cy < innerHeight) ? document.elementFromPoint(cx, cy) : null;
        return {
            text: el.textContent.trim(), y: round(rr.y), centerY: round(cy), fullyInside,
            hit: fullyInside ? (top && (top === el || el.contains(top)) ? 'self' : (top ? `${top.tagName}.${String(top.className || '').slice(0, 22)}` : '(null)')) : 'clipped'
        };
    });
    return {
        scrollY: round(scrollY),
        band: { top: round(br.bottom), bottom: round(nr.top) },
        trigger: { top: round(more.getBoundingClientRect().top), bottom: round(more.getBoundingClientRect().bottom) },
        hidden: menu.hidden, ariaExpanded: more.getAttribute('aria-expanded'),
        painted: cs.display !== 'none' && r.height > 0,
        menu: { y: round(r.y), bottom: round(r.bottom), h: round(r.height), scrollable: menu.scrollHeight > menu.clientHeight + 1 },
        items
    };
};

(async () => {
    fs.mkdirSync(SHOTS, { recursive: true });
    const build = execSync('md5 -q features/vocabulary/vocabulary.js index.html styles.css', { cwd: ROOT }).toString().trim().split('\n');
    const launchOpts = { headless: true };
    if (fs.existsSync(CHROME)) launchOpts.executablePath = CHROME;
    const browser = await chromium.launch(launchOpts);
    const results = [];

    for (const locale of ['zh-CN', 'zh-HK']) {
        for (const kind of ['empty', 'long']) {
            for (const vp of [{ w: 320, h: 400 }, { w: 320, h: 260 }]) {
                const context = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, locale: locale === 'zh-HK' ? 'zh-HK' : 'zh-CN' });
                await context.route('**/*', (route) => {
                    let url;
                    try { url = new URL(route.request().url()); } catch (_) { return route.abort(); }
                    if (url.pathname.endsWith('/ai-config.js')) return route.fulfill({ status: 200, contentType: 'application/javascript', body: MOCK });
                    return (url.hostname === '127.0.0.1' || url.hostname === 'localhost') ? route.continue() : route.abort();
                });
                const books = kind === 'empty' ? [] : [{ id: 'book-long', name: EN_ARTICLE, createdAt: '2026-01-01T00:00:00.000Z', sourceType: 'legacy', words: [{ id: 'l1', word: 'volunteer', meaning: '志愿者', sources: [] }] }];
                await context.addInitScript(({ books, activeId, locale }) => {
                    localStorage.clear();
                    localStorage.setItem('vocabularyBooks', JSON.stringify(books));
                    if (activeId) localStorage.setItem('activeBookId', activeId);
                    localStorage.setItem('vocabImportPromptShown', '1');
                    localStorage.setItem('pen_global_settings', JSON.stringify({ language: { interfaceLocale: locale }, assistant: { enabled: false } }));
                }, { books, activeId: kind === 'empty' ? null : 'book-long', locale });

                const page = await context.newPage();
                const pageErrors = [];
                page.on('pageerror', (e) => pageErrors.push(String(e && e.message || e).slice(0, 160)));
                await page.goto(`${BASE}#v${kind === 'empty' ? '' : '/book-long'}`, { waitUntil: 'load' });
                await page.waitForTimeout(1100);

                const entry = { locale, kind, viewport: `${vp.w}x${vp.h}`, steps: [], pageErrors };

                // ① 人類順序：用真實滾輪把入口捲到「完整落在操作區內」，等捲動事件沉澱，再按座標點擊
                await page.mouse.move(vp.w / 2, vp.h / 2);
                let placed = null;
                for (let i = 0; i < 18; i += 1) {
                    const st = await page.evaluate(STATE);
                    if (st.trigger.top >= st.band.top && st.trigger.bottom <= st.band.bottom) { placed = st; break; }
                    await page.mouse.wheel(0, 50);
                    await page.waitForTimeout(160);
                }
                await page.waitForTimeout(500); // 讓捲動事件沉澱
                const before = await page.evaluate(STATE);
                const rect = await page.evaluate(() => {
                    const r = document.getElementById('word-panel-more-btn').getBoundingClientRect();
                    return { x: r.x + r.width / 2, y: r.y + r.height / 2, visible: r.top >= 0 && r.bottom <= innerHeight };
                });
                entry.scrollSteps = placed ? 'placed-in-band' : 'never-fully-in-band';
                entry.steps.push({ step: 'before-human-click', ...before, btn: rect });
                if (!rect.visible) {
                    entry.verdict = 'entry-not-visible-after-scroll';
                } else if (before.trigger.top < before.band.top || before.trigger.bottom > before.band.bottom) {
                    entry.verdict = `entry-not-fully-in-band(trigger=${JSON.stringify(before.trigger)},band=${JSON.stringify(before.band)})`;
                } else {
                    await page.mouse.click(rect.x, rect.y);
                    await page.waitForTimeout(350);
                    const after = await page.evaluate(STATE);
                    entry.steps.push({ step: 'after-human-click', ...after });
                    entry.verdict = after.hidden
                        ? (after.trigger.top < after.band.top || after.trigger.bottom > after.band.bottom ? 'closed-by-design(trigger-outside-band)' : 'closed-although-trigger-in-band')
                        : 'open';
                    const badItems = after.items.filter((i) => i.fullyInside && i.hit !== 'self');
                    if (!after.hidden && badItems.length) entry.verdict = 'open-but-items-covered:' + JSON.stringify(badItems);
                    await page.screenshot({ path: path.join(SHOTS, `human-open_${kind}_${locale}-${vp.w}x${vp.h}.png`) }).catch(() => {});
                }
                // ③ 診斷：重載後改用 Playwright 的 page.click（會自動把入口捲進視窗），
                //    證明「自動捲動造成的 scroll 事件」會在新版 scroll→close 下把剛開的選單收掉（測試工具假象）
                if (vp.h === 400) {
                    await page.reload({ waitUntil: 'load' });
                    await page.waitForTimeout(700);
                    await page.evaluate(() => window.scrollTo(0, 0));
                    await page.waitForTimeout(700);
                    await page.evaluate(() => {
                        window.__scrollEvents = 0;
                        window.addEventListener('scroll', () => { window.__scrollEvents += 1; }, { passive: true });
                    });
                    const y0 = await page.evaluate(() => scrollY);
                    await page.click('#word-panel-more-btn');
                    await page.waitForTimeout(400);
                    entry.autoscrollClick = await page.evaluate((startY) => ({
                        startScrollY: startY,
                        scrollY: Math.round(scrollY),
                        scrollEvents: window.__scrollEvents,
                        hidden: document.getElementById('word-panel-menu').hidden,
                        ariaExpanded: document.getElementById('word-panel-more-btn').getAttribute('aria-expanded')
                    }), y0);
                }

                results.push(entry);
                await context.close();
            }
        }
    }

    await browser.close();
    const jsonPath = path.join(ASSET_DIR, 'menu-open-short-v4.json');
    fs.writeFileSync(jsonPath, JSON.stringify({ finishedAt: new Date().toISOString(), build, results }, null, 2));
    results.forEach((r) => {
        const a = r.steps[r.steps.length - 1];
        console.log(`${r.locale}/${r.kind}@${r.viewport}: ${r.verdict} | scrollY=${a.scrollY} trigger=${JSON.stringify(a.trigger)} band=${JSON.stringify(a.band)} menu=${JSON.stringify(a.menu)} aria=${a.ariaExpanded}`);
    });
    console.log(`json: ${path.relative(ROOT, jsonPath)}`);
})();
