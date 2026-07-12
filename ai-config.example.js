// AI 服務端點（示例）
export const API_URL = 'https://YOUR-ENDPOINT/v1/chat/completions';
// API 金鑰（請自行填入；此檔僅作為示例，不應提交真實金鑰）
export const API_KEY = '';

// 多端點 Providers（示例）
// - default 指向全域（維持相容）
// - 你可以新增如 tbai/openrouter/local 等 provider
export const AI_PROVIDERS = {
  default: { apiUrl: API_URL, apiKey: API_KEY },
  // 範例：
  tbai: { apiUrl: 'https://tbai.xin/v1/chat/completions', apiKey: '' },
  openrouter: { apiUrl: 'https://openrouter.ai/api/v1/chat/completions', apiKey: '' },
  local: { apiUrl: 'http://localhost:11434/v1/chat/completions', apiKey: '' } // Ollama 之類的相容服務
};

// 相容舊名稱
export const AI_PROFILES = AI_PROVIDERS;

// AI 任務映射（示例）
// 模型使用位置索引（示例）：
// - exampleGeneration → modules/api.js: generateExamplesForWord()
// - wordAnalysis      → modules/api.js: getWordAnalysis()；亦為 analyzeSelection() 後備
// - sentenceChecking  → modules/api.js: checkUserSentence()
// - qaChecking        → features/qa/qa-checker.js
// - articleAnalysis   → modules/api.js: analyzeParagraph() / analyzeSentence()
// - articleCleanup    → modules/api.js: aiCleanArticleMarkdown() / aiExtractArticleFromHtml()
// - imageOCR          → modules/api.js: ocrExtractTextFromImage() / aiGradeHandwriting()
// - assistant         → features/assistant/assistant.js
export const AI_TASKS = {
  // 你可以使用以下三種寫法指定模型對應的端點：
  // 1) 純字串：'gpt-4.1-mini'（走全域 API_URL/API_KEY）
  // 2) 前綴字串：'tbai:gpt-4.1-mini'（走 AI_PROVIDERS.tbai）
  // 3) 物件：{ provider:'tbai', model:'gpt-4.1-mini' }（可加覆蓋 apiUrl/apiKey）
  exampleGeneration: 'tbai:gpt-4.1-nano',
  wordAnalysis: { provider: 'tbai', model: 'gpt-4.1-mini' },
  sentenceChecking: 'gpt-4.1-mini',
  qaChecking: 'gpt-4.1-mini',
  articleAnalysis: 'gpt-4.1-mini',
  articleCleanup: 'gpt-4.1-mini',
  imageOCR: { provider: 'openrouter', model: 'gpt-4o-mini' },
  assistant: 'gpt-4.1-mini',

  // 相容既有細分任務
  articlePhraseAnalysis: 'gpt-4.1-mini',
  articleWordTooltip: 'gpt-4.1-mini',
  articleParagraphTranslation: 'gpt-4.1-mini',
  articleParagraphTranslationFallback: { provider: 'openrouter', model: 'gpt-4o-mini' },
  articleSentenceTranslation: 'gpt-4.1-mini',
  articleSentenceTranslationFallback: { provider: 'openrouter', model: 'gpt-4o-mini' },
  articleWordTranslation: 'gpt-4.1-mini',
  articleWordTranslationFallback: { provider: 'openrouter', model: 'gpt-4o-mini' },
  articlePhraseTranslation: 'gpt-4.1-mini',
  articlePhraseTranslationFallback: { provider: 'openrouter', model: 'gpt-4o-mini' }
};

// 相容舊名稱
export const AI_MODELS = AI_TASKS;

// AI 請求節流 / 併發控制（前端佇列）
// 用途：modules/api.js 會依「任務類型」把請求分流到各自的佇列，避免短時間湧出大量
//       請求而觸發服務商限流（HTTP 429）。每個任務一條獨立佇列（佇列鍵 = 端點 +
//       provider + 模型 + 任務），彼此互不影響。
// 欄位：
//   - maxConcurrency：該佇列「同時在途」的最大請求數。調高 → 更快，但更易被限流。
//   - minIntervalMs ：同佇列中相鄰兩次請求「啟動」的最小間隔（毫秒），等同每秒最多
//                     發出 1000 / minIntervalMs 個請求。調大 → 更溫和、更不易 429。
// 規則：
//   - default 為總後備；任何未列在下方的任務都套用 default。
//   - 個別任務可只覆寫其中一個欄位，未填者沿用 default。
//   - 鍵名必須對應 AI_TASKS 的任務名稱（如 articleWordTranslation）才會生效。
// 為何只有文章翻譯類另設：文章詳解會「逐段／逐句／逐詞／逐片語」拆成大量小請求，
//   其中逐詞、逐片語數量最多，故併發壓到 1、間隔加大，最不易觸發限流。
export const AI_LIMITS = {
  // 全域後備：未單獨設定的任務都用這組（最多 2 併發、每次至少間隔 150ms）
  default: { maxConcurrency: 2, minIntervalMs: 150 },
  // 文章「逐段」翻譯：請求數中等，2 併發、間隔 500ms
  articleParagraphTranslation: { maxConcurrency: 2, minIntervalMs: 500 },
  // 文章「逐句」翻譯：請求較多，2 併發、間隔 250ms
  articleSentenceTranslation: { maxConcurrency: 2, minIntervalMs: 250 },
  // 文章「逐詞」翻譯：請求最多，限 1 併發、間隔 300ms
  articleWordTranslation: { maxConcurrency: 1, minIntervalMs: 300 },
  // 文章「逐片語」翻譯：同上，1 併發、間隔 350ms
  articlePhraseTranslation: { maxConcurrency: 1, minIntervalMs: 350 }
};

// 產品 AI 提示詞統一維護於 modules/prompts/。
// 此設定檔只保留端點、模型、限流與外部服務配置。
// 問答集校對模型別名（缺省時回退到 sentenceChecking）
if (!AI_MODELS.answerChecking) {
  AI_MODELS.answerChecking = AI_MODELS.qaChecking || AI_MODELS.sentenceChecking || 'gpt-4.1-mini';
}

// Email 發送配置（可選；目前為預留設定，尚未被任何模組讀取）
// - mode: 'mailto'（預設，開啟本機郵件用戶端）、'webhook'（自建 API）、'emailjs'（需 EmailJS 公鑰）
// - defaultTo：預設收件人
export const EMAIL = {
  mode: 'mailto',
  defaultTo: '',
  webhook: { url: '', method: 'POST', headers: {} },
  emailjs: { publicKey: '', serviceId: '', templateId: '' }
};

// 文本轉語音（示例）
// - 支援「遠端 / 本機」雙來源：use 決定預設使用哪一個，使用者也可在「全域設定」中切換。
//   baseUrl 為舊欄位，僅在未提供 baseUrlRemote 時作為後備（向後相容）。
export const TTS_CONFIG = {
  baseUrl: 'https://your-tts.example.com',
  // 遠端 TTS 端點（對外網址）；未填則回退到 baseUrl
  baseUrlRemote: 'https://your-tts.example.com',
  // 本機 / 區網 TTS 端點（例如自架服務）；可留空
  baseUrlLocal: 'http://localhost:8888',
  // 預設使用哪個來源：'remote'（遠端）或 'local'（本機）
  use: 'remote',
  // 可選：提供一個可查詢可用音色/模型清單的端點（例如 /voices）
  voicesUrl: 'https://your-tts.example.com/voices',
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
  // 可用 PROFILE 指向 AI_PROVIDERS 中的某個端點；或直接填 API_URL/API_KEY 覆蓋。
  PROFILE: undefined,
  API_URL: undefined,
  API_KEY: undefined,
  MODEL: AI_TASKS.qaChecking,
  // 可選模型清單（供 UI 下拉選擇使用）
  MODELS: [ 'gpt-4.1-mini', 'gpt-4.1-nano' ],
  DEFAULT_MODEL: AI_TASKS.qaChecking,
  temperature: 0.2,
  maxTokens: 1500,
  timeoutMs: 30000,   // 單題逾時（毫秒）
  concurrent: true,   // 整批校對時是否並行
  includeAnalysis: true, // 是否回傳錯誤分類分析
  cache: false        // 是否使用本地快取（預設關閉，避免取到舊結果）
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
  MODEL: AI_TASKS.imageOCR,
  MODELS: [
    // e.g. 'gemini-2.5-flash-nothinking', 'gemini-2.5-flash-lite', 'gemini-2.5-pro'
  ],
  DEFAULT_MODEL: AI_TASKS.imageOCR,
  maxTokens: 1500,
  timeoutMs: 45000,
  // 批量 OCR 時一次最多同時處理幾張圖片；未設定時程式預設為 5
  maxConcurrency: 3
};

// 文章導入與 AI 清洗（新增）
// - 若你希望文章清洗（去雜訊、整理 Markdown）使用與全域不同的端點/金鑰/模型，可於此覆蓋；
// - 留空（undefined）則沿用全域 API_URL / API_KEY 與 AI_MODELS.articleAnalysis。
export const ARTICLE_IMPORT = {
  // 指定單獨端點（擇一）：PROFILE 或 API_URL/API_KEY
  PROFILE: undefined,
  API_URL: undefined,
  API_KEY: undefined,
  // 可選：你自己的 HTML 代理服務（例如 Cloudflare Worker），避免 CORS；格式例：'https://your-worker.example/fetch?url='
  PROXY_URL: undefined,
  // 可選：Worker 的正文抽取端點（優先於 PROXY_URL 用於擷取正文）；格式例：'https://your-worker.example/extract?url='
  EXTRACT_URL: undefined,
  // 可選：Worker 的新聞 Feed 聚合端點；設定後「新聞」分頁才能拉取來源與文章列表
  FEED_URL: undefined,
  // 可選：新聞來源清單（當 FEED_URL 未回傳來源時的後備）；每項格式：{ id, label }
  SOURCES: [
    // { id: 'guardian', label: 'The Guardian US' },
    // { id: 'techcrunch', label: 'TechCrunch' }
  ],
  // 模型：可用 'provider:model'、物件或純字串（走全域）
  MODEL: AI_TASKS.articleCleanup,
  MODELS: [ 'gpt-4.1-mini', 'gpt-4o-mini' ],
  DEFAULT_MODEL: AI_TASKS.articleCleanup,
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

// 同步後端（Cloudflare D1 + Worker）設定（示例）
// - endpoint：部署 cloudflare-worker/ 後得到的 Worker 網址，例如：
//   'https://bdc-sync-api.YOUR-SUBDOMAIN.workers.dev'
// - 通行碼不放這裡；由使用者登入時輸入，僅存於瀏覽器本機。
//
// poll：控制「多久向伺服器問一次：其他裝置有沒有更新資料」。整段可省略，省略時用下面的預設值。
//   baseMs          正常的檢查間隔（毫秒）。你正在看這個頁面時，每隔這麼久問伺服器一次。
//                   預設 90000，也就是每 90 秒問一次。數字越小越即時，但送出的請求也越多。
//   maxMs           最慢的檢查間隔（毫秒）。頁面開著、但你有一陣子完全沒有操作時，
//                   App 會自動把間隔越拉越長來少送請求，最長拉到這個值為止。
//                   預設 300000，也就是發呆時最久每 5 分鐘才問一次。
//                   只要你一操作、或問到伺服器確實有更新，間隔就馬上恢復成正常的 baseMs。
//   pauseWhenHidden 切到別的分頁、或把視窗縮到背景時，完全停止問伺服器（不送任何請求）；
//                   回到這個頁面時自動繼續。預設 true。
//   pollOnFocus     回到這個頁面（或視窗重新被點選）的那一刻，立刻問一次，
//                   讓你馬上看到最新資料。預設 true。
export const SYNC = {
  endpoint: '',
  poll: {
    baseMs: 90000,          // 正常每 90 秒問一次伺服器有沒有別的裝置更新
    maxMs: 300000,          // 沒操作時間隔自動變長，最久 5 分鐘問一次；一有動作就恢復成 baseMs
    pauseWhenHidden: true,  // 切到背景分頁就停止問，回到頁面再繼續
    pollOnFocus: true       // 一回到頁面就立刻問一次，馬上看到最新
  }
};

// AI 助手（聊天）模型清單（示例）
// - 可用：純字串、'provider:model'、或 { provider, model }
export const ASSISTANT = {
  MODEL: AI_TASKS.assistant,
  MODELS: [ 'gpt-4.1-mini', 'gpt-4.1-nano' ],
  DEFAULT_MODEL: AI_TASKS.assistant
};

// 匯出預設設定，便於動態 import 使用 config.default 取得整體物件
const __DEFAULT__ = {
  API_URL,
  API_KEY,
  AI_PROVIDERS,
  AI_TASKS,
  AI_PROFILES,
  AI_MODELS,
  AI_LIMITS,
  ASSISTANT,
  TTS_CONFIG,
  QA_CHECK,
  OCR_CONFIG,
  ARTICLE_IMPORT,
  SUPABASE,
  SYNC
};
export default __DEFAULT__;
