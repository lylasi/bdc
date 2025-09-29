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
export function buildLocalSnapshot() {
  // Ensure we read the latest dictationSettings from localStorage
  try { state.loadDictationSettings(); } catch (_) {}

  const dictation = state.dictationSettings || {};
  const vocabularyUpdatedAt = getLocalUpdatedAt('vocabularyUpdatedAt');
  const articlesUpdatedAt = getLocalUpdatedAt('articlesUpdatedAt');

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
  return out;
}
