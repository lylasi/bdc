// Actual MV3, actual HTTP WAV playback and service catalog; device speech is
// controlled so fallback, voice selection and cancellation remain deterministic.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { environment, ALICE } = require('./helpers/extension-mv3.cjs');
const { openCard, waitResult } = require('./extension-lookup-cache.cjs');
const ROOT = path.resolve(__dirname, '..');
const OUT = process.env.TTS_CONTROLS_OUTPUT || path.join(os.tmpdir(), 'bdc-extension-tts-controls');
const KEY = ['tts', 'test', 'credential'].join('-');
const checks = [], errors = [], requests = [];
function check(name, condition) {
    checks.push({ name, ok: !!condition });
    console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`);
    assert.ok(condition, name);
}
function wav() {
    const samples = 5512, bytes = samples * 2, b = Buffer.alloc(44 + bytes);
    b.write('RIFF'); b.writeUInt32LE(36 + bytes, 4); b.write('WAVEfmt ', 8);
    b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
    b.writeUInt32LE(22050, 24); b.writeUInt32LE(44100, 28); b.writeUInt16LE(2, 32);
    b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(bytes, 40);
    return b;
}
(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    execFileSync(process.execPath, ['scripts/package-extension.mjs'], { cwd: ROOT });
    const env = await environment(), profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-tts-controls-'));
    let context, mode = 'good';
    const held = new Set();
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://localhost');
        const authenticated = url.searchParams.get('api_key') === KEY;
        res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Cache-Control', 'no-store');
        requests.push({ path: url.pathname, voice: url.searchParams.get('v'), authenticated, mode });
        if (!authenticated) { res.writeHead(401); res.end('unauthorized'); return; }
        if (url.pathname === '/voices') {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify([{ ShortName: 'en-US-ServiceVoice', Locale: 'en-US', FriendlyName: 'Service English' },
                { ShortName: 'en-GB-ServiceVoice', Locale: 'en-GB' }])); return;
        }
        if (url.pathname !== '/tts') { res.writeHead(404); res.end(); return; }
        if (mode === 'fail') { res.writeHead(503); res.end('unavailable'); return; }
        if (mode === 'hold') { held.add(res); res.on('close', () => held.delete(res)); return; }
        res.setHeader('Content-Type', 'audio/wav'); res.end(wav());
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const service = 'http://127.0.0.1:' + server.address().port;
    try {
        context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
            viewport: { width: 1100, height: 800 }, args: ['--disable-extensions-except=' + ROOT + '/extension', '--load-extension=' + ROOT + '/extension'] });
        context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
        await context.addInitScript(() => {
            if (location.protocol !== 'chrome-extension:') return;
            const data = window.__deviceSpeech = { calls: [], current: null };
            const synth = new EventTarget();
            synth.getVoices = () => [
                { name: 'Albert', voiceURI: 'Albert', lang: 'en-US', localService: true },
                { name: 'English US Natural', voiceURI: 'natural-us', lang: 'en-US', localService: true },
                { name: 'English UK Natural', voiceURI: 'natural-gb', lang: 'en-GB', localService: true }
            ];
            synth.cancel = () => { data.current = null; };
            synth.speak = (utterance) => { data.calls.push(utterance); data.current = utterance; utterance.onstart?.(); };
            Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: class { constructor(text) { this.text = text; } } });
            Object.defineProperty(window, 'speechSynthesis', { value: synth });
        });
        await context.route('https://lookup-cache-tts.example/**', (route) => route.fulfill({ contentType: 'text/html',
            body: '<!doctype html><title>TTS article</title><article><h1>TTS article</h1><p id="article">Markets plunge as investors wait.</p></article>' }));
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
        const page = await context.newPage(); await page.goto('https://lookup-cache-tts.example/article');
        const frame = await openCard(page, base); await waitResult(frame);
        const aiCalls = env.state.aiCalls;
        check('未設定服務時明示裝置來源及未配置原因', (await frame.locator('#ext-tts-status').textContent()).includes('English UK Natural')
            && (await frame.locator('#ext-tts-status').getAttribute('title')).includes('TTS 未配置'));
        await frame.locator('#ext-result-speak').click();
        check('自動裝置聲音不再選取 Albert', await frame.evaluate(() => window.__deviceSpeech.current.voice.name === 'English UK Natural'));
        await frame.locator('#ext-result-speak').click();
        await frame.locator('#ext-tts-status').click();
        check('來源提示可直接開啟 TTS 設定彈窗', await frame.locator('#ext-settings-dialog').evaluate((node) => node.open)
            && await frame.locator('#ext-tts-settings').evaluate((node) => node.open));
        check('TTS 金鑰欄位遮蔽輸入', await frame.locator('#ext-tts-key').getAttribute('type') === ['pass', 'word'].join(''));
        const requestsBeforeInvalid = requests.length;
        await frame.locator('#ext-tts-url').fill('https://speech.test/?secret=value');
        await frame.locator('#ext-tts-key').fill(KEY);
        await frame.locator('#ext-tts-test').click();
        check('無效地址阻止試播，修改其他欄位也不會誤播舊服務', (await frame.locator('#ext-tts-check').textContent()).includes('HTTP(S)')
            && requests.length === requestsBeforeInvalid);
        await frame.locator('#ext-tts-url').fill(service.replace('http:', 'HTTP:') + '/'); await frame.locator('#ext-tts-key').fill(KEY);
        check('貼上的大小寫及尾斜線地址會正規化保存', await frame.evaluate(async () =>
            (await import('./modules/settings.js')).loadGlobalSettings().tts.baseUrlCustom) === service);
        await frame.locator('#ext-tts-accent').selectOption('en-US');
        await frame.locator('#ext-tts-voice').fill('en-US-ServiceVoice');
        await frame.locator('#ext-tts-device-voice').selectOption('natural-us');
        await frame.locator('#ext-tts-load-voices').click();
        await frame.locator('#ext-tts-load-voices').waitFor({ state: 'visible' });
        await frame.waitForFunction(() => !document.querySelector('#ext-tts-load-voices').disabled);
        check('只讀取所填服務的聲音清單並使用 Key', await frame.locator('#ext-tts-voice-list option').count() === 2
            && requests.some((request) => request.path === '/voices' && request.authenticated));
        check('讀取清單不會誤報播放成功', await frame.locator('#ext-tts-check').getAttribute('data-state') !== 'success');
        const deviceBefore = await frame.evaluate(() => window.__deviceSpeech.calls.length);
        await frame.locator('#ext-tts-test').click();
        await frame.waitForFunction(() => document.querySelector('#ext-tts-check').dataset.state === 'success');
        check('真 HTTP WAV 音訊播放成功，顯示服務及聲音 ID', (await frame.locator('#ext-tts-check').textContent()).includes('TTS 服务播放成功')
            && (await frame.locator('#ext-tts-check').textContent()).includes('en-US-ServiceVoice'));
        check('服務正常時沒有偷用裝置語音', await frame.evaluate((count) => window.__deviceSpeech.calls.length === count, deviceBefore));
        check('TTS 請求實際使用所選聲音及 Key', requests.some((request) => request.path === '/tts' && request.voice === 'en-US-ServiceVoice' && request.authenticated));
        check('公開狀態不顯示密鑰或請求 URL', !((await frame.locator('#ext-tts-check').textContent())
            + (await frame.locator('#ext-tts-status').getAttribute('title'))).includes(KEY));
        await frame.waitForFunction(() => document.querySelector('#ext-tts-test').getAttribute('aria-pressed') === 'false', null, { timeout: 3000 });
        await page.screenshot({ path: path.join(OUT, 'settings-zh-CN-success.png') });

        await frame.evaluate(() => {
            window.__ttsEvents = [];
            for (const type of ['pointerdown', 'pointerup', 'click', 'blur', 'change']) document.addEventListener(type, (event) => {
                const button = document.querySelector('#ext-tts-test'), rect = button.getBoundingClientRect();
                window.__ttsEvents.push({ type, target: event.target.id, y: rect.y, height: rect.height,
                    pressed: button.getAttribute('aria-pressed'), state: document.querySelector('#ext-tts-check').dataset.state });
            }, true);
        });
        await frame.locator('#ext-tts-key').fill('wrong-key'); await frame.locator('#ext-tts-test').click();
        fs.writeFileSync(path.join(OUT, 'event-trace.json'), JSON.stringify(await frame.evaluate(() => window.__ttsEvents), null, 2));
        await frame.waitForFunction(() => document.querySelector('#ext-tts-check').dataset.state === 'warning');
        check('服務拒絕時明示回退裝置及實際聲音', (await frame.locator('#ext-tts-check').textContent()).includes('English US Natural')
            && (await frame.locator('#ext-tts-check').textContent()).includes('TTS 音频无法加载'));
        check('服務失敗不顯示綠色正常', await frame.locator('#ext-tts-check').getAttribute('data-state') !== 'success');
        await frame.evaluate(() => window.__deviceSpeech.current.onend());
        await frame.locator('#ext-tts-load-voices').click();
        await frame.waitForFunction(() => document.querySelector('#ext-tts-voices-notice').textContent.includes('401'));
        check('聲音清單可辨識 HTTP 401，而不是使用別個服務的快取', (await frame.locator('#ext-tts-voices-notice').textContent()).includes('401'));
        await page.screenshot({ path: path.join(OUT, 'settings-zh-CN-fallback.png') });

        await frame.locator('#ext-tts-key').fill(KEY); await frame.locator('#ext-tts-test').click();
        await frame.waitForFunction(() => document.querySelector('#ext-tts-check').dataset.state === 'success');
        check('修正 Key 後直接重試可恢復服務播放', await frame.locator('#ext-tts-status').getAttribute('data-state') === 'success');
        await frame.waitForFunction(() => document.querySelector('#ext-tts-test').textContent.includes('试播'));
        mode = 'hold'; const countBeforeCancel = await frame.evaluate(() => window.__deviceSpeech.calls.length);
        await frame.locator('#ext-tts-test').click();
        await frame.waitForFunction(() => document.querySelector('#ext-tts-check').dataset.state === 'info'
            && document.querySelector('#ext-tts-test').textContent.includes('停止'));
        await frame.evaluate(async () => { await (await import('./modules/tts-account-sync.js')).syncTTSAccount(); });
        check('背景確認 Key 同步狀態不會打斷正在等待的試播', await frame.locator('#ext-tts-test').getAttribute('aria-pressed') === 'true');
        await frame.locator('#ext-tts-test').click();
        for (const res of held) res.destroy(); held.clear();
        await page.waitForTimeout(150);
        check('取消未完成的遠端試播後不會突然啟動裝置語音', await frame.evaluate((count) => window.__deviceSpeech.calls.length === count, countBeforeCancel));
        mode = 'good';

        await frame.locator('#ext-tts-mode').selectOption('device');
        await frame.locator('#ext-tts-test').click();
        check('可明確選裝置語音，保留手選的自然聲音', await frame.evaluate(() => window.__deviceSpeech.current.voice.name === 'English US Natural')
            && await frame.locator('#ext-tts-check').getAttribute('data-state') === 'info');
        await frame.locator('#ext-tts-test').click();
        await frame.locator('#ext-locale-select').selectOption('zh-HK');
        await page.setViewportSize({ width: 320, height: 720 });
        await frame.waitForFunction(() => innerWidth <= 320);
        const settingsGeometry = await frame.evaluate(() => {
            const dialog = document.querySelector('#ext-settings-dialog'), r = dialog.getBoundingClientRect();
            const body = dialog.querySelector('.ext-dialog-body');
            return { width: innerWidth, left: r.left, right: r.right, bodyWidth: body.clientWidth, bodyScrollWidth: body.scrollWidth };
        });
        check('320px TTS 設定彈窗及欄位完整置於畫面內', settingsGeometry.left >= 0 && settingsGeometry.right <= settingsGeometry.width
            && settingsGeometry.bodyScrollWidth <= settingsGeometry.bodyWidth, settingsGeometry);
        check('香港繁體設定及播放來源文案完整', (await frame.locator('#ext-tts-check').textContent()).includes('裝置語音')
            && (await frame.locator('#ext-tts-test').textContent()).includes('試播並檢查'));
        await page.screenshot({ path: path.join(OUT, 'settings-zh-HK-device-320.png') });
        await frame.locator('#ext-settings-close').click();
        await frame.locator('#ext-inline-retry').click(); await waitResult(frame);
        check('320px 詞卡顯示聲音來源而不橫向溢出', await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth)
            && (await frame.locator('#ext-tts-status').textContent()).includes('English US Natural'));
        await page.screenshot({ path: path.join(OUT, 'card-zh-HK-device-320.png') });
        await frame.locator('#ext-result-speak').click();
        check('詞卡發音沿用已儲存的裝置聲音', await frame.evaluate(() => window.__deviceSpeech.current.voice.name === 'English US Natural'));
        check('修改及測試語音不會重新請求 AI 查詞', env.state.aiCalls === aiCalls + 1, 'only explicit locale requery adds one');
        const reopened = await context.newPage();
        await reopened.goto(base + '/lookup.html');
        await reopened.waitForFunction(() => !!document.querySelector('#ext-account-status').textContent);
        await reopened.locator('#ext-settings-open').click();
        await reopened.locator('#ext-tts-settings').evaluate((node) => { node.open = true; });
        check('重新開啟擴充後保留模式、服務、聲音及金鑰', await reopened.locator('#ext-tts-mode').inputValue() === 'device'
            && await reopened.locator('#ext-tts-url').inputValue() === service
            && await reopened.locator('#ext-tts-key').inputValue() === KEY
            && await reopened.locator('#ext-tts-voice').inputValue() === 'en-US-ServiceVoice'
            && await reopened.locator('#ext-tts-device-voice').inputValue() === 'natural-us');
        check('設定及錯誤路徑沒有未捕獲頁面例外', errors.length === 0);
    } finally {
        const diagnostics = [];
        for (const page of context?.pages() || []) for (const frame of page.frames()) {
            if (!frame.url().startsWith('chrome-extension://') || !frame.url().includes('/lookup.html')) continue;
            diagnostics.push(await frame.evaluate(async () => {
                const { globalAudioElement: el } = await import('./modules/state.js');
                const { getActiveAudioOwner } = await import('./modules/audio.js');
                return { owner: getActiveAudioOwner(), label: document.querySelector('#ext-tts-test')?.textContent,
                    status: document.querySelector('#ext-tts-check')?.textContent,
                    audio: el && { time: el.currentTime, duration: el.duration, ended: el.ended, paused: el.paused,
                        readyState: el.readyState, networkState: el.networkState, endedHandler: typeof el.onended } };
            }).catch(() => ({ unavailable: true })));
        }
        fs.writeFileSync(path.join(OUT, 'diagnostics.json'), JSON.stringify(diagnostics, null, 2));
        fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ checks, errors, requests }, null, 2));
        await context?.close(); await env.close();
        for (const res of held) res.destroy(); server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve)); fs.rmSync(profile, { recursive: true, force: true });
    }
    console.log(JSON.stringify({ passed: checks.filter((check) => check.ok).length, failed: checks.filter((check) => !check.ok).length, output: OUT }));
})().catch((error) => { console.error(error); process.exitCode = 1; });
