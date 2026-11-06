import { errorJson, json, readJsonBody } from './http.js';
import { ensureReadingState, readingRevisionStatements } from './reading.js';
import { findPageArticle, linkPageVocabularyBooks } from './page-links.js';
import { pageStableId, pageUrlKey } from '../../shared/page-protocol.mjs';
import { isValidEntityId } from '../../shared/reading-protocol.mjs';

const fail = (code, status = 400) => Object.assign(new Error(code), { code, status });

export async function defaultCaptureBook(env, userId, books) {
    const row = await env.DB.prepare('SELECT default_book_id FROM vocabulary_capture_settings WHERE owner_user_id = ?').bind(userId).first();
    return books.some((book) => book.id === row?.default_book_id) ? row.default_book_id : '';
}

async function createBook(env, userId, body) {
    const requestId = String(body?.requestId || '');
    const name = String(body?.name || '').trim();
    const kind = body?.kind === 'page' ? 'page' : 'custom';
    const sourceUrl = body?.sourceUrl ? pageUrlKey(body.sourceUrl) : '';
    if (!/^[A-Za-z0-9_:.-]{1,100}$/.test(requestId) || !name || name.length > 300
        || (body?.sourceUrl && !sourceUrl) || (kind === 'page' && !sourceUrl)) throw fail('capture_invalid_input');
    const makeDefault = body.makeDefault === true;
    const fingerprint = JSON.stringify({ operation: 'book', kind, name, sourceUrl, makeDefault });
    const bookId = await pageStableId('webbook', kind === 'page' ? sourceUrl : requestId);
    for (let attempt = 0; attempt < 4; attempt += 1) {
        const prior = await env.DB.prepare('SELECT fingerprint, result_json FROM vocabulary_captures WHERE owner_user_id = ? AND request_id = ?').bind(userId, requestId).first();
        if (prior) {
            if (prior.fingerprint !== fingerprint) throw fail('capture_request_mismatch', 409);
            const receipt = JSON.parse(prior.result_json);
            if (receipt.ok) return receipt;
            throw fail('capture_revision_conflict', 409);
        }
        let targetId = bookId;
        let existing = await env.DB.prepare('SELECT * FROM reading_entities WHERE owner_user_id = ? AND entity_type = ? AND entity_id = ?').bind(userId, 'vocabularyBook', targetId).first();
        if (kind === 'page') {
            const rows = await env.DB.prepare('SELECT * FROM reading_entities WHERE owner_user_id = ? AND entity_type = ? AND deleted_at IS NULL').bind(userId, 'vocabularyBook').all();
            const active = (rows.results || []).find((row) => pageUrlKey(JSON.parse(row.data_json || '{}').sourceUrl) === sourceUrl);
            if (active) existing = active;
            else if (existing?.deleted_at) {
                // A new, explicit create allocates a fresh book. Replaying the
                // old request still returns its old receipt without resurrection.
                for (let slot = 1; slot <= 100; slot += 1) {
                    targetId = bookId + '_' + slot;
                    const occupied = await env.DB.prepare('SELECT entity_id FROM reading_entities WHERE owner_user_id = ? AND entity_type = ? AND entity_id = ?').bind(userId, 'vocabularyBook', targetId).first();
                    if (!occupied) { existing = null; break; }
                }
            }
        }
        if (existing?.deleted_at) throw fail('capture_target_missing', 404);
        const id = existing?.entity_id || targetId;
        const article = sourceUrl ? await findPageArticle(env, userId, sourceUrl) : null;
        const timestamp = new Date().toISOString();
        const mutationId = `book:${requestId}`;
        const data = { name, sourceUrl, sourceType: article ? 'article' : 'manual', ...(article ? { articleId: article.id } : {}), createdAt: timestamp, updatedAt: timestamp };
        const receipt = { ok: true, requestId, bookId: id, created: !existing, revision: Number(existing?.revision || 1), defaultBookId: makeDefault ? id : '' };
        const claim = JSON.stringify({ claim: crypto.randomUUID() });
        const guardSql = 'SELECT 1 FROM vocabulary_captures WHERE owner_user_id = ? AND request_id = ? AND result_json = ?';
        const guardArgs = [userId, requestId, claim];
        await ensureReadingState(env, userId);
        const condition = existing
            ? 'EXISTS (SELECT 1 FROM reading_entities WHERE owner_user_id = ? AND entity_type = ? AND entity_id = ? AND revision = ? AND deleted_at IS NULL)'
            : 'NOT EXISTS (SELECT 1 FROM reading_entities WHERE owner_user_id = ? AND entity_type = ? AND entity_id = ?)';
        const args = [userId, 'vocabularyBook', id, ...(existing ? [Number(existing.revision)] : [])];
        const statements = [env.DB.prepare('INSERT INTO vocabulary_captures (owner_user_id, request_id, fingerprint, result_json, created_at) '
            + 'SELECT ?, ?, ?, ?, ? WHERE ' + condition + ' ON CONFLICT (owner_user_id, request_id) DO NOTHING')
            .bind(userId, requestId, fingerprint, claim, timestamp, ...args)];
        if (!existing) {
            statements.push(env.DB.prepare('INSERT INTO reading_entities (owner_user_id, entity_type, entity_id, revision, deleted_at, data_json, updated_at, last_mutation_id) '
                + 'SELECT ?, ?, ?, 1, NULL, ?, ?, ? WHERE EXISTS (' + guardSql + ')')
                .bind(userId, 'vocabularyBook', id, JSON.stringify(data), timestamp, mutationId, ...guardArgs));
            statements.push(...readingRevisionStatements(env, { userId, entityType: 'vocabularyBook', entityId: id, op: 'upsert', revision: 1, timestamp, mutationId, guardSql, guardArgs }));
        }
        if (makeDefault) statements.push(env.DB.prepare('INSERT INTO vocabulary_capture_settings (owner_user_id, default_book_id, updated_at) SELECT ?, ?, ? WHERE EXISTS (' + guardSql + ') '
            + 'ON CONFLICT (owner_user_id) DO UPDATE SET default_book_id = excluded.default_book_id, updated_at = excluded.updated_at')
            .bind(userId, id, timestamp, ...guardArgs));
        statements.push(env.DB.prepare('UPDATE vocabulary_captures SET result_json = ? WHERE owner_user_id = ? AND request_id = ? AND result_json = ?').bind(JSON.stringify(receipt), ...guardArgs));
        try { await env.DB.batch(statements); }
        catch (error) {
            const completed = await env.DB.prepare('SELECT result_json FROM vocabulary_captures WHERE owner_user_id = ? AND request_id = ?').bind(userId, requestId).first();
            if (!completed) {
                if (attempt < 3) continue;
                throw error;
            }
        }
        const completed = await env.DB.prepare('SELECT fingerprint, result_json FROM vocabulary_captures WHERE owner_user_id = ? AND request_id = ?').bind(userId, requestId).first();
        if (completed?.fingerprint === fingerprint) {
            const result = JSON.parse(completed.result_json);
            if (result.ok) return result;
        }
    }
    throw fail('capture_revision_conflict', 409);
}

export async function handleCaptureBookWrite({ request, env, url, user }) {
    try {
        if (!((url.pathname === '/vocabulary/books' && request.method === 'POST') || (url.pathname === '/vocabulary/default' && request.method === 'PUT') || (url.pathname === '/vocabulary/page-link' && request.method === 'POST'))) {
            return errorJson('method_not_allowed', 405, env, request);
        }
        const body = await readJsonBody(request, 16000);
        if (url.pathname === '/vocabulary/page-link') {
            const sourceUrl = pageUrlKey(body?.sourceUrl);
            if (!sourceUrl) throw fail('capture_invalid_input');
            const article = await findPageArticle(env, user.user_id, sourceUrl);
            if (!article) throw fail('article_not_found', 404);
            await linkPageVocabularyBooks(env, user.user_id, { id: article.id, sourceUrl: article.source_url });
            return json({ ok: true, articleId: article.id }, 200, env, request);
        }
        if (url.pathname === '/vocabulary/books' && request.method === 'POST') {
            const receipt = await createBook(env, user.user_id, body);
            if (body.sourceUrl) {
                const article = await findPageArticle(env, user.user_id, body.sourceUrl);
                if (article) await linkPageVocabularyBooks(env, user.user_id, { id: article.id, sourceUrl: article.source_url });
            }
            return json(receipt, 200, env, request);
        }
        if (url.pathname === '/vocabulary/default' && request.method === 'PUT') {
            const bookId = String(body?.bookId || '');
            if (!isValidEntityId(bookId)) throw fail('capture_invalid_input');
            const timestamp = new Date().toISOString();
            const result = await env.DB.prepare('INSERT INTO vocabulary_capture_settings (owner_user_id, default_book_id, updated_at) '
                + 'SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM reading_entities WHERE owner_user_id = ? AND entity_type = ? AND entity_id = ? AND deleted_at IS NULL) '
                + 'ON CONFLICT (owner_user_id) DO UPDATE SET default_book_id = excluded.default_book_id, updated_at = excluded.updated_at')
                .bind(user.user_id, bookId, timestamp, user.user_id, 'vocabularyBook', bookId).run();
            if (!(Number(result.meta?.changes ?? result.changes) > 0)) throw fail('capture_target_missing', 404);
            return json({ ok: true, defaultBookId: bookId }, 200, env, request);
        }
        return errorJson('method_not_allowed', 405, env, request);
    } catch (error) {
        return errorJson(error.code || 'capture_failed', error.status || 500, env, request);
    }
}
