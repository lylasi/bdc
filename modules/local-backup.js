// Lightweight local snapshot backup utilities (client-side only)
// Stores recent payload backups in localStorage under prefix 'bdc:backup:v1:'
// Note: This is a convenience rollback; clearing site data will remove backups.

import { buildLocalSnapshot } from './sync-core.js';
import * as articleStore from './article-store.js';
import * as readingStore from './reading-store.js';
import { getAIProfileUpdatedAt } from './ai-profile-storage.js';

const PREFIX = 'bdc:backup:v1:';
const INDEX_KEY = 'bdc:backup:index:v1';
// 備份的 ts／note／manual 只寫在索引旁的中繼資料，不必為了裁剪而重新解析
// 每一包完整 payload（大型備份每次解析都很貴）。
const META_KEY = 'bdc:backup:meta:v1';
const SIGNATURE_KEY = 'bdc:backup:last-auto-signature:v1';
// 寫入世代計數只存在模組記憶體；加上每次載入頁面的隨機值，避免重新載入後
// 世代歸零撞到上一輪的簽章而誤判「沒有變更」。
const BACKUP_SESSION_ID = Math.random().toString(36).slice(2, 10);
// Auto-backup retention (manual backups are not counted nor pruned by this limit)
const MAX_AUTO_BACKUPS = 2;

function isManualNote(note) {
  return /(手動|手动|manual)/i.test(String(note || ''));
}

function isAutoNote(note) {
  return !isManualNote(note) && /(自動|自动|auto)/i.test(String(note || ''));
}

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

function readMeta() {
  try {
    const parsed = JSON.parse(localStorage.getItem(META_KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) { return {}; }
}

function writeMeta(meta) {
  try { localStorage.setItem(META_KEY, JSON.stringify(meta)); } catch (_) {}
}

function keyOf(id) { return PREFIX + String(id); }

/**
 * 取得單一備份的 ts／note／manual。有中繼資料時不解析 payload；
 * 舊版備份（只有 id）才解析一次並補寫中繼資料。
 */
function describeBackup(id, meta) {
  const entryId = String(id);
  const known = meta[entryId];
  if (known) {
    return { id: entryId, ts: known.ts || entryId, note: known.note || '', manual: known.manual === true };
  }
  const raw = localStorage.getItem(keyOf(entryId));
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    const note = String(obj?.note || '');
    const entry = { id: entryId, ts: obj?.ts || entryId, note, manual: isManualNote(note) };
    meta[entryId] = { ts: entry.ts, note: entry.note, manual: entry.manual };
    return entry;
  } catch (_) {
    return null;
  }
}

export function listBackups() {
  try {
    const meta = readMeta();
    let metaDirty = false;
    const list = [];
    for (const id of readIndex()) {
      const before = Object.prototype.hasOwnProperty.call(meta, String(id));
      const entry = describeBackup(id, meta);
      if (!entry) continue;
      if (!before) metaDirty = true;
      const raw = localStorage.getItem(keyOf(entry.id));
      if (!raw) continue;
      list.push({ id: entry.id, ts: entry.ts, note: entry.note, size: raw.length });
    }
    if (metaDirty) writeMeta(meta);
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
  const meta = readMeta();
  if (Object.prototype.hasOwnProperty.call(meta, String(id))) {
    delete meta[String(id)];
    writeMeta(meta);
  }
}

export function saveBackupPayload(payload, note = '') {
  try {
    const id = Date.now();
    const data = { ts: id, note, payload };
    const raw = JSON.stringify(data);
    localStorage.setItem(keyOf(id), raw);
    const meta = readMeta();
    meta[String(id)] = { ts: id, note: String(note || ''), manual: isManualNote(note) };
    const idx = readIndex();
    idx.push(id);
    // 只用索引與中繼資料判斷手動／自動，不必重新解析整包備份。
    const entries = [];
    for (const bid of idx) {
      const entry = describeBackup(bid, meta);
      if (entry) entries.push(entry);
    }
    const manual = entries.filter(e => e.manual);
    const auto = entries.filter(e => !e.manual);
    auto.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
    const keptAuto = auto.slice(0, MAX_AUTO_BACKUPS);
    const keepIds = new Set([...manual, ...keptAuto].map(e => e.id));
    // Delete overflow (auto beyond limit)
    for (const entry of entries) {
      if (keepIds.has(entry.id)) continue;
      try { localStorage.removeItem(keyOf(entry.id)); } catch (_) {}
      delete meta[entry.id];
    }
    // Write back pruned index (newest first for display)
    const keepSorted = entries
      .filter(e => keepIds.has(e.id))
      .sort((a, b) => String(b.ts).localeCompare(String(a.ts)))
      .map(e => e.id);
    writeIndex(keepSorted);
    writeMeta(meta);
    return { id };
  } catch (e) {
    return { error: e };
  }
}

function readTimestamp(key) {
  try { return localStorage.getItem(key) || ''; } catch (_) { return ''; }
}

/**
 * 便宜的資料版本簽章：文章／閱讀寫入世代 + 快照群組時間戳。
 * 任何一個群組真的變更就會不同；連續同步但資料沒變時可直接跳過重建。
 */
function dataSignature() {
  const parts = [
    `z${BACKUP_SESSION_ID}`,
    `a${articleStore.getDataEpoch()}`,
    `r${readingStore.getDataEpoch()}`,
    `d${readTimestamp('dictationUpdatedAt')}`,
    `v${readTimestamp('vocabularyUpdatedAt')}`,
    `q${readTimestamp('qaUpdatedAt')}`,
    `s${readTimestamp('assistantUpdatedAt')}`
  ];
  try { parts.push(`ai${getAIProfileUpdatedAt()}`); } catch (_) { parts.push('ai'); }
  return parts.join('|');
}

function readLastSignature() {
  try { return localStorage.getItem(SIGNATURE_KEY) || ''; } catch (_) { return ''; }
}

function writeLastSignature(signature) {
  try {
    if (signature) localStorage.setItem(SIGNATURE_KEY, signature);
    else localStorage.removeItem(SIGNATURE_KEY);
  } catch (_) {}
}

// Convenience: build a fresh local snapshot and save its payload as a backup.
// 文章已不再放在快照裡，因此這裡另外附上完整文章文件（原文＋分析＋來源＋
// 閱讀時間），備份才能從空白裝置離線還原全部文章。
let autoBackupInFlight = null;

async function buildAndSaveBackup(note, { auto = false, force = false, signature = '', articleCtx = null, readingCtx = null } = {}) {
  try {
    if (auto && !force && signature && signature === readLastSignature()) {
      return { skipped: true, reason: 'unchanged' };
    }
    const snap = await buildLocalSnapshot();
    const payload = { ...(snap?.payload || {}) };
    // 每個必要群組都必須確認匯出真的成功：舊版把例外轉成 []／null 後仍存成
    // 「成功備份」並更新自動備份簽章，之後同一簽章會跳過重建，等於用一份
    // 沒有文章的備份覆蓋了可用的舊備份。失敗就不保存、不裁剪、不動簽章。
    const articleExport = await articleStore.exportDocumentsResult(
      articleCtx || articleStore.captureArticleContext(),
      { hydrate: false }
    );
    if (!articleExport || articleExport.ok !== true) {
      return { error: new Error(`article_export_failed:${(articleExport && articleExport.error) || 'unknown'}`) };
    }
    payload.articleDocuments = articleExport.documents;
    // 完整閱讀檔案：學習條目、詞書／關聯、文件、全部消息、原文版本。
    // 與給 AI 的上下文裁剪完全分開，沒有 50 條上限。
    const readingExport = await readingStore.exportAll(
      readingCtx || readingStore.captureReadingContext(),
      { hydrate: false }
    );
    if (!readingExport || readingExport.ok !== true) {
      return { error: new Error(`reading_export_failed:${(readingExport && readingExport.error) || 'unknown'}`) };
    }
    payload.reading = readingExport;
    const saved = saveBackupPayload(payload, note);
    if (auto && saved && !saved.error && signature) writeLastSignature(signature);
    return saved;
  } catch (e) {
    return { error: e };
  }
}

/**
 * 建立本機完整備份。
 * `options.auto` 預設依 note 判斷（自動同步 → true）：自動備份會先用資料版本
 * 簽章去重，資料沒有變更就不重建整個 payload；同時只允許一個自動備份在跑。
 * 手動備份一律建立。
 */
export async function createBackup(note = '', options = {}) {
  const auto = options.auto === true || (options.auto !== false && isAutoNote(note));
  // 入口同步捕捉 scope：備份在鎖外執行，切換帳戶後不得把新範圍的資料混進來。
  const articleCtx = articleStore.captureArticleContext();
  const readingCtx = readingStore.captureReadingContext();
  if (!auto) return buildAndSaveBackup(note, { auto: false, articleCtx, readingCtx });
  if (autoBackupInFlight) return autoBackupInFlight;
  autoBackupInFlight = (async () => {
    try {
      return await buildAndSaveBackup(note, {
        auto: true,
        force: options.force === true,
        signature: dataSignature(),
        articleCtx,
        readingCtx
      });
    } finally {
      autoBackupInFlight = null;
    }
  })();
  return autoBackupInFlight;
}
