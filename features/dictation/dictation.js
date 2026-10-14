import * as state from '../../modules/state.js';
import * as dom from '../../modules/dom.js';
import * as audio from '../../modules/audio.js';
import * as ui from '../../modules/ui.js';
import * as platform from '../../modules/platform.js';
import { initDictationGrader } from './dictation-grader.js';
import { t, formatDateTime } from '../../modules/i18n.js';

// =================================
// Dictation Feature
// =================================

/** 產生統一線性圖標（與 index.html 的 sprite 共用） */
function iconSvg(id, extraClass = '') {
    return `<svg class="icon ${extraClass}" aria-hidden="true"><use href="#ic-${id}"/></svg>`;
}

/** 把秒數格式化為 m:ss */
function formatDuration(ms) {
    const totalSeconds = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * 初始化默寫模式功能，綁定事件監聽器。
 */
export function initDictation() {
    dom.startDictationBtn.addEventListener('click', startDictation);
    dom.stopDictationBtn.addEventListener('click', () => stopDictation());
    dom.pauseDictationBtn.addEventListener('click', togglePauseDictation);
    dom.replayDictationBtn.addEventListener('click', replayCurrentDictationWord);
    dom.prevDictationBtn.addEventListener('click', gotoPrevDictationWord);
    dom.nextDictationBtn.addEventListener('click', gotoNextDictationWord);
    dom.checkDictationBtn.addEventListener('click', checkDictation);
    document.addEventListener('bdc:locale-change', () => {
        updatePauseButtonUI();
        updateFloatingStatus();
        updateFloatingWordList();
        updateFloatingCardTexts();
        updatePlayerSummary();
    });
    dom.listenOnlyMode?.addEventListener('change', syncDictationMode);
    dom.dictationTypedMode?.addEventListener('change', syncDictationMode);
    dom.dictationAgainBtn?.addEventListener('click', startDictation);
    dom.dictationBackSettingsBtn?.addEventListener('click', showDictationSetup);
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

/** 紙上聽寫 / 跟打練習：同步練習區塊顯示與設定 */
function syncDictationMode() {
    const paperMode = !!dom.listenOnlyMode?.checked;
    if (dom.dictationPractice) {
        dom.dictationPractice.classList.toggle('hidden', paperMode);
    }
    saveDictationSettings();
}

/**
 * 加載默寫設置到界面
 */
function loadDictationSettings() {
    if (dom.repeatTimes) dom.repeatTimes.value = state.dictationSettings.repeatTimes;
    if (dom.wordInterval) dom.wordInterval.value = state.dictationSettings.wordInterval;
    if (dom.loopMode) dom.loopMode.checked = state.dictationSettings.loopMode;
    if (dom.shuffleMode) dom.shuffleMode.checked = state.dictationSettings.shuffleMode;
    const paperMode = state.dictationSettings.listenOnlyMode !== false;
    if (dom.listenOnlyMode) dom.listenOnlyMode.checked = paperMode;
    if (dom.dictationTypedMode) dom.dictationTypedMode.checked = !paperMode;
    if (dom.dictationPractice) dom.dictationPractice.classList.toggle('hidden', paperMode);
    applyChineseVoiceSelection(state.dictationSettings.readChineseVoice || 'none');
    updatePlayerSummary();
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
    const fields = getFloatingListFields();
    const settings = {
        repeatTimes: parseInt(dom.repeatTimes?.value || '2'),
        wordInterval: parseInt(dom.wordInterval?.value || '3'),
        readChineseVoice: chineseVoice,
        loopMode: dom.loopMode?.checked || false,
        shuffleMode: dom.shuffleMode?.checked || false,
        listenOnlyMode: !!dom.listenOnlyMode?.checked,
        floatListFields: { ...fields },
        // 舊欄位保留給既有資料／同步比對：只要顯示單詞、音標或釋義就算「顯示單詞資訊」
        showWordInfo: !!(fields.word || fields.phonetic || fields.meaning)
    };
    
    state.setDictationSettings(settings);
    state.saveDictationSettings();
    updatePlayerSummary();
}

/**
 * 檢查並恢復默寫會話
 */
function checkAndRestoreDictationSession() {
    const session = state.loadDictationSession();
    if (!session) return;
    
    // 顯示恢復提示
    showSessionRestorePrompt(session).catch(() => { /* 對話框本身不會 reject，這裡僅防禦 */ });
}

/**
 * 顯示會話恢復提示（用站內對話框，取代原生 confirm）
 */
async function showSessionRestorePrompt(session) {
    const startTime = formatDateTime(session.startTime);
    const message = t('dictation.restoreSession', {
        startTime,
        current: session.currentIndex + 1,
        total: session.words.length
    });

    const confirmed = await ui.confirmAction({
        title: t('dictation.restoreTitle'),
        message,
        confirmLabel: t('dictation.restoreConfirm'),
        cancelLabel: t('dictation.restoreDiscard')
    });

    if (confirmed) {
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
        dom.dictationPractice.classList.toggle('hidden', !!dom.listenOnlyMode?.checked);
        dom.dictationProgressContainer.classList.remove('hidden');
        // 使用者可能停在別的頁面，先切到聽寫頁再顯示播放器
        document.getElementById('dictation-btn')?.click();
        showPlayerView();
        bringPlayerIntoView();

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
        ui.displayMessage(t('dictation.selectBookAlert'), 'warning');
        dom.dictationBookSelector?.scrollIntoView({ block: 'center' });
        return;
    }

    // 保存當前設置
    saveDictationSettings();

    if (dom.shuffleMode?.checked) {
        wordsForDictation = [...wordsForDictation].sort(() => Math.random() - 0.5);
    }
    
    state.setDictationWords(wordsForDictation);
    
    // 激活會話狀態
    state.setDictationSessionActive(true);
    state.setDictationStartTime(Date.now());
    
    dom.startDictationBtn.disabled = true;
    dom.stopDictationBtn.disabled = false;
    dom.pauseDictationBtn.disabled = false;
    if (dom.replayDictationBtn) dom.replayDictationBtn.disabled = false;
    state.setIsDictationPaused(false);
    
    dom.dictationPractice.classList.toggle('hidden', !!dom.listenOnlyMode?.checked);
    dom.dictationProgressContainer.classList.remove('hidden');

    // 關鍵：先設置索引，再更新UI
    state.setCurrentDictationIndex(0);
    dom.dictationWordDisplay.textContent = '';
    dom.dictationInput.value = '';
    dom.dictationResult.textContent = '';
    dom.dictationResult.className = '';

    // 切換到播放器視圖
    showPlayerView();
    // 設定卡很長，開始後把播放器帶到畫面上方，讓進度與控制項立即可見
    bringPlayerIntoView();
    
    // 現在更新按鈕UI，此時currentDictationIndex已經是0了
    updatePauseButtonUI();
    updateDictationProgress(state.dictationWords.length);
    playCurrentWord();
    showFloatingControls();
    
    // 保存會話狀態
    state.saveDictationSession();
}

/** 開始前 / 結束後的設定視圖 */
function showDictationSetup() {
    dom.dictationPlayer?.classList.add('hidden');
    dom.dictationComplete?.classList.add('hidden');
    dom.dictationSettingsCard?.classList.remove('hidden');
    document.querySelector('.dictation-container')?.classList.remove('is-running', 'is-complete');
    if (dom.dictationProgressContainer) dom.dictationProgressContainer.classList.add('hidden');
    updatePlayerSummary();
}

/** 訓練中的播放器視圖 */
function showPlayerView() {
    dom.dictationPlayer?.classList.remove('hidden');
    dom.dictationComplete?.classList.add('hidden');
    dom.dictationSettingsCard?.classList.remove('hidden');
    document.querySelector('.dictation-container')?.classList.remove('is-complete');
    document.querySelector('.dictation-container')?.classList.add('is-running');
    if (dom.dictationStateBadge) dom.dictationStateBadge.classList.remove('is-paused');
    updatePlayerSummary();
}

/** 把播放器捲到畫面上方（手機上設定卡很長，不捲會看不到進度與控制項） */
function bringPlayerIntoView() {
    if (!dom.dictationPlayer || typeof dom.dictationPlayer.scrollIntoView !== 'function') return;
    try {
        dom.dictationPlayer.scrollIntoView({ block: 'start' });
    } catch (_) {
        /* 舊環境不支援選項物件時忽略 */
    }
}

/**
 * 結束默寫。
 * @param {{completed?: boolean}} [options] completed 為 true 表示所有單詞已播放完畢
 */
function stopDictation(options = {}) {
    const completed = options && options.completed === true;

    state.setIsDictationPaused(true);
    audio.stopCurrentAudio();
    clearTimeout(state.dictationTimeout);
    clearInterval(state.dictationInterval);
    state.setDictationInterval(null);

    dom.startDictationBtn.disabled = false;
    dom.stopDictationBtn.disabled = true;
    dom.pauseDictationBtn.disabled = true;
    if (dom.replayDictationBtn) dom.replayDictationBtn.disabled = true;
    if (dom.prevDictationBtn) dom.prevDictationBtn.disabled = true;
    if (dom.nextDictationBtn) dom.nextDictationBtn.disabled = true;
    dom.dictationProgressContainer.classList.add('hidden');
    dom.dictationPractice.classList.toggle('hidden', !!dom.listenOnlyMode?.checked);
    dom.dictationWordDisplay.textContent = completed ? t('dictation.completed') : t('dictation.stopped');

    state.setCurrentDictationIndex(-1);
    state.setIsDictationPaused(false);
    
    // 停用會話狀態並清理持久化數據
    state.setDictationSessionActive(false);
    state.clearDictationSession();
    
    updatePauseButtonUI();
    renderDictationOutcome(completed);

    // 清理浮動控制器和事件監聽器
    teardownFloatingControls();
    
    // 清理平臺相關的事件監聽器
    if (window._dictationCleanups) {
        window._dictationCleanups.forEach(cleanup => {
            if (typeof cleanup === 'function') cleanup();
        });
        window._dictationCleanups = [];
    }
}

/** 結束後：完成卡片（紙上聽寫重點回饋）或回到設定 */
function renderDictationOutcome(completed) {
    const container = document.querySelector('.dictation-container');
    container?.classList.remove('is-running');
    container?.classList.toggle('is-complete', !!completed);
    dom.dictationPlayer?.classList.add('hidden');
    dom.dictationSettingsCard?.classList.remove('hidden');

    if (!completed) {
        dom.dictationComplete?.classList.add('hidden');
        return;
    }

    const words = state.dictationWords || [];
    const total = words.length;
    const elapsedMs = state.dictationStartTime ? (Date.now() - state.dictationStartTime) : 0;
    if (dom.completeWords) dom.completeWords.textContent = String(total);
    if (dom.completeRepeat) dom.completeRepeat.textContent = String(parseInt(dom.repeatTimes?.value || '2', 10) || 2);
    if (dom.completeTime) dom.completeTime.textContent = formatDuration(elapsedMs);
    if (dom.dictationCompleteDesc) {
        dom.dictationCompleteDesc.textContent = t('dictation.doneDescCount', { count: total });
    }
    dom.dictationComplete?.classList.remove('hidden');
}

/** 播放器上的設定摘要（每詞次數 / 間隔 / 朗讀內容） */
function updatePlayerSummary() {
    if (!dom.dictationSummary) return;
    const settings = state.dictationSettings || {};
    const chips = [
        t('dictation.summaryRepeat', { count: settings.repeatTimes || 2 }),
        t('dictation.summaryInterval', { seconds: settings.wordInterval || 3 })
    ];
    const chineseVoice = settings.readChineseVoice || 'none';
    if (chineseVoice === 'chinese') chips.push(t('dictation.summaryMandarin'));
    if (chineseVoice === 'cantonese') chips.push(t('dictation.summaryCantonese'));
    if (settings.loopMode) chips.push(t('dictation.summaryLoop'));
    if (settings.shuffleMode) chips.push(t('dictation.summaryShuffle'));
    dom.dictationSummary.innerHTML = chips
        .map(text => `<span class="chip">${text}</span>`)
        .join('');
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
    const paused = state.isDictationPaused;
    const text = paused ? t('dictation.resume') : t('dictation.pause');
    const hasSession = state.currentDictationIndex >= 0 && state.dictationWords.length > 0;

    // 播放器主按鈕：只更新文字與圖標，保留 DOM 結構
    if (dom.pauseDictationLabel) dom.pauseDictationLabel.textContent = text;
    if (dom.pauseDictationBtn) {
        const use = dom.pauseDictationBtn.querySelector('use');
        if (use) use.setAttribute('href', paused ? '#ic-play' : '#ic-pause');
        dom.pauseDictationBtn.setAttribute('aria-label', text);
    }
    if (dom.replayDictationBtn) dom.replayDictationBtn.disabled = !hasSession;
    if (dom.prevDictationBtn) dom.prevDictationBtn.disabled = !hasSession;
    if (dom.nextDictationBtn) dom.nextDictationBtn.disabled = !hasSession;

    // 播放器狀態標籤
    if (dom.dictationStateBadge) {
        dom.dictationStateBadge.textContent = paused ? t('dictation.statePaused') : t('dictation.statePlaying');
        dom.dictationStateBadge.classList.toggle('is-paused', paused);
    }
    if (dom.dictationPlayer) dom.dictationPlayer.classList.toggle('is-paused', paused);
    if (dom.dictationStageTitle) {
        dom.dictationStageTitle.textContent = paused
            ? t('dictation.stagePaused')
            : t('dictation.stageListening');
    }

    const floatingPauseBtn = document.getElementById('floating-pause-btn');
    if (floatingPauseBtn) {
        const label = floatingPauseBtn.querySelector('span');
        if (label) label.textContent = text; else floatingPauseBtn.textContent = text;
        const use = floatingPauseBtn.querySelector('use');
        if (use) use.setAttribute('href', paused ? '#ic-play' : '#ic-pause');
    }

    // 更新按鈕狀態
    updateNavigationButtonState();
}

function showFloatingControls() {
    if (document.getElementById('floating-dictation-controls')) return;

    // 創建增強版狀態欄
    const statusBar = createEnhancedStatusBar();
    document.body.appendChild(statusBar);
    document.body.classList.add('has-floating-player');
    
    // 初始化平臺特定的優化
    initPlatformOptimizations(statusBar);
    
    // 監聽頁面可見性變化
    setupVisibilityHandling();

    // 聽寫進行中於所有頁面常駐：PC 是可拖曳／收合的小卡片，行動端是置中膠囊
    setupFloatingCard(statusBar);
}

/* ==================== 懸浮播放器：PC 卡片模式 ==================== */

const FLOAT_CARD_MEDIA = '(min-width: 1024px)';
const FLOAT_CARD_MARGIN = 12;
const FLOAT_POS_KEY = 'pen_dictation_float_pos';
const FLOAT_COLLAPSED_KEY = 'pen_dictation_float_collapsed';

/** 目前是否為 PC 卡片模式 */
function isFloatingCardMode() {
    return typeof window.matchMedia === 'function' && window.matchMedia(FLOAT_CARD_MEDIA).matches;
}

function readFloatingState(key) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
    } catch (_) {
        return null;
    }
}

function writeFloatingState(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch (_) {
        // 私密模式等無法寫入時忽略，不影響本次操作
    }
}

/** 依模式切換卡片樣式與位置；非卡片模式清掉行內定位，回到置中膠囊 */
function syncFloatingLayout(statusBar) {
    const card = isFloatingCardMode();
    statusBar.classList.toggle('is-card', card);

    if (!card) {
        statusBar.classList.remove('is-collapsed');
        ['left', 'top', 'right', 'bottom', 'transform'].forEach((prop) => statusBar.style.removeProperty(prop));
        return;
    }

    statusBar.classList.toggle('is-collapsed', readFloatingState(FLOAT_COLLAPSED_KEY) === true);
    updateFloatingCollapseUI(statusBar);
    applyFloatingPosition(statusBar, readFloatingState(FLOAT_POS_KEY));
}

/** 套用位置：只把顯示位置夾回可視範圍，不覆寫使用者儲存的位置 */
function applyFloatingPosition(statusBar, position) {
    if (!isFloatingCardMode() || !position) return;

    const rect = statusBar.getBoundingClientRect();
    const maxLeft = Math.max(FLOAT_CARD_MARGIN, window.innerWidth - rect.width - FLOAT_CARD_MARGIN);
    const maxTop = Math.max(FLOAT_CARD_MARGIN, window.innerHeight - rect.height - FLOAT_CARD_MARGIN);

    statusBar.style.left = `${Math.min(Math.max(FLOAT_CARD_MARGIN, position.left), maxLeft)}px`;
    statusBar.style.top = `${Math.min(Math.max(FLOAT_CARD_MARGIN, position.top), maxTop)}px`;
    statusBar.style.right = 'auto';
    statusBar.style.bottom = 'auto';
    statusBar.style.transform = 'none';
}

/** 僅在使用者拖曳結束時記錄位置，避免視窗暫時變小時把位置存壞 */
function rememberFloatingPosition(statusBar) {
    if (!isFloatingCardMode()) return;
    const rect = statusBar.getBoundingClientRect();
    writeFloatingState(FLOAT_POS_KEY, { left: Math.round(rect.left), top: Math.round(rect.top) });
}

/** 拖曳：卡片模式抓標題列，收合成膠囊時整張卡片皆可拖 */
function enableFloatingDrag(statusBar) {
    let dragging = false;
    let pointerId = null;
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;

    const isHandle = (target) => {
        if (!target || !target.closest || target.closest('button')) return false;
        if (target.closest('.fp-header')) return true;
        return statusBar.classList.contains('is-collapsed') && !target.closest('.info-area');
    };

    const onPointerDown = (event) => {
        if (!isFloatingCardMode() || event.button > 0 || !isHandle(event.target)) return;
        const rect = statusBar.getBoundingClientRect();
        dragging = true;
        pointerId = event.pointerId;
        startX = event.clientX;
        startY = event.clientY;
        originLeft = rect.left;
        originTop = rect.top;
        statusBar.style.transition = 'none';
        try {
            statusBar.setPointerCapture(pointerId);
        } catch (_) {
            // 合成事件或指標已失效時忽略
        }
        event.preventDefault();
    };

    const onPointerMove = (event) => {
        if (!dragging || event.pointerId !== pointerId) return;
        applyFloatingPosition(statusBar, {
            left: originLeft + (event.clientX - startX),
            top: originTop + (event.clientY - startY)
        });
    };

    const endDrag = (event) => {
        if (!dragging || (event && event.pointerId !== pointerId)) return;
        dragging = false;
        statusBar.style.removeProperty('transition');
        try {
            statusBar.releasePointerCapture(pointerId);
        } catch (_) {
            // 未取得捕獲時忽略
        }
        pointerId = null;
        rememberFloatingPosition(statusBar);
    };

    statusBar.addEventListener('pointerdown', onPointerDown);
    statusBar.addEventListener('pointermove', onPointerMove);
    statusBar.addEventListener('pointerup', endDrag);
    statusBar.addEventListener('pointercancel', endDrag);
}

/** 收合／展開卡片 */
function toggleFloatingCollapsed(statusBar) {
    const collapsed = !statusBar.classList.contains('is-collapsed');
    statusBar.classList.toggle('is-collapsed', collapsed);
    writeFloatingState(FLOAT_COLLAPSED_KEY, collapsed);

    // 收合時先把單詞列表收起來，避免面板與膠囊同時存在
    if (collapsed) {
        const panel = document.getElementById('expand-panel');
        if (panel && panel.style.display !== 'none') {
            panel.style.display = 'none';
            statusBar.classList.remove('expanded');
            updateExpandIcon(false);
        }
    }

    updateFloatingCollapseUI(statusBar);
    applyFloatingPosition(statusBar, readFloatingState(FLOAT_POS_KEY));
}

/** 收合鍵的圖示與無障礙文字 */
function updateFloatingCollapseUI(statusBar) {
    const bar = statusBar || document.getElementById('floating-dictation-controls');
    if (!bar) return;
    const button = bar.querySelector('#floating-minimize-btn');
    if (!button) return;

    const collapsed = bar.classList.contains('is-collapsed');
    button.textContent = collapsed ? '⤢' : '—';
    const label = collapsed ? t('dictation.expandPlayer') : t('dictation.collapsePlayer');
    button.title = label;
    button.setAttribute('aria-label', label);
}

/** 切換介面語言時更新卡片文字 */
function updateFloatingCardTexts() {
    const statusBar = document.getElementById('floating-dictation-controls');
    if (!statusBar) return;
    const title = statusBar.querySelector('.fp-title');
    if (title) title.textContent = t('dictation.title');
    const homeBtn = statusBar.querySelector('#floating-home-btn');
    if (homeBtn) {
        homeBtn.title = t('dictation.backToDictation');
        homeBtn.setAttribute('aria-label', t('dictation.backToDictation'));
    }
    updateFloatingCollapseUI(statusBar);
}

function setupFloatingCard(statusBar) {
    enableFloatingDrag(statusBar);
    setupFloatingHomeButton(statusBar);
    syncFloatingLayout(statusBar);

    const onViewportChange = () => syncFloatingLayout(statusBar);
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('orientationchange', onViewportChange);

    if (!window._dictationCleanups) window._dictationCleanups = [];
    window._dictationCleanups.push(() => {
        window.removeEventListener('resize', onViewportChange);
        window.removeEventListener('orientationchange', onViewportChange);
    });
}

function teardownFloatingControls() {
    document.body.classList.remove('has-floating-player');
    const floatingControls = document.getElementById('floating-dictation-controls');
    if (floatingControls) {
        floatingControls.remove();
    }
}

/**
 * 創建增強版浮動狀態欄
 */
function createEnhancedStatusBar() {
    const statusBar = document.createElement('div');
    statusBar.id = 'floating-dictation-controls';
    statusBar.className = 'enhanced-floating-controls';
    
    // 標題列（僅 PC 卡片模式顯示，供拖曳與收合）
    statusBar.appendChild(createCardHeader());
    
    // 創建主控制區域
    const mainControls = createMainControls();
    statusBar.appendChild(mainControls);
    
    // 創建展開面板
    const expandPanel = createExpandPanel();
    statusBar.appendChild(expandPanel);
    
    return statusBar;
}

/**
 * 創建卡片標題列（拖曳把手 + 標題 + 收合鍵）
 */
function createCardHeader() {
    const header = document.createElement('div');
    header.className = 'fp-header';
    
    const grip = document.createElement('span');
    grip.className = 'fp-grip';
    grip.textContent = '⠿';
    grip.setAttribute('aria-hidden', 'true');
    
    const title = document.createElement('span');
    title.className = 'fp-title';
    title.textContent = t('dictation.title');
    
    // 返回聽寫頁：只在不在聽寫模式頁面時出現（見 setupFloatingHomeButton）
    const homeBtn = document.createElement('button');
    homeBtn.id = 'floating-home-btn';
    homeBtn.type = 'button';
    homeBtn.className = 'fp-home';
    homeBtn.innerHTML = iconSvg('pen');
    homeBtn.hidden = true;
    homeBtn.title = t('dictation.backToDictation');
    homeBtn.setAttribute('aria-label', t('dictation.backToDictation'));
    homeBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        goToDictationSection();
    });
    
    const minimizeBtn = document.createElement('button');
    minimizeBtn.id = 'floating-minimize-btn';
    minimizeBtn.type = 'button';
    minimizeBtn.className = 'fp-minimize';
    minimizeBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        const statusBar = document.getElementById('floating-dictation-controls');
        if (statusBar) toggleFloatingCollapsed(statusBar);
    });
    
    header.appendChild(grip);
    header.appendChild(title);
    header.appendChild(homeBtn);
    header.appendChild(minimizeBtn);
    
    return header;
}

/** 切換到聽寫模式頁面（沿用主導覽按鈕，行為與側邊／底部導覽一致） */
function goToDictationSection() {
    const navBtn = document.getElementById('dictation-btn');
    if (navBtn) {
        navBtn.click();
    } else {
        dom.dictationSection?.classList.add('active');
    }
    // 回到聽寫頁後把播放器帶進視野（手機上設定卡很長）
    requestAnimationFrame(() => bringPlayerIntoView());
}

/**
 * 「返回聽寫頁」按鈕的可見性。
 * 聽寫進行中播放器會在每個頁面常駐，但只有離開聽寫模式時才需要這個入口；
 * 以 MutationObserver 監看各 section 的 active 類別，導覽、hash 路由或模組自行切換都能同步。
 */
function setupFloatingHomeButton(statusBar) {
    const button = statusBar.querySelector('#floating-home-btn');
    if (!button) return;

    const sync = () => {
        const onDictationPage = !!dom.dictationSection?.classList.contains('active');
        const showBack = !onDictationPage;
        button.hidden = !showBack;
        // 手機／平板據此顯示標題列（卡片模式本身固定顯示）
        statusBar.classList.toggle('has-back', showBack);
    };

    const observer = new MutationObserver(sync);
    dom.sections.forEach((section) => {
        observer.observe(section, { attributes: true, attributeFilter: ['class'] });
    });
    sync();

    if (!window._dictationCleanups) window._dictationCleanups = [];
    window._dictationCleanups.push(() => observer.disconnect());
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
    prevBtn.innerHTML = iconSvg('prev');
    prevBtn.title = t('dictation.previousTitle');
    prevBtn.setAttribute('aria-label', t('dictation.previousTitle'));
    prevBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        gotoPrevDictationWord();
    });
    
    // 重播按鈕（在左側按鈕和信息區域之間）
    const replayBtn = document.createElement('button');
    replayBtn.id = 'floating-replay-btn';
    replayBtn.className = 'control-btn replay-btn';
    replayBtn.innerHTML = iconSvg('replay');
    replayBtn.title = t('dictation.replayTitle');
    replayBtn.setAttribute('aria-label', t('dictation.replayTitle'));
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
    expandIcon.setAttribute('aria-label', t('dictation.expandWordList'));
    expandIcon.dataset.expanded = 'false';

    infoArea.appendChild(progressSpan);
    infoArea.appendChild(expandIcon);
    
    // 暫停/繼續按鈕（中間）
    const pauseBtn = document.createElement('button');
    pauseBtn.id = 'floating-pause-btn';
    pauseBtn.className = 'control-btn pause-btn';
    pauseBtn.innerHTML = `${iconSvg(state.isDictationPaused ? 'play' : 'pause')}<span>${state.isDictationPaused ? t('dictation.resume') : t('dictation.pause')}</span>`;
    pauseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        togglePauseDictation();
    });
    
    // 下一個按鈕（右側，大按鈕）
    const nextBtn = document.createElement('button');
    nextBtn.id = 'floating-next-btn';
    nextBtn.className = 'control-btn next-btn';
    nextBtn.innerHTML = iconSvg('next');
    nextBtn.title = t('dictation.nextTitle');
    nextBtn.setAttribute('aria-label', t('dictation.nextTitle'));
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
    title.textContent = t('dictation.wordList');
    
    const closeBtn = document.createElement('button');
    closeBtn.className = 'close-btn';
    closeBtn.innerHTML = '×';
    closeBtn.addEventListener('click', () => toggleExpandPanel());
    
    header.appendChild(title);
    header.appendChild(closeBtn);

    // 顯示內容：逐欄位開關（序號／狀態／單詞／音標／釋義），全部關閉等於隱藏整份列表
    const fields = document.createElement('div');
    fields.className = 'panel-fields';
    fields.setAttribute('role', 'group');
    fields.setAttribute('aria-label', t('dictation.fieldsLabel'));

    const fieldLabels = {
        index: t('dictation.fieldIndex'),
        status: t('dictation.fieldStatus'),
        word: t('dictation.fieldWord'),
        phonetic: t('dictation.fieldPhonetic'),
        meaning: t('dictation.fieldMeaning')
    };
    FLOAT_LIST_FIELD_IDS.forEach((id) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'field-chip';
        chip.setAttribute('data-field', id);
        chip.setAttribute('aria-pressed', 'false');
        chip.textContent = fieldLabels[id];
        chip.addEventListener('click', () => toggleFloatingListField(id));
        fields.appendChild(chip);
    });

    // 單詞列表容器
    const listContainer = document.createElement('div');
    listContainer.className = 'word-list-container';
    
    const wordList = document.createElement('div');
    wordList.id = 'floating-word-list';
    wordList.className = 'word-list';
    
    listContainer.appendChild(wordList);
    
    panel.appendChild(header);
    panel.appendChild(fields);
    panel.appendChild(listContainer);
    updateFloatingListFieldChips();

    return panel;
}

/**
 * 展開面板可用高度：確保卡片連同面板都留在畫面內
 */
function availablePanelHeight(statusBar) {
    const panel = document.getElementById('expand-panel');
    const viewportHeight = platform.getViewportHeight() || window.innerHeight;
    const rect = statusBar.getBoundingClientRect();
    const panelHeight = panel && panel.style.display !== 'none' ? panel.offsetHeight : 0;
    const chrome = Math.max(0, rect.height - panelHeight); // 標題列＋控制列的高度
    const cardCap = isFloatingCardMode() ? 420 : Math.round(viewportHeight * 0.5);

    let free;
    if (isFloatingCardMode()) {
        // 桌面卡片：先往下長，之後由 applyFloatingPosition 夾回可視範圍
        free = viewportHeight - 24 - chrome;
    } else {
        // 手機／平板：卡片底端固定，只能往上長，扣掉頂部工具列
        const barHeight = document.querySelector('.app-bar')?.getBoundingClientRect().height || 0;
        const topReserve = barHeight + 12;
        free = rect.top - topReserve;
    }

    return Math.max(180, Math.round(Math.min(cardCap, free)));
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
        // 收合成膠囊時先展開卡片，否則單詞列表無處可放
        if (statusBar.classList.contains('is-collapsed')) {
            statusBar.classList.remove('is-collapsed');
            writeFloatingState(FLOAT_COLLAPSED_KEY, false);
            updateFloatingCollapseUI(statusBar);
        }
        
        // 先量可用高度再顯示面板：面板一旦顯示，底部固定的膠囊會先往上長，
        // 那時量到的剩餘空間會偏小，導致面板被壓得過扁。
        // 卡片模式留出標題列與控制列；手機只能往上長，需扣掉頂部工具列，
        // 否則面板一展開就會把標題列（收合／返回聽寫）推出畫面而點不到。
        const targetPanelHeight = availablePanelHeight(statusBar);

        // 展開面板：一定要用 flex（CSS 的 .expand-panel 是 flex column），
        // 行內寫成 block 會讓清單容器無法被限制高度，列表就永遠捲不動。
        panel.style.display = 'flex';
        statusBar.classList.add('expanded');

        // 更新單詞列表
        updateFloatingWordList();

        panel.style.height = `${targetPanelHeight}px`;
    }

    // 卡片高度改變後重新夾回可視範圍
    if (isFloatingCardMode()) {
        const reclamp = () => applyFloatingPosition(statusBar, readFloatingState(FLOAT_POS_KEY));
        reclamp();
        requestAnimationFrame(reclamp);
    }

    updateExpandIcon(!isExpanded);
}

function updateExpandIcon(isExpanded) {
    const expandIcon = document.querySelector('.expand-icon');
    if (!expandIcon) return;
    expandIcon.textContent = isExpanded ? '▲' : '▼';
    expandIcon.setAttribute('aria-label', isExpanded ? t('dictation.collapseWordList') : t('dictation.expandWordList'));
    expandIcon.dataset.expanded = String(isExpanded);
}

/** 懸浮單詞列表可顯示的欄位（紙筆聽寫預設只給序號與狀態，避免答案外洩） */
const FLOAT_LIST_FIELD_IDS = ['index', 'status', 'word', 'phonetic', 'meaning'];

function getFloatingListFields() {
    const stored = state.dictationSettings.floatListFields;
    const fields = {};
    FLOAT_LIST_FIELD_IDS.forEach((id) => {
        fields[id] = stored && typeof stored[id] === 'boolean'
            ? stored[id]
            : state.DEFAULT_FLOAT_LIST_FIELDS[id] === true;
    });
    return fields;
}

/** 切換單一欄位並立即重繪列表與晶片狀態 */
function toggleFloatingListField(id) {
    if (!FLOAT_LIST_FIELD_IDS.includes(id)) return;
    const fields = getFloatingListFields();
    fields[id] = !fields[id];
    state.setDictationSettings({
        floatListFields: { ...fields },
        showWordInfo: !!(fields.word || fields.phonetic || fields.meaning)
    });
    state.saveDictationSettings();
    updateFloatingListFieldChips();
    updateFloatingWordList();
}

function updateFloatingListFieldChips() {
    const fields = getFloatingListFields();
    document.querySelectorAll('#expand-panel .field-chip').forEach((chip) => {
        const on = fields[chip.getAttribute('data-field')] === true;
        chip.classList.toggle('active', on);
        chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
}

function paragraphStatusText(index) {
    if (index === state.currentDictationIndex) return t('dictation.statusCurrent');
    if (index < state.currentDictationIndex) return t('dictation.statusDone');
    return t('dictation.statusPending');
}

/**
 * 更新浮動單詞列表（欄位依使用者設定組合，全部關閉時整份列表隱藏）
 */
function updateFloatingWordList() {
    const wordList = document.getElementById('floating-word-list');

    if (!wordList || !state.dictationWords) return;

    const fields = getFloatingListFields();
    const showAnything = FLOAT_LIST_FIELD_IDS.some((id) => fields[id]);
    const compact = !fields.word && !fields.meaning; // 只給序號／狀態時走單行排版

    wordList.innerHTML = '';

    if (!showAnything) {
        const hint = document.createElement('div');
        hint.className = 'word-list-empty';
        hint.textContent = t('dictation.listHiddenHint');
        wordList.appendChild(hint);
        updateFloatingListFieldChips();
        return;
    }

    state.dictationWords.forEach((word, index) => {
        const wordItem = document.createElement('div');
        wordItem.className = 'word-item';
        if (index === state.currentDictationIndex) {
            wordItem.classList.add('current');
        }
        wordItem.dataset.index = index;
        wordItem.dataset.compact = String(compact);

        const wordHeader = document.createElement('div');
        wordHeader.className = 'word-header';
        wordItem.appendChild(wordHeader);

        if (fields.index) {
            const indexEl = document.createElement('span');
            indexEl.className = 'word-index';
            indexEl.textContent = `#${index + 1}`;
            wordHeader.appendChild(indexEl);
        }

        if (fields.status) {
            const statusEl = document.createElement('span');
            statusEl.className = 'word-status';
            statusEl.textContent = paragraphStatusText(index);
            wordHeader.appendChild(statusEl);
        }

        if (fields.word) {
            const wordText = document.createElement('div');
            wordText.className = 'word-text';
            wordText.textContent = word.word;
            wordHeader.appendChild(wordText);
        }

        if (fields.phonetic) {
            const rawPhonetic = typeof word.phonetic === 'string' ? word.phonetic.trim() : '';
            const cleanedPhonetic = rawPhonetic.replace(/^\/+|\/+$/g, '');
            const hasPhonetic = cleanedPhonetic && cleanedPhonetic.toLowerCase() !== 'n/a';
            const phoneticEl = document.createElement('span');
            phoneticEl.className = hasPhonetic ? 'word-phonetic' : 'word-phonetic word-phonetic--missing';
            phoneticEl.textContent = hasPhonetic ? `/${cleanedPhonetic}/` : t('dictation.noPhonetic');
            wordHeader.appendChild(phoneticEl);
        }

        if (fields.meaning && word.meaning) {
            const wordMeaning = document.createElement('div');
            wordMeaning.className = 'word-meaning';
            wordMeaning.textContent = word.meaning;
            wordItem.appendChild(wordMeaning);
        }

        wordItem.addEventListener('click', () => {
            jumpToWord(index);
        });

        wordList.appendChild(wordItem);
    });

    updateFloatingListFieldChips();
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
        const text = state.isDictationPaused ? t('dictation.resume') : t('dictation.pause');
        const label = pauseBtn.querySelector('span');
        if (label) label.textContent = text; else pauseBtn.textContent = text;
        const use = pauseBtn.querySelector('use');
        if (use) use.setAttribute('href', state.isDictationPaused ? '#ic-play' : '#ic-pause');
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
        if (dom.loopMode?.checked) {
            state.setCurrentDictationIndex(0);
        } else {
            stopDictation({ completed: true });
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
        ui.displayMessage(t('dictation.startFirst'), 'warning');
        return;
    }
    
    const currentWord = state.dictationWords[state.currentDictationIndex];
    const userInput = dom.dictationInput.value.trim().toLowerCase();
    
    if (userInput === currentWord.word.toLowerCase()) {
        dom.dictationResult.textContent = t('dictation.correct');
        dom.dictationResult.className = 'correct';
    } else {
        dom.dictationResult.textContent = t('dictation.incorrect', { answer: currentWord.word });
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

    // 播放器計數與書名標籤
    if (dom.dictationCounterTotal) dom.dictationCounterTotal.textContent = String(totalWords || 0);
    if (dom.dictationCounterCurrent) {
        const current = state.currentDictationIndex >= 0 ? state.currentDictationIndex + 1 : 0;
        dom.dictationCounterCurrent.textContent = String(current);
    }
    if (dom.dictationBookChip) {
        const selectedRadio = dom.dictationBookSelector?.querySelector('input[name="dictation-book"]:checked');
        const book = selectedRadio ? state.vocabularyBooks.find(b => b.id === selectedRadio.value) : null;
        dom.dictationBookChip.textContent = book ? book.name : '';
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

    if (state.isDictationPaused) {
        audio.speakText(currentWord.word);
        return;
    }

    // 播放中按下重播：中止目前的播放鏈，從當前單詞重新播放完整序列
    clearTimeout(state.dictationTimeout);
    clearInterval(state.dictationInterval);
    audio.stopCurrentAudio();
    playCurrentWord();
}

/**
 * 跳到指定單詞。
 * 播放中跳轉會接續播放（不中斷整場聽寫）；暫停中跳轉只播放一次並維持暫停。
 */
function jumpToDictationWord(newIndex) {
    const wasPlaying = !state.isDictationPaused;
    clearTimeout(state.dictationTimeout);
    clearInterval(state.dictationInterval);
    audio.stopCurrentAudio();

    state.setCurrentDictationIndex(newIndex);
    if (wasPlaying) {
        state.setIsDictationPaused(false);
        updatePauseButtonUI();
        playCurrentWord();
    } else {
        playCurrentWordOnce();
    }

    updateDictationProgress(state.dictationWords.length);
    updateNavigationButtonState();

    // 清空輸入和結果
    dom.dictationInput.value = '';
    dom.dictationResult.textContent = '';
    dom.dictationResult.className = '';
    dom.dictationWordDisplay.textContent = '';
}

function gotoPrevDictationWord() {
    if (!state.dictationWords || state.dictationWords.length === 0) return;

    let newIndex = state.currentDictationIndex - 1;
    if (newIndex < 0) {
        if (!dom.loopMode.checked) return; // 不允許超出邊界
        newIndex = state.dictationWords.length - 1; // 循環到最後一個
    }

    jumpToDictationWord(newIndex);
}

function gotoNextDictationWord() {
    if (!state.dictationWords || state.dictationWords.length === 0) return;

    let newIndex = state.currentDictationIndex + 1;
    if (newIndex >= state.dictationWords.length) {
        if (!dom.loopMode.checked) return; // 不允許超出邊界
        newIndex = 0; // 循環到第一個
    }

    jumpToDictationWord(newIndex);
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
