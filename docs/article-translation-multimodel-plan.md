# 多模型翻譯兼容與限流改進計畫

## 目標

優化文章詳解中的翻譯能力，讓以下場景在 GPT、Gemini 與其他兼容 OpenAI API 的模型上都更穩定：

1. 整段翻譯
2. 句子翻譯
3. 單詞在句子中的翻譯／解釋
4. 片語在句子中的翻譯／解釋

同時控制請求並發，降低 429、超時、格式漂移與單一 API 過載的風險。

---

## 一、目前問題原因

### 1. 任務類型拆分不清，太多功能共用同一模型
目前：
- `modules/api.js:247` 的段落分析用 `articleAnalysis`
- `modules/api.js:388` 的句子分析也用 `articleAnalysis`
- `modules/api.js:347` 的單詞句中解釋，實際又回退到 `wordAnalysis`
- `modules/api.js:448` 的片語解析也會回退到 `wordAnalysis`

問題：
- 同一模型同時承擔長段翻譯、句法拆解、詞義分析、片語解釋，對不同模型不夠友好。
- GPT-4.1-mini 容錯高時看起來沒問題，但 Gemini 類模型更容易在某些任務失穩。

例子：
- 同一個 `gemini-flash-latest` 既要翻譯整段，又要輸出句子 chunks，又要給單詞 role。
- 長上下文 + JSON + 多欄位約束混在一起時，Gemini 更容易漏欄位或跑偏。

### 2. JSON 要求過重，跨模型兼容性不足
目前：
- `modules/api.js:257`、`356`、`402`、`458` 都要求嚴格 JSON。

問題：
- GPT 往往能穩定遵守；Gemini、部分代理端點、轉發服務常會：
  - 多包一層 markdown code fence
  - 多說一句說明文字
  - 漏欄位
  - 欄位名漂移
  - 把陣列改成字串

例子：
- 期望：`{"translation":"..."}`
- 實際可能變成：
  - ```json ... ```
  - `以下是翻譯結果：{"translation":"..."}`
  - `{"translated_text":"..."}`

### 3. 目前的 fallback 還不夠針對「多模型格式漂移」
目前：
- `requestAI()` 會重試 429 / 5xx：`modules/api.js:131-160`
- `analyzeParagraph()` 與 `analyzeSentence()` 有 fallback

問題：
- 現有 fallback 更偏向「請求失敗」而不是「輸出格式半正確但不可直接 parse」。
- 多模型場景下，最常見的不是完全失敗，而是**有內容但格式不穩**。

例子：
- 模型其實翻譯成功，但欄位叫 `translated` 而不是 `translation`。
- 現在可能直接判定失敗，浪費一次本可救回的結果。

### 4. 缺少全局任務隊列，前端多入口會同時打爆 API
目前：
- 段落分析在 `features/article/article.js:1651` 有本地 `CONCURRENCY = 2`
- 失敗重試在 `features/article/article.js:3247` 也限制到 2
- 但句子詳解、片語詳解、點詞彈窗、選中解析沒有統一全局排隊

問題：
- 使用者一邊跑整篇段落翻譯，一邊快速點句子、點單詞、選片語，會讓多種請求同時命中同一 API。
- 即使單個入口有限流，整體仍可能壓垮端點。

例子：
- 一篇 20 段文章正在翻譯。
- 使用者連點 5 個句子、3 個單詞。
- 前端瞬間就可能疊出十多個請求。

### 5. 缺少按「任務類型」設計的模型選擇與降級鏈
目前：
- `ai-config.js:37-53` 幾乎全部都設為 `gemini-flash-latest`

問題：
- 沒有針對不同任務選擇最穩的模型。
- 也沒有明確的主模型／備用模型機制。

例子：
- 段落翻譯比較適合穩定長文本模型。
- 句子翻譯適合短文本 JSON 輸出穩定的模型。
- 單詞句中義適合輕量短上下文模型。
- 這三種不應強行共用一個設定。

### 6. 單詞／片語任務目前混合了太多分析維度
目前：
- `analyzeWordInSentence()` 不只要 meaning，還要 phonetic / pos / role：`modules/api.js:356-359`
- `analyzeSelection()` 還要 phonetic / meaning / usage / examples：`modules/api.js:458`

問題：
- 這對 GPT 還好，對 Gemini 與代理端點常常太重。
- 使用者真正最核心的需求，通常先是「這裡是什麼意思」。

例子：
- 模型可能其實能正確翻出 meaning，卻因為 phonetic 或 examples 格式不合，整個結果被判失敗。

---

## 二、改進方向

### 建議 1：把翻譯任務明確拆成 4 類
新增或重構成以下任務：

1. `paragraphTranslation`
   - 只關心段落翻譯
   - 可選少量 key points

2. `sentenceTranslation`
   - 只關心句子翻譯
   - 可選 key points

3. `wordInSentenceMeaning`
   - 單詞在句中的核心意思
   - 可選詞性與 role，但 meaning 優先

4. `phraseInSentenceMeaning`
   - 片語在句中的核心意思
   - usage / examples 屬進階資訊

目的：
- 讓每類任務 schema 更小。
- 降低模型跑偏機率。

### 建議 2：不要再讓所有翻譯任務共享 `articleAnalysis`
建議在模型配置中拆出：

- `articleParagraphTranslation`
- `articleSentenceTranslation`
- `articleWordTranslation`
- `articlePhraseTranslation`

目的：
- 可以按任務挑模型。
- 以後切換模型時更容易定位問題。

例子：
- 段落翻譯：可用較穩的 GPT 或更適合長文本的模型
- 單詞／片語：可用更快更便宜的模型

### 建議 3：縮小 JSON schema，先保證「能用」
建議把返回結構先壓小：

#### 段落翻譯
```json
{
  "translation": "..."
}
```

進階模式再加：
```json
{
  "translation": "...",
  "key_points": ["...", "..."]
}
```

#### 句子翻譯
```json
{
  "translation": "...",
  "key_points": ["..."]
}
```

#### 單詞在句中
```json
{
  "word": "...",
  "meaning": "...",
  "role": "..."
}
```

#### 片語在句中
```json
{
  "selection": "...",
  "meaning": "...",
  "usage": "..."
}
```

目的：
- 跨模型時先保住核心字段。
- 非核心欄位缺失時，不至於整個請求報廢。

### 建議 4：設計三層解析策略，而不是只做一次 JSON.parse
每個翻譯請求都走三層：

#### 第一層：標準 JSON 響應
- 直接 parse
- 通過 schema 驗證

#### 第二層：容錯修復
- 去掉 code fence
- 抽取第一段 `{...}` JSON
- 接受欄位別名，如：
  - `translated_text` -> `translation`
  - `chinese_translation` -> `translation`
  - `gloss` -> `meaning`

#### 第三層：純文本兜底
若模型根本不回 JSON：
- 段落／句子：把整段文本當 `translation`
- 單詞／片語：把第一行或全文當 `meaning`

目的：
- 對 Gemini / 代理服務更友好。
- 把「半成功」盡量救回來。

### 建議 5：加全局 AI 請求隊列
在 `modules/api.js` 或新共享模組內增加統一排隊器：

按 `endpoint + model + taskType` 建立隊列。

建議並發：
- 段落翻譯：1~2
- 句子翻譯：2
- 單詞／片語：1

附加控制：
- 每個隊列請求之間加 200~500ms 間隔
- 遇到 429 時整個隊列退避，不只是單請求重試
- 同類短時間重複請求做 dedupe

目的：
- 降低同一 API 同時被多種 UI 行為打爆的風險。

例子：
- 使用者連點 6 個單詞
- 現在：可能同時發 6 個請求
- 改後：排隊 1 個個發出，體驗更穩

### 建議 6：給每類任務做主模型 + 備用模型
例如：
- 段落翻譯：主模型 A，備用模型 B
- 句子翻譯：主模型 C，備用模型 B
- 單詞翻譯：主模型 D，備用模型 C

失敗時：
1. 主模型請求
2. 主模型格式修復
3. 備用模型請求
4. 備用模型格式修復
5. 純文本保底

目的：
- 讓某個模型不穩時不至於整個功能失效。

### 建議 7：對單詞／片語任務採用「核心優先」
第一優先只拿：
- `meaning`
- `translation`

第二優先才補：
- `pos`
- `role`
- `usage`
- `examples`
- `phonetic`

目的：
- 先保證使用者看到能用的翻譯結果。
- 進階資訊缺失時不要阻塞主流程。

---

## 三、具體修改建議（文件級別）

### 1. `modules/api.js`
重點修改：
- 抽出統一翻譯任務層
- 增加多模型容錯解析
- 增加全局請求隊列／限流
- 增加主模型／備用模型降級鏈

建議新增能力：
- `requestAIQueued()`
- `parseStructuredAIResponse()`
- `normalizeTranslationFields()`
- `translateParagraph()`
- `translateSentence()`
- `translateWordInSentence()`
- `translatePhraseInSentence()`

### 2. `modules/validate.js`
重點修改：
- 驗證器改成更寬容但仍可控
- 核心字段為主，非核心字段可選

例如：
- 段落翻譯只要求 `translation`
- 單詞句中只要求 `word` + `meaning`

### 3. `features/article/article.js`
重點修改：
- 段落翻譯改調新 API
- 句子詳解卡改成翻譯優先、分析可選
- 點詞／片語詳解改成 meaning-first
- 與全局隊列整合，避免 UI 各入口自己亂發

### 4. `ai-config.js`
重點修改：
- 增加分任務模型配置
- 為不同任務設主模型與備用模型
- 增加可調整的並發與節流參數

可考慮新增：
- `AI_LIMITS`
- `AI_MODELS.articleParagraphTranslation`
- `AI_MODELS.articleSentenceTranslation`
- `AI_MODELS.articleWordTranslation`
- `AI_MODELS.articlePhraseTranslation`
- 備用模型欄位或模型列表

---

## 四、建議效果示例

### 例 1：段落翻譯
原文：
`The policy was introduced quietly, but it quickly became a flashpoint for a wider debate about accountability.`

理想返回：
```json
{
  "translation": "這項政策原本在低調情況下推出，但很快便成為一場更廣泛、圍繞問責問題的爭論焦點。"
}
```

若 Gemini 多說一句：
`以下是翻譯：{"translation":"..."}`

系統應能自動抽取 JSON，而不是整體失敗。

### 例 2：句子翻譯
理想返回：
```json
{
  "translation": "然而，外界原以為只是技術調整，最終卻演變成政治爭議。",
  "key_points": [
    "turned into 表示逐步演變",
    "句子重點在預期落差"
  ]
}
```

若模型只回純文本：
`然而，外界原以為只是技術調整，最終卻演變成政治爭議。`

系統仍應保底顯示翻譯。

### 例 3：單詞在句中
原句：
`The move was widely seen as symbolic rather than practical.`

點詞：`symbolic`

理想返回：
```json
{
  "word": "symbolic",
  "meaning": "象徵性的",
  "role": "在句中用來形容這項舉措偏向表態意義，而非實際效果"
}
```

若模型只回：
`象徵性的`

系統也應能保底展示為 meaning。

---

## 五、實施順序

1. 先整理翻譯任務分層與新 schema。
2. 再改 `modules/api.js`：
   - 隊列
   - 限流
   - 容錯解析
   - 降級鏈
3. 再改 `modules/validate.js` 的驗證規則。
4. 再接 `features/article/article.js`，把段落／句子／點詞／片語翻譯切到新接口。
5. 最後整理 `ai-config.js`，加入任務級模型配置與限流參數。

---

## 六、待你確認

如果你同意，我下一步就按這份計畫開始修改，優先先動：
1. `modules/api.js`
2. `modules/validate.js`
3. `ai-config.js`
4. `features/article/article.js`
