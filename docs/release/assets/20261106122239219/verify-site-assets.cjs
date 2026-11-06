const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const ROOT = path.resolve(__dirname, '../../../..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const imports = JSON.parse(html.match(/<script type="importmap">\s*([\s\S]*?)<\/script>/)[1]).imports;
const paths = ['/', '/index.html', '/styles.css?v=a365703cb9c7', ...Object.values(imports)];
const expected = Object.fromEntries(paths.map((url) => [url,
    createHash('sha256').update(fs.readFileSync(path.join(ROOT, url === '/' ? 'index.html' : url.split('?')[0].slice(1)))).digest('hex')]));
const blockedPaths = ['/.git/config', '/.env', '/docs/', '/scripts/serve.py', '/tests/extension-capture.cjs',
    '/selfhost/package.json', '/cloudflare-worker/wrangler.toml', '/deploy/nginx.conf', '/ai-config.example.js',
    '/test-floating-statusbar.html', '/node_modules/', '/Dockerfile', '/docker-compose.yml', '/missing-release-route', '/shared/missing.mjs'];
const configHash = '6961935c69385e837692203fb0eba506a04b7d7b99680ef0e2dd5d09870aec93';
function mimeOK(url, mime) {
    const suffix = url.split('?')[0];
    return /\.(js|mjs)$/.test(suffix) ? mime.includes('javascript') : suffix.endsWith('.css') ? mime.includes('text/css') : mime.includes('text/html');
}
(async () => {
    let browser;
    try {
        const base = 'http://10.10.10.149:8001';
        const assets = [];
        for (const [url, wanted] of Object.entries(expected)) {
            const response = await fetch(base + url, { signal: AbortSignal.timeout(20000) });
            const sha256 = createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');
            const mime = response.headers.get('content-type') || '';
            assets.push({ url, status: response.status, sha256, pass: response.status === 200 && sha256 === wanted && mimeOK(url, mime) });
        }
        const blocked = [];
        for (const url of blockedPaths) {
            const r = await fetch(base + url, { signal: AbortSignal.timeout(20000) });
            blocked.push({ url, status: r.status, pass: r.status === 404 });
        }
        const config = await fetch(base + '/ai-config.js');
        const sha256 = createHash('sha256').update(Buffer.from(await config.arrayBuffer())).digest('hex');
        const privateConfig = { sha256, status: config.status, cacheControl: config.headers.get('cache-control'),
            pass: config.status === 200 && sha256 === configHash && (config.headers.get('cache-control') || '').includes('no-store') };
        const lan = { base, release: 'a365703cb9c7', assets, blocked, privateConfig, pass: [...assets, ...blocked, privateConfig].every((x) => x.pass) };
        fs.writeFileSync(path.join(__dirname, 'assets-lan.json'), JSON.stringify(lan, null, 2) + '\n');
        assert.ok(lan.pass, 'LAN resources match deployed release');
        console.log('PASS LAN: ' + assets.length + ' matching assets, ' + blocked.length + ' blocked paths, private config unchanged');
        browser = await chromium.launch({ channel: 'chromium', headless: true });
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto('https://bdc.a4a4.qzz.io/', { waitUntil: 'domcontentloaded', timeout: 60000 });
        const publicResult = await page.evaluate(async ({ expected, blockedPaths, configHash }) => {
            const digest = async (buffer) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))].map((n) => n.toString(16).padStart(2, '0')).join('');
            const assets = [];
            for (const [url, wanted] of Object.entries(expected)) {
                const response = await fetch(url, { cache: 'reload' });
                const sha256 = await digest(await response.arrayBuffer());
                const mime = response.headers.get('content-type') || '';
                const suffix = url.split('?')[0];
                const goodMime = /\.(js|mjs)$/.test(suffix) ? mime.includes('javascript') : suffix.endsWith('.css') ? mime.includes('text/css') : mime.includes('text/html');
                assets.push({ url, status: response.status, sha256, pass: response.status === 200 && sha256 === wanted && goodMime });
            }
            const blocked = [];
            for (const url of blockedPaths) {
                const response = await fetch(url, { cache: 'reload' });
                blocked.push({ url, status: response.status, pass: response.status === 404 });
            }
            const response = await fetch('/ai-config.js', { cache: 'reload' });
            const sha256 = await digest(await response.arrayBuffer());
            const privateConfig = { status: response.status, sha256, cacheControl: response.headers.get('cache-control') };
            privateConfig.pass = response.status === 200 && sha256 === configHash && (privateConfig.cacheControl || '').includes('no-store');
            return { assets, blocked, privateConfig, pass: [...assets, ...blocked, privateConfig].every((x) => x.pass) };
        }, { expected, blockedPaths, configHash });
        publicResult.pageErrors = errors;
        fs.writeFileSync(path.join(__dirname, 'assets-public.json'), JSON.stringify(publicResult, null, 2) + '\n');
        assert.ok(publicResult.pass, 'Public resources match deployed release');
        assert.equal(errors.length, 0);
        console.log('PASS public: ' + publicResult.assets.length + ' matching assets, ' + publicResult.blocked.length + ' blocked paths, private config unchanged, no page errors');
    } finally {
        if (browser) await browser.close();
    }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
