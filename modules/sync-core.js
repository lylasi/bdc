// Minimal sync core for Supabase snapshot (Scheme C)
// Focus: group-level LWW with local-first snapshot apply / restore

import * as state from './state.js';
import * as cache from './cache.js';
import {
  saveVocabularyBooks,
  saveAppState,
  getGradingHistory,
  saveGradingHistory
} from './storage.js';
import * as articleStore from './article-store.js';
import * as readingStore from './reading-store.js';
import { loadGlobalSettings } from './settings.js';
import { sanitizeAISettings } from './ai-settings-sanitize.js';
import { applyRemoteAISettings, getAIProfileUpdatedAt } from './ai-profile-storage.js';
import { t } from './i18n.js';

const ASSISTANT_LEGACY_KEY = 'assistantConversations';
const ASSISTANT_INDEX_KEY = 'assistantConvIndex';
const ASSISTANT_UPDATED_AT_KEY = 'assistantUpdatedAt';
const DICTATION_UPDATED_AT_KEY = 'dictationUpdatedAt';

function getLocalUpdatedAt(key, fallbackNow = true) {
  try {
    const v = localStorage.getItem(key);
    if (v && typeof v === 'string') return v;
  } catch (_) {}
  if (fallbackNow) {
    const now = new Date().toISOString();
    try { localStorage.setItem(key, now); } catch (_) {}
    return now;
  }
  return '';
}

function normalizeUpdatedAt(ts, fallback = '') {
  return typeof ts === 'string' && ts ? ts : fallback;
}

function shouldApplyGroup(remoteUpdatedAt, localUpdatedAt, force = false) {
  if (force) return true;
  const rts = String(remoteUpdatedAt || '');
  const lts = String(localUpdatedAt || '');
  if (!rts) return false;
  return !lts || rts > lts;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasSyncableAISettings(ai) {
  if (!isPlainObject(ai)) return false;
  return !!(
    (typeof ai.apiUrl === 'string' && ai.apiUrl.trim())
    || (isPlainObject(ai.providers) && Object.keys(ai.providers).length)
    || (isPlainObject(ai.models) && Object.keys(ai.models).length)
    || (isPlainObject(ai.tasks) && Object.keys(ai.tasks).length)
  );
}

function readAssistantIndex() {
  try {
    const raw = localStorage.getItem(ASSISTANT_INDEX_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function normalizeAssistantMeta(meta, fallbackUpdatedAt = '') {
  if (!meta || !meta.id) return null;
  return {
    id: meta.id,
    articleKey: meta.articleKey || 'global',
    title: meta.title || (meta.articleKey === 'global' ? t('assistant.globalSession') : t('assistant.article')),
    updatedAt: normalizeUpdatedAt(meta.updatedAt, fallbackUpdatedAt)
  };
}

async function readAssistantConversationMessages(convId) {
  if (!convId) return [];
  try {
    const rec = await cache.getItem(`assistant:conv:${convId}`);
    return Array.isArray(rec?.messages) ? rec.messages : [];
  } catch (_) {
    return [];
  }
}

async function writeAssistantConversationMessages(convId, messages) {
  if (!convId) return false;
  try {
    return await cache.setItem(`assistant:conv:${convId}`, { messages: Array.isArray(messages) ? messages : [] });
  } catch (_) {
    return false;
  }
}

async function buildAssistantSnapshotPayload() {
  const index = readAssistantIndex();
  const conversations = await Promise.all(index.map(async (meta) => {
    const normalizedMeta = normalizeAssistantMeta(meta);
    if (!normalizedMeta) return null;
    const messages = await readAssistantConversationMessages(normalizedMeta.id);
    return {
      ...normalizedMeta,
      messages: Array.isArray(messages) ? messages.slice(-50) : []
    };
  }));
  return {
    conversations: conversations.filter(Boolean)
  };
}

async function writeAssistantSnapshotPayload(payload, options = {}) {
  const normalizedOptions = options && typeof options === 'object' ? options : {};
  const groupUpdatedAt = normalizeUpdatedAt(normalizedOptions.updatedAtOverride, new Date().toISOString());
  const conversations = Array.isArray(payload?.conversations) ? payload.conversations : [];
  const localIds = new Set(readAssistantIndex().map(item => item && item.id).filter(Boolean));
  const nextIndex = [];
  const nextIds = new Set();

  for (const conv of conversations) {
    if (!conv || !conv.id) continue;
    const meta = normalizeAssistantMeta(conv, groupUpdatedAt);
    if (!meta) continue;
    nextIndex.push(meta);
    nextIds.add(meta.id);
    await writeAssistantConversationMessages(meta.id, Array.isArray(conv.messages) ? conv.messages : []);
  }

  if (normalizedOptions.clearMissing === true) {
    for (const id of localIds) {
      if (!nextIds.has(id)) {
        await writeAssistantConversationMessages(id, []);
      }
    }
  }

  try {
    localStorage.setItem(ASSISTANT_INDEX_KEY, JSON.stringify(nextIndex));
    localStorage.setItem(ASSISTANT_UPDATED_AT_KEY, groupUpdatedAt);
    localStorage.removeItem(ASSISTANT_LEGACY_KEY);
  } catch (_) {}
}

async function applyDictationPayload(remote, force = false) {
  const remoteGroup = remote?.dictation;
  if (remoteGroup && typeof remoteGroup === 'object') {
    const remoteUpdatedAt = normalizeUpdatedAt(remoteGroup.updatedAt, remoteGroup.settings?.updatedAt || remoteGroup.settingsUpdatedAt || '');
    const localUpdatedAt = getLocalUpdatedAt(DICTATION_UPDATED_AT_KEY, false) || String(state.dictationSettings?.updatedAt || '');
    if (!shouldApplyGroup(remoteUpdatedAt, localUpdatedAt, force)) return;

    const remoteSettings = remoteGroup.settings && typeof remoteGroup.settings === 'object'
      ? remoteGroup.settings
      : remote?.userSettings?.dictation;
    if (remoteSettings && typeof remoteSettings === 'object') {
      const next = { ...state.dictationSettings, ...remoteSettings };
      state.setDictationSettings(next);
      state.saveDictationSettings({
        preserveUpdatedAt: true,
        updatedAtOverride: normalizeUpdatedAt(remoteUpdatedAt, remoteSettings.updatedAt || ''),
        suppressSyncTouch: true
      });
    }
    if (Array.isArray(remoteGroup.gradingHistory)) {
      saveGradingHistory(remoteGroup.gradingHistory, {
        preserveUpdatedAt: true,
        updatedAtOverride: remoteUpdatedAt,
        suppressSyncTouch: true
      });
    }
    return;
  }

  // Backward compatibility: older snapshots only stored userSettings.dictation
  const remoteDict = remote?.userSettings?.dictation;
  if (remoteDict && typeof remoteDict === 'object') {
    const localDict = state.dictationSettings || {};
    const rts = String(remoteDict.updatedAt || '');
    const lts = String(localDict.updatedAt || '');
    if (!shouldApplyGroup(rts, lts, force)) return;
    const next = { ...localDict, ...remoteDict };
    state.setDictationSettings(next);
    state.saveDictationSettings({
      preserveUpdatedAt: true,
      updatedAtOverride: remoteDict.updatedAt,
      suppressSyncTouch: true
    });
  }
}

function applyVocabularyPayload(remote, force = false) {
  const remoteV = remote?.vocabulary;
  if (!remoteV || typeof remoteV !== 'object') return;
  // 詞書已遷移到逐項永久層後，舊快照群組不得再整組覆蓋。
  // 例外：新裝置的永久層仍為空（例如後端尚未支援逐項 API），允許一次
  // 唯讀匯入舊快照，避免使用者看不到既有資料；匯入後仍以永久層為準。
  if (readingStore.isReadingMigrated()) {
    if (Array.isArray(remoteV.books) && remoteV.books.length) {
      readingStore.adoptLegacyVocabularySnapshot(remoteV.books).then((result) => {
        if (result && result.books) state.setVocabularyBooks(readingStore.vocabularyBooksForUi());
      }).catch(() => {});
    }
    return;
  }
  const localUpdatedAt = getLocalUpdatedAt('vocabularyUpdatedAt', false);
  if (!shouldApplyGroup(remoteV.updatedAt, localUpdatedAt, force)) return;

  if (Array.isArray(remoteV.books)) {
    state.setVocabularyBooks(remoteV.books);
    saveVocabularyBooks({
      preserveUpdatedAt: true,
      updatedAtOverride: remoteV.updatedAt,
      suppressSyncTouch: true
    });
  }
  if (remoteV.activeBookId !== undefined) {
    state.setActiveBookId(remoteV.activeBookId);
    saveAppState({
      preserveUpdatedAt: true,
      updatedAtOverride: remoteV.updatedAt,
      suppressSyncTouch: true
    });
  }
}

// 文章已搬到逐篇儲存：舊快照裡的 articles 群組只當成「一次性匯入來源」。
// 已存在的本機記錄不覆蓋；匯入後由文章同步走 /articles 接口，不再回寫快照。
async function applyArticlesPayload(remote) {
  const legacy = remote?.articles;
  if (!legacy || typeof legacy !== 'object') return;
  const metas = Array.isArray(legacy.articleMetas) ? legacy.articleMetas : [];
  const metaById = new Map();
  for (const meta of metas) {
    if (meta && meta.id) metaById.set(String(meta.id), meta);
  }
  const entries = [];
  for (const item of Array.isArray(legacy.analyzedArticles) ? legacy.analyzedArticles : []) {
    if (!item || typeof item.article !== 'string' || !item.article.trim()) continue;
    const id = item.articleId ? String(item.articleId) : '';
    const meta = id ? metaById.get(id) : null;
    entries.push({
      articleId: id || (meta && meta.id) || '',
      article: item.article,
      result: item.result === undefined ? null : item.result,
      title: meta?.title || item.title || '',
      sourceType: meta?.sourceType || item.sourceType,
      sourceUrl: meta?.sourceUrl || item.sourceUrl,
      createdAt: meta?.createdAt || item.createdAt,
      updatedAt: item.result?.updatedAt || meta?.updatedAt || ''
    });
  }
  // 沒有文章的 meta 也一併保留，避免生詞本與來源關聯斷掉
  for (const meta of metas) {
    if (!meta || !meta.id) continue;
    if (entries.some((entry) => entry.articleId === String(meta.id))) continue;
    entries.push({ articleId: String(meta.id), article: '', title: meta.title || '', sourceType: meta.sourceType, sourceUrl: meta.sourceUrl, createdAt: meta.createdAt });
  }
  try {
    await articleStore.importLegacyArticles(entries.filter((entry) => entry.article && entry.article.trim()));
  } catch (error) {
    console.warn('[sync] 舊文章匯入失敗:', error && error.code ? error.code : 'unknown');
  }
}

function applyQAPayload(remote, force = false) {
  const remoteQA = remote?.qa;
  if (!remoteQA || typeof remoteQA !== 'object') return;
  const localUpdatedAt = getLocalUpdatedAt('qaUpdatedAt', false);
  if (!shouldApplyGroup(remoteQA.updatedAt, localUpdatedAt, force)) return;

  try {
    const prevManifest = (() => {
      try {
        const raw = localStorage.getItem('qa-sets');
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
      } catch (_) {
        return [];
      }
    })();

    if (Array.isArray(remoteQA.manifest)) {
      localStorage.setItem('qa-sets', JSON.stringify(remoteQA.manifest));
    }

    const sets = remoteQA.sets || {};
    const ids = new Set(Object.keys(sets));
    for (const it of prevManifest) {
      const id = it && it.id;
      if (id && !ids.has(id)) {
        try { localStorage.removeItem(`qa-set-${id}`); } catch (_) {}
      }
    }
    for (const id of Object.keys(sets)) {
      try { localStorage.setItem(`qa-set-${id}`, JSON.stringify(sets[id])); } catch (_) {}
    }
    localStorage.setItem('qaUpdatedAt', remoteQA.updatedAt || new Date().toISOString());
  } catch (_) {}
}

async function applyAssistantPayload(remote, force = false) {
  const remoteAsst = remote?.assistant;
  if (!remoteAsst || typeof remoteAsst !== 'object') return;
  // 聊天已遷移到逐項永久層後，舊快照群組不得再整組覆蓋。
  // 新裝置永久層仍為空時允許一次匯入，之後仍走逐項同步。
  if (readingStore.isReadingMigrated()) {
    if (Array.isArray(remoteAsst.conversations) && remoteAsst.conversations.length) {
      readingStore.adoptLegacyAssistantSnapshot(remoteAsst).catch(() => {});
    }
    return;
  }
  const localUpdatedAt = getLocalUpdatedAt(ASSISTANT_UPDATED_AT_KEY, false);
  if (!shouldApplyGroup(remoteAsst.updatedAt, localUpdatedAt, force)) return;
  await writeAssistantSnapshotPayload(remoteAsst, {
    updatedAtOverride: remoteAsst.updatedAt,
    clearMissing: true
  });
}

/**
 * Announce that remote AI settings were written to the local profile.
 *
 * Personal keys are not part of the snapshot; a device that applied provider
 * definitions only now knows which `/ai-credentials` rows it can download. The
 * credential sync listens for this event instead of being imported here (which
 * would close a module cycle). It only schedules a sync, so this can never feed
 * back into another apply.
 */
function notifyAISettingsApplied() {
  try {
    if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
    window.dispatchEvent(new CustomEvent('bdc:ai-settings-applied'));
  } catch (_) {}
}

function applyAISettingsPayload(remote, force = false) {
  const remoteGroup = remote?.aiSettings;
  if (!remoteGroup || typeof remoteGroup !== 'object') return;
  const remoteUpdatedAt = normalizeUpdatedAt(remoteGroup.updatedAt);
  const localUpdatedAt = getAIProfileUpdatedAt();
  if (!shouldApplyGroup(remoteUpdatedAt, localUpdatedAt, force)) return;
  try {
    applyRemoteAISettings(sanitizeAISettings(remoteGroup.settings), remoteUpdatedAt);
  } catch (error) {
    // A failed local write must not abort the rest of the snapshot restore.
    console.warn('[sync] AI settings apply failed:', error && error.code ? error.code : 'unknown');
    return;
  }
  notifyAISettingsApplied();
}

async function applySnapshotPayload(payload, force = false) {
  const remote = payload || {};
  // 必要群組的失敗必須往上回報：備份還原若把文章匯入失敗吞掉，畫面上會
  // 顯示「還原成功」，實際上文章完全沒有回來。其他群組照常套用。
  const errors = [];
  await applyDictationPayload(remote, force);
  applyVocabularyPayload(remote, force);
  await applyArticlesPayload(remote);
  // 備份／匯出帶的完整文章文件（新格式）：離線還原時一併寫回逐篇儲存。
  if (Array.isArray(remote.articleDocuments) && remote.articleDocuments.length) {
    try {
      const result = await articleStore.importDocuments(remote.articleDocuments, { replace: force === true });
      if (!result || result.ok !== true) {
        errors.push({ group: 'articleDocuments', error: (result && result.error) || 'article_import_failed' });
        console.warn('[sync] 文章文件還原失敗:', (result && result.error) || 'unknown');
      }
    } catch (error) {
      const code = (error && (error.code || error.message)) || 'article_import_failed';
      errors.push({ group: 'articleDocuments', error: code });
      console.warn('[sync] 文章文件還原失敗:', code);
    }
  }
  // 完整備份的閱讀資料（學習條目、詞書、關聯、文件、消息、版本）
  if (remote.reading && typeof remote.reading === 'object') {
    try {
      const result = await readingStore.restoreAll(remote.reading, { allowPartial: true });
      if (!result || result.ok !== true) {
        errors.push({ group: 'reading', error: (result && result.error) || 'reading_restore_failed' });
        console.warn('[sync] 閱讀資料還原失敗:', (result && result.error) || 'unknown');
      }
    } catch (error) {
      const code = (error && (error.code || error.message)) || 'reading_restore_failed';
      errors.push({ group: 'reading', error: code });
      console.warn('[sync] 閱讀資料還原失敗:', code);
    }
  }
  applyQAPayload(remote, force);
  applyAISettingsPayload(remote, force);
  await applyAssistantPayload(remote, force);
  return errors.length ? { ok: false, errors } : { ok: true, errors: [] };
}

// Build a local snapshot payload
// Returns an object: { schemaVersion, updatedAt, payload }
export async function buildLocalSnapshot() {
  // Ensure we read the latest dictationSettings from localStorage
  try { state.loadDictationSettings(); } catch (_) {}

  const dictation = state.dictationSettings || {};
  const dictationUpdatedAt = getLocalUpdatedAt(DICTATION_UPDATED_AT_KEY, false) || String(dictation.updatedAt || '');
  // Do NOT auto-create timestamps when missing; treat as unknown so remote wins on first run after local wipe
  const vocabularyUpdatedAt = getLocalUpdatedAt('vocabularyUpdatedAt', false);

  // QA group (user-created only)
  const qaManifest = (() => {
    try { return JSON.parse(localStorage.getItem('qa-sets') || '[]'); } catch (_) { return []; }
  })();
  const qaSets = (() => {
    const out = {};
    try {
      if (Array.isArray(qaManifest)) {
        for (const item of qaManifest) {
          const id = item && item.id;
          if (!id) continue;
          const raw = localStorage.getItem(`qa-set-${id}`);
          if (raw) {
            try { out[id] = JSON.parse(raw); } catch (_) {}
          }
        }
      }
    } catch (_) {}
    return out;
  })();
  // Same here for QA group. Missing timestamp should not be considered newer than remote
  const qaUpdatedAt = getLocalUpdatedAt('qaUpdatedAt', false);

  // Assistant（對話）：遷移後由逐項永久層負責，不再讀舊快取或截取 50 條。
  const assistantPayload = readingStore.isReadingMigrated()
    ? { conversations: [] }
    : await buildAssistantSnapshotPayload();
  const assistantUpdatedAt = readingStore.isReadingMigrated()
    ? ''
    : getLocalUpdatedAt(ASSISTANT_UPDATED_AT_KEY, false);
  const globalSettings = loadGlobalSettings();
  const aiSettingsUpdatedAt = getAIProfileUpdatedAt();

  // 文章不再放進快照：每篇獨立資料列，由 modules/article-sync.js 以自己的游標同步。
  // 保留 `articles` 之外的群組語意，其他資料照舊走 snapshot LWW。
  const gradingHistory = getGradingHistory();

  return {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    payload: {
      userSettings: {
        dictation
      },
      dictation: {
        updatedAt: dictationUpdatedAt,
        settings: dictation,
        gradingHistory
      },
      // 詞書已完成遷移時不再放進快照；activeBookId 屬裝置偏好，留在本機。
      ...(readingStore.isReadingMigrated() ? {} : {
        vocabulary: {
          updatedAt: vocabularyUpdatedAt,
          books: state.vocabularyBooks,
          activeBookId: state.activeBookId
        }
      }),
      qa: {
        updatedAt: qaUpdatedAt,
        manifest: qaManifest,
        sets: qaSets
      },
      aiSettings: {
        updatedAt: aiSettingsUpdatedAt,
        settings: sanitizeAISettings(globalSettings?.ai)
      },
      ...(readingStore.isReadingMigrated() ? {} : {
        assistant: {
          updatedAt: assistantUpdatedAt,
          ...assistantPayload
        }
      })
    }
  };
}

// Apply merged snapshot (group-level LWW)
// 不拋出：合併式同步不是使用者主動還原，失敗只回傳結果供除錯；呼叫端
// 仍可從回傳值看到必要群組的錯誤。
export async function applyMergedSnapshot(snapshot) {
  return applySnapshotPayload(snapshot?.payload || {}, false);
}

// Restore snapshot locally without LWW checks
// 使用者主動還原必須明確失敗：UI 才不會在文章完全沒寫回時顯示成功。
export async function restoreSnapshotLocally(payload) {
  const result = await applySnapshotPayload(payload || {}, true);
  if (result && result.ok === false) {
    const detail = (result.errors || [])
      .map((item) => `${item.group}:${item.error}`)
      .join(', ');
    const error = new Error(`snapshot_restore_failed${detail ? `: ${detail}` : ''}`);
    error.code = 'snapshot_restore_failed';
    error.errors = result.errors || [];
    throw error;
  }
  return result;
}

// Trivial LWW for group-level merge
export function lwwMerge(localPayload, remotePayload) {
  const out = { ...(remotePayload || {}) };

  const ld = localPayload?.dictation;
  const rd = remotePayload?.dictation;
  const ldts = String(ld?.updatedAt || localPayload?.userSettings?.dictation?.updatedAt || '');
  const rdts = String(rd?.updatedAt || remotePayload?.userSettings?.dictation?.updatedAt || '');
  if (ld && (!rd || ldts > rdts)) {
    out.dictation = ld;
    out.userSettings = out.userSettings || {};
    out.userSettings.dictation = ld.settings || localPayload?.userSettings?.dictation || {};
  } else {
    const l = localPayload?.userSettings?.dictation;
    const r = remotePayload?.userSettings?.dictation;
    const lts = String(l?.updatedAt || '');
    const rts = String(r?.updatedAt || '');
    if (l && (!r || lts > rts)) {
      out.userSettings = out.userSettings || {};
      out.userSettings.dictation = l;
    }
  }

  // vocabulary group-level LWW
  if (!readingStore.isReadingMigrated()) {
    const lv = localPayload?.vocabulary;
    const rv = remotePayload?.vocabulary;
    const lvts = String(lv?.updatedAt || '');
    const rvts = String(rv?.updatedAt || '');
    if (lv && (!rv || lvts > rvts)) {
      out.vocabulary = lv;
    }
  } else {
    delete out.vocabulary;
  }

  // 文章群組不再參與快照合併（獨立逐篇同步）。遠端舊群組只在套用時匯入，
  // 不會被回寫，避免舊客戶端把已刪除的文章帶回來。
  delete out.articles;

  // qa group-level LWW
  const lq = localPayload?.qa;
  const rq = remotePayload?.qa;
  const lqts = String(lq?.updatedAt || '');
  const rqts = String(rq?.updatedAt || '');
  if (lq && (!rq || lqts > rqts)) {
    out.qa = lq;
  }

  // non-sensitive AI provider/model settings group-level LWW
  const lai = localPayload?.aiSettings;
  const rai = remotePayload?.aiSettings;
  const laits = String(lai?.updatedAt || '');
  const raits = String(rai?.updatedAt || '');
  if (lai && (!rai || laits > raits)) {
    out.aiSettings = lai;
  }

  // assistant group-level LWW
  if (!readingStore.isReadingMigrated()) {
    const las = localPayload?.assistant;
    const ras = remotePayload?.assistant;
    const lasts = String(las?.updatedAt || '');
    const rasts = String(ras?.updatedAt || '');
    if (las && (!ras || lasts > rasts)) {
      out.assistant = las;
    }
  } else {
    delete out.assistant;
  }

  return out;
}
