# 2026-03-24 QA / Assistant Task Mapping 實際請求驗證

## 續作目標
延續 `docs/report/20260323235321243_ai_provider_playwright_context.md`，補做以下驗證：

1. QA 真正發請求時是否命中 `qaChecking` 對應的 provider / model
2. Assistant 真正發請求時是否命中 `assistant` 對應的 provider / model

本次重點是**驗證實際 request 組裝是否走到 task mapping**，而不是驗證外部第三方 AI 供應商本身是否可用。

---

## 驗證方法
使用 Playwright 在本地靜態伺服器上載入 SPA，並於頁面內預先寫入：

- `pen_global_settings.ai.providers`
- `pen_global_settings.ai.tasks`
- `pen_global_settings.ai.models`
- `pen_global_secrets.aiProviders`

測試注入值：

- `qaChecking -> qaMock:qa-model-x`
- `assistant -> asstMock:assistant-model-y`
- `qaMock.apiUrl -> https://qa-provider.local/v1/chat/completions`
- `asstMock.apiUrl -> https://assistant-provider.local/v1/chat/completions`
- `qaMock.apiKey -> qa-key`
- `asstMock.apiKey -> assistant-key`
- `assistant.stream = false`

之後在 Playwright 內攔截 `**/v1/chat/completions`：

- 記錄實際請求的 URL / Authorization / model / stream / response_format
- 回傳 mock response，避免依賴外部網絡與真實 provider 狀態

---

## 驗證結果

### 1. QA 命中 `qaChecking` task mapping
已直接在頁面內呼叫 `startAIChecking()`，捕獲到的 QA 請求如下：

- URL：`https://qa-provider.local/v1/chat/completions`
- Authorization：`Bearer qa-key`
- model：`qa-model-x`
- `response_format`：`{ "type": "json_object" }`
- `stream`：`false`

結論：

- QA 請求**確實使用了** `pen_global_settings.ai.tasks.qaChecking`
- provider 的 endpoint 與 secret key **確實來自**本機 provider override
- 沒有退回 static `API_URL` / `API_KEY`

這與程式路徑一致：

- `features/qa/qa-checker.js:43` 的 `getQaRequestConfig()` 先走 `resolveConfigConnection()` + `resolveAIRequestConfig()`
- `features/qa/qa-checker.js:291` 之後透過 `requestAI()` 真正發送
- `modules/api.js:152` 的 `resolveAIRequestConfig()` 會把 task spec 解析為 model / provider / endpoint / key
- `modules/api.js:394` 的 `requestAI()` 會以解析後的值實際送出 fetch

### 2. Assistant 命中 `assistant` task mapping
已切到文章頁，等待 `window.__assistant` 就緒後透過對外 API 發送訊息，捕獲到的 Assistant 請求如下：

- URL：`https://assistant-provider.local/v1/chat/completions`
- Authorization：`Bearer assistant-key`
- model：`assistant-model-y`
- `stream`：`false`
- 頁面最終收到回覆：`這是助手測試回覆。`

結論：

- Assistant 請求**確實使用了** `pen_global_settings.ai.tasks.assistant`
- provider endpoint / key **確實來自**本機 provider override
- 因本次設為 `assistant.stream = false`，Assistant 走的是非串流請求

這與程式路徑一致：

- `features/assistant/assistant.js:27` 的 `getAssistantModelOverride()` 優先讀 `ai.tasks.assistant`
- `features/assistant/assistant.js:48` 的 `getAssistantRequestConfig()` 走 `resolveAIRequestConfig({ task: 'assistant' ... })`
- `features/assistant/assistant.js:504` 的 `onceCompletions()` 透過 `requestAI()` 發送非串流請求
- 若 `assistant.stream = true`，則會走 `features/assistant/assistant.js:515` 的 `streamCompletions()`，同樣先由 `getAssistantRequestConfig()` 取得 endpoint / model / key

### 3. Assistant UI 狀態補充
本次注入 `assistant.enabled = true`，重新整理後頁面上存在：

- `#assistant-fab`

這與下列程式一致：

- `features/assistant/assistant.js:72`
- `features/assistant/assistant.js:121`

表示 assistant UI 啟用條件仍正常。

---

## 本次驗證的性質與邊界
這次驗證屬於：

- **前端 request routing / task mapping 驗證**
- **本機 settings / secrets override 驗證**
- **provider/model 實際請求組裝驗證**

這次**沒有**驗證：

1. 真實第三方 provider 是否接受該 model 名稱
2. 真實第三方 provider 是否回傳與目前 parsing 完全兼容的 payload
3. Assistant 在 `stream = true` 時，目標 provider 的 SSE / chunk 格式是否完全兼容
4. QA / Assistant 在真實 UI 完整操作流程中的所有邊界情況

也就是說：

- task mapping 這層目前已可確認**打通**
- 但若要做 provider 端到端驗證，下一步仍建議用真實 provider 再做一次 network 檢查

---

## 對原先待驗證清單的更新
來自上一份上下文文件中的待驗證項：

1. QA 真正發請求時是否命中 `qaChecking` 指定 provider/model
   - **本次已驗證完成**
2. Assistant 真正發請求時是否命中 `assistant` 指定 provider/model
   - **本次已驗證完成**
3. 在靜態 `API_URL` / `API_KEY` 留空、僅本機 override 存在時，QA 是否仍能正常走 AI 而不退回 basic mode
   - **本次已部分驗證**：從 request routing 角度看，確實可只靠本機 override 組出請求
   - **但尚未做「真實 provider 成功回應」的端到端驗證**
4. OCR / articleAnalysis / articleCleanup 等 task mapping 的端到端網路行為
   - **尚未驗證**

---

## 建議下個續作點
若要繼續，建議優先做以下其中一項：

1. 驗證 Assistant 在 `assistant.stream = true` 時，真實 provider 的串流格式是否與 `streamCompletions()` 相容
2. 用真實 provider 對 QA 做一次完整 UI 操作驗證，確認不是只有 mock response 能通
3. 擴充同樣的 Playwright 攔截驗證到：
   - `imageOCR`
   - `articleAnalysis`
   - `articleCleanup`

---

## 相關檔案
- `modules/api.js:104`
- `modules/api.js:152`
- `modules/api.js:394`
- `features/qa/qa-checker.js:43`
- `features/qa/qa-checker.js:76`
- `features/qa/qa-checker.js:291`
- `features/assistant/assistant.js:27`
- `features/assistant/assistant.js:48`
- `features/assistant/assistant.js:504`
- `features/assistant/assistant.js:515`
- `features/assistant/assistant.js:863`
- `features/sync/sync.js:312`
- `modules/settings.js:7`
- `modules/settings.js:77`
