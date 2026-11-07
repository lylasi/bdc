#!/usr/bin/env node
/**
 * V4「選單可操作範圍」定點覆驗 — A：入口可見並開啟時，選單是否全落在頂欄與底部導覽之間且 pointer 可達
 *
 * 由 V3 的 docs/report/assets/20261107063401314_long-title-v3/audit-menu-navbar-coverage.cjs 改寫：
 *   - 斷言基準由「innerHeight / 只看底部 nav」改為 V4 定義的操作區 band = [頂欄底, 底部導覽頂]
 *     （band 由本腳本獨立推算：只認真正貼齊上／下邊的 fixed/sticky 全寬列，側欄不算）
 *   - 尺寸：320×720、390×844；詞書：空 / 長標題 / 短標題；locale：zh-CN、zh-HK
 *   - 每格：未捲動、捲到最後一項各量一次 elementFromPoint；再真實點擊「第一個 enabled 且可達」的項目
 *   - 保留 V3 的安全網：攔截 5 個來源按鈕與 .nav-btn 的 click，只記錄不執行
 *
 * 只量測；不改正式程式碼。獨立 context、空 SYNC mock、封鎖外站。
 *
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
const SHORT_NAME = '5A Unit 1 单词本';

const BOOK_LONG = [{
    id: 'book-long', name: EN_ARTICLE, createdAt: '2026-01-01T00:00:00.000Z', sourceType: 'legacy',
    words: [{ id: 'l1', word: 'volunteer', meaning: '志愿者', sources: [] }]
}];
const BOOK_SHORT = [{
    id: 'book-short', name: SHORT_NAME, createdAt: '2026-01-01T00:00:00.000Z', sourceType: 'legacy',
    words: [{ id: 's1', word: 'volunteer', meaning: '志愿者', sources: [] }]
}];

/** 量測：操作區 band、選單框、每個項目與其中心命中元素 */
const MEASURE = () => {
    const menu = document.getElementById('word-panel-menu');
    const more = document.getElementById('word-panel-more-btn');
    const nav = document.querySelector('.app-nav');
    const bar = document.querySelector('.app-bar');
    if (!menu) return { found: false };
    const iw = window.innerWidth;
    const ih = window.innerHeight;
    const mr = menu.getBoundingClientRect();
    const bars = [];

    // ── 獨立推算「操作區」：只認真正貼齊上／下邊的 fixed/sticky 全寬列
    let bandTop = 0;
    let bandBottom = ih;
    const rectOf = (el) => { const r = el.getBoundingClientRect(); return { top: +r.top.toFixed(1), bottom: +r.bottom.toFixed(1), left: +r.left.toFixed(1), width: +r.width.toFixed(1), height: +r.height.toFixed(1) }; };
    if (bar) {
        const r = bar.getBoundingClientRect();
        const cs = getComputedStyle(bar);
        const dockedTop = ['fixed', 'sticky'].includes(cs.position) && r.top <= 0.5 && r.bottom > 0 && r.width >= iw - 1;
        const dockedBottom = ['fixed', 'sticky'].includes(cs.position) && r.bottom >= ih - 0.5 && r.top > ih / 2;
        bars.push({ el: 'app-bar', position: cs.position, rect: rectOf(bar), role: dockedTop ? 'top' : (dockedBottom ? 'bottom' : 'ignored') });
        if (dockedTop) bandTop = Math.max(bandTop, r.bottom);
        if (dockedBottom) bandBottom = Math.min(bandBottom, r.top);
    }
    if (nav) {
        const r = nav.getBoundingClientRect();
        const cs = getComputedStyle(nav);
        const dockedBottom = ['fixed', 'sticky'].includes(cs.position) && r.bottom >= ih - 0.5 && r.top > ih / 2 && r.width >= iw - 1;
        const dockedTop = ['fixed', 'sticky'].includes(cs.position) && r.top <= bandTop + 1 && r.width >= iw - 1 && r.top < ih / 2;
        bars.push({ el: 'app-nav', position: cs.position, rect: rectOf(nav), role: dockedBottom ? 'bottom' : (dockedTop ? 'top' : 'ignored(sidebar?)') });
        if (dockedBottom) bandBottom = Math.min(bandBottom, r.top);
        if (dockedTop) bandTop = Math.max(bandTop, r.bottom);
    }

    const items = Array.from(menu.querySelectorAll('.menu-item'));
    const probe = (el) => {
        const r = el.getBoundingClientRect();
        const cx = r.x + r.width / 2;
        const cy = r.y + r.height / 2;
        const fullyInsideMenu = r.top >= mr.top - 0.5 && r.bottom <= mr.bottom + 0.5;
        const centerInViewport = cy > 0 && cy < ih;
        const top = (fullyInsideMenu && centerInViewport) ? document.elementFromPoint(cx, cy) : null;
        return {
            text: (el.textContent || '').trim(),
            disabled: !!el.disabled,
            rect: { y: +r.y.toFixed(1), bottom: +r.bottom.toFixed(1), h: +r.height.toFixed(1) },
            centerX: +cx.toFixed(1),
            centerY: +cy.toFixed(1),
            fullyInsideMenu,
            insideBand: r.top >= bandTop - 0.5 && r.bottom <= bandBottom + 0.5,
            hitIsItem: fullyInsideMenu ? !!(top && (top === el || el.contains(top))) : null,
            hitTag: top ? `${top.tagName}.${String(top.className || '').slice(0, 30)}` : (fullyInsideMenu ? '(null)' : '(clipped)')
        };
    };
    const probed = items.map(probe);

    return {
        found: true,
        hidden: menu.hidden,
        ariaExpanded: more ? more.getAttribute('aria-expanded') : null,
        innerWidth: iw,
        innerHeight: ih,
        band: { top: +bandTop.toFixed(1), bottom: +bandBottom.toFixed(1), height: +(bandBottom - bandTop).toFixed(1) },
        bars,
        menu: {
            x: +mr.x.toFixed(1), y: +mr.y.toFixed(1), w: +mr.width.toFixed(1), h: +mr.height.toFixed(1), bottom: +mr.bottom.toFixed(1),
            zIndex: getComputedStyle(menu).zIndex,
            inlineTop: menu.style.top,
            inlineMaxHeight: menu.style.maxHeight,
            scrollTop: menu.scrollTop,
            scrollHeight: menu.scrollHeight,
            clientHeight: menu.clientHeight,
            scrollable: menu.scrollHeight > menu.clientHeight + 1,
            topInBand: mr.top >= bandTop - 0.5,
            bottomInBand: mr.bottom <= bandBottom + 0.5,
            fullyInBand: mr.top >= bandTop - 0.5 && mr.bottom <= bandBottom + 0.5
        },
        items: probed,
        blockedItems: probed.filter((p) => p.fullyInsideMenu && p.hitIsItem === false).map((p) => `${p.text}@${p.centerY}(${p.hitTag})`),
        itemsOutsideBand: probed.filter((p) => !p.insideBand).map((p) => `${p.text}@${p.rect.y}-${p.rect.bottom}`),
        clippedItems: probed.filter((p) => !p.fullyInsideMenu).map((p) => p.text),
        enabledItems: probed.filter((p) => !p.disabled).map((p) => p.text)
    };
};

const results = [];
function addFinding(list, severity, code, detail) { list.push({ severity, code, detail }); }

(async () => {
    fs.mkdirSync(SHOTS, { recursive: true });
    const launchOpts = { headless: true };
    if (fs.existsSync(CHROME)) launchOpts.executablePath = CHROME;
    const browser = await chromium.launch(launchOpts);

    const booksFor = (kind) => (kind === 'empty' ? [] : (kind === 'long' ? BOOK_LONG : BOOK_SHORT));
    const activeFor = (kind) => (kind === 'empty' ? null : (kind === 'long' ? 'book-long' : 'book-short'));

    const cases = [];
    for (const vp of [{ w: 320, h: 720 }, { w: 390, h: 844 }]) {
        for (const kind of ['empty', 'long', 'short']) {
            cases.push({ id: `${kind}-${vp.w}x${vp.h}`, width: vp.w, height: vp.h, kind });
        }
    }

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
            }, { books: booksFor(c.kind), activeId: activeFor(c.kind), locale });

            const page = await context.newPage();
            const pageErrors = [];
            page.on('pageerror', (e) => pageErrors.push(String(e && e.message || e).slice(0, 160)));
            await page.goto(`${BASE}#v${c.kind === 'empty' ? '' : '/book-' + (c.kind === 'long' ? 'long' : 'short')}`, { waitUntil: 'load' });
            await page.waitForTimeout(1100);

            const entry = { locale, case: c.id, viewport: `${c.width}x${c.height}`, kind: c.kind, pageErrors, findings: [] };

            // 安全網：攔截來源按鈕與導覽列點擊，只記錄不執行
            await page.evaluate(() => {
                window.__clicked = [];
                window.__navClicked = 0;
                ['complete-missing-btn', 'merge-vocab-books-btn', 'export-vocab-book-btn', 'edit-vocab-book-btn', 'delete-vocab-book-btn'].forEach((id) => {
                    const btn = document.getElementById(id);
                    if (!btn) return;
                    btn.addEventListener('click', (e) => { window.__clicked.push(id); e.preventDefault(); e.stopImmediatePropagation(); }, true);
                });
                document.querySelectorAll('.app-nav .nav-btn').forEach((btn) => {
                    btn.addEventListener('click', (e) => { window.__navClicked += 1; e.preventDefault(); e.stopImmediatePropagation(); }, true);
                });
            });

            const moreVisible = await page.evaluate(() => {
                const b = document.getElementById('word-panel-more-btn');
                return b ? getComputedStyle(b).display !== 'none' : false;
            });
            entry.moreVisible = moreVisible;
            if (!moreVisible) {
                addFinding(entry.findings, 'high', 'more-btn-missing', '窄螢幕卻看不到「更多」按鈕');
                results.push(entry);
                await context.close();
                continue;
            }

            await page.click('#word-panel-more-btn');
            await page.waitForTimeout(260);
            entry.opened = await page.evaluate(MEASURE);
            await page.screenshot({ path: path.join(SHOTS, `band-${c.id}_${locale}-open.png`) }).catch(() => {});

            // 捲到選單底部（若可捲）
            await page.evaluate(() => { const m = document.getElementById('word-panel-menu'); if (m) m.scrollTop = m.scrollHeight; });
            await page.waitForTimeout(180);
            entry.scrolled = await page.evaluate(MEASURE);
            await page.screenshot({ path: path.join(SHOTS, `band-${c.id}_${locale}-bottom.png`) }).catch(() => {});

            // 真實點擊：對每個 enabled 項目「捲到選單可見處」後量 pointer 可達性，點第一個可達的
            // （等同使用者把該項捲進視野後再點，不是硬點被選單裁掉的座標）
            entry.enabledProbe = [];
            let target = null;
            for (const item of (entry.scrolled.items || []).filter((i) => !i.disabled)) {
                const m = await page.evaluate((text) => {
                    const menu = document.getElementById('word-panel-menu');
                    const el = Array.from(menu.querySelectorAll('.menu-item')).find((n) => (n.textContent || '').trim() === text);
                    if (!el) return null;
                    menu.scrollTop = Math.max(0, el.offsetTop - (menu.clientHeight - el.offsetHeight) / 2 + 6);
                    const r = el.getBoundingClientRect();
                    const mr = menu.getBoundingClientRect();
                    const cx = r.x + r.width / 2;
                    const cy = r.y + r.height / 2;
                    const top = document.elementFromPoint(cx, cy);
                    return {
                        text,
                        scrollTop: menu.scrollTop,
                        centerX: +cx.toFixed(1),
                        centerY: +cy.toFixed(1),
                        insideMenu: r.top >= mr.top - 0.5 && r.bottom <= mr.bottom + 0.5,
                        insideViewport: r.top >= 0 && r.bottom <= window.innerHeight,
                        hitIsItem: !!(top && (top === el || el.contains(top))),
                        hitTag: top ? `${top.tagName}.${String(top.className || '').slice(0, 30)}` : '(null)'
                    };
                }, item.text);
                if (!m) continue;
                entry.enabledProbe.push(m);
                if (!target && m.hitIsItem && m.insideMenu && m.insideViewport) target = m;
            }
            entry.clickTarget = target ? { text: target.text, centerX: target.centerX, centerY: target.centerY } : null;
            if (target) {
                await page.mouse.click(target.centerX, target.centerY);
                await page.waitForTimeout(280);
                entry.clickResult = await page.evaluate(() => ({
                    clicked: window.__clicked || [],
                    navClicked: window.__navClicked || 0,
                    menuHidden: document.getElementById('word-panel-menu').hidden,
                    ariaExpanded: document.getElementById('word-panel-more-btn').getAttribute('aria-expanded')
                }));
            }
            await page.screenshot({ path: path.join(SHOTS, `band-${c.id}_${locale}-clicked.png`) }).catch(() => {});

            // ── 判定（V4 預期：開啟後整個選單要在 band 內、每項 pointer 可達、至少一個 enabled 項可觸發）
            const opened = entry.opened;
            if (!opened.found) addFinding(entry.findings, 'high', 'menu-missing', '選單節點不存在');
            else if (opened.hidden) {
                addFinding(entry.findings, 'high', 'menu-closed-on-open', `入口可見卻開啟即收起（band=${JSON.stringify(opened.band)}）`);
            } else {
                if (!opened.menu.topInBand) {
                    addFinding(entry.findings, 'high', 'menu-above-band',
                        `menu.top=${opened.menu.y} < band.top=${opened.band.top}（${JSON.stringify(opened.bars)}）`);
                }
                if (!opened.menu.bottomInBand) {
                    addFinding(entry.findings, 'high', 'menu-below-band',
                        `menu.bottom=${opened.menu.bottom} > band.bottom=${opened.band.bottom}`);
                }
                if (opened.blockedItems.length) {
                    addFinding(entry.findings, 'high', 'item-not-reachable-on-open',
                        `${opened.blockedItems.length} 項 pointer 不可達：${JSON.stringify(opened.blockedItems)}`);
                }
                const scrolled = entry.scrolled;
                if (scrolled.hidden) {
                    addFinding(entry.findings, 'medium', 'menu-closed-after-inner-scroll', '捲動選單後自行收起');
                } else {
                    if (!scrolled.menu.bottomInBand) addFinding(entry.findings, 'high', 'menu-below-band-after-scroll', `menu.bottom=${scrolled.menu.bottom} band.bottom=${scrolled.band.bottom}`);
                    if (!scrolled.menu.topInBand) addFinding(entry.findings, 'high', 'menu-above-band-after-scroll', `menu.top=${scrolled.menu.y} band.top=${scrolled.band.top}`);
                    if (scrolled.blockedItems.length) {
                        addFinding(entry.findings, 'high', 'item-not-reachable-after-scroll',
                            `捲到底後 ${scrolled.blockedItems.length} 項 pointer 不可達：${JSON.stringify(scrolled.blockedItems)}`);
                    }
                }
                if (!target) {
                    if ((opened.enabledItems || []).length) {
                        addFinding(entry.findings, 'high', 'enabled-item-unreachable',
                            `enabled 項目 ${JSON.stringify(opened.enabledItems)} 全部捲進視野後仍 pointer 不可達：${JSON.stringify(entry.enabledProbe)}`);
                    } else {
                        addFinding(entry.findings, 'medium', 'no-enabled-item', `enabled 項目=${JSON.stringify(opened.enabledItems)}`);
                    }
                }
            }
            if (target) {
                const cr = entry.clickResult || { clicked: [], navClicked: 0 };
                if (cr.navClicked) addFinding(entry.findings, 'high', 'click-hit-nav-bar', `點擊落在導覽列（${cr.navClicked} 次）`);
                if (!cr.clicked.length) addFinding(entry.findings, 'high', 'enabled-item-click-blocked', `點擊「${target.text}」未觸發任何來源按鈕`);
                if (!cr.menuHidden) addFinding(entry.findings, 'medium', 'menu-not-closed-after-item-click', '點擊項目後選單未收起');
                if (cr.ariaExpanded !== 'false') addFinding(entry.findings, 'medium', 'aria-expanded-stale-after-click', `aria-expanded=${cr.ariaExpanded}`);
            }

            results.push(entry);
            await context.close();
        }
    }

    await browser.close();
    const jsonPath = path.join(ASSET_DIR, 'menu-band-v4.json');
    const build = execSync('md5 -q features/vocabulary/vocabulary.js index.html styles.css', { cwd: ROOT }).toString().trim().split('\n');
    fs.writeFileSync(jsonPath, JSON.stringify({ finishedAt: new Date().toISOString(), build, results }, null, 2));
    const findings = results.flatMap((r) => r.findings.map((f) => ({ locale: r.locale, case: r.case, ...f })));
    console.log(`cases=${results.length} findings=${findings.length}`);
    findings.forEach((f) => console.log(`  [${f.severity}] ${f.locale}/${f.case} ${f.code}: ${String(f.detail).slice(0, 260)}`));
    results.forEach((r) => {
        const o = r.opened || {};
        const s = r.scrolled || {};
        console.log(`${r.locale}/${r.case}: band=${JSON.stringify(o.band)} menu=${o.menu ? JSON.stringify({ y: o.menu.y, bottom: o.menu.bottom, h: o.menu.h, inBand: o.menu.fullyInBand, scrollable: o.menu.scrollable }) : 'n/a'} afterScrollBlocked=${JSON.stringify(s.blockedItems || [])} click=${JSON.stringify((r.clickResult || {}).clicked || [])} enabled=${JSON.stringify(o.enabledItems || [])}`);
    });
    console.log(`json: ${path.relative(ROOT, jsonPath)}`);
})();
