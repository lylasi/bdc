import { validateCapture, captureFingerprint } from './capture-protocol.mjs';
import { isValidEntityId } from './reading-protocol.mjs';

const PREFIX = 'bdc_capture_outbox_v1:';
const error = (code, status = 0) => Object.assign(new Error(code), { code, status });
export const captureScopeKey = (session) => `${encodeURIComponent(session.endpoint || '')}:${encodeURIComponent(session.userId || '')}`;

/** Transport and storage adapters keep this exact implementation testable. */
export function createCaptureClient({ storage, getSession, isSessionCurrent, request, onUnauthorized = () => {}, randomUUID = () => crypto.randomUUID() }) {
    const sending = new Map();
    function assertSession(session) {
        if (!session?.loggedIn || !session.userId || !session.endpoint || !isSessionCurrent(session)) throw error('stale_session');
    }
    function assertStorage() {
        if (!storage?.get || !storage?.set || !storage?.remove) throw error('capture_storage_failed');
    }
    async function responseBody(response, session) {
        const body = await response.json().catch(() => null);
        if (response.status === 401 && isSessionCurrent(session)) await onUnauthorized(session);
        if (!response.ok) {
            const code = response.status === 404 || response.status === 405
                ? 'capture_server_update_required' : (typeof body?.code === 'string' ? body.code : 'capture_failed');
            // A capture target 404 is a business failure, not an old backend.
            throw error(body?.code === 'capture_target_missing' ? body.code : code, response.status);
        }
        return body;
    }
    async function pending(session = getSession()) {
        if (!session?.loggedIn) return [];
        assertStorage();
        const prefix = PREFIX + captureScopeKey(session) + ':';
        let all;
        try { all = await storage.get(null); }
        catch (_) { throw error('capture_storage_failed'); }
        const result = [];
        for (const [key, record] of Object.entries(all || {})) {
            if (!key.startsWith(prefix)) continue;
            try {
                if (record?.endpoint !== session.endpoint || record?.userId !== session.userId) throw error('capture_invalid_record');
                const payload = validateCapture(record.payload);
                if (key !== prefix + payload.requestId) throw error('capture_storage_failed');
                result.push({ key, endpoint: record.endpoint, userId: record.userId, payload, createdAt: typeof record.createdAt === 'string' ? record.createdAt : '' });
            } catch (_) {
                // Preserve malformed records visibly, while allowing healthy
                // operations to send. Only explicit cancellation removes them.
                const belongs = record?.endpoint === session.endpoint && record?.userId === session.userId;
                result.push({ key, endpoint: session.endpoint, userId: session.userId, invalid: true,
                    payload: { requestId: key.slice(prefix.length), word: belongs && typeof record?.payload?.word === 'string' ? record.payload.word.slice(0, 400) : '',
                        bookId: belongs && typeof record?.payload?.bookId === 'string' ? record.payload.bookId.slice(0, 160) : '' }, createdAt: '' });
            }
        }
        return result.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    }
    async function books(session = getSession()) {
        assertSession(session);
        const response = await request(session, '/vocabulary/books', { method: 'GET' });
        const body = await responseBody(response, session);
        assertSession(session);
        if (!Array.isArray(body?.books)) throw error('capture_invalid_response');
        const list = body.books.filter((book) => isValidEntityId(book?.id) && typeof book.name === 'string');
        return { books: list, defaultBookId: list.some((book) => book.id === body.defaultBookId) ? body.defaultBookId : '' };
    }
    async function enqueue(input, session = getSession()) {
        assertSession(session);
        assertStorage();
        const payload = validateCapture({ ...input, requestId: 'capture_' + randomUUID() });
        if ((await pending(session)).length >= 200) throw error('capture_outbox_full');
        assertSession(session);
        const key = PREFIX + captureScopeKey(session) + ':' + payload.requestId;
        const operation = { endpoint: session.endpoint, userId: session.userId, payload, createdAt: new Date().toISOString() };
        try { await storage.set({ [key]: operation }); }
        catch (_) { throw error('capture_storage_failed'); }
        return { ...operation, key };
    }
    async function send(operation, session = getSession()) {
        assertSession(session);
        if (operation.invalid) throw error('capture_invalid_record', 422);
        if (operation.endpoint !== session.endpoint || operation.userId !== session.userId) throw error('stale_session');
        assertStorage();
        if (sending.has(operation.key)) return sending.get(operation.key);
        const promise = (async () => {
            // Only operations that have already reached durable storage may send.
            const stored = (await storage.get(operation.key))?.[operation.key];
            if (!stored || stored.endpoint !== session.endpoint || stored.userId !== session.userId
                || captureFingerprint(stored.payload) !== captureFingerprint(operation.payload)) throw error('capture_storage_failed');
            assertSession(session);
            const response = await request(session, '/captures', { method: 'POST', body: JSON.stringify(operation.payload) });
            const receipt = await responseBody(response, session);
            if (receipt?.ok !== true || receipt.requestId !== operation.payload.requestId || receipt.bookId !== operation.payload.bookId
                || !isValidEntityId(receipt.entryId) || !(Number(receipt.revision) > 0)) throw error('capture_invalid_response');
            // The immutable key belongs to the captured account. A late receipt
            // can retire that account's operation without touching another scope.
            await storage.remove(operation.key);
            return receipt;
        })();
        sending.set(operation.key, promise);
        try { return await promise; }
        finally { sending.delete(operation.key); }
    }
    async function retry(session = getSession()) {
        assertSession(session);
        const results = [];
        for (const operation of await pending(session)) {
            if (!isSessionCurrent(session)) break;
            if (operation.invalid) { results.push({ operation, error: 'capture_invalid_record', status: 422 }); continue; }
            try { results.push({ operation, receipt: await send(operation, session) }); }
            catch (failure) {
                results.push({ operation, error: failure.code || 'capture_pending', status: failure.status || 0 });
                if (!failure.status || failure.status >= 500 || failure.status === 429 || failure.status === 401) break;
            }
        }
        return results;
    }
    async function cancel(operation, session = getSession()) {
        assertSession(session);
        if (operation.endpoint !== session.endpoint || operation.userId !== session.userId) throw error('stale_session');
        const prefix = PREFIX + captureScopeKey(session) + ':';
        if (!operation.key.startsWith(prefix) || (!operation.invalid && operation.key !== prefix + operation.payload?.requestId)) throw error('stale_session');
        assertStorage();
        const stored = (await storage.get(operation.key))?.[operation.key];
        if (stored && !operation.invalid && (stored.endpoint !== session.endpoint || stored.userId !== session.userId)) throw error('stale_session');
        assertSession(session);
        await storage.remove(operation.key);
    }
    return { books, pending, enqueue, send, retry, cancel };
}
