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
export let dictationWords = [];

// 新增：默写会话状态（支持跨页面和刷新恢复）
export let dictationSessionActive = false;
export let dictationStartTime = null;
export let dictationSettings = {
    selectedBookId: null,
    repeatTimes: 2,
    wordInterval: 3,
    readMeaning: false,
    loopMode: false,
    shuffleMode: false,
    listenOnlyMode: true,
    showWordInfo: false
};

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

export function setDictationWords(words) {
    dictationWords = words;
}

// 新增：默写会话状态管理函数
export function setDictationSessionActive(active) {
    dictationSessionActive = active;
    if (active) {
        dictationStartTime = new Date().toISOString();
    } else {
        dictationStartTime = null;
    }
}

export function setDictationStartTime(time) {
    dictationStartTime = time;
}

export function setDictationSettings(settings) {
    dictationSettings = { ...dictationSettings, ...settings };
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

// =================================
// 默写状态持久化功能
// =================================

const DICTATION_STATE_KEY = 'pen_dictation_session';
const DICTATION_SETTINGS_KEY = 'pen_dictation_settings';

/**
 * 保存默写会话状态到 localStorage
 */
export function saveDictationSession() {
    if (!dictationSessionActive) return;
    
    const sessionState = {
        active: dictationSessionActive,
        startTime: dictationStartTime,
        currentIndex: currentDictationIndex,
        isPaused: isDictationPaused,
        words: dictationWords,
        settings: dictationSettings,
        timestamp: Date.now()
    };
    
    try {
        localStorage.setItem(DICTATION_STATE_KEY, JSON.stringify(sessionState));
    } catch (error) {
        console.warn('Failed to save dictation session:', error);
    }
}

/**
 * 从 localStorage 加载默写会话状态
 */
export function loadDictationSession() {
    try {
        const saved = localStorage.getItem(DICTATION_STATE_KEY);
        if (!saved) return null;
        
        const sessionState = JSON.parse(saved);
        
        // 检查会话是否过期（24小时）
        const now = Date.now();
        const sessionAge = now - sessionState.timestamp;
        const maxAge = 24 * 60 * 60 * 1000; // 24小时
        
        if (sessionAge > maxAge) {
            clearDictationSession();
            return null;
        }
        
        // 恢复状态
        if (sessionState.active) {
            dictationSessionActive = sessionState.active;
            dictationStartTime = sessionState.startTime;
            currentDictationIndex = sessionState.currentIndex || -1;
            isDictationPaused = sessionState.isPaused || false;
            dictationWords = sessionState.words || [];
            dictationSettings = { ...dictationSettings, ...(sessionState.settings || {}) };
            
            return sessionState;
        }
        
        return null;
    } catch (error) {
        console.warn('Failed to load dictation session:', error);
        clearDictationSession();
        return null;
    }
}

/**
 * 清除保存的默写会话状态
 */
export function clearDictationSession() {
    try {
        localStorage.removeItem(DICTATION_STATE_KEY);
    } catch (error) {
        console.warn('Failed to clear dictation session:', error);
    }
}

/**
 * 保存默写设置到 localStorage
 */
export function saveDictationSettings() {
    try {
        localStorage.setItem(DICTATION_SETTINGS_KEY, JSON.stringify(dictationSettings));
    } catch (error) {
        console.warn('Failed to save dictation settings:', error);
    }
}

/**
 * 从 localStorage 加载默写设置
 */
export function loadDictationSettings() {
    try {
        const saved = localStorage.getItem(DICTATION_SETTINGS_KEY);
        if (saved) {
            const loadedSettings = JSON.parse(saved);
            dictationSettings = { ...dictationSettings, ...loadedSettings };
            if (typeof dictationSettings.showWordInfo !== 'boolean') {
                dictationSettings.showWordInfo = false;
            }
            return dictationSettings;
        }
    } catch (error) {
        console.warn('Failed to load dictation settings:', error);
    }
    return dictationSettings;
}

/**
 * 获取默写会话摘要信息（用于状态栏显示）
 */
export function getDictationSessionSummary() {
    if (!dictationSessionActive) return null;
    
    return {
        isActive: dictationSessionActive,
        startTime: dictationStartTime,
        currentIndex: currentDictationIndex,
        totalWords: dictationWords.length,
        isPaused: isDictationPaused,
        progress: dictationWords.length > 0 ? 
                 Math.round(((currentDictationIndex + 1) / dictationWords.length) * 100) : 0
    };
}
