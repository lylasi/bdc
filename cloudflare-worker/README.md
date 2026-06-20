# bdc-sync-api（Cloudflare D1 + Worker 同步後端）

以 Cloudflare D1（SQLite）取代 Supabase 的快照同步。每位使用者一個通行碼、資料各自隔離。

- 計費按「列讀寫數」：單列快照模型每次同步只算 1 列讀/寫，免費額度（每日 500 萬列讀 / 10 萬列寫 / 5GB）幾乎用不到。
- Workers 無閒置暫停、純配額制（不超額不封）。

## 一次性部署

需要 Node.js。Wrangler 用 `npx` 即可，不必全域安裝。

```bash
cd cloudflare-worker

# 0) 複製設定範本（wrangler.toml 已被 .gitignore 忽略，不會上傳）
cp wrangler.toml.example wrangler.toml

# 1) 登入 Cloudflare
npx wrangler login

# 2) 建立 D1 資料庫（把回傳的 database_id 填進 wrangler.toml）
npx wrangler d1 create bdc-sync

# 3) 套用資料表（遠端）
npx wrangler d1 execute bdc-sync --remote --file ./schema.sql

# 4) 部署 Worker
npx wrangler deploy
```

部署完成後會得到 Worker 網址，例如：
`https://bdc-sync-api.<你的子網域>.workers.dev`
把它填到前端 `ai-config.js` 的 `SYNC.endpoint`。

> 也可全程在 Cloudflare Dashboard 網頁操作（D1 → 建庫、執行 SQL；Workers → 貼上 `src/worker.js`、綁定 D1、設定變數、部署），不一定要用 CLI。

## 新增 / 管理使用者（通行碼）

通行碼以 SHA-256 雜湊存入 `users` 表。用內附腳本產生 SQL：

```bash
# 產生 SQL（印到終端機，不會送出）
node add-user.mjs "alice-的通行碼" alice "Alice"

# 把印出的 SQL 套用到遠端 D1
npx wrangler d1 execute bdc-sync --remote --command "<上一步印出的 INSERT SQL>"
```

- `user_id` 是資料隔離鍵（每人唯一，建議用英數，如 `alice`、`bob`）。
- `label` 只是顯示用備註。
- 換通行碼：用相同 `user_id` 再跑一次即可（會覆蓋 token_hash，資料保留）。
- 移除某人：`... --command "DELETE FROM users WHERE user_id='alice';"`（其快照仍在 snapshots 表，可另行刪除）。

## 設定 CORS

`wrangler.toml` 的 `ALLOW_ORIGIN` 預設 `*`。建議改成你的網站網域後重新 `npx wrangler deploy`，降低被他人濫用的風險。

## API 速覽

| 方法 | 路徑 | 說明 |
| --- | --- | --- |
| GET | `/me` | 驗證通行碼，回 `{ user_id, label }` |
| GET | `/version` | 回 `{ version }`（輪詢用） |
| GET | `/snapshot` | 回 `{ version, updated_at, payload }` 或 `null` |
| POST | `/snapshot` | body `{ expected_version, payload }`；版本不符回 409 |

所有請求需帶 `Authorization: Bearer <通行碼>`。
