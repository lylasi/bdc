// BDC 本機設定範例
//
// ⚠️ 此檔從此不再保存「全站預設 AI 供應商」的網址、共享 Key、模型列表或
//    任務模型映射。這些內容由管理員在 BDC「設定 → 管理預設供應商」發布，
//    存於 Cloudflare D1，只有已登入使用者可取得。
//
// 使用者自己的供應商與 Key 存放在帳戶範圍的本機 AI profile，
// 由「設定 → 我的供應商」新增；未登入時保存到「此裝置」。
//
// 這個檔案只保留非 AI 供應商設定：TTS、文章抓取服務、同步端點與限流參數。
// 請勿把真實 Key 寫進此檔或提交到版本控制。

// AI 請求節流 / 併發控制（前端佇列）
// 任務鍵名對應 modules/ai-models.js 的任務名稱；default 為後備。
export const AI_LIMITS = {
  default: { maxConcurrency: 2, minIntervalMs: 150 },
  articleParagraphTranslation: { maxConcurrency: 2, minIntervalMs: 500 },
  articleSentenceTranslation: { maxConcurrency: 2, minIntervalMs: 250 },
  articleWordTranslation: { maxConcurrency: 1, minIntervalMs: 300 },
  articlePhraseTranslation: { maxConcurrency: 1, minIntervalMs: 350 }
};

// 文本轉語音（TTS；非 AI 供應商設定，可保留）
export const TTS_CONFIG = {
  baseUrl: 'https://your-tts.example.com',
  baseUrlRemote: 'https://your-tts.example.com',
  baseUrlLocal: 'http://localhost:8888',
  use: 'remote',
  voicesUrl: 'https://your-tts.example.com/voices',
  apiKey: '',
  voices: {
    english: 'en-US-JennyNeural',
    chinese: 'zh-CN-XiaoxiaoNeural',
    cantonese: 'zh-HK-HiuGaaiNeural'
  }
};

// 問答集校對的推論參數（端點、Key、模型一律由使用者在 BDC 內選擇）
export const QA_CHECK = {
  temperature: 0.2,
  maxTokens: 1500,
  timeoutMs: 30000,
  concurrent: true,
  includeAnalysis: true,
  cache: false
};

// 影像識別 / AI 批改的推論參數（不含端點、Key、模型）
export const OCR_CONFIG = {
  maxTokens: 1500,
  timeoutMs: 45000,
  maxConcurrency: 3
};

// 文章導入與 AI 清洗的推論參數 / 抓取服務（不含 AI 端點、Key、模型）
export const ARTICLE_IMPORT = {
  // 同源或自架的 HTML 抓取 / 正文抽取端點；與 AI 供應商無關
  PROXY_URL: undefined,
  EXTRACT_URL: undefined,
  FEED_URL: undefined,
  SOURCES: [
    // { id: 'bbc', label: 'BBC World' },
    // { id: 'cnn', label: 'CNN World' }
  ],
  temperature: 0.1,
  maxTokens: 1400,
  timeoutMs: 25000,
  keepImagesDefault: true
};

// Supabase（歷史欄位；目前同步使用 Cloudflare Worker）
export const SUPABASE = {
  url: '',
  anonKey: ''
};

// 同步後端設定（Cloudflare Worker + D1，或 selfhost/ 的 Node + SQLite／PostgreSQL）
// - endpoint：Worker 網址或自建伺服器網址（例如 http://127.0.0.1:8787）
// - 通行碼不放這裡；由使用者登入時輸入，僅存於瀏覽器本機。
// - poll 控制向伺服器輪詢學習資料更新的節奏（AI 設定同步另有版本檢查）。
export const SYNC = {
  endpoint: '',
  poll: {
    baseMs: 90000,
    maxMs: 300000,
    pauseWhenHidden: true,
    pollOnFocus: true
  }
};

const __DEFAULT__ = {
  AI_LIMITS,
  TTS_CONFIG,
  QA_CHECK,
  OCR_CONFIG,
  ARTICLE_IMPORT,
  SUPABASE,
  SYNC
};
export default __DEFAULT__;
