/**
 * 獨立核查報告專項複驗
 *
 * 對象：docs/report/20261016125252220_Session383獨立核查報告.md 所列的四項主要問題與一項次要發現。
 *
 *   R1 詞書名稱輸出入口的 HTML 注入（合併窗口、補全缺失、編輯詞書、匯入清單）
 *   R2 編號（Q1:/A1:）格式的問答內容被靜默丟棄
 *   R3 彈窗開啟時提示條（Toast）被遮罩壓住、關閉鈕不可點
 *   R4 聽寫批改歷史「清空全部」沒有反應（外部入口 + 彈窗內入口）
 *   R5 OCR 完成／失敗態的按鈕文字是否真的顯示出來
 *
 * 用法：
 *   PORT=8400 \
 *   CHROME_PATH="$HOME/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell" \
 *   PLAYWRIGHT_MODULE="$(npm root -g)/@playwright/cli/node_modules/playwright" \
 *   node tests/audit-review-report.cjs
 *
 * 退出碼：0 = 全部通過；1 = 有未通過項目。
 */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8400);
const BASE = `http://127.0.0.1:${PORT}/`;
const ROOT = path.resolve(__dirname, '..');
const ASSETS = path.join(ROOT, 'docs', 'report', 'root-audit');
fs.mkdirSync(ASSETS, { recursive: true });
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const results = [];
function pass(id, title, detail) {
    results.push({ id, title, status: 'pass', detail: String(detail === undefined ? '' : detail) });
    console.log(`  PASS  [${id}] ${title}${detail ? ' — ' + String(detail).slice(0, 200) : ''}`);
}
function fail(id, title, detail) {
    results.push({ id, title, status: 'fail', detail: String(detail === undefined ? '' : detail) });
    console.log(`  FAIL  [${id}] ${title}\n        ${String(detail).slice(0, 600)}`);
}
function check(id, condition, title, detail) {
    if (condition) pass(id, title, detail); else fail(id, title, detail);
}

// 同時適用於「元素文字」與「雙引號屬性值」兩種拼接位置：
// 文字位置會插入 <img>；屬性位置會先閉合屬性再插入 <img>。
const PAYLOAD = '書名"><img src=x onerror="window.__xss=(window.__xss||0)+1">';

const XSS_BOOKS = [
    {
        id: 'audit-xss-1', name: PAYLOAD, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        words: [{ id: 'w1', word: 'apple', meaning: '', phonetic: '' }]
    },
    {
        id: 'audit-xss-2', name: '第二本', createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
        words: [{ id: 'x1', word: 'banana', meaning: '香蕉', phonetic: 'bəˈnɑːnə' }]
    }
];

async function newPage(browser, { books = XSS_BOOKS, storage = {}, locale = 'zh-CN', route = null } = {}) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale, acceptDownloads: true });
    await context.route('**/*', (r) => {
        let host = '';
        try { host = new URL(r.request().url()).hostname; } catch (_) { return r.abort(); }
        return (host === '127.0.0.1' || host === 'localhost') ? r.continue() : r.abort();
    });
    if (route) await route(context);
    const page = await context.newPage();
    await page.addInitScript(({ books, storage, locale }) => {
        window.__xss = 0;
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
    }, { books, storage, locale });
    return { context, page };
}

async function boot(page, hash = '') {
    await page.goto(BASE + hash, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1700);
}

const NAV = {
    vocabulary: 'vocabulary-btn', dictation: 'dictation-btn', learning: 'learning-btn',
    qa: 'qa-btn', article: 'article-btn', ocr: 'ocr-btn', quiz: 'quiz-btn'
};
async function goModule(page, key) {
    await page.evaluate((id) => {
        document.querySelectorAll('.options-modal-overlay #cancel-btn, #app-modal .modal-close-btn, #app-modal .cancel-btn')
            .forEach((b) => { if (b.offsetParent !== null) b.click(); });
    });
    await page.waitForTimeout(150);
    await page.evaluate((id) => document.getElementById(id)?.click(), NAV[key]);
    await page.waitForTimeout(500);
}

// ============================================================ R1
async function r1EntryPoint(browser, { id, label, selector, prepare }) {
    const { context, page } = await newPage(browser, prepare ? prepare() : {});
    await boot(page, '#vocabulary');
    await page.waitForTimeout(400);
    const opened = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        el.click();
        return true;
    }, selector);
    await page.waitForTimeout(700);
    const res = await page.evaluate(() => ({
        xss: window.__xss,
        imgs: Array.from(document.querySelectorAll('img[src="x"]')).length,
        modalVisible: !!document.querySelector('#app-modal .modal-content, .options-modal-overlay .modal-content'),
        snippet: (document.querySelector('#app-modal #modal-body')?.innerHTML || '').slice(0, 220)
    }));
    await page.screenshot({ path: path.join(ASSETS, `review-r1-${id}.png`) });
    check(`R1-${id}`, opened && res.xss === 0 && res.imgs === 0,
        `${label}：詞書名不得注入 HTML`,
        `opened=${opened} xss=${res.xss} injectedImg=${res.imgs} modalVisible=${res.modalVisible}\n        ${res.snippet.replace(/\n/g, ' ')}`);
    await context.close();
}

async function r1(browser) {
    console.log('\n### R1 詞書名稱注入入口');
    const cases = [
        { id: 'merge', label: '合併詞書窗口', selector: '#merge-vocab-books-btn' },
        { id: 'complete-missing', label: '補全缺失窗口', selector: '#complete-missing-btn' },
        { id: 'edit-book', label: '編輯詞書窗口', selector: '#edit-vocab-book-btn' },
        {
            id: 'import-presets', label: '匯入詞書清單（遠端 manifest）',
            selector: '#import-vocab-book-btn',
            prepare: () => ({
                route: async (context) => {
                    await context.route('**/wordlists/manifest.json', (r) => r.fulfill({
                        status: 200,
                        contentType: 'application/json',
                        body: JSON.stringify([{ name: PAYLOAD, path: 'wordlists/6A_Unit1.json', id: 'audit-x' }])
                    }));
                }
            })
        }
    ];
    for (const c of cases) await r1EntryPoint(browser, c);

    // 篩選關鍵字：使用者自己輸入的字串也曾經直接串進 innerHTML
    {
        const { context, page } = await newPage(browser, {});
        await boot(page, '#vocabulary');
        await page.waitForTimeout(400);
        await page.evaluate((p) => {
            const input = document.getElementById('word-filter');
            if (!input) return;
            input.value = p;
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }, PAYLOAD);
        await page.waitForTimeout(600);
        const res = await page.evaluate(() => ({
            xss: window.__xss,
            imgs: Array.from(document.querySelectorAll('img[src="x"]')).length,
            placeholder: document.querySelector('#word-list .word-item-placeholder')?.textContent?.trim().slice(0, 80) || null
        }));
        check('R1-filter', res.xss === 0 && res.imgs === 0,
            '篩選無結果訊息：關鍵字不得注入 HTML', JSON.stringify(res));
        await context.close();
    }

    // 反向確認：正常字元仍要原樣顯示（不能過度轉義）
    {
        const literal = 'A & B "c" <d> \'e\'';
        const { context, page } = await newPage(browser, {
            books: [
                { id: 'lit-1', name: literal, words: [{ id: 'w1', word: 'apple', meaning: '苹果', phonetic: 'ˈæpl' }] },
                { id: 'lit-2', name: '第二本', words: [{ id: 'w2', word: 'banana', meaning: '香蕉', phonetic: 'bəˈnɑːnə' }] }
            ]
        });
        await boot(page, '#vocabulary');
        await page.waitForTimeout(400);
        await page.evaluate(() => document.getElementById('merge-vocab-books-btn')?.click());
        await page.waitForTimeout(600);
        const mergeText = await page.evaluate(() => document.querySelector('#merge-book-list .import-preset-item')?.textContent?.trim() || '');
        await page.evaluate(() => document.querySelector('#app-modal .cancel-btn')?.click());
        await page.waitForTimeout(300);
        await page.evaluate(() => document.getElementById('edit-vocab-book-btn')?.click());
        await page.waitForTimeout(600);
        const inputValue = await page.evaluate(() => document.getElementById('modal-book-name')?.value || '');
        check('R1-render', mergeText.startsWith(literal) && inputValue === literal,
            '含 & " < > 的詞書名要原樣顯示（轉義不得外洩到畫面）',
            `mergeText=${JSON.stringify(mergeText)} inputValue=${JSON.stringify(inputValue)}`);
        await context.close();
    }

    // 功能回歸：轉義不能破壞「編輯詞書」的內容往返
    {
        const trickyWord = 'a<b>&"c';
        const trickyMeaning = '意<义>&';
        const { context, page } = await newPage(browser, {
            books: [{ id: 'rt-1', name: '往返本', words: [{ id: 'w1', word: trickyWord, meaning: trickyMeaning, phonetic: 'ˈæpl' }] }]
        });
        await boot(page, '#vocabulary');
        await page.waitForTimeout(400);
        const txt = await page.evaluate(() => {
            document.getElementById('edit-vocab-book-btn')?.click();
            return null;
        });
        void txt;
        await page.waitForTimeout(600);
        const expected = `${trickyWord}#${trickyMeaning}@/ˈæpl/`;
        const actual = await page.evaluate(() => document.getElementById('modal-vocab-content')?.value ?? null);
        check('R1-edit-roundtrip', actual === expected,
            '編輯詞書的 textarea 內容要與原資料完全一致（轉義可還原）',
            `expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
        await context.close();
    }

    // 文章庫（articles/manifest.json）—— 外部檔案直送的資料
    {
        const { context, page } = await newPage(browser, {
            books: XSS_BOOKS.slice(1),
            route: async (ctx) => {
                await ctx.route('**/articles/manifest.json', (r) => r.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify([{
                        path: 'articles/audit-x.json',
                        title: PAYLOAD,
                        description: PAYLOAD,
                        category: PAYLOAD,
                        difficulty: PAYLOAD
                    }])
                }));
            }
        });
        await boot(page, '#article');
        await page.waitForTimeout(500);
        await page.evaluate(() => {
            const btn = document.getElementById('article-library-btn')
                || Array.from(document.querySelectorAll('button')).find((b) => /文章库|文章庫/.test(b.textContent));
            btn?.click();
        });
        await page.waitForTimeout(1200);
        const res = await page.evaluate(() => ({
            xss: window.__xss,
            imgs: Array.from(document.querySelectorAll('img[src="x"]')).length,
            categories: Array.from(document.querySelectorAll('#article-category-filter option')).length
        }));
        check('R1-article-library', res.xss === 0 && res.imgs === 0,
            '文章庫清單：標題／描述／分類不得注入 HTML', JSON.stringify(res));
        await context.close();
    }

    // 功能回歸：合併詞書仍能正常完成
    {
        const { context, page } = await newPage(browser, {});
        await boot(page, '#vocabulary');
        await page.waitForTimeout(400);
        await page.evaluate(() => document.getElementById('merge-vocab-books-btn')?.click());
        await page.waitForTimeout(600);
        await page.evaluate(() => {
            document.querySelectorAll('#merge-book-list .import-preset-item-wrapper').forEach((el) => el.classList.add('selected'));
            const name = document.getElementById('modal-merge-book-name');
            name.value = '合併結果';
            name.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await page.waitForTimeout(300);
        await page.evaluate(() => document.getElementById('confirm-merge-btn')?.click());
        await page.waitForTimeout(900);
        const res = await page.evaluate(() => {
            const books = JSON.parse(localStorage.getItem('vocabularyBooks') || '[]');
            const merged = books.find((b) => b.name === '合併結果');
            return {
                names: books.map((b) => b.name),
                mergedWords: merged ? merged.words.map((w) => w.word).sort() : null
            };
        });
        check('R1-merge-fn', !!res.mergedWords && res.mergedWords.join(',') === 'apple,banana',
            '合併詞書功能仍正常（去重後合併）', JSON.stringify(res));
        await context.close();
    }
}

// ============================================================ R2
async function r2(browser) {
    console.log('\n### R2 編號 QA 格式的內容丟失');
    const { context, page } = await newPage(browser, { books: [] });
    await boot(page);
    const res = await page.evaluate(async () => {
        const m = await import('/features/qa/qa-creator.js');
        const cases = {
            numberedOrphanQuestion: 'Q1: One?\nA1: Yes.\nQ2: Lost?',
            numberedEmptyAnswer: 'Q1: One?\nA1: Yes.\nQ2: Lost?\nA2:',
            plainOrphanQuestion: 'One?\nYes.\nLost?',
            numberedComplete: 'Q1: One?\nA1: Yes.\nQ2: Two?\nA2: Two.'
        };
        const out = {};
        for (const [k, v] of Object.entries(cases)) {
            const r = m.analyzeQAPairs(v);
            out[k] = {
                pairs: r.pairs.map((p) => p.question),
                warnings: r.warnings.map((w) => w.key),
                warningTexts: r.warnings.map((w) => w.params?.line || '')
            };
        }
        return out;
    });
    check('R2-a', res.numberedOrphanQuestion.warnings.length > 0,
        '編號格式末尾缺答案要回報警告', JSON.stringify(res.numberedOrphanQuestion));
    check('R2-b', res.numberedEmptyAnswer.warnings.length > 0,
        '編號格式空答案要回報警告', JSON.stringify(res.numberedEmptyAnswer));
    check('R2-c', res.plainOrphanQuestion.warnings.length > 0,
        '兩行格式落單行要回報警告', JSON.stringify(res.plainOrphanQuestion));
    check('R2-d', res.numberedComplete.warnings.length === 0 && res.numberedComplete.pairs.length === 2,
        '完整編號格式不得產生假警告', JSON.stringify(res.numberedComplete));
    await context.close();

    // 保存路徑：有內容沒被採用時，必須在寫入前讓使用者決定
    {
        const { context, page } = await newPage(browser, { books: XSS_BOOKS.slice(1) });
        await boot(page, '#qa');
        await page.waitForTimeout(600);
        const openCreator = async () => {
            await page.evaluate(() => document.getElementById('create-qa-set-btn')?.click());
            await page.waitForTimeout(400);
        };
        await openCreator();
        const fill = async () => {
            await page.fill('#qa-set-name', 'audit-編號格式');
            await page.fill('#qa-pairs-input', 'Q1: One?\nA1: Yes.\nQ2: Lost?');
            await page.waitForTimeout(300);
        };
        await fill();
        await page.evaluate(() => document.getElementById('save-qa-set-btn')?.click());
        await page.waitForTimeout(500);
        const dialog = await page.evaluate(() => {
            const ov = document.querySelector('.options-modal-overlay');
            if (!ov) return { shown: false };
            return {
                shown: true,
                title: ov.querySelector('#om-title, h3')?.textContent?.trim() || '',
                message: ov.querySelector('.om-desc, p')?.textContent?.trim() || '',
                confirm: ov.querySelector('#confirm-btn')?.textContent?.trim() || '',
                cancel: ov.querySelector('#cancel-btn')?.textContent?.trim() || ''
            };
        });
        check('R2-e', dialog.shown && /没有对应答案|沒有對應答案/.test(dialog.message),
            '保存前要先提示「有內容沒被採用」並讓使用者決定', JSON.stringify(dialog));

        // 按「返回修改」→ 不能寫入，且留在建立畫面
        await page.evaluate(() => document.querySelector('.options-modal-overlay #cancel-btn')?.click());
        await page.waitForTimeout(500);
        const afterCancel = await page.evaluate(() => ({
            saved: JSON.parse(localStorage.getItem('qa-sets') || '[]').some((s) => s.name === 'audit-編號格式'),
            creatorVisible: getComputedStyle(document.getElementById('qa-creator-area')).display !== 'none',
            inputValue: document.getElementById('qa-pairs-input')?.value || ''
        }));
        check('R2-f', !afterCancel.saved && afterCancel.creatorVisible && afterCancel.inputValue.includes('Q2: Lost?'),
            '按「返回修改」不得保存，且原輸入要留著', JSON.stringify(afterCancel));

        // 按「仍然保存」→ 明確決定後才寫入
        await page.evaluate(() => document.getElementById('save-qa-set-btn')?.click());
        await page.waitForTimeout(500);
        await page.evaluate(() => document.querySelector('.options-modal-overlay #confirm-btn')?.click());
        await page.waitForTimeout(900);
        const saved = await page.evaluate(() => {
            const sets = JSON.parse(localStorage.getItem('qa-sets') || '[]');
            const sum = sets.find((s) => s.name === 'audit-編號格式');
            const detail = sum ? JSON.parse(localStorage.getItem('qa-set-' + sum.id) || 'null') : null;
            return { found: !!sum, questions: detail?.questions?.map((q) => q.question) || null };
        });
        check('R2-g', saved.found && saved.questions?.length === 1 && saved.questions[0] === 'One?',
            '按「仍然保存」後只保存已配對的題目', JSON.stringify(saved));
        await context.close();
    }
}

// ============================================================ R3
async function r3(browser) {
    console.log('\n### R3 彈窗內的驗證訊息與提示條層級');
    const { context, page } = await newPage(browser, { books: XSS_BOOKS.slice(1) });
    await boot(page, '#article');
    await page.waitForTimeout(400);
    await page.evaluate(() => document.getElementById('import-article-btn')?.click());
    await page.waitForSelector('#imp-fetch', { state: 'attached', timeout: 5000 }).catch(() => {});

    // (a) 空網址：應該是彈窗內的就地訊息，且真的看得見、點得到
    await page.evaluate(() => document.getElementById('imp-fetch')?.click());
    await page.waitForTimeout(600);
    const inline = await page.evaluate(() => {
        const el = document.getElementById('imp-url-error');
        if (!el || el.hidden) return { shown: false };
        const input = document.getElementById('imp-url');
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + Math.min(r.width / 2, 40), r.top + r.height / 2);
        return {
            shown: true,
            text: el.textContent.trim(),
            visible: r.width > 0 && r.height > 0,
            hitIsSelf: !!(hit && (hit === el || el.contains(hit))),
            ariaInvalid: input?.getAttribute('aria-invalid'),
            insideModal: !!el.closest('#app-modal'),
            focused: document.activeElement === input
        };
    });
    check('R3-a', inline.shown && inline.visible && inline.hitIsSelf && inline.ariaInvalid === 'true' && inline.insideModal,
        '彈窗內空網址要顯示就地驗證訊息（可見、可命中、標記 aria-invalid）', JSON.stringify(inline));

    // 輸入內容後就地訊息應消失
    await page.fill('#imp-url', 'https://example.invalid/x');
    await page.waitForTimeout(200);
    const cleared = await page.evaluate(() => {
        const el = document.getElementById('imp-url-error');
        return { hidden: !el || el.hidden, ariaInvalid: document.getElementById('imp-url')?.getAttribute('aria-invalid') };
    });
    check('R3-b', cleared.hidden && !cleared.ariaInvalid, '輸入內容後就地驗證訊息要消失', JSON.stringify(cleared));

    // (b) 彈窗開著時發出的提示條：必須在最上層且可點
    await page.evaluate(async () => {
        const ui = await import('/modules/ui.js');
        ui.displayMessage('audit-toast-in-modal', 'warning', 20000);
    });
    await page.waitForSelector('#message-container .message-toast.is-shown', { timeout: 5000 }).catch(() => {});
    const layered = await page.evaluate(() => {
        const toast = Array.from(document.querySelectorAll('#message-container .message-toast'))
            .find((n) => n.textContent.includes('audit-toast-in-modal'));
        if (!toast) return { toast: false };
        const close = toast.querySelector('.message-toast__close');
        const tr = toast.getBoundingClientRect();
        const cr = close.getBoundingClientRect();
        const atToast = document.elementFromPoint(tr.left + tr.width / 2, tr.top + tr.height / 2);
        const atClose = document.elementFromPoint(cr.left + cr.width / 2, cr.top + cr.height / 2);
        const overlay = document.querySelector('.modal-overlay, .options-modal-overlay');
        return {
            toast: true,
            containerZ: getComputedStyle(document.getElementById('message-container')).zIndex,
            overlayZ: overlay ? getComputedStyle(overlay).zIndex : null,
            hitToastIsToast: !!(atToast && atToast.closest('#message-container')),
            hitCloseIsClose: !!(atClose && atClose.classList.contains('message-toast__close')),
            hitToastTag: atToast ? (atToast.id || atToast.className || atToast.tagName) : null,
            hitCloseTag: atClose ? (atClose.id || atClose.className || atClose.tagName) : null
        };
    });
    await page.screenshot({ path: path.join(ASSETS, 'review-r3-article-toast.png') });
    // 注意：提示條本體是刻意 pointer-events: none（避免攔截下方按鈕），
    // 所以本體位置的 elementFromPoint 命中下層元素是正常行為；
    // 真正要驗的是「層級高於遮罩（不會被壓暗）＋關閉鈕可點」。
    const aboveOverlay = Number(layered.containerZ) > Number(layered.overlayZ);
    check('R3-c', layered.toast && aboveOverlay && layered.hitCloseIsClose,
        '彈窗開啟時提示條層級要高於遮罩、關閉鈕可點（本體保持點擊穿透）', JSON.stringify(layered));

    if (layered.toast) {
        const box = await page.evaluate(() => {
            const c = Array.from(document.querySelectorAll('#message-container .message-toast'))
                .find((n) => n.textContent.includes('audit-toast-in-modal'))
                ?.querySelector('.message-toast__close');
            if (!c) return null;
            const r = c.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        });
        if (box) {
            await page.mouse.click(box.x, box.y);
            await page.waitForTimeout(400);
            const gone = await page.evaluate(() => !Array.from(document.querySelectorAll('#message-container .message-toast'))
                .some((n) => n.textContent.includes('audit-toast-in-modal')));
            check('R3-d', gone, '提示條關閉鈕點擊後要真的關閉', `gone=${gone}`);
        }
    }

    // (c) 端到端：抓取失敗時彈窗內的錯誤提示同樣要可命中
    await page.evaluate(() => document.getElementById('imp-fetch')?.click());
    await page.waitForTimeout(2500);
    const real = await page.evaluate(() => {
        const toast = Array.from(document.querySelectorAll('#message-container .message-toast'))
            .find((n) => /失败|失敗/.test(n.textContent));
        if (!toast) return { toast: false, all: Array.from(document.querySelectorAll('#message-container .message-toast')).map((n) => n.textContent.trim()) };
        const close = toast.querySelector('.message-toast__close');
        const cr = close.getBoundingClientRect();
        const atClose = document.elementFromPoint(cr.left + cr.width / 2, cr.top + cr.height / 2);
        const overlay = document.querySelector('.modal-overlay, .options-modal-overlay');
        return {
            toast: true,
            text: toast.textContent.trim().slice(0, 80),
            aboveOverlay: Number(getComputedStyle(document.getElementById('message-container')).zIndex)
                > Number(overlay ? getComputedStyle(overlay).zIndex : 0),
            closeHittable: !!(atClose && atClose.classList.contains('message-toast__close'))
        };
    });
    check('R3-e', real.toast && real.aboveOverlay && real.closeHittable,
        '抓取失敗的提示條在彈窗上方且關閉鈕可點', JSON.stringify(real));
    await context.close();
}

// ============================================================ R4
async function r4(browser) {
    console.log('\n### R4 聽寫批改歷史「清空全部」');
    const seed = () => ({
        storage: {
            dictationGradingHistory: [{
                id: 'audit-rec-1', createdAt: Date.now(), model: 'audit-model',
                imagesCount: 1, wordsCount: 2, thumbnail: '', markdown: '| 標準答案 | 書寫 |\n| --- | --- |\n| apple | apple |\n'
            }]
        }
    });

    // 外部入口：右上角菜單 → 批改歷史
    {
        const { context, page } = await newPage(browser, seed());
        await boot(page);
        await page.evaluate(async () => {
            const m = await import('/features/dictation/dictation-grader.js');
            m.openDictationGradingHistory();
        });
        await page.waitForTimeout(500);
        const before = await page.evaluate(() => JSON.parse(localStorage.getItem('dictationGradingHistory') || '[]').length);
        await page.evaluate(() => document.getElementById('dg-h-clear')?.click());
        await page.waitForTimeout(400);
        const confirmShown = await page.evaluate(() => !!document.querySelector('.options-modal-overlay #confirm-btn'));
        await page.evaluate(() => document.querySelector('.options-modal-overlay #confirm-btn')?.click());
        await page.waitForTimeout(700);
        const after = await page.evaluate(() => JSON.parse(localStorage.getItem('dictationGradingHistory') || '[]').length);
        check('R4-a', confirmShown && after === 0,
            '外部歷史入口的「清空全部」要彈確認並清空',
            `before=${before} confirmShown=${confirmShown} after=${after}`);
        await context.close();
    }

    // 內部入口：聽寫頁 → AI 批改彈窗 → 歷史 → 清空全部
    {
        const { context, page } = await newPage(browser, seed());
        await boot(page, '#dictation');
        await page.waitForTimeout(400);
        await page.evaluate(() => document.getElementById('dictation-ai-grade-btn')?.click());
        await page.waitForSelector('#dg-history', { state: 'attached', timeout: 5000 }).catch(() => {});
        await page.evaluate(() => document.getElementById('dg-history')?.click());
        await page.waitForTimeout(500);
        const listShown = await page.evaluate(() => document.querySelectorAll('#modal-body .dg-h-item').length);
        await page.evaluate(() => document.getElementById('dg-h-clear')?.click());
        await page.waitForTimeout(400);
        const confirmShown = await page.evaluate(() => !!document.querySelector('.options-modal-overlay #confirm-btn'));
        await page.evaluate(() => document.querySelector('.options-modal-overlay #confirm-btn')?.click());
        await page.waitForTimeout(700);
        const after = await page.evaluate(() => JSON.parse(localStorage.getItem('dictationGradingHistory') || '[]').length);
        check('R4-b', listShown === 1 && confirmShown && after === 0,
            '彈窗內歷史入口的「清空全部」要彈確認並清空',
            `listShown=${listShown} confirmShown=${confirmShown} after=${after}`);
        await context.close();
    }

    // 單筆檢視／刪除不能被「清空全部」的修正破壞
    {
        const { context, page } = await newPage(browser, seed());
        await boot(page);
        await page.evaluate(async () => {
            const m = await import('/features/dictation/dictation-grader.js');
            m.openDictationGradingHistory();
        });
        await page.waitForTimeout(500);
        await page.evaluate(() => document.querySelector('#modal-body .dg-h-item button[data-act="view"]')?.click());
        await page.waitForTimeout(500);
        const viewed = await page.evaluate(() => (document.getElementById('modal-body')?.textContent || '').includes('apple'));
        await page.evaluate(async () => {
            const m = await import('/features/dictation/dictation-grader.js');
            m.openDictationGradingHistory();
        });
        await page.waitForTimeout(400);
        await page.evaluate(() => document.querySelector('#modal-body .dg-h-item button[data-act="del"]')?.click());
        await page.waitForTimeout(400);
        await page.evaluate(() => document.querySelector('.options-modal-overlay #confirm-btn')?.click());
        await page.waitForTimeout(600);
        const after = await page.evaluate(() => JSON.parse(localStorage.getItem('dictationGradingHistory') || '[]').length);
        check('R4-c', viewed && after === 0, '單筆「檢視／刪除」仍要正常', `viewed=${viewed} after=${after}`);
        await context.close();
    }
}

// ============================================================ R5
async function r5(browser) {
    console.log('\n### R5 OCR 完成／失敗態按鈕文字');
    const { context, page } = await newPage(browser, { books: XSS_BOOKS.slice(1) });
    await boot(page, '#ocr');
    await page.waitForTimeout(400);
    const input = await page.$('#ocr-image-input');
    if (!input) { fail('R5', 'OCR 完成態按鈕文字', '找不到 #ocr-image-input'); await context.close(); return; }
    await input.setInputFiles(path.join(ROOT, '5AU1_1.jpg'));
    await page.waitForTimeout(2500);
    await page.evaluate(() => document.getElementById('ocr-run-btn')?.click());
    // 一出現結果提示就立刻讀按鈕文字（完成態只在這一瞬可能出現）
    await page.waitForSelector('#message-container .message-toast', { timeout: 40000 }).catch(() => {});
    const res = await page.evaluate(() => ({
        label: (document.getElementById('ocr-run-btn')?.textContent || '').trim(),
        disabled: document.getElementById('ocr-run-btn')?.disabled,
        toasts: Array.from(document.querySelectorAll('#message-container .message-toast')).map((n) => n.textContent.replace('×', '').trim())
    }));
    await page.screenshot({ path: path.join(ASSETS, 'review-r5-ocr-done.png') });
    const allFailed = /识别失败|識別失敗/.test(res.label);
    check('R5', allFailed, '全部失敗時按鈕要顯示「识别失败」而不是立刻還原成「开始识别」', JSON.stringify(res));
    await context.close();
}

// ============================================================ R6
// 本輪新增／改動的文案，兩種介面語言都要能正確顯示（不得露出鍵名）
async function r6(browser) {
    console.log('\n### R6 新增文案的簡繁檢查');
    const seen = {};
    for (const locale of ['zh-CN', 'zh-HK']) {
        const { context, page } = await newPage(browser, {
            books: XSS_BOOKS.slice(1),
            locale,
            storage: {
                dictationGradingHistory: [{
                    id: 'audit-rec-locale', createdAt: Date.now(), model: 'm',
                    imagesCount: 1, wordsCount: 2, thumbnail: '', markdown: '| a |\n| --- |\n| b |\n'
                }]
            }
        });
        await boot(page, '#qa');
        await page.waitForTimeout(600);
        await page.evaluate(() => document.getElementById('create-qa-set-btn')?.click());
        await page.waitForTimeout(400);
        await page.fill('#qa-set-name', 'audit-locale');
        await page.fill('#qa-pairs-input', 'Q1: One?\nA1: Yes.\nQ2: Lost?');
        await page.waitForTimeout(300);
        await page.evaluate(() => document.getElementById('save-qa-set-btn')?.click());
        await page.waitForTimeout(500);
        const saveDialog = await page.evaluate(() => {
            const ov = document.querySelector('.options-modal-overlay');
            if (!ov) return null;
            return {
                title: ov.querySelector('#om-title, h3')?.textContent?.trim() || '',
                message: ov.querySelector('.om-desc, p')?.textContent?.trim() || '',
                confirm: ov.querySelector('#confirm-btn')?.textContent?.trim() || '',
                cancel: ov.querySelector('#cancel-btn')?.textContent?.trim() || ''
            };
        });
        await page.evaluate(() => document.querySelector('.options-modal-overlay #cancel-btn')?.click());
        await page.waitForTimeout(300);

        // 文章導入的空網址就地訊息
        await goModule(page, 'article');
        await page.evaluate(() => document.getElementById('import-article-btn')?.click());
        await page.waitForSelector('#imp-fetch', { state: 'attached', timeout: 5000 }).catch(() => {});
        await page.evaluate(() => document.getElementById('imp-fetch')?.click());
        await page.waitForTimeout(500);
        const inline = await page.evaluate(() => document.getElementById('imp-url-error')?.textContent?.trim() || '');

        // 聽寫批改歷史的清空確認
        await page.evaluate(async () => {
            const m = await import('/features/dictation/dictation-grader.js');
            m.openDictationGradingHistory();
        });
        await page.waitForTimeout(400);
        const clearLabel = await page.evaluate(() => document.getElementById('dg-h-clear')?.textContent?.trim() || '');

        seen[locale] = { saveDialog, inline, clearLabel };
        const leaked = [saveDialog?.title, saveDialog?.message, saveDialog?.confirm, saveDialog?.cancel, inline, clearLabel]
            .some((s) => !s || /^qa\.|^article\.|^dictationGrader\.|^common\./.test(s));
        check(`R6-${locale}`, !leaked && !!saveDialog && saveDialog.message.length > 10,
            `${locale}：本輪新增文案要正常翻譯（不得露出鍵名）`, JSON.stringify(seen[locale]));
        await context.close();
    }
    const cn = seen['zh-CN'] || {};
    const hk = seen['zh-HK'] || {};
    check('R6-diff', cn.inline && hk.inline && cn.inline !== hk.inline
        && cn.saveDialog?.title !== hk.saveDialog?.title
        && cn.saveDialog?.confirm !== hk.saveDialog?.confirm,
        'zh-CN 與 zh-HK 文案確實不同（不是同一份字典）',
        `CN=${JSON.stringify(cn)}\n        HK=${JSON.stringify(hk)}`);
}

async function main() {
    const browser = await chromium.launch({ executablePath: CHROME });
    await r1(browser);
    await r2(browser);
    await r3(browser);
    await r4(browser);
    await r5(browser);
    await r6(browser);
    await browser.close();

    const failed = results.filter((r) => r.status === 'fail');
    const out = path.join(ASSETS, 'review-report-verify.json');
    fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
    console.log(`\n=== ${results.length - failed.length}/${results.length} 通過 -> ${out} ===`);
    if (failed.length) {
        console.log('未通過：' + failed.map((f) => f.id).join(', '));
        process.exit(1);
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
