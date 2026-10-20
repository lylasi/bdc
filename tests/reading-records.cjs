/**
 * 閱讀記錄（文章逐篇儲存第一階段）瀏覽器驗收。
 *
 * 用法：
 *   PORT=8313 PLAYWRIGHT_MODULE=<path-to-playwright> node tests/reading-records.cjs
 *   CHROME_PATH=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome
 *
 * 覆蓋：
 *   1. 單一入口、數量徽章、狀態列
 *   2. 搜尋／來源篩選／排序／日期分組（只在時間排序出現）
 *   3. 目前文章標示、開啟記錄、改名持久化
 *   4. 刪除不影響目前文章、連續刪除各自可復原
 *   5. 刪除目前文章與復原
 *   6. 草稿保護與再次找回
 *   7. 從文章庫匯入 B 不會覆蓋已載入的 A（分析失敗也不改 A）
 *   8. zh-CN／zh-HK 與手機（390）／桌面（1280）
 */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const PORT = Number(process.env.PORT || 8313);
const BASE = `http://127.0.0.1:${PORT}/`;
const ENDPOINT = process.env.TEST_SYNC_ENDPOINT || 'http://127.0.0.1:19999/test-endpoint';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const failures = [];
function check(name, condition, detail) {
    if (condition) {
        console.log(`  ok   ${name}`);
        return true;
    }
    failures.push({ name, detail: detail === undefined ? '' : String(detail).slice(0, 500) });
    console.log(`  FAIL ${name}${detail !== undefined ? ' -- ' + String(detail).slice(0, 300) : ''}`);
    return false;
}

const ARTICLES = [
    {
        id: 'art_alpha',
        title: 'Alpha Article',
        body: 'Alpha body one.\n\nAlpha body two.',
        analysis: { chinese_translation: '甲', paragraph_analysis: [{ chinese_translation: '甲一' }, { chinese_translation: '甲二' }] },
        sourceType: 'url',
        sourceUrl: 'https://example.com/alpha',
        revision: 3,
        createdAt: '2026-10-01T10:00:00.000Z',
        updatedAt: '2026-10-17T10:00:00.000Z',
        lastOpenedAt: '2026-10-18T09:00:00.000Z'
    },
    {
        id: 'art_beta',
        title: 'Beta Notes',
        body: 'Beta body about a scanned page.',
        analysis: { chinese_translation: '乙', paragraph_analysis: [{ chinese_translation: '乙一' }] },
        sourceType: 'ocr',
        revision: 1,
        createdAt: '2026-09-01T10:00:00.000Z',
        updatedAt: '2026-09-02T10:00:00.000Z',
        lastOpenedAt: '2026-09-03T10:00:00.000Z'
    },
    {
        id: 'art_zulu',
        title: 'Zulu Draft',
        body: 'Zulu body mentioning vocabulary words.',
        analysis: null,
        sourceType: 'paste',
        revision: 0,
        createdAt: '2026-08-01T10:00:00.000Z',
        updatedAt: '2026-08-01T10:00:00.000Z',
        lastOpenedAt: ''
    }
];

async function newPage(browser, { locale = 'zh-CN', viewport = { width: 1280, height: 900 } } = {}) {
    const context = await browser.newContext({ viewport });
    await context.addInitScript(({ endpoint, locale }) => {
        window.__BDC_SYNC_ENDPOINT__ = endpoint;
        try {
            const raw = localStorage.getItem('pen_global_settings');
            const parsed = raw ? JSON.parse(raw) : {};
            parsed.language = { ...(parsed.language || {}), interfaceLocale: locale };
            localStorage.setItem('pen_global_settings', JSON.stringify(parsed));
        } catch (_) {}
    }, { endpoint: ENDPOINT, locale });
    const page = await context.newPage();
    const errors = [];
    page.on('console', (m) => { if (m.type() !== 'error') return; const text = m.text(); if (/Failed to load resource|ERR_CONNECTION_REFUSED|ERR_UNSAFE_PORT|404|501/i.test(text)) return; errors.push(text.slice(0, 240)); });
    page.on('pageerror', (e) => errors.push('PAGEERROR ' + String(e && e.stack ? e.stack.split('\n')[0] : e)));
    return { context, page, errors };
}

async function seedArticles(page, docs) {
    return page.evaluate(async ({ endpoint, docs }) => {
        const scope = `${endpoint}::guest`;
        const db = await new Promise((resolve, reject) => {
            const req = indexedDB.open('bdc-articles');
            req.onupgradeneeded = () => {
                const d = req.result;
                if (!d.objectStoreNames.contains('docs')) d.createObjectStore('docs', { keyPath: 'key' });
                if (!d.objectStoreNames.contains('outbox')) d.createObjectStore('outbox', { keyPath: 'key' });
                if (!d.objectStoreNames.contains('state')) d.createObjectStore('state', { keyPath: 'scope' });
                if (!d.objectStoreNames.contains('drafts')) d.createObjectStore('drafts', { keyPath: 'scope' });
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        await new Promise((resolve) => {
            const tx = db.transaction('docs', 'readwrite');
            const store = tx.objectStore('docs');
            docs.forEach((doc) => store.put({
                ...doc,
                scope,
                key: `${scope}\u0000${doc.id}`,
                analysis: doc.analysis || null,
                dirty: false,
                pending: false,
                sizeBytes: doc.body.length + 10
            }));
            tx.oncomplete = resolve;
        });
        db.close();
        return docs.length;
    }, { endpoint: ENDPOINT, docs });
}

const state = (page) => page.evaluate(() => ({
    count: document.getElementById('article-history-count')?.textContent?.trim() || '',
    countHidden: document.getElementById('article-history-count')?.classList.contains('hidden') ?? true,
    statusHidden: document.getElementById('article-history-status')?.classList.contains('hidden') ?? true,
    status: document.getElementById('article-history-status')?.textContent?.trim() || '',
    input: document.getElementById('article-input')?.value || '',
    paragraphs: document.querySelectorAll('#article-analysis-container .paragraph-pair').length,
    modalOpen: !document.getElementById('app-modal').classList.contains('hidden')
}));

const rows = (page) => page.evaluate(() => Array.from(document.querySelectorAll('.ar-history-item')).map((row) => ({
    key: row.getAttribute('data-key'),
    title: row.querySelector('.ar-history-title')?.textContent?.trim(),
    meta: row.querySelector('.ar-history-meta')?.textContent?.trim(),
    current: row.classList.contains('is-current')
})));

async function openHistory(page) {
    await page.click('#article-history-btn');
    await page.waitForTimeout(350);
}

async function closeModal(page) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    // Esc 在站內彈窗不一定綁定，退回關閉按鈕
    if (await page.evaluate(() => !document.getElementById('app-modal').classList.contains('hidden'))) {
        await page.click('#app-modal .modal-close-btn').catch(() => {});
        await page.waitForTimeout(200);
    }
}

async function desktopZhCn(browser) {
    console.log('\n[桌面 zh-CN]');
    const { context, page, errors } = await newPage(browser);
    await page.goto(BASE + '#a', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    await seedArticles(page, ARTICLES);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1600);

    let s = await state(page);
    check('初始：數量徽章顯示 3 篇', s.count === '3' && !s.countHidden, JSON.stringify(s));
    check('初始：未載入文章時狀態列隱藏', s.statusHidden, JSON.stringify(s));

    await openHistory(page);
    let list = await rows(page);
    check('清單列出 3 篇', list.length === 3, JSON.stringify(list));
    check('預設（最近閱讀）順序正確',
        list[0]?.key === 'art_alpha' && list[1]?.key === 'art_beta' && list[2]?.key === 'art_zulu',
        JSON.stringify(list.map((r) => r.key)));
    const groups = await page.evaluate(() => Array.from(document.querySelectorAll('.ar-history-group')).map((n) => n.textContent.trim()));
    check('時間排序有日期分組', groups.length >= 2, JSON.stringify(groups));
    const footer = await page.evaluate(() => document.querySelector('.ar-history-footer')?.textContent?.replace(/\s+/g, ' ').trim());
    check('底部顯示篇數與容量', /3/.test(footer || ''), footer);

    // 搜尋（內文）
    await page.fill('#ar-history-search', 'scanned');
    await page.waitForTimeout(200);
    check('搜尋命中內文', (await rows(page)).length === 1 && (await rows(page))[0].key === 'art_beta');
    await page.fill('#ar-history-search', '');
    await page.waitForTimeout(150);

    // 來源篩選
    await page.click('.ar-history-filter[data-source="ocr"]');
    await page.waitForTimeout(200);
    check('來源篩選（OCR）只留 1 篇', (await rows(page)).length === 1);
    await page.click('.ar-history-filter[data-source="all"]');
    await page.waitForTimeout(200);

    // 標題排序：A→Z 且不再分組
    await page.selectOption('#ar-history-sort', 'title');
    await page.waitForTimeout(250);
    list = await rows(page);
    const groupsAfter = await page.evaluate(() => document.querySelectorAll('.ar-history-group').length);
    check('標題排序 A→Z', list.map((r) => r.title).join('|') === 'Alpha Article|Beta Notes|Zulu Draft', JSON.stringify(list.map((r) => r.title)));
    check('標題排序不分日期組', groupsAfter === 0, String(groupsAfter));
    await page.selectOption('#ar-history-sort', 'recent');
    await page.waitForTimeout(200);

    // 開啟記錄
    await page.click('.ar-history-item[data-key="art_alpha"] .ar-history-open');
    await page.waitForTimeout(500);
    s = await state(page);
    check('開啟記錄：輸入框載入原文', s.input.startsWith('Alpha body one.'), s.input.slice(0, 40));
    check('開啟記錄：渲染分析結果', s.paragraphs === 2, String(s.paragraphs));
    check('開啟記錄：狀態列顯示已存入', !s.statusHidden && /已存入/.test(s.status), s.status);
    check('開啟記錄：彈窗關閉', !s.modalOpen, String(s.modalOpen));

    await openHistory(page);
    list = await rows(page);
    check('清單標示目前文章', list.find((r) => r.key === 'art_alpha')?.current === true, JSON.stringify(list));
    await closeModal(page);

    // 改名並驗證持久化
    await openHistory(page);
    await page.click('.ar-history-item[data-key="art_alpha"] .ar-history-more');
    await page.waitForTimeout(150);
    await page.click('.ar-history-item[data-key="art_alpha"] .ar-history-menu button[data-act="rename"]');
    await page.waitForTimeout(300);
    await page.fill('#prompt-input', 'Alpha Renamed');
    await page.click('#prompt-confirm');
    await page.waitForTimeout(500);
    list = await rows(page);
    check('改名後清單標題更新', list.some((r) => r.title === 'Alpha Renamed'), JSON.stringify(list.map((r) => r.title)));
    check('改名不影響內文', (await state(page)).input.startsWith('Alpha body one.'));
    await closeModal(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1600);
    await openHistory(page);
    list = await rows(page);
    check('改名已持久化', list.some((r) => r.title === 'Alpha Renamed'), JSON.stringify(list.map((r) => r.title)));

    // 刪除非目前文章不影響目前畫面
    const beforeDelete = await state(page);
    await page.click('.ar-history-item[data-key="art_beta"] .ar-history-more');
    await page.waitForTimeout(150);
    await page.click('.ar-history-item[data-key="art_beta"] .ar-history-menu button[data-act="delete"]');
    await page.waitForTimeout(500);
    list = await rows(page);
    check('刪除後列消失', !list.some((r) => r.key === 'art_beta'), JSON.stringify(list.map((r) => r.key)));
    const afterDelete = await state(page);
    check('刪除非目前文章不清空目前畫面', afterDelete.input === beforeDelete.input && afterDelete.paragraphs === beforeDelete.paragraphs, JSON.stringify(afterDelete));

    // 復原（第一次刪除）
    const undoVisible = await page.evaluate(() => {
        const bar = document.querySelector('.ar-history-undo');
        return !!bar && !bar.classList.contains('hidden') && /復原|撤销/.test(bar.textContent);
    });
    check('顯示可復原提示', undoVisible === true);
    await page.click('.ar-history-undo .article-history-undo-btn');
    await page.waitForTimeout(500);
    list = await rows(page);
    check('復原後列回來', list.some((r) => r.key === 'art_beta'), JSON.stringify(list.map((r) => r.key)));

    // 連續刪除：各自保存復原
    for (const key of ['art_beta', 'art_zulu']) {
        await page.click(`.ar-history-item[data-key="${key}"] .ar-history-more`);
        await page.waitForTimeout(120);
        await page.click(`.ar-history-item[data-key="${key}"] .ar-history-menu button[data-act="delete"]`);
        await page.waitForTimeout(400);
    }
    list = await rows(page);
    check('連續刪除兩筆', list.length === 1, JSON.stringify(list.map((r) => r.key)));
    await page.click('.ar-history-undo .article-history-undo-btn');
    await page.waitForTimeout(400);
    list = await rows(page);
    check('第一次復原救回最後刪除的一筆', list.some((r) => r.key === 'art_zulu'), JSON.stringify(list.map((r) => r.key)));
    await page.click('.ar-history-undo .article-history-undo-btn');
    await page.waitForTimeout(400);
    list = await rows(page);
    check('第二次復原救回前一筆', list.some((r) => r.key === 'art_beta'), JSON.stringify(list.map((r) => r.key)));

    // 刪除目前文章 + 復原
    await page.click('.ar-history-item[data-key="art_alpha"] .ar-history-more');
    await page.waitForTimeout(120);
    await page.click('.ar-history-item[data-key="art_alpha"] .ar-history-menu button[data-act="delete"]');
    await page.waitForTimeout(300);
    // 目前文章有未儲存修改時會先確認；這裡沒有修改，直接刪除
    s = await state(page);
    check('刪除目前文章後畫面清空並提示', /已從閱讀記錄中刪除|已从阅读记录中删除/.test(
        await page.evaluate(() => document.getElementById('article-analysis-container').textContent.trim())
    ) || s.input === '', JSON.stringify({ input: s.input.slice(0, 20) }));
    await page.click('.ar-history-undo .article-history-undo-btn');
    await page.waitForTimeout(500);
    list = await rows(page);
    check('目前文章可復原', list.some((r) => r.key === 'art_alpha'), JSON.stringify(list.map((r) => r.key)));
    await closeModal(page);

    // 草稿保護：載入 Alpha → 改輸入 → 切到 Zulu → 草稿可找回
    await openHistory(page);
    await page.click('.ar-history-item[data-key="art_alpha"] .ar-history-open');
    await page.waitForTimeout(400);
    await page.fill('#article-input', 'Alpha body one.\n\nUnsaved extra paragraph.');
    await page.waitForTimeout(200);
    s = await state(page);
    check('未儲存修改時狀態列不再是「已存入」', !/已存入/.test(s.status), s.status);
    await openHistory(page);
    await page.click('.ar-history-item[data-key="art_zulu"] .ar-history-open');
    await page.waitForTimeout(500);
    await openHistory(page);
    const draftRow = await page.evaluate(() => {
        const host = document.querySelector('.ar-history-draft');
        return host && !host.hidden ? host.textContent.replace(/\s+/g, ' ').trim() : '';
    });
    check('切換後提供草稿入口', /草稿/.test(draftRow), draftRow);
    await page.click('.ar-history-draft [data-act="restore-draft"]');
    await page.waitForTimeout(500);
    s = await state(page);
    check('草稿可再次找回', s.input.includes('Unsaved extra paragraph.'), s.input.slice(0, 60));

    // 身份安全：載入 A 後從文章庫匯入 B，分析（無 AI provider 會失敗）也不得改到 A
    await page.click('#article-input');
    await page.fill('#article-input', 'Alpha body one.\n\nAlpha body two.');
    await openHistory(page);
    await page.click('.ar-history-item[data-key="art_alpha"] .ar-history-open');
    await page.waitForTimeout(400);
    const alphaBodyBefore = await page.evaluate(() => document.getElementById('article-input').value);
    await page.click('#show-article-library-btn');
    await page.waitForTimeout(1500);
    const picked = await page.evaluate(() => {
        const first = document.querySelector('#article-library-list .article-library-item');
        if (first) first.click();
        return !!first;
    });
    check('文章庫可選取文章', picked === true);
    await page.waitForTimeout(700);
    s = await state(page);
    check('匯入 B 後狀態列不是「已存入」（尚未成為新記錄）', !/已存入/.test(s.status), s.status);
    await page.click('#analyze-article-btn');
    await page.waitForTimeout(2500);
    await openHistory(page);
    list = await rows(page);
    const alphaRow = list.find((r) => r.key === 'art_alpha');
    check('匯入新文章後，A 仍是獨立的一筆', !!alphaRow, JSON.stringify(list.map((r) => r.key)));
    await page.click('.ar-history-item[data-key="art_alpha"] .ar-history-open');
    await page.waitForTimeout(500);
    const alphaBodyAfter = await page.evaluate(() => document.getElementById('article-input').value);
    check('A 的內容沒有被 B 覆蓋', alphaBodyAfter === alphaBodyBefore, alphaBodyAfter.slice(0, 60));

    check('桌面 zh-CN 無 console 錯誤', errors.length === 0, JSON.stringify(errors.slice(0, 6)));
    await context.close();
}

async function mobileZhHk(browser) {
    console.log('\n[手機 390 zh-HK]');
    const { context, page, errors } = await newPage(browser, { locale: 'zh-HK', viewport: { width: 390, height: 844 } });
    await page.goto(BASE + '#a', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    await seedArticles(page, ARTICLES);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1800);

    const labels = await page.evaluate(() => ({
        entry: document.getElementById('article-history-btn')?.textContent?.replace(/\s+/g, ' ').trim(),
        status: document.getElementById('article-history-status')?.textContent?.trim()
    }));
    check('zh-HK：入口與狀態文案為香港繁體', /閱讀記錄/.test(labels.entry || '') && /閱讀記錄/.test(labels.status || ''), JSON.stringify(labels));

    await openHistory(page);
    const modalLabels = await page.evaluate(() => ({
        title: document.getElementById('modal-title')?.textContent?.trim(),
        sort: Array.from(document.querySelectorAll('#ar-history-sort option')).map((o) => o.textContent.trim()),
        filters: Array.from(document.querySelectorAll('.ar-history-filter')).map((b) => b.textContent.trim()),
        searchPlaceholder: document.getElementById('ar-history-search')?.getAttribute('placeholder'),
        rows: document.querySelectorAll('.ar-history-item').length
    }));
    check('zh-HK：清單標題與控制項為香港繁體',
        modalLabels.title === '閱讀記錄'
        && modalLabels.sort.includes('最近閱讀')
        && modalLabels.filters.includes('全部來源')
        && modalLabels.searchPlaceholder === '搜尋標題或內文', JSON.stringify(modalLabels));
    check('手機：清單可見 3 篇', modalLabels.rows === 3, String(modalLabels.rows));

    const overflow = await page.evaluate(() => ({
        docWidth: document.documentElement.scrollWidth,
        viewport: window.innerWidth,
        listWidth: document.querySelector('.ar-history-list')?.scrollWidth,
        listClient: document.querySelector('.ar-history-list')?.clientWidth
    }));
    check('手機：沒有水平溢出', overflow.docWidth <= overflow.viewport + 1 && (overflow.listWidth || 0) <= (overflow.listClient || 0) + 1, JSON.stringify(overflow));

    await page.click('.ar-history-item[data-key="art_alpha"] .ar-history-open');
    await page.waitForTimeout(600);
    const opened = await state(page);
    check('手機：可開啟記錄並渲染', opened.input.startsWith('Alpha body one.') && opened.paragraphs === 2, JSON.stringify({ p: opened.paragraphs }));

    check('手機 zh-HK 無 console 錯誤', errors.length === 0, JSON.stringify(errors.slice(0, 6)));
    await context.close();
}

(async () => {
    const browser = await chromium.launch({
        headless: true,
        executablePath: CHROME
    });
    try {
        await desktopZhCn(browser);
        await mobileZhHk(browser);
    } finally {
        await browser.close();
    }
    console.log(`\n=== 結果：${failures.length ? failures.length + ' 項失敗' : '全部通過'} ===`);
    if (failures.length) {
        for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
        process.exit(1);
    }
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
