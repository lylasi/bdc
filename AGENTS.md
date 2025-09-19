# Repository Guidelines

更新日期：2025-09-18

## 專案結構與模組組織
- 入口檔案 `index.html` 負責渲染頁面框架，`styles.css` 管理全域主題，`main.js` 啟動各功能模組。
- 共用服務集中於 `modules/`（狀態、DOM、儲存、UI、音訊、API、平台）；若需要跨功能工具，請優先放置於此以避免重複。
- 功能流程依 `features/<name>/` 分層，每個模組需輸出 `init*` 初始化器與其輔助工具；當檔案超過約 300 行應拆分為鄰近的工具檔。
- 資料資產存放於 `wordlists/`、`articles/`、`qa-sets/` 及根目錄媒體檔；調整 QA 設計時請同步查閱 `docs/prd.md` 與 `PLAN.md`。
- URL 參數與模組捷徑範例請參見 `docs/url-parameters.md`。

## 建置、測試與開發指令
- `npx serve .` 啟動靜態開發伺服器，確保 ES 模組與 fetch 來源一致。
- `npx http-server -c-1 .` 提供快取無效化版本，適合偵錯儲存流程。
- 建議透過編輯器整合的 ESLint/Prettier（四空白縮排、單引號）保持格式一致，目前未內建專案設定檔。

## 程式風格與命名規範
- 採用 ES2022 語法，預設使用 `const` 與 `let`；函式與變數採 `camelCase`，類別或命名空間保留給 `PascalCase`。
- DOM 近端操作統一呼叫 `modules/dom.js` 內的選擇器，避免直接查詢。
- 內嵌註解僅補充「為何」或 TODO，必要時標記負責人縮寫。

## 測試方針
- 目前無自動化測試；請以 `test-floating-statusbar.html` 進行煙霧測試，覆蓋平台偵測、狀態持久化與浮動控制。
- 新增 QA 功能時同步擴充 `qa-sets/*.json`，並記錄使用的資料集方便審查者重播情境。

## Commit 與 Pull Request 準則
- 依循類似 Conventional Commit 格式（如 `feat:`、`fix:`、`chore:`），摘要可使用中文或英文，但保持精煉。
- 每個分支聚焦單一變更，PR 需連結相關文件或議題，並附上前後截圖或 GIF（若有 UI 更新）。
- 提交說明應列出設定步驟、手動驗證證據及資料異動，以加速審查。

## 安全與設定提示
- 發佈環境請複製 `ai-config.example.js` 為私有設定並忽略提交，避免將憑證推送至版本庫。
- 添增外部 API 呼叫時，務必在 `modules/api.js` 標示速率限制與錯誤處理策略，避免阻斷 UI 執行緒。
- 分享內容前再次檢查 `wordlists/` 與 `articles/`，移除敏感資料樣本。
