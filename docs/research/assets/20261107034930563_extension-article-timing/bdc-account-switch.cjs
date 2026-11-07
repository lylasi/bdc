// Scratch: verify account-switch isolation during in-flight paragraph analysis.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE);
const { environment, ALICE, BOB } = require('/Users/linus/CODE/bdc/tests/helpers/extension-mv3.cjs');
const ROOT = '/Users/linus/CODE/bdc';
const OUT = '/tmp/bdc-perf-probe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
    execFileSync(process.execPath, ['scripts/package-extension.mjs'], { cwd: ROOT });
    const env = await environment();
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-switch-'));
    const events = [];
    let context;
    try {
        context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
            args: ['--disable-extensions-except=' + ROOT + '/extension', '--load-extension=' + ROOT + '/extension'] });
        context.on('requestfailed', (r) => { if (r.url().includes('/mock-ai/')) events.push('aborted ' + r.failure()?.errorText); });
        let aiPara = 0;
        await context.route(env.base + '/mock-ai/**', async (route) => {
            let body = {}; try { body = route.request().postDataJSON() || {}; } catch (_) {}
            const prompt = (body.messages || []).map((m) => m.content || '').join('\n');
            const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
            if (prompt.includes('Clean the supplied Markdown article')) {
                await sleep(300);
                return route.fulfill({ status: 200, headers, body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '# Switch article\n\nSwitchA: alpha paragraph.\n\nSwitchB: beta paragraph.\n\nSwitchC: gamma paragraph.' } }] }) });
            }
            if (prompt.includes('Translate the following English paragraph')) {
                aiPara += 1;
                await sleep(4000);
                return route.fulfill({ status: 200, headers, body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ chinese_translation: 'x' }) } }] }) });
            }
            return route.fulfill({ status: 200, headers, body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{}' } }] }) });
        });
        const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
        const base = 'chrome-extension://' + new URL(worker.url()).host;
        const popup = await context.newPage(); await popup.goto(base + '/lookup.html');
        await popup.waitForFunction(() => !!document.querySelector('#ext-account-status').textContent);
        const login = async (token, label) => {
            if (!(await popup.locator('#ext-settings-dialog').evaluate((n) => n.open))) await popup.locator('#ext-settings-open').click();
            await popup.evaluate(() => { const d = document.getElementById('ext-account-details'); if (d) d.open = true; });
            await popup.locator('#ext-endpoint-input').fill(env.base);
            await popup.locator('#ext-login-mode').selectOption('token');
            await popup.locator('#ext-token-input').fill(token);
            await popup.locator('#ext-connect-btn').click();
            await popup.waitForFunction((name) => !document.querySelector('#ext-connect-btn').disabled
                && document.querySelector('#ext-account-status').textContent.includes(name), label, { timeout: 30000 });
            await popup.locator('#ext-settings-close').click().catch(() => {});
        };
        await login(ALICE, 'alice');
        const source = await context.newPage(); await source.goto(env.base + '/test-article?switch=1'); await source.bringToFront();
        const opening = context.waitForEvent('page');
        const opened = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'BDC_OPEN_WINDOW', view: 'article', autoImport: true }));
        const article = await opening;
        await article.locator('#ext-article-preview').waitFor({ state: 'visible', timeout: 60000 });
        await article.waitForFunction(() => !document.querySelector('#ext-article-save').disabled, null, { timeout: 60000 });
        const sourceUrl = source.url();
        const aliceBefore = env.db.prepare("SELECT COUNT(*) AS n FROM articles WHERE owner_user_id='alice'").get().n;
        await article.locator('#ext-article-save').click();
        await article.locator('#ext-article-cancel').waitFor({ state: 'visible', timeout: 10000 });
        await sleep(500);
        const paraBeforeSwitch = aiPara;
        // Switch to Bob mid-analysis.
        await login(BOB, 'bob');
        await sleep(2500);
        const aliceRows = () => env.db.prepare("SELECT COUNT(*) AS n FROM articles WHERE owner_user_id='alice' AND source_url=?").get(sourceUrl).n;
        const bobRows = () => env.db.prepare("SELECT COUNT(*) AS n FROM articles WHERE owner_user_id='bob' AND source_url=?").get(sourceUrl).n;
        const pending = await popup.evaluate(async () => Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith('bdc_workspace_outbox_v1:')).length);
        const state = {
            paraRequestsBeforeSwitch: paraBeforeSwitch,
            aborted: events.length,
            aliceBefore,
            aliceRows: aliceRows(),
            bobRows: bobRows(),
            pending,
            previewHidden: await article.locator('#ext-article-preview').isHidden().catch(() => false),
            titleCleared: (await article.locator('#ext-article-title').inputValue().catch(() => '')) === '',
            bodyCleared: (await article.locator('#ext-article-body').inputValue().catch(() => '')) === '',
            notice: await article.locator('#ext-workspace-notice').textContent().catch(() => ''),
            accountStatus: await popup.locator('#ext-account-status').textContent()
        };
        // Back to Alice: no leftover job, fresh extraction still works.
        await login(ALICE, 'alice');
        await source.bringToFront();
        const reopening = context.waitForEvent('page');
        if (opened?.ok) await popup.evaluate((id) => chrome.windows.remove(id), opened.value.windowId);
        const reopened = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'BDC_OPEN_WINDOW', view: 'article', autoImport: true }));
        const article2 = await reopening;
        await article2.locator('#ext-article-preview').waitFor({ state: 'visible', timeout: 60000 });
        state.afterSwitchBackPending = await popup.evaluate(async () => Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith('bdc_workspace_outbox_v1:')).length);
        fs.writeFileSync(path.join(OUT, 'switch.json'), JSON.stringify(state, null, 2));
        console.log(JSON.stringify(state, null, 2));
    } finally {
        await context?.close(); await env.close(); fs.rmSync(profile, { recursive: true, force: true });
    }
})().catch((error) => { console.error(error); process.exitCode = 1; });
