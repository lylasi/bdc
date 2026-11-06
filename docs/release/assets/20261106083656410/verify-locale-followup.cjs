const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const extension = path.resolve('extension');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-ext-locale-followup-'));
const checks = [];
let context;

(async () => {
    try {
        context = await chromium.launchPersistentContext(profile, {
            channel: 'chromium', headless: true, viewport: { width: 400, height: 900 },
            args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
        });
        const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
        const page = await context.newPage();
        await page.goto(`chrome-extension://${new URL(worker.url()).host}/lookup.html`);
        await page.waitForFunction(() => !!globalThis.__bdcExtensionRuntime);
        const variants = [
            { locale: 'zh-CN', label: '单词或短语', button: '语境查词', notice: '请输入要查询的单词或短语' },
            { locale: 'zh-HK', label: '字詞或詞組', button: '語境查詞', notice: '請輸入要查詢的字詞或詞組' }
        ];
        for (const variant of variants) {
            await page.locator('#ext-locale-select').selectOption(variant.locale);
            await page.locator('#ext-lookup-btn').click();
            await page.waitForFunction(() => !document.querySelector('#ext-lookup-btn').disabled);
            const actual = {
                label: await page.locator('label[for="ext-word-input"]').textContent(),
                button: await page.locator('#ext-lookup-btn').textContent(),
                notice: await page.locator('#ext-lookup-notice').textContent(),
                noOverflow: await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)
            };
            for (const key of ['label', 'button', 'notice', 'noOverflow']) {
                checks.push({ name: `${variant.locale}_${key}`, ok: actual[key] === (key === 'noOverflow' ? true : variant[key]), actual: actual[key] });
            }
            await page.screenshot({ path: path.join(__dirname, `locale-followup-${variant.locale}.png`), fullPage: true });
        }
    } catch (error) {
        checks.push({ name: 'execution', ok: false, error: String(error.message) });
    } finally {
        if (context) await context.close();
        fs.rmSync(profile, { recursive: true, force: true });
        const result = { timestamp: new Date().toISOString(), checks, passed: checks.filter((x) => x.ok).length, failed: checks.filter((x) => !x.ok).length, profileRemoved: !fs.existsSync(profile), accountUsed: false };
        fs.writeFileSync(path.join(__dirname, 'locale-followup-results.json'), JSON.stringify(result, null, 2) + '\n');
        console.log(JSON.stringify(result, null, 2));
        if (result.failed) process.exitCode = 1;
    }
})();
