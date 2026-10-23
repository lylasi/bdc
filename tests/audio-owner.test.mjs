/**
 * 音訊 owner／中斷通知單元測試（P0-T1 載具）。
 *
 * 真正的音訊中斷行為屬 Phase 2（P2-T1）；在 `getActiveAudioOwner` 尚未實作前，
 * 這個測試會 skip，不阻塞 Phase 1 的驗收。Phase 2 實作後會自動開始檢查：
 *   - speakText 更換 owner 時，舊 owner 會收到 bdc:audio-interrupted
 *   - 同一個 owner 重播不觸發中斷事件
 *   - stopCurrentAudio 會清掉 owner
 *
 * 載具本身必須是真的事件目標：`document.addEventListener` 註冊的監聽器要能被
 * `document.dispatchEvent` 收到（下方「事件 stub 自測」任何時候都會跑）。
 *
 * 用法：node --test tests/audio-owner.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * 可註冊／可派送的事件目標 stub。
 * 每個 target 各自維護 listener 集合，dispatchEvent 會同步呼叫已註冊的監聽器。
 */
function createEventTarget(extra = {}) {
    const listeners = new Map();
    return Object.assign({
        addEventListener(type, handler) {
            if (typeof handler !== 'function') return;
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type).add(handler);
        },
        removeEventListener(type, handler) {
            listeners.get(type)?.delete(handler);
        },
        dispatchEvent(event) {
            const set = listeners.get(event?.type);
            if (set) {
                for (const handler of Array.from(set)) handler(event);
            }
            return true;
        },
        __listeners: listeners
    }, extra);
}

// modules/state.js 在 import 時就 new Audio()；先補最小瀏覽器 stub，
// 讓這個單元測試能在 node 環境載入共用音訊層。
function installBrowserStubs() {
    globalThis.Audio = class FakeAudio {
        constructor() {
            this.src = '';
            this.paused = true;
            this.currentTime = 0;
            this.onended = null;
            this.onerror = null;
            this.onloadstart = null;
            this.onplaying = null;
            this.onwaiting = null;
        }
        load() {}
        play() { this.paused = false; return Promise.resolve(); }
        pause() { this.paused = true; }
    };
    globalThis.CustomEvent = class CustomEvent {
        constructor(type, init = {}) {
            this.type = type;
            this.detail = init.detail || null;
        }
    };
    globalThis.document = createEventTarget({
        createElement: () => createEventTarget({
            style: {},
            setAttribute() {},
            appendChild() {},
            remove() {},
            click() {}
        }),
        body: createEventTarget({ appendChild() {}, removeChild() {} })
    });
    globalThis.localStorage = {
        store: new Map(),
        getItem(key) { return this.store.has(key) ? this.store.get(key) : null; },
        setItem(key, value) { this.store.set(String(key), String(value)); },
        removeItem(key) { this.store.delete(String(key)); }
    };
    // 固定指向不可達的本機位址：單元測試不得依賴開發機 ai-config.js 的真實 TTS。
    globalThis.localStorage.setItem('pen_global_settings', JSON.stringify({
        tts: {
            use: 'remote',
            baseUrl: 'http://127.0.0.1:9/tts',
            baseUrlRemote: 'http://127.0.0.1:9/tts',
            baseUrlLocal: ''
        }
    }));
    globalThis.window = createEventTarget({
        speechSynthesis: {
            speak() {},
            cancel() {},
            getVoices: () => []
        },
        location: { href: 'http://127.0.0.1:8313/' }
    });
    const globalTarget = createEventTarget();
    globalThis.addEventListener = globalTarget.addEventListener;
    globalThis.removeEventListener = globalTarget.removeEventListener;
    globalThis.dispatchEvent = globalTarget.dispatchEvent;
}

installBrowserStubs();

const audio = await import('../modules/audio.js');
const state = await import('../modules/state.js');

test('事件 stub 本身能註冊與派送', () => {
    const received = [];
    const handler = (event) => received.push(event.detail);
    document.addEventListener('bdc:audio-interrupted', handler);
    document.dispatchEvent(new CustomEvent('bdc:audio-interrupted', { detail: { owner: 'article-reading' } }));
    document.removeEventListener('bdc:audio-interrupted', handler);
    document.dispatchEvent(new CustomEvent('bdc:audio-interrupted', { detail: { owner: 'word-pronunciation' } }));
    assert.deepEqual(received, [{ owner: 'article-reading' }]);
    // window 與 globalThis 也是獨立的事件目標，不會互相污染。
    const globalReceived = [];
    const globalHandler = (event) => globalReceived.push(event.detail);
    globalThis.addEventListener('bdc:audio-interrupted', globalHandler);
    globalThis.dispatchEvent(new CustomEvent('bdc:audio-interrupted', { detail: { owner: 'global' } }));
    globalThis.removeEventListener('bdc:audio-interrupted', globalHandler);
    assert.deepEqual(globalReceived, [{ owner: 'global' }]);
    assert.equal(document.__listeners.get('bdc:audio-interrupted')?.size || 0, 0);
});

test('音訊 owner 與中斷通知', async (t) => {
    const events = [];
    document.addEventListener('bdc:audio-interrupted', (event) => events.push(event.detail));

    // 本機語音：owner 更換要通知舊 owner
    audio.speakText('first sentence', 'english', 0, () => {}, () => {}, { owner: 'article-reading' });
    assert.equal(audio.getActiveAudioOwner(), 'article-reading');
    audio.speakText('word', 'english', 0, () => {}, () => {}, { owner: 'word-pronunciation' });
    assert.equal(events.length, 1);
    assert.equal(events[0].owner, 'article-reading');
    assert.equal(events[0].by, 'word-pronunciation');

    // 同 owner 重播不應 trigger 中斷事件
    audio.speakText('same owner again', 'english', 0, () => {}, () => {}, { owner: 'word-pronunciation' });
    assert.equal(events.length, 1);

    // stopCurrentAudio 清掉 owner
    audio.stopCurrentAudio();
    assert.equal(audio.getActiveAudioOwner(), '');

    // 遠端播放失敗且本機語音也不可用：要回報 error，不能卡在播放中
    state.globalAudioElement.play = () => Promise.reject(new Error('remote down'));
    state.globalAudioElement.load = () => {};
    const originalUtterance = window.SpeechSynthesisUtterance;
    window.SpeechSynthesisUtterance = undefined;
    const statuses = [];
    const errors = [];
    const ok = await audio.speakText('fallback target', 'english', 0, () => {}, () => {}, {
        owner: 'article-reading',
        onStatus: (status) => statuses.push(status),
        onError: (error) => errors.push(error)
    });
    window.SpeechSynthesisUtterance = originalUtterance;
    assert.equal(ok, false);
    assert.ok(statuses.some((status) => status.state === 'error'), JSON.stringify(statuses));
    assert.equal(errors.length, 1);
});
