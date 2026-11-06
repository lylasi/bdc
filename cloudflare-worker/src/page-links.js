import { pageUrlKey } from '../../shared/page-protocol.mjs';
import { readingRevisionStatements, ensureReadingState } from './reading.js';

export async function findPageArticle(env, userId, sourceUrl) {
    const key = pageUrlKey(sourceUrl);
    if (!key) return null;
    const rows = await env.DB.prepare('SELECT id, legacy_article_id, source_url, title FROM articles WHERE owner_user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC').bind(userId).all();
    const found = (rows.results || []).find((row) => pageUrlKey(row.source_url) === key);
    return found ? { ...found, id: found.legacy_article_id || found.id } : null;
}

// Called after a successful article create/update, including idempotent retries.
// Existing vocabulary content remains intact; revisions are guarded per book.
export async function linkPageVocabularyBooks(env, userId, article) {
    const key = pageUrlKey(article?.sourceUrl);
    if (!key || !article?.id || article.deletedAt) return;
    const rows = await env.DB.prepare('SELECT * FROM reading_entities WHERE owner_user_id = ? AND entity_type = ? AND deleted_at IS NULL').bind(userId, 'vocabularyBook').all();
    const books = (rows.results || []).filter((row) => {
        const book = JSON.parse(row.data_json || '{}');
        return pageUrlKey(book.sourceUrl) === key && book.articleId !== article.id;
    });
    if (!books.length) return;
    await ensureReadingState(env, userId);
    for (const row of books) {
        const previous = JSON.parse(row.data_json || '{}');
        if (previous.articleId) {
            const active = await env.DB.prepare('SELECT id FROM articles WHERE owner_user_id = ? AND (id = ? OR legacy_article_id = ?) AND deleted_at IS NULL').bind(userId, previous.articleId, previous.articleId).first();
            if (active) continue;
        }
        const revision = Number(row.revision) + 1;
        const timestamp = new Date().toISOString();
        const mutationId = `page-link:${article.id}:${row.entity_id}:${revision}`;
        const data = { ...previous, sourceType: 'article', articleId: article.id, updatedAt: timestamp };
        const guardSql = 'SELECT 1 FROM reading_entities WHERE owner_user_id = ? AND entity_type = ? AND entity_id = ? AND revision = ? AND last_mutation_id = ?';
        const guardArgs = [userId, 'vocabularyBook', row.entity_id, revision, mutationId];
        await env.DB.batch([
            env.DB.prepare('UPDATE reading_entities SET revision = ?, data_json = ?, updated_at = ?, last_mutation_id = ? WHERE owner_user_id = ? AND entity_type = ? AND entity_id = ? AND revision = ? AND deleted_at IS NULL '
                + 'AND EXISTS (SELECT 1 FROM articles WHERE owner_user_id = ? AND (id = ? OR legacy_article_id = ?) AND source_url = ? AND deleted_at IS NULL)')
                .bind(revision, JSON.stringify(data), timestamp, mutationId, userId, 'vocabularyBook', row.entity_id, Number(row.revision), userId, article.id, article.id, article.sourceUrl),
            ...readingRevisionStatements(env, { userId, entityType: 'vocabularyBook', entityId: row.entity_id, op: 'upsert', revision, timestamp, mutationId, guardSql, guardArgs })
        ]);
        const after = await env.DB.prepare('SELECT data_json, deleted_at FROM reading_entities WHERE owner_user_id = ? AND entity_type = ? AND entity_id = ?').bind(userId, 'vocabularyBook', row.entity_id).first();
        if (after && !after.deleted_at && !JSON.parse(after.data_json || '{}').articleId) {
            throw Object.assign(new Error('capture_revision_conflict'), { code: 'capture_revision_conflict', status: 409 });
        }
    }
}
