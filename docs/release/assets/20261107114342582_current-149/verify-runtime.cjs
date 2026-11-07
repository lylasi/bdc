const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = __dirname;
const expected = JSON.parse(fs.readFileSync(path.join(root, 'expected-runtime.json')));
const entries = Object.entries(expected.assets || expected.files).map(([file, sha256]) => ({
    file, sha256, url: file === 'index.html' ? '/' : '/' + file + '?v=' + expected.release
}));
(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
    const checks = [];
    try {
        for (const base of ['http://10.10.10.149:8001', 'https://bdc.a4a4.qzz.io']) {
            const context = await browser.newContext();
            await context.addInitScript(() => { window.__BDC_SYNC_ENDPOINT__ = 'http://127.0.0.1:19999/runtime-verification'; });
            await context.route('**/*', (route) => {
                const url = new URL(route.request().url());
                if (url.pathname === '/ai-config.js') return route.fulfill({
                    contentType: 'application/javascript',
                    body: 'export const SYNC={endpoint:""}; export const TTS_CONFIG={}, AI_LIMITS={}, OCR_CONFIG={}, ARTICLE_IMPORT={}, SUPABASE={};'
                });
                return url.origin === base ? route.continue() : route.abort();
            });
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', (error) => errors.push(error.message));
            await page.exposeFunction('__bdcVerifyDigest', (bytes) => crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex'));
            await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
            const rows = await page.evaluate(async (entries) => {
                let cursor = 0;
                const results = [];
                const worker = async () => {
                    while (cursor < entries.length) {
                        const item = entries[cursor++];
                        const response = await fetch(item.url, { cache: 'no-store' });
                        const sha256 = await window.__bdcVerifyDigest(Array.from(new Uint8Array(await response.arrayBuffer())));
                        results.push({ file: item.file, url: location.origin + item.url, status: response.status, sha256, expected: item.sha256, ok: response.ok && sha256 === item.sha256 });
                    }
                };
                await Promise.all(Array.from({ length: 8 }, worker));
                return results;
            }, entries);
            checks.push(...rows);
            if (errors.length || rows.some((row) => !row.ok)) throw new Error(JSON.stringify({ base, errors, failed: rows.filter((row) => !row.ok) }));
            console.log('PASS', base, rows.length, 'runtime assets match committed release', expected.release);
            await context.close();
        }
        fs.writeFileSync(path.join(root, 'online-runtime.json'), JSON.stringify({ release: expected.release, checks }, null, 2) + '\n');
        console.log('PASS', checks.length, 'checks total');
    } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
