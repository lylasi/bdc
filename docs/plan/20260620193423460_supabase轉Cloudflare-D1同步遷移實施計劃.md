# Supabase → Cloudflare D1 + Worker 同步遷移實施計劃

- 日期：2026-06-20
- 方案：以 Cloudflare D1（SQLite）+ Worker 取代 Supabase 同步
- 認證：**單一通行碼**（單使用者/少數人共用）
- 前置調研：見 `docs/research/20260620174829159_supabase換本地sqlite可行性分析.md`

---

## 1. 目標

1. 徹底脫離 Supabase（已被封 + 7 天閒置暫停 + 「資源占用過高」限制）。
2. 換成 **Cloudflare D1（本質是 SQLite）+ Worker**：
   - 按「列讀寫數」計費，單列快照模型每次同步只算 1 列讀/寫 → 永遠用不到免費額度。
   - Workers 無閒置暫停、純配額制（不超額不封）。
3. 維持現有的 **local-first + 單列 JSON 快照 + group-level LWW** 模型，**不重寫合併邏輯**。

## 2. 架構總覽

```
瀏覽器 (純前端 SPA)
  │  fetch + Authorization: Bearer <通行碼>
  ▼
Cloudflare Worker  (sync-api)
  │  - GET  /snapshot          → 讀取當前快照
  │  - POST /snapshot          → 樂觀鎖寫入 (expected_version)
  │  - 校驗 env.SYNC_TOKEN
  │  - CORS 預檢
  ▼
Cloudflare D1 (SQLite)  表 snapshots(user_id, version, updated_at, payload)
```

- `sync-core.js` 的 `buildLocalSnapshot / applyMergedSnapshot / lwwMerge` **完全沿用**。
- Realtime 訂閱 → 降級為 **輪詢**（focus / visibilitychange + 定時拉取比對 version）。

## 3. 認證設計（單一通行碼）

- 通行碼存在 Worker 的 secret：`env.SYNC_TOKEN`。
- 前端登入 = 輸入通行碼 → 存 `localStorage('sync_token')` → 之後每次請求帶
  `Authorization: Bearer <通行碼>`。
- `user_id` 固定為常數（如 `'default'`），整張表只有 1 列。
  - 若日後要分人，可改成「每個通行碼對應一個 user_id」，表結構不用變。
- **不需要**：郵箱註冊、OTP、magic link、密碼重置、密碼修改 → 這些前端 UI 全部移除。

## 4. 資料遷移（重點：幾乎零遷移）

- 本專案是 **local-first**，核心資料一直在本機 `localStorage` + IndexedDB。
- 即使 Supabase 已被封拿不到雲端資料，**本機資料仍在**。
- 切換後端後，第一次同步會自動把本機快照 `push` 上 D1 → 完成「上雲」。
- 因此**無需從 Supabase 匯出**。若擔心，先用現有 `local-backup.js → createBackup()` 做一份本機備份即可。

## 5. 後端實施（Cloudflare）

### 5.1 D1 schema（`cloudflare-worker/schema.sql`）

```sql
CREATE TABLE IF NOT EXISTS snapshots (
  user_id    TEXT PRIMARY KEY,
  version    INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  payload    TEXT NOT NULL          -- JSON 字串（D1 無原生 JSON 型別）
);
```

### 5.2 Worker（`cloudflare-worker/src/worker.js`）核心契約

對齊現有前端期望（見 `modules/sync-supabase.js`）：

- `GET /snapshot`
  - 回傳 `{ version, updated_at, payload(物件) }`；無資料回 `null`。
- `POST /snapshot`  body：`{ expected_version, payload }`
  - 若 `expected_version !== 當前 version` → HTTP 409 + `{ conflict:true }`
  - 否則 `version+1`、寫入，回 `{ conflict:false, version, updated_at }`
- 認證：`Authorization: Bearer <token>` 比對 `env.SYNC_TOKEN`，不符回 401。
- CORS：處理 `OPTIONS` 預檢，回 `Access-Control-Allow-Origin`（先用 `*`，或鎖定你的網站網域）。

> 樂觀鎖等價於 Supabase 端的 `save_snapshot(expected_version, payload)` 與衝突碼 `40001`。

### 5.3 設定（`cloudflare-worker/wrangler.toml`）

```toml
name = "bdc-sync-api"
main = "src/worker.js"
compatibility_date = "2026-01-01"

[[d1_databases]]
binding = "DB"
database_name = "bdc-sync"
database_id = "<wrangler d1 create 後填入>"
```

- secret：`wrangler secret put SYNC_TOKEN`（或 Dashboard → Worker → Settings → Variables）。
- 部署：`wrangler deploy`（或全程用 Dashboard 網頁建立，不必用 CLI）。

## 6. 前端改動清單

| 檔案 | 動作 | 說明 |
| --- | --- | --- |
| `modules/sync-cloudflare.js` | 🆕 新增 | 對外導出與舊檔**同名**接口：`syncNow / auth / subscribeSnapshotChanges / unsubscribeChannel`，內部改用 fetch Worker。`auth` 做成輕殼（通行碼存取 + getSession 讀 localStorage）。`subscribeSnapshotChanges` 改成輪詢實作。 |
| `modules/sync-supabase.js` | 🗄️ 保留不引用 | 暫不刪，作為回滾後備。 |
| `modules/sync-core.js` | ✅ 不動 | 合併/套用/還原邏輯完整沿用。 |
| `features/sync/sync.js` | ✏️ 改 import + 精簡 auth UI | import 改指向 `sync-cloudflare.js`；`showLoginModal` 改為「輸入通行碼」；移除 `handleAuthCallbackIfAny / showResetPasswordModal / showChangePasswordModal` 及 OTP/註冊相關分支；`attachRealtime` 改呼叫輪詢。 |
| `ai-config.example.js` / `ai-config.js` | ✏️ 改 | 移除/保留 `SUPABASE`，新增 `SYNC = { endpoint: 'https://bdc-sync-api.<you>.workers.dev' }`（通行碼由使用者登入時輸入，不寫進 config）。 |
| `index.html` | ⚠️ 檢查 | 登入相關 DOM 若有 email/註冊欄位，配合精簡。 |
| `CLAUDE.md` / `docs/*` | ✏️ 更新 | 同步模組描述、storage/sync 文件。 |

### 6.1 Realtime → 輪詢策略

- 移除 `supabase.channel(...postgres_changes...)`。
- 改為：`visibilitychange`/`focus` 時拉一次 + 每 30~60s 輪詢 `GET /snapshot` 比對 `version`，
  version 變了才觸發 `scheduleAutoSync('poll')`。
- 對單列快照模型完全足夠，且 D1 列讀額度用不完。

## 7. 風險與回滾

- **回滾**：保留 `sync-supabase.js` 與 `SUPABASE` 設定；把 `sync.js` 的 import 切回即可恢復（前提是 Supabase 帳號可用）。
- **通行碼洩漏**：通行碼即唯一憑證，務必夠長且只在自己/家人間分享；CORS 可鎖網域降低濫用。
- **首次上雲覆蓋**：第一次同步走既有 LWW + `isLikelyAccidentalWipe` 防呆，本機有資料時不會被空遠端清掉。

## 8. 驗證清單（手動）

1. 未登入狀態：同步入口停用 / 提示輸入通行碼。
2. 輸入正確通行碼 → 首次同步 → D1 出現 1 列、version=1，本機資料完整。
3. 改一本詞書 → 6s 後自動同步 → version 遞增。
4. 另一台裝置/另一瀏覽器輸入同通行碼 → 拉到資料；兩端交叉修改 → LWW 合併正確。
5. 輸入錯誤通行碼 → 401，不影響本機資料。
6. 關閉網路 → 本機照常用；恢復網路 → 自動補同步。
7. 既有回歸：詞書 CRUD、聽寫、測驗離開保護、文章分析、QA、assistant。
8. `test-floating-statusbar.html` 平台/浮動狀態列不受影響。

## 9. 執行步驟（建議順序）

**A. 後端（你操作，我提供全部檔案/指令）**
1. 註冊 Cloudflare 帳號。
2. 建 D1：`wrangler d1 create bdc-sync`（或 Dashboard），套用 `schema.sql`。
3. 設定 `SYNC_TOKEN`（你自訂的通行碼）。
4. `wrangler deploy`，拿到 Worker URL。

**B. 前端（我寫程式）**
5. 新增 `modules/sync-cloudflare.js`。
6. 改 `features/sync/sync.js`（切 import + 精簡 auth UI + 輪詢）。
7. 改 `ai-config.example.js`（加 `SYNC.endpoint`）。
8. 你把 Worker URL 填進 `ai-config.js`。

**C. 驗證**
9. 依第 8 節逐項手動驗證。
10. 更新 `CLAUDE.md` 與相關 docs。

---

## 10. 待你確認/決定的點

1. Worker URL 用預設 `*.workers.dev` 還是綁自己的網域？（預設即可，最省事）
2. 你的網站部署在哪個網域？（用於 CORS 鎖定；不確定可先用 `*`）
3. 輪詢間隔預設 **45s**，可接受？
4. 是否要我在倉庫內新增 `cloudflare-worker/` 目錄統一存放 Worker 原始碼與設定？（建議：是）
