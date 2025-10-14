// Cloudflare Worker: Simple HTML fetch proxy for Article Import
// Purpose: Bypass target site CORS for fetching HTML only, then return it with permissive CORS headers.
// Security: Blocks private IP ranges, optional host allowlist, limits content size, and strips non-HTML responses.
// Usage: Deploy on Cloudflare Workers and configure your app's ai-config ARTICLE_IMPORT.PROXY_URL to this worker URL.

const MAX_BYTES = 2_000_000; // ~2MB safety cap for HTML

// Private IP / hostname patterns to avoid SSRF
const PRIVATE_HOST_PATTERNS = [
  /(^|\.)localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./
];

/**
 * Module Worker entry (recommended by Cloudflare).
 */
export default {
  async fetch(request, env, ctx) {
    return handle(request, env, ctx);
  }
};

async function handle(request, env) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') {
    return withCORS(new Response(null, { status: 204 }));
  }
  if (request.method !== 'GET') {
    return withCORS(new Response('Method Not Allowed', { status: 405 }));
  }

  // Expect either /fetch?url=... or root with ?url=...
  const target = url.searchParams.get('url');
  if (!target) {
    return withCORS(new Response('missing url', { status: 400 }));
  }

  let t;
  try {
    t = new URL(target);
  } catch (_) {
    return withCORS(new Response('bad url', { status: 400 }));
  }
  if (!/^https?:$/i.test(t.protocol)) {
    return withCORS(new Response('bad protocol', { status: 400 }));
  }

  if (isPrivateHost(t.hostname)) {
    return withCORS(new Response('forbidden', { status: 403 }));
  }

  // Optional domain allowlist via Worker env var ALLOW_HOSTS (comma-separated)
  // Example: news.example.com,*.trusted.com
  const allow = (env && env.ALLOW_HOSTS ? String(env.ALLOW_HOSTS) : '').trim();
  if (allow) {
    const ok = hostAllowed(t.hostname, allow.split(',').map(s => s.trim()).filter(Boolean));
    if (!ok) return withCORS(new Response('host not allowed', { status: 403 }));
  }

  // Fetch
  const resp = await fetch(t.toString(), {
    headers: {
      // Provide a browser-like UA to avoid some bot blocks
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
    },
    redirect: 'follow'
  });

  // Validate response type
  const ct = resp.headers.get('content-type') || '';
  if (!/text\/(html|xml)|application\/xhtml\+xml/i.test(ct)) {
    return withCORS(new Response('unsupported content-type', { status: 415 }));
  }

  // Size guard (based on Content-Length when available)
  const len = parseInt(resp.headers.get('content-length') || '0', 10);
  if (Number.isFinite(len) && len > MAX_BYTES) {
    return withCORS(new Response('payload too large', { status: 413 }));
  }

  // Stream and truncate if unknown length exceeds cap
  const reader = resp.body.getReader();
  let received = 0;
  const chunks = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    received += (value ? value.length : 0);
    if (received > MAX_BYTES) {
      return withCORS(new Response('payload too large', { status: 413 }));
    }
    chunks.push(value);
  }
  const html = new TextDecoder('utf-8').decode(concatChunks(chunks));

  return withCORS(new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // Pass through a hint that this is HTML-only; clients can choose to cache.
      'Cache-Control': 'no-store'
    }
  }));
}

function withCORS(resp) {
  const h = new Headers(resp.headers);
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Methods', 'GET,OPTIONS');
  h.set('Access-Control-Allow-Headers', '*');
  return new Response(resp.body, { status: resp.status, headers: h });
}

function isPrivateHost(hostname) {
  if (!hostname) return true;
  if (PRIVATE_HOST_PATTERNS.some(re => re.test(hostname))) return true;
  return false;
}

function hostAllowed(hostname, patterns) {
  for (const p of patterns) {
    if (!p) continue;
    if (p.startsWith('*.')) {
      const root = p.slice(2).toLowerCase();
      if (hostname.toLowerCase() === root) return true;
      if (hostname.toLowerCase().endsWith('.' + root)) return true;
    } else if (p.includes('*')) {
      // naive wildcard: convert * to .*
      const re = new RegExp('^' + p.replace(/[.+?^${}()|\[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
      if (re.test(hostname)) return true;
    } else {
      if (hostname.toLowerCase() === p.toLowerCase()) return true;
    }
  }
  return false;
}

function concatChunks(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

