# PDF 中文字型與導出指南

更新日期：2025-09-18

## 目標與現況
- 以 jsPDF 生成 PDF，確保繁體/簡體/英文完整顯示並儘量減小字型體積。
- 載入順序（index.html）：
  1) `modules/fonts/NotoSansTC-Subset.loader.js`（優先，~0.32MB base64）
  2) `modules/fonts/NotoSansTC-Regular.loader.js`（備援，~9MB base64）
  3) `modules/fonts/SourceHanSansSC-Normal-Min-normal.js`（簡體最小集，末位保底）
- 仍缺字時，`features/qa/qa-pdf.js` 會對含 CJK 的文字以 Canvas 轉圖嵌入，保證不爆字。

## 常用路徑
- 子集清單：`modules/fonts/subset-chars.txt`
- 子集字型：`modules/fonts/NotoSansTC-Subset.ttf`、`NotoSansTC-Subset.base64.txt`
- 載入器：`modules/fonts/NotoSansTC-Subset.loader.js`、`NotoSansTC-Regular.loader.js`
- 生成邏輯：`features/qa/qa-pdf.js`（`registerChineseFont` 與 `addTextWithCJKImageFallback`）

## 本地開發與驗證
- 啟動：`npx http-server -c-1 .`（或 `npx serve .`），然後在 QA 介面點「導出PDF」。
- 檢查：瀏覽器 Console 應出現 `Loaded NotoSansTC-Subset` 與 `已註冊中文字型`；PDF 檔案中 Fonts 應含 `NotoSansTC-Subset`（Embedded）。

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
