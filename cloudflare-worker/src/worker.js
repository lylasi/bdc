// bdc-sync-api — Cloudflare Worker
//
// Responsibilities: passcode/device-pairing login, per-user learning snapshots,
// personal AI credentials, and the admin-managed default AI catalog. This
// Worker never proxies AI requests; browsers call providers directly.
//
// Routes:
//   OPTIONS *                                     CORS preflight
//   GET  /auth-capabilities                       supported login methods (no auth)
//   GET  /me                                      { user_id, label, role }
//   GET  /version                                 { version }
//   GET  /snapshot                                { version, updated_at, payload } | null
//   POST /snapshot                                CAS write (409 on conflict)
//   GET  /articles                                article list / incremental cursor sync
//   POST /articles                                create one article (idempotent)
//   POST /articles/batch                          read several article documents
//   POST /articles/import                         import legacy snapshot articles
//   GET  /articles/usage                          article count / byte usage
//   GET  /reading/capabilities                    reading item sync capability
//   GET  /reading/changes                         per-entity cursor sync
//   POST /reading/batch                           read several reading entities
//   POST /reading/mutations                       idempotent entity mutations
//   GET|PUT|DELETE /articles/:id                  read / CAS update / soft delete
//   POST /articles/:id/restore                    undo a soft delete (CAS)
//   POST /login                                   username + password → session token (no auth)
//   POST /pair                                    device pairing code → session token (no auth)
//   POST /reset-token                             recovery-code reset (no auth)
//   POST /change-token                            change own passcode
//   POST /change-password                         change own password (logged in)
//   GET|PUT|DELETE /ai-credentials[/:id]          personal encrypted keys
//   GET  /ai-catalog                              published catalog (logged in)
//   GET  /ai-catalog/providers/:id/credential     shared key (logged in, current version)
//   GET  /admin/ai-catalog[/history]              admin view (no keys)
//   POST /admin/ai-catalog/publish                atomic catalog publish
//   GET  /admin/users                             admin user list (no hashes)
//   POST /admin/users                             admin creates a user (one-time secret)
//   PUT  /admin/users/:id                         admin edits label/email
//   POST /admin/users/:id/reset-passcode          admin resets a non-admin user
//   POST /admin/users/:id/pairing-code            admin issues a one-time login code
//   DELETE /admin/users/:id/pairing-codes         admin revokes unused login codes
//
// Secrets (set with `wrangler secret put`): AI_CREDENTIAL_KEY_V1,
// AI_CATALOG_DIGEST_KEY, PASSWORD_PEPPER. Plain vars:
// AI_CREDENTIAL_KEY_VERSION, ALLOWED_ORIGINS.

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
import { handlePairRequest, SESSION_TTL_MS } from './device-pairing.js';
import { sanitizeSnapshotPayload } from './snapshot-sanitize.js';
import { handleArticlesRoute, isLegacyArticleWriteBlocked } from './articles.js';
import { handleReadingRoute, isLegacyReadingWriteBlocked } from './reading.js';
import { snapshotCarriesArticles } from '../../shared/article-protocol.mjs';
import { snapshotCarriesReading } from '../../shared/reading-protocol.mjs';
import { randomToken, sha256Hex } from './token.js';
import {
  ADMIN_PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  hashPassword,
  isPasswordPepperConfigured,
  normalizeUsername,
  validatePassword,
  verifyPassword
} from './password.js';

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
    .prepare('SELECT user_id, label, role, username, password_hash, is_active FROM users WHERE token_hash = ?')
    .bind(hash)
    .first();
  if (row) {
    if (Number(row.is_active) === 0) return null;
    return {
      user_id: row.user_id,
      label: row.label,
      role: row.role === 'admin' ? 'admin' : 'user',
      username: row.username || '',
      hasPassword: Boolean(row.password_hash),
      tokenLength: token.length,
      viaSession: false
    };
  }

  // Session tokens live in user_sessions and expire independently of the
  // account passcode. auth_version ties them to the current password/passcode
  // generation, so a reset invalidates every older device immediately.
  const session = await env.DB
    .prepare('SELECT u.user_id, u.label, u.role, u.username, u.password_hash, u.is_active FROM user_sessions s JOIN users u ON u.user_id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND s.auth_version = u.auth_version')
    .bind(hash, new Date().toISOString())
    .first();
  if (!session) return null;
  if (Number(session.is_active) === 0) return null;
  return {
    user_id: session.user_id,
    label: session.label,
    role: session.role === 'admin' ? 'admin' : 'user',
    username: session.username || '',
    hasPassword: Boolean(session.password_hash),
    tokenLength: token.length,
    viaSession: true
  };
}

async function runStatements(env, statements) {
  if (typeof env.DB.batch === 'function') return env.DB.batch(statements);
  const results = [];
  for (const statement of statements) results.push(await statement.run());
  return results;
}

async function setPasscodeAndRevoke(env, userId, newHash) {
  const statements = [
    env.DB.prepare('UPDATE users SET token_hash = ?, auth_version = auth_version + 1 WHERE user_id = ?').bind(newHash, userId),
    env.DB.prepare('DELETE FROM user_sessions WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM pairing_codes WHERE user_id = ? AND used_at IS NULL').bind(userId)
  ];
  return runStatements(env, statements);
}

function tooManyRequests(env, request, retryAfter) {
  return json({ error: 'rate_limited', code: 'rate_limited' }, 429, env, request, {
    'Retry-After': String(retryAfter)
  });
}

/**
 * POST /login — username + password. Unauthenticated, rate-limited per client
 * and per client+username. Unknown users and wrong passwords share one error.
 */
async function handleLogin(request, env) {
  let body;
  try { body = await readJson(request, 8 * 1024); } catch (error) {
    return errorJson(error.code || 'bad_json', error.status || 400, env, request);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return errorJson('invalid_credentials', 401, env, request);
  }

  const username = normalizeUsername(body.username);
  const password = String(body.password == null ? '' : body.password);
  if (!username || !password) return errorJson('invalid_credentials', 401, env, request);
  if (password.length > PASSWORD_MAX_LENGTH) return errorJson('invalid_credentials', 401, env, request);

  const client = getClientKey(request, null);
  const globalLimit = rateLimit(`login-all:${client}`, 30, 10 * 60 * 1000);
  if (!globalLimit.ok) return tooManyRequests(env, request, globalLimit.retryAfter);
  const userLimit = rateLimit(`login-user:${client}:${username}`, 10, 10 * 60 * 1000);
  if (!userLimit.ok) return tooManyRequests(env, request, userLimit.retryAfter);

  if (!isPasswordPepperConfigured(env)) {
    return errorJson('password_not_configured', 503, env, request);
  }

  const row = await env.DB
    .prepare('SELECT user_id, label, role, username, password_hash, auth_version, is_active FROM users WHERE username_normalized = ?')
    .bind(username)
    .first();
  const passwordOk = row && row.password_hash
    ? await verifyPassword(password, row.password_hash, env.PASSWORD_PEPPER)
    : false;
  if (!row || !passwordOk) return errorJson('invalid_credentials', 401, env, request);
  if (Number(row.is_active) === 0) return errorJson('account_disabled', 403, env, request);

  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  const deviceLabel = String(body.deviceLabel || '').trim().slice(0, 80) || null;
  const authVersion = Number(row.auth_version) || 1;

  await env.DB
    .prepare('INSERT INTO user_sessions (token_hash, user_id, created_at, expires_at, device_label, auth_version) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(tokenHash, row.user_id, nowIso, expiresAt, deviceLabel, authVersion)
    .run();

  return json({
    token,
    user_id: row.user_id,
    label: row.label || '',
    role: row.role === 'admin' ? 'admin' : 'user',
    username: row.username || username,
    hasPassword: true,
    expires_at: expiresAt
  }, 200, env, request);
}

/**
 * POST /change-password — requires the current password. Increments
 * auth_version, keeps the current session, and revokes every other session.
 */
async function handleChangePassword(request, env, user) {
  if (!isPasswordPepperConfigured(env)) {
    return errorJson('password_not_configured', 503, env, request);
  }
  let body;
  try { body = await readJson(request, 8 * 1024); } catch (error) {
    return errorJson(error.code || 'bad_json', error.status || 400, env, request);
  }
  const currentPassword = String(body && body.currentPassword != null ? body.currentPassword : '');
  const newPassword = String(body && body.newPassword != null ? body.newPassword : '');
  if (!currentPassword || !newPassword) return errorJson('missing_fields', 400, env, request);

  const passwordError = validatePassword(newPassword, user.role);
  if (passwordError) return errorJson(passwordError, 400, env, request);

  const row = await env.DB
    .prepare('SELECT password_hash, auth_version, role FROM users WHERE user_id = ?')
    .bind(user.user_id)
    .first();
  if (!row || !row.password_hash) return errorJson('password_not_set', 409, env, request);
  if (!(await verifyPassword(currentPassword, row.password_hash, env.PASSWORD_PEPPER))) {
    return errorJson('invalid_current_password', 403, env, request);
  }

  const newHash = await hashPassword(newPassword, env.PASSWORD_PEPPER);
  const changedAt = new Date().toISOString();
  const nextVersion = (Number(row.auth_version) || 1) + 1;
  const currentHash = await sha256Hex(getBearerToken(request));

  await runStatements(env, [
    env.DB.prepare('UPDATE users SET password_hash = ?, password_updated_at = ?, auth_version = ? WHERE user_id = ?')
      .bind(newHash, changedAt, nextVersion, user.user_id),
    env.DB.prepare('DELETE FROM user_sessions WHERE user_id = ? AND token_hash <> ?')
      .bind(user.user_id, currentHash),
    env.DB.prepare('UPDATE user_sessions SET auth_version = ? WHERE token_hash = ? AND user_id = ?')
      .bind(nextVersion, currentHash, user.user_id),
    env.DB.prepare('DELETE FROM pairing_codes WHERE user_id = ? AND used_at IS NULL')
      .bind(user.user_id)
  ]);

  return json({ ok: true, authVersion: nextVersion }, 200, env, request);
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
    // 條件讀取：客戶端已持有同版本內容時只回 notModified，省下整包 payload。
    // 舊客戶端不帶 ?version=，行為完全不變。
    const knownVersion = Number(new URL(request.url).searchParams.get('version'));
    if (Number.isInteger(knownVersion) && knownVersion > 0 && knownVersion === Number(row.version)) {
      return json({ version: Number(row.version), updated_at: row.updated_at, notModified: true }, 200, env, request);
    }
    let payload = {};
    try { payload = JSON.parse(row.payload || '{}'); } catch (_) { payload = {}; }
    payload = sanitizeSnapshotPayload(payload);
    // 帳戶已改用逐篇文章儲存後，快照不再回傳舊的文章群組，避免新裝置把
    // 已刪除或過期的文章當成最新資料重新匯入。其他群組維持不變。
    if (snapshotCarriesArticles(payload) && await isLegacyArticleWriteBlocked(env, user.user_id)) {
      delete payload.articles;
    }
    // 詞書與聊天搬到逐項儲存後，舊快照不得再把整組資料帶回新裝置。
    if (snapshotCarriesReading(payload) && await isLegacyReadingWriteBlocked(env, user.user_id)) {
      delete payload.vocabulary;
      delete payload.assistant;
    }
    return json({ version: row.version, updated_at: row.updated_at, payload }, 200, env, request);
  }

  if (path === '/snapshot' && request.method === 'POST') {
    let body;
    try { body = await readJson(request, SNAPSHOT_MAX_BYTES); } catch (error) {
      return errorJson(error.code || 'bad_json', error.status || 400, env, request);
    }
    const expected = Number.isInteger(body && body.expected_version) ? body.expected_version : 0;
    const payload = body ? body.payload : undefined;
    if (payload === undefined || payload === null) return errorJson('missing_payload', 400, env, request);
    const sanitized = sanitizeSnapshotPayload(payload);
    // 舊客戶端仍會把整包文章塞進快照。文章搬到獨立表之後，這條路徑必須關閉，
    // 否則兩個寫入來源會互相覆蓋；其他群組的更新不受影響。
    if (snapshotCarriesArticles(sanitized) && await isLegacyArticleWriteBlocked(env, user.user_id)) {
      return json({
        error: 'articles_legacy_write_blocked',
        code: 'articles_legacy_write_blocked',
        conflict: true,
        upgradeRequired: true
      }, 409, env, request);
    }
    if (snapshotCarriesReading(sanitized) && await isLegacyReadingWriteBlocked(env, user.user_id)) {
      return json({
        error: 'reading_legacy_write_blocked',
        code: 'reading_legacy_write_blocked',
        conflict: true,
        upgradeRequired: true
      }, 409, env, request);
    }
    if (sanitized && typeof sanitized === 'object') delete sanitized.articles;
    const payloadStr = JSON.stringify(sanitized);
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

    if (path === '/auth-capabilities') {
      if (request.method !== 'GET') return errorJson('method_not_allowed', 405, env, request);
      return json({
        pairingLogin: true,
        loginLinks: true,
        // Password login needs a server-side pepper. Hiding it until the
        // secret exists avoids advertising a method that always fails.
        passwordLogin: isPasswordPepperConfigured(env),
        passwordMinLength: PASSWORD_MIN_LENGTH,
        adminPasswordMinLength: ADMIN_PASSWORD_MIN_LENGTH
      }, 200, env, request);
    }

    if (path === '/login') {
      if (request.method !== 'POST') return errorJson('method_not_allowed', 405, env, request);
      return handleLogin(request, env);
    }

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
        return json({
          user_id: user.user_id,
          label: user.label || '',
          role: user.role,
          username: user.username || '',
          hasPassword: Boolean(user.hasPassword)
        }, 200, env, request);
      }

      if (path === '/change-token' && request.method === 'POST') {
        return handleChangeToken(request, env, user);
      }

      if (path === '/change-password' && request.method === 'POST') {
        return handleChangePassword(request, env, user);
      }

      if (path === '/version' || path === '/snapshot') {
        return handleSnapshot(request, env, user, path);
      }

      if (path === '/articles' || path.startsWith('/articles/')) {
        return handleArticlesRoute({
          request,
          env,
          url,
          user,
          rest: path.slice('/articles'.length)
        });
      }

      if (path === '/reading' || path.startsWith('/reading/')) {
        return handleReadingRoute({
          request,
          env,
          url,
          user,
          rest: path.slice('/reading'.length)
        });
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
