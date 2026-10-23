// 文章閱讀檔案的共用資料契約。
//
// 這個檔案只放純函式，前端、Cloudflare Worker 與 selfhost 都匯入同一份：
//   * 實體種類、ID／容量／字串驗證
//   * mutation（冪等操作）與 patch 白名單
//   * 基於已知 base 的逐欄位三方合併
//   * 舊快照是否仍攜帶詞書／聊天資料（用來關閉舊整組覆寫）
//
// 不在這裡碰 IndexedDB、DOM 或網路，讓四個執行環境的規則不會分叉。

export const READING_ENTITY_TYPES = [
    'learningItem',
    'articleDocument',
    'conversation',
    'message',
    'vocabularyBook',
    'vocabularyEntry',
    'vocabularyLink'
];

export const READING_KINDS = ['word', 'phrase', 'sentence'];
export const UNDERSTANDING_STATES = ['unmarked', 'needs_review', 'understood'];
export const DOCUMENT_KINDS = ['note', 'ai'];

export const READING_LIMITS = {
    maxEntityId: 160,
    maxMutationId: 120,
    maxPatchBytes: 1024 * 1024,
    maxBatchKeys: 200,
    maxMutationsPerRequest: 100,
    maxChangesPage: 300,
    maxNoteChars: 20000,
    maxDocumentChars: 400000,
    maxMessageChars: 200000,
    maxQuoteChars: 2000,
    maxTitleChars: 300,
    maxAnchorContext: 120,
    maxContentVersion: 120,
    requestMaxBytes: 4 * 1024 * 1024
};

export const READING_ERRORS = {
    unauthorized: 'unauthorized',
    invalidMutation: 'reading_invalid_mutation',
    invalidEntity: 'reading_invalid_entity',
    invalidPatch: 'reading_invalid_patch',
    entityTooLarge: 'reading_entity_too_large',
    notFound: 'reading_entity_not_found',
    revisionRequired: 'reading_revision_required',
    revisionConflict: 'reading_revision_conflict',
    alreadyDeleted: 'reading_already_deleted',
    legacyBlocked: 'reading_legacy_write_blocked',
    cursorInvalid: 'reading_cursor_invalid',
    methodNotAllowed: 'method_not_allowed'
};

const PATCH_FIELDS = {
    learningItem: [
        'articleId', 'contentVersion', 'kind', 'anchor', 'sentence',
        'explanation', 'firstViewedAt', 'lastViewedAt', 'marked', 'understanding', 'note',
        'positionUncertain', 'sourceContentVersion', 'createdAt', 'updatedAt', 'deletedAt'
    ],
    articleDocument: [
        'articleId', 'kind', 'title', 'content', 'sourceItemIds', 'sourceMessageIds',
        'contentVersion', 'createdAt', 'updatedAt', 'deletedAt'
    ],
    conversation: ['articleId', 'legacyArticleKey', 'title', 'createdAt', 'updatedAt', 'deletedAt'],
    message: [
        'conversationId', 'role', 'content', 'status', 'learningItemId', 'anchor',
        'contentVersion', 'createdAt', 'updatedAt', 'deletedAt'
    ],
    vocabularyBook: ['name', 'sourceType', 'articleId', 'sourceUrl', 'shareId', 'createdAt', 'updatedAt', 'deletedAt'],
    vocabularyEntry: [
        'bookId', 'word', 'meaning', 'phonetic', 'pos', 'examples', 'sources',
        'definition', 'source', 'sourceArticleId', 'wordbookId', 'context',
        'shareId', 'addedAt', 'createdAt', 'updatedAt', 'deletedAt'
    ],
    vocabularyLink: ['itemId', 'bookId', 'entryId', 'addedAt', 'removedAt', 'updatedAt', 'deletedAt', 'positionUnknown']
};

// 這些欄位代表實體身分／引用位置，三方合併時不能無提示地換掉。
const IDENTITY_FIELDS = {
    learningItem: ['articleId', 'contentVersion', 'kind', 'anchor', 'sentence'],
    articleDocument: ['articleId', 'kind'],
    conversation: ['articleId'],
    message: ['conversationId', 'role'],
    vocabularyBook: ['articleId'],
    vocabularyEntry: ['bookId', 'word'],
    vocabularyLink: ['itemId', 'bookId', 'entryId']
};

export function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function isReadingEntityType(value) {
    return READING_ENTITY_TYPES.includes(String(value || ''));
}

export function isValidEntityId(value) {
    const id = String(value == null ? '' : value);
    if (!id || id.length > READING_LIMITS.maxEntityId) return false;
    return /^[A-Za-z0-9][A-Za-z0-9_:.~-]*$/.test(id);
}

export function normalizeMutationId(value) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return '';
    return raw.replace(/[^A-Za-z0-9_:.~-]/g, '').slice(0, READING_LIMITS.maxMutationId);
}

export function generateReadingId(prefix = 'ri') {
    const tail = Math.random().toString(36).slice(2, 10);
    return `${prefix}_${Date.now().toString(36)}${tail}`;
}

/** 穩定的原文版本識別：FNV-1a + 長度。只用來判斷「原文是否變了」，不是安全雜湊。 */
export function contentVersionOf(text) {
    const raw = String(text == null ? '' : text);
    let hash = 0x811c9dc5;
    for (let i = 0; i < raw.length; i += 1) {
        hash ^= raw.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `cv1_${hash.toString(16).padStart(8, '0')}_${raw.length}`;
}

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

function cleanString(value, max) {
    return String(value == null ? '' : value).slice(0, max);
}

export function normalizeAnchor(raw) {
    if (!isPlainObject(raw)) return { start: -1, end: -1, quote: '', prefix: '', suffix: '' };
    const start = Number.isInteger(Number(raw.start)) ? Number(raw.start) : -1;
    const end = Number.isInteger(Number(raw.end)) ? Number(raw.end) : -1;
    return {
        start: start >= 0 ? start : -1,
        end: end >= 0 ? end : -1,
        quote: cleanString(raw.quote, READING_LIMITS.maxQuoteChars),
        prefix: cleanString(raw.prefix, READING_LIMITS.maxAnchorContext),
        suffix: cleanString(raw.suffix, READING_LIMITS.maxAnchorContext)
    };
}

function normalizeStringArray(value, maxItems = 200) {
    if (!Array.isArray(value)) return [];
    return value.map((item) => cleanString(item, READING_LIMITS.maxEntityId)).filter(Boolean).slice(0, maxItems);
}

/** 把 patch 或完整實體裁切成白名單欄位，避免遠端塞入任意資料。 */
export function normalizeReadingPatch(entityType, raw) {
    if (!isReadingEntityType(entityType) || !isPlainObject(raw)) return null;
    const fields = PATCH_FIELDS[entityType];
    const out = {};
    for (const field of fields) {
        if (!Object.prototype.hasOwnProperty.call(raw, field)) continue;
        const value = raw[field];
        switch (field) {
            case 'anchor':
                out.anchor = normalizeAnchor(value);
                break;
            case 'sourceItemIds':
                out.sourceItemIds = normalizeStringArray(value);
                break;
            case 'sourceMessageIds':
                out.sourceMessageIds = normalizeStringArray(value);
                break;
            case 'examples':
                out.examples = Array.isArray(value)
                    ? value.filter(isPlainObject).slice(0, 50).map((ex) => {
                        const normalized = {
                            en: cleanString(ex.en, 4000),
                            zh: cleanString(ex.zh, 4000)
                        };
                        // 學習模式的 AI 例句使用 english／chinese／alignment；
                        // 這些欄位若被削掉，保存後就只剩空白例句，因此最小保留。
                        if (typeof ex.english === 'string') normalized.english = cleanString(ex.english, 4000);
                        if (typeof ex.chinese === 'string') normalized.chinese = cleanString(ex.chinese, 4000);
                        if (Array.isArray(ex.alignment)) {
                            normalized.alignment = ex.alignment
                                .filter(isPlainObject)
                                .slice(0, 50)
                                .map((pair) => ({
                                    en: cleanString(pair.en, 1000),
                                    zh: cleanString(pair.zh, 1000)
                                }))
                                .filter((pair) => pair.en && pair.zh);
                        }
                        return normalized;
                    })
                    : [];
                break;
            case 'sources':
                out.sources = Array.isArray(value)
                    ? value.filter(isPlainObject).slice(0, 100).map((source) => ({
                        sentence: cleanString(source.sentence, 4000),
                        context: cleanString(source.context, 8000),
                        articleId: cleanString(source.articleId, READING_LIMITS.maxEntityId),
                        contentVersion: cleanString(source.contentVersion, READING_LIMITS.maxContentVersion),
                        anchor: normalizeAnchor(source.anchor),
                        addedAt: cleanString(source.addedAt, 40)
                    }))
                    : [];
                break;
            case 'explanation': {
                if (value === null || value === undefined) { out.explanation = null; break; }
                if (!isPlainObject(value)) break;
                out.explanation = {
                    language: cleanString(value.language, 20),
                    result: value.result === undefined ? null : value.result,
                    generatedAt: cleanString(value.generatedAt, 40),
                    provenance: isPlainObject(value.provenance) ? value.provenance : null
                };
                break;
            }
            case 'note':
                out.note = cleanString(value, READING_LIMITS.maxNoteChars);
                break;
            case 'content':
                out.content = cleanString(value, READING_LIMITS.maxDocumentChars);
                break;
            case 'title':
            case 'name':
                out[field] = cleanString(value, READING_LIMITS.maxTitleChars);
                break;
            case 'sentence':
            case 'quote':
                out[field] = cleanString(value, READING_LIMITS.maxQuoteChars);
                break;
            case 'meaning':
            case 'definition':
                out[field] = cleanString(value, 4000);
                break;
            case 'phonetic':
            case 'pos':
                out[field] = cleanString(value, 200);
                break;
            case 'word':
                out.word = cleanString(value, 400);
                break;
            case 'role':
                out.role = ['user', 'assistant', 'system'].includes(value) ? value : 'user';
                break;
            case 'status':
                out.status = cleanString(value, 40);
                break;
            case 'marked':
                // 只有明確 true 才是標記；false 是明確取消，必須原樣保存。
                out.marked = value === true;
                break;
            case 'understanding':
                out.understanding = UNDERSTANDING_STATES.includes(value) ? value : 'unmarked';
                break;
            case 'kind':
                out.kind = entityType === 'articleDocument'
                    ? (DOCUMENT_KINDS.includes(value) ? value : 'note')
                    : (READING_KINDS.includes(value) ? value : 'word');
                break;
            case 'firstViewedAt':
            case 'lastViewedAt':
            case 'createdAt':
            case 'updatedAt':
            case 'deletedAt':
            case 'addedAt':
            case 'removedAt':
                out[field] = value ? cleanString(value, 40) : '';
                break;
            case 'positionUncertain':
            case 'positionUnknown':
                out[field] = value === true;
                break;
            case 'contentVersion':
            case 'sourceContentVersion':
            case 'articleId':
            case 'bookId':
            case 'entryId':
            case 'itemId':
            case 'conversationId':
            case 'learningItemId':
            case 'legacyArticleKey':
                out[field] = cleanString(value, READING_LIMITS.maxContentVersion);
                break;
            default:
                out[field] = value;
        }
    }
    if (entityType === 'learningItem') {
        if (out.anchor) out.anchor = normalizeAnchor(out.anchor);
        if (out.understanding && !UNDERSTANDING_STATES.includes(out.understanding)) out.understanding = 'unmarked';
    }
    return out;
}

export function patchSize(patch) {
    try { return utf8Bytes(JSON.stringify(patch || {})); } catch (_) { return READING_LIMITS.maxPatchBytes + 1; }
}

export function validateReadingMutation(raw) {
    if (!isPlainObject(raw)) return { ok: false, error: READING_ERRORS.invalidMutation };
    const entityType = String(raw.entityType || '');
    const entityId = String(raw.entityId || '');
    if (!isReadingEntityType(entityType)) return { ok: false, error: READING_ERRORS.invalidEntity };
    if (!isValidEntityId(entityId)) return { ok: false, error: READING_ERRORS.invalidEntity };
    const op = raw.op === 'delete' ? 'delete' : (raw.op === 'upsert' ? 'upsert' : '');
    if (!op) return { ok: false, error: READING_ERRORS.invalidMutation };
    const expectedRevision = Number(raw.expectedRevision);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
        return { ok: false, error: READING_ERRORS.revisionRequired };
    }
    const mutationId = normalizeMutationId(raw.mutationId);
    if (!mutationId) return { ok: false, error: READING_ERRORS.invalidMutation };
    let patch = null;
    if (op === 'upsert') {
        patch = normalizeReadingPatch(entityType, raw.patch);
        if (!patch) return { ok: false, error: READING_ERRORS.invalidPatch };
        const size = patchSize(patch);
        if (size > READING_LIMITS.maxPatchBytes) return { ok: false, error: READING_ERRORS.entityTooLarge, size };
    }
    return {
        ok: true,
        mutation: {
            mutationId,
            entityType,
            entityId,
            op,
            expectedRevision,
            patch,
            clientUpdatedAt: cleanString(raw.clientUpdatedAt, 40)
        }
    };
}

export function wireReadingEntity(entity) {
    if (!isPlainObject(entity)) return null;
    const out = { ...entity };
    delete out.scope;
    delete out.key;
    delete out.pending;
    delete out.dirty;
    delete out.conflict;
    delete out.lastError;
    return out;
}

/**
 * 從完整實體產生下一個 mutation。`base` 只用來記錄合併基準，
 * 伺服器收到的是完整可編輯欄位（patch），避免不同版本各自解讀差異。
 */
/**
 * 穩定、可比較的 mutation 業務指紋。
 *
 * `clientUpdatedAt` 只代表傳輸／重試時間，不屬於業務內容；同一個 outbox
 * 重送時即使時間不同，也必須被視為同一次操作。反之，entityId、預期版本或
 * patch 任一業務欄位不同，就必須是不同操作，不能被當成冪等成功。
 */
function canonicalizeReadingValue(value) {
    if (Array.isArray(value)) return value.map((item) => canonicalizeReadingValue(item));
    if (value && typeof value === 'object') {
        const out = {};
        for (const key of Object.keys(value).sort()) out[key] = canonicalizeReadingValue(value[key]);
        return out;
    }
    return value === undefined ? null : value;
}

export function readingMutationFingerprint(mutation) {
    if (!mutation || typeof mutation !== 'object') return '';
    const entityType = String(mutation.entityType || '');
    const op = mutation.op === 'delete' ? 'delete' : 'upsert';
    const patch = op === 'delete' ? null : normalizeReadingPatch(entityType, mutation.patch || {});
    return JSON.stringify(canonicalizeReadingValue({
        mutationId: normalizeMutationId(mutation.mutationId),
        entityType,
        entityId: String(mutation.entityId || ''),
        op,
        expectedRevision: Number(mutation.expectedRevision) || 0,
        patch
    }));
}

export function mutationForEntity(entityType, entity, { mutationId, expectedRevision, op = 'upsert' } = {}) {
    if (!entity || !entity.id) return null;
    return {
        mutationId: normalizeMutationId(mutationId) || generateReadingId('m'),
        entityType,
        entityId: String(entity.id),
        op,
        expectedRevision: Number.isInteger(expectedRevision) ? expectedRevision : Number(entity.revision) || 0,
        patch: op === 'delete' ? null : normalizeReadingPatch(entityType, wireReadingEntity(entity)),
        clientUpdatedAt: new Date().toISOString()
    };
}

function deepEqual(a, b) {
    if (a === b) return true;
    if (a === null || b === null || a === undefined || b === undefined) return false;
    if (typeof a !== typeof b) return false;
    if (typeof a !== 'object') return false;
    try { return JSON.stringify(a) === JSON.stringify(b); } catch (_) { return false; }
}

function laterIso(a, b) {
    const left = String(a || '');
    const right = String(b || '');
    if (!left) return right;
    if (!right) return left;
    return left > right ? left : right;
}

function earlierIso(a, b) {
    const left = String(a || '');
    const right = String(b || '');
    if (!left) return right;
    if (!right) return left;
    return left < right ? left : right;
}

/**
 * 逐欄位三方合併。回傳 `{ record, conflicts }`：
 *   * `record` 是合併後應保留的本機版本（衝突欄位保留本機值）
 *   * `conflicts` 列出同欄位矛盾，呼叫端必須保留遠端值供使用者選擇，
 *     不得直接丟棄。
 */
export function mergeReadingEntity(entityType, { base = null, local = null, remote = null } = {}) {
    if (!isReadingEntityType(entityType)) return { record: local || remote, conflicts: [] };
    if (!local) return { record: { ...remote }, conflicts: [] };
    if (!remote) return { record: { ...local }, conflicts: [] };
    if (deepEqual(remote, local)) return { record: { ...local }, conflicts: [] };

    const baseObj = isPlainObject(base) ? base : {};
    const localObj = { ...local };
    const remoteObj = { ...remote };
    const merged = { ...remoteObj, ...localObj };
    const conflicts = [];
    const contentFields = ['note', 'marked', 'understanding', 'explanation', 'anchor', 'sentence', 'content', 'title'];
    const contentChanged = (changed, other) => contentFields.some((field) => !deepEqual(changed[field], baseObj[field])
        && !deepEqual(changed[field], other[field]));
    let deletionConflict = false;
    if (remoteObj.deletedAt && !localObj.deletedAt && !baseObj.deletedAt && contentChanged(localObj, remoteObj)) {
        // 雲端刪除 vs 本機編輯：保留本機內容並要求使用者選擇，不可默默吞掉筆記。
        conflicts.push({ field: 'deletedAt', local: '', remote: remoteObj.deletedAt });
        merged.deletedAt = '';
        deletionConflict = true;
    } else if (localObj.deletedAt && !remoteObj.deletedAt && !baseObj.deletedAt && contentChanged(remoteObj, localObj)) {
        conflicts.push({ field: 'deletedAt', local: localObj.deletedAt, remote: '' });
        merged.deletedAt = localObj.deletedAt;
        deletionConflict = true;
    }
    const fields = new Set([
        ...Object.keys(PATCH_FIELDS[entityType] || []),
        ...Object.keys(localObj),
        ...Object.keys(remoteObj)
    ]);

    for (const field of fields) {
        if (field === 'id' || field === 'scope' || field === 'revision' || field === 'pending'
            || field === 'dirty' || field === 'conflict' || field === 'key' || field === 'lastError') continue;
        if (field === 'firstViewedAt' || field === 'lastViewedAt') continue;
        if (field === 'deletedAt' && deletionConflict) continue;
        if (field === 'createdAt') {
            merged.createdAt = earlierIso(localObj.createdAt, remoteObj.createdAt);
            continue;
        }
        if (field === 'updatedAt') {
            merged.updatedAt = laterIso(localObj.updatedAt, remoteObj.updatedAt);
            continue;
        }
        const localVal = localObj[field];
        const remoteVal = remoteObj[field];
        if (deepEqual(localVal, remoteVal)) continue;
        // 舊後端／舊備份缺少 marked 不代表「明確取消」；本機已有的布林值
        // 必須保留，不能被缺欄位覆寫而讓取消標記在同步後復活。
        if (field === 'marked'
            && !Object.prototype.hasOwnProperty.call(remoteObj, 'marked')
            && typeof localVal === 'boolean') {
            merged.marked = localVal;
            continue;
        }
        const baseVal = baseObj[field];
        const localChanged = !deepEqual(localVal, baseVal);
        const remoteChanged = !deepEqual(remoteVal, baseVal);
        if (!localChanged && remoteChanged) {
            merged[field] = remoteVal;
            continue;
        }
        if (localChanged && remoteChanged) {
            // 刪除 vs 修改：保留本機內容並要求使用者處理，避免默默復活或默默刪除。
            conflicts.push({ field, local: localVal, remote: remoteVal });
            merged[field] = localVal;
            continue;
        }
        // 只有本機改或兩邊都沒改：保留本機（等價於 base）。
        merged[field] = localVal;
    }

    if (entityType === 'learningItem') {
        merged.firstViewedAt = earlierIso(localObj.firstViewedAt, remoteObj.firstViewedAt);
        merged.lastViewedAt = laterIso(localObj.lastViewedAt, remoteObj.lastViewedAt);
        merged.understanding = UNDERSTANDING_STATES.includes(merged.understanding) ? merged.understanding : 'unmarked';
        if (typeof merged.marked !== 'boolean' && typeof localObj.marked !== 'boolean' && typeof remoteObj.marked !== 'boolean') {
            delete merged.marked;
        } else if (typeof merged.marked !== 'boolean') {
            merged.marked = localObj.marked === true || remoteObj.marked === true;
        }
        if (!isPlainObject(merged.anchor)) merged.anchor = normalizeAnchor(merged.anchor);
    }

    merged.id = localObj.id || remoteObj.id;
    merged.revision = Math.max(Number(localObj.revision) || 0, Number(remoteObj.revision) || 0);
    if (localObj.scope) merged.scope = localObj.scope;
    return { record: merged, conflicts };
}

/** 舊快照仍帶詞書或聊天時回傳 true；伺服器據此關閉舊整組覆寫。 */
export function snapshotCarriesReading(payload) {
    if (!isPlainObject(payload)) return false;
    const vocab = payload.vocabulary;
    const assistant = payload.assistant;
    const vocabHas = isPlainObject(vocab) && Array.isArray(vocab.books) && vocab.books.length > 0;
    const assistantHas = isPlainObject(assistant) && Array.isArray(assistant.conversations) && assistant.conversations.length > 0;
    return vocabHas || assistantHas;
}

export function readingConflictPayload(entity) {
    return {
        error: READING_ERRORS.revisionConflict,
        code: READING_ERRORS.revisionConflict,
        conflict: true,
        current: entity ? wireReadingEntity(entity) : null
    };
}

export function parseReadingCursor(raw) {
    if (raw === undefined || raw === null || raw === '') return { cursor: 0, invalid: false };
    const text = String(raw).trim();
    if (!/^\d{1,15}$/.test(text)) return { cursor: 0, invalid: true };
    return { cursor: Number.parseInt(text, 10), invalid: false };
}

export function parseReadingLimit(raw, fallback = 200) {
    const text = String(raw == null ? '' : raw).trim();
    if (!/^\d{1,5}$/.test(text)) return fallback;
    const value = Number.parseInt(text, 10);
    if (!value) return fallback;
    return Math.min(READING_LIMITS.maxChangesPage, value);
}

/**
 * 在原文中定位引用。只有在唯一匹配（或句子本身唯一、引用落在該句內）時
 * 才回傳 `unique:true`；歧義時保留 quote／prefix／suffix，start/end 為 -1。
 */
export function locateTextAnchor(text, quote, sentence = '') {
    const body = String(text || '');
    const needle = String(quote || '').trim();
    if (!body || !needle) {
        return { anchor: { start: -1, end: -1, quote: needle, prefix: '', suffix: '' }, unique: false, candidates: 0 };
    }
    const positions = [];
    let index = body.indexOf(needle);
    while (index >= 0 && positions.length < 50) {
        positions.push(index);
        index = body.indexOf(needle, index + Math.max(1, needle.length));
    }
    let chosen = positions.length === 1 ? positions[0] : -1;
    if (positions.length > 1 && sentence) {
        const sentencePositions = [];
        let sentIndex = body.indexOf(sentence);
        while (sentIndex >= 0 && sentencePositions.length < 20) {
            sentencePositions.push(sentIndex);
            sentIndex = body.indexOf(sentence, sentIndex + Math.max(1, sentence.length));
        }
        if (sentencePositions.length === 1) {
            const within = body.indexOf(needle, sentencePositions[0]);
            if (within >= 0 && within < sentencePositions[0] + sentence.length) chosen = within;
        }
    }
    return {
        anchor: {
            start: chosen,
            end: chosen >= 0 ? chosen + needle.length : -1,
            quote: needle,
            prefix: chosen > 0 ? body.slice(Math.max(0, chosen - 40), chosen) : '',
            suffix: chosen >= 0 ? body.slice(chosen + needle.length, chosen + needle.length + 40) : ''
        },
        unique: chosen >= 0,
        candidates: positions.length
    };
}
