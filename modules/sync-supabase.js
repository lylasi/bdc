// Supabase client + snapshot sync utilities (Scheme C)
// Uses RPC: get_snapshot(), save_snapshot(expected_version, p_payload)

import { SUPABASE } from '../ai-config.js';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { lwwMerge } from './sync-core.js';

export const supabase = createClient(SUPABASE.url, SUPABASE.anonKey, {
  auth: { persistSession: true, autoRefreshToken: true }
});

export const auth = supabase.auth;

export async function pullSnapshot() {
  const { data, error } = await supabase.rpc('get_snapshot');
  if (error) {
    // When no row exists, some Postgres versions might return empty result (data = []) rather than error
    // If error is non-null here, surface it.
    throw error;
  }
  // Supabase RPC returns an array of rows for SQL functions; normalize to the first row
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return null;
  return row; // { version, updated_at, payload }
}

export async function pushSnapshot(expectedVersion, payload) {
  const { data, error } = await supabase.rpc('save_snapshot', {
    expected_version: expectedVersion ?? 0,
    p_payload: payload
  });
  if (error) {
    if (error.code === '40001') return { conflict: true };
    throw error;
  }
  const row = Array.isArray(data) ? data[0] : data;
  const version = row?.version ?? row?.out_version ?? row?.v ?? 0;
  const updatedAt = row?.updated_at ?? row?.out_updated_at ?? row?.updatedAt ?? null;
  return { conflict: false, version, updatedAt };
}

// Heuristic: detect accidental local wipe (local empty, remote has data, and we've synced before)
function isLikelyAccidentalWipe(localPayload, remotePayload) {
  try {
    const lv = localPayload?.vocabulary, rv = remotePayload?.vocabulary;
    const la = localPayload?.articles,   ra = remotePayload?.articles;
    const lq = localPayload?.qa,         rq = remotePayload?.qa;

    const localEmpty = (
      (!lv || !Array.isArray(lv.books) || lv.books.length === 0) &&
      (!la || !Array.isArray(la.analyzedArticles) || la.analyzedArticles.length === 0) &&
      (!lq || !Array.isArray(lq.manifest) || lq.manifest.length === 0)
    );

    const remoteHas = (
      (rv && Array.isArray(rv.books) && rv.books.length > 0) ||
      (ra && Array.isArray(ra.analyzedArticles) && ra.analyzedArticles.length > 0) ||
      (rq && Array.isArray(rq.manifest) && rq.manifest.length > 0)
    );

    const lastVer = parseInt(localStorage.getItem('lastSnapshotVersion') || '0', 10) || 0;

    return lastVer > 0 && localEmpty && remoteHas;
  } catch (_) {
    return false;
  }
}

// High-level sync: pull → LWW merge → conditional push with expected_version
export async function syncNow(buildLocalSnapshot, applyMergedSnapshot) {
  const remote = await pullSnapshot();             // { version, updated_at, payload } | null
  const local = await buildLocalSnapshot();        // { payload, updatedAt }
  const baseVersion = remote?.version ?? 0;

  // Safety net: if local looks wiped but remote still has data and we had synced before,
  // treat this as pull-only to avoid wiping cloud data.
  if (remote && isLikelyAccidentalWipe(local.payload, remote.payload)) {
    await applyMergedSnapshot({ payload: remote.payload || {} });
    return { version: remote.version ?? 0, updatedAt: remote.updated_at ?? null };
  }

  // Group-level LWW for dictation via per-group updatedAt
  const merged = lwwMerge(local.payload, remote?.payload || {});

  const needPush = JSON.stringify(merged) !== JSON.stringify(remote?.payload || {});
  if (needPush) {
    const res = await pushSnapshot(baseVersion, merged);
    if (res.conflict) {
      const latest = await pullSnapshot();
      const merged2 = lwwMerge(local.payload, latest?.payload || {});
      const res2 = await pushSnapshot(latest?.version ?? 0, merged2);
      if (res2.conflict) throw new Error('同步衝突重試仍失敗');
      await applyMergedSnapshot({ payload: merged2 });
      return { version: res2.version ?? latest?.version ?? 0, updatedAt: res2.updatedAt ?? latest?.updated_at ?? null };
    }
    await applyMergedSnapshot({ payload: merged });
    return { version: res.version ?? baseVersion + 1, updatedAt: res.updatedAt ?? null };
  } else {
    // If remote differs from local (remote newer), apply it locally
    if (JSON.stringify(local.payload) !== JSON.stringify(merged)) {
      await applyMergedSnapshot({ payload: merged });
    }
    return { version: remote?.version ?? 0, updatedAt: remote?.updated_at ?? null };
  }
}

// Realtime subscription for snapshots row of current user
export function subscribeSnapshotChanges(userId, onChange) {
  try {
    const channel = supabase.channel('snapshots-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'snapshots', filter: `user_id=eq.${userId}` }, (payload) => {
        try { onChange && onChange(payload); } catch(_) {}
      })
      .subscribe((status) => {
        // console.log('[realtime] status:', status)
      });
    return channel;
  } catch (e) {
    console.warn('subscribeSnapshotChanges failed:', e);
    return null;
  }
}

export function unsubscribeChannel(ch) {
  try { if (ch) supabase.removeChannel(ch); } catch(_) {}
}
