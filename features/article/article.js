import * as state from '../../modules/state.js';
import * as dom from '../../modules/dom.js';
import * as storage from '../../modules/storage.js';
import * as ui from '../../modules/ui.js';
import * as api from '../../modules/api.js';
import * as audio from '../../modules/audio.js';

// =================================
// Article Analysis Feature
// =================================

export function initArticle() {
    dom.analyzeArticleBtn.addEventListener('click', analyzeArticle);
    dom.clearArticleBtn.addEventListener('click', clearArticleInput);
    dom.articleHistorySelect.addEventListener('change', loadSelectedArticle);
    dom.deleteHistoryBtn.addEventListener('click', deleteSelectedArticleHistory);
    dom.readArticleBtn.addEventListener('click', handleReadButtonClick);
    dom.stopReadArticleBtn.addEventListener('click', stopReadArticle);
    dom.downloadAudioBtn.addEventListener('click', downloadAudio);
    
    dom.speedBtnGroup.addEventListener('click', (e) => {
        if (e.target.classList.contains('speed-btn')) {
            dom.speedBtnGroup.querySelectorAll('.speed-btn').forEach(btn => btn.classList.remove('active'));
            e.target.classList.add('active');
            state.setCurrentSpeed(parseInt(e.target.dataset.speed, 10));
        }
    });

    dom.readingModeSelect.addEventListener('change', () => {
        stopReadArticle();
        const mode = dom.readingModeSelect.value;
        const isChunkMode = mode === 'sentence' || mode === 'paragraph';
        dom.chunkRepeatControls.classList.toggle('hidden', !isChunkMode);
        
        let navText = '句';
        if (mode === 'paragraph') navText = '段';
        dom.prevChunkBtn.textContent = `上一${navText}`;
        dom.nextChunkBtn.textContent = `下一${navText}`;
    });

    // 重新设计导航控制 - 分别防抖每个按钮
    let prevClickTime = 0;
    let nextClickTime = 0;
    const CLICK_DEBOUNCE_TIME = 300;
    
    dom.prevChunkBtn.addEventListener('click', () => {
        const now = Date.now();
        if (now - prevClickTime < CLICK_DEBOUNCE_TIME) {
            return; // 防抖拦截
        }
        prevClickTime = now;
        playPrevChunk();
    });
    
    dom.nextChunkBtn.addEventListener('click', () => {
        const now = Date.now();
        if (now - nextClickTime < CLICK_DEBOUNCE_TIME) {
            return; // 防抖拦截
        }
        nextClickTime = now;
        playNextChunk();
    });
    
    dom.articleAnalysisContainer.addEventListener('mouseover', handleWordHighlight);
    dom.articleAnalysisContainer.addEventListener('mouseout', handleWordHighlight);
    dom.articleAnalysisContainer.addEventListener('click', handleArticleWordAnalysisClick);

    dom.showArticleLibraryBtn.addEventListener('click', openArticleLibrary);
    dom.articleLibraryModal.querySelector('.modal-close-btn').addEventListener('click', closeArticleLibrary);
    dom.articleLibraryModal.addEventListener('click', (e) => {
        if (e.target === dom.articleLibraryModal) {
            closeArticleLibrary();
        }
    });

    populateArticleHistorySelect();
}

async function analyzeArticle() {
    const articleText = dom.articleInput.value.trim();
    if (!articleText) {
        alert('請輸入要分析的文章！');
        return;
    }

    dom.analyzeArticleBtn.disabled = true;
    dom.analyzeArticleBtn.textContent = '分析中...';
    
    const paragraphs = articleText.split(/\n+/).filter(p => p.trim() !== '');
    if (paragraphs.length === 0) {
        alert('請輸入有效的文章內容！');
        dom.analyzeArticleBtn.disabled = false;
        dom.analyzeArticleBtn.textContent = '分析文章';
        return;
    }

    updateAnalysisProgress(0, paragraphs.length, '準備中...');

    try {
        let paragraphAnalyses = [];
        for (let i = 0; i < paragraphs.length; i++) {
            updateAnalysisProgress(i, paragraphs.length, `正在分析第 ${i + 1} 段...`);
            try {
                const paragraphResult = await api.analyzeParagraph(paragraphs[i]);
                paragraphAnalyses.push(paragraphResult);
            } catch (error) {
                console.error(`分析第 ${i + 1} 段時出錯:`, error);
                paragraphAnalyses.push({ chinese_translation: `[第 ${i + 1} 段分析失敗]`, word_alignment: [], detailed_analysis: [] });
            }
            updateAnalysisProgress(i + 1, paragraphs.length, `已完成 ${i + 1} 段分析`);
        }

        const finalResult = {
            chinese_translation: paragraphAnalyses.map(p => p.chinese_translation).join('\n\n'),
            word_alignment: paragraphAnalyses.flatMap(p => p.word_alignment || []),
            detailed_analysis: paragraphAnalyses.flatMap(p => p.detailed_analysis || []),
            paragraph_analysis: paragraphAnalyses
        };

        dom.articleAnalysisContainer.dataset.analysis = JSON.stringify(finalResult.detailed_analysis || []);
        displayArticleAnalysis(articleText, finalResult);
        storage.saveAnalysisResult(articleText, finalResult);
        populateArticleHistorySelect();

    } catch (error) {
        console.error('分析文章時出錯:', error);
        dom.articleAnalysisContainer.innerHTML = `<p style="color: red;">分析失敗！請檢查API Key或網絡連接後再試。</p>`;
    } finally {
        dom.analyzeArticleBtn.disabled = false;
        dom.analyzeArticleBtn.textContent = '分析文章';
    }
}

function updateAnalysisProgress(completed, total, message) {
    const progressFill = dom.articleAnalysisContainer.querySelector('.progress-fill');
    const progressText = dom.articleAnalysisContainer.querySelector('.progress-text');
    if (progressFill && progressText) {
        progressFill.style.width = `${(completed / total) * 100}%`;
        progressText.textContent = `${message} (${completed}/${total})`;
    } else {
        dom.articleAnalysisContainer.innerHTML = `
            <div class="analysis-progress">
                <p>${message}</p>
                <div class="progress-bar"><div class="progress-fill" style="width: ${(completed / total) * 100}%"></div></div>
                <p class="progress-text">${message} (${completed}/${total})</p>
            </div>`;
    }
}

function displayArticleAnalysis(originalArticle, analysisResult) {
    const { chinese_translation, word_alignment, detailed_analysis, paragraph_analysis } = analysisResult;

    if (!chinese_translation && (!paragraph_analysis || paragraph_analysis.length === 0)) {
        dom.articleAnalysisContainer.innerHTML = `<p style="color: red;">API返回的數據格式不完整。</p>`;
        return;
    }

    const englishParagraphs = originalArticle.split(/\n+/).filter(p => p.trim() !== '');
    const chineseParagraphs = (chinese_translation || '').split(/\n+/).filter(p => p.trim() !== '');
    const escapeRegex = (string) => string ? string.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&') : '';

    let htmlContent = '';
    for (let i = 0; i < englishParagraphs.length; i++) {
        const englishPara = englishParagraphs[i] || '';
        const chinesePara = chineseParagraphs[i] || '';
        
        let processedEnglish = englishPara;
        let processedChinese = chinesePara;
        
        const paragraphWords = (paragraph_analysis && paragraph_analysis[i]?.detailed_analysis) || [];
        
        const wordStartMap = new Map();
        let cursor = 0;
        paragraphWords.forEach(item => {
            const wordRegex = new RegExp(`\\b${escapeRegex(item.word)}\\b`);
            const match = englishPara.substring(cursor).match(wordRegex);
            if (match) {
                item.startIndex = cursor + match.index;
                wordStartMap.set(item.startIndex, item);
                cursor = item.startIndex + 1;
            }
        });
        
        const relevantAlignment = (word_alignment || []).filter(pair => englishPara.includes(pair.en) && chinesePara.includes(pair.zh));
        const sortedAlignment = [...relevantAlignment].sort((a, b) => (b.en?.length || 0) - (a.en?.length || 0));
        
        sortedAlignment.forEach((pair, index) => {
            if (!pair.en || !pair.zh) return;
            const pairId = `para-${i}-pair-${index}`;
            processedEnglish = processedEnglish.replace(new RegExp(`\\b(${escapeRegex(pair.en)})\\b`, 'g'), `<span class="interactive-word" data-pair-id="${pairId}">$1</span>`);
            processedChinese = processedChinese.replace(new RegExp(`(${escapeRegex(pair.zh)})`, 'g'), `<span class="interactive-word" data-pair-id="${pairId}">$1</span>`);
        });

        htmlContent += `
            <div class="paragraph-pair">
                <div class="paragraph-english">${processedEnglish}</div>
                <div class="paragraph-chinese">${processedChinese}</div>
            </div>`;
    }
    
    dom.articleAnalysisContainer.innerHTML = htmlContent;
    dom.articleAnalysisContainer.dataset.analysis = JSON.stringify(detailed_analysis || []);
}

function clearArticleInput() {
    dom.articleInput.value = '';
    dom.articleAnalysisContainer.innerHTML = '<p>請先輸入文章並點擊分析按鈕。</p>';
    dom.articleHistorySelect.value = '';
}

function populateArticleHistorySelect() {
    dom.articleHistorySelect.innerHTML = '<option value="">讀取歷史記錄</option>';
    state.analyzedArticles.forEach((item, index) => {
        const option = document.createElement('option');
        option.value = index;
        option.textContent = item.article.substring(0, 20) + '...';
        dom.articleHistorySelect.appendChild(option);
    });
}

function loadSelectedArticle() {
    const selectedIndex = dom.articleHistorySelect.value;
    if (selectedIndex === '') {
        clearArticleInput();
        return;
    }
    const item = state.analyzedArticles[selectedIndex];
    if (item) {
        dom.articleInput.value = item.article;
        displayArticleAnalysis(item.article, item.result);
    }
}

function deleteSelectedArticleHistory() {
    const selectedIndex = dom.articleHistorySelect.value;
    if (selectedIndex === '') {
        alert('請先選擇一個歷史記錄！');
        return;
    }
    if (confirm('確定要刪除這條歷史記錄嗎？')) {
        const articles = [...state.analyzedArticles];
        articles.splice(selectedIndex, 1);
        state.setAnalyzedArticles(articles);
        storage.saveAnalyzedArticles();
        populateArticleHistorySelect();
        clearArticleInput();
    }
}

// --- Article Reading ---

function handleReadButtonClick() {
    if (dom.stopReadArticleBtn.disabled) readArticle();
    else togglePauseResume();
}

function readArticle() {
    const text = dom.articleInput.value.trim();
    if (!text) {
        alert('請先輸入要朗讀的文章！');
        return;
    }
    const mode = dom.readingModeSelect.value;
    state.setIsReadingChunkPaused(false);
    state.setReadingChunks(splitText(text, mode === 'full' ? 'sentence' : mode));
    if (state.readingChunks.length > 0) {
        state.setCurrentChunkIndex(0);
        dom.chunkNavControls.classList.toggle('hidden', mode === 'full');
        playCurrentChunk();
    }
}

function stopReadArticle() {
    audio.stopCurrentAudio();
    state.setIsReadingChunkPaused(false);
    dom.stopReadArticleBtn.disabled = true;
    updateReadButtonUI('stopped');
    dom.chunkNavControls.classList.toggle('hidden', dom.readingModeSelect.value === 'full');
    highlightCurrentChunk(null);
    if(dom.currentSentenceDisplay) dom.currentSentenceDisplay.textContent = '';
}

function playCurrentChunk() {
    if (state.currentChunkIndex < 0 || state.currentChunkIndex >= state.readingChunks.length) {
        stopReadArticle();
        return;
    }
    const chunk = state.readingChunks[state.currentChunkIndex];
    highlightCurrentChunk(chunk);
    if(dom.currentSentenceDisplay) dom.currentSentenceDisplay.textContent = chunk;

    const repeatTimesVal = parseInt(dom.chunkRepeatTimes.value, 10) || 1;
    
    const onEnd = () => {
        state.setSentenceRepeatCount(state.sentenceRepeatCount + 1);
        if (state.isReadingChunkPaused) return;
        if (state.sentenceRepeatCount < repeatTimesVal) {
            playCurrentChunk();
        } else {
            if (state.currentChunkIndex < state.readingChunks.length - 1) {
                state.setCurrentChunkIndex(state.currentChunkIndex + 1);
                state.setSentenceRepeatCount(0);
                playCurrentChunk();
            } else {
                stopReadArticle();
            }
        }
    };
    audio.speakText(chunk, 'en-US', state.currentSpeed, () => {
        dom.stopReadArticleBtn.disabled = false;
        updateReadButtonUI('playing');
        updateChunkNav();
    }, onEnd);
}

function playNextChunk() {
    // 防止在非播放状态下切换
    if (dom.stopReadArticleBtn.disabled) return;
    
    if (state.currentChunkIndex < state.readingChunks.length - 1) {
        audio.stopCurrentAudio();
        state.setCurrentChunkIndex(state.currentChunkIndex + 1);
        state.setSentenceRepeatCount(0);
        state.setIsReadingChunkPaused(false);
        
        // 立即更新UI
        updateChunkNav();
        
        // 短延迟后开始播放
        setTimeout(() => {
            playCurrentChunk();
        }, 50);
    }
}

function playPrevChunk() {
    // 防止在非播放状态下切换
    if (dom.stopReadArticleBtn.disabled) return;
    
    if (state.currentChunkIndex > 0) {
        audio.stopCurrentAudio();
        state.setCurrentChunkIndex(state.currentChunkIndex - 1);
        state.setSentenceRepeatCount(0);
        state.setIsReadingChunkPaused(false);
        
        // 立即更新UI
        updateChunkNav();
        
        // 短延迟后开始播放
        setTimeout(() => {
            playCurrentChunk();
        }, 50);
    }
}

function togglePauseResume() {
    const wasPaused = state.isReadingChunkPaused;
    audio.stopCurrentAudio();
    state.setIsReadingChunkPaused(!wasPaused);
    if (wasPaused) {
        playCurrentChunk();
        updateReadButtonUI('playing');
    } else {
        updateReadButtonUI('paused');
    }
}

function updateReadButtonUI(status) {
    const icon = dom.readArticleBtn.querySelector('svg');
    const icons = {
        play: '<path d="m11.596 8.697-6.363 3.692c-.54.313-1.233-.066-1.233-.697V4.308c0-.63.692-1.01 1.233-.696l6.363 3.692a.802.802 0 0 1 0 1.393z"/>',
        pause: '<path d="M5.5 3.5A1.5 1.5 0 0 1 7 5v6a1.5 1.5 0 0 1-3 0V5a1.5 1.5 0 0 1 1.5-1.5m5 0A1.5 1.5 0 0 1 12 5v6a1.5 1.5 0 0 1-3 0V5a1.5 1.5 0 0 1 1.5-1.5z"/>'
    };
    icon.innerHTML = status === 'playing' ? icons.pause : icons.play;
    dom.readArticleBtn.title = status === 'playing' ? "暫停" : (status === 'paused' ? "繼續" : "朗讀文章");
}

function updateChunkNav() {
    dom.chunkProgressSpan.textContent = `${state.currentChunkIndex + 1} / ${state.readingChunks.length}`;
    dom.prevChunkBtn.disabled = state.currentChunkIndex === 0;
    dom.nextChunkBtn.disabled = state.currentChunkIndex === state.readingChunks.length - 1;
}

function splitText(text, mode) {
    if (mode === 'paragraph') return text.split(/\n+/).filter(p => p.trim() !== '');
    if (mode === 'sentence') return text.match(/[^.!?]+[.!?]*/g) || [];
    return [text];
}

function highlightCurrentChunk(chunk) {
    let content = dom.articleAnalysisContainer.innerHTML;
    content = content.replace(/<span class="highlight-reading">(.*?)<\/span>/gs, '$1');
    if (chunk) {
        content = content.replace(chunk, `<span class="highlight-reading">${chunk}</span>`);
    }
    dom.articleAnalysisContainer.innerHTML = content;
}

async function downloadAudio() {
    const text = dom.articleInput.value.trim();
    if (!text) {
        alert('請先輸入要下載的文章！');
        return;
    }
    alert('下載功能正在開發中...');
}

// --- Article Library ---

async function openArticleLibrary() {
    dom.articleLibraryList.innerHTML = '<p>正在加載文章列表...</p>';
    dom.articleLibraryModal.classList.remove('hidden');
    try {
        const response = await fetch('articles/manifest.json');
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const articles = await response.json();
        if (articles.length === 0) {
            dom.articleLibraryList.innerHTML = '<p>文章庫是空的。</p>';
            return;
        }
        dom.articleLibraryList.innerHTML = articles.map(article => `
            <div class="article-library-item" data-path="${article.path}">
                <h4>${article.title}</h4>
                <p class="description">${article.description}</p>
                <div class="meta">
                    <span class="difficulty">${article.difficulty}</span>
                    <span class="category">${article.category}</span>
                </div>
            </div>`).join('');
        document.querySelectorAll('.article-library-item').forEach(item => {
            item.addEventListener('click', () => loadArticleFromLibrary(item.dataset.path));
        });
    } catch (error) {
        console.error("無法加載文章庫:", error);
        dom.articleLibraryList.innerHTML = '<p style="color: red;">加載文章列表失敗。</p>';
    }
}

async function loadArticleFromLibrary(path) {
    try {
        const response = await fetch(path);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const article = await response.json();
        dom.articleInput.value = article.content;
        closeArticleLibrary();
    } catch (error) {
        console.error(`無法從 ${path} 加載文章:`, error);
        alert('加載文章失敗！');
    }
}

function closeArticleLibrary() {
    dom.articleLibraryModal.classList.add('hidden');
}

// --- Helpers ---

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

function handleArticleWordAnalysisClick(e) {
    if (e.target.classList.contains('interactive-word')) {
        e.stopPropagation();
        try {
            const analysisArray = JSON.parse(dom.articleAnalysisContainer.dataset.analysis || '[]');
            if (analysisArray.length > 0) {
                showArticleWordAnalysis(e.target, analysisArray);
            }
        } catch (err) {
            console.error("Failed to parse analysis data:", err);
        }
    }
}

function showArticleWordAnalysis(clickedElement, analysisArray) {
    const wordText = clickedElement.dataset.word || clickedElement.textContent;
    const wordIndex = parseInt(clickedElement.dataset.wordIndex, 10) || 0;

    const matchingAnalyses = analysisArray.filter(item => item.word.toLowerCase() === wordText.toLowerCase());
    const wordAnalysisData = (wordIndex < matchingAnalyses.length) ? matchingAnalyses[wordIndex] : null;

    if (wordAnalysisData && wordAnalysisData.analysis) {
        const analysis = wordAnalysisData.analysis;
        const phonetic = analysis.phonetic ? ` /${analysis.phonetic.replace(/^\/|\/$/g, '')}/` : '';
        ui.repositionTooltip(clickedElement);
        dom.analysisTooltip.innerHTML = `
            <div class="tooltip-title">${wordAnalysisData.word}<span class="tooltip-phonetic">${phonetic}</span> (${analysis.pos})</div>
            <div class="tooltip-content">
                <p><strong>作用:</strong> ${analysis.role}</p>
                <p><strong>意思:</strong> ${analysis.meaning}</p>
            </div>`;
    } else {
        dom.analysisTooltip.innerHTML = `<div class="tooltip-content"><p>分析數據未找到。</p></div>`;
    }
    dom.analysisTooltip.style.display = 'block';
    ui.repositionTooltip(clickedElement);
}