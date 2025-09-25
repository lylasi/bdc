// Lightweight localStorage cache with SHA-256 keys and TTL
// Note: Runs in browser; uses Web Crypto API.

const PREFIX = 'bdc:cache:v1:';

// --- IndexedDB (fallback to localStorage) ---
let _dbPromise = null;
function openDB() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open('bdc-cache', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('kv')) {
          db.createObjectStore('kv', { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch (e) {
      resolve(null);
    }
  });
  return _dbPromise;
}

async function idbGet(key) {
  const db = await openDB();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction('kv', 'readonly');
      const store = tx.objectStore('kv');
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    } catch (e) { resolve(null); }
  });
}

async function idbSet(key, rec) {
  const db = await openDB();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction('kv', 'readwrite');
      const store = tx.objectStore('kv');
      const req = store.put({ key, ...rec });
      req.onsuccess = () => resolve(true);
      req.onerror = () => resolve(false);
    } catch (e) { resolve(false); }
  });
}

function now() { return Date.now(); }

const CRYPTO = (typeof globalThis !== 'undefined' && globalThis.crypto) ? globalThis.crypto : null;
const SUBTLE_DIGEST = CRYPTO && CRYPTO.subtle && typeof CRYPTO.subtle.digest === 'function' ? CRYPTO.subtle.digest.bind(CRYPTO.subtle) : null;
let warnedFallbackDigest = false;

function fallbackHash(str) {
  // 非安全雜湊，用於 HTTP 等不支援 crypto.subtle 的情境，只做快取 key。
  let hash = 0x811c9dc5; // FNV-1a 32-bit 起始值
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

async function sha256Hex(str) {
  if (SUBTLE_DIGEST && typeof TextEncoder !== 'undefined') {
    const enc = new TextEncoder();
    const buf = await SUBTLE_DIGEST('SHA-256', enc.encode(str));
    const bytes = new Uint8Array(buf);
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  if (!warnedFallbackDigest) {
    warnedFallbackDigest = true;
    console.warn('cache: crypto.subtle 不可用，使用弱雜湊作為快取鍵。');
  }
  return fallbackHash(str);
}

export async function makeKey(namespace, payload) {
  const raw = JSON.stringify({ namespace, payload });
  const h = await sha256Hex(raw);
  return `${PREFIX}${namespace}:${h}`;
}

export async function setItem(key, value, ttlMs = 0) {
  const rec = { v: 1, expiresAt: ttlMs > 0 ? now() + ttlMs : 0, value };
  let ok = false;
  try { ok = await idbSet(key, rec); } catch(_) {}
  if (ok) return true;
  try { localStorage.setItem(key, JSON.stringify(rec)); return true; } catch (e) { console.warn('cache.setItem failed', e); return false; }
}

export async function getItem(key) {
  try {
    let rec = null;
    try { rec = await idbGet(key); } catch(_) {}
    if (!rec) {
      const raw = localStorage.getItem(key);
      rec = raw ? JSON.parse(raw) : null;
    }
    if (!rec) return null;
    if (rec && rec.expiresAt && rec.expiresAt > 0 && rec.expiresAt < now()) {
      try { localStorage.removeItem(key); } catch(_) {}
      return null;
    }
    return rec ? rec.value : null;
  } catch (e) {
    console.warn('cache.getItem failed', e);
    return null;
  }
}

export async function getCached(namespace, payload) {
  const key = await makeKey(namespace, payload);
  return await getItem(key);
}

export async function setCached(namespace, payload, value, ttlMs) {
  const key = await makeKey(namespace, payload);
  return await setItem(key, value, ttlMs);
}

// Convenience helpers for this app
export async function getParagraphAnalysisCached(paragraph, level, model) {
  return getCached('paragraphAnalysis', { paragraph, level, model, schema: 'v1' });
}

export async function setParagraphAnalysisCached(paragraph, level, model, value, ttlMs) {
  return setCached('paragraphAnalysis', { paragraph, level, model, schema: 'v1' }, value, ttlMs);
}

export async function getWordAnalysisCached(word, sentence, model) {
  return getCached('wordAnalysis', { word, sentence, model, schema: 'v1' });
}

export async function setWordAnalysisCached(word, sentence, model, value, ttlMs) {
  return setCached('wordAnalysis', { word, sentence, model, schema: 'v1' }, value, ttlMs);
}

// Sentence-level analysis
export async function getSentenceAnalysisCached(sentence, contextHash, model) {
  return getCached('sentenceAnalysis', { sentence, contextHash, model, schema: 'v1' });
}

export async function setSentenceAnalysisCached(sentence, contextHash, model, value, ttlMs) {
  return setCached('sentenceAnalysis', { sentence, contextHash, model, schema: 'v1' }, value, ttlMs);
}

// Selection/phrase analysis within a sentence
export async function getSelectionAnalysisCached(selection, sentence, contextHash, model) {
  return getCached('selectionAnalysis', { selection, sentence, contextHash, model, schema: 'v1' });
}

export async function setSelectionAnalysisCached(selection, sentence, contextHash, model, value, ttlMs) {
  return setCached('selectionAnalysis', { selection, sentence, contextHash, model, schema: 'v1' }, value, ttlMs);
}
