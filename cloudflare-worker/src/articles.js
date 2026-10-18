// 文章逐篇儲存 API（Cloudflare D1）。
//
// 與 selfhost/articles.js 共用同一份協議驗證（shared/article-protocol.mjs）與
// 相同的 SQL 語意：
//
//   GET    /articles                  增量（?cursor=）或完整列表（?full=1）
//   POST   /articles/batch            批次讀取單篇文件 { ids }
//   POST   /articles/import           舊快照文章匯入（冪等，最後一次會開啟舊寫入閘門）
//   GET    /articles/usage            目前用量
//   GET    /articles/:id              單篇文件
//   POST   /articles                  新增（冪等：clientMutationId）
//   PUT    /articles/:id              更新（expectedRevision 原子版本檢查）
//   DELETE /articles/:id              刪除（軟刪除＋tombstone）
//   POST   /articles/:id/restore      復原（同樣帶 expectedRevision）
//
// 所有查詢都帶 `owner_user_id = 登入者 user_id`，別人的文章一律當成不存在（404），
// 不洩漏跨帳戶的存在性。`label` 與 `token_hash` 都不參與文章身份。

import { errorJson, json, readJsonBody } from './http.js';
import {
    ARTICLE_ERRORS,
    ARTICLE_LIMITS,
    checkQuota,
    conflictPayload,
    generateArticleId,
    isValidArticleId,
    normalizeArticleDocument,
    normalizeMutationId,
    parseCursor,
    parseExpectedRevision,
    parseListLimit,
    summarizeUsage,
    toArticleDocument,
    toArticleMeta
} from '../../shared/article-protocol.mjs';

const MAX_BATCH_ITEMS = 8; // 每批 SQL 語句數（每篇 3 條），避免單次 batch 過大

function nowIso() {
    return new Date().toISOString();
}

async function ensureState(env, userId) {
    await env.DB
        .prepare('INSERT INTO article_state (owner_user_id, next_seq, legacy_write_blocked, updated_at) VALUES (?, 1, 0, ?) ON CONFLICT (owner_user_id) DO NOTHING')
        .bind(userId, nowIso())
        .run();
    const row = await env.DB
        .prepare('SELECT next_seq, legacy_write_blocked, migrated_at, pruned_before FROM article_state WHERE owner_user_id = ?')
        .bind(userId)
        .first();
    return {
        nextSeq: Number(row?.next_seq || 1),
        legacyWriteBlocked: Number(row?.legacy_write_blocked || 0) === 1,
        migratedAt: row?.migrated_at || '',
        prunedBefore: Number(row?.pruned_before || 0)
    };
}

export async function isLegacyArticleWriteBlocked(env, userId) {
    const row = await env.DB
        .prepare('SELECT legacy_write_blocked FROM article_state WHERE owner_user_id = ?')
        .bind(userId)
        .first();
    return Number(row?.legacy_write_blocked || 0) === 1;
}

async function readRow(env, userId, articleId) {
    return env.DB
        .prepare('SELECT * FROM articles WHERE owner_user_id = ? AND id = ?')
        .bind(userId, articleId)
        .first();
}

async function readUsage(env, userId) {
    const rows = await env.DB
        .prepare('SELECT size_bytes, deleted_at FROM articles WHERE owner_user_id = ?')
        .bind(userId)
        .all();
    return summarizeUsage(rows?.results || []);
}

// 三條語句一組：文章寫入 + 變更記錄 + 游標前進。三者在同一 batch（D1 交易）內，
// 因此「文章寫入成功但變更記錄沒寫」不會發生；條件不成立時三條都不生效。
function writeStatements(env, { userId, changes }) {
    return changes.map((change) => env.DB
        .prepare('INSERT INTO article_changes (owner_user_id, seq, article_id, op, revision, updated_at) '
            + 'SELECT owner_user_id, next_seq, ?, ?, ?, ? FROM article_state '
            + 'WHERE owner_user_id = ? AND EXISTS (SELECT 1 FROM articles WHERE owner_user_id = ? AND id = ? AND revision = ?)')
        .bind(change.articleId, change.op, change.revision, change.updatedAt, userId, userId, change.articleId, change.revision));
}

function advanceStatements(env, { userId, changes }) {
    return changes.map((change) => env.DB
        .prepare('UPDATE article_state SET next_seq = next_seq + 1, updated_at = ? '
            + 'WHERE owner_user_id = ? AND EXISTS (SELECT 1 FROM articles WHERE owner_user_id = ? AND id = ? AND revision = ?)')
        .bind(change.updatedAt, userId, userId, change.articleId, change.revision));
}

function insertStatement(env, { userId, document, size, articleId, mutationId, updatedAt }) {
    return env.DB
        .prepare('INSERT INTO articles (owner_user_id, id, title, body, analysis_json, source_type, source_url, revision, created_at, updated_at, deleted_at, legacy_article_id, last_mutation_id, size_bytes) '
            + 'VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, ?, ?, ?)')
        .bind(
            userId,
            articleId,
            document.title,
            document.body,
            document.analysis === null ? null : JSON.stringify(document.analysis),
            document.sourceType,
            document.sourceUrl || null,
            updatedAt,
            updatedAt,
            document.legacyArticleId || null,
            mutationId || null,
            size
        );
}

async function respondDoc(env, request, row, status, extra = {}) {
    return json({ ...extra, article: toArticleDocument(row) }, status, env, request);
}

function malformed(error) {
    const err = new Error(error);
    err.code = error;
    err.status = 400;
    return err;
}

export async function handleArticlesRoute({ request, env, url, user, rest }) {
    const userId = user.user_id;
    const method = request.method;
    const path = String(rest || '');

    // --- 用量 ---
    if (path === '/usage' && method === 'GET') {
        const usage = await readUsage(env, userId);
        const state = await ensureState(env, userId);
        return json({
            count: usage.count,
            totalBytes: usage.totalBytes,
            limits: ARTICLE_LIMITS,
            warning: usage.count > ARTICLE_LIMITS.warnCount,
            legacyWriteBlocked: state.legacyWriteBlocked,
            cursor: state.nextSeq - 1
        }, 200, env, request);
    }

    // --- 批次讀取文件 ---
    if (path === '/batch' && method === 'POST') {
        const body = await readJsonBody(request, ARTICLE_LIMITS.requestMaxBytes);
        const ids = Array.isArray(body?.ids) ? body.ids.map((id) => String(id || '')).filter(Boolean) : [];
        if (!ids.length) return json({ articles: [] }, 200, env, request);
        if (ids.length > ARTICLE_LIMITS.batchMax) {
            return errorJson(ARTICLE_ERRORS.invalidBody, 400, env, request, { limit: ARTICLE_LIMITS.batchMax });
        }
        const found = [];
        for (const id of Array.from(new Set(ids)).slice(0, ARTICLE_LIMITS.batchMax)) {
            const row = await readRow(env, userId, id);
            if (row && !row.deleted_at) found.push(toArticleDocument(row));
        }
        return json({ articles: found }, 200, env, request);
    }

    // --- 舊資料匯入 ---
    if (path === '/import' && method === 'POST') {
        return handleImport({ request, env, user });
    }

    // --- 列表／增量 ---
    if ((path === '' || path === '/') && method === 'GET') {
        return handleList({ request, env, url, user });
    }

    // --- 新增 ---
    if ((path === '' || path === '/') && method === 'POST') {
        const body = await readJsonBody(request, ARTICLE_LIMITS.requestMaxBytes);
        return handleCreate({ request, env, user, body });
    }

    // --- 單篇 ---
    const restoreMatch = path.match(/^\/([^/]+)\/restore$/);
    if (restoreMatch && method === 'POST') {
        return handleRestore({ request, env, user, articleId: decodeURIComponent(restoreMatch[1]) });
    }
    const singleMatch = path.match(/^\/([^/]+)$/);
    if (singleMatch) {
        const articleId = decodeURIComponent(singleMatch[1]);
        if (method === 'GET') {
            const row = await readRow(env, userId, articleId);
            if (!row) return errorJson(ARTICLE_ERRORS.notFound, 404, env, request);
            return respondDoc(env, request, row, 200, { deleted: !!row.deleted_at });
        }
        if (method === 'PUT') return handleUpdate({ request, env, user, articleId });
        if (method === 'DELETE') return handleDelete({ request, env, user, articleId });
    }

    if (path === '' || path === '/' || singleMatch || restoreMatch) {
        return errorJson(ARTICLE_ERRORS.methodNotAllowed, 405, env, request);
    }
    return errorJson('not_found', 404, env, request);
}

async function handleList({ request, env, url, user }) {
    const userId = user.user_id;
    const state = await ensureState(env, userId);
    const full = url.searchParams.get('full') === '1';
    const includeDeleted = url.searchParams.get('includeDeleted') === '1';
    const limit = parseListLimit(url.searchParams.get('limit'));

    if (full) {
        const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') || '0', 10) || 0);
        const rows = await env.DB
            .prepare(`SELECT * FROM articles WHERE owner_user_id = ?${includeDeleted ? '' : ' AND deleted_at IS NULL'} ORDER BY updated_at DESC, id ASC LIMIT ? OFFSET ?`)
            .bind(userId, limit + 1, offset)
            .all();
        const list = rows?.results || [];
        const hasMore = list.length > limit;
        return json({
            full: true,
            cursor: state.nextSeq - 1,
            articles: list.slice(0, limit).map(toArticleMeta),
            hasMore,
            offset: offset + Math.min(limit, list.length)
        }, 200, env, request);
    }

    const { cursor, invalid } = parseCursor(url.searchParams.get('cursor'));
    if (invalid) {
        return json({ resetRequired: true, reason: 'invalid_cursor', cursor: state.nextSeq - 1, changes: [], hasMore: false }, 200, env, request);
    }
    if (cursor < state.prunedBefore) {
        return json({ resetRequired: true, reason: 'cursor_expired', cursor: state.nextSeq - 1, changes: [], hasMore: false }, 200, env, request);
    }
    if (cursor >= state.nextSeq) {
        return json({ resetRequired: false, cursor: state.nextSeq - 1, changes: [], hasMore: false }, 200, env, request);
    }
    const rows = await env.DB
        .prepare('SELECT c.seq, c.article_id, c.op, c.revision, a.title, a.source_type, a.source_url, a.created_at, a.updated_at, a.deleted_at, a.size_bytes, a.revision AS current_revision '
            + 'FROM article_changes c JOIN articles a ON a.owner_user_id = c.owner_user_id AND a.id = c.article_id '
            + 'WHERE c.owner_user_id = ? AND c.seq > ? ORDER BY c.seq ASC LIMIT ?')
        .bind(userId, cursor, limit + 1)
        .all();
    const all = rows?.results || [];
    const hasMore = all.length > limit;
    const slice = all.slice(0, limit);
    const changes = slice.map((row) => ({
        ...toArticleMeta({
            id: row.article_id,
            revision: row.current_revision,
            title: row.title,
            source_type: row.source_type,
            source_url: row.source_url,
            created_at: row.created_at,
            updated_at: row.updated_at,
            deleted_at: row.deleted_at,
            size_bytes: row.size_bytes
        }),
        seq: Number(row.seq),
        op: row.op,
        revision: Number(row.revision),
        currentRevision: Number(row.current_revision)
    }));
    const nextCursor = slice.length ? Number(slice[slice.length - 1].seq) : cursor;
    return json({
        resetRequired: false,
        cursor: nextCursor,
        serverCursor: state.nextSeq - 1,
        hasMore,
        changes
    }, 200, env, request);
}

async function handleCreate({ request, env, user, body }) {
    const userId = user.user_id;
    const mutationId = normalizeMutationId(body?.clientMutationId);
    const parsed = normalizeArticleDocument(body);
    if (!parsed.ok) {
        const status = parsed.error === ARTICLE_ERRORS.bodyTooLarge ? 413 : 400;
        return errorJson(parsed.error, status, env, request, parsed.limit ? { limit: parsed.limit } : undefined);
    }
    const document = parsed.document;
    let articleId = document.id ? String(document.id) : '';
    if (articleId && !isValidArticleId(articleId)) {
        return errorJson(ARTICLE_ERRORS.invalidId, 400, env, request);
    }
    if (!articleId) articleId = generateArticleId();

    const existing = await readRow(env, userId, articleId);
    if (existing) {
        if (mutationId && existing.last_mutation_id === mutationId) {
            return respondDoc(env, request, existing, 200, { created: false, idempotent: true });
        }
        return errorJson(ARTICLE_ERRORS.idExists, 409, env, request, { current: toArticleMeta(existing) });
    }

    const usage = await readUsage(env, userId);
    const quota = checkQuota({ usage, nextSize: parsed.size, isCreate: true });
    if (!quota.ok) {
        const status = quota.error === ARTICLE_ERRORS.countExceeded || quota.error === ARTICLE_ERRORS.quotaExceeded ? 409 : 413;
        return errorJson(quota.error, status, env, request, {
            limit: quota.limit,
            count: quota.count,
            totalBytes: quota.totalBytes
        });
    }

    await ensureState(env, userId);
    const updatedAt = nowIso();
    try {
        await env.DB.batch([
            insertStatement(env, { userId, document, size: parsed.size, articleId, mutationId, updatedAt }),
            ...writeStatements(env, { userId, changes: [{ articleId, op: 'create', revision: 1, updatedAt }] }),
            ...advanceStatements(env, { userId, changes: [{ articleId, revision: 1, updatedAt }] })
        ]);
    } catch (error) {
        // 併發建立同一 ID：重讀一次，若是同一個 mutation 就當成冪等成功。
        const row = await readRow(env, userId, articleId);
        if (row && mutationId && row.last_mutation_id === mutationId) {
            return respondDoc(env, request, row, 200, { created: false, idempotent: true });
        }
        throw error;
    }
    const row = await readRow(env, userId, articleId);
    return respondDoc(env, request, row, 201, { created: true });
}

async function handleUpdate({ request, env, user, articleId }) {
    const userId = user.user_id;
    const body = await readJsonBody(request, ARTICLE_LIMITS.requestMaxBytes);
    const existing = await readRow(env, userId, articleId);
    if (!existing) return errorJson(ARTICLE_ERRORS.notFound, 404, env, request);

    const mutationId = normalizeMutationId(body?.clientMutationId);
    if (mutationId && existing.last_mutation_id === mutationId) {
        return respondDoc(env, request, existing, 200, { updated: false, idempotent: true });
    }
    if (existing.deleted_at) {
        return errorJson(ARTICLE_ERRORS.alreadyDeleted, 409, env, request, { current: toArticleMeta(existing) });
    }
    const expected = parseExpectedRevision(body?.expectedRevision);
    if (expected === null) return errorJson(ARTICLE_ERRORS.revisionRequired, 400, env, request);
    if (expected !== Number(existing.revision)) {
        return json(conflictPayload(existing), 409, env, request);
    }

    const merged = {
        id: articleId,
        title: body?.title !== undefined ? body.title : existing.title,
        body: body?.body !== undefined ? body.body : existing.body,
        analysis: body?.analysis !== undefined ? body.analysis : (body?.result !== undefined ? body.result : existing.analysis_json),
        sourceType: body?.sourceType !== undefined ? body.sourceType : existing.source_type,
        sourceUrl: body?.sourceUrl !== undefined ? body.sourceUrl : existing.source_url
    };
    const parsed = normalizeArticleDocument(merged, { requireId: true });
    if (!parsed.ok) {
        const status = parsed.error === ARTICLE_ERRORS.bodyTooLarge ? 413 : 400;
        return errorJson(parsed.error, status, env, request, parsed.limit ? { limit: parsed.limit } : undefined);
    }
    const usage = await readUsage(env, userId);
    const quota = checkQuota({ usage, nextSize: parsed.size, currentRow: existing, isCreate: false });
    if (!quota.ok) {
        const status = quota.error === ARTICLE_ERRORS.quotaExceeded ? 409 : 413;
        return errorJson(quota.error, status, env, request, { limit: quota.limit, totalBytes: quota.totalBytes });
    }

    const updatedAt = nowIso();
    const nextRevision = expected + 1;
    const results = await env.DB.batch([
        env.DB
            .prepare('UPDATE articles SET title = ?, body = ?, analysis_json = ?, source_type = ?, source_url = ?, revision = ?, updated_at = ?, size_bytes = ?, last_mutation_id = ? '
                + 'WHERE owner_user_id = ? AND id = ? AND revision = ? AND deleted_at IS NULL')
            .bind(
                parsed.document.title,
                parsed.document.body,
                parsed.document.analysis === null ? null : JSON.stringify(parsed.document.analysis),
                parsed.document.sourceType,
                parsed.document.sourceUrl || null,
                nextRevision,
                updatedAt,
                parsed.size,
                mutationId || null,
                userId,
                articleId,
                expected
            ),
        ...writeStatements(env, { userId, changes: [{ articleId, op: 'upsert', revision: nextRevision, updatedAt }] }),
        ...advanceStatements(env, { userId, changes: [{ articleId, revision: nextRevision, updatedAt }] })
    ]);
    const changed = Number(results?.[0]?.meta?.changes ?? results?.[0]?.changes ?? 0);
    if (!changed) {
        const row = await readRow(env, userId, articleId);
        if (!row) return errorJson(ARTICLE_ERRORS.notFound, 404, env, request);
        return json(conflictPayload(row), 409, env, request);
    }
    const row = await readRow(env, userId, articleId);
    return respondDoc(env, request, row, 200, { updated: true });
}

async function handleDelete({ request, env, user, articleId }) {
    const userId = user.user_id;
    let body = {};
    try {
        body = await readJsonBody(request, 8 * 1024);
    } catch (_) {
        body = {};
    }
    const existing = await readRow(env, userId, articleId);
    if (!existing) return errorJson(ARTICLE_ERRORS.notFound, 404, env, request);
    const mutationId = normalizeMutationId(body?.clientMutationId);
    if (mutationId && existing.last_mutation_id === mutationId) {
        return respondDoc(env, request, existing, 200, { deleted: true, idempotent: true });
    }
    const expected = parseExpectedRevision(body?.expectedRevision);
    if (expected === null) return errorJson(ARTICLE_ERRORS.revisionRequired, 400, env, request);
    if (existing.deleted_at) {
        return respondDoc(env, request, existing, 200, { deleted: true, idempotent: true });
    }
    if (expected !== Number(existing.revision)) return json(conflictPayload(existing), 409, env, request);

    const updatedAt = nowIso();
    const nextRevision = expected + 1;
    const results = await env.DB.batch([
        env.DB
            .prepare('UPDATE articles SET deleted_at = ?, revision = ?, updated_at = ?, last_mutation_id = ? '
                + 'WHERE owner_user_id = ? AND id = ? AND revision = ? AND deleted_at IS NULL')
            .bind(updatedAt, nextRevision, updatedAt, mutationId || null, userId, articleId, expected),
        ...writeStatements(env, { userId, changes: [{ articleId, op: 'delete', revision: nextRevision, updatedAt }] }),
        ...advanceStatements(env, { userId, changes: [{ articleId, revision: nextRevision, updatedAt }] })
    ]);
    const changed = Number(results?.[0]?.meta?.changes ?? results?.[0]?.changes ?? 0);
    if (!changed) {
        const row = await readRow(env, userId, articleId);
        if (!row) return errorJson(ARTICLE_ERRORS.notFound, 404, env, request);
        return json(conflictPayload(row), 409, env, request);
    }
    const row = await readRow(env, userId, articleId);
    return respondDoc(env, request, row, 200, { deleted: true });
}

async function handleRestore({ request, env, user, articleId }) {
    const userId = user.user_id;
    const body = await readJsonBody(request, 8 * 1024);
    const existing = await readRow(env, userId, articleId);
    if (!existing) return errorJson(ARTICLE_ERRORS.notFound, 404, env, request);
    const mutationId = normalizeMutationId(body?.clientMutationId);
    if (mutationId && existing.last_mutation_id === mutationId) {
        return respondDoc(env, request, existing, 200, { restored: true, idempotent: true });
    }
    const expected = parseExpectedRevision(body?.expectedRevision);
    if (expected === null) return errorJson(ARTICLE_ERRORS.revisionRequired, 400, env, request);
    if (!existing.deleted_at) {
        if (expected === Number(existing.revision)) {
            return respondDoc(env, request, existing, 200, { restored: true, idempotent: true });
        }
        return errorJson(ARTICLE_ERRORS.notDeleted, 409, env, request, { current: toArticleMeta(existing) });
    }
    if (expected !== Number(existing.revision)) return json(conflictPayload(existing), 409, env, request);

    const usage = await readUsage(env, userId);
    const quota = checkQuota({ usage, nextSize: Number(existing.size_bytes) || 0, isCreate: true });
    if (!quota.ok) {
        const status = quota.error === ARTICLE_ERRORS.countExceeded ? 409 : 413;
        return errorJson(quota.error, status, env, request, { limit: quota.limit, count: quota.count });
    }

    const updatedAt = nowIso();
    const nextRevision = expected + 1;
    const results = await env.DB.batch([
        env.DB
            .prepare('UPDATE articles SET deleted_at = NULL, revision = ?, updated_at = ?, last_mutation_id = ? '
                + 'WHERE owner_user_id = ? AND id = ? AND revision = ? AND deleted_at IS NOT NULL')
            .bind(nextRevision, updatedAt, mutationId || null, userId, articleId, expected),
        ...writeStatements(env, { userId, changes: [{ articleId, op: 'restore', revision: nextRevision, updatedAt }] }),
        ...advanceStatements(env, { userId, changes: [{ articleId, revision: nextRevision, updatedAt }] })
    ]);
    const changed = Number(results?.[0]?.meta?.changes ?? results?.[0]?.changes ?? 0);
    if (!changed) {
        const row = await readRow(env, userId, articleId);
        if (!row) return errorJson(ARTICLE_ERRORS.notFound, 404, env, request);
        return json(conflictPayload(row), 409, env, request);
    }
    const row = await readRow(env, userId, articleId);
    return respondDoc(env, request, row, 200, { restored: true });
}

async function handleImport({ request, env, user }) {
    const userId = user.user_id;
    const body = await readJsonBody(request, ARTICLE_LIMITS.requestMaxBytes);
    const items = Array.isArray(body?.articles) ? body.articles : [];
    if (!items.length) {
        await ensureState(env, userId);
        // 空批次 + final 仍要開啟閘門：舊資料可能全在別台裝置匯入，這台只是補完。
        if (body?.final === true) {
            await env.DB
                .prepare('UPDATE article_state SET legacy_write_blocked = 1, migrated_at = COALESCE(migrated_at, ?), updated_at = ? WHERE owner_user_id = ?')
                .bind(nowIso(), nowIso(), userId)
                .run();
        }
        const empty = await ensureState(env, userId);
        return json({
            imported: 0,
            skipped: 0,
            invalid: 0,
            ids: [],
            cursor: empty.nextSeq - 1,
            legacyWriteBlocked: empty.legacyWriteBlocked
        }, 200, env, request);
    }
    if (items.length > ARTICLE_LIMITS.importMax) {
        return errorJson(ARTICLE_ERRORS.invalidBody, 400, env, request, { limit: ARTICLE_LIMITS.importMax });
    }
    await ensureState(env, userId);

    let imported = 0;
    let skipped = 0;
    let invalid = 0;
    const importedIds = [];
    let chunk = [];

    const flush = async () => {
        if (!chunk.length) return;
        await env.DB.batch(chunk);
        chunk = [];
    };

    for (const raw of items) {
        const legacyId = String(raw?.legacyId || raw?.id || '').slice(0, 160);
        const parsed = normalizeArticleDocument({ ...raw, id: legacyId });
        if (!parsed.ok) { invalid += 1; continue; }
        const articleId = isValidArticleId(legacyId) ? legacyId : generateArticleId();
        const existingById = await readRow(env, userId, articleId);
        const existingByLegacy = legacyId
            ? await env.DB
                .prepare('SELECT id FROM articles WHERE owner_user_id = ? AND legacy_article_id = ?')
                .bind(userId, legacyId)
                .first()
            : null;
        if (existingById || existingByLegacy) { skipped += 1; continue; }

        const usage = await readUsage(env, userId);
        const quota = checkQuota({ usage, nextSize: parsed.size, isCreate: true });
        if (!quota.ok) {
            // 超限不丟棄既有資料：停止匯入，回報已匯入的數量與原因，讓前端提示使用者。
            await flush();
            return errorJson(quota.error, 409, env, request, {
                limit: quota.limit,
                imported,
                skipped,
                invalid,
                ids: importedIds,
                message: 'quota'
            });
        }

        const updatedAt = nowIso();
        const document = { ...parsed.document, legacyArticleId: legacyId };
        chunk.push(insertStatement(env, { userId, document, size: parsed.size, articleId, mutationId: '', updatedAt }));
        chunk.push(...writeStatements(env, { userId, changes: [{ articleId, op: 'create', revision: 1, updatedAt }] }));
        chunk.push(...advanceStatements(env, { userId, changes: [{ articleId, revision: 1, updatedAt }] }));
        imported += 1;
        importedIds.push(articleId);
        if (chunk.length >= MAX_BATCH_ITEMS * 3) await flush();
    }
    await flush();

    if (body?.final === true) {
        await env.DB
            .prepare('UPDATE article_state SET legacy_write_blocked = 1, migrated_at = COALESCE(migrated_at, ?), updated_at = ? WHERE owner_user_id = ?')
            .bind(nowIso(), nowIso(), userId)
            .run();
    }
    const state = await ensureState(env, userId);
    return json({
        imported,
        skipped,
        invalid,
        ids: importedIds,
        cursor: state.nextSeq - 1,
        legacyWriteBlocked: state.legacyWriteBlocked
    }, 200, env, request);
}

