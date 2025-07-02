// =================================
// 应用全局状态管理
// =================================

// ---------------------------------
// 核心数据
// ---------------------------------
export let vocabularyBooks = []; // { id: string, name: string, words: [...] }[]
export let activeBookId = null;
export let analyzedArticles = [];

// ---------------------------------
// 默写模式状态
// ---------------------------------
export let currentDictationIndex = -1;
export let dictationInterval = null;
export let dictationTimeout = null;
export let isDictationPaused = false;

// ---------------------------------
// 测验模式状态
// ---------------------------------
export let quizQuestions = [];
export let currentQuestionIndex = 0;
export let quizScore = 0;
export let selectedAnswer = null;
export let quizInProgress = false;

// ---------------------------------
// 文章朗读状态
// ---------------------------------
export let readingChunks = [];
export let currentChunkIndex = 0;
export let isReadingChunkPaused = false;
export let currentSpeed = 0;
export let sentenceRepeatCount = 0;

// ---------------------------------
// Web Audio API 状态
// ---------------------------------
export let audioContext = null;
export let audioSource = null;
export const globalAudioElement = new Audio();
export let isAudioContextUnlocked = false;

// =================================
// 状态更新函数
// =================================

export function setVocabularyBooks(newBooks) {
    vocabularyBooks = newBooks;
}

export function setActiveBookId(newId) {
    activeBookId = newId;
}

export function setAnalyzedArticles(newArticles) {
    analyzedArticles = newArticles;
}

export function setCurrentDictationIndex(index) {
    currentDictationIndex = index;
}

export function setDictationInterval(interval) {
    dictationInterval = interval;
}

export function setDictationTimeout(timeout) {
    dictationTimeout = timeout;
}

export function setIsDictationPaused(paused) {
    isDictationPaused = paused;
}

export function setQuizQuestions(questions) {
    quizQuestions = questions;
}

export function setCurrentQuestionIndex(index) {
    currentQuestionIndex = index;
}

export function setQuizScore(score) {
    quizScore = score;
}

export function setSelectedAnswer(answer) {
    selectedAnswer = answer;
}

export function setQuizInProgress(inProgress) {
    quizInProgress = inProgress;
}

export function setReadingChunks(chunks) {
    readingChunks = chunks;
}

export function setCurrentChunkIndex(index) {
    currentChunkIndex = index;
}

export function setIsReadingChunkPaused(paused) {
    isReadingChunkPaused = paused;
}

export function setCurrentSpeed(speed) {
    currentSpeed = speed;
}

export function setSentenceRepeatCount(count) {
    sentenceRepeatCount = count;
}

export function setAudioContext(context) {
    audioContext = context;
}

export function setAudioSource(source) {
    audioSource = source;
}

export function setIsAudioContextUnlocked(unlocked) {
    isAudioContextUnlocked = unlocked;
}