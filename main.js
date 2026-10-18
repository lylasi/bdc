import * as dom from './modules/dom.js';
import * as state from './modules/state.js';
import { loadVocabularyBooks, loadAnalyzedArticles } from './modules/storage.js';
import { initModal, setupNumberSteppers, initTooltip, displayMessage, confirmAction } from './modules/ui.js';
import { unlockAudioContext } from './modules/audio.js';
import { initVocabulary, handleVocabularyQueryParams, refreshVocabularyView } from './features/vocabulary/vocabulary.js';
import { initLearning, populateLearningBookSelector, populateWordSelect } from './features/learning/learning.js';
import { initDictation, populateDictationBookSelector, togglePauseDictation } from './features/dictation/dictation.js';
import { initQuiz, populateQuizBookSelector, stopQuiz } from './features/quiz/quiz.js';
import { initArticle, showCurrentArticleIfAvailable } from './features/article/article.js';
import { initOCR } from './features/ocr/ocr.js';
import { init as initQA, showQAModule, hideQAModule } from './features/qa/qa.js';
import { initSync, openLoginModal } from './features/sync/sync.js';
import { initAiAssistant } from './features/assistant/assistant.js';
import { initPhonetics } from './features/phonetics/phonetics.js';
import { initI18n, t } from './modules/i18n.js';
import { initTheme } from './modules/theme.js';
import { migrateLegacyAISettings } from './modules/ai-profile-storage.js';
import { initAICatalog } from './modules/ai-catalog.js';
import { initAICredentialSync } from './modules/ai-credential-sync.js';
import { initAiAdmin } from './features/ai-admin/ai-admin.js';
import { initAdminUsers } from './features/admin-users/admin-users.js';

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

let leaveQuizPromptOpen = false;

function setupNavigation() {
    dom.navBtns.forEach(btn => {
        btn.addEventListener('click', async () => {
            if (state.quizInProgress && btn.id !== 'quiz-btn') {
                // 原生 confirm 在部分環境（內嵌瀏覽器、被封鎖的對話框）不會顯示，
                // 使用者會看到「按了沒反應」，因此改用站內確認框。
                if (leaveQuizPromptOpen) return; // 避免連點時疊出多個確認框
                leaveQuizPromptOpen = true;
                let leave = false;
                try {
                    leave = await confirmAction({
                        title: t('quiz.leaveTitle'),
                        message: t('quiz.leaveConfirmation'),
                        confirmLabel: t('quiz.leaveConfirm'),
                        cancelLabel: t('quiz.leaveStay'),
                        danger: true
                    });
                } catch (error) {
                    console.error('[bdc] 離開測驗確認框失敗，預設留在測驗:', error);
                    leave = false;
                } finally {
                    leaveQuizPromptOpen = false;
                }
                if (!leave) { return; }

                // 使用者確認離開 → 真正結束測驗。
                // 少了這一步，state.quizInProgress 會一直是 true，
                // 之後每次切換模組都會再跳一次確認，等於被困住。
                try {
                    stopQuiz({ silent: true });
                } catch (error) {
                    console.error('[bdc] 結束測驗失敗，仍繼續導覽:', error);
                    state.setQuizInProgress(false);
                }
            }

            syncNavActive(btn);
            closeNavMore();

            // 讓 CSS 知道目前在哪個模組（訊息提示需要對不同頁面的底部控制列避讓）
            markActiveModule(btn.id);

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
    const initiallyActive = document.querySelector('.nav-btn.active');
    syncNavActive(initiallyActive);
    if (initiallyActive) markActiveModule(initiallyActive.id);
}

// 目前所在模組（供 CSS 針對不同頁面的底部控制列調整懸浮元件位置）
// 這裡用可讀的模組名而不是 hash 別名（'a' / 'v' / 'qa'…），CSS 選擇器才看得懂。
const BUTTON_ID_TO_MODULE_NAME = {
    'vocabulary-btn': 'vocabulary',
    'learning-btn': 'learning',
    'dictation-btn': 'dictation',
    'quiz-btn': 'quiz',
    'article-btn': 'article',
    'qa-btn': 'qa',
    'ocr-btn': 'ocr'
};

function markActiveModule(buttonId) {
    const name = BUTTON_ID_TO_MODULE_NAME[buttonId];
    if (!name) return;
    document.body.dataset.module = name;
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
    // 每個初始化步驟獨立容錯：單一模組（或它相依的網路資源）失敗時，
    // 其餘模組、主導覽與 URL 路由仍要能運作。
    // 先前這裡是線性 await，任何一步拋錯都會讓後面全部不執行，
    // 使用者只看到「畫面半殘但沒有任何錯誤訊息」。
    const failedSteps = [];
    async function step(name, fn) {
        try {
            return await fn();
        } catch (error) {
            failedSteps.push({ name, error });
            console.error(`[bdc] 初始化步驟「${name}」失敗:`, error);
            return undefined;
        }
    }

    // 0. One-time migration of legacy AI provider settings into the device profile.
    //    The old AI secrets are only removed after the new profile is written and
    //    read back successfully.
    try {
        const migration = migrateLegacyAISettings();
        if (migration && migration.migrated) {
            console.info('[bdc] legacy AI settings migrated:', migration.migratedIds?.length || 0);
        }
    } catch (error) {
        console.warn('[bdc] AI settings migration failed:', error && error.code ? error.code : error);
    }

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
    await step('vocabulary', () => initVocabulary());
    await step('learning', () => initLearning());
    await step('phonetics', () => initPhonetics());
    await step('dictation', () => initDictation());
    await step('quiz', () => initQuiz());
    await step('article', () => initArticle());
    await step('ocr', () => initOCR());
    await step('qa', () => initQA());
    await step('sync', () => initSync());
    // 僅注入 UI，不修改全局 DOM/CSS
    await step('assistant', () => initAiAssistant());
    // AI catalog / credential sync are independent of the learning-data sync:
    // a failure in either must not block the rest of the app.
    await step('aiCatalog', () => initAICatalog());
    await step('aiCredentialSync', () => initAICredentialSync());
    await step('aiAdmin', () => initAiAdmin());
    await step('adminUsers', () => initAdminUsers());

    // 5. 填充初始视图
    // 确保为默认显示的模块（如此处为学习模块）填充内容
    await step('populateLearning', () => { populateLearningBookSelector(); populateWordSelect(); });

    // 6. 主導覽已於 2.1 接管

    document.addEventListener('bdc:request-login', () => {
        try { openLoginModal(); } catch (_) {}
    });

    // 7. 手動觸發一次change事件來更新初始狀態
    await step('listenOnlyMode', () => {
        if (dom.listenOnlyMode) {
            dom.listenOnlyMode.dispatchEvent(new Event('change'));
        }
    });

    await step('routing', () => handleModuleRouting({ ensureHash: true }));
    window.addEventListener('hashchange', () => {
        try { handleModuleRouting(); } catch (error) { console.error('[bdc] 路由切換失敗:', error); }
    });

    // 8. 處理透過 URL 傳入的單詞本導入需求
    await step('vocabularyQueryParams', () => handleVocabularyQueryParams());

    // 9. 讓使用者知道有模組沒起來，而不是面對一個沒有反應的畫面
    if (failedSteps.length) {
        try {
            const names = failedSteps.map(s => s.name).join(', ');
            displayMessage(t('app.partialInitWarning', { modules: names }), 'warning', 8000);
        } catch (_) { /* 提示失敗也不能再拋 */ }
    }

    console.log(failedSteps.length
        ? `应用程序已初始化，但有 ${failedSteps.length} 个模块失败：${failedSteps.map(s => s.name).join(', ')}`
        : '应用程序已完全初始化。');

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
