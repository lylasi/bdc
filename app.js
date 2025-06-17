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

// 文章詳解DOM元素
const articleInput = document.getElementById('article-input');
const analyzeArticleBtn = document.getElementById('analyze-article-btn');
const articleAnalysisContainer = document.getElementById('article-analysis-container');
const articleHistorySelect = document.getElementById('article-history-select');
const deleteHistoryBtn = document.getElementById('delete-history-btn');
const clearArticleBtn = document.getElementById('clear-article-btn');

// 文章詳解相關變量
let analyzedArticles = [];

// 初始化
document.addEventListener('DOMContentLoaded', () => {
    loadVocabulary();
    loadAnalyzedArticles(); // 新增：加載已分析的文章歷史
    renderWordList();
    populateWordSelect();
    populateArticleHistorySelect(); // 新增：填充歷史記錄下拉菜單
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

    // 文章詳解功能
    analyzeArticleBtn.addEventListener('click', analyzeArticle);
    clearArticleBtn.addEventListener('click', clearArticleInput);
    articleHistorySelect.addEventListener('change', loadSelectedArticle);
    deleteHistoryBtn.addEventListener('click', deleteSelectedArticleHistory);

    // 文章詳解結果區的事件監聽（類似於例句）
    articleAnalysisContainer.addEventListener('mouseover', (e) => {
        if (e.target.classList.contains('interactive-word')) {
            const pairId = e.target.dataset.pairId;
            if (pairId) {
                const elements = document.querySelectorAll(`[data-pair-id="${pairId}"]`);
                elements.forEach(el => el.classList.add('highlight'));
            }
        }
    });

    articleAnalysisContainer.addEventListener('mouseout', (e) => {
        if (e.target.classList.contains('interactive-word')) {
            const pairId = e.target.dataset.pairId;
            if (pairId) {
                const elements = document.querySelectorAll(`[data-pair-id="${pairId}"]`);
                elements.forEach(el => el.classList.remove('highlight'));
            }
        }
    });

    articleAnalysisContainer.addEventListener('click', (e) => {
        if (e.target.classList.contains('interactive-word')) {
            e.stopPropagation();
            try {
                const analysisArray = JSON.parse(articleAnalysisContainer.dataset.analysis || '[]');
                if (analysisArray.length > 0) {
                    showArticleWordAnalysis(e.target, analysisArray);
                }
            } catch (err) {
                console.error("Failed to parse analysis data:", err);
            }
        }
    });
}

// 文章詳解功能
async function analyzeArticle() {
    const articleText = articleInput.value.trim();
    if (!articleText) {
        alert('請輸入要分析的文章！');
        return;
    }

    analyzeArticleBtn.disabled = true;
    analyzeArticleBtn.textContent = '分析中...';
    articleAnalysisContainer.innerHTML = '<p>正在為您生成詳細解析，請稍候...</p>';

    try {
        // 最終優化 Prompt，要求極致的上下文關聯分析
        const prompt = `請對以下英文文章進行全面、深入的語法和語義分析，並嚴格按照指定的JSON格式返回結果。

文章: "${articleText}"

請返回一個JSON對象，包含以下三個鍵:
1. "chinese_translation": 字符串，為整篇文章的流暢中文翻譯。
2. "word_alignment": 數組，每個元素是一個對象 {"en": "英文單詞", "zh": "對應的中文詞語"}，用於實現英漢詞語對照高亮。
3. "detailed_analysis": 一個 **數組**，其中每個元素都是一個對象，代表文章中一個具體單詞的分析。
   - **重要**: 這個數組中的對象必須嚴格按照單詞在原文中出現的順序排列。
   - **重要**: 如果同一個單詞在文章中出現多次，請為每一次出現都創建一個獨立的分析對象。
   - 每個對象的結構如下:
     {
       "word": "被分析的單詞原文",
       "sentence": "該單詞所在的完整句子",
       "analysis": {
         "pos": "詞性",
         "meaning": "在當前上下文中的準確中文意思",
         "role": "在句子中的極其詳細的語法作用，並強力關聯上下文。描述必須非常具體，清晰地闡述該詞與前後文的邏輯關係。例如：
                  - **並列結構**: 對於 'He bought snacks and waited' 中的 'waited'，分析應為 '與前面的動詞 'bought' 構成並列謂語，由連詞 'and' 連接，共同描述主語 'He' 的兩個連續動作：先「買了零食」，然後「等待」。'
                  - **代詞**: 對於 'I liked it' 中的 'it'，分析應為 '指代上文提到的名詞 'the hot dog'。'
                  - **副詞**: 對於 'They were so exciting' 中的 'so'，分析應為 '程度副詞，修飾形容詞 'exciting'，表示「非常」的意思，加強了遊樂設施的刺激程度。'
                  - **關係代詞**: 對於 'the man who is a doctor' 中的 'who'，分析應為 '引導定語從句修飾先行詞 'the man'，並在從句中充當主語。'
                  - **形容詞**: 對於 'colourful birds' 中的 'colourful'，分析應為 '作為定語，修飾名詞 'birds'，描述鳥的顏色是多彩的。'"
       }
     }

請只返回JSON格式的數據，不要包含任何額外的解釋性文字或標記。`;

        const response = await fetch(API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}`
            },
            body: JSON.stringify({
                model: AI_MODELS.exampleGeneration, // 可以考慮為此功能使用更強大的模型
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
        const content = data.choices[0].message.content.replace(/^```json\n/, '').replace(/\n```$/, '');
        const analysisResult = JSON.parse(content);

        // 將新的、更可靠的 detailed_analysis 數組存儲在 dataset 中
        articleAnalysisContainer.dataset.analysis = JSON.stringify(analysisResult.detailed_analysis || []);

        // 渲染結果
        displayArticleAnalysis(articleText, analysisResult);

        // 新增：保存分析結果到歷史記錄
        saveAnalysisResult(articleText, analysisResult);

    } catch (error) {
        console.error('分析文章時出錯:', error);
        articleAnalysisContainer.innerHTML = `<p style="color: red;">分析失敗！請檢查API Key或網絡連接後再試。</p>`;
        alert('分析文章失敗，請稍後再試。');
    } finally {
        analyzeArticleBtn.disabled = false;
        analyzeArticleBtn.textContent = '分析文章';
    }
}

function displayArticleAnalysis(originalArticle, analysisResult) {
    const { chinese_translation, word_alignment, detailed_analysis } = analysisResult;

    if (!chinese_translation || !word_alignment || !detailed_analysis) {
        articleAnalysisContainer.innerHTML = `<p style="color: red;">API返回的數據格式不完整，無法顯示分析結果。</p>`;
        return;
    }

    const escapeRegex = (string) => string ? string.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&') : '';

    // --- 數據預處理 ---
    // 1. 為每個分析的單詞計算其在原文的精確位置
    let cursor = 0;
    const wordStartMap = new Map(); // 使用Map來從起始位置快速查找單詞
    detailed_analysis.forEach(item => {
        const word = item.word;
        if (!word) return;
        const wordRegex = new RegExp(`\\b${escapeRegex(word)}\\b`);
        const match = originalArticle.substring(cursor).match(wordRegex);
        if (match) {
            const startIndex = cursor + match.index;
            item.startIndex = startIndex;
            item.endIndex = startIndex + word.length;
            wordStartMap.set(startIndex, item);
            cursor = item.startIndex + 1;
        }
    });

    // 2. 處理中英文高亮配對，並將pairId賦予對應的英文單詞
    let processedChinese = chinese_translation;
    const sortedAlignment = [...word_alignment].sort((a, b) => (b.en?.length || 0) - (a.en?.length || 0));
    const processedPhrases = new Array(originalArticle.length).fill(false); // 標記已處理的文本範圍

    sortedAlignment.forEach((pair, index) => {
        if (!pair.en || !pair.zh) return;

        let phraseIndex = -1;
        let tempCursor = 0;
        // 查找一個尚未被更長的短語覆蓋的匹配項
        while ((phraseIndex = originalArticle.indexOf(pair.en, tempCursor)) !== -1) {
            if (!processedPhrases[phraseIndex]) {
                break;
            }
            tempCursor = phraseIndex + 1;
        }

        if (phraseIndex !== -1) {
            const phraseEndIndex = phraseIndex + pair.en.length;
            const pairId = `article-pair-${index}`;

            // 將此ID賦予所有起始位置在該短語範圍內的單詞
            for (let i = phraseIndex; i < phraseEndIndex; i++) {
                if (wordStartMap.has(i)) {
                    const wordItem = wordStartMap.get(i);
                    // 確保單詞完全包含在短語內
                    if (wordItem.endIndex <= phraseEndIndex) {
                        wordItem.pairId = pairId;
                    }
                }
            }
            
            // 將此範圍標記為已處理
            for (let i = phraseIndex; i < phraseEndIndex; i++) {
                processedPhrases[i] = true;
            }

            // 為中文部分添加高亮span
            const zhRegex = new RegExp(`(?<!<span[^>]*>)(${escapeRegex(pair.zh)})(?!<\\/span>)`);
            processedChinese = processedChinese.replace(zhRegex, `<span class="interactive-word" data-pair-id="${pairId}">${pair.zh}</span>`);
        }
    });

    // --- 渲染 ---
    // 3. 根據預處理好的數據構建英文顯示內容
    let processedEnglish = '';
    let lastIndex = 0;
    const wordCounts = {};
    detailed_analysis.forEach(item => {
        if (item.startIndex === undefined) return;
        
        // 添加單詞間的普通文本
        processedEnglish += originalArticle.substring(lastIndex, item.startIndex);
        
        // 添加帶有完整數據的單詞span
        const wordLower = item.word.toLowerCase();
        const wordIndex = wordCounts[wordLower] || 0;
        processedEnglish += `<span class="interactive-word" data-word="${item.word}" data-word-index="${wordIndex}" data-pair-id="${item.pairId || ''}">${item.word}</span>`;
        wordCounts[wordLower] = wordIndex + 1;
        lastIndex = item.endIndex;
    });
    // 添加最後的剩餘文本
    processedEnglish += originalArticle.substring(lastIndex);

    // 4. 插入最終的HTML
    articleAnalysisContainer.innerHTML = `
        <div class="example-item">
            <p class="example-english">${processedEnglish.replace(/\n/g, '<br>')}</p>
            <p class="example-chinese">${processedChinese.replace(/\n/g, '<br>')}</p>
        </div>
    `;
    
    // 存儲分析數據供點擊事件使用
    articleAnalysisContainer.dataset.analysis = JSON.stringify(detailed_analysis || []);
}

function showArticleWordAnalysis(clickedElement, analysisArray) {
    const wordText = clickedElement.dataset.word;
    const wordIndex = parseInt(clickedElement.dataset.wordIndex, 10);

    if (!wordText || isNaN(wordIndex)) {
        analysisTooltip.innerHTML = `<div class="tooltip-content"><p>無法識別單詞。</p></div>`;
        repositionTooltip(clickedElement);
        return;
    }
    
    // 從總分析數組中，篩選出所有對應這個單詞的分析結果
    const matchingAnalyses = analysisArray.filter(item => item.word.toLowerCase() === wordText.toLowerCase());

    // 根據存儲的索引，從篩選後的分析結果中獲取唯一的、正確的分析數據
    const wordAnalysisData = (wordIndex < matchingAnalyses.length)
        ? matchingAnalyses[wordIndex]
        : null;

    if (wordAnalysisData && wordAnalysisData.analysis) {
        const analysis = wordAnalysisData.analysis;
        analysisTooltip.innerHTML = `
            <div class="tooltip-title">${wordAnalysisData.word} (${analysis.pos})</div>
            <div class="tooltip-content">
                <p><strong>作用:</strong> ${analysis.role}</p>
                <p><strong>意思:</strong> ${analysis.meaning}</p>
            </div>
        `;
    } else {
        analysisTooltip.innerHTML = `<div class="tooltip-content"><p>單詞 "${wordText}" (第 ${wordIndex + 1} 次出現) 的分析數據未找到或不匹配。</p></div>`;
    }

    analysisTooltip.style.visibility = 'hidden';
    analysisTooltip.style.display = 'block';
    repositionTooltip(clickedElement);
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
            // 步驟 1: 生成例句
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
            const exampleSentences = JSON.parse(content);

            // 步驟 2: 為每個例句非同步獲取所有單詞的分析
            generateExamplesBtn.textContent = '分析語義中...';
            const analysisPromises = exampleSentences.map(example =>
                analyzeWordsInSentence(example.english).then(analysis => {
                    example.analysis = analysis; // 將分析結果附加到例句對象
                    return example;
                })
            );
            
            // 等待所有分析完成
            const examplesWithAnalysis = await Promise.all(analysisPromises);
            
            word.examples = examplesWithAnalysis;
            saveVocabulary();
            displayExamples(word);

        } catch (error) {
            console.error('生成例句或分析時出錯:', error);
            alert('生成例句或分析失敗，請檢查API Key或網絡連接後再試。');
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

// 專門用於定位 Tooltip 的輔助函式
function repositionTooltip(targetElement) {
    // 使用 requestAnimationFrame 來確保 DOM 更新完畢，從而獲得準確的尺寸
    requestAnimationFrame(() => {
        const rect = targetElement.getBoundingClientRect();
        const tooltipHeight = analysisTooltip.offsetHeight;
        const tooltipWidth = analysisTooltip.offsetWidth;
        const spaceAbove = rect.top;

        let top, left;

        // 決定垂直位置
        if (spaceAbove > tooltipHeight + 10) {
            // 如果上方空間充足，顯示在上方
            top = rect.top + window.scrollY - tooltipHeight - 5;
        } else {
            // 否則，顯示在下方 (這是更安全的默認選項)
            top = rect.bottom + window.scrollY + 5;
        }

        // 決定水平位置，確保不超出視窗左右邊界
        left = rect.left;
        if (left + tooltipWidth > window.innerWidth - 10) {
            // 如果右側超出，使其右對齊到觸發詞的右邊界
            left = rect.right - tooltipWidth;
        }
        if (left < 10) {
            // 如果左側超出，設置為靠近邊界
            left = 10;
        }

        analysisTooltip.style.top = `${top}px`;
        analysisTooltip.style.left = `${left}px`;
        analysisTooltip.style.visibility = 'visible'; // 確保可見
    });
}

// 新函式：一次性分析句子中所有單詞
async function analyzeWordsInSentence(sentence) {
    try {
        const prompt = `對以下句子中的每個單詞進行詳細的語法分析。請以JSON對象形式返回結果，鍵為單詞原文（小寫）。每個單詞的分析應包含：1. "pos": 詞性（例如, "名詞", "動詞", "副詞"）。2. "meaning": 該單詞在當前上下文中的中文意思。3. "role": 在句子中的詳細語法作用。這個描述應該非常具體，例如，如果一個副詞修飾一個動詞，請明確指出它修飾了哪個動詞以及修飾的方面（如方式、程度、時間）。如果一個形容詞修飾一個名詞，請指出來。如果一個單詞是某個片語的一部分，也請說明。句子為: "${sentence}"。請只返回JSON格式，不要有其他任何文字。返回格式示例: {"word1": {"pos": "...", "meaning": "...", "role": "..." }, "word2": ...}`;
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
        const content = data.choices[0].message.content.replace(/^```json\n/, '').replace(/\n```$/, '');
        return JSON.parse(content);

    } catch (error) {
        console.error('批量分析單詞時出錯:', error);
        return {}; // 返回空對象表示失敗
    }
}

// 修改後的函式：從預加載的數據顯示Tooltip
function analyzeWordInContext(word, sentence, event) {
    const targetElement = event.target;
    const selectedId = wordSelect.value;
    const currentWordData = vocabularyList.find(w => w.id === selectedId);

    // 從例句的DOM中找到其索引
    const exampleItem = targetElement.closest('.example-item');
    const exampleIndex = Array.from(examplesContainer.children).indexOf(exampleItem);
    
    if (!currentWordData || !currentWordData.examples[exampleIndex] || !currentWordData.examples[exampleIndex].analysis) {
        analysisTooltip.innerHTML = '<div class="tooltip-content"><p>無分析數據。</p></div>';
        analysisTooltip.style.display = 'block';
        repositionTooltip(targetElement);
        return;
    }
    
    const analysisData = currentWordData.examples[exampleIndex].analysis;
    const normalizedWord = word.toLowerCase();
    let wordAnalysis = analysisData[normalizedWord];

    // 如果直接查找失敗，嘗試更寬鬆的匹配，處理鍵中可能包含標點的情況
    if (!wordAnalysis) {
        const analysisKeys = Object.keys(analysisData);
        const matchingKey = analysisKeys.find(key =>
            key.replace(/[^a-z-]/g, '') === normalizedWord
        );
        if (matchingKey) {
            wordAnalysis = analysisData[matchingKey];
        }
    }

    if (wordAnalysis) {
        analysisTooltip.innerHTML = `
            <div class="tooltip-title">${word} (${wordAnalysis.pos})</div>
            <div class="tooltip-content">
                <p><strong>作用:</strong> ${wordAnalysis.role}</p>
                <p><strong>意思:</strong> ${wordAnalysis.meaning}</p>
            </div>
        `;
    } else {
        analysisTooltip.innerHTML = `<div class="tooltip-content"><p>單詞 "${word}" 的分析數據未找到。</p></div>`;
    }

    analysisTooltip.style.visibility = 'hidden';
    analysisTooltip.style.display = 'block';
    repositionTooltip(targetElement);
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

// 新增：文章詳解歷史記錄功能
function saveAnalyzedArticles() {
    localStorage.setItem('analyzedArticles', JSON.stringify(analyzedArticles));
}

function loadAnalyzedArticles() {
    const saved = localStorage.getItem('analyzedArticles');
    analyzedArticles = saved ? JSON.parse(saved) : [];
}

function populateArticleHistorySelect() {
    articleHistorySelect.innerHTML = '<option value="">讀取歷史記錄</option>';
    analyzedArticles.forEach((item, index) => {
        const option = document.createElement('option');
        option.value = index;
        // 截取文章前20個字符作為標題
        const title = item.article.substring(0, 20) + '...';
        option.textContent = title;
        articleHistorySelect.appendChild(option);
    });
}

function saveAnalysisResult(article, result) {
    // 檢查是否已存在相同的文章，如果存在則更新
    const existingIndex = analyzedArticles.findIndex(item => item.article === article);
    if (existingIndex > -1) {
        analyzedArticles[existingIndex].result = result;
    } else {
        analyzedArticles.push({ article, result });
    }
    saveAnalyzedArticles();
    populateArticleHistorySelect();
}

function loadSelectedArticle() {
    const selectedIndex = articleHistorySelect.value;
    if (selectedIndex === '') {
        clearArticleInput();
        return;
    }
    
    const item = analyzedArticles[selectedIndex];
    if (item) {
        articleInput.value = item.article;
        displayArticleAnalysis(item.article, item.result);
    }
}

function deleteSelectedArticleHistory() {
    const selectedIndex = articleHistorySelect.value;
    if (selectedIndex === '') {
        alert('請先選擇一個歷史記錄！');
        return;
    }
    
    if (confirm('確定要刪除這條歷史記錄嗎？')) {
        analyzedArticles.splice(selectedIndex, 1);
        saveAnalyzedArticles();
        populateArticleHistorySelect();
        clearArticleInput();
    }
}

function clearArticleInput() {
    articleInput.value = '';
    articleAnalysisContainer.innerHTML = '<p>請先輸入文章並點擊分析按鈕。</p>';
    articleHistorySelect.value = '';
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