# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 語言與現況

- 本專案文件以繁體中文為主；介面支援大陸簡體中文（`zh-CN`，預設）與香港繁體中文（`zh-HK`）。
- 這是一個純前端靜態 SPA，沒有 bundler，也沒有既定的 npm scripts 工作流。
- `main.js` 已取代舊版 `app.js` 作為唯一初始化入口；`PLAN.md` 主要是歷史重構紀錄。

## 常用命令

### 啟動本地開發伺服器

在專案根目錄執行：

```bash
python3 scripts/serve.py            # 127.0.0.1:8313，含同源代理與文章抓取
python3 scripts/serve.py --lan      # 綁 0.0.0.0，手機／平板可開
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

- `ai-config.js` 現在只保留 TTS、同步端點（`SYNC.endpoint`）與非 AI 參數。
- 全站預設 AI 供應商由管理員在 BDC 發布到 Cloudflare D1；個人供應商與 Key 存在帳戶範圍的本機 AI profile。不要在 `ai-config.js` 設定或保留 AI 網址／Key／模型。
- 自建同步後端：`selfhost/` 提供 Node + SQLite／PostgreSQL 的學習資料同步（不含 AI 憑證／目錄）；把 `SYNC.endpoint` 指向它即可，部署步驟見 `selfhost/README.md`。
- 若未設定供應商，應用仍可使用大部分離線功能；AI 會提示先登入或先新增供應商。
- 局域網 AI 供應商要填裝置可達的區網 IP（如 `http://192.168.1.100:11434/v1`），不可用 `localhost`；服務需允許 CORS。`scripts/serve.py --lan` 只改變前端綁定位址，AI 仍由瀏覽器直連（或另加 `--ai-proxy`）；同網段可讀 `ai-config.js`。HTTPS 頁面直連 HTTP 區網受混合內容／瀏覽器本地網路權限限制。

### 手動驗證

本專案目前**沒有** npm scripts、build、lint 或 typecheck 工作流。AI 相關模組有 `node:test` 單元／Worker 測試；其他驗證仍以瀏覽器巡檢與 `tests/*.cjs` Playwright 腳本為主。

```bash
# 啟動伺服器後，在瀏覽器開啟
/test-floating-statusbar.html
```

- `test-floating-statusbar.html` 是目前唯一明確存在的獨立測試頁，專門驗證平台偵測、浮動控制與持久化行為。
- 若使用者要求「跑單一測試」，AI 部分可用 `node --test tests/ai-worker.test.mjs tests/ai-units.test.mjs`；其他模組沒有統一 runner。

### 常用維護腳本

```bash
node --test tests/ai-worker.test.mjs tests/ai-units.test.mjs
node scripts/migrate-ai-config.mjs --dry-run
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
- `sync/`：Cloudflare 登入／學習資料同步、AI 供應商設定與同步狀態
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
- `modules/sync-core.js` / `modules/sync-signals.js` / `modules/sync-cloudflare.js`：同步序列化、資料變更事件與 Cloudflare Worker 介面
- `modules/ai-profile-storage.js` / `ai-catalog.js` / `ai-credential-sync.js` / `ai-models.js` / `ai-protocols/`：AI 供應商、共享列表、金鑰同步與協議適配
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
- AI 非秘密設定走 snapshot；個人 Key 走 `/ai-credentials`（AES-GCM、逐供應商版本）；共享預設走唯讀 catalog。
- 本機 AI profile 鍵名為 `bdc_ai_profile_v1:<endpoint>:<user>` 與 `bdc_ai_profile_v1:device:guest`，修改時要兼顧退出／401／帳戶切換清理。
- 若你新增持久化欄位，通常需要同步檢查：
  - `modules/storage.js`
  - `modules/sync-core.js`
  - `modules/sync-cloudflare.js`
  - `modules/ai-profile-storage.js`、`modules/ai-credential-sync.js`
  - 以及任何使用該資料的 feature module

## AI 與外部服務邊界

- 所有 AI 相關能力都應經過 `modules/api.js` 與 `modules/ai-protocols/`，不要在功能模組內直接散寫 fetch 邏輯。
- AI 供應商來源只有兩個：帳戶／裝置的 AI profile（個人供應商與 Key）與管理員發布的 D1 managed catalog（共享 Key 只在記憶體）。沒有靜態 AI 預設。
- `ai-config.js` 只保留 TTS、同步端點、限流、文章抓取與 QA/OCR 的非秘密參數。
- `assistant/`、`ocr/`、`qa/`、`article/` 都依賴這層 API / 設定抽象；助手串流也必須走共用適配層。

## 修改時應遵守的結構慣例

- 使用 ES2022、4 空白縮排、單引號。
- 先延用既有模組邊界；新增共享邏輯前先檢查 `modules/` 是否已有相近職責。
- 新增 DOM 參照時，優先擴充 `modules/dom.js`。
- 跨模組共享狀態優先放 `modules/state.js`，或透過既有同步 / 自訂事件機制傳遞。
- 使用者可見文字必須同時支援大陸簡體中文與香港繁體中文，預設介面為 `zh-CN`。
- 全域設定面板採即時儲存：新增設定項時直接呼叫 `saveGlobalSettings`／`saveGlobalSecrets` 寫入，不要再加「儲存」按鈕；同層欄位（`tts`、`reading`、`assistant`…）由 `modules/settings.js` 合併，勿改成淺覆蓋。
- `features/` 下的功能模組應維持 `init*` 入口模式，讓 `main.js` 能統一初始化。

## UI 雙語開發規範（強制）

- 新增功能或調整既有功能時，只要涉及 UI 層的使用者可見文字，就必須同時完成 `zh-CN` 與 `zh-HK` 兩份文案。
- 功能邏輯只維護一套；不得為簡體與繁體複製兩套功能程式碼。
- 靜態 HTML 文案使用 `data-i18n`、`data-i18n-title`、`data-i18n-placeholder`、`data-i18n-aria-label` 等屬性。
- JavaScript 動態產生的按鈕、彈窗、提示、載入狀態、錯誤訊息、空狀態及 `aria-label` 必須使用 `t('...')`，禁止直接硬編碼簡體或繁體中文。
- 每個新翻譯鍵必須同時加入 `locales/zh-CN.js` 與 `locales/zh-HK.js`，兩份字典的鍵集合必須保持一致。
- 香港繁體文案使用香港正式書面中文及香港常用詞，不使用台灣慣用詞，也不預設使用粵語口語。
- 介面語言只控制 UI 與後續 AI 回覆；不得轉換教材、文章原文、OCR 原文、QA 內容、詞書內容、使用者輸入或歷史訊息。
- AI 任務邏輯與輸出 schema 維護一套，透過 `modules/prompts/language-rules.js` 按目前 locale 注入語言規則；不要複製兩套完整提示詞。
- 修改 UI 後至少驗證一次 `zh-CN` 和 `zh-HK`，尤其檢查動態建立的 DOM、非同步載入文字、操作完成狀態與錯誤路徑。
- 詳細實作與驗收清單見 `docs/spec/20260712202038506_UI雙語開發與維護規範.md`。

## 驗證重點

因為沒有自動化測試，修改後至少手動驗證受影響功能；常見回歸區域：

1. 詞書 CRUD / 匯入匯出
2. 聽寫流程與暫停恢復
3. 測驗計分與離開保護（`state.quizInProgress`）
4. 文章分析與 AI 助手顯示條件
5. OCR 拖放、模型切換、Markdown 預覽
6. QA 訓練進度恢復、AI 校對、PDF 匯出
7. Cloudflare 登入 / 學習資料同步、AI 供應商與金鑰同步、本地備援

若變更牽涉平台偵測、浮動狀態列或持久化 UI，務必額外打開 `test-floating-statusbar.html` 驗證。

AI 相關變更至少執行：

```bash
node --test tests/ai-worker.test.mjs tests/ai-units.test.mjs tests/ai-sync-regressions.test.mjs
node tests/audit-i18n.mjs
# 瀏覽器：python3 scripts/serve.py --port 8313 後執行
PORT=8313 PLAYWRIGHT_MODULE=<path-to-playwright> node tests/audit-flows.cjs
# 全域設定即時儲存（需先開 scripts/serve.py）
PORT=8313 PLAYWRIGHT_MODULE=<path-to-playwright> node tests/settings-autosave.cjs
# AI 供應商設定／模型選擇器（自帶路由與 mock，不需要另開伺服器）
PLAYWRIGHT_MODULE=<path-to-playwright> node tests/ai-review-regressions.mjs
# mock Worker／供應商：python3 -m http.server 8414 --directory . 後開 tests/ai-provider-e2e.html
```

## 重要參考文件

- `README.md`：最新專案摘要與啟動方式
- `AGENTS.md`：給所有 AI 代理的共用規則
- `SNOW.md`：開發者導向的高階摘要
- `docs/spec/20261017030603591_AI設定與局域網支援.md`：AI 供應商設定與局域網連線條件
- `docs/prd.md`：QA 模組產品需求
- `@docs/storage-architecture.md`：本地資料鍵名、TTL、快取與資料生命週期
- `@docs/sync-overview.md`、`@docs/sync-supabase-design.md`：同步設計脈絡

## 目前已知限制

- 根目錄沒有 `package.json` / npm scripts 工作流；不要假設存在 `npm run build`、`npm test`、`npm run lint`。`selfhost/` 子專案另有 `package.json`，僅 PostgreSQL 模式需要 `npm install`。
- 沒有統一測試框架；AI 模組使用 `node:test`（`tests/ai-*.test.mjs`），其餘為 Playwright 巡檢腳本與手動驗證，不要虛構不存在的指令。
- `ai-config.js` 屬本機私有設定，不應被當成可安全提交的專案檔案。

## 文檔落盤規範（強製）
1. 每次生成文檔、計劃、紀要、調研、報告、清單時，必須落盤到工作區 `docs` 目錄下。
2. 必須按類型創建子目錄，至少包含：
- `docs/plan`（計劃）
- `docs/meeting`（會議材料與紀要）
- `docs/research`（調研）
- `docs/spec`（需求與規格拆解）
- `docs/report`（週報/階段報告）
- `docs/decision`（決策記錄）
- `docs/release`（髮佈記錄）
3. 文件名必須包含時間戳，格式固定：`yyyyMMddHHmmssfff`。
4. 文件命名建議：`<時間戳>_<主題>.md`，示例：`20260224165501222_登錄改造實施計劃.md`。
5. 若目錄不存在，先自動創建再冩入；冩入完成後在結果裡明確給出實際文件路徑。
6. 除非我明確要求，不要隻在聊天中給文檔，必須同時生成對應落地文件。
