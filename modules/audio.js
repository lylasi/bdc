import * as state from './state.js';
import { TTS_CONFIG } from '../ai-config.js';
import { loadGlobalSettings, loadGlobalSecrets } from './settings.js';

// =================================
// 音频播放管理 (Web Audio & TTS)
// =================================

// 目前佔用音訊播放的模組（文章朗讀、單詞發音、聽寫…）。
// 只有 owner 真正更換時才會發出中斷事件；停止本身不發事件，避免呼叫端誤判。
let activeAudioOwner = '';

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

/** 遠端 TTS 是否已設定（未設定時直接使用系統語音，避免討厭的錯誤彈窗） */
export function isRemoteTtsConfigured() {
    const url = getEffectiveBaseUrl(loadGlobalSettings());
    if (!url || typeof url !== 'string') return false;
    let host = url;
    try { host = new URL(url, window.location.href).hostname; } catch (_) { /* 保持原字串 */ }
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
    const url = getEffectiveBaseUrl(loadGlobalSettings());
    const configured = isRemoteTtsConfigured();
    let host = '';
    if (url && typeof url === 'string') {
        try {
            const parsed = new URL(url, window.location.href);
            host = parsed.host || parsed.hostname || '';
        } catch (_) {
            // 非絕對網址（例如只填主機名）時退回原字串，仍不帶查詢參數。
            host = String(url).split(/[/?#]/)[0] || '';
        }
    }
    return { configured, host };
}

/** 依語系提示挑選系統語音 */
function pickLocalVoice(langOrVoice) {
    const synth = window.speechSynthesis;
    if (!synth || typeof synth.getVoices !== 'function') return null;
    const voices = synth.getVoices() || [];
    if (!voices.length) return null;
    const raw = String(langOrVoice || '').toLowerCase();
    let wanted = 'en';
    if (/cantonese|yue|zh-hk|zh_hk|粵|粤/.test(raw)) wanted = 'zh-hk';
    else if (/chinese|mandarin|zh|中文|普通/.test(raw)) wanted = 'zh';
    const exact = voices.find(v => (v.lang || '').toLowerCase() === wanted);
    if (exact) return exact;
    const byPrefix = voices.find(v => (v.lang || '').toLowerCase().startsWith(wanted.slice(0, 2)));
    return byPrefix || voices[0];
}

/** 以系統語音朗讀（離線可用；音質依裝置而定） */
function speakWithLocalVoice(text, langOrVoice, speed, onStart, onEnd, options = {}) {
    const synth = window.speechSynthesis;
    const UtteranceCtor = window.SpeechSynthesisUtterance;
    const plainText = text == null ? '' : String(text);
    const hasStatusConsumer = typeof options.onStatus === 'function' || typeof options.onError === 'function';
    // 有 status／error 回呼的呼叫端（文章朗讀）要能明確停止；
    // 舊呼叫端（聽寫）沒有這些回呼，保留原本「失敗也走 onEnd」的相容行為。
    const notifyFailure = (error) => {
        if (typeof options.onStatus === 'function') {
            try { options.onStatus({ state: 'error', error }); } catch (_) { /* noop */ }
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
        const voice = pickLocalVoice(langOrVoice);
        if (voice) {
            utterance.voice = voice;
            utterance.lang = voice.lang;
        } else {
            const raw = String(langOrVoice || '').toLowerCase();
            utterance.lang = /cantonese|yue|zh-hk/.test(raw)
                ? 'zh-HK'
                : (/chinese|mandarin|zh/.test(raw) ? 'zh-CN' : 'en-US');
        }
        const numericSpeed = Number(speed) || 0;
        utterance.rate = Math.min(2, Math.max(0.5, 1 + numericSpeed / 100));
        utterance.onstart = () => {
            if (seq !== localSpeechSeq) return;
            if (typeof options.onStatus === 'function') {
                try { options.onStatus({ state: 'playing' }); } catch (_) { /* noop */ }
            }
            if (onStart) onStart();
        };
        utterance.onend = () => {
            if (seq !== localSpeechSeq) return;
            if (typeof options.onStatus === 'function') {
                try { options.onStatus({ state: 'ended' }); } catch (_) { /* noop */ }
            }
            if (!state.isDictationPaused && onEnd) onEnd();
        };
        utterance.onerror = (event) => {
            if (seq !== localSpeechSeq) return;
            console.warn('本機語音播放失敗:', event?.error || event);
            notifyFailure(event?.error || event || new Error('local_speech_error'));
        };
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
    const apiKey = (sec?.ttsApiKey && String(sec.ttsApiKey).trim()) || TTS_CONFIG.apiKey;
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
    if (previousOwner && previousOwner !== owner) {
        dispatchAudioInterrupted(previousOwner, owner);
    }

    let errorReported = false;
    const notifyStatus = (status) => {
        if (status && status.state === 'error') errorReported = true;
        if (typeof opts.onStatus === 'function') {
            try { opts.onStatus(status); } catch (_) { /* 呼叫端錯誤不影響音訊 */ }
        }
    };
    const reportError = (error) => {
        if (errorReported) return;
        notifyStatus({ state: 'error', error });
        if (typeof opts.onError === 'function') {
            try { opts.onError(error); } catch (_) { /* noop */ }
        }
    };
    const localOptions = { ...opts, onStatus: notifyStatus };

    // 未設定遠端 TTS（或設定仍為範例網址）時，直接使用系統語音，確保聽寫有聲音
    if (!isRemoteTtsConfigured()) {
        return speakWithLocalVoice(text, langOrVoice, speed, onStart, onEnd, localOptions);
    }

    const s = loadGlobalSettings();
    const sec = loadGlobalSecrets();
    const baseUrl = getEffectiveBaseUrl(s);
    const apiKey = (sec?.ttsApiKey && String(sec.ttsApiKey).trim()) || TTS_CONFIG.apiKey;
    const voice = resolveVoiceId(langOrVoice, s) || TTS_CONFIG.voices.english;
    const url = `${baseUrl}/tts?t=${encodeURIComponent(text)}&v=${encodeURIComponent(voice)}&r=${speed}&api_key=${encodeURIComponent(apiKey)}`;
    let fallbackResult = null;
    let started = false;

    const markStarted = () => {
        if (started) return;
        started = true;
        notifyStatus({ state: 'playing' });
        if (onStart) onStart();
    };
    const clearHandlers = () => {
        const el = state.globalAudioElement;
        if (!el) return;
        el.onended = null;
        el.onerror = null;
        el.onloadstart = null;
        el.onplaying = null;
        el.oncanplay = null;
        el.onwaiting = null;
    };
    const fallbackToLocal = () => {
        if (fallbackResult !== null) return fallbackResult;
        clearHandlers();
        fallbackResult = speakWithLocalVoice(text, langOrVoice, speed, onStart, onEnd, localOptions);
        return fallbackResult;
    };

    try {
        const el = state.globalAudioElement;
        // 先綁事件再設定 src，避免 loadstart 在 handler 掛上之前就觸發。
        el.onloadstart = () => notifyStatus({ state: 'loading' });
        el.onplaying = () => markStarted();
        el.oncanplay = () => markStarted();
        el.onwaiting = () => notifyStatus({ state: 'loading' });
        el.onended = () => {
            clearHandlers();
            notifyStatus({ state: 'ended' });
            if (!state.isDictationPaused && onEnd) onEnd();
        };
        el.onerror = (error) => {
            clearHandlers();
            console.warn('遠端 TTS 播放失敗，改用系統語音:', error?.message || error);
            const ok = fallbackToLocal();
            if (!ok) reportError(error || new Error('remote_tts_failed'));
        };
        el.src = url;
        el.load();
        await el.play();
        // 少數瀏覽器 play() resolve 後才補 onplaying；這裡保証 onStart 一定會來。
        markStarted();
        return true;
    } catch (error) {
        if (error?.name === 'AbortError') {
            // 暫停 / 停止 / 切換單詞時主動中斷播放，屬預期行為，不可觸發 onEnd（避免流程多走一格）
            console.log('Audio playback was aborted, which is expected on pause/stop.');
            return false;
        }
        console.warn('遠端 TTS 無法播放，改用系統語音:', error?.name || error);
        const ok = fallbackToLocal();
        if (!ok) reportError(error || new Error('remote_tts_failed'));
        return ok;
    }
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
    return TTS_CONFIG.voices[key] || TTS_CONFIG.voices.english;
}

function getEffectiveBaseUrl(s) {
    const sel = (s?.tts && s.tts.use) || '';
    const r = ((s?.tts && s.tts.baseUrlRemote && String(s.tts.baseUrlRemote).trim()) || (TTS_CONFIG.baseUrlRemote || TTS_CONFIG.baseUrl || '')).trim();
    const l = ((s?.tts && s.tts.baseUrlLocal && String(s.tts.baseUrlLocal).trim()) || (TTS_CONFIG.baseUrlLocal || '')).trim();
    const c = (s?.tts && s.tts.baseUrlCustom && String(s.tts.baseUrlCustom).trim()) || '';
    if (sel === 'custom' && c) return c;
    if (sel === 'local' && l) return l;
    if (sel === 'remote' && r) return r;
    // backward compatibility
    return (s?.tts?.baseUrl && String(s.tts.baseUrl).trim()) || r || TTS_CONFIG.baseUrl;
}
