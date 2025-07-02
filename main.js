import * as dom from './modules/dom.js';
import * as state from './modules/state.js';
import { loadVocabularyBooks, loadAnalyzedArticles } from './modules/storage.js';
import { initModal, setupNumberSteppers, initTooltip } from './modules/ui.js';
import { unlockAudioContext } from './modules/audio.js';
import { initVocabulary } from './features/vocabulary/vocabulary.js';
import { initLearning, populateLearningBookSelector, populateWordSelect } from './features/learning/learning.js';
import { initDictation, populateDictationBookSelector } from './features/dictation/dictation.js';
import { initQuiz, populateQuizBookSelector } from './features/quiz/quiz.js';
import { initArticle } from './features/article/article.js';

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
            
            const targetId = btn.id.replace('-btn', '-section');
            dom.sections.forEach(section => {
                section.classList.toggle('active', section.id === targetId);
            });

            // 根據頁面切換，更新對應模塊的視圖
            if (targetId === 'dictation-section') {
                populateDictationBookSelector();
            } else if (targetId === 'learning-section') {
                populateLearningBookSelector();
                populateWordSelect();
            } else if (targetId === 'quiz-section') {
                populateQuizBookSelector();
            }
        });
    });
}

document.addEventListener('DOMContentLoaded', () => {
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
    
    // 5. 填充初始视图
    // 确保在导航设置前，为默认显示的模块（如此处为学习模块）填充内容
    populateLearningBookSelector();
    populateWordSelect();

    // 6. 初始化主导航
    setupNavigation();

    // 7. 手動觸發一次change事件來更新初始狀態
    if(dom.listenOnlyMode) {
        dom.listenOnlyMode.dispatchEvent(new Event('change'));
    }

    console.log("应用程序已完全初始化。");
});