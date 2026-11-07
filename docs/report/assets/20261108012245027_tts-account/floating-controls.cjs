const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto('http://127.0.0.1:8357/test-floating-statusbar.html');
        await page.waitForFunction(() => typeof testPlatformDetection === 'function');
        const checks = await page.evaluate(() => {
            testPlatformDetection(); testStatePersistence(); testFloatingControls();
            return ['platform-result', 'state-result', 'ui-result'].map((id) => ({ id,
                ok: document.getElementById(id).classList.contains('success') }));
        });
        assert.ok(checks.every((check) => check.ok));
        await page.screenshot({ path: path.join(__dirname, 'floating-controls.png') });
        await page.evaluate(() => removeFloatingControls());
        assert.equal(await page.locator('#floating-dictation-controls').count(), 0);
        assert.deepEqual(errors, []);
        fs.writeFileSync(path.join(__dirname, 'floating-controls.json'), JSON.stringify({ checks, removal: true, errors }, null, 2) + '\n');
        console.log('PASS platform, persistence, floating controls and removal');
    } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
