import * as state from '../../modules/state.js';
import * as dom from '../../modules/dom.js';
import * as storage from '../../modules/storage.js';
import * as ui from '../../modules/ui.js';
import * as api from '../../modules/api.js';
import * as audio from '../../modules/audio.js';

// =================================
// Learning Feature
// =================================

/**
 * 初始化学习模式功能，绑定事件监听器。
 */
export function initLearning() {
    dom.learningBookSelector.addEventListener('change', (e) => {
        // 監聽表單的 change 事件，適用於單選按鈕組
        if (e.target.closest('.book-selector-form')) {
            populateWordSelect();
        }
    });
    dom.wordSelect.addEventListener('change', displayWordDetails);
    dom.speakWordBtn.addEventListener('click', speakCurrentWord);
    dom.generateExamplesBtn.addEventListener('click', generateExamples);
    dom.checkSentenceBtn.addEventListener('click', checkSentence);

    // 例句單詞互動
    dom.examplesContainer.addEventListener('mouseover', handleWordHighlight);
    dom.examplesContainer.addEventListener('mouseout', handleWordHighlight);
    dom.examplesContainer.addEventListener('click', handleWordAnalysisClick);
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
        dom.wordSelect.innerHTML = '<option value="">當前單詞本為空</option>';
        clearWordDetails();
        return;
    }

    dom.wordSelect.innerHTML = '<option value="">請選擇單詞</option>';
    words.forEach(word => {
        const option = document.createElement('option');
        option.value = word.id;
        option.textContent = word.word;
        dom.wordSelect.appendChild(option);
    });

    if (Array.from(dom.wordSelect.options).some(opt => opt.value === currentSelectedValue)) {
        dom.wordSelect.value = currentSelectedValue;
    } else {
        clearWordDetails();
    }
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
        dom.detailWord.textContent = word.word;
        dom.detailPhonetic.textContent = word.phonetic ? `/${word.phonetic}/` : '';
        dom.detailMeaning.textContent = word.meaning || '(無中文意思)';
        displayExamples(word);
    } else {
        clearWordDetails();
    }
}

function clearWordDetails() {
    dom.detailWord.textContent = '';
    dom.detailPhonetic.textContent = '';
    dom.detailMeaning.textContent = '';
    dom.examplesContainer.innerHTML = '';
}

function speakCurrentWord() {
    const selectedId = dom.wordSelect.value;
    if (!selectedId) {
        alert('請先選擇一個單詞！');
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
        alert('請先選擇一個單詞！');
        return;
    }
    
    const words = getActiveWords();
    const word = words.find(w => w.id === selectedId);
    if (word) {
        dom.generateExamplesBtn.disabled = true;
        dom.generateExamplesBtn.textContent = '生成中...';
        
        try {
            const exampleSentences = await api.generateExamplesForWord(word);
            word.examples = exampleSentences;
            storage.saveVocabularyBooks();
            displayExamples(word);
        } catch (error) {
            console.error('生成例句時出錯:', error);
            alert('生成例句失敗，請檢查API Key或網絡連接後再試。');
        } finally {
            dom.generateExamplesBtn.disabled = false;
            dom.generateExamplesBtn.textContent = '生成AI例句';
        }
    }
}

function displayExamples(word) {
    dom.examplesContainer.innerHTML = '';

    if (!word.examples || word.examples.length === 0) {
        dom.examplesContainer.innerHTML = '<p>還沒有例句，點擊「生成AI例句」按鈕生成例句。</p>';
        return;
    }

    const escapeRegex = (string) => string ? string.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&') : '';

    word.examples.forEach((example, index) => {
        const div = document.createElement('div');
        div.className = 'example-item';

        if (!example.alignment) {
            div.innerHTML = `<p class="example-english">${example.english}</p><p class="example-chinese">${example.chinese}</p>`;
            dom.examplesContainer.appendChild(div);
            return;
        }

        let processedEnglish = example.english;
        let processedChinese = example.chinese;

        const sortedAlignment = [...example.alignment].sort((a, b) => (b.en?.length || 0) - (a.en?.length || 0));
        
        sortedAlignment.forEach((pair) => {
            if (pair.en && pair.zh) {
                const pairId = `${word.id}-${index}-${pair.en.replace(/[^a-zA-Z0-9]/g, '')}`;
                
                const enRegex = new RegExp(`(?<!<span[^>]*>)\\b(${escapeRegex(pair.en)})\\b(?!<\\/span>)`, 'gi');
                processedEnglish = processedEnglish.replace(enRegex, `<span class="interactive-word" data-pair-id="${pairId}">${pair.en}</span>`);

                const zhRegex = new RegExp(`(?<!<span[^>]*>)(${escapeRegex(pair.zh)})(?!<\\/span>)`, 'g');
                processedChinese = processedChinese.replace(zhRegex, `<span class="interactive-word" data-pair-id="${pairId}">${pair.zh}</span>`);
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
        alert('請先選擇一個單詞！');
        return;
    }
    if (!userSentence) {
        alert('請輸入一個例句！');
        return;
    }
    
    const words = getActiveWords();
    const word = words.find(w => w.id === selectedId);
    if (word) {
        const wordRegex = new RegExp(`\\b${word.word}\\b`, 'i');
        if (!wordRegex.test(userSentence)) {
            dom.sentenceFeedback.textContent = `您的例句必須包含單詞 "${word.word}"。`;
            dom.sentenceFeedback.className = 'feedback-incorrect';
            return;
        }

        dom.checkSentenceBtn.disabled = true;
        dom.sentenceFeedback.textContent = '正在檢查...';
        dom.sentenceFeedback.className = '';
        
        try {
            const feedback = await api.checkUserSentence(word.word, userSentence);
            if (feedback.startsWith('正確')) {
                dom.sentenceFeedback.textContent = '很好！您的例句正確。';
                dom.sentenceFeedback.className = 'feedback-correct';
            } else {
                const suggestion = feedback.replace('不正確。建議：', '').trim();
                dom.sentenceFeedback.innerHTML = `您的例句有一些問題。<div class="feedback-suggestion">建議：${suggestion}</div>`;
                dom.sentenceFeedback.className = 'feedback-incorrect';
            }
        } catch (error) {
            console.error('檢查例句時出錯:', error);
            alert('檢查例句失敗，請檢查API Key或網絡連接後再試。');
            dom.sentenceFeedback.textContent = '檢查失敗。';
            dom.sentenceFeedback.className = 'feedback-incorrect';
        } finally {
            dom.checkSentenceBtn.disabled = false;
        }
    }
}

// --- Helper Functions ---

function getActiveWords() {
    const activeBook = state.vocabularyBooks.find(b => b.id === state.activeBookId);
    return activeBook ? activeBook.words : [];
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