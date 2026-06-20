// Cloudflare D1 + Worker 同步客戶端（取代 sync-supabase.js）
// 對外導出與舊檔同名接口：syncNow / auth / subscribeSnapshotChanges / unsubscribeChannel
// 認證：單一通行碼（Bearer token），資料按使用者隔離。
//
// 後端見 cloudflare-worker/；端點設定於 ai-config.js 的 SYNC.endpoint。

import { SYNC } from '../ai-config.js';
import { lwwMerge } from './sync-core.js';

const TOKEN_KEY = 'sync_token';
const USER_ID_KEY = 'sync_user_id';
const LABEL_KEY = 'sync_label';
const POLL_MS = 45000; // 輪詢間隔（取代 realtime）

function getEndpoint() {
  const url = (SYNC && SYNC.endpoint) ? String(SYNC.endpoint) : '';
  return url.replace(/\/+$/, '');
}

function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (_) { return ''; }
}

async function apiFetch(path, options = {}, tokenOverride) {
  const endpoint = getEndpoint();
  if (!endpoint) throw new Error('尚未設定同步端點（ai-config.js 的 SYNC.endpoint）');
  const token = tokenOverride || getToken();
  const headers = { ...(options.headers || {}) };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  if (options.body) headers['Content-Type'] = 'application/json';
  return fetch(endpoint + path, { ...options, headers });
}

// --- auth shim：對齊 supabase auth 的最小用法 ---
const _authCallbacks = [];

function emitAuth(event, user) {
  const session = user ? { user } : null;
  for (const cb of _authCallbacks) {
    try { cb(event, session); } catch (_) {}
  }
}

export const auth = {
  async getSession() {
    const token = getToken();
    let userId = '';
    let label = '';
    try {
      userId = localStorage.getItem(USER_ID_KEY) || '';
      label = localStorage.getItem(LABEL_KEY) || '';
    } catch (_) {}
    if (!token || !userId) return { data: { session: null } };
    return { data: { session: { user: { id: userId, email: label || userId } } } };
  },

  onAuthStateChange(cb) {
    if (typeof cb === 'function') _authCallbacks.push(cb);
    return {
      data: {
        subscription: {
          unsubscribe() {
            const i = _authCallbacks.indexOf(cb);
            if (i >= 0) _authCallbacks.splice(i, 1);
          }
        }
      }
    };
  },

  async signOut() {
    try {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_ID_KEY);
      localStorage.removeItem(LABEL_KEY);
    } catch (_) {}
    emitAuth('SIGNED_OUT', null);
    return { error: null };
  },

  // 通行碼登入：驗證後存 token + user_id，並廣播 SIGNED_IN
  async signInWithToken(token) {
    const code = String(token || '').trim();
    if (!code) throw new Error('請輸入通行碼');
    let res;
    try {
      res = await apiFetch('/me', { method: 'GET' }, code);
    } catch (e) {
      throw new Error(e?.message || '無法連線到同步服務');
    }
    if (res.status === 401) throw new Error('通行碼錯誤');
    if (!res.ok) throw new Error('登入失敗（' + res.status + '）');
    const data = await res.json().catch(() => ({}));
    const userId = data && data.user_id ? String(data.user_id) : '';
    if (!userId) throw new Error('伺服器未返回使用者');
    try {
      localStorage.setItem(TOKEN_KEY, code);
      localStorage.setItem(USER_ID_KEY, userId);
      localStorage.setItem(LABEL_KEY, data.label || '');
    } catch (_) {}
    const user = { id: userId, email: data.label || userId };
    emitAuth('SIGNED_IN', user);
    return { user_id: userId, label: data.label || '' };
  },

  // 已登入下修改自己的通行碼；成功後更新本機存的 token
  async changeToken(newToken) {
    const next = String(newToken || '').trim();
    if (next.length < 6) throw new Error('新通行碼至少 6 位');
    const res = await apiFetch('/change-token', {
      method: 'POST',
      body: JSON.stringify({ new_token: next })
    });
    if (res.status === 401) throw new Error('登入已失效，請重新登入');
    if (!res.ok) throw new Error('修改失敗（' + res.status + '）');
    try { localStorage.setItem(TOKEN_KEY, next); } catch (_) {}
    return true;
  },

  // 忘記通行碼：用 user_id + 恢復碼重置成新通行碼，並自動登入
  async resetToken(userId, recoveryCode, newToken) {
    const uid = String(userId || '').trim();
    const recovery = String(recoveryCode || '').trim();
    const next = String(newToken || '').trim();
    if (!uid || !recovery) throw new Error('請填寫使用者代號與恢復碼');
    if (next.length < 6) throw new Error('新通行碼至少 6 位');
    let res;
    try {
      res = await apiFetch('/reset-token', {
        method: 'POST',
        body: JSON.stringify({ user_id: uid, recovery_code: recovery, new_token: next })
      });
    } catch (e) {
      throw new Error(e?.message || '無法連線到同步服務');
    }
    if (res.status === 403) throw new Error('使用者代號或恢復碼錯誤');
    if (!res.ok) throw new Error('重置失敗（' + res.status + '）');
    // 重置成功後直接用新通行碼登入
    return this.signInWithToken(next);
  }
};

// --- snapshot pull / push ---
export async function pullSnapshot() {
  const res = await apiFetch('/snapshot', { method: 'GET' });
  if (res.status === 401) throw new Error('未授權，請重新登入');
  if (!res.ok) throw new Error('讀取雲端失敗（' + res.status + '）');
  const data = await res.json().catch(() => null);
  if (!data || data.version === undefined || data.version === null) return null;
  let payload = data.payload;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch (_) { payload = {}; }
  }
  return { version: data.version, updated_at: data.updated_at, payload: payload || {} };
}

export async function pushSnapshot(expectedVersion, payload) {
  const res = await apiFetch('/snapshot', {
    method: 'POST',
    body: JSON.stringify({ expected_version: expectedVersion ?? 0, payload })
  });
  if (res.status === 409) return { conflict: true };
  if (res.status === 401) throw new Error('未授權，請重新登入');
  if (!res.ok) throw new Error('寫入雲端失敗（' + res.status + '）');
  const data = await res.json().catch(() => ({}));
  return { conflict: false, version: data.version, updatedAt: data.updated_at };
}

// Heuristic: detect accidental local wipe (與 sync-supabase 一致)
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
  const remote = await pullSnapshot();          // { version, updated_at, payload } | null
  const local = await buildLocalSnapshot();     // { payload, updatedAt }
  const baseVersion = remote?.version ?? 0;

  if (remote && isLikelyAccidentalWipe(local.payload, remote.payload)) {
    await applyMergedSnapshot({ payload: remote.payload || {} });
    return { version: remote.version ?? 0, updatedAt: remote.updated_at ?? null, restoredFromRemote: true };
  }

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
    if (JSON.stringify(local.payload) !== JSON.stringify(merged)) {
      await applyMergedSnapshot({ payload: merged });
    }
    return { version: remote?.version ?? 0, updatedAt: remote?.updated_at ?? null };
  }
}

// --- 輪詢取代 realtime 訂閱 ---
// 介面對齊 supabase 版：傳入 (userId, onChange)，回傳可被 unsubscribeChannel 停止的 handle
export function subscribeSnapshotChanges(userId, onChange) {
  let stopped = false;
  let timer = null;

  const tick = async () => {
    if (stopped) return;
    try {
      const res = await apiFetch('/version', { method: 'GET' });
      if (res.ok) {
        const data = await res.json().catch(() => null);
        const remoteVer = data && typeof data.version === 'number' ? data.version : 0;
        const localVer = parseInt(localStorage.getItem('lastSnapshotVersion') || '0', 10) || 0;
        if (remoteVer > localVer) {
          try { onChange && onChange({ eventType: 'poll', version: remoteVer }); } catch (_) {}
        }
      }
    } catch (_) {
      // 網路抖動忽略，下一輪再試
    }
    if (!stopped) timer = setTimeout(tick, POLL_MS);
  };

  timer = setTimeout(tick, POLL_MS);
  return {
    stop() {
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
    }
  };
}

export function unsubscribeChannel(ch) {
  try { if (ch && typeof ch.stop === 'function') ch.stop(); } catch (_) {}
}
