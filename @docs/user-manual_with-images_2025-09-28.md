# PEN子背單詞 圖文操作手冊（2025-09-28）

本手冊配合截圖說明各功能的實際位置與操作動線。若首次閱讀，建議先看《使用者操作手冊》，再回到本篇對照畫面熟悉。

—

## 截圖檔擺放方式
- 圖片目錄：`@docs/img/`
- 檔名建議：
  - `nav.png`（主導航）
  - `vocab-list.png`（單詞本列表）
  - `vocab-new-book.png`（新增單詞本彈窗）
  - `vocab-import.png`（導入單詞本彈窗）
  - `vocab-merge.png`（合併單詞本彈窗）
  - `learning-select.png`（選書選詞）
  - `learning-examples.png`（AI 例句）
  - `dictation-controls.png`（默寫控制列與設置）
  - `quiz-question.png`（測驗出題與選項）
  - `article-analyze.png`（文章分析結果）
  - `article-tooltip.png`（點詞詳解浮窗）
  - `article-reading.png`（逐句/逐段朗讀控制）
  - `qa-list.png`（問答集管理）
  - `qa-creator.png`（問答創建器）
  - `qa-training.png`（問答作答介面）
  - `qa-report-pdf.png`（校對/匯出 PDF）

—

## 1. 主導航與版面
![主導航](img/nav.png)
- A：6 大功能入口（依序：單詞本/學習/默寫/測驗/文章/問答）。
- B：當前功能的主工作區域。
- C：全域提示（例如操作成功/錯誤訊息）會出現在右上角。

—

## 2. 單詞本
![單詞本列表](img/vocab-list.png)
- A：單詞本清單；點選後可切換當前單詞本。
- B：功能按鈕（新增/導入/編輯/刪除/導出/合併/補完缺失）。
- C：單詞列表；右側播放鍵朗讀單詞（及中文）。

![新增單詞本](img/vocab-new-book.png)
- A：輸入單詞本名稱。
- B：批量貼上內容（每行一條，支援 `word#中文@/音標/` 等）。
- C：儲存。

![導入單詞本](img/vocab-import.png)
- A：預設清單（可多選）。
- B：由 URL 導入。
- C：由檔案導入。
- D：開始導入與進度顯示。

![合併單詞本](img/vocab-merge.png)
- A：選擇多個來源單詞本；
- B：輸入新名稱；
- C：預覽總詞數（自動去重）；
- D：確認合併。

—

## 3. 學習
![選書與選詞](img/learning-select.png)
- A：選擇欲學習的單詞本。
- B：選擇單詞。
- C：顯示字形/音標/中文。

![AI 例句](img/learning-examples.png)
- A：產生 AI 例句按鈕。
- B：產生後顯示中英對照，滑過高亮對應詞。
- C：「檢查例句」可評估您自寫的英文句子。

—

## 4. 默寫
![默寫控制與設置](img/dictation-controls.png)
- A：選擇單詞本。
- B：重覆次數、單詞間隔、中文語音（普通話/粵語/不讀）。
- C：開始/暫停/重播/上一/下一/檢查。
- D：進度條與百分比。

—

## 5. 測驗
![測驗出題](img/quiz-question.png)
- A：選擇單詞本、題量、題型（意思/單詞/音標/混合）。
- B：題目文本與選項；點選後即時判分。
- C：「下一題」與上方進度/得分。

—

## 6. 文章詳解與朗讀
![文章分析結果](img/article-analyze.png)
- A：貼上英文文章 → 點「分析文章」。
- B：每段顯示英文與中文；失敗段落可重試。

![點詞詳解浮窗](img/article-tooltip.png)
- A：在英文段落中點詞，浮窗顯示音標/詞性/中文/語法作用。
- B：按鈕：發音 / 加入生詞本 / 片語解析 / 自訂片語。

![逐句/逐段朗讀](img/article-reading.png)
- A：選擇朗讀模式（全文/逐句/逐段）。
- B：速度與重覆次數設定；上一/下一句控制。
- C：「下載音檔」保存 TTS 音檔。

—

## 7. 問答訓練
![清單與管理](img/qa-list.png)
- A：問答集清單（預置 + 自建）。
- B：導入/導出/刪除/備份按鈕。

![創建器](img/qa-creator.png)
- A：以 `Q1:` / `A1:` 批量貼上；右側即時預覽。
- B：輸入名稱與描述 → 儲存。

![作答介面](img/qa-training.png)
- A：問題與作答區。
- B：上一/下一題、暫停/繼續。
- C：完成後可「AI 校對」與「匯出 PDF」。

![校對與匯出](img/qa-report-pdf.png)
- A：AI 校對清單（可單題重檢）。
- B：匯出完整問答 PDF / 手寫練習版。

—

提示：若截圖尚未就位，請先照上述檔名存入 `@docs/img/`，Markdown 圖片即會顯示。
