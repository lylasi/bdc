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
    toArticleDocument,
    toArticleMeta
} from '../../shared/article-protocol.mjs';

const MAX_BATCH_ITEMS = 8; // 每批 SQL 語句數（每篇 3 條），避免單次 batch 過大
// D1 單一查詢的 bound parameter 上限為 100：owner_user_id 固定佔 1 個，
// 其餘留給 IN (...) 清單。selfhost（SQLite／PostgreSQL）的上限遠高於此值。
const MAX_QUERY_IDS = 90;
// 匯入批次遇到其他請求先插入時，重新讀取既有 ID 後重試的次數上限。
const MAX_IMPORT_ATTEMPTS = 4;

function nowIso() {
    return new Date().toISOString();
}

function stateFromRow(row) {
    return {
        nextSeq: Number(row?.next_seq || 1),
        legacyWriteBlocked: Number(row?.legacy_write_blocked || 0) === 1,
        migratedAt: row?.migrated_at || '',
        prunedBefore: Number(row?.pruned_before || 0)
    };
}

async function ensureState(env, userId) {
    const readRow = () => env.DB
        .prepare('SELECT next_seq, legacy_write_blocked, migrated_at, pruned_before FROM article_state WHERE owner_user_id = ?')
        .bind(userId)
        .first();
    // 狀態列已存在時只讀一次，不再每次請求都做 upsert；寫入路徑的並行
    // 序列化由 quotaLockStatements() 的明確列鎖負責，不依賴 upsert 偶然
    // 擋住別的交易。
    const existing = await readRow();
    if (existing) return stateFromRow(existing);
    await env.DB
        .prepare('INSERT INTO article_state (owner_user_id, next_seq, legacy_write_blocked, updated_at) VALUES (?, 1, 0, ?) ON CONFLICT (owner_user_id) DO NOTHING')
        .bind(userId, nowIso())
        .run();
    return stateFromRow(await readRow());
}

export async function isLegacyArticleWriteBlocked(env, userId) {
    const row = await env.DB
        .prepare('SELECT legacy_write_blocked FROM article_state WHERE owner_user_id = ?')
        .bind(userId)
        .first();
    return Number(row?.legacy_write_blocked || 0) === 1;
}

/** 閘門開啟會改變 GET /snapshot 的有效內容，因此在同一交易推進版本。 */
function bumpSnapshotVersionStatement(env, userId, updatedAt) {
    return env.DB
        .prepare('UPDATE snapshots SET version = version + 1, updated_at = ? WHERE user_id = ?')
        .bind(updatedAt, userId);
}

async function readRow(env, userId, articleId) {
    return env.DB
        .prepare('SELECT * FROM articles WHERE owner_user_id = ? AND id = ?')
        .bind(userId, articleId)
        .first();
}

/** 集合讀取（分批 IN）：避免 /batch 逐篇等待資料庫往返。 */
async function readRowsByIds(env, userId, ids) {
    const rows = [];
    for (let index = 0; index < ids.length; index += MAX_QUERY_IDS) {
        const chunk = ids.slice(index, index + MAX_QUERY_IDS);
        const placeholders = chunk.map(() => '?').join(', ');
        const result = await env.DB
            .prepare(`SELECT * FROM articles WHERE owner_user_id = ? AND id IN (${placeholders})`)
            .bind(userId, ...chunk)
            .all();
        const list = result?.results;
        if (Array.isArray(list)) rows.push(...list);
    }
    return rows;
}

async function readExistingIds(env, userId, ids) {
    const found = new Set();
    for (let index = 0; index < ids.length; index += MAX_QUERY_IDS) {
        const chunk = ids.slice(index, index + MAX_QUERY_IDS);
        const placeholders = chunk.map(() => '?').join(', ');
        const result = await env.DB
            .prepare(`SELECT id FROM articles WHERE owner_user_id = ? AND id IN (${placeholders})`)
            .bind(userId, ...chunk)
            .all();
        for (const row of result?.results || []) found.add(String(row.id));
    }
    return found;
}

async function readExistingLegacyIds(env, userId, legacyIds) {
    const found = new Set();
    for (let index = 0; index < legacyIds.length; index += MAX_QUERY_IDS) {
        const chunk = legacyIds.slice(index, index + MAX_QUERY_IDS);
        const placeholders = chunk.map(() => '?').join(', ');
        const result = await env.DB
            .prepare(`SELECT legacy_article_id FROM articles WHERE owner_user_id = ? AND legacy_article_id IN (${placeholders})`)
            .bind(userId, ...chunk)
            .all();
        for (const row of result?.results || []) {
            if (row.legacy_article_id) found.add(String(row.legacy_article_id));
        }
    }
    return found;
}

/**
 * 配額交易的鎖：SQLite／D1 的寫入本身會序列化，INSERT／UPDATE 內的子查詢
 * 看到的是已提交資料；PostgreSQL 預設的 READ COMMITTED 不會讓兩個交易
 * 互相等待，必須先鎖住該使用者的 article_state 列，配額讀取與寫入才會
 * 依序看到對方已提交的結果（只鎖同一列，不會互相死結）。
 */
function quotaLockStatements(env, userId) {
    if (!env || !env.DB || env.DB.driver !== 'postgres') return [];
    return [env.DB.prepare('SELECT 1 FROM article_state WHERE owner_user_id = ? FOR UPDATE').bind(userId)];
}

/** 用量統計用 SQL 聚合，不再把整張表的 size_bytes 拉回應用層。
 * 匯入與每次建立／更新都會呼叫，文章量大時省下可觀的傳輸與解析。
 */
async function readUsage(env, userId) {
    const row = await env.DB
        .prepare('SELECT COUNT(*) AS article_count, COALESCE(SUM(size_bytes), 0) AS total_bytes '
            + 'FROM articles WHERE owner_user_id = ? AND deleted_at IS NULL')
        .bind(userId)
        .first();
    return {
        count: Number(row?.article_count) || 0,
        totalBytes: Number(row?.total_bytes) || 0
    };
}

// 三條語句一組：文章寫入 + 變更記錄 + 游標前進。三者在同一 batch（D1 交易）內，
// 因此「文章寫入成功但變更記錄沒寫」不會發生；條件不成立時三條都不生效。
function writeStatements(env, { userId, changes, matchToken = '' }) {
    const tokenClause = matchToken ? ' AND last_mutation_id = ?' : '';
    return changes.map((change) => {
        const statement = env.DB.prepare('INSERT INTO article_changes (owner_user_id, seq, article_id, op, revision, updated_at) '
            + 'SELECT owner_user_id, next_seq, ?, ?, ?, ? FROM article_state '
            + 'WHERE owner_user_id = ? AND EXISTS (SELECT 1 FROM articles WHERE owner_user_id = ? AND id = ? AND revision = ?'
            + tokenClause + ')');
        const args = [change.articleId, change.op, change.revision, change.updatedAt, userId, userId, change.articleId, change.revision];
        if (matchToken) args.push(matchToken);
        return statement.bind(...args);
    });
}

function advanceStatements(env, { userId, changes, matchToken = '' }) {
    const tokenClause = matchToken ? ' AND last_mutation_id = ?' : '';
    return changes.map((change) => {
        const statement = env.DB.prepare('UPDATE article_state SET next_seq = next_seq + 1, updated_at = ? '
            + 'WHERE owner_user_id = ? AND EXISTS (SELECT 1 FROM articles WHERE owner_user_id = ? AND id = ? AND revision = ?'
            + tokenClause + ')');
        const args = [change.updatedAt, userId, userId, change.articleId, change.revision];
        if (matchToken) args.push(matchToken);
        return statement.bind(...args);
    });
}

/**
 * 匯入用的原子配額檢查：插入與「當下已提交用量」在同一個 statement 內，
 * 並行請求不能只靠 JavaScript 讀到的舊用量就突破上限。條件不成立時
 * insert 影響 0 列，後續 change/advance 也因 EXISTS 不成立而不會前進。
 * `token` 寫進 last_mutation_id，讓 change／advance 只綁定這次真正插入的列。
 */
function insertQuotaStatement(env, { userId, document, size, articleId, updatedAt, token }) {
    return env.DB
        .prepare('INSERT INTO articles (owner_user_id, id, title, body, analysis_json, source_type, source_url, revision, created_at, updated_at, deleted_at, legacy_article_id, last_mutation_id, size_bytes) '
            + 'SELECT ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, ?, ?, ? '
            + 'WHERE (SELECT COUNT(*) FROM articles WHERE owner_user_id = ? AND deleted_at IS NULL) < ? '
            + 'AND (SELECT COALESCE(SUM(size_bytes), 0) FROM articles WHERE owner_user_id = ? AND deleted_at IS NULL) + ? <= ?')
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
            token,
            size,
            userId,
            ARTICLE_LIMITS.maxCount,
            userId,
            size,
            ARTICLE_LIMITS.maxUserBytes
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
        const unique = Array.from(new Set(ids)).slice(0, ARTICLE_LIMITS.batchMax);
        // 一次集合查詢取代逐篇 readRow；維持回應順序與原本行為一致。
        const rows = await readRowsByIds(env, userId, unique);
        const byId = new Map(rows.map((row) => [row.id, row]));
        const found = [];
        for (const id of unique) {
            const row = byId.get(id);
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
    // 單篇建立也走交易內原子配額：前置 checkQuota 只負責快速回錯誤，
    // 真正會不會超額由 INSERT … SELECT 的條件決定（並行 import／create
    // 不能都拿著同一份舊用量通過）。
    const token = mutationId || `crt_${crypto.randomUUID()}`;
    const locks = quotaLockStatements(env, userId);
    let results;
    try {
        results = await env.DB.batch([
            ...locks,
            insertQuotaStatement(env, { userId, document, size: parsed.size, articleId, updatedAt, token }),
            ...writeStatements(env, { userId, matchToken: token, changes: [{ articleId, op: 'create', revision: 1, updatedAt }] }),
            ...advanceStatements(env, { userId, matchToken: token, changes: [{ articleId, revision: 1, updatedAt }] })
        ]);
    } catch (error) {
        // 併發建立同一 ID：重讀一次，若是同一個 mutation 就當成冪等成功。
        const row = await readRow(env, userId, articleId);
        if (row && mutationId && row.last_mutation_id === mutationId) {
            return respondDoc(env, request, row, 200, { created: false, idempotent: true });
        }
        throw error;
    }
    const inserted = Number(results?.[locks.length]?.meta?.changes ?? results?.[locks.length]?.changes ?? 0);
    if (!inserted) {
        const row = await readRow(env, userId, articleId);
        if (row) {
            if (mutationId && row.last_mutation_id === mutationId) {
                return respondDoc(env, request, row, 200, { created: false, idempotent: true });
            }
            return errorJson(ARTICLE_ERRORS.idExists, 409, env, request, { current: toArticleMeta(row) });
        }
        // 原子條件擋下且沒有這篇：一定是另一個請求已提交了容量。
        const usageNow = await readUsage(env, userId);
        const quotaNow = checkQuota({ usage: usageNow, nextSize: parsed.size, isCreate: true });
        return errorJson(quotaNow.ok ? ARTICLE_ERRORS.countExceeded : quotaNow.error, 409, env, request, {
            limit: quotaNow.limit,
            count: quotaNow.count,
            totalBytes: quotaNow.totalBytes
        });
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
    await ensureState(env, userId);
    // 更新的配額條件必須在 UPDATE 內用「已提交的其他人文章＋本篇新大小」計算；
    // 否則並行 import 可以在讀完用量後先插入，本篇再以舊用量通過。
    const token = mutationId || `upd_${crypto.randomUUID()}`;
    const locks = quotaLockStatements(env, userId);
    const results = await env.DB.batch([
        ...locks,
        env.DB
            .prepare('UPDATE articles SET title = ?, body = ?, analysis_json = ?, source_type = ?, source_url = ?, revision = ?, updated_at = ?, size_bytes = ?, last_mutation_id = ? '
                + 'WHERE owner_user_id = ? AND id = ? AND revision = ? AND deleted_at IS NULL '
                + 'AND (SELECT COALESCE(SUM(size_bytes), 0) FROM articles WHERE owner_user_id = ? AND deleted_at IS NULL AND id <> ?) + ? <= ?')
            .bind(
                parsed.document.title,
                parsed.document.body,
                parsed.document.analysis === null ? null : JSON.stringify(parsed.document.analysis),
                parsed.document.sourceType,
                parsed.document.sourceUrl || null,
                nextRevision,
                updatedAt,
                parsed.size,
                token,
                userId,
                articleId,
                expected,
                userId,
                articleId,
                parsed.size,
                ARTICLE_LIMITS.maxUserBytes
            ),
        ...writeStatements(env, { userId, matchToken: token, changes: [{ articleId, op: 'upsert', revision: nextRevision, updatedAt }] }),
        ...advanceStatements(env, { userId, matchToken: token, changes: [{ articleId, revision: nextRevision, updatedAt }] })
    ]);
    const changed = Number(results?.[locks.length]?.meta?.changes ?? results?.[locks.length]?.changes ?? 0);
    if (!changed) {
        const row = await readRow(env, userId, articleId);
        if (!row) return errorJson(ARTICLE_ERRORS.notFound, 404, env, request);
        if (row.deleted_at || Number(row.revision) !== expected) return json(conflictPayload(row), 409, env, request);
        // revision 仍相符卻沒更新：只剩配額條件不成立。
        const usageNow = await readUsage(env, userId);
        const quotaNow = checkQuota({ usage: usageNow, nextSize: parsed.size, currentRow: row, isCreate: false });
        return errorJson(quotaNow.ok ? ARTICLE_ERRORS.quotaExceeded : quotaNow.error, 409, env, request, {
            limit: quotaNow.limit,
            totalBytes: quotaNow.totalBytes
        });
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
    await ensureState(env, userId);
    const token = mutationId || `del_${crypto.randomUUID()}`;
    const locks = quotaLockStatements(env, userId);
    const results = await env.DB.batch([
        ...locks,
        env.DB
            .prepare('UPDATE articles SET deleted_at = ?, revision = ?, updated_at = ?, last_mutation_id = ? '
                + 'WHERE owner_user_id = ? AND id = ? AND revision = ? AND deleted_at IS NULL')
            .bind(updatedAt, nextRevision, updatedAt, token, userId, articleId, expected),
        ...writeStatements(env, { userId, matchToken: token, changes: [{ articleId, op: 'delete', revision: nextRevision, updatedAt }] }),
        ...advanceStatements(env, { userId, matchToken: token, changes: [{ articleId, revision: nextRevision, updatedAt }] })
    ]);
    const changed = Number(results?.[locks.length]?.meta?.changes ?? results?.[locks.length]?.changes ?? 0);
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
    const size = Number(existing.size_bytes) || 0;
    await ensureState(env, userId);
    // 還原會讓文章重新计入用量，配額條件必須與 UPDATE 同一個 statement，
    // 否則並行的還原／匯入可以各自拿著舊用量通過。
    const token = mutationId || `rst_${crypto.randomUUID()}`;
    const locks = quotaLockStatements(env, userId);
    const results = await env.DB.batch([
        ...locks,
        env.DB
            .prepare('UPDATE articles SET deleted_at = NULL, revision = ?, updated_at = ?, last_mutation_id = ? '
                + 'WHERE owner_user_id = ? AND id = ? AND revision = ? AND deleted_at IS NOT NULL '
                + 'AND (SELECT COUNT(*) FROM articles WHERE owner_user_id = ? AND deleted_at IS NULL) < ? '
                + 'AND (SELECT COALESCE(SUM(size_bytes), 0) FROM articles WHERE owner_user_id = ? AND deleted_at IS NULL) + ? <= ?')
            .bind(
                nextRevision,
                updatedAt,
                token,
                userId,
                articleId,
                expected,
                userId,
                ARTICLE_LIMITS.maxCount,
                userId,
                size,
                ARTICLE_LIMITS.maxUserBytes
            ),
        ...writeStatements(env, { userId, matchToken: token, changes: [{ articleId, op: 'restore', revision: nextRevision, updatedAt }] }),
        ...advanceStatements(env, { userId, matchToken: token, changes: [{ articleId, revision: nextRevision, updatedAt }] })
    ]);
    const changed = Number(results?.[locks.length]?.meta?.changes ?? results?.[locks.length]?.changes ?? 0);
    if (!changed) {
        const row = await readRow(env, userId, articleId);
        if (!row) return errorJson(ARTICLE_ERRORS.notFound, 404, env, request);
        if (!row.deleted_at || Number(row.revision) !== expected) return json(conflictPayload(row), 409, env, request);
        // revision 仍相符卻沒還原：只剩配額條件不成立。
        const usageNow = await readUsage(env, userId);
        const quotaNow = checkQuota({ usage: usageNow, nextSize: size, isCreate: true });
        return errorJson(quotaNow.ok ? ARTICLE_ERRORS.countExceeded : quotaNow.error, 409, env, request, {
            limit: quotaNow.limit,
            count: quotaNow.count,
            totalBytes: quotaNow.totalBytes
        });
    }
    const row = await readRow(env, userId, articleId);
    return respondDoc(env, request, row, 200, { restored: true });
}

async function handleImport({ request, env, user }) {
    const userId = user.user_id;
    const body = await readJsonBody(request, ARTICLE_LIMITS.requestMaxBytes);
    const items = Array.isArray(body?.articles) ? body.articles : [];
    const initialState = await ensureState(env, userId);
    if (!items.length) {
        // 空批次 + final 仍要開啟閘門：舊資料可能全在別台裝置匯入，這台只是補完。
        if (body?.final === true) {
            const updatedAt = nowIso();
            const statements = [
                env.DB
                    .prepare('UPDATE article_state SET legacy_write_blocked = 1, migrated_at = COALESCE(migrated_at, ?), updated_at = ? WHERE owner_user_id = ?')
                    .bind(updatedAt, updatedAt, userId)
            ];
            // 閘門改變 GET /snapshot 的有效內容卻不會改變快照版本；同一個 batch
            // 原子推進版本，其他裝置用舊版本條件讀取時才會拿到更新後（已移除
            // 舊文章群組）的 payload，而不是 notModified。
            if (!initialState.legacyWriteBlocked) {
                statements.push(bumpSnapshotVersionStatement(env, userId, updatedAt));
            }
            await env.DB.batch(statements);
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

    let imported = 0;
    let skipped = 0;
    let invalid = 0;
    const importedIds = [];
    let chunk = [];

    const quotaResponse = (quota) => errorJson(quota.error, 409, env, request, {
        limit: quota.limit,
        count: quota.count,
        totalBytes: quota.totalBytes,
        imported,
        skipped,
        invalid,
        ids: importedIds,
        message: 'quota'
    });

    /**
     * 寫入目前累積的批次。若另一個請求在預讀後先插入相同 ID／legacy ID，
     * 整個 batch 會因唯一鍵衝突回滾；此時重新讀取既有 ID，過濾掉已由別人
     * 建立的項目再安全重試。不能只忽略 INSERT 衝突，否則 change log 與
     * imported/ids 會和實際寫入結果不一致。
     *
     * 用量也必須在重試前從已提交資料重算；INSERT 本身帶原子配額條件，
     * 即使另一個請求在重算後才提交，也不會突破上限。
     */
    const flush = async () => {
        if (!chunk.length) return { blocked: false };
        let entries = chunk;
        chunk = [];
        let attempt = 0;
        while (entries.length) {
            if (attempt > 0) {
                const retryIds = entries.map((entry) => entry.articleId);
                const retryLegacyIds = entries.map((entry) => entry.legacyId).filter(Boolean);
                const [nowIds, nowLegacyIds] = await Promise.all([
                    readExistingIds(env, userId, retryIds),
                    retryLegacyIds.length ? readExistingLegacyIds(env, userId, retryLegacyIds) : new Set()
                ]);
                const remaining = [];
                for (const entry of entries) {
                    if (nowIds.has(entry.articleId)
                        || (entry.legacyId && nowLegacyIds.has(entry.legacyId))) {
                        // 別的請求已先建立：保留它的內容，本請求只計 skipped。
                        skipped += 1;
                        existingIds.add(entry.articleId);
                        if (entry.legacyId) existingLegacyIds.add(entry.legacyId);
                    } else {
                        remaining.push(entry);
                    }
                }
                entries = remaining;
                // 這裡不能用原本的暫記用量，也不能只扣掉重複項目：另一個請求
                // 已提交的新增必須计入，否則後續會誤判還有容量。全部變成
                // 重複項目時也要重算，不能把被跳過項目的預占額度留下來。
                usage = await readUsage(env, userId);
                if (!entries.length) return { blocked: false };
            }
            const locks = quotaLockStatements(env, userId);
            const statements = [...locks];
            for (const entry of entries) {
                // 每次 insert 帶一個唯一 token；change/advance 必須比對同一
                // token，才不會在其他請求已建立同 ID 時替別人的文章記變更。
                if (!entry.importToken) entry.importToken = `imp_${crypto.randomUUID()}`;
                statements.push(insertQuotaStatement(env, {
                    userId,
                    document: entry.document,
                    size: entry.size,
                    articleId: entry.articleId,
                    updatedAt: entry.updatedAt,
                    token: entry.importToken
                }));
                statements.push(...writeStatements(env, {
                    userId,
                    matchToken: entry.importToken,
                    changes: [{ articleId: entry.articleId, op: 'create', revision: 1, updatedAt: entry.updatedAt }]
                }));
                statements.push(...advanceStatements(env, {
                    userId,
                    matchToken: entry.importToken,
                    changes: [{ articleId: entry.articleId, revision: 1, updatedAt: entry.updatedAt }]
                }));
            }
            let results;
            try {
                results = await env.DB.batch(statements);
            } catch (error) {
                attempt += 1;
                if (attempt >= MAX_IMPORT_ATTEMPTS) throw error;
                continue;
            }
            const inserted = [];
            const blocked = [];
            entries.forEach((entry, index) => {
                // 每篇 3 條語句：insert + change + advance（前面可能有配額鎖）；
                // 只有 insert 真的寫入時，後兩條才會因 token EXISTS 成立而生效。
                const changed = Number(results?.[locks.length + index * 3]?.meta?.changes ?? results?.[locks.length + index * 3]?.changes ?? 0);
                if (changed > 0) inserted.push(entry);
                else blocked.push(entry);
            });
            for (const entry of inserted) {
                imported += 1;
                importedIds.push(entry.articleId);
                existingIds.add(entry.articleId);
                if (entry.legacyId) existingLegacyIds.add(entry.legacyId);
            }
            if (attempt > 0) usage = await readUsage(env, userId);
            if (!blocked.length) return { blocked: false };
            // 被條件擋下的項目可能只是另一個請求先建立了同 ID。重新讀取後
            // 把重複項目計入 skipped，其餘才是真正撞到配額的項目。
            const blockedIds = blocked.map((entry) => entry.articleId);
            const blockedLegacyIds = blocked.map((entry) => entry.legacyId).filter(Boolean);
            const [nowIds, nowLegacyIds] = await Promise.all([
                readExistingIds(env, userId, blockedIds),
                blockedLegacyIds.length ? readExistingLegacyIds(env, userId, blockedLegacyIds) : new Set()
            ]);
            const quotaBlocked = [];
            for (const entry of blocked) {
                if (nowIds.has(entry.articleId) || (entry.legacyId && nowLegacyIds.has(entry.legacyId))) {
                    skipped += 1;
                    existingIds.add(entry.articleId);
                    if (entry.legacyId) existingLegacyIds.add(entry.legacyId);
                } else {
                    quotaBlocked.push(entry);
                }
            }
            if (!quotaBlocked.length) {
                // 被跳過的項目已計 skipped，但它們先前預占的容量必須清掉，
                // 後續新項目才能用真實用量判斷（否則合法項目會被誤拒）。
                usage = await readUsage(env, userId);
                return { blocked: false };
            }
            // 原子條件擋下代表實際用量已滿；用已提交資料算出正確錯誤碼。
            usage = await readUsage(env, userId);
            const quota = checkQuota({ usage, nextSize: quotaBlocked[0].size, isCreate: true });
            return {
                blocked: true,
                quota: quota.ok
                    ? { ok: false, error: ARTICLE_ERRORS.quotaExceeded, limit: ARTICLE_LIMITS.maxUserBytes, totalBytes: usage.totalBytes }
                    : quota
            };
        }
        return { blocked: false };
    };

    // 匯入前一次抓齊既有 ID 與用量：原本每篇各查 3 次，100 篇等於 300 次
    // 串行往返；這些查詢結果在本次請求內可直接增量維護。
    const legacyIds = items.map((raw) => String(raw?.legacyId || raw?.id || '').slice(0, 160));
    const candidateIds = Array.from(new Set(legacyIds.filter((id) => id && isValidArticleId(id))));
    const legacyCandidates = Array.from(new Set(legacyIds.filter(Boolean)));
    const [existingIds, existingLegacyIds] = await Promise.all([
        candidateIds.length ? readExistingIds(env, userId, candidateIds) : new Set(),
        legacyCandidates.length ? readExistingLegacyIds(env, userId, legacyCandidates) : new Set()
    ]);
    let usage = await readUsage(env, userId);

    for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
        const raw = items[itemIndex];
        const legacyId = legacyIds[itemIndex] || '';
        const parsed = normalizeArticleDocument({ ...raw, id: legacyId });
        if (!parsed.ok) { invalid += 1; continue; }
        const articleId = isValidArticleId(legacyId) ? legacyId : generateArticleId();
        if (existingIds.has(articleId) || (legacyId && existingLegacyIds.has(legacyId))) { skipped += 1; continue; }

        const quota = checkQuota({ usage, nextSize: parsed.size, isCreate: true });
        if (!quota.ok) {
            // 先送出目前批次：其中的重複項目可能已被另一個請求建立，flush 會
            // 跳過它們並釋放先前暫佔的容量。
            const flushed = await flush();
            if (flushed.blocked) return quotaResponse(flushed.quota);
            // flush 後用量可能大幅下降（例如 900-byte 的重複項目實際只佔
            // 1 byte）；不能拿 flush 前的檢查結果回 409，必須以最新用量重驗
            // 目前這篇，容量足夠就繼續匯入。
            usage = await readUsage(env, userId);
            const retried = checkQuota({ usage, nextSize: parsed.size, isCreate: true });
            if (!retried.ok) return quotaResponse(retried);
        }

        const updatedAt = nowIso();
        const document = { ...parsed.document, legacyArticleId: legacyId };
        chunk.push({ articleId, legacyId, document, size: parsed.size, updatedAt });
        existingIds.add(articleId);
        if (legacyId) existingLegacyIds.add(legacyId);
        usage = { count: (Number(usage.count) || 0) + 1, totalBytes: (Number(usage.totalBytes) || 0) + parsed.size };
        if (chunk.length >= MAX_BATCH_ITEMS) {
            const flushed = await flush();
            if (flushed.blocked) return quotaResponse(flushed.quota);
        }
    }
    const flushed = await flush();
    if (flushed.blocked) return quotaResponse(flushed.quota);

    if (body?.final === true) {
        const updatedAt = nowIso();
        const statements = [
            env.DB
                .prepare('UPDATE article_state SET legacy_write_blocked = 1, migrated_at = COALESCE(migrated_at, ?), updated_at = ? WHERE owner_user_id = ?')
                .bind(updatedAt, updatedAt, userId)
        ];
        if (!initialState.legacyWriteBlocked) {
            statements.push(bumpSnapshotVersionStatement(env, userId, updatedAt));
        }
        await env.DB.batch(statements);
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
