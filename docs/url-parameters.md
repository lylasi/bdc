# URL 參數快速入門

> 本文件說明如何透過網址參數或雜湊片段直接開啟特定模組，並在載入頁面時自動導入預設或遠端單詞本。範例皆假設專案以 `http://localhost:3000/index.html` 提供。

## 1. 模組捷徑（Module Shortcuts）

| 模組 | 主要捷徑 | 其他別名 |
| --- | --- | --- |
| 單詞本 | `v` | `vocab`, `vocabulary` |
| 學習 | `l` | `learn`, `learning` |
| 默寫 | `d` | `dict`, `dictation` |
| 測驗 | `q` | `quiz` |
| 文章朗讀 | `a` | `article` |
| 問答訓練 | `qa` | — |

### 範例：直接跳到默寫模組
- Hash 形式（推薦，可分享）：`http://localhost:3000/index.html#d`
- Query 參數：`http://localhost:3000/index.html?module=d`
- 精簡 query（會在載入後轉成 hash）：`http://localhost:3000/index.html?d`

載入後導覽列會自動切換到目標模組，網址也會同步成 `#捷徑` 以便分享或重新整理。

## 2. 預設單詞本自動導入

在網址上加上以下參數可以於初始化時提示使用者導入清單中的單詞本：

- `wordlist` 或 `wordlistId`：對應 `wordlists/manifest.json` 內的 `id`。
- `wordlistUrl` / `wordlistURL`：指向外部 JSON 單詞本的完整 URL。

### 範例：導入指定預設單詞本
- `http://localhost:3000/index.html#v?wordlist=5a-unit1`
  1. 網頁進入單詞本模組。
  2. 彈出對話框詢問是否導入「Unit 1 All around the city」。

### 範例：同時導入預設與遠端單詞本
- `http://localhost:3000/index.html#v?wordlist=5a-full&wordlistUrl=https://example.com/share/ielts-core.json`
  1. 頁面開啟單詞本模組。
  2. 依序詢問是否導入預設清單與遠端檔案。
  3. 導入完成後會顯示摘要訊息。

如需同時切換模組與導入單詞本，可以混用上述參數；模組捷徑會在初始化早期處理，導入流程緊接其後。

## 3. 常見問題

- **網址包含舊的 `?module=/x` 參數會怎麼辦？**
  - 會自動轉成 `#x` 並清理原 query，以保持乾淨的分享網址。
- **導入過的單詞本還會提示嗎？**
  - 若該單詞本名稱已存在，系統會詢問是否覆蓋原有資料。
- **可以只指定 `wordlistUrl` 嗎？**
- 可以，網址例如 `index.html#v?wordlistUrl=https://example.com/my-words.json`，會略過預設清單直接嘗試遠端導入。

> 更新日期：2025-09-18
