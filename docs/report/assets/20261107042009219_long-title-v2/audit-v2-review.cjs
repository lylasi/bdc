#!/usr/bin/env node
/**
 * 長標題 UI 第二版 — 獨立覆驗（agent 「測試界面審查」獨立腳本）
 *
 * 只用來量測與截圖，不改任何正式程式檔。
 *  - 獨立 headless context；mock /ai-config.js 為空 SYNC；封鎖所有外站
 *  - 不讀寫使用者瀏覽器的登入態（每次都是全新 context + 自帶 localStorage）
 *
 * 用法：
 *   PORT=8313 PLAYWRIGHT_MODULE=<playwright> node /tmp/bdc-v2-review.cjs --stage=vocab
 *   ... --stage=details|moremenu|edit|sources|langswitch|all
 */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('fs');
const path = require('path');

const ROOT = '/Users/linus/CODE/bdc';
const PORT = Number(process.env.PORT || 8313);
const BASE = `http://127.0.0.1:${PORT}/`;
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function stamp() {
    const d = new Date();
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}`;
}
const TS = stamp();
const OUT_ROOT = path.join(ROOT, 'docs', 'report', 'assets', `${TS}_long-title-v2`);
const SHOTS = path.join(OUT_ROOT, 'shots');

const argv = process.argv.slice(2);
const arg = (name, fallback = '') => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
};
const STAGE = arg('stage', 'all');
const VP_FILTER = arg('viewports', '').split(',').filter(Boolean);
const TITLE_FILTER = arg('titles', '').split(',').filter(Boolean);

const ALL_VIEWPORTS_ALL = [
    { name: '320', width: 320, height: 720 },
    { name: '390', width: 390, height: 844 },
    { name: '719', width: 719, height: 900 },
    { name: '720', width: 720, height: 900 },
    { name: '834', width: 834, height: 1112 },
    { name: '1024', width: 1024, height: 900 },
    { name: '1280', width: 1280, height: 900 },
    { name: '1440', width: 1440, height: 900 }
];
const ALL_VIEWPORTS = VP_FILTER.length ? ALL_VIEWPORTS_ALL.filter((v) => VP_FILTER.includes(v.name)) : ALL_VIEWPORTS_ALL;

const EN_ARTICLE = "Mike: Some volunteers help sell flags in the street. There are some other volunteers who help online. I'm one of them. Last month, I filmed a video to encourage people to donate money and posted it online. Although it took time, it was meaningful.";
const ZH_LONG = '香港中學文憑試英文科第三單元：環境保護與社區服務義工活動完整閱讀理解練習題目與答案詳解（第二部分）';
const NO_SPACE = 'https://www.example.com/learning/articles/2026/11/very-long-path-without-any-break-opportunity-abcdefghijklmnopqrstuvwxyz0123456789?token=abcdef0123456789';
const SHORT = '5A Unit 1 单词本';

const TITLES_ALL = [
    { key: 'en-article', name: EN_ARTICLE, note: '使用者提供的長英文原樣（整段文章）' },
    { key: 'zh-long', name: ZH_LONG, note: '超長中文' },
    { key: 'nospace', name: NO_SPACE, note: '無空格長網址' },
    { key: 'short', name: SHORT, note: '普通短標題（對照組）' }
];
const TITLES = TITLE_FILTER.length ? TITLES_ALL.filter((t) => TITLE_FILTER.includes(t.key)) : TITLES_ALL;
const LOCALES = ['zh-CN', 'zh-HK'];
const BANNER_URL = 'https://example.com/learning/articles/2026/11/very-long-path-without-any-break-opportunity-abcdefghijklmnopqrstuvwxyz0123456789';

const LONG_TERM = 'https://example.com/a/very-long-word-without-breaks-abcdefghijklmnopqrstuvwxyz-0123456789?ref=单词来源测试';
const WORDS = [
    {
        id: 'w1', word: 'volunteer', meaning: '志愿者', phonetic: 'ˌvɒlənˈtɪə',
        sources: [
            { pageTitle: 'Some volunteers help sell flags in the street. There are some other volunteers who help online.', sourceUrl: 'https://example.com/article/very-long-source-link-abcdefghijklmnopqrstuvwxyz', sentence: 'Some volunteers help sell flags in the street.', meaning: '一些志愿者在街上帮忙卖旗。', context: '义工的社区服务活动', addedAt: '2026-10-01T10:00:00.000Z' },
            { pageTitle: '', sourceUrl: '', sentence: 'I am one of them.', meaning: '我是其中之一。', context: '', addedAt: '2026-10-02T10:00:00.000Z' },
            { pageTitle: '', sourceUrl: '', sentence: 'It was meaningful.', meaning: '这很有意义。', context: '', addedAt: '2026-10-03T10:00:00.000Z' }
        ]
    },
    { id: 'w2', word: 'meaningful', meaning: '有意义的', phonetic: 'ˈmiːnɪŋfl', sources: [] },
    { id: 'w3', word: LONG_TERM, meaning: '超长词条（无断点）', phonetic: '', sources: [{ pageTitle: 'Article', sourceUrl: 'https://example.com/x', sentence: 'Long term in sentence.', meaning: '长词。', context: '', addedAt: '2026-10-04T10:00:00.000Z' }] },
    { id: 'w4', word: 'encourage', meaning: '鼓励', phonetic: 'ɪnˈkʌrɪdʒ', sources: [] }
];

function buildBooks() {
    return TITLES.map((title) => ({
        id: `book-${title.key}`,
        name: title.name,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        sourceType: 'url',
        sourceUrl: 'https://example.com/learning/articles/2026/11/very-long-path-without-any-break-opportunity-abcdefghijklmnopqrstuvwxyz0123456789',
        // 詞條 id 必須跨書唯一，否則舊資料遷移會因去重而回讀核對失敗
        words: WORDS.map((w) => ({ ...JSON.parse(JSON.stringify(w)), id: `book-${title.key}-${w.id}` }))
    }));
}

const MOCK_AI_CONFIG = `export const AI_LIMITS = { default: { maxConcurrency: 1, minIntervalMs: 400 } };
export const TTS_CONFIG = { baseUrl: '', baseUrlRemote: '', baseUrlLocal: '', use: 'remote', voicesUrl: '', apiKey: '', voices: {} };
export const OCR_CONFIG = { DEFAULT_MODEL: '' };
export const ARTICLE_IMPORT = { FEED_URL: '', PROXY_URL: '', SOURCES: [] };
export const SYNC = {};
export const SUPABASE = {};
`;

function ensureDirs() {
    fs.mkdirSync(SHOTS, { recursive: true });
}

// ───────────────────────── 頁面內量測 ─────────────────────────
const MEASURE = () => {
    const vis = (el) => {
        if (!el) return false;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0.5 && r.height > 0.5;
    };
    const rect = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
            x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1),
            right: +r.right.toFixed(1), bottom: +r.bottom.toFixed(1)
        };
    };
    // 只看實際落在元素框內的行框（line-clamp 之後 Range 仍會回報被裁掉的行）
    const textLines = (el) => {
        if (!el) return 0;
        const box = el.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(el);
        const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0.5 && r.height > 0.5);
        if (!rects.length) return 0;
        const inside = rects.filter((r) => {
            const cy = r.y + r.height / 2;
            return cy >= box.top - 1 && cy <= box.bottom + 1;
        });
        const use = inside.length ? inside : rects;
        return new Set(use.map((r) => Math.round(r.y))).size;
    };
    const css = (el, props) => {
        if (!el) return null;
        const cs = getComputedStyle(el);
        const out = {};
        props.forEach((p) => { out[p] = cs.getPropertyValue(p); });
        return out;
    };
    const overlapArea = (a, b) => {
        if (!a || !b) return 0;
        const w = Math.min(a.right, b.right) - Math.max(a.x, b.x);
        const h = Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y);
        return w > 0.5 && h > 0.5 ? +(w * h).toFixed(1) : 0;
    };
    const inside = (inner, outer, tol = 0.6) => !!inner && !!outer
        && inner.x >= outer.x - tol && inner.right <= outer.right + tol
        && inner.y >= outer.y - tol && inner.bottom <= outer.bottom + tol;

    const q = (s, r = document) => r.querySelector(s);
    const panel = q('#vocab-words-panel');
    const header = panel ? q('.panel-header', panel) : null;
    const titleRow = q('.book-title-row');
    const title = q('#current-book-name');
    const details = q('#book-name-details-btn');
    const more = q('#word-panel-more-btn');
    const actions = panel ? q('.word-panel-actions', panel) : null;
    const meta = q('#current-book-meta');
    const banner = meta ? q('.book-meta-banner', meta) : null;
    const toolbar = panel ? q('.word-toolbar', panel) : null;
    const listBox = panel ? q('.list-container', panel) : null;
    const firstItem = q('#word-list .word-item');
    const menu = q('#word-panel-menu');

    const panelRect = rect(panel);
    const pcs = panel ? getComputedStyle(panel) : null;
    const pad = pcs
        ? { l: parseFloat(pcs.paddingLeft) || 0, r: parseFloat(pcs.paddingRight) || 0 }
        : { l: 0, r: 0 };
    const content = panelRect
        ? { x: +(panelRect.x + pad.l).toFixed(1), right: +(panelRect.right - pad.r).toFixed(1) }
        : null;

    const chipEls = actions ? Array.from(actions.querySelectorAll('.action-chip')) : [];
    const chips = chipEls.map((c) => {
        const r = rect(c);
        const label = c.querySelector('span');
        return {
            id: c.id, visible: vis(c), rect: r, disabled: !!c.disabled,
            label: (c.textContent || '').trim(),
            textLines: label ? textLines(label) : 0,
            ariaLabel: c.getAttribute('aria-label') || '',
            titleAttr: c.getAttribute('title') || ''
        };
    });

    const iconBoxes = Array.from(document.querySelectorAll(
        '#vocab-words-panel .panel-header .icon, #word-panel-menu .icon, #vocab-words-panel .word-actions .icon, #vocab-words-panel .action-chip .icon'
    )).filter(vis).map((el) => {
        const r = el.getBoundingClientRect();
        return {
            cls: typeof el.className === 'string' ? el.className : el.tagName,
            w: +r.width.toFixed(1), h: +r.height.toFixed(1),
            ratio: r.height ? +(r.width / r.height).toFixed(2) : 0
        };
    });

    const headerKids = header ? Array.from(header.children).filter(vis) : [];
    const headerOverlaps = [];
    for (let i = 0; i < headerKids.length; i += 1) {
        for (let j = i + 1; j < headerKids.length; j += 1) {
            const area = overlapArea(rect(headerKids[i]), rect(headerKids[j]));
            if (area > 0) {
                headerOverlaps.push({
                    a: headerKids[i].id || headerKids[i].className,
                    b: headerKids[j].id || headerKids[j].className,
                    area
                });
            }
        }
    }

    const tStyle = title ? getComputedStyle(title) : null;
    const tLineHeight = tStyle ? (parseFloat(tStyle.lineHeight) || (parseFloat(tStyle.fontSize) * 1.5)) : 0;

    const titleInfo = title ? {
        text: title.textContent,
        textLen: (title.textContent || '').length,
        titleAttr: title.getAttribute('title') || '',
        ariaLabel: title.getAttribute('aria-label') || '',
        rect: rect(title),
        lines: textLines(title),
        expectedLinesByHeight: tLineHeight ? Math.round(title.clientHeight / tLineHeight) : 0,
        clientW: title.clientWidth, clientH: title.clientHeight,
        scrollW: title.scrollWidth, scrollH: title.scrollHeight,
        clampedH: title.scrollWidth > title.clientWidth + 1,
        clampedV: title.scrollHeight > title.clientHeight + 1,
        style: css(title, ['font-size', 'line-height', 'overflow', 'text-overflow', 'overflow-wrap', 'word-break', 'display', '-webkit-line-clamp', '-webkit-box-orient', 'flex', 'min-width'])
    } : null;

    const menuItems = menu ? Array.from(menu.querySelectorAll('.menu-item')).map((item) => ({
        label: (item.textContent || '').trim(),
        disabled: !!item.disabled,
        rect: rect(item),
        textLines: textLines(item.querySelector('span') || item),
        role: item.getAttribute('role') || ''
    })) : [];

    const dStyle = details ? getComputedStyle(details) : null;
    const detailsRect = rect(details);

    return {
        viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
        locale: document.documentElement.lang,
        pageScrollable: document.documentElement.scrollHeight > window.innerHeight + 4,
        page: {
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
            bodyScrollWidth: document.body.scrollWidth,
            overflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth)
        },
        activeBookId: (() => { try { return localStorage.getItem('activeBookId') || ''; } catch (_) { return ''; } })(),
        storedBooks: (() => {
            try { return JSON.parse(localStorage.getItem('vocabularyBooks') || '[]').map((b) => ({ id: b.id, name: b.name })); } catch (_) { return null; }
        })(),
        panel: panelRect ? {
            rect: panelRect,
            content,
            scrollWidth: panel.scrollWidth, clientWidth: panel.clientWidth,
            overflowX: Math.max(0, panel.scrollWidth - panel.clientWidth),
            containerName: pcs.getPropertyValue('container-name'),
            containerType: pcs.getPropertyValue('container-type'),
            width: Math.round(panel.getBoundingClientRect().width)
        } : null,
        header: header ? {
            rect: rect(header),
            display: getComputedStyle(header).display,
            gridTemplateColumns: getComputedStyle(header).gridTemplateColumns,
            rows: new Set(headerKids.map((k) => Math.round(k.getBoundingClientRect().y))).size,
            overlaps: headerOverlaps,
            children: headerKids.map((k) => ({
                id: k.id || '', cls: typeof k.className === 'string' ? k.className : '', rect: rect(k)
            }))
        } : null,
        titleRow: titleRow ? { rect: rect(titleRow), gridColumn: getComputedStyle(titleRow).gridColumn } : null,
        title: titleInfo,
        detailsBtn: details ? {
            hiddenAttr: details.hidden,
            visible: vis(details),
            display: dStyle.display,
            rect: detailsRect,
            titleAttr: details.getAttribute('title') || '',
            ariaLabel: details.getAttribute('aria-label') || '',
            ariaHasPopup: details.getAttribute('aria-haspopup') || '',
            square: detailsRect && detailsRect.h ? +(detailsRect.w / detailsRect.h).toFixed(2) : 0
        } : null,
        moreBtn: more ? {
            visible: vis(more),
            display: getComputedStyle(more).display,
            rect: rect(more),
            expanded: more.getAttribute('aria-expanded'),
            titleAttr: more.getAttribute('title') || '',
            ariaLabel: more.getAttribute('aria-label') || ''
        } : null,
        actions: actions ? {
            visible: vis(actions),
            display: getComputedStyle(actions).display,
            rect: rect(actions),
            chips,
            rows: new Set(chips.filter((c) => c.visible).map((c) => Math.round(c.rect.y))).size
        } : null,
        meta: meta ? {
            text: (meta.textContent || '').trim().replace(/\s+/g, ' '),
            rect: rect(meta), visible: vis(meta), banner: rect(banner),
            bannerInfo: banner ? rect(q('.book-meta-info', banner)) : null,
            bannerActions: banner ? rect(q('.book-meta-actions', banner)) : null,
            bannerLink: banner ? rect(q('.book-origin-link', banner)) : null,
            bannerScrollWidth: banner ? banner.scrollWidth : null,
            bannerClientWidth: banner ? banner.clientWidth : null
        } : null,
        toolbar: toolbar ? {
            rect: rect(toolbar),
            input: (() => { const i = q('#word-filter'); return i ? { placeholder: i.placeholder, rect: rect(i) } : null; })(),
            count: (q('#word-filter-count') || {}).textContent || ''
        } : null,
        list: listBox ? { rect: rect(listBox), firstItem: rect(firstItem), items: document.querySelectorAll('#word-list .word-item').length } : null,
        sourceButtons: document.querySelectorAll('#word-list .word-sources-btn').length,
        menu: menu ? {
            open: !menu.hidden,
            rect: rect(menu),
            top: menu.style.top || '',
            items: menuItems,
            role: menu.getAttribute('role') || '',
            insidePanel: inside(rect(menu), panelRect),
            insideViewport: inside(rect(menu), { x: 0, y: 0, right: window.innerWidth, bottom: window.innerHeight }),
            overlapsTitle: overlapArea(rect(menu), rect(title)),
            overlapsMeta: overlapArea(rect(menu), rect(meta)),
            overlapsToolbar: overlapArea(rect(menu), rect(toolbar)),
            overlapsMoreBtn: overlapArea(rect(menu), rect(more))
        } : null,
        icons: iconBoxes
    };
};

const MODAL_MEASURE = () => {
    const rect = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1), right: +r.right.toFixed(1), bottom: +r.bottom.toFixed(1) };
    };
    const modal = document.getElementById('app-modal');
    const content = modal ? modal.querySelector('.modal-content') : null;
    const titleEl = document.getElementById('modal-title');
    const body = document.getElementById('modal-body');
    const full = body ? body.querySelector('.book-name-full') : null;
    const term = body ? body.querySelector('.word-source-term') : null;
    const sources = body ? body.querySelector('.word-sources') : null;
    const nameInput = body ? body.querySelector('#modal-book-name') : null;
    const cs = body ? getComputedStyle(body) : null;
    const tcs = titleEl ? getComputedStyle(titleEl) : null;
    return {
        open: !!modal && !modal.classList.contains('hidden'),
        activeTag: document.activeElement ? (document.activeElement.id || document.activeElement.className || document.activeElement.tagName) : '',
        title: titleEl ? titleEl.textContent : '',
        titleRect: rect(titleEl),
        titleLines: (() => {
            if (!titleEl) return 0;
            const r = document.createRange(); r.selectNodeContents(titleEl);
            return new Set(Array.from(r.getClientRects()).filter((x) => x.height > 0).map((x) => Math.round(x.y))).size;
        })(),
        modalRect: rect(modal),
        contentRect: rect(content),
        bodyRect: rect(body),
        bodyStyle: cs ? { overflowY: cs.overflowY, overflowX: cs.overflowX, maxHeight: cs.maxHeight, overflowWrap: cs.overflowWrap } : null,
        bodyScroll: body ? { scrollWidth: body.scrollWidth, clientWidth: body.clientWidth, scrollHeight: body.scrollHeight, clientHeight: body.clientHeight } : null,
        pageOverflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
        fullName: full ? { text: full.textContent, rect: rect(full), textLines: (() => { const r = document.createRange(); r.selectNodeContents(full); return new Set(Array.from(r.getClientRects()).filter((x) => x.height > 0).map((x) => Math.round(x.y))).size; })() } : null,
        term: term ? { text: term.textContent, rect: rect(term), style: { overflowWrap: getComputedStyle(term).overflowWrap, whiteSpace: getComputedStyle(term).whiteSpace } } : null,
        sources: sources ? { rect: rect(sources), items: sources.querySelectorAll('.word-source').length } : null,
        nameInput: nameInput ? { value: nameInput.value, len: nameInput.value.length, scrollWidth: nameInput.scrollWidth, clientWidth: nameInput.clientWidth, rect: rect(nameInput) } : null,
        titleStyle: tcs ? { overflowWrap: tcs.overflowWrap, height: tcs.height, lineHeight: tcs.lineHeight } : null
    };
};

// ───────────────────────── 瀏覽器 / 頁面 ─────────────────────────
async function newPage(browser, { locale, viewport, books }) {
    const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        locale: locale === 'zh-HK' ? 'zh-HK' : 'zh-CN',
        deviceScaleFactor: 1,
        timezoneId: 'Asia/Hong_Kong',
        colorScheme: 'light'
    });

    const blocked = [];
    await context.route('**/*', (route) => {
        const url = route.request().url();
        let u;
        try { u = new URL(url); } catch (_) { return route.abort(); }
        if (u.pathname.endsWith('/ai-config.js')) {
            return route.fulfill({ status: 200, contentType: 'application/javascript; charset=utf-8', body: MOCK_AI_CONFIG });
        }
        if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return route.continue();
        blocked.push(u.hostname);
        return route.abort();
    });

    await context.addInitScript(({ locale, books }) => {
        try {
            localStorage.clear();
            localStorage.setItem('vocabularyBooks', JSON.stringify(books));
            localStorage.setItem('activeBookId', '');
            localStorage.setItem('vocabImportPromptShown', '1');
            localStorage.setItem('pen_global_settings', JSON.stringify({
                language: { interfaceLocale: locale }
            }));
        } catch (_) { /* 忽略 */ }
    }, { locale, books });

    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (err) => errors.push(`pageerror: ${String(err.message).slice(0, 200)}`));
    page.on('console', (msg) => {
        if (msg.type() === 'error') {
            const text = msg.text();
            if (/net::ERR_|Failed to load resource/i.test(text)) return;
            errors.push(`console: ${text.slice(0, 200)}`);
        }
    });
    return { context, page, errors, blocked };
}

// 新永久層的詞書沒有 sourceUrl（舊資料遷移不再帶入），用官方 API 補上，
// 讓「來源橫幅」在每個案例都存在，才驗得到標題列變高時的下方版面。
async function ensureSourceBanner(page, sourceUrl) {
    try {
        await page.evaluate(async ({ sourceUrl }) => {
            const rs = await import('/modules/reading-store.js');
            const st = await import('/modules/storage.js');
            const books = rs.vocabularyBooksForUi();
            if (!books.length || books.some((b) => b.sourceUrl)) return;
            await rs.syncVocabularyFromMemory(books.map((b) => ({
                ...b, sourceUrl, shareId: b.shareId || 'wb_review_share'
            })), {});
            st.loadVocabularyBooks();
            const v = await import('/features/vocabulary/vocabulary.js');
            v.refreshVocabularyView();
        }, { sourceUrl });
        await page.waitForSelector('#current-book-meta .book-meta-banner', { timeout: 4000 });
    } catch (_) { /* 橫幅缺席不阻斷案例 */ }
    await page.waitForTimeout(120);
}

async function gotoBook(page, bookId, sourceUrl) {
    await page.goto(`${BASE}#v/${encodeURIComponent(bookId)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
        const t = document.getElementById('current-book-name');
        const b = document.getElementById('vocab-words-panel');
        return !!t && !!b && b.getBoundingClientRect().width > 0;
    }, null, { timeout: 15000 });
    // 等 ResizeObserver / 字型就緒後的版面穩定
    await page.waitForTimeout(220);
    await page.waitForFunction((id) => {
        const title = document.getElementById('current-book-name');
        const books = (() => { try { return JSON.parse(localStorage.getItem('vocabularyBooks') || '[]'); } catch (_) { return []; } })();
        const book = books.find((b) => b.id === id);
        return !!book && title && title.textContent === book.name;
    }, bookId, { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(120);
    if (sourceUrl) await ensureSourceBanner(page, sourceUrl);
}

async function shotViewport(page, file) {
    await page.screenshot({ path: file, animations: 'disabled' });
}
async function shotPanel(page, file) {
    const el = await page.$('#vocab-words-panel');
    if (!el) return false;
    await el.screenshot({ path: file, animations: 'disabled' });
    return true;
}
async function shotModal(page, file) {
    const el = await page.$('#app-modal .modal-content');
    if (!el) return false;
    await el.screenshot({ path: file, animations: 'disabled' });
    return true;
}

const rel = (p) => path.relative(ROOT, p);

// ───────────────────────── 判定規則 ─────────────────────────
function judgeVocab(m, ctx) {
    const out = [];
    const add = (severity, code, detail) => out.push({ severity, code, detail, ...ctx });

    const longTitle = ctx.titleKey !== 'short';
    const stored = (m.storedBooks || []).find((b) => b.id === ctx.bookId);
    const origName = stored ? stored.name : null;

    // 1. 名稱不得被改寫
    if (origName !== null && m.title && m.title.text !== origName) {
        add('high', 'title-text-changed', `DOM 標題「${String(m.title.text).slice(0, 40)}」≠ 已儲存名稱「${String(origName).slice(0, 40)}」`);
    }
    if (origName !== null && m.title && m.title.titleAttr !== origName) {
        add('low', 'title-attr-mismatch', `title 屬性與原名不同（attr len=${(m.title.titleAttr || '').length}, name len=${origName.length}）`);
    }

    // 2. 水平溢位
    if (m.page.overflowX > 0) add('high', 'page-overflow-x', `頁面水平溢位 ${m.page.overflowX}px`);
    if (m.panel && m.panel.overflowX > 0) add('medium', 'panel-overflow-x', `面板水平溢位 ${m.panel.overflowX}px`);

    // 3. 標題最多兩行
    if (m.title) {
        if (m.title.lines > 2) add('high', 'title-lines-over-2', `實際可見 ${m.title.lines} 行（上限 2）`);
        if (m.title.style && !String(m.title.style['-webkit-line-clamp']).includes('2')) {
            add('medium', 'title-clamp-missing', `-webkit-line-clamp=${m.title.style['-webkit-line-clamp']}`);
        }
        if (m.title.clampedH) add('high', 'title-horizontal-clip', `標題橫向被裁切 scrollW=${m.title.scrollW} clientW=${m.title.clientW}`);
        if (m.panel && m.title.rect && (m.title.rect.right > m.panel.content.right + 0.6 || m.title.rect.x < m.panel.content.x - 0.6)) {
            add('high', 'title-outside-content', `標題超出面板內容區（title ${m.title.rect.x}~${m.title.rect.right} / content ${m.panel.content.x}~${m.panel.content.right}）`);
        }
    }

    // 4. 截斷時全文可取得；短名稱不應出現入口
    const clamped = !!m.title && (m.title.clampedH || m.title.clampedV);
    const detailsVisible = !!m.detailsBtn && m.detailsBtn.visible;
    if (clamped && !detailsVisible) add('high', 'clamped-no-details-entry', '標題被截斷但 #book-name-details-btn 不可見');
    if (!clamped && detailsVisible) add('medium', 'details-entry-when-not-clamped', '標題未被截斷卻顯示完整名稱入口');
    if (longTitle && !clamped) add('info', 'long-title-not-clamped', `長標題在此寬度未被截斷（lines=${m.title && m.title.lines}）`);

    // 5. 操作入口：chips 或更多選單，只能有一種
    const chipsVisible = !!m.actions && m.actions.visible && m.actions.chips.some((c) => c.visible);
    const moreVisible = !!m.moreBtn && m.moreBtn.visible;
    if (chipsVisible && moreVisible) add('medium', 'both-action-entry', '同時顯示 chips 與更多選單按鈕');
    if (!chipsVisible && !moreVisible) add('high', 'no-action-entry', '五個操作都沒有入口（chips 與更多選單皆不可見）');

    if (chipsVisible) {
        if (m.actions.rows > 1) add('medium', 'chips-wrapped', `chips 排成 ${m.actions.rows} 列（面板寬 ${m.panel ? m.panel.width : '?'}px）`);
        if (m.actions.chips.length !== 5) add('high', 'chips-count', `chips 數量 ${m.actions.chips.length}（應為 5）`);
        for (const c of m.actions.chips.filter((x) => x.visible)) {
            if (m.panel && (c.rect.right > m.panel.content.right + 0.6 || c.rect.x < m.panel.content.x - 0.6)) {
                add('high', 'chip-outside-content', `${c.id} 超出面板內容區（${c.rect.x}~${c.rect.right}）`);
            }
            if (c.textLines > 1) add('medium', 'chip-text-wrapped', `${c.id} 文字換行 ${c.textLines} 行（孤立換行風險）`);
            if (c.rect.h > 52) add('medium', 'chip-height', `${c.id} 高度 ${c.rect.h}px`);
        }
        if (m.moreBtn && m.moreBtn.expanded === 'true') add('low', 'menu-left-open', '桌面 chips 可見時更多選單仍為展開狀態');
        // chips 與橫幅／篩選列重疊
        for (const c of m.actions.chips.filter((x) => x.visible)) {
            if (m.meta && m.meta.visible && m.meta.banner) {
                const a = Math.min(c.rect.right, m.meta.banner.right) - Math.max(c.rect.x, m.meta.banner.x);
                const b = Math.min(c.rect.bottom, m.meta.banner.bottom) - Math.max(c.rect.y, m.meta.banner.y);
                if (a > 0.5 && b > 0.5) add('high', 'chip-overlaps-banner', `${c.id} 與來源橫幅重疊 ${(a * b).toFixed(0)}px²`);
            }
            if (m.toolbar) {
                const a = Math.min(c.rect.right, m.toolbar.rect.right) - Math.max(c.rect.x, m.toolbar.rect.x);
                const b = Math.min(c.rect.bottom, m.toolbar.rect.bottom) - Math.max(c.rect.y, m.toolbar.rect.y);
                if (a > 0.5 && b > 0.5) add('high', 'chip-overlaps-toolbar', `${c.id} 與篩選列重疊 ${(a * b).toFixed(0)}px²`);
            }
        }
    }

    if (moreVisible) {
        if (m.moreBtn.display === 'none') add('high', 'more-btn-invisible-display', '更多選單按鈕被判定可見但 display:none');
        if (m.panel && (m.moreBtn.rect.right > m.panel.content.right + 0.6 || m.moreBtn.rect.x < m.panel.content.x - 0.6)) {
            add('high', 'more-btn-outside-content', `更多按鈕超出面板內容區（${m.moreBtn.rect.x}~${m.moreBtn.rect.right}）`);
        }
        // 與標題重疊
        if (m.title && m.title.rect) {
            const a = Math.min(m.moreBtn.rect.right, m.title.rect.right) - Math.max(m.moreBtn.rect.x, m.title.rect.x);
            const b = Math.min(m.moreBtn.rect.bottom, m.title.rect.bottom) - Math.max(m.moreBtn.rect.y, m.title.rect.y);
            if (a > 0.5 && b > 0.5) add('high', 'more-btn-overlaps-title', `更多按鈕與標題重疊 ${(a * b).toFixed(0)}px²`);
        }
        if (m.title && m.title.rect && m.moreBtn.rect && m.moreBtn.rect.y < m.title.rect.bottom - 1 && m.moreBtn.rect.bottom > m.title.rect.y + 1) {
            // 同一列是預期的，只記錄
        }
        if (!m.moreBtn.ariaLabel) add('low', 'more-btn-no-aria', '更多按鈕缺 aria-label');
    }

    // 6. 標題列獨佔一行（桌面：chips 必須另起一列）
    if (chipsVisible && m.actions && m.titleRow && m.actions.rect.y < m.titleRow.rect.bottom - 1) {
        add('high', 'actions-not-own-row', `chips 與標題同一列（chips.y=${m.actions.rect.y}, titleRow.bottom=${m.titleRow.rect.bottom}）`);
    }

    // 7. 標題列內部重疊
    if (m.header && m.header.overlaps.length) {
        add('high', 'header-child-overlap', m.header.overlaps.map((o) => `${o.a}×${o.b} ${o.area}px²`).join(', '));
    }

    // 8. 圖示變形
    for (const ic of m.icons) {
        if (ic.ratio && Math.abs(ic.ratio - 1) > 0.15 && ic.w > 4 && ic.h > 4) {
            add('medium', 'icon-distorted', `${ic.cls} ${ic.w}×${ic.h}（ratio ${ic.ratio}）`);
        }
    }

    // 9. 來源橫幅／篩選列
    if (m.meta && m.meta.banner && (m.meta.banner.right > (m.panel ? m.panel.content.right + 0.6 : 1e9) || m.meta.banner.x < (m.panel ? m.panel.content.x - 0.6 : -1e9))) {
        add('medium', 'banner-outside-content', `來源橫幅超出面板內容區（${m.meta.banner.x}~${m.meta.banner.right}）`);
    }
    if (m.meta && m.meta.banner) {
        if (m.meta.bannerScrollWidth && m.meta.bannerScrollWidth > m.meta.bannerClientWidth + 1) {
            add('medium', 'banner-overflow-x', `來源橫幅內容水平溢位 ${m.meta.bannerScrollWidth - m.meta.bannerClientWidth}px`);
        }
        if (m.meta.bannerInfo && m.meta.bannerActions) {
            const a = Math.min(m.meta.bannerInfo.right, m.meta.bannerActions.right) - Math.max(m.meta.bannerInfo.x, m.meta.bannerActions.x);
            const b = Math.min(m.meta.bannerInfo.bottom, m.meta.bannerActions.bottom) - Math.max(m.meta.bannerInfo.y, m.meta.bannerActions.y);
            if (a > 0.5 && b > 0.5) add('high', 'banner-inner-overlap', `來源橫幅文字與操作按鈕重疊 ${(a * b).toFixed(0)}px²`);
        }
        if (m.title && m.title.rect && m.meta.banner.y < m.title.rect.bottom - 1) {
            add('high', 'banner-overlaps-title', `來源橫幅壓到標題（banner.y=${m.meta.banner.y} < title.bottom=${m.title.rect.bottom}）`);
        }
    }
    if (m.toolbar && m.panel && (m.toolbar.rect.right > m.panel.content.right + 0.6 || m.toolbar.rect.x < m.panel.content.x - 0.6)) {
        add('medium', 'toolbar-outside-content', `篩選列超出面板內容區（${m.toolbar.rect.x}~${m.toolbar.rect.right}）`);
    }
    if (m.toolbar && m.meta && m.meta.visible && m.meta.banner) {
        const a = Math.min(m.toolbar.rect.right, m.meta.banner.right) - Math.max(m.toolbar.rect.x, m.meta.banner.x);
        const b = Math.min(m.toolbar.rect.bottom, m.meta.banner.bottom) - Math.max(m.toolbar.rect.y, m.meta.banner.y);
        if (a > 0.5 && b > 0.5) add('high', 'toolbar-overlaps-banner', `篩選列與來源橫幅重疊 ${(a * b).toFixed(0)}px²`);
    }

    // 10. 詳情入口的無障礙與尺寸
    if (detailsVisible && m.detailsBtn) {
        if (Math.abs(m.detailsBtn.square - 1) > 0.2) add('low', 'details-btn-distorted', `詳情按鈕 ${m.detailsBtn.rect.w}×${m.detailsBtn.rect.h}`);
        if (m.detailsBtn.rect.w < 28 || m.detailsBtn.rect.h < 28) add('low', 'details-btn-small', `詳情按鈕 ${m.detailsBtn.rect.w}×${m.detailsBtn.rect.h} < 28px`);
        if (!m.detailsBtn.ariaLabel) add('low', 'details-btn-no-aria', '詳情按鈕缺 aria-label');
        if (m.detailsBtn.ariaHasPopup !== 'dialog') add('low', 'details-btn-no-haspopup', `aria-haspopup=${m.detailsBtn.ariaHasPopup}`);
    }

    return out;
}

function judgeMenu(m, ctx) {
    const out = [];
    const add = (severity, code, detail) => out.push({ severity, code, detail, ...ctx });
    if (!m.menu) { add('high', 'menu-missing', '#word-panel-menu 不存在'); return out; }
    if (!m.menu.open) { add('high', 'menu-not-open', '點擊更多後選單未展開'); return out; }
    if (m.menu.role !== 'menu') add('low', 'menu-role', `menu role=${m.menu.role}`);
    if (m.menu.items.length !== 5) add('high', 'menu-item-count', `選單項目 ${m.menu.items.length} 個（應為 5）`);
    const labels = m.menu.items.map((i) => i.label);
    const expectIds = ['complete-missing-btn', 'merge-vocab-books-btn', 'export-vocab-book-btn', 'edit-vocab-book-btn', 'delete-vocab-book-btn'];
    const expectedLabels = (m.actions ? m.actions.chips : []).map((c) => c.label);
    if (expectedLabels.length === 5 && JSON.stringify(labels) !== JSON.stringify(expectedLabels)) {
        add('medium', 'menu-label-mismatch', `選單文案 ${JSON.stringify(labels)} ≠ chips ${JSON.stringify(expectedLabels)}`);
    }
    void expectIds;
    // 位置：不可被標題遮擋
    if (m.menu.overlapsTitle > 0) add('medium', 'menu-overlaps-title', `選單壓住標題 ${m.menu.overlapsTitle}px²（menu.top=${m.menu.top}）`);
    if (m.menu.overlapsMoreBtn > 0) add('high', 'menu-overlaps-more-btn', `選單壓住更多按鈕 ${m.menu.overlapsMoreBtn}px²`);
    if (m.header && m.menu.rect && m.menu.rect.y < m.header.rect.bottom - 1) {
        add('medium', 'menu-overlaps-header', `選單起點 ${m.menu.rect.y} 高於 header 底部 ${m.header.rect.bottom}`);
    }
    if (!m.menu.insidePanel) add('info', 'menu-outside-panel', `選單超出面板（下拉浮層，面板較矮時會伸到面板外；menu ${JSON.stringify(m.menu.rect)} panel ${JSON.stringify(m.panel && m.panel.rect)}）`);
    if (!m.menu.insideViewport) {
        // 超出視窗時，只要頁面可捲動仍可操作；不可捲動才是真的碰不到
        const hard = m.pageScrollable === false;
        add(hard ? 'high' : 'low', 'menu-outside-viewport', `選單超出視窗 ${JSON.stringify(m.menu.rect)}（pageScrollable=${m.pageScrollable}）`);
    }
    // 下拉選單覆蓋下方內容是預期行為，僅記錄
    if (m.menu.overlapsMeta > 0) add('info', 'menu-covers-banner', `選單覆蓋來源橫幅 ${m.menu.overlapsMeta}px²（下拉預期）`);
    if (m.menu.overlapsToolbar > 0) add('info', 'menu-covers-toolbar', `選單覆蓋篩選列 ${m.menu.overlapsToolbar}px²（下拉預期）`);
    for (const item of m.menu.items) {
        if (item.rect.h < 40) add('low', 'menu-item-too-short', `「${item.label}」高度 ${item.rect.h}px < 40px`);
        if (item.textLines > 1) add('medium', 'menu-item-wrapped', `「${item.label}」換行 ${item.textLines} 行`);
    }
    // 禁用狀態鏡射
    const map = { 'completemissing': 0, 'merge': 1, 'export': 2, 'edit': 3, 'delete': 4 };
    void map;
    return out;
}

function summarize(results) {
    const findings = [];
    for (const r of results) {
        for (const f of r.findings || []) findings.push(f);
    }
    const failed = new Set(findings.filter((f) => f.severity !== 'info').map((f) => `${f.stage}|${f.locale}|${f.viewport}|${f.surface || ''}|${f.titleKey || ''}`));
    const byCode = {};
    for (const f of findings) {
        const k = `${f.severity}:${f.code}`;
        byCode[k] = (byCode[k] || 0) + 1;
    }
    return { cases: results.length, findings, failedCases: failed.size, byCode };
}

// ───────────────────────── 階段 ─────────────────────────
async function runVocabStage(browser, results) {
    const books = buildBooks();
    for (const locale of LOCALES) {
        for (const vp of ALL_VIEWPORTS) {
            const { context, page, errors } = await newPage(browser, { locale, viewport: vp, books });
            try {
                for (const title of TITLES) {
                    const bookId = `book-${title.key}`;
                    await gotoBook(page, bookId, BANNER_URL);
                    const m = await page.evaluate(MEASURE);
                    const stem = `vocab_${locale}_${vp.name}_${title.key}`;
                    const ctx = {
                        stage: 'vocab', locale, viewport: vp.name, viewportWidth: vp.width,
                        titleKey: title.key, bookId, surface: 'vocabulary-panel'
                    };
                    const findings = judgeVocab(m, ctx);
                    await shotPanel(page, path.join(SHOTS, `${stem}-panel.png`));
                    const wantViewportShot = findings.some((f) => f.severity !== 'info') || ['1024', '320'].includes(vp.name);
                    if (wantViewportShot) await shotViewport(page, path.join(SHOTS, `${stem}.png`));

                    let menuMeasurement = null;
                    if (m.moreBtn && m.moreBtn.visible) {
                        await page.click('#word-panel-more-btn');
                        await page.waitForTimeout(140);
                        const mm = await page.evaluate(MEASURE);
                        menuMeasurement = mm.menu;
                        findings.push(...judgeMenu(mm, { ...ctx, surface: 'more-menu' }));
                        await shotViewport(page, path.join(SHOTS, `${stem}-menu.png`));
                        await page.keyboard.press('Escape');
                        await page.waitForTimeout(80);
                    }

                    results.push({
                        ...ctx,
                        title: { key: title.key, note: title.note, len: title.name.length },
                        clamped: !!(m.title && (m.title.clampedH || m.title.clampedV)),
                        titleLines: m.title ? m.title.lines : null,
                        entry: m.detailsBtn && m.detailsBtn.visible ? 'details' : 'none',
                        actionsEntry: m.actions && m.actions.visible && m.actions.chips.some((c) => c.visible) ? 'chips' : (m.moreBtn && m.moreBtn.visible ? 'more' : 'none'),
                        panelWidth: m.panel ? m.panel.width : null,
                        measurement: m,
                        menu: menuMeasurement,
                        findings,
                        errors: errors.slice(0, 4),
                        screenshot: rel(path.join(SHOTS, `${stem}-panel.png`)),
                        screenshotViewport: wantViewportShot ? rel(path.join(SHOTS, `${stem}.png`)) : '',
                        screenshotMenu: menuMeasurement ? rel(path.join(SHOTS, `${stem}-menu.png`)) : ''
                    });
                }
            } finally {
                if (errors.length) {
                    results.push({ stage: 'vocab', locale, viewport: vp.name, surface: 'page-errors', findings: errors.map((e) => ({ severity: 'medium', code: 'page-error', detail: e, stage: 'vocab', locale, viewport: vp.name })) });
                }
                await context.close();
            }
        }
    }
}

async function openPanelAction(page, chipId) {
    const chipsVisible = await page.evaluate(() => {
        const a = document.querySelector('.word-panel-actions');
        return !!a && getComputedStyle(a).display !== 'none';
    });
    if (chipsVisible) {
        await page.click(`#${chipId}`);
        return { via: 'chip' };
    }
    await page.click('#word-panel-more-btn');
    await page.waitForTimeout(140);
    const items = await page.evaluate(() => Array.from(document.querySelectorAll('#word-panel-menu .menu-item')).map((i) => (i.textContent || '').trim()));
    const order = ['complete-missing-btn', 'merge-vocab-books-btn', 'export-vocab-book-btn', 'edit-vocab-book-btn', 'delete-vocab-book-btn'];
    const index = order.indexOf(chipId);
    const locator = page.locator('#word-panel-menu .menu-item').nth(index);
    await locator.click();
    await page.waitForTimeout(200);
    return { via: 'menu', index, items };
}

async function runDetailsStage(browser, results) {
    const books = buildBooks();
    for (const locale of LOCALES) {
        for (const vp of ALL_VIEWPORTS) {
            const { context, page, errors } = await newPage(browser, { locale, viewport: vp, books });
            try {
                for (const title of TITLES) {
                    const bookId = `book-${title.key}`;
                    await gotoBook(page, bookId, BANNER_URL);
                    const before = await page.evaluate(MEASURE);
                    const ctx = { stage: 'details', locale, viewport: vp.name, viewportWidth: vp.width, titleKey: title.key, bookId, surface: 'book-name-details' };
                    const findings = [];
                    const add = (severity, code, detail) => findings.push({ severity, code, detail, ...ctx });
                    const visible = !!(before.detailsBtn && before.detailsBtn.visible);
                    const clamped = !!(before.title && (before.title.clampedH || before.title.clampedV));

                    if (!clamped) {
                        if (visible) add('medium', 'details-visible-when-short', '未截斷仍顯示詳情入口');
                        results.push({ ...ctx, skipped: true, clamped, visible, findings });
                        continue;
                    }
                    if (!visible) { add('high', 'details-missing', '已截斷但沒有詳情入口'); results.push({ ...ctx, skipped: true, findings }); continue; }

                    await page.click('#book-name-details-btn');
                    await page.waitForTimeout(220);
                    const modal = await page.evaluate(MODAL_MEASURE);
                    const stem = `details_${locale}_${vp.name}_${title.key}`;
                    await shotModal(page, path.join(SHOTS, `${stem}-modal.png`));
                    await shotViewport(page, path.join(SHOTS, `${stem}.png`));
                    if (!modal.open) add('high', 'details-modal-not-open', '點擊後彈窗未開啟');
                    if (modal.fullName && modal.fullName.text !== title.name) {
                        add('high', 'details-wrong-text', `彈窗全文與原名稱不同（彈窗 ${modal.fullName.text.length} 字 / 原 ${title.name.length} 字）`);
                    }
                    if (!modal.fullName) add('high', 'details-no-fullname', '彈窗內沒有 .book-name-full');
                    if (modal.pageOverflow > 0) add('high', 'details-page-overflow', `彈窗造成頁面水平溢位 ${modal.pageOverflow}px`);
                    if (modal.bodyScroll && modal.bodyScroll.scrollWidth > modal.bodyScroll.clientWidth + 1) {
                        add('medium', 'details-body-overflow-x', `彈窗內文水平溢位 ${modal.bodyScroll.scrollWidth - modal.bodyScroll.clientWidth}px`);
                    }
                    if (modal.fullName && modal.bodyRect && modal.fullName.rect.right > modal.bodyRect.right + 0.6) {
                        add('medium', 'details-fullname-overflow', `全文超出彈窗內文右緣（${modal.fullName.rect.right} > ${modal.bodyRect.right}）`);
                    }
                    // 關閉並檢查焦點返回
                    await page.keyboard.press('Escape');
                    await page.waitForTimeout(180);
                    const after = await page.evaluate(() => ({
                        open: !document.getElementById('app-modal').classList.contains('hidden'),
                        activeId: document.activeElement ? document.activeElement.id : '',
                        bodyEmpty: (document.getElementById('modal-body').children.length === 0)
                    }));
                    if (after.open) add('high', 'details-modal-not-closed', 'Escape 未關閉彈窗');
                    if (after.activeId !== 'book-name-details-btn') add('high', 'details-focus-not-restored', `關閉後焦點在「${after.activeId}」，應回到 book-name-details-btn`);

                    results.push({
                        ...ctx, clamped, visible, modal, afterClose: after, findings,
                        screenshot: rel(path.join(SHOTS, `${stem}-modal.png`)),
                        screenshotViewport: rel(path.join(SHOTS, `${stem}.png`))
                    });
                }
            } finally {
                if (errors.length) {
                    results.push({ stage: 'details', locale, viewport: vp.name, surface: 'page-errors', findings: errors.slice(0, 4).map((e) => ({ severity: 'medium', code: 'page-error', detail: e, stage: 'details', locale, viewport: vp.name })) });
                }
                await context.close();
            }
        }
    }
}

async function runMoreMenuStage(browser, results) {
    const books = buildBooks();
    const vps = ALL_VIEWPORTS;
    for (const locale of LOCALES) {
        for (const vp of vps) {
            const { context, page } = await newPage(browser, { locale, viewport: vp, books });
            try {
                for (const title of TITLES) {
                    const bookId = `book-${title.key}`;
                    await gotoBook(page, bookId, BANNER_URL);
                    const base = await page.evaluate(MEASURE);
                    const ctx = { stage: 'moremenu', locale, viewport: vp.name, viewportWidth: vp.width, titleKey: title.key, bookId, surface: 'more-menu' };
                    const moreVisible = !!(base.moreBtn && base.moreBtn.visible);
                    if (!moreVisible) {
                        results.push({ ...ctx, skipped: true, reason: 'chips 模式（更多按鈕隱藏）', findings: [] });
                        continue;
                    }
                    const findings = [];
                    const add = (severity, code, detail) => findings.push({ severity, code, detail, ...ctx });
                    await page.click('#word-panel-more-btn');
                    await page.waitForTimeout(160);
                    const opened = await page.evaluate(MEASURE);
                    findings.push(...judgeMenu(opened, ctx));
                    // 選單與標題之間的垂直間隙（top 應貼齊 header 底部，不能飄太遠）
                    if (opened.menu && opened.header && opened.menu.rect && opened.menu.rect.y > opened.header.rect.bottom + 24) {
                        findings.push({ severity: 'low', code: 'menu-detached-from-header', detail: `選單起點 ${opened.menu.rect.y} 距 header 底部 ${opened.header.rect.bottom} 超過 24px`, ...ctx });
                    }
                    const stem = `moremenu_${locale}_${vp.name}_${title.key}`;
                    await shotViewport(page, path.join(SHOTS, `${stem}-open.png`));

                    // disabled 狀態鏡射
                    const mirror = await page.evaluate(() => {
                        const chips = Array.from(document.querySelectorAll('.word-panel-actions .action-chip'));
                        const items = Array.from(document.querySelectorAll('#word-panel-menu .menu-item'));
                        return chips.map((c, i) => ({ chip: c.id, chipDisabled: !!c.disabled, itemDisabled: items[i] ? !!items[i].disabled : null }));
                    });
                    mirror.forEach((row) => {
                        if (row.chipDisabled !== row.itemDisabled) add('medium', 'menu-disabled-mirror', `${row.chip}: chip.disabled=${row.chipDisabled} vs menu.disabled=${row.itemDisabled}`);
                    });

                    // 選單項目是否真的接到原按鈕（不改狀態：攔截 sourceBtn.click）
                    const wiring = await page.evaluate(async () => {
                        const order = ['complete-missing-btn', 'merge-vocab-books-btn', 'export-vocab-book-btn', 'edit-vocab-book-btn', 'delete-vocab-book-btn'];
                        const calls = [];
                        const restores = [];
                        order.forEach((id) => {
                            const btn = document.getElementById(id);
                            if (!btn) return;
                            const original = btn.click;
                            btn.click = function patched() { calls.push(id); };
                            restores.push(() => { btn.click = original; });
                        });
                        // 逐一觸發選單項目
                        const items = Array.from(document.querySelectorAll('#word-panel-menu .menu-item'));
                        const results = [];
                        for (let i = 0; i < items.length; i += 1) {
                            const hidden = !document.getElementById('word-panel-menu') || document.getElementById('word-panel-menu').hidden;
                            if (hidden) document.getElementById('word-panel-more-btn').click();
                            await new Promise((r) => setTimeout(r, 60));
                            const item = document.querySelectorAll('#word-panel-menu .menu-item')[i];
                            if (item) item.click();
                            await new Promise((r) => setTimeout(r, 60));
                            results.push({ index: i, expected: order[i], disabled: item ? !!item.disabled : null });
                        }
                        restores.forEach((fn) => fn());
                        return { calls, results };
                    });
                    const expectedCalls = wiring.results.filter((r) => !r.disabled).map((r) => r.expected);
                    if (JSON.stringify(wiring.calls) !== JSON.stringify(expectedCalls)) {
                        add('high', 'menu-wiring-mismatch', `選單觸發 ${JSON.stringify(wiring.calls)}，預期 ${JSON.stringify(expectedCalls)}`);
                    }

                    // Escape 關閉 + 焦點回到更多按鈕
                    await page.evaluate(() => { const m = document.getElementById('word-panel-menu'); if (m && m.hidden) document.getElementById('word-panel-more-btn').click(); });
                    await page.waitForTimeout(120);
                    await page.keyboard.press('Escape');
                    await page.waitForTimeout(160);
                    const closed = await page.evaluate(() => ({
                        hidden: document.getElementById('word-panel-menu').hidden,
                        expanded: document.getElementById('word-panel-more-btn').getAttribute('aria-expanded'),
                        active: document.activeElement ? document.activeElement.id : ''
                    }));
                    if (!closed.hidden) add('high', 'menu-escape-not-closed', 'Escape 未關閉更多選單');
                    if (closed.expanded !== 'false') add('medium', 'menu-aria-expanded', `aria-expanded=${closed.expanded}`);
                    if (closed.active !== 'word-panel-more-btn') add('medium', 'menu-focus-not-restored', `關閉後焦點在「${closed.active}」`);

                    // 外部點擊關閉
                    await page.click('#word-panel-more-btn');
                    await page.waitForTimeout(120);
                    await page.mouse.click(6, 6);
                    await page.waitForTimeout(160);
                    const outside = await page.evaluate(() => document.getElementById('word-panel-menu').hidden);
                    if (!outside) add('medium', 'menu-outside-click', '點擊選單外部未關閉');

                    results.push({
                        ...ctx, menu: opened.menu, mirror, wiring, afterEscape: closed, findings,
                        screenshot: rel(path.join(SHOTS, `${stem}-open.png`))
                    });
                }
            } finally {
                await context.close();
            }
        }
    }
}

async function runEditStage(browser, results) {
    const books = buildBooks();
    const vps = ALL_VIEWPORTS.filter((v) => ['320', '390', '719', '720', '834', '1024', '1440'].includes(v.name));
    for (const locale of LOCALES) {
        for (const vp of vps) {
            const { context, page } = await newPage(browser, { locale, viewport: vp, books });
            try {
                for (const title of TITLES) {
                    const bookId = `book-${title.key}`;
                    await gotoBook(page, bookId);
                    const ctx = { stage: 'edit', locale, viewport: vp.name, viewportWidth: vp.width, titleKey: title.key, bookId, surface: 'edit-book-modal' };
                    const findings = [];
                    const add = (severity, code, detail) => findings.push({ severity, code, detail, ...ctx });
                    const opened = await openPanelAction(page, 'edit-vocab-book-btn');
                    await page.waitForTimeout(260);
                    const modal = await page.evaluate(MODAL_MEASURE);
                    const stem = `edit_${locale}_${vp.name}_${title.key}`;
                    await shotModal(page, path.join(SHOTS, `${stem}-modal.png`));
                    if (!modal.open) add('high', 'edit-modal-not-open', `未開啟編輯彈窗（via ${opened.via}）`);
                    if (modal.nameInput && modal.nameInput.value !== title.name) {
                        add('high', 'edit-input-wrong', `輸入框名稱與原名不同（${modal.nameInput.len} vs ${title.name.length} 字）`);
                    }
                    if (!modal.nameInput) add('high', 'edit-input-missing', '找不到 #modal-book-name');
                    if (modal.title && modal.title.length > 24) add('medium', 'edit-title-long', `彈窗標題「${modal.title}」長度 ${modal.title.length}`);
                    if (modal.titleLines > 2) add('medium', 'edit-title-lines', `彈窗標題 ${modal.titleLines} 行`);
                    if (modal.pageOverflow > 0) add('high', 'edit-page-overflow', `編輯彈窗造成頁面水平溢位 ${modal.pageOverflow}px`);
                    if (modal.bodyScroll && modal.bodyScroll.scrollWidth > modal.bodyScroll.clientWidth + 1) {
                        add('medium', 'edit-body-overflow-x', `編輯彈窗內文水平溢位 ${modal.bodyScroll.scrollWidth - modal.bodyScroll.clientWidth}px`);
                    }
                    if (modal.nameInput && modal.contentRect && modal.nameInput.rect.right > modal.contentRect.right + 0.6) {
                        add('high', 'edit-input-overflow', '名稱輸入框超出彈窗右緣');
                    }
                    await page.keyboard.press('Escape');
                    await page.waitForTimeout(160);
                    const closed = await page.evaluate(() => ({
                        open: !document.getElementById('app-modal').classList.contains('hidden'),
                        active: document.activeElement ? (document.activeElement.id || document.activeElement.className) : ''
                    }));
                    if (closed.open) add('medium', 'edit-not-closed', 'Escape 未關閉編輯彈窗');
                    results.push({ ...ctx, via: opened.via, modal, afterClose: closed, findings, screenshot: rel(path.join(SHOTS, `${stem}-modal.png`)) });
                }
            } finally {
                await context.close();
            }
        }
    }
}

async function runSourcesStage(browser, results) {
    const books = buildBooks();
    const vps = ALL_VIEWPORTS.filter((v) => ['320', '390', '719', '1024', '1280', '1440'].includes(v.name));
    for (const locale of LOCALES) {
        for (const vp of vps) {
            const { context, page } = await newPage(browser, { locale, viewport: vp, books });
            try {
                for (const title of TITLES.filter((t) => ['en-article', 'nospace'].includes(t.key))) {
                    const bookId = `book-${title.key}`;
                    await gotoBook(page, bookId);
                    const ctx = { stage: 'sources', locale, viewport: vp.name, viewportWidth: vp.width, titleKey: title.key, bookId, surface: 'word-sources-modal' };
                    const findings = [];
                    const add = (severity, code, detail) => findings.push({ severity, code, detail, ...ctx });

                    // 第一個長句來源詞（3 條來源），以及無斷點長詞
                    const cases = await page.evaluate(() => Array.from(document.querySelectorAll('#word-list .word-item')).map((li, index) => ({
                        index,
                        word: (li.querySelector('.word-text strong') || {}).textContent || '',
                        hasSourceBtn: !!li.querySelector('.word-sources-btn'),
                        sourceCount: li.querySelector('.word-sources-btn') ? li.querySelector('.word-sources-btn').getAttribute('title') : ''
                    })));
                    for (const c of cases.filter((x) => x.hasSourceBtn)) {
                        const btn = page.locator('#word-list .word-item').nth(c.index).locator('.word-sources-btn');
                        await btn.click();
                        await page.waitForTimeout(240);
                        const modal = await page.evaluate(MODAL_MEASURE);
                        const stem = `sources_${locale}_${vp.name}_${title.key}_w${c.index}`;
                        await shotModal(page, path.join(SHOTS, `${stem}-modal.png`));
                        if (!modal.open) add('high', 'sources-modal-not-open', '來源彈窗未開啟');
                        if (!modal.term) add('high', 'sources-no-term', '找不到 .word-source-term');
                        if (modal.term && modal.term.text !== c.word) {
                            add('medium', 'sources-term-mismatch', `.word-source-term「${String(modal.term.text).slice(0, 24)}」≠ 詞條「${String(c.word).slice(0, 24)}」`);
                        }
                        const isCount = /（\d+）/.test(modal.title) || /\(\d+\)/.test(modal.title);
                        if (!isCount) add('medium', 'sources-title-no-count', `彈窗標題「${modal.title}」不含（n）`);
                        if (modal.title.length > 16) add('medium', 'sources-title-long', `彈窗標題「${modal.title}」長度 ${modal.title.length}`);
                        if (modal.titleLines > 1) add('medium', 'sources-title-wrapped', `彈窗標題換行 ${modal.titleLines} 行`);
                        if (modal.pageOverflow > 0) add('high', 'sources-page-overflow', `來源彈窗造成頁面水平溢位 ${modal.pageOverflow}px`);
                        if (modal.bodyScroll && modal.bodyScroll.scrollWidth > modal.bodyScroll.clientWidth + 1) {
                            add('medium', 'sources-body-overflow-x', `來源彈窗內文水平溢位 ${modal.bodyScroll.scrollWidth - modal.bodyScroll.clientWidth}px`);
                        }
                        if (modal.term && modal.contentRect && modal.term.rect.right > modal.contentRect.right + 0.6) {
                            add('high', 'sources-term-overflow', `長詞超出彈窗右緣（${modal.term.rect.right} > ${modal.contentRect.right}）`);
                        }
                        if (modal.bodyStyle && !/auto|scroll/.test(modal.bodyStyle.overflowY || '')) {
                            add('low', 'sources-body-not-scrollable', `內文 overflow-y=${modal.bodyStyle.overflowY}`);
                        }
                        const scrollable = modal.bodyScroll ? modal.bodyScroll.scrollHeight > modal.bodyScroll.clientHeight : false;
                        await page.keyboard.press('Escape');
                        await page.waitForTimeout(140);
                        results.push({ ...ctx, wordIndex: c.index, word: c.word, modal, scrollable, findings, screenshot: rel(path.join(SHOTS, `${stem}-modal.png`)) });
                    }
                }
            } finally {
                await context.close();
            }
        }
    }
}

async function runLangSwitchStage(browser, results) {
    const books = buildBooks();
    const vps = ALL_VIEWPORTS.filter((v) => ['320', '390', '719', '720', '834', '1024', '1280', '1440'].includes(v.name));
    for (const vp of vps) {
        const { context, page, errors } = await newPage(browser, { locale: 'zh-CN', viewport: vp, books });
        try {
            for (const title of TITLES) {
                const bookId = `book-${title.key}`;
                await gotoBook(page, bookId);
                const before = await page.evaluate(MEASURE);
                const ctx = { stage: 'langswitch', locale: 'zh-CN→zh-HK', viewport: vp.name, viewportWidth: vp.width, titleKey: title.key, bookId, surface: 'locale-switch' };
                const findings = [];
                const add = (severity, code, detail) => findings.push({ severity, code, detail, ...ctx });
                // 開啟更多選單比對文案（若為 chips 模式則量 chips）
                const switchResult = await page.evaluate(async () => {
                    const mod = await import('/modules/i18n.js');
                    const next = mod.setLocale('zh-HK');
                    await new Promise((r) => setTimeout(r, 260));
                    const title = document.getElementById('current-book-name');
                    const details = document.getElementById('book-name-details-btn');
                    const more = document.getElementById('word-panel-more-btn');
                    const menu = document.getElementById('word-panel-menu');
                    const labels = menu ? Array.from(menu.querySelectorAll('.menu-item span[data-i18n]')).map((s) => ({ key: s.dataset.i18n, text: s.textContent })) : [];
                    const chips = Array.from(document.querySelectorAll('.word-panel-actions .action-chip span[data-i18n]')).map((s) => ({ key: s.dataset.i18n, text: s.textContent }));
                    let storedNames = null;
                    try { storedNames = JSON.parse(localStorage.getItem('vocabularyBooks') || '[]').map((b) => b.name); } catch (_) { storedNames = null; }
                    return {
                        next,
                        htmlLang: document.documentElement.lang,
                        titleText: title ? title.textContent : '',
                        titleTitleAttr: title ? (title.getAttribute('title') || '') : '',
                        detailsTitle: details ? (details.getAttribute('title') || '') : '',
                        detailsAria: details ? (details.getAttribute('aria-label') || '') : '',
                        moreAria: more ? (more.getAttribute('aria-label') || '') : '',
                        menuLabels: labels,
                        chipLabels: chips,
                        storedNames
                    };
                });
                const stem = `langswitch_${vp.name}_${title.key}`;
                await shotPanel(page, path.join(SHOTS, `${stem}-panel.png`));

                if (switchResult.next !== 'zh-HK') add('high', 'locale-not-applied', `setLocale 回傳 ${switchResult.next}`);
                if (switchResult.titleText !== title.name) add('high', 'locale-changed-book-name', `切換語言後標題變成「${switchResult.titleText.slice(0, 32)}」，原名「${title.name.slice(0, 32)}」`);
                if (switchResult.titleTitleAttr !== title.name) add('medium', 'locale-changed-title-attr', '切換語言後 title 屬性改變');
                if (switchResult.detailsAria !== '查看完整名稱') add('medium', 'locale-details-aria', `詳情 aria-label「${switchResult.detailsAria}」`);
                if (switchResult.moreAria !== '更多操作') add('low', 'locale-more-aria', `更多 aria-label「${switchResult.moreAria}」`);
                const stored = switchResult.storedNames && switchResult.storedNames.find((n) => n === title.name);
                if (!stored) add('high', 'locale-changed-stored', '切換語言後 localStorage 的名稱被改寫');
                if (switchResult.menuLabels.length && !switchResult.menuLabels.every((l) => l.text === ({
                    'vocabulary.completeMissingShort': '補全資料',
                    'vocabulary.mergeShort': '合併',
                    'vocabulary.exportShort': '匯出',
                    'vocabulary.editShort': '編輯',
                    'vocabulary.deleteShort': '刪除'
                })[l.key])) {
                    add('medium', 'locale-menu-labels', `選單文案未更新：${JSON.stringify(switchResult.menuLabels)}`);
                }
                const after = await page.evaluate(MEASURE);
                const clampedBefore = !!(before.title && (before.title.clampedH || before.title.clampedV));
                const clampedAfter = !!(after.title && (after.title.clampedH || after.title.clampedV));
                if (clampedBefore !== clampedAfter) add('medium', 'locale-clamp-changed', `切換語言後截斷狀態改變 ${clampedBefore}→${clampedAfter}`);
                if (after.title && after.title.lines > 2) add('high', 'locale-title-lines', `切換語言後標題 ${after.title.lines} 行`);
                if (after.page.overflowX > 0) add('high', 'locale-page-overflow', `切換語言後頁面水平溢位 ${after.page.overflowX}px`);

                results.push({
                    ...ctx, switchResult, before: { clamped: clampedBefore, lines: before.title && before.title.lines, titleText: before.title && before.title.text },
                    after: { clamped: clampedAfter, lines: after.title && after.title.lines, titleText: after.title && after.title.text },
                    findings, screenshot: rel(path.join(SHOTS, `${stem}-panel.png`)), errors: errors.slice(0, 3)
                });
                // 還原成 zh-CN，順便驗反向切換（zh-HK → zh-CN）
                const backResult = await page.evaluate(async () => {
                    const mod = await import('/modules/i18n.js');
                    mod.setLocale('zh-CN');
                    await new Promise((r) => setTimeout(r, 220));
                    const title = document.getElementById('current-book-name');
                    const details = document.getElementById('book-name-details-btn');
                    const chips = Array.from(document.querySelectorAll('.word-panel-actions .action-chip span[data-i18n]')).map((x) => x.textContent);
                    let storedNames = null;
                    try { storedNames = JSON.parse(localStorage.getItem('vocabularyBooks') || '[]').map((b) => b.name); } catch (_) { storedNames = null; }
                    return {
                        titleText: title ? title.textContent : '',
                        detailsAria: details ? (details.getAttribute('aria-label') || '') : '',
                        chipLabels: chips,
                        storedNames
                    };
                });
                if (backResult.titleText !== title.name) add('high', 'locale-back-changed-name', '切回簡體後標題被改寫');
                if (backResult.detailsAria !== '查看完整名称') add('medium', 'locale-back-details-aria', `切回簡體後詳情 aria-label「${backResult.detailsAria}」`);
                if (!(backResult.storedNames || []).includes(title.name)) add('high', 'locale-back-stored', '切回簡體後 localStorage 名稱被改寫');
                if (backResult.chipLabels.length && !backResult.chipLabels.includes('合并')) add('medium', 'locale-back-labels', `切回簡體後 chips 文案 ${JSON.stringify(backResult.chipLabels)}`);
                results[results.length - 1].backResult = backResult;
                await page.waitForTimeout(120);
            }
        } finally {
            await context.close();
        }
    }
}


// 極端長名稱／長詞壓力案例
async function runStressStage(browser, results) {
    const hugeName = `${EN_ARTICLE} `.repeat(8).trim();
    const longTerm = 'https://example.com/' + 'a'.repeat(300) + '/term-' + 'b'.repeat(200);
    const books = TITLES.map((title) => ({
        id: `book-${title.key}`,
        name: title.key === 'en-article' ? hugeName : title.name,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        sourceType: 'url',
        sourceUrl: BANNER_URL,
        words: [
            { id: `book-${title.key}-w1`, word: longTerm, meaning: '超長無斷點詞條', phonetic: '', sources: [{ pageTitle: 'A', sourceUrl: 'https://example.com/x', sentence: 's', meaning: 'm', context: '', addedAt: '2026-10-01T10:00:00.000Z' }] },
            ...WORDS.slice(0, 2).map((w, i) => ({ ...JSON.parse(JSON.stringify(w)), id: `book-${title.key}-extra${i}` }))
        ]
    }));
    for (const locale of LOCALES) {
        for (const vp of ALL_VIEWPORTS.filter((v) => ['320', '390', '719', '1024', '1440'].includes(v.name))) {
            const { context, page } = await newPage(browser, { locale, viewport: vp, books });
            try {
                const ctx = { stage: 'stress', locale, viewport: vp.name, viewportWidth: vp.width, titleKey: 'en-article', bookId: 'book-en-article', surface: 'huge-name' };
                await gotoBook(page, 'book-en-article', BANNER_URL);
                const findings = [];
                const add = (severity, code, detail) => findings.push({ severity, code, detail, ...ctx });
                const m = await page.evaluate(MEASURE);
                const storedName = await page.evaluate(() => {
                    try {
                        const books = JSON.parse(localStorage.getItem('vocabularyBooks') || '[]');
                        const b = books.find((x) => x.id === 'book-en-article');
                        return b ? b.name : '';
                    } catch (_) { return ''; }
                });
                const toastText = await page.evaluate(() => {
                    const nodes = Array.from(document.querySelectorAll('[role="alert"], .toast, .message, .notification'));
                    return nodes.map((n) => (n.textContent || '').trim()).filter(Boolean).join(' | ');
                });
                if (/迁移失败|遷移失敗/.test(toastText)) {
                    findings.push({ severity: 'medium', code: 'migration-toast', detail: `出現遷移失敗提示：${toastText.slice(0, 80)}`, ...ctx });
                }
                const stem = `stress_${locale}_${vp.name}`;
                await shotPanel(page, path.join(SHOTS, `${stem}-panel.png`));
                if (m.page.overflowX > 0) add('high', 'stress-page-overflow', `頁面水平溢位 ${m.page.overflowX}px`);
                if (m.title.lines > 2) add('high', 'stress-title-lines', `標題 ${m.title.lines} 行`);
                if (!m.detailsBtn.visible) add('high', 'stress-no-details', '超長名稱沒有完整名稱入口');
                const titleSummary = { lines: m.title.lines, clamped: m.title.clampedH || m.title.clampedV, actions: m.actions.visible ? 'chips' : (m.moreBtn.visible ? 'more' : 'none') };
                await page.click('#book-name-details-btn');
                await page.waitForTimeout(240);
                const modal = await page.evaluate(MODAL_MEASURE);
                await shotModal(page, path.join(SHOTS, `${stem}-details-modal.png`));
                const expectedName = storedName || hugeName;
                if (modal.fullName && modal.fullName.text !== expectedName) {
                    add('high', 'stress-details-text', `彈窗全文（${modal.fullName.text.length} 字）與已存名稱（${expectedName.length} 字）不同`);
                }
                if (hugeName.length > 300 && expectedName.length < hugeName.length) {
                    add('info', 'stress-name-capped', `已存名稱被截到 ${expectedName.length} 字（輸入 ${hugeName.length} 字；reading-protocol maxTitleChars=300）`);
                }
                if (modal.contentRect && modal.contentRect.h > vp.height + 1) add('high', 'stress-modal-taller-than-viewport', `彈窗高度 ${modal.contentRect.h} > 視窗 ${vp.height}`);
                if (modal.pageOverflow > 0) add('high', 'stress-modal-page-overflow', `彈窗造成頁面水平溢位 ${modal.pageOverflow}px`);
                const scrollable = modal.bodyScroll ? modal.bodyScroll.scrollHeight > modal.bodyScroll.clientHeight + 1 : false;
                const clipped = !!(modal.fullName && modal.bodyRect && modal.fullName.rect.bottom > modal.bodyRect.bottom + 1);
                if (clipped && !scrollable) add('high', 'stress-text-clipped', `全文被裁掉且內文不可捲動（fullName.bottom=${modal.fullName.rect.bottom} > body.bottom=${modal.bodyRect.bottom}）`);
                if (clipped && scrollable) add('info', 'stress-text-scrolls', `全文超出內文高度，需在彈窗內捲動（${modal.bodyScroll.scrollHeight} > ${modal.bodyScroll.clientHeight}）`);
                await page.keyboard.press('Escape');
                await page.waitForTimeout(180);
                const afterClose = await page.evaluate(() => ({
                    open: !document.getElementById('app-modal').classList.contains('hidden'),
                    active: document.activeElement ? document.activeElement.id : ''
                }));
                if (afterClose.open) add('high', 'stress-modal-not-closed', '超長名稱彈窗未關閉');
                if (afterClose.active !== 'book-name-details-btn') add('medium', 'stress-focus', `關閉後焦點在「${afterClose.active}」`);

                // 超長詞條來源彈窗
                const srcBtn = page.locator('#word-list .word-item').first().locator('.word-sources-btn');
                await srcBtn.click();
                await page.waitForTimeout(240);
                const srcModal = await page.evaluate(MODAL_MEASURE);
                await shotModal(page, path.join(SHOTS, `${stem}-sources-modal.png`));
                if (!srcModal.term) add('high', 'stress-sources-term-missing', '超長詞條沒有 .word-source-term');
                if (srcModal.pageOverflow > 0) add('high', 'stress-sources-page-overflow', `來源彈窗造成頁面水平溢位 ${srcModal.pageOverflow}px`);
                if (srcModal.term && srcModal.contentRect && srcModal.term.rect.right > srcModal.contentRect.right + 0.6) {
                    add('high', 'stress-sources-term-overflow', '超長詞條超出彈窗內容區');
                }
                if (srcModal.titleLines > 1) add('medium', 'stress-sources-title-lines', `來源彈窗標題 ${srcModal.titleLines} 行`);
                if (srcModal.contentRect && srcModal.contentRect.h > vp.height + 1) add('high', 'stress-sources-taller', `來源彈窗高度 ${srcModal.contentRect.h} > 視窗`);
                const srcScrollable = srcModal.bodyScroll ? srcModal.bodyScroll.scrollHeight > srcModal.bodyScroll.clientHeight + 1 : false;
                const listBottom = srcModal.sources ? srcModal.sources.rect.bottom : (srcModal.term ? srcModal.term.rect.bottom : 0);
                const srcClipped = !!(srcModal.bodyRect && listBottom > srcModal.bodyRect.bottom + 1);
                if (srcClipped && !srcScrollable) add('high', 'stress-sources-clipped', '來源內容被裁掉且不可捲動');
                if (srcClipped && srcScrollable) add('info', 'stress-sources-scrolls', `來源內容需在彈窗內捲動（${srcModal.bodyScroll.scrollHeight} > ${srcModal.bodyScroll.clientHeight}）`);
                await page.keyboard.press('Escape');
                await page.waitForTimeout(140);
                results.push({ ...ctx, titleSummary, modal, afterClose, sourceModal: srcModal, findings,
                    screenshot: rel(path.join(SHOTS, `${stem}-panel.png`)) });
            } finally {
                await context.close();
            }
        }
    }
}

// 執行中改變視窗大小：container query + ResizeObserver 是否即時切換
async function runResizeStage(browser, results) {
    const books = buildBooks();
    for (const locale of LOCALES) {
        const { context, page } = await newPage(browser, { locale, viewport: { width: 1440, height: 900 }, books });
        try {
            await gotoBook(page, 'book-en-article', BANNER_URL);
            const steps = [1440, 1024, 834, 720, 719, 390, 320, 834, 1280, 1440];
            let previousMenuOpen = false;
            for (const width of steps) {
                await page.setViewportSize({ width, height: width < 720 ? 720 : 900 });
                await page.waitForTimeout(260);
                if (previousMenuOpen) {
                    const menuLeft = await page.evaluate(() => document.getElementById('word-panel-menu').hidden);
                    if (!menuLeft) {
                        results.push({ stage: 'resize', locale, viewport: String(width), surface: 'resize', findings: [{ severity: 'medium', code: 'menu-left-open-after-resize', detail: `視窗改為 ${width}px 後更多選單仍開著`, stage: 'resize', locale, viewport: String(width) }] });
                    }
                    previousMenuOpen = false;
                }
                const m = await page.evaluate(MEASURE);
                const ctx = { stage: 'resize', locale, viewport: String(width), surface: 'resize' };
                const findings = judgeVocab(m, { ...ctx, titleKey: 'en-article', bookId: 'book-en-article' });
                const entry = m.actions.visible && m.actions.chips.some((c) => c.visible) ? 'chips' : (m.moreBtn.visible ? 'more' : 'none');
                // 切換後的入口必須與面板寬度一致：< 480（container query）或視窗 <= 719 時應為 more
                const expectMore = width <= 719 || (m.panel && m.panel.width <= 480);
                if (entry === 'chips' && expectMore) findings.push({ severity: 'high', code: 'resize-entry-stale', detail: `面板寬 ${m.panel && m.panel.width}px、視窗 ${width}px 仍顯示 chips（應為更多選單）`, ...ctx });
                if (entry === 'more' && !expectMore) findings.push({ severity: 'high', code: 'resize-entry-stale', detail: `面板寬 ${m.panel && m.panel.width}px、視窗 ${width}px 卻只給更多選單`, ...ctx });
                if (entry === 'more') {
                    await page.click('#word-panel-more-btn');
                    await page.waitForTimeout(160);
                    const mm = await page.evaluate(MEASURE);
                    findings.push(...judgeMenu(mm, { ...ctx, titleKey: 'en-article' }));
                    await page.keyboard.press('Escape');
                    await page.waitForTimeout(80);
                }
                results.push({ ...ctx, entry, panelWidth: m.panel && m.panel.width, titleLines: m.title && m.title.lines, findings });
            }

            // 選單開著時放大視窗：按鈕被 CSS 隱藏後必須自動收合，不能殘留浮層
            await page.setViewportSize({ width: 320, height: 720 });
            await page.waitForTimeout(260);
            await page.click('#word-panel-more-btn');
            await page.waitForTimeout(200);
            const openBefore = await page.evaluate(() => !document.getElementById('word-panel-menu').hidden);
            await page.setViewportSize({ width: 1280, height: 900 });
            await page.waitForTimeout(320);
            const afterResize = await page.evaluate(() => ({
                hidden: document.getElementById('word-panel-menu').hidden,
                expanded: document.getElementById('word-panel-more-btn').getAttribute('aria-expanded'),
                moreDisplay: getComputedStyle(document.getElementById('word-panel-more-btn')).display
            }));
            const resizeFindings = [];
            if (!openBefore) resizeFindings.push({ severity: 'high', code: 'resize-menu-not-opened', detail: '320px 開更多選單失敗' });
            if (!afterResize.hidden) resizeFindings.push({ severity: 'medium', code: 'menu-left-open-after-resize', detail: '選單開著時放大到 1280px，浮層仍殘留' });
            if (afterResize.expanded === 'true') resizeFindings.push({ severity: 'low', code: 'aria-expanded-stale', detail: '放大後 aria-expanded 仍是 true' });
            await shotViewport(page, path.join(SHOTS, `resize_${locale}_menu-after-resize.png`));
            results.push({ stage: 'resize', locale, viewport: '320→1280', surface: 'resize-menu', openBefore, afterResize, findings: resizeFindings.map((f) => ({ ...f, stage: 'resize', locale, viewport: '320→1280' })) });
        } finally {
            await context.close();
        }
    }
}


// 空狀態：沒有任何詞書時不應出現完整名稱入口，「更多」選單的五個操作必須全部停用
async function runEmptyStage(browser, results) {
    for (const locale of LOCALES) {
        for (const vp of ALL_VIEWPORTS.filter((v) => ['320', '390', '719', '1024', '1440'].includes(v.name))) {
            const { context, page, errors } = await newPage(browser, { locale, viewport: vp, books: [] });
            try {
                await page.goto(`${BASE}#v`, { waitUntil: 'domcontentloaded' });
                await page.waitForFunction(() => !!document.getElementById('current-book-name'), null, { timeout: 15000 });
                await page.waitForTimeout(400);
                const ctx = { stage: 'empty', locale, viewport: vp.name, surface: 'empty-state' };
                const findings = [];
                const add = (severity, code, detail) => findings.push({ severity, code, detail, ...ctx });
                const m = await page.evaluate(MEASURE);
                const stem = `empty_${locale}_${vp.name}`;
                await shotPanel(page, path.join(SHOTS, `${stem}-panel.png`));
                if (m.page.overflowX > 0) add('high', 'empty-page-overflow', `頁面水平溢位 ${m.page.overflowX}px`);
                if (m.detailsBtn && m.detailsBtn.visible) add('medium', 'empty-details-visible', '沒有選取詞書卻顯示完整名稱入口');
                if (m.title && m.title.text !== '') {
                    const expect = locale === 'zh-HK' ? '請選擇一個生字簿' : '请选择一个单词本';
                    if (m.title.text !== expect) add('low', 'empty-title-placeholder', `空狀態標題「${m.title.text}」（預期「${expect}」）`);
                }
                if (m.title && m.title.lines > 2) add('medium', 'empty-title-lines', `空狀態標題 ${m.title.lines} 行`);
                const entry = m.actions.visible && m.actions.chips.some((c) => c.visible) ? 'chips' : (m.moreBtn.visible ? 'more' : 'none');
                if (entry === 'none') add('high', 'empty-no-entry', '空狀態沒有操作入口');
                let menu = null;
                if (entry === 'more') {
                    await page.click('#word-panel-more-btn');
                    await page.waitForTimeout(180);
                    const mm = await page.evaluate(MEASURE);
                    menu = mm.menu;
                    findings.push(...judgeMenu(mm, ctx));
                    const enabledItems = menu ? (menu.items || []).filter((i) => !i.disabled).map((i) => i.label) : [];
                    const enabledChips = (m.actions.chips || []).filter((c) => !c.disabled).map((c) => c.label);
                    if (JSON.stringify(enabledItems) !== JSON.stringify(enabledChips)) {
                        add('medium', 'empty-menu-enabled-mismatch', `選單可用項目 ${JSON.stringify(enabledItems)} ≠ chips ${JSON.stringify(enabledChips)}`);
                    } else if (enabledItems.length) {
                        add('info', 'empty-merge-still-enabled', `空狀態仍有可用操作：${enabledItems.join('、')}（與 chips 一致，屬既有行為）`);
                    }
                    await shotViewport(page, path.join(SHOTS, `${stem}-menu.png`));
                    await page.keyboard.press('Escape');
                }
                results.push({
                    ...ctx, entry, menu, findings, screenshot: rel(path.join(SHOTS, `${stem}-panel.png`)),
                    measurement: { titleText: m.title && m.title.text, titleLines: m.title && m.title.lines, detailsVisible: !!(m.detailsBtn && m.detailsBtn.visible), chips: (m.actions.chips || []).map((c) => ({ id: c.id, disabled: c.disabled })) }
                });
            } finally {
                if (errors.length) {
                    results.push({ stage: 'empty', locale, viewport: vp.name, surface: 'page-errors', findings: errors.slice(0, 4).map((e) => ({ severity: 'medium', code: 'page-error', detail: e, stage: 'empty', locale, viewport: vp.name })) });
                }
                await context.close();
            }
        }
    }
}


// 首次載入時入口是否閃現：每次都開新 document（帶 query 參數），
// 從第一個 rAF 開始記錄詳情圖示的顯示狀態。
async function runFlashStage(browser, results) {
    const books = buildBooks();
    for (const locale of LOCALES) {
        for (const vp of ALL_VIEWPORTS.filter((v) => ['320', '720', '1024', '1440'].includes(v.name))) {
            for (const title of TITLES) {
                const bookId = `book-${title.key}`;
                const { context, page, errors } = await newPage(browser, { locale, viewport: vp, books });
                try {
                    await context.addInitScript(() => {
                        window.__flash = [];
                        const start = performance.now();
                        const tick = () => {
                            const btn = document.getElementById('book-name-details-btn');
                            const title = document.getElementById('current-book-name');
                            if (btn && title) {
                                const cs = getComputedStyle(title);
                                window.__flash.push({
                                    t: Math.round(performance.now() - start),
                                    hidden: btn.hidden,
                                    display: getComputedStyle(btn).display,
                                    cw: title.clientWidth, sw: title.scrollWidth,
                                    ch: title.clientHeight, sh: title.scrollHeight,
                                    lines: Math.round(title.clientHeight / (parseFloat(cs.lineHeight) || 24)),
                                    text: (title.textContent || '').slice(0, 12),
                                    fonts: document.fonts ? document.fonts.status : ''
                                });
                            }
                            if (performance.now() - start < 1600) requestAnimationFrame(tick);
                        };
                        requestAnimationFrame(tick);
                    });
                    // 每個案例都是獨立 context，第一次 goto 就是新 document；
                    // 不可加 query 參數：main.js 會把未知 query 當成模組別名，深連結就不套用了。
                    await page.goto(`${BASE}#v/${encodeURIComponent(bookId)}`, { waitUntil: 'load' });
                    await page.waitForTimeout(1700);
                    const flash = await page.evaluate(() => window.__flash || []);
                    const m = await page.evaluate(MEASURE);
                    const ctx = { stage: 'flash', locale, viewport: vp.name, surface: 'details-entry-timing' };
                    const findings = [];
                    const clamped = !!(m.title && (m.title.clampedH || m.title.clampedV));
                    const visibleFrames = flash.filter((x) => !x.hidden && x.display !== 'none');
                    const finalVisible = !!(m.detailsBtn && m.detailsBtn.visible);
                    const firstVisible = visibleFrames.length ? visibleFrames[0].t : null;
                    if (!clamped && visibleFrames.length) {
                        findings.push({ severity: 'low', code: 'entry-flash-when-not-clamped', detail: `未被截斷（${title.key}）卻在第 ${firstVisible}ms 起顯示完整名稱圖示，共 ${visibleFrames.length} 幀（下一幀自行隱藏）`, ...ctx });
                    }
                    if (clamped && !finalVisible) {
                        findings.push({ severity: 'high', code: 'entry-missing-after-load', detail: '載入完成後被截斷卻沒有完整名稱圖示', ...ctx });
                    }
                    if (clamped && finalVisible && firstVisible !== null && firstVisible > 600) {
                        findings.push({ severity: 'low', code: 'entry-appears-late', detail: `完整名稱圖示到 ${firstVisible}ms 才出現`, ...ctx });
                    }
                    const transitions = [];
                    let prevKey = null;
                    for (const f of flash) {
                        const key = `${f.hidden}/${f.display}`;
                        if (key !== prevKey) { transitions.push(f); prevKey = key; }
                    }
                    results.push({
                        ...ctx, titleKey: title.key, clamped, finalVisible, frames: flash.length, firstVisible, transitions,
                        flashHead: flash.slice(0, 6), findings, errors: errors.slice(0, 3),
                        debug: {
                            titleText: m.title && m.title.text,
                            titleLen: m.title && m.title.textLen,
                            clientW: m.title && m.title.clientW, scrollW: m.title && m.title.scrollW,
                            clientH: m.title && m.title.clientH, scrollH: m.title && m.title.scrollH,
                            lines: m.title && m.title.lines,
                            panelWidth: m.panel && m.panel.width,
                            activeBookId: m.activeBookId,
                            hash: await page.evaluate(() => location.hash)
                        }
                    });
                } finally {
                    await context.close();
                }
            }
        }
    }
}

// ───────────────────────── 主流程 ─────────────────────────
(async () => {
    ensureDirs();
    const browser = await chromium.launch({
        headless: true,
        executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
        args: ['--disable-lcd-text', '--font-render-hinting=none']
    });
    const results = [];
    const startedAt = new Date().toISOString();
    const dump = (tag) => {
        try {
            fs.writeFileSync(path.join(OUT_ROOT, `v2-${STAGE}${tag ? '-' + tag : ''}.json`), JSON.stringify({ label: 'v2-review', stage: STAGE, timestamp: TS, partialAfter: tag || '', startedAt, results, summary: summarize(results) }, null, 1));
        } catch (_) { /* 忽略 */ }
    };
    const stages = STAGE === 'all' ? ['vocab', 'details', 'moremenu', 'edit', 'sources', 'langswitch', 'stress', 'resize', 'empty', 'flash'] : STAGE.split(',');
    try {
        for (const stage of stages) {
            if (stage === 'vocab') await runVocabStage(browser, results);
            else if (stage === 'details') await runDetailsStage(browser, results);
            else if (stage === 'moremenu') await runMoreMenuStage(browser, results);
            else if (stage === 'edit') await runEditStage(browser, results);
            else if (stage === 'sources') await runSourcesStage(browser, results);
            else if (stage === 'langswitch') await runLangSwitchStage(browser, results);
            else if (stage === 'stress') await runStressStage(browser, results);
            else if (stage === 'resize') await runResizeStage(browser, results);
            else if (stage === 'empty') await runEmptyStage(browser, results);
            else if (stage === 'flash') await runFlashStage(browser, results);
            dump(stage);
            console.log(`[done] ${stage} cumulative cases=${results.length}`);
        }
    } finally {
        await browser.close();
    }
    const summary = summarize(results);
    const payload = {
        label: 'v2-review', stage: STAGE, timestamp: TS, startedAt, finishedAt: new Date().toISOString(),
        base: BASE, assetVersion: '3f68c9359755',
        summary: { ...summary, failedCases: summary.failedCases },
        results
    };
    fs.writeFileSync(path.join(OUT_ROOT, `v2-${STAGE}.json`), JSON.stringify(payload, null, 1));
    console.log(`TS=${TS}`);
    console.log(`OUT=${OUT_ROOT}`);
    console.log(`cases=${summary.cases} findings=${summary.findings.length} failedCases=${summary.failedCases}`);
    for (const [code, n] of Object.entries(summary.byCode).sort()) console.log(`  ${code}: ${n}`);
    const bad = summary.findings.filter((f) => f.severity !== 'info');
    bad.slice(0, 40).forEach((f) => console.log(`  [${f.severity}] ${f.stage}/${f.surface} ${f.locale}@${f.viewport}/${f.titleKey || ''} ${f.code}: ${String(f.detail).slice(0, 160)}`));
})().catch((err) => { console.error(err); process.exit(1); });
