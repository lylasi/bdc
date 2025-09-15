// =================================
// DOM 元素选择器
// =================================

// --- 导航与主要布局 ---
export const navBtns = document.querySelectorAll('.nav-btn');
export const sections = document.querySelectorAll('.section');

// --- 单词本页面 ---
export const vocabBookList = document.getElementById('vocab-book-list');
export const addVocabBookBtn = document.getElementById('add-vocab-book-btn');
export const importVocabBookBtn = document.getElementById('import-vocab-book-btn');
export const currentBookName = document.getElementById('current-book-name');
export const editVocabBookBtn = document.getElementById('edit-vocab-book-btn');
export const deleteVocabBookBtn = document.getElementById('delete-vocab-book-btn');
export const exportVocabBookBtn = document.getElementById('export-vocab-book-btn');
export const mergeVocabBooksBtn = document.getElementById('merge-vocab-books-btn');
export const wordList = document.getElementById('word-list');

// --- 学习模式页面 ---
export const learningBookSelector = document.getElementById('learning-book-selector');
export const wordSelect = document.getElementById('word-select');
export const detailWord = document.getElementById('detail-word');
export const detailPhonetic = document.getElementById('detail-phonetic');
export const detailMeaning = document.getElementById('detail-meaning');
export const speakWordBtn = document.getElementById('speak-word-btn');
export const generateExamplesBtn = document.getElementById('generate-examples-btn');
export const examplesContainer = document.getElementById('examples-container');
export const sentenceInput = document.getElementById('sentence-input');
export const checkSentenceBtn = document.getElementById('check-sentence-btn');
export const sentenceFeedback = document.getElementById('sentence-feedback');

// --- 默写模式页面 ---
export const repeatTimes = document.getElementById('repeat-times');
export const wordInterval = document.getElementById('word-interval');
export const readMeaning = document.getElementById('read-meaning');
export const loopMode = document.getElementById('loop-mode');
export const shuffleMode = document.getElementById('shuffle-mode');
export const startDictationBtn = document.getElementById('start-dictation-btn');
export const stopDictationBtn = document.getElementById('stop-dictation-btn');
export const pauseDictationBtn = document.getElementById('pause-dictation-btn');
export const replayDictationBtn = document.getElementById('replay-dictation-btn');
export const prevDictationBtn = document.getElementById('prev-dictation-btn');
export const nextDictationBtn = document.getElementById('next-dictation-btn');
export const dictationWordDisplay = document.getElementById('dictation-word-display');
export const dictationInput = document.getElementById('dictation-input');
export const checkDictationBtn = document.getElementById('check-dictation-btn');
export const dictationResult = document.getElementById('dictation-result');
export const dictationBookSelector = document.getElementById('dictation-book-selector');
export const listenOnlyMode = document.getElementById('listen-only-mode');
export const dictationPractice = document.querySelector('.dictation-practice');
export const dictationProgressContainer = document.getElementById('dictation-progress-container');
export const dictationProgressBar = document.getElementById('dictation-progress-bar');
export const dictationProgressText = document.getElementById('dictation-progress-text');

// --- 测验模式页面 ---
export const quizBookSelector = document.getElementById('quiz-book-selector');
export const quizCount = document.getElementById('quiz-count');
export const quizType = document.getElementById('quiz-type');
export const startQuizBtn = document.getElementById('start-quiz-btn');
export const stopQuizBtn = document.getElementById('stop-quiz-btn');
export const quizProgress = document.getElementById('quiz-progress');
export const quizScoreDisplay = document.getElementById('quiz-score');
export const quizQuestion = document.getElementById('quiz-question');
export const quizOptions = document.getElementById('quiz-options');
export const nextQuestionBtn = document.getElementById('next-question-btn');
export const quizResult = document.getElementById('quiz-result');
export const finalScore = document.getElementById('final-score');
export const quizSummary = document.getElementById('quiz-summary');
export const restartQuizBtn = document.getElementById('restart-quiz-btn');
export const quizSettingsContainer = document.getElementById('quiz-settings-container');
export const quizMainContainer = document.getElementById('quiz-main-container');
export const analysisTooltip = document.getElementById('word-analysis-tooltip');

// --- 文章详解页面 ---
export const articleInput = document.getElementById('article-input');
export const analyzeArticleBtn = document.getElementById('analyze-article-btn');
export const articleAnalysisContainer = document.getElementById('article-analysis-container');
export const articleHistorySelect = document.getElementById('article-history-select');
export const deleteHistoryBtn = document.getElementById('delete-history-btn');
export const clearArticleBtn = document.getElementById('clear-article-btn');
export const readArticleBtn = document.getElementById('read-article-btn');
export const stopReadArticleBtn = document.getElementById('stop-read-article-btn');
export const downloadAudioBtn = document.getElementById('download-audio-btn');
export const readingModeSelect = document.getElementById('reading-mode');
export const speedBtnGroup = document.getElementById('speed-control-group');
export const chunkNavControls = document.getElementById('chunk-nav-controls');
export const prevChunkBtn = document.getElementById('prev-chunk-btn');
export const nextChunkBtn = document.getElementById('next-chunk-btn');
export const chunkProgressSpan = document.getElementById('chunk-progress');
export const chunkRepeatControls = document.getElementById('chunk-repeat-controls');
export const chunkRepeatTimes = document.getElementById('chunk-repeat-times');
export const currentSentenceDisplay = document.getElementById('current-sentence-display');

// --- 文章库 ---
export const showArticleLibraryBtn = document.getElementById('show-article-library-btn');
export const articleLibraryModal = document.getElementById('article-library-modal');
export const articleLibraryList = document.getElementById('article-library-list');

// --- 通用 Modal ---
export const appModal = document.getElementById('app-modal');
export const modalTitle = document.getElementById('modal-title');
export const modalBody = document.getElementById('modal-body');
export const modalCloseBtn = appModal.querySelector('.modal-close-btn');