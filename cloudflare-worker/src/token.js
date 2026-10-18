// Small token helpers shared by authentication and admin user management.

/**
 * SHA-256 hex digest. Passcodes and recovery codes are high-entropy random
 * values, so a fast hash is appropriate; plaintext is never stored.
 */
export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Cryptographically random Base64URL token (no padding).
 * 32 bytes → 43 characters; 24 bytes → 32 characters.
 */
export function randomToken(byteLength) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
