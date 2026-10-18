// AI key encryption helpers (AES-256-GCM).
//
// - Master keys live in versioned Worker Secrets: AI_CREDENTIAL_KEY_V1, ...
// - The current version is a plain Worker variable: AI_CREDENTIAL_KEY_VERSION.
// - Personal credentials and managed (catalog) credentials use separate AAD
//   domains, so one can never be decrypted as the other.
// - Nothing in this module logs or returns plaintext keys.

export const AAD_VERSION = 1;
export const SUPPORTED_PROVIDER_FORMATS = ['openai-chat', 'anthropic-messages', 'gemini'];
export const SUPPORTED_AUTH_MODES = ['bearer', 'x-api-key', 'google', 'none'];

const KEY_CACHE = new Map();

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(String(value || ''));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function hexToBytes(value) {
  const hex = String(value || '');
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toBase64Url(value) {
  return bytesToBase64(new TextEncoder().encode(String(value))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

export function getCurrentKeyVersion(env) {
  const raw = env && env.AI_CREDENTIAL_KEY_VERSION;
  const version = Number.parseInt(String(raw || '1'), 10);
  return Number.isInteger(version) && version >= 1 ? version : 1;
}

function readMasterSecret(env, keyVersion) {
  const name = `AI_CREDENTIAL_KEY_V${keyVersion}`;
  const raw = env ? env[name] : '';
  return typeof raw === 'string' ? raw.trim() : '';
}

async function importMasterKey(env, keyVersion) {
  const secretName = `AI_CREDENTIAL_KEY_V${keyVersion}`;
  const cacheKey = `${keyVersion}:${(env && env[secretName]) || ''}`.slice(0, 200);
  if (KEY_CACHE.has(cacheKey)) return KEY_CACHE.get(cacheKey);
  const secret = readMasterSecret(env, keyVersion);
  let bytes = null;
  if (secret) {
    if (/^[0-9a-f]+$/i.test(secret) && secret.length === 64) bytes = hexToBytes(secret);
    else {
      try { bytes = base64ToBytes(secret); } catch (_) { bytes = null; }
    }
  }
  if (!bytes || bytes.length !== 32) {
    const err = new Error('credential key unavailable');
    err.code = 'credential_unavailable';
    throw err;
  }
  const key = await crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  KEY_CACHE.set(cacheKey, key);
  return key;
}

export function buildPersonalAad({ userId, providerId, binding, version, keyVersion }) {
  return [
    `bdc-ai-cred-v${AAD_VERSION}`,
    'scope=personal',
    `user=${String(userId || '')}`,
    `provider=${String(providerId || '')}`,
    `binding=${canonicalJson(binding || {})}`,
    `version=${Number(version)}`,
    `key=${Number(keyVersion)}`
  ].join('|');
}

export function buildManagedAad({ providerId, binding, credentialRevision, keyVersion }) {
  return [
    `bdc-ai-cred-v${AAD_VERSION}`,
    'scope=managed',
    `provider=${String(providerId || '')}`,
    `binding=${canonicalJson(binding || {})}`,
    `revision=${Number(credentialRevision)}`,
    `key=${Number(keyVersion)}`
  ].join('|');
}

export async function encryptSecret(plaintext, { aad, keyVersion = 1 }, env) {
  const key = await importMasterKey(env, keyVersion);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: nonce,
      additionalData: new TextEncoder().encode(String(aad || '')),
      tagLength: 128
    },
    key,
    new TextEncoder().encode(String(plaintext || ''))
  );
  return {
    ciphertext: bytesToBase64(new Uint8Array(cipher)),
    nonce: bytesToBase64(nonce),
    keyVersion
  };
}

export async function decryptSecret(envelope, { aad, keyVersion }, env) {
  if (!envelope || !envelope.ciphertext || !envelope.nonce) {
    const err = new Error('credential ciphertext missing');
    err.code = 'credential_missing';
    throw err;
  }
  const version = Number(keyVersion || envelope.keyVersion || 0);
  if (!Number.isInteger(version) || version < 1) {
    const err = new Error('credential key version missing');
    err.code = 'credential_decrypt_failed';
    throw err;
  }
  let key;
  try {
    key = await importMasterKey(env, version);
  } catch (error) {
    throw error;
  }
  try {
    const plain = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: base64ToBytes(envelope.nonce),
        additionalData: new TextEncoder().encode(String(aad || '')),
        tagLength: 128
      },
      key,
      base64ToBytes(envelope.ciphertext)
    );
    return new TextDecoder().decode(plain);
  } catch (_) {
    const err = new Error('credential decryption failed');
    err.code = 'credential_decrypt_failed';
    throw err;
  }
}

export async function hmacDigest(secret, text) {
  if (!secret) {
    const err = new Error('catalog digest key unavailable');
    err.code = 'credential_unavailable';
    throw err;
  }
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(String(secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(String(text)));
  return `v1:${[...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeUrl(value, label) {
  const raw = String(value || '').trim();
  if (!raw) {
    const err = new Error(`${label} missing`);
    err.code = 'invalid_binding';
    throw err;
  }
  let url;
  try { url = new URL(raw); } catch (_) {
    const err = new Error(`${label} invalid`);
    err.code = 'invalid_binding';
    throw err;
  }
  if (!/^https?:$/.test(url.protocol)) {
    const err = new Error(`${label} scheme not allowed`);
    err.code = 'invalid_binding';
    throw err;
  }
  if (url.username || url.password) {
    const err = new Error(`${label} must not contain credentials`);
    err.code = 'invalid_binding';
    throw err;
  }
  if (url.hash) url.hash = '';
  for (const key of url.searchParams.keys()) {
    if (/key|token|secret|auth|pass|sig/i.test(key)) {
      const err = new Error(`${label} must not contain credential query parameters`);
      err.code = 'invalid_binding';
      throw err;
    }
  }
  return url.toString();
}

/**
 * Validate and normalise a credential binding. Only non-secret routing data is
 * stored here; keys never appear in the binding.
 */
export function normalizeBinding(input) {
  const value = isPlainObject(input) ? input : {};
  const format = String(value.format || value.protocol || '').trim();
  const authMode = String(value.authMode || 'bearer').trim();
  if (!SUPPORTED_PROVIDER_FORMATS.includes(format)) {
    const err = new Error('unsupported provider format');
    err.code = 'unsupported_format';
    throw err;
  }
  if (!SUPPORTED_AUTH_MODES.includes(authMode)) {
    const err = new Error('unsupported auth mode');
    err.code = 'invalid_binding';
    throw err;
  }
  const apiUrl = normalizeUrl(value.apiUrl, 'apiUrl');
  const modelsUrl = value.modelsUrl ? normalizeUrl(value.modelsUrl, 'modelsUrl') : '';
  return {
    formatVersion: Number(value.formatVersion || 1),
    format,
    apiUrl,
    modelsUrl,
    authMode
  };
}

export function bindingMatches(a, b) {
  try {
    return canonicalJson(normalizeBinding(a)) === canonicalJson(normalizeBinding(b));
  } catch (_) {
    return false;
  }
}

export { toBase64Url, bytesToBase64, base64ToBytes };
