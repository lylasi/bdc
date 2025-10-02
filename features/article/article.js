import * as state from '../../modules/state.js';
import * as dom from '../../modules/dom.js';
import * as storage from '../../modules/storage.js';
import * as ui from '../../modules/ui.js';
import * as api from '../../modules/api.js';
import * as audio from '../../modules/audio.js';
import { AI_MODELS } from '../../ai-config.js';
import { loadGlobalSettings } from '../../modules/settings.js';

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
        // 文章圖片：點擊開啟燈箱（沿用 OCR lightbox overlay）
        const img = rawTarget?.closest && rawTarget.closest('.md-image img');
        if (img) {
            const sources = Array.from(dom.articleAnalysisContainer.querySelectorAll('.md-image img')).map(x => x.src);
            const uniq = Array.from(new Set(sources));
            let idx = Math.max(0, uniq.indexOf(img.src));
            const overlay = document.createElement('div');
            overlay.className = 'lightbox-overlay';
            overlay.innerHTML = `<img src="${uniq[idx]}" alt="preview">`;
            const onClose = () => { document.removeEventListener('keydown', onKey); overlay.remove(); };
            const onKey = (ev) => {
                if (ev.key === 'Escape') { onClose(); }
                else if (ev.key === 'ArrowLeft') { idx = (idx - 1 + uniq.length) % uniq.length; overlay.querySelector('img').src = uniq[idx]; }
                else if (ev.key === 'ArrowRight') { idx = (idx + 1) % uniq.length; overlay.querySelector('img').src = uniq[idx]; }
            };
            overlay.addEventListener('click', onClose);
            document.addEventListener('keydown', onKey);
            document.body.appendChild(overlay);
            return;
        }
    });

    if (dom.importArticleBtn) dom.importArticleBtn.addEventListener('click', openArticleImportModal);
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

    // 淡化強度調整
    if (dom.dimmingIntensity) {
        const applyDim = () => {
            const v = parseFloat(dom.dimmingIntensity.value);
            if (!Number.isNaN(v)) {
                dom.articleAnalysisContainer.style.setProperty('--dim-opacity', String(v));
            }
        };
        dom.dimmingIntensity.addEventListener('input', applyDim);
        dom.dimmingIntensity.addEventListener('change', applyDim);
        // 初始套用
        try { applyDim(); } catch(_) {}
    }

    populateArticleHistorySelect();

    // 選字快速加入生詞本（文章詳解區）
    try { initArticleSelectionToWordbook(); } catch (_) {}
}

// 導入文章（網址/圖片OCR）— 使用一顆按鈕彈窗，避免佔版面
function openArticleImportModal() {
    const esc = (s) => (s || '').replace(/&/g,'&amp;').replace(/\"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/'/g,'&#39;');
    const body = dom.modalBody;
    if (!body) return;
    body.innerHTML = '';

    // 簡易標籤切換
    const tabs = document.createElement('div');
    tabs.style.display = 'flex';
    tabs.style.gap = '6px';
    tabs.style.marginBottom = '8px';
    const btnUrl = document.createElement('button');
    btnUrl.className = 'btn-ghost btn-mini';
    btnUrl.textContent = '網址導入';
    btnUrl.dataset.tab = 'url';
    const btnOcr = document.createElement('button');
    btnOcr.className = 'btn-ghost btn-mini';
    btnOcr.textContent = '圖片 OCR';
    btnOcr.dataset.tab = 'ocr';
    tabs.appendChild(btnUrl); tabs.appendChild(btnOcr);
    const panel = document.createElement('div');
    panel.style.minHeight = '120px';
    body.appendChild(tabs);
    body.appendChild(panel);

    const renderUrl = () => {
        panel.innerHTML = '';
        const wrap = document.createElement('div');
        // 準備模型清單（去重）
        const s = loadGlobalSettings();
        const suggestions = [];
        const push = (v) => { if (v && typeof v === 'string' && !suggestions.includes(v)) suggestions.push(v); };
        push(s?.ai?.models?.articleCleanup);
        push(s?.ai?.models?.articleAnalysis);
        push(AI_MODELS?.articleAnalysis);
        push(AI_MODELS?.wordAnalysis);
        ['gpt-4.1-nano','gpt-4.1-mini','gpt-4o-mini','gemini-2.5-flash-nothinking'].forEach(push);
        const defaultModel = s?.ai?.models?.articleCleanup || s?.ai?.models?.articleAnalysis || AI_MODELS?.articleAnalysis || suggestions[0] || '';

        wrap.innerHTML = `
            <label for="imp-url" style="display:block;margin-bottom:6px;">貼上網址：</label>
            <div style="display:flex;gap:6px;align-items:center;">
                <input id="imp-url" type="url" placeholder="https://example.com/article" style="flex:1;">
                <button id="imp-fetch" class="btn-primary">擷取</button>
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:8px;">
                <label class="checkbox-inline" style="display:inline-flex;gap:6px;align-items:center;">
                    <input id="imp-ai-clean" type="checkbox"> <span>AI 清洗內容（更適合閱讀）</span>
                </label>
                <label class="checkbox-inline" style="display:inline-flex;gap:6px;align-items:center;">
                    <input id="imp-ai-keep-images" type="checkbox" checked> <span>清洗時保留圖片</span>
                </label>
                <div id="imp-ai-model-row" style="display:inline-flex;gap:6px;align-items:center;">
                    <label for="imp-ai-clean-model" style="white-space:nowrap;">清洗模型:</label>
                    <select id="imp-ai-clean-model" style="max-width:360px;">
                        ${suggestions.map(m => `<option value="${m}">${m}</option>`).join('')}
                    </select>
                </div>
            </div>
            <div id="imp-preview" style="display:none;margin-top:10px;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
                <div style="display:flex;gap:0;flex-wrap:wrap;">
                    <div style="flex:1;min-width:280px;border-right:1px solid #e5e7eb;">
                        <div style="background:#f8fafc;padding:6px 8px;font-weight:600;">清洗前</div>
                        <pre id="imp-before" style="margin:0;padding:8px;white-space:pre-wrap;word-break:break-word;max-height:240px;overflow:auto;"></pre>
                    </div>
                    <div style="flex:1;min-width:280px;">
                        <div style="background:#f8fafc;padding:6px 8px;font-weight:600;">清洗後</div>
                        <pre id="imp-after" style="margin:0;padding:8px;white-space:pre-wrap;word-break:break-word;max-height:240px;overflow:auto;"></pre>
                    </div>
                </div>
                <div style="padding:8px;display:flex;gap:8px;justify-content:flex-end;">
                    <button id="imp-apply" class="btn-primary">套用到輸入框</button>
                </div>
            </div>
            <p style="font-size:12px;opacity:.8;margin-top:6px;">將透過 r.jina.ai 嘗試擷取閱讀版內容；若失敗則改為簡易抽取。</p>
        `;
        panel.appendChild(wrap);
        const $ = (sel) => wrap.querySelector(sel);
        const urlInput = $('#imp-url');
        const fetchBtn = $('#imp-fetch');
        const aiCleanChk = $('#imp-ai-clean');
        const modelSelect = $('#imp-ai-clean-model');
        const keepImagesChk = $('#imp-ai-keep-images');
        if (modelSelect) modelSelect.value = defaultModel || '';
        const previewBox = $('#imp-preview');
        const beforeEl = $('#imp-before');
        const afterEl = $('#imp-after');
        const applyBtn = $('#imp-apply');
        if (applyBtn) applyBtn.addEventListener('click', () => {
            const md = (afterEl && afterEl.textContent && afterEl.textContent.trim()) || (beforeEl && beforeEl.textContent) || '';
            if (md && dom.articleInput) {
                dom.articleInput.value = md;
                try { ui.closeModal(); } catch(_) {}
                try { dom.articleInput.focus(); } catch (_) {}
            }
        });
        fetchBtn.addEventListener('click', async () => {
            const url = (urlInput.value || '').trim();
            if (!url) { alert('請輸入網址'); return; }
            fetchBtn.disabled = true; fetchBtn.textContent = '擷取中...';
            try {
                // 優先使用結構化抽取，將標題與正文分離；失敗則回退純文字
                const res = await api.fetchArticleFromUrlStructured(url, { timeoutMs: 22000 });
                const before = ((res.title ? (`# ${res.title}\n\n`) : '') + (res.content || '')).trim();
                if (aiCleanChk && aiCleanChk.checked) {
                    fetchBtn.textContent = 'AI 清洗中...';
                    let after = before;
                    try {
                        after = await api.aiCleanArticleMarkdown(before, { timeoutMs: 25000, model: modelSelect && modelSelect.value, keepImages: keepImagesChk ? !!keepImagesChk.checked : true });
                    } catch (_) { /* keep before */ }
                    if (beforeEl) beforeEl.textContent = before;
                    if (afterEl) afterEl.textContent = after;
                    if (previewBox) previewBox.style.display = 'block';
                } else {
                    if (dom.articleInput) dom.articleInput.value = before;
                    try { ui.closeModal(); } catch(_) {}
                    // 導入後自動聚焦輸入框，方便直接分析
                    try { dom.articleInput.focus(); } catch (_) {}
                }
            } catch (e) {
                alert('擷取失敗：' + (e?.message || e));
            } finally {
                fetchBtn.disabled = false; fetchBtn.textContent = '擷取';
            }
        });
    };

    const renderOcr = () => {
        panel.innerHTML = '';
        const wrap = document.createElement('div');
        wrap.innerHTML = `
            <label for="imp-img" style="display:block;margin-bottom:6px;">選擇圖片（可多張）：</label>
            <input id="imp-img" type="file" accept="image/*" multiple capture="environment">
            <div style="margin-top:8px;display:flex;gap:6px;align-items:center;">
                <button id="imp-ocr" class="btn-primary">擷取圖片文字</button>
                <label class="checkbox-inline"><input id="imp-merge" type="checkbox" checked> <span>合併輸出</span></label>
            </div>
            <p style="font-size:12px;opacity:.8;margin-top:6px;">使用 AI 視覺模型擷取圖片中文本，保留原始換行與標點。</p>
        `;
        panel.appendChild(wrap);
        const $ = (sel) => wrap.querySelector(sel);
        const fileInput = $('#imp-img');
        const runBtn = $('#imp-ocr');
        const mergeChk = $('#imp-merge');
        runBtn.addEventListener('click', async () => {
            const files = Array.from(fileInput.files || []);
            if (!files.length) { alert('請先選擇圖片'); return; }
            runBtn.disabled = true; runBtn.textContent = '擷取中...';
            try {
                const texts = [];
                for (const f of files) {
                    if (!f.type || !f.type.startsWith('image/')) continue;
                    const dataUrl = await fileToDataURL(f);
                    const resized = await downscaleImage(dataUrl, { maxW: 1600, maxH: 1600, quality: 0.9 });
                    const text = await api.ocrExtractTextFromImage(resized || dataUrl, { temperature: 0.0 });
                    texts.push(text || '');
                }
                const finalText = mergeChk.checked ? texts.join('\n\n') : texts.map((t, i) => `--- 圖片 ${i+1} ---\n${t}`).join('\n\n');
                if (dom.articleInput) dom.articleInput.value = finalText;
                try { ui.closeModal(); } catch(_) {}
                try { dom.articleInput.focus(); } catch (_) {}
            } catch (e) {
                alert('OCR 失敗：' + (e?.message || e));
            } finally {
                runBtn.disabled = false; runBtn.textContent = '擷取圖片文字';
            }
        });
    };

    const activate = (name) => {
        if (name === 'ocr') { btnOcr.classList.add('active'); btnUrl.classList.remove('active'); renderOcr(); }
        else { btnUrl.classList.add('active'); btnOcr.classList.remove('active'); renderUrl(); }
    };
    btnUrl.addEventListener('click', () => activate('url'));
    btnOcr.addEventListener('click', () => activate('ocr'));
    activate('url');

    try { dom.modalTitle.textContent = '導入文章'; } catch (_) {}
    ui.openModal();
}

// 小工具：讀檔/縮圖（避免引入整個 OCR 模組以保持彈窗輕量）
function fileToDataURL(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = (e) => reject(e);
        reader.readAsDataURL(file);
    });
}

function downscaleImage(dataUrl, { maxW = 1600, maxH = 1600, quality = 0.9 } = {}) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            let { width, height } = img;
            const ratio = Math.min(maxW / width, maxH / height, 1);
            if (ratio < 1) { width = Math.round(width * ratio); height = Math.round(height * ratio); }
            const canvas = document.createElement('canvas');
            canvas.width = width; canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);
            try { resolve(canvas.toDataURL('image/jpeg', quality)); } catch (_) { resolve(dataUrl); }
        };
        img.onerror = () => resolve(dataUrl);
        img.src = dataUrl;
    });
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

// 以 Modal 呈現句子詳解（避免佔據版面與收合誤觸）
const USE_SENTENCE_MODAL = true;

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

// --- Persist helpers (merge & save to analyzedArticles for sync) ---
function _safeString(x) { return (x || '').toString(); }

function persistSentenceAnalysis(sentence, context, data) {
    try {
        const articleText = (dom.articleInput.value || '').trim();
        if (!articleText) return;
        const rec = (state.analyzedArticles || []).find(it => it.article === articleText);
        if (!rec || !rec.result) return;
        const arr = Array.isArray(rec.result.sentence_analysis) ? rec.result.sentence_analysis : [];
        const keyOf = (s, c) => `${_safeString(s).trim()}||${_safeString(c).trim()}`.toLowerCase();
        const next = [...arr];
        const normalized = { ...data, sentence, context, updatedAt: new Date().toISOString() };
        const idx = next.findIndex(x => keyOf(x.sentence, x.context || x._context) === keyOf(sentence, context));
        if (idx >= 0) next[idx] = normalized; else next.push(normalized);
        storage.saveAnalysisResult(articleText, { ...rec.result, sentence_analysis: next });
    } catch (_) { /* ignore */ }
}

function persistPhraseAnalysis(selection, sentence, context, data) {
    try {
        const articleText = (dom.articleInput.value || '').trim();
        if (!articleText) return;
        const rec = (state.analyzedArticles || []).find(it => it.article === articleText);
        if (!rec || !rec.result) return;
        const arr = Array.isArray(rec.result.phrase_analysis) ? rec.result.phrase_analysis : [];
        const keyOf = (sel, s, c) => `${_safeString(sel).trim()}||${_safeString(s).trim()}||${_safeString(c).trim()}`.toLowerCase();
        const next = [...arr];
        const normalized = { ...(data || {}), selection: data?.selection || selection, sentence, context, updatedAt: new Date().toISOString() };
        const idx = next.findIndex(x => keyOf(x.selection, x.sentence, x.context || x._context) === keyOf(normalized.selection, sentence, context));
        if (idx >= 0) next[idx] = normalized; else next.push(normalized);
        // 保留策略：每句（sentence+context）最多 3 條片語解析（依 updatedAt 取最新）
        try {
            const scKey = (s, c) => `${_safeString(s).trim()}||${_safeString(c).trim()}`.toLowerCase();
            const targetKey = scKey(sentence, context);
            const group = next.filter(x => scKey(x.sentence, x.context || x._context) === targetKey);
            const others = next.filter(x => scKey(x.sentence, x.context || x._context) !== targetKey);
            group.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
            const trimmed = group.slice(0, 3);
            storage.saveAnalysisResult(articleText, { ...rec.result, phrase_analysis: [...others, ...trimmed] });
        } catch (_) {
            storage.saveAnalysisResult(articleText, { ...rec.result, phrase_analysis: next });
        }
    } catch (_) { /* ignore */ }
}

// Markdown helpers: detect and group table blocks so they are treated as a single paragraph.
function isMdTableAlignLine(line) {
    if (!line) return false;
    // e.g. | :--- | ---: | :---: |
    const s = line.trim();
    const re = /^\|?\s*:?-{3,}\s*(\|\s*:?-{3,}\s*)+\|?$/;
    return re.test(s);
}

function isMdTableStart(lines, i) {
    // A table starts when a header row with '|' is followed by an alignment row
    const cur = (lines[i] || '').trim();
    const nxt = (lines[i + 1] || '').trim();
    if (!cur || !nxt) return false;
    // Require at least one pipe bar and at least two columns
    if (!/\|/.test(cur)) return false;
    const colCount = (cur.match(/\|/g) || []).length;
    if (colCount < 2) return false;
    return isMdTableAlignLine(nxt);
}

function collectMdTable(lines, i) {
    const buf = [];
    // header + align line are guaranteed by caller
    buf.push(lines[i]);
    buf.push(lines[i + 1]);
    let j = i + 2;
    while (j < lines.length) {
        const ln = lines[j];
        if (ln == null) break;
        const t = ln.trim();
        if (!t) break; // blank line ends the table
        // Continue while the line still looks like a table row (contains at least one pipe)
        if (/\|/.test(t)) { buf.push(ln); j += 1; continue; }
        break;
    }
    return { text: buf.join('\n'), nextIndex: j };
}

function parseTitleAndParagraphs(text) {
    const lines = (text || '').split(/\n/);
    const paragraphs = [];
    let title = '';
    // First, detect title in the very first non-empty line
    let idx = 0;
    while (idx < lines.length && !lines[idx].trim()) idx += 1;
    if (idx < lines.length) {
        const first = lines[idx].trim();
        const m = first.match(/^#+\s*(.+)$/);
        if (m) {
            title = m[1].trim();
            idx += 1;
        }
    }

    // Walk remaining lines and group into paragraphs and table blocks
    let i = idx;
    while (i < lines.length) {
        // skip consecutive blank lines
        while (i < lines.length && !lines[i].trim()) i += 1;
        if (i >= lines.length) break;
        if (isMdTableStart(lines, i)) {
            const { text: tableBlock, nextIndex } = collectMdTable(lines, i);
            paragraphs.push(tableBlock);
            i = nextIndex;
            continue;
        }
        // Normal paragraph: collect until blank line OR until a table start
        const buf = [];
        while (i < lines.length) {
            // stop when next non-empty line begins a table
            if (isMdTableStart(lines, i)) break;
            const ln = lines[i];
            if (ln == null) break;
            const t = ln.trim();
            if (!t) { i += 1; break; }
            buf.push(ln);
            i += 1;
        }
        const p = buf.join('\n').trim();
        if (p) paragraphs.push(p);
    }
    return { title, paragraphs };
}

// Detect if a multi-line text itself begins with a Markdown table (header + align row)
function isMarkdownTableStart(text) {
    if (!text) return false;
    const lines = String(text).split(/\n/);
    // find first non-empty
    let i = 0; while (i < lines.length && !lines[i].trim()) i += 1;
    if (i >= lines.length) return false;
    return isMdTableStart(lines, i);
}

function splitMdRowCells(line) {
    if (!line) return [];
    let arr = line.split('|');
    // drop leading/trailing empty caused by edge pipes
    if (arr.length && arr[0].trim() === '') arr = arr.slice(1);
    if (arr.length && arr[arr.length - 1].trim() === '') arr = arr.slice(0, -1);
    return arr.map(s => s.trim());
}

function parseMarkdownTableFromText(text) {
    const lines = String(text).split(/\n/).filter(l => l.trim() !== '');
    if (lines.length < 2) return null;
    if (!isMarkdownTableStart(text)) return null;
    const header = splitMdRowCells(lines[0]);
    // Skip align line at index 1
    const rows = [];
    for (let i = 2; i < lines.length; i++) {
        const t = lines[i].trim();
        if (!t || !/\|/.test(t)) continue;
        rows.push(splitMdRowCells(lines[i]));
    }
    return { headers: header, rows };
}

function escapeHtml(s) {
    return (s || '').replace(/&/g,'&amp;').replace(/\"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/'/g,'&#39;');
}

// Return HTML that wraps words in a string with <span class="interactive-word" ...>
function wrapWordsInTextHTML(text) {
    const wordRe = /[A-Za-z][A-Za-z'’-]*/g;
    if (!text || !wordRe.test(text)) return escapeHtml(text || '');
    wordRe.lastIndex = 0;
    let out = '';
    let idx = 0;
    let m;
    while ((m = wordRe.exec(text))) {
        const before = text.slice(idx, m.index);
        if (before) out += escapeHtml(before);
        const w = m[0];
        const escW = escapeHtml(w);
        out += `<span class=\"interactive-word\" data-word=\"${escW}\">${escW}</span>`;
        idx = m.index + w.length;
    }
    const tail = text.slice(idx);
    if (tail) out += escapeHtml(tail);
    return out;
}

// 將 Markdown 表格成對渲染（英/中），並在英文單元格內提供句/詞互動標記。
function renderMarkdownTablePairHTML(engText, zhText, paraIdx) {
    const te = parseMarkdownTableFromText(engText);
    if (!te) {
        return {
            eng: `<div class=\"md-fallback\">${escapeHtml(engText || '')}</div>`,
            zh: `<div>${escapeHtml(zhText || '')}</div>`,
            lastSentIndex: -1
        };
    }
    const tz = parseMarkdownTableFromText(zhText);
    const headE = `<thead><tr>${te.headers.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>`;
    let sIdx = 0;
    const bodyE = `<tbody>${te.rows.map((r) => {
        const tds = r.map((cell) => {
            const sentence = String(cell || '').trim();
            const inner = `<span class=\"sentence-wrap\">`
                + `<span class=\"interactive-sentence\" data-para-index=\"${paraIdx}\" data-sent-index=\"${sIdx}\" data-sentence=\"${escapeHtml(sentence)}\">${wrapWordsInTextHTML(sentence)}</span>`
                + `<button class=\"sent-analyze-btn icon-only\" data-para-index=\"${paraIdx}\" data-sent-index=\"${sIdx}\" title=\"解析\" aria-label=\"解析\"><svg width=\"12\" height=\"12\" viewBox=\"0 0 16 16\" aria-hidden=\"true\"><path fill=\"currentColor\" d=\"M8 1a7 7 0 1 1 0 14A7 7 0 0 1 8 1zm0 1.5A5.5 5.5 0 1 0 8 13.5 5.5 5.5 0 0 0 8 2.5zm.93 3.412a1.5 1.5 0 0 0-2.83.588h1.005c0-.356.29-.64.652-.64.316 0 .588.212.588.53 0 .255-.127.387-.453.623-.398.29-.87.654-.87 1.29v.255h1V8c0-.254.128-.387.454-.623.398-.29.87-.654.87-1.29 0-.364-.146-.706-.416-.935zM8 10.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5z\"/></svg></button>`
                + `</span>`;
            const html = `<td>${inner}</td>`;
            sIdx += 1;
            return html;
        }).join('');
        return `<tr>${tds}</tr>`;
    }).join('')}</tbody>`;
    const htmlE = `<div class=\"md-table\"><table>${headE}${bodyE}</table></div>`;

    // 中文表格若可解析，按相同單元格順序對齊 sent-index；否則顯示純文字
    let htmlZ = `<div>${escapeHtml(zhText || '')}</div>`;
    if (tz && tz.rows && tz.rows.length) {
        let zi = 0;
        const headZ = `<thead><tr>${tz.headers.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>`;
        const bodyZ = `<tbody>${tz.rows.map((r) => {
            const tds = r.map((cell) => {
                const sentence = String(cell || '').trim();
                const inner = `<span class=\"interactive-sentence-zh\" data-para-index=\"${paraIdx}\" data-sent-index=\"${zi}\">${escapeHtml(sentence)}</span>`;
                const html = `<td>${inner}</td>`;
                zi += 1;
                return html;
            }).join('');
            return `<tr>${tds}</tr>`;
        }).join('')}</tbody>`;
        htmlZ = `<div class=\"md-table\"><table>${headZ}${bodyZ}</table></div>`;
    }

    return { eng: htmlE, zh: htmlZ, lastSentIndex: sIdx - 1 };
}

// Detect if a line is a standalone Markdown image: ![alt](url)
function isMarkdownImageLine(line) {
    if (!line) return false;
    const s = String(line).trim();
    return /^!\[[^\]]*\]\([^\)]+\)\s*$/i.test(s);
}

// Detect if the whole paragraph is composed only of Markdown image lines (or blank lines)
function isPureMarkdownImageParagraph(text) {
    const lines = String(text || '').split(/\n/).map(l => l.trim());
    const nonEmpty = lines.filter(l => l.length > 0);
    if (!nonEmpty.length) return false;
    return nonEmpty.every(isMarkdownImageLine);
}

// Strip image lines from paragraph when sending to AI (keep text only)
function stripMarkdownImagesFromText(text) {
    const lines = String(text || '').split(/\n/);
    const kept = lines.filter(l => !isMarkdownImageLine(l));
    // collapse 3+ blank lines to 2
    return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// If a paragraph consists solely of image lines (and blank lines), render them as <img> blocks
function renderMarkdownImagesPairHTML(engText, zhText) {
    const toLines = (t) => String(t || '').split(/\n/).map(l => l.trim()).filter(l => l.length > 0);
    const engLines = toLines(engText);
    if (!engLines.length || !engLines.every(isMarkdownImageLine)) return null;

    const imgRe = /^!\[([^\]]*)\]\(([^\)]+)\)\s*$/i;
    const parseImgs = (arr) => arr.map(l => {
        const m = l.match(imgRe);
        return m ? { alt: m[1] || '', url: m[2] || '' } : null;
    }).filter(Boolean);
    const engImgs = parseImgs(engLines);

    // zh 側若也都是圖片，獨立解析；否則沿用英文側圖片（圖片不做翻譯/改寫）
    let zhImgs = [];
    const zhLines = toLines(zhText);
    if (zhLines.length && zhLines.every(isMarkdownImageLine)) {
        zhImgs = parseImgs(zhLines);
    } else {
        zhImgs = engImgs.slice();
    }

    const toHTML = (imgs) => {
        if (!imgs.length) return '';
        const blocks = imgs.map(({ alt, url }) => {
            const esc = (s) => (s || '').replace(/&/g,'&amp;').replace(/\"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/'/g,'&#39;');
            const a = esc(alt);
            const u = esc(url);
            return `<div class=\"md-image\"><img src=\"${u}\" alt=\"${a}\" loading=\"lazy\" referrerpolicy=\"no-referrer\"></div>`;
        });
        return `<div class=\"md-images\">${blocks.join('')}</div>`;
    };

    return { eng: toHTML(engImgs), zh: toHTML(zhImgs) };
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
                let result;
                if (cached) {
                    result = cached;
                } else if (isPureMarkdownImageParagraph(text)) {
                    // 純圖片段落：不送 AI；中文留空，僅顯示一次圖片
                    result = { chinese_translation: '', word_alignment: [], detailed_analysis: [] };
                } else {
                    const textForAI = stripMarkdownImagesFromText(text);
                    result = await api.analyzeParagraph(textForAI || text, { timeoutMs, signal: currentAnalysisAbort.signal, level: 'quick' });
                }
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
    // 與英文段落一一對齊，優先使用 paragraph_analysis 的逐段結果，避免表格被拆行
    const chineseParagraphs = englishParagraphs.map((_, i) => (paragraph_analysis && paragraph_analysis[i] && paragraph_analysis[i].chinese_translation) || '');
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

        // 若是 Markdown 表格段落，直接以表格渲染
        if (isMarkdownTableStart(englishPara)) {
            const pair = renderMarkdownTablePairHTML(englishPara, chinesePara, i);
            const engTableHtml = pair.eng;
            const zhTableHtml = pair.zh;
            const isTitle = !!title && i === 0;
            htmlContent += `
                <div class=\"paragraph-pair${isTitle ? ' is-title' : ''}\" data-paragraph-index=\"${i}\" data-english=\"${escapeAttr(englishPara)}\">
                    <div class=\"paragraph-english\" data-markdown-table=\"1\">${engTableHtml}</div>
                    <div class=\"paragraph-chinese\" data-markdown-table=\"1\">${zhTableHtml}</div>
                </div>`;
            continue;
        }

        // sentence-level wrapping for full render（非表格）
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
                   `<span class=\"sentence-hotzone\" data-para-index=\"${i}\" data-sent-index=\"${sIdx}\" title=\"展開/收合\"></span>` +
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
    dom.articleAnalysisContainer.querySelectorAll('.paragraph-english').forEach(el => {
        // 表格不做 token 包裝以免破壞結構
        if (el.querySelector('table') || el.dataset.markdownTable === '1') { el.dataset.tokensWrapped = '1'; return; }
        wrapWordsInElementOnce(el);
    });
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
        // full 模式改為逐句朗讀（視覺效果更好，支援逐句高亮/淡化）
        if (mode === 'paragraph') {
            paraEls.forEach(el => {
                const text = Array.from(el.querySelectorAll('.interactive-sentence')).map(s => s.textContent.trim()).join(' ')
                    || el.textContent.trim();
                if (text) chunks.push({ type: 'paragraph', text, el });
            });
            return chunks;
        }
        // sentence / full mode：逐句
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
    if (mode === 'paragraph') {
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
    const chunks = buildReadingChunks(mode === 'full' ? 'sentence' : mode);
    state.setReadingChunks(chunks);
    if (state.readingChunks.length > 0) {
        state.setCurrentChunkIndex(0);
        // 全文模式強制隱藏導航（雖然逐句朗讀，但視覺上仍視為全文）
        dom.chunkNavControls.classList.toggle('hidden', mode === 'full' || state.readingChunks.length <= 1);
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
        // 不在播放狀態時，移除整體淡化效果
        try { dom.articleAnalysisContainer.classList.remove('dim-others'); } catch (_) {}
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
    dom.articleAnalysisContainer.classList.remove('dim-others');
}

function highlightCurrentChunk(chunk) {
    clearReadingHighlights();
    if (!chunk) return;
    if (chunk.type === 'sentence' && chunk.el) {
        chunk.el.classList.add('sentence-active');
        // 僅在實際播放時才啟用淡化（暫停或未播放時不淡化）
        if (!state.isReadingChunkPaused) {
            dom.articleAnalysisContainer.classList.add('dim-others');
        }
        // 確保可視
        try { chunk.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (_) {}
    } else if (chunk.type === 'paragraph' && chunk.el) {
        chunk.el.classList.add('para-active');
        try { chunk.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (_) {}
        dom.articleAnalysisContainer.classList.remove('dim-others');
    } else if (chunk.type === 'full') {
        // 已不再用 full 單片段，保留兼容，但遵循播放狀態
        if (!state.isReadingChunkPaused) dom.articleAnalysisContainer.classList.add('dim-others');
        try { dom.articleAnalysisContainer.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (_) {}
    }
}

async function downloadAudio() {
    const raw = dom.articleInput.value.trim();
    if (!raw) { alert('請先輸入要下載的文章！'); return; }
    // 構造下載文本：
    const mode = dom.readingModeSelect.value;
    const chunks = (function() {
        try { return buildReadingChunks(mode === 'full' ? 'sentence' : mode); } catch(_) { return []; }
    })();
    let textToDownload = '';
    if (mode === 'sentence' || mode === 'paragraph') {
        const cur = state.readingChunks[state.currentChunkIndex] || chunks[0];
        textToDownload = (cur && cur.text) || '';
    } else {
        // full: 合併全部句子為單檔
        textToDownload = chunks.map(c => c.text).join(' ');
    }
    if (!textToDownload) {
        // 後備：直接使用輸入框
        const { title, paragraphs } = parseTitleAndParagraphs(raw);
        textToDownload = [title, ...paragraphs].filter(Boolean).join(' ');
    }
    const makeSlug = (s) => (s || '').toLowerCase().replace(/[^a-z0-9\s-]/g,'').trim().replace(/\s+/g,'-').replace(/-+/g,'-') || 'article';
    const { title } = parseTitleAndParagraphs(raw);
    const base = title ? makeSlug(title) : makeSlug(textToDownload.slice(0, 40));
    const fname = `${base}-${mode === 'full' ? 'full' : mode}.mp3`;
    try {
        await audio.downloadTextAsAudio(textToDownload, 'en-US', state.currentSpeed, fname, { pitch: 0, style: 'general', download: true });
    } catch (err) {
        console.error('下載音頻失敗:', err);
        alert('下載音頻失敗，可能是文字過長或網絡問題。請嘗試切換為句子/段落模式下載。');
    }
}

// --- Article Library ---


// --- Article Library ---
let _articleLibraryData = [];

function renderArticleLibraryList(filter = {}) {
    const cat = (filter.category || '').trim();
    const items = _articleLibraryData.filter(a => !cat || (a.category || '') === cat);
    if (dom.articleLibraryCount) dom.articleLibraryCount.textContent = `${items.length} 篇`;
    if (items.length === 0) {
        dom.articleLibraryList.innerHTML = '<p>沒有符合條件的文章。</p>';
        return;
    }
    dom.articleLibraryList.innerHTML = items.map(article => `
        <div class="article-library-item" data-path="${article.path}" data-category="${(article.category||'').replace(/\"/g,'&quot;')}">
            <h4>${article.title}</h4>
            <p class="description">${article.description}</p>
            <div class="meta">
                <span class="difficulty">${article.difficulty}</span>
                <span class="category">${article.category || '未分類'}</span>
            </div>
        </div>`).join('');
    dom.articleLibraryList.querySelectorAll('.article-library-item').forEach(item => {
        item.addEventListener('click', () => loadArticleFromLibrary(item.dataset.path));
    });
}

async function openArticleLibrary() {
    dom.articleLibraryList.innerHTML = '<p>正在加載文章列表...</p>';
    dom.articleLibraryModal.classList.remove('hidden');
    try {
        if (!_articleLibraryData || _articleLibraryData.length === 0) {
            const response = await fetch('articles/manifest.json');
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            _articleLibraryData = await response.json();
        }

        if (!_articleLibraryData || _articleLibraryData.length === 0) {
            dom.articleLibraryList.innerHTML = '<p>文章庫是空的。</p>';
            return;
        }

        // 構建分類下拉
        if (dom.articleCategoryFilter) {
            const cats = Array.from(new Set(_articleLibraryData.map(a => a.category || '未分類')));
            const prev = dom.articleCategoryFilter.value || '';
            dom.articleCategoryFilter.innerHTML = ['<option value="">全部分類</option>']
                .concat(cats.map(c => `<option value="${String(c).replace(/\"/g,'&quot;')}">${c}</option>`))
                .join('');
            dom.articleCategoryFilter.value = prev;
            dom.articleCategoryFilter.onchange = () => {
                renderArticleLibraryList({ category: dom.articleCategoryFilter.value });
            };
        }

        renderArticleLibraryList({ category: dom.articleCategoryFilter ? dom.articleCategoryFilter.value : '' });
    } catch (error) {
        console.error('無法加載文章庫:', error);
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
    // 1) 句子整行/熱區可點開/收合
    const wrap = rawTarget?.closest && rawTarget.closest('.sentence-wrap');
    const isIcon = rawTarget?.closest && rawTarget.closest('.sent-analyze-btn');
    const isHotzone = rawTarget?.closest && rawTarget.closest('.sentence-hotzone');
    const isWord = rawTarget?.closest && rawTarget.closest('.interactive-word');
    if (wrap && !isIcon && !isWord) {
        // 若點擊來源位於已展開的句卡內部，則不觸發句子層級的開合。
        // 注意：這裡不要 `return` 整個處理函式，否則卡片內的委派按鈕（如「詳解」）會失效。
        const insideCard = rawTarget.closest && rawTarget.closest('.sentence-card');
        if (!insideCard) {
            // 非卡片內點擊 → 視為點擊句子本身，進行開合。
            // 如果正在選字，避免誤觸
            try {
                const sel = window.getSelection && window.getSelection();
                if (sel && sel.toString && sel.toString().trim()) return; // 仍允許提前返回（僅針對句子開合）
            } catch (_) {}
            const sent = wrap.querySelector('.interactive-sentence');
            if (sent) { ev.stopPropagation(); await toggleSentenceCard(sent); return; }
        }
        // insideCard: 繼續往下讓委派邏輯處理（例如 .chunk-explain「詳解」按鈕）
    }
    if (isHotzone) {
        const paraIdx = parseInt(rawTarget.getAttribute('data-para-index'), 10) || 0;
        const sentIdx = parseInt(rawTarget.getAttribute('data-sent-index'), 10) || 0;
        const el = dom.articleAnalysisContainer.querySelector(`.interactive-sentence[data-para-index="${paraIdx}"][data-sent-index="${sentIdx}"]`);
        if (el) { ev.stopPropagation(); await toggleSentenceCard(el); return; }
    }
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
            // 持久化片語解析
            try { persistPhraseAnalysis(phrase, sentence, context, res); } catch (_) {}
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

// 句子詳解在「彈窗模式」下也需要支援片語「詳解」按鈕的委派處理
try {
    dom.appModal.addEventListener('click', async (ev) => {
        const rawTarget = ev.target && ev.target.nodeType === 3 ? ev.target.parentElement : ev.target;
        const chunkBtn = rawTarget?.closest && rawTarget.closest('.chunk-explain');
        if (!chunkBtn) return;
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
            const ex = [];
            try { const arr = res?.analysis?.examples; if (Array.isArray(arr)) arr.slice(0,2).forEach(x => ex.push(x)); } catch (_) {}
            box.innerHTML = `<div style="display:flex;justify-content:space-between;gap:8px;align-items:center;">
                               <div><strong>${esc(res.selection || phrase)}</strong>：${esc(res.analysis?.meaning || '')}
                                   ${res.analysis?.usage ? `<div>用法：${esc(res.analysis.usage)}</div>`:''}
                                   ${ex.length? '<div>' + ex.map(x=>`<div>• ${esc(x.en)} — ${esc(x.zh)}</div>`).join('') + '</div>' : ''}
                               </div>
                               <button class="phrase-close" style="font-size:12px;">關閉</button>
                             </div>`;
            const chunkItem = chunkBtn.closest('.chunk-item');
            if (chunkItem) chunkItem.after(box); else card.appendChild(box);
            try { persistPhraseAnalysis(phrase, sentence, context, res); } catch (_) {}
            applySentenceDim(paraIdx, sentIdx, true);
            const closeBtn = box.querySelector('.phrase-close');
            if (closeBtn) closeBtn.addEventListener('click', () => {
                box.remove();
                if (!card.querySelector('.phrase-explain-box')) applySentenceDim(paraIdx, sentIdx, false);
            });
        } catch (err) {
            console.warn('片語詳解請求失敗(Modal):', err);
            alert('解析失敗，稍後再試');
        } finally {
            chunkBtn.disabled = false; chunkBtn.textContent = '詳解';
        }
    });
} catch (_) {}

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
        const prev = btnAdd.textContent;
        btnAdd.disabled = true;
        btnAdd.textContent = '加入中...';
        btnAdd.setAttribute('aria-busy', 'true');
        try {
            const mod = await import('../../modules/vocab.js');
            const meaning = btnAdd.getAttribute('data-meaning') || '';
            const phonetic = btnAdd.getAttribute('data-phonetic') || '';
            const pos = btnAdd.getAttribute('data-pos') || '';
            const res = await mod.addWordToDefaultBook(w, { source: 'article', sentence, context, meaning, phonetic, pos });
            btnAdd.textContent = res && res.reason === 'duplicate' ? '已存在' : '已加入';
        } catch (err) {
            console.warn('加入生詞本失敗:', err);
            btnAdd.textContent = '失敗';
        } finally {
            setTimeout(() => {
                btnAdd.removeAttribute('aria-busy');
                btnAdd.disabled = false;
                btnAdd.textContent = prev || '加入生詞本';
            }, 1000);
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
                    <button class="btn-ghost btn-mini btn-add-to-book"
                        data-word="${escAttr(defaultPhrase||data.word||'')}"
                        data-sentence="${escAttr(sentenceForBtn||'')}"
                        data-context="${escAttr(contextForBtn||'')}"
                        data-meaning="${escAttr(analysis.meaning || '')}"
                        data-phonetic="${escAttr(analysis.phonetic || '')}"
                        data-pos="${escAttr(analysis.pos || '')}"
                    >加入生詞本</button>
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
        // 持久化新增的詞詳解到當前文章的分析結果，便於跨端同步
        try {
            const articleText = (dom.articleInput.value || '').trim();
            if (articleText) {
                const current = (state.analyzedArticles || []).find(it => it.article === articleText);
                if (current && current.result) {
                    const updated = {
                        ...current.result,
                        detailed_analysis: mergeDetailedAnalyses(current.result.detailed_analysis || [], [normalized])
                    };
                    storage.saveAnalysisResult(articleText, updated);
                }
            }
        } catch (_) { /* ignore persistence errors */ }
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
    // 統一為最小輸出模式
    const level = 'quick';
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

    // 若是 Markdown 表格，直接以表格方式渲染並跳過逐句標註
    if (isMarkdownTableStart(englishPara)) {
        if (englishDiv || chineseDiv) {
            const zh = cleanChinese(stripSpanTags(chinese || ''));
            const pair = renderMarkdownTablePairHTML(englishPara, zh, index);
            if (englishDiv) {
                englishDiv.innerHTML = pair.eng;
                englishDiv.dataset.markdownTable = '1';
                englishDiv.dataset.tokensWrapped = '1';
            }
            if (chineseDiv) {
                chineseDiv.innerHTML = pair.zh;
                chineseDiv.dataset.markdownTable = '1';
            }
        }
        // 更新狀態列
        if (statusDiv) {
            const textSpan = statusDiv.querySelector('.status-text');
            const iconSpan = statusDiv.querySelector('.status-icon');
            const elapsedSpan = statusDiv.querySelector('.elapsed');
            const retryBtn = statusDiv.querySelector('.retry-paragraph-btn');
            if (elapsedSpan && paragraphElapsedMs[index] != null) {
                const ms = paragraphElapsedMs[index];
                const secs = (ms / 1000).toFixed(1);
                elapsedSpan.textContent = `(${secs}s)`;
            }
            statusDiv.dataset.status = 'done';
            if (textSpan) textSpan.textContent = '完成 ✓';
            if (iconSpan) iconSpan.textContent = '✅';
            if (retryBtn) { retryBtn.style.display = 'inline-block'; retryBtn.textContent = '重新獲取'; }
        }
        return;
    }

    // 若該段為純圖片（Markdown 圖片行），直接以 <img> 呈現，並跳過逐句標註與包字
    {
        const zhForImg = processedChinese || chinese || '';
        const pairImgs = renderMarkdownImagesPairHTML(englishPara, zhForImg);
        if (pairImgs) {
            if (englishDiv) {
                englishDiv.innerHTML = pairImgs.eng;
                englishDiv.dataset.markdownImages = '1';
                englishDiv.dataset.tokensWrapped = '1';
            }
            // 圖片只顯示一次；中文側不重複顯示
            if (chineseDiv) {
                chineseDiv.innerHTML = '';
                chineseDiv.dataset.markdownImages = '1';
            }
            if (statusDiv) {
                const textSpan = statusDiv.querySelector('.status-text');
                const iconSpan = statusDiv.querySelector('.status-icon');
                const elapsedSpan = statusDiv.querySelector('.elapsed');
                const retryBtn = statusDiv.querySelector('.retry-paragraph-btn');
                if (elapsedSpan && paragraphElapsedMs[index] != null) {
                    const ms = paragraphElapsedMs[index];
                    const secs = (ms / 1000).toFixed(1);
                    elapsedSpan.textContent = `(${secs}s)`;
                }
                statusDiv.dataset.status = 'done';
                if (textSpan) textSpan.textContent = '完成 ✓';
                if (iconSpan) iconSpan.textContent = '✅';
                if (retryBtn) { retryBtn.style.display = 'inline-block'; retryBtn.textContent = '重新獲取'; }
            }
            return;
        }
    }

    // 支援混合段：行內若混有圖片與文字，圖片以 <img> 呈現，其餘文字保持逐句互動
    const toLines = (t) => String(t || '').split(/\n/);
    const engLines = toLines(englishPara || '');
    const zhLinesAll = toLines(processedChinese || chinese || '');
    const hasAnyImageLine = engLines.some(isMarkdownImageLine);
    if (hasAnyImageLine) {
        const imgRe = /^!\[([^\]]*)\]\(([^\)]+)\)\s*$/i;
        const engBlocks = [];
        let buf = '';
        let sentIdxCounter = 0;
        const flushText = () => {
            const segment = buf.trim();
            buf = '';
            if (!segment) return;
            const sentences = sentenceSplit(segment);
            const htmlParts = [];
            sentences.forEach((s) => {
                const curIdx = sentIdxCounter++;
                let sHtml = s;
                const sAlign = alignment.filter(p => s.includes(p.en) && (processedChinese || '').includes(p.zh));
                const sSorted = [...sAlign].sort((a, b) => (b.en?.length || 0) - (a.en?.length || 0));
                sSorted.forEach((pair) => {
                    const pairId = `para-${index}-pair-${curIdx}-${pair.en}-${pair.zh}`.replace(/[^a-zA-Z0-9_-]/g,'_');
                    sHtml = sHtml.replace(new RegExp(`\\b(${escapeRegex(pair.en)})\\b`, 'g'), `<span class=\"interactive-word\" data-pair-id=\"${pairId}\" data-word=\"${esc(pair.en)}\">$1</span>`);
                });
                const sWords = (result?.detailed_analysis || []).filter(w => w.word && s.includes(w.word)).map(w => w.word);
                const sUnique = Array.from(new Set(sWords));
                sUnique.forEach(word => {
                    const marker = `data-word=\"${esc(word)}\"`;
                    if (sHtml.includes(marker)) return;
                    const re = new RegExp(`\\b(${escapeRegex(word)})\\b`, 'g');
                    sHtml = sHtml.replace(re, `<span class=\"interactive-word\" data-word=\"${esc(word)}\">$1</span>`);
                });
                htmlParts.push(`<span class=\"sentence-wrap\">` +
                    `<span class=\"interactive-sentence\" data-para-index=\"${index}\" data-sent-index=\"${curIdx}\" data-sentence=\"${esc(s)}\">${sHtml}</span>` +
                    `<button class=\"sent-analyze-btn icon-only\" data-para-index=\"${index}\" data-sent-index=\"${curIdx}\" title=\"解析\" aria-label=\"解析\"><svg width=\"12\" height=\"12\" viewBox=\"0 0 16 16\" aria-hidden=\"true\"><path fill=\"currentColor\" d=\"M8 1a7 7 0 1 1 0 14A7 7 7 0 0 1 8 1zm0 1.5A5.5 5.5 0 1 0 8 13.5 5.5 5.5 0 0 0 8 2.5zm.93 3.412a1.5 1.5 0 0 0-2.83.588h1.005c0-.356.29-.64.652-.64.316 0 .588.212.588.53 0 .255-.127.387-.453.623-.398.29-.87.654-.87 1.29v.255h1V8c0-.254.128-.387.454-.623.398-.29.87-.654.87-1.29 0-.364-.146-.706-.416-.935zM8 10.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5z\"/></svg></button>` +
                    `<span class=\"sentence-hotzone\" data-para-index=\"${index}\" data-sent-index=\"${curIdx}\" title=\"展開/收合\"></span>` +
                    `</span>`);
            });
            engBlocks.push(`<div class=\"text-block\">${htmlParts.join(' ')}</div>`);
        };
        engLines.forEach((l) => {
            const m = l.trim().match(imgRe);
            if (m) {
                flushText();
                const a = (m[1] || '').replace(/&/g,'&amp;').replace(/\"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/'/g,'&#39;');
                const u = (m[2] || '').replace(/&/g,'&amp;').replace(/\"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/'/g,'&#39;');
                engBlocks.push(`<div class=\"md-image\"><img src=\"${u}\" alt=\"${a}\" loading=\"lazy\" referrerpolicy=\"no-referrer\"></div>`);
            } else {
                buf += (buf ? '\n' : '') + l;
            }
        });
        flushText();
        englishDiv.innerHTML = engBlocks.join('');
        wrapWordsInElementOnce(englishDiv);

        // 中文側：不重複顯示圖片；僅對文字分句包裝
        const zhBlocks = [];
        let zhBuf = '';
        const flushZh = () => {
            const seg = zhBuf.trim();
            zhBuf = '';
            if (!seg) return;
            const parts = sentenceSplitZh(seg);
            const html = parts.map((z, i) => `<span class=\"interactive-sentence-zh\" data-para-index=\"${index}\" data-sent-index=\"${i}\">${esc(z)}</span>`).join(' ');
            zhBlocks.push(`<div class=\"text-block\">${html}</div>`);
        };
        zhLinesAll.forEach((l) => {
            const m = l.trim().match(imgRe);
            if (m) {
                // 忽略圖片；不在中文側重複顯示
                flushZh();
            } else {
                zhBuf += (zhBuf ? '\n' : '') + l;
            }
        });
        flushZh();
        chineseDiv.innerHTML = zhBlocks.join('') || '<em>分析失敗</em>';

        if (statusDiv) {
            const textSpan = statusDiv.querySelector('.status-text');
            const iconSpan = statusDiv.querySelector('.status-icon');
            const elapsedSpan = statusDiv.querySelector('.elapsed');
            const retryBtn = statusDiv.querySelector('.retry-paragraph-btn');
            if (elapsedSpan && paragraphElapsedMs[index] != null) {
                const ms = paragraphElapsedMs[index];
                const secs = (ms / 1000).toFixed(1);
                elapsedSpan.textContent = `(${secs}s)`;
            }
            statusDiv.dataset.status = 'done';
            if (textSpan) textSpan.textContent = '完成 ✓';
            if (iconSpan) iconSpan.textContent = '✅';
            if (retryBtn) { retryBtn.style.display = 'inline-block'; retryBtn.textContent = '重新獲取'; }
        }
        return;
    }

    // Build sentence-by-sentence HTML for English to support per-sentence click（原有路徑）
    const sentences = sentenceSplit(englishPara || '');
    const htmlParts = [];
    const paraWords = (result && Array.isArray(result.detailed_analysis)) ? result.detailed_analysis : [];

    sentences.forEach((s, sIdx) => {
        let sHtml = s;
        const sAlign = alignment.filter(p => s.includes(p.en) && (processedChinese || '').includes(p.zh));
        const sSorted = [...sAlign].sort((a, b) => (b.en?.length || 0) - (a.en?.length || 0));
        sSorted.forEach((pair) => {
            const pairId = `para-${index}-pair-${sIdx}-${pair.en}-${pair.zh}`.replace(/[^a-zA-Z0-9_-]/g,'_');
            sHtml = sHtml.replace(new RegExp(`\\b(${escapeRegex(pair.en)})\\b`, 'g'), `<span class=\"interactive-word\" data-pair-id=\"${pairId}\" data-word=\"${esc(pair.en)}\">$1</span>`);
        });
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
            `<button class=\"sent-analyze-btn icon-only\" data-para-index=\"${index}\" data-sent-index=\"${sIdx}\" title=\"解析\" aria-label=\"解析\"><svg width=\"12\" height=\"12\" viewBox=\"0 0 16 16\" aria-hidden=\"true\"><path fill=\"currentColor\" d=\"M8 1a7 7 0 1 1 0 14A7 7 7 0 0 1 8 1zm0 1.5A5.5 5.5 0 1 0 8 13.5 5.5 5.5 0 0 0 8 2.5zm.93 3.412a1.5 1.5 0 0 0-2.83.588h1.005c0-.356.29-.64.652-.64.316 0 .588.212.588.53 0 .255-.127.387-.453.623-.398.29-.87.654-.87 1.29v.255h1V8c0-.254.128-.387.454-.623.398-.29.87-.654.87-1.29 0-.364-.146-.706-.416-.935zM8 10.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5z\"/></svg></button>` +
            `<span class=\"sentence-hotzone\" data-para-index=\"${index}\" data-sent-index=\"${sIdx}\" title=\"展開/收合\"></span>` +
            `</span>`);
    });

    englishDiv.innerHTML = htmlParts.join(' ');
    wrapWordsInElementOnce(englishDiv);
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
    // 統一為最小輸出模式
    const level = 'quick';
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

            const prev = btn.textContent;
            btn.disabled = true; btn.textContent = '加入中...'; btn.setAttribute('aria-busy','true');
            try {
                const mod = await import('../../modules/vocab.js');
                await mod.addWordToDefaultBook(text, { source: 'article', sentence, context });
            } catch (_) {}
            hideBtn();
            btn.removeAttribute('aria-busy'); btn.disabled = false; btn.textContent = prev || '加入生詞本';
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

    // Modal 模式：直接在彈窗中顯示詳解
    if (USE_SENTENCE_MODAL) {
        // 高亮當前句（未播放時不淡化，其邏輯在 applySentenceHighlight 內）
        applySentenceHighlight(paraIdx, sentIdx, true);
        try { ui.openModal(); } catch (_) {}
        try { dom.modalTitle.textContent = '句子解析'; } catch (_) {}
        // 建立容器並標記為 modal 環境
        dom.modalBody.innerHTML = '';
        try {
            const mc = dom.appModal.querySelector('.modal-content');
            mc && mc.classList.add('modal-large');
        } catch (_) {}
        const card = document.createElement('div');
        card.className = 'sentence-card';
        card.dataset.modal = '1';
        card.style.margin = '0';
        card.style.padding = '8px 10px 8px 10px';
        card.style.border = '1px solid #e5e7eb';
        card.style.borderRadius = '6px';
        card.style.background = '#fafafa';
        card.innerHTML = '<div style="font-size:12px;opacity:.8">載入中...</div>';
        dom.modalBody.appendChild(card);

        // 關閉時清理高亮
        const cleanup = () => {
            try { applySentenceHighlight(paraIdx, sentIdx, false); } catch (_) {}
            try { const mc = dom.appModal.querySelector('.modal-content'); mc && mc.classList.remove('modal-large'); } catch(_) {}
        };
        try { dom.modalCloseBtn.addEventListener('click', cleanup, { once: true }); } catch(_) {}
        try { dom.appModal.addEventListener('click', (e)=>{ if (e.target === dom.appModal) cleanup(); }, { once: true }); } catch(_) {}

        try {
            const data = await analyzeSentenceDedupe(sentence, context, { timeoutMs: 22000, conciseKeypoints: true, includeStructure: true });
            renderSentenceCard(card, data, sentence, context, paraIdx, sentIdx);
            // 持久化句子解析
            persistSentenceAnalysis(sentence, context, data);
        } catch (e) {
            card.innerHTML = `<div style=\"color:#b91c1c\">解析失敗，稍後再試</div>`;
        }
        return;
    }

    // Inline 卡片模式（保留兼容）
    // existing card toggle
    let card = sentenceEl.nextElementSibling;
    if (card && card.classList.contains('sentence-card')) {
        const hidden = card.classList.toggle('hidden');
        const paraIdx2 = parseInt(sentenceEl.getAttribute('data-para-index'), 10) || 0;
        const sentIdx2 = parseInt(sentenceEl.getAttribute('data-sent-index'), 10) || 0;
        applySentenceHighlight(paraIdx2, sentIdx2, !hidden);
        return;
    }
    card = document.createElement('div');
    card.className = 'sentence-card';
    card.style.margin = '6px 0 10px 0';
    // 為了在句卡右側提供一整塊可點擊的收合區（overlay），
    // 這裡主動預留右側空白，避免 overlay 蓋住內容與操作按鈕。
    card.style.padding = '8px 10px 8px 10px';
    card.style.paddingRight = '76px'; // 與 CSS 中 overlay 寬度對齊，並多留一點緩衝
    card.style.border = '1px solid #e5e7eb';
    card.style.borderRadius = '6px';
    card.style.background = '#fafafa';
    card.innerHTML = '<div style="font-size:12px;opacity:.8">載入中...</div>';
    sentenceEl.after(card);

    try {
        const data = await analyzeSentenceDedupe(sentence, context, { timeoutMs: 22000, conciseKeypoints: true, includeStructure: true });
        renderSentenceCard(card, data, sentence, context, paraIdx, sentIdx);
        // 持久化句子解析
        persistSentenceAnalysis(sentence, context, data);
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
                <button class="btn-ghost btn-mini sent-collapse" title="收合 (點擊標題列或右側也可收合)">收合</button>
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
    // Modal 環境下，將收合按鈕文案替換為「關閉」
    if (collapse && card.dataset.modal === '1') {
        collapse.textContent = '關閉';
        collapse.title = '關閉視窗';
    }
    const head = card.querySelector('.sentence-card-head');
    const selBtn = card.querySelector('.analyze-selection');
    if (collapse) collapse.addEventListener('click', (ev)=> {
        // 避免事件冒泡到標題列或 overlay 造成重複觸發
        ev.stopPropagation();
        if (card.dataset.modal === '1') {
            // 在彈窗中：按鈕行為改為關閉彈窗
            try { ui.closeModal(); } catch(_) {}
            applySentenceHighlight(paraIdx, sentIdx, false);
        } else {
            const hidden = card.classList.toggle('hidden');
            applySentenceHighlight(paraIdx, sentIdx, !hidden);
        }
    });
    if (head) head.addEventListener('click', (ev) => {
        // 允許整個標題列點擊收合，但避免點擊按鈕重複觸發
        const t = ev.target;
        if (t.closest && t.closest('button')) return;
        if (card.dataset.modal === '1') {
            try { ui.closeModal(); } catch(_) {}
            applySentenceHighlight(paraIdx, sentIdx, false);
            return;
        }
        const hidden = card.classList.toggle('hidden');
        applySentenceHighlight(paraIdx, sentIdx, !hidden);
    });

    // 右側大面積收合區（提高點按容忍度）— 僅在 inline 卡片時加入
    try {
        if (card.dataset.modal !== '1') {
            card.style.position = 'relative';
            const overlay = document.createElement('div');
            overlay.className = 'card-collapse-overlay';
            overlay.title = '點擊此區收合';
            // 降低層級，讓標題列與其上的按鈕可點擊在上層
            overlay.style.zIndex = '1';
            overlay.setAttribute('aria-label', '點擊右側空白區可收合');
            // 顯示更明顯的收合圖示與分塊感
            const handle = document.createElement('div');
            handle.className = 'collapse-handle';
            handle.innerHTML = '<span class="chevron">◀</span>';
            overlay.appendChild(handle);
            overlay.addEventListener('click', (ev) => {
                // 避免冒泡，也避免在選字時誤觸
                ev.stopPropagation();
                try {
                    const sel = window.getSelection && window.getSelection();
                    if (sel && sel.toString && sel.toString().trim()) return;
                } catch (_) {}
                const hidden = card.classList.toggle('hidden');
                applySentenceHighlight(paraIdx, sentIdx, !hidden);
            });
            card.appendChild(overlay);
        }
    } catch (_) {}
    if (refresh) refresh.addEventListener('click', async ()=>{
        refresh.disabled = true; refresh.textContent = '重新獲取中...';
        try { const fresh = await api.analyzeSentence(sentence, context, { timeoutMs: 22000, noCache: true, conciseKeypoints: true }); renderSentenceCard(card, fresh, sentence, context, paraIdx, sentIdx); persistSentenceAnalysis(sentence, context, fresh); }
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
            // 持久化片語解析
            try { persistPhraseAnalysis(text, sentence, context, res); } catch (_) {}
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
        const prev = addBtn.textContent;
        addBtn.disabled = true; addBtn.textContent = '加入中...'; addBtn.setAttribute('aria-busy','true');
        try {
            const mod = await import('../../modules/vocab.js');
            const res = await mod.addWordToDefaultBook(text, { source: 'article', sentence, context });
            addBtn.textContent = (res && res.reason === 'duplicate') ? '已存在' : '已加入';
        } catch (err) {
            console.warn('加入生詞本失敗:', err);
            addBtn.textContent = '失敗';
        } finally {
            setTimeout(()=>{
                addBtn.removeAttribute('aria-busy');
                addBtn.disabled = false; addBtn.textContent = prev || '加入生詞本（選中）';
            }, 1000);
        }
    });

}


function applySentenceHighlight(paraIdx, sentIdx, on) {
    const eng = document.querySelector(`.interactive-sentence[data-para-index="${paraIdx}"][data-sent-index="${sentIdx}"]`);
    const zh = document.querySelector(`.interactive-sentence-zh[data-para-index="${paraIdx}"][data-sent-index="${sentIdx}"]`);
    [eng, zh].forEach(el => { if (el) el.classList.toggle('sentence-active', !!on); });
    // 僅在文章朗讀實際播放時啟用淡化，其餘情況不淡化
    const isPlaying = !state.isReadingChunkPaused && !dom.stopReadArticleBtn.disabled;
    dom.articleAnalysisContainer.classList.toggle('dim-others', !!isPlaying);
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
