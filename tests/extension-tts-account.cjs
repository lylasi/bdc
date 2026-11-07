// Actual website UI + actual MV3 + actual Worker/SQLite and real HTTP audio.
// TTS service/config and account credentials are synthetic fixtures only.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { environment, ALICE, BOB } = require('./helpers/extension-mv3.cjs');
const ROOT = path.resolve(__dirname, '..');
const OUT = process.env.TTS_ACCOUNT_OUTPUT || path.join(os.tmpdir(), 'bdc-tts-account-browser');
const KEY = ['fixture', 'account', 'tts'].join('-'), BOB_KEY = ['fixture', 'bob', 'tts'].join('-');
const VOICE = 'en-US-JennyNeural', ID = ['bdc', 'tts', 'v1'].join('-');
const checks = [], errors = [], audioRequests = [];
function check(name, ok) { checks.push({ name, ok: !!ok }); console.log((ok ? 'PASS ' : 'FAIL ') + name); assert.ok(ok, name); }
function wav() {
    const samples = 5512, bytes = samples * 2, b = Buffer.alloc(44 + bytes);
    b.write('RIFF'); b.writeUInt32LE(36 + bytes, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
    b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(22050, 24); b.writeUInt32LE(44100, 28);
    b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(bytes, 40); return b;
}
(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    execFileSync(process.execPath, ['scripts/package-extension.mjs'], { cwd: ROOT });
    const env = await environment();
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://localhost');
        res.setHeader('Access-Control-Allow-Origin', '*');
        const valid = url.searchParams.get('api_key') === KEY;
        audioRequests.push({ path: url.pathname, authenticated: valid, voice: url.searchParams.get('v') });
        if (!valid) { res.writeHead(401); res.end(); return; }
        if (url.pathname === '/voices') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify([{ ShortName: VOICE, Locale: 'en-US' }])); return; }
        if (url.pathname !== '/tts') { res.writeHead(404); res.end(); return; }
        res.setHeader('Content-Type', 'audio/wav'); res.end(wav());
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const service = 'http://127.0.0.1:' + server.address().port, otherService = 'https://bob-speech.example.test';
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-tts-account-'));
    let browser, web, context;
    const cloud = async (token = ALICE) => (await fetch(env.base + '/snapshot', { headers: { Authorization: 'Bearer ' + token } })).json();
    try {
        browser = await chromium.launch({ channel: 'chromium', headless: true });
        web = await browser.newContext({ viewport: { width: 1250, height: 900 } });
        await web.addInitScript((endpoint) => { window.__BDC_SYNC_ENDPOINT__ = endpoint; }, env.base);
        const source = fs.readFileSync(path.join(ROOT, 'ai-config.example.js'), 'utf8').replace(/export const TTS_CONFIG = \{[\s\S]*?\n\};/,
            'export const TTS_CONFIG = ' + JSON.stringify({ use: 'remote', baseUrl: service, baseUrlRemote: service, apiKey: KEY,
                voices: { english: VOICE, chinese: 'zh-CN-XiaoxiaoNeural', cantonese: 'zh-HK-HiuGaaiNeural' } }) + ';');
        await web.route('**/ai-config.js', (route) => route.fulfill({ contentType: 'text/javascript', body: source }));
        const page = await web.newPage(); page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(env.appBase); await page.waitForSelector('#app-gear-btn');
        await page.evaluate(async (token) => { await (await import('/modules/sync-cloudflare.js')).auth.signInWithToken(token); }, ALICE);
        await page.evaluate(async () => { await (await import('/modules/tts-account-sync.js')).syncTTSAccount(); });
        check('主站登入後自動保存原本遠端 TTS 伺服器', (await cloud()).payload.ttsSettings.settings.tts.baseUrlRemote === service);
        await page.evaluate(() => {
            const later = [...document.querySelectorAll('button')].find((button) => ['稍后', '稍後'].includes(button.textContent.trim())); later?.click();
        });
        await page.locator('#app-gear-btn').click(); await page.locator('#gm-settings').click();
        await page.locator('[data-gs-tab="voice"]').click();
        await page.waitForFunction(() => document.querySelector('#gs-tts-account-state')?.textContent.includes('已保存'));
        check('個人設定的語音頁顯示已保存到目前帳戶', (await page.locator('#gs-tts-account-state').textContent()).includes('当前账号'));
        check('主站 Key 欄位保持遮蔽', await page.locator('#gs-tts-key').getAttribute('type') === ['pass', 'word'].join(''));
        check('主站 Key 標籤明示登入後加密同步', (await page.locator('#gs-tts-key').getAttribute('aria-label')).includes('加密同步'));
        await page.locator('label:has(#gs-read-en-us)').click();
        await page.locator('[data-voice-group="en-US"]').selectOption(VOICE);
        await page.locator('#gs-tts-account-sync').click();
        await page.waitForFunction(() => document.querySelector('#gs-tts-account-state').textContent.includes('已保存'));
        const mainCloud = await cloud();
        check('聲音與英語朗讀偏好均保存到帳戶', mainCloud.payload.ttsSettings.settings.tts.selectedVoices['en-US'] === VOICE
            && mainCloud.payload.ttsSettings.settings.reading.englishVariant === 'en-US');
        const row = env.db.prepare('SELECT key_ciphertext,nonce FROM user_ai_credentials WHERE user_id=? AND provider_id=?').get('alice', ID);
        check('真 Worker 在資料庫保存密文，沒有明文 Key', !!row?.nonce && !!row?.key_ciphertext && !row.key_ciphertext.includes(KEY));
        check('一般學習資料快照沒有 TTS Key', !JSON.stringify(mainCloud).includes(KEY));
        await page.screenshot({ path: path.join(OUT, 'website-account-zh-CN.png') });
        await page.locator('[data-gs-tab="general"]').click();
        await page.locator('#gs-interface-locale').selectOption('zh-HK');
        await page.locator('[data-gs-tab="voice"]').click();
        await page.waitForFunction(() => document.querySelector('#gs-tts-account-state')?.textContent.includes('帳戶'));
        check('主站香港繁體顯示帳戶保存及加密同步', (await page.locator('#gs-tts-account-state').textContent()).includes('已儲存')
            && (await page.locator('#gs-tts-key').getAttribute('aria-label')).includes('加密同步'));
        await page.screenshot({ path: path.join(OUT, 'website-account-zh-HK.png') });
        await page.locator('#gs-save').click(); await web.close(); web = null; await browser.close(); browser = null;
        const beforeExtension = (await cloud()).version;

        context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
            viewport: { width: 1100, height: 820 }, args: ['--disable-extensions-except=' + ROOT + '/extension', '--load-extension=' + ROOT + '/extension'] });
        context.on('page', (p) => p.on('pageerror', (error) => errors.push(error.message)));
        const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
        const base = 'chrome-extension://' + new URL(worker.url()).host;
        const popup = await context.newPage(); await popup.goto(base + '/lookup.html');
        await popup.waitForFunction(() => !!document.querySelector('#ext-account-status').textContent);
        await popup.evaluate(() => chrome.storage.local.set({ bdc_extension_assistant_enabled: false }));
        await popup.locator('#ext-settings-open').click();
        if (!await popup.locator('#ext-account-details').evaluate((node) => node.open)) await popup.locator('#ext-account-summary').click();
        await popup.locator('#ext-endpoint-input').fill(env.base); await popup.locator('#ext-login-mode').selectOption('token');
        await popup.locator('#ext-token-input').fill(ALICE); await popup.locator('#ext-connect-btn').click();
        await popup.waitForFunction(() => !document.querySelector('#ext-connect-btn').disabled && document.querySelector('#ext-account-status').textContent.includes('alice'));
        await popup.locator('#ext-tts-settings').evaluate((node) => { node.open = true; });
        await popup.waitForFunction(() => document.querySelector('#ext-tts-url').value.startsWith('http://127.0.0.1:'));
        check('全新擴充登入即帶入主站遠端地址，不用重新填寫', await popup.locator('#ext-tts-url').inputValue() === service);
        check('所選聲音、朗讀偏好與加密 Key 一併帶入', await popup.locator('#ext-tts-key').inputValue() === KEY
            && await popup.locator('#ext-tts-accent').inputValue() === 'en-US' && await popup.locator('#ext-tts-voice').inputValue() === VOICE);
        check('新擴充沒有用空白內容覆蓋主站快照', (await cloud()).version === beforeExtension);
        await popup.locator('#ext-tts-test').click();
        await popup.waitForFunction(() => document.querySelector('#ext-tts-check').dataset.state === 'success');
        check('帶入的配置實際成功播放 HTTP 音訊', audioRequests.some((request) => request.path === '/tts' && request.authenticated && request.voice === VOICE));
        await popup.waitForFunction(() => document.querySelector('#ext-tts-test').getAttribute('aria-pressed') === 'false');
        await popup.screenshot({ path: path.join(OUT, 'extension-inherited-zh-CN.png') });
        await popup.locator('#ext-locale-select').selectOption('zh-HK'); await popup.setViewportSize({ width: 320, height: 780 });
        check('香港繁體顯示帳戶帶入及加密同步說明', (await popup.locator('#ext-tts-account-state').textContent()).includes('帳戶')
            && (await popup.locator('[data-i18n="extension.ttsScopeHint"]').textContent()).includes('加密憑據'));
        await popup.screenshot({ path: path.join(OUT, 'extension-inherited-zh-HK-320.png') });

        // Bob has his own account configuration and encrypted key.
        const bobSettings = { ttsSettings: { updatedAt: new Date().toISOString(), settings: { tts: { use: 'custom', baseUrlCustom: otherService,
            selectedVoices: { 'en-GB': 'en-GB-SoniaNeural' } }, reading: { englishVariant: 'en-GB' } } } };
        let response = await fetch(env.base + '/snapshot', { method: 'POST', headers: { Authorization: 'Bearer ' + BOB, 'Content-Type': 'application/json' },
            body: JSON.stringify({ expected_version: 0, payload: bobSettings }) }); assert.equal(response.status, 200);
        response = await fetch(env.base + '/ai-credentials/' + ID, { method: 'PUT', headers: { Authorization: 'Bearer ' + BOB, 'Content-Type': 'application/json' },
            body: JSON.stringify({ expectedVersion: 0, mutationId: 'seed-bob-tts-account', apiKey: BOB_KEY,
                binding: { formatVersion: 1, format: 'openai-chat', apiUrl: otherService + '/tts', modelsUrl: '', authMode: 'bearer' } }) });
        assert.equal(response.status, 200);
        // Start a debounced edit in Alice, then switch before it can be saved.
        await popup.evaluate(async ({ token }) => {
            const input = document.querySelector('#ext-tts-key'); input.value = 'not-for-bob'; input.dispatchEvent(new Event('input', { bubbles: true }));
            await (await import('./modules/sync-cloudflare.js')).auth.signInWithToken(token);
            await (await import('./modules/extension-ai-runtime.js')).syncExtensionAccountAI();
        }, { token: BOB });
        await popup.waitForFunction(() => document.querySelector('#ext-tts-url').value.startsWith('https://bob-speech'));
        check('切換帳戶後顯示 Bob 自己的服務與 Key', await popup.locator('#ext-tts-url').inputValue() === otherService && await popup.locator('#ext-tts-key').inputValue() === BOB_KEY);
        const bobKey = await (await fetch(env.base + '/ai-credentials/' + ID, { headers: { Authorization: 'Bearer ' + BOB } })).json();
        check('舊帳戶尚未自動儲存的輸入不會寫進新帳戶', bobKey.apiKey === BOB_KEY);
        if (!await popup.locator('#ext-account-details').evaluate((node) => node.open)) await popup.locator('#ext-account-summary').click();
        await popup.locator('#ext-logout-btn').click();
        await popup.waitForFunction(() => document.querySelector('#ext-tts-key').value === '');
        check('登出即清除目前帳戶聲音及 Key 的表單顯示', await popup.locator('#ext-tts-url').inputValue() === ''
            && !(await popup.locator('#ext-tts-summary').textContent()).includes('bob'));
        check('網站及擴充流程沒有未捕獲 JS 例外', errors.length === 0);
    } finally {
        fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ checks, errors, audioRequests }, null, 2) + '\n');
        await web?.close(); await browser?.close(); await context?.close();
        await env.close(); server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve));
        fs.rmSync(profile, { recursive: true, force: true });
    }
    console.log(JSON.stringify({ passed: checks.filter((item) => item.ok).length, failed: checks.filter((item) => !item.ok).length, output: OUT }));
})().catch((error) => { console.error(error); process.exitCode = 1; });
