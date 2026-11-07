#!/usr/bin/env node
/**
 * V3 長標題最終覆驗 — C（補充）：⋯ 選單末項是否被固定底部導覽列蓋住（pointer 可達性）
 *
 * 背景：手機（<768px）的字根導覽列 `.app-nav` 是 position:fixed; bottom:0; z-index:1200，
 * 而 `.word-panel-menu` 只有 z-index:40。V3 把選單限制在 innerHeight 內，但沒有扣掉導覽列高度，
 * 因此最末項可能「在視口內、卻被導覽列蓋住」。本腳本用 elementFromPoint + 真實滑鼠點擊量化。
 *
 * 安全措施：量測前把 5 個來源按鈕與所有 `.nav-btn` 的 click 以 capture 攔截並阻止預設行為，
 * 不觸發任何實際操作（不刪除、不導航）。
 *
 * 用法：
 *   PORT=8313 PLAYWRIGHT_MODULE=<playwright> node docs/report/assets/<ts>_long-title-v3/audit-menu-navbar-coverage.cjs
 */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('fs');
const path = require('path');

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

const BOOKS_LONG = [{
    id: 'book-long', name: EN_ARTICLE, createdAt: '2026-01-01T00:00:00.000Z', sourceType: 'legacy',
    words: [{ id: 'l1', word: 'volunteer', meaning: '志愿者', sources: [] }]
}];

const MEASURE = () => {
    const menu = document.getElementById('word-panel-menu');
    const nav = document.querySelector('.app-nav');
    if (!menu) return { found: false };
    const mr = menu.getBoundingClientRect();
    const nr = nav ? nav.getBoundingClientRect() : null;
    const items = Array.from(menu.querySelectorAll('.menu-item'));
    const probed = items.map((el, index) => {
        const r = el.getBoundingClientRect();
        const cx = r.x + r.width / 2;
        const cy = r.y + r.height / 2;
        // 只對「完整落在選單框內」的項目做 pointer 測試；被選單自身裁掉的是「需要捲動」而非「被遮擋」
        const fullyInsideMenu = r.top >= mr.top - 0.5 && r.bottom <= mr.bottom + 0.5;
        const top = (fullyInsideMenu && cy > 0 && cy < window.innerHeight) ? document.elementFromPoint(cx, cy) : null;
        return {
            index,
            text: (el.textContent || '').trim(),
            disabled: !!el.disabled,
            rect: { x: +r.x.toFixed(1), y: +r.y.toFixed(1), bottom: +r.bottom.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) },
            centerX: +cx.toFixed(1),
            centerY: +cy.toFixed(1),
            fullyInsideMenu,
            hitIsItem: fullyInsideMenu ? !!(top && (top === el || el.contains(top))) : null,
            hitTag: top ? `${top.tagName}.${String(top.className || '').slice(0, 32)}` : (fullyInsideMenu ? '(null)' : '(clipped by menu)'),
            coveredByNav: !!(nr && cy >= nr.top && cy <= nr.bottom)
        };
    });
    return {
        found: true,
        innerHeight: window.innerHeight,
        menu: { y: +mr.y.toFixed(1), bottom: +mr.bottom.toFixed(1), h: +mr.height.toFixed(1), scrollTop: menu.scrollTop, scrollHeight: menu.scrollHeight, clientHeight: menu.clientHeight },
        nav: nr ? { top: +nr.top.toFixed(1), bottom: +nr.bottom.toFixed(1), h: +nr.height.toFixed(1), zIndex: getComputedStyle(nav).zIndex, position: getComputedStyle(nav).position } : null,
        menuZ: getComputedStyle(menu).zIndex,
        items: probed,
        blockedItems: probed.filter((p) => p.fullyInsideMenu && p.hitIsItem === false).map((p) => `${p.text}@${p.centerY}(${p.hitTag})`),
        clippedItems: probed.filter((p) => !p.fullyInsideMenu).map((p) => p.text)
    };
};

const results = [];
function finding(list, severity, code, detail) { list.push({ severity, code, detail }); }

(async () => {
    fs.mkdirSync(SHOTS, { recursive: true });
    const launchOpts = { headless: true };
    if (fs.existsSync(CHROME)) launchOpts.executablePath = CHROME;
    const browser = await chromium.launch(launchOpts);

    const cases = [
        { id: 'empty-320x720', width: 320, height: 720, books: [], activeId: null },
        { id: 'long-320x720', width: 320, height: 720, books: BOOKS_LONG, activeId: 'book-long' },
        { id: 'empty-390x844', width: 390, height: 844, books: [], activeId: null },
        { id: 'long-390x844', width: 390, height: 844, books: BOOKS_LONG, activeId: 'book-long' },
        { id: 'long-719x900', width: 719, height: 900, books: BOOKS_LONG, activeId: 'book-long' },
        // 縮放情境：視窗高度變矮（≈125%~150% 瀏覽器縮放的等效 CSS 視口），面板仍在畫面上
        { id: 'empty-320x560', width: 320, height: 560, books: [], activeId: null },
        { id: 'long-320x560', width: 320, height: 560, books: BOOKS_LONG, activeId: 'book-long' },
        { id: 'empty-390x600', width: 390, height: 600, books: [], activeId: null },
        { id: 'long-390x600', width: 390, height: 600, books: BOOKS_LONG, activeId: 'book-long' }
    ];

    const argv = process.argv.slice(2);
    const CASE_FILTER = (argv.find((a) => a.startsWith('--cases=')) || '').slice(8).split(',').filter(Boolean);
    const selected = CASE_FILTER.length ? cases.filter((c) => CASE_FILTER.includes(c.id)) : cases;

    for (const locale of ['zh-CN', 'zh-HK']) {
        for (const c of selected) {
            const context = await browser.newContext({
                viewport: { width: c.width, height: c.height },
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
            await context.addInitScript(({ books, activeId, locale }) => {
                localStorage.clear();
                localStorage.setItem('vocabularyBooks', JSON.stringify(books));
                if (activeId) localStorage.setItem('activeBookId', activeId);
                localStorage.setItem('vocabImportPromptShown', '1');
                localStorage.setItem('pen_global_settings', JSON.stringify({ language: { interfaceLocale: locale }, assistant: { enabled: false } }));
            }, { books: c.books, activeId: c.activeId, locale });
            const page = await context.newPage();
            const pageErrors = [];
            page.on('pageerror', (e) => pageErrors.push(String(e && e.message || e).slice(0, 160)));
            await page.goto(`${BASE}#v`, { waitUntil: 'load' });
            await page.waitForTimeout(1200);

            const entry = { locale, case: c.id, findings: [], pageErrors };

            // 安全網：攔截來源按鈕與導覽列的點擊，只記錄不執行
            await page.evaluate(() => {
                window.__clicked = [];
                const ids = ['complete-missing-btn', 'merge-vocab-books-btn', 'export-vocab-book-btn', 'edit-vocab-book-btn', 'delete-vocab-book-btn'];
                ids.forEach((id) => {
                    const btn = document.getElementById(id);
                    if (!btn) return;
                    btn.addEventListener('click', (e) => {
                        window.__clicked.push(id);
                        e.preventDefault();
                        e.stopImmediatePropagation();
                    }, true);
                });
                document.querySelectorAll('.app-nav .nav-btn').forEach((btn) => {
                    btn.addEventListener('click', (e) => { window.__navClicked = (window.__navClicked || 0) + 1; e.preventDefault(); e.stopImmediatePropagation(); }, true);
                });
            });

            await page.click('#word-panel-more-btn');
            await page.waitForTimeout(260);
            entry.beforeScroll = await page.evaluate(MEASURE);
            await page.screenshot({ path: path.join(SHOTS, `navbar-menu_${locale}_${c.id}-top.png`) }).catch(() => {});

            // 捲到選單底部
            await page.evaluate(() => { const m = document.getElementById('word-panel-menu'); if (m) m.scrollTop = m.scrollHeight; });
            await page.waitForTimeout(180);
            entry.afterScroll = await page.evaluate(MEASURE);
            await page.screenshot({ path: path.join(SHOTS, `navbar-menu_${locale}_${c.id}-bottom.png`) }).catch(() => {});

            // 真實滑鼠點擊最末項（刪除）：看點擊實際落到哪個元素
            const last = entry.afterScroll.items[entry.afterScroll.items.length - 1];
            entry.realClickTarget = last.text;
            await page.mouse.click(last.centerX, last.centerY);
            await page.waitForTimeout(250);
            entry.realClick = await page.evaluate(() => ({
                clicked: window.__clicked || [],
                navClicked: window.__navClicked || 0,
                menuStillOpen: !document.getElementById('word-panel-menu').hidden
            }));

            if (!entry.beforeScroll.found) finding(entry.findings, 'high', 'menu-missing', '選單不存在');
            else {
                const coveredBefore = entry.beforeScroll.items.filter((i) => i.fullyInsideMenu && i.hitIsItem === false);
                if (coveredBefore.length) {
                    finding(entry.findings, 'medium', 'menu-item-covered',
                        `未捲動時 ${coveredBefore.length}/${entry.beforeScroll.items.length} 項 pointer 不可達：${JSON.stringify(coveredBefore.map((i) => `${i.text}@${i.centerY}(${i.hitTag})`))}`);
                }
                const coveredAfter = entry.afterScroll.items.filter((i) => i.fullyInsideMenu && i.hitIsItem === false);
                if (coveredAfter.length) {
                    finding(entry.findings, 'medium', 'menu-item-covered-after-scroll',
                        `捲到底後仍 ${coveredAfter.length} 項 pointer 不可達：${JSON.stringify(coveredAfter.map((i) => `${i.text}@${i.centerY}(${i.hitTag})`))}`);
                }
                if (entry.afterScroll.nav && entry.afterScroll.menu.bottom > entry.afterScroll.nav.bottom + 0.5) {
                    finding(entry.findings, 'low', 'menu-overlaps-nav',
                        `menu.bottom=${entry.afterScroll.menu.bottom} > nav.top=${entry.afterScroll.nav.top}`);
                }
            }
            entry.expectedClickFired = last.disabled ? 'disabled(不應觸發)' : last.text;
            if (!last.disabled && !(entry.realClick.clicked || []).includes('delete-vocab-book-btn')) {
                finding(entry.findings, 'medium', 'last-item-click-blocked',
                    `真實點擊「${last.text}」未觸發來源按鈕（clicked=${JSON.stringify(entry.realClick.clicked)}）`);
            }
            if (entry.realClick.navClicked) {
                finding(entry.findings, 'medium', 'click-hit-nav-bar', `點擊落在導覽列（${entry.realClick.navClicked} 次）`);
            }

            results.push(entry);
            await context.close();
        }
    }

    await browser.close();
    const jsonPath = path.join(ASSET_DIR, 'menu-navbar-coverage.json');
    fs.writeFileSync(jsonPath, JSON.stringify({ finishedAt: new Date().toISOString(), results }, null, 2));
    const blocking = results.flatMap((r) => r.findings.map((f) => ({ locale: r.locale, case: r.case, ...f })));
    console.log(`cases=${results.length} findings=${blocking.length}`);
    blocking.forEach((f) => console.log(`  [${f.severity}] ${f.locale}/${f.case} ${f.code}: ${String(f.detail).slice(0, 220)}`));
    results.forEach((r) => {
        const b = r.afterScroll;
        console.log(`${r.locale}/${r.case}: menu=${JSON.stringify(b.menu)} nav=${JSON.stringify(b.nav)} menuZ=${b.menuZ} blocked=${JSON.stringify(b.blockedItems)} clicked=${JSON.stringify(r.realClick.clicked)} navClicked=${r.realClick.navClicked}`);
    });
    console.log(`json: ${path.relative(ROOT, jsonPath)}`);
})();
