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
    try { window.__supabase_user = user || null; } catch(_) {}
    updateAuthButtons(user);
    updateStatus(user ? (user.email || '已登入') : '未登入');
    attachRealtime(user);
    setGearLoginState(!!user, user?.email || '');
  });

  // 初始化一次（避免等待事件）
  auth.getSession().then(({ data }) => {
    const user = data?.session?.user || null;
    try { window.__supabase_user = user || null; } catch(_) {}
    updateAuthButtons(user);
    updateStatus(user ? (user.email || '已登入') : '未登入');
    attachRealtime(user);
    setGearLoginState(!!user, user?.email || '');
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
    const info = await syncNow(buildLocalSnapshot, applyMergedSnapshot);
    lastSyncAt = Date.now();
    if (info && typeof info.version === 'number') {
      try { localStorage.setItem('lastSnapshotVersion', String(info.version)); } catch(_) {}
    }
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
    const ver = parseInt(localStorage.getItem('lastSnapshotVersion')||'0',10) || 0;
    const ts = lastSyncAt ? `（上次：${new Date(lastSyncAt).toLocaleTimeString()}，v${ver}）` : (ver ? `（v${ver}）` : '');
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
    <div class="auth-modal" style="min-width:300px;">
      <div class="auth-tabs" role="tablist">
        <button class="auth-tab is-active" data-mode="password" role="tab" aria-selected="true">登入</button>
        <button class="auth-tab" data-mode="signup" role="tab" aria-selected="false">註冊</button>
        <button class="auth-tab" data-mode="magic" role="tab" aria-selected="false">魔術連結</button>
      </div>
      <div class="auth-field">
        <label for="auth-email">電郵</label>
        <input id="auth-email" type="email" placeholder="you@example.com">
      </div>
      <div class="auth-field" id="auth-pass-wrap">
        <label for="auth-password">密碼</label>
        <input id="auth-password" type="password" placeholder="至少 6 位">
      </div>
      <div class="auth-actions">
        <button id="auth-forgot" class="btn-secondary" type="button">忘記密碼</button>
        <button id="auth-submit" class="btn-primary" type="button">確定</button>
      </div>
      <div id="auth-msg" class="auth-msg"></div>
    </div>`;
  dom.modalBody.innerHTML = html;
  const tabs = Array.from(dom.modalBody.querySelectorAll('.auth-tab'));
  const emailEl = dom.modalBody.querySelector('#auth-email');
  const passWrap = dom.modalBody.querySelector('#auth-pass-wrap');
  const passEl = dom.modalBody.querySelector('#auth-password');
  const submitBtn = dom.modalBody.querySelector('#auth-submit');
  const forgotBtn = dom.modalBody.querySelector('#auth-forgot');
  const msg = dom.modalBody.querySelector('#auth-msg');
  let mode = 'password';
  const setMode = (m) => {
    mode = m;
    tabs.forEach(t => { const on = t.dataset.mode === m; t.classList.toggle('is-active', on); t.setAttribute('aria-selected', on ? 'true' : 'false'); });
    passWrap.style.display = (m === 'password' || m === 'signup') ? 'block' : 'none';
    forgotBtn.style.display = m === 'password' ? 'inline-block' : 'none';
  };
  tabs.forEach(t => t.addEventListener('click', () => setMode(t.dataset.mode)));
  setMode('password');

  submitBtn.onclick = async () => {
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

function toggleGearMenu() {
  const existed = document.getElementById('gear-menu');
  if (existed) { existed.remove(); return; }
  const m = document.createElement('div');
  m.id = 'gear-menu';
  m.className = 'gear-menu';
  const email = (window.__supabase_user && window.__supabase_user.email) || '';
  const status = dom.syncStatus?.textContent || '';
  const loggedIn = !!email;
  m.innerHTML = `
    <div class="menu-item" id="gm-sync"><span>🔄</span><span>立即同步</span><span class="meta"></span></div>
    ${loggedIn ? '' : '<div class="menu-item" id="gm-login"><span>🔐</span><span>登入 / 註冊</span></div>'}
    ${loggedIn ? '<div class="menu-item" id="gm-logout"><span>🚪</span><span>登出</span><span class="meta">'+escapeHtml(email)+'</span></div>' : ''}
    <div class="menu-divider"></div>
    <div class="menu-item" id="gm-settings"><span>⚙️</span><span>全局設定</span></div>
    <div class="menu-item" id="gm-clear-cache"><span>🧹</span><span>清理本機快取</span></div>
    <div class="menu-status">${status}</div>`;
  document.body.appendChild(m);
  const sync = m.querySelector('#gm-sync');
  const login = m.querySelector('#gm-login');
  const logout = m.querySelector('#gm-logout');
  const settings = m.querySelector('#gm-settings');
  const clearCache = m.querySelector('#gm-clear-cache');
  if (sync) sync.addEventListener('click', () => { handleSync(); m.remove(); });
  if (login) login.addEventListener('click', () => { showLoginModal(); m.remove(); });
  if (logout) logout.addEventListener('click', async () => { try { await auth.signOut(); } catch(_){} updateAuthButtons(null); updateStatus('已登出'); m.remove(); });
  if (settings) settings.addEventListener('click', () => { showGlobalSettingsModal(); m.remove(); });
  if (clearCache) clearCache.addEventListener('click', async () => { await clearLocalCaches(); alert('已清理本機快取'); m.remove(); });
}

function showGlobalSettingsModal() {
  try { ui.openModal(); } catch(_) {}
  try { dom.modalTitle.textContent = '全局設定'; } catch(_) {}
  // read existing
  let settings, secrets;
  try { const mod = requireOrImportSettings(); settings = mod.settings; secrets = mod.secrets; } catch(_) { settings = {}; secrets = {}; }
  const html = `
    <div class="auth-modal" style="min-width:320px;">
      <div class="auth-field">
        <label>AI API URL</label>
        <input id="gs-ai-url" type="text" placeholder="https://api.example.com/v1/chat/completions" value="${escapeHtml(settings.aiUrl||'')}">
      </div>
      <div class="auth-field">
        <label>AI API Key（僅保存在本機）</label>
        <input id="gs-ai-key" type="password" placeholder="sk-..." value="${escapeHtml(secrets.aiKey||'')}">
      </div>
      <div class="auth-field">
        <label>TTS 基礎 URL</label>
        <input id="gs-tts-url" type="text" placeholder="https://tts.example.com" value="${escapeHtml(settings.ttsUrl||'')}">
      </div>
      <div class="auth-field">
        <label>TTS API Key（僅保存在本機）</label>
        <input id="gs-tts-key" type="password" placeholder="..." value="${escapeHtml(secrets.ttsKey||'')}">
      </div>
      <div class="auth-actions">
        <button id="gs-cancel" class="btn-secondary">取消</button>
        <button id="gs-save" class="btn-primary">儲存</button>
      </div>
      <div class="auth-msg" id="gs-msg">設定僅保存在本機，不會同步到雲端。</div>
    </div>`;
  dom.modalBody.innerHTML = html;
  const $ = (id)=> dom.modalBody.querySelector(id);
  $('#gs-cancel').onclick = ()=> ui.closeModal();
  $('#gs-save').onclick = async ()=>{
    try {
      const { saveGlobalSettings, saveGlobalSecrets } = await import('../../modules/settings.js');
      const aiUrl = $('#gs-ai-url').value.trim();
      const aiKey = $('#gs-ai-key').value.trim();
      const ttsUrl = $('#gs-tts-url').value.trim();
      const ttsKey = $('#gs-tts-key').value.trim();
      saveGlobalSettings({ ai: { apiUrl: aiUrl }, tts: { baseUrl: ttsUrl } });
      saveGlobalSecrets({ aiApiKey: aiKey, ttsApiKey: ttsKey });
      $('#gs-msg').textContent = '已儲存（僅本機）';
      setTimeout(()=> ui.closeModal(), 500);
    } catch (e) {
      $('#gs-msg').textContent = '儲存失敗：' + (e?.message || '');
    }
  };
}

function setGearLoginState(isLoggedIn, email) {
  if (!dom.appGearBtn) return;
  dom.appGearBtn.classList.toggle('is-logged-in', !!isLoggedIn);
  if (email) dom.appGearBtn.title = `設定（${email}）`; else dom.appGearBtn.title = '設定';
}

async function clearLocalCaches() {
  try {
    // localStorage cache entries
    const keys = Object.keys(localStorage);
    for (const k of keys) { if (k.startsWith('bdc:cache:v1:')) localStorage.removeItem(k); }
  } catch(_) {}
  try {
    // IndexedDB 'bdc-cache'
    const dbs = await (indexedDB?.databases ? indexedDB.databases() : Promise.resolve([]));
    const has = Array.isArray(dbs) ? dbs.some(d => d.name === 'bdc-cache') : true;
    if (has && indexedDB && indexedDB.deleteDatabase) {
      await new Promise(res => { const req = indexedDB.deleteDatabase('bdc-cache'); req.onsuccess = req.onerror = req.onblocked = () => res(); });
    }
  } catch(_) {}
}

function escapeHtml(s){
  return String(s||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function requireOrImportSettings() {
  // Read current values synchronously from localStorage
  let settings = {}, secrets = {};
  try { const raw = localStorage.getItem('pen_global_settings'); if (raw) { const s = JSON.parse(raw); settings.aiUrl = s?.ai?.apiUrl || ''; settings.ttsUrl = s?.tts?.baseUrl || ''; } } catch(_) {}
  try { const raw = localStorage.getItem('pen_global_secrets'); if (raw) { const s = JSON.parse(raw); secrets.aiKey = s?.aiApiKey || ''; secrets.ttsKey = s?.ttsApiKey || ''; } } catch(_) {}
  return { settings, secrets };
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
    const info = await syncNow(buildLocalSnapshot, applyMergedSnapshot);
    lastSyncAt = Date.now();
    if (info && typeof info.version === 'number') {
      try { localStorage.setItem('lastSnapshotVersion', String(info.version)); } catch(_) {}
    }
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
