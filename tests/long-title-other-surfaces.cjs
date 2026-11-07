#!/usr/bin/env node
/**
 * 長標題巡檢（其他代表性畫面）：QA 問答集卡片、文章庫清單、詞書匯入彈窗。
 *
 * 這些畫面在離線 headless 環境不一定有真實資料，因此分兩段量測：
 *   real  —— 用真實資料／既有預置資料呈現的標題
 *   inject —— 在既有 DOM 節點注入超長標題字串，觀察版面是否被撐壞
 * 注入只改測試頁面的 DOM，不動 localStorage 內的教材原文或使用者資料。
 *
 * 用法：
 *   PORT=8313 PLAYWRIGHT_MODULE=<playwright> node tests/long-title-other-surfaces.cjs --label=v1
 */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8313);
const BASE = `http://127.0.0.1:${PORT}/`;
const OUT_ROOT = path.join(ROOT, 'docs', 'report', 'assets', 'long-title');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const argv = process.argv.slice(2);
const arg = (name, fallback = '') => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
};
const LABEL = arg('label', 'run');

const EN_ARTICLE = "Mike: Some volunteers help sell flags in the street. There are some other volunteers who help online. I'm one of them. Last month, I filmed a video to encourage people to donate money and posted it online. Although it took time, it was meaningful.";
const ZH_LONG = '香港中學文憑試英文科第三單元：環境保護與社區服務義工活動完整閱讀理解練習題目與答案詳解（第二部分）';

const VIEWPORTS = [
    { name: '320-phone', width: 320, height: 720 },
    { name: '390-phone', width: 390, height: 844 },
    { name: '834-tablet', width: 834, height: 1112 },
    { name: '1280-laptop', width: 1280, height: 900 }
];

const MEASURE = (selector) => {
    const visible = (el) => {
        if (!el) return false;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    };
    const rect = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1), right: +r.right.toFixed(1), bottom: +r.bottom.toFixed(1) };
    };
    const lines = (el) => {
        if (!el) return 0;
        const box = el.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(el);
        const rects = Array.from(range.getClientRects()).filter((r) => r.height > 0
            && r.y + r.height / 2 >= box.top - 1 && r.y + r.height / 2 <= box.bottom + 1);
        return new Set(rects.map((r) => Math.round(r.y))).size;
    };
    const nodes = Array.from(document.querySelectorAll(selector)).filter(visible);
    // 長標題優先量：避免 6 筆上限把真正要看的長名稱卡片裁掉
    nodes.sort((a, b) => (b.textContent || '').length - (a.textContent || '').length);
    return {
        count: nodes.length,
        docOverflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
        items: nodes.slice(0, 8).map((el) => {
            const parent = el.closest('.qa-set-card, .article-library-item, .modal-card, li') || el.parentElement;
            // 只比同層兄弟（不含祖先容器），否則「標題在容器內」會被誤判成重疊
            const siblings = el.parentElement
                ? Array.from(el.parentElement.children).filter((c) => c !== el && visible(c))
                : [];
            return {
                text: (el.textContent || '').trim().slice(0, 70),
                rect: rect(el),
                lines: lines(el),
                scrollWidth: el.scrollWidth,
                clientWidth: el.clientWidth,
                scrollHeight: el.scrollHeight,
                clientHeight: el.clientHeight,
                clipsX: el.scrollWidth > el.clientWidth + 1,
                clipsY: el.scrollHeight > el.clientHeight + 1,
                outsideViewport: (() => { const r = el.getBoundingClientRect(); return r.right > window.innerWidth + 1 || r.x < -1; })(),
                parentOverflowX: parent ? Math.max(0, parent.scrollWidth - parent.clientWidth) : 0,
                siblingRects: siblings.map((s) => ({ cls: String(s.className).slice(0, 40), rect: rect(s) }))
            };
        })
    };
};

function evaluateSurface(surface, data) {
    const findings = [];
    if (!data.count) {
        findings.push({ severity: 'info', code: 'surface-empty', detail: `${surface} 在離線環境沒有可量的節點` });
        return findings;
    }
    if (data.docOverflowX > 1) {
        findings.push({ severity: 'high', code: 'page-overflow-x', detail: `${surface} 頁面水平溢位 ${data.docOverflowX}px` });
    }
    data.items.forEach((item) => {
        const label = item.text.slice(0, 24);
        const tag = `${surface}「${label}」`;
        if (item.outsideViewport) findings.push({ severity: 'high', code: 'title-outside-viewport', detail: tag });
        if (item.clipsX) findings.push({ severity: 'medium', code: 'title-clips-x', detail: `${tag} ${item.scrollWidth}>${item.clientWidth}` });
        if (item.parentOverflowX > 1) findings.push({ severity: 'high', code: 'card-overflow-x', detail: `${tag} 卡片溢位 ${item.parentOverflowX}px` });
        if (item.lines > 3) findings.push({ severity: 'medium', code: 'title-many-lines', detail: `${tag} ${item.lines} 行 h=${item.rect.h}` });
        // 標題與同層兄弟（題數／操作按鈕）重疊
        item.siblingRects.forEach((sib) => {
            const a = item.rect;
            const b = sib.rect;
            if (!a || !b) return;
            const w = Math.min(a.right, b.right) - Math.max(a.x, b.x);
            const h = Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y);
            if (w > 0.5 && h > 0.5) {
                findings.push({ severity: 'high', code: 'title-overlaps-sibling', detail: `${tag} 與 ${sib.cls} 重疊 ${Math.round(w * h)}px²` });
            }
        });
    });
    return findings;
}

async function boot(browser, { locale, viewport, hash, seed }) {
    const context = await browser.newContext({ viewport, locale: locale === 'zh-HK' ? 'zh-HK' : 'zh-CN' });
    await context.route('**/*', (route) => {
        let host = '';
        try { host = new URL(route.request().url()).hostname; } catch (_) { return route.abort(); }
        return (host === '127.0.0.1' || host === 'localhost') ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    await page.addInitScript(({ locale, seed }) => {
        try {
            if (sessionStorage.getItem('__lt2')) return;
            sessionStorage.setItem('__lt2', '1');
            localStorage.clear();
            localStorage.setItem('pen_global_settings', JSON.stringify({ language: { interfaceLocale: locale }, assistant: { enabled: false } }));
            localStorage.setItem('vocabularyBooks', JSON.stringify([{ id: 'b1', name: '短名', words: [], createdAt: '2026-01-01T00:00:00.000Z', sourceType: 'legacy' }]));
            localStorage.setItem('activeBookId', 'b1');
            localStorage.setItem('vocabImportPromptShown', '1');
            Object.entries(seed || {}).forEach(([k, v]) => localStorage.setItem(k, JSON.stringify(v)));
            const synth = window.speechSynthesis;
            if (synth) { synth.speak = () => {}; synth.cancel = () => {}; }
        } catch (_) {}
    }, { locale, seed });
    await page.goto(`${BASE}${hash}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1800);
    return { context, page };
}

(async () => {
    fs.mkdirSync(path.join(OUT_ROOT, LABEL), { recursive: true });
    const launchOpts = { headless: true };
    if (fs.existsSync(CHROME)) launchOpts.executablePath = CHROME;
    const browser = await chromium.launch(launchOpts);
    const results = [];

    for (const locale of ['zh-CN', 'zh-HK']) {
        for (const vp of VIEWPORTS) {
            // ── QA：使用者自建問答集（長名稱）＋預置問答集
            {
                const seed = {
                    'qa-sets': [{ id: 'qa-long', name: EN_ARTICLE, category: '我的', questionCount: 12, createdAt: '2026-01-01T00:00:00.000Z', description: ZH_LONG }],
                    'qa-set-qa-long': { id: 'qa-long', name: EN_ARTICLE, questions: [{ q: 'What did Mike do?', a: 'He filmed a video.' }] }
                };
                const { context, page } = await boot(browser, { locale, viewport: { width: vp.width, height: vp.height }, hash: '#qa', seed });
                const data = await page.evaluate(MEASURE, '.qa-set-name');
                const shot = path.join(OUT_ROOT, LABEL, `qa-sets_${locale}_${vp.name}.png`);
                await page.screenshot({ path: shot }).catch(() => {});
                results.push({ surface: 'qa-sets', locale, viewport: vp, data, findings: evaluateSurface('qa-sets', data), screenshot: path.relative(ROOT, shot) });
                await context.close();
            }

            // ── 文章庫清單（真實預置文章標題）＋注入超長標題
            {
                const { context, page } = await boot(browser, { locale, viewport: { width: vp.width, height: vp.height }, hash: '#a', seed: {} });
                await page.evaluate(() => document.getElementById('show-article-library-btn')?.click());
                await page.waitForTimeout(900);
                const real = await page.evaluate(MEASURE, '#article-library-list .article-library-item h4');
                const injected = await page.evaluate((long) => {
                    const h = document.querySelector('#article-library-list .article-library-item h4');
                    if (!h) return null;
                    h.dataset.original = h.textContent;
                    h.textContent = long;
                    return true;
                }, EN_ARTICLE);
                await page.waitForTimeout(200);
                const afterInject = injected ? await page.evaluate(MEASURE, '#article-library-list .article-library-item h4') : null;
                const shot = path.join(OUT_ROOT, LABEL, `article-library_${locale}_${vp.name}.png`);
                await page.screenshot({ path: shot }).catch(() => {});
                results.push({
                    surface: 'article-library', locale, viewport: vp,
                    data: { real, afterInject },
                    findings: [
                        ...evaluateSurface('article-library(real)', real),
                        ...(afterInject ? evaluateSurface('article-library(inject)', afterInject) : [])
                    ],
                    screenshot: path.relative(ROOT, shot)
                });
                await context.close();
            }

            // ── 詞書匯入（來源）彈窗：注入超長來源名稱
            {
                const { context, page } = await boot(browser, { locale, viewport: { width: vp.width, height: vp.height }, hash: '#v', seed: {} });
                await page.evaluate(() => document.getElementById('import-vocab-book-btn')?.click());
                await page.waitForTimeout(600);
                const opened = await page.evaluate(() => {
                    const m = document.getElementById('app-modal');
                    return !!m && !m.classList.contains('hidden');
                });
                let data = { count: 0 };
                if (opened) {
                    await page.evaluate((long) => {
                        // 只改畫面文字，不動任何儲存資料
                        const h = document.getElementById('modal-title');
                        if (h) h.textContent = long;
                    }, EN_ARTICLE);
                    data = await page.evaluate(() => {
                        const m = document.getElementById('app-modal');
                        const card = m.querySelector('.modal-card, .modal-content, .modal') || m.firstElementChild;
                        const r = card.getBoundingClientRect();
                        const titleNode = document.getElementById('modal-title');
                        const tr = titleNode.getBoundingClientRect();
                        return {
                            count: 1,
                            docOverflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
                            items: [{
                                text: (titleNode.textContent || '').slice(0, 60),
                                rect: { x: +tr.x.toFixed(1), y: +tr.y.toFixed(1), w: +tr.width.toFixed(1), h: +tr.height.toFixed(1), right: +tr.right.toFixed(1), bottom: +tr.bottom.toFixed(1) },
                                lines: 0, scrollWidth: titleNode.scrollWidth, clientWidth: titleNode.clientWidth,
                                scrollHeight: titleNode.scrollHeight, clientHeight: titleNode.clientHeight,
                                clipsX: titleNode.scrollWidth > titleNode.clientWidth + 1,
                                clipsY: titleNode.scrollHeight > titleNode.clientHeight + 1,
                                outsideViewport: r.right > window.innerWidth + 1 || r.x < -1,
                                parentOverflowX: Math.max(0, card.scrollWidth - card.clientWidth),
                                siblingRects: []
                            }]
                        };
                    });
                }
                const shot = path.join(OUT_ROOT, LABEL, `import-modal_${locale}_${vp.name}.png`);
                if (opened) await page.screenshot({ path: shot }).catch(() => {});
                results.push({
                    surface: 'import-modal', locale, viewport: vp, opened, data,
                    findings: opened ? evaluateSurface('import-modal(inject)', data) : [{ severity: 'high', code: 'import-modal-not-open', detail: '匯入彈窗未開啟' }],
                    screenshot: opened ? path.relative(ROOT, shot) : ''
                });
                await context.close();
            }
        }
    }

    await browser.close();
    const jsonPath = path.join(OUT_ROOT, `${LABEL}-others.json`);
    fs.writeFileSync(jsonPath, JSON.stringify({ label: LABEL, results }, null, 2));
    const blocking = results.flatMap((r) => r.findings.filter((f) => f.severity !== 'info').map((f) => ({ ...r, ...f })));
    console.log(`cases=${results.length} blocking=${blocking.length}`);
    blocking.slice(0, 40).forEach((f) => console.log(`  [${f.severity}] ${f.surface} ${f.locale}@${f.viewport.name} ${f.code}: ${String(f.detail).slice(0, 160)}`));
    results.forEach((r) => {
        const empty = r.findings.some((f) => f.code === 'surface-empty');
        const count = r.data?.count ?? r.data?.real?.count ?? '?';
        console.log(`  ${r.surface} ${r.locale}@${r.viewport.name}: nodes=${count}${empty ? ' (empty)' : ''} findings=${r.findings.length}`);
    });
    console.log(`json: ${path.relative(ROOT, jsonPath)}`);
})();
