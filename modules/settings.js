import { TTS_CONFIG } from '../ai-config.js';
import { touch as syncTouch } from './sync-signals.js';
import {
    getAIViewFromProfile,
    applyAISettingsPatch,
    AI_PROFILE_MIGRATION_KEY
} from './ai-profile-storage.js';

// Global settings are stored locally; selected non-sensitive AI fields may be synced.
// AI provider definitions, task selections and keys now live in the account-scoped
// AI profile (see ai-profile-storage.js). This module keeps its public shape so
// existing features can keep reading `loadGlobalSettings()?.ai`, but it never
// writes AI data (least of all keys) back into `pen_global_secrets`.

const SETTINGS_KEY = 'pen_global_settings';
const SECRETS_KEY = 'pen_global_secrets';

const defaults = {
  language: {
    interfaceLocale: 'zh-CN'
  },
  ai: {
    apiUrl: '',
    models: {},
    providers: {},
    tasks: {},
    defaultModel: ''
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
  // analysisCheckpoint：文章逐段分析的 checkpoint 開關（P3-T1）；false 時回到只在最後保存。
  reading: { englishVariant: 'en-GB', chineseVariant: 'zh-CN', translationMask: true, analysisCheckpoint: true },
  phonetics: { enabled: false },
  assistant: { enabled: true, stream: true },
  // 配色背景插畫的顯示參數；圖片本體存在 IndexedDB（modules/theme-art.js）
  themeArt: { enabled: true, strength: 0.22, blur: 2 },
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
  const ttsOverride = isPlainObject(override.tts) ? override.tts : null;
  return {
    ...base,
    ...override,
    language: mergeRecord(base.language, override.language),
    ai: { ...defaults.ai },
    tts: {
      ...mergeRecord(base.tts, override.tts),
      selectedVoices: ttsOverride && Object.prototype.hasOwnProperty.call(ttsOverride, 'selectedVoices')
        ? mergeRecord({}, ttsOverride.selectedVoices)
        : mergeRecord(base.tts?.selectedVoices, undefined)
    },
    phonetics: mergeRecord(base.phonetics, override.phonetics),
    reading: mergeRecord(base.reading, override.reading),
    assistant: mergeRecord(base.assistant, override.assistant),
    themeArt: mergeRecord(base.themeArt, override.themeArt)
  };
}

function mergeSecrets(baseValue, overrideValue) {
  const base = isPlainObject(baseValue) ? baseValue : {};
  const override = isPlainObject(overrideValue) ? overrideValue : {};
  const merged = {
    ...base,
    ...override
  };
  // Legacy AI secrets are never surfaced; the profile is the only AI source.
  delete merged.aiProviders;
  delete merged.aiApiKey;
  merged.aiProviders = {};
  merged.updatedAt = Object.prototype.hasOwnProperty.call(override, 'updatedAt')
    ? override.updatedAt
    : (base.updatedAt || null);
  return merged;
}

// 寫回 localStorage 時也要做同樣的分組合併：設定面板是一個欄位一個欄位即時儲存，
// 若只做 { ...stored, ...patch } 的淺合併，存 tts.use 會把同一個 tts 底下的
// baseUrlCustom／selectedVoices 整組蓋掉（reading、assistant 同理）。
function mergeStoredSettings(stored, patch) {
  const base = isPlainObject(stored) ? stored : {};
  const override = isPlainObject(patch) ? patch : {};
  const next = { ...base, ...override };
  for (const key of ['language', 'tts', 'reading', 'assistant', 'phonetics']) {
    if (!isPlainObject(base[key]) && !isPlainObject(override[key])) continue;
    next[key] = mergeRecord(base[key], override[key]);
    if (key === 'tts' && (isPlainObject(base.tts?.selectedVoices) || isPlainObject(override.tts?.selectedVoices))) {
      next.tts.selectedVoices = mergeRecord(base.tts?.selectedVoices, override.tts?.selectedVoices);
    }
  }
  return next;
}

function readLegacySettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return {};
    return JSON.parse(raw) || {};
  } catch (_) {
    return {};
  }
}

export function loadGlobalSettings() {
  const parsed = readLegacySettings();
  const merged = mergeSettings(defaults, parsed);
  // AI is always projected from the active account/device profile.
  merged.ai = getAIViewFromProfile();
  return merged;
}

export function saveGlobalSettings(partial, options = {}) {
  const current = loadGlobalSettings();
  const normalizedOptions = options && typeof options === 'object' ? options : {};
  const hasAiUpdate = isPlainObject(partial?.ai);
  const now = new Date().toISOString();
  const updatedAt = normalizedOptions.preserveUpdatedAt
    ? (current.updatedAt || normalizedOptions.updatedAtOverride || now)
    : now;

  // AI data is not duplicated into pen_global_settings.
  const legacyPartial = { ...(isPlainObject(partial) ? partial : {}) };
  delete legacyPartial.ai;

  const next = {
    ...mergeSettings(current, legacyPartial),
    updatedAt
  };
  let savedToStorage = true;
  try {
    const stored = readLegacySettings();
    const nextStored = mergeStoredSettings(stored, legacyPartial);
    nextStored.updatedAt = updatedAt;
    // Remove the legacy AI block only after the one-time migration has safely
    // completed; otherwise keep it so a failed migration can be retried.
    let migrated = false;
    try { migrated = localStorage.getItem(AI_PROFILE_MIGRATION_KEY) === 'done'; } catch (_) {}
    if (migrated) delete nextStored.ai;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(nextStored));
  } catch (_) {
    savedToStorage = false;
  }

  if (hasAiUpdate) {
    // Profile writes throw on failure; callers must not report success.
    applyAISettingsPatch(partial.ai, normalizedOptions.scope);
    if (normalizedOptions.suppressSyncTouch !== true) syncTouch('aiSettings');
  }
  if (!savedToStorage && !hasAiUpdate) return current;
  return loadGlobalSettings();
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
  const clean = isPlainObject(partial) ? { ...partial } : {};
  delete clean.aiProviders;
  delete clean.aiApiKey;
  const next = {
    ...mergeSecrets(current, clean),
    updatedAt: new Date().toISOString()
  };
  try {
    const storedRaw = localStorage.getItem(SECRETS_KEY);
    const stored = storedRaw ? JSON.parse(storedRaw) : {};
    let migrated = false;
    try { migrated = localStorage.getItem(AI_PROFILE_MIGRATION_KEY) === 'done'; } catch (_) {}
    const toStore = { ...next };
    if (!migrated) {
      // Migration has not completed: keep legacy AI secrets for a retry. They
      // are never returned by loadGlobalSecrets().
      if (stored && stored.aiProviders !== undefined) toStore.aiProviders = stored.aiProviders;
      if (stored && stored.aiApiKey !== undefined) toStore.aiApiKey = stored.aiApiKey;
    }
    localStorage.setItem(SECRETS_KEY, JSON.stringify(toStore));
    return next;
  } catch (_) {
    return current;
  }
}
