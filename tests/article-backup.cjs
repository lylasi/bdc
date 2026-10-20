/**
 * 文章備份／匯出／離線還原驗收。
 *
 * 用法：
 *   PORT=8313 PLAYWRIGHT_MODULE=<path-to-playwright> node tests/article-backup.cjs
 *
 * 覆蓋：
 *   1. 建立備份後，備份內容包含每篇文章的原文、分析結果與來源（完整可還原）
 *   2. 清空全部文章 → 從本機備份還原 → 每篇都能開啟
 *   3. 匯出備份檔 → 在「空白裝置」匯入該檔 → 還原 → 內容與分析完整
 */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.PORT || 8313);
const BASE = `http://127.0.0.1:${PORT}/`;
const ENDPOINT = process.env.TEST_SYNC_ENDPOINT || 'http://127.0.0.1:19999/backup-endpoint';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const failures = [];
function check(name, condition, detail) {
    if (condition) { console.log(`  ok   ${name}`); return true; }
    failures.push({ name, detail: detail === undefined ? '' : String(detail).slice(0, 400) });
    console.log(`  FAIL ${name}${detail !== undefined ? ' -- ' + String(detail).slice(0, 300) : ''}`);
    return false;
}

const DOCS = [
    {
        id: 'art_backup_a',
        title: 'Backup Alpha',
        body: 'Backup alpha body.',
        analysis: { chinese_translation: '備份甲', paragraph_analysis: [{ chinese_translation: '備份甲一' }], detailed_analysis: [{ word: 'alpha', sentence: 'Backup alpha body.', analysis: { meaning: '阿爾法' } }] },
        sourceType: 'url',
        sourceUrl: 'https://example.com/backup-alpha',
        revision: 4,
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-17T00:00:00.000Z',
        lastOpenedAt: '2026-10-18T09:00:00.000Z'
    },
    {
        id: 'art_backup_b',
        title: 'Backup Beta',
        body: 'Backup beta body.',
        analysis: null,
        sourceType: 'paste',
        revision: 0,
        createdAt: '2026-10-02T00:00:00.000Z',
        updatedAt: '2026-10-02T00:00:00.000Z',
        lastOpenedAt: ''
    }
];

async function newPage(browser) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
    await context.addInitScript((endpoint) => {
        window.__BDC_SYNC_ENDPOINT__ = endpoint;
    }, ENDPOINT);
    const page = await context.newPage();
    const errors = [];
    page.on('console', (m) => { if (m.type() !== 'error') return; const text = m.text(); if (/Failed to load resource|ERR_CONNECTION_REFUSED|ERR_UNSAFE_PORT|404|501/i.test(text)) return; errors.push(text.slice(0, 240)); });
    page.on('pageerror', (e) => errors.push('PAGEERROR ' + String(e && e.stack ? e.stack.split('\n')[0] : e)));
    return { context, page, errors };
}

async function seedDocs(page) {
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
            docs.forEach((doc) => store.put({ ...doc, scope, key: `${scope}\u0000${doc.id}`, dirty: false, pending: false, sizeBytes: doc.body.length }));
            tx.oncomplete = resolve;
        });
        db.close();
        return docs.length;
    }, { endpoint: ENDPOINT, docs: DOCS });
}

async function closeAnyModal(page) {
    for (let i = 0; i < 6; i += 1) {
        const open = await page.evaluate(() => !document.getElementById('app-modal').classList.contains('hidden'));
        if (!open) return true;
        await page.evaluate(() => {
            const btn = document.querySelector('#app-modal .modal-close-btn');
            if (btn) btn.click();
        });
        await page.waitForTimeout(220);
    }
    return page.evaluate(() => document.getElementById('app-modal').classList.contains('hidden'));
}

async function openBackupPanel(page) {
    await page.click('#app-gear-btn');
    await page.waitForTimeout(250);
    await page.click('#gm-backup-panel');
    await page.waitForTimeout(400);
}

async function recordKeys(page) {
    // 點這個按鈕會立刻開彈窗；用 DOM click 避免 Playwright 的可點擊性判定與彈窗互相等待
    await page.evaluate(() => document.getElementById('article-history-btn')?.click());
    await page.waitForTimeout(350);
    const keys = await page.evaluate(() => Array.from(document.querySelectorAll('.ar-history-item')).map((row) => row.getAttribute('data-key')));
    await closeAnyModal(page);
    return keys;
}

(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: CHROME });
    const { context, page, errors } = await newPage(browser);
    await page.goto(BASE + '#a', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    // 首次啟動的「開始之前」提示
    if (await page.evaluate(() => !document.getElementById('app-modal').classList.contains('hidden'))) {
        await page.click('#app-modal .modal-close-btn').catch(() => {});
        await page.waitForTimeout(200);
    }
    await seedDocs(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1600);
    check('起始有 2 篇文章', (await recordKeys(page)).length === 2);

    console.log('\n[建立備份]');
    await openBackupPanel(page);
    await page.click('#bk-create');
    // 建立備份是非同步的；面板會在完成後自行重建，必須等它重建完再關閉
    await page.waitForFunction(() => /已建立備份|已建立备份/.test(document.getElementById('bk-msg')?.textContent || ''), null, { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(800);
    const backups = await page.evaluate(() => {
        const idx = JSON.parse(localStorage.getItem('bdc:backup:index:v1') || '[]');
        return idx.map((id) => {
            const raw = localStorage.getItem('bdc:backup:v1:' + id);
            const parsed = raw ? JSON.parse(raw) : null;
            return {
                id,
                note: parsed?.note,
                hasDocuments: Array.isArray(parsed?.payload?.articleDocuments),
                docCount: parsed?.payload?.articleDocuments?.length || 0,
                firstBody: parsed?.payload?.articleDocuments?.[0]?.body || '',
                firstAnalysis: parsed?.payload?.articleDocuments?.[0]?.analysis || null,
                firstSource: parsed?.payload?.articleDocuments?.[0]?.sourceUrl || ''
            };
        });
    });
    const backup = backups.find((item) => item.hasDocuments);
    check('備份包含完整文章文件', !!backup && backup.docCount === 2, JSON.stringify(backups));
    check('備份保留原文與分析結果',
        !!backup && /Backup alpha body/.test(backup.firstBody) && !!backup.firstAnalysis?.detailed_analysis,
        JSON.stringify({ body: backup?.firstBody, analysis: backup?.firstAnalysis }));
    check('備份保留來源網址', backup?.firstSource === 'https://example.com/backup-alpha', backup?.firstSource);

    console.log('\n[清空後從本機備份還原]');
    check('備份面板可關閉', await closeAnyModal(page));
    await page.waitForTimeout(300);
    await page.evaluate(() => document.getElementById('article-history-btn')?.click());
    await page.waitForTimeout(350);
    await page.waitForTimeout(300);
    await page.click('#ar-history-clear');
    await page.waitForTimeout(300);
    await page.click('.options-modal-overlay #confirm-btn').catch(() => {});
    await page.waitForTimeout(600);
    check('清空後沒有文章', (await recordKeys(page)).length === 0);

    await openBackupPanel(page);
    await page.click('.bi-restore');
    await page.waitForTimeout(1200);
    const restoredKeys = await recordKeys(page);
    check('還原後文章數量正確', restoredKeys.length === 2 && restoredKeys.includes('art_backup_a') && restoredKeys.includes('art_backup_b'), JSON.stringify(restoredKeys));

    // 開啟還原的文章，確認分析結果可以顯示
    await page.evaluate(() => document.getElementById('article-history-btn')?.click());
    await page.waitForTimeout(350);
    await page.click('.ar-history-item[data-key="art_backup_a"] .ar-history-open');
    await page.waitForTimeout(500);
    const opened = await page.evaluate(() => ({
        input: document.getElementById('article-input').value,
        paragraphs: document.querySelectorAll('#article-analysis-container .paragraph-pair').length,
        chinese: document.querySelector('#article-analysis-container .paragraph-chinese')?.textContent?.trim() || ''
    }));
    check('還原的文章可以開啟並顯示分析', opened.input === 'Backup alpha body.' && opened.paragraphs >= 1 && /備份甲/.test(opened.chinese), JSON.stringify(opened));

    console.log('\n[匯出檔案 → 空白裝置匯入還原]');
    await openBackupPanel(page);
    const downloadPromise = page.waitForEvent('download', { timeout: 8000 });
    await page.click('.bi-export');
    const download = await downloadPromise;
    const tmpFile = path.join(os.tmpdir(), `bdc-backup-${Date.now()}.json`);
    await download.saveAs(tmpFile);
    const exported = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
    check('匯出檔包含文章文件', Array.isArray(exported.articleDocuments) && exported.articleDocuments.length === 2,
        JSON.stringify({ keys: Object.keys(exported), docs: exported.articleDocuments?.length }));

    // 模擬空白裝置：清掉文章與本機備份索引
    check('匯出後面板可關閉', await closeAnyModal(page));
    await page.evaluate(async () => {
        localStorage.removeItem('bdc:backup:index:v1');
        Object.keys(localStorage).filter((k) => k.startsWith('bdc:backup:v1:')).forEach((k) => localStorage.removeItem(k));
        const db = await new Promise((resolve) => { const req = indexedDB.open('bdc-articles'); req.onsuccess = () => resolve(req.result); });
        await new Promise((resolve) => {
            const tx = db.transaction(['docs', 'article_summaries'], 'readwrite');
            tx.objectStore('docs').clear();
            tx.objectStore('article_summaries').clear();
            tx.oncomplete = resolve;
        });
        db.close();
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1600);
    check('空白裝置沒有文章', (await recordKeys(page)).length === 0);

    await openBackupPanel(page);
    await page.setInputFiles('#bk-import', tmpFile);
    await page.waitForTimeout(900);
    const importedList = await page.evaluate(() => document.querySelectorAll('.backup-item').length);
    check('匯入檔案後出現在備份列表', importedList >= 1, String(importedList));
    await page.click('.bi-restore');
    await page.waitForTimeout(1200);
    const offlineKeys = await recordKeys(page);
    check('離線還原後文章齊全', offlineKeys.length === 2 && offlineKeys.includes('art_backup_a'), JSON.stringify(offlineKeys));
    await page.evaluate(() => document.getElementById('article-history-btn')?.click());
    await page.waitForTimeout(350);
    await page.click('.ar-history-item[data-key="art_backup_b"] .ar-history-open');
    await page.waitForTimeout(400);
    check('離線還原的未分析文章也能開啟',
        (await page.evaluate(() => document.getElementById('article-input').value)) === 'Backup beta body.');

    check('無 console 錯誤', errors.length === 0, JSON.stringify(errors.slice(0, 6)));
    try { fs.unlinkSync(tmpFile); } catch (_) {}
    await browser.close();
    console.log(`\n=== 結果：${failures.length ? failures.length + ' 項失敗' : '全部通過'} ===`);
    if (failures.length) {
        for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
        process.exit(1);
    }
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
