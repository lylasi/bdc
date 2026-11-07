#!/usr/bin/env node
/**
 * V3 長標題最終覆驗 — C（決定性版）：⋯ 選單的實際落點與 pointer 可達性
 *
 * 為什麼另寫一支：第一支探測（audit-menu-navbar-coverage.cjs）用 page.click('#word-panel-more-btn')，
 * 按鈕若在視窗外 Playwright 會自動捲動，導致同一視口在不同 locale 量到不同捲動位置。
 * 本支改成：載入後先 window.scrollTo(0,0)，必要時才明確把 ⋯ 按鈕捲到視窗中央並記錄 scrollY，
 * 之後每一步都記錄視口／header／選單／導覽列的絕對與相對位置，結果可重現。
 *
 * 量測內容（每個案例）：
 *   1) 選單 rect（bottom 是否 <= innerHeight）
 *   2) 固定底部導覽列 .app-nav（position:fixed; z-index:1200; 高 63px）與選單的重疊
 *   3) 每個選單項：是否完整落在選單框內、pointer 命中元素、是否落在導覽列帶內
 *   4) 選單捲到底後，末項是否 pointer 可達
 *   5) 真實滑鼠點擊末項 → 是否觸發來源按鈕（來源按鈕與導覽列的 click 先被攔截，不會真的執行）
 *   6) 強制「下方空間很少」→ 是否翻到上方、且上方版本仍在視口內
 *
 * 用法：
 *   PORT=8313 PLAYWRIGHT_MODULE=<playwright> node docs/report/assets/<ts>_long-title-v3/audit-menu-placement.cjs
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
    const header = document.getElementById('current-book-name')?.closest('.panel-header');
    const nav = document.querySelector('.app-nav');
    const more = document.getElementById('word-panel-more-btn');
    if (!menu || !header) return { found: false };
    const box = (el) => {
        const r = el.getBoundingClientRect();
        return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1), right: +r.right.toFixed(1), bottom: +r.bottom.toFixed(1) };
    };
    const mr = menu.getBoundingClientRect();
    const nr = nav ? nav.getBoundingClientRect() : null;
    const items = Array.from(menu.querySelectorAll('.menu-item')).map((el, index) => {
        const r = el.getBoundingClientRect();
        const cx = r.x + r.width / 2;
        const cy = r.y + r.height / 2;
        const fullyInsideMenu = r.top >= mr.top - 0.5 && r.bottom <= mr.bottom + 0.5;
        const inViewportCenter = cy > 0 && cy < window.innerHeight;
        const hit = (fullyInsideMenu && inViewportCenter) ? document.elementFromPoint(cx, cy) : null;
        return {
            index, text: (el.textContent || '').trim(), disabled: !!el.disabled,
            rect: box(el), centerX: +cx.toFixed(1), centerY: +cy.toFixed(1),
            fullyInsideMenu,
            pointerHitsItem: fullyInsideMenu ? !!(hit && (hit === el || el.contains(hit))) : null,
            hitTag: hit ? `${hit.tagName}.${String(hit.getAttribute('class') || '').slice(0, 28)}` : (fullyInsideMenu ? '(null)' : '(clipped)'),
            insideNavBand: !!(nr && cy >= nr.top && cy <= nr.bottom)
        };
    });
    return {
        found: true,
        scrollY: Math.round(window.scrollY),
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        header: box(header),
        moreBtn: more ? box(more) : null,
        menu: { ...box(menu), hidden: menu.hidden, inlineTop: menu.style.top, inlineMaxHeight: menu.style.maxHeight,
            overflowY: getComputedStyle(menu).overflowY, scrollTop: menu.scrollTop,
            scrollHeight: menu.scrollHeight, clientHeight: menu.clientHeight,
            scrollable: menu.scrollHeight > menu.clientHeight + 1 },
        nav: nr ? { ...box(nav), zIndex: getComputedStyle(nav).zIndex, position: getComputedStyle(nav).position,
            clientHeight: nav.clientHeight } : null,
        menuZ: getComputedStyle(menu).zIndex,
        items,
        bottomWithinViewport: mr.bottom <= window.innerHeight + 0.5,
        topWithinViewport: mr.top >= -0.5
    };
};

const results = [];
function finding(list, severity, code, detail) { list.push({ severity, code, detail }); }

async function prepare(page, vp) {
    // 決定性捲動：先回頂，若 ⋯ 按鈕不在視窗內才明確置中，並記錄 scrollY
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(150);
    const visible = await page.evaluate(() => {
        const b = document.getElementById('word-panel-more-btn');
        if (!b) return false;
        const r = b.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= window.innerHeight;
    });
    if (!visible) {
        await page.evaluate(() => document.getElementById('word-panel-more-btn')?.scrollIntoView({ block: 'center' }));
        await page.waitForTimeout(250);
    }
    return { scrolledToRevealButton: !visible };
}

(async () => {
    fs.mkdirSync(SHOTS, { recursive: true });
    const launchOpts = { headless: true };
    if (fs.existsSync(CHROME)) launchOpts.executablePath = CHROME;
    const browser = await chromium.launch(launchOpts);

    const cases = [
        { id: 'empty-320x720', width: 320, height: 720, books: [], activeId: null, note: '使用者指定的空詞書定點' },
        { id: 'long-320x720', width: 320, height: 720, books: BOOKS_LONG, activeId: 'book-long', note: '長標題對照（有詞書）' },
        { id: 'empty-390x844', width: 390, height: 844, books: [], activeId: null, note: '常見手機高度' },
        { id: 'long-390x844', width: 390, height: 844, books: BOOKS_LONG, activeId: 'book-long', note: '常見手機高度（長標題）' },
        { id: 'empty-320x560', width: 320, height: 560, books: [], activeId: null, note: '縮放等效視口（≈129%）' },
        { id: 'long-320x560', width: 320, height: 560, books: BOOKS_LONG, activeId: 'book-long', note: '縮放等效視口（≈129%，長標題）' },
        { id: 'empty-390x600', width: 390, height: 600, books: [], activeId: null, note: '縮放等效視口（≈141%）' },
        { id: 'long-390x600', width: 390, height: 600, books: BOOKS_LONG, activeId: 'book-long', note: '縮放等效視口（≈141%，長標題）' },
        { id: 'long-719x900', width: 719, height: 900, books: BOOKS_LONG, activeId: 'book-long', note: '選單模式臨界寬度' }
    ];

    for (const locale of ['zh-CN', 'zh-HK']) {
        for (const c of cases) {
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

            const entry = { locale, case: c.id, size: `${c.width}x${c.height}`, note: c.note, findings: [], pageErrors };

            // 安全網：來源按鈕與導覽列 click 只記錄不執行
            await page.evaluate(() => {
                window.__clicked = [];
                window.__navClicked = 0;
                ['complete-missing-btn', 'merge-vocab-books-btn', 'export-vocab-book-btn', 'edit-vocab-book-btn', 'delete-vocab-book-btn']
                    .forEach((id) => {
                        const btn = document.getElementById(id);
                        if (!btn) return;
                        btn.addEventListener('click', (e) => { window.__clicked.push(id); e.preventDefault(); e.stopImmediatePropagation(); }, true);
                    });
                document.querySelectorAll('.app-nav .nav-btn').forEach((btn) => {
                    btn.addEventListener('click', (e) => { window.__navClicked += 1; e.preventDefault(); e.stopImmediatePropagation(); }, true);
                });
            });

            entry.prepare = await prepare(page, c);
            await page.click('#word-panel-more-btn');
            await page.waitForTimeout(280);
            entry.top = await page.evaluate(MEASURE);
            await page.screenshot({ path: path.join(SHOTS, `place_${locale}_${c.id}_open.png`) }).catch(() => {});

            // 捲到選單底部後再量
            await page.evaluate(() => { const m = document.getElementById('word-panel-menu'); if (m) m.scrollTop = m.scrollHeight; });
            await page.waitForTimeout(180);
            entry.bottom = await page.evaluate(MEASURE);
            await page.screenshot({ path: path.join(SHOTS, `place_${locale}_${c.id}_scrolled.png`) }).catch(() => {});

            // 真實滑鼠點擊末項
            const last = entry.bottom.items[entry.bottom.items.length - 1];
            await page.mouse.click(last.centerX, last.centerY);
            await page.waitForTimeout(280);
            entry.realClick = await page.evaluate(() => ({
                clicked: window.__clicked || [], navClicked: window.__navClicked || 0,
                menuHidden: document.getElementById('word-panel-menu').hidden
            }));
            entry.lastItem = { text: last.text, disabled: last.disabled, centerY: last.centerY, hitTag: last.hitTag, insideNavBand: last.insideNavBand };

            // (a) 新行為：選單開著時捲動頁面 → 應自動收合（不留浮層）
            await page.evaluate(() => {
                const menu = document.getElementById('word-panel-menu');
                if (menu && menu.hidden) document.getElementById('word-panel-more-btn')?.click();
                window.scrollBy(0, 12);
            });
            await page.waitForTimeout(320);
            entry.scrollWhileOpen = await page.evaluate(() => {
                const menu = document.getElementById('word-panel-menu');
                const more = document.getElementById('word-panel-more-btn');
                return { hidden: menu ? menu.hidden : null, ariaExpanded: more ? more.getAttribute('aria-expanded') : null, scrollY: Math.round(window.scrollY) };
            });

            // (b) 下方空間很少時開選單：先把 header 捲到視窗底緣上方 60px，再開
            await page.evaluate(() => {
                const menu = document.getElementById('word-panel-menu');
                if (menu && !menu.hidden) document.getElementById('word-panel-more-btn')?.click();
            });
            await page.waitForTimeout(150);
            await page.evaluate(() => {
                const header = document.getElementById('current-book-name')?.closest('.panel-header');
                if (!header) return;
                const r = header.getBoundingClientRect();
                window.scrollBy(0, r.bottom - (window.innerHeight - 60));
            });
            await page.waitForTimeout(250);
            await page.evaluate(() => document.getElementById('word-panel-more-btn')?.click());
            await page.waitForTimeout(320);
            entry.flipAbove = await page.evaluate(MEASURE);
            await page.screenshot({ path: path.join(SHOTS, `place_${locale}_${c.id}_flip.png`) }).catch(() => {});

            // ── 判定
            const t = entry.top;
            const b = entry.bottom;
            if (!t.found) finding(entry.findings, 'high', 'menu-missing', '選單節點不存在');
            else if (t.menu.hidden) {
                // 新版的「觸發器可見帶」守衛會直接收合選單：記錄成因（trigger 與底部導覽列重疊）
                const navTop = t.nav && t.nav.y > t.innerHeight / 2 ? t.nav.y : t.innerHeight;
                const overlap = t.moreBtn && t.nav ? Math.max(0, Math.min(t.moreBtn.bottom, t.nav.bottom) - Math.max(t.moreBtn.y, t.nav.y)) : 0;
                finding(entry.findings, 'low', 'menu-closed-by-trigger-guard',
                    `點擊後選單未開啟：trigger=${t.moreBtn ? `${t.moreBtn.y}..${t.moreBtn.bottom}` : '?'} 與 bottom-nav(top=${navTop}) 重疊 ${overlap.toFixed(1)}px；aria-expanded=${t.menu.hidden ? 'false' : '?'}`);
            } else {
                if (!t.bottomWithinViewport) finding(entry.findings, 'medium', 'open-menu-bottom-overflow', `bottom=${t.menu.bottom} innerHeight=${t.innerHeight}（scrollY=${t.scrollY}）`);
                if (t.nav && t.menu.bottom > t.nav.y + 0.5) {
                    finding(entry.findings, 'medium', 'open-menu-under-nav',
                        `menu.bottom=${t.menu.bottom} > nav.top=${t.nav.y}（nav h=${t.nav.clientHeight}, z=${t.nav.zIndex} vs menu z=${t.menuZ}）`);
                }
                const coveredTop = t.items.filter((i) => i.fullyInsideMenu && i.pointerHitsItem === false);
                if (coveredTop.length) finding(entry.findings, 'medium', 'item-pointer-blocked@open',
                    JSON.stringify(coveredTop.map((i) => `${i.text}@${i.centerY}→${i.hitTag}`)));
                const coveredBottom = b.items.filter((i) => i.fullyInsideMenu && i.pointerHitsItem === false);
                if (coveredBottom.length) finding(entry.findings, 'medium', 'item-pointer-blocked@scrolled',
                    JSON.stringify(coveredBottom.map((i) => `${i.text}@${i.centerY}→${i.hitTag}`)));
                if (!b.bottomWithinViewport) finding(entry.findings, 'medium', 'scrolled-menu-bottom-overflow', `bottom=${b.menu.bottom} innerHeight=${b.innerHeight}`);
                if (entry.realClick && last && !last.disabled && !(entry.realClick.clicked || []).includes('delete-vocab-book-btn')) {
                    finding(entry.findings, 'medium', 'last-item-click-blocked',
                        `真實點擊「${last.text}」未觸發來源按鈕（clicked=${JSON.stringify(entry.realClick.clicked)}, navClicked=${entry.realClick.navClicked}）`);
                }
            }
            const f = entry.flipAbove;
            if (f && f.found) {
                if (!f.bottomWithinViewport) finding(entry.findings, 'low', 'flip-above-outside-viewport', `bottom=${f.menu.bottom} innerHeight=${f.innerHeight}`);
                if (!f.topWithinViewport) finding(entry.findings, 'low', 'flip-above-top-cut', `top=${f.menu.y}`);
                if (!f.menu.inlineMaxHeight) finding(entry.findings, 'low', 'flip-above-no-maxheight', '上方展開未設 maxHeight');
                const flipped = f.menu.bottom <= f.header.y + 0.5;
                entry.flippedAbove = flipped;
                entry.flipDetail = { menu: f.menu, header: f.header, nav: f.nav };
            }

            results.push(entry);
            await context.close();
        }
    }

    await browser.close();
    const jsonPath = path.join(ASSET_DIR, 'menu-placement.json');
    fs.writeFileSync(jsonPath, JSON.stringify({ finishedAt: new Date().toISOString(), results }, null, 2));
    const blocking = results.flatMap((r) => r.findings.map((x) => ({ locale: r.locale, case: r.case, size: r.size, ...x })));
    console.log(`cases=${results.length} findings=${blocking.length}`);
    blocking.forEach((x) => console.log(`  [${x.severity}] ${x.locale}/${x.case} ${x.code}: ${String(x.detail).slice(0, 220)}`));
    results.forEach((r) => {
        const t = r.top, b = r.bottom, f = r.flipAbove || {};
        console.log(`${r.locale}/${r.case}(${r.size}) scrollY=${t.scrollY} open: menu=${t.menu.y}..${t.menu.bottom} h=${t.menu.h} maxH=${t.menu.inlineMaxHeight} | nav=${t.nav ? `${t.nav.y}..${t.nav.bottom}` : 'n/a'} | bottomOK=${t.bottomWithinViewport} scrolled: scrollTop=${b.menu.scrollTop} last=${r.lastItem.text}@${r.lastItem.centerY}(${r.lastItem.hitTag}) click=${JSON.stringify(r.realClick.clicked)} navClick=${r.realClick.navClicked} | flipAbove=${r.flippedAbove} flipMenu=${f.menu ? `${f.menu.y}..${f.menu.bottom}` : 'n/a'} findings=${r.findings.length}`);
    });
    console.log(`json: ${path.relative(ROOT, jsonPath)}`);
})();
