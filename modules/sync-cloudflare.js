// Cloudflare D1 + Worker 同步客戶端（取代 sync-supabase.js）
// 對外導出與舊檔同名接口：syncNow / auth / subscribeSnapshotChanges / unsubscribeChannel
// 認證：高強度通行碼或裝置配對 session token（同為 Bearer），資料按使用者隔離。
//
// 後端見 cloudflare-worker/；端點設定於 ai-config.js 的 SYNC.endpoint。
// 測試頁可在模組載入前設定 globalThis.__BDC_SYNC_ENDPOINT__ 覆寫端點。

import { SYNC } from '../ai-config.js';
import { lwwMerge } from './sync-core.js';
import * as articleStore from './article-store.js';
import { t } from './i18n.js';

const TOKEN_KEY = 'sync_token';
const USER_ID_KEY = 'sync_user_id';
const LABEL_KEY = 'sync_label';
const ROLE_KEY = 'sync_role';

export const AUTH_EVENT = 'bdc:auth-change';
export const MIN_AI_PASSCODE_LENGTH = 32;

// Matches both legacy 12-character pairing codes and current 16-character
// login codes. Input may contain spaces or hyphens; normalize before testing.
export const LOGIN_CODE_RE = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12,32}$/;

export function normalizeLoginCode(value) {
  return String(value == null ? '' : value)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

let sessionGeneration = 0;
let loginAttempt = 0;
let authCapabilitiesPromise = null;
let authCapabilitiesCache = null;

function beginLoginAttempt() {
  loginAttempt += 1;
  return loginAttempt;
}

function assertLoginAttemptCurrent(attempt) {
  if (attempt !== loginAttempt) {
    throw authError('stale_login', t('errors.loginSuperseded'), 409);
  }
}

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
  const override = (typeof globalThis !== 'undefined' && typeof globalThis.__BDC_SYNC_ENDPOINT__ === 'string')
    ? globalThis.__BDC_SYNC_ENDPOINT__
    : '';
  const url = override || ((SYNC && SYNC.endpoint) ? String(SYNC.endpoint) : '');
  return url.replace(/\/+$/, '');
}

export function getSyncEndpoint() {
  return getEndpoint();
}

function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (_) { return ''; }
}

function getStoredUserId() {
  try { return localStorage.getItem(USER_ID_KEY) || ''; } catch (_) { return ''; }
}

function getStoredRole() {
  try { return localStorage.getItem(ROLE_KEY) || ''; } catch (_) { return ''; }
}

export function getAuthGeneration() {
  return sessionGeneration;
}

export function getStoredSyncUserId() {
  return getStoredUserId();
}

export function getAuthSnapshot() {
  const token = getToken();
  const userId = getStoredUserId();
  return {
    token,
    userId,
    label: (() => { try { return localStorage.getItem(LABEL_KEY) || ''; } catch (_) { return ''; } })(),
    role: getStoredRole() === 'admin' ? 'admin' : (userId ? 'user' : ''),
    endpoint: getEndpoint(),
    generation: sessionGeneration,
    loggedIn: !!(token && userId)
  };
}

/**
 * Ask the sync backend which login methods it supports. Older Workers and the
 * self-host server do not implement the endpoint; in that case login-code UI is
 * hidden instead of failing later. Network failures keep the UI available so a
 * temporary outage does not remove the only way to sign in.
 */
export function getAuthCapabilities({ force = false } = {}) {
  if (!force && authCapabilitiesPromise) return authCapabilitiesPromise;
  authCapabilitiesPromise = (async () => {
    let capabilities;
    try {
      const res = await apiRequest('/auth-capabilities', { method: 'GET' }, { token: '', timeoutMs: 6000 });
      if (res.status === 401 || res.status === 404) {
        capabilities = { pairingLogin: false, loginLinks: false, passwordLogin: false };
      } else if (!res.ok) {
        capabilities = { pairingLogin: true, loginLinks: true, passwordLogin: false };
      } else {
        const data = await res.json().catch(() => ({}));
        capabilities = {
          pairingLogin: data.pairingLogin !== false,
          loginLinks: data.loginLinks !== false,
          passwordLogin: data.passwordLogin === true,
          passwordMinLength: Number(data.passwordMinLength) || 10,
          adminPasswordMinLength: Number(data.adminPasswordMinLength) || 12
        };
      }
    } catch (_) {
      capabilities = { pairingLogin: true, loginLinks: true, passwordLogin: false };
    }
    authCapabilitiesCache = capabilities;
    return capabilities;
  })();
  return authCapabilitiesPromise;
}

/** Last resolved capabilities, or null before the first request finishes. */
export function getCachedAuthCapabilities() {
  return authCapabilitiesCache;
}

/**
 * Capture the identity of the session an async task starts in. Every async
 * task (credential download, credential sync, /me verification) must call
 * `isAuthSessionCurrent()` before it changes any session-wide state — in
 * particular before reacting to a 401, which would otherwise sign out a newer
 * account that logged in while the old request was still in flight.
 */
export function captureAuthSession() {
  const snapshot = getAuthSnapshot();
  return {
    endpoint: snapshot.endpoint,
    userId: snapshot.userId,
    token: snapshot.token,
    generation: snapshot.generation,
    loggedIn: snapshot.loggedIn
  };
}

export function isAuthSessionCurrent(session) {
  if (!session) return false;
  const snapshot = getAuthSnapshot();
  return session.generation === snapshot.generation
    && session.token === snapshot.token
    && session.userId === snapshot.userId
    && session.endpoint === snapshot.endpoint;
}

function authError(code, message, status) {
  const err = new Error(message || code);
  err.code = code;
  if (status) err.status = status;
  return err;
}

/**
 * Authenticated request with a 10s default timeout and generation capture.
 * Callers that write state must compare the returned generation afterwards.
 */
export async function apiRequest(path, options = {}, config = {}) {
  const endpoint = getEndpoint();
  if (!endpoint) throw authError('sync_endpoint_missing', t('errors.syncEndpointMissing'));
  const generation = sessionGeneration;
  const useToken = Object.prototype.hasOwnProperty.call(config, 'token')
    ? config.token
    : getToken();
  const headers = { ...(options.headers || {}) };
  if (useToken) headers['Authorization'] = 'Bearer ' + useToken;
  if (options.body) headers['Content-Type'] = 'application/json';

  const timeoutMs = typeof config.timeoutMs === 'number' ? config.timeoutMs : 10000;
  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => {
    try { controller.abort(new DOMException('Timeout', 'TimeoutError')); } catch (_) { controller.abort(); }
  }, timeoutMs) : null;
  const external = config.signal;
  const onAbort = () => controller.abort(external && external.reason);
  if (external) {
    if (external.aborted) controller.abort(external.reason);
    else external.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const response = await fetch(endpoint + path, {
      ...options,
      headers,
      signal: controller.signal,
      cache: 'no-store'
    });
    response.__bdcGeneration = generation;
    response.__bdcSession = captureAuthSession();
    return response;
  } catch (error) {
    if (error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      const err = authError(external && external.aborted ? 'client_aborted' : 'sync_timeout', 'sync timeout');
      err.aborted = !!(external && external.aborted);
      throw err;
    }
    throw authError('sync_unreachable', error && error.message ? error.message : 'sync unreachable');
  } finally {
    if (timer) clearTimeout(timer);
    if (external) external.removeEventListener('abort', onAbort);
  }
}

export async function verifySession() {
  const snapshot = getAuthSnapshot();
  if (!snapshot.loggedIn) throw authError('unauthorized', 'not logged in', 401);
  const session = captureAuthSession();
  const res = await apiRequest('/me', { method: 'GET' }, { timeoutMs: 10000, token: snapshot.token });
  if (res.status === 401) throw authError('unauthorized', 'invalid token', 401);
  if (!res.ok) throw authError('session_verify_failed', `HTTP ${res.status}`, res.status);
  const data = await res.json().catch(() => ({}));
  if (!data || !data.user_id) throw authError('session_verify_failed', 'no user', 500);
  // Never let an answer that belongs to an older account change the current one.
  if (!isAuthSessionCurrent(session)) throw authError('stale_session', 'session changed', 409);
  const role = data.role === 'admin' ? 'admin' : 'user';
  try { localStorage.setItem(ROLE_KEY, role); } catch (_) {}
  return {
    user: { id: String(data.user_id), role },
    role,
    generation: snapshot.generation
  };
}

// --- auth shim：對齊 supabase auth 的最小用法 ---
const _authCallbacks = [];

// Last identity this document has seen. Used to notice that *another* tab
// changed the login token or the account, which must lock shared keys and
// invalidate in-flight requests exactly like a same-tab switch.
let lastKnownIdentity = { token: '', userId: '' };

function readStoredIdentity() {
  return { token: getToken(), userId: getStoredUserId() };
}

function rememberIdentity() {
  lastKnownIdentity = readStoredIdentity();
  return lastKnownIdentity;
}

// Cross-tab sign-out / account switch. No key material is ever passed through
// storage events.
try {
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('storage', (event) => {
      if (!event || (event.key !== TOKEN_KEY && event.key !== USER_ID_KEY)) return;
      const next = readStoredIdentity();
      const previous = lastKnownIdentity || { token: '', userId: '' };
      if (!next.token) {
        if (!previous.token) return;
        lastKnownIdentity = next;
        sessionGeneration += 1;
        emitAuth(getStoredUserId() ? 'SESSION_INVALID' : 'SIGNED_OUT', null);
        return;
      }
      if (next.token === previous.token && next.userId === previous.userId) return;
      lastKnownIdentity = next;
      sessionGeneration += 1;
      if (next.userId && previous.userId && previous.userId !== next.userId) {
        emitAuth('ACCOUNT_CHANGED', { id: next.userId, email: next.userId, role: getStoredRole() || 'user' });
      } else {
        // Same account, new passcode (e.g. changed in another tab): re-verify,
        // but keep the account profile.
        emitAuth('SIGNED_IN', { id: next.userId, email: next.userId, role: getStoredRole() || 'user' });
      }
    });
  }
} catch (_) {}

rememberIdentity();

function detectDeviceLabel() {
  try {
    const nav = typeof navigator !== 'undefined' ? navigator : null;
    return String((nav && (nav.platform || nav.userAgent)) || '').slice(0, 80);
  } catch (_) {
    return '';
  }
}

function commitSession(token, data) {
  const userId = data && data.user_id ? String(data.user_id) : '';
  if (!userId) throw new Error(t('errors.serverNoUser'));
  const role = data.role === 'admin' ? 'admin' : 'user';
  const previousUser = getStoredUserId();
  let previous = null;
  sessionGeneration += 1;
  try {
    previous = {
      token: localStorage.getItem(TOKEN_KEY),
      userId: localStorage.getItem(USER_ID_KEY),
      label: localStorage.getItem(LABEL_KEY),
      role: localStorage.getItem(ROLE_KEY)
    };
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_ID_KEY, userId);
    localStorage.setItem(LABEL_KEY, data.label || '');
    localStorage.setItem(ROLE_KEY, role);
  } catch (_) {
    // Never leave a half-written session behind: it would look logged in on
    // the next request but carry a token from a different storage operation.
    try {
      if (previous) {
        for (const [key, value] of [[TOKEN_KEY, previous.token], [USER_ID_KEY, previous.userId], [LABEL_KEY, previous.label], [ROLE_KEY, previous.role]]) {
          if (value == null) localStorage.removeItem(key);
          else localStorage.setItem(key, value);
        }
      } else {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USER_ID_KEY);
        localStorage.removeItem(LABEL_KEY);
        localStorage.removeItem(ROLE_KEY);
      }
    } catch (_) {}
    throw new Error(t('errors.loginStorageFailed'));
  }
  const user = { id: userId, email: data.label || userId, role };
  rememberIdentity();
  emitAuth(previousUser && previousUser !== userId ? 'ACCOUNT_CHANGED' : 'SIGNED_IN', user);
  return { user_id: userId, label: data.label || '', role };
}

function emitAuth(event, user) {
  const session = user ? { user } : null;
  for (const cb of _authCallbacks) {
    try { cb(event, session); } catch (_) {}
  }
  try {
    window.dispatchEvent(new CustomEvent(AUTH_EVENT, { detail: { event, user: user || null, generation: sessionGeneration } }));
  } catch (_) {}
}

export const auth = {
  async getSession() {
    const token = getToken();
    const userId = getStoredUserId();
    let label = '';
    try { label = localStorage.getItem(LABEL_KEY) || ''; } catch (_) {}
    if (!token || !userId) return { data: { session: null } };
    return { data: { session: { user: { id: userId, email: label || userId, role: getStoredRole() || 'user' } } } };
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
    sessionGeneration += 1;
    try {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_ID_KEY);
      localStorage.removeItem(LABEL_KEY);
      localStorage.removeItem(ROLE_KEY);
    } catch (_) {}
    rememberIdentity();
    emitAuth('SIGNED_OUT', null);
    return { error: null };
  },

  /**
   * The server rejected the token (401). Unlike an explicit sign-out this keeps
   * the account identity so the local AI profile (personal providers + keys)
   * keeps working offline. Only the rejected token and role are removed.
   */
  async invalidateSession() {
    sessionGeneration += 1;
    try {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(ROLE_KEY);
    } catch (_) {}
    rememberIdentity();
    emitAuth('SESSION_INVALID', null);
    return { error: null };
  },

  // 通行碼登入：驗證後存 token + user_id，並廣播 SIGNED_IN
  async signInWithToken(token) {
    const code = String(token || '').trim();
    if (!code) throw new Error(t('errors.passcodeRequired'));
    const attempt = beginLoginAttempt();
    let res;
    try {
      res = await apiRequest('/me', { method: 'GET' }, { token: code });
    } catch (e) {
      throw new Error(e?.message || t('errors.cannotReachSync'));
    }
    if (res.status === 401) throw new Error(t('errors.passcodeWrong'));
    if (!res.ok) throw new Error(t('errors.loginFailed', { status: res.status }));
    const data = await res.json().catch(() => ({}));
    assertLoginAttemptCurrent(attempt);
    return commitSession(code, data);
  },

  // 使用者名稱＋密碼登入：後端驗證 PBKDF2 雜湊後發放長期 session token。
  async signInWithPassword(username, password) {
    const user = String(username == null ? '' : username).trim();
    const pass = String(password == null ? '' : password);
    if (!user) throw authError('username_required', t('errors.usernameRequired'));
    if (!pass) throw authError('password_required', t('errors.passwordRequired'));
    const attempt = beginLoginAttempt();
    let res;
    try {
      res = await apiRequest('/login', {
        method: 'POST',
        body: JSON.stringify({ username: user, password: pass, deviceLabel: detectDeviceLabel() })
      }, { token: '', timeoutMs: 15000 });
    } catch (e) {
      throw new Error(e?.message || t('errors.cannotReachSync'));
    }
    if (res.status === 401) throw authError('invalid_credentials', t('errors.invalidCredentials'), 401);
    if (res.status === 403) throw authError('account_disabled', t('errors.accountDisabled'), 403);
    if (res.status === 429) throw authError('rate_limited', t('errors.loginRateLimited'), 429);
    if (res.status === 503) throw authError('password_not_configured', t('errors.passwordNotConfigured'), 503);
    if (!res.ok) throw new Error(t('errors.loginFailed', { status: res.status }));
    const data = await res.json().catch(() => ({}));
    if (!data || !data.token) throw new Error(t('errors.loginFailed', { status: res.status }));
    assertLoginAttemptCurrent(attempt);
    return commitSession(String(data.token), data);
  },

  // 登入碼登入：使用者只需輸入管理員產生的一次性登入碼；後端由碼查出帳號。
  // 不影響原本通行碼，其他已登入裝置也不會被登出。
  async signInWithLoginCode(loginCode) {
    const code = normalizeLoginCode(loginCode);
    if (!code) throw authError('pairing_required', t('errors.pairingRequired'));
    if (!LOGIN_CODE_RE.test(code)) throw authError('pairing_format', t('errors.pairingFormat'));
    const attempt = beginLoginAttempt();
    let res;
    try {
      res = await apiRequest('/pair', {
        method: 'POST',
        body: JSON.stringify({ code, deviceLabel: detectDeviceLabel() })
      }, { token: '', timeoutMs: 10000 });
    } catch (e) {
      throw new Error(e?.message || t('errors.cannotReachSync'));
    }
    if (res.status === 403) throw authError('pairing_invalid', t('errors.pairingInvalid'), 403);
    if (res.status === 429) throw authError('rate_limited', t('errors.pairingRateLimited'), 429);
    if (!res.ok) throw new Error(t('errors.pairingFailed', { status: res.status }));
    const data = await res.json().catch(() => ({}));
    if (!data || !data.token) throw new Error(t('errors.pairingFailed', { status: res.status }));
    assertLoginAttemptCurrent(attempt);
    return commitSession(String(data.token), data);
  },

  // 裝置配對登入（v1 相容）：保留 userId 欄位；新流程請用 signInWithLoginCode。
  async signInWithPairingCode(userId, pairingCode) {
    const uid = String(userId || '').trim();
    const code = normalizeLoginCode(pairingCode);
    if (!uid || !code) throw authError('pairing_required', t('errors.pairingRequired'));
    if (!LOGIN_CODE_RE.test(code)) throw authError('pairing_format', t('errors.pairingFormat'));
    const attempt = beginLoginAttempt();
    let res;
    try {
      res = await apiRequest('/pair', {
        method: 'POST',
        body: JSON.stringify({ userId: uid, code, deviceLabel: detectDeviceLabel() })
      }, { token: '', timeoutMs: 10000 });
    } catch (e) {
      throw new Error(e?.message || t('errors.cannotReachSync'));
    }
    if (res.status === 403) throw authError('pairing_invalid', t('errors.pairingInvalid'), 403);
    if (res.status === 429) throw authError('rate_limited', t('errors.pairingRateLimited'), 429);
    if (!res.ok) throw new Error(t('errors.pairingFailed', { status: res.status }));
    const data = await res.json().catch(() => ({}));
    if (!data || !data.token) throw new Error(t('errors.pairingFailed', { status: res.status }));
    assertLoginAttemptCurrent(attempt);
    return commitSession(String(data.token), data);
  },

  // 已登入下修改自己的通行碼；成功後更新本機存的 token
  async changeToken(newToken) {
    const next = String(newToken || '').trim();
    if (next.length < MIN_AI_PASSCODE_LENGTH) throw authError('weak_passcode', t('errors.passcodeTooShort'));
    const res = await apiRequest('/change-token', {
      method: 'POST',
      body: JSON.stringify({ new_token: next })
    });
    if (res.status === 401) throw new Error(t('errors.loginExpired'));
    if (res.status === 400) throw new Error(t('errors.passcodeTooShort'));
    if (!res.ok) throw new Error(t('errors.changeFailed', { status: res.status }));
    // A new passcode invalidates anything still in flight under the old one.
    sessionGeneration += 1;
    try { localStorage.setItem(TOKEN_KEY, next); } catch (_) {}
    rememberIdentity();
    return true;
  },

  // 已登入下修改自己的密碼；目前 session 保持有效，其他裝置立即失效。
  async changePassword(currentPassword, newPassword) {
    const current = String(currentPassword == null ? '' : currentPassword);
    const next = String(newPassword == null ? '' : newPassword);
    if (!current) throw authError('password_required', t('errors.passwordRequired'));
    if (!next) throw authError('password_required', t('errors.passwordRequired'));
    let res;
    try {
      res = await apiRequest('/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: current, newPassword: next })
      });
    } catch (e) {
      throw new Error(e?.message || t('errors.cannotReachSync'));
    }
    if (res.status === 401) throw authError('unauthorized', t('errors.loginExpired'), 401);
    if (res.status === 403) throw authError('invalid_current_password', t('errors.invalidCurrentPassword'), 403);
    if (res.status === 409) throw authError('password_not_set', t('errors.passwordNotSet'), 409);
    if (res.status === 503) throw authError('password_not_configured', t('errors.passwordNotConfigured'), 503);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      if (data.code === 'weak_password') throw authError('weak_password', t('errors.weakPassword'), 400);
      if (data.code === 'invalid_password') throw authError('invalid_password', t('errors.passwordInvalid'), 400);
      throw new Error(t('errors.changeFailed', { status: res.status }));
    }
    return true;
  },

  // 忘記通行碼：用 user_id + 恢復碼重置成新通行碼，並自動登入
  async resetToken(userId, recoveryCode, newToken) {
    const uid = String(userId || '').trim();
    const recovery = String(recoveryCode || '').trim();
    const next = String(newToken || '').trim();
    if (!uid || !recovery) throw new Error(t('errors.recoveryRequired'));
    if (next.length < MIN_AI_PASSCODE_LENGTH) throw authError('weak_passcode', t('errors.passcodeTooShort'));
    let res;
    try {
      res = await apiRequest('/reset-token', {
        method: 'POST',
        body: JSON.stringify({ user_id: uid, recovery_code: recovery, new_token: next })
      }, { token: '' });
    } catch (e) {
      throw new Error(e?.message || t('errors.cannotReachSync'));
    }
    if (res.status === 403) throw new Error(t('errors.recoveryWrong'));
    if (res.status === 400) throw new Error(t('errors.passcodeTooShort'));
    if (!res.ok) throw new Error(t('errors.resetFailed', { status: res.status }));
    // 重置成功後直接用新通行碼登入
    return this.signInWithToken(next);
  }
};

// --- snapshot pull / push ---
export async function pullSnapshot() {
  const res = await apiRequest('/snapshot', { method: 'GET' }, { timeoutMs: 15000 });
  if (res.status === 401) {
    const err = new Error(t('errors.unauthorized'));
    err.code = 'unauthorized';
    throw err;
  }
  if (!res.ok) throw new Error(t('errors.cloudReadFailed', { status: res.status }));
  const data = await res.json().catch(() => null);
  if (!data || data.version === undefined || data.version === null) return null;
  let payload = data.payload;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch (_) { payload = {}; }
  }
  return { version: data.version, updated_at: data.updated_at, payload: payload || {} };
}

export async function pushSnapshot(expectedVersion, payload) {
  const res = await apiRequest('/snapshot', {
    method: 'POST',
    body: JSON.stringify({ expected_version: expectedVersion ?? 0, payload })
  }, { timeoutMs: 20000 });
  if (res.status === 409) {
    // 409 有多種意思：一般是版本衝突，但「帳戶已改用逐篇文章儲存」要讓呼叫端
    // 顯示不同的處理方式，不能一律當成重試衝突。
    const body = await res.json().catch(() => null);
    const code = body && body.code ? String(body.code) : '';
    if (code === 'articles_legacy_write_blocked' || (body && body.upgradeRequired)) {
      return { conflict: true, code: code || 'client_upgrade_required', upgradeRequired: true };
    }
    return { conflict: true, code, version: body && Number.isInteger(body.version) ? body.version : undefined };
  }
  if (res.status === 401) {
    const err = new Error(t('errors.unauthorized'));
    err.code = 'unauthorized';
    throw err;
  }
  if (!res.ok) throw new Error(t('errors.cloudWriteFailed', { status: res.status }));
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

/** 舊文章資料尚未全部匯入 /articles 之前，快照必須保留遠端文章群組。 */
function needsLegacyArticlePassthrough() {
  try {
    return !articleStore.isMigrated() || articleStore.getGatePending();
  } catch (_) {
    return true;
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
  // 文章還沒完成遷移（本機或雲端舊資料尚未匯入）之前，保留雲端快照裡的文章群組，
  // 避免第一次推快照就把它刪掉。遷移完成、伺服器閘門開啟後就不再附帶。
  if (needsLegacyArticlePassthrough() && remote?.payload?.articles) {
    merged.articles = remote.payload.articles;
  }
  const needPush = JSON.stringify(merged) !== JSON.stringify(remote?.payload || {});

  if (needPush) {
    const res = await pushSnapshot(baseVersion, merged);
    if (res.conflict) {
      const latest = await pullSnapshot();
      const merged2 = lwwMerge(local.payload, latest?.payload || {});
      const res2 = await pushSnapshot(latest?.version ?? 0, merged2);
      if (res2.conflict) throw new Error(t('errors.syncConflict'));
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
      const res = await apiRequest('/version', { method: 'GET' }, { timeoutMs: 10000 });
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
