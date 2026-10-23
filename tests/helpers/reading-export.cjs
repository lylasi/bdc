/**
 * 閱讀筆記匯出的 Playwright 助手。
 *
 * P2-T7 起 `#reading-export-md`（以及頂部的 `#article-reading-export-btn`）
 * 不再直接下載，而是先開「匯出範圍」對話框（modules/ui.js showOptionsModal）：
 *   - 外殼：`.options-modal-overlay`
 *   - 選項：`input[data-option-key="fullText" | "chat" | "fullBackup"]`（預設全部未勾 = note-only）
 *   - 動作：`#confirm-btn` / `#cancel-btn`
 * 因此測試必須先勾選需要的範圍再確認，才能等到 download 事件。
 */

/**
 * 依指定範圍匯出閱讀筆記，並回傳 Playwright 的 download 物件。
 *
 * @param {import('playwright').Page} page
 * @param {{ fullText?: boolean, chat?: boolean, fullBackup?: boolean, selector?: string }} [options]
 * @returns {Promise<import('playwright').Download>}
 */
async function exportReadingNote(page, {
    fullText = false,
    chat = false,
    fullBackup = false,
    selector = '#reading-export-md'
} = {}) {
    const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
    await page.click(selector);
    await page.waitForSelector('.options-modal-overlay #confirm-btn', { timeout: 10000 });
    for (const [key, desired] of [['fullText', fullText], ['chat', chat], ['fullBackup', fullBackup]]) {
        await page.evaluate(({ key, desired }) => {
            const box = document.querySelector(`.options-modal-overlay input[type="checkbox"][data-option-key="${key}"]`);
            if (!box) throw new Error(`export scope checkbox missing: ${key}`);
            // 開關的 input 在對話框內是 0×0 疊在 label 上，改用 DOM click 才穩定。
            if (box.checked !== desired) box.click();
        }, { key, desired: !!desired });
    }
    await page.click('.options-modal-overlay #confirm-btn');
    return downloadPromise;
}

module.exports = { exportReadingNote };
