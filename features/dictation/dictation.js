import * as state from '../../modules/state.js';
import * as dom from '../../modules/dom.js';
import * as audio from '../../modules/audio.js';
import * as ui from '../../modules/ui.js';

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
    const wordsForDictation = getSelectedDictationWords();

    if (!wordsForDictation || wordsForDictation.length === 0) {
        alert('請先選擇一個包含單詞的單詞本！');
        return;
    }
    
    dom.startDictationBtn.disabled = true;
    dom.stopDictationBtn.disabled = false;
    dom.pauseDictationBtn.disabled = false;
    state.setIsDictationPaused(false);
    updatePauseButtonUI();
    
    dom.dictationPractice.classList.toggle('hidden', dom.listenOnlyMode.checked);
    dom.dictationProgressContainer.classList.remove('hidden');

    state.setCurrentDictationIndex(0);
    dom.dictationWordDisplay.textContent = '';
    dom.dictationInput.value = '';
    dom.dictationResult.textContent = '';
    dom.dictationResult.className = '';
    
    updateDictationProgress(wordsForDictation.length);
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
    dom.dictationPractice.classList.remove('hidden');
    dom.replayDictationBtn.style.display = 'none';
    dom.dictationWordDisplay.textContent = '已停止';
    
    state.setCurrentDictationIndex(-1);
    state.setIsDictationPaused(false);
    updatePauseButtonUI();

    const floatingControls = document.getElementById('floating-dictation-controls');
    if (floatingControls) {
        floatingControls.remove();
    }
}

function togglePauseDictation() {
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

    if (dom.pauseDictationBtn) dom.pauseDictationBtn.textContent = text;
    if (dom.replayDictationBtn) dom.replayDictationBtn.style.display = replayBtnDisplay;

    const floatingPauseBtn = document.getElementById('floating-pause-btn');
    if (floatingPauseBtn) floatingPauseBtn.textContent = text;
    
    const floatingReplayBtn = document.getElementById('floating-replay-btn');
    if (floatingReplayBtn) floatingReplayBtn.style.display = replayBtnDisplay;
}

function showFloatingControls() {
    if (document.getElementById('floating-dictation-controls')) return;

    const controlsContainer = document.createElement('div');
    controlsContainer.id = 'floating-dictation-controls';

    const pauseBtn = document.createElement('button');
    pauseBtn.id = 'floating-pause-btn';
    pauseBtn.textContent = state.isDictationPaused ? '繼續' : '暫停';
    pauseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        togglePauseDictation();
    });

    const stopBtn = document.createElement('button');
    stopBtn.id = 'floating-stop-btn';
    stopBtn.textContent = '停止';
    stopBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        stopDictation();
    });

    const progressSpan = document.createElement('span');
    progressSpan.id = 'floating-progress-text';
    progressSpan.textContent = dom.dictationProgressText.textContent;

    const replayBtn = document.createElement('button');
    replayBtn.id = 'floating-replay-btn';
    replayBtn.textContent = '重播';
    replayBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        replayCurrentDictationWord();
    });
    replayBtn.style.display = state.isDictationPaused ? 'inline-block' : 'none';

    controlsContainer.appendChild(document.createTextNode('默寫進行中: '));
    controlsContainer.appendChild(progressSpan);
    controlsContainer.appendChild(pauseBtn);
    controlsContainer.appendChild(replayBtn);
    controlsContainer.appendChild(stopBtn);
    document.body.appendChild(controlsContainer);
}

function playCurrentWord() {
    if (state.isDictationPaused) return;

    const wordsForDictation = getSelectedDictationWords();
    if (!wordsForDictation) {
        stopDictation();
        return;
    }

    if (state.currentDictationIndex >= wordsForDictation.length) {
        if (dom.loopMode.checked) {
            state.setCurrentDictationIndex(0);
        } else {
            stopDictation();
            dom.dictationWordDisplay.textContent = '默寫完成';
            return;
        }
    }

    const currentWord = wordsForDictation[state.currentDictationIndex];
    updateDictationProgress(wordsForDictation.length);
    
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
    const wordsForDictation = getSelectedDictationWords();
    if (!wordsForDictation || state.currentDictationIndex < 0 || state.currentDictationIndex >= wordsForDictation.length) {
        alert('請先開始默寫！');
        return;
    }
    
    const currentWord = wordsForDictation[state.currentDictationIndex];
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
    const wordsForDictation = getSelectedDictationWords();
    if (!wordsForDictation || state.currentDictationIndex >= wordsForDictation.length) return;
    
    const currentWord = wordsForDictation[state.currentDictationIndex];
    audio.speakText(currentWord.word);
}

export function populateDictationBookSelector() {
    ui.createBookSelector(dom.dictationBookSelector, state.activeBookId);
}