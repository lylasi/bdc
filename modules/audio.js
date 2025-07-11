import * as state from './state.js';
import { TTS_CONFIG } from '../ai-config.js';

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
 * 使用 TTS 服務朗讀指定的文本。
 * @param {string} text - 要朗讀的文本。
 * @param {string} lang - 語言代碼 (e.g., 'en-US', 'zh-TW')。
 * @param {number} speed - 語速調整值。
 * @param {function} onStart - 播放開始時的回調函數。
 * @param {function} onEnd - 播放結束時的回調函數。
 */
export async function speakText(text, lang = 'en-US', speed = 0, onStart, onEnd) {
    stopCurrentAudio();

    const voice = lang.startsWith('zh') ? TTS_CONFIG.voices.chinese : TTS_CONFIG.voices.english;
    const url = `${TTS_CONFIG.baseUrl}/tts?t=${encodeURIComponent(text)}&v=${voice}&r=${speed}&api_key=${TTS_CONFIG.apiKey}`;

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
    }
}