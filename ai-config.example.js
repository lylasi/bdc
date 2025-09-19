// AI 服務端點（示例）
export const API_URL = 'https://YOUR-ENDPOINT/v1/chat/completions';
// API 金鑰（請自行填入；此檔僅作為示例，不應提交真實金鑰）
export const API_KEY = '';

// AI 模型清單（示例）
export const AI_MODELS = {
  // 範例產生
  exampleGeneration: 'gpt-4.1-nano',
  // 單詞/短語分析
  wordAnalysis: 'gpt-4.1-mini',
  // 句子校對/評分
  sentenceChecking: 'gpt-4.1-mini'
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
  API_URL: undefined,
  API_KEY: undefined,
  MODEL: 'gpt-4.1-mini',
  temperature: 0.2,
  maxTokens: 1500,
  timeoutMs: 30000,   // 單題逾時（毫秒）
  concurrent: true,   // 整批校對時是否並行
  includeAnalysis: true // 是否回傳錯誤分類分析
};

// 匯出預設設定，便於動態 import 使用 config.default 取得整體物件
const __DEFAULT__ = {
  API_URL,
  API_KEY,
  AI_MODELS,
  TTS_CONFIG,
  QA_CHECK
};
export default __DEFAULT__;
