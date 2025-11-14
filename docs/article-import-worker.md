# 文章導入功能升級與 Cloudflare Worker 方案

## 目標
- **URL 導入強化**：在 `features/article/article.js` 既有導入視窗中，支援自家 Worker 進行 HTML 擷取與標題/正文/圖片抽取，減少對第三方服務的依賴。
- **固定新聞來源**：在導入視窗新增「新聞來源」分頁，由 Worker 端定期抓取已配置的 RSS/JSON，前端只需點擊標題即可導入。
- **AI 清理串接**：將 Worker 返回的結構化資料透過現有 `api.aiExtractArticleFromHtml` / `api.aiCleanArticleMarkdown` 管線轉成最終 Markdown。

## 系統架構概觀
1. 使用者在導入視窗貼上網址或選擇新聞來源。
2. 前端（`modules/api.js`）呼叫 Cloudflare Worker：
   - `/fetch`：維持原始 HTML 代理（現有 `scripts/cf-worker-proxy.js`）。
   - `/extract`：新增路由，Worker 直接回傳標題、正文 HTML、關鍵圖片清單。
   - `/feeds/:source`：新增路由，提供固定新聞來源列表。
3. 前端收到資料後，交給既有 AI 清理程式，再套用到 `dom.articleInput`。
4. 相關設定透過 `ai-config.js` → `ARTICLE_IMPORT` 區塊集中管理。

## Cloudflare Worker 擴充設計

### 路由規劃
| Method | Path | 說明 |
| --- | --- | --- |
| `GET` | `/fetch?url=` | 沿用現有代理，僅回傳 HTML，方便需要自行貼上 HTML 的使用情境。 |
| `GET` | `/extract?url=&mode=markdown` | 抓取 HTML → 解析 → 回傳 JSON，包含 `title`、`byline`、`publishedAt`、`contentHtml`、`contentText`、`images`、`rawHtml`。`mode=markdown` 時，可讓 Worker 先行呼叫 AI 或用 `Readability` 轉 Markdown。 |
| `GET` | `/feeds/:id` | 抓取並快取固定新聞來源（RSS/JSON），以 `{ title, url, publishedAt, sourceId }[]` 格式回傳。 |
| `GET` | `/feeds/:id/article?url=` | （可選）直接串聯 `/extract`，讓前端一次取得解析結果。 |

### HTML 抽取流程
1. **基礎取用**：沿用 `scripts/cf-worker-proxy.js` 的私網阻擋、白名單、大小限制、UA 偽裝等邏輯，確保 `/extract` 與 `/fetch` 一致安全。
2. **可讀性分析**：
   - 透過 `linkedom` + `@mozilla/readability`（或 Cloudflare 官方 `html-rewriter` + 自行實作 DOM parser）於 Worker 內進行正文萃取。
   - `Readability.parse()` 會提供 `title`、`byline`、`content`（HTML）；並可自行補強：從 `<meta property="og:title">`、`<meta name="author">`、`<time>`、`article:published_time` 取得缺漏資訊。
3. **圖片策略**：
   - 先收集 `<meta property="og:image">`、`twitter:image` 作為首圖備用。
   - 在正文 HTML 內搜尋 `<img>`：若有 `srcset`，選擇最大寬度項；儲存 `url`、`caption`（優先 `<figcaption>` 或 `alt`）、`width`、`height`。
   - 過濾追蹤與社群圖（可沿用 `modules/api.js` 中 `bannedImageHosts`/`bannedImagePathHints` 陣列）。
4. **回傳結構**（示例）：
   ```json
   {
     "title": "Example Article",
     "byline": "John Doe",
     "publishedAt": "2024-05-18T02:30:00Z",
     "source": "https://news.example.com/foo",
     "contentHtml": "<h1>...</h1><p>...</p>",
     "contentText": "純文字版本（移除標籤）",
     "images": [
       { "url": "https://...", "caption": "Photo: Agency", "width": 2048, "height": 1365, "role": "hero" }
     ],
     "rawHtml": "<!doctype html>..."
   }
   ```
5. **回傳頭**：和 `/fetch` 一樣加上 `Access-Control-Allow-Origin: *`；必要時加 `Cache-Control: public, max-age=180`，再配合 Worker `caches.default` 或 KV 做短暫快取。

### 固定新聞來源（Feeds）模組
1. 在 Worker 內定義 `SOURCES`（亦可透過 `KV` 或環境變數載入），格式例如：
   ```js
   const SOURCES = {
     guardian: { label: 'The Guardian US', rss: 'https://www.theguardian.com/us/rss', allowHosts: ['www.theguardian.com'], max: 12 },
     techcrunch: { label: 'TechCrunch', rss: 'https://techcrunch.com/feed/', max: 15 },
     cna: { label: '中央社即時', rss: 'https://www.cna.com.tw/rss.aspx?Type=0' }
   };
   ```
2. `/feeds/:id` 流程：
   - 驗證 `id` 是否存在，並檢查對應 `allowHosts` 是否已在 Worker 白名單。
   - 以 `fetch()` 抓取 RSS/JSON；RSS 解析可用 `fast-xml-parser`（node 版可透過 esbuild 打包）。
   - 將結果（標題、連結、時間）寫入 `KV` 或 `caches.default`，過期時間 5~10 分鐘。
3. `/feeds/:id/article` 可直接呼叫 `extractArticle(url)`，並附帶 `sourceId`，方便前端紀錄來源。
4. 如需排程自動刷新，在 Worker 新增 Cron Trigger，每 5 分鐘預先抓取一次熱門來源，降低首次載入延遲。

### 安全與限制
- **Host 白名單**：沿用 `ALLOW_HOSTS`；對 `/feeds` 來源自動加入對應網域，以免 RSS/文章連結被拒。
- **請求節流**：於 Worker 內對 `url` 設定 `RATE_LIMIT_PER_MINUTE`，超過回 `429`，前端再退回 r.jina.ai。
- **內容大小**：`MAX_BYTES` 可視需求調整至 3–4 MB，以容納圖片豐富的新聞頁。
- **錯誤回傳**：以 JSON 物件 `{ error, code }` 提示前端做 UI 陳述（例如提示需降級至第三方轉換）。

## 前端整合計畫

### ai-config.js
在 `ARTICLE_IMPORT` 中新增設定：
```js
ARTICLE_IMPORT: {
    PROXY_URL: 'https://worker.example.workers.dev/fetch?url=',
    EXTRACT_URL: 'https://worker.example.workers.dev/extract?url=',
    FEED_URL: 'https://worker.example.workers.dev/feeds',
    SOURCES: [
        { id: 'guardian', label: 'The Guardian US' },
        { id: 'techcrunch', label: 'TechCrunch' },
        { id: 'cna', label: '中央社即時' }
    ],
    DEFAULT_MODEL: 'gpt-4o-mini',
    keepImagesDefault: true
}
```
`FEED_URL` 作為前端查詢列表的根路徑，`SOURCES` 用於渲染 UI 與 fallback（例如 Worker 無回應時仍可顯示按鈕）。

### modules/api.js
1. 新增 `fetchArticleViaWorker(url, opts)`：
   - 嘗試 `ARTICLE_IMPORT.EXTRACT_URL + encodeURIComponent(url)`。
   - 成功時返回 Worker JSON，並視 `opts.wantMarkdown` 決定是否立即呼叫 `aiExtractArticleFromHtml`。
2. 新增 `listCuratedArticles(sourceId)` 與 `fetchCuratedArticle(sourceId, url)`，分別對 `/feeds/:id` 與 `/feeds/:id/article` 發送請求。
3. 在既有 `fetchArticleCleanMarkdown` 中，若 `opts.useWorkerExtract` 為真，優先走 Worker 路徑，失敗再退回 `fetchArticleFromUrlStructured`。

### features/article/article.js
1. 在導入視窗的 tabs 新增「新聞來源」按鈕（例如 `btnNews`）。
2. 新增 `renderNews()`：
   - 根據 `ARTICLE_IMPORT.SOURCES` 渲染左側來源列表，點擊後向 Worker 請求 `/feeds/:id`。
   - 以 `<ul>` 顯示標題 + 發布時間，提供「導入」與「預覽」按鈕。
3. 使用者點擊導入時：
   - 顯示 loading（`btn.disabled = true`），呼叫 `api.fetchCuratedArticle(sourceId, url)`。
   - 若 Worker 僅回傳原始 HTML，則傳給 `api.aiExtractArticleFromHtml()`；若 Worker 已返回 Markdown，直接填入。
   - 完成後依 `imp-ai-clean` / `imp-auto-apply` 選項決定是否顯示預覽或直接寫入輸入框。
4. 若 Worker 失敗或超時：
   - 顯示提示並 fallback 至現有 `fetchArticleFromUrlStructured` + `aiClean` 流程。
5. 記錄最近導入的來源，可存於 `localStorage`（沿用 `LS` 物件），下次預設開啟同一來源。

## 部署流程（Cloudflare Workers）
1. **準備專案**
   ```bash
   cd scripts
   npm create cloudflare@latest article-worker
   cd article-worker
   npm install linkedom @mozilla/readability fast-xml-parser
   ```
   將現有 `scripts/cf-worker-proxy.js` 作為 `src/fetch.js` 的基礎，新增 `/extract` 與 `/feeds` 邏輯。
2. **設定環境變數**
   - 在 `wrangler.toml` 加入：
     ```toml
     [vars]
     ALLOW_HOSTS = "news.example.com,*.guardian.co.uk"
     SOURCES_JSON = '{ "guardian": { ... }, "techcrunch": { ... } }'
     ```
   - 若使用 KV 快取：
     ```toml
     [[kv_namespaces]]
     binding = "FEEDS_KV"
     id = "xxxx"
     ```
3. **部署**
   ```bash
   npm run build   # 以 esbuild/Miniflare 打包
   npx wrangler deploy
   ```
   或在 Cloudflare Dashboard → Workers → Upload → 貼上編譯後腳本。
4. **綁定自訂網域（可選）**
   - Workers Routes 指向 `/article-import/*`，方便在 `ai-config.js` 中使用同一 base URL。
5. **設定 Cron Trigger（可選）**
   - 在 `wrangler.toml` 新增：
     ```toml
     [[triggers]]
     crons = ["*/5 * * * *"]
     ```
   - Cron handler 觸發 `refreshFeeds()`，預熱熱門來源。

## 驗證流程
1. 手動測 `docs/cf-worker-proxy.md` 既有步驟，確認 `/fetch` 正常。
2. 新測 `/extract`：
   - 一般網站：確認回傳 JSON 含 `title`、`images`。
   - 需要代理的網站：確認 Worker 仍可抓到 HTML。
   - 超過大小或白名單：確認 413/403 文案。
3. 新聞來源：
   - 進入導入視窗 → 新分頁能載入來源列表。
   - 點擊標題 → 預期 3 秒內產出清洗後內容。
   - Worker 故障時，UI 能顯示 fallback 提示並維持舊流程。
4. AI 清理：
   - 勾選/取消「保留圖片」、「自動套用」等選項，確保仍能呼叫 `api.aiCleanArticleMarkdown`。
5. 測 `test-floating-statusbar.html`，確認新增導入流程對其他模組無副作用。

## 後續建議
- 若 Worker 頻繁被某些站點阻擋，可在 `scripts/cf-worker-proxy.js` 中加入多組 UA 或 header templates，並透過 `ALLOW_HOSTS` 指定。
- 可將已清洗的內容（Markdown）回寫到 KV，前端再次請求同文章時直接命中快取，減少 AI 成本。
- 視需求在 docs 更新 `cf-worker-proxy.md`，附上 `/extract` 參數說明與範例 curl，方便其他成員查閱。

