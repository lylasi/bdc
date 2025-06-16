// 全局變量
let vocabularyList = [];
let currentDictationIndex = -1;
let dictationInterval;
let dictationTimeout;
let synth = window.speechSynthesis;


// 測驗相關變量
let quizQuestions = [];
let currentQuestionIndex = 0;
let quizScore = 0;
let selectedAnswer = null;
let quizInProgress = false;

// DOM元素
const navBtns = document.querySelectorAll('.nav-btn');
const sections = document.querySelectorAll('.section');
const wordInput = document.getElementById('word-input');
const phoneticInput = document.getElementById('phonetic-input');
const meaningInput = document.getElementById('meaning-input');
const addWordBtn = document.getElementById('add-word-btn');
const batchInput = document.getElementById('batch-input');
const batchAddBtn = document.getElementById('batch-add-btn');
const wordList = document.getElementById('word-list');
const wordSelect = document.getElementById('word-select');
const detailWord = document.getElementById('detail-word');
const detailPhonetic = document.getElementById('detail-phonetic');
const detailMeaning = document.getElementById('detail-meaning');
const speakWordBtn = document.getElementById('speak-word-btn');
const generateExamplesBtn = document.getElementById('generate-examples-btn');
const examplesContainer = document.getElementById('examples-container');
const sentenceInput = document.getElementById('sentence-input');
const checkSentenceBtn = document.getElementById('check-sentence-btn');
const sentenceFeedback = document.getElementById('sentence-feedback');
const repeatTimes = document.getElementById('repeat-times');
const wordInterval = document.getElementById('word-interval');
const readMeaning = document.getElementById('read-meaning');
const loopMode = document.getElementById('loop-mode');
const startDictationBtn = document.getElementById('start-dictation-btn');
const stopDictationBtn = document.getElementById('stop-dictation-btn');
const dictationWordDisplay = document.getElementById('dictation-word-display');
const dictationInput = document.getElementById('dictation-input');
const checkDictationBtn = document.getElementById('check-dictation-btn');
const dictationResult = document.getElementById('dictation-result');

// 測驗模式DOM元素
const quizCount = document.getElementById('quiz-count');
const quizType = document.getElementById('quiz-type');
const startQuizBtn = document.getElementById('start-quiz-btn');
const stopQuizBtn = document.getElementById('stop-quiz-btn');
const quizProgress = document.getElementById('quiz-progress');
const quizScoreDisplay = document.getElementById('quiz-score');
const quizQuestion = document.getElementById('quiz-question');
const quizOptions = document.getElementById('quiz-options');
const nextQuestionBtn = document.getElementById('next-question-btn');
const quizResult = document.getElementById('quiz-result');
const finalScore = document.getElementById('final-score');
const quizSummary = document.getElementById('quiz-summary');
const restartQuizBtn = document.getElementById('restart-quiz-btn');
const analysisTooltip = document.getElementById('word-analysis-tooltip');

// 初始化
document.addEventListener('DOMContentLoaded', () => {
    loadVocabulary();
    renderWordList();
    populateWordSelect();
    setupEventListeners();
});

// 設置事件監聽器
function setupEventListeners() {
    // 導航按鈕
    navBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            // 如果正在進行測驗，先詢問是否要停止
            if (quizInProgress && btn.id !== 'quiz-btn') {
                if (!confirm('測驗正在進行中，確定要離開嗎？')) {
                    return;
                }
                stopQuiz();
            }
            
            navBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            
            const targetId = btn.id.replace('-btn', '-section');
            sections.forEach(section => {
                section.classList.remove('active');
                if (section.id === targetId) {
                    section.classList.add('active');
                }
            });
        });
    });
    
    // 單詞本功能
    addWordBtn.addEventListener('click', addWord);
    batchAddBtn.addEventListener('click', batchAddWords);
    
    // 單詞列表高亮
    wordList.addEventListener('mouseover', (e) => {
        const wordId = e.target.dataset.wordId;
        if (wordId) {
            const elements = wordList.querySelectorAll(`[data-word-id="${wordId}"]`);
            elements.forEach(el => el.classList.add('highlight'));
        }
    });

    wordList.addEventListener('mouseout', (e) => {
        const wordId = e.target.dataset.wordId;
        if (wordId) {
            const elements = wordList.querySelectorAll(`[data-word-id="${wordId}"]`);
            elements.forEach(el => el.classList.remove('highlight'));
        }
    });

    // 默寫模式
    startDictationBtn.addEventListener('click', startDictation);
    stopDictationBtn.addEventListener('click', stopDictation);
    checkDictationBtn.addEventListener('click', checkDictation);
    
    // 學習模式
    wordSelect.addEventListener('change', displayWordDetails);
    speakWordBtn.addEventListener('click', speakCurrentWord);
    generateExamplesBtn.addEventListener('click', generateExamples);
    checkSentenceBtn.addEventListener('click', checkSentence);

    // 例句單詞互動：懸停高亮 & 點擊分析
    examplesContainer.addEventListener('mouseover', (e) => {
        if (e.target.classList.contains('interactive-word')) {
            const pairId = e.target.dataset.pairId;
            if (pairId) {
                const elements = document.querySelectorAll(`[data-pair-id="${pairId}"]`);
                elements.forEach(el => el.classList.add('highlight'));
            }
        }
    });

    examplesContainer.addEventListener('mouseout', (e) => {
        if (e.target.classList.contains('interactive-word')) {
            const pairId = e.target.dataset.pairId;
            if (pairId) {
                const elements = document.querySelectorAll(`[data-pair-id="${pairId}"]`);
                elements.forEach(el => el.classList.remove('highlight'));
            }
        }
    });

    examplesContainer.addEventListener('click', (e) => {
        if (e.target.classList.contains('interactive-word')) {
            e.stopPropagation();
            const word = e.target.textContent.replace(/[^a-zA-Z\s-]/g, '').trim();
            if (word) {
                const sentence = e.target.closest('p').textContent;
                analyzeWordInContext(word, sentence, e);
            }
        }
    });

    // 點擊頁面其他地方隱藏tooltip
    document.addEventListener('click', () => {
        analysisTooltip.style.display = 'none';
    });
    
    // 測驗模式
    startQuizBtn.addEventListener('click', startQuiz);
    stopQuizBtn.addEventListener('click', stopQuiz);
    nextQuestionBtn.addEventListener('click', nextQuestion);
    restartQuizBtn.addEventListener('click', restartQuiz);
}

// 單詞本功能
function addWord() {
    const word = wordInput.value.trim();
    const phonetic = phoneticInput.value.trim();
    const meaning = meaningInput.value.trim();
    
    if (word && phonetic) {
        const newWord = {
            id: Date.now().toString(),
            word,
            phonetic,
            meaning,
            examples: []
        };
        
        vocabularyList.push(newWord);
        saveVocabulary();
        renderWordList();
        populateWordSelect();
        
        // 清空輸入框
        wordInput.value = '';
        phoneticInput.value = '';
        meaningInput.value = '';
    } else {
        alert('請至少輸入單詞和音標！');
    }
}

function batchAddWords() {
    const batchText = batchInput.value.trim();
    if (!batchText) {
        alert('請輸入要批量添加的單詞！');
        return;
    }
    
    const lines = batchText.split('\n');
    let addedCount = 0;
    
    lines.forEach(line => {
        // 新格式: 單詞#中文@音標
        const hashIndex = line.indexOf('#');
        const atIndex = line.indexOf('@');

        if (hashIndex > 0 && atIndex > hashIndex) {
            const word = line.substring(0, hashIndex).trim();
            const meaning = line.substring(hashIndex + 1, atIndex).trim();
            const phonetic = line.substring(atIndex + 1).trim();
            
            if (word && phonetic) {
                const newWord = {
                    id: Date.now().toString() + addedCount,
                    word,
                    phonetic,
                    meaning,
                    examples: []
                };
                
                vocabularyList.push(newWord);
                addedCount++;
            }
        }
    });
    
    if (addedCount > 0) {
        saveVocabulary();
        renderWordList();
        populateWordSelect();
        batchInput.value = '';
        alert(`成功添加了 ${addedCount} 個單詞！`);
    } else {
        alert('未能添加任何單詞，請檢查格式是否正確！格式：單詞#中文@音標');
    }
}

function editWord(id) {
    const word = vocabularyList.find(w => w.id === id);
    if (word) {
        const newWord = prompt('修改單詞:', word.word);
        const newPhonetic = prompt('修改音標:', word.phonetic);
        const newMeaning = prompt('修改中文意思:', word.meaning);
        
        if (newWord && newPhonetic) {
            word.word = newWord;
            word.phonetic = newPhonetic;
            word.meaning = newMeaning || '';
            
            saveVocabulary();
            renderWordList();
            populateWordSelect();
        }
    }
}

function deleteWord(id) {
    if (confirm('確定要刪除這個單詞嗎？')) {
        vocabularyList = vocabularyList.filter(word => word.id !== id);
        saveVocabulary();
        renderWordList();
        populateWordSelect();
    }
}

function renderWordList() {
    wordList.innerHTML = '';
    
    if (vocabularyList.length === 0) {
        wordList.innerHTML = '<li class="word-item">還沒有添加單詞</li>';
        return;
    }
    
    vocabularyList.forEach(word => {
        const li = document.createElement('li');
        li.className = 'word-item';
        li.innerHTML = `
            <div class="word-text">
                <strong data-word-id="${word.id}">${word.word}</strong>
                <span class="phonetic">${word.phonetic}</span>
                ${word.meaning ? `<span class="meaning" data-word-id="${word.id}">${word.meaning}</span>` : ''}
            </div>
            <div class="word-actions">
                <button class="edit-btn">編輯</button>
                <button class="delete-btn">刪除</button>
            </div>
        `;
        
        const editBtn = li.querySelector('.edit-btn');
        const deleteBtn = li.querySelector('.delete-btn');
        
        editBtn.addEventListener('click', () => editWord(word.id));
        deleteBtn.addEventListener('click', () => deleteWord(word.id));
        
        wordList.appendChild(li);
    });
}

// 默寫模式功能
function startDictation() {
    if (vocabularyList.length === 0) {
        alert('請先添加單詞！');
        return;
    }
    
    // 禁用開始按鈕，啟用停止按鈕
    startDictationBtn.disabled = true;
    stopDictationBtn.disabled = false;
    
    // 初始化默寫狀態
    currentDictationIndex = 0;
    dictationWordDisplay.textContent = '';
    dictationInput.value = '';
    dictationResult.textContent = '';
    dictationResult.className = '';
    
    // 開始播放第一個單詞
    playCurrentWord();
}

function stopDictation() {
    // 清除定時器
    clearTimeout(dictationTimeout);
    clearInterval(dictationInterval);
    
    // 啟用開始按鈕，禁用停止按鈕
    startDictationBtn.disabled = false;
    stopDictationBtn.disabled = true;
    
    // 重置狀態
    currentDictationIndex = -1;
    dictationWordDisplay.textContent = '已停止';
}

function playCurrentWord() {
    if (currentDictationIndex >= vocabularyList.length) {
        if (loopMode.checked) {
            currentDictationIndex = 0;
        } else {
            stopDictation();
            dictationWordDisplay.textContent = '默寫完成';
            return;
        }
    }
    
    const currentWord = vocabularyList[currentDictationIndex];
    let timesPlayed = 0;
    
    // 清除之前的定時器
    clearInterval(dictationInterval);
    
    // 播放單詞的功能
    const playWord = () => {
        speakText(currentWord.word);
        timesPlayed++;
        
        // 如果需要朗讀中文，在單詞後朗讀中文
        if (readMeaning.checked && currentWord.meaning && timesPlayed === parseInt(repeatTimes.value)) {
            setTimeout(() => {
                speakText(currentWord.meaning, 'zh-TW');
            }, 1000);
        }
        
        // 如果已經播放了設定的次數，準備播放下一個單詞
        if (timesPlayed >= parseInt(repeatTimes.value)) {
            clearInterval(dictationInterval);
            
            // 延遲後播放下一個單詞
            dictationTimeout = setTimeout(() => {
                currentDictationIndex++;
                playCurrentWord();
            }, parseInt(wordInterval.value) * 1000);
        }
    };
    
    // 立即播放一次，然後設置間隔重複播放
    playWord();
    dictationInterval = setInterval(playWord, 2000);
}

function checkDictation() {
    if (currentDictationIndex === -1 || currentDictationIndex >= vocabularyList.length) {
        alert('請先開始默寫！');
        return;
    }
    
    const currentWord = vocabularyList[currentDictationIndex];
    const userInput = dictationInput.value.trim().toLowerCase();
    
    if (userInput === currentWord.word.toLowerCase()) {
        dictationResult.textContent = '正確！';
        dictationResult.className = 'correct';
        dictationWordDisplay.textContent = currentWord.word;
    } else {
        dictationResult.textContent = `錯誤！正確答案是: ${currentWord.word}`;
        dictationResult.className = 'incorrect';
        dictationWordDisplay.textContent = currentWord.word;
    }
    
    // 清空輸入框
    dictationInput.value = '';
}

// 學習模式功能
function populateWordSelect() {
    // 保存當前選中的值
    const currentSelectedValue = wordSelect.value;
    
    // 清空選擇框
    wordSelect.innerHTML = '<option value="">請選擇單詞</option>';
    
    // 添加所有單詞
    vocabularyList.forEach(word => {
        const option = document.createElement('option');
        option.value = word.id;
        option.textContent = word.word;
        wordSelect.appendChild(option);
    });
    
    // 如果可能，恢復先前選中的值
    if (currentSelectedValue) {
        wordSelect.value = currentSelectedValue;
    }
}

function displayWordDetails() {
    const selectedId = wordSelect.value;
    
    if (!selectedId) {
        clearWordDetails();
        return;
    }
    
    const word = vocabularyList.find(w => w.id === selectedId);
    if (word) {
        detailWord.textContent = word.word;
        detailPhonetic.textContent = word.phonetic;
        detailMeaning.textContent = word.meaning || '(無中文意思)';
        
        // 顯示已有的例句
        displayExamples(word);
    } else {
        clearWordDetails();
    }
}

function clearWordDetails() {
    detailWord.textContent = '';
    detailPhonetic.textContent = '';
    detailMeaning.textContent = '';
    examplesContainer.innerHTML = '';
}

function speakCurrentWord() {
    const selectedId = wordSelect.value;
    
    if (!selectedId) {
        alert('請先選擇一個單詞！');
        return;
    }
    
    const word = vocabularyList.find(w => w.id === selectedId);
    if (word) {
        speakText(word.word);
    }
}

async function generateExamples() {
    const selectedId = wordSelect.value;
    
    if (!selectedId) {
        alert('請先選擇一個單詞！');
        return;
    }
    
    const word = vocabularyList.find(w => w.id === selectedId);
    if (word) {
        generateExamplesBtn.disabled = true;
        generateExamplesBtn.textContent = '生成中...';
        
        try {
            const prompt = `請為單詞 "${word.word}" 生成3個英文例句。對於每個例句，請提供英文、中文翻譯，以及一個英文單詞到中文詞語的對齊映射數組。請確保對齊盡可能精確。請只返回JSON格式的數組，不要有其他任何文字。格式為: [{"english": "...", "chinese": "...", "alignment": [{"en": "word", "zh": "詞語"}, ...]}, ...]`;
            const response = await fetch(API_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${API_KEY}`
                },
                body: JSON.stringify({
                    model: AI_MODELS.exampleGeneration,
                    messages: [{ role: "user", content: prompt }],
                    temperature: 0.7,
                })
            });

            if (!response.ok) {
                const errorData = await response.json();
                console.error('API Error:', errorData);
                throw new Error(`API請求失敗，狀態碼: ${response.status}`);
            }

            const data = await response.json();
            const content = data.choices[0].message.content;
            
            // 嘗試解析API返回的JSON
            const exampleSentences = JSON.parse(content);
            
            word.examples = exampleSentences;
            saveVocabulary();
            displayExamples(word);

        } catch (error) {
            console.error('生成例句時出錯:', error);
            alert('生成例句失敗，請檢查API Key或網絡連接後再試。');
            // 如果API失敗，則使用模擬數據作為後備
            word.examples = generateMockExamples(word.word);
            saveVocabulary();
            displayExamples(word);
        } finally {
            generateExamplesBtn.disabled = false;
            generateExamplesBtn.textContent = '生成AI例句';
        }
    }
}


function displayExamples(word) {
    examplesContainer.innerHTML = '';

    if (!word.examples || word.examples.length === 0) {
        examplesContainer.innerHTML = '<p>還沒有例句，點擊「生成AI例句」按鈕生成例句。</p>';
        return;
    }

    const escapeRegex = (string) => string ? string.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&') : '';

    word.examples.forEach((example, index) => {
        const div = document.createElement('div');
        div.className = 'example-item';

        if (!example.alignment) {
            div.innerHTML = `<p class="example-english">${example.english}</p><p class="example-chinese">${example.chinese}</p>`;
            examplesContainer.appendChild(div);
            return;
        }

        let processedEnglish = example.english;
        let processedChinese = example.chinese;

        const sortedAlignment = [...example.alignment].sort((a, b) => (b.en?.length || 0) - (a.en?.length || 0));
        const processedEn = new Set(); // 用於跟踪已處理的英文單詞（小寫）

        sortedAlignment.forEach((pair) => {
            if (pair.en && pair.zh) {
                const lowerEn = pair.en.toLowerCase();
                if (processedEn.has(lowerEn)) {
                    return; // 如果這個單詞的小寫形式已經處理過，就跳過
                }

                const pairId = `${word.id}-${index}-${pair.en.replace(/[^a-zA-Z0-9]/g, '')}`;
                
                const enRegex = new RegExp(`(?<!<span[^>]*>)\\b(${escapeRegex(pair.en)})\\b(?!<\\/span>)`, 'gi');
                processedEnglish = processedEnglish.replace(enRegex, (match) => {
                    return `<span class="interactive-word" data-pair-id="${pairId}">${match}</span>`;
                });

                const zhRegex = new RegExp(`(?<!<span[^>]*>)(${escapeRegex(pair.zh)})(?!<\\/span>)`, 'g');
                processedChinese = processedChinese.replace(zhRegex, (match) => {
                    return `<span class="interactive-word" data-pair-id="${pairId}">${match}</span>`;
                });

                processedEn.add(lowerEn); // 標記為已處理
            }
        });

        div.innerHTML = `
            <p class="example-english">${processedEnglish}</p>
            <p class="example-chinese">${processedChinese}</p>
        `;
        examplesContainer.appendChild(div);
    });
}

async function analyzeWordInContext(word, sentence, event) {
    // 立即顯示 Tooltip，並設置為加載狀態
    analysisTooltip.innerHTML = '<div class="tooltip-content"><p>分析中...</p></div>';
    analysisTooltip.style.display = 'block';

    // 根據點擊位置定位 Tooltip
    const rect = event.target.getBoundingClientRect();
    analysisTooltip.style.left = `${rect.left}px`;
    analysisTooltip.style.top = `${rect.bottom + window.scrollY + 5}px`;

    try {
        const prompt = `在句子 "${sentence}" 中，單詞 "${word}" 的詞性是什麼？它在句子中扮演什麼角色或作用？請用中文簡潔地回答。請只返回JSON格式，不要有其他任何文字。格式為: {"pos": "詞性", "role": "作用", "meaning": "在該句中的中文意思"}`;
        
        const response = await fetch(API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}`
            },
            body: JSON.stringify({
                model: AI_MODELS.wordAnalysis,
                messages: [{ role: "user", content: prompt }],
                temperature: 0.3,
            })
        });

        if (!response.ok) {
            throw new Error(`API請求失敗，狀態碼: ${response.status}`);
        }

        const data = await response.json();
        // 處理API可能返回的包裹在```json ... ```中的情況
        const content = data.choices[0].message.content.replace(/^```json\n/, '').replace(/\n```$/, '');
        const analysis = JSON.parse(content);

        // 更新 Tooltip 內容
        analysisTooltip.innerHTML = `
            <div class="tooltip-title">${word} (${analysis.pos})</div>
            <div class="tooltip-content">
                <p><strong>作用:</strong> ${analysis.role}</p>
                <p><strong>意思:</strong> ${analysis.meaning}</p>
            </div>
        `;
    } catch (error) {
        console.error('分析單詞時出錯:', error);
        analysisTooltip.innerHTML = '<div class="tooltip-content"><p>分析失敗，請稍後再試。</p></div>';
    }
}

async function checkSentence() {
    const selectedId = wordSelect.value;
    const userSentence = sentenceInput.value.trim();
    
    if (!selectedId) {
        alert('請先選擇一個單詞！');
        return;
    }
    
    if (!userSentence) {
        alert('請輸入一個例句！');
        return;
    }
    
    const word = vocabularyList.find(w => w.id === selectedId);
    if (word) {
        const wordRegex = new RegExp(`\\b${word.word}\\b`, 'i');
        if (!wordRegex.test(userSentence)) {
            sentenceFeedback.textContent = `您的例句必須包含單詞 "${word.word}"。`;
            sentenceFeedback.className = 'feedback-incorrect';
            return;
        }

        checkSentenceBtn.disabled = true;
        sentenceFeedback.textContent = '正在檢查...';
        sentenceFeedback.className = '';
        
        try {
            const prompt = `請判斷以下這個使用單詞 "${word.word}" 的句子在語法和用法上是否正確: "${userSentence}"。如果正確，請只回答 "正確"。如果不正確，請詳細指出錯誤並提供一個修改建議，格式為 "不正確。建議：[你的建議]"。並總結錯誤的知識點。`;
            
            const response = await fetch(API_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${API_KEY}`
                },
                body: JSON.stringify({
                    model: AI_MODELS.sentenceChecking,
                    messages: [{ role: "user", content: prompt }],
                    temperature: 0.5,
                })
            });

            if (!response.ok) {
                const errorData = await response.json();
                console.error('API Error:', errorData);
                throw new Error(`API請求失敗，狀態碼: ${response.status}`);
            }

            const data = await response.json();
            const feedback = data.choices[0].message.content;

            if (feedback.startsWith('正確')) {
                sentenceFeedback.textContent = '很好！您的例句正確。';
                sentenceFeedback.className = 'feedback-correct';
            } else {
                const suggestion = feedback.replace('不正確。建議：', '').trim();
                sentenceFeedback.innerHTML = `您的例句有一些問題。<div class="feedback-suggestion">建議：${suggestion}</div>`;
                sentenceFeedback.className = 'feedback-incorrect';
            }
        } catch (error) {
            console.error('檢查例句時出錯:', error);
            alert('檢查例句失敗，請檢查API Key或網絡連接後再試。');
            // 後備方案
            sentenceFeedback.textContent = '檢查失敗，但您的句子包含了關鍵詞。';
            sentenceFeedback.className = 'feedback-correct';
        } finally {
            checkSentenceBtn.disabled = false;
        }
    }
}


// 輔助功能
function speakText(text, lang = 'en-US') {
    if (!synth) {
        console.error('您的瀏覽器不支持語音合成！');
        return;
    }
    
    // 取消任何正在進行的語音
    synth.cancel();
    
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang;
    utterance.rate = 0.9;
    
    synth.speak(utterance);
}

function saveVocabulary() {
    localStorage.setItem('vocabularyList', JSON.stringify(vocabularyList));
}

function loadVocabulary() {
    const saved = localStorage.getItem('vocabularyList');
    vocabularyList = saved ? JSON.parse(saved) : [];
}

// 模擬AI功能 (作為API調用失敗時的後備)
function generateMockExamples(word) {
    // 這裡只是模擬例句，實際應用中應該調用AI API
    const examples = [
        {
            english: `The ${word} is an essential tool.`,
            chinese: `這個${word}是個必要的工具。`,
            alignment: [
                { en: 'The', zh: '這個' },
                { en: word, zh: word },
                { en: 'is', zh: '是個' },
                { en: 'an', zh: '' },
                { en: 'essential', zh: '必要的' },
                { en: 'tool', zh: '工具' }
            ]
        },
        {
            english: `She bought a new ${word}.`,
            chinese: `她買了一個新的${word}。`,
            alignment: [
                { en: 'She', zh: '她' },
                { en: 'bought', zh: '買了' },
                { en: 'a', zh: '一個' },
                { en: 'new', zh: '新的' },
                { en: word, zh: word }
            ]
        }
    ];
    
    return examples;
}

// 隨堂測驗功能
function startQuiz() {
    if (vocabularyList.length < 4) {
        alert('至少需要4個單詞才能開始測驗！');
        return;
    }
    
    const questionCount = parseInt(quizCount.value);
    if (vocabularyList.length < questionCount) {
        alert(`您只有${vocabularyList.length}個單詞，請減少測驗題目數量！`);
        return;
    }
    
    // 初始化測驗狀態
    quizInProgress = true;
    currentQuestionIndex = 0;
    quizScore = 0;
    selectedAnswer = null;
    
    // 生成測驗題目
    generateQuizQuestions();
    
    // 更新UI狀態
    startQuizBtn.disabled = true;
    stopQuizBtn.disabled = false;
    quizResult.classList.add('hidden');
    
    // 顯示第一道題目
    showCurrentQuestion();
}

function stopQuiz() {
    quizInProgress = false;
    currentQuestionIndex = 0;
    quizScore = 0;
    selectedAnswer = null;
    
    // 重置UI狀態
    startQuizBtn.disabled = false;
    stopQuizBtn.disabled = true;
    nextQuestionBtn.disabled = true;
    
    // 清空顯示
    quizQuestion.textContent = '';
    quizOptions.innerHTML = '';
    updateQuizProgress();
    
    alert('測驗已停止！');
}

function generateQuizQuestions() {
    const questionCount = parseInt(quizCount.value);
    const type = quizType.value;
    quizQuestions = [];
    
    // 隨機選擇單詞
    const selectedWords = [...vocabularyList].sort(() => 0.5 - Math.random()).slice(0, questionCount);
    
    selectedWords.forEach(word => {
        let questionType = type;
        if (type === 'mixed') {
            const types = ['meaning', 'word', 'phonetic'];
            questionType = types[Math.floor(Math.random() * types.length)];
        }
        
        const question = generateQuestionByType(word, questionType);
        if (question) {
            quizQuestions.push(question);
        }
    });
}

function generateQuestionByType(targetWord, type) {
    let question = {
        type: type,
        target: targetWord,
        correctAnswer: '',
        question: '',
        options: []
    };
    
    // 獲取其他單詞作為錯誤選項
    const otherWords = vocabularyList.filter(w => w.id !== targetWord.id);
    const wrongOptions = otherWords.sort(() => 0.5 - Math.random()).slice(0, 3);
    
    switch (type) {
        case 'meaning':
            question.question = `"${targetWord.word}" 的中文意思是？`;
            question.correctAnswer = targetWord.meaning || '(無中文意思)';
            question.options = [
                question.correctAnswer,
                ...wrongOptions.map(w => w.meaning || '(無中文意思)')
            ];
            break;
            
        case 'word':
            question.question = `"${targetWord.meaning || '(無中文意思)'}" 對應的英文單詞是？`;
            question.correctAnswer = targetWord.word;
            question.options = [
                question.correctAnswer,
                ...wrongOptions.map(w => w.word)
            ];
            break;
            
        case 'phonetic':
            question.question = `音標 "${targetWord.phonetic}" 對應的單詞是？`;
            question.correctAnswer = targetWord.word;
            question.options = [
                question.correctAnswer,
                ...wrongOptions.map(w => w.word)
            ];
            break;
    }
    
    // 隨機排列選項
    question.options = question.options.sort(() => 0.5 - Math.random());
    
    return question;
}

function showCurrentQuestion() {
    if (currentQuestionIndex >= quizQuestions.length) {
        endQuiz();
        return;
    }
    
    const question = quizQuestions[currentQuestionIndex];
    selectedAnswer = null;
    
    // 顯示題目
    quizQuestion.textContent = question.question;
    
    // 顯示選項
    quizOptions.innerHTML = '';
    question.options.forEach((option, index) => {
        const optionDiv = document.createElement('div');
        optionDiv.className = 'quiz-option';
        optionDiv.textContent = option;
        optionDiv.addEventListener('click', () => selectOption(index, option));
        quizOptions.appendChild(optionDiv);
    });
    
    // 更新進度
    updateQuizProgress();
    
    // 重置下一題按鈕
    nextQuestionBtn.disabled = true;
}

function selectOption(index, selectedText) {
    if (selectedAnswer !== null) return; // 已經選擇過了
    
    selectedAnswer = selectedText;
    const question = quizQuestions[currentQuestionIndex];
    const options = document.querySelectorAll('.quiz-option');
    
    options.forEach((option, i) => {
        option.classList.add('disabled');
        
        if (option.textContent === question.correctAnswer) {
            option.classList.add('correct');
        }
        
        if (i === index) {
            if (selectedText === question.correctAnswer) {
                option.classList.add('correct');
                quizScore++;
            } else {
                option.classList.add('incorrect');
            }
        }
    });
    
    // 啟用下一題按鈕
    nextQuestionBtn.disabled = false;
    
    // 更新得分
    updateQuizProgress();
}

function nextQuestion() {
    currentQuestionIndex++;
    showCurrentQuestion();
}

function updateQuizProgress() {
    quizProgress.textContent = `題目 ${currentQuestionIndex + 1}/${quizQuestions.length}`;
    quizScoreDisplay.textContent = `得分: ${quizScore}/${Math.min(currentQuestionIndex + 1, quizQuestions.length)}`;
}

function endQuiz() {
    quizInProgress = false;
    
    // 隱藏問題容器，顯示結果
    document.getElementById('quiz-question-container').style.display = 'none';
    quizResult.classList.remove('hidden');
    
    // 計算分數百分比
    const percentage = Math.round((quizScore / quizQuestions.length) * 100);
    
    // 顯示最終分數
    finalScore.textContent = `${quizScore}/${quizQuestions.length} (${percentage}%)`;
    
    // 根據分數設置顏色
    if (percentage >= 80) {
        finalScore.className = 'score-excellent';
    } else if (percentage >= 60) {
        finalScore.className = 'score-good';
    } else {
        finalScore.className = 'score-poor';
    }
    
    // 顯示總結
    let summary = '';
    if (percentage >= 90) {
        summary = '優秀！您對這些單詞掌握得很好！';
    } else if (percentage >= 80) {
        summary = '良好！繼續保持，再接再勵！';
    } else if (percentage >= 60) {
        summary = '及格！建議多複習這些單詞。';
    } else {
        summary = '需要加強！請多花時間學習這些單詞。';
    }
    
    quizSummary.textContent = summary;
    
    // 重置按鈕狀態
    startQuizBtn.disabled = false;
    stopQuizBtn.disabled = true;
    nextQuestionBtn.disabled = true;
}

function restartQuiz() {
    // 重置顯示
    document.getElementById('quiz-question-container').style.display = 'block';
    quizResult.classList.add('hidden');
    
    // 開始新的測驗
    startQuiz();
}