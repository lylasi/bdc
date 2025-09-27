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
    
    // 移除 hover 行為：不再於滑過時自動高亮或補配對，改為點擊才觸發詳解
    // dom.articleAnalysisContainer.addEventListener('mouseover', handleWordHighlight);
    // dom.articleAnalysisContainer.addEventListener('mouseout', handleWordHighlight);
    dom.articleAnalysisContainer.addEventListener('click', handleArticleWordAnalysisClick);
    dom.articleAnalysisContainer.addEventListener('click', (e) => {
        const rawTarget = e.target && e.target.nodeType === 3 ? e.target.parentElement : e.target;
        const btn = rawTarget?.closest && rawTarget.closest('.retry-paragraph-btn');
        if (btn) {
            const idx = parseInt(btn.getAttribute('data-index'), 10);
            if (!Number.isNaN(idx)) retrySingleParagraph(idx, { force: true });
        }
    });

    dom.showArticleLibraryBtn.addEventListener('click', openArticleLibrary);
    dom.articleLibraryModal.querySelector('.modal-close-btn').addEventListener('click', closeArticleLibrary);
    dom.articleLibraryModal.addEventListener('click', (e) => {
        if (e.target === dom.articleLibraryModal) {
            closeArticleLibrary();
        }
    });

    if (dom.retryFailedParagraphsBtn) {
        dom.retryFailedParagraphsBtn.addEventListener('click', retryFailedParagraphs);
    }

    populateArticleHistorySelect();

    // 選字快速加入生詞本（文章詳解區）
    try { initArticleSelectionToWordbook(); } catch (_) {}
}


// In-flight controller and a simple per-session paragraph cache
let currentAnalysisAbort = null;
const paragraphCache = new Map();
let lastFailedIndices = [];
// Track per-paragraph timing (ms)
const paragraphStartTime = Object.create(null);
const paragraphElapsedMs = Object.create(null);

// --- Sentence analysis in-flight de-duplication ---
// 同一句子（在相同上下文）短時間內只發出一個請求，其餘共用同一 promise。
const _inflightSentenceMap = new Map(); // key: `${sentence}||${context}` -> Promise

function _sentenceKey(sentence, context) {
    return `${sentence}||${context || ''}`;
}

function analyzeSentenceDedupe(sentence, context = '', opts = {}) {
    const key = _sentenceKey(sentence, context);
    const existed = _inflightSentenceMap.get(key);
    if (existed) return existed;
    const p = api.analyzeSentence(sentence, context, opts)
        .finally(() => { try { _inflightSentenceMap.delete(key); } catch (_) {} });
    _inflightSentenceMap.set(key, p);
    return p;
}

// Merge helper: deduplicate detailed_analysis by key (word|sentence)
function mergeDetailedAnalyses(existing, incoming) {
    const out = [];
    const seen = new Set();
    const add = (it) => {
        if (!it || !it.word || !it.sentence) return;
        const k = `${it.sentence}__${it.word}`.toLowerCase();
        if (seen.has(k)) return;
        seen.add(k);
        out.push(it);
    };
    (existing || []).forEach(add);
    (incoming || []).forEach(add);
    return out;
}

function parseTitleAndParagraphs(text) {
    const paras = text.split(/\n+/).filter(p => p.trim() !== '');
    if (paras.length === 0) return { title: '', paragraphs: [] };
    const first = paras[0].trim();
    const m = first.match(/^#+\s*(.+)$/); // support '# Title' or '## Title'
    if (m) {
        return { title: m[1].trim(), paragraphs: paras.slice(1) };
    }
    return { title: '', paragraphs: paras };
}

async function analyzeArticle() {
    const articleText = dom.articleInput.value.trim();
    if (!articleText) {
        alert('請輸入要分析的文章！');
        return;
    }

    // Abort previous run if exists
    if (currentAnalysisAbort) {
        try { currentAnalysisAbort.abort('cancelled-by-new-run'); } catch (_) { /* noop */ }
    }
    currentAnalysisAbort = new AbortController();

    dom.analyzeArticleBtn.disabled = true;
    dom.analyzeArticleBtn.textContent = '分析中...';
    
    const { title, paragraphs } = parseTitleAndParagraphs(articleText);
    const items = title ? [title, ...paragraphs] : paragraphs; // 將標題也納入分析列表
    if (items.length === 0) {
        alert('請輸入有效的文章內容！');
        dom.analyzeArticleBtn.disabled = false;
        dom.analyzeArticleBtn.textContent = '分析文章';
        return;
    }

    updateAnalysisProgress(0, items.length, '準備中...');

    // Pre-render placeholders for incremental rendering
    const esc = (s) => (s || '').replace(/&/g,'&amp;').replace(/\"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/'/g,'&#39;');
    dom.articleAnalysisContainer.innerHTML = items.map((p, i) => `
        <div class="paragraph-pair${title && i === 0 ? ' is-title' : ''}" data-paragraph-index="${i}" data-english="${esc(p)}">
            <div class="para-status" data-status="pending" style="font-size:12px;opacity:.8;margin:4px 0;display:flex;gap:8px;align-items:center;">
                <span class="status-icon">⏳</span>
                <span class="status-text">分析中...</span>
                <span class="elapsed" title="耗時"></span>
                <button class="retry-paragraph-btn" data-index="${i}" style="display:none;">重試本段</button>
            </div>
            <div class="paragraph-english">${esc(p)}</div>
            <div class="paragraph-chinese"><em>分析中...</em></div>
        </div>`).join('');

    try {
        const total = items.length;
        let completed = 0;
        let paragraphAnalyses = new Array(total);

        // 降低段落併發，避免觸發 429；並在拉起任務時加入間隔
        const CONCURRENCY = Math.min(2, total);
        const SPACING_MS = 400;
        let nextIndex = 0;
        const timeoutMs = 45000;
        lastFailedIndices = [];
        let aggregatedDetails = [];

        const runNext = async () => {
            const idx = nextIndex++;
            if (idx >= total) return;
            // 啟動前延遲，平滑請求節奏
            await new Promise(r => setTimeout(r, SPACING_MS));
            const text = items[idx];
            updateAnalysisProgress(completed, total, `正在分析第 ${idx + 1} 段...`);
            try {
                // start timing for this paragraph
                paragraphStartTime[idx] = Date.now();
                const cached = paragraphCache.get(text);
                const result = cached || await api.analyzeParagraph(text, { timeoutMs, signal: currentAnalysisAbort.signal, level: 'quick' });
                if (!cached) paragraphCache.set(text, result);
                paragraphAnalyses[idx] = result;
                // Incremental DOM update
                try { renderParagraph(idx, text, result); } catch(_) {}
                if (Array.isArray(result?.detailed_analysis)) {
                    aggregatedDetails = mergeDetailedAnalyses(aggregatedDetails, result.detailed_analysis);
                    dom.articleAnalysisContainer.dataset.analysis = JSON.stringify(aggregatedDetails);
                }
            } catch (error) {
                if (currentAnalysisAbort.signal.aborted) throw error;
                console.error(`分析第 ${idx + 1} 段時出錯:`, error);
                paragraphAnalyses[idx] = { chinese_translation: `[第 ${idx + 1} 段分析失敗]`, word_alignment: [], detailed_analysis: [] };
                lastFailedIndices.push(idx);
                try { renderParagraph(idx, text, paragraphAnalyses[idx]); } catch(_) {}
            } finally {
                // finalize elapsed time
                if (paragraphStartTime[idx]) paragraphElapsedMs[idx] = Math.max(0, Date.now() - paragraphStartTime[idx]);
                completed += 1;
                updateAnalysisProgress(completed, total, `已完成 ${completed} 段分析`);
                await runNext();
            }
        };

        const runners = [];
        for (let i = 0; i < CONCURRENCY; i++) runners.push(runNext());
        await Promise.all(runners);

        const finalResult = {
            // Join translated paragraphs with visible newlines; keep it single-line JS string
            chinese_translation: paragraphAnalyses.map(p => p.chinese_translation).join('\n\n'),
            word_alignment: paragraphAnalyses.flatMap(p => p.word_alignment || []),
            detailed_analysis: paragraphAnalyses.flatMap(p => p.detailed_analysis || []),
            paragraph_analysis: paragraphAnalyses
        };

        dom.articleAnalysisContainer.dataset.analysis = JSON.stringify(finalResult.detailed_analysis || []);
        // 僅更新資料與歷史快取，不做全量重繪（保留逐段增量渲染）
        storage.saveAnalysisResult(articleText, finalResult);
        if (dom.retryFailedParagraphsBtn) {
            dom.retryFailedParagraphsBtn.style.display = lastFailedIndices.length > 0 ? 'inline-block' : 'none';
        }
        populateArticleHistorySelect();

    } catch (error) {
        if (currentAnalysisAbort?.signal?.aborted) {
            dom.articleAnalysisContainer.innerHTML = '<p>已取消此次分析。</p>';
        } else {
            console.error('分析文章時出錯:', error);
            dom.articleAnalysisContainer.innerHTML = `<p style="color: red;">分析失敗！請檢查API Key或網絡連接後再試。</p>`;
        }
    } finally {
        dom.analyzeArticleBtn.disabled = false;
        dom.analyzeArticleBtn.textContent = '分析文章';
        const inline = dom.articleAnalysisContainer.querySelector('.inline-progress');
        if (inline) inline.remove();
    }
}

function updateAnalysisProgress(completed, total, message) {
    const container = dom.articleAnalysisContainer;
    // 若已存在段落骨架，使用行內小型進度，不覆蓋內容
    if (container.querySelector('.paragraph-pair')) {
        let inline = container.querySelector('.inline-progress');
        if (!inline) {
            inline = document.createElement('div');
            inline.className = 'inline-progress';
            inline.style.fontSize = '12px';
            inline.style.opacity = '0.8';
            inline.style.margin = '6px 0';
            const titlePair = container.querySelector('.paragraph-pair.is-title');
            if (titlePair) titlePair.insertAdjacentElement('afterend', inline);
            else container.prepend(inline);
        }
        inline.textContent = `${message} (${completed}/${total})`;
        return;
    }
    const progressFill = container.querySelector('.progress-fill');
    const progressText = container.querySelector('.progress-text');
    if (progressFill && progressText) {
        progressFill.style.width = `${(completed / total) * 100}%`;
        progressText.textContent = `${message} (${completed}/${total})`;
    } else {
        container.innerHTML = `
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

    const { title, paragraphs: englishParagraphsRaw } = parseTitleAndParagraphs(originalArticle);
    const englishParagraphs = title ? [title, ...englishParagraphsRaw] : englishParagraphsRaw;
    const chineseParagraphs = (chinese_translation || '').split(/\n+/).filter(p => p.trim() !== '');
    const escapeRegex = (string) => string ? string.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&') : '';
    const stripSpanTags = (s) => (s || '').replace(/<\/?span[^>]*>/g, '');
    const escapeAttr = (s) => (s || '').replace(/&/g,'&amp;').replace(/\"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/'/g,'&#39;');

    let htmlContent = '';
    for (let i = 0; i < englishParagraphs.length; i++) {
        const englishPara = englishParagraphs[i] || '';
        const chinesePara = stripSpanTags(chineseParagraphs[i] || '');
        
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
            processedEnglish = processedEnglish.replace(new RegExp(`\b(${escapeRegex(pair.en)})\b`, 'g'), `<span class=\"interactive-word\" data-pair-id=\"${pairId}\" data-word=\"${escapeAttr(pair.en)}\">$1</span>`);
            processedChinese = processedChinese.replace(new RegExp(`(${escapeRegex(pair.zh)})`, 'g'), `<span class=\"interactive-word\" data-pair-id=\"${pairId}\">$1</span>`);
        });

        // sentence-level wrapping for full render
        const sentences = sentenceSplit(englishPara || '');
        const paraWords = (paragraph_analysis && paragraph_analysis[i]?.detailed_analysis) || [];
        const englishHtml = sentences.map((sText, sIdx) => {
            let sHtml = sText;
            const sAlign = (word_alignment || []).filter(p => sText.includes(p.en) && (processedChinese || '').includes(p.zh));
            const sSorted = [...sAlign].sort((a, b) => (b.en?.length || 0) - (a.en?.length || 0));
            sSorted.forEach((pair) => {
                const pid = `para-${i}-pair-${sIdx}-${pair.en}-${pair.zh}`.replace(/[^a-zA-Z0-9_-]/g,'_');
                sHtml = sHtml.replace(new RegExp(`\b(${escapeRegex(pair.en)})\b`, 'g'), `<span class=\"interactive-word\" data-pair-id=\"${pid}\" data-word=\"${escapeAttr(pair.en)}\">$1</span>`);
            });
            const words = paraWords.filter(w => w.word && sText.includes(w.word)).map(w => w.word);
            Array.from(new Set(words)).forEach(w => {
                const marker = `data-word=\"${escapeAttr(w)}\"`;
                if (sHtml.includes(marker)) return;
                const re = new RegExp(`\b(${escapeRegex(w)})\b`, 'g');
                sHtml = sHtml.replace(re, `<span class=\"interactive-word\" data-word=\"${escapeAttr(w)}\">$1</span>`);
            });
            return `<span class=\"sentence-wrap\">` +
                   `<span class=\"interactive-sentence\" data-para-index=\"${i}\" data-sent-index=\"${sIdx}\" data-sentence=\"${escapeAttr(sText)}\">${sHtml}</span>` +
                   `<button class=\"sent-analyze-btn icon-only\" data-para-index=\"${i}\" data-sent-index=\"${sIdx}\" title=\"解析\" aria-label=\"解析\"><svg width=\"12\" height=\"12\" viewBox=\"0 0 16 16\" aria-hidden=\"true\"><path fill=\"currentColor\" d=\"M8 1a7 7 0 1 1 0 14A7 7 0 0 1 8 1zm0 1.5A5.5 5.5 0 1 0 8 13.5 5.5 5.5 0 0 0 8 2.5zm.93 3.412a1.5 1.5 0 0 0-2.83.588h1.005c0-.356.29-.64.652-.64.316 0 .588.212.588.53 0 .255-.127.387-.453.623-.398.29-.87.654-.87 1.29v.255h1V8c0-.254.128-.387.454-.623.398-.29.87-.654.87-1.29 0-.364-.146-.706-.416-.935zM8 10.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5z\"/></svg></button>` +
                   `</span>`;
        }).join(' ');

        // Chinese sentence wrapping + cleaning
        const cleanedZh = cleanChinese(stripSpanTags(processedChinese || ''));
        const zhSentences = sentenceSplitZh(cleanedZh);
        const zhHtml = zhSentences.map((z, sIdx) => `<span class=\"interactive-sentence-zh\" data-para-index=\"${i}\" data-sent-index=\"${sIdx}\">${escapeAttr(z)}</span>`).join(' ');

        const isTitle = !!title && i === 0;
        htmlContent += `
            <div class=\"paragraph-pair${isTitle ? ' is-title' : ''}\" data-paragraph-index=\"${i}\" data-english=\"${escapeAttr(englishPara)}\">
                <div class=\"paragraph-english\">${englishHtml}</div>
                <div class=\"paragraph-chinese\">${zhHtml}</div>
            </div>`;
    }
    
    dom.articleAnalysisContainer.innerHTML = htmlContent;
    // 包裝英文單詞為可點 token（一次性）
    dom.articleAnalysisContainer.querySelectorAll('.paragraph-english').forEach(wrapWordsInElementOnce);
    dom.articleAnalysisContainer.dataset.analysis = JSON.stringify(detailed_analysis || []);
}

function clearArticleInput() {
    dom.articleInput.value = '';
    dom.articleAnalysisContainer.innerHTML = '<p>請先輸入文章並點擊分析按鈕。</p>';
    dom.articleHistorySelect.value = '';
    if (currentAnalysisAbort) {
        try { currentAnalysisAbort.abort('cancelled-by-clear'); } catch (_) { /* noop */ }
    }
    if (dom.retryFailedParagraphsBtn) dom.retryFailedParagraphsBtn.style.display = 'none';
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

// Build reading chunks from the rendered analysis DOM when available,
// falling back to raw text splitting when analysis is not present.
function buildReadingChunks(mode) {
    const chunks = [];
    const area = dom.articleAnalysisContainer;
    const hasRendered = !!area.querySelector('.paragraph-pair');

    if (hasRendered) {
        const paraEls = Array.from(area.querySelectorAll('.paragraph-pair .paragraph-english'));
        if (mode === 'full') {
            const text = paraEls.map(el => el.textContent.trim()).filter(Boolean).join(' ');
            chunks.push({ type: 'full', text, el: null });
            return chunks;
        }
        if (mode === 'paragraph') {
            paraEls.forEach(el => {
                const text = Array.from(el.querySelectorAll('.interactive-sentence')).map(s => s.textContent.trim()).join(' ')
                    || el.textContent.trim();
                if (text) chunks.push({ type: 'paragraph', text, el });
            });
            return chunks;
        }
        // sentence mode
        paraEls.forEach(el => {
            const sentEls = Array.from(el.querySelectorAll('.interactive-sentence'));
            if (sentEls.length) {
                sentEls.forEach(s => {
                    const t = s.textContent.trim();
                    if (t) chunks.push({ type: 'sentence', text: t, el: s });
                });
            } else {
                const t = el.textContent.trim();
                if (t) chunks.push({ type: 'sentence', text: t, el });
            }
        });
        return chunks;
    }

    // Fallback when no analysis rendered yet
    const text = dom.articleInput.value.trim();
    if (!text) return chunks;
    const splitText = (t, m) => {
        if (m === 'paragraph') return t.split(/\n+/).filter(p => p.trim() !== '');
        if (m === 'sentence' || m === 'full') return t.match(/[^.!?]+[.!?]*/g) || [t];
        return [t];
    };
    const parts = splitText(text, mode);
    if (mode === 'full') {
        chunks.push({ type: 'full', text, el: null });
    } else if (mode === 'paragraph') {
        parts.forEach(p => chunks.push({ type: 'paragraph', text: p, el: null }));
    } else {
        parts.forEach(s => chunks.push({ type: 'sentence', text: s, el: null }));
    }
    return chunks;
}

let _playToken = 0; // 用於避免競態：切段期間舊的 onEnd 不再推進

function readArticle() {
    const text = dom.articleInput.value.trim();
    if (!text) {
        alert('請先輸入要朗讀的文章！');
        return;
    }
    const mode = dom.readingModeSelect.value;
    state.setIsReadingChunkPaused(false);
    const chunks = buildReadingChunks(mode === 'full' ? 'full' : mode);
    state.setReadingChunks(chunks);
    if (state.readingChunks.length > 0) {
        state.setCurrentChunkIndex(0);
        dom.chunkNavControls.classList.toggle('hidden', state.readingChunks.length <= 1);
        _playToken++; // 重置 token
        playCurrentChunk();
    }
}

function stopReadArticle() {
    audio.stopCurrentAudio();
    state.setIsReadingChunkPaused(false);
    dom.stopReadArticleBtn.disabled = true;
    updateReadButtonUI('stopped');
    // 若片段數量 <= 1，隱藏切換控制
    try { dom.chunkNavControls.classList.toggle('hidden', (state.readingChunks || []).length <= 1); } catch (_) {}
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
    if (dom.currentSentenceDisplay) {
        dom.currentSentenceDisplay.textContent = (chunk?.type === 'full') ? '全文' : (chunk?.text || '');
    }

    const repeatTimesVal = parseInt(dom.chunkRepeatTimes.value, 10) || 1;
    
    const token = ++_playToken;
    const onEnd = () => {
        if (token !== _playToken) return; // 已切換，不再推進
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
    audio.speakText(chunk?.text || String(chunk || ''), 'en-US', state.currentSpeed, () => {
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
        _playToken++; // 取消前一段的 onEnd 推進
        state.setCurrentChunkIndex(state.currentChunkIndex + 1);
        state.setSentenceRepeatCount(0);
        state.setIsReadingChunkPaused(false);
        
        // 立即更新UI
        updateChunkNav();
        
        // 短延遲後開始播放
        setTimeout(() => { playCurrentChunk(); }, 10);
    }
}

function playPrevChunk() {
    // 防止在非播放状态下切换
    if (dom.stopReadArticleBtn.disabled) return;
    
    if (state.currentChunkIndex > 0) {
        audio.stopCurrentAudio();
        _playToken++;
        state.setCurrentChunkIndex(state.currentChunkIndex - 1);
        state.setSentenceRepeatCount(0);
        state.setIsReadingChunkPaused(false);
        
        // 立即更新UI
        updateChunkNav();
        
        // 短延遲後開始播放
        setTimeout(() => { playCurrentChunk(); }, 10);
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

function clearReadingHighlights() {
    dom.articleAnalysisContainer.querySelectorAll('.interactive-sentence.sentence-active').forEach(el => el.classList.remove('sentence-active'));
    dom.articleAnalysisContainer.querySelectorAll('.paragraph-english.para-active').forEach(el => el.classList.remove('para-active'));
    dom.articleAnalysisContainer.classList.remove('full-reading-active');
}

function highlightCurrentChunk(chunk) {
    clearReadingHighlights();
    if (!chunk) return;
    if (chunk.type === 'sentence' && chunk.el) {
        chunk.el.classList.add('sentence-active');
        // 確保可視
        try { chunk.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (_) {}
    } else if (chunk.type === 'paragraph' && chunk.el) {
        chunk.el.classList.add('para-active');
        try { chunk.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (_) {}
    } else if (chunk.type === 'full') {
        dom.articleAnalysisContainer.classList.add('full-reading-active');
        try { dom.articleAnalysisContainer.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (_) {}
    }
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
        // 將標題一併插入正文最前面，以 Markdown 風格 # 開頭展示
        const title = (article && article.title) ? `# ${article.title}\n\n` : '';
        dom.articleInput.value = `${title}${article.content || ''}`.trim();
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
        const doHighlight = (id, on) => {
            const elements = document.querySelectorAll(`[data-pair-id="${id}"]`);
            if (on) elements.forEach(el => el.classList.add('highlight'));
            else elements.forEach(el => el.classList.remove('highlight'));
        };
        if (e.type === 'mouseover') {
            if (pairId) {
                doHighlight(pairId, true);
            } else {
                ensureWordPairMapping(target).then(ok => {
                    if (ok && target.dataset.pairId) doHighlight(target.dataset.pairId, true);
                    else target.classList.add('highlight');
                }).catch(() => { target.classList.add('highlight'); });
            }
        } else {
            target.classList.remove('highlight');
            if (pairId) doHighlight(pairId, false);
        }
    }
}

// 動態補配對的實作定義在本檔案靠後（"Lazy pairing helpers" 區段）

function handleArticleWordAnalysisClick(e) {
    if (e.target.classList.contains('interactive-word')) {
        e.stopPropagation();
        try {
            const analysisArray = JSON.parse(dom.articleAnalysisContainer.dataset.analysis || '[]');
            // 無論是否已有分析資料，都嘗試顯示；若無命中，showArticleWordAnalysis 會走懶載
            showArticleWordAnalysis(e.target, Array.isArray(analysisArray) ? analysisArray : []);
        } catch (err) {
            console.error("Failed to parse analysis data:", err);
            // 解析失敗時也嘗試以空陣列啟動懶載
            showArticleWordAnalysis(e.target, []);
        }
    }
}

// Sentence analyze button to lazy-load sentence analysis
dom.articleAnalysisContainer.addEventListener('click', async (ev) => {
    const rawTarget = ev.target && ev.target.nodeType === 3 ? ev.target.parentElement : ev.target;
    const chunkBtn = rawTarget?.closest && rawTarget.closest('.chunk-explain');
    if (chunkBtn) {
        ev.stopPropagation();
        ev.preventDefault();
        const card = chunkBtn.closest('.sentence-card');
        if (!card) return;
        const phrase = chunkBtn.getAttribute('data-phrase') || '';
        if (!phrase) return;
        const sentence = card.dataset.sentence || '';
        const context = card.dataset.context || '';
        const paraIdx = parseInt(card.dataset.paraIdx, 10) || 0;
        const sentIdx = parseInt(card.dataset.sentIdx, 10) || 0;
        chunkBtn.disabled = true; chunkBtn.textContent = '詳解中...';
        try {
            const res = await api.analyzeSelection(phrase, sentence, context, { timeoutMs: 15000 });
            const box = document.createElement('div');
            box.className = 'phrase-explain-box';
            box.style.margin = '4px 0 4px 50px';
            box.style.fontSize = '12px';
            const esc = (s) => (s || '').replace(/&/g,'&amp;').replace(/\"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/'/g,'&#39;');
            const ex = Array.isArray(res.analysis?.examples) ? res.analysis.examples.slice(0,2) : [];
            box.innerHTML = `<div style="display:flex;justify-content:space-between;gap:8px;align-items:center;">
                               <div><strong>${esc(res.selection || phrase)}</strong>：${esc(res.analysis?.meaning || '')}
                                   ${res.analysis?.usage ? `<div>用法：${esc(res.analysis.usage)}</div>`:''}
                                   ${ex.length? '<div>' + ex.map(x=>`<div>• ${esc(x.en)} — ${esc(x.zh)}</div>`).join('') + '</div>' : ''}
                               </div>
                               <button class="phrase-close" style="font-size:12px;">關閉</button>
                             </div>`;
            const chunkItem = chunkBtn.closest('.chunk-item');
            if (chunkItem) chunkItem.after(box);
            else card.appendChild(box);
            applySentenceDim(paraIdx, sentIdx, true);
            const closeBtn = box.querySelector('.phrase-close');
            if (closeBtn) closeBtn.addEventListener('click', () => {
                box.remove();
                if (!card.querySelector('.phrase-explain-box')) {
                    applySentenceDim(paraIdx, sentIdx, false);
                }
            });
        } catch (err) {
            console.warn('片語詳解請求失敗:', err);
            alert('解析失敗，稍後再試');
        } finally {
            chunkBtn.disabled = false; chunkBtn.textContent = '詳解';
        }
        return;
    }
    const btn = rawTarget?.closest && rawTarget.closest('.sent-analyze-btn');
    if (!btn) return;
    ev.stopPropagation();
    const paraIdx = parseInt(btn.getAttribute('data-para-index'), 10) || 0;
    const sentIdx = parseInt(btn.getAttribute('data-sent-index'), 10) || 0;
    const el = dom.articleAnalysisContainer.querySelector(`.interactive-sentence[data-para-index="${paraIdx}"][data-sent-index="${sentIdx}"]`);
    if (el) await toggleSentenceCard(el);
});

// Tooltip actions delegation: phrase analysis buttons
dom.analysisTooltip.addEventListener('click', async (e) => {
    // 在 tooltip 內的任何點擊都不向外冒泡，避免觸發外層關閉/重繪邏輯
    e.stopPropagation();
    const rawTarget = e.target && e.target.nodeType === 3 ? e.target.parentElement : e.target;
    const btnPhrase = rawTarget?.closest && rawTarget.closest('.btn-analyze-phrase');
    const btnCustom = rawTarget?.closest && rawTarget.closest('.btn-analyze-phrase-custom');
    const btnPlay = rawTarget?.closest && rawTarget.closest('.btn-play-word');
    if (btnPlay) {
        const w = btnPlay.getAttribute('data-word') || '';
        if (w) audio.speakText(w, 'en-US', 0);
        return;
    }
    const btnAdd = rawTarget?.closest && rawTarget.closest('.btn-add-to-book');
    if (btnAdd) {
        e.stopPropagation();
        const w = btnAdd.getAttribute('data-word') || '';
        const sentence = btnAdd.getAttribute('data-sentence') || '';
        const context = btnAdd.getAttribute('data-context') || '';
        try {
            const mod = await import('../../modules/vocab.js');
            await mod.addWordToDefaultBook(w, { source: 'article', sentence, context });
        } catch (err) {
            console.warn('加入生詞本失敗:', err);
        }
        return;
    }
    if (!btnPhrase && !btnCustom) return;
    // 已在最上方 stopPropagation；此處保持語義一致
    const sentence = (btnPhrase || btnCustom).getAttribute('data-sentence') || '';
    const context = (btnPhrase || btnCustom).getAttribute('data-context') || '';
    let selection = (btnPhrase || btnCustom).getAttribute('data-default') || '';
    if (btnCustom) {
        const input = prompt('輸入要解析的片語', selection);
        if (!input) return;
        selection = input.trim();
    }
    const resultBox = dom.analysisTooltip.querySelector('.tooltip-phrase-result');
    if (resultBox) resultBox.textContent = '解析中...';
    try {
        const res = await api.analyzeSelection(selection, sentence, context, { timeoutMs: 15000 });
        if (resultBox) {
            const esc = (s) => (s || '').replace(/&/g,'&amp;').replace(/\"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/'/g,'&#39;');
            const ex = Array.isArray(res.analysis?.examples) ? res.analysis.examples.slice(0,2) : [];
            const phon = (res.analysis?.phonetic || '').replace(/^\/|\/$/g, '');
            resultBox.innerHTML = `<div><strong>片語:</strong> ${esc(res.selection || selection)}${phon ? ` <span class=\"tooltip-phonetic\">/${esc(phon)}/</span>` : ''}</div>
                                   <div><strong>釋義:</strong> ${esc(res.analysis?.meaning || '')}</div>
                                   ${res.analysis?.usage ? `<div><strong>用法:</strong> ${esc(res.analysis.usage)}</div>`:''}
                                   ${ex.length? '<div style="margin-top:4px">' + ex.map(x=>`<div>• ${esc(x.en)} — ${esc(x.zh)}</div>`).join('') + '</div>' : ''}`;
        }
    } catch (err) {
        if (resultBox) resultBox.innerHTML = '<span style="color:#b91c1c">解析失敗，稍後重試</span>';
    }
});

function showArticleWordAnalysis(clickedElement, analysisArray) {
    const wordText = clickedElement.dataset.word || clickedElement.textContent;
    const wordIndex = parseInt(clickedElement.dataset.wordIndex, 10) || 0;

    const matchingAnalyses = analysisArray.filter(item => item.word && item.word.toLowerCase() === (wordText || '').toLowerCase());
    let wordAnalysisData = (wordIndex < matchingAnalyses.length) ? matchingAnalyses[wordIndex] : null;

    const showTooltip = (data, sentenceForBtn = null, contextForBtn = null, defaultPhrase = wordText) => {
        const escAttr = (s) => (s || '').replace(/&/g,'&amp;').replace(/\"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/'/g,'&#39;');
        if (data && data.analysis) {
            const analysis = data.analysis;
            const phonetic = analysis.phonetic ? ` /${analysis.phonetic.replace(/^\/|\/$/g, '')}/` : '';
            ui.repositionTooltip(clickedElement);
            dom.analysisTooltip.innerHTML = `
                <div class="tooltip-title">${data.word}<span class="tooltip-phonetic">${phonetic}</span> (${analysis.pos})</div>
                <div class="tooltip-content">
                    <p><strong>作用:</strong> ${analysis.role}</p>
                    <p><strong>意思:</strong> ${analysis.meaning}</p>
                </div>
                <div class="tooltip-actions" style="margin-top:6px;display:flex;gap:6px;align-items:center;">
                    <button class="btn-ghost btn-mini btn-play-word" data-word="${escAttr(data.word || defaultPhrase)}">發音</button>
                    <button class="btn-ghost btn-mini btn-add-to-book" data-word="${escAttr(defaultPhrase||data.word||'')}" data-sentence="${escAttr(sentenceForBtn||'')}" data-context="${escAttr(contextForBtn||'')}">加入生詞本</button>
                    <button class="btn-ghost btn-mini btn-analyze-phrase" data-sentence="${escAttr(sentenceForBtn||'')}" data-context="${escAttr(contextForBtn||'')}" data-default="${escAttr(defaultPhrase||'')}">片語解析</button>
                    <button class="btn-ghost btn-mini btn-analyze-phrase-custom" data-sentence="${escAttr(sentenceForBtn||'')}" data-context="${escAttr(contextForBtn||'')}" data-default="${escAttr(defaultPhrase||'')}">自訂片語...</button>
                </div>
                <div class="tooltip-phrase-result" style="margin-top:6px;font-size:12px;"></div>`;
        } else {
            dom.analysisTooltip.innerHTML = `<div class="tooltip-content"><p>分析數據未找到。</p></div>`;
        }
        dom.analysisTooltip.style.display = 'block';
        ui.repositionTooltip(clickedElement);
    };

    if (wordAnalysisData && wordAnalysisData.analysis) {
        // build context for phrase button
        const englishContainer = clickedElement.closest('.paragraph-english');
        const pairContainer = clickedElement.closest('.paragraph-pair');
        const paraEnglish = pairContainer ? pairContainer.getAttribute('data-english') || englishContainer?.textContent || '' : englishContainer?.textContent || '';
        const sentences = (paraEnglish.match(/[^.!?]+[.!?]*/g) || [paraEnglish]);
        const sentence = sentences.find(s => s.includes(wordText)) || paraEnglish;
        showTooltip(wordAnalysisData, sentence, paraEnglish, wordText);
        return;
    }

    // 懶載詳解：僅當點擊英文字時觸發
    const englishContainer = clickedElement.closest('.paragraph-english');
    if (!englishContainer) {
        showTooltip(null);
        return;
    }
    const pairContainer = clickedElement.closest('.paragraph-pair');
    const paraEnglish = pairContainer ? pairContainer.getAttribute('data-english') || englishContainer.textContent : englishContainer.textContent;

    // 找出包含該詞的句子
    const sentences = paraEnglish.match(/[^.!?]+[.!?]*/g) || [paraEnglish];
    const sentence = sentences.find(s => s.includes(wordText)) || paraEnglish;

    // 去重：避免重覆請求
    const lazyKey = `${sentence}::${wordText}`;
    if (!showArticleWordAnalysis._lazyCache) showArticleWordAnalysis._lazyCache = new Map();
    if (showArticleWordAnalysis._lazyCache.has(lazyKey)) {
        const data = showArticleWordAnalysis._lazyCache.get(lazyKey);
        // 合併到 analysisArray 並更新 dataset（去重）
        const merged = mergeDetailedAnalyses(analysisArray, [data]);
        dom.articleAnalysisContainer.dataset.analysis = JSON.stringify(merged);
        showTooltip(data);
        return;
    }

    dom.analysisTooltip.innerHTML = `<div class="tooltip-content"><p>載入中...</p></div>`;
    dom.analysisTooltip.style.display = 'block';
    ui.repositionTooltip(clickedElement);

    api.analyzeWordInSentence(wordText, sentence, { timeoutMs: 20000 }).then(data => {
        // 標準化返回結構
        const normalized = data && data.analysis ? data : {
            word: wordText,
            sentence,
            analysis: {
                phonetic: data?.analysis?.phonetic || '',
                pos: data?.analysis?.pos || '',
                meaning: data?.analysis?.meaning || (typeof data === 'string' ? data : ''),
                role: data?.analysis?.role || ''
            }
        };
        showArticleWordAnalysis._lazyCache.set(lazyKey, normalized);
        const merged = mergeDetailedAnalyses(analysisArray, [normalized]);
        dom.articleAnalysisContainer.dataset.analysis = JSON.stringify(merged);
        showTooltip(normalized, sentence, paraEnglish, wordText);
    }).catch(err => {
        console.warn('懶載詳解失敗:', err);
        showTooltip(null);
    });
}

// --- Lazy pairing helpers ---
const _pendingPairKeys = new Set();

async function ensureWordPairMapping(wordEl) {
    if (!wordEl || wordEl.dataset.pairId) return true;
    const rawWord = (wordEl.dataset.word || wordEl.textContent || '').trim();
    if (!rawWord) return false;
    const sentenceEl = wordEl.closest('.interactive-sentence');
    const paraEl = wordEl.closest('.paragraph-pair');
    const zhContainer = paraEl ? paraEl.querySelector('.paragraph-chinese') : null;
    if (!sentenceEl || !paraEl || !zhContainer) return false;
    const sentence = sentenceEl.getAttribute('data-sentence') || sentenceEl.textContent || '';
    const context = paraEl.getAttribute('data-english') || '';
    const sentIdx = parseInt(sentenceEl.getAttribute('data-sent-index'), 10) || 0;
    const key = `${sentence}::${rawWord}`;
    if (_pendingPairKeys.has(key)) return false;
    _pendingPairKeys.add(key);
    try {
        // 句級請求走去重，避免同一句多次 hover/點擊導致的重複並發
        const data = await analyzeSentenceDedupe(sentence, context, { timeoutMs: 15000 });
        const aligns = (data && Array.isArray(data.phrase_alignment)) ? data.phrase_alignment : [];
        // find an alignment whose en contains the word (case-insensitive)
        const lower = rawWord.toLowerCase();
        const cand = aligns.find(p => (p.en || '').toLowerCase().includes(lower) && p.zh);
        if (!cand) return false;
        const pairId = `dyn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,6)}`;
        // mark English
        wordEl.setAttribute('data-pair-id', pairId);
        // wrap Chinese match inside corresponding sentence if present
        const zhSentenceEl = zhContainer.querySelector(`.interactive-sentence-zh[data-sent-index="${sentIdx}"]`);
        const wrapTarget = zhSentenceEl || zhContainer;
        const wrapped = wrapChineseWithPairId(wrapTarget, String(cand.zh), pairId);
        return wrapped;
    } catch (err) {
        return false;
    } finally {
        _pendingPairKeys.delete(key);
    }
}

function wrapChineseWithPairId(container, zh, pairId) {
    if (!container || !zh || container.querySelector(`[data-pair-id="${pairId}"]`)) return true;
    const tw = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = tw.nextNode())) {
        const txt = node.nodeValue || '';
        const idx = txt.indexOf(zh);
        if (idx >= 0) {
            const before = document.createTextNode(txt.slice(0, idx));
            const mid = document.createElement('span');
            mid.className = 'interactive-word';
            mid.setAttribute('data-pair-id', pairId);
            mid.textContent = txt.slice(idx, idx + zh.length);
            const after = document.createTextNode(txt.slice(idx + zh.length));
            const parent = node.parentNode;
            parent.replaceChild(after, node);
            parent.insertBefore(mid, after);
            parent.insertBefore(before, mid);
            return true;
        }
    }
    return false;
}

async function retrySingleParagraph(idx, options = {}) {
    const articleText = dom.articleInput.value.trim();
    if (!articleText) return;
    const { title, paragraphs } = parseTitleAndParagraphs(articleText);
    const all = title ? [title, ...paragraphs] : paragraphs;
    if (idx < 0 || idx >= all.length) return;
    const level = (dom.analysisLevelSelect && dom.analysisLevelSelect.value) || 'standard';
    const timeoutMs = level === 'quick' ? 30000 : (level === 'standard' ? 45000 : 60000);
    const text = all[idx];
    const statusDiv = document.querySelector(`.paragraph-pair[data-paragraph-index="${idx}"] .para-status`);
    if (statusDiv) {
        statusDiv.dataset.status = 'pending';
        const t = statusDiv.querySelector('.status-text');
        const b = statusDiv.querySelector('.retry-paragraph-btn');
        if (t) t.textContent = '分析中...';
        if (b) b.style.display = 'none';
    }
    try {
        paragraphStartTime[idx] = Date.now();
        const result = await api.analyzeParagraph(text, { timeoutMs, level, noCache: !!options.force });
        renderParagraph(idx, text, result);
        // merge into aggregated dataset
        let aggregated = [];
        try { aggregated = JSON.parse(dom.articleAnalysisContainer.dataset.analysis || '[]'); } catch(_) {}
        if (Array.isArray(result?.detailed_analysis)) {
            aggregated = mergeDetailedAnalyses(aggregated, result.detailed_analysis);
            dom.articleAnalysisContainer.dataset.analysis = JSON.stringify(aggregated);
        }
        // remove from failed list if present
        lastFailedIndices = (lastFailedIndices || []).filter(i => i !== idx);
        if (dom.retryFailedParagraphsBtn) dom.retryFailedParagraphsBtn.style.display = lastFailedIndices.length > 0 ? 'inline-block' : 'none';
        // compute and show elapsed
        if (paragraphStartTime[idx]) paragraphElapsedMs[idx] = Math.max(0, Date.now() - paragraphStartTime[idx]);
        renderParagraph(idx, text, result);
        // flash success highlight
        flashParagraphSuccess(idx);
    } catch (e) {
        console.warn(`單段重試失敗 ${idx+1}`, e);
        // show failed state again
        const t = statusDiv && statusDiv.querySelector('.status-text');
        const b = statusDiv && statusDiv.querySelector('.retry-paragraph-btn');
        if (statusDiv) statusDiv.dataset.status = 'failed';
        if (t) t.textContent = '失敗 ⚠️';
        if (b) b.style.display = 'inline-block';
        if (!lastFailedIndices.includes(idx)) lastFailedIndices.push(idx);
        if (dom.retryFailedParagraphsBtn) dom.retryFailedParagraphsBtn.style.display = 'inline-block';
    }
}

function flashParagraphSuccess(index) {
    const container = document.querySelector(`.paragraph-pair[data-paragraph-index="${index}"]`);
    if (!container) return;
    const prev = container.style.transition;
    container.style.transition = 'background-color 0.4s ease';
    const oldBg = container.style.backgroundColor;
    container.style.backgroundColor = 'rgba(255, 255, 0, 0.35)';
    setTimeout(() => {
        container.style.backgroundColor = oldBg || '';
        setTimeout(() => { container.style.transition = prev || ''; }, 450);
    }, 120);
}

// --- Incremental paragraph rendering helpers ---
function renderParagraph(index, englishPara, result) {
    const container = document.querySelector(`.paragraph-pair[data-paragraph-index="${index}"]`);
    if (!container) return;
    const esc = (s) => (s || '').replace(/&/g,'&amp;').replace(/\"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/'/g,'&#39;');
    const escapeRegex = (string) => string ? string.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&') : '';
    const englishDiv = container.querySelector('.paragraph-english');
    const chineseDiv = container.querySelector('.paragraph-chinese');
    const statusDiv = container.querySelector('.para-status');

    const alignment = (result && Array.isArray(result.word_alignment)) ? result.word_alignment : [];
    let chinese = result?.chinese_translation || '';
    chinese = cleanChinese(chinese);

    const stripSpanTags = (s) => (s || '').replace(/<\/?span[^>]*>/g, '');
    let processedChinese = stripSpanTags(chinese || '');

    // Build sentence-by-sentence HTML for English to support per-sentence click
    const sentences = sentenceSplit(englishPara || '');
    const htmlParts = [];
    const paraWords = (result && Array.isArray(result.detailed_analysis)) ? result.detailed_analysis : [];

    sentences.forEach((s, sIdx) => {
        let sHtml = s;
        // alignment limited to this sentence
        const sAlign = alignment.filter(p => s.includes(p.en) && (processedChinese || '').includes(p.zh));
        const sSorted = [...sAlign].sort((a, b) => (b.en?.length || 0) - (a.en?.length || 0));
        sSorted.forEach((pair) => {
            const pairId = `para-${index}-pair-${sIdx}-${pair.en}-${pair.zh}`.replace(/[^a-zA-Z0-9_-]/g,'_');
            sHtml = sHtml.replace(new RegExp(`\\b(${escapeRegex(pair.en)})\\b`, 'g'), `<span class=\"interactive-word\" data-pair-id=\"${pairId}\" data-word=\"${esc(pair.en)}\">$1</span>`);
        });
        // fallback mark words from detailed_analysis
        const sWords = paraWords.filter(w => w.word && s.includes(w.word)).map(w => w.word);
        const sUnique = Array.from(new Set(sWords));
        sUnique.forEach(word => {
            const marker = `data-word=\"${esc(word)}\"`;
            if (sHtml.includes(marker)) return;
            const re = new RegExp(`\\b(${escapeRegex(word)})\\b`, 'g');
            sHtml = sHtml.replace(re, `<span class=\"interactive-word\" data-word=\"${esc(word)}\">$1</span>`);
        });
        htmlParts.push(`<span class=\"sentence-wrap\">` +
            `<span class=\"interactive-sentence\" data-para-index=\"${index}\" data-sent-index=\"${sIdx}\" data-sentence=\"${esc(s)}\">${sHtml}</span>` +
            `<button class=\"sent-analyze-btn icon-only\" data-para-index=\"${index}\" data-sent-index=\"${sIdx}\" title=\"解析\" aria-label=\"解析\"><svg width=\"12\" height=\"12\" viewBox=\"0 0 16 16\" aria-hidden=\"true\"><path fill=\"currentColor\" d=\"M8 1a7 7 0 1 1 0 14A7 7 0 0 1 8 1zm0 1.5A5.5 5.5 0 1 0 8 13.5 5.5 5.5 0 0 0 8 2.5zm.93 3.412a1.5 1.5 0 0 0-2.83.588h1.005c0-.356.29-.64.652-.64.316 0 .588.212.588.53 0 .255-.127.387-.453.623-.398.29-.87.654-.87 1.29v.255h1V8c0-.254.128-.387.454-.623.398-.29.87-.654.87-1.29 0-.364-.146-.706-.416-.935zM8 10.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5z\"/></svg></button>` +
            `</span>`);
    });

    englishDiv.innerHTML = htmlParts.join(' ');
    // 將英文句子中的純文字 token 包成可點的 interactive-word（不影響已存在的 span）
    wrapWordsInElementOnce(englishDiv);
    // Chinese sentence wrapping
    const zhSentences = sentenceSplitZh(processedChinese || chinese || '');
    const zhHtml = zhSentences.map((z, sIdx) => `<span class=\"interactive-sentence-zh\" data-para-index=\"${index}\" data-sent-index=\"${sIdx}\">${esc(z)}</span>`).join(' ');
    const failed = processedChinese ? false : true;
    chineseDiv.innerHTML = (processedChinese ? zhHtml : '<em>分析失敗</em>');

    if (statusDiv) {
        const textSpan = statusDiv.querySelector('.status-text');
        const iconSpan = statusDiv.querySelector('.status-icon');
        const elapsedSpan = statusDiv.querySelector('.elapsed');
        const retryBtn = statusDiv.querySelector('.retry-paragraph-btn');
        // show elapsed if available
        if (elapsedSpan && paragraphElapsedMs[index] != null) {
            const ms = paragraphElapsedMs[index];
            const secs = (ms / 1000).toFixed(1);
            elapsedSpan.textContent = `(${secs}s)`;
        }
        if (!failed) {
            statusDiv.dataset.status = 'done';
            if (textSpan) textSpan.textContent = '完成 ✓';
            if (iconSpan) iconSpan.textContent = '✅';
            if (retryBtn) { retryBtn.style.display = 'inline-block'; retryBtn.textContent = '重新獲取'; }
        } else {
            statusDiv.dataset.status = 'failed';
            if (textSpan) textSpan.textContent = '失敗 ⚠️';
            if (iconSpan) iconSpan.textContent = '⚠️';
            if (retryBtn) { retryBtn.style.display = 'inline-block'; retryBtn.textContent = '重試本段'; }
            if (retryBtn) retryBtn.setAttribute('data-index', String(index));
        }
    }
}

async function retryFailedParagraphs() {
    const articleText = dom.articleInput.value.trim();
    if (!articleText || !Array.isArray(lastFailedIndices) || lastFailedIndices.length === 0) return;
    if (currentAnalysisAbort) {
        try { currentAnalysisAbort.abort('cancelled-by-retry'); } catch(_) {}
    }
    currentAnalysisAbort = new AbortController();
    const { title, paragraphs } = parseTitleAndParagraphs(articleText);
    const all = title ? [title, ...paragraphs] : paragraphs;
    const total = lastFailedIndices.length;
    const level = (dom.analysisLevelSelect && dom.analysisLevelSelect.value) || 'standard';
    const timeoutMs = level === 'quick' ? 30000 : (level === 'standard' ? 45000 : 60000);
    let done = 0;
    const CONCURRENCY = Math.min(2, total);
    const SPACING_MS = 400;

    const indices = [...lastFailedIndices];
    lastFailedIndices = [];
    let aggregatedDetails = JSON.parse(dom.articleAnalysisContainer.dataset.analysis || '[]');

    const updateProgressText = (d, t) => {
        const progressText = dom.articleAnalysisContainer.querySelector('.progress-text');
        if (progressText) progressText.textContent = `重試中... (${d}/${t})`;
    };
    updateProgressText(0, indices.length);

    let nextIdx = 0;
    const runNext = async () => {
        const pick = nextIdx++;
        if (pick >= indices.length) return;
        await new Promise(r => setTimeout(r, SPACING_MS));
        const idx = indices[pick];
        const text = all[idx];
        try {
            const result = await api.analyzeParagraph(text, { timeoutMs, signal: currentAnalysisAbort.signal, level });
            renderParagraph(idx, text, result);
            if (Array.isArray(result?.detailed_analysis)) {
                aggregatedDetails = aggregatedDetails.concat(result.detailed_analysis);
                dom.articleAnalysisContainer.dataset.analysis = JSON.stringify(aggregatedDetails);
            }
        } catch (e) {
            console.warn(`重試第 ${idx + 1} 段仍失敗`, e);
            lastFailedIndices.push(idx);
        } finally {
            done += 1;
            updateProgressText(done, indices.length);
            await runNext();
        }
    };

    const runners = [];
    for (let i = 0; i < CONCURRENCY; i++) runners.push(runNext());
    await Promise.all(runners);
    if (dom.retryFailedParagraphsBtn) dom.retryFailedParagraphsBtn.style.display = lastFailedIndices.length > 0 ? 'inline-block' : 'none';
    const inline = dom.articleAnalysisContainer.querySelector('.inline-progress');
    if (inline) inline.remove();
}

// --- Sentence helpers ---
function sentenceSplit(text) {
    try {
        if (Intl && Intl.Segmenter) {
            const seg = new Intl.Segmenter('en', { granularity: 'sentence' });
            return Array.from(seg.segment(text)).map(s => s.segment.trim()).filter(Boolean);
        }
    } catch (_) {}
    // Fallback regex with simple abbreviation guard
    const abbrev = /\b(Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e)\.$/i;
    const parts = [];
    let buf = '';
    for (const ch of text) {
        buf += ch;
        if (/[.!?]/.test(ch)) {
            const trimmed = buf.trim();
            if (!abbrev.test(trimmed)) {
                parts.push(trimmed);
                buf = '';
            }
        }
    }
    if (buf.trim()) parts.push(buf.trim());
    return parts.length ? parts : [text];
}

function sentenceSplitZh(text) {
    if (!text) return [];
    // Split by Chinese punctuation while keeping them
    const re = /[^。！？；;]+[。！？；;]?/g;
    const parts = text.match(re) || [text];
    return parts.map(s => s.trim()).filter(Boolean);
}

function cleanChinese(s) {
    if (!s) return s;
    // remove stray '>' and extra spaces, normalize spaces around punctuation
    s = s.replace(/[>]+/g, '');
    s = s.replace(/\s+/g, ' ');
    s = s.replace(/\s*([，。！？；：,.!?;:])\s*/g, '$1');
    return s.trim();
}

// QA 同款：在文章詳解區選字後顯示一個小按鈕，直接加入生詞本
function initArticleSelectionToWordbook() {
    const area = dom.articleAnalysisContainer;
    if (!area) return;

    let btn = null;
    function ensureBtn() {
        if (btn) return btn;
        btn = document.createElement('button');
        btn.className = 'btn-ghost btn-mini';
        btn.textContent = '加入生詞本';
        btn.style.cssText = [
            'position:absolute',
            'z-index:9999',
            'display:none'
        ].join(';');
        document.body.appendChild(btn);
        btn.addEventListener('click', async () => {
            const sel = window.getSelection();
            const text = (sel && sel.toString && sel.toString().trim()) || '';
            if (!text) { return hideBtn(); }

            // 推斷上下文：優先 sentence，再回退 paragraph 英文
            let sentence = '';
            let context = '';
            try {
                const range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
                const node = range ? (range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement) : null;
                const sentenceEl = node && node.closest ? node.closest('.interactive-sentence') : null;
                const pair = node && node.closest ? node.closest('.paragraph-pair') : null;
                sentence = (sentenceEl && (sentenceEl.getAttribute('data-sentence') || sentenceEl.textContent)) || '';
                context = (pair && (pair.getAttribute('data-english'))) || (pair && pair.querySelector('.paragraph-english') && pair.querySelector('.paragraph-english').textContent) || sentence || '';
                if (!context) context = (dom.articleInput && dom.articleInput.value) || '';
            } catch (_) {}

            try {
                const mod = await import('../../modules/vocab.js');
                await mod.addWordToDefaultBook(text, { source: 'article', sentence, context });
            } catch (_) {}
            hideBtn();
            try { sel && sel.removeAllRanges && sel.removeAllRanges(); } catch (_) {}
        });
        return btn;
    }

    function hideBtn() { if (btn) btn.style.display = 'none'; }

    function showBtnNearSelection() {
        const sel = window.getSelection();
        const text = (sel && sel.toString && sel.toString().trim()) || '';
        if (!text) { return hideBtn(); }
        if (!sel || sel.rangeCount === 0) { return hideBtn(); }
        const range = sel.getRangeAt(0);
        // 僅處理在分析容器內的選區
        const container = range.commonAncestorContainer;
        const host = (container.nodeType === 1 ? container : container.parentElement);
        if (!area.contains(host)) { return hideBtn(); }
        const rect = range.getBoundingClientRect();
        if (!rect || (rect.width === 0 && rect.height === 0)) { return hideBtn(); }
        const b = ensureBtn();
        b.style.left = `${rect.left + window.scrollX}px`;
        b.style.top = `${rect.bottom + window.scrollY + 6}px`;
        b.style.display = 'inline-block';
    }

    area.addEventListener('mouseup', () => setTimeout(showBtnNearSelection, 0));
    area.addEventListener('touchend', () => setTimeout(showBtnNearSelection, 0), { passive: true });
    document.addEventListener('mousedown', (e) => {
        if (!btn) return;
        if (e.target === btn) return;
        hideBtn();
    });
    window.addEventListener('scroll', hideBtn, { passive: true });
}

async function toggleSentenceCard(sentenceEl) {
    const paraIdx = parseInt(sentenceEl.getAttribute('data-para-index'), 10) || 0;
    const sentIdx = parseInt(sentenceEl.getAttribute('data-sent-index'), 10) || 0;
    const sentence = sentenceEl.getAttribute('data-sentence') || sentenceEl.textContent;
    const pairContainer = sentenceEl.closest('.paragraph-pair');
    const context = pairContainer ? pairContainer.getAttribute('data-english') || '' : '';

    // existing card toggle
    let card = sentenceEl.nextElementSibling;
    if (card && card.classList.contains('sentence-card')) {
        const hidden = card.classList.toggle('hidden');
        // 切換整句高亮
        const paraIdx = parseInt(sentenceEl.getAttribute('data-para-index'), 10) || 0;
        const sentIdx = parseInt(sentenceEl.getAttribute('data-sent-index'), 10) || 0;
        applySentenceHighlight(paraIdx, sentIdx, !hidden);
        return;
    }
    card = document.createElement('div');
    card.className = 'sentence-card';
    card.style.margin = '6px 0 10px 0';
    card.style.padding = '8px 10px';
    card.style.border = '1px solid #e5e7eb';
    card.style.borderRadius = '6px';
    card.style.background = '#fafafa';
    card.innerHTML = '<div style="font-size:12px;opacity:.8">載入中...</div>';
    sentenceEl.after(card);

    try {
        const data = await analyzeSentenceDedupe(sentence, context, { timeoutMs: 22000, conciseKeypoints: true, includeStructure: true });
        renderSentenceCard(card, data, sentence, context, paraIdx, sentIdx);
        // 首次渲染即整句高亮
        applySentenceHighlight(paraIdx, sentIdx, true);
        // 片語級標記已移除，僅保留整句高亮
        // Prefetch next sentence lazily
        setTimeout(async () => {
            const next = sentenceEl.parentElement.querySelector(`.interactive-sentence[data-para-index=\"${paraIdx}\"][data-sent-index=\"${sentIdx+1}\"]`);
            if (next) {
                const nSentence = next.getAttribute('data-sentence') || next.textContent;
                try { await analyzeSentenceDedupe(nSentence, context, { timeoutMs: 15000, conciseKeypoints: true, includeStructure: true }); } catch(_){}
            }
        }, 300);
    } catch (e) {
        card.innerHTML = `<div style="color:#b91c1c">解析失敗。<button class="retry-sentence-btn">重試</button></div>`;
        const btn = card.querySelector('.retry-sentence-btn');
        if (btn) btn.addEventListener('click', async () => {
            btn.disabled = true; btn.textContent = '重試中...';
            try { const data = await api.analyzeSentence(sentence, context, { timeoutMs: 22000, noCache: true, conciseKeypoints: true, includeStructure: true }); renderSentenceCard(card, data, sentence, context, paraIdx, sentIdx); applySentenceHighlight(paraIdx, sentIdx, true); }
            catch { btn.disabled = false; btn.textContent = '重試'; }
        });
    }
}

function renderSentenceCard(card, data, sentence, context, paraIdx, sentIdx) {
    const esc = (s) => (s || '').replace(/&/g,'&amp;').replace(/\"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/'/g,'&#39;');
    const translation = esc(data.translation || '');
    const chunks = Array.isArray(data.chunks) ? data.chunks : [];
    const points = Array.isArray(data.key_points) ? data.key_points : [];
    const align = Array.isArray(data.phrase_alignment) ? data.phrase_alignment : [];
    // 去重：將與 chunks 明顯重複的 key_points 過濾掉
    const chunkLines = chunks.slice(0, 8).map(c => `${(c.text||'').toLowerCase()} ${(c.role||'').toLowerCase()} ${(c.note||'').toLowerCase()}`.replace(/\s+/g,' ').trim());
    const filteredPoints = [];
    const seen = new Set();
    for (const p of points) {
        const t = String(p).toLowerCase().replace(/\s+/g,' ').trim();
        if (!t || seen.has(t)) continue;
        seen.add(t);
        const dup = chunkLines.some(cl => cl.includes(t) || t.includes(cl));
        if (!dup) filteredPoints.push(p);
    }
    card.dataset.paraIdx = paraIdx;
    card.dataset.sentIdx = sentIdx;
    card.dataset.sentence = sentence;
    card.dataset.context = context;

    card.innerHTML = `
        <div class="sentence-card-head" style="display:flex;justify-content:space-between;align-items:center;gap:8px">
            <div style="font-weight:600">句子解析</div>
            <div class="actions" style="display:flex;gap:6px;">
                <button class="btn-ghost btn-mini sent-refresh">重新獲取</button>
                <button class="btn-ghost btn-mini sent-collapse">收合</button>
            </div>
        </div>
        <div class="sentence-translation" style="margin:6px 0 8px 0;">${translation}</div>
        ${align.length? `<div class="sentence-align" style="font-size:13px;opacity:.9;margin:4px 0;">`
            + align.slice(0,12).map(a=>`<span style="margin-right:8px"><span style="color:#0ea5e9">${esc(a.en)}</span> ➜ ${esc(a.zh)}</span>`).join('')
            + `</div>` : ''}
        ${chunks.length? `<div class="sentence-chunks">`
            + chunks.slice(0,8).map((c,idx)=>`<div class="chunk-item" data-chunk-id="sent-${paraIdx}-${sentIdx}-${idx}" style="margin:4px 0;display:flex;gap:6px;align-items:center;">
                    <button class="btn-ghost btn-mini chunk-explain" data-chunk-id="sent-${paraIdx}-${sentIdx}-${idx}" data-phrase="${esc(c.text)}">詳解</button>
                    <div class="chunk-line"><span class="chunk-text" style="color:#22c55e">${esc(c.text)}</span> — <em>${esc(c.role)}</em>${c.note? `：${esc(c.note)}`:''}</div>
                </div>`).join('')
            + `</div>` : ''}
        ${filteredPoints.length? `<ul class="sentence-points" style="margin:6px 0 0 18px;">`
            + filteredPoints.slice(0,6).map(p=>`<li>${esc(p)}</li>`).join('') + `</ul>` : ''}
        <div class="sent-footer" style="margin-top:8px;display:flex;gap:6px;align-items:center;">
            <button class="btn-ghost btn-mini analyze-selection">解析選中</button>
            <small style="opacity:.8">選取句中片語後點擊</small>
        </div>
    `;
    const refresh = card.querySelector('.sent-refresh');
    const collapse = card.querySelector('.sent-collapse');
    const selBtn = card.querySelector('.analyze-selection');
    if (collapse) collapse.addEventListener('click', ()=> {
        const hidden = card.classList.toggle('hidden');
        applySentenceHighlight(paraIdx, sentIdx, !hidden);
    });
    if (refresh) refresh.addEventListener('click', async ()=>{
        refresh.disabled = true; refresh.textContent = '重新獲取中...';
        try { const fresh = await api.analyzeSentence(sentence, context, { timeoutMs: 22000, noCache: true, conciseKeypoints: true }); renderSentenceCard(card, fresh, sentence, context, paraIdx, sentIdx); }
        finally { refresh.disabled = false; refresh.textContent = '重新獲取'; }
    });
    if (selBtn) selBtn.addEventListener('click', async ()=>{
        const sentenceEl = card.previousElementSibling;
        const selection = window.getSelection();
        const text = (selection && selection.toString && selection.toString().trim()) || '';
        if (!text) { alert('請先在該句中選取片語'); return; }
        selBtn.disabled = true; selBtn.textContent = '解析中...';
        try {
            const res = await api.analyzeSelection(text, sentence, context, { timeoutMs: 15000 });
            const box = document.createElement('div');
            box.style.marginTop = '6px'; box.style.padding='6px 8px'; box.style.border='1px dashed #ddd'; box.style.borderRadius='6px';
            box.innerHTML = `<div style="font-weight:600;">片語：${esc(res.selection||text)}</div>
                             <div>${esc(res.analysis?.meaning || '')}</div>
                             ${res.analysis?.usage? `<div style=\"opacity:.9\">用法：${esc(res.analysis.usage)}</div>`:''}
                             ${Array.isArray(res.analysis?.examples) && res.analysis.examples.length? '<div style=\"margin-top:4px\">' + res.analysis.examples.slice(0,2).map(ex=>`<div>• ${esc(ex.en)} — ${esc(ex.zh)}</div>`).join('') + '</div>' : ''}`;
            card.appendChild(box);
        } catch (e) {
            alert('解析失敗，稍後再試');
        } finally {
            selBtn.disabled = false; selBtn.textContent = '解析選中';
        }
    });
    // Add to wordbook from current selection (sentence card)
    const addBtn = document.createElement('button');
    addBtn.className = 'btn-ghost btn-mini sent-add-to-book';
    addBtn.textContent = '加入生詞本（選中）';
    addBtn.style.marginLeft = '6px';
    const footer = card.querySelector('.sent-footer');
    if (footer) footer.insertBefore(addBtn, footer.lastElementChild);
    addBtn.addEventListener('click', async () => {
        const selection = window.getSelection();
        const text = (selection && selection.toString && selection.toString().trim()) || '';
        if (!text) { alert('請先在該句中選取詞/片語'); return; }
        try {
            const mod = await import('../../modules/vocab.js');
            await mod.addWordToDefaultBook(text, { source: 'article', sentence, context });
        } catch (err) {
            console.warn('加入生詞本失敗:', err);
        }
    });

}


function applySentenceHighlight(paraIdx, sentIdx, on) {
    const eng = document.querySelector(`.interactive-sentence[data-para-index="${paraIdx}"][data-sent-index="${sentIdx}"]`);
    const zh = document.querySelector(`.interactive-sentence-zh[data-para-index="${paraIdx}"][data-sent-index="${sentIdx}"]`);
    [eng, zh].forEach(el => { if (el) el.classList.toggle('sentence-active', !!on); });
}

function applySentenceDim(paraIdx, sentIdx, on) {
    const eng = document.querySelector(`.interactive-sentence[data-para-index="${paraIdx}"][data-sent-index="${sentIdx}"]`);
    const zh = document.querySelector(`.interactive-sentence-zh[data-para-index="${paraIdx}"][data-sent-index="${sentIdx}"]`);
    [eng, zh].forEach(el => { if (el) el.classList.toggle('sentence-dim', !!on); });
}

// 將容器內的英文單詞包成可點擊的 span（僅執行一次）
function wrapWordsInElementOnce(root) {
    if (!root || root.dataset.tokensWrapped === '1') return;
    wrapWordsInElement(root);
    root.dataset.tokensWrapped = '1';
}

function wrapWordsInElement(root) {
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const targets = [];
    let node;
    while ((node = tw.nextNode())) {
        if (!node.nodeValue || !node.nodeValue.trim()) continue;
        // 跳過在按鈕等節點中的文字
        const p = node.parentElement;
        if (p && (p.closest('.sent-analyze-btn') || p.closest('.interactive-word'))) continue;
        targets.push(node);
    }
    const wordRe = /[A-Za-z][A-Za-z'’-]*/g;
    targets.forEach(textNode => {
        const text = textNode.nodeValue;
        if (!wordRe.test(text)) return;
        wordRe.lastIndex = 0;
        const frag = document.createDocumentFragment();
        let idx = 0;
        let m;
        while ((m = wordRe.exec(text))) {
            const before = text.slice(idx, m.index);
            if (before) frag.appendChild(document.createTextNode(before));
            const w = m[0];
            const span = document.createElement('span');
            span.className = 'interactive-word';
            span.setAttribute('data-word', w);
            span.textContent = w;
            frag.appendChild(span);
            idx = m.index + w.length;
        }
        const tail = text.slice(idx);
        if (tail) frag.appendChild(document.createTextNode(tail));
        textNode.parentNode.replaceChild(frag, textNode);
    });
}
