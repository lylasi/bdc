// Lightweight local snapshot backup utilities (client-side only)
// Stores recent payload backups in localStorage under prefix 'bdc:backup:v1:'
// Note: This is a convenience rollback; clearing site data will remove backups.

import { buildLocalSnapshot } from './sync-core.js';

const PREFIX = 'bdc:backup:v1:';
const INDEX_KEY = 'bdc:backup:index:v1';
// Auto-backup retention (manual backups are not counted nor pruned by this limit)
const MAX_AUTO_BACKUPS = 2;

function readIndex() {
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (_) { return []; }
}

function writeIndex(ids) {
  try { localStorage.setItem(INDEX_KEY, JSON.stringify(ids)); } catch (_) {}
}

function keyOf(id) { return PREFIX + String(id); }

export function listBackups() {
  try {
    const ids = readIndex();
    const list = [];
    for (const id of ids) {
      const raw = localStorage.getItem(keyOf(id));
      if (!raw) continue;
      try {
        const obj = JSON.parse(raw);
        const size = raw.length;
        list.push({ id, ts: obj.ts || id, note: obj.note || '', size });
      } catch (_) {}
    }
    // newest first
    list.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
    return list;
  } catch (_) { return []; }
}

export function loadBackupPayload(id) {
  try {
    const raw = localStorage.getItem(keyOf(id));
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return obj?.payload || null;
  } catch (_) { return null; }
}

export function deleteBackup(id) {
  try { localStorage.removeItem(keyOf(id)); } catch (_) {}
  const idx = readIndex().filter(x => String(x) !== String(id));
  writeIndex(idx);
}

export function saveBackupPayload(payload, note = '') {
  try {
    const id = Date.now();
    const data = { ts: id, note, payload };
    const raw = JSON.stringify(data);
    localStorage.setItem(keyOf(id), raw);
    const idx = readIndex();
    idx.push(id);
    // Build a view of entries with ts and note to distinguish auto vs manual
    const entries = [];
    for (const bid of idx) {
      try {
        const rawB = localStorage.getItem(keyOf(bid));
        if (!rawB) continue;
        const obj = JSON.parse(rawB);
        const ts = obj?.ts || bid;
        const n = String(obj?.note || '');
        const isManual = /手動|manual/i.test(n);
        entries.push({ id: bid, ts, isManual });
      } catch (_) {}
    }
    // Separate manual and auto
    const manual = entries.filter(e => e.isManual);
    const auto = entries.filter(e => !e.isManual);
    auto.sort((a,b)=> String(b.ts).localeCompare(String(a.ts)));
    const keptAuto = auto.slice(0, MAX_AUTO_BACKUPS);
    const keepIdsSet = new Set([...manual.map(e=>e.id), ...keptAuto.map(e=>e.id)]);
    // Delete overflow (auto beyond limit)
    for (const e of entries) {
      if (!keepIdsSet.has(e.id)) {
        try { localStorage.removeItem(keyOf(e.id)); } catch (_) {}
      }
    }
    // Write back pruned index (newest first for display)
    const keepSorted = entries
      .filter(e => keepIdsSet.has(e.id))
      .sort((a,b)=> String(b.ts).localeCompare(String(a.ts)))
      .map(e => e.id);
    writeIndex(keepSorted);
    return { id };
  } catch (e) {
    return { error: e };
  }
}

// Convenience: build a fresh local snapshot and save its payload as a backup
export async function createBackup(note = '') {
  try {
    const snap = await buildLocalSnapshot();
    return saveBackupPayload(snap?.payload || {}, note);
  } catch (e) {
    return { error: e };
  }
}
