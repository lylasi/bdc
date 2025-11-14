# CLAUDE.md

本文件提供給具備原始碼存取權的 AI/代理協作者，快速理解專案結構、模組邊界與開發約束。所有敘述以繁體中文撰寫，並盡量對齊目前的代碼現狀（2025-11-14）。

## 變更紀錄

### 2025-11-14 13:01 CST — 代碼結構刷新
- ✅ 全面改寫模組結構圖與索引，納入 OCR / QA / 同步 / AI 助手等新模組
- ✅ 將敘述轉為繁體中文並同步啟動指令（`npx serve .`、`npx http-server -c-1 .`）
- ✅ 補齊共享模組（settings、cache、markdown、local-backup、sync-*、vocab、voices）與資料夾說明

### 2025-09-15 23:44:59 — AI 上下文優化更新
- ✅ 更新專案結構分析與覆蓋率統計
- ✅ 驗證既有模組化架構完整性
- ✅ 優化模組結構圖與導覽體系
- ✅ 確認所有功能模組與共享模組的實作狀態

### 2025-09-14 23:20:57 — AI 上下文初始化
- ✅ 完成專案 AI 上下文初始化與模組化文件梳理
- ✅ 辨識核心功能模組與共享模組
- ✅ 產生模組結構圖與導覽體系
- ✅ 建立完整的 AI 開發指引文件

## 專案願景

PEN 子背單字是一款重視離線體驗與 AI 增強的單頁應用（SPA）。它提供單字本管理、智慧學習、聽寫與測驗訓練、文章解析、OCR 文字抽取、問答練習、Supabase 雲端同步，以及 AI 助手輔助閱讀等功能。整體採現代 ES 模組語法，前端純靜態部署即可執行。

## 架構總覽

應用分為三層：
1. **表示層**：`index.html` + `styles.css` 負責外觀與排版，`main.js` 掛載模組、導覽與全域監聽。
2. **功能層**：`features/<module>/` 內的九大功能模組，皆暴露 `init*` 入口並各自管理事件與狀態同步。
3. **服務層**：`modules/` 內的共享服務（狀態、DOM、儲存、AI、音訊、平台、設定、快取、同步、字型、語音等）。

## 模組結構圖

```mermaid
graph TD
    A["🏠 PEN 子背單字<br/>(根目錄)"] --> B["⚙️ modules<br/>(共享服務層)"]
    A --> C["🧩 features<br/>(功能模組)"]
    A --> D["📚 data<br/>(wordlists / articles / qa-sets)"]
    A --> E["📜 docs + @docs"]
    A --> F["🛠 scripts"]

    subgraph B[modules]
        B1[state.js]
        B2[dom.js]
        B3[storage.js]
        B4[api.js]
        B5[audio.js]
        B6[ui.js]
        B7[platform.js]
        B8[settings.js]
        B9[cache.js]
        B10[markdown.js]
        B11[local-backup.js]
        B12[sync-core.js]
        B13[sync-signals.js]
        B14[sync-supabase.js]
        B15[validate.js]
        B16[vocab.js]
        B17[voices.js]
        B18[fonts/*]
    end

    subgraph C[features]
        C1[vocabulary]
        C2[learning]
        C3[dictation]
        C4[quiz]
        C5[article]
        C6[ocr]
        C7[qa]
        C8[sync]
        C9[assistant]
    end

    subgraph D[data]
        D1[wordlists/]
        D2[articles/]
        D3[qa-sets/]
        D4[voices*.json]
    end

    subgraph E[docs]
        E1[docs/]
        E2[@docs/]
        E3[PLAN.md]
        E4[AGENTS.md]
    end

    subgraph F[scripts]
        F1[update-voices]
        F2[font subset]
        F3[data generators]
    end
```

## 模組索引（重點路徑整理）

| 類型 | 名稱 / 路徑 | 說明 | 狀態 |
| --- | --- | --- | --- |
| **入口** | `index.html` | 靜態單頁入口，包含九大模組的區塊 DOM。 | ✅ |
|  | `styles.css` | 全域樣式、響應式版型、OCR / QA / 同步等子模組樣式。 | ✅ |
|  | `main.js` | SPA 入口，載入資料、初始化通用 UI、註冊 nav、導向 hash。 | ✅ |
| **共享服務** | `modules/state.js` | 全域狀態、旗標與衍生 getter。 | ✅ |
|  | `modules/dom.js` | 集中 DOM 查找與 NodeList，避免散落的 `querySelector`。 | ✅ |
|  | `modules/storage.js` | localStorage CRUD、資料初始化、詞書/文章緩存載入。 | ✅ |
|  | `modules/api.js` | 封裝 AI 相關 fetch、回退策略與速率限制。 | ✅ |
|  | `modules/audio.js` | Web Audio / SpeechSynthesis 控制、解鎖與播放序列。 | ✅ |
|  | `modules/ui.js` | 模態框、狀態條、數字步進器、提示訊息、浮動控件。 | ✅ |
|  | `modules/platform.js` | 裝置/瀏覽器偵測、視窗高度、安全區、可見性 API。 | ✅ |
|  | `modules/settings.js` | 儲存全域偏好（AI 模型、TTS、閱讀、助手）與私密設定。 | ✅ |
|  | `modules/cache.js` | IndexedDB + localStorage 雙層快取、TTL 管理與 SHA256 key。 | ✅ |
|  | `modules/markdown.js` | 輕量 Markdown → HTML，供 OCR 與報表預覽。 | ✅ |
|  | `modules/local-backup.js` | 本機快照備份、保留次數、回復與刪除。 | ✅ |
|  | `modules/sync-core.js` | 建構/套用本地快照，提供同步模組的序列化介面。 | ✅ |
|  | `modules/sync-signals.js` | 在資料變更時派發自訂事件給同步或助手。 | ✅ |
|  | `modules/sync-supabase.js` | 處理 Supabase 認證、即時通道與 snapshot 上傳下載。 | ✅ |
|  | `modules/validate.js` | 表單與輸入驗證工具（詞彙/QA/設定共用）。 | ✅ |
|  | `modules/vocab.js` | 提供跨模組的單字增刪、預設詞書管理。 | ✅ |
|  | `modules/voices.js` | 聲音清單載入、快取、重載邏輯；配合 `voices*.json`。 | ✅ |
|  | `modules/fonts/` | 字型子集載入器與子集字形檔。 | ✅ |
| **功能模組** | `features/vocabulary/` | 生詞本 CRUD、合併、JSON 匯入匯出、URL 解析。 | ✅ |
|  | `features/learning/` | 單字詳解、例句、AI 解析、音訊播放、書籍選擇器。 | ✅ |
|  | `features/dictation/` | 聽寫設定、播放流程、評分、暫停/恢復、結果紀錄。 | ✅ |
|  | `features/quiz/` | 測驗題庫生成、倒數計時、計分與結果瀏覽。 | ✅ |
|  | `features/article/` | 文章載入、段落標註、AI 解說與朗讀控制。 | ✅ |
|  | `features/ocr/` | 圖片/相機 OCR、拖放、Markdown 預覽、模板提示、模型選擇。 | ✅ |
|  | `features/qa/` | 問答集管理、創建器、訓練流程、AI 校正、PDF 匯出。 | ✅ |
|  | `features/sync/` | Supabase 登入/登出、OTP、同步按鈕、齒輪懸浮菜單。 | ✅ |
|  | `features/assistant/` | 文章內懸浮 AI 助手（FAB + panel）、對話儲存、Markdown 轉換。 | ✅ |
| **資料 / 設定** | `wordlists/` | 多套課本詞書 JSON 與 `manifest.json`。 | ✅ |
|  | `articles/` | 文章 JSON、`manifest.json`、產出腳本輸入來源。 | ✅ |
|  | `qa-sets/` | 問答模板、教案情境、示例資料。 | ✅ |
|  | `voices.json` / `voices.min.json` | TTS 聲音清單（完整 + 精簡）。 | ✅ |
|  | `ai-config.example.js` | AI / TTS / OCR / QA 模型的範例設定。 | ✅ |
|  | `ai-config.js` | 實際環境設定（不提交版本控制）。 | ✅ |
| **文件** | `docs/` | 專案 PRD、PROMPT、URL 參數、PDF 匯出等公開文檔。 | ✅ |
|  | `@docs/` | 進階架構記錄（同步、儲存等），僅在本 repo 可見。 | ✅ |
|  | `PLAN.md` | 從 `app.js` 拆分的重構計畫與里程碑。 | ✅ |
|  | `AGENTS.md` | 對所有 AI 代理生效的全域指引。 | ✅ |
| **工具** | `scripts/` | 更新 voices、產生字型子集、擷取 5A 素材等腳本。 | ✅ |
| **測試** | `test-floating-statusbar.html` | 手動測試平台偵測、持久化與浮動控制。 | ✅ |

## 其他重要資料夾與資產
- `@docs/`：包含 `storage-architecture.md`、`sync-overview.md`、`sync-supabase-design.md`，描述資料流程與同步協定細節。
- `.spec-workflow/`：Spec 產生器模板，可用於撰寫需求/設計/結構文件。
- `.serena/`：Serena 代理所需的專案設定與快取。
- `worksheet.md`、`5AU1_*.jpg`：教學/教材素材，供 QA 或腳本轉換使用。

## 運行與開發

### 環境需求
- 任意支援 ES2022 的現代瀏覽器。
- 本地靜態伺服器（避免 `file://` 造成的 CORS/模組載入問題）。
- 若要啟用雲端同步或 AI 服務，需提供 `ai-config.js` 內的 API 金鑰與 Supabase 設定。

### 快速啟動指令
```bash
npx serve .
# 或
npx http-server -c-1 .
```
> 於專案根目錄執行，上線後以 `http://localhost:3000`（預設 serve port）等同源路徑開啟。

### 必備設定
- 複製 `ai-config.example.js` 為 `ai-config.js`，依照實際服務填入：
  - `API_URL` / `API_KEY`
  - `AI_MODELS`（wordAnalysis、articleAnalysis、qaChecking、assistant 等）
  - `TTS_CONFIG`（remote/local/baseUrlCustom、voices）
  - `OCR_CONFIG`、`QA_CHECK`、`ASSISTANT`
- 如需 Supabase，同步設定位於 `modules/sync-supabase.js`（匿名 key、project url）。

## 測試策略

- **手動驗證**：開啟 `test-floating-statusbar.html` 逐一檢查平台偵測、浮動控制與持久化設定。
- **功能巡檢建議**：
  1. 詞書 CRUD 與匯入匯出。
  2. 聽寫流程（含暫停/恢復、自動評分、歷史記錄 PDF）。
  3. 測驗計分與離開保護（`state.quizInProgress`）。
  4. 文章分析 + AI 助手顯示邏輯（需待文章分頁 active 時才出現 FAB）。
  5. OCR 模型選擇、拖放、Markdown 預覽。
  6. QA 模組的訓練進度恢復、AI 校對快取清理、PDF 匯出。
  7. Supabase 登入/同步、`modules/local-backup.js` 自動備援。
- **資料一致性**：`modules/cache.js`、`modules/storage.js`、`modules/sync-core.js` 之間的序列化格式應保持向前相容。

## 編碼規範與結構原則

- 採用 ES2022；縮排四個空白，字串使用單引號。
- 共享邏輯請優先放入既有模組；若需新增，先確認 `modules/` 是否已有對應職責（例如設定、快取、同步）。
- 功能模組需輸出 `init*` 函式，並在 `main.js` 由 `DOMContentLoaded` 後呼叫。
- DOM 操作需透過 `modules/dom.js` 暴露的節點；若需要新元素，先擴充該檔案。
- 事件監聽與狀態旗標盡量封裝於功能模組內，跨模組共享狀態透過 `modules/state.js` 或自訂事件（`bdc:data-changed`）。
- 文字內容預設繁體中文；若需雙語請在文檔內說明。

## AI 與雲端使用指引

1. **AI API**：所有 AI 請求在 `modules/api.js` 統一處理，包含：單字分析、例句生成、句子/段落/片語解析、OCR 轉錄後的後處理、QA 回答校正等。新增請求請實作可設定模型與快取策略，並在 `ai-config.js` 裡提供預設模型或 profile。
2. **QA 校對**：`features/qa/qa.js` 透過 `qa-checker.js` 呼叫 `modules/api.js` 的 `checkQAAnswer`/`batchCheckAnswers`。請同步更新 `qa-sets/*.json` 以方便測試。
3. **OCR**：`features/ocr/` 使用 `OCR_CONFIG` 內的模型設定並支援 Markdown 預覽；長任務會使用 `currentRun` 追蹤並提供取消功能。
4. **AI 助手**：`features/assistant/assistant.js` 會根據 `loadGlobalSettings()` 與 `loadGlobalSecrets()` 選擇模型與 profile，並利用 `modules/cache.js` 保存對話索引。保持 UI 隔離（所有 DOM 由模組自行注入）。
5. **Supabase 同步**：`features/sync/` + `modules/sync-*` 需保存資料結構相容。開發新資料欄位時，請更新 `buildLocalSnapshot` / `applyMergedSnapshot`。
6. **TTS/Voices**：聲音清單優先讀取 `voices.min.json`，失敗再回退 `voices.json`；可經由 `scripts/update-voices.sh` 更新。

## 故障排查速查表
- `localStorage` 無法使用：`modules/platform.js` 內含可用性檢查，必要時提示使用者或回退 IndexedDB。
- AudioContext 被鎖：`modules/audio.js` 的 `unlockAudioContext` 會在 `main.js` 於首次點擊/觸控後運行。
- AI 請求延遲：先檢查 `modules/cache.js` 是否有命中；若需清除快取，可透過瀏覽器 devtools 清除 `bdc:cache:*` 項目。
- 同步衝突：觀察 `modules/sync-supabase.js` 的 console log，並確認 `buildLocalSnapshot` 是否包含新增欄位。

---

如需補充更多架構/模組說明，可將文件放在 `docs/` 或 `@docs/`，並在此文件新增條目以便其他代理快速定位。
