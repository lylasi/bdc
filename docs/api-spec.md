# API 規格

## /fetch
- 方法：`GET /fetch`
- Query 參數：
  - `url`（必填，string，http/https）目標文章網址。
- 行為：代理抓取遠端 HTML，套用白名單、私網阻擋、檔案大小限制（`MAX_BYTES`，預設 4,000,000 bytes），回應帶 `Access-Control-Allow-Origin: *`。
- 安全限制：
  - 允許的網域：`ALLOW_HOSTS`（逗號分隔，可含 `*.bbc.com`）。
  - 私網/localhost 直接拒絕；負責檢查 DNS → IP → 區網。
  - 大小限制：Content-Length 或串流長度超過 `MAX_BYTES` 回 `413`。
  - 速率限制：預設 60 req / 分鐘 / IP。
- 範例：
  ```bash
  curl "$BASE_URL/fetch?url=https%3A%2F%2Fwww.bbc.com%2Fnews%2Fworld"
  ```
- 典型成功回應：`200 OK`，content-type 隨遠端回傳（多為 `text/html`）。

## /extract
- 方法：`GET /extract`
- Query 參數：
  - `url`（必填，string，http/https）要抽取的文章網址。
  - `format`（選填，enum：`json`|`html`|`markdown`，預設 `json`）決定回應格式。
  - `keepImages`（選填，boolean，預設 `false`）
    - `format=markdown`：是否保留 `![img]`。
    - `format=json`：若 `includeMarkdown=true`，決定 `markdown` 欄位是否保留圖片。
  - `includeMarkdown`（選填，boolean，預設 `false`）`format=json` 時附帶 `markdown` 欄位。
  - `mode`（選填，enum：`readability`|`raw`，預設 `readability`）
    - `readability`：使用 Readability 抽取。
    - `raw`：直接回傳原始 HTML，不解析、不產生 markdown。
- 成功回傳（`format=json` 範例）：
  ```json
  {
    "title": "Israel confirms ...",
    "byline": "BBC News",
    "publishedAt": "2024-11-14T08:41:48.000Z",
    "sourceUrl": "https://www.bbc.com/news/world-asia-...",
    "contentHtml": "<article><p>...</p></article>",
    "contentText": "純文字內容...",
    "markdown": "# Title\n\n正文...",
    "images": [
      { "url": "https://ichef.bbci.co.uk/...jpg", "alt": "", "width": 1200, "height": 800 }
    ],
    "rawHtml": "<!doctype html>..."
  }
  ```
- 成功回傳（`format=markdown` 範例）：`text/markdown` 內容，如
  ```
  # Title

  第一段內文...
  ```
- 成功回傳（`format=html` 範例）：直接輸出 `contentHtml`，content-type `text/html`。
- 成功回傳（`mode=raw` 範例）：直接輸出遠端 HTML 與原始 headers，content-type 隨遠端。
- 範例請求：
  ```bash
  # JSON（預設）
  curl "$BASE_URL/extract?url=https%3A%2F%2Fwww.bbc.com%2Fnews%2Farticle123"

  # Markdown 並保留圖片
  curl "$BASE_URL/extract?format=markdown&keepImages=true&url=https%3A%2F%2Fedition.cnn.com%2F2024%2F11%2F14%2Ftech%2Fstory.html"

  # JSON + markdown 欄位，但 Markdown 去除圖片
  curl "$BASE_URL/extract?url=https%3A%2F%2Fwww.nytimes.com%2F...&includeMarkdown=true&keepImages=false"
  ```
- 限制：同 `/fetch` 的白名單、私網阻擋、大小限制，並有速率限制（預設 40 req/分鐘/IP）。

## /feeds
- `GET /feeds`
  - 用途：列出系統內所有來源。
  - 回傳示例：
    ```json
    {
      "sources": [
        { "id": "bbc", "label": "BBC World", "type": "rss", "description": "BBC World feed", "hasArticleProxy": true, "maxItems": 15 }
      ]
    }
    ```

- `GET /feeds/:id`
  - Query：`refresh`（選填，boolean，預設 `false`，true 則跳過 KV 直接抓遠端）。
  - 回傳示例：
    ```json
    {
      "id": "bbc",
      "items": [
        { "title": "Headline", "url": "https://www.bbc.com/...", "summary": "...", "publishedAt": "2024-11-14T08:41:48.000Z" }
      ],
      "refreshedAt": "2024-11-14T08:45:00.000Z"
    }
    ```

- `GET /feeds/:id/article`
  - Query：
    - `url`（必填）目標文章網址，會先檢查該來源的 `allowHosts`。
    - 其餘 `format`、`keepImages` 等同 `/extract`。
  - 行為：以該來源的白名單包裝 `/extract`，回應格式同 `/extract`。
  - 範例：
    ```bash
    curl "$BASE_URL/feeds/bbc/article?url=https%3A%2F%2Fwww.bbc.com%2Fnews%2Farticle123&format=markdown"
    ```
  
- `GET /feeds/:id/refresh`
  - 用途：管理員或 Cron 強制刷新 KV，並回傳最新 feed payload。
  - 無額外參數；可能受權限/環境變數保護。
  - 範例：
    ```bash
    curl "$BASE_URL/feeds/rt/refresh"
    ```

## 錯誤格式
- 統一使用 JSON：
  ```json
  { "error": "Bad Request", "status": 400, "details": "URL is required" }
  ```
- 常見狀態碼：
  - `400` 缺少必要參數或網址不合法
  - `403` 網域不在白名單 / 遠端拒絕
  - `413` 超出 `MAX_BYTES`
  - `422` RSS/JSON 解析失敗
  - `429` 超過速率限制
  - `500` 伺服端未預期錯誤
