# 儲存庫指引（AGENTS.md）

本文件提供給所有 AI 代理與自動化程式，協助快速掌握 `bdc` 專案的最新程式結構、開發規範與安全守則。所有敘述請使用繁體中文。

---

## 專案結構與模組劃分

整個應用是純靜態網站，以 `index.html`、`styles.css` 與 `main.js` 為骨幹：

| 範疇 | 路徑 | 說明 |
| --- | --- | --- |
| 入口 | `index.html` | SPA 主畫面，預先擺放九個功能區塊的 DOM。 |
|  | `styles.css` | 全域樣式、各模組子樣式、響應式設定。 |
|  | `main.js` | 入口腳本，載入資料、初始化所有功能模組、控制導航與 hash routing。 |
| 通用 UI | `test-floating-statusbar.html` | 手動測試平台偵測與浮動控制。 |

### 共享模組（`modules/`）

| 檔案 | 職責摘要 |
| --- | --- |
| `state.js` | 全域狀態、旗標與 helper getter。 |
| `dom.js` | 集中管理所有 DOM 選擇器，嚴禁在功能模組內直接 `document.querySelector`。 |
| `storage.js` | localStorage 初始化、詞書/文章/設定的持久化。 |
| `api.js` | AI 請求封裝（單字解析、句子/段落分析、QA 校對、OCR 後處理等）。 |
| `audio.js` | Web Audio / SpeechSynthesis 控制與解鎖。 |
| `ui.js` | 模態框、數字步進器、訊息條、提示框。 |
| `platform.js` | 平台偵測、視窗高度、安全區、可見性 API。 |
| `settings.js` | 全域設定與秘密資料（AI 模型、TTS、閱讀偏好、助手開關）。 |
| `cache.js` | IndexedDB + localStorage 雙層快取與 TTL 管理。 |
| `local-backup.js` | 內建快照備份與回復。 |
| `markdown.js` | 輕量 Markdown→HTML（OCR/報表共用）。 |
| `sync-core.js` / `sync-signals.js` / `sync-supabase.js` | 雲端同步序列化、資料變更事件與 Supabase 介面。 |
| `validate.js` | 表單與輸入驗證 helpers。 |
| `vocab.js` | 跨模組的詞彙增刪與預設詞書維護。 |
| `voices.js` | 聲音清單載入與快取（搭配 `voices*.json`）。 |
| `fonts/` | 字型子集與載入器。 |

> **規則**：新增共享邏輯前，必須先檢查是否能復用既有模組；若需擴充 `dom.js` 或 `state.js`，同步更新相關文件。

### 功能模組（`features/<name>/`）

| 模組 | 入口函式 | 功能摘要 |
| --- | --- | --- |
| `vocabulary/` | `initVocabulary()` | 詞書 CRUD、匯入匯出、URL 導入。 |
| `learning/` | `initLearning()` | AI 單字詳解、例句產生、語音播放。 |
| `dictation/` | `initDictation()` | 聽寫題組、計時、暫停/恢復、評分與歷史。 |
| `quiz/` | `initQuiz()` | 測驗題庫、倒數與計分；跨模組旗標 `state.quizInProgress`。 |
| `article/` | `initArticle()` | 文章載入、難度分析、朗讀控制。 |
| `ocr/` | `initOCR()` | 圖片/相機 OCR、拖放、Markdown 預覽與模板提示。 |
| `qa/` | `init()` | 問答集管理、訓練流程、AI 校對、PDF 匯出。 |
| `sync/` | `initSync()` | Supabase 登入/登出、OTP、即時同步、懸浮齒輪設定。 |
| `assistant/` | `initAiAssistant()` | 文章頁專用 AI 助手 FAB + 面板、對話儲存、Markdown 回覆。 |

每個模組都要輸出 `init*` 函式，並由 `main.js` 在 `DOMContentLoaded` 後呼叫。禁止在未初始化前操作 DOM。

### 資料與內容

- `wordlists/`: 各冊/各單位詞書 JSON 與 `manifest.json`。
- `articles/`: 文章內容 JSON，搭配生成腳本。
- `qa-sets/`: 問答模板與訓練資料。
- `voices.json` / `voices.min.json`: TTS 聲音清單（使用 `scripts/update-voices.sh` 更新）。
- `ai-config.example.js`: 範例設定；複製成 `ai-config.js` 並填入真正 API key、模型、TTS/OCR/QA/Assistant 設定。

## 建置與開發命令

在專案根目錄執行：

```bash
npx serve .
# 或
npx http-server -c-1 .
```

> 這兩個指令可提供 ES Module 需要的 HTTP 服務；第二個停用快取，方便除錯 storage 相關功能。

## 程式風格與命名

- 目標語法：ES2022，縮排 4 spaces，字串使用單引號。
- 優先使用 `const`/`let`，函式與變數採 `camelCase`，類別/命名空間採 `PascalCase`。
- DOM 操作一律透過 `modules/dom.js`；若需新增節點存取器，請集中更新該檔並保持命名一致。
- 大型檔案接近 300 行就拆分至同層 helper（例如 `features/qa/qa-creator.js`）。
- 行內註解僅針對複雜邏輯或 TODO，必要時標註負責人縮寫。

## 測試與驗證

- 自動化測試尚未建立；重大改動需手動巡檢九大模組。
- `test-floating-statusbar.html`：每次處理平台偵測、浮動控制或持久化相關改動後必須開啟檢查。
- QA 功能改動時，同步更新 `qa-sets/*.json` 並在 PR 描述中標註使用的測試資料集。
- AI / Supabase 整合需以真實 API key 測試；若無法執行，請撰寫清楚的驗證步驟供 reviewer 跟進。

## Commit 與 PR 規則

- 指令前綴遵循 Conventional Commit（`feat:`, `fix:`, `chore:` 等），摘要可使用中文或英文。
- 單一分支僅處理一個主題；PR 需連結需求文件或追蹤單。
- PR 描述需紀錄手動驗證步驟、設定變更、資料遷移、以及（若有）影像前後對照。

## 安全與配置

- 部署前請將 `ai-config.example.js` 複製為私有的 `ai-config.js`，並確保該檔未被提交。
- 新增外部 API 時，必須在 `modules/api.js` 撰寫速率限制、錯誤回退與 UI Thread 保護說明。
- 釋出前檢查 `wordlists/`、`articles/`、`qa-sets/` 等內容，確保不含敏感資訊。
- 雲端同步採 Supabase，相關金鑰只可透過 `ai-config.js` 或瀏覽器本地儲存注入，不得硬編碼。

---

如需擴充開發指引，請更新此檔並同步通知專案維運者。

#使用繁體中文
