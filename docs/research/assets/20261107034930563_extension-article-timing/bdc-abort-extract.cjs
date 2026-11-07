// Scratch: does pressing 停止 during a multi-chunk extraction actually stop?
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE);
const { environment, ALICE } = require('/Users/linus/CODE/bdc/tests/helpers/extension-mv3.cjs');
const ROOT = '/Users/linus/CODE/bdc';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const html = (paras, chars) => `<!doctype html><title>Long</title><article><h1>Long article</h1>${paras.map((_, i) => `<p>RawMarker${i} ${'word '.repeat(chars / 5)}</p>`).join('')}</article>`;
(async () => {
    execFileSync(process.execPath, ['scripts/package-extension.mjs'], { cwd: ROOT });
    const env = await environment(); const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-abort-'));
    let context; const events = []; let clean = 0, aborted = 0;
    try {
        context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
            args: ['--disable-extensions-except=' + ROOT + '/extension', '--load-extension=' + ROOT + '/extension'] });
        context.on('requestfailed', (r) => { if (r.url().includes('/mock-ai/')) aborted += 1; });
        await context.route(env.base + '/long*', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: html(Array.from({ length: 5 }, (_, i) => i), 1400) }));
        await context.route(env.base + '/mock-ai/**', async (route) => {
            if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' } });
            let body = {}; try { body = route.request().postDataJSON() || {}; } catch (_) {}
            const prompt = (body.messages || []).map((m) => m.content || '').join('\n');
            const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
            if (prompt.includes('Clean the supplied Markdown article')) {
                clean += 1; const n = clean;
                const marker = (prompt.match(/RawMarker(\d)/) || [])[1];
                events.push('clean start ' + n + ' marker=' + marker + ' chars=' + prompt.length);
                await sleep(2500);
                events.push('clean end ' + n);
                return route.fulfill({ status: 200, headers, body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: `# Clean${n}\n\nCleanMarker${n} body.` } }] }) });
            }
            return route.fulfill({ status: 200, headers, body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{}' } }] }) });
        });
        const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
        const base = 'chrome-extension://' + new URL(worker.url()).host;
        const popup = await context.newPage(); await popup.goto(base + '/lookup.html');
        await popup.waitForFunction(() => !!document.querySelector('#ext-account-status').textContent);
        await popup.locator('#ext-settings-open').click();
        await popup.locator('#ext-endpoint-input').fill(env.base);
        await popup.locator('#ext-login-mode').selectOption('token');
        await popup.locator('#ext-token-input').fill(ALICE);
        await popup.locator('#ext-connect-btn').click();
        await popup.waitForFunction(() => !document.querySelector('#ext-connect-btn').disabled && document.querySelector('#ext-account-status').textContent.includes('alice'), null, { timeout: 30000 });
        await popup.locator('#ext-settings-close').click();
        const source = await context.newPage(); await source.goto(env.base + '/long?x=1'); await source.bringToFront();
        const opening = context.waitForEvent('page');
        const opened = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'BDC_OPEN_WINDOW', view: 'article', autoImport: true }));
        const page = await opening;
        // Wait until the first chunk is in flight, then press 停止.
        const deadline = Date.now() + 30000;
        while (clean < 2 && Date.now() < deadline) await sleep(50);
        await page.locator('#ext-article-cancel').waitFor({ state: 'visible', timeout: 10000 });
        await page.locator('#ext-article-cancel').click();
        const noticeAtClick = await page.locator('#ext-workspace-notice').textContent();
        const trail = [];
        for (let i = 0; i < 24; i += 1) {
            trail.push({ at: i * 250, notice: await page.locator('#ext-workspace-notice').textContent().catch(() => '?'),
                preview: await page.locator('#ext-article-preview').isVisible().catch(() => false),
                saveDisabled: await page.locator('#ext-article-save').isDisabled().catch(() => true) });
            await sleep(250);
        }
        const state = { trail,
            cleanRequests: clean,
            aborted,
            events,
            noticeAtClick,
            noticeAfter: await page.locator('#ext-workspace-notice').textContent(),
            previewVisible: await page.locator('#ext-article-preview').isVisible(),
            body: (await page.locator('#ext-article-body').inputValue()).slice(0, 300),
            saveDisabled: await page.locator('#ext-article-save').isDisabled(),
            busy: await page.locator('#ext-article-cancel').isVisible()
        };
        fs.writeFileSync('/tmp/bdc-perf-probe/abort-extract.json', JSON.stringify(state, null, 2));
        console.log(JSON.stringify(state, null, 2));
        if (opened?.ok) await popup.evaluate((id) => chrome.windows.remove(id), opened.value.windowId);
    } finally { await context?.close(); await env.close(); fs.rmSync(profile, { recursive: true, force: true }); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
