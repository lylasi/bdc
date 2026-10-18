// Admin user management (v1).
//
// Scope: list users, create a user with a one-time passcode/recovery code,
// edit label/email, and reset a non-admin user's credentials. Role changes,
// admin credential resets and account deletion stay deployer-only on purpose.
//
// Every route requires a D1-backed admin role and a >=32-character passcode
// (enforced by the caller). Plaintext passcodes and recovery codes are
// generated here, returned once, and never stored, logged or audited.

import { json, errorJson, readJsonBody, rateLimit } from './http.js';
import { randomToken, sha256Hex } from './token.js';
import { PAIRING_CODE_TTL_MS, randomPairingCode } from './device-pairing.js';

const USER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_LABEL_LENGTH = 120;
const MAX_EMAIL_LENGTH = 254;
const MAX_BODY_BYTES = 8 * 1024;
const USER_LIST_LIMIT = 1000;

function normalizeEmail(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

function isValidEmail(email) {
  if (!email) return true;
  return email.length <= MAX_EMAIL_LENGTH && EMAIL_RE.test(email);
}

function toUserJson(row) {
  return {
    userId: row.user_id,
    label: row.label || '',
    role: row.role === 'admin' ? 'admin' : 'user',
    email: row.email || '',
    createdAt: row.created_at || null
  };
}

function rateLimited(env, request, retryAfter) {
  return json({ error: 'rate_limited', code: 'rate_limited' }, 429, env, request, {
    'Retry-After': String(retryAfter)
  });
}

function auditStatement(env, actorUserId, action, targetUserId, detail, createdAt) {
  return env.DB
    .prepare('INSERT INTO admin_audit_log (actor_user_id, action, target_user_id, detail_json, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(actorUserId, action, targetUserId, JSON.stringify(detail || {}), createdAt);
}

async function runWithAudit(env, statements) {
  if (typeof env.DB.batch === 'function') return env.DB.batch(statements);
  const results = [];
  for (const statement of statements) results.push(await statement.run());
  return results;
}

function isUniqueError(error) {
  return /unique|constraint/i.test(String(error && error.message));
}

function findUserById(env, userId) {
  return env.DB
    .prepare('SELECT user_id, label, role, email, created_at FROM users WHERE user_id = ?')
    .bind(userId)
    .first();
}

function decodeUserId(value) {
  try { return decodeURIComponent(value); } catch (_) { return ''; }
}

async function listUsersHandler(ctx) {
  const { request, env, user } = ctx;
  const limit = rateLimit(`admin-users-list:${user.user_id}`, 120, 60 * 1000);
  if (!limit.ok) return rateLimited(env, request, limit.retryAfter);

  const result = await env.DB
    .prepare('SELECT user_id, label, role, email, created_at FROM users ORDER BY (created_at IS NULL) ASC, created_at DESC, user_id ASC LIMIT ?')
    .bind(USER_LIST_LIMIT)
    .all();
  const users = (result && result.results ? result.results : []).map(toUserJson);
  return json({ users, currentUserId: user.user_id }, 200, env, request);
}

async function createUserHandler(ctx) {
  const { request, env, user } = ctx;
  const limit = rateLimit(`admin-users-create:${user.user_id}`, 20, 60 * 1000);
  if (!limit.ok) return rateLimited(env, request, limit.retryAfter);

  let body;
  try { body = await readJsonBody(request, MAX_BODY_BYTES); } catch (error) {
    return errorJson(error.code || 'bad_json', error.status || 400, env, request);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return errorJson('bad_json', 400, env, request);
  }

  const userId = String(body.userId || '').trim();
  if (!USER_ID_RE.test(userId)) return errorJson('invalid_user_id', 400, env, request);

  const label = String(body.label || '').trim();
  if (label.length > MAX_LABEL_LENGTH) return errorJson('invalid_label', 400, env, request);

  const email = normalizeEmail(body.email);
  if (!isValidEmail(email)) return errorJson('invalid_email', 400, env, request);

  if (await findUserById(env, userId)) return errorJson('user_exists', 409, env, request);
  if (email) {
    const emailOwner = await env.DB
      .prepare('SELECT user_id FROM users WHERE email = ?')
      .bind(email)
      .first();
    if (emailOwner) return errorJson('email_exists', 409, env, request);
  }

  const passcode = randomToken(32);
  const recoveryCode = randomToken(24);
  const passcodeHash = await sha256Hex(passcode);
  const recoveryHash = await sha256Hex(recoveryCode);
  const createdAt = new Date().toISOString();

  const insert = env.DB
    .prepare('INSERT INTO users (token_hash, user_id, label, recovery_hash, role, email, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(passcodeHash, userId, label, recoveryHash, 'user', email || null, createdAt);
  const audit = auditStatement(env, user.user_id, 'user_create', userId, {
    role: 'user',
    hasEmail: Boolean(email)
  }, createdAt);

  try {
    await runWithAudit(env, [insert, audit]);
  } catch (error) {
    if (isUniqueError(error)) {
      if (await findUserById(env, userId)) return errorJson('user_exists', 409, env, request);
      return errorJson('email_exists', 409, env, request);
    }
    throw error;
  }

  return json({
    user: { userId, label, role: 'user', email, createdAt },
    passcode,
    recoveryCode
  }, 201, env, request);
}

async function updateUserHandler(ctx, userId) {
  const { request, env, user } = ctx;
  const limit = rateLimit(`admin-users-update:${user.user_id}`, 60, 60 * 1000);
  if (!limit.ok) return rateLimited(env, request, limit.retryAfter);
  if (!USER_ID_RE.test(userId)) return errorJson('invalid_user_id', 400, env, request);

  const row = await findUserById(env, userId);
  if (!row) return errorJson('user_not_found', 404, env, request);

  let body;
  try { body = await readJsonBody(request, MAX_BODY_BYTES); } catch (error) {
    return errorJson(error.code || 'bad_json', error.status || 400, env, request);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return errorJson('bad_json', 400, env, request);
  }

  const label = body.label === undefined ? (row.label || '') : String(body.label == null ? '' : body.label).trim();
  if (label.length > MAX_LABEL_LENGTH) return errorJson('invalid_label', 400, env, request);

  const email = body.email === undefined ? (row.email || '') : normalizeEmail(body.email);
  if (!isValidEmail(email)) return errorJson('invalid_email', 400, env, request);

  if (email && email !== (row.email || '')) {
    const emailOwner = await env.DB
      .prepare('SELECT user_id FROM users WHERE email = ? AND user_id <> ?')
      .bind(email, userId)
      .first();
    if (emailOwner) return errorJson('email_exists', 409, env, request);
  }

  const labelChanged = label !== (row.label || '');
  const emailChanged = email !== (row.email || '');
  if (!labelChanged && !emailChanged) return json({ user: toUserJson(row) }, 200, env, request);

  const changedAt = new Date().toISOString();
  const update = env.DB
    .prepare('UPDATE users SET label = ?, email = ? WHERE user_id = ?')
    .bind(label, email || null, userId);
  const audit = auditStatement(env, user.user_id, 'user_update', userId, {
    labelChanged,
    emailChanged
  }, changedAt);

  try {
    await runWithAudit(env, [update, audit]);
  } catch (error) {
    if (isUniqueError(error)) return errorJson('email_exists', 409, env, request);
    throw error;
  }

  return json({
    user: {
      userId,
      label,
      role: row.role === 'admin' ? 'admin' : 'user',
      email,
      createdAt: row.created_at || null
    }
  }, 200, env, request);
}

async function resetPasscodeHandler(ctx, userId) {
  const { request, env, user } = ctx;
  const limit = rateLimit(`admin-users-reset:${user.user_id}`, 20, 60 * 1000);
  if (!limit.ok) return rateLimited(env, request, limit.retryAfter);
  if (!USER_ID_RE.test(userId)) return errorJson('invalid_user_id', 400, env, request);

  const row = await findUserById(env, userId);
  if (!row) return errorJson('user_not_found', 404, env, request);
  if (row.role === 'admin') return errorJson('admin_account_protected', 403, env, request);

  const passcode = randomToken(32);
  const recoveryCode = randomToken(24);
  const passcodeHash = await sha256Hex(passcode);
  const recoveryHash = await sha256Hex(recoveryCode);
  const changedAt = new Date().toISOString();

  const update = env.DB
    .prepare('UPDATE users SET token_hash = ?, recovery_hash = ? WHERE user_id = ?')
    .bind(passcodeHash, recoveryHash, userId);
  const revokeSessions = env.DB
    .prepare('DELETE FROM user_sessions WHERE user_id = ?')
    .bind(userId);
  const revokePairingCodes = env.DB
    .prepare('DELETE FROM pairing_codes WHERE user_id = ? AND used_at IS NULL')
    .bind(userId);
  const audit = auditStatement(env, user.user_id, 'user_reset_passcode', userId, {}, changedAt);
  await runWithAudit(env, [update, revokeSessions, revokePairingCodes, audit]);

  return json({
    user: toUserJson(row),
    passcode,
    recoveryCode
  }, 200, env, request);
}

async function pairingCodeHandler(ctx, userId) {
  const { request, env, user } = ctx;
  const limit = rateLimit(`admin-users-pair:${user.user_id}`, 30, 60 * 1000);
  if (!limit.ok) return rateLimited(env, request, limit.retryAfter);
  if (!USER_ID_RE.test(userId)) return errorJson('invalid_user_id', 400, env, request);

  const row = await findUserById(env, userId);
  if (!row) return errorJson('user_not_found', 404, env, request);
  // Admin accounts keep a single strong credential; pairing them would create
  // a temporary path to admin privileges.
  if (row.role === 'admin') return errorJson('admin_account_protected', 403, env, request);

  const code = randomPairingCode();
  const codeHash = await sha256Hex(code);
  const createdAt = new Date();
  const createdAtIso = createdAt.toISOString();
  const expiresAt = new Date(createdAt.getTime() + PAIRING_CODE_TTL_MS).toISOString();

  const insert = env.DB
    .prepare('INSERT INTO pairing_codes (code_hash, user_id, created_by, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(codeHash, userId, user.user_id, createdAtIso, expiresAt, null);
  const audit = auditStatement(env, user.user_id, 'user_pairing_code', userId, { expiresAt }, createdAtIso);
  await runWithAudit(env, [insert, audit]);

  // The plaintext code is returned once and never stored.
  return json({ userId, code, expiresAt }, 200, env, request);
}

/**
 * @param {{ request: Request, env: object, url: URL, user: object }} ctx
 */
export async function handleAdminUsersRoute(ctx) {
  const { request, env, url, user } = ctx;
  if (!user || !user.user_id) return errorJson('unauthorized', 401, env, request);
  if (user.role !== 'admin') return errorJson('admin_required', 403, env, request);

  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (path === '/admin/users') {
    if (request.method === 'GET') return listUsersHandler(ctx);
    if (request.method === 'POST') return createUserHandler(ctx);
    return errorJson('method_not_allowed', 405, env, request);
  }

  const resetMatch = path.match(/^\/admin\/users\/([^/]+)\/reset-passcode$/);
  if (resetMatch) {
    if (request.method !== 'POST') return errorJson('method_not_allowed', 405, env, request);
    return resetPasscodeHandler(ctx, decodeUserId(resetMatch[1]));
  }

  const pairingMatch = path.match(/^\/admin\/users\/([^/]+)\/pairing-code$/);
  if (pairingMatch) {
    if (request.method !== 'POST') return errorJson('method_not_allowed', 405, env, request);
    return pairingCodeHandler(ctx, decodeUserId(pairingMatch[1]));
  }

  const updateMatch = path.match(/^\/admin\/users\/([^/]+)$/);
  if (updateMatch) {
    if (request.method !== 'PUT') return errorJson('method_not_allowed', 405, env, request);
    return updateUserHandler(ctx, decodeUserId(updateMatch[1]));
  }

  return errorJson('not_found', 404, env, request);
}
