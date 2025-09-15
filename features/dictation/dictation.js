import * as state from '../../modules/state.js';
import * as dom from '../../modules/dom.js';
import * as audio from '../../modules/audio.js';
import * as ui from '../../modules/ui.js';
import * as platform from '../../modules/platform.js';

// =================================
// Dictation Feature
// =================================

/**
 * 初始化默写模式功能，绑定事件监听器。
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

    if (dom.shuffleMode.checked) {
        wordsForDictation = [...wordsForDictation].sort(() => Math.random() - 0.5);
    }
    
    state.setDictationWords(wordsForDictation);
    
    dom.startDictationBtn.disabled = true;
    dom.stopDictationBtn.disabled = false;
    dom.pauseDictationBtn.disabled = false;
    state.setIsDictationPaused(false);
    
    dom.dictationPractice.classList.toggle('hidden', dom.listenOnlyMode.checked);
    dom.dictationProgressContainer.classList.remove('hidden');

    // 关键：先设置索引，再更新UI
    state.setCurrentDictationIndex(0);
    dom.dictationWordDisplay.textContent = '';
    dom.dictationInput.value = '';
    dom.dictationResult.textContent = '';
    dom.dictationResult.className = '';
    
    // 现在更新按钮UI，此时currentDictationIndex已经是0了
    updatePauseButtonUI();
    updateDictationProgress(state.dictationWords.length);
    playCurrentWord();
    showFloatingControls();
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
    updatePauseButtonUI();

    // 清理浮动控制器和事件监听器
    const floatingControls = document.getElementById('floating-dictation-controls');
    if (floatingControls) {
        floatingControls.remove();
    }
    
    // 清理平台相关的事件监听器
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
}

function updatePauseButtonUI() {
    const text = state.isDictationPaused ? '繼續' : '暫停';
    const replayBtnDisplay = state.isDictationPaused ? 'inline-block' : 'none';
    // 导航按钮在默写开始后就显示（不管是否暂停）
    const navBtnDisplay = (state.currentDictationIndex >= 0 && state.dictationWords.length > 0) ? 'inline-block' : 'none';

    if (dom.pauseDictationBtn) dom.pauseDictationBtn.textContent = text;
    if (dom.replayDictationBtn) dom.replayDictationBtn.style.display = replayBtnDisplay;
    if (dom.prevDictationBtn) dom.prevDictationBtn.style.display = navBtnDisplay;
    if (dom.nextDictationBtn) dom.nextDictationBtn.style.display = navBtnDisplay;

    const floatingPauseBtn = document.getElementById('floating-pause-btn');
    if (floatingPauseBtn) floatingPauseBtn.textContent = text;
    
    const floatingReplayBtn = document.getElementById('floating-replay-btn');
    if (floatingReplayBtn) floatingReplayBtn.style.display = replayBtnDisplay;

    // 更新按钮状态
    updateNavigationButtonState();
}

function showFloatingControls() {
    if (document.getElementById('floating-dictation-controls')) return;

    // 创建增强版状态栏
    const statusBar = createEnhancedStatusBar();
    document.body.appendChild(statusBar);
    
    // 初始化平台特定的优化
    initPlatformOptimizations(statusBar);
    
    // 监听页面可见性变化
    setupVisibilityHandling();
}

/**
 * 创建增强版浮动状态栏
 */
function createEnhancedStatusBar() {
    const statusBar = document.createElement('div');
    statusBar.id = 'floating-dictation-controls';
    statusBar.className = 'enhanced-floating-controls';
    
    // 创建主控制区域
    const mainControls = createMainControls();
    statusBar.appendChild(mainControls);
    
    // 创建展开面板
    const expandPanel = createExpandPanel();
    statusBar.appendChild(expandPanel);
    
    return statusBar;
}

/**
 * 创建主控制区域（不展开时显示）
 */
function createMainControls() {
    const container = document.createElement('div');
    container.className = 'main-controls';
    
    // 上一个按钮（左侧，大按钮）
    const prevBtn = document.createElement('button');
    prevBtn.id = 'floating-prev-btn';
    prevBtn.className = 'control-btn prev-btn';
    prevBtn.innerHTML = '⬅';
    prevBtn.title = '上一个单词';
    prevBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        gotoPrevDictationWord();
    });
    
    // 中间信息区域
    const infoArea = document.createElement('div');
    infoArea.className = 'info-area';
    infoArea.addEventListener('click', toggleExpandPanel);
    
    const progressSpan = document.createElement('span');
    progressSpan.id = 'floating-progress-text';
    progressSpan.className = 'progress-text';
    progressSpan.textContent = dom.dictationProgressText.textContent;
    
    const expandIcon = document.createElement('span');
    expandIcon.className = 'expand-icon';
    expandIcon.innerHTML = '▲';
    
    infoArea.appendChild(progressSpan);
    infoArea.appendChild(expandIcon);
    
    // 暂停/继续按钮（中间）
    const pauseBtn = document.createElement('button');
    pauseBtn.id = 'floating-pause-btn';
    pauseBtn.className = 'control-btn pause-btn';
    pauseBtn.textContent = state.isDictationPaused ? '继续' : '暂停';
    pauseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        togglePauseDictation();
    });
    
    // 下一个按钮（右侧，大按钮）
    const nextBtn = document.createElement('button');
    nextBtn.id = 'floating-next-btn';
    nextBtn.className = 'control-btn next-btn';
    nextBtn.innerHTML = '➡';
    nextBtn.title = '下一个单词';
    nextBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        gotoNextDictationWord();
    });
    
    container.appendChild(prevBtn);
    container.appendChild(infoArea);
    container.appendChild(pauseBtn);
    container.appendChild(nextBtn);
    
    return container;
}

/**
 * 创建展开面板
 */
function createExpandPanel() {
    const panel = document.createElement('div');
    panel.id = 'expand-panel';
    panel.className = 'expand-panel';
    panel.style.display = 'none';
    
    // 面板头部
    const header = document.createElement('div');
    header.className = 'panel-header';
    
    const title = document.createElement('h3');
    title.textContent = '单词列表';
    
    const closeBtn = document.createElement('button');
    closeBtn.className = 'close-btn';
    closeBtn.innerHTML = '×';
    closeBtn.addEventListener('click', () => toggleExpandPanel());
    
    // 控制选项
    const controls = document.createElement('div');
    controls.className = 'panel-controls';
    
    const showInfoToggle = document.createElement('label');
    showInfoToggle.className = 'toggle-label';
    showInfoToggle.innerHTML = `
        <input type="checkbox" id="show-word-info" checked>
        <span>显示单词信息</span>
    `;
    
    controls.appendChild(showInfoToggle);
    
    header.appendChild(title);
    header.appendChild(controls);
    header.appendChild(closeBtn);
    
    // 单词列表容器
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
 * 切换展开面板显示状态
 */
function toggleExpandPanel() {
    const panel = document.getElementById('expand-panel');
    const expandIcon = document.querySelector('.expand-icon');
    const statusBar = document.getElementById('floating-dictation-controls');
    
    if (!panel || !expandIcon || !statusBar) return;
    
    const isExpanded = panel.style.display !== 'none';
    
    if (isExpanded) {
        // 收起面板
        panel.style.display = 'none';
        expandIcon.innerHTML = '▲';
        statusBar.classList.remove('expanded');
    } else {
        // 展开面板
        panel.style.display = 'block';
        expandIcon.innerHTML = '▼';
        statusBar.classList.add('expanded');
        
        // 更新单词列表
        updateFloatingWordList();
        
        // 设置面板高度为屏幕的1/2
        const viewportHeight = platform.getViewportHeight();
        panel.style.height = `${viewportHeight * 0.5}px`;
    }
}

/**
 * 更新浮动单词列表
 */
function updateFloatingWordList() {
    const wordList = document.getElementById('floating-word-list');
    const showInfoCheckbox = document.getElementById('show-word-info');
    
    if (!wordList || !state.dictationWords) return;
    
    const showInfo = showInfoCheckbox ? showInfoCheckbox.checked : true;
    
    wordList.innerHTML = '';
    
    state.dictationWords.forEach((word, index) => {
        const wordItem = document.createElement('div');
        wordItem.className = `word-item ${index === state.currentDictationIndex ? 'current' : ''}`;
        wordItem.dataset.index = index;
        
        const wordText = document.createElement('div');
        wordText.className = 'word-text';
        wordText.textContent = word.word;
        
        wordItem.appendChild(wordText);
        
        if (showInfo && word.meaning) {
            const wordMeaning = document.createElement('div');
            wordMeaning.className = 'word-meaning';
            wordMeaning.textContent = word.meaning;
            wordItem.appendChild(wordMeaning);
        }
        
        // 点击跳转到该单词
        wordItem.addEventListener('click', () => {
            jumpToWord(index);
        });
        
        wordList.appendChild(wordItem);
    });
    
    // 滚动到当前单词
    scrollToCurrentWord();
}

/**
 * 跳转到指定单词
 */
function jumpToWord(index) {
    if (index < 0 || index >= state.dictationWords.length) return;
    
    // 暂停当前播放
    if (!state.isDictationPaused) {
        state.setIsDictationPaused(true);
        clearTimeout(state.dictationTimeout);
        clearInterval(state.dictationInterval);
        audio.stopCurrentAudio();
    }
    
    // 跳转到指定单词
    state.setCurrentDictationIndex(index);
    playCurrentWordOnce();
    updateDictationProgress(state.dictationWords.length);
    updatePauseButtonUI();
    updateFloatingWordList();
    
    // 清空输入和结果
    if (dom.dictationInput) dom.dictationInput.value = '';
    if (dom.dictationResult) {
        dom.dictationResult.textContent = '';
        dom.dictationResult.className = '';
    }
    if (dom.dictationWordDisplay) dom.dictationWordDisplay.textContent = '';
}

/**
 * 滚动到当前单词
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
 * 初始化平台特定优化
 */
function initPlatformOptimizations(statusBar) {
    // iOS特殊处理
    if (platform.detect.isIOS) {
        // 禁用弹性滚动
        const wordList = statusBar.querySelector('.word-list');
        if (wordList) {
            platform.disableBounceScrolling(wordList);
        }
        
        // 触摸优化
        const touchTargetSize = platform.getOptimalTouchTarget();
        statusBar.style.setProperty('--touch-target-size', `${touchTargetSize}px`);
    }
    
    // 微信浏览器优化
    if (platform.detect.isWeixin) {
        platform.initWeixinAudio(() => {
            console.log('微信音频已初始化');
        });
    }
}

/**
 * 设置页面可见性处理
 */
function setupVisibilityHandling() {
    const removeListener = platform.onVisibilityChange((isVisible) => {
        if (!isVisible) {
            // 页面不可见时，继续播放但更新状态栏
            updateFloatingStatus();
        } else {
            // 页面可见时，恢复状态栏显示
            updateFloatingStatus();
        }
    });
    
    // 保存移除监听器的函数，在停止默写时调用
    if (!window._dictationCleanups) window._dictationCleanups = [];
    window._dictationCleanups.push(removeListener);
}

/**
 * 更新浮动状态栏信息
 */
function updateFloatingStatus() {
    const progressText = document.getElementById('floating-progress-text');
    const pauseBtn = document.getElementById('floating-pause-btn');
    
    if (progressText && dom.dictationProgressText) {
        progressText.textContent = dom.dictationProgressText.textContent;
    }
    
    if (pauseBtn) {
        pauseBtn.textContent = state.isDictationPaused ? '继续' : '暂停';
    }
    
    // 更新单词列表（如果展开）
    const panel = document.getElementById('expand-panel');
    if (panel && panel.style.display !== 'none') {
        updateFloatingWordList();
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
                if (dom.readMeaning.checked && currentWord.meaning) {
                    setTimeout(() => audio.speakText(currentWord.meaning, 'zh-TW', 0, null, scheduleNextWord), 500);
                } else {
                    scheduleNextWord();
                }
            }
        };
        audio.speakText(currentWord.word, 'en-US', 0, null, afterWordPlayed);
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
    
    // 如果正在播放，先自动暂停
    if (!state.isDictationPaused) {
        state.setIsDictationPaused(true);
        clearTimeout(state.dictationTimeout);
        clearInterval(state.dictationInterval);
        audio.stopCurrentAudio();
        updatePauseButtonUI(); // 更新暂停按钮UI
    }
    
    let newIndex = state.currentDictationIndex - 1;
    
    // 处理边界情况
    if (newIndex < 0) {
        if (dom.loopMode.checked) {
            newIndex = state.dictationWords.length - 1; // 循环到最后一个
        } else {
            return; // 不允许超出边界
        }
    }
    
    state.setCurrentDictationIndex(newIndex);
    playCurrentWordOnce();
    updateDictationProgress(state.dictationWords.length);
    updateNavigationButtonState();
    
    // 清空输入和结果
    dom.dictationInput.value = '';
    dom.dictationResult.textContent = '';
    dom.dictationResult.className = '';
    dom.dictationWordDisplay.textContent = '';
}

function gotoNextDictationWord() {
    if (!state.dictationWords || state.dictationWords.length === 0) return;
    
    // 如果正在播放，先自动暂停
    if (!state.isDictationPaused) {
        state.setIsDictationPaused(true);
        clearTimeout(state.dictationTimeout);
        clearInterval(state.dictationInterval);
        audio.stopCurrentAudio();
        updatePauseButtonUI(); // 更新暂停按钮UI
    }
    
    let newIndex = state.currentDictationIndex + 1;
    
    // 处理边界情况
    if (newIndex >= state.dictationWords.length) {
        if (dom.loopMode.checked) {
            newIndex = 0; // 循环到第一个
        } else {
            return; // 不允许超出边界
        }
    }
    
    state.setCurrentDictationIndex(newIndex);
    playCurrentWordOnce();
    updateDictationProgress(state.dictationWords.length);
    updateNavigationButtonState();
    
    // 清空输入和结果
    dom.dictationInput.value = '';
    dom.dictationResult.textContent = '';
    dom.dictationResult.className = '';
    dom.dictationWordDisplay.textContent = '';
}

function playCurrentWordOnce() {
    // 单次播放当前单词，用于手动切换时
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
    
    // 更新页面内导航按钮
    if (dom.prevDictationBtn) {
        // 在首位且无循环时禁用，否则启用
        dom.prevDictationBtn.disabled = (isFirstWord && !loopEnabled);
    }
    if (dom.nextDictationBtn) {
        // 在末位且无循环时禁用，否则启用
        dom.nextDictationBtn.disabled = (isLastWord && !loopEnabled);
    }
    
    // 更新浮动状态栏按钮
    const floatingPrevBtn = document.getElementById('floating-prev-btn');
    const floatingNextBtn = document.getElementById('floating-next-btn');
    
    if (floatingPrevBtn) {
        floatingPrevBtn.disabled = (isFirstWord && !loopEnabled);
    }
    if (floatingNextBtn) {
        floatingNextBtn.disabled = (isLastWord && !loopEnabled);
    }
    
    // 更新浮动状态栏显示
    updateFloatingStatus();
}

export function populateDictationBookSelector() {
    ui.createBookSelector(dom.dictationBookSelector, state.activeBookId);
}