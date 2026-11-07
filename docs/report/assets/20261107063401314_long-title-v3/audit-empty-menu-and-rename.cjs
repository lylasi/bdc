#!/usr/bin/env node
/**
 * V3 長標題最終覆驗 — C：定點驗兩件事
 *
 *  C1 空詞書（沒有任何詞書）在 320×720：⋯ 選單 bottom <= innerHeight、最後一項可捲到且可點，
 *     並在「縮放／改視窗高度」（320×400、320×260、390×900）後仍在視口內。
 *  C2 詞書名稱由長改短：詳情圖示不得殘留（逐幀取樣「名稱已是短名卻仍顯示圖示」的幀數）。
 *
 * 只量測；不改正式程式碼。獨立 context、空 SYNC mock、封鎖外站。
 *
 * 用法：
 *   PORT=8313 PLAYWRIGHT_MODULE=<playwright> node docs/report/assets/<ts>_long-title-v3/audit-empty-menu-and-rename.cjs
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
const SHORT = '5A Unit 1 单词本';

const MENU_EDIT_INDEX = 3;

async function newContext(browser, { locale, width, height, books, activeId }) {
    const context = await browser.newContext({
        viewport: { width, height },
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
        localStorage.setItem('pen_global_settings', JSON.stringify({
            language: { interfaceLocale: locale }, assistant: { enabled: false }
        }));
    }, { books, activeId, locale });
    return context;
}

const MENU_MEASURE = () => {
    const menu = document.getElementById('word-panel-menu');
    const more = document.getElementById('word-panel-more-btn');
    if (!menu) return { found: false };
    const cs = getComputedStyle(menu);
    const rect = menu.getBoundingClientRect();
    const items = Array.from(menu.querySelectorAll('.menu-item'));
    const last = items[items.length - 1] || null;
    return {
        found: true,
        hidden: menu.hidden,
        ariaExpanded: more ? more.getAttribute('aria-expanded') : null,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        rect: {
            x: +rect.x.toFixed(1), y: +rect.y.toFixed(1), w: +rect.width.toFixed(1), h: +rect.height.toFixed(1),
            right: +rect.right.toFixed(1), bottom: +rect.bottom.toFixed(1)
        },
        inlineTop: menu.style.top,
        inlineMaxHeight: menu.style.maxHeight,
        overflowY: cs.overflowY,
        maxHeight: cs.maxHeight,
        scrollHeight: menu.scrollHeight,
        clientHeight: menu.clientHeight,
        scrollable: menu.scrollHeight > menu.clientHeight + 1,
        items: items.length,
        itemTexts: items.map((el) => (el.textContent || '').trim()),
        bottomWithinViewport: rect.bottom <= window.innerHeight + 0.5,
        topWithinViewport: rect.top >= -0.5,
        rightWithinViewport: rect.right <= window.innerWidth + 0.5,
        lastItem: last ? (() => {
            const r = last.getBoundingClientRect();
            return { text: (last.textContent || '').trim(), y: +r.y.toFixed(1), bottom: +r.bottom.toFixed(1), h: +r.height.toFixed(1), disabled: !!last.disabled };
        })() : null
    };
};

const LAST_ITEM_REACH = () => {
    const menu = document.getElementById('word-panel-menu');
    if (!menu) return { found: false };
    const items = Array.from(menu.querySelectorAll('.menu-item'));
    const last = items[items.length - 1];
    if (!last) return { found: true, reachable: false };
    menu.scrollTop = menu.scrollHeight; // 捲到底
    const r = last.getBoundingClientRect();
    const mr = menu.getBoundingClientRect();
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    const top = document.elementFromPoint(cx, Math.min(window.innerHeight - 1, Math.max(1, cy)));
    const hit = !!(top && (top === last || last.contains(top)));
    return {
        found: true,
        menuScrollTop: menu.scrollTop,
        lastRect: { x: +r.x.toFixed(1), y: +r.y.toFixed(1), bottom: +r.bottom.toFixed(1), h: +r.height.toFixed(1) },
        insideMenu: r.top >= mr.top - 0.5 && r.bottom <= mr.bottom + 0.5,
        insideViewport: r.top >= -0.5 && r.bottom <= window.innerHeight + 0.5,
        hitTestHitsItem: hit,
        hitTag: top ? `${top.tagName}.${String(top.className || '').slice(0, 30)}` : ''
    };
};

const FRAME_SAMPLER = (ms) => {
    // 安裝逐幀取樣器（只讀 DOM）
    const btn = document.getElementById('book-name-details-btn');
    const nameEl = document.getElementById('current-book-name');
    window.__frames = [];
    const start = performance.now();
    const loop = () => {
        if (!btn || !nameEl) return;
        const cs = getComputedStyle(btn);
        const r = btn.getBoundingClientRect();
        const visible = !btn.hidden && cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
        const ncs = getComputedStyle(nameEl);
        const lh = parseFloat(ncs.lineHeight) || 24;
        window.__frames.push({
            t: Math.round(performance.now() - start),
            visible,
            hiddenProp: !!btn.hidden,
            display: cs.display,
            w: +r.width.toFixed(1),
            text: nameEl.textContent,
            len: nameEl.textContent.length,
            lines: Math.round(nameEl.getBoundingClientRect().height / lh),
            clipped: nameEl.scrollHeight > nameEl.clientHeight + 1
        });
        if (performance.now() - start < ms) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
};

const results = [];
function addFinding(list, severity, code, detail) { list.push({ severity, code, detail }); }

(async () => {
    fs.mkdirSync(SHOTS, { recursive: true });
    const launchOpts = { headless: true };
    if (fs.existsSync(CHROME)) launchOpts.executablePath = CHROME;
    const browser = await chromium.launch(launchOpts);

    // ══════════════ C1：空詞書 × 320×720 ＋ 縮放 ══════════════
    for (const locale of ['zh-CN', 'zh-HK']) {
        const context = await newContext(browser, { locale, width: 320, height: 720, books: [], activeId: null });
        const page = await context.newPage();
        const pageErrors = [];
        page.on('pageerror', (e) => pageErrors.push(String(e && e.message || e).slice(0, 180)));
        await page.goto(`${BASE}#v`, { waitUntil: 'load' });
        await page.waitForTimeout(1200);

        const entry = { case: 'empty-menu', locale, viewport: '320x720', stages: [], findings: [], pageErrors };
        const before = await page.evaluate(() => ({
            title: document.getElementById('current-book-name')?.textContent || '',
            moreVisible: (() => { const b = document.getElementById('word-panel-more-btn'); return b ? getComputedStyle(b).display !== 'none' : false; })(),
            bookCount: (() => { try { return JSON.parse(localStorage.getItem('vocabularyBooks') || '[]').length; } catch (_) { return -1; } })()
        }));
        entry.before = before;
        if (!before.moreVisible) addFinding(entry.findings, 'high', 'more-btn-missing', '空狀態看不到「更多」按鈕');

        await page.click('#word-panel-more-btn');
        await page.waitForTimeout(250);
        entry.stages.push({ step: 'open-320x720', ...(await page.evaluate(MENU_MEASURE)) });
        await page.screenshot({ path: path.join(SHOTS, `empty-menu_${locale}_320x720-open.png`) }).catch(() => {});

        const reach = await page.evaluate(LAST_ITEM_REACH);
        entry.reach = reach;
        await page.screenshot({ path: path.join(SHOTS, `empty-menu_${locale}_320x720-scrolled.png`) }).catch(() => {});

        // 縮放／改高度：選單保持開啟（等同瀏覽器縮放改變 CSS 視口）
        for (const size of [{ width: 320, height: 400 }, { width: 320, height: 260 }, { width: 390, height: 900 }, { width: 320, height: 720 }]) {
            await page.setViewportSize(size);
            await page.waitForTimeout(320);
            const m = await page.evaluate(MENU_MEASURE);
            const r = await page.evaluate(LAST_ITEM_REACH);
            entry.stages.push({ step: `resize-${size.width}x${size.height}`, ...m, reach: r });
        }
        // 縮放後「重新開啟」：確認選單在新視口尺寸下仍完整落在視口內且末項可點
        for (const size of [{ width: 320, height: 720 }, { width: 390, height: 900 }, { width: 320, height: 560 }, { width: 390, height: 600 }]) {
            await page.setViewportSize(size);
            await page.waitForTimeout(320);
            // 模擬使用者：先把 ⋯ 按鈕捲到看得到的位置，再開選單
            await page.evaluate(() => window.scrollTo(0, 0));
            await page.waitForTimeout(150);
            const triggerVisible = await page.evaluate(() => {
                const b = document.getElementById('word-panel-more-btn');
                const nav = document.querySelector('.app-nav');
                if (!b) return false;
                const r = b.getBoundingClientRect();
                const nr = nav ? nav.getBoundingClientRect() : null;
                const navTop = nr && nr.top > window.innerHeight / 2 ? nr.top : window.innerHeight;
                return r.top >= 0 && r.bottom <= navTop;
            });
            if (!triggerVisible) {
                await page.evaluate(() => document.getElementById('word-panel-more-btn')?.scrollIntoView({ block: 'center' }));
                await page.waitForTimeout(250);
            }
            const openedNow = await page.evaluate(() => {
                const menu = document.getElementById('word-panel-menu');
                if (menu && !menu.hidden) return false; // 已開著就不用再點
                document.getElementById('word-panel-more-btn')?.click();
                return true;
            });
            await page.waitForTimeout(320);
            const m = await page.evaluate(MENU_MEASURE);
            const r = await page.evaluate(LAST_ITEM_REACH);
            entry.stages.push({ step: `reopen-${size.width}x${size.height}`, reopened: openedNow, triggerScrolled: !triggerVisible, ...m, reach: r });
            await page.screenshot({ path: path.join(SHOTS, `empty-menu_${locale}_${size.width}x${size.height}-reopen.png`) }).catch(() => {});
            // 量完關掉，避免汙染下一個尺寸
            await page.evaluate(() => {
                const menu = document.getElementById('word-panel-menu');
                if (menu && !menu.hidden) document.getElementById('word-panel-more-btn')?.click();
            });
            await page.waitForTimeout(200);
        }

        // 真實瀏覽器縮放（headless 不一定支援；有變化就記下來）
        const zoomProbe = await page.evaluate(() => ({ ih: window.innerHeight, dpr: window.devicePixelRatio }));
        try {
            await page.keyboard.press('Control+Equal');
            await page.waitForTimeout(250);
            await page.keyboard.press('Control+Equal');
            await page.waitForTimeout(350);
        } catch (_) { /* 忽略 */ }
        const zoomAfter = await page.evaluate(() => ({ ih: window.innerHeight, dpr: window.devicePixelRatio }));
        entry.zoomProbe = { before: zoomProbe, after: zoomAfter, changed: zoomProbe.ih !== zoomAfter.ih || zoomProbe.dpr !== zoomAfter.dpr };
        if (entry.zoomProbe.changed) {
            entry.stages.push({ step: 'browser-zoom-in', ...(await page.evaluate(MENU_MEASURE)) });
        }

        // 判定
        const initial = entry.stages[0];
        if (!initial.found) addFinding(entry.findings, 'high', 'menu-missing', '選單節點不存在');
        else if (initial.hidden) addFinding(entry.findings, 'high', 'menu-not-open-on-320x720', `選單未開啟（aria-expanded=${initial.ariaExpanded}）`);
        else {
            if (!initial.bottomWithinViewport) addFinding(entry.findings, 'medium', 'menu-bottom-overflow', `bottom=${initial.rect.bottom} innerHeight=${initial.innerHeight}`);
            if (!initial.topWithinViewport) addFinding(entry.findings, 'medium', 'menu-top-overflow', `top=${initial.rect.y}`);
            if (!initial.rightWithinViewport) addFinding(entry.findings, 'medium', 'menu-right-overflow', `right=${initial.rect.right}`);
            if (initial.overflowY !== 'auto' && initial.overflowY !== 'scroll') addFinding(entry.findings, 'medium', 'menu-not-scrollable', initial.overflowY);
            if (initial.items !== 5) addFinding(entry.findings, 'medium', 'menu-item-count', String(initial.items));
        }
        if (reach.found && reach.reachable === false) addFinding(entry.findings, 'high', 'last-item-missing', '選單沒有項目');
        else if (!reach.insideViewport) addFinding(entry.findings, 'medium', 'last-item-outside-viewport', JSON.stringify(reach.lastRect));
        else if (!reach.insideMenu) addFinding(entry.findings, 'high', 'last-item-not-in-menu', JSON.stringify(reach.lastRect));
        else if (!reach.hitTestHitsItem) addFinding(entry.findings, 'medium', 'last-item-not-clickable', reach.hitTag);
        // 重新開啟後的視口內檢查
        entry.stages.filter((s) => s.step.startsWith('reopen-')).forEach((s) => {
            if (!s.found) { addFinding(entry.findings, 'high', `menu-missing@${s.step}`, '選單節點不存在'); return; }
            if (s.hidden) { addFinding(entry.findings, 'high', `menu-not-open@${s.step}`, `aria-expanded=${s.ariaExpanded}`); return; }
            if (!s.bottomWithinViewport) addFinding(entry.findings, 'medium', `reopen-bottom-overflow@${s.step}`, `bottom=${s.rect.bottom} innerHeight=${s.innerHeight}`);
            if (!s.topWithinViewport) addFinding(entry.findings, 'medium', `reopen-top-overflow@${s.step}`, `top=${s.rect.y}`);
            if (s.rect.right > s.innerWidth + 0.5) addFinding(entry.findings, 'medium', `reopen-right-overflow@${s.step}`, `right=${s.rect.right} innerWidth=${s.innerWidth}`);
            if (!s.reach.insideViewport) addFinding(entry.findings, 'medium', `reopen-last-item-outside-viewport@${s.step}`, JSON.stringify(s.reach.lastRect));
            if (!s.reach.hitTestHitsItem) addFinding(entry.findings, 'medium', `reopen-last-item-not-clickable@${s.step}`, s.reach.hitTag);
        });

        entry.stages.slice(1).forEach((s) => {
            if (!s.step.startsWith('resize-') || !s.found) return;
            // 新版的 positionWordPanelMenu 在「觸發器離開可見帶」時會主動收合選單 → 這是正確行為
            if (s.hidden) {
                if (s.ariaExpanded !== 'false') addFinding(entry.findings, 'low', `menu-closed-missing-aria@${s.step}`, String(s.ariaExpanded));
                return;
            }
            if (!s.bottomWithinViewport) addFinding(entry.findings, 'medium', `menu-bottom-overflow@${s.step}`, `bottom=${s.rect.bottom} innerHeight=${s.innerHeight}`);
            if (!s.topWithinViewport) addFinding(entry.findings, 'medium', `menu-top-overflow@${s.step}`, `top=${s.rect.y}`);
            if (!s.reach.insideViewport) addFinding(entry.findings, 'medium', `last-item-outside-viewport@${s.step}`, JSON.stringify(s.reach.lastRect));
        });

        results.push(entry);
        await context.close();
    }

    // ══════════════ C2：長名 → 短名，詳情圖示不得殘留 ══════════════
    const BOOKS = [
        { id: 'book-long', name: EN_ARTICLE, createdAt: '2026-01-01T00:00:00.000Z', sourceType: 'legacy', words: [{ id: 'l1', word: 'volunteer', meaning: '志愿者', sources: [] }] },
        { id: 'book-short', name: 'BOOK SHORT', createdAt: '2026-01-02T00:00:00.000Z', sourceType: 'legacy', words: [{ id: 's1', word: 'meaningful', meaning: '有意义的', sources: [] }] }
    ];

    for (const locale of ['zh-CN', 'zh-HK']) {
        for (const target of [{ width: 320, height: 720, mode: 'menu' }, { width: 834, height: 1112, mode: 'chips' }, { width: 1440, height: 900, mode: 'chips' }]) {
            const context = await newContext(browser, {
                locale, width: target.width, height: target.height, books: BOOKS, activeId: 'book-long'
            });
            const page = await context.newPage();
            const pageErrors = [];
            page.on('pageerror', (e) => pageErrors.push(String(e && e.message || e).slice(0, 180)));
            await page.goto(`${BASE}#v/book-long`, { waitUntil: 'load' });
            await page.waitForTimeout(1200);

            const entry = { case: 'rename-icon', locale, width: target.width, mode: target.mode, findings: [], pageErrors };
            entry.initial = await page.evaluate(() => {
                const btn = document.getElementById('book-name-details-btn');
                const nameEl = document.getElementById('current-book-name');
                return {
                    title: nameEl.textContent,
                    len: nameEl.textContent.length,
                    iconHidden: btn.hidden,
                    iconVisible: !btn.hidden && getComputedStyle(btn).display !== 'none',
                    moreVisible: (() => { const b = document.getElementById('word-panel-more-btn'); return b ? getComputedStyle(b).display !== 'none' : false; })()
                };
            });
            if (!entry.initial.iconVisible) addFinding(entry.findings, 'medium', 'long-name-icon-missing', '長名稱初始未顯示詳情圖示（無法驗殘留）');

            // 改名：長 → 短
            await page.evaluate(FRAME_SAMPLER, 1200);
            if (target.mode === 'menu') {
                await page.click('#word-panel-more-btn');
                await page.waitForTimeout(180);
                await page.locator('#word-panel-menu .menu-item').nth(MENU_EDIT_INDEX).click();
            } else {
                await page.click('#edit-vocab-book-btn');
            }
            await page.waitForTimeout(420);
            entry.modalOpen = await page.evaluate(() => !document.getElementById('app-modal').classList.contains('hidden'));
            await page.fill('#modal-book-name', SHORT);
            await page.click('#app-modal .save-btn');
            await page.waitForTimeout(1200);
            const frames = await page.evaluate(() => window.__frames || []);
            entry.afterRename = await page.evaluate(() => {
                const btn = document.getElementById('book-name-details-btn');
                const nameEl = document.getElementById('current-book-name');
                const stored = (() => { try { return JSON.parse(localStorage.getItem('vocabularyBooks') || '[]'); } catch (_) { return []; } })();
                const rec = stored.find((b) => b.id === 'book-long');
                return {
                    title: nameEl.textContent,
                    titleAttr: nameEl.getAttribute('title'),
                    iconHidden: btn.hidden,
                    iconDisplay: getComputedStyle(btn).display,
                    storedName: rec ? rec.name : null,
                    modalClosed: document.getElementById('app-modal').classList.contains('hidden')
                };
            });
            await page.screenshot({ path: path.join(SHOTS, `rename-short_${locale}_${target.width}.png`) }).catch(() => {});

            const residual = frames.filter((f) => f.visible && f.text === SHORT);
            entry.frameStats = {
                frames: frames.length,
                residualIconFrames: residual.length,
                residualSamples: residual.slice(0, 5),
                firstFrameTexts: frames.slice(0, 6).map((f) => ({ t: f.t, len: f.len, visible: f.visible, lines: f.lines })),
                lastFrames: frames.slice(-4).map((f) => ({ t: f.t, len: f.len, visible: f.visible, lines: f.lines }))
            };
            if (!entry.modalOpen) addFinding(entry.findings, 'high', 'edit-modal-not-open', '編輯彈窗未開啟');
            if (entry.afterRename.title !== SHORT) addFinding(entry.findings, 'high', 'rename-not-applied', entry.afterRename.title);
            if (!entry.afterRename.iconHidden) addFinding(entry.findings, 'medium', 'icon-still-shown-after-short', `${entry.afterRename.iconDisplay}`);
            if (entry.afterRename.storedName !== SHORT) addFinding(entry.findings, 'medium', 'stored-name-mismatch', String(entry.afterRename.storedName));
            if (residual.length) addFinding(entry.findings, 'low', 'residual-icon-frame', `${residual.length} 幀（名稱已短但圖示仍顯示）：${JSON.stringify(residual.slice(0, 3))}`);

            // 反向：短 → 長，圖示應重新出現（避免「乾脆永不出現」的假修正）
            await page.evaluate(FRAME_SAMPLER, 1400);
            if (target.mode === 'menu') {
                await page.click('#word-panel-more-btn');
                await page.waitForTimeout(180);
                await page.locator('#word-panel-menu .menu-item').nth(MENU_EDIT_INDEX).click();
            } else {
                await page.click('#edit-vocab-book-btn');
            }
            await page.waitForTimeout(420);
            await page.fill('#modal-book-name', EN_ARTICLE);
            await page.click('#app-modal .save-btn');
            await page.waitForTimeout(1400);
            const framesBack = await page.evaluate(() => window.__frames || []);
            entry.afterRestore = await page.evaluate(() => {
                const btn = document.getElementById('book-name-details-btn');
                const nameEl = document.getElementById('current-book-name');
                return {
                    title: nameEl.textContent,
                    len: nameEl.textContent.length,
                    iconHidden: btn.hidden,
                    iconVisible: !btn.hidden && getComputedStyle(btn).display !== 'none'
                };
            });
            entry.restoreFrameStats = {
                frames: framesBack.length,
                framesWithIconHidden: framesBack.filter((f) => !f.visible).length,
                last: framesBack.slice(-3).map((f) => ({ t: f.t, len: f.len, visible: f.visible }))
            };
            if (entry.afterRestore.len !== EN_ARTICLE.length) addFinding(entry.findings, 'medium', 'restore-name-mismatch', String(entry.afterRestore.len));
            if (!entry.afterRestore.iconVisible) addFinding(entry.findings, 'medium', 'icon-not-restored', '長名稱恢復後圖示未出現');
            await page.screenshot({ path: path.join(SHOTS, `rename-long_${locale}_${target.width}.png`) }).catch(() => {});

            results.push(entry);
            await context.close();
        }
    }

    await browser.close();
    const jsonPath = path.join(ASSET_DIR, 'empty-menu-and-rename.json');
    fs.writeFileSync(jsonPath, JSON.stringify({ finishedAt: new Date().toISOString(), results }, null, 2));
    const blocking = results.flatMap((r) => r.findings.map((f) => ({
        case: r.case, locale: r.locale, vp: r.viewport || `${r.width}x?`, ...f
    })));
    console.log(`cases=${results.length} blocking=${blocking.length}`);
    blocking.forEach((f) => console.log(`  [${f.severity}] ${f.case} ${f.locale}@${f.vp} ${f.code}: ${String(f.detail).slice(0, 200)}`));
    results.forEach((r) => {
        if (r.case === 'empty-menu') {
            const s = r.stages[0];
            console.log(`empty-menu ${r.locale}: rect=${JSON.stringify(s.rect)} innerH=${s.innerHeight} bottomOK=${s.bottomWithinViewport} maxH=${s.inlineMaxHeight} overflowY=${s.overflowY} scrollable=${s.scrollable} lastInsideVP=${r.reach.insideViewport} hit=${r.reach.hitTestHitsItem} findings=${r.findings.length}`);
            r.stages.slice(1).forEach((x) => console.log(`    ${x.step}: rect=${x.found ? JSON.stringify(x.rect) : 'n/a'} bottomOK=${x.bottomWithinViewport} lastInsideVP=${x.reach ? x.reach.insideViewport : 'n/a'}`));
            console.log(`    zoomProbe=${JSON.stringify(r.zoomProbe)}`);
        } else {
            console.log(`rename ${r.locale}@${r.width}(${r.mode}): icon→${r.afterRename.iconHidden ? 'hidden' : 'shown'} residualFrames=${r.frameStats.residualIconFrames} frames=${r.frameStats.frames} restoreIcon=${r.afterRestore.iconVisible} findings=${r.findings.length}`);
        }
    });
    console.log(`json: ${path.relative(ROOT, jsonPath)}`);
})();
