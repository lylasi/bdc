import * as dom from './modules/dom.js';
import * as state from './modules/state.js';
import { loadVocabularyBooks, loadAnalyzedArticles } from './modules/storage.js';
import { initModal, setupNumberSteppers, initTooltip } from './modules/ui.js';
import { unlockAudioContext } from './modules/audio.js';
import { initVocabulary } from './features/vocabulary/vocabulary.js';
import { initLearning, populateLearningBookSelector, populateWordSelect } from './features/learning/learning.js';
import { initDictation, populateDictationBookSelector, togglePauseDictation } from './features/dictation/dictation.js';
import { initQuiz, populateQuizBookSelector } from './features/quiz/quiz.js';
import { initArticle } from './features/article/article.js';
import { init as initQA, showQAModule, hideQAModule } from './features/qa/qa.js';

function setupNavigation() {
    dom.navBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            if (state.quizInProgress && btn.id !== 'quiz-btn') {
                if (!confirm('測驗正在進行中，確定要離開嗎？')) { return; }
                // 需要一个 stopQuiz 的引用，暂时从 quiz 模块导出
                // import { stopQuiz } from './features/quiz/quiz.js';
                // stopQuiz();
            }

            dom.navBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            // 隱藏所有模組
            hideAllModules();

            // 根據按鈕顯示對應模組
            switch (btn.id) {
                case 'vocabulary-btn':
                    dom.vocabularySection.classList.add('active');
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
                    break;
                case 'qa-btn':
                    showQAModule();
                    break;
            }
        });
    });
}

// 隱藏所有模組的輔助函數
function hideAllModules() {
    dom.sections.forEach(section => {
        section.classList.remove('active');
    });
    hideQAModule();
}

// 根據視窗寬度切換主導航文案（移動端顯示短文案）
function responsiveNavLabels() {
    const isCompact = window.innerWidth <= 480;
    document.querySelectorAll('.nav-btn .nav-text').forEach(el => {
        const full = el.getAttribute('data-full-text') || el.textContent;
        const short = el.getAttribute('data-short-text') || full;
        el.textContent = isCompact ? short : full;
    });
}

document.addEventListener('DOMContentLoaded', async () => {
    // 1. 加载核心数据
    loadVocabularyBooks();
    loadAnalyzedArticles();

    // 2. 初始化通用UI组件
    initModal();
    setupNumberSteppers();
    initTooltip();

    // 3. 设置音频解锁
    document.body.addEventListener('click', unlockAudioContext, { once: true });
    document.body.addEventListener('touchend', unlockAudioContext, { once: true });

    // 4. 初始化所有功能模块
    initVocabulary();
    initLearning();
    initDictation();
    initQuiz();
    initArticle();
    await initQA();
    
    // 5. 填充初始视图
    // 确保在导航设置前，为默认显示的模块（如此处为学习模块）填充内容
    populateLearningBookSelector();
    populateWordSelect();

    // 6. 初始化主导航
    setupNavigation();
    // 6.1 移動端壓縮文案（並監聽視窗縮放）
    responsiveNavLabels();
    window.addEventListener('resize', responsiveNavLabels);

    // 7. 手動觸發一次change事件來更新初始狀態
    if(dom.listenOnlyMode) {
        dom.listenOnlyMode.dispatchEvent(new Event('change'));
    }

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
