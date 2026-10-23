// Lightweight localStorage cache with SHA-256 keys and TTL
// Note: Runs in browser; uses Web Crypto API.

const PREFIX = 'bdc:cache:v1:';
const LAST_PRUNE_KEY = 'bdc:cache:lastPrune';
export const CACHE_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

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

async function idbDelete(key) {
  const db = await openDB();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction('kv', 'readwrite');
      const store = tx.objectStore('kv');
      const req = store.delete(key);
      req.onsuccess = () => resolve(true);
      req.onerror = () => resolve(false);
    } catch (e) { resolve(false); }
  });
}

async function idbDeleteMany(keys) {
  const list = Array.isArray(keys) ? keys.filter(Boolean) : [];
  if (!list.length) return true;
  const db = await openDB();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction('kv', 'readwrite');
      const store = tx.objectStore('kv');
      list.forEach((key) => store.delete(key));
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
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
  const nowMs = now();
  const rec = { v: 1, storedAt: nowMs, expiresAt: ttlMs > 0 ? nowMs + ttlMs : 0, value };
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
      // 過期項目必須同時離開 IDB 與 localStorage，否則長期使用只會無限累積。
      try { await idbDelete(key); } catch(_) {}
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

/** 掃描 IDB `kv` 中符合快取前綴的記錄；沒有 IDB 時回傳 null。 */
async function scanIdbCacheRows() {
    const db = await openDB();
    if (!db) return null;
    return new Promise((resolve) => {
        const rows = [];
        try {
            const tx = db.transaction('kv', 'readonly');
            const store = tx.objectStore('kv');
            if (typeof store.openCursor !== 'function') {
                // 測試替身或極舊環境沒有游標：退回 getAll（仍是同一組 kv 記錄）。
                const req = store.getAll();
                req.onsuccess = () => {
                    (req.result || []).forEach((rec) => {
                        if (rec && String(rec.key || '').startsWith(PREFIX)) rows.push(rec);
                    });
                    resolve(rows);
                };
                req.onerror = () => resolve(rows);
                return;
            }
            const req = store.openCursor();
            req.onsuccess = () => {
                const cursor = req.result;
                if (!cursor) return;
                const rec = cursor.value;
                if (rec && String(cursor.key || '').startsWith(PREFIX)) rows.push({ ...rec, key: String(cursor.key) });
                cursor.continue();
            };
            req.onerror = () => resolve(rows);
            tx.oncomplete = () => resolve(rows);
            tx.onerror = () => resolve(rows);
            tx.onabort = () => resolve(rows);
        } catch (_) {
            resolve(rows);
        }
    });
}

function localCacheRows() {
    const rows = [];
    try {
        for (const key of Object.keys(localStorage)) {
            if (!key.startsWith(PREFIX)) continue;
            let rec = null;
            try { rec = JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) { rec = null; }
            rows.push({ key, ...(rec && typeof rec === 'object' ? rec : {}) });
        }
    } catch (_) { /* noop */ }
    return rows;
}

function recordSizeBytes(rec) {
    try { return JSON.stringify(rec?.value === undefined ? rec : rec.value).length * 2; } catch (_) { return 0; }
}

/**
 * 清理可重建快取（P3-T2）。
 * 只處理 `bdc:cache:v1:` 前綴，絕不觸碰 bdc-articles／bdc-reading 或永久資料。
 *
 * @param {{ maxEntries?: number, maxBytes?: number, maxAgeMs?: number }} options
 * @returns {Promise<{ ok: boolean, removed: number, kept: number, fallback?: boolean }>}
 */
export async function pruneCache(options = {}) {
    const maxEntries = Number.isFinite(options.maxEntries) ? Math.max(0, options.maxEntries) : 1500;
    const maxBytes = Number.isFinite(options.maxBytes) ? Math.max(0, options.maxBytes) : 30 * 1024 * 1024;
    const maxAgeMs = Number.isFinite(options.maxAgeMs) ? Math.max(0, options.maxAgeMs) : 60 * 24 * 60 * 60 * 1000;
    const nowMs = now();

    let idbRows = null;
    try { idbRows = await scanIdbCacheRows(); } catch (_) { idbRows = null; }
    const localRows = localCacheRows();

    const entries = new Map();
    const addRow = (row, source) => {
        const key = String(row?.key || '');
        if (!key.startsWith(PREFIX)) return;
        let entry = entries.get(key);
        if (!entry) {
            entry = { key, expiresAt: 0, storedAt: 0, sizeBytes: 0, inIdb: false, inLocal: false };
            entries.set(key, entry);
        }
        if (source === 'idb') {
            // IDB 是主要來源：同一 key 若 localStorage 還留著舊副本（例如舊 TTL
            // 已過期、但 IDB 後來寫成無期限），不可用舊副本的 expiresAt 把新副本
            // 一起判成過期。IDB 有記錄時完全以 IDB 為準。
            entry.expiresAt = Number(row.expiresAt) || 0;
            entry.storedAt = Number(row.storedAt) || 0;
            entry.sizeBytes = recordSizeBytes(row);
            entry.inIdb = true;
            return;
        }
        entry.inLocal = true;
        if (entry.inIdb) return;
        entry.expiresAt = Math.max(entry.expiresAt, Number(row.expiresAt) || 0);
        entry.storedAt = Math.max(entry.storedAt, Number(row.storedAt) || 0);
        entry.sizeBytes = Math.max(entry.sizeBytes, recordSizeBytes(row));
    };
    (idbRows || []).forEach((row) => addRow(row, 'idb'));
    localRows.forEach((row) => addRow(row, 'local'));

    const removedKeys = [];
    const kept = [];
    for (const entry of entries.values()) {
        const expired = entry.expiresAt > 0 && entry.expiresAt < nowMs;
        const tooOld = maxAgeMs > 0 && entry.storedAt > 0 && nowMs - entry.storedAt > maxAgeMs;
        if (expired || tooOld) removedKeys.push(entry.key);
        else kept.push(entry);
    }

    // 最舊的先移除；沒有 storedAt 的舊資料視為最新，避免一次清空無法判斷年齡的資料。
    const ageOf = (entry) => entry.storedAt || entry.expiresAt || Number.MAX_SAFE_INTEGER;
    kept.sort((a, b) => ageOf(a) - ageOf(b));
    let totalBytes = kept.reduce((sum, entry) => sum + entry.sizeBytes, 0);
    while (kept.length > maxEntries) {
        const oldest = kept.shift();
        totalBytes -= oldest.sizeBytes;
        removedKeys.push(oldest.key);
    }
    while (totalBytes > maxBytes && kept.length > 1) {
        const oldest = kept.shift();
        totalBytes -= oldest.sizeBytes;
        removedKeys.push(oldest.key);
    }

    let deletionOk = true;
    let pendingRemoval = 0;
    if (removedKeys.length) {
        if (idbRows !== null) {
            try {
                deletionOk = await idbDeleteMany(removedKeys);
            } catch (_) {
                deletionOk = false;
            }
            if (!deletionOk) pendingRemoval = removedKeys.length;
        }
        // 即使 IDB 刪除失敗，localStorage 的可重建副本仍可清掉；下次 prune 會
        // 因 lastPrune 未更新而重試 IDB。
        for (const key of removedKeys) {
            try { localStorage.removeItem(key); } catch (_) { /* noop */ }
        }
    }
    return {
        ok: idbRows !== null && deletionOk,
        fallback: idbRows === null,
        removed: deletionOk ? removedKeys.length : 0,
        pendingRemoval,
        kept: kept.length
    };
}

/**
 * 依 `bdc:cache:lastPrune` 控制實際掃描頻率（預設 24 小時一次）。
 * main.js 在初始化後於閒置時呼叫；測試可直接注入 nowMs。
 */
export async function pruneCacheIfDue(options = {}) {
    const minIntervalMs = Number.isFinite(options.minIntervalMs) ? Math.max(0, options.minIntervalMs) : CACHE_PRUNE_INTERVAL_MS;
    const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : now();
    let lastPruneMs = 0;
    try { lastPruneMs = Number(localStorage.getItem(LAST_PRUNE_KEY) || 0) || 0; } catch (_) { lastPruneMs = 0; }
    if (lastPruneMs > 0 && nowMs - lastPruneMs < minIntervalMs) {
        return { ok: true, skipped: true, removed: 0, kept: 0 };
    }
    const result = await pruneCache(options);
    // 只有真的掃描成功（或本來就沒有 IDB、只清 localStorage）才記錄時間；
    // IDB 刪除失敗時保留舊時間，下一次啟動會重試，而不是等到 24 小時後。
    if (result.ok || result.fallback) {
        try { localStorage.setItem(LAST_PRUNE_KEY, String(nowMs)); } catch (_) { /* noop */ }
    }
    return { ...result, skipped: false };
}

// Convenience helpers for this app
/** 只清除可重建的快取（localStorage 前綴 + bdc-cache/kv 的同一前綴），不刪資料庫。 */
export async function clearRebuildable() {
    let removed = 0;
    try {
        for (const key of Object.keys(localStorage)) {
            if (key.startsWith(PREFIX)) {
                localStorage.removeItem(key);
                removed += 1;
            }
        }
    } catch (_) {}
    try {
        // 與 prune 共用同一套掃描：沒有 openCursor 的環境（含測試替身）
        // 會退回 getAll，否則「清理快取」在那些環境會靜默什麼都没刪。
        const rows = await scanIdbCacheRows();
        if (rows && rows.length) {
            await idbDeleteMany(rows.map((row) => row.key));
            removed += rows.length;
        }
    } catch (_) {}
    return { ok: true, removed };
}

export async function getParagraphAnalysisCached(paragraph, level, model, options = {}) {
  return getCached('paragraphAnalysis', { paragraph, level, model, ...options, schema: 'v2' });
}

export async function setParagraphAnalysisCached(paragraph, level, model, value, ttlMs, options = {}) {
  return setCached('paragraphAnalysis', { paragraph, level, model, ...options, schema: 'v2' }, value, ttlMs);
}

export async function getWordAnalysisCached(word, sentence, model, options = {}) {
  return getCached('wordAnalysis', { word, sentence, model, ...options, schema: 'v2' });
}

export async function setWordAnalysisCached(word, sentence, model, value, ttlMs, options = {}) {
  return setCached('wordAnalysis', { word, sentence, model, ...options, schema: 'v2' }, value, ttlMs);
}

// Sentence-level analysis
export async function getSentenceAnalysisCached(sentence, contextHash, model, options = {}) {
  return getCached('sentenceAnalysis', { sentence, contextHash, model, ...options, schema: 'v2' });
}

export async function setSentenceAnalysisCached(sentence, contextHash, model, value, ttlMs, options = {}) {
  return setCached('sentenceAnalysis', { sentence, contextHash, model, ...options, schema: 'v2' }, value, ttlMs);
}

// Selection/phrase analysis within a sentence
export async function getSelectionAnalysisCached(selection, sentence, contextHash, model, options = {}) {
  return getCached('selectionAnalysis', { selection, sentence, contextHash, model, ...options, schema: 'v2' });
}

export async function setSelectionAnalysisCached(selection, sentence, contextHash, model, value, ttlMs, options = {}) {
  return setCached('selectionAnalysis', { selection, sentence, contextHash, model, ...options, schema: 'v2' }, value, ttlMs);
}
