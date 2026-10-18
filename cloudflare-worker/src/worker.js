// bdc-sync-api — Cloudflare Worker
//
// Responsibilities: passcode/device-pairing login, per-user learning snapshots,
// personal AI credentials, and the admin-managed default AI catalog. This
// Worker never proxies AI requests; browsers call providers directly.
//
// Routes:
//   OPTIONS *                                     CORS preflight
//   GET  /me                                      { user_id, label, role }
//   GET  /version                                 { version }
//   GET  /snapshot                                { version, updated_at, payload } | null
//   POST /snapshot                                CAS write (409 on conflict)
//   POST /pair                                    device pairing code → session token (no auth)
//   POST /reset-token                             recovery-code reset (no auth)
//   POST /change-token                            change own passcode
//   GET|PUT|DELETE /ai-credentials[/:id]          personal encrypted keys
//   GET  /ai-catalog                              published catalog (logged in)
//   GET  /ai-catalog/providers/:id/credential     shared key (logged in, current version)
//   GET  /admin/ai-catalog[/history]              admin view (no keys)
//   POST /admin/ai-catalog/publish                atomic catalog publish
//   GET  /admin/users                             admin user list (no hashes)
//   POST /admin/users                             admin creates a user (one-time secret)
//   PUT  /admin/users/:id                         admin edits label/email
//   POST /admin/users/:id/reset-passcode          admin resets a non-admin user
//   POST /admin/users/:id/pairing-code            admin issues a one-time pairing code
//
// Secrets (set with `wrangler secret put`): AI_CREDENTIAL_KEY_V1,
// AI_CATALOG_DIGEST_KEY. Plain vars: AI_CREDENTIAL_KEY_VERSION, ALLOWED_ORIGINS.

import {
  json,
  errorJson,
  plainResponse,
  isOriginAllowed,
  rateLimit,
  getClientKey
} from './http.js';
import { handleCredentialsRoute } from './ai-credentials.js';
import { handleCatalogRoute } from './ai-catalog.js';
import { handleAdminUsersRoute } from './admin-users.js';
import { handlePairRequest } from './device-pairing.js';
import { sanitizeSnapshotPayload } from './snapshot-sanitize.js';
import { sha256Hex } from './token.js';

const MIN_AI_PASSCODE_LENGTH = 32;
const SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;

function getBearerToken(request) {
  const h = request.headers.get('Authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

async function authenticate(request, env) {
  const token = getBearerToken(request);
  if (!token) return null;
  const hash = await sha256Hex(token);
  const row = await env.DB
    .prepare('SELECT user_id, label, role FROM users WHERE token_hash = ?')
    .bind(hash)
    .first();
  if (row) {
    return {
      ...row,
      role: row.role === 'admin' ? 'admin' : 'user',
      tokenLength: token.length,
      viaSession: false
    };
  }

  // Paired-device tokens live in user_sessions and expire independently of the
  // account passcode. Resetting the passcode deletes them.
  const session = await env.DB
    .prepare('SELECT u.user_id, u.label, u.role FROM user_sessions s JOIN users u ON u.user_id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?')
    .bind(hash, new Date().toISOString())
    .first();
  if (!session) return null;
  return {
    ...session,
    role: session.role === 'admin' ? 'admin' : 'user',
    tokenLength: token.length,
    viaSession: true
  };
}

async function setPasscodeAndRevoke(env, userId, newHash) {
  const statements = [
    env.DB.prepare('UPDATE users SET token_hash = ? WHERE user_id = ?').bind(newHash, userId),
    env.DB.prepare('DELETE FROM user_sessions WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM pairing_codes WHERE user_id = ? AND used_at IS NULL').bind(userId)
  ];
  if (typeof env.DB.batch === 'function') return env.DB.batch(statements);
  for (const statement of statements) await statement.run();
}

function requireStrongPasscode(user, request, env) {
  if (user && Number(user.tokenLength) >= MIN_AI_PASSCODE_LENGTH) return null;
  return errorJson('passcode_upgrade_required', 403, env, request, { requiredLength: MIN_AI_PASSCODE_LENGTH });
}

async function readJson(request, maxBytes) {
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (maxBytes && declared && declared > maxBytes) {
    const err = new Error('payload too large');
    err.code = 'payload_too_large';
    err.status = 413;
    throw err;
  }
  let text;
  try { text = await request.text(); } catch (_) {
    const err = new Error('bad body');
    err.code = 'bad_json';
    err.status = 400;
    throw err;
  }
  if (maxBytes && text.length > maxBytes) {
    const err = new Error('payload too large');
    err.code = 'payload_too_large';
    err.status = 413;
    throw err;
  }
  try { return JSON.parse(text || '{}'); } catch (_) {
    const err = new Error('bad json');
    err.code = 'bad_json';
    err.status = 400;
    throw err;
  }
}

async function handleResetToken(request, env) {
  const limit = rateLimit(`reset:${getClientKey(request, null)}`, 10, 10 * 60 * 1000);
  if (!limit.ok) {
    return json({ error: 'rate_limited', code: 'rate_limited' }, 429, env, request, { 'Retry-After': String(limit.retryAfter) });
  }
  let body;
  try { body = await readJson(request, 8 * 1024); } catch (error) {
    return errorJson(error.code || 'bad_json', error.status || 400, env, request);
  }
  const uid = String((body && body.user_id) || '').trim();
  const recovery = String((body && body.recovery_code) || '').trim();
  const newToken = String((body && body.new_token) || '').trim();
  if (!uid || !recovery || !newToken) return errorJson('missing_fields', 400, env, request);
  if (newToken.length < MIN_AI_PASSCODE_LENGTH) return errorJson('weak_passcode', 400, env, request);
  const row = await env.DB
    .prepare('SELECT recovery_hash FROM users WHERE user_id = ?')
    .bind(uid)
    .first();
  if (!row || !row.recovery_hash) return errorJson('no_recovery_set', 403, env, request);
  if (await sha256Hex(recovery) !== row.recovery_hash) return errorJson('invalid_recovery_code', 403, env, request);
  const newHash = await sha256Hex(newToken);
  await setPasscodeAndRevoke(env, uid, newHash);
  return json({ ok: true, user_id: uid }, 200, env, request);
}

async function handleChangeToken(request, env, user) {
  let body;
  try { body = await readJson(request, 8 * 1024); } catch (error) {
    return errorJson(error.code || 'bad_json', error.status || 400, env, request);
  }
  const newToken = String((body && body.new_token) || '').trim();
  if (!newToken) return errorJson('missing_new_token', 400, env, request);
  if (newToken.length < MIN_AI_PASSCODE_LENGTH) return errorJson('weak_passcode', 400, env, request);
  const newHash = await sha256Hex(newToken);
  await setPasscodeAndRevoke(env, user.user_id, newHash);
  return json({ ok: true }, 200, env, request);
}

async function handleSnapshot(request, env, user, path) {
  if (path === '/version' && request.method === 'GET') {
    const row = await env.DB
      .prepare('SELECT version FROM snapshots WHERE user_id = ?')
      .bind(user.user_id)
      .first();
    return json({ version: row ? row.version : 0 }, 200, env, request);
  }

  if (path === '/snapshot' && request.method === 'GET') {
    const row = await env.DB
      .prepare('SELECT version, updated_at, payload FROM snapshots WHERE user_id = ?')
      .bind(user.user_id)
      .first();
    if (!row) return json(null, 200, env, request);
    let payload = {};
    try { payload = JSON.parse(row.payload || '{}'); } catch (_) { payload = {}; }
    return json({ version: row.version, updated_at: row.updated_at, payload: sanitizeSnapshotPayload(payload) }, 200, env, request);
  }

  if (path === '/snapshot' && request.method === 'POST') {
    let body;
    try { body = await readJson(request, SNAPSHOT_MAX_BYTES); } catch (error) {
      return errorJson(error.code || 'bad_json', error.status || 400, env, request);
    }
    const expected = Number.isInteger(body && body.expected_version) ? body.expected_version : 0;
    const payload = body ? body.payload : undefined;
    if (payload === undefined || payload === null) return errorJson('missing_payload', 400, env, request);
    const payloadStr = JSON.stringify(sanitizeSnapshotPayload(payload));
    const updatedAt = new Date().toISOString();
    const row = await env.DB
      .prepare('SELECT version FROM snapshots WHERE user_id = ?')
      .bind(user.user_id)
      .first();
    const current = row ? row.version : 0;
    if (expected !== current) return json({ conflict: true, version: current }, 409, env, request);
    const next = current + 1;
    if (row) {
      const result = await env.DB
        .prepare('UPDATE snapshots SET version = ?, updated_at = ?, payload = ? WHERE user_id = ? AND version = ?')
        .bind(next, updatedAt, payloadStr, user.user_id, current)
        .run();
      if (!result.meta || result.meta.changes === 0) {
        const fresh = await env.DB
          .prepare('SELECT version FROM snapshots WHERE user_id = ?')
          .bind(user.user_id)
          .first();
        return json({ conflict: true, version: fresh ? fresh.version : current }, 409, env, request);
      }
    } else {
      if (expected !== 0) return json({ conflict: true, version: 0 }, 409, env, request);
      try {
        await env.DB
          .prepare('INSERT INTO snapshots (user_id, version, updated_at, payload) VALUES (?, ?, ?, ?)')
          .bind(user.user_id, next, updatedAt, payloadStr)
          .run();
      } catch (_) {
        return json({ conflict: true }, 409, env, request);
      }
    }
    return json({ conflict: false, version: next, updated_at: updatedAt }, 200, env, request);
  }

  return errorJson('not_found', 404, env, request);
}

export default {
  async fetch(request, env) {
    let url;
    try { url = new URL(request.url); } catch (_) { return new Response('bad request', { status: 400 }); }
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') {
      if (!isOriginAllowed(env, request)) return plainResponse(403, env, request);
      return plainResponse(204, env, request);
    }

    if (!env.DB) return errorJson('d1_binding_missing', 500, env, request);

    // Reject cross-origin calls from origins outside the configured list when an
    // Origin header is present. Same-origin and CLI calls have no Origin header
    // and still need a valid Bearer token.
    const origin = request.headers.get('Origin');
    if (origin && !isOriginAllowed(env, request)) return errorJson('origin_not_allowed', 403, env, request);

    if (path === '/pair') {
      if (request.method !== 'POST') return errorJson('method_not_allowed', 405, env, request);
      return handlePairRequest({ request, env });
    }

    if (path === '/reset-token' && request.method === 'POST') {
      return handleResetToken(request, env);
    }

    if (path === '/me' && request.method === 'GET') {
      const limit = rateLimit(`me:${getClientKey(request, null)}`, 60, 60 * 1000);
      if (!limit.ok) {
        return json({ error: 'rate_limited', code: 'rate_limited' }, 429, env, request, { 'Retry-After': String(limit.retryAfter) });
      }
    }

    const user = await authenticate(request, env);
    if (!user) return errorJson('unauthorized', 401, env, request);

    try {
      if (path === '/me' && request.method === 'GET') {
        return json({ user_id: user.user_id, label: user.label || '', role: user.role }, 200, env, request);
      }

      if (path === '/change-token' && request.method === 'POST') {
        return handleChangeToken(request, env, user);
      }

      if (path === '/version' || path === '/snapshot') {
        return handleSnapshot(request, env, user, path);
      }

      if (path === '/ai-credentials' || path.startsWith('/ai-credentials/')) {
        const weak = requireStrongPasscode(user, request, env);
        if (weak) return weak;
        return handleCredentialsRoute({
          request,
          env,
          url,
          user,
          rest: path.slice('/ai-credentials'.length)
        });
      }

      if (path === '/admin/users' || path.startsWith('/admin/users/')) {
        const weak = requireStrongPasscode(user, request, env);
        if (weak) return weak;
        return handleAdminUsersRoute({ request, env, url, user });
      }

      if (path === '/ai-catalog' || path.startsWith('/ai-catalog/') || path.startsWith('/admin/')) {
        const weak = requireStrongPasscode(user, request, env);
        if (weak) return weak;
        return handleCatalogRoute({ request, env, url, user });
      }

      return errorJson('not_found', 404, env, request);
    } catch (error) {
      // Never log authorization headers, bodies or decrypted content.
      console.error('[bdc-sync] route failed:', error && error.code ? error.code : 'internal_error');
      if (error && error.code === 'credential_unavailable') {
        return errorJson('credential_unavailable', 503, env, request);
      }
      if (error && error.code === 'payload_too_large') {
        return errorJson('payload_too_large', 413, env, request);
      }
      return errorJson('internal_error', 500, env, request);
    }
  }
};
