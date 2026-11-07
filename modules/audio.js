import * as state from './state.js';
import { TTS_CONFIG } from '../ai-config.js';
import { loadGlobalSettings, loadGlobalSecrets } from './settings.js';

// =================================
// 音频播放管理 (Web Audio & TTS)
// =================================

// 目前佔用音訊播放的模組（文章朗讀、單詞發音、聽寫…）。
// 只有 owner 真正更換時才會發出中斷事件；停止本身不發事件，避免呼叫端誤判。
let activeAudioOwner = '';
let playbackSequence = 0;
let cancelRemotePlayback = null;

export function getActiveAudioOwner() {
    return activeAudioOwner;
}

/**
 * 解鎖音頻上下文，以解決在iOS等移動設備上的自動播放限制。
 * 首次用戶交互時應調用此函數。
 */
export function unlockAudioContext() {
    if (state.isAudioContextUnlocked || (window.AudioContext === undefined && window.webkitAudioContext === undefined)) {
        return;
    }
    
    const context = new (window.AudioContext || window.webkitAudioContext)();
    state.setAudioContext(context);
    
    // 在iOS上，AudioContext創建後是"suspended"狀態，需要用戶操作來"resume"
    const silentBuffer = context.createBuffer(1, 1, 22050);
    const source = context.createBufferSource();
    source.buffer = silentBuffer;
    source.connect(context.destination);
    source.start(0);
    
    if (context.state === 'suspended') {
        context.resume();
    }
    
    state.setIsAudioContextUnlocked(true);
    console.log('AudioContext is unlocked and ready.');
    
    // 成功解鎖後，移除監聽器
    document.body.removeEventListener('click', unlockAudioContext, true);
    document.body.removeEventListener('touchend', unlockAudioContext, true);
}

/**
 * 停止當前所有正在播放的音頻源。
 * 這包括 Web Audio API 的 source、全局的 HTML Audio 元素，以及本機語音合成。
 */
export function stopCurrentAudio(options = {}) {
    playbackSequence += 1;
    const cancel = cancelRemotePlayback;
    cancelRemotePlayback = null;
    cancel?.();
    // 停止即代表沒有 owner；不由這裡主動派送中斷事件，避免「自己停止」被當成被別人打斷。
    activeAudioOwner = '';
    // 停止 Web Audio API 音頻源
    if (state.audioSource) {
        state.audioSource.onended = null; // 停止時取消回調
        state.audioSource.stop();
        state.setAudioSource(null);
    }
    
    // 停止 HTML Audio 元素
    if (state.globalAudioElement) {
        const el = state.globalAudioElement;
        el.onended = null;
        el.onerror = null;
        el.onloadstart = null;
        el.onplaying = null;
        el.oncanplay = null;
        el.onwaiting = null;
        if (!el.paused) {
            el.pause();
            el.currentTime = 0;
        }
    }

    // 停止本機語音合成（序號遞增讓舊回調自動失效）
    localSpeechSeq++;
    if (window.speechSynthesis) {
        try { window.speechSynthesis.cancel(); } catch (_) { /* 忽略不支援的環境 */ }
    }
}

// ---------------------------------
// 本機語音（Web Speech API）後備方案
// ---------------------------------

let localSpeechSeq = 0;

/** Selected service URL for local settings forms; never include it in playback status. */
export function getTtsServiceBaseUrl() {
    return String(getEffectiveBaseUrl(loadGlobalSettings()) || '').trim();
}

/** 遠端 TTS 是否已設定（未設定時直接使用系統語音，避免討厭的錯誤彈窗） */
export function isRemoteTtsConfigured() {
    const url = getEffectiveBaseUrl(loadGlobalSettings());
    if (!url || typeof url !== 'string') return false;
    let host = '';
    try {
        const parsed = new URL(url, window.location.href);
        if (!/^https?:$/.test(parsed.protocol)) return false;
        host = parsed.hostname;
    } catch (_) { return false; }
    if (!host) return false;
    if (/(^|\.)example\.(com|org|net)$/i.test(host)) return false;
    if (/your-tts|yourtts|placeholder/i.test(url)) return false;
    return true;
}

/**
 * 回報目前 TTS 目標，供 UI 說明下載能力與服務來源。
 * 只回傳 http(s) host，不含路徑、查詢字串或 api_key。
 * @returns {{configured: boolean, host: string}}
 */
export function describeTtsTarget() {
    const { configured, host } = describeSpeechTarget();
    return { configured, host };
}

export function describeSpeechTarget(langOrVoice = 'english', options = {}) {
    const url = getEffectiveBaseUrl(loadGlobalSettings());
    const configured = isRemoteTtsConfigured();
    let host = '';
    if (url && typeof url === 'string') {
        try {
            const parsed = new URL(url, window.location.href);
            if (/^https?:$/.test(parsed.protocol)) host = parsed.host;
        } catch (_) {
            host = '';
        }
    }
    const source = configured && !options.forceLocal ? 'remote' : 'device';
    const voice = source === 'remote' ? null : pickLocalVoice(langOrVoice);
    return { configured, host: configured ? host : '', source,
        voice: source === 'remote' ? resolveVoiceId(langOrVoice) : voice?.name || '',
        voiceURI: voice?.voiceURI || '', lang: voice?.lang || localLanguage(langOrVoice) };
}

function localLanguage(langOrVoice) {
    const raw = String(langOrVoice || '').toLowerCase();
    if (/cantonese|yue|zh-hk|zh_hk|粵|粤/.test(raw)) return 'zh-HK';
    if (/chinese|mandarin|zh|中文|普通/.test(raw)) return 'zh-CN';
    const locale = raw.match(/^en-(us|gb|au|ie|za)/i)?.[0];
    return locale || loadGlobalSettings()?.reading?.englishVariant || 'en-GB';
}

export function getLocalSpeechVoices(langOrVoice = 'english') {
    const wanted = localLanguage(langOrVoice).slice(0, 2).toLowerCase();
    return (window.speechSynthesis?.getVoices?.() || [])
        .filter((voice) => String(voice.lang || '').slice(0, 2).toLowerCase() === wanted);
}

/** 優先明確選擇、語系及自然語音；不再直接使用清單首個趣味音色。 */
function pickLocalVoice(langOrVoice) {
    const voices = getLocalSpeechVoices(langOrVoice);
    if (!voices.length) return null;
    const wanted = localLanguage(langOrVoice).toLowerCase();
    const selected = loadGlobalSettings()?.tts?.deviceVoiceURI;
    const explicit = selected && voices.find((voice) => voice.voiceURI === selected || voice.name === selected);
    if (explicit && wanted.startsWith('en')) return explicit;
    const novelty = /^(albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|junior|organ|pipe organ|princess|ralph|trinoids|whisper|wobble|zarvox|fred)$/i;
    const natural = /natural|enhanced|premium|neural|google|samantha|alex|daniel|karen|moira|tessa|serena|ava|zoe/i;
    const score = (voice) => (novelty.test(voice.name || '') ? -1000 : 0)
        + (String(voice.lang).toLowerCase() === wanted ? 250 : 0)
        + (voice.default ? 200 : 0) + (natural.test(voice.name || '') ? 100 : 0)
        + (voice.localService ? 1 : 0);
    return [...voices].sort((a, b) => score(b) - score(a))[0];
}

/** 以系統語音朗讀（離線可用；音質依裝置而定） */
function speakWithLocalVoice(text, langOrVoice, speed, onStart, onEnd, options = {}) {
    const synth = window.speechSynthesis;
    const UtteranceCtor = window.SpeechSynthesisUtterance;
    const plainText = text == null ? '' : String(text);
    const hasStatusConsumer = typeof options.onStatus === 'function' || typeof options.onError === 'function';
    const voice = pickLocalVoice(langOrVoice);
    const metadata = { source: 'device', voice: voice?.name || '', voiceURI: voice?.voiceURI || '',
        lang: voice?.lang || localLanguage(langOrVoice), host: '',
        fallbackReason: options.fallbackReason || '', targetHost: options.targetHost || '' };
    const status = (state, error) => options.onStatus?.({ ...metadata, state, ...(error ? { error } : {}) });
    // 有 status／error 回呼的呼叫端（文章朗讀）要能明確停止；
    // 舊呼叫端（聽寫）沒有這些回呼，保留原本「失敗也走 onEnd」的相容行為。
    const notifyFailure = (error) => {
        if (typeof options.onStatus === 'function') {
            try { status('error', error); } catch (_) { /* noop */ }
        }
        if (typeof options.onError === 'function') {
            try { options.onError(error); } catch (_) { /* noop */ }
        }
        if (!hasStatusConsumer && !state.isDictationPaused && onEnd) onEnd();
    };

    if (!plainText) return false;
    if (!synth || !UtteranceCtor) {
        notifyFailure(new Error('local_speech_unavailable'));
        return false;
    }

    const seq = ++localSpeechSeq;
    try {
        synth.cancel();
        const utterance = new UtteranceCtor(plainText);
        if (voice) {
            utterance.voice = voice;
            utterance.lang = voice.lang;
        } else {
            utterance.lang = localLanguage(langOrVoice);
        }
        const numericSpeed = Number(speed) || 0;
        utterance.rate = Math.min(2, Math.max(0.5, 1 + numericSpeed / 100));
        utterance.onstart = () => {
            if (seq !== localSpeechSeq) return;
            if (typeof options.onStatus === 'function') {
                try { status('playing'); } catch (_) { /* noop */ }
            }
            if (onStart) onStart();
        };
        utterance.onend = () => {
            if (seq !== localSpeechSeq) return;
            if (typeof options.onStatus === 'function') {
                try { status('ended'); } catch (_) { /* noop */ }
            }
            if (!state.isDictationPaused && onEnd) onEnd();
        };
        utterance.onerror = (event) => {
            if (seq !== localSpeechSeq) return;
            console.warn('本機語音播放失敗:', event?.error || event);
            notifyFailure(event?.error || event || new Error('local_speech_error'));
        };
        status('loading');
        synth.speak(utterance);
        return true;
    } catch (error) {
        console.error('本機語音播放出錯:', error);
        notifyFailure(error);
        return false;
    }
}

/**
 * 構造 TTS 下載 URL（與播放相同邏輯）。
 */
export function buildTTSUrl(text, langOrVoice = 'english', speed = 0) {
    const s = loadGlobalSettings();
    const sec = loadGlobalSecrets();
    const baseUrl = getEffectiveBaseUrl(s);
    const apiKey = sec?.ttsApiKey !== undefined ? String(sec.ttsApiKey).trim() : TTS_CONFIG.apiKey || '';
    const voice = resolveVoiceId(langOrVoice, s) || TTS_CONFIG.voices.english;
    // 注意：保持與 speakText 同步
    return `${baseUrl}/tts?t=${encodeURIComponent(text)}&v=${encodeURIComponent(voice)}&r=${speed}&api_key=${encodeURIComponent(apiKey)}`;
}

/**
 * 下載指定文本的 TTS 音頻。
 * 回傳 { ok, url } 或 { ok: false, error }；呼叫端只可使用 ok 決定提示，
 * 不得把含 api_key 的 url 寫進 console／toast／DOM 文字。
 */
export async function downloadTextAsAudio(text, langOrVoice = 'english', speed = 0, filename = 'audio.mp3', options = {}) {
    // 支援 p(音高) / s(風格) / d(下載)
    const url = (() => {
        let u = buildTTSUrl(text, langOrVoice, speed);
        const params = [];
        if (options && typeof options.pitch === 'number') params.push(`p=${encodeURIComponent(String(options.pitch))}`);
        if (options && typeof options.style === 'string' && options.style) params.push(`s=${encodeURIComponent(options.style)}`);
        // 強制要求服務端走下載回應，以避開跨源 fetch 的 CORS 讀取限制
        if (!options || options.download === true) params.push('d=true');
        if (params.length) u += `&${params.join('&')}`;
        return u;
    })();

    // 注意：許多第三方 TTS 服務未開啟 CORS，
    // 用 fetch(arrayBuffer) 會因為跨源而失敗（TypeError: Failed to fetch）。
    // 因此改為直接以 <a href> 觸發下載，交給瀏覽器處理跨源檔案。
    // 若服務端回覆 Content-Disposition: attachment，將直接下載；
    // 部分瀏覽器會忽略跨源的 a.download 檔名，但仍能下載成功。
    try {
        const a = document.createElement('a');
        a.href = url;
        a.rel = 'noopener';
        a.target = '_blank'; // 確保在新分頁處理跨源下載，避免破壞當前單頁應用
        try { a.download = filename; } catch (_) { /* 某些瀏覽器會忽略跨源檔名 */ }
        document.body.appendChild(a);
        a.click();
        // 立即清理 DOM（不需要 URL.revokeObjectURL，因為未建立 blob: URL）
        setTimeout(() => a.remove(), 0);
    } catch (error) {
        // 只回報可辨識錯誤；不要把 url（含 api_key）放進訊息。
        return { ok: false, error: (error && error.message) ? String(error.message) : 'download_failed' };
    }
    // 只代表「已把連結交給瀏覽器」，是否完成由瀏覽器與 TTS 服務決定。
    return { ok: true, url };
}

function dispatchAudioInterrupted(owner, by) {
    try {
        if (typeof document !== 'undefined' && typeof CustomEvent === 'function') {
            document.dispatchEvent(new CustomEvent('bdc:audio-interrupted', {
                detail: { owner, by }
            }));
        }
    } catch (_) { /* 沒有 DOM 的環境（單元測試）不影響播放 */ }
}

/**
 * 使用 TTS 服務朗讀指定的文本。
 * @param {string} text - 要朗讀的文本。
 * @param {string} langOrVoice - 語言代碼或 TTS_CONFIG 中的 voice key。
 * @param {number} speed - 語速調整值。
 * @param {function} onStart - 真正開始播放時的回調函數（loading 不觸發）。
 * @param {function} onEnd - 播放結束時的回調函數。
 * @param {{owner?: string, onStatus?: function, onError?: function}} options
 *        owner 預設 'default'；更換 owner 時舊 owner 會收到 bdc:audio-interrupted。
 */
export async function speakText(text, langOrVoice = 'english', speed = 0, onStart, onEnd, options = {}) {
    const opts = (options && typeof options === 'object') ? options : {};
    const owner = opts.owner || 'default';
    const previousOwner = activeAudioOwner;
    stopCurrentAudio({ reason: 'replaced-by-speak' });
    activeAudioOwner = owner;
    const sequence = playbackSequence;
    const current = () => sequence === playbackSequence;
    if (previousOwner && previousOwner !== owner) dispatchAudioInterrupted(previousOwner, owner);

    let errorReported = false;
    const notifyStatus = (status) => {
        if (!current()) return;
        if (status?.state === 'error') errorReported = true;
        try { opts.onStatus?.(status); } catch (_) { /* consumer */ }
    };
    const plan = describeSpeechTarget(langOrVoice, opts);
    const local = (fallbackReason) => speakWithLocalVoice(text, langOrVoice, speed, onStart, onEnd, {
        ...opts, fallbackReason, targetHost: plan.host, onStatus: notifyStatus
    });
    if (opts.forceLocal || !plan.configured) return local(opts.forceLocal ? '' : 'not_configured');

    const settings = loadGlobalSettings();
    const secrets = loadGlobalSecrets();
    const base = String(getEffectiveBaseUrl(settings)).replace(/\/+$/, '');
    const key = String(secrets?.ttsApiKey !== undefined ? secrets.ttsApiKey : TTS_CONFIG.apiKey || '').trim();
    const voice = plan.voice || '';
    const url = `${base}/tts?t=${encodeURIComponent(text)}&v=${encodeURIComponent(voice)}&r=${speed}&api_key=${encodeURIComponent(key)}`;
    const metadata = { source: 'remote', host: plan.host, voice, fallbackReason: '', targetHost: plan.host,
        lang: voice.match(/^[a-z]{2,4}-[a-z]{2}/i)?.[0] || localLanguage(langOrVoice) };
    const el = state.globalAudioElement;
    if (!el) return local('media_unavailable');

    return new Promise((resolve) => {
        let settled = false, started = false, fallbackStarted = false, timer;
        const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
        const handlers = {};
        const cleanup = () => {
            clearTimeout(timer);
            for (const [property, handler] of Object.entries(handlers)) {
                if (el[property] === handler) el[property] = null;
            }
            if (cancelRemotePlayback === cancel) cancelRemotePlayback = null;
        };
        const stopRemote = () => {
            cleanup();
            try { el.pause(); el.removeAttribute?.('src'); el.load?.(); } catch (_) { /* already stopped */ }
        };
        const cancel = () => { stopRemote(); finish(false); };
        const fallback = (reason) => {
            if (!current() || fallbackStarted) return;
            fallbackStarted = true;
            stopRemote();
            const ok = local(reason);
            if (!ok && !errorReported) notifyStatus({ ...metadata, state: 'error', error: new Error(reason) });
            finish(ok);
        };
        const markStarted = () => {
            if (!current() || fallbackStarted || started) return;
            started = true;
            clearTimeout(timer);
            notifyStatus({ ...metadata, state: 'playing' });
            onStart?.();
            finish(true);
        };
        handlers.onloadstart = () => { if (current() && !fallbackStarted) notifyStatus({ ...metadata, state: 'loading' }); };
        handlers.onwaiting = handlers.onloadstart;
        handlers.onplaying = markStarted;
        handlers.onended = () => {
            if (!current() || fallbackStarted) return;
            cleanup();
            notifyStatus({ ...metadata, state: 'ended' });
            finish(true);
            if (!state.isDictationPaused) onEnd?.();
        };
        handlers.onerror = () => fallback(el.error?.code === 3 ? 'decode_failed' : 'audio_load_failed');
        for (const [property, handler] of Object.entries(handlers)) el[property] = handler;
        cancelRemotePlayback = cancel;
        timer = setTimeout(() => fallback('timeout'), Math.max(1, Number(opts.timeoutMs) || 15000));
        notifyStatus({ ...metadata, state: 'loading' });
        try {
            el.src = url;
            el.load();
            Promise.resolve(el.play()).then(markStarted, (error) => {
                if (!current() || fallbackStarted) return;
                fallback(error?.name === 'NotAllowedError' ? 'playback_blocked'
                    : error?.name === 'NotSupportedError' ? 'audio_load_failed' : 'service_unavailable');
            });
        } catch (error) {
            fallback(error?.name === 'NotAllowedError' ? 'playback_blocked' : 'service_unavailable');
        }
    });
}

// ---------------------------------
// Voice resolution
// ---------------------------------

// Map a semantic key or locale to a concrete voice id.
// Supports:
//  - full voice id (e.g., 'en-US-JennyNeural')
//  - semantic keys: 'english', 'cantonese', 'chinese'
//  - locale-style hints: 'en-US', 'en-GB', 'zh-HK', 'zh-CN', 'english-us', 'english-uk'
function resolveVoiceId(langOrVoice, settingsObj) {
    const s = settingsObj || loadGlobalSettings();
    const map = (s?.tts && s.tts.selectedVoices) || {};
    const raw = typeof langOrVoice === 'string' ? langOrVoice.trim() : '';
    if (!raw) return fallbackByKey('english');
    // If caller passes a concrete voice id (locale-prefixed). Accept 2–4 letter language tags like en, zh, yue, wuu.
    if (/^[a-z]{2,4}-[a-z]{2}-/i.test(raw)) return raw;
    const v = raw.toLowerCase();
    // Locale hints
    if (v === 'en-us' || v === 'us' || v === 'english-us' || v === 'american') {
        return map['en-US'] || fallbackByKey('english');
    }
    if (v === 'en-gb' || v === 'gb' || v === 'uk' || v === 'english-uk' || v === 'british') {
        return map['en-GB'] || map['en-US'] || fallbackByKey('english');
    }
    if (v === 'zh-hk' || v === 'yue' || v === 'cantonese' || v === '粤語' || v === '粵語' || v === '廣東話') {
        return map['zh-HK'] || fallbackByKey('cantonese');
    }
    if (v.startsWith('zh') || v === 'mandarin' || v === '普通話' || v === '中文') {
        return map['zh-CN'] || fallbackByKey('chinese');
    }
    if (v === 'english') {
        const pref = (s?.reading && s.reading.englishVariant) || 'en-GB';
        return map[pref] || map['en-US'] || fallbackByKey('english');
    }
    if (v === 'chinese') {
        const pref = (s?.reading && s.reading.chineseVariant) || 'zh-CN';
        return map[pref] || fallbackByKey(pref === 'zh-HK' ? 'cantonese' : 'chinese');
    }
    // default
    return fallbackByKey('english');
}

function fallbackByKey(key) {
    return TTS_CONFIG.voices?.[key] || TTS_CONFIG.voices?.english || '';
}

function getEffectiveBaseUrl(s) {
    const sel = (s?.tts && s.tts.use) || '';
    const r = ((s?.tts && s.tts.baseUrlRemote && String(s.tts.baseUrlRemote).trim()) || (TTS_CONFIG.baseUrlRemote || TTS_CONFIG.baseUrl || '')).trim();
    const l = ((s?.tts && s.tts.baseUrlLocal && String(s.tts.baseUrlLocal).trim()) || (TTS_CONFIG.baseUrlLocal || '')).trim();
    const c = (s?.tts && s.tts.baseUrlCustom && String(s.tts.baseUrlCustom).trim()) || '';
    if (sel === 'custom') return c;
    if (sel === 'local' && l) return l;
    if (sel === 'remote' && r) return r;
    // backward compatibility
    return (s?.tts?.baseUrl && String(s.tts.baseUrl).trim()) || r || TTS_CONFIG.baseUrl;
}
