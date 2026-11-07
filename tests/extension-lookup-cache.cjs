// Real MV3 and Worker/SQLite; prove that local results render while network
// initialization is deliberately held. The AI server is a local mock.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { environment, ALICE } = require('./helpers/extension-mv3.cjs');
const ROOT = path.resolve(__dirname, '..');
const OUT = process.env.LOOKUP_CACHE_OUTPUT || path.join(ROOT, 'docs/report/assets/20261107015023770_lookup-cache/browser');
const checks = [], errors = [], timings = [], speechEvents = [];
function check(name, value, detail) {
    checks.push({ name, ok: !!value, ...(detail ? { detail } : {}) });
    console.log(`${value ? 'PASS' : 'FAIL'} ${name}`);
    assert.ok(value, name + (detail ? ': ' + JSON.stringify(detail) : ''));
}
async function openCard(page, base, word = 'plunge') {
    await page.bringToFront();
    await page.waitForSelector('bdc-page-lookup');
    const rect = await page.evaluate((word) => {
        getSelection().removeAllRanges();
        const node = document.querySelector('#article').firstChild;
        const start = node.textContent.indexOf(word);
        const range = document.createRange(); range.setStart(node, start); range.setEnd(node, start + word.length);
        const r = range.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };
    }, word);
    await page.mouse.move(rect.x + 1, rect.y + rect.height / 2); await page.mouse.down();
    await page.mouse.move(rect.x + rect.width - 1, rect.y + rect.height / 2, { steps: 8 }); await page.mouse.up();
    const cdp = await page.context().newCDPSession(page);
    let buttonBox;
    for (let attempt = 0; attempt < 80 && !buttonBox; attempt += 1) {
        const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
        const candidates = [];
        function visit(node) {
            if (node.nodeName === 'BUTTON' && !node.attributes?.includes('bdc-assistant-ball')) candidates.push(node);
            for (const child of [...node.children || [], ...node.shadowRoots || []]) visit(child);
        }
        visit(root);
        for (const node of candidates) {
            const r = await cdp.send('DOM.getBoxModel', { backendNodeId: node.backendNodeId }).catch(() => null);
            if (r?.model.width > 8 && r.model.height > 8) { buttonBox = r.model.border; break; }
        }
        if (!buttonBox) await page.waitForTimeout(40);
    }
    assert.ok(buttonBox, 'actual selection button exists in closed shadow root');
    await page.mouse.click((buttonBox[0] + buttonBox[4]) / 2, (buttonBox[1] + buttonBox[5]) / 2);
    await cdp.detach();
    for (let n = 0; n < 100; n += 1) {
        const frame = page.frames().find((f) => f.url().startsWith(base + '/lookup.html'));
        if (frame) return frame;
        await page.waitForTimeout(40);
    }
    throw new Error('No actual extension frame');
}
async function waitResult(frame, timeout = 15000) {
    await frame.waitForFunction(() => !!document.querySelector('#ext-result-meaning')?.textContent && !document.querySelector('#ext-result-box').classList.contains('hidden'), null, { timeout });
    await frame.waitForFunction(() => !document.querySelector('#ext-inline-retry').disabled, null, { timeout });
}
async function closeCard(page, frame, base) {
    await frame.locator('#ext-inline-close').click();
    await page.waitForFunction((base) => !Array.from(document.querySelectorAll('iframe')).some((node) => node.src.startsWith(base)), base).catch(() => {});
    for (let n = 0; n < 100 && page.frames().some((f) => f.url().startsWith(base + '/lookup.html')); n += 1) await page.waitForTimeout(20);
    assert.ok(!page.frames().some((f) => f.url().startsWith(base + '/lookup.html')));
}
module.exports = { openCard, waitResult, closeCard };

if (require.main === module) (async () => {
    fs.mkdirSync(OUT, { recursive: true });
    execFileSync(process.execPath, ['scripts/package-extension.mjs'], { cwd: ROOT });
    const env = await environment();
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-lookup-cache-'));
    let context, hold = false, held = 0, failLookups = false, aiAttempts = 0;
    const releases = new Set();
    function releaseAll() { hold = false; for (const release of releases) release(); releases.clear(); }
    try {
        context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
            viewport: { width: 1100, height: 800 }, args: [`--disable-extensions-except=${ROOT}/extension`, `--load-extension=${ROOT}/extension`] });
        context.on('page', (p) => p.on('pageerror', (e) => errors.push(e.message)));
        await context.exposeFunction('__recordLookupSpeech', (event) => speechEvents.push(event));
        await context.addInitScript(() => {
            if (location.protocol !== 'chrome-extension:') return;
            const speech = window.__lookupSpeech = { calls: [], canceled: 0, current: null, failNext: false };
            Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: class {
                constructor(text) { this.text = text; }
            } });
            Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
                getVoices: () => [{ name: 'Chinese', lang: 'zh-CN' }, { name: 'English', lang: 'en-US' }],
                cancel() {
                    speech.canceled += 1; speech.current = null;
                    window.__recordLookupSpeech({ type: 'cancel', url: location.href }).catch(() => {});
                },
                speak(utterance) {
                    speech.calls.push(utterance); speech.current = utterance;
                    if (speech.failNext) {
                        speech.failNext = false;
                        utterance.onerror?.({ error: 'synthesis-failed' });
                    } else utterance.onstart?.();
                }
            } });
        });
        await context.route(env.base + '/**', async (route) => {
            const url = new URL(route.request().url());
            if (hold && !url.pathname.startsWith('/mock-ai/')) {
                held += 1;
                await new Promise((resolve) => releases.add(resolve));
            }
            if (url.pathname.startsWith('/mock-ai/') && route.request().method() === 'POST') {
                aiAttempts += 1;
                if (failLookups) {
                    return route.fulfill({ status: 503, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: '{"error":{"message":"mock unavailable"}}' });
                }
                const response = await route.fetch(); const data = await response.json();
                const parsed = JSON.parse(data.choices[0].message.content);
                if (parsed.analysis) parsed.analysis.meaning = 'cached-answer-' + env.state.aiCalls;
                if (parsed.meaning) parsed.meaning = 'cached-answer-' + env.state.aiCalls;
                data.choices[0].message.content = JSON.stringify(parsed);
                return route.fulfill({ response, json: data });
            }
            return route.continue().catch(() => {});
        });
        const html = '<!doctype html><title>Cache article</title><article><h1>Cache article</h1><p id="article">Major tech stocks plunge as investors worry. Markets remain volatile.</p></article>';
        await context.route('https://lookup-cache-*.example/**', (route) => route.fulfill({ contentType: 'text/html', body: html }));
        const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
        const base = 'chrome-extension://' + new URL(worker.url()).host;
        const popup = await context.newPage(); await popup.goto(base + '/lookup.html');
        await popup.waitForFunction(() => !!document.querySelector('#ext-account-status').textContent);
        await popup.evaluate(() => chrome.storage.local.set({ bdc_extension_assistant_enabled: false }));
        await popup.locator('#ext-settings-open').click();
        if (!await popup.locator('#ext-account-details').evaluate((node) => node.open)) await popup.locator('#ext-account-summary').click();
        await popup.locator('#ext-endpoint-input').fill(env.base);
        await popup.locator('#ext-login-mode').selectOption('token'); await popup.locator('#ext-token-input').fill(ALICE);
        await popup.locator('#ext-connect-btn').click();
        await popup.waitForFunction(() => !document.querySelector('#ext-connect-btn').disabled && document.querySelector('#ext-account-status').textContent.includes('alice'));
        await popup.locator('#ext-settings-close').click();
        const page = await context.newPage(); await page.goto('https://lookup-cache-one.example/article');
        let frame = await openCard(page, base); await waitResult(frame);
        check('首次查詢真的呼叫一次 AI，常駐重查圖示在結果出現後可用', env.state.aiCalls === 1 && await frame.locator('#ext-inline-retry').isVisible());
        check('首次回應不標成快取', await frame.locator('#ext-result-cache').isHidden());
        const first = await frame.locator('#ext-result-meaning').textContent();
        await closeCard(page, frame, base);
        hold = true; held = 0;
        let started = Date.now(); frame = await openCard(page, base); await waitResult(frame, 2000);
        timings.push({ scenario: 'reopen-blocked-network', elapsed: Date.now() - started, held });
        check('關窗後重開，同步請求被按住仍在兩秒內讀到本機結果', env.state.aiCalls === 1 && await frame.locator('#ext-result-cache').isVisible(), timings.at(-1));
        check('命中的內容就是第一次成功結果，網絡仍未放行', (await frame.locator('#ext-result-meaning').textContent()) === first && hold);
        const beforeAudio = env.state.aiCalls;
        await frame.locator('#ext-result-speak').click();
        const spoken = await frame.evaluate(() => window.__lookupSpeech.calls.map(({ text, lang }) => ({ text, lang })));
        check('同步網絡被阻塞時，快取詞卡仍可立即用英語發音且不重查 AI', hold && env.state.aiCalls === beforeAudio
            && spoken.length === 1 && spoken[0].text === 'plunge' && spoken[0].lang === 'en-US'
            && await frame.locator('#ext-result-speak').getAttribute('aria-pressed') === 'true', spoken);
        const cancels = await frame.evaluate(() => window.__lookupSpeech.canceled);
        await frame.locator('#ext-result-speak').click();
        check('同一喇叭再點一次會停止發音', await frame.evaluate((count) => window.__lookupSpeech.canceled > count, cancels)
            && await frame.locator('#ext-result-speak').getAttribute('aria-pressed') === 'false');
        await frame.locator('#ext-result-speak').click();
        await frame.evaluate(() => window.__lookupSpeech.calls[0].onend?.());
        check('前一次發音的遲到回呼不會結束新播放', await frame.locator('#ext-result-speak').getAttribute('aria-pressed') === 'true');
        await frame.evaluate(() => window.__lookupSpeech.current.onend());
        check('正常播放結束後恢復喇叭及可重播狀態', await frame.locator('#ext-result-speak').getAttribute('aria-pressed') === 'false'
            && await frame.locator('#ext-pronunciation-notice').isHidden());
        await page.screenshot({ path: path.join(OUT, 'cached-before-network.png') });
        releaseAll();
        await closeCard(page, frame, base); await page.reload();
        hold = true; held = 0;
        started = Date.now(); frame = await openCard(page, base); await waitResult(frame, 2000);
        timings.push({ scenario: 'reload-blocked-network', elapsed: Date.now() - started, held });
        check('刷新原網頁後仍能直讀本機，沒有重跑 AI', env.state.aiCalls === 1 && await frame.locator('#ext-result-cache').isVisible(), timings.at(-1));
        releaseAll(); await closeCard(page, frame, base);
        const other = await context.newPage(); await other.goto('https://lookup-cache-two.example/article');
        hold = true; held = 0;
        started = Date.now(); frame = await openCard(other, base); await waitResult(frame, 2000);
        timings.push({ scenario: 'other-origin-blocked-network', elapsed: Date.now() - started, held });
        check('另一網站相同詞句與語境也可重用本機結果', env.state.aiCalls === 1 && await frame.locator('#ext-result-cache').isVisible(), timings.at(-1));
        releaseAll();
        const beforeForce = env.state.aiCalls;
        await frame.locator('#ext-inline-retry').click();
        await frame.waitForFunction((previous) => document.querySelector('#ext-result-meaning').textContent !== previous, first);
        await waitResult(frame);
        check('重查圖示強制發出一次 AI 請求並更新結果', env.state.aiCalls === beforeForce + 1 && await frame.locator('#ext-result-cache').isHidden());
        check('重查圖示成功後仍在，沒有改成永久略過快取', await frame.locator('#ext-inline-retry').isVisible() && !await frame.locator('#ext-force-refresh').isChecked());
        const refreshed = await frame.locator('#ext-result-meaning').textContent();
        await closeCard(other, frame, base);
        frame = await openCard(other, base); await waitResult(frame);
        check('下次普通查詢重用強制重查後的新結果', env.state.aiCalls === beforeForce + 1 && (await frame.locator('#ext-result-meaning').textContent()) === refreshed && await frame.locator('#ext-result-cache').isVisible());
        for (const locale of ['zh-CN', 'zh-HK']) {
            await frame.locator('#ext-inline-settings').click(); await frame.locator('#ext-locale-select').selectOption(locale);
            await frame.locator('#ext-settings-close').click();
            await frame.waitForFunction(() => !document.querySelector('#ext-settings-dialog').open && document.body.classList.contains('ext-compact'));
            // Dialog closure updates the outer iframe through an authenticated
            // message on the next animation frame. Wait for that geometry too.
            for (let n = 0; n < 80; n += 1) {
                const height = await frame.evaluate(() => Math.ceil(document.body.getBoundingClientRect().height));
                const box = await (await frame.frameElement()).boundingBox();
                if (box && Math.abs(box.height - Math.min(height + 2, other.viewportSize().height - 24)) < 5) break;
                await other.waitForTimeout(25);
            }
            await frame.locator('#ext-inline-retry').click(); await waitResult(frame);
            await other.setViewportSize({ width: 320, height: 650 });
            await frame.waitForFunction(() => innerWidth <= 304 && ['ext-capture-save', 'ext-book-settings', 'ext-inline-retry'].every((id) => {
                const e = document.getElementById(id), r = e.getBoundingClientRect();
                return r.bottom <= innerHeight && e.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
            }));
            await other.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            const geometry = await frame.evaluate(() => {
                const ids = ['ext-capture-save', 'ext-book-settings', 'ext-inline-retry'];
                return { width: innerWidth, height: innerHeight, scroll: document.documentElement.scrollWidth, buttons: ids.map((id) => { const e = document.getElementById(id), r = e.getBoundingClientRect(); return { id, x: r.x, y: r.y, width: r.width, height: r.height, label: e.getAttribute('aria-label'), title: e.title }; }) };
            });
            check(locale + ' 收藏短按鈕與兩個圖示保持一行、320px 無溢出', geometry.width <= 304 && geometry.scroll <= geometry.width && Math.max(...geometry.buttons.map((b) => b.y)) - Math.min(...geometry.buttons.map((b) => b.y)) < 2 && geometry.buttons[0].width < 100, geometry);
            check(locale + ' 重查圖示有本地化可讀標籤', /重新查词|重新查詞/.test(geometry.buttons[2].label));
            const expectedLabel = locale === 'zh-HK' ? '播放發音' : '播放发音';
            check(locale + ' 發音圖示可見且具本地化標籤', await frame.locator('#ext-result-speak').isVisible()
                && await frame.locator('#ext-result-speak').getAttribute('aria-label') === expectedLabel);
            await frame.evaluate(() => { window.__lookupSpeech.failNext = true; });
            await frame.locator('#ext-result-speak').click();
            const errorText = await frame.locator('#ext-pronunciation-notice').textContent();
            check(locale + ' 系統語音失敗會顯示對應語言提示並可重試', await frame.locator('#ext-pronunciation-notice').isVisible()
                && errorText.includes(locale === 'zh-HK' ? '暫時無法播放發音' : '暂时无法播放发音')
                && await frame.locator('#ext-result-speak').getAttribute('aria-pressed') === 'false');
            await frame.locator('#ext-result-speak').click();
            check(locale + ' 發音失敗後可直接重播，原單詞保持英文', await frame.locator('#ext-pronunciation-notice').isHidden()
                && await frame.evaluate(() => window.__lookupSpeech.current.text === 'plunge' && window.__lookupSpeech.current.lang === 'en-US'));
            await frame.evaluate(() => window.__lookupSpeech.current.onend());
            await other.screenshot({ path: path.join(OUT, 'compact-' + locale + '.png') });
        }
        const attemptsBeforeFailure = aiAttempts;
        failLookups = true;
        await frame.locator('#ext-inline-retry').click();
        await frame.locator('#ext-inline-lookup-notice').waitFor({ state: 'visible' });
        await frame.waitForFunction(() => !document.querySelector('#ext-inline-retry').disabled);
        check('重查失敗直接顯示錯誤，圖示保留且沒有舊答案冒充成功', aiAttempts > attemptsBeforeFailure
            && await frame.locator('#ext-inline-retry').isVisible() && await frame.locator('#ext-result-box').isHidden());
        failLookups = false;
        const attemptsBeforeRecovery = aiAttempts;
        await frame.locator('#ext-inline-retry').click(); await waitResult(frame);
        check('失敗後可再次點圖示恢復，不會卡在忙碌狀態', aiAttempts === attemptsBeforeRecovery + 1
            && await frame.locator('#ext-inline-lookup-notice').isHidden());
        const latest = await frame.locator('#ext-result-meaning').textContent(), successfulCalls = env.state.aiCalls;
        await frame.locator('#ext-result-speak').click();
        const beforeCloseSpeech = speechEvents.length;
        await closeCard(other, frame, base);
        check('關閉正在發音的詞卡會取消語音', speechEvents.slice(beforeCloseSpeech).some((event) => event.type === 'cancel'));
        frame = await openCard(other, base); await waitResult(frame);
        check('恢復後普通查詢命中新成功結果，失敗沒有覆蓋快取', env.state.aiCalls === successfulCalls
            && (await frame.locator('#ext-result-meaning').textContent()) === latest && await frame.locator('#ext-result-cache').isVisible());
        check('所有流程無未捕獲 JavaScript 例外', errors.length === 0, errors);
    } finally {
        releaseAll();
        const diagnostics = [];
        for (const page of context?.pages() || []) for (const frame of page.frames()) {
            if (!frame.url().startsWith('chrome-extension://') || !frame.url().includes('/lookup.html')) continue;
            diagnostics.push(await frame.evaluate(() => ({ url: location.href, word: document.querySelector('#ext-word-input')?.value,
                sentence: document.querySelector('#ext-sentence-input')?.value, result: document.querySelector('#ext-result-meaning')?.textContent,
                notice: document.querySelector('#ext-lookup-notice')?.textContent, inlineNotice: document.querySelector('#ext-inline-lookup-notice')?.textContent,
                task: document.querySelector('#ext-task-status')?.textContent, refreshDisabled: document.querySelector('#ext-inline-retry')?.disabled,
                capture: document.querySelector('#ext-capture-notice')?.textContent, account: document.querySelector('#ext-account-status')?.textContent
            })).catch((error) => ({ error: error.message })));
        }
        fs.writeFileSync(path.join(OUT, 'diagnostics.json'), JSON.stringify({ aiCalls: env.state.aiCalls, diagnostics }, null, 2));
        fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ checks, timings, errors }, null, 2));
        await context?.close(); await env.close(); fs.rmSync(profile, { recursive: true, force: true });
    }
})().catch((e) => { console.error(e); process.exitCode = 1; });
