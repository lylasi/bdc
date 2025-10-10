import * as state from './state.js';
import { TTS_CONFIG } from '../ai-config.js';
import { loadGlobalSettings, loadGlobalSecrets } from './settings.js';

// =================================
// 音频播放管理 (Web Audio & TTS)
// =================================

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
 * 這包括 Web Audio API 的 source 和全局的 HTML Audio 元素。
 */
export function stopCurrentAudio() {
    // 停止 Web Audio API 音頻源
    if (state.audioSource) {
        state.audioSource.onended = null; // 停止時取消回調
        state.audioSource.stop();
        state.setAudioSource(null);
    }
    
    // 停止 HTML Audio 元素
    if (state.globalAudioElement && !state.globalAudioElement.paused) {
        state.globalAudioElement.onended = null;
        state.globalAudioElement.onerror = null;
        state.globalAudioElement.pause();
        state.globalAudioElement.currentTime = 0;
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
    const a = document.createElement('a');
    a.href = url;
    a.rel = 'noopener';
    a.target = '_blank'; // 確保在新分頁處理跨源下載，避免破壞當前單頁應用
    try { a.download = filename; } catch (_) { /* 某些瀏覽器會忽略跨源檔名 */ }
    document.body.appendChild(a);
    a.click();
    // 立即清理 DOM（不需要 URL.revokeObjectURL，因為未建立 blob: URL）
    setTimeout(() => a.remove(), 0);
}

/**
 * 使用 TTS 服務朗讀指定的文本。
 * @param {string} text - 要朗讀的文本。
 * @param {string} langOrVoice - 語言代碼或 TTS_CONFIG 中的 voice key。
 * @param {number} speed - 語速調整值。
 * @param {function} onStart - 播放開始時的回調函數。
 * @param {function} onEnd - 播放結束時的回調函數。
 */
export async function speakText(text, langOrVoice = 'english', speed = 0, onStart, onEnd) {
    stopCurrentAudio();

    const s = loadGlobalSettings();
    const sec = loadGlobalSecrets();
    const baseUrl = getEffectiveBaseUrl(s);
    const apiKey = (sec?.ttsApiKey && String(sec.ttsApiKey).trim()) || TTS_CONFIG.apiKey;
    const voice = resolveVoiceId(langOrVoice, s) || TTS_CONFIG.voices.english;
    const url = `${baseUrl}/tts?t=${encodeURIComponent(text)}&v=${encodeURIComponent(voice)}&r=${speed}&api_key=${encodeURIComponent(apiKey)}`;

    try {
        state.globalAudioElement.src = url;
        state.globalAudioElement.load();
        
        state.globalAudioElement.onloadstart = () => {
            if (onStart) onStart();
        };
        
        state.globalAudioElement.onended = () => {
            state.globalAudioElement.onended = null;
            state.globalAudioElement.onerror = null;
            if (!state.isDictationPaused && onEnd) onEnd();
        };
        
        state.globalAudioElement.onerror = (error) => {
            state.globalAudioElement.onended = null;
            state.globalAudioElement.onerror = null;
            console.error('音頻播放錯誤:', error);
            alert('無法播放語音，請檢查網絡連接或TTS服務。');
            if (!state.isDictationPaused && onEnd) onEnd();
        };
        
        await state.globalAudioElement.play();
        return true;
    } catch (error) {
        if (error.name === 'AbortError') {
            console.log('Audio playback was aborted, which is expected on pause/stop.');
        } else {
            console.error('播放音頻時出錯:', error);
            if (error.name === 'NotAllowedError') {
                alert('音頻播放被阻止，請允許該網站播放音頻。');
            } else {
                alert('無法播放語音，請稍後再試。');
            }
        }
        if (!state.isDictationPaused && onEnd) onEnd();
        return false;
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
