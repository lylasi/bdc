# PEN 子背單詞

一個專注離線體驗與 AI 強化的靜態單頁應用，提供詞彙管理、智慧學習、默寫、測驗、文章分析、OCR、問答訓練以及 Supabase 雲端同步等工具。專案以原生 ES Modules 撰寫，部署於任何靜態主機即可運行。

## 專案概覽

- **最新狀態**（2025-12-06）
  - `main.js` 已全面接手模組初始化；老舊的 `app.js` 已淘汰，`PLAN.md` 僅作歷史記錄。
  - 問答訓練模組（`features/qa/`）已正式 GA，支援問答集管理、AI 校對、PDF 導出與 RWD 改善。
  - `ai-config.js` 需自行配置 QA 校對、TTS 與 Supabase；缺少設定時系統僅能使用離線/本地功能。
  - 仍無自動化測試，重大改動請以瀏覽器巡檢（尤其 QA 批次校對、PDF 導出、行動版 UI）。
  - 倉庫核心說明位於本檔、`SNOW.md`、`CLAUDE.md`，其餘模組/規格請參照 `docs/` 與 `@docs/`。

## 技術棧

| 類別 | 選用技術 |
| --- | --- |
| 語言/執行環境 | HTML5、CSS3、JavaScript (ES2022) |
| 前端框架 | 無（原生 ES Modules） |
| 資料儲存 | localStorage + IndexedDB（透過 `modules/storage.js`） |
| AI / API | `modules/api.js` 封裝之外部 OpenAI 相容 API、TTS、OCR |
| 雲端同步 | Supabase（`features/sync/`, `modules/sync-*`） |
| PDF/圖像 | jsPDF、html2canvas（由 QA 模組及報表功能使用） |
| 建置工具 | 無需 bundler；以 `npx serve .` 或 `npx http-server -c-1 .` 啟動 |

## 目錄地圖

```
/
├── index.html            # SPA 入口與九大模組的 DOM 區塊
├── main.js               # 初始化模組、註冊導覽、處理 hash 路由
├── styles.css / styles/  # 全域與模組化樣式（含 QA / OCR / 同步）
├── modules/              # 共用服務：state、dom、storage、api、audio、ui、settings、sync 等
├── features/
│   ├── vocabulary/       # 詞書管理（CRUD、導入/導出）
│   ├── learning/         # 單字詳解、例句、朗讀
│   ├── dictation/        # 默寫流程、暫停/恢復、評分
│   ├── quiz/             # 測驗題庫、計分、離開保護
│   ├── article/          # 文章載入、AI 標註、朗讀控制
│   ├── ocr/              # 圖片 / 相機 OCR、Markdown 預覽
│   ├── qa/               # 問答集管理、訓練、AI 校對、PDF
│   ├── sync/             # Supabase 登入/同步與懸浮控制
│   └── assistant/        # 文章閱讀 AI 助手
├── qa-sets/, wordlists/, articles/   # 內建教材/問答資料
├── docs/, @docs/         # PRD、API/平台規格、同步/儲存架構
├── scripts/              # voices 更新、字型子集與資料生成腳本
├── PLAN.md, SNOW.md, CLAUDE.md       # 架構、里程碑與 AI 開發說明
└── worksheet.md, 5AU1_*.jpg          # 教材/QA 素材
```

> 進階架構文件（同步、儲存、AI 流程）位於 `@docs/`；若未 clone 該資料夾，請向倉庫維護者索取。

## 安裝與啟動

### 先決條件
- Node.js（僅用於啟動本地靜態服務器或執行腳本）。
- 現代瀏覽器（Chrome/Edge/Firefox/Safari）。

### 步驟
1. **取得程式碼**：`git clone` 或下載 ZIP。
2. **（可選）設定 AI/雲端**：
   ```bash
   cp ai-config.example.js ai-config.js
   # 編輯 ai-config.js，填入 API_URL、API_KEY、AI_MODELS、TTS/Supabase 等設定
   ```
3. **啟動本地伺服器**：
   ```bash
   npx serve .
   # 或
   npx http-server -c-1 .
   ```
4. 瀏覽器開啟輸出網址（預設 `http://localhost:3000`），即可開始使用。

## AI / 雲端設定重點
- `ai-config.js` **不得**提交版本控制，內含：
  - `AI_MODELS`：wordAnalysis、articleAnalysis、qaChecking、assistant 等分流。
  - `TTS_CONFIG`：遠端/本地/自定 Base URL，對應 `voices*.json`。
  - `OCR_CONFIG`、`QA_CHECK`、`ASSISTANT`、`SUPABASE`：模組專用參數。
- 若未配置 API，應用仍可使用詞書/默寫/測驗等離線功能；AI 相關按鈕會顯示提示或採用 fallback。

## 問答訓練模組摘要
- 檔案路徑：`features/qa/`（`qa.js`, `qa-trainer.js`, `qa-creator.js`, `qa-checker.js`, `qa-pdf.js`, `qa-storage.js`）。
- 功能：
  - 問答集 CRUD、導入/導出（JSON, `qa-sets/`）。
  - Q1:A1 批量解析、格式驗證與預覽。
  - 訓練會話：順序/隨機題、逐題或批次提交、進度指示。
  - AI 校對：併發最多 3 個請求、結果快取、離線降級。
  - PDF 導出：完整問答／僅題目兩種模式，支援自訂版面與中文字體。
- 相關規格：`docs/prd.md` 描述完整故事點、`docs/pdf-export-config.md` 說明字體與排版設定、`qa-sets/README.md` 定義資料格式。

## 資料與腳本
- `qa-sets/manifest.json` 列出所有問答集；新增內容需同步更新清單。
- `wordlists/manifest.json`、`articles/manifest.json` 分別管理詞書與文章來源。
- 腳本：
  - `scripts/update-voices.sh`：更新 `voices.json` / `voices.min.json`。
  - `scripts/compact-voices.mjs`：自訂 voices 精簡流程。
  - `scripts/build-font-subset.sh`、`scripts/gen-subset-chars.js`：PDF/字型子集。
  - 其他 `generate-from-5a-*.js`：將 5A 素材轉換成應用可讀格式。

## 開發流程
1. **修改程式**：依模組劃分編輯 `features/` 或 `modules/`；DOM 節點請統一路徑在 `modules/dom.js`。
2. **遵循規範**：ES2022、4 空白縮排、單引號；共用邏輯優先放既有模組。
3. **手動測試**：
   - 詞書 CRUD / 匯入匯出。
   - 默寫流程（含暫停/恢復）。
   - 測驗（離開保護、計分）。
   - 文章分析 + AI 助手。
   - OCR 拖放、相機取字、Markdown 預覽。
   - QA 訓練、AI 校對、PDF 導出、行動版布局。
   - Supabase 登入/同步、`modules/local-backup.js` 備份。
4. **提交前檢查**：確保 `ai-config.js`、個資或 API 金鑰未被加入版本控制。

## 進階文件索引
- `SNOW.md`：面向開發者的專案定位、最新狀態、架構摘要（本 README 的延伸）。
- `CLAUDE.md`：面向 AI 協作者的深度導覽（模組索引、約束、測試建議）。
- `AGENTS.md`：自動化代理指令與協作規則。
- `docs/prd.md`：問答訓練模組 PRD。
- `docs/api-spec.md`、`docs/url-parameters.md`、`docs/cf-worker-proxy.md`：外部 API、文章抽取代理的技術細節。
- `@docs/`：同步、儲存與 AI 架構內部文件（若倉庫含子模組）。

## 授權
本倉庫未指定開源授權；如需對外發佈或授權，請與維護者確認。
