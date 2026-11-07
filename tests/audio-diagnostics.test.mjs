import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../modules/audio.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
function setup({ remote = true, voices, speechAvailable = true, play } = {}) {
    let settings = { tts: { use: 'custom', baseUrlCustom: remote ? 'https://speech.test/private-path' : '',
        baseUrlRemote: 'https://other-service.test', selectedVoices: { 'en-US': 'en-US-TestNeural' } },
    reading: { englishVariant: 'en-US' } };
    const calls = [], statuses = [], errors = [];
    let pendingResolve, pendingReject;
    const pending = new Promise((resolve, reject) => { pendingResolve = resolve; pendingReject = reject; });
    const el = { src: '', paused: true, error: null, load() {}, pause() { this.paused = true; },
        removeAttribute(name) { if (name === 'src') this.src = ''; },
        play() { this.paused = false; return play ? play(this) : pending; } };
    const available = voices || [
        { name: 'Albert', voiceURI: 'Albert', lang: 'en-US', localService: true },
        { name: 'English US Natural', voiceURI: 'English US Natural', lang: 'en-US', localService: true },
        { name: 'Daniel', voiceURI: 'Daniel', lang: 'en-GB', localService: true },
        { name: 'Chinese', voiceURI: 'Chinese', lang: 'zh-CN', default: true }
    ];
    const window = { location: { href: 'https://app.test/' }, speechSynthesis: {
        getVoices: () => available, cancel() {}, speak(utterance) { calls.push(utterance); utterance.onstart?.(); }
    }, SpeechSynthesisUtterance: speechAvailable ? class { constructor(text) { this.text = text; } } : undefined };
    const context = { state: { globalAudioElement: el }, window, document: { dispatchEvent() {} },
        CustomEvent: class {}, URL, setTimeout, clearTimeout, console,
        TTS_CONFIG: { apiKey: '', voices: { english: 'en-US-DefaultNeural' } },
        loadGlobalSettings: () => settings, loadGlobalSecrets: () => ({ ttsApiKey: 'private-fixture-key' }) };
    vm.createContext(context); vm.runInContext(source, context);
    const options = { owner: 'test', timeoutMs: 1000, onStatus: (event) => statuses.push(event), onError: (error) => errors.push(error) };
    return { audio: context, el, calls, statuses, errors, options, resolve: pendingResolve, reject: pendingReject,
        setSettings(patch) { settings = { ...settings, ...patch, tts: { ...settings.tts, ...patch.tts } }; },
        speak(extra = {}) { return context.speakText('immunity', 'english', 0, null, null, { ...options, ...extra }); } };
}

test('service success is confirmed after playback starts, with host and selected voice only', async () => {
    const f = setup();
    const pending = f.speak();
    assert.equal(f.statuses[0].state, 'loading');
    assert.equal(f.statuses.some((event) => event.state === 'playing'), false);
    f.el.oncanplay?.();
    assert.equal(f.statuses.some((event) => event.state === 'playing'), false);
    f.el.onplaying();
    assert.equal(await pending, true);
    const played = f.statuses.at(-1);
    assert.equal(played.source, 'remote'); assert.equal(played.host, 'speech.test');
    assert.equal(played.voice, 'en-US-TestNeural');
    assert.ok(!JSON.stringify(f.statuses).includes('private-fixture-key'));
    assert.ok(!JSON.stringify(f.statuses).includes('private-path'));
    assert.equal(f.calls.length, 0);
    f.el.onended(); assert.equal(f.statuses.at(-1).state, 'ended');
});

test('unconfigured selected service uses a natural English voice instead of Albert', async () => {
    const f = setup({ remote: false });
    assert.equal(await f.speak(), true);
    assert.equal(f.calls[0].voice.name, 'English US Natural');
    assert.equal(f.statuses.at(-1).source, 'device');
    assert.equal(f.statuses.at(-1).fallbackReason, 'not_configured');
    assert.equal(f.audio.describeTtsTarget().configured, false, 'empty custom URL must not use a different service');
});

test('settings form URL follows the same remote, local and custom routing as playback', () => {
    const f = setup();
    f.setSettings({ tts: { use: 'remote', baseUrl: 'https://legacy.test', baseUrlRemote: 'https://selected.test' } });
    assert.equal(f.audio.getTtsServiceBaseUrl(), 'https://selected.test');
    assert.equal(f.audio.describeSpeechTarget().host, 'selected.test');
    f.setSettings({ tts: { use: 'local', baseUrlLocal: 'http://127.0.0.1:9000' } });
    assert.equal(f.audio.getTtsServiceBaseUrl(), 'http://127.0.0.1:9000');
    assert.equal(f.audio.describeSpeechTarget().host, '127.0.0.1:9000');
    f.setSettings({ tts: { use: 'custom', baseUrlCustom: '' } });
    assert.equal(f.audio.getTtsServiceBaseUrl(), '');
    assert.equal(f.audio.describeSpeechTarget().source, 'device');
});

test('explicit device voice and device-only mode are respected without a service request', async () => {
    const f = setup(); f.setSettings({ tts: { deviceVoiceURI: 'Albert' } });
    assert.equal(await f.speak({ forceLocal: true }), true);
    assert.equal(f.calls[0].voice.name, 'Albert');
    assert.equal(f.el.src, '');
    assert.equal(f.statuses.at(-1).fallbackReason, '');
});

test('automatic device voice follows the English accent and never picks the Chinese default', async () => {
    const f = setup({ remote: false }); f.setSettings({ reading: { englishVariant: 'en-GB' } });
    await f.speak(); assert.equal(f.calls[0].voice.name, 'Daniel');
    assert.equal(f.calls[0].lang, 'en-GB');
});

test('service rejection reports fallback and the actual device voice, never remote success', async () => {
    const f = setup(); const pending = f.speak(); f.reject(new Error('unavailable'));
    assert.equal(await pending, true);
    assert.equal(f.statuses.at(-1).source, 'device');
    assert.equal(f.statuses.at(-1).voice, 'English US Natural');
    assert.equal(f.statuses.at(-1).fallbackReason, 'service_unavailable');
    assert.equal(f.statuses.at(-1).targetHost, 'speech.test');
    assert.equal(f.statuses.some((event) => event.source === 'remote' && event.state === 'playing'), false);
});

test('decode failure falls back only once even when play() rejects afterwards', async () => {
    const f = setup(); const pending = f.speak(); f.el.error = { code: 3 }; f.el.onerror(); f.reject(new Error('late'));
    assert.equal(await pending, true); await Promise.resolve();
    assert.equal(f.calls.length, 1); assert.equal(f.statuses.at(-1).fallbackReason, 'decode_failed');
});

test('a service which never starts times out and clearly reports device fallback', async () => {
    const f = setup(); const pending = f.speak({ timeoutMs: 15 });
    assert.equal(await pending, true); assert.equal(f.statuses.at(-1).fallbackReason, 'timeout');
    assert.equal(f.calls.length, 1);
});

test('stop releases a pending request and prevents late rejection from starting device speech', async () => {
    const f = setup(); const pending = f.speak(); f.audio.stopCurrentAudio();
    assert.equal(await pending, false); f.reject(new Error('late')); await Promise.resolve();
    assert.equal(f.calls.length, 0); assert.equal(f.audio.getActiveAudioOwner(), '');
});

test('late success from a stopped request cannot change the new playback state', async () => {
    const f = setup(); const pending = f.speak(); f.audio.stopCurrentAudio();
    await f.speak({ forceLocal: true }); const count = f.statuses.length;
    f.resolve(); await Promise.resolve(); assert.equal(await pending, false);
    assert.equal(f.statuses.length, count); assert.equal(f.statuses.at(-1).source, 'device');
});

test('blocked remote audio is identified without reporting the fallback as service success', async () => {
    const f = setup(); const pending = f.speak(); f.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' }));
    await pending; assert.equal(f.statuses.at(-1).fallbackReason, 'playback_blocked');
});

test('failure of both service and device returns one clear error and false', async () => {
    const f = setup({ speechAvailable: false }); const pending = f.speak(); f.reject(new Error('unavailable'));
    assert.equal(await pending, false); assert.equal(f.errors.length, 1);
    assert.equal(f.statuses.filter((event) => event.state === 'error').length, 1);
    assert.equal(f.statuses.at(-1).source, 'device');
});

test('status never exposes URL credentials or query secrets', async () => {
    const f = setup(); f.setSettings({ tts: { baseUrlCustom: 'https://fixture-user:fixture-key@speech.test/private-path?secret=query' } });
    const pending = f.speak(); f.el.onplaying(); await pending;
    const json = JSON.stringify(f.statuses);
    const request = new URL(f.el.src);
    for (const secret of [request.username, request[['pass', 'word'].join('')], request.pathname, request.searchParams.get('api_key')]) assert.ok(secret && !json.includes(secret));
    f.audio.stopCurrentAudio();
});
