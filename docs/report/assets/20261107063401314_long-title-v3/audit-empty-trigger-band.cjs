#!/usr/bin/env node
/**
 * V3 長標題最終覆驗 — C（邊界掃描）：空詞書狀態下，哪些「真實手機高度」會讓 ⋯ 按鈕與固定底部導覽列重疊，
 * 以至於 positionWordPanelMenu 的可見帶守衛（trigger 必須完整落在 viewportTop..viewportBottom 內）
 * 立即把選單收合 → 使用者按了 ⋯ 卻沒有選單。
 *
 * 量測：每個 (寬, 高) 組合，scrollY=0、空詞書、點 ⋯ 後 400ms 量選單是否真的開啟，
 * 並記錄 trigger 與導覽列的幾何關係（重疊像素）。
 *
 * 用法：
 *   PORT=8313 PLAYWRIGHT_MODULE=<playwright> node docs/report/assets/<ts>_long-title-v3/audit-empty-trigger-band.cjs
 */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('fs');
const path = require('path');

const ROOT = '/Users/linus/CODE/bdc';
const PORT = Number(process.env.PORT || 8313);
const BASE = `http://127.0.0.1:${PORT}/`;
const ASSET_DIR = __dirname;
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const MOCK = `export const AI_LIMITS={default:{maxConcurrency:1,minIntervalMs:400}};
export const TTS_CONFIG={baseUrl:'',baseUrlRemote:'',baseUrlLocal:'',use:'remote',voicesUrl:'',apiKey:'',voices:{}};
export const OCR_CONFIG={DEFAULT_MODEL:''};
export const ARTICLE_IMPORT={FEED_URL:'',PROXY_URL:'',SOURCES:[]};
export const SYNC={};export const SUPABASE={};`;

const PROBE = () => {
    const menu = document.getElementById('word-panel-menu');
    const more = document.getElementById('word-panel-more-btn');
    const nav = document.querySelector('.app-nav');
    const header = document.getElementById('current-book-name')?.closest('.panel-header');
    const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { y: +r.y.toFixed(1), bottom: +r.bottom.toFixed(1), h: +r.height.toFixed(1), w: +r.width.toFixed(1) }; };
    const mr = more ? more.getBoundingClientRect() : null;
    const nr = nav ? nav.getBoundingClientRect() : null;
    const navTop = nr && nr.top > window.innerHeight / 2 ? nr.top : window.innerHeight;
    const triggerBottom = mr ? mr.bottom : 0;
    const overlap = mr && nr && nr.top > window.innerHeight / 2 ? Math.max(0, Math.min(mr.bottom, nr.bottom) - Math.max(mr.top, nr.top)) : 0;
    return {
        scrollY: Math.round(window.scrollY),
        innerHeight: window.innerHeight,
        header: box(header),
        more: box(more),
        nav: box(nav),
        navTop,
        triggerOverlapWithNav: +overlap.toFixed(1),
        fullTriggerInsideBand: triggerBottom <= navTop + 0.01,
        menuOpen: menu ? !menu.hidden : null,
        menuRect: box(menu),
        menuInlineTop: menu ? menu.style.top : '',
        menuInlineMaxHeight: menu ? menu.style.maxHeight : '',
        ariaExpanded: more ? more.getAttribute('aria-expanded') : null
    };
};

(async () => {
    const launchOpts = { headless: true };
    if (fs.existsSync(CHROME)) launchOpts.executablePath = CHROME;
    const browser = await chromium.launch(launchOpts);
    const sizes = [];
    for (const width of [320, 360]) {
        for (const height of [500, 520, 540, 560, 568, 580, 600, 620, 640, 720]) sizes.push({ width, height });
    }
    const results = [];
    for (const locale of ['zh-CN', 'zh-HK']) {
        for (const size of sizes) {
            for (const mode of ['empty', 'long']) {
                const context = await browser.newContext({
                    viewport: { width: size.width, height: size.height },
                    locale: locale === 'zh-HK' ? 'zh-HK' : 'zh-CN'
                });
                await context.route('**/*', (route) => {
                    let url;
                    try { url = new URL(route.request().url()); } catch (_) { return route.abort(); }
                    if (url.pathname.endsWith('/ai-config.js')) {
                        return route.fulfill({ status: 200, contentType: 'application/javascript', body: MOCK });
                    }
                    return (url.hostname === '127.0.0.1' || url.hostname === 'localhost') ? route.continue() : route.abort();
                });
                await context.addInitScript(({ mode, locale }) => {
                    localStorage.clear();
                    const books = mode === 'empty' ? [] : [{
                        id: 'book-long',
                        name: "Mike: Some volunteers help sell flags in the street. There are some other volunteers who help online. I'm one of them.",
                        createdAt: '2026-01-01T00:00:00.000Z', sourceType: 'legacy', words: []
                    }];
                    localStorage.setItem('vocabularyBooks', JSON.stringify(books));
                    if (books.length) localStorage.setItem('activeBookId', 'book-long');
                    localStorage.setItem('vocabImportPromptShown', '1');
                    localStorage.setItem('pen_global_settings', JSON.stringify({ language: { interfaceLocale: locale }, assistant: { enabled: false } }));
                }, { mode, locale });
                const page = await context.newPage();
                await page.goto(`${BASE}#v`, { waitUntil: 'load' });
                await page.waitForTimeout(1100);
                await page.evaluate(() => window.scrollTo(0, 0));
                await page.waitForTimeout(150);
                const before = await page.evaluate(PROBE);
                await page.evaluate(() => document.getElementById('word-panel-more-btn')?.click());
                await page.waitForTimeout(400);
                const after = await page.evaluate(PROBE);
                results.push({ locale, mode, size, before, after });
                await context.close();
            }
        }
    }
    await browser.close();
    const jsonPath = path.join(ASSET_DIR, 'empty-trigger-band.json');
    fs.writeFileSync(jsonPath, JSON.stringify({ finishedAt: new Date().toISOString(), results }, null, 2));

    console.log('locale mode  size       trigger(y..bottom) navTop overlap opensMenu  menuRect');
    results.forEach((r) => {
        const b = r.after;
        console.log(`${r.locale} ${r.mode.padEnd(5)} ${String(r.size.width).padStart(4)}x${String(r.size.height).padEnd(4)} more=${b.more ? `${b.more.y}..${b.more.bottom}` : 'n/a'} navTop=${b.navTop} ov=${b.triggerOverlapWithNav} opens=${b.menuOpen}${b.menuOpen ? ` ${b.menuRect.y}..${b.menuRect.bottom}` : ''}`);
    });
    const failures = results.filter((r) => !r.after.menuOpen);
    console.log(`\nmenu-not-open cases: ${failures.length}`);
    console.log(`json: ${path.relative(ROOT, jsonPath)}`);
})();
