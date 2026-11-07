#!/usr/bin/env node
/**
 * 除錯用：印出 320×720 / 320×560 空詞書與長標題下，⋯ 選單與 header 的實際幾何與定位來源，
 * 並在開啟後連續取樣 1 秒，確認是否有後續重新定位。
 */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8313);
const BASE = `http://127.0.0.1:${PORT}/`;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MOCK = `export const AI_LIMITS={default:{maxConcurrency:1,minIntervalMs:400}};
export const TTS_CONFIG={baseUrl:'',baseUrlRemote:'',baseUrlLocal:'',use:'remote',voicesUrl:'',apiKey:'',voices:{}};
export const OCR_CONFIG={DEFAULT_MODEL:''};
export const ARTICLE_IMPORT={FEED_URL:'',PROXY_URL:'',SOURCES:[]};
export const SYNC={};export const SUPABASE={};`;
const EN = "Mike: Some volunteers help sell flags in the street. There are some other volunteers who help online. I'm one of them. Last month, I filmed a video to encourage people to donate money and posted it online. Although it took time, it was meaningful.";
const BOOK = [{ id: 'book-long', name: EN, createdAt: '2026-01-01T00:00:00.000Z', sourceType: 'legacy', words: [] }];

const PROBE = () => {
    const menu = document.getElementById('word-panel-menu');
    const header = document.getElementById('current-book-name')?.closest('.panel-header');
    const more = document.getElementById('word-panel-more-btn');
    const nav = document.querySelector('.app-nav');
    const panel = document.getElementById('vocab-words-panel');
    const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { y: +b.y.toFixed(1), bottom: +b.bottom.toFixed(1), h: +b.height.toFixed(1) }; };
    return {
        t: Math.round(performance.now()),
        scrollY: Math.round(window.scrollY),
        innerHeight: window.innerHeight,
        menuHidden: menu ? menu.hidden : null,
        menuDisplay: menu ? getComputedStyle(menu).display : null,
        menuRect: r(menu),
        menuInlineTop: menu ? menu.style.top : null,
        menuInlineMaxH: menu ? menu.style.maxHeight : null,
        menuOffsetParent: menu && menu.offsetParent ? `${menu.offsetParent.tagName}#${menu.offsetParent.id}` : null,
        menuOffsetTop: menu ? menu.offsetTop : null,
        headerRect: r(header),
        headerOffsetTop: header ? header.offsetTop : null,
        headerOffsetParent: header && header.offsetParent ? `${header.offsetParent.tagName}#${header.offsetParent.id}` : null,
        moreRect: r(more),
        navRect: r(nav),
        panelRect: r(panel),
        ariaExpanded: more ? more.getAttribute('aria-expanded') : null
    };
};

(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: CHROME });
    const out = [];
    for (const c of [
        { id: 'empty-320x720', w: 320, h: 720, books: [], active: null },
        { id: 'empty-320x560', w: 320, h: 560, books: [], active: null },
        { id: 'long-320x720', w: 320, h: 720, books: BOOK, active: 'book-long' },
        { id: 'long-320x560', w: 320, h: 560, books: BOOK, active: 'book-long' }
    ]) {
        const context = await browser.newContext({ viewport: { width: c.w, height: c.h }, locale: 'zh-CN' });
        await context.route('**/*', (route) => {
            let url; try { url = new URL(route.request().url()); } catch (_) { return route.abort(); }
            if (url.pathname.endsWith('/ai-config.js')) return route.fulfill({ status: 200, contentType: 'application/javascript', body: MOCK });
            return (url.hostname === '127.0.0.1' || url.hostname === 'localhost') ? route.continue() : route.abort();
        });
        await context.addInitScript(({ books, active }) => {
            localStorage.clear();
            localStorage.setItem('vocabularyBooks', JSON.stringify(books));
            if (active) localStorage.setItem('activeBookId', active);
            localStorage.setItem('vocabImportPromptShown', '1');
            localStorage.setItem('pen_global_settings', JSON.stringify({ language: { interfaceLocale: 'zh-CN' }, assistant: { enabled: false } }));
        }, { books: c.books, active: c.active });
        const page = await context.newPage();
        await page.goto(`${BASE}#v`, { waitUntil: 'load' });
        await page.waitForTimeout(1200);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(200);
        const before = await page.evaluate(PROBE);
        await page.evaluate(() => document.getElementById('word-panel-more-btn')?.click());
        const samples = [];
        for (let i = 0; i < 8; i++) {
            await page.waitForTimeout(120);
            samples.push(await page.evaluate(PROBE));
        }
        out.push({ case: c.id, before, samples });
        console.log(`\n=== ${c.id} ===`);
        console.log('before:', JSON.stringify(before));
        samples.forEach((s) => console.log('  ', JSON.stringify(s)));
        await context.close();
    }
    await browser.close();
    fs.writeFileSync(path.join(__dirname, 'debug-geometry.json'), JSON.stringify(out, null, 2));
})();
