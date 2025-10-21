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
// 模型使用位置索引（示例）：
// - exampleGeneration → modules/api.js: generateExamplesForWord()
// - wordAnalysis      → modules/api.js: getWordAnalysis()；亦為 analyzeSelection() 後備
// - articleWordTooltip→ modules/api.js: analyzeWordInSentence()（文章詳解區：點詞彈窗）
// - articlePhraseAnalysis→ modules/api.js: analyzeSelection()（文章詳解區：片語解析）
// - sentenceChecking  → modules/api.js: checkUserSentence()
// - articleAnalysis   → modules/api.js: analyzeParagraph() / analyzeSentence()
// - imageOCR          → modules/api.js: ocrExtractTextFromImage() / aiGradeHandwriting()
export const AI_MODELS = {
  // 你可以使用以下三種寫法指定模型對應的端點：
  // 1) 純字串：'gpt-4.1-mini'（走全域 API_URL/API_KEY）
  // 2) 前綴字串：'tbai:gpt-4.1-mini'（走 AI_PROFILES.tbai）
  // 3) 物件：{ profile:'tbai', model:'gpt-4.1-mini' }（可加覆蓋 apiUrl/apiKey）
  exampleGeneration: 'tbai:gpt-4.1-nano',
  wordAnalysis: { profile: 'tbai', model: 'gpt-4.1-mini' },
  // 文章詳解：片語解析（句卡內「詳解」與工具提示內「片語解析」）
  articlePhraseAnalysis: 'gpt-4.1-mini',
  // 文章詳解：點擊單詞彈出卡片專用（可與 wordAnalysis 不同）
  articleWordTooltip: 'gpt-4.1-mini',
  sentenceChecking: 'gpt-4.1-mini', // 沒前綴 → 用全域
  // 若需要，也可新增 articleAnalysis 指定段落/句子分析用模型
  // articleAnalysis: 'gpt-4.1-mini',
  imageOCR: { profile: 'openrouter', model: 'gpt-4o-mini' }
};

// 集中管理的提示詞模板（示例）
// - 使用 ${name} 作為變數佔位，程式端會帶入對應值
export const AI_PROMPTS = {
  dictionary: {
    wordAnalysis: {
      template: 'Please provide a detailed analysis for the word "${word}". Return the result in a strict JSON format with the following keys: "phonetic" (IPA), "pos" (part of speech), and "meaning" (the most common Traditional Chinese (Hong Kong) meaning). For example: {"phonetic": "ɪɡˈzæmpəl", "pos": "noun", "meaning": "例子"}. Ensure the meaning is in Traditional Chinese (Hong Kong) vocabulary (e.g., 網上/上載/電郵/巴士/的士/單車/軟件/網絡/連結/相片).'
    }
  },
  qa: {
    checker: {
      system: `你是一位具有20年教學經驗的資深英語教師，擅長學生答案評估和教學指導。你的評價風格溫和而專業，既要指出問題，也要給予鼓勵，幫助學生建立學習信心。你特別關注學生的語言技能發展，能夠提供具體的改進建議和學習方向。`,
      template: `你是一位以繁體中文回覆的英語老師與審稿員。你只依據「題目 + 標準答案」來判定學生答案是否正確，並在必要時指出格式問題（大小寫、標點）。不要產生長篇說理，輸出務必簡潔、可機器解析。

請回傳單一 JSON（不要加任何說明或程式碼圍欄），欄位如下：
{
  "isCorrect": true/false,
  "teacherFeedback": "<=50字，指出是否答題、不足之處與核心差異",
  "improvementSuggestions": ["<=2條，每條<=30字，提供最小修改方向"],
  "errors": {
    "punctuation": ["標點或格式問題，如：句首需大寫/句末缺標點/Yes 後需逗號"],
    "grammar": ["文法錯誤（可留空）"],
    "spelling": ["拼寫錯誤（可留空）"],
    "vocabulary": ["選詞不當（可留空）"],
    "structure": ["語序/邏輯問題（可留空）"]
  },
  "aiFeedbackOk": true/false,
  "aiFeedbackIssues": ["若你的評語可能有誤或不完滿，簡短列出原因（如：未檢查大小寫、錯把附和句視為正確等）"]
}

資料（請務必結合三者比對）：
題目: \${question}
標準答案: \${correctAnswer}
學生答案: \${userAnswer}

評估規則：
- 嚴禁把附和或評述句視為正確答案；若出現，isCorrect應為false，並在 teacherFeedback 指明「未直接回答題目」。
- 嚴格檢查大小寫與標點：句首需大寫、句末需 . ? ！；Yes/No 後建議加逗號；若有問題請放入 errors.punctuation。
- 當學生語義正確但表述不同：isCorrect=true，teacherFeedback 簡述與標準答案差異（<=20字）。
- 若你對自己的評語不完全確定或可能遺漏某類錯誤，aiFeedbackOk=false 並在 aiFeedbackIssues 中列出原因。
- 僅輸出 JSON。`
    }
  },
  learning: {
    exampleGeneration: {
      template: '請為單詞 "${word}" 生成3個英文例句。對於每個例句，請提供英文、中文翻譯（使用香港繁體中文用字），以及一個英文單詞到中文詞語的對齊映射數組。請確保對齊盡可能精確。請只返回JSON格式的數組，不要有其他任何文字。格式為: [{"english": "...", "chinese": "...", "alignment": [{"en": "word", "zh": "詞語"}, ...]}, ...]'
    },
    sentenceChecking: {
      template: '請判斷以下這個使用單詞 "${word}" 的句子在語法和用法上是否正確: "${userSentence}"。如果正確，請只回答 "正確"。如果不正確，請詳細指出錯誤並提供一個修改建議，格式為 "不正確。建議：[你的建議]"。並總結錯誤的知識點。'
    }
  },
  article: {
    paragraph: {
      instructions: '只返回 JSON：{"chinese_translation":"..."}\n要求：\n- 翻譯請使用繁體中文符合香港中文習慣，不要廣東話。 英文姓名不用翻譯；\n- 用字遵從香港中文（例如：網上、上載、電郵、巴士、的士、單車、軟件、網絡、連結、相片）。\n- 若段落包含 Markdown 結構（如表格、清單、標題），請完整保留原始 Markdown 標記與行結構：\n  * 表格：保留每行的管線符號與對齊行（如 | --- |），不要將表格展平成普通句子。\n  * 清單：保留項目前綴（-、*、1. 等）與每項一行。\n  * 圖片：對於 Markdown 圖片標記（例如：![](URL) 或 ![alt](URL)），請保持原樣在輸出中，不要翻譯或改寫其中的 alt 文字，也不要移除；若圖片單獨成段，保留為同一 Markdown 行。\n- 不要返回 word_alignment 與 detailed_analysis。',
      user: '請對以下英文段落進行分析並返回嚴格有效的 JSON（不允許代碼塊或額外解釋）：\n\n段落: """\n${paragraph}\n"""\n\n${instructions}',
      fallback: '只返回 JSON：{"chinese_translation":"..."}\n請使用繁體中文符合香港中文習慣，不要廣東話。\n段落:"""\n${paragraph}\n"""'
    },
    sentence: {
      withStructure: '對下列英文句子進行分析，返回嚴格 JSON：\n${basePrompt}\n只返回：{\n  "sentence":"...",\n  "translation":"...",\n  "phrase_alignment":[{"en":"...","zh":"..."}],\n  "chunks":[{"text":"...","role":"...","note":"..."}],\n  "key_points":["..."]\n}\n${keyPointRule}',
      concise: '僅對下列英文句子進行精簡分析，返回嚴格 JSON：\n${basePrompt}\n只返回：{\n  "sentence":"...",\n  "translation":"...",\n  "key_points":["..."]\n}\n${keyPointRule}',
      fallback: '僅翻譯下列句子並提煉 2-3 條關鍵點（JSON，中文請使用繁體中文符合香港中文習慣，不要廣東話。）：\n{"sentence":"${sentence}","translation":"...","key_points":["..."]}'
    },
    wordTooltip: {
      template: '請針對下列句子中的目標詞進行語音/詞性/語義與句法作用的簡潔分析，返回嚴格 JSON（中文請使用繁體中文符合香港中文習慣，不要廣東話。）：\n詞: "${word}"\n句: "${sentence}"\n只返回：{"word":"...","sentence":"...","analysis":{"phonetic":"IPA","pos":"詞性","meaning":"中文意思","role":"語法作用（簡潔）"}}'
    },
    phraseAnalysis: {
      template: '針對句子中的選中片語給出簡潔解析（JSON，中文請使用繁體中文符合香港中文習慣，不要廣東話。）。\n請同時提供該片語的國際音標 IPA：若能提供片語整體讀音則給整體讀音；若無可靠整體讀音，可用逐詞 IPA 串接（用空格分隔）。\n選中: "${selection}"\n句子: "${sentence}"\n上下文: "${context}"\n只返回：{"selection":"...","sentence":"...","analysis":{"phonetic":"IPA","meaning":"...","usage":"...","examples":[{"en":"...","zh":"..."}]}}'
    }
  },
  ocr: {
    extract: { promptHint: '請將圖片中的文字內容完整擷取為純文字，保留原始換行與標點；不要翻譯或改寫。若為截圖，請忽略 UI 按鈕與雜訊，只輸出正文。' },
    grading: { defaultPrompt: '這是一張默寫單詞的相片。請直接在圖片中擷取學生書寫內容並進行批改：\n- 請忽略被手寫劃掉（刪去線）的詞字；\n- 逐行擷取學生書寫的英文單詞或短語，保留順序與原始大小寫；若某行同時有中文，請一併擷取；\n- 以提供的「標準詞表」作為唯一正確答案來源，逐行判斷英文拼寫是否正確；若該行含中文，檢查中文是否書寫正確；\n- 僅對錯誤的部分逐點指出（英/中），並給出建議修正；\n- 請返回嚴格 JSON 格式，不要任何多餘說明或程式碼框。JSON 需為：\n{\n  "items": [\n    {"line": "原始行文字", "english": "擷取到的英文", "chinese": "擷取到的中文(可空)", "correct": true|false,\n     "errors": [ {"type": "english|chinese", "expected": "標準答案或正確語義", "got": "書寫內容", "suggestion": "修正建議"} ]}\n  ],\n  "summary": {"total": 總行數, "correct": 正確行數, "wrong": 錯誤行數}\n}' }
  },
  import: {
    extractor: {
      system: 'You are a precise content extractor that outputs clean Markdown. Do not translate or add commentary.',
      rulesKeepImages: [
        '- 保留正文的結構：# 標題、段落、清單、表格、區塊引用、程式碼區塊（僅當確為程式碼）。',
        '- 將與正文相關的圖片保留為 Markdown 圖片行（![]()）。避免社交/廣告/追蹤用圖；為保留的圖片填入 alt（沿用原 alt 或鄰近 caption；不要改寫），URL 轉為絕對路徑。',
        '- 徹底移除網站導航、側欄、頁尾、Cookie 提示、語言切換、社交分享、推薦卡、廣告、留言模組、版權宣告。',
        '- 不要新增任何強調或裝飾標記：嚴禁使用 * 或 _ 產生粗斜體；不要輸出純裝飾分隔線（-----、_______、****、====、••• 等）或無意義圖示（▶︎◆•·►等）。',
        '- 僅輸出 Markdown 純文字，不要使用 ``` 程式碼圍欄，也不要額外解釋。',
        '- 解析相對 URL（連結與圖片）為絕對 URL，基於提供的 Base URL。',
        '- 對連結移除追蹤參數（utm_*、fbclid、ref 等），清理多餘空白，但不要改動正文語句與標點。'
      ],
      rulesNoImages: [
        '- 保留正文的結構：# 標題、段落、清單、表格、區塊引用、程式碼區塊（僅當確為程式碼）。',
        '- 移除所有圖片，不要以文字替代。',
        '- 徹底移除網站導航、側欄、頁尾、Cookie 提示、語言切換、社交分享、推薦卡、廣告、留言模組、版權宣告。',
        '- 不要新增任何強調或裝飾標記：嚴禁使用 * 或 _ 產生粗斜體；不要輸出純裝飾分隔線（-----、_______、****、====、••• 等）或無意義圖示（▶︎◆•·►等）。',
        '- 僅輸出 Markdown 純文字，不要使用 ``` 程式碼圍欄，也不要額外解釋。',
        '- 解析相對 URL（連結與圖片）為絕對 URL，基於提供的 Base URL。',
        '- 對連結移除追蹤參數（utm_*、fbclid、ref 等），清理多餘空白，但不要改動正文語句與標點。'
      ]
    }
  }
};
// 問答集校對模型別名（缺省時回退到 sentenceChecking）
if (!AI_MODELS.answerChecking) {
  AI_MODELS.answerChecking = AI_MODELS.sentenceChecking || 'gpt-4.1-mini';
}

// 文本轉語音（示例）
export const TTS_CONFIG = {
  baseUrl: 'https://your-tts.example.com',
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
  // 可選：你自己的 HTML 代理服務（例如 Cloudflare Worker），避免 CORS；格式例：'https://your-worker.example/fetch?url='
  PROXY_URL: undefined,
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
  AI_PROMPTS,
  ASSISTANT,
  TTS_CONFIG,
  QA_CHECK,
  OCR_CONFIG,
  ARTICLE_IMPORT,
  SUPABASE
};
export default __DEFAULT__;
// AI 助手（聊天）模型清單（示例）
// - 可用：純字串、'profile:model'、或 { profile, model }
export const ASSISTANT = {
  MODEL: 'gpt-4.1-mini',
  MODELS: [ 'gpt-4.1-mini', 'gpt-4.1-nano' ],
  DEFAULT_MODEL: undefined
};
