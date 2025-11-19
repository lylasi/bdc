# Article Import Service（Worker/Docker）專案指南

這份文件描述如何從零建立一個「文章採集與清理服務」專案，支援 Cloudflare Workers 與 Docker 兩種部署方式，並提供 HTML / JSON / Markdown 多格式輸出，供 `bdc` 前端或其他客戶端透過 API 取得乾淨的文章內容。建議直接將本文件放入新 repo 中，作為開發起點。

---

## 1. 專案目標與特性
- **統一 API**：提供 `/fetch`、`/extract`、`/feeds` 等 REST 端點，回傳原始 HTML、結構化 JSON、或轉換後的 Markdown。
- **來源可擴充**：支援 RT、BBC、CNN、NYTimes 等 RSS/JSON 來源；後續可加入自建文章庫。
- **安全與合規**：阻擋私有網域、白名單控制、大小限制、速率限制，防止 SSRF 與資源濫用。
- **部署彈性**：預設使用 Cloudflare Workers，亦可透過 Docker 以 Node.js 版本部署；兩種模式共用相同程式與 API。
- **易於整合**：前端僅需設定 `ARTICLE_IMPORT.BASE_URL` 等參數，即可透過 API 拉取內容，不受部署環境影響。

---

## 2. 目錄結構（建議）
```
article-import-service/
├─ README.md                  # 總覽與快速開始
├─ docs/
│  ├─ api-spec.md             # 端點、參數、回傳結構
│  ├─ deployment.md           # Worker / Docker 部署詳解
│  └─ feeds-playbook.md       # 新增來源、Cron 範例
├─ wrangler.toml              # Worker 設定（綁定 KV、環境變數、Cron）
├─ package.json
├─ src/
│  ├─ index.js                # Worker 入口（Cloudflare Modules）
│  ├─ index-node.js           # Docker/Node 入口（Hono / Express）
│  ├─ routes/
│  │   ├─ fetch.js            # /fetch
│  │   ├─ extract.js          # /extract、/extract?format=markdown
│  │   └─ feeds.js            # /feeds、/feeds/:id、/feeds/:id/article
│  ├─ lib/
│  │   ├─ http.js             # withCors、errorResponse、router 工具
│  │   ├─ content-parser.js   # linkedom + @mozilla/readability 包裝
│  │   ├─ markdown.js         # HTML→Markdown（turndown 或自寫）
│  │   ├─ images.js           # 圖片過濾、srcset→原圖、絕對化 URL
│  │   ├─ feeds.js            # RSS/JSON 解析、KV 快取
│  │   └─ config.js           # ALLOW_HOSTS、SOURCES、限制參數
│  └─ utils/
│      ├─ logger.js           # 可選：Console / Workers Trace
│      └─ rate-limit.js       # 可選：Token bucket
├─ scripts/
│  └─ bundle-node.mjs         # 產生 Node 版 bundle（若需要）
└─ Dockerfile                 # Node 版部署（可選）
```

---

## 3. 技術堆疊與依賴
| 類別 | 套件 |
| --- | --- |
| DOM/解析 | `linkedom`, `@mozilla/readability`, `fast-xml-parser` |
| Markdown 轉換 | `turndown`（或自寫輕量轉換器） |
| HTTP 框架 | Workers 端使用原生 `fetch` + 自建 router；Node 版可用 `hono` 或 `itty-router` |
| 打包 | Cloudflare 直接用 ESModules；Node 版可用 `esbuild` 或原生 ESM |
| 測試（可選） | `vitest`, `miniflare` |

---

## 4. 功能與 API 詳解

### 4.1 `/fetch`
- **Purpose**：CORS 代理，回傳原始 HTML。
- **Query**：`url`（必填），僅允許 http/https。
- **Headers**：`Access-Control-Allow-Origin: *`。
- **安全檢查**：阻擋私網 IP / `localhost`、限制 `MAX_BYTES`（預設 3MB）、套用 `ALLOW_HOSTS` 白名單。

### 4.2 `/extract`
- **查詢參數**：
  - `url`：必填。
  - `format`：`json`（預設）、`html`、`markdown`。
  - `keepImages`：`true/false`，控制 Markdown 是否保留圖片。
  - `mode`：`readability`（預設）或 `raw`（僅回 rawHtml）。
- **流程**：
  1. 透過 `/fetch` 邏輯取得 HTML。
  2. 使用 `Readability` 抽取 `title/byline/content`，並補充 `<meta property="og:*">`、`<time>`。
  3. 解析 `<img>` 與 `srcset`，套用過濾規則（追蹤圖、社群圖、尺寸過小圖）。
  4. `contentHtml` → `contentText`（移除標籤）。
  5. 若 `format=markdown` 或 `json` 且 `includeMarkdown=true`，用 `turndown` + 自訂規則轉 Markdown；保留/移除圖片依 `keepImages`。
- **回應 JSON**：
  ```json
  {
    "title": "",
    "byline": "",
    "publishedAt": "2024-05-18T02:30:00Z",
    "sourceUrl": "https://...",
    "contentHtml": "<h1>...</h1>",
    "contentText": "純文字內容",
    "markdown": "可選",
    "images": [
      { "url": "https://...", "caption": "Photo", "width": 2048, "height": 1365, "role": "hero" }
    ],
    "rawHtml": "<!doctype html>..."
  }
  ```

### 4.3 `/feeds`
- `GET /feeds`：列出所有來源（`id`, `label`, `type`, `description`，是否有 `/feeds/:id/article` 支援）。
- `GET /feeds/:id`：回傳最近 N 則文章（標題、連結、發佈時間、摘要）。RSS 預設用 `caches.default` 或 `KV` 快取 5~10 分鐘。
- `GET /feeds/:id/article?url=`：進一步調用 `/extract`，可直接輸出 JSON / Markdown。
- **資料來源設定**（`src/lib/config.js`）：
  ```js
  export const SOURCES = {
    rt: {
      label: 'RT News',
      rss: 'https://www.rt.com/rss/news/',
      allowHosts: ['www.rt.com'],
      maxItems: 20
    },
    bbc: {
      label: 'BBC World',
      rss: 'https://feeds.bbci.co.uk/news/world/rss.xml',
      allowHosts: ['www.bbc.com'],
      maxItems: 15
    },
    cnn: { ... },
    nyt: { ... }
  };
  ```

---

## 5. 開發流程

### 5.1 前置需求
- Node.js 18+（建議 20）
- npm 或 pnpm
- Cloudflare CLI：`npm install -g wrangler`，執行 `wrangler login`

### 5.2 初始化指令
```bash
git init article-import-service
cd article-import-service
npm init -y
npm install linkedom @mozilla/readability fast-xml-parser turndown hono
npm install -D wrangler miniflare vitest
```
接著建立 `wrangler.toml`，內容示例：
```toml
name = "article-import-service"
main = "src/index.js"
compatibility_date = "2024-07-01"

[vars]
ALLOW_HOSTS = "www.rt.com,*.bbc.com,edition.cnn.com,www.nytimes.com"
MAX_BYTES = "4000000"

[[kv_namespaces]]
binding = "FEEDS_CACHE"
id = "xxxxxxxxxxxxxxxxxxxxxx"

[[triggers]]
crons = ["*/5 * * * *"]
```

### 5.3 實作建議
1. **複製現有 proxy**：將 `bdc/scripts/cf-worker-proxy.js` 轉為 `routes/fetch.js`，確保 `/fetch` 正常。
2. **新增 Router**：在 `src/index.js` 建立簡易 router（可用 `itty-router` 或自寫 switch）。
3. **可讀性抽取**：實作 `lib/content-parser.js`，輸入 HTML + URL，輸出 `{ title, byline, contentHtml, rawHtml, meta }`。
4. **Markdown 工具**：`lib/markdown.js` 使用 turndown，可針對 `<figure>`、`<table>`、`<pre>` 加自訂規則。
5. **圖片處理**：`lib/images.js` 寫 `normalizeImageNode(el, baseUrl)`，處理 `srcset` 與 `data-*` 屬性，並過濾 banned host/path。
6. **Feeds**：`lib/feeds.js` 內使用 `fast-xml-parser` 解析 RSS，並撰寫 `refreshFeed(sourceId)` 函式（支援 Cron 與即時呼叫）。
7. **Node 版本**：`src/index-node.js` 引入同一組 routes，透過 `hono` / `@hono/node-server` 提供 HTTP API；搭配 `Dockerfile`：
   ```dockerfile
   FROM node:20-alpine
   WORKDIR /app
   COPY package*.json ./
   RUN npm install --omit=dev
   COPY . .
   CMD ["node", "src/index-node.js"]
   ```

---

## 6. 測試與驗證
- **本地 Worker**：`npm run dev`（對應 `wrangler dev`），在瀏覽器或 curl 測試：
  ```bash
  curl "http://127.0.0.1:8787/extract?url=https://www.rt.com/news/..." \
    -H "Accept: application/json"
  ```
- **Miniflare 測試**：撰寫 `vitest` 搭配 `miniflare` 模擬 Worker 環境，測試圖片過濾、白名單、中英文輸出。
- **Cron 驗證**：使用 `wrangler dev --test-scheduled` 驗證 `refreshFeeds`。
- **Node 版**：`node src/index-node.js` 或 `npm run dev:node`，使用 Postman/curl 測 API。

---

## 7. 部署步驟
1. **Worker 版**  
   ```bash
   wrangler login
   wrangler deploy
   wrangler tail  # 監看日誌
   ```
   - 若使用自訂網域，設定 Workers Routes（例如 `https://api.example.com/article/*`）。
   - 在 Cloudflare Dashboard → Workers → Variables 設定 `ALLOW_HOSTS`、`SOURCES_JSON`（可直接放 JSON 字串）。

2. **Docker / Node 版**  
   ```bash
   docker build -t article-import-service .
   docker run -p 8787:8787 \
     -e ALLOW_HOSTS="..." \
     -e SOURCES_JSON='{"rt": {...}}' \
     article-import-service
   ```
   - 如需水平擴充，建議放在 Kubernetes 或 Fly.io，並搭配 CDN。

---

## 8. 與 bdc 專案整合
1. 在 `bdc/ai-config.js` 設定：
   ```js
   ARTICLE_IMPORT: {
       BASE_URL: 'https://article-worker.example.workers.dev',
       PROXY_URL: 'https://article-worker.example.workers.dev/fetch?url=',
       EXTRACT_URL: 'https://article-worker.example.workers.dev/extract',
       FEED_URL: 'https://article-worker.example.workers.dev/feeds',
       SOURCES: [
           { id: 'rt', label: 'RT News' },
           { id: 'bbc', label: 'BBC World' }
       ]
   }
   ```
2. `modules/api.js` 新增對應呼叫：`fetchArticleViaWorker(url, { format })`、`listCuratedArticles(sourceId)`、`fetchCuratedArticle(sourceId, url)`。
3. 導入視窗新增「新聞來源」Tab，使用 API 串資料；若 Worker 回 Markdown，直接套用；如僅回 JSON，則交給 `api.aiExtractArticleFromHtml` / `api.aiCleanArticleMarkdown`。

---

## 9. 後續擴充構想
- **AI 清理搬到服務端**：新增 `/ai/clean` 或在 `/extract` 增加 `pipeline=worker-ai`，於 Worker 內呼叫 OpenAI/Azure API，減少前端 token 消耗。
- **文章快取**：成功清理後寫入 KV / D1 / Supabase，後續同一網址直接命中快取。
- **使用者自建庫**：可在 `/feeds/custom` 讀取 GitHub Raw 或自建 JSON，或提供 `POST /library` API 上傳 Markdown。
- **安全強化**：整合 Turnstile、人機驗證或簡易 API Key；對頻繁來源加入速率限制。
- **監控**：導入 Workers Analytics Engine、或將日誌匯出到第三方（Logtail、Better Stack）。

---

透過以上結構與流程，你可以快速建立一個獨立的文章採集服務 repo，並在 `bdc` 專案中僅透過 API 接口取得需要的格式。若之後需要搬遷（改用 Docker、Supabase Edge Functions 等），只要維持同樣的 API 契約即可無縫切換。祝開發順利！
