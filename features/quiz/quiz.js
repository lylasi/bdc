import * as state from '../../modules/state.js';
import * as dom from '../../modules/dom.js';
import * as ui from '../../modules/ui.js';
import { t } from '../../modules/i18n.js';

// =================================
// Quiz Feature
// =================================

/**
 * 初始化测验模式功能，绑定事件监听器。
 */
export function initQuiz() {
    dom.startQuizBtn.addEventListener('click', startQuiz);
    dom.stopQuizBtn.addEventListener('click', stopQuiz);
    dom.nextQuestionBtn.addEventListener('click', nextQuestion);
    dom.restartQuizBtn.addEventListener('click', restartQuiz);
    document.addEventListener('bdc:locale-change', refreshQuizLocale);
}

function getSelectedQuizWords() {
    const selectedRadio = dom.quizBookSelector.querySelector('input[name="quiz-book"]:checked');
    if (selectedRadio) {
        const book = state.vocabularyBooks.find(b => b.id === selectedRadio.value);
        return book ? book.words : [];
    }
    return [];
}

function startQuiz() {
    const wordsForQuiz = getSelectedQuizWords();
    if (!wordsForQuiz || wordsForQuiz.length < 4) {
        alert(t('quiz.needFourWords'));
        return;
    }
    
    state.setQuizInProgress(true);
    state.setCurrentQuestionIndex(0);
    state.setQuizScore(0);
    state.setSelectedAnswer(null);
    
    generateQuizQuestions();

    dom.quizSettingsContainer.classList.add('hidden');
    dom.quizMainContainer.classList.remove('hidden');
    document.getElementById('quiz-question-container').style.display = 'block';
    dom.quizResult.classList.add('hidden');

    dom.stopQuizBtn.disabled = false;

    showCurrentQuestion();
}

function stopQuiz() {
    state.setQuizInProgress(false);
    state.setCurrentQuestionIndex(0);
    state.setQuizScore(0);
    state.setSelectedAnswer(null);

    dom.quizSettingsContainer.classList.remove('hidden');
    dom.quizMainContainer.classList.add('hidden');

    dom.stopQuizBtn.disabled = true;
    dom.nextQuestionBtn.disabled = true;

    dom.quizQuestion.textContent = '';
    dom.quizOptions.innerHTML = '';
    updateQuizProgress();

    alert(t('quiz.stopped'));
}

function generateQuizQuestions() {
    const type = dom.quizType.value;
    const wordsForQuiz = getSelectedQuizWords();
    if (!wordsForQuiz) {
        state.setQuizQuestions([]);
        return;
    }
    
    const selectedWords = [...wordsForQuiz].sort(() => 0.5 - Math.random());
    const questions = selectedWords.map(word => {
        let questionType = type;
        if (type === 'mixed') {
            const types = ['meaning', 'word', 'phonetic'];
            questionType = types[Math.floor(Math.random() * types.length)];
        }
        return generateQuestionByType(word, questionType, wordsForQuiz);
    }).filter(q => q !== null);
    
    state.setQuizQuestions(questions);
}

function generateQuestionByType(targetWord, type, allWords) {
    let question = {
        type: type,
        target: targetWord,
        correctAnswer: '',
        question: '',
        options: []
    };
    
    const otherWords = allWords.filter(w => w.id !== targetWord.id);
    const wrongOptions = otherWords.sort(() => 0.5 - Math.random()).slice(0, 3);
    
    switch (type) {
        case 'meaning':
            question.correctAnswer = targetWord.meaning || t('quiz.noMeaning');
            question.options = [question.correctAnswer, ...wrongOptions.map(w => w.meaning || t('quiz.noMeaning'))];
            break;
        case 'word':
            question.correctAnswer = targetWord.word;
            question.options = [question.correctAnswer, ...wrongOptions.map(w => w.word)];
            break;
        case 'phonetic':
            if (!targetWord.phonetic) return null; // Skip if no phonetic
            question.correctAnswer = targetWord.word;
            question.options = [question.correctAnswer, ...wrongOptions.map(w => w.word)];
            break;
        default:
            return null;
    }
    
    question.question = getLocalizedQuestion(question);
    question.options = question.options.sort(() => 0.5 - Math.random());
    return question;
}

function getLocalizedQuestion(question) {
    if (question.type === 'meaning') return t('quiz.askMeaning', { word: question.target.word });
    if (question.type === 'word') return t('quiz.askWord', { meaning: question.target.meaning || t('quiz.noMeaning') });
    if (question.type === 'phonetic') return t('quiz.askPhonetic', { phonetic: question.target.phonetic });
    return question.question || '';
}

function showCurrentQuestion() {
    if (state.currentQuestionIndex >= state.quizQuestions.length) {
        endQuiz();
        return;
    }
    
    const question = state.quizQuestions[state.currentQuestionIndex];
    state.setSelectedAnswer(null);
    
    dom.quizQuestion.textContent = question.question;
    
    dom.quizOptions.innerHTML = '';
    question.options.forEach((option, index) => {
        const optionDiv = document.createElement('div');
        optionDiv.className = 'quiz-option';
        optionDiv.textContent = option;
        optionDiv.addEventListener('click', () => selectOption(index, option));
        dom.quizOptions.appendChild(optionDiv);
    });
    
    updateQuizProgress();
    dom.nextQuestionBtn.disabled = true;
}

function selectOption(index, selectedText) {
    if (state.selectedAnswer !== null) return;
    
    state.setSelectedAnswer(selectedText);
    const question = state.quizQuestions[state.currentQuestionIndex];
    const options = document.querySelectorAll('.quiz-option');
    
    options.forEach((option, i) => {
        option.classList.add('disabled');
        if (option.textContent === question.correctAnswer) {
            option.classList.add('correct');
        }
        if (i === index) {
            if (selectedText === question.correctAnswer) {
                option.classList.add('correct');
                state.setQuizScore(state.quizScore + 1);
            } else {
                option.classList.add('incorrect');
            }
        }
    });
    
    dom.nextQuestionBtn.disabled = false;
    updateQuizProgress();
}

function nextQuestion() {
    state.setCurrentQuestionIndex(state.currentQuestionIndex + 1);
    showCurrentQuestion();
}

function updateQuizProgress() {
    dom.quizProgress.textContent = t('quiz.progress', {
        current: state.currentQuestionIndex + 1,
        total: state.quizQuestions.length
    });
    dom.quizScoreDisplay.textContent = t('quiz.score', {
        score: state.quizScore,
        total: Math.min(state.currentQuestionIndex + 1, state.quizQuestions.length)
    });
}

function endQuiz() {
    state.setQuizInProgress(false);
    
    document.getElementById('quiz-question-container').style.display = 'none';
    dom.quizResult.classList.remove('hidden');
    
    const percentage = Math.round((state.quizScore / state.quizQuestions.length) * 100);
    
    dom.finalScore.textContent = `${state.quizScore}/${state.quizQuestions.length} (${percentage}%)`;
    
    if (percentage >= 80) dom.finalScore.className = 'score-excellent';
    else if (percentage >= 60) dom.finalScore.className = 'score-good';
    else dom.finalScore.className = 'score-poor';
    
    dom.quizSummary.textContent = getQuizSummary(percentage);
    dom.stopQuizBtn.disabled = true;
    dom.nextQuestionBtn.disabled = true;
}

function getQuizSummary(percentage) {
    if (percentage >= 90) return t('quiz.excellent');
    if (percentage >= 80) return t('quiz.good');
    if (percentage >= 60) return t('quiz.pass');
    return t('quiz.improve');
}

function refreshQuizLocale() {
    updateQuizProgress();
    const question = state.quizQuestions[state.currentQuestionIndex];
    if (question && !dom.quizMainContainer.classList.contains('hidden')) {
        question.question = getLocalizedQuestion(question);
        dom.quizQuestion.textContent = question.question;
    }
    if (!dom.quizResult.classList.contains('hidden') && state.quizQuestions.length) {
        const percentage = Math.round((state.quizScore / state.quizQuestions.length) * 100);
        dom.quizSummary.textContent = getQuizSummary(percentage);
    }
}

function restartQuiz() {
    startQuiz();
}

export function populateQuizBookSelector() {
    ui.createBookSelector(dom.quizBookSelector, state.activeBookId);
}
