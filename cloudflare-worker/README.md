# bdc-sync-api（Cloudflare D1 + Worker 同步後端）

以 Cloudflare D1（SQLite）保存學習快照、個人 AI 供應商金鑰，以及管理員發布的全站預設 AI 供應商列表。Worker **不會**代理 AI 請求；瀏覽器取得設定後直接呼叫供應商。

- 學習資料：每位使用者一列 JSON 快照，沿用樂觀鎖。
- 個人 AI 金鑰：`user_ai_credentials`，AES-256-GCM 加密，逐供應商版本控制。
- 全站預設：`ai_default_catalog_releases`，每次「發布」建立不可變版本，共用 Key 另存加密信封。
- 帳戶權限：`users.role`（`user` / `admin`），由服務端每次請求檢查。
- 用戶管理：管理員可在前端新增用戶、修改備註／電郵、設定使用者名稱與初始密碼、重設非管理員通行碼；角色調整與刪除仍由部署者維護。
- 使用者名稱＋密碼：管理員為帳戶設定 `username` 與初始密碼後，使用者可在主站以「使用者名稱＋密碼」登入；密碼以 PBKDF2-SHA256（50,000 次）加伺服器端 pepper 雜湊，`auth_version` 會讓改密碼／重設通行碼即時撤銷舊 session。
- 裝置配對：管理員可為非管理員用戶產生 10 分鐘一次性配對碼，新裝置用它換取 180 天 session token；重設通行碼會撤銷所有已配對 session。

## 一次性部署（既有服務升級）

完整命令、首次安裝分支、帳戶 SQL 套用與前端發布流程見 [逐步部署與維護手冊](../docs/release/20261018025155000_AI供應商逐步部署與維護手冊.md)。

> 執行前先備份 D1，並安全保管對應版本的 Worker 主密鑰。只有密文備份無法還原 Key。

```bash
cd cloudflare-worker

# 0) 設定檔（wrangler.toml 已被 .gitignore 忽略）
test -f wrangler.toml || cp wrangler.toml.example wrangler.toml
# 填入 database_id、ALLOWED_ORIGINS（或先沿用 ALLOW_ORIGIN）

# 1) 備份
npx wrangler d1 export bdc-sync --remote --output backup-$(date +%Y%m%d).sql

# 2) 套用 migration（各只需一次，按編號順序）
npx wrangler d1 execute bdc-sync --remote --file ./migrations/001_ai_provider_sync.sql
npx wrangler d1 execute bdc-sync --remote --file ./migrations/002_admin_user_management.sql
npx wrangler d1 execute bdc-sync --remote --file ./migrations/003_device_pairing.sql
npx wrangler d1 execute bdc-sync --remote --file ./migrations/004_article_storage.sql
npx wrangler d1 execute bdc-sync --remote --file ./migrations/005_username_password.sql

# 3) 核對秘密；已有值必須保留，只有缺少時才執行相應的 put
npx wrangler secret list
# 首次設定：各用 openssl rand -base64 32 產生不同值，保存到密碼管理器再輸入
npx wrangler secret put AI_CREDENTIAL_KEY_V1
npx wrangler secret put AI_CATALOG_DIGEST_KEY
# 使用者名稱＋密碼登入用；至少 32 字元，設定後 /auth-capabilities 才會回報 passwordLogin: true
npx wrangler secret put PASSWORD_PEPPER

# 4) 指定首名管理員（先確認 user_id）
npx wrangler d1 execute bdc-sync --remote \
  --command "UPDATE users SET role='admin' WHERE user_id='<confirmed-user-id>';"

# 5) 部署 Worker
npx wrangler deploy
```

全新資料庫可直接執行 `schema.sql`，再設定秘密與管理員。

### 通行碼規則

憑證與預設 Key 接口**拒絕少於 32 字元**的舊通行碼（回 `403 passcode_upgrade_required`）。建立或重設使用者請用新的產生器：

```bash
node add-user.mjs <user_id> [label]          # 自動產生 43 字元隨機通行碼
node add-user.mjs --admin <user_id> [label]  # 新帳戶直接設為 admin（既有帳戶角色不變）
```

`add-user.mjs` 只輸出 SQL，必須另行保存到網站外的私密檔案，再以 `wrangler d1 execute --remote --file` 套用。其 `ON CONFLICT` 只更新通行碼／恢復碼／label，**不會**提升或清除既有角色。學習快照仍接受舊通行碼，讓既有帳戶可以先同步資料；AI 相關功能會提示先更新通行碼。

### 管理用戶（v1）

套用 `002_admin_user_management.sql` 後，管理員可在 BDC「設定 → 工具 → 管理用戶」：

- 查看用戶列表（用戶代號、備註、角色、可選電郵、建立時間）。
- 新增 `role=user` 帳戶；Worker 產生 43 字元通行碼與恢復碼，**只顯示一次**。
- 修改備註名稱與可選電郵；用戶代號建立後不可修改。
- 重設非管理員帳戶的通行碼／恢復碼；該用戶舊通行碼立即失效。
- 為非管理員帳戶產生一次性配對碼（12 字元、10 分鐘有效），供新裝置登入。

### 裝置配對登入

套用 `003_device_pairing.sql` 後，新裝置可在登入彈窗選「使用裝置配對碼」，輸入
「用戶代號 + 配對碼」換取 180 天 session token：

- 配對碼只存 SHA-256 雜湊，使用一次後即失效；所有失敗一律回 `403 pairing_invalid`。
- 配對不會改動原本通行碼，也不會登出其他已登入裝置。
- 管理員帳戶不可產生配對碼。
- 自助重設通行碼、登入後修改通行碼或管理員重設通行碼，都會刪除該用戶所有
  `user_sessions` 與未使用的 `pairing_codes`，可用於遺失裝置的補救。

以下操作仍由部署者維護，不提供管理介面：

- 角色調整（`user` / `admin`）。
- 刪除或停用帳戶。
- 管理員帳戶的通行碼重設。
- 首名管理員初始化；管理介面無法解決冷啟動。

所有管理操作寫入 `admin_audit_log`（操作者、動作、目標、時間），不記錄通行碼、恢復碼或明文電郵。

## 遷移順序（正式切換）

1. 備份 D1（`npx wrangler d1 export bdc-sync --remote --output backup-<date>.sql`）。
2. 套用 migration（`001`～`005`；`005_username_password.sql` 只新增使用者名稱／密碼與 `auth_version` 欄位，既有帳戶與 session 預設為版本 1，不影響原本登入）。
3. 設定 `AI_CREDENTIAL_KEY_V1`、`AI_CATALOG_DIGEST_KEY`、`PASSWORD_PEPPER`、`AI_CREDENTIAL_KEY_VERSION`，指定首名管理員。
4. 部署新 Worker。
5. 在私密發布副本移除靜態 AI 預設並通過掃描，再部署新版前端（`ai-config.js` 不再提供 API_URL／API_KEY／供應商／任務模型）。
6. 管理員登入新版 BDC → 設定 →「管理預設供應商」，建立並測試預設列表，發布版本 1。若需避免首次列表空窗，可先在允許的測試 origin 使用新版管理介面發布，再切換正式前端。
7. 小範圍驗收後停用舊共享 Key（到供應商控制台撤銷），確認 CDN／瀏覽器快取不再提供舊 `ai-config.js`。

## API

所有請求需 `Authorization: Bearer <通行碼或 session token>`（`/auth-capabilities`、`/login`、`/pair`、`/reset-token` 除外）。所有 AI 相關回應帶 `Cache-Control: no-store`。

| 方法 | 路徑 | 說明 |
| --- | --- | --- |
| GET | `/auth-capabilities` | 未登入；`{ pairingLogin, loginLinks, passwordLogin, passwordMinLength, adminPasswordMinLength }` |
| POST | `/login` | 未登入；`{ username, password, deviceLabel? }` → session token；錯帳密回 401 `invalid_credentials` |
| POST | `/pair` | 未登入；`{ userId, code, deviceLabel? }` → 一次性 session token |
| POST | `/reset-token` | 未登入；`{ user_id, recovery_code, new_token }` |
| POST | `/change-password` | 已登入；`{ currentPassword, newPassword }`；成功後其他 session 立即失效 |
| GET | `/me` | `{ user_id, label, role, username, hasPassword }` |
| GET | `/version` | 快照版本 |
| GET | `/snapshot` | 快照或 `null`；帳戶已遷移到逐篇文章儲存後不再回傳舊 `articles` 群組 |
| POST | `/snapshot` | body `{ expected_version, payload }`；衝突回 409；舊格式文章群組回 409 `articles_legacy_write_blocked` |
| GET | `/articles?cursor=N&limit=` | 文章增量同步（伺服器游標）；`resetRequired` 表示需完整重同步 |
| GET | `/articles?full=1&includeDeleted=1` | 完整文章清單（僅 metadata，不含正文） |
| POST | `/articles/batch` | `{ ids: [...] }` → 最多 50 篇完整文件 |
| POST | `/articles` | 新增；`clientMutationId` 提供冪等重試 |
| GET | `/articles/:id` | 單篇完整文件 |
| PUT | `/articles/:id` | `{ expectedRevision, ... }` 原子版本檢查；衝突回 409 `article_revision_conflict` |
| DELETE | `/articles/:id` | `{ expectedRevision }` 軟刪除（tombstone，可復原） |
| POST | `/articles/:id/restore` | `{ expectedRevision }` 復原 |
| POST | `/articles/import` | 舊快照文章匯入（冪等，保留原 ID）；`{ final: true }` 開啟舊寫入閘門 |
| GET | `/articles/usage` | `{ count, totalBytes, limits, legacyWriteBlocked }` |
| GET | `/ai-credentials` | 個人憑證中繼資料（不含 Key） |
| GET | `/ai-credentials/:providerId` | 解密後的 Key、binding、version |
| PUT | `/ai-credentials/:providerId` | `{ expectedVersion, mutationId, binding, apiKey }`，CAS 寫入 |
| DELETE | `/ai-credentials/:providerId` | `{ expectedVersion, mutationId }`，清除密文保留刪除標記 |
| GET | `/ai-catalog` | 已登入；當前版本、啟用供應商與任務預設（不含 Key） |
| GET | `/ai-catalog/providers/:id/credential?catalogVersion=N` | 已登入且版本相符；回傳共享 Key 與 binding |
| GET | `/admin/ai-catalog` | 管理員；完整設定、是否已設定 Key、憑證版本 |
| GET | `/admin/ai-catalog/history` | 管理員；最近 10 版設定（不含歷史 Key） |
| POST | `/admin/ai-catalog/publish` | 管理員；`{ baseVersion, mutationId, config, keyOps }` 原子發布 |
| GET | `/admin/users` | 管理員；用戶列表，不含任何雜湊 |
| POST | `/admin/users` | 管理員；`{ userId, label?, email?, username?, password? }`，回傳一次性通行碼／恢復碼 |
| PUT | `/admin/users/:id` | 管理員；`{ label?, email?, username?, newPassword? }`；設定密碼會撤銷該帳戶所有 session |
| POST | `/admin/users/:id/reset-passcode` | 管理員；僅限非管理員帳戶，回傳一次性通行碼／恢復碼 |
| POST | `/admin/users/:id/pairing-code` | 管理員；僅限非管理員帳戶，回傳 10 分鐘一次性配對碼 |

### 錯誤碼

`unauthorized`(401)、`invalid_credentials`(401)、`account_disabled`(403)、`invalid_current_password`(403)、`password_not_set`(409)、`password_not_configured`(503)、`article_not_found`(404)、`article_revision_conflict`(409)、`article_already_deleted`(409)、`article_id_exists`(409)、`article_quota_exceeded`(409)、`article_count_exceeded`(409)、`articles_legacy_write_blocked`(409)、`article_too_large`(413)、`expected_revision_required`(400)、`passcode_upgrade_required`(403)、`origin_not_allowed`(403)、`admin_required`(403)、`admin_account_protected`(403)、`pairing_invalid`(403)、`credential_not_found`(404)、`credential_missing`(404)、`user_not_found`(404)、`version_conflict`(409)、`catalog_version_conflict`(409)、`mutation_conflict`(409)、`user_exists`(409)、`email_exists`(409)、`username_exists`(409)、`invalid_*`(400)、`weak_password`(400)、`payload_too_large`(413)、`rate_limited`(429)、`credential_unavailable`(503)。前端一律用 `t()` 翻譯穩定錯誤碼，不直接顯示英文。

### 金鑰加密

- AES-256-GCM，96-bit 隨機 nonce，128-bit 認證標籤。
- 個人 AAD：`scope=personal`、user ID、provider ID、binding、業務 version、key version。
- 共享 AAD：`scope=managed`、provider ID、binding、credentialRevision、key version。
- `AI_CREDENTIAL_KEY_VERSION` 決定新寫入使用哪把密鑰；解密使用信封自帶的 `keyVersion`。
- `AI_CATALOG_DIGEST_KEY` 只用在發布請求的 HMAC（含操作者、baseVersion、設定與 Key 操作），與主密鑰分開保管。

### 版本與重試

- 個人憑證：`WHERE user_id=? AND provider_id=? AND version=?` 條件更新；首次建立靠主鍵衝突回 409。
- 相同 `mutationId` 且內容相同 → 回原成功結果（不增加版本）；同 ID 不同內容 → 409。
- 發布：`baseVersion` 必須等於當前最大版本；`INSERT ... ON CONFLICT(version) DO NOTHING` 保證只有一位管理員成功。
- 發布歷史保留 10 版；使用者只能下載當前版本的共享 Key。

## 文章逐篇儲存（第一階段）

文章不再放在 `snapshots.payload.articles`，而是 `articles` 表每篇一列，擁有人以
`users.user_id` 關聯（`label` 可改名、`token_hash` 會輪替，兩者都不是身份）。

- `articles`：原文、分析 JSON、來源、`revision`、建立／修改時間、`deleted_at`、
  `legacy_article_id`（舊資料冪等映射）與 `size_bytes`。
- `article_changes`：每位使用者單調遞增的 `seq`，客戶端以游標增量同步；文章寫入與
  變更記錄在同一個 D1 batch（交易）內完成。
- `article_state`：`next_seq`、`legacy_write_blocked`、`migrated_at`。

產品限制在 `shared/article-protocol.mjs`：單篇 800 KB（原文＋分析 JSON 的 UTF-8
位元組）、每人 50 MB、400 篇提示／1,000 篇上限、原文 20k 字元提示／100k 上限。
超限回 413／409，不刪除既有資料。

舊客戶端升級流程：新版客戶端會先把本機與雲端快照中的文章以 `POST /articles/import`
逐篇匯入（保留原文章 ID，重試不會重複），完成後以 `{ final: true }` 開啟閘門；此後
`POST /snapshot` 若仍帶有非空文章群組會回 409 `articles_legacy_write_blocked`，
其他群組照常同步。`GET /snapshot` 也會隱藏舊文章群組，避免新裝置重複匯入。

## 備份與輪換

- 備份 D1 時另行保管 `AI_CREDENTIAL_KEY_V1`（及後續版本）。
- 輪換：設定 V2 → 把 `AI_CREDENTIAL_KEY_VERSION` 改 2 → 重新加密既有資料（以業務 version 與舊 key version 作條件）→ 核對 → 按備份政策處理 V1。
- 摘要密鑰可獨立輪換；`request_digest` 以 `v1:` 前綴記錄格式版本。
- 失去所有主密鑰且沒有備份時，雲端密文無法還原；使用者需重新提供 Key。

## 安全邊界

- 瀏覽器直連供應商，因此**已登入使用者可以複製共享 Key**。本方案不提供供應商端強制登入或逐人限額；緊急撤銷必須到供應商控制台更換／停用 Key。
- CORS 不是身分驗證；每個接口仍驗證 Bearer。Origin 清單用於縮小瀏覽器攻擊面。
- 管理員可建立用戶及重設非管理員通行碼；管理員通行碼洩漏的影響面因此比只管理 AI 預設更大。管理員帳戶的通行碼重設與角色調整刻意留給部署者，降低互相接管風險。
- 通行碼與恢復碼只在建立／重設回應出現一次，Worker 不寫入日誌、快照或審計紀錄。
- 配對碼只在產生時回傳一次，資料庫僅存雜湊；配對 session token 與通行碼同為 Bearer，但可獨立撤銷。
- 已配對 session 在 180 天後失效；目前不提供單一裝置撤銷介面，重設通行碼會撤銷全部裝置。
- 限流計數器存在單一 Worker isolate 記憶體中，屬盡力而為的濫用剎車，不是全域配額。
- 日誌只記錄錯誤碼，不記錄 Authorization、Key、請求 body 或明文回應。
