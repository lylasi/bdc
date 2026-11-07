#!/usr/bin/env node
/**
 * V5 單行守衛修正 — 定點覆驗（資源版本 b37b774bc1c7）
 *
 * 唯一正式差異：features/vocabulary/vocabulary.js positionWordPanelMenu()
 *   舊：if (trigger.top < viewportTop || trigger.bottom > viewportBottom)   // 必須「完整」落在操作帶內
 *   新：if (trigger.bottom <= viewportTop || trigger.top >= viewportBottom) // 只要與操作帶有交集就放行
 * 判讀原則：以「按鈕與操作帶(viewportTop..viewportBottom)是否有交集」為準；
 *   完全被底部導覽列蓋住 / 完全離開操作帶時，收合才是正確結果（不得要求它開啟）。
 *
 * 三部分（沿用既有 V3 腳本骨幹，僅改判定與斷言，未新增場景類型）：
 *   A. 80 例邊界掃描：2 語言 × 320/360 寬 × 500/520/540/560/568/580/600/620/640/720 高 × 空/長詞書
 *      → 每例斷言 menuOpen === (overlapBand > 0)；開啟時再驗 hidden/aria 一致、選單邊界避開 appBar/appNav、項目可捲達
 *   B. 4 例「完全無交集」：B1 自然 resize（開啟後縮高，按鈕整個沒入底欄）、B2 幾何注入（按鈕整支移到操作帶上方）
 *      → 必須收合（hidden=true 且 aria-expanded=false）
 *   C. 4 例桌面對照：1024（選單路徑）、1440（chips 路徑）× 2 語言 → 不得退化
 *
 * 用法：
 *   PORT=8313 PLAYWRIGHT_MODULE=<playwright> node <本檔>
 * 本腳本只量測，不改正式檔。
 */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = '/Users/linus/CODE/bdc';
const PORT = Number(process.env.PORT || 8313);
const BASE = `http://127.0.0.1:${PORT}/`;
const ASSET_DIR = __dirname;
const SHOTS = path.join(ASSET_DIR, 'shots');
const PARTS = (process.env.PARTS || 'A,B,C').split(',').map((x) => x.trim().toUpperCase());
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const MOCK = `export const AI_LIMITS={default:{maxConcurrency:1,minIntervalMs:400}};
export const TTS_CONFIG={baseUrl:'',baseUrlRemote:'',baseUrlLocal:'',use:'remote',voicesUrl:'',apiKey:'',voices:{}};
export const OCR_CONFIG={DEFAULT_MODEL:''};
export const ARTICLE_IMPORT={FEED_URL:'',PROXY_URL:'',SOURCES:[]};
export const SYNC={};export const SUPABASE={};`;

const LONG_BOOK = "Mike: Some volunteers help sell flags in the street. There are some other volunteers who help online. I'm one of them.";

// ---------- 頁內量測：帶幾何完全複製被測程式的算法 ----------
const PROBE = () => {
    const round = (n) => +n.toFixed(1);
    const box = (el) => {
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { top: round(b.top), bottom: round(b.bottom), height: round(b.height), left: round(b.left), right: round(b.right), width: round(b.width) };
    };
    const menu = document.getElementById('word-panel-menu');
    const more = document.getElementById('word-panel-more-btn');
    const header = document.getElementById('current-book-name')?.closest('.panel-header');
    const appBar = document.querySelector('.app-bar');
    const appNav = document.querySelector('.app-nav');

    let bandTop = 0;
    let bandBottom = window.innerHeight;
    const bars = [];
    for (const bar of [appBar, appNav]) {
        if (!bar) continue;
        const position = window.getComputedStyle(bar).position;
        if (!['fixed', 'sticky'].includes(position)) continue;
        const b = bar.getBoundingClientRect();
        bars.push({ cls: String(bar.className || ''), position, top: round(b.top), bottom: round(b.bottom), width: round(b.width) });
        if (b.width < window.innerWidth - 1 || b.bottom <= 0 || b.top >= window.innerHeight) continue;
        if (b.top < window.innerHeight / 2) bandTop = Math.max(bandTop, b.bottom);
        else bandBottom = Math.min(bandBottom, b.top);
    }

    const trigger = box(more);
    const overlapBand = trigger
        ? round(Math.max(0, Math.min(trigger.bottom, bandBottom) - Math.max(trigger.top, bandTop)))
        : 0;
    const fullyInsideBand = trigger ? (trigger.top >= bandTop - 0.01 && trigger.bottom <= bandBottom + 0.01) : null;

    return {
        scrollY: Math.round(window.scrollY),
        innerHeight: window.innerHeight,
        band: { top: round(bandTop), bottom: round(bandBottom) },
        bars,
        header: box(header),
        trigger,
        overlapBand,
        fullyInsideBand,
        guardClosedExpected: overlapBand === 0,
        moreDisplay: more ? window.getComputedStyle(more).display : null,
        menu: menu ? {
            hidden: menu.hidden,
            painted: window.getComputedStyle(menu).display !== 'none' && menu.getBoundingClientRect().height > 0,
            rect: box(menu),
            scrollable: menu.scrollHeight > menu.clientHeight + 1,
            inlineTop: menu.style.top,
            inlineMaxHeight: menu.style.maxHeight
        } : null,
        ariaExpanded: more ? more.getAttribute('aria-expanded') : null
    };
};

// ---------- 頁內量測：開啟時項目是否可捲達（第一項與最後一項都必須能被點到） ----------
const ITEM_REACH = () => {
    const menu = document.getElementById('word-panel-menu');
    const itemHit = (el) => {
        const mr = menu.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const inside = r.top >= mr.top - 0.5 && r.bottom <= mr.bottom + 0.5;
        if (!inside) return { ok: false, why: 'outside-menu-box', y: +r.top.toFixed(1) };
        const hit = document.elementFromPoint(cx, cy);
        const ok = !!hit && (hit === el || el.contains(hit));
        return { ok, why: ok ? '' : (hit ? `${hit.tagName}.${String(hit.className || '').slice(0, 20)}` : '(null)'), y: +r.top.toFixed(1) };
    };
    menu.scrollTop = 0;
    const items = Array.from(menu.querySelectorAll('.menu-item'));
    if (!items.length) return { count: 0, first: { ok: false, why: 'no-items' }, last: { ok: false, why: 'no-items' }, scrollable: false, scrollTopMax: 0 };
    const first = itemHit(items[0]);
    menu.scrollTop = menu.scrollHeight;
    const last = itemHit(items[items.length - 1]);
    const scrollTopMax = menu.scrollHeight - menu.clientHeight;
    menu.scrollTop = 0;
    return { count: items.length, first, last, scrollable: scrollTopMax > 1, scrollTopMax };
};

async function newCtx(browser, { width, height, locale, mode }) {
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
    await context.addInitScript(({ mode, locale, LONG_BOOK }) => {
        localStorage.clear();
        const books = mode === 'empty' ? [] : [{
            id: 'book-long',
            name: LONG_BOOK,
            createdAt: '2026-01-01T00:00:00.000Z', sourceType: 'legacy', words: []
        }];
        localStorage.setItem('vocabularyBooks', JSON.stringify(books));
        if (books.length) localStorage.setItem('activeBookId', 'book-long');
        localStorage.setItem('vocabImportPromptShown', '1');
        localStorage.setItem('pen_global_settings', JSON.stringify({ language: { interfaceLocale: locale }, assistant: { enabled: false } }));
    }, { mode, locale, LONG_BOOK });
    return context;
}

function judgeOpen(probe, reach, failed) {
    if (probe.menu.hidden !== false) failed.push('menu-hidden-when-should-open');
    if (probe.ariaExpanded !== 'true') failed.push(`aria-expanded=${probe.ariaExpanded} 應為 true`);
    if (!probe.menu.painted) failed.push('menu-not-painted');
    if (!(probe.menu.rect.height > 0)) failed.push('menu-zero-height');
    if (probe.menu.rect.top < probe.band.top - 0.5) failed.push(`menu-top=${probe.menu.rect.top} 侵入 appBar(<=${probe.band.top})`);
    if (probe.menu.rect.bottom > probe.band.bottom + 0.5) failed.push(`menu-bottom=${probe.menu.rect.bottom} 侵入 appNav(>=${probe.band.bottom})`);
    if (!reach.first.ok) failed.push(`首項不可達(${reach.first.why})`);
    if (!reach.last.ok) failed.push(`末項不可達(${reach.last.why})`);
}

function judgeClosed(probe, failed) {
    if (probe.menu.hidden !== true) failed.push(`應收合卻 hidden=${probe.menu.hidden}`);
    if (probe.ariaExpanded !== 'false') failed.push(`aria-expanded=${probe.ariaExpanded} 應為 false`);
}

(async () => {
    const launchOpts = { headless: true };
    if (fs.existsSync(CHROME)) launchOpts.executablePath = CHROME;
    const browser = await chromium.launch(launchOpts);
    fs.mkdirSync(SHOTS, { recursive: true });

    // ---- 環境與資源版本（前後核對用） ----
    const localHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'features/vocabulary/vocabulary.js'))).digest('hex');
    const servedText = await (await fetch(`${BASE}features/vocabulary/vocabulary.js`)).text();
    const servedHash = crypto.createHash('sha256').update(servedText).digest('hex');
    const indexHtml = await (await fetch(BASE)).text();
    const assetVersion = (indexHtml.match(/vocabulary\.js\?v=([0-9a-f]+)/) || [])[1] || null;
    const guardLine = (servedText.split('\n').find((l) => l.includes('trigger.top >= viewportBottom')) || '').trim();
    const environment = { localHash, servedHash, hashesMatch: localHash === servedHash, assetVersion, guardLine, startedAt: new Date().toISOString() };
    console.log(`資源版本: ${assetVersion}`);
    console.log(`vocabulary.js sha256(本機)=${localHash.slice(0, 16)}… sha256(HTTP)=${servedHash.slice(0, 16)}… 一致=${localHash === servedHash}`);
    console.log(`守衛行: ${guardLine}`);
    if (!environment.hashesMatch) {
        console.log('!! 本機檔與伺服器提供內容不一致，中止');
        await browser.close();
        process.exit(1);
    }

    const results = [];

    // ================= A. 80 例邊界掃描 =================
    const sizes = [];
    for (const width of [320, 360]) {
        for (const height of [500, 520, 540, 560, 568, 580, 600, 620, 640, 720]) sizes.push({ width, height });
    }
    if (PARTS.includes('A')) for (const locale of ['zh-CN', 'zh-HK']) {
        for (const size of sizes) {
            for (const mode of ['empty', 'long']) {
                const context = await newCtx(browser, { width: size.width, height: size.height, locale, mode });
                const page = await context.newPage();
                await page.goto(`${BASE}#v`, { waitUntil: 'load' });
                await page.waitForTimeout(1100);
                await page.evaluate(() => window.scrollTo(0, 0));
                await page.waitForTimeout(150);
                const before = await page.evaluate(PROBE);
                await page.evaluate(() => document.getElementById('word-panel-more-btn')?.click());
                await page.waitForTimeout(400);
                const after = await page.evaluate(PROBE);
                let reach = null;
                const failed = [];
                if (after.overlapBand > 0) {
                    reach = await page.evaluate(ITEM_REACH);
                    judgeOpen(after, reach, failed);
                } else {
                    judgeClosed(after, failed);
                }
                if (failed.length) await page.screenshot({ path: path.join(SHOTS, `A_${mode}_${size.width}x${size.height}_${locale}.png`) }).catch(() => {});
                results.push({
                    part: 'A', locale, mode, size,
                    expectation: after.overlapBand > 0 ? 'open' : 'closed',
                    band: after.band, bars: after.bars, header: after.header,
                    trigger: after.trigger, overlapBand: after.overlapBand,
                    fullyInsideBand: after.fullyInsideBand,
                    menu: after.menu, ariaExpanded: after.ariaExpanded, reach,
                    beforeTrigger: before.trigger, beforeOverlapBand: before.overlapBand,
                    failed, pass: failed.length === 0
                });
                await context.close();
            }
        }
    }

    // ================= B. 完全無交集 → 必須收合 =================
    if (PARTS.includes('B')) for (const locale of ['zh-CN', 'zh-HK']) {
        // B1：自然 resize — 720 開得起來，縮到 480 時按鈕整個沒入底部導覽列
        {
            const context = await newCtx(browser, { width: 360, height: 720, locale, mode: 'empty' });
            const page = await context.newPage();
            await page.goto(`${BASE}#v`, { waitUntil: 'load' });
            await page.waitForTimeout(1100);
            await page.evaluate(() => window.scrollTo(0, 0));
            await page.waitForTimeout(150);
            await page.evaluate(() => document.getElementById('word-panel-more-btn')?.click());
            await page.waitForTimeout(400);
            const opened = await page.evaluate(PROBE);
            await page.setViewportSize({ width: 360, height: 480 });
            await page.waitForTimeout(600);
            const after = await page.evaluate(PROBE);
            const failed = [];
            if (!(opened.overlapBand > 0 && opened.menu.hidden === false)) failed.push('前置：720 高應可開啟');
            if (after.overlapBand !== 0) failed.push(`resize 後仍與操作帶有交集(${after.overlapBand})，情境未成立`);
            judgeClosed(after, failed);
            if (failed.length) await page.screenshot({ path: path.join(SHOTS, `B1_resize_${locale}.png`) }).catch(() => {});
            results.push({
                part: 'B1', locale, mode: 'empty', viewport: '360x720→360x480',
                expectation: 'closed', openedAt720: { overlapBand: opened.overlapBand, hidden: opened.menu.hidden },
                band: after.band, trigger: after.trigger, overlapBand: after.overlapBand,
                menu: after.menu, ariaExpanded: after.ariaExpanded, failed, pass: failed.length === 0
            });
            await context.close();
        }
        // B2：幾何注入 — 把整個單詞本面板上移，使 ⋯ 完全離開操作帶上方（人工不可達，只為走守衛分支）
        {
            const context = await newCtx(browser, { width: 360, height: 720, locale, mode: 'empty' });
            const page = await context.newPage();
            await page.goto(`${BASE}#v`, { waitUntil: 'load' });
            await page.waitForTimeout(1100);
            await page.evaluate(() => window.scrollTo(0, 0));
            await page.waitForTimeout(150);
            await page.evaluate(() => document.getElementById('word-panel-more-btn')?.click());
            await page.waitForTimeout(400);
            const opened = await page.evaluate(PROBE);
            await page.evaluate(() => {
                const panel = document.getElementById('vocab-words-panel');
                panel.style.transform = 'translateY(-620px)';
                window.dispatchEvent(new Event('resize')); // 走 positionWordPanelMenu 的 resize 路徑
            });
            await page.waitForTimeout(300);
            const after = await page.evaluate(PROBE);
            const failed = [];
            if (!(opened.overlapBand > 0 && opened.menu.hidden === false)) failed.push('前置：720 高應可開啟');
            if (!(after.trigger && after.trigger.bottom <= after.band.top)) failed.push(`注入後按鈕未完全離開操作帶上方 trigger=${JSON.stringify(after.trigger)} band=${JSON.stringify(after.band)}`);
            if (after.overlapBand !== 0) failed.push(`注入後仍與操作帶有交集(${after.overlapBand})，情境未成立`);
            judgeClosed(after, failed);
            if (failed.length) await page.screenshot({ path: path.join(SHOTS, `B2_inject_${locale}.png`) }).catch(() => {});
            results.push({
                part: 'B2', locale, mode: 'empty', viewport: '360x720 + translateY(-620px)',
                expectation: 'closed', openedAt720: { overlapBand: opened.overlapBand, hidden: opened.menu.hidden },
                band: after.band, trigger: after.trigger, overlapBand: after.overlapBand,
                menu: after.menu, ariaExpanded: after.ariaExpanded, failed, pass: failed.length === 0
            });
            await context.close();
        }
    }

    // ================= C. 桌面對照（1024 選單路徑 / 1440 chips 路徑）=================
    if (PARTS.includes('C')) for (const locale of ['zh-CN', 'zh-HK']) {
        for (const target of [{ width: 1024, height: 900, mode: 'menu' }, { width: 1440, height: 900, mode: 'chips' }]) {
            const context = await newCtx(browser, { width: target.width, height: target.height, locale, mode: 'empty' });
            const page = await context.newPage();
            await page.goto(`${BASE}#v`, { waitUntil: 'load' });
            await page.waitForTimeout(1100);
            await page.evaluate(() => window.scrollTo(0, 0));
            await page.waitForTimeout(150);
            const out = { part: 'C', locale, viewport: `${target.width}x${target.height}`, mode: target.mode, failed: [] };
            const pre = await page.evaluate(PROBE);
            out.band = pre.band;
            out.bars = pre.bars;
            out.moreDisplay = pre.moreDisplay;
            if (target.mode === 'menu') {
                if (pre.moreDisplay === 'none') out.failed.push('1024 的 ⋯ 按鈕不應隱藏（應走選單路徑）');
                await page.evaluate(() => document.getElementById('word-panel-more-btn')?.click());
                await page.waitForTimeout(400);
                const after = await page.evaluate(PROBE);
                out.trigger = after.trigger;
                out.overlapBand = after.overlapBand;
                out.menu = after.menu;
                out.ariaExpanded = after.ariaExpanded;
                if (after.band.bottom !== after.innerHeight) out.failed.push(`側欄被誤判為底欄：band.bottom=${after.band.bottom} innerHeight=${after.innerHeight}`);
                out.reach = await page.evaluate(ITEM_REACH);
                judgeOpen(after, out.reach, out.failed);
            } else {
                if (pre.moreDisplay !== 'none') out.failed.push(`1440 的 ⋯ 按鈕應隱藏，實際 display=${pre.moreDisplay}`);
                // 空詞書下只有「合併」chip 可用（其餘 chip 為 disabled）。單本詞書會走守衛提示，
                // 仍足以證明 chips 的正式 handler 活著、且沒有被選單層攔截。
                await page.click('#merge-vocab-books-btn');
                await page.waitForTimeout(600);
                out.chipsResponse = await page.evaluate(() => ({
                    modalOpen: !document.getElementById('app-modal').classList.contains('hidden'),
                    modalTitle: document.getElementById('modal-title')?.textContent || '',
                    toast: Array.from(document.querySelectorAll('.toast, .banner, [class*=toast]')).map((e) => e.textContent.trim()).filter(Boolean)[0] || '',
                    menuPainted: (() => { const m = document.getElementById('word-panel-menu'); return !!m && getComputedStyle(m).display !== 'none'; })()
                }));
                if (!(out.chipsResponse.modalOpen || out.chipsResponse.toast)) out.failed.push('chips「合併」點擊無任何回應（handler 疑似失效）');
                if (out.chipsResponse.menuPainted) out.failed.push('1440 不應出現 #word-panel-menu');
                if (out.chipsResponse.modalOpen) {
                    await page.keyboard.press('Escape');
                    await page.waitForTimeout(350);
                    out.focusBack = await page.evaluate(() => {
                        const el = document.activeElement;
                        return { tag: el ? el.tagName : '', id: el ? el.id : '' };
                    });
                    if (out.focusBack.id !== 'merge-vocab-books-btn') out.failed.push(`關閉後焦點回=${out.focusBack.tag}#${out.focusBack.id || '(no id)'}`);
                }
            }
            out.pass = out.failed.length === 0;
            if (!out.pass) await page.screenshot({ path: path.join(SHOTS, `C_${target.width}_${locale}.png`) }).catch(() => {});
            results.push(out);
            await context.close();
        }
    }

    await browser.close();

    // ---- 後置核對：跑完後正式檔與伺服器內容必須與開始時一致 ----
    const localHashAfter = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'features/vocabulary/vocabulary.js'))).digest('hex');
    const servedHashAfter = crypto.createHash('sha256').update(await (await fetch(`${BASE}features/vocabulary/vocabulary.js`)).text()).digest('hex');
    const indexAfter = await (await fetch(BASE)).text();
    const environmentAfter = {
        localHash: localHashAfter,
        servedHash: servedHashAfter,
        assetVersion: (indexAfter.match(/vocabulary\.js\?v=([0-9a-f]+)/) || [])[1] || null,
        finishedAt: new Date().toISOString()
    };

    const jsonPath = path.join(ASSET_DIR, 'trigger-intersection-v5.json');
    fs.writeFileSync(jsonPath, JSON.stringify({ environment, environmentAfter, results }, null, 2));

    // ---- 輸出 ----
    const A = results.filter((r) => r.part === 'A');
    console.log('\n[A] locale mode  size        帶(top..bottom)  按鈕(top..bottom) 交集 預期  實際   選單(y..bottom) 可捲 判定');
    A.forEach((r) => {
        const m = r.menu;
        console.log(`${r.locale} ${r.mode.padEnd(5)} ${String(r.size.width).padStart(4)}x${String(r.size.height).padEnd(4)} ${String(r.band.top).padStart(4)}..${String(r.band.bottom).padEnd(4)} ${String(r.trigger?.top).padStart(6)}..${String(r.trigger?.bottom).padEnd(6)} ${String(r.overlapBand).padStart(5)} ${r.expectation.padEnd(6)} ${String(m.hidden ? 'closed' : 'open').padEnd(6)} ${m.hidden ? '-' : `${m.rect.top}..${m.rect.bottom}`} ${r.reach ? (r.reach.scrollable ? 'Y' : 'n') : '-'} ${r.pass ? 'PASS' : 'FAIL ' + r.failed.join(' | ')}`);
    });
    console.log('\n[B] 完全無交集 → 應收合');
    results.filter((r) => r.part.startsWith('B')).forEach((r) => {
        console.log(`${r.part} ${r.locale} ${r.viewport}: 交集=${r.overlapBand} 按鈕=${r.trigger?.top}..${r.trigger?.bottom} 帶=${r.band.top}..${r.band.bottom} menu.hidden=${r.menu.hidden} aria=${r.ariaExpanded} → ${r.pass ? 'PASS' : 'FAIL ' + r.failed.join(' | ')}`);
    });
    console.log('\n[C] 桌面對照');
    results.filter((r) => r.part === 'C').forEach((r) => {
        console.log(`${r.locale} ${r.viewport} ${r.mode}: band=${r.band.top}..${r.band.bottom} moreDisplay=${r.moreDisplay} ${r.mode === 'menu' ? `menu=${r.menu.hidden ? 'closed' : `${r.menu.rect.top}..${r.menu.rect.bottom}`} 可捲=${r.reach.scrollable}` : `chipsResponse=${JSON.stringify(r.chipsResponse)}`} → ${r.pass ? 'PASS' : 'FAIL ' + r.failed.join(' | ')}`);
    });

    const fails = results.filter((r) => !r.pass);
    const aOpen = A.filter((r) => r.expectation === 'open');
    const aClosed = A.filter((r) => r.expectation === 'closed');
    const r1 = A.filter((r) => r.mode === 'empty' && r.overlapBand > 0);
    console.log(`\n合計 ${results.length} 例（A=${A.length}, B=${results.filter((r) => r.part.startsWith('B')).length}, C=${results.filter((r) => r.part === 'C').length}）`);
    console.log(`A 內：預期開啟 ${aOpen.length} 例（部分可見）、預期收合 ${aClosed.length} 例（完全無交集）`);
    console.log(`R1 情境（空詞書、矮視口、按鈕部分可見）: ${r1.length} 例，全部開啟=${r1.every((r) => r.menu.hidden === false)}`);
    console.log(`FAIL: ${fails.length}`);
    console.log(`hash 前後一致: ${environment.localHash === localHashAfter && environment.servedHash === servedHashAfter && localHashAfter === servedHashAfter}`);
    console.log(`json: ${path.relative(ROOT, jsonPath)}`);
    process.exit(fails.length ? 2 : 0);
})();
