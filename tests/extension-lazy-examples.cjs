// Actual MV3 + Worker/SQLite. Provider responses and delayed TTS credentials are
// controlled fixtures; timings only demonstrate removal of a network dependency.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { environment, ALICE } = require('./helpers/extension-mv3.cjs');
const { openCard, waitResult, closeCard } = require('./extension-lookup-cache.cjs');
const ROOT = path.resolve(__dirname, '..');
const OUT = process.env.LAZY_EXAMPLES_OUTPUT || path.join(os.tmpdir(), 'bdc-lazy-examples');
const checks = [], errors = [], lookups = [], examples = [], timings = [];
function check(name, ok) {
    checks.push({ name, ok: !!ok });
    console.log((ok ? 'PASS ' : 'FAIL ') + name);
    assert.ok(ok, name);
}
const article = 'The Board of Directors approved the annual budget. She will take charge of the project. The team worked under pressure.';
const exampleWaits = new Set(), ttsWaits = new Set();
function release(waits) { for (const resolve of waits) resolve(); waits.clear(); }

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    execFileSync(process.execPath, ['scripts/package-extension.mjs'], { cwd: ROOT });
    const env = await environment();
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-lazy-examples-'));
    let context, mode = 'ok', holdTTS = false, heldTTS = 0;
    try {
        context = await chromium.launchPersistentContext(profile, {
            channel: 'chromium', headless: true, viewport: { width: 1100, height: 820 },
            args: ['--disable-extensions-except=' + ROOT + '/extension', '--load-extension=' + ROOT + '/extension']
        });
        context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
        await context.route('https://lookup-lazy.example/article', (route) => route.fulfill({
            contentType: 'text/html', body: '<!doctype html><title>Board decisions</title><article><p id="article">' + article + '</p></article>'
        }));
        await context.route('**/ai-credentials/bdc-tts-v1', async (route) => {
            if (holdTTS) { heldTTS += 1; await new Promise((resolve) => ttsWaits.add(resolve)); }
            await route.continue().catch(() => {});
        });
        await context.route('**/mock-ai/**', async (route) => {
            if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204 });
            const body = route.request().postDataJSON();
            const prompt = body.messages.map((item) => item.content).join('\n');
            const hk = prompt.includes('香港繁體中文');
            let response;
            if (prompt.includes('Generate exactly 2 short')) {
                const reference = JSON.parse(prompt.split('\n').at(-1));
                examples.push({ body, reference });
                const requestedMode = mode;
                if (requestedMode === 'hold') await new Promise((resolve) => exampleWaits.add(resolve));
                response = { examples: requestedMode === 'invalid' ? [{ en: 'Missing translation.' }] : [
                    { en: 'The board approved the annual budget.', zh: hk ? '董事會批准了年度預算。' : '董事会批准了年度预算。' },
                    { en: 'She presented the proposal to the board.', zh: hk ? '她向董事會提交了建議。' : '她向董事会提交了建议。' }
                ] };
            } else {
                lookups.push(body);
                response = { phonetic: 'bɔːd əv dəˈrektəz', meaning: hk ? '董事會' : '董事会', usage: hk ? '公司管理機構' : '公司管理机构' };
            }
            await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{
                finish_reason: 'stop', message: { content: JSON.stringify(response) }
            }] }) }).catch(() => {});
        });
        const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
        const base = 'chrome-extension://' + new URL(worker.url()).host;
        const popup = await context.newPage();
        await popup.goto(base + '/lookup.html');
        await popup.waitForFunction(() => !!document.querySelector('#ext-account-status').textContent);
        await popup.evaluate(() => chrome.storage.local.set({ bdc_extension_assistant_enabled: false }));
        await popup.locator('#ext-settings-open').click();
        if (!await popup.locator('#ext-account-details').evaluate((node) => node.open)) await popup.locator('#ext-account-summary').click();
        await popup.locator('#ext-endpoint-input').fill(env.base);
        await popup.locator('#ext-login-mode').selectOption('token');
        await popup.locator('#ext-token-input').fill(ALICE);
        await popup.locator('#ext-connect-btn').click();
        await popup.waitForFunction(() => !document.querySelector('#ext-connect-btn').disabled && document.querySelector('#ext-account-status').textContent.includes('alice'));
        await popup.locator('#ext-settings-close').click();
        const snapshot = await (await fetch(env.base + '/snapshot', { headers: { Authorization: 'Bearer ' + ALICE } })).json() || { version: 0, payload: {} };
        const seeded = await fetch(env.base + '/snapshot', { method: 'POST', headers: {
            Authorization: 'Bearer ' + ALICE, 'Content-Type': 'application/json'
        }, body: JSON.stringify({ expected_version: snapshot.version || 0, payload: { ...snapshot.payload,
            ttsSettings: { updatedAt: new Date().toISOString(), settings: { tts: { use: 'remote', baseUrlRemote: 'https://speech.mock.test' } } }
        } }) });
        assert.equal(seeded.status, 200);
        holdTTS = true;
        const page = await context.newPage();
        await page.goto('https://lookup-lazy.example/article');
        const started = Date.now();
        let frame = await openCard(page, base, 'Board of Directors');
        await waitResult(frame, 5000);
        timings.push({ scenario: 'new-phrase-with-tts-request-held', elapsedMs: Date.now() - started });
        for (let attempt = 0; heldTTS === 0 && attempt < 50; attempt += 1) await page.waitForTimeout(20);
        check('首次新短語在 TTS 憑據請求仍被按住時已顯示詞義', heldTTS > 0 && lookups.length === 1);
        check('首輪提示詞沒有要求例句，尚未點開時例句請求為零', !lookups[0].messages[0].content.includes('"examples"') && examples.length === 0);
        check('首屏保留音標及簡短用法，例句入口可見且預設收合', !!await frame.locator('#ext-result-phonetic').textContent()
            && await frame.locator('#ext-result-role').isVisible() && await frame.locator('#ext-result-details').isVisible()
            && !await frame.locator('#ext-result-details').evaluate((node) => node.open));
        await page.screenshot({ path: path.join(OUT, 'first-lookup-zh-CN.png') });
        mode = 'hold';
        await frame.locator('#ext-result-details > summary').click();
        await frame.waitForFunction(() => document.querySelector('#ext-result-details').getAttribute('aria-busy') === 'true');
        await frame.locator('#ext-examples-notice').filter({ hasText: '正在生成例句' }).waitFor();
        check('首次點開才發例句請求，傳入剛才的詞義與原文', examples.length === 1 && examples[0].reference.meaning === '董事会'
            && examples[0].reference.text === 'Board of Directors' && examples[0].reference.sentence.includes('annual budget'));
        await page.screenshot({ path: path.join(OUT, 'examples-loading-zh-CN.png') });
        await frame.locator('#ext-result-details > summary').click();
        await frame.locator('#ext-result-details > summary').click();
        check('生成中收合再展開不會重複請求', examples.length === 1);
        release(exampleWaits);
        await frame.waitForFunction(() => document.querySelectorAll('#ext-result-examples li').length === 2);
        check('完成後顯示兩句中英對照並保留原詞義', await frame.locator('#ext-result-meaning').textContent() === '董事会'
            && (await frame.locator('#ext-result-examples').textContent()).includes('董事会'));
        holdTTS = false; release(ttsWaits); mode = 'ok';
        await closeCard(page, frame, base);
        frame = await openCard(page, base, 'Board of Directors');
        await waitResult(frame);
        await frame.locator('#ext-result-details > summary').click();
        await frame.waitForFunction(() => document.querySelectorAll('#ext-result-examples li').length === 2);
        check('關窗重開後詞義及例句都使用本機快取', lookups.length === 1 && examples.length === 1);
        await closeCard(page, frame, base);

        for (const locale of ['zh-CN', 'zh-HK']) {
            await popup.bringToFront();
            await popup.locator('#ext-settings-open').click();
            await popup.locator('#ext-locale-select').selectOption(locale);
            await popup.locator('#ext-settings-close').click();
            frame = await openCard(page, base, 'take charge of');
            await waitResult(frame);
            const before = examples.length;
            mode = 'invalid';
            await frame.locator('#ext-result-details > summary').click();
            await frame.locator('#ext-examples-retry').waitFor();
            check(locale + ' 例句失敗顯示本語言重試，詞義保持可用', examples.length === before + 1
                && (await frame.locator('#ext-examples-notice').textContent()).includes(locale === 'zh-HK' ? '產生失敗' : '生成失败')
                && await frame.locator('#ext-result-meaning').isVisible());
            await page.screenshot({ path: path.join(OUT, 'examples-error-' + locale + '.png') });
            mode = 'ok';
            await frame.locator('#ext-examples-retry').click();
            await frame.waitForFunction(() => document.querySelectorAll('#ext-result-examples li').length === 2);
            check(locale + ' 失敗沒有寫入快取，重試成功且文案完整', examples.length === before + 2
                && await frame.locator('#ext-examples-notice').isHidden() && await frame.locator('#ext-examples-retry').isHidden());
            if (locale === 'zh-HK') {
                await page.setViewportSize({ width: 320, height: 780 });
                await page.waitForTimeout(150);
                await page.screenshot({ path: path.join(OUT, 'examples-ready-zh-HK-320.png') });
            }
            await closeCard(page, frame, base);
        }
        check('切換 UI 語言沒有轉換原文內容', await page.locator('#article').textContent() === article);
        await page.setViewportSize({ width: 1100, height: 820 });
        frame = await openCard(page, base, 'under pressure');
        await waitResult(frame);
        mode = 'hold';
        const before = examples.length;
        await frame.locator('#ext-result-details > summary').click();
        for (let attempt = 0; examples.length === before && attempt < 100; attempt += 1) await page.waitForTimeout(20);
        assert.equal(examples.length, before + 1, 'delayed example request started');
        await frame.locator('#ext-inline-edit').click();
        await frame.locator('#ext-word-input').fill('new phrase');
        await frame.locator('#ext-lookup-btn').click();
        await waitResult(frame);
        release(exampleWaits);
        await frame.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        check('更換選詞會取消舊例句，遲到回覆不會覆蓋新詞卡', await frame.locator('#ext-result-word').textContent() === 'new phrase'
            && await frame.locator('#ext-result-examples li').count() === 0 && !await frame.locator('#ext-result-details').evaluate((node) => node.open));
        await closeCard(page, frame, base);

        const floating = await context.newPage();
        await floating.goto(env.appBase + '/test-floating-statusbar.html');
        await floating.waitForFunction(() => typeof window.testPlatformDetection === 'function');
        await floating.getByRole('button', { name: '检测当前平台' }).click();
        await floating.getByRole('button', { name: '测试状态保存/加载' }).click();
        await floating.getByRole('button', { name: '显示测试状态栏' }).click();
        check('獨立浮動狀態列頁的平台、持久化及 UI 檢查通過', await floating.locator('#platform-result.success').count() === 1
            && await floating.locator('#state-result.success').count() === 1 && await floating.locator('#ui-result.success').count() === 1);
        await floating.getByRole('button', { name: '移除状态栏' }).click();
        check('真 MV3 與雙語操作沒有未處理的頁面錯誤', errors.length === 0);
    } finally {
        release(exampleWaits); release(ttsWaits);
        fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ checks, errors, timings,
            lookupRequests: lookups.length, examplesRequests: examples.length }, null, 2));
        await context?.close();
        await env.close();
        fs.rmSync(profile, { recursive: true, force: true });
    }
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
