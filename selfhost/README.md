# BDC 自建同步後端（SQLite / PostgreSQL）

這個目錄提供一個零框架的 Node.js 同步伺服器，讓 BDC 不依賴 Cloudflare Worker 也能同步學習資料。適合 NAS、VPS、家用電腦或內網部署。

## 支援範圍

| 功能 | 自建伺服器 | Cloudflare Worker |
| --- | --- | --- |
| 通行碼登入、`/me` | 支援 | 支援 |
| 學習快照 `/snapshot`、`/version` | 支援（樂觀鎖） | 支援 |
| 修改通行碼、恢復碼重設 | 支援 | 支援 |
| 個人 AI 供應商憑證 `/ai-credentials` | 不支援 | 支援 |
| 全站預設 AI 供應商 `/ai-catalog` | 不支援 | 支援 |
| 管理員發布目錄 `/admin/ai-catalog` | 不支援 | 支援 |

前端仍以 localStorage／IndexedDB 為主；同步是快照式，每使用者一列 JSON。若需要 AI 供應商雲端同步，請繼續使用 Cloudflare Worker，或自行擴充本伺服器。

## 需求

- Node.js **22.13 以上**（建議 24；SQLite 使用內建 `node:sqlite`，本專案以 Node 24 測試）。
- SQLite 模式不需要 `npm install`，也不需要另外安裝資料庫。
- PostgreSQL 模式需要 `npm install`（安裝 `pg`）。

## SQLite 部署

```bash
cd selfhost

DB_DRIVER=sqlite \
SQLITE_PATH=./data/bdc-sync.sqlite \
PORT=8787 \
ALLOWED_ORIGINS=http://127.0.0.1:8313 \
node server.mjs
```

啟動時會自動建立 `users` 與 `snapshots` 資料表。看到 `listening on http://0.0.0.0:8787` 即成功。

### 建立使用者

另開終端，在 `selfhost/` 目錄執行：

```bash
node add-user.mjs alice "Alice" > /tmp/alice.sql
mkdir -p data
sqlite3 data/bdc-sync.sqlite < schema.sql
sqlite3 data/bdc-sync.sqlite < /tmp/alice.sql
```

通行碼與恢復碼只會顯示在終端一次，請立即保存。若沒有 `sqlite3` CLI：

```bash
mkdir -p data
node -e "const {DatabaseSync}=require('node:sqlite');const fs=require('fs');const db=new DatabaseSync('data/bdc-sync.sqlite');db.exec(fs.readFileSync('schema.sql','utf8'));db.exec(fs.readFileSync('/tmp/alice.sql','utf8'));"
```

> `add-user.mjs` 對既有 `user_id` 只重設通行碼與恢復碼，不會改變角色。自建伺服器沒有 AI 管理接口，`role` 只用於 `/me` 回傳。

## PostgreSQL 部署

### 1. 啟動 PostgreSQL

Docker 範例：

```bash
docker run --name bdc-postgres \
  -e POSTGRES_DB=bdc \
  -e POSTGRES_USER=bdc \
  -e POSTGRES_PASSWORD='change-me' \
  -p 5432:5432 \
  -d postgres:16
```

正式環境請使用強密碼，並只綁定需要的介面。

### 2. 安裝依賴並啟動

```bash
cd selfhost
npm install

DB_DRIVER=postgres \
DATABASE_URL='postgres://bdc:change-me@127.0.0.1:5432/bdc' \
PORT=8787 \
ALLOWED_ORIGINS=http://127.0.0.1:8313 \
node server.mjs
```

資料表同樣會在啟動時自動建立。健康檢查：

```bash
curl http://127.0.0.1:8787/health
# {"ok":true,"driver":"postgres","time":"..."}
```

### 3. 建立使用者

```bash
node add-user.mjs alice "Alice" > /tmp/alice.sql
docker exec -i bdc-postgres psql -U bdc -d bdc < /tmp/alice.sql
```

或使用本機 `psql`：

```bash
psql "$DATABASE_URL" -f /tmp/alice.sql
```

## 前端設定

編輯 `ai-config.js`（此檔不進版本控制）：

```js
export const SYNC = {
  endpoint: 'http://127.0.0.1:8787',
  poll: {
    baseMs: 90000,
    maxMs: 300000,
    pauseWhenHidden: true,
    pollOnFocus: true
  }
};
```

重新載入應用，使用 `add-user.mjs` 產生的通行碼登入即可同步。

### 局域網

- 手機／平板要把 `endpoint` 改成電腦的區網 IP，例如 `http://192.168.1.100:8787`，不能填 `localhost`。
- `ALLOWED_ORIGINS` 要包含前端來源，例如 `http://192.168.1.100:8313`；多個來源用逗號分隔。
- 若前端是 HTTPS，後端也要用 HTTPS，否則瀏覽器會阻擋混合內容。

## 反向代理與 HTTPS

建議把 Node 伺服器放在 Caddy、Nginx 或 Cloudflare Tunnel 後面，不要直接暴露連接埠。

Caddy 範例：

```caddyfile
bdc-sync.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

之後把前端 `SYNC.endpoint` 改成 `https://bdc-sync.example.com`，並把 `ALLOWED_ORIGINS` 設為正式前端 origin。

## systemd 範例

```ini
[Unit]
Description=BDC self-host sync
After=network.target

[Service]
WorkingDirectory=/opt/bdc/selfhost
Environment=DB_DRIVER=sqlite
Environment=SQLITE_PATH=/var/lib/bdc/bdc-sync.sqlite
Environment=PORT=8787
Environment=ALLOWED_ORIGINS=https://bdc.example.com
ExecStart=/usr/bin/node server.mjs
Restart=on-failure
User=bdc

[Install]
WantedBy=multi-user.target
```

若使用 PostgreSQL，把 `DB_DRIVER` 改為 `postgres`，並加上 `DATABASE_URL`。`User=bdc` 需能寫入 `SQLITE_PATH` 所在目錄。

## 備份

SQLite：

```bash
sqlite3 data/bdc-sync.sqlite ".backup '/path/to/bdc-sync-backup.sqlite'"
```

PostgreSQL：

```bash
pg_dump "$DATABASE_URL" > bdc-sync-backup.sql
```

定期備份並把備份放在網站目錄之外。

## API

所有需要登入的請求使用 `Authorization: Bearer <通行碼>`。

| 方法 | 路徑 | 說明 |
| --- | --- | --- |
| GET | `/health` | 健康檢查（免登入） |
| GET | `/me` | `{ user_id, label, role }` |
| GET | `/version` | `{ version }` |
| GET | `/snapshot` | `{ version, updated_at, payload }` 或 `null` |
| POST | `/snapshot` | `{ expected_version, payload }`；版本不符回 409；舊格式文章群組回 409 `articles_legacy_write_blocked` |
| GET | `/articles?cursor=N&limit=` | 文章增量同步（伺服器游標） |
| GET | `/articles?full=1&includeDeleted=1` | 完整文章清單（僅 metadata） |
| POST | `/articles/batch` | `{ ids: [...] }` 批次讀取完整文件（最多 50） |
| POST | `/articles` | 新增（`clientMutationId` 冪等） |
| GET | `/articles/:id` | 單篇完整文件 |
| PUT | `/articles/:id` | `{ expectedRevision, ... }` 原子版本檢查 |
| DELETE | `/articles/:id` | `{ expectedRevision }` 軟刪除 |
| POST | `/articles/:id/restore` | `{ expectedRevision }` 復原 |
| POST | `/articles/import` | 舊文章匯入（保留原 ID；`final: true` 開啟閘門） |
| GET | `/articles/usage` | 用量與限制 |
| POST | `/change-token` | `{ new_token }`，需登入，至少 32 字元 |
| POST | `/reset-token` | `{ user_id, recovery_code, new_token }`，免登入 |

`/ai-credentials`、`/ai-catalog`、`/admin/*` 會回 `501 not_supported`。

## 文章逐篇儲存

`articles`、`article_changes`、`article_state` 三張表由 `schema.sql` 在啟動時以
`IF NOT EXISTS` 建立，既有安裝直接重啟即可取得；若想先手動套用，見
`migrations/001_article_storage.sql`（可重複執行）。**套用前請先備份資料庫**。

文章 API 直接重用 Cloudflare Worker 的實作（`../cloudflare-worker/src/articles.js`）
與共用驗證（`../shared/article-protocol.mjs`），因此兩個後端的路由、SQL 語意、
錯誤碼、`expectedRevision` 衝突規則與冪等行為一致；`tests/articles-protocol.test.mjs`
會把同一份情境分別跑在兩邊。

瀏覽器需要 `PUT`／`DELETE`（更新與刪除），CORS 已允許這兩個方法；若前面有反向代理，
請一併放行。

## 疑難排解

| 現象 | 處理 |
| --- | --- |
| `Cannot find module 'node:sqlite'` | Node 版本過舊，請升級至 22.13+ 或 24 |
| `PostgreSQL 模式需要 pg 套件` | 在 `selfhost/` 執行 `npm install` |
| `origin_not_allowed` | `ALLOWED_ORIGINS` 必須是完整 origin，不要加路徑或結尾斜線 |
| 登入回 401 | 通行碼錯誤，或 `add-user.mjs` 的 SQL 尚未套用 |
| 同步回 409 | 版本衝突，前端會重新拉取；持續發生時重新整理再試 |
| 手機連不上 | 確認 `endpoint` 用區網 IP、防火牆放行、伺服器綁定 `0.0.0.0` |

## 安全提醒

- `ALLOWED_ORIGINS` 未設定時會允許任何來源；正式環境務必設定明確清單。
- 通行碼以 SHA-256 雜湊儲存；請使用 `add-user.mjs` 產生的 43 字元隨機值。
- 限流是單一行程內的盡力而為，不是全域配額；公開部署請在反向代理加上限流。
- 不要把 `data/*.sqlite`、`.env` 或 `DATABASE_URL` 提交到版本控制。
