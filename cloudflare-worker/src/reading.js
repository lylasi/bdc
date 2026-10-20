// 逐項閱讀資料 API（Cloudflare D1 / selfhost 共用）。
//
// 路由：
//   GET  /reading/capabilities                 能力與舊快照閘門
//   GET  /reading/changes?cursor=              服務端序號增量
//   POST /reading/batch                        { keys:[{entityType,entityId}] }
//   POST /reading/mutations                    { mutations:[...], final? }
//
// 每次 mutation 的「實體、change、冪等憑據、游標前進」都在同一個 DB batch
// （D1 交易／selfhost BEGIN…COMMIT）內完成。owner 一律由登入者取得，不接受
// 客戶端指定。

import { errorJson, json, readJsonBody } from './http.js';
import {
    READING_ENTITY_TYPES,
    READING_ERRORS,
    READING_LIMITS,
    parseReadingCursor,
    parseReadingLimit,
    readingMutationFingerprint,
    validateReadingMutation,
    wireReadingEntity
} from '../../shared/reading-protocol.mjs';

function nowIso() {
    return new Date().toISOString();
}

function changed(result) {
    if (!result) return 0;
    const meta = result.meta || {};
    return Number(meta.changes != null ? meta.changes : result.changes) || 0;
}

async function ensureState(env, userId) {
    await env.DB
        .prepare('INSERT INTO reading_state (owner_user_id, next_seq, legacy_write_blocked, updated_at) VALUES (?, 1, 0, ?) ON CONFLICT (owner_user_id) DO NOTHING')
        .bind(userId, nowIso())
        .run();
    const row = await env.DB
        .prepare('SELECT next_seq, legacy_write_blocked, migrated_at, updated_at FROM reading_state WHERE owner_user_id = ?')
        .bind(userId)
        .first();
    return {
        nextSeq: Number(row?.next_seq || 1),
        legacyWriteBlocked: Number(row?.legacy_write_blocked || 0) === 1,
        migratedAt: row?.migrated_at || '',
        updatedAt: row?.updated_at || ''
    };
}

export async function isLegacyReadingWriteBlocked(env, userId) {
    const row = await env.DB
        .prepare('SELECT legacy_write_blocked FROM reading_state WHERE owner_user_id = ?')
        .bind(userId)
        .first();
    return Number(row?.legacy_write_blocked || 0) === 1;
}

function rowToEntity(row) {
    if (!row) return null;
    let data = {};
    try { data = row.data_json ? JSON.parse(row.data_json) : {}; } catch (_) { data = {}; }
    return wireReadingEntity({
        ...data,
        id: row.entity_id,
        revision: Number(row.revision) || 0,
        deletedAt: row.deleted_at || ''
    });
}

async function readRow(env, userId, entityType, entityId) {
    return env.DB
        .prepare('SELECT * FROM reading_entities WHERE owner_user_id = ? AND entity_type = ? AND entity_id = ?')
        .bind(userId, entityType, entityId)
        .first();
}

async function readMutation(env, userId, mutationId) {
    return env.DB
        .prepare('SELECT * FROM reading_mutations WHERE owner_user_id = ? AND mutation_id = ?')
        .bind(userId, mutationId)
        .first();
}

async function readBatch(env, userId, keys) {
    const out = [];
    for (const key of keys) {
        const entityType = String(key?.entityType || '');
        const entityId = String(key?.entityId || '');
        if (!READING_ENTITY_TYPES.includes(entityType) || !entityId) continue;
        const row = await readRow(env, userId, entityType, entityId);
        if (!row) continue;
        out.push({
            entityType,
            entityId,
            ...rowToEntity(row)
        });
    }
    return out;
}

function parseKeys(raw) {
    const list = Array.isArray(raw) ? raw : [];
    const unique = [];
    const seen = new Set();
    for (const item of list) {
        if (!item) continue;
        const entityType = String(item.entityType || '');
        const entityId = String(item.entityId || '');
        if (!READING_ENTITY_TYPES.includes(entityType) || !entityId) continue;
        const key = `${entityType}:${entityId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push({ entityType, entityId });
        if (unique.length >= READING_LIMITS.maxBatchKeys) break;
    }
    return unique;
}

function priorResponse(env, userId, prior, mutation, fingerprint) {
    const existingPromise = readRow(env, userId, prior.entity_type, prior.entity_id);
    const matches = priorMatchesMutation(prior, mutation, fingerprint);
    return existingPromise.then((existing) => {
        if (!matches) {
            return {
                mutationId: mutation.mutationId,
                status: 'conflict',
                code: 'reading_mutation_mismatch',
                current: rowToEntity(existing)
            };
        }
        let result = null;
        try { result = prior.result_json ? JSON.parse(prior.result_json) : null; } catch (_) { result = null; }
        if (result && result.claim) {
            // 正常交易會在提交前把 claim 換成完整回執；若看到 claim，代表
            // 上一個請求的交易尚未完成或已中止。以目前實體回傳完整回執，
            // 絕不回傳缺少 revision／record 的假成功。
            const current = rowToEntity(existing);
            return {
                mutationId: mutation.mutationId,
                status: 'ok',
                idempotent: true,
                revision: Number(prior.revision) || Number(current?.revision) || 0,
                record: current
            };
        }
        return { mutationId: mutation.mutationId, status: 'ok', idempotent: true, ...(result || {}) };
    });
}

function priorMatchesMutation(prior, mutation, fingerprint) {
    if (!prior) return false;
    if (prior.request_json === fingerprint) return true;
    let parsed = null;
    try { parsed = prior.request_json ? JSON.parse(prior.request_json) : null; } catch (_) { parsed = null; }
    if (!parsed || typeof parsed !== 'object') return false;
    // 相容舊版以完整 JSON（含 clientUpdatedAt）保存的 ledger：仍用同一份
    // 業務指紋比較，不能因重試時間不同就拒絕真正的重送。
    return readingMutationFingerprint(parsed) === fingerprint
        && String(prior.entity_type || '') === mutation.entityType
        && String(prior.entity_id || '') === mutation.entityId;
}

async function applyMutation(env, userId, mutation) {
    const existing = await readRow(env, userId, mutation.entityType, mutation.entityId);
    const prior = await readMutation(env, userId, mutation.mutationId);
    const fingerprint = readingMutationFingerprint(mutation);
    if (prior) return priorResponse(env, userId, prior, mutation, fingerprint);

    const currentRevision = Number(existing?.revision) || 0;
    if (mutation.op === 'upsert' && existing?.deleted_at) {
        // 只有帶著目前 revision 的明確 upsert 才能復活；離線舊 revision 仍衝突。
        if (mutation.expectedRevision !== currentRevision) {
            return {
                mutationId: mutation.mutationId,
                status: 'conflict',
                code: READING_ERRORS.alreadyDeleted,
                current: rowToEntity(existing)
            };
        }
    }
    if (mutation.op === 'delete' && !existing) {
        return {
            mutationId: mutation.mutationId,
            status: 'conflict',
            code: READING_ERRORS.notFound,
            current: null
        };
    }
    if (mutation.op === 'delete' && existing?.deleted_at && mutation.expectedRevision === currentRevision) {
        return {
            mutationId: mutation.mutationId,
            status: 'ok',
            idempotent: true,
            revision: currentRevision,
            record: rowToEntity(existing)
        };
    }
    if (mutation.expectedRevision !== currentRevision) {
        return {
            mutationId: mutation.mutationId,
            status: 'conflict',
            code: READING_ERRORS.revisionConflict,
            current: rowToEntity(existing)
        };
    }

    const nextRevision = currentRevision + 1;
    const timestamp = nowIso();
    const deletedAt = mutation.op === 'delete' ? timestamp : null;
    const dataJson = mutation.op === 'delete'
        ? (existing?.data_json || '{}')
        : JSON.stringify(mutation.patch || {});
    const resultRecord = {
        ...(mutation.op === 'delete' ? rowToEntity(existing) : wireReadingEntity({ ...mutation.patch, id: mutation.entityId })),
        id: mutation.entityId,
        revision: nextRevision,
        deletedAt: deletedAt || ''
    };
    const resultJson = JSON.stringify({ revision: nextRevision, record: resultRecord });
    // 每次 HTTP 請求一個唯一 claim。ledger 的 PK 決定誰有權寫入；後續
    // entity／change／cursor 都只在「ledger 仍是自己的 claim」時才生效。
    // 這使同一 mutationId 的並發請求即使 payload 或 entity 不同，也只有
    // 真正先取得 ledger 的那一個能寫入。
    const claimToken = `claim_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const claimJson = JSON.stringify({ claim: claimToken });
    const claimWhere = 'SELECT 1 FROM reading_mutations WHERE owner_user_id = ? AND mutation_id = ? AND result_json = ?';
    const entityMatchWhere = 'SELECT 1 FROM reading_entities WHERE owner_user_id = ? AND entity_type = ? AND entity_id = ? AND revision = ? AND last_mutation_id = ?';

    const statements = [];
    statements.push(env.DB
        .prepare('INSERT INTO reading_mutations (owner_user_id, mutation_id, entity_type, entity_id, revision, request_json, result_json, created_at) '
            + 'VALUES (?, ?, ?, ?, 0, ?, ?, ?) ON CONFLICT (owner_user_id, mutation_id) DO NOTHING')
        .bind(userId, mutation.mutationId, mutation.entityType, mutation.entityId, fingerprint, claimJson, timestamp));
    if (existing) {
        statements.push(env.DB
            .prepare('UPDATE reading_entities SET revision = ?, deleted_at = ?, data_json = ?, updated_at = ?, last_mutation_id = ? '
                + 'WHERE owner_user_id = ? AND entity_type = ? AND entity_id = ? AND revision = ? '
                + 'AND EXISTS (' + claimWhere + ')')
            .bind(nextRevision, deletedAt, dataJson, timestamp, mutation.mutationId, userId, mutation.entityType, mutation.entityId, currentRevision, userId, mutation.mutationId, claimJson));
    } else {
        statements.push(env.DB
            .prepare('INSERT INTO reading_entities (owner_user_id, entity_type, entity_id, revision, deleted_at, data_json, updated_at, last_mutation_id) '
                + 'SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (' + claimWhere + ')')
            .bind(userId, mutation.entityType, mutation.entityId, nextRevision, deletedAt, dataJson, timestamp, mutation.mutationId, userId, mutation.mutationId, claimJson));
    }
    statements.push(env.DB
        .prepare('INSERT INTO reading_changes (owner_user_id, seq, entity_type, entity_id, op, revision, updated_at) '
            + 'SELECT owner_user_id, next_seq, ?, ?, ?, ?, ? FROM reading_state '
            + 'WHERE owner_user_id = ? AND EXISTS (' + claimWhere + ') AND EXISTS (' + entityMatchWhere + ')')
        .bind(mutation.entityType, mutation.entityId, mutation.op, nextRevision, timestamp, userId, userId, mutation.mutationId, claimJson, userId, mutation.entityType, mutation.entityId, nextRevision, mutation.mutationId));
    statements.push(env.DB
        .prepare('UPDATE reading_state SET next_seq = next_seq + 1, updated_at = ? '
            + 'WHERE owner_user_id = ? AND EXISTS (' + claimWhere + ') '
            + 'AND EXISTS (SELECT 1 FROM reading_changes WHERE owner_user_id = ? AND entity_type = ? AND entity_id = ? AND revision = ?)')
        .bind(timestamp, userId, userId, mutation.mutationId, claimJson, userId, mutation.entityType, mutation.entityId, nextRevision));
    statements.push(env.DB
        .prepare('UPDATE reading_mutations SET revision = ?, result_json = ? '
            + 'WHERE owner_user_id = ? AND mutation_id = ? AND result_json = ? '
            + 'AND EXISTS (' + entityMatchWhere + ')')
        .bind(nextRevision, resultJson, userId, mutation.mutationId, claimJson, userId, mutation.entityType, mutation.entityId, nextRevision, mutation.mutationId));
    statements.push(env.DB
        .prepare('DELETE FROM reading_mutations '
            + 'WHERE owner_user_id = ? AND mutation_id = ? AND result_json = ? '
            + 'AND NOT EXISTS (' + entityMatchWhere + ')')
        .bind(userId, mutation.mutationId, claimJson, userId, mutation.entityType, mutation.entityId, nextRevision, mutation.mutationId));

    let batchResults;
    try {
        batchResults = await env.DB.batch(statements);
    } catch (error) {
        // 並發建立同一 ID：交易已整批回滾，重讀後判斷是冪等成功或衝突。
        const latestPrior = await readMutation(env, userId, mutation.mutationId);
        if (latestPrior) return priorResponse(env, userId, latestPrior, mutation, fingerprint);
        const latest = await readRow(env, userId, mutation.entityType, mutation.entityId);
        return {
            mutationId: mutation.mutationId,
            status: 'conflict',
            code: READING_ERRORS.revisionConflict,
            current: rowToEntity(latest)
        };
    }
    // 只有 ledger 真的換成完整回執才算成功；單看 UPDATE changes 會讓並發
    // 失敗的第二個請求因第一個請求的 revision 而誤判成功。
    const applied = await readMutation(env, userId, mutation.mutationId);
    if (!applied || !priorMatchesMutation(applied, mutation, fingerprint)) {
        const latest = await readRow(env, userId, mutation.entityType, mutation.entityId);
        return {
            mutationId: mutation.mutationId,
            status: 'conflict',
            code: applied ? 'reading_mutation_mismatch' : READING_ERRORS.revisionConflict,
            current: rowToEntity(latest)
        };
    }
    let receipt = null;
    try { receipt = applied.result_json ? JSON.parse(applied.result_json) : null; } catch (_) { receipt = null; }
    if (!receipt || receipt.claim) {
        const latest = await readRow(env, userId, mutation.entityType, mutation.entityId);
        return {
            mutationId: mutation.mutationId,
            status: 'conflict',
            code: READING_ERRORS.revisionConflict,
            current: rowToEntity(latest)
        };
    }
    return { mutationId: mutation.mutationId, status: 'ok', idempotent: false, ...receipt };
}

async function handleBatch({ request, env, user }) {
    const userId = user.user_id;
    const body = await readJsonBody(request, READING_LIMITS.requestMaxBytes);
    const keys = parseKeys(body?.keys);
    if (keys.length > READING_LIMITS.maxBatchKeys) {
        return errorJson(READING_ERRORS.invalidMutation, 400, env, request, { limit: READING_LIMITS.maxBatchKeys });
    }
    const entities = keys.length ? await readBatch(env, userId, keys) : [];
    return json({ entities }, 200, env, request);
}

async function handleMutations({ request, env, user }) {
    const userId = user.user_id;
    const state = await ensureState(env, userId);
    const body = await readJsonBody(request, READING_LIMITS.requestMaxBytes);
    const rawList = Array.isArray(body?.mutations) ? body.mutations : [];
    if (rawList.length > READING_LIMITS.maxMutationsPerRequest) {
        return errorJson(READING_ERRORS.invalidMutation, 400, env, request, { limit: READING_LIMITS.maxMutationsPerRequest });
    }
    const results = [];
    for (const raw of rawList) {
        const parsed = validateReadingMutation(raw);
        if (!parsed.ok) {
            results.push({
                mutationId: String(raw?.mutationId || ''),
                status: 'invalid',
                code: parsed.error
            });
            continue;
        }
        results.push(await applyMutation(env, userId, parsed.mutation));
    }
    const final = body?.final === true;
    const allApplied = results.every((item) => item.status === 'ok');
    if (final && allApplied) {
        await env.DB
            .prepare('UPDATE reading_state SET legacy_write_blocked = 1, migrated_at = COALESCE(migrated_at, ?), updated_at = ? WHERE owner_user_id = ?')
            .bind(nowIso(), nowIso(), userId)
            .run();
    }
    const nextState = await ensureState(env, userId);
    return json({
        results,
        cursor: nextState.nextSeq - 1,
        legacyWriteBlocked: nextState.legacyWriteBlocked,
        finalApplied: final && allApplied
    }, 200, env, request);
}

async function handleChanges({ request, env, url, user }) {
    const userId = user.user_id;
    const state = await ensureState(env, userId);
    const { cursor, invalid } = parseReadingCursor(url.searchParams.get('cursor'));
    const limit = parseReadingLimit(url.searchParams.get('limit'), 200);
    if (invalid) {
        return json({ resetRequired: true, reason: 'invalid_cursor', cursor: state.nextSeq - 1, changes: [], hasMore: false }, 200, env, request);
    }
    if (cursor >= state.nextSeq) {
        return json({ resetRequired: false, cursor: state.nextSeq - 1, serverCursor: state.nextSeq - 1, changes: [], hasMore: false, legacyWriteBlocked: state.legacyWriteBlocked }, 200, env, request);
    }
    const rows = await env.DB
        .prepare('SELECT c.seq, c.entity_type, c.entity_id, c.op, c.revision, c.updated_at, e.deleted_at FROM reading_changes c '
            + 'LEFT JOIN reading_entities e ON e.owner_user_id = c.owner_user_id AND e.entity_type = c.entity_type AND e.entity_id = c.entity_id '
            + 'WHERE c.owner_user_id = ? AND c.seq > ? ORDER BY c.seq ASC LIMIT ?')
        .bind(userId, cursor, limit + 1)
        .all();
    const all = rows?.results || [];
    const hasMore = all.length > limit;
    const slice = all.slice(0, limit);
    const nextCursor = slice.length ? Number(slice[slice.length - 1].seq) : cursor;
    return json({
        resetRequired: false,
        cursor: nextCursor,
        serverCursor: state.nextSeq - 1,
        hasMore,
        legacyWriteBlocked: state.legacyWriteBlocked,
        changes: slice.map((row) => ({
            entityType: row.entity_type,
            entityId: row.entity_id,
            op: row.op,
            revision: Number(row.revision) || 0,
            updatedAt: row.updated_at || '',
            deletedAt: row.deleted_at || '',
            seq: Number(row.seq) || 0
        }))
    }, 200, env, request);
}

export async function handleReadingRoute({ request, env, url, user, rest }) {
    const path = String(rest || '');
    const method = request.method;

    if (path === '/capabilities' && method === 'GET') {
        const state = await ensureState(env, user.user_id);
        return json({
            supported: true,
            // 舊後端沒有這個能力時，新前端會在同步前停下並保留 outbox。
            learningItemMarked: true,
            legacyWriteBlocked: state.legacyWriteBlocked,
            cursor: state.nextSeq - 1,
            limits: READING_LIMITS
        }, 200, env, request);
    }
    if (path === '/changes' && method === 'GET') {
        return handleChanges({ request, env, url, user });
    }
    if (path === '/batch' && method === 'POST') {
        return handleBatch({ request, env, user });
    }
    if (path === '/mutations' && method === 'POST') {
        return handleMutations({ request, env, user });
    }
    if (path === '' || path === '/' || path === '/capabilities' || path === '/changes' || path === '/batch' || path === '/mutations') {
        return errorJson(READING_ERRORS.methodNotAllowed, 405, env, request);
    }
    return errorJson('not_found', 404, env, request);
}
