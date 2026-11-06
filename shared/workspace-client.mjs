import { captureScopeKey } from './capture-client.mjs';
import { pageStableId, pageUrlKey } from './page-protocol.mjs';
import { isValidEntityId } from './reading-protocol.mjs';
import { isValidArticleReference, normalizeArticleDocument } from './article-protocol.mjs';

const PREFIX = 'bdc_workspace_outbox_v1:';
const fail = (code, status = 0) => Object.assign(new Error(code), { code, status });
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export function createWorkspaceClient({ storage, getSession, isSessionCurrent, request }) {
    const sending = new Map();
    const assertSession = (session) => { if (!session?.loggedIn || !isSessionCurrent(session)) throw fail('stale_session'); };
    async function read(response) {
        const data = await response.json().catch(() => null);
        if (!response.ok) throw fail((response.status === 404 || response.status === 405) && !['article_not_found', 'capture_target_missing'].includes(data?.code)
            ? 'capture_server_update_required' : data?.code || 'capture_failed', response.status);
        return data;
    }
    async function pending(session = getSession()) {
        if (!session.loggedIn) return [];
        const prefix = PREFIX + captureScopeKey(session) + ':';
        return Object.entries(await storage.get(null)).filter(([key]) => key.startsWith(prefix)).map(([key, job]) => {
            if (!job || job.endpoint !== session.endpoint || job.userId !== session.userId || !['book', 'article'].includes(job.type)
                || key !== prefix + job.requestId || !job.payload || typeof job.payload !== 'object') {
                return { key, invalid: true, type: 'invalid', endpoint: session.endpoint, userId: session.userId, payload: {} };
            }
            return { ...job, key };
        }).sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || a.key.localeCompare(b.key));
    }
    async function enqueue(type, payload, session = getSession()) {
        assertSession(session);
        if (!['book', 'article'].includes(type)) throw fail('capture_invalid_input');
        if (type === 'article') {
            const parsed = normalizeArticleDocument(payload);
            if (!parsed.ok) throw fail(parsed.error, 422);
            if (!pageUrlKey(payload.sourceUrl)) throw fail('capture_invalid_input');
        }
        if ((await pending(session)).length >= 20) throw fail('capture_outbox_full');
        assertSession(session);
        const requestId = 'workspace_' + crypto.randomUUID();
        const key = PREFIX + captureScopeKey(session) + ':' + requestId;
        const job = { type, requestId, endpoint: session.endpoint, userId: session.userId, payload: structuredClone(payload), createdAt: new Date().toISOString() };
        try { await storage.set({ [key]: job }); }
        catch (_) { throw fail('capture_storage_failed'); }
        return { ...job, key };
    }
    async function send(job, session = getSession()) {
        assertSession(session);
        if (job.endpoint !== session.endpoint || job.userId !== session.userId) throw fail('stale_session');
        const prefix = PREFIX + captureScopeKey(session) + ':';
        if (job.key !== prefix + job.requestId || !['book', 'article'].includes(job.type)) throw fail('capture_invalid_record');
        if (sending.has(job.key)) return sending.get(job.key);
        const promise = (async () => {
            const stored = (await storage.get(job.key))[job.key];
            if (!stored || stored.endpoint !== session.endpoint || stored.userId !== session.userId || stored.requestId !== job.requestId
                || JSON.stringify(canonical(stored.payload)) !== JSON.stringify(canonical(job.payload)) || stored.type !== job.type) throw fail('capture_invalid_record');
            assertSession(session);
            let receipt;
            if (job.type === 'book') {
                receipt = await read(await request(session, '/vocabulary/books', { method: 'POST', body: JSON.stringify({ ...job.payload, requestId: job.requestId }) }));
                if (!receipt?.ok || receipt.requestId !== job.requestId || !isValidEntityId(receipt.bookId)) throw fail('capture_invalid_response');
            } else {
                const sourceUrl = pageUrlKey(job.payload.sourceUrl);
                if (!sourceUrl) throw fail('capture_invalid_input');
                const books = await read(await request(session, '/vocabulary/books?sourceUrl=' + encodeURIComponent(sourceUrl), { method: 'GET' }));
                assertSession(session);
                if (books.articleId) {
                    if (!isValidArticleReference(books.articleId)) throw fail('capture_invalid_response');
                    receipt = { ok: true, articleId: books.articleId, reused: true };
                }
                else {
                    const rootId = await pageStableId('webart', sourceUrl);
                    for (let slot = 0; slot <= 100; slot += 1) {
                        assertSession(session);
                        const id = rootId + (slot ? '_' + slot : '');
                        const response = await request(session, '/articles', { method: 'POST', body: JSON.stringify({ ...job.payload, id, clientMutationId: job.requestId }) });
                        const result = await response.json().catch(() => null);
                        if (response.ok && result?.article?.deletedAt) throw fail('capture_target_missing', 404);
                        if (response.ok && isValidArticleReference(result?.article?.id) && pageUrlKey(result.article.sourceUrl) === sourceUrl) {
                            receipt = { ok: true, articleId: result.article.id, reused: result.created === false }; break;
                        }
                        if (response.status === 409 && result?.code === 'article_id_exists' && result.current?.deletedAt) continue;
                        if (response.status === 409 && result?.code === 'article_id_exists' && isValidArticleReference(result.current?.id) && pageUrlKey(result.current?.sourceUrl) === sourceUrl) {
                            receipt = { ok: true, articleId: result.current.id, reused: true }; break;
                        }
                        throw fail(result?.code || 'capture_failed', response.status);
                    }
                    if (!receipt) throw fail('capture_revision_conflict', 409);
                }
                assertSession(session);
                const linked = await read(await request(session, '/vocabulary/page-link', { method: 'POST', body: JSON.stringify({ sourceUrl }) }));
                if (!linked?.ok || !isValidArticleReference(linked.articleId)) throw fail('capture_invalid_response');
            }
            await storage.remove(job.key);
            return receipt;
        })();
        sending.set(job.key, promise);
        try { return await promise; }
        finally { sending.delete(job.key); }
    }
    async function cancel(job, session = getSession()) {
        assertSession(session);
        if (job.endpoint !== session.endpoint || job.userId !== session.userId || !job.key.startsWith(PREFIX + captureScopeKey(session) + ':')) throw fail('stale_session');
        await storage.remove(job.key);
    }
    return { enqueue, pending, send, cancel, async retry(session = getSession()) {
        const results = [];
        for (const job of await pending(session)) {
            if (!isSessionCurrent(session)) break;
            if (job.invalid) { results.push({ job, error: 'capture_invalid_record' }); continue; }
            try { results.push({ job, receipt: await send(job, session) }); }
            catch (error) {
                results.push({ job, error: error.code });
                const localFailure = ['capture_invalid_record', 'capture_invalid_response', 'capture_invalid_input', 'invalid_article', 'article_too_large'].includes(error.code);
                if ((!error.status && !localFailure) || error.status >= 500 || error.status === 401 || error.status === 429) break;
            }
        }
        return results;
    } };
}
