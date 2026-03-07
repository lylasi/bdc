# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 語言與現況

- 本專案文件與介面文案以繁體中文為主。
- 這是一個純前端靜態 SPA，沒有 bundler，也沒有既定的 npm scripts 工作流。
- `main.js` 已取代舊版 `app.js` 作為唯一初始化入口；`PLAN.md` 主要是歷史重構紀錄。

## 常用命令

### 啟動本地開發伺服器

在專案根目錄執行：

```bash
npx serve .
# 或
npx http-server -c-1 .
```

- `http-server -c-1` 會停用快取，較適合除錯靜態資源、storage 與 manifest 變更。
- 專案依賴瀏覽器以 HTTP 載入 ES Modules，不要直接用 `file://` 開啟。

### AI / 雲端設定

```bash
cp ai-config.example.js ai-config.js
```

- `ai-config.js` 用於本機 API / TTS / OCR / Supabase 設定。
- 若未設定，應用仍可使用大部分離線功能，但 AI、TTS、OCR、同步會降級或不可用。

### 手動驗證

本專案目前**沒有**既定的 build、lint、typecheck 或自動化測試命令；驗證方式以瀏覽器手動巡檢為主。

```bash
# 啟動伺服器後，在瀏覽器開啟
/test-floating-statusbar.html
```

- `test-floating-statusbar.html` 是目前唯一明確存在的獨立測試頁，專門驗證平台偵測、浮動控制與持久化行為。
- 若使用者要求「跑單一測試」，目前沒有測試 runner；可用的最接近做法是啟動本機伺服器後只驗證此頁，或只巡檢受影響模組。

### 常用維護腳本

```bash
bash scripts/update-voices.sh
node scripts/compact-voices.mjs voices.json voices.min.json
bash scripts/build-font-subset.sh
node scripts/gen-subset-chars.js
node scripts/generate-from-5a-jumpstart.js
node scripts/generate-from-5a-texts.js
node scripts/extract-5a-readings.js
```

- `scripts/update-voices.sh`：更新 `voices.json`，並在可用時產生 `voices.min.json`。
- `scripts/compact-voices.mjs`：將完整 voices 清單壓成前端優先讀取的精簡版。
- 其餘腳本主要用於字型子集與教材資料生成。

## 高階架構

### 1. 應用骨架

- `index.html`：SPA 的靜態骨架，預先放好各功能模組需要的主要 DOM 區塊。
- `styles.css`：全域樣式與各模組樣式。
- `main.js`：唯一啟動入口，負責：
  1. 載入本地資料（詞書、已分析文章）
  2. 初始化共用 UI
  3. 初始化九個功能模組
  4. 綁定主導覽與 hash / query routing
  5. 處理音訊解鎖、可見性切換與 URL 導入

### 2. 分層結構

專案可以視為三層：

1. **表示層**：`index.html` + `styles.css`
2. **功能層**：`features/<module>/`，每個模組提供 `init*` 入口，由 `main.js` 呼叫
3. **共享服務層**：`modules/`，封裝跨模組狀態、DOM、儲存、AI、音訊、同步與設定

### 3. 功能模組分工

`features/` 目前包含九個主要模組：

- `vocabulary/`：詞書 CRUD、匯入匯出、URL 導入
- `learning/`：單字詳解、例句、朗讀
- `dictation/`：聽寫流程、暫停/恢復、評分
- `quiz/`：題庫生成、倒數、計分、離開保護
- `article/`：文章載入、分析、朗讀
- `ocr/`：圖片 / 相機 OCR、Markdown 預覽
- `qa/`：問答集管理、訓練、AI 校對、PDF 匯出
- `sync/`：Supabase 登入與同步控制
- `assistant/`：文章閱讀場景的 AI 助手面板

關鍵模式：**每個功能模組自己處理事件與 UI，但初始化都從 `main.js` 集中觸發。**

### 4. 共享服務分工

最重要的共享模組：

- `modules/dom.js`：集中 DOM 參照；不要在功能模組中散落新的 `querySelector` 慣用法
- `modules/state.js`：全域旗標與共享狀態，例如測驗中、默寫狀態
- `modules/storage.js`：localStorage 讀寫與初始資料載入
- `modules/cache.js`：IndexedDB 優先、localStorage 後備的 AI 快取
- `modules/api.js`：所有 AI 請求的統一入口
- `modules/settings.js`：全域設定與 secrets 載入
- `modules/audio.js`：Web Audio / SpeechSynthesis 控制與解鎖
- `modules/sync-core.js` / `modules/sync-signals.js` / `modules/sync-supabase.js`：同步序列化、資料變更事件與 Supabase 介面
- `modules/vocab.js` / `modules/voices.js` / `modules/markdown.js` / `modules/local-backup.js`：跨模組的詞彙、語音、Markdown 與備份能力

## 關鍵資料流與持久化

### 本地資料模型

專案是 **local-first**：

- 核心資料主要放在 `localStorage`
  - `vocabularyBooks`, `activeBookId`
  - `analyzedArticles`
  - `qa-sets`, `qa-set-<id>`
- 短期會話 / 偏好也在 `localStorage`
  - `pen_dictation_session`
  - `pen_dictation_settings`
  - `qa-training-progress`
- AI 派生結果快取優先使用 IndexedDB（`bdc-cache`），失敗時回退 localStorage

### 靜態內容來源

- `wordlists/manifest.json`：詞書索引
- `articles/manifest.json`：文章索引
- `qa-sets/manifest.json`：問答集索引
- `voices.min.json` / `voices.json`：TTS 聲音清單

變更這些資料集時，通常要同時更新對應 manifest 或相關載入流程。

### 同步模型

同步相關程式採 **snapshot / local-first** 思路：

- 本地資料仍是主要來源
- 同步模組負責建構與套用快照
- 若你新增持久化欄位，通常需要同步檢查：
  - `modules/storage.js`
  - `modules/sync-core.js`
  - `modules/sync-supabase.js`
  - 以及任何使用該資料的 feature module

## AI 與外部服務邊界

- 所有 AI 相關能力都應優先經過 `modules/api.js`，不要在功能模組內直接散寫 fetch 邏輯。
- 模型、端點、TTS、OCR、QA 校對與助手設定集中在 `ai-config.js` / `ai-config.example.js` 的結構中。
- `assistant/`、`ocr/`、`qa/`、`article/` 都會依賴這層 API / 設定抽象。

## 修改時應遵守的結構慣例

- 使用 ES2022、4 空白縮排、單引號。
- 先延用既有模組邊界；新增共享邏輯前先檢查 `modules/` 是否已有相近職責。
- 新增 DOM 參照時，優先擴充 `modules/dom.js`。
- 跨模組共享狀態優先放 `modules/state.js`，或透過既有同步 / 自訂事件機制傳遞。
- 使用者可見文字預設採繁體中文。
- `features/` 下的功能模組應維持 `init*` 入口模式，讓 `main.js` 能統一初始化。

## 驗證重點

因為沒有自動化測試，修改後至少手動驗證受影響功能；常見回歸區域：

1. 詞書 CRUD / 匯入匯出
2. 聽寫流程與暫停恢復
3. 測驗計分與離開保護（`state.quizInProgress`）
4. 文章分析與 AI 助手顯示條件
5. OCR 拖放、模型切換、Markdown 預覽
6. QA 訓練進度恢復、AI 校對、PDF 匯出
7. Supabase 登入 / 同步與本地備援

若變更牽涉平台偵測、浮動狀態列或持久化 UI，務必額外打開 `test-floating-statusbar.html` 驗證。

## 重要參考文件

- `README.md`：最新專案摘要與啟動方式
- `AGENTS.md`：給所有 AI 代理的共用規則
- `SNOW.md`：開發者導向的高階摘要
- `docs/prd.md`：QA 模組產品需求
- `@docs/storage-architecture.md`：本地資料鍵名、TTL、快取與資料生命週期
- `@docs/sync-overview.md`、`@docs/sync-supabase-design.md`：同步設計脈絡

## 目前已知限制

- 沒有 `package.json` / npm scripts 工作流；不要假設存在 `npm run build`、`npm test`、`npm run lint`。
- 沒有自動化測試框架；不要虛構單測指令。
- `ai-config.js` 屬本機私有設定，不應被當成可安全提交的專案檔案。
