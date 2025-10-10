import * as state from '../../modules/state.js';
import * as dom from '../../modules/dom.js';
import * as audio from '../../modules/audio.js';
import * as ui from '../../modules/ui.js';
import * as platform from '../../modules/platform.js';
import { initDictationGrader } from './dictation-grader.js';

// =================================
// Dictation Feature
// =================================

/**
 * 初始化默寫模式功能，綁定事件監聽器。
 */
export function initDictation() {
    dom.startDictationBtn.addEventListener('click', startDictation);
    dom.stopDictationBtn.addEventListener('click', stopDictation);
    dom.pauseDictationBtn.addEventListener('click', togglePauseDictation);
    dom.replayDictationBtn.addEventListener('click', replayCurrentDictationWord);
    dom.prevDictationBtn.addEventListener('click', gotoPrevDictationWord);
    dom.nextDictationBtn.addEventListener('click', gotoNextDictationWord);
    dom.checkDictationBtn.addEventListener('click', checkDictation);
    dom.listenOnlyMode.addEventListener('change', () => {
        dom.dictationPractice.classList.toggle('hidden', dom.listenOnlyMode.checked);
    });
    dom.dictationInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            checkDictation();
        }
    });
    // 初始化 AI 批改
    try { initDictationGrader(); } catch(_) {}
    
    // 加載保存的設置
    state.loadDictationSettings();
    loadDictationSettings();
    setupChineseVoiceOptions();
    
    // 檢查是否有未完成的會話需要恢復
    checkAndRestoreDictationSession();
}

/**
 * 加載默寫設置到界面
 */
function loadDictationSettings() {
    if (dom.repeatTimes) dom.repeatTimes.value = state.dictationSettings.repeatTimes;
    if (dom.wordInterval) dom.wordInterval.value = state.dictationSettings.wordInterval;
    if (dom.loopMode) dom.loopMode.checked = state.dictationSettings.loopMode;
    if (dom.shuffleMode) dom.shuffleMode.checked = state.dictationSettings.shuffleMode;
    if (dom.listenOnlyMode) dom.listenOnlyMode.checked = state.dictationSettings.listenOnlyMode;
    applyChineseVoiceSelection(state.dictationSettings.readChineseVoice || 'none');
}

function getSelectedChineseVoice() {
    if (dom.readChineseMandarin?.checked) return 'chinese';
    if (dom.readChineseCantonese?.checked) return 'cantonese';
    return 'none';
}

function applyChineseVoiceSelection(voice) {
    if (dom.readChineseMandarin) dom.readChineseMandarin.checked = voice === 'chinese';
    if (dom.readChineseCantonese) dom.readChineseCantonese.checked = voice === 'cantonese';
    updateChineseVoiceToggleStyles();
}

function updateChineseVoiceToggleStyles() {
    if (!dom.chineseVoiceToggles) return;
    dom.chineseVoiceToggles.forEach(toggle => {
        const input = toggle.querySelector('input');
        if (!input) return;
        toggle.classList.toggle('is-active', input.checked);
    });
}

function setupChineseVoiceOptions() {
    if (!dom.readChineseMandarin || !dom.readChineseCantonese) return;

    const syncSelection = () => {
        saveDictationSettings();
        updateChineseVoiceToggleStyles();
    };

    dom.readChineseMandarin.addEventListener('change', () => {
        if (dom.readChineseMandarin.checked) {
            dom.readChineseCantonese.checked = false;
        }
        syncSelection();
    });

    dom.readChineseCantonese.addEventListener('change', () => {
        if (dom.readChineseCantonese.checked) {
            dom.readChineseMandarin.checked = false;
        }
        syncSelection();
    });

    updateChineseVoiceToggleStyles();
}

/**
 * 保存當前設置
 */
function saveDictationSettings() {
    const chineseVoice = getSelectedChineseVoice();
    const settings = {
        repeatTimes: parseInt(dom.repeatTimes?.value || '2'),
        wordInterval: parseInt(dom.wordInterval?.value || '3'),
        readChineseVoice: chineseVoice,
        loopMode: dom.loopMode?.checked || false,
        shuffleMode: dom.shuffleMode?.checked || false,
        listenOnlyMode: dom.listenOnlyMode?.checked || true,
        showWordInfo: typeof state.dictationSettings.showWordInfo === 'boolean'
            ? state.dictationSettings.showWordInfo
            : false
    };
    
    state.setDictationSettings(settings);
    state.saveDictationSettings();
}

/**
 * 檢查並恢復默寫會話
 */
function checkAndRestoreDictationSession() {
    const session = state.loadDictationSession();
    if (!session) return;
    
    // 顯示恢復提示
    showSessionRestorePrompt(session);
}

/**
 * 顯示會話恢復提示
 */
function showSessionRestorePrompt(session) {
    const startTime = new Date(session.startTime).toLocaleString();
    const message = `檢測到未完成的默寫會話：\n開始時間：${startTime}\n進度：${session.currentIndex + 1}/${session.words.length}\n\n是否繼續之前的會話？`;
    
    if (confirm(message)) {
        restoreDictationSession(session);
    } else {
        state.clearDictationSession();
    }
}

/**
 * 恢復默寫會話
 */
function restoreDictationSession(session) {
    try {
        // 恢復設置
        loadDictationSettings();
        
        // 恢復狀態
        state.setDictationWords(session.words);
        state.setCurrentDictationIndex(session.currentIndex);
        state.setIsDictationPaused(session.isPaused);
        state.setDictationSessionActive(true);
        state.setDictationStartTime(session.startTime);
        
        // 更新界面
        dom.startDictationBtn.disabled = true;
        dom.stopDictationBtn.disabled = false;
        dom.pauseDictationBtn.disabled = false;
        dom.dictationPractice.classList.toggle('hidden', dom.listenOnlyMode.checked);
        dom.dictationProgressContainer.classList.remove('hidden');
        
        // 顯示浮動控制器
        showFloatingControls();
        
        // 更新進度和按鈕狀態
        updateDictationProgress(session.words.length);
        updatePauseButtonUI();
        
        // 如果不是暫停狀態，繼續播放
        if (!session.isPaused) {
            setTimeout(() => playCurrentWord(), 1000);
        }
        
        console.log('默寫會話已恢復');
    } catch (error) {
        console.error('恢復默寫會話失敗:', error);
        state.clearDictationSession();
    }
}

function getSelectedDictationWords() {
    const selectedRadio = dom.dictationBookSelector.querySelector('input[name="dictation-book"]:checked');
    if (selectedRadio) {
        const book = state.vocabularyBooks.find(b => b.id === selectedRadio.value);
        return book ? book.words : [];
    }
    return [];
}

function startDictation() {
    let wordsForDictation = getSelectedDictationWords();

    if (!wordsForDictation || wordsForDictation.length === 0) {
        alert('請先選擇一個包含單詞的單詞本！');
        return;
    }

    // 保存當前設置
    saveDictationSettings();

    if (dom.shuffleMode.checked) {
        wordsForDictation = [...wordsForDictation].sort(() => Math.random() - 0.5);
    }
    
    state.setDictationWords(wordsForDictation);
    
    // 激活會話狀態
    state.setDictationSessionActive(true);
    
    dom.startDictationBtn.disabled = true;
    dom.stopDictationBtn.disabled = false;
    dom.pauseDictationBtn.disabled = false;
    state.setIsDictationPaused(false);
    
    dom.dictationPractice.classList.toggle('hidden', dom.listenOnlyMode.checked);
    dom.dictationProgressContainer.classList.remove('hidden');

    // 關鍵：先設置索引，再更新UI
    state.setCurrentDictationIndex(0);
    dom.dictationWordDisplay.textContent = '';
    dom.dictationInput.value = '';
    dom.dictationResult.textContent = '';
    dom.dictationResult.className = '';
    
    // 現在更新按鈕UI，此時currentDictationIndex已經是0了
    updatePauseButtonUI();
    updateDictationProgress(state.dictationWords.length);
    playCurrentWord();
    showFloatingControls();
    
    // 保存會話狀態
    state.saveDictationSession();
}

function stopDictation() {
    state.setIsDictationPaused(true);
    audio.stopCurrentAudio();
    clearTimeout(state.dictationTimeout);
    clearInterval(state.dictationInterval);
    state.setDictationInterval(null);

    dom.startDictationBtn.disabled = false;
    dom.stopDictationBtn.disabled = true;
    dom.pauseDictationBtn.disabled = true;
    dom.dictationProgressContainer.classList.add('hidden');
    dom.dictationPractice.classList.toggle('hidden', dom.listenOnlyMode.checked);
    dom.replayDictationBtn.style.display = 'none';
    dom.dictationWordDisplay.textContent = '已停止';
    
    state.setCurrentDictationIndex(-1);
    state.setIsDictationPaused(false);
    
    // 停用會話狀態並清理持久化數據
    state.setDictationSessionActive(false);
    state.clearDictationSession();
    
    updatePauseButtonUI();

    // 清理浮動控制器和事件監聽器
    const floatingControls = document.getElementById('floating-dictation-controls');
    if (floatingControls) {
        floatingControls.remove();
    }
    
    // 清理平臺相關的事件監聽器
    if (window._dictationCleanups) {
        window._dictationCleanups.forEach(cleanup => {
            if (typeof cleanup === 'function') cleanup();
        });
        window._dictationCleanups = [];
    }
}

export function togglePauseDictation() {
    if (dom.stopDictationBtn.disabled) return;

    state.setIsDictationPaused(!state.isDictationPaused);

    if (state.isDictationPaused) {
        clearTimeout(state.dictationTimeout);
        clearInterval(state.dictationInterval);
        audio.stopCurrentAudio();
    } else {
        playCurrentWord();
    }
    setTimeout(updatePauseButtonUI, 0);
    
    // 保存狀態變化
    if (state.dictationSessionActive) {
        state.saveDictationSession();
    }
}

function updatePauseButtonUI() {
    const text = state.isDictationPaused ? '繼續' : '暫停';
    const replayBtnDisplay = state.isDictationPaused ? 'inline-block' : 'none';
    // 導航按鈕在默寫開始後就顯示（不管是否暫停）
    const navBtnDisplay = (state.currentDictationIndex >= 0 && state.dictationWords.length > 0) ? 'inline-block' : 'none';

    if (dom.pauseDictationBtn) dom.pauseDictationBtn.textContent = text;
    if (dom.replayDictationBtn) dom.replayDictationBtn.style.display = replayBtnDisplay;
    if (dom.prevDictationBtn) dom.prevDictationBtn.style.display = navBtnDisplay;
    if (dom.nextDictationBtn) dom.nextDictationBtn.style.display = navBtnDisplay;

    const floatingPauseBtn = document.getElementById('floating-pause-btn');
    if (floatingPauseBtn) floatingPauseBtn.textContent = text;
    
    const floatingReplayBtn = document.getElementById('floating-replay-btn');
    if (floatingReplayBtn) floatingReplayBtn.style.display = replayBtnDisplay;

    // 更新按鈕狀態
    updateNavigationButtonState();
}

function showFloatingControls() {
    if (document.getElementById('floating-dictation-controls')) return;

    // 創建增強版狀態欄
    const statusBar = createEnhancedStatusBar();
    document.body.appendChild(statusBar);
    
    // 初始化平臺特定的優化
    initPlatformOptimizations(statusBar);
    
    // 監聽頁面可見性變化
    setupVisibilityHandling();
}

/**
 * 創建增強版浮動狀態欄
 */
function createEnhancedStatusBar() {
    const statusBar = document.createElement('div');
    statusBar.id = 'floating-dictation-controls';
    statusBar.className = 'enhanced-floating-controls';
    
    // 創建主控制區域
    const mainControls = createMainControls();
    statusBar.appendChild(mainControls);
    
    // 創建展開面板
    const expandPanel = createExpandPanel();
    statusBar.appendChild(expandPanel);
    
    return statusBar;
}

/**
 * 創建主控制區域（不展開時顯示）
 */
function createMainControls() {
    const container = document.createElement('div');
    container.className = 'main-controls';
    
    // 上一個按鈕（左側，大按鈕）
    const prevBtn = document.createElement('button');
    prevBtn.id = 'floating-prev-btn';
    prevBtn.className = 'control-btn prev-btn';
    prevBtn.innerHTML = '⬅';
    prevBtn.title = '上一個單詞';
    prevBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        gotoPrevDictationWord();
    });
    
    // 重播按鈕（在左側按鈕和信息區域之間）
    const replayBtn = document.createElement('button');
    replayBtn.id = 'floating-replay-btn';
    replayBtn.className = 'control-btn replay-btn';
    replayBtn.innerHTML = '🔄';
    replayBtn.title = '重播當前單詞';
    replayBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        replayCurrentDictationWord();
    });
    
    // 中間信息區域
    const infoArea = document.createElement('div');
    infoArea.className = 'info-area';
    infoArea.addEventListener('click', toggleExpandPanel);
    
    const progressSpan = document.createElement('span');
    progressSpan.id = 'floating-progress-text';
    progressSpan.className = 'progress-text';
    progressSpan.textContent = dom.dictationProgressText.textContent;
    
    const expandIcon = document.createElement('span');
    expandIcon.className = 'expand-icon';
    expandIcon.textContent = '▼';
    expandIcon.setAttribute('aria-label', '展開單詞列表');
    expandIcon.dataset.expanded = 'false';

    infoArea.appendChild(progressSpan);
    infoArea.appendChild(expandIcon);
    
    // 暫停/繼續按鈕（中間）
    const pauseBtn = document.createElement('button');
    pauseBtn.id = 'floating-pause-btn';
    pauseBtn.className = 'control-btn pause-btn';
    pauseBtn.textContent = state.isDictationPaused ? '繼續' : '暫停';
    pauseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        togglePauseDictation();
    });
    
    // 下一個按鈕（右側，大按鈕）
    const nextBtn = document.createElement('button');
    nextBtn.id = 'floating-next-btn';
    nextBtn.className = 'control-btn next-btn';
    nextBtn.innerHTML = '➡';
    nextBtn.title = '下一個單詞';
    nextBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        gotoNextDictationWord();
    });
    
    container.appendChild(prevBtn);
    container.appendChild(replayBtn);
    container.appendChild(infoArea);
    container.appendChild(pauseBtn);
    container.appendChild(nextBtn);
    
    return container;
}

/**
 * 創建展開面板
 */
function createExpandPanel() {
    const panel = document.createElement('div');
    panel.id = 'expand-panel';
    panel.className = 'expand-panel';
    panel.style.display = 'none';
    
    // 面板頭部
    const header = document.createElement('div');
    header.className = 'panel-header';
    
    const title = document.createElement('h3');
    title.textContent = '單詞列表';
    
    const closeBtn = document.createElement('button');
    closeBtn.className = 'close-btn';
    closeBtn.innerHTML = '×';
    closeBtn.addEventListener('click', () => toggleExpandPanel());
    
    // 控制選項
    const controls = document.createElement('div');
    controls.className = 'panel-controls';
    
    const showInfoToggle = document.createElement('label');
    showInfoToggle.className = 'toggle-label';

    const showInfoCheckbox = document.createElement('input');
    showInfoCheckbox.type = 'checkbox';
    showInfoCheckbox.id = 'show-word-info';

    const showInfoLabel = document.createElement('span');
    showInfoLabel.textContent = '顯示單詞信息';

    showInfoToggle.appendChild(showInfoCheckbox);
    showInfoToggle.appendChild(showInfoLabel);

    const shouldShowInfo = typeof state.dictationSettings.showWordInfo === 'boolean'
        ? state.dictationSettings.showWordInfo
        : false;
    showInfoCheckbox.checked = shouldShowInfo;

    showInfoCheckbox.addEventListener('change', () => {
        const isChecked = showInfoCheckbox.checked;
        state.setDictationSettings({ showWordInfo: isChecked });
        state.saveDictationSettings();
        updateFloatingWordList();
    });

    controls.appendChild(showInfoToggle);
    
    header.appendChild(title);
    header.appendChild(controls);
    header.appendChild(closeBtn);
    
    // 單詞列表容器
    const listContainer = document.createElement('div');
    listContainer.className = 'word-list-container';
    
    const wordList = document.createElement('div');
    wordList.id = 'floating-word-list';
    wordList.className = 'word-list';
    
    listContainer.appendChild(wordList);
    
    panel.appendChild(header);
    panel.appendChild(listContainer);
    
    return panel;
}

/**
 * 切換展開面板顯示狀態
 */
function toggleExpandPanel() {
    const panel = document.getElementById('expand-panel');
    const statusBar = document.getElementById('floating-dictation-controls');
    
    if (!panel || !statusBar) return;
    
    const isExpanded = panel.style.display !== 'none';
    
    if (isExpanded) {
        // 收起面板
        panel.style.display = 'none';
        statusBar.classList.remove('expanded');
    } else {
        // 展開面板
        panel.style.display = 'block';
        statusBar.classList.add('expanded');
        
        // 更新單詞列表
        updateFloatingWordList();
        
        // 設置面板高度爲屏幕的1/2
        const viewportHeight = platform.getViewportHeight();
        panel.style.height = `${viewportHeight * 0.5}px`;
    }

    updateExpandIcon(!isExpanded);
}

function updateExpandIcon(isExpanded) {
    const expandIcon = document.querySelector('.expand-icon');
    if (!expandIcon) return;
    expandIcon.textContent = isExpanded ? '▲' : '▼';
    expandIcon.setAttribute('aria-label', isExpanded ? '收起單詞列表' : '展開單詞列表');
    expandIcon.dataset.expanded = String(isExpanded);
}

/**
 * 更新浮動單詞列表
 */
function updateFloatingWordList() {
    const wordList = document.getElementById('floating-word-list');
    const showInfoCheckbox = document.getElementById('show-word-info');
    
    if (!wordList || !state.dictationWords) return;
    
    const storedPreference = typeof state.dictationSettings.showWordInfo === 'boolean'
        ? state.dictationSettings.showWordInfo
        : false;
    const showInfo = showInfoCheckbox ? showInfoCheckbox.checked : storedPreference;
    
    wordList.innerHTML = '';
    
    state.dictationWords.forEach((word, index) => {
        const wordItem = document.createElement('div');
        wordItem.className = 'word-item';
        if (index === state.currentDictationIndex) {
            wordItem.classList.add('current');
        }
        wordItem.dataset.index = index;
        wordItem.dataset.phoneticOnly = (!showInfo).toString();

        const wordHeader = document.createElement('div');
        wordHeader.className = 'word-header';
        wordItem.appendChild(wordHeader);

        if (showInfo) {
            const wordText = document.createElement('div');
            wordText.className = 'word-text';
            wordText.textContent = word.word;
            wordHeader.appendChild(wordText);
        }

        const rawPhonetic = typeof word.phonetic === 'string' ? word.phonetic.trim() : '';
        const cleanedPhonetic = rawPhonetic.replace(/^\/+|\/+$/g, '');
        const hasPhonetic = cleanedPhonetic && cleanedPhonetic.toLowerCase() !== 'n/a';
        const shouldRenderPhonetic = hasPhonetic || !showInfo;

        if (shouldRenderPhonetic) {
            const phoneticEl = document.createElement('span');
            phoneticEl.className = 'word-phonetic';
            if (hasPhonetic) {
                phoneticEl.textContent = `/${cleanedPhonetic}/`;
            } else {
                phoneticEl.textContent = '暫無音標';
                phoneticEl.classList.add('word-phonetic--missing');
            }
            wordHeader.appendChild(phoneticEl);
        }

        if (showInfo && word.meaning) {
            const wordMeaning = document.createElement('div');
            wordMeaning.className = 'word-meaning';
            wordMeaning.textContent = word.meaning;
            wordItem.appendChild(wordMeaning);
        }
        
        // 點擊跳轉到該單詞
        wordItem.addEventListener('click', () => {
            jumpToWord(index);
        });
        
        wordList.appendChild(wordItem);
    });
    
    // 滾動到當前單詞
    scrollToCurrentWord();
}

/**
 * 跳轉到指定單詞
 */
function jumpToWord(index) {
    if (index < 0 || index >= state.dictationWords.length) return;
    
    // 暫停當前播放
    if (!state.isDictationPaused) {
        state.setIsDictationPaused(true);
        clearTimeout(state.dictationTimeout);
        clearInterval(state.dictationInterval);
        audio.stopCurrentAudio();
    }
    
    // 跳轉到指定單詞
    state.setCurrentDictationIndex(index);
    playCurrentWordOnce();
    updateDictationProgress(state.dictationWords.length);
    updatePauseButtonUI();
    updateFloatingWordList();
    
    // 清空輸入和結果
    if (dom.dictationInput) dom.dictationInput.value = '';
    if (dom.dictationResult) {
        dom.dictationResult.textContent = '';
        dom.dictationResult.className = '';
    }
    if (dom.dictationWordDisplay) dom.dictationWordDisplay.textContent = '';
    
    // 保存狀態變化
    if (state.dictationSessionActive) {
        state.saveDictationSession();
    }
}

/**
 * 滾動到當前單詞
 */
function scrollToCurrentWord() {
    const currentItem = document.querySelector('.word-item.current');
    if (currentItem && currentItem.scrollIntoView) {
        currentItem.scrollIntoView({
            behavior: 'smooth',
            block: 'center'
        });
    }
}

/**
 * 初始化平臺特定優化
 */
function initPlatformOptimizations(statusBar) {
    // iOS特殊處理
    if (platform.detect.isIOS) {
        // 禁用彈性滾動
        const wordList = statusBar.querySelector('.word-list');
        if (wordList) {
            platform.disableBounceScrolling(wordList);
        }
        
        // 觸摸優化
        const touchTargetSize = platform.getOptimalTouchTarget();
        statusBar.style.setProperty('--touch-target-size', `${touchTargetSize}px`);
    }
    
    // 微信瀏覽器優化
    if (platform.detect.isWeixin) {
        platform.initWeixinAudio(() => {
            console.log('微信音頻已初始化');
        });
    }
}

/**
 * 設置頁面可見性處理
 */
function setupVisibilityHandling() {
    const removeListener = platform.onVisibilityChange((isVisible) => {
        if (!isVisible) {
            // 頁面不可見時，繼續播放但更新狀態欄
            updateFloatingStatus();
        } else {
            // 頁面可見時，恢復狀態欄顯示
            updateFloatingStatus();
        }
    });
    
    // 保存移除監聽器的函數，在停止默寫時調用
    if (!window._dictationCleanups) window._dictationCleanups = [];
    window._dictationCleanups.push(removeListener);
}

/**
 * 更新浮動狀態欄信息
 */
function updateFloatingStatus() {
    const progressText = document.getElementById('floating-progress-text');
    const pauseBtn = document.getElementById('floating-pause-btn');
    
    if (progressText && dom.dictationProgressText) {
        progressText.textContent = dom.dictationProgressText.textContent;
    }
    
    if (pauseBtn) {
        pauseBtn.textContent = state.isDictationPaused ? '繼續' : '暫停';
    }
    
    // 更新單詞列表（如果展開）
    const panel = document.getElementById('expand-panel');
    if (panel && panel.style.display !== 'none') {
        updateFloatingWordList();
        updateExpandIcon(true);
    } else {
        updateExpandIcon(false);
    }
}

function playCurrentWord() {
    if (state.isDictationPaused) return;

    if (state.currentDictationIndex >= state.dictationWords.length) {
        if (dom.loopMode.checked) {
            state.setCurrentDictationIndex(0);
        } else {
            stopDictation();
            dom.dictationWordDisplay.textContent = '默寫完成';
            return;
        }
    }

    const currentWord = state.dictationWords[state.currentDictationIndex];
    updateDictationProgress(state.dictationWords.length);
    updateNavigationButtonState();
    
    let timesPlayed = 0;
    const repeatTarget = parseInt(dom.repeatTimes.value, 10);

    function playSequence() {
        if (state.isDictationPaused) return;
        timesPlayed++;

        const afterWordPlayed = () => {
            if (state.isDictationPaused) return;
            if (timesPlayed < repeatTarget) {
                setTimeout(playSequence, 500);
            } else {
                const chineseVoice = state.dictationSettings.readChineseVoice || 'none';
                if (chineseVoice !== 'none' && currentWord.meaning) {
                    const voiceKey = chineseVoice === 'cantonese' ? 'cantonese' : 'chinese';
                    setTimeout(() => audio.speakText(currentWord.meaning, voiceKey, 0, null, scheduleNextWord), 500);
                } else {
                    scheduleNextWord();
                }
            }
        };
        // 默寫英語：若未特別指定，遵從全局英語朗讀首選
        audio.speakText(currentWord.word, 'english', 0, null, afterWordPlayed);
    }
    
    function scheduleNextWord() {
        if (state.isDictationPaused) return;
        clearTimeout(state.dictationTimeout);
        const timeout = setTimeout(() => {
            state.setCurrentDictationIndex(state.currentDictationIndex + 1);
            playCurrentWord();
        }, parseInt(dom.wordInterval.value, 10) * 1000);
        state.setDictationTimeout(timeout);
    }

    playSequence();
}

function checkDictation() {
    if (!state.dictationWords || state.currentDictationIndex < 0 || state.currentDictationIndex >= state.dictationWords.length) {
        alert('請先開始默寫！');
        return;
    }
    
    const currentWord = state.dictationWords[state.currentDictationIndex];
    const userInput = dom.dictationInput.value.trim().toLowerCase();
    
    if (userInput === currentWord.word.toLowerCase()) {
        dom.dictationResult.textContent = '正確！';
        dom.dictationResult.className = 'correct';
    } else {
        dom.dictationResult.textContent = `錯誤！正確答案是: ${currentWord.word}`;
        dom.dictationResult.className = 'incorrect';
    }
    dom.dictationWordDisplay.textContent = currentWord.word;
    dom.dictationInput.value = '';
}

function updateDictationProgress(totalWords) {
    if (state.currentDictationIndex >= 0 && totalWords > 0) {
        const progress = Math.round(((state.currentDictationIndex + 1) / totalWords) * 100);
        dom.dictationProgressBar.style.width = `${progress}%`;
        dom.dictationProgressText.textContent = `${state.currentDictationIndex + 1}/${totalWords}`;
    } else {
        dom.dictationProgressBar.style.width = '0%';
        dom.dictationProgressText.textContent = `0/${totalWords}`;
    }

    const floatingProgress = document.getElementById('floating-progress-text');
    if (floatingProgress) {
        floatingProgress.textContent = dom.dictationProgressText.textContent;
    }
}

function replayCurrentDictationWord() {
    if (state.currentDictationIndex < 0) return;
    if (!state.dictationWords || state.currentDictationIndex >= state.dictationWords.length) return;
    
    const currentWord = state.dictationWords[state.currentDictationIndex];
    audio.speakText(currentWord.word);
}

function gotoPrevDictationWord() {
    if (!state.dictationWords || state.dictationWords.length === 0) return;
    
    // 如果正在播放，先自動暫停
    if (!state.isDictationPaused) {
        state.setIsDictationPaused(true);
        clearTimeout(state.dictationTimeout);
        clearInterval(state.dictationInterval);
        audio.stopCurrentAudio();
        updatePauseButtonUI(); // 更新暫停按鈕UI
    }
    
    let newIndex = state.currentDictationIndex - 1;
    
    // 處理邊界情況
    if (newIndex < 0) {
        if (dom.loopMode.checked) {
            newIndex = state.dictationWords.length - 1; // 循環到最後一個
        } else {
            return; // 不允許超出邊界
        }
    }
    
    state.setCurrentDictationIndex(newIndex);
    playCurrentWordOnce();
    updateDictationProgress(state.dictationWords.length);
    updateNavigationButtonState();
    
    // 清空輸入和結果
    dom.dictationInput.value = '';
    dom.dictationResult.textContent = '';
    dom.dictationResult.className = '';
    dom.dictationWordDisplay.textContent = '';
}

function gotoNextDictationWord() {
    if (!state.dictationWords || state.dictationWords.length === 0) return;
    
    // 如果正在播放，先自動暫停
    if (!state.isDictationPaused) {
        state.setIsDictationPaused(true);
        clearTimeout(state.dictationTimeout);
        clearInterval(state.dictationInterval);
        audio.stopCurrentAudio();
        updatePauseButtonUI(); // 更新暫停按鈕UI
    }
    
    let newIndex = state.currentDictationIndex + 1;
    
    // 處理邊界情況
    if (newIndex >= state.dictationWords.length) {
        if (dom.loopMode.checked) {
            newIndex = 0; // 循環到第一個
        } else {
            return; // 不允許超出邊界
        }
    }
    
    state.setCurrentDictationIndex(newIndex);
    playCurrentWordOnce();
    updateDictationProgress(state.dictationWords.length);
    updateNavigationButtonState();
    
    // 清空輸入和結果
    dom.dictationInput.value = '';
    dom.dictationResult.textContent = '';
    dom.dictationResult.className = '';
    dom.dictationWordDisplay.textContent = '';
}

function playCurrentWordOnce() {
    // 單次播放當前單詞，用於手動切換時
    if (state.currentDictationIndex >= 0 && state.currentDictationIndex < state.dictationWords.length) {
        const currentWord = state.dictationWords[state.currentDictationIndex];
        audio.speakText(currentWord.word);
    }
}

function updateNavigationButtonState() {
    if (!state.dictationWords || state.dictationWords.length === 0) return;
    
    const isFirstWord = state.currentDictationIndex <= 0;
    const isLastWord = state.currentDictationIndex >= state.dictationWords.length - 1;
    const loopEnabled = dom.loopMode.checked;
    
    // 更新頁面內導航按鈕
    if (dom.prevDictationBtn) {
        // 在首位且無循環時禁用，否則啓用
        dom.prevDictationBtn.disabled = (isFirstWord && !loopEnabled);
    }
    if (dom.nextDictationBtn) {
        // 在末位且無循環時禁用，否則啓用
        dom.nextDictationBtn.disabled = (isLastWord && !loopEnabled);
    }
    
    // 更新浮動狀態欄按鈕
    const floatingPrevBtn = document.getElementById('floating-prev-btn');
    const floatingNextBtn = document.getElementById('floating-next-btn');
    
    if (floatingPrevBtn) {
        floatingPrevBtn.disabled = (isFirstWord && !loopEnabled);
    }
    if (floatingNextBtn) {
        floatingNextBtn.disabled = (isLastWord && !loopEnabled);
    }
    
    // 更新浮動狀態欄顯示
    updateFloatingStatus();
}

export function populateDictationBookSelector() {
    ui.createBookSelector(dom.dictationBookSelector, state.activeBookId);
}
