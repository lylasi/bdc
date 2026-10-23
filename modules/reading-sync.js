// 逐項閱讀資料同步（Cloudflare Worker / selfhost 共用路由）。
//
// 規則：
//   * 同一帳戶只允許一輪在途；切換帳戶後舊回應不得寫入新 scope。
//   * 先推本機 outbox，再拉增量；拉取時若有 pending，使用 base 做三方合併。
//   * 伺服器回 404／405 表示後端尚未更新：本機功能照常，顯示「需要更新服務端」。
//   * 舊快照不再承載詞書／聊天；本模組是唯一上傳路徑。

import { apiRequest, getAuthSnapshot, pullSnapshot } from './sync-cloudflare.js';
import * as articleStore from './article-store.js';
import * as store from './reading-store.js';
import { READING_LIMITS } from '../shared/reading-protocol.mjs';

const MAX_PUSH_MUTATIONS = 100;
const MAX_PUSH_ROUNDS = 4;
const MAX_PULL_PAGES = 20;

let inFlight = null;

function loggedIn() {
    const snapshot = getAuthSnapshot();
    return !!(snapshot && snapshot.loggedIn);
}

async function readJson(response) {
    try { return await response.json(); } catch (_) { return null; }
}

function authError(status, body) {
    const err = new Error((body && body.code) || `http_${status}`);
    err.code = (body && body.code) || (status === 401 ? 'unauthorized' : 'request_failed');
    err.status = status;
    return err;
}

function staleScopeError() {
    const err = new Error('reading_scope_changed');
    err.code = 'stale_session';
    return err;
}

function assertScope(scopeOrCtx) {
    const ctx = typeof scopeOrCtx === 'string'
        ? { scope: scopeOrCtx, generation: null }
        : scopeOrCtx;
    if (articleStore.getArticleScope() !== ctx.scope) throw staleScopeError();
    if (ctx.generation != null && !store.isReadingContextActive(ctx)) throw staleScopeError();
}

async function request(path, options = {}) {
    const res = await apiRequest(path, options, { timeoutMs: 30000, roundScoped: true });
    if (res.status === 401) throw authError(401, { code: 'unauthorized' });
    return res;
}

export async function getReadingCapabilities() {
    const res = await request('/reading/capabilities', { method: 'GET' });
    if (res.status === 404 || res.status === 405) return { supported: false, unsupported: true };
    if (!res.ok) {
        const body = await readJson(res);
        throw authError(res.status, body);
    }
    const body = await readJson(res);
    return {
        supported: true,
        legacyWriteBlocked: !!body?.legacyWriteBlocked,
        cursor: Number(body?.cursor) || 0,
        // 新前端必須先確認後端理解 learningItem.marked，才會推／拉閱讀資料；
        // 舊後端缺這個能力時保留本機資料與 outbox，絕不默默清掉待同步修改。
        learningItemMarked: body?.learningItemMarked === true
    };
}

function toMutation(op) {
    return {
        mutationId: op.mutationId,
        entityType: op.entityType,
        entityId: op.entityId,
        op: op.op,
        expectedRevision: op.expectedRevision,
        patch: op.op === 'delete' ? null : op.patch,
        // 固定使用 outbox 建立時間：重送同一業務操作不可因傳輸時間不同而
        // 產生新指紋；伺服器也會忽略此欄位做語意比對。
        clientUpdatedAt: op.createdAt || op.clientUpdatedAt || ''
    };
}

async function pushAll(ctx) {
    let pushed = 0;
    let conflicts = 0;
    let failed = 0;
    let unsupported = false;
    for (let round = 0; round < MAX_PUSH_ROUNDS; round += 1) {
        assertScope(ctx);
        const outbox = await store.listOutbox(ctx);
        assertScope(ctx);
        if (!outbox.length) break;
        // 尚未處理的同欄位衝突不得自動重送，否則會用本機值默默覆蓋雲端。
        const blocked = new Set(store.getReadingConflicts().map((item) => `${item.entityType}:${item.entityId}`));
        const pushable = outbox.filter((op) => !blocked.has(`${op.entityType}:${op.entityId}`));
        if (!pushable.length) break;
        const chunk = pushable.slice(0, MAX_PUSH_MUTATIONS);
        const byMutation = new Map(chunk.map((op) => [op.mutationId, op]));
        let res;
        try {
            res = await request('/reading/mutations', {
                method: 'POST',
                body: JSON.stringify({ mutations: chunk.map(toMutation) })
            });
        } catch (error) {
            if (error && error.code === 'unauthorized') throw error;
            throw error;
        }
        if (res.status === 404 || res.status === 405) {
            unsupported = true;
            break;
        }
        const body = await readJson(res);
        if (!res.ok) {
            const code = body?.code || `http_${res.status}`;
            for (const op of chunk) await store.markOutboxFailed(op.entityType, op.entityId, code, ctx);
            failed += chunk.length;
            break;
        }
        assertScope(ctx);
        const results = Array.isArray(body?.results) ? body.results : [];
        let progressed = false;
        for (const result of results) {
            const op = byMutation.get(result.mutationId);
            if (!op) continue;
            if (result.status === 'ok') {
                const ack = await store.markOutboxAcknowledged(op.entityType, op.entityId, {
                    mutationId: op.mutationId,
                    revision: result.revision,
                    serverRecord: result.record || null
                }, ctx);
                if (!ack.ok) {
                    failed += 1;
                    await store.markOutboxFailed(op.entityType, op.entityId, ack.error || 'ack_failed', ctx);
                    continue;
                }
                pushed += 1;
                progressed = true;
            } else if (result.status === 'conflict') {
                conflicts += 1;
                if (result.current) {
                    const merged = await store.applyRemoteEntity(op.entityType, result.current, ctx);
                    if (!merged.conflict) progressed = true;
                } else {
                    await store.markOutboxFailed(op.entityType, op.entityId, result.code || 'conflict', ctx);
                    await store.applyRemoteTombstone(op.entityType, op.entityId, ctx);
                }
            } else {
                failed += 1;
                await store.markOutboxFailed(op.entityType, op.entityId, result.code || 'invalid', ctx);
            }
        }
        if (!progressed) break;
    }
    return { pushed, conflicts, failed, unsupported };
}

async function pullAll(ctx) {
    let cursor = store.getReadingCursor();
    let pulled = 0;
    let conflicts = 0;
    let unsupported = false;
    for (let page = 0; page < MAX_PULL_PAGES; page += 1) {
        assertScope(ctx);
        const res = await request(`/reading/changes?cursor=${encodeURIComponent(String(cursor))}&limit=200`, { method: 'GET' });
        if (res.status === 404 || res.status === 405) {
            unsupported = true;
            break;
        }
        const body = await readJson(res);
        if (!res.ok) throw authError(res.status, body);
        if (body?.resetRequired) {
            cursor = 0;
            await store.setReadingCursor(0, ctx);
            continue;
        }
        const changes = Array.isArray(body?.changes) ? body.changes : [];
        if (changes.length) {
            // 同一頁可能對同一實體留下多筆 seq；/reading/batch 回的是「目前」
            // 實體，逐筆重套只會重複合併。每個 key 保留最後一筆即語意等價。
            const uniqueChanges = [];
            const seenKeys = new Map();
            for (const change of changes) {
                const key = `${change.entityType}:${change.entityId}`;
                if (seenKeys.has(key)) {
                    uniqueChanges[seenKeys.get(key)] = change;
                    continue;
                }
                seenKeys.set(key, uniqueChanges.length);
                uniqueChanges.push(change);
            }
            const keys = uniqueChanges.map((change) => ({ entityType: change.entityType, entityId: change.entityId }));
            const entities = [];
            for (let index = 0; index < keys.length; index += READING_LIMITS.maxBatchKeys) {
                const chunk = keys.slice(index, index + READING_LIMITS.maxBatchKeys);
                const batchRes = await request('/reading/batch', {
                    method: 'POST',
                    body: JSON.stringify({ keys: chunk })
                });
                if (batchRes.status === 404 || batchRes.status === 405) { unsupported = true; break; }
                const batchBody = await readJson(batchRes);
                if (!batchRes.ok) throw authError(batchRes.status, batchBody);
                if (Array.isArray(batchBody?.entities)) entities.push(...batchBody.entities);
            }
            if (unsupported) break;
            assertScope(ctx);
            const byKey = new Map(entities.map((entity) => [`${entity.entityType}:${entity.id}`, entity]));
            const entries = [];
            for (const change of uniqueChanges) {
                const entity = byKey.get(`${change.entityType}:${change.entityId}`);
                if (entity) {
                    entries.push({ entityType: change.entityType, entityId: change.entityId, remote: entity });
                } else if (change.deletedAt) {
                    // 只有伺服器明確墓碑才刪除本機；批次缺資料不當成刪除。
                    entries.push({ entityType: change.entityType, entityId: change.entityId, tombstone: true });
                } else {
                    const err = new Error('reading_entity_missing');
                    err.code = 'reading_entity_missing';
                    throw err;
                }
            }
            if (entries.length) {
                // 整頁在同一個 IndexedDB 交易套用，避免逐項開交易／讀寫整個 bucket。
                const result = await store.applyRemoteEntities(entries, ctx);
                if (!result.ok) {
                    const err = new Error(result.error || 'reading_pull_failed');
                    err.code = result.error || 'reading_pull_failed';
                    throw err;
                }
                pulled += result.applied || 0;
                conflicts += result.conflicts || 0;
            }
        }
        const next = Number(body?.cursor);
        if (Number.isFinite(next) && next >= cursor) cursor = next;
        await store.setReadingCursor(cursor, ctx);
        if (!body?.hasMore) break;
    }
    return { pulled, conflicts, unsupported, cursor };
}

async function finalizeMigrationGate(ctx) {
    if (!store.isReadingMigrated()) return false;
    if ((await store.listOutbox(ctx)).length) return false;
    if (store.getReadingConflicts().length) return false;
    const res = await request('/reading/mutations', {
        method: 'POST',
        body: JSON.stringify({ mutations: [], final: true })
    });
    if (res.status === 404 || res.status === 405) return false;
    if (!res.ok) return false;
    const body = await readJson(res);
    return !!body?.finalApplied;
}

async function runSync() {
    let ctx = store.captureReadingContext();
    if (store.getReadingScope() !== ctx.scope || !store.isReadingContextActive(ctx)) {
        await store.reloadReadingScope(articleStore.getArticleScope());
        ctx = store.captureReadingContext();
    }
    const scope = ctx.scope;
    assertScope(ctx);
    const migration = await store.migrateLegacyReadingData();
    assertScope(ctx);
    if (!migration.ok) {
        await store.markReadingSyncError(migration.error || 'migration_failed', ctx);
        return { ok: false, error: migration.error || 'migration_failed', migration, scope };
    }
    if (!loggedIn()) {
        return { ok: true, skipped: true, reason: 'signed_out', migration, scope };
    }
    const caps = await getReadingCapabilities();
    if (!caps.supported) {
        await store.markReadingSyncError('server_update_required', ctx);
        return {
            ok: false,
            error: 'server_update_required',
            unsupported: true,
            migration,
            scope,
            message: '此同步服務尚未支援逐項閱讀資料，請更新 Worker / selfhost。'
        };
    }
    if (!caps.learningItemMarked) {
        // 舊後端會把缺少 marked 的 patch 當成一般資料，或用缺欄位覆寫本地
        // 明確取消；在它升級前只保留本機資料與 outbox。
        await store.markReadingSyncError('server_update_required', ctx);
        return {
            ok: false,
            error: 'server_update_required',
            unsupported: true,
            capability: 'learningItemMarked',
            migration,
            scope,
            message: '此同步服務尚未支援文章標記，請更新 Worker / selfhost。'
        };
    }
    // 舊後端閘門尚未關閉前，先把雲端舊 snapshot 的詞書／聊天移交到永久層。
    // 只有舊資料、且只補缺少的實體，不覆蓋本機既有內容；移交失敗就不關閘。
    if (!caps.legacyWriteBlocked && !store.getReadingMeta().legacySnapshotAdopted) {
        // 用共用的 pullSnapshot：這輪稍後主同步讀快照時可直接命中同一版本，
        // 不必再下載一次完整 payload。舊後端不支援條件讀取時照常回完整內容。
        const snapshot = await pullSnapshot();
        const payload = snapshot?.payload || {};
        if (payload.vocabulary || payload.assistant) {
            const vocab = await store.adoptLegacyVocabularySnapshot(payload.vocabulary?.books || []);
            if (!vocab.ok) throw authError(500, { code: vocab.error || 'legacy_vocabulary_handover_failed' });
            const assistant = await store.adoptLegacyAssistantSnapshot(payload.assistant || {});
            if (!assistant.ok) throw authError(500, { code: assistant.error || 'legacy_assistant_handover_failed' });
        }
        await store.markLegacySnapshotAdopted();
    }
    let push = await pushAll(ctx);
    let pull = await pullAll(ctx);
    // 拉取後可能產生需要重送的三方合併，再做一輪推／拉收斂。
    const pushAgain = await pushAll(ctx);
    const pullAgain = await pullAll(ctx);
    assertScope(ctx);
    const finalized = await finalizeMigrationGate(ctx).catch(() => false);
    assertScope(ctx);
    const pending = (await store.listOutbox(ctx)).length;
    const conflicts = store.getReadingConflicts().length;
    await store.markReadingSynced(undefined, ctx);
    return {
        ok: true,
        scope,
        migration,
        capabilities: caps,
        pushed: push.pushed + pushAgain.pushed,
        pulled: pull.pulled + pullAgain.pulled,
        conflicts: push.conflicts + pull.conflicts + pushAgain.conflicts + pullAgain.conflicts,
        failed: push.failed + pushAgain.failed,
        pending,
        conflictCount: conflicts,
        finalized,
        unsupported: pull.unsupported || push.unsupported
    };
}

export async function syncReading() {
    if (inFlight) return inFlight;
    inFlight = runSync();
    try {
        return await inFlight;
    } catch (error) {
        const ctx = store.captureReadingContext();
        await store.markReadingSyncError(error && error.code ? error.code : 'sync_failed', ctx).catch(() => {});
        throw error;
    } finally {
        inFlight = null;
    }
}

export function isReadingSyncRunning() {
    return !!inFlight;
}

/**
 * 使用者處理衝突：
 *   keep-local  保留本機並用遠端 revision 重送
 *   use-remote  採用雲端版本
 *   keep-copy   本機另存副本，原實體採用雲端版本
 */
export async function resolveReadingConflict(entityType, entityId, choice) {
    const ctx = store.captureReadingContext();
    const conflict = store.getReadingConflicts().find((item) => item.entityType === entityType && item.entityId === entityId);
    if (!conflict) return { ok: false, error: 'no_conflict' };
    const remote = conflict.remote;
    if (choice === 'use-remote' && remote) {
        await store.persistRemoteEntity(entityType, remote, ctx);
        await store.discardOutbox(entityType, entityId, ctx);
        await store.clearReadingConflict(entityType, entityId, ctx);
        await syncReading();
        return { ok: true };
    }
    if (choice === 'keep-copy') {
        const local = store.getEntitySync(entityType, entityId);
        if (local) await store.duplicateEntityForConflict(entityType, local);
        if (remote) await store.persistRemoteEntity(entityType, remote, ctx);
        await store.discardOutbox(entityType, entityId, ctx);
        await store.clearReadingConflict(entityType, entityId, ctx);
        await syncReading();
        return { ok: true, copied: true };
    }
    // keep-local：合併後的記錄已保留本機值，outbox 的 expectedRevision 也已
    // 指向遠端 revision；清掉衝突標記後重送即可。
    await store.clearReadingConflict(entityType, entityId, ctx);
    await syncReading();
    return { ok: true };
}
