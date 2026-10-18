// Device pairing: exchange a short-lived one-time code for a long-lived
// session token. The user's primary passcode (users.token_hash) stays valid,
// so pairing a new device does not log out existing devices.
//
// Codes are 12 characters from an unambiguous alphabet (~60 bits), valid for
// 10 minutes, single-use, and stored as SHA-256 hashes only.

import { json, errorJson, readJsonBody, rateLimit, getClientKey } from './http.js';
import { randomToken, sha256Hex } from './token.js';

export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
export const SESSION_TTL_MS = 180 * 24 * 60 * 60 * 1000;

const PAIRING_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const PAIRING_CODE_RE = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12}$/;
const USER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_BODY_BYTES = 4 * 1024;

export function randomPairingCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
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

  const userId = String(body.userId || '').trim();
  const code = normalizePairingCode(body.code);
  if (!USER_ID_RE.test(userId) || !PAIRING_CODE_RE.test(code)) {
    return errorJson('pairing_invalid', 403, env, request);
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const codeHash = await sha256Hex(code);
  const row = await pairingCodeRow(env, codeHash);
  if (!row || row.user_id !== userId || row.used_at || !(row.expires_at > nowIso)) {
    return errorJson('pairing_invalid', 403, env, request);
  }

  const user = await env.DB
    .prepare('SELECT user_id, label, role FROM users WHERE user_id = ?')
    .bind(userId)
    .first();
  if (!user || user.role === 'admin') return errorJson('pairing_invalid', 403, env, request);

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
    .prepare('INSERT INTO user_sessions (token_hash, user_id, created_at, expires_at, device_label) VALUES (?, ?, ?, ?, ?)')
    .bind(tokenHash, user.user_id, nowIso, expiresAt, deviceLabel)
    .run();

  return json({
    token,
    user_id: user.user_id,
    label: user.label || '',
    role: user.role === 'admin' ? 'admin' : 'user',
    expires_at: expiresAt
  }, 200, env, request);
}
