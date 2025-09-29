// Minimal sync core for Supabase snapshot (Scheme C)
// Focus: userSettings.dictation only (group-level LWW via updatedAt)

import * as state from './state.js';
import { saveVocabularyBooks, saveAppState, saveAnalyzedArticles } from './storage.js';

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

// Build a local snapshot payload
// Returns an object: { schemaVersion, updatedAt, payload }
export async function buildLocalSnapshot() {
  // Ensure we read the latest dictationSettings from localStorage
  try { state.loadDictationSettings(); } catch (_) {}

  const dictation = state.dictationSettings || {};
  const vocabularyUpdatedAt = getLocalUpdatedAt('vocabularyUpdatedAt');
  const articlesUpdatedAt = getLocalUpdatedAt('articlesUpdatedAt');

  // QA group (user-created only)
  const qaManifest = (() => {
    try { return JSON.parse(localStorage.getItem('qa-sets') || '[]'); } catch(_) { return []; }
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
            try { out[id] = JSON.parse(raw); } catch(_) {}
          }
        }
      }
    } catch(_) {}
    return out;
  })();
  const qaUpdatedAt = getLocalUpdatedAt('qaUpdatedAt');

  return {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    payload: {
      userSettings: {
        dictation
      },
      vocabulary: {
        updatedAt: vocabularyUpdatedAt,
        books: state.vocabularyBooks,
        activeBookId: state.activeBookId
      },
      articles: {
        updatedAt: articlesUpdatedAt,
        analyzedArticles: state.analyzedArticles
      },
      qa: {
        updatedAt: qaUpdatedAt,
        manifest: qaManifest,
        sets: qaSets
      }
    }
  };
}

// Apply merged snapshot (group-level LWW for dictation)
export async function applyMergedSnapshot(snapshot) {
  const remote = snapshot?.payload || {};

  // dictation
  const remoteDict = remote?.userSettings?.dictation;
  if (remoteDict && typeof remoteDict === 'object') {
    const localDict = state.dictationSettings || {};
    const rts = String(remoteDict.updatedAt || '');
    const lts = String(localDict.updatedAt || '');
    if (!lts || rts > lts) {
      const next = { ...localDict, ...remoteDict };
      state.setDictationSettings(next);
      // preserve remote updatedAt to avoid false-dirty after apply
      state.saveDictationSettings(true /* preserveUpdatedAt */);
    }
  }

  // vocabulary (books + activeBookId)
  const remoteV = remote?.vocabulary;
  if (remoteV && typeof remoteV === 'object') {
    const lv = getLocalUpdatedAt('vocabularyUpdatedAt', false);
    const rts = String(remoteV.updatedAt || '');
    const lts = String(lv || '');
    if (!lts || rts > lts) {
      if (Array.isArray(remoteV.books)) {
        state.setVocabularyBooks(remoteV.books);
        saveVocabularyBooks({ preserveUpdatedAt: true, updatedAtOverride: remoteV.updatedAt });
      }
      if (remoteV.activeBookId !== undefined) {
        state.setActiveBookId(remoteV.activeBookId);
        saveAppState({ preserveUpdatedAt: true, updatedAtOverride: remoteV.updatedAt });
      }
    }
  }

  // analyzedArticles
  const remoteA = remote?.articles;
  if (remoteA && typeof remoteA === 'object') {
    const la = getLocalUpdatedAt('articlesUpdatedAt', false);
    const rts = String(remoteA.updatedAt || '');
    const lts = String(la || '');
    if (!lts || rts > lts) {
      if (Array.isArray(remoteA.analyzedArticles)) {
        state.setAnalyzedArticles(remoteA.analyzedArticles);
        saveAnalyzedArticles({ preserveUpdatedAt: true, updatedAtOverride: remoteA.updatedAt });
      }
    }
  }

  // QA
  const remoteQA = remote?.qa;
  if (remoteQA && typeof remoteQA === 'object') {
    const lqa = getLocalUpdatedAt('qaUpdatedAt', false);
    const rts = String(remoteQA.updatedAt || '');
    const lts = String(lqa || '');
    if (!lts || rts > lts) {
      try {
        // overwrite manifest
        if (Array.isArray(remoteQA.manifest)) {
          localStorage.setItem('qa-sets', JSON.stringify(remoteQA.manifest));
        }
        // overwrite sets
        const sets = remoteQA.sets || {};
        const ids = new Set(Object.keys(sets));
        // remove local sets not present remotely
        try {
          const localManifest = JSON.parse(localStorage.getItem('qa-sets') || '[]');
          if (Array.isArray(localManifest)) {
            for (const it of localManifest) {
              const id = it && it.id;
              if (id && !ids.has(id)) { try { localStorage.removeItem(`qa-set-${id}`); } catch(_) {} }
            }
          }
        } catch(_) {}
        for (const id of Object.keys(sets)) {
          try { localStorage.setItem(`qa-set-${id}`, JSON.stringify(sets[id])); } catch(_) {}
        }
        localStorage.setItem('qaUpdatedAt', remoteQA.updatedAt || new Date().toISOString());
      } catch (_) {}
    }
  }
}

// Trivial LWW for dictation group (placeholder for future per-key merge)
export function lwwMerge(localPayload, remotePayload) {
  const out = { ...(remotePayload || {}) };
  const l = localPayload?.userSettings?.dictation;
  const r = remotePayload?.userSettings?.dictation;
  const lts = String(l?.updatedAt || '');
  const rts = String(r?.updatedAt || '');

  if (l && (!r || lts > rts)) {
    out.userSettings = out.userSettings || {};
    out.userSettings.dictation = l;
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
  return out;
}
