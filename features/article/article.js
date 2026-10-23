import * as state from '../../modules/state.js';
import * as dom from '../../modules/dom.js';
import * as storage from '../../modules/storage.js';
import * as ui from '../../modules/ui.js';
import { escapeHtml, escapeAttr } from '../../modules/ui.js';
import * as api from '../../modules/api.js';
import * as audio from '../../modules/audio.js';
import {
    getTaskModelSelection,
    saveTaskModelSelection
} from '../../modules/ai-models.js';
import { ARTICLE_IMPORT } from '../../ai-config.js';
import { getAllQASets, loadQASet } from '../qa/qa-storage.js';
import * as cache from '../../modules/cache.js';
import { loadGlobalSettings, saveGlobalSettings } from '../../modules/settings.js';
import { t, formatDateTime, createCollator, getLocaleTag, getLocale } from '../../modules/i18n.js';
import { inlineMarkdownToHtml } from '../../modules/markdown.js';
import * as articleStore from '../../modules/article-store.js';
import * as articleSync from '../../modules/article-sync.js';
import * as readingStore from '../../modules/reading-store.js';
import * as readingActions from '../../modules/reading-actions.js';
import {
    PARAGRAPH_STATUS,
    ANALYSIS_RUN_STATUS,
    classifyParagraphResult,
    paragraphStatusLabelKey,
    paragraphErrorLabelKey,
    failedIndicesFromResult,
    resumeIndicesFromResult,
    isPredominantlyChinese,
    isMarkdownImageLine,
    isPureMarkdownImageParagraph,
    normalizeAnalysisRun,
    isIncompleteAnalysisRun,
    analysisRunStats,
    createAnalysisRun
} from './analysis-state.js';
import * as paragraphPipeline from './paragraph-pipeline.js';
import { contentVersionOf } from '../../shared/reading-protocol.mjs';
import { initReadingPanel, openReadingPanelForItem } from './reading-panel.js';
import { initPhrasePicker, openPhrasePicker } from './phrase-picker.js';
import { segmentWords, shouldSkipNode } from './tokenize.js';
// P3-T5：長文效能量測（?perf=1）；關閉時所有呼叫都是 no-op。
import * as perfProbe from './perf-probe.js';

// =================================
// Article Analysis Feature
// =================================

// ─────────────────────────────────────────────────────────────────────────────
// 文章身份與非同步工作歸屬
//
// 「編輯已載入的記錄」與「匯入另一篇」是兩件事：
//   * 載入閱讀記錄 → articleContext.recordId 指著那篇；
//   * 任何匯入入口（文章庫／網址／OCR／檔案／問答集）→ 先清掉 recordId，
//     分析時才會建立新記錄，不會把 B 寫進 A；
//   * 重新分析同一篇（含手改內文）→ 沿用 recordId 與文章專屬生詞本。
//
// 每個非同步工作（主分析、重試、詞／句／片語）啟動時固定
// { runId, articleId, controller }，回應時只寫回自己那一篇，DOM 也只在自己的
// run 仍是目前工作時更新。
// ─────────────────────────────────────────────────────────────────────────────
const articleContext = {
    recordId: null,
    origin: 'idle',       // 'loaded' | 'analyzed' | 'imported' | 'idle'
    // 記憶體狀態，不持久化：畫面目前顯示的分析版本 vs 輸入框的最新內容。
    viewVersion: '',
    viewText: '',
    analyzedVersion: ''
};

function contentVersionOfText(text) {
    try { return contentVersionOf(String(text || '')); } catch (_) { return ''; }
}

/** 設定「畫面上這份分析」的版本；analyzed=false 代表畫面已不再是分析結果。 */
function setArticleViewVersion(text, { analyzed = true } = {}) {
    articleContext.viewText = String(text || '');
    articleContext.viewVersion = contentVersionOfText(text);
    if (analyzed) articleContext.analyzedVersion = articleContext.viewVersion;
    if (!analyzed) articleContext.analyzedVersion = '';
}

/** 畫面上的分析是否已落後於輸入框（原文被改過）。 */
function isArticleViewStale() {
    // analyzedVersion 只在「畫面真的是某次分析的結果」時才有值；
    // 匯入新文章／清空後 analyzedVersion 為空，就不該再顯示舊版提示。
    const analyzed = articleContext.analyzedVersion || '';
    if (!analyzed) return false;
    const inputVersion = contentVersionOfText(String(dom.articleInput?.value || '').trim());
    return inputVersion !== analyzed;
}

let runSeq = 0;
let activeRun = null;

// ─────────────────────────────────────────────────────────────────────────────
// 分析工作清單（P1-T4）
//
// 主分析與重試都登記在這裡，取消時一起中止；回應回來後先用 isJobWriteTarget
// 確認「原文章、原版本、原帳戶」仍一致，才可更新畫面或寫入記錄。
// ─────────────────────────────────────────────────────────────────────────────
const analysisJobs = new Set();
// 每個段落同一時間只能有一個「寫入擁有者」。後開始的工作會接手同一段的寫入權，
// 被淘汰的舊工作即使晚到也拿不到所有權，因此不得更新 DOM 或落盤（P1-2）。
const paragraphClaims = new Map(); // `${articleId}\n${index}` -> claim
let jobSeq = 0;
let claimSeq = 0;

function paragraphClaimKey(articleId, index) {
    return `${articleId || ''}\n${Number(index)}`;
}

function releaseParagraphClaims(job) {
    if (!job || !job.claims) return;
    job.claims.forEach((claim, key) => {
        if (paragraphClaims.get(key) === claim) paragraphClaims.delete(key);
    });
    job.claims.clear();
}

function cancelAnalysisJob(job, reason = 'cancelled') {
    if (!job || job.cancelled) return;
    job.cancelled = true;
    try { job.controller.abort(reason); } catch (_) { /* noop */ }
    releaseParagraphClaims(job);
    analysisJobs.delete(job);
}

/** 取得某一段落的寫入權；舊的擁有者會被淘汰（單段工作直接中止）。 */
function claimParagraphForJob(job, index) {
    if (!job || !Number.isInteger(index)) return null;
    const key = paragraphClaimKey(job.articleId, index);
    const previous = paragraphClaims.get(key);
    if (previous && previous.job !== job) {
        // 單段工作只有這一段：直接中止。批次工作只失去這一段的寫入權，
        // 其他段落要繼續跑；它的晚到回應會因所有權檢查而被丟棄。
        const previousJob = previous.job;
        if (previousJob && previousJob.kind === 'retry-single') {
            cancelAnalysisJob(previousJob, 'superseded');
        } else {
            previousJob?.claims?.delete(key);
            paragraphClaims.delete(key);
        }
    }
    const claim = { key, job, index, id: ++claimSeq };
    paragraphClaims.set(key, claim);
    if (!job.claims) job.claims = new Map();
    job.claims.set(key, claim);
    return claim;
}

function ownsParagraph(job, index) {
    if (!job || job.cancelled || !job.claims || !Number.isInteger(index)) return false;
    const key = paragraphClaimKey(job.articleId, index);
    const claim = paragraphClaims.get(key);
    return !!claim && claim.job === job && job.claims.get(key) === claim;
}

/** 目前畫面上的這個段落是否仍有工作在跑（忙碌中不得再解鎖按鈕）。 */
function isParagraphBusy(index) {
    if (!Number.isInteger(index)) return false;
    const claim = paragraphClaims.get(paragraphClaimKey(articleContext.recordId, index));
    if (!claim || !claim.job || claim.job.cancelled) return false;
    return analysisJobs.has(claim.job);
}

/** 批次重試進行中：所有逐段入口都必須保持停用。 */
function isBatchRetryActive() {
    for (const job of analysisJobs) {
        if (!job.cancelled && (job.kind === 'retry-batch' || job.kind === 'resume-batch') && isCurrentArticle(job.articleId)) return true;
    }
    return false;
}

function startAnalysisJob({ kind, articleId, contentVersion = '', controller, actionContext = null, index = null }) {
    jobSeq += 1;
    const job = {
        id: jobSeq,
        kind,
        articleId: articleId || '',
        contentVersion: contentVersion || '',
        index: Number.isInteger(index) ? index : null,
        controller: controller || new AbortController(),
        actionContext: actionContext || (() => {
            try { return readingActions.captureActionContext(); } catch (_) { return null; }
        })(),
        cancelled: false,
        claims: new Map(),
        startedAt: Date.now()
    };
    analysisJobs.add(job);
    return job;
}

function finishAnalysisJob(job) {
    if (!job) return;
    releaseParagraphClaims(job);
    analysisJobs.delete(job);
}

/** 中止所有分析工作；晚回應不得再更新新畫面或寫入新文章。 */
function cancelAnalysisJobs(reason = 'cancelled') {
    for (const job of Array.from(analysisJobs)) {
        job.cancelled = true;
        try { job.controller.abort(reason); } catch (_) { /* noop */ }
        releaseParagraphClaims(job);
    }
    analysisJobs.clear();
}

function isJobWriteTarget(job, index = null) {
    if (!job || job.cancelled) return false;
    if (!isCurrentArticle(job.articleId)) return false;
    if (job.actionContext && !readingActions.actionContextActive(job.actionContext)) return false;
    if (job.contentVersion) {
        const record = articleStore.getRecord(job.articleId);
        if (!record) return false;
        if (readingActions.articleVersion(job.articleId) !== job.contentVersion) return false;
    }
    // 同段落請求世代：只有目前持有該段寫入權的工作才能寫。
    const targetIndex = Number.isInteger(index) ? index : job.index;
    if (Number.isInteger(targetIndex) && !ownsParagraph(job, targetIndex)) return false;
    return true;
}

function beginImportContext() {
    articleContext.recordId = null;
    articleContext.origin = 'imported';
}

/** 所有匯入入口都經過這裡：先換編輯上下文，再決定是否命中既有來源。 */
function applyImportedArticle(text, meta = {}) {
    // 匯入等於換一篇：先保存目前草稿、停掉朗讀與分析，再清掉舊分析畫面。
    try { saveCurrentDraft({ force: true }); } catch (_) { /* noop */ }
    cancelAnalysisJobs('import');
    if (activeRun?.checkpoint) cancelAnalysisCheckpoint(activeRun.checkpoint);
    hideAnalysisResumeBanner();
    clearAnalysisCheckpointFailure();
    try { audio.stopCurrentAudio(); } catch (_) { /* noop */ }
    try {
        if (!dom.stopReadArticleBtn?.disabled) stopReadArticle();
    } catch (_) { /* noop */ }
    beginImportContext();
    if (dom.articleInput) dom.articleInput.value = text;
    clearCurrentArticleSourceMeta();
    const sourceType = meta.sourceType || 'paste';
    setCurrentArticleSourceMeta({
        sourceType,
        sourceUrl: meta.sourceUrl || '',
        title: meta.title || ''
    });
    // 舊分析不屬於這篇：直接換成「請重新分析」，不留下看起來可用的舊譯文。
    if (dom.articleAnalysisContainer) {
        // 保留一句說明「為什麼畫面變空」與下一步，不留下看似可用的舊譯文。
        dom.articleAnalysisContainer.innerHTML = `
            <div class="analysis-placeholder">
                <p class="import-replaced-notice">${escapeHtml(t('article.importReplacedAnalysis'))}</p>
                <p class="form-hint">${escapeHtml(t('article.analysisStaleHint'))}</p>
            </div>`;
        dom.articleAnalysisContainer.dataset.analysis = '[]';
    }
    lastFailedIndices = [];
    try { showArticleWordAnalysis._lazyCache?.clear?.(); } catch (_) { /* noop */ }
    dismissWordTooltip({ restoreFocus: false, source: 'article-switch' });
    if (articleSentenceCard) resetSentenceCardState({ restoreFocus: false });
    else clearWordMode({ restoreFocus: false });
    setArticleViewVersion('', { analyzed: false });
    updateRetryFailedButton();
    updateArticleVersionState();
    try { notifyAssistantArticleChanged(); } catch (_) {}
    if (typeof updateHistoryIndicators === 'function') updateHistoryIndicators();
}

function setLoadedArticleContext(recordId, meta = {}) {
    articleContext.recordId = recordId || null;
    articleContext.origin = recordId ? 'loaded' : 'idle';
    if (recordId && typeof state.setCurrentArticleId === 'function') state.setCurrentArticleId(recordId);
    if (recordId && typeof state.setCurrentWordbookId === 'function') state.setCurrentWordbookId(recordId);
    if (meta && meta.sourceType) {
        setCurrentArticleSourceMeta({
            sourceType: meta.sourceType,
            sourceUrl: meta.sourceUrl || '',
            title: meta.title || ''
        });
    }
}

function resetArticleContext() {
    articleContext.recordId = null;
    articleContext.origin = 'idle';
    setArticleViewVersion('', { analyzed: false });
    try {
        if (typeof state.setCurrentArticleId === 'function') state.setCurrentArticleId(null);
        if (typeof state.setCurrentWordbookId === 'function') state.setCurrentWordbookId(null);
    } catch (_) { /* ignore */ }
}

/**
 * 決定這次分析要寫進哪一篇：
 *   1. 正在編輯已載入的記錄 → 沿用（重新分析不換 ID、不裂出生詞本）
 *   2. 本機已有相同網址的記錄 → 沿用該篇（同帳戶內）
 *   3. 其他 → 建立新 ID
 */
function resolveAnalysisArticleId() {
    if (articleContext.recordId && articleStore.getRecord(articleContext.recordId)) {
        return { id: articleContext.recordId, reused: true };
    }
    const ds = (dom.articleInput && dom.articleInput.dataset) || {};
    if ((ds.sourceType || 'paste') === 'url' && (ds.sourceUrl || '').trim()) {
        const url = ds.sourceUrl.trim();
        const existing = articleStore.getRecords().find((record) => (
            record && record.sourceType === 'url' && (record.sourceUrl || '').trim() === url
        ));
        if (existing) return { id: existing.articleId, reused: true };
    }
    return { id: null, reused: false };
}

function createRun(articleId, controller) {
    runSeq += 1;
    return {
        runId: runSeq,
        articleId: articleId || null,
        controller,
        startedAt: Date.now(),
        cancelled: false
    };
}

function isRunActive(run) {
    return !!run && activeRun === run && run.cancelled !== true;
}

/** 分析按鈕的狀態只能由「目前的工作」決定；取消後一定要還原，否則會卡在停用。 */
function resetAnalyzeButton() {
    if (!dom.analyzeArticleBtn) return;
    dom.analyzeArticleBtn.disabled = false;
    dom.analyzeArticleBtn.textContent = t('article.analyze');
}

function cancelActiveRun(reason) {
    cancelAnalysisJobs(reason || 'article-switched');
    const run = activeRun;
    activeRun = null;
    if (!run) {
        resetAnalyzeButton();
        return;
    }
    run.cancelled = true;
    try { run.controller?.abort(reason || 'article-switched'); } catch (_) {}
    // 取消／切換文章：先 flush checkpoint，再把 analysis_run 標成 cancelled，
    // 保留已完成段；重新載入後才能續作。實際寫入是非同步 best effort。
    if (run.checkpoint) cancelAnalysisCheckpoint(run.checkpoint);
    // 舊工作不會再走到自己的 finally，這裡負責把共用 UI 還原
    resetAnalyzeButton();
    const inline = dom.articleAnalysisContainer?.querySelector('.inline-progress');
    if (inline) inline.remove();
}

function isCurrentArticle(articleId) {
    return !!articleId && articleContext.recordId === articleId;
}

// 對 AI 助手通報：文章內容已變更，請按新上下文切換對話（不覆寫使用者已選會話）。
async function notifyAssistantArticleChanged() {
    try {
        const text = (dom.articleInput && dom.articleInput.value) || '';
        const key = text.trim() ? await cache.makeKey('assistant-article', text) : 'global';
        if (window.__assistant && window.__assistant.__ready) {
            // convId 置空 → 由助手決定：已選的會話或該文章的第一筆
            window.__assistant.switch(key, '');
        }
    } catch (_) { /* noop */ }
}

// 根據當前輸入框 dataset 更新「來源」資訊列
function updateArticleSourceBarFromDataset() {
    const input = dom.articleInput;
    const bar = dom.articleSourceBar;
    const label = dom.articleSourceLabel;
    const link = dom.articleSourceLink;
    if (!input || !bar || !label) return;

    const ds = input.dataset || {};
    const sourceType = (ds.sourceType || '').trim();
    const rawUrl = (ds.sourceUrl || '').trim();

    if (!sourceType) {
        bar.classList.add('hidden');
        if (link) link.classList.add('hidden');
        return;
    }

    let text = t('article.sourcePrefix');
    switch (sourceType) {
        case 'url':
            text += t('article.sourceUrl');
            break;
        case 'file':
            text += t('article.sourceFile');
            break;
        case 'ocr':
            text += t('article.sourceOcr');
            break;
        case 'paste':
        default:
            text += t('article.sourcePaste');
            break;
    }
    label.textContent = text;

    if (link) {
        if (sourceType === 'url' && rawUrl) {
            link.href = rawUrl;
            link.textContent = t('article.openSource');
            link.classList.remove('hidden');
        } else {
            link.removeAttribute('href');
            link.classList.add('hidden');
        }
    }

    bar.classList.remove('hidden');
}

// 紀錄當前文章來源 metadata（供後續建立文章專屬生詞本使用）
function setCurrentArticleSourceMeta(meta = {}) {
    const input = dom.articleInput;
    if (!input || !input.dataset) return;
    const ds = input.dataset;
    if (meta.sourceType) {
        ds.sourceType = meta.sourceType;
    }
    if (Object.prototype.hasOwnProperty.call(meta, 'sourceUrl')) {
        const url = (meta.sourceUrl || '').trim();
        if (url) ds.sourceUrl = url;
        else delete ds.sourceUrl;
    }
    if (meta.title) {
        ds.sourceTitle = meta.title;
    }
    updateArticleSourceBarFromDataset();
}

function clearCurrentArticleSourceMeta() {
    const input = dom.articleInput;
    if (!input || !input.dataset) return;
    const ds = input.dataset;
    delete ds.sourceType;
    delete ds.sourceUrl;
    delete ds.sourceTitle;
    updateArticleSourceBarFromDataset();
}

// 依據目前輸入框與已解析標題，構建 ArticleMeta 輸入資料
function buildArticleMetaInput(articleText, parsedTitle) {
    const input = dom.articleInput;
    const ds = (input && input.dataset) || {};
    let sourceType = ds.sourceType || 'paste';
    if (!['url', 'paste', 'file', 'ocr'].includes(sourceType)) {
        sourceType = 'paste';
    }
    const rawUrl = (ds.sourceUrl || '').trim();
    const title = (parsedTitle && parsedTitle.trim())
        || (ds.sourceTitle && ds.sourceTitle.trim())
        || (articleText || '').split('\n').find(line => line.trim())?.trim()
        || t('article.untitled');
    const meta = {
        title,
        sourceType
    };
    if (sourceType === 'url' && rawUrl) {
        meta.sourceUrl = rawUrl;
    }
    return meta;
}

export function initArticle() {
    document.addEventListener('bdc:locale-change', () => {
        updateArticleSourceBarFromDataset();
        refreshHistoryModal();
        updateHistoryIndicators();
        // 頁內查詞結果綁定介面語言與模型：換語言就失效，避免顯示上一種語言的詳解。
        try { wordLookupCache().clear(); } catch (_) { /* noop */ }
        updateRetryFailedButton();
        // 朗讀列只在第一次朗讀時建立，切換語言時要手動刷新它的文字
        applyFloatingReaderTexts();
        updateFloatingToggle();
        // 朗讀鈕的 title／aria-label 會隨播放狀態改變，locale 套用靜態文案後要再校正一次。
        updateReadButtonUI(dom.stopReadArticleBtn.disabled
            ? 'stopped'
            : (state.isReadingChunkPaused ? 'paused' : 'playing'));
        // 下載能力取決於遠端 TTS 設定，locale 套用 data-i18n-* 後也要重套。
        updateDownloadAvailability();
        updateArticleVersionState();
        // 段落狀態、失敗原因、重試鈕與批次摘要是執行時才產生的節點，要重套文案。
        refreshParagraphDynamicTexts();
        refreshAnalysisCheckpointTexts();
        const mode = dom.readingModeSelect?.value;
        if (dom.prevChunkBtn && dom.nextChunkBtn) {
            dom.prevChunkBtn.textContent = t(mode === 'paragraph' ? 'article.previousParagraph' : 'article.previousSentence');
            dom.nextChunkBtn.textContent = t(mode === 'paragraph' ? 'article.nextParagraph' : 'article.nextSentence');
        }
        // 句子／解析鍵的 aria-label 是渲染時動態組的，換語言要重套。
        refreshSentenceAccessibility();
        if (wordModeState?.hint) wordModeState.hint.textContent = t('article.wordModeHint');
        if (articleSentenceCard) {
            const modeBtn = dom.modalBody?.querySelector('.sent-word-mode');
            if (modeBtn) modeBtn.textContent = t('article.wordMode');
        }
        // 可見中的單詞詳解用最後一次內容（wordTooltipLastPayload）重畫；
        // 觸發詞已被移除就關閉並清狀態。
        if (wordTooltipLastPayload && isWordTooltipVisible()) {
            if (!wordTooltipTrigger?.isConnected) {
                dismissWordTooltip({ restoreFocus: false, source: 'locale-trigger-removed' });
            } else {
                const active = document.activeElement;
                const hadFocus = dom.analysisTooltip.contains(active);
                rerenderVisibleWordTooltip();
                // 重畫會換掉節點：焦點原本在裡面、或已經掉到 body／失效節點時，
                // 把焦點放回新的標題，不讓鍵盤使用者失去位置。
                if (hadFocus || !active || active === document.body || !active.isConnected) {
                    focusWordTooltipTitle();
                }
            }
        }
    });
    dom.analyzeArticleBtn.addEventListener('click', analyzeArticle);
    if (dom.resumeAnalysisBtn) dom.resumeAnalysisBtn.addEventListener('click', resumeAnalysis);
    dom.clearArticleBtn.addEventListener('click', () => clearArticleInput());
    if (dom.articleHistoryBtn) dom.articleHistoryBtn.addEventListener('click', openArticleHistory);
    if (dom.articleHistoryStatus) {
        dom.articleHistoryStatus.addEventListener('click', toggleHistoryFromStatus);
        dom.articleHistoryStatus.type = 'button';
    }
    // 復原按鈕可能在文章頁或閱讀記錄彈窗內，用事件委派避免每次重繪都要重新綁定
    document.addEventListener('click', (event) => {
        const button = event.target && event.target.closest ? event.target.closest('.article-history-undo-btn') : null;
        if (!button) return;
        event.preventDefault();
        undoLastDelete();
    });
    // 輸入框內容變動 → 狀態列（尚未存入 / 草稿）即時更新；版本提示用 250ms debounce，
    // 避免每個按鍵都掃描整份分析與按鈕。
    let versionStateTimer = 0;
    dom.articleInput.addEventListener('input', () => {
        updateHistoryIndicators();
        clearTimeout(versionStateTimer);
        versionStateTimer = window.setTimeout(() => {
            try { updateArticleVersionState(); } catch (_) { /* noop */ }
        }, 250);
    });
    if (dom.reanalyzeArticleBtn) {
        dom.reanalyzeArticleBtn.addEventListener('click', () => analyzeArticle());
    }
    if (dom.articleVersionNotice) {
        document.addEventListener('bdc:article-loaded', () => {
            try { updateArticleVersionState(); } catch (_) { /* noop */ }
        });
    }
    // 帳戶切換：範圍內的資料由 article-store 重新載入，畫面不得沿用上一個帳戶的文章
    document.addEventListener('bdc:articles-scope-changed', () => {
        // 換帳戶：上一個範圍的未保存標記不得沿用到新範圍。
        unsavedParagraphs.clear();
        analysisSaveFailures.clear();
        clearBatchSummary();
        clearArticleInput({ keepDraft: false });
        updateHistoryIndicators();
    });
    window.addEventListener('bdc:articles-change', () => { updateHistoryIndicators(); });
    // 留下目前 checkpoint（best effort；不宣稱能保證關頁前最後一刻一定寫入）。
    const flushActiveAnalysisCheckpoint = () => {
        const cp = activeRun?.checkpoint;
        if (!cp || cp.finalSaved) return;
        flushAnalysisCheckpoint(cp, { status: cp.finalStatus || ANALYSIS_RUN_STATUS.running });
    };
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flushActiveAnalysisCheckpoint();
    });
    // 離頁前盡量收掉在途工作（best effort；不宣稱能保證中斷保存）。
    window.addEventListener('pagehide', () => {
        flushActiveAnalysisCheckpoint();
        cancelAnalysisJobs('pagehide');
    });
    // 外部點擊由 ui.initTooltip 收詳解；article 同步清 session 與焦點狀態（不把焦點搶回來）。
    document.addEventListener('bdc:tooltip-hidden', () => { resetWordTooltipState(); });
    // Escape：先收單詞詳解（焦點回原詞），再收句卡（焦點回句子）。
    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        if (isWordTooltipVisible()) {
            // 片語選取器／閱讀面板在上層時，Escape 先交給它們處理。
            if (hasBlockingArticleOverlay()) return;
            event.preventDefault();
            dismissWordTooltip({ restoreFocus: true, source: 'escape' });
            return;
        }
        if (!articleSentenceCard) return;
        if (hasBlockingArticleOverlay()) return;
        const active = document.activeElement;
        const inModal = !!(active && active.closest && active.closest('#app-modal'));
        const onSentence = active === articleSentenceCard.sentenceEl;
        if (!inModal && !onSentence) return;
        event.preventDefault();
        const openedByKeyboard = articleSentenceCard.openedByKeyboard;
        if (!dom.appModal || dom.appModal.classList.contains('hidden')) {
            resetSentenceCardState({ restoreFocus: openedByKeyboard });
            return;
        }
        try { ui.closeModal(); } catch (_) { resetSentenceCardState({ restoreFocus: openedByKeyboard }); }
    });
    document.addEventListener('bdc:modal-closed', () => {
        if (!articleSentenceCard) return;
        // 句卡內的按鈕被移除後焦點會落回 body；這種情況也要把焦點還給句子。
        const restoreFocus = articleSentenceCard.openedByKeyboard || document.activeElement === document.body;
        resetSentenceCardState({ restoreFocus });
    });
    // 重繪／重新分析後：舊句卡與逐詞狀態不得殘留，句子 aria-label 要重套。
    document.addEventListener('bdc:article-loaded', () => {
        if (isWordTooltipVisible()) dismissWordTooltip({ restoreFocus: false, source: 'article-rendered' });
        if (articleSentenceCard) resetSentenceCardState({ restoreFocus: false });
        clearWordMode({ restoreFocus: false });
        refreshSentenceAccessibility();
    });
    window.addEventListener('resize', () => {
        if (!isWordTooltipVisible() || !wordTooltipTrigger?.isConnected) return;
        syncWordTooltipSheetMode();
        ui.repositionTooltip(wordTooltipTrigger);
    });
    // 文章載入後的平滑捲動或使用者捲動時，詳解要跟著觸發詞走，
    // 不能在捲動開始前算一次座標就固定住。
    let wordTooltipScrollFrame = 0;
    window.addEventListener('scroll', () => {
        if (!isWordTooltipVisible() || !wordTooltipTrigger?.isConnected) return;
        if (wordTooltipScrollFrame) return;
        wordTooltipScrollFrame = requestAnimationFrame(() => {
            wordTooltipScrollFrame = 0;
            if (!isWordTooltipVisible() || !wordTooltipTrigger?.isConnected) return;
            ui.repositionTooltip(wordTooltipTrigger);
        });
    }, { passive: true, capture: true });
    dom.readArticleBtn.addEventListener('click', handleReadButtonClick);
    dom.stopReadArticleBtn.addEventListener('click', stopReadArticle);
    updateReadButtonUI('stopped');
    updateDownloadAvailability();
    // 設定面板改了 TTS 服務後，下載鈕的能力說明要立即反映。
    document.addEventListener('bdc:settings-change', updateDownloadAvailability);
    // 其他模組（單詞發音、聽寫）搶走音訊時，文章朗讀只進入暫停，不自動恢復、也不假裝續播。
    document.addEventListener('bdc:audio-interrupted', (event) => {
        const detail = event?.detail || {};
        if (detail.owner !== 'article-reading') return;
        if (!state.readingChunks || !state.readingChunks.length) return;
        _playToken++;
        state.setIsReadingChunkPaused(true);
        _interruptedByOtherAudio = true;
        updateReadButtonUI('paused');
        updateFloatingToggle();
    });
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
        
        dom.prevChunkBtn.textContent = t(mode === 'paragraph' ? 'article.previousParagraph' : 'article.previousSentence');
        dom.nextChunkBtn.textContent = t(mode === 'paragraph' ? 'article.nextParagraph' : 'article.nextSentence');
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
    
    // 中文翻譯遮罩（預設開啟；滑鼠移入/行動端按住顯示）
    try { setupChineseTranslationMask(); } catch (_) {}
    
    // 移除 hover 行為：不再於滑過時自動高亮或補配對，改為點擊才觸發詳解
    // dom.articleAnalysisContainer.addEventListener('mouseover', handleWordHighlight);
    // dom.articleAnalysisContainer.addEventListener('mouseout', handleWordHighlight);
    dom.articleAnalysisContainer.addEventListener('click', handleArticleWordAnalysisClick);
    dom.articleAnalysisContainer.addEventListener('keydown', handleArticleAnalysisKeydown);
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

    updateHistoryIndicators();
    try { updateArticleSourceBarFromDataset(); } catch (_) {}

    // 選字快速加入生詞本／選短語（文章詳解區）
    try { initArticleSelectionToWordbook(); } catch (_) {}
    try { initPhrasePicker(); } catch (_) {}
    try { initReadingPanel(); } catch (_) {}
}

// =============================
// 中文翻譯模糊遮罩（文章詳解）
// =============================
function setupChineseTranslationMask() {
    // 讀取全域設定，預設為 true（啟用遮罩）
    const s = loadGlobalSettings();
    const enabled = !!(s && s.reading ? s.reading.translationMask !== false : true);
    applyCnMask(enabled);

    if (dom.cnMaskToggle) {
        dom.cnMaskToggle.checked = enabled;
        dom.cnMaskToggle.addEventListener('change', () => {
            const on = !!dom.cnMaskToggle.checked;
            applyCnMask(on);
            try { saveGlobalSettings({ reading: { translationMask: on } }); } catch(_) {}
        });
    }

    // 行動端「按住顯示」邏輯：按下時揭示，鬆開即恢復
    let revealingEl = null;
    const getChineseContainer = (el) => el && el.closest ? el.closest('.paragraph-chinese') : null;
    const beginReveal = (el) => { if (el) { revealingEl = el; revealingEl.classList.add('reveal'); } };
    const endReveal = () => { if (revealingEl) { revealingEl.classList.remove('reveal'); revealingEl = null; } };
    const shouldHandle = () => dom.articleSection && dom.articleSection.classList.contains('cn-mask-enabled');

    // Pointer 事件（跨裝置）
    dom.articleAnalysisContainer.addEventListener('pointerdown', (e) => {
        if (!shouldHandle()) return;
        const t = getChineseContainer(e.target);
        if (t) beginReveal(t);
    }, { passive: true });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => {
        dom.articleAnalysisContainer.addEventListener(ev, endReveal, { passive: true });
    });

    // 備援：Touch 事件（舊機）
    dom.articleAnalysisContainer.addEventListener('touchstart', (e) => {
        if (!shouldHandle()) return;
        const t = getChineseContainer(e.target);
        if (t) beginReveal(t);
    }, { passive: true });
    ['touchend', 'touchcancel'].forEach(ev => {
        dom.articleAnalysisContainer.addEventListener(ev, endReveal, { passive: true });
    });
}

function applyCnMask(on) {
    if (!dom.articleSection) return;
    dom.articleSection.classList.toggle('cn-mask-enabled', !!on);
    if (!on) {
        try { dom.articleSection.querySelectorAll('.paragraph-chinese.reveal').forEach(el => el.classList.remove('reveal')); } catch(_) {}
    }
}

// api 層回報的非致命問題（例如清洗結果被模型輸出上限截斷）→ 用語系文案提示使用者
const IMPORT_NOTICE_KEYS = {
    'cleanup-truncated': 'article.cleanupTruncated',
    'extract-truncated': 'article.extractTruncated'
};
function onImportNotice(code) {
    const key = IMPORT_NOTICE_KEYS[code];
    if (!key) return;
    try { ui.displayMessage(t(key), 'warning', 6000); } catch (_) {}
}

// 導入文章（網址/圖片OCR）— 使用一顆按鈕彈窗，避免佔版面
function openArticleImportModal() {
    const esc = escapeHtml;
    const body = dom.modalBody;
    if (!body) return;
    body.innerHTML = '';
    // 使導入視窗採用較寬/較高版面，避免內容擁擠與被裁切
    try {
        const mc = dom.appModal.querySelector('.modal-content');
        if (mc) mc.classList.add('modal-large');
    } catch(_) {}

    // 分頁切換（樣式化）
    const tabs = document.createElement('div');
    tabs.className = 'import-tabbar';
    const btnUrl = document.createElement('button');
    btnUrl.className = 'tab-btn';
    btnUrl.textContent = t('article.importUrl');
    btnUrl.dataset.tab = 'url';
    const btnNews = document.createElement('button');
    btnNews.className = 'tab-btn';
    btnNews.textContent = t('article.importNews');
    btnNews.dataset.tab = 'news';
    const btnOcr = document.createElement('button');
    btnOcr.className = 'tab-btn';
    btnOcr.textContent = t('article.importOcr');
    btnOcr.dataset.tab = 'ocr';
    const btnQa = document.createElement('button');
    btnQa.className = 'tab-btn';
    btnQa.textContent = t('article.importQa');
    btnQa.dataset.tab = 'qa';
    tabs.appendChild(btnUrl); tabs.appendChild(btnNews); tabs.appendChild(btnOcr); tabs.appendChild(btnQa);
    const panel = document.createElement('div');
    panel.style.minHeight = '120px';
    body.appendChild(tabs);
    body.appendChild(panel);

    // --- localStorage helpers for remembering user preferences ---
    const LS = {
        get(key, def) { try { const v = localStorage.getItem(key); if (v == null) return def; return JSON.parse(v); } catch(_) { return def; } },
        set(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch(_) {} }
    };
    const LS_KEYS = {
        activeTab: 'importArticle.activeTab',
        cleanEnabled: 'importArticle.clean.enabled',
        cleanKeepImages: 'importArticle.clean.keepImages',
        cleanModel: 'importArticle.clean.model',
        cleanAutoApply: 'importArticle.clean.autoApply',
        directOnly: 'importArticle.url.directOnly',
        ocrModel: 'importArticle.ocr.model',
        ocrPreferCamera: 'importArticle.ocr.preferCamera',
        ocrMerge: 'importArticle.ocr.merge',
        newsSource: 'importArticle.news.source'
    };

    const getArticleCleanupModelSelection = () => getTaskModelSelection('articleCleanup', {
        currentValue: LS.get(LS_KEYS.cleanModel, '')
    });
    const getArticleOCRModelSelection = () => getTaskModelSelection('imageOCR', {
        currentValue: LS.get(LS_KEYS.ocrModel, '')
    });
    const persistArticleCleanupModel = (value) => {
        const normalized = String(value || '');
        LS.set(LS_KEYS.cleanModel, normalized);
        try { saveTaskModelSelection('articleCleanup', normalized); } catch (_) {}
    };
    const persistArticleOCRModel = (value) => {
        const normalized = String(value || '');
        LS.set(LS_KEYS.ocrModel, normalized);
        try { saveTaskModelSelection('imageOCR', normalized); } catch (_) {}
    };

    // 模型選擇器：沒有可選模型時不留下空白下拉框，改為提示前往全局設定
    const modelPickerHtml = (selectId, selection, labelText) => {
        const optionsHtml = (selection.options || [])
            .map(option => `<option value="${esc(option.value)}">${esc(option.label || option.value)}</option>`)
            .join('');
        const control = optionsHtml && !selection.disabled
            ? `<select id="${selectId}" class="import-input short">${optionsHtml}</select>`
            : `<span class="form-hint">${t('article.configureModel')}</span>`;
        return `<span class="model-label">${labelText}</span>${control}`;
    };

    const renderUrl = () => {
        panel.innerHTML = '';
        const wrap = document.createElement('div');

        const cleanSelection = getArticleCleanupModelSelection();
        wrap.innerHTML = `
            <div class="import-form">
                <div class="form-row">
                    <label class="label" for="imp-url">${t('article.pasteUrl')}</label>
                    <div class="controls">
                        <input id="imp-url" class="import-input" type="url" placeholder="https://example.com/article">
                        <p id="imp-url-error" class="field-error" role="alert" hidden></p>
                    </div>
                    <div class="form-actions">
                        <button id="imp-fetch" class="btn-primary">${t('article.fetch')}</button>
                        <button id="imp-url-pick" class="btn-secondary" type="button" title="${t('article.chooseFileTitle')}">${t('article.chooseFile')}</button>
                        <input id="imp-url-file" class="import-file-input" type="file" accept=".md,.markdown,.txt,text/plain,text/markdown" multiple>
                    </div>
                </div>
                <div class="form-row wrap">
                    <span class="label">${t('article.cleanupOptions')}</span>
                    <div class="controls">
                        <label class="checkbox-inline"><input id="imp-ai-clean" type="checkbox"> <span>${t('article.aiCleanup')}</span></label>
                        <label class="checkbox-inline"><input id="imp-ai-keep-images" type="checkbox" checked> <span>${t('article.keepImages')}</span></label>
                        <label class="checkbox-inline"><input id="imp-auto-apply" type="checkbox"> <span>${t('article.autoApply')}</span></label>
                        <label class="checkbox-inline"><input id="imp-direct-only" type="checkbox"> <span>${t('article.skipThirdParty')}</span></label>
                        ${modelPickerHtml('imp-ai-clean-model', cleanSelection, t('article.cleanupModel'))}
                    </div>
                </div>
                <div class="dropzone" id="imp-url-dropzone" tabindex="0" aria-label="${t('article.dropTextFile')}">${t('article.dropTextFile')}</div>
                <div id="imp-preview" class="import-preview" style="display:none;">
                    <div class="split">
                        <div class="pane">
                            <div class="import-preview-head">${t('article.beforeCleanup')}</div>
                            <pre id="imp-before" class="import-preview-body"></pre>
                        </div>
                        <div class="pane">
                            <div class="import-preview-head">${t('article.afterCleanup')}</div>
                            <pre id="imp-after" class="import-preview-body"></pre>
                        </div>
                    </div>
                    <div class="import-preview-actions"><button id="imp-apply" class="btn-primary">${t('article.applyInput')}</button></div>
                </div>
                <p class="import-hint">${t('article.importHint')}</p>
            </div>`;
        panel.appendChild(wrap);
        const $ = (sel) => wrap.querySelector(sel);
        const urlInput = $('#imp-url');
        const fetchBtn = $('#imp-fetch');
        const urlErrorEl = $('#imp-url-error');
        // 就地驗證：彈窗還開著的時候，欄位旁的訊息比底部提示條可靠
        //（提示條會被遮罩壓住、且幾秒後消失，使用者常常來不及看到）。
        const showUrlError = (message) => {
            if (!urlErrorEl) return;
            urlErrorEl.textContent = message || '';
            urlErrorEl.hidden = !message;
            if (urlInput) {
                if (message) urlInput.setAttribute('aria-invalid', 'true');
                else urlInput.removeAttribute('aria-invalid');
            }
            if (message && urlInput) { try { urlInput.focus(); } catch (_) {} }
        };
        if (urlInput) urlInput.addEventListener('input', () => showUrlError(''));
        const fileInput = $('#imp-url-file');
        const pickBtn = $('#imp-url-pick');
        const aiCleanChk = $('#imp-ai-clean');
        const modelSelect = $('#imp-ai-clean-model');
        const keepImagesChk = $('#imp-ai-keep-images');
        const autoApplyChk = $('#imp-auto-apply');
        const directOnlyChk = $('#imp-direct-only');
        if (modelSelect) {
            modelSelect.value = String(cleanSelection.value || '');
        }
        // restore toggles
        if (aiCleanChk) aiCleanChk.checked = !!LS.get(LS_KEYS.cleanEnabled, true);
        if (keepImagesChk) keepImagesChk.checked = LS.get(LS_KEYS.cleanKeepImages, true);
        if (autoApplyChk) autoApplyChk.checked = LS.get(LS_KEYS.cleanAutoApply, true);
        if (directOnlyChk) directOnlyChk.checked = !!LS.get(LS_KEYS.directOnly, false);
        // persist on change
        if (aiCleanChk) aiCleanChk.addEventListener('change', () => LS.set(LS_KEYS.cleanEnabled, !!aiCleanChk.checked));
        if (keepImagesChk) keepImagesChk.addEventListener('change', () => LS.set(LS_KEYS.cleanKeepImages, !!keepImagesChk.checked));
        if (autoApplyChk) autoApplyChk.addEventListener('change', () => LS.set(LS_KEYS.cleanAutoApply, !!autoApplyChk.checked));
        if (modelSelect) modelSelect.addEventListener('change', () => persistArticleCleanupModel(modelSelect.value));
        if (directOnlyChk) directOnlyChk.addEventListener('change', () => LS.set(LS_KEYS.directOnly, !!directOnlyChk.checked));
        const previewBox = $('#imp-preview');
        const beforeEl = $('#imp-before');
        const afterEl = $('#imp-after');
        const applyBtn = $('#imp-apply');
        const dropzone = $('#imp-url-dropzone');
        if (applyBtn) applyBtn.addEventListener('click', () => {
            const md = (afterEl && afterEl.textContent && afterEl.textContent.trim()) || (beforeEl && beforeEl.textContent) || '';
            if (md && dom.articleInput) {
                const rawUrl = (urlInput && urlInput.value) ? urlInput.value.trim() : '';
                applyImportedArticle(md, rawUrl
                    ? { sourceType: 'url', sourceUrl: rawUrl }
                    : { sourceType: 'paste' });
                try { ui.closeModal(); } catch(_) {}
                try { dom.articleInput.focus(); } catch (_) {}
                // 通知 AI 助手：文章已切換
                try { notifyAssistantArticleChanged(); } catch(_) {}
            }
        });

        // 本機檔案導入（.md/.txt）
        function acceptLocalTextFiles(list) {
            const files = Array.from(list || []);
            const allowed = files.filter(f => {
                if (!f) return false;
                const name = (f.name||'').toLowerCase();
                const okExt = name.endsWith('.md') || name.endsWith('.markdown') || name.endsWith('.txt');
                const okType = /^text\/(plain|markdown)/.test(f.type||'');
                return okExt || okType;
            });
            if (!allowed.length) return;
            Promise.all(allowed.map(f => f.text())).then(async texts => {
                const merged = texts.join('\n\n').trim();
                if (!merged) return;
                if (aiCleanChk && aiCleanChk.checked) {
                    fetchBtn.textContent = t('article.cleaning'); fetchBtn.disabled = true;
                    let after = merged;
                    try { after = await api.aiCleanArticleMarkdown(merged, { timeoutMs: 25000, model: modelSelect && modelSelect.value, keepImages: keepImagesChk ? !!keepImagesChk.checked : true, onNotice: onImportNotice }); } catch(_) {}
                    if (autoApplyChk && autoApplyChk.checked) {
                        applyImportedArticle(after, { sourceType: 'file' });
                        try { ui.closeModal(); } catch(_) {}
                        try { dom.articleInput.focus(); } catch(_) {}
                        try { notifyAssistantArticleChanged(); } catch(_) {}
                    } else {
                        if (beforeEl) beforeEl.textContent = merged;
                        if (afterEl) afterEl.textContent = after;
                        if (previewBox) previewBox.style.display = 'block';
                    }
                    fetchBtn.disabled = false; fetchBtn.textContent = t('article.fetchShort');
                } else {
                    if (beforeEl) beforeEl.textContent = merged;
                    if (afterEl) afterEl.textContent = '';
                    if (previewBox) previewBox.style.display = 'block';
                }
            });
        }
        if (pickBtn) pickBtn.addEventListener('click', () => { fileInput && fileInput.click(); });
        if (fileInput) fileInput.addEventListener('change', () => { acceptLocalTextFiles(fileInput.files); try { fileInput.value=''; } catch(_){} });

        // 拖放與貼上純文字或檔案
        if (dropzone) {
            ;['dragenter','dragover','dragleave','drop'].forEach(ev => dropzone.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); }));
            dropzone.addEventListener('dragover', () => dropzone.classList.add('dragover'));
            dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
            dropzone.addEventListener('drop', (e) => {
                dropzone.classList.remove('dragover');
                if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
                    acceptLocalTextFiles(e.dataTransfer.files);
                }
            });
            dropzone.addEventListener('focus', () => dropzone.classList.add('focused'));
            dropzone.addEventListener('blur', () => dropzone.classList.remove('focused'));
            // 僅在 dropzone 聚焦或貼於其上時攔截貼上全文；避免覆蓋網址輸入框的貼上
            dropzone.addEventListener('paste', async (e) => {
                try {
                    // 若焦點在網址輸入框則不處理
                    if (document.activeElement === urlInput || e.target === urlInput) return;
                    const html = (e.clipboardData && e.clipboardData.getData && e.clipboardData.getData('text/html')) || '';
                    const plain = (e.clipboardData && e.clipboardData.getData && e.clipboardData.getData('text/plain')) || '';
                    if (html && html.trim()) {
                        e.preventDefault();
                        if (aiCleanChk && aiCleanChk.checked) {
                            fetchBtn.textContent = t('article.cleaning'); fetchBtn.disabled = true;
                            try {
                                const after = await api.aiExtractArticleFromHtml(html, { url: (urlInput && urlInput.value) || '', keepImages: keepImagesChk ? !!keepImagesChk.checked : true, model: modelSelect && modelSelect.value, timeoutMs: 30000, onNotice: onImportNotice });
                                if (autoApplyChk && autoApplyChk.checked) {
                                    {
                                        const rawUrl = (urlInput && urlInput.value) ? urlInput.value.trim() : '';
                                        applyImportedArticle(after, rawUrl
                                            ? { sourceType: 'url', sourceUrl: rawUrl }
                                            : { sourceType: 'paste' });
                                    }
                                    try { ui.closeModal(); } catch(_) {}
                                    try { dom.articleInput.focus(); } catch(_) {}
                                    try { notifyAssistantArticleChanged(); } catch(_) {}
                                } else {
                                    if (beforeEl) beforeEl.textContent = '';
                                    if (afterEl) afterEl.textContent = after;
                                    if (previewBox) previewBox.style.display = 'block';
                                }
                            } catch(_) {}
                            fetchBtn.disabled = false; fetchBtn.textContent = t('article.fetchShort');
                        } else {
                            // 不清洗時，直接丟回純文字
                            if (beforeEl) beforeEl.textContent = plain.trim() || '';
                            if (afterEl) afterEl.textContent = '';
                            if (previewBox) previewBox.style.display = 'block';
                        }
                        return;
                    }
                    if (plain && plain.trim()) {
                        e.preventDefault();
                        beforeEl.textContent = plain.trim();
                        afterEl.textContent = '';
                        previewBox.style.display = 'block';
                    }
                } catch(_) {}
            });
        }
        fetchBtn.addEventListener('click', async () => {
            const url = (urlInput.value || '').trim();
            if (!url) { showUrlError(t('article.enterUrl')); return; }
            showUrlError('');
            fetchBtn.disabled = true; fetchBtn.textContent = t('article.fetching');
            try {
                const wantsAiClean = aiCleanChk && aiCleanChk.checked;
                const wantsDirectOnly = directOnlyChk && directOnlyChk.checked;

                if (wantsAiClean && wantsDirectOnly) {
                    // 不經 r.jina.ai：僅嘗試直抓 HTML → AI 生成乾淨 Markdown
                    let after = '';
                    try {
                        after = await api.fetchArticleCleanMarkdown(url, {
                            noThirdPartyGateway: true,
                            timeoutMs: 30000,
                            model: modelSelect && modelSelect.value,
                            keepImages: keepImagesChk ? !!keepImagesChk.checked : true,
                            onNotice: onImportNotice
                        });
                    } catch (e) {
                        throw new Error((e && e.message) ? e.message : t('article.directFetchFailed'));
                    }
                    if (autoApplyChk && autoApplyChk.checked) {
                        applyImportedArticle(after, { sourceType: 'url', sourceUrl: url });
                        try { ui.closeModal(); } catch(_) {}
                        try { dom.articleInput.focus(); } catch (_) {}
                        try { notifyAssistantArticleChanged(); } catch(_) {}
                    } else {
                        if (beforeEl) beforeEl.textContent = '';
                        if (afterEl) afterEl.textContent = after;
                        if (previewBox) previewBox.style.display = 'block';
                    }
                } else {
                    // 既有流程：r.jina.ai → 文字 →（可選）AI 清洗
                    const res = await api.fetchArticleFromUrlStructured(url, { timeoutMs: 22000 });
                    // 內容已經是 Markdown 且有 H1 時不要再補一次標題（否則會出現兩個同樣的標題）
                    const body = (res.content || '').trim();
                    const needsTitle = !!res.title && !/^#\s+/.test(body.split('\n')[0] || '');
                    const before = ((needsTitle ? `# ${res.title}\n\n` : '') + body).trim();
                        if (wantsAiClean) {
                        fetchBtn.textContent = t('article.cleaning');
                        let after = before;
                        const onProgress = (done, total) => { fetchBtn.textContent = t('article.cleaningProgress', { done, total }); };
                        try {
                            after = await api.aiCleanArticleMarkdown(before, { timeoutMs: 25000, model: modelSelect && modelSelect.value, keepImages: keepImagesChk ? !!keepImagesChk.checked : true, onNotice: onImportNotice, onProgress });
                        } catch (_) { /* keep before */ }
                            if (autoApplyChk && autoApplyChk.checked) {
                                applyImportedArticle(after, {
                                    sourceType: 'url',
                                    sourceUrl: url,
                                    title: res && res.title ? String(res.title) : ''
                                });
                                try { ui.closeModal(); } catch(_) {}
                                try { dom.articleInput.focus(); } catch (_) {}
                                try { notifyAssistantArticleChanged(); } catch(_) {}
                            } else {
                            if (beforeEl) beforeEl.textContent = before;
                            if (afterEl) afterEl.textContent = after;
                            if (previewBox) previewBox.style.display = 'block';
                        }
                        } else {
                            applyImportedArticle(before, {
                                sourceType: 'url',
                                sourceUrl: url,
                                title: res && res.title ? String(res.title) : ''
                            });
                            try { ui.closeModal(); } catch(_) {}
                            try { dom.articleInput.focus(); } catch (_) {}
                            try { notifyAssistantArticleChanged(); } catch(_) {}
                        }
                }
            } catch (e) {
                ui.displayMessage(t('article.fetchFailed', { message: e?.message || e }), 'error');
            } finally {
                fetchBtn.disabled = false; fetchBtn.textContent = t('article.fetchShort');
            }
        });
    };

    const renderNews = async () => {
        panel.innerHTML = '';
        const wrap = document.createElement('div');
        const cleanSelection = getArticleCleanupModelSelection();
        wrap.innerHTML = `
            <div class="import-form">
                <div class="form-row wrap">
                    <span class="label">${t('article.sourceList')}</span>
                    <div class="controls news-source-list" id="news-source-list"></div>
                </div>
                <div class="form-row wrap">
                    <span class="label">${t('article.cleanupOptions')}</span>
                    <div class="controls">
                        <label class="checkbox-inline"><input id="news-ai-clean" type="checkbox"> <span>${t('article.aiCleanup')}</span></label>
                        <label class="checkbox-inline"><input id="news-keep-images" type="checkbox" checked> <span>${t('article.keepImages')}</span></label>
                        <label class="checkbox-inline"><input id="news-auto-apply" type="checkbox"> <span>${t('article.autoApply')}</span></label>
                        ${modelPickerHtml('news-clean-model', cleanSelection, t('article.cleanupModel'))}
                    </div>
                </div>
                <div id="news-feed" class="news-feed" aria-live="polite"></div>
                <div id="news-preview" class="import-preview" style="display:none;">
                    <div class="import-preview-head">${t('article.preview')}</div>
                    <pre id="news-preview-body" class="import-preview-body"></pre>
                    <div class="import-preview-actions"><button id="news-apply" class="btn-primary">${t('article.applyInput')}</button></div>
                </div>
            </div>
        `;
        panel.appendChild(wrap);

        const sourceList = wrap.querySelector('#news-source-list');
        const feedBox = wrap.querySelector('#news-feed');
        const previewBox = wrap.querySelector('#news-preview');
        const previewBody = wrap.querySelector('#news-preview-body');
        const applyBtn = wrap.querySelector('#news-apply');
        const aiCleanChk = wrap.querySelector('#news-ai-clean');
        const keepImagesChk = wrap.querySelector('#news-keep-images');
        const autoApplyChk = wrap.querySelector('#news-auto-apply');
        const modelSel = wrap.querySelector('#news-clean-model');
        if (aiCleanChk) aiCleanChk.checked = !!LS.get(LS_KEYS.cleanEnabled, true);
        if (keepImagesChk) keepImagesChk.checked = LS.get(LS_KEYS.cleanKeepImages, true);
        if (autoApplyChk) autoApplyChk.checked = LS.get(LS_KEYS.cleanAutoApply, false);
        if (modelSel) modelSel.value = String(cleanSelection.value || '');

        // 來源列表：優先向 Worker 取得，若無則回退 ai-config.SOURCES
        // 這個端點偶爾會慢到十幾秒，單次失敗就掉進後備清單會讓使用者點到不存在的來源，所以重試一次；
        // 期間先放佔位文字，否則這裡會空白十幾秒，看起來像壞掉
        if (sourceList) sourceList.innerHTML = `<span class="form-hint">${t('article.loading')}</span>`;
        let sources = [];
        for (const timeoutMs of [10000, 8000]) {
            try {
                const fromApi = await api.listArticleSources({ timeoutMs });
                if (Array.isArray(fromApi) && fromApi.length) { sources = fromApi; break; }
            } catch (_) { /* 再試一次 */ }
        }
        const usingFallbackSources = !sources.length;
        if (usingFallbackSources && Array.isArray(ARTICLE_IMPORT?.SOURCES)) sources = ARTICLE_IMPORT.SOURCES;
        if (!sources.length) {
            feedBox.innerHTML = `<div class="news-empty">${t('article.newsSourcesMissing')}</div>`;
            return;
        }
        if (usingFallbackSources && sourceList) {
            // 後備清單是手寫的，可能與服務端實際支援的來源不一致；先講清楚再讓使用者點
            const hint = document.createElement('div');
            hint.className = 'form-hint';
            hint.textContent = t('article.sourcesFallbackHint');
            sourceList.after(hint);
        }

        let currentSource = LS.get(LS_KEYS.newsSource, sources[0]?.id || '');
        let previewText = '';
        let previewUrl = '';
        let previewTitle = '';
        const cacheFeeds = new Map();

        const formatDate = (ds) => {
            if (!ds) return '';
            try {
                const d = new Date(ds);
                if (Number.isNaN(d.getTime())) return '';
                return formatDateTime(d, { hour12: false });
            } catch (_) { return ''; }
        };

        const renderSources = () => {
            if (!sourceList) return;
            sourceList.innerHTML = '';
            sources.forEach(src => {
                const btn = document.createElement('button');
                btn.className = 'news-source-btn';
                if (src.id === currentSource) btn.classList.add('active');
                btn.dataset.id = src.id;
                btn.textContent = src.label || src.id;
                btn.addEventListener('click', () => {
                    if (src.id === currentSource) return;
                    currentSource = src.id;
                    try { LS.set(LS_KEYS.newsSource, currentSource); } catch (_) {}
                    renderSources();
                    loadFeed(currentSource);
                });
                sourceList.appendChild(btn);
            });
        };

        const renderFeed = (list, sourceId) => {
            if (!feedBox) return;
            feedBox.innerHTML = '';
            if (!list || !list.length) {
                feedBox.innerHTML = `<div class="news-empty">${t('article.newsEmptySource')}</div>`;
                return;
            }
            list.forEach(item => {
                const title = item.title || t('errors.untitledArticle');
                const url = item.url || item.link || '';
                const hasUrl = !!url;
                const time = formatDate(item.publishedAt || item.pubDate || item.date);
                const meta = [time, item.sourceId || sourceId].filter(Boolean).join(' · ');
                const card = document.createElement('div');
                card.className = 'news-card';
                card.innerHTML = `
                    <div class="news-head">
                        <div class="news-title" title="${esc(title)}">${esc(title)}</div>
                        <div class="news-meta">${esc(meta)}</div>
                    </div>
                    <div class="news-actions">
                        ${hasUrl ? `<a class="btn-secondary news-origin-btn" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${t('article.newsOrigin')}</a>` : ''}
                        <button class="btn-secondary news-preview-btn" data-url="${esc(url)}" data-source="${esc(sourceId)}">${t('article.preview')}</button>
                        <button class="btn-primary news-import-btn" data-url="${esc(url)}" data-source="${esc(sourceId)}">${t('article.newsImportBtn')}</button>
                    </div>
                `;
                feedBox.appendChild(card);
            });
        };

        const loadFeed = async (sourceId) => {
            if (!feedBox) return;
            feedBox.innerHTML = `<div class="news-empty">${t('article.loading')}</div>`;
            try {
                if (cacheFeeds.has(sourceId)) {
                    renderFeed(cacheFeeds.get(sourceId), sourceId);
                    return;
                }
                const list = await api.listCuratedArticles(sourceId, { timeoutMs: 16000 });
                cacheFeeds.set(sourceId, list || []);
                renderFeed(list || [], sourceId);
            } catch (err) {
                // 失敗時給一顆重試鍵：再點同一個來源按鈕會被「已是目前來源」擋掉，否則只能重新開窗
                feedBox.innerHTML = `<div class="news-empty">${t('article.newsLoadFailed', { message: esc(err?.message || err || t('article.newsUnknownError')) })}
                    <button class="btn-secondary news-retry-btn" data-source="${esc(sourceId)}">${t('article.retry')}</button></div>`;
            }
        };

        const applyMarkdown = (md, { forcePreview = false } = {}) => {
            if (!md) return;
            previewText = md;
            if (!forcePreview && autoApplyChk && autoApplyChk.checked && dom.articleInput) {
                applyImportedArticle(md, previewUrl
                    ? { sourceType: 'url', sourceUrl: previewUrl, title: previewTitle }
                    : { sourceType: 'paste' });
                try { ui.closeModal(); } catch (_) {}
                try { dom.articleInput.focus(); } catch (_) {}
                try { notifyAssistantArticleChanged(); } catch (_) {}
                return;
            }
            if (previewBody) previewBody.textContent = md;
            if (previewBox) previewBox.style.display = 'block';
            try { previewBox?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (_) {}
        };

        const importArticleFromNews = async (sourceId, articleUrl, triggerBtn, forcePreviewOnly = false) => {
            if (!articleUrl) { ui.displayMessage(t('article.missingUrl'), 'warning'); return; }
            const btnState = triggerBtn ? { el: triggerBtn, text: triggerBtn.textContent } : null;
            if (btnState) { btnState.el.disabled = true; btnState.el.textContent = t('article.processing'); }
            try {
                const keepImages = keepImagesChk ? !!keepImagesChk.checked : true;
                const wantAiClean = aiCleanChk ? !!aiCleanChk.checked : true;
                const model = modelSel ? modelSel.value : undefined;
                const res = await api.fetchCuratedArticle(sourceId, articleUrl, { keepImages, timeoutMs: 22000, model, onNotice: onImportNotice });
                let md = res?.markdown || '';
                if (!md && res?.raw?.contentText) md = String(res.raw.contentText);
                if (res?.title) {
                    const firstLine = (md || '').split('\n')[0] || '';
                    if (!/^#\s+/.test(firstLine.trim())) md = `# ${res.title}\n\n${md || ''}`;
                }
                previewUrl = articleUrl || '';
                previewTitle = res && res.title ? String(res.title) : '';
                if (wantAiClean && md) {
                    try {
                        md = await api.aiCleanArticleMarkdown(md, {
                            keepImages, timeoutMs: 25000, model, onNotice: onImportNotice,
                            onProgress: (done, total) => { if (btnState) btnState.el.textContent = t('article.cleaningProgress', { done, total }); }
                        });
                    } catch (_) { /* noop */ }
                }
                if (!md) throw new Error(t('article.articleContentMissing'));
                applyMarkdown(md.trim(), { forcePreview: forcePreviewOnly });
            } catch (err) {
                ui.displayMessage(t('article.articleImportFailed', { message: err?.message || err }), 'error');
            } finally {
                if (btnState) { btnState.el.disabled = false; btnState.el.textContent = btnState.text; }
            }
        };

        renderSources();
        await loadFeed(currentSource);

        if (feedBox) {
            feedBox.addEventListener('click', (e) => {
                const target = e.target && e.target.closest ? e.target.closest('button') : null;
                if (!target) return;
                const url = target.dataset.url || '';
                const src = target.dataset.source || currentSource;
                if (target.classList.contains('news-retry-btn')) {
                    loadFeed(src);
                } else if (target.classList.contains('news-import-btn')) {
                    importArticleFromNews(src, url, target, false);
                } else if (target.classList.contains('news-preview-btn')) {
                    importArticleFromNews(src, url, target, true);
                }
            });
        }
        if (applyBtn) applyBtn.addEventListener('click', () => {
            if (previewText && dom.articleInput) {
                applyImportedArticle(previewText, previewUrl
                    ? { sourceType: 'url', sourceUrl: previewUrl, title: previewTitle }
                    : { sourceType: 'paste' });
                try { ui.closeModal(); } catch (_) {}
                try { dom.articleInput.focus(); } catch (_) {}
                try { notifyAssistantArticleChanged(); } catch (_) {}
            }
        });
        if (aiCleanChk) aiCleanChk.addEventListener('change', () => LS.set(LS_KEYS.cleanEnabled, !!aiCleanChk.checked));
        if (keepImagesChk) keepImagesChk.addEventListener('change', () => LS.set(LS_KEYS.cleanKeepImages, !!keepImagesChk.checked));
        if (autoApplyChk) autoApplyChk.addEventListener('change', () => LS.set(LS_KEYS.cleanAutoApply, !!autoApplyChk.checked));
        if (modelSel) modelSel.addEventListener('change', () => persistArticleCleanupModel(modelSel.value));
    };

    const renderOcr = () => {
        panel.innerHTML = '';
        const wrap = document.createElement('div');
        const ocrSelection = getArticleOCRModelSelection();

        wrap.innerHTML = `
            <div class="import-form">
                <div class="form-row wrap">
                    <label for="imp-img" class="label">${t('article.chooseImages')}</label>
                    <div class="controls">
                        <input id="imp-img" type="file" accept="image/*" multiple class="import-file-input">
                        <div class="import-actions">
                            <label class="checkbox-inline"><input id="imp-prefer-camera" type="checkbox"> <span>${t('article.preferCamera')}</span></label>
                            <button id="imp-add-files" class="btn-secondary" type="button">${t('article.addImages')}</button>
                            <button id="imp-clear-files" class="btn-secondary" type="button">${t('article.clearImages')}</button>
                        </div>
                    </div>
                    <div class="controls right">
                        ${modelPickerHtml('imp-ocr-model', ocrSelection, t('article.ocrModel'))}
                    </div>
                </div>
                <div class="dropzone" id="imp-dropzone" aria-label="${t('article.dropImages')}">${t('article.dropImages')}</div>
                <div id="imp-ocr-thumbs" class="thumbs-grid" aria-live="polite"></div>
                <div class="form-row wrap">
                    <label for="imp-ocr-hint" class="label">${t('article.prompt')}</label>
                    <div class="controls">
                        <textarea id="imp-ocr-hint" rows="3" class="import-input" placeholder="${t('article.promptPlaceholder')}"></textarea>
                    </div>
                    <div class="controls right">
                        <button id="imp-ocr" class="btn-primary">${t('article.extractImageText')}</button>
                        <label class="checkbox-inline"><input id="imp-merge" type="checkbox" checked> <span>${t('article.mergeOutput')}</span></label>
                    </div>
                </div>
                <div id="imp-ocr-preview" class="import-preview" style="display:none;">
                    <div class="import-preview-head">${t('article.ocrPreview')}</div>
                    <pre id="imp-ocr-result" class="import-preview-body"></pre>
                    <div class="import-preview-actions"><button id="imp-ocr-apply" class="btn-primary">${t('article.applyInput')}</button></div>
                </div>
                <p class="import-hint">${t('article.ocrHint')}</p>
            </div>`;
        panel.appendChild(wrap);
        const $ = (sel) => wrap.querySelector(sel);
        const fileInput = $('#imp-img');
        const runBtn = $('#imp-ocr');
        const mergeChk = $('#imp-merge');
        const preferCam = $('#imp-prefer-camera');
        const addBtn = $('#imp-add-files');
        const clearBtn = $('#imp-clear-files');
        const modelSel = $('#imp-ocr-model');
        const hintInput = $('#imp-ocr-hint');
        const previewBox = $('#imp-ocr-preview');
        const resultPre = $('#imp-ocr-result');
        const applyBtn = $('#imp-ocr-apply');
        const dropzone = $('#imp-dropzone');
        const thumbs = $('#imp-ocr-thumbs');
        if (modelSel) modelSel.value = String(ocrSelection.value || '');

        // 內部檔案池（支援拖放/貼上）
        const selectedFiles = [];
        function refreshThumbs() {
            if (!thumbs) return;
            thumbs.innerHTML = '';
            selectedFiles.forEach((f, i) => {
                const url = URL.createObjectURL(f);
                const cell = document.createElement('div');
                cell.className = 'thumb-cell';
                cell.setAttribute('draggable', 'true');
                cell.dataset.index = String(i);
                cell.innerHTML = `<img src="${url}" alt="image ${i+1}"><button type="button" class="thumb-remove" data-i="${i}" aria-label="${t('article.remove')}">×</button>`;
                thumbs.appendChild(cell);
                cell.querySelector('.thumb-remove').addEventListener('click', () => {
                    selectedFiles.splice(i, 1);
                    refreshThumbs();
                });
                attachDnD(cell);
            });
        }
        // drag-and-drop reorder for thumbnails
        let dragIndex = -1;
        function attachDnD(el) {
            el.addEventListener('dragstart', (e) => {
                dragIndex = parseInt(el.dataset.index||'-1', 10);
                el.classList.add('dragging');
                try { e.dataTransfer.effectAllowed = 'move'; } catch(_) {}
            });
            el.addEventListener('dragend', () => { dragIndex = -1; el.classList.remove('dragging'); clearDropHighlights(); });
            el.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; el.classList.add('drop-target'); });
            el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
            el.addEventListener('drop', (e) => {
                e.preventDefault();
                el.classList.remove('drop-target');
                const to = parseInt(el.dataset.index||'-1', 10);
                if (dragIndex < 0 || to < 0 || dragIndex === to) return;
                const item = selectedFiles.splice(dragIndex, 1)[0];
                selectedFiles.splice(to, 0, item);
                refreshThumbs();
            });
        }
        function clearDropHighlights() { try { thumbs.querySelectorAll('.drop-target').forEach(n=>n.classList.remove('drop-target')); } catch(_) {}
        }
        function acceptFiles(list) {
            const arr = Array.from(list || []);
            let added = 0;
            arr.forEach(file => {
                if (!file || !file.type || !file.type.startsWith('image/')) return;
                selectedFiles.push(file);
                added++;
            });
            if (added) refreshThumbs();
        }

        if (fileInput) fileInput.addEventListener('change', () => { acceptFiles(fileInput.files); try { fileInput.value = ''; } catch(_){} });
        if (addBtn) addBtn.addEventListener('click', () => { fileInput && fileInput.click(); });
        if (clearBtn) clearBtn.addEventListener('click', () => { selectedFiles.splice(0, selectedFiles.length); refreshThumbs(); if (previewBox) previewBox.style.display = 'none'; if (resultPre) resultPre.textContent = ''; });

        // 拖放
        if (dropzone) {
            ;['dragenter','dragover','dragleave','drop'].forEach(ev => dropzone.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); }));
            dropzone.addEventListener('dragover', () => dropzone.classList.add('dragover'));
            dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
            dropzone.addEventListener('drop', (e) => {
                dropzone.classList.remove('dragover');
                acceptFiles(e.dataTransfer && e.dataTransfer.files);
            });
        }

        // 貼上剪貼簿
        wrap.addEventListener('paste', async (e) => {
            try {
                const items = Array.from((e.clipboardData && e.clipboardData.items) || []);
                const imgs = items.filter(it => it.kind === 'file' && /^image\//.test(it.type));
                if (!imgs.length) return;
                e.preventDefault();
                const files = await Promise.all(imgs.map(async it => {
                    const blob = it.getAsFile();
                    if (!blob) return null;
                    const name = `paste-${Date.now()}-${Math.random().toString(36).slice(2,8)}.${(blob.type.split('/')[1]||'png')}`;
                    try { return new File([blob], name, { type: blob.type }); } catch(_) { blob.name = name; return blob; }
                }));
                acceptFiles(files.filter(Boolean));
            } catch(_) {}
        });
        if (preferCam) {
            preferCam.addEventListener('change', () => {
                try {
                    if (preferCam.checked) fileInput.setAttribute('capture', 'environment');
                    else fileInput.removeAttribute('capture');
                } catch(_) {}
            });
        }
        if (applyBtn) applyBtn.addEventListener('click', () => {
            const text = (resultPre && resultPre.textContent) || '';
            if (text && dom.articleInput) {
                applyImportedArticle(text, { sourceType: 'ocr' });
                try { ui.closeModal(); } catch(_) {}
                try { dom.articleInput.focus(); } catch(_) {}
                // OCR 套用 → 通知助手切換上下文
                try { notifyAssistantArticleChanged(); } catch(_) {}
            }
        });
        // 點擊縮圖 → Lightbox 放大預覽（可左右切換）
        if (thumbs) {
            thumbs.addEventListener('click', (e) => {
                const img = e.target && e.target.tagName === 'IMG' ? e.target : null;
                if (!img) return;
                const imgs = Array.from(thumbs.querySelectorAll('img')).map(x => x.src);
                let idx = Math.max(0, imgs.indexOf(img.src));
                const overlay = document.createElement('div');
                overlay.className = 'lightbox-overlay';
                overlay.innerHTML = `<img src="${imgs[idx]}" alt="preview">`;
                const onClose = () => { document.removeEventListener('keydown', onKey); overlay.remove(); };
                const onKey = (ev) => {
                    if (ev.key === 'Escape') onClose();
                    else if (ev.key === 'ArrowLeft') { idx = (idx - 1 + imgs.length) % imgs.length; overlay.querySelector('img').src = imgs[idx]; }
                    else if (ev.key === 'ArrowRight') { idx = (idx + 1) % imgs.length; overlay.querySelector('img').src = imgs[idx]; }
                };
                overlay.addEventListener('click', onClose);
                document.addEventListener('keydown', onKey);
                document.body.appendChild(overlay);
            });
        }
        if (modelSel) modelSel.addEventListener('change', () => persistArticleOCRModel(modelSel.value));
        runBtn.addEventListener('click', async () => {
            const files = selectedFiles.length ? selectedFiles.slice() : Array.from(fileInput.files || []);
            if (!files.length) { ui.displayMessage(t('article.selectImagesFirst'), 'warning'); return; }
            runBtn.disabled = true; runBtn.textContent = t('article.extracting');
            try {
                const texts = [];
                for (const f of files) {
                    if (!f.type || !f.type.startsWith('image/')) continue;
                    const dataUrl = await fileToDataURL(f);
                    const resized = await downscaleImage(dataUrl, { maxW: 1600, maxH: 1600, quality: 0.9 });
                    const text = await api.ocrExtractTextFromImage(resized || dataUrl, { temperature: 0.0, promptHint: (hintInput && hintInput.value) || undefined, model: modelSel && modelSel.value });
                    texts.push(text || '');
                }
                const finalText = mergeChk.checked ? texts.join('\n\n') : texts.map((text, i) => `--- ${t('article.imageNumber', { number: i + 1 })} ---\n${text}`).join('\n\n');
                if (resultPre) resultPre.textContent = finalText.trim();
                if (previewBox) previewBox.style.display = 'block';
            } catch (e) {
                ui.displayMessage(t('article.ocrFailed', { message: e?.message || e }), 'error');
            } finally {
                runBtn.disabled = false; runBtn.textContent = t('article.extractImageText');
            }
        });
    };

    // 問答集導入分頁
    const renderQa = async () => {
        panel.innerHTML = '';
        const wrap = document.createElement('div');
        wrap.innerHTML = `
            <div class="import-form">
                <div class="form-row wrap">
                    <label class="label" for="qa-import-select">${t('article.selectQa')}</label>
                    <div class="controls">
                        <select id="qa-import-select" class="import-input"></select>
                        <button id="qa-import-apply" class="btn-primary" type="button">${t('article.importAsArticle')}</button>
                    </div>
                </div>
                <div id="qa-import-preview" class="import-preview hidden">
                    <div class="import-preview-head">${t('article.preview')}</div>
                    <pre id="qa-import-preview-body" class="import-preview-body"></pre>
                </div>
            </div>
        `;
        panel.appendChild(wrap);

        const select = wrap.querySelector('#qa-import-select');
        const applyBtn = wrap.querySelector('#qa-import-apply');
        const previewBox = wrap.querySelector('#qa-import-preview');
        const previewBody = wrap.querySelector('#qa-import-preview-body');

        // 載入所有問答集
        let list = [];
        try { list = await getAllQASets(); } catch(_) { list = []; }
        const collator = createCollator({ sensitivity: 'base' });
        list.sort((a, b) => collator.compare(a.name || '', b.name || ''));
        // 下拉選項
        (list || []).forEach(item => {
            const opt = document.createElement('option');
            opt.value = item.id;
            opt.textContent = `${item.name}${item.isPreset ? t('article.preset') : ''}`;
            select.appendChild(opt);
        });

        async function refreshPreview() {
            const id = select.value;
            if (!id) { previewBox.classList.add('hidden'); previewBody.textContent = ''; return; }
            const qaSet = await loadQASet(id);
            if (!qaSet) { previewBox.classList.add('hidden'); previewBody.textContent = ''; return; }
            const md = qaSetToMarkdownForArticle(qaSet);
            previewBody.textContent = md;
            previewBox.classList.remove('hidden');
        }

        select.addEventListener('change', refreshPreview);
        if (select.options.length) { select.selectedIndex = 0; refreshPreview(); }

        applyBtn.addEventListener('click', async () => {
            const id = select.value;
            if (!id) { ui.displayMessage(t('article.selectQaFirst'), 'warning'); return; }
            const qaSet = await loadQASet(id);
            if (!qaSet) { ui.displayMessage(t('article.loadQaFailed'), 'error'); return; }
            const md = qaSetToMarkdownForArticle(qaSet);
            applyImportedArticle(md, { sourceType: 'paste' });
            try { ui.closeModal(); } catch(_) {}
            try { dom.articleInput.focus(); } catch(_) {}
            try { notifyAssistantArticleChanged(); } catch(_) {}
        });
    };

    const activate = (name) => {
        btnUrl.classList.remove('active');
        btnNews.classList.remove('active');
        btnOcr.classList.remove('active');
        btnQa.classList.remove('active');
        if (name === 'news') { btnNews.classList.add('active'); renderNews(); }
        else if (name === 'ocr') { btnOcr.classList.add('active'); renderOcr(); }
        else if (name === 'qa') { btnQa.classList.add('active'); renderQa(); }
        else { btnUrl.classList.add('active'); renderUrl(); }
        try { localStorage.setItem('importArticle.activeTab', JSON.stringify(name)); } catch(_) {}
    };
    btnUrl.addEventListener('click', () => activate('url'));
    btnNews.addEventListener('click', () => activate('news'));
    btnOcr.addEventListener('click', () => activate('ocr'));
    btnQa.addEventListener('click', () => activate('qa'));
    try {
        const saved = JSON.parse(localStorage.getItem('importArticle.activeTab') || '"url"');
        if (saved === 'news') activate('news');
        else if (saved === 'ocr') activate('ocr');
        else if (saved === 'qa') activate('qa');
        else activate('url');
    } catch(_) { activate('url'); }

    try { dom.modalTitle.textContent = t('article.importModal'); } catch (_) {}
        ui.openModal();
}

// 將問答集轉為適合文章詳解的 Markdown
function qaSetToMarkdownForArticle(qaSet) {
    if (!qaSet || !Array.isArray(qaSet.questions)) return '';
    const header = `# ${qaSet.name || t('article.qaDefault')}\n\n` + (qaSet.description ? `${qaSet.description}\n\n` : '');
    // 不要用 `1. Q:` 這種 Markdown 有序清單寫法：文章詳解會把行首的「1.」判定成清單，
    // 因而關閉逐句翻譯；英文被切成「1.」「Q:」「A:」三句、中文只有兩句時就會綁錯譯句。
    // 改用 `Q1:` / `A1:` 標籤，保留題號，同時讓整段被視為普通散文走逐句對齊。
    const body = qaSet.questions.map((q, i) => {
        const num = i + 1;
        const qq = (q?.question || '').trim();
        const aa = (q?.answer || '').trim();
        return `Q${num}: ${qq}\nA${num}: ${aa}`;
    }).join('\n\n');
    return header + body + '\n';
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


// In-flight controller；段落快取只留 modules/api.js 的持久快取（含 locale／模型／版本身份）。
let currentAnalysisAbort = null;
let lastFailedIndices = [];
// Track per-paragraph timing (ms)
const paragraphStartTime = Object.create(null);
const paragraphElapsedMs = Object.create(null);

// --- Sentence analysis in-flight de-duplication ---
// 同一句子（在相同上下文）短時間內只發出一個請求，其餘共用同一 promise。
const _inflightSentenceMap = new Map(); // key: `${sentence}||${context}` -> Promise
const _analyzedSentenceKeys = new Set(); // 本次會話已完成分析的句子；hover 配對僅限此集合，避免 hover 觸發 AI 請求

function _sentenceKey(sentence, context) {
    return `${sentence}||${context || ''}`;
}

/** 由點擊的單詞元素推算原文位置；句子重複時不亂猜，交由 locate 判定。 */
function sentenceTextOf(element) {
    return ((element && (element.getAttribute('data-sentence') || element.textContent)) || '').trim();
}

/** 以 DOM 中相同句子的出現順序，推算它在原文中的起始 offset。 */
function sourceStartForSentence(sentenceEl) {
    if (!sentenceEl) return -1;
    const articleId = articleContext.recordId || '';
    const body = articleId ? (articleStore.getRecord(articleId)?.article || '') : '';
    const text = sentenceTextOf(sentenceEl);
    if (!body || !text) return -1;
    const same = Array.from(dom.articleAnalysisContainer.querySelectorAll('.interactive-sentence'))
        .filter((element) => sentenceTextOf(element) === text);
    const index = same.indexOf(sentenceEl);
    if (index < 0) return -1;
    const positions = [];
    let cursor = body.indexOf(text);
    while (cursor >= 0 && positions.length < 100) {
        positions.push(cursor);
        cursor = body.indexOf(text, cursor + Math.max(1, text.length));
    }
    return positions[index] ?? -1;
}

function sentenceOffsetOfElement(sentenceEl, node, offset = 0) {
    if (!sentenceEl || !node) return -1;
    try {
        const range = document.createRange();
        range.selectNodeContents(sentenceEl);
        range.setEnd(node, offset);
        return range.toString().length;
    } catch (_) {
        return -1;
    }
}

function anchorForWordElement(clickedElement, sentenceEl, quote) {
    const articleId = articleContext.recordId || '';
    const sentenceText = sentenceTextOf(sentenceEl);
    if (!articleId || !sentenceText || !clickedElement) {
        return readingActions.resolveAnchor(articleId, quote, sentenceText);
    }
    const sentenceStart = sourceStartForSentence(sentenceEl);
    const offset = sentenceOffsetOfElement(sentenceEl, clickedElement.firstChild || clickedElement, 0);
    const hint = sentenceStart >= 0 && offset >= 0 ? sentenceStart + offset : -1;
    return readingActions.resolveAnchor(articleId, quote, sentenceText, hint);
}

function analyzeSentenceDedupe(sentence, context = '', opts = {}) {
    const key = _sentenceKey(sentence, context);
    const existed = _inflightSentenceMap.get(key);
    if (existed) return existed;
    const p = api.analyzeSentence(sentence, context, opts)
        .then((data) => { try { _analyzedSentenceKeys.add(key); } catch (_) {} return data; })
        .finally(() => { try { _inflightSentenceMap.delete(key); } catch (_) {} });
    _inflightSentenceMap.set(key, p);
    return p;
}

// 以 Modal 呈現句子詳解（避免佔據版面與收合誤觸）
const USE_SENTENCE_MODAL = true;

// 句卡載入中：若中文側已有該句譯文（按句翻譯對齊產生），先顯示譯文再等 AI 詳解
function sentenceCardLoadingHtml(paraIdx, sentIdx) {
    let zh = '';
    try {
        const el = dom.articleAnalysisContainer.querySelector(`.interactive-sentence-zh[data-para-index="${paraIdx}"][data-sent-index="${sentIdx}"]`);
        zh = el ? (el.textContent || '').trim() : '';
    } catch (_) {}
    return zh
      ? `<div class="sentence-card-zh">${escapeHtml(zh)}</div><div class="sentence-card-loading">${t('article.loadingDetails')}</div>`
      : `<div class="sentence-card-loading">${t('article.loading')}</div>`;
}

// Merge helper: deduplicate detailed_analysis by key (word|sentence)
/**
 * 同一份原文重新分析時，保留使用者已保存的句子／短語解析。
 * 原文真的變更時不回填，避免把舊位置的解析當成新原文結果。
 */
export function mergePreservedReadingAnalysis(previousResult, nextResult, sameBody) {
    if (!sameBody || !previousResult) return nextResult;
    return {
        ...nextResult,
        sentence_analysis: Array.isArray(previousResult.sentence_analysis)
            ? previousResult.sentence_analysis
            : (nextResult.sentence_analysis || []),
        phrase_analysis: Array.isArray(previousResult.phrase_analysis)
            ? previousResult.phrase_analysis
            : (nextResult.phrase_analysis || [])
    };
}

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

/**
 * 非同步詳解寫回前重新確認：原帳戶、原文章、原正文版本仍一致，才可更新
 * legacy `result`（detailed_analysis／sentence_analysis／phrase_analysis）。
 * readingItem 仍可依請求時凍結的版本保存，但舊分析不得併入目前正文。
 */
function analysisWriteTargetCurrent(articleId, articleCtx, contentVersion, actionContext) {
    if (!articleId) return false;
    if (articleCtx && typeof articleStore.isArticleContextActive === 'function'
        && !articleStore.isArticleContextActive(articleCtx)) return false;
    if (actionContext && !readingActions.actionContextActive(actionContext)) return false;
    const record = articleStore.getRecord(articleId);
    if (!record || !record.result) return false;
    if (contentVersion !== undefined && contentVersion !== null
        && String(contentVersion) !== readingActions.articleVersion(articleId)) return false;
    return true;
}

function reportAnalysisSaveFailure(result) {
    if (!result || result.ok) return;
    // 帳戶／版本在等待期間切換是預期競態，不顯示「儲存失敗」打擾使用者。
    if (result.staleScope || result.staleVersion) return;
    ui.displayMessage(t('article.saveAnalysisFailed'), 'error');
}

/**
 * 詞／句／片語詳解都寫回「請求開始時」所屬的文章，而不是回應回來時的目前文章。
 * 目標文章已被刪除、帳戶切換或正文版本已變更時直接丟棄，不會污染新正文，
 * 也不會復活已刪除的記錄。
 */
function persistSentenceAnalysis(sentence, context, data, targetArticleId, articleCtx = null, options = {}) {
    const articleId = targetArticleId || articleContext.recordId;
    if (!articleId) return;
    const contentVersion = options.contentVersion === undefined ? null : options.contentVersion;
    const actionCtx = options.actionContext || null;
    if (!analysisWriteTargetCurrent(articleId, articleCtx, contentVersion, actionCtx)) return;
    const record = articleStore.getRecord(articleId);
    if (!record || !record.result) return;
    const arr = Array.isArray(record.result.sentence_analysis) ? record.result.sentence_analysis : [];
    const keyOf = (s, c) => `${_safeString(s).trim()}||${_safeString(c).trim()}`.toLowerCase();
    const next = [...arr];
    const normalized = { ...data, sentence, context, updatedAt: new Date().toISOString() };
    const idx = next.findIndex(x => keyOf(x.sentence, x.context || x._context) === keyOf(sentence, context));
    if (idx >= 0) next[idx] = normalized; else next.push(normalized);
    // 使用請求開始時的帳戶上下文：晚期回應不得寫進切換後的新帳戶。
    const saveOptions = { ...(articleCtx ? { ctx: articleCtx } : {}), expectContentVersion: contentVersion };
    articleStore.saveAnalysis(articleId, { ...record.result, sentence_analysis: next }, saveOptions)
        .then((result) => { if (!result.ok) console.warn('[article] 句子解析未能寫入本機:', result.error); reportAnalysisSaveFailure(result); })
        .catch(() => {});
}

function persistPhraseAnalysis(selection, sentence, context, data, targetArticleId, articleCtx = null, options = {}) {
    const articleId = targetArticleId || articleContext.recordId;
    if (!articleId) return;
    const contentVersion = options.contentVersion === undefined ? null : options.contentVersion;
    const actionCtx = options.actionContext || null;
    if (!analysisWriteTargetCurrent(articleId, articleCtx, contentVersion, actionCtx)) return;
    const record = articleStore.getRecord(articleId);
    if (!record || !record.result) return;
    const arr = Array.isArray(record.result.phrase_analysis) ? record.result.phrase_analysis : [];
    const keyOf = (sel, s, c) => `${_safeString(sel).trim()}||${_safeString(s).trim()}||${_safeString(c).trim()}`.toLowerCase();
    const next = [...arr];
    const normalized = { ...(data || {}), selection: data?.selection || selection, sentence, context, updatedAt: new Date().toISOString() };
    const idx = next.findIndex(x => keyOf(x.selection, x.sentence, x.context || x._context) === keyOf(normalized.selection, sentence, context));
    if (idx >= 0) next[idx] = normalized; else next.push(normalized);
    // 不再裁剪：永久層保留每個短語；顯示層可依需要只展示最近幾筆。
    const saveOptions = { ...(articleCtx ? { ctx: articleCtx } : {}), expectContentVersion: contentVersion };
    articleStore.saveAnalysis(articleId, { ...record.result, phrase_analysis: next }, saveOptions)
        .then((result) => { if (!result.ok) console.warn('[article] 片語解析未能寫入本機:', result.error); reportAnalysisSaveFailure(result); })
        .catch(() => {});
}

/**
 * 片語／選取短語：先讀本文永久記錄，再走既有 API 快取，最後才請求 AI。
 * 實際顯示成功時才記錄查閱；切走文章後的背景結果只保存解釋。
 */
async function analyzePhraseWithSaved(phrase, sentence, context, articleId, markViewed = true, options = {}) {
    // 片語查到哪個版本、哪個位置，必須由呼叫前凍結；回應回來後不重算。
    const version = options.contentVersion === undefined || options.contentVersion === null
        ? readingActions.articleVersion(articleId)
        : String(options.contentVersion);
    const anchor = options.anchor || readingActions.resolveAnchor(articleId, phrase, sentence);
    const actionContext = options.actionContext || readingActions.captureActionContext();
    const saved = readingActions.findSavedItem(articleId, 'phrase', phrase, sentence, { anchor, contentVersion: version })
        || readingActions.findSavedItem(articleId, 'word', phrase, sentence, { anchor, contentVersion: version });
    if (saved && saved.explanation && saved.explanation.result) {
        if (markViewed && readingActions.actionContextActive(actionContext)) readingStore.markLearningItemViewed(saved.id).catch(() => {});
        return saved.explanation.result;
    }
    const res = await api.analyzeSelection(phrase, sentence, context, { timeoutMs: 15000 });
    readingActions.recordExplanation({
        articleId,
        kind: /\s/.test(String(phrase || '').trim()) ? 'phrase' : 'word',
        quote: phrase,
        sentence,
        context,
        data: res,
        markViewed: markViewed && readingActions.actionContextActive(actionContext),
        anchor,
        contentVersion: version,
        actionContext
    }).catch(() => {});
    return res;
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

function normalizeInlineImages(text) {
    if (!text) return '';
    let t = String(text);
    // Pattern A: Same line — Image 3: alt text https://url
    t = t.replace(/(^|\n)\s*Image\s*\d*\s*:\s*([^\n]+?)\s+(https?:\/\/\S+)(?=\s|$)/gi, (m, p1, alt, url) => `${p1}![${alt.trim()}](${url.trim()})`);
    // Pattern B: Two lines — Image 3: alt text\nhttps://url
    t = t.replace(/(^|\n)\s*Image\s*\d*\s*:\s*([^\n]+?)\s*\n\s*(https?:\/\/\S+)(?=\s|$)/gi, (m, p1, alt, url) => `${p1}![${alt.trim()}](${url.trim()})`);
    // Pattern C: generic "Image:" without number
    t = t.replace(/(^|\n)\s*Image\s*:\s*([^\n]+?)\s+(https?:\/\/\S+)(?=\s|$)/gi, (m, p1, alt, url) => `${p1}![${alt.trim()}](${url.trim()})`);
    // Pattern D: Broken Markdown image across lines, e.g. "![\nImage 6(https://..)" or "![Image\n6(https...)" or with ']' missing
    t = t.replace(/!\[\s*([\s\S]*?)\s*\(\s*(https?:\/\/[^\s)]+)\s*\)/gi, (m, alt, url) => {
        const cleanAlt = String(alt || '').replace(/\]/g, ' ').replace(/\s+/g, ' ').trim();
        return `![${cleanAlt}](${url.trim()})`;
    });
    return t;
}

function parseTitleAndParagraphs(text) {
    const normalized = normalizeInlineImages(text || '');
    const lines = normalized.split(/\n/);
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

/**
 * 認出 `## 小標題` / `### 小標題` 這種 Markdown 標題段落。
 * 文章詳解原本只做「行內」渲染，`##` 會原樣顯示成文字，所以要在這裡先拆出來，
 * 交給 renderParagraph 用標題樣式呈現。
 */
function splitMarkdownHeading(text) {
    const m = String(text || '').trim().match(/^(#{1,6})\s+([\s\S]+)$/);
    if (!m) return null;
    const heading = m[2].trim();
    if (!heading) return null;
    return { level: Math.min(6, m[1].length), text: heading };
}

/**
 * 整段都是 Markdown 清單項目（`- x` / `1. x`）時回 true。
 * 文章詳解只做行內渲染，清單的 `- ` 會原樣顯示，所以要單獨處理。
 */
function isMarkdownListBlock(text) {
    const lines = String(text || '').split('\n').filter(l => l.trim());
    return lines.length > 0 && lines.every(l => /^\s*(?:[-*+]|\d+[.)])\s+\S/.test(l));
}

// 顯示用：把清單標記換成圓點（有序清單保留編號），其餘文字不動。
function normalizeListMarkersForDisplay(text) {
    return String(text || '').split('\n').map((line) => {
        const m = line.match(/^\s*(?:[-*+]|(\d+)[.)])\s+/);
        if (!m) return line;
        return m[1] ? `${m[1]}. ${line.slice(m[0].length)}` : `• ${line.slice(m[0].length)}`;
    }).join('\n');
}

/**
 * 送翻譯前的清理：圖片只留 alt、連結只留文字，但**保留粗體／斜體標記**。
 * 舊版送翻譯前會把 `**粗體**` 一起剝掉，導致譯文整段沒有加粗；
 * 提示詞本來就要求「保留 Markdown 標記」，這裡把標記留著才有東西可保留。
 */
// 翻譯前的文字清理只留一份實作（paragraph-pipeline.js），顯示與請求共用。
const prepareParagraphForTranslation = paragraphPipeline.prepareParagraphForTranslation;

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

// escapeHtml / escapeAttr 由 modules/ui.js 統一提供（站內只留一份 HTML 轉義實作）；
// 這個檔案原本另外自己宣告了一份同名函式，兩份長期容易走鐘。

/** 只在 HTML 的文字片段做替換，避免動到標籤本身或屬性內容 */
function replaceOutsideTags(html, regex, replacer) {
    return String(html).split(/(<[^>]*>)/).map((seg) => (seg.charAt(0) === '<' ? seg : seg.replace(regex, replacer))).join('');
}

/** 句子要顯示的 HTML（行內 Markdown），表格之類沒有後續包字流程的地方再自行包 token */
function sentenceInlineHtml(text) {
    return inlineMarkdownToHtml(text);
}

// Return HTML that wraps words in a string with <span class="interactive-word" ...>
// 只包 token，不改文字內容；offset 直接取自 segmentWords，錨點仍對回原文。
// 文章查詞以拉丁字詞為主：純 CJK 原文沿用舊行為，不把每個漢字都變成查詞入口。
const LOOKUP_WORD_RE = /\p{Script=Latin}/u;
const isLookupWord = (word) => LOOKUP_WORD_RE.test(word);

function wrapWordsInTextHTML(text, { locale = 'en' } = {}) {
    const source = String(text == null ? '' : text);
    if (!source) return '';
    const tokens = segmentWords(source, { locale }).filter(({ word }) => isLookupWord(word));
    if (!tokens.length) return escapeHtml(source);
    let out = '';
    let idx = 0;
    tokens.forEach(({ word, start, end }) => {
        if (start > idx) out += escapeHtml(source.slice(idx, start));
        const escW = escapeHtml(word);
        out += `<span class=\"interactive-word\" data-word=\"${escW}\">${escW}</span>`;
        idx = end;
    });
    if (idx < source.length) out += escapeHtml(source.slice(idx));
    return out;
}

// 句末解析鍵的圖示（線性 sprite 風格的圓形 i）與說明文字
const SENT_ANALYZE_ICON_PATH = 'M8 1a7 7 0 1 1 0 14A7 7 0 0 1 8 1zm0 1.5A5.5 5.5 0 1 0 8 13.5 5.5 5.5 0 0 0 8 2.5zm.93 3.412a1.5 1.5 0 0 0-2.83.588h1.005c0-.356.29-.64.652-.64.316 0 .588.212.588.53 0 .255-.127.387-.453.623-.398.29-.87.654-.87 1.29v.255h1V8c0-.254.128-.387.454-.623.398-.29.87-.654.87-1.29 0-.364-.146-.706-.416-.935zM8 10.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5z';

/** 句首片段：供 aria-label 與解析鍵名稱使用（不翻譯原文）。 */
function sentenceSnippet(text, max = 40) {
    const flat = String(text || '').replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 句子可操作名稱：句首片段＋「句子解析」，兩語共用同一套組合。 */
function sentenceAriaLabel(text) {
    const snippet = sentenceSnippet(text);
    const label = t('article.sentenceAnalysis');
    return snippet ? `${snippet} · ${label}` : label;
}

/** locale 切換後重套句子與解析鍵的動態 aria-label。 */
function refreshSentenceAccessibility() {
    const container = dom.articleAnalysisContainer;
    if (!container) return;
    container.querySelectorAll('.interactive-sentence').forEach((el) => {
        const sentence = el.getAttribute('data-sentence') || el.textContent || '';
        el.setAttribute('aria-label', sentenceAriaLabel(sentence));
    });
    container.querySelectorAll('.sent-analyze-btn').forEach((btn) => {
        const sentenceEl = btn.closest('.sentence-wrap')?.querySelector('.interactive-sentence');
        const sentence = sentenceEl?.getAttribute('data-sentence') || '';
        btn.setAttribute('aria-label', sentenceAriaLabel(sentence));
    });
}

/**
 * 句末解析鍵：內嵌在句子結尾（inline），不再絕對定位漂在段落右緣。
 * 只留 aria-label，不用 title，避免原生 tooltip 與站內浮動提示重複。
 */
function sentenceAnalyzeButtonHtml(paraIdx, sentIdx, sentence = '') {
    const label = escapeAttr(sentenceAriaLabel(sentence));
    return `<button class="sent-analyze-btn icon-only" data-para-index="${paraIdx}" data-sent-index="${sentIdx}" aria-expanded="false" aria-label="${label}">`
        + `<svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="${SENT_ANALYZE_ICON_PATH}"/></svg>`
        + `</button>`;
}

/** 把英文句與其解析鍵包成 sentence-wrap，句子本體隨段落自然斷行 */
function sentenceWrapHtml(paraIdx, sentIdx, sentence, innerHtml) {
    return `<span class="sentence-wrap">`
        + `<span class="interactive-sentence" tabindex="0" role="button" aria-expanded="false" aria-label="${escapeAttr(sentenceAriaLabel(sentence))}" data-para-index="${paraIdx}" data-sent-index="${sentIdx}" data-sentence="${escapeAttr(sentence)}" data-article-id="${escapeAttr(articleContext.recordId || '')}">${innerHtml}</span>`
        + sentenceAnalyzeButtonHtml(paraIdx, sentIdx, sentence)
        + `</span>`;
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
            const inner = sentenceWrapHtml(paraIdx, sIdx, sentence, replaceOutsideTags(sentenceInlineHtml(sentence), /[A-Za-z][A-Za-z'’-]*/g, (w) => `<span class="interactive-word" data-word="${escapeAttr(w)}">${w}</span>`));
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

// Markdown 圖片判定與中文原文判定集中在 analysis-state.js，避免顯示、朗讀與快取各有一套。
const stripMarkdownImagesFromText = paragraphPipeline.stripMarkdownImagesFromText;

// If a paragraph consists solely of image lines (and blank lines), render them as <img> blocks
function renderMarkdownImagesPairHTML(engText, zhText) {
    const toLines = (text) => String(text || '').split(/\n/).map(l => l.trim()).filter(l => l.length > 0);
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
            const esc = escapeHtml;
            const a = esc(alt);
            const u = esc(url);
            return `<div class=\"md-image\"><img src=\"${u}\" alt=\"${a}\" loading=\"lazy\" referrerpolicy=\"no-referrer\"></div>`;
        });
        return `<div class=\"md-images\">${blocks.join('')}</div>`;
    };

    return { eng: toHTML(engImgs), zh: toHTML(zhImgs) };
}

/**
 * 把一個段落交給 pipeline：清理文字、決定是否跳過、準備按句翻譯的句子。
 * 主分析與兩種重試都走這裡，避免「中文／圖片／空結果」在三個地方各寫一次。
 */
function runParagraphRequest(text, options = {}) {
    const baseText = prepareParagraphForTranslation(stripMarkdownImagesFromText(text)) || text;
    const sentences = isPlainProseParagraph(baseText) ? sentenceSplit(baseText) : [];
    return paragraphPipeline.requestParagraphAnalysis({
        text,
        aiText: baseText,
        sentences,
        isSourceChinese: isPredominantlyChinese(baseText),
        isImageParagraph: isPureMarkdownImageParagraph(text),
        ...options
    });
}

/** 目前正文的段落清單（含標題），順序與分析結果一致。 */
function currentParagraphTexts(articleText) {
    const { title, paragraphs } = parseTitleAndParagraphs(articleText || '');
    return title ? [title, ...paragraphs] : paragraphs;
}

/** 逐段重試鈕的可用狀態只由「版本」與「該段是否仍有工作」決定。 */
function updateParagraphButtonState(btn) {
    if (!btn) return;
    const index = Number(btn.dataset.index);
    const hasIndex = Number.isInteger(index);
    const stale = isArticleViewStale();
    const busy = hasIndex && (isParagraphBusy(index) || isBatchRetryActive());
    btn.disabled = stale || busy;
    if (stale) {
        btn.setAttribute('aria-disabled', 'true');
        btn.setAttribute('title', t('article.retryNeedsReanalyze'));
    } else {
        btn.removeAttribute('aria-disabled');
        btn.removeAttribute('title');
    }
    if (busy) btn.setAttribute('aria-busy', 'true');
    else btn.removeAttribute('aria-busy');
}

/** 批次重試按鈕的隱藏、段數與 aria-label 只由這一個函式決定。 */
function updateRetryFailedButton() {
    const btn = dom.retryFailedParagraphsBtn;
    const count = Array.isArray(lastFailedIndices) ? lastFailedIndices.length : 0;
    const stale = isArticleViewStale();
    const batchBusy = isBatchRetryActive();
    if (btn) {
        btn.classList.toggle('hidden', count === 0);
        btn.disabled = count === 0 || stale || batchBusy;
        const label = stale
            ? t('article.retryNeedsReanalyze')
            : (count > 0 ? t('article.retryFailedCount', { count }) : t('article.retryFailed'));
        btn.setAttribute('aria-label', label);
        if (stale) btn.setAttribute('title', t('article.retryNeedsReanalyze'));
        else btn.removeAttribute('title');
        if (batchBusy) btn.setAttribute('aria-busy', 'true');
        else btn.removeAttribute('aria-busy');
    }
    const badge = dom.retryFailedCount || document.getElementById('retry-failed-count');
    if (badge) {
        badge.textContent = String(count);
        badge.classList.toggle('hidden', count === 0);
    }
}

/**
 * 原文版本提示（P1-T6）：畫面保留舊譯文，但明示已落後，並停用重試。
 * 只更新 banner 與按鈕狀態，不重建分析 DOM，避免輸入時整頁閃動。
 */
function updateArticleVersionState() {
    const stale = isArticleViewStale();
    const notice = dom.articleVersionNotice;
    if (notice) notice.classList.toggle('hidden', !stale);
    if (dom.articleAnalysisContainer) {
        dom.articleAnalysisContainer.classList.toggle('is-stale-analysis', stale);
    }
    dom.articleAnalysisContainer?.querySelectorAll('.retry-paragraph-btn').forEach(updateParagraphButtonState);
    updateRetryFailedButton();
    return stale;
}

/**
 * 真正的 IndexedDB 交易失敗時，`article-store.saveAnalysis` 仍會更新記憶體結果。
 * 這些段落若直接從記憶體重算，就會出現「畫面失敗、摘要 0 段、重試入口消失」（P1-1）。
 * 因此以「實際保存結果」為準：保存失敗的段落登記在這裡，讓失敗數、重試入口與
 * 歷史列都使用同一個來源；重新載入後磁碟仍是舊狀態，兩邊才會一致。
 */
const unsavedParagraphs = new Map(); // `${articleId}\n${contentVersion}` -> Map<index, result>

function unsavedParagraphKey(articleId, contentVersion) {
    return `${articleId || ''}\n${contentVersion || ''}`;
}

function markParagraphsUnsaved(articleId, contentVersion, entries) {
    if (!articleId) return;
    const key = unsavedParagraphKey(articleId, contentVersion);
    let bucket = unsavedParagraphs.get(key);
    if (!bucket) {
        bucket = new Map();
        unsavedParagraphs.set(key, bucket);
    }
    entries.forEach(([index, result]) => bucket.set(Number(index), result || null));
}

/** 一次成功保存會寫入整份記錄；此時可清掉全部，或只清指定段落。 */
function clearParagraphsUnsaved(articleId, contentVersion, indexes = null) {
    const key = unsavedParagraphKey(articleId, contentVersion);
    const bucket = unsavedParagraphs.get(key);
    if (!bucket) return;
    if (!indexes) {
        unsavedParagraphs.delete(key);
        return;
    }
    indexes.forEach((index) => bucket.delete(Number(index)));
    if (!bucket.size) unsavedParagraphs.delete(key);
}

function unsavedParagraphIndices(articleId, contentVersion) {
    const bucket = unsavedParagraphs.get(unsavedParagraphKey(articleId, contentVersion));
    return bucket ? Array.from(bucket.keys()).sort((a, b) => a - b) : [];
}

function unsavedParagraphResult(articleId, contentVersion, index) {
    return unsavedParagraphs.get(unsavedParagraphKey(articleId, contentVersion))?.get(Number(index)) || null;
}

/** 記錄層面的失敗段：記錄中失敗的段落 ＋ 尚未成功保存的段落（去重）。 */
function failedIndicesForRecord(record) {
    if (!record?.result) return [];
    const { title, paragraphs } = parseTitleAndParagraphs(record.article || '');
    const list = title ? [title, ...paragraphs] : paragraphs;
    const base = failedIndicesFromResult(record.result, list);
    const unsaved = unsavedParagraphIndices(record.articleId, readingActions.articleVersion(record.articleId));
    return Array.from(new Set([...base, ...unsaved])).sort((a, b) => a - b);
}

/** 畫面目前這篇是否有「分析已顯示但尚未保存」的明確失敗狀態。 */
function currentAnalysisSaveFailure() {
    const record = articleContext.recordId ? articleStore.getRecord(articleContext.recordId) : null;
    return analysisSaveFailureFor(record);
}

/** 從目前記錄重新推導失敗段（畫面與按鈕共用同一份來源）。 */
function refreshFailedStateFromRecord() {
    const record = articleContext.recordId ? articleStore.getRecord(articleContext.recordId) : null;
    lastFailedIndices = failedIndicesForRecord(record);
    updateRetryFailedButton();
    return lastFailedIndices;
}

/**
 * 同一篇文章＋同一內容版本的分析保存佇列（F1）。
 *
 * 單段／批次重試各自只持有自己那幾段的 patch，但 `articleStore.saveAnalysis`
 * 一次寫入整份 `paragraph_analysis`。若兩個工作都先用舊快照組好整份結果再排隊，
 * 後寫者會把先寫者的段落蓋回去（lost update）。這裡以 articleId + contentVersion
 * 為 scope 序列化保存；每個任務真正提交前才讀最新記錄並合併仍持有的 patch。
 * key 含版本，因此不同文章／不同版本不會互相阻塞。
 */
const analysisSaveQueues = new Map();

function analysisSaveScopeKey(articleId, contentVersion) {
    return `${articleId || ''}\n${contentVersion || ''}`;
}

function queueAnalysisSave(articleId, contentVersion, task) {
    const key = analysisSaveScopeKey(articleId, contentVersion);
    const previous = analysisSaveQueues.get(key) || Promise.resolve();
    // 前一個任務失敗也要讓下一個任務繼續，否則單段失敗會卡住整篇文章的保存。
    const run = previous.catch(() => null).then(task);
    const tail = run.then(() => null, () => null);
    analysisSaveQueues.set(key, tail);
    tail.then(() => {
        if (analysisSaveQueues.get(key) === tail) analysisSaveQueues.delete(key);
    });
    return run;
}

/**
 * 整篇分析最後一次保存失敗的明確狀態（F3）。
 * 交易失敗時結果仍在記憶體與畫面上，但磁碟沒有；必須保留「未保存」提示與
 * 重試保存入口，不能讓歷史指示器把它覆蓋成「已存入」。
 */
const analysisSaveFailures = new Map(); // articleId -> failure payload

function rememberAnalysisSaveFailure(articleId, payload) {
    if (!articleId) return;
    analysisSaveFailures.set(articleId, { ...payload, articleId });
}

function clearAnalysisSaveFailure(articleId) {
    if (!articleId) return;
    analysisSaveFailures.delete(articleId);
}

/**
 * 把單段的新結果同步回「完整分析未保存」快照。
 * 快照保留的是整篇最後保存失敗當下的 finalResult；若之後單段刷新或批次重試成功，
 * 快照仍是舊值，按「重試保存」就會把剛寫入的新結果蓋回舊譯文（F6）。
 * 只更新同文章、同版本、同 index 的段落；任何異常都不得中斷已成功的保存流程。
 */
function syncAnalysisSaveFailureParagraph(articleId, contentVersion, index, result) {
    try {
        if (!articleId || !result) return;
        const failure = analysisSaveFailures.get(articleId);
        if (!failure) return;
        // 版本不同代表快照屬於舊原文：寧可保留舊快照，也不得跨版本污染。
        if (failure.contentVersion !== contentVersion) return;
        const paragraphs = failure.result?.paragraph_analysis;
        if (!Array.isArray(paragraphs)) return;
        const idx = Number(index);
        if (!Number.isInteger(idx) || idx < 0 || idx >= paragraphs.length) return;
        const nextParagraphs = [...paragraphs];
        nextParagraphs[idx] = result;
        analysisSaveFailures.set(articleId, {
            ...failure,
            result: {
                ...failure.result,
                paragraph_analysis: nextParagraphs,
                detailed_analysis: mergeDetailedAnalyses(
                    failure.result?.detailed_analysis || [],
                    result?.detailed_analysis || []
                )
            }
        });
    } catch (error) {
        // 同步失敗只影響重試保存的新鮮度，保存本身已經成功，不得回報失敗。
        console.warn('sync analysis save snapshot failed', error);
    }
}

function analysisSaveFailureFor(record) {
    if (!record?.articleId) return null;
    const failure = analysisSaveFailures.get(record.articleId);
    if (!failure) return null;
    const version = contentVersionOfText(record.article || '');
    if (failure.contentVersion && version && failure.contentVersion !== version) return null;
    return failure;
}

/** 保存失敗提示列：保留目前分析畫面，只額外提供「重試保存」入口。 */
function renderAnalysisSaveFailure(record) {
    const container = dom.articleAnalysisContainer;
    if (!container) return;
    container.querySelector('.analysis-save-failure')?.remove();
    const failure = analysisSaveFailureFor(record);
    if (!failure) return;
    const el = document.createElement('div');
    el.className = 'analysis-save-failure';
    el.setAttribute('role', 'status');
    el.innerHTML = `
        <div class="analysis-save-failure__body">
            <strong class="analysis-save-failure__title">${escapeHtml(t('article.analysisSavePendingTitle'))}</strong>
            <span class="analysis-save-failure__hint">${escapeHtml(t('article.analysisSavePendingHint'))}</span>
        </div>
        <button type="button" class="btn-ghost btn-mini analysis-save-retry">${escapeHtml(t('article.retrySaveAnalysis'))}</button>`;
    el.querySelector('.analysis-save-retry')?.addEventListener('click', retryPendingAnalysisSave);
    container.prepend(el);
}

function refreshAnalysisSaveFailureTexts() {
    const el = dom.articleAnalysisContainer?.querySelector('.analysis-save-failure');
    if (!el) return;
    const title = el.querySelector('.analysis-save-failure__title');
    const hint = el.querySelector('.analysis-save-failure__hint');
    const btn = el.querySelector('.analysis-save-retry');
    if (title) title.textContent = t('article.analysisSavePendingTitle');
    if (hint) hint.textContent = t('article.analysisSavePendingHint');
    if (btn) btn.textContent = t('article.retrySaveAnalysis');
}

let pendingSaveRetryActive = false;

/** 只重試保存，不重新呼叫 AI；失敗時保留提示列與可再按的入口。 */
async function retryPendingAnalysisSave() {
    if (pendingSaveRetryActive) return;
    const record = articleContext.recordId ? articleStore.getRecord(articleContext.recordId) : null;
    const failure = analysisSaveFailureFor(record);
    if (!failure) return;
    pendingSaveRetryActive = true;
    const btn = dom.articleAnalysisContainer?.querySelector('.analysis-save-retry');
    if (btn) {
        btn.disabled = true;
        btn.setAttribute('aria-busy', 'true');
    }
    try {
        const saved = await queueAnalysisSave(failure.articleId, failure.contentVersion, async () => {
            // 佇列等待期間可能已切換文章或改版：不得把舊結果寫進新版本。
            if (!isCurrentArticle(failure.articleId)) return { ok: false, error: 'stale_job' };
            if (contentVersionOfText(articleStore.getRecord(failure.articleId)?.article || '') !== failure.contentVersion) {
                return { ok: false, error: 'stale_version' };
            }
            return articleStore.saveArticle({
                articleId: failure.articleId,
                article: failure.article,
                result: failure.result,
                title: failure.title,
                sourceType: failure.sourceType,
                sourceUrl: failure.sourceUrl
            });
        });
        if (!saved.ok) {
            if (isCurrentArticle(failure.articleId)) {
                ui.displayMessage(t('article.analysisSaveFailedInline'), 'error', 6000);
            }
            return;
        }
        clearAnalysisSaveFailure(failure.articleId);
        clearParagraphsUnsaved(failure.articleId, failure.contentVersion);
        if (isCurrentArticle(failure.articleId)) {
            renderAnalysisSaveFailure(articleStore.getRecord(failure.articleId));
            updateHistoryIndicators();
            ui.displayMessage(t('article.analysisSaveRecovered'), 'success', 2400);
        }
    } finally {
        pendingSaveRetryActive = false;
        if (isCurrentArticle(failure.articleId)) {
            refreshAnalysisSaveFailureTexts();
            const current = dom.articleAnalysisContainer?.querySelector('.analysis-save-retry');
            if (current) {
                current.disabled = false;
                current.removeAttribute('aria-busy');
            }
        }
    }
}

/**
 * 把單段結果合併回最新記錄並保存。
 * `canCommit` 在真正提交前再次核對工作所有權；排隊等待期間若工作已被取消／
 * 換段，這裡就不會再寫入任何內容。
 * 回傳 `{ ok, error, applied }`；呼叫端必須在 ok 之後才把狀態改成 done／閃成功。
 */
async function persistParagraphResult({ articleId, index, result, contentVersion, canCommit }) {
    if (!articleId) return { ok: false, error: 'record_missing' };
    return queueAnalysisSave(articleId, contentVersion, async () => {
        if (typeof canCommit === 'function' && !canCommit()) return { ok: false, error: 'stale_job' };
        const record = articleStore.getRecord(articleId);
        if (!record) return { ok: false, error: 'record_missing' };
        if (contentVersion && readingActions.articleVersion(articleId) !== contentVersion) {
            return { ok: false, error: 'stale_version' };
        }
        const ctx = articleStore.captureArticleContext();
        const paragraphAnalysis = Array.isArray(record.result?.paragraph_analysis)
            ? [...record.result.paragraph_analysis]
            : [];
        paragraphAnalysis[index] = result;
        const updated = {
            ...(record.result || {}),
            paragraph_analysis: paragraphAnalysis,
            detailed_analysis: mergeDetailedAnalyses(
                record.result?.detailed_analysis || [],
                result?.detailed_analysis || []
            )
        };
        const saved = await articleStore.saveAnalysis(articleId, updated, {
            ctx,
            expectContentVersion: contentVersion || undefined
        });
        // 單段結果已落盤：同步完整分析快照，避免「重試保存」用舊快照蓋回去（F6）。
        if (saved.ok) syncAnalysisSaveFailureParagraph(articleId, contentVersion, index, result);
        return { ok: !!saved.ok, error: saved.error || '', applied: [index] };
    });
}

/** 批次重試的結果摘要（留在畫面上，不只用 3 秒 toast）。 */
let lastBatchSummary = null;

function renderBatchSummaryText() {
    if (!lastBatchSummary) return;
    const el = dom.articleAnalysisContainer?.querySelector('.analysis-batch-summary');
    if (!el) return;
    el.textContent = t('article.retrySummary', lastBatchSummary);
}

function showBatchSummary({ done, failed }) {
    const container = dom.articleAnalysisContainer;
    if (!container) return;
    lastBatchSummary = { done, failed };
    let el = container.querySelector('.analysis-batch-summary');
    if (!el) {
        el = document.createElement('div');
        el.className = 'analysis-batch-summary';
        container.prepend(el);
    }
    renderBatchSummaryText();
}

function clearBatchSummary() {
    lastBatchSummary = null;
    dom.articleAnalysisContainer?.querySelector('.analysis-batch-summary')?.remove();
}

/**
 * 語言切換時重新套用動態文案（P2-5）：狀態文字、失敗原因、重試按鈕與批次摘要
 * 都是執行時才產生的節點，`data-i18n` 不會處理，必須保留狀態後重新 t()。
 */
function refreshParagraphDynamicTexts() {
    const container = dom.articleAnalysisContainer;
    if (!container) return;
    container.querySelectorAll('.para-status').forEach((statusDiv) => {
        const status = statusDiv.dataset.status || '';
        if (!status) return;
        const textSpan = statusDiv.querySelector('.status-text');
        if (textSpan) textSpan.textContent = t(paragraphStatusLabelKey(status));
        const reasonSpan = statusDiv.querySelector('.para-reason');
        if (reasonSpan && status === PARAGRAPH_STATUS.failed) {
            reasonSpan.textContent = t('article.paragraphFailureReason', {
                message: t(paragraphErrorLabelKey(statusDiv.dataset.errorCode || ''))
            });
        }
        const retryBtn = statusDiv.querySelector('.retry-paragraph-btn');
        if (retryBtn && retryBtn.style.display !== 'none') {
            retryBtn.textContent = status === PARAGRAPH_STATUS.done
                ? t('article.refresh')
                : t('article.retryParagraph');
        }
    });
    container.querySelectorAll('.analysis-failed-inline').forEach((el) => {
        el.textContent = t('article.analysisFailedInline');
    });
    container.querySelectorAll('.source-language-note').forEach((el) => {
        el.textContent = t('article.sourceAlreadyChinese');
    });
    refreshAnalysisSaveFailureTexts();
    renderBatchSummaryText();
}

/** 重試前確認輸入框版本與記錄一致；不一致時要求先重新分析。 */
function retryTargetsCurrentVersion(record) {
    const input = String(dom.articleInput?.value || '').trim();
    const body = String(record?.article || '').trim();
    return !!body && input === body;
}

// ─────────────────────────────────────────────────────────────────────────────
// 逐段 checkpoint 與未完成分析續作（P3-T1）
//
// `result.analysis_run` 是 additive 欄位：沒有它或格式不符時，畫面與歷史列完全
// 回到 Phase 1 的「失敗段＋批次重試」行為。checkpoint 只更新記憶體與持久層
// （saveAnalysis 的 silent），不觸發歷史列重繪；最終保存才發變更事件。
//
// 未完成段在 checkpoint 中保留為 null（維持 total 長度），顯示與統計必須把 null
// 視為「尚未完成」，不得算成失敗。`settings.reading.analysisCheckpoint === false`
// 時整段流程停用，只在最後保存一次。
// ─────────────────────────────────────────────────────────────────────────────
const ANALYSIS_CHECKPOINT_DEBOUNCE_MS = 1200;
let checkpointEpoch = 0;

function analysisCheckpointEnabled() {
    try {
        const settings = loadGlobalSettings();
        return !(settings && settings.reading && settings.reading.analysisCheckpoint === false);
    } catch (_) {
        return true;
    }
}

function analysisCheckpointNoteElement() {
    return dom.articleCheckpointNote || document.getElementById('article-checkpoint-note');
}

/** checkpoint 寫入失敗：只提示，不中斷分析，也不把狀態改成失敗。 */
function showAnalysisCheckpointFailure() {
    const el = analysisCheckpointNoteElement();
    if (!el) return;
    el.hidden = false;
    el.classList.remove('hidden');
    el.dataset.tone = 'error';
    el.textContent = t('article.analysisCheckpointFailed');
}

function clearAnalysisCheckpointFailure() {
    const el = analysisCheckpointNoteElement();
    if (!el) return;
    el.classList.add('hidden');
    el.hidden = true;
    el.dataset.tone = '';
    el.textContent = '';
}

function hideAnalysisResumeBanner() {
    if (dom.articleAnalysisResume) dom.articleAnalysisResume.classList.add('hidden');
}

function showAnalysisResumeBanner(run) {
    if (!dom.articleAnalysisResume || !run) return;
    if (dom.articleAnalysisResumeStatus) {
        dom.articleAnalysisResumeStatus.textContent = t('article.analysisPartial', {
            // 「已保存」只算處理成功（含跳過）的段落；failed 段落仍需續作。
            done: Math.max(0, run.completed - run.failed),
            total: run.total
        });
    }
    dom.articleAnalysisResume.classList.remove('hidden');
}

/** 語言切換時，執行期產生的 checkpoint 提示與續作狀態要重新 t()。 */
function refreshAnalysisCheckpointTexts() {
    const note = analysisCheckpointNoteElement();
    if (note && !note.classList.contains('hidden')) {
        note.textContent = t('article.analysisCheckpointFailed');
    }
    if (dom.articleAnalysisResume && !dom.articleAnalysisResume.classList.contains('hidden')) {
        const record = articleContext.recordId ? articleStore.getRecord(articleContext.recordId) : null;
        const run = normalizeAnalysisRun(record?.result?.analysis_run);
        if (run && dom.articleAnalysisResumeStatus) {
            dom.articleAnalysisResumeStatus.textContent = t('article.analysisPartial', {
                done: Math.max(0, run.completed - run.failed),
                total: run.total
            });
        }
    }
}

function createAnalysisCheckpoint({ run, articleId, contentVersion, runMeta, paragraphAnalyses, previousResult }) {
    return {
        enabled: analysisCheckpointEnabled(),
        epoch: checkpointEpoch,
        run,
        articleId,
        contentVersion,
        ctx: articleStore.captureArticleContext(),
        runMeta,
        paragraphAnalyses,
        previousResult: previousResult || null,
        timer: 0,
        chain: Promise.resolve(),
        finalizing: false,
        finalSaved: false,
        finalStatus: '',
        lastCheckpointError: '',
        disabledByLimit: false
    };
}

/** 以目前完整段落結果＋analysis_run 組成 checkpoint 要寫入的 result。 */
function buildCheckpointResult(cp, status, baseResult) {
    const analyses = cp.paragraphAnalyses || [];
    const total = analyses.length;
    const paragraphAnalysis = new Array(total).fill(null);
    for (let i = 0; i < total; i += 1) {
        if (analyses[i] !== undefined && analyses[i] !== null) paragraphAnalysis[i] = analyses[i];
    }
    const stats = analysisRunStats(paragraphAnalysis);
    const runMeta = {
        ...(cp.runMeta || {}),
        schemaVersion: 1,
        status: status || ANALYSIS_RUN_STATUS.running,
        total,
        completed: stats.completed,
        failed: stats.failed,
        updatedAt: new Date().toISOString(),
        lastErrorCode: cp.lastCheckpointError ? 'checkpoint_failed' : ''
    };
    cp.runMeta = runMeta;
    const base = baseResult || cp.previousResult || {};
    return {
        ...base,
        chinese_translation: paragraphAnalysis.map((item) => (item && item.chinese_translation) || '').join('\n\n'),
        word_alignment: paragraphAnalysis.flatMap((item) => (item && item.word_alignment) || []),
        detailed_analysis: mergeDetailedAnalyses(
            paragraphAnalysis.flatMap((item) => (item && item.detailed_analysis) || []),
            base.detailed_analysis || []
        ),
        paragraph_analysis: paragraphAnalysis,
        analysis_run: runMeta,
        updatedAt: runMeta.updatedAt
    };
}

/**
 * 真正寫入一次 checkpoint（同一 checkpoint 的呼叫由 chain 序列化）。
 * 排隊等待期間若已經換了新的分析回合（epoch 改變），舊回合不得再寫。
 */
function writeAnalysisCheckpoint(cp, status) {
    if (!cp || !cp.enabled || !cp.articleId) return Promise.resolve(null);
    const requested = status || cp.finalStatus || ANALYSIS_RUN_STATUS.running;
    return queueAnalysisSave(cp.articleId, cp.contentVersion, async () => {
        if (cp.epoch !== checkpointEpoch) return { ok: true, skipped: true };
        // 最終保存開始／完成後，尚未執行的 running checkpoint 不得蓋回去。
        // 取消是例外：取消發生在新回合開始前，應保留已完成段。
        if (requested !== ANALYSIS_RUN_STATUS.cancelled && (cp.finalizing || cp.finalSaved)) {
            return { ok: true, skipped: true };
        }
        // 用最新記錄當基底，保留期間內單段刷新寫入的詳解／句子／片語分析，
        // 但段落結果一律以這次 checkpoint 的完整快照為準。
        const latest = articleStore.getRecord(cp.articleId);
        const base = latest && contentVersionOfText(latest.article || '') === cp.contentVersion
            ? (latest.result || cp.previousResult)
            : cp.previousResult;
        const result = buildCheckpointResult(cp, requested, base);
        return articleStore.saveAnalysis(cp.articleId, result, {
            ctx: cp.ctx,
            expectContentVersion: cp.contentVersion,
            silent: true
        });
    }).then((saved) => {
        if (!saved || saved.skipped) return saved;
        if (saved.ok) {
            cp.lastCheckpointError = '';
            cp.runMeta = { ...cp.runMeta, lastErrorCode: '' };
            if (requested === ANALYSIS_RUN_STATUS.running) clearAnalysisCheckpointFailure();
            return saved;
        }
        cp.lastCheckpointError = saved.error || 'checkpoint_failed';
        if (saved.error === 'article_too_large') cp.disabledByLimit = true;
        if (cp.run && isRunActive(cp.run)) showAnalysisCheckpointFailure();
        return saved;
    }).catch((error) => {
        cp.lastCheckpointError = error?.name || 'checkpoint_failed';
        if (cp.run && isRunActive(cp.run)) showAnalysisCheckpointFailure();
        return { ok: false, error: 'checkpoint_failed' };
    });
}

/** debounce 1200ms；同一 checkpoint 一次只會有一個寫入在跑。 */
function scheduleAnalysisCheckpoint(cp) {
    if (!cp || !cp.enabled || cp.finalizing || cp.finalStatus || cp.disabledByLimit) return;
    clearTimeout(cp.timer);
    cp.timer = window.setTimeout(() => {
        cp.timer = 0;
        flushAnalysisCheckpoint(cp);
    }, ANALYSIS_CHECKPOINT_DEBOUNCE_MS);
}

function flushAnalysisCheckpoint(cp, options = {}) {
    if (!cp || !cp.enabled || cp.disabledByLimit) return Promise.resolve(null);
    clearTimeout(cp.timer);
    cp.timer = 0;
    const requested = options.status || cp.finalStatus || ANALYSIS_RUN_STATUS.running;
    cp.chain = (cp.chain || Promise.resolve())
        .catch(() => null)
        .then(() => writeAnalysisCheckpoint(cp, requested));
    return cp.chain;
}

/** 取消：先 flush，把 status 寫成 cancelled，保留已完成段。 */
function cancelAnalysisCheckpoint(cp) {
    // 已完成且最終保存成功：之後按清除／切換文章不得把 complete 蓋成 cancelled。
    if (!cp || !cp.enabled || cp.finalSaved) return Promise.resolve(null);
    // 取消當下通常仍是目前文章；後續的清除／切換會先改掉 recordId，先記下來才決定是否提示。
    const wasCurrent = isCurrentArticle(cp.articleId);
    cp.finalStatus = ANALYSIS_RUN_STATUS.cancelled;
    clearTimeout(cp.timer);
    cp.timer = 0;
    return flushAnalysisCheckpoint(cp, { status: ANALYSIS_RUN_STATUS.cancelled }).then((saved) => {
        if (saved?.ok && wasCurrent) {
            ui.displayMessage(t('article.analysisCancelledKept'), 'warning', 5000);
        }
        return saved;
    });
}

async function analyzeArticle() {
    const articleText = dom.articleInput.value.trim();
    if (!articleText) {
        ui.displayMessage(t('article.enterArticle'), 'warning');
        return;
    }
    const perfToken = perfProbe.markAnalysisStart();

    // 先取消上一個工作：舊請求不得再寫入任何文章、也不得再更新畫面。
    cancelActiveRun('cancelled-by-new-run');
    if (currentAnalysisAbort) {
        try { currentAnalysisAbort.abort('cancelled-by-new-run'); } catch (_) { /* noop */ }
    }
    const controller = new AbortController();
    currentAnalysisAbort = controller;

    // 文章身份：重新分析沿用原 ID；匯入的新內容一律建立新 ID。
    const resolved = resolveAnalysisArticleId();
    const articleId = resolved.id || articleStore.newArticleId();
    const run = createRun(articleId, controller);
    activeRun = run;
    // 新回合：舊回合排隊中的 checkpoint 一律失效，避免蓋掉這次的 running 狀態。
    checkpointEpoch += 1;
    hideAnalysisResumeBanner();
    clearAnalysisCheckpointFailure();
    articleContext.recordId = articleId;
    articleContext.origin = resolved.reused ? articleContext.origin : 'imported';
    if (typeof state.setCurrentArticleId === 'function') state.setCurrentArticleId(articleId);
    if (typeof state.setCurrentWordbookId === 'function') state.setCurrentWordbookId(articleId);

    dom.analyzeArticleBtn.disabled = true;
    dom.analyzeArticleBtn.textContent = t('article.analyzing');

    const { title, paragraphs } = parseTitleAndParagraphs(articleText);
    const items = title ? [title, ...paragraphs] : paragraphs; // 將標題也納入分析列表
    const paragraphAnalyses = new Array(items.length);
    // 只記規模（長度／段數），不記原文；關閉 probe 時為 no-op。
    perfProbe.recordArticleStats({ characters: articleText.length, paragraphs: items.length });

    // 文章專屬生詞本：id 與文章相同，重新分析不會裂出第二本。
    let articleMeta = null;
    try {
        const articleMetaInput = { ...buildArticleMetaInput(articleText, title), id: articleId };
        const res = storage.getOrCreateArticleWordbook(articleMetaInput, { createWordbook: false });
        articleMeta = res && res.articleMeta ? res.articleMeta : articleMetaInput;
    } catch (err) {
        console.warn('初始化文章生詞本失敗（將回退到預設生詞本）:', err);
    }
    const metaForRecord = buildArticleMetaInput(articleText, title);
    const previousRecord = articleStore.getRecord(articleId);
    const previousResult = previousRecord?.result || null;
    // 初始保存就帶入 running 的 analysis_run：即使第一段還沒回來，重新載入也知道
    // 這篇分析未完成；checkpoint 關閉時完全沿用舊行為（只保存既有結果）。
    const initialRun = analysisCheckpointEnabled()
        ? createAnalysisRun({
            runId: `run_${Date.now().toString(36)}_${run.runId}`,
            contentVersion: contentVersionOfText(articleText),
            total: items.length,
            startedAt: new Date().toISOString()
        })
        : null;
    const initialResult = initialRun
        ? {
            ...(previousResult || {}),
            chinese_translation: '',
            word_alignment: [],
            paragraph_analysis: new Array(items.length).fill(null),
            analysis_run: initialRun,
            updatedAt: new Date().toISOString()
        }
        : previousResult;
    // 先把「正在分析的這篇」存成記錄：中斷或重新載入都找得回來，也不會覆蓋別篇。
    const initialSave = await articleStore.saveArticle({
        articleId,
        article: articleText,
        result: initialResult,
        title: articleMeta?.title || metaForRecord.title,
        sourceType: articleMeta?.sourceType || metaForRecord.sourceType,
        sourceUrl: articleMeta?.sourceUrl || metaForRecord.sourceUrl
    }, { touch: false });
    if (!initialSave.ok) {
        ui.displayMessage(t('article.historySaveFailed'), 'error', 6000);
    }
    updateHistoryIndicators();

    if (items.length === 0) {
        perfProbe.markAnalysisSettled(perfToken, 'invalid');
        ui.displayMessage(t('article.invalidArticle'), 'warning');
        if (isRunActive(run)) {
            dom.analyzeArticleBtn.disabled = false;
            dom.analyzeArticleBtn.textContent = t('article.analyze');
        }
        return;
    }

    updateAnalysisProgress(0, items.length, t('article.preparing'));

    // Pre-render placeholders for incremental rendering
    const esc = escapeHtml;
    // 標題段落：去掉 `##` 再送分析與顯示，並用 is-heading 讓它長得像標題（見 styles.css）
    const paragraphViews = items.map((p, i) => {
        const heading = i > 0 || !title ? splitMarkdownHeading(p) : null;
        const list = !heading && isMarkdownListBlock(p);
        return {
            display: heading ? heading.text : (list ? normalizeListMarkersForDisplay(p) : p),
            headingLevel: heading ? heading.level : 0,
            isList: list
        };
    });
    dom.articleAnalysisContainer.innerHTML = paragraphViews.map((v, i) => `
        <div class="paragraph-pair${title && i === 0 ? ' is-title' : ''}${v.headingLevel ? ' is-heading' : ''}${v.isList ? ' is-list' : ''}" data-paragraph-index="${i}"${v.headingLevel ? ` data-heading-level="${v.headingLevel}"` : ''} data-english="${esc(v.display)}">
            <div class="para-status" data-status="pending">
                <span class="status-icon" aria-hidden="true"><svg class="icon" aria-hidden="true"><use href="#ic-timer"></use></svg></span>
                <span class="status-text">${t('article.analyzing')}</span>
                <span class="para-reason" hidden></span>
                <span class="elapsed" title="${t('article.elapsed')}"></span>
                <button class="retry-paragraph-btn" data-index="${i}" style="display:none;">${t('article.retryParagraph')}</button>
            </div>
            <div class="paragraph-english">${esc(v.display)}</div>
            <div class="paragraph-chinese"><em>${t('article.analyzing')}</em></div>
        </div>`).join('');

    let mainJob = null;
    let checkpoint = null;
    try {
        const total = items.length;
        let completed = 0;

        // 降低段落併發，避免觸發 429；並在拉起任務時加入間隔
        const CONCURRENCY = Math.min(2, total);
        const SPACING_MS = 400;
        let nextIndex = 0;
        const timeoutMs = 45000;
        lastFailedIndices = [];
        let aggregatedDetails = [];
        // 主分析也登記成一個 job：取消／換文章時和其他重試一起收束。
        const job = startAnalysisJob({
            kind: 'full',
            articleId,
            contentVersion: readingActions.articleVersion(articleId),
            controller
        });
        mainJob = job;
        if (initialRun) {
            checkpoint = createAnalysisCheckpoint({
                run,
                articleId,
                contentVersion: initialRun.contentVersion,
                runMeta: initialRun,
                paragraphAnalyses,
                previousResult
            });
            run.checkpoint = checkpoint;
        }

        const runNext = async () => {
            if (!isRunActive(run)) return;
            const idx = nextIndex++;
            if (idx >= total) return;
            // 啟動前延遲，平滑請求節奏
            await new Promise(r => setTimeout(r, SPACING_MS));
            if (!isRunActive(run)) return;
            // 標題段落用去掉 `##` 的顯示文字送分析與渲染
            const text = paragraphViews[idx]?.display ?? items[idx];
            updateAnalysisProgress(completed, total, t('article.analyzingParagraph', { number: idx + 1 }));
            try {
                // start timing for this paragraph
                paragraphStartTime[idx] = Date.now();
                const outcome = await runParagraphRequest(text, {
                    signal: controller.signal,
                    timeoutMs,
                    level: 'quick'
                });
                // 回應回來時這條工作可能已被取消／切換：結果不寫入目前的 DOM，也不改歸屬。
                if (!isRunActive(run) || !isJobWriteTarget(job)) return;
                if (outcome.ok) {
                    paragraphAnalyses[idx] = outcome.result;
                } else {
                    paragraphAnalyses[idx] = outcome.result || paragraphPipeline.failedParagraphResult(outcome.errorCode);
                    lastFailedIndices.push(idx);
                }
                // Incremental DOM update
                try { renderParagraph(idx, text, paragraphAnalyses[idx]); } catch(_) {}
                if (Array.isArray(paragraphAnalyses[idx]?.detailed_analysis)) {
                    aggregatedDetails = mergeDetailedAnalyses(aggregatedDetails, paragraphAnalyses[idx].detailed_analysis);
                    dom.articleAnalysisContainer.dataset.analysis = JSON.stringify(aggregatedDetails);
                }
            } catch (error) {
                if (error?.name === 'AbortError' || !isRunActive(run) || controller.signal.aborted) return;
                console.error(`分析第 ${idx + 1} 段時出錯:`, error);
                // 失敗時不偽造譯文，避免「分析失敗」文案被存入歷史與同步快照；
                // renderParagraph 會顯示失敗狀態、可翻譯原因與「重試本段」
                paragraphAnalyses[idx] = paragraphPipeline.failedParagraphResult(error?.code || 'provider_error');
                lastFailedIndices.push(idx);
                try { renderParagraph(idx, text, paragraphAnalyses[idx]); } catch(_) {}
            } finally {
                // finalize elapsed time
                if (paragraphStartTime[idx]) paragraphElapsedMs[idx] = Math.max(0, Date.now() - paragraphStartTime[idx]);
                completed += 1;
                if (isRunActive(run)) {
                    updateAnalysisProgress(completed, total, t('article.completedParagraphs', { count: completed }));
                    // 每段成功／失敗後排程 checkpoint；內容是「目前完整段落結果＋analysis_run」。
                    if (paragraphAnalyses[idx] !== undefined && paragraphAnalyses[idx] !== null) {
                        scheduleAnalysisCheckpoint(checkpoint);
                    }
                    await runNext();
                }
            }
        };

        const runners = [];
        for (let i = 0; i < CONCURRENCY; i++) runners.push(runNext());
        await Promise.all(runners);
        finishAnalysisJob(job);
        // 所有段落都已 render：量測「點擊 → 完成 render」（不等後續 IndexedDB 保存）。
        perfProbe.markAnalysisDone(perfToken, { status: 'rendered' });

        if (!isRunActive(run)) return;

        const latestRecord = articleStore.getRecord(articleId);
        const baseResult = {
            // Join translated paragraphs with visible newlines; keep it single-line JS string
            chinese_translation: paragraphAnalyses.map(p => (p && p.chinese_translation) || '').join('\n\n'),
            word_alignment: paragraphAnalyses.flatMap(p => (p && p.word_alignment) || []),
            // 保留頂層獨有項目：按需取得的單字詳解只存在這裡，不做事後有損精簡。
            detailed_analysis: mergeDetailedAnalyses(
                paragraphAnalyses.flatMap(p => (p && p.detailed_analysis) || []),
                latestRecord?.result?.detailed_analysis || []
            ),
            paragraph_analysis: paragraphAnalyses,
            sentence_analysis: [],
            phrase_analysis: [],
            updatedAt: new Date().toISOString()
        };
        const mergedResult = mergePreservedReadingAnalysis(
            latestRecord?.result,
            baseResult,
            !!latestRecord && latestRecord.article === articleText
        );
        // 全部完成：最後一次保存不 silent，status 為 complete／partial。
        const finalStats = analysisRunStats(paragraphAnalyses);
        const finalStatus = finalStats.failed > 0
            ? ANALYSIS_RUN_STATUS.partial
            : ANALYSIS_RUN_STATUS.complete;
        const finalRun = checkpoint
            ? {
                ...checkpoint.runMeta,
                status: finalStatus,
                total,
                completed: finalStats.completed,
                failed: finalStats.failed,
                updatedAt: new Date().toISOString(),
                lastErrorCode: ''
            }
            : null;
        if (checkpoint) {
            // 標記收尾：排隊中的 running checkpoint 不得蓋掉最終保存。
            checkpoint.finalizing = true;
            checkpoint.finalStatus = finalStatus;
            clearTimeout(checkpoint.timer);
            checkpoint.timer = 0;
        }
        const finalResult = finalRun
            ? { ...mergedResult, analysis_run: finalRun }
            : mergedResult;

        dom.articleAnalysisContainer.dataset.analysis = JSON.stringify(finalResult.detailed_analysis || []);
        setArticleViewVersion(articleText);
        updateArticleVersionState();
        const saveVersion = contentVersionOfText(articleText);
        // 整篇結果也走同一條保存佇列：等待中的段落重試不得用舊快照蓋掉這份完整結果。
        const saved = await queueAnalysisSave(articleId, saveVersion, async () => {
            if (!isRunActive(run)) return { ok: false, error: 'cancelled' };
            return articleStore.saveArticle({
                articleId,
                article: articleText,
                result: finalResult,
                title: articleMeta?.title || metaForRecord.title,
                sourceType: articleMeta?.sourceType || metaForRecord.sourceType,
                sourceUrl: articleMeta?.sourceUrl || metaForRecord.sourceUrl
            });
        });
        // 保存 await 期間可能已切到別篇：只有仍是目前文章／版本才能改畫面、摘要與歷史列。
        const stillCurrent = isRunActive(run)
            && isCurrentArticle(articleId)
            && contentVersionOfText(articleStore.getRecord(articleId)?.article || '') === saveVersion;
        if (!saved.ok) {
            if (checkpoint) {
                // 最終保存失敗：允許之後的 pagehide／可見性 flush 再試一次 running 狀態。
                checkpoint.finalizing = false;
                checkpoint.finalStatus = '';
            }
            if (saved.error !== 'cancelled' && saved.error !== 'stale_job') {
                // 結果已顯示但沒有落盤：保留明確的未保存狀態與「重試保存」入口（F3）。
                rememberAnalysisSaveFailure(articleId, {
                    contentVersion: saveVersion,
                    article: articleText,
                    result: finalResult,
                    title: articleMeta?.title || metaForRecord.title,
                    sourceType: articleMeta?.sourceType || metaForRecord.sourceType,
                    sourceUrl: articleMeta?.sourceUrl || metaForRecord.sourceUrl,
                    error: saved.error || 'save_failed'
                });
            }
            if (stillCurrent) {
                renderAnalysisSaveFailure(articleStore.getRecord(articleId));
                // 分析成功但寫入失敗要分開呈現：結果仍在畫面上，提供重試與匯出。
                ui.displayMessage(t('article.historySaveFailed'), 'error', 8000);
                if (dom.articleHistoryStatus) {
                    dom.articleHistoryStatus.hidden = false;
                    dom.articleHistoryStatus.classList.remove('hidden');
                    dom.articleHistoryStatus.dataset.state = 'failed';
                    dom.articleHistoryStatus.textContent = t('article.historyStatusSaveFailed');
                }
                if (dom.retryFailedParagraphsBtn) updateRetryFailedButton();
                await updateHistoryIndicators();
            }
            return;
        }
        // 這次保存寫入整份結果：清掉「本篇＋這個版本」的舊未保存標記（F4）。
        clearAnalysisSaveFailure(articleId);
        clearParagraphsUnsaved(articleId, saveVersion);
        if (checkpoint) {
            checkpoint.finalSaved = true;
            checkpoint.lastCheckpointError = '';
            checkpoint.runMeta = finalRun;
        }
        if (!stillCurrent) return;
        clearAnalysisCheckpointFailure();
        renderAnalysisSaveFailure(articleStore.getRecord(articleId));
        if (dom.retryFailedParagraphsBtn) updateRetryFailedButton();
        await updateHistoryIndicators();

    } catch (error) {
        if (!isRunActive(run)) {
            perfProbe.markAnalysisSettled(perfToken, 'cancelled');
            return;
        }
        if (controller.signal.aborted) {
            perfProbe.markAnalysisSettled(perfToken, 'cancelled');
            dom.articleAnalysisContainer.innerHTML = `<p>${t('article.cancelled')}</p>`;
        } else {
            perfProbe.markAnalysisSettled(perfToken, 'failed');
            console.error('分析文章時出錯:', error);
            dom.articleAnalysisContainer.innerHTML = `<p class="analysis-error">${t('article.analysisFailed')}</p>`;
        }
    } finally {
        // 取消／換文章等提前返回：已開始但沒有完成 render 的回合收尾（無則 no-op）。
        perfProbe.markAnalysisSettled(perfToken, controller.signal.aborted ? 'cancelled' : 'settled');
        finishAnalysisJob(mainJob);
        if (isRunActive(run)) {
            dom.analyzeArticleBtn.disabled = false;
            dom.analyzeArticleBtn.textContent = t('article.analyze');
            const inline = dom.articleAnalysisContainer.querySelector('.inline-progress');
            if (inline) inline.remove();
        }
        if (currentAnalysisAbort === controller) currentAnalysisAbort = null;
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

/** 歷史／整篇渲染時，每個段落都要有可判讀的狀態列（失敗可逐段重試）。 */
function paragraphStatusRowHtml(index, englishPara, item) {
    const classification = classifyParagraphResult(item, {
        sourceText: englishPara,
        isImageParagraph: isPureMarkdownImageParagraph(englishPara)
    });
    const status = classification.status;
    const icon = PARAGRAPH_STATUS_ICONS[status] || PARAGRAPH_STATUS_ICONS.pending;
    const reason = status === PARAGRAPH_STATUS.failed
        ? `<span class="para-reason">${escapeHtml(t('article.paragraphFailureReason', {
            message: t(paragraphErrorLabelKey(classification.errorCode))
        }))}</span>`
        : '<span class="para-reason" hidden></span>';
    const showRetry = status === PARAGRAPH_STATUS.failed || status === PARAGRAPH_STATUS.done;
    const retryLabel = status === PARAGRAPH_STATUS.failed ? t('article.retryParagraph') : t('article.refresh');
    const errorCodeAttr = classification.errorCode ? ` data-error-code="${escapeAttr(classification.errorCode)}"` : '';
    return `
        <div class="para-status" data-status="${escapeAttr(status)}"${errorCodeAttr}>
            <span class="status-icon" aria-hidden="true"><svg class="icon" aria-hidden="true"><use href="${icon}"></use></svg></span>
            <span class="status-text">${escapeHtml(t(paragraphStatusLabelKey(status)))}</span>
            ${reason}
            <button class="retry-paragraph-btn" data-index="${index}" style="display:${showRetry ? 'inline-block' : 'none'};">${escapeHtml(retryLabel)}</button>
        </div>`;
}

function displayArticleAnalysis(originalArticle, analysisResult) {
    const { chinese_translation, word_alignment, detailed_analysis, paragraph_analysis } = analysisResult;

    if (!chinese_translation && (!paragraph_analysis || paragraph_analysis.length === 0)) {
        dom.articleAnalysisContainer.innerHTML = `<p class="analysis-error">${t('article.invalidResponse')}</p>`;
        return;
    }

    const { title, paragraphs: englishParagraphsRaw } = parseTitleAndParagraphs(originalArticle);
    const englishParagraphs = title ? [title, ...englishParagraphsRaw] : englishParagraphsRaw;
    // 與英文段落一一對齊，優先使用 paragraph_analysis 的逐段結果，避免表格被拆行
    const chineseParagraphs = englishParagraphs.map((_, i) => (paragraph_analysis && paragraph_analysis[i] && paragraph_analysis[i].chinese_translation) || '');
    const escapeRegex = (string) => string ? string.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&') : '';
    const stripSpanTags = (s) => (s || '').replace(/<\/?span[^>]*>/g, '');

    let htmlContent = '';
    for (let i = 0; i < englishParagraphs.length; i++) {
        const rawEnglish = englishParagraphs[i] || '';
        // 標題段落（## / ###）：顯示時去掉標記，改用 is-heading 樣式呈現
        const heading = i === 0 && title ? null : splitMarkdownHeading(rawEnglish);
        const list = !heading && isMarkdownListBlock(rawEnglish);
        const englishPara = heading ? heading.text : (list ? normalizeListMarkersForDisplay(rawEnglish) : rawEnglish);
        const headingClass = `${heading ? ' is-heading' : ''}${list ? ' is-list' : ''}`;
        const headingAttr = heading ? ` data-heading-level="${heading.level}"` : '';
        // 原文已是中文（例如問答集描述）時不重複顯示翻譯，改顯示提示。
        const sourceIsChinese = isPredominantlyChinese(prepareParagraphForTranslation(englishPara));
        const sourceLangAttr = sourceIsChinese ? ' data-source-language="zh"' : '';
        const paragraphItem = paragraph_analysis?.[i] || null;
        // checkpoint 尚未完成的段落是 null：顯示「待分析」，不得當成失敗。
        const itemPending = !sourceIsChinese && paragraphItem === null;
        const pendingHtml = `<em class="analysis-pending-inline">${escapeHtml(t('article.paragraphStatusPending'))}</em>`;
        const chinesePara = sourceIsChinese ? '' : stripSpanTags(chineseParagraphs[i] || '');

        const processedChinese = chinesePara;

        // 若是 Markdown 表格段落，直接以表格渲染
        if (isMarkdownTableStart(englishPara)) {
            const pair = renderMarkdownTablePairHTML(englishPara, chinesePara, i);
            const engTableHtml = pair.eng;
            const zhTableHtml = sourceIsChinese
                ? `<span class="source-language-note">${escapeHtml(t('article.sourceAlreadyChinese'))}</span>`
                : (itemPending ? pendingHtml : pair.zh);
            const isTitle = !!title && i === 0;
            htmlContent += `
                <div class=\"paragraph-pair${isTitle ? ' is-title' : ''}${headingClass}\" data-paragraph-index=\"${i}\"${headingAttr}${sourceLangAttr} data-english=\"${escapeAttr(englishPara)}\">
                    <div class=\"paragraph-english\" data-markdown-table=\"1\">${engTableHtml}</div>
                    <div class=\"paragraph-chinese\" data-markdown-table=\"1\">${zhTableHtml}</div>
                    ${paragraphStatusRowHtml(i, englishPara, paragraph_analysis?.[i])}
                </div>`;
            continue;
        }

        // 純圖片段（Markdown 圖片行）直接以 <img> 呈現
        {
            const pairImgs = renderMarkdownImagesPairHTML(englishPara, processedChinese || chinesePara || '');
            if (pairImgs) {
                const isTitle = !!title && i === 0;
                htmlContent += `
                    <div class=\"paragraph-pair${isTitle ? ' is-title' : ''}${headingClass}\" data-paragraph-index=\"${i}\"${headingAttr}${sourceLangAttr} data-english=\"${escapeAttr(englishPara)}\">
                        <div class=\"paragraph-english\" data-markdown-images=\"1\">${pairImgs.eng}</div>
                        <div class=\"paragraph-chinese\" data-markdown-images=\"1\"></div>
                        ${paragraphStatusRowHtml(i, englishPara, paragraph_analysis?.[i])}
                    </div>`;
                continue;
            }
        }

        // sentence-level wrapping for full render（非表格、非圖片）
        const sentences = sentenceSplit(englishPara || '');
        const paraWords = (paragraph_analysis && paragraph_analysis[i]?.detailed_analysis) || [];
        const englishHtml = sentences.map((sText, sIdx) => {
            let sHtml = sentenceInlineHtml(sText);
            const sAlign = (word_alignment || []).filter(p => sText.includes(p.en) && (processedChinese || '').includes(p.zh));
            const sSorted = [...sAlign].sort((a, b) => (b.en?.length || 0) - (a.en?.length || 0));
            sSorted.forEach((pair) => {
                const pid = `para-${i}-pair-${sIdx}-${pair.en}-${pair.zh}`.replace(/[^a-zA-Z0-9_-]/g,'_');
                sHtml = replaceOutsideTags(sHtml, new RegExp(`\\b(${escapeRegex(pair.en)})\\b`, 'g'), `<span class=\"interactive-word\" data-pair-id=\"${pid}\" data-word=\"${escapeAttr(pair.en)}\">$1</span>`);
            });
            const words = paraWords.filter(w => w.word && sText.includes(w.word)).map(w => w.word);
            Array.from(new Set(words)).forEach(w => {
                const marker = `data-word=\"${escapeAttr(w)}\"`;
                if (sHtml.includes(marker)) return;
                const re = new RegExp(`\\b(${escapeRegex(w)})\\b`, 'g');
                sHtml = replaceOutsideTags(sHtml, re, `<span class=\"interactive-word\" data-word=\"${escapeAttr(w)}\">$1</span>`);
            });
            return sentenceWrapHtml(i, sIdx, sText, sHtml);
        }).join(' ');

        // Chinese sentence wrapping + cleaning
        // 優先用按句翻譯結果對齊（與英文 sent-index 一一對應）；否則回退中文標點分句
        const zhAligned = alignedZhSentences(paragraph_analysis && paragraph_analysis[i], sentences);
        const cleanedZh = cleanChinese(stripSpanTags(processedChinese || ''));
        const zhSentences = zhAligned || sentenceSplitZh(cleanedZh);
        const zhHtml = sourceIsChinese
            ? `<span class="source-language-note">${escapeHtml(t('article.sourceAlreadyChinese'))}</span>`
            : zhSentences.map((z, sIdx) => `<span class=\"interactive-sentence-zh\" data-para-index=\"${i}\" data-sent-index=\"${sIdx}\">${inlineMarkdownToHtml(normalizeListMarkersForDisplay(z))}</span>`).join(' ');

        // 沒有譯文又沒有被標成 skipped：中文側顯示失敗提示，不要留空白假裝完成。
        const zhDisplayHtml = itemPending
            ? pendingHtml
            : ((!sourceIsChinese && !zhHtml)
                ? `<em class="analysis-failed-inline">${escapeHtml(t('article.analysisFailedInline'))}</em>`
                : zhHtml);
        const isTitle = !!title && i === 0;
        htmlContent += `
            <div class=\"paragraph-pair${isTitle ? ' is-title' : ''}${headingClass}\" data-paragraph-index=\"${i}\"${headingAttr}${sourceLangAttr} data-english=\"${escapeAttr(englishPara)}\">
                <div class=\"paragraph-english\">${englishHtml}</div>
                <div class=\"paragraph-chinese\">${zhDisplayHtml}</div>
                ${paragraphStatusRowHtml(i, englishPara, paragraph_analysis?.[i])}
            </div>`;
    }
    
    dom.articleAnalysisContainer.innerHTML = htmlContent;
    // 畫面上這份分析對應的正文版本（記憶體狀態，供版本提示與朗讀判斷）。
    setArticleViewVersion(originalArticle);
    updateArticleVersionState();
    // 包裝英文單詞為可點 token（一次性）
    dom.articleAnalysisContainer.querySelectorAll('.paragraph-english').forEach(el => {
        // 表格不做 token 包裝以免破壞結構
        if (el.querySelector('table') || el.dataset.markdownTable === '1') { el.dataset.tokensWrapped = '1'; return; }
        wrapWordsInElementOnce(el);
    });
    bindAnalyzeButtonToLastWord(dom.articleAnalysisContainer);
    dom.articleAnalysisContainer.dataset.analysis = JSON.stringify(detailed_analysis || []);
    try {
        document.dispatchEvent(new CustomEvent('bdc:article-loaded', {
            detail: { articleId: articleContext.recordId || '' }
        }));
    } catch (_) {}
}

function clearArticleInput(options = {}) {
    cancelActiveRun('cancelled-by-clear');
    if (options.keepDraft !== true) saveCurrentDraft({ force: true });
    dom.articleInput.value = '';
    dom.articleAnalysisContainer.innerHTML = `<p>${t('article.initialHint')}</p>`;
    dom.articleAnalysisContainer.dataset.analysis = '[]';
    hideAnalysisResumeBanner();
    clearAnalysisCheckpointFailure();
    clearCurrentArticleSourceMeta();
    resetArticleContext();
    lastFailedIndices = [];
    updateRetryFailedButton();
    updateArticleVersionState();
    try { notifyAssistantArticleChanged(); } catch (_) {}
    updateHistoryIndicators();
}

// ─────────────────────────────────────────────────────────────────────────────
// 閱讀記錄（單一入口 + 清單彈窗）
// ─────────────────────────────────────────────────────────────────────────────

const HISTORY_SORT = { recent: 'recent', updated: 'updated', title: 'title' };
const historyUi = {
    sort: HISTORY_SORT.recent,
    source: 'all',
    query: '',
    open: false,
    menuKey: ''
};
// 每次刪除各自保存一份可復原快照；連續刪除不會覆蓋前一次。
const historyUndoStack = [];
const HISTORY_UNDO_LIMIT = 20;

function currentDraftSnapshot() {
    const text = (dom.articleInput && dom.articleInput.value) || '';
    if (!text.trim()) return null;
    const ds = (dom.articleInput && dom.articleInput.dataset) || {};
    return {
        text,
        sourceType: ds.sourceType || 'paste',
        sourceUrl: ds.sourceUrl || '',
        title: ds.sourceTitle || '',
        recordId: articleContext.recordId || ''
    };
}

function recordHasUnsavedInput(record) {
    if (!record) return !!(dom.articleInput && dom.articleInput.value.trim());
    return String(dom.articleInput?.value || '').trim() !== String(record.article || '').trim();
}

/** 切換文章／刪除目前文章之前，先把目前輸入存成可恢復的草稿。 */
function saveCurrentDraft(options = {}) {
    const snapshot = currentDraftSnapshot();
    if (!snapshot) return false;
    const record = snapshot.recordId ? articleStore.getRecord(snapshot.recordId) : null;
    if (record && !recordHasUnsavedInput(record) && !options.force) return false;
    articleStore.saveDraft(snapshot).then(() => updateHistoryIndicators()).catch(() => {});
    return true;
}

function sourceLabel(sourceType) {
    const map = {
        url: t('article.sourceUrl'),
        file: t('article.sourceFile'),
        ocr: t('article.sourceOcr'),
        paste: t('article.sourcePaste')
    };
    return map[sourceType] || t('article.sourcePaste');
}

function recordTimestamp(record) {
    return record.lastOpenedAt || record.updatedAt || record.createdAt || '';
}

function relativeTime(value) {
    if (!value) return t('article.unknownTime');
    const ms = new Date(value).getTime();
    if (Number.isNaN(ms)) return t('article.unknownTime');
    const diff = ms - Date.now();
    const abs = Math.abs(diff);
    try {
        const rtf = new Intl.RelativeTimeFormat(getLocaleTag(), { numeric: 'auto' });
        if (abs < 60 * 1000) return rtf.format(Math.round(diff / 1000), 'second');
        if (abs < 60 * 60 * 1000) return rtf.format(Math.round(diff / (60 * 1000)), 'minute');
        if (abs < 24 * 60 * 60 * 1000) return rtf.format(Math.round(diff / (60 * 60 * 1000)), 'hour');
        if (abs < 30 * 24 * 60 * 60 * 1000) return rtf.format(Math.round(diff / (24 * 60 * 60 * 1000)), 'day');
        return formatDateTime(value, { year: 'numeric', month: '2-digit', day: '2-digit' });
    } catch (_) {
        return formatDateTime(value);
    }
}

function recordTitle(record) {
    const title = String(record?.title || '').trim();
    if (title) return title;
    if (record?.summaryOnly !== false && record?.excerpt) return String(record.excerpt).slice(0, 80);
    const { title: parsed, paragraphs } = parseTitleAndParagraphs(record?.article || '');
    return (parsed || paragraphs.find((p) => p && p.trim()) || t('article.untitled')).trim().slice(0, 80);
}

function recordSummary(record) {
    if (record?.summaryOnly !== false && record?.excerpt) return String(record.excerpt).slice(0, 120);
    const { paragraphs } = parseTitleAndParagraphs(record?.article || '');
    const text = paragraphs.find((p) => p && p.trim()) || record?.article || '';
    return String(text).replace(/\s+/g, ' ').slice(0, 120);
}

function recordFailedParagraphs(record) {
    if (record?.result == null) return Number(record?.failedParagraphs) || 0;
    // 與畫面共用同一套判定：中文原文與純圖片段不算失敗，空譯文與未保存段算失敗。
    return failedIndicesForRecord(record).length;
}

function recordStatusText(record) {
    if (analysisSaveFailureFor(record)) return t('article.historyStatusSaveFailed');
    if (!record?.result) return record?.hasAnalysis ? t('article.analyzed') : t('article.notAnalyzed');
    // analysis_run 格式不符或不存在時，完全回到 Phase 1 的失敗段狀態。
    const run = normalizeAnalysisRun(record.result.analysis_run);
    if (run) {
        if (run.status === ANALYSIS_RUN_STATUS.running) return t('article.analysisRunningStatus');
        if (isIncompleteAnalysisRun(run)) {
            return t('article.analysisPartialStatus', {
                done: Math.max(0, run.completed - run.failed),
                total: run.total
            });
        }
    }
    const failed = recordFailedParagraphs(record);
    if (failed > 0) return t('article.historyPartial', { count: failed });
    return t('article.analyzed');
}

function buildHistoryEntries() {
    const records = articleStore.getRecords();
    const query = historyUi.query.trim().toLowerCase();
    let list = records.filter((record) => {
        if (historyUi.source !== 'all' && (record.sourceType || 'paste') !== historyUi.source) return false;
        if (!query) return true;
        const haystack = `${record.title || ''}\n${record.excerpt || ''}`.toLowerCase();
        return haystack.includes(query);
    });
    if (historyUi.sort === HISTORY_SORT.title) {
        const collator = createCollator();
        list = list.sort((a, b) => collator.compare(recordTitle(a), recordTitle(b)));
    } else if (historyUi.sort === HISTORY_SORT.updated) {
        list = list.sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
    } else {
        list = list.sort((a, b) => String(recordTimestamp(b)).localeCompare(String(recordTimestamp(a))));
    }
    return list;
}

function groupLabel(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return t('article.historyEarlier');
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const time = date.getTime();
    if (time >= startOfToday) return t('article.historyToday');
    if (time >= startOfToday - 24 * 60 * 60 * 1000) return t('article.historyYesterday');
    if (time >= startOfToday - 7 * 24 * 60 * 60 * 1000) return t('article.historyThisWeek');
    return t('article.historyEarlier');
}

function historyRowHtml(record) {
    const isCurrent = isCurrentArticle(record.articleId);
    const title = recordTitle(record);
    const summary = recordSummary(record);
    const timeText = relativeTime(recordTimestamp(record));
    const status = recordStatusText(record);
    const dirty = record.dirty || record.pending ? `<span class="ar-history-dirty" title="${escapeAttr(t('article.historyPendingSync'))}">${escapeHtml(t('article.historyPendingSyncShort'))}</span>` : '';
    const conflict = record.conflict ? `<span class="ar-history-conflict">${escapeHtml(t('article.historyConflict'))}</span>` : '';
    return `
        <div class="ar-history-item${isCurrent ? ' is-current' : ''}" data-key="${escapeAttr(record.articleId)}" role="listitem" tabindex="0">
            <button type="button" class="ar-history-open" data-act="open">
                <span class="ar-history-title">${escapeHtml(title)}</span>
                <span class="ar-history-meta">${escapeHtml(timeText)} · ${escapeHtml(sourceLabel(record.sourceType))} · ${escapeHtml(status)}${dirty}${conflict}</span>
                <span class="ar-history-summary">${escapeHtml(summary)}</span>
            </button>
            <div class="ar-history-side">
                ${isCurrent ? `<span class="ar-history-badge">${escapeHtml(t('article.historyCurrent'))}</span>` : ''}
                <button type="button" class="ar-history-more" data-act="more" aria-haspopup="menu" aria-expanded="false" aria-label="${escapeAttr(t('article.historyMoreActions'))}">⋯</button>
            </div>
        </div>`;
}

function renderHistoryList(container) {
    const entries = buildHistoryEntries();
    const list = container.querySelector('.ar-history-list');
    if (!list) return;
    if (!entries.length) {
        list.innerHTML = `<div class="ar-history-empty">
            <p class="ar-history-empty-title">${escapeHtml(t('article.historyEmptyTitle'))}</p>
            <p class="ar-history-empty-hint">${escapeHtml(t('article.historyEmptyHint'))}</p>
        </div>`;
        return;
    }
    const useGroups = historyUi.sort !== HISTORY_SORT.title;
    let html = '';
    let lastGroup = '';
    for (const record of entries) {
        if (useGroups) {
            const group = groupLabel(recordTimestamp(record));
            if (group !== lastGroup) {
                html += `<div class="ar-history-group" role="presentation">${escapeHtml(group)}</div>`;
                lastGroup = group;
            }
        }
        html += historyRowHtml(record);
    }
    list.innerHTML = html;
    // 點「更多」時就地展開，不重建整份清單（避免捲動位置跳動）
    list.querySelectorAll('.ar-history-more').forEach((button) => {
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            const row = button.closest('.ar-history-item');
            if (!row) return;
            toggleRowMenu(row, button);
        });
    });
    list.querySelectorAll('.ar-history-open').forEach((button) => {
        button.addEventListener('click', () => {
            const key = button.closest('.ar-history-item')?.getAttribute('data-key');
            if (key) openReadingRecord(key);
        });
    });
}

function closeRowMenus(root) {
    (root || document).querySelectorAll('.ar-history-menu').forEach((node) => node.remove());
    (root || document).querySelectorAll('.ar-history-more[aria-expanded="true"]').forEach((node) => node.setAttribute('aria-expanded', 'false'));
}

function toggleRowMenu(row, trigger) {
    const host = row.parentElement;
    const existing = row.querySelector('.ar-history-menu');
    closeRowMenus(host);
    if (existing) return;
    const key = row.getAttribute('data-key');
    trigger.setAttribute('aria-expanded', 'true');
    const menu = document.createElement('div');
    menu.className = 'ar-history-menu';
    menu.setAttribute('role', 'menu');
    menu.innerHTML = `
        <button type="button" role="menuitem" data-act="rename">${escapeHtml(t('article.historyRename'))}</button>
        <button type="button" role="menuitem" data-act="delete">${escapeHtml(t('article.historyDelete'))}</button>`;
    row.appendChild(menu);
    menu.addEventListener('click', (event) => {
        const button = event.target.closest('button');
        if (!button) return;
        event.stopPropagation();
        closeRowMenus(host);
        if (button.dataset.act === 'rename') renameReadingRecord(key);
        else if (button.dataset.act === 'delete') deleteReadingRecord(key);
    });
    // 點別處關閉（只掛一次，靠旗標避免重複）
    if (!toggleRowMenu._wired) {
        toggleRowMenu._wired = true;
        document.addEventListener('click', (event) => {
            if (event.target.closest && event.target.closest('.ar-history-menu')) return;
            if (event.target.closest && event.target.closest('.ar-history-more')) return;
            closeRowMenus();
        });
    }
}

async function openReadingRecord(recordId) {
    const record = await articleStore.ensureArticleLoaded(recordId);
    if (!record) {
        ui.displayMessage(t('article.analysisRecordMissing'), 'warning');
        return;
    }
    saveCurrentDraft();
    // 切換記錄前先收起所有分析／重試工作：晚回應不得寫進剛打開的這篇。
    cancelActiveRun('load-record');
    cancelAnalysisJobs('load-record');
    applyRecordToView(record);
    await articleStore.touchOpened(recordId);
    try { ui.closeModal(); } catch (_) {}
    updateHistoryIndicators();
    if (window.matchMedia && window.matchMedia('(min-width: 900px)').matches) {
        try { dom.articleAnalysisContainer.querySelector('.paragraph-pair')?.scrollIntoView({ block: 'nearest' }); } catch (_) {}
    } else {
        try { dom.articleAnalysisContainer.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (_) {}
    }
}

function applyRecordToView(record) {
    cancelAnalysisJobs('load-record');
    // 切換文章：上一頁的頁內查詞快取與 tooltip 會談不得套到新正文。
    try { showArticleWordAnalysis._lazyCache?.clear?.(); } catch (_) { /* noop */ }
    dismissWordTooltip({ restoreFocus: false, source: 'article-switch' });
    if (articleSentenceCard) resetSentenceCardState({ restoreFocus: false });
    else clearWordMode({ restoreFocus: false });
    dom.articleInput.value = record.article || '';
    setLoadedArticleContext(record.articleId, {
        sourceType: record.sourceType || 'paste',
        sourceUrl: record.sourceUrl || '',
        title: record.title || ''
    });
    if (record.result) {
        displayArticleAnalysis(record.article || '', record.result);
        // 保存失敗的段落：以「未保存」狀態覆蓋記憶體中看似成功的結果，
        // 否則切回這篇時畫面會變成可用的譯文（P1-1）。
        const contentVersion = readingActions.articleVersion(record.articleId);
        const paragraphTexts = currentParagraphTexts(record.article || '');
        unsavedParagraphIndices(record.articleId, contentVersion).forEach((index) => {
            if (index < 0 || index >= paragraphTexts.length) return;
            const unsaved = unsavedParagraphResult(record.articleId, contentVersion, index) || {};
            renderParagraph(index, paragraphTexts[index], { ...unsaved, failed: true, errorCode: 'save_failed' });
        });
    } else {
        dom.articleAnalysisContainer.innerHTML = `<p>${escapeHtml(t('article.historyNotAnalyzedHint'))}</p>`;
        dom.articleAnalysisContainer.dataset.analysis = '[]';
        // 無分析記錄：畫面沒有任何「分析結果」，版本狀態必須一起重設，
        // 否則會同時出現「尚未分析」與「畫面仍是舊版分析」（P2-4）。
        setArticleViewVersion(record.article || '', { analyzed: false });
        clearBatchSummary();
    }
    clearAnalysisCheckpointFailure();
    // 未完成分析：analysis_run 與目前正文版本一致才顯示續作 banner；
    // 版本不一致時不提供舊版續作，沿用既有的舊版分析提示。
    const resumeRun = record.result ? normalizeAnalysisRun(record.result.analysis_run) : null;
    const resumeVersionMatches = !!resumeRun
        && resumeRun.contentVersion === contentVersionOfText(record.article || '');
    if (resumeRun && isIncompleteAnalysisRun(resumeRun) && resumeVersionMatches) {
        showAnalysisResumeBanner(resumeRun);
    } else {
        hideAnalysisResumeBanner();
    }
    // 整篇分析保存失敗的結果只存在記憶體：切回該篇時仍要看見未保存提示與保存入口。
    renderAnalysisSaveFailure(record);
    // 失敗段與批次按鈕一律由記錄推導（歷史上本來就沒有 lastFailedIndices）。
    refreshFailedStateFromRecord();
    updateArticleVersionState();
    try { notifyAssistantArticleChanged(); } catch (_) {}
}

async function renameReadingRecord(recordId) {
    const record = articleStore.getRecord(recordId);
    if (!record) return;
    const nextTitle = await ui.promptAction({
        title: t('article.historyRename'),
        message: t('article.historyRenamePrompt'),
        label: t('article.historyRenameLabel'),
        value: recordTitle(record),
        confirmLabel: t('article.historyRenameConfirm'),
        cancelLabel: t('common.cancel')
    });
    if (nextTitle === null || nextTitle === undefined) return;
    const result = await articleStore.renameArticle(recordId, nextTitle);
    if (!result.ok) {
        ui.displayMessage(t('article.historyRenameFailed'), 'error');
        return;
    }
    ui.displayMessage(t('article.historyRenamed'), 'success', 1800);
    refreshHistoryModal();
    updateHistoryIndicators();
}

async function deleteReadingRecord(recordId) {
    const record = await articleStore.ensureArticleLoaded(recordId);
    if (!record) return;
    const isCurrent = isCurrentArticle(recordId);
    if (isCurrent && recordHasUnsavedInput(record)) {
        const okDelete = await ui.confirmAction({
            title: t('article.historyDelete'),
            message: t('article.historyDeleteCurrentUnsaved'),
            confirmLabel: t('article.historyDelete'),
            cancelLabel: t('common.cancel'),
            danger: true
        });
        if (!okDelete) return;
    }
    // 復原需要完整快照：記錄本身 + 刪除當下的順序
    const snapshot = { ...record };
    saveCurrentDraft({ force: true });
    const result = await articleStore.deleteArticle(recordId);
    if (!result.ok) {
        ui.displayMessage(t('article.historyDeleteFailed'), 'error');
        return;
    }
    historyUndoStack.push({ snapshot, at: Date.now() });
    if (historyUndoStack.length > HISTORY_UNDO_LIMIT) historyUndoStack.shift();
    if (isCurrent) {
        cancelActiveRun('record-deleted');
        dom.articleAnalysisContainer.innerHTML = `<p>${escapeHtml(t('article.historyCurrentDeleted'))}</p>`;
        dom.articleAnalysisContainer.dataset.analysis = '[]';
        resetArticleContext();
    }
    refreshHistoryModal();
    updateHistoryIndicators();
    showUndoBar();
}

async function undoLastDelete() {
    const entry = historyUndoStack.pop();
    if (!entry) return;
    const result = await articleStore.restoreArticle(entry.snapshot);
    if (!result.ok) {
        ui.displayMessage(t('article.historyUndoFailed'), 'error');
        return;
    }
    ui.displayMessage(t('article.historyUndone', { title: recordTitle(entry.snapshot) }), 'success', 2200);
    refreshHistoryModal();
    updateHistoryIndicators();
    showUndoBar();
}

let undoBarTimer = 0;
function undoSlots() {
    return [
        document.getElementById('article-history-undo'),
        document.querySelector('.ar-history-undo')
    ].filter(Boolean);
}

/** 刪除後的復原提示同時出現在文章頁狀態列與閱讀記錄彈窗內（彈窗開著時也按得到）。 */
function showUndoBar() {
    const latest = historyUndoStack[historyUndoStack.length - 1];
    for (const bar of undoSlots()) {
        if (!latest) {
            bar.hidden = true;
            bar.classList.add('hidden', 'is-empty');
            bar.innerHTML = '';
            continue;
        }
        bar.hidden = false;
        bar.classList.remove('hidden', 'is-empty');
        bar.innerHTML = `<span class="undo-text">${escapeHtml(t('article.historyDeleted', { title: recordTitle(latest.snapshot) }))}${historyUndoStack.length > 1 ? ` <span class="undo-more">${escapeHtml(t('article.historyUndoMore', { count: historyUndoStack.length - 1 }))}</span>` : ''}</span>
            <button type="button" class="btn-ghost btn-mini article-history-undo-btn">${escapeHtml(t('article.historyUndo'))}</button>`;
    }
    clearTimeout(undoBarTimer);
    undoBarTimer = setTimeout(() => {
        for (const bar of undoSlots()) {
            bar.hidden = true;
            bar.classList.add('hidden');
        }
    }, 12000);
}

function historyFooterHtml(container) {
    const usageText = t('article.historyStorage', {
        count: articleStore.getRecords().length,
        size: formatBytes(articleStore.getRecords().reduce((sum, item) => sum + (Number(item.sizeBytes) || 0), 0))
    });
    return `<span class="ar-history-usage" id="ar-history-usage">${escapeHtml(usageText)}</span>
        <span class="ar-history-undo hidden" hidden></span>
        <button type="button" class="btn-secondary" id="ar-history-clear">${escapeHtml(t('article.clearAll'))}</button>`;
}

function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 * 1024)).toFixed(2)} MB`;
}

function updateHistoryUsage(container) {
    const el = container.querySelector('#ar-history-usage');
    if (!el) return;
    const records = articleStore.getRecords();
    el.textContent = t('article.historyStorage', {
        count: records.length,
        size: formatBytes(records.reduce((sum, item) => sum + (Number(item.sizeBytes) || 0), 0))
    });
}

function refreshHistoryModal() {
    const container = document.querySelector('.ar-history');
    if (!container) return;
    // 重建清單不得把使用者的閱讀位置與搜尋焦點洗掉（locale 切換會走這條路）。
    const previousList = container.querySelector('.ar-history-list');
    const scrollTop = previousList ? Number(previousList.scrollTop) || 0 : 0;
    const active = document.activeElement;
    const searchFocused = !!active && active.id === 'ar-history-search';
    const selectionStart = searchFocused ? active.selectionStart : null;
    const selectionEnd = searchFocused ? active.selectionEnd : null;
    renderHistoryList(container);
    updateHistoryUsage(container);
    renderDraftRow(container);
    renderConflictRow(container);
    const list = container.querySelector('.ar-history-list');
    if (list && scrollTop > 0) {
        try { list.scrollTop = scrollTop; } catch (_) { /* 退回頂部 */ }
    }
    if (searchFocused) {
        const search = container.querySelector('#ar-history-search');
        if (search) {
            try { search.focus({ preventScroll: true }); } catch (_) { /* noop */ }
            if (selectionStart != null) {
                try { search.setSelectionRange(selectionStart, selectionEnd ?? selectionStart); } catch (_) { /* noop */ }
            }
        }
    }
}

function renderDraftRow(container) {
    const host = container.querySelector('.ar-history-draft');
    if (!host) return;
    articleStore.readDraft().then((draft) => {
        if (!draft || !String(draft.text || '').trim()) {
            host.hidden = true;
            host.innerHTML = '';
            return;
        }
        host.hidden = false;
        host.innerHTML = `<div class="ar-draft-item">
            <div class="ar-draft-main">
                <div class="ar-draft-title">${escapeHtml(t('article.historyDraftTitle'))}</div>
                <div class="ar-draft-meta">${escapeHtml(relativeTime(draft.savedAt))} · ${escapeHtml(draft.title || draft.text.slice(0, 40))}</div>
            </div>
            <div class="ar-draft-actions">
                <button type="button" class="btn-secondary" data-act="restore-draft">${escapeHtml(t('article.historyDraftRestore'))}</button>
                <button type="button" class="btn-tertiary" data-act="discard-draft">${escapeHtml(t('article.historyDraftDiscard'))}</button>
            </div>
        </div>`;
        host.querySelector('[data-act="restore-draft"]')?.addEventListener('click', async () => {
            const latest = await articleStore.readDraft();
            if (!latest) return;
            applyImportedArticle(latest.text, {
                sourceType: latest.sourceType || 'paste',
                sourceUrl: latest.sourceUrl || '',
                title: latest.title || ''
            });
            if (latest.recordId && isCurrentArticle(latest.recordId)) {
                articleContext.recordId = latest.recordId;
                articleContext.origin = 'loaded';
            }
            await articleStore.clearDraft();
            try { ui.closeModal(); } catch (_) {}
            updateHistoryIndicators();
            ui.displayMessage(t('article.historyDraftRestored'), 'success', 2000);
        });
        host.querySelector('[data-act="discard-draft"]')?.addEventListener('click', async () => {
            await articleStore.clearDraft();
            renderDraftRow(container);
            updateHistoryIndicators();
        });
    }).catch(() => {});
}

function renderConflictRow(container) {
    const host = container.querySelector('.ar-history-conflicts');
    if (!host) return;
    const conflicts = articleStore.getConflicts();
    if (!conflicts.length) {
        host.hidden = true;
        host.innerHTML = '';
        return;
    }
    host.hidden = false;
    host.innerHTML = `<div class="ar-conflict-title">${escapeHtml(t('article.historyConflictsTitle'))}</div>
        ${conflicts.map((conflict) => {
            const record = articleStore.getRecord(conflict.articleId);
            const title = record ? recordTitle(record) : conflict.articleId;
            return `<div class="ar-conflict-item" data-key="${escapeAttr(conflict.articleId)}">
                <div class="ar-conflict-main">
                    <div class="ar-conflict-name">${escapeHtml(title)}</div>
                    <div class="ar-conflict-meta">${escapeHtml(t('article.historyConflictHint'))}</div>
                </div>
                <div class="ar-conflict-actions">
                    <button type="button" class="btn-secondary" data-act="keep-mine">${escapeHtml(t('article.historyConflictKeepMine'))}</button>
                    <button type="button" class="btn-tertiary" data-act="save-copy">${escapeHtml(t('article.historyConflictSaveCopy'))}</button>
                    <button type="button" class="btn-tertiary" data-act="use-remote">${escapeHtml(t('article.historyConflictUseRemote'))}</button>
                </div>
            </div>`;
        }).join('')}`;
    host.querySelectorAll('.ar-conflict-item').forEach((row) => {
        const key = row.getAttribute('data-key');
        row.querySelector('[data-act="keep-mine"]')?.addEventListener('click', async () => {
            row.classList.add('is-busy');
            try { await articleSync.resolveKeepMine(key); } catch (_) {}
            row.classList.remove('is-busy');
            refreshHistoryModal();
        });
        row.querySelector('[data-act="save-copy"]')?.addEventListener('click', async () => {
            row.classList.add('is-busy');
            try { await articleSync.resolveSaveCopy(key); } catch (_) {}
            row.classList.remove('is-busy');
            refreshHistoryModal();
        });
        row.querySelector('[data-act="use-remote"]')?.addEventListener('click', async () => {
            row.classList.add('is-busy');
            try { await articleSync.resolveUseRemote(key); } catch (_) {}
            row.classList.remove('is-busy');
            refreshHistoryModal();
        });
    });
}

function openArticleHistory() {
    historyUi.open = true;
    historyUi.menuKey = '';
    try { ui.openModal(); } catch (_) {}
    try { dom.modalTitle.textContent = t('article.historyRecords'); } catch (_) {}
    try { document.querySelector('#app-modal .modal-content')?.classList.add('modal-large'); } catch (_) {}
    const container = document.createElement('div');
    container.className = 'ar-history';
    container.innerHTML = `
        <div class="ar-history-toolbar">
            <input type="search" id="ar-history-search" class="ar-history-search" autocomplete="off"
                placeholder="${escapeAttr(t('article.historySearchPlaceholder'))}" aria-label="${escapeAttr(t('article.historySearchLabel'))}">
            <select id="ar-history-sort" class="ar-history-sort" aria-label="${escapeAttr(t('article.historySortLabel'))}">
                <option value="recent">${escapeHtml(t('article.historySortRecent'))}</option>
                <option value="updated">${escapeHtml(t('article.historySortUpdated'))}</option>
                <option value="title">${escapeHtml(t('article.historySortTitle'))}</option>
            </select>
        </div>
        <div class="ar-history-filters" role="group" aria-label="${escapeAttr(t('article.historyFilterLabel'))}">
            ${[['all', 'article.historySourceAll'], ['url', 'article.sourceUrl'], ['file', 'article.sourceFile'], ['ocr', 'article.sourceOcr'], ['paste', 'article.sourcePaste']]
                .map(([value, key]) => `<button type="button" class="ar-history-filter${historyUi.source === value ? ' active' : ''}" data-source="${value}" aria-pressed="${historyUi.source === value}">${escapeHtml(t(key))}</button>`)
                .join('')}
        </div>
        <div class="ar-history-draft" hidden></div>
        <div class="ar-history-conflicts" hidden></div>
        <div class="ar-history-search-note">${escapeHtml(t('article.historySearchScope'))}</div>
        <div class="ar-history-list" role="list"></div>
        <div class="ar-history-footer">${historyFooterHtml(container)}</div>`;
    dom.modalBody.innerHTML = '';
    dom.modalBody.appendChild(container);
    const search = container.querySelector('#ar-history-search');
    search.value = historyUi.query;
    container.querySelector('#ar-history-sort').value = historyUi.sort;
    search.addEventListener('input', () => {
        historyUi.query = search.value || '';
        renderHistoryList(container);
    });
    container.querySelector('#ar-history-sort').addEventListener('change', (event) => {
        historyUi.sort = event.target.value;
        renderHistoryList(container);
    });
    container.querySelectorAll('.ar-history-filter').forEach((button) => {
        button.addEventListener('click', () => {
            historyUi.source = button.dataset.source || 'all';
            container.querySelectorAll('.ar-history-filter').forEach((item) => {
                const active = item.dataset.source === historyUi.source;
                item.classList.toggle('active', active);
                item.setAttribute('aria-pressed', active ? 'true' : 'false');
            });
            renderHistoryList(container);
        });
    });
    container.addEventListener('keydown', (event) => {
        const row = event.target.closest && event.target.closest('.ar-history-item');
        if (!row) return;
        if (event.key === 'Enter') {
            event.preventDefault();
            openReadingRecord(row.getAttribute('data-key'));
        } else if (event.key === 'Delete') {
            // Delete 只在列本身取得焦點時生效；搜尋框維持文字編輯。
            event.preventDefault();
            deleteReadingRecord(row.getAttribute('data-key'));
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const rows = Array.from(container.querySelectorAll('.ar-history-item'));
            const index = rows.indexOf(row);
            const next = rows[index + (event.key === 'ArrowDown' ? 1 : -1)];
            if (next) next.focus();
        }
    });
    container.querySelector('#ar-history-clear')?.addEventListener('click', async () => {
        const okClear = await ui.confirmAction({
            title: t('article.clearAll'),
            message: t('article.confirmClearHistory'),
            confirmLabel: t('article.clearAll'),
            cancelLabel: t('common.cancel'),
            danger: true
        });
        if (!okClear) return;
        const records = articleStore.getRecords().slice();
        for (const record of records) {
            const full = await articleStore.ensureArticleLoaded(record.articleId);
            historyUndoStack.push({ snapshot: { ...(full || record) }, at: Date.now() });
        }
        while (historyUndoStack.length > HISTORY_UNDO_LIMIT) historyUndoStack.shift();
        for (const record of records) await articleStore.deleteArticle(record.articleId);
        if (isCurrentArticle(articleContext.recordId)) clearArticleInput({ keepDraft: true });
        renderHistoryList(container);
        updateHistoryUsage(container);
        showUndoBar();
        updateHistoryIndicators();
        ui.displayMessage(t('article.historyClearDone'), 'success', 2000);
    }, { once: true });
    renderHistoryList(container);
    renderDraftRow(container);
    renderConflictRow(container);
    showUndoBar();
    // 桌面聚焦搜尋框；手機聚焦第一列（避免行動端鍵盤一開就擋住清單）
    setTimeout(() => {
        const isWide = window.matchMedia && window.matchMedia('(min-width: 900px)').matches;
        if (isWide) search.focus();
        else container.querySelector('.ar-history-item')?.focus();
    }, 30);
}

async function updateHistoryIndicators() {
    const count = articleStore.getRecords().length;
    if (dom.articleHistoryCount) {
        dom.articleHistoryCount.textContent = String(count);
        dom.articleHistoryCount.classList.toggle('hidden', count === 0);
    }
    const statusEl = dom.articleHistoryStatus;
    if (!statusEl) return;
    const record = articleContext.recordId ? articleStore.getRecord(articleContext.recordId) : null;
    const pendingSync = record && (record.dirty || record.pending);
    const edited = !!record && recordHasUnsavedInput(record);
    // 保存失敗是比「已載入記錄」更強的狀態：一般歷史指示器不得把它覆蓋成已保存（F3）。
    if (record && analysisSaveFailureFor(record)) {
        statusEl.hidden = false;
        statusEl.classList.remove('hidden');
        statusEl.textContent = t('article.historyStatusSaveFailed');
        statusEl.dataset.state = 'failed';
        statusEl.disabled = false;
    } else if (record && articleContext.origin === 'imported') {
        // 匯入的新內容還沒成為記錄：不能沿用上一篇的「已存入」
        statusEl.hidden = false;
        statusEl.classList.remove('hidden');
        statusEl.textContent = t('article.historyStatusUnsaved');
        statusEl.dataset.state = 'unsaved';
        statusEl.disabled = false;
    } else if (record && edited) {
        // 已載入記錄但內文被改過：分析後才會更新這一篇，現在還不算已存入
        statusEl.hidden = false;
        statusEl.classList.remove('hidden');
        statusEl.textContent = t('article.historyStatusEdited');
        statusEl.dataset.state = 'pending';
        statusEl.disabled = false;
    } else if (record) {
        statusEl.hidden = false;
        statusEl.classList.remove('hidden');
        statusEl.textContent = t('article.historyStatusSaved', { time: relativeTime(record.lastOpenedAt || record.updatedAt) });
        statusEl.dataset.state = pendingSync ? 'pending' : 'saved';
        statusEl.disabled = false;
    } else if ((dom.articleInput?.value || '').trim()) {
        const draft = await articleStore.readDraft().catch(() => null);
        const currentText = (dom.articleInput?.value || '').trim();
        // 只有「目前輸入就是那份草稿」才顯示草稿狀態，否則會誤導使用者
        const matchesDraft = !!draft && String(draft.text || '').trim() === currentText;
        statusEl.hidden = false;
        statusEl.classList.remove('hidden');
        statusEl.textContent = matchesDraft
            ? t('article.historyStatusDraft', { time: relativeTime(draft.savedAt) })
            : t('article.historyStatusUnsaved');
        statusEl.dataset.state = 'unsaved';
        statusEl.disabled = false;
    } else {
        statusEl.hidden = true;
        statusEl.classList.add('hidden');
    }
}

function toggleHistoryFromStatus() {
    openArticleHistory();
}

/**
 * 依據 state.currentArticleId 嘗試載入對應文章與分析結果。
 * 若找不到對應記錄，則不改變當前畫面。
 */
export async function showCurrentArticleIfAvailable() {
    const articleId = state.currentArticleId || null;
    if (!articleId) {
        ui.displayMessage(t('article.noArticleRecord'), 'info', 3500);
        return false;
    }
    const record = await articleStore.ensureArticleLoaded(articleId);
    if (!record || !record.article) {
        ui.displayMessage(t('article.analysisRecordMissing'), 'warning', 5000);
        return false;
    }
    applyRecordToView(record);
    return true;
}

// --- Article Reading ---

function handleReadButtonClick() {
    if (dom.stopReadArticleBtn.disabled) readArticle();
    else togglePauseResume();
}

// Build reading chunks from the rendered analysis DOM when available,
// falling back to raw text splitting when analysis is not present.
function buildReadingChunks(mode) {
    const perfStart = perfProbe.beginReadingChunks();
    const chunks = [];
    const area = dom.articleAnalysisContainer;
    // 原文已被修改：朗讀跟「最新輸入」，不從舊分析的 DOM 唸出舊版本。
    const hasRendered = !isArticleViewStale() && !!area.querySelector('.paragraph-pair');

    if (hasRendered) {
        const paraEls = Array.from(area.querySelectorAll('.paragraph-pair .paragraph-english'));
        // 原文已是中文的段落不交給英文 TTS 朗讀
        const isChineseSourcePara = (el) => el.parentElement?.dataset?.sourceLanguage === 'zh';
        // full 模式改為逐句朗讀（視覺效果更好，支援逐句高亮/淡化）
        const finishChunks = () => {
            perfProbe.markReadingChunks(perfStart, chunks);
            return chunks;
        };
        if (mode === 'paragraph') {
            paraEls.forEach(el => {
                if (isChineseSourcePara(el)) return;
                const text = Array.from(el.querySelectorAll('.interactive-sentence')).map(s => s.textContent.trim()).join(' ')
                    || el.textContent.trim();
                if (text) chunks.push({ type: 'paragraph', text, el });
            });
            return finishChunks();
        }
        // sentence / full mode：逐句
        paraEls.forEach(el => {
            if (isChineseSourcePara(el)) return;
            // 跳過純圖片段（避免朗讀 Markdown 或圖片連結）
            if (el.dataset && el.dataset.markdownImages === '1') return;
            if (el.querySelector && el.querySelector('img')) return;
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
        return finishChunks();
    }

    // Fallback when no analysis rendered yet
    const text = dom.articleInput.value.trim();
    if (!text) return chunks;
    const splitText = (text, m) => {
        if (m === 'paragraph') return text.split(/\n+/).filter(p => p.trim() !== '');
        if (m === 'sentence' || m === 'full') return text.match(/[^.!?]+[.!?]*/g) || [text];
        return [text];
    };
    const parts = splitText(text, mode);
    if (mode === 'paragraph') {
        parts.forEach(p => chunks.push({ type: 'paragraph', text: p, el: null }));
    } else {
        parts.forEach(s => chunks.push({ type: 'sentence', text: s, el: null }));
    }
    perfProbe.markReadingChunks(perfStart, chunks);
    return chunks;
}

let _playToken = 0; // 用於避免競態：切段期間舊的 onEnd 不再推進
// 文章朗讀被其他音訊（通常是單詞發音）打斷：恢復時只能重播本句，不能假裝續播。
let _interruptedByOtherAudio = false;
// 浮動播放控制（避免捲動後看不到控制）
let _floatingReader = null;
let _englishOnly = false;   // 僅顯示英文
let _followScroll = true;   // 是否跟隨朗讀自動捲動/淡化

// 朗讀列上不會隨播放狀態改變的按鈕文字（建立時與切換介面語言時都要套用）
const FLOATING_READER_LABELS = [
    ['.fr-prev', 'article.previousSentence'],
    ['.fr-next', 'article.nextSentence'],
    ['.fr-en', 'article.englishOnly'],
    ['.fr-follow', 'article.followScroll'],
    ['.fr-stop', 'article.finishReading'],
    ['.fr-close', 'article.close']
];

/**
 * 套用朗讀列的標題與無障礙文字。
 * 元素只在第一次朗讀時建立，之後切換介面語言不會重建，因此必須能手動刷新。
 */
function applyFloatingReaderTexts() {
    if (!_floatingReader) return;
    const handle = _floatingReader.querySelector('.fr-handle');
    if (handle) handle.title = t('article.readerDrag');
    _floatingReader.setAttribute('aria-label', t('article.readingControls'));
    FLOATING_READER_LABELS.forEach(([selector, key]) => {
        const button = _floatingReader.querySelector(selector);
        if (!button) return;
        button.title = t(key);
        button.setAttribute('aria-label', t(key));
    });
}

function ensureFloatingReader() {
    if (_floatingReader) return _floatingReader;
    const el = document.createElement('div');
    el.className = 'floating-reader';
    el.setAttribute('role', 'toolbar');
    el.innerHTML = `
        <span class="fr-handle" aria-hidden="true"><svg class="icon icon-sm" aria-hidden="true"><use href="#ic-grip"/></svg></span>
        <button type="button" class="fr-btn fr-prev"><svg class="icon icon-sm" aria-hidden="true"><use href="#ic-prev"/></svg></button>
        <button type="button" class="fr-btn fr-toggle"><svg class="icon icon-sm" aria-hidden="true"><use href="#ic-pause"/></svg></button>
        <button type="button" class="fr-btn fr-next"><svg class="icon icon-sm" aria-hidden="true"><use href="#ic-next"/></svg></button>
        <button type="button" class="fr-btn fr-en"><svg class="icon icon-sm" aria-hidden="true"><use href="#ic-eye"/></svg></button>
        <button type="button" class="fr-btn fr-follow"><svg class="icon icon-sm" aria-hidden="true"><use href="#ic-follow"/></svg></button>
        <button type="button" class="fr-btn fr-stop"><svg class="icon icon-sm" aria-hidden="true"><use href="#ic-stop"/></svg></button>
        <button type="button" class="fr-btn fr-close"><svg class="icon icon-sm" aria-hidden="true"><use href="#ic-close"/></svg></button>
    `;
    document.body.appendChild(el);
    _floatingReader = el;
    applyFloatingReaderTexts();
    el.querySelector('.fr-prev').addEventListener('click', () => { try { playPrevChunk(); } catch(_) {} });
    el.querySelector('.fr-next').addEventListener('click', () => { try { playNextChunk(); } catch(_) {} });
    el.querySelector('.fr-toggle').addEventListener('click', () => { try { togglePauseResume(); updateFloatingToggle(); } catch(_) {} });
    el.querySelector('.fr-stop').addEventListener('click', () => { try { stopReadArticle(); } catch(_) {} });
    el.querySelector('.fr-close').addEventListener('click', () => { hideFloatingReader(); });
    el.querySelector('.fr-en').addEventListener('click', () => {
        _englishOnly = !_englishOnly;
        try { dom.articleAnalysisContainer.classList.toggle('english-only', _englishOnly); } catch(_) {}
        updateFloatingToggle();
    });
    el.querySelector('.fr-follow').addEventListener('click', () => {
        _followScroll = !_followScroll;
        if (!_followScroll) {
            try { dom.articleAnalysisContainer.classList.remove('dim-others'); } catch(_) {}
        }
        updateFloatingToggle();
    });
    // 拖曳移動
    const handle = el.querySelector('.fr-handle');
    let dragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;
    const onMove = (e) => {
        if (!dragging) return;
        const x = (e.clientX || (e.touches && e.touches[0]?.clientX) || 0);
        const y = (e.clientY || (e.touches && e.touches[0]?.clientY) || 0);
        const dx = x - startX; const dy = y - startY;
        const left = Math.max(4, Math.min(window.innerWidth - el.offsetWidth - 4, startLeft + dx));
        const top  = Math.max(4, Math.min(window.innerHeight - el.offsetHeight - 4, startTop + dy));
        el.style.left = left + 'px';
        el.style.top = top + 'px';
        el.style.bottom = 'auto';
    };
    const onUp = () => {
        dragging = false;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('touchend', onUp);
    };
    const onDown = (e) => {
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        dragging = true; startX = (e.clientX || (e.touches && e.touches[0]?.clientX) || 0); startY = (e.clientY || (e.touches && e.touches[0]?.clientY) || 0);
        startLeft = rect.left; startTop = rect.top;
        document.addEventListener('mousemove', onMove, { passive: true });
        document.addEventListener('mouseup', onUp, { passive: true });
        document.addEventListener('touchmove', onMove, { passive: true });
        document.addEventListener('touchend', onUp, { passive: true });
    };
    handle.addEventListener('mousedown', onDown);
    handle.addEventListener('touchstart', onDown, { passive: true });
    return el;
}

function showFloatingReader() {
    const el = ensureFloatingReader();
    applyFloatingReaderTexts();
    el.classList.add('is-visible');
    // 讓底部訊息提示往上讓位，否則提示會蓋住整條播放控制
    document.body.classList.add('has-floating-reader');
    updateFloatingToggle();
}

function hideFloatingReader() {
    if (_floatingReader) _floatingReader.classList.remove('is-visible');
    document.body.classList.remove('has-floating-reader');
}

function updateFloatingToggle() {
    if (!_floatingReader) return;
    const btn = _floatingReader.querySelector('.fr-toggle');
    const isPaused = state.isReadingChunkPaused || !!dom.stopReadArticleBtn.disabled;
    // 與全站圖標體系一致：24 網格、1.7 描邊的 sprite 圖標
    const icon = (id) => `<svg class="icon icon-sm" aria-hidden="true"><use href="#ic-${id}"/></svg>`;
    if (btn) {
        btn.innerHTML = icon(isPaused ? 'play' : 'pause');
        btn.title = isPaused
            ? (_interruptedByOtherAudio ? t('article.replayChunk') : t('article.resume'))
            : t('article.pause');
        btn.setAttribute('aria-label', btn.title);
    }
    // EN-only 按鈕：切換圖標與高亮
    const enBtn = _floatingReader.querySelector('.fr-en');
    if (enBtn) {
        enBtn.classList.toggle('active', !!_englishOnly);
        enBtn.innerHTML = icon(_englishOnly ? 'eye-off' : 'eye');
        enBtn.setAttribute('aria-pressed', _englishOnly ? 'true' : 'false');
    }
    // 跟隨滾動按鈕高亮
    const followBtn = _floatingReader.querySelector('.fr-follow');
    if (followBtn) {
        followBtn.classList.toggle('active', !!_followScroll);
        followBtn.setAttribute('aria-pressed', _followScroll ? 'true' : 'false');
    }
}

function readArticle() {
    const text = dom.articleInput.value.trim();
    if (!text) {
        ui.displayMessage(t('article.enterArticleToRead'), 'warning');
        return;
    }
    const mode = dom.readingModeSelect.value;
    if (isArticleViewStale()) {
        // 不阻塞朗讀，但要說清楚唸的是最新輸入，不是畫面上的舊分析。
        ui.displayMessage(t('article.analysisStaleHint'), 'info', 5000);
        clearReadingHighlights();
    }
    state.setIsReadingChunkPaused(false);
    _interruptedByOtherAudio = false;
    const chunks = buildReadingChunks(mode === 'full' ? 'sentence' : mode);
    state.setReadingChunks(chunks);
    if (state.readingChunks.length > 0) {
        state.setCurrentChunkIndex(0);
        // 全文模式強制隱藏導航（雖然逐句朗讀，但視覺上仍視為全文）
        dom.chunkNavControls.classList.toggle('hidden', mode === 'full' || state.readingChunks.length <= 1);
        _playToken++; // 重置 token
        showFloatingReader();
        playCurrentChunk();
    }
}

function stopReadArticle() {
    audio.stopCurrentAudio();
    _interruptedByOtherAudio = false;
    state.setIsReadingChunkPaused(false);
    dom.stopReadArticleBtn.disabled = true;
    updateReadButtonUI('stopped');
    hideFloatingReader();
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
        dom.currentSentenceDisplay.textContent = (chunk?.type === 'full') ? t('article.readingFull') : (chunk?.text || '');
    }

    const repeatTimesVal = parseInt(dom.chunkRepeatTimes.value, 10) || 1;
    
    const token = ++_playToken;
    const onStatus = (status) => {
        // 已經切段／停止的舊音訊，不得再改目前 UI。
        if (token !== _playToken) return;
        updatePlaybackStatus(status);
    };
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
    // 使用全局英語朗讀首選
    audio.speakText(chunk?.text || String(chunk || ''), 'english', state.currentSpeed, () => {
        if (token !== _playToken) return;
        dom.stopReadArticleBtn.disabled = false;
        updateReadButtonUI('playing');
        updateChunkNav();
    }, onEnd, { owner: 'article-reading', onStatus });
}

function playNextChunk() {
    // 防止在非播放状态下切换
    if (dom.stopReadArticleBtn.disabled) return;
    showFloatingReader();
    
    if (state.currentChunkIndex < state.readingChunks.length - 1) {
        audio.stopCurrentAudio();
        _playToken++; // 取消前一段的 onEnd 推進
        _interruptedByOtherAudio = false;
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
    showFloatingReader();
    
    if (state.currentChunkIndex > 0) {
        audio.stopCurrentAudio();
        _playToken++;
        _interruptedByOtherAudio = false;
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
    // 朗讀進行中使用者又按了播放／暫停：把先前用「關閉」收掉的朗讀列帶回來，
    // 否則關掉後就再也叫不回來（關閉只收起控制條，不會停止朗讀）。
    if (!dom.stopReadArticleBtn.disabled) showFloatingReader();
    audio.stopCurrentAudio();
    state.setIsReadingChunkPaused(!wasPaused);
    if (wasPaused) {
        if (_interruptedByOtherAudio) {
            // 只提示一次；恢復是從本句開頭重播，不是從被單詞發音打斷的時間點續播。
            _interruptedByOtherAudio = false;
            ui.displayMessage(t('article.playbackPausedByPronunciation'), 'info', 4000);
        }
        playCurrentChunk();
        updateReadButtonUI('playing');
    } else {
        updateReadButtonUI('paused');
        // 不在播放狀態時，移除整體淡化效果
        try { dom.articleAnalysisContainer.classList.remove('dim-others'); } catch (_) {}
    }
    updateFloatingToggle();
}

/**
 * 音訊層回報的播放狀態（P2-T1）。
 * loading 只更新 UI，不假裝已開始；error 要停止朗讀並讓按鈕可再按。
 */
function updatePlaybackStatus(status = {}) {
    const audioState = status?.state;
    if (!audioState) return;
    if (audioState === 'loading') {
        if (!state.readingChunks || !state.readingChunks.length) return;
        dom.stopReadArticleBtn.disabled = false;
        updateReadButtonUI('playing');
        dom.readArticleBtn.title = t('article.loading');
        dom.readArticleBtn.setAttribute('aria-label', t('article.loading'));
        return;
    }
    if (audioState === 'playing') {
        if (!state.readingChunks || !state.readingChunks.length) return;
        dom.stopReadArticleBtn.disabled = false;
        updateReadButtonUI('playing');
        updateChunkNav();
        return;
    }
    if (audioState === 'error') {
        console.warn('文章朗讀音訊失敗:', status?.error || '');
        ui.displayMessage(t('article.audioFailed'), 'error', 5000);
        stopReadArticle();
    }
}

function updateReadButtonUI(status) {
    const icon = dom.readArticleBtn.querySelector('svg');
    const icons = {
        play: '<path d="m11.596 8.697-6.363 3.692c-.54.313-1.233-.066-1.233-.697V4.308c0-.63.692-1.01 1.233-.696l6.363 3.692a.802.802 0 0 1 0 1.393z"/>',
        pause: '<path d="M5.5 3.5A1.5 1.5 0 0 1 7 5v6a1.5 1.5 0 0 1-3 0V5a1.5 1.5 0 0 1 1.5-1.5m5 0A1.5 1.5 0 0 1 12 5v6a1.5 1.5 0 0 1-3 0V5a1.5 1.5 0 0 1 1.5-1.5z"/>'
    };
    icon.innerHTML = status === 'playing' ? icons.pause : icons.play;
    const label = status === 'playing'
        ? t('article.pause')
        : (status === 'paused'
            ? (_interruptedByOtherAudio ? t('article.replayChunk') : t('article.resume'))
            : t('article.read'));
    dom.readArticleBtn.title = label;
    // 動態狀態不能用 data-i18n-aria-label，否則 locale 套用時會被靜態值蓋回。
    dom.readArticleBtn.setAttribute('aria-label', label);
    // 同步更新浮動控制的暫停/播放按鈕
    updateFloatingToggle();
}

/**
 * 播放與下載的能力不同：朗讀有系統語音後備，下載必須有可連線的遠端 TTS。
 * 按鈕不隱藏，只用 title／aria-label 說明目前能不能下載，避免使用者以為按鈕壞了。
 */
function updateDownloadAvailability() {
    const button = dom.downloadAudioBtn;
    if (!button) return;
    const target = typeof audio.describeTtsTarget === 'function'
        ? audio.describeTtsTarget()
        : { configured: audio.isRemoteTtsConfigured(), host: '' };
    const label = target.configured ? t('article.downloadAudio') : t('article.downloadNeedsRemote');
    button.title = label;
    button.setAttribute('aria-label', label);
    if (target.configured) button.removeAttribute('data-download-unavailable');
    else button.setAttribute('data-download-unavailable', '1');
}

function updateChunkNav() {
    dom.chunkProgressSpan.textContent = `${state.currentChunkIndex + 1} / ${state.readingChunks.length}`;
    dom.prevChunkBtn.disabled = state.currentChunkIndex === 0;
    dom.nextChunkBtn.disabled = state.currentChunkIndex === state.readingChunks.length - 1;
}

function clearReadingHighlights() {
    dom.articleAnalysisContainer.querySelectorAll('.interactive-sentence.sentence-active').forEach(el => el.classList.remove('sentence-active'));
    dom.articleAnalysisContainer.querySelectorAll('.interactive-sentence-zh.sentence-active').forEach(el => el.classList.remove('sentence-active'));
    dom.articleAnalysisContainer.querySelectorAll('.paragraph-english.para-active').forEach(el => el.classList.remove('para-active'));
    dom.articleAnalysisContainer.querySelectorAll('.paragraph-chinese.para-active').forEach(el => el.classList.remove('para-active'));
    dom.articleAnalysisContainer.classList.remove('full-reading-active');
    dom.articleAnalysisContainer.classList.remove('dim-others');
}

function highlightCurrentChunk(chunk) {
    clearReadingHighlights();
    if (!chunk) return;
    if (chunk.type === 'sentence' && chunk.el) {
        const paraIdx = chunk.el.getAttribute('data-para-index');
        const sentIdx = chunk.el.getAttribute('data-sent-index');
        chunk.el.classList.add('sentence-active');
        if (paraIdx != null && sentIdx != null) {
            const zh = dom.articleAnalysisContainer.querySelector(`.interactive-sentence-zh[data-para-index="${paraIdx}"][data-sent-index="${sentIdx}"]`);
            if (zh) zh.classList.add('sentence-active');
        }
        // 僅在實際播放時才啟用淡化（暫停或未播放時不淡化）
        if (!state.isReadingChunkPaused && _followScroll) { dom.articleAnalysisContainer.classList.add('dim-others'); }
        // 確保可視：僅在跟隨滾動時置中，避免失去控制
        if (_followScroll) { try { chunk.el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) {} }
    } else if (chunk.type === 'paragraph' && chunk.el) {
        chunk.el.classList.add('para-active');
        try {
            const zhPara = chunk.el.parentElement?.querySelector('.paragraph-chinese');
            if (zhPara) zhPara.classList.add('para-active');
        } catch (_) {}
        if (_followScroll) { try { chunk.el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) {} }
        dom.articleAnalysisContainer.classList.remove('dim-others');
    } else if (chunk.type === 'full') {
        // 已不再用 full 單片段，保留兼容，但遵循播放狀態
        if (!state.isReadingChunkPaused && _followScroll) dom.articleAnalysisContainer.classList.add('dim-others');
        try { dom.articleAnalysisContainer.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (_) {}
    }
}

// 全文下載是一次 GET 請求；太長的字串容易讓 TTS 服務逾時或回空檔。
// 超過此門檻時先阻擋，建議改用段落／句子（依實測可調）。
const DOWNLOAD_FULL_TEXT_LIMIT = 1800;

/** 以實際送給 TTS 的文字長度估算；與 buildTTSUrl 的 t 參數一致。 */
function estimateDownloadCharCount(text) {
    try {
        const url = new URL(audio.buildTTSUrl(text, 'english', state.currentSpeed), window.location.href);
        const value = url.searchParams.get('t');
        if (value != null) return value.length;
    } catch (_) { /* 設定缺失時退回原始字串長度 */ }
    return String(text || '').length;
}

async function downloadAudio() {
    const raw = dom.articleInput.value.trim();
    if (!raw) { ui.displayMessage(t('article.enterArticle'), 'warning'); return; }

    // 下載沒有系統語音後備：先說清楚能力，不開空白分頁。
    const target = typeof audio.describeTtsTarget === 'function'
        ? audio.describeTtsTarget()
        : { configured: audio.isRemoteTtsConfigured(), host: '' };
    if (!target.configured) {
        ui.displayMessage(t('article.downloadNeedsRemote'), 'warning');
        return;
    }

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

    // 範圍與長度說明要在開啟連結前先講清楚。
    const scopeLabel = mode === 'paragraph'
        ? t('article.paragraph')
        : (mode === 'sentence' ? t('article.sentence') : t('article.full'));
    if (mode === 'full' && estimateDownloadCharCount(textToDownload) > DOWNLOAD_FULL_TEXT_LIMIT) {
        ui.displayMessage(t('article.downloadLongText'), 'warning', 5000);
        return;
    }

    const scopeLine = t('article.downloadScope', { scope: scopeLabel });
    const message = target.host ? `${scopeLine} · ${target.host}` : scopeLine;
    const confirmed = await ui.confirmAction({
        title: t('article.downloadAudio'),
        message,
        confirmLabel: t('article.downloadAudio')
    });
    if (!confirmed) return;

    const makeSlug = (s) => (s || '').toLowerCase().replace(/[^a-z0-9\s-]/g,'').trim().replace(/\s+/g,'-').replace(/-+/g,'-') || 'article';
    const { title } = parseTitleAndParagraphs(raw);
    const base = title ? makeSlug(title) : makeSlug(textToDownload.slice(0, 40));
    const fname = `${base}-${mode === 'full' ? 'full' : mode}.mp3`;
    try {
        const result = await audio.downloadTextAsAudio(textToDownload, 'english', state.currentSpeed, fname, { pitch: 0, style: 'general', download: true });
        if (result && result.ok === false) {
            ui.displayMessage(t('article.downloadAudioFailed'), 'error');
            return;
        }
    } catch (err) {
        // 不記錄含 api_key 的 URL；只保留錯誤類型。
        console.error('下載音頻失敗:', err?.name || 'error');
        ui.displayMessage(t('article.downloadAudioFailed'), 'error');
        return;
    }
    // 只宣稱已開啟連結；是否完成由瀏覽器與 TTS 服務決定。
    ui.displayMessage(t('article.downloadLinkOpened'), 'info', 5000);
}

// --- Article Library ---


// --- Article Library ---
let _articleLibraryData = [];

function renderArticleLibraryList(filter = {}) {
    const cat = (filter.category || '').trim();
    const items = _articleLibraryData.filter(a => !cat || (a.category || '') === cat);
    if (dom.articleLibraryCount) dom.articleLibraryCount.textContent = t('article.articleCount', { count: items.length });
    if (items.length === 0) {
        dom.articleLibraryList.innerHTML = `<p>${t('article.noLibraryMatch')}</p>`;
        return;
    }
    dom.articleLibraryList.innerHTML = items.map(article => `
        <div class="article-library-item" data-path="${escapeAttr(article.path)}" data-category="${escapeAttr(article.category || '')}">
            <h4>${escapeHtml(article.title)}</h4>
            <p class="description">${escapeHtml(article.description)}</p>
            <div class="meta">
                <span class="difficulty">${escapeHtml(article.difficulty)}</span>
                <span class="category">${escapeHtml(article.category || t('article.uncategorized'))}</span>
            </div>
        </div>`).join('');
    dom.articleLibraryList.querySelectorAll('.article-library-item').forEach(item => {
        item.addEventListener('click', () => loadArticleFromLibrary(item.dataset.path));
    });
}

async function openArticleLibrary() {
    dom.articleLibraryList.innerHTML = `<p>${t('article.loadingLibrary')}</p>`;
    dom.articleLibraryModal.classList.remove('hidden');
    try {
        if (!_articleLibraryData || _articleLibraryData.length === 0) {
            const response = await fetch('articles/manifest.json');
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            _articleLibraryData = await response.json();
        }

        if (!_articleLibraryData || _articleLibraryData.length === 0) {
            dom.articleLibraryList.innerHTML = `<p>${t('article.emptyLibrary')}</p>`;
            return;
        }

        // 構建分類下拉
        if (dom.articleCategoryFilter) {
            const cats = Array.from(new Set(_articleLibraryData.map(a => a.category || t('article.uncategorized'))));
            const prev = dom.articleCategoryFilter.value || '';
            dom.articleCategoryFilter.innerHTML = [`<option value="">${t('article.allCategories')}</option>`]
                .concat(cats.map(c => `<option value="${escapeAttr(c)}">${escapeHtml(c)}</option>`))
                .join('');
            dom.articleCategoryFilter.value = prev;
            dom.articleCategoryFilter.onchange = () => {
                renderArticleLibraryList({ category: dom.articleCategoryFilter.value });
            };
        }

        renderArticleLibraryList({ category: dom.articleCategoryFilter ? dom.articleCategoryFilter.value : '' });
    } catch (error) {
        console.error('無法加載文章庫:', error);
        dom.articleLibraryList.innerHTML = `<p class="analysis-error">${t('article.loadLibraryFailed')}</p>`;
    }
}
async function loadArticleFromLibrary(path) {
    try {
        const response = await fetch(path);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const article = await response.json();
        // 將標題一併插入正文最前面，以 Markdown 風格 # 開頭展示
        const titleText = (article && article.title) ? String(article.title) : '';
        const title = titleText ? `# ${titleText}\n\n` : '';
        // 從文章庫匯入是「另一篇」：先解除目前的文章綁定，避免寫進上一篇
        applyImportedArticle(`${title}${article.content || ''}`.trim(), {
            sourceType: 'file',
            sourceUrl: path,
            title: titleText
        });
        closeArticleLibrary();
    } catch (error) {
        console.error(`無法從 ${path} 加載文章:`, error);
        ui.displayMessage(t('article.loadArticleFailed'), 'error');
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
    const rawTarget = e.target && e.target.nodeType === 3 ? e.target.parentElement : e.target;
    // 連結與程式碼片段保留原生行為：不攔截、不 preventDefault、不開查詞。
    if (rawTarget?.closest && rawTarget.closest('a, code, pre, kbd, samp')) return;
    if (rawTarget?.classList && rawTarget.classList.contains('interactive-word')) {
        e.stopPropagation();
        try {
            const analysisArray = JSON.parse(dom.articleAnalysisContainer.dataset.analysis || '[]');
            // 無論是否已有分析資料，都嘗試顯示；若無命中，showArticleWordAnalysis 會走懶載
            showArticleWordAnalysis(rawTarget, Array.isArray(analysisArray) ? analysisArray : []);
        } catch (err) {
            console.error("Failed to parse analysis data:", err);
            // 解析失敗時也嘗試以空陣列啟動懶載
            showArticleWordAnalysis(rawTarget, []);
        }
    }
}

// Sentence analyze button to lazy-load sentence analysis
dom.articleAnalysisContainer.addEventListener('click', async (ev) => {
    const rawTarget = ev.target && ev.target.nodeType === 3 ? ev.target.parentElement : ev.target;
    // 連結與程式碼片段維持原生行為：不 preventDefault、不開句卡、不開查詞。
    if (rawTarget?.closest && rawTarget.closest('a, code, pre, kbd, samp')) return;
    // 1) 點句子本體即開合句卡（解析鍵改為內嵌後，右側熱區已移除，整句都是點擊範圍）
    const wrap = rawTarget?.closest && rawTarget.closest('.sentence-wrap');
    const isIcon = rawTarget?.closest && rawTarget.closest('.sent-analyze-btn');
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
    const chunkBtn = rawTarget?.closest && rawTarget.closest('.chunk-explain');
    if (chunkBtn) {
        ev.stopPropagation();
        ev.preventDefault();
        const card = chunkBtn.closest('.sentence-card');
        if (!card) return;
        const phrase = chunkBtn.getAttribute('data-phrase') || '';
        if (!phrase) return;
        // 卡片建立時的歸屬已失效：不得把舊卡片的詳解寫成目前版本。
        const chunkTarget = sentenceCardTarget(card);
        if (sentenceCardTargetStale(chunkTarget)) {
            ui.displayMessage(t('article.staleSentenceCard'), 'warning');
            return;
        }
        const sentence = card.dataset.sentence || '';
        const context = card.dataset.context || '';
        const paraIdx = parseInt(card.dataset.paraIdx, 10) || 0;
        const sentIdx = parseInt(card.dataset.sentIdx, 10) || 0;
        // 請求前凍結：卡片自己的文章、帳戶、版本與 occurrence（重複句不重算位置）。
        const chunkArticleId = chunkTarget.articleId;
        const chunkContentVersion = chunkTarget.contentVersion;
        const chunkActionCtx = chunkTarget.actionContext || readingActions.captureActionContext();
        const chunkArticleCtx = chunkTarget.articleContext || articleStore.captureArticleContext();
        chunkBtn.disabled = true; chunkBtn.textContent = t('article.detailsLoading');
        try {
            // 精確句子錨點用來定位句內短語，不重算成目前正文的第一處。
            const chunkAnchor = sentencePhraseAnchor(chunkTarget, phrase)
                || readingActions.resolveAnchor(chunkArticleId, phrase, sentence);
            const res = await analyzePhraseWithSaved(phrase, sentence, context, chunkArticleId, isCurrentArticle(chunkArticleId), { anchor: chunkAnchor, contentVersion: chunkContentVersion, actionContext: chunkActionCtx });
            const box = document.createElement('div');
            box.className = 'phrase-explain-box';
            const esc = escapeHtml;
            const ex = Array.isArray(res.analysis?.examples) ? res.analysis.examples.slice(0,2) : [];
            box.innerHTML = `<div class="phrase-explain-head">
                               <div><strong>${esc(res.selection || phrase)}</strong>：${esc(res.analysis?.meaning || '')}
                                   ${res.analysis?.usage ? `<div>${t('article.usageLabel')}${esc(res.analysis.usage)}</div>`:''}
                                   ${ex.length? '<div>' + ex.map(x=>`<div>• ${esc(x.en)} — ${esc(x.zh)}</div>`).join('') + '</div>' : ''}
                               </div>
                               <button class="phrase-close">${t('article.close')}</button>
                             </div>`;
            if (!card.isConnected || sentenceCardTargetStale(chunkTarget)) return;
            const chunkItem = chunkBtn.closest('.chunk-item');
            if (chunkItem) chunkItem.after(box);
            else card.appendChild(box);
            // 持久化片語解析
            try { persistPhraseAnalysis(phrase, sentence, context, res, chunkArticleId, chunkArticleCtx, { contentVersion: chunkContentVersion, actionContext: chunkActionCtx }); } catch (_) {}
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
            ui.displayMessage(t('article.analysisRetry'), 'warning');
        } finally {
            chunkBtn.disabled = false; chunkBtn.textContent = t('article.details');
        }
        return;
    }
    const btn = rawTarget?.closest && rawTarget.closest('.sent-analyze-btn');
    if (!btn) return;
    ev.stopPropagation();
    clearSentenceLink();   // 句卡要開了，懸停提示先收掉
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
        // 卡片建立時的歸屬已失效：不得把舊卡片的詳解寫成目前版本。
        const chunkTarget = sentenceCardTarget(card);
        if (sentenceCardTargetStale(chunkTarget)) {
            ui.displayMessage(t('article.staleSentenceCard'), 'warning');
            return;
        }
        const sentence = card.dataset.sentence || '';
        const context = card.dataset.context || '';
        const paraIdx = parseInt(card.dataset.paraIdx, 10) || 0;
        const sentIdx = parseInt(card.dataset.sentIdx, 10) || 0;
        // Modal 內的片語詳解同樣以卡片建立時的句境為準，不讀最新選區。
        const chunkArticleId = chunkTarget.articleId;
        const chunkContentVersion = chunkTarget.contentVersion;
        const chunkActionCtx = chunkTarget.actionContext || readingActions.captureActionContext();
        const chunkArticleCtx = chunkTarget.articleContext || articleStore.captureArticleContext();
        chunkBtn.disabled = true; chunkBtn.textContent = t('article.detailsLoading');
        try {
            const chunkAnchor = sentencePhraseAnchor(chunkTarget, phrase)
                || readingActions.resolveAnchor(chunkArticleId, phrase, sentence);
            const res = await analyzePhraseWithSaved(phrase, sentence, context, chunkArticleId, isCurrentArticle(chunkArticleId), { anchor: chunkAnchor, contentVersion: chunkContentVersion, actionContext: chunkActionCtx });
            const box = document.createElement('div');
            box.className = 'phrase-explain-box';
            const esc = escapeHtml;
            const ex = [];
            try { const arr = res?.analysis?.examples; if (Array.isArray(arr)) arr.slice(0,2).forEach(x => ex.push(x)); } catch (_) {}
            box.innerHTML = `<div class="phrase-explain-head">
                               <div><strong>${esc(res.selection || phrase)}</strong>：${esc(res.analysis?.meaning || '')}
                                   ${res.analysis?.usage ? `<div>${t('article.usageLabel')}${esc(res.analysis.usage)}</div>`:''}
                                   ${ex.length? '<div>' + ex.map(x=>`<div>• ${esc(x.en)} — ${esc(x.zh)}</div>`).join('') + '</div>' : ''}
                               </div>
                               <button class="phrase-close">${t('article.close')}</button>
                             </div>`;
            if (!card.isConnected || sentenceCardTargetStale(chunkTarget)) return;
            const chunkItem = chunkBtn.closest('.chunk-item');
            if (chunkItem) chunkItem.after(box); else card.appendChild(box);
            try { persistPhraseAnalysis(phrase, sentence, context, res, chunkArticleId, chunkArticleCtx, { contentVersion: chunkContentVersion, actionContext: chunkActionCtx }); } catch (_) {}
            applySentenceDim(paraIdx, sentIdx, true);
            const closeBtn = box.querySelector('.phrase-close');
            if (closeBtn) closeBtn.addEventListener('click', () => {
                box.remove();
                if (!card.querySelector('.phrase-explain-box')) applySentenceDim(paraIdx, sentIdx, false);
            });
        } catch (err) {
            console.warn('片語詳解請求失敗(Modal):', err);
            ui.displayMessage(t('article.analysisRetry'), 'warning');
        } finally {
            chunkBtn.disabled = false; chunkBtn.textContent = t('article.details');
        }
    });
} catch (_) {}

// Tooltip actions delegation: phrase analysis buttons
dom.analysisTooltip.addEventListener('click', async (e) => {
    // 在 tooltip 內的任何點擊都不向外冒泡，避免觸發外層關閉/重繪邏輯
    e.stopPropagation();
    const rawTarget = e.target && e.target.nodeType === 3 ? e.target.parentElement : e.target;
    if (rawTarget?.closest && rawTarget.closest('.tooltip-close')) {
        dismissWordTooltip({ restoreFocus: true, source: 'close-button' });
        return;
    }
    const btnPhrase = rawTarget?.closest && rawTarget.closest('.btn-analyze-phrase');
    const btnPick = rawTarget?.closest && rawTarget.closest('.btn-pick-phrase');
    const btnCustom = rawTarget?.closest && rawTarget.closest('.btn-analyze-phrase-custom');
    const btnPlay = rawTarget?.closest && rawTarget.closest('.btn-play-word');
    if (btnPlay) {
        const w = btnPlay.getAttribute('data-word') || '';
        if (w) audio.speakText(w, 'english', 0, null, null, { owner: 'word-pronunciation' });
        return;
    }
    const btnAdd = rawTarget?.closest && rawTarget.closest('.btn-add-to-book');
    const btnMark = rawTarget?.closest && rawTarget.closest('.btn-toggle-mark');
    const btnNote = rawTarget?.closest && rawTarget.closest('.btn-note-item');
    if (btnAdd || btnMark || btnNote) {
        e.stopPropagation();
        const button = btnAdd || btnMark || btnNote;
        const readTarget = () => {
            const articleId = button.getAttribute('data-article-id') || articleContext.recordId || '';
            const quote = (button.getAttribute('data-quote') || button.getAttribute('data-word') || '').trim();
            const sentence = button.getAttribute('data-sentence') || '';
            const context = button.getAttribute('data-context') || '';
            const sentenceStart = parseInt(button.getAttribute('data-sentence-start'), 10);
            const startOffset = parseInt(button.getAttribute('data-start-offset'), 10);
            const anchorStart = parseInt(button.getAttribute('data-anchor-start'), 10);
            const anchorEnd = parseInt(button.getAttribute('data-anchor-end'), 10);
            const hint = Number.isFinite(sentenceStart) && sentenceStart >= 0 && Number.isFinite(startOffset) && startOffset >= 0
                ? sentenceStart + startOffset
                : -1;
            // 按鈕記著自己那一個 occurrence 的精確 offset；不重算、不退回全文文字搜尋。
            const exactAnchor = readingActions.anchorFromOffsets(articleId, quote, anchorStart, anchorEnd);
            return {
                articleId,
                kind: button.getAttribute('data-kind') === 'phrase' || /\s/.test(quote) ? 'phrase' : 'word',
                quote,
                sentence,
                context,
                contentVersion: button.getAttribute('data-content-version') || '',
                anchor: exactAnchor || readingActions.resolveAnchor(articleId, quote, sentence, hint)
            };
        };
        const prev = button.textContent;
        button.disabled = true;
        button.textContent = t('qa.adding');
        button.setAttribute('aria-busy', 'true');
        try {
            const target = readTarget();
            if (!target.articleId || !target.quote) throw new Error('missing_target');
            // 帳戶／文章切換後，舊彈窗按鈕不得寫入新 scope。
            const actionContext = wordTooltipContext?.actionContext || readingActions.captureActionContext();
            if (!readingActions.actionContextActive(actionContext)) throw new Error('stale_scope');
            const ensured = await readingActions.ensureItem({ ...target, actionContext });
            if (!ensured.ok) throw new Error(ensured.error);
            const item = readingStore.getLearningItem(ensured.entity.id) || ensured.entity;
            if (btnMark) {
                const result = await readingActions.setMarked(item.id, item.marked !== true, actionContext);
                if (!result.ok) throw new Error(result.error);
                const marked = result.entity?.marked === true;
                button.textContent = marked ? t('article.unmarkThis') : t('article.markThis');
                button.setAttribute('aria-pressed', marked ? 'true' : 'false');
                ui.displayMessage(marked ? t('article.markAdded') : t('article.markRemoved'), 'success');
            } else if (btnNote) {
                const opened = await openReadingPanelForItem(target.articleId, item.id);
                if (!opened.ok) throw new Error(opened.error || 'panel_failed');
            } else {
                const result = await readingActions.addItemToVocabulary(item, {
                    context: target.context,
                    sentence: target.sentence,
                    meaning: button.getAttribute('data-meaning') || '',
                    phonetic: button.getAttribute('data-phonetic') || '',
                    pos: button.getAttribute('data-pos') || ''
                });
                if (!result || result.ok === false) throw new Error(result?.error || 'failed');
                button.textContent = result.reason === 'duplicate' ? t('qa.exists') : t('qa.added');
                const markButton = dom.analysisTooltip.querySelector('.btn-toggle-mark');
                if (markButton) {
                    markButton.textContent = t('article.unmarkThis');
                    markButton.setAttribute('aria-pressed', 'true');
                }
            }
        } catch (err) {
            console.warn('閱讀記錄動作失敗:', err);
            button.textContent = t('qa.failed');
        } finally {
            button.removeAttribute('aria-busy');
            button.disabled = false;
            if (btnAdd) {
                setTimeout(() => { button.textContent = prev || t('article.addToWordbook'); }, 1000);
            } else if (btnNote) {
                button.textContent = prev || t('article.writeNote');
            }
        }
        return;
    }
    if (btnPick) {
        const sentence = btnPick.getAttribute('data-sentence') || '';
        const startWord = btnPick.getAttribute('data-default') || '';
        openPhrasePicker({
            articleId: btnPick.getAttribute('data-article-id') || articleContext.recordId || '',
            sentence,
            context: btnPick.getAttribute('data-context') || '',
            startWord,
            sentenceStart: parseInt(btnPick.getAttribute('data-sentence-start'), 10),
            startOffset: parseInt(btnPick.getAttribute('data-start-offset'), 10)
        });
        return;
    }
    if (!btnPhrase && !btnCustom) return;
    // 已在最上方 stopPropagation；此處保持語義一致
    const sentence = (btnPhrase || btnCustom).getAttribute('data-sentence') || '';
    const context = (btnPhrase || btnCustom).getAttribute('data-context') || '';
    let selection = (btnPhrase || btnCustom).getAttribute('data-default') || '';
    if (btnCustom) {
        const input = prompt(t('article.phrasePrompt'), selection);
        if (!input) return;
        selection = input.trim();
    }
    const resultBox = dom.analysisTooltip.querySelector('.tooltip-phrase-result');
    if (resultBox) resultBox.textContent = t('article.analyzingSelection');
    try {
        const res = await api.analyzeSelection(selection, sentence, context, { timeoutMs: 15000 });
        if (resultBox) {
            const esc = escapeHtml;
            const ex = Array.isArray(res.analysis?.examples) ? res.analysis.examples.slice(0,2) : [];
            const phon = (res.analysis?.phonetic || '').replace(/^\/|\/$/g, '');
            resultBox.innerHTML = `<div><strong>${t('article.phraseLabel')}</strong> ${esc(res.selection || selection)}${phon ? ` <span class=\"tooltip-phonetic\">/${esc(phon)}/</span>` : ''}</div>
                                   <div><strong>${t('article.meaningLabel')}</strong> ${esc(res.analysis?.meaning || '')}</div>
                                   ${res.analysis?.usage ? `<div><strong>${t('article.usageLabel')}</strong> ${esc(res.analysis.usage)}</div>`:''}
                                   ${ex.length? '<div class="phrase-result-examples">' + ex.map(x=>`<div>• ${esc(x.en)} — ${esc(x.zh)}</div>`).join('') + '</div>' : ''}`;
        }
    } catch (err) {
        if (resultBox) resultBox.innerHTML = `<span class="text-danger">${t('article.analysisRetryShort')}</span>`;
    }
});

let wordTooltipSession = 0;
// 目前顯示中的單詞彈窗所屬上下文（帳戶＋內文版本），供按鈕動作沿用。
let wordTooltipContext = null;
// 單詞彈窗的觸發詞、最後一次內容與重畫函式（locale 切換時使用）。
let wordTooltipTrigger = null;
let wordTooltipReturnFocus = null;
let wordTooltipLastPayload = null;
let wordTooltipRender = null;
let wordTooltipKeyboardOpen = false;

function isWordTooltipVisible() {
    return !!dom.analysisTooltip && dom.analysisTooltip.style.display === 'block';
}

/** 窄屏改用固定底部 sheet；同時清掉桌機留下的 inline top/left，避免與 bottom 定位衝突。 */
function syncWordTooltipSheetMode() {
    const tooltip = dom.analysisTooltip;
    if (!tooltip) return;
    const sheet = !!(window.matchMedia && window.matchMedia('(max-width: 640px)').matches);
    tooltip.classList.toggle('tooltip-sheet', sheet);
    if (sheet) {
        tooltip.style.top = '';
        tooltip.style.left = '';
    }
}

function resetWordTooltipState() {
    wordTooltipSession += 1;
    wordTooltipContext = null;
    wordTooltipTrigger = null;
    wordTooltipReturnFocus = null;
    wordTooltipLastPayload = null;
    wordTooltipRender = null;
    wordTooltipKeyboardOpen = false;
}

/** 焦點回觸發詞：滑鼠開的詞原本不可聚焦，暫時給 tabindex=-1 並在失焦時移除。 */
function focusWordTrigger(element) {
    if (!element || !element.isConnected) return false;
    const hadTabindex = element.hasAttribute('tabindex');
    if (!hadTabindex) {
        element.setAttribute('tabindex', '-1');
        element.addEventListener('blur', () => {
            if (element.getAttribute('tabindex') === '-1') element.removeAttribute('tabindex');
        }, { once: true });
    }
    try { element.focus(); } catch (_) { return false; }
    return document.activeElement === element;
}

function focusWordTooltipTitle() {
    const title = dom.analysisTooltip?.querySelector('#word-tooltip-title');
    if (!title) return;
    try { title.focus({ preventScroll: true }); } catch (_) { try { title.focus(); } catch (_) {} }
}

/**
 * 關閉單詞詳解。Escape／關閉鈕會把焦點還給觸發詞；外部點擊只清狀態、不搶焦點。
 */
function dismissWordTooltip({ restoreFocus = false, source = 'article' } = {}) {
    const target = wordTooltipReturnFocus || wordTooltipTrigger;
    resetWordTooltipState();
    try { ui.hideTooltip(source); } catch (_) {
        try { dom.analysisTooltip.style.display = 'none'; } catch (__) { /* noop */ }
    }
    // 收起後不留舊詞標題／內容：否則畫面上雖然看不到，輔助技術或下一次
    // 顯示前的探測仍會讀到上一個版本的字。
    try { dom.analysisTooltip.innerHTML = ''; } catch (_) { /* noop */ }
    if (restoreFocus) focusWordTrigger(target);
}

/** 用最後一次內容重畫可見中的詳解（locale 切換用）；沒有內容就回 false。 */
function rerenderVisibleWordTooltip() {
    if (!wordTooltipLastPayload || !wordTooltipRender || !isWordTooltipVisible()) return false;
    wordTooltipRender();
    return true;
}

function showArticleWordAnalysis(clickedElement, analysisArray, options = {}) {
    // P3-T5：記錄「點詞 → tooltip 可見」；probe 關閉時 no-op。
    perfProbe.beginWordTooltip();
    // 點擊當下的文章就是這次請求的歸屬；回應回來時不再讀取「目前文章」。
    const targetArticleId = articleContext.recordId || '';
    const wordText = clickedElement.dataset.word || clickedElement.textContent;

    // 句子直接取自包裹的 interactive-sentence（渲染時已寫入 data-sentence），
    // 避免二次分句與子字串匹配造成句子錯配
    const englishContainer = clickedElement.closest('.paragraph-english');
    const pairContainer = clickedElement.closest('.paragraph-pair');
    const paraEnglish = pairContainer ? (pairContainer.getAttribute('data-english') || englishContainer?.textContent || '') : (englishContainer?.textContent || '');
    const sentenceEl = clickedElement.closest('.interactive-sentence');
    const sentence = ((sentenceEl && (sentenceEl.getAttribute('data-sentence') || sentenceEl.textContent)) || paraEnglish).trim();

    // 命中查找需同時比對單詞與句子，避免多義詞拿到其他句境的舊解釋
    const normText = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const wordAnalysisData = analysisArray.find(item => item.word
        && item.word.toLowerCase() === (wordText || '').toLowerCase()
        && normText(item.sentence) === normText(sentence)) || null;

    // 本次查詞的固定上下文：session 只認最新一次查詞；articleId、內文版本、
    // 錨點與帳戶都在點擊當下凍結，延遲回應不得改寫新選詞／新版本／新帳戶。
    const session = ++wordTooltipSession;
    const actionContext = readingActions.captureActionContext();
    const articleContextSnapshot = articleStore.captureArticleContext();
    const contentVersion = readingActions.articleVersion(targetArticleId);
    const wordAnchor = anchorForWordElement(clickedElement, sentenceEl, wordText);
    // 鍵盤開詳解：事件 detail=0，或焦點還在句子／詞節點上（逐詞模式的 Enter）。
    const openedFromKeyboard = options.keyboard === true
        || options.eventDetail === 0
        || document.activeElement === clickedElement
        || !!(document.activeElement?.closest?.('.interactive-sentence'));
    wordTooltipTrigger = clickedElement;
    wordTooltipReturnFocus = clickedElement;
    wordTooltipKeyboardOpen = openedFromKeyboard;
    const stillShowing = () => session === wordTooltipSession
        && clickedElement.isConnected
        && readingActions.actionContextActive(actionContext)
        && isCurrentArticle(targetArticleId)
        // 正文在同一次查詞期間被改寫：舊回應不得重新顯示在新版本上。
        && readingActions.articleVersion(targetArticleId) === contentVersion
        // 使用者已點擊別處收起彈窗：舊請求不得把彈窗重新打開。
        && dom.analysisTooltip.style.display !== 'none';
    // 這一個查詞仍是目前 session，但它所屬的正文／文章／帳戶已失效：
    // 載入殼必須一起收掉，不能留下舊詞標題假裝還在載入。
    const staleSessionContext = () => session === wordTooltipSession
        && !(clickedElement.isConnected
            && readingActions.actionContextActive(actionContext)
            && isCurrentArticle(targetArticleId)
            && readingActions.articleVersion(targetArticleId) === contentVersion);
    wordTooltipContext = { actionContext, contentVersion };
    let renderedOnce = false;

    const tooltipTitleHtml = (data, fallbackWord) => {
        const wordHtml = escapeHtml(data?.word || fallbackWord || '');
        const rawPhonetic = String(data?.analysis?.phonetic || '').replace(/^\/|\/$/g, '');
        const phonetic = rawPhonetic ? `<span class="tooltip-phonetic">/${escapeHtml(rawPhonetic)}/</span>` : '';
        const pos = data?.analysis?.pos ? ` (${escapeHtml(data.analysis.pos)})` : '';
        return `${wordHtml}${phonetic}${pos}`;
    };

    const actionButtonsHtml = (sentenceForBtn = null, contextForBtn = null, defaultPhrase = wordText, analysis = null) => {
        const escAttr = escapeAttr;
        const sentenceStart = sourceStartForSentence(sentenceEl);
        const startOffset = sentenceOffsetOfElement(sentenceEl, clickedElement.firstChild || clickedElement, 0);
        const quote = String(defaultPhrase || '').trim();
        const kind = /\s/.test(quote) ? 'phrase' : 'word';
        // 同一段文字可能出現多次：一律用這個按鈕自己的精確錨點＋版本查狀態，
        // 不可用全文文字搜尋退回到另一處的條目。
        const savedItem = readingActions.findSavedItem(targetArticleId, kind, quote, sentenceForBtn || '', { anchor: wordAnchor, contentVersion });
        const marked = savedItem?.marked === true;
        const anchorAttrs = `data-article-id="${escAttr(targetArticleId)}" data-quote="${escAttr(quote)}" data-word="${escAttr(quote)}" data-kind="${kind}" data-sentence="${escAttr(sentenceForBtn||'')}" data-context="${escAttr(contextForBtn||'')}" data-sentence-start="${escAttr(String(sentenceStart))}" data-start-offset="${escAttr(String(startOffset))}" data-anchor-start="${escAttr(String(wordAnchor?.start ?? -1))}" data-anchor-end="${escAttr(String(wordAnchor?.end ?? -1))}" data-content-version="${escAttr(contentVersion || '')}"`;
        // 預設只露出三個主要操作；筆記與短語類操作收進「更多」。
        return `
            <div class="tooltip-primary-actions">
                <button class="btn-ghost btn-mini btn-play-word" data-word="${escAttr(quote || wordText)}">${t('article.pronunciation')}</button>
                <button class="btn-ghost btn-mini btn-add-to-book"
                    ${anchorAttrs}
                    data-meaning="${escAttr(analysis?.meaning || '')}"
                    data-phonetic="${escAttr(analysis?.phonetic || '')}"
                    data-pos="${escAttr(analysis?.pos || '')}"
                >${t('article.addToWordbook')}</button>
                <button class="btn-ghost btn-mini btn-toggle-mark" ${anchorAttrs} aria-pressed="${marked ? 'true' : 'false'}">${marked ? t('article.unmarkThis') : t('article.markThis')}</button>
            </div>
            <details class="tooltip-more">
                <summary>${t('article.moreActions')}</summary>
                <div class="tooltip-more-body">
                    <button class="btn-ghost btn-mini btn-note-item" ${anchorAttrs}>${t('article.writeNote')}</button>
                    <button class="btn-ghost btn-mini btn-pick-phrase" data-article-id="${escAttr(targetArticleId)}" data-sentence="${escAttr(sentenceForBtn||'')}" data-context="${escAttr(contextForBtn||'')}" data-default="${escAttr(defaultPhrase||'')}" data-sentence-start="${escAttr(String(sentenceStart))}" data-start-offset="${escAttr(String(startOffset))}">${t('article.pickPhrase')}</button>
                    <button class="btn-ghost btn-mini btn-analyze-phrase" data-sentence="${escAttr(sentenceForBtn||'')}" data-context="${escAttr(contextForBtn||'')}" data-default="${escAttr(defaultPhrase||'')}">${t('article.analyzePhrase')}</button>
                    <button class="btn-ghost btn-mini btn-analyze-phrase-custom" data-sentence="${escAttr(sentenceForBtn||'')}" data-context="${escAttr(contextForBtn||'')}" data-default="${escAttr(defaultPhrase||'')}">${t('article.analyzeOtherPhrase')}</button>
                </div>
            </details>`;
    };

    const renderTooltipShell = (titleHtml, contentHtml, actionsHtml, { retryHtml = '' } = {}) => {
        const hadFocusInside = dom.analysisTooltip.contains(document.activeElement);
        syncWordTooltipSheetMode();
        dom.analysisTooltip.innerHTML = `
            <div class="tooltip-head">
                <div class="tooltip-title" id="word-tooltip-title" tabindex="-1">${titleHtml}</div>
                <button type="button" class="tooltip-close" aria-label="${escapeAttr(t('article.close'))}">×</button>
            </div>
            <div class="tooltip-content">${contentHtml}</div>
            ${retryHtml}
            <div class="tooltip-actions">${actionsHtml}</div>
            <div class="tooltip-phrase-result"></div>`;
        dom.analysisTooltip.style.display = 'block';
        ui.repositionTooltip(clickedElement);
        perfProbe.markWordTooltip();
        // 鍵盤開卡：第一次與後續非同步重畫都要把焦點留在標題；滑鼠開的不搶焦點。
        if (wordTooltipKeyboardOpen && (hadFocusInside || !renderedOnce)) {
            focusWordTooltipTitle();
        }
        renderedOnce = true;
    };

    const showTooltip = (data, sentenceForBtn = null, contextForBtn = null, defaultPhrase = wordText) => {
        const analysis = data && data.analysis ? data.analysis : null;
        const meaning = String(analysis?.meaning || '').trim();
        const role = String(analysis?.role || '').trim();
        // 資訊層級：句中意思先於句中角色；角色是次要說明。
        const contentHtml = analysis
            ? `${meaning ? `<p class="tooltip-meaning"><strong>${t('article.meaningLabel')}</strong> ${escapeHtml(meaning)}</p>` : ''}
               ${role ? `<p class="tooltip-role"><strong>${t('article.roleLabel')}</strong> ${escapeHtml(role)}</p>` : ''}`
            : `<p>${t('article.noAnalysisData')}</p>`;
        wordTooltipLastPayload = { kind: 'data', data, sentenceForBtn, contextForBtn, defaultPhrase };
        wordTooltipRender = () => showTooltip(data, sentenceForBtn, contextForBtn, defaultPhrase);
        renderTooltipShell(
            tooltipTitleHtml(data, defaultPhrase),
            contentHtml || `<p>${t('article.noAnalysisData')}</p>`,
            actionButtonsHtml(sentenceForBtn, contextForBtn, defaultPhrase, analysis)
        );
    };

    const showLoading = (sentenceForBtn = null, contextForBtn = null, defaultPhrase = wordText) => {
        wordTooltipLastPayload = { kind: 'loading', sentenceForBtn, contextForBtn, defaultPhrase };
        wordTooltipRender = () => showLoading(sentenceForBtn, contextForBtn, defaultPhrase);
        // 載入中仍保留發音、加入詞書、標記與關閉，不能只剩一行等待文字。
        renderTooltipShell(
            tooltipTitleHtml(null, defaultPhrase),
            `<p>${t('article.loading')}</p>`,
            actionButtonsHtml(sentenceForBtn, contextForBtn, defaultPhrase, null)
        );
    };

    const showError = (sentenceForBtn = null, contextForBtn = null, defaultPhrase = wordText) => {
        wordTooltipLastPayload = { kind: 'error', sentenceForBtn, contextForBtn, defaultPhrase };
        wordTooltipRender = () => showError(sentenceForBtn, contextForBtn, defaultPhrase);
        renderTooltipShell(
            tooltipTitleHtml(null, defaultPhrase),
            `<p>${t('article.wordAnalysisFailed')}</p>`,
            actionButtonsHtml(sentenceForBtn, contextForBtn, defaultPhrase, null),
            { retryHtml: `<div class="tooltip-retry"><button class="btn-ghost btn-mini btn-retry-word">${t('article.retry')}</button></div>` }
        );
        const retryBtn = dom.analysisTooltip.querySelector('.btn-retry-word');
        if (retryBtn) retryBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            const keyboard = wordTooltipKeyboardOpen;
            showArticleWordAnalysis(clickedElement, analysisArray, { keyboard });
        });
    };

    if (wordAnalysisData && wordAnalysisData.analysis) {
        showTooltip(wordAnalysisData, sentence, paraEnglish, wordText);
        try {
            readingActions.recordExplanation({
                articleId: targetArticleId,
                kind: 'word',
                quote: wordText,
                sentence,
                context: paraEnglish,
                data: wordAnalysisData,
                markViewed: true,
                anchor: wordAnchor,
                contentVersion,
                actionContext
            }).catch(() => {});
        } catch (_) {}
        return;
    }

    // 懶載詳解：僅當點擊英文字時觸發
    if (!englishContainer) {
        showTooltip(null, sentence, paraEnglish, wordText);
        return;
    }

    // 查詞去重（P1-T7）：key 含內容版本、介面語言、模型與句子，避免跨版本／跨語言誤命中。
    // 快取存的是 Promise：同一個詞連點只會有一個請求，失敗就刪除讓重試可重新發出。
    const lazyKey = wordLookupKey(wordText, sentence);
    const lookupCache = wordLookupCache();
    if (!lookupCache.has(lazyKey)) {
        lookupCache.set(lazyKey, api.analyzeWordInSentence(wordText, sentence, { timeoutMs: 20000 })
            .then((data) => {
                const normalized = normalizeWordAnalysisData(data, wordText, sentence);
                if (!isUsableWordAnalysis(normalized)) {
                    lookupCache.delete(lazyKey);
                    const error = new Error('empty word analysis');
                    error.code = normalized?.errorCode || 'empty_response';
                    throw error;
                }
                return normalized;
            })
            .catch((error) => {
                lookupCache.delete(lazyKey);
                throw error;
            }));
    }

    showLoading(sentence, paraEnglish, wordText);

    lookupCache.get(lazyKey).then((normalized) => {
        // 解釋永遠存到「點擊時」的文章版本與錨點（舊回應寫舊版本，不得記成新版本）。
        try {
            readingActions.recordExplanation({
                articleId: targetArticleId,
                kind: 'word',
                quote: wordText,
                sentence,
                context: paraEnglish,
                data: normalized,
                markViewed: stillShowing(),
                anchor: wordAnchor,
                contentVersion,
                actionContext
            }).catch(() => {});
        } catch (_) {}
        // 持久化新增的詞詳解到「點擊時」所屬的文章與帳戶；文章已刪除、
        // 帳戶切換或正文版本已變更時丟棄，不得把舊分析併入目前正文。
        try {
            if (analysisWriteTargetCurrent(targetArticleId, articleContextSnapshot, contentVersion, actionContext)) {
                const record = articleStore.getRecord(targetArticleId);
                if (record && record.result) {
                    const updated = {
                        ...record.result,
                        // 頂層 detailed_analysis 是這些按需詳解唯一的家，不可省略或精簡
                        detailed_analysis: mergeDetailedAnalyses(record.result.detailed_analysis || [], [normalized])
                    };
                    articleStore.saveAnalysis(targetArticleId, updated, { ctx: articleContextSnapshot, expectContentVersion: contentVersion })
                        .then((result) => reportAnalysisSaveFailure(result))
                        .catch(() => {});
                }
            }
        } catch (_) { /* 持久化失敗不影響顯示 */ }
        // 已換選詞／換文章／換帳戶：舊回應不得覆寫目前畫面。
        if (!stillShowing()) {
            if (staleSessionContext()) dismissWordTooltip({ restoreFocus: false, source: 'stale-word-response' });
            return;
        }
        const merged = mergeDetailedAnalyses(analysisArray, [normalized]);
        dom.articleAnalysisContainer.dataset.analysis = JSON.stringify(merged);
        showTooltip(normalized, sentence, paraEnglish, wordText);
    }).catch((err) => {
        console.warn('懶載詳解失敗:', err);
        // 只有這一個選詞仍是目前顯示的才可以把錯誤寫進畫面。
        if (!stillShowing()) {
            if (staleSessionContext()) dismissWordTooltip({ restoreFocus: false, source: 'stale-word-response' });
            return;
        }
        showError(sentence, paraEnglish, wordText);
    });
}

/**
 * 頁內查詞快取的身分：內容版本＋介面語言＋模型＋句子＋詞。
 * 任一項改變都不該命中上一份結果（例如切換 zh-CN／zh-HK 或換模型）。
 */
function wordLookupKey(word, sentence) {
    let model = '';
    try { model = getTaskModelSelection('wordAnalysis').value || ''; } catch (_) { /* noop */ }
    let version = '';
    try { version = readingActions.articleVersion(articleContext.recordId || ''); } catch (_) { /* noop */ }
    return `${version}::${getLocale()}::${model}::${normSentenceForCache(sentence)}::${String(word || '').trim().toLowerCase()}`;
}

function normSentenceForCache(sentence) {
    return String(sentence || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function wordLookupCache() {
    if (!(showArticleWordAnalysis._lazyCache instanceof Map)) showArticleWordAnalysis._lazyCache = new Map();
    return showArticleWordAnalysis._lazyCache;
}

/** 只有拿到非空 meaning 才算成功；空詳解不得寫入快取，也不得記成已查閱。 */
function isUsableWordAnalysis(data) {
    return !!String(data?.analysis?.meaning || '').trim();
}

function normalizeWordAnalysisData(data, wordText, sentence) {
    if (data && data.analysis) return data;
    return {
        word: wordText,
        sentence,
        analysis: {
            phonetic: data?.analysis?.phonetic || '',
            pos: data?.analysis?.pos || '',
            meaning: data?.analysis?.meaning || (typeof data === 'string' ? data : ''),
            role: data?.analysis?.role || ''
        },
        failed: data?.failed === true,
        errorCode: data?.errorCode || ''
    };
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
    // 僅當該句在本次會話已完成分析時才做配對（此時 analyzeSentenceDedupe 會命中快取）；
    // 否則直接返回，避免 hover 觸發新的 AI 請求擠佔併發隊列
    if (!_analyzedSentenceKeys.has(_sentenceKey(sentence, context))) return false;
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
    // 固定這次重試所屬的文章與版本：切換文章／改版後才回來的結果不得寫進別篇。
    const record = articleContext.recordId ? articleStore.getRecord(articleContext.recordId) : null;
    if (!record || !record.result) {
        ui.displayMessage(t('article.analysisRecordMissing'), 'warning', 5000);
        return;
    }
    const targetArticleId = record.articleId;
    if (!retryTargetsCurrentVersion(record)) {
        // 輸入框內容與記錄版本不同：先請使用者重新分析，避免把新原文的結果寫進舊記錄。
        ui.displayMessage(t('article.retryNeedsReanalyze'), 'warning', 5000);
        return;
    }
    const contentVersion = readingActions.articleVersion(targetArticleId);
    const all = currentParagraphTexts(record.article || '');
    if (idx < 0 || idx >= all.length) return;
    const text = all[idx];
    const level = 'quick';
    const statusDiv = document.querySelector(`.paragraph-pair[data-paragraph-index="${idx}"] .para-status`);
    const textSpan = statusDiv?.querySelector('.status-text');
    const reasonSpan = statusDiv?.querySelector('.para-reason');
    const retryBtn = statusDiv?.querySelector('.retry-paragraph-btn');
    const controller = new AbortController();
    const job = startAnalysisJob({
        kind: 'retry-single',
        articleId: targetArticleId,
        contentVersion,
        controller,
        index: idx
    });
    // 同一段落只允許一個工作持有寫入權；重複工作會淘汰舊工作。
    claimParagraphForJob(job, idx);
    if (statusDiv) {
        setParagraphStatus(statusDiv, 'pending');
        if (textSpan) textSpan.textContent = t('article.analyzing');
        if (reasonSpan) { reasonSpan.hidden = true; reasonSpan.textContent = ''; }
    }
    if (retryBtn) {
        retryBtn.disabled = true;
        retryBtn.setAttribute('aria-busy', 'true');
    }
    try {
        paragraphStartTime[idx] = Date.now();
        const outcome = await runParagraphRequest(text, {
            signal: controller.signal,
            level,
            force: options.force !== false
        });
        if (!isJobWriteTarget(job, idx)) return;
        if (paragraphStartTime[idx]) paragraphElapsedMs[idx] = Math.max(0, Date.now() - paragraphStartTime[idx]);
        if (!outcome.ok) {
            renderParagraph(idx, text, outcome.result || paragraphPipeline.failedParagraphResult(outcome.errorCode));
            return;
        }
        // 先保存再更新畫面：保存失敗不得閃成功。
        const saved = await persistParagraphResult({
            articleId: targetArticleId,
            index: idx,
            result: outcome.result,
            contentVersion,
            canCommit: () => isJobWriteTarget(job, idx)
        });
        // 保存期間才回來的新工作接手了這個段落：舊結果不得再改畫面。
        if (!isJobWriteTarget(job, idx)) return;
        if (!saved.ok) {
            const errorCode = saved.error === 'stale_version' ? 'stale_version' : 'save_failed';
            // 交易真的失敗時記憶體已更新，必須保留「未保存」標記，失敗數才會一致。
            markParagraphsUnsaved(targetArticleId, contentVersion, [[idx, outcome.result]]);
            renderParagraph(idx, text, { ...outcome.result, failed: true, errorCode });
            ui.displayMessage(t('article.analysisSaveFailedInline'), 'error', 6000);
        } else {
            // 一次成功保存寫入整份記錄，先前未保存的段落也一起落盤：畫面同步成記錄狀態。
            const stillUnsaved = unsavedParagraphIndices(targetArticleId, contentVersion);
            clearParagraphsUnsaved(targetArticleId, contentVersion);
            stillUnsaved.forEach((other) => {
                if (other === idx) return;
                const otherText = all[other];
                const otherItem = articleStore.getRecord(targetArticleId)?.result?.paragraph_analysis?.[other];
                if (otherText && otherItem) renderParagraph(other, otherText, otherItem);
            });
            renderParagraph(idx, text, outcome.result);
            flashParagraphSuccess(idx);
        }
        let aggregated = [];
        try { aggregated = JSON.parse(dom.articleAnalysisContainer.dataset.analysis || '[]'); } catch (_) {}
        if (Array.isArray(outcome.result?.detailed_analysis)) {
            aggregated = mergeDetailedAnalyses(aggregated, outcome.result.detailed_analysis);
            dom.articleAnalysisContainer.dataset.analysis = JSON.stringify(aggregated);
        }
        refreshFailedStateFromRecord();
    } catch (error) {
        if (error?.name === 'AbortError' || job.cancelled) return;
        console.warn(`單段重試失敗 ${idx + 1}`, error);
        if (!isJobWriteTarget(job, idx)) return;
        renderParagraph(idx, text, paragraphPipeline.failedParagraphResult(error?.code || 'provider_error'));
        refreshFailedStateFromRecord();
    } finally {
        finishAnalysisJob(job);
        // 舊工作不得在切換後改到新畫面的按鈕／版本狀態；只有仍是目前文章才刷新。
        if (isCurrentArticle(targetArticleId)) updateArticleVersionState();
    }
}

/** 段落狀態一律使用站內 sprite 線性圖標（不用 emoji，縮放與配色才能跟著設計令牌走） */
const PARAGRAPH_STATUS_ICONS = {
    pending: '#ic-timer',
    done: '#ic-check',
    failed: '#ic-warning',
    skipped: '#ic-info',
    cancelled: '#ic-stop'
};

/** 切換段落狀態列的圖標與狀態標記；配色由 styles.css 依 data-status 決定 */
function setParagraphStatus(statusDiv, status) {
    if (!statusDiv) return;
    statusDiv.dataset.status = status;
    const use = statusDiv.querySelector('.status-icon use');
    if (use) use.setAttribute('href', PARAGRAPH_STATUS_ICONS[status] || PARAGRAPH_STATUS_ICONS.pending);
}

function flashParagraphSuccess(index) {
    const container = document.querySelector(`.paragraph-pair[data-paragraph-index="${index}"]`);
    if (!container) return;
    container.classList.add('is-flash');
    setTimeout(() => {
        container.classList.remove('is-flash');
    }, 600);
}

// --- Incremental paragraph rendering helpers ---
function renderParagraph(index, englishPara, result) {
    const container = document.querySelector(`.paragraph-pair[data-paragraph-index="${index}"]`);
    if (!container) return;
    const esc = escapeHtml;
    const escapeRegex = (string) => string ? string.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&') : '';
    const englishDiv = container.querySelector('.paragraph-english');
    const chineseDiv = container.querySelector('.paragraph-chinese');
    const statusDiv = container.querySelector('.para-status');
    // 原文本身已是中文時不顯示重複譯文，也讓朗讀流程跳過這一段。
    const sourceIsChinese = isPredominantlyChinese(prepareParagraphForTranslation(englishPara));
    if (sourceIsChinese) container.dataset.sourceLanguage = 'zh';
    else container.removeAttribute('data-source-language');

    const alignment = (result && Array.isArray(result.word_alignment)) ? result.word_alignment : [];
    let chinese = result?.chinese_translation || '';
    chinese = cleanChinese(chinese);

    const stripSpanTags = (s) => (s || '').replace(/<\/?span[^>]*>/g, '');
    let processedChinese = stripSpanTags(chinese || '');

    // 段落狀態只認 analysis-state 的判定：成功／失敗／跳過／待分析都不是靠「有沒有文字」猜。
    const paragraphClassification = (isImageParagraph = false) => classifyParagraphResult(result, {
        sourceText: englishPara,
        sourceIsChinese,
        isImageParagraph
    });
    const applyParagraphStatusUI = (classification) => {
        if (!statusDiv) return classification;
        setParagraphStatus(statusDiv, classification.status);
        // 保留錯誤碼：語言切換時要用同一份狀態重套文案（P2-5）。
        if (classification.errorCode) statusDiv.dataset.errorCode = classification.errorCode;
        else delete statusDiv.dataset.errorCode;
        const textSpan = statusDiv.querySelector('.status-text');
        const elapsedSpan = statusDiv.querySelector('.elapsed');
        const retryBtn = statusDiv.querySelector('.retry-paragraph-btn');
        if (elapsedSpan && paragraphElapsedMs[index] != null) {
            const ms = paragraphElapsedMs[index];
            elapsedSpan.textContent = `(${(ms / 1000).toFixed(1)}s)`;
        }
        if (textSpan) textSpan.textContent = t(paragraphStatusLabelKey(classification.status));
        let reasonSpan = statusDiv.querySelector('.para-reason');
        if (!reasonSpan) {
            reasonSpan = document.createElement('span');
            reasonSpan.className = 'para-reason';
            reasonSpan.hidden = true;
            textSpan?.insertAdjacentElement('afterend', reasonSpan);
        }
        if (classification.status === PARAGRAPH_STATUS.failed) {
            reasonSpan.hidden = false;
            reasonSpan.textContent = t('article.paragraphFailureReason', {
                message: t(paragraphErrorLabelKey(classification.errorCode))
            });
        } else {
            reasonSpan.hidden = true;
            reasonSpan.textContent = '';
        }
        if (retryBtn) {
            if (classification.status === PARAGRAPH_STATUS.failed) {
                retryBtn.style.display = 'inline-block';
                retryBtn.textContent = t('article.retryParagraph');
                retryBtn.dataset.index = String(index);
            } else if (classification.status === PARAGRAPH_STATUS.done) {
                retryBtn.style.display = 'inline-block';
                retryBtn.textContent = t('article.refresh');
                retryBtn.dataset.index = String(index);
            } else {
                // skipped／cancelled／pending 不提供「重試本段」
                retryBtn.style.display = 'none';
                retryBtn.removeAttribute('data-index');
            }
            // 忙碌中的段落不得因其他段落完成而被提前解鎖（P1-2）。
            updateParagraphButtonState(retryBtn);
        }
        return classification;
    };

    // 若是 Markdown 表格，直接以表格方式渲染並跳過逐句標註
    if (isMarkdownTableStart(englishPara)) {
        if (englishDiv || chineseDiv) {
            const zh = cleanChinese(stripSpanTags(chinese || ''));
            const pair = renderMarkdownTablePairHTML(englishPara, zh, index);
            if (englishDiv) {
                englishDiv.innerHTML = pair.eng;
                englishDiv.dataset.markdownTable = '1';
                englishDiv.dataset.tokensWrapped = '1';
                bindAnalyzeButtonToLastWord(englishDiv);
            }
            if (chineseDiv) {
                chineseDiv.innerHTML = sourceIsChinese
                    ? `<span class="source-language-note">${escapeHtml(t('article.sourceAlreadyChinese'))}</span>`
                    : pair.zh;
                chineseDiv.dataset.markdownTable = '1';
            }
        }
        // 更新狀態列
        applyParagraphStatusUI(paragraphClassification(false));
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
            applyParagraphStatusUI(paragraphClassification(true));
            return;
        }
    }

    // 支援混合段：行內若混有圖片與文字，圖片以 <img> 呈現，其餘文字保持逐句互動
    const toLines = (text) => String(text || '').split(/\n/);
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
                let sHtml = sentenceInlineHtml(s);
                const sAlign = alignment.filter(p => s.includes(p.en) && (processedChinese || '').includes(p.zh));
                const sSorted = [...sAlign].sort((a, b) => (b.en?.length || 0) - (a.en?.length || 0));
                sSorted.forEach((pair) => {
                    const pairId = `para-${index}-pair-${curIdx}-${pair.en}-${pair.zh}`.replace(/[^a-zA-Z0-9_-]/g,'_');
                    sHtml = replaceOutsideTags(sHtml, new RegExp(`\\b(${escapeRegex(pair.en)})\\b`, 'g'), `<span class=\"interactive-word\" data-pair-id=\"${pairId}\" data-word=\"${esc(pair.en)}\">$1</span>`);
                });
                const sWords = (result?.detailed_analysis || []).filter(w => w.word && s.includes(w.word)).map(w => w.word);
                const sUnique = Array.from(new Set(sWords));
                sUnique.forEach(word => {
                    const marker = `data-word=\"${esc(word)}\"`;
                    if (sHtml.includes(marker)) return;
                    const re = new RegExp(`\\b(${escapeRegex(word)})\\b`, 'g');
                    sHtml = replaceOutsideTags(sHtml, re, `<span class=\"interactive-word\" data-word=\"${esc(word)}\">$1</span>`);
                });
                htmlParts.push(sentenceWrapHtml(index, curIdx, s, sHtml));
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
        bindAnalyzeButtonToLastWord(englishDiv);

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
        chineseDiv.innerHTML = sourceIsChinese
            ? `<span class="source-language-note">${escapeHtml(t('article.sourceAlreadyChinese'))}</span>`
            : (zhBlocks.join('') || `<em class="analysis-failed-inline">${t('article.analysisFailedInline')}</em>`);

        applyParagraphStatusUI(paragraphClassification(false));
        return;
    }

    // Build sentence-by-sentence HTML for English to support per-sentence click（原有路徑）
    const sentences = sentenceSplit(englishPara || '');
    const htmlParts = [];
    const paraWords = (result && Array.isArray(result.detailed_analysis)) ? result.detailed_analysis : [];

    sentences.forEach((s, sIdx) => {
        let sHtml = sentenceInlineHtml(s);
        const sAlign = alignment.filter(p => s.includes(p.en) && (processedChinese || '').includes(p.zh));
        const sSorted = [...sAlign].sort((a, b) => (b.en?.length || 0) - (a.en?.length || 0));
        sSorted.forEach((pair) => {
            const pairId = `para-${index}-pair-${sIdx}-${pair.en}-${pair.zh}`.replace(/[^a-zA-Z0-9_-]/g,'_');
            sHtml = replaceOutsideTags(sHtml, new RegExp(`\\b(${escapeRegex(pair.en)})\\b`, 'g'), `<span class=\"interactive-word\" data-pair-id=\"${pairId}\" data-word=\"${esc(pair.en)}\">$1</span>`);
        });
        const sWords = paraWords.filter(w => w.word && s.includes(w.word)).map(w => w.word);
        const sUnique = Array.from(new Set(sWords));
        sUnique.forEach(word => {
            const marker = `data-word=\"${esc(word)}\"`;
            if (sHtml.includes(marker)) return;
            const re = new RegExp(`\\b(${escapeRegex(word)})\\b`, 'g');
            sHtml = replaceOutsideTags(sHtml, re, `<span class=\"interactive-word\" data-word=\"${esc(word)}\">$1</span>`);
        });
        htmlParts.push(sentenceWrapHtml(index, sIdx, s, sHtml));
    });

    englishDiv.innerHTML = htmlParts.join(' ');
    wrapWordsInElementOnce(englishDiv);
    bindAnalyzeButtonToLastWord(englishDiv);
    // 優先用按句翻譯結果對齊（與英文 sent-index 一一對應）；否則回退中文標點分句
    const zhAligned = alignedZhSentences(result, sentences);
    const zhSentences = zhAligned || sentenceSplitZh(processedChinese || chinese || '');
    const zhHtml = zhSentences.map((z, sIdx) => `<span class="interactive-sentence-zh" data-para-index="${index}" data-sent-index="${sIdx}">${inlineMarkdownToHtml(z)}</span>`).join(' ');
    const classification = paragraphClassification(false);
    chineseDiv.innerHTML = sourceIsChinese
        ? `<span class="source-language-note">${escapeHtml(t('article.sourceAlreadyChinese'))}</span>`
        : (classification.status === PARAGRAPH_STATUS.failed
            ? `<em class="analysis-failed-inline">${t('article.analysisFailedInline')}</em>`
            : zhHtml);

    applyParagraphStatusUI(classification);
}

async function retryFailedParagraphs() {
    // 以「記錄中的正文」為來源，不用輸入框的即時文字。
    const record = articleContext.recordId ? articleStore.getRecord(articleContext.recordId) : null;
    if (!record || !record.result) {
        ui.displayMessage(t('article.analysisRecordMissing'), 'warning', 5000);
        return;
    }
    if (!retryTargetsCurrentVersion(record)) {
        ui.displayMessage(t('article.retryNeedsReanalyze'), 'warning', 5000);
        return;
    }
    if (isBatchRetryActive()) {
        // 批次重試已在跑：不建立第二個批次（按鈕理論上已停用，這裡是防禦）。
        ui.displayMessage(t('article.retrying'), 'warning', 3000);
        return;
    }
    const targetArticleId = record.articleId;
    const contentVersion = readingActions.articleVersion(targetArticleId);
    const all = currentParagraphTexts(record.article || '');
    // 重試範圍與畫面、按鈕共用同一來源：記錄中失敗 ＋ 尚未成功保存的段落。
    const indices = failedIndicesForRecord(record);
    if (!indices.length) {
        refreshFailedStateFromRecord();
        return;
    }

    const level = 'quick';
    const CONCURRENCY = Math.min(2, indices.length);
    const SPACING_MS = 400;
    const controller = new AbortController();
    const job = startAnalysisJob({
        kind: 'retry-batch',
        articleId: targetArticleId,
        contentVersion,
        controller
    });

    clearBatchSummary();
    const batchBtn = dom.retryFailedParagraphsBtn;
    if (batchBtn) {
        batchBtn.disabled = true;
        batchBtn.setAttribute('aria-busy', 'true');
    }
    dom.articleAnalysisContainer.querySelectorAll('.retry-paragraph-btn').forEach((btn) => {
        btn.disabled = true;
        btn.setAttribute('aria-busy', 'true');
    });
    indices.forEach((idx) => {
        const statusDiv = document.querySelector(`.paragraph-pair[data-paragraph-index="${idx}"] .para-status`);
        if (!statusDiv) return;
        setParagraphStatus(statusDiv, 'pending');
        const textSpan = statusDiv.querySelector('.status-text');
        const reasonSpan = statusDiv.querySelector('.para-reason');
        if (textSpan) textSpan.textContent = t('article.analyzing');
        if (reasonSpan) { reasonSpan.hidden = true; reasonSpan.textContent = ''; }
    });

    const results = new Map();
    let nextPick = 0;
    let completed = 0;
    const updateProgressText = () => {
        const progressText = dom.articleAnalysisContainer.querySelector('.progress-text');
        if (progressText) progressText.textContent = t('article.retryingProgress', { done: completed, total: indices.length });
    };
    updateProgressText();

    const runNext = async () => {
        if (job.cancelled) return;
        const pick = nextPick++;
        if (pick >= indices.length) return;
        await new Promise((resolve) => setTimeout(resolve, SPACING_MS));
        if (job.cancelled) return;
        const idx = indices[pick];
        const text = all[idx];
        // 這一段已被別的工作（例如使用者剛送出的單段重試）接手：批次跳過，
        // 不重複請求，也不搶回寫入權。
        const existingClaim = paragraphClaims.get(paragraphClaimKey(job.articleId, idx));
        if (existingClaim && existingClaim.job && existingClaim.job !== job && !existingClaim.job.cancelled) {
            completed += 1;
            updateProgressText();
            return runNext();
        }
        // 拿到這一段的寫入權；若已被更新的單段重試接手，舊回應不得再寫。
        claimParagraphForJob(job, idx);
        try {
            paragraphStartTime[idx] = Date.now();
            const outcome = await runParagraphRequest(text, {
                signal: controller.signal,
                level,
                timeoutMs: paragraphPipeline.timeoutForLevel(level)
            });
            if (!isJobWriteTarget(job, idx)) return;
            if (paragraphStartTime[idx]) paragraphElapsedMs[idx] = Math.max(0, Date.now() - paragraphStartTime[idx]);
            if (outcome.ok) {
                results.set(idx, outcome.result);
                renderParagraph(idx, text, outcome.result);
            } else {
                renderParagraph(idx, text, outcome.result || paragraphPipeline.failedParagraphResult(outcome.errorCode));
            }
        } catch (error) {
            if (error?.name === 'AbortError' || job.cancelled) return;
            if (!isJobWriteTarget(job, idx)) return;
            console.warn(`重試第 ${idx + 1} 段仍失敗`, error);
            renderParagraph(idx, text, paragraphPipeline.failedParagraphResult(error?.code || 'provider_error'));
        } finally {
            completed += 1;
            // 舊工作已被取消：進度文字與後續排程都屬於新畫面，不得再動（F2）。
            if (!job.cancelled) {
                updateProgressText();
                await runNext();
            }
        }
    };

    const runners = [];
    for (let i = 0; i < CONCURRENCY; i++) runners.push(runNext());
    await Promise.all(runners);

    if (!isJobWriteTarget(job)) {
        finishAnalysisJob(job);
        return;
    }

    let persisted = 0;
    // 只保存仍由這個批次擁有的段落：被單段重試接手的段落由新工作負責。
    const ownedResults = new Map();
    results.forEach((result, idx) => {
        if (ownsParagraph(job, idx)) ownedResults.set(idx, result);
    });
    if (ownedResults.size) {
        // 同一篇文章＋版本的保存序列化：提交前重讀最新記錄，只合併仍持有的 patch。
        const saved = await queueAnalysisSave(targetArticleId, contentVersion, async () => {
            if (!isJobWriteTarget(job)) return { ok: false, error: 'cancelled', applied: [] };
            if (readingActions.articleVersion(targetArticleId) !== contentVersion) {
                return { ok: false, error: 'stale_version', applied: [] };
            }
            const latest = articleStore.getRecord(targetArticleId);
            if (!latest?.result) return { ok: false, error: 'record_missing', applied: [] };
            const paragraphAnalysis = Array.isArray(latest.result.paragraph_analysis)
                ? [...latest.result.paragraph_analysis]
                : [];
            let details = latest.result.detailed_analysis || [];
            const applied = [];
            for (const [idx, result] of ownedResults) {
                // 佇列等待期間被別的工作接手：這一段的結果不得寫回。
                if (!ownsParagraph(job, idx)) continue;
                paragraphAnalysis[idx] = result;
                details = mergeDetailedAnalyses(details, result?.detailed_analysis || []);
                applied.push(idx);
            }
            if (!applied.length) return { ok: false, error: 'no_patch', applied: [] };
            const result = await articleStore.saveAnalysis(targetArticleId, {
                ...latest.result,
                paragraph_analysis: paragraphAnalysis,
                detailed_analysis: details
            }, {
                ctx: articleStore.captureArticleContext(),
                expectContentVersion: contentVersion
            });
            return { ok: !!result.ok, error: result.error || '', applied };
        });
        if (saved.ok) {
            persisted = Array.isArray(saved.applied) ? saved.applied.length : ownedResults.size;
            // 這次保存寫入整份記錄：先前的未保存標記全部失效。
            clearParagraphsUnsaved(targetArticleId, contentVersion);
            // 批次結果同樣已落盤：把實際套用的段落同步回完整分析快照（F6）。
            const appliedIndices = Array.isArray(saved.applied)
                ? saved.applied
                : Array.from(ownedResults.keys());
            appliedIndices.forEach((idx) => {
                const result = ownedResults.get(idx);
                if (result) syncAnalysisSaveFailureParagraph(targetArticleId, contentVersion, idx, result);
            });
        } else if (!['cancelled', 'no_patch', 'stale_version', 'stale_job'].includes(saved.error)) {
            // 保存失敗（真正的交易失敗）：保留「未保存」標記，失敗數與重試入口不得消失。
            markParagraphsUnsaved(targetArticleId, contentVersion, Array.from(ownedResults.entries()));
        }
        // 保存 await 期間切換了文章：舊 job 只保留 A 的內部未保存狀態，不碰 B 的 DOM。
        if (!isJobWriteTarget(job)) {
            finishAnalysisJob(job);
            return;
        }
        if (!saved.ok && !['cancelled', 'no_patch', 'stale_version', 'stale_job'].includes(saved.error)) {
            for (const [idx, result] of ownedResults) {
                renderParagraph(idx, all[idx], { ...result, failed: true, errorCode: 'save_failed' });
            }
            ui.displayMessage(t('article.analysisSaveFailedInline'), 'error', 6000);
        }
    }

    // 到這裡 job 仍持有目前畫面；才可更新摘要、按鈕與進度。
    if (!isJobWriteTarget(job)) {
        finishAnalysisJob(job);
        return;
    }
    refreshFailedStateFromRecord();
    showBatchSummary({ done: persisted, failed: lastFailedIndices.length });
    finishAnalysisJob(job);
    // 由同一個來源重算批次與逐段按鈕（含忙碌與版本停用）。
    updateArticleVersionState();
    const inline = dom.articleAnalysisContainer.querySelector('.inline-progress');
    if (inline) inline.remove();
}

/**
 * 續作未完成分析（P3-T1）。
 *
 * 只對 `resumeIndicesFromResult` 選出的段落走既有的段落管線：已完成、null 洞、
 * 純圖片與原文中文都會跳過。成功段不重做；完成後把結果合併回最新記錄，
 * 最後一次保存寫入 analysis_run（complete／partial）。
 */
async function resumeAnalysis() {
    const record = articleContext.recordId ? articleStore.getRecord(articleContext.recordId) : null;
    if (!record || !record.result) {
        hideAnalysisResumeBanner();
        ui.displayMessage(t('article.analysisRecordMissing'), 'warning', 5000);
        return;
    }
    const run = normalizeAnalysisRun(record.result.analysis_run);
    if (!run || !isIncompleteAnalysisRun(run)) {
        hideAnalysisResumeBanner();
        return;
    }
    const contentVersion = readingActions.articleVersion(record.articleId);
    if (run.contentVersion && run.contentVersion !== contentVersion) {
        hideAnalysisResumeBanner();
        ui.displayMessage(t('article.retryNeedsReanalyze'), 'warning', 5000);
        return;
    }
    if (!retryTargetsCurrentVersion(record)) {
        ui.displayMessage(t('article.retryNeedsReanalyze'), 'warning', 5000);
        return;
    }
    if (isBatchRetryActive()) {
        ui.displayMessage(t('article.retrying'), 'warning', 3000);
        return;
    }

    const all = currentParagraphTexts(record.article || '');
    const indices = resumeIndicesFromResult(record.result, all);
    if (!indices.length) {
        // 沒有可續作的段落：只把 analysis_run 收成 complete，不重送任何請求。
        const stats = analysisRunStats(record.result.paragraph_analysis);
        const finalRun = {
            ...run,
            status: ANALYSIS_RUN_STATUS.complete,
            total: all.length,
            completed: stats.completed,
            failed: stats.failed,
            updatedAt: new Date().toISOString(),
            lastErrorCode: ''
        };
        const saved = await queueAnalysisSave(record.articleId, contentVersion, async () => (
            articleStore.saveAnalysis(record.articleId, {
                ...record.result,
                analysis_run: finalRun
            }, {
                ctx: articleStore.captureArticleContext(),
                expectContentVersion: contentVersion
            })
        ));
        if (saved.ok) {
            hideAnalysisResumeBanner();
            clearAnalysisCheckpointFailure();
            if (isCurrentArticle(record.articleId)) await updateHistoryIndicators();
        }
        return;
    }

    const level = 'quick';
    const CONCURRENCY = Math.min(2, indices.length);
    const SPACING_MS = 400;
    const controller = new AbortController();
    const job = startAnalysisJob({
        kind: 'resume-batch',
        articleId: record.articleId,
        contentVersion,
        controller
    });
    const resumeBtn = dom.resumeAnalysisBtn;
    if (resumeBtn) {
        resumeBtn.disabled = true;
        resumeBtn.setAttribute('aria-busy', 'true');
    }
    dom.articleAnalysisContainer.querySelectorAll('.retry-paragraph-btn').forEach((btn) => {
        btn.disabled = true;
        btn.setAttribute('aria-busy', 'true');
    });

    const results = new Map();
    let nextPick = 0;
    let completed = 0;
    const runNext = async () => {
        if (job.cancelled) return;
        const pick = nextPick++;
        if (pick >= indices.length) return;
        await new Promise((resolve) => setTimeout(resolve, SPACING_MS));
        if (job.cancelled) return;
        const idx = indices[pick];
        const text = all[idx];
        // 這一段已被別的工作接手：不重複請求、不搶寫入權。
        const existingClaim = paragraphClaims.get(paragraphClaimKey(job.articleId, idx));
        if (existingClaim && existingClaim.job && existingClaim.job !== job && !existingClaim.job.cancelled) {
            completed += 1;
            return runNext();
        }
        claimParagraphForJob(job, idx);
        try {
            paragraphStartTime[idx] = Date.now();
            const outcome = await runParagraphRequest(text, {
                signal: controller.signal,
                level,
                timeoutMs: paragraphPipeline.timeoutForLevel(level)
            });
            if (!isJobWriteTarget(job, idx)) return;
            if (paragraphStartTime[idx]) paragraphElapsedMs[idx] = Math.max(0, Date.now() - paragraphStartTime[idx]);
            if (outcome.ok) {
                results.set(idx, outcome.result);
                renderParagraph(idx, text, outcome.result);
            } else {
                renderParagraph(idx, text, outcome.result || paragraphPipeline.failedParagraphResult(outcome.errorCode));
            }
        } catch (error) {
            if (error?.name === 'AbortError' || job.cancelled) return;
            if (!isJobWriteTarget(job, idx)) return;
            console.warn(`續作第 ${idx + 1} 段仍失敗`, error);
            renderParagraph(idx, text, paragraphPipeline.failedParagraphResult(error?.code || 'provider_error'));
        } finally {
            completed += 1;
            if (!job.cancelled) await runNext();
        }
    };

    const runners = [];
    for (let i = 0; i < CONCURRENCY; i += 1) runners.push(runNext());
    await Promise.all(runners);

    if (!isJobWriteTarget(job)) {
        finishAnalysisJob(job);
        return;
    }

    const saved = await queueAnalysisSave(record.articleId, contentVersion, async () => {
        if (!isJobWriteTarget(job)) return { ok: false, error: 'cancelled' };
        const latest = articleStore.getRecord(record.articleId);
        if (!latest?.result) return { ok: false, error: 'record_missing' };
        if (readingActions.articleVersion(record.articleId) !== contentVersion) {
            return { ok: false, error: 'stale_version' };
        }
        const paragraphAnalysis = Array.isArray(latest.result.paragraph_analysis)
            ? [...latest.result.paragraph_analysis]
            : [];
        while (paragraphAnalysis.length < all.length) paragraphAnalysis.push(null);
        let details = latest.result.detailed_analysis || [];
        for (const [idx, result] of results) {
            if (!ownsParagraph(job, idx)) continue;
            paragraphAnalysis[idx] = result;
            details = mergeDetailedAnalyses(details, result?.detailed_analysis || []);
        }
        const stats = analysisRunStats(paragraphAnalysis);
        const finalRun = {
            ...run,
            status: stats.failed > 0 ? ANALYSIS_RUN_STATUS.partial : ANALYSIS_RUN_STATUS.complete,
            total: all.length,
            completed: stats.completed,
            failed: stats.failed,
            updatedAt: new Date().toISOString(),
            lastErrorCode: ''
        };
        const merged = {
            ...latest.result,
            chinese_translation: paragraphAnalysis.map((item) => (item && item.chinese_translation) || '').join('\n\n'),
            word_alignment: paragraphAnalysis.flatMap((item) => (item && item.word_alignment) || []),
            detailed_analysis: details,
            paragraph_analysis: paragraphAnalysis,
            analysis_run: finalRun
        };
        const res = await articleStore.saveAnalysis(record.articleId, merged, {
            ctx: articleStore.captureArticleContext(),
            expectContentVersion: contentVersion
        });
        return { ok: !!res.ok, error: res.error || '', finalRun };
    });
    finishAnalysisJob(job);

    if (resumeBtn) {
        resumeBtn.disabled = false;
        resumeBtn.removeAttribute('aria-busy');
    }
    if (!saved.ok) {
        if (!['cancelled', 'stale_version', 'stale_job'].includes(saved.error)) {
            ui.displayMessage(t('article.analysisSaveFailedInline'), 'error', 6000);
        }
        if (isCurrentArticle(record.articleId)) updateArticleVersionState();
        return;
    }
    if (!isCurrentArticle(record.articleId)) return;
    // 成功段不重做；失敗段保留重試入口。
    refreshFailedStateFromRecord();
    clearAnalysisCheckpointFailure();
    hideAnalysisResumeBanner();
    renderAnalysisSaveFailure(articleStore.getRecord(record.articleId));
    updateArticleVersionState();
    await updateHistoryIndicators();
}

// --- Sentence helpers ---
function sentenceSplit(text) {
    const source = String(text || '');
    // 先把網址換成佔位符：Intl.Segmenter 會把網址裡的 "?" "!" 當成句末，
    // 把 https://example.com/a?b=c 切成兩句，導致顯示與送給模型的句子都斷在網址中間
    const urls = [];
    const guarded = source.replace(/https?:\/\/[^\s<>"')\]}）】」』]+/g, (m) => {
        urls.push(m);
        return `\u0000U${urls.length - 1}\u0000`;
    });
    const restore = (s) => s.replace(/\u0000U(\d+)\u0000/g, (m, i) => (urls[Number(i)] !== undefined ? urls[Number(i)] : m));
    let parts = [];
    try {
        if (Intl && Intl.Segmenter) {
            const seg = new Intl.Segmenter('en', { granularity: 'sentence' });
            parts = Array.from(seg.segment(guarded)).map(s => s.segment.trim()).filter(Boolean);
        }
    } catch (_) {}
    if (!parts.length) {
        // Fallback regex with simple abbreviation guard
        const abbrev = /\b(Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e)\.$/i;
        let buf = '';
        for (const ch of guarded) {
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
    }
    if (!parts.length) parts = [guarded];
    // Intl.Segmenter 會把行首的「1.」獨立成一句，但中文分句會把題號併進下一句。
    // 兩邊句數不一致時，data-sent-index 就會把英文句綁到錯誤的中文譯句；
    // 這裡把純題號併回下一句，讓中英分句結果一致。
    const merged = [];
    for (let i = 0; i < parts.length; i += 1) {
        const current = parts[i];
        const next = parts[i + 1];
        if (next !== undefined && /^\(?\d+[.)]$/.test(current.trim())) {
            merged.push(`${current.trim()} ${next}`.trim());
            i += 1;
        } else {
            merged.push(current);
        }
    }
    return merged.map(restore);
}

function sentenceSplitZh(text) {
    if (!text) return [];
    // Split by Chinese punctuation while keeping them
    const re = /[^。！？；;]+[。！？；;]?/g;
    const parts = text.match(re) || [text];
    return parts.map(s => s.trim()).filter(Boolean);
}

// 問答集導入的段落：`Q1: ...\nA1: ...`（新格式）或 `1. Q: ...\nA: ...`（舊格式）。
// 舊格式行首的「1.」符合 Markdown 有序清單標記，但整段其實是 Q/A 散文；
// 若照清單處理而關閉逐句翻譯，英文與中文的分句數只要不同，hover/朗讀就會綁錯譯句。
function isQAParagraph(text) {
    const value = String(text || '').trim();
    if (!value) return false;
    const hasQuestion = /^(?:\d+[.)]\s*)?Q\d*\s*[:：]/i.test(value);
    const hasAnswer = /(?:^|\n)\s*(?:\d+[.)]\s*)?A\d*\s*[:：]/i.test(value);
    return hasQuestion && hasAnswer;
}

// 純文字段落（無表格/清單/標題/引用/圖片）才適用按句翻譯模式，避免破壞 Markdown 結構
function isPlainProseParagraph(text) {
    const value = String(text || '');
    if (!value.trim()) return false;
    if (isMarkdownTableStart(value)) return false;
    // Q/A 段落即使帶著舊格式的 `1.` 題號，也應走逐句翻譯，確保中英逐句對齊。
    if (isQAParagraph(value)) return true;
    const lines = value.split('\n').map(l => l.trim()).filter(Boolean);
    return !lines.some(l => /^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|\||!\[)/.test(l));
}

// 若分析結果帶有按句翻譯（sentences: [{en, zh}]）且與本地分句逐句吻合，
// 返回對齊的中文譯句陣列；否則返回 null（呼叫端回退 sentenceSplitZh）
function alignedZhSentences(result, localSentences) {
    const pairs = result && Array.isArray(result.sentences) ? result.sentences : null;
    if (!pairs || !Array.isArray(localSentences) || pairs.length !== localSentences.length) return null;
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    for (let i = 0; i < pairs.length; i++) {
        const p = pairs[i];
        if (!p || typeof p.zh !== 'string' || !p.zh.trim()) return null;
        if (p.en != null && norm(p.en) !== norm(localSentences[i])) return null;
    }
    return pairs.map(p => cleanChinese(p.zh));
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

    let bar = null;
    let snapshot = null;
    let hideTimer = null;

    function ensureBar() {
        if (bar && bar.isConnected) return bar;
        bar = document.createElement('div');
        bar.className = 'article-selection-bar';
        bar.setAttribute('role', 'toolbar');
        bar.innerHTML = `
          <button type="button" class="btn-ghost btn-mini" data-act="add">${t('article.addToWordbook')}</button>
          <button type="button" class="btn-ghost btn-mini" data-act="mark">${t('article.markThis')}</button>
          <button type="button" class="btn-ghost btn-mini" data-act="note">${t('article.writeNote')}</button>
          <button type="button" class="btn-ghost btn-mini" data-act="phrase">${t('article.pickPhrase')}</button>
          <button type="button" class="btn-ghost btn-mini" data-act="close" aria-label="${t('article.close')}">×</button>`;
        document.body.appendChild(bar);
        bar.addEventListener('mousedown', (event) => event.preventDefault());
        bar.addEventListener('click', async (event) => {
            const button = event.target.closest('[data-act]');
            if (!button) return;
            event.preventDefault();
            event.stopPropagation();
            const act = button.getAttribute('data-act');
            if (act === 'close') { hideBar(); return; }
            const captured = snapshot;
            if (!captured || !captured.text) { hideBar(); return; }
            // 選區建立時的帳戶／文章上下文已凍結；切換後不得寫進新帳戶。
            if (!readingActions.actionContextActive(captured.actionContext)) {
                hideBar();
                ui.displayMessage(t('article.saveFailedRetry'), 'error');
                return;
            }
            if (act === 'phrase') {
                hideBar();
                openPhrasePicker({
                    articleId: captured.articleId || articleContext.recordId || '',
                    sentence: captured.sentence,
                    context: captured.context,
                    initialQuote: captured.text,
                    sentenceStart: captured.sentenceStart,
                    startOffset: captured.startOffset
                });
                return;
            }
            const prev = button.textContent;
            button.disabled = true;
            button.textContent = t('qa.adding');
            try {
                const target = {
                    articleId: captured.articleId || articleContext.recordId || '',
                    kind: /\s/.test(captured.text) ? 'phrase' : 'word',
                    quote: captured.text,
                    sentence: captured.sentence,
                    context: captured.context,
                    anchor: captured.anchor,
                    contentVersion: captured.contentVersion
                };
                const actionContext = captured.actionContext || readingActions.captureActionContext();
                const itemResult = await readingActions.ensureItem({ ...target, actionContext });
                if (!itemResult.ok) throw new Error(itemResult.error);
                const item = readingStore.getLearningItem(itemResult.entity.id) || itemResult.entity;
                if (act === 'mark') {
                    const markResult = await readingActions.setMarked(item.id, item.marked !== true, actionContext);
                    if (!markResult.ok) throw new Error(markResult.error);
                    button.textContent = markResult.entity?.marked === true ? t('article.unmarkThis') : t('article.markThis');
                    button.setAttribute('aria-pressed', markResult.entity?.marked === true ? 'true' : 'false');
                    snapshot = { ...captured, item };
                } else if (act === 'note') {
                    hideBar();
                    await openReadingPanelForItem(target.articleId, item.id);
                } else {
                    const result = await readingActions.addItemToVocabulary(item, { context: captured.context });
                    if (!result || result.ok === false) throw new Error(result?.error || 'failed');
                    button.textContent = result.reason === 'duplicate' ? t('qa.exists') : t('qa.added');
                }
            } catch (err) {
                button.textContent = t('qa.failed');
            } finally {
                if (act === 'add') {
                    setTimeout(() => {
                        button.disabled = false;
                        button.textContent = prev || t('article.addToWordbook');
                        hideBar();
                    }, 900);
                } else {
                    button.disabled = false;
                }
            }
        });
        return bar;
    }

    function hideBar() {
        if (bar) bar.classList.remove('is-visible');
        snapshot = null;
    }

    function captureSelection() {
        const sel = window.getSelection && window.getSelection();
        if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
        const text = String(sel.toString() || '').trim();
        if (!text) return null;
        const range = sel.getRangeAt(0);
        const container = range.commonAncestorContainer;
        const host = container.nodeType === 1 ? container : container.parentElement;
        if (!host || !area.contains(host)) return null;
        const rect = range.getBoundingClientRect();
        if (!rect || (rect.width === 0 && rect.height === 0)) return null;
        const node = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
        const endNode = range.endContainer.nodeType === 1 ? range.endContainer : range.endContainer.parentElement;
        const sentenceEl = node && node.closest ? node.closest('.interactive-sentence') : null;
        const endSentenceEl = endNode && endNode.closest ? endNode.closest('.interactive-sentence') : null;
        // 只接受英文原文的同一個句子；翻譯區、跨句或跨段落一律不誤收。
        if (!sentenceEl || !endSentenceEl || sentenceEl !== endSentenceEl) return null;
        if (!/[A-Za-z]/.test(text)) return null;
        const pair = node && node.closest ? node.closest('.paragraph-pair') : null;
        const sentence = (sentenceEl.getAttribute('data-sentence') || sentenceEl.textContent || '').trim();
        const context = (pair && pair.getAttribute('data-english')) || sentence || '';
        const articleId = articleContext.recordId || '';
        const sentenceStart = sourceStartForSentence(sentenceEl);
        const startOffset = sentenceOffsetOfElement(sentenceEl, range.startContainer, range.startOffset);
        const hint = sentenceStart >= 0 && startOffset >= 0 ? sentenceStart + startOffset : -1;
        return {
            text,
            sentence,
            context,
            articleId,
            startOffset,
            sentenceStart,
            anchor: readingActions.resolveAnchor(articleId, text, sentence, hint),
            // 選區建立當下的帳戶與內文版本；按鈕、儲存、查狀態都用這一份。
            contentVersion: readingActions.articleVersion(articleId),
            actionContext: readingActions.captureActionContext(),
            rect
        };
    }

    function selectionKind(captured) {
        return /\s/.test(String(captured?.text || '').trim()) ? 'phrase' : 'word';
    }

    /** 每次顯示都按「這一精確選區」重設按鈕狀態，不沿用上一個選區的文案。 */
    function syncBarState(captured) {
        const markButton = bar.querySelector('[data-act="mark"]');
        const addButton = bar.querySelector('[data-act="add"]');
        const noteButton = bar.querySelector('[data-act="note"]');
        const phraseButton = bar.querySelector('[data-act="phrase"]');
        if (addButton) addButton.textContent = t('article.addToWordbook');
        if (noteButton) noteButton.textContent = t('article.writeNote');
        if (phraseButton) phraseButton.textContent = t('article.pickPhrase');
        if (!markButton) return;
        const item = readingActions.findSavedItem(captured.articleId, selectionKind(captured), captured.text, captured.sentence, {
            anchor: captured.anchor,
            contentVersion: captured.contentVersion
        });
        const marked = item?.marked === true;
        markButton.textContent = marked ? t('article.unmarkThis') : t('article.markThis');
        markButton.setAttribute('aria-pressed', marked ? 'true' : 'false');
    }

    function showBar() {
        const captured = captureSelection();
        if (!captured) { hideBar(); return; }
        if (!readingActions.actionContextActive(captured.actionContext)) { hideBar(); return; }
        snapshot = captured;
        const element = ensureBar();
        syncBarState(captured);
        const left = Math.max(8, Math.min(window.innerWidth - 260, captured.rect.left));
        const top = Math.max(8, Math.min(window.innerHeight - 60, captured.rect.bottom + 8));
        element.style.left = `${left}px`;
        element.style.top = `${top}px`;
        element.classList.add('is-visible');
    }

    function scheduleShow() {
        clearTimeout(hideTimer);
        hideTimer = setTimeout(showBar, 80);
    }

    // selectionchange 先捕捉範圍；按鈕使用快照，不重讀已失焦的 Selection。
    document.addEventListener('selectionchange', scheduleShow);
    area.addEventListener('mouseup', scheduleShow);
    area.addEventListener('touchend', scheduleShow, { passive: true });
    document.addEventListener('mousedown', (event) => {
        if (!bar) return;
        if (bar.contains(event.target)) return;
        hideBar();
    });
    window.addEventListener('scroll', () => { if (bar) hideBar(); }, { passive: true });
    window.addEventListener('resize', () => { if (bar) hideBar(); });
}

/**
 * 每張句卡建立時凍結自己的歸屬：文章、正文版本、精確 occurrence、帳戶與句境。
 * 之後 refresh／詳解／選取／加入詞書都只沿用這一份；正文改版後不得改抓目前版本。
 */
const sentenceCardTargets = new WeakMap();

/** 把這張句卡自己的文章、正文版本與精確 occurrence 記在卡片上；已有凍結值不覆寫。 */
function stampSentenceCardTarget(card, articleId, contentVersion, anchor, extra = {}) {
    const frozen = sentenceCardTargets.get(card);
    if (frozen) return frozen;
    const start = Number(anchor?.start);
    const end = Number(anchor?.end);
    const hasAnchor = Number.isFinite(start) && start >= 0;
    const target = {
        articleId: articleId || '',
        contentVersion: contentVersion === undefined || contentVersion === null ? '' : String(contentVersion),
        anchor: hasAnchor
            ? {
                start,
                end: Number.isFinite(end) ? end : start + String(extra.sentence || anchor?.quote || '').length,
                quote: String(extra.sentence || anchor?.quote || '')
            }
            : null,
        sentence: String(extra.sentence || ''),
        context: String(extra.context || ''),
        paraIdx: Number.isFinite(Number(extra.paraIdx)) ? Number(extra.paraIdx) : 0,
        sentIdx: Number.isFinite(Number(extra.sentIdx)) ? Number(extra.sentIdx) : 0,
        articleContext: extra.articleContext || null,
        actionContext: extra.actionContext || null
    };
    card.dataset.articleId = target.articleId;
    card.dataset.contentVersion = target.contentVersion;
    card.dataset.anchorStart = String(hasAnchor ? start : -1);
    card.dataset.anchorEnd = String(hasAnchor && Number.isFinite(end) ? end : -1);
    sentenceCardTargets.set(card, target);
    return target;
}

/** 讀回句卡的凍結歸屬；若卡片是舊路徑建立、沒有 WeakMap 記錄，至少用 dataset 重建。 */
function sentenceCardTarget(card) {
    const frozen = sentenceCardTargets.get(card);
    if (frozen) return frozen;
    return stampSentenceCardTarget(
        card,
        card.dataset.articleId || '',
        card.dataset.contentVersion || '',
        { start: parseInt(card.dataset.anchorStart, 10), end: parseInt(card.dataset.anchorEnd, 10) },
        {
            sentence: card.dataset.sentence || '',
            context: card.dataset.context || '',
            paraIdx: parseInt(card.dataset.paraIdx, 10) || 0,
            sentIdx: parseInt(card.dataset.sentIdx, 10) || 0
        }
    );
}

/** 卡片建立時的正文版本／帳戶／精確位置已失效 → 不得再發請求或寫成目前版本。 */
function sentenceCardTargetStale(target) {
    if (!target || !target.articleId) return true;
    if (!readingActions.actionContextActive(target.actionContext)) return true;
    if (readingActions.articleVersion(target.articleId) !== target.contentVersion) return true;
    if (target.anchor) {
        return !readingActions.anchorFromOffsets(
            target.articleId,
            target.anchor.quote || target.sentence,
            target.anchor.start,
            target.anchor.end
        );
    }
    return false;
}

/** 在凍結的整句錨點內定位句內短語；正文已改寫時回傳 null。 */
function sentencePhraseAnchor(target, phrase) {
    if (!target || !target.anchor) return null;
    const sentence = String(target.sentence || '');
    const text = String(phrase || '');
    const offset = sentence.indexOf(text);
    if (offset < 0) return null;
    const start = Number(target.anchor.start) + offset;
    return readingActions.anchorFromOffsets(target.articleId, text, start, start + text.length);
}

// ── P2-T3：句級鍵盤入口與逐詞模式（僅記憶體狀態，不持久化） ──────────
let articleSentenceCard = null; // { sentenceEl, paraIdx, sentIdx, openedByKeyboard }
let wordModeState = null;        // { sentenceEl, words, hint }

function setSentenceExpanded(sentenceEl, expanded) {
    if (!sentenceEl || !sentenceEl.isConnected) return;
    sentenceEl.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    const wrap = sentenceEl.closest('.sentence-wrap');
    const analyzeBtn = wrap ? wrap.querySelector('.sent-analyze-btn') : null;
    if (analyzeBtn) analyzeBtn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
}

function focusSentenceElement(sentenceEl) {
    if (!sentenceEl || !sentenceEl.isConnected) return;
    try { sentenceEl.focus({ preventScroll: true }); } catch (_) { try { sentenceEl.focus(); } catch (__) {} }
}

function sentenceAnalysisArray() {
    try {
        const parsed = JSON.parse(dom.articleAnalysisContainer.dataset.analysis || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch (_) { return []; }
}

/** 逐詞模式關閉時清掉 tabindex，避免隱藏／失效節點留在 Tab 順序。 */
function clearWordMode({ restoreFocus = false } = {}) {
    const state = wordModeState;
    wordModeState = null;
    if (!state) return;
    state.words.forEach((word) => {
        if (word.getAttribute('tabindex') === '0') word.removeAttribute('tabindex');
    });
    state.sentenceEl?.classList.remove('word-mode-active');
    try { state.hint?.remove(); } catch (_) { /* noop */ }
    if (restoreFocus) focusSentenceElement(state.sentenceEl);
}

function focusSentenceWord(word) {
    if (!word || !word.isConnected) return;
    try { word.focus(); } catch (_) { /* noop */ }
    if (wordModeState) wordModeState.index = wordModeState.words.indexOf(word);
}

/** 只把「目前這一句」的詞放進 Tab 順序，不影響其他句子。 */
function enterWordMode(sentenceEl) {
    if (!sentenceEl || !sentenceEl.isConnected) return false;
    if (wordModeState && wordModeState.sentenceEl !== sentenceEl) clearWordMode({ restoreFocus: false });
    const words = Array.from(sentenceEl.querySelectorAll('.interactive-word')).filter((word) => word.isConnected);
    if (!words.length) return false;
    if (!wordModeState || wordModeState.sentenceEl !== sentenceEl) {
        const hint = document.createElement('span');
        hint.className = 'word-mode-hint';
        hint.setAttribute('role', 'status');
        hint.textContent = t('article.wordModeHint');
        (sentenceEl.parentElement || sentenceEl).appendChild(hint);
        sentenceEl.classList.add('word-mode-active');
        words.forEach((word) => word.setAttribute('tabindex', '0'));
        wordModeState = { sentenceEl, words, hint, index: 0 };
    }
    focusSentenceWord(wordModeState.words[0]);
    return true;
}

function exitWordMode({ restoreFocus = false } = {}) {
    const sentenceEl = wordModeState?.sentenceEl;
    clearWordMode({ restoreFocus: false });
    if (restoreFocus) focusSentenceElement(sentenceEl);
}

function hasBlockingArticleOverlay() {
    const picker = document.getElementById('phrase-picker');
    if (picker && !picker.classList.contains('hidden')) return true;
    const readingPanel = document.getElementById('article-reading-panel');
    if (readingPanel && !readingPanel.classList.contains('hidden')) return true;
    if (document.querySelector('.lightbox-overlay')) return true;
    return false;
}

function focusSentenceCardFirstAction(card) {
    if (!card || !card.isConnected) return;
    const target = card.querySelector('.sent-word-mode')
        || card.querySelector('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary');
    if (target) {
        try { target.focus({ preventScroll: true }); } catch (_) { try { target.focus(); } catch (__) {} }
        return;
    }
    if (!card.hasAttribute('tabindex')) card.setAttribute('tabindex', '-1');
    try { card.focus({ preventScroll: true }); } catch (_) { /* noop */ }
}

/** 句卡關閉：還原 aria-expanded、清逐詞 tabindex，必要時把焦點還給句子。 */
function resetSentenceCardState({ restoreFocus = false } = {}) {
    const state = articleSentenceCard;
    articleSentenceCard = null;
    clearWordMode({ restoreFocus: false });
    if (!state?.sentenceEl) return;
    setSentenceExpanded(state.sentenceEl, false);
    try { applySentenceHighlight(state.paraIdx, state.sentIdx, false); } catch (_) { /* noop */ }
    if (restoreFocus) focusSentenceElement(state.sentenceEl);
}

function toggleSentenceCardFromKeyboard(sentenceEl) {
    const modalOpen = !!dom.appModal && !dom.appModal.classList.contains('hidden');
    if (articleSentenceCard?.sentenceEl === sentenceEl && modalOpen) {
        try { ui.closeModal(); } catch (_) { resetSentenceCardState({ restoreFocus: true }); }
        return;
    }
    toggleSentenceCard(sentenceEl, { keyboard: true });
}

/** 句子／逐詞節點的鍵盤入口：Enter／Space 開關句卡、方向鍵選詞、Escape 逐層退出。 */
function handleArticleAnalysisKeydown(event) {
    if (event.defaultPrevented || event.isComposing) return;
    const target = event.target;
    if (!target || target.nodeType !== 1) return;
    const word = target.closest('.interactive-word');
    const sentence = target.closest('.interactive-sentence');
    if (wordModeState && word && sentence === wordModeState.sentenceEl) {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        const words = wordModeState.words;
        const index = words.indexOf(word);
        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
            event.preventDefault();
            const next = words[index + (event.key === 'ArrowRight' ? 1 : -1)];
            if (next) focusSentenceWord(next);
            return;
        }
        if (event.key === 'Enter') {
            event.preventDefault();
            showArticleWordAnalysis(word, sentenceAnalysisArray(), { keyboard: true });
            return;
        }
        if (event.key === 'Escape') {
            // 詳解還開著時先由 document 層收起詳解，第二次 Escape 才離開逐詞模式。
            if (isWordTooltipVisible()) return;
            event.preventDefault();
            exitWordMode({ restoreFocus: true });
            return;
        }
    }
    if (!sentence || target !== sentence) return;
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
        event.preventDefault();
        toggleSentenceCardFromKeyboard(sentence);
    }
}

async function toggleSentenceCard(sentenceEl, options = {}) {
    const openedByKeyboard = options.keyboard === true;
    // 句卡是模態層；先把單詞詳解收起來，避免它留在遮罩後方。
    if (isWordTooltipVisible()) dismissWordTooltip({ restoreFocus: false, source: 'sentence-card' });
    // 開另一句前先收起逐詞模式，避免上一句的詞還留在 Tab 順序。
    if (wordModeState) clearWordMode({ restoreFocus: false });
    if (articleSentenceCard && articleSentenceCard.sentenceEl !== sentenceEl) {
        setSentenceExpanded(articleSentenceCard.sentenceEl, false);
        articleSentenceCard = null;
    }
    // 請求開始時就記住所屬文章；回應回來後只寫回這一篇，也只在它仍是目前文章時更新畫面
    const targetArticleId = articleContext.recordId || '';
    const paraIdx = parseInt(sentenceEl.getAttribute('data-para-index'), 10) || 0;
    const sentIdx = parseInt(sentenceEl.getAttribute('data-sent-index'), 10) || 0;
    const sentence = sentenceEl.getAttribute('data-sentence') || sentenceEl.textContent;
    const pairContainer = sentenceEl.closest('.paragraph-pair');
    const context = pairContainer ? pairContainer.getAttribute('data-english') || '' : '';
    // 句子詳解也是非同步：請求開始時就凍結帳戶、版本與這一整句的精確錨點。
    const actionContext = readingActions.captureActionContext();
    const articleContextSnapshot = articleStore.captureArticleContext();
    const contentVersion = readingActions.articleVersion(targetArticleId);
    const sentenceAnchor = readingActions.resolveAnchor(targetArticleId, sentence, sentence, sourceStartForSentence(sentenceEl));
    // 回應回來後，只有同一帳戶、同一文章、同一正文版本且原卡片仍在畫面上才可重繪。
    const canUpdateView = (card) => Boolean(card && card.isConnected)
        && readingActions.actionContextActive(actionContext)
        && isCurrentArticle(targetArticleId)
        && readingActions.articleVersion(targetArticleId) === contentVersion;

    // Modal 模式：直接在彈窗中顯示詳解
    if (USE_SENTENCE_MODAL) {
        setSentenceExpanded(sentenceEl, true);
        articleSentenceCard = { sentenceEl, paraIdx, sentIdx, openedByKeyboard };
        // 高亮當前句（未播放時不淡化，其邏輯在 applySentenceHighlight 內）
        applySentenceHighlight(paraIdx, sentIdx, true);
        try { ui.openModal(); } catch (_) {}
        try { dom.modalTitle.textContent = t('article.sentenceAnalysis'); } catch (_) {}
        // 建立容器並標記為 modal 環境
        dom.modalBody.innerHTML = '';
        try {
            const mc = dom.appModal.querySelector('.modal-content');
            mc && mc.classList.add('modal-large');
        } catch (_) {}
        const card = document.createElement('div');
        card.className = 'sentence-card is-modal';
        card.dataset.modal = '1';
        stampSentenceCardTarget(card, targetArticleId, contentVersion, sentenceAnchor, {
            sentence, context, paraIdx, sentIdx,
            articleContext: articleContextSnapshot,
            actionContext
        });
        card.innerHTML = sentenceCardLoadingHtml(paraIdx, sentIdx);
        dom.modalBody.appendChild(card);
        // 鍵盤開卡：先讓焦點進入卡片；內容渲染後再移到第一個操作（逐詞檢視）。
        if (openedByKeyboard) {
            card.dataset.keyboardFocus = '1';
            if (!card.hasAttribute('tabindex')) card.setAttribute('tabindex', '-1');
            try { card.focus({ preventScroll: true }); } catch (_) { /* noop */ }
        }

        // 關閉時清理高亮
        const cleanup = () => {
            try { applySentenceHighlight(paraIdx, sentIdx, false); } catch (_) {}
            try { const mc = dom.appModal.querySelector('.modal-content'); mc && mc.classList.remove('modal-large'); } catch(_) {}
        };
        try { dom.modalCloseBtn.addEventListener('click', cleanup, { once: true }); } catch(_) {}
        try { dom.appModal.addEventListener('click', (e)=>{ if (e.target === dom.appModal) cleanup(); }, { once: true }); } catch(_) {}

        // 先讀這篇文章已保存的句子解析：重開、離線或換裝置都不必再請求 AI。
        const savedItem = readingActions.findSavedItem(targetArticleId, 'sentence', sentence, sentence, { anchor: sentenceAnchor, contentVersion });
        if (savedItem && savedItem.explanation && savedItem.explanation.result) {
            renderSentenceCard(card, savedItem.explanation.result, sentence, context, paraIdx, sentIdx, targetArticleId);
            if (canUpdateView(card)) {
                readingStore.markLearningItemViewed(savedItem.id).catch(() => {});
            }
            return;
        }
        try {
            const data = await analyzeSentenceDedupe(sentence, context, { timeoutMs: 22000, conciseKeypoints: true, includeStructure: true });
            // 已切換到其他文章或正文已改版：結果只寫回原文章，不再更新目前畫面
            if (!canUpdateView(card)) {
                persistSentenceAnalysis(sentence, context, data, targetArticleId, articleContextSnapshot, { contentVersion, actionContext });
                readingActions.recordExplanation({ articleId: targetArticleId, kind: 'sentence', quote: sentence, sentence, context, data, markViewed: false, anchor: sentenceAnchor, contentVersion, actionContext }).catch(() => {});
                return;
            }
            renderSentenceCard(card, data, sentence, context, paraIdx, sentIdx, targetArticleId);
            // 持久化句子解析（寫回請求開始時所屬的文章）
            persistSentenceAnalysis(sentence, context, data, targetArticleId, articleContextSnapshot, { contentVersion, actionContext });
            readingActions.recordExplanation({ articleId: targetArticleId, kind: 'sentence', quote: sentence, sentence, context, data, markViewed: true, anchor: sentenceAnchor, contentVersion, actionContext }).catch(() => {});
        } catch (e) {
            if (!canUpdateView(card)) return;
            card.classList.add('is-error');
            card.textContent = t('article.analysisRetry');
            if (card.dataset.keyboardFocus === '1') {
                delete card.dataset.keyboardFocus;
                focusSentenceCardFirstAction(card);
            }
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
        setSentenceExpanded(sentenceEl, !hidden);
        if (hidden) {
            articleSentenceCard = null;
            clearWordMode({ restoreFocus: false });
        } else {
            articleSentenceCard = { sentenceEl, paraIdx: paraIdx2, sentIdx: sentIdx2, openedByKeyboard };
        }
        return;
    }
    card = document.createElement('div');
    card.className = 'sentence-card is-inline';
    setSentenceExpanded(sentenceEl, true);
    articleSentenceCard = { sentenceEl, paraIdx, sentIdx, openedByKeyboard };
    if (openedByKeyboard) card.dataset.keyboardFocus = '1';
    stampSentenceCardTarget(card, targetArticleId, contentVersion, sentenceAnchor, {
        sentence, context, paraIdx, sentIdx,
        articleContext: articleContextSnapshot,
        actionContext
    });
    card.innerHTML = sentenceCardLoadingHtml(paraIdx, sentIdx);
    sentenceEl.after(card);

    const savedInlineItem = readingActions.findSavedItem(targetArticleId, 'sentence', sentence, sentence, { anchor: sentenceAnchor, contentVersion });
    if (savedInlineItem && savedInlineItem.explanation && savedInlineItem.explanation.result) {
        renderSentenceCard(card, savedInlineItem.explanation.result, sentence, context, paraIdx, sentIdx, targetArticleId);
        if (canUpdateView(card)) readingStore.markLearningItemViewed(savedInlineItem.id).catch(() => {});
        return;
    }
    try {
        const data = await analyzeSentenceDedupe(sentence, context, { timeoutMs: 22000, conciseKeypoints: true, includeStructure: true });
        if (!canUpdateView(card)) {
            persistSentenceAnalysis(sentence, context, data, targetArticleId, articleContextSnapshot, { contentVersion, actionContext });
            readingActions.recordExplanation({ articleId: targetArticleId, kind: 'sentence', quote: sentence, sentence, context, data, markViewed: false, anchor: sentenceAnchor, contentVersion, actionContext }).catch(() => {});
            return;
        }
        renderSentenceCard(card, data, sentence, context, paraIdx, sentIdx, targetArticleId);
        // 持久化句子解析（寫回請求開始時所屬的文章）
        persistSentenceAnalysis(sentence, context, data, targetArticleId, articleContextSnapshot, { contentVersion, actionContext });
        readingActions.recordExplanation({ articleId: targetArticleId, kind: 'sentence', quote: sentence, sentence, context, data, markViewed: true, anchor: sentenceAnchor, contentVersion, actionContext }).catch(() => {});
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
        card.classList.add('is-error');
            card.innerHTML = `${t('article.wordAnalysisFailed')}<button class="retry-sentence-btn">${t('article.retry')}</button>`;
        const btn = card.querySelector('.retry-sentence-btn');
        if (btn) btn.addEventListener('click', async () => {
            const retryTarget = sentenceCardTarget(card);
            if (sentenceCardTargetStale(retryTarget)) {
                ui.displayMessage(t('article.staleSentenceCard'), 'warning');
                return;
            }
            btn.disabled = true; btn.textContent = t('article.retrying');
            try {
                const data = await api.analyzeSentence(sentence, context, { timeoutMs: 22000, noCache: true, conciseKeypoints: true, includeStructure: true });
                if (!card.isConnected || sentenceCardTargetStale(retryTarget)) return;
                renderSentenceCard(card, data, sentence, context, paraIdx, sentIdx, retryTarget.articleId);
                applySentenceHighlight(paraIdx, sentIdx, true);
            }
            catch { btn.disabled = false; btn.textContent = t('article.retry'); }
        });
    }
}

function renderSentenceCard(card, data, sentence, context, paraIdx, sentIdx, targetArticleId = articleContext.recordId || '') {
    const esc = escapeHtml;
    const translation = esc(data.translation || '');
    const chunks = Array.isArray(data.chunks) ? data.chunks : [];
    const points = Array.isArray(data.key_points) ? data.key_points : [];
    const align = Array.isArray(data.phrase_alignment) ? data.phrase_alignment : [];
    // 去重：將與 chunks 明顯重複的 key_points 過濾掉
    const chunkLines = chunks.slice(0, 8).map(c => `${(c.text||'').toLowerCase()} ${(c.role||'').toLowerCase()} ${(c.note||'').toLowerCase()}`.replace(/\s+/g,' ').trim());
    const filteredPoints = [];
    const seen = new Set();
    for (const p of points) {
        const norm = String(p).toLowerCase().replace(/\s+/g,' ').trim();
        if (!norm || seen.has(norm)) continue;
        seen.add(norm);
        const dup = chunkLines.some(cl => cl.includes(norm) || norm.includes(cl));
        if (!dup) filteredPoints.push(p);
    }
    card.dataset.paraIdx = paraIdx;
    card.dataset.sentIdx = sentIdx;
    card.dataset.sentence = sentence;
    card.dataset.context = context;
    // 請求所屬文章固定在卡片上，之後的片語詳解一律寫回這一篇
    card.dataset.articleId = targetArticleId || '';

    card.innerHTML = `
        <div class="sentence-card-head">
            <div>${t('article.sentenceAnalysis')}</div>
            <div class="actions">
                <button class="btn-ghost btn-mini sent-word-mode">${t('article.wordMode')}</button>
                <button class="btn-ghost btn-mini sent-refresh">${t('article.refresh')}</button>
                <button class="btn-ghost btn-mini sent-collapse">${t('article.collapse')}</button>
            </div>
        </div>
        <div class="sentence-translation">${translation}</div>
        ${align.length? `<div class="sentence-align">`
            + align.slice(0,12).map(a=>`<span class="align-pair"><span class="align-en">${esc(a.en)}</span> ➜ <span class="align-zh">${esc(a.zh)}</span></span>`).join('')
            + `</div>` : ''}
        ${chunks.length? `<div class="sentence-chunks">`
            + chunks.slice(0,8).map((c,idx)=>`<div class="chunk-item" data-chunk-id="sent-${paraIdx}-${sentIdx}-${idx}">
                    <button class="btn-ghost btn-mini chunk-explain" data-chunk-id="sent-${paraIdx}-${sentIdx}-${idx}" data-phrase="${esc(c.text)}">${t('article.details')}</button>
                    <div class="chunk-line"><span class="chunk-text">${esc(c.text)}</span> — <em>${esc(c.role)}</em>${c.note? `：${esc(c.note)}`:''}</div>
                </div>`).join('')
            + `</div>` : ''}
        ${filteredPoints.length? `<ul class="sentence-points">`
            + filteredPoints.slice(0,6).map(p=>`<li>${esc(p)}</li>`).join('') + `</ul>` : ''}
        <div class="sent-footer">
            <button class="btn-ghost btn-mini sent-pick-phrase">${t('article.pickPhrase')}</button>
            <button class="btn-ghost btn-mini analyze-selection">${t('article.analyzeSelection')}</button>
            <small>${t('article.selectPhraseHint')}</small>
        </div>
    `;
    const refresh = card.querySelector('.sent-refresh');
    const collapse = card.querySelector('.sent-collapse');
    const wordModeBtn = card.querySelector('.sent-word-mode');
    if (wordModeBtn) wordModeBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const sentenceEl = articleSentenceCard?.sentenceEl;
        if (!sentenceEl || !sentenceEl.isConnected) return;
        // 句卡是 modal；逐詞檢視要回到文章本體，先收起句卡再進入逐詞模式。
        if (card.dataset.modal === '1') {
            try { ui.closeModal(); } catch (_) { resetSentenceCardState({ restoreFocus: false }); }
        } else {
            const inlinePara = parseInt(sentenceEl.getAttribute('data-para-index'), 10) || 0;
            const inlineSent = parseInt(sentenceEl.getAttribute('data-sent-index'), 10) || 0;
            card.classList.add('hidden');
            applySentenceHighlight(inlinePara, inlineSent, false);
            resetSentenceCardState({ restoreFocus: false });
        }
        enterWordMode(sentenceEl);
    });
    // Modal 環境下，將收合按鈕文案替換為「關閉」
    if (collapse && card.dataset.modal === '1') {
        collapse.textContent = t('article.close');
        collapse.title = t('article.closeWindow');
    }
    const head = card.querySelector('.sentence-card-head');
    const selBtn = card.querySelector('.analyze-selection');
    const pickBtn = card.querySelector('.sent-pick-phrase');
    if (pickBtn) pickBtn.addEventListener('click', () => {
        const pickTarget = sentenceCardTarget(card);
        if (sentenceCardTargetStale(pickTarget)) {
            ui.displayMessage(t('article.staleSentenceCard'), 'warning');
            return;
        }
        const sourceSentence = dom.articleAnalysisContainer.querySelector(`.interactive-sentence[data-para-index="${paraIdx}"][data-sent-index="${sentIdx}"]`);
        openPhrasePicker({
            articleId: pickTarget.articleId,
            sentence,
            context,
            // 舊卡用自己凍結的 occurrence，不用目前 DOM 重算的位置。
            sentenceStart: pickTarget.anchor && pickTarget.anchor.start >= 0
                ? pickTarget.anchor.start
                : sourceStartForSentence(sourceSentence)
        });
    });
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
            overlay.title = t('article.collapseArea');
            // 降低層級，讓標題列與其上的按鈕可點擊在上層
            overlay.style.zIndex = '1';
            overlay.setAttribute('aria-label', t('article.collapseAreaAria'));
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
        // 卡片建立時已凍結歸屬；正文改版後舊卡不得再發請求或改寫成目前版本。
        const refreshTarget = sentenceCardTarget(card);
        if (sentenceCardTargetStale(refreshTarget)) {
            ui.displayMessage(t('article.staleSentenceCard'), 'warning');
            return;
        }
        refresh.disabled = true; refresh.textContent = t('article.refreshing');
        // 請求前凍結：文章、帳戶、版本與「這張卡自己的」occurrence。
        // 重複句子不可在 await 後用最新正文重算，否則會寫到另一處或 -1。
        const refreshArticleId = refreshTarget.articleId;
        const refreshArticleCtx = refreshTarget.articleContext || articleStore.captureArticleContext();
        const refreshActionCtx = refreshTarget.actionContext || readingActions.captureActionContext();
        const refreshVersion = refreshTarget.contentVersion;
        const refreshAnchor = refreshTarget.anchor
            || readingActions.resolveAnchor(refreshArticleId, sentence, sentence);
        try {
            const fresh = await api.analyzeSentence(sentence, context, { timeoutMs: 22000, noCache: true, conciseKeypoints: true });
            // 只更新仍連在畫面上、帳戶／文章／版本都還有效的原卡片。
            const stillValid = card.isConnected
                && !sentenceCardTargetStale(refreshTarget)
                && isCurrentArticle(refreshArticleId);
            if (stillValid) renderSentenceCard(card, fresh, sentence, context, paraIdx, sentIdx, refreshArticleId);
            persistSentenceAnalysis(sentence, context, fresh, refreshArticleId, refreshArticleCtx, { contentVersion: refreshVersion, actionContext: refreshActionCtx });
            readingActions.recordExplanation({ articleId: refreshArticleId, kind: 'sentence', quote: sentence, sentence, context, data: fresh, markViewed: stillValid, anchor: refreshAnchor, contentVersion: refreshVersion, actionContext: refreshActionCtx }).catch(() => {});
        }
        finally { refresh.disabled = false; refresh.textContent = t('article.refresh'); }
    });
    if (selBtn) selBtn.addEventListener('click', async ()=>{
        const selection = window.getSelection();
        const text = (selection && selection.toString && selection.toString().trim()) || '';
        if (!text) { ui.displayMessage(t('article.selectPhraseFirst'), 'warning'); return; }
        // 舊卡的正文版本已失效：不得把選中的內容歸到目前版本／帳戶。
        const phraseTarget = sentenceCardTarget(card);
        if (sentenceCardTargetStale(phraseTarget)) {
            ui.displayMessage(t('article.staleSentenceCard'), 'warning');
            return;
        }
        selBtn.disabled = true; selBtn.textContent = t('article.analyzingSelection');
        try {
            const targetArticle = phraseTarget.articleId;
            const phraseArticleCtx = phraseTarget.articleContext || articleStore.captureArticleContext();
            const phraseActionCtx = phraseTarget.actionContext || readingActions.captureActionContext();
            const phraseVersion = phraseTarget.contentVersion;
            const phraseAnchor = sentencePhraseAnchor(phraseTarget, text)
                || readingActions.resolveAnchor(targetArticle, text, sentence);
            const res = await analyzePhraseWithSaved(text, sentence, context, targetArticle, true, { anchor: phraseAnchor, contentVersion: phraseVersion, actionContext: phraseActionCtx });
            if (!card.isConnected || sentenceCardTargetStale(phraseTarget)) return;
            const box = document.createElement('div');
            box.className = 'phrase-result';
            box.innerHTML = `<div class="phrase-result-title">${t('article.phraseLabel')}${esc(res.selection||text)}</div>
                             <div>${esc(res.analysis?.meaning || '')}</div>
                             ${res.analysis?.usage? `<div class="phrase-result-usage">${t('article.usageLabel')}${esc(res.analysis.usage)}</div>`:''}
                             ${Array.isArray(res.analysis?.examples) && res.analysis.examples.length? '<div class="phrase-result-examples">' + res.analysis.examples.slice(0,2).map(ex=>`<div>• ${esc(ex.en)} — ${esc(ex.zh)}</div>`).join('') + '</div>' : ''}`;
            card.appendChild(box);
            // 持久化片語解析（版本／帳戶沿用請求前凍結值）
            try { persistPhraseAnalysis(text, sentence, context, res, targetArticle, phraseArticleCtx, { contentVersion: phraseVersion, actionContext: phraseActionCtx }); } catch (_) {}
        } catch (e) {
            ui.displayMessage(t('article.analysisRetry'), 'warning');
        } finally {
            selBtn.disabled = false; selBtn.textContent = t('article.analyzeSelection');
        }
    });
    // Add to wordbook from current selection (sentence card)
    const addBtn = document.createElement('button');
    addBtn.className = 'btn-ghost btn-mini sent-add-to-book';
    addBtn.textContent = t('article.addSelectedToWordbook');
    addBtn.style.marginLeft = '6px';
    const footer = card.querySelector('.sent-footer');
    if (footer) footer.insertBefore(addBtn, footer.lastElementChild);
    addBtn.addEventListener('click', async () => {
        const selection = window.getSelection();
        const text = (selection && selection.toString && selection.toString().trim()) || '';
        if (!text) { ui.displayMessage(t('article.selectWordOrPhrase'), 'warning'); return; }
        // 舊卡的正文版本已失效：不得把選中的內容記到目前版本／帳戶。
        const bookTarget = sentenceCardTarget(card);
        if (sentenceCardTargetStale(bookTarget)) {
            ui.displayMessage(t('article.staleSentenceCard'), 'warning');
            return;
        }
        const prev = addBtn.textContent;
        addBtn.disabled = true; addBtn.textContent = t('qa.adding'); addBtn.setAttribute('aria-busy','true');
        try {
            const mod = await import('../../modules/vocab.js');
            if (!card.isConnected || sentenceCardTargetStale(bookTarget)) {
                ui.displayMessage(t('article.staleSentenceCard'), 'warning');
                return;
            }
            const phraseAnchor = sentencePhraseAnchor(bookTarget, text) || undefined;
            const res = await mod.addWordToCurrentArticleBook(text, {
                source: 'article',
                sentence,
                context,
                articleId: bookTarget.articleId,
                contentVersion: bookTarget.contentVersion,
                anchor: phraseAnchor,
                kind: /\s/.test(text) ? 'phrase' : 'word'
            });
            addBtn.textContent = (res && res.reason === 'duplicate') ? t('qa.exists') : t('qa.added');
        } catch (err) {
            console.warn('加入生詞本失敗:', err);
            addBtn.textContent = t('qa.failed');
        } finally {
            setTimeout(()=>{
                addBtn.removeAttribute('aria-busy');
                addBtn.disabled = false; addBtn.textContent = prev || t('article.addSelectedToWordbook');
            }, 1000);
        }
    });

    // 鍵盤開卡的焦點：載入完成／初次渲染後移到卡片第一個可操作元素（逐詞檢視）。
    if (card.dataset.keyboardFocus === '1') {
        delete card.dataset.keyboardFocus;
        if (card.contains(document.activeElement) || document.activeElement === document.body) {
            focusSentenceCardFirstAction(card);
        }
    }
}


function applySentenceHighlight(paraIdx, sentIdx, on) {
    const eng = document.querySelector(`.interactive-sentence[data-para-index="${paraIdx}"][data-sent-index="${sentIdx}"]`);
    const zh = document.querySelector(`.interactive-sentence-zh[data-para-index="${paraIdx}"][data-sent-index="${sentIdx}"]`);
    [eng, zh].forEach(el => { if (el) el.classList.toggle('sentence-active', !!on); });
    // 僅在文章朗讀實際播放時啟用淡化，其餘情況不淡化；
    // 使用者關掉朗讀列的「跟隨朗讀滾動」後就不該再自動淡化（該開關會移除 dim-others）。
    const isPlaying = !state.isReadingChunkPaused && !dom.stopReadArticleBtn.disabled && _followScroll;
    dom.articleAnalysisContainer.classList.toggle('dim-others', !!isPlaying);
}

function applySentenceDim(paraIdx, sentIdx, on) {
    const eng = document.querySelector(`.interactive-sentence[data-para-index="${paraIdx}"][data-sent-index="${sentIdx}"]`);
    const zh = document.querySelector(`.interactive-sentence-zh[data-para-index="${paraIdx}"][data-sent-index="${sentIdx}"]`);
    [eng, zh].forEach(el => { if (el) el.classList.toggle('sentence-dim', !!on); });
}

/* ---------- 句末解析鍵的懸停聯動 ----------
   指向句末那顆圓形解析鍵時：
   1. 該英文句與對應的中文譯句同時加深（深色提醒），一眼看出鍵屬於哪一句；
   2. 鍵的上方浮出一個小提示，顯示這一句的中文譯文——中文句被捲出畫面時也能確認指向。 */

let sentenceHintEl = null;
let sentenceHintAnchor = null;

function ensureSentenceHint() {
    if (sentenceHintEl && sentenceHintEl.isConnected) return sentenceHintEl;
    sentenceHintEl = document.createElement('div');
    sentenceHintEl.className = 'sentence-hint';
    sentenceHintEl.setAttribute('role', 'tooltip');
    const label = document.createElement('span');
    label.className = 'sentence-hint-label';
    label.textContent = t('article.sentenceAnalysis');
    const text = document.createElement('span');
    text.className = 'sentence-hint-text';
    sentenceHintEl.append(label, text);
    document.body.appendChild(sentenceHintEl);
    return sentenceHintEl;
}

/** 收起聯動高亮與浮動提示 */
function clearSentenceLink() {
    if (!dom.articleAnalysisContainer) return;
    dom.articleAnalysisContainer.querySelectorAll('.sentence-linked').forEach(el => el.classList.remove('sentence-linked'));
    if (sentenceHintEl) sentenceHintEl.classList.remove('is-shown');
    sentenceHintAnchor = null;
}

/** 兩個矩形的重疊面積；用來挑「最不擋字」的落點 */
function overlapArea(a, b) {
    const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return (w > 0 && h > 0) ? w * h : 0;
}

/**
 * 浮動提示的落點。
 *
 * 懸浮層在文字欄裡不可能完全不遮到字（欄內沒有空位，要嘛遮字要嘛擠開版面造成跳動）。
 * 所以退而求其次，按這個優先順序挑：
 *   1. 本句英文與對應中文都不壓到的位置 → 通常是句子下方，也就是中文譯文區
 *   2. 至少不壓到本句英文的位置（你正在讀的那一句一定看得到）
 *   3. 真的都放不下（例如貼著視窗底）時，才選壓到最少的一個
 */
function positionSentenceHint(hint, anchor, engRects = [], zhRects = []) {
    const rect = anchor.getBoundingClientRect();
    const box = hint.getBoundingClientRect();
    const gap = 8;
    const margin = 8;
    // 水平優先貼著段落欄（不然句子靠左時卡片會被推到畫面最左邊，看起來跟句子無關）
    const column = anchor.closest('.paragraph-pair');
    const columnRect = column ? column.getBoundingClientRect() : null;
    const viewportRight = window.innerWidth - margin - box.width;
    const columnLeft = columnRect ? Math.max(margin, columnRect.left) : margin;
    const columnRight = columnRect ? Math.min(viewportRight, columnRect.right - box.width) : viewportRight;
    const centered = rect.left + rect.width / 2 - box.width / 2;
    const left = columnRight >= columnLeft
        ? Math.min(Math.max(centered, columnLeft), columnRight)
        : Math.min(Math.max(centered, margin), Math.max(margin, viewportRight));
    const make = (top) => ({ left, top, right: left + box.width, bottom: top + box.height });
    const below = make(rect.bottom + gap);
    const above = make(rect.top - box.height - gap);
    const inViewport = (r) => r.top >= margin && r.bottom <= window.innerHeight - margin;

    let chosen = null;
    const candidates = [below, above].filter(inViewport);
    if (candidates.length) {
        chosen = candidates.find((c) => !overlapArea(c, engRects) && !overlapArea(c, zhRects))
            || candidates.find((c) => !overlapArea(c, engRects))
            || candidates.reduce((best, c) => (overlapArea(c, engRects) < overlapArea(best, engRects) ? c : best));
    } else {
        chosen = make(Math.min(Math.max(margin, rect.top - box.height - gap), Math.max(margin, window.innerHeight - box.height - margin)));
    }

    hint.style.left = `${Math.round(chosen.left)}px`;
    hint.style.top = `${Math.round(chosen.top)}px`;
    hint.dataset.placement = chosen.top >= rect.bottom - 1 ? 'bottom' : 'top';
}

/** 依解析鍵找回它所指的英文句與對應中文句，並量出各自的每一行矩形 */
function sentenceLinkTargets(btn) {
    const paraIdx = btn && btn.getAttribute('data-para-index');
    const sentIdx = btn && btn.getAttribute('data-sent-index');
    if (paraIdx == null || sentIdx == null) return { eng: null, zh: null, engRects: [], zhRects: [] };
    const selector = `[data-para-index="${paraIdx}"][data-sent-index="${sentIdx}"]`;
    const eng = dom.articleAnalysisContainer.querySelector(`.interactive-sentence${selector}`);
    const zh = dom.articleAnalysisContainer.querySelector(`.interactive-sentence-zh${selector}`);
    const rectsOf = (el) => (el ? Array.from(el.getClientRects()).filter((r) => r.width > 0 || r.height > 0) : []);
    return { eng, zh, engRects: rectsOf(eng), zhRects: rectsOf(zh) };
}

/** 高亮解析鍵所指的那一句（英文＋對應中文），並顯示中文譯文提示 */
function linkSentenceToButton(btn) {
    if (!btn || sentenceHintAnchor === btn) return;
    const { eng, zh, engRects, zhRects } = sentenceLinkTargets(btn);
    if (!eng && !zh) return;
    dom.articleAnalysisContainer.querySelectorAll('.sentence-linked').forEach(el => {
        if (el !== eng && el !== zh) el.classList.remove('sentence-linked');
    });
    if (eng) eng.classList.add('sentence-linked');
    if (zh) zh.classList.add('sentence-linked');

    const hint = ensureSentenceHint();
    const zhText = zh ? zh.textContent.trim() : '';
    hint.querySelector('.sentence-hint-text').textContent = zhText || t('article.sentenceNoTranslation');
    hint.classList.toggle('is-placeholder', !zhText);
    hint.classList.add('is-shown');   // 先顯示才量得到尺寸，再決定落點
    positionSentenceHint(hint, btn, engRects, zhRects);
    sentenceHintAnchor = btn;
}

if (dom.articleAnalysisContainer) {
    dom.articleAnalysisContainer.addEventListener('mouseover', (ev) => {
        const btn = ev.target?.closest?.('.sent-analyze-btn');
        if (btn) linkSentenceToButton(btn);
    });
    dom.articleAnalysisContainer.addEventListener('mouseout', (ev) => {
        const btn = ev.target?.closest?.('.sent-analyze-btn');
        if (!btn) return;
        const to = ev.relatedTarget;
        if (to && btn.contains(to)) return;   // 只是移到按鈕內的 svg，不算離開
        clearSentenceLink();
    });
    // 提示是 fixed 定位，不會跟著句子捲動：捲動時改為重新對位，句子捲出畫面才收起
    let repositionScheduled = false;
    const followScroll = () => {
        if (!sentenceHintAnchor || repositionScheduled) return;
        repositionScheduled = true;
        requestAnimationFrame(() => {
            repositionScheduled = false;
            const anchor = sentenceHintAnchor;
            if (!anchor || !sentenceHintEl) return;
            const rect = anchor.getBoundingClientRect();
            const offscreen = rect.bottom < 0 || rect.top > window.innerHeight;
            if (offscreen) { clearSentenceLink(); return; }
            const { engRects, zhRects } = sentenceLinkTargets(anchor);
            positionSentenceHint(sentenceHintEl, anchor, engRects, zhRects);
        });
    };
    window.addEventListener('scroll', followScroll, { passive: true, capture: true });
    window.addEventListener('resize', followScroll);
}

// 將容器內的英文單詞包成可點擊的 span（僅執行一次）
function wrapWordsInElementOnce(root) {
    if (!root || root.dataset.tokensWrapped === '1') return;
    wrapWordsInElement(root);
    root.dataset.tokensWrapped = '1';
}

/**
 * 把句末解析鍵與該句最後一個詞綁成一組（.sentence-tail，white-space: nowrap）。
 *
 * 按鈕是 inline-flex（原子行內元素），本身永遠是一個可斷行位置：句子最後一個詞剛好
 * 頂到行尾時，整顆鍵會被擠到下一行開頭，緊貼著下一句，看起來像是屬於下一句。
 * 綁住最後一個詞之後，鍵只會跟著那個詞一起換行，永遠不會單獨出現。
 */
function bindAnalyzeButtonToLastWord(root) {
    if (!root) return;
    const wraps = Array.from(root.querySelectorAll ? root.querySelectorAll('.sentence-wrap') : []);
    if (root.matches && root.matches('.sentence-wrap')) wraps.push(root);
    wraps.forEach((wrap) => {
        if (wrap.dataset.tailBound === '1') return;
        const sent = wrap.querySelector('.interactive-sentence');
        const btn = wrap.querySelector('.sent-analyze-btn');
        if (!sent || !btn) return;

        const picked = [];
        let node = sent.lastChild;
        let guard = 0;
        while (node && guard < 3) {
            if (node.nodeType === 3) {
                const text = node.nodeValue || '';
                // 尾端文字可能同時含最後一個詞與其後標點，切出「詞 + 標點」那一截。
                // 用 Unicode 字母，避免 café／naïve 這類帶重音詞被拆成 ASCII 片段。
                const match = text.match(/[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N}'’.-]*[^\s\p{L}\p{M}\p{N}]*\s*$/u);
                if (match) {
                    if (match.index > 0) {
                        node.nodeValue = text.slice(0, match.index);
                        picked.unshift(document.createTextNode(text.slice(match.index)));
                    } else {
                        picked.unshift(node);
                    }
                    break;
                }
            }
            picked.unshift(node);
            guard += 1;
            if (node.nodeType === 1 && node.classList && node.classList.contains('interactive-word')) break;
            node = node.previousSibling;
        }
        if (!picked.length) return;

        const tail = document.createElement('span');
        tail.className = 'sentence-tail';
        picked[0].before(tail);
        picked.forEach((n) => tail.appendChild(n));
        tail.appendChild(btn);
        wrap.dataset.tailBound = '1';
    });
}

function wrapWordsInElement(root) {
    if (!root) return;
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const targets = [];
    let node;
    while ((node = tw.nextNode())) {
        if (!node.nodeValue || !node.nodeValue.trim()) continue;
        // 語義節點（連結、code、既有 token、圖片…）保留原文，不再包字。
        if (shouldSkipNode(node)) continue;
        targets.push(node);
    }
    targets.forEach(textNode => {
        const text = textNode.nodeValue;
        const tokens = segmentWords(text).filter(({ word }) => isLookupWord(word));
        if (!tokens.length) return;
        const frag = document.createDocumentFragment();
        let idx = 0;
        tokens.forEach(({ word, start, end }) => {
            if (start > idx) frag.appendChild(document.createTextNode(text.slice(idx, start)));
            const span = document.createElement('span');
            span.className = 'interactive-word';
            span.setAttribute('data-word', word);
            span.textContent = word;
            frag.appendChild(span);
            idx = end;
        });
        const tail = text.slice(idx);
        if (tail) frag.appendChild(document.createTextNode(tail));
        textNode.parentNode.replaceChild(frag, textNode);
    });
}
