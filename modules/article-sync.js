// 文章逐篇同步（伺服器游標 + 本機 outbox）。
//
// 與 snapshot 同步完全分開：
//   * 文章有自己的游標（伺服器 seq），不以 snapshot version 判定有沒有變更；
//   * 其他群組沒有變更時仍然要跑這裡；
//   * 失敗只影響文章同步，不會讓其他群組回捲。
//
// 衝突政策：伺服器以 expectedRevision 原子檢查；409 時保留本機內容，停住該篇的
// 上傳並記錄衝突，由使用者選擇「保留本機重試」或「另存副本」。

import { apiRequest, getAuthSnapshot } from './sync-cloudflare.js';
import * as store from './article-store.js';
import { ARTICLE_LIMITS } from '../shared/article-protocol.mjs';

const PAGE_LIMIT = 200;
const MAX_PULL_PAGES = 50;
const MAX_PUSH_PER_ROUND = 60;

let inFlight = null;

function loggedIn() {
    const snapshot = getAuthSnapshot();
    return !!(snapshot && snapshot.loggedIn);
}

async function readJson(response) {
    try {
        return await response.json();
    } catch (_) {
        return null;
    }
}

function authError(status, body) {
    const err = new Error((body && body.code) || `http_${status}`);
    err.code = (body && body.code) || (status === 401 ? 'unauthorized' : 'request_failed');
    err.status = status;
    return err;
}

// ─────────────────────────────────────────────────────────────────────────────
// 拉取
// ─────────────────────────────────────────────────────────────────────────────

async function fetchDocs(ids) {
    const unique = Array.from(new Set(ids)).slice(0, ARTICLE_LIMITS.batchMax);
    if (!unique.length) return [];
    const res = await apiRequest('/articles/batch', {
        method: 'POST',
        body: JSON.stringify({ ids: unique })
    }, { timeoutMs: 30000 });
    if (res.status === 401) throw authError(401, { code: 'unauthorized' });
    if (!res.ok) throw authError(res.status, await readJson(res));
    const body = await readJson(res);
    return Array.isArray(body?.articles) ? body.articles : [];
}

async function downloadAndApply(ids) {
    let applied = 0;
    for (let index = 0; index < ids.length; index += ARTICLE_LIMITS.batchMax) {
        const chunk = ids.slice(index, index + ARTICLE_LIMITS.batchMax);
        const docs = await fetchDocs(chunk);
        const found = new Set(docs.map((doc) => doc.id));
        for (const doc of docs) {
            const result = await store.applyRemoteDoc(doc);
            if (result.ok) applied += 1;
        }
        // 伺服器已沒有這篇（刪除或權限變更）→ 當成 tombstone，避免本機殘留幽靈資料
        for (const id of chunk) {
            if (!found.has(id)) await store.applyRemoteTombstone(id);
        }
    }
    return applied;
}

async function pullFull() {
    const serverIds = [];
    let offset = 0;
    let cursor = store.getCursor();
    for (let page = 0; page < MAX_PULL_PAGES; page += 1) {
        const res = await apiRequest(`/articles?full=1&includeDeleted=1&limit=500&offset=${offset}`, { method: 'GET' }, { timeoutMs: 30000 });
        if (res.status === 401) throw authError(401, { code: 'unauthorized' });
        if (!res.ok) throw authError(res.status, await readJson(res));
        const body = await readJson(res);
        const list = Array.isArray(body?.articles) ? body.articles : [];
        for (const item of list) {
            if (item && item.id) serverIds.push(item.id);
        }
        cursor = Number(body?.cursor) || cursor;
        if (!body?.hasMore) break;
        offset = Number(body?.offset) || offset + list.length;
    }
    const removed = await store.reconcileFullList(serverIds);
    // 逐篇核對 revision：只下載落後或缺少的
    const needDocs = [];
    for (const id of serverIds) {
        const record = store.getRecord(id);
        if (!record) needDocs.push(id);
    }
    // 未下載的（含本機尚未有 tombstone 的）一次抓回
    const applied = await downloadAndApply(needDocs);
    await store.setCursor(cursor);
    return { reset: true, removed: removed.length, applied };
}

async function pullDelta() {
    let cursor = store.getCursor();
    let applied = 0;
    let removed = 0;
    let pulled = 0;
    for (let page = 0; page < MAX_PULL_PAGES; page += 1) {
        const res = await apiRequest(`/articles?cursor=${cursor}&limit=${PAGE_LIMIT}`, { method: 'GET' }, { timeoutMs: 30000 });
        if (res.status === 401) throw authError(401, { code: 'unauthorized' });
        if (!res.ok) throw authError(res.status, await readJson(res));
        const body = await readJson(res);
        if (body?.resetRequired) {
            const result = await pullFull();
            return { ...result, pulled: result.applied, removed: result.removed };
        }
        const changes = Array.isArray(body?.changes) ? body.changes : [];
        pulled += changes.length;
        const { needDocs, tombstones } = store.planRemote(changes);
        for (const id of tombstones) {
            await store.applyRemoteTombstone(id);
            removed += 1;
        }
        if (needDocs.length) applied += await downloadAndApply(needDocs);
        const next = Number(body?.cursor);
        if (Number.isFinite(next) && next >= cursor) cursor = next;
        await store.setCursor(cursor);
        if (!body?.hasMore) break;
    }
    return { reset: false, pulled, applied, removed };
}

// ─────────────────────────────────────────────────────────────────────────────
// 上傳
// ─────────────────────────────────────────────────────────────────────────────

async function pushOne(op) {
    const record = store.getRecord(op.articleId);
    if (!record) {
        await store.markOpDone(op.articleId, { revision: op.expectedRevision });
        return { ok: true, skipped: true };
    }
    const payloadDoc = {
        title: record.title || '',
        body: record.article || '',
        analysis: record.result === undefined ? null : record.result,
        sourceType: record.sourceType || 'paste',
        sourceUrl: record.sourceUrl || ''
    };
    const mutationId = op.clientMutationId;
    if (op.type === 'create') {
        const res = await apiRequest('/articles', {
            method: 'POST',
            body: JSON.stringify({ ...payloadDoc, id: op.articleId, clientMutationId: mutationId })
        }, { timeoutMs: 30000 });
        const body = await readJson(res);
        if (res.status === 401) throw authError(401, body);
        if (res.ok && body?.article) {
            await store.markOpDone(op.articleId, { revision: body.article.revision, serverUpdatedAt: body.article.updatedAt });
            return { ok: true };
        }
        if (res.status === 409 && body?.code === 'article_id_exists') {
            // 另一個裝置／先前的重試已經建立成功：拉回伺服器版本再比對
            const docs = await fetchDocs([op.articleId]);
            const doc = docs[0];
            if (doc) {
                if (doc.body === payloadDoc.body && doc.title === payloadDoc.title) {
                    await store.applyRemoteDoc({ ...doc, deletedAt: '' });
                    await store.markOpDone(op.articleId, { revision: doc.revision, serverUpdatedAt: doc.updatedAt });
                    return { ok: true, idempotent: true };
                }
                await store.markOpFailed(op.articleId, body?.code, {
                    conflict: { kind: 'id_exists', remoteRevision: doc.revision, remoteTitle: doc.title }
                });
                return { ok: false, conflict: true };
            }
        }
        await store.markOpFailed(op.articleId, body?.code || `http_${res.status}`);
        return { ok: false, error: body?.code || res.status, status: res.status };
    }

    if (op.type === 'update') {
        const res = await apiRequest(`/articles/${encodeURIComponent(op.articleId)}`, {
            method: 'PUT',
            body: JSON.stringify({ ...payloadDoc, expectedRevision: record.revision, clientMutationId: mutationId })
        }, { timeoutMs: 30000 });
        const body = await readJson(res);
        if (res.status === 401) throw authError(401, body);
        if (res.ok && body?.article) {
            await store.markOpDone(op.articleId, { revision: body.article.revision, serverUpdatedAt: body.article.updatedAt });
            return { ok: true };
        }
        if (res.status === 409 && body?.code === 'article_revision_conflict') {
            await store.markOpFailed(op.articleId, body.code, {
                conflict: {
                    kind: 'revision',
                    remoteRevision: Number(body?.current?.revision) || 0,
                    remoteTitle: body?.current?.title || ''
                }
            });
            return { ok: false, conflict: true };
        }
        if (res.status === 409 && body?.code === 'article_already_deleted') {
            await store.markOpFailed(op.articleId, body.code, {
                conflict: { kind: 'deleted_remote', remoteRevision: Number(body?.current?.revision) || 0 }
            });
            return { ok: false, conflict: true };
        }
        if (res.status === 404) {
            // 伺服器沒有這篇（例如在別處被刪除後清空）：改以建立重送，避免永久卡住
            await store.requeueAsCreate(op.articleId);
            return { ok: false, error: 'article_not_found', requeued: true };
        }
        await store.markOpFailed(op.articleId, body?.code || `http_${res.status}`);
        return { ok: false, error: body?.code || res.status, status: res.status };
    }

    if (op.type === 'delete' || op.type === 'restore') {
        const path = op.type === 'delete'
            ? `/articles/${encodeURIComponent(op.articleId)}`
            : `/articles/${encodeURIComponent(op.articleId)}/restore`;
        const res = await apiRequest(path, {
            method: op.type === 'delete' ? 'DELETE' : 'POST',
            body: JSON.stringify({ expectedRevision: record.revision, clientMutationId: mutationId })
        }, { timeoutMs: 30000 });
        const body = await readJson(res);
        if (res.status === 401) throw authError(401, body);
        if (res.ok) {
            await store.markOpDone(op.articleId, { revision: body?.article?.revision, serverUpdatedAt: body?.article?.updatedAt });
            return { ok: true };
        }
        if (res.status === 404 && op.type === 'delete') {
            await store.markOpDone(op.articleId, { revision: record.revision });
            return { ok: true, idempotent: true };
        }
        if (res.status === 409) {
            await store.markOpFailed(op.articleId, body?.code || 'article_revision_conflict', {
                conflict: {
                    kind: 'revision',
                    remoteRevision: Number(body?.current?.revision) || 0,
                    remoteTitle: body?.current?.title || ''
                }
            });
            return { ok: false, conflict: true };
        }
        await store.markOpFailed(op.articleId, body?.code || `http_${res.status}`);
        return { ok: false, error: body?.code || res.status, status: res.status };
    }

    await store.markOpDone(op.articleId);
    return { ok: true, skipped: true };
}

async function pushOutbox() {
    const ops = (await store.listPending()).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    let pushed = 0;
    let conflicts = 0;
    let failed = 0;
    for (const op of ops.slice(0, MAX_PUSH_PER_ROUND)) {
        const conflict = store.getConflicts().find((item) => item.articleId === op.articleId);
        if (conflict) { conflicts += 1; continue; } // 等使用者決定，不自動覆蓋遠端
        const result = await pushOne(op);
        if (result.ok) pushed += 1;
        else if (result.conflict) conflicts += 1;
        else {
            failed += 1;
            // 容量或授權錯誤：停止本輪，避免重複撞同一面牆
            if (result.status === 413 || result.status === 409 || result.status === 429) break;
        }
    }
    return { pushed, conflicts, failed };
}

// ─────────────────────────────────────────────────────────────────────────────
// 舊資料上傳（保留原 ID、開啟閘門）
// ─────────────────────────────────────────────────────────────────────────────

async function pushLegacyMigration() {
    const ops = (await store.listPending()).filter((op) => op.type === 'create' && op.legacy);
    const gatePending = store.getGatePending();
    if (!ops.length && !gatePending) return { imported: 0, skipped: 0 };

    const ids = ops.map((op) => op.articleId);
    const records = ids.map((id) => store.getRecord(id)).filter(Boolean);
    const articles = records.map((record) => ({
        legacyId: record.articleId,
        title: record.title || '',
        body: record.article || '',
        analysis: record.result === undefined ? null : record.result,
        sourceType: record.sourceType || 'paste',
        sourceUrl: record.sourceUrl || ''
    }));
    let imported = 0;
    let skipped = 0;
    for (let index = 0; index < articles.length; index += ARTICLE_LIMITS.importMax) {
        const chunk = articles.slice(index, index + ARTICLE_LIMITS.importMax);
        const res = await apiRequest('/articles/import', {
            method: 'POST',
            body: JSON.stringify({ articles: chunk })
        }, { timeoutMs: 60000 });
        const body = await readJson(res);
        if (res.status === 401) throw authError(401, body);
        if (!res.ok) {
            // 容量不足或格式問題：不清掉 outbox，保留資料等使用者處理
            await store.markSyncError(body?.code || `http_${res.status}`);
            return { imported, skipped, error: body?.code || res.status };
        }
        imported += Number(body?.imported) || 0;
        skipped += Number(body?.skipped) || 0;
    }

    // 匯入後逐篇核對版本：內容一致才接受伺服器版本，否則保留本機修改等衝突流程。
    if (records.length) {
        const docs = await fetchDocs(records.map((record) => record.articleId));
        const byId = new Map(docs.map((doc) => [doc.id, doc]));
        for (const record of records) {
            const doc = byId.get(record.articleId);
            if (doc && doc.body === record.article && doc.title === (record.title || '')) {
                await store.applyRemoteDoc(doc);
                await store.markOpDone(record.articleId, { revision: doc.revision, serverUpdatedAt: doc.updatedAt });
            } else if (doc) {
                await store.markOpFailed(record.articleId, 'legacy_content_differs', {
                    conflict: { kind: 'legacy_differs', remoteRevision: doc.revision, remoteTitle: doc.title }
                });
            }
        }
    }

    // 匯入完成後開啟閘門（空批次 + final 也支援）；失敗就留待下次重試。
    const finalRes = await apiRequest('/articles/import', {
        method: 'POST',
        body: JSON.stringify({ articles: [], final: true })
    }, { timeoutMs: 30000 });
    if (finalRes.ok) await store.setGatePending(false);
    return { imported, skipped };
}

// ─────────────────────────────────────────────────────────────────────────────
// 對外
// ─────────────────────────────────────────────────────────────────────────────

export async function syncArticles(options = {}) {
    if (inFlight) return inFlight;
    if (!loggedIn()) {
        // 未登入：只做本機遷移，不上傳任何資料（訪客內容不會歸給下一個帳戶）
        const local = await store.migrateLegacyLocalData().catch(() => ({ ok: false }));
        return { skipped: true, reason: 'signed_out', migration: local };
    }
    inFlight = (async () => {
        const scope = await store.refreshScope();
        const migration = await store.migrateLegacyLocalData();
        if (!migration.ok) {
            await store.markSyncError(migration.error || 'migration_failed');
            return { ok: false, error: migration.error || 'migration_failed', migration, scope };
        }
        const legacy = await pushLegacyMigration();
        const pulled = await pullDelta();
        const pushed = await pushOutbox();
        await store.markSynced();
        return { ok: true, scope, migration, legacy, pulled, pushed, at: new Date().toISOString() };
    })();
    try {
        return await inFlight;
    } catch (error) {
        await store.markSyncError(error && error.code ? error.code : 'sync_failed').catch(() => {});
        throw error;
    } finally {
        inFlight = null;
    }
}

export async function resolveKeepMine(articleId) {
    const conflict = store.getConflicts().find((item) => item.articleId === articleId);
    if (!conflict) return { ok: false, error: 'no_conflict' };
    if (conflict.remoteRevision) await store.setBaseRevision(articleId, conflict.remoteRevision);
    await store.clearConflict(articleId);
    const record = store.getRecord(articleId);
    if (record) await store.enqueueForRetry(articleId);
    return syncArticles();
}

export async function resolveSaveCopy(articleId) {
    const result = await store.duplicateArticle(articleId, ' (copy)');
    if (!result.ok) return result;
    // 原篇放棄本機修改，改成伺服器版本
    const docs = await fetchDocs([articleId]);
    if (docs[0]) await store.applyRemoteDoc(docs[0]);
    await store.discardPending(articleId);
    await store.clearConflict(articleId);
    await syncArticles();
    return result;
}

export async function resolveUseRemote(articleId) {
    const docs = await fetchDocs([articleId]);
    if (!docs[0]) return { ok: false, error: 'article_not_found' };
    await store.applyRemoteDoc(docs[0]);
    await store.discardPending(articleId);
    await store.clearConflict(articleId);
    return { ok: true };
}

export function isArticleSyncRunning() {
    return !!inFlight;
}
