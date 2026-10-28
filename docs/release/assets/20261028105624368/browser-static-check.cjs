/**
 * 核對正式 HTTP 資源與指定 Git 提交；以 JavaScript 純文字文件建立同源 context。
 * 不啟動應用、不讀取帳戶；私有設定只在記憶體中計算雜湊。
 * BASE_URL=<url> RELEASE_REF=<commit> CONFIG_SHA256=<hash> OUTPUT_FILE=<json> \
 * PLAYWRIGHT_MODULE=<path> node <this-file>
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const base = new URL(process.env.BASE_URL || 'https://bdc.a4a4.qzz.io').origin;
const ref = process.env.RELEASE_REF;
const configSha = process.env.CONFIG_SHA256;
assert.ok(ref && /^[0-9a-f]{64}$/.test(configSha || ''), 'RELEASE_REF and CONFIG_SHA256 are required');
const root = path.resolve(__dirname, '../../../..');
const source = name => execFileSync('git', ['show', `${ref}:${name}`], { cwd: root });
const digest = body => crypto.createHash('sha256').update(body).digest('hex');
const html = source('index.html');
const imports = JSON.parse(html.toString().match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]).imports;
const release = new URL(Object.values(imports)[0], base).searchParams.get('v');
const expected = [{ path: '/', sha256: digest(html) },
    { path: '/index.html', sha256: digest(html) },
    { path: `/styles.css?v=${release}`, sha256: digest(source('styles.css')) },
    ...Object.entries(imports).map(([name, url]) => ({ path: url, sha256: digest(source(name.replace(/^\//, ''))) }))];
const excluded = ['/.git/config', '/.env', '/docs/', '/scripts/serve.py', '/tests/article-navigation.cjs',
    '/selfhost/package.json', '/cloudflare-worker/wrangler.toml', '/deploy/nginx.conf',
    '/ai-config.example.js', '/test-floating-statusbar.html', '/node_modules/', '/Dockerfile',
    '/docker-compose.yml', '/missing-release-route', '/shared/missing.mjs'];

(async () => {
    const browser = await chromium.launch({
        executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless: true
    });
    try {
        const context = await browser.newContext({ serviceWorkers: 'block' });
        const allowed = new Set([...expected.map(item => new URL(item.path, base).pathname), ...excluded, '/ai-config.js']);
        await context.route('**/*', route => {
            const url = new URL(route.request().url());
            return url.origin === base && allowed.has(url.pathname) ? route.continue() : route.abort();
        });
        const page = await context.newPage();
        await page.goto(`${base}/modules/article-route.js?v=${release}`, { waitUntil: 'domcontentloaded' });
        const result = await page.evaluate(async ({ expected, excluded, configSha }) => {
            async function read(url) {
                try {
                    const response = await fetch(url, { cache: 'no-store', credentials: 'omit' });
                    const bytes = await response.arrayBuffer();
                    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
                        value => value.toString(16).padStart(2, '0')).join('');
                    return { path: url, status: response.status, sha256: hash,
                        mime: response.headers.get('content-type') || '',
                        cacheControl: response.headers.get('cache-control') || '' };
                } catch (error) {
                    return { path: url, error: error.message };
                }
            }
            const assets = [];
            for (let index = 0; index < expected.length; index += 5) {
                assets.push(...await Promise.all(expected.slice(index, index + 5).map(async wanted => {
                    const item = await read(wanted.path);
                    const pathname = new URL(wanted.path, location.origin).pathname;
                    const mime = item.mime || '';
                    const goodMime = /\.(?:m?js)$/.test(pathname) ? mime.includes('javascript')
                        : pathname.endsWith('.css') ? mime.includes('text/css') : mime.includes('text/html');
                    return { ...item, expected: wanted.sha256,
                        pass: item.status === 200 && item.sha256 === wanted.sha256 && goodMime };
                })));
            }
            const blocked = await Promise.all(excluded.map(async url => {
                const item = await read(url);
                return { path: url, status: item.status, pass: item.status === 404, ...(item.error ? { error: item.error } : {}) };
            }));
            const config = await read('/ai-config.js');
            const privateConfig = { ...config,
                pass: config.status === 200 && config.sha256 === configSha && config.cacheControl.includes('no-store') };
            return { assets, blocked, privateConfig };
        }, { expected, excluded, configSha });
        const evidence = { base, ref, release, client: 'Google Chrome / Playwright',
            checkedAt: new Date().toISOString(), ...result };
        fs.writeFileSync(process.env.OUTPUT_FILE || path.join(__dirname, 'public-static.json'), JSON.stringify(evidence, null, 2) + '\n');
        const failed = [...result.assets, ...result.blocked, result.privateConfig].filter(item => !item.pass);
        assert.equal(failed.length, 0, JSON.stringify(failed, null, 2));
        console.log(`PASS ${base}: ${result.assets.length} asset hashes/MIME, ${result.blocked.length} excluded paths, unchanged private config/no-store; release ${release}`);
    } finally {
        await browser.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
