import * as state from '../../modules/state.js';
import * as dom from '../../modules/dom.js';
import * as storage from '../../modules/storage.js';
import * as ui from '../../modules/ui.js';
import { escapeHtml } from '../../modules/ui.js';
import * as api from '../../modules/api.js';
import { t } from '../../modules/i18n.js';
import * as audio from '../../modules/audio.js';
import { setPhoneticsWord } from '../phonetics/phonetics.js';

// 例句請求流水號：晚回來的結果只能寫回原詞，不得覆蓋目前畫面。
let exampleRequestSeq = 0;

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
    dom.examplesContainer.addEventListener('keydown', handleExampleWordKeydown);
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
    if (!word) return;

    // 每次請求都有流水號：晚回來的舊結果只能寫回原詞，不得覆蓋目前選詞的畫面。
    const requestId = ++exampleRequestSeq;
    const targetWordId = selectedId;
    dom.generateExamplesBtn.disabled = true;
    dom.generateExamplesBtn.textContent = t('learning.generating');

    try {
        const exampleSentences = await api.generateExamplesForWord(word);
        word.examples = exampleSentences;
        const saved = await storage.saveVocabularyBooks();
        if (!saved.ok) {
            if (requestId === exampleRequestSeq) {
                ui.displayMessage(t('vocabulary.permanentSaveFailed', { message: saved.error || '' }), 'error', 6000);
            }
            return;
        }
        // 保存成功後，只有仍是最新請求且使用者還在原詞時才重畫；否則結果留在原詞。
        if (requestId === exampleRequestSeq && dom.wordSelect.value === targetWordId) {
            displayExamples(word);
        }
    } catch (error) {
        if (requestId === exampleRequestSeq) {
            console.error('生成例句時出錯:', error);
            ui.displayMessage(t('learning.generateFailed'), 'error');
        } else {
            console.warn('舊的例句請求失敗，已忽略:', error);
        }
    } finally {
        // 舊請求不得解除新請求的按鈕忙碌狀態。
        if (requestId === exampleRequestSeq) {
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

    word.examples.forEach((example, index) => {
        const item = document.createElement('div');
        item.className = 'example-item';

        const english = document.createElement('p');
        english.className = 'example-english';
        english.appendChild(buildExampleFragment(example.english, example.alignment, 'en', word.id, index));

        const chinese = document.createElement('p');
        chinese.className = 'example-chinese';
        chinese.appendChild(buildExampleFragment(example.chinese, example.alignment, 'zh', word.id, index));

        item.appendChild(english);
        item.appendChild(chinese);
        dom.examplesContainer.appendChild(item);
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
            const elements = document.querySelectorAll('.interactive-word');
            elements.forEach(el => {
                if (el.dataset.pairId !== pairId) return;
                if (e.type === 'mouseover') el.classList.add('highlight');
                else el.classList.remove('highlight');
            });
        }
    }
}

function handleWordAnalysisClick(e) {
    const target = e.target?.closest?.('.interactive-word');
    if (!target) return;
    e.stopPropagation();
    toggleExampleWordGloss(target);
}

function handleExampleWordKeydown(e) {
    const target = e.target?.closest?.('.interactive-word');
    if (!target) return;
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        toggleExampleWordGloss(target);
        return;
    }
    if (e.key === 'Escape') {
        const item = target.closest('.example-item');
        if (!item?.querySelector('.example-word-gloss')) return;
        e.preventDefault();
        closeExampleWordGloss(item);
        target.focus();
    }
}

/**
 * 把一句例句拆成可點詞。
 * - 有 alignment 的詞／片語共用 pairId，滑過時中英同步高亮。
 * - 英文句中的其他單詞也保持可點，但沒有對應意思時只顯示 exampleNoGloss。
 * - 全部用 DOM textContent 建立，AI／文章內容不經過 innerHTML。
 */
function buildExampleFragment(text, alignment, language, wordId, exampleIndex) {
    const raw = String(text || '');
    const fragment = document.createDocumentFragment();
    const pairs = Array.isArray(alignment)
        ? alignment.filter((pair) => pair && pair.en && pair.zh)
        : [];
    const lookup = language === 'en' ? 'en' : 'zh';
    const haystack = language === 'en' ? raw.toLowerCase() : raw;
    const ranges = [];

    pairs.forEach((pair, pairIndex) => {
        const needleRaw = String(pair[lookup] || '');
        if (!needleRaw) return;
        const needle = language === 'en' ? needleRaw.toLowerCase() : needleRaw;
        let from = 0;
        while (from < haystack.length) {
            const start = haystack.indexOf(needle, from);
            if (start === -1) break;
            const end = start + needle.length;
            const before = start > 0 ? raw[start - 1] : '';
            const after = end < raw.length ? raw[end] : '';
            const boundaryBlocked = language === 'en'
                && ((before && /[A-Za-z0-9'’\-]/.test(before)) || (after && /[A-Za-z0-9'’\-]/.test(after)));
            const overlaps = ranges.some((range) => start < range.end && end > range.start);
            if (!boundaryBlocked && !overlaps) {
                ranges.push({
                    start,
                    end,
                    pair,
                    pairId: `${wordId}-${exampleIndex}-${pairIndex}`
                });
            }
            from = start + Math.max(1, needle.length);
        }
    });

    ranges.sort((a, b) => a.start - b.start);

    const appendPlain = (plain) => {
        if (!plain) return;
        if (language !== 'en') {
            fragment.appendChild(document.createTextNode(plain));
            return;
        }
        // 英文句中未被 alignment 命中的單詞也要可點（顯示無對應意思）。
        const wordPattern = /[A-Za-z][A-Za-z'’\-]*/g;
        let last = 0;
        let match;
        while ((match = wordPattern.exec(plain)) !== null) {
            if (match.index > last) {
                fragment.appendChild(document.createTextNode(plain.slice(last, match.index)));
            }
            fragment.appendChild(createExampleWordSpan(
                match[0], null, '', wordId, exampleIndex, language
            ));
            last = wordPattern.lastIndex;
        }
        if (last < plain.length) {
            fragment.appendChild(document.createTextNode(plain.slice(last)));
        }
    };

    let cursor = 0;
    ranges.forEach((range) => {
        if (range.start > cursor) appendPlain(raw.slice(cursor, range.start));
        fragment.appendChild(createExampleWordSpan(
            raw.slice(range.start, range.end),
            range.pair,
            range.pairId,
            wordId,
            exampleIndex,
            language
        ));
        cursor = range.end;
    });
    if (cursor < raw.length) appendPlain(raw.slice(cursor));
    return fragment;
}

function createExampleWordSpan(text, pair, pairId, wordId, exampleIndex, language) {
    const span = document.createElement('span');
    span.className = 'interactive-word';
    span.setAttribute('role', 'button');
    span.setAttribute('tabindex', '0');
    span.setAttribute('aria-expanded', 'false');
    span.textContent = text;
    span.dataset.wordId = wordId;
    span.dataset.exampleIndex = String(exampleIndex);
    span.dataset.language = language;
    if (pair) {
        span.dataset.pairId = pairId;
        span.dataset.word = pair.en || text;
        if (pair.zh) span.dataset.glossZh = pair.zh;
    } else {
        span.dataset.word = text;
    }
    return span;
}

function closeExampleWordGloss(item) {
    item?.querySelector('.example-word-gloss')?.remove();
    item?.querySelectorAll('.interactive-word[aria-expanded="true"]')
        .forEach((word) => word.setAttribute('aria-expanded', 'false'));
}

function openExampleWordGloss(item, target) {
    const pairId = target.dataset.pairId || '';
    const wordText = target.dataset.word || target.textContent || '';
    const meaning = target.dataset.glossZh || '';
    const gloss = document.createElement('div');
    gloss.className = 'example-word-gloss';
    gloss.setAttribute('role', 'group');
    gloss.dataset.pairId = pairId;
    gloss.dataset.word = wordText;

    const text = document.createElement('span');
    text.className = 'example-word-gloss-text';
    // AI 產生的對應意思不可進 innerHTML。
    text.textContent = meaning
        ? t('learning.exampleGloss', { meaning })
        : t('learning.exampleNoGloss');
    gloss.appendChild(text);

    if (wordText) {
        const play = document.createElement('button');
        play.type = 'button';
        play.className = 'example-word-gloss-play';
        play.title = t('learning.speakWord');
        play.setAttribute('aria-label', t('learning.speakWord'));
        play.innerHTML = '<svg class="icon icon-sm" aria-hidden="true"><use href="#ic-speaker"/></svg>';
        play.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            audio.speakText(wordText, 'english', 0, null, null, { owner: 'learning-example' });
        });
        gloss.appendChild(play);
    }

    const english = item.querySelector('.example-english');
    if (english) english.after(gloss);
    else item.appendChild(gloss);

    item.querySelectorAll('.interactive-word').forEach((word) => {
        if (pairId ? word.dataset.pairId === pairId : word === target) {
            word.setAttribute('aria-expanded', 'true');
        }
    });
}

function toggleExampleWordGloss(target) {
    const item = target.closest?.('.example-item');
    if (!item) return;
    const existing = item.querySelector('.example-word-gloss');
    const pairId = target.dataset.pairId || '';
    if (existing) {
        const same = pairId
            ? existing.dataset.pairId === pairId
            : existing.dataset.word === (target.dataset.word || target.textContent || '');
        closeExampleWordGloss(item);
        if (same) return;
    }
    openExampleWordGloss(item, target);
}
