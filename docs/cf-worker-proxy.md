Cloudflare Worker Proxy for Article Import

概述
- 目的：繞過目標站點的 CORS 限制，僅抓取 HTML 交回前端，讓前端再交給 AI 清洗成乾淨 Markdown。
- 適用：你想在「不使用第三方轉換」的情況下，直接抓取多數網站的 HTML。
- 安全：阻擋私有網段（避免 SSRF）、可設定域名白名單、限制回應大小、只允許 HTML。

快速開始
1) 建立 Worker
- Cloudflare Dashboard → Workers & Pages → Create Worker → Quick edit。
- 將 scripts/cf-worker-proxy.js 的內容整段貼上。
- 儲存並部署（Deploy）。

2) 可選：設定域名白名單
- 在 Worker 的 Settings → Variables 中新增環境變數：
  - `ALLOW_HOSTS`：以逗號分隔的允許域名或萬用字元，例如：
    `news.example.com,*.trusted.com`
- 不設定代表任何公開站點都可請求（仍會阻擋 localhost/內網等私有位址）。

3) 測試
- 用瀏覽器或 curl 測試：
  `https://<你的-worker>.workers.dev/fetch?url=https%3A%2F%2Fexample.com%2Farticle`
- 成功會回傳 `text/html`；若內容過大或非 HTML，會回應 413/415。

4) 在前端專案配置
- 檔案：ai-config.js:105 起的 `ARTICLE_IMPORT.PROXY_URL`
- 例：
  `PROXY_URL: 'https://<你的-worker>.workers.dev/fetch?url=',`
- 儲存後，前端導入視窗（文章詳解 → 導入…）勾選「跳過第三方轉換」，貼上網址擷取即可。

使用說明與工作流程
- 前端會依序嘗試：
  1) 直接抓取目標頁面（可能被 CORS 擋下）。
  2) 若你有設 `PROXY_URL` → 透過 Worker 代抓 HTML。
  3) 若未勾選「跳過第三方轉換」，仍可回退 r.jina.ai 取得可讀文本後再 AI 清洗。
- 你也可以直接在導入視窗貼上整頁 HTML（剪貼簿 `text/html`），前端會直接交給 AI 清洗，無須 Worker。

Worker 程式要點（scripts/cf-worker-proxy.js）
- 僅支援 GET 與 OPTIONS。
- 取參數 `?url=<目標網址>`，僅允許 http/https 協定。
- 阻擋 localhost/127.0.0.1/10.x/172.16-31/192.168.x 等私有網段。
- 僅回覆 content-type 為 HTML（text/html、application/xhtml+xml）。
- Content-Length 大於 ~2MB 時回 413；未知長度則流式讀取並在超過上限時中止。
- 回覆標頭含 `Access-Control-Allow-Origin: *`，前端可直接跨域讀取。

常見問題
- 回 403（host not allowed）
  - 設了 `ALLOW_HOSTS` 但目標站不在清單內，請加入對應域名或萬用字元（如 `*.example.com`）。
- 回 415（unsupported content-type）
  - 目標回應不是 HTML（可能是 JSON、PDF、影像等），請確認網址或改用別的來源。
- 回 413（payload too large）
  - 頁面過大。可調整 Worker 內的 `MAX_BYTES`（風險：成本與延遲）。
- 仍被站方攔截
  - 可調整 User-Agent 或加入一些基本標頭；若站點需要 cookie 或 session，則不適合用此 Worker 抓取。

費用與限制
- Cloudflare Workers 免費額度可支援原型開發；正式環境請評估用量與計費。
- 請遵守目標網站服務條款與 robots 指引，僅用於被允許的內容存取。

進階（可選）
- 綁定自有網域與路由（Workers Routes），可把路徑設為 `/fetch` 並保留 `?url=` 參數。
- 加入簡單快取：可在 Worker 回應中改用 `Cache-Control: public, max-age=...`，或使用 `caches.default` 依 URL 快取一段時間。
- 主機白名單與速率限制：可在 `ALLOW_HOSTS` 搭配 KV/Vars，或再加上基本的 IP/UA 篩選與計數。

前端使用小抄
- 設定：ai-config.js → `ARTICLE_IMPORT.PROXY_URL`
- 導入視窗：勾「跳過第三方轉換」→ 貼上網址 → 擷取
- 若只想預覽再套用：取消「擷取後自動套用」，看左右對比無誤再套用。

