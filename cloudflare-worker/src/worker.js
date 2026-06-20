// bdc-sync-api — Cloudflare Worker
// 以 Cloudflare D1 (SQLite) 取代 Supabase 同步。
//
// 模型：單列 JSON 快照 + 樂觀鎖（對齊原本的 get_snapshot / save_snapshot RPC）。
// 認證：每位使用者一個通行碼，通行碼以 SHA-256 雜湊存於 users 表（不存明文）。
//
// 路由：
//   OPTIONS *        → CORS 預檢
//   GET  /me         → 驗證通行碼，回 { user_id, label }
//   GET  /version    → 回 { version }（輪詢用，極輕量）
//   GET  /snapshot   → 回 { version, updated_at, payload } 或 null
//   POST /snapshot   → body { expected_version, payload }；版本不符回 409 { conflict:true }

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

function corsHeaders(env) {
  const origin = (env && env.ALLOW_ORIGIN) ? env.ALLOW_ORIGIN : '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function json(data, status, env) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { ...JSON_HEADERS, ...corsHeaders(env) }
  });
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function getBearer(request) {
  const h = request.headers.get('Authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

async function authenticate(request, env) {
  const token = getBearer(request);
  if (!token) return null;
  const hash = await sha256Hex(token);
  const row = await env.DB
    .prepare('SELECT user_id, label FROM users WHERE token_hash = ?')
    .bind(hash)
    .first();
  return row || null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    if (!env.DB) return json({ error: 'D1 binding "DB" missing' }, 500, env);

    // POST /reset-token —— 忘記通行碼，用恢復碼重置（無需登入）
    if (path === '/reset-token' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch (_) { return json({ error: 'bad json' }, 400, env); }
      const uid = String((body && body.user_id) || '').trim();
      const recovery = String((body && body.recovery_code) || '').trim();
      const newToken = String((body && body.new_token) || '').trim();
      if (!uid || !recovery || !newToken) return json({ error: 'missing fields' }, 400, env);
      if (newToken.length < 6) return json({ error: 'new token too short' }, 400, env);
      const row = await env.DB
        .prepare('SELECT recovery_hash FROM users WHERE user_id = ?')
        .bind(uid)
        .first();
      if (!row || !row.recovery_hash) return json({ error: 'no recovery set' }, 403, env);
      const rhash = await sha256Hex(recovery);
      if (rhash !== row.recovery_hash) return json({ error: 'invalid recovery code' }, 403, env);
      const newHash = await sha256Hex(newToken);
      await env.DB
        .prepare('UPDATE users SET token_hash = ? WHERE user_id = ?')
        .bind(newHash, uid)
        .run();
      return json({ ok: true, user_id: uid }, 200, env);
    }

    // 其餘業務路由都需要通行碼
    const user = await authenticate(request, env);
    if (!user) return json({ error: 'unauthorized' }, 401, env);
    const userId = user.user_id;

    // GET /me
    if (path === '/me' && request.method === 'GET') {
      return json({ user_id: userId, label: user.label || '' }, 200, env);
    }

    // POST /change-token —— 已登入下修改自己的通行碼
    if (path === '/change-token' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch (_) { return json({ error: 'bad json' }, 400, env); }
      const newToken = String((body && body.new_token) || '').trim();
      if (!newToken) return json({ error: 'missing new_token' }, 400, env);
      if (newToken.length < 6) return json({ error: 'new token too short' }, 400, env);
      const newHash = await sha256Hex(newToken);
      await env.DB
        .prepare('UPDATE users SET token_hash = ? WHERE user_id = ?')
        .bind(newHash, userId)
        .run();
      return json({ ok: true }, 200, env);
    }

    // GET /version
    if (path === '/version' && request.method === 'GET') {
      const row = await env.DB
        .prepare('SELECT version FROM snapshots WHERE user_id = ?')
        .bind(userId)
        .first();
      return json({ version: row ? row.version : 0 }, 200, env);
    }

    // GET /snapshot
    if (path === '/snapshot' && request.method === 'GET') {
      const row = await env.DB
        .prepare('SELECT version, updated_at, payload FROM snapshots WHERE user_id = ?')
        .bind(userId)
        .first();
      if (!row) return json(null, 200, env);
      let payload = {};
      try { payload = JSON.parse(row.payload || '{}'); } catch (_) { payload = {}; }
      return json({ version: row.version, updated_at: row.updated_at, payload }, 200, env);
    }

    // POST /snapshot
    if (path === '/snapshot' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch (_) { return json({ error: 'bad json' }, 400, env); }

      const expected = Number.isInteger(body && body.expected_version) ? body.expected_version : 0;
      const payload = body ? body.payload : undefined;
      if (payload === undefined || payload === null) {
        return json({ error: 'missing payload' }, 400, env);
      }
      const payloadStr = JSON.stringify(payload);
      const updatedAt = new Date().toISOString();

      const row = await env.DB
        .prepare('SELECT version FROM snapshots WHERE user_id = ?')
        .bind(userId)
        .first();
      const current = row ? row.version : 0;
      if (expected !== current) {
        return json({ conflict: true, version: current }, 409, env);
      }

      const next = current + 1;
      if (row) {
        // 條件更新：再次以 version 比對，避免並發競態
        const r = await env.DB
          .prepare('UPDATE snapshots SET version = ?, updated_at = ?, payload = ? WHERE user_id = ? AND version = ?')
          .bind(next, updatedAt, payloadStr, userId, current)
          .run();
        if (!r.meta || r.meta.changes === 0) {
          const fresh = await env.DB
            .prepare('SELECT version FROM snapshots WHERE user_id = ?')
            .bind(userId)
            .first();
          return json({ conflict: true, version: fresh ? fresh.version : current }, 409, env);
        }
      } else {
        if (expected !== 0) return json({ conflict: true, version: 0 }, 409, env);
        try {
          await env.DB
            .prepare('INSERT INTO snapshots (user_id, version, updated_at, payload) VALUES (?, ?, ?, ?)')
            .bind(userId, next, updatedAt, payloadStr)
            .run();
        } catch (_) {
          // 並發插入：另一請求已建立該列
          return json({ conflict: true }, 409, env);
        }
      }
      return json({ conflict: false, version: next, updated_at: updatedAt }, 200, env);
    }

    return json({ error: 'not found' }, 404, env);
  }
};
