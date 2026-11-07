import { apiRequest, auth, captureAuthSession, isAuthSessionCurrent } from './sync-cloudflare.js';
import { createWorkspaceClient } from '../shared/workspace-client.mjs';
import { isValidArticleReference } from '../shared/article-protocol.mjs';

let client;
export function getExtensionWorkspaceClient() {
    if (!client) client = createWorkspaceClient({
        storage: chrome.storage.local,
        getSession: captureAuthSession,
        isSessionCurrent: isAuthSessionCurrent,
        request: async (session, path, options) => {
            if (!isAuthSessionCurrent(session)) throw Object.assign(new Error('stale_session'), { code: 'stale_session' });
            const response = await apiRequest(path, options, { token: session.token, timeoutMs: 30000 });
            if (response.status === 401 && isAuthSessionCurrent(session)) await auth.invalidateSession();
            return response;
        }
    });
    return client;
}
export async function setDefaultCaptureBook(bookId) {
    const session = captureAuthSession();
    if (!session.loggedIn) throw Object.assign(new Error('stale_session'), { code: 'stale_session' });
    const response = await apiRequest('/vocabulary/default', { method: 'PUT', body: JSON.stringify({ bookId }) }, { token: session.token });
    const data = await response.json();
    if (response.status === 401 && isAuthSessionCurrent(session)) await auth.invalidateSession();
    if (!isAuthSessionCurrent(session)) throw Object.assign(new Error('stale_session'), { code: 'stale_session' });
    if (!response.ok) throw Object.assign(new Error(data.code), { code: data.code, status: response.status });
    return data;
}

export async function findExistingPageArticle(sourceUrl, { link = false, signal, timeoutMs = 6000 } = {}) {
    const session = captureAuthSession();
    if (!session.loggedIn) throw Object.assign(new Error('stale_session'), { code: 'stale_session' });
    const request = async (path, options) => {
        if (!isAuthSessionCurrent(session)) throw Object.assign(new Error('stale_session'), { code: 'stale_session' });
        const response = await apiRequest(path, options, { token: session.token, signal, timeoutMs });
        const data = await response.json().catch(() => null);
        if (response.status === 401 && isAuthSessionCurrent(session)) await auth.invalidateSession();
        if (!isAuthSessionCurrent(session)) throw Object.assign(new Error('stale_session'), { code: 'stale_session' });
        if (!response.ok) {
            const code = data?.code || ([404, 405].includes(response.status) ? 'capture_server_update_required' : 'capture_failed');
            throw Object.assign(new Error(code), { code, status: response.status });
        }
        if (!data || typeof data !== 'object') throw Object.assign(new Error('capture_invalid_response'), { code: 'capture_invalid_response' });
        return data;
    };
    const data = await request('/vocabulary/books?sourceUrl=' + encodeURIComponent(sourceUrl), { method: 'GET' });
    if (!data.articleId) return '';
    if (!isValidArticleReference(data.articleId)) throw Object.assign(new Error('capture_invalid_response'), { code: 'capture_invalid_response' });
    if (!link) return data.articleId;
    let linked;
    try { linked = await request('/vocabulary/page-link', { method: 'POST', body: JSON.stringify({ sourceUrl }) }); }
    catch (error) {
        // An article can be deleted between the lookup and linking requests.
        if (error.status === 404 && error.code === 'article_not_found') return '';
        throw error;
    }
    if (!linked.ok || !isValidArticleReference(linked.articleId)) throw Object.assign(new Error('capture_invalid_response'), { code: 'capture_invalid_response' });
    return linked.articleId;
}
