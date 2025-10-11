// Local-only global settings & secrets (never synced)
// Keys
const SETTINGS_KEY = 'pen_global_settings';
const SECRETS_KEY = 'pen_global_secrets';

const defaults = {
  ai: { apiUrl: '', models: {} }, // request endpoint & per-feature model override
  // tts: baseUrl kept for backward compatibility; prefer baseUrlRemote/baseUrlLocal+use
  tts: {
    baseUrl: '',
    baseUrlRemote: (TTS_CONFIG && (TTS_CONFIG.baseUrlRemote || TTS_CONFIG.baseUrl)) || '',
    baseUrlLocal: (TTS_CONFIG && TTS_CONFIG.baseUrlLocal) || '',
    use: (TTS_CONFIG && TTS_CONFIG.use) || 'remote',
    baseUrlCustom: '',
    selectedVoices: {}
  },
  // global reading preferences
  // translationMask: 是否對「文章詳解」中的中文翻譯加上模糊遮罩（滑鼠移入/按住顯示）
  reading: { englishVariant: 'en-GB', chineseVariant: 'zh-CN', translationMask: true },
  assistant: { enabled: true, stream: true },
  updatedAt: null
};

export function loadGlobalSettings() {
  try { const raw = localStorage.getItem(SETTINGS_KEY); if (!raw) return { ...defaults };
    const s = JSON.parse(raw);
    return {
      ...defaults,
      ...s,
      ai: { ...defaults.ai, ...(s.ai||{}) },
      tts: { ...defaults.tts, ...(s.tts||{}) },
      reading: { ...defaults.reading, ...(s.reading||{}) },
      assistant: { ...defaults.assistant, ...(s.assistant||{}) }
    };
  } catch(_) { return { ...defaults }; }
}

export function saveGlobalSettings(partial) {
  const cur = loadGlobalSettings();
  const next = {
    ...cur,
    ...partial,
    ai: { ...cur.ai, ...(partial?.ai || {}) },
    tts: { ...cur.tts, ...(partial?.tts || {}) },
    reading: { ...cur.reading, ...(partial?.reading || {}) },
    assistant: { ...cur.assistant, ...(partial?.assistant || {}) },
    updatedAt: new Date().toISOString()
  };
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); return next; } catch(_) { return cur; }
}

export function loadGlobalSecrets() {
  try { const raw = localStorage.getItem(SECRETS_KEY); return raw ? JSON.parse(raw) : {}; } catch(_) { return {}; }
}

export function saveGlobalSecrets(partial) {
  const cur = loadGlobalSecrets();
  const next = { ...cur, ...(partial || {}), updatedAt: new Date().toISOString() };
  try { localStorage.setItem(SECRETS_KEY, JSON.stringify(next)); return next; } catch(_) { return cur; }
}
import { TTS_CONFIG } from '../ai-config.js';
