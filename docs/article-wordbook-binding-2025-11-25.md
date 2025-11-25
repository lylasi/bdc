# 文章與生詞本綁定設計說明（2025-11-25）

本文檔說明如何在現有 `bdc` 專案中，實作「一篇文章對應一個生詞本」的綁定關係，並支援從文章與生詞本之間相互跳轉與追溯來源。

本文面向開發者與維運人員，作為實作與後續調整的依據。

---

## 1. 目標與範圍

### 1.1 功能目標

- 每一篇文章都有自己的專屬生詞本（1:1 綁定）。  
- 從文章詳解頁加入生詞時，自動加入到該文章專屬生詞本，無需使用者手動選擇。  
- 從生詞本可以回溯來源文章（或至少看到原始 URL），支援一鍵跳轉。  
- 支援多種文章來源型態：URL、貼上文字、檔案匯入、OCR 等。  
- 舊資料不強制遷移，保持相容，缺少綁定資訊時優雅降級。

### 1.2 非目標（本階段不處理）

- 不實作跨多篇文章共用的一般生詞本管理（但保留未來擴充空間）。  
- 不實作進階的「回到文章中的精確位置捲動」（僅預留欄位）。  
- 不將全文內容全面快取到 IndexedDB / `cache.js`，僅處理 metadata 與綁定關係。

---

## 2. 核心設計概念

### 2.1 一篇文章一個生詞本

- 對於來源為文章的生詞，本設計採用「每篇文章一個生詞本」的模式：  
  - 每個生詞本只對應一篇文章。  
  - 文章的 `id` 與生詞本的 `id` 建議保持一致（簡化查找與綁定）。  
- 特例：未來若需要「自建生詞本」或「舊資料生詞本」，則以 `sourceType` 區隔：
  - `sourceType = 'article'`：文章專屬生詞本。  
  - `sourceType = 'custom'`：純生詞本，無文章。  
  - `sourceType = 'legacy'`：舊資料彙總生詞本。

### 2.2 Metadata 優先，而非全文存儲

- 本設計優先處理「文章 metadata」與「生詞本」的綁定，而非全文儲存：  
  - `ArticleMeta`：記錄文章 ID、標題、來源類型、來源 URL 等。  
  - `Wordbook`：記錄生詞本 ID、來源類型、關聯文章 ID、標題等。  
  - 生詞條目 (`WordEntry`) 則透過 `wordbookId` 掛在對應生詞本下。  
- 若來源為 URL 或新聞連結，會將 URL 寫入 `ArticleMeta.sourceUrl`，以便回到原文。

---

## 3. 資料模型與儲存結構

### 3.1 ArticleMeta（文章 metadata）

> 儲存位置：`modules/storage.js` → localStorage key 建議沿用 `analyzedArticles` 或新增獨立 key（視後續實作決定）。  
> 由於目前已有 `state.analyzedArticles`，需注意兩者關係：  
> - `analyzedArticles` 偏向「文章內容與 AI 分析結果」  
> - 新增 `ArticleMeta` 則偏向「文章識別與來源資訊」

建議型別：

```js
/**
 * @typedef {Object} ArticleMeta
 * @property {string} id           // 全域唯一 articleId
 * @property {string} title        // 顯示用標題
 * @property {'url' | 'paste' | 'file' | 'ocr'} sourceType
 * @property {string} [sourceUrl]  // 若 sourceType === 'url'，此欄位必填
 * @property {number} createdAt    // timestamp (Date.now())
 */
```

ID 生成策略（建議）：

- URL 來源：  
  `id = 'url:' + encodeURIComponent(url)`  
  - 相同 URL 自動共用同一個 articleId，方便回溯同一來源。  
- 其他來源（貼上、檔案、OCR）：  
  `id = 'local:' + <隨機字串>`（例如 `Date.now()` + `Math.random()` 或 `nanoid`）。

### 3.2 Wordbook（生詞本）

> 儲存位置：`modules/state.js` 既有的 `vocabularyBooks` 結構目前為：  
> `{ id: string, name: string, words: [...] }[]`  
> 本次調整會在現有結構上加上最小必要欄位，而不重寫整套系統。

新增欄位建議：

```js
// 現有：book 結構基礎上擴充
// { id, name, words, ... } + 新欄位
{
    id: string,
    name: string,
    words: [...],
    // 新增：
    sourceType?: 'article' | 'custom' | 'legacy',
    articleId?: string,  // 若 sourceType === 'article' 時必填
    createdAt?: string,  // ISO 字串，方便排序與同步
}
```

- 若為文章專屬生詞本：
  - `sourceType = 'article'`  
  - `articleId = <ArticleMeta.id>`  
  - `id` 建議 = `articleId`（保持 1:1 一致，簡化 lookup）  
  - `name` 預設為文章標題。
- 舊資料的生詞本：
  - 若缺少 `sourceType` 或 `articleId`，在載入時一律視為 `sourceType = 'legacy'`。  
  - 不強制遷移既有資料，確保使用者過往生詞不會消失。

### 3.3 WordEntry（生詞條目）

> 儲存位置：沿用既有 `book.words` 內部結構。  
> 為了保持「一篇文章一個生詞本」的簡單性，**不再在單詞條目上存 `articleId`**，只存於生詞本。

在現有 `word` 結構上可選擇性擴充：

```js
{
    id: string,
    word: string,
    // ... 其他欄位（音標、釋義、例句等）
    // 可選：紀錄在文章中的大致位置，預留未來自動捲動。
    sourcePosition?: {
        paragraphIndex?: number,
        charOffset?: number
    }
}
```

---

## 4. 全域狀態與介面設計（state.js）

### 4.1 新增狀態欄位

> 檔案：`modules/state.js`

```js
// 文章／生詞本當前上下文
export let currentArticleId = null;
export let currentWordbookId = null;
```

### 4.2 新增狀態操作函式

```js
export function setCurrentArticleId(articleId) {
    currentArticleId = articleId;
}

export function getCurrentArticleId() {
    return currentArticleId;
}

export function setCurrentWordbookId(wordbookId) {
    currentWordbookId = wordbookId;
}

export function getCurrentWordbookId() {
    return currentWordbookId;
}
```

### 4.3 高階 helper：文章上下文初始化

> 由 `features/article/` 在載入文章時呼叫。

```js
/**
 * articleMetaInput:
 * {
 *   id?: string,
 *   title: string,
 *   sourceType: 'url' | 'paste' | 'file' | 'ocr',
 *   sourceUrl?: string
 * }
 *
 * 功能：
 * - 生成或確認 articleId
 * - 透過 storage 建立 / 取得對應 ArticleMeta
 * - 透過 storage 建立 / 取得對應的文章專屬生詞本
 * - 更新 currentArticleId / currentWordbookId
 * - 回傳 { articleId, wordbookId }
 */
export async function initArticleContext(articleMetaInput) {
    // 具體實作在後續開發中完成
}
```

實際實作時會呼叫 `modules/storage.js` 內的 `getOrCreateArticleWithWordbook` 或類似介面。

---

## 5. 本地儲存與 helper 設計（storage.js）

### 5.1 ArticleMeta 存取介面

> 檔案：`modules/storage.js`

新增型別註解與存取函式：

```js
// 型別註解（僅註解用途，不影響執行）
// 參考第 3 章 ArticleMeta 定義

// 依 ID 取得單一文章 metadata
export function getArticleMetaById(articleId) {}

// 取得全部文章 metadata 列表（供文章列表 / 生詞本列表使用）
export function getAllArticleMetas() {}

// 新增或更新文章 metadata
export function saveArticleMeta(articleMeta) {}

// 依 URL 尋找文章（避免同一 URL 建立多個 articleId）
export function findArticleMetaByUrl(url) {}
```

實作細節：

- 建議使用單一 localStorage key，例如：`'articleMetas'`，儲存為 `{ [articleId]: ArticleMeta }`。  
- 若考量與 `analyzedArticles` 的歷史資料整合，可以：
  - 短期內分開存（metadata vs. 分析結果）。  
  - 長期計畫再做 schema 收斂。

### 5.2 Wordbook 存取介面

本專案既有的生詞本讀寫主要透過：

- `state.vocabularyBooks`  
- `saveVocabularyBooks()` / `loadVocabularyBooks()`

本次調整的方向是 **在既有結構上加欄位，不重建新命名空間**，並補充一些 helper：

```js
// 依 ID 取得生詞本
export function getWordbookById(wordbookId) {
    return state.vocabularyBooks.find(b => b.id === wordbookId) || null;
}

// 取得所有生詞本
export function getAllWordbooks() {
    return state.vocabularyBooks || [];
}

/**
 * 新增或更新生詞本：
 * - 若同 id 已存在則覆蓋
 * - 同步呼叫 saveVocabularyBooks()
 */
export function saveWordbook(wordbook) {}

/**
 * 確保文章專屬生詞本存在：
 * - 若已存在 articleId 對應生詞本（id === articleId）則直接回傳
 * - 若不存在：
 *   - 建立新生詞本：
 *     - id = articleMeta.id
 *     - name = articleMeta.title
 *     - sourceType = 'article'
 *     - articleId = articleMeta.id
 *     - createdAt = new Date().toISOString()
 *   - push 進 state.vocabularyBooks，並 saveVocabularyBooks()
 * 回傳 { articleMeta, wordbook }
 */
export function getOrCreateArticleWordbook(articleMeta) {}
```

### 5.3 生詞條目與生詞本的關係

現有結構為 `book.words` 陣列，本次只在介面上明確標定 `wordbookId`，方便未來重構時保持一致：

```js
/**
 * @typedef {Object} WordEntry
 * @property {string} id
 * @property {string} word
 * // ... 其他欄位
 * @property {string} [wordbookId]  // 目前隱含在所屬 book 中，未來可顯性化
 */

// 取得某生詞本底下的所有單字
export function getWordsByWordbookId(wordbookId) {}

// 在指定生詞本下新增單字
export function addWordToWordbook(wordbookId, wordPayload) {}

// 更新單字
export function updateWordInWordbook(wordbookId, wordEntry) {}

// 從生詞本移除單字
export function removeWordFromWordbook(wordbookId, wordEntryId) {}
```

---

## 6. 功能模組整合方案

### 6.1 文章模組（features/article/）

職責調整：

- 文章載入時（不論來源）：  
  1. 組出 `articleMetaInput`（標題、來源類型、URL 等）。  
  2. 呼叫 `initArticleContext(articleMetaInput)`。  
  3. 獲得 `{ articleId, wordbookId }`，並在需要時使用。  
- 從文章詳解介面觸發「加入生詞本」時：  
  - 直接使用 `state.getCurrentWordbookId()` 作為目標生詞本 ID。  
  - 呼叫 `storage.addWordToWordbook(currentWordbookId, payload)`。

若來源為 URL 或新聞：

- 將 URL 存入 `ArticleMeta.sourceUrl`。  
- 文章詳解介面中顯示「在新分頁開啟原文」按鈕，透過 `window.open(sourceUrl, '_blank')`。

### 6.2 生詞本模組（features/vocabulary/）

職責調整：

- 生詞本列表視圖：  
  - 顯示每一個生詞本（可視為「每篇文章的生詞本」）。  
  - 顯示來源類型與基本統計：單字數量、建立時間等。  
- 單一生詞本詳情視圖：  
  - 若 `book.sourceType === 'article' && book.articleId`：  
    - 顯示「回到來源文章」按鈕。  
    - 點擊時透過全域導航（`navigateToArticle(book.articleId)`）切換畫面。  
  - 若為 `custom` / `legacy` 則不顯示該按鈕。

### 6.3 入口與路由（main.js）

需新增／調整的邏輯：

- Hash 路由新增一種格式：`#article/<articleId>`。  
- 新增共用導航 helper：

```js
/**
 * 導航到指定文章：
 * - 設定 location.hash
 * - 更新 state.currentArticleId / state.currentWordbookId
 * - 呼叫文章模組顯示對應內容
 */
export function navigateToArticle(articleId) {}
```

此 helper 會被：

- 生詞本詳情頁「回到來源文章」按鈕呼叫。  
- 之後若有其他模組需要引用某篇文章時，也可共用。

---

## 7. 遷移與相容性策略

### 7.1 舊生詞本資料

- 既有 `vocabularyBooks` 讀取時：  
  - 若 `book.sourceType` 缺失，視為 `sourceType = 'legacy'`。  
  - 不強制指定 `articleId`。  
  - UI 中不顯示「回到來源文章」按鈕。  
- 保證舊資料在新版本仍可正常顯示與使用。

### 7.2 舊文章分析資料

- 目前 `analyzedArticles` 已包含 `{ article, result }` 之類結構。  
- 新增的 `ArticleMeta` 與之互不影響，短期內分開存放。  
- 若未來需要，可考慮：
  - 以 `article` 內容 hash 作為 `ArticleMeta` 的輔助索引。  
  - 在保存分析結果時，同步更新 `ArticleMeta`。

---

## 8. 實作步驟建議

### 第一步：資料層與狀態層

1. 在 `modules/state.js` 中新增：  
   - `currentArticleId` / `currentWordbookId` 與對應 getter / setter。  
2. 在 `modules/storage.js` 中新增：  
   - `ArticleMeta` 相關的 localStorage key 與存取方法。  
   - `getWordbookById` / `getAllWordbooks` / `saveWordbook`。  
   - `getOrCreateArticleWordbook(articleMeta)`。  
3. 在現有 `loadVocabularyBooks()` 中，對舊資料補齊：  
   - 若缺少 `sourceType` 則視為 `legacy`。  
   - 若新建文章生詞本時，直接用擴充後的結構。

### 第二步：文章模組串接

1. 在 `features/article/` 中：  
   - 文章載入完成後，組 `articleMetaInput`。  
   - 呼叫 `initArticleContext(articleMetaInput)`，取得並記錄 `articleId`。  
   - 將「加入生詞本」行為改為使用 `getCurrentWordbookId()`。  
2. 若來源為 URL：  
   - 在畫面上顯示原始 URL 的跳轉按鈕。

### 第三步：生詞本模組與導覽

1. 在 `features/vocabulary/` 中：  
   - 生詞本列表顯示新增欄位（來源類型、文章標題）。  
   - 生詞本詳情頁加上「回到來源文章」按鈕（僅對 `sourceType = 'article'` 顯示）。  
2. 在 `main.js` 中：  
   - 實作並導出 `navigateToArticle(articleId)`。  
   - 在 hash 路由邏輯中解析 `#article/<articleId>`。  
   - 導航時呼叫文章模組顯示對應內容。

### 第四步：驗證與微調

1. 手動測試流程：
   - 從 URL 匯入／貼上文章 → 文章詳解頁 → 加入若干生詞。  
   - 切換到生詞本模組 → 檢查是否只出現對應文章的生詞。  
   - 在生詞本中點擊「回到來源文章」→ 檢查是否能正確跳轉。  
   - 刷新頁面後，確認狀態與綁定仍存在。  
2. 檢查 localStorage 中：  
   - `vocabularyBooks` 是否新增正確欄位。  
   - 新增的 `ArticleMeta` key 是否內容合理。  
3. 視需要在日後補充自動化測試或簡易檢查腳本。

---

## 9. 備註與後續擴充方向

- 若未來要支援「同一單字出現在多篇文章」，可以在統計層面跨 `wordbookId` 聚合。  
- 若要做「回到文章中的精確位置」：
  - 在加詞時記錄 `sourcePosition`（段落索引 / 字元偏移）。  
  - 文章模組在顯示文章時，依據該資訊進行捲動或高亮。  
- 若要與 Supabase 同步：
  - 需擴充 `sync-core.js` / `sync-signals.js` / `sync-supabase.js` 的 schema，將 `ArticleMeta` 與擴充後的 `vocabularyBooks` 納入同步。

