// Shared HTTP helpers for the BDC sync Worker.
//
// Every AI-related response is marked `Cache-Control: no-store` and is never
// cached by a CDN or the browser. CORS is an allow-list, but it is not
// authentication: Bearer verification still happens on every route.

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };
const NO_STORE = { 'Cache-Control': 'no-store, no-cache, must-revalidate, private', 'Pragma': 'no-cache' };
const RATE_BUCKETS = new Map();

export function parseOrigins(env) {
  const raw = String((env && (env.ALLOWED_ORIGINS || env.ALLOW_ORIGIN)) || '').trim();
  if (!raw || raw === '*') return { wildcard: true, origins: [] };
  return {
    wildcard: false,
    origins: raw.split(',').map((item) => item.trim().replace(/\/+$/, '')).filter(Boolean)
  };
}

export function isOriginAllowed(env, request) {
  const cfg = parseOrigins(env);
  if (cfg.wildcard) return true;
  const origin = request && request.headers ? request.headers.get('Origin') || '' : '';
  if (!origin) return false;
  return cfg.origins.includes(origin.replace(/\/+$/, ''));
}

export function corsHeaders(env, request) {
  const cfg = parseOrigins(env);
  const origin = request && request.headers ? request.headers.get('Origin') || '' : '';
  const allowOrigin = cfg.wildcard ? '*' : (cfg.origins.includes(origin.replace(/\/+$/, '')) ? origin : '');
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '600',
    'Vary': 'Origin',
    ...NO_STORE
  };
  if (allowOrigin) headers['Access-Control-Allow-Origin'] = allowOrigin;
  return headers;
}

export function json(data, status, env, request, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { ...JSON_HEADERS, ...corsHeaders(env, request), ...(extraHeaders || {}) }
  });
}

export function errorJson(code, status, env, request, extra) {
  return json({ error: code, code, ...(extra || {}) }, status || 400, env, request);
}

export function plainResponse(status, env, request) {
  return new Response(null, { status, headers: corsHeaders(env, request) });
}

/**
 * Read a request body with a hard size limit. `Content-Length` is checked first
 * when present; the actual text is checked again afterwards.
 */
export async function readJsonBody(request, maxBytes) {
  const limit = Number(maxBytes) || 0;
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (limit && declared && declared > limit) {
    const err = new Error('payload too large');
    err.code = 'payload_too_large';
    err.status = 413;
    throw err;
  }
  let text;
  try {
    text = await request.text();
  } catch (_) {
    const err = new Error('bad body');
    err.code = 'bad_json';
    err.status = 400;
    throw err;
  }
  if (limit && text.length > limit) {
    const err = new Error('payload too large');
    err.code = 'payload_too_large';
    err.status = 413;
    throw err;
  }
  if (!text.trim()) {
    const err = new Error('empty body');
    err.code = 'bad_json';
    err.status = 400;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch (_) {
    const err = new Error('bad json');
    err.code = 'bad_json';
    err.status = 400;
    throw err;
  }
}

/**
 * Like `readJsonBody`, but an empty body is treated as `{}`. Use this for
 * endpoints whose request body is optional (for example, an admin generating a
 * login code with the default lifetime).
 */
export async function readOptionalJsonBody(request, maxBytes) {
  const limit = Number(maxBytes) || 0;
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (limit && declared && declared > limit) {
    const err = new Error('payload too large');
    err.code = 'payload_too_large';
    err.status = 413;
    throw err;
  }
  let text;
  try {
    text = await request.text();
  } catch (_) {
    const err = new Error('bad body');
    err.code = 'bad_json';
    err.status = 400;
    throw err;
  }
  if (limit && text.length > limit) {
    const err = new Error('payload too large');
    err.code = 'payload_too_large';
    err.status = 413;
    throw err;
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (_) {
    const err = new Error('bad json');
    err.code = 'bad_json';
    err.status = 400;
    throw err;
  }
}

/**
 * Small in-isolate sliding-window limiter. It is a best-effort abuse brake, not
 * a global quota: each Worker isolate keeps its own counters.
 */
export function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const bucketKey = String(key || '');
  let bucket = RATE_BUCKETS.get(bucketKey);
  if (!bucket || now - bucket.startedAt >= windowMs) {
    bucket = { startedAt: now, count: 0 };
    RATE_BUCKETS.set(bucketKey, bucket);
  }
  bucket.count += 1;
  if (RATE_BUCKETS.size > 5000) {
    for (const [k, b] of RATE_BUCKETS) {
      if (now - b.startedAt >= windowMs) RATE_BUCKETS.delete(k);
    }
  }
  if (bucket.count > limit) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((bucket.startedAt + windowMs - now) / 1000)) };
  }
  return { ok: true, retryAfter: 0 };
}

export function getClientKey(request, user) {
  if (user && user.user_id) return `u:${user.user_id}`;
  const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
  return `ip:${ip}`;
}
