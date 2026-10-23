/**
 * 文章詳解 P3-T4：語言感知分詞與語義節點保護。
 *
 * 這個模組刻意保持「純函式、不碰 DOM」：
 *   - `segmentWords`／`trimTokenEdge`／`isTokenizableChar` 可在 node:test 直接 import；
 *   - `shouldSkipNode` 只用 `closest`（元素或文字節點的 parent），不做任何查詢或副作用。
 *
 * 為什麼不用單純的 `/[A-Za-z]+/`：
 *   cafe ́／naïve 會被拆成 ASCII 片段，COVID-19／B2B／3D 會被拆成兩三個詞，
 *   送給模型的 word 與畫面上的詞就不是同一個字串，`detailed_analysis` 也比對不到。
 *
 * 分詞結果一律帶 `start`／`end`（原文 code unit offset）：
 * 呼叫端只能「包 DOM」，不得改寫文字內容，錨點與朗讀定位才不會被分詞影響。
 */

/** 這些節點內不生成查詞 token：連結與程式碼保留原行為，既有 token 不重包。 */
export const WORD_SKIP_SELECTOR = [
    'a',
    'code',
    'pre',
    'kbd',
    'samp',
    'script',
    'style',
    'textarea',
    '.sent-analyze-btn',
    '.interactive-word',
    '.md-image',
    '[data-no-word-wrap]'
].join(', ');

/** 可構成詞的字元：字母、組合符號（重音）、數字。 */
const TOKEN_CHAR_RE = /[\p{L}\p{M}\p{N}]/u;
/** 至少要有一個字母才算「詞」；純數字（2020、3.14）不查詞。 */
const LETTER_RE = /\p{L}/u;
/** 連字號家族：Segmenter 會在這些符號處切開，但文章裡它們是詞的一部分。 */
const HYPHEN_CHARS = '-‐‑';
const HYPHEN_GAP_RE = /^[-‐‑]+$/;

/**
 * Fallback 分詞（沒有 Intl.Segmenter 時使用）。
 * 以規格 regex 為基礎，加上：
 *   - 允許 `3D` 這種數字開頭但含字母的詞（lookahead 要求整串至少一個字母）；
 *   - 允許非斷行連字號（U+2010／U+2011）。
 * 尾端標點（句號、小數點、網址尾點）由 `trimTokenEdge` 去掉。
 */
const FALLBACK_WORD_RE = /(?=[\p{L}\p{M}\p{N}.'’\-‐‑]*\p{L})[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N}'’.\-‐‑]*/gu;

/** 單一字元是否可成為詞的一部分（字母／組合符號／數字）。 */
export function isTokenizableChar(char) {
    if (!char) return false;
    return TOKEN_CHAR_RE.test(char);
}

/** 去掉詞兩端的標點，只保留詞內符號（don't、COVID-19、U.S.A）。 */
export function trimTokenEdge(token) {
    const value = String(token == null ? '' : token);
    let start = 0;
    let end = value.length;
    while (start < end && !isTokenizableChar(value[start])) start += 1;
    while (end > start && !isTokenizableChar(value[end - 1])) end -= 1;
    return value.slice(start, end);
}

function pushToken(tokens, text, start, end) {
    const raw = text.slice(start, end);
    const trimmed = trimTokenEdge(raw);
    if (!trimmed || !LETTER_RE.test(trimmed)) return;
    const lead = raw.indexOf(trimmed.charAt(0));
    const tokenStart = start + Math.max(0, lead);
    tokens.push({ word: trimmed, start: tokenStart, end: tokenStart + trimmed.length });
}

/**
 * 用 Intl.Segmenter 分詞；不支援或建構失敗時回 null（交由 fallback）。
 * Segmenter 會把 `co-operate`／`COVID-19` 切成多段，這裡把「只隔一個連字號」的
 * 相鄰 word-like 片段合併回同一個詞；合併後才檢查是否含字母。
 */
function segmentWithIntl(text, locale) {
    const SegmenterCtor = typeof Intl !== 'undefined' ? Intl.Segmenter : undefined;
    if (typeof SegmenterCtor !== 'function') return null;
    let segmenter = null;
    try {
        segmenter = new SegmenterCtor(locale || 'en', { granularity: 'word' });
    } catch (_) {
        try {
            segmenter = new SegmenterCtor('en', { granularity: 'word' });
        } catch (_) {
            return null;
        }
    }

    let parts;
    try {
        parts = Array.from(segmenter.segment(text));
    } catch (_) {
        return null;
    }

    const merged = [];
    for (const part of parts) {
        if (part.isWordLike !== true) continue;
        const start = part.index;
        const end = part.index + part.segment.length;
        const prev = merged[merged.length - 1];
        if (prev && prev.end <= start && HYPHEN_GAP_RE.test(text.slice(prev.end, start))) {
            prev.end = end;
            continue;
        }
        merged.push({ start, end });
    }

    const tokens = [];
    for (const part of merged) pushToken(tokens, text, part.start, part.end);
    return tokens;
}

function segmentWithFallback(text) {
    const tokens = [];
    for (const match of text.matchAll(FALLBACK_WORD_RE)) {
        pushToken(tokens, text, match.index, match.index + match[0].length);
    }
    return tokens;
}

/**
 * 把文字切成「可查詞」的 token。
 *
 * @param {string} text 原文
 * @param {{ locale?: string }} [options] 分詞語言（預設 en；只用於 Intl.Segmenter）
 * @returns {{ word: string, start: number, end: number }[]} `word` 為原文切片，offset 可直接定位錨點
 */
export function segmentWords(text, { locale = 'en' } = {}) {
    const source = String(text == null ? '' : text);
    if (!source) return [];
    return segmentWithIntl(source, locale) || segmentWithFallback(source);
}

/**
 * 這個節點（元素，或文字節點的 parent）是否位於不該包詞的語義節點內。
 * 沒有 DOM／`closest` 可用時一律回 false，呼叫端不需自行防禦。
 */
export function shouldSkipNode(node) {
    if (!node) return false;
    let element = null;
    if (node.nodeType === 1) element = node;
    else if (node.parentElement) element = node.parentElement;
    if (!element || typeof element.closest !== 'function') return false;
    try {
        return !!element.closest(WORD_SKIP_SELECTOR);
    } catch (_) {
        return false;
    }
}
