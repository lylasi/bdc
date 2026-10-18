#!/usr/bin/env node
// BDC self-host sync server.
//
// Implements the learning-data subset of the Cloudflare Worker API:
//   GET  /health
//   GET  /me
//   GET  /version
//   GET  /snapshot
//   POST /snapshot
//   POST /change-token
//   POST /reset-token
//
// AI provider credentials/catalog endpoints are not implemented. Point the
// frontend at SYNC.endpoint = http://<host>:<port> for learning-data sync; use
// the Cloudflare Worker if cloud AI settings sync is required.

import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeSnapshotPayload } from './snapshot-sanitize.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIN_TOKEN_LENGTH = 32;
const SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;
const AUTH_BODY_MAX_BYTES = 8 * 1024;

const driver = String(process.env.DB_DRIVER || 'sqlite').toLowerCase();
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '0.0.0.0';
const origins = loadOrigins();

function loadOrigins() {
  const raw = String(process.env.ALLOWED_ORIGINS || '').trim();
  if (!raw || raw === '*') return { wildcard: true, list: [] };
  return {
    wildcard: false,
    list: raw.split(',')
      .map((item) => item.trim().replace(/\/+$/, ''))
      .filter(Boolean)
  };
}

function redactTarget(value) {
  try {
    const url = new URL(value);
    if (url.password) url.password = '***';
    return url.toString();
  } catch (_) {
    return value;
  }
}

function originAllowed(origin) {
  if (!origin) return true; // CLI / same-origin requests have no Origin header.
  if (origins.wildcard) return true;
  return origins.list.includes(origin.replace(/\/+$/, ''));
}

function corsHeaders(req) {
  const origin = req.headers.origin || '';
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    Pragma: 'no-cache'
  };
  if (origins.wildcard) headers['Access-Control-Allow-Origin'] = '*';
  else if (origin && origins.list.includes(origin.replace(/\/+$/, ''))) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

function sendJson(req, res, data, status = 200, extra = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...corsHeaders(req),
    ...extra
  });
  res.end(body);
}

function fail(req, res, code, status, extra = {}) {
  sendJson(req, res, { error: code, code, ...extra }, status);
}

class HttpError extends Error {
  constructor(code, status, extra = {}) {
    super(code);
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

async function readJson(req, maxBytes) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared && declared > maxBytes) throw new HttpError('payload_too_large', 413);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError('payload_too_large', 413);
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) throw new HttpError('bad_json', 400);
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new HttpError('bad_json', 400);
  }
}

function sha256Hex(text) {
  return createHash('sha256').update(String(text)).digest('hex');
}

function safeEqualHex(a, b) {
  const left = Buffer.from(String(a || ''), 'hex');
  const right = Buffer.from(String(b || ''), 'hex');
  return left.length > 0 && left.length === right.length && timingSafeEqual(left, right);
}

function getBearerToken(req) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function isUniqueViolation(error) {
  if (!error) return false;
  if (error.code === '23505') return true; // PostgreSQL
  return /UNIQUE constraint failed|duplicate key value/i.test(String(error.message || ''));
}

// Best-effort in-process limiter. Use a reverse proxy if you need global limits.
const buckets = new Map();
function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || now - bucket.startedAt >= windowMs) {
    bucket = { startedAt: now, count: 0 };
    buckets.set(key, bucket);
  }
  bucket.count += 1;
  if (buckets.size > 10_000) {
    for (const [k, value] of buckets) {
      if (now - value.startedAt >= windowMs) buckets.delete(k);
    }
  }
  return {
    ok: bucket.count <= limit,
    retryAfter: Math.max(1, Math.ceil((bucket.startedAt + windowMs - now) / 1000))
  };
}

function clientKey(req) {
  return req.socket.remoteAddress || 'unknown';
}

async function createDatabase() {
  if (driver === 'sqlite') {
    const { DatabaseSync } = await import('node:sqlite');
    const file = process.env.SQLITE_PATH || join(HERE, 'data', 'bdc-sync.sqlite');
    mkdirSync(dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec(await readFile(join(HERE, 'schema.sql'), 'utf8'));
    return {
      driver: 'sqlite',
      target: file,
      all: async (sql, params = []) => db.prepare(sql).all(...params),
      get: async (sql, params = []) => db.prepare(sql).get(...params),
      run: async (sql, params = []) => {
        const result = db.prepare(sql).run(...params);
        return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
      },
      close: async () => db.close()
    };
  }

  if (driver === 'postgres') {
    if (!process.env.DATABASE_URL) {
      throw new Error('PostgreSQL 模式需要 DATABASE_URL');
    }
    let pg;
    try {
      pg = await import('pg');
    } catch (_) {
      throw new Error('PostgreSQL 模式需要 pg 套件：cd selfhost && npm install');
    }
    const Pool = pg.Pool || (pg.default && pg.default.Pool);
    if (!Pool) throw new Error('無法載入 pg.Pool，請重新安裝 pg');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.PG_POOL_MAX || 10)
    });
    await pool.query(await readFile(join(HERE, 'schema.sql'), 'utf8'));
    const convert = (sql) => {
      let index = 0;
      return sql.replace(/\?/g, () => `$${(index += 1)}`);
    };
    return {
      driver: 'postgres',
      target: redactTarget(process.env.DATABASE_URL || '(DATABASE_URL 未設定)'),
      all: async (sql, params = []) => (await pool.query(convert(sql), params)).rows,
      get: async (sql, params = []) => (await pool.query(convert(sql), params)).rows[0],
      run: async (sql, params = []) => {
        const result = await pool.query(convert(sql), params);
        return { changes: result.rowCount };
      },
      close: async () => pool.end()
    };
  }

  throw new Error('DB_DRIVER 只支援 sqlite 或 postgres');
}

let db;

async function authenticate(req) {
  const token = getBearerToken(req);
  if (!token) return null;
  const row = await db.get(
    'SELECT user_id, label, role FROM users WHERE token_hash = ?',
    [sha256Hex(token)]
  );
  if (!row) return null;
  return {
    user_id: row.user_id,
    label: row.label || '',
    role: row.role === 'admin' ? 'admin' : 'user',
    tokenLength: token.length
  };
}

async function handleResetToken(req, res) {
  const limit = rateLimit(`reset:${clientKey(req)}`, 10, 10 * 60 * 1000);
  if (!limit.ok) {
    return fail(req, res, 'rate_limited', 429, { 'Retry-After': String(limit.retryAfter) });
  }
  const body = await readJson(req, AUTH_BODY_MAX_BYTES);
  const userId = String((body && body.user_id) || '').trim();
  const recovery = String((body && body.recovery_code) || '').trim();
  const newToken = String((body && body.new_token) || '').trim();
  if (!userId || !recovery || !newToken) return fail(req, res, 'missing_fields', 400);
  if (newToken.length < MIN_TOKEN_LENGTH) return fail(req, res, 'weak_passcode', 400);

  const row = await db.get('SELECT recovery_hash FROM users WHERE user_id = ?', [userId]);
  if (!row || !row.recovery_hash) return fail(req, res, 'no_recovery_set', 403);
  if (!safeEqualHex(sha256Hex(recovery), row.recovery_hash)) {
    return fail(req, res, 'invalid_recovery_code', 403);
  }

  try {
    await db.run('UPDATE users SET token_hash = ? WHERE user_id = ?', [sha256Hex(newToken), userId]);
  } catch (error) {
    if (isUniqueViolation(error)) return fail(req, res, 'token_conflict', 409);
    throw error;
  }
  return sendJson(req, res, { ok: true, user_id: userId });
}

async function handleChangeToken(req, res, user) {
  const body = await readJson(req, AUTH_BODY_MAX_BYTES);
  const newToken = String((body && body.new_token) || '').trim();
  if (!newToken) return fail(req, res, 'missing_new_token', 400);
  if (newToken.length < MIN_TOKEN_LENGTH) return fail(req, res, 'weak_passcode', 400);
  try {
    await db.run('UPDATE users SET token_hash = ? WHERE user_id = ?', [sha256Hex(newToken), user.user_id]);
  } catch (error) {
    if (isUniqueViolation(error)) return fail(req, res, 'token_conflict', 409);
    throw error;
  }
  return sendJson(req, res, { ok: true });
}

async function handleSnapshot(req, res, user, path) {
  if (path === '/version' && req.method === 'GET') {
    const row = await db.get('SELECT version FROM snapshots WHERE user_id = ?', [user.user_id]);
    return sendJson(req, res, { version: row ? Number(row.version) : 0 });
  }

  if (path === '/snapshot' && req.method === 'GET') {
    const row = await db.get(
      'SELECT version, updated_at, payload FROM snapshots WHERE user_id = ?',
      [user.user_id]
    );
    if (!row) return sendJson(req, res, null);
    let payload = {};
    try {
      payload = JSON.parse(row.payload || '{}');
    } catch (_) {
      payload = {};
    }
    return sendJson(req, res, {
      version: Number(row.version),
      updated_at: row.updated_at,
      payload: sanitizeSnapshotPayload(payload)
    });
  }

  if (path === '/snapshot' && req.method === 'POST') {
    const body = await readJson(req, SNAPSHOT_MAX_BYTES);
    const expected = body && Number.isInteger(body.expected_version) ? body.expected_version : 0;
    const payload = body ? body.payload : undefined;
    if (payload === undefined || payload === null) return fail(req, res, 'missing_payload', 400);

    const payloadText = JSON.stringify(sanitizeSnapshotPayload(payload));
    const updatedAt = new Date().toISOString();
    const row = await db.get('SELECT version FROM snapshots WHERE user_id = ?', [user.user_id]);
    const current = row ? Number(row.version) : 0;
    if (expected !== current) {
      return sendJson(req, res, { conflict: true, version: current }, 409);
    }
    const next = current + 1;

    if (row) {
      const result = await db.run(
        'UPDATE snapshots SET version = ?, updated_at = ?, payload = ? WHERE user_id = ? AND version = ?',
        [next, updatedAt, payloadText, user.user_id, current]
      );
      if (result.changes === 0) {
        const fresh = await db.get('SELECT version FROM snapshots WHERE user_id = ?', [user.user_id]);
        return sendJson(req, res, { conflict: true, version: fresh ? Number(fresh.version) : current }, 409);
      }
    } else {
      if (expected !== 0) return sendJson(req, res, { conflict: true, version: 0 }, 409);
      try {
        await db.run(
          'INSERT INTO snapshots (user_id, version, updated_at, payload) VALUES (?, ?, ?, ?)',
          [user.user_id, next, updatedAt, payloadText]
        );
      } catch (error) {
        if (isUniqueViolation(error)) return sendJson(req, res, { conflict: true }, 409);
        throw error;
      }
    }
    return sendJson(req, res, { conflict: false, version: next, updated_at: updatedAt });
  }

  return fail(req, res, 'not_found', 404);
}

async function handle(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const origin = req.headers.origin || '';

  if (req.method === 'OPTIONS') {
    if (!originAllowed(origin)) return fail(req, res, 'origin_not_allowed', 403);
    res.writeHead(204, corsHeaders(req));
    return res.end();
  }

  if (!originAllowed(origin)) return fail(req, res, 'origin_not_allowed', 403);

  if (path === '/health' && req.method === 'GET') {
    return sendJson(req, res, {
      ok: true,
      driver: db.driver,
      time: new Date().toISOString()
    });
  }

  if (path === '/reset-token' && req.method === 'POST') {
    return handleResetToken(req, res);
  }

  if (path === '/me' && req.method === 'GET') {
    const limit = rateLimit(`me:${clientKey(req)}`, 60, 60 * 1000);
    if (!limit.ok) {
      return fail(req, res, 'rate_limited', 429, { 'Retry-After': String(limit.retryAfter) });
    }
  }

  const user = await authenticate(req);
  if (!user) return fail(req, res, 'unauthorized', 401);

  if (path === '/me' && req.method === 'GET') {
    return sendJson(req, res, {
      user_id: user.user_id,
      label: user.label,
      role: user.role
    });
  }

  if (path === '/change-token' && req.method === 'POST') {
    return handleChangeToken(req, res, user);
  }

  if (path === '/version' || path === '/snapshot') {
    return handleSnapshot(req, res, user, path);
  }

  if (
    path === '/ai-credentials' ||
    path.startsWith('/ai-credentials/') ||
    path === '/ai-catalog' ||
    path.startsWith('/ai-catalog/') ||
    path.startsWith('/admin/')
  ) {
    return fail(req, res, 'not_supported', 501, {
      message: 'Self-host server supports learning snapshots only.'
    });
  }

  return fail(req, res, 'not_found', 404);
}

async function main() {
  try {
    db = await createDatabase();
  } catch (error) {
    console.error(`[bdc-selfhost] ${error.message || error}`);
    process.exit(1);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (error instanceof HttpError) {
        if (!res.headersSent) fail(req, res, error.code, error.status, error.extra);
        else res.end();
        return;
      }
      console.error('[bdc-selfhost] request failed:', error && error.code ? error.code : 'internal_error');
      if (!res.headersSent) fail(req, res, 'internal_error', 500);
      else res.end();
    });
  });

  server.listen(port, host, () => {
    const address = server.address();
    const actualPort = address && typeof address === 'object' ? address.port : port;
    console.log(`[bdc-selfhost] ${db.driver} listening on http://${host}:${actualPort}`);
    console.log(`[bdc-selfhost] data: ${db.target}`);
    console.log(`[bdc-selfhost] allowed origins: ${origins.wildcard ? '*' : (origins.list.join(', ') || '(same-origin only)')}`);
    if (origins.wildcard) {
      console.warn('[bdc-selfhost] 警告：ALLOWED_ORIGINS 未限制，任何網站都可呼叫此 API。正式環境請設定明確來源。');
    }
  });

  const shutdown = () => {
    server.close(async () => {
      try { await db.close(); } catch (_) {}
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

await main();
