import { TTS_CONFIG } from '../ai-config.js';

// Local-only global settings & secrets (never synced)
// Keys
const SETTINGS_KEY = 'pen_global_settings';
const SECRETS_KEY = 'pen_global_secrets';

const defaults = {
  ai: {
    apiUrl: '',
    models: {},
    providers: {},
    tasks: {}
  },
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

const secretDefaults = {
  aiProviders: {},
  updatedAt: null
};

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function mergeRecord(baseValue, overrideValue) {
  return {
    ...(isPlainObject(baseValue) ? baseValue : {}),
    ...(isPlainObject(overrideValue) ? overrideValue : {})
  };
}

function mergeSettings(baseValue, overrideValue) {
  const base = isPlainObject(baseValue) ? baseValue : {};
  const override = isPlainObject(overrideValue) ? overrideValue : {};
  const aiOverride = isPlainObject(override.ai) ? override.ai : null;
  const ttsOverride = isPlainObject(override.tts) ? override.tts : null;
  return {
    ...base,
    ...override,
    ai: {
      ...mergeRecord(base.ai, override.ai),
      models: aiOverride && Object.prototype.hasOwnProperty.call(aiOverride, 'models')
        ? mergeRecord({}, aiOverride.models)
        : mergeRecord(base.ai?.models, undefined),
      providers: aiOverride && Object.prototype.hasOwnProperty.call(aiOverride, 'providers')
        ? mergeRecord({}, aiOverride.providers)
        : mergeRecord(base.ai?.providers, undefined),
      tasks: aiOverride && Object.prototype.hasOwnProperty.call(aiOverride, 'tasks')
        ? mergeRecord({}, aiOverride.tasks)
        : mergeRecord(base.ai?.tasks, undefined)
    },
    tts: {
      ...mergeRecord(base.tts, override.tts),
      selectedVoices: ttsOverride && Object.prototype.hasOwnProperty.call(ttsOverride, 'selectedVoices')
        ? mergeRecord({}, ttsOverride.selectedVoices)
        : mergeRecord(base.tts?.selectedVoices, undefined)
    },
    reading: mergeRecord(base.reading, override.reading),
    assistant: mergeRecord(base.assistant, override.assistant)
  };
}

function mergeSecrets(baseValue, overrideValue) {
  const base = isPlainObject(baseValue) ? baseValue : {};
  const override = isPlainObject(overrideValue) ? overrideValue : {};
  return {
    ...base,
    ...override,
    aiProviders: Object.prototype.hasOwnProperty.call(override, 'aiProviders')
      ? mergeRecord({}, override.aiProviders)
      : mergeRecord(base.aiProviders, undefined)
  };
}

export function loadGlobalSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return mergeSettings(defaults, {});
    const parsed = JSON.parse(raw);
    return mergeSettings(defaults, parsed);
  } catch (_) {
    return mergeSettings(defaults, {});
  }
}

export function saveGlobalSettings(partial) {
  const current = loadGlobalSettings();
  const next = {
    ...mergeSettings(current, partial),
    updatedAt: new Date().toISOString()
  };
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    return next;
  } catch (_) {
    return current;
  }
}

export function loadGlobalSecrets() {
  try {
    const raw = localStorage.getItem(SECRETS_KEY);
    if (!raw) return mergeSecrets(secretDefaults, {});
    return mergeSecrets(secretDefaults, JSON.parse(raw));
  } catch (_) {
    return mergeSecrets(secretDefaults, {});
  }
}

export function saveGlobalSecrets(partial) {
  const current = loadGlobalSecrets();
  const next = {
    ...mergeSecrets(current, partial),
    updatedAt: new Date().toISOString()
  };
  try {
    localStorage.setItem(SECRETS_KEY, JSON.stringify(next));
    return next;
  } catch (_) {
    return current;
  }
}
