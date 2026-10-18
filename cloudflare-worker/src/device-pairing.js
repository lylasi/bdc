// Login codes: exchange a one-time code for a long-lived session token.
// The user's primary passcode (users.token_hash) stays valid, so signing in on
// a device does not log out existing devices.
//
// New codes are 16 characters from an unambiguous alphabet (80 bits),
// single-use, and stored as SHA-256 hashes only. The default lifetime is seven
// days; administrators can choose 10 minutes, 24 hours, 7 days or 30 days.
// Legacy 12-character codes remain accepted until they expire.

import { json, errorJson, readJsonBody, rateLimit, getClientKey } from './http.js';
import { randomToken, sha256Hex } from './token.js';

export const PAIRING_CODE_LENGTH = 16;
export const PAIRING_CODE_TTL_SECONDS = Object.freeze([600, 86400, 604800, 2592000]);
export const DEFAULT_PAIRING_CODE_TTL_SECONDS = 604800;
// Kept for callers that still use the millisecond constant. New code should
// send an explicit ttlSeconds value.
export const PAIRING_CODE_TTL_MS = DEFAULT_PAIRING_CODE_TTL_SECONDS * 1000;
export const SESSION_TTL_MS = 180 * 24 * 60 * 60 * 1000;

const PAIRING_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
// 12-character codes are the v1 format; 16 is the current default. The upper
// bound leaves room for future formats without accepting arbitrary input.
const PAIRING_CODE_RE = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12,32}$/;
const USER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_BODY_BYTES = 4 * 1024;

export function randomPairingCode(length = PAIRING_CODE_LENGTH) {
  const size = Math.max(12, Math.min(32, Number(length) || PAIRING_CODE_LENGTH));
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  let code = '';
  // 256 is divisible by the 32-character alphabet, so modulo is unbiased.
  for (const byte of bytes) code += PAIRING_ALPHABET[byte % PAIRING_ALPHABET.length];
  return code;
}

export function normalizePairingCode(value) {
  return String(value == null ? '' : value)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

async function pairingCodeRow(env, codeHash) {
  return env.DB
    .prepare('SELECT user_id, expires_at, used_at FROM pairing_codes WHERE code_hash = ?')
    .bind(codeHash)
    .first();
}

/**
 * POST /pair — unauthenticated, rate-limited.
 * @param {{ request: Request, env: object }} ctx
 */
export async function handlePairRequest(ctx) {
  const { request, env } = ctx;
  const limit = rateLimit(`pair:${getClientKey(request, null)}`, 20, 10 * 60 * 1000);
  if (!limit.ok) {
    return json({ error: 'rate_limited', code: 'rate_limited' }, 429, env, request, {
      'Retry-After': String(limit.retryAfter)
    });
  }

  let body;
  try { body = await readJsonBody(request, MAX_BODY_BYTES); } catch (error) {
    return errorJson(error.code || 'bad_json', error.status || 400, env, request);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return errorJson('pairing_invalid', 403, env, request);
  }

  const userIdInput = String(body.userId || '').trim();
  const code = normalizePairingCode(body.code);
  if (!PAIRING_CODE_RE.test(code) || (userIdInput && !USER_ID_RE.test(userIdInput))) {
    return errorJson('pairing_invalid', 403, env, request);
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const codeHash = await sha256Hex(code);
  const row = await pairingCodeRow(env, codeHash);
  if (!row || row.used_at || !(row.expires_at > nowIso)) {
    return errorJson('pairing_invalid', 403, env, request);
  }

  // The code alone identifies the account. userId is optional and only acts as
  // an extra check for clients that still display a user-id field. User ids are
  // case-insensitive; the stored canonical id is always used below.
  if (userIdInput && row.user_id.toLowerCase() !== userIdInput.toLowerCase()) {
    return errorJson('pairing_invalid', 403, env, request);
  }

  const user = await env.DB
    .prepare('SELECT user_id, label, role, auth_version, is_active FROM users WHERE user_id = ?')
    .bind(row.user_id)
    .first();
  if (!user || user.role === 'admin' || user.is_active === 0) {
    return errorJson('pairing_invalid', 403, env, request);
  }

  // Conditional update makes the code single-use even if two devices race.
  const consumed = await env.DB
    .prepare('UPDATE pairing_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL')
    .bind(nowIso, codeHash)
    .run();
  if (!consumed || !consumed.meta || consumed.meta.changes !== 1) {
    return errorJson('pairing_invalid', 403, env, request);
  }

  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  const deviceLabel = String(body.deviceLabel || '').trim().slice(0, 80) || null;

  await env.DB
    .prepare('INSERT INTO user_sessions (token_hash, user_id, created_at, expires_at, device_label, auth_version) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(tokenHash, user.user_id, nowIso, expiresAt, deviceLabel, user.auth_version ?? 1)
    .run();

  return json({
    token,
    user_id: user.user_id,
    label: user.label || '',
    role: user.role === 'admin' ? 'admin' : 'user',
    expires_at: expiresAt
  }, 200, env, request);
}
