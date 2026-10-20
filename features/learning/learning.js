import * as state from '../../modules/state.js';
import * as dom from '../../modules/dom.js';
import * as storage from '../../modules/storage.js';
import * as ui from '../../modules/ui.js';
import { escapeHtml } from '../../modules/ui.js';
import * as api from '../../modules/api.js';
import { t } from '../../modules/i18n.js';
import * as audio from '../../modules/audio.js';
import { setPhoneticsWord } from '../phonetics/phonetics.js';

// =================================
// Learning Feature
// =================================

/**
 * 初始化学习模式功能，绑定事件监听器。
 */
export function initLearning() {
    dom.learningBookSelector.addEventListener('change', (e) => {
        // 監聽單選按鈕組的 change 事件（事件會冒泡到容器）
        if (e.target.matches('input[type="radio"]')) {
            populateWordSelect();
        }
    });
    dom.wordSelect.addEventListener('change', displayWordDetails);
    dom.wordPrevBtn?.addEventListener('click', () => stepWord(-1));
    dom.wordNextBtn?.addEventListener('click', () => stepWord(1));
    dom.speakWordBtn.addEventListener('click', speakCurrentWord);
    dom.generateExamplesBtn.addEventListener('click', generateExamples);
    dom.checkSentenceBtn.addEventListener('click', checkSentence);

    // 例句單詞互動
    dom.examplesContainer.addEventListener('mouseover', handleWordHighlight);
    dom.examplesContainer.addEventListener('mouseout', handleWordHighlight);
    dom.examplesContainer.addEventListener('click', handleWordAnalysisClick);
    document.addEventListener('bdc:locale-change', () => {
        populateWordSelect();
        displayWordDetails();
    });
}

/**
 * 上一個 / 下一個單詞。
 *
 * 原本是「環繞」：未選取時按「上一個」會直接跳到**最後一個**單詞，
 * 在第一個單詞按「上一個」也會跳到最後一個，而且沒有任何提示。
 * 學習情境下這等於默默把使用者的位置換掉，所以改成：
 *  - 尚未選取：兩個方向都從第一個單詞開始；
 *  - 已經在最前／最後：停在原地，並在「第 n / 共 m」的位置用同一行顯示提示。
 */
function stepWord(delta) {
    const options = Array.from(dom.wordSelect.options).filter(opt => opt.value);
    if (!options.length) return;
    const currentIndex = options.findIndex(opt => opt.value === dom.wordSelect.value);

    let nextIndex;
    if (currentIndex === -1) {
        nextIndex = 0;
    } else {
        nextIndex = currentIndex + delta;
        if (nextIndex < 0) {
            nextIndex = 0;
            showWordNavHint(t('learning.alreadyFirst'));
        } else if (nextIndex >= options.length) {
            nextIndex = options.length - 1;
            showWordNavHint(t('learning.alreadyLast'));
        }
    }

    if (nextIndex === currentIndex) {
        // 停在原地時仍要讓提示有機會顯示（位置標籤被提示暫時取代）
        dom.wordSelect.scrollIntoView?.({ block: 'nearest' });
        return;
    }

    dom.wordSelect.value = options[nextIndex].value;
    displayWordDetails();
    dom.wordSelect.scrollIntoView?.({ block: 'nearest' });
}

let _wordNavHintTimer = null;
/** 借用「第 n / 共 m」那一行顯示短提示，時間到再還原 */
function showWordNavHint(message) {
    if (!dom.wordPosition) return;
    dom.wordPosition.textContent = message;
    clearTimeout(_wordNavHintTimer);
    _wordNavHintTimer = setTimeout(() => {
        try { updateWordPosition(); } catch (_) {}
    }, 1800);
}

/** 更新「第 n / 共 m 個」提示 */
function updateWordPosition() {
    if (!dom.wordPosition) return;
    const options = Array.from(dom.wordSelect.options).filter(opt => opt.value);
    const index = options.findIndex(opt => opt.value === dom.wordSelect.value);
    if (index === -1) {
        dom.wordPosition.textContent = '';
        return;
    }
    dom.wordPosition.textContent = t('learning.wordPosition', { current: index + 1, total: options.length });
}

/**
 * 填充学习模式下的单词本选择器。
 */
export function populateLearningBookSelector() {
    ui.createBookSelector(dom.learningBookSelector, state.activeBookId, state.vocabularyBooks);
}

export function populateWordSelect() {
    const currentSelectedValue = dom.wordSelect.value;
    const words = getSelectedWords(dom.learningBookSelector);

    // 清空下拉菜單
    dom.wordSelect.innerHTML = '';

    if (!words || words.length === 0) {
        dom.wordSelect.innerHTML = `<option value="">${t('learning.currentBookEmpty')}</option>`;
        clearWordDetails();
        updateWordPosition();
        return;
    }

    dom.wordSelect.innerHTML = `<option value="">${t('learning.selectWordOption')}</option>`;
    words.forEach(word => {
        const option = document.createElement('option');
        option.value = word.id;
        option.textContent = word.word;
        dom.wordSelect.appendChild(option);
    });

    if (currentSelectedValue && Array.from(dom.wordSelect.options).some(opt => opt.value === currentSelectedValue)) {
        dom.wordSelect.value = currentSelectedValue;
    } else {
        dom.wordSelect.value = '';
        clearWordDetails();
    }
    updateWordPosition();
}

function displayWordDetails() {
    const selectedId = dom.wordSelect.value;
    if (!selectedId) {
        clearWordDetails();
        return;
    }

    const words = getActiveWords();
    const word = words.find(w => w.id === selectedId);
    if (word) {
        setPhoneticsWord(word);
        document.getElementById('word-detail-container')?.classList.remove('is-empty');
        dom.detailWord.textContent = word.word;
        dom.detailPhonetic.textContent = word.phonetic ? `/${word.phonetic}/` : '';
        dom.detailMeaning.textContent = word.meaning || t('learning.noMeaning');
        displayExamples(word);
    } else {
        clearWordDetails();
    }
    updateWordPosition();
}

function clearWordDetails() {
    setPhoneticsWord(null);
    dom.detailWord.textContent = t('learning.selectWordTitle');
    dom.detailPhonetic.textContent = '';
    dom.detailMeaning.textContent = '';
    document.getElementById('word-detail-container')?.classList.add('is-empty');
    dom.examplesContainer.innerHTML = '';
    updateWordPosition();
}

function speakCurrentWord() {
    const selectedId = dom.wordSelect.value;
    if (!selectedId) {
        ui.displayMessage(t('learning.selectWord'), 'warning');
        return;
    }

    const words = getActiveWords();
    const word = words.find(w => w.id === selectedId);
    if (word) {
        audio.speakText(word.word);
    }
}

async function generateExamples() {
    const selectedId = dom.wordSelect.value;
    if (!selectedId) {
        ui.displayMessage(t('learning.selectWord'), 'warning');
        return;
    }

    const words = getActiveWords();
    const word = words.find(w => w.id === selectedId);
    if (word) {
        dom.generateExamplesBtn.disabled = true;
        dom.generateExamplesBtn.textContent = t('learning.generating');

        try {
            const exampleSentences = await api.generateExamplesForWord(word);
            word.examples = exampleSentences;
            const saved = await storage.saveVocabularyBooks();
            if (!saved.ok) {
                ui.displayMessage(t('vocabulary.permanentSaveFailed', { message: saved.error || '' }), 'error', 6000);
                return;
            }
            displayExamples(word);
        } catch (error) {
            console.error('生成例句時出錯:', error);
            ui.displayMessage(t('learning.generateFailed'), 'error');
        } finally {
            dom.generateExamplesBtn.disabled = false;
            dom.generateExamplesBtn.textContent = t('learning.generateExamples');
        }
    }
}

function displayExamples(word) {
    dom.examplesContainer.innerHTML = '';

    if (!word.examples || word.examples.length === 0) {
        dom.examplesContainer.innerHTML = `<p>${t('learning.noExamples')}</p>`;
        return;
    }

    const escapeRegex = (string) => string ? string.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&') : '';

    word.examples.forEach((example, index) => {
        const div = document.createElement('div');
        div.className = 'example-item';

        if (!example.alignment) {
            div.innerHTML = `<p class="example-english">${escapeHtml(example.english)}</p><p class="example-chinese">${escapeHtml(example.chinese)}</p>`;
            dom.examplesContainer.appendChild(div);
            return;
        }

        // 先轉義再標記互動單詞：例句由 AI 產生（或轉述文章／OCR 內容），
        // 直接串進 innerHTML 會被當成標記解析。
        let processedEnglish = escapeHtml(example.english);
        let processedChinese = escapeHtml(example.chinese);

        const sortedAlignment = [...example.alignment].sort((a, b) => (b.en?.length || 0) - (a.en?.length || 0));

        sortedAlignment.forEach((pair) => {
            if (pair.en && pair.zh) {
                const pairId = `${word.id}-${index}-${pair.en.replace(/[^a-zA-Z0-9]/g, '')}`;

                const safeEn = escapeHtml(pair.en);
                const safeZh = escapeHtml(pair.zh);
                const enRegex = new RegExp(`(?<!<span[^>]*>)\\b(${escapeRegex(escapeHtml(pair.en))})\\b(?!<\\/span>)`, 'gi');
                processedEnglish = processedEnglish.replace(enRegex, `<span class="interactive-word" data-pair-id="${escapeHtml(pairId)}">${safeEn}</span>`);

                const zhRegex = new RegExp(`(?<!<span[^>]*>)(${escapeRegex(escapeHtml(pair.zh))})(?!<\\/span>)`, 'g');
                processedChinese = processedChinese.replace(zhRegex, `<span class="interactive-word" data-pair-id="${escapeHtml(pairId)}">${safeZh}</span>`);
            }
        });

        div.innerHTML = `
            <p class="example-english">${processedEnglish}</p>
            <p class="example-chinese">${processedChinese}</p>
        `;
        dom.examplesContainer.appendChild(div);
    });
}

async function checkSentence() {
    const selectedId = dom.wordSelect.value;
    const userSentence = dom.sentenceInput.value.trim();

    if (!selectedId) {
        ui.displayMessage(t('learning.selectWord'), 'warning');
        return;
    }
    if (!userSentence) {
        ui.displayMessage(t('learning.enterSentence'), 'warning');
        return;
    }

    const words = getActiveWords();
    const word = words.find(w => w.id === selectedId);
    if (word) {
        const wordRegex = new RegExp(`\\b${word.word}\\b`, 'i');
        if (!wordRegex.test(userSentence)) {
            dom.sentenceFeedback.textContent = t('learning.mustContainWord', { word: word.word });
            dom.sentenceFeedback.className = 'feedback-incorrect';
            return;
        }

        dom.checkSentenceBtn.disabled = true;
        dom.sentenceFeedback.textContent = t('learning.checking');
        dom.sentenceFeedback.className = '';

        try {
            const feedback = await api.checkUserSentence(word.word, userSentence);
            if (/^(正確|正确)/.test(feedback)) {
                dom.sentenceFeedback.textContent = t('learning.sentenceCorrect');
                dom.sentenceFeedback.className = 'feedback-correct';
            } else {
                const suggestion = feedback.replace(/^(不正確。建議：|不正确。建议：)/, '').trim();
                dom.sentenceFeedback.innerHTML = `${escapeHtml(t('learning.sentenceHasIssues'))}<div class="feedback-suggestion">${escapeHtml(t('learning.suggestion'))}${escapeHtml(suggestion)}</div>`;
                dom.sentenceFeedback.className = 'feedback-incorrect';
            }
        } catch (error) {
            console.error('檢查例句時出錯:', error);
            ui.displayMessage(t('learning.requestFailed'), 'error');
            dom.sentenceFeedback.textContent = t('learning.checkFailed');
            dom.sentenceFeedback.className = 'feedback-incorrect';
        } finally {
            dom.checkSentenceBtn.disabled = false;
        }
    }
}

// --- Helper Functions ---

function getActiveWords() {
    return getSelectedWords(dom.learningBookSelector) || [];
}

function getSelectedWords(container) {
    if (!container) return null;
    // 根據新的 book selector 結構查找選中的單選按鈕
    const selectedRadio = container.querySelector(`input[name="learning-book"]:checked`);
    if (selectedRadio) {
        const book = state.vocabularyBooks.find(b => b.id === selectedRadio.value);
        return book ? book.words : [];
    }
    return []; // 如果沒有選中，返回空數組
}

function handleWordHighlight(e) {
    const target = e.target;
    if (target.classList.contains('interactive-word')) {
        const pairId = target.dataset.pairId;
        if (pairId) {
            const elements = document.querySelectorAll(`[data-pair-id="${pairId}"]`);
            if (e.type === 'mouseover') {
                elements.forEach(el => el.classList.add('highlight'));
            } else {
                elements.forEach(el => el.classList.remove('highlight'));
            }
        }
    }
}

function handleWordAnalysisClick(e) {
    if (e.target.classList.contains('interactive-word')) {
        e.stopPropagation();
        const word = e.target.textContent.replace(/[^a-zA-Z\s-]/g, '').trim();
        if (word) {
            // This functionality is complex and depends on other modules.
            // For now, we just log it. A full implementation would require
            // a more robust way to get context and analysis data.
            console.log(`Analyze word: ${word}`);
        }
    }
}
