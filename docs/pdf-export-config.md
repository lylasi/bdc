# PDF 導出可調整配置（速查）

更新日期：2025-09-18

本文件列出 PDF 生成的主要可調整項與對應程式碼位置，方便後續微調版面與樣式。

## 主要配置（統一入口）
- 位置：features/qa/qa-pdf.js:8
- 區塊：`PDF_CONFIG`（檔內以「可調整區」大段註解標註）
- 項目：
  - `margin.{top,right,bottom,left}`：頁邊距（毫米，jsPDF 內部使用 mm）
  - `fontSize.{title,subtitle,normal,small}`：字級（pt）
  - `spacing.titleBottom`：標題下方距離
  - `spacing.instructionBottom`：說明段落下方距離
  - `spacing.questionSpacing`：題與題之間的基本間距
  - `spacing.answerLineGap`：底線行距（同時作為題幹→第一條線距離）
  - `spacing.answerTopGap`：保留給手寫題（與 answerLineGap 同步）；一般無需改
  - `spacing.answerBottomGap`：手寫題底線結束後的下方空白
  - `spacing.answerTextTopGap`：含答案版型「題目→答案」距離（越小越貼近題目）
  - `spacing.answerTextBottomGap`：含答案版型「答案→下一題」距離
  - `colors.{primary,success,warning,error,text}`：主題色與文字色

## 版面關鍵點位（對應邏輯）
- 題幹→第一條線或答案的距離：
  - features/qa/qa-pdf.js:246 使用 `answerTextTopGap` 或 `answerLineGap`
- 含答案段落左對齊與換行：
  - features/qa/qa-pdf.js:256 以 `addWrappedTextSmart` 處理自動換行
- 含答案段落之後的間距：
  - features/qa/qa-pdf.js:262 使用 `answerTextBottomGap`
- 兩條底線的間距：
  - features/qa/qa-pdf.js:268 使用 `answerLineGap`
- 分頁估算（避免切頁擠壓）：
  - features/qa/qa-pdf.js:309 起計算題塊高度，含上述各項間距

## 建議調整策略
- 書寫空間想再大一點：`spacing.answerLineGap` 往上調（例如 10 → 12）
- 答案更貼近題目：`spacing.answerTextTopGap` 往下調（例如 4 → 3）
- 題與題之間更鬆：
  - 含答案：調 `spacing.answerTextBottomGap`
  - 手寫題：調 `spacing.answerBottomGap`

## 風險提醒
- 過小的邊距或過大的行距可能導致分頁提前/溢出；若出現切頁問題，
  請同步調整 `questionsPerPage` 或上述間距，並留意檔內分頁估算段落。

## 相關工具
- 字型與子集：docs/pdf-fonts.md
- 字集腳本：scripts/gen-subset-chars.js、scripts/build-font-subset.sh

