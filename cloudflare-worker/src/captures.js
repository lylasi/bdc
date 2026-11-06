import { errorJson, json, readJsonBody, rateLimit } from './http.js';
import { ensureReadingState, readingRevisionStatements } from './reading.js';
import { normalizeReadingPatch, patchSize, READING_LIMITS } from '../../shared/reading-protocol.mjs';
import { CAPTURE_MAX_BYTES, captureFingerprint, validateCapture } from '../../shared/capture-protocol.mjs';
import { MAX_VOCABULARY_SOURCES, normalizeVocabularyWordKey, vocabularySourceKey } from '../../shared/vocabulary-source.mjs';

const failure = (code, status = 409) => Object.assign(new Error(code), { code, status });

function parseRow(row) {
    if (!row) return null;
    return { ...JSON.parse(row.data_json || '{}'), id: row.entity_id, revision: Number(row.revision), deletedAt: row.deleted_at || '' };
}

async function readEntity(env, userId, type, id) {
    return env.DB.prepare('SELECT * FROM reading_entities WHERE owner_user_id = ? AND entity_type = ? AND entity_id = ?')
        .bind(userId, type, id).first();
}

async function readReceipt(env, userId, requestId, fingerprint) {
    const row = await env.DB.prepare('SELECT fingerprint, result_json FROM vocabulary_captures WHERE owner_user_id = ? AND request_id = ?')
        .bind(userId, requestId).first();
    if (!row) return null;
    if (row.fingerprint !== fingerprint) throw failure('capture_request_mismatch');
    const receipt = JSON.parse(row.result_json);
    if (!receipt.ok) throw failure('capture_revision_conflict');
    return receipt;
}

async function stableEntryId(bookId, wordKey) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${bookId}\u0000${wordKey}`));
    return 'capture_' + Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 48);
}

async function listBooks(env, userId) {
    const result = await env.DB.prepare('SELECT * FROM reading_entities WHERE owner_user_id = ? AND entity_type = ? AND deleted_at IS NULL ORDER BY entity_id')
        .bind(userId, 'vocabularyBook').all();
    const books = (result.results || []).map((row) => {
        const book = parseRow(row);
        return { id: book.id, name: book.name || '', revision: book.revision };
    });
    // The account model has no explicit default-book setting. Require the
    // first choice and let the extension remember that page's selection.
    return { books, defaultBookId: '' };
}

async function captureWord(env, userId, capture) {
    const fingerprint = captureFingerprint(capture);
    const wordKey = normalizeVocabularyWordKey(capture.word);
    const generatedId = await stableEntryId(capture.bookId, wordKey);
    for (let attempt = 0; attempt < 4; attempt += 1) {
        // Replays return their original receipt even after a later deletion/edit.
        const prior = await readReceipt(env, userId, capture.requestId, fingerprint);
        if (prior) return prior;
        const bookRow = await readEntity(env, userId, 'vocabularyBook', capture.bookId);
        if (!bookRow || bookRow.deleted_at) throw failure('capture_target_missing', 404);
        const rows = await env.DB.prepare('SELECT * FROM reading_entities WHERE owner_user_id = ? AND entity_type = ? AND deleted_at IS NULL ORDER BY entity_id')
            .bind(userId, 'vocabularyEntry').all();
        let row = (rows.results || []).find((item) => {
            const entry = parseRow(item);
            return entry.bookId === capture.bookId && normalizeVocabularyWordKey(entry.word) === wordKey;
        });
        if (!row) {
            // An entry may have been moved or renamed by the website. A hash ID
            // is an allocation hint, never permission to replace that identity.
            for (let slot = 0; slot < 10; slot += 1) {
                const candidateId = slot ? `${generatedId}_${slot}` : generatedId;
                const candidate = await readEntity(env, userId, 'vocabularyEntry', candidateId);
                const record = parseRow(candidate);
                if (!candidate || (record.bookId === capture.bookId && normalizeVocabularyWordKey(record.word) === wordKey)) {
                    row = candidate || { entity_id: candidateId, revision: 0, allocating: true };
                    break;
                }
            }
            if (!row) throw failure('capture_revision_conflict');
        }
        const allocatingId = row.allocating ? row.entity_id : '';
        if (row.allocating) row = null;
        const existing = row && !row.deleted_at ? parseRow(row) : null;
        const entryId = row?.entity_id || allocatingId || generatedId;
        const revision = Number(row?.revision || 0);
        const timestamp = new Date().toISOString();
        const sources = existing && Array.isArray(existing.sources) ? [...existing.sources] : [];
        const source = capture.source && (capture.source.sourceUrl || capture.source.sentence || capture.source.context)
            ? { ...capture.source, addedAt: timestamp } : null;
        const sourceAdded = !!source && !sources.some((item) => vocabularySourceKey(item) === vocabularySourceKey(source));
        if (sourceAdded && sources.length >= MAX_VOCABULARY_SOURCES) throw failure('capture_sources_full', 422);
        if (sourceAdded) sources.push(source);
        const patch = normalizeReadingPatch('vocabularyEntry', {
            ...(existing || {}), bookId: capture.bookId,
            word: existing?.word || capture.word,
            meaning: existing?.meaning || capture.meaning,
            phonetic: existing?.phonetic || capture.phonetic,
            pos: existing?.pos || capture.pos,
            examples: existing?.examples || [], sources,
            source: existing?.source || 'extension',
            context: existing?.context || capture.source?.sentence || '',
            addedAt: existing?.addedAt || timestamp,
            createdAt: existing?.createdAt || timestamp,
            updatedAt: existing?.updatedAt || timestamp
        });
        const changed = !existing || sourceAdded || ['meaning', 'phonetic', 'pos'].some((key) => patch[key] !== (existing[key] || ''));
        if (patchSize(patch) > READING_LIMITS.maxPatchBytes) throw failure('capture_entry_too_large', 422);
        const nextRevision = changed ? revision + 1 : revision;
        if (changed) patch.updatedAt = timestamp;
        const receipt = { ok: true, requestId: capture.requestId, bookId: capture.bookId, entryId, revision: nextRevision, duplicate: !!existing, sourceAdded };
        const claimJson = JSON.stringify({ claim: crypto.randomUUID() });
        const guardSql = 'SELECT 1 FROM vocabulary_captures WHERE owner_user_id = ? AND request_id = ? AND result_json = ?';
        const guardArgs = [userId, capture.requestId, claimJson];
        const condition = 'EXISTS (SELECT 1 FROM reading_entities WHERE owner_user_id = ? AND entity_type = ? AND entity_id = ? AND revision = ? AND deleted_at IS NULL)';
        const entryCondition = row
            ? 'EXISTS (SELECT 1 FROM reading_entities WHERE owner_user_id = ? AND entity_type = ? AND entity_id = ? AND revision = ?)'
            : 'NOT EXISTS (SELECT 1 FROM reading_entities WHERE owner_user_id = ? AND entity_type = ? AND entity_id = ?)';
        const entryArgs = [userId, 'vocabularyEntry', entryId, ...(row ? [revision] : [])];
        await ensureReadingState(env, userId);
        const statements = [env.DB.prepare('INSERT INTO vocabulary_captures (owner_user_id, request_id, fingerprint, result_json, created_at) '
            + 'SELECT ?, ?, ?, ?, ? WHERE ' + condition + ' AND ' + entryCondition
            + ' ON CONFLICT (owner_user_id, request_id) DO NOTHING')
            .bind(userId, capture.requestId, fingerprint, claimJson, timestamp, userId, 'vocabularyBook', capture.bookId, Number(bookRow.revision), ...entryArgs)];
        if (env.DB.driver === 'postgres') {
            // SQLite/D1 serializes the write batch. PostgreSQL needs explicit
            // row locks before checking revisions to keep the same boundary.
            const locks = [env.DB.prepare('SELECT 1 FROM reading_entities WHERE owner_user_id = ? AND entity_type = ? AND entity_id = ? FOR UPDATE')
                .bind(userId, 'vocabularyBook', capture.bookId)];
            if (row) locks.push(env.DB.prepare('SELECT 1 FROM reading_entities WHERE owner_user_id = ? AND entity_type = ? AND entity_id = ? FOR UPDATE')
                .bind(userId, 'vocabularyEntry', entryId));
            statements.unshift(...locks);
        }
        if (changed) {
            const mutationId = `capture:${capture.requestId}`;
            if (row) {
                statements.push(env.DB.prepare('UPDATE reading_entities SET revision = ?, deleted_at = NULL, data_json = ?, updated_at = ?, last_mutation_id = ? '
                    + 'WHERE owner_user_id = ? AND entity_type = ? AND entity_id = ? AND revision = ? AND EXISTS (' + guardSql + ')')
                    .bind(nextRevision, JSON.stringify(patch), timestamp, mutationId, userId, 'vocabularyEntry', entryId, revision, ...guardArgs));
            } else {
                statements.push(env.DB.prepare('INSERT INTO reading_entities (owner_user_id, entity_type, entity_id, revision, deleted_at, data_json, updated_at, last_mutation_id) '
                    + 'SELECT ?, ?, ?, ?, NULL, ?, ?, ? WHERE EXISTS (' + guardSql + ')')
                    .bind(userId, 'vocabularyEntry', entryId, nextRevision, JSON.stringify(patch), timestamp, mutationId, ...guardArgs));
            }
            statements.push(...readingRevisionStatements(env, {
                userId, entityType: 'vocabularyEntry', entityId: entryId, op: 'upsert', revision: nextRevision,
                timestamp, mutationId, guardSql, guardArgs
            }));
        }
        statements.push(env.DB.prepare('UPDATE vocabulary_captures SET result_json = ? WHERE owner_user_id = ? AND request_id = ? AND result_json = ?')
            .bind(JSON.stringify(receipt), ...guardArgs));
        try {
            await env.DB.batch(statements);
        } catch (error) {
            const completed = await readReceipt(env, userId, capture.requestId, fingerprint);
            if (completed) return completed;
            // A database/trigger failure is surfaced; never acknowledge partial work.
            throw error;
        }
        const completed = await readReceipt(env, userId, capture.requestId, fingerprint);
        if (completed) return completed;
        // Another request edited/deleted the target between read and transaction.
    }
    throw failure('capture_revision_conflict');
}

export async function handleVocabularyCaptureRoute({ request, env, url, user }) {
    try {
        if (url.pathname === '/vocabulary/books' && request.method === 'GET') {
            return json(await listBooks(env, user.user_id), 200, env, request);
        }
        if (url.pathname === '/captures/capabilities' && request.method === 'GET') {
            return json({ captureVersion: 1, maxSources: MAX_VOCABULARY_SOURCES }, 200, env, request);
        }
        if (url.pathname === '/captures' && request.method === 'POST') {
            const limit = rateLimit(`captures:${user.user_id}`, 120, 60 * 1000);
            if (!limit.ok) return errorJson('rate_limited', 429, env, request);
            const capture = validateCapture(await readJsonBody(request, CAPTURE_MAX_BYTES));
            return json(await captureWord(env, user.user_id, capture), 200, env, request);
        }
        return errorJson('method_not_allowed', 405, env, request);
    } catch (error) {
        if (error.status || error.code === 'bad_json' || error.code === 'payload_too_large') {
            return errorJson(error.code, error.status || 400, env, request);
        }
        return errorJson('capture_failed', 500, env, request);
    }
}
