#!/usr/bin/env node
/**
 * V4「選單可操作範圍」定點覆驗 — C：1024／1440 不得把側欄當頂欄或底欄；選單／chips 原路徑可用；
 *                                從「更多」開編輯、關閉後焦點仍回到「更多」按鈕（V2 M1 修正不得退化）
 *
 * 由 V3 的 docs/report/assets/20261107063401314_long-title-v3/audit-menu-focus-v3.cjs 改寫：
 *   - 只保留本輪指定尺寸：1024（選單路徑）、1440（chips 路徑）
 *   - 新增側欄診斷：量 .app-nav 的 position / 寬度，確認 1024 的側欄不會被當成底部導覽
 *     （若被誤判，V4 的 viewportBottom 會變成側欄頂端，選單會一開就收起 → 這裡直接抓）
 *   - 其餘（編輯／合併 → Esc → activeElement、aria-expanded、選單是否收合）沿用 V3
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

const BOOKS = [
    {
        id: 'book-a',
        name: EN_ARTICLE,
        createdAt: '2026-01-01T00:00:00.000Z',
        sourceType: 'legacy',
        words: [{ id: 'a1', word: 'volunteer', meaning: '志愿者', sources: [] }]
    },
    // 「合併」需要至少兩本（否則只跳提示），故另備一本短名稱詞書
    {
        id: 'book-b',
        name: 'BOOK B',
        createdAt: '2026-01-02T00:00:00.000Z',
        sourceType: 'legacy',
        words: [{ id: 'b1', word: 'meaningful', meaning: '有意义的', sources: [] }]
    }
];

const MENU_EDIT_INDEX = 3; // 补全资料 / 合并 / 导出 / 编辑 / 删除
const MENU_MERGE_INDEX = 1;

const results = [];

function describeFocus() {
    const el = document.activeElement;
    if (!el) return { tag: '', id: '', cls: '' };
    return { tag: el.tagName, id: el.id || '', cls: String(el.className || '').slice(0, 60) };
}

(async () => {
    fs.mkdirSync(SHOTS, { recursive: true });
    const launchOpts = { headless: true };
    if (fs.existsSync(CHROME)) launchOpts.executablePath = CHROME;
    const browser = await chromium.launch(launchOpts);

    const targets = [
        { width: 1024, height: 900, mode: 'menu' },
        { width: 1440, height: 900, mode: 'chips' }
    ];

    for (const locale of ['zh-CN', 'zh-HK']) {
        for (const target of targets) {
            const context = await browser.newContext({
                viewport: { width: target.width, height: target.height },
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
            await context.addInitScript(({ books, locale }) => {
                localStorage.clear();
                localStorage.setItem('vocabularyBooks', JSON.stringify(books));
                localStorage.setItem('activeBookId', 'book-a');
                localStorage.setItem('vocabImportPromptShown', '1');
                localStorage.setItem('pen_global_settings', JSON.stringify({
                    language: { interfaceLocale: locale }, assistant: { enabled: false }
                }));
            }, { books: BOOKS, locale });
            const page = await context.newPage();
            const pageErrors = [];
            page.on('pageerror', (e) => pageErrors.push(String(e && e.message || e).slice(0, 180)));
            await page.goto(`${BASE}#v/book-a`, { waitUntil: 'load' });
            await page.waitForTimeout(1000);

            const out = { locale, width: target.width, mode: target.mode, pageErrors, findings: [] };
            const state = await page.evaluate(() => {
                const chips = document.querySelector('.word-panel-actions');
                const more = document.getElementById('word-panel-more-btn');
                return {
                    chipsVisible: chips ? getComputedStyle(chips).display !== 'none' : false,
                    moreVisible: more ? getComputedStyle(more).display !== 'none' : false,
                    detailsHidden: document.getElementById('book-name-details-btn')?.hidden === true
                };
            });
            out.initial = state;
            if (target.mode === 'menu' && !state.moreVisible) {
                out.findings.push({ severity: 'high', code: 'more-btn-missing', detail: '選單模式下看不到「更多」按鈕' });
            }
            if (target.mode === 'chips' && !state.chipsVisible) {
                out.findings.push({ severity: 'high', code: 'chips-missing', detail: 'chips 模式卻看不到 chips' });
            }

            if (target.mode === 'menu') {
                // ---- 編輯：⋯ → 編輯 → 開啟彈窗 → Esc → 焦點
                await page.click('#word-panel-more-btn');
                await page.waitForTimeout(180);
                out.menuOpen = await page.evaluate(() => {
                    const menu = document.getElementById('word-panel-menu');
                    const more = document.getElementById('word-panel-more-btn');
                    const nav = document.querySelector('.app-nav');
                    const bar = document.querySelector('.app-bar');
                    if (!menu) return null;
                    const iw = window.innerWidth;
                    const ih = window.innerHeight;
                    const r = menu.getBoundingClientRect();
                    const br = bar.getBoundingClientRect();
                    const nr = nav.getBoundingClientRect();
                    const ncs = getComputedStyle(nav);
                    const round = (n) => +n.toFixed(1);
                    // 獨立推算操作區：只認「貼齊上／下邊 + 全寬」的 fixed/sticky 列（側欄不算）
                    let bandTop = 0;
                    let bandBottom = ih;
                    const dockedTopBar = ['fixed', 'sticky'].includes(getComputedStyle(bar).position) && br.top <= 0.5 && br.width >= iw - 1;
                    const navDockedBottom = ['fixed', 'sticky'].includes(ncs.position) && nr.bottom >= ih - 0.5 && nr.top > ih / 2 && nr.width >= iw - 1;
                    const navDockedTop = ['fixed', 'sticky'].includes(ncs.position) && nr.top <= 0.5 + br.height + 1 && nr.width >= iw - 1 && nr.top < ih / 2;
                    if (dockedTopBar) bandTop = Math.max(bandTop, br.bottom);
                    if (navDockedTop) bandTop = Math.max(bandTop, nr.bottom);
                    if (navDockedBottom) bandBottom = Math.min(bandBottom, nr.top);
                    return {
                        hidden: menu.hidden,
                        ariaExpanded: more ? more.getAttribute('aria-expanded') : null,
                        items: menu.querySelectorAll('.menu-item').length,
                        rect: { x: round(r.x), y: round(r.y), w: round(r.width), h: round(r.height), bottom: round(r.bottom) },
                        insideViewport: r.bottom <= ih + 0.5 && r.top >= -0.5,
                        band: { top: round(bandTop), bottom: round(bandBottom), height: round(bandBottom - bandTop) },
                        inBand: r.top >= bandTop - 0.5 && r.bottom <= bandBottom + 0.5,
                        maxHeight: menu.style.maxHeight,
                        bars: {
                            appBar: { position: getComputedStyle(bar).position, top: round(br.top), bottom: round(br.bottom), width: round(br.width), role: dockedTopBar ? 'top' : 'ignored' },
                            appNav: { position: ncs.position, top: round(nr.top), bottom: round(nr.bottom), width: round(nr.width), innerWidth: iw,
                                role: navDockedBottom ? 'bottom' : (navDockedTop ? 'top' : 'ignored(sidebar)') }
                        },
                        wantedByV4: (() => {
                            // 重現 V4 的判定：固定/sticky 且「寬度 >= innerWidth-1」才納入
                            const pick = [];
                            for (const [name, el] of [['app-bar', bar], ['app-nav', nav]]) {
                                const cs = getComputedStyle(el);
                                const rr = el.getBoundingClientRect();
                                if (!['fixed', 'sticky'].includes(cs.position)) continue;
                                const fullWidthOk = rr.width >= iw - 1;
                                pick.push({ name, width: round(rr.width), fullWidthOk, used: fullWidthOk && rr.bottom > 0 && rr.top < ih });
                            }
                            return pick;
                        })()
                    };
                });
                if (out.menuOpen && out.menuOpen.hidden) {
                    out.findings.push({ severity: 'high', code: 'menu-closed-on-open', detail: `1024 選單一開即收起（band=${JSON.stringify(out.menuOpen.band)} bars=${JSON.stringify(out.menuOpen.bars)}）` });
                } else if (out.menuOpen) {
                    if (!out.menuOpen.inBand) out.findings.push({ severity: 'high', code: 'menu-out-of-band', detail: `menu=${JSON.stringify(out.menuOpen.rect)} band=${JSON.stringify(out.menuOpen.band)}` });
                    if (out.menuOpen.bars.appNav.role !== 'ignored(sidebar)') out.findings.push({ severity: 'high', code: 'sidebar-treated-as-bar', detail: JSON.stringify(out.menuOpen.bars.appNav) });
                }
                out.editFocus = await page.evaluate(() => document.activeElement ? document.activeElement.className : '');
                await page.locator('#word-panel-menu .menu-item').nth(MENU_EDIT_INDEX).click();
                await page.waitForTimeout(450);
                out.edit = await page.evaluate(() => {
                    const m = document.getElementById('app-modal');
                    const menu = document.getElementById('word-panel-menu');
                    return {
                        modalOpen: m ? !m.classList.contains('hidden') : false,
                        modalTitle: document.getElementById('modal-title')?.textContent || '',
                        menuClosed: menu ? menu.hidden : null
                    };
                });
                await page.screenshot({ path: path.join(SHOTS, `focus-edit-modal_${locale}_${target.width}.png`) }).catch(() => {});
                await page.keyboard.press('Escape');
                await page.waitForTimeout(350);
                out.editAfterClose = await page.evaluate(() => {
                    const el = document.activeElement;
                    const more = document.getElementById('word-panel-more-btn');
                    const menu = document.getElementById('word-panel-menu');
                    return {
                        tag: el ? el.tagName : '',
                        id: el ? el.id : '',
                        cls: el ? String(el.className || '').slice(0, 60) : '',
                        ariaExpanded: more ? more.getAttribute('aria-expanded') : null,
                        menuHidden: menu ? menu.hidden : null,
                        bodyHasFocus: el === document.body
                    };
                });
                if (!out.edit.modalOpen) out.findings.push({ severity: 'high', code: 'edit-modal-not-open', detail: '選單「編輯」未開彈窗' });
                if (out.editAfterClose.id !== 'word-panel-more-btn') {
                    out.findings.push({
                        severity: 'medium', code: 'edit-focus-not-returned',
                        detail: `關閉後焦點 = ${out.editAfterClose.tag}#${out.editAfterClose.id || '(no id)'}.${out.editAfterClose.cls || ''}`
                    });
                }

                // ---- 合併：⋯ → 合併 → 彈窗 → Esc → 焦點
                await page.click('#word-panel-more-btn');
                await page.waitForTimeout(180);
                await page.locator('#word-panel-menu .menu-item').nth(MENU_MERGE_INDEX).click();
                await page.waitForTimeout(550);
                out.merge = await page.evaluate(() => {
                    const m = document.getElementById('app-modal');
                    return {
                        modalOpen: m ? !m.classList.contains('hidden') : false,
                        modalTitle: document.getElementById('modal-title')?.textContent || ''
                    };
                });
                await page.screenshot({ path: path.join(SHOTS, `focus-merge-modal_${locale}_${target.width}.png`) }).catch(() => {});
                await page.keyboard.press('Escape');
                await page.waitForTimeout(350);
                out.mergeAfterClose = await page.evaluate(() => {
                    const el = document.activeElement;
                    const more = document.getElementById('word-panel-more-btn');
                    return {
                        tag: el ? el.tagName : '',
                        id: el ? el.id : '',
                        cls: el ? String(el.className || '').slice(0, 60) : '',
                        ariaExpanded: more ? more.getAttribute('aria-expanded') : null,
                        bodyHasFocus: el === document.body
                    };
                });
                if (!out.merge.modalOpen) out.findings.push({ severity: 'high', code: 'merge-modal-not-open', detail: '選單「合併」未開彈窗' });
                if (out.mergeAfterClose.id !== 'word-panel-more-btn') {
                    out.findings.push({
                        severity: 'medium', code: 'merge-focus-not-returned',
                        detail: `關閉後焦點 = ${out.mergeAfterClose.tag}#${out.mergeAfterClose.id || '(no id)'}.${out.mergeAfterClose.cls || ''}`
                    });
                }
            } else {
                // ---- 1440：chips 直接開彈窗（不得退化）
                await page.click('#edit-vocab-book-btn');
                await page.waitForTimeout(450);
                out.edit = await page.evaluate(() => ({
                    modalOpen: !document.getElementById('app-modal').classList.contains('hidden'),
                    modalTitle: document.getElementById('modal-title')?.textContent || ''
                }));
                await page.keyboard.press('Escape');
                await page.waitForTimeout(350);
                out.editAfterClose = await page.evaluate(() => {
                    const el = document.activeElement;
                    return { tag: el ? el.tagName : '', id: el ? el.id : '', cls: el ? String(el.className || '').slice(0, 60) : '', bodyHasFocus: el === document.body };
                });
                if (!out.edit.modalOpen) out.findings.push({ severity: 'high', code: 'edit-modal-not-open', detail: 'chips「編輯」未開彈窗' });
                if (out.editAfterClose.id !== 'edit-vocab-book-btn') {
                    out.findings.push({
                        severity: 'medium', code: 'chips-focus-regressed',
                        detail: `關閉後焦點 = ${out.editAfterClose.tag}#${out.editAfterClose.id || '(no id)'}`
                    });
                }

                await page.click('#merge-vocab-books-btn');
                await page.waitForTimeout(550);
                out.merge = await page.evaluate(() => ({
                    modalOpen: !document.getElementById('app-modal').classList.contains('hidden'),
                    modalTitle: document.getElementById('modal-title')?.textContent || ''
                }));
                await page.screenshot({ path: path.join(SHOTS, `focus-chips-merge_${locale}_1440.png`) }).catch(() => {});
                await page.keyboard.press('Escape');
                await page.waitForTimeout(350);
                out.mergeAfterClose = await page.evaluate(() => {
                    const el = document.activeElement;
                    return { tag: el ? el.tagName : '', id: el ? el.id : '', cls: el ? String(el.className || '').slice(0, 60) : '', bodyHasFocus: el === document.body };
                });
                if (!out.merge.modalOpen) out.findings.push({ severity: 'high', code: 'merge-modal-not-open', detail: 'chips「合併」未開彈窗' });
                if (out.mergeAfterClose.id !== 'merge-vocab-books-btn') {
                    out.findings.push({
                        severity: 'medium', code: 'chips-merge-focus-regressed',
                        detail: `關閉後焦點 = ${out.mergeAfterClose.tag}#${out.mergeAfterClose.id || '(no id)'}`
                    });
                }
            }

            results.push(out);
            await context.close();
        }
    }

    await browser.close();
    const jsonPath = path.join(ASSET_DIR, 'menu-focus-v4.json');
    const build = execSync('md5 -q features/vocabulary/vocabulary.js index.html styles.css', { cwd: ROOT }).toString().trim().split('\n');
    fs.writeFileSync(jsonPath, JSON.stringify({ finishedAt: new Date().toISOString(), build, results }, null, 2));
    const blocking = results.flatMap((r) => r.findings.map((f) => ({ locale: r.locale, width: r.width, ...f })));
    console.log(`cases=${results.length} blocking=${blocking.length}`);
    blocking.forEach((f) => console.log(`  [${f.severity}] ${f.locale}@${f.width} ${f.code}: ${f.detail}`));
    results.forEach((r) => {
        console.log(`${r.locale}@${r.width} (${r.mode}) edit→${r.editAfterClose.id || r.editAfterClose.tag} merge→${r.mergeAfterClose.id || r.mergeAfterClose.tag} findings=${r.findings.length}`);
    });
    console.log(`json: ${path.relative(ROOT, jsonPath)}`);
})();
