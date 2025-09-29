// Minimal UI wiring for Supabase-based sync (Scheme C)
// Provides: Login (Email OTP), Logout, and "Sync Now" button

import * as dom from '../../modules/dom.js';
import { buildLocalSnapshot, applyMergedSnapshot } from '../../modules/sync-core.js';
import { syncNow, auth, subscribeSnapshotChanges, unsubscribeChannel } from '../../modules/sync-supabase.js';
import * as ui from '../../modules/ui.js';

export function initSync() {
  try {
    console.log('[sync] initSync()');
    wireAuthUI();
    if (dom.syncNowBtn) {
      dom.syncNowBtn.addEventListener('click', handleSync);
    } else {
      console.warn('[sync] syncNowBtn not found');
    }
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

  if (dom.logoutBtn) dom.logoutBtn.addEventListener('click', async () => {
    try { await auth.signOut(); } catch (_) {}
    updateAuthButtons(null);
    updateStatus('已登出');
  });

  auth.onAuthStateChange((_e, session) => {
    const user = session?.user || null;
    updateAuthButtons(user);
    updateStatus(user ? (user.email || '已登入') : '未登入');
    attachRealtime(user);
  });

  // 初始化一次（避免等待事件）
  auth.getSession().then(({ data }) => {
    const user = data?.session?.user || null;
    updateAuthButtons(user);
    updateStatus(user ? (user.email || '已登入') : '未登入');
    attachRealtime(user);
  }).catch(() => {});
}

async function handleSync() {
  console.log('[sync] handleSync()');
  // 必須登入後才能同步
  const { data } = await auth.getSession();
  if (!data?.session) {
    updateStatus('請先登入');
    alert('請先登入');
    return;
  }

  try {
    setBusy(true);
    updateStatus('同步中...');
    await syncNow(buildLocalSnapshot, applyMergedSnapshot);
    lastSyncAt = Date.now();
    updateStatus('已完成同步');
  } catch (e) {
    console.warn(e);
    updateStatus('同步失敗');
    alert('同步失敗：' + (e?.message || '未知錯誤'));
  } finally {
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
    const ts = lastSyncAt ? `（上次：${new Date(lastSyncAt).toLocaleTimeString()}）` : '';
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
  try { dom.modalTitle.textContent = '登入 / 註冊'; } catch(_) {}
  const html = `
    <div style="display:flex;flex-direction:column;gap:10px;min-width:280px;">
      <label style="display:flex;gap:6px;align-items:center;">
        <input type="radio" name="auth-mode" value="password" checked>
        <span>電郵＋密碼登入</span>
      </label>
      <label style="display:flex;gap:6px;align-items:center;">
        <input type="radio" name="auth-mode" value="signup">
        <span>新用戶註冊（電郵＋密碼）</span>
      </label>
      <label style="display:flex;gap:6px;align-items:center;">
        <input type="radio" name="auth-mode" value="magic">
        <span>魔術連結（寄登入信）</span>
      </label>
      <div class="form-group settings-group">
        <label>電郵</label>
        <input id="auth-email" type="email" placeholder="you@example.com" style="width:100%">
      </div>
      <div class="form-group settings-group" id="auth-pass-wrap">
        <label>密碼</label>
        <input id="auth-password" type="password" placeholder="至少 6 位" style="width:100%">
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button id="auth-forgot" class="btn-secondary" type="button">忘記密碼</button>
        <button id="auth-submit" class="btn-primary" type="button">確定</button>
      </div>
      <div id="auth-msg" style="font-size:12px;color:#666"></div>
    </div>`;
  dom.modalBody.innerHTML = html;
  const modeInputs = dom.modalBody.querySelectorAll('input[name="auth-mode"]');
  const emailEl = dom.modalBody.querySelector('#auth-email');
  const passWrap = dom.modalBody.querySelector('#auth-pass-wrap');
  const passEl = dom.modalBody.querySelector('#auth-password');
  const submitBtn = dom.modalBody.querySelector('#auth-submit');
  const forgotBtn = dom.modalBody.querySelector('#auth-forgot');
  const msg = dom.modalBody.querySelector('#auth-msg');
  const getMode = () => { const it = Array.from(modeInputs).find(r => r.checked); return it ? it.value : 'password'; };
  const updateUI = () => { const m = getMode(); passWrap.style.display = (m === 'password' || m === 'signup') ? 'block' : 'none'; forgotBtn.style.display = m === 'password' ? 'inline-block' : 'none'; };
  modeInputs.forEach(r => r.addEventListener('change', updateUI));
  updateUI();

  submitBtn.onclick = async () => {
    const mode = getMode();
    const email = (emailEl.value || '').trim();
    const password = (passEl.value || '').trim();
    if (!email) { msg.textContent = '請輸入電郵'; return; }
    submitBtn.disabled = true; submitBtn.textContent = '處理中...';
    try {
      if (mode === 'password') {
        const { error } = await auth.signInWithPassword({ email, password });
        if (error) throw error;
        msg.textContent = '登入成功'; ui.closeModal();
      } else if (mode === 'signup') {
        const { data, error } = await auth.signUp({ email, password });
        if (error) throw error;
        if (data?.user && !data?.session) { msg.textContent = '註冊成功，請至電郵完成驗證'; }
        else { msg.textContent = '註冊並登入成功'; ui.closeModal(); }
      } else {
        const { error } = await auth.signInWithOtp({ email });
        if (error) throw error;
        msg.textContent = '已寄出登入連結，請至電郵確認';
      }
    } catch (e) {
      msg.textContent = '錯誤：' + (e?.message || '請稍後再試');
    } finally {
      submitBtn.disabled = false; submitBtn.textContent = '確定';
    }
  };

  forgotBtn.onclick = async () => {
    const email = (emailEl.value || '').trim();
    if (!email) { msg.textContent = '請先輸入電郵'; return; }
    try {
      const { error } = await auth.resetPasswordForEmail(email, { redirectTo: location.origin });
      if (error) throw error;
      msg.textContent = '已寄送重設密碼連結';
    } catch (e) {
      msg.textContent = '錯誤：' + (e?.message || '請稍後再試');
    }
  };
}

// -----------------
// Auto sync & Realtime
// -----------------
let autoTimer = null;
let lastSyncAt = 0;
let syncInFlight = false;
const DEBOUNCE_MS = 6000; // 6s after last change
const MIN_INTERVAL_MS = 20000; // at least 20s between sync runs
let rtChannel = null;
let rtThrottled = 0;

function scheduleAutoSync(reason) {
  const now = Date.now();
  const delta = now - lastSyncAt;
  if (delta < MIN_INTERVAL_MS && !autoTimer) {
    const wait = MIN_INTERVAL_MS - delta + 200; // small buffer
    autoTimer = setTimeout(() => { autoTimer = null; doAutoSync('min-interval'); }, wait);
    return;
  }
  if (autoTimer) clearTimeout(autoTimer);
  autoTimer = setTimeout(() => { autoTimer = null; doAutoSync(reason || 'debounce'); }, DEBOUNCE_MS);
}

async function doAutoSync(reason) {
  const { data } = await auth.getSession();
  if (!data?.session) return; // not logged in
  if (syncInFlight) return; // avoid reentry
  try {
    syncInFlight = true;
    updateStatus('自動同步中...');
    await syncNow(buildLocalSnapshot, applyMergedSnapshot);
    lastSyncAt = Date.now();
    updateStatus('已完成同步');
  } catch (e) {
    console.warn('[sync] auto sync failed:', e);
    updateStatus('自動同步失敗');
  } finally {
    syncInFlight = false;
  }
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
