# AI Provider + Task Mapping 實施紀錄

## 已完成內容

### 1. 統一 AI 解析核心
- `modules/api.js` 已作為主要解析入口。
- 目前由共用 helper 處理：
  - task -> model spec
  - provider / profile -> endpoint / key
  - local settings / secrets override
  - `provider:model` 與舊格式相容

### 2. QA 模組收斂到共用解析
- 檔案：`features/qa/qa-checker.js`
- 變更：
  - 移除只依賴靜態 `API_URL` / `API_KEY` 的 early gate。
  - 改為透過 `resolveConfigConnection()` + `resolveAIRequestConfig()` 判斷是否可用。
  - AI 校對請求改走 `requestAI()`。
  - 保留原有 prompt、JSON 解析、fallback 行為。
- 結果：
  - 本機 provider override 存在時，QA 不會再誤退回 basic mode。

### 3. Assistant 模組收斂到共用解析
- 檔案：`features/assistant/assistant.js`
- 變更：
  - 移除本檔自建的 provider/model parsing。
  - 改由 `resolveAITaskSpec()` / `resolveAIRequestConfig()` 取得 assistant task 的最終模型與端點。
  - 非串流請求改走 `requestAI()`。
  - `assistant.stream` 改為使用 `saveGlobalSettings()` 持久化。
  - assistant 模型下拉儲存時，同步寫入：
    - `settings.ai.tasks.assistant`
    - `settings.ai.models.assistant`（保留相容）

### 4. 全局設定 modal 改為 provider + task mapping 入口
- 檔案：`features/sync/sync.js`
- 變更：
  - 新增靜態 AI provider/task 視圖資料 helper。
  - `requireOrImportSettings()` 現在會組合：
    - 靜態 `AI_PROVIDERS` / `AI_TASKS`
    - 本機 `settings.ai.providers`
    - 本機 `settings.ai.tasks`
    - 本機 `secrets.aiProviders`
  - settings modal AI 區塊改為：
    - Provider 設定列表（apiUrl / apiKey）
    - Task -> model mapping 列表
  - 儲存時寫入：
    - `settings.ai.providers`
    - `settings.ai.tasks`
    - `secrets.aiProviders`
  - 同時保留舊欄位相容：
    - `settings.ai.apiUrl`
    - `settings.ai.models`
    - `secrets.aiApiKey`

## 目前相容策略
- 保留舊欄位讀取與寫入，避免既有功能立即失效。
- 新結構為主要來源：
  - providers: `settings.ai.providers` + `secrets.aiProviders`
  - tasks: `settings.ai.tasks`
- 舊結構仍保留作過渡：
  - `settings.ai.models`
  - `settings.ai.apiUrl`
  - `secrets.aiApiKey`

## 已確認項目
- `features/qa/qa-checker.js` 無 IDE diagnostics。
- `features/assistant/assistant.js` 無 IDE diagnostics。
- `features/sync/sync.js` 無 IDE diagnostics。

## 尚未做的驗證
由於本專案沒有自動化測試，仍建議手動驗證：
1. gear -> 全局設定 中修改 provider 與 task mapping。
2. 驗證 QA 校對是否使用指定 provider/model。
3. 驗證 Assistant 是否跟隨 `assistant` task mapping。
4. 驗證 `assistant.stream` 重新整理後仍保留。
5. 驗證 default provider 與 legacy fallback 在未完整設定時仍可工作。

## 相關檔案
- `modules/api.js`
- `features/qa/qa-checker.js`
- `features/assistant/assistant.js`
- `features/sync/sync.js`
- `modules/settings.js`
- `ai-config.js`
- `ai-config.example.js`
