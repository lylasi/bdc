# 存儲架構說明（BDC）

最後更新：2025-09-29

1) 目標與範疇
- 說明目前專案各模組的資料存放位置、結構與生命週期。
- 區分核心用戶資產、會話與偏好、派生快取，方便未來引入同步與帳號系統。
- 統一鍵名與欄位設計，為後續「快照式同步」或「實體級同步」預先鋪路。

2) 存儲分類（概覽）
- 核心用戶資產（建議支援同步）
  - 單詞本：`vocabularyBooks`；活動詞本 ID：`activeBookId`
  - QA 問答集：清單 `qa-sets` + 每個 `qa-set-<id>`
  - 已分析文章：`analyzedArticles`（可選同步）
- 會話與偏好（通常本地；部分可選同步）
  - 默寫會話：`pen_dictation_session`（24h）
  - 默寫設定：`pen_dictation_settings`（建議可選同步）
  - QA 訓練進度：`qa-training-progress`（24h）
- 派生快取（不同步、有 TTL）
  - AI 結果快取：IndexedDB kv + localStorage 後備（鍵名前綴 `bdc:cache:v1:`）

3) 核心用戶資產

3.1 單詞本（Vocabulary）
- 存放
  - localStorage: `vocabularyBooks`、`activeBookId`
    - 載入與保存：modules/storage.js:12、modules/storage.js:21、modules/storage.js:64、modules/storage.js:72
- 結構（示例）
```json
[
  {
    "id": "1716798123456",
    "name": "我的第一個單詞本",
    "words": [
      {
        "id": "1716798123456-0-0.123",
        "word": "example",
        "meaning": "例子",
        "phonetic": "ɪɡˈzæmpəl",
        "examples": []
      }
    ]
  }
]
```
- 行為
  - 初次載入無資料時，生成預設一本（modules/storage.js:25）
  - 載入附帶清洗音標（去除前後斜線：modules/storage.js:35）
  - UI 操作時保存（features/vocabulary/vocabulary.js 多處呼叫 saveVocabularyBooks()；例如 features/vocabulary/vocabulary.js:744）
- 後續同步建議
  - 書本與詞條加上 `updatedAt`、`deleted`；前期可用「整本 LWW」合併，後期再細化到詞級別

3.2 已分析文章（Article Analyses）
- 存放
  - localStorage: `analyzedArticles`
    - 讀/寫/更新：modules/storage.js:88、modules/storage.js:95、modules/storage.js:107
- 結構（示例）
```json
[
  {
    "article": "英文段落全文或標識",
    "result": {
      "chinese_translation": "...",
      "word_alignment": [],
      "detailed_analysis": []
    }
  }
]
```
- 說明
  - 這是「用戶資產」版的文章分析列表（與快取不同）；可跨端重用時納入同步；若僅臨時參考，亦可保留本地

3.3 QA 問答集（Questions & Answers）
- 存放
  - 清單：localStorage: `qa-sets`（features/qa/qa-storage.js:53、features/qa/qa-storage.js:129）
  - 單集：localStorage: `qa-set-<id>`（features/qa/qa-storage.js:146、features/qa/qa-storage.js:182）
- 預置清單
  - 檔案 `qa-sets/manifest.json` 與各預置 JSON（features/qa/qa-storage.js:14）
- 工具
  - 導入（JSON）/導出（下載）：features/qa/qa-storage.js:240、features/qa/qa-storage.js:260
  - 整體備份（合併所有 user QA 集）：features/qa/qa-storage.js:348
- 結構（單集示例）
```json
{
  "id": "qa-123",
  "name": "Unit 1 詞義測驗",
  "category": "英語",
  "difficulty": "easy",
  "questions": [
    { "qid": "q1", "question": "apple", "answer": "蘋果" }
  ],
  "createdAt": "2025-09-28T12:00:00Z",
  "updatedAt": "2025-09-28T12:00:00Z",
  "isPreset": false
}
```
- 後續同步建議
  - 單集維度加 `updatedAt/deleted`，LWW 合併；清單與實體分離，避免重複

4) 會話與偏好

4.1 默寫會話（24h 內恢復）
- 存放：localStorage: `pen_dictation_session`（modules/state.js:120、modules/state.js:220）
- 結構要點
  - active/startTime/currentIndex/isPaused/words/settings/timestamp
- 行為
  - 超過 24h 視為過期並清除

4.2 默寫設定（偏好）
- 存放：localStorage: `pen_dictation_settings`（modules/state.js:150）
- 結構（片段）
```json
{
  "selectedBookId": null,
  "repeatTimes": 2,
  "wordInterval": 3,
  "readChineseVoice": "none",
  "loopMode": false,
  "shuffleMode": false,
  "listenOnlyMode": true,
  "showWordInfo": false
}
```
- 建議：此類偏好可選擇隨賬戶同步（非必要）

4.3 QA 訓練進度（24h）
- 存放：localStorage: `qa-training-progress`（features/qa/qa-trainer.js:338、features/qa/qa-trainer.js:350）
- 行為
  - 保存當前 session，用於短期恢復；超時清除

5) 派生快取（AI 結果）

5.1 存放與鍵名
- IndexedDB 優先：資料庫 `bdc-cache`、object store `kv`；失敗則回退 localStorage
  - 開啟與操作：modules/cache.js:6、modules/cache.js:29、modules/cache.js:43
- 鍵名：`bdc:cache:v1:<namespace>:<sha256(payload)>`（modules/cache.js:4、modules/cache.js:87）
- 值格式：`{ v:1, expiresAt: <ms>, value: <任意> }`

5.2 命名空間與 TTL（來自 API 調用）
- 段落分析 paragraphAnalysis：quick 14 天、standard 21 天、detailed 30 天；fallback 7 天（modules/api.js:213、modules/api.js:224、modules/api.js:247）
- 詞於句中 wordAnalysis：30 天（modules/api.js:280、modules/api.js:286）
- 句子分析 sentenceAnalysis：21 天（成功）或 7 天（fallback）（modules/api.js:321、modules/api.js:338）
- 片語分析 selectionAnalysis：30 天（modules/api.js:366）
- 注意：快取是派生數據，不建議同步；過期後自動失效

6) 存儲鍵一覽（localStorage）
- 核心
  - `vocabularyBooks`
  - `activeBookId`
  - `analyzedArticles`
  - `qa-sets`
  - `qa-set-<id>`
- 會話/偏好
  - `pen_dictation_session`（24h）
  - `pen_dictation_settings`
  - `qa-training-progress`（24h）
- 快取/雜項
  - `bdc:cache:v1:*`（派生快取項）
  - QA 專用臨時快取（如存在）：`qa-cache-*`（features/qa/qa-storage.js:413，清理過期）

7) 大小與保留策略
- localStorage：5–10 MB/域；核心資產有機會超過，請控制內容體積（避免大型 binary）
- IndexedDB：容量較大，已用於 AI 快取；必要時也可將核心資產移至 IndexedDB（建議下一步）
- 清理
  - 快取由 TTL 控制（modules/cache.js）
  - QA 有清理過期緩存入口（features/qa/qa-storage.js:413）

8) 匯入/導出/備份（現狀）
- 詞本
  - 導出：下載 JSON（features/vocabulary/vocabulary.js:720–777）
  - 導入：透過 UI 輸入/預置清單/URL 參數（features/vocabulary/vocabulary.js:100+）
- QA
  - 單集導入/導出：features/qa/qa-storage.js:240、features/qa/qa-storage.js:260
  - 整體備份：features/qa/qa-storage.js:348（合併 manifest + 各集）
- 建議補強
  - 一鍵「全站備份/還原」：打包核心資產（排除派生快取、會話暫存），便於手動遷移或 QR 分片分享

9) 同步與賬戶化（演進建議）
- 加欄位：對核心實體補 `updatedAt`（epoch ms 或 ISO）、`deleted`、`schemaVersion`
- 合併策略
  - LWW：最新 updatedAt 覆蓋；刪除優先
  - 初期整本合併（book/qaSet），後期再細化到詞/題
- 後端形態
  - 快照式最小可行：`snapshots(token PK, version, payload BLOB(gzip), updated_at)`
  - 或實體表（`books`、`qa_sets`、`articles`），伺服端不做合併，僅存最後版本
- 安全
  - 匿名同步碼或正式登入；可選端到端加密（AES-GCM）讓伺服端只見密文

10) 相容性與風險
- localStorage 可用性：平台檢查已做（modules/platform.js:73），無法使用時回退 IndexedDB 或提示
- 容量超限：請避免將大型內容（如 PDF/音訊）放入核心資產；改走檔案導出
- Schema 變更：使用 `schemaVersion` + 遷移步驟（現有單詞本有簡單清洗邏輯）

11) 變更與維護
- 每次新增持久化項目：
  - 定義鍵名與命名空間
  - 設計資料結構（含 `id/updatedAt/deleted/schemaVersion`）
  - 明確保存時機與清理規則
  - 是否納入備份/同步（是/否）
- 請於 PR 說明：新增鍵、影響頁面與手動驗證步驟

附：關鍵檔案參照
- modules/storage.js:12、modules/storage.js:21、modules/storage.js:64、modules/storage.js:72、modules/storage.js:88、modules/storage.js:107
- modules/state.js:120、modules/state.js:150
- modules/cache.js:4、modules/cache.js:29、modules/cache.js:93、modules/cache.js:101
- modules/api.js:213、modules/api.js:224、modules/api.js:247、modules/api.js:280、modules/api.js:321、modules/api.js:338、modules/api.js:366
- features/vocabulary/vocabulary.js:720、features/vocabulary/vocabulary.js:744
- features/qa/qa-storage.js:53、features/qa/qa-storage.js:129、features/qa/qa-storage.js:146、features/qa/qa-storage.js:182、features/qa/qa-storage.js:240、features/qa/qa-storage.js:260、features/qa/qa-storage.js:348、features/qa/qa-storage.js:413
- features/qa/qa-trainer.js:338、features/qa/qa-trainer.js:350
- modules/platform.js:73
