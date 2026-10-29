/**
 * 閱讀筆記匯出的 Playwright 助手。
 *
 * 頂部與面板入口共用 `.options-modal-overlay.reading-export-dialog`：
 *   - `format` 單選預設為 HTML；此助手明確改選 Markdown，保留舊測試的 note-only 行為。
 *   - Markdown 範圍使用 `fullText`、`chat` 核取方塊。
 *   - `fullBackup: true` 改走獨立的 `#reading-export-json` 備份入口，沒有格式／範圍選項。
 *   - 配置完成後才確認 `#confirm-btn` 並等待實際 download；成功後對話框關閉。
 */
const EXPORT_DIALOG = '.options-modal-overlay.reading-export-dialog';

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
    const entry = fullBackup ? '#reading-export-json' : selector;
    if (fullBackup) {
        const tools = page.locator('.reading-tools');
        if (await tools.count() && !(await tools.evaluate((element) => element.open))) {
            await tools.locator('summary').click();
        }
    }
    await page.click(entry);
    await page.waitForSelector(`${EXPORT_DIALOG} #confirm-btn`, { timeout: 10000 });
    if (!fullBackup) {
        await page.evaluate((dialogSelector) => {
            const markdown = document.querySelector(`${dialogSelector} .radio-group[data-option-key="format"] input[value="markdown"]`);
            if (!markdown) throw new Error('export format radio missing: markdown');
            markdown.click();
        }, EXPORT_DIALOG);
        for (const [key, desired] of [['fullText', fullText], ['chat', chat]]) {
            await page.evaluate(({ dialogSelector, key, desired }) => {
                const box = document.querySelector(`${dialogSelector} input[type="checkbox"][data-option-key="${key}"]`);
                if (!box) throw new Error(`export scope checkbox missing: ${key}`);
                // 開關的 input 在對話框內是 0×0 疊在 label 上，改用 DOM click 才穩定。
                if (box.checked !== desired) box.click();
            }, { dialogSelector: EXPORT_DIALOG, key, desired: !!desired });
        }
    }
    const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 30000 }),
        page.click(`${EXPORT_DIALOG} #confirm-btn`)
    ]);
    await page.waitForSelector(EXPORT_DIALOG, { state: 'detached', timeout: 10000 });
    return download;
}

module.exports = { exportReadingNote };
