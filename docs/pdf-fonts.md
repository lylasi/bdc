# PDF 中文字型與導出指南

更新日期：2026-10-14

## 目標與現況
- 以 jsPDF 生成 PDF，確保繁體/簡體/英文完整顯示並儘量減小字型體積。
- **整條 PDF 工具鏈都改為按需載入**：首頁不含 jsPDF，也不含任何字型資料（過去 index.html 直接載入三份字型，開頁要多下載約 12MB）。只有真的要導出時才由 `features/qa/qa-pdf.js` 抓取。
- 字型抓取順序（`CJK_FONT_SOURCES`）：
  1) `modules/fonts/NotoSansTC-Subset.base64.txt`（優先，~0.32MB）
  2) `modules/fonts/NotoSansTC-Regular.base64.txt`（備援，~9MB）
  3) `modules/fonts/SourceHanSansSC-Normal-Min-normal.js`（簡體最小集，末位保底）
- 仍缺字時，`features/qa/qa-pdf.js` 會對含 CJK 的文字以 Canvas 轉圖嵌入，保證不爆字。
- 使用者把游標移到導出按鈕上時會先暖機（`prefetchPdfEngine()`），第一次導出不必等；未暖機直接點也能正常導出（會顯示「首次導出需準備 PDF 元件」提示）。

## jsPDF 來源（v4.2.1）
- 內嵌優先：`modules/vendor/jspdf.umd.min.js`（MIT，授權全文見 `modules/vendor/jspdf.LICENSE.txt`）。
- 載入順序由 `features/qa/qa-pdf.js` 的 `JSPDF_SOURCES` 決定：本地檔 → unpkg → registry.npmmirror，前者失敗才試下一個；全部失敗才提示「無法載入 jsPDF 庫」。
- 為什麼不直接抓 CDN：專案主打離線可用，且 `jspdf@latest` 版本會漂移；unpkg／jsdelivr 在部分網路（含大陸）不可達時，導出會直接失敗（2026-10 排障案例）。
- 更新版本：`npm pack jspdf@<版本>`，取 `package/dist/jspdf.umd.min.js` 覆蓋本地檔，並同步改 `JSPDF_SOURCES` 內的版本號。

## 常用路徑
- 子集清單：`modules/fonts/subset-chars.txt`
- 子集字型：`modules/fonts/NotoSansTC-Subset.ttf`、`NotoSansTC-Subset.base64.txt`
- 載入器：`modules/fonts/NotoSansTC-Subset.loader.js`、`NotoSansTC-Regular.loader.js`（舊的「開頁即載入」寫法，index.html 已不再引用；`registerChineseFont` 仍會沿用它們設定的 `window.fontBase64`，要用可自行加回 `<script>`）
- 生成邏輯：`features/qa/qa-pdf.js`（`ensureChineseFontData`、`registerChineseFont` 與 `addTextWithCJKImageFallback`）

## 本地開發與驗證
- 啟動：`npx http-server -c-1 .`（或 `python3 scripts/serve.py`），然後在 QA 介面點「導出PDF」。
- 檢查：瀏覽器 Console 應出現 `中文字型就緒` 與 `已註冊中文字型`；PDF 檔案中 Fonts 應含 `NotoSansTC-Subset`（Embedded）。
- 開頁時 Network 不應出現 `modules/fonts/**` 或任何 `jspdf` 請求（懶載入生效）。

## 重新產生子集（推薦流程）
1) 生成字元清單（會掃描專案並補常用詞；可附加自備文案檔）：
   - `node scripts/gen-subset-chars.js [extra.txt]`
2) 建立/更新子集字型與 base64（需要 Python/fonttools，腳本會自動安裝 venv）：
   - `scripts/build-font-subset.sh [字型來源TTF] [字元清單]`
   - 預設來源：`Noto_Sans_TC/static/NotoSansTC-Regular.ttf`
3) 重新整理頁面，重新導出 PDF 進行驗證。

## 疑難排解
- 仍出現空框：優先清快取硬重載；或暫時移除 `NotoSansTC-Regular.loader.js` 以確認確實走子集；如仍缺字，將缺字加入 `subset-chars.txt` 後重建。
- PDF 文字不可選：代表該行走了影像化保底；確保字型已註冊，或增補缺字進子集。
- 需要完整覆蓋：保留 `NotoSansTC-Regular.loader.js` 作為備援，體積較大但一勞永逸。

## 授權
- Noto Sans TC 採用 SIL Open Font License（見 `Noto_Sans_TC/OFL.txt`）。分發子集亦需遵守 OFL 條款。
