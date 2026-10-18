// Managed (admin-published) AI provider catalog.
//
// - The whole catalog is published as one immutable release row, which keeps
//   providers and task defaults consistent for a single read.
// - Shared provider keys are stored as per-provider AES-GCM envelopes with a
//   separate AAD domain (`scope=managed`). They are never sent to ordinary
//   users except on demand for the *current* release, and never to anonymous
//   callers.
// - Only admins can publish; the role is read from D1, never from the client.

import { json, errorJson, readJsonBody, rateLimit } from './http.js';
import {
  canonicalJson,
  buildManagedAad,
  decryptSecret,
  encryptSecret,
  getCurrentKeyVersion,
  hmacDigest,
  normalizeBinding,
  bindingMatches,
  isPlainObject
} from './credential-crypto.js';

export const CATALOG_LIMITS = {
  maxProviders: 30,
  maxPublishBytes: 512 * 1024,
  maxKeyBytes: 8 * 1024,
  historyKeep: 10,
  sessionTtlMs: 60 * 60 * 1000
};

const PROVIDER_ID_RE = /^managed-[A-Za-z0-9_-]{4,64}$/;
const TASK_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MODEL_ID_MAX = 200;
const CAPABILITIES = new Set(['yes', 'no', 'unknown']);
const CAPABILITY_KEYS = ['text', 'images', 'json', 'stream', 'models'];

function failure(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

function normalizeModel(raw) {
  if (typeof raw === 'string') {
    const id = raw.trim();
    if (!id || id.length > MODEL_ID_MAX) throw failure('invalid_model', 'invalid model id');
    return { id, label: id, capabilities: {} };
  }
  if (!isPlainObject(raw)) throw failure('invalid_model', 'invalid model entry');
  const id = String(raw.id || raw.model || '').trim();
  if (!id || id.length > MODEL_ID_MAX) throw failure('invalid_model', 'invalid model id');
  const capabilities = {};
  if (isPlainObject(raw.capabilities)) {
    for (const key of CAPABILITY_KEYS) {
      const value = String(raw.capabilities[key] || '').trim();
      if (CAPABILITIES.has(value)) capabilities[key] = value;
    }
  }
  return {
    id,
    label: String(raw.label || raw.name || id).slice(0, 200),
    capabilities
  };
}

/**
 * Validate a full catalog draft and return the whitelisted representation that
 * will be stored. Unknown fields (including any `apiKey`) are dropped.
 */
export function validateCatalogConfig(input) {
  if (!isPlainObject(input)) throw failure('invalid_catalog', 'catalog must be an object');
  const providersRaw = Array.isArray(input.providers) ? input.providers : [];
  if (providersRaw.length > CATALOG_LIMITS.maxProviders) throw failure('provider_limit_exceeded', 'too many providers');

  const seen = new Set();
  const providers = providersRaw.map((raw, index) => {
    if (!isPlainObject(raw)) throw failure('invalid_provider', 'provider must be an object');
    const id = String(raw.id || '').trim();
    if (!PROVIDER_ID_RE.test(id)) throw failure('invalid_provider_id', 'provider id must use the managed- namespace');
    if (seen.has(id)) throw failure('duplicate_provider_id', 'duplicate provider id');
    seen.add(id);
    let binding;
    try {
      binding = normalizeBinding({
        formatVersion: raw.formatVersion,
        format: raw.format,
        apiUrl: raw.apiUrl,
        modelsUrl: raw.modelsUrl,
        authMode: raw.authMode
      });
    } catch (error) {
      throw failure(error.code || 'invalid_binding', 'provider binding invalid');
    }
    const models = (Array.isArray(raw.models) ? raw.models : []).map(normalizeModel);
    const modelIds = new Set();
    for (const model of models) {
      if (modelIds.has(model.id)) throw failure('duplicate_model_id', 'duplicate model id');
      modelIds.add(model.id);
    }
    return {
      id,
      name: String(raw.name || id).slice(0, 120),
      enabled: raw.enabled !== false,
      order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : index,
      baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl.slice(0, 500) : '',
      ...binding,
      models
    };
  });

  const tasksRaw = isPlainObject(input.tasks) ? input.tasks : {};
  const tasks = {};
  for (const [task, spec] of Object.entries(tasksRaw)) {
    if (!TASK_NAME_RE.test(task)) throw failure('invalid_task', 'invalid task name');
    if (spec === null || spec === undefined) {
      tasks[task] = null;
      continue;
    }
    if (!isPlainObject(spec)) throw failure('invalid_task_reference', 'task reference must be an object');
    const providerId = String(spec.providerId || '').trim();
    const model = String(spec.model || '').trim();
    const provider = providers.find((item) => item.id === providerId);
    if (!provider) throw failure('dangling_task_reference', `task ${task} references an unknown provider`);
    if (!model || !provider.models.some((item) => item.id === model)) {
      throw failure('dangling_task_reference', `task ${task} references an unknown model`);
    }
    tasks[task] = { providerId, model };
  }

  return {
    schemaVersion: 1,
    providers,
    tasks
  };
}

export function validateKeyOps(input, providers) {
  const ops = isPlainObject(input) ? input : {};
  const out = {};
  for (const provider of providers) {
    const op = ops[provider.id];
    const action = isPlainObject(op) ? String(op.action || 'preserve') : 'preserve';
    if (!['preserve', 'replace', 'clear'].includes(action)) {
      throw failure('invalid_key_operation', 'invalid key operation');
    }
    if (action === 'replace') {
      const apiKey = typeof op.apiKey === 'string' ? op.apiKey : '';
      if (!apiKey.trim()) throw failure('api_key_required', 'replacement key missing');
      if (new TextEncoder().encode(apiKey).length > CATALOG_LIMITS.maxKeyBytes) {
        throw failure('api_key_too_large', 'replacement key too large');
      }
      out[provider.id] = { action, apiKey };
    } else {
      out[provider.id] = { action };
    }
  }
  return out;
}

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function releaseRowToAdmin(row) {
  if (!row) return null;
  const config = parseJson(row.config_json, { schemaVersion: 1, providers: [], tasks: {} });
  const credentials = parseJson(row.credentials_json, {});
  return {
    version: Number(row.version),
    config,
    credentials: Object.fromEntries(Object.entries(credentials).map(([providerId, envelope]) => [
      providerId,
      {
        hasKey: !!(envelope && envelope.ciphertext),
        credentialRevision: Number(envelope && envelope.credentialRevision) || 0,
        binding: (envelope && envelope.binding) || null
      }
    ])),
    publishedBy: row.published_by,
    publishedAt: row.published_at
  };
}

async function getLatestRelease(env) {
  return env.DB
    .prepare('SELECT version, config_json, credentials_json, mutation_id, request_digest, published_by, published_at FROM ai_default_catalog_releases ORDER BY version DESC LIMIT 1')
    .first();
}

async function getReleaseByVersion(env, version) {
  return env.DB
    .prepare('SELECT version, config_json, credentials_json, mutation_id, request_digest, published_by, published_at FROM ai_default_catalog_releases WHERE version = ?')
    .bind(version)
    .first();
}

async function getReleaseByMutation(env, mutationId) {
  return env.DB
    .prepare('SELECT version, config_json, credentials_json, mutation_id, request_digest, published_by, published_at FROM ai_default_catalog_releases WHERE mutation_id = ?')
    .bind(mutationId)
    .first();
}

function sessionWindow() {
  const verifiedAt = Date.now();
  return {
    verifiedAt: new Date(verifiedAt).toISOString(),
    expiresAt: new Date(verifiedAt + CATALOG_LIMITS.sessionTtlMs).toISOString()
  };
}

function publicCatalog(config, version, release) {
  const providers = (config.providers || [])
    .filter((provider) => provider.enabled !== false)
    .sort((a, b) => Number(a.order || 0) - Number(b.order || 0))
    .map((provider) => ({
      id: provider.id,
      name: provider.name,
      order: provider.order,
      format: provider.format,
      formatVersion: provider.formatVersion,
      apiUrl: provider.apiUrl,
      modelsUrl: provider.modelsUrl,
      authMode: provider.authMode,
      models: provider.models,
      capabilities: provider.capabilities || {}
    }));
  const enabledIds = new Set(providers.map((provider) => provider.id));
  const tasks = {};
  for (const [task, spec] of Object.entries(config.tasks || {})) {
    if (!spec) { tasks[task] = null; continue; }
    if (enabledIds.has(spec.providerId)) tasks[task] = { providerId: spec.providerId, model: spec.model };
  }
  return {
    version: Number(version || 0),
    providers,
    tasks,
    publishedAt: release ? release.published_at : null,
    ...sessionWindow()
  };
}

async function catalogHandler(ctx) {
  const { env, request, user } = ctx;
  const limit = rateLimit(`catalog:${user.user_id}`, 120, 60 * 1000);
  if (!limit.ok) {
    return json({ error: 'rate_limited', code: 'rate_limited' }, 429, env, request, { 'Retry-After': String(limit.retryAfter) });
  }
  const release = await getLatestRelease(env);
  if (!release) return json(publicCatalog({ providers: [], tasks: {} }, 0, null), 200, env, request);
  const config = parseJson(release.config_json, { schemaVersion: 1, providers: [], tasks: {} });
  return json(publicCatalog(config, release.version, release), 200, env, request);
}

async function catalogCredentialHandler(ctx, providerId) {
  const { env, request, user, url } = ctx;
  const limit = rateLimit(`catalog-key:${user.user_id}`, 120, 60 * 1000);
  if (!limit.ok) {
    return json({ error: 'rate_limited', code: 'rate_limited' }, 429, env, request, { 'Retry-After': String(limit.retryAfter) });
  }
  const requestedVersion = Number(url.searchParams.get('catalogVersion'));
  if (!Number.isInteger(requestedVersion) || requestedVersion < 1) {
    return errorJson('catalog_version_required', 400, env, request);
  }
  const release = await getLatestRelease(env);
  if (!release) return errorJson('catalog_empty', 404, env, request);
  if (Number(release.version) !== requestedVersion) {
    return json({
      error: 'catalog_version_conflict',
      code: 'catalog_version_conflict',
      version: Number(release.version)
    }, 409, env, request);
  }
  const config = parseJson(release.config_json, { providers: [], tasks: {} });
  const provider = (config.providers || []).find((item) => item.id === providerId);
  if (!provider || provider.enabled === false) {
    return errorJson('provider_unavailable', 404, env, request);
  }
  const binding = {
    formatVersion: provider.formatVersion,
    format: provider.format,
    apiUrl: provider.apiUrl,
    modelsUrl: provider.modelsUrl,
    authMode: provider.authMode
  };
  if (provider.authMode === 'none') {
    return json({
      providerId,
      catalogVersion: requestedVersion,
      credentialRevision: 0,
      binding,
      apiKey: null
    }, 200, env, request);
  }
  const credentials = parseJson(release.credentials_json, {});
  const envelope = credentials[providerId];
  if (!envelope || !envelope.ciphertext) {
    return errorJson('credential_missing', 404, env, request);
  }
  try {
    const aad = buildManagedAad({
      providerId,
      binding: envelope.binding || binding,
      credentialRevision: Number(envelope.credentialRevision) || 0,
      keyVersion: Number(envelope.keyVersion) || 0
    });
    const apiKey = await decryptSecret(
      { ciphertext: envelope.ciphertext, nonce: envelope.nonce, keyVersion: Number(envelope.keyVersion) },
      { aad, keyVersion: Number(envelope.keyVersion) },
      env
    );
    return json({
      providerId,
      catalogVersion: requestedVersion,
      credentialRevision: Number(envelope.credentialRevision) || 0,
      binding: envelope.binding || binding,
      apiKey
    }, 200, env, request);
  } catch (error) {
    if (error && error.code === 'credential_unavailable') {
      return errorJson('credential_unavailable', 503, env, request);
    }
    return errorJson('credential_decrypt_failed', 500, env, request);
  }
}

async function adminCatalogHandler(ctx) {
  const { env, request } = ctx;
  const release = await getLatestRelease(env);
  const payload = releaseRowToAdmin(release);
  return json(payload || {
    version: 0,
    config: { schemaVersion: 1, providers: [], tasks: {} },
    credentials: {},
    publishedBy: '',
    publishedAt: null
  }, 200, env, request);
}

async function adminHistoryHandler(ctx) {
  const { env, request } = ctx;
  const result = await env.DB
    .prepare('SELECT version, config_json, published_by, published_at FROM ai_default_catalog_releases ORDER BY version DESC LIMIT ?')
    .bind(CATALOG_LIMITS.historyKeep)
    .all();
  const items = (result && result.results ? result.results : []).map((row) => ({
    version: Number(row.version),
    config: parseJson(row.config_json, { schemaVersion: 1, providers: [], tasks: {} }),
    publishedBy: row.published_by,
    publishedAt: row.published_at
  }));
  return json({ items }, 200, env, request);
}

async function publishHandler(ctx) {
  const { env, request, user } = ctx;
  const limit = rateLimit(`catalog-publish:${user.user_id}`, 20, 60 * 1000);
  if (!limit.ok) {
    return json({ error: 'rate_limited', code: 'rate_limited' }, 429, env, request, { 'Retry-After': String(limit.retryAfter) });
  }
  let body;
  try {
    body = await readJsonBody(request, CATALOG_LIMITS.maxPublishBytes);
  } catch (error) {
    return errorJson(error.code || 'bad_json', error.status || 400, env, request);
  }
  const baseVersion = Number(body.baseVersion);
  const mutationId = String(body.mutationId || '');
  if (!Number.isInteger(baseVersion) || baseVersion < 0) return errorJson('invalid_base_version', 400, env, request);
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(mutationId)) return errorJson('invalid_mutation_id', 400, env, request);

  let config;
  try {
    config = validateCatalogConfig(body.config);
  } catch (error) {
    return errorJson(error.code || 'invalid_catalog', 400, env, request);
  }
  let keyOps;
  try {
    keyOps = validateKeyOps(body.keyOps, config.providers);
  } catch (error) {
    return errorJson(error.code || 'invalid_key_operation', 400, env, request);
  }

  const latest = await getLatestRelease(env);
  const currentVersion = latest ? Number(latest.version) : 0;
  const currentConfig = latest ? parseJson(latest.config_json, { providers: [], tasks: {} }) : { providers: [], tasks: {} };
  const currentCredentials = latest ? parseJson(latest.credentials_json, {}) : {};

  const digestKey = env && env.AI_CATALOG_DIGEST_KEY;
  let digest;
  try {
    digest = await hmacDigest(digestKey, canonicalJson({
      operator: user.user_id,
      baseVersion,
      config,
      keyOps
    }));
  } catch (error) {
    return errorJson('credential_unavailable', 503, env, request);
  }

  const byMutation = await getReleaseByMutation(env, mutationId);
  if (byMutation) {
    if (byMutation.published_by === user.user_id && byMutation.request_digest === digest) {
      return json({
        version: Number(byMutation.version),
        publishedAt: byMutation.published_at,
        idempotent: true,
        credentialRevisions: Object.fromEntries(Object.entries(parseJson(byMutation.credentials_json, {})).map(([id, envelope]) => [id, Number(envelope.credentialRevision) || 0]))
      }, 200, env, request);
    }
    return errorJson('mutation_conflict', 409, env, request);
  }

  if (baseVersion !== currentVersion) {
    return json({
      error: 'catalog_version_conflict',
      code: 'catalog_version_conflict',
      version: currentVersion
    }, 409, env, request);
  }

  const keyVersion = getCurrentKeyVersion(env);
  const credentials = {};
  try {
    for (const provider of config.providers) {
      const previous = currentCredentials[provider.id];
      const op = keyOps[provider.id] || { action: 'preserve' };
      if (provider.authMode === 'none') {
        if (op.action === 'replace') throw failure('key_not_required', 'this provider does not use a key');
        continue;
      }
      const binding = {
        formatVersion: provider.formatVersion,
        format: provider.format,
        apiUrl: provider.apiUrl,
        modelsUrl: provider.modelsUrl,
        authMode: provider.authMode
      };
      if (op.action === 'clear') {
        if (provider.enabled !== false) throw failure('cannot_clear_enabled_provider_key', 'disable the provider before clearing its key');
        continue;
      }
      if (op.action === 'replace') {
        const revision = (Number(previous && previous.credentialRevision) || 0) + 1;
        const aad = buildManagedAad({ providerId: provider.id, binding, credentialRevision: revision, keyVersion });
        const envelope = await encryptSecret(op.apiKey, { aad, keyVersion }, env);
        credentials[provider.id] = {
          ciphertext: envelope.ciphertext,
          nonce: envelope.nonce,
          keyVersion: envelope.keyVersion,
          credentialRevision: revision,
          binding
        };
        continue;
      }
      if (!previous || !previous.ciphertext) throw failure('api_key_required', 'provider needs a key');
      if (!bindingMatches(previous.binding, binding)) throw failure('binding_changed_requires_key', 'endpoint changed; confirm the key for the new endpoint');
      credentials[provider.id] = previous;
    }
  } catch (error) {
    return errorJson(error.code || 'credential_encrypt_failed', error.code === 'credential_unavailable' ? 503 : 400, env, request);
  }

  const nextVersion = currentVersion + 1;
  const publishedAt = new Date().toISOString();
  const configJson = JSON.stringify(config);
  const credentialsJson = JSON.stringify(credentials);
  try {
    const result = await env.DB
      .prepare('INSERT INTO ai_default_catalog_releases (version, config_json, credentials_json, mutation_id, request_digest, published_by, published_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(version) DO NOTHING')
      .bind(nextVersion, configJson, credentialsJson, mutationId, digest, user.user_id, publishedAt)
      .run();
    if (!result || !result.meta || Number(result.meta.changes) === 0) {
      const fresh = await getLatestRelease(env);
      return json({
        error: 'catalog_version_conflict',
        code: 'catalog_version_conflict',
        version: fresh ? Number(fresh.version) : 0
      }, 409, env, request);
    }
  } catch (error) {
    const byId = await getReleaseByMutation(env, mutationId).catch(() => null);
    if (byId) {
      if (byId.published_by === user.user_id && byId.request_digest === digest) {
        return json({ version: Number(byId.version), publishedAt: byId.published_at, idempotent: true }, 200, env, request);
      }
      return errorJson('mutation_conflict', 409, env, request);
    }
    return errorJson('publish_failed', 500, env, request);
  }

  try {
    await env.DB
      .prepare('DELETE FROM ai_default_catalog_releases WHERE version NOT IN (SELECT version FROM ai_default_catalog_releases ORDER BY version DESC LIMIT ?)')
      .bind(CATALOG_LIMITS.historyKeep)
      .run();
  } catch (_) { /* history pruning must never fail a publish */ }

  return json({
    version: nextVersion,
    publishedAt,
    idempotent: false,
    credentialRevisions: Object.fromEntries(Object.entries(credentials).map(([id, envelope]) => [id, Number(envelope.credentialRevision) || 0]))
  }, 200, env, request);
}

function restPath(path) {
  return path.replace(/\/+$/, '');
}

/**
 * Public + admin catalog routes.
 * @param {{ request: Request, env: object, url: URL, user: object }} ctx
 */
export async function handleCatalogRoute(ctx) {
  const { request, env, url, user } = ctx;
  const path = restPath(url.pathname);
  if (!user || !user.user_id) return errorJson('unauthorized', 401, env, request);

  if (path === '/ai-catalog' && request.method === 'GET') return catalogHandler(ctx);

  const credentialMatch = path.match(/^\/ai-catalog\/providers\/([^/]+)\/credential$/);
  if (credentialMatch) {
    if (request.method !== 'GET') return errorJson('method_not_allowed', 405, env, request);
    const providerId = decodeURIComponent(credentialMatch[1]);
    if (!PROVIDER_ID_RE.test(providerId)) return errorJson('invalid_provider_id', 400, env, request);
    return catalogCredentialHandler(ctx, providerId);
  }

  if (path.startsWith('/admin/ai-catalog') || path.startsWith('/admin/')) {
    if (user.role !== 'admin') return errorJson('admin_required', 403, env, request);
    if (path === '/admin/ai-catalog' && request.method === 'GET') return adminCatalogHandler(ctx);
    if (path === '/admin/ai-catalog/history' && request.method === 'GET') return adminHistoryHandler(ctx);
    if (path === '/admin/ai-catalog/publish' && request.method === 'POST') return publishHandler(ctx);
    return errorJson('not_found', 404, env, request);
  }

  return errorJson('not_found', 404, env, request);
}
