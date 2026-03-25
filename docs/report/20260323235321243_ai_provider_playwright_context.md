# 2026-03-23 AI Provider/Model Mapping 與 Playwright 驗證上下文

## 本輪工作目標
只聚焦於 **AI providers 與 models 更容易配置**，不擴大到 TTS、Supabase、sync 或整體 settings 重構。

使用者已選定的方向：
- **Provider Registry + Task Mapping**
- gear → **全局設定 modal** 作為主要 AI 設定入口
- `modules/api.js` 作為 provider/model/endpoint/key 的統一解析入口
- `features/qa/qa-checker.js`、`features/assistant/assistant.js` 不再各自做一套解析

## 已完成的主要代碼方向
參考既有文件：
- `docs/plan/20260323123000000_ai_provider_model_mapping.md`

該文件已記錄本輪已完成的核心實作：
- `modules/api.js` 統一 AI 解析
- `features/qa/qa-checker.js` 改走共用解析與 `requestAI()`
- `features/assistant/assistant.js` 改走共用解析，且 `assistant.stream` 改為經由 `saveGlobalSettings()` 持久化
- `features/sync/sync.js` 的全局設定 modal 改成 provider + task mapping 入口
- 保留 legacy 相容欄位：
  - `settings.ai.apiUrl`
  - `settings.ai.models`
  - `secrets.aiApiKey`
  - `AI_PROFILES`
  - `AI_MODELS`
  - `provider:model` / 舊格式相容

## 本次續做時發現並修復的 UI 問題
### 問題
全局設定 modal 能打開，但 AI Provider / AI Task 區塊是空的。

### 根因
`features/sync/sync.js` 的 `requireOrImportSettings()` 會呼叫：
- `buildAiSettingsViewState()`

但該 helper 在檔案內缺失，導致 UI 沒有 provider/task rows。

### 已修復
已在 `features/sync/sync.js` 補回 `buildAiSettingsViewState()`，配合既有 helper：
- `getStaticAiProviders()`
- `getStaticAiTasks()`
- `getAiTaskFieldList()`
- `stringifyAiSpec()`

修復後，Playwright 確認 AI 設定區已恢復正常渲染。

## Playwright 驗證結果
### 基本載入
- 使用本地靜態伺服器載入 `index.html`
- 頁面正常進入 SPA
- 全局設定 modal 可正常打開

### 全局設定 modal 驗證
已確認：
- AI Provider 區正常渲染
- AI Task 映射區正常渲染
- provider 數量：`7`
- task 數量：`8`

可見 provider 包含：
- `default`
- `tbai`
- `lfy`
- `gj`
- `dabai`
- `hyb`
- `bohe`

可見 task 包含：
- `wordAnalysis`
- `sentenceChecking`
- `qaChecking`
- `articleAnalysis`
- `articleCleanup`
- `exampleGeneration`
- `imageOCR`
- `assistant`

### 已驗證的保存/回填資料
曾透過 modal 填入並成功保存：
- default provider URL：`https://example.com/v1/chat/completions`
- default provider key：`test-key-default`
- `qaChecking`：`tbai:test-model`
- `assistant`：`hyb:gemini-2.5-flash`

保存後在 localStorage 觀察到：
- `pen_global_settings`
- `pen_global_secrets`
都已更新

且重新打開 modal 後，值會正確回填。

### `assistant.stream` 驗證
最終已確認：
- `pen_global_settings.assistant.stream === false`
- 重新打開全局設定 modal 後：
  - `#gs-assistant-stream` 為未勾選
  - `#gs-assistant-enabled` 為未勾選

此外也確認：
- 在 `assistant.enabled = false` 狀態下，頁面上沒有 `#assistant-fab`

這說明：
- global settings modal 對 assistant 開關的保存有效
- `assistant.stream` 的持久化有效
- `assistant.enabled` 對 UI 顯示條件有效

## 對 `features/assistant/assistant.js` 的補充確認
已再次檢查到：
- `getAssistantModelOverride()` 會優先讀：
  - `loadGlobalSettings().ai.tasks.assistant`
  - fallback `ai.models.assistant`
- `getAssistantRequestConfig()` 會走：
  - `resolveAIRequestConfig({ task: 'assistant', model: ... })`
- panel 內部的 `#assistant-stream` change 事件會：
  - `saveGlobalSettings({ assistant: { stream: ev.target.checked } })`
- 模型下拉儲存時同時寫入：
  - `ai.tasks.assistant`
  - `ai.models.assistant`

## 對 `features/sync/sync.js` / `modules/settings.js` 的補充確認
### `features/sync/sync.js`
儲存時會寫入：
- `saveGlobalSettings({ ai: { apiUrl, models, providers, tasks }, ... assistant: { enabled, stream } })`
- `saveGlobalSecrets({ aiApiKey, aiProviders, ttsApiKey })`

重讀時會從 localStorage 合併：
- `settings.ai.providers`
- `settings.ai.tasks`
- legacy `settings.ai.models`
- `settings.assistant.enabled`
- `settings.assistant.stream`
- `secrets.aiProviders`
- `secrets.aiApiKey`

### `modules/settings.js`
已確認：
- defaults 內含：
  - `ai.providers`
  - `ai.tasks`
  - `assistant.enabled`
  - `assistant.stream`
- `mergeSettings()` 會深層合併：
  - `ai.models`
  - `ai.providers`
  - `ai.tasks`
  - `tts.selectedVoices`
  - `reading`
  - `assistant`
- `mergeSecrets()` 會合併：
  - `aiProviders`

## 背景 server task 失敗說明
有 3 個背景 server task 失敗：
- `bhexwa79c`
- `boba0ch7m`
- `bkjgo1i2a`

原因一致：
- `OSError: [Errno 48] Address already in use`

即：嘗試啟動靜態伺服器時，對應 port 已被占用。
這不是專案程式錯誤，也不影響已完成的 Playwright 驗證結論。

## 目前工作狀態
### 已完成
- 全局設定 modal 的 AI provider/task UI 渲染修復
- Playwright 驗證保存與回填
- `assistant.stream = false` 持久化驗證
- `assistant.enabled = false` 時 assistant FAB 不顯示

### 尚未深入驗證
雖然架構與設定路徑已確認，但以下仍屬「可選的後續手動/瀏覽器驗證」：
1. QA 真正發請求時是否命中 `qaChecking` 指定 provider/model
2. Assistant 真正發請求時是否命中 `assistant` 指定 provider/model
3. 在靜態 `API_URL` / `API_KEY` 留空、僅本機 override 存在時，QA 是否仍能正常走 AI 而不退回 basic mode
4. 更完整檢查 OCR / articleAnalysis / articleCleanup 等 task mapping 的端到端網路行為

## 建議下次接續時可做的第一步
如果要繼續這條線，建議直接從以下任一項開始：
1. 用 Playwright / 瀏覽器 Network 驗證 QA 的 `qaChecking` 實際請求端點與 model
2. 驗證 Assistant 發送訊息時是否使用 `assistant` task mapping 對應的 provider/model
3. 檢查是否需要把目前測試留下的 localStorage 測試值恢復

## 相關檔案
- `features/sync/sync.js`
- `features/assistant/assistant.js`
- `features/qa/qa-checker.js`
- `modules/api.js`
- `modules/settings.js`
- `ai-config.js`
- `docs/plan/20260323123000000_ai_provider_model_mapping.md`
