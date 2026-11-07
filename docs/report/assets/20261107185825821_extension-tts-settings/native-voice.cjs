const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const ROOT = path.resolve(__dirname, '../../../..');
const { environment, ALICE } = require(path.join(ROOT, 'tests/helpers/extension-mv3.cjs'));
const { openCard, waitResult } = require(path.join(ROOT, 'tests/extension-lookup-cache.cjs'));

(async () => {
    const env = await environment();
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-native-voice-'));
    let context;
    const result = { engine: 'native Chromium speechSynthesis; no speech mock', events: [], checks: [] };
    try {
        context = await chromium.launchPersistentContext(profile, {
            channel: 'chromium', headless: false, viewport: { width: 1100, height: 800 },
            args: ['--disable-extensions-except=' + ROOT + '/extension', '--load-extension=' + ROOT + '/extension']
        });
        await context.route('https://lookup-cache-native.example/**', (route) => route.fulfill({
            contentType: 'text/html',
            body: '<!doctype html><title>Pronunciation</title><article><h1>Pronunciation</h1><p id="article">The president was impeached after the vote.</p></article>'
        }));
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
        const page = await context.newPage();
        await page.goto('https://lookup-cache-native.example/article');
        const frame = await openCard(page, base, 'impeached');
        await waitResult(frame);
        // Headed macOS drags may select a shorter range while the browser
        // window settles. Set the exact term through the real edit dialog.
        await frame.locator('#ext-inline-edit').click();
        await frame.locator('#ext-word-input').fill('impeached');
        await frame.locator('#ext-lookup-btn').click();
        await waitResult(frame);
        assert.equal(await frame.locator('#ext-result-word').textContent(), 'impeached');
        await frame.waitForFunction(() => speechSynthesis.getVoices().some((voice) => /^en/i.test(voice.lang)), null, { timeout: 15000 });
        result.voices = await frame.evaluate(() => speechSynthesis.getVoices().map(({ name, lang, localService }) => ({ name, lang, localService })));
        await frame.evaluate(() => {
            window.__nativeSpeechEvents = [];
            const original = speechSynthesis.speak.bind(speechSynthesis);
            speechSynthesis.speak = (utterance) => {
                for (const type of ['start', 'end', 'error']) utterance.addEventListener(type, (event) =>
                    window.__nativeSpeechEvents.push({ type, text: utterance.text, lang: utterance.lang,
                        voice: utterance.voice?.name || '', error: event.error || '' }));
                return original(utterance);
            };
        });
        const calls = env.state.aiCalls;
        await frame.locator('#ext-result-speak').click();
        await frame.waitForFunction(() => window.__nativeSpeechEvents.some((event) => event.type === 'end' || event.type === 'error'), null, { timeout: 15000 });
        result.events = await frame.evaluate(() => window.__nativeSpeechEvents);
        assert.ok(result.events.some((event) => event.type === 'start' && event.text === 'impeached' && /^en/i.test(event.lang)));
        assert.ok(result.events.some((event) => event.type === 'end'));
        assert.ok(!result.events.some((event) => event.type === 'error'));
        assert.equal(env.state.aiCalls, calls);
        assert.equal(await frame.locator('#ext-result-speak').getAttribute('aria-pressed'), 'false');
        const started = result.events.find((event) => event.type === 'start');
        assert.ok(started.voice && !/^albert$/i.test(started.voice));
        result.status = await frame.locator('#ext-tts-status').textContent();
        result.detail = await frame.locator('#ext-tts-status').getAttribute('title');
        assert.ok(result.status.includes(started.voice));
        assert.ok(result.detail.includes('TTS 未配置'));
        result.checks = ['native English voice starts in actual cross-origin extension iframe', 'native engine ends without error',
            'no AI request for speech', 'button returns to play', 'natural English voice chosen instead of Albert',
            'source badge shows actual voice and unconfigured service reason'];
        await page.screenshot({ path: path.join(__dirname, 'native-pronunciation.png') });
        console.log('PASS native engine in real extension iframe', result.events);
    } finally {
        fs.writeFileSync(path.join(__dirname, 'native-voice.json'), JSON.stringify(result, null, 2) + '\n');
        await context?.close();
        await env.close();
        fs.rmSync(profile, { recursive: true, force: true });
    }
})().catch((error) => { console.error(error); process.exitCode = 1; });
