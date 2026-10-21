// 文章閱讀檔案的使用者動作（查閱記錄、收藏、標記、筆記、AI 文件）。
//
// 功能模組只呼叫這裡，不直接散寫 reading-store 的欄位；所有非同步動作
// 都在開始時固定 articleId / anchor，回應回來後不會寫到切換後的文章。

import * as articleStore from './article-store.js';
import * as readingStore from './reading-store.js';
import * as vocab from './vocab.js';
import * as api from './api.js';
import { getPreferredTaskSpec } from './ai-models.js';
import { loadGlobalSettings } from './settings.js';
import { buildPrompt } from './prompts/index.js';
import { getLocale, t } from './i18n.js';
import {
    contentVersionOf,
    locateTextAnchor,
    normalizeAnchor
} from '../shared/reading-protocol.mjs';

const PROMPT_VERSION = 'article.readingSummary@1.1.0';

/** 在非同步動作開始時固定文章與閱讀 scope；完成後不得寫到新帳戶／新文章。 */
export function captureActionContext() {
    return {
        reading: readingStore.captureReadingContext(),
        articleScope: articleStore.getArticleScope(),
        articleGeneration: typeof articleStore.getScopeGeneration === 'function' ? articleStore.getScopeGeneration() : 0
    };
}

export function actionContextActive(actionCtx) {
    if (!actionCtx) return true;
    return actionCtx.articleScope === articleStore.getArticleScope()
        && actionCtx.articleGeneration === (typeof articleStore.getScopeGeneration === 'function' ? articleStore.getScopeGeneration() : 0)
        && readingStore.isReadingContextActive(actionCtx.reading);
}

export function articleBody(articleId) {
    const record = articleStore.getRecord(articleId);
    return record?.article || '';
}

export function articleVersion(articleId) {
    return contentVersionOf(articleBody(articleId));
}

export function resolveAnchor(articleId, quote, sentence = '', hintStart = -1, bodyOverride = null) {
    const body = bodyOverride == null ? articleBody(articleId) : String(bodyOverride);
    const located = locateTextAnchor(body, quote, sentence);
    const anchor = located.anchor;
    if (!located.unique && hintStart >= 0 && body.slice(hintStart, hintStart + String(quote).length) === quote) {
        return normalizeAnchor({
            start: hintStart,
            end: hintStart + String(quote).length,
            quote,
            prefix: body.slice(Math.max(0, hintStart - 40), hintStart),
            suffix: body.slice(hintStart + String(quote).length, hintStart + String(quote).length + 40)
        });
    }
    if (!located.unique && !sentence) {
        // 位置不確定時保留引用與前後文空白；UI 會標示「位置待確認」。
        return normalizeAnchor({ start: -1, end: -1, quote, prefix: anchor.prefix, suffix: anchor.suffix });
    }
    return anchor;
}

/**
 * 用已知的精確 offset 重建錨點（不改用全文文字搜尋）。
 * 內文已改寫、offset 不再對應原引用時回傳 null，由呼叫端決定是否放棄。
 */
export function anchorFromOffsets(articleId, quote, start, end) {
    const text = String(quote || '');
    const body = articleBody(articleId);
    const from = Number(start);
    const to = Number(end);
    if (!text || !Number.isFinite(from) || from < 0) return null;
    if (body.slice(from, from + text.length) !== text) return null;
    const expectedEnd = Number.isFinite(to) && to > from ? to : from + text.length;
    return normalizeAnchor({
        start: from,
        end: expectedEnd,
        quote: text,
        prefix: body.slice(Math.max(0, from - 40), from),
        suffix: body.slice(expectedEnd, expectedEnd + 40)
    });
}

export function explanationFromItem(item) {
    if (!item || !item.explanation) return null;
    return item.explanation.result || null;
}

/**
 * 找同一個 occurrence 的既有條目。
 *
 * `options.anchor` 有精確 offset 時，只按「同一錨點＋同一內文版本」查詢；
 * 絕不退回到全文文字搜尋，否則同一段文字出現兩次時會拿到另一處的狀態
 * （例如第二處已標記卻顯示未標記）。只有舊資料真的沒有位置（start < 0）
 * 才允許用引用文字＋句子比對。
 */
export function findSavedItem(articleId, kind, quote, sentence = '', options = {}) {
    if (!articleId || !quote) return null;
    const version = options.contentVersion === undefined || options.contentVersion === null
        ? articleVersion(articleId)
        : String(options.contentVersion);
    const anchor = options.anchor
        ? normalizeAnchor(options.anchor)
        : resolveAnchor(articleId, quote, sentence);
    const exact = readingStore.findLearningItem(articleId, kind, anchor, version);
    if (exact) return exact;
    const positioned = Number(anchor.start) >= 0 && Number(anchor.end) >= 0;
    if (positioned) {
        // 同一段文字出現多次時，位置未知的舊條目無法歸屬到哪一處，不得拿它冒充狀態。
        const occurrences = locateTextAnchor(articleBody(articleId), quote, sentence).candidates;
        if (occurrences > 1) return null;
        return readingStore.findUnpositionedItem(articleId, kind, quote, sentence, version);
    }
    if (kind === 'sentence') return readingStore.findSentenceItem(articleId, quote, version);
    return readingStore.findPhraseItem(articleId, quote, sentence, version);
}

function normalizeExplanationData(kind, data) {
    if (!data) return null;
    if (kind === 'word') {
        return data.analysis ? data : {
            word: data.word || '',
            sentence: data.sentence || '',
            analysis: data.analysis || data
        };
    }
    return data;
}

/**
 * 保存實際呈現給使用者的解釋。`markViewed` 僅在畫面真的顯示成功時為 true；
 * 背景預取、失敗或已切走的回應只保存解釋，不更新查閱時間。
 */
export async function recordExplanation({
    articleId,
    kind,
    quote,
    sentence = '',
    context = '',
    data,
    markViewed = false,
    anchor = null,
    contentVersion = null,
    actionContext: actionCtx = null
}) {
    if (!articleId || !quote) return { ok: false, error: 'missing_target' };
    // 帳戶／文章範圍已切換時，舊回應不得寫入新 scope。
    if (!actionContextActive(actionCtx)) return { ok: false, error: 'stale_scope' };
    if (!articleStore.getRecord(articleId)) return { ok: false, error: 'stale_scope' };
    // 版本與錨點必須由「請求／選區建立時」傳入；重新計算會把舊回應寫成新版本。
    const version = contentVersion === null || contentVersion === undefined
        ? articleVersion(articleId)
        : String(contentVersion);
    const resolvedAnchor = anchor || resolveAnchor(articleId, quote, sentence);
    const explanation = {
        language: getLocale(),
        result: normalizeExplanationData(kind, data),
        generatedAt: new Date().toISOString(),
        provenance: {
            promptVersion: kind === 'word' ? 'article.wordTooltip' : (kind === 'sentence' ? 'article.sentenceAnalysis' : 'article.phraseAnalysis'),
            source: 'ai_or_cache'
        }
    };
    const result = await readingStore.upsertLearningItem({
        articleId,
        contentVersion: version,
        kind,
        anchor: resolvedAnchor,
        sentence,
        explanation
    }, { markViewed });
    return result;
}

/** 建立或更新條目但不改變標記（收藏、寫筆記、查閱都可以先於標記發生）。 */
export async function ensureItem({
    articleId,
    kind,
    quote,
    sentence = '',
    context = '',
    anchor = null,
    note = undefined,
    marked = undefined,
    contentVersion = null,
    actionContext: actionCtx = null
}) {
    if (!articleId || !quote) return { ok: false, error: 'missing_target' };
    if (!actionContextActive(actionCtx)) return { ok: false, error: 'stale_scope' };
    if (!articleStore.getRecord(articleId)) return { ok: false, error: 'stale_scope' };
    const version = contentVersion === null || contentVersion === undefined
        ? articleVersion(articleId)
        : String(contentVersion);
    const resolvedAnchor = anchor || resolveAnchor(articleId, quote, sentence);
    const payload = {
        articleId,
        contentVersion: version,
        kind,
        anchor: resolvedAnchor,
        sentence
    };
    // 只有明確指定的欄位才更新；收藏／筆記不得把既有標記或筆記重設。
    if (note !== undefined) payload.note = note;
    if (marked !== undefined) payload.marked = marked === true;
    return readingStore.upsertLearningItem(payload, { markViewed: false });
}

/** 單一標記切換；查閱、寫筆記、AI 回應都不會呼叫這裡。 */
export async function setMarked(itemId, marked, actionCtx = null) {
    if (!actionContextActive(actionCtx)) return { ok: false, error: 'stale_scope' };
    if (!itemId) return { ok: false, error: 'missing_item' };
    return readingStore.patchLearningItem(itemId, { marked: marked === true });
}

export async function toggleMarked(itemId, actionCtx = null) {
    const item = readingStore.getLearningItem(itemId);
    if (!item) return { ok: false, error: 'not_found' };
    return setMarked(itemId, item.marked !== true, actionCtx);
}

// 測試用：允許注入一次「儲存失敗」，驗證草稿不會被清掉且可重試。
let noteSaveInterceptorForTests = null;
export function __setNoteSaveInterceptorForTests(fn) {
    noteSaveInterceptorForTests = typeof fn === 'function' ? fn : null;
}

export async function saveNote(itemId, note, actionCtx = null) {
    if (!actionContextActive(actionCtx)) return { ok: false, error: 'stale_scope' };
    if (noteSaveInterceptorForTests) {
        const override = await noteSaveInterceptorForTests({ itemId, note: String(note || '') });
        if (override) return override;
    }
    return readingStore.patchLearningItem(itemId, { note: String(note || '') });
}

export async function addItemToVocabulary(item, options = {}) {
    if (!item) return { ok: false, error: 'missing_item' };
    return vocab.addWordToCurrentArticleBook(item.anchor?.quote || '', {
        source: 'article',
        sentence: item.sentence || options.sentence || '',
        context: options.context || '',
        meaning: options.meaning !== undefined && options.meaning !== ''
            ? options.meaning
            : (item.explanation?.result?.analysis?.meaning
                || item.explanation?.result?.meaning
                || ''),
        phonetic: options.phonetic || item.explanation?.result?.analysis?.phonetic || '',
        pos: options.pos || item.explanation?.result?.analysis?.pos || '',
        articleId: item.articleId,
        contentVersion: item.contentVersion,
        anchor: item.anchor,
        itemId: item.id,
        kind: item.kind
    });
}

export async function saveAiAnswerAsDocument({
    articleId,
    conversationId,
    messageId,
    content,
    learningItemId = '',
    title = ''
}) {
    if (!articleId || !content) return { ok: false, error: 'missing_content' };
    const actionCtx = captureActionContext();
    if (!actionContextActive(actionCtx)) return { ok: false, error: 'stale_scope' };
    return readingStore.saveArticleDocument({
        articleId,
        kind: 'ai',
        title: title || String(content).replace(/\s+/g, ' ').trim().slice(0, 60),
        content,
        sourceItemIds: learningItemId ? [learningItemId] : [],
        sourceMessageIds: messageId ? [messageId] : [],
        contentVersion: articleVersion(articleId)
    });
}

function formatRecordForAI(item, index, includeNotes = true) {
    const meaning = item.explanation?.result?.analysis?.meaning
        || item.explanation?.result?.meaning
        || item.explanation?.result?.translation
        || '';
    const note = String(item.note || '').trim();
    return [
        `${index + 1}. [${item.kind}] ${item.anchor?.quote || ''}`,
        item.sentence ? `   sentence: ${item.sentence}` : '',
        meaning ? `   saved explanation: ${meaning}` : '',
        `   marked: ${item.marked === true ? 'yes' : 'no'}`,
        includeNotes && note ? `   personal note: ${note}` : '',
        item.anchor?.start < 0 || item.positionUncertain ? '   position: uncertain' : ''
    ].filter(Boolean).join('\n');
}

/**
 * 「分析本文難點」／「整理閱讀筆記」：先由使用者選範圍，再走既有 api.js。
 * 結果保存成新的 AI 文件；不改標記或個人筆記。
 */
export async function generateReadingDocument({
    articleId,
    mode = 'notes',
    itemIds = null,
    documentIds = [],
    includeNotes = true
}) {
    const actionCtx = captureActionContext();
    const record = articleStore.getRecord(articleId);
    if (!record) return { ok: false, error: 'article_not_found' };
    const allItems = readingStore.listLearningItems(articleId).filter((item) => !item.deletedAt);
    const selected = Array.isArray(itemIds)
        ? allItems.filter((item) => itemIds.includes(item.id))
        : allItems;
    const filtered = selected;
    if (!filtered.length && !documentIds.length) return { ok: false, error: 'empty_selection' };
    const docs = documentIds.length
        ? documentIds.map((id) => readingStore.getArticleDocument(id)).filter(Boolean)
        : readingStore.listArticleDocuments(articleId, { withContent: true }).filter((doc) => doc.kind === 'ai');
    const records = [
        ...filtered.map((item, index) => formatRecordForAI(item, index, includeNotes)),
        ...docs.map((doc, index) => `[saved AI material ${index + 1}] ${doc.title}\n${doc.content}`)
    ].join('\n\n');
    // 與一般文章分析同一條解析鏈：先看「文章詳解」任務，再回退查詞模型。
    // 使用 'article' 這種不存在的任務名會拿不到設定，誤報未配置。
    const model = getPreferredTaskSpec(['articleAnalysis', 'wordAnalysis'], { settings: loadGlobalSettings() });
    if (!model) {
        return { ok: false, error: 'ai_not_configured' };
    }
    const contentVersion = articleVersion(articleId);
    const prompt = buildPrompt('article.readingSummary', {
        mode: mode === 'difficulties' ? 'difficulties' : 'notes',
        title: record.title || '',
        source: record.sourceUrl || record.sourceType || '',
        contentVersion,
        records
    }, { locale: getLocale() });
    const response = await api.requestAI({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        timeoutMs: 90000,
        taskType: 'articleAnalysis'
    });
    const text = String(response?.text || response?.choices?.[0]?.message?.content || '').trim();
    if (!text) return { ok: false, error: 'empty_ai_response' };
    if (!actionContextActive(actionCtx)) return { ok: false, error: 'stale_scope' };
    const saved = await readingStore.saveArticleDocument({
        articleId,
        kind: 'ai',
        title: mode === 'difficulties' ? t('article.aiDifficultiesTitle') : t('article.aiNotesTitle'),
        content: text,
        sourceItemIds: filtered.map((item) => item.id),
        sourceMessageIds: [],
        contentVersion
    });
    if (!saved.ok) return saved;
    return { ok: true, document: saved.entity, provenance: { model, promptVersion: PROMPT_VERSION } };
}

export async function deleteItem(itemId) {
    return readingStore.deleteLearningItem(itemId);
}
