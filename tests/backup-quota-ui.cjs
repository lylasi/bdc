// 真實瀏覽器 localStorage 填滿後的備份搬移、建立、匯出／匯入及後備錯誤文案。
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const BASE = `http://127.0.0.1:${process.env.PORT || 8313}`;

async function run(browser, locale, idb) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
    await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/ai-config.js') return route.fulfill({ contentType: 'application/javascript', body: 'export const SYNC={endpoint:""}; export const TTS_CONFIG={},AI_LIMITS={},OCR_CONFIG={},ARTICLE_IMPORT={},SUPABASE={},QA_CHECK={};' });
        return url.origin === BASE ? route.continue() : route.abort();
    });
    await context.addInitScript(({ locale, idb }) => {
        if (!idb) Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined });
        localStorage.setItem('pen_global_settings', JSON.stringify({ language: { interfaceLocale: locale }, theme: 'teal' }));
        for (let index = 0; index < 4; index += 1) {
            const id = String(1700000000000 + index);
            localStorage.setItem('bdc:backup:v1:' + id, JSON.stringify({ ts: Number(id), note: index < 3 ? 'manual original' : 'auto original', payload: { reading: { note: '筆記'.repeat(150000) } } }));
        }
        let padding = '';
        for (;;) {
            try { localStorage.setItem('test-padding', padding + 'x'.repeat(10000)); padding += 'x'.repeat(10000); }
            catch (_) { break; }
        }
    }, { locale, idb });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
        await page.goto(BASE, { waitUntil: 'networkidle' });
        const close = page.locator('#app-modal:not(.hidden) .modal-close-btn');
        if (await close.isVisible()) await close.click();
        await page.locator('#app-gear-btn').click();
        await page.locator('#gm-backup-panel').click();
        await page.locator('#bk-create').waitFor();
        assert.equal(await page.locator('.backup-item').count(), 4);
        if (!idb) await page.evaluate(() => {
            let padding = localStorage.getItem('test-padding') || '';
            for (;;) {
                try { localStorage.setItem('test-padding', padding + 'x'.repeat(256)); padding += 'x'.repeat(256); }
                catch (_) { break; }
            }
        });
        await page.locator('#bk-create').click();
        if (!idb) {
            await page.waitForFunction(() => /空间不足|空間不足/.test(document.getElementById('bk-msg')?.textContent || ''));
            assert.equal(await page.locator('.backup-item').count(), 4);
            const message = await page.locator('#bk-msg').innerText();
            assert.ok(message.includes(locale === 'zh-CN' ? '不要清除网站数据' : '不要清除網站資料'));
        } else {
            await page.waitForFunction(() => document.querySelectorAll('.backup-item').length === 5);
            const state = await page.evaluate(async () => {
                const backup = await import('/modules/local-backup.js');
                const items = await backup.listBackups();
                const original = await Promise.all(items.filter(item => item.note.endsWith('original')).map(item => backup.loadBackupPayload(item.id)));
                return { count: items.length, originals: original.map(payload => payload.reading.note.length), legacy: Object.keys(localStorage).filter(key => key.startsWith('bdc:backup:v1:')) };
            });
            assert.deepEqual(state.originals, [300000, 300000, 300000, 300000]);
            assert.deepEqual(state.legacy, []);
            const downloadPromise = page.waitForEvent('download');
            await page.locator('.bi-export').first().click();
            const download = await downloadPromise;
            const payload = JSON.parse(await fs.readFile(await download.path(), 'utf8'));
            assert.ok(payload.reading?.ok);
            assert.ok(Array.isArray(payload.articleDocuments));
            await page.locator('#bk-import').setInputFiles({ name: 'imported-backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ payload: { qa: { updatedAt: '2026-11-02T00:00:00Z', manifest: [], sets: {} } } })) });
            await page.waitForFunction(() => document.querySelectorAll('.backup-item').length === 6);
            await page.locator('.bi-delete').first().click();
            await page.waitForFunction(() => document.querySelectorAll('.backup-item').length === 5);
        }
        assert.deepEqual(errors, []);
        console.log(`PASS ${locale} ${idb ? 'IndexedDB migration / create / export / import / delete' : 'quota fallback preserves backups and explains failure'}`);
    } finally { await context.close(); }
}

(async () => {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
        for (const locale of ['zh-CN', 'zh-HK']) {
            await run(browser, locale, true);
            await run(browser, locale, false);
        }
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
