// Personal AI credential storage (D1).
//
// Contract (see docs/plan/20261017130932086_...md, section 6):
//   GET    /ai-credentials                      metadata only
//   GET    /ai-credentials/:providerId          key + binding + version
//   PUT    /ai-credentials/:providerId          CAS write with idempotent mutationId
//   DELETE /ai-credentials/:providerId          clear ciphertext, keep tombstone
//
// The server always scopes every statement to the authenticated user_id; a
// client can never name another user. Keys are encrypted with AES-256-GCM and
// the AAD binds scope/user/provider/binding/version/keyVersion.

import { json, errorJson, readJsonBody, rateLimit } from './http.js';
import {
  canonicalJson,
  buildPersonalAad,
  decryptSecret,
  encryptSecret,
  getCurrentKeyVersion,
  normalizeBinding
} from './credential-crypto.js';

export const CREDENTIAL_LIMITS = {
  maxProvidersPerUser: 200,
  maxPutBytes: 32 * 1024,
  maxDeleteBytes: 8 * 1024,
  maxKeyBytes: 8 * 1024
};

const RESERVED_IDS = new Set(['default', '__proto__', 'prototype', 'constructor']);
const PROVIDER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isReservedProviderId(id) {
  const value = String(id || '');
  return RESERVED_IDS.has(value) || value.startsWith('managed-');
}

export function isValidProviderId(id) {
  const value = String(id || '');
  return PROVIDER_ID_RE.test(value) && !isReservedProviderId(value);
}

export function isValidMutationId(id) {
  return /^[A-Za-z0-9_-]{8,128}$/.test(String(id || ''));
}

/**
 * Pure idempotency decision used by PUT/DELETE and by tests.
 * `existing` describes the stored row, `incoming` the requested mutation.
 */
export function evaluateReplay(existing, incoming) {
  if (!existing) return { replay: false, conflict: false };
  if (!incoming || !incoming.mutationId) return { replay: false, conflict: false };
  if (existing.last_mutation_id !== incoming.mutationId) {
    if (Number(existing.version) !== Number(incoming.expectedVersion)) return { replay: false, conflict: true };
    return { replay: false, conflict: false };
  }
  // Same mutation id: it is only a replay when the content matches too.
  const sameBinding = canonicalJson(existing.binding || {}) === canonicalJson(incoming.binding || {});
  const sameKey = typeof incoming.apiKey === 'string'
    ? existing.apiKey === incoming.apiKey
    : existing.deleted === true;
  if (sameBinding && sameKey) return { replay: true, conflict: false };
  return { replay: false, conflict: true };
}

function parseProviderId(raw) {
  let id = '';
  try { id = decodeURIComponent(String(raw || '')); } catch (_) { id = ''; }
  return id;
}

function rowToMeta(row) {
  return {
    providerId: row.provider_id,
    version: Number(row.version),
    deleted: Number(row.deleted) === 1,
    updatedAt: row.updated_at,
    lastMutationId: row.last_mutation_id
  };
}

function rowToResult(row) {
  return {
    providerId: row.provider_id,
    version: Number(row.version),
    deleted: Number(row.deleted) === 1,
    updatedAt: row.updated_at,
    lastMutationId: row.last_mutation_id
  };
}

async function selectRow(env, userId, providerId) {
  return env.DB
    .prepare('SELECT user_id, provider_id, binding_json, key_ciphertext, nonce, key_version, version, deleted, last_mutation_id, updated_at FROM user_ai_credentials WHERE user_id = ? AND provider_id = ?')
    .bind(userId, providerId)
    .first();
}

async function decryptRow(env, userId, row) {
  if (!row || Number(row.deleted) === 1 || !row.key_ciphertext) return '';
  let binding = {};
  try { binding = JSON.parse(row.binding_json || '{}'); } catch (_) { binding = {}; }
  const aad = buildPersonalAad({
    userId,
    providerId: row.provider_id,
    binding,
    version: Number(row.version),
    keyVersion: Number(row.key_version)
  });
  return decryptSecret(
    { ciphertext: row.key_ciphertext, nonce: row.nonce, keyVersion: Number(row.key_version) },
    { aad, keyVersion: Number(row.key_version) },
    env
  );
}

async function listHandler(ctx) {
  const { env, request, user } = ctx;
  const result = await env.DB
    .prepare('SELECT provider_id, binding_json, version, deleted, updated_at, last_mutation_id FROM user_ai_credentials WHERE user_id = ? ORDER BY provider_id')
    .bind(user.user_id)
    .all();
  const items = (result && result.results ? result.results : []).map((row) => {
    let binding = {};
    try { binding = JSON.parse(row.binding_json || '{}'); } catch (_) { binding = {}; }
    return {
      providerId: row.provider_id,
      version: Number(row.version),
      deleted: Number(row.deleted) === 1,
      binding,
      updatedAt: row.updated_at,
      lastMutationId: row.last_mutation_id
    };
  });
  return json({ items }, 200, env, request);
}

async function getHandler(ctx, providerId) {
  const { env, request, user } = ctx;
  const row = await selectRow(env, user.user_id, providerId);
  if (!row) return errorJson('credential_not_found', 404, env, request);
  if (Number(row.deleted) === 1) {
    return json({
      providerId,
      ...rowToMeta(row),
      apiKey: null,
      binding: (() => { try { return JSON.parse(row.binding_json || '{}'); } catch (_) { return {}; } })()
    }, 200, env, request);
  }
  let apiKey;
  try {
    apiKey = await decryptRow(env, user.user_id, row);
  } catch (error) {
    if (error && error.code === 'credential_unavailable') {
      return errorJson('credential_unavailable', 503, env, request);
    }
    return errorJson('credential_decrypt_failed', 500, env, request);
  }
  let binding = {};
  try { binding = JSON.parse(row.binding_json || '{}'); } catch (_) { binding = {}; }
  return json({
    providerId,
    ...rowToMeta(row),
    apiKey,
    binding
  }, 200, env, request);
}

async function putHandler(ctx, providerId) {
  const { env, request, user } = ctx;
  const limit = rateLimit(`cred-put:${user.user_id}`, 120, 60 * 1000);
  if (!limit.ok) {
    return json({ error: 'rate_limited', code: 'rate_limited' }, 429, env, request, { 'Retry-After': String(limit.retryAfter) });
  }
  let body;
  try {
    body = await readJsonBody(request, CREDENTIAL_LIMITS.maxPutBytes);
  } catch (error) {
    return errorJson(error.code || 'bad_json', error.status || 400, env, request);
  }

  const expectedVersion = Number(body.expectedVersion);
  const mutationId = String(body.mutationId || '');
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey : '';
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    return errorJson('invalid_expected_version', 400, env, request);
  }
  if (!isValidMutationId(mutationId)) {
    return errorJson('invalid_mutation_id', 400, env, request);
  }
  if (!apiKey.trim()) return errorJson('api_key_required', 400, env, request);
  if (new TextEncoder().encode(apiKey).length > CREDENTIAL_LIMITS.maxKeyBytes) {
    return errorJson('api_key_too_large', 413, env, request);
  }
  let binding;
  try {
    binding = normalizeBinding(body.binding);
  } catch (error) {
    return errorJson(error.code || 'invalid_binding', 400, env, request);
  }
  if (binding.authMode === 'none') {
    return errorJson('key_not_required', 400, env, request);
  }

  const existing = await selectRow(env, user.user_id, providerId);
  let existingKey = '';
  if (existing) {
    try {
      existingKey = await decryptRow(env, user.user_id, existing);
    } catch (error) {
      if (error && error.code === 'credential_unavailable') {
        return errorJson('credential_unavailable', 503, env, request);
      }
      return errorJson('credential_decrypt_failed', 500, env, request);
    }
  }
  const replay = evaluateReplay(
    existing ? {
      version: Number(existing.version),
      deleted: Number(existing.deleted) === 1,
      last_mutation_id: existing.last_mutation_id,
      binding: (() => { try { return JSON.parse(existing.binding_json || '{}'); } catch (_) { return {}; } })(),
      apiKey: existingKey
    } : null,
    {
      mutationId,
      expectedVersion,
      binding,
      apiKey
    }
  );
  if (replay.replay) return json(rowToResult(existing), 200, env, request);
  if (replay.conflict) {
    return json({
      error: 'version_conflict',
      code: 'version_conflict',
      ...rowToMeta(existing)
    }, 409, env, request);
  }

  if (!existing && expectedVersion !== 0) {
    return json({ error: 'version_conflict', code: 'version_conflict', version: 0, deleted: false }, 409, env, request);
  }
  if (existing && expectedVersion !== Number(existing.version)) {
    return json({
      error: 'version_conflict',
      code: 'version_conflict',
      ...rowToMeta(existing)
    }, 409, env, request);
  }

  if (!existing) {
    const countRow = await env.DB
      .prepare('SELECT COUNT(*) AS n FROM user_ai_credentials WHERE user_id = ?')
      .bind(user.user_id)
      .first();
    if (Number(countRow && countRow.n) >= CREDENTIAL_LIMITS.maxProvidersPerUser) {
      return errorJson('provider_limit_reached', 429, env, request);
    }
  }

  const keyVersion = getCurrentKeyVersion(env);
  const nextVersion = expectedVersion + 1;
  const aad = buildPersonalAad({
    userId: user.user_id,
    providerId,
    binding,
    version: nextVersion,
    keyVersion
  });
  let envelope;
  try {
    envelope = await encryptSecret(apiKey, { aad, keyVersion }, env);
  } catch (error) {
    if (error && error.code === 'credential_unavailable') {
      return errorJson('credential_unavailable', 503, env, request);
    }
    return errorJson('credential_encrypt_failed', 500, env, request);
  }
  const updatedAt = new Date().toISOString();
  const bindingJson = JSON.stringify(binding);

  try {
    if (!existing) {
      await env.DB
        .prepare('INSERT INTO user_ai_credentials (user_id, provider_id, binding_json, key_ciphertext, nonce, key_version, version, deleted, last_mutation_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)')
        .bind(user.user_id, providerId, bindingJson, envelope.ciphertext, envelope.nonce, envelope.keyVersion, nextVersion, mutationId, updatedAt)
        .run();
    } else {
      const result = await env.DB
        .prepare('UPDATE user_ai_credentials SET binding_json = ?, key_ciphertext = ?, nonce = ?, key_version = ?, version = ?, deleted = 0, last_mutation_id = ?, updated_at = ? WHERE user_id = ? AND provider_id = ? AND version = ?')
        .bind(bindingJson, envelope.ciphertext, envelope.nonce, envelope.keyVersion, nextVersion, mutationId, updatedAt, user.user_id, providerId, expectedVersion)
        .run();
      if (!result || !result.meta || Number(result.meta.changes) === 0) {
        const fresh = await selectRow(env, user.user_id, providerId);
        return json({
          error: 'version_conflict',
          code: 'version_conflict',
          ...(fresh ? rowToMeta(fresh) : { version: 0 })
        }, 409, env, request);
      }
    }
  } catch (error) {
    const fresh = await selectRow(env, user.user_id, providerId).catch(() => null);
    if (fresh) {
      return json({
        error: 'version_conflict',
        code: 'version_conflict',
        ...rowToMeta(fresh)
      }, 409, env, request);
    }
    return errorJson('credential_write_failed', 500, env, request);
  }

  return json({
    providerId,
    version: nextVersion,
    deleted: false,
    updatedAt,
    lastMutationId: mutationId
  }, 200, env, request);
}

async function deleteHandler(ctx, providerId) {
  const { env, request, user } = ctx;
  let body;
  try {
    body = await readJsonBody(request, CREDENTIAL_LIMITS.maxDeleteBytes);
  } catch (error) {
    return errorJson(error.code || 'bad_json', error.status || 400, env, request);
  }
  const expectedVersion = Number(body.expectedVersion);
  const mutationId = String(body.mutationId || '');
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    return errorJson('invalid_expected_version', 400, env, request);
  }
  if (!isValidMutationId(mutationId)) {
    return errorJson('invalid_mutation_id', 400, env, request);
  }

  const existing = await selectRow(env, user.user_id, providerId);
  if (!existing) return errorJson('credential_not_found', 404, env, request);

  let existingKey = '';
  try {
    existingKey = await decryptRow(env, user.user_id, existing);
  } catch (error) {
    if (error && error.code === 'credential_unavailable') {
      return errorJson('credential_unavailable', 503, env, request);
    }
    /* A corrupt envelope must not block deletion. */
    existingKey = '';
  }

  const replay = evaluateReplay(
    {
      version: Number(existing.version),
      deleted: Number(existing.deleted) === 1,
      last_mutation_id: existing.last_mutation_id,
      binding: (() => { try { return JSON.parse(existing.binding_json || '{}'); } catch (_) { return {}; } })(),
      apiKey: existingKey
    },
    { mutationId, expectedVersion, binding: (() => { try { return JSON.parse(existing.binding_json || '{}'); } catch (_) { return {}; } })(), apiKey: '' }
  );
  if (replay.replay) return json(rowToResult(existing), 200, env, request);
  if (replay.conflict) {
    return json({ error: 'version_conflict', code: 'version_conflict', ...rowToMeta(existing) }, 409, env, request);
  }
  if (expectedVersion !== Number(existing.version)) {
    return json({ error: 'version_conflict', code: 'version_conflict', ...rowToMeta(existing) }, 409, env, request);
  }

  const nextVersion = expectedVersion + 1;
  const updatedAt = new Date().toISOString();
  const result = await env.DB
    .prepare('UPDATE user_ai_credentials SET key_ciphertext = NULL, nonce = NULL, key_version = NULL, version = ?, deleted = 1, last_mutation_id = ?, updated_at = ? WHERE user_id = ? AND provider_id = ? AND version = ?')
    .bind(nextVersion, mutationId, updatedAt, user.user_id, providerId, expectedVersion)
    .run();
  if (!result || !result.meta || Number(result.meta.changes) === 0) {
    const fresh = await selectRow(env, user.user_id, providerId);
    return json({
      error: 'version_conflict',
      code: 'version_conflict',
      ...(fresh ? rowToMeta(fresh) : { version: 0 })
    }, 409, env, request);
  }

  return json({
    providerId,
    version: nextVersion,
    deleted: true,
    updatedAt,
    lastMutationId: mutationId
  }, 200, env, request);
}

/**
 * @param {{ request: Request, env: object, url: URL, user: object, rest: string }} ctx
 * `rest` is the path after `/ai-credentials` ('' or '/<providerId>').
 */
export async function handleCredentialsRoute(ctx) {
  const { rest, request, env, user } = ctx;
  if (!user || !user.user_id) return errorJson('unauthorized', 401, env, request);

  if (!rest) {
    if (request.method === 'GET') return listHandler(ctx);
    return errorJson('method_not_allowed', 405, env, request);
  }

  const providerId = parseProviderId(rest.replace(/^\//, ''));
  if (!providerId || rest.split('/').length > 2) {
    return errorJson('invalid_provider_id', 400, env, request);
  }
  if (!isValidProviderId(providerId)) {
    return errorJson('invalid_provider_id', 400, env, request);
  }

  if (request.method === 'GET') return getHandler(ctx, providerId);
  if (request.method === 'PUT') return putHandler(ctx, providerId);
  if (request.method === 'DELETE') return deleteHandler(ctx, providerId);
  return errorJson('method_not_allowed', 405, env, request);
}
