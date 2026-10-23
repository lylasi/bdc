// Minimal UI wiring for Cloudflare D1 + Worker sync (Scheme C)
// Provides: Login (single passcode), Logout, and "Sync Now" button

import * as dom from '../../modules/dom.js';
import * as state from '../../modules/state.js';
import { buildLocalSnapshot, applyMergedSnapshot, restoreSnapshotLocally } from '../../modules/sync-core.js';
import { syncReading } from '../../modules/reading-sync.js';
import * as readingStore from '../../modules/reading-store.js';
import * as cache from '../../modules/cache.js';
import {
  syncNow,
  auth,
  subscribeSnapshotChanges,
  unsubscribeChannel,
  getAuthGeneration,
  getStoredSyncUserId,
  getAuthSnapshot,
  getAuthCapabilities,
  getCachedAuthCapabilities,
  normalizeLoginCode,
  LOGIN_CODE_RE,
  beginSyncRound,
  endSyncRound
} from '../../modules/sync-cloudflare.js';
import * as ui from '../../modules/ui.js';
import {
  loadGlobalSettings,
  loadGlobalSecrets,
  saveGlobalSettings,
  saveGlobalSecrets
} from '../../modules/settings.js';
import { mountAIProviderSettings } from './ai-provider-settings.js';
import { openAdminUsersPanel } from '../admin-users/admin-users.js';
import { getCredentialSyncState } from '../../modules/ai-credential-sync.js';
import { THEMES, applyTheme, getSavedTheme } from '../../modules/theme.js';
import {
  getArtSettings,
  saveArtSettings,
  applyArtSettings,
  applyThemeArt,
  getThemeArtMeta,
  getThemeDefaultArt,
  setThemeArtFromFile,
  removeThemeArt,
  getThemeIconMeta,
  setThemeIconFromFile,
  removeThemeIcon
} from '../../modules/theme-art.js';
import { openDictationGradingHistory } from '../dictation/dictation-grader.js';
import {
  listAssistantConversationMetas,
  getAssistantConversationMessages,
  createAssistantConversation,
  renameAssistantConversation,
  deleteAssistantConversation
} from '../assistant/assistant.js';
import * as backup from '../../modules/local-backup.js';
import * as articleStore from '../../modules/article-store.js';
import { syncArticles } from '../../modules/article-sync.js';
import { markdownToHtml } from '../../modules/markdown.js';
import { resolveSyncCompletion } from './sync-status.js';
import { getLocale, setLocale, t, formatDateTime } from '../../modules/i18n.js';
import { SUPPORTED_LOCALES } from '../../modules/i18n-config.js';

let aiProviderController = null;

// A login link is captured synchronously during startup and exchanged after
// auth callbacks are wired. It never survives a reload: the fragment is
// stripped immediately so it does not leak through history, screenshots or
// referrers.
const PENDING_MERGE_KEY = 'sync_pending_merge_user';
let pendingLoginCode = '';
let pendingLoginInvalid = false;
let suppressAutoSyncForLoginLink = false;
let loginLinkBusy = false;
// Set when a login-link sign-in chose "only sign in" on a device that already
// has local learning data. Auto-sync stays paused until the user explicitly
// confirms a merge, including after a reload.
let pendingMergePaused = false;

function destroyAIProviderSettings() {
  try { aiProviderController?.destroy(); } catch (_) {}
  aiProviderController = null;
}

export function initSync() {
  try {
    console.log('[sync] initSync()');
    // Warm the capability cache so the login modal and gear menu can decide
    // synchronously whether username/password login is available.
    getAuthCapabilities().catch(() => {});
    pendingMergePaused = isPendingMergeForCurrentUser();
    if (pendingMergePaused) {
      try { ui.displayMessage(t('sync.mergePendingStatus'), 'warning', 8000); } catch (_) {}
    }
    document.addEventListener('bdc:modal-closed', destroyAIProviderSettings);
    wireAuthUI();
    if (dom.syncNowBtn) {
      dom.syncNowBtn.addEventListener('click', handleSync);
    } else {
      console.warn('[sync] syncNowBtn not found');
    }
    // Floating gear menu
    if (dom.appGearBtn) {
      dom.appGearBtn.addEventListener('click', toggleGearMenu);
    }
    document.addEventListener('click', (e) => {
      const m = document.getElementById('gear-menu');
      if (!m) return;
      if (e.target === dom.appGearBtn || dom.appGearBtn.contains(e.target)) return;
      if (m.contains(e.target)) return;
      m.remove();
    });
    // ESC 關閉齒輪選單（與手機版「更多」抽屜一致）
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const m = document.getElementById('gear-menu');
      if (m) m.remove();
    });
    // Auto-sync: listen to data change signals
    window.addEventListener('bdc:data-changed', (e) => {
      const g = e?.detail?.group || 'unknown';
      console.log('[sync] data changed:', g);
      scheduleAutoSync('data:' + g);
    });
  } catch (e) {
    console.error('[sync] init failed:', e);
  }
}

function wireAuthUI() {
  console.log('[sync] wireAuthUI()', { loginBtn: !!dom.loginBtn, logoutBtn: !!dom.logoutBtn, syncNowBtn: !!dom.syncNowBtn });
  if (dom.loginBtn) dom.loginBtn.addEventListener('click', async () => {
    showLoginModal();
  });

  if (dom.logoutBtn) dom.logoutBtn.addEventListener('click', handleLogout);

  auth.onAuthStateChange((event, session) => {
    const user = session?.user || null;
    try { window.__supabase_user = user || null; } catch(_) {}
    updateAuthButtons(user);
    updateStatus(user ? (user.email || t('sync.loggedIn')) : t('sync.loggedOutState'));
    attachRealtime(user);
    setGearLoginState(!!user, user?.email || '');
    if (!user) {
      clearPendingMerge();
      return;
    }
    const pendingUser = readPendingMergeUser();
    if (pendingUser && pendingUser !== user.id) clearPendingMerge();
    if (readPendingMergeUser() === user.id && !hasMeaningfulLocalData()) clearPendingMerge();
    pendingMergePaused = readPendingMergeUser() === user.id;
    if (pendingMergePaused) {
      updateStatus(t('sync.mergePendingStatus'));
      return;
    }
    if (!suppressAutoSyncForLoginLink && !pendingLoginCode) {
      try { scheduleAutoSync('login'); } catch(_) {}
    }
  });

  refreshArticleScope().catch(() => {});

  // 初始化一次（避免等待事件）
  auth.getSession().then(({ data }) => {
    const user = data?.session?.user || null;
    try { window.__supabase_user = user || null; } catch(_) {}
    updateAuthButtons(user);
    updateStatus(user ? (user.email || t('sync.loggedIn')) : t('sync.loggedOutState'));
    attachRealtime(user);
    setGearLoginState(!!user, user?.email || '');
    if (!user) return;
    const pendingUser = readPendingMergeUser();
    if (pendingUser && pendingUser !== user.id) clearPendingMerge();
    if (readPendingMergeUser() === user.id && !hasMeaningfulLocalData()) clearPendingMerge();
    pendingMergePaused = readPendingMergeUser() === user.id;
    if (pendingMergePaused) {
      updateStatus(t('sync.mergePendingStatus'));
      return;
    }
    if (!suppressAutoSyncForLoginLink && !pendingLoginCode) {
      try { scheduleAutoSync('init-session'); } catch(_) {}
    }
  }).catch(() => {});
}

function generateStrongPasscode() {
  const bytes = new Uint8Array(32);
  try { crypto.getRandomValues(bytes); } catch (_) {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function handleLogout() {
  const sync = getCredentialSyncState();
  const hasUnsynced = sync.pending.length > 0 || sync.conflicts.length > 0;
  if (hasUnsynced) {
    const ok = await ui.confirmAction({
      title: t('sync.logout'),
      message: t('sync.logoutUnsynced'),
      confirmLabel: t('sync.logoutConfirm'),
      cancelLabel: t('settings.cancel'),
      danger: true
    });
    if (!ok) return;
  }
  try { await auth.signOut(); } catch (_) {}
  clearPendingMerge();
  updateAuthButtons(null);
  updateStatus(t('sync.loggedOut'));
}

function createSyncGuard() {
  const userId = getStoredSyncUserId();
  const generation = getAuthGeneration();
  const stale = () => getAuthGeneration() !== generation || getStoredSyncUserId() !== userId;
  return {
    stale,
    build: async () => {
      if (stale()) {
        const err = new Error('stale session');
        err.code = 'stale_session';
        throw err;
      }
      return buildLocalSnapshot();
    },
    apply: async (snapshot) => {
      if (stale()) return;
      await applyMergedSnapshot(snapshot);
    }
  };
}

/** 文章儲存範圍（endpoint + user）切換後重新載入，並通知文章模組清空目前畫面。 */
const GUEST_ADOPT_ASKED_KEY = 'bdc:articles:guest-adopt-asked';
const GUEST_READING_ADOPT_ASKED_KEY = 'bdc:reading:guest-adopt-asked';

async function refreshArticleScope({ offerGuestMerge = false } = {}) {
  const result = await articleStore.refreshScope();
  try { await readingStore.reloadReadingScope(); } catch (_) {}
  if (result && result.changed) {
    try { document.dispatchEvent(new CustomEvent('bdc:articles-scope-changed')); } catch (_) {}
  }
  if (offerGuestMerge && !articleStore.isGuestScope()) {
    try { await offerGuestArticleMerge(); } catch (_) {}
    try { await offerGuestReadingMerge(); } catch (_) {}
  }
  return result;
}

/**
 * 登入後，訪客範圍若有文章，明確詢問是否帶入目前帳戶。
 * 不做隱式歸屬：使用者不確認就不會上傳 (IMPL: 文章逐篇儲存第一階段)。
 */
async function offerGuestArticleMerge() {
  let asked = '';
  try { asked = localStorage.getItem(GUEST_ADOPT_ASKED_KEY) || ''; } catch (_) {}
  const userId = getStoredSyncUserId();
  if (asked === userId) return;
  const count = await articleStore.guestArticleCount();
  if (!count) return;
  try { localStorage.setItem(GUEST_ADOPT_ASKED_KEY, userId); } catch (_) {}
  const ok = await ui.confirmAction({
    title: t('sync.guestArticlesTitle'),
    message: t('sync.guestArticlesMessage', { count }),
    confirmLabel: t('sync.guestArticlesConfirm'),
    cancelLabel: t('sync.guestArticlesSkip')
  });
  if (!ok) return;
  const result = await articleStore.adoptGuestArticles();
  if (result && result.ok) {
    ui.displayMessage(t('sync.guestArticlesMerged', { count: result.imported }), 'success', 3000);
    try { document.dispatchEvent(new CustomEvent('bdc:articles-scope-changed')); } catch (_) {}
    try { scheduleAutoSync('articles:guest-adopt'); } catch (_) {}
  } else {
    ui.displayMessage(t('sync.articleSyncFailed'), 'error');
  }
}

async function offerGuestReadingMerge() {
    if (articleStore.isGuestScope()) return;
    const userId = getStoredSyncUserId();
    let asked = '';
    try { asked = localStorage.getItem(GUEST_READING_ADOPT_ASKED_KEY) || ''; } catch (_) {}
    if (asked === userId) return;
    const counts = await readingStore.guestReadingCounts();
    const total = counts.books + counts.entries + counts.conversations + counts.messages + counts.items + counts.documents;
    if (!total) return;
    try { localStorage.setItem(GUEST_READING_ADOPT_ASKED_KEY, userId); } catch (_) {}
    const ok = await ui.confirmAction({
        title: t('sync.guestReadingTitle'),
        message: t('sync.guestReadingMessage', { books: counts.books, items: counts.items, messages: counts.messages }),
        confirmLabel: t('sync.guestReadingConfirm'),
        cancelLabel: t('sync.guestReadingSkip')
    });
    if (!ok) return;
    const result = await readingStore.adoptGuestReadingData();
    if (result && result.ok) {
        ui.displayMessage(t('sync.guestReadingMerged', { count: result.imported || 0 }), 'success', 3000);
        document.dispatchEvent(new CustomEvent('bdc:reading-change', { detail: {} }));
        try { scheduleAutoSync('reading:guest-adopt'); } catch (_) {}
    } else {
        ui.displayMessage(t('sync.readingPending'), 'error');
    }
}

/**
 * 文章同步是一個獨立階段：即使快照沒有任何變更也要執行，失敗也不阻斷其他群組。
 * 回傳 `{ ok, info, pending, failed, conflicts }` 或 `{ ok:false, error, ... }`，
 * 不拋出（除了 stale session）。`pending` 代表這一輪仍有單篇失敗／衝突，
 * 完成狀態不得顯示 `syncDone`。
 */
async function runArticleSyncPhase() {
  try {
    const info = await syncArticles();
    // syncArticles() 以 `{ ok:false, error }` 回報失敗（不拋出）：這一階段必須
    // 把失敗往上傳，否則呼叫端會把「文章其實沒同步」顯示成同步完成。
    if (info && info.ok === false) {
      updateStatus(t('sync.articleSyncFailed'));
      const failed = Number(info?.pushed?.failed) || 0;
      const conflicts = Number(info?.pushed?.conflicts) || 0;
      return { ok: false, error: (info && info.error) || 'article_sync_failed', info, pending: false, failed, conflicts };
    }
    // 單篇失敗／衝突時 syncArticles() 仍是 ok:true（整體流程完成），但這一輪
    // 並沒有全部推上去；明確回報 pending，讓完成狀態不要顯示 syncDone。
    const failed = Number(info?.pushed?.failed) || 0;
    const conflicts = Number(info?.pushed?.conflicts) || 0;
    const pending = failed > 0 || conflicts > 0;
    if (pending) {
      updateStatus(t('sync.articleSyncPending'));
    }
    return { ok: true, info, pending, failed, conflicts };
  } catch (e) {
    if (e && e.code === 'stale_session') throw e;
    if (e && e.code === 'unauthorized') throw e;
    console.warn('[sync] article sync failed:', e && (e.code || e.message));
    return { ok: false, error: e, pending: false, failed: 0, conflicts: 0 };
  }
}

/**
 * 逐項閱讀資料同步：文章同步之後、快照之前。後端尚未支援時只回報
 * 「需要更新服務端」，本機功能與快照其他群組仍照常運作。
 */
let readingServerUpdateWarned = false;
async function runReadingSyncPhase() {
  try {
    const info = await syncReading();
    if (info && info.unsupported) {
      if (!readingServerUpdateWarned) {
        readingServerUpdateWarned = true;
        try { ui.displayMessage(t('sync.readingServerUpdateRequired'), 'warning', 7000); } catch (_) {}
      }
      updateStatus(t('sync.readingServerUpdateRequired'));
      return { ok: false, error: { code: 'server_update_required' }, info };
    }
    if (info && (info.pending || info.conflictCount)) {
      updateStatus(t('sync.readingPending'));
    }
    return { ok: true, info };
  } catch (e) {
    if (e && (e.code === 'stale_session' || e.code === 'unauthorized')) throw e;
    console.warn('[sync] reading sync failed:', e && (e.code || e.message));
    return { ok: false, error: e };
  }
}

async function handleSync() {
  // 必須登入後才能同步
  const { data } = await auth.getSession();
  if (!data?.session) {
    updateStatus(t('sync.loginFirst'));
    ui.displayMessage(t('sync.loginFirst'), 'warning');
    return;
  }

  // Auto-sync is paused after a login-link sign-in that skipped merging local
  // data. A manual "Sync now" is the explicit consent to merge.
  if (isPendingMergeForCurrentUser()) {
    const current = getAuthSnapshot();
    const ok = await ui.confirmAction({
      title: t('sync.mergePendingTitle'),
      message: t('sync.mergePendingMessage', { user: current.label || current.userId }),
      confirmLabel: t('sync.mergePendingConfirm'),
      cancelLabel: t('settings.cancel')
    });
    if (!ok) return;
    clearPendingMerge();
  }

  let guard = null;
  try {
    setBusy(true);
    beginSyncRound();
    updateStatus(t('sync.syncing'));
    guard = createSyncGuard();
    // 先跑文章同步：舊快照裡的文章群組必須先匯入逐篇儲存，推送快照才不會把它刪掉。
    const articlePhase = await runArticleSyncPhase();
    if (guard.stale()) return;
    const readingPhase = await runReadingSyncPhase();
    if (guard.stale()) return;
    const info = await syncNow(guard.build, guard.apply);
    if (guard.stale()) return;
    lastSyncAt = Date.now();
    try { localStorage.setItem('lastSnapshotAt', String(lastSyncAt)); } catch(_) {}
    if (info && typeof info.version === 'number') {
      try { localStorage.setItem('lastSnapshotVersion', String(info.version)); } catch(_) {}
    }
    const completion = resolveSyncCompletion({
      manual: true,
      restoredFromRemote: !!(info && info.restoredFromRemote),
      articleOk: articlePhase.ok === true,
      articlePending: articlePhase.pending === true,
      readingUnsupported: !!(readingPhase && !readingPhase.ok && readingPhase.info?.unsupported)
    });
    updateStatus(t(completion.statusKey));
    if (completion.toastKey) {
      try { ui.displayMessage(t(completion.toastKey), completion.toastLevel, completion.toastMs); } catch(_) {}
    }
    // 手動同步的備份也移到鎖外，避免匯出全部資料時卡住「同步中」狀態。
    scheduleBackupAfterSync(t('sync.backupNoteManual'));
  } catch (e) {
    if (e && e.code === 'stale_session') return;
    if (e && e.code === 'unauthorized') {
      // Only the session that issued this request may be signed out.
      if (!(guard && guard.stale())) await auth.invalidateSession();
      updateStatus(t('sync.loggedOutState'));
      return;
    }
    console.warn(e);
    updateStatus(t('sync.syncFailed'));
    ui.displayMessage(`${t('sync.syncFailed')}：${e?.message || t('sync.unknownError')}`, 'error');
  } finally {
    endSyncRound();
    setBusy(false);
  }
}

function setBusy(b) {
  if (dom.syncNowBtn) dom.syncNowBtn.disabled = b;
  if (dom.loginBtn) dom.loginBtn.disabled = b;
  if (dom.logoutBtn) dom.logoutBtn.disabled = b;
}

function updateStatus(text) {
  if (dom.syncStatus) {
    const ver = parseInt(localStorage.getItem('lastSnapshotVersion')||'0',10) || 0;
    const ts = lastSyncAt
        ? t('sync.lastSyncWithVersion', { time: formatDateTime(lastSyncAt, { hour12: false, year: undefined, month: undefined, day: undefined }), version: ver })
        : (ver ? t('sync.versionOnly', { version: ver }) : '');
    dom.syncStatus.textContent = (text || '') + ' ' + ts;
  }
}

function updateAuthButtons(user) {
  const loggedIn = !!user;
  if (dom.loginBtn) dom.loginBtn.style.display = loggedIn ? 'none' : 'inline-block';
  if (dom.logoutBtn) dom.logoutBtn.style.display = loggedIn ? 'inline-block' : 'none';
}

function showLoginModal() {
  try { ui.openModal(); } catch(_) {}
  try { dom.modalTitle.textContent = t('sync.login'); } catch(_) {}
  const initialCaps = getCachedAuthCapabilities();
  const passwordReady = initialCaps ? initialCaps.passwordLogin === true : false;
  const html = `
    <div class="auth-modal" style="min-width:300px;">
      <div class="auth-tabs" role="tablist">
        <button class="auth-tab" id="auth-tab-password" type="button" role="tab" data-auth-tab="password" aria-selected="${passwordReady ? 'true' : 'false'}">${t('sync.loginTabPassword')}</button>
        <button class="auth-tab" id="auth-tab-passcode" type="button" role="tab" data-auth-tab="passcode" aria-selected="${passwordReady ? 'false' : 'true'}">${t('sync.loginTabPasscode')}</button>
      </div>
      <div class="auth-panel" data-auth-panel="password" ${passwordReady ? '' : 'hidden'}>
        <div class="auth-field">
          <label for="auth-username">${t('sync.username')}</label>
          <input id="auth-username" type="text" placeholder="${t('sync.usernamePlaceholder')}" autocomplete="username" autocapitalize="none" spellcheck="false">
        </div>
        <div class="auth-field">
          <label for="auth-password">${t('sync.password')}</label>
          <div class="auth-pass-row">
            <input id="auth-password" type="password" placeholder="${t('sync.passwordPlaceholder')}" autocomplete="current-password">
            <button id="auth-password-toggle" class="btn-secondary" type="button">${t('sync.show')}</button>
          </div>
        </div>
        <div class="auth-actions">
          <button id="auth-password-submit" class="btn-primary" type="button">${t('sync.login')}</button>
        </div>
        <div id="auth-password-msg" class="auth-msg">${t('sync.passwordLoginHint')}</div>
        <p class="gs-hint">${t('sync.forgotPasswordHint')}</p>
      </div>
      <div class="auth-panel" data-auth-panel="passcode" ${passwordReady ? 'hidden' : ''}>
        <div class="auth-field">
          <label for="auth-token">${t('sync.passcode')}</label>
          <div class="auth-pass-row">
            <input id="auth-token" type="password" placeholder="${t('sync.passcodePlaceholder')}" autocomplete="current-password">
            <button id="auth-token-toggle" class="btn-secondary" type="button">${t('sync.show')}</button>
          </div>
        </div>
        <div class="auth-actions">
          <button id="auth-pair" class="btn-secondary" type="button">${t('sync.pairingLogin')}</button>
          <button id="auth-forgot" class="btn-secondary" type="button">${t('sync.forgotPasscode')}</button>
          <button id="auth-submit" class="btn-primary" type="button">${t('sync.login')}</button>
        </div>
        <div id="auth-msg" class="auth-msg">${t('sync.loginHint')}<br>${t('sync.loginRememberHint')}</div>
      </div>
    </div>`;
  dom.modalBody.innerHTML = html;

  const usernameEl = dom.modalBody.querySelector('#auth-username');
  const passwordEl = dom.modalBody.querySelector('#auth-password');
  const passwordToggle = dom.modalBody.querySelector('#auth-password-toggle');
  const passwordBtn = dom.modalBody.querySelector('#auth-password-submit');
  const passwordMsg = dom.modalBody.querySelector('#auth-password-msg');
  const tokenEl = dom.modalBody.querySelector('#auth-token');
  const submitBtn = dom.modalBody.querySelector('#auth-submit');
  const msg = dom.modalBody.querySelector('#auth-msg');
  const toggle = dom.modalBody.querySelector('#auth-token-toggle');
  let userChoseTab = false;

  const setTab = (tab) => {
    const target = dom.modalBody.querySelector(`[data-auth-tab="${tab}"]`);
    if (!target) return;
    for (const button of dom.modalBody.querySelectorAll('[data-auth-tab]')) {
      button.setAttribute('aria-selected', button.dataset.authTab === tab ? 'true' : 'false');
    }
    for (const panelEl of dom.modalBody.querySelectorAll('[data-auth-panel]')) {
      panelEl.hidden = panelEl.dataset.authPanel !== tab;
    }
    if (tab === 'password') { try { usernameEl?.focus(); } catch (_) {} }
    else { try { tokenEl?.focus(); } catch (_) {} }
  };

  for (const button of dom.modalBody.querySelectorAll('[data-auth-tab]')) {
    button.onclick = () => { userChoseTab = true; setTab(button.dataset.authTab); };
  }
  if (passwordReady) setTab('password');
  else setTab('passcode');

  if (passwordToggle) passwordToggle.onclick = () => {
    const toText = passwordEl.type === 'password';
    passwordEl.type = toText ? 'text' : 'password';
    passwordToggle.textContent = toText ? t('sync.hide') : t('sync.show');
  };
  if (toggle) toggle.onclick = () => {
    const toText = tokenEl.type === 'password';
    tokenEl.type = toText ? 'text' : 'password';
    toggle.textContent = toText ? t('sync.hide') : t('sync.show');
  };

  const doPasswordLogin = async () => {
    const username = (usernameEl.value || '').trim();
    const password = passwordEl.value || '';
    if (!username) { passwordMsg.textContent = t('sync.usernameRequired'); return; }
    if (!password) { passwordMsg.textContent = t('sync.passwordRequired'); return; }
    if (!(await confirmAccountSwitch())) return;
    passwordBtn.disabled = true; passwordBtn.textContent = t('sync.loggingIn');
    passwordMsg.textContent = '';
    try {
      await auth.signInWithPassword(username, password);
      passwordMsg.textContent = t('sync.loginSuccess');
      try { ui.closeModal(); } catch(_) {}
    } catch (e) {
      passwordMsg.textContent = passwordLoginErrorMessage(e);
    } finally {
      passwordBtn.disabled = false; passwordBtn.textContent = t('sync.login');
    }
  };

  const doLogin = async () => {
    const code = (tokenEl.value || '').trim();
    if (!code) { msg.textContent = t('sync.enterPasscode'); return; }
    submitBtn.disabled = true; submitBtn.textContent = t('sync.loggingIn');
    try {
      await auth.signInWithToken(code);
      msg.textContent = t('sync.loginSuccess');
      try { ui.closeModal(); } catch(_) {}
    } catch (e) {
      msg.textContent = t('sync.error', { message: e?.message || t('sync.tryLater') });
    } finally {
      submitBtn.disabled = false; submitBtn.textContent = t('sync.login');
    }
  };

  passwordBtn.onclick = doPasswordLogin;
  for (const el of [usernameEl, passwordEl]) {
    el?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); doPasswordLogin(); }
    });
  }
  submitBtn.onclick = doLogin;
  if (tokenEl) tokenEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doLogin(); }
  });
  const forgotBtn = dom.modalBody.querySelector('#auth-forgot');
  if (forgotBtn) forgotBtn.onclick = () => showResetTokenModal();
  const pairBtn = dom.modalBody.querySelector('#auth-pair');
  if (pairBtn) pairBtn.onclick = () => showLoginCodeModal();
  getAuthCapabilities().then((caps) => {
    const pair = dom.modalBody.querySelector('#auth-pair');
    if (pair && !caps.pairingLogin) pair.remove();
    const passwordTab = dom.modalBody.querySelector('#auth-tab-password');
    const passwordPanel = dom.modalBody.querySelector('[data-auth-panel="password"]');
    if (!caps.passwordLogin) {
      passwordTab?.remove();
      passwordPanel?.remove();
      setTab('passcode');
    } else if (!userChoseTab && !passwordReady) {
      setTab('password');
    }
  }).catch(() => {});
}

function passwordLoginErrorMessage(error) {
  if (error?.code === 'invalid_credentials') return t('errors.invalidCredentials');
  if (error?.code === 'account_disabled') return t('errors.accountDisabled');
  if (error?.code === 'rate_limited') return t('errors.loginRateLimited');
  if (error?.code === 'password_not_configured') return t('errors.passwordNotConfigured');
  if (error?.code === 'stale_login') return t('errors.loginSuperseded');
  return t('sync.error', { message: error?.message || t('sync.tryLater') });
}

function loginCodeErrorMessage(error) {
  if (error?.code === 'pairing_invalid') return t('errors.pairingInvalid');
  if (error?.code === 'pairing_format') return t('errors.pairingFormat');
  if (error?.code === 'rate_limited') return t('errors.pairingRateLimited');
  if (error?.code === 'stale_login') return t('errors.loginSuperseded');
  return t('sync.error', { message: error?.message || t('sync.tryLater') });
}

// 登入碼登入：管理員產生一次性登入碼（或直接給連結／二維碼），
// 使用者在這裡換取長期 session。若本機已有學習資料，登入後再詢問是否合併。
function showLoginCodeModal(options = {}) {
  try { ui.openModal(); } catch(_) {}
  try { dom.modalTitle.textContent = t('sync.pairingLoginTitle'); } catch(_) {}
  const initialCode = String(options.code || '');
  const notice = options.notice || t('sync.pairingHint');
  const html = `
    <div class="auth-modal" style="min-width:300px;">
      <div class="auth-field">
        <label for="pair-code">${t('sync.pairingCode')}</label>
        <input id="pair-code" type="text" maxlength="64" value="${escapeHtml(initialCode)}" placeholder="${t('sync.pairingCodePlaceholder')}" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false">
      </div>
      <div class="auth-actions">
        <button id="pair-back" class="btn-secondary" type="button">${t('sync.backToPasscode')}</button>
        <button id="pair-submit" class="btn-primary" type="button">${t('sync.pairingSubmit')}</button>
      </div>
      <div id="pair-msg" class="auth-msg">${escapeHtml(notice)}</div>
    </div>`;
  dom.modalBody.innerHTML = html;
  const codeEl = dom.modalBody.querySelector('#pair-code');
  const submitBtn = dom.modalBody.querySelector('#pair-submit');
  const backBtn = dom.modalBody.querySelector('#pair-back');
  const msg = dom.modalBody.querySelector('#pair-msg');

  const doLogin = async () => {
    const code = (codeEl.value || '').trim();
    if (!code) { msg.textContent = t('errors.pairingRequired'); return; }
    submitBtn.disabled = true; submitBtn.textContent = t('sync.pairingLoggingIn');
    try {
      const caps = await getAuthCapabilities();
      if (!caps.pairingLogin) {
        msg.textContent = t('sync.loginCodeCapabilityMissing');
        return;
      }
      if (!(await confirmAccountSwitch())) {
        msg.textContent = t('sync.loginCodeSwitchCancelled');
        return;
      }
      suppressAutoSyncForLoginLink = true;
      const result = await auth.signInWithLoginCode(code);
      msg.textContent = t('sync.pairingSuccess');
      await afterLoginCode(result, { notify: false });
      try { ui.closeModal(); } catch(_) {}
    } catch (e) {
      msg.textContent = loginCodeErrorMessage(e);
    } finally {
      suppressAutoSyncForLoginLink = false;
      submitBtn.disabled = false; submitBtn.textContent = t('sync.pairingSubmit');
    }
  };

  if (backBtn) backBtn.onclick = () => showLoginModal();
  submitBtn.onclick = doLogin;
  if (codeEl) {
    codeEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); doLogin(); }
    });
    try { codeEl.focus(); } catch (_) {}
  }
}

function readPendingMergeUser() {
  try { return localStorage.getItem(PENDING_MERGE_KEY) || ''; } catch (_) { return ''; }
}

function isPendingMergeForCurrentUser() {
  const userId = getStoredSyncUserId();
  return !!userId && readPendingMergeUser() === userId;
}

function setPendingMerge(userId) {
  try { localStorage.setItem(PENDING_MERGE_KEY, String(userId || '')); } catch (_) {}
  pendingMergePaused = true;
}

function clearPendingMerge() {
  try { localStorage.removeItem(PENDING_MERGE_KEY); } catch (_) {}
  pendingMergePaused = false;
}

// Only user-created content counts. Settings and seeded defaults alone do not
// justify asking about a merge, and they must never be uploaded silently.
function hasMeaningfulLocalData() {
  try {
    if (Array.isArray(state.vocabularyBooks) && state.vocabularyBooks.length > 0) return true;
    if (Array.isArray(state.analyzedArticles) && state.analyzedArticles.length > 0) return true;
    const qaManifest = JSON.parse(localStorage.getItem('qa-sets') || '[]');
    if (Array.isArray(qaManifest) && qaManifest.length > 0) return true;
    const conversations = listAssistantConversationMetas();
    if (Array.isArray(conversations) && conversations.length > 0) return true;
  } catch (_) {}
  return false;
}

async function confirmAccountSwitch() {
  const current = getAuthSnapshot();
  if (!current.loggedIn) return true;
  return ui.confirmAction({
    title: t('sync.loginCodeSwitchTitle'),
    message: t('sync.loginCodeSwitchMessage', { user: current.label || current.userId }),
    confirmLabel: t('sync.loginCodeSwitchConfirm'),
    cancelLabel: t('settings.cancel')
  });
}

async function afterLoginCode(result, { notify = true } = {}) {
  const userId = result?.user_id || '';
  const label = result?.label || userId;
  if (notify) ui.displayMessage(t('sync.loginCodeLinkSuccess', { user: label }), 'success', 3500);

  if (!hasMeaningfulLocalData()) {
    clearPendingMerge();
    suppressAutoSyncForLoginLink = false;
    scheduleAutoSync('login-link');
    return;
  }

  // Login-link auto-login is not consent to upload this device's data to the
  // account. Ask explicitly; "only sign in" keeps auto-sync paused until the
  // user later confirms a merge from "Sync now".
  const shouldMerge = await ui.confirmAction({
    title: t('sync.loginCodeMergeTitle'),
    message: t('sync.loginCodeMergeMessage', { user: label }),
    confirmLabel: t('sync.loginCodeMergeConfirm'),
    cancelLabel: t('sync.loginCodeMergeSkip')
  });
  if (shouldMerge) {
    clearPendingMerge();
    suppressAutoSyncForLoginLink = false;
    scheduleAutoSync('login-link-merge');
    return;
  }
  setPendingMerge(userId);
  suppressAutoSyncForLoginLink = false;
  updateStatus(t('sync.mergePendingStatus'));
  ui.displayMessage(t('sync.loginCodeMergeSkipped'), 'warning', 6000);
}

function stripLoginHash() {
  try {
    const url = new URL(window.location.href);
    url.hash = '';
    window.history.replaceState(null, '', url.pathname + url.search);
  } catch (_) {
    try { window.history.replaceState(null, '', window.location.pathname + window.location.search); } catch (_) {}
  }
}

/**
 * Capture `#login=<CODE>` before routing reads the fragment, then remove it.
 * The code is kept only in memory until initSync() has wired auth callbacks.
 * Returns the normalized code when one was captured.
 */
export function captureLoginLinkFromUrl() {
  let hash = '';
  try { hash = String(window.location.hash || ''); } catch (_) { return ''; }
  if (!/^#login=/i.test(hash)) return '';
  const raw = hash.slice(1);
  const separator = raw.indexOf('=');
  const value = separator >= 0 ? raw.slice(separator + 1).split('&')[0] : '';
  let decoded = value;
  try { decoded = decodeURIComponent(value); } catch (_) {}
  const code = normalizeLoginCode(decoded);
  stripLoginHash();
  pendingLoginCode = LOGIN_CODE_RE.test(code) ? code : '';
  return pendingLoginCode;
}

/**
 * Exchange the captured link code. Called after initSync(), and again on a
 * later hashchange. On failure the manual login-code dialog opens prefilled so
 * the user can retry without the fragment being put back into the URL.
 */
export async function consumePendingLoginLink() {
  if (loginLinkBusy) return false;
  const code = pendingLoginCode;
  pendingLoginCode = '';
  if (!code) return false;
  loginLinkBusy = true;
  try {
    const caps = await getAuthCapabilities();
    if (!caps.loginLinks && !caps.pairingLogin) {
      showLoginCodeModal({ code, notice: t('sync.loginCodeCapabilityMissing') });
      return false;
    }
    if (!(await confirmAccountSwitch())) {
      showLoginCodeModal({ code, notice: t('sync.loginCodeSwitchCancelled') });
      return false;
    }
    suppressAutoSyncForLoginLink = true;
    const result = await auth.signInWithLoginCode(code);
    await afterLoginCode(result);
    return true;
  } catch (error) {
    showLoginCodeModal({ code, notice: loginCodeErrorMessage(error) });
    return false;
  } finally {
    suppressAutoSyncForLoginLink = false;
    loginLinkBusy = false;
  }
}

// 對外暴露：提供給其他功能模組開啟登入彈窗
export function openLoginModal() {
  try { showLoginModal(); } catch (_) { ui.displayMessage(t('sync.loginUnavailable'), 'error'); }
}

// 已登入下，自助修改通行碼
function showChangeTokenModal() {
  try { ui.openModal(); } catch(_) {}
  try { dom.modalTitle.textContent = t('sync.changePasscode'); } catch(_) {}
  const html = `
    <div class="auth-modal" style="min-width:300px;">
      <div class="auth-field">
        <label for="ct-new">${t('sync.newPasscode')}</label>
        <div class="auth-pass-row" style="display:flex;gap:8px;align-items:center;">
          <input id="ct-new" type="password" placeholder="${t('sync.minThirtyTwo')}" style="flex:1;">
          <button id="ct-toggle" class="btn-secondary" type="button" style="white-space:nowrap;">${t('sync.show')}</button>
          <button id="ct-generate" class="btn-secondary" type="button" style="white-space:nowrap;">${t('sync.generatePasscode')}</button>
        </div>
      </div>
      <div class="auth-field">
        <label for="ct-new2">${t('sync.confirmPasscode')}</label>
        <input id="ct-new2" type="password" placeholder="${t('sync.enterAgain')}">
      </div>
      <div class="auth-actions">
        <button id="ct-submit" class="btn-primary" type="button">${t('sync.updatePasscode')}</button>
      </div>
      <div id="ct-msg" class="auth-msg">${t('sync.changeHint')}</div>
    </div>`;
  dom.modalBody.innerHTML = html;
  const n1 = dom.modalBody.querySelector('#ct-new');
  const n2 = dom.modalBody.querySelector('#ct-new2');
  const btn = dom.modalBody.querySelector('#ct-submit');
  const msg = dom.modalBody.querySelector('#ct-msg');
  const toggle = dom.modalBody.querySelector('#ct-toggle');
  if (toggle) toggle.onclick = () => { const showText = n1.type === 'password'; n1.type = showText ? 'text' : 'password'; toggle.textContent = showText ? t('sync.hide') : t('sync.show'); };
  dom.modalBody.querySelector('#ct-generate')?.addEventListener('click', () => {
    const value = generateStrongPasscode();
    n1.type = 'text'; n2.type = 'text';
    n1.value = value; n2.value = value;
    msg.textContent = t('sync.generatedPasscodeHint');
  });
  btn.onclick = async () => {
    const a = (n1.value || '').trim();
    const b = (n2.value || '').trim();
    if (a.length < 32) { msg.textContent = t('sync.passcodeTooShort'); return; }
    if (a !== b) { msg.textContent = t('sync.mismatch'); return; }
    btn.disabled = true; btn.textContent = t('sync.updating');
    try {
      await auth.changeToken(a);
      msg.textContent = t('sync.updatedPasscode');
      setTimeout(() => { try { ui.closeModal(); } catch(_) {} }, 600);
    } catch (e) {
      msg.textContent = t('sync.error', { message: e?.message || t('sync.tryLater') });
    } finally {
      btn.disabled = false; btn.textContent = t('sync.updatePasscode');
    }
  };
}

// 已登入下修改自己的密碼。管理員設定初始密碼後，使用者可在這裡更換。
function showChangePasswordModal() {
  try { ui.openModal(); } catch(_) {}
  try { dom.modalTitle.textContent = t('sync.changePassword'); } catch(_) {}
  const caps = getCachedAuthCapabilities() || {};
  const role = getAuthSnapshot().role === 'admin' ? 'admin' : 'user';
  const minLength = role === 'admin'
    ? (Number(caps.adminPasswordMinLength) || 12)
    : (Number(caps.passwordMinLength) || 10);
  const html = `
    <div class="auth-modal" style="min-width:300px;">
      <div class="auth-field">
        <label for="cp-current">${t('sync.currentPassword')}</label>
        <input id="cp-current" type="password" placeholder="${t('sync.currentPasswordPlaceholder')}" autocomplete="current-password">
      </div>
      <div class="auth-field">
        <label for="cp-new">${t('sync.newPassword')}</label>
        <div class="auth-pass-row">
          <input id="cp-new" type="password" placeholder="${t('sync.passwordMinHint', { count: minLength })}" autocomplete="new-password">
          <button id="cp-toggle" class="btn-secondary" type="button">${t('sync.show')}</button>
        </div>
      </div>
      <div class="auth-field">
        <label for="cp-new2">${t('sync.confirmNewPassword')}</label>
        <input id="cp-new2" type="password" placeholder="${t('sync.enterAgain')}" autocomplete="new-password">
      </div>
      <div class="auth-actions">
        <button id="cp-submit" class="btn-primary" type="button">${t('sync.updatePassword')}</button>
      </div>
      <div id="cp-msg" class="auth-msg">${t('sync.passwordMinHint', { count: minLength })}</div>
    </div>`;
  dom.modalBody.innerHTML = html;
  const currentEl = dom.modalBody.querySelector('#cp-current');
  const newEl = dom.modalBody.querySelector('#cp-new');
  const confirmEl = dom.modalBody.querySelector('#cp-new2');
  const btn = dom.modalBody.querySelector('#cp-submit');
  const msg = dom.modalBody.querySelector('#cp-msg');
  const toggle = dom.modalBody.querySelector('#cp-toggle');

  if (toggle) toggle.onclick = () => {
    const toText = newEl.type === 'password';
    newEl.type = toText ? 'text' : 'password';
    confirmEl.type = toText ? 'text' : 'password';
    toggle.textContent = toText ? t('sync.hide') : t('sync.show');
  };

  const doSubmit = async () => {
    const current = currentEl.value || '';
    const next = newEl.value || '';
    const confirmation = confirmEl.value || '';
    if (!current) { msg.textContent = t('sync.currentPasswordRequired'); return; }
    if (next.length < minLength) { msg.textContent = t('sync.passwordTooShort', { count: minLength }); return; }
    if (next !== confirmation) { msg.textContent = t('sync.passwordMismatch'); return; }
    btn.disabled = true; btn.textContent = t('sync.updating');
    msg.textContent = '';
    try {
      await auth.changePassword(current, next);
      msg.textContent = t('sync.passwordUpdated');
      setTimeout(() => { try { ui.closeModal(); } catch(_) {} }, 700);
    } catch (e) {
      if (e?.code === 'password_not_set') msg.textContent = t('sync.passwordNotSetHint');
      else if (e?.code === 'invalid_current_password') msg.textContent = t('errors.invalidCurrentPassword');
      else if (e?.code === 'weak_password' || e?.code === 'invalid_password') {
        msg.textContent = t('sync.passwordTooShort', { count: minLength });
      } else {
        msg.textContent = t('sync.error', { message: e?.message || t('sync.tryLater') });
      }
    } finally {
      btn.disabled = false; btn.textContent = t('sync.updatePassword');
    }
  };

  btn.onclick = doSubmit;
  for (const el of [currentEl, newEl, confirmEl]) {
    el?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); doSubmit(); }
    });
  }
}

// 忘記通行碼：用「使用者代號 + 恢復碼」重置
function showResetTokenModal() {
  try { ui.openModal(); } catch(_) {}
  try { dom.modalTitle.textContent = t('sync.resetPasscode'); } catch(_) {}
  const html = `
    <div class="auth-modal" style="min-width:300px;">
      <div class="auth-field">
        <label for="rt-uid">${t('sync.userId')}</label>
        <input id="rt-uid" type="text" placeholder="${t('sync.userIdPlaceholder')}" autocomplete="username">
      </div>
      <div class="auth-field">
        <label for="rt-recovery">${t('sync.recoveryCode')}</label>
        <input id="rt-recovery" type="text" placeholder="${t('sync.recoveryPlaceholder')}">
      </div>
      <div class="auth-field">
        <label for="rt-new">${t('sync.newPasscode')}</label>
        <div class="auth-pass-row" style="display:flex;gap:8px;align-items:center;">
          <input id="rt-new" type="password" placeholder="${t('sync.minThirtyTwo')}" style="flex:1;">
          <button id="rt-toggle" class="btn-secondary" type="button" style="white-space:nowrap;">${t('sync.show')}</button>
          <button id="rt-generate" class="btn-secondary" type="button" style="white-space:nowrap;">${t('sync.generatePasscode')}</button>
        </div>
      </div>
      <div class="auth-actions">
        <button id="rt-back" class="btn-secondary" type="button">${t('sync.backLogin')}</button>
        <button id="rt-submit" class="btn-primary" type="button">${t('sync.resetAndLogin')}</button>
      </div>
      <div id="rt-msg" class="auth-msg">${t('sync.resetHint')}</div>
    </div>`;
  dom.modalBody.innerHTML = html;
  const uid = dom.modalBody.querySelector('#rt-uid');
  const rec = dom.modalBody.querySelector('#rt-recovery');
  const nw = dom.modalBody.querySelector('#rt-new');
  const btn = dom.modalBody.querySelector('#rt-submit');
  const back = dom.modalBody.querySelector('#rt-back');
  const msg = dom.modalBody.querySelector('#rt-msg');
  const toggle = dom.modalBody.querySelector('#rt-toggle');
  if (toggle) toggle.onclick = () => { const showText = nw.type === 'password'; nw.type = showText ? 'text' : 'password'; toggle.textContent = showText ? t('sync.hide') : t('sync.show'); };
  dom.modalBody.querySelector('#rt-generate')?.addEventListener('click', () => {
    const value = generateStrongPasscode();
    nw.type = 'text';
    nw.value = value;
    msg.textContent = t('sync.generatedPasscodeHint');
  });
  if (back) back.onclick = () => showLoginModal();
  btn.onclick = async () => {
    const u = (uid.value || '').trim();
    const r = (rec.value || '').trim();
    const a = (nw.value || '').trim();
    if (!u || !r) { msg.textContent = t('sync.fillRecovery'); return; }
    if (a.length < 32) { msg.textContent = t('sync.passcodeTooShort'); return; }
    btn.disabled = true; btn.textContent = t('sync.processing');
    try {
      await auth.resetToken(u, r, a);
      msg.textContent = t('sync.resetSuccess');
      try { ui.closeModal(); } catch(_) {}
    } catch (e) {
      msg.textContent = t('sync.error', { message: e?.message || t('sync.tryLater') });
    } finally {
      btn.disabled = false; btn.textContent = t('sync.resetAndLogin');
    }
  };
}

function toggleGearMenu() {
  const existed = document.getElementById('gear-menu');
  if (existed) { existed.remove(); return; }
  const m = document.createElement('div');
  m.id = 'gear-menu';
  m.className = 'gear-menu';
  const email = (window.__supabase_user && window.__supabase_user.email) || '';
  let ver = parseInt(localStorage.getItem('lastSnapshotVersion')||'0',10) || 0;
  const atMs = parseInt(localStorage.getItem('lastSnapshotAt')||'0',10) || 0;
  const timeText = atMs ? new Date(atMs).toLocaleTimeString() : '';
  const status = dom.syncStatus?.textContent || '';
  if (!ver && status) {
    const mVer = status.match(/v(\d+)/i);
    if (mVer) { ver = parseInt(mVer[1], 10) || 0; try { if (ver>0) localStorage.setItem('lastSnapshotVersion', String(ver)); } catch(_) {} }
  }
  const loggedIn = !!email;
  const caps = getCachedAuthCapabilities();
  const passwordLogin = Boolean(caps && caps.passwordLogin);
  // 每個 .mi-text 都帶 data-i18n：選單是「開啟當下」才建立的，
  // 若只寫死 t() 的結果，之後切換介面語言時這份已經在畫面上的選單不會更新
  // （applyTranslations 只認 data-i18n 屬性），使用者會看到舊語言的文案。
  m.innerHTML = `
    <div class="menu-item" id="gm-sync">
      <span class="mi-icon" aria-hidden="true">${svgSync()}</span>
      <span class="mi-text" data-i18n="menu.syncNow">${t('menu.syncNow')}</span>
      <span class="meta">${ver ? 'v'+ver : ''}${timeText ? ' · ' + timeText.replace(/:\\d{2}$/, '') : ''}</span>
    </div>
    ${loggedIn ? '' : `<div class="menu-item" id="gm-login"><span class="mi-icon">${svgLogin()}</span><span class="mi-text" data-i18n="menu.login">${t('menu.login')}</span></div>`}
    ${loggedIn && passwordLogin ? `<div class="menu-item" id="gm-change-password"><span class="mi-icon">${svgKey()}</span><span class="mi-text" data-i18n="menu.changePassword">${t('menu.changePassword')}</span></div>` : ''}
    ${loggedIn ? `<div class="menu-item" id="gm-change-token"><span class="mi-icon">${svgKey()}</span><span class="mi-text" data-i18n="menu.changePasscode">${t('menu.changePasscode')}</span></div>` : ''}
    ${loggedIn ? `<div class="menu-item" id="gm-logout"><span class="mi-icon">${svgLogout()}</span><span class="mi-text" data-i18n="menu.logout">${t('menu.logout')}</span><span class="meta">${escapeHtml(email)}</span></div>` : ''}
    <div class="menu-divider"></div>
    <div class="menu-item" id="gm-settings"><span class="mi-icon">${svgGear()}</span><span class="mi-text" data-i18n="menu.globalSettings">${t('menu.globalSettings')}</span></div>
    <div class="menu-item" id="gm-grading-history"><span class="mi-icon">${svgHistory()}</span><span class="mi-text" data-i18n="menu.gradingHistory">${t('menu.gradingHistory')}</span></div>
    <div class="menu-item" id="gm-assistant"><span class="mi-icon">${svgChat()}</span><span class="mi-text" data-i18n="menu.assistantSessions">${t('menu.assistantSessions')}</span></div>
    <div class="menu-item" id="gm-backup-panel"><span class="mi-icon">${svgRestore()}</span><span class="mi-text" data-i18n="menu.backupRestore">${t('menu.backupRestore')}</span></div>
    <div class="menu-status">${status}</div>`;
  document.body.appendChild(m);
  const sync = m.querySelector('#gm-sync');
  const login = m.querySelector('#gm-login');
  const changePassword = m.querySelector('#gm-change-password');
  const changeToken = m.querySelector('#gm-change-token');
  const logout = m.querySelector('#gm-logout');
  const settings = m.querySelector('#gm-settings');
  const gradingHistory = m.querySelector('#gm-grading-history');
  const assistantSessions = m.querySelector('#gm-assistant');
  const backupPanel = m.querySelector('#gm-backup-panel');
  if (sync) sync.addEventListener('click', () => { handleSync(); m.remove(); });
  if (login) login.addEventListener('click', () => { showLoginModal(); m.remove(); });
  if (changePassword) changePassword.addEventListener('click', () => { showChangePasswordModal(); m.remove(); });
  if (changeToken) changeToken.addEventListener('click', () => { showChangeTokenModal(); m.remove(); });
  if (logout) logout.addEventListener('click', async () => { m.remove(); await handleLogout(); });
  if (settings) settings.addEventListener('click', () => { showGlobalSettingsModal(); m.remove(); });
  if (gradingHistory) gradingHistory.addEventListener('click', () => { try { openDictationGradingHistory(); } catch(_) {} m.remove(); });
  if (assistantSessions) assistantSessions.addEventListener('click', () => { showAssistantSessions(); m.remove(); });
  if (backupPanel) backupPanel.addEventListener('click', () => { showBackupRestoreModal(); m.remove(); });
}

// 全域設定：左側分類 + 右側卡片，任何變更即時寫入本機設定（不再需要「儲存」按鈕）。
// #gs-save 保留為「完成」：既有巡檢腳本與使用習慣都以它關閉面板。
let gsActiveTab = 'general';
let gsCleanup = null;

function showGlobalSettingsModal() {
  try { gsCleanup?.(); } catch (_) {}
  gsCleanup = null;
  try { ui.openModal(); } catch(_) {}
  try { dom.modalTitle.textContent = t('settings.globalTitle'); } catch(_) {}
  try { const mc = dom.appModal.querySelector('.modal-content'); if (mc) mc.classList.add('modal-large'); } catch(_) {}

  let disposed = false;
  const persistedSettings = loadGlobalSettings();
  const persistedSecrets = loadGlobalSecrets();
  const settings = {
    interfaceLocale: persistedSettings?.language?.interfaceLocale || getLocale(),
    ttsUrlCustom: persistedSettings?.tts?.baseUrlCustom || '',
    ttsUse: persistedSettings?.tts?.use || 'remote',
    readEn: (persistedSettings?.reading && persistedSettings.reading.englishVariant) || 'en-GB',
    readZh: (persistedSettings?.reading && persistedSettings.reading.chineseVariant) || 'zh-CN',
    selectedVoices: (persistedSettings?.tts && persistedSettings.tts.selectedVoices) || {},
    assistantEnabled: persistedSettings?.assistant?.enabled !== false,
    assistantStream: persistedSettings?.assistant?.stream !== false,
    phoneticsEnabled: persistedSettings?.phonetics?.enabled === true
  };
  const secrets = { ttsKey: persistedSecrets?.ttsApiKey || '' };
  try { applyTheme(getSavedTheme()); } catch (_) {}
  const authSnapshot = getAuthSnapshot();
  const isAdmin = authSnapshot.loggedIn && authSnapshot.role === 'admin';

  const TABS = [
    { id: 'general', labelKey: 'settings.tabGeneral', icon: 'ic-sliders' },
    { id: 'voice', labelKey: 'settings.tabVoice', icon: 'ic-speaker' },
    { id: 'ai', labelKey: 'settings.tabAi', icon: 'ic-sparkle' },
    { id: 'tools', labelKey: 'settings.tabTools', icon: 'ic-bulb' }
  ];
  if (!TABS.some((tab) => tab.id === gsActiveTab)) gsActiveTab = 'general';

  const navHtml = TABS.map((tab) => `
    <button type="button" class="gs-nav-btn${tab.id === gsActiveTab ? ' active' : ''}"
      role="tab" id="gs-tab-${tab.id}" aria-controls="gs-panel-${tab.id}" data-gs-tab="${tab.id}"
      aria-selected="${tab.id === gsActiveTab ? 'true' : 'false'}" tabindex="${tab.id === gsActiveTab ? '0' : '-1'}">
      <svg class="gs-nav-icon" aria-hidden="true"><use href="#${tab.icon}"/></svg>
      <span>${escapeHtml(t(tab.labelKey))}</span>
    </button>`).join('');

  const savedThemeId = getSavedTheme();
  const themeButtons = THEMES.map((theme) => `
    <button type="button" class="gs-theme-btn${theme.id === savedThemeId ? ' active' : ''}" data-theme-id="${theme.id}"
      aria-pressed="${theme.id === savedThemeId ? 'true' : 'false'}">
      <span class="gs-theme-dot" style="background:${theme.swatch}" aria-hidden="true"></span>
      <span class="gs-theme-name">${escapeHtml(t(theme.labelKey))}</span>
    </button>`).join('');

  const voiceRows = [
    ['en-US', 'settings.englishAmerican', 'gs-test-en-us'],
    ['en-GB', 'settings.englishBritish', 'gs-test-en-gb'],
    ['zh-HK', 'settings.cantoneseVoice', 'gs-test-zh-hk'],
    ['zh-CN', 'settings.mandarinVoice', 'gs-test-zh-cn']
  ].map(([group, labelKey, testId]) => `
    <div class="gs-voice-row">
      <div class="gs-voice-row-head">
        <span class="gs-voice-label">${escapeHtml(t(labelKey))}</span>
        <button id="${testId}" type="button" class="btn-secondary gs-mini">${escapeHtml(t('settings.previewVoice'))}</button>
      </div>
      <select data-voice-group="${group}" aria-label="${escapeHtml(t(labelKey))}"><option value="">${escapeHtml(t('settings.loading'))}</option></select>
    </div>`).join('');

  const panel = (id, titleKey, hintKey, body) => `
    <section class="gs-panel" role="tabpanel" id="gs-panel-${id}" aria-labelledby="gs-tab-${id}" data-gs-panel="${id}" ${gsActiveTab === id ? '' : 'hidden'}>
      <header class="gs-panel-head">
        <h5>${escapeHtml(t(titleKey))}</h5>
        <p>${escapeHtml(t(hintKey))}</p>
      </header>
      ${body}
    </section>`;

  const html = `
    <div class="gs-settings">
      <div class="gs-shell">
        <div class="gs-nav-wrap">
          <nav class="gs-nav" role="tablist" aria-orientation="vertical" aria-label="${escapeHtml(t('settings.globalTitle'))}">
            ${navHtml}
          </nav>
        </div>
        <div class="gs-panels">
          ${panel('general', 'settings.tabGeneral', 'settings.panelGeneralHint', `
            <div class="gs-card">
              <div class="gs-card-body">
                <div class="gs-field">
                  <label for="gs-interface-locale">${escapeHtml(t('settings.languageLabel'))}</label>
                  <select id="gs-interface-locale">
                    ${Object.keys(SUPPORTED_LOCALES).map((value) => `<option value="${escapeHtml(value)}" ${settings.interfaceLocale === value ? 'selected' : ''}>${escapeHtml(t(value === 'zh-HK' ? 'settings.localeHk' : 'settings.localeCn'))}</option>`).join('')}
                  </select>
                  <p class="gs-hint">${escapeHtml(t('settings.languageHint'))}</p>
                </div>
              </div>
            </div>
            <div class="gs-card">
              <div class="gs-card-head">
                <span class="gs-card-title">${escapeHtml(t('settings.theme'))}</span>
                <span class="gs-hint">${escapeHtml(t('settings.themeHint'))}</span>
              </div>
              <div class="gs-card-body">
                <div class="gs-theme-row" id="gs-theme-row" role="group" aria-label="${escapeHtml(t('settings.theme'))}">${themeButtons}</div>
              </div>
            </div>
            <div class="gs-card">
              <div class="gs-card-head">
                <span class="gs-card-title">${escapeHtml(t('settings.themeArt'))}</span>
                <span class="gs-hint">${escapeHtml(t('settings.themeArtHint'))}</span>
              </div>
              <div class="gs-card-body">
                <div class="gs-art-row">
                  <button type="button" id="gs-art-pick" class="btn">${escapeHtml(t('settings.themeArtPick'))}</button>
                  <button type="button" id="gs-art-clear" class="btn-secondary" hidden>${escapeHtml(t('settings.themeArtClear'))}</button>
                  <span id="gs-art-status" class="gs-hint"></span>
                </div>
                <input type="file" id="gs-art-file" accept="image/*" class="gs-visually-hidden" />
                <div class="gs-art-controls">
                  <label class="gs-toggle">
                    <span class="gs-label">${escapeHtml(t('settings.themeArtEnabled'))}</span>
                    <input id="gs-art-enabled" class="gs-visually-hidden" type="checkbox">
                    <span class="gs-switch" aria-hidden="true"></span>
                  </label>
                  <label class="gs-art-slider">
                    <span>${escapeHtml(t('settings.themeArtStrength'))}</span>
                    <input id="gs-art-strength" type="range" min="0" max="50" step="1">
                    <span id="gs-art-strength-value" class="gs-art-value"></span>
                  </label>
                  <label class="gs-art-slider">
                    <span>${escapeHtml(t('settings.themeArtBlur'))}</span>
                    <input id="gs-art-blur" type="range" min="0" max="8" step="1">
                    <span id="gs-art-blur-value" class="gs-art-value"></span>
                  </label>
                </div>
              </div>
            </div>
            <div class="gs-card">
              <div class="gs-card-head">
                <span class="gs-card-title">${escapeHtml(t('settings.brandIcon'))}</span>
                <span class="gs-hint">${escapeHtml(t('settings.brandIconHint'))}</span>
              </div>
              <div class="gs-card-body">
                <div class="gs-art-row">
                  <button type="button" id="gs-icon-pick" class="btn">${escapeHtml(t('settings.brandIconPick'))}</button>
                  <button type="button" id="gs-icon-clear" class="btn-secondary" hidden>${escapeHtml(t('settings.brandIconRestore'))}</button>
                  <span id="gs-icon-status" class="gs-hint"></span>
                </div>
                <input type="file" id="gs-icon-file" accept="image/*" class="gs-visually-hidden" />
              </div>
            </div>`)}
          ${panel('voice', 'settings.tabVoice', 'settings.panelVoiceHint', `
            <div class="gs-card">
              <div class="gs-card-head">
                <span class="gs-card-title">${escapeHtml(t('settings.ttsSource'))}</span>
                <span class="gs-hint">${escapeHtml(t('settings.ttsSourceHint'))}</span>
              </div>
              <div class="gs-card-body">
                <div class="gs-choice-row" role="radiogroup" aria-label="${escapeHtml(t('settings.ttsSource'))}">
                  <label class="gs-choice"><input id="gs-tts-use-remote" class="gs-visually-hidden" type="radio" name="gs-tts-use" ${settings.ttsUse !== 'local' && settings.ttsUse !== 'custom' ? 'checked' : ''}><span class="gs-choice-label">${escapeHtml(t('settings.remote'))}</span></label>
                  <label class="gs-choice"><input id="gs-tts-use-local" class="gs-visually-hidden" type="radio" name="gs-tts-use" ${settings.ttsUse === 'local' ? 'checked' : ''}><span class="gs-choice-label">${escapeHtml(t('settings.local'))}</span></label>
                  <label class="gs-choice"><input id="gs-tts-use-custom" class="gs-visually-hidden" type="radio" name="gs-tts-use" ${settings.ttsUse === 'custom' ? 'checked' : ''}><span class="gs-choice-label">${escapeHtml(t('settings.custom'))}</span></label>
                </div>
                <div class="gs-field" id="gs-tts-custom-wrap" ${settings.ttsUse === 'custom' ? '' : 'hidden'}>
                  <label for="gs-tts-url-custom">${escapeHtml(t('settings.customTtsUrl'))}</label>
                  <input id="gs-tts-url-custom" type="text" placeholder="https://your-tts.example.com" value="${escapeHtml(settings.ttsUrlCustom)}" autocomplete="off" spellcheck="false">
                </div>
              </div>
            </div>
            <div class="gs-card">
              <div class="gs-card-head">
                <span class="gs-card-title">${escapeHtml(t('settings.ttsKey'))}</span>
              </div>
              <div class="gs-card-body">
                <div class="gs-field">
                  <input id="gs-tts-key" type="password" placeholder="..." value="${escapeHtml(secrets.ttsKey)}" autocomplete="off" spellcheck="false" aria-label="${escapeHtml(t('settings.ttsKey'))}">
                  <p class="gs-hint">${escapeHtml(t('settings.ttsKeyHint'))}</p>
                </div>
              </div>
            </div>
            <div class="gs-card">
              <div class="gs-card-head">
                <span class="gs-card-title">${escapeHtml(t('settings.readingPrefs'))}</span>
                <span class="gs-hint">${escapeHtml(t('settings.defaultBritish'))}</span>
              </div>
              <div class="gs-card-body">
                <div class="gs-inline-field">
                  <span class="gs-field-label">${escapeHtml(t('settings.englishVoicePreference'))}</span>
                  <div class="gs-choice-row" role="radiogroup" aria-label="${escapeHtml(t('settings.englishVoicePreference'))}">
                    <label class="gs-choice"><input id="gs-read-en-gb" class="gs-visually-hidden" name="gs-read-en" type="radio" ${settings.readEn !== 'en-US' ? 'checked' : ''}><span class="gs-choice-label">${escapeHtml(t('settings.britishEnglish'))}</span></label>
                    <label class="gs-choice"><input id="gs-read-en-us" class="gs-visually-hidden" name="gs-read-en" type="radio" ${settings.readEn === 'en-US' ? 'checked' : ''}><span class="gs-choice-label">${escapeHtml(t('settings.americanEnglish'))}</span></label>
                  </div>
                </div>
                <div class="gs-inline-field">
                  <span class="gs-field-label">${escapeHtml(t('settings.chineseVoicePreference'))}</span>
                  <div class="gs-choice-row" role="radiogroup" aria-label="${escapeHtml(t('settings.chineseVoicePreference'))}">
                    <label class="gs-choice"><input id="gs-read-zh-cn" class="gs-visually-hidden" name="gs-read-zh" type="radio" ${settings.readZh !== 'zh-HK' ? 'checked' : ''}><span class="gs-choice-label">${escapeHtml(t('settings.mandarin'))}</span></label>
                    <label class="gs-choice"><input id="gs-read-zh-hk" class="gs-visually-hidden" name="gs-read-zh" type="radio" ${settings.readZh === 'zh-HK' ? 'checked' : ''}><span class="gs-choice-label">${escapeHtml(t('settings.cantonese'))}</span></label>
                  </div>
                </div>
              </div>
            </div>
            <div class="gs-card">
              <div class="gs-card-head">
                <span class="gs-card-title">${escapeHtml(t('settings.ttsVoices'))}</span>
                <button id="gs-tts-reload" type="button" class="btn-secondary gs-mini">${escapeHtml(t('settings.reloadList'))}</button>
              </div>
              <div class="gs-card-body">
                <div class="gs-voice-grid">${voiceRows}</div>
                <p id="gs-voice-hint" class="gs-hint">${escapeHtml(t('settings.voiceLoadHint'))}</p>
              </div>
            </div>`)}
          ${panel('ai', 'settings.tabAi', 'settings.panelAiHint', '<div id="gs-ai-settings"></div>')}
          ${panel('tools', 'settings.tabTools', 'settings.panelToolsHint', `
            <div class="gs-card">
              <div class="gs-card-head">
                <span class="gs-card-title">${escapeHtml(t('settings.phoneticsTitle'))}</span>
                <a href="phonetics.html" target="_blank" rel="noopener">${escapeHtml(t('phonetics.independent'))}</a>
              </div>
              <div class="gs-card-body">
                <label class="gs-toggle">
                  <span class="gs-label">${escapeHtml(t('phonetics.enable'))}</span>
                  <input id="gs-phonetics-enabled" class="gs-visually-hidden" type="checkbox" ${settings.phoneticsEnabled ? 'checked' : ''}>
                  <span class="gs-switch" aria-hidden="true"></span>
                </label>
                <p class="gs-hint">${escapeHtml(t('phonetics.settingHint'))}</p>
              </div>
            </div>
            <div class="gs-card">
              <div class="gs-card-head">
                <span class="gs-card-title">${escapeHtml(t('settings.assistant'))}</span>
                <span class="gs-hint">${escapeHtml(t('settings.assistantHint'))}</span>
              </div>
              <div class="gs-card-body">
                <label class="gs-toggle" title="${escapeHtml(t('settings.assistantEntryTitle'))}">
                  <span class="gs-label">${escapeHtml(t('settings.enableAssistant'))}</span>
                  <input id="gs-assistant-enabled" class="gs-visually-hidden" type="checkbox" ${settings.assistantEnabled ? 'checked' : ''}>
                  <span class="gs-switch" aria-hidden="true"></span>
                </label>
                <label class="gs-toggle" title="${escapeHtml(t('settings.streamTitle'))}">
                  <span class="gs-label">${escapeHtml(t('settings.streaming'))}</span>
                  <input id="gs-assistant-stream" class="gs-visually-hidden" type="checkbox" ${settings.assistantStream === false ? '' : 'checked'}>
                  <span class="gs-switch" aria-hidden="true"></span>
                </label>
              </div>
            </div>
            ${isAdmin ? `<div class="gs-card">
              <div class="gs-card-head">
                <span class="gs-card-title">${escapeHtml(t('settings.adminUsersTitle'))}</span>
                <span class="gs-hint">${escapeHtml(t('settings.adminUsersHint'))}</span>
              </div>
              <div class="gs-card-body">
                <button type="button" class="btn-secondary" id="gs-admin-users">${escapeHtml(t('settings.adminUsersEntry'))}</button>
              </div>
            </div>` : ''}`)}
        </div>
      </div>
    </div>`;
  dom.modalBody.innerHTML = html;
  if (dom.modalActions) {
    dom.modalActions.hidden = false;
    dom.modalActions.innerHTML = `<div class="gs-footer">
      <span class="gs-saved" id="gs-saved" role="status" aria-live="polite"></span>
      <button type="button" class="btn-primary" id="gs-save">${escapeHtml(t('settings.done'))}</button>
    </div>`;
  }

  const $ = (sel) => dom.modalBody.querySelector(sel);
  const $$ = (sel) => Array.from(dom.modalBody.querySelectorAll(sel));
  const savedEl = () => dom.modalActions ? dom.modalActions.querySelector('#gs-saved') : null;

  const markSaved = () => {
    if (disposed) return;
    const el = savedEl();
    if (!el) return;
    el.classList.remove('failed');
    el.textContent = `${t('settings.autoSaved')} · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
  };
  const markFailed = () => {
    const el = savedEl();
    if (!el) return;
    el.classList.add('failed');
    el.textContent = t('settings.autoSaveFailed');
  };
  // 所有設定都走這裡：成功就更新底部狀態，失敗保留在使用者眼前而不是靜靜吞掉。
  const persist = (patch, secretPatch, options = {}) => {
    try {
      if (patch) saveGlobalSettings(patch);
      if (secretPatch) saveGlobalSecrets(secretPatch);
      if (options.silent !== true) markSaved();
      return true;
    } catch (_) {
      markFailed();
      return false;
    }
  };
  const debounce = (fn, wait = 500) => {
    let timer = 0;
    const run = () => { clearTimeout(timer); timer = 0; fn(); };
    const wrapped = () => { clearTimeout(timer); timer = setTimeout(run, wait); };
    wrapped.flush = () => { if (!timer) return; run(); };
    wrapped.cancel = () => { clearTimeout(timer); timer = 0; };
    return wrapped;
  };

  const setTab = (id) => {
    gsActiveTab = id;
    $$('[data-gs-tab]').forEach((btn) => {
      const on = btn.dataset.gsTab === id;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
      btn.tabIndex = on ? 0 : -1;
    });
    $$('[data-gs-panel]').forEach((panelEl) => { panelEl.hidden = panelEl.dataset.gsPanel !== id; });
    dom.modalBody.scrollTop = 0;
  };
  $$('[data-gs-tab]').forEach((btn) => btn.addEventListener('click', () => setTab(btn.dataset.gsTab)));
  const nav = $('.gs-nav');
  if (nav) {
    nav.addEventListener('keydown', (event) => {
      if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const ids = TABS.map((tab) => tab.id);
      const index = ids.indexOf(gsActiveTab);
      const next = event.key === 'Home' ? ids[0]
        : event.key === 'End' ? ids[ids.length - 1]
          : ids[(index + (event.key === 'ArrowDown' ? 1 : -1) + ids.length) % ids.length];
      setTab(next);
      $(`[data-gs-tab="${next}"]`)?.focus();
    });
  }

  // 介面語言：立即儲存並套用；面板文案是建立時以 t() 定稿，換語言就重建（保留分類）。
  $('#gs-interface-locale')?.addEventListener('change', (event) => {
    const value = event.target.value || 'zh-CN';
    if (!persist({ language: { interfaceLocale: value } })) return;
    try { setLocale(value, { persist: false }); } catch (_) {}
    try { document.dispatchEvent(new CustomEvent('bdc:settings-change')); } catch (_) {}
    destroyAIProviderSettings();
    showGlobalSettingsModal();
  });

  // 背景插畫：圖片本體只存本機 IndexedDB，切換配色會自動跟著換；顯示參數即時儲存
  let refreshArtStatus = () => {};
  (function wireThemeArt() {
    const pick = $('#gs-art-pick');
    const fileInput = $('#gs-art-file');
    const clearBtn = $('#gs-art-clear');
    const statusEl = $('#gs-art-status');
    const enabledInput = $('#gs-art-enabled');
    const strengthInput = $('#gs-art-strength');
    const blurInput = $('#gs-art-blur');
    const strengthValue = $('#gs-art-strength-value');
    const blurValue = $('#gs-art-blur-value');
    if (!pick || !fileInput || !statusEl) return;

    const currentThemeId = () => document.documentElement.dataset.theme || getSavedTheme();
    const artSettings = getArtSettings();
    if (enabledInput) enabledInput.checked = artSettings.enabled;
    const strengthPercent = Math.round(artSettings.strength * 100);
    if (strengthInput) strengthInput.value = String(strengthPercent);
    if (strengthValue) strengthValue.textContent = `${strengthPercent}%`;
    if (blurInput) blurInput.value = String(Math.round(artSettings.blur));
    if (blurValue) blurValue.textContent = `${Math.round(artSettings.blur)}px`;

    refreshArtStatus = async () => {
      const themeId = currentThemeId();
      const meta = await getThemeArtMeta(themeId);
      const builtin = getThemeDefaultArt(themeId);
      if (meta) {
        const size = meta.width && meta.height ? `${meta.width}×${meta.height}` : '';
        statusEl.textContent = [meta.name, size].filter(Boolean).join(' · ');
        statusEl.dataset.hasArt = 'true';
      } else if (builtin) {
        statusEl.textContent = t('settings.themeArtBuiltIn');
        statusEl.dataset.hasArt = 'true';
      } else {
        statusEl.textContent = t('settings.themeArtNone');
        delete statusEl.dataset.hasArt;
      }
      // 只有「自己選的圖」才需要移除；移除後回到主題內建圖
      if (clearBtn) clearBtn.hidden = !meta;
      if (enabledInput) enabledInput.disabled = !(meta || builtin);
    };

    pick.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const chosen = fileInput.files && fileInput.files[0];
      if (!chosen) return;
      pick.disabled = true;
      try {
        await setThemeArtFromFile(currentThemeId(), chosen);
        await applyThemeArt(currentThemeId());
      } catch (error) {
        const code = error && error.message;
        const key = code === 'too-large' ? 'settings.themeArtTooLarge'
          : code === 'unsupported-type' ? 'settings.themeArtBadType'
            : 'settings.themeArtFailed';
        ui.displayMessage(t(key), 'error', 4200);
      } finally {
        pick.disabled = false;
        fileInput.value = '';
        refreshArtStatus();
      }
    });
    clearBtn?.addEventListener('click', async () => {
      await removeThemeArt(currentThemeId());
      refreshArtStatus();
    });
    enabledInput?.addEventListener('change', () => {
      saveArtSettings({ enabled: enabledInput.checked });
      applyArtSettings();
    });
    strengthInput?.addEventListener('input', () => {
      const percent = Number(strengthInput.value);
      if (strengthValue) strengthValue.textContent = `${percent}%`;
      saveArtSettings({ strength: percent / 100 });
      applyArtSettings();
    });
    blurInput?.addEventListener('input', () => {
      const px = Number(blurInput.value);
      if (blurValue) blurValue.textContent = `${px}px`;
      saveArtSettings({ blur: px });
      applyArtSettings();
    });
    refreshArtStatus();
  })();

  // 品牌圖標：可為每套配色換上自己的小圖；沒設定就沿用主題內建的線性圖標
  let refreshIconStatus = () => {};
  (function wireThemeIcon() {
    const pick = $('#gs-icon-pick');
    const fileInput = $('#gs-icon-file');
    const clearBtn = $('#gs-icon-clear');
    const statusEl = $('#gs-icon-status');
    if (!pick || !fileInput || !statusEl) return;

    const currentThemeId = () => document.documentElement.dataset.theme || getSavedTheme();

    refreshIconStatus = async () => {
      const meta = await getThemeIconMeta(currentThemeId());
      if (meta) {
        const size = meta.width && meta.height ? `${meta.width}×${meta.height}` : '';
        statusEl.textContent = [meta.name, size].filter(Boolean).join(' · ');
        statusEl.dataset.hasArt = 'true';
      } else {
        statusEl.textContent = t('settings.brandIconNone');
        delete statusEl.dataset.hasArt;
      }
      if (clearBtn) clearBtn.hidden = !meta;
    };

    pick.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const chosen = fileInput.files && fileInput.files[0];
      if (!chosen) return;
      pick.disabled = true;
      try {
        await setThemeIconFromFile(currentThemeId(), chosen);
        await applyThemeArt(currentThemeId());
      } catch (error) {
        const code = error && error.message;
        const key = code === 'too-large' ? 'settings.themeArtTooLarge'
          : code === 'unsupported-type' ? 'settings.themeArtBadType'
            : 'settings.themeArtFailed';
        ui.displayMessage(t(key), 'error', 4200);
      } finally {
        pick.disabled = false;
        fileInput.value = '';
        refreshIconStatus();
      }
    });
    clearBtn?.addEventListener('click', async () => {
      await removeThemeIcon(currentThemeId());
      refreshIconStatus();
    });
    refreshIconStatus();
  })();

  // 主題：點一下就套用並寫入，不再有「預覽後按儲存」。
  const themeRow = $('#gs-theme-row');
  themeRow?.addEventListener('click', (event) => {
    const btn = event.target.closest('.gs-theme-btn');
    if (!btn) return;
    const applied = applyTheme(btn.getAttribute('data-theme-id'));
    themeRow.querySelectorAll('.gs-theme-btn').forEach((item) => {
      const on = item.getAttribute('data-theme-id') === applied;
      item.classList.toggle('active', on);
      item.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    persist({ theme: applied });
    refreshArtStatus();
    refreshIconStatus();
  });

  // 朗讀來源／自訂 URL
  const customWrap = $('#gs-tts-custom-wrap');
  const customInput = $('#gs-tts-url-custom');
  const currentTtsUse = () => $('#gs-tts-use-custom')?.checked ? 'custom' : ($('#gs-tts-use-local')?.checked ? 'local' : 'remote');
  const syncCustomWrap = () => { if (customWrap) customWrap.hidden = currentTtsUse() !== 'custom'; };
  const saveCustomUrl = debounce(() => {
    persist({ tts: { baseUrlCustom: String(customInput?.value || '').trim() } });
    loadVoices(false);
  }, 700);
  ['#gs-tts-use-remote', '#gs-tts-use-local', '#gs-tts-use-custom'].forEach((sel) => {
    $(sel)?.addEventListener('change', () => {
      const use = currentTtsUse();
      syncCustomWrap();
      persist({ tts: { use } });
      loadVoices(false);
    });
  });
  customInput?.addEventListener('input', saveCustomUrl);
  customInput?.addEventListener('change', () => saveCustomUrl.flush());

  // TTS 金鑰（只存本機）
  const keyInput = $('#gs-tts-key');
  const saveTtsKey = debounce(() => persist(null, { ttsApiKey: String(keyInput?.value || '').trim() }), 600);
  keyInput?.addEventListener('input', saveTtsKey);
  keyInput?.addEventListener('change', () => saveTtsKey.flush());

  // 讀音偏好
  ['#gs-read-en-gb', '#gs-read-en-us'].forEach((sel) => {
    $(sel)?.addEventListener('change', () => {
      const variant = $('#gs-read-en-us')?.checked ? 'en-US' : 'en-GB';
      if (persist({ reading: { englishVariant: variant } })) {
        try { document.dispatchEvent(new CustomEvent('bdc:settings-change')); } catch (_) {}
      }
    });
  });
  ['#gs-read-zh-cn', '#gs-read-zh-hk'].forEach((sel) => {
    $(sel)?.addEventListener('change', () => {
      const variant = $('#gs-read-zh-hk')?.checked ? 'zh-HK' : 'zh-CN';
      if (persist({ reading: { chineseVariant: variant } })) {
        try { document.dispatchEvent(new CustomEvent('bdc:settings-change')); } catch (_) {}
      }
    });
  });

  // 拼讀與助手
  $('#gs-phonetics-enabled')?.addEventListener('change', (event) => {
    if (persist({ phonetics: { enabled: event.target.checked === true } })) {
      try { document.dispatchEvent(new CustomEvent('bdc:settings-change')); } catch (_) {}
    }
  });
  $('#gs-assistant-enabled')?.addEventListener('change', (event) => {
    persist({ assistant: { enabled: event.target.checked === true } });
  });
  $('#gs-assistant-stream')?.addEventListener('change', (event) => {
    persist({ assistant: { stream: event.target.checked === true } });
  });
  $('#gs-admin-users')?.addEventListener('click', () => {
    openAdminUsersPanel();
  });

  // 聲音清單
  const VOICE_GROUPS = ['en-US', 'en-GB', 'zh-HK', 'zh-CN'];
  const voiceSelects = () => VOICE_GROUPS.map((group) => $(`[data-voice-group="${group}"]`));
  const voiceHint = () => $('#gs-voice-hint');
  const savedVoices = () => {
    try { return { ...(loadGlobalSettings()?.tts?.selectedVoices || {}) }; } catch (_) { return {}; }
  };
  let voiceRequest = 0;
  const setVoiceLoading = (on) => {
    voiceSelects().forEach((sel) => {
      if (!sel) return;
      if (on) sel.innerHTML = `<option value="">${escapeHtml(t('settings.loading'))}</option>`;
      sel.disabled = on;
    });
  };
  const fillVoices = (groups, stored) => {
    const saved = { ...stored };
    const pick = async () => (await import('../../modules/voices.js')).pickDefaultVoiceId;
    return pick().then((pickDefaultVoiceId) => {
      if (disposed) return null;
      VOICE_GROUPS.forEach((group) => {
        if (!saved[group] && groups[group] && groups[group].length) saved[group] = pickDefaultVoiceId(groups[group]);
      });
      voiceSelects().forEach((sel, index) => {
        const group = VOICE_GROUPS[index];
        if (!sel) return;
        const list = groups[group] || [];
        if (!list.length) {
          sel.innerHTML = `<option value="">${escapeHtml(t('settings.noAvailable'))}</option>`;
          sel.disabled = false;
          return;
        }
        sel.innerHTML = list.map((voice) => `<option value="${escapeHtml(voice.id)}">${escapeHtml(voice.__label || voice.id)}</option>`).join('');
        if (saved[group] && list.some((voice) => voice.id === saved[group])) sel.value = saved[group];
        if (!sel.value && sel.options.length) sel.selectedIndex = 0;
        sel.disabled = false;
      });
      return saved;
    });
  };
  const loadVoices = async (refresh = false) => {
    const seq = ++voiceRequest;
    setVoiceLoading(true);
    try {
      const { fetchVoicesList, groupVoices, formatVoiceLabel } = await import('../../modules/voices.js');
      const preferUse = currentTtsUse();
      const overrideBaseUrls = preferUse === 'custom'
        ? { custom: String(customInput?.value || '').trim() }
        : undefined;
      const list = await fetchVoicesList({ refresh, overrideUse: preferUse, overrideBaseUrls });
      if (disposed || seq !== voiceRequest) return;
      list.forEach((voice) => { voice.__label = formatVoiceLabel(voice); });
      const groups = groupVoices(list);
      const before = savedVoices();
      const missing = VOICE_GROUPS.some((group) => !before[group]);
      const filled = await fillVoices(groups, before);
      if (!filled || disposed || seq !== voiceRequest) return;
      // 首次載入選到的預設語音也直接寫入，避免「畫面上選了但其實沒存」。
      if (missing) persist({ tts: { selectedVoices: filled } }, null, { silent: true });
      const hint = voiceHint();
      if (hint) hint.textContent = t('settings.voicesLoaded', { count: list.length });
    } catch (error) {
      if (disposed || seq !== voiceRequest) return;
      voiceSelects().forEach((sel) => {
        if (!sel) return;
        sel.innerHTML = `<option value="">${escapeHtml(t('settings.loadFailed'))}</option>`;
        sel.disabled = false;
      });
      const hint = voiceHint();
      if (hint) hint.textContent = t('settings.loadFailedMessage', { message: (error && error.message) || '' });
    }
  };
  $('#gs-tts-reload')?.addEventListener('click', () => loadVoices(true));
  voiceSelects().forEach((sel) => {
    sel?.addEventListener('change', () => {
      const group = sel.getAttribute('data-voice-group');
      const current = savedVoices();
      current[group] = sel.value;
      persist({ tts: { selectedVoices: current } });
    });
  });

  // 試聽
  const playSamples = async (group) => {
    const hint = voiceHint();
    const sel = $(`[data-voice-group="${group}"]`);
    try {
      const { stopCurrentAudio, speakText, buildTTSUrl } = await import('../../modules/audio.js');
      stopCurrentAudio();
      let id = (sel && sel.value) ? sel.value : '';
      if (!id) id = savedVoices()[group] || '';
      if (!id) {
        try {
          const cfg = await import('../../ai-config.js');
          if (group === 'zh-HK') id = cfg?.TTS_CONFIG?.voices?.cantonese || '';
          else if (group === 'zh-CN') id = cfg?.TTS_CONFIG?.voices?.chinese || '';
          else id = cfg?.TTS_CONFIG?.voices?.english || '';
        } catch(_) {}
      }
      if (!id) { if (hint) hint.textContent = t('settings.noVoice'); return; }
      let text;
      if (group === 'en-US') text = 'This is a test voice.';
      else if (group === 'en-GB') text = 'This is a British English test voice.';
      // i18n-allow: 刻意用「該語音自己的語言」唸測試句（測粵語 voice 就用粵語句），不跟介面語言走
      else if (group === 'zh-HK') text = '呢個係測試語音。';
      // i18n-allow: 同上，測試句跟著語音語言
      else text = '這是一段測試語音。';
      const ok = await speakText(text, id, 0);
      if (!ok) {
        const url = buildTTSUrl(text, id, 0);
        try { console.debug('[TTS test]', group, id, url.replace(/(api_key=)[^&]+/, '$1***')); } catch(_) {}
        if (hint) hint.textContent = t('settings.playbackFailed');
      }
    } catch(error) {
      console.error('試聽失敗', error);
      // 後備：若該 id 不被後端支援，嘗試使用 ai-config 的預設粵/普語音
      try {
        const cfg = await import('../../ai-config.js');
        const { speakText } = await import('../../modules/audio.js');
        let fallback = '';
        if (group === 'zh-HK') fallback = cfg?.TTS_CONFIG?.voices?.cantonese || '';
        if (group === 'zh-CN') fallback = cfg?.TTS_CONFIG?.voices?.chinese || '';
        if (group === 'en-US') fallback = cfg?.TTS_CONFIG?.voices?.english || '';
        if (group === 'en-GB') {
          // 若未提供英音預設，回退到 english 也可接受
          fallback = cfg?.TTS_CONFIG?.voices?.english || '';
        }
        if (fallback) {
          // i18n-allow: 測試句刻意用該語音自己的語言，不跟介面語言
          const text = (group === 'zh-HK') ? '呢個係測試語音。' : (group === 'zh-CN' ? '這是一段測試語音。' : 'This is a test voice.');
          await speakText(text, fallback, 0);
          if (hint) hint.textContent = t('settings.fallbackVoice');
        }
      } catch(_) {}
    }
  };
  [['en-US', '#gs-test-en-us'], ['en-GB', '#gs-test-en-gb'], ['zh-HK', '#gs-test-zh-hk'], ['zh-CN', '#gs-test-zh-cn']]
    .forEach(([group, sel]) => $(sel)?.addEventListener('click', () => playSamples(group)));
  loadVoices(false);

  // AI 供應商面板
  destroyAIProviderSettings();
  aiProviderController = mountAIProviderSettings($('#gs-ai-settings'), {
    onRequestLogin: () => {
      destroyAIProviderSettings();
      try { showLoginModal(); } catch (_) {}
    }
  });

  // 關閉：把還在 debounce 的輸入（TTS 金鑰、自訂 URL）沖掉，避免最後一刻的修改遺失。
  const flushPending = () => {
    try { saveTtsKey.flush(); } catch (_) {}
    try { saveCustomUrl.flush(); } catch (_) {}
  };
  const onClosed = () => {
    disposed = true;
    flushPending();
    document.removeEventListener('bdc:modal-closed', onClosed);
  };
  document.addEventListener('bdc:modal-closed', onClosed);
  // 底部按鈕在 #modal-actions（不在 modalBody）裡，要用 footer 查詢。
  dom.modalActions?.querySelector('#gs-save')?.addEventListener('click', () => {
    flushPending();
    destroyAIProviderSettings();
    try { ui.closeModal(); } catch (_) {}
  });
  gsCleanup = () => {
    document.removeEventListener('bdc:modal-closed', onClosed);
    disposed = true;
    try { saveTtsKey.cancel(); } catch (_) {}
    try { saveCustomUrl.cancel(); } catch (_) {}
  };
}

function setGearLoginState(isLoggedIn, email) {
  if (!dom.appGearBtn) return;
  dom.appGearBtn.classList.toggle('is-logged-in', !!isLoggedIn);
  if (email) dom.appGearBtn.title = `${t('sync.settings')}（${email}）`; else dom.appGearBtn.title = t('sync.settings');
}

// 通行碼登入模式：不再需要郵件回跳處理與密碼重設 / 變更流程（已移除）

async function clearLocalCaches() {
  // 只清可重建的 AI 快取；文章、學習條目、詞書、筆記、聊天與文件都不受影響。
  const result = await cache.clearRebuildable();
  if (!result || !result.ok) throw new Error('cache_clear_failed');
}

function escapeHtml(s){
  return String(s||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// -----------------
// Assistant Sessions Modal
// -----------------
async function showAssistantSessions(){
  try { ui.openModal(); } catch(_) {}
  try { dom.modalTitle.textContent = t('menu.assistantSessions'); } catch(_) {}
  try { const mc = dom.appModal.querySelector('.modal-content'); if (mc) mc.classList.add('modal-large'); } catch(_) {}

  // 單次注入樣式（避免全局污染）
  (function injectStyle(){
    const id = 'assistant-sessions-style';
    if (document.getElementById(id)) return;
    const st = document.createElement('style'); st.id = id; st.textContent = `
      /* 左右兩欄的總容器固定高度，確保內部出現滾動條 */
      #as-layout{display:grid;grid-template-columns:280px 1fr;gap:12px;height:72vh;overflow:hidden}
      #as-left-wrap{display:flex;flex-direction:column;gap:8px;height:100%}
      #as-left{border:1px solid var(--line);border-radius:var(--r-sm);overflow:auto;background:var(--surface);flex:1}
      #as-right{border:1px solid var(--line);border-radius:var(--r-sm);background:var(--surface);display:flex;flex-direction:column;height:100%;overflow:hidden;position:relative}
      #as-right-body{flex:1;padding:10px;overflow:auto;font-size:var(--fs-sm);display:flex;flex-direction:column;gap:2px}
      #as-right-toolbar{position:sticky;bottom:0;background:var(--surface);border-top:1px solid var(--line);padding:8px;display:flex;gap:6px;align-items:center}
      #as-right-toolbar .btn{padding:6px 10px;font-size:var(--fs-xs)}
      #as-left-toolbar .btn{padding:6px 8px;font-size:var(--fs-xs)}
      #as-question{flex:1;border:1px solid var(--line-strong);border-radius:var(--r-xs);padding:6px 8px;min-width:120px}
      #as-left .as-item{padding:10px 12px;border-bottom:1px dashed var(--line);cursor:pointer}
      #as-left .as-item.active{background:var(--surface-3)}
      /* 預覽面板的 markdown 基本樣式（若未載入 assistant 風格時的降級樣式） */
      #as-right-body .assistant-msg{white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;padding:10px 12px;border-radius:var(--r-md);margin:4px 0;box-sizing:border-box}
      #as-right-body .assistant-user{background:var(--primary-050);color:var(--ink-800);border:1px solid var(--primary-100);align-self:flex-end;box-shadow:inset -3px 0 0 var(--primary)}
      #as-right-body .assistant-assistant{background:var(--surface-2);color:var(--ink-800);border:1px solid var(--line);align-self:flex-start;box-shadow:inset 3px 0 0 var(--line-strong)}
      #as-right-body .assistant-msg{max-width:86%}
      #as-right-body .assistant-msg pre{background:var(--ink-900);color:var(--paper-2);border:1px solid var(--ink-900);border-radius:var(--r-sm);padding:12px 14px;overflow:auto;position:relative}
      #as-right-body .assistant-msg .assistant-copy{position:absolute;top:8px;right:8px;font-size:var(--fs-xs);padding:4px 8px;border-radius:var(--r-xs);border:1px solid var(--ink-600);background:var(--ink-900);color:var(--ink-300);opacity:.85;cursor:pointer}
      #as-right-body .assistant-msg .assistant-copy:hover{opacity:1}
      @media (max-width: 768px){
        #as-layout{grid-template-columns:1fr;height:70vh}
        #as-right{order:1;height:100%}
        #as-left-wrap{order:2}
        #as-left{max-height:30vh}
      }
    `; document.head.appendChild(st);
  })();

  // 讀取索引
  let index = listAssistantConversationMetas();
  if (!Array.isArray(index)) index = [];

  const layout = document.createElement('div');
  layout.id = 'as-layout';
  const leftWrap = document.createElement('div'); leftWrap.id = 'as-left-wrap';
  const leftToolbar = document.createElement('div'); leftToolbar.id = 'as-left-toolbar'; leftToolbar.style.cssText='display:flex;gap:6px;flex-wrap:wrap;';
  leftToolbar.innerHTML = `<button id="as-new" class="btn primary" style="padding:6px 8px;font-size:12px;">${t('assistant.new')}</button>
  <input id="as-import" type="file" accept="application/json" style="display:none"><button id="as-import-btn" class="btn secondary" style="padding:6px 8px;font-size:12px;">${t('assistant.import')}</button>
  <span style="flex:1"></span>
  <button id="as-rename" class="btn tertiary" title="${t('assistant.modifyTitle')}" style="padding:6px 8px;font-size:12px;">${t('assistant.rename')}</button>
  <button id="as-delete" class="btn danger" title="${t('assistant.delete')}" style="padding:6px 8px;font-size:12px;">${t('assistant.delete')}</button>`;
  const left = document.createElement('div'); left.id = 'as-left';
  leftWrap.appendChild(leftToolbar); leftWrap.appendChild(left);
  const right = document.createElement('div'); right.id = 'as-right';

  left.innerHTML = index.length ? index.map(m => {
    const title = (m.articleKey==='global' ? `${t('assistant.global')} · ` : '') + (m.title || t('assistant.session'));
    const time = formatDateTime(m.updatedAt || Date.now());
    return `<div class="as-item" data-id="${m.id}" title="${t('sync.sessionItemTitle')}">
      <div style="font-weight:600;color:var(--ink-800);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(title)}</div>
      <div style="font-size:12px;color:var(--ink-500);">${time}</div>
    </div>`;
  }).join('') : `<div style="padding:12px;color:var(--ink-500);">${t('assistant.noSessions')}</div>`;

  layout.appendChild(leftWrap); layout.appendChild(right);
  dom.modalBody.innerHTML=''; dom.modalBody.appendChild(layout);

  let currentId = '';
  let currentArticleKey = '';
  const rightBody = document.createElement('div'); rightBody.id = 'as-right-body';
  const rightToolbar = document.createElement('div'); rightToolbar.id = 'as-right-toolbar';
  rightToolbar.innerHTML = `<button id="as-open" class="btn primary" style="padding:6px 10px;font-size:12px;">${t('assistant.continueInAssistant')}</button>
  <button id="as-export" class="btn secondary" style="padding:6px 10px;font-size:12px;">${t('assistant.export')}</button>
  <input id="as-question" type="text" placeholder="${t('assistant.questionPlaceholder')}" style="flex:1;border:1px solid var(--line-strong);border-radius:8px;padding:6px 8px;">
  <button id="as-send" class="btn primary" style="padding:6px 10px;font-size:12px;">${t('assistant.send')}</button>`;
  right.appendChild(rightBody); right.appendChild(rightToolbar);

  async function renderConversation(id){
    currentId = id; const meta = index.find(x=>x.id===id) || {}; currentArticleKey = meta.articleKey || 'global';
    rightBody.innerHTML = `<div style="padding:8px;color:var(--ink-500);">${t('assistant.loading')}</div>`;
    try {
      const msgs = await getAssistantConversationMessages(id);
      const html = msgs.map(m => {
        if (m.role === 'assistant') return `<div class=\"assistant-msg assistant-assistant\">${markdownToHtml(m.content||'')}</div>`;
        return `<div class=\"assistant-msg assistant-user\">${escapeHtml(m.content||'')}</div>`;
      }).join('');
      rightBody.innerHTML = html || `<div style="padding:8px;color:var(--ink-500);">${t('assistant.emptySession')}</div>`;
      // 為預覽面板中的程式碼塊補上複製按鈕
      try { rightBody.querySelectorAll('pre').forEach(pre => {
        if (pre.querySelector('.assistant-copy')) return;
        const code = pre.querySelector('code');
        const btn = document.createElement('button');
        btn.className = 'assistant-copy'; btn.textContent = t('assistant.copy');
        btn.addEventListener('click', async () => {
          try { const txt = code ? code.innerText : pre.innerText; await navigator.clipboard.writeText(txt); btn.textContent=t('assistant.copied'); setTimeout(()=> btn.textContent=t('assistant.copy'), 1200); } catch(_) {}
        });
        pre.appendChild(btn);
      }); } catch(_) {}
    } catch(e) { rightBody.innerHTML = `<div style="padding:8px;color:var(--danger);">${t('assistant.loadFailed')}</div>`; }
  }

  left.addEventListener('click', (ev) => {
    const it = ev.target.closest('.as-item'); if (!it) return; const id = it.getAttribute('data-id');
    // 高亮選中項（避免逐一寫 style）
    left.querySelectorAll('.as-item').forEach(x => x.classList.remove('active')); it.classList.add('active');
    renderConversation(id);
  });

  // 需求：直接點擊開啟助手彈窗。為保留左側預覽體驗，採用「雙擊」打開；單擊仍為預覽。
  left.addEventListener('dblclick', (ev) => {
    const it = ev.target.closest('.as-item'); if (!it) return; const id = it.getAttribute('data-id');
    const meta = index.find(x=>x.id===id)||{};
    try { window.__assistant && window.__assistant.open('modal'); window.__assistant && window.__assistant.switch(meta.articleKey||'global', id); } catch(_){}
  });

  const first = left.querySelector('.as-item'); if (first) first.click();

  // 新建
  leftToolbar.querySelector('#as-new').addEventListener('click', async () => {
    const ak = prompt(t('assistant.articleKeyPrompt'),'') || '';
    const articleKey = ak.trim() ? ak.trim() : 'global';
    const title = prompt(t('assistant.sessionName'), t('assistant.newSession')) || t('assistant.newSession');
    try {
      const meta = await createAssistantConversation({ articleKey, title, messages: [] });
      if (!meta) throw new Error('create_failed');
      index = listAssistantConversationMetas();
      left.innerHTML += `<div class="as-item" data-id="${meta.id}" style="padding:10px 12px;border-bottom:1px dashed var(--line);cursor:pointer;"><div style="font-weight:600;color:var(--ink-800);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml((articleKey==='global'?t('sync.globalPrefix'):'')+meta.title)}</div><div style="font-size:12px;color:var(--ink-500);">${formatDateTime(meta.updatedAt || Date.now())}</div></div>`;
    } catch(_) {}
  });
  // 匯入
  leftToolbar.querySelector('#as-import-btn').addEventListener('click', ()=> leftToolbar.querySelector('#as-import').click());
  leftToolbar.querySelector('#as-import').addEventListener('change', async (ev) => {
    const f = ev.target.files && ev.target.files[0]; if (!f) return;
    try {
      const text = await f.text(); const json = JSON.parse(text||'{}');
      const articleKey = json.articleKey || 'global'; const title = json.title || t('assistant.importedSession'); const messages = Array.isArray(json.messages)? json.messages: [];
      const meta = await createAssistantConversation({ articleKey, title, messages });
      if (!meta) throw new Error('create_failed');
      index = listAssistantConversationMetas();
      left.innerHTML += `<div class="as-item" data-id="${meta.id}" style="padding:10px 12px;border-bottom:1px dashed var(--line);cursor:pointer;"><div style="font-weight:600;color:var(--ink-800);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml((articleKey==='global'?t('sync.globalPrefix'):'')+meta.title)}</div><div style="font-size:12px;color:var(--ink-500);">${formatDateTime(meta.updatedAt || Date.now())}</div></div>`;
    } catch(e) { ui.displayMessage(t('assistant.importFailed', { message: e?.message || '' }), 'error'); }
  });
  // 重命名
  leftToolbar.querySelector('#as-rename').addEventListener('click', async () => {
    const active = left.querySelector('.as-item.active');
    const id = active ? active.getAttribute('data-id') : (currentId || '');
    if (!id) { ui.displayMessage(t('assistant.selectSession'), 'warning'); return; }
    const meta = index.find(x => x.id === id) || null; if (!meta) return;
    const newTitle = prompt(t('assistant.renamePrompt'), meta.title || t('assistant.session'));
    if (!newTitle || !newTitle.trim()) return;
    const updated = await renameAssistantConversation(id, newTitle.trim());
    if (!updated) return;
    index = listAssistantConversationMetas();
    const item = left.querySelector(`.as-item[data-id="${id}"]`);
    if (item) {
      const titleDiv = item.querySelector('div');
      if (titleDiv) titleDiv.textContent = (updated.articleKey === 'global' ? t('sync.globalPrefix') : '') + updated.title;
      const timeDiv = item.querySelector('div:nth-child(2)');
      if (timeDiv) timeDiv.textContent = formatDateTime(updated.updatedAt || Date.now());
    }
  });
  // 刪除
  leftToolbar.querySelector('#as-delete').addEventListener('click', async () => {
    const active = left.querySelector('.as-item.active');
    const id = active ? active.getAttribute('data-id') : (currentId || '');
    if (!id) { ui.displayMessage(t('assistant.selectSession'), 'warning'); return; }
    const okDeleteConv = await ui.confirmAction({
      title: t('assistant.delete'),
      message: t('assistant.confirmDelete'),
      confirmLabel: t('assistant.delete'),
      cancelLabel: t('common.cancel'),
      danger: true
    });
    if (!okDeleteConv) return;
    try {
      const removed = await deleteAssistantConversation(id);
      if (!removed) throw new Error(t('assistant.sessionMissing'));
      index = listAssistantConversationMetas();
      const node = left.querySelector(`.as-item[data-id="${id}"]`);
      if (node) node.remove();
      if (!left.querySelector('.as-item')) left.innerHTML = `<div style="padding:12px;color:var(--ink-500);">${t('assistant.noSessions')}</div>`;
      if (currentId === id) { currentId = ''; rightBody.innerHTML = `<div style="padding:8px;color:var(--ink-500);">${t('assistant.noSelection')}</div>`; }
    } catch (e) { ui.displayMessage(t('assistant.deleteFailed', { message: e?.message || '' }), 'error'); }
  });
  // 匯出
  rightToolbar.querySelector('#as-export').addEventListener('click', async () => {
    if (!currentId) return;
    const meta = index.find(x=>x.id===currentId) || { articleKey:'global', title:t('assistant.session') };
    try {
      const messages = await getAssistantConversationMessages(currentId);
      const blob = new Blob([JSON.stringify({ articleKey: meta.articleKey, title: meta.title, messages }, null, 2)], { type:'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `assistant-conv-${currentId}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch(_) {}
  });
  // 在助手中繼續 + 直接發送
  rightToolbar.querySelector('#as-open').addEventListener('click', () => { if (!currentId) return; const meta = index.find(x=>x.id===currentId)||{}; try { window.__assistant && window.__assistant.open('modal'); window.__assistant && window.__assistant.switch(meta.articleKey||'global', currentId); } catch(_){} });
  rightToolbar.querySelector('#as-send').addEventListener('click', () => {
    if (!currentId) return;
    const inputEl = rightToolbar.querySelector('#as-question');
    const q = inputEl.value.trim();
    if (!q) return;
    const meta = index.find(x=>x.id===currentId)||{};
    try {
      window.__assistant && window.__assistant.send(q, meta.articleKey||'global', currentId);
    } catch(_){}
    // UX：發送之後清空輸入框
    try { inputEl.value = ''; } catch(_){}
  });
}

// -----------------
// Auto sync & Realtime
// -----------------
let autoTimer = null;
let autoDueAt = 0;
let pendingAutoReason = '';
let lastLocalChangeAt = 0;
let lastSyncAt = 0;
let syncInFlight = false;
let queuedWhileInFlight = false;
const DEBOUNCE_MS = 6000; // 6s after last change
const MIN_INTERVAL_MS = 20000; // at least 20s between sync runs
let rtChannel = null;
let rtThrottled = 0;

function clearAutoTimer() {
  if (!autoTimer) return;
  clearTimeout(autoTimer);
  autoTimer = null;
}

function extractTouchedGroup(reason) {
  if (typeof reason !== 'string') return '';
  if (reason.startsWith('data:')) return reason.slice(5) || '';
  return '';
}

function runAutoSyncTimer() {
  autoTimer = null;
  autoDueAt = 0;
  const reason = pendingAutoReason || 'debounce';
  pendingAutoReason = '';
  doAutoSync(reason);
}

function scheduleAutoSync(reason) {
  if (pendingMergePaused) {
    updateStatus(t('sync.mergePendingStatus'));
    return;
  }
  const now = Date.now();
  const group = extractTouchedGroup(reason);
  const isLocalDataChange = !!group;
  if (isLocalDataChange) {
    lastLocalChangeAt = now;
  }

  if (!pendingAutoReason || isLocalDataChange) {
    pendingAutoReason = reason || 'debounce';
  }

  if (syncInFlight) {
    if (isLocalDataChange) {
      queuedWhileInFlight = true;
    }
    return;
  }

  let nextDue = now;
  if (isLocalDataChange) {
    const debounceBase = lastLocalChangeAt || now;
    const debounceDue = debounceBase + DEBOUNCE_MS;
    const minDue = lastSyncAt > 0 ? lastSyncAt + MIN_INTERVAL_MS : now;
    nextDue = Math.max(debounceDue, minDue);
  }
  const wait = Math.max(0, nextDue - now);

  if (autoTimer && autoDueAt === nextDue) return;

  clearAutoTimer();
  autoDueAt = nextDue;
  autoTimer = setTimeout(runAutoSyncTimer, wait);
}

async function doAutoSync(reason) {
  if (pendingMergePaused) return;
  const { data } = await auth.getSession();
  if (!data?.session) return; // not logged in
  if (syncInFlight) {
    queuedWhileInFlight = true;
    return;
  }
  let guard = null;
  try {
    syncInFlight = true;
    beginSyncRound();
    updateStatus(t('sync.autoSyncing'));
    guard = createSyncGuard();
    // 先跑文章同步：舊快照裡的文章群組必須先匯入逐篇儲存，推送快照才不會把它刪掉。
    const articlePhase = await runArticleSyncPhase();
    if (guard.stale()) return;
    const readingPhase = await runReadingSyncPhase();
    if (guard.stale()) return;
    const info = await syncNow(guard.build, guard.apply);
    if (guard.stale()) return;
    lastSyncAt = Date.now();
    try { localStorage.setItem('lastSnapshotAt', String(lastSyncAt)); } catch(_) {}
    if (info && typeof info.version === 'number') {
      try { localStorage.setItem('lastSnapshotVersion', String(info.version)); } catch(_) {}
    }
    const completion = resolveSyncCompletion({
      manual: false,
      restoredFromRemote: !!(info && info.restoredFromRemote),
      articleOk: articlePhase.ok === true,
      articlePending: articlePhase.pending === true,
      readingUnsupported: !!(readingPhase && !readingPhase.ok && readingPhase.info?.unsupported)
    });
    updateStatus(t(completion.statusKey));
    if (completion.toastKey) {
      try { ui.displayMessage(t(completion.toastKey), completion.toastLevel, completion.toastMs); } catch(_) {}
    }
    // 自動同步成功不再彈出提示，避免干擾（失敗的提示由上面的判斷決定）。
    // 備份不佔用同步鎖：排到本輪結束、鎖釋放後才執行，且由資料版本去重。
    scheduleBackupAfterSync(t('sync.backupNoteAuto'));
  } catch (e) {
    if (e && e.code === 'stale_session') {
      updateStatus(t('sync.loggedOutState'));
    } else if (e && e.code === 'unauthorized') {
      if (!(guard && guard.stale())) await auth.invalidateSession();
      updateStatus(t('sync.loggedOutState'));
    } else {
      console.warn('[sync] auto sync failed:', e);
      updateStatus(t('sync.autoSyncFailed'));
    }
  } finally {
    endSyncRound();
    syncInFlight = false;
    if (queuedWhileInFlight) {
      queuedWhileInFlight = false;
      scheduleAutoSync('data:queued');
    }
  }
}

/**
 * 同步完成後才建立自動備份：不阻塞 syncInFlight 的釋放，也不影響下一輪觸發。
 * createBackup 本身會用資料版本簽章去重，沒變更時直接跳過。
 */
function scheduleBackupAfterSync(note) {
  setTimeout(() => {
    try {
      backup.createBackup(note).catch(() => {});
    } catch (_) {}
  }, 0);
}

// SVG icons
function svgSync(){
  return '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 1 1 .908.418A6 6 0 1 1 8 2v1z"/><path d="M8 0a.5.5 0 0 1 .5.5v3.707l1.146-1.147a.5.5 0 0 1 .708.708L8.354 5.768a.5.5 0 0 1-.708 0L5.646 3.768a.5.5 0 1 1 .708-.708L7.5 4.207V.5A.5.5 0 0 1 8 0z"/></svg>';
}
function svgLogin(){
  return '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 12a1 1 0 0 0 1-1V9H7.5a.5.5 0 0 1 0-1H11V5a1 1 0 0 0-1-1H5a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2z"/><path d="M13.354 8.354a.5.5 0 0 0 0-.708L11.172 5.464a.5.5 0 0 0-.708.708L12.293 8l-1.829 1.828a.5.5 0 1 0 .708.708z"/></svg>';
}
function svgLogout(){
  return '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 12a1 1 0 0 0 1-1V9H7.5a.5.5 0 0 1 0-1H11V5a1 1 0 0 0-1-1H5a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2z"/><path d="M11.146 5.146a.5.5 0 0 1 .708 0L14 7.293a1 1 0 0 1 0 1.414l-2.146 2.147a.5.5 0 1 1-.708-.708L12.793 8l-1.647-1.646a.5.5 0 0 1 0-.708z"/></svg>';
}
function svgGear(){
  return '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.405 1.05c-.413-1.4-2.397-1.4-2.81 0l-.1.34a1 1 0 0 1-.52.63l-.31.15c-1.283.62-1.283 2.39 0 3.01l.31.15a1 1 0 0 1 .52.63l.1.34c.413 1.4 2.397 1.4 2.81 0l.1-.34a1 1 0 0 1 .52-.63l.31-.15c1.283-.62 1.283-2.39 0-3.01l-.31-.15a1 1 0 0 1-.52-.63zM8 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"/><path d="M4.754 9.036a1 1 0 0 0-.417 1.341l.176.352a1 1 0 0 1 0 .542l-.176.352a1 1 0 0 0 .417 1.341l.352.176a1 1 0 0 1 .352.293l.243.303c.936 1.166 2.764.58 2.764-.954V12.5a1 1 0 0 1 .293-.707l.303-.243a1 1 0 0 1 .352-.293l.352-.176a1 1 0 0 0 .417-1.341l-.176-.352a1 1 0 0 1 0-.542l.176-.352a1 1 0 0 0-.417-1.341l-.352-.176a1 1 0 0 1-.352-.293l-.303-.243A1 1 0 0 1 8.5 7h-.5a1 1 0 0 1-.707.293l-.303.243a1 1 0 0 1-.352.293z"/></svg>';
}
function svgHistory(){
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M8 3a5 5 0 1 1-4.546 2.914.5.5 0 0 0-.908-.417A6 6 0 1 0 8 2v1z"/><path d="M7.5 8V5h1v3h2v1h-3z"/></svg>';
}
function svgTrash(){
  return '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.5 1h3a.5.5 0 0 1 .5.5V3h3a.5.5 0 0 1 0 1H3a.5.5 0 0 1 0-1h3V1.5a.5.5 0 0 1 .5-.5z"/><path d="M5.5 5a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-1 0v-7a.5.5 0 0 1 .5-.5zm5 0a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-1 0v-7a.5.5 0 0 1 .5-.5z"/><path d="M4.118 4.5 4 14a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2l-.118-9.5H4.118z"/></svg>';
}
function svgSave(){
  return '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 1a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V4.5a1 1 0 0 0-.293-.707l-2.5-2.5A1 1 0 0 0 11.5 1H2z"/><path d="M2 1h9.5v4A1.5 1.5 0 0 1 10 6.5H6A1.5 1.5 0 0 1 4.5 5V1"/><path d="M4 10h8v4H4z"/></svg>';
}
function svgRestore(){
  return '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3a5 5 0 1 0 3.905 8.12.5.5 0 1 1 .79.612A6 6 0 1 1 8 2v1z"/><path d="M8 0a.5.5 0 0 1 .5.5v3.793l1.146-1.147a.5.5 0 0 1 .708.708L8.354 5.71a.5.5 0 0 1-.708 0L5.646 3.854a.5.5 0 1 1 .708-.708L7.5 4.293V.5A.5.5 0 0 1 8 0z"/></svg>';
}
function svgChat(){
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3C6.5 3 2 6.8 2 11.6c0 1.9.7 3.7 1.9 5.2L3 21l4.2-1.8c1.4.5 3 .8 4.8.8 5.5 0 10-3.8 10-8.6S17.5 3 12 3z"/></svg>';
}

// Key icon for change password
function svgKey(){
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 7a5 5 0 1 1-9.9 1H9L5 12v3H2v4h4v-3h3l4-4v-2.1A5 5 0 0 1 21 7Zm-3 0a2 2 0 1 0-4 0 2 2 0 0 0 4 0Z"/></svg>';
}

function attachRealtime(user) {
  try { if (rtChannel) { unsubscribeChannel(rtChannel); rtChannel = null; } } catch(_) {}
  if (!user || !user.id) return;
  rtChannel = subscribeSnapshotChanges(user.id, (payload) => {
    const now = Date.now();
    // throttle realtime triggers (min every 5s)
    if (now - rtThrottled < 5000) return;
    rtThrottled = now;
    console.log('[sync] realtime change:', payload?.eventType || 'update');
    scheduleAutoSync('realtime');
  });
}

// -----------------
// Backup/Restore UI
// -----------------
function showBackupRestoreModal() {
  try { ui.openModal(); } catch(_) {}
  try { dom.modalTitle.textContent = t('sync.backupTitle'); } catch(_) {}
  const items = (function(){ try { return backup.listBackups(); } catch(_) { return []; } })();
  const listHtml = items.length ? items.map(it => {
    const timeStr = formatDateTime(parseInt(it.ts, 10) || Date.now());
    const sizeKB = Math.round((it.size||0)/102.4)/10; // 1 decimal
    const mkBadge = (text, color) => `<span class="bk-badge" style="display:inline-block;padding:1px 6px;margin-left:6px;border-radius:999px;font-size:11px;background:${color.bg};color:${color.fg};border:1px solid ${color.bd};vertical-align:middle;">${escapeHtml(text)}</span>`;
    let noteHtml = '';
    if (it.note) {
      if (/自動同步|自动同步/.test(it.note)) noteHtml = mkBadge(it.note, { bg:'var(--info-050)', fg:'var(--info)', bd:'var(--info)' });
      else if (/手動|手动/.test(it.note)) noteHtml = mkBadge(it.note, { bg:'var(--ok-050)', fg:'var(--ok-600)', bd:'var(--ok)' });
      else noteHtml = `<span style="margin-left:6px;color:var(--ink-500);">${escapeHtml(it.note)}</span>`;
    }
    return `<div class="backup-item" data-id="${it.id}" style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px dashed var(--line);">
      <div class="bi-meta">
        <div class="bi-title">${timeStr}${noteHtml}</div>
        <div class="bi-sub" style="color:var(--ink-500);font-size:12px;">ID: ${it.id} · ${t('sync.approximately', { size: sizeKB })}</div>
      </div>
      <div class="bi-actions" style="display:flex;gap:6px;">
        <button class="btn-secondary bi-restore" data-id="${it.id}">${t('sync.restore')}</button>
        <button class="btn-tertiary bi-export" data-id="${it.id}">${t('sync.export')}</button>
        <button class="btn-danger bi-delete" data-id="${it.id}">${t('sync.delete')}</button>
      </div>
    </div>`;
  }).join('') : `<div style="color:var(--ink-500);padding:8px 0;">${t('sync.noBackups')}</div>`;

  const html = `
    <div class="backup-modal" style="min-width:340px;">
      <div class="backup-list">${listHtml}</div>
      <div class="auth-actions" style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
        <button id="bk-close" class="btn-secondary">${t('sync.close')}</button>
        <button id="bk-create" class="btn-primary">${t('sync.createBackup')}</button>
        <input id="bk-import" type="file" accept="application/json,.json" style="display:none">
        <button id="bk-import-btn" class="btn-secondary">${t('sync.importBackup')}</button>
        <button id="bk-clear-cache" class="btn-tertiary">${t('sync.clearCache')}</button>
      </div>
      <div id="bk-msg" class="auth-msg"></div>
    </div>`;
  dom.modalBody.innerHTML = html;
  const $ = (sel)=> dom.modalBody.querySelector(sel);
  $('#bk-close').onclick = () => ui.closeModal();
  $('#bk-create').onclick = async () => {
    const msg = $('#bk-msg');
    try { const result = await backup.createBackup('manual'); if (result && result.error) throw result.error; msg.textContent = t('sync.backupCreated'); setTimeout(()=> showBackupRestoreModal(), 300); } catch (e) { msg.textContent = t('sync.backupCreateFailed', { message: e?.message || '' }); }
  };
  // 從檔案匯入備份：先存入本機備份列表（標記手動，不會被自動裁剪），再由使用者點「還原」套用
  const bkImport = $('#bk-import');
  $('#bk-import-btn').onclick = () => { try { if (bkImport) bkImport.value = ''; } catch(_) {} try { bkImport && bkImport.click(); } catch(_) {} };
  if (bkImport) bkImport.onchange = () => {
    const msg = $('#bk-msg');
    const file = bkImport.files && bkImport.files[0];
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) { msg.textContent = t('sync.fileTooLarge'); return; }
    const reader = new FileReader();
    reader.onerror = () => { msg.textContent = t('sync.readFileFailed'); };
    reader.onload = () => {
      let parsed;
      try { parsed = JSON.parse(String(reader.result || '')); }
      catch (_) { msg.textContent = t('sync.invalidJson'); return; }
      // 相容三種格式：原始 payload / 完整快照 {payload} / 備份包 {ts,note,payload}
      const payload = (parsed && typeof parsed === 'object' && parsed.payload && typeof parsed.payload === 'object')
        ? parsed.payload : parsed;
      const KNOWN = ['userSettings', 'dictation', 'vocabulary', 'articles', 'qa', 'assistant', 'reading', 'articleDocuments'];
      const ok = payload && typeof payload === 'object'
        && KNOWN.some(k => payload[k] && typeof payload[k] === 'object');
      if (!ok) { msg.textContent = t('sync.invalidBackup'); return; }
      const res = backup.saveBackupPayload(payload, t('sync.backupNoteImport'));
      if (res && res.error) { msg.textContent = t('sync.importWriteFailed', { message: res.error?.message || t('sync.unknownError') }); return; }
      try { ui.displayMessage(t('sync.backupImported'), 'success'); } catch(_) {}
      showBackupRestoreModal();
    };
    reader.readAsText(file);
  };
  $('#bk-clear-cache').onclick = async () => {
    const msg = $('#bk-msg');
    try { await clearLocalCaches(); msg.textContent = t('sync.cacheCleared'); } catch (e) { msg.textContent = t('sync.clearFailed', { message: e?.message || '' }); }
  };
  // actions
  dom.modalBody.querySelectorAll('.bi-restore').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id');
      try {
        const payload = backup.loadBackupPayload(id);
        if (!payload) { try { ui.displayMessage(t('sync.backupMissing'), 'error'); } catch(_) {} return; }
        await restoreSnapshotLocally(payload);
        try { lastSyncAt = Date.now(); localStorage.setItem('lastSnapshotAt', String(lastSyncAt)); } catch(_) {}
        updateStatus(t('sync.restoredLocal'));
        try { ui.displayMessage(t('sync.restoredLocal'), 'success'); } catch(_) {}
        ui.closeModal();
      } catch (e) {
        try { ui.displayMessage(t('sync.restoreFailed', { message: e?.message || '' }), 'error'); } catch(_) {}
      }
    });
  });
  dom.modalBody.querySelectorAll('.bi-export').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      const payload = backup.loadBackupPayload(id);
      if (!payload) { try { ui.displayMessage(t('sync.backupMissing'), 'error'); } catch(_) {} return; }
      try {
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `bdc-backup-${id}.json`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        try { ui.displayMessage(t('sync.backupExported'), 'success'); } catch(_) {}
      } catch (_) { try { ui.displayMessage(t('sync.exportFailed'), 'error'); } catch(_) {} }
    });
  });
  dom.modalBody.querySelectorAll('.bi-delete').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      try { backup.deleteBackup(id); showBackupRestoreModal(); try { ui.displayMessage(t('sync.backupDeleted'), 'success'); } catch(_) {} } catch (_) { try { ui.displayMessage(t('sync.deleteFailed'), 'error'); } catch(_) {} }
    });
  });
}
