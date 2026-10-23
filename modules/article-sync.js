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
import {
    ARTICLE_LIMITS,
    normalizeAnalysis,
    normalizeSourceType,
    normalizeSourceUrl,
    normalizeTitle
} from '../shared/article-protocol.mjs';

const PAGE_LIMIT = 200;
const MAX_PULL_PAGES = 50;
const MAX_PUSH_PER_ROUND = 60;

let inFlight = null;
// 同步在途時收到的新請求只排一輪後續同步；直接回傳舊 promise 會讓
// 期間新增的 outbox（例如剛解決衝突、或別台裝置的新墓碑）被跳過。
let queuedSync = null;

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

function staleScopeError() {
    const err = new Error('article_scope_changed');
    err.code = 'stale_scope';
    return err;
}

/** 每個網路邊界與寫入前都核對入口 scope + generation（A→B→A 也失效）。 */
function assertArticleScope(ctx) {
    if (!store.isArticleContextActive(ctx)) throw staleScopeError();
}

/**
 * 文章同步的所有請求都屬於同一輪同步，需一併受整輪期限約束：
 * 單一請求逾時之外，整輪（文章→閱讀→快照）也不能無限拖長。
 */
function request(path, options = {}, timeoutMs = 30000) {
    return apiRequest(path, options, { timeoutMs, roundScoped: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// 拉取
// ─────────────────────────────────────────────────────────────────────────────

async function fetchDocs(ids) {
    const unique = Array.from(new Set(ids)).slice(0, ARTICLE_LIMITS.batchMax);
    if (!unique.length) return [];
    const res = await request('/articles/batch', {
        method: 'POST',
        body: JSON.stringify({ ids: unique })
    }, 30000);
    if (res.status === 401) throw authError(401, { code: 'unauthorized' });
    if (!res.ok) throw authError(res.status, await readJson(res));
    const body = await readJson(res);
    return Array.isArray(body?.articles) ? body.articles : [];
}

async function downloadAndApply(ids, ctx) {
    assertArticleScope(ctx);
    let applied = 0;
    for (let index = 0; index < ids.length; index += ARTICLE_LIMITS.batchMax) {
        assertArticleScope(ctx);
        const chunk = ids.slice(index, index + ARTICLE_LIMITS.batchMax);
        const docs = await fetchDocs(chunk);
        assertArticleScope(ctx);
        if (docs.length) {
            // 整批在同一個 IndexedDB 交易套用；逐篇開交易會讓首次下載變成 N 次交易。
            const result = await store.applyRemoteDocs(docs, ctx);
            if (!result.ok) {
                const err = new Error(result.error || 'article_apply_failed');
                err.code = result.error || 'article_apply_failed';
                throw err;
            }
            applied += result.results.filter((item) => item.applied).length;
        }
        // 伺服器已沒有這篇（刪除或權限變更）→ 當成 tombstone，避免本機殘留幽靈資料
        const found = new Set(docs.map((doc) => doc.id));
        const missing = chunk.filter((id) => !found.has(id));
        if (missing.length) {
            const result = await store.applyRemoteTombstones(missing, ctx);
            if (!result.ok) {
                const err = new Error(result.error || 'article_tombstone_failed');
                err.code = result.error || 'article_tombstone_failed';
                throw err;
            }
        }
    }
    return applied;
}

async function pullFull(ctx) {
    assertArticleScope(ctx);
    const serverIds = [];
    const serverItems = new Map();
    let offset = 0;
    let cursor = store.getCursor();
    for (let page = 0; page < MAX_PULL_PAGES; page += 1) {
        const res = await request(`/articles?full=1&includeDeleted=1&limit=500&offset=${offset}`, { method: 'GET' }, 30000);
        if (res.status === 401) throw authError(401, { code: 'unauthorized' });
        if (!res.ok) throw authError(res.status, await readJson(res));
        const body = await readJson(res);
        const list = Array.isArray(body?.articles) ? body.articles : [];
        for (const item of list) {
            if (item && item.id) {
                serverIds.push(item.id);
                serverItems.set(item.id, item);
            }
        }
        cursor = Number(body?.cursor) || cursor;
        if (!body?.hasMore) break;
        offset = Number(body?.offset) || offset + list.length;
        assertArticleScope(ctx);
    }
    assertArticleScope(ctx);
    const reconciled = await store.reconcileFullList(serverIds, ctx);
    assertArticleScope(ctx);
    if (!reconciled || reconciled.ok !== true) {
        // 後備桶讀不到／損壞時 reconcileFullList 會明確失敗：完整清單沒有真的
        // 套用（可能還有本機已移除的遠端文章），不能靜默繼續。
        const code = (reconciled && reconciled.error) || 'article_reconcile_failed';
        const err = new Error(code);
        err.code = code;
        throw err;
    }
    const removed = reconciled.removed || [];
    // 逐篇核對 revision：缺少、落後（且本機沒有未上傳修改）或遠端已墓碑都要處理。
    const needDocs = [];
    const tombstones = [];
    for (const id of serverIds) {
        const record = store.getRecord(id);
        const item = serverItems.get(id) || {};
        if (item.deletedAt) {
            if (record && !record.dirty && !record.pending) tombstones.push(id);
            continue;
        }
        if (!record) { needDocs.push(id); continue; }
        if (record.dirty || record.pending) continue;
        if (Number(item.revision) > Number(record.revision)) needDocs.push(id);
    }
    if (tombstones.length) {
        const result = await store.applyRemoteTombstones(tombstones, ctx);
        if (!result.ok) {
            const err = new Error(result.error || 'article_tombstone_failed');
            err.code = result.error || 'article_tombstone_failed';
            throw err;
        }
    }
    // 未下載的（含本機尚未有 tombstone 的）一次抓回
    const applied = await downloadAndApply(needDocs, ctx);
    assertArticleScope(ctx);
    await store.setCursor(cursor, ctx);
    return { reset: true, removed: removed.length + tombstones.length, applied };
}

async function pullDelta(ctx) {
    assertArticleScope(ctx);
    let cursor = store.getCursor();
    let applied = 0;
    let removed = 0;
    let pulled = 0;
    for (let page = 0; page < MAX_PULL_PAGES; page += 1) {
        const res = await request(`/articles?cursor=${cursor}&limit=${PAGE_LIMIT}`, { method: 'GET' }, 30000);
        if (res.status === 401) throw authError(401, { code: 'unauthorized' });
        if (!res.ok) throw authError(res.status, await readJson(res));
        const body = await readJson(res);
        assertArticleScope(ctx);
        if (body?.resetRequired) {
            const result = await pullFull(ctx);
            return { ...result, pulled: result.applied, removed: result.removed };
        }
        const changes = Array.isArray(body?.changes) ? body.changes : [];
        pulled += changes.length;
        const { needDocs, tombstones } = store.planRemote(changes);
        if (tombstones.length) {
            const result = await store.applyRemoteTombstones(tombstones, ctx);
            if (!result.ok) {
                const err = new Error(result.error || 'article_tombstone_failed');
                err.code = result.error || 'article_tombstone_failed';
                throw err;
            }
            removed += tombstones.length;
        }
        if (needDocs.length) applied += await downloadAndApply(needDocs, ctx);
        assertArticleScope(ctx);
        const next = Number(body?.cursor);
        if (Number.isFinite(next) && next >= cursor) cursor = next;
        await store.setCursor(cursor, ctx);
        if (!body?.hasMore) break;
    }
    return { reset: false, pulled, applied, removed };
}

// ─────────────────────────────────────────────────────────────────────────────
// 上傳
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 回執一定要帶上「它所屬操作」的 mutation ID 與代際。
 * 重建（404 → create）會換代際；只有同一代際的回執才能改動文件的版本基準，
 * 遲到的舊代際回執（例如重建前送出的 PUT）不得把新代際的 revision 推回去。
 */
function receiptOf(op, extra = {}) {
    return { ...extra, clientMutationId: op.clientMutationId, generation: op.generation };
}

/**
 * 回執必須真的寫進持久化儲存（IndexedDB 或 localStorage 後備）才算完成。
 * 確認失敗時 outbox 仍留著，下一輪會用同一個 mutation ID 重試（伺服器端冪等），
 * 因此不得計為成功、也不得誤判成衝突。
 */
async function confirmReceipt(articleId, receipt, ctx) {
    const done = await store.markOpDone(articleId, receipt, ctx);
    if (!done || done.ok !== true) {
        return { ok: false, error: (done && done.error) || 'receipt_persist_failed' };
    }
    return { ok: true, stale: done.stale === true };
}

/**
 * 備份還原覆蓋遠端墓碑：先 POST /restore 取得目前 revision（並清掉 deletedAt），
 * 再用同一個正文 mutation 把新內容 PUT 回去。
 *
 * 只有備份還原（`restore_update` 操作）會走這條路；使用者手動編輯一篇被別台
 * 裝置刪除的文章仍是 update → deleted_remote 衝突，由使用者決定要保留哪一份。
 *
 * 失敗處理：404 沿用 update 的「改成建立」；墓碑／版本在 restore 與 PUT 之間
 * 被別台裝置推進時保留 outbox、下一輪重試（不是使用者要處理的資料衝突）。
 */
async function pushRestoreUpdate(op, payloadDoc, ctx) {
    const articleId = op.articleId;
    const mutationId = op.clientMutationId;
    // restore 與 PUT 是兩個伺服器操作，需要各自的冪等身分；都由同一筆 outbox
    // 操作決定，重試時不變。
    const restoreMutationId = `${mutationId}:restore`;
    const record = store.getRecord(articleId);
    let expected = Number(record && record.revision) || Number(op.expectedRevision) || 0;
    let current = null;
    // 墓碑 revision 可能已被其他裝置推進：只採伺服器回報的目前版本再試一次，
    // 不在同一輪無限重試。
    for (let attempt = 0; attempt < 2 && !current; attempt += 1) {
        const res = await request(`/articles/${encodeURIComponent(articleId)}/restore`, {
            method: 'POST',
            body: JSON.stringify({ expectedRevision: expected, clientMutationId: restoreMutationId })
        }, 30000);
        const body = await readJson(res);
        assertArticleScope(ctx);
        if (res.status === 401) throw authError(401, body);
        if (res.ok) {
            current = body && body.article ? body.article : null;
            break;
        }
        if (res.status === 404) {
            // 遠端已永久移除：與 update 的 404 一致，改成建立（下一輪完成）。
            const requeued = await store.requeueAsCreate(articleId, ctx, { fromMutationId: mutationId });
            assertArticleScope(ctx);
            return {
                ok: false,
                error: 'article_not_found',
                requeued: requeued.ok === true,
                deferred: requeued.deferred === true
            };
        }
        const code = body && body.code;
        const remote = body && body.current ? body.current : null;
        if (res.status === 409 && code === 'article_not_deleted' && remote) {
            // 另一個裝置已經 restore，或先前 restore 已成功但回應遺失：
            // 直接以目前版本 PUT 新正文。
            current = remote;
            break;
        }
        if (res.status === 409 && code === 'article_revision_conflict'
            && remote && remote.deletedAt && attempt === 0) {
            // 墓碑 revision 已前進（例如另一個裝置 restore 後又刪除）：用目前
            // 伺服器版本再試一次 restore。
            expected = Number(remote.revision) || 0;
            continue;
        }
        // 其他失敗（配額、權限、暫時性錯誤）保留 outbox 下一輪重試；
        // 明確的還原意圖不記成需要使用者處理的衝突。
        await store.markOpFailed(articleId, code || `http_${res.status}`, { ctx });
        return { ok: false, error: code || res.status, status: res.status };
    }
    if (!current) {
        await store.markOpFailed(articleId, 'article_restore_failed', { ctx });
        return { ok: false, error: 'article_restore_failed' };
    }
    // restore 已把遠端推進到 `current.revision`：先把它落地成文件與 outbox 的
    // 版本基準（不清 outbox、不標完成）。否則接下來 PUT 失敗後重試、或使用者
    // 直接刪除，都會拿著 restore 前的 revision 送出，被遠端以 409 拒絕而記成
    // 使用者要處理的假衝突。
    const advanced = await store.advanceOperationBase(articleId, Number(current.revision) || 0, {
        ctx,
        clientMutationId: mutationId,
        generation: Number(op.generation) || 0
    });
    assertArticleScope(ctx);
    if (!advanced || advanced.ok !== true) {
        // 基準沒能落地就不能繼續用這個 revision 推進：保留 outbox 下一輪重試。
        await store.markOpFailed(articleId, (advanced && advanced.error) || 'revision_persist_failed', { ctx });
        return { ok: false, error: (advanced && advanced.error) || 'revision_persist_failed' };
    }
    if (advanced.applied !== true) {
        // 等待期間這筆操作已被新的本機修改取代，或已被另一個分頁完成／移除：
        // 不能用舊正文繼續 PUT，也**不可** markOpFailed —— 那會用本分頁記憶體
        // 把文件寫成 dirty/pending（outbox 已無對應操作，形成永不重試的孤兒），
        // 並且把持久化中較新的 revision 回寫成記憶體裡的舊版本。
        // 同代際的新操作（例如使用者在回應回來前刪除）則會由 store 把已確認
        // 的 revision 交接給它（`rebased:true`）。兩種情況都視為已被取代：
        // 原狀不再變動，只回報 superseded，下一輪由新操作自然接手。
        return {
            ok: false,
            error: advanced.rebased === true ? 'revision_base_rebased' : 'revision_base_superseded',
            superseded: true,
            rebased: advanced.rebased === true
        };
    }
    // restore 成功但回應遺失後重試、或另一個裝置已還原同一份內容：不必再
    // PUT（避免無意義的 revision 推進）。
    if (articleContentKey(current) === articleContentKey(payloadDoc)) {
        const confirmed = await confirmReceipt(articleId, receiptOf(op, {
            revision: current.revision,
            serverUpdatedAt: current.updatedAt
        }), ctx);
        if (!confirmed.ok) return confirmed;
        return { ok: true, idempotent: true };
    }
    const res = await request(`/articles/${encodeURIComponent(articleId)}`, {
        method: 'PUT',
        body: JSON.stringify({ ...payloadDoc, expectedRevision: current.revision, clientMutationId: mutationId })
    }, 30000);
    const body = await readJson(res);
    assertArticleScope(ctx);
    if (res.status === 401) throw authError(401, body);
    if (res.ok && body?.article) {
        const confirmed = await confirmReceipt(articleId, receiptOf(op, {
            revision: body.article.revision,
            serverUpdatedAt: body.article.updatedAt
        }), ctx);
        if (!confirmed.ok) return confirmed;
        return { ok: true };
    }
    if (res.status === 404) {
        const requeued = await store.requeueAsCreate(articleId, ctx, { fromMutationId: mutationId });
        assertArticleScope(ctx);
        return {
            ok: false,
            error: 'article_not_found',
            requeued: requeued.ok === true,
            deferred: requeued.deferred === true
        };
    }
    if (res.status === 409) {
        // restore 與 PUT 之間又被刪除／改版：保留 outbox，下一輪重新 restore
        // 並以最新版本重送；這不是使用者要處理的資料衝突。
        await store.markOpFailed(articleId, body?.code || 'article_revision_conflict', { ctx });
        return { ok: false, error: body?.code || 'article_revision_conflict', status: 409 };
    }
    await store.markOpFailed(articleId, body?.code || `http_${res.status}`, { ctx });
    return { ok: false, error: body?.code || res.status, status: res.status };
}

async function pushOne(op, ctx) {
    assertArticleScope(ctx);
    let record = store.getRecord(op.articleId);
    if (record?.summaryOnly) {
        // 必須分辨「讀取失敗」與「真的沒有這篇」：讀取失敗不能 confirm／清 op，
        // 否則本輪會回報完成，實際卻從未送出。
        const loaded = await store.ensureArticleLoadedDetailed(op.articleId, ctx);
        assertArticleScope(ctx);
        if (!loaded || loaded.ok !== true) {
            return {
                ok: false,
                error: (loaded && loaded.error) || 'article_load_failed'
            };
        }
        record = loaded.doc;
    }
    assertArticleScope(ctx);
    if (!record) {
        const confirmed = await confirmReceipt(op.articleId, receiptOf(op, { revision: op.expectedRevision }), ctx);
        if (!confirmed.ok) return confirmed;
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
    if (op.type === 'restore_update') {
        return pushRestoreUpdate(op, payloadDoc, ctx);
    }
    if (op.type === 'create') {
        const res = await request('/articles', {
            method: 'POST',
            body: JSON.stringify({ ...payloadDoc, id: op.articleId, clientMutationId: mutationId })
        }, 30000);
        const body = await readJson(res);
        assertArticleScope(ctx);
        if (res.status === 401) throw authError(401, body);
        if (res.ok && body?.article) {
            const confirmed = await confirmReceipt(op.articleId, receiptOf(op, {
                revision: body.article.revision,
                serverUpdatedAt: body.article.updatedAt
            }), ctx);
            if (!confirmed.ok) return confirmed;
            return { ok: true };
        }
        if (res.status === 409 && body?.code === 'article_id_exists') {
            // 另一個裝置／先前的重試已經建立成功：拉回伺服器版本再比對
            const docs = await fetchDocs([op.articleId]);
            assertArticleScope(ctx);
            const doc = docs[0];
            if (doc) {
                if (doc.body === payloadDoc.body && doc.title === payloadDoc.title) {
                    await store.applyRemoteDoc({ ...doc, deletedAt: '' }, ctx);
                    const confirmed = await confirmReceipt(op.articleId, receiptOf(op, {
                        revision: doc.revision,
                        serverUpdatedAt: doc.updatedAt
                    }), ctx);
                    if (!confirmed.ok) return confirmed;
                    return { ok: true, idempotent: true };
                }
                await store.markOpFailed(op.articleId, body?.code, {
                    conflict: { kind: 'id_exists', remoteRevision: doc.revision, remoteTitle: doc.title },
                    ctx
                });
                return { ok: false, conflict: true };
            }
        }
        await store.markOpFailed(op.articleId, body?.code || `http_${res.status}`, { ctx });
        return { ok: false, error: body?.code || res.status, status: res.status };
    }

    if (op.type === 'update') {
        const res = await request(`/articles/${encodeURIComponent(op.articleId)}`, {
            method: 'PUT',
            body: JSON.stringify({ ...payloadDoc, expectedRevision: record.revision, clientMutationId: mutationId })
        }, 30000);
        const body = await readJson(res);
        assertArticleScope(ctx);
        if (res.status === 401) throw authError(401, body);
        if (res.ok && body?.article) {
            const confirmed = await confirmReceipt(op.articleId, receiptOf(op, {
                revision: body.article.revision,
                serverUpdatedAt: body.article.updatedAt
            }), ctx);
            if (!confirmed.ok) return confirmed;
            return { ok: true };
        }
        if (res.status === 409 && body?.code === 'article_revision_conflict') {
            await store.markOpFailed(op.articleId, body.code, {
                conflict: {
                    kind: 'revision',
                    remoteRevision: Number(body?.current?.revision) || 0,
                    remoteTitle: body?.current?.title || ''
                },
                ctx
            });
            return { ok: false, conflict: true };
        }
        if (res.status === 409 && body?.code === 'article_already_deleted') {
            await store.markOpFailed(op.articleId, body.code, {
                conflict: { kind: 'deleted_remote', remoteRevision: Number(body?.current?.revision) || 0 },
                ctx
            });
            return { ok: false, conflict: true };
        }
        if (res.status === 404) {
            // 伺服器沒有這篇（例如在別處被刪除後清空）：改以建立重送，避免永久卡住。
            // 重建必須把版本基準重設為 0（而且只在交易內仍是同一個操作時才做），
            // 否則建立成功後遠端是 revision 1、本機仍停在舊版本，下一次更新必 409。
            const requeued = await store.requeueAsCreate(op.articleId, ctx, { fromMutationId: mutationId });
            assertArticleScope(ctx);
            return {
                ok: false,
                error: 'article_not_found',
                requeued: requeued.ok === true,
                deferred: requeued.deferred === true
            };
        }
        await store.markOpFailed(op.articleId, body?.code || `http_${res.status}`, { ctx });
        return { ok: false, error: body?.code || res.status, status: res.status };
    }

    if (op.type === 'delete' || op.type === 'restore') {
        const path = op.type === 'delete'
            ? `/articles/${encodeURIComponent(op.articleId)}`
            : `/articles/${encodeURIComponent(op.articleId)}/restore`;
        const res = await request(path, {
            method: op.type === 'delete' ? 'DELETE' : 'POST',
            body: JSON.stringify({ expectedRevision: record.revision, clientMutationId: mutationId })
        }, 30000);
        const body = await readJson(res);
        assertArticleScope(ctx);
        if (res.status === 401) throw authError(401, body);
        if (res.ok) {
            const confirmed = await confirmReceipt(op.articleId, receiptOf(op, {
                revision: body?.article?.revision,
                serverUpdatedAt: body?.article?.updatedAt
            }), ctx);
            if (!confirmed.ok) return confirmed;
            return { ok: true };
        }
        if (res.status === 404 && op.type === 'delete') {
            const confirmed = await confirmReceipt(op.articleId, receiptOf(op, { revision: record.revision }), ctx);
            if (!confirmed.ok) return confirmed;
            return { ok: true, idempotent: true };
        }
        if (res.status === 409) {
            await store.markOpFailed(op.articleId, body?.code || 'article_revision_conflict', {
                conflict: {
                    kind: 'revision',
                    remoteRevision: Number(body?.current?.revision) || 0,
                    remoteTitle: body?.current?.title || ''
                },
                ctx
            });
            return { ok: false, conflict: true };
        }
        await store.markOpFailed(op.articleId, body?.code || `http_${res.status}`, { ctx });
        return { ok: false, error: body?.code || res.status, status: res.status };
    }

    const confirmed = await confirmReceipt(op.articleId, receiptOf(op), ctx);
    if (!confirmed.ok) return confirmed;
    return { ok: true, skipped: true };
}

async function pushOutbox(ctx) {
    assertArticleScope(ctx);
    const ops = (await store.listPending(ctx)).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    assertArticleScope(ctx);
    let pushed = 0;
    let conflicts = 0;
    let failed = 0;
    const errors = [];
    for (const op of ops.slice(0, MAX_PUSH_PER_ROUND)) {
        assertArticleScope(ctx);
        const conflict = store.getConflicts().find((item) => item.articleId === op.articleId);
        if (conflict) { conflicts += 1; continue; } // 等使用者決定，不自動覆蓋遠端
        const result = await pushOne(op, ctx);
        if (result.ok) pushed += 1;
        else if (result.conflict) conflicts += 1;
        else if (result.superseded) {
            // 這筆操作已被新的本機修改取代／別的分頁完成：不是使用者衝突，
            // 也不該重試同一筆（outbox 已不是它了），不計失敗、不動任何資料。
        } else {
            failed += 1;
            errors.push({
                articleId: op.articleId,
                mutationId: op.clientMutationId,
                error: result.error || `http_${result.status}`
            });
            // 容量或授權錯誤：停止本輪，避免重複撞同一面牆
            if (result.status === 413 || result.status === 409 || result.status === 429) break;
        }
    }
    return { pushed, conflicts, failed, errors };
}

// ─────────────────────────────────────────────────────────────────────────────
// 舊資料上傳（保留原 ID、開啟閘門）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 穩定排序的 JSON：分析物件鍵序不同不算內容不同。
 * 與 JSON.stringify 一致地忽略 undefined／function，避免本機物件有未定義欄位、
 * 伺服器回來的 JSON 沒有該欄位時被誤判成內容不同而產生假衝突。
 */
function sortedJson(value) {
    if (value === undefined || typeof value === 'function') return 'null';
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) {
        // 與 JSON.stringify 的陣列語意一致：空洞、undefined、function 都輸出
        // null。Array#map 會跳過空洞，直接 join 會讓 Array(1) 變成 `[]`，
        // 與實際送出／回來的 `[null]` 不同，核對時就會誤判內容不一致。
        const items = [];
        for (let index = 0; index < value.length; index += 1) {
            items.push(sortedJson(value[index]));
        }
        return `[${items.join(',')}]`;
    }
    const keys = Object.keys(value)
        .filter((key) => value[key] !== undefined && typeof value[key] !== 'function')
        .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${sortedJson(value[key])}`).join(',')}}`;
}

/**
 * 同步內容指紋：核對必須涵蓋 analysis／sourceType／sourceUrl，不能只比
 * title／body；只比正文會讓「伺服器已收到舊內容、本機只改了分析」被誤判完成。
 */
export function articleContentKey(article) {
    return sortedJson({
        title: normalizeTitle(article?.title),
        body: String(article?.body == null ? '' : article.body),
        analysis: normalizeAnalysis(article?.analysis != null ? article.analysis : article?.result),
        sourceType: normalizeSourceType(article?.sourceType),
        sourceUrl: normalizeSourceUrl(article?.sourceUrl)
    });
}

function docContentKey(doc) {
    return articleContentKey({
        title: doc?.title,
        body: doc?.body,
        analysis: doc?.analysis,
        sourceType: doc?.sourceType,
        sourceUrl: doc?.sourceUrl
    });
}

/** 舊資料操作：需要走 /articles/import 或以送出快照核對的項目。 */
function isLegacyPendingOp(op) {
    if (!op || op.legacy !== true) return false;
    if (op.type === 'create' || op.type === 'update') return true;
    return !!op.importSnapshot;
}

/**
 * 這筆操作是否帶著「尚未核對」的 import 快照。
 *
 * 只要快照的 mutation ID 與目前操作不同就必須先核對：快照代表上一次真的送出
 * 的內容與身分，目前操作已經換了身分（例如回應遺失後又保存同一份內容、或
 * 內容 A→B→A）。此時若只比內容就跳過核對，`recordImportSubmission()` 會因為
 * 已有另一份未核對快照而持續拒絕寫入，每一輪都 deferred、outbox 與 gate 都清
 * 不掉，還會擋住其他操作推送。
 *
 * mutation ID 相同、內容也相同時重送只會被伺服器 skip，核對仍會成功，不必先
 * 多打一次 batch；delete 一律要核對，才能把刪除的基準 revision 推進到伺服器版本。
 */
function snapshotNeedsVerification(op) {
    const snapshot = op && op.importSnapshot;
    // 沒有 mutation ID 的快照無法確認（也不會是本次版本寫入的），忽略它。
    if (!snapshot || !snapshot.clientMutationId) return false;
    if (op.type === 'delete') return true;
    if (snapshot.clientMutationId !== op.clientMutationId) return true;
    if (!op.payload) return true;
    return articleContentKey(snapshot) !== articleContentKey(op.payload);
}

/**
 * 核對一次 import 實際送出的紀錄。
 * records: [{ articleId, clientMutationId, title, body, analysis, sourceType, sourceUrl }]
 *
 * 回傳 `{ ok:true }` 才代表這批已確認且完成進度已持久化；缺少遠端文件、
 * 寫入失敗或 outbox 尚未對應都必須回報失敗，呼叫端不得送出 final 或改走
 * 逐篇上傳。舊回執只清除同一個 mutation ID 的操作；等待期間的新修改／刪除
 * 會由 markOpsDone 保留並推進基準 revision。
 */
async function verifyLegacyRecords(records, ctx) {
    if (!records.length) return { ok: true };
    for (let index = 0; index < records.length; index += ARTICLE_LIMITS.batchMax) {
        assertArticleScope(ctx);
        const chunk = records.slice(index, index + ARTICLE_LIMITS.batchMax);
        const missingMutation = chunk.find((record) => !record.clientMutationId);
        if (missingMutation) {
            return { ok: false, error: 'legacy_verify_mutation_missing', articleId: missingMutation.articleId };
        }
        const docs = await fetchDocs(chunk.map((record) => record.articleId));
        assertArticleScope(ctx);
        const byId = new Map(docs.map((doc) => [doc.id, doc]));
        const done = [];
        const missing = [];
        for (const record of chunk) {
            const doc = byId.get(record.articleId);
            if (!doc) {
                // 伺服器沒有這篇就不能算已確認；保留 outbox 讓下一輪重試。
                missing.push(record.articleId);
                continue;
            }
            if (docContentKey(doc) === articleContentKey(record)) {
                done.push({
                    articleId: record.articleId,
                    revision: doc.revision,
                    serverUpdatedAt: doc.updatedAt,
                    clientMutationId: record.clientMutationId,
                    // 代際跟著回執走：重建過的文章不得被舊代際的核對推進版本。
                    generation: record.generation
                });
                continue;
            }
            const failed = await store.markOpFailed(record.articleId, 'legacy_content_differs', {
                conflict: { kind: 'legacy_differs', remoteRevision: doc.revision, remoteTitle: doc.title },
                ctx
            });
            if (!failed || failed.ok !== true) {
                return { ok: false, error: (failed && failed.error) || 'legacy_verify_persist_failed' };
            }
        }
        if (done.length) {
            const persisted = await store.markOpsDone(done, ctx);
            if (!persisted || persisted.ok !== true) {
                return { ok: false, error: (persisted && persisted.error) || 'legacy_verify_persist_failed' };
            }
        }
        if (missing.length) {
            return { ok: false, error: 'legacy_verify_missing', missing };
        }
    }
    return { ok: true };
}

/**
 * 先確認「上一次真的送出過、但回應遺失」的 import 快照。
 *
 * 伺服器上的內容如果正好是那份快照，就確認快照的 mutation ID，並由
 * markOpsDone 把目前的新修改 rebase 到伺服器 revision；伺服器沒有這篇就
 * 回報 missing，由呼叫端清除快照後重送目前內容；內容既不是快照也不是目前
 * 操作，才算真衝突。
 */
async function verifySubmittedSnapshots(ops, ctx) {
    const targets = ops.filter(snapshotNeedsVerification);
    const resolved = new Set();
    const conflicted = new Set();
    // articleId → 查詢當時的快照身分。呼叫端只能用這份身分清除快照；
    // 重新讀取 outbox 拿到的可能是另一個分頁後來寫入的新快照（S2），
    // 用它去比對等於直接刪掉還沒核對的新證據。
    const missing = new Map();
    if (!targets.length) return { ok: true, resolved, conflicted, missing };
    for (let index = 0; index < targets.length; index += ARTICLE_LIMITS.batchMax) {
        assertArticleScope(ctx);
        const chunk = targets.slice(index, index + ARTICLE_LIMITS.batchMax);
        const docs = await fetchDocs(chunk.map((op) => op.articleId));
        assertArticleScope(ctx);
        const byId = new Map(docs.map((doc) => [doc.id, doc]));
        const done = [];
        for (const op of chunk) {
            const snapshot = op.importSnapshot;
            const doc = byId.get(op.articleId);
            // 伺服器還沒有這篇：快照當初沒有提交成功。呼叫端要先清掉這份
            // 快照，下一階段才能用目前內容重新匯入，而不是被舊證據卡住。
            if (!doc) {
                missing.set(op.articleId, {
                    clientMutationId: snapshot.clientMutationId,
                    submittedAt: snapshot.submittedAt || ''
                });
                continue;
            }
            if (docContentKey(doc) === articleContentKey(snapshot)) {
                done.push({
                    articleId: op.articleId,
                    revision: doc.revision,
                    serverUpdatedAt: doc.updatedAt,
                    clientMutationId: snapshot.clientMutationId,
                    generation: op.generation
                });
                continue;
            }
            const failed = await store.markOpFailed(op.articleId, 'legacy_content_differs', {
                conflict: { kind: 'legacy_differs', remoteRevision: doc.revision, remoteTitle: doc.title },
                ctx
            });
            if (!failed || failed.ok !== true) {
                return {
                    ok: false,
                    error: (failed && failed.error) || 'legacy_verify_persist_failed',
                    resolved,
                    conflicted,
                    missing
                };
            }
            conflicted.add(op.articleId);
        }
        if (done.length) {
            const persisted = await store.markOpsDone(done, ctx);
            if (!persisted || persisted.ok !== true) {
                return {
                    ok: false,
                    error: (persisted && persisted.error) || 'legacy_verify_persist_failed',
                    resolved,
                    conflicted,
                    missing
                };
            }
            for (const entry of done) resolved.add(entry.articleId);
        }
    }
    return { ok: true, resolved, conflicted, missing };
}

/**
 * 逐批匯入舊文章：每個 import 批次成功後，立刻按 batchMax 核對並持久化
 * 完成進度，再處理下一批。匯入與核對都受整輪期限約束；逾時時已完成的
 * outbox 已清除，下一輪只會從未完成的部分繼續，不會從第一批重傳。
 */
export async function runLegacyImportBatches({
    records,
    importChunk,
    verifyChunk,
    finalize,
    importMax = ARTICLE_LIMITS.importMax,
    batchMax = ARTICLE_LIMITS.batchMax
} = {}) {
    const list = Array.isArray(records) ? records : [];
    if (typeof importChunk !== 'function' || typeof verifyChunk !== 'function') {
        return { imported: 0, skipped: 0, error: 'invalid_import_runner' };
    }
    let imported = 0;
    let skipped = 0;
    let deferred = false;
    for (let index = 0; index < list.length; index += importMax) {
        const chunk = list.slice(index, index + importMax);
        const result = await importChunk(chunk);
        if (!result || result.ok !== true) {
            return {
                imported,
                skipped,
                error: (result && result.error) || 'import_failed',
                status: result && result.status
            };
        }
        imported += Number(result.body?.imported) || 0;
        skipped += Number(result.body?.skipped) || 0;
        if (result.deferred === true) deferred = true;
        // 只核對這次真的送出且已寫入快照的紀錄；被安全延後的項目留待下一輪。
        const verifiedRecords = Array.isArray(result.records) ? result.records : chunk;
        for (let verifyIndex = 0; verifyIndex < verifiedRecords.length; verifyIndex += batchMax) {
            const verified = await verifyChunk(verifiedRecords.slice(verifyIndex, verifyIndex + batchMax));
            if (!verified || verified.ok !== true) {
                // 核對／持久化失敗就停止本輪：不得送 final、不得清 gate，
                // 也不得改走逐篇補送。已完成批次的 outbox 已清除。
                return {
                    imported,
                    skipped,
                    error: (verified && verified.error) || 'legacy_verify_failed',
                    status: verified && verified.status
                };
            }
        }
        if (deferred) {
            // 有項目因核對期間的新操作而安全延後：不能送 final、不能清 gate，
            // 也不能拿目前內容覆蓋尚未核對的快照。
            return { imported, skipped, deferred: true };
        }
    }
    if (typeof finalize === 'function' && !deferred) {
        const final = await finalize();
        if (!final || final.ok !== true) {
            return {
                imported,
                skipped,
                error: (final && final.error) || 'final_failed',
                status: final && final.status
            };
        }
    }
    return { imported, skipped };
}

async function pushLegacyMigration(ctx) {
    assertArticleScope(ctx);
    const gatePending = store.getGatePending();
    let ops = (await store.listPending(ctx)).filter(isLegacyPendingOp);
    assertArticleScope(ctx);
    if (!ops.length && !gatePending) return { imported: 0, skipped: 0 };

    await store.loadAllRecords(ctx);
    assertArticleScope(ctx);

    // 1) 先確認上一次真的送出、但回應遺失的 import 快照。
    //    伺服器上的內容正好是那份快照時，只確認快照的 mutation ID；
    //    等待期間的新修改／刪除由 markOpsDone 保留並 rebase 到伺服器 revision。
    //
    //    核對期間使用者仍可修改其他文章：每次核對後重新讀取 outbox，把新出現的
    //    未確認快照再核對一次。絕不能直接拿目前內容覆蓋舊快照：伺服器會 skip
    //    已存在的文章，核對時就會把真正的新修改誤判成 legacy_differs。
    const resolved = new Set();
    const conflicted = new Set();
    const missing = new Map();
    const MAX_PREFLIGHT_PASSES = 3;
    for (let pass = 0; pass < MAX_PREFLIGHT_PASSES; pass += 1) {
        const targets = ops.filter((op) => !resolved.has(op.articleId)
            && !conflicted.has(op.articleId)
            && !missing.has(op.articleId)
            && snapshotNeedsVerification(op));
        if (!targets.length) break;
        const preflight = await verifySubmittedSnapshots(targets, ctx);
        assertArticleScope(ctx);
        if (!preflight.ok) {
            await store.markSyncError(preflight.error, ctx);
            return { imported: 0, skipped: 0, error: preflight.error };
        }
        for (const articleId of preflight.resolved) resolved.add(articleId);
        for (const articleId of preflight.conflicted) conflicted.add(articleId);
        for (const [articleId, identity] of preflight.missing) missing.set(articleId, identity);
        ops = (await store.listPending(ctx)).filter(isLegacyPendingOp);
        assertArticleScope(ctx);
    }

    // 伺服器確認沒有這篇 → 舊快照不可能已提交，可以安全清掉再匯入目前內容。
    // 先清掉才不會讓「舊快照內容不同」被當成另一筆未確認提交而永久延後。
    //
    // 只使用「查詢當時」的快照身分：等待回應期間另一個分頁可能已清掉 S1、
    // 提交 S2；若拿重新讀到的 outbox 快照來比對，就會把 S2 當成 S1 刪掉，
    // 接著重匯 S3 產生假 legacy_differs。身分不符時儲存層回報 deferred，
    // 這一輪延後、下一輪重新核對真正存在的新快照。
    const verifiedMissing = [];
    for (const [articleId, identity] of missing) {
        verifiedMissing.push({
            articleId,
            clientMutationId: identity.clientMutationId,
            submittedAt: identity.submittedAt
        });
    }
    if (verifiedMissing.length) {
        const cleared = await store.clearImportSnapshots(verifiedMissing, ctx);
        assertArticleScope(ctx);
        if (!cleared || cleared.ok !== true) {
            const error = (cleared && cleared.error) || 'import_snapshot_clear_failed';
            await store.markSyncError(error, ctx);
            return { imported: 0, skipped: 0, error };
        }
        if ((cleared.deferred || []).length) {
            // 清除前又有新的快照寫入：這一輪先不動它，下一輪重新核對。
            return { imported: 0, skipped: 0, deferred: true };
        }
        ops = (await store.listPending(ctx)).filter(isLegacyPendingOp);
        assertArticleScope(ctx);
    }

    // 2) 建立匯入清單：只剩「已確認」的修改／刪除，以及快照已可安全替換的項目。
    const opById = new Map(ops.map((op) => [op.articleId, op]));
    const toImport = [];
    const deferred = [];
    for (const op of ops) {
        if (resolved.has(op.articleId) || conflicted.has(op.articleId)) continue;
        // 先檢查「是否還有未核對的快照」，再按操作類型分流。
        // delete 的快照同樣要核對：刪除基準 revision 還停在 0 時送出 DELETE，
        // 伺服器會回 expected_revision_required（400），遠端文章仍留著。
        if (snapshotNeedsVerification(op)) {
            // 核對期間又持續被修改：安全延後，不能用新內容覆蓋未確認的快照。
            deferred.push(op.articleId);
            continue;
        }
        if (op.type !== 'create' && op.type !== 'update') continue;
        // 已確認過伺服器版本的修改（expectedRevision > 0）走逐篇 update；
        // 再匯入一次只會被 skip，不能拿來當成完成確認。
        if (!op.importSnapshot && Number(op.expectedRevision) > 0) continue;
        const record = store.getRecord(op.articleId);
        if (!record || record.deletedAt) continue;
        toImport.push(record);
    }

    // import 與後續核對必須使用同一份送出內容與 mutation ID；不能在核對時
    // 重新比較「現在的本機內容」，否則等待期間的修改會被舊回執誤判完成。
    const importArticleOf = (record) => ({
        legacyId: record.articleId,
        title: record.title || '',
        body: record.article || '',
        analysis: record.result === undefined ? null : record.result,
        sourceType: record.sourceType === undefined ? 'paste' : record.sourceType,
        sourceUrl: record.sourceUrl || ''
    });

    const result = await runLegacyImportBatches({
        records: toImport,
        importChunk: async (chunk) => {
            const articles = chunk.map(importArticleOf);
            // 先持久化實際送出的內容與操作身分；回應遺失（甚至重新載入）後
            // 才有辦法確認「伺服器上的內容是不是我們送出的那一次」。
            const recorded = await store.recordImportSubmission(chunk.map((record, index) => ({
                articleId: record.articleId,
                snapshot: {
                    clientMutationId: opById.get(record.articleId)?.clientMutationId || '',
                    title: articles[index].title,
                    body: articles[index].body,
                    analysis: articles[index].analysis,
                    sourceType: articles[index].sourceType,
                    sourceUrl: articles[index].sourceUrl,
                    submittedAt: new Date().toISOString()
                }
            })), ctx);
            assertArticleScope(ctx);
            if (!recorded || recorded.ok !== true) {
                return { ok: false, error: (recorded && recorded.error) || 'import_snapshot_persist_failed' };
            }
            // 等待期間出現新操作、舊快照尚未核對時，recordImportSubmission
            // 會拒絕覆蓋並回報 deferred；這一輪不能送出這些項目。
            const deferredIds = new Set(recorded.deferred || []);
            const sent = chunk.filter((record) => !deferredIds.has(record.articleId));
            if (!sent.length) {
                return { ok: true, body: { imported: 0, skipped: 0, ids: [] }, records: [], deferred: true };
            }
            const sentArticles = sent.map(importArticleOf);
            const res = await request('/articles/import', {
                method: 'POST',
                body: JSON.stringify({ articles: sentArticles })
            }, 60000);
            const body = await readJson(res);
            assertArticleScope(ctx);
            if (res.status === 401) throw authError(401, body);
            if (!res.ok) {
                // 容量不足或格式問題：不清掉 outbox，保留資料等使用者處理
                return { ok: false, error: body?.code || `http_${res.status}`, status: res.status };
            }
            return { ok: true, body, records: sent, deferred: deferredIds.size > 0 };
        },
        // 核對的對象是「實際送出的快照」，不是核對當下的本機內容；等待期間的
        // 新修改才能由 markOpsDone 保留並 rebase，而不是產生假衝突。
        verifyChunk: async (chunk) => {
            const ids = new Set(chunk.map((record) => record.articleId));
            const pending = (await store.listPending(ctx)).filter((op) => ids.has(op.articleId));
            assertArticleScope(ctx);
            const byId = new Map(pending.map((op) => [op.articleId, op]));
            const records = [];
            for (const record of chunk) {
                const op = byId.get(record.articleId);
                const snapshot = op && op.importSnapshot;
                if (!snapshot || !snapshot.clientMutationId) {
                    return { ok: false, error: 'legacy_snapshot_missing', articleId: record.articleId };
                }
                records.push({
                    articleId: record.articleId,
                    clientMutationId: snapshot.clientMutationId,
                    generation: op.generation,
                    title: snapshot.title,
                    body: snapshot.body,
                    analysis: snapshot.analysis,
                    sourceType: snapshot.sourceType,
                    sourceUrl: snapshot.sourceUrl
                });
            }
            return verifyLegacyRecords(records, ctx);
        },
        // 沒有要匯入、閘門也已關閉時不必再送 final（例如只剩已 rebase 的 update）；
        // 有延後項目時也不能送 final／清 gate，否則下一輪會改走逐篇上傳。
        finalize: (!deferred.length && (gatePending || toImport.length)) ? async () => {
            // 匯入完成後開啟閘門（空批次 + final 也支援）；失敗就留待下次重試。
            assertArticleScope(ctx);
            const finalRes = await request('/articles/import', {
                method: 'POST',
                body: JSON.stringify({ articles: [], final: true })
            }, 30000);
            const finalBody = await readJson(finalRes);
            assertArticleScope(ctx);
            if (finalRes.status === 401) throw authError(401, finalBody);
            if (!finalRes.ok) {
                return { ok: false, error: finalBody?.code || `http_${finalRes.status}`, status: finalRes.status };
            }
            return { ok: true, body: finalBody };
        } : undefined
    });

    if (result.error) {
        await store.markSyncError(result.error, ctx);
        return { imported: result.imported, skipped: result.skipped, error: result.error };
    }
    if (result.deferred || deferred.length) {
        // 下一輪重新核對後再匯入／推送；本輪不清 gatePending。
        return { imported: result.imported, skipped: result.skipped, deferred: true };
    }
    await store.setGatePending(false, ctx);
    return { imported: result.imported, skipped: result.skipped };
}

// ─────────────────────────────────────────────────────────────────────────────
// 對外
// ─────────────────────────────────────────────────────────────────────────────

export async function syncArticles(options = {}) {
    if (inFlight) {
        if (!queuedSync) {
            queuedSync = inFlight.catch(() => null).then(() => {
                queuedSync = null;
                return syncArticles(options);
            });
        }
        return queuedSync;
    }
    if (!loggedIn()) {
        // 未登入：只做本機遷移，不上傳任何資料（訪客內容不會歸給下一個帳戶）
        const ctx = store.captureArticleContext();
        const local = await store.migrateLegacyLocalData({ ctx }).catch(() => ({ ok: false }));
        return { skipped: true, reason: 'signed_out', migration: local };
    }
    let syncCtx = null;
    inFlight = (async () => {
        const scope = await store.refreshScope();
        syncCtx = store.captureArticleContext();
        const migration = await store.migrateLegacyLocalData({ ctx: syncCtx });
        assertArticleScope(syncCtx);
        if (!migration.ok) {
            await store.markSyncError(migration.error || 'migration_failed', syncCtx);
            return { ok: false, error: migration.error || 'migration_failed', migration, scope };
        }
        const legacy = await pushLegacyMigration(syncCtx);
        assertArticleScope(syncCtx);
        if (legacy.error) {
            // 匯入／核對失敗代表進度尚未持久化完成：立即停止本輪，不拉取、
            // 不清 gatePending，也不讓 pushOutbox 改走逐篇建立重傳。
            return { ok: false, error: legacy.error, scope, migration, legacy };
        }
        if (legacy.deferred) {
            // 核對期間又有新操作被安全延後：這一輪不推送 legacy 操作，
            // 避免逐篇上傳繞過尚未完成的快照核對；下一輪重新核對。
            const deferredSynced = await store.markSynced(undefined, syncCtx);
            // 收尾狀態必須真的寫進儲存才算完成；後備桶讀不到時不能回報成功
            // （也不能把桶當成空的覆寫，store 已在那邊拒絕寫入）。
            if (!deferredSynced || deferredSynced.ok !== true) {
                return {
                    ok: false,
                    error: (deferredSynced && deferredSynced.error) || 'state_persist_failed',
                    scope,
                    migration,
                    legacy,
                    deferred: true,
                    pushed: { pushed: 0, conflicts: 0, failed: 0, deferred: true },
                    at: new Date().toISOString()
                };
            }
            return {
                ok: true,
                scope,
                migration,
                legacy,
                deferred: true,
                pushed: { pushed: 0, conflicts: 0, failed: 0, deferred: true },
                at: new Date().toISOString()
            };
        }
        const pulled = await pullDelta(syncCtx);
        assertArticleScope(syncCtx);
        const pushed = await pushOutbox(syncCtx);
        assertArticleScope(syncCtx);
        // 同步收尾（markSynced）會讀改寫後備桶的 state；讀不到／損壞時
        // store 會明確失敗且不寫入。此時這一輪並沒有真正收尾（lastSyncAt、
        // lastError 都沒落地），不得回報成功。
        const synced = await store.markSynced(undefined, syncCtx);
        assertArticleScope(syncCtx);
        if (!synced || synced.ok !== true) {
            return {
                ok: false,
                error: (synced && synced.error) || 'state_persist_failed',
                scope,
                migration,
                legacy,
                pulled,
                pushed,
                at: new Date().toISOString()
            };
        }
        return { ok: true, scope, migration, legacy, pulled, pushed, at: new Date().toISOString() };
    })();
    try {
        return await inFlight;
    } catch (error) {
        // 只有仍在同一 scope／世代才記錄錯誤；切帳戶後不得把 A 的錯誤寫進 B。
        if (syncCtx && store.isArticleContextActive(syncCtx)) {
            await store.markSyncError(error && error.code ? error.code : 'sync_failed', syncCtx).catch(() => {});
        }
        throw error;
    } finally {
        inFlight = null;
    }
}

async function waitForInFlight() {
    if (!inFlight) return;
    try { await inFlight; } catch (_) {}
}

export async function resolveKeepMine(articleId) {
    // 先讓背景同步結束，否則它可能用舊 outbox 的 mutationId 回執，
    // 而使用者在等待期間排入的新操作會留在 outbox 沒有送出。
    await waitForInFlight();
    const ctx = store.captureArticleContext();
    assertArticleScope(ctx);
    const conflict = store.getConflicts().find((item) => item.articleId === articleId);
    if (!conflict) return { ok: false, error: 'no_conflict' };
    if (conflict.remoteRevision) await store.setBaseRevision(articleId, conflict.remoteRevision, { ctx });
    assertArticleScope(ctx);
    await store.clearConflict(articleId, ctx);
    const record = store.getRecord(articleId);
    if (record) await store.enqueueForRetry(articleId, ctx);
    assertArticleScope(ctx);
    return syncArticles();
}

export async function resolveSaveCopy(articleId) {
    await waitForInFlight();
    const ctx = store.captureArticleContext();
    assertArticleScope(ctx);
    const result = await store.duplicateArticle(articleId, ' (copy)', { ctx });
    if (!result.ok) return result;
    assertArticleScope(ctx);
    // 原篇放棄本機修改，改成伺服器版本
    const docs = await fetchDocs([articleId]);
    assertArticleScope(ctx);
    if (docs[0]) await store.applyRemoteDoc(docs[0], ctx);
    await store.discardPending(articleId, ctx);
    await store.clearConflict(articleId, ctx);
    assertArticleScope(ctx);
    await syncArticles();
    return result;
}

export async function resolveUseRemote(articleId) {
    await waitForInFlight();
    const ctx = store.captureArticleContext();
    assertArticleScope(ctx);
    const docs = await fetchDocs([articleId]);
    assertArticleScope(ctx);
    if (!docs[0]) return { ok: false, error: 'article_not_found' };
    await store.applyRemoteDoc(docs[0], ctx);
    await store.discardPending(articleId, ctx);
    await store.clearConflict(articleId, ctx);
    return { ok: true };
}

export function isArticleSyncRunning() {
    return !!inFlight;
}
