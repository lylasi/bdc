// AI 服務端點（示例）
export const API_URL = 'https://YOUR-ENDPOINT/v1/chat/completions';
// API 金鑰（請自行填入；此檔僅作為示例，不應提交真實金鑰）
export const API_KEY = '';

// 多端點 Profiles（新增）：根據供應商/環境切換 baseUrl 與 key
// - default 指向全域（維持相容）
// - 你可以新增如 tbai/openrouter/local 等 profile
export const AI_PROFILES = {
  default: { apiUrl: API_URL, apiKey: API_KEY },
  // 範例：
  tbai: { apiUrl: 'https://tbai.xin/v1/chat/completions', apiKey: '' },
  openrouter: { apiUrl: 'https://openrouter.ai/api/v1/chat/completions', apiKey: '' },
  local: { apiUrl: 'http://localhost:11434/v1/chat/completions', apiKey: '' } // Ollama 之類的相容服務
};

// AI 模型清單（示例）
export const AI_MODELS = {
  // 你可以使用以下三種寫法指定模型對應的端點：
  // 1) 純字串：'gpt-4.1-mini'（走全域 API_URL/API_KEY）
  // 2) 前綴字串：'tbai:gpt-4.1-mini'（走 AI_PROFILES.tbai）
  // 3) 物件：{ profile:'tbai', model:'gpt-4.1-mini' }（可加覆蓋 apiUrl/apiKey）
  exampleGeneration: 'tbai:gpt-4.1-nano',
  wordAnalysis: { profile: 'tbai', model: 'gpt-4.1-mini' },
  sentenceChecking: 'gpt-4.1-mini', // 沒前綴 → 用全域
  imageOCR: { profile: 'openrouter', model: 'gpt-4o-mini' }
};

// 問答集校對模型別名（缺省時回退到 sentenceChecking）
if (!AI_MODELS.answerChecking) {
  AI_MODELS.answerChecking = AI_MODELS.sentenceChecking || 'gpt-4.1-mini';
}

// 文本轉語音（示例）
export const TTS_CONFIG = {
  baseUrl: 'https://your-tts.example.com',
  apiKey: '',
  voices: {
    english: 'en-US-JennyNeural',
    chinese: 'zh-CN-XiaoxiaoNeural',
    cantonese: 'zh-HK-HiuGaaiNeural'
  }
};

// 問答集 AI 校對專用設定（示例）
// 若需與其他功能使用不同端點/金鑰/模型，可在此覆寫；
// 留空（undefined）則沿用上方全域 API_URL/API_KEY 與 AI_MODELS.answerChecking。
export const QA_CHECK = {
  // 可用 PROFILE 指向 AI_PROFILES 中的某個端點；或直接填 API_URL/API_KEY 覆蓋。
  PROFILE: undefined,
  API_URL: undefined,
  API_KEY: undefined,
  MODEL: 'gpt-4.1-mini',
  temperature: 0.2,
  maxTokens: 1500,
  timeoutMs: 30000,   // 單題逾時（毫秒）
  concurrent: true,   // 整批校對時是否並行
  includeAnalysis: true // 是否回傳錯誤分類分析
};

// 影像識別（OCR）專用覆蓋（示例）
// - 若你希望 OCR 使用與其他功能不同的端點/金鑰/模型，可在此覆寫；
// - 留空（undefined）則沿用全域 API_URL / API_KEY 與 AI_MODELS.imageOCR。
export const OCR_CONFIG = {
  // 指定單獨的 OCR 端點（擇一）：PROFILE 或 API_URL/API_KEY
  PROFILE: undefined,
  API_URL: undefined,
  API_KEY: undefined,
  // 你可以只指定 MODEL，或提供 MODELS 與 DEFAULT_MODEL 給 UI 供選
  MODEL: undefined, // e.g. 'gpt-4o-mini' 或 'openrouter:gpt-4o-mini'
  MODELS: [
    // e.g. 'gemini-2.5-flash-nothinking', 'gemini-2.5-flash-lite', 'gemini-2.5-pro'
  ],
  DEFAULT_MODEL: undefined,
  maxTokens: 1500,
  timeoutMs: 45000
};

// 文章導入與 AI 清洗（新增）
// - 若你希望文章清洗（去雜訊、整理 Markdown）使用與全域不同的端點/金鑰/模型，可於此覆蓋；
// - 留空（undefined）則沿用全域 API_URL / API_KEY 與 AI_MODELS.articleAnalysis。
export const ARTICLE_IMPORT = {
  // 指定單獨端點（擇一）：PROFILE 或 API_URL/API_KEY
  PROFILE: undefined,
  API_URL: undefined,
  API_KEY: undefined,
  // 模型：可用 'profile:model'、物件或純字串（走全域）
  MODEL: 'gpt-4.1-mini',
  MODELS: [ 'gpt-4.1-mini', 'gpt-4o-mini' ],
  DEFAULT_MODEL: undefined,
  // 推論參數與預設清洗選項
  temperature: 0.1,
  maxTokens: 1400,
  timeoutMs: 25000,
  keepImagesDefault: true
};

// Supabase 設定（示例）
// - url 例：'https://YOUR-PROJECT.supabase.co'
// - anonKey 從 Supabase 控台 Project Settings → API 取得（anon public）
export const SUPABASE = {
  url: '',
  anonKey: ''
};

// 匯出預設設定，便於動態 import 使用 config.default 取得整體物件
const __DEFAULT__ = {
  API_URL,
  API_KEY,
  AI_PROFILES,
  AI_MODELS,
  TTS_CONFIG,
  QA_CHECK,
  OCR_CONFIG,
  ARTICLE_IMPORT,
  SUPABASE
};
export default __DEFAULT__;
