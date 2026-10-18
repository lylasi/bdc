/**
 * BDC 全站端到端巡檢 — 第二階段：各模組真實互動流程。
 *
 * 用法：
 *   node tests/audit-flows.cjs --port 8399 [--only=vocabulary,learning,...] [--headed]
 *   node tests/audit-flows.cjs --port 8399 --dump   # 只印出當前頁面可互動元素，除錯用
 */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8399);
const BASE = `http://127.0.0.1:${PORT}/`;
const ROOT = path.resolve(__dirname, '..');
const ASSETS = path.join(ROOT, 'docs', 'report', 'root-audit');
fs.mkdirSync(ASSETS, { recursive: true });
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const VIEWPORTS = {
    desktop: { width: 1440, height: 900 },
    tablet: { width: 834, height: 1112 },
    mobile: { width: 390, height: 844 }
};

const findings = [];
function record(area, severity, title, detail) {
    findings.push({ area, severity, title, detail: detail === undefined ? '' : String(detail).slice(0, 600) });
    console.log(`  [${severity}] ${area} :: ${title}${detail ? ' -- ' + String(detail).slice(0, 220) : ''}`);
}
function ok(msg) { console.log(`  ok   ${msg}`); }

const SAMPLE_BOOKS = [
    {
        id: 'audit-book', name: '巡檢詞書',
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        words: [
            { id: 'w1', word: 'apple', meaning: '苹果', phonetic: 'ˈæpl' },
            { id: 'w2', word: 'notebook', meaning: '笔记本', phonetic: 'ˈnəʊtbʊk' },
            { id: 'w3', word: 'running', meaning: '跑步', phonetic: 'ˈrʌnɪŋ' },
            { id: 'w4', word: 'beautiful', meaning: '美丽的', phonetic: 'ˈbjuːtɪfl' },
            { id: 'w5', word: 'environment', meaning: '环境', phonetic: 'ɪnˈvaɪrənmənt' }
        ]
    },
    {
        id: 'audit-book-2', name: '第二本', createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
        words: [
            { id: 'x1', word: 'banana', meaning: '香蕉', phonetic: 'bəˈnɑːnə' },
            { id: 'x2', word: 'orange', meaning: '橙子', phonetic: 'ˈɒrɪndʒ' }
        ]
    }
];

function makeCollector(page, { dialogMode = 'dismiss' } = {}) {
    const c = { consoleErrors: [], pageErrors: [], requestFailed: [], i18nMissing: [], dialogs: [], nativeDialogs: [] };
    page.on('console', (m) => {
        const text = m.text();
        if (m.type() === 'error') c.consoleErrors.push(text.slice(0, 300));
        if (/i18n: missing translation key/.test(text)) c.i18nMissing.push(text.slice(0, 200));
    });
    page.on('pageerror', (e) => c.pageErrors.push(String(e && e.stack ? e.stack.split('\n')[0] : e)));
    page.on('requestfailed', (r) => { if (!r.url().startsWith('data:')) c.requestFailed.push(r.url().slice(0, 120)); });
    if (dialogMode !== 'none') {
        page.on('dialog', async (d) => {
            c.nativeDialogs.push(`${d.type()}: ${d.message()}`);
            c.dialogs.push({ type: d.type(), message: d.message() });
            if (dialogMode === 'accept') await d.accept().catch(() => {});
            else await d.dismiss().catch(() => {});
        });
    }
    return c;
}

// 原生對話框紀錄器（不自動關閉，讓測試自行判斷）
function captureNativeDialogs(page) {
    const seen = [];
    page.on('dialog', async (d) => {
        seen.push({ type: d.type(), message: d.message() });
        await d.dismiss().catch(() => {});
    });
    return seen;
}

async function newPage(browser, { viewport = 'desktop', locale = 'zh-CN', books = SAMPLE_BOOKS, storage = {} } = {}) {
    const context = await browser.newContext({ viewport: VIEWPORTS[viewport], locale: locale === 'zh-HK' ? 'zh-HK' : 'zh-CN', acceptDownloads: true });
    await context.route('**/*', (route) => {
        let host = '';
        try { host = new URL(route.request().url()).hostname; } catch (_) { return route.abort(); }
        return (host === '127.0.0.1' || host === 'localhost') ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    await page.addInitScript(({ locale, books, storage }) => {
        try {
            // addInitScript 每次導覽都會執行；用一個哨兵鍵確保只在首次載入播種，
            // 否則 reload 會把測試剛寫入的狀態清掉（會掩蓋真正的持久化缺陷）。
            if (sessionStorage.getItem('__audit_seeded') === '1') return;
            sessionStorage.setItem('__audit_seeded', '1');
            localStorage.clear();
            localStorage.setItem('vocabularyBooks', JSON.stringify(books));
            localStorage.setItem('activeBookId', books[0] ? books[0].id : '');
            localStorage.setItem('vocabImportPromptShown', '1');
            localStorage.setItem('pen_global_settings', JSON.stringify({
                language: { interfaceLocale: locale },
                assistant: { enabled: false }
            }));
            for (const [k, v] of Object.entries(storage)) localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
            let timer;
            const synth = window.speechSynthesis;
            if (synth) {
                window.__spoken = [];
                synth.speak = (u) => { window.__spoken.push(u.text); u.onstart && u.onstart(); timer = setTimeout(() => u.onend && u.onend(), 30); };
                synth.cancel = () => clearTimeout(timer);
            }
        } catch (_) {}
    }, { locale, books, storage });
    return { context, page };
}

async function boot(page, { hash = '' } = {}) {
    await page.goto(BASE + hash, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1600);
}

const visibleText = (page, sel) => page.evaluate((s) => {
    const el = document.querySelector(s);
    return el ? (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 200) : null;
}, sel);

async function toastText(page) {
    return page.evaluate(() => {
        const nodes = document.querySelectorAll('.message, .toast, #message-container > *, [class*="message"]');
        return Array.from(nodes).map(n => (n.textContent || '').trim()).filter(Boolean).slice(0, 4);
    });
}

// ---- 彈窗輔助（依實測 DOM：app-modal 的按鈕在 #modal-body 內；確認框是獨立 .options-modal-overlay）
const appModalOpen = (page) => page.evaluate(() => {
    const m = document.getElementById('app-modal');
    return !!m && !m.classList.contains('hidden') && getComputedStyle(m).display !== 'none';
});
const confirmModalOpen = (page) => page.evaluate(() => !!document.querySelector('.options-modal-overlay'));

async function clickModalPrimary(page) {
    return page.evaluate(() => {
        const btn = document.querySelector('#app-modal #modal-body .save-btn, #app-modal .save-btn, #app-modal .modal-actions .primary-btn');
        if (btn) { btn.click(); return btn.textContent.trim(); }
        return null;
    });
}
async function clickModalCancel(page) {
    return page.evaluate(() => {
        const btn = document.querySelector('#app-modal #modal-body .cancel-btn, #app-modal .cancel-btn');
        if (btn) { btn.click(); return btn.textContent.trim(); }
        return null;
    });
}
async function clickOptionsConfirm(page) {
    return page.evaluate(() => {
        const btn = document.querySelector('.options-modal-overlay #confirm-btn');
        if (btn) { btn.click(); return btn.textContent.trim(); }
        return null;
    });
}
async function clickOptionsCancel(page) {
    return page.evaluate(() => {
        const btn = document.querySelector('.options-modal-overlay #cancel-btn');
        if (btn) { btn.click(); return btn.textContent.trim(); }
        return null;
    });
}
// QA 訓練區的按鈕會隨 updateTrainingInterface() 重繪，偶爾在重繪瞬間不存在，
// 直接 page.click 會等到逾時。這裡先等元素出現再點，仍失敗才退回 DOM click。
async function clickWhenReady(page, selector, { timeout = 8000 } = {}) {
    try {
        await page.waitForSelector(selector, { state: 'attached', timeout });
        await page.waitForFunction((sel) => {
            const el = document.querySelector(sel);
            return !!el && !el.disabled;
        }, selector, { timeout }).catch(() => {});
        await page.click(selector, { timeout });
        return 'clicked';
    } catch (_) {
        return page.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (!el) return 'missing';
            el.click();
            return 'dom-click';
        }, selector);
    }
}

async function closeAnyModal(page) {
    await page.evaluate(() => {
        const btns = document.querySelectorAll('.options-modal-overlay #cancel-btn, #app-modal .modal-close-btn, #app-modal .cancel-btn');
        btns.forEach(b => { if (b.offsetParent !== null) b.click(); });
    });
    await page.waitForTimeout(300);
}

async function dumpInteractive(page) {
    return page.evaluate(() => {
        const out = [];
        document.querySelectorAll('button, [role="button"], input, select, textarea, a[href]').forEach((el) => {
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden' || el.offsetParent === null) return;
            out.push({
                tag: el.tagName.toLowerCase(),
                id: el.id || '',
                type: el.type || '',
                text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 30),
                aria: el.getAttribute('aria-label') || '',
                disabled: !!el.disabled,
                rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]
            });
        });
        return out;
    });
}

function trap(page, c, area, label) {
    const n = c.pageErrors.length;
    const m = c.consoleErrors.length;
    const k = c.i18nMissing.length;
    return () => {
        if (c.pageErrors.length > n) record(area, 'high', `${label}：未捕捉例外`, c.pageErrors.slice(n).join(' | '));
        if (c.consoleErrors.length > m) record(area, 'low', `${label}：console error`, c.consoleErrors.slice(m).join(' | '));
        if (c.i18nMissing.length > k) record(area, 'high', `${label}：缺少翻譯鍵`, c.i18nMissing.slice(k).join(' | '));
    };
}

const onlyArg = (process.argv.find(a => a.startsWith('--only=')) || '').split('=')[1];
const WANT = onlyArg ? new Set(onlyArg.split(',')) : null;
const should = (name) => !WANT || WANT.has(name);

// ============================================================ 單詞本
async function flowVocabulary(browser) {
    console.log('\n### 單詞本');
    const { context, page } = await newPage(browser, {});
    const c = makeCollector(page);
    await boot(page);

    // 1. 篩選
    let check = trap(page, c, 'vocabulary', '篩選');
    await page.fill('#word-filter', 'app');
    await page.waitForTimeout(300);
    let listText = await visibleText(page, '#word-list');
    if (!listText || !listText.includes('apple') || listText.includes('notebook')) {
        record('vocabulary', 'high', '篩選無效或結果錯誤', `filter=app => ${listText}`);
    } else ok('篩選 apple 命中');
    const countText = await visibleText(page, '#word-filter-count');
    ok(`篩選計數顯示：${countText}`);
    await page.fill('#word-filter', '不存在詞');
    await page.waitForTimeout(300);
    listText = await visibleText(page, '#word-list');
    if (!listText) record('vocabulary', 'medium', '篩選無結果時沒有任何空狀態文案', 'word-list 為空');
    else ok(`無結果文案：${listText}`);
    await page.fill('#word-filter', '');
    await page.waitForTimeout(250);
    check();

    // 2. 搜尋清空鈕 / Enter
    check = trap(page, c, 'vocabulary', '篩選清空');

    // 3. 新增單詞本
    await page.click('#add-vocab-book-btn');
    await page.waitForTimeout(600);
    let modalOpen = await appModalOpen(page);
    if (!modalOpen) {
        record('vocabulary', 'high', '「新增單詞本」沒有開啟彈窗', '');
    } else {
        ok(`新增單詞本彈窗標題：${await visibleText(page, '#modal-title')}`);
        const fields = await page.evaluate(() => Array.from(document.querySelectorAll('#app-modal input, #app-modal textarea')).map(i => ({ id: i.id, tag: i.tagName })));
        ok(`彈窗欄位：${JSON.stringify(fields)}`);
        await page.fill('#modal-book-name', '巡檢新增本');
        await page.fill('#modal-vocab-content', 'banana\norange\n\n[{"word":"grape","meaning":"葡萄"}]');
        await page.waitForTimeout(300);
        const primaryLabel = await clickModalPrimary(page);
        ok(`主要按鈕：${primaryLabel}`);
        await page.waitForTimeout(1500);
        const stillOpen = await appModalOpen(page);
        if (stillOpen) {
            record('vocabulary', 'medium', '新增單詞本填了名稱與內容後彈窗仍未關閉', `body=${await visibleText(page, '#modal-body')}`);
            await closeAnyModal(page);
        }
        const books = await page.evaluate(() => JSON.parse(localStorage.getItem('vocabularyBooks') || '[]').map(b => ({ name: b.name, n: b.words.length, words: b.words.map(w => w.word) })));
        const created = books.find(b => b.name === '巡檢新增本');
        if (!created) record('vocabulary', 'high', '新增單詞本後未寫入 localStorage', JSON.stringify(books));
        else ok(`新增成功：${JSON.stringify(created).slice(0, 200)}`);
    }
    check();
    await page.screenshot({ path: path.join(ASSETS, 'flow-vocabulary-desktop.png') });

    // 4. 空名稱 / 空內容
    check = trap(page, c, 'vocabulary', '空名與空內容');
    await page.click('#add-vocab-book-btn');
    await page.waitForTimeout(500);
    await clickModalPrimary(page);
    await page.waitForTimeout(800);
    const emptyToasts = await toastText(page);
    ok(`空名稱提交後提示：${JSON.stringify(emptyToasts)}`);
    const stillOpenEmpty = await appModalOpen(page);
    if (!emptyToasts.length && !stillOpenEmpty) record('vocabulary', 'medium', '新增單詞本空名稱提交沒有任何提示且彈窗已關閉', '');
    if (stillOpenEmpty && !emptyToasts.length) record('vocabulary', 'low', '新增單詞本空名稱提交後彈窗未關閉但也沒有提示', '');
    await closeAnyModal(page);
    check();

    // 5. 重名
    check = trap(page, c, 'vocabulary', '重名');
    await page.click('#add-vocab-book-btn');
    await page.waitForTimeout(500);
    await page.fill('#modal-book-name', '巡檢詞書');
    await page.fill('#modal-vocab-content', 'grape');
    await clickModalPrimary(page);
    await page.waitForTimeout(1500);
    const dupeState = await page.evaluate(() => ({
        open: !document.getElementById('app-modal').classList.contains('hidden'),
        options: !!document.querySelector('.options-modal-overlay'),
        modalTitle: document.getElementById('modal-title')?.textContent.trim()
    }));
    const names = await page.evaluate(() => JSON.parse(localStorage.getItem('vocabularyBooks') || '[]').map(b => b.name));
    ok(`重名提交後：${JSON.stringify(dupeState)} 詞書=${JSON.stringify(names)}`);
    if (names.filter(n => n === '巡檢詞書').length > 1) {
        record('vocabulary', 'medium', '允許建立完全同名的單詞本，後續難以區分', JSON.stringify(names));
    } else {
        ok('同名建立已被擋下（詞書選擇器只顯示名稱，重名無法區分）');
    }
    const dupeMsg = await toastText(page);
    if (!dupeMsg.length) record('vocabulary', 'low', '同名建立被擋下時沒有任何提示', '');
    else ok(`重名提示：${JSON.stringify(dupeMsg)}`);
    await closeAnyModal(page);
    check();

    // 6. 刪除（走站內確認框）
    check = trap(page, c, 'vocabulary', '刪除');
    await page.evaluate(() => {
        const li = Array.from(document.querySelectorAll('#vocab-book-list li')).find(x => x.textContent.includes('巡檢新增本'));
        if (li) li.click();
    });
    await page.waitForTimeout(400);
    await page.click('#delete-vocab-book-btn');
    await page.waitForTimeout(800);
    const delModal = await page.evaluate(() => {
        const ov = document.querySelector('.options-modal-overlay');
        return ov ? { title: ov.querySelector('h3')?.textContent.trim(), desc: ov.querySelector('.om-desc')?.textContent.trim(), confirm: ov.querySelector('#confirm-btn')?.textContent.trim() } : null;
    });
    ok(`刪除確認框：${JSON.stringify(delModal)}`);
    if (!delModal) record('vocabulary', 'high', '「删除」沒有跳出確認框', '');
    await page.screenshot({ path: path.join(ASSETS, 'flow-vocabulary-confirm.png') });
    await clickOptionsConfirm(page);
    await page.waitForTimeout(900);
    const afterDelete = await page.evaluate(() => JSON.parse(localStorage.getItem('vocabularyBooks') || '[]').map(b => b.name));
    if (afterDelete.includes('巡檢新增本')) record('vocabulary', 'high', '刪除確認後詞書仍在', JSON.stringify(afterDelete));
    else ok(`刪除成功：${JSON.stringify(afterDelete)}`);
    check();

    // 6b. 取消刪除
    check = trap(page, c, 'vocabulary', '取消刪除');
    const beforeCancel = await page.evaluate(() => JSON.parse(localStorage.getItem('vocabularyBooks') || '[]').length);
    await page.click('#delete-vocab-book-btn');
    await page.waitForTimeout(700);
    await clickOptionsCancel(page);
    await page.waitForTimeout(600);
    const afterCancel = await page.evaluate(() => JSON.parse(localStorage.getItem('vocabularyBooks') || '[]').length);
    if (afterCancel !== beforeCancel) record('vocabulary', 'high', '取消刪除仍刪掉了詞書', `${beforeCancel} -> ${afterCancel}`);
    else ok('取消刪除未變更資料');
    check();

    // 7. 編輯單詞
    check = trap(page, c, 'vocabulary', '編輯');
    await page.evaluate(() => document.querySelector('#vocab-book-list li')?.click());
    await page.waitForTimeout(400);
    await page.click('#edit-vocab-book-btn');
    await page.waitForTimeout(1200);
    const editOpen = await appModalOpen(page);
    if (!editOpen) {
        record('vocabulary', 'high', '「编辑」未開啟編輯彈窗', '');
    } else {
        const info = await page.evaluate(() => ({
            title: document.getElementById('modal-title').textContent.trim(),
            inputs: document.querySelectorAll('#modal-body input, #modal-body textarea').length,
            saveBtn: !!document.querySelector('#modal-body .save-btn')
        }));
        ok(`編輯彈窗：${JSON.stringify(info)}`);
        await page.screenshot({ path: path.join(ASSETS, 'flow-vocabulary-edit-modal.png') });
        await closeAnyModal(page);
    }
    check();

    // 8. 導出
    check = trap(page, c, 'vocabulary', '導出');
    const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 8000 }).catch(() => null),
        page.click('#export-vocab-book-btn').catch(() => {})
    ]);
    if (!download) record('vocabulary', 'medium', '「導出」沒有產生下載', JSON.stringify(await toastText(page)));
    else ok(`導出檔案：${download.suggestedFilename()}`);
    await page.waitForTimeout(400);
    check();

    // 9. 合併
    check = trap(page, c, 'vocabulary', '合併');
    await page.click('#merge-vocab-books-btn');
    await page.waitForTimeout(900);
    const mergeState = await page.evaluate(() => ({
        appModal: !document.getElementById('app-modal').classList.contains('hidden'),
        optionsModal: !!document.querySelector('.options-modal-overlay'),
        title: document.getElementById('modal-title').textContent.trim(),
        overlayTitle: document.querySelector('.options-modal-overlay h3')?.textContent.trim() || null
    }));
    ok(`合併彈窗：${JSON.stringify(mergeState)}`);
    if (!mergeState.appModal && !mergeState.optionsModal) record('vocabulary', 'medium', '「合并」未開啟任何彈窗', '');
    await page.screenshot({ path: path.join(ASSETS, 'flow-vocabulary-merge.png') });
    await closeAnyModal(page);
    check();

    // 10. 導入
    check = trap(page, c, 'vocabulary', '導入');
    await page.click('#import-vocab-book-btn');
    await page.waitForTimeout(1500);
    const importState = await page.evaluate(() => ({
        appModal: !document.getElementById('app-modal').classList.contains('hidden'),
        title: document.getElementById('modal-title').textContent.trim(),
        bodyLen: document.getElementById('modal-body').textContent.trim().length,
        checkboxes: document.querySelectorAll('#modal-body input[type=checkbox], #modal-body .import-checkbox').length,
        fileInput: !!document.querySelector('#modal-body input[type=file]')
    }));
    ok(`導入彈窗：${JSON.stringify(importState)}`);
    if (!importState.appModal) record('vocabulary', 'medium', '「導入單詞本」未開啟彈窗', '');
    else if (importState.bodyLen < 10) record('vocabulary', 'medium', '導入彈窗內容為空（預置清單載入失敗？）', JSON.stringify(importState));
    await page.screenshot({ path: path.join(ASSETS, 'flow-vocabulary-import.png') });
    await closeAnyModal(page);
    check();

    // 11. 補全資料（AI 不可用）
    check = trap(page, c, 'vocabulary', '補全資料');
    await page.evaluate(() => document.querySelector('#vocab-book-list li')?.click());
    await page.waitForTimeout(300);
    await page.click('#complete-missing-btn').catch(() => {});
    await page.waitForTimeout(3000);
    ok(`補全資料後提示：${JSON.stringify(await toastText(page))}`);
    await closeAnyModal(page);
    check();

    // 12. 朗讀
    check = trap(page, c, 'vocabulary', '單詞朗讀');
    const speakBtn = await page.$('#word-list button');
    if (speakBtn) {
        await speakBtn.click().catch(() => {});
        await page.waitForTimeout(800);
        const spoken = await page.evaluate(() => window.__spoken || []);
        ok(`朗讀觸發內容：${JSON.stringify(spoken)}`);
        if (!spoken.length) record('vocabulary', 'medium', '點擊朗讀按鈕沒有觸發語音合成', '');
    } else record('vocabulary', 'medium', '單詞列表沒有朗讀按鈕', '');
    check();

    await context.close();

    // 13. 手機版
    const m = await newPage(browser, { viewport: 'mobile' });
    const cm = makeCollector(m.page);
    await boot(m.page);
    const mobileCheck = trap(m.page, cm, 'vocabulary', '手機單詞本');
    const moreBtnVisible = await m.page.evaluate(() => {
        const b = document.getElementById('word-panel-more-btn');
        return b ? getComputedStyle(b).display !== 'none' && b.offsetParent !== null : false;
    });
    ok(`手機「更多」按鈕可見：${moreBtnVisible}`);
    if (moreBtnVisible) {
        await m.page.click('#word-panel-more-btn');
        await m.page.waitForTimeout(500);
        const menu = await m.page.evaluate(() => {
            const el = document.querySelector('.word-panel-menu, .word-panel-more-menu, [class*="word-panel"][class*="menu"]');
            return el ? { cls: el.className, items: Array.from(el.querySelectorAll('button')).map(b => b.textContent.trim()) } : null;
        });
        ok(`單詞本更多選單：${JSON.stringify(menu)}`);
        if (!menu) record('vocabulary', 'medium', '手機「更多」按鈕點了沒有選單', '');
        await m.page.screenshot({ path: path.join(ASSETS, 'flow-vocabulary-mobile-menu.png') });
    } else {
        record('vocabulary', 'medium', '手機版看不到單詞本「更多」操作入口（桌機 chips 是否仍顯示？）', '');
    }
    // 手機是否仍顯示桌機 chips
    const chipsVisible = await m.page.evaluate(() => {
        const chips = document.querySelectorAll('.word-panel-actions .action-chip:not(.word-panel-more-btn)');
        return Array.from(chips).filter(c => c.offsetParent !== null).length;
    });
    ok(`手機仍顯示的桌機操作 chips 數：${chipsVisible}`);
    mobileCheck();
    await m.context.close();
}

// ============================================================ 學習模式
async function flowLearning(browser) {
    console.log('\n### 學習模式');
    const { context, page } = await newPage(browser, {});
    const c = makeCollector(page);
    await page.goto(BASE + '#l', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1600);

    let check = trap(page, c, 'learning', '初始');
    const bookSel = await page.evaluate(() => {
        const el = document.getElementById('learning-book-selector');
        return el ? { html: el.innerHTML.slice(0, 300), inputs: el.querySelectorAll('input').length } : null;
    });
    ok(`學習詞書選擇器：${JSON.stringify(bookSel).slice(0, 200)}`);
    if (!bookSel || bookSel.inputs === 0) record('learning', 'high', '學習模式沒有渲染詞書選擇器', '');

    const wordOpts = await page.evaluate(() => {
        const s = document.getElementById('word-select');
        return s ? { options: Array.from(s.options).map(o => o.textContent), value: s.value } : null;
    });
    ok(`單詞下拉：${JSON.stringify(wordOpts)}`);
    if (!wordOpts || !wordOpts.options.length) record('learning', 'high', '學習模式單詞下拉為空', '');

    const detail = await page.evaluate(() => ({
        word: document.getElementById('detail-word').textContent.trim(),
        phonetic: document.getElementById('detail-phonetic').textContent.trim(),
        meaning: document.getElementById('detail-meaning').textContent.trim()
    }));
    ok(`單字詳解：${JSON.stringify(detail)}`);
    if (!detail.word) record('learning', 'high', '學習模式單字詳解為空', '');
    check();

    // 下一詞 / 上一詞
    // 導覽語意（已於 2026-10-16 調整）：首尾不環繞，邊界停在原地並在位置列顯示提示；
    // 尚未選取時兩個方向都從第一個單詞開始（先前「上一個」會直接跳到最後一個且無提示）。
    check = trap(page, c, 'learning', '前後切換');
    const before = detail.word;
    await page.click('#word-next-btn');
    await page.waitForTimeout(350);
    const after = await visibleText(page, '#detail-word');
    if (!after || after === before) record('learning', 'medium', '「下一個」沒有切換單字', `${before} -> ${after}`);
    else ok(`下一個：${before} -> ${after}`);
    const firstPos = await visibleText(page, '#word-position');
    if (!/1\s*\/|第 1/.test(firstPos || '')) {
        record('learning', 'medium', '未選取時按「下一個」應從第一個單詞開始', `位置指示=${firstPos}`);
    } else ok(`未選取時從第一個開始：${firstPos}`);

    // 在第一個單詞按「上一個」：應停在原地並提示，不得跳到最後一個
    await page.click('#word-prev-btn');
    await page.waitForTimeout(350);
    const back = await visibleText(page, '#detail-word');
    if (back !== after) record('learning', 'medium', '在第一個單詞按「上一個」不得跳到最後一個', `${after} -> ${back}`);
    else ok(`上一個停在原地：${back}`);
    const navHint = await visibleText(page, '#word-position');
    if (!/第一個|第一个/.test(navHint || '')) {
        record('learning', 'low', '導覽到邊界時沒有任何提示', `位置指示=${navHint}`);
    } else ok(`邊界提示：${navHint}`);
    check();

    // 到最後一個再按下一詞
    check = trap(page, c, 'learning', '邊界');
    for (let i = 0; i < 10; i++) { await page.click('#word-next-btn').catch(() => {}); await page.waitForTimeout(120); }
    const last = await visibleText(page, '#detail-word');
    ok(`連按下一個後停在：${last}`);
    for (let i = 0; i < 10; i++) { await page.click('#word-prev-btn').catch(() => {}); await page.waitForTimeout(120); }
    ok(`連按上一個後停在：${await visibleText(page, '#detail-word')}`);
    check();

    // 例句生成（AI 離線）
    check = trap(page, c, 'learning', 'AI 例句');
    await page.click('#generate-examples-btn').catch(() => {});
    await page.waitForTimeout(3000);
    const exampleText = await visibleText(page, '#examples-container');
    ok(`例句區：${String(exampleText).slice(0, 120)}`);
    if (!exampleText) record('learning', 'medium', 'AI 例句失敗時沒有任何錯誤或空狀態文案', '');
    check();

    // 造句檢查（AI 離線）
    check = trap(page, c, 'learning', '造句檢查');
    await page.fill('#sentence-input', 'I like apple.');
    await page.click('#check-sentence-btn').catch(() => {});
    await page.waitForTimeout(3000);
    const feedback = await visibleText(page, '#sentence-feedback');
    ok(`造句回饋：${String(feedback).slice(0, 120)}`);
    if (!feedback) record('learning', 'medium', '造句檢查失敗時沒有回饋文案', '');
    check();

    // 朗讀
    check = trap(page, c, 'learning', '朗讀');
    await page.click('#speak-word-btn').catch(() => {});
    await page.waitForTimeout(700);
    const spoken = await page.evaluate(() => window.__spoken || []);
    if (!spoken.length) record('learning', 'medium', '學習模式朗讀按鈕未觸發語音', '');
    else ok(`朗讀：${JSON.stringify(spoken)}`);
    check();

    // 語言切換後檢查殘留
    check = trap(page, c, 'learning', '語言切換');
    await page.evaluate(() => {
        const s = JSON.parse(localStorage.getItem('pen_global_settings') || '{}');
        s.language = { interfaceLocale: 'zh-HK' };
        localStorage.setItem('pen_global_settings', JSON.stringify(s));
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1600);
    const langAfter = await page.evaluate(() => document.documentElement.lang);
    if (langAfter !== 'zh-HK') record('i18n', 'medium', '改 localStorage 後重載未套用 zh-HK', langAfter);
    else ok('重載後語言為 zh-HK');
    const hkDetail = await page.evaluate(() => document.getElementById('detail-word')?.textContent.trim());
    ok(`zh-HK 下單字：${hkDetail}`);
    check();

    await page.screenshot({ path: path.join(ASSETS, 'flow-learning-desktop.png') });
    await context.close();
}

// ============================================================ 聽寫
async function flowDictation(browser) {
    console.log('\n### 聽寫模式');
    const { context, page } = await newPage(browser, {});
    const c = makeCollector(page);
    await page.goto(BASE + '#d', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1600);

    let check = trap(page, c, 'dictation', '初始');
    const settingsCard = await page.evaluate(() => {
        const el = document.getElementById('dictation-settings-card');
        return el ? { visible: getComputedStyle(el).display !== 'none', text: el.textContent.trim().replace(/\s+/g, ' ').slice(0, 200) } : null;
    });
    ok(`設定卡：${JSON.stringify(settingsCard).slice(0, 240)}`);
    const bookChips = await page.evaluate(() => Array.from(document.querySelectorAll('#dictation-section .book-selector input')).map(i => ({ v: i.value, checked: i.checked })));
    if (!bookChips.length) record('dictation', 'high', '聽寫模式沒有詞書可選', '');
    else ok(`詞書選項：${JSON.stringify(bookChips)}`);
    check();

    // 高級設置展開
    check = trap(page, c, 'dictation', '高級設置');
    await page.evaluate(() => {
        const details = document.querySelectorAll('#dictation-section details, #dictation-section .advanced-toggle, #dictation-section [aria-expanded]');
        details.forEach(d => { if (d.tagName === 'DETAILS') d.open = true; else d.click(); });
    });
    await page.waitForTimeout(500);
    const advancedFields = await page.evaluate(() => Array.from(document.querySelectorAll('#dictation-section input, #dictation-section select')).map(i => ({
        id: i.id, type: i.type, val: i.value, visible: i.offsetParent !== null
    })));
    ok(`聽寫欄位：${JSON.stringify(advancedFields).slice(0, 500)}`);
    check();

    // 開始聽寫
    check = trap(page, c, 'dictation', '開始聽寫');
    await page.click('#start-dictation-btn');
    await page.waitForTimeout(2500);
    const playerState = await page.evaluate(() => ({
        playerVisible: !document.getElementById('dictation-player').classList.contains('hidden'),
        settingsVisible: getComputedStyle(document.getElementById('dictation-settings-card')).display !== 'none',
        badge: document.getElementById('dictation-state-badge')?.textContent.trim(),
        counter: [document.getElementById('dictation-counter-current')?.textContent, document.getElementById('dictation-counter-total')?.textContent],
        title: document.getElementById('dictation-stage-title')?.textContent.trim(),
        hint: document.getElementById('dictation-stage-hint')?.textContent.trim(),
        stopDisabled: document.getElementById('stop-dictation-btn').disabled
    }));
    ok(`聽寫進行中：${JSON.stringify(playerState)}`);
    if (!playerState.playerVisible) record('dictation', 'high', '點「開始聽寫」後播放器沒有出現', JSON.stringify(playerState));
    if (playerState.stopDisabled) record('dictation', 'high', '聽寫進行中「結束」按鈕仍是 disabled', '');
    const spoken1 = await page.evaluate(() => window.__spoken || []);
    if (!spoken1.length) record('dictation', 'medium', '聽寫開始後沒有朗讀任何單詞（TTS 未觸發）', '');
    else ok(`已朗讀：${JSON.stringify(spoken1)}`);
    await page.screenshot({ path: path.join(ASSETS, 'flow-dictation-playing.png') });
    check();

    // 暫停 / 恢復
    check = trap(page, c, 'dictation', '暫停恢復');
    await page.click('#pause-dictation-btn').catch(() => {});
    await page.waitForTimeout(500);
    const paused = await page.evaluate(() => ({
        badge: document.getElementById('dictation-state-badge')?.textContent.trim(),
        label: document.getElementById('pause-dictation-label')?.textContent.trim()
    }));
    ok(`暫停後：${JSON.stringify(paused)}`);
    await page.click('#pause-dictation-btn').catch(() => {});
    await page.waitForTimeout(500);
    const resumed = await page.evaluate(() => document.getElementById('dictation-state-badge')?.textContent.trim());
    ok(`恢復後：${resumed}`);
    if (paused.badge === resumed) record('dictation', 'high', '暫停/恢復狀態徽章沒有變化', `${paused.badge} == ${resumed}`);
    check();

    // 重播 / 上一個 / 下一個
    check = trap(page, c, 'dictation', '控制列');
    const idxBefore = await visibleText(page, '#dictation-counter-current');
    await page.click('#replay-dictation-btn').catch(() => {});
    await page.waitForTimeout(800);
    await page.click('#next-dictation-btn').catch(() => {});
    await page.waitForTimeout(1200);
    const idxAfter = await visibleText(page, '#dictation-counter-current');
    if (idxBefore === idxAfter) record('dictation', 'medium', '「下一個」沒有推進計數', `${idxBefore} -> ${idxAfter}`);
    else ok(`下一個：${idxBefore} -> ${idxAfter}`);
    await page.click('#prev-dictation-btn').catch(() => {});
    await page.waitForTimeout(1200);
    ok(`上一個後：${await visibleText(page, '#dictation-counter-current')}`);
    check();

    // 暫停中離開頁面（可見性）
    check = trap(page, c, 'dictation', '可見性自動暫停');
    await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(600);
    const afterHidden = await page.evaluate(() => document.getElementById('dictation-state-badge')?.textContent.trim());
    ok(`切到背景後狀態：${afterHidden}`);
    await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
        document.dispatchEvent(new Event('visibilitychange'));
    });
    check();

    // 會話持久化
    const session = await page.evaluate(() => localStorage.getItem('pen_dictation_session'));
    if (!session) record('dictation', 'medium', '聽寫進行中沒有寫入 pen_dictation_session', '');
    else ok(`會話已持久化：${String(session).slice(0, 140)}`);

    // 結束聽寫 → 完成卡片
    check = trap(page, c, 'dictation', '結束聽寫');
    await page.click('#stop-dictation-btn').catch(() => {});
    await page.waitForTimeout(800);
    const stopped = await page.evaluate(() => ({
        settingsVisible: getComputedStyle(document.getElementById('dictation-settings-card')).display !== 'none',
        completeVisible: !document.getElementById('dictation-complete').classList.contains('hidden'),
        playerVisible: !document.getElementById('dictation-player').classList.contains('hidden'),
        completeText: document.getElementById('dictation-complete')?.textContent.trim().replace(/\s+/g, ' ').slice(0, 200)
    }));
    ok(`結束後：${JSON.stringify(stopped)}`);
    await page.screenshot({ path: path.join(ASSETS, 'flow-dictation-stopped.png') });
    check();

    // 跟打練習模式
    check = trap(page, c, 'dictation', '跟打練習');
    await page.evaluate(() => {
        const mode = document.getElementById('dictation-typed-mode');
        if (mode) { mode.checked = true; mode.dispatchEvent(new Event('change', { bubbles: true })); }
    });
    await page.waitForTimeout(400);
    await page.click('#start-dictation-btn').catch(() => {});
    await page.waitForTimeout(1800);
    const typedVisible = await page.evaluate(() => {
        const el = document.querySelector('.dictation-practice');
        return el ? getComputedStyle(el).display !== 'none' : null;
    });
    ok(`跟打練習區可見：${typedVisible}`);
    if (typedVisible === false) record('dictation', 'medium', '切到跟打練習後作答區沒有出現', '');
    // 輸入錯誤答案
    const inputExists = await page.$('#dictation-input');
    if (inputExists) {
        await page.fill('#dictation-input', 'zzz');
        await page.click('#check-dictation-btn').catch(() => {});
        await page.waitForTimeout(900);
        const result = await visibleText(page, '#dictation-result');
        ok(`拼寫檢查結果：${result}`);
        if (!result) record('dictation', 'medium', '拼寫檢查沒有顯示結果', '');
        await page.screenshot({ path: path.join(ASSETS, 'flow-dictation-typed.png') });
        // AI 批改
        await page.click('#dictation-ai-grade-btn').catch(() => {});
        await page.waitForTimeout(3000);
        ok(`AI 批改提示：${JSON.stringify(await toastText(page))}`);
    } else record('dictation', 'medium', '跟打模式找不到 #dictation-input', '');
    check();

    // 手機版
    await context.close();
    const m = await newPage(browser, { viewport: 'mobile' });
    const cm = makeCollector(m.page);
    await m.page.goto(BASE + '#d', { waitUntil: 'domcontentloaded' });
    await m.page.waitForTimeout(1600);
    const mc = trap(m.page, cm, 'dictation', '手機聽寫');
    await m.page.click('#start-dictation-btn').catch(() => {});
    await m.page.waitForTimeout(2500);
    const mobileOverflow = await m.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (mobileOverflow > 2) record('dictation', 'medium', `手機聽寫進行中水平溢出 ${mobileOverflow}px`, '');
    await m.page.screenshot({ path: path.join(ASSETS, 'flow-dictation-mobile-playing.png'), fullPage: true });
    // 浮動控制條
    const floating = await m.page.evaluate(() => {
        const el = document.querySelector('.floating-dictation-controls, #floating-controls, [class*="floating"]');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return { cls: el.className, visible: cs.display !== 'none' && cs.visibility !== 'hidden', rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], z: cs.zIndex, position: cs.position };
    });
    ok(`手機浮動控制：${JSON.stringify(floating)}`);
    mc();
    await m.context.close();
}

// ============================================================ 測驗
async function flowQuiz(browser) {
    console.log('\n### 隨堂測驗');
    const { context, page } = await newPage(browser, {});
    const c = makeCollector(page);
    const native = captureNativeDialogs(page);
    await page.goto(BASE + '#q', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1600);

    let check = trap(page, c, 'quiz', '初始');
    const sel = await page.evaluate(() => Array.from(document.querySelectorAll('#quiz-book-selector input')).map(i => ({ v: i.value, checked: i.checked })));
    ok(`測驗詞書：${JSON.stringify(sel)}`);
    if (!sel.length) record('quiz', 'high', '測驗模式沒有詞書可選', '');
    check();

    // 開始測驗（5 個單詞，>=4）
    check = trap(page, c, 'quiz', '開始測驗');
    await page.click('#start-quiz-btn');
    await page.waitForTimeout(600);
    const q1 = await page.evaluate(() => ({
        question: document.getElementById('quiz-question').textContent.trim(),
        options: Array.from(document.querySelectorAll('.quiz-option')).map(o => o.textContent),
        progress: document.getElementById('quiz-progress').textContent.trim(),
        score: document.getElementById('quiz-score').textContent.trim(),
        settingsHidden: document.getElementById('quiz-settings-container').classList.contains('hidden'),
        nextDisabled: document.getElementById('next-question-btn').disabled
    }));
    ok(`第 1 題：${JSON.stringify(q1)}`);
    if (!q1.options.length) record('quiz', 'high', '測驗開始後沒有選項', JSON.stringify(q1));
    if (q1.options.length !== 4) record('quiz', 'medium', `選項數不是 4（實際 ${q1.options.length}）`, '');
    const dupe = q1.options.length !== new Set(q1.options).size;
    if (dupe) record('quiz', 'medium', '選項有重複文字', JSON.stringify(q1.options));
    if (!q1.nextDisabled) record('quiz', 'medium', '尚未作答時「下一題」未停用', '');
    check();

    // 選項可重複點擊？
    check = trap(page, c, 'quiz', '作答');
    const firstOption = await page.$('.quiz-option');
    await firstOption.click();
    await page.waitForTimeout(300);
    const answered = await page.evaluate(() => ({
        correct: document.querySelectorAll('.quiz-option.correct').length,
        incorrect: document.querySelectorAll('.quiz-option.incorrect').length,
        nextDisabled: document.getElementById('next-question-btn').disabled,
        score: document.getElementById('quiz-score').textContent.trim()
    }));
    ok(`作答後：${JSON.stringify(answered)}`);
    if (answered.correct !== 1) record('quiz', 'high', `作答後標記為正確的選項數不是 1（實際 ${answered.correct}）`, '');
    if (answered.nextDisabled) record('quiz', 'high', '作答後「下一題」仍停用', '');
    // 再點第二個選項，應無效
    const opts = await page.$$('.quiz-option');
    if (opts[1]) { await opts[1].click(); await page.waitForTimeout(200); }
    const scoreAfterSecond = await page.evaluate(() => document.getElementById('quiz-score').textContent.trim());
    if (scoreAfterSecond !== answered.score) record('quiz', 'high', '作答後再點其他選項仍會改變分數', `${answered.score} -> ${scoreAfterSecond}`);
    else ok('已作答後再點其他選項無效（正確）');
    check();

    // 走完全部題目
    check = trap(page, c, 'quiz', '完成測驗');
    for (let i = 0; i < 12; i++) {
        const done = await page.evaluate(() => !document.getElementById('quiz-result').classList.contains('hidden'));
        if (done) break;
        const nextBtn = await page.$('#next-question-btn');
        const disabled = await page.evaluate(() => document.getElementById('next-question-btn').disabled);
        if (disabled) { const o = await page.$('.quiz-option'); if (o) await o.click(); await page.waitForTimeout(200); }
        await nextBtn.click().catch(() => {});
        await page.waitForTimeout(300);
    }
    const result = await page.evaluate(() => ({
        resultVisible: !document.getElementById('quiz-result').classList.contains('hidden'),
        finalScore: document.getElementById('final-score').textContent.trim(),
        summary: document.getElementById('quiz-summary').textContent.trim(),
        cls: document.getElementById('final-score').className
    }));
    ok(`測驗結果：${JSON.stringify(result)}`);
    if (!result.resultVisible) record('quiz', 'high', '題目走完後沒有顯示結果', '');
    if (!/\d+\/\d+/.test(result.finalScore)) record('quiz', 'medium', '最終分數格式異常', result.finalScore);
    await page.screenshot({ path: path.join(ASSETS, 'flow-quiz-result.png') });
    check();

    // 重新測驗
    check = trap(page, c, 'quiz', '重新測驗');
    await page.click('#restart-quiz-btn');
    await page.waitForTimeout(600);
    const restarted = await page.evaluate(() => document.getElementById('quiz-question').textContent.trim());
    if (!restarted) record('quiz', 'high', '「重新測驗」沒有重新開始', '');
    else ok(`重新測驗第 1 題：${restarted.slice(0, 60)}`);
    check();

    // 離開保護：現在走站內確認框（modules/ui.js confirmAction）
    check = trap(page, c, 'quiz', '離開保護');
    const stateOf = () => page.evaluate(async () => (await import('/modules/state.js')).quizInProgress);
    await page.click('#learning-btn');
    await page.waitForTimeout(800);
    const leaveModal = await page.evaluate(() => {
        const ov = document.querySelector('.options-modal-overlay');
        return ov ? { title: ov.querySelector('h3')?.textContent.trim(), confirm: ov.querySelector('#confirm-btn')?.textContent.trim(), cancel: ov.querySelector('#cancel-btn')?.textContent.trim() } : null;
    });
    ok(`離開確認框：${JSON.stringify(leaveModal)}（原生對話框 ${native.length} 個）`);
    if (!leaveModal) record('quiz', 'medium', '測驗進行中切換模組沒有離開確認', '');
    if (native.length) record('quiz', 'medium', '離開確認仍使用原生對話框', JSON.stringify(native));

    // 按「繼續測驗」應留在測驗頁
    await clickOptionsCancel(page);
    await page.waitForTimeout(600);
    const stillQuiz = await page.evaluate(() => document.getElementById('quiz-section').classList.contains('active'));
    const inProgressAfterStay = await stateOf();
    if (!stillQuiz) record('quiz', 'high', '離開確認按「繼續測驗」後仍離開測驗頁', '');
    else ok('繼續測驗後仍在測驗頁（正確）');
    if (inProgressAfterStay !== true) record('quiz', 'medium', '選擇留在測驗後 quizInProgress 被清掉', String(inProgressAfterStay));
    check();

    // 再切一次並確認離開 → 應真正結束測驗，且之後不再詢問
    check = trap(page, c, 'quiz', '離開並結束');
    await page.click('#learning-btn');
    await page.waitForTimeout(800);
    await clickOptionsConfirm(page);
    await page.waitForTimeout(800);
    const landed = await page.evaluate(() => Array.from(document.querySelectorAll('.section.active')).map(s => s.id));
    const inProgressAfterLeave = await stateOf();
    ok(`確認離開後落在 ${JSON.stringify(landed)}，quizInProgress=${inProgressAfterLeave}`);
    if (!landed.includes('learning-section')) record('quiz', 'high', '確認離開後沒有切換到目標模組', JSON.stringify(landed));
    if (inProgressAfterLeave !== false) {
        record('quiz', 'high', '確認離開後 state.quizInProgress 仍為 true，之後每次切換模組都會再彈一次確認（使用者被困住）', `quizInProgress=${inProgressAfterLeave}`);
    } else ok('確認離開後測驗狀態已清除');

    await page.click('#vocabulary-btn');
    await page.waitForTimeout(600);
    await page.click('#dictation-btn');
    await page.waitForTimeout(600);
    const extraPrompt = await confirmModalOpen(page);
    if (extraPrompt) record('quiz', 'high', '離開測驗後再切換模組仍跳出確認框', '');
    else ok('離開測驗後切換不再詢問');
    check();

    // 少於 4 個單詞
    await context.close();
    const few = await newPage(browser, { books: [{ id: 'small', name: '兩詞本', words: [{ id: 'a', word: 'cat', meaning: '猫' }, { id: 'b', word: 'dog', meaning: '狗' }] }] });
    const cf = makeCollector(few.page);
    const nativeFew = captureNativeDialogs(few.page);
    await few.page.goto(BASE + '#q', { waitUntil: 'domcontentloaded' });
    await few.page.waitForTimeout(1600);
    const fewCheck = trap(few.page, cf, 'quiz', '單詞不足');
    await few.page.click('#start-quiz-btn');
    await few.page.waitForTimeout(800);
    const fewToast = await few.page.evaluate(() => Array.from(document.querySelectorAll('#message-container .message-toast')).map(n => n.textContent.replace('×', '').trim()));
    ok(`單詞不足時提示：toast=${JSON.stringify(fewToast)} 原生對話框=${JSON.stringify(nativeFew)}`);
    if (!fewToast.length && !nativeFew.length) record('quiz', 'medium', '單詞不足 4 個時沒有任何提示', '');
    if (nativeFew.length) record('quiz', 'low', '單詞不足提示仍使用原生 alert', JSON.stringify(nativeFew));
    const started = await few.page.evaluate(() => document.getElementById('quiz-settings-container').classList.contains('hidden'));
    if (started) record('quiz', 'high', '單詞不足時仍進入測驗流程', '');
    fewCheck();
    await few.context.close();
}

// ============================================================ 文章
async function flowArticle(browser) {
    console.log('\n### 文章詳解');
    const { context, page } = await newPage(browser, {});
    const c = makeCollector(page);
    await page.goto(BASE + '#a', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1800);

    let check = trap(page, c, 'article', '初始');
    const initial = await page.evaluate(() => ({
        textarea: document.getElementById('article-input')?.value?.slice(0, 40),
        historyOptions: Array.from(document.getElementById('article-history-select')?.options || []).map(o => o.textContent),
        sourceBarVisible: document.getElementById('article-source-bar') ? getComputedStyle(document.getElementById('article-source-bar')).display !== 'none' : null,
        analysisHtml: document.getElementById('article-analysis-container')?.innerHTML.length
    }));
    ok(`初始：${JSON.stringify(initial)}`);
    check();

    // 文章庫
    check = trap(page, c, 'article', '文章庫');
    const libBtn = await page.$('#show-article-library-btn');
    if (!libBtn) record('article', 'high', '找不到文章庫按鈕', '');
    else {
        await libBtn.click();
        await page.waitForTimeout(1500);
        const lib = await page.evaluate(() => {
            const m = document.getElementById('article-library-modal');
            return {
                open: m && !m.classList.contains('hidden'),
                count: document.getElementById('article-library-count')?.textContent.trim(),
                items: Array.from(document.querySelectorAll('#article-library-list > *')).length,
                categories: Array.from(document.getElementById('article-category-filter')?.options || []).map(o => o.textContent)
            };
        });
        ok(`文章庫：${JSON.stringify(lib)}`);
        if (!lib.open) record('article', 'high', '文章庫彈窗未開啟', '');
        if (lib.items === 0) record('article', 'high', '內建文章庫清單為空（articles/manifest.json 未被讀取？）', JSON.stringify(lib));
        await page.screenshot({ path: path.join(ASSETS, 'flow-article-library.png') });
        // 選第一篇文章
        if (lib.items > 0) {
            await page.evaluate(() => {
                const first = document.querySelector('#article-library-list button, #article-library-list li, #article-library-list > *');
                if (first) first.click();
            });
            await page.waitForTimeout(2500);
            const loaded = await page.evaluate(() => ({
                input: document.getElementById('article-input')?.value?.length,
                history: document.getElementById('article-history-select')?.value,
                analysisLen: document.getElementById('article-analysis-container')?.innerHTML.length,
                modalOpen: !document.getElementById('article-library-modal').classList.contains('hidden')
            }));
            ok(`載入文章後：${JSON.stringify(loaded)}`);
            if (!loaded.input) record('article', 'high', '從文章庫選擇後文章輸入框仍為空', JSON.stringify(loaded));
            if (loaded.analysisLen < 50) record('article', 'medium', '從文章庫載入後沒有渲染任何分析內容（需要 AI，離線時應有提示）', `len=${loaded.analysisLen}`);
            await page.screenshot({ path: path.join(ASSETS, 'flow-article-loaded.png') });
        }
    }
    check();

    // 分類篩選
    const catCount = await page.evaluate(() => document.getElementById('article-category-filter')?.options.length || 0);
    ok(`分類數：${catCount}`);

    // 直接送分析（AI 離線）
    check = trap(page, c, 'article', '送分析');
    await page.evaluate(() => {
        const ta = document.getElementById('article-input');
        ta.value = 'The quick brown fox jumps over the lazy dog. This sentence contains every letter of the alphabet.';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.click('#analyze-article-btn').catch(() => {});
    await page.waitForTimeout(4000);
    const analyzeResult = await page.evaluate(() => ({
        container: document.getElementById('article-analysis-container')?.innerHTML.length,
        text: document.getElementById('article-analysis-container')?.textContent.trim().replace(/\s+/g, ' ').slice(0, 200)
    }));
    ok(`分析結果：${JSON.stringify(analyzeResult)}`);
    if (analyzeResult.container < 30) record('article', 'high', 'AI 不可用時分析區完全空白，沒有錯誤提示', JSON.stringify(analyzeResult));
    check();

    // 空文章送出
    check = trap(page, c, 'article', '空文章');
    await page.evaluate(() => {
        const ta = document.getElementById('article-input');
        ta.value = '';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.click('#analyze-article-btn').catch(() => {});
    await page.waitForTimeout(1200);
    ok(`空文章送出提示：${JSON.stringify(await toastText(page))}`);
    check();

    // 清空
    check = trap(page, c, 'article', '清空');
    await page.click('#clear-article-btn').catch(() => {});
    await page.waitForTimeout(800);
    const cleared = await page.evaluate(() => document.getElementById('article-input')?.value);
    ok(`清空後輸入框長度：${cleared?.length}`);
    check();

    // 朗讀控制
    check = trap(page, c, 'article', '朗讀');
    const readBtn = await page.$('#read-article-btn');
    if (readBtn) {
        const disabled = await page.evaluate(() => document.getElementById('read-article-btn').disabled);
        ok(`朗讀按鈕 disabled=${disabled}`);
        if (!disabled) {
            await readBtn.click().catch(() => {});
            await page.waitForTimeout(1500);
            const reading = await page.evaluate(() => ({
                stopVisible: !document.getElementById('stop-read-article-btn').classList.contains('hidden'),
                chunkNav: document.getElementById('chunk-nav-controls') ? getComputedStyle(document.getElementById('chunk-nav-controls')).display : null
            }));
            ok(`朗讀中：${JSON.stringify(reading)}`);
        }
    }
    check();

    // 歷史記錄下拉
    check = trap(page, c, 'article', '歷史記錄');
    await page.click('#manage-history-btn').catch(() => {});
    await page.waitForTimeout(800);
    const histModal = await page.evaluate(() => ({
        open: !document.getElementById('app-modal').classList.contains('hidden'),
        title: document.getElementById('modal-title').textContent.trim(),
        body: document.getElementById('modal-body').textContent.trim().replace(/\s+/g, ' ').slice(0, 150)
    }));
    ok(`歷史管理：${JSON.stringify(histModal)}`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    check();

    await page.screenshot({ path: path.join(ASSETS, 'flow-article-desktop.png') });
    await context.close();
}

// ============================================================ OCR
async function flowOcr(browser) {
    console.log('\n### 圖片識別');
    const { context, page } = await newPage(browser, {});
    const c = makeCollector(page);
    await page.goto(BASE + '#ocr', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1600);

    let check = trap(page, c, 'ocr', '初始');
    const initial = await page.evaluate(() => ({
        modelOptions: Array.from(document.getElementById('ocr-model-select')?.options || []).map(o => ({ v: o.value, t: o.textContent })),
        runDisabled: document.getElementById('ocr-run-btn')?.disabled,
        displayMode: document.getElementById('ocr-display-mode')?.value,
        preferCamera: document.getElementById('ocr-prefer-camera')?.checked,
        hint: document.getElementById('ocr-hint')?.textContent.trim().slice(0, 100)
    }));
    ok(`OCR 初始：${JSON.stringify(initial)}`);
    if (!initial.modelOptions.length) record('ocr', 'high', 'OCR 模型下拉為空', '');
    check();

    // 無圖片直接執行
    check = trap(page, c, 'ocr', '無圖片執行');
    await page.click('#ocr-run-btn').catch(() => {});
    await page.waitForTimeout(1200);
    const noImgMsg = await toastText(page);
    ok(`無圖片執行提示：${JSON.stringify(noImgMsg)}`);
    if (!noImgMsg.length) record('ocr', 'medium', '沒有選圖就按「開始識別」沒有任何提示', '');
    check();

    // 用真實圖片檔測試（透過 file input）
    check = trap(page, c, 'ocr', '選圖');
    const input = await page.$('#ocr-image-input');
    if (input) {
        await input.setInputFiles(path.join(ROOT, '5AU1_1.jpg'));
        await page.waitForTimeout(2500);
        const preview = await page.evaluate(() => ({
            items: document.querySelectorAll('#ocr-preview-list > *').length,
            runDisabled: document.getElementById('ocr-run-btn')?.disabled,
            thumbLen: document.querySelectorAll('#ocr-preview-list img').length,
            anySrc: Array.from(document.querySelectorAll('#ocr-preview-list img')).map(i => i.src.slice(0, 30))
        }));
        ok(`選圖後：${JSON.stringify(preview)}`);
        if (preview.thumbLen === 0) record('ocr', 'high', '選圖後沒有縮圖預覽', JSON.stringify(preview));
        await page.screenshot({ path: path.join(ASSETS, 'flow-ocr-selected.png') });
        // 執行 OCR（AI 離線，應有錯誤處理）
        await page.click('#ocr-run-btn').catch(() => {});
        await page.waitForTimeout(5000);
        const runResult = await page.evaluate(() => ({
            progress: document.getElementById('ocr-progress-text')?.textContent.trim(),
            // #ocr-result 是 textarea，失敗細節寫在 value 而不是 textContent
            result: (document.getElementById('ocr-result')?.value || '').slice(0, 200),
            toasts: Array.from(document.querySelectorAll('#message-container .message-toast')).map(n => ({ txt: n.textContent.replace('×', '').trim(), cls: n.className })),
            progressRowVisible: document.getElementById('ocr-progress-row') ? getComputedStyle(document.getElementById('ocr-progress-row')).display !== 'none' : null
        }));
        ok(`OCR 執行後：${JSON.stringify(runResult)}`);
        if (!runResult.result) record('ocr', 'medium', 'OCR 失敗時沒有任何錯誤文案', JSON.stringify(runResult));
        const failedToast = runResult.toasts.find(x => /失败\s*[1-9]|识别失败/.test(x.txt));
        if (failedToast && /success/.test(failedToast.cls)) {
            record('ocr', 'medium', 'OCR 全部失敗時提示仍是 success 樣式，使用者會誤以為成功', JSON.stringify(failedToast));
        }
        await page.screenshot({ path: path.join(ASSETS, 'flow-ocr-after-run.png') });
        // 清空
        await page.click('#ocr-clear-btn').catch(() => {});
        await page.waitForTimeout(800);
        const afterClear = await page.evaluate(() => document.querySelectorAll('#ocr-preview-list > *').length);
        if (afterClear !== 0) record('ocr', 'medium', '「清空」後仍有預覽項目', afterClear);
        else ok('清空成功');
    } else record('ocr', 'high', '找不到 #ocr-image-input', '');
    check();

    // 顯示模式切換
    check = trap(page, c, 'ocr', '顯示模式');
    const modes = await page.evaluate(() => Array.from(document.getElementById('ocr-display-mode')?.options || []).map(o => o.value));
    for (const mode of modes) {
        await page.selectOption('#ocr-display-mode', mode).catch(() => {});
        await page.waitForTimeout(300);
    }
    ok(`顯示模式切換完成：${JSON.stringify(modes)}`);
    check();

    await context.close();
}

// ============================================================ 問答訓練
async function flowQa(browser) {
    console.log('\n### 問答訓練');
    const { context, page } = await newPage(browser, {});
    const c = makeCollector(page);
    await page.goto(BASE + '#qa', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);

    let check = trap(page, c, 'qa', '初始');
    const initial = await page.evaluate(() => ({
        managementVisible: getComputedStyle(document.getElementById('qa-management-area')).display !== 'none',
        setItems: document.querySelectorAll('#qa-sets-list > *').length,
        listText: document.getElementById('qa-sets-list')?.textContent.trim().replace(/\s+/g, ' ').slice(0, 200)
    }));
    ok(`QA 初始：${JSON.stringify(initial)}`);
    if (initial.setItems === 0) record('qa', 'medium', '問答集清單為空（預置問答集未載入？）', JSON.stringify(initial));
    check();

    // 建立問答集
    check = trap(page, c, 'qa', '建立問答集');
    await page.click('#create-qa-set-btn');
    await page.waitForTimeout(600);
    const creator = await page.evaluate(() => ({
        visible: getComputedStyle(document.getElementById('qa-creator-area')).display !== 'none',
        templates: Array.from(document.getElementById('qa-template-select')?.options || []).map(o => o.textContent).slice(0, 5)
    }));
    ok(`建立器：${JSON.stringify(creator)}`);
    if (!creator.visible) record('qa', 'high', '「创建问答集」沒有顯示建立表單', '');

    await page.fill('#qa-set-name', '巡檢問答集');
    await page.fill('#qa-set-description', '自動化巡檢用');
    await page.fill('#qa-pairs-input', 'What is your name?\nMy name is Tom.\n\nHow old are you?\nI am ten years old.');
    await page.waitForTimeout(500);
    const preview = await visibleText(page, '#qa-preview');
    ok(`問答預覽：${String(preview).slice(0, 150)}`);
    if (!preview) record('qa', 'medium', '問答對輸入後沒有預覽', '');
    await page.screenshot({ path: path.join(ASSETS, 'flow-qa-creator.png') });
    await page.click('#save-qa-set-btn');
    await page.waitForTimeout(1200);
    const saved = await page.evaluate(() => ({
        sets: JSON.parse(localStorage.getItem('qa-sets') || '[]').map(s => s.name),
        managementVisible: getComputedStyle(document.getElementById('qa-management-area')).display !== 'none'
    }));
    ok(`儲存後：${JSON.stringify(saved)}`);
    if (!saved.sets.includes('巡檢問答集')) record('qa', 'high', '新增問答集未寫入 localStorage', JSON.stringify(saved));
    check();

    // 奇數行輸入：保存前必須先出現「有內容沒有被採用」的確認框（不是存完才通知）
    check = trap(page, c, 'qa', '奇數行輸入');
    await page.click('#create-qa-set-btn');
    await page.waitForTimeout(500);
    await page.fill('#qa-set-name', '奇數測試');
    await page.fill('#qa-pairs-input', 'Q1?\nA1.\nQ2?');
    await page.waitForTimeout(400);
    await page.click('#save-qa-set-btn');
    await page.waitForTimeout(700);
    const warnDialog = await page.evaluate(() => {
        const ov = document.querySelector('.options-modal-overlay');
        return ov ? {
            title: ov.querySelector('#om-title, h3')?.textContent.trim(),
            message: ov.querySelector('.om-desc, p')?.textContent.trim(),
            confirm: ov.querySelector('#confirm-btn')?.textContent.trim(),
            cancel: ov.querySelector('#cancel-btn')?.textContent.trim()
        } : null;
    });
    ok(`落單行保存確認框：${JSON.stringify(warnDialog)}`);
    if (!warnDialog || !/沒有對應|没有对应/.test(warnDialog.message || '')) {
        record('qa', 'medium', '落單行內容在保存前沒有提示，使用者會以為全部存好了', JSON.stringify(warnDialog));
    }
    // 選「返回修改」→ 不得寫入
    await clickOptionsCancel(page);
    await page.waitForTimeout(500);
    const afterBack = await page.evaluate(() => JSON.parse(localStorage.getItem('qa-sets') || '[]').map(s => s.name));
    ok(`返回修改後：${JSON.stringify(afterBack)}`);
    if (afterBack.includes('奇數測試')) {
        record('qa', 'high', '按「返回修改」仍寫入了問答集', JSON.stringify(afterBack));
    }
    // 再按一次保存並確認 → 才寫入（只含已配對的題目）
    await page.click('#save-qa-set-btn');
    await page.waitForTimeout(700);
    await clickOptionsConfirm(page);
    await page.waitForTimeout(900);
    const oddSaved = await page.evaluate(() => JSON.parse(localStorage.getItem('qa-sets') || '[]').map(s => s.name));
    ok(`奇數行儲存後：${JSON.stringify(oddSaved)}`);
    const oddToast = await toastText(page);
    ok(`奇數行提示：${JSON.stringify(oddToast)}`);
    await page.click('#cancel-qa-creator-btn').catch(() => {});
    await page.waitForTimeout(400);
    check();

    // 開始訓練
    check = trap(page, c, 'qa', '開始訓練');
    await page.evaluate(() => {
        const startBtn = Array.from(document.querySelectorAll('#qa-sets-list button.start-training-btn'))
            .find(b => /開始|开始/.test(b.textContent));
        if (startBtn) startBtn.click();
    });
    await page.waitForTimeout(900);
    // 開始訓練會先彈出「訓練設置」選項彈窗，需確認
    const setupModal = await page.evaluate(() => {
        const ov = document.querySelector('.options-modal-overlay');
        return ov ? { title: ov.querySelector('h3')?.textContent.trim(), confirm: ov.querySelector('#confirm-btn')?.textContent.trim() } : null;
    });
    ok(`訓練設置彈窗：${JSON.stringify(setupModal)}`);
    if (!setupModal) record('qa', 'medium', '點「开始训练」沒有出現訓練設置彈窗', '');
    // 訓練預設是「一次列出全部」(layout=list)，此時單題作答區 (.qa-question-area) 是刻意隱藏的。
    // 本流程要驗證的是逐題作答，因此先選「逐题」(layout=single) 再確認。
    const pickedSingle = await page.evaluate(() => {
        const radios = Array.from(document.querySelectorAll('.options-modal-overlay input[type="radio"]'));
        const single = radios.find(r => r.value === 'single');
        if (!single) return false;
        single.checked = true;
        return true;
    });
    ok(`已選擇逐題模式：${pickedSingle}`);
    if (!pickedSingle) record('qa', 'medium', '訓練設置彈窗找不到「逐题」選項，無法逐題作答', '');
    await clickOptionsConfirm(page);
    await page.waitForTimeout(1500);
    const training = await page.evaluate(() => ({
        trainingVisible: getComputedStyle(document.getElementById('qa-training-area')).display !== 'none',
        question: document.getElementById('qa-current-question')?.textContent.trim(),
        progress: document.getElementById('qa-progress-text')?.textContent.trim(),
        modelOptions: Array.from(document.getElementById('qa-model-select')?.options || []).length
    }));
    ok(`訓練中：${JSON.stringify(training)}`);
    if (!training.trainingVisible) record('qa', 'high', '點「開始訓練」沒有進入訓練畫面', '');
    if (!training.modelOptions) record('qa', 'medium', 'QA 校對模型下拉為空', '');
    check();

    // 作答 + 校對（AI 離線）
    check = trap(page, c, 'qa', '作答校對');
    await page.fill('#qa-answer-input', 'My name is Tom.');
    await page.click('#submit-and-check-btn').catch(() => {});
    await page.waitForTimeout(4000);
    const feedback = await page.evaluate(() => ({
        feedVisible: getComputedStyle(document.getElementById('qa-instant-feedback')).display !== 'none',
        content: document.getElementById('qa-instant-feedback-content')?.textContent.trim().slice(0, 150)
    }));
    ok(`本題回饋：${JSON.stringify(feedback)}`);
    if (feedback.feedVisible && !feedback.content) record('qa', 'medium', 'AI 校對失敗時回饋框是空的', '');
    if (!feedback.feedVisible) record('qa', 'medium', 'AI 校對失敗時沒有顯示任何回饋或錯誤', '');
    check();

    // 上一題 / 下一題
    check = trap(page, c, 'qa', '題目切換');
    const q1 = await visibleText(page, '#qa-current-question');
    ok(`下一題點擊：${await clickWhenReady(page, '#next-qa-btn')}`);
    await page.waitForTimeout(700);
    const q2 = await visibleText(page, '#qa-current-question');
    ok(`下一題：${q1} -> ${q2}`);
    ok(`上一題點擊：${await clickWhenReady(page, '#prev-qa-btn')}`);
    await page.waitForTimeout(700);
    const q3 = await visibleText(page, '#qa-current-question');
    if (q3 !== q1) record('qa', 'medium', '「上一題」沒有回到原題目', `${q1} -> ${q3}`);
    // 首題再按上一題
    await clickWhenReady(page, '#prev-qa-btn');
    await page.waitForTimeout(500);
    ok(`首題再按上一題：${await visibleText(page, '#qa-current-question')}`);
    // 未作答就下一題
    const answerKept = await page.evaluate(() => document.getElementById('qa-answer-input').value);
    ok(`切題後答案框內容：${JSON.stringify(answerKept)}`);
    check();

    // 進度持久化
    const progress = await page.evaluate(() => localStorage.getItem('qa-training-progress'));
    if (!progress) record('qa', 'medium', '訓練中沒有寫入 qa-training-progress', '');
    else ok(`訓練進度已持久化：${String(progress).slice(0, 120)}`);
    await page.screenshot({ path: path.join(ASSETS, 'flow-qa-training.png') });

    // 完成訓練 → 報告（有未作答題目時會先出現站內確認框）
    check = trap(page, c, 'qa', '完成訓練');
    await page.click('#finish-training-btn').catch(() => {});
    await page.waitForTimeout(900);
    const finishConfirm = await page.evaluate(() => {
        const ov = document.querySelector('.options-modal-overlay');
        return ov ? { title: ov.querySelector('h3')?.textContent.trim(), desc: ov.querySelector('.om-desc')?.textContent.trim() } : null;
    });
    ok(`完成訓練確認框：${JSON.stringify(finishConfirm)}`);
    if (finishConfirm) { await clickOptionsConfirm(page); }
    await page.waitForTimeout(3000);
    const report = await page.evaluate(() => ({
        reportVisible: getComputedStyle(document.getElementById('qa-report-area')).display !== 'none',
        details: document.getElementById('qa-detailed-results')?.textContent.trim().replace(/\s+/g, ' ').slice(0, 200),
        summaryDisplay: document.querySelector('.report-summary') ? getComputedStyle(document.querySelector('.report-summary')).display : null,
        clearProgress: localStorage.getItem('qa-training-progress')
    }));
    ok(`報告：${JSON.stringify(report)}`);
    if (!report.reportVisible) record('qa', 'high', '「完成訓練」後沒有顯示報告', '');
    if (!report.details) record('qa', 'medium', '報告沒有任何內容', '');
    if (report.clearProgress) record('qa', 'medium', '完成訓練後 qa-training-progress 未清除', String(report.clearProgress).slice(0, 80));
    await page.screenshot({ path: path.join(ASSETS, 'flow-qa-report.png'), fullPage: true });
    check();

    // 報告頁按鈕
    check = trap(page, c, 'qa', '報告操作');
    await page.click('#toggle-all-details-btn').catch(() => {});
    await page.waitForTimeout(500);
    ok(`收起/展開鈕文字：${await visibleText(page, '#toggle-all-details-btn')}`);
    await page.click('#copy-report-btn').catch(() => {});
    await page.waitForTimeout(1200);
    ok(`複製報告提示：${JSON.stringify(await toastText(page))}`);
    await page.click('#retry-training-btn').catch(() => {});
    await page.waitForTimeout(1000);
    const retry = await page.evaluate(() => getComputedStyle(document.getElementById('qa-training-area')).display !== 'none');
    ok(`重新訓練可見：${retry}`);
    await page.click('#back-to-qa-menu-btn').catch(() => {});
    await page.waitForTimeout(800);
    ok(`返回主選單後管理區可見：${await page.evaluate(() => getComputedStyle(document.getElementById('qa-management-area')).display !== 'none')}`);
    check();

    // 匯入問答集
    check = trap(page, c, 'qa', '匯入');
    await page.click('#import-qa-set-btn').catch(() => {});
    await page.waitForTimeout(800);
    const importModal = await page.evaluate(() => ({
        open: !document.getElementById('app-modal').classList.contains('hidden'),
        title: document.getElementById('modal-title').textContent.trim()
    }));
    ok(`匯入彈窗：${JSON.stringify(importModal)}`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    check();

    // 刪除問答集
    check = trap(page, c, 'qa', '刪除問答集');
    await page.evaluate(() => {
        const del = Array.from(document.querySelectorAll('#qa-sets-list button')).find(b => /刪除|删除/.test(b.textContent));
        if (del) del.click();
    });
    await page.waitForTimeout(800);
    await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const b = btns.find(x => /danger|confirm/.test(x.className) && x.offsetParent !== null);
        if (b) b.click();
    });
    await page.waitForTimeout(900);
    ok(`刪除後問答集：${JSON.stringify(await page.evaluate(() => JSON.parse(localStorage.getItem('qa-sets') || '[]').map(s => s.name)))}`);
    check();

    // 手機版
    await context.close();
    const m = await newPage(browser, { viewport: 'mobile' });
    const cm = makeCollector(m.page);
    await m.page.goto(BASE + '#qa', { waitUntil: 'domcontentloaded' });
    await m.page.waitForTimeout(2500);
    const mc = trap(m.page, cm, 'qa', '手機 QA');
    const overflow = await m.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 2) record('qa', 'medium', `手機 QA 頁水平溢出 ${overflow}px`, '');
    await m.page.screenshot({ path: path.join(ASSETS, 'flow-qa-mobile.png'), fullPage: true });
    mc();
    await m.context.close();
}

// ============================================================ 設定 / 同步
async function flowSettings(browser) {
    console.log('\n### 設定與同步');
    const { context, page } = await newPage(browser, {});
    const c = makeCollector(page);
    await boot(page);

    let check = trap(page, c, 'settings', '齒輪選單');
    await page.click('#app-gear-btn');
    await page.waitForTimeout(700);
    const menu = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('body > *, main *')).filter(el => {
            const cs = getComputedStyle(el);
            return cs.position === 'fixed' && cs.display !== 'none' && el.offsetWidth > 50 && el.offsetHeight > 30 &&
                /\b(menu|popover|dropdown|gear|settings)\b/i.test(el.className || '');
        });
        return els.map(e => ({ cls: e.className, items: Array.from(e.querySelectorAll('button, a')).map(b => b.textContent.trim()).slice(0, 12) }));
    });
    ok(`齒輪選單：${JSON.stringify(menu).slice(0, 400)}`);
    if (!menu.length) record('settings', 'high', '點齒輪沒有任何選單出現', '');
    await page.screenshot({ path: path.join(ASSETS, 'flow-settings-menu.png') });
    check();

    // 找語言切換
    check = trap(page, c, 'settings', '語言切換');
    const switched = await page.evaluate(async () => {
        // 直接呼叫模組 API 較可靠
        const mod = await import('/modules/i18n.js');
        mod.setLocale('zh-HK');
        return { locale: mod.getLocale(), lang: document.documentElement.lang, navText: document.querySelector('#vocabulary-btn .nav-label-full')?.textContent };
    }).catch(e => ({ error: String(e) }));
    ok(`切 zh-HK：${JSON.stringify(switched)}`);
    if (switched.lang !== 'zh-HK') record('i18n', 'high', 'setLocale("zh-HK") 沒有更新 html lang', JSON.stringify(switched));
    // 檢查是否留下任何未翻譯的簡體文案
    const residual = await page.evaluate(() => {
        const out = [];
        // 這裡列的必須是「只在簡體出現」的字。`制` 兩邊同形（控制、制度…），
        // 先前誤收進來，於是 zh-HK 的「朗讀控制」被報成殘留簡體。
        const simp = /[从个为说话学习时间单词书页题选择录图识别关闭开启动复]/;
        document.querySelectorAll('body *').forEach(el => {
            if (el.children.length) return;
            const txt = (el.textContent || '').trim();
            if (txt && txt.length < 40 && simp.test(txt)) out.push(`${el.tagName}#${el.id || ''} = ${txt}`);
        });
        return out.slice(0, 25);
    });
    if (residual.length) record('i18n', 'medium', `切到 zh-HK 後仍有疑似簡體文案（${residual.length}）`, residual.join(' | '));
    else ok('切到 zh-HK 後未發現殘留簡體');
    const backToCN = await page.evaluate(async () => {
        const mod = await import('/modules/i18n.js');
        mod.setLocale('zh-CN');
        return document.documentElement.lang;
    });
    ok(`切回 zh-CN：${backToCN}`);
    check();

    // 主題
    check = trap(page, c, 'settings', '主題');
    const theme = await page.evaluate(async () => {
        const mod = await import('/modules/theme.js');
        return typeof mod;
    }).catch(e => String(e));
    const themeAttr = await page.evaluate(() => ({
        attr: document.documentElement.getAttribute('data-theme'),
        cls: document.documentElement.className,
        stored: localStorage.getItem('pen_theme') || localStorage.getItem('bdc-theme')
    }));
    ok(`主題狀態：${JSON.stringify(themeAttr)}`);
    check();

    // 同步區
    check = trap(page, c, 'sync', '同步列');
    const syncUI = await page.evaluate(() => {
        const s = document.getElementById('sync-status');
        return {
            status: s ? s.textContent.trim() : null,
            statusVisible: s ? getComputedStyle(s).display !== 'none' : null,
            loginBtnText: document.getElementById('login-btn')?.textContent.trim(),
            syncBtnText: document.getElementById('sync-now-btn')?.textContent.trim(),
            loginHidden: document.getElementById('login-btn')?.offsetParent === null
        };
    });
    ok(`同步 UI：${JSON.stringify(syncUI)}`);
    check();

    // 未登入按同步
    check = trap(page, c, 'sync', '未登入同步');
    await page.click('#sync-now-btn').catch(() => {});
    await page.waitForTimeout(1500);
    ok(`未登入按同步提示：${JSON.stringify(await toastText(page))}`);
    check();

    // 登入彈窗
    check = trap(page, c, 'sync', '登入彈窗');
    const loginVisible = await page.evaluate(() => {
        const b = document.getElementById('login-btn');
        return b && b.offsetParent !== null;
    });
    if (loginVisible) {
        await page.click('#login-btn');
        await page.waitForTimeout(1000);
        const modal = await page.evaluate(() => ({
            open: !document.getElementById('app-modal').classList.contains('hidden'),
            title: document.getElementById('modal-title').textContent.trim(),
            bodyLen: document.getElementById('modal-body').textContent.trim().length
        }));
        ok(`登入彈窗：${JSON.stringify(modal)}`);
        if (!modal.open) record('sync', 'high', '點「登入」沒有開啟登入彈窗', '');
        await page.screenshot({ path: path.join(ASSETS, 'flow-sync-login.png') });
        // 空送出
        await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('#modal-actions button'));
            const primary = btns.find(b => /primary/.test(b.className)) || btns[btns.length - 1];
            if (primary) primary.click();
        });
        await page.waitForTimeout(1200);
        ok(`空通行碼送出後提示：${JSON.stringify(await toastText(page))}`);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(400);
    } else ok('登入按鈕目前不可見（可能已登入）');
    check();

    await context.close();
}

// ============================================================ TTS / 音訊
async function flowAudio(browser) {
    console.log('\n### 語音與朗讀');
    const { context, page } = await newPage(browser, {});
    const c = makeCollector(page);
    await boot(page);

    const check = trap(page, c, 'audio', '語音清單');
    const voices = await page.evaluate(async () => {
        try {
            const mod = await import('/modules/voices.js');
            return { exports: Object.keys(mod) };
        } catch (e) { return { error: String(e) }; }
    });
    ok(`voices 模組：${JSON.stringify(voices)}`);

    const voiceResp = await page.evaluate(async () => {
        const r = await fetch('/voices.min.json');
        const j = await r.json();
        return { status: r.status, count: Array.isArray(j) ? j.length : (j.voices ? j.voices.length : Object.keys(j).length) };
    });
    ok(`voices.min.json：${JSON.stringify(voiceResp)}`);
    await context.close();
}

// ============================================================ 無障礙
async function flowA11y(browser) {
    console.log('\n### 無障礙與可用性');
    const { context, page } = await newPage(browser, {});
    await boot(page);

    for (const mod of ['vocabulary', 'dictation', 'learning', 'qa', 'article', 'ocr', 'quiz']) {
        await page.goto(`${BASE}#${mod}`, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1200);
        const audit = await page.evaluate(() => {
            const out = { noName: [], imgNoAlt: [], smallTargets: [], dupIds: [] };
            const seenIds = new Set();
            document.querySelectorAll('body *').forEach(el => {
                if (el.id) { if (seenIds.has(el.id)) out.dupIds.push(el.id); seenIds.add(el.id); }
            });
            document.querySelectorAll('button, [role="button"], a[href], input, select, textarea').forEach(el => {
                const cs = getComputedStyle(el);
                if (cs.display === 'none' || cs.visibility === 'hidden' || el.offsetParent === null) return;
                // aria-hidden="true" 的節點本來就被排除在無障礙樹之外（例如 #ocr-prefer-camera
                // 只是 #ocr-prefer-toggle 按鈕的狀態容器），不需要可訪問名稱。
                if (el.getAttribute('aria-hidden') === 'true' || el.closest('[aria-hidden="true"]')) return;
                const r = el.getBoundingClientRect();
                // sr-only 這類「只給輔助技術」的節點會渲染成 1px；它們本來就不打算被看見，
                // 真正的控制項另有其物（例如 #ocr-prefer-camera 對應 #ocr-prefer-toggle）。
                if (r.width <= 2 || r.height <= 2) return;

                // 可訪問名稱要按無障礙演算法取：aria-label → aria-labelledby →
                // <label for> → 外層 <label> → 自身文字 → title/placeholder。
                // 先前只看自身 textContent，於是所有用自己的 <label for> 標註的
                // 單選框、文字輸入都被誤報成「沒有無障礙名稱」。
                const accName = (() => {
                    const al = (el.getAttribute('aria-label') || '').trim();
                    if (al) return al;
                    const lb = (el.getAttribute('aria-labelledby') || '').trim();
                    if (lb) {
                        const joined = lb.split(/\s+/)
                            .map(id => document.getElementById(id)?.textContent || '')
                            .join(' ').trim();
                        if (joined) return joined;
                    }
                    if (el.id) {
                        const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
                        const t = (lab?.textContent || '').trim();
                        if (t) return t;
                    }
                    const wrap = el.closest('label');
                    if (wrap) { const t = (wrap.textContent || '').trim(); if (t) return t; }
                    const own = (el.textContent || '').trim();
                    if (own) return own;
                    return (el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('alt') || '').trim();
                })();
                if (!accName) out.noName.push(`${el.tagName}#${el.id || ''}.${(el.className || '').toString().split(' ')[0]}`);
                if (el.tagName === 'BUTTON' && (r.width < 24 || r.height < 24)) {
                    out.smallTargets.push(`${el.tagName}#${el.id || ''} ${Math.round(r.width)}x${Math.round(r.height)}`);
                }
            });
            document.querySelectorAll('img').forEach(img => {
                if (!img.hasAttribute('alt')) out.imgNoAlt.push(img.src.slice(-40));
            });
            return out;
        });
        if (audit.noName.length) record('a11y', 'medium', `[${mod}] 有可互動元素沒有無障礙名稱`, audit.noName.slice(0, 8).join(' | '));
        if (audit.imgNoAlt.length) record('a11y', 'low', `[${mod}] 圖片缺少 alt`, audit.imgNoAlt.slice(0, 5).join(' | '));
        if (audit.smallTargets.length) record('a11y', 'low', `[${mod}] 點擊目標小於 24px`, audit.smallTargets.slice(0, 5).join(' | '));
        if (audit.dupIds.length) record('a11y', 'medium', `[${mod}] 重複的 DOM id`, [...new Set(audit.dupIds)].join(' | '));
    }

    // 鍵盤導覽
    const kb = await page.evaluate(() => {
        const focusable = Array.from(document.querySelectorAll('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
            .filter(el => el.offsetParent !== null);
        const negative = focusable.filter(el => el.tabIndex < 0).length;
        return { focusable: focusable.length, negative };
    });
    ok(`可聚焦元素：${JSON.stringify(kb)}`);

    // 對比度：粗略檢查主要文字
    const contrast = await page.evaluate(() => {
        function lum(c) {
            const m = c.match(/\d+(\.\d+)?/g);
            if (!m) return null;
            const [r, g, b] = m.slice(0, 3).map(Number).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
            return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        }
        function bgOf(el) {
            let cur = el;
            while (cur && cur !== document.documentElement) {
                const c = getComputedStyle(cur).backgroundColor;
                if (c && !/rgba?\(0, 0, 0, 0\)/.test(c)) return c;
                cur = cur.parentElement;
            }
            return 'rgb(255,255,255)';
        }
        const out = [];
        document.querySelectorAll('p, span, li, label, h1,h2,h3,h4, button, a').forEach(el => {
            if (el.children.length || el.offsetParent === null) return;
            const txt = (el.textContent || '').trim();
            if (txt.length < 2) return;
            const cs = getComputedStyle(el);
            const l1 = lum(cs.color), l2 = lum(bgOf(el));
            if (l1 === null || l2 === null) return;
            const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
            const size = parseFloat(cs.fontSize);
            const large = size >= 24 || (size >= 18.66 && parseInt(cs.fontWeight, 10) >= 700);
            const need = large ? 3 : 4.5;
            if (ratio < need) out.push(`${el.tagName}${el.id ? '#' + el.id : ''} "${txt.slice(0, 20)}" ${ratio.toFixed(2)}:1 (需 ${need}) 前景 ${cs.color} 背景 ${bgOf(el)}`);
        });
        return out.slice(0, 15);
    });
    if (contrast.length) record('a11y', 'low', `文字對比度不足（${contrast.length} 處）`, contrast.join(' | '));
    else ok('未發現明顯對比度問題');

    await context.close();
}

(async () => {
    const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
    const flows = [
        ['vocabulary', flowVocabulary],
        ['learning', flowLearning],
        ['dictation', flowDictation],
        ['quiz', flowQuiz],
        ['article', flowArticle],
        ['ocr', flowOcr],
        ['qa', flowQa],
        ['settings', flowSettings],
        ['audio', flowAudio],
        ['a11y', flowA11y]
    ];
    try {
        for (const [name, fn] of flows) {
            if (!should(name)) continue;
            try { await fn(browser); } catch (e) {
                record(name, 'high', '巡檢流程本身拋出例外（可能是產品缺陷）', e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e));
            }
        }
    } finally {
        await browser.close();
    }

    const out = path.join(ASSETS, 'flows.json');
    fs.writeFileSync(out, JSON.stringify({ findings, generatedAt: new Date().toISOString() }, null, 2));
    console.log(`\n=== 共 ${findings.length} 項發現 ===`);
    const bySev = findings.reduce((a, f) => (a[f.severity] = (a[f.severity] || 0) + 1, a), {});
    console.log('嚴重度分布:', bySev, '->', out);
})();
