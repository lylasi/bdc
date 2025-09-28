# PEN子背單詞 模組說明（2025-09-28）

本文件概述目前專案的功能模組與使用方式，涵蓋入口、共用模組（modules/）、功能模組（features/）以及資料與設定。內容以繁體中文（香港）撰寫，供開發與維護參考。

- 執行開發伺服器（專案根目錄）：
  - `npx serve .`
  - 或 `npx http-server -c-1 .`（停用快取，便於 storage/debug）

## 專案結構概覽
- 核心頁面：`index.html`、`styles.css`、`main.js`
- 共用服務：`modules/`（state、dom、storage、ui、audio、api、platform、cache、validate、vocab、fonts）
- 功能模組：`features/<name>/`（vocabulary、learning、dictation、quiz、article、qa）
- 內容資料：`articles/`、`wordlists/`、`qa-sets/`
- 參考文件：`docs/prd.md`、`PLAN.md`
- 測試頁面：`test-floating-statusbar.html`

---

## 入口與導覽

- `index.html`：主畫面與導航、各 section 容器、模態框等。
- `main.js`：應用啟動器與導覽路由。
  - 責任：載入資料、初始化通用 UI、註冊音訊解鎖、初始化所有功能模組、設定導航、URL 路由。
  - 模組路由（網址中的 `#` 或 `?module=` 等別名）：
    - `v|vocab|vocabulary` → 單詞本
    - `l|learn|learning` → 學習
    - `d|dict|dictation` → 默寫
    - `q|quiz` → 測驗
    - `a|article` → 文章詳解
    - `qa` → 問答訓練
  - 相關方法：
    - `setupNavigation()` 綁定主導航按鈕並切換對應 section/模組。
    - `handleModuleRouting()` 解析 `hash` 或 `?module=/tab/page` 參數並定位模組。

---

## 共用模組（modules/）

以下模組供各 features 復用，避免重複與耦合。

### modules/dom.js（DOM 選擇器）
- 將所有 `document.querySelector*` 集中為可重用常量，例如：
  - `navBtns`、`sections`
  - 單詞本：`vocabBookList`、`addVocabBookBtn`、`wordList`...
  - 學習：`learningBookSelector`、`wordSelect`、`detailWord`...
  - 默寫：`startDictationBtn`、`dictationInput`、`dictationProgressBar`...
  - 測驗：`quizBookSelector`、`quizQuestion`、`quizOptions`...
  - 文章：`articleInput`、`analyzeArticleBtn`、`articleAnalysisContainer`...
  - 問答：`qaModule`、`qaTrainingArea`、`qaCreatorArea`...
  - 通用 Modal：`appModal`、`modalTitle`、`modalBody`...
- 使用規則：在 feature/模組中以 `import * as dom from '../modules/dom.js'` 引用，不直接寫 `document.querySelector`。

### modules/state.js（全域狀態）
- 儲存與更新應用狀態：單詞本、默寫/測驗/文章朗讀進度、音訊狀態等。
- 核心欄位（節選）：
  - 詞彙：`vocabularyBooks`、`activeBookId`
  - 文章：`analyzedArticles`
  - 默寫：`dictationWords`、`currentDictationIndex`、`dictationSettings{ repeatTimes, wordInterval, readChineseVoice, ... }`、會話保存
  - 測驗：`quizQuestions`、`currentQuestionIndex`、`quizInProgress`
  - 朗讀：`readingChunks`、`currentChunkIndex`、`currentSpeed`、`sentenceRepeatCount`
  - 音訊：`audioContext`、`audioSource`、`globalAudioElement`
- 使用規則：
  - 讀值：直接讀取導出變數，例如 `state.activeBookId`。
  - 改值：務必使用對應 setter，例如 `state.setActiveBookId(id)`、`state.setDictationSettings({...})`，避免直接改寫導出變數。

### modules/storage.js（LocalStorage 持久化）
- 詞彙：`saveVocabularyBooks()`、`loadVocabularyBooks()`（包含既有資料的音標格式清理）
- 應用狀態：`saveAppState()`、`loadAppState()`（維持上次選書）
- 文章分析歷史：`saveAnalyzedArticles()`、`loadAnalyzedArticles()`、`saveAnalysisResult(article, result)`
- 使用時機：應用啟動時先 `loadVocabularyBooks()` 再 `loadAnalyzedArticles()`，更動後呼叫對應 `save*()`。

### modules/ui.js（通用 UI）
- Modal：`openModal()`、`closeModal()`、`initModal()`（關閉按鈕與點擊背景關閉）
- 數字步進器：`setupNumberSteppers()`（綁定 `.number-stepper` 或垂直版本的加減/滑桿聯動）
- Tooltip：`repositionTooltip(target)`、`initTooltip()`（全局點擊隱藏）
- 體驗提示：`displayMessage(message, type='info', duration=3000)`（成功/錯誤/警告/資訊 toast）
- 單詞本單選器：`createBookSelector(container, defaultBookId)`（渲染 radio 群組）
- 選項彈窗：`showOptionsModal({ title, description, options, onConfirm, onCancel })`

### modules/audio.js（Web Audio & TTS）
- iOS 自動播放解鎖：`unlockAudioContext()`（於首次點擊/觸控時註冊，`main.js` 已處理）
- 播放控制：`stopCurrentAudio()`（停止 Web Audio 與全域 HTMLAudioElement）
- TTS：
  - `speakText(text, langOrVoice='english', speed=0, onStart, onEnd)`
  - `downloadTextAsAudio(text, langOrVoice, speed, filename, { pitch, style, download })`
  - `buildTTSUrl(text, langOrVoice, speed)`（進階使用）
- 依賴設定：`ai-config.js` 中的 `TTS_CONFIG`（baseUrl、apiKey、voices）。

### modules/api.js（AI API 封裝）
- 共用請求器：內建逾時、Abort 合成、429/5xx 退避重試。
- 主要方法：
  - `getWordAnalysis(word)` → { phonetic, pos, meaning }
  - `generateExamplesForWord(word, { count, level, timeoutMs })` → 例句陣列（含中英對齊）
  - `checkUserSentence(word, sentence)` → 文句校對回饋
  - `analyzeParagraph(paragraph, { level, timeoutMs, signal })` → 文章段落翻譯與重點詞詳解（含快取）
  - `analyzeWordInSentence(word, sentence, opts)`、`analyzeSentence(sentence, context, opts)`、`analyzeSelection(selection, sentence, context, opts)`
- 響應驗證：結合 `modules/validate.js` 保證結構；失敗時提供降級輸出（至少中文翻譯）。
- 快取：結合 `modules/cache.js` 以 TTL 作為本地快取（IndexedDB→localStorage）。
- 設定：讀取 `ai-config.js` 的 `API_URL`、`API_KEY`、`AI_MODELS`。

### modules/platform.js（平台偵測與相容）
- 偵測：`detect`（isIOS/isAndroid/isMobile/isWeixin 等）、`features`（webAudio/localStorage/visualViewport 等）
- 視窗：`getViewportHeight()`、`getSafeAreaHeight()`（iOS 地址欄/安全區域）
- 可見性：`getVisibilityAPI()`、`onVisibilityChange(cb)`
- 音訊相容：`checkAutoplayPolicy()`、`initWeixinAudio(cb)`
- 交互最佳化：`getOptimalTouchTarget()`、`disableBounceScrolling(el)`
- 除錯：`logPlatformInfo()`（開發模式）

### modules/cache.js（本地快取）
- 以 `sha256Hex` 對 payload 建 key；優先 IndexedDB，失敗則回退 localStorage。
- `getCached(ns, payload)` / `setCached(ns, payload, value, ttlMs)`；
- 便捷別名：paragraph/word/sentence/selection 的 `get*Cached`/`set*Cached`。

### modules/validate.js（AI 響應驗證）
- 方法：`validateArticleAnalysis`、`validateDetailedAnalysis`、`validateWordAlignment`、`validateWordInSentence`、`validateSentenceAnalysis`、`validateSelectionAnalysis` 等。
- 用途：在 `modules/api.js` 執行結構檢查與降級處理。

### modules/vocab.js（詞彙輔助）
- 預設生詞本：`ensureDefaultWordbook()`、`getDefaultWordbook()`
- 增補詳情：`ensureWordDetails(entry, { sentence, context, allowDeferForPhrase })`（支援片語：優先 selection→整體→逐詞 IPA 串接）
- 新增詞彙：`addWordToDefaultBook(text, { source, sentence, context })`
- 查重：`findInBookByWord(book, text)`
- 典型用法：
  ```js
  import * as vocab from './modules/vocab.js';
  await vocab.addWordToDefaultBook('take off', { source: 'article', sentence, context });
  ```

### modules/fonts/*（字型載入）
- 內含 Noto Sans TC/思源黑體 子集載入器與 base64 資源，供 PDF 或頁面中文字型一致性需求。

---

## 功能模組（features/）

各功能模組提供 `init*` 入口，並封裝其 UI 與互動邏輯。

### features/vocabulary/vocabulary.js（單詞本）
- 入口：`initVocabulary()`；輔助：`refreshVocabularyView()`、`handleVocabularyQueryParams()`
- 功能：新增/編輯/刪除/導入/導出/合併單詞本，批量 AI 補完缺失（音標/中文）、播放單詞及中文。
- 批量輸入格式：每行一條，支援以下任一格式：
  - `word#中文@/音標/`
  - `word#中文`
  - `word@/音標/`
  - `word`
- URL 導入：支援 `?wordlist=<id>` 或 `?wordlistUrl=<url>` 觸發導入流程。

### features/learning/learning.js（學習）
- 入口：`initLearning()`；輔助：`populateLearningBookSelector()`、`populateWordSelect()`
- 功能：選書→選詞→顯示詳情與例句；可用 AI 生成例句、檢查自寫句子是否正確；滑過例句高亮中英對齊詞。
- 與音訊：`speakWordBtn` 朗讀當前單詞。

### features/dictation/dictation.js（默寫）
- 入口：`initDictation()`
- 功能：根據設定（重複次數、間隔、是否念中文、循環/隨機/只聽模式）進行逐詞播報與默寫；支援暫停/繼續/上一個/下一個/重播；顯示進度與結果；會話與設定可持久化並提示恢復。

### features/quiz/quiz.js（測驗）
- 入口：`initQuiz()`；輔助：`populateQuizBookSelector()`
- 功能：從選定單詞本出題，題型：`meaning`（看英選中）、`word`（看中選英）、`phonetic`（看音標選英）、`mixed`（混合）；顯示進度與得分，結束後展示摘要。

### features/article/article.js（文章詳解與朗讀）
- 入口：`initArticle()`
- 功能：
  - 段落分析：支援標題與段落拆分，採用小並發（預設 2）分段分析，逐段即時渲染；有失敗段落可單獨重試；結果緩存於 `storage` 與 `cache`。
  - 詳解互動：英文句子與中文句子包裝互動標記；點詞顯示提示框（音標/詞性/中文/語法角色），可一鍵加入生詞本、片語解析、播放發音。
  - 文章朗讀：模式 `full`/`sentence`/`paragraph`，支援逐句/逐段、高亮/淡化、重複次數設定、上一/下一句導航；下載 TTS 音檔。
  - 文章庫：開啟/關閉文章庫 Modal，依 `articles/manifest.json` 顯示清單。

### features/qa/*（問答訓練模組）
- 入口：`features/qa/qa.js` 的 `init()`、`showQAModule()`、`hideQAModule()`
- 子模組：
  - `qa-storage.js`：清單載入（預置+本地）、單一載入/保存/刪除、導入/導出、備份、清理過期快取
  - `qa-creator.js`：`Q1: ...\nA1: ...` 批量解析與預覽、表單保存、樣例生成
  - `qa-trainer.js`：開始/暫停/繼續/取消訓練、上一/下一題、保存與恢復進度、統計
  - `qa-checker.js`：AI 校對（並發/重試/快取）、單題重檢
  - `qa-pdf.js`：PDF 導出（包含手寫練習版）
- 常用導出（節選）：
  - `startTraining(id, opts)`、`submitAnswer()`、`nextQuestion()`、`finishTraining()`、`saveTrainingProgress()`
  - `startAIChecking(trainingResult, opts)`、`recheckAnswer(answer)`
  - `exportTrainingResultToPDF(result, aiResult)`、`exportQASetForHandwriting(id, opts)`

---

## 資料與設定

- `wordlists/`：預設單詞本與 `manifest.json`（供導入面板與 URL 參數使用）。
- `articles/`：文章與 `manifest.json`；也有整批 `.txt` 來源。
- `qa-sets/`：預置問答集與 `manifest.json`。
- `ai-config.js`：
  - 從 `ai-config.example.js` 複製生成，填入私密金鑰並勿提交版本庫。
  - `API_URL`、`API_KEY`、`AI_MODELS{ wordAnalysis/articleAnalysis/... }`、`TTS_CONFIG{ baseUrl, apiKey, voices }`。
  - 服務端節流/退避：`modules/api.js` 已處理 429/5xx 回退與最小輸出降級，UI 線程安全。

---

## 測試建議
- 開啟 `test-floating-statusbar.html`：驗證平台偵測、可見性/解鎖策略與懸浮控制行為。
- 功能回歸：
  - 單詞本：新增/導入/合併/導出/批補；
  - 學習：生成例句、句子檢查；
  - 默寫：恢復會話、暫停/繼續、語音切換；
  - 測驗：各題型流程與分數；
  - 文章：段落重試/朗讀/片語解析/加入生詞本；
  - 問答：導入→訓練→AI 校對→PDF。

---

## 常見整合範例

- 在任意功能內顯示提示訊息：
```js
import { displayMessage } from './modules/ui.js';
displayMessage('已保存', 'success');
```

- 在文章詳解中加入選字到生詞本：
```js
import * as vocab from './modules/vocab.js';
await vocab.addWordToDefaultBook(selection, { source: 'article', sentence, context });
```

- 下載當前句子的 TTS：
```js
import { downloadTextAsAudio } from './modules/audio.js';
await downloadTextAsAudio(sentenceText, 'en-US', 0, 'sentence.mp3');
```

---

如需擴展新功能，請遵循：
- 新增共用工具 → 優先放入 `modules/`，並沿用現有風格（ES 模組、單一職責）。
- 新增業務功能 → 置於 `features/<name>/`，提供 `init*` 入口與分檔超過 300 行的內聚輔助檔。
- DOM 請統一走 `modules/dom.js`；狀態變更請使用 `modules/state.js` 的 setter。
- 涉及外部 API → 在 `modules/api.js` 註明速率限制與降級策略，避免阻塞 UI 線程。
