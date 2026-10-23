/**
 * 段落請求管線（P1-T2）。
 *
 * 單段重試、批次重試、主分析都經過這裡，讓「送什麼給模型」「什麼算成功／失敗」
 * 「哪些錯誤可以重試」只有一份實作。這一層不做 DOM、不寫儲存：
 * 呼叫端拿到 `{ ok, result, errorCode }` 之後才決定要不要 render／save。
 */
import * as api from '../../modules/api.js';
import {
    PARAGRAPH_STATUS,
    SKIP_REASON,
    classifyParagraphResult,
    isMarkdownImageLine
} from './analysis-state.js';

/** 這些錯誤碼值得再試一次；認證、權限、格式錯誤應先檢查設定。 */
const RETRYABLE_ERROR_CODES = new Set([
    'provider_rate_limited',
    'provider_server_error',
    'provider_timeout',
    'request_timeout',
    'network_or_cors',
    'network_error',
    'empty_response',
    'empty_translation'
]);

export function isRetryableError(errorCode) {
    return RETRYABLE_ERROR_CODES.has(String(errorCode || ''));
}

export function timeoutForLevel(level) {
    if (level === 'standard') return 45000;
    if (level === 'deep') return 60000;
    return 30000;
}

/** 送翻譯前清理：圖片只留 alt、連結只留文字，保留粗體／斜體標記。 */
export function prepareParagraphForTranslation(text) {
    return String(text || '')
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .trim();
}

/** 送模型前移除整行圖片語法，避免模型去翻譯圖片網址。 */
export function stripMarkdownImagesFromText(text) {
    const lines = String(text || '').split(/\n/);
    const kept = lines.filter((line) => !isMarkdownImageLine(line));
    return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 純圖片段落：不送 AI，狀態是 skipped。 */
export function imageSkipResult() {
    return {
        chinese_translation: '',
        word_alignment: [],
        detailed_analysis: [],
        skipped: true,
        skipReason: SKIP_REASON.image,
        status: PARAGRAPH_STATUS.skipped
    };
}

/**
 * 原文已是中文：沿用原文，狀態是 skipped。
 * `sentences` 由呼叫端用渲染同一套分句器準備，確保英中逐句對齊。
 */
export function chineseSourceResult(text, sentences = []) {
    const source = String(text || '').trim();
    return {
        chinese_translation: source,
        sentences: (Array.isArray(sentences) ? sentences : []).map((sentence) => ({ en: sentence, zh: sentence })),
        word_alignment: [],
        detailed_analysis: [],
        skipped: true,
        skipReason: SKIP_REASON.sourceZh,
        status: PARAGRAPH_STATUS.skipped
    };
}

function abortedError() {
    const error = new Error('aborted');
    error.name = 'AbortError';
    return error;
}

/**
 * 取得單一段落的分析結果。
 *
 * @param {object} options
 * @param {string} options.text - 顯示用段落文字（含 Markdown）
 * @param {string} [options.aiText] - 已清理、要送模型的文字；預設由 text 清理
 * @param {string[]} [options.sentences] - 按句翻譯用的句子（與渲染分句一致）
 * @param {boolean} [options.isSourceChinese]
 * @param {boolean} [options.isImageParagraph]
 * @param {string} [options.level='quick']
 * @param {number} [options.timeoutMs]
 * @param {AbortSignal} [options.signal]
 * @param {boolean} [options.force] - true 時略過持久快取
 * @returns {Promise<{ ok: boolean, result: object|null, errorCode: string, status: string }>}
 */
export async function requestParagraphAnalysis(options = {}) {
    const {
        text,
        sentences,
        isSourceChinese = false,
        isImageParagraph = false,
        level = 'quick',
        signal,
        force = false
    } = options;

    if (isImageParagraph) {
        return { ok: true, result: imageSkipResult(), errorCode: '', status: PARAGRAPH_STATUS.skipped };
    }
    if (isSourceChinese) {
        return { ok: true, result: chineseSourceResult(text, sentences), errorCode: '', status: PARAGRAPH_STATUS.skipped };
    }

    const aiText = options.aiText || prepareParagraphForTranslation(stripMarkdownImagesFromText(text)) || text;
    const timeoutMs = options.timeoutMs || timeoutForLevel(level);
    let result;
    try {
        result = await api.analyzeParagraph(aiText, {
            timeoutMs,
            level,
            noCache: !!force,
            signal,
            sentences: (Array.isArray(sentences) && sentences.length) ? sentences : undefined
        });
    } catch (error) {
        if (error?.name === 'AbortError') throw abortedError();
        return { ok: false, result: null, errorCode: error?.code || 'provider_error', status: PARAGRAPH_STATUS.failed };
    }
    if (signal?.aborted || result?.errorCode === 'request_aborted') throw abortedError();

    const classification = classifyParagraphResult(result, {
        sourceText: text,
        sourceIsChinese: isSourceChinese,
        isImageParagraph
    });
    if (classification.status !== PARAGRAPH_STATUS.done) {
        return {
            ok: false,
            result,
            errorCode: classification.errorCode || 'empty_translation',
            status: classification.status
        };
    }
    return { ok: true, result, errorCode: '', status: PARAGRAPH_STATUS.done };
}

/** 產生一個「失敗」的段落結果，讓 renderParagraph 能顯示原因與重試。 */
export function failedParagraphResult(errorCode) {
    return {
        chinese_translation: '',
        word_alignment: [],
        detailed_analysis: [],
        failed: true,
        errorCode: errorCode || 'provider_error'
    };
}
