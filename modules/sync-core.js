// Minimal sync core for Supabase snapshot (Scheme C)
// Focus: group-level LWW with local-first snapshot apply / restore

import * as state from './state.js';
import * as cache from './cache.js';
import {
  saveVocabularyBooks,
  saveAppState,
  saveAnalyzedArticles,
  getAllArticleMetas,
  replaceArticleMetas,
  getGradingHistory,
  saveGradingHistory
} from './storage.js';

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
    title: meta.title || (meta.articleKey === 'global' ? '全局會話' : '文章'),
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

// Compact policy for articles:
// - sentence_analysis: keep only 1 per (sentence+context); prefer latest updatedAt
// - phrase_analysis: for each (sentence+context), keep top 3 by updatedAt
function compactAnalyzedArticles(arr) {
  try {
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const item of arr) {
      const r = item && item.result ? { ...item.result } : null;
      if (!r) { out.push(item); continue; }
      // sentence_analysis
      if (Array.isArray(r.sentence_analysis)) {
        const map = new Map();
        const keyOf = (s, c) => `${String(s || '').trim()}||${String(c || '').trim()}`.toLowerCase();
        for (const it of r.sentence_analysis) {
          const k = keyOf(it?.sentence, it?.context || it?._context);
          const prev = map.get(k);
          if (!prev) map.set(k, it);
          else {
            const pa = String(prev?.updatedAt || '');
            const pb = String(it?.updatedAt || '');
            if (pb > pa) map.set(k, it); else map.set(k, prev);
          }
        }
        r.sentence_analysis = Array.from(map.values());
      }
      // phrase_analysis
      if (Array.isArray(r.phrase_analysis)) {
        const buckets = new Map();
        const keySC = (s, c) => `${String(s || '').trim()}||${String(c || '').trim()}`.toLowerCase();
        for (const it of r.phrase_analysis) {
          const k = keySC(it?.sentence, it?.context || it?._context);
          if (!buckets.has(k)) buckets.set(k, []);
          buckets.get(k).push(it);
        }
        const merged = [];
        for (const list of buckets.values()) {
          list.sort((a, b) => String(b?.updatedAt || '').localeCompare(String(a?.updatedAt || '')));
          merged.push(...list.slice(0, 3));
        }
        r.phrase_analysis = merged;
      }
      out.push({ ...item, result: r });
    }
    return out;
  } catch (_) { return Array.isArray(arr) ? arr : []; }
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

function applyArticlesPayload(remote, force = false) {
  const remoteA = remote?.articles;
  if (!remoteA || typeof remoteA !== 'object') return;
  const localUpdatedAt = getLocalUpdatedAt('articlesUpdatedAt', false);
  if (!shouldApplyGroup(remoteA.updatedAt, localUpdatedAt, force)) return;

  if (Array.isArray(remoteA.analyzedArticles)) {
    const compacted = compactAnalyzedArticles(remoteA.analyzedArticles);
    state.setAnalyzedArticles(compacted);
    saveAnalyzedArticles({
      preserveUpdatedAt: true,
      updatedAtOverride: remoteA.updatedAt,
      suppressSyncTouch: true
    });
  }
  if (Array.isArray(remoteA.articleMetas)) {
    replaceArticleMetas(remoteA.articleMetas, {
      preserveUpdatedAt: true,
      updatedAtOverride: remoteA.updatedAt,
      suppressSyncTouch: true
    });
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
  const localUpdatedAt = getLocalUpdatedAt(ASSISTANT_UPDATED_AT_KEY, false);
  if (!shouldApplyGroup(remoteAsst.updatedAt, localUpdatedAt, force)) return;
  await writeAssistantSnapshotPayload(remoteAsst, {
    updatedAtOverride: remoteAsst.updatedAt,
    clearMissing: true
  });
}

async function applySnapshotPayload(payload, force = false) {
  const remote = payload || {};
  await applyDictationPayload(remote, force);
  applyVocabularyPayload(remote, force);
  applyArticlesPayload(remote, force);
  applyQAPayload(remote, force);
  await applyAssistantPayload(remote, force);
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
  const articlesUpdatedAt = getLocalUpdatedAt('articlesUpdatedAt', false);

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

  // Assistant（對話）
  const assistantPayload = await buildAssistantSnapshotPayload();
  const assistantUpdatedAt = getLocalUpdatedAt(ASSISTANT_UPDATED_AT_KEY, false);

  // Compact articles before push to reduce payload
  const compactArticles = compactAnalyzedArticles(state.analyzedArticles);
  const articleMetas = getAllArticleMetas();
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
      vocabulary: {
        updatedAt: vocabularyUpdatedAt,
        books: state.vocabularyBooks,
        activeBookId: state.activeBookId
      },
      articles: {
        updatedAt: articlesUpdatedAt,
        analyzedArticles: compactArticles,
        articleMetas
      },
      qa: {
        updatedAt: qaUpdatedAt,
        manifest: qaManifest,
        sets: qaSets
      },
      assistant: {
        updatedAt: assistantUpdatedAt,
        ...assistantPayload
      }
    }
  };
}

// Apply merged snapshot (group-level LWW)
export async function applyMergedSnapshot(snapshot) {
  await applySnapshotPayload(snapshot?.payload || {}, false);
}

// Restore snapshot locally without LWW checks
export async function restoreSnapshotLocally(payload) {
  await applySnapshotPayload(payload || {}, true);
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
  const lv = localPayload?.vocabulary;
  const rv = remotePayload?.vocabulary;
  const lvts = String(lv?.updatedAt || '');
  const rvts = String(rv?.updatedAt || '');
  if (lv && (!rv || lvts > rvts)) {
    out.vocabulary = lv;
  }

  // articles group-level LWW
  const la = localPayload?.articles;
  const ra = remotePayload?.articles;
  const lats = String(la?.updatedAt || '');
  const rats = String(ra?.updatedAt || '');
  if (la && (!ra || lats > rats)) {
    out.articles = la;
  }

  // qa group-level LWW
  const lq = localPayload?.qa;
  const rq = remotePayload?.qa;
  const lqts = String(lq?.updatedAt || '');
  const rqts = String(rq?.updatedAt || '');
  if (lq && (!rq || lqts > rqts)) {
    out.qa = lq;
  }

  // assistant group-level LWW
  const las = localPayload?.assistant;
  const ras = remotePayload?.assistant;
  const lasts = String(las?.updatedAt || '');
  const rasts = String(ras?.updatedAt || '');
  if (las && (!ras || lasts > rasts)) {
    out.assistant = las;
  }

  return out;
}
