#!/usr/bin/env node
/**
 * 長標題 UI 巡檢（詞書面板標題＋來源橫幅＋詞書彈窗＋其他長標題畫面）
 *
 * 目的：確認長標題在手機／平板／桌面斷點下不會造成 UI 錯位、變形、遮擋或溢位，
 * 且被視覺截斷時全文仍可取得（title / aria）。
 *
 * 用法：
 *   PORT=8313 PLAYWRIGHT_MODULE=<playwright> node tests/long-title-ui-audit.cjs --label=v0-baseline
 *   ... --stage=vocab|shell|all （預設 all）
 *   ... --viewports=320,390,719,720,834,1024,1280,1440
 *   ... --titles=en-article,zh-long,nospace,short
 *
 * 輸出：
 *   docs/report/assets/long-title/<label>-<stage>.json
 *   docs/report/assets/long-title/<label>/<...>.png （詞書面板與關鍵畫面）
 *
 * 只讀取工作區檔案；不寫入任何正式程式碼，不動使用者登入態（獨立 context、封鎖外站）。
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
const STAGE = arg('stage', 'all');
const VIEWPORT_FILTER = arg('viewports', '').split(',').filter(Boolean).map(Number);
const TITLE_FILTER = arg('titles', '').split(',').filter(Boolean);

const ALL_VIEWPORTS = [
    { name: '320-phone', width: 320, height: 720 },
    { name: '390-phone', width: 390, height: 844 },
    { name: '719-breakpoint-below', width: 719, height: 900 },
    { name: '720-breakpoint', width: 720, height: 900 },
    { name: '834-tablet', width: 834, height: 1112 },
    { name: '900-sidebar-2col', width: 900, height: 900 },
    { name: '960-sidebar-2col', width: 960, height: 900 },
    { name: '1024-tablet-land', width: 1024, height: 900 },
    { name: '1080-narrow-2col', width: 1080, height: 900 },
    { name: '1280-laptop', width: 1280, height: 900 },
    { name: '1440-desktop', width: 1440, height: 900 }
];
const VIEWPORTS = VIEWPORT_FILTER.length
    ? ALL_VIEWPORTS.filter((v) => VIEWPORT_FILTER.includes(v.width))
    : ALL_VIEWPORTS;

// 使用者截圖中的真實資料：整段文章被當成詞書名稱
const EN_ARTICLE = "Mike: Some volunteers help sell flags in the street. There are some other volunteers who help online. I'm one of them. Last month, I filmed a video to encourage people to donate money and posted it online. Although it took time, it was meaningful.";
const ZH_LONG = '香港中學文憑試英文科第三單元：環境保護與社區服務義工活動完整閱讀理解練習題目與答案詳解（第二部分）';
const NO_SPACE = 'https://www.example.com/learning/articles/2026/11/very-long-path-without-any-break-opportunity-abcdefghijklmnopqrstuvwxyz0123456789?token=abcdef0123456789';
const SHORT = '5A Unit 1 单词本';

const TITLES = [
    { key: 'en-article', name: EN_ARTICLE, note: '使用者截圖原樣（整段英文文章）' },
    { key: 'zh-long', name: ZH_LONG, note: '超長中文' },
    { key: 'nospace', name: NO_SPACE, note: '無空格長英文／網址' },
    { key: 'short', name: SHORT, note: '普通短標題（對照組）' }
].filter((t) => !TITLE_FILTER.length || TITLE_FILTER.includes(t.key));

const WORDS = [
    { id: 'w1', word: 'volunteer', meaning: '志愿者', phonetic: 'ˌvɒlənˈtɪə', sources: [{ title: '文章段落 2', text: 'Some volunteers help sell flags in the street.' }] },
    { id: 'w2', word: 'meaningful', meaning: '有意义的', phonetic: 'ˈmiːnɪŋfl', sources: [] },
    { id: 'w3', word: 'encourage', meaning: '鼓励', phonetic: 'ɪnˈkʌrɪdʒ', sources: [] }
];

function buildBooks() {
    return TITLES.map((title, index) => ({
        id: `book-${title.key}`,
        name: title.name,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        sourceType: 'url',
        sourceUrl: index === 0 ? NO_SPACE : '',
        shareId: `wb_test_${title.key}`,
        words: WORDS.map((w) => ({ ...w }))
    }));
}

function ensureDirs() {
    fs.mkdirSync(OUT_ROOT, { recursive: true });
    fs.mkdirSync(path.join(OUT_ROOT, LABEL), { recursive: true });
}

// ── 量測：在頁面內量所有需要的幾何與文字狀態 ────────────────────────────────
const MEASURE_FN = () => {
    const visible = (el) => {
        if (!el) return false;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    };
    const rect = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
            x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1),
            right: +r.right.toFixed(1), bottom: +r.bottom.toFixed(1)
        };
    };
    // 只算「實際看得到的行」：line-clamp / overflow:hidden 之後，
    // Range 仍會回報被裁掉的行框，直接用會把 2 行誤判成 12 行。
    const lineCount = (el) => {
        if (!el) return 0;
        const box = el.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(el);
        const rects = Array.from(range.getClientRects()).filter((r) => r.height > 0);
        if (!rects.length) return 0;
        const visible = rects.filter((r) => {
            const centerY = r.y + r.height / 2;
            return centerY >= box.top - 1 && centerY <= box.bottom + 1;
        });
        const ys = new Set((visible.length ? visible : rects).map((r) => Math.round(r.y)));
        return ys.size;
    };
    const styleOf = (el, props) => {
        if (!el) return null;
        const cs = getComputedStyle(el);
        const out = {};
        props.forEach((p) => { out[p] = cs[p] ?? cs.getPropertyValue(p); });
        return out;
    };
    const overlap = (a, b) => {
        if (!a || !b) return 0;
        const w = Math.min(a.right, b.right) - Math.max(a.x, b.x);
        const h = Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y);
        return w > 0.5 && h > 0.5 ? +(w * h).toFixed(1) : 0;
    };

    const panel = document.querySelector('#vocab-words-panel');
    const header = panel ? panel.querySelector('.panel-header') : null;
    const title = document.getElementById('current-book-name');
    const actions = panel ? panel.querySelector('.word-panel-actions') : null;
    const moreBtn = document.getElementById('word-panel-more-btn');
    const meta = document.getElementById('current-book-meta');
    const toolbar = panel ? panel.querySelector('.word-toolbar') : null;
    const list = panel ? panel.querySelector('.list-container') : null;
    const banner = meta ? meta.querySelector('.book-meta-banner') : null;
    const chips = actions ? Array.from(actions.querySelectorAll('.action-chip')).map((c) => ({
        id: c.id, visible: visible(c), rect: rect(c), disabled: !!c.disabled,
        text: (c.textContent || '').trim()
    })) : [];

    // 標題列內的可見子元素兩兩重疊
    const headerKids = header ? Array.from(header.children).filter(visible) : [];
    const overlaps = [];
    for (let i = 0; i < headerKids.length; i += 1) {
        for (let j = i + 1; j < headerKids.length; j += 1) {
            const area = overlap(rect(headerKids[i]), rect(headerKids[j]));
            if (area > 0) {
                overlaps.push({
                    a: headerKids[i].id || headerKids[i].className,
                    b: headerKids[j].id || headerKids[j].className,
                    area
                });
            }
        }
    }

    const panelRect = rect(panel);
    const panelStyle = panel ? getComputedStyle(panel) : null;
    const contentRight = panelRect
        ? panelRect.right - parseFloat(panelStyle.paddingRight || '0')
        : 0;
    const contentLeft = panelRect
        ? panelRect.x + parseFloat(panelStyle.paddingLeft || '0')
        : 0;

    // chips 是否被擠出面板內容區
    const chipsOut = chips.filter((c) => c.visible && c.rect && panelRect
        && (c.rect.right > contentRight + 0.5 || c.rect.x < contentLeft - 0.5
            || c.rect.right > window.innerWidth + 0.5));

    // chips 排成幾列（桌面應維持一列）
    const chipRows = (() => {
        const ys = chips.filter((c) => c.visible).map((c) => Math.round(c.rect.y));
        return new Set(ys).size;
    })();

    // 圖示是否變形（寬高比）
    const iconBoxes = Array.from(document.querySelectorAll(
        '.vocab-words-panel .panel-header .icon, .vocab-words-panel .word-actions .icon, .vocab-words-panel .word-sources-btn, .vocab-words-panel .play-btn'
    )).filter(visible).map((el) => {
        const r = el.getBoundingClientRect();
        return {
            cls: el.className && typeof el.className === 'string' ? el.className : el.tagName,
            w: +r.width.toFixed(1), h: +r.height.toFixed(1),
            ratio: r.height ? +(r.width / r.height).toFixed(2) : 0
        };
    });

    const firstRow = document.querySelector('#word-list .word-item');
    const listStyle = list ? getComputedStyle(list) : null;

    return {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        page: {
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
            overflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth)
        },
        panel: panelRect ? {
            rect: panelRect,
            scrollWidth: panel.scrollWidth,
            clientWidth: panel.clientWidth,
            overflowX: Math.max(0, panel.scrollWidth - panel.clientWidth),
            contentLeft: +contentLeft.toFixed(1),
            contentRight: +contentRight.toFixed(1)
        } : null,
        header: header ? {
            rect: rect(header),
            rows: lineCount(header),
            flexWrap: getComputedStyle(header).flexWrap,
            alignItems: getComputedStyle(header).alignItems,
            gap: getComputedStyle(header).gap
        } : null,
        title: title ? {
            text: title.textContent,
            textLen: (title.textContent || '').length,
            rect: rect(title),
            lines: lineCount(title),
            fullText: title.textContent === title.dataset.expectedText,
            titleAttr: title.getAttribute('title') || '',
            ariaLabel: title.getAttribute('aria-label') || '',
            scrollWidth: title.scrollWidth,
            clientWidth: title.clientWidth,
            scrollHeight: title.scrollHeight,
            clientHeight: title.clientHeight,
            clipsHorizontally: title.scrollWidth > title.clientWidth + 1,
            clipsVertically: title.scrollHeight > title.clientHeight + 1,
            style: styleOf(title, ['fontSize', 'lineHeight', 'whiteSpace', 'overflow', 'textOverflow', 'overflowWrap', 'wordBreak', 'display', 'webkitLineClamp', 'maxHeight', 'flex', 'flexBasis', 'minWidth', 'position'])
        } : null,
        moreBtn: moreBtn ? { visible: visible(moreBtn), rect: rect(moreBtn) } : null,
        detailsBtn: (() => {
            const btn = document.getElementById('book-name-details-btn');
            if (!btn) return null;
            return {
                hidden: btn.hidden,
                visible: visible(btn),
                rect: rect(btn),
                titleAttr: btn.getAttribute('title') || '',
                ariaLabel: btn.getAttribute('aria-label') || '',
                ratio: (() => { const r = btn.getBoundingClientRect(); return r.height ? +(r.width / r.height).toFixed(2) : 0; })()
            };
        })(),
        actions: actions ? { visible: visible(actions), rect: rect(actions), rowCount: chipRows } : null,
        chips,
        chipsOutOfPanel: chipsOut.map((c) => ({ id: c.id, rect: c.rect })),
        headerOverlaps: overlaps,
        banner: banner ? { rect: rect(banner), text: (banner.textContent || '').trim().slice(0, 120), scrollWidth: banner.scrollWidth, clientWidth: banner.clientWidth } : null,
        meta: meta ? { rect: rect(meta), text: (meta.textContent || '').trim().slice(0, 80), scrollWidth: meta.scrollWidth, clientWidth: meta.clientWidth } : null,
        toolbar: toolbar ? { rect: rect(toolbar), scrollWidth: toolbar.scrollWidth, clientWidth: toolbar.clientWidth } : null,
        list: list ? {
            rect: rect(list), overflowY: listStyle.overflowY,
            scrollWidth: list.scrollWidth, clientWidth: list.clientWidth,
            overflowX: Math.max(0, list.scrollWidth - list.clientWidth),
            firstRow: firstRow ? rect(firstRow) : null
        } : null,
        wordIcons: iconBoxes,
        sourcesBtn: (() => {
            const btn = document.querySelector('.word-sources-btn');
            if (!btn) return null;
            const r = rect(btn);
            const cs = getComputedStyle(btn);
            return { visible: visible(btn), rect: r, borderRadius: cs.borderRadius, ratio: r.h ? +(r.w / r.h).toFixed(2) : 0 };
        })()
    };
};

function evaluateCase(measurement, title) {
    const findings = [];
    const m = measurement;
    if (!m.panel) {
        findings.push({ severity: 'blocker', code: 'panel-missing', detail: '#vocab-words-panel 不存在' });
        return findings;
    }
    if (m.page.overflowX > 1) {
        findings.push({ severity: 'high', code: 'page-overflow-x', detail: `頁面水平溢位 ${m.page.overflowX}px` });
    }
    if (m.panel.overflowX > 1) {
        findings.push({ severity: 'high', code: 'panel-overflow-x', detail: `面板水平溢位 ${m.panel.overflowX}px` });
    }
    if (m.headerOverlaps.length) {
        findings.push({ severity: 'high', code: 'header-overlap', detail: JSON.stringify(m.headerOverlaps) });
    }
    if (m.chipsOutOfPanel.length) {
        findings.push({ severity: 'high', code: 'chips-outside-panel', detail: JSON.stringify(m.chipsOutOfPanel) });
    }
    if (m.title && m.title.text !== title.name) {
        findings.push({ severity: 'blocker', code: 'title-text-changed', detail: `標題被改寫：${m.title.text.slice(0, 60)}` });
    }
    if (m.title && (m.title.clipsHorizontally || m.title.clipsVertically)) {
        const retrievable = m.title.titleAttr === title.name || m.title.ariaLabel === title.name;
        findings.push({
            severity: retrievable ? 'info' : 'high',
            code: retrievable ? 'title-clamped-with-fallback' : 'title-clamped-no-fallback',
            detail: `clamp h=${m.title.clipsHorizontally} v=${m.title.clipsVertically}, lines=${m.title.lines}, title=「${m.title.titleAttr.slice(0, 40)}」`
        });
    }
    if (m.title && !m.title.clipsHorizontally && !m.title.clipsVertically
        && m.title.titleAttr && m.title.titleAttr !== title.name) {
        findings.push({ severity: 'low', code: 'title-attr-stale', detail: `title 屬性與名稱不一致：${m.title.titleAttr.slice(0, 40)}` });
    }
    // 桌面／平板：標題不應被壓成多行而與 chips 爭寬
    if (m.viewport.width >= 720 && m.title) {
        if (m.title.rect.w < 160) {
            findings.push({ severity: 'high', code: 'title-too-narrow', detail: `標題寬 ${m.title.rect.w}px（<160）` });
        }
        if (m.title.lines > 2) {
            findings.push({ severity: 'medium', code: 'title-many-lines-desktop', detail: `桌面標題 ${m.title.lines} 行，高 ${m.title.rect.h}px` });
        }
        if (m.actions && m.actions.visible && m.actions.rowCount > 1) {
            findings.push({ severity: 'medium', code: 'chips-wrapped-desktop', detail: `chips 排成 ${m.actions.rowCount} 列` });
        }
    }
    // 手機：標題不得超過 2 行（否則把清單推走）
    if (m.viewport.width < 720 && m.title && m.title.lines > 2) {
        findings.push({ severity: 'medium', code: 'title-many-lines-mobile', detail: `手機標題 ${m.title.lines} 行，高 ${m.title.rect.h}px` });
    }
    // 視覺截斷時必須另有「取得全文」的路徑（title 屬性、aria 或詳情按鈕）
    if (m.title && (m.title.clipsVertically || m.title.clipsHorizontally || m.title.lines > 2)) {
        const hasFallback = m.title.titleAttr === title.name || m.title.ariaLabel === title.name;
        const hasDetails = !!(m.detailsBtn && m.detailsBtn.visible);
        if (!hasFallback && !hasDetails) {
            findings.push({ severity: 'high', code: 'no-full-name-path', detail: `截斷但無 title/詳情：lines=${m.title.lines}` });
        }
        if (!hasDetails) {
            findings.push({ severity: 'medium', code: 'details-btn-hidden-when-clamped', detail: `lines=${m.title.lines} hidden=${m.detailsBtn ? m.detailsBtn.hidden : 'noEl'}` });
        }
    }
    if (m.detailsBtn && m.detailsBtn.visible && m.title && !m.title.clipsVertically && !m.title.clipsHorizontally) {
        findings.push({ severity: 'low', code: 'details-btn-shown-when-fits', detail: '未截斷仍顯示詳情按鈕' });
    }
    if (m.detailsBtn && m.detailsBtn.visible && !m.detailsBtn.titleAttr) {
        findings.push({ severity: 'low', code: 'details-btn-no-label', detail: '詳情按鈕缺 title／aria-label' });
    }

    // 操作區模式：手機斷點或面板被雙欄壓窄時，chips 應收進「更多」選單。
    // 容器查詢量的是內容盒（扣掉 padding），門檻必須用同一個寬度比較。
    const panelW = m.panel.rect.w;
    const panelContentW = +(m.panel.contentRight - m.panel.contentLeft).toFixed(1);
    const menuMode = m.viewport.width < 720 || panelContentW <= 480.5;
    const visibleChips = m.chips.filter((c) => c.visible).length;
    if (!menuMode) {
        if (visibleChips !== m.chips.length || visibleChips < 5) {
            findings.push({ severity: 'high', code: 'chips-missing-desktop', detail: `面板 ${panelW}px（內容 ${panelContentW}px）下可見 chip ${visibleChips}/${m.chips.length}` });
        }
        if (m.moreBtn && m.moreBtn.visible) {
            findings.push({ severity: 'low', code: 'more-btn-shown-desktop', detail: '未收合模式仍顯示「更多」按鈕' });
        }
        if (m.actions && m.actions.visible && m.actions.rowCount > 1) {
            findings.push({ severity: 'medium', code: 'chips-wrapped', detail: `面板 ${panelW}px（內容 ${panelContentW}px）：chips 排成 ${m.actions.rowCount} 列` });
        }
    } else {
        if (m.actions && m.actions.visible) {
            findings.push({ severity: 'medium', code: 'chips-shown-in-menu-mode', detail: `面板 ${panelW}px（menuMode）仍顯示 5 顆 chip` });
        }
        if (m.moreBtn && !m.moreBtn.visible) {
            findings.push({ severity: 'high', code: 'more-btn-missing', detail: `面板 ${panelW}px（menuMode）沒有「更多」按鈕` });
        }
    }
    const distorted = m.wordIcons.filter((i) => i.ratio && (i.ratio < 0.75 || i.ratio > 1.34));
    if (distorted.length) {
        findings.push({ severity: 'medium', code: 'icon-distorted', detail: JSON.stringify(distorted.slice(0, 4)) });
    }
    if (m.sourcesBtn && m.sourcesBtn.visible && (m.sourcesBtn.ratio < 0.9 || m.sourcesBtn.ratio > 1.11)) {
        findings.push({ severity: 'medium', code: 'sources-btn-not-round', detail: `ratio=${m.sourcesBtn.ratio}` });
    }
    if (m.list && m.list.overflowX > 1) {
        findings.push({ severity: 'high', code: 'word-list-overflow-x', detail: `${m.list.overflowX}px` });
    }
    if (m.banner && m.banner.scrollWidth > m.banner.clientWidth + 1) {
        findings.push({ severity: 'medium', code: 'banner-overflow', detail: `banner ${m.banner.scrollWidth} > ${m.banner.clientWidth}` });
    }
    if (m.banner && m.toolbar && m.banner.rect.bottom > m.toolbar.rect.y + 1) {
        findings.push({ severity: 'medium', code: 'banner-overlaps-toolbar', detail: `banner.bottom=${m.banner.rect.bottom} toolbar.y=${m.toolbar.rect.y}` });
    }
    if (m.toolbar && m.list && m.toolbar.rect.bottom > m.list.rect.y + 1) {
        findings.push({ severity: 'medium', code: 'toolbar-overlaps-list', detail: `toolbar.bottom=${m.toolbar.rect.bottom} list.y=${m.list.rect.y}` });
    }
    return findings;
}

// ── 建立頁面 ────────────────────────────────────────────────────────────────
async function newPage(browser, { locale, books }) {
    const context = await browser.newContext({
        viewport: VIEWPORTS[0],
        locale: locale === 'zh-HK' ? 'zh-HK' : 'zh-CN',
        acceptDownloads: false,
        serviceWorkers: 'block'
    });
    // 只允許本機；外站（TTS／同步／AI）一律 abort，避免碰真實服務與登入態
    await context.route('**/*', (route) => {
        let host = '';
        try { host = new URL(route.request().url()).hostname; } catch (_) { return route.abort(); }
        return (host === '127.0.0.1' || host === 'localhost') ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message ? e.message : e).slice(0, 300)));
    page.on('console', (m) => {
        const text = m.text();
        if (m.type() === 'error' && !/Failed to load resource|ERR_FAILED|i18n: missing/.test(text)) {
            errors.push(text.slice(0, 300));
        }
    });
    await page.addInitScript(({ locale, books }) => {
        try {
            if (sessionStorage.getItem('__lt_seeded') === '1') return;
            sessionStorage.setItem('__lt_seeded', '1');
            localStorage.clear();
            localStorage.setItem('vocabularyBooks', JSON.stringify(books));
            localStorage.setItem('activeBookId', books[0] ? books[0].id : '');
            localStorage.setItem('vocabImportPromptShown', '1');
            localStorage.setItem('pen_global_settings', JSON.stringify({
                language: { interfaceLocale: locale },
                assistant: { enabled: false }
            }));
            const synth = window.speechSynthesis;
            if (synth) {
                let timer;
                synth.speak = (u) => { u.onstart && u.onstart(); timer = setTimeout(() => u.onend && u.onend(), 20); };
                synth.cancel = () => clearTimeout(timer);
                synth.getVoices = () => [];
            }
        } catch (_) {}
    }, { locale, books });
    return { context, page, errors };
}

async function selectBook(page, bookId) {
    await page.evaluate((id) => {
        const item = document.querySelector(`.vocab-book-item[data-book-id="${id}"]`);
        if (item) item.click();
    }, bookId);
    await page.waitForTimeout(120);
}

async function measureCase(page, title) {
    await page.evaluate((expected) => {
        const el = document.getElementById('current-book-name');
        if (el) el.dataset.expectedText = expected;
    }, title.name);
    const raw = await page.evaluate(MEASURE_FN);
    return { raw, findings: evaluateCase(raw, title) };
}

async function runVocabStage(browser, results) {
    const books = buildBooks();
    for (const locale of ['zh-CN', 'zh-HK']) {
        for (const vp of VIEWPORTS) {
            const { context, page, errors } = await newPage(browser, { locale, books });
            await page.setViewportSize({ width: vp.width, height: vp.height });
            await page.goto(`${BASE}#v`, { waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(1500);
            for (const title of TITLES) {
                await selectBook(page, `book-${title.key}`);
                const { raw, findings } = await measureCase(page, title);
                const shot = path.join(OUT_ROOT, LABEL, `vocab_${locale}_${vp.name}_${title.key}.png`);
                const clip = raw.panel ? {
                    x: Math.max(0, raw.panel.rect.x - 2),
                    y: Math.max(0, raw.panel.rect.y - 2),
                    width: Math.min(raw.panel.rect.w + 4, vp.width),
                    height: Math.min(Math.max(raw.panel.rect.h + 4, 120), vp.height)
                } : null;
                if (clip && clip.width > 10 && clip.height > 10) {
                    await page.screenshot({ path: shot, clip }).catch(() => {});
                }
                results.push({
                    stage: 'vocab', locale, viewport: vp, title: { key: title.key, note: title.note, len: title.name.length },
                    measurement: raw, findings,
                    screenshot: path.relative(ROOT, shot)
                });
            }
            if (errors.length) {
                results.push({ stage: 'vocab', locale, viewport: vp, pageErrors: errors.slice(0, 6) });
            }
            await context.close();
        }
    }
}

// 手機「更多操作」選單仍可用（不可被標題擠壞）
async function runMoreMenuStage(browser, results) {
    const books = buildBooks();
    for (const locale of ['zh-CN', 'zh-HK']) {
        for (const width of [320, 720 - 1, 900, 1024, 1080]) {
            const { context, page } = await newPage(browser, { locale, books });
            await page.setViewportSize({ width, height: 900 });
            await page.goto(`${BASE}#v`, { waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(1500);
            await selectBook(page, 'book-en-article');
            const before = await page.evaluate(() => {
                const btn = document.getElementById('word-panel-more-btn');
                const cs = btn ? getComputedStyle(btn) : null;
                return { visible: !!btn && cs.display !== 'none', rect: btn ? btn.getBoundingClientRect().toJSON() : null };
            });
            if (!before.visible) {
                await context.close();
                continue;
            }
            await page.evaluate(() => document.getElementById('word-panel-more-btn')?.click());
            await page.waitForTimeout(150);
            const menu = await page.evaluate(() => {
                const el = document.getElementById('word-panel-menu');
                if (!el || el.hidden) return { open: false };
                const r = el.getBoundingClientRect();
                return {
                    open: true,
                    rect: { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1), right: +r.right.toFixed(1), bottom: +r.bottom.toFixed(1) },
                    items: el.querySelectorAll('.menu-item').length,
                    insideViewport: r.right <= window.innerWidth + 0.5 && r.x >= -0.5 && r.bottom <= window.innerHeight + 0.5
                };
            });
            const shot = path.join(OUT_ROOT, LABEL, `moremenu_${locale}_${width}.png`);
            await page.screenshot({ path: shot }).catch(() => {});
            results.push({
                stage: 'moremenu', locale, viewport: { name: `${width}px`, width, height: 900 },
                moreButton: before, menu,
                findings: [
                    ...(before.visible ? [] : [{ severity: 'high', code: 'more-btn-hidden', detail: `${width}px 看不到更多操作按鈕` }]),
                    ...(menu.open ? [] : [{ severity: 'blocker', code: 'more-menu-not-open', detail: '點擊後選單未開啟' }]),
                    ...(menu.open && !menu.insideViewport ? [{ severity: 'high', code: 'more-menu-outside-viewport', detail: JSON.stringify(menu.rect) }] : []),
                    ...(menu.open && menu.items !== 5 ? [{ severity: 'medium', code: 'more-menu-item-count', detail: String(menu.items) }] : [])
                ],
                screenshot: path.relative(ROOT, shot)
            });
            await context.close();
        }
    }
}

// 詞書編輯彈窗（長名稱在 modal 內是否溢位／壓壞按鈕）
async function runModalStage(browser, results) {
    const books = buildBooks();
    for (const locale of ['zh-CN', 'zh-HK']) {
        for (const vp of VIEWPORTS.filter((v) => [320, 390, 834, 1280].includes(v.width))) {
            const { context, page } = await newPage(browser, { locale, books });
            await page.setViewportSize({ width: vp.width, height: vp.height });
            await page.goto(`${BASE}#v`, { waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(1500);
            await selectBook(page, 'book-en-article');

            // (1) 詳情按鈕 → 完整名稱彈窗
            const details = await page.evaluate(() => {
                const btn = document.getElementById('book-name-details-btn');
                if (!btn || btn.hidden) return { available: false };
                btn.click();
                return { available: true };
            });
            await page.waitForTimeout(350);
            const fullName = await page.evaluate(() => {
                const m = document.getElementById('app-modal');
                if (!m || m.classList.contains('hidden')) return { open: false };
                const body = document.getElementById('modal-body');
                const node = body ? (body.querySelector('.book-name-full') || body) : null;
                const r = node ? node.getBoundingClientRect() : null;
                return {
                    open: true,
                    modalTitle: (document.getElementById('modal-title')?.textContent || '').trim(),
                    text: node ? (node.textContent || '') : '',
                    rect: r ? { w: +r.width.toFixed(1), h: +r.height.toFixed(1), right: +r.right.toFixed(1) } : null,
                    overflowX: node ? Math.max(0, node.scrollWidth - node.clientWidth) : 0,
                    docOverflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
                    wrap: node ? getComputedStyle(node).overflowWrap : ''
                };
            });
            const shotFull = path.join(OUT_ROOT, LABEL, `fullname_${locale}_${vp.name}.png`);
            if (fullName.open) await page.screenshot({ path: shotFull }).catch(() => {});
            const fullFindings = [];
            if (!details.available) fullFindings.push({ severity: 'high', code: 'details-btn-unavailable', detail: '長標題未提供詳情按鈕' });
            else if (!fullName.open) fullFindings.push({ severity: 'blocker', code: 'details-modal-not-open', detail: '點擊詳情未開彈窗' });
            else {
                if (fullName.text !== EN_ARTICLE) fullFindings.push({ severity: 'blocker', code: 'full-name-text-mismatch', detail: `len=${fullName.text.length}` });
                if (fullName.overflowX > 1) fullFindings.push({ severity: 'high', code: 'full-name-overflow', detail: String(fullName.overflowX) });
                if (fullName.docOverflowX > 1) fullFindings.push({ severity: 'high', code: 'full-name-page-overflow', detail: String(fullName.docOverflowX) });
            }
            results.push({
                stage: 'fullname', locale, viewport: vp, details, fullName, findings: fullFindings,
                screenshot: fullName.open ? path.relative(ROOT, shotFull) : ''
            });
            // 關閉彈窗（Escape）
            await page.keyboard.press('Escape').catch(() => {});
            await page.waitForTimeout(250);

            await page.evaluate(() => document.getElementById('edit-vocab-book-btn')?.click());
            await page.waitForTimeout(400);
            const modal = await page.evaluate(() => {
                const m = document.getElementById('app-modal');
                if (!m || m.classList.contains('hidden')) return { open: false };
                const card = m.querySelector('.modal-card, .modal-content, .modal') || m.firstElementChild;
                const r = card ? card.getBoundingClientRect() : null;
                const titleEl = document.getElementById('modal-title');
                const inputs = Array.from(m.querySelectorAll('input, textarea')).map((el) => {
                    const ir = el.getBoundingClientRect();
                    return { tag: el.tagName, value: (el.value || '').slice(0, 60), w: +ir.width.toFixed(1), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
                });
                return {
                    open: true,
                    cardRect: r ? { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1), right: +r.right.toFixed(1), bottom: +r.bottom.toFixed(1) } : null,
                    title: titleEl ? (titleEl.textContent || '').trim() : '',
                    docOverflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
                    inputs,
                    insideViewport: r ? (r.x >= -0.5 && r.right <= window.innerWidth + 0.5 && r.y >= -0.5 && r.bottom <= window.innerHeight + 0.5) : false
                };
            });
            const shot = path.join(OUT_ROOT, LABEL, `modal-edit_${locale}_${vp.name}.png`);
            if (modal.open) await page.screenshot({ path: shot }).catch(() => {});
            const findings = [];
            if (!modal.open) findings.push({ severity: 'blocker', code: 'edit-modal-not-open', detail: '點擊編輯未開彈窗' });
            else {
                if (!modal.insideViewport) findings.push({ severity: 'high', code: 'modal-outside-viewport', detail: JSON.stringify(modal.cardRect) });
                if (modal.docOverflowX > 1) findings.push({ severity: 'high', code: 'modal-page-overflow-x', detail: String(modal.docOverflowX) });
                const clipped = modal.inputs.filter((i) => i.scrollWidth > i.clientWidth + 1);
                if (clipped.length) findings.push({ severity: 'info', code: 'modal-input-scroll', detail: JSON.stringify(clipped.slice(0, 2)) });
            }
            results.push({ stage: 'modal-edit', locale, viewport: vp, modal, findings, screenshot: modal.open ? path.relative(ROOT, shot) : '' });
            await context.close();
        }
    }
}

// 其他長標題畫面（文章列表／文章閱讀／QA）：以使用者可見標題字串檢查是否溢位
async function runShellStage(browser, results) {
    const books = buildBooks();
    const surfaces = [
        { id: 'article', hash: '#a', label: '文章閱讀' },
        { id: 'qa', hash: '#qa', label: 'QA 模組' }
    ];
    for (const locale of ['zh-CN', 'zh-HK']) {
        for (const vp of VIEWPORTS.filter((v) => [320, 390, 834, 1280, 1440].includes(v.width))) {
            const { context, page } = await newPage(browser, { locale, books });
            await page.setViewportSize({ width: vp.width, height: vp.height });
            for (const surface of surfaces) {
                await page.goto(`${BASE}${surface.hash}`, { waitUntil: 'domcontentloaded' });
                await page.waitForTimeout(1200);
                const info = await page.evaluate(() => {
                    const overflowX = Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth);
                    // 找出超寬／超高的可見標題元素：h1-h4、標題類 class
                    const sel = 'h1, h2, h3, .card-title, .article-title, .qa-set-title, .page-head h2';
                    const heads = Array.from(document.querySelectorAll(sel)).filter((el) => {
                        const cs = getComputedStyle(el);
                        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
                        const r = el.getBoundingClientRect();
                        return r.width > 0 && r.height > 0;
                    }).map((el) => {
                        const r = el.getBoundingClientRect();
                        return {
                            tag: el.tagName,
                            text: (el.textContent || '').trim().slice(0, 50),
                            w: +r.width.toFixed(1),
                            h: +r.height.toFixed(1),
                            scrollWidth: el.scrollWidth,
                            clientWidth: el.clientWidth,
                            right: +r.right.toFixed(1),
                            clipsX: el.scrollWidth > el.clientWidth + 1,
                            outsideViewport: r.right > window.innerWidth + 1 || r.x < -1
                        };
                    });
                    return { overflowX, heads };
                });
                const offenders = info.heads.filter((h) => h.outsideViewport || h.clipsX);
                const findings = [];
                if (info.overflowX > 1) findings.push({ severity: 'high', code: 'shell-page-overflow-x', detail: `${surface.label} 水平溢位 ${info.overflowX}px` });
                offenders.forEach((h) => findings.push({
                    severity: 'medium', code: 'heading-overflow',
                    detail: `${h.tag}「${h.text}」clip=${h.clipsX} outside=${h.outsideViewport} w=${h.w}`
                }));
                const shot = path.join(OUT_ROOT, LABEL, `shell-${surface.id}_${locale}_${vp.name}.png`);
                await page.screenshot({ path: shot }).catch(() => {});
                results.push({ stage: 'shell', surface: surface.id, surfaceLabel: surface.label, locale, viewport: vp, info, findings, screenshot: path.relative(ROOT, shot) });
            }
            await context.close();
        }
    }
}

function summarize(results) {
    const perStage = {};
    results.forEach((r) => {
        if (!r.findings) return;
        const key = r.stage;
        perStage[key] = perStage[key] || { cases: 0, failed: 0, severities: {} };
        perStage[key].cases += 1;
        const blocking = r.findings.filter((f) => f.severity !== 'info');
        if (blocking.length) perStage[key].failed += 1;
        r.findings.forEach((f) => {
            perStage[key].severities[f.severity] = (perStage[key].severities[f.severity] || 0) + 1;
        });
    });
    const allFindings = results.flatMap((r) => (r.findings || []).map((f) => ({
        stage: r.stage, surface: r.surface || '', locale: r.locale,
        viewport: r.viewport ? r.viewport.name || r.viewport.width : '', ...f,
        screenshot: r.screenshot || ''
    })));
    return { perStage, findings: allFindings };
}

(async () => {
    ensureDirs();
    const launchOpts = { headless: true };
    if (fs.existsSync(CHROME)) launchOpts.executablePath = CHROME;
    const browser = await chromium.launch(launchOpts);
    const results = [];
    const startedLabel = new Date().toISOString();
    try {
        if (STAGE === 'all' || STAGE === 'vocab') await runVocabStage(browser, results);
        if (STAGE === 'all' || STAGE === 'moremenu') await runMoreMenuStage(browser, results);
        if (STAGE === 'all' || STAGE === 'modal') await runModalStage(browser, results);
        if (STAGE === 'all' || STAGE === 'shell') await runShellStage(browser, results);
    } finally {
        await browser.close();
    }
    const summary = summarize(results);
    const payload = { label: LABEL, stage: STAGE, startedAt: startedLabel, finishedAt: new Date().toISOString(), summary, results };
    const jsonPath = path.join(OUT_ROOT, `${LABEL}-${STAGE}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
    console.log(`\n== ${LABEL} / ${STAGE} ==`);
    Object.entries(summary.perStage).forEach(([stage, s]) => {
        console.log(`${stage}: ${s.cases} cases, ${s.failed} with findings, ${JSON.stringify(s.severities)}`);
    });
    const blocking = summary.findings.filter((f) => f.severity !== 'info');
    console.log(`blocking findings: ${blocking.length}`);
    blocking.slice(0, 40).forEach((f) => {
        console.log(`  [${f.severity}] ${f.stage}/${f.surface ? f.surface + '/' : ''}${f.locale}@${f.viewport} ${f.code}: ${f.detail.slice(0, 180)}`);
    });
    console.log(`json: ${path.relative(ROOT, jsonPath)}`);
})();
