// Minimal sync core for Supabase snapshot (Scheme C)
// Focus: userSettings.dictation only (group-level LWW via updatedAt)

import * as state from './state.js';

// Build a local snapshot payload
// Returns an object: { schemaVersion, updatedAt, payload }
export function buildLocalSnapshot() {
  // Ensure we read the latest dictationSettings from localStorage
  try { state.loadDictationSettings(); } catch (_) {}

  const dictation = state.dictationSettings || {};

  return {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    payload: {
      userSettings: {
        dictation
      }
    }
  };
}

// Apply merged snapshot (group-level LWW for dictation)
export async function applyMergedSnapshot(snapshot) {
  const remote = snapshot?.payload || {};
  const remoteDict = remote?.userSettings?.dictation;
  if (!remoteDict || typeof remoteDict !== 'object') return;

  const localDict = state.dictationSettings || {};
  const rts = String(remoteDict.updatedAt || '');
  const lts = String(localDict.updatedAt || '');

  // If remote dictation is newer (or local has no timestamp), adopt remote
  if (!lts || rts > lts) {
    const next = { ...localDict, ...remoteDict };
    state.setDictationSettings(next);
    state.saveDictationSettings();
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
  return out;
}

