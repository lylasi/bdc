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

// 向伺服器確認更新的預設參數（可由 ai-config.js 的 SYNC.poll 覆寫；各欄位用途見 ai-config.example.js）
// baseMs：正常檢查間隔；maxMs：沒操作時自動拉長到的最慢間隔；
// pauseWhenHidden：切到背景分頁就停止檢查；pollOnFocus：回到頁面立刻檢查一次
const DEFAULT_POLL = { baseMs: 90000, maxMs: 300000, pauseWhenHidden: true, pollOnFocus: true };

function toInt(v, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

function getPollConfig() {
  const p = (SYNC && SYNC.poll) || {};
  const baseMs = Math.max(5000, toInt(p.baseMs, DEFAULT_POLL.baseMs));
  const maxMs = Math.max(baseMs, toInt(p.maxMs, DEFAULT_POLL.maxMs));
  return {
    baseMs,
    maxMs,
    pauseWhenHidden: p.pauseWhenHidden !== false,
    pollOnFocus: p.pollOnFocus !== false,
  };
}

function isHidden() {
  try { return typeof document !== 'undefined' && document.hidden === true; } catch (_) { return false; }
}

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

// --- 定時向伺服器確認其他裝置有沒有更新（取代 realtime 訂閱）---
// 介面對齊 supabase 版：傳入 (userId, onChange)，回傳可被 unsubscribeChannel 停止的 handle
// 行為：
//   - 切到背景分頁（document.hidden）時停止確認；回到前景立刻確認一次。
//   - 在前景但一直沒有操作時，間隔會從 baseMs 逐次加倍、最長到 maxMs，藉此少送請求。
//   - 一旦發現遠端有更新、或本機剛改過資料，間隔就馬上恢復成最短的 baseMs。
export function subscribeSnapshotChanges(userId, onChange) {
  const cfg = getPollConfig();
  let stopped = false;
  let timer = null;
  let inFlight = false;
  let curInterval = cfg.baseMs;

  const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };

  const schedule = (ms) => {
    clearTimer();
    if (stopped) return;
    if (cfg.pauseWhenHidden && isHidden()) return; // 切到背景就不再安排下一次檢查
    timer = setTimeout(tick, Math.max(0, ms));
  };

  // 把間隔縮回最短的 baseMs；pollNow 為 true 時立刻檢查一次，否則等一個 baseMs 後再檢查
  const resetToBase = (pollNow) => {
    curInterval = cfg.baseMs;
    schedule(pollNow ? 0 : curInterval);
  };

  async function tick() {
    timer = null;
    if (stopped || inFlight) return;
    if (cfg.pauseWhenHidden && isHidden()) return; // 保險：背景不發請求
    inFlight = true;
    let changed = false;
    try {
      const res = await apiFetch('/version', { method: 'GET' });
      if (res.ok) {
        const data = await res.json().catch(() => null);
        const remoteVer = data && typeof data.version === 'number' ? data.version : 0;
        const localVer = parseInt(localStorage.getItem('lastSnapshotVersion') || '0', 10) || 0;
        if (remoteVer > localVer) {
          changed = true;
          try { onChange && onChange({ eventType: 'poll', version: remoteVer }); } catch (_) {}
        }
      }
    } catch (_) {
      // 網路抖動忽略，下一輪再試
    } finally {
      inFlight = false;
    }
    if (stopped) return;
    // 有更新就把間隔縮回最短的 baseMs；沒更新就把間隔加倍（最長到 maxMs），藉此少送請求
    curInterval = changed ? cfg.baseMs : Math.min(cfg.maxMs, curInterval * 2);
    schedule(curInterval);
  }

  // 本機剛改過資料：代表使用者正在操作，把間隔縮回最短的 baseMs（不立刻送請求，上行交給既有 push 路徑）
  const onLocalChange = () => { if (!stopped) resetToBase(false); };
  // 切換分頁／視窗焦點：切到背景就停止，回到前景就立刻確認一次並把間隔縮回最短
  const onVisible = () => {
    if (stopped) return;
    if (isHidden()) { clearTimer(); return; }
    resetToBase(cfg.pollOnFocus);
  };

  try { window.addEventListener('bdc:data-changed', onLocalChange); } catch (_) {}
  try { document.addEventListener('visibilitychange', onVisible); } catch (_) {}
  try { if (cfg.pollOnFocus) window.addEventListener('focus', onVisible); } catch (_) {}

  // 起始：可見則照 base 排程，背景則等回前景再啟動
  schedule(curInterval);

  return {
    stop() {
      stopped = true;
      clearTimer();
      try { window.removeEventListener('bdc:data-changed', onLocalChange); } catch (_) {}
      try { document.removeEventListener('visibilitychange', onVisible); } catch (_) {}
      try { window.removeEventListener('focus', onVisible); } catch (_) {}
    }
  };
}

export function unsubscribeChannel(ch) {
  try { if (ch && typeof ch.stop === 'function') ch.stop(); } catch (_) {}
}
