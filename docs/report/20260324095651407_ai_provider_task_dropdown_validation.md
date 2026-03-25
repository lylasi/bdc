# AI Provider / Task Dropdown 驗證報告

## 本次修正
- 修正 `modules/ai-models.js` 的 `getTaskModelSelection()` 選擇優先序。
- 現在會優先採用已儲存的 task model，再退回 feature 傳入的 legacy/current 值，避免 OCR 被舊的 `ocr.model` 或靜態 `OCR_CONFIG.DEFAULT_MODEL` 誤蓋。

## 涉及檔案
- `modules/ai-models.js:577`

## 驗證方式
- 啟動本機靜態伺服器：`python3 -m http.server 4173 --directory /Users/linus/CODE/bdc`
- 使用 Playwright 以 localStorage 預置乾淨的 runtime provider / task model 狀態
- 驗證全局設定 modal、OCR、Assistant、文章導入清洗 / OCR 分頁

## 預置測試資料
- Providers:
  - `default`
  - `qaMock`
  - `articleMock`
- Task models:
  - `qaChecking = qaMock:qa-model-y`
  - `assistant = default:gpt-4.1-mini`
  - `imageOCR = qaMock:qa-model-x`
  - `articleCleanup = articleMock:article-cleaner`

## 驗證結果

### 1. OCR dropdown
- 路徑：`#ocr`
- 結果：通過
- 實際選中值：`qaMock:qa-model-x`
- 狀態：未 disabled
- 可見 options：
  - `default:gpt-4.1-mini`
  - `articleMock:article-cleaner`
  - `qaMock:qa-model-x`
  - `qaMock:qa-model-y`

### 2. Assistant dropdown
- 路徑：文章頁 AI 助手面板
- 結果：通過
- 實際選中值：`default:gpt-4.1-mini`
- 狀態：未 disabled

### 3. 全局設定 modal task mapping
- 結果：通過
- `imageOCR` 顯示 `qaMock:qa-model-x`
- `assistant` 顯示 `default:gpt-4.1-mini`
- `articleCleanup` 顯示 `articleMock:article-cleaner`
- `qaChecking` 顯示 `qaMock:qa-model-y`

### 4. discoveredModels 保存
- 結果：通過
- 重新打開 modal 並按下儲存後，以下 provider 的 `discoveredModels` 仍保留：
  - `default`
  - `qaMock`
  - `articleMock`
- 未再出現保存後清空的問題

### 5. 文章導入清洗模型
- 結果：通過
- 打開文章導入預設 URL 分頁時，`#imp-ai-clean-model` 選中：`articleMock:article-cleaner`
- 狀態：未 disabled

### 6. 文章導入 OCR 模型
- 結果：通過
- 將 `importArticle.activeTab` 設為 `ocr` 後開啟導入 modal，`#imp-ocr-model` 選中：`qaMock:qa-model-x`
- 狀態：未 disabled

## 觀察到的既有狀態
- runtime provider registry 仍會合併靜態 `ai-config.js` 內的 provider，因此全局設定中除了測試注入的 provider，仍可看到 `bohe`、`dabai`、`gj`、`hyb`、`lfy`、`tbai`。
- 這是目前設計預期，因為 registry 會合併 static + runtime provider，不屬於本次 bug。

## 結論
- OCR 先前出現的 `bohe:gemini-2.5-flash（目前值，未在允許清單）` 問題已修正。
- shared AI model registry 的 task selection 優先序目前符合預期。
- 本輪手動驗證覆蓋的共享 dropdown 路徑均正常。
