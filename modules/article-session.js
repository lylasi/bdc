import { captureArticleContext, isArticleContextActive } from './article-store.js';
import { isValidArticleId } from '../shared/article-protocol.mjs';

const RECENT_PREFIX = 'bdc:article-recent:v1:';
const EDITOR_PREFIX = 'bdc:article-editor:v1:';
let lastStagedTime = 0;

function editorKey(ctx, recordId) {
    return `${EDITOR_PREFIX}${encodeURIComponent(ctx.scope)}:${encodeURIComponent(recordId || '')}`;
}

// 最近閱讀只是一個裝置內指標，不加入 snapshot 或文章同步。
export function rememberArticle(id, ctx = captureArticleContext()) {
    if (!isArticleContextActive(ctx) || !isValidArticleId(id)) return;
    try { localStorage.setItem(RECENT_PREFIX + ctx.scope, id); } catch (_) { /* 便利功能不阻止開篇 */ }
}

export function recentArticleId(ctx = captureArticleContext()) {
    if (!isArticleContextActive(ctx)) return '';
    try {
        const id = localStorage.getItem(RECENT_PREFIX + ctx.scope) || '';
        return isValidArticleId(id) ? id : '';
    } catch (_) { return ''; }
}

/** 同步寫入本分頁的刷新備援；正式草稿仍寫進 article-store。 */
export function stageEditorDraft(draft, ctx) {
    if (!draft || !isArticleContextActive(ctx)) return null;
    lastStagedTime = Math.max(Date.now(), lastStagedTime + 1);
    const staged = { ...draft, savedAt: new Date(lastStagedTime).toISOString() };
    try {
        sessionStorage.setItem(editorKey(ctx, draft.recordId), JSON.stringify(staged));
        return staged;
    } catch (_) { return null; }
}

export function stagedEditorDraft(recordId, ctx = captureArticleContext()) {
    if (!isArticleContextActive(ctx)) return null;
    try {
        const draft = JSON.parse(sessionStorage.getItem(editorKey(ctx, recordId)) || 'null');
        return draft && draft.recordId === (recordId || '') && typeof draft.text === 'string' ? draft : null;
    } catch (_) { return null; }
}

export function clearStagedDraft(recordId, ctx, savedAt = '') {
    if (!isArticleContextActive(ctx)) return;
    const current = stagedEditorDraft(recordId, ctx);
    if (savedAt && current?.savedAt !== savedAt) return;
    try { sessionStorage.removeItem(editorKey(ctx, recordId)); } catch (_) { /* noop */ }
}
