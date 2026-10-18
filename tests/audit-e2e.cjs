/**
 * BDC 全站端到端巡檢 — 第一階段：啟動、導覽、雙語、響應式。
 *
 * 用法：
 *   node tests/audit-e2e.cjs [--port 8313] [--only bootstrap,nav] [--headed]
 *
 * 產出：docs/report/<timestamp>_全站功能巡檢報告.md 的資料（JSON 中間檔在 docs/report/root-audit/）
 */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8313);
const BASE = `http://127.0.0.1:${PORT}/`;
const ROOT = path.resolve(__dirname, '..');
const ASSETS = path.join(ROOT, 'docs', 'report', 'root-audit');
fs.mkdirSync(ASSETS, { recursive: true });

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const findings = [];
const log = [];
function record(area, severity, title, detail) {
    findings.push({ area, severity, title, detail });
    console.log(`[${severity}] ${area} :: ${title}${detail ? ' -- ' + String(detail).slice(0, 300) : ''}`);
}
function note(msg) { log.push(msg); console.log(msg); }

const VIEWPORTS = {
    desktop: { width: 1440, height: 900 },
    tablet: { width: 834, height: 1112 },
    mobile: { width: 390, height: 844 }
};

const SAMPLE_BOOKS = [{
    id: 'audit-book',
    name: '巡檢詞書',
    createdAt: new Date('2026-01-01').toISOString(),
    updatedAt: new Date('2026-01-01').toISOString(),
    words: [
        { id: 'w1', word: 'apple', meaning: '苹果', phonetic: 'ˈæpl' },
        { id: 'w2', word: 'notebook', meaning: '笔记本', phonetic: 'ˈnəʊtbʊk' },
        { id: 'w3', word: 'running', meaning: '跑步', phonetic: 'ˈrʌnɪŋ' },
        { id: 'w4', word: 'beautiful', meaning: '美丽的', phonetic: 'ˈbjuːtɪfl' },
        { id: 'w5', word: 'environment', meaning: '环境', phonetic: 'ɪnˈvaɪrənmənt' }
    ]
}];

function makeCollector(page) {
    const c = { consoleErrors: [], pageErrors: [], requestFailed: [], i18nMissing: [], unhandled: [], dialog: [] };
    page.on('console', (m) => {
        const text = m.text();
        if (m.type() === 'error') c.consoleErrors.push(text);
        if (/i18n: missing translation key/.test(text)) c.i18nMissing.push(text);
        if (m.type() === 'warning' && /i18n: missing/.test(text)) c.i18nMissing.push(text);
    });
    page.on('pageerror', (e) => c.pageErrors.push(String(e && e.stack ? e.stack.split('\n')[0] : e)));
    page.on('requestfailed', (r) => {
        const url = r.url();
        if (url.startsWith('data:')) return;
        c.requestFailed.push(`${url} :: ${r.failure() ? r.failure().errorText : '?'}`);
    });
    page.on('dialog', async (d) => {
        c.dialog.push(`${d.type()}: ${d.message()}`);
        await d.dismiss().catch(() => {});
    });
    return c;
}

async function seed(page, { locale = 'zh-CN', books = SAMPLE_BOOKS, extra = {} } = {}) {
    await page.addInitScript(({ locale, books, extra }) => {
        try {
            localStorage.clear();
            localStorage.setItem('vocabularyBooks', JSON.stringify(books));
            localStorage.setItem('activeBookId', books[0] ? books[0].id : '');
            localStorage.setItem('vocabImportPromptShown', '1');
            localStorage.setItem('pen_global_settings', JSON.stringify(Object.assign({
                language: { interfaceLocale: locale },
                assistant: { enabled: false }
            }, extra)));
            let timer;
            const synth = window.speechSynthesis;
            if (synth) {
                synth.speak = (u) => { u.onstart && u.onstart(); timer = setTimeout(() => u.onend && u.onend(), 40); };
                synth.cancel = () => clearTimeout(timer);
            }
        } catch (_) {}
    }, { locale, books, extra });
}

function blockExternal(context) {
    return context.route('**/*', (route) => {
        let host = '';
        try { host = new URL(route.request().url()).hostname; } catch (_) { return route.abort(); }
        if (host === '127.0.0.1' || host === 'localhost') return route.continue();
        return route.abort();
    });
}

async function newPage(browser, { viewport = 'desktop', locale = 'zh-CN', books = SAMPLE_BOOKS, extra } = {}) {
    const context = await browser.newContext({ viewport: VIEWPORTS[viewport], locale: locale === 'zh-HK' ? 'zh-HK' : 'zh-CN' });
    await blockExternal(context);
    const page = await context.newPage();
    await seed(page, { locale, books, extra });
    return { context, page };
}

// 找出畫面上「文字等於 i18n 鍵」的元素（代表翻譯缺失）
async function findRawKeys(page) {
    return page.evaluate(() => {
        const out = [];
        // 只認「命名空間.駝峰鍵」或「命名空間.鍵.鍵」這種形狀，避免 x0.5 之類的誤判
        const re = /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z][a-zA-Z0-9]*){1,3}$/;
        const KNOWN_NS = /^(vocabulary|dictation|learning|quiz|article|ocr|qa|sync|assistant|phonetics|common|app|nav|settings|modal|toast|errors|ui)\./;
        document.querySelectorAll('body *').forEach((el) => {
            if (el.children.length) return;
            const txt = (el.textContent || '').trim();
            if (!txt || txt.length > 60) return;
            if (!re.test(txt) || !KNOWN_NS.test(txt)) return;
            out.push({ tag: el.tagName, text: txt, id: el.id || '' });
        });
        return out;
    });
}

async function waitSettled(page, ms = 900) {
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(ms);
}

const MODULES = [
    { id: 'vocabulary-btn', section: 'vocabulary-section', key: 'v', name: '單詞本' },
    { id: 'dictation-btn', section: 'dictation-section', key: 'd', name: '聽寫' },
    { id: 'learning-btn', section: 'learning-section', key: 'l', name: '學習' },
    { id: 'qa-btn', section: 'qa-module', key: 'qa', name: '問答訓練' },
    { id: 'article-btn', section: 'article-section', key: 'a', name: '文章詳解' },
    { id: 'ocr-btn', section: 'ocr-section', key: 'ocr', name: '圖片識別' },
    { id: 'quiz-btn', section: 'quiz-section', key: 'q', name: '隨堂測驗' }
];

async function clickModule(page, mod) {
    // 手機版：article / ocr / quiz 收在「更多」抽屜
    const inDrawer = await page.evaluate((id) => {
        const btn = document.getElementById(id);
        if (!btn) return null;
        return { hidden: btn.offsetParent === null, inMore: !!btn.closest('#nav-more-list') };
    }, mod.id);
    if (!inDrawer) return { ok: false, why: 'button missing' };

    // 站內彈窗（引導、確認框）會蓋住整頁，導覽列就點不到；
    // 不先關掉的話每次點擊都會耗掉 Playwright 的預設 30 秒逾時，
    // 單一階段就能拖到三分鐘以上（實測 corrupt 階段 215s）。
    const dismissed = await page.evaluate(() => {
        let n = 0;
        document.querySelectorAll('.options-modal-overlay #cancel-btn, #app-modal .modal-close-btn, #app-modal .cancel-btn').forEach(b => {
            if (b.offsetParent !== null) { b.click(); n++; }
        });
        return n;
    });
    if (dismissed) await page.waitForTimeout(150);

    if (inDrawer.hidden && inDrawer.inMore) {
        await page.click('#nav-more-btn', { timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(200);
    }
    // 用短逾時：被遮住時快速失敗，而不是白等 30 秒
    await page.click(`#${mod.id}`, { timeout: 3000 }).catch(() => {
        page.evaluate((id) => document.getElementById(id)?.click(), mod.id).catch(() => {});
    });
    await page.waitForTimeout(450);
    return { ok: true, wasHidden: inDrawer.hidden };
}

// ---------------------------------------------------------------- bootstrap
async function runBootstrap(browser) {
    for (const viewport of Object.keys(VIEWPORTS)) {
        for (const locale of ['zh-CN', 'zh-HK']) {
            const { context, page } = await newPage(browser, { viewport, locale });
            const c = makeCollector(page);
            const t0 = Date.now();
            await page.goto(BASE, { waitUntil: 'domcontentloaded' });
            await waitSettled(page, 1600);
            const ms = Date.now() - t0;

            const lang = await page.evaluate(() => document.documentElement.lang);
            if (lang !== locale) record('boot/i18n', 'medium', `html lang 與介面語言不一致 (${viewport}/${locale})`, `實際 ${lang}`);

            if (c.pageErrors.length) record('boot', 'high', `啟動時未捕捉例外 (${viewport}/${locale})`, c.pageErrors.join(' | '));
            if (c.consoleErrors.length) record('boot', 'medium', `啟動時 console error (${viewport}/${locale})`, c.consoleErrors.join(' | '));
            if (c.requestFailed.length) record('boot', 'medium', `資源載入失敗 (${viewport}/${locale})`, c.requestFailed.slice(0, 5).join(' | '));
            if (c.i18nMissing.length) record('boot/i18n', 'high', `啟動時缺少翻譯鍵 (${viewport}/${locale})`, c.i18nMissing.slice(0, 8).join(' | '));

            const rawKeys = await findRawKeys(page);
            if (rawKeys.length) record('boot/i18n', 'high', `畫面直接顯示 i18n 鍵 (${viewport}/${locale})`, JSON.stringify(rawKeys.slice(0, 8)));

            // 水平溢出檢查
            const overflow = await page.evaluate(() => ({
                scrollW: document.documentElement.scrollWidth,
                clientW: document.documentElement.clientWidth
            }));
            if (overflow.scrollW > overflow.clientW + 2) {
                const culprits = await page.evaluate((cw) => {
                    const out = [];
                    document.querySelectorAll('body *').forEach((el) => {
                        const r = el.getBoundingClientRect();
                        if (r.width > 0 && r.right > cw + 1) out.push(`${el.tagName}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.split(/\s+/).slice(0, 2).join('.') : ''} right=${Math.round(r.right)}`);
                    });
                    return out.slice(0, 6);
                }, overflow.clientW);
                record('responsive', 'medium', `頁面水平溢出 (${viewport}/${locale})`, `${overflow.scrollW} > ${overflow.clientW} :: ${culprits.join(' | ')}`);
            }

            note(`啟動 ${viewport}/${locale} 完成 ${ms}ms`);
            await page.screenshot({ path: path.join(ASSETS, `boot-${viewport}-${locale}.png`) });
            await context.close();
        }
    }
}

// ---------------------------------------------------------------- navigation
async function runNav(browser) {
    for (const viewport of ['desktop', 'mobile']) {
        const { context, page } = await newPage(browser, { viewport, locale: 'zh-CN' });
        const c = makeCollector(page);
        await page.goto(BASE, { waitUntil: 'domcontentloaded' });
        await waitSettled(page, 1500);

        for (const mod of MODULES) {
            const before = c.pageErrors.length + c.consoleErrors.length;
            const res = await clickModule(page, mod);
            if (!res.ok) { record('nav', 'high', `找不到導覽按鈕 ${mod.name} (${viewport})`, res.why); continue; }
            const visible = await page.evaluate((sel) => {
                const el = document.getElementById(sel);
                if (!el) return 'missing';
                const cs = getComputedStyle(el);
                if (cs.display === 'none' || cs.visibility === 'hidden') return 'hidden';
                const r = el.getBoundingClientRect();
                return r.height > 0 ? 'visible' : 'zero-height';
            }, mod.section);
            if (visible !== 'visible') record('nav', 'high', `切換到「${mod.name}」後區塊未顯示 (${viewport})`, visible);
            const hash = await page.evaluate(() => location.hash);
            if (hash !== `#${mod.key}`) record('nav', 'low', `「${mod.name}」未同步 hash (${viewport})`, `hash=${hash} 期望 #${mod.key}`);
            const after = c.pageErrors.length + c.consoleErrors.length;
            if (after > before) record('nav', 'high', `切換「${mod.name}」時丟出錯誤 (${viewport})`, c.pageErrors.concat(c.consoleErrors).slice(before).join(' | '));
            const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
            if (overflow > 2) record('nav', 'medium', `「${mod.name}」頁面水平溢出 ${overflow}px (${viewport})`, '');
            await page.screenshot({ path: path.join(ASSETS, `nav-${viewport}-${mod.key}.png`) });
        }

        // 直接以 hash 進入
        for (const mod of MODULES) {
            await page.goto(`${BASE}#${mod.key}`, { waitUntil: 'domcontentloaded' });
            await waitSettled(page, 900);
            const visible = await page.evaluate((sel) => {
                const el = document.getElementById(sel);
                if (!el) return 'missing';
                const cs = getComputedStyle(el);
                if (cs.display === 'none' || cs.visibility === 'hidden') return 'hidden';
                return el.getBoundingClientRect().height > 0 ? 'visible' : 'zero-height';
            }, mod.section);
            if (visible !== 'visible') record('routing', 'high', `以 #${mod.key} 直達時「${mod.name}」未顯示 (${viewport})`, visible);
        }
        // 未知模組
        await page.goto(`${BASE}?module=nope`, { waitUntil: 'domcontentloaded' });
        await waitSettled(page, 800);
        const stillOk = await page.evaluate(() => document.querySelectorAll('.section.active, #qa-module.section').length);
        note(`未知 module 參數後仍渲染 ${stillOk} 個區塊容器`);

        if (c.pageErrors.length) record('nav', 'high', `導覽過程未捕捉例外 (${viewport})`, c.pageErrors.join(' | '));
        if (c.consoleErrors.length) record('nav', 'medium', `導覽過程 console error (${viewport})`, c.consoleErrors.slice(0, 10).join(' | '));
        await context.close();
    }
}

// ---------------------------------------------------------------- 空狀態
async function runEmptyState(browser) {
    for (const viewport of ['desktop', 'mobile']) {
        const { context, page } = await newPage(browser, { viewport, locale: 'zh-CN', books: [] });
        const c = makeCollector(page);
        await page.goto(BASE, { waitUntil: 'domcontentloaded' });
        await waitSettled(page, 1600);
        if (c.pageErrors.length) record('empty-state', 'high', `無詞書時啟動例外 (${viewport})`, c.pageErrors.join(' | '));
        const vocabEmpty = await page.evaluate(() => document.getElementById('word-list').textContent.trim().slice(0, 80));
        note(`空狀態 ${viewport} word-list = ${JSON.stringify(vocabEmpty)}`);
        for (const mod of MODULES) {
            await clickModule(page, mod);
            const errs = c.pageErrors.length;
            if (errs) { record('empty-state', 'high', `無詞書時進入「${mod.name}」出錯 (${viewport})`, c.pageErrors.slice(-2).join(' | ')); c.pageErrors.length = 0; }
        }
        await page.screenshot({ path: path.join(ASSETS, `empty-${viewport}.png`) });
        await context.close();
    }
}

// ---------------------------------------------------------------- 損壞資料
async function runCorruptData(browser) {
    const context = await browser.newContext({ viewport: VIEWPORTS.desktop });
    await blockExternal(context);
    const page = await context.newPage();
    await page.addInitScript(() => {
        localStorage.clear();
        localStorage.setItem('vocabularyBooks', '{not json');
        localStorage.setItem('analyzedArticles', '"a string"');
        localStorage.setItem('qa-sets', 'null');
        localStorage.setItem('pen_global_settings', '{{{');
        localStorage.setItem('activeBookId', 'nonexistent');
        // 不設的話會彈出「開始之前」引導彈窗蓋住導覽列，這一階段就只是在等逾時
        localStorage.setItem('vocabImportPromptShown', '1');
    });
    const c = makeCollector(page);
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await waitSettled(page, 2000);
    if (c.pageErrors.length) record('resilience', 'high', 'localStorage 損壞時啟動失敗', c.pageErrors.join(' | '));
    const books = await page.evaluate(() => document.getElementById('vocab-book-list').textContent.trim().slice(0, 60));
    note(`損壞資料啟動後書單 = ${JSON.stringify(books)}`);
    for (const mod of MODULES) {
        await clickModule(page, mod);
        if (c.pageErrors.length) { record('resilience', 'high', `損壞資料下進入「${mod.name}」出錯`, c.pageErrors.slice(-2).join(' | ')); c.pageErrors.length = 0; }
    }
    await context.close();
}

(async () => {
    const only = (process.argv.find(a => a.startsWith('--only=')) || '').split('=')[1];
    const want = only ? new Set(only.split(',')) : null;
    const run = (name, fn) => (!want || want.has(name)) ? fn() : Promise.resolve();

    const browser = await chromium.launch({
        executablePath: CHROME,
        args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']
    });
    const phaseT0 = Date.now();
    const timed = (name, fn) => async () => {
        const t0 = Date.now();
        try { return await fn(); } finally { note(`[計時] ${name} 階段耗時 ${Date.now() - t0}ms`); }
    };
    try {
        await run('bootstrap', timed('bootstrap', () => runBootstrap(browser)));
        await run('nav', timed('nav', () => runNav(browser)));
        await run('empty', timed('empty', () => runEmptyState(browser)));
        await run('corrupt', timed('corrupt', () => runCorruptData(browser)));
        note(`[計時] 總耗時 ${Date.now() - phaseT0}ms`);
    } finally {
        await browser.close();
    }

    const out = path.join(ASSETS, 'e2e-phase1.json');
    fs.writeFileSync(out, JSON.stringify({ findings, log, generatedAt: new Date().toISOString() }, null, 2));
    console.log(`\n=== 共 ${findings.length} 項發現，明細：${out} ===`);
    const bySev = findings.reduce((a, f) => (a[f.severity] = (a[f.severity] || 0) + 1, a), {});
    console.log('嚴重度分布:', bySev);
})();
