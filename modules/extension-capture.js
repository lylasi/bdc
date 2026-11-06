import { apiRequest, auth, captureAuthSession, isAuthSessionCurrent } from './sync-cloudflare.js';
import { createCaptureClient } from '../shared/capture-client.mjs';

let client;
export function getExtensionCaptureClient() {
    if (client) return client;
    const storage = globalThis.chrome?.storage?.local;
    client = createCaptureClient({
        storage: storage && {
            async get(keys) {
                await storage.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });
                return storage.get(keys);
            },
            set: (items) => storage.set(items),
            remove: (key) => storage.remove(key)
        },
        getSession: captureAuthSession,
        isSessionCurrent: isAuthSessionCurrent,
        request: (session, path, options) => apiRequest(path, options, { token: session.token, timeoutMs: 20000 }),
        onUnauthorized: (session) => isAuthSessionCurrent(session) ? auth.invalidateSession() : undefined
    });
    return client;
}
