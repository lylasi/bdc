#!/usr/bin/env node
/**
 * V4「選單可操作範圍」定點覆驗 — D：真實滾輪輸入下，選單與頁面捲動的關係
 *
 * 背景：V4 定案版本在 openWordPanelMenu 內加了 `window.addEventListener('scroll', closeWordPanelMenu)`；
 *       本腳本用真實 mouse wheel（不是程式化 scrollTo）驗兩件事：
 *   D1 在選單外滾動頁面 → 選單應立刻收起（hidden=true、aria-expanded=false、display:none、該點不再命中選單）。
 *   D2 在「可捲動的選單」內部滾動 → 選單先自己捲（不得一滾就關）；捲到底後若鏈式帶動頁面捲動，
 *      此時收起屬可接受（等同入口離開操作區）。記錄兩種結果，不預設對錯。
 *
 * 只量測；不改正式程式碼。獨立 context、空 SYNC mock、封鎖外站。
 * 用法：PORT=8313 PLAYWRIGHT_MODULE=<playwright> node <此檔>
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
    const bar = document.querySelector('.app-bar');
    const nav = document.querySelector('.app-nav');
    const ih = innerHeight;
    const iw = innerWidth;
    const br = bar.getBoundingClientRect();
    const nr = nav.getBoundingClientRect();
    const cs = getComputedStyle(menu);
    const r = menu.getBoundingClientRect();
    const round = (n) => +n.toFixed(1);
    const items = Array.from(menu.querySelectorAll('.menu-item')).map((el) => {
        const rr = el.getBoundingClientRect();
        const cx = rr.x + rr.width / 2;
        const cy = rr.y + rr.height / 2;
        const top = (cy > 0 && cy < ih) ? document.elementFromPoint(cx, cy) : null;
        const fullyInside = rr.top >= r.top - 0.5 && rr.bottom <= r.bottom + 0.5;
        return {
            text: (el.textContent || '').trim(), y: round(rr.y), bottom: round(rr.bottom), fullyInside,
            hit: fullyInside ? (top && (top === el || el.contains(top)) ? 'self' : (top ? `${top.tagName}.${String(top.className || '').slice(0, 24)}` : '(null)')) : 'clipped'
        };
    });
    return {
        scrollY: round(window.scrollY),
        band: { top: round(br.bottom), bottom: round(nr.top) },
        trigger: { top: round(more.getBoundingClientRect().top), bottom: round(more.getBoundingClientRect().bottom) },
        hidden: menu.hidden,
        ariaExpanded: more.getAttribute('aria-expanded'),
        display: cs.display,
        painted: cs.display !== 'none' && r.height > 0,
        menu: { y: round(r.y), bottom: round(r.bottom), h: round(r.height), scrollTop: menu.scrollTop, scrollHeight: menu.scrollHeight, clientHeight: menu.clientHeight },
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
        for (const scenario of [
            { id: 'outside-scroll-320x400-empty', width: 320, height: 400, kind: 'empty', where: 'outside' },
            { id: 'outside-scroll-320x400-long', width: 320, height: 400, kind: 'long', where: 'outside' },
            { id: 'inside-menu-scroll-320x720-empty', width: 320, height: 720, kind: 'empty', where: 'inside' }
        ]) {
            const context = await browser.newContext({ viewport: { width: scenario.width, height: scenario.height }, locale: locale === 'zh-HK' ? 'zh-HK' : 'zh-CN' });
            await context.route('**/*', (route) => {
                let url;
                try { url = new URL(route.request().url()); } catch (_) { return route.abort(); }
                if (url.pathname.endsWith('/ai-config.js')) return route.fulfill({ status: 200, contentType: 'application/javascript', body: MOCK });
                return (url.hostname === '127.0.0.1' || url.hostname === 'localhost') ? route.continue() : route.abort();
            });
            const books = scenario.kind === 'empty' ? [] : [{ id: 'book-long', name: EN_ARTICLE, createdAt: '2026-01-01T00:00:00.000Z', sourceType: 'legacy', words: [{ id: 'l1', word: 'volunteer', meaning: '志愿者', sources: [] }] }];
            await context.addInitScript(({ books, activeId, locale }) => {
                localStorage.clear();
                localStorage.setItem('vocabularyBooks', JSON.stringify(books));
                if (activeId) localStorage.setItem('activeBookId', activeId);
                localStorage.setItem('vocabImportPromptShown', '1');
                localStorage.setItem('pen_global_settings', JSON.stringify({ language: { interfaceLocale: locale }, assistant: { enabled: false } }));
            }, { books, activeId: scenario.kind === 'empty' ? null : 'book-long', locale });

            const page = await context.newPage();
            const pageErrors = [];
            page.on('pageerror', (e) => pageErrors.push(String(e && e.message || e).slice(0, 180)));
            await page.goto(`${BASE}#v${scenario.kind === 'empty' ? '' : '/book-long'}`, { waitUntil: 'load' });
            await page.waitForTimeout(1100);
            await page.click('#word-panel-more-btn');
            await page.waitForTimeout(300);
            const opened = await page.evaluate(STATE);

            const entry = { locale, scenario: scenario.id, opened, steps: [], pageErrors };

            if (scenario.where === 'outside') {
                // 真實滾輪：在選單左側的空白／內容區往上捲
                await page.mouse.move(20, Math.min(scenario.height - 120, opened.menu.bottom + 20));
                await page.mouse.wheel(0, -260);
                await page.waitForTimeout(420);
                entry.steps.push({ step: 'wheel-outside(-260)', ...(await page.evaluate(STATE)) });
                await page.screenshot({ path: path.join(SHOTS, `scroll-outside_${scenario.id}_${locale}.png`) }).catch(() => {});
            } else {
                // 真實滾輪：在選單內部往下捲，逐格看選單是否維持開啟
                const cx = opened.menu.y > 0 ? 200 : 200;
                const cy = opened.menu.y + Math.min(40, opened.menu.h / 2);
                await page.mouse.move(cx, cy);
                for (const [i, delta] of [30, 60, 120, 400].entries()) {
                    await page.mouse.wheel(0, delta);
                    await page.waitForTimeout(280);
                    entry.steps.push({ step: `wheel-inside(+${delta})#${i}`, ...(await page.evaluate(STATE)) });
                }
                await page.screenshot({ path: path.join(SHOTS, `scroll-inside_${scenario.id}_${locale}.png`) }).catch(() => {});
            }

            const last = entry.steps[entry.steps.length - 1];
            entry.verdict = {
                closedAfterScroll: last.hidden === true,
                ariaExpandedAfter: last.ariaExpanded,
                anyPainted: entry.steps.some((s) => s.painted),
                anyItemCoveredWhilePainted: entry.steps.some((s) => s.painted && !s.hidden && s.items.some((i) => i.fullyInside && i.hit !== 'self')),
                menuScrolledInternally: entry.steps.some((s) => s.menu.scrollTop > 0)
            };
            if (entry.opened.hidden) entry.verdict.note = 'open-failed';
            results.push(entry);
            await context.close();
        }
    }

    await browser.close();
    const jsonPath = path.join(ASSET_DIR, 'menu-scroll-wheel-v4.json');
    fs.writeFileSync(jsonPath, JSON.stringify({ finishedAt: new Date().toISOString(), build, results }, null, 2));
    results.forEach((r) => {
        console.log(`${r.locale}/${r.scenario}: opened(menu=${r.opened.menu.y}..${r.opened.menu.bottom}, scrollable=${r.opened.menu.scrollHeight > r.opened.menu.clientHeight}) → ${r.steps.map((s) => `${s.step}:scrollY=${s.scrollY},hidden=${s.hidden},aria=${s.ariaExpanded},menu=${s.menu.y}..${s.menu.bottom},scrollTop=${s.menu.scrollTop}${s.painted && !s.hidden && s.items.some((i) => i.fullyInside && i.hit !== 'self') ? ',covered=' + JSON.stringify(s.items.filter((i) => i.fullyInside && i.hit !== 'self')) : ''}`).join(' | ')}`);
        console.log(`   verdict=${JSON.stringify(r.verdict)}`);
    });
    console.log(`json: ${path.relative(ROOT, jsonPath)}`);
})();
