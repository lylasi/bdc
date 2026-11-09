// Real MV3 windows/iframes and browser navigation, including the exact Chrome
// intervention from a fresh auto-import window. Ordinary Playwright DOM reads
// grant user activation, so all checks before a real click use raw CDP instead.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { environment, ALICE } = require('./helpers/extension-mv3.cjs');
const ROOT = path.resolve(__dirname, '..');
const stamp = new Date(Date.now() + 8 * 3600000).toISOString().replace(/\D/g, '').slice(0, 17);
const OUT = process.env.BEFOREUNLOAD_OUTPUT || path.join(ROOT, 'docs/report/assets', stamp + '_extension-beforeunload');
const baseline = process.env.BEFOREUNLOAD_BASELINE === '1';
const phases = [];
const blocked = (logs) => logs.filter((entry) => /Blocked attempt to show a 'beforeunload' confirmation panel/.test(entry.text));
async function raw(cdp, expression) {
    const response = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, userGesture: false });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
    return response.result.value;
}
async function waitForValue(read, name) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
        const value = await read().catch(() => false);
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error('Timed out: ' + name);
}
async function observe(context, pageOrFrame) {
    const cdp = await context.newCDPSession(pageOrFrame);
    const logs = [];
    await cdp.send('Log.enable');
    cdp.on('Log.entryAdded', ({ entry }) => logs.push(entry));
    return { cdp, logs };
}
async function navigateAway(cdp) {
    await cdp.send('Page.navigate', { url: 'about:blank' });
    await waitForValue(() => raw(cdp, 'location.href === "about:blank"'), 'navigate away');
}
function checkFresh(name, logs) {
    const warnings = blocked(logs);
    phases.push({ name, warnings });
    if (baseline) assert.ok(warnings.length, name + ' must reproduce the original warning');
    else assert.equal(warnings.length, 0, name + ' must not request an ineligible dialog');
    console.log('PASS ' + name + (baseline ? ' (baseline warning reproduced)' : ' (no blocked confirmation)'));
}
(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    execFileSync(process.execPath, ['scripts/package-extension.mjs'], { cwd: ROOT });
    const env = await environment();
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-beforeunload-'));
    let context;
    try {
        context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
            args: ['--disable-extensions-except=' + ROOT + '/extension', '--load-extension=' + ROOT + '/extension'] });
        const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
        const extension = 'chrome-extension://' + new URL(worker.url()).host;
        const settings = await context.newPage();
        await settings.goto(extension + '/lookup.html');
        await settings.locator('#ext-settings-open').click();
        await settings.locator('#ext-endpoint-input').fill(env.base);
        await settings.locator('#ext-login-mode').selectOption('token');
        await settings.locator('#ext-token-input').fill(ALICE);
        await settings.locator('#ext-connect-btn').click();
        await settings.waitForFunction(() => !document.querySelector('#ext-connect-btn').disabled && document.querySelector('#ext-account-status').textContent.includes('alice'));
        await settings.locator('#ext-settings-close').click();
        const source = await context.newPage();
        await source.goto(env.base + '/test-article');

        const control = await context.newPage();
        await control.goto(extension + '/lookup.html');
        const positive = await observe(context, control);
        assert.equal(await raw(positive.cdp, 'navigator.userActivation.hasBeenActive'), false);
        await raw(positive.cdp, 'window.addEventListener("beforeunload", event => { event.preventDefault(); event.returnValue = ""; })');
        await navigateAway(positive.cdp);
        await waitForValue(async () => blocked(positive.logs).length, 'positive control browser warning');
        phases.push({ name: 'positive control', warnings: blocked(positive.logs) });
        console.log('PASS positive control captures the exact Chrome intervention');
        await control.close();

        async function articleWindow(autoImport = true) {
            await source.bringToFront();
            const opening = context.waitForEvent('page');
            const result = await settings.evaluate((extract) => chrome.runtime.sendMessage({ type: 'BDC_OPEN_WINDOW', view: 'article', autoImport: extract }), autoImport);
            assert.ok(result.ok);
            const page = await opening;
            const observation = await observe(context, page);
            await waitForValue(() => raw(observation.cdp, autoImport
                ? '!!document.querySelector("#ext-article-body")?.value && !document.querySelector("#ext-article-preview").hidden && !document.querySelector("#ext-article-save").disabled'
                : '!!document.querySelector("#ext-article-extract") && !document.querySelector("#ext-article-extract").disabled'), 'article window ready');
            assert.equal(await raw(observation.cdp, 'navigator.userActivation.hasBeenActive'), false, 'reads must leave the new window unactivated');
            return { page, ...observation };
        }

        for (const locale of ['zh-CN', 'zh-HK']) {
            await settings.locator('#ext-settings-open').click();
            await settings.locator('#ext-locale-select').selectOption(locale);
            await settings.locator('#ext-settings-close').click();
            const fresh = await articleWindow();
            await navigateAway(fresh.cdp);
            checkFresh(locale + ' auto-import preview without interaction', fresh.logs);
            await fresh.page.close();

            const edited = await articleWindow();
            await edited.page.locator('#ext-article-body').click();
            await edited.page.locator('#ext-article-body').fill('Edited draft worth keeping.');
            assert.equal(await raw(edited.cdp, 'navigator.userActivation.hasBeenActive'), true);
            const dialogs = [];
            let accept = false;
            edited.page.on('dialog', async (dialog) => { dialogs.push(dialog.type()); await (accept ? dialog.accept() : dialog.dismiss()); });
            await edited.cdp.send('Page.navigate', { url: 'about:blank' });
            await waitForValue(async () => dialogs.length === 1, 'leave confirmation');
            assert.equal(await raw(edited.cdp, 'document.querySelector("#ext-article-body")?.value'), 'Edited draft worth keeping.');
            accept = true;
            await navigateAway(edited.cdp);
            assert.deepEqual(dialogs, ['beforeunload', 'beforeunload']);
            assert.equal(blocked(edited.logs).length, 0);
            phases.push({ name: locale + ' edited preview', dialogs, keptDraftAfterCancel: true });
            console.log('PASS ' + locale + ' edited preview prompts, cancel keeps the draft, accept leaves');
            await edited.page.close();

            const empty = await articleWindow(false);
            await empty.page.mouse.click(20, 20);
            assert.equal(await raw(empty.cdp, 'navigator.userActivation.hasBeenActive'), true);
            const unexpectedDialogs = [];
            empty.page.on('dialog', async (dialog) => { unexpectedDialogs.push(dialog.type()); await dialog.dismiss(); });
            await navigateAway(empty.cdp);
            assert.deepEqual(unexpectedDialogs, []);
            phases.push({ name: locale + ' activated empty workspace', dialogs: unexpectedDialogs });
            console.log('PASS ' + locale + ' empty workspace leaves without a prompt');
            await empty.page.close();

            await source.bringToFront();
            await settings.evaluate(async () => {
                const response = await chrome.runtime.sendMessage({ type: 'BDC_READ_PAGE' });
                const { extensionConversationKey } = await import('./modules/extension-assistant.js');
                const { getActiveAIScope } = await import('./modules/ai-profile-storage.js');
                localStorage.setItem(extensionConversationKey(getActiveAIScope(), response.value), JSON.stringify({ draft: 'Restored assistant draft.', messages: [] }));
            });
            const host = await observe(context, source);
            const result = await settings.evaluate(() => chrome.runtime.sendMessage({ type: 'BDC_SHOW_ASSISTANT' }));
            assert.ok(result.ok);
            const frame = await waitForValue(async () => source.frames().find((item) => item.url().startsWith(extension + '/lookup.html')), 'inline assistant frame');
            const inline = await observe(context, frame);
            await waitForValue(() => raw(inline.cdp, 'document.querySelector("#ext-assistant-input")?.value === "Restored assistant draft."'), 'restored inline draft');
            assert.equal(await raw(inline.cdp, 'navigator.userActivation.hasBeenActive'), false);
            await navigateAway(host.cdp);
            checkFresh(locale + ' restored inline draft without interaction', [...host.logs, ...inline.logs]);
            await source.goto(env.base + '/test-article');
        }
    } finally {
        fs.writeFileSync(path.join(OUT, baseline ? 'baseline.json' : 'results.json'), JSON.stringify({ baseline, phases }, null, 2));
        await context?.close(); await env.close(); fs.rmSync(profile, { recursive: true, force: true });
    }
    console.log('All beforeunload checks passed; ' + OUT);
})().catch((error) => { console.error(error); process.exitCode = 1; });
