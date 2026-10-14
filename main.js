import * as dom from './modules/dom.js';
import * as state from './modules/state.js';
import { loadVocabularyBooks, loadAnalyzedArticles } from './modules/storage.js';
import { initModal, setupNumberSteppers, initTooltip } from './modules/ui.js';
import { unlockAudioContext } from './modules/audio.js';
import { initVocabulary, handleVocabularyQueryParams, refreshVocabularyView } from './features/vocabulary/vocabulary.js';
import { initLearning, populateLearningBookSelector, populateWordSelect } from './features/learning/learning.js';
import { initDictation, populateDictationBookSelector, togglePauseDictation } from './features/dictation/dictation.js';
import { initQuiz, populateQuizBookSelector } from './features/quiz/quiz.js';
import { initArticle, showCurrentArticleIfAvailable } from './features/article/article.js';
import { initOCR } from './features/ocr/ocr.js';
import { init as initQA, showQAModule, hideQAModule } from './features/qa/qa.js';
import { initSync } from './features/sync/sync.js';
import { initAiAssistant } from './features/assistant/assistant.js';
import { initPhonetics } from './features/phonetics/phonetics.js';
import { initI18n, t } from './modules/i18n.js';
import { initTheme } from './modules/theme.js';

const MODULE_ALIAS_TO_BUTTON_ID = {
    v: 'vocabulary-btn',
    vocab: 'vocabulary-btn',
    vocabulary: 'vocabulary-btn',
    l: 'learning-btn',
    learn: 'learning-btn',
    learning: 'learning-btn',
    d: 'dictation-btn',
    dict: 'dictation-btn',
    dictation: 'dictation-btn',
    q: 'quiz-btn',
    quiz: 'quiz-btn',
    a: 'article-btn',
    article: 'article-btn',
    qa: 'qa-btn',
    i: 'ocr-btn',
    img: 'ocr-btn',
    ocr: 'ocr-btn'
};

const BUTTON_ID_TO_PRIMARY_ALIAS = {
    'vocabulary-btn': 'v',
    'learning-btn': 'l',
    'dictation-btn': 'd',
    'quiz-btn': 'q',
    'article-btn': 'a',
    'qa-btn': 'qa',
    'ocr-btn': 'ocr'
};

function setupNavigation() {
    dom.navBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            if (state.quizInProgress && btn.id !== 'quiz-btn') {
                if (!confirm(t('quiz.leaveConfirmation'))) { return; }
                // 需要一个 stopQuiz 的引用，暂时从 quiz 模块导出
                // import { stopQuiz } from './features/quiz/quiz.js';
                // stopQuiz();
            }

            syncNavActive(btn);
            closeNavMore();

            // 隱藏所有模組
            hideAllModules();

            // 根據按鈕顯示對應模組
            switch (btn.id) {
                case 'vocabulary-btn':
                    dom.vocabularySection.classList.add('active');
                    try { refreshVocabularyView(); } catch (_) {}
                    break;
                case 'learning-btn':
                    dom.learningSection.classList.add('active');
                    populateLearningBookSelector();
                    populateWordSelect();
                    break;
                case 'dictation-btn':
                    dom.dictationSection.classList.add('active');
                    populateDictationBookSelector();
                    break;
                case 'quiz-btn':
                    dom.quizSection.classList.add('active');
                    populateQuizBookSelector();
                    break;
                case 'article-btn':
                    dom.articleSection.classList.add('active');
                    try { showCurrentArticleIfAvailable(); } catch (_) {}
                    break;
                case 'qa-btn':
                    showQAModule();
                    break;
                case 'ocr-btn':
                    dom.ocrSection.classList.add('active');
                    break;
            }

            updateModuleHashFromButtonId(btn.id);
        });
    });

    setupNavMore();
    syncNavActive(document.querySelector('.nav-btn.active'));
}

// 手機底部導覽：目前模組若收在「更多」抽屜內，抽屜按鈕同步高亮
function syncNavActive(activeBtn) {
    dom.navBtns.forEach(b => b.classList.remove('active'));
    if (activeBtn) activeBtn.classList.add('active');

    const inMoreList = !!(activeBtn && dom.navMoreList && dom.navMoreList.contains(activeBtn));
    if (dom.navMoreBtn) {
        dom.navMoreBtn.classList.toggle('active', inMoreList);
    }
}

// 手機底部導覽的「更多」抽屜：點擊開合、點背景或 Esc 關閉
function setupNavMore() {
    if (!dom.navMoreBtn || !dom.navMoreList) return;

    dom.navMoreBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        const willOpen = !dom.navMoreList.classList.contains('is-open');
        if (willOpen) { openNavMore(); } else { closeNavMore(); }
    });

    if (dom.navBackdrop) {
        dom.navBackdrop.addEventListener('click', closeNavMore);
    }

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') closeNavMore();
    });

    window.addEventListener('resize', () => {
        if (window.innerWidth >= 768) closeNavMore();
    });
}

function openNavMore() {
    if (!dom.navMoreList) return;
    dom.navMoreList.classList.add('is-open');
    dom.navMoreBtn.setAttribute('aria-expanded', 'true');
    if (dom.navBackdrop) {
        dom.navBackdrop.hidden = false;
        dom.navBackdrop.classList.add('is-open');
    }
}

function closeNavMore() {
    if (!dom.navMoreList) return;
    dom.navMoreList.classList.remove('is-open');
    dom.navMoreBtn.setAttribute('aria-expanded', 'false');
    if (dom.navBackdrop) {
        dom.navBackdrop.classList.remove('is-open');
        dom.navBackdrop.hidden = true;
    }
}

// 隱藏所有模組的輔助函數
function hideAllModules() {
    dom.sections.forEach(section => {
        section.classList.remove('active');
    });
    hideQAModule();
}

document.addEventListener('DOMContentLoaded', async () => {
    initI18n();
    // 0. 套用使用者選定的配色主題（index.html 的 head 已先套一次，避免首次繪製閃色）
    initTheme();

    // 1. 加载核心数据
    loadVocabularyBooks();
    loadAnalyzedArticles();

    // 2. 初始化通用UI组件
    initModal();
    setupNumberSteppers();
    initTooltip();

    // 2.1 先接管主導覽：initQA 需要等待網路，期間點底部標籤也應該有反應
    setupNavigation();
    closeNavMore();

    // 3. 设置音频解锁
    document.body.addEventListener('click', unlockAudioContext, { once: true });
    document.body.addEventListener('touchend', unlockAudioContext, { once: true });

    // 4. 初始化所有功能模块
    initVocabulary();
    initLearning();
    initPhonetics();
    initDictation();
    initQuiz();
    initArticle();
    initOCR();
    await initQA();
    initSync();
    // 僅注入 UI，不修改全局 DOM/CSS
    try { initAiAssistant(); } catch (_) {}

    // 5. 填充初始视图
    // 确保为默认显示的模块（如此处为学习模块）填充内容
    populateLearningBookSelector();
    populateWordSelect();

    // 6. 主導覽已於 2.1 接管

    // 7. 手動觸發一次change事件來更新初始狀態
    if(dom.listenOnlyMode) {
        dom.listenOnlyMode.dispatchEvent(new Event('change'));
    }

    handleModuleRouting({ ensureHash: true });
    window.addEventListener('hashchange', () => handleModuleRouting());

    // 8. 處理透過 URL 傳入的單詞本導入需求
    await handleVocabularyQueryParams();

    console.log("应用程序已完全初始化。");

    // 監聽頁面可見性變化，以處理背景播放問題
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            // 如果默寫正在進行中且未暫停，則自動暫停
            if (!dom.stopDictationBtn.disabled && !state.isDictationPaused) {
                togglePauseDictation();
            }
        }
    });
});

function handleModuleRouting(options = {}) {
    const aliasFromUrl = extractModuleAliasFromUrl();

    if (!aliasFromUrl) {
        if (options.ensureHash) {
            const activeBtn = document.querySelector('.nav-btn.active');
            if (activeBtn) {
                updateModuleHashFromButtonId(activeBtn.id);
            }
        }
        return;
    }

    const buttonId = resolveButtonIdFromAlias(aliasFromUrl);
    if (!buttonId) {
        console.warn('未知的模組參數:', aliasFromUrl);
        return;
    }

    const button = document.getElementById(buttonId);
    if (!button) {
        console.warn('找不到對應的導航按鈕:', buttonId);
        return;
    }

    if (button.classList.contains('active')) {
        updateModuleHashFromButtonId(button.id);
        return;
    }

    button.click();
}

function resolveButtonIdFromAlias(alias) {
    if (!alias) return null;
    return MODULE_ALIAS_TO_BUTTON_ID[alias] || null;
}

function extractModuleAliasFromUrl() {
    const params = new URLSearchParams(window.location.search);
    let rawAlias = params.get('module') || params.get('tab') || params.get('page');

    if (!rawAlias) {
        const searchMatch = window.location.search.match(/^\?\/?([^&#]+)/);
        if (searchMatch) {
            rawAlias = searchMatch[1];
        }
    }

    if (!rawAlias && window.location.hash) {
        rawAlias = window.location.hash;
    }

    return normalizeModuleAlias(rawAlias);
}

function normalizeModuleAlias(value) {
    if (!value) return null;
    if (Array.isArray(value)) {
        value = value[0];
    }

    const trimmed = String(value).trim();
    if (!trimmed) return null;

    const withoutPrefix = trimmed.replace(/^[#/?]+/, '');
    if (!withoutPrefix) return null;

    const firstSegment = withoutPrefix.split(/[?#&/]/)[0];
    return firstSegment.toLowerCase();
}

function updateModuleHashFromButtonId(buttonId) {
    const alias = BUTTON_ID_TO_PRIMARY_ALIAS[buttonId];
    if (!alias) return;

    const desiredHash = `#${alias}`;
    if (window.location.hash === desiredHash) return;

    const cleanedSearch = getSearchWithoutRoutingParams();
    const newUrl = `${window.location.pathname}${cleanedSearch}${desiredHash}`;
    history.replaceState(null, '', newUrl);
}

function getSearchWithoutRoutingParams() {
    let search = window.location.search || '';

    if (search.startsWith('?/') || (search.startsWith('?') && !search.includes('='))) {
        const nextParamIndex = search.indexOf('&');
        search = nextParamIndex === -1 ? '' : `?${search.slice(nextParamIndex + 1)}`;
    }

    if (!search) {
        return '';
    }

    const params = new URLSearchParams(search);
    ['module', 'tab', 'page'].forEach(key => params.delete(key));

    const normalized = params.toString();
    return normalized ? `?${normalized}` : '';
}
