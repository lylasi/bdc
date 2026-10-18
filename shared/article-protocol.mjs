// 文章獨立儲存協議：前端、Cloudflare Worker 與 selfhost 共用的純函式。
//
// 這個檔案刻意不含任何 DOM、資料庫或網路存取，兩邊後端都必須先通過這裡的
// 驗證與容量計算，才不會出現「Worker 收、selfhost 不收」的分歧。
// 前端也匯入同一份，讓本機與伺服器對文章大小、來源類型與游標的判斷一致。

export const ARTICLE_LIMITS = {
    // 單篇文章（原文＋分析 JSON 的 UTF-8 位元組）
    maxArticleBytes: 800 * 1024,
    // 每位使用者全部文章的 UTF-8 位元組合計
    maxUserBytes: 50 * 1024 * 1024,
    // 產品提示與硬上限（筆數）
    warnCount: 400,
    maxCount: 1000,
    // 原文字元數：提示與硬上限
    warnBodyChars: 20000,
    maxBodyChars: 100000,
    // 列表分頁
    listLimitDefault: 200,
    listLimitMax: 500,
    // 批次讀取單篇文件
    batchMax: 50,
    // 一次舊資料匯入的最大筆數
    importMax: 100,
    // 單次請求 body 上限（含 JSON 包裝的餘裕）
    requestMaxBytes: 4 * 1024 * 1024
};

export const ARTICLE_SOURCE_TYPES = ['url', 'paste', 'file', 'ocr'];

// 伺服器回傳的錯誤碼。前端據此區分「版本衝突 / 需要升級 / 容量 / 權限」，
// 不把 409 一律當成一般重試衝突。
export const ARTICLE_ERRORS = {
    unauthorized: 'unauthorized',
    notFound: 'article_not_found',
    invalidBody: 'invalid_article',
    bodyTooLarge: 'article_too_large',
    quotaExceeded: 'article_quota_exceeded',
    countExceeded: 'article_count_exceeded',
    revisionRequired: 'expected_revision_required',
    revisionConflict: 'article_revision_conflict',
    alreadyDeleted: 'article_already_deleted',
    notDeleted: 'article_not_deleted',
    idExists: 'article_id_exists',
    invalidId: 'article_id_invalid',
    invalidCursor: 'article_cursor_invalid',
    legacyBlocked: 'articles_legacy_write_blocked',
    methodNotAllowed: 'method_not_allowed'
};

export function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** UTF-8 位元組數；沒有 TextEncoder 時用保守估算（每個 code unit 最多 3 bytes）。 */
export function utf8Bytes(text) {
    const raw = String(text == null ? '' : text);
    if (typeof TextEncoder !== 'undefined') {
        try { return new TextEncoder().encode(raw).length; } catch (_) { /* fall through */ }
    }
    let bytes = 0;
    for (const ch of raw) {
        const code = ch.codePointAt(0);
        if (code <= 0x7f) bytes += 1;
        else if (code <= 0x7ff) bytes += 2;
        else if (code <= 0xffff) bytes += 3;
        else bytes += 4;
    }
    return bytes;
}

export function charCount(text) {
    return Array.from(String(text == null ? '' : text)).length;
}

/**
 * 文章 ID：與標題、網址、內容都無關的穩定識別碼。
 * 舊資料的 `url:` / `local:` ID 要保留（生詞本用它當主鍵），所以不強制改寫。
 */
export function isValidArticleId(id) {
    const value = String(id == null ? '' : id);
    if (!value || value.length > 160) return false;
    return /^[A-Za-z0-9][A-Za-z0-9_:.-]*$/.test(value);
}

export function generateArticleId(seed) {
    const base = typeof seed === 'number' ? seed : Date.now();
    const tail = Math.random().toString(36).slice(2, 10);
    return `art_${base.toString(36)}${tail}`;
}

export function normalizeSourceType(value) {
    const raw = String(value == null ? '' : value).trim();
    return ARTICLE_SOURCE_TYPES.includes(raw) ? raw : 'paste';
}

export function normalizeSourceUrl(value) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return '';
    return raw.slice(0, 2048);
}

export function normalizeTitle(value, fallback = '') {
    const raw = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    const title = raw || String(fallback || '').trim();
    return title.slice(0, 300);
}

/** 分析結果只接受物件／陣列；字串會被包成物件，其他型別視為空。 */
export function normalizeAnalysis(value) {
    if (value === undefined || value === null) return null;
    if (Array.isArray(value)) return value;
    if (isPlainObject(value)) return value;
    if (typeof value === 'string' && value.trim()) {
        try {
            const parsed = JSON.parse(value);
            if (parsed && typeof parsed === 'object') return parsed;
        } catch (_) { /* ignore */ }
    }
    return null;
}

export function serializeAnalysis(value) {
    const normalized = normalizeAnalysis(value);
    if (normalized === null) return null;
    try {
        return JSON.stringify(normalized);
    } catch (_) {
        return null;
    }
}

export function parseAnalysis(value) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(String(value));
    } catch (_) {
        return null;
    }
}

/**
 * 把請求內容正規化成文章文件。回傳 `{ ok, error, document }`。
 * 不檢查容量以外的業務規則，方便同一份驗證同時用於 Worker、selfhost 與前端。
 */
export function normalizeArticleDocument(raw, options = {}) {
    if (!isPlainObject(raw)) {
        return { ok: false, error: ARTICLE_ERRORS.invalidBody };
    }
    const body = typeof raw.body === 'string'
        ? raw.body
        : (typeof raw.article === 'string' ? raw.article : '');
    const title = normalizeTitle(raw.title);
    if (!body.trim()) return { ok: false, error: ARTICLE_ERRORS.invalidBody };
    if (charCount(body) > ARTICLE_LIMITS.maxBodyChars) {
        return { ok: false, error: ARTICLE_ERRORS.bodyTooLarge, limit: ARTICLE_LIMITS.maxBodyChars };
    }
    const analysis = normalizeAnalysis(raw.analysis != null ? raw.analysis : raw.result);
    const document = {
        id: raw.id == null ? '' : String(raw.id),
        title: title || body.split('\n').map((line) => line.trim()).find(Boolean)?.slice(0, 300) || '',
        body,
        analysis,
        sourceType: normalizeSourceType(raw.sourceType),
        sourceUrl: normalizeSourceUrl(raw.sourceUrl)
    };
    if (options.requireId && !isValidArticleId(document.id)) {
        return { ok: false, error: ARTICLE_ERRORS.invalidId };
    }
    const size = articleSizeBytes(document);
    if (size > ARTICLE_LIMITS.maxArticleBytes) {
        return {
            ok: false,
            error: ARTICLE_ERRORS.bodyTooLarge,
            limit: ARTICLE_LIMITS.maxArticleBytes,
            size
        };
    }
    return { ok: true, document, size };
}

export function articleSizeBytes(document) {
    const body = typeof document?.body === 'string'
        ? document.body
        : (typeof document?.article === 'string' ? document.article : '');
    const analysisText = serializeAnalysis(document?.analysis != null ? document.analysis : document?.result);
    return utf8Bytes(body) + (analysisText ? utf8Bytes(analysisText) : 0);
}

export function summarizeUsage(rows) {
    const list = Array.isArray(rows) ? rows : [];
    let totalBytes = 0;
    let count = 0;
    for (const row of list) {
        if (!row) continue;
        const deleted = !!(row.deleted_at || row.deletedAt);
        if (deleted) continue;
        count += 1;
        totalBytes += Number(row.size_bytes != null ? row.size_bytes : row.sizeBytes) || 0;
    }
    return { count, totalBytes };
}

/**
 * 容量檢查。`currentRow` 是正在更新的那一篇（建立時為 null），
 * 更新時的差值才不會被重複計算。
 */
export function checkQuota({ usage, nextSize, currentRow = null, isCreate = false }) {
    const limits = ARTICLE_LIMITS;
    if (nextSize > limits.maxArticleBytes) {
        return { ok: false, error: ARTICLE_ERRORS.bodyTooLarge, limit: limits.maxArticleBytes, size: nextSize };
    }
    const count = Number(usage?.count) || 0;
    const totalBytes = Number(usage?.totalBytes) || 0;
    const previousSize = currentRow ? (Number(currentRow.size_bytes) || 0) : 0;
    const nextCount = isCreate ? count + 1 : count;
    const nextTotal = totalBytes - previousSize + nextSize;
    if (nextCount > limits.maxCount) {
        return { ok: false, error: ARTICLE_ERRORS.countExceeded, limit: limits.maxCount, count: nextCount };
    }
    if (nextTotal > limits.maxUserBytes) {
        return { ok: false, error: ARTICLE_ERRORS.quotaExceeded, limit: limits.maxUserBytes, totalBytes: nextTotal };
    }
    return {
        ok: true,
        count: nextCount,
        totalBytes: nextTotal,
        warning: nextCount > limits.warnCount
    };
}

/** 游標：整數且 >= 0。格式錯誤時 `invalid=true`，呼叫端應要求完整重同步。 */
export function parseCursor(raw) {
    if (raw === undefined || raw === null || raw === '') return { cursor: 0, invalid: false, provided: false };
    const text = String(raw).trim();
    if (!/^\d{1,15}$/.test(text)) return { cursor: 0, invalid: true, provided: true };
    return { cursor: Number.parseInt(text, 10), invalid: false, provided: true };
}

export function parseListLimit(raw) {
    const text = String(raw == null ? '' : raw).trim();
    if (!/^\d{1,5}$/.test(text)) return ARTICLE_LIMITS.listLimitDefault;
    const value = Number.parseInt(text, 10);
    if (!value) return ARTICLE_LIMITS.listLimitDefault;
    return Math.min(ARTICLE_LIMITS.listLimitMax, value);
}

export function parseExpectedRevision(raw) {
    if (raw === undefined || raw === null || raw === '') return null;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) return null;
    return value;
}

export function normalizeMutationId(raw) {
    const value = String(raw == null ? '' : raw).trim();
    if (!value) return '';
    return value.slice(0, 120);
}

/**
 * 列表／增量回應中單篇文章的 metadata（不含正文與分析 JSON）。
 */
export function toArticleMeta(row) {
    if (!row) return null;
    return {
        id: row.id,
        revision: Number(row.revision) || 0,
        title: row.title || '',
        sourceType: normalizeSourceType(row.source_type),
        sourceUrl: row.source_url || '',
        createdAt: row.created_at || '',
        updatedAt: row.updated_at || '',
        deletedAt: row.deleted_at || '',
        sizeBytes: Number(row.size_bytes) || 0
    };
}

export function toArticleDocument(row) {
    if (!row) return null;
    return {
        ...toArticleMeta(row),
        body: row.body || '',
        analysis: parseAnalysis(row.analysis_json)
    };
}

/**
 * 舊快照是否仍帶文章資料。文章搬到獨立表之後，快照裡的這個群組只能讀、
 * 不能再寫；伺服器用它判斷是否要擋下舊客戶端。
 */
export function snapshotCarriesArticles(payload) {
    const group = payload && payload.articles;
    if (!group || typeof group !== 'object') return false;
    const analyzed = Array.isArray(group.analyzedArticles) ? group.analyzedArticles.length : 0;
    const metas = Array.isArray(group.articleMetas) ? group.articleMetas.length : 0;
    return analyzed > 0 || metas > 0;
}

export function conflictPayload(row) {
    const meta = toArticleMeta(row);
    return {
        error: ARTICLE_ERRORS.revisionConflict,
        code: ARTICLE_ERRORS.revisionConflict,
        conflict: true,
        current: meta
    };
}
