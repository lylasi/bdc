var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// ../../../../../Users/linus/CODE/bdc-extension-ai-proof-20261105/cloudflare-worker/src/http.js
var JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };
var NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate, private", "Pragma": "no-cache" };
var RATE_BUCKETS = /* @__PURE__ */ new Map();
function parseOrigins(env) {
  const raw = String(env && (env.ALLOWED_ORIGINS || env.ALLOW_ORIGIN) || "").trim();
  if (!raw || raw === "*") return { wildcard: true, origins: [] };
  return {
    wildcard: false,
    origins: raw.split(",").map((item) => item.trim().replace(/\/+$/, "")).filter(Boolean)
  };
}
__name(parseOrigins, "parseOrigins");
function isOriginAllowed(env, request) {
  const cfg = parseOrigins(env);
  if (cfg.wildcard) return true;
  const origin = request && request.headers ? request.headers.get("Origin") || "" : "";
  if (!origin) return false;
  return cfg.origins.includes(origin.replace(/\/+$/, ""));
}
__name(isOriginAllowed, "isOriginAllowed");
function corsHeaders(env, request) {
  const cfg = parseOrigins(env);
  const origin = request && request.headers ? request.headers.get("Origin") || "" : "";
  const allowOrigin = cfg.wildcard ? "*" : cfg.origins.includes(origin.replace(/\/+$/, "")) ? origin : "";
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "600",
    "Vary": "Origin",
    ...NO_STORE
  };
  if (allowOrigin) headers["Access-Control-Allow-Origin"] = allowOrigin;
  return headers;
}
__name(corsHeaders, "corsHeaders");
function json(data, status, env, request, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { ...JSON_HEADERS, ...corsHeaders(env, request), ...extraHeaders || {} }
  });
}
__name(json, "json");
function errorJson(code, status, env, request, extra) {
  return json({ error: code, code, ...extra || {} }, status || 400, env, request);
}
__name(errorJson, "errorJson");
function plainResponse(status, env, request) {
  return new Response(null, { status, headers: corsHeaders(env, request) });
}
__name(plainResponse, "plainResponse");
async function readJsonBody(request, maxBytes) {
  const limit = Number(maxBytes) || 0;
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (limit && declared && declared > limit) {
    const err = new Error("payload too large");
    err.code = "payload_too_large";
    err.status = 413;
    throw err;
  }
  let text;
  try {
    text = await request.text();
  } catch (_) {
    const err = new Error("bad body");
    err.code = "bad_json";
    err.status = 400;
    throw err;
  }
  if (limit && text.length > limit) {
    const err = new Error("payload too large");
    err.code = "payload_too_large";
    err.status = 413;
    throw err;
  }
  if (!text.trim()) {
    const err = new Error("empty body");
    err.code = "bad_json";
    err.status = 400;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch (_) {
    const err = new Error("bad json");
    err.code = "bad_json";
    err.status = 400;
    throw err;
  }
}
__name(readJsonBody, "readJsonBody");
async function readOptionalJsonBody(request, maxBytes) {
  const limit = Number(maxBytes) || 0;
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (limit && declared && declared > limit) {
    const err = new Error("payload too large");
    err.code = "payload_too_large";
    err.status = 413;
    throw err;
  }
  let text;
  try {
    text = await request.text();
  } catch (_) {
    const err = new Error("bad body");
    err.code = "bad_json";
    err.status = 400;
    throw err;
  }
  if (limit && text.length > limit) {
    const err = new Error("payload too large");
    err.code = "payload_too_large";
    err.status = 413;
    throw err;
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (_) {
    const err = new Error("bad json");
    err.code = "bad_json";
    err.status = 400;
    throw err;
  }
}
__name(readOptionalJsonBody, "readOptionalJsonBody");
function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const bucketKey = String(key || "");
  let bucket = RATE_BUCKETS.get(bucketKey);
  if (!bucket || now - bucket.startedAt >= windowMs) {
    bucket = { startedAt: now, count: 0 };
    RATE_BUCKETS.set(bucketKey, bucket);
  }
  bucket.count += 1;
  if (RATE_BUCKETS.size > 5e3) {
    for (const [k, b] of RATE_BUCKETS) {
      if (now - b.startedAt >= windowMs) RATE_BUCKETS.delete(k);
    }
  }
  if (bucket.count > limit) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((bucket.startedAt + windowMs - now) / 1e3)) };
  }
  return { ok: true, retryAfter: 0 };
}
__name(rateLimit, "rateLimit");
function getClientKey(request, user) {
  if (user && user.user_id) return `u:${user.user_id}`;
  const ip = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "unknown";
  return `ip:${ip}`;
}
__name(getClientKey, "getClientKey");

// ../../../../../Users/linus/CODE/bdc-extension-ai-proof-20261105/cloudflare-worker/src/credential-crypto.js
var AAD_VERSION = 1;
var SUPPORTED_PROVIDER_FORMATS = ["openai-chat", "anthropic-messages", "gemini"];
var SUPPORTED_AUTH_MODES = ["bearer", "x-api-key", "google", "none"];
var KEY_CACHE = /* @__PURE__ */ new Map();
function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 32768;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
__name(bytesToBase64, "bytesToBase64");
function base64ToBytes(value) {
  const binary = atob(String(value || ""));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}
__name(base64ToBytes, "base64ToBytes");
function hexToBytes(value) {
  const hex = String(value || "");
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
__name(hexToBytes, "hexToBytes");
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
__name(canonicalJson, "canonicalJson");
function getCurrentKeyVersion(env) {
  const raw = env && env.AI_CREDENTIAL_KEY_VERSION;
  const version = Number.parseInt(String(raw || "1"), 10);
  return Number.isInteger(version) && version >= 1 ? version : 1;
}
__name(getCurrentKeyVersion, "getCurrentKeyVersion");
function readMasterSecret(env, keyVersion) {
  const name = `AI_CREDENTIAL_KEY_V${keyVersion}`;
  const raw = env ? env[name] : "";
  return typeof raw === "string" ? raw.trim() : "";
}
__name(readMasterSecret, "readMasterSecret");
async function importMasterKey(env, keyVersion) {
  const secretName = `AI_CREDENTIAL_KEY_V${keyVersion}`;
  const cacheKey = `${keyVersion}:${env && env[secretName] || ""}`.slice(0, 200);
  if (KEY_CACHE.has(cacheKey)) return KEY_CACHE.get(cacheKey);
  const secret = readMasterSecret(env, keyVersion);
  let bytes = null;
  if (secret) {
    if (/^[0-9a-f]+$/i.test(secret) && secret.length === 64) bytes = hexToBytes(secret);
    else {
      try {
        bytes = base64ToBytes(secret);
      } catch (_) {
        bytes = null;
      }
    }
  }
  if (!bytes || bytes.length !== 32) {
    const err = new Error("credential key unavailable");
    err.code = "credential_unavailable";
    throw err;
  }
  const key = await crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  KEY_CACHE.set(cacheKey, key);
  return key;
}
__name(importMasterKey, "importMasterKey");
function buildPersonalAad({ userId, providerId, binding, version, keyVersion }) {
  return [
    `bdc-ai-cred-v${AAD_VERSION}`,
    "scope=personal",
    `user=${String(userId || "")}`,
    `provider=${String(providerId || "")}`,
    `binding=${canonicalJson(binding || {})}`,
    `version=${Number(version)}`,
    `key=${Number(keyVersion)}`
  ].join("|");
}
__name(buildPersonalAad, "buildPersonalAad");
function buildManagedAad({ providerId, binding, credentialRevision, keyVersion }) {
  return [
    `bdc-ai-cred-v${AAD_VERSION}`,
    "scope=managed",
    `provider=${String(providerId || "")}`,
    `binding=${canonicalJson(binding || {})}`,
    `revision=${Number(credentialRevision)}`,
    `key=${Number(keyVersion)}`
  ].join("|");
}
__name(buildManagedAad, "buildManagedAad");
async function encryptSecret(plaintext, { aad, keyVersion = 1 }, env) {
  const key = await importMasterKey(env, keyVersion);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce,
      additionalData: new TextEncoder().encode(String(aad || "")),
      tagLength: 128
    },
    key,
    new TextEncoder().encode(String(plaintext || ""))
  );
  return {
    ciphertext: bytesToBase64(new Uint8Array(cipher)),
    nonce: bytesToBase64(nonce),
    keyVersion
  };
}
__name(encryptSecret, "encryptSecret");
async function decryptSecret(envelope, { aad, keyVersion }, env) {
  if (!envelope || !envelope.ciphertext || !envelope.nonce) {
    const err = new Error("credential ciphertext missing");
    err.code = "credential_missing";
    throw err;
  }
  const version = Number(keyVersion || envelope.keyVersion || 0);
  if (!Number.isInteger(version) || version < 1) {
    const err = new Error("credential key version missing");
    err.code = "credential_decrypt_failed";
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
        name: "AES-GCM",
        iv: base64ToBytes(envelope.nonce),
        additionalData: new TextEncoder().encode(String(aad || "")),
        tagLength: 128
      },
      key,
      base64ToBytes(envelope.ciphertext)
    );
    return new TextDecoder().decode(plain);
  } catch (_) {
    const err = new Error("credential decryption failed");
    err.code = "credential_decrypt_failed";
    throw err;
  }
}
__name(decryptSecret, "decryptSecret");
async function hmacDigest(secret, text) {
  if (!secret) {
    const err = new Error("catalog digest key unavailable");
    err.code = "credential_unavailable";
    throw err;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(String(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(String(text)));
  return `v1:${[...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
__name(hmacDigest, "hmacDigest");
function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
__name(isPlainObject, "isPlainObject");
function normalizeUrl(value, label) {
  const raw = String(value || "").trim();
  if (!raw) {
    const err = new Error(`${label} missing`);
    err.code = "invalid_binding";
    throw err;
  }
  let url;
  try {
    url = new URL(raw);
  } catch (_) {
    const err = new Error(`${label} invalid`);
    err.code = "invalid_binding";
    throw err;
  }
  if (!/^https?:$/.test(url.protocol)) {
    const err = new Error(`${label} scheme not allowed`);
    err.code = "invalid_binding";
    throw err;
  }
  if (url.username || url.password) {
    const err = new Error(`${label} must not contain credentials`);
    err.code = "invalid_binding";
    throw err;
  }
  if (url.hash) url.hash = "";
  for (const key of url.searchParams.keys()) {
    if (/key|token|secret|auth|pass|sig/i.test(key)) {
      const err = new Error(`${label} must not contain credential query parameters`);
      err.code = "invalid_binding";
      throw err;
    }
  }
  return url.toString();
}
__name(normalizeUrl, "normalizeUrl");
function normalizeBinding(input) {
  const value = isPlainObject(input) ? input : {};
  const format = String(value.format || value.protocol || "").trim();
  const authMode = String(value.authMode || "bearer").trim();
  if (!SUPPORTED_PROVIDER_FORMATS.includes(format)) {
    const err = new Error("unsupported provider format");
    err.code = "unsupported_format";
    throw err;
  }
  if (!SUPPORTED_AUTH_MODES.includes(authMode)) {
    const err = new Error("unsupported auth mode");
    err.code = "invalid_binding";
    throw err;
  }
  const apiUrl = normalizeUrl(value.apiUrl, "apiUrl");
  const modelsUrl = value.modelsUrl ? normalizeUrl(value.modelsUrl, "modelsUrl") : "";
  return {
    formatVersion: Number(value.formatVersion || 1),
    format,
    apiUrl,
    modelsUrl,
    authMode
  };
}
__name(normalizeBinding, "normalizeBinding");
function bindingMatches(a, b) {
  try {
    return canonicalJson(normalizeBinding(a)) === canonicalJson(normalizeBinding(b));
  } catch (_) {
    return false;
  }
}
__name(bindingMatches, "bindingMatches");

// ../../../../../Users/linus/CODE/bdc-extension-ai-proof-20261105/cloudflare-worker/src/ai-credentials.js
var CREDENTIAL_LIMITS = {
  maxProvidersPerUser: 200,
  maxPutBytes: 32 * 1024,
  maxDeleteBytes: 8 * 1024,
  maxKeyBytes: 8 * 1024
};
var RESERVED_IDS = /* @__PURE__ */ new Set(["default", "__proto__", "prototype", "constructor"]);
var PROVIDER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
function isReservedProviderId(id) {
  const value = String(id || "");
  return RESERVED_IDS.has(value) || value.startsWith("managed-");
}
__name(isReservedProviderId, "isReservedProviderId");
function isValidProviderId(id) {
  const value = String(id || "");
  return PROVIDER_ID_RE.test(value) && !isReservedProviderId(value);
}
__name(isValidProviderId, "isValidProviderId");
function isValidMutationId(id) {
  return /^[A-Za-z0-9_-]{8,128}$/.test(String(id || ""));
}
__name(isValidMutationId, "isValidMutationId");
function evaluateReplay(existing, incoming) {
  if (!existing) return { replay: false, conflict: false };
  if (!incoming || !incoming.mutationId) return { replay: false, conflict: false };
  if (existing.last_mutation_id !== incoming.mutationId) {
    if (Number(existing.version) !== Number(incoming.expectedVersion)) return { replay: false, conflict: true };
    return { replay: false, conflict: false };
  }
  const sameBinding = canonicalJson(existing.binding || {}) === canonicalJson(incoming.binding || {});
  const sameKey = typeof incoming.apiKey === "string" ? existing.apiKey === incoming.apiKey : existing.deleted === true;
  if (sameBinding && sameKey) return { replay: true, conflict: false };
  return { replay: false, conflict: true };
}
__name(evaluateReplay, "evaluateReplay");
function parseProviderId(raw) {
  let id = "";
  try {
    id = decodeURIComponent(String(raw || ""));
  } catch (_) {
    id = "";
  }
  return id;
}
__name(parseProviderId, "parseProviderId");
function rowToMeta(row) {
  return {
    providerId: row.provider_id,
    version: Number(row.version),
    deleted: Number(row.deleted) === 1,
    updatedAt: row.updated_at,
    lastMutationId: row.last_mutation_id
  };
}
__name(rowToMeta, "rowToMeta");
function rowToResult(row) {
  return {
    providerId: row.provider_id,
    version: Number(row.version),
    deleted: Number(row.deleted) === 1,
    updatedAt: row.updated_at,
    lastMutationId: row.last_mutation_id
  };
}
__name(rowToResult, "rowToResult");
async function selectRow(env, userId, providerId) {
  return env.DB.prepare("SELECT user_id, provider_id, binding_json, key_ciphertext, nonce, key_version, version, deleted, last_mutation_id, updated_at FROM user_ai_credentials WHERE user_id = ? AND provider_id = ?").bind(userId, providerId).first();
}
__name(selectRow, "selectRow");
async function decryptRow(env, userId, row) {
  if (!row || Number(row.deleted) === 1 || !row.key_ciphertext) return "";
  let binding = {};
  try {
    binding = JSON.parse(row.binding_json || "{}");
  } catch (_) {
    binding = {};
  }
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
__name(decryptRow, "decryptRow");
async function listHandler(ctx) {
  const { env, request, user } = ctx;
  const result = await env.DB.prepare("SELECT provider_id, binding_json, version, deleted, updated_at, last_mutation_id FROM user_ai_credentials WHERE user_id = ? ORDER BY provider_id").bind(user.user_id).all();
  const items = (result && result.results ? result.results : []).map((row) => {
    let binding = {};
    try {
      binding = JSON.parse(row.binding_json || "{}");
    } catch (_) {
      binding = {};
    }
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
__name(listHandler, "listHandler");
async function getHandler(ctx, providerId) {
  const { env, request, user } = ctx;
  const row = await selectRow(env, user.user_id, providerId);
  if (!row) return errorJson("credential_not_found", 404, env, request);
  if (Number(row.deleted) === 1) {
    return json({
      providerId,
      ...rowToMeta(row),
      apiKey: null,
      binding: (() => {
        try {
          return JSON.parse(row.binding_json || "{}");
        } catch (_) {
          return {};
        }
      })()
    }, 200, env, request);
  }
  let apiKey;
  try {
    apiKey = await decryptRow(env, user.user_id, row);
  } catch (error) {
    if (error && error.code === "credential_unavailable") {
      return errorJson("credential_unavailable", 503, env, request);
    }
    return errorJson("credential_decrypt_failed", 500, env, request);
  }
  let binding = {};
  try {
    binding = JSON.parse(row.binding_json || "{}");
  } catch (_) {
    binding = {};
  }
  return json({
    providerId,
    ...rowToMeta(row),
    apiKey,
    binding
  }, 200, env, request);
}
__name(getHandler, "getHandler");
async function putHandler(ctx, providerId) {
  const { env, request, user } = ctx;
  const limit = rateLimit(`cred-put:${user.user_id}`, 120, 60 * 1e3);
  if (!limit.ok) {
    return json({ error: "rate_limited", code: "rate_limited" }, 429, env, request, { "Retry-After": String(limit.retryAfter) });
  }
  let body;
  try {
    body = await readJsonBody(request, CREDENTIAL_LIMITS.maxPutBytes);
  } catch (error) {
    return errorJson(error.code || "bad_json", error.status || 400, env, request);
  }
  const expectedVersion = Number(body.expectedVersion);
  const mutationId = String(body.mutationId || "");
  const apiKey = typeof body.apiKey === "string" ? body.apiKey : "";
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    return errorJson("invalid_expected_version", 400, env, request);
  }
  if (!isValidMutationId(mutationId)) {
    return errorJson("invalid_mutation_id", 400, env, request);
  }
  if (!apiKey.trim()) return errorJson("api_key_required", 400, env, request);
  if (new TextEncoder().encode(apiKey).length > CREDENTIAL_LIMITS.maxKeyBytes) {
    return errorJson("api_key_too_large", 413, env, request);
  }
  let binding;
  try {
    binding = normalizeBinding(body.binding);
  } catch (error) {
    return errorJson(error.code || "invalid_binding", 400, env, request);
  }
  if (binding.authMode === "none") {
    return errorJson("key_not_required", 400, env, request);
  }
  const existing = await selectRow(env, user.user_id, providerId);
  let existingKey = "";
  if (existing) {
    try {
      existingKey = await decryptRow(env, user.user_id, existing);
    } catch (error) {
      if (error && error.code === "credential_unavailable") {
        return errorJson("credential_unavailable", 503, env, request);
      }
      return errorJson("credential_decrypt_failed", 500, env, request);
    }
  }
  const replay = evaluateReplay(
    existing ? {
      version: Number(existing.version),
      deleted: Number(existing.deleted) === 1,
      last_mutation_id: existing.last_mutation_id,
      binding: (() => {
        try {
          return JSON.parse(existing.binding_json || "{}");
        } catch (_) {
          return {};
        }
      })(),
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
      error: "version_conflict",
      code: "version_conflict",
      ...rowToMeta(existing)
    }, 409, env, request);
  }
  if (!existing && expectedVersion !== 0) {
    return json({ error: "version_conflict", code: "version_conflict", version: 0, deleted: false }, 409, env, request);
  }
  if (existing && expectedVersion !== Number(existing.version)) {
    return json({
      error: "version_conflict",
      code: "version_conflict",
      ...rowToMeta(existing)
    }, 409, env, request);
  }
  if (!existing) {
    const countRow = await env.DB.prepare("SELECT COUNT(*) AS n FROM user_ai_credentials WHERE user_id = ?").bind(user.user_id).first();
    if (Number(countRow && countRow.n) >= CREDENTIAL_LIMITS.maxProvidersPerUser) {
      return errorJson("provider_limit_reached", 429, env, request);
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
    if (error && error.code === "credential_unavailable") {
      return errorJson("credential_unavailable", 503, env, request);
    }
    return errorJson("credential_encrypt_failed", 500, env, request);
  }
  const updatedAt = (/* @__PURE__ */ new Date()).toISOString();
  const bindingJson = JSON.stringify(binding);
  try {
    if (!existing) {
      await env.DB.prepare("INSERT INTO user_ai_credentials (user_id, provider_id, binding_json, key_ciphertext, nonce, key_version, version, deleted, last_mutation_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)").bind(user.user_id, providerId, bindingJson, envelope.ciphertext, envelope.nonce, envelope.keyVersion, nextVersion, mutationId, updatedAt).run();
    } else {
      const result = await env.DB.prepare("UPDATE user_ai_credentials SET binding_json = ?, key_ciphertext = ?, nonce = ?, key_version = ?, version = ?, deleted = 0, last_mutation_id = ?, updated_at = ? WHERE user_id = ? AND provider_id = ? AND version = ?").bind(bindingJson, envelope.ciphertext, envelope.nonce, envelope.keyVersion, nextVersion, mutationId, updatedAt, user.user_id, providerId, expectedVersion).run();
      if (!result || !result.meta || Number(result.meta.changes) === 0) {
        const fresh = await selectRow(env, user.user_id, providerId);
        return json({
          error: "version_conflict",
          code: "version_conflict",
          ...fresh ? rowToMeta(fresh) : { version: 0 }
        }, 409, env, request);
      }
    }
  } catch (error) {
    const fresh = await selectRow(env, user.user_id, providerId).catch(() => null);
    if (fresh) {
      return json({
        error: "version_conflict",
        code: "version_conflict",
        ...rowToMeta(fresh)
      }, 409, env, request);
    }
    return errorJson("credential_write_failed", 500, env, request);
  }
  return json({
    providerId,
    version: nextVersion,
    deleted: false,
    updatedAt,
    lastMutationId: mutationId
  }, 200, env, request);
}
__name(putHandler, "putHandler");
async function deleteHandler(ctx, providerId) {
  const { env, request, user } = ctx;
  let body;
  try {
    body = await readJsonBody(request, CREDENTIAL_LIMITS.maxDeleteBytes);
  } catch (error) {
    return errorJson(error.code || "bad_json", error.status || 400, env, request);
  }
  const expectedVersion = Number(body.expectedVersion);
  const mutationId = String(body.mutationId || "");
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    return errorJson("invalid_expected_version", 400, env, request);
  }
  if (!isValidMutationId(mutationId)) {
    return errorJson("invalid_mutation_id", 400, env, request);
  }
  const existing = await selectRow(env, user.user_id, providerId);
  if (!existing) return errorJson("credential_not_found", 404, env, request);
  let existingKey = "";
  try {
    existingKey = await decryptRow(env, user.user_id, existing);
  } catch (error) {
    if (error && error.code === "credential_unavailable") {
      return errorJson("credential_unavailable", 503, env, request);
    }
    existingKey = "";
  }
  const replay = evaluateReplay(
    {
      version: Number(existing.version),
      deleted: Number(existing.deleted) === 1,
      last_mutation_id: existing.last_mutation_id,
      binding: (() => {
        try {
          return JSON.parse(existing.binding_json || "{}");
        } catch (_) {
          return {};
        }
      })(),
      apiKey: existingKey
    },
    { mutationId, expectedVersion, binding: (() => {
      try {
        return JSON.parse(existing.binding_json || "{}");
      } catch (_) {
        return {};
      }
    })(), apiKey: "" }
  );
  if (replay.replay) return json(rowToResult(existing), 200, env, request);
  if (replay.conflict) {
    return json({ error: "version_conflict", code: "version_conflict", ...rowToMeta(existing) }, 409, env, request);
  }
  if (expectedVersion !== Number(existing.version)) {
    return json({ error: "version_conflict", code: "version_conflict", ...rowToMeta(existing) }, 409, env, request);
  }
  const nextVersion = expectedVersion + 1;
  const updatedAt = (/* @__PURE__ */ new Date()).toISOString();
  const result = await env.DB.prepare("UPDATE user_ai_credentials SET key_ciphertext = NULL, nonce = NULL, key_version = NULL, version = ?, deleted = 1, last_mutation_id = ?, updated_at = ? WHERE user_id = ? AND provider_id = ? AND version = ?").bind(nextVersion, mutationId, updatedAt, user.user_id, providerId, expectedVersion).run();
  if (!result || !result.meta || Number(result.meta.changes) === 0) {
    const fresh = await selectRow(env, user.user_id, providerId);
    return json({
      error: "version_conflict",
      code: "version_conflict",
      ...fresh ? rowToMeta(fresh) : { version: 0 }
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
__name(deleteHandler, "deleteHandler");
async function handleCredentialsRoute(ctx) {
  const { rest, request, env, user } = ctx;
  if (!user || !user.user_id) return errorJson("unauthorized", 401, env, request);
  if (!rest) {
    if (request.method === "GET") return listHandler(ctx);
    return errorJson("method_not_allowed", 405, env, request);
  }
  const providerId = parseProviderId(rest.replace(/^\//, ""));
  if (!providerId || rest.split("/").length > 2) {
    return errorJson("invalid_provider_id", 400, env, request);
  }
  if (!isValidProviderId(providerId)) {
    return errorJson("invalid_provider_id", 400, env, request);
  }
  if (request.method === "GET") return getHandler(ctx, providerId);
  if (request.method === "PUT") return putHandler(ctx, providerId);
  if (request.method === "DELETE") return deleteHandler(ctx, providerId);
  return errorJson("method_not_allowed", 405, env, request);
}
__name(handleCredentialsRoute, "handleCredentialsRoute");

// ../../../../../Users/linus/CODE/bdc-extension-ai-proof-20261105/cloudflare-worker/src/ai-catalog.js
var CATALOG_LIMITS = {
  maxProviders: 30,
  maxPublishBytes: 512 * 1024,
  maxKeyBytes: 8 * 1024,
  historyKeep: 10,
  sessionTtlMs: 60 * 60 * 1e3
};
var PROVIDER_ID_RE2 = /^managed-[A-Za-z0-9_-]{4,64}$/;
var TASK_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
var MODEL_ID_MAX = 200;
var CAPABILITIES = /* @__PURE__ */ new Set(["yes", "no", "unknown"]);
var CAPABILITY_KEYS = ["text", "images", "json", "stream", "models"];
function failure(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}
__name(failure, "failure");
function normalizeModel(raw) {
  if (typeof raw === "string") {
    const id2 = raw.trim();
    if (!id2 || id2.length > MODEL_ID_MAX) throw failure("invalid_model", "invalid model id");
    return { id: id2, label: id2, capabilities: {} };
  }
  if (!isPlainObject(raw)) throw failure("invalid_model", "invalid model entry");
  const id = String(raw.id || raw.model || "").trim();
  if (!id || id.length > MODEL_ID_MAX) throw failure("invalid_model", "invalid model id");
  const capabilities = {};
  if (isPlainObject(raw.capabilities)) {
    for (const key of CAPABILITY_KEYS) {
      const value = String(raw.capabilities[key] || "").trim();
      if (CAPABILITIES.has(value)) capabilities[key] = value;
    }
  }
  return {
    id,
    label: String(raw.label || raw.name || id).slice(0, 200),
    capabilities
  };
}
__name(normalizeModel, "normalizeModel");
function validateCatalogConfig(input) {
  if (!isPlainObject(input)) throw failure("invalid_catalog", "catalog must be an object");
  const providersRaw = Array.isArray(input.providers) ? input.providers : [];
  if (providersRaw.length > CATALOG_LIMITS.maxProviders) throw failure("provider_limit_exceeded", "too many providers");
  const seen = /* @__PURE__ */ new Set();
  const providers = providersRaw.map((raw, index) => {
    if (!isPlainObject(raw)) throw failure("invalid_provider", "provider must be an object");
    const id = String(raw.id || "").trim();
    if (!PROVIDER_ID_RE2.test(id)) throw failure("invalid_provider_id", "provider id must use the managed- namespace");
    if (seen.has(id)) throw failure("duplicate_provider_id", "duplicate provider id");
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
      throw failure(error.code || "invalid_binding", "provider binding invalid");
    }
    const models = (Array.isArray(raw.models) ? raw.models : []).map(normalizeModel);
    const modelIds = /* @__PURE__ */ new Set();
    for (const model of models) {
      if (modelIds.has(model.id)) throw failure("duplicate_model_id", "duplicate model id");
      modelIds.add(model.id);
    }
    return {
      id,
      name: String(raw.name || id).slice(0, 120),
      enabled: raw.enabled !== false,
      order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : index,
      baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl.slice(0, 500) : "",
      ...binding,
      models
    };
  });
  const tasksRaw = isPlainObject(input.tasks) ? input.tasks : {};
  const tasks = {};
  for (const [task, spec] of Object.entries(tasksRaw)) {
    if (!TASK_NAME_RE.test(task)) throw failure("invalid_task", "invalid task name");
    if (spec === null || spec === void 0) {
      tasks[task] = null;
      continue;
    }
    if (!isPlainObject(spec)) throw failure("invalid_task_reference", "task reference must be an object");
    const providerId = String(spec.providerId || "").trim();
    const model = String(spec.model || "").trim();
    const provider = providers.find((item) => item.id === providerId);
    if (!provider) throw failure("dangling_task_reference", `task ${task} references an unknown provider`);
    if (!model || !provider.models.some((item) => item.id === model)) {
      throw failure("dangling_task_reference", `task ${task} references an unknown model`);
    }
    tasks[task] = { providerId, model };
  }
  return {
    schemaVersion: 1,
    providers,
    tasks
  };
}
__name(validateCatalogConfig, "validateCatalogConfig");
function validateKeyOps(input, providers) {
  const ops = isPlainObject(input) ? input : {};
  const out = {};
  for (const provider of providers) {
    const op = ops[provider.id];
    const action = isPlainObject(op) ? String(op.action || "preserve") : "preserve";
    if (!["preserve", "replace", "clear"].includes(action)) {
      throw failure("invalid_key_operation", "invalid key operation");
    }
    if (action === "replace") {
      const apiKey = typeof op.apiKey === "string" ? op.apiKey : "";
      if (!apiKey.trim()) throw failure("api_key_required", "replacement key missing");
      if (new TextEncoder().encode(apiKey).length > CATALOG_LIMITS.maxKeyBytes) {
        throw failure("api_key_too_large", "replacement key too large");
      }
      out[provider.id] = { action, apiKey };
    } else {
      out[provider.id] = { action };
    }
  }
  return out;
}
__name(validateKeyOps, "validateKeyOps");
function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}
__name(parseJson, "parseJson");
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
        binding: envelope && envelope.binding || null
      }
    ])),
    publishedBy: row.published_by,
    publishedAt: row.published_at
  };
}
__name(releaseRowToAdmin, "releaseRowToAdmin");
async function getLatestRelease(env) {
  return env.DB.prepare("SELECT version, config_json, credentials_json, mutation_id, request_digest, published_by, published_at FROM ai_default_catalog_releases ORDER BY version DESC LIMIT 1").first();
}
__name(getLatestRelease, "getLatestRelease");
async function getReleaseByMutation(env, mutationId) {
  return env.DB.prepare("SELECT version, config_json, credentials_json, mutation_id, request_digest, published_by, published_at FROM ai_default_catalog_releases WHERE mutation_id = ?").bind(mutationId).first();
}
__name(getReleaseByMutation, "getReleaseByMutation");
function sessionWindow() {
  const verifiedAt = Date.now();
  return {
    verifiedAt: new Date(verifiedAt).toISOString(),
    expiresAt: new Date(verifiedAt + CATALOG_LIMITS.sessionTtlMs).toISOString()
  };
}
__name(sessionWindow, "sessionWindow");
function publicCatalog(config, version, release) {
  const providers = (config.providers || []).filter((provider) => provider.enabled !== false).sort((a, b) => Number(a.order || 0) - Number(b.order || 0)).map((provider) => ({
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
    if (!spec) {
      tasks[task] = null;
      continue;
    }
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
__name(publicCatalog, "publicCatalog");
async function catalogHandler(ctx) {
  const { env, request, user } = ctx;
  const limit = rateLimit(`catalog:${user.user_id}`, 120, 60 * 1e3);
  if (!limit.ok) {
    return json({ error: "rate_limited", code: "rate_limited" }, 429, env, request, { "Retry-After": String(limit.retryAfter) });
  }
  const release = await getLatestRelease(env);
  if (!release) return json(publicCatalog({ providers: [], tasks: {} }, 0, null), 200, env, request);
  const config = parseJson(release.config_json, { schemaVersion: 1, providers: [], tasks: {} });
  return json(publicCatalog(config, release.version, release), 200, env, request);
}
__name(catalogHandler, "catalogHandler");
async function catalogCredentialHandler(ctx, providerId) {
  const { env, request, user, url } = ctx;
  const limit = rateLimit(`catalog-key:${user.user_id}`, 120, 60 * 1e3);
  if (!limit.ok) {
    return json({ error: "rate_limited", code: "rate_limited" }, 429, env, request, { "Retry-After": String(limit.retryAfter) });
  }
  const requestedVersion = Number(url.searchParams.get("catalogVersion"));
  if (!Number.isInteger(requestedVersion) || requestedVersion < 1) {
    return errorJson("catalog_version_required", 400, env, request);
  }
  const release = await getLatestRelease(env);
  if (!release) return errorJson("catalog_empty", 404, env, request);
  if (Number(release.version) !== requestedVersion) {
    return json({
      error: "catalog_version_conflict",
      code: "catalog_version_conflict",
      version: Number(release.version)
    }, 409, env, request);
  }
  const config = parseJson(release.config_json, { providers: [], tasks: {} });
  const provider = (config.providers || []).find((item) => item.id === providerId);
  if (!provider || provider.enabled === false) {
    return errorJson("provider_unavailable", 404, env, request);
  }
  const binding = {
    formatVersion: provider.formatVersion,
    format: provider.format,
    apiUrl: provider.apiUrl,
    modelsUrl: provider.modelsUrl,
    authMode: provider.authMode
  };
  if (provider.authMode === "none") {
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
    return errorJson("credential_missing", 404, env, request);
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
    if (error && error.code === "credential_unavailable") {
      return errorJson("credential_unavailable", 503, env, request);
    }
    return errorJson("credential_decrypt_failed", 500, env, request);
  }
}
__name(catalogCredentialHandler, "catalogCredentialHandler");
async function adminCatalogHandler(ctx) {
  const { env, request } = ctx;
  const release = await getLatestRelease(env);
  const payload = releaseRowToAdmin(release);
  return json(payload || {
    version: 0,
    config: { schemaVersion: 1, providers: [], tasks: {} },
    credentials: {},
    publishedBy: "",
    publishedAt: null
  }, 200, env, request);
}
__name(adminCatalogHandler, "adminCatalogHandler");
async function adminHistoryHandler(ctx) {
  const { env, request } = ctx;
  const result = await env.DB.prepare("SELECT version, config_json, published_by, published_at FROM ai_default_catalog_releases ORDER BY version DESC LIMIT ?").bind(CATALOG_LIMITS.historyKeep).all();
  const items = (result && result.results ? result.results : []).map((row) => ({
    version: Number(row.version),
    config: parseJson(row.config_json, { schemaVersion: 1, providers: [], tasks: {} }),
    publishedBy: row.published_by,
    publishedAt: row.published_at
  }));
  return json({ items }, 200, env, request);
}
__name(adminHistoryHandler, "adminHistoryHandler");
async function publishHandler(ctx) {
  const { env, request, user } = ctx;
  const limit = rateLimit(`catalog-publish:${user.user_id}`, 20, 60 * 1e3);
  if (!limit.ok) {
    return json({ error: "rate_limited", code: "rate_limited" }, 429, env, request, { "Retry-After": String(limit.retryAfter) });
  }
  let body;
  try {
    body = await readJsonBody(request, CATALOG_LIMITS.maxPublishBytes);
  } catch (error) {
    return errorJson(error.code || "bad_json", error.status || 400, env, request);
  }
  const baseVersion = Number(body.baseVersion);
  const mutationId = String(body.mutationId || "");
  if (!Number.isInteger(baseVersion) || baseVersion < 0) return errorJson("invalid_base_version", 400, env, request);
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(mutationId)) return errorJson("invalid_mutation_id", 400, env, request);
  let config;
  try {
    config = validateCatalogConfig(body.config);
  } catch (error) {
    return errorJson(error.code || "invalid_catalog", 400, env, request);
  }
  let keyOps;
  try {
    keyOps = validateKeyOps(body.keyOps, config.providers);
  } catch (error) {
    return errorJson(error.code || "invalid_key_operation", 400, env, request);
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
    return errorJson("credential_unavailable", 503, env, request);
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
    return errorJson("mutation_conflict", 409, env, request);
  }
  if (baseVersion !== currentVersion) {
    return json({
      error: "catalog_version_conflict",
      code: "catalog_version_conflict",
      version: currentVersion
    }, 409, env, request);
  }
  const keyVersion = getCurrentKeyVersion(env);
  const credentials = {};
  try {
    for (const provider of config.providers) {
      const previous = currentCredentials[provider.id];
      const op = keyOps[provider.id] || { action: "preserve" };
      if (provider.authMode === "none") {
        if (op.action === "replace") throw failure("key_not_required", "this provider does not use a key");
        continue;
      }
      const binding = {
        formatVersion: provider.formatVersion,
        format: provider.format,
        apiUrl: provider.apiUrl,
        modelsUrl: provider.modelsUrl,
        authMode: provider.authMode
      };
      if (op.action === "clear") {
        if (provider.enabled !== false) throw failure("cannot_clear_enabled_provider_key", "disable the provider before clearing its key");
        continue;
      }
      if (op.action === "replace") {
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
      if (!previous || !previous.ciphertext) throw failure("api_key_required", "provider needs a key");
      if (!bindingMatches(previous.binding, binding)) throw failure("binding_changed_requires_key", "endpoint changed; confirm the key for the new endpoint");
      credentials[provider.id] = previous;
    }
  } catch (error) {
    return errorJson(error.code || "credential_encrypt_failed", error.code === "credential_unavailable" ? 503 : 400, env, request);
  }
  const nextVersion = currentVersion + 1;
  const publishedAt = (/* @__PURE__ */ new Date()).toISOString();
  const configJson = JSON.stringify(config);
  const credentialsJson = JSON.stringify(credentials);
  try {
    const result = await env.DB.prepare("INSERT INTO ai_default_catalog_releases (version, config_json, credentials_json, mutation_id, request_digest, published_by, published_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(version) DO NOTHING").bind(nextVersion, configJson, credentialsJson, mutationId, digest, user.user_id, publishedAt).run();
    if (!result || !result.meta || Number(result.meta.changes) === 0) {
      const fresh = await getLatestRelease(env);
      return json({
        error: "catalog_version_conflict",
        code: "catalog_version_conflict",
        version: fresh ? Number(fresh.version) : 0
      }, 409, env, request);
    }
  } catch (error) {
    const byId = await getReleaseByMutation(env, mutationId).catch(() => null);
    if (byId) {
      if (byId.published_by === user.user_id && byId.request_digest === digest) {
        return json({ version: Number(byId.version), publishedAt: byId.published_at, idempotent: true }, 200, env, request);
      }
      return errorJson("mutation_conflict", 409, env, request);
    }
    return errorJson("publish_failed", 500, env, request);
  }
  try {
    await env.DB.prepare("DELETE FROM ai_default_catalog_releases WHERE version NOT IN (SELECT version FROM ai_default_catalog_releases ORDER BY version DESC LIMIT ?)").bind(CATALOG_LIMITS.historyKeep).run();
  } catch (_) {
  }
  return json({
    version: nextVersion,
    publishedAt,
    idempotent: false,
    credentialRevisions: Object.fromEntries(Object.entries(credentials).map(([id, envelope]) => [id, Number(envelope.credentialRevision) || 0]))
  }, 200, env, request);
}
__name(publishHandler, "publishHandler");
function restPath(path) {
  return path.replace(/\/+$/, "");
}
__name(restPath, "restPath");
async function handleCatalogRoute(ctx) {
  const { request, env, url, user } = ctx;
  const path = restPath(url.pathname);
  if (!user || !user.user_id) return errorJson("unauthorized", 401, env, request);
  if (path === "/ai-catalog" && request.method === "GET") return catalogHandler(ctx);
  const credentialMatch = path.match(/^\/ai-catalog\/providers\/([^/]+)\/credential$/);
  if (credentialMatch) {
    if (request.method !== "GET") return errorJson("method_not_allowed", 405, env, request);
    const providerId = decodeURIComponent(credentialMatch[1]);
    if (!PROVIDER_ID_RE2.test(providerId)) return errorJson("invalid_provider_id", 400, env, request);
    return catalogCredentialHandler(ctx, providerId);
  }
  if (path.startsWith("/admin/ai-catalog") || path.startsWith("/admin/")) {
    if (user.role !== "admin") return errorJson("admin_required", 403, env, request);
    if (path === "/admin/ai-catalog" && request.method === "GET") return adminCatalogHandler(ctx);
    if (path === "/admin/ai-catalog/history" && request.method === "GET") return adminHistoryHandler(ctx);
    if (path === "/admin/ai-catalog/publish" && request.method === "POST") return publishHandler(ctx);
    return errorJson("not_found", 404, env, request);
  }
  return errorJson("not_found", 404, env, request);
}
__name(handleCatalogRoute, "handleCatalogRoute");

// ../../../../../Users/linus/CODE/bdc-extension-ai-proof-20261105/cloudflare-worker/src/token.js
async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(sha256Hex, "sha256Hex");
function randomToken(byteLength) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
__name(randomToken, "randomToken");

// ../../../../../Users/linus/CODE/bdc-extension-ai-proof-20261105/cloudflare-worker/src/device-pairing.js
var PAIRING_CODE_LENGTH = 16;
var PAIRING_CODE_TTL_SECONDS = Object.freeze([600, 86400, 604800, 2592e3]);
var DEFAULT_PAIRING_CODE_TTL_SECONDS = 604800;
var PAIRING_CODE_TTL_MS = DEFAULT_PAIRING_CODE_TTL_SECONDS * 1e3;
var SESSION_TTL_MS = 180 * 24 * 60 * 60 * 1e3;
var PAIRING_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
var PAIRING_CODE_RE = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12,32}$/;
var USER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
var MAX_BODY_BYTES = 4 * 1024;
function randomPairingCode(length = PAIRING_CODE_LENGTH) {
  const size = Math.max(12, Math.min(32, Number(length) || PAIRING_CODE_LENGTH));
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  let code = "";
  for (const byte of bytes) code += PAIRING_ALPHABET[byte % PAIRING_ALPHABET.length];
  return code;
}
__name(randomPairingCode, "randomPairingCode");
function normalizePairingCode(value) {
  return String(value == null ? "" : value).toUpperCase().replace(/[^A-Z0-9]/g, "");
}
__name(normalizePairingCode, "normalizePairingCode");
async function pairingCodeRow(env, codeHash) {
  return env.DB.prepare("SELECT user_id, expires_at, used_at FROM pairing_codes WHERE code_hash = ?").bind(codeHash).first();
}
__name(pairingCodeRow, "pairingCodeRow");
async function handlePairRequest(ctx) {
  const { request, env } = ctx;
  const limit = rateLimit(`pair:${getClientKey(request, null)}`, 20, 10 * 60 * 1e3);
  if (!limit.ok) {
    return json({ error: "rate_limited", code: "rate_limited" }, 429, env, request, {
      "Retry-After": String(limit.retryAfter)
    });
  }
  let body;
  try {
    body = await readJsonBody(request, MAX_BODY_BYTES);
  } catch (error) {
    return errorJson(error.code || "bad_json", error.status || 400, env, request);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return errorJson("pairing_invalid", 403, env, request);
  }
  const userIdInput = String(body.userId || "").trim();
  const code = normalizePairingCode(body.code);
  if (!PAIRING_CODE_RE.test(code) || userIdInput && !USER_ID_RE.test(userIdInput)) {
    return errorJson("pairing_invalid", 403, env, request);
  }
  const now = /* @__PURE__ */ new Date();
  const nowIso3 = now.toISOString();
  const codeHash = await sha256Hex(code);
  const row = await pairingCodeRow(env, codeHash);
  if (!row || row.used_at || !(row.expires_at > nowIso3)) {
    return errorJson("pairing_invalid", 403, env, request);
  }
  if (userIdInput && row.user_id.toLowerCase() !== userIdInput.toLowerCase()) {
    return errorJson("pairing_invalid", 403, env, request);
  }
  const user = await env.DB.prepare("SELECT user_id, label, role, auth_version, is_active FROM users WHERE user_id = ?").bind(row.user_id).first();
  if (!user || user.role === "admin" || user.is_active === 0) {
    return errorJson("pairing_invalid", 403, env, request);
  }
  const consumed = await env.DB.prepare("UPDATE pairing_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL").bind(nowIso3, codeHash).run();
  if (!consumed || !consumed.meta || consumed.meta.changes !== 1) {
    return errorJson("pairing_invalid", 403, env, request);
  }
  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  const deviceLabel = String(body.deviceLabel || "").trim().slice(0, 80) || null;
  await env.DB.prepare("INSERT INTO user_sessions (token_hash, user_id, created_at, expires_at, device_label, auth_version) VALUES (?, ?, ?, ?, ?, ?)").bind(tokenHash, user.user_id, nowIso3, expiresAt, deviceLabel, user.auth_version ?? 1).run();
  return json({
    token,
    user_id: user.user_id,
    label: user.label || "",
    role: user.role === "admin" ? "admin" : "user",
    expires_at: expiresAt
  }, 200, env, request);
}
__name(handlePairRequest, "handlePairRequest");

// ../../../../../Users/linus/CODE/bdc-extension-ai-proof-20261105/cloudflare-worker/src/password.js
var PBKDF2_ITERATIONS = 5e4;
var PASSWORD_MIN_LENGTH = 10;
var ADMIN_PASSWORD_MIN_LENGTH = 12;
var PASSWORD_MAX_LENGTH = 200;
var USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
var PASSWORD_SCHEME = "pbkdf2-sha256";
var PEPPER_MIN_LENGTH = 32;
var encoder = new TextEncoder();
function normalizeUsername(value) {
  return String(value == null ? "" : value).trim().normalize("NFKC").toLowerCase();
}
__name(normalizeUsername, "normalizeUsername");
function validateUsername(value) {
  const username = normalizeUsername(value);
  if (!username) return "username_required";
  if (!USERNAME_RE.test(username)) return "invalid_username";
  return "";
}
__name(validateUsername, "validateUsername");
function passwordMinLength(role) {
  return role === "admin" ? ADMIN_PASSWORD_MIN_LENGTH : PASSWORD_MIN_LENGTH;
}
__name(passwordMinLength, "passwordMinLength");
function validatePassword(password, role) {
  const value = String(password == null ? "" : password);
  if (!value) return "password_required";
  if (value.length < passwordMinLength(role)) return "weak_password";
  if (value.length > PASSWORD_MAX_LENGTH) return "invalid_password";
  return "";
}
__name(validatePassword, "validatePassword");
function isPasswordPepperConfigured(env) {
  const pepper = env && env.PASSWORD_PEPPER;
  return typeof pepper === "string" && pepper.length >= PEPPER_MIN_LENGTH;
}
__name(isPasswordPepperConfigured, "isPasswordPepperConfigured");
function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
__name(bytesToBase64Url, "bytesToBase64Url");
function base64UrlToBytes(value) {
  const text = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = text + "===".slice((text.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
__name(base64UrlToBytes, "base64UrlToBytes");
function concatBytes(left, right) {
  const out = new Uint8Array(left.length + right.length);
  out.set(left, 0);
  out.set(right, left.length);
  return out;
}
__name(concatBytes, "concatBytes");
function timingSafeEqual(left, right) {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}
__name(timingSafeEqual, "timingSafeEqual");
async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(String(password)),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    256
  );
  return new Uint8Array(bits);
}
__name(derive, "derive");
async function pepperMac(pepper, salt, derived) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, concatBytes(salt, derived));
  return new Uint8Array(mac);
}
__name(pepperMac, "pepperMac");
async function hashPassword(password, pepper, iterations = PBKDF2_ITERATIONS) {
  if (!pepper) throw new Error("password pepper missing");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const derived = await derive(password, salt, iterations);
  const mac = await pepperMac(pepper, salt, derived);
  return `${PASSWORD_SCHEME}$${iterations}$${bytesToBase64Url(salt)}$${bytesToBase64Url(mac)}`;
}
__name(hashPassword, "hashPassword");
async function verifyPassword(password, encoded, pepper) {
  if (!pepper) return false;
  const parts = String(encoded || "").split("$");
  if (parts.length !== 4 || parts[0] !== PASSWORD_SCHEME) return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1e3 || iterations > 1e6) return false;
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
__name(verifyPassword, "verifyPassword");

// ../../../../../Users/linus/CODE/bdc-extension-ai-proof-20261105/cloudflare-worker/src/admin-users.js
var USER_ID_RE2 = /^[A-Za-z0-9_-]{1,64}$/;
var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
var MAX_LABEL_LENGTH = 120;
var MAX_EMAIL_LENGTH = 254;
var MAX_BODY_BYTES2 = 8 * 1024;
var USER_LIST_LIMIT = 1e3;
function normalizeEmail(value) {
  return String(value == null ? "" : value).trim().toLowerCase();
}
__name(normalizeEmail, "normalizeEmail");
function isValidEmail(email) {
  if (!email) return true;
  return email.length <= MAX_EMAIL_LENGTH && EMAIL_RE.test(email);
}
__name(isValidEmail, "isValidEmail");
function toUserJson(row) {
  return {
    userId: row.user_id,
    label: row.label || "",
    role: row.role === "admin" ? "admin" : "user",
    email: row.email || "",
    username: row.username || "",
    hasPassword: Boolean(row.password_hash),
    createdAt: row.created_at || null
  };
}
__name(toUserJson, "toUserJson");
function rateLimited(env, request, retryAfter) {
  return json({ error: "rate_limited", code: "rate_limited" }, 429, env, request, {
    "Retry-After": String(retryAfter)
  });
}
__name(rateLimited, "rateLimited");
function auditStatement(env, actorUserId, action, targetUserId, detail, createdAt) {
  return env.DB.prepare("INSERT INTO admin_audit_log (actor_user_id, action, target_user_id, detail_json, created_at) VALUES (?, ?, ?, ?, ?)").bind(actorUserId, action, targetUserId, JSON.stringify(detail || {}), createdAt);
}
__name(auditStatement, "auditStatement");
async function runWithAudit(env, statements) {
  if (typeof env.DB.batch === "function") return env.DB.batch(statements);
  const results = [];
  for (const statement of statements) results.push(await statement.run());
  return results;
}
__name(runWithAudit, "runWithAudit");
function isUniqueError(error) {
  return /unique|constraint/i.test(String(error && error.message));
}
__name(isUniqueError, "isUniqueError");
function findUserById(env, userId) {
  return env.DB.prepare("SELECT user_id, label, role, email, created_at, username, username_normalized, password_hash, password_updated_at, auth_version, is_active FROM users WHERE user_id = ?").bind(userId).first();
}
__name(findUserById, "findUserById");
function decodeUserId(value) {
  try {
    return decodeURIComponent(value);
  } catch (_) {
    return "";
  }
}
__name(decodeUserId, "decodeUserId");
async function listUsersHandler(ctx) {
  const { request, env, user } = ctx;
  const limit = rateLimit(`admin-users-list:${user.user_id}`, 120, 60 * 1e3);
  if (!limit.ok) return rateLimited(env, request, limit.retryAfter);
  const result = await env.DB.prepare("SELECT user_id, label, role, email, created_at, username, password_hash FROM users ORDER BY (created_at IS NULL) ASC, created_at DESC, user_id ASC LIMIT ?").bind(USER_LIST_LIMIT).all();
  const users = (result && result.results ? result.results : []).map(toUserJson);
  return json({ users, currentUserId: user.user_id }, 200, env, request);
}
__name(listUsersHandler, "listUsersHandler");
async function createUserHandler(ctx) {
  const { request, env, user } = ctx;
  const limit = rateLimit(`admin-users-create:${user.user_id}`, 20, 60 * 1e3);
  if (!limit.ok) return rateLimited(env, request, limit.retryAfter);
  let body;
  try {
    body = await readJsonBody(request, MAX_BODY_BYTES2);
  } catch (error) {
    return errorJson(error.code || "bad_json", error.status || 400, env, request);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return errorJson("bad_json", 400, env, request);
  }
  const userId = String(body.userId || "").trim();
  if (!USER_ID_RE2.test(userId)) return errorJson("invalid_user_id", 400, env, request);
  const label = String(body.label || "").trim();
  if (label.length > MAX_LABEL_LENGTH) return errorJson("invalid_label", 400, env, request);
  const email = normalizeEmail(body.email);
  if (!isValidEmail(email)) return errorJson("invalid_email", 400, env, request);
  const usernameInput = String(body.username == null ? "" : body.username).trim();
  const passwordInput = String(body.password == null ? "" : body.password);
  let username = "";
  if (usernameInput) {
    const usernameError = validateUsername(usernameInput);
    if (usernameError) return errorJson(usernameError, 400, env, request);
    username = normalizeUsername(usernameInput);
    if (!passwordInput) return errorJson("password_required", 400, env, request);
    const passwordError = validatePassword(passwordInput, "user");
    if (passwordError) return errorJson(passwordError, 400, env, request);
    if (!isPasswordPepperConfigured(env)) return errorJson("password_not_configured", 503, env, request);
  } else if (passwordInput) {
    return errorJson("username_required", 400, env, request);
  }
  if (await findUserById(env, userId)) return errorJson("user_exists", 409, env, request);
  if (email) {
    const emailOwner = await env.DB.prepare("SELECT user_id FROM users WHERE email = ?").bind(email).first();
    if (emailOwner) return errorJson("email_exists", 409, env, request);
  }
  if (username) {
    const usernameOwner = await env.DB.prepare("SELECT user_id FROM users WHERE username_normalized = ?").bind(username).first();
    if (usernameOwner) return errorJson("username_exists", 409, env, request);
  }
  const passcode = randomToken(32);
  const recoveryCode = randomToken(24);
  const passcodeHash = await sha256Hex(passcode);
  const recoveryHash = await sha256Hex(recoveryCode);
  const createdAt = (/* @__PURE__ */ new Date()).toISOString();
  const passwordHash = username ? await hashPassword(passwordInput, env.PASSWORD_PEPPER) : null;
  const passwordUpdatedAt = passwordHash ? createdAt : null;
  const insert = env.DB.prepare("INSERT INTO users (token_hash, user_id, label, recovery_hash, role, email, created_at, username, username_normalized, password_hash, password_updated_at, auth_version, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)").bind(passcodeHash, userId, label, recoveryHash, "user", email || null, createdAt, username || null, username || null, passwordHash, passwordUpdatedAt);
  const audit = auditStatement(env, user.user_id, "user_create", userId, {
    role: "user",
    hasEmail: Boolean(email),
    username: username || null,
    hasPassword: Boolean(passwordHash)
  }, createdAt);
  try {
    await runWithAudit(env, [insert, audit]);
  } catch (error) {
    if (isUniqueError(error)) {
      if (await findUserById(env, userId)) return errorJson("user_exists", 409, env, request);
      if (email) {
        const emailOwner = await env.DB.prepare("SELECT user_id FROM users WHERE email = ?").bind(email).first();
        if (emailOwner) return errorJson("email_exists", 409, env, request);
      }
      if (username) {
        const usernameOwner = await env.DB.prepare("SELECT user_id FROM users WHERE username_normalized = ?").bind(username).first();
        if (usernameOwner) return errorJson("username_exists", 409, env, request);
      }
    }
    throw error;
  }
  return json({
    user: {
      userId,
      label,
      role: "user",
      email,
      username,
      hasPassword: Boolean(passwordHash),
      createdAt
    },
    passcode,
    recoveryCode
  }, 201, env, request);
}
__name(createUserHandler, "createUserHandler");
async function updateUserHandler(ctx, userId) {
  const { request, env, user } = ctx;
  const limit = rateLimit(`admin-users-update:${user.user_id}`, 60, 60 * 1e3);
  if (!limit.ok) return rateLimited(env, request, limit.retryAfter);
  if (!USER_ID_RE2.test(userId)) return errorJson("invalid_user_id", 400, env, request);
  const row = await findUserById(env, userId);
  if (!row) return errorJson("user_not_found", 404, env, request);
  let body;
  try {
    body = await readJsonBody(request, MAX_BODY_BYTES2);
  } catch (error) {
    return errorJson(error.code || "bad_json", error.status || 400, env, request);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return errorJson("bad_json", 400, env, request);
  }
  const label = body.label === void 0 ? row.label || "" : String(body.label == null ? "" : body.label).trim();
  if (label.length > MAX_LABEL_LENGTH) return errorJson("invalid_label", 400, env, request);
  const email = body.email === void 0 ? row.email || "" : normalizeEmail(body.email);
  if (!isValidEmail(email)) return errorJson("invalid_email", 400, env, request);
  const usernameInput = body.username === void 0 ? row.username || "" : String(body.username == null ? "" : body.username).trim();
  let username = "";
  if (usernameInput) {
    const usernameError = validateUsername(usernameInput);
    if (usernameError) return errorJson(usernameError, 400, env, request);
    username = normalizeUsername(usernameInput);
  }
  const newPassword = String(body.newPassword == null ? "" : body.newPassword);
  if (newPassword) {
    const passwordError = validatePassword(newPassword, row.role);
    if (passwordError) return errorJson(passwordError, 400, env, request);
    if (!username) return errorJson("username_required", 400, env, request);
    if (!isPasswordPepperConfigured(env)) return errorJson("password_not_configured", 503, env, request);
  }
  if (!username && row.password_hash) return errorJson("username_required", 400, env, request);
  if (email && email !== (row.email || "")) {
    const emailOwner = await env.DB.prepare("SELECT user_id FROM users WHERE email = ? AND user_id <> ?").bind(email, userId).first();
    if (emailOwner) return errorJson("email_exists", 409, env, request);
  }
  const currentUsername = row.username_normalized || normalizeUsername(row.username || "");
  if (username && username !== currentUsername) {
    const usernameOwner = await env.DB.prepare("SELECT user_id FROM users WHERE username_normalized = ? AND user_id <> ?").bind(username, userId).first();
    if (usernameOwner) return errorJson("username_exists", 409, env, request);
  }
  const labelChanged = label !== (row.label || "");
  const emailChanged = email !== (row.email || "");
  const usernameChanged = username !== currentUsername;
  const passwordChanged = Boolean(newPassword);
  if (!labelChanged && !emailChanged && !usernameChanged && !passwordChanged) {
    return json({ user: toUserJson(row) }, 200, env, request);
  }
  const changedAt = (/* @__PURE__ */ new Date()).toISOString();
  let passwordHash = row.password_hash || null;
  let passwordUpdatedAt = row.password_updated_at || null;
  let authVersion = Number(row.auth_version) || 1;
  if (passwordChanged) {
    passwordHash = await hashPassword(newPassword, env.PASSWORD_PEPPER);
    passwordUpdatedAt = changedAt;
    authVersion += 1;
  }
  const update = env.DB.prepare("UPDATE users SET label = ?, email = ?, username = ?, username_normalized = ?, password_hash = ?, password_updated_at = ?, auth_version = ? WHERE user_id = ?").bind(label, email || null, username || null, username || null, passwordHash, passwordUpdatedAt, authVersion, userId);
  const statements = [update];
  if (passwordChanged) {
    statements.push(env.DB.prepare("DELETE FROM user_sessions WHERE user_id = ?").bind(userId));
    statements.push(env.DB.prepare("DELETE FROM pairing_codes WHERE user_id = ? AND used_at IS NULL").bind(userId));
  }
  statements.push(auditStatement(env, user.user_id, "user_update", userId, {
    labelChanged,
    emailChanged,
    usernameChanged,
    passwordChanged
  }, changedAt));
  try {
    await runWithAudit(env, statements);
  } catch (error) {
    if (isUniqueError(error)) {
      if (email) return errorJson("email_exists", 409, env, request);
      if (username) return errorJson("username_exists", 409, env, request);
    }
    throw error;
  }
  return json({
    user: {
      userId,
      label,
      role: row.role === "admin" ? "admin" : "user",
      email,
      username,
      hasPassword: Boolean(passwordHash),
      createdAt: row.created_at || null
    }
  }, 200, env, request);
}
__name(updateUserHandler, "updateUserHandler");
async function resetPasscodeHandler(ctx, userId) {
  const { request, env, user } = ctx;
  const limit = rateLimit(`admin-users-reset:${user.user_id}`, 20, 60 * 1e3);
  if (!limit.ok) return rateLimited(env, request, limit.retryAfter);
  if (!USER_ID_RE2.test(userId)) return errorJson("invalid_user_id", 400, env, request);
  const row = await findUserById(env, userId);
  if (!row) return errorJson("user_not_found", 404, env, request);
  if (row.role === "admin") return errorJson("admin_account_protected", 403, env, request);
  const passcode = randomToken(32);
  const recoveryCode = randomToken(24);
  const passcodeHash = await sha256Hex(passcode);
  const recoveryHash = await sha256Hex(recoveryCode);
  const changedAt = (/* @__PURE__ */ new Date()).toISOString();
  const update = env.DB.prepare("UPDATE users SET token_hash = ?, recovery_hash = ?, auth_version = auth_version + 1 WHERE user_id = ?").bind(passcodeHash, recoveryHash, userId);
  const revokeSessions = env.DB.prepare("DELETE FROM user_sessions WHERE user_id = ?").bind(userId);
  const revokePairingCodes = env.DB.prepare("DELETE FROM pairing_codes WHERE user_id = ? AND used_at IS NULL").bind(userId);
  const audit = auditStatement(env, user.user_id, "user_reset_passcode", userId, {}, changedAt);
  await runWithAudit(env, [update, revokeSessions, revokePairingCodes, audit]);
  return json({
    user: toUserJson(row),
    passcode,
    recoveryCode
  }, 200, env, request);
}
__name(resetPasscodeHandler, "resetPasscodeHandler");
async function pairingCodeHandler(ctx, userId) {
  const { request, env, user } = ctx;
  const limit = rateLimit(`admin-users-pair:${user.user_id}`, 30, 60 * 1e3);
  if (!limit.ok) return rateLimited(env, request, limit.retryAfter);
  if (!USER_ID_RE2.test(userId)) return errorJson("invalid_user_id", 400, env, request);
  const row = await findUserById(env, userId);
  if (!row) return errorJson("user_not_found", 404, env, request);
  if (row.role === "admin") return errorJson("admin_account_protected", 403, env, request);
  let body;
  try {
    body = await readOptionalJsonBody(request, MAX_BODY_BYTES2);
  } catch (error) {
    return errorJson(error.code || "bad_json", error.status || 400, env, request);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return errorJson("bad_json", 400, env, request);
  }
  let ttlSeconds = DEFAULT_PAIRING_CODE_TTL_SECONDS;
  if (body.ttlSeconds !== void 0) {
    ttlSeconds = Number(body.ttlSeconds);
    if (!PAIRING_CODE_TTL_SECONDS.includes(ttlSeconds)) {
      return errorJson("invalid_ttl", 400, env, request);
    }
  }
  const code = randomPairingCode();
  const codeHash = await sha256Hex(code);
  const createdAt = /* @__PURE__ */ new Date();
  const createdAtIso = createdAt.toISOString();
  const expiresAt = new Date(createdAt.getTime() + ttlSeconds * 1e3).toISOString();
  const insert = env.DB.prepare("INSERT INTO pairing_codes (code_hash, user_id, created_by, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, ?, ?)").bind(codeHash, userId, user.user_id, createdAtIso, expiresAt, null);
  const audit = auditStatement(env, user.user_id, "user_pairing_code", userId, {
    expiresAt,
    ttlSeconds
  }, createdAtIso);
  await runWithAudit(env, [insert, audit]);
  return json({ userId, code, expiresAt, ttlSeconds }, 200, env, request);
}
__name(pairingCodeHandler, "pairingCodeHandler");
async function revokePairingCodesHandler(ctx, userId) {
  const { request, env, user } = ctx;
  const limit = rateLimit(`admin-users-pair-revoke:${user.user_id}`, 30, 60 * 1e3);
  if (!limit.ok) return rateLimited(env, request, limit.retryAfter);
  if (!USER_ID_RE2.test(userId)) return errorJson("invalid_user_id", 400, env, request);
  const row = await findUserById(env, userId);
  if (!row) return errorJson("user_not_found", 404, env, request);
  if (row.role === "admin") return errorJson("admin_account_protected", 403, env, request);
  const changedAt = (/* @__PURE__ */ new Date()).toISOString();
  const revoke = env.DB.prepare("DELETE FROM pairing_codes WHERE user_id = ? AND used_at IS NULL").bind(userId);
  const audit = auditStatement(env, user.user_id, "user_pairing_codes_revoke", userId, {}, changedAt);
  const results = await runWithAudit(env, [revoke, audit]);
  const revoked = results && results[0] && results[0].meta && Number(results[0].meta.changes) ? Number(results[0].meta.changes) : 0;
  return json({ userId, revoked }, 200, env, request);
}
__name(revokePairingCodesHandler, "revokePairingCodesHandler");
async function handleAdminUsersRoute(ctx) {
  const { request, env, url, user } = ctx;
  if (!user || !user.user_id) return errorJson("unauthorized", 401, env, request);
  if (user.role !== "admin") return errorJson("admin_required", 403, env, request);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (path === "/admin/users") {
    if (request.method === "GET") return listUsersHandler(ctx);
    if (request.method === "POST") return createUserHandler(ctx);
    return errorJson("method_not_allowed", 405, env, request);
  }
  const resetMatch = path.match(/^\/admin\/users\/([^/]+)\/reset-passcode$/);
  if (resetMatch) {
    if (request.method !== "POST") return errorJson("method_not_allowed", 405, env, request);
    return resetPasscodeHandler(ctx, decodeUserId(resetMatch[1]));
  }
  const pairingMatch = path.match(/^\/admin\/users\/([^/]+)\/pairing-code$/);
  if (pairingMatch) {
    if (request.method !== "POST") return errorJson("method_not_allowed", 405, env, request);
    return pairingCodeHandler(ctx, decodeUserId(pairingMatch[1]));
  }
  const pairingsMatch = path.match(/^\/admin\/users\/([^/]+)\/pairing-codes$/);
  if (pairingsMatch) {
    if (request.method !== "DELETE") return errorJson("method_not_allowed", 405, env, request);
    return revokePairingCodesHandler(ctx, decodeUserId(pairingsMatch[1]));
  }
  const updateMatch = path.match(/^\/admin\/users\/([^/]+)$/);
  if (updateMatch) {
    if (request.method !== "PUT") return errorJson("method_not_allowed", 405, env, request);
    return updateUserHandler(ctx, decodeUserId(updateMatch[1]));
  }
  return errorJson("not_found", 404, env, request);
}
__name(handleAdminUsersRoute, "handleAdminUsersRoute");

// ../../../../../Users/linus/CODE/bdc-extension-ai-proof-20261105/cloudflare-worker/src/snapshot-sanitize.js
var FORMATS = /* @__PURE__ */ new Set(["openai-chat", "anthropic-messages", "gemini"]);
var AUTH_MODES = /* @__PURE__ */ new Set(["bearer", "x-api-key", "google", "none"]);
var CAPABILITY_KEYS2 = ["text", "images", "json", "stream", "models"];
var THINKING_LEVELS = /* @__PURE__ */ new Set(["auto", "none", "low", "medium", "high"]);
var CREDENTIAL_QUERY_RE = /key|token|secret|auth|pass|sig/i;
function isPlainObject2(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
__name(isPlainObject2, "isPlainObject");
function isValidPersonalProviderId(id) {
  const value = String(id || "");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) return false;
  if (value === "default" || value.startsWith("managed-")) return false;
  return !["__proto__", "prototype", "constructor", "aiApiKey"].includes(value);
}
__name(isValidPersonalProviderId, "isValidPersonalProviderId");
function sanitizeUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (!/^https?:$/.test(url.protocol)) return "";
    if (url.username || url.password) return "";
    url.hash = "";
    for (const key of Array.from(url.searchParams.keys())) {
      if (CREDENTIAL_QUERY_RE.test(key)) return "";
    }
    return url.toString();
  } catch (_) {
    return "";
  }
}
__name(sanitizeUrl, "sanitizeUrl");
function uniqueStrings(values) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const raw = String(value || "").trim();
    if (!raw || seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw.slice(0, 240));
  }
  return out;
}
__name(uniqueStrings, "uniqueStrings");
function sanitizeModels(models) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const model of Array.isArray(models) ? models : []) {
    const id = String(typeof model === "string" ? model : model && (model.id || model.model) || "").trim();
    if (!id || seen.has(id) || id.length > 200) continue;
    seen.add(id);
    const entry = { id, label: String(model && model.label || id).slice(0, 200) };
    if (model && isPlainObject2(model.capabilities)) {
      const capabilities = {};
      for (const key of CAPABILITY_KEYS2) {
        const value = String(model.capabilities[key] || "");
        if (value === "yes" || value === "no" || value === "unknown") capabilities[key] = value;
      }
      if (Object.keys(capabilities).length) entry.capabilities = capabilities;
    }
    out.push(entry);
  }
  return out;
}
__name(sanitizeModels, "sanitizeModels");
function sanitizeSnapshotTaskMappings(record) {
  if (!isPlainObject2(record)) return {};
  const out = {};
  for (const [task, value] of Object.entries(record)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(task)) continue;
    let spec = "";
    if (typeof value === "string") spec = value.trim();
    else if (isPlainObject2(value)) {
      const provider = String(value.provider || value.providerId || value.profile || "").trim();
      const model = String(value.model || "").trim();
      if (provider && model) spec = `${provider}:${model}`;
      else if (model) spec = model;
    }
    if (!spec || spec.length > 240 || /\s/.test(spec)) continue;
    out[task] = spec;
  }
  return out;
}
__name(sanitizeSnapshotTaskMappings, "sanitizeSnapshotTaskMappings");
function sanitizeSnapshotThinkingMappings(record) {
  if (!isPlainObject2(record)) return {};
  const out = {};
  for (const [task, value] of Object.entries(record)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(task)) continue;
    const level = String(value || "").trim().toLowerCase();
    if (!THINKING_LEVELS.has(level)) continue;
    out[task] = level;
  }
  return out;
}
__name(sanitizeSnapshotThinkingMappings, "sanitizeSnapshotThinkingMappings");
function sanitizeSnapshotAISettings(ai) {
  const source = isPlainObject2(ai) ? ai : {};
  const providers = {};
  if (isPlainObject2(source.providers)) {
    for (const [id, provider] of Object.entries(source.providers)) {
      if (!isValidPersonalProviderId(id) || !isPlainObject2(provider)) continue;
      const prefix = `${id}:`;
      providers[id] = {
        label: String(provider.label || id).slice(0, 120),
        enabled: provider.enabled !== false,
        format: FORMATS.has(provider.format) ? provider.format : "openai-chat",
        baseUrl: sanitizeUrl(provider.baseUrl),
        apiUrl: sanitizeUrl(provider.apiUrl),
        modelsUrl: sanitizeUrl(provider.modelsUrl),
        authMode: AUTH_MODES.has(provider.authMode) ? provider.authMode : "bearer",
        allowCrossOriginModels: provider.allowCrossOriginModels === true,
        allowedModels: uniqueStrings(provider.allowedModels).map((value) => value.startsWith(prefix) ? value.slice(prefix.length) : value),
        discoveredModels: sanitizeModels(provider.discoveredModels),
        lastDiscoveryAt: typeof provider.lastDiscoveryAt === "string" ? provider.lastDiscoveryAt.slice(0, 40) : "",
        discoveryStatus: ["success", "error"].includes(provider.discoveryStatus) ? provider.discoveryStatus : ""
      };
    }
  }
  const models = sanitizeSnapshotTaskMappings(source.models);
  const tasks = sanitizeSnapshotTaskMappings(source.tasks);
  const settings = {
    apiUrl: "",
    providers,
    models,
    tasks: { ...models, ...tasks },
    defaultModel: typeof source.defaultModel === "string" ? source.defaultModel.trim().slice(0, 240) : ""
  };
  if (isPlainObject2(source.thinking)) {
    const thinking = sanitizeSnapshotThinkingMappings(source.thinking);
    if (Object.keys(thinking).length) settings.thinking = thinking;
  }
  if (source.keySyncDefault === "cloud" || source.keySyncDefault === "local-only") {
    settings.keySyncDefault = source.keySyncDefault;
  }
  return settings;
}
__name(sanitizeSnapshotAISettings, "sanitizeSnapshotAISettings");
function sanitizeSnapshotPayload(payload) {
  if (!isPlainObject2(payload)) return payload;
  const next = { ...payload };
  if (isPlainObject2(next.aiSettings)) {
    next.aiSettings = {
      ...next.aiSettings,
      settings: sanitizeSnapshotAISettings(next.aiSettings.settings)
    };
    delete next.aiSettings.apiKey;
    delete next.aiSettings.apiProviders;
  }
  delete next.aiApiKey;
  delete next.aiProviders;
  return next;
}
__name(sanitizeSnapshotPayload, "sanitizeSnapshotPayload");

// ../../../../../Users/linus/CODE/bdc-extension-ai-proof-20261105/shared/article-protocol.mjs
var ARTICLE_LIMITS = {
  // 單篇文章（原文＋分析 JSON 的 UTF-8 位元組）
  maxArticleBytes: 800 * 1024,
  // 每位使用者全部文章的 UTF-8 位元組合計
  maxUserBytes: 50 * 1024 * 1024,
  // 產品提示與硬上限（筆數）
  warnCount: 400,
  maxCount: 1e3,
  // 原文字元數：提示與硬上限
  warnBodyChars: 2e4,
  maxBodyChars: 1e5,
  // 列表分頁
  listLimitDefault: 200,
  listLimitMax: 500,
  // 批次讀取單篇文件
  batchMax: 50,
  // 一次舊資料匯入的最大筆數
  importMax: 100,
  // 單次請求 body 上限（含 JSON 包裝的餘裕）
  requestMaxBytes: 4 * 1024 * 1024
};
var ARTICLE_SOURCE_TYPES = ["url", "paste", "file", "ocr"];
var ARTICLE_ERRORS = {
  unauthorized: "unauthorized",
  notFound: "article_not_found",
  invalidBody: "invalid_article",
  bodyTooLarge: "article_too_large",
  quotaExceeded: "article_quota_exceeded",
  countExceeded: "article_count_exceeded",
  revisionRequired: "expected_revision_required",
  revisionConflict: "article_revision_conflict",
  alreadyDeleted: "article_already_deleted",
  notDeleted: "article_not_deleted",
  idExists: "article_id_exists",
  invalidId: "article_id_invalid",
  invalidCursor: "article_cursor_invalid",
  legacyBlocked: "articles_legacy_write_blocked",
  methodNotAllowed: "method_not_allowed"
};
function isPlainObject3(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
__name(isPlainObject3, "isPlainObject");
function utf8Bytes(text) {
  const raw = String(text == null ? "" : text);
  if (typeof TextEncoder !== "undefined") {
    try {
      return new TextEncoder().encode(raw).length;
    } catch (_) {
    }
  }
  let bytes = 0;
  for (const ch of raw) {
    const code = ch.codePointAt(0);
    if (code <= 127) bytes += 1;
    else if (code <= 2047) bytes += 2;
    else if (code <= 65535) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}
__name(utf8Bytes, "utf8Bytes");
function charCount(text) {
  return Array.from(String(text == null ? "" : text)).length;
}
__name(charCount, "charCount");
function isValidArticleId(id) {
  const value = String(id == null ? "" : id);
  if (!value || value.length > 160) return false;
  return /^[A-Za-z0-9][A-Za-z0-9_:.-]*$/.test(value);
}
__name(isValidArticleId, "isValidArticleId");
function generateArticleId(seed) {
  const base = typeof seed === "number" ? seed : Date.now();
  const tail = Math.random().toString(36).slice(2, 10);
  return `art_${base.toString(36)}${tail}`;
}
__name(generateArticleId, "generateArticleId");
function normalizeSourceType(value) {
  const raw = String(value == null ? "" : value).trim();
  return ARTICLE_SOURCE_TYPES.includes(raw) ? raw : "paste";
}
__name(normalizeSourceType, "normalizeSourceType");
function normalizeSourceUrl(value) {
  const raw = String(value == null ? "" : value).trim();
  if (!raw) return "";
  return raw.slice(0, 2048);
}
__name(normalizeSourceUrl, "normalizeSourceUrl");
function normalizeTitle(value, fallback = "") {
  const raw = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  const title = raw || String(fallback || "").trim();
  return title.slice(0, 300);
}
__name(normalizeTitle, "normalizeTitle");
function normalizeAnalysis(value) {
  if (value === void 0 || value === null) return null;
  if (Array.isArray(value)) return value;
  if (isPlainObject3(value)) return value;
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object") return parsed;
    } catch (_) {
    }
  }
  return null;
}
__name(normalizeAnalysis, "normalizeAnalysis");
function serializeAnalysis(value) {
  const normalized = normalizeAnalysis(value);
  if (normalized === null) return null;
  try {
    return JSON.stringify(normalized);
  } catch (_) {
    return null;
  }
}
__name(serializeAnalysis, "serializeAnalysis");
function parseAnalysis(value) {
  if (value === void 0 || value === null || value === "") return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(String(value));
  } catch (_) {
    return null;
  }
}
__name(parseAnalysis, "parseAnalysis");
function normalizeArticleDocument(raw, options = {}) {
  if (!isPlainObject3(raw)) {
    return { ok: false, error: ARTICLE_ERRORS.invalidBody };
  }
  const body = typeof raw.body === "string" ? raw.body : typeof raw.article === "string" ? raw.article : "";
  const title = normalizeTitle(raw.title);
  if (!body.trim()) return { ok: false, error: ARTICLE_ERRORS.invalidBody };
  if (charCount(body) > ARTICLE_LIMITS.maxBodyChars) {
    return { ok: false, error: ARTICLE_ERRORS.bodyTooLarge, limit: ARTICLE_LIMITS.maxBodyChars };
  }
  const analysis = normalizeAnalysis(raw.analysis != null ? raw.analysis : raw.result);
  const document = {
    id: raw.id == null ? "" : String(raw.id),
    title: title || body.split("\n").map((line) => line.trim()).find(Boolean)?.slice(0, 300) || "",
    body,
    analysis,
    sourceType: normalizeSourceType(raw.sourceType),
    sourceUrl: normalizeSourceUrl(raw.sourceUrl)
  };
  if (options.requireId && !isValidArticleId(document.id)) {
    return { ok: false, error: ARTICLE_ERRORS.invalidId };
  }
  const size = articleSizeBytes(document);
  if (size > ARTICLE_LIMITS.maxArticleBytes) {
    return {
      ok: false,
      error: ARTICLE_ERRORS.bodyTooLarge,
      limit: ARTICLE_LIMITS.maxArticleBytes,
      size
    };
  }
  return { ok: true, document, size };
}
__name(normalizeArticleDocument, "normalizeArticleDocument");
function articleSizeBytes(document) {
  const body = typeof document?.body === "string" ? document.body : typeof document?.article === "string" ? document.article : "";
  const analysisText = serializeAnalysis(document?.analysis != null ? document.analysis : document?.result);
  return utf8Bytes(body) + (analysisText ? utf8Bytes(analysisText) : 0);
}
__name(articleSizeBytes, "articleSizeBytes");
function checkQuota({ usage, nextSize, currentRow = null, isCreate = false }) {
  const limits = ARTICLE_LIMITS;
  if (nextSize > limits.maxArticleBytes) {
    return { ok: false, error: ARTICLE_ERRORS.bodyTooLarge, limit: limits.maxArticleBytes, size: nextSize };
  }
  const count = Number(usage?.count) || 0;
  const totalBytes = Number(usage?.totalBytes) || 0;
  const previousSize = currentRow ? Number(currentRow.size_bytes) || 0 : 0;
  const nextCount = isCreate ? count + 1 : count;
  const nextTotal = totalBytes - previousSize + nextSize;
  if (nextCount > limits.maxCount) {
    return { ok: false, error: ARTICLE_ERRORS.countExceeded, limit: limits.maxCount, count: nextCount };
  }
  if (nextTotal > limits.maxUserBytes) {
    return { ok: false, error: ARTICLE_ERRORS.quotaExceeded, limit: limits.maxUserBytes, totalBytes: nextTotal };
  }
  return {
    ok: true,
    count: nextCount,
    totalBytes: nextTotal,
    warning: nextCount > limits.warnCount
  };
}
__name(checkQuota, "checkQuota");
function parseCursor(raw) {
  if (raw === void 0 || raw === null || raw === "") return { cursor: 0, invalid: false, provided: false };
  const text = String(raw).trim();
  if (!/^\d{1,15}$/.test(text)) return { cursor: 0, invalid: true, provided: true };
  return { cursor: Number.parseInt(text, 10), invalid: false, provided: true };
}
__name(parseCursor, "parseCursor");
function parseListLimit(raw) {
  const text = String(raw == null ? "" : raw).trim();
  if (!/^\d{1,5}$/.test(text)) return ARTICLE_LIMITS.listLimitDefault;
  const value = Number.parseInt(text, 10);
  if (!value) return ARTICLE_LIMITS.listLimitDefault;
  return Math.min(ARTICLE_LIMITS.listLimitMax, value);
}
__name(parseListLimit, "parseListLimit");
function parseExpectedRevision(raw) {
  if (raw === void 0 || raw === null || raw === "") return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) return null;
  return value;
}
__name(parseExpectedRevision, "parseExpectedRevision");
function normalizeMutationId(raw) {
  const value = String(raw == null ? "" : raw).trim();
  if (!value) return "";
  return value.slice(0, 120);
}
__name(normalizeMutationId, "normalizeMutationId");
function toArticleMeta(row) {
  if (!row) return null;
  return {
    // 舊 ID 是閱讀條目、詞書與會話的外鍵。匯入時產生的新 ID 只用於
    // SQL 儲存，不可取代公開身份，否則原本的關聯及匯入核對都會失效。
    id: row.legacy_article_id || row.id,
    ...row.legacy_article_id && row.legacy_article_id !== row.id ? { storageId: row.id } : {},
    revision: Number(row.revision) || 0,
    title: row.title || "",
    sourceType: normalizeSourceType(row.source_type),
    sourceUrl: row.source_url || "",
    createdAt: row.created_at || "",
    updatedAt: row.updated_at || "",
    deletedAt: row.deleted_at || "",
    sizeBytes: Number(row.size_bytes) || 0
  };
}
__name(toArticleMeta, "toArticleMeta");
function toArticleDocument(row) {
  if (!row) return null;
  return {
    ...toArticleMeta(row),
    body: row.body || "",
    analysis: parseAnalysis(row.analysis_json)
  };
}
__name(toArticleDocument, "toArticleDocument");
function snapshotCarriesArticles(payload) {
  const group = payload && payload.articles;
  if (!group || typeof group !== "object") return false;
  const analyzed = Array.isArray(group.analyzedArticles) ? group.analyzedArticles.length : 0;
  const metas = Array.isArray(group.articleMetas) ? group.articleMetas.length : 0;
  return analyzed > 0 || metas > 0;
}
__name(snapshotCarriesArticles, "snapshotCarriesArticles");
function conflictPayload(row) {
  const meta = toArticleMeta(row);
  return {
    error: ARTICLE_ERRORS.revisionConflict,
    code: ARTICLE_ERRORS.revisionConflict,
    conflict: true,
    current: meta
  };
}
__name(conflictPayload, "conflictPayload");

// ../../../../../Users/linus/CODE/bdc-extension-ai-proof-20261105/cloudflare-worker/src/articles.js
var MAX_BATCH_ITEMS = 8;
var MAX_QUERY_IDS = 90;
var MAX_IMPORT_ATTEMPTS = 4;
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
__name(nowIso, "nowIso");
function stateFromRow(row) {
  return {
    nextSeq: Number(row?.next_seq || 1),
    legacyWriteBlocked: Number(row?.legacy_write_blocked || 0) === 1,
    migratedAt: row?.migrated_at || "",
    prunedBefore: Number(row?.pruned_before || 0)
  };
}
__name(stateFromRow, "stateFromRow");
async function ensureState(env, userId) {
  const readRow3 = /* @__PURE__ */ __name(() => env.DB.prepare("SELECT next_seq, legacy_write_blocked, migrated_at, pruned_before FROM article_state WHERE owner_user_id = ?").bind(userId).first(), "readRow");
  const existing = await readRow3();
  if (existing) return stateFromRow(existing);
  await env.DB.prepare("INSERT INTO article_state (owner_user_id, next_seq, legacy_write_blocked, updated_at) VALUES (?, 1, 0, ?) ON CONFLICT (owner_user_id) DO NOTHING").bind(userId, nowIso()).run();
  return stateFromRow(await readRow3());
}
__name(ensureState, "ensureState");
async function isLegacyArticleWriteBlocked(env, userId) {
  const row = await env.DB.prepare("SELECT legacy_write_blocked FROM article_state WHERE owner_user_id = ?").bind(userId).first();
  return Number(row?.legacy_write_blocked || 0) === 1;
}
__name(isLegacyArticleWriteBlocked, "isLegacyArticleWriteBlocked");
function bumpSnapshotVersionStatement(env, userId, updatedAt) {
  return env.DB.prepare("UPDATE snapshots SET version = version + 1, updated_at = ? WHERE user_id = ?").bind(updatedAt, userId);
}
__name(bumpSnapshotVersionStatement, "bumpSnapshotVersionStatement");
async function readRow(env, userId, articleId) {
  return env.DB.prepare("SELECT * FROM articles WHERE owner_user_id = ? AND (id = ? OR legacy_article_id = ?) ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END LIMIT 1").bind(userId, articleId, articleId, articleId).first();
}
__name(readRow, "readRow");
async function readRowsByIds(env, userId, ids) {
  const rows = [];
  const referenceMax = Math.floor(MAX_QUERY_IDS / 2);
  for (let index = 0; index < ids.length; index += referenceMax) {
    const chunk = ids.slice(index, index + referenceMax);
    const placeholders = chunk.map(() => "?").join(", ");
    const result = await env.DB.prepare(`SELECT * FROM articles WHERE owner_user_id = ? AND (id IN (${placeholders}) OR legacy_article_id IN (${placeholders}))`).bind(userId, ...chunk, ...chunk).all();
    const list = result?.results;
    if (Array.isArray(list)) rows.push(...list);
  }
  return rows;
}
__name(readRowsByIds, "readRowsByIds");
async function readExistingIds(env, userId, ids) {
  const found = /* @__PURE__ */ new Set();
  for (let index = 0; index < ids.length; index += MAX_QUERY_IDS) {
    const chunk = ids.slice(index, index + MAX_QUERY_IDS);
    const placeholders = chunk.map(() => "?").join(", ");
    const result = await env.DB.prepare(`SELECT id FROM articles WHERE owner_user_id = ? AND id IN (${placeholders})`).bind(userId, ...chunk).all();
    for (const row of result?.results || []) found.add(String(row.id));
  }
  return found;
}
__name(readExistingIds, "readExistingIds");
async function readExistingLegacyIds(env, userId, legacyIds) {
  const found = /* @__PURE__ */ new Set();
  for (let index = 0; index < legacyIds.length; index += MAX_QUERY_IDS) {
    const chunk = legacyIds.slice(index, index + MAX_QUERY_IDS);
    const placeholders = chunk.map(() => "?").join(", ");
    const result = await env.DB.prepare(`SELECT legacy_article_id FROM articles WHERE owner_user_id = ? AND legacy_article_id IN (${placeholders})`).bind(userId, ...chunk).all();
    for (const row of result?.results || []) {
      if (row.legacy_article_id) found.add(String(row.legacy_article_id));
    }
  }
  return found;
}
__name(readExistingLegacyIds, "readExistingLegacyIds");
function quotaLockStatements(env, userId) {
  if (!env || !env.DB || env.DB.driver !== "postgres") return [];
  return [env.DB.prepare("SELECT 1 FROM article_state WHERE owner_user_id = ? FOR UPDATE").bind(userId)];
}
__name(quotaLockStatements, "quotaLockStatements");
async function readUsage(env, userId) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS article_count, COALESCE(SUM(size_bytes), 0) AS total_bytes FROM articles WHERE owner_user_id = ? AND deleted_at IS NULL").bind(userId).first();
  return {
    count: Number(row?.article_count) || 0,
    totalBytes: Number(row?.total_bytes) || 0
  };
}
__name(readUsage, "readUsage");
function writeStatements(env, { userId, changes, matchToken = "" }) {
  const tokenClause = matchToken ? " AND last_mutation_id = ?" : "";
  return changes.map((change) => {
    const statement = env.DB.prepare("INSERT INTO article_changes (owner_user_id, seq, article_id, op, revision, updated_at) SELECT owner_user_id, next_seq, ?, ?, ?, ? FROM article_state WHERE owner_user_id = ? AND EXISTS (SELECT 1 FROM articles WHERE owner_user_id = ? AND id = ? AND revision = ?" + tokenClause + ")");
    const args = [change.articleId, change.op, change.revision, change.updatedAt, userId, userId, change.articleId, change.revision];
    if (matchToken) args.push(matchToken);
    return statement.bind(...args);
  });
}
__name(writeStatements, "writeStatements");
function advanceStatements(env, { userId, changes, matchToken = "" }) {
  const tokenClause = matchToken ? " AND last_mutation_id = ?" : "";
  return changes.map((change) => {
    const statement = env.DB.prepare("UPDATE article_state SET next_seq = next_seq + 1, updated_at = ? WHERE owner_user_id = ? AND EXISTS (SELECT 1 FROM articles WHERE owner_user_id = ? AND id = ? AND revision = ?" + tokenClause + ")");
    const args = [change.updatedAt, userId, userId, change.articleId, change.revision];
    if (matchToken) args.push(matchToken);
    return statement.bind(...args);
  });
}
__name(advanceStatements, "advanceStatements");
function insertQuotaStatement(env, { userId, document, size, articleId, updatedAt, token }) {
  return env.DB.prepare("INSERT INTO articles (owner_user_id, id, title, body, analysis_json, source_type, source_url, revision, created_at, updated_at, deleted_at, legacy_article_id, last_mutation_id, size_bytes) SELECT ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, ?, ?, ? WHERE (SELECT COUNT(*) FROM articles WHERE owner_user_id = ? AND deleted_at IS NULL) < ? AND (SELECT COALESCE(SUM(size_bytes), 0) FROM articles WHERE owner_user_id = ? AND deleted_at IS NULL) + ? <= ?").bind(
    userId,
    articleId,
    document.title,
    document.body,
    document.analysis === null ? null : JSON.stringify(document.analysis),
    document.sourceType,
    document.sourceUrl || null,
    updatedAt,
    updatedAt,
    document.legacyArticleId || null,
    token,
    size,
    userId,
    ARTICLE_LIMITS.maxCount,
    userId,
    size,
    ARTICLE_LIMITS.maxUserBytes
  );
}
__name(insertQuotaStatement, "insertQuotaStatement");
async function respondDoc(env, request, row, status, extra = {}) {
  return json({ ...extra, article: toArticleDocument(row) }, status, env, request);
}
__name(respondDoc, "respondDoc");
async function handleArticlesRoute({ request, env, url, user, rest }) {
  const userId = user.user_id;
  const method = request.method;
  const path = String(rest || "");
  if (path === "/usage" && method === "GET") {
    const usage = await readUsage(env, userId);
    const state = await ensureState(env, userId);
    return json({
      count: usage.count,
      totalBytes: usage.totalBytes,
      limits: ARTICLE_LIMITS,
      warning: usage.count > ARTICLE_LIMITS.warnCount,
      legacyWriteBlocked: state.legacyWriteBlocked,
      cursor: state.nextSeq - 1
    }, 200, env, request);
  }
  if (path === "/batch" && method === "POST") {
    const body = await readJsonBody(request, ARTICLE_LIMITS.requestMaxBytes);
    const ids = Array.isArray(body?.ids) ? body.ids.map((id) => String(id || "")).filter(Boolean) : [];
    if (!ids.length) return json({ articles: [] }, 200, env, request);
    if (ids.length > ARTICLE_LIMITS.batchMax) {
      return errorJson(ARTICLE_ERRORS.invalidBody, 400, env, request, { limit: ARTICLE_LIMITS.batchMax });
    }
    const unique = Array.from(new Set(ids)).slice(0, ARTICLE_LIMITS.batchMax);
    const rows = await readRowsByIds(env, userId, unique);
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const row of rows) {
      if (row.legacy_article_id && !byId.has(row.legacy_article_id)) byId.set(row.legacy_article_id, row);
    }
    const found = [];
    const seen = /* @__PURE__ */ new Set();
    for (const id of unique) {
      const row = byId.get(id);
      if (row && !row.deleted_at && !seen.has(row.id)) {
        found.push(toArticleDocument(row));
        seen.add(row.id);
      }
    }
    return json({ articles: found }, 200, env, request);
  }
  if (path === "/import" && method === "POST") {
    return handleImport({ request, env, user });
  }
  if ((path === "" || path === "/") && method === "GET") {
    return handleList({ request, env, url, user });
  }
  if ((path === "" || path === "/") && method === "POST") {
    const body = await readJsonBody(request, ARTICLE_LIMITS.requestMaxBytes);
    return handleCreate({ request, env, user, body });
  }
  const restoreMatch = path.match(/^\/([^/]+)\/restore$/);
  if (restoreMatch && method === "POST") {
    return handleRestore({ request, env, user, articleId: decodeURIComponent(restoreMatch[1]) });
  }
  const singleMatch = path.match(/^\/([^/]+)$/);
  if (singleMatch) {
    const articleId = decodeURIComponent(singleMatch[1]);
    if (method === "GET") {
      const row = await readRow(env, userId, articleId);
      if (!row) return errorJson(ARTICLE_ERRORS.notFound, 404, env, request);
      return respondDoc(env, request, row, 200, { deleted: !!row.deleted_at });
    }
    if (method === "PUT") return handleUpdate({ request, env, user, articleId });
    if (method === "DELETE") return handleDelete({ request, env, user, articleId });
  }
  if (path === "" || path === "/" || singleMatch || restoreMatch) {
    return errorJson(ARTICLE_ERRORS.methodNotAllowed, 405, env, request);
  }
  return errorJson("not_found", 404, env, request);
}
__name(handleArticlesRoute, "handleArticlesRoute");
async function handleList({ request, env, url, user }) {
  const userId = user.user_id;
  const state = await ensureState(env, userId);
  const full = url.searchParams.get("full") === "1";
  const includeDeleted = url.searchParams.get("includeDeleted") === "1";
  const limit = parseListLimit(url.searchParams.get("limit"));
  if (full) {
    const offset = Math.max(0, Number.parseInt(url.searchParams.get("offset") || "0", 10) || 0);
    const rows2 = await env.DB.prepare(`SELECT * FROM articles WHERE owner_user_id = ?${includeDeleted ? "" : " AND deleted_at IS NULL"} ORDER BY updated_at DESC, id ASC LIMIT ? OFFSET ?`).bind(userId, limit + 1, offset).all();
    const list = rows2?.results || [];
    const hasMore2 = list.length > limit;
    return json({
      full: true,
      identityVersion: 1,
      cursor: state.nextSeq - 1,
      articles: list.slice(0, limit).map(toArticleMeta),
      hasMore: hasMore2,
      offset: offset + Math.min(limit, list.length)
    }, 200, env, request);
  }
  const { cursor, invalid } = parseCursor(url.searchParams.get("cursor"));
  if (invalid) {
    return json({ resetRequired: true, reason: "invalid_cursor", cursor: state.nextSeq - 1, changes: [], hasMore: false }, 200, env, request);
  }
  if (cursor < state.prunedBefore) {
    return json({ resetRequired: true, reason: "cursor_expired", cursor: state.nextSeq - 1, changes: [], hasMore: false }, 200, env, request);
  }
  if (cursor >= state.nextSeq) {
    return json({ resetRequired: false, identityVersion: 1, cursor: state.nextSeq - 1, changes: [], hasMore: false }, 200, env, request);
  }
  const rows = await env.DB.prepare("SELECT c.seq, c.article_id, c.op, c.revision, a.legacy_article_id, a.title, a.source_type, a.source_url, a.created_at, a.updated_at, a.deleted_at, a.size_bytes, a.revision AS current_revision FROM article_changes c JOIN articles a ON a.owner_user_id = c.owner_user_id AND a.id = c.article_id WHERE c.owner_user_id = ? AND c.seq > ? ORDER BY c.seq ASC LIMIT ?").bind(userId, cursor, limit + 1).all();
  const all = rows?.results || [];
  const hasMore = all.length > limit;
  const slice = all.slice(0, limit);
  const changes = slice.map((row) => ({
    ...toArticleMeta({
      id: row.article_id,
      legacy_article_id: row.legacy_article_id,
      revision: row.current_revision,
      title: row.title,
      source_type: row.source_type,
      source_url: row.source_url,
      created_at: row.created_at,
      updated_at: row.updated_at,
      deleted_at: row.deleted_at,
      size_bytes: row.size_bytes
    }),
    seq: Number(row.seq),
    op: row.op,
    revision: Number(row.revision),
    currentRevision: Number(row.current_revision)
  }));
  const nextCursor = slice.length ? Number(slice[slice.length - 1].seq) : cursor;
  return json({
    resetRequired: false,
    identityVersion: 1,
    cursor: nextCursor,
    serverCursor: state.nextSeq - 1,
    hasMore,
    changes
  }, 200, env, request);
}
__name(handleList, "handleList");
async function handleCreate({ request, env, user, body }) {
  const userId = user.user_id;
  const mutationId = normalizeMutationId(body?.clientMutationId);
  const parsed = normalizeArticleDocument(body);
  if (!parsed.ok) {
    const status = parsed.error === ARTICLE_ERRORS.bodyTooLarge ? 413 : 400;
    return errorJson(parsed.error, status, env, request, parsed.limit ? { limit: parsed.limit } : void 0);
  }
  const document = parsed.document;
  let articleId = document.id ? String(document.id) : "";
  if (articleId && !isValidArticleId(articleId)) {
    return errorJson(ARTICLE_ERRORS.invalidId, 400, env, request);
  }
  if (!articleId) articleId = generateArticleId();
  const existing = await readRow(env, userId, articleId);
  if (existing) {
    if (mutationId && existing.last_mutation_id === mutationId) {
      return respondDoc(env, request, existing, 200, { created: false, idempotent: true });
    }
    return errorJson(ARTICLE_ERRORS.idExists, 409, env, request, { current: toArticleMeta(existing) });
  }
  const usage = await readUsage(env, userId);
  const quota = checkQuota({ usage, nextSize: parsed.size, isCreate: true });
  if (!quota.ok) {
    const status = quota.error === ARTICLE_ERRORS.countExceeded || quota.error === ARTICLE_ERRORS.quotaExceeded ? 409 : 413;
    return errorJson(quota.error, status, env, request, {
      limit: quota.limit,
      count: quota.count,
      totalBytes: quota.totalBytes
    });
  }
  await ensureState(env, userId);
  const updatedAt = nowIso();
  const token = mutationId || `crt_${crypto.randomUUID()}`;
  const locks = quotaLockStatements(env, userId);
  let results;
  try {
    results = await env.DB.batch([
      ...locks,
      insertQuotaStatement(env, { userId, document, size: parsed.size, articleId, updatedAt, token }),
      ...writeStatements(env, { userId, matchToken: token, changes: [{ articleId, op: "create", revision: 1, updatedAt }] }),
      ...advanceStatements(env, { userId, matchToken: token, changes: [{ articleId, revision: 1, updatedAt }] })
    ]);
  } catch (error) {
    const row2 = await readRow(env, userId, articleId);
    if (row2 && mutationId && row2.last_mutation_id === mutationId) {
      return respondDoc(env, request, row2, 200, { created: false, idempotent: true });
    }
    throw error;
  }
  const inserted = Number(results?.[locks.length]?.meta?.changes ?? results?.[locks.length]?.changes ?? 0);
  if (!inserted) {
    const row2 = await readRow(env, userId, articleId);
    if (row2) {
      if (mutationId && row2.last_mutation_id === mutationId) {
        return respondDoc(env, request, row2, 200, { created: false, idempotent: true });
      }
      return errorJson(ARTICLE_ERRORS.idExists, 409, env, request, { current: toArticleMeta(row2) });
    }
    const usageNow = await readUsage(env, userId);
    const quotaNow = checkQuota({ usage: usageNow, nextSize: parsed.size, isCreate: true });
    return errorJson(quotaNow.ok ? ARTICLE_ERRORS.countExceeded : quotaNow.error, 409, env, request, {
      limit: quotaNow.limit,
      count: quotaNow.count,
      totalBytes: quotaNow.totalBytes
    });
  }
  const row = await readRow(env, userId, articleId);
  return respondDoc(env, request, row, 201, { created: true });
}
__name(handleCreate, "handleCreate");
async function handleUpdate({ request, env, user, articleId }) {
  const userId = user.user_id;
  const body = await readJsonBody(request, ARTICLE_LIMITS.requestMaxBytes);
  const existing = await readRow(env, userId, articleId);
  if (!existing) return errorJson(ARTICLE_ERRORS.notFound, 404, env, request);
  articleId = existing.id;
  const mutationId = normalizeMutationId(body?.clientMutationId);
  if (mutationId && existing.last_mutation_id === mutationId) {
    return respondDoc(env, request, existing, 200, { updated: false, idempotent: true });
  }
  if (existing.deleted_at) {
    return errorJson(ARTICLE_ERRORS.alreadyDeleted, 409, env, request, { current: toArticleMeta(existing) });
  }
  const expected = parseExpectedRevision(body?.expectedRevision);
  if (expected === null) return errorJson(ARTICLE_ERRORS.revisionRequired, 400, env, request);
  if (expected !== Number(existing.revision)) {
    return json(conflictPayload(existing), 409, env, request);
  }
  const merged = {
    id: articleId,
    title: body?.title !== void 0 ? body.title : existing.title,
    body: body?.body !== void 0 ? body.body : existing.body,
    analysis: body?.analysis !== void 0 ? body.analysis : body?.result !== void 0 ? body.result : existing.analysis_json,
    sourceType: body?.sourceType !== void 0 ? body.sourceType : existing.source_type,
    sourceUrl: body?.sourceUrl !== void 0 ? body.sourceUrl : existing.source_url
  };
  const parsed = normalizeArticleDocument(merged, { requireId: true });
  if (!parsed.ok) {
    const status = parsed.error === ARTICLE_ERRORS.bodyTooLarge ? 413 : 400;
    return errorJson(parsed.error, status, env, request, parsed.limit ? { limit: parsed.limit } : void 0);
  }
  const usage = await readUsage(env, userId);
  const quota = checkQuota({ usage, nextSize: parsed.size, currentRow: existing, isCreate: false });
  if (!quota.ok) {
    const status = quota.error === ARTICLE_ERRORS.quotaExceeded ? 409 : 413;
    return errorJson(quota.error, status, env, request, { limit: quota.limit, totalBytes: quota.totalBytes });
  }
  const updatedAt = nowIso();
  const nextRevision = expected + 1;
  await ensureState(env, userId);
  const token = mutationId || `upd_${crypto.randomUUID()}`;
  const locks = quotaLockStatements(env, userId);
  const results = await env.DB.batch([
    ...locks,
    env.DB.prepare("UPDATE articles SET title = ?, body = ?, analysis_json = ?, source_type = ?, source_url = ?, revision = ?, updated_at = ?, size_bytes = ?, last_mutation_id = ? WHERE owner_user_id = ? AND id = ? AND revision = ? AND deleted_at IS NULL AND (SELECT COALESCE(SUM(size_bytes), 0) FROM articles WHERE owner_user_id = ? AND deleted_at IS NULL AND id <> ?) + ? <= ?").bind(
      parsed.document.title,
      parsed.document.body,
      parsed.document.analysis === null ? null : JSON.stringify(parsed.document.analysis),
      parsed.document.sourceType,
      parsed.document.sourceUrl || null,
      nextRevision,
      updatedAt,
      parsed.size,
      token,
      userId,
      articleId,
      expected,
      userId,
      articleId,
      parsed.size,
      ARTICLE_LIMITS.maxUserBytes
    ),
    ...writeStatements(env, { userId, matchToken: token, changes: [{ articleId, op: "upsert", revision: nextRevision, updatedAt }] }),
    ...advanceStatements(env, { userId, matchToken: token, changes: [{ articleId, revision: nextRevision, updatedAt }] })
  ]);
  const changed = Number(results?.[locks.length]?.meta?.changes ?? results?.[locks.length]?.changes ?? 0);
  if (!changed) {
    const row2 = await readRow(env, userId, articleId);
    if (!row2) return errorJson(ARTICLE_ERRORS.notFound, 404, env, request);
    if (row2.deleted_at || Number(row2.revision) !== expected) return json(conflictPayload(row2), 409, env, request);
    const usageNow = await readUsage(env, userId);
    const quotaNow = checkQuota({ usage: usageNow, nextSize: parsed.size, currentRow: row2, isCreate: false });
    return errorJson(quotaNow.ok ? ARTICLE_ERRORS.quotaExceeded : quotaNow.error, 409, env, request, {
      limit: quotaNow.limit,
      totalBytes: quotaNow.totalBytes
    });
  }
  const row = await readRow(env, userId, articleId);
  return respondDoc(env, request, row, 200, { updated: true });
}
__name(handleUpdate, "handleUpdate");
async function handleDelete({ request, env, user, articleId }) {
  const userId = user.user_id;
  let body = {};
  try {
    body = await readJsonBody(request, 8 * 1024);
  } catch (_) {
    body = {};
  }
  const existing = await readRow(env, userId, articleId);
  if (!existing) return errorJson(ARTICLE_ERRORS.notFound, 404, env, request);
  articleId = existing.id;
  const mutationId = normalizeMutationId(body?.clientMutationId);
  if (mutationId && existing.last_mutation_id === mutationId) {
    return respondDoc(env, request, existing, 200, { deleted: true, idempotent: true });
  }
  const expected = parseExpectedRevision(body?.expectedRevision);
  if (expected === null) return errorJson(ARTICLE_ERRORS.revisionRequired, 400, env, request);
  if (existing.deleted_at) {
    return respondDoc(env, request, existing, 200, { deleted: true, idempotent: true });
  }
  if (expected !== Number(existing.revision)) return json(conflictPayload(existing), 409, env, request);
  const updatedAt = nowIso();
  const nextRevision = expected + 1;
  await ensureState(env, userId);
  const token = mutationId || `del_${crypto.randomUUID()}`;
  const locks = quotaLockStatements(env, userId);
  const results = await env.DB.batch([
    ...locks,
    env.DB.prepare("UPDATE articles SET deleted_at = ?, revision = ?, updated_at = ?, last_mutation_id = ? WHERE owner_user_id = ? AND id = ? AND revision = ? AND deleted_at IS NULL").bind(updatedAt, nextRevision, updatedAt, token, userId, articleId, expected),
    ...writeStatements(env, { userId, matchToken: token, changes: [{ articleId, op: "delete", revision: nextRevision, updatedAt }] }),
    ...advanceStatements(env, { userId, matchToken: token, changes: [{ articleId, revision: nextRevision, updatedAt }] })
  ]);
  const changed = Number(results?.[locks.length]?.meta?.changes ?? results?.[locks.length]?.changes ?? 0);
  if (!changed) {
    const row2 = await readRow(env, userId, articleId);
    if (!row2) return errorJson(ARTICLE_ERRORS.notFound, 404, env, request);
    return json(conflictPayload(row2), 409, env, request);
  }
  const row = await readRow(env, userId, articleId);
  return respondDoc(env, request, row, 200, { deleted: true });
}
__name(handleDelete, "handleDelete");
async function handleRestore({ request, env, user, articleId }) {
  const userId = user.user_id;
  const body = await readJsonBody(request, 8 * 1024);
  const existing = await readRow(env, userId, articleId);
  if (!existing) return errorJson(ARTICLE_ERRORS.notFound, 404, env, request);
  articleId = existing.id;
  const mutationId = normalizeMutationId(body?.clientMutationId);
  if (mutationId && existing.last_mutation_id === mutationId) {
    return respondDoc(env, request, existing, 200, { restored: true, idempotent: true });
  }
  const expected = parseExpectedRevision(body?.expectedRevision);
  if (expected === null) return errorJson(ARTICLE_ERRORS.revisionRequired, 400, env, request);
  if (!existing.deleted_at) {
    if (expected === Number(existing.revision)) {
      return respondDoc(env, request, existing, 200, { restored: true, idempotent: true });
    }
    return errorJson(ARTICLE_ERRORS.notDeleted, 409, env, request, { current: toArticleMeta(existing) });
  }
  if (expected !== Number(existing.revision)) return json(conflictPayload(existing), 409, env, request);
  const usage = await readUsage(env, userId);
  const quota = checkQuota({ usage, nextSize: Number(existing.size_bytes) || 0, isCreate: true });
  if (!quota.ok) {
    const status = quota.error === ARTICLE_ERRORS.countExceeded ? 409 : 413;
    return errorJson(quota.error, status, env, request, { limit: quota.limit, count: quota.count });
  }
  const updatedAt = nowIso();
  const nextRevision = expected + 1;
  const size = Number(existing.size_bytes) || 0;
  await ensureState(env, userId);
  const token = mutationId || `rst_${crypto.randomUUID()}`;
  const locks = quotaLockStatements(env, userId);
  const results = await env.DB.batch([
    ...locks,
    env.DB.prepare("UPDATE articles SET deleted_at = NULL, revision = ?, updated_at = ?, last_mutation_id = ? WHERE owner_user_id = ? AND id = ? AND revision = ? AND deleted_at IS NOT NULL AND (SELECT COUNT(*) FROM articles WHERE owner_user_id = ? AND deleted_at IS NULL) < ? AND (SELECT COALESCE(SUM(size_bytes), 0) FROM articles WHERE owner_user_id = ? AND deleted_at IS NULL) + ? <= ?").bind(
      nextRevision,
      updatedAt,
      token,
      userId,
      articleId,
      expected,
      userId,
      ARTICLE_LIMITS.maxCount,
      userId,
      size,
      ARTICLE_LIMITS.maxUserBytes
    ),
    ...writeStatements(env, { userId, matchToken: token, changes: [{ articleId, op: "restore", revision: nextRevision, updatedAt }] }),
    ...advanceStatements(env, { userId, matchToken: token, changes: [{ articleId, revision: nextRevision, updatedAt }] })
  ]);
  const changed = Number(results?.[locks.length]?.meta?.changes ?? results?.[locks.length]?.changes ?? 0);
  if (!changed) {
    const row2 = await readRow(env, userId, articleId);
    if (!row2) return errorJson(ARTICLE_ERRORS.notFound, 404, env, request);
    if (!row2.deleted_at || Number(row2.revision) !== expected) return json(conflictPayload(row2), 409, env, request);
    const usageNow = await readUsage(env, userId);
    const quotaNow = checkQuota({ usage: usageNow, nextSize: size, isCreate: true });
    return errorJson(quotaNow.ok ? ARTICLE_ERRORS.countExceeded : quotaNow.error, 409, env, request, {
      limit: quotaNow.limit,
      count: quotaNow.count,
      totalBytes: quotaNow.totalBytes
    });
  }
  const row = await readRow(env, userId, articleId);
  return respondDoc(env, request, row, 200, { restored: true });
}
__name(handleRestore, "handleRestore");
async function handleImport({ request, env, user }) {
  const userId = user.user_id;
  const body = await readJsonBody(request, ARTICLE_LIMITS.requestMaxBytes);
  const items = Array.isArray(body?.articles) ? body.articles : [];
  const initialState = await ensureState(env, userId);
  if (!items.length) {
    if (body?.final === true) {
      const updatedAt = nowIso();
      const statements = [
        env.DB.prepare("UPDATE article_state SET legacy_write_blocked = 1, migrated_at = COALESCE(migrated_at, ?), updated_at = ? WHERE owner_user_id = ?").bind(updatedAt, updatedAt, userId)
      ];
      if (!initialState.legacyWriteBlocked) {
        statements.push(bumpSnapshotVersionStatement(env, userId, updatedAt));
      }
      await env.DB.batch(statements);
    }
    const empty = await ensureState(env, userId);
    return json({
      imported: 0,
      skipped: 0,
      invalid: 0,
      ids: [],
      cursor: empty.nextSeq - 1,
      legacyWriteBlocked: empty.legacyWriteBlocked
    }, 200, env, request);
  }
  if (items.length > ARTICLE_LIMITS.importMax) {
    return errorJson(ARTICLE_ERRORS.invalidBody, 400, env, request, { limit: ARTICLE_LIMITS.importMax });
  }
  let imported = 0;
  let skipped = 0;
  let invalid = 0;
  const importedIds = [];
  let chunk = [];
  const quotaResponse = /* @__PURE__ */ __name((quota) => errorJson(quota.error, 409, env, request, {
    limit: quota.limit,
    count: quota.count,
    totalBytes: quota.totalBytes,
    imported,
    skipped,
    invalid,
    ids: importedIds,
    message: "quota"
  }), "quotaResponse");
  const flush = /* @__PURE__ */ __name(async () => {
    if (!chunk.length) return { blocked: false };
    let entries = chunk;
    chunk = [];
    let attempt = 0;
    while (entries.length) {
      if (attempt > 0) {
        const retryIds = entries.map((entry) => entry.articleId);
        const retryLegacyIds = entries.map((entry) => entry.legacyId).filter(Boolean);
        const [nowIds2, nowLegacyIds2] = await Promise.all([
          readExistingIds(env, userId, retryIds),
          retryLegacyIds.length ? readExistingLegacyIds(env, userId, retryLegacyIds) : /* @__PURE__ */ new Set()
        ]);
        const remaining = [];
        for (const entry of entries) {
          if (nowIds2.has(entry.articleId) || entry.legacyId && nowLegacyIds2.has(entry.legacyId)) {
            skipped += 1;
            existingIds.add(entry.articleId);
            if (entry.legacyId) existingLegacyIds.add(entry.legacyId);
          } else {
            remaining.push(entry);
          }
        }
        entries = remaining;
        usage = await readUsage(env, userId);
        if (!entries.length) return { blocked: false };
      }
      const locks = quotaLockStatements(env, userId);
      const statements = [...locks];
      for (const entry of entries) {
        if (!entry.importToken) entry.importToken = `imp_${crypto.randomUUID()}`;
        statements.push(insertQuotaStatement(env, {
          userId,
          document: entry.document,
          size: entry.size,
          articleId: entry.articleId,
          updatedAt: entry.updatedAt,
          token: entry.importToken
        }));
        statements.push(...writeStatements(env, {
          userId,
          matchToken: entry.importToken,
          changes: [{ articleId: entry.articleId, op: "create", revision: 1, updatedAt: entry.updatedAt }]
        }));
        statements.push(...advanceStatements(env, {
          userId,
          matchToken: entry.importToken,
          changes: [{ articleId: entry.articleId, revision: 1, updatedAt: entry.updatedAt }]
        }));
      }
      let results;
      try {
        results = await env.DB.batch(statements);
      } catch (error) {
        attempt += 1;
        if (attempt >= MAX_IMPORT_ATTEMPTS) throw error;
        continue;
      }
      const inserted = [];
      const blocked = [];
      entries.forEach((entry, index) => {
        const changed = Number(results?.[locks.length + index * 3]?.meta?.changes ?? results?.[locks.length + index * 3]?.changes ?? 0);
        if (changed > 0) inserted.push(entry);
        else blocked.push(entry);
      });
      for (const entry of inserted) {
        imported += 1;
        importedIds.push(entry.articleId);
        existingIds.add(entry.articleId);
        if (entry.legacyId) existingLegacyIds.add(entry.legacyId);
      }
      if (attempt > 0) usage = await readUsage(env, userId);
      if (!blocked.length) return { blocked: false };
      const blockedIds = blocked.map((entry) => entry.articleId);
      const blockedLegacyIds = blocked.map((entry) => entry.legacyId).filter(Boolean);
      const [nowIds, nowLegacyIds] = await Promise.all([
        readExistingIds(env, userId, blockedIds),
        blockedLegacyIds.length ? readExistingLegacyIds(env, userId, blockedLegacyIds) : /* @__PURE__ */ new Set()
      ]);
      const quotaBlocked = [];
      for (const entry of blocked) {
        if (nowIds.has(entry.articleId) || entry.legacyId && nowLegacyIds.has(entry.legacyId)) {
          skipped += 1;
          existingIds.add(entry.articleId);
          if (entry.legacyId) existingLegacyIds.add(entry.legacyId);
        } else {
          quotaBlocked.push(entry);
        }
      }
      if (!quotaBlocked.length) {
        usage = await readUsage(env, userId);
        return { blocked: false };
      }
      usage = await readUsage(env, userId);
      const quota = checkQuota({ usage, nextSize: quotaBlocked[0].size, isCreate: true });
      return {
        blocked: true,
        quota: quota.ok ? { ok: false, error: ARTICLE_ERRORS.quotaExceeded, limit: ARTICLE_LIMITS.maxUserBytes, totalBytes: usage.totalBytes } : quota
      };
    }
    return { blocked: false };
  }, "flush");
  const legacyIds = items.map((raw) => String(raw?.legacyId || raw?.id || "").slice(0, 160));
  const candidateIds = Array.from(new Set(legacyIds.filter((id) => id && isValidArticleId(id))));
  const legacyCandidates = Array.from(new Set(legacyIds.filter(Boolean)));
  const [existingIds, existingLegacyIds] = await Promise.all([
    candidateIds.length ? readExistingIds(env, userId, candidateIds) : /* @__PURE__ */ new Set(),
    legacyCandidates.length ? readExistingLegacyIds(env, userId, legacyCandidates) : /* @__PURE__ */ new Set()
  ]);
  let usage = await readUsage(env, userId);
  for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
    const raw = items[itemIndex];
    const legacyId = legacyIds[itemIndex] || "";
    const parsed = normalizeArticleDocument({ ...raw, id: legacyId });
    if (!parsed.ok) {
      invalid += 1;
      continue;
    }
    const articleId = isValidArticleId(legacyId) ? legacyId : generateArticleId();
    if (existingIds.has(articleId) || legacyId && existingLegacyIds.has(legacyId)) {
      skipped += 1;
      continue;
    }
    const quota = checkQuota({ usage, nextSize: parsed.size, isCreate: true });
    if (!quota.ok) {
      const flushed2 = await flush();
      if (flushed2.blocked) return quotaResponse(flushed2.quota);
      usage = await readUsage(env, userId);
      const retried = checkQuota({ usage, nextSize: parsed.size, isCreate: true });
      if (!retried.ok) return quotaResponse(retried);
    }
    const updatedAt = nowIso();
    const document = { ...parsed.document, legacyArticleId: legacyId };
    chunk.push({ articleId, legacyId, document, size: parsed.size, updatedAt });
    existingIds.add(articleId);
    if (legacyId) existingLegacyIds.add(legacyId);
    usage = { count: (Number(usage.count) || 0) + 1, totalBytes: (Number(usage.totalBytes) || 0) + parsed.size };
    if (chunk.length >= MAX_BATCH_ITEMS) {
      const flushed2 = await flush();
      if (flushed2.blocked) return quotaResponse(flushed2.quota);
    }
  }
  const flushed = await flush();
  if (flushed.blocked) return quotaResponse(flushed.quota);
  if (body?.final === true) {
    const updatedAt = nowIso();
    const statements = [
      env.DB.prepare("UPDATE article_state SET legacy_write_blocked = 1, migrated_at = COALESCE(migrated_at, ?), updated_at = ? WHERE owner_user_id = ?").bind(updatedAt, updatedAt, userId)
    ];
    if (!initialState.legacyWriteBlocked) {
      statements.push(bumpSnapshotVersionStatement(env, userId, updatedAt));
    }
    await env.DB.batch(statements);
  }
  const state = await ensureState(env, userId);
  return json({
    imported,
    skipped,
    invalid,
    ids: importedIds,
    cursor: state.nextSeq - 1,
    legacyWriteBlocked: state.legacyWriteBlocked
  }, 200, env, request);
}
__name(handleImport, "handleImport");

// ../../../../../Users/linus/CODE/bdc-extension-ai-proof-20261105/shared/vocabulary-source.mjs
var MAX_VOCABULARY_SOURCES = 100;
function normalizeVocabularyWordKey(value) {
  return String(value || "").replace(/\s+/g, " ").trim().replace(/^[\s"'“”‘’()\[\]{}<>，。！？；：,.!?;:]+/, "").replace(/[\s"'“”‘’()\[\]{}<>，。！？；：,.!?;:]+$/, "").replace(/\s+/g, " ").trim().toLowerCase();
}
__name(normalizeVocabularyWordKey, "normalizeVocabularyWordKey");
function publicSourceUrl(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.length > 4096) return "";
  try {
    const url = new URL(raw);
    return /^(https?:)$/.test(url.protocol) && !url.username && !url.password ? url.href : "";
  } catch (_) {
    return "";
  }
}
__name(publicSourceUrl, "publicSourceUrl");
function vocabularySourceKey(source = {}) {
  return JSON.stringify([
    publicSourceUrl(source.sourceUrl),
    String(source.articleId || ""),
    String(source.sentence || ""),
    Number(source.anchor?.start ?? -1),
    Number(source.anchor?.end ?? -1),
    String(source.anchor?.quote || ""),
    String(source.meaning || "")
  ]);
}
__name(vocabularySourceKey, "vocabularySourceKey");
function normalizeVocabularySource(source, { cleanString: cleanString2, normalizeAnchor: normalizeAnchor2, maxEntityId, maxContentVersion }) {
  const result = {
    sentence: cleanString2(source.sentence, 4e3),
    context: cleanString2(source.context, 8e3),
    articleId: cleanString2(source.articleId, maxEntityId),
    contentVersion: cleanString2(source.contentVersion, maxContentVersion),
    anchor: normalizeAnchor2(source.anchor),
    addedAt: cleanString2(source.addedAt, 40)
  };
  for (const [key, limit] of [["sourceUrl", 4096], ["pageTitle", 300], ["meaning", 4e3], ["locale", 20]]) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    result[key] = key === "sourceUrl" ? publicSourceUrl(source[key]) ? cleanString2(source[key], limit) : "" : cleanString2(source[key], limit);
  }
  return result;
}
__name(normalizeVocabularySource, "normalizeVocabularySource");

// ../../../../../Users/linus/CODE/bdc-extension-ai-proof-20261105/shared/reading-protocol.mjs
var READING_ENTITY_TYPES = [
  "learningItem",
  "articleDocument",
  "conversation",
  "message",
  "vocabularyBook",
  "vocabularyEntry",
  "vocabularyLink"
];
var READING_KINDS = ["word", "phrase", "sentence"];
var UNDERSTANDING_STATES = ["unmarked", "needs_review", "understood"];
var DOCUMENT_KINDS = ["note", "ai"];
var READING_LIMITS = {
  maxEntityId: 160,
  maxMutationId: 120,
  maxPatchBytes: 1024 * 1024,
  maxBatchKeys: 200,
  maxMutationsPerRequest: 100,
  maxChangesPage: 300,
  maxNoteChars: 2e4,
  maxDocumentChars: 4e5,
  maxMessageChars: 2e5,
  maxQuoteChars: 2e3,
  maxTitleChars: 300,
  maxAnchorContext: 120,
  maxContentVersion: 120,
  requestMaxBytes: 4 * 1024 * 1024
};
var READING_ERRORS = {
  unauthorized: "unauthorized",
  invalidMutation: "reading_invalid_mutation",
  invalidEntity: "reading_invalid_entity",
  invalidPatch: "reading_invalid_patch",
  entityTooLarge: "reading_entity_too_large",
  sourcesFull: "vocabulary_sources_full",
  notFound: "reading_entity_not_found",
  revisionRequired: "reading_revision_required",
  revisionConflict: "reading_revision_conflict",
  alreadyDeleted: "reading_already_deleted",
  legacyBlocked: "reading_legacy_write_blocked",
  cursorInvalid: "reading_cursor_invalid",
  methodNotAllowed: "method_not_allowed"
};
var PATCH_FIELDS = {
  learningItem: [
    "articleId",
    "contentVersion",
    "kind",
    "anchor",
    "sentence",
    "explanation",
    "firstViewedAt",
    "lastViewedAt",
    "marked",
    "understanding",
    "note",
    "positionUncertain",
    "sourceContentVersion",
    "createdAt",
    "updatedAt",
    "deletedAt"
  ],
  articleDocument: [
    "articleId",
    "kind",
    "title",
    "content",
    "sourceItemIds",
    "sourceMessageIds",
    "contentVersion",
    "createdAt",
    "updatedAt",
    "deletedAt"
  ],
  conversation: ["articleId", "legacyArticleKey", "title", "createdAt", "updatedAt", "deletedAt"],
  message: [
    "conversationId",
    "role",
    "content",
    "status",
    "learningItemId",
    "anchor",
    "contentVersion",
    "createdAt",
    "updatedAt",
    "deletedAt"
  ],
  vocabularyBook: ["name", "sourceType", "articleId", "sourceUrl", "shareId", "createdAt", "updatedAt", "deletedAt"],
  vocabularyEntry: [
    "bookId",
    "word",
    "meaning",
    "phonetic",
    "pos",
    "examples",
    "sources",
    "definition",
    "source",
    "sourceArticleId",
    "wordbookId",
    "context",
    "shareId",
    "addedAt",
    "createdAt",
    "updatedAt",
    "deletedAt"
  ],
  vocabularyLink: ["itemId", "bookId", "entryId", "addedAt", "removedAt", "updatedAt", "deletedAt", "positionUnknown"]
};
function isPlainObject4(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
__name(isPlainObject4, "isPlainObject");
function isReadingEntityType(value) {
  return READING_ENTITY_TYPES.includes(String(value || ""));
}
__name(isReadingEntityType, "isReadingEntityType");
function isValidEntityId(value) {
  const id = String(value == null ? "" : value);
  if (!id || id.length > READING_LIMITS.maxEntityId) return false;
  return /^[A-Za-z0-9][A-Za-z0-9_:.~-]*$/.test(id);
}
__name(isValidEntityId, "isValidEntityId");
function normalizeMutationId2(value) {
  const raw = String(value == null ? "" : value).trim();
  if (!raw) return "";
  return raw.replace(/[^A-Za-z0-9_:.~-]/g, "").slice(0, READING_LIMITS.maxMutationId);
}
__name(normalizeMutationId2, "normalizeMutationId");
function utf8Bytes2(text) {
  const raw = String(text == null ? "" : text);
  if (typeof TextEncoder !== "undefined") {
    try {
      return new TextEncoder().encode(raw).length;
    } catch (_) {
    }
  }
  let bytes = 0;
  for (const ch of raw) {
    const code = ch.codePointAt(0);
    if (code <= 127) bytes += 1;
    else if (code <= 2047) bytes += 2;
    else if (code <= 65535) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}
__name(utf8Bytes2, "utf8Bytes");
function cleanString(value, max) {
  return String(value == null ? "" : value).slice(0, max);
}
__name(cleanString, "cleanString");
function normalizeAnchor(raw) {
  if (!isPlainObject4(raw)) return { start: -1, end: -1, quote: "", prefix: "", suffix: "" };
  const start = Number.isInteger(Number(raw.start)) ? Number(raw.start) : -1;
  const end = Number.isInteger(Number(raw.end)) ? Number(raw.end) : -1;
  return {
    start: start >= 0 ? start : -1,
    end: end >= 0 ? end : -1,
    quote: cleanString(raw.quote, READING_LIMITS.maxQuoteChars),
    prefix: cleanString(raw.prefix, READING_LIMITS.maxAnchorContext),
    suffix: cleanString(raw.suffix, READING_LIMITS.maxAnchorContext)
  };
}
__name(normalizeAnchor, "normalizeAnchor");
function normalizeStringArray(value, maxItems = 200) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => cleanString(item, READING_LIMITS.maxEntityId)).filter(Boolean).slice(0, maxItems);
}
__name(normalizeStringArray, "normalizeStringArray");
function normalizeReadingPatch(entityType, raw) {
  if (!isReadingEntityType(entityType) || !isPlainObject4(raw)) return null;
  const fields = PATCH_FIELDS[entityType];
  const out = {};
  for (const field2 of fields) {
    if (!Object.prototype.hasOwnProperty.call(raw, field2)) continue;
    const value = raw[field2];
    switch (field2) {
      case "anchor":
        out.anchor = normalizeAnchor(value);
        break;
      case "sourceItemIds":
        out.sourceItemIds = normalizeStringArray(value);
        break;
      case "sourceMessageIds":
        out.sourceMessageIds = normalizeStringArray(value);
        break;
      case "examples":
        out.examples = Array.isArray(value) ? value.filter(isPlainObject4).slice(0, 50).map((ex) => {
          const normalized = {
            en: cleanString(ex.en, 4e3),
            zh: cleanString(ex.zh, 4e3)
          };
          if (typeof ex.english === "string") normalized.english = cleanString(ex.english, 4e3);
          if (typeof ex.chinese === "string") normalized.chinese = cleanString(ex.chinese, 4e3);
          if (Array.isArray(ex.alignment)) {
            normalized.alignment = ex.alignment.filter(isPlainObject4).slice(0, 50).map((pair) => ({
              en: cleanString(pair.en, 1e3),
              zh: cleanString(pair.zh, 1e3)
            })).filter((pair) => pair.en && pair.zh);
          }
          return normalized;
        }) : [];
        break;
      case "sources":
        out.sources = Array.isArray(value) ? value.filter(isPlainObject4).map((source) => normalizeVocabularySource(source, {
          cleanString,
          normalizeAnchor,
          maxEntityId: READING_LIMITS.maxEntityId,
          maxContentVersion: READING_LIMITS.maxContentVersion
        })) : [];
        break;
      case "explanation": {
        if (value === null || value === void 0) {
          out.explanation = null;
          break;
        }
        if (!isPlainObject4(value)) break;
        out.explanation = {
          language: cleanString(value.language, 20),
          result: value.result === void 0 ? null : value.result,
          generatedAt: cleanString(value.generatedAt, 40),
          provenance: isPlainObject4(value.provenance) ? value.provenance : null
        };
        break;
      }
      case "note":
        out.note = cleanString(value, READING_LIMITS.maxNoteChars);
        break;
      case "content":
        out.content = cleanString(value, READING_LIMITS.maxDocumentChars);
        break;
      case "title":
      case "name":
        out[field2] = cleanString(value, READING_LIMITS.maxTitleChars);
        break;
      case "sentence":
      case "quote":
        out[field2] = cleanString(value, READING_LIMITS.maxQuoteChars);
        break;
      case "meaning":
      case "definition":
        out[field2] = cleanString(value, 4e3);
        break;
      case "phonetic":
      case "pos":
        out[field2] = cleanString(value, 200);
        break;
      case "word":
        out.word = cleanString(value, 400);
        break;
      case "role":
        out.role = ["user", "assistant", "system"].includes(value) ? value : "user";
        break;
      case "status":
        out.status = cleanString(value, 40);
        break;
      case "marked":
        out.marked = value === true;
        break;
      case "understanding":
        out.understanding = UNDERSTANDING_STATES.includes(value) ? value : "unmarked";
        break;
      case "kind":
        out.kind = entityType === "articleDocument" ? DOCUMENT_KINDS.includes(value) ? value : "note" : READING_KINDS.includes(value) ? value : "word";
        break;
      case "firstViewedAt":
      case "lastViewedAt":
      case "createdAt":
      case "updatedAt":
      case "deletedAt":
      case "addedAt":
      case "removedAt":
        out[field2] = value ? cleanString(value, 40) : "";
        break;
      case "positionUncertain":
      case "positionUnknown":
        out[field2] = value === true;
        break;
      case "contentVersion":
      case "sourceContentVersion":
      case "articleId":
      case "bookId":
      case "entryId":
      case "itemId":
      case "conversationId":
      case "learningItemId":
      case "legacyArticleKey":
        out[field2] = cleanString(value, READING_LIMITS.maxContentVersion);
        break;
      default:
        out[field2] = value;
    }
  }
  if (entityType === "learningItem") {
    if (out.anchor) out.anchor = normalizeAnchor(out.anchor);
    if (out.understanding && !UNDERSTANDING_STATES.includes(out.understanding)) out.understanding = "unmarked";
  }
  return out;
}
__name(normalizeReadingPatch, "normalizeReadingPatch");
function patchSize(patch) {
  try {
    return utf8Bytes2(JSON.stringify(patch || {}));
  } catch (_) {
    return READING_LIMITS.maxPatchBytes + 1;
  }
}
__name(patchSize, "patchSize");
function validateReadingMutation(raw) {
  if (!isPlainObject4(raw)) return { ok: false, error: READING_ERRORS.invalidMutation };
  const entityType = String(raw.entityType || "");
  const entityId = String(raw.entityId || "");
  if (!isReadingEntityType(entityType)) return { ok: false, error: READING_ERRORS.invalidEntity };
  if (!isValidEntityId(entityId)) return { ok: false, error: READING_ERRORS.invalidEntity };
  const op = raw.op === "delete" ? "delete" : raw.op === "upsert" ? "upsert" : "";
  if (!op) return { ok: false, error: READING_ERRORS.invalidMutation };
  const expectedRevision = Number(raw.expectedRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    return { ok: false, error: READING_ERRORS.revisionRequired };
  }
  const mutationId = normalizeMutationId2(raw.mutationId);
  if (!mutationId) return { ok: false, error: READING_ERRORS.invalidMutation };
  let patch = null;
  if (op === "upsert") {
    if (entityType === "vocabularyEntry" && Array.isArray(raw.patch?.sources) && raw.patch.sources.filter(isPlainObject4).length > MAX_VOCABULARY_SOURCES) {
      return { ok: false, error: READING_ERRORS.sourcesFull };
    }
    patch = normalizeReadingPatch(entityType, raw.patch);
    if (!patch) return { ok: false, error: READING_ERRORS.invalidPatch };
    const size = patchSize(patch);
    if (size > READING_LIMITS.maxPatchBytes) return { ok: false, error: READING_ERRORS.entityTooLarge, size };
  }
  return {
    ok: true,
    mutation: {
      mutationId,
      entityType,
      entityId,
      op,
      expectedRevision,
      patch,
      clientUpdatedAt: cleanString(raw.clientUpdatedAt, 40)
    }
  };
}
__name(validateReadingMutation, "validateReadingMutation");
function wireReadingEntity(entity) {
  if (!isPlainObject4(entity)) return null;
  const out = { ...entity };
  delete out.scope;
  delete out.key;
  delete out.pending;
  delete out.dirty;
  delete out.conflict;
  delete out.lastError;
  return out;
}
__name(wireReadingEntity, "wireReadingEntity");
function canonicalizeReadingValue(value) {
  if (Array.isArray(value)) return value.map((item) => canonicalizeReadingValue(item));
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalizeReadingValue(value[key]);
    return out;
  }
  return value === void 0 ? null : value;
}
__name(canonicalizeReadingValue, "canonicalizeReadingValue");
function readingMutationFingerprint(mutation) {
  if (!mutation || typeof mutation !== "object") return "";
  const entityType = String(mutation.entityType || "");
  const op = mutation.op === "delete" ? "delete" : "upsert";
  const patch = op === "delete" ? null : normalizeReadingPatch(entityType, mutation.patch || {});
  return JSON.stringify(canonicalizeReadingValue({
    mutationId: normalizeMutationId2(mutation.mutationId),
    entityType,
    entityId: String(mutation.entityId || ""),
    op,
    expectedRevision: Number(mutation.expectedRevision) || 0,
    patch
  }));
}
__name(readingMutationFingerprint, "readingMutationFingerprint");
function snapshotCarriesReading(payload) {
  if (!isPlainObject4(payload)) return false;
  const vocab = payload.vocabulary;
  const assistant = payload.assistant;
  const vocabHas = isPlainObject4(vocab) && Array.isArray(vocab.books) && vocab.books.length > 0;
  const assistantHas = isPlainObject4(assistant) && Array.isArray(assistant.conversations) && assistant.conversations.length > 0;
  return vocabHas || assistantHas;
}
__name(snapshotCarriesReading, "snapshotCarriesReading");
function parseReadingCursor(raw) {
  if (raw === void 0 || raw === null || raw === "") return { cursor: 0, invalid: false };
  const text = String(raw).trim();
  if (!/^\d{1,15}$/.test(text)) return { cursor: 0, invalid: true };
  return { cursor: Number.parseInt(text, 10), invalid: false };
}
__name(parseReadingCursor, "parseReadingCursor");
function parseReadingLimit(raw, fallback = 200) {
  const text = String(raw == null ? "" : raw).trim();
  if (!/^\d{1,5}$/.test(text)) return fallback;
  const value = Number.parseInt(text, 10);
  if (!value) return fallback;
  return Math.min(READING_LIMITS.maxChangesPage, value);
}
__name(parseReadingLimit, "parseReadingLimit");

// ../../../../../Users/linus/CODE/bdc-extension-ai-proof-20261105/cloudflare-worker/src/reading.js
function nowIso2() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
__name(nowIso2, "nowIso");
var MAX_QUERY_IDS2 = 90;
async function ensureState2(env, userId) {
  await env.DB.prepare("INSERT INTO reading_state (owner_user_id, next_seq, legacy_write_blocked, updated_at) VALUES (?, 1, 0, ?) ON CONFLICT (owner_user_id) DO NOTHING").bind(userId, nowIso2()).run();
  const row = await env.DB.prepare("SELECT next_seq, legacy_write_blocked, migrated_at, updated_at FROM reading_state WHERE owner_user_id = ?").bind(userId).first();
  return {
    nextSeq: Number(row?.next_seq || 1),
    legacyWriteBlocked: Number(row?.legacy_write_blocked || 0) === 1,
    migratedAt: row?.migrated_at || "",
    updatedAt: row?.updated_at || ""
  };
}
__name(ensureState2, "ensureState");
function readingRevisionStatements(env, {
  userId,
  entityType,
  entityId,
  op,
  revision,
  timestamp,
  mutationId,
  guardSql,
  guardArgs
}) {
  return [
    env.DB.prepare("INSERT INTO reading_changes (owner_user_id, seq, entity_type, entity_id, op, revision, updated_at) SELECT owner_user_id, next_seq, ?, ?, ?, ?, ? FROM reading_state WHERE owner_user_id = ? AND EXISTS (" + guardSql + ") AND EXISTS (SELECT 1 FROM reading_entities WHERE owner_user_id = ? AND entity_type = ? AND entity_id = ? AND revision = ? AND last_mutation_id = ?)").bind(entityType, entityId, op, revision, timestamp, userId, ...guardArgs, userId, entityType, entityId, revision, mutationId),
    env.DB.prepare("UPDATE reading_state SET next_seq = next_seq + 1, updated_at = ? WHERE owner_user_id = ? AND EXISTS (" + guardSql + ") AND EXISTS (SELECT 1 FROM reading_changes WHERE owner_user_id = ? AND entity_type = ? AND entity_id = ? AND revision = ?)").bind(timestamp, userId, ...guardArgs, userId, entityType, entityId, revision)
  ];
}
__name(readingRevisionStatements, "readingRevisionStatements");
async function isLegacyReadingWriteBlocked(env, userId) {
  const row = await env.DB.prepare("SELECT legacy_write_blocked FROM reading_state WHERE owner_user_id = ?").bind(userId).first();
  return Number(row?.legacy_write_blocked || 0) === 1;
}
__name(isLegacyReadingWriteBlocked, "isLegacyReadingWriteBlocked");
function bumpSnapshotVersionStatement2(env, userId, updatedAt) {
  return env.DB.prepare("UPDATE snapshots SET version = version + 1, updated_at = ? WHERE user_id = ?").bind(updatedAt, userId);
}
__name(bumpSnapshotVersionStatement2, "bumpSnapshotVersionStatement");
function rowToEntity(row) {
  if (!row) return null;
  let data = {};
  try {
    data = row.data_json ? JSON.parse(row.data_json) : {};
  } catch (_) {
    data = {};
  }
  return wireReadingEntity({
    ...data,
    id: row.entity_id,
    revision: Number(row.revision) || 0,
    deletedAt: row.deleted_at || ""
  });
}
__name(rowToEntity, "rowToEntity");
async function readRow2(env, userId, entityType, entityId) {
  return env.DB.prepare("SELECT * FROM reading_entities WHERE owner_user_id = ? AND entity_type = ? AND entity_id = ?").bind(userId, entityType, entityId).first();
}
__name(readRow2, "readRow");
async function readMutation(env, userId, mutationId) {
  return env.DB.prepare("SELECT * FROM reading_mutations WHERE owner_user_id = ? AND mutation_id = ?").bind(userId, mutationId).first();
}
__name(readMutation, "readMutation");
async function readBatch(env, userId, keys) {
  const rows = await readRowsForKeys(env, userId, keys);
  const byKey = new Map(rows.map((row) => [`${row.entity_type}:${row.entity_id}`, row]));
  const out = [];
  for (const key of keys) {
    const row = byKey.get(`${key.entityType}:${key.entityId}`);
    if (!row) continue;
    out.push({
      entityType: key.entityType,
      entityId: key.entityId,
      ...rowToEntity(row)
    });
  }
  return out;
}
__name(readBatch, "readBatch");
async function readRowsForKeys(env, userId, keys) {
  const grouped = /* @__PURE__ */ new Map();
  for (const key of keys) {
    const entityType = String(key?.entityType || "");
    const entityId = String(key?.entityId || "");
    if (!READING_ENTITY_TYPES.includes(entityType) || !entityId) continue;
    if (!grouped.has(entityType)) grouped.set(entityType, /* @__PURE__ */ new Set());
    grouped.get(entityType).add(entityId);
  }
  const rows = [];
  for (const [entityType, idSet] of grouped) {
    const ids = Array.from(idSet);
    for (let index = 0; index < ids.length; index += MAX_QUERY_IDS2) {
      const chunk = ids.slice(index, index + MAX_QUERY_IDS2);
      const placeholders = chunk.map(() => "?").join(", ");
      const result = await env.DB.prepare(`SELECT * FROM reading_entities WHERE owner_user_id = ? AND entity_type = ? AND entity_id IN (${placeholders})`).bind(userId, entityType, ...chunk).all();
      const list = result?.results;
      if (Array.isArray(list)) rows.push(...list);
    }
  }
  return rows;
}
__name(readRowsForKeys, "readRowsForKeys");
async function readMutationsByIds(env, userId, mutationIds) {
  const unique = Array.from(new Set(mutationIds.filter(Boolean)));
  const found = /* @__PURE__ */ new Map();
  for (let index = 0; index < unique.length; index += MAX_QUERY_IDS2) {
    const chunk = unique.slice(index, index + MAX_QUERY_IDS2);
    const placeholders = chunk.map(() => "?").join(", ");
    const result = await env.DB.prepare(`SELECT * FROM reading_mutations WHERE owner_user_id = ? AND mutation_id IN (${placeholders})`).bind(userId, ...chunk).all();
    for (const row of result?.results || []) found.set(row.mutation_id, row);
  }
  return found;
}
__name(readMutationsByIds, "readMutationsByIds");
async function createMutationCache(env, userId, mutations) {
  const entities = /* @__PURE__ */ new Map();
  for (const mutation of mutations) {
    entities.set(`${mutation.entityType}:${mutation.entityId}`, null);
  }
  const mutationRows = /* @__PURE__ */ new Map();
  for (const mutation of mutations) mutationRows.set(mutation.mutationId, null);
  const [entityRows, priorRows] = await Promise.all([
    readRowsForKeys(env, userId, mutations.map((mutation) => ({
      entityType: mutation.entityType,
      entityId: mutation.entityId
    }))),
    readMutationsByIds(env, userId, mutations.map((mutation) => mutation.mutationId))
  ]);
  for (const row of entityRows) entities.set(`${row.entity_type}:${row.entity_id}`, row);
  for (const [mutationId, row] of priorRows) mutationRows.set(mutationId, row);
  return { entities, mutations: mutationRows };
}
__name(createMutationCache, "createMutationCache");
function parseKeys(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const unique = [];
  const seen = /* @__PURE__ */ new Set();
  for (const item of list) {
    if (!item) continue;
    const entityType = String(item.entityType || "");
    const entityId = String(item.entityId || "");
    if (!READING_ENTITY_TYPES.includes(entityType) || !entityId) continue;
    const key = `${entityType}:${entityId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ entityType, entityId });
    if (unique.length >= READING_LIMITS.maxBatchKeys) break;
  }
  return unique;
}
__name(parseKeys, "parseKeys");
function priorResponse(env, userId, prior, mutation, fingerprint) {
  const existingPromise = readRow2(env, userId, prior.entity_type, prior.entity_id);
  const matches = priorMatchesMutation(prior, mutation, fingerprint);
  return existingPromise.then((existing) => {
    if (!matches) {
      return {
        mutationId: mutation.mutationId,
        status: "conflict",
        code: "reading_mutation_mismatch",
        current: rowToEntity(existing)
      };
    }
    let result = null;
    try {
      result = prior.result_json ? JSON.parse(prior.result_json) : null;
    } catch (_) {
      result = null;
    }
    if (result && result.claim) {
      const current = rowToEntity(existing);
      return {
        mutationId: mutation.mutationId,
        status: "ok",
        idempotent: true,
        revision: Number(prior.revision) || Number(current?.revision) || 0,
        record: current
      };
    }
    return { mutationId: mutation.mutationId, status: "ok", idempotent: true, ...result || {} };
  });
}
__name(priorResponse, "priorResponse");
function priorMatchesMutation(prior, mutation, fingerprint) {
  if (!prior) return false;
  if (prior.request_json === fingerprint) return true;
  let parsed = null;
  try {
    parsed = prior.request_json ? JSON.parse(prior.request_json) : null;
  } catch (_) {
    parsed = null;
  }
  if (!parsed || typeof parsed !== "object") return false;
  return readingMutationFingerprint(parsed) === fingerprint && String(prior.entity_type || "") === mutation.entityType && String(prior.entity_id || "") === mutation.entityId;
}
__name(priorMatchesMutation, "priorMatchesMutation");
async function applyMutation(env, userId, mutation, cache = null) {
  const entityCacheKey = `${mutation.entityType}:${mutation.entityId}`;
  let existing;
  let prior;
  if (cache && cache.entities.has(entityCacheKey)) {
    existing = cache.entities.get(entityCacheKey) || null;
    cache.entities.delete(entityCacheKey);
  } else {
    existing = await readRow2(env, userId, mutation.entityType, mutation.entityId);
  }
  if (cache && cache.mutations.has(mutation.mutationId)) {
    prior = cache.mutations.get(mutation.mutationId) || null;
    cache.mutations.delete(mutation.mutationId);
  } else {
    prior = await readMutation(env, userId, mutation.mutationId);
  }
  const fingerprint = readingMutationFingerprint(mutation);
  if (prior) return priorResponse(env, userId, prior, mutation, fingerprint);
  const currentRevision = Number(existing?.revision) || 0;
  if (mutation.op === "upsert" && existing?.deleted_at) {
    if (mutation.expectedRevision !== currentRevision) {
      return {
        mutationId: mutation.mutationId,
        status: "conflict",
        code: READING_ERRORS.alreadyDeleted,
        current: rowToEntity(existing)
      };
    }
  }
  if (mutation.op === "delete" && !existing) {
    return {
      mutationId: mutation.mutationId,
      status: "conflict",
      code: READING_ERRORS.notFound,
      current: null
    };
  }
  if (mutation.op === "delete" && existing?.deleted_at && mutation.expectedRevision === currentRevision) {
    return {
      mutationId: mutation.mutationId,
      status: "ok",
      idempotent: true,
      revision: currentRevision,
      record: rowToEntity(existing)
    };
  }
  if (mutation.expectedRevision !== currentRevision) {
    return {
      mutationId: mutation.mutationId,
      status: "conflict",
      code: READING_ERRORS.revisionConflict,
      current: rowToEntity(existing)
    };
  }
  const nextRevision = currentRevision + 1;
  const timestamp = nowIso2();
  const deletedAt = mutation.op === "delete" ? timestamp : null;
  const dataJson = mutation.op === "delete" ? existing?.data_json || "{}" : JSON.stringify(mutation.patch || {});
  const resultRecord = {
    ...mutation.op === "delete" ? rowToEntity(existing) : wireReadingEntity({ ...mutation.patch, id: mutation.entityId }),
    id: mutation.entityId,
    revision: nextRevision,
    deletedAt: deletedAt || ""
  };
  const resultJson = JSON.stringify({ revision: nextRevision, record: resultRecord });
  const claimToken = `claim_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const claimJson = JSON.stringify({ claim: claimToken });
  const claimWhere = "SELECT 1 FROM reading_mutations WHERE owner_user_id = ? AND mutation_id = ? AND result_json = ?";
  const entityMatchWhere = "SELECT 1 FROM reading_entities WHERE owner_user_id = ? AND entity_type = ? AND entity_id = ? AND revision = ? AND last_mutation_id = ?";
  const statements = [];
  statements.push(env.DB.prepare("INSERT INTO reading_mutations (owner_user_id, mutation_id, entity_type, entity_id, revision, request_json, result_json, created_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?) ON CONFLICT (owner_user_id, mutation_id) DO NOTHING").bind(userId, mutation.mutationId, mutation.entityType, mutation.entityId, fingerprint, claimJson, timestamp));
  if (existing) {
    statements.push(env.DB.prepare("UPDATE reading_entities SET revision = ?, deleted_at = ?, data_json = ?, updated_at = ?, last_mutation_id = ? WHERE owner_user_id = ? AND entity_type = ? AND entity_id = ? AND revision = ? AND EXISTS (" + claimWhere + ")").bind(nextRevision, deletedAt, dataJson, timestamp, mutation.mutationId, userId, mutation.entityType, mutation.entityId, currentRevision, userId, mutation.mutationId, claimJson));
  } else {
    statements.push(env.DB.prepare("INSERT INTO reading_entities (owner_user_id, entity_type, entity_id, revision, deleted_at, data_json, updated_at, last_mutation_id) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (" + claimWhere + ")").bind(userId, mutation.entityType, mutation.entityId, nextRevision, deletedAt, dataJson, timestamp, mutation.mutationId, userId, mutation.mutationId, claimJson));
  }
  statements.push(...readingRevisionStatements(env, {
    userId,
    entityType: mutation.entityType,
    entityId: mutation.entityId,
    op: mutation.op,
    revision: nextRevision,
    timestamp,
    mutationId: mutation.mutationId,
    guardSql: claimWhere,
    guardArgs: [userId, mutation.mutationId, claimJson]
  }));
  statements.push(env.DB.prepare("UPDATE reading_mutations SET revision = ?, result_json = ? WHERE owner_user_id = ? AND mutation_id = ? AND result_json = ? AND EXISTS (" + entityMatchWhere + ")").bind(nextRevision, resultJson, userId, mutation.mutationId, claimJson, userId, mutation.entityType, mutation.entityId, nextRevision, mutation.mutationId));
  statements.push(env.DB.prepare("DELETE FROM reading_mutations WHERE owner_user_id = ? AND mutation_id = ? AND result_json = ? AND NOT EXISTS (" + entityMatchWhere + ")").bind(userId, mutation.mutationId, claimJson, userId, mutation.entityType, mutation.entityId, nextRevision, mutation.mutationId));
  let batchResults;
  try {
    batchResults = await env.DB.batch(statements);
  } catch (error) {
    const latestPrior = await readMutation(env, userId, mutation.mutationId);
    if (latestPrior) return priorResponse(env, userId, latestPrior, mutation, fingerprint);
    const latest = await readRow2(env, userId, mutation.entityType, mutation.entityId);
    return {
      mutationId: mutation.mutationId,
      status: "conflict",
      code: READING_ERRORS.revisionConflict,
      current: rowToEntity(latest)
    };
  }
  const applied = await readMutation(env, userId, mutation.mutationId);
  if (!applied || !priorMatchesMutation(applied, mutation, fingerprint)) {
    const latest = await readRow2(env, userId, mutation.entityType, mutation.entityId);
    return {
      mutationId: mutation.mutationId,
      status: "conflict",
      code: applied ? "reading_mutation_mismatch" : READING_ERRORS.revisionConflict,
      current: rowToEntity(latest)
    };
  }
  let receipt = null;
  try {
    receipt = applied.result_json ? JSON.parse(applied.result_json) : null;
  } catch (_) {
    receipt = null;
  }
  if (!receipt || receipt.claim) {
    const latest = await readRow2(env, userId, mutation.entityType, mutation.entityId);
    return {
      mutationId: mutation.mutationId,
      status: "conflict",
      code: READING_ERRORS.revisionConflict,
      current: rowToEntity(latest)
    };
  }
  return { mutationId: mutation.mutationId, status: "ok", idempotent: false, ...receipt };
}
__name(applyMutation, "applyMutation");
async function handleBatch({ request, env, user }) {
  const userId = user.user_id;
  const body = await readJsonBody(request, READING_LIMITS.requestMaxBytes);
  const keys = parseKeys(body?.keys);
  if (keys.length > READING_LIMITS.maxBatchKeys) {
    return errorJson(READING_ERRORS.invalidMutation, 400, env, request, { limit: READING_LIMITS.maxBatchKeys });
  }
  const entities = keys.length ? await readBatch(env, userId, keys) : [];
  return json({ entities }, 200, env, request);
}
__name(handleBatch, "handleBatch");
async function handleMutations({ request, env, user }) {
  const userId = user.user_id;
  const state = await ensureState2(env, userId);
  const body = await readJsonBody(request, READING_LIMITS.requestMaxBytes);
  const rawList = Array.isArray(body?.mutations) ? body.mutations : [];
  if (rawList.length > READING_LIMITS.maxMutationsPerRequest) {
    return errorJson(READING_ERRORS.invalidMutation, 400, env, request, { limit: READING_LIMITS.maxMutationsPerRequest });
  }
  const results = [];
  const validated = rawList.map((raw) => ({ raw, parsed: validateReadingMutation(raw) }));
  const validMutations = validated.filter((item) => item.parsed.ok).map((item) => item.parsed.mutation);
  const cache = validMutations.length ? await createMutationCache(env, userId, validMutations) : null;
  for (const item of validated) {
    if (!item.parsed.ok) {
      results.push({
        mutationId: String(item.raw?.mutationId || ""),
        status: "invalid",
        code: item.parsed.error
      });
      continue;
    }
    results.push(await applyMutation(env, userId, item.parsed.mutation, cache));
  }
  const final = body?.final === true;
  const allApplied = results.every((item) => item.status === "ok");
  if (final && allApplied) {
    const updatedAt = nowIso2();
    const statements = [
      env.DB.prepare("UPDATE reading_state SET legacy_write_blocked = 1, migrated_at = COALESCE(migrated_at, ?), updated_at = ? WHERE owner_user_id = ?").bind(updatedAt, updatedAt, userId)
    ];
    if (!state.legacyWriteBlocked) {
      statements.push(bumpSnapshotVersionStatement2(env, userId, updatedAt));
    }
    await env.DB.batch(statements);
  }
  const nextState = await ensureState2(env, userId);
  return json({
    results,
    cursor: nextState.nextSeq - 1,
    legacyWriteBlocked: nextState.legacyWriteBlocked,
    finalApplied: final && allApplied
  }, 200, env, request);
}
__name(handleMutations, "handleMutations");
async function handleChanges({ request, env, url, user }) {
  const userId = user.user_id;
  const state = await ensureState2(env, userId);
  const { cursor, invalid } = parseReadingCursor(url.searchParams.get("cursor"));
  const limit = parseReadingLimit(url.searchParams.get("limit"), 200);
  if (invalid) {
    return json({ resetRequired: true, reason: "invalid_cursor", cursor: state.nextSeq - 1, changes: [], hasMore: false }, 200, env, request);
  }
  if (cursor >= state.nextSeq) {
    return json({ resetRequired: false, cursor: state.nextSeq - 1, serverCursor: state.nextSeq - 1, changes: [], hasMore: false, legacyWriteBlocked: state.legacyWriteBlocked }, 200, env, request);
  }
  const rows = await env.DB.prepare("SELECT c.seq, c.entity_type, c.entity_id, c.op, c.revision, c.updated_at, e.deleted_at FROM reading_changes c LEFT JOIN reading_entities e ON e.owner_user_id = c.owner_user_id AND e.entity_type = c.entity_type AND e.entity_id = c.entity_id WHERE c.owner_user_id = ? AND c.seq > ? ORDER BY c.seq ASC LIMIT ?").bind(userId, cursor, limit + 1).all();
  const all = rows?.results || [];
  const hasMore = all.length > limit;
  const slice = all.slice(0, limit);
  const nextCursor = slice.length ? Number(slice[slice.length - 1].seq) : cursor;
  return json({
    resetRequired: false,
    cursor: nextCursor,
    serverCursor: state.nextSeq - 1,
    hasMore,
    legacyWriteBlocked: state.legacyWriteBlocked,
    changes: slice.map((row) => ({
      entityType: row.entity_type,
      entityId: row.entity_id,
      op: row.op,
      revision: Number(row.revision) || 0,
      updatedAt: row.updated_at || "",
      deletedAt: row.deleted_at || "",
      seq: Number(row.seq) || 0
    }))
  }, 200, env, request);
}
__name(handleChanges, "handleChanges");
async function handleReadingRoute({ request, env, url, user, rest }) {
  const path = String(rest || "");
  const method = request.method;
  if (path === "/capabilities" && method === "GET") {
    const state = await ensureState2(env, user.user_id);
    return json({
      supported: true,
      // 舊後端沒有這個能力時，新前端會在同步前停下並保留 outbox。
      learningItemMarked: true,
      legacyWriteBlocked: state.legacyWriteBlocked,
      cursor: state.nextSeq - 1,
      limits: READING_LIMITS
    }, 200, env, request);
  }
  if (path === "/changes" && method === "GET") {
    return handleChanges({ request, env, url, user });
  }
  if (path === "/batch" && method === "POST") {
    return handleBatch({ request, env, user });
  }
  if (path === "/mutations" && method === "POST") {
    return handleMutations({ request, env, user });
  }
  if (path === "" || path === "/" || path === "/capabilities" || path === "/changes" || path === "/batch" || path === "/mutations") {
    return errorJson(READING_ERRORS.methodNotAllowed, 405, env, request);
  }
  return errorJson("not_found", 404, env, request);
}
__name(handleReadingRoute, "handleReadingRoute");

// ../../../../../Users/linus/CODE/bdc-extension-ai-proof-20261105/shared/capture-protocol.mjs
var CAPTURE_MAX_BYTES = 128 * 1024;
function inputError(code = "capture_invalid_input") {
  return Object.assign(new Error(code), { code, status: 400 });
}
__name(inputError, "inputError");
function field(raw, name, limit, { required = false } = {}) {
  if (raw[name] != null && typeof raw[name] !== "string") throw inputError();
  const value = String(raw[name] || "").trim();
  if (value.length > limit || required && !value) throw inputError();
  return value;
}
__name(field, "field");
function validateCapture(raw) {
  if (!isPlainObject4(raw)) throw inputError();
  const requestId = field(raw, "requestId", 120, { required: true });
  const bookId = field(raw, "bookId", 160, { required: true });
  if (!isValidEntityId(requestId) || !isValidEntityId(bookId)) throw inputError();
  const word = field(raw, "word", 400, { required: true }).replace(/\s+/g, " ");
  if (!normalizeVocabularyWordKey(word)) throw inputError();
  const result = {
    requestId,
    bookId,
    word,
    meaning: field(raw, "meaning", 4e3, { required: true }),
    phonetic: field(raw, "phonetic", 200),
    pos: field(raw, "pos", 200)
  };
  if (raw.source != null) {
    if (!isPlainObject4(raw.source)) throw inputError();
    const source = raw.source;
    const sourceUrl = field(source, "sourceUrl", 4096);
    if (sourceUrl && !publicSourceUrl(sourceUrl)) throw inputError("capture_invalid_url");
    if (source.anchor != null && !isPlainObject4(source.anchor)) throw inputError();
    if (source.anchor?.quote != null && (typeof source.anchor.quote !== "string" || source.anchor.quote.length > 2e3)) throw inputError();
    if (["prefix", "suffix"].some((name) => source.anchor?.[name] != null && (typeof source.anchor[name] !== "string" || source.anchor[name].length > 120))) throw inputError();
    for (const name of ["start", "end"]) {
      const position = source.anchor?.[name];
      if (position != null && (typeof position !== "number" || !Number.isSafeInteger(position) || position < -1)) throw inputError();
    }
    if (source.anchor?.start >= 0 && source.anchor?.end >= 0 && source.anchor.end < source.anchor.start) throw inputError();
    result.source = {
      sourceUrl,
      pageTitle: field(source, "pageTitle", 300),
      sentence: field(source, "sentence", 4e3),
      context: field(source, "context", 8e3),
      meaning: result.meaning,
      locale: field(source, "locale", 20),
      anchor: normalizeAnchor(source.anchor || { quote: word })
    };
  }
  return result;
}
__name(validateCapture, "validateCapture");
function captureFingerprint(capture) {
  return JSON.stringify(validateCapture(capture));
}
__name(captureFingerprint, "captureFingerprint");

// ../../../../../Users/linus/CODE/bdc-extension-ai-proof-20261105/cloudflare-worker/src/captures.js
var failure2 = /* @__PURE__ */ __name((code, status = 409) => Object.assign(new Error(code), { code, status }), "failure");
function parseRow(row) {
  if (!row) return null;
  return { ...JSON.parse(row.data_json || "{}"), id: row.entity_id, revision: Number(row.revision), deletedAt: row.deleted_at || "" };
}
__name(parseRow, "parseRow");
async function readEntity(env, userId, type, id) {
  return env.DB.prepare("SELECT * FROM reading_entities WHERE owner_user_id = ? AND entity_type = ? AND entity_id = ?").bind(userId, type, id).first();
}
__name(readEntity, "readEntity");
async function readReceipt(env, userId, requestId, fingerprint) {
  const row = await env.DB.prepare("SELECT fingerprint, result_json FROM vocabulary_captures WHERE owner_user_id = ? AND request_id = ?").bind(userId, requestId).first();
  if (!row) return null;
  if (row.fingerprint !== fingerprint) throw failure2("capture_request_mismatch");
  const receipt = JSON.parse(row.result_json);
  if (!receipt.ok) throw failure2("capture_revision_conflict");
  return receipt;
}
__name(readReceipt, "readReceipt");
async function stableEntryId(bookId, wordKey) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${bookId}\0${wordKey}`));
  return "capture_" + Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 48);
}
__name(stableEntryId, "stableEntryId");
async function listBooks(env, userId) {
  const result = await env.DB.prepare("SELECT * FROM reading_entities WHERE owner_user_id = ? AND entity_type = ? AND deleted_at IS NULL ORDER BY entity_id").bind(userId, "vocabularyBook").all();
  const books = (result.results || []).map((row) => {
    const book = parseRow(row);
    return { id: book.id, name: book.name || "", revision: book.revision };
  });
  return { books, defaultBookId: "" };
}
__name(listBooks, "listBooks");
async function captureWord(env, userId, capture) {
  const fingerprint = captureFingerprint(capture);
  const wordKey = normalizeVocabularyWordKey(capture.word);
  const generatedId = await stableEntryId(capture.bookId, wordKey);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const prior = await readReceipt(env, userId, capture.requestId, fingerprint);
    if (prior) return prior;
    const bookRow = await readEntity(env, userId, "vocabularyBook", capture.bookId);
    if (!bookRow || bookRow.deleted_at) throw failure2("capture_target_missing", 404);
    const rows = await env.DB.prepare("SELECT * FROM reading_entities WHERE owner_user_id = ? AND entity_type = ? AND deleted_at IS NULL ORDER BY entity_id").bind(userId, "vocabularyEntry").all();
    let row = (rows.results || []).find((item) => {
      const entry = parseRow(item);
      return entry.bookId === capture.bookId && normalizeVocabularyWordKey(entry.word) === wordKey;
    });
    if (!row) {
      for (let slot = 0; slot < 10; slot += 1) {
        const candidateId = slot ? `${generatedId}_${slot}` : generatedId;
        const candidate = await readEntity(env, userId, "vocabularyEntry", candidateId);
        const record = parseRow(candidate);
        if (!candidate || record.bookId === capture.bookId && normalizeVocabularyWordKey(record.word) === wordKey) {
          row = candidate || { entity_id: candidateId, revision: 0, allocating: true };
          break;
        }
      }
      if (!row) throw failure2("capture_revision_conflict");
    }
    const allocatingId = row.allocating ? row.entity_id : "";
    if (row.allocating) row = null;
    const existing = row && !row.deleted_at ? parseRow(row) : null;
    const entryId = row?.entity_id || allocatingId || generatedId;
    const revision = Number(row?.revision || 0);
    const timestamp = (/* @__PURE__ */ new Date()).toISOString();
    const sources = existing && Array.isArray(existing.sources) ? [...existing.sources] : [];
    const source = capture.source && (capture.source.sourceUrl || capture.source.sentence || capture.source.context) ? { ...capture.source, addedAt: timestamp } : null;
    const sourceAdded = !!source && !sources.some((item) => vocabularySourceKey(item) === vocabularySourceKey(source));
    if (sourceAdded && sources.length >= MAX_VOCABULARY_SOURCES) throw failure2("capture_sources_full", 422);
    if (sourceAdded) sources.push(source);
    const patch = normalizeReadingPatch("vocabularyEntry", {
      ...existing || {},
      bookId: capture.bookId,
      word: existing?.word || capture.word,
      meaning: existing?.meaning || capture.meaning,
      phonetic: existing?.phonetic || capture.phonetic,
      pos: existing?.pos || capture.pos,
      examples: existing?.examples || [],
      sources,
      source: existing?.source || "extension",
      context: existing?.context || capture.source?.sentence || "",
      addedAt: existing?.addedAt || timestamp,
      createdAt: existing?.createdAt || timestamp,
      updatedAt: existing?.updatedAt || timestamp
    });
    const changed = !existing || sourceAdded || ["meaning", "phonetic", "pos"].some((key) => patch[key] !== (existing[key] || ""));
    if (patchSize(patch) > READING_LIMITS.maxPatchBytes) throw failure2("capture_entry_too_large", 422);
    const nextRevision = changed ? revision + 1 : revision;
    if (changed) patch.updatedAt = timestamp;
    const receipt = { ok: true, requestId: capture.requestId, bookId: capture.bookId, entryId, revision: nextRevision, duplicate: !!existing, sourceAdded };
    const claimJson = JSON.stringify({ claim: crypto.randomUUID() });
    const guardSql = "SELECT 1 FROM vocabulary_captures WHERE owner_user_id = ? AND request_id = ? AND result_json = ?";
    const guardArgs = [userId, capture.requestId, claimJson];
    const condition = "EXISTS (SELECT 1 FROM reading_entities WHERE owner_user_id = ? AND entity_type = ? AND entity_id = ? AND revision = ? AND deleted_at IS NULL)";
    const entryCondition = row ? "EXISTS (SELECT 1 FROM reading_entities WHERE owner_user_id = ? AND entity_type = ? AND entity_id = ? AND revision = ?)" : "NOT EXISTS (SELECT 1 FROM reading_entities WHERE owner_user_id = ? AND entity_type = ? AND entity_id = ?)";
    const entryArgs = [userId, "vocabularyEntry", entryId, ...row ? [revision] : []];
    await ensureState2(env, userId);
    const statements = [env.DB.prepare("INSERT INTO vocabulary_captures (owner_user_id, request_id, fingerprint, result_json, created_at) SELECT ?, ?, ?, ?, ? WHERE " + condition + " AND " + entryCondition + " ON CONFLICT (owner_user_id, request_id) DO NOTHING").bind(userId, capture.requestId, fingerprint, claimJson, timestamp, userId, "vocabularyBook", capture.bookId, Number(bookRow.revision), ...entryArgs)];
    if (env.DB.driver === "postgres") {
      const locks = [env.DB.prepare("SELECT 1 FROM reading_entities WHERE owner_user_id = ? AND entity_type = ? AND entity_id = ? FOR UPDATE").bind(userId, "vocabularyBook", capture.bookId)];
      if (row) locks.push(env.DB.prepare("SELECT 1 FROM reading_entities WHERE owner_user_id = ? AND entity_type = ? AND entity_id = ? FOR UPDATE").bind(userId, "vocabularyEntry", entryId));
      statements.unshift(...locks);
    }
    if (changed) {
      const mutationId = `capture:${capture.requestId}`;
      if (row) {
        statements.push(env.DB.prepare("UPDATE reading_entities SET revision = ?, deleted_at = NULL, data_json = ?, updated_at = ?, last_mutation_id = ? WHERE owner_user_id = ? AND entity_type = ? AND entity_id = ? AND revision = ? AND EXISTS (" + guardSql + ")").bind(nextRevision, JSON.stringify(patch), timestamp, mutationId, userId, "vocabularyEntry", entryId, revision, ...guardArgs));
      } else {
        statements.push(env.DB.prepare("INSERT INTO reading_entities (owner_user_id, entity_type, entity_id, revision, deleted_at, data_json, updated_at, last_mutation_id) SELECT ?, ?, ?, ?, NULL, ?, ?, ? WHERE EXISTS (" + guardSql + ")").bind(userId, "vocabularyEntry", entryId, nextRevision, JSON.stringify(patch), timestamp, mutationId, ...guardArgs));
      }
      statements.push(...readingRevisionStatements(env, {
        userId,
        entityType: "vocabularyEntry",
        entityId: entryId,
        op: "upsert",
        revision: nextRevision,
        timestamp,
        mutationId,
        guardSql,
        guardArgs
      }));
    }
    statements.push(env.DB.prepare("UPDATE vocabulary_captures SET result_json = ? WHERE owner_user_id = ? AND request_id = ? AND result_json = ?").bind(JSON.stringify(receipt), ...guardArgs));
    try {
      await env.DB.batch(statements);
    } catch (error) {
      const completed2 = await readReceipt(env, userId, capture.requestId, fingerprint);
      if (completed2) return completed2;
      throw error;
    }
    const completed = await readReceipt(env, userId, capture.requestId, fingerprint);
    if (completed) return completed;
  }
  throw failure2("capture_revision_conflict");
}
__name(captureWord, "captureWord");
async function handleVocabularyCaptureRoute({ request, env, url, user }) {
  try {
    if (url.pathname === "/vocabulary/books" && request.method === "GET") {
      return json(await listBooks(env, user.user_id), 200, env, request);
    }
    if (url.pathname === "/captures/capabilities" && request.method === "GET") {
      return json({ captureVersion: 1, maxSources: MAX_VOCABULARY_SOURCES }, 200, env, request);
    }
    if (url.pathname === "/captures" && request.method === "POST") {
      const limit = rateLimit(`captures:${user.user_id}`, 120, 60 * 1e3);
      if (!limit.ok) return errorJson("rate_limited", 429, env, request);
      const capture = validateCapture(await readJsonBody(request, CAPTURE_MAX_BYTES));
      return json(await captureWord(env, user.user_id, capture), 200, env, request);
    }
    return errorJson("method_not_allowed", 405, env, request);
  } catch (error) {
    if (error.status || error.code === "bad_json" || error.code === "payload_too_large") {
      return errorJson(error.code, error.status || 400, env, request);
    }
    return errorJson("capture_failed", 500, env, request);
  }
}
__name(handleVocabularyCaptureRoute, "handleVocabularyCaptureRoute");

// ../../../../../Users/linus/CODE/bdc-extension-ai-proof-20261105/cloudflare-worker/src/worker.js
var MIN_AI_PASSCODE_LENGTH = 32;
var SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;
function getBearerToken(request) {
  const h = request.headers.get("Authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : "";
}
__name(getBearerToken, "getBearerToken");
async function authenticate(request, env) {
  const token = getBearerToken(request);
  if (!token) return null;
  const hash = await sha256Hex(token);
  const row = await env.DB.prepare("SELECT user_id, label, role, username, password_hash, is_active FROM users WHERE token_hash = ?").bind(hash).first();
  if (row) {
    if (Number(row.is_active) === 0) return null;
    return {
      user_id: row.user_id,
      label: row.label,
      role: row.role === "admin" ? "admin" : "user",
      username: row.username || "",
      hasPassword: Boolean(row.password_hash),
      tokenLength: token.length,
      viaSession: false
    };
  }
  const session = await env.DB.prepare("SELECT u.user_id, u.label, u.role, u.username, u.password_hash, u.is_active FROM user_sessions s JOIN users u ON u.user_id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND s.auth_version = u.auth_version").bind(hash, (/* @__PURE__ */ new Date()).toISOString()).first();
  if (!session) return null;
  if (Number(session.is_active) === 0) return null;
  return {
    user_id: session.user_id,
    label: session.label,
    role: session.role === "admin" ? "admin" : "user",
    username: session.username || "",
    hasPassword: Boolean(session.password_hash),
    tokenLength: token.length,
    viaSession: true
  };
}
__name(authenticate, "authenticate");
async function runStatements(env, statements) {
  if (typeof env.DB.batch === "function") return env.DB.batch(statements);
  const results = [];
  for (const statement of statements) results.push(await statement.run());
  return results;
}
__name(runStatements, "runStatements");
async function setPasscodeAndRevoke(env, userId, newHash) {
  const statements = [
    env.DB.prepare("UPDATE users SET token_hash = ?, auth_version = auth_version + 1 WHERE user_id = ?").bind(newHash, userId),
    env.DB.prepare("DELETE FROM user_sessions WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM pairing_codes WHERE user_id = ? AND used_at IS NULL").bind(userId)
  ];
  return runStatements(env, statements);
}
__name(setPasscodeAndRevoke, "setPasscodeAndRevoke");
function tooManyRequests(env, request, retryAfter) {
  return json({ error: "rate_limited", code: "rate_limited" }, 429, env, request, {
    "Retry-After": String(retryAfter)
  });
}
__name(tooManyRequests, "tooManyRequests");
async function handleLogin(request, env) {
  let body;
  try {
    body = await readJson(request, 8 * 1024);
  } catch (error) {
    return errorJson(error.code || "bad_json", error.status || 400, env, request);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return errorJson("invalid_credentials", 401, env, request);
  }
  const username = normalizeUsername(body.username);
  const password = String(body.password == null ? "" : body.password);
  if (!username || !password) return errorJson("invalid_credentials", 401, env, request);
  if (password.length > PASSWORD_MAX_LENGTH) return errorJson("invalid_credentials", 401, env, request);
  const client = getClientKey(request, null);
  const globalLimit = rateLimit(`login-all:${client}`, 30, 10 * 60 * 1e3);
  if (!globalLimit.ok) return tooManyRequests(env, request, globalLimit.retryAfter);
  const userLimit = rateLimit(`login-user:${client}:${username}`, 10, 10 * 60 * 1e3);
  if (!userLimit.ok) return tooManyRequests(env, request, userLimit.retryAfter);
  if (!isPasswordPepperConfigured(env)) {
    return errorJson("password_not_configured", 503, env, request);
  }
  const row = await env.DB.prepare("SELECT user_id, label, role, username, password_hash, auth_version, is_active FROM users WHERE username_normalized = ?").bind(username).first();
  const passwordOk = row && row.password_hash ? await verifyPassword(password, row.password_hash, env.PASSWORD_PEPPER) : false;
  if (!row || !passwordOk) return errorJson("invalid_credentials", 401, env, request);
  if (Number(row.is_active) === 0) return errorJson("account_disabled", 403, env, request);
  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const now = /* @__PURE__ */ new Date();
  const nowIso3 = now.toISOString();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  const deviceLabel = String(body.deviceLabel || "").trim().slice(0, 80) || null;
  const authVersion = Number(row.auth_version) || 1;
  await env.DB.prepare("INSERT INTO user_sessions (token_hash, user_id, created_at, expires_at, device_label, auth_version) VALUES (?, ?, ?, ?, ?, ?)").bind(tokenHash, row.user_id, nowIso3, expiresAt, deviceLabel, authVersion).run();
  return json({
    token,
    user_id: row.user_id,
    label: row.label || "",
    role: row.role === "admin" ? "admin" : "user",
    username: row.username || username,
    hasPassword: true,
    expires_at: expiresAt
  }, 200, env, request);
}
__name(handleLogin, "handleLogin");
async function handleChangePassword(request, env, user) {
  if (!isPasswordPepperConfigured(env)) {
    return errorJson("password_not_configured", 503, env, request);
  }
  let body;
  try {
    body = await readJson(request, 8 * 1024);
  } catch (error) {
    return errorJson(error.code || "bad_json", error.status || 400, env, request);
  }
  const currentPassword = String(body && body.currentPassword != null ? body.currentPassword : "");
  const newPassword = String(body && body.newPassword != null ? body.newPassword : "");
  if (!currentPassword || !newPassword) return errorJson("missing_fields", 400, env, request);
  const passwordError = validatePassword(newPassword, user.role);
  if (passwordError) return errorJson(passwordError, 400, env, request);
  const row = await env.DB.prepare("SELECT password_hash, auth_version, role FROM users WHERE user_id = ?").bind(user.user_id).first();
  if (!row || !row.password_hash) return errorJson("password_not_set", 409, env, request);
  if (!await verifyPassword(currentPassword, row.password_hash, env.PASSWORD_PEPPER)) {
    return errorJson("invalid_current_password", 403, env, request);
  }
  const newHash = await hashPassword(newPassword, env.PASSWORD_PEPPER);
  const changedAt = (/* @__PURE__ */ new Date()).toISOString();
  const nextVersion = (Number(row.auth_version) || 1) + 1;
  const currentHash = await sha256Hex(getBearerToken(request));
  await runStatements(env, [
    env.DB.prepare("UPDATE users SET password_hash = ?, password_updated_at = ?, auth_version = ? WHERE user_id = ?").bind(newHash, changedAt, nextVersion, user.user_id),
    env.DB.prepare("DELETE FROM user_sessions WHERE user_id = ? AND token_hash <> ?").bind(user.user_id, currentHash),
    env.DB.prepare("UPDATE user_sessions SET auth_version = ? WHERE token_hash = ? AND user_id = ?").bind(nextVersion, currentHash, user.user_id),
    env.DB.prepare("DELETE FROM pairing_codes WHERE user_id = ? AND used_at IS NULL").bind(user.user_id)
  ]);
  return json({ ok: true, authVersion: nextVersion }, 200, env, request);
}
__name(handleChangePassword, "handleChangePassword");
function requireStrongPasscode(user, request, env) {
  if (user && Number(user.tokenLength) >= MIN_AI_PASSCODE_LENGTH) return null;
  return errorJson("passcode_upgrade_required", 403, env, request, { requiredLength: MIN_AI_PASSCODE_LENGTH });
}
__name(requireStrongPasscode, "requireStrongPasscode");
async function readJson(request, maxBytes) {
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (maxBytes && declared && declared > maxBytes) {
    const err = new Error("payload too large");
    err.code = "payload_too_large";
    err.status = 413;
    throw err;
  }
  let text;
  try {
    text = await request.text();
  } catch (_) {
    const err = new Error("bad body");
    err.code = "bad_json";
    err.status = 400;
    throw err;
  }
  if (maxBytes && text.length > maxBytes) {
    const err = new Error("payload too large");
    err.code = "payload_too_large";
    err.status = 413;
    throw err;
  }
  try {
    return JSON.parse(text || "{}");
  } catch (_) {
    const err = new Error("bad json");
    err.code = "bad_json";
    err.status = 400;
    throw err;
  }
}
__name(readJson, "readJson");
async function handleResetToken(request, env) {
  const limit = rateLimit(`reset:${getClientKey(request, null)}`, 10, 10 * 60 * 1e3);
  if (!limit.ok) {
    return json({ error: "rate_limited", code: "rate_limited" }, 429, env, request, { "Retry-After": String(limit.retryAfter) });
  }
  let body;
  try {
    body = await readJson(request, 8 * 1024);
  } catch (error) {
    return errorJson(error.code || "bad_json", error.status || 400, env, request);
  }
  const uid = String(body && body.user_id || "").trim();
  const recovery = String(body && body.recovery_code || "").trim();
  const newToken = String(body && body.new_token || "").trim();
  if (!uid || !recovery || !newToken) return errorJson("missing_fields", 400, env, request);
  if (newToken.length < MIN_AI_PASSCODE_LENGTH) return errorJson("weak_passcode", 400, env, request);
  const row = await env.DB.prepare("SELECT recovery_hash FROM users WHERE user_id = ?").bind(uid).first();
  if (!row || !row.recovery_hash) return errorJson("no_recovery_set", 403, env, request);
  if (await sha256Hex(recovery) !== row.recovery_hash) return errorJson("invalid_recovery_code", 403, env, request);
  const newHash = await sha256Hex(newToken);
  await setPasscodeAndRevoke(env, uid, newHash);
  return json({ ok: true, user_id: uid }, 200, env, request);
}
__name(handleResetToken, "handleResetToken");
async function handleChangeToken(request, env, user) {
  let body;
  try {
    body = await readJson(request, 8 * 1024);
  } catch (error) {
    return errorJson(error.code || "bad_json", error.status || 400, env, request);
  }
  const newToken = String(body && body.new_token || "").trim();
  if (!newToken) return errorJson("missing_new_token", 400, env, request);
  if (newToken.length < MIN_AI_PASSCODE_LENGTH) return errorJson("weak_passcode", 400, env, request);
  const newHash = await sha256Hex(newToken);
  await setPasscodeAndRevoke(env, user.user_id, newHash);
  return json({ ok: true }, 200, env, request);
}
__name(handleChangeToken, "handleChangeToken");
async function handleSnapshot(request, env, user, path) {
  if (path === "/version" && request.method === "GET") {
    const row = await env.DB.prepare("SELECT version FROM snapshots WHERE user_id = ?").bind(user.user_id).first();
    return json({ version: row ? row.version : 0 }, 200, env, request);
  }
  if (path === "/snapshot" && request.method === "GET") {
    const row = await env.DB.prepare("SELECT version, updated_at, payload FROM snapshots WHERE user_id = ?").bind(user.user_id).first();
    if (!row) return json(null, 200, env, request);
    const knownVersion = Number(new URL(request.url).searchParams.get("version"));
    if (Number.isInteger(knownVersion) && knownVersion > 0 && knownVersion === Number(row.version)) {
      return json({ version: Number(row.version), updated_at: row.updated_at, notModified: true }, 200, env, request);
    }
    let payload = {};
    try {
      payload = JSON.parse(row.payload || "{}");
    } catch (_) {
      payload = {};
    }
    payload = sanitizeSnapshotPayload(payload);
    if (snapshotCarriesArticles(payload) && await isLegacyArticleWriteBlocked(env, user.user_id)) {
      delete payload.articles;
    }
    if (snapshotCarriesReading(payload) && await isLegacyReadingWriteBlocked(env, user.user_id)) {
      delete payload.vocabulary;
      delete payload.assistant;
    }
    return json({ version: row.version, updated_at: row.updated_at, payload }, 200, env, request);
  }
  if (path === "/snapshot" && request.method === "POST") {
    let body;
    try {
      body = await readJson(request, SNAPSHOT_MAX_BYTES);
    } catch (error) {
      return errorJson(error.code || "bad_json", error.status || 400, env, request);
    }
    const expected = Number.isInteger(body && body.expected_version) ? body.expected_version : 0;
    const payload = body ? body.payload : void 0;
    if (payload === void 0 || payload === null) return errorJson("missing_payload", 400, env, request);
    const sanitized = sanitizeSnapshotPayload(payload);
    if (snapshotCarriesArticles(sanitized) && await isLegacyArticleWriteBlocked(env, user.user_id)) {
      return json({
        error: "articles_legacy_write_blocked",
        code: "articles_legacy_write_blocked",
        conflict: true,
        upgradeRequired: true
      }, 409, env, request);
    }
    if (snapshotCarriesReading(sanitized) && await isLegacyReadingWriteBlocked(env, user.user_id)) {
      return json({
        error: "reading_legacy_write_blocked",
        code: "reading_legacy_write_blocked",
        conflict: true,
        upgradeRequired: true
      }, 409, env, request);
    }
    if (sanitized && typeof sanitized === "object") delete sanitized.articles;
    const payloadStr = JSON.stringify(sanitized);
    const updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    const row = await env.DB.prepare("SELECT version FROM snapshots WHERE user_id = ?").bind(user.user_id).first();
    const current = row ? row.version : 0;
    if (expected !== current) return json({ conflict: true, version: current }, 409, env, request);
    const next = current + 1;
    if (row) {
      const result = await env.DB.prepare("UPDATE snapshots SET version = ?, updated_at = ?, payload = ? WHERE user_id = ? AND version = ?").bind(next, updatedAt, payloadStr, user.user_id, current).run();
      if (!result.meta || result.meta.changes === 0) {
        const fresh = await env.DB.prepare("SELECT version FROM snapshots WHERE user_id = ?").bind(user.user_id).first();
        return json({ conflict: true, version: fresh ? fresh.version : current }, 409, env, request);
      }
    } else {
      if (expected !== 0) return json({ conflict: true, version: 0 }, 409, env, request);
      try {
        await env.DB.prepare("INSERT INTO snapshots (user_id, version, updated_at, payload) VALUES (?, ?, ?, ?)").bind(user.user_id, next, updatedAt, payloadStr).run();
      } catch (_) {
        return json({ conflict: true }, 409, env, request);
      }
    }
    return json({ conflict: false, version: next, updated_at: updatedAt }, 200, env, request);
  }
  return errorJson("not_found", 404, env, request);
}
__name(handleSnapshot, "handleSnapshot");
var worker_default = {
  async fetch(request, env) {
    let url;
    try {
      url = new URL(request.url);
    } catch (_) {
      return new Response("bad request", { status: 400 });
    }
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (request.method === "OPTIONS") {
      if (!isOriginAllowed(env, request)) return plainResponse(403, env, request);
      return plainResponse(204, env, request);
    }
    if (!env.DB) return errorJson("d1_binding_missing", 500, env, request);
    const origin = request.headers.get("Origin");
    if (origin && !isOriginAllowed(env, request)) return errorJson("origin_not_allowed", 403, env, request);
    if (path === "/auth-capabilities") {
      if (request.method !== "GET") return errorJson("method_not_allowed", 405, env, request);
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
    if (path === "/login") {
      if (request.method !== "POST") return errorJson("method_not_allowed", 405, env, request);
      return handleLogin(request, env);
    }
    if (path === "/pair") {
      if (request.method !== "POST") return errorJson("method_not_allowed", 405, env, request);
      return handlePairRequest({ request, env });
    }
    if (path === "/reset-token" && request.method === "POST") {
      return handleResetToken(request, env);
    }
    if (path === "/me" && request.method === "GET") {
      const limit = rateLimit(`me:${getClientKey(request, null)}`, 60, 60 * 1e3);
      if (!limit.ok) {
        return json({ error: "rate_limited", code: "rate_limited" }, 429, env, request, { "Retry-After": String(limit.retryAfter) });
      }
    }
    const user = await authenticate(request, env);
    if (!user) return errorJson("unauthorized", 401, env, request);
    try {
      if (path === "/me" && request.method === "GET") {
        return json({
          user_id: user.user_id,
          label: user.label || "",
          role: user.role,
          username: user.username || "",
          hasPassword: Boolean(user.hasPassword)
        }, 200, env, request);
      }
      if (path === "/change-token" && request.method === "POST") {
        return handleChangeToken(request, env, user);
      }
      if (path === "/change-password" && request.method === "POST") {
        return handleChangePassword(request, env, user);
      }
      if (path === "/version" || path === "/snapshot") {
        return handleSnapshot(request, env, user, path);
      }
      if (path === "/articles" || path.startsWith("/articles/")) {
        return handleArticlesRoute({
          request,
          env,
          url,
          user,
          rest: path.slice("/articles".length)
        });
      }
      if (path === "/captures" || path === "/captures/capabilities" || path === "/vocabulary/books") {
        return handleVocabularyCaptureRoute({ request, env, url, user });
      }
      if (path === "/reading" || path.startsWith("/reading/")) {
        return handleReadingRoute({
          request,
          env,
          url,
          user,
          rest: path.slice("/reading".length)
        });
      }
      if (path === "/ai-credentials" || path.startsWith("/ai-credentials/")) {
        const weak = requireStrongPasscode(user, request, env);
        if (weak) return weak;
        return handleCredentialsRoute({
          request,
          env,
          url,
          user,
          rest: path.slice("/ai-credentials".length)
        });
      }
      if (path === "/admin/users" || path.startsWith("/admin/users/")) {
        const weak = requireStrongPasscode(user, request, env);
        if (weak) return weak;
        return handleAdminUsersRoute({ request, env, url, user });
      }
      if (path === "/ai-catalog" || path.startsWith("/ai-catalog/") || path.startsWith("/admin/")) {
        const weak = requireStrongPasscode(user, request, env);
        if (weak) return weak;
        return handleCatalogRoute({ request, env, url, user });
      }
      return errorJson("not_found", 404, env, request);
    } catch (error) {
      console.error("[bdc-sync] route failed:", error && error.code ? error.code : "internal_error");
      if (error && error.code === "credential_unavailable") {
        return errorJson("credential_unavailable", 503, env, request);
      }
      if (error && error.code === "payload_too_large") {
        return errorJson("payload_too_large", 413, env, request);
      }
      return errorJson("internal_error", 500, env, request);
    }
  }
};
export {
  worker_default as default
};
//# sourceMappingURL=worker.js.map
