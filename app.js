// =================================
// 全局變量 (重構後)
// =================================
let vocabularyBooks = []; // { id: string, name: string, words: [...] }[]
let activeBookId = null;
let currentDictationIndex = -1;
let dictationInterval;
let dictationTimeout;
let isDictationPaused = false;
let synth = window.speechSynthesis;
let ttsAudio; // 用於TTS API的音頻對象

// 測驗相關變量
let quizQuestions = [];
let currentQuestionIndex = 0;
let quizScore = 0;
let selectedAnswer = null;
let quizInProgress = false;

// =================================
// DOM元素 (重構後)
// =================================
const navBtns = document.querySelectorAll('.nav-btn');
const sections = document.querySelectorAll('.section');

// 單詞本頁面
const vocabBookList = document.getElementById('vocab-book-list');
const addVocabBookBtn = document.getElementById('add-vocab-book-btn');
const importVocabBookBtn = document.getElementById('import-vocab-book-btn');
const currentBookName = document.getElementById('current-book-name');
const editVocabBookBtn = document.getElementById('edit-vocab-book-btn');
const deleteVocabBookBtn = document.getElementById('delete-vocab-book-btn');
const exportVocabBookBtn = document.getElementById('export-vocab-book-btn');
const wordList = document.getElementById('word-list');

// 學習模式頁面
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

// 默寫模式頁面
const repeatTimes = document.getElementById('repeat-times');
const wordInterval = document.getElementById('word-interval');
const readMeaning = document.getElementById('read-meaning');
const loopMode = document.getElementById('loop-mode');
const startDictationBtn = document.getElementById('start-dictation-btn');
const stopDictationBtn = document.getElementById('stop-dictation-btn');
const pauseDictationBtn = document.getElementById('pause-dictation-btn');
const replayDictationBtn = document.getElementById('replay-dictation-btn');
const dictationWordDisplay = document.getElementById('dictation-word-display');
const dictationInput = document.getElementById('dictation-input');
const checkDictationBtn = document.getElementById('check-dictation-btn');
const dictationResult = document.getElementById('dictation-result');
const dictationBookSelector = document.getElementById('dictation-book-selector');
const listenOnlyMode = document.getElementById('listen-only-mode');
const dictationPractice = document.querySelector('.dictation-practice');
const dictationProgressContainer = document.getElementById('dictation-progress-container');
const dictationProgressBar = document.getElementById('dictation-progress-bar');
const dictationProgressText = document.getElementById('dictation-progress-text');

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
const readArticleBtn = document.getElementById('read-article-btn');
const stopReadArticleBtn = document.getElementById('stop-read-article-btn');
const pauseResumeArticleBtn = document.getElementById('pause-resume-article-btn');
const downloadAudioBtn = document.getElementById('download-audio-btn');
const readingModeSelect = document.getElementById('reading-mode');
const speedBtnGroup = document.getElementById('speed-control-group');
const chunkNavControls = document.getElementById('chunk-nav-controls');
const prevChunkBtn = document.getElementById('prev-chunk-btn');
const nextChunkBtn = document.getElementById('next-chunk-btn');
const chunkProgressSpan = document.getElementById('chunk-progress');
const chunkRepeatControls = document.getElementById('chunk-repeat-controls');
const chunkRepeatTimes = document.getElementById('chunk-repeat-times');
const currentSentenceDisplay = document.getElementById('current-sentence-display');


// 文章詳解相關變量
let analyzedArticles = [];
let readingChunks = [];
let currentChunkIndex = 0;
let isReadingChunkPaused = false;
let currentSpeed = 0;
let sentenceRepeatCount = 0;

// Modal DOM 元素
const appModal = document.getElementById('app-modal');
const modalTitle = document.getElementById('modal-title');
const modalBody = document.getElementById('modal-body');
const modalCloseBtn = appModal.querySelector('.modal-close-btn');


// =================================
// 初始化與事件監聽 (重構後)
// =================================
document.addEventListener('DOMContentLoaded', () => {
    loadVocabularyBooks();
    loadAnalyzedArticles();
    renderVocabBookList();
    updateActiveBookView();
    populateArticleHistorySelect();
    setupEventListeners();
    // 手動觸發一次change事件來更新初始狀態
    listenOnlyMode.dispatchEvent(new Event('change'));
});

function setupEventListeners() {
    // 導航按鈕
    navBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            if (quizInProgress && btn.id !== 'quiz-btn') {
                if (!confirm('測驗正在進行中，確定要離開嗎？')) { return; }
                stopQuiz();
            }
            
            // 檢查是否正在進行默寫以及是否要離開默寫頁面
            const isDictationRunning = !stopDictationBtn.disabled;
            const isLeavingDictationSection = btn.id !== 'dictation-btn';
            
            // 根據新的需求，浮動條的顯示/隱藏只由默寫的開始和停止決定，
            // 不再與頁面切換掛鉤。

            navBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            
            const targetId = btn.id.replace('-btn', '-section');
            sections.forEach(section => {
                section.classList.toggle('active', section.id === targetId);
            });

            // 切換到默寫頁面時，更新單詞本選擇器
            if (targetId === 'dictation-section') {
                populateDictationBookSelector();
            }
        });
    });

    // 單詞本面板事件
    addVocabBookBtn.addEventListener('click', () => openModalForNewBook());
    vocabBookList.addEventListener('click', handleVocabBookSelection);
    editVocabBookBtn.addEventListener('click', () => openModalForEditBook());
    deleteVocabBookBtn.addEventListener('click', deleteActiveVocabBook);
    importVocabBookBtn.addEventListener('click', openModalForImportBook);
    exportVocabBookBtn.addEventListener('click', exportActiveVocabBook);

    // Modal 事件
    modalCloseBtn.addEventListener('click', closeModal);
    appModal.addEventListener('click', (e) => {
        if (e.target === appModal) {
            closeModal();
        }
    });
    
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
    pauseDictationBtn.addEventListener('click', togglePauseDictation);
    replayDictationBtn.addEventListener('click', replayCurrentDictationWord);
    checkDictationBtn.addEventListener('click', checkDictation);
    listenOnlyMode.addEventListener('change', () => {
        dictationPractice.classList.toggle('hidden', listenOnlyMode.checked);
    });
    
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
    readArticleBtn.addEventListener('click', readArticle);
    stopReadArticleBtn.addEventListener('click', stopReadArticle);
    pauseResumeArticleBtn.addEventListener('click', togglePauseResume);
    downloadAudioBtn.addEventListener('click', downloadAudio);
    
    speedBtnGroup.addEventListener('click', (e) => {
        if (e.target.classList.contains('speed-btn')) {
            speedBtnGroup.querySelectorAll('.speed-btn').forEach(btn => btn.classList.remove('active'));
            e.target.classList.add('active');
            currentSpeed = parseInt(e.target.dataset.speed, 10);
        }
    });

    readingModeSelect.addEventListener('change', () => {
        stopReadArticle();
        const mode = readingModeSelect.value;
        const isChunkMode = mode === 'sentence' || mode === 'paragraph';
        chunkRepeatControls.classList.toggle('hidden', !isChunkMode);
        
        let navText = '句';
        if (mode === 'paragraph') {
            navText = '段';
        }
        prevChunkBtn.textContent = `上一${navText}`;
        nextChunkBtn.textContent = `下一${navText}`;
    });
    prevChunkBtn.addEventListener('click', playPrevChunk);
    nextChunkBtn.addEventListener('click', playNextChunk);
    
    
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
    
    const navTextElements = document.querySelectorAll('.nav-text');

    const updateNavText = () => {
        const screenWidth = window.innerWidth;
        navTextElements.forEach(el => {
            if (screenWidth <= 480) {
                el.style.display = 'none';
            } else if (screenWidth <= 768) {
                el.style.display = 'inline';
                el.textContent = el.dataset.shortText;
            } else {
                el.style.display = 'inline';
                el.textContent = el.dataset.fullText;
            }
        });
    };
    window.addEventListener('resize', updateNavText);
    updateNavText(); // Initial check

    // 頁面可見性變化事件，確保浮動控件在切換標籤頁後能恢復
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            const isDictationRunning = !stopDictationBtn.disabled;
            // 如果默寫正在運行，就顯示浮動控件
            if (isDictationRunning) {
                showFloatingControls();
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
    
    // 按段落分割文章
    const paragraphs = articleText.split(/\n+/).filter(p => p.trim() !== '');
    
    if (paragraphs.length === 0) {
        alert('請輸入有效的文章內容！');
        analyzeArticleBtn.disabled = false;
        analyzeArticleBtn.textContent = '分析文章';
        return;
    }

    // 顯示初始進度
    articleAnalysisContainer.innerHTML = `
        <div class="analysis-progress">
            <p>正在分析文章，共 ${paragraphs.length} 個段落...</p>
            <div class="progress-bar">
                <div class="progress-fill" style="width: 0%"></div>
            </div>
            <p class="progress-text">準備中... (0/${paragraphs.length})</p>
        </div>
    `;

    try {
        // 存儲所有段落的分析結果
        let combinedTranslation = '';
        let combinedWordAlignment = [];
        let paragraphAnalyses = [];
        let combinedDetailedAnalysis = [];
        
        // 逐段落分析
        for (let i = 0; i < paragraphs.length; i++) {
            const paragraph = paragraphs[i];
            
            // 更新進度
            updateAnalysisProgress(i, paragraphs.length, `正在分析第 ${i + 1} 段...`);
            
            try {
                const paragraphResult = await analyzeParagraph(paragraph);
                
                // [BUG FIX] 修正重複添加，只添加一次
                paragraphAnalyses.push(paragraphResult);

                // 合併總翻譯和總詞語對齊
                if (paragraphResult.chinese_translation) {
                    combinedTranslation += (combinedTranslation ? '\n\n' : '') + paragraphResult.chinese_translation;
                }
                
                if (paragraphResult.word_alignment) {
                    combinedWordAlignment = combinedWordAlignment.concat(paragraphResult.word_alignment);
                }
                
                // [BUG FIX] 不再手動合併 combinedDetailedAnalysis。
                // 這是之前 Bug 的根源。我們將在下面從 paragraphAnalyses 陣列直接生成。
                
                // 更新進度顯示已完成的段落
                updateAnalysisProgress(i + 1, paragraphs.length, `已完成 ${i + 1} 段分析`);
                
            } catch (error) {
                console.error(`分析第 ${i + 1} 段時出錯:`, error);
                updateAnalysisProgress(i + 1, paragraphs.length, `第 ${i + 1} 段分析失敗，繼續下一段...`);
                
                // 添加失敗段落的基本處理
                const failedResult = {
                    chinese_translation: `[第 ${i + 1} 段分析失敗]`,
                    word_alignment: [],
                    detailed_analysis: []
                };
                paragraphAnalyses.push(failedResult);
                combinedTranslation += (combinedTranslation ? '\n\n' : '') + failedResult.chinese_translation;
            }
        }

        // 組合最終結果
        const finalResult = {
            chinese_translation: combinedTranslation,
            word_alignment: combinedWordAlignment,
            detailed_analysis: paragraphAnalyses.flatMap(p => p.detailed_analysis || []),
            paragraph_analysis: paragraphAnalyses
        };

        // 顯示最終結果
        articleAnalysisContainer.dataset.analysis = JSON.stringify(finalResult.detailed_analysis || []);
        displayArticleAnalysis(articleText, finalResult);
        saveAnalysisResult(articleText, finalResult);

    } catch (error) {
        console.error('分析文章時出錯:', error);
        articleAnalysisContainer.innerHTML = `<p style="color: red;">分析失敗！請檢查API Key或網絡連接後再試。</p>`;
        alert('分析文章失敗，請稍後再試。');
    } finally {
        analyzeArticleBtn.disabled = false;
        analyzeArticleBtn.textContent = '分析文章';
    }
}

// 分析單個段落的函數
async function analyzeParagraph(paragraph) {
    const prompt = `請對以下英文段落進行全面、深入的語法和語義分析，並嚴格按照指定的JSON格式返回結果。

段落: "${paragraph}"

請返回一個JSON對象，包含以下三個鍵:
1. "chinese_translation": 字符串，為此段落的流暢中文翻譯。
2. "word_alignment": 數組，每個元素是一個對象 {"en": "英文單詞", "zh": "對應的中文詞語"}，用於實現英漢詞語對照高亮。
3. "detailed_analysis": 一個 **數組**，其中每個元素都是一個對象，代表段落中一個具體單詞的分析。
   - **重要**: 這個數組中的對象必須嚴格按照單詞在原文中出現的順序排列。
   - **重要**: 如果同一個單詞在段落中出現多次，請為每一次出現都創建一個獨立的分析對象。
   - 每個對象的結構如下:
     {
       "word": "被分析的單詞原文",
       "sentence": "該單詞所在的完整句子",
       "analysis": {
         "phonetic": "該單詞的國際音標(IPA)，例如 'ˈæpəl'",
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

請只返回JSON格式的數據，不要包含任何額外的解釋性文字或標記。
**極其重要**: JSON值內的所有雙引號都必須使用反斜杠進行轉義 (例如，寫成 \\" 而不是 ")。如果一個單詞的分析中需要引用其他單詞，請使用單引號或確保雙引號被正確轉義，否則會導致嚴重的解析錯誤。`;

    const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${API_KEY}`
        },
        body: JSON.stringify({
            model: AI_MODELS.exampleGeneration,
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
    let content = data.choices[0].message.content.replace(/^```json\n/, '').replace(/\n```$/, '').trim();

    try {
        // 優先嘗試直接解析，因為這是最快且最標準的方式。
        return JSON.parse(content);
    } catch (error) {
        console.warn("常規 JSON 解析失敗，啟動備用解析策略。", `錯誤: ${error.message}`);
        
        // 備用策略 1: 嘗試修復常見的 AI 生成錯誤，例如在字串值末尾多餘的引號。
        // 這個正則表達式尋找一個單詞字符或單引號，後面跟著一個雙引號，
        // 再後面是任意空格和一個逗號或右大括號。然後它會移除那個多餘的雙引號。
        // 例如: "role": "... 'cars'\" }" 會被修正為 "role": "... 'cars' }"
        let fixedContent = content.replace(/([\w'])\"(\s*[,}])/g, '$1$2');

        if (content !== fixedContent) {
            console.log("已應用啟發式修復，正在嘗試重新解析...");
            try {
                return JSON.parse(fixedContent);
            } catch (e1) {
                console.warn("啟發式修復後解析失敗。繼續下一個策略。", `錯誤: ${e1.message}`);
            }
        }

        // 備用策略 2: 提取第一個 '{' 和最後一個 '}' 之間的內容。
        // 這可以處理 AI 在 JSON 前後添加了額外文字的情況。
        const firstBrace = content.indexOf('{');
        const lastBrace = content.lastIndexOf('}');

        if (firstBrace !== -1 && lastBrace > firstBrace) {
            const potentialJson = content.substring(firstBrace, lastBrace + 1);
            console.log("正在嘗試解析提取出的 JSON 內容...");
            try {
                return JSON.parse(potentialJson);
            } catch (e2) {
                 console.error("所有備用解析策略均失敗。", `提取後解析錯誤: ${e2.message}`);
            }
        }

        // 如果所有方法都失敗了，則記錄完整的上下文並拋出原始錯誤。
        console.error("徹底解析失敗。無法從以下內容中恢復 JSON:", content);
        throw error;
    }
}

// 更新分析進度的函數
function updateAnalysisProgress(completed, total, message) {
    const progressFill = document.querySelector('.progress-fill');
    const progressText = document.querySelector('.progress-text');
    
    if (progressFill && progressText) {
        const percentage = (completed / total) * 100;
        progressFill.style.width = `${percentage}%`;
        progressText.textContent = `${message} (${completed}/${total})`;
    }
}

function displayArticleAnalysis(originalArticle, analysisResult) {
    const { chinese_translation, word_alignment, detailed_analysis, paragraph_analysis } = analysisResult;

    if (!chinese_translation && (!paragraph_analysis || paragraph_analysis.length === 0)) {
        articleAnalysisContainer.innerHTML = `<p style="color: red;">API返回的數據格式不完整，無法顯示分析結果。</p>`;
        return;
    }

    // 按段落分割原文和翻譯
    const englishParagraphs = originalArticle.split(/\n+/).filter(p => p.trim() !== '');
    const chineseParagraphs = chinese_translation.split(/\n+/).filter(p => p.trim() !== '');
    
    const escapeRegex = (string) => string ? string.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&') : '';

    // 建立段落級別的顯示
    let htmlContent = '';
    
    for (let i = 0; i < Math.max(englishParagraphs.length, chineseParagraphs.length); i++) {
        const englishPara = englishParagraphs[i] || '';
        const chinesePara = chineseParagraphs[i] || '';
        
        if (!englishPara && !chinesePara) continue;
        
        // 處理該段落的單詞分析
        let processedEnglish = englishPara;
        let processedChinese = chinesePara;
        
        // 為當前段落找到相關的單詞分析
        const paragraphWords = (paragraph_analysis && paragraph_analysis[i] && paragraph_analysis[i].detailed_analysis)
            ? paragraph_analysis[i].detailed_analysis
            : [];
        
        // 建立單詞映射
        let cursor = 0;
        const wordStartMap = new Map();
        paragraphWords.forEach(item => {
            const word = item.word;
            if (!word) return;
            const wordRegex = new RegExp(`\\b${escapeRegex(word)}\\b`);
            const match = englishPara.substring(cursor).match(wordRegex);
            if (match) {
                const startIndex = cursor + match.index;
                item.startIndex = startIndex;
                item.endIndex = startIndex + word.length;
                wordStartMap.set(startIndex, item);
                cursor = item.startIndex + 1;
            }
        });
        
        // 處理詞語對齊高亮
        const relevantAlignment = word_alignment.filter(pair =>
            englishPara.includes(pair.en) && chinesePara.includes(pair.zh)
        );
        
        const sortedAlignment = [...relevantAlignment].sort((a, b) => (b.en?.length || 0) - (a.en?.length || 0));
        const processedPhrases = new Array(englishPara.length).fill(false);

        sortedAlignment.forEach((pair, index) => {
            if (!pair.en || !pair.zh) return;

            let phraseIndex = -1;
            let tempCursor = 0;
            while ((phraseIndex = englishPara.indexOf(pair.en, tempCursor)) !== -1) {
                if (!processedPhrases[phraseIndex]) {
                    break;
                }
                tempCursor = phraseIndex + 1;
            }

            if (phraseIndex !== -1) {
                const phraseEndIndex = phraseIndex + pair.en.length;
                const pairId = `para-${i}-pair-${index}`;

                for (let j = phraseIndex; j < phraseEndIndex; j++) {
                    if (wordStartMap.has(j)) {
                        const wordItem = wordStartMap.get(j);
                        if (wordItem.endIndex <= phraseEndIndex) {
                            wordItem.pairId = pairId;
                        }
                    }
                }
                
                for (let j = phraseIndex; j < phraseEndIndex; j++) {
                    processedPhrases[j] = true;
                }

                const zhRegex = new RegExp(`(?<!<span[^>]*>)(${escapeRegex(pair.zh)})(?!<\\/span>)`);
                processedChinese = processedChinese.replace(zhRegex, `<span class="interactive-word" data-pair-id="${pairId}">${pair.zh}</span>`);
            }
        });

        // 處理英文單詞（添加互動性和音標）
        let processedEnglishFinal = '';
        let lastIndex = 0;
        const wordCounts = {};
        paragraphWords.forEach(item => {
            if (item.startIndex === undefined) return;
            
            processedEnglishFinal += englishPara.substring(lastIndex, item.startIndex);
            
            const wordLower = item.word.toLowerCase();
            const wordIndex = wordCounts[wordLower] || 0;
            
            // 獲取音標 - 現在直接從 analysis 中獲取
            const phonetic = item.analysis?.phonetic || '';
            const phoneticDisplay = phonetic ? `/${phonetic}/` : '';
            
            processedEnglishFinal += `<span class="interactive-word" data-word="${item.word}" data-word-index="${wordIndex}" data-pair-id="${item.pairId || ''}" title="${item.analysis?.meaning || ''}">${item.word}</span>`;
            wordCounts[wordLower] = wordIndex + 1;
            lastIndex = item.endIndex;
        });
        processedEnglishFinal += englishPara.substring(lastIndex);
        
        // 添加段落到HTML
        htmlContent += `
            <div class="paragraph-pair">
                <div class="paragraph-english">${processedEnglishFinal}</div>
                <div class="paragraph-chinese">${processedChinese}</div>
            </div>
        `;
    }
    
    articleAnalysisContainer.innerHTML = htmlContent;
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
    
    const matchingAnalyses = analysisArray.filter(item => item.word.toLowerCase() === wordText.toLowerCase());

    const wordAnalysisData = (wordIndex < matchingAnalyses.length)
        ? matchingAnalyses[wordIndex]
        : null;

    if (wordAnalysisData && wordAnalysisData.analysis) {
        const analysis = wordAnalysisData.analysis;
        const phonetic = analysis.phonetic || '';
        const phoneticDisplay = phonetic ? ` /${phonetic.replace(/^\/|\/$/g, '')}/` : '';
        
        // 先建立結構，音標部分留空
        analysisTooltip.innerHTML = `
            <div class="tooltip-title">${wordAnalysisData.word}<span class="tooltip-phonetic">${phoneticDisplay}</span> (${analysis.pos})</div>
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


// 文章朗讀增強功能
function readArticle() {
    const text = articleInput.value.trim();
    if (!text) {
        alert('請先輸入要朗讀的文章！');
        return;
    }

    if (ttsAudio && ttsAudio.paused) {
        togglePauseResume();
        return;
    }

    const mode = readingModeSelect.value;
    isReadingChunkPaused = false;

    const chunkMode = (mode === 'full') ? 'sentence' : mode;
    readingChunks = splitText(text, chunkMode);

    if (readingChunks.length > 0) {
        currentChunkIndex = 0;
        
        if (mode === 'full') {
            chunkNavControls.classList.add('hidden');
        } else {
            updateChunkNav();
            chunkNavControls.classList.remove('hidden');
        }
        
        playCurrentChunk();
    }
}

function stopCurrentAudio() {
    if (ttsAudio) {
        ttsAudio.onended = null;
        ttsAudio.onerror = null;
        if (!ttsAudio.paused) {
            ttsAudio.pause();
        }
        ttsAudio.src = '';
        ttsAudio = null;
    }
}

function stopReadArticle() {
    stopCurrentAudio();
    isReadingChunkPaused = false;
    readArticleBtn.disabled = false;
    stopReadArticleBtn.disabled = true;
    pauseResumeArticleBtn.disabled = true;
    updatePauseResumeIcon(false);
    
    const mode = readingModeSelect.value;
    if (mode === 'paragraph' || mode === 'sentence') {
        updateChunkNav();
    } else {
        chunkNavControls.classList.add('hidden');
    }

    highlightCurrentChunk(null);
    if(currentSentenceDisplay) {
        currentSentenceDisplay.textContent = '';
    }
}

function playCurrentChunk() {
    if (currentChunkIndex < 0 || currentChunkIndex >= readingChunks.length) {
        stopReadArticle();
        return;
    }

    const chunk = readingChunks[currentChunkIndex];
    highlightCurrentChunk(chunk);
    if(currentSentenceDisplay){
        currentSentenceDisplay.textContent = chunk;
    }

    const mode = readingModeSelect.value;
    const isChunkMode = mode === 'sentence' || mode === 'paragraph';
    const repeatTimesVal = isChunkMode ? parseInt(chunkRepeatTimes.value, 10) : 1;

    const onStart = () => {
        readArticleBtn.disabled = true;
        stopReadArticleBtn.disabled = false;
        updateChunkNav();
    };
    
    const onEnd = () => {
        sentenceRepeatCount++;
        if (isReadingChunkPaused) {
            return;
        }
        if (sentenceRepeatCount < repeatTimesVal) {
            playCurrentChunk();
        } else {
            const isLastChunk = currentChunkIndex >= readingChunks.length - 1;
            
            if (!isLastChunk) {
                currentChunkIndex++;
                sentenceRepeatCount = 0;
                playCurrentChunk();
            } else {
                 stopReadArticle();
            }
        }
    };

    speakText(chunk, 'en-US', currentSpeed, onStart, onEnd);
}

function playNextChunk() {
    if (currentChunkIndex < readingChunks.length - 1) {
        stopCurrentAudio();
        currentChunkIndex++;
        sentenceRepeatCount = 0;
        isReadingChunkPaused = false;
        playCurrentChunk();
    }
}

function playPrevChunk() {
    if (currentChunkIndex > 0) {
        stopCurrentAudio();
        currentChunkIndex--;
        sentenceRepeatCount = 0;
        isReadingChunkPaused = false;
        playCurrentChunk();
    }
}

function togglePauseResume() {
    if (!ttsAudio) return;

    if (ttsAudio.paused) {
        ttsAudio.play().catch(e => console.error("恢復播放失敗", e));
        isReadingChunkPaused = false;
        updatePauseResumeIcon(false);
    } else {
        ttsAudio.pause();
        isReadingChunkPaused = true;
        updatePauseResumeIcon(true);
    }
}

function updatePauseResumeIcon(isPaused) {
    const icon = pauseResumeArticleBtn.querySelector('svg');
    if (isPaused) {
        icon.innerHTML = '<path d="m11.596 8.697-6.363 3.692c-.54.313-1.233-.066-1.233-.697V4.308c0-.63.692-1.01 1.233-.696l6.363 3.692a.802.802 0 0 1 0 1.393z"/>';
        pauseResumeArticleBtn.title = "繼續";
    } else {
        icon.innerHTML = '<path d="M5.5 3.5A1.5 1.5 0 0 1 7 5v6a1.5 1.5 0 0 1-3 0V5a1.5 1.5 0 0 1 1.5-1.5m5 0A1.5 1.5 0 0 1 12 5v6a1.5 1.5 0 0 1-3 0V5a1.5 1.5 0 0 1 1.5-1.5z"/>';
        pauseResumeArticleBtn.title = "暫停";
    }
}

function updateChunkNav() {
    chunkProgressSpan.textContent = `${currentChunkIndex + 1} / ${readingChunks.length}`;
    prevChunkBtn.disabled = currentChunkIndex === 0;
    nextChunkBtn.disabled = currentChunkIndex === readingChunks.length - 1;
}

function splitText(text, mode) {
    if (mode === 'paragraph') {
        return text.split(/\n+/).filter(p => p.trim() !== '');
    } else if (mode === 'sentence') {
        return text.match(/[^.!?]+[.!?]*/g) || [];
    }
    return [text];
}

function highlightCurrentChunk(chunk) {
    let analysisContent = articleAnalysisContainer.innerHTML;
    analysisContent = analysisContent.replace(/<span class="highlight-reading">(.*?)<\/span>/gs, '$1');
     if (chunk) {
        analysisContent = analysisContent.replace(chunk, `<span class="highlight-reading">${chunk}</span>`);
    }
    articleAnalysisContainer.innerHTML = analysisContent;
}

async function downloadAudio() {
    const text = articleInput.value.trim();
    if (!text) {
        alert('請先輸入要下載的文章！');
        return;
    }
    const voice = TTS_CONFIG.voices.english;
    const url = `${TTS_CONFIG.baseUrl}/tts?t=${encodeURIComponent(text)}&v=${voice}&r=${currentSpeed}`;

    downloadAudioBtn.textContent = '下載中...';
    downloadAudioBtn.disabled = true;

    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`網絡響應錯誤: ${response.statusText}`);
        }
        const blob = await response.blob();
        const downloadUrl = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
a.style.display = 'none';
        a.href = downloadUrl;
        a.download = 'article_audio.mp3';
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(downloadUrl);
        a.remove();
    } catch (error) {
        console.error('下載音頻失敗:', error);
        alert('下載音頻失敗，請稍後再試。');
    } finally {
        downloadAudioBtn.textContent = '下載語音';
        downloadAudioBtn.disabled = false;
    }
}


// =================================
// 單詞本管理 (重構後)
// =================================

function renderVocabBookList() {
    vocabBookList.innerHTML = '';
    if (vocabularyBooks.length === 0) {
        vocabBookList.innerHTML = '<li class="word-item-placeholder">還沒有單詞本</li>';
        return;
    }
    vocabularyBooks.forEach(book => {
        const li = document.createElement('li');
        li.className = 'vocab-book-item';
        li.dataset.bookId = book.id;
        if (book.id === activeBookId) {
            li.classList.add('active');
        }
        li.innerHTML = `<span>${book.name}</span> <span class="word-count">${book.words.length}</span>`;
        vocabBookList.appendChild(li);
    });
}

function handleVocabBookSelection(e) {
    const target = e.target.closest('.vocab-book-item');
    if (target) {
        const bookId = target.dataset.bookId;
        if (activeBookId !== bookId) {
            activeBookId = bookId;
            saveAppState();
            renderVocabBookList();
            updateActiveBookView();
        }
    }
}

function updateActiveBookView() {
    const activeBook = vocabularyBooks.find(b => b.id === activeBookId);
    if (activeBook) {
        currentBookName.textContent = activeBook.name;
        editVocabBookBtn.disabled = false;
        deleteVocabBookBtn.disabled = false;
        exportVocabBookBtn.disabled = false;
        renderWordList();
        populateWordSelect();
    } else {
        currentBookName.textContent = '請選擇一個單詞本';
        editVocabBookBtn.disabled = true;
        deleteVocabBookBtn.disabled = true;
        exportVocabBookBtn.disabled = true;
        wordList.innerHTML = '<li class="word-item-placeholder">請從左側選擇或創建一個單詞本</li>';
        populateWordSelect();
    }
}

function openModalForNewBook() {
    modalTitle.textContent = '新增單詞本';
    modalBody.innerHTML = `
        <div class="input-group">
            <label for="modal-book-name">單詞本名稱</label>
            <input type="text" id="modal-book-name" placeholder="例如：雅思核心詞彙">
        </div>
        <div class="modal-actions">
            <button class="cancel-btn">取消</button>
            <button class="save-btn">創建</button>
        </div>
    `;
    appModal.querySelector('.save-btn').onclick = () => saveVocabBook();
    appModal.querySelector('.cancel-btn').onclick = closeModal;
    openModal();
}

function openModalForEditBook() {
    const book = vocabularyBooks.find(b => b.id === activeBookId);
    if (!book) return;

    modalTitle.textContent = '編輯單詞本 - ' + book.name;
    const wordsText = book.words.map(w => {
        const phonetic = (w.phonetic || '').replace(/^\/+|\/+$/g, '');
        return `${w.word}#${w.meaning || ''}@/${phonetic}/`;
    }).join('\n');
    modalBody.innerHTML = `
        <div class="input-group">
            <label for="modal-book-name">單詞本名稱</label>
            <input type="text" id="modal-book-name" value="${book.name}">
        </div>
        <div class="input-group">
            <label for="modal-vocab-content">單詞內容 (格式: 單詞#中文@音標)</label>
            <textarea id="modal-vocab-content">${wordsText}</textarea>
        </div>
        <div class="modal-actions">
            <button class="cancel-btn">取消</button>
            <button class="save-btn">保存更改</button>
        </div>
    `;
    appModal.querySelector('.save-btn').onclick = () => saveVocabBook(book.id);
    appModal.querySelector('.cancel-btn').onclick = closeModal;
    openModal();
}

async function openModalForImportBook() {
    modalTitle.textContent = '導入單詞本';
    modalBody.innerHTML = `<p>正在加載預設單詞本...</p>`;
    openModal();

    try {
        const defaultBooks = await fetchDefaultWordlists();
        if (defaultBooks.length === 0) {
            modalBody.innerHTML = `<p>沒有找到可用的預設單詞本。</p>`;
            return;
        }

        let presetItemsHtml = defaultBooks.map(book => {
            const safeId = `import-${book.path.replace(/[^a-zA-Z0-9]/g, '')}`;
            return `
                <div class="import-preset-item-wrapper">
                    <input type="checkbox" id="${safeId}" value="${book.path}" data-name="${book.name}" class="import-checkbox">
                    <label for="${safeId}" class="import-preset-item">${book.name}</label>
                </div>
            `;
        }).join('');

        modalBody.innerHTML = `
            <div class="import-container">
                <div class="import-section">
                    <h4 class="import-section-title">從預設列表選擇</h4>
                    <div id="modal-import-list" class="import-preset-list">
                        ${presetItemsHtml}
                    </div>
                </div>
                <div class="import-section">
                    <h4 class="import-section-title">從URL導入</h4>
                    <div class="input-group">
                         <label for="modal-import-url">單詞本URL</label>
                         <input type="url" id="modal-import-url" placeholder="https://example.com/words.json">
                    </div>
                </div>
                <div class="import-section">
                    <h4 class="import-section-title">從文件導入</h4>
                    <div class="input-group">
                        <label for="modal-import-file">選擇JSON文件</label>
                        <input type="file" id="modal-import-file" accept=".json">
                    </div>
                </div>
            </div>
            <div id="modal-import-progress" class="import-progress"></div>
            <div class="modal-actions">
                <button class="cancel-btn">取消</button>
                <button class="save-btn">導入選中</button>
            </div>
        `;
        appModal.querySelector('.save-btn').onclick = () => importSharedVocabBooks();
        appModal.querySelector('.cancel-btn').onclick = closeModal;

    } catch (error) {
        console.error('加載預設單詞本失敗:', error);
        modalBody.innerHTML = `<p style="color: red;">加載失敗，請稍後再試。</p>`;
    }
}

async function fetchDefaultWordlists() {
    // 使用預打包的數據，避免在 file:// 協議下 fetch 失敗
    try {
        const response = await fetchPrepackagedData('wordlists/manifest.json');
        const manifest = await response.json();
        return manifest;
    } catch (error) {
        console.error("獲取預設單詞本列表時出錯 (從預打包數據):", error);
        return [];
    }
}

async function importSharedVocabBooks() {
    const selectedCheckboxes = document.querySelectorAll('#modal-import-list input[type="checkbox"]:checked');
    const urlInput = document.getElementById('modal-import-url');
    const fileInput = document.getElementById('modal-import-file');
    const progressContainer = document.getElementById('modal-import-progress');

    const urlPath = urlInput.value.trim();
    const file = fileInput.files[0];

    let sources = Array.from(selectedCheckboxes).map(cb => ({ type: 'preset', value: cb.value, name: cb.dataset.name }));

    if (urlPath) {
        try {
            const url = new URL(urlPath);
            sources.push({ type: 'url', value: urlPath, name: url.pathname.split('/').pop() || 'URL單詞本' });
        } catch (_) {
            alert(`"${urlPath}" 不是一個有效的URL。`);
            return;
        }
    }

    if (file) {
        sources.push({ type: 'file', value: file, name: file.name });
    }

    if (sources.length === 0) {
        alert('請至少選擇一個預設單詞本、提供一個URL或選擇一個文件。');
        return;
    }

    const saveBtn = appModal.querySelector('.save-btn');
    saveBtn.disabled = true;
    saveBtn.textContent = '正在導入...';
    progressContainer.innerHTML = '';

    let successCount = 0;
    let finalMessage = '導入完成！\n\n';

    for (const source of sources) {
        try {
            progressContainer.innerHTML = `<p>正在處理: ${source.name}...</p>`;
            let bookData;

            if (source.type === 'preset' || source.type === 'url') {
                const response = source.type === 'url' ? await fetch(source.value) : await fetchPrepackagedData(source.value);
                if (!response.ok) throw new Error(`無法加載: ${source.name}`);
                bookData = await response.json();
            } else {
                bookData = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => {
                        try { resolve(JSON.parse(reader.result)); } catch (e) { reject(new Error('文件格式無效')); }
                    };
                    reader.onerror = () => reject(new Error('讀取文件失敗'));
                    reader.readAsText(source.value);
                });
            }

            if (!bookData.name || !Array.isArray(bookData.words)) {
                throw new Error(`數據源 ${source.name} 格式不正確。`);
            }

            const existingBookIndex = vocabularyBooks.findIndex(b => b.name === bookData.name);
            if (existingBookIndex > -1) {
                if (!confirm(`單詞本 "${bookData.name}" 已存在。要覆蓋它嗎？`)) {
                    finalMessage += `已跳過: ${bookData.name}\n`;
                    continue; // Skip to next source if user cancels
                }
            }

            const wordsWithDetails = [];
            for (let i = 0; i < bookData.words.length; i++) {
                const line = bookData.words[i];
                progressContainer.innerHTML = `<p>正在解析: ${line} (${i + 1}/${bookData.words.length})</p>`;
                
                const parsedWord = parseWordsFromText(line)[0];
                if (!parsedWord) continue;

                if (!parsedWord.meaning || !parsedWord.phonetic) {
                    const analysis = await getWordAnalysis(parsedWord.word);
                    parsedWord.phonetic = parsedWord.phonetic || (analysis.phonetic || 'n/a').replace(/^\/|\/$/g, '');
                    parsedWord.meaning = parsedWord.meaning || analysis.meaning || '';
                }
                wordsWithDetails.push(parsedWord);
            }

            const newBook = { id: Date.now().toString(), name: bookData.name, words: wordsWithDetails };
            
            if (existingBookIndex > -1) {
                vocabularyBooks[existingBookIndex] = { ...vocabularyBooks[existingBookIndex], ...newBook };
                 finalMessage += `已覆蓋: ${bookData.name}\n`;
            } else {
                vocabularyBooks.push(newBook);
                 finalMessage += `已導入: ${bookData.name}\n`;
            }
            activeBookId = newBook.id;
            successCount++;

        } catch (error) {
            console.error(`導入 ${source.name} 失敗:`, error);
            finalMessage += `導入失敗: ${source.name} (${error.message})\n`;
        }
    }
    
    if (successCount > 0) {
        saveVocabularyBooks();
        renderVocabBookList();
        updateActiveBookView();
    }
    
    alert(finalMessage);
    closeModal();
}

// 獲取單一單詞分析的簡化版API調用
async function getWordAnalysis(word) {
    try {
        const prompt = `Please provide a detailed analysis for the word "${word}". Return the result in a strict JSON format with the following keys: "phonetic" (IPA), "pos" (part of speech), and "meaning" (the most common Chinese meaning). For example: {"phonetic": "ɪɡˈzæmpəl", "pos": "noun", "meaning": "例子"}.`;
        const response = await fetch(API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}`
            },
            body: JSON.stringify({
                model: AI_MODELS.wordAnalysis,
                messages: [{ role: "user", content: prompt }],
                temperature: 0.2,
            })
        });

        if (!response.ok) {
            throw new Error(`API request failed with status: ${response.status}`);
        }

        const data = await response.json();
        const content = data.choices[0].message.content.replace(/^```json\n/, '').replace(/\n```$/, '');
        return JSON.parse(content);

    } catch (error) {
        console.error(`Error analyzing word "${word}":`, error);
        // 返回一個預設對象，這樣流程可以繼續
        return { phonetic: 'error', pos: '', meaning: '分析失敗' };
    }
}


function saveVocabBook(bookId = null) {
    const bookNameInput = document.getElementById('modal-book-name');
    const name = bookNameInput.value.trim();
    if (!name) {
        alert('單詞本名稱不能為空！');
        return;
    }

    if (bookId) { // 編輯模式
        const book = vocabularyBooks.find(b => b.id === bookId);
        if (book) {
            book.name = name;
            const wordsText = document.getElementById('modal-vocab-content').value.trim();
            book.words = parseWordsFromText(wordsText);
        }
    } else { // 新增模式
        const newBook = {
            id: Date.now().toString(),
            name: name,
            words: []
        };
        vocabularyBooks.push(newBook);
        activeBookId = newBook.id;
    }

    saveVocabularyBooks();
    renderVocabBookList();
    updateActiveBookView();
    closeModal();
}

function deleteActiveVocabBook() {
    const book = vocabularyBooks.find(b => b.id === activeBookId);
    if (book && confirm(`確定要永久刪除單詞本 "${book.name}" 嗎？此操作無法撤銷。`)) {
        vocabularyBooks = vocabularyBooks.filter(b => b.id !== activeBookId);
        activeBookId = vocabularyBooks.length > 0 ? vocabularyBooks[0].id : null;
        saveVocabularyBooks();
        saveAppState();
        renderVocabBookList();
        updateActiveBookView();
    }
}

function parseWordsFromText(text) {
    const lines = text.split('\n');
    return lines.map((line, index) => {
        if (!line.trim()) return null;
        let word = '', meaning = '', phonetic = '';
        const atIndex = line.indexOf('@');
        const hashIndex = line.indexOf('#');

        if (atIndex !== -1 && hashIndex !== -1) {
            if (hashIndex < atIndex) { // format: word#meaning@phonetic
                word = line.substring(0, hashIndex).trim();
                meaning = line.substring(hashIndex + 1, atIndex).trim();
                phonetic = line.substring(atIndex + 1).trim();
            } else { // format: word@phonetic#meaning
                word = line.substring(0, atIndex).trim();
                phonetic = line.substring(atIndex + 1, hashIndex).trim();
                meaning = line.substring(hashIndex + 1).trim();
            }
        } else if (hashIndex !== -1) { // format: word#meaning
            word = line.substring(0, hashIndex).trim();
            meaning = line.substring(hashIndex + 1).trim();
        } else if (atIndex !== -1) { // format: word@phonetic
            word = line.substring(0, atIndex).trim();
            phonetic = line.substring(atIndex + 1).trim();
        } else {
            word = line.trim();
        }

        if (!word) return null;

        return {
            id: `${Date.now()}-${index}`,
            word,
            meaning,
            phonetic: phonetic.replace(/^\/|\/$/g, ''), // 移除斜線
            examples: [],
        };
    }).filter(w => w !== null);
}

function exportActiveVocabBook() {
    const activeBook = vocabularyBooks.find(b => b.id === activeBookId);
    if (!activeBook) {
        alert('沒有激活的單詞本可以導出。');
        return;
    }

    const bookData = {
        name: activeBook.name,
        words: activeBook.words.map(w => {
            let parts = [w.word];
            if (w.meaning) parts.push(`#${w.meaning}`);
            if (w.phonetic) parts.push(`@${w.phonetic}`);
            // 修正組合邏輯，確保 # 在 @ 前面
            if (w.meaning && w.phonetic) {
                return `${w.word}#${w.meaning}@${w.phonetic}`;
            } else if (w.meaning) {
                return `${w.word}#${w.meaning}`;
            } else if (w.phonetic) {
                return `${w.word}@${w.phonetic}`;
            }
            return w.word;
        })
    };

    const content = JSON.stringify(bookData, null, 2);
    const blob = new Blob([content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeBook.name.replace(/[\\/:\*\?"<>\|]/g, '_')}.json`;
    document.body.appendChild(a);
    a.click();
    
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    alert(`單詞本 "${activeBook.name}" 已導出。`);
}

// =================================
// 單詞列表功能 (重構後)
// =================================

function renderWordList() {
    wordList.innerHTML = '';
    const activeBook = vocabularyBooks.find(b => b.id === activeBookId);

    if (!activeBook || activeBook.words.length === 0) {
        wordList.innerHTML = '<li class="word-item-placeholder">這個單詞本是空的，點擊右上角鉛筆按鈕添加單詞。</li>';
        return;
    }

    activeBook.words.forEach(word => {
        const li = document.createElement('li');
        li.className = 'word-item';
        li.innerHTML = `
            <div class="word-text">
                <strong data-word-id="${word.id}">${word.word}</strong>
                <span class="phonetic">/${word.phonetic}/</span>
                ${word.meaning ? `<span class="meaning" data-word-id="${word.id}">${word.meaning}</span>` : ''}
            </div>
            <div class="word-actions">
                <button class="play-btn" title="播放"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-play-circle" viewBox="0 0 16 16"><path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/><path d="M6.271 5.055a.5.5 0 0 1 .52.038l3.5 2.5a.5.5 0 0 1 0 .814l-3.5 2.5A.5.5 0 0 1 6 10.5v-5a.5.5 0 0 1 .271-.445z"/></svg></button>
            </div>
        `;

        const playBtn = li.querySelector('.play-btn');
        playBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            playWordAndMeaning(word);
        });
        
        wordList.appendChild(li);
    });
}


// =================================
// 默寫模式功能 (重構後)
// =================================
function populateDictationBookSelector() {
    dictationBookSelector.innerHTML = '';
    const bookCount = vocabularyBooks.length;

    if (bookCount === 0) {
        dictationBookSelector.innerHTML = '<p>沒有可用的單詞本。</p>';
        return;
    }

    if (bookCount <= 5) { // 點選按鈕
        vocabularyBooks.forEach((book, index) => {
            const radioId = `book-radio-${book.id}`;
            const radio = document.createElement('input');
            radio.type = 'radio';
            radio.id = radioId;
            radio.name = 'dictation-book';
            radio.value = book.id;
            radio.className = 'radio-btn';
            if (index === 0) radio.checked = true;

            const label = document.createElement('label');
            label.htmlFor = radioId;
            label.textContent = book.name;
            label.className = 'radio-label';

            dictationBookSelector.appendChild(radio);
            dictationBookSelector.appendChild(label);
        });
    } else { // 下拉選擇框
        const select = document.createElement('select');
        select.id = 'dictation-book-select';
        vocabularyBooks.forEach(book => {
            const option = document.createElement('option');
            option.value = book.id;
            option.textContent = book.name;
            select.appendChild(option);
        });
        dictationBookSelector.appendChild(select);
    }
}

function getSelectedDictationWords() {
    const bookCount = vocabularyBooks.length;
    let selectedBookId;

    if (bookCount <= 5) {
        const selectedRadio = dictationBookSelector.querySelector('input[name="dictation-book"]:checked');
        if (!selectedRadio) return null;
        selectedBookId = selectedRadio.value;
    } else {
        const select = document.getElementById('dictation-book-select');
        if (!select) return null;
        selectedBookId = select.value;
    }
    
    const book = vocabularyBooks.find(b => b.id === selectedBookId);
    return book ? book.words : null;
}

function startDictation() {
    const wordsForDictation = getSelectedDictationWords();

    if (!wordsForDictation || wordsForDictation.length === 0) {
        alert('請先選擇一個包含單詞的單詞本！');
        return;
    }
    
    startDictationBtn.disabled = true;
    stopDictationBtn.disabled = false;
    pauseDictationBtn.disabled = false;
    isDictationPaused = false;
    updatePauseButtonText();
    
    dictationPractice.classList.toggle('hidden', listenOnlyMode.checked);
    dictationProgressContainer.classList.remove('hidden');

    currentDictationIndex = 0;
    dictationWordDisplay.textContent = '';
    dictationInput.value = '';
    dictationResult.textContent = '';
    dictationResult.className = '';
    
    updateDictationProgress(wordsForDictation.length);
    playCurrentWord();
    showFloatingControls();
}

function stopDictation() {
    clearTimeout(dictationTimeout);
    clearInterval(dictationInterval);
    
    startDictationBtn.disabled = false;
    stopDictationBtn.disabled = true;
    pauseDictationBtn.disabled = true;
    isDictationPaused = false;
    updatePauseButtonText();
    dictationProgressContainer.classList.add('hidden');
    dictationPractice.classList.remove('hidden'); // 停止時恢復顯示
    replayDictationBtn.style.display = 'none';
    currentDictationIndex = -1;
    dictationWordDisplay.textContent = '已停止';

    const floatingControls = document.getElementById('floating-dictation-controls');
    if (floatingControls) {
        floatingControls.remove();
    }
}

function togglePauseDictation() {
    if (stopDictationBtn.disabled) return;
    
    isDictationPaused = !isDictationPaused;

    if (isDictationPaused) {
        clearTimeout(dictationTimeout);
        clearInterval(dictationInterval);
        if (synth.speaking) {
            synth.pause();
        }
        replayDictationBtn.style.display = 'inline-block';
    } else {
        if (synth.paused) {
            synth.resume();
        }
        replayDictationBtn.style.display = 'none';
        // 延遲一點時間再開始，避免語音引擎狀態問題
        setTimeout(() => {
            playCurrentWord();
        }, 100);
    }
    updatePauseButtonText();
}

function updatePauseButtonText() {
    const text = isDictationPaused ? '繼續' : '暫停';
    if(pauseDictationBtn) {
        pauseDictationBtn.textContent = text;
    }
    const floatingBtn = document.getElementById('floating-pause-btn');
    if (floatingBtn) {
        floatingBtn.textContent = text;
    }
    const floatingReplayBtn = document.getElementById('floating-replay-btn');
    if (floatingReplayBtn) {
        floatingReplayBtn.style.display = isDictationPaused ? 'inline-block' : 'none';
    }
}


function showFloatingControls() {
    if (document.getElementById('floating-dictation-controls')) return;

    const controlsContainer = document.createElement('div');
    controlsContainer.id = 'floating-dictation-controls';

    const pauseBtn = document.createElement('button');
    pauseBtn.id = 'floating-pause-btn';
    pauseBtn.textContent = isDictationPaused ? '繼續' : '暫停';
    pauseBtn.onclick = (e) => {
        e.stopPropagation();
        togglePauseDictation();
    };

    const stopBtn = document.createElement('button');
    stopBtn.id = 'floating-stop-btn';
    stopBtn.textContent = '停止';
    stopBtn.onclick = (e) => {
        e.stopPropagation();
        stopDictation();
    };

    const progressSpan = document.createElement('span');
    progressSpan.id = 'floating-progress-text';
    progressSpan.textContent = dictationProgressText.textContent;

    const replayBtn = document.createElement('button');
    replayBtn.id = 'floating-replay-btn';
    replayBtn.textContent = '重播';
    replayBtn.onclick = (e) => {
        e.stopPropagation();
        replayCurrentDictationWord();
    };
    replayBtn.style.display = isDictationPaused ? 'inline-block' : 'none';

    controlsContainer.appendChild(document.createTextNode('默寫進行中: '));
    controlsContainer.appendChild(progressSpan);
    controlsContainer.appendChild(pauseBtn);
    controlsContainer.appendChild(replayBtn);
    controlsContainer.appendChild(stopBtn);
    document.body.appendChild(controlsContainer);
}

function playCurrentWord() {
    if (isDictationPaused) return;

    const wordsForDictation = getSelectedDictationWords();
    if (!wordsForDictation) {
        stopDictation();
        return;
    }

    if (currentDictationIndex >= wordsForDictation.length) {
        if (loopMode.checked) {
            currentDictationIndex = 0;
        } else {
            stopDictation();
            dictationWordDisplay.textContent = '默寫完成';
            return;
        }
    }
    
    const currentWord = wordsForDictation[currentDictationIndex];
    updateDictationProgress(wordsForDictation.length);
    let timesPlayed = 0;
    
    clearInterval(dictationInterval);
    
    const playWord = () => {
        speakText(currentWord.word);
        timesPlayed++;
        
        if (readMeaning.checked && currentWord.meaning && timesPlayed === parseInt(repeatTimes.value)) {
            setTimeout(() => {
                speakText(currentWord.meaning, 'zh-TW');
            }, 1000);
        }
        
        if (timesPlayed >= parseInt(repeatTimes.value)) {
            clearInterval(dictationInterval);
            
            dictationTimeout = setTimeout(() => {
                currentDictationIndex++;
                playCurrentWord();
            }, parseInt(wordInterval.value) * 1000);
        }
    };
    
    playWord();
    dictationInterval = setInterval(playWord, 2000);
}

function checkDictation() {
    const wordsForDictation = getSelectedDictationWords();
    if (!wordsForDictation || currentDictationIndex === -1 || currentDictationIndex >= wordsForDictation.length) {
        alert('請先開始默寫！');
        return;
    }
    
    const currentWord = wordsForDictation[currentDictationIndex];
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
    
    dictationInput.value = '';
}

function updateDictationProgress(totalWords) {
    if (currentDictationIndex >= 0 && totalWords > 0) {
        const progress = Math.round(((currentDictationIndex + 1) / totalWords) * 100);
        dictationProgressBar.style.width = `${progress}%`;
        dictationProgressText.textContent = `${currentDictationIndex + 1}/${totalWords}`;
    } else {
        dictationProgressBar.style.width = '0%';
        dictationProgressText.textContent = `0/${totalWords}`;
    }

    const floatingProgress = document.getElementById('floating-progress-text');
    if (floatingProgress) {
        floatingProgress.textContent = dictationProgressText.textContent;
    }
}

function replayCurrentDictationWord() {
    if (currentDictationIndex < 0) return;
    const wordsForDictation = getSelectedDictationWords();
    if (!wordsForDictation || currentDictationIndex >= wordsForDictation.length) return;
    
    const currentWord = wordsForDictation[currentDictationIndex];
    speakText(currentWord.word);
}

// 學習模式功能
function populateWordSelect() {
    const currentSelectedValue = wordSelect.value;
    wordSelect.innerHTML = '<option value="">請選擇單詞</option>';
    
    const activeBook = vocabularyBooks.find(b => b.id === activeBookId);
    if (activeBook) {
        activeBook.words.forEach(word => {
            const option = document.createElement('option');
            option.value = word.id;
            option.textContent = word.word;
            wordSelect.appendChild(option);
        });
    }

    if (currentSelectedValue) {
        wordSelect.value = currentSelectedValue;
    }
}

function getActiveWords() {
    const activeBook = vocabularyBooks.find(b => b.id === activeBookId);
    return activeBook ? activeBook.words : [];
}

function displayWordDetails() {
    const selectedId = wordSelect.value;
    if (!selectedId) {
        clearWordDetails();
        return;
    }
    
    const words = getActiveWords();
    const word = words.find(w => w.id === selectedId);
    if (word) {
        detailWord.textContent = word.word;
        detailPhonetic.textContent = word.phonetic ? `/${word.phonetic}/` : '';
        detailMeaning.textContent = word.meaning || '(無中文意思)';
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
    
    const words = getActiveWords();
    const word = words.find(w => w.id === selectedId);
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
    
    const words = getActiveWords();
    const word = words.find(w => w.id === selectedId);
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
            const exampleSentences = JSON.parse(content);

            generateExamplesBtn.textContent = '分析語義中...';
            const analysisPromises = exampleSentences.map(example =>
                analyzeWordsInSentence(example.english).then(analysis => {
                    example.analysis = analysis;
                    return example;
                })
            );
            
            const examplesWithAnalysis = await Promise.all(analysisPromises);
            
            word.examples = examplesWithAnalysis;
            saveVocabularyBooks();
            displayExamples(word);

        } catch (error) {
            console.error('生成例句或分析時出錯:', error);
            alert('生成例句或分析失敗，請檢查API Key或網絡連接後再試。');
            word.examples = generateMockExamples(word.word);
            saveVocabularyBooks();
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
        const processedEn = new Set();

        sortedAlignment.forEach((pair) => {
            if (pair.en && pair.zh) {
                const lowerEn = pair.en.toLowerCase();
                if (processedEn.has(lowerEn)) {
                    return;
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

                processedEn.add(lowerEn);
            }
        });

        div.innerHTML = `
            <p class="example-english">${processedEnglish}</p>
            <p class="example-chinese">${processedChinese}</p>
        `;
        examplesContainer.appendChild(div);
    });
}

function repositionTooltip(targetElement) {
    requestAnimationFrame(() => {
        const rect = targetElement.getBoundingClientRect();
        const tooltipHeight = analysisTooltip.offsetHeight;
        const tooltipWidth = analysisTooltip.offsetWidth;
        const spaceAbove = rect.top;

        let top, left;

        if (spaceAbove > tooltipHeight + 10) {
            top = rect.top + window.scrollY - tooltipHeight - 5;
        } else {
            top = rect.bottom + window.scrollY + 5;
        }

        left = rect.left;
        if (left + tooltipWidth > window.innerWidth - 10) {
            left = rect.right - tooltipWidth;
        }
        if (left < 10) {
            left = 10;
        }

        analysisTooltip.style.top = `${top}px`;
        analysisTooltip.style.left = `${left}px`;
        analysisTooltip.style.visibility = 'visible';
    });
}

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
        return {};
    }
}

function analyzeWordInContext(word, sentence, event) {
    const targetElement = event.target;
    const selectedId = wordSelect.value;
    const words = getActiveWords();
    const currentWordData = words.find(w => w.id === selectedId);

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
        const phonetic = wordAnalysis.phonetic || '';
        const phoneticDisplay = phonetic ? ` /${phonetic.replace(/^\/|\/$/g, '')}/` : '';
        analysisTooltip.innerHTML = `
            <div class="tooltip-title">${word}<span class="tooltip-phonetic">${phoneticDisplay}</span> (${wordAnalysis.pos})</div>
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
    
    const words = getActiveWords();
    const word = words.find(w => w.id === selectedId);
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
            sentenceFeedback.textContent = '檢查失敗，但您的句子包含了關鍵詞。';
            sentenceFeedback.className = 'feedback-correct';
        } finally {
            checkSentenceBtn.disabled = false;
        }
    }
}


// 輔助功能
function speakText(text, lang = 'en-US', speed = 0, onStart, onEnd) {
    stopCurrentAudio();

    const voice = lang.startsWith('zh') ? TTS_CONFIG.voices.chinese : TTS_CONFIG.voices.english;
    const url = `${TTS_CONFIG.baseUrl}/tts?t=${encodeURIComponent(text)}&v=${voice}&r=${speed}`;
    
    ttsAudio = new Audio(url);
    
    pauseResumeArticleBtn.disabled = false;
    
    ttsAudio.addEventListener('play', () => {
        if (onStart) onStart();
    });

    ttsAudio.onended = () => {
        if (onEnd) onEnd();
    };
    
    ttsAudio.onerror = (e) => {
        console.error('播放音頻時出錯:', e);
        alert('無法播放語音，請檢查TTS服務是否正在運行。');
        if (onEnd) onEnd();
    };

    ttsAudio.play().catch(error => {
        console.error('音頻播放失敗:', error);
        if (error.name === 'NotAllowedError') {
            alert('您的瀏覽器阻止了音頻自動播放。請再次點擊按鈕嘗試，或檢查您瀏覽器的網站設置以允許音頻播放。');
        } else {
            alert('播放音頻時發生未知錯誤，請查看控制台了解詳情。');
        }
        if (onEnd) onEnd();
    });
}

function playWordAndMeaning(word) {
    stopCurrentAudio();

    speakText(word.word, 'en-US', 0, 
        () => {
            console.log(`Playing: ${word.word}`);
        }, 
        () => {
            if (word.meaning) {
                setTimeout(() => {
                    speakText(word.meaning, 'zh-TW', 0,
                        () => {
                             console.log(`Playing: ${word.meaning}`);
                        },
                        () => {
                            console.log("Finished playing all.");
                        }
                    );
                }, 300);
            }
        }
    );
}

// =================================
// 本地存儲 (重構後)
// =================================
function saveVocabularyBooks() {
    localStorage.setItem('vocabularyBooks', JSON.stringify(vocabularyBooks));
}

function loadVocabularyBooks() {
    const saved = localStorage.getItem('vocabularyBooks');
    let books = saved ? JSON.parse(saved) : [];

    if (books.length === 0) {
        // 如果沒有數據，創建一個預設的
        books.push({
            id: Date.now().toString(),
            name: '我的第一個單詞本',
            words: []
        });
    } else {
        // 資料遷移和清理：遍歷所有單詞並標準化音標格式
        let dataWasModified = false;
        books.forEach(book => {
            if (book.words && Array.isArray(book.words)) {
                book.words.forEach(word => {
                    if (word.phonetic && typeof word.phonetic === 'string') {
                        const originalPhonetic = word.phonetic;
                        const cleanedPhonetic = originalPhonetic.replace(/^\/+|\/+$/g, '');
                        if (originalPhonetic !== cleanedPhonetic) {
                            word.phonetic = cleanedPhonetic;
                            dataWasModified = true;
                        }
                    }
                });
            }
        });
        // 如果資料被修改過，就立即存回localStorage
        if (dataWasModified) {
            localStorage.setItem('vocabularyBooks', JSON.stringify(books));
        }
    }

    vocabularyBooks = books;
    loadAppState();
}

function saveAppState() {
    localStorage.setItem('activeBookId', activeBookId);
}

function loadAppState() {
    const savedId = localStorage.getItem('activeBookId');
    if (savedId && vocabularyBooks.some(b => b.id === savedId)) {
        activeBookId = savedId;
    } else if (vocabularyBooks.length > 0) {
        activeBookId = vocabularyBooks[0].id;
    } else {
        activeBookId = null;
    }
}

// =================================
// Modal 控制
// =================================
function openModal() {
    appModal.classList.remove('hidden');
}

function closeModal() {
    appModal.classList.add('hidden');
    modalBody.innerHTML = '';
}


// =================================
// 文章詳解歷史記錄功能 (無變化)
// =================================
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
        const title = item.article.substring(0, 20) + '...';
        option.textContent = title;
        articleHistorySelect.appendChild(option);
    });
}

function saveAnalysisResult(article, result) {
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
    const wordsForQuiz = getActiveWords();
    if (wordsForQuiz.length < 4) {
        alert('當前單詞本至少需要4個單詞才能開始測驗！');
        return;
    }
    
    const questionCount = parseInt(quizCount.value);
    if (wordsForQuiz.length < questionCount) {
        alert(`您當前單詞本只有${wordsForQuiz.length}個單詞，請減少測驗題目數量！`);
        return;
    }
    
    quizInProgress = true;
    currentQuestionIndex = 0;
    quizScore = 0;
    selectedAnswer = null;
    
    generateQuizQuestions();
    
    startQuizBtn.disabled = true;
    stopQuizBtn.disabled = false;
    quizResult.classList.add('hidden');
    
    showCurrentQuestion();
}

function stopQuiz() {
    quizInProgress = false;
    currentQuestionIndex = 0;
    quizScore = 0;
    selectedAnswer = null;
    
    startQuizBtn.disabled = false;
    stopQuizBtn.disabled = true;
    nextQuestionBtn.disabled = true;
    
    quizQuestion.textContent = '';
    quizOptions.innerHTML = '';
    updateQuizProgress();
    
    alert('測驗已停止！');
}

function generateQuizQuestions() {
    const questionCount = parseInt(quizCount.value);
    const type = quizType.value;
    quizQuestions = [];
    
    const wordsForQuiz = getActiveWords();
    const selectedWords = [...wordsForQuiz].sort(() => 0.5 - Math.random()).slice(0, questionCount);
    
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
    
    const wordsForQuiz = getActiveWords();
    const otherWords = wordsForQuiz.filter(w => w.id !== targetWord.id);
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
    
    quizQuestion.textContent = question.question;
    
    quizOptions.innerHTML = '';
    question.options.forEach((option, index) => {
        const optionDiv = document.createElement('div');
        optionDiv.className = 'quiz-option';
        optionDiv.textContent = option;
        optionDiv.addEventListener('click', () => selectOption(index, option));
        quizOptions.appendChild(optionDiv);
    });
    
    updateQuizProgress();
    
    nextQuestionBtn.disabled = true;
}

function selectOption(index, selectedText) {
    if (selectedAnswer !== null) return;
    
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
    
    nextQuestionBtn.disabled = false;
    
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
    
    document.getElementById('quiz-question-container').style.display = 'none';
    quizResult.classList.remove('hidden');
    
    const percentage = Math.round((quizScore / quizQuestions.length) * 100);
    
    finalScore.textContent = `${quizScore}/${quizQuestions.length} (${percentage}%)`;
    
    if (percentage >= 80) {
        finalScore.className = 'score-excellent';
    } else if (percentage >= 60) {
        finalScore.className = 'score-good';
    } else {
        finalScore.className = 'score-poor';
    }
    
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
    
    startQuizBtn.disabled = false;
    stopQuizBtn.disabled = true;
    nextQuestionBtn.disabled = true;
}

function restartQuiz() {
    document.getElementById('quiz-question-container').style.display = 'block';
    quizResult.classList.add('hidden');
    
    startQuiz();
}