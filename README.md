# PEN 子背單詞

一個專注離線體驗與 AI 強化的靜態單頁應用，提供詞彙管理、智慧學習、默寫、測驗、文章分析、OCR、問答訓練，以及 Cloudflare D1 或自建 PostgreSQL／SQLite 雲端同步等工具。專案以原生 ES Modules 撰寫，部署於任何靜態主機即可運行。

## 專案概覽

- **最新狀態**（2026-10-18）
  - `main.js` 已全面接手模組初始化；老舊的 `app.js` 已淘汰，`PLAN.md` 僅作歷史記錄。
  - 問答訓練模組（`features/qa/`）已正式 GA，支援問答集管理、AI 校對、PDF 導出與 RWD 改善。
  - 全站預設 AI 供應商由管理員在 BDC 內發布到 Cloudflare D1；`ai-config.js` 只保留 TTS、同步端點與非 AI 參數，不再保存 AI 網址／Key／模型。
  - 個人 AI 供應商與 Key 保存在帳戶範圍的本機 profile；未登入時為「此裝置」設定。缺少 AI 設定時仍可使用離線功能。
  - 全域設定改為左側分類面板（介面／語音朗讀／AI 供應商／助手與工具），任何選項一改即時寫入本機設定，不再需要按「儲存」。
  - AI 模組有 `node:test` 單元／Worker 測試；其餘重大改動仍以瀏覽器巡檢（尤其 QA 批次校對、PDF 導出、行動版 UI）與 `tests/*.cjs` Playwright 腳本驗證。
  - 倉庫核心說明位於本檔、`SNOW.md`、`CLAUDE.md`，其餘模組/規格請參照 `docs/` 與 `@docs/`。
  - 介面預設使用大陸簡體中文，並可切換香港繁體中文；新增或修改 UI 時必須同步維護兩份 locale，詳見 `docs/spec/20260712202038506_UI雙語開發與維護規範.md`。

## 技術棧

| 類別 | 選用技術 |
| --- | --- |
| 語言/執行環境 | HTML5、CSS3、JavaScript (ES2022) |
| 前端框架 | 無（原生 ES Modules） |
| 資料儲存 | localStorage + IndexedDB（透過 `modules/storage.js`） |
| AI / API | `modules/api.js` + `modules/ai-protocols/`（Chat Completions／Anthropic Messages／Gemini），瀏覽器直連供應商 |
| 雲端同步 | Cloudflare Worker + D1（預設）；自建 Node + PostgreSQL／SQLite（`selfhost/`，學習資料同步） |
| PDF/圖像 | jsPDF、html2canvas（由 QA 模組及報表功能使用） |
| 建置工具 | 無需 bundler；以 `python3 scripts/serve.py` 或 `npx serve .` 啟動 |

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
│   ├── sync/             # Cloudflare 登入/同步、AI 供應商設定與懸浮控制
│   ├── ai-admin/         # 管理員預設 AI 供應商編輯與發布
│   ├── admin-users/      # 管理員用戶管理（新增、編輯、設定使用者名稱／密碼、重設通行碼）
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
- Node.js（用於啟動本地靜態服務器、執行腳本，或 `selfhost/` 同步後端；自建 SQLite 需 22.13+）。
- 現代瀏覽器（Chrome/Edge/Firefox/Safari）。

### 步驟
1. **取得程式碼**：`git clone` 或下載 ZIP。
2. **（可選）設定非 AI 服務**：
   ```bash
   cp ai-config.example.js ai-config.js
   # 編輯 ai-config.js，填入 TTS、SYNC.endpoint（Cloudflare Worker）等非 AI 設定。
   # AI 供應商不要在檔案裡設定：管理員登入 BDC → 設定 →「管理預設供應商」發布；
   # 一般使用者用「我的供應商」新增自己的網址與 Key。
   ```
3. **啟動本地伺服器**：
   ```bash
   # 推薦：自帶 AI 同源代理與文章抓取，且停用快取（不需要 npm）
   python3 scripts/serve.py                      # http://127.0.0.1:8313/
   python3 scripts/serve.py --lan                # 綁 0.0.0.0，手機／平板也能開
   python3 scripts/serve.py --ai-proxy http://127.0.0.1:3425

   # 或單純靜態服務（此時沒有 /v1 代理、沒有 /fetch 與 /extract）
   npx serve .
   npx http-server -c-1 .
   ```
4. 瀏覽器開啟輸出網址即可開始使用（`scripts/serve.py` 預設 `http://127.0.0.1:8313/`）。

### 為什麼建議用 `scripts/serve.py`

| 路由 | 用途 |
| --- | --- |
| `/v1/*` | 可選的舊式 AI 同源代理，把請求轉給 `--ai-proxy` 指定的網關。新版供應商設定要求**完整絕對網址**（例如 `http://192.168.1.100:8313/v1`；手機要用電腦的區網 IP，不能用 `127.0.0.1`），不再使用 `ai-config.js` 的相對 provider；不同裝置的 origin 可能不同，同步前請確認 binding。 |
| `/fetch?url=` | 伺服器端代抓目標網頁原始 HTML（瀏覽器直抓會被 CORS 擋）。 |
| `/extract?url=` | 伺服器端代抓並直接轉成 `{title, markdown}`；文章「新聞來源／網址導入」優先走這條，不必再把整份 HTML 丟給模型。 |

- 兩條抓取路由都有 SSRF 防護：只允許 http/https、拒絕私網／loopback／link-local／保留位址、逐次轉址重新檢查、限制大小與逾時。
- 不需要文章抓取時用 `--no-article-fetch` 關閉。
- 局域網使用：`--lan` 只改變前端綁定位址，讓同網段裝置載入頁面；AI 仍由瀏覽器直連，除非另加 `--ai-proxy` 走同源 `/v1`。AI 供應商要填電腦的區網 IP（例如 `http://192.168.1.100:11434/v1`），不能用 `localhost`；服務需允許 CORS，HTTPS 頁面直連 HTTP 區網亦受混合內容／瀏覽器本地網路權限限制。同網段可讀 `ai-config.js`，僅限可信網絡。
- 反過來說：用 `npx serve .` 也能跑，但 AI 與文章導入會退回直接連線或第三方服務（可能被 CORS／白名單擋掉）。

## AI / 雲端設定重點
- `ai-config.js` **不得**提交版本控制。它現在只包含：
  - `TTS_CONFIG`：遠端/本地/自定 Base URL，對應 `voices*.json`。
  - `SYNC.endpoint`：同步後端端點（Cloudflare Worker，或 `selfhost/` 自建的 SQLite／PostgreSQL 伺服器）。
  - `AI_LIMITS`、`QA_CHECK`、`OCR_CONFIG`、`ARTICLE_IMPORT` 的非秘密參數（逾時、併發、抓取服務）。
- 全站預設 AI 供應商：管理員在 BDC「設定 → 管理預設供應商」建立、測試、發布；存於 D1，只有已登入使用者可取得，共享 Key 只留頁面記憶體（最長 60 分鐘）。
- 管理員用戶管理：BDC「設定 → 工具 → 管理用戶」可新增用戶、修改備註／可選電郵、設定使用者名稱與初始密碼、重設非管理員通行碼，並為非管理員產生一次性裝置配對碼；角色調整、刪除與管理員通行碼重設仍由部署者維護。需先套用 `cloudflare-worker/migrations/002_admin_user_management.sql`、`003_device_pairing.sql` 與 `005_username_password.sql`。
- 使用者名稱＋密碼登入：管理員為帳戶設定使用者名稱與密碼後，使用者可在主站登入彈窗直接登入；一般使用者密碼至少 10 字元、管理員至少 12 字元。密碼以 PBKDF2-SHA256 加伺服器端 pepper 雜湊，修改密碼或重設通行碼會撤銷其他裝置的 session。此功能需要 Worker secret `PASSWORD_PEPPER`，未設定時前端自動隱藏密碼分頁。pepper 只在密碼登入與設定／修改密碼時使用；`wrangler deploy` 會保留它，但重建 Worker 或還原 D1 時必須用同一個值。正式值另存於密碼管理器／2FA 安全筆記，D1 備份不含 pepper。
- 裝置配對登入：新裝置可在登入彈窗用「用戶代號 + 配對碼」換取 180 天 session token；配對碼 10 分鐘內有效且只能使用一次，重設通行碼會撤銷所有已配對裝置。原本的 43 字元通行碼仍然有效，不需要在每台新裝置手動輸入。
- 個人 AI 供應商：所有使用者都可在「設定 → 我的供應商」新增、編輯、測試、刪除；未登入時保存到此裝置，登入後可明確匯入並選擇是否同步 Key。
- 支援協議：OpenAI Chat Completions 相容、Anthropic Messages、Gemini 原生（文字／圖片／JSON／串流）。未實作的協議會明確提示，不會猜測。
- 若未配置供應商，應用仍可使用詞書/默寫/測驗等離線功能；AI 按鈕會顯示「尚未選擇模型」或登入提示。
- 清除舊靜態 AI 設定：
  ```bash
  node scripts/migrate-ai-config.mjs --dry-run
  node scripts/migrate-ai-config.mjs   # 備份與匯入 JSON 放在網站根目錄之外
  ```
  之後到供應商控制台撤銷舊共享 Key；只刪檔案不能收回已複製的 Key。

## 自建同步後端（PostgreSQL / SQLite）

除了 Cloudflare Worker + D1，`selfhost/` 另附一個零框架 Node.js 同步伺服器。它實作學習資料快照 API（`/me`、`/version`、`/snapshot`、修改／重設通行碼），適合 NAS、VPS 或家用電腦；不包含 AI 供應商憑證與共享目錄接口。

需求：Node.js 22.13 以上（建議 24）；SQLite 模式無需 npm，PostgreSQL 模式需在 `selfhost/` 執行 `npm install`。

### SQLite（最快，無需 npm 套件）

```bash
cd selfhost
DB_DRIVER=sqlite SQLITE_PATH=./data/bdc-sync.sqlite \
  PORT=8787 ALLOWED_ORIGINS=http://127.0.0.1:8313 \
  node server.mjs
```

建立使用者（另開終端；通行碼只顯示一次）：

```bash
node add-user.mjs alice "Alice" > /tmp/alice.sql
mkdir -p data
sqlite3 data/bdc-sync.sqlite < schema.sql
sqlite3 data/bdc-sync.sqlite < /tmp/alice.sql
```

沒有 `sqlite3` CLI 時可用 Node 套用：

```bash
mkdir -p data
node -e "const {DatabaseSync}=require('node:sqlite');const fs=require('fs');const db=new DatabaseSync('data/bdc-sync.sqlite');db.exec(fs.readFileSync('schema.sql','utf8'));db.exec(fs.readFileSync('/tmp/alice.sql','utf8'));"
```

### PostgreSQL（Docker 範例）

```bash
docker run --name bdc-postgres \
  -e POSTGRES_DB=bdc -e POSTGRES_USER=bdc -e POSTGRES_PASSWORD='change-me' \
  -p 5432:5432 -d postgres:16

cd selfhost
npm install   # 安裝 pg

DB_DRIVER=postgres \
DATABASE_URL='postgres://bdc:change-me@127.0.0.1:5432/bdc' \
PORT=8787 ALLOWED_ORIGINS=http://127.0.0.1:8313 \
node server.mjs
```

建立使用者：

```bash
node add-user.mjs alice "Alice" > /tmp/alice.sql
docker exec -i bdc-postgres psql -U bdc -d bdc < /tmp/alice.sql
```

資料表會在啟動時自動建立。健康檢查：`curl http://127.0.0.1:8787/health`。

### 前端接上自建後端

編輯不進版本控制的 `ai-config.js`：

```js
export const SYNC = {
  endpoint: 'http://127.0.0.1:8787',
  poll: { baseMs: 90000, maxMs: 300000, pauseWhenHidden: true, pollOnFocus: true }
};
```

重新載入後用 `add-user.mjs` 產生的通行碼登入即可同步學習資料。手機／其他裝置請把 `endpoint` 與 `ALLOWED_ORIGINS` 改成電腦的區網 IP（不能填 `localhost`）；正式環境請放在 HTTPS 反向代理後面。

- 支援範圍：詞書、文章、QA、聽寫等學習快照；AI 供應商雲端憑證／共享目錄仍只由 Cloudflare Worker 提供。
- 詳細設定、備份、systemd、Caddy 與疑難排解：`selfhost/README.md`。

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
   - Cloudflare 登入/學習資料同步、AI 供應商設定與金鑰同步、`modules/local-backup.js` 備份。
4. **自動檢查**：
   ```bash
   node --test tests/ai-worker.test.mjs tests/ai-units.test.mjs tests/ai-sync-regressions.test.mjs
   node tests/audit-i18n.mjs
   # 需要 Playwright 時（本機模組路徑依環境調整）：
   PLAYWRIGHT_MODULE=<path-to-playwright> PORT=8313 node tests/audit-e2e.cjs
   PLAYWRIGHT_MODULE=<path-to-playwright> PORT=8313 node tests/audit-flows.cjs
   PLAYWRIGHT_MODULE=<path-to-playwright> PORT=8313 node tests/settings-autosave.cjs
   PLAYWRIGHT_MODULE=<path-to-playwright> node tests/ai-review-regressions.mjs
   ```
   瀏覽器 E2E（mock Worker／mock 供應商）：
   `python3 -m http.server 8414 --directory .` 後開 `/tests/ai-provider-e2e.html`（`scripts/serve.py` 會封鎖 `/tests`）。
5. **提交前檢查**：確保 `ai-config.js`、個資或 API 金鑰未被加入版本控制。

## 進階文件索引
- `SNOW.md`：面向開發者的專案定位、最新狀態、架構摘要（本 README 的延伸）。
- `CLAUDE.md`：面向 AI 協作者的深度導覽（模組索引、約束、測試建議）。
- `AGENTS.md`：自動化代理指令與協作規則。
- `docs/prd.md`：問答訓練模組 PRD。
- `docs/spec/20261017030603591_AI設定與局域網支援.md`：AI 供應商設定與局域網連線條件。
- `selfhost/README.md`：自建 SQLite／PostgreSQL 同步後端、反向代理、備份與疑難排解。
- `docs/spec/20261018044825000_自建同步後端SQLite與PostgreSQL部署.md`：本次自建後端的範圍與驗證記錄。
- `docs/api-spec.md`、`docs/url-parameters.md`、`docs/cf-worker-proxy.md`：外部 API、文章抽取代理的技術細節。
- `@docs/`：同步、儲存與 AI 架構內部文件（若倉庫含子模組）。

## 授權
本倉庫未指定開源授權；如需對外發佈或授權，請與維護者確認。
