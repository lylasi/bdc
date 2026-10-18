// Password hashing for username/password login (Workers Free friendly).
//
// PBKDF2-HMAC-SHA256 at 50,000 iterations keeps a login request within the
// Workers Free 10 ms CPU budget in practice, while a server-side pepper (a
// Worker secret, never stored in D1) makes a database-only leak insufficient
// for offline cracking. If the deployment moves to Workers Paid, raising
// PBKDF2_ITERATIONS only invalidates stored hashes if the iteration count is
// not encoded; it is encoded here, so old hashes keep verifying.

export const PBKDF2_ITERATIONS = 50000;
export const PASSWORD_MIN_LENGTH = 10;
export const ADMIN_PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 200;
export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 32;
export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;

const PASSWORD_SCHEME = 'pbkdf2-sha256';
const PEPPER_MIN_LENGTH = 32;
const encoder = new TextEncoder();

export function normalizeUsername(value) {
  return String(value == null ? '' : value)
    .trim()
    .normalize('NFKC')
    .toLowerCase();
}

/** Returns an error code, or '' when the normalized username is valid. */
export function validateUsername(value) {
  const username = normalizeUsername(value);
  if (!username) return 'username_required';
  if (!USERNAME_RE.test(username)) return 'invalid_username';
  return '';
}

export function passwordMinLength(role) {
  return role === 'admin' ? ADMIN_PASSWORD_MIN_LENGTH : PASSWORD_MIN_LENGTH;
}

/** Returns an error code, or '' when the password is acceptable. */
export function validatePassword(password, role) {
  const value = String(password == null ? '' : password);
  if (!value) return 'password_required';
  if (value.length < passwordMinLength(role)) return 'weak_password';
  if (value.length > PASSWORD_MAX_LENGTH) return 'invalid_password';
  return '';
}

export function isPasswordPepperConfigured(env) {
  const pepper = env && env.PASSWORD_PEPPER;
  return typeof pepper === 'string' && pepper.length >= PEPPER_MIN_LENGTH;
}

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(value) {
  const text = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = text + '==='.slice((text.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function concatBytes(left, right) {
  const out = new Uint8Array(left.length + right.length);
  out.set(left, 0);
  out.set(right, left.length);
  return out;
}

function timingSafeEqual(left, right) {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}

async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(String(password)),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    256
  );
  return new Uint8Array(bits);
}

async function pepperMac(pepper, salt, derived) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, concatBytes(salt, derived));
  return new Uint8Array(mac);
}

/**
 * Hash a password. The returned string is safe to store in D1:
 * `pbkdf2-sha256$<iterations>$<salt>$<peppered-hash>`.
 */
export async function hashPassword(password, pepper, iterations = PBKDF2_ITERATIONS) {
  if (!pepper) throw new Error('password pepper missing');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const derived = await derive(password, salt, iterations);
  const mac = await pepperMac(pepper, salt, derived);
  return `${PASSWORD_SCHEME}$${iterations}$${bytesToBase64Url(salt)}$${bytesToBase64Url(mac)}`;
}

/** Verify a password against an encoded hash. Never throws for bad input. */
export async function verifyPassword(password, encoded, pepper) {
  if (!pepper) return false;
  const parts = String(encoded || '').split('$');
  if (parts.length !== 4 || parts[0] !== PASSWORD_SCHEME) return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1000 || iterations > 1000000) return false;
  let salt;
  let expected;
  try {
    salt = base64UrlToBytes(parts[2]);
    expected = base64UrlToBytes(parts[3]);
  } catch (_) {
    return false;
  }
  if (salt.length < 8 || expected.length < 16) return false;
  try {
    const derived = await derive(password, salt, iterations);
    const actual = await pepperMac(pepper, salt, derived);
    return timingSafeEqual(actual, expected);
  } catch (_) {
    return false;
  }
}
