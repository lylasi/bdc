# AI 提示詞總覽（Prompts Inventory）

說明：本文件彙整專案中所有發送至 AI 的「上下文提示詞 / 指令模板」，並標註用途、程式位置、模型鍵與回退順序，方便集中維護與調整。若需快速跳轉，可依下方各區塊中的檔案路徑打開對應程式碼。

維護建議：
- 儘量維持「只輸出 JSON」類請求的嚴格格式，降低前端解析成本。
- 與「香港繁體中文」用字相關的規則請保持一致（如：網上/上載/電郵/巴士/的士/單車/軟件/網絡/連結/相片）。
- 如需調整模型，優先在 `ai-config.js` 內的 `AI_MODELS.*` 或以本機偏好 `settings.ai.models.*` 覆蓋，避免在程式中散落硬編。

---

## 詞彙 / 單詞分析（Dictionary）

用途：單詞音標、詞性、中文意思。
- 位置：modules/api.js:150
- 模型優先序：`settings.ai.models.wordAnalysis` → `AI_MODELS.wordAnalysis`

提示詞：
```
Please provide a detailed analysis for the word "${word}". Return the result in a strict JSON format with the following keys: "phonetic" (IPA), "pos" (part of speech), and "meaning" (the most common Traditional Chinese (Hong Kong) meaning). For example: {"phonetic": "ɪɡˈzæmpəl", "pos": "noun", "meaning": "例子"}. Ensure the meaning is in Traditional Chinese (Hong Kong) vocabulary (e.g., 網上/上載/電郵/巴士/的士/單車/軟件/網絡/連結/相片).
```

---

## 學習模塊（Learning）

1) 生成例句（3 條 + 中譯 + 對齊）
- 位置：modules/api.js:166
- 模型優先序：`settings.ai.models.exampleGeneration` → `AI_MODELS.exampleGeneration`

提示詞：
```
請為單詞 "${word.word}" 生成3個英文例句。對於每個例句，請提供英文、中文翻譯（使用香港繁體中文用字），以及一個英文單詞到中文詞語的對齊映射數組。請確保對齊盡可能精確。請只返回JSON格式的數組，不要有其他任何文字。格式為: [{"english": "...", "chinese": "...", "alignment": [{"en": "word", "zh": "詞語"}, ...]}, ...]
```

2) 造句檢查（正確/錯誤 + 建議 + 知識點）
- 位置：modules/api.js:178
- 模型優先序：`settings.ai.models.sentenceChecking` → `AI_MODELS.sentenceChecking`

提示詞：
```
請判斷以下這個使用單詞 "${word}" 的句子在語法和用法上是否正確: "${userSentence}"。如果正確，請只回答 "正確"。如果不正確，請詳細指出錯誤並提供一個修改建議，格式為 "不正確。建議：[你的建議]"。並總結錯誤的知識點。
```

---

## 文章詳解（Article Analysis）

1) 段落分析（最小輸出：只翻譯）
- 位置：modules/api.js:206（instructions 與 prompt），fallback：modules/api.js:279
- 模型優先序：`settings.ai.models.articleAnalysis` → `AI_MODELS.articleAnalysis`（內部仍保留到 `AI_MODELS.wordAnalysis` 的極端回退）

指令（instructions，片段被嵌入至主提示）：
```
只返回 JSON：{"chinese_translation":"..."}
要求：
- 翻譯請使用繁體中文符合香港中文習慣，不要廣東話。 英文姓名不用翻譯；
- 用字遵從香港中文（例如：網上、上載、電郵、巴士、的士、單車、軟件、網絡、連結、相片）。
- 若段落包含 Markdown 結構（如表格、清單、標題），請完整保留原始 Markdown 標記與行結構：
  * 表格：保留每行的管線符號與對齊行（如 | --- |），不要將表格展平成普通句子。
  * 清單：保留項目前綴（-、*、1. 等）與每項一行。
  * 圖片：對於 Markdown 圖片標記（例如：![](URL) 或 ![alt](URL)），請保持原樣在輸出中，不要翻譯或改寫其中的 alt 文字，也不要移除；若圖片單獨成段，保留為同一 Markdown 行。
- 不要返回 word_alignment 與 detailed_analysis。
```

主提示（含段落）：
```
請對以下英文段落進行分析並返回嚴格有效的 JSON（不允許代碼塊或額外解釋）：

段落: """
${paragraph}
"""

${instructions}
```

回退提示（最小翻譯）：
```
只返回 JSON：{"chinese_translation":"..."}
請使用繁體中文符合香港中文習慣，不要廣東話。
段落:"""
${paragraph}
"""
```

2) 句子詳解卡（含對齊/分塊/關鍵點 或精簡版）
- 位置：modules/api.js:336（主提示），fallback：modules/api.js:360
- 模型優先序：`settings.ai.models.articleAnalysis` → `AI_MODELS.articleAnalysis`

含結構版（includeStructure=true）：
```
對下列英文句子進行分析，返回嚴格 JSON：
${basePrompt}
只返回：{
  "sentence":"...",
  "translation":"...",
  "phrase_alignment":[{"en":"...","zh":"..."}],
  "chunks":[{"text":"...","role":"...","note":"..."}],
  "key_points":["..."]
}
${keyPointRule}
```

精簡版（includeStructure=false）：
```
僅對下列英文句子進行精簡分析，返回嚴格 JSON：
${basePrompt}
只返回：{
  "sentence":"...",
  "translation":"...",
  "key_points":["..."]
}
${keyPointRule}
```

回退提示：
```
僅翻譯下列句子並提煉 2-3 條關鍵點（JSON，中文請使用繁體中文符合香港中文習慣，不要廣東話。）：
{"sentence":"${sentence}","translation":"...","key_points":["..."]}
```

3) 點字彈窗（單詞詳解）
- 位置：modules/api.js:392
- 模型優先序：`settings.ai.models.articleWordTooltip` → `AI_MODELS.articleWordTooltip` → `settings.ai.models.wordAnalysis` → `AI_MODELS.wordAnalysis`

提示詞：
```
請針對下列句子中的目標詞進行語音/詞性/語義與句法作用的簡潔分析，返回嚴格 JSON（中文請使用繁體中文符合香港中文習慣，不要廣東話。）：
詞: "${word}"
句: "${sentence}"
只返回：{"word":"...","sentence":"...","analysis":{"phonetic":"IPA","pos":"詞性","meaning":"中文意思","role":"語法作用（簡潔）"}}
```

4) 片語解析（句卡「詳解」與工具提示「片語解析」）
- 位置：modules/api.js:404
- 模型優先序：`settings.ai.models.articlePhraseAnalysis` → `AI_MODELS.articlePhraseAnalysis` → `settings.ai.models.wordAnalysis` → `AI_MODELS.wordAnalysis`

提示詞：
```
針對句子中的選中片語給出簡潔解析（JSON，中文請使用繁體中文符合香港中文習慣，不要廣東話。）。
請同時提供該片語的國際音標 IPA：若能提供片語整體讀音則給整體讀音；若無可靠整體讀音，可用逐詞 IPA 串接（用空格分隔）。
選中: "${selection}"
句子: "${sentence}"
上下文: "${context}"
只返回：{"selection":"...","sentence":"...","analysis":{"phonetic":"IPA","meaning":"...","usage":"...","examples":[{"en":"...","zh":"..."}]}}
```

---

## OCR / 視覺

1) 單張圖片取字（可併發）
- 位置：modules/api.js:416
- 模型優先序：`opts.model` → `settings.ai.models.imageOCR|ocr` → `OCR_CONFIG.DEFAULT_MODEL|MODEL` → `AI_MODELS.imageOCR`

預設提示詞（可在 UI 覆蓋）：
```
請將圖片中的文字內容完整擷取為純文字，保留原始換行與標點；不要翻譯或改寫。若為截圖，請忽略 UI 按鈕與雜訊，只輸出正文。
```

常用模板（UI 下拉 presets，將附加到提示詞）：
- 位置：index.html:296-308
- 範例：
  - 只擷取：右下角藍色對話框
  - 只擷取：英文與數字
  - 正文轉寫，移除UI/雜訊
  - 試題模式：題幹+選項
  - 輸出格式：Markdown 清單
  - 小學生默寫單詞：檢查拼寫

2) 默寫批改（多張圖片 + 標準詞表）
- 位置：modules/api.js:493
- 模型優先序：`opts.model` → `settings.ai.models.imageOCR|ocr` → `OCR_CONFIG.DEFAULT_MODEL|MODEL` → `AI_MODELS.imageOCR`

預設提示詞（JSON 版）：
```
這是一張默寫單詞的相片。請直接在圖片中擷取學生書寫內容並進行批改：
- 請忽略被手寫劃掉（刪去線）的詞字；
- 逐行擷取學生書寫的英文單詞或短語，保留順序與原始大小寫；若某行同時有中文，請一併擷取；
- 以提供的「標準詞表」作為唯一正確答案來源，逐行判斷英文拼寫是否正確；若該行含中文，檢查中文是否書寫正確；
- 僅對錯誤的部分逐點指出（英/中），並給出建議修正；
- 請返回嚴格 JSON 格式，不要任何多餘說明或程式碼框。JSON 需為：
{
  "items": [
    {"line": "原始行文字", "english": "擷取到的英文", "chinese": "擷取到的中文(可空)", "correct": true|false,
     "errors": [ {"type": "english|chinese", "expected": "標準答案或正確語義", "got": "書寫內容", "suggestion": "修正建議"} ]}
  ],
  "summary": {"total": 總行數, "correct": 正確行數, "wrong": 錯誤行數}
}
```

---

## 文章導入 / HTML 清洗 → Markdown

用途：將抓到的完整 HTML 交給 AI，抽取「正文」並輸出乾淨 Markdown（不翻譯）。
- 位置：modules/api.js:848
- 模型優先序：`opts.model` → `ARTICLE_IMPORT.DEFAULT_MODEL|MODEL` → `AI_MODELS.articleAnalysis`

System（系統訊息）：
```
You are a precise content extractor that outputs clean Markdown. Do not translate or add commentary.
```

Rules（依是否保留圖片而變化，節錄）：
```
- 保留正文的結構：# 標題、段落、清單、表格、區塊引用、程式碼區塊（僅當確為程式碼）。
- 將與正文相關的圖片保留為 Markdown 圖片行（![]()）。避免社交/廣告/追蹤用圖；為保留的圖片填入 alt（沿用原 alt 或鄰近 caption；不要改寫），URL 轉為絕對路徑。
- 移除所有圖片（keepImages=false）。
- 徹底移除網站導航、側欄、頁尾、Cookie 提示、語言切換、社交分享、推薦卡、廣告、留言模組、版權宣告。
- 不要新增任何強調或裝飾標記；不要輸出純裝飾分隔線或圖示。
- 僅輸出 Markdown 純文字，不要使用 ``` 程式碼圍欄，也不要額外解釋。
- 解析相對 URL 為絕對 URL（基於 Base URL），並移除連結追蹤參數。
```

User（使用者訊息）：
```
Base URL: ${url}
規則：
${rules}

=== HTML 開始 ===
${html}
=== HTML 結束 ===
```

---

## 本機偏好（settings.ai.models.*）與覆蓋說明

- 來源：localStorage（鍵名 `pen_global_settings`），透過 `modules/settings.js` 的 `loadGlobalSettings()`/`saveGlobalSettings()` 讀寫。
- 用法：可在瀏覽器 Console 覆蓋，例如：
```
saveGlobalSettings({ ai: { models: { articleWordTooltip: 'tbai:gemini-2.5-flash-nothinking' } } })
```
- 目的：提供不改動程式碼與版本控制的細粒度模型/端點切換。

