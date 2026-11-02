// 發布驗證：隔離瀏覽器只讀取正式靜態資源，配置與帳戶資料均使用測試值。
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const root = process.env.BDC_RELEASE_ROOT;
const output = process.env.BDC_ASSET_DIR;
assert(root && output, 'BDC_RELEASE_ROOT / BDC_ASSET_DIR required');
const bases = ['http://10.10.10.149:8001', 'https://bdc.a4a4.qzz.io'];
const hash = data => crypto.createHash('sha256').update(data).digest('hex');

(async () => {
    await fs.mkdir(output, { recursive: true });
    const expectedHtml = await fs.readFile(path.join(root, 'index.html'), 'utf8');
    const importMap = JSON.parse(expectedHtml.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]);
    const release = new URL(Object.values(importMap.imports)[0], bases[0]).searchParams.get('v');
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    const results = [];
    try {
        for (const base of bases) {
            const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
            const page = await context.newPage();
            const errors = [];
            const responses = [];
            const observed = [];
            page.on('pageerror', error => errors.push(error.message));
            await context.route('**/*', route => {
                const url = new URL(route.request().url());
                if (url.pathname === '/ai-config.js') return route.fulfill({
                    contentType: 'application/javascript',
                    body: 'export const SYNC={endpoint:""}; export const TTS_CONFIG={},AI_LIMITS={},OCR_CONFIG={},ARTICLE_IMPORT={},SUPABASE={},QA_CHECK={};'
                });
                return url.origin === base ? route.continue() : route.abort();
            });
            page.on('response', response => {
                const url = new URL(response.url());
                if (url.origin !== base || url.pathname === '/ai-config.js') return;
                if (!/\.(?:m?js|css)$/.test(url.pathname)) return;
                responses.push((async () => {
                    const bytes = await response.body();
                    const expected = await fs.readFile(path.join(root, url.pathname.slice(1)));
                    observed.push({
                        path: url.pathname, version: url.searchParams.get('v'), status: response.status(),
                        sha256: hash(bytes), expected: hash(expected)
                    });
                })().catch(error => errors.push(`${url.pathname}: ${error.message}`)));
            });
            try {
                await page.goto(base + '/', { waitUntil: 'networkidle', timeout: 60000 });
                const actualMap = await page.locator('script[type="importmap"]').textContent();
                assert.deepEqual(JSON.parse(actualMap), importMap, 'deployed import map differs');
                const close = page.locator('#app-modal:not(.hidden) .modal-close-btn');
                if (await close.isVisible()) await close.click();
                await page.locator('#app-gear-btn').click();
                await page.locator('#gear-menu').waitFor();
                const cnStatus = await page.locator('#gear-menu .menu-status').innerText();
                assert.equal(cnStatus, '未登录');
                await page.evaluate(async () => (await import('/modules/i18n.js')).setLocale('zh-HK'));
                await page.setViewportSize({ width: 390, height: 844 });
                const hkStatus = await page.locator('#gear-menu .menu-status').innerText();
                assert.equal(hkStatus, '未登入');
                assert.equal(await page.locator('#gm-sync .mi-text').innerText(), '立即同步');
                await Promise.all(responses);
                assert.deepEqual(errors, []);
                assert.ok(observed.length >= 90, `only ${observed.length} modules / styles loaded`);
                assert.ok(observed.every(item => item.status === 200 && item.sha256 === item.expected), 'resource hash mismatch');
                assert.ok(observed.every(item => item.version === release), 'unversioned or stale module request');
                for (const required of ['/modules/reading-sync.js', '/features/sync/sync.js', '/features/sync/sync-status.js', '/modules/dom.js', '/locales/zh-CN.js', '/locales/zh-HK.js']) {
                    assert.ok(observed.some(item => item.path === required), `missing ${required}`);
                }
                results.push({ base, release, cnStatus, hkStatus, checked: observed.length, errors, resources: observed });
                console.log(`PASS ${base}: ${observed.length} module/style hashes match, ${release}, zh-CN / zh-HK`);
            } finally {
                await context.close();
            }
        }
    } finally {
        await browser.close();
        await fs.writeFile(path.join(output, 'browser-verification.json'), JSON.stringify({ release, results }, null, 2) + '\n');
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
