// Lightweight local snapshot backup utilities (client-side only)
// Complete payloads live in IndexedDB; legacy localStorage backups migrate after verification.
// Note: This is a convenience rollback; clearing site data will remove backups.

import { buildLocalSnapshot } from './sync-core.js';
import * as articleStore from './article-store.js';
import * as readingStore from './reading-store.js';
import { getAIProfileUpdatedAt } from './ai-profile-storage.js';

export { prepareBackupStorage } from './backup-store.js';
export {
    listBackupRecords as listBackups,
    loadBackupRecord as loadBackupPayload,
    deleteBackupRecord as deleteBackup,
    saveBackupRecord as saveBackupPayload
} from './backup-store.js';
import { saveBackupRecord as saveBackupPayload } from './backup-store.js';

const SIGNATURE_KEY = 'bdc:backup:last-auto-signature:v1';
const BACKUP_SESSION_ID = Math.random().toString(36).slice(2, 10);

function isAutoNote(note) {
    return !/(手動|手动|manual)/i.test(String(note || '')) && /(自動|自动|auto)/i.test(String(note || ''));
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
    const saved = await saveBackupPayload(payload, note);
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
