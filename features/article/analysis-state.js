/**
 * 段落分析狀態模型（P1-T1）。
 *
 * 這個模組只做「純判定」：不碰 DOM、不碰網路、不讀設定。
 * 目的是讓主分析、單段重試、批次重試、歷史記錄與快取共用同一套
 * 「成功／失敗／跳過／待分析」規則，不再用「譯文是不是空字串」各自猜。
 *
 * 舊記錄沒有 `status` 欄位也能用：一律由 `skipped`／`failed` 旗標與譯文內容推導。
 */

export const PARAGRAPH_STATUS = Object.freeze({
    pending: 'pending',
    done: 'done',
    skipped: 'skipped',
    failed: 'failed',
    cancelled: 'cancelled'
});

export const SKIP_REASON = Object.freeze({
    sourceZh: 'source_zh',
    image: 'image'
});

const STATUS_LABEL_KEYS = {
    [PARAGRAPH_STATUS.pending]: 'article.paragraphStatusPending',
    [PARAGRAPH_STATUS.done]: 'article.doneStatus',
    [PARAGRAPH_STATUS.skipped]: 'article.paragraphStatusSkipped',
    [PARAGRAPH_STATUS.failed]: 'article.failedStatus',
    [PARAGRAPH_STATUS.cancelled]: 'article.paragraphStatusCancelled'
};

const ERROR_LABEL_KEYS = {
    provider_auth_failed: 'errors.aiProviderAuthFailed',
    provider_forbidden: 'errors.aiProviderForbidden',
    provider_rate_limited: 'errors.aiProviderRateLimited',
    provider_server_error: 'errors.aiProviderServerError',
    provider_timeout: 'errors.aiTimeout',
    provider_bad_request: 'article.analysisFailedInline',
    provider_request_failed: 'article.analysisFailedInline',
    model_refusal: 'errors.aiRefusal',
    request_timeout: 'errors.aiTimeout',
    network_or_cors: 'errors.aiNetworkBlocked',
    network_error: 'errors.aiNetworkBlocked',
    request_aborted: 'article.paragraphStatusCancelled',
    empty_translation: 'article.emptyTranslation',
    empty_response: 'article.emptyTranslation',
    save_failed: 'article.analysisSaveFailedInline',
    stale_version: 'article.retryNeedsReanalyze'
};

/** 狀態列的翻譯鍵；呼叫端只負責 t()，不在這裡拼字。 */
export function paragraphStatusLabelKey(status) {
    return STATUS_LABEL_KEYS[status] || STATUS_LABEL_KEYS[PARAGRAPH_STATUS.pending];
}

/** 失敗原因的翻譯鍵；未知錯誤碼回最小輸出模式的通用文案。 */
export function paragraphErrorLabelKey(errorCode) {
    return ERROR_LABEL_KEYS[String(errorCode || '')] || 'article.analysisFailedInline';
}

/** 段落是否以中文為主：至少 2 個中文字，且中文字數不少於英文字母數的一半。 */
export function isPredominantlyChinese(text) {
    const value = String(text || '');
    if (!value.trim()) return false;
    // 與 5839aa7 的判定完全一致：CJK 擴充 A、CJK 統一表意、CJK 相容表意。
    const cjk = (value.match(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g) || []).length;
    if (cjk < 2) return false;
    const latin = (value.match(/[A-Za-z]/g) || []).length;
    return cjk * 2 >= latin;
}

export function isMarkdownImageLine(line) {
    if (!line) return false;
    return /^!\[[^\]]*\]\([^)]+\)\s*$/i.test(String(line).trim());
}

/** 整段只有 Markdown 圖片（可含空行）時回 true；朗讀與失敗統計都應跳過。 */
export function isPureMarkdownImageParagraph(text) {
    const lines = String(text || '').split(/\n/).map((line) => line.trim());
    const nonEmpty = lines.filter((line) => line.length > 0);
    if (!nonEmpty.length) return false;
    return nonEmpty.every(isMarkdownImageLine);
}

function hasText(value) {
    return !!String(value == null ? '' : value).trim();
}

/**
 * 判定單一段落的狀態。
 *
 * @param {object|null|undefined} item - `result.paragraph_analysis[index]`
 * @param {{ sourceText?: string, isImageParagraph?: boolean, sourceIsChinese?: boolean }} context
 * @returns {{ status: string, errorCode: string, skipReason: string }}
 */
export function classifyParagraphResult(item, context = {}) {
    const sourceText = String(context.sourceText || '');
    const sourceIsChinese = context.sourceIsChinese !== undefined
        ? !!context.sourceIsChinese
        : isPredominantlyChinese(sourceText);
    const isImageParagraph = context.isImageParagraph !== undefined
        ? !!context.isImageParagraph
        : isPureMarkdownImageParagraph(sourceText);

    // 使用者取消：不是失敗、也不是成功，重試入口要保留。
    if (item && (item.cancelled === true || item.status === PARAGRAPH_STATUS.cancelled)) {
        return { status: PARAGRAPH_STATUS.cancelled, errorCode: '', skipReason: '' };
    }
    if (item && (item.skipped === true || item.status === PARAGRAPH_STATUS.skipped)) {
        return {
            status: PARAGRAPH_STATUS.skipped,
            errorCode: '',
            skipReason: item.skipReason || (isImageParagraph ? SKIP_REASON.image : SKIP_REASON.sourceZh)
        };
    }
    if (isImageParagraph) {
        return { status: PARAGRAPH_STATUS.skipped, errorCode: '', skipReason: SKIP_REASON.image };
    }
    if (sourceIsChinese) {
        return { status: PARAGRAPH_STATUS.skipped, errorCode: '', skipReason: SKIP_REASON.sourceZh };
    }
    if (!item) {
        return { status: PARAGRAPH_STATUS.pending, errorCode: '', skipReason: '' };
    }
    if (item.failed === true) {
        return {
            status: PARAGRAPH_STATUS.failed,
            errorCode: item.errorCode || 'provider_error',
            skipReason: ''
        };
    }
    if (!hasText(item.chinese_translation)) {
        return {
            status: PARAGRAPH_STATUS.failed,
            errorCode: item.errorCode || 'empty_translation',
            skipReason: ''
        };
    }
    return { status: PARAGRAPH_STATUS.done, errorCode: '', skipReason: '' };
}

/** 只有真的拿到可用譯文才算成功；重試與快取都必須先問這裡。 */
export function isUsableParagraphResult(item, context = {}) {
    return classifyParagraphResult(item, context).status === PARAGRAPH_STATUS.done;
}

/**
 * 依目前正文段落，回傳「顯示上是失敗」的索引。
 * 中文原文與純圖片段不算失敗，缺結果的段落算待分析（不是失敗）。
 */
export function failedIndicesFromResult(result, paragraphs, options = {}) {
    const list = Array.isArray(paragraphs) ? paragraphs : [];
    const items = Array.isArray(result?.paragraph_analysis) ? result.paragraph_analysis : [];
    const out = [];
    list.forEach((text, index) => {
        const { status } = classifyParagraphResult(items[index], {
            sourceText: text,
            isImageParagraph: options.isImageParagraph ? options.isImageParagraph(text) : undefined,
            sourceIsChinese: options.isSourceChinese ? options.isSourceChinese(text) : undefined
        });
        if (status === PARAGRAPH_STATUS.failed) out.push(index);
    });
    return out;
}

/**
 * 續作要跑的段落：還沒有結果（pending）或先前的失敗。
 * 中文原文與純圖片段一律跳過。
 */
export function resumeIndicesFromResult(result, paragraphs, options = {}) {
    const list = Array.isArray(paragraphs) ? paragraphs : [];
    const items = Array.isArray(result?.paragraph_analysis) ? result.paragraph_analysis : [];
    const out = [];
    list.forEach((text, index) => {
        const { status } = classifyParagraphResult(items[index], {
            sourceText: text,
            isImageParagraph: options.isImageParagraph ? options.isImageParagraph(text) : undefined,
            sourceIsChinese: options.isSourceChinese ? options.isSourceChinese(text) : undefined
        });
        if (status === PARAGRAPH_STATUS.pending || status === PARAGRAPH_STATUS.failed) out.push(index);
    });
    return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 整篇分析的 checkpoint 狀態（P3-T1）
//
// `analysis_run` 是 additive 欄位：舊記錄沒有它時，呼叫端必須完全回到 Phase 1
// 的失敗段／批次重試行為。這裡只做客觀統計，不碰 DOM、網路或儲存。
// ─────────────────────────────────────────────────────────────────────────────

export const ANALYSIS_RUN_STATUS = Object.freeze({
    running: 'running',
    complete: 'complete',
    partial: 'partial',
    cancelled: 'cancelled',
    failed: 'failed'
});

const ANALYSIS_RUN_STATUSES = new Set(Object.values(ANALYSIS_RUN_STATUS));

/** 尚未完成的分析狀態：可以顯示續作入口。 */
export function isIncompleteAnalysisRun(run) {
    if (!run || typeof run !== 'object') return false;
    return run.status === ANALYSIS_RUN_STATUS.running
        || run.status === ANALYSIS_RUN_STATUS.partial
        || run.status === ANALYSIS_RUN_STATUS.cancelled;
}

/** 讀取舊記錄時容忍缺欄位；格式不符回 null，呼叫端回到 Phase 1 行為。 */
export function normalizeAnalysisRun(run) {
    if (!run || typeof run !== 'object') return null;
    if (!ANALYSIS_RUN_STATUSES.has(run.status)) return null;
    const total = Number(run.total);
    if (!Number.isFinite(total) || total < 0) return null;
    return {
        schemaVersion: Number(run.schemaVersion) || 1,
        runId: String(run.runId || ''),
        contentVersion: String(run.contentVersion || ''),
        status: run.status,
        total,
        completed: Math.max(0, Math.min(total, Number(run.completed) || 0)),
        failed: Math.max(0, Number(run.failed) || 0),
        startedAt: String(run.startedAt || ''),
        updatedAt: String(run.updatedAt || ''),
        lastErrorCode: String(run.lastErrorCode || '')
    };
}

/**
 * 由目前 `paragraph_analysis` 陣列推導進度。
 * 只有真的有結果（含 skipped／failed）的段落才算 completed；null 洞是「尚未完成」。
 */
export function analysisRunStats(items) {
    const list = Array.isArray(items) ? items : [];
    let completed = 0;
    let failed = 0;
    list.forEach((item) => {
        if (item === null || item === undefined) return;
        completed += 1;
        if (item.failed === true) failed += 1;
    });
    return { completed, failed };
}

/** 建立新的 analysis_run；呼叫端負責提供 runId 與正文版本。 */
export function createAnalysisRun({ runId, contentVersion, total, startedAt }) {
    const stamp = startedAt || new Date().toISOString();
    return {
        schemaVersion: 1,
        runId: String(runId || ''),
        contentVersion: String(contentVersion || ''),
        status: ANALYSIS_RUN_STATUS.running,
        total: Math.max(0, Number(total) || 0),
        completed: 0,
        failed: 0,
        startedAt: stamp,
        updatedAt: stamp,
        lastErrorCode: ''
    };
}
