// Regression for Chrome's "Blocked autofocusing ... cross-origin subframe".
// Real MV3 iframe on an intercepted HTTPS article, real input clicks, and an
// explicit positive control so a missing browser-log listener cannot pass.
// AI uses the existing local Worker/SQLite + SSE mock; no production services.
// PLAYWRIGHT_MODULE=<path> FOCUS_LOCALE=zh-CN node tests/extension-focus.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { environment, ALICE } = require('./helpers/extension-mv3.cjs');
const ROOT = path.resolve(__dirname, '..');
const locale = process.env.FOCUS_LOCALE || 'zh-CN';
const stamp = new Date(Date.now() + 8 * 3600000).toISOString().replace(/\D/g, '').slice(0, 17);
const output = process.env.FOCUS_OUTPUT || path.join(ROOT, 'docs/report/assets', stamp + '_extension-focus', locale + '.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
    execFileSync(process.execPath, ['scripts/package-extension.mjs'], { cwd: ROOT });
    const env = await environment();
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-focus-'));
    let context;
    const logs = [], errors = [], phases = [];
    try {
        context = await chromium.launchPersistentContext(profile, { channel: process.env.FOCUS_CHANNEL || 'chromium', headless: true,
            viewport: { width: 1200, height: 900 }, args: ['--disable-extensions-except=' + ROOT + '/extension', '--load-extension=' + ROOT + '/extension'] });
        context.on('page', (p) => { p.on('console', (m) => logs.push({ source: 'console', type: m.type(), text: m.text(), location: m.location() })); p.on('pageerror', (e) => errors.push(e.message)); });
        const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
        const base = 'chrome-extension://' + new URL(worker.url()).host;
        const popup = await context.newPage(); await popup.goto(base + '/lookup.html');
        await popup.waitForFunction(() => !!document.querySelector('#ext-account-status').textContent);
        await popup.locator('#ext-settings-open').click();
        await popup.locator('#ext-endpoint-input').fill(env.base);
        await popup.locator('#ext-login-mode').selectOption('token'); await popup.locator('#ext-token-input').fill(ALICE);
        await popup.locator('#ext-connect-btn').click(); await popup.waitForFunction(() => !document.querySelector('#ext-connect-btn').disabled && document.querySelector('#ext-account-status').textContent.includes('alice'));
        await popup.locator('#ext-locale-select').selectOption(locale);
        await popup.waitForFunction((value) => document.documentElement.lang === value, locale);
        await popup.locator('#ext-settings-close').click();
        await context.route('https://focus-test.example/**', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Focus test article</title><article><h1>Focus test</h1><p id="text">Major tech stocks plunge as investors worry.</p></article>' }));
        const page = await context.newPage();
        const cdp = await context.newCDPSession(page);
        await cdp.send('Log.enable');
        cdp.on('Log.entryAdded', ({ entry }) => logs.push({ source: 'cdp', ...entry }));
        await page.goto('https://focus-test.example/article'); await page.bringToFront();
        await page.waitForSelector('bdc-page-lookup');
        const rect = await page.evaluate(() => {
            const node = document.querySelector('#text').firstChild; const start = node.textContent.indexOf('plunge');
            const range = document.createRange(); range.setStart(node, start); range.setEnd(node, start + 6);
            const box = range.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height };
        });
        await page.mouse.move(rect.x + 1, rect.y + rect.height / 2); await page.mouse.down();
        await page.mouse.move(rect.x + rect.width - 1, rect.y + rect.height / 2, { steps: 8 }); await page.mouse.up();
        const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
        const buttons = [];
        function visit(n) { if (n.nodeName === 'BUTTON' && !n.attributes?.includes('bdc-assistant-ball')) buttons.push(n); for (const c of [...n.children || [], ...n.shadowRoots || []]) visit(c); }
        visit(root); let box;
        for (const node of buttons) { const m = await cdp.send('DOM.getBoxModel', { nodeId: node.nodeId }).catch(() => null); if (m?.model?.width > 8) { box = m.model.border; break; } }
        assert.ok(box); await page.mouse.click((box[0] + box[4]) / 2, (box[1] + box[5]) / 2);
        let frame;
        for (let i = 0; i < 100; i++) { frame = page.frames().find((f) => f.url().startsWith(base + '/lookup.html')); if (frame) break; await sleep(50); }
        assert.ok(frame); await frame.waitForFunction(() => !!document.querySelector('#ext-result-meaning').textContent);
        phases.push({ name: 'lookup-loaded', autofocus: await frame.locator('[autofocus]').count(), focused: await frame.evaluate(() => document.activeElement?.id || '') });
        const frameCDP = await context.newCDPSession(frame).catch(() => null);
        if (frameCDP) { await frameCDP.send('Log.enable'); frameCDP.on('Log.entryAdded', ({ entry }) => logs.push({ source: 'frame-cdp', ...entry })); }
        await frame.locator('#ext-inline-edit').click();
        phases.push({ name: 'edit-open', focused: await frame.evaluate(() => document.activeElement?.id || ''), active: await frame.evaluate(() => navigator.userActivation?.isActive) });
        await frame.locator('#ext-word-input').fill('plunge'); await frame.locator('#ext-query-close').click();
        await sleep(200);
        await frame.locator('#ext-inline-settings').click();
        phases.push({ name: 'settings-open', focused: await frame.evaluate(() => document.activeElement?.id || '') });
        await frame.locator('#ext-settings-close').click(); await sleep(200);
        await frame.locator('#ext-inline-ai').click();
        await frame.waitForFunction(() => !document.querySelector('#ext-assistant-section').hidden && !!document.querySelector('#ext-assistant-context').textContent);
        phases.push({ name: 'assistant-open', focused: await frame.evaluate(() => document.activeElement?.id || '') });
        await frame.locator('#ext-assistant-input').fill('Explain plunge'); await frame.locator('#ext-assistant-send').click();
        await frame.waitForFunction(() => document.querySelector('#ext-assistant-stop').hidden && document.querySelector('.ext-assistant-msg-assistant')?.textContent.includes('mock'));
        phases.push({ name: 'assistant-response', focused: await frame.evaluate(() => document.activeElement?.id || '') });
        await frame.locator('#ext-inline-back').click();
        await frame.locator('#ext-book-settings').click();
        phases.push({ name: 'book-dialog-open', focused: await frame.evaluate(() => document.activeElement?.id || '') });
        await frame.locator('#ext-book-close').click();
        await sleep(300);
        const blocked = logs.filter((m) => /Blocked autofocusing|autofocus|focus\(\)/i.test(m.text || ''));
        const controlStart = logs.length;
        await frame.evaluate(() => { const input = document.createElement('input'); input.id = 'focus-positive-control'; input.autofocus = true; document.body.appendChild(input); });
        await sleep(150);
        const controlLogs = logs.slice(controlStart).filter((m) => /Blocked autofocusing/i.test(m.text || ''));
        const result = { locale, browser: context.browser()?.version(), channel: process.env.FOCUS_CHANNEL || 'chromium', phases, focusLogs: blocked, positiveControlLogs: controlLogs, pageErrors: errors };
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(output, JSON.stringify(result, null, 2));
        assert.deepEqual(blocked, [], 'normal lookup, edit/settings dialogs and assistant emit no blocked autofocus warning');
        assert.deepEqual(errors, [], 'normal flow has no uncaught page errors');
        assert.equal(phases[0].autofocus, 0, 'hidden editor does not request focus when the iframe loads');
        assert.equal(phases[1].focused, 'ext-word-input', 'user clicking edit focuses the word field');
        assert.equal(phases[1].active, true, 'edit focus follows a real user gesture');
        assert.equal(phases[3].focused, 'ext-assistant-input', 'assistant input can receive focus');
        assert.equal(phases.find((phase) => phase.name === 'book-dialog-open').focused, 'ext-book-close', 'book dialog opens from a real click without input autofocus');
        assert.ok(controlLogs.length > 0, 'positive control reproduces the exact browser warning, proving collection works');
        console.log('PASS ' + locale + ': no autofocus warnings in real cross-origin lookup/editor/assistant; positive control detected; ' + output);
    } finally { await context?.close(); await env.close(); fs.rmSync(profile, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
