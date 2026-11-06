const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../../../..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const imports = JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]).imports;
const release = new URL(Object.values(imports)[0], 'http://localhost').searchParams.get('v');
const expected = Object.entries({ '/': '/', ...Object.fromEntries(Object.entries(imports).map(([key, value]) => [value, key])), [`/main.js?v=${release}`]: '/main.js', [`/styles.css?v=${release}`]: '/styles.css' })
    .map(([url, file]) => ({ url, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file === '/' ? 'index.html' : file.slice(1)))).digest('hex') }));
const blocked = ['/.git/config', '/.env', '/docs/', '/scripts/serve.py', '/tests/extension-capture.cjs', '/selfhost/package.json', '/cloudflare-worker/wrangler.toml', '/deploy/nginx.conf', '/ai-config.example.js', '/test-floating-statusbar.html', '/node_modules/', '/Dockerfile', '/docker-compose.yml', '/missing-release-route', '/shared/missing.mjs'];
const configHash = JSON.parse(fs.readFileSync(path.join(__dirname, 'site-before.json'))).config_sha256;
(async () => {
    const browser = await chromium.launch({ channel: 'chromium', headless: true });
    try {
        for (const [name, base] of [['lan', 'http://10.10.10.149:8001'], ['public', 'https://bdc.a4a4.qzz.io']]) {
            const page = await browser.newPage();
            await page.exposeFunction('bdcDigest', (bytes) => crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex'));
            const pageErrors = []; page.on('pageerror', (error) => pageErrors.push(error.message));
            await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
            const result = await page.evaluate(async ({ expected, blocked, configHash }) => {
                const digest = async (response) => globalThis.bdcDigest(Array.from(new Uint8Array(await response.arrayBuffer())));
                const assets = await Promise.all(expected.map(async (item) => {
                    const response = await fetch(item.url, { cache: 'no-store' });
                    const sha256 = await digest(response);
                    return { url: item.url, status: response.status, mime: response.headers.get('content-type'), sha256, pass: response.ok && sha256 === item.sha256 };
                }));
                const excluded = await Promise.all(blocked.map(async (url) => ({ url, status: (await fetch(url, { cache: 'no-store' })).status })));
                const response = await fetch('/ai-config.js', { cache: 'no-store' });
                const privateConfig = { status: response.status, sha256: await digest(response), cacheControl: response.headers.get('cache-control') };
                return { assets, blocked: excluded, privateConfig, pass: assets.every((item) => item.pass) && excluded.every((item) => item.status === 404) && privateConfig.sha256 === configHash && /no-store/.test(privateConfig.cacheControl) };
            }, { expected, blocked, configHash });
            result.pageErrors = pageErrors; result.base = base; result.release = release;
            result.pass &&= pageErrors.length === 0;
            fs.writeFileSync(path.join(__dirname, 'assets-' + name + '.json'), JSON.stringify(result, null, 2) + '\n');
            if (!result.pass) throw new Error(name + ' asset verification failed');
            console.log(`PASS ${name}: ${result.assets.length} assets, ${blocked.length} excluded routes, private configuration hash and cache policy, no page errors`);
            await page.close();
        }
    } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
