#!/usr/bin/env node
/**
 * V3 長標題最終覆驗（補量）：QA 卡片／QA 預覽彈窗全文、文章庫標題 title=、閱讀記錄 title=、新聞標題 clamp。
 *
 * 只量測、只截圖；不改正式程式碼、不寫使用者資料（每個案例都是獨立 context + 自帶 localStorage）。
 *  - /ai-config.js 由 route 回傳空 SYNC 的 mock
 *  - 只放行 127.0.0.1 / localhost，其餘主機 abort
 *
 * 用法：
 *   PORT=8313 PLAYWRIGHT_MODULE=<playwright> node docs/report/assets/<ts>_long-title-v3/audit-qa-and-titles.cjs
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

// 資產版本：執行時從 index.html 讀（避免硬編碼舊版本）
let ASSET_VERSION = '';

async function readAssetVersion(page) {
    return page.evaluate(async () => {
        try {
            const html = await (await fetch('/', { cache: 'no-store' })).text();
            const m = html.match(/\?v=([A-Za-z0-9]+)/);
            return m ? m[1] : '';
        } catch (_) { return ''; }
    });
}

const EN_ARTICLE = "Mike: Some volunteers help sell flags in the street. There are some other volunteers who help online. I'm one of them. Last month, I filmed a video to encourage people to donate money and posted it online. Although it took time, it was meaningful.";
const ZH_LONG = '香港中學文憑試英文科第三單元：環境保護與社區服務義工活動完整閱讀理解練習題目與答案詳解（第二部分）';

const VIEWPORTS = [
    { name: '320', width: 320, height: 720 },
    { name: '390', width: 390, height: 844 },
    { name: '834', width: 834, height: 1112 },
    { name: '1280', width: 1280, height: 900 }
];

const QA_SEED = {
    'qa-sets': [{
        id: 'qa-long', name: EN_ARTICLE, category: '我的', questionCount: 12,
        createdAt: '2026-01-01T00:00:00.000Z', description: ZH_LONG
    }],
    'qa-set-qa-long': {
        id: 'qa-long', name: EN_ARTICLE,
        questions: [{ qid: 'q1', question: 'What did Mike do?', answer: 'He filmed a video.' }]
    }
};

const rectOf = `(el)=>{const r=el.getBoundingClientRect();return {x:+r.x.toFixed(1),y:+r.y.toFixed(1),w:+r.width.toFixed(1),h:+r.height.toFixed(1),right:+r.right.toFixed(1),bottom:+r.bottom.toFixed(1)};}`;

async function boot(browser, { locale, viewport, hash, seed }) {
    const context = await browser.newContext({ viewport, locale: locale === 'zh-HK' ? 'zh-HK' : 'zh-CN' });
    await context.route('**/*', (route) => {
        let url;
        try { url = new URL(route.request().url()); } catch (_) { return route.abort(); }
        if (url.pathname.endsWith('/ai-config.js')) {
            return route.fulfill({ status: 200, contentType: 'application/javascript', body: MOCK });
        }
        return (url.hostname === '127.0.0.1' || url.hostname === 'localhost') ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e && e.message || e).slice(0, 200)));
    await page.addInitScript(({ locale, seed }) => {
        try {
            if (sessionStorage.getItem('__v3a3')) return;
            sessionStorage.setItem('__v3a3', '1');
            localStorage.clear();
            localStorage.setItem('pen_global_settings', JSON.stringify({
                language: { interfaceLocale: locale }, assistant: { enabled: false }
            }));
            localStorage.setItem('vocabularyBooks', JSON.stringify([
                { id: 'b1', name: '短名', words: [], createdAt: '2026-01-01T00:00:00.000Z', sourceType: 'legacy' }
            ]));
            localStorage.setItem('activeBookId', 'b1');
            localStorage.setItem('vocabImportPromptShown', '1');
            Object.entries(seed || {}).forEach(([k, v]) => localStorage.setItem(k, JSON.stringify(v)));
        } catch (_) {}
    }, { locale, seed });
    await page.goto(`${BASE}${hash}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1600);
    return { context, page, pageErrors };
}

const results = [];
function push(entry) { results.push(entry); }

(async () => {
    fs.mkdirSync(SHOTS, { recursive: true });
    const launchOpts = { headless: true };
    if (fs.existsSync(CHROME)) launchOpts.executablePath = CHROME;
    const browser = await chromium.launch(launchOpts);

    for (const locale of ['zh-CN', 'zh-HK']) {
        // ── 1) QA 卡片 .qa-set-name ＋ QA 預覽彈窗 .qa-preview-name
        for (const vp of VIEWPORTS) {
            const { context, page, pageErrors } = await boot(browser, {
                locale, viewport: { width: vp.width, height: vp.height }, hash: '#qa', seed: QA_SEED
            });
            const card = await page.evaluate((rectSrc) => {
                const rect = eval(rectSrc);
                const el = document.querySelector('.qa-set-card[data-qa-id="qa-long"] .qa-set-name');
                if (!el) return { found: false };
                const box = el.getBoundingClientRect();
                const range = document.createRange();
                range.selectNodeContents(el);
                const lines = new Set(Array.from(range.getClientRects())
                    .filter((r) => r.height > 0 && r.y + r.height / 2 >= box.top - 1 && r.y + r.height / 2 <= box.bottom + 1)
                    .map((r) => Math.round(r.y))).size;
                const cs = getComputedStyle(el);
                const cardEl = el.closest('.qa-set-card');
                const count = cardEl ? cardEl.querySelector('.qa-set-count') : null;
                const cr = count ? count.getBoundingClientRect() : null;
                const overlap = cr ? Math.max(0, Math.min(box.right, cr.right) - Math.max(box.x, cr.x))
                    * Math.max(0, Math.min(box.bottom, cr.bottom) - Math.max(box.y, cr.y)) : 0;
                return {
                    found: true,
                    text: el.textContent,
                    textLen: el.textContent.length,
                    titleAttr: el.getAttribute('title'),
                    titleMatches: (el.getAttribute('title') || '') === el.textContent,
                    lines,
                    clamp: cs.webkitLineClamp,
                    overflowWrap: cs.overflowWrap,
                    rect: rect(el),
                    cardRect: cardEl ? rect(cardEl) : null,
                    countRect: cr ? { x: +cr.x.toFixed(1), y: +cr.y.toFixed(1), w: +cr.width.toFixed(1), h: +cr.height.toFixed(1) } : null,
                    overlapWithCount: +overlap.toFixed(1),
                    clipsX: el.scrollWidth > el.clientWidth + 1,
                    clipsY: el.scrollHeight > el.clientHeight + 1,
                    cardOverflowX: cardEl ? Math.max(0, cardEl.scrollWidth - cardEl.clientWidth) : 0,
                    docOverflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth)
                };
            }, rectOf);
            await page.screenshot({ path: path.join(SHOTS, `qa-cards_${locale}_${vp.name}.png`) }).catch(() => {});

            const findings = [];
            if (!card.found) findings.push({ severity: 'high', code: 'qa-card-missing', detail: '找不到長名稱卡片' });
            else {
                if (card.lines > 2) findings.push({ severity: 'medium', code: 'qa-title-many-lines', detail: `${card.lines} 行` });
                if (card.clipsX) findings.push({ severity: 'high', code: 'qa-title-clips-x', detail: `${card.rect.w}` });
                if (card.overlapWithCount > 1) findings.push({ severity: 'high', code: 'qa-title-overlaps-count', detail: String(card.overlapWithCount) });
                if (!card.titleAttr) findings.push({ severity: 'medium', code: 'qa-title-attr-missing', detail: '缺少 title 全文' });
                if (card.titleAttr && !card.titleMatches) findings.push({ severity: 'medium', code: 'qa-title-attr-mismatch', detail: `len=${card.titleAttr.length}/${card.textLen}` });
                if (card.docOverflowX > 1) findings.push({ severity: 'high', code: 'qa-page-overflow-x', detail: String(card.docOverflowX) });
                if (card.cardOverflowX > 1) findings.push({ severity: 'high', code: 'qa-card-overflow-x', detail: String(card.cardOverflowX) });
            }

            // 開啟預覽彈窗
            const opened = await page.evaluate(() => {
                const btn = document.querySelector('.qa-set-card[data-qa-id="qa-long"] .view-btn');
                if (!btn) return false;
                btn.click();
                return true;
            });
            await page.waitForTimeout(500);
            const modal = await page.evaluate((rectSrc) => {
                const rect = eval(rectSrc);
                const m = document.getElementById('app-modal');
                const isOpen = m && !m.classList.contains('hidden');
                const title = document.getElementById('modal-title');
                const body = document.getElementById('modal-body');
                const name = document.querySelector('#modal-body .qa-preview-name');
                if (!isOpen || !name) return { open: !!isOpen, found: !!name };
                const cs = getComputedStyle(name);
                const nameRect = name.getBoundingClientRect();
                const bodyRect = body.getBoundingClientRect();
                const contentStyle = getComputedStyle(body);
                const card = m.querySelector('.modal-content');
                const cardRect = card.getBoundingClientRect();
                // 名字是否完全落在可捲動內文的內容區（右緣不超出、寬度不為 0）
                const insideRight = nameRect.right <= bodyRect.right - 8 + 1;
                // 內文是否可捲動、捲到底時名字是否仍可完整顯示（名字在最上方，先捲到頂）
                body.scrollTop = 0;
                const scrollable = body.scrollHeight > body.clientHeight + 1;
                return {
                    open: true,
                    found: true,
                    modalTitle: title ? title.textContent : '',
                    modalTitleLines: title ? Math.round(title.getBoundingClientRect().height
                        / Math.max(1, parseFloat(getComputedStyle(title).lineHeight) || 1)) : 0,
                    modalTitleRect: title ? rect(title) : null,
                    nameText: name.textContent,
                    nameLen: name.textContent.length,
                    nameLines: (() => {
                        const box = name.getBoundingClientRect();
                        const range = document.createRange();
                        range.selectNodeContents(name);
                        return new Set(Array.from(range.getClientRects())
                            .filter((r) => r.height > 0 && r.y + r.height / 2 >= box.top - 1 && r.y + r.height / 2 <= box.bottom + 1)
                            .map((r) => Math.round(r.y))).size;
                    })(),
                    clamp: cs.webkitLineClamp,
                    overflowWrap: cs.overflowWrap,
                    whiteSpace: cs.whiteSpace,
                    overflow: cs.overflow,
                    nameRect: rect(name),
                    nameInternalClipY: name.scrollHeight > name.clientHeight + 1,
                    nameInternalClipX: name.scrollWidth > name.clientWidth + 1,
                    bodyRect: rect(body),
                    bodyOverflowY: contentStyle.overflowY,
                    bodyScrollable: scrollable,
                    bodyScrollHeight: body.scrollHeight,
                    bodyClientHeight: body.clientHeight,
                    cardRect: rect(card),
                    insideRight,
                    cardInsideViewport: cardRect.right <= window.innerWidth + 1 && cardRect.left >= -1,
                    cardInsideViewportY: cardRect.top >= -1 && cardRect.bottom <= window.innerHeight + 1,
                    docOverflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
                    questionCount: document.querySelectorAll('#modal-body .qa-pair-preview').length
                };
            }, rectOf);
            await page.screenshot({ path: path.join(SHOTS, `qa-preview_${locale}_${vp.name}.png`) }).catch(() => {});

            if (!opened) findings.push({ severity: 'high', code: 'qa-preview-button-missing', detail: '看不到「查看」按鈕' });
            if (opened && !modal.open) findings.push({ severity: 'high', code: 'qa-preview-not-open', detail: '預覽彈窗未開啟' });
            if (modal.open) {
                const expectedTitle = locale === 'zh-HK' ? '查看問答集' : '查看问答集';
                if (modal.modalTitle.trim() !== expectedTitle) {
                    findings.push({ severity: 'low', code: 'qa-preview-title-unexpected', detail: modal.modalTitle });
                }
                if (modal.modalTitleLines > 2) findings.push({ severity: 'medium', code: 'qa-preview-title-many-lines', detail: String(modal.modalTitleLines) });
                if (modal.nameLen !== EN_ARTICLE.length) findings.push({ severity: 'high', code: 'qa-preview-name-truncated', detail: `${modal.nameLen}/${EN_ARTICLE.length}` });
                if (modal.nameText !== EN_ARTICLE) findings.push({ severity: 'high', code: 'qa-preview-name-mismatch', detail: '名稱與原始資料不一致' });
                if (modal.clamp && modal.clamp !== 'none') findings.push({ severity: 'high', code: 'qa-preview-name-clamped', detail: modal.clamp });
                if (modal.nameInternalClipY || modal.nameInternalClipX) findings.push({ severity: 'high', code: 'qa-preview-name-clipped', detail: JSON.stringify({ x: modal.nameInternalClipX, y: modal.nameInternalClipY }) });
                if (!modal.insideRight) findings.push({ severity: 'high', code: 'qa-preview-name-outside-body', detail: `${modal.nameRect.right}>${modal.bodyRect.right}` });
                if (modal.bodyOverflowY !== 'auto' && modal.bodyOverflowY !== 'scroll') findings.push({ severity: 'medium', code: 'qa-preview-body-not-scrollable', detail: modal.bodyOverflowY });
                if (modal.bodyScrollable !== true && modal.bodyScrollHeight > modal.bodyClientHeight + 1) findings.push({ severity: 'medium', code: 'qa-preview-body-scroll-broken', detail: JSON.stringify({ s: modal.bodyScrollHeight, c: modal.bodyClientHeight }) });
                if (!modal.cardInsideViewport) findings.push({ severity: 'high', code: 'qa-preview-card-outside-viewport', detail: JSON.stringify(modal.cardRect) });
                if (modal.docOverflowX > 1) findings.push({ severity: 'high', code: 'qa-preview-page-overflow-x', detail: String(modal.docOverflowX) });
            }
            // Esc 關閉並確認已收合
            await page.keyboard.press('Escape');
            await page.waitForTimeout(250);
            const closed = await page.evaluate(() => document.getElementById('app-modal').classList.contains('hidden'));

            push({
                surface: 'qa-card+preview', locale, viewport: vp, card, modal, closed, pageErrors,
                findings, screenshot: path.relative(ROOT, path.join(SHOTS, `qa-preview_${locale}_${vp.name}.png`))
            });
            await context.close();
        }

        // ── 2) 文章庫清單 h4：title 屬性與兩行 clamp
        for (const vp of VIEWPORTS) {
            const { context, page, pageErrors } = await boot(browser, {
                locale, viewport: { width: vp.width, height: vp.height }, hash: '#a', seed: {}
            });
            await page.evaluate(() => document.getElementById('show-article-library-btn')?.click());
            await page.waitForTimeout(900);
            const real = await page.evaluate((rectSrc) => {
                const rect = eval(rectSrc);
                const nodes = Array.from(document.querySelectorAll('#article-library-list .article-library-item h4'));
                const items = nodes.map((el) => {
                    const cs = getComputedStyle(el);
                    return {
                        text: el.textContent,
                        len: el.textContent.length,
                        titleAttr: el.getAttribute('title'),
                        titleMatches: (el.getAttribute('title') || '') === el.textContent,
                        clamp: cs.webkitLineClamp,
                        lines: (() => {
                            const box = el.getBoundingClientRect();
                            const range = document.createRange();
                            range.selectNodeContents(el);
                            return new Set(Array.from(range.getClientRects())
                                .filter((r) => r.height > 0 && r.y + r.height / 2 >= box.top - 1 && r.y + r.height / 2 <= box.bottom + 1)
                                .map((r) => Math.round(r.y))).size;
                        })(),
                        clipsX: el.scrollWidth > el.clientWidth + 1
                    };
                });
                return {
                    count: items.length,
                    missingTitleAttr: items.filter((i) => !i.titleAttr).length,
                    mismatch: items.filter((i) => i.titleAttr && !i.titleMatches).map((i) => i.text.slice(0, 30)),
                    maxLines: items.reduce((m, i) => Math.max(m, i.lines), 0),
                    clipsX: items.filter((i) => i.clipsX).length,
                    sample: items.slice(0, 3)
                };
            }, rectOf);
            // 注入長標題（只改測試頁 DOM；同時把 title 設成同一份長標題，模擬 renderer 行為）
            const injected = await page.evaluate(({ rectSrc, long }) => {
                const rect = eval(rectSrc);
                const h = document.querySelector('#article-library-list .article-library-item h4');
                if (!h) return null;
                h.textContent = long;
                h.setAttribute('title', long);
                const cs = getComputedStyle(h);
                const box = h.getBoundingClientRect();
                const range = document.createRange();
                range.selectNodeContents(h);
                const lines = new Set(Array.from(range.getClientRects())
                    .filter((r) => r.height > 0 && r.y + r.height / 2 >= box.top - 1 && r.y + r.height / 2 <= box.bottom + 1)
                    .map((r) => Math.round(r.y))).size;
                return {
                    lines,
                    clamp: cs.webkitLineClamp,
                    rect: rect(h),
                    clipsX: h.scrollWidth > h.clientWidth + 1,
                    clipsY: h.scrollHeight > h.clientHeight + 1,
                    titleAttrLen: (h.getAttribute('title') || '').length,
                    docOverflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
                    cardOverflowX: Math.max(0, (h.closest('.article-library-item') || h).scrollWidth - (h.closest('.article-library-item') || h).clientWidth)
                };
            }, { rectSrc: rectOf, long: EN_ARTICLE });
            await page.screenshot({ path: path.join(SHOTS, `article-library_${locale}_${vp.name}.png`) }).catch(() => {});

            const findings = [];
            if (!real.count) findings.push({ severity: 'high', code: 'library-empty', detail: '文章庫沒有節點' });
            if (real.missingTitleAttr) findings.push({ severity: 'medium', code: 'library-title-attr-missing', detail: `${real.missingTitleAttr} 個 h4 缺 title` });
            if (real.mismatch.length) findings.push({ severity: 'medium', code: 'library-title-attr-mismatch', detail: JSON.stringify(real.mismatch) });
            if (real.maxLines > 2) findings.push({ severity: 'medium', code: 'library-title-many-lines', detail: String(real.maxLines) });
            if (real.clipsX) findings.push({ severity: 'high', code: 'library-title-clips-x', detail: String(real.clipsX) });
            if (injected) {
                if (injected.lines > 2) findings.push({ severity: 'medium', code: 'library-inject-many-lines', detail: `${injected.lines} 行` });
                if (injected.clipsX) findings.push({ severity: 'high', code: 'library-inject-clips-x', detail: String(injected.clipsX) });
                if (injected.docOverflowX > 1) findings.push({ severity: 'high', code: 'library-inject-page-overflow-x', detail: String(injected.docOverflowX) });
                if (injected.cardOverflowX > 1) findings.push({ severity: 'high', code: 'library-inject-card-overflow-x', detail: String(injected.cardOverflowX) });
                if (injected.titleAttrLen !== EN_ARTICLE.length) findings.push({ severity: 'medium', code: 'library-inject-title-attr', detail: String(injected.titleAttrLen) });
            }
            push({
                surface: 'article-library', locale, viewport: vp, real, injected, pageErrors,
                findings, screenshot: path.relative(ROOT, path.join(SHOTS, `article-library_${locale}_${vp.name}.png`))
            });
            await context.close();
        }

        // ── 3) 閱讀記錄 .ar-history-title（title 全文）：以官方 article-store API 種一筆長標題記錄
        for (const vp of [{ name: '320', width: 320, height: 720 }, { name: '1280', width: 1280, height: 900 }]) {
            const { context, page, pageErrors } = await boot(browser, {
                locale, viewport: { width: vp.width, height: vp.height }, hash: '#a', seed: {}
            });
            ASSET_VERSION = ASSET_VERSION || await readAssetVersion(page);
            const seeded = await page.evaluate(async ({ version, long }) => {
                try {
                    const mod = await import(`/modules/article-store.js?v=${version}`);
                    await mod.initArticleStore();
                    const r = await mod.saveArticle({
                        articleId: 'art-long-v3',
                        title: long,
                        article: `${long}\n\nVolunteers help sell flags in the street.`,
                        sourceType: 'paste'
                    });
                    return { ok: !!r.ok, error: r.error || '' };
                } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
            }, { version: ASSET_VERSION, long: EN_ARTICLE });
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(1800);
            await page.evaluate(() => document.getElementById('article-history-btn')?.click());
            await page.waitForTimeout(700);
            const history = await page.evaluate(({ rectSrc, long }) => {
                const rect = eval(rectSrc);
                const rows = Array.from(document.querySelectorAll('#modal-body .ar-history-title'));
                const target = rows.find((el) => el.textContent === long) || null;
                const describe = (el) => {
                    if (!el) return null;
                    const cs = getComputedStyle(el);
                    const row = el.closest('.ar-history-item');
                    const side = row ? row.querySelector('.ar-history-side') : null;
                    const sr = side ? side.getBoundingClientRect() : null;
                    const er = el.getBoundingClientRect();
                    const overlap = sr ? Math.max(0, Math.min(er.right, sr.right) - Math.max(er.x, sr.x))
                        * Math.max(0, Math.min(er.bottom, sr.bottom) - Math.max(er.y, sr.y)) : 0;
                    return {
                        text: el.textContent,
                        len: el.textContent.length,
                        titleAttr: el.getAttribute('title'),
                        titleMatches: (el.getAttribute('title') || '') === el.textContent,
                        whiteSpace: cs.whiteSpace,
                        overflow: cs.overflow,
                        textOverflow: cs.textOverflow,
                        rect: rect(el),
                        rowRect: row ? rect(row) : null,
                        clipsX: el.scrollWidth > el.clientWidth + 1,
                        overlapWithSide: +overlap.toFixed(1),
                        rowOverflowX: row ? Math.max(0, row.scrollWidth - row.clientWidth) : 0
                    };
                };
                return {
                    count: rows.length,
                    allHaveTitle: rows.every((el) => (el.getAttribute('title') || '') === el.textContent),
                    target: describe(target),
                    first: describe(rows[0]),
                    docOverflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth)
                };
            }, { rectSrc: rectOf, long: EN_ARTICLE });
            await page.screenshot({ path: path.join(SHOTS, `ar-history_${locale}_${vp.name}.png`) }).catch(() => {});
            const findings = [];
            if (!seeded.ok) findings.push({ severity: 'medium', code: 'history-seed-failed', detail: seeded.error });
            if (!history.count) findings.push({ severity: 'high', code: 'history-empty', detail: '閱讀記錄沒有列' });
            else {
                if (!history.allHaveTitle) findings.push({ severity: 'medium', code: 'history-title-attr-missing', detail: '有列缺 title 全文' });
                if (!history.target) findings.push({ severity: 'medium', code: 'history-long-record-missing', detail: `只有 ${history.count} 列` });
                else {
                    if (history.target.len !== EN_ARTICLE.length) findings.push({ severity: 'high', code: 'history-title-truncated', detail: `${history.target.len}` });
                    if (!history.target.titleMatches) findings.push({ severity: 'medium', code: 'history-title-attr-mismatch', detail: `len=${(history.target.titleAttr || '').length}` });
                    if (history.target.rowOverflowX > 1) findings.push({ severity: 'high', code: 'history-row-overflow-x', detail: String(history.target.rowOverflowX) });
                    if (history.target.overlapWithSide > 1) findings.push({ severity: 'high', code: 'history-title-overlaps-actions', detail: String(history.target.overlapWithSide) });
                }
                if (history.docOverflowX > 1) findings.push({ severity: 'high', code: 'history-page-overflow-x', detail: String(history.docOverflowX) });
            }
            push({
                surface: 'article-history', locale, viewport: vp, seeded, history, pageErrors,
                findings, screenshot: path.relative(ROOT, path.join(SHOTS, `ar-history_${locale}_${vp.name}.png`))
            });
            await context.close();
        }

        // ── 4) 新聞標題 .news-title：feed 來源被 mock 為空，故在真實 #news-feed 容器注入 renderer 相同結構
        for (const vp of [{ name: '320', width: 320, height: 720 }, { name: '1280', width: 1280, height: 900 }]) {
            const { context, page, pageErrors } = await boot(browser, {
                locale, viewport: { width: vp.width, height: vp.height }, hash: '#a', seed: {}
            });
            await page.evaluate(() => document.getElementById('import-article-btn')?.click());
            await page.waitForTimeout(500);
            await page.evaluate(() => document.querySelector('.import-tabbar .tab-btn[data-tab="news"]')?.click());
            await page.waitForTimeout(700);
            const news = await page.evaluate(({ rectSrc, long }) => {
                const rect = eval(rectSrc);
                const feed = document.querySelector('#news-feed');
                if (!feed) return { feedFound: false };
                const card = document.createElement('div');
                card.className = 'news-card';
                const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
                card.innerHTML = `<div class="news-head"><div class="news-title" title="${esc(long)}">${esc(long)}</div>`
                    + `<div class="news-meta">2026-11-07 · mock</div></div>`
                    + `<div class="news-actions"><button class="btn-secondary news-preview-btn">预览</button></div>`;
                feed.appendChild(card);
                const el = card.querySelector('.news-title');
                const cs = getComputedStyle(el);
                const box = el.getBoundingClientRect();
                const range = document.createRange();
                range.selectNodeContents(el);
                const lines = new Set(Array.from(range.getClientRects())
                    .filter((r) => r.height > 0 && r.y + r.height / 2 >= box.top - 1 && r.y + r.height / 2 <= box.bottom + 1)
                    .map((r) => Math.round(r.y))).size;
                const actions = card.querySelector('.news-actions').getBoundingClientRect();
                const overlap = Math.max(0, Math.min(box.right, actions.right) - Math.max(box.x, actions.x))
                    * Math.max(0, Math.min(box.bottom, actions.bottom) - Math.max(box.y, actions.y));
                return {
                    feedFound: true,
                    text: el.textContent,
                    len: el.textContent.length,
                    titleAttrLen: (el.getAttribute('title') || '').length,
                    clamp: cs.webkitLineClamp,
                    overflowWrap: cs.overflowWrap,
                    lines,
                    rect: rect(el),
                    clipsX: el.scrollWidth > el.clientWidth + 1,
                    overlapWithActions: +overlap.toFixed(1),
                    cardOverflowX: Math.max(0, card.scrollWidth - card.clientWidth),
                    docOverflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth)
                };
            }, { rectSrc: rectOf, long: EN_ARTICLE });
            await page.screenshot({ path: path.join(SHOTS, `news-title_${locale}_${vp.name}.png`) }).catch(() => {});
            const findings = [];
            if (!news.feedFound) findings.push({ severity: 'medium', code: 'news-feed-missing', detail: '#news-feed 不存在' });
            else {
                if (news.lines > 2) findings.push({ severity: 'medium', code: 'news-title-many-lines', detail: String(news.lines) });
                if (news.clipsX) findings.push({ severity: 'high', code: 'news-title-clips-x', detail: String(news.clipsX) });
                if (news.overlapWithActions > 1) findings.push({ severity: 'high', code: 'news-title-overlaps-actions', detail: String(news.overlapWithActions) });
                if (news.titleAttrLen !== EN_ARTICLE.length) findings.push({ severity: 'medium', code: 'news-title-attr', detail: String(news.titleAttrLen) });
                if (news.cardOverflowX > 1) findings.push({ severity: 'high', code: 'news-card-overflow-x', detail: String(news.cardOverflowX) });
                if (news.docOverflowX > 1) findings.push({ severity: 'high', code: 'news-page-overflow-x', detail: String(news.docOverflowX) });
            }
            push({
                surface: 'news-title', locale, viewport: vp, news, pageErrors,
                findings, screenshot: path.relative(ROOT, path.join(SHOTS, `news-title_${locale}_${vp.name}.png`))
            });
            await context.close();
        }
    }

    await browser.close();
    const jsonPath = path.join(ASSET_DIR, 'qa-and-titles.json');
    fs.writeFileSync(jsonPath, JSON.stringify({
        startedAt: new Date().toISOString(),
        script: path.relative(ROOT, __filename),
        results
    }, null, 2));
    const blocking = results.flatMap((r) => r.findings.filter((f) => f.severity !== 'info')
        .map((f) => ({ surface: r.surface, locale: r.locale, vp: r.viewport.name, ...f })));
    console.log(`cases=${results.length} blocking=${blocking.length}`);
    blocking.forEach((f) => console.log(`  [${f.severity}] ${f.surface} ${f.locale}@${f.vp} ${f.code}: ${String(f.detail).slice(0, 160)}`));
    results.forEach((r) => console.log(`  ${r.surface} ${r.locale}@${r.viewport.name}: findings=${r.findings.length}`));
    console.log(`json: ${path.relative(ROOT, jsonPath)}`);
})();
