#!/usr/bin/env node
/**
 * V4「選單可操作範圍」定點覆驗 — B：縮小／捲動後入口離開操作區時的行為
 *
 * 由 V3 的 docs/report/assets/20261107063401314_long-title-v3/audit-empty-menu-and-rename.cjs 的 C1 改寫
 * （C2「改名圖示」屬 V3 已驗項目，本輪不重跑），斷言改為 V4 的預期行為：
 *
 *   規則（可證偽）：
 *     R1 若「更多」按鈕的矩形仍完整落在操作區 band=[頂欄底,底部導覽頂] 內
 *        → 選單必須仍開啟，且選單矩形完整落在 band 內、最後一項捲到底後 pointer 可達。
 *     R2 若「更多」按鈕已離開 band（視口變矮被頂欄／底部導覽吃掉）
 *        → 選單必須已收起：hidden=true、aria-expanded=false、display:none（不得留下視口外浮層），
 *          且該點不得仍命中選單。
 *     R3 收起後把視口還原、重新開啟 → 仍可正常開啟並滿足 R1（不得「關了就再也開不回來」）。
 *
 * 尺寸：320×720 → 320×400 → 320×260 → 390×900 → 320×720；另加頁面捲動情境（入口被捲出操作區）。
 * 詞書：空詞書（V3 出問題的場景）＋ 長標題各一輪，locale：zh-CN、zh-HK。
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
const BOOK_LONG = [{ id: 'book-long', name: EN_ARTICLE, createdAt: '2026-01-01T00:00:00.000Z', sourceType: 'legacy', words: [{ id: 'l1', word: 'volunteer', meaning: '志愿者', sources: [] }] }];

async function newContext(browser, { locale, width, height, books, activeId }) {
    const context = await browser.newContext({ viewport: { width, height }, locale: locale === 'zh-HK' ? 'zh-HK' : 'zh-CN' });
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
    }, { books, activeId, locale });
    return context;
}

/** 量測：band（獨立推算）、入口位置、選單狀態、最後一項可達性 */
const STATE = () => {
    const menu = document.getElementById('word-panel-menu');
    const more = document.getElementById('word-panel-more-btn');
    const nav = document.querySelector('.app-nav');
    const bar = document.querySelector('.app-bar');
    const iw = window.innerWidth;
    const ih = window.innerHeight;
    let bandTop = 0;
    let bandBottom = ih;
    const bars = [];
    const round = (n) => +n.toFixed(1);
    for (const [name, el] of [['app-bar', bar], ['app-nav', nav]]) {
        if (!el) continue;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        const dockedTop = ['fixed', 'sticky'].includes(cs.position) && r.top <= 0.5 && r.bottom > 0 && r.width >= iw - 1;
        const dockedBottom = ['fixed', 'sticky'].includes(cs.position) && r.bottom >= ih - 0.5 && r.top > ih / 2 && r.width >= iw - 1;
        bars.push({ el: name, position: cs.position, top: round(r.top), bottom: round(r.bottom), width: round(r.width), role: dockedTop ? 'top' : (dockedBottom ? 'bottom' : 'ignored') });
        if (dockedTop) bandTop = Math.max(bandTop, r.bottom);
        if (dockedBottom) bandBottom = Math.min(bandBottom, r.top);
    }
    const mr = more.getBoundingClientRect();
    const trigger = { top: round(mr.top), bottom: round(mr.bottom), inBand: mr.top >= bandTop - 0.5 && mr.bottom <= bandBottom + 0.5 };
    if (!menu) return { found: false, band: { top: round(bandTop), bottom: round(bandBottom) }, bars, trigger };
    const cs = getComputedStyle(menu);
    const rect = menu.getBoundingClientRect();
    const items = Array.from(menu.querySelectorAll('.menu-item'));
    const last = items[items.length - 1] || null;
    return {
        found: true,
        hidden: menu.hidden,
        ariaExpanded: more.getAttribute('aria-expanded'),
        display: cs.display,
        innerWidth: iw,
        innerHeight: ih,
        scrollY: round(window.scrollY),
        band: { top: round(bandTop), bottom: round(bandBottom), height: round(bandBottom - bandTop) },
        bars,
        trigger,
        rect: { y: round(rect.y), bottom: round(rect.bottom), h: round(rect.height), w: round(rect.width) },
        painted: cs.display !== 'none' && rect.height > 0,
        inBand: rect.top >= bandTop - 0.5 && rect.bottom <= bandBottom + 0.5,
        inlineTop: menu.style.top,
        inlineMaxHeight: menu.style.maxHeight,
        scrollable: menu.scrollHeight > menu.clientHeight + 1,
        hitAtMenuCenter: (() => {
            if (cs.display === 'none' || rect.height === 0) return null;
            const cx = rect.x + rect.width / 2;
            const cy = rect.y + rect.height / 2;
            if (cy <= 0 || cy >= ih) return '(off-viewport)';
            const top = document.elementFromPoint(cx, cy);
            return top ? `${top.tagName}.${String(top.className || '').slice(0, 28)}` : '(null)';
        })(),
        lastItem: last ? (() => {
            menu.scrollTop = menu.scrollHeight; // 捲到底
            const r = last.getBoundingClientRect();
            const cx = r.x + r.width / 2;
            const cy = r.y + r.height / 2;
            const top = (cy > 0 && cy < ih) ? document.elementFromPoint(cx, cy) : null;
            return {
                text: (last.textContent || '').trim(),
                rect: { y: round(r.y), bottom: round(r.bottom) },
                insideMenu: r.top >= menu.getBoundingClientRect().top - 0.5 && r.bottom <= menu.getBoundingClientRect().bottom + 0.5,
                hitIsSelf: !!(top && (top === last || last.contains(top))),
                hitTag: top ? `${top.tagName}.${String(top.className || '').slice(0, 28)}` : '(off-viewport)'
            };
        })() : null,
        // 「畫出來了卻點不到」的項目（被頂欄／底欄或任何元素蓋住）
        blockedItems: cs.display === 'none' ? [] : items.map((el) => {
            const r = el.getBoundingClientRect();
            const mr2 = menu.getBoundingClientRect();
            if (r.top < mr2.top - 0.5 || r.bottom > mr2.bottom + 0.5) return null; // 被選單自身裁掉＝需捲動
            const cx = r.x + r.width / 2;
            const cy = r.y + r.height / 2;
            if (cy <= 0 || cy >= ih) return `${(el.textContent || '').trim()}@off-viewport(${round(cy)})`;
            const top = document.elementFromPoint(cx, cy);
            if (top && (top === el || el.contains(top))) return null;
            return `${(el.textContent || '').trim()}@${round(cy)}(${top ? top.tagName + '.' + String(top.className || '').slice(0, 24) : 'null'})`;
        }).filter(Boolean),
        itemsInBand: items.filter((el) => {
            const r = el.getBoundingClientRect();
            return r.top >= bandTop - 0.5 && r.bottom <= bandBottom + 0.5;
        }).length,
        itemCount: items.length
    };
};

const results = [];
function addFinding(list, severity, code, detail) { list.push({ severity, code, detail }); }

function judge(prev, stage, state, findings, note) {
    if (!state.found) { addFinding(findings, 'high', 'menu-missing', '選單節點不存在'); return; }
    const justClosed = prev && prev.hidden === false && state.hidden === true;
    if (!state.hidden) {
        // 選單開著 → 必須完整在 band 內、最後一項可達、沒有「畫出來卻點不到」的項目
        if (!state.inBand) addFinding(findings, 'high', `menu-out-of-band@${stage}`, `menu=${JSON.stringify(state.rect)} band=${JSON.stringify(state.band)} trigger=${JSON.stringify(state.trigger)}`);
        if (state.lastItem && !state.lastItem.hitIsSelf) addFinding(findings, 'high', `last-item-unreachable@${stage}`, JSON.stringify(state.lastItem));
        if ((state.blockedItems || []).length) addFinding(findings, 'high', `items-covered@${stage}`, `${state.blockedItems.length}/${state.itemCount} 項被遮住：${JSON.stringify(state.blockedItems)}`);
        if (state.ariaExpanded !== 'true') addFinding(findings, 'medium', `aria-not-expanded@${stage}`, `aria-expanded=${state.ariaExpanded}`);
        return;
    }
    // 選單已收起（或本來就沒開）→ 不得留下任何可見浮層，aria 必須同步
    if (state.painted) addFinding(findings, 'high', `stale-layer-painted@${stage}`, `display=${state.display} rect=${JSON.stringify(state.rect)}`);
    if (state.ariaExpanded !== 'false') addFinding(findings, 'high', `aria-expanded-stale@${stage}`, `aria-expanded=${state.ariaExpanded}`);
    if (state.hitAtMenuCenter === 'DIV.word-panel-menu') addFinding(findings, 'high', 'ghost-menu-hit', `選單已收起但該點仍命中選單（${stage}）`);
    if (justClosed && state.trigger.inBand && !(note && note.allowClose)) {
        // 入口仍在操作區卻「剛剛」被收起：V4 只在入口離開 band 時才主動收起，這裡不應發生
        addFinding(findings, 'medium', `closed-while-trigger-in-band@${stage}`,
            `入口仍在 band（trigger=${JSON.stringify(state.trigger)} band=${JSON.stringify(state.band)}）卻自行收起`);
    }
}

(async () => {
    fs.mkdirSync(SHOTS, { recursive: true });
    const launchOpts = { headless: true };
    if (fs.existsSync(CHROME)) launchOpts.executablePath = CHROME;
    const browser = await chromium.launch(launchOpts);

    const kinds = [
        { kind: 'empty', books: [], activeId: null, hash: '#v' },
        { kind: 'long', books: BOOK_LONG, activeId: 'book-long', hash: '#v/book-long' }
    ];

    for (const locale of ['zh-CN', 'zh-HK']) {
        for (const k of kinds) {
            const context = await newContext(browser, { locale, width: 320, height: 720, books: k.books, activeId: k.activeId });
            const page = await context.newPage();
            const pageErrors = [];
            page.on('pageerror', (e) => pageErrors.push(String(e && e.message || e).slice(0, 180)));
            await page.goto(`${BASE}${k.hash}`, { waitUntil: 'load' });
            await page.waitForTimeout(1200);

            const entry = { locale, kind: k.kind, stages: [], findings: [], pageErrors };
            let prev = null;
            const record = async (step, extra) => {
                const s = await page.evaluate(STATE);
                entry.stages.push({ step, ...s, ...(extra || {}) });
                judge(prev, step, s, entry.findings, extra);
                prev = s;
                return s;
            };

            await page.click('#word-panel-more-btn');
            await page.waitForTimeout(250);
            await record('open-320x720', { openAttempted: true });
            await page.screenshot({ path: path.join(SHOTS, `shrink-${k.kind}_${locale}-320x720-open.png`) }).catch(() => {});

            // ── 逐步縮矮視口（等同瀏覽器放大／視口變矮），不主動關閉，看產品反應
            for (const size of [{ width: 320, height: 400 }, { width: 320, height: 260 }, { width: 390, height: 900 }, { width: 320, height: 720 }]) {
                await page.setViewportSize(size);
                await page.waitForTimeout(320);
                await record(`resize-${size.width}x${size.height}`);
                await page.screenshot({ path: path.join(SHOTS, `shrink-${k.kind}_${locale}-${size.width}x${size.height}.png`) }).catch(() => {});
            }

            // ── R3：回到 320x720 後重新開啟（若前面被收起），必須能開回來且符合 R1
            const wasClosed = await page.evaluate(() => document.getElementById('word-panel-menu').hidden);
            if (wasClosed) {
                await page.click('#word-panel-more-btn');
                await page.waitForTimeout(280);
            }
            await record('reopen-320x720', { wasClosed, openAttempted: wasClosed });
            await page.screenshot({ path: path.join(SHOTS, `shrink-${k.kind}_${locale}-reopen.png`) }).catch(() => {});

            // ── 頁面捲動：入口被捲出操作區時的行為
            for (const delta of [-120, 200, 400]) {
                await page.evaluate((d) => window.scrollBy(0, d), delta);
                await page.waitForTimeout(250);
                // 定案版在 openWordPanelMenu 註冊了 window scroll → close：頁面捲動即收起屬刻意行為（規格允許）
                await record(`page-scroll(${delta})`, { allowClose: true });
            }
            entry.scrollRange = await page.evaluate(() => ({ scrollY: window.scrollY, maxScroll: Math.max(0, document.documentElement.scrollHeight - window.innerHeight) }));
            await page.screenshot({ path: path.join(SHOTS, `shrink-${k.kind}_${locale}-scrolled.png`) }).catch(() => {});

            results.push(entry);
            await context.close();
        }
    }

    // ══════════ 直接以矮視口開啟（320×400 / 320×260），V3 出問題的同一場景 ══════════
    for (const locale of ['zh-CN', 'zh-HK']) {
        for (const k of kinds) {
            for (const size of [{ width: 320, height: 400 }, { width: 320, height: 260 }]) {
                const context = await newContext(browser, { locale, width: size.width, height: size.height, books: k.books, activeId: k.activeId });
                const page = await context.newPage();
                const pageErrors = [];
                page.on('pageerror', (e) => pageErrors.push(String(e && e.message || e).slice(0, 180)));
                await page.goto(`${BASE}${k.hash}`, { waitUntil: 'load' });
                await page.waitForTimeout(1200);
                const entry = { locale, kind: k.kind, viewport: `${size.width}x${size.height}`, stages: [], findings: [], pageErrors };
                let prev = null;
                const record = async (step, extra) => {
                    const s = await page.evaluate(STATE);
                    entry.stages.push({ step, ...s, ...(extra || {}) });
                    judge(prev, step, s, entry.findings, extra);
                    prev = s;
                    return s;
                };
                await page.click('#word-panel-more-btn');
                await page.waitForTimeout(280);
                const s = await record('open', { openAttempted: true });
                // 入口若本來就在操作區外 → 依 V4 規格「收起並 aria-expanded=false」即為正確，不算缺陷
                entry.outcome = s.hidden
                    ? (s.trigger.inBand
                        ? 'closed-on-open(harness-autoscroll: page.click 自動捲動→scroll→close；人類操作順序見 audit-menu-open-320x400-v4.cjs)'
                        : 'closed-by-design(trigger-outside-band)')
                    : 'open';
                await page.screenshot({ path: path.join(SHOTS, `shrink-direct-${k.kind}_${locale}-${size.width}x${size.height}.png`) }).catch(() => {});
                if (entry.outcome === 'open' && s.lastItem) {
                    entry.lastItemReachable = s.lastItem.hitIsSelf;
                }

                // ── 頁面捲動掃描（320×400 才有足夠可捲範圍）：入口被捲出操作區時的實際行為
                if (size.height === 400 && entry.outcome === 'open') {
                    entry.scrollSweep = [];
                    const maxScroll = await page.evaluate(() => Math.max(0, document.documentElement.scrollHeight - window.innerHeight));
                    entry.maxScroll = maxScroll;
                    for (const y of [0, Math.round(maxScroll / 2), maxScroll]) {
                        await page.evaluate((v) => window.scrollTo(0, v), y);
                        await page.waitForTimeout(220);
                        const st = await page.evaluate(STATE);
                        entry.scrollSweep.push({
                            scrollY: st.scrollY, trigger: st.trigger, hidden: st.hidden, ariaExpanded: st.ariaExpanded,
                            menu: st.rect, inBand: st.inBand, painted: st.painted, blockedItems: st.blockedItems,
                            lastItem: st.lastItem ? { hitIsSelf: st.lastItem.hitIsSelf, hitTag: st.lastItem.hitTag, rect: st.lastItem.rect } : null
                        });
                        judge(null, `scroll-sweep@y${y}`, st, entry.findings);
                        await page.screenshot({ path: path.join(SHOTS, `scroll-${k.kind}_${locale}-${size.width}x${size.height}-y${y}.png`) }).catch(() => {});
                    }
                }
                results.push(entry);
                await context.close();
            }
        }
    }

    await browser.close();
    const jsonPath = path.join(ASSET_DIR, 'menu-shrink-v4.json');
    const build = execSync('md5 -q features/vocabulary/vocabulary.js index.html styles.css', { cwd: ROOT }).toString().trim().split('\n');
    fs.writeFileSync(jsonPath, JSON.stringify({ finishedAt: new Date().toISOString(), build, results }, null, 2));
    const findings = results.flatMap((r) => r.findings.map((f) => ({ locale: r.locale, kind: r.kind, ...f })));
    console.log(`cases=${results.length} findings=${findings.length}`);
    findings.forEach((f) => console.log(`  [${f.severity}] ${f.locale}/${f.kind} ${f.code}: ${String(f.detail).slice(0, 240)}`));
    results.forEach((r) => {
        r.stages.forEach((s) => console.log(`${r.locale}/${r.kind} ${s.step}: trigger=${JSON.stringify(s.trigger)} hidden=${s.hidden} aria=${s.ariaExpanded} menu=${JSON.stringify(s.rect)} inBand=${s.inBand} painted=${s.painted}`));
    });
    console.log(`json: ${path.relative(ROOT, jsonPath)}`);
})();
