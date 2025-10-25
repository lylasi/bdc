// Minimal UI wiring for Supabase-based sync (Scheme C)
// Provides: Login (Email OTP), Logout, and "Sync Now" button

import * as dom from '../../modules/dom.js';
import { buildLocalSnapshot, applyMergedSnapshot } from '../../modules/sync-core.js';
import { syncNow, auth, subscribeSnapshotChanges, unsubscribeChannel } from '../../modules/sync-supabase.js';
import * as ui from '../../modules/ui.js';
import { openDictationGradingHistory } from '../dictation/dictation-grader.js';
import * as backup from '../../modules/local-backup.js';
import * as cache from '../../modules/cache.js';
import { markdownToHtml } from '../../modules/markdown.js';

export function initSync() {
  try {
    console.log('[sync] initSync()');
    wireAuthUI();
    // 嘗試處理從郵件回跳的 auth 參數（魔術連結 / 密碼重設）
    handleAuthCallbackIfAny().catch(() => {});
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

  auth.onAuthStateChange((event, session) => {
    const user = session?.user || null;
    try { window.__supabase_user = user || null; } catch(_) {}
    updateAuthButtons(user);
    updateStatus(user ? (user.email || '已登入') : '未登入');
    attachRealtime(user);
    setGearLoginState(!!user, user?.email || '');
    if (user) {
      try { scheduleAutoSync('login'); } catch(_) {}
    }
    // 密碼重設事件：彈出新密碼對話框
    if (event === 'PASSWORD_RECOVERY') {
      try { showResetPasswordModal(); } catch(_) {}
    }
  });

  // 初始化一次（避免等待事件）
  auth.getSession().then(({ data }) => {
    const user = data?.session?.user || null;
    try { window.__supabase_user = user || null; } catch(_) {}
    updateAuthButtons(user);
    updateStatus(user ? (user.email || '已登入') : '未登入');
    attachRealtime(user);
    setGearLoginState(!!user, user?.email || '');
    if (user) {
      try { scheduleAutoSync('init-session'); } catch(_) {}
    }
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
    try { localStorage.setItem('lastSnapshotAt', String(lastSyncAt)); } catch(_) {}
    if (info && typeof info.version === 'number') {
      try { localStorage.setItem('lastSnapshotVersion', String(info.version)); } catch(_) {}
    }
    if (info && info.restoredFromRemote) {
      updateStatus('已從雲端恢復（偵測到本機為空）');
      try { ui.displayMessage('偵測到本機為空，已自動從雲端恢復', 'warning', 5000); } catch(_) {}
    } else {
      updateStatus('已完成同步');
      try { ui.displayMessage('同步完成', 'success', 2000); } catch(_) {}
    }
    try { await backup.createBackup('手動同步後備份'); } catch(_) {}
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
        <div class="auth-pass-row" style="display:flex;gap:8px;align-items:center;">
          <input id="auth-password" type="password" placeholder="至少 6 位" style="flex:1;">
          <button id="auth-password-toggle" class="btn-secondary" type="button" style="white-space:nowrap;">顯示</button>
        </div>
      </div>
      <div class="auth-field" id="auth-pass2-wrap" style="display:none;">
        <label for="auth-password2">確認密碼</label>
        <div class="auth-pass-row" style="display:flex;gap:8px;align-items:center;">
          <input id="auth-password2" type="password" placeholder="再輸入一次" style="flex:1;">
          <button id="auth-password2-toggle" class="btn-secondary" type="button" style="white-space:nowrap;">顯示</button>
        </div>
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
  const pass2Wrap = dom.modalBody.querySelector('#auth-pass2-wrap');
  const pass2El = dom.modalBody.querySelector('#auth-password2');
  const submitBtn = dom.modalBody.querySelector('#auth-submit');
  const forgotBtn = dom.modalBody.querySelector('#auth-forgot');
  const msg = dom.modalBody.querySelector('#auth-msg');
  const pwToggle = dom.modalBody.querySelector('#auth-password-toggle');
  const pw2Toggle = dom.modalBody.querySelector('#auth-password2-toggle');
  let mode = 'password';
  const setMode = (m) => {
    mode = m;
    tabs.forEach(t => { const on = t.dataset.mode === m; t.classList.toggle('is-active', on); t.setAttribute('aria-selected', on ? 'true' : 'false'); });
    passWrap.style.display = (m === 'password' || m === 'signup') ? 'block' : 'none';
    pass2Wrap.style.display = (m === 'signup') ? 'block' : 'none';
    forgotBtn.style.display = m === 'password' ? 'inline-block' : 'none';
  };
  tabs.forEach(t => t.addEventListener('click', () => setMode(t.dataset.mode)));
  setMode('password');

  // 顯示/隱藏密碼
  if (pwToggle) pwToggle.onclick = () => {
    const toText = passEl.type === 'password';
    passEl.type = toText ? 'text' : 'password';
    pwToggle.textContent = toText ? '隱藏' : '顯示';
  };
  if (pw2Toggle) pw2Toggle.onclick = () => {
    if (!pass2El) return;
    const toText = pass2El.type === 'password';
    pass2El.type = toText ? 'text' : 'password';
    pw2Toggle.textContent = toText ? '隱藏' : '顯示';
  };

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
        const password2 = (pass2El?.value || '').trim();
        if (!password || password.length < 6) { msg.textContent = '密碼至少 6 位'; return; }
        if (password !== password2) { msg.textContent = '兩次輸入的密碼不一致'; return; }
        const { data, error } = await auth.signUp({ email, password });
        if (error) throw error;
        if (data?.user && !data?.session) { msg.textContent = '註冊成功，請至電郵完成驗證'; }
        else { msg.textContent = '註冊並登入成功'; ui.closeModal(); }
      } else {
        const { error } = await auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin } });
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

// 對外暴露：提供給其他功能模組開啟登入彈窗
export function openLoginModal() {
  try { showLoginModal(); } catch (_) { alert('登入模組暫時不可用'); }
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
  const t = atMs ? new Date(atMs).toLocaleTimeString() : '';
  const status = dom.syncStatus?.textContent || '';
  if (!ver && status) {
    const mVer = status.match(/v(\d+)/i);
    if (mVer) { ver = parseInt(mVer[1], 10) || 0; try { if (ver>0) localStorage.setItem('lastSnapshotVersion', String(ver)); } catch(_) {} }
  }
  const loggedIn = !!email;
  m.innerHTML = `
    <div class="menu-item" id="gm-sync">
      <span class="mi-icon" aria-hidden="true">${svgSync()}</span>
      <span class="mi-text">立即同步</span>
      <span class="meta">${ver ? 'v'+ver : ''}${t ? ' · ' + t.replace(/:\\d{2}$/, '') : ''}</span>
    </div>
    ${loggedIn ? '' : `<div class="menu-item" id="gm-login"><span class="mi-icon">${svgLogin()}</span><span class="mi-text">登入 / 註冊</span></div>`}
    ${loggedIn ? `<div class="menu-item" id="gm-change-password"><span class="mi-icon">${svgKey()}</span><span class="mi-text">變更密碼</span></div>` : ''}
    ${loggedIn ? `<div class="menu-item" id="gm-logout"><span class="mi-icon">${svgLogout()}</span><span class="mi-text">登出</span><span class="meta">${escapeHtml(email)}</span></div>` : ''}
    <div class="menu-divider"></div>
    <div class="menu-item" id="gm-settings"><span class="mi-icon">${svgGear()}</span><span class="mi-text">全局設定</span></div>
    <div class="menu-item" id="gm-grading-history"><span class="mi-icon">${svgHistory()}</span><span class="mi-text">默寫批改歷史</span></div>
    <div class="menu-item" id="gm-assistant"><span class="mi-icon">${svgChat()}</span><span class="mi-text">AI 會話</span></div>
    <div class="menu-item" id="gm-backup-panel"><span class="mi-icon">${svgRestore()}</span><span class="mi-text">備份與還原</span></div>
    <div class="menu-status">${status}</div>`;
  document.body.appendChild(m);
  const sync = m.querySelector('#gm-sync');
  const login = m.querySelector('#gm-login');
  const changePassword = m.querySelector('#gm-change-password');
  const logout = m.querySelector('#gm-logout');
  const settings = m.querySelector('#gm-settings');
  const gradingHistory = m.querySelector('#gm-grading-history');
  const assistantSessions = m.querySelector('#gm-assistant');
  const backupPanel = m.querySelector('#gm-backup-panel');
  if (sync) sync.addEventListener('click', () => { handleSync(); m.remove(); });
  if (login) login.addEventListener('click', () => { showLoginModal(); m.remove(); });
  if (changePassword) changePassword.addEventListener('click', () => { showChangePasswordModal(); m.remove(); });
  if (logout) logout.addEventListener('click', async () => { try { await auth.signOut(); } catch(_){} updateAuthButtons(null); updateStatus('已登出'); m.remove(); });
  if (settings) settings.addEventListener('click', () => { showGlobalSettingsModal(); m.remove(); });
  if (gradingHistory) gradingHistory.addEventListener('click', () => { try { openDictationGradingHistory(); } catch(_) {} m.remove(); });
  if (assistantSessions) assistantSessions.addEventListener('click', () => { showAssistantSessions(); m.remove(); });
  if (backupPanel) backupPanel.addEventListener('click', () => { showBackupRestoreModal(); m.remove(); });
}

function showGlobalSettingsModal() {
  try { ui.openModal(); } catch(_) {}
  try { dom.modalTitle.textContent = '全局設定'; } catch(_) {}
  try { const mc = dom.appModal.querySelector('.modal-content'); if (mc) mc.classList.add('modal-large'); } catch(_) {}
  // 注入本面板私有樣式（避免全局污染）
  (function injectGsStyle(){
    const id = 'gs-asst-style'; if (document.getElementById(id)) return;
    const st = document.createElement('style'); st.id = id; st.textContent = `
      /* AI 助手設定：更輕量的開關樣式 */
      .gs-asst-row{display:flex;align-items:center;gap:16px;flex-wrap:wrap;padding:10px 12px;border:1px solid #e5e7eb;background:#f8fafc;border-radius:12px}
      .gs-toggle{display:inline-flex;align-items:center;gap:8px;padding:6px 10px;border-radius:10px;background:#fff;border:1px solid #e5e7eb;cursor:pointer}
      .gs-visually-hidden{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
      .gs-switch{position:relative;width:38px;height:22px;border-radius:999px;background:#e5e7eb;border:1px solid #d1d5db;display:inline-block;vertical-align:middle;transition:background .2s,border-color .2s}
      .gs-switch::after{content:'';position:absolute;top:1px;left:1px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.15);transition:transform .2s}
      .gs-toggle input:checked + .gs-switch{background:#3b82f6;border-color:#3b82f6}
      .gs-toggle input:checked + .gs-switch::after{transform:translateX(16px)}
      .gs-toggle .gs-label{font-size:13px;color:#0f172a}
      .gs-hint{color:#64748b;font-size:12px;margin-left:auto}
    `; document.head.appendChild(st);
  })();
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
        <label>TTS 來源</label>
        <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
          <label class="gs-toggle"><input id="gs-tts-use-remote" class="gs-visually-hidden" type="radio" name="gs-tts-use" checked><span class="gs-switch" aria-hidden="true"></span><span class="gs-label">遠程</span></label>
          <label class="gs-toggle"><input id="gs-tts-use-local" class="gs-visually-hidden" type="radio" name="gs-tts-use"><span class="gs-switch" aria-hidden="true"></span><span class="gs-label">本地</span></label>
          <label class="gs-toggle"><input id="gs-tts-use-custom" class="gs-visually-hidden" type="radio" name="gs-tts-use"><span class="gs-switch" aria-hidden="true"></span><span class="gs-label">自定義</span></label>
          <span class="gs-hint">一般用戶只需選擇來源；需要自定義再輸入 URL</span>
        </div>
      </div>
      <div class="auth-field" id="gs-tts-custom-wrap" style="display:none">
        <label>自定義 TTS 基礎 URL</label>
        <input id="gs-tts-url-custom" type="text" placeholder="https://your-tts.example.com" value="${escapeHtml(settings.ttsUrlCustom||'')}">
      </div>
      <div class="auth-field">
        <label>TTS API Key（僅保存在本機）</label>
        <input id="gs-tts-key" type="password" placeholder="..." value="${escapeHtml(secrets.ttsKey||'')}">
      </div>
      <div class="auth-field">
        <label>英語朗讀首選</label>
        <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
          <label class="gs-toggle"><input id="gs-read-en-gb" class="gs-visually-hidden" name="gs-read-en" type="radio"><span class="gs-switch" aria-hidden="true"></span><span class="gs-label">英音 en‑GB</span></label>
          <label class="gs-toggle"><input id="gs-read-en-us" class="gs-visually-hidden" name="gs-read-en" type="radio"><span class="gs-switch" aria-hidden="true"></span><span class="gs-label">美音 en‑US</span></label>
          <span class="gs-hint">未指定時預設英音</span>
        </div>
      </div>
      <div class="auth-field">
        <label>中文朗讀首選</label>
        <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
          <label class="gs-toggle"><input id="gs-read-zh-cn" class="gs-visually-hidden" name="gs-read-zh" type="radio"><span class="gs-switch" aria-hidden="true"></span><span class="gs-label">普通話 zh‑CN</span></label>
          <label class="gs-toggle"><input id="gs-read-zh-hk" class="gs-visually-hidden" name="gs-read-zh" type="radio"><span class="gs-switch" aria-hidden="true"></span><span class="gs-label">粵語 zh‑HK</span></label>
        </div>
      </div>
      <div class="auth-field">
        <div style="display:flex;align-items:center;gap:8px;justify-content:space-between;flex-wrap:wrap">
          <label style="margin:0">TTS 聲音（僅顯示：美音、英音、廣東話、普通話）</label>
          <button id="gs-tts-reload" type="button" class="btn" style="margin-left:auto">重新載入清單</button>
        </div>
        <div id="gs-voice-box" style="display:grid;grid-template-columns:1fr;gap:12px;margin-top:8px">
          <div>
            <div style="display:flex;align-items:center;gap:8px;justify-content:space-between">
              <div style="font-size:12px;color:#64748b">英語（美音 en-US）</div>
              <button id="gs-test-en-us" type="button" class="btn-secondary" style="padding:4px 8px">試聽</button>
            </div>
            <select id="gs-voice-en-us" style="width:100%"><option value="">正在載入...</option></select>
          </div>
          <div>
            <div style="display:flex;align-items:center;gap:8px;justify-content:space-between">
              <div style="font-size:12px;color:#64748b">英語（英音 en-GB）</div>
              <button id="gs-test-en-gb" type="button" class="btn-secondary" style="padding:4px 8px">試聽</button>
            </div>
            <select id="gs-voice-en-gb" style="width:100%"><option value="">正在載入...</option></select>
          </div>
          <div>
            <div style="display:flex;align-items:center;gap:8px;justify-content:space-between">
              <div style="font-size:12px;color:#64748b">粵語（廣東話 zh-HK）</div>
              <button id="gs-test-zh-hk" type="button" class="btn-secondary" style="padding:4px 8px">試聽</button>
            </div>
            <select id="gs-voice-zh-hk" style="width:100%"><option value="">正在載入...</option></select>
          </div>
          <div>
            <div style="display:flex;align-items:center;gap:8px;justify-content:space-between">
              <div style="font-size:12px;color:#64748b">中文（普通話 zh-CN）</div>
              <button id="gs-test-zh-cn" type="button" class="btn-secondary" style="padding:4px 8px">試聽</button>
            </div>
            <select id="gs-voice-zh-cn" style="width:100%"><option value="">正在載入...</option></select>
          </div>
        </div>
        <div id="gs-voice-hint" class="gs-hint">若載入失敗，請確認 TTS 基礎 URL 或 ai-config.js 的 voicesUrl 可存取。</div>
      </div>
      <div class="auth-field">
        <label>AI 助手</label>
        <div class="gs-asst-row">
          <label class="gs-toggle" title="右下角浮窗入口">
            <input id="gs-assistant-enabled" class="gs-visually-hidden" type="checkbox" ${settings.assistantEnabled ? 'checked' : ''}>
            <span class="gs-switch" aria-hidden="true"></span>
            <span class="gs-label">啟用助手</span>
          </label>
          <label class="gs-toggle" title="串流回應可減少等待">
            <input id="gs-assistant-stream" class="gs-visually-hidden" type="checkbox" ${settings.assistantStream === false ? '' : 'checked'}>
            <span class="gs-switch" aria-hidden="true"></span>
            <span class="gs-label">串流回應</span>
          </label>
          <span class="gs-hint">右下角入口 · 串流更順暢</span>
        </div>
      </div>
      <div class="auth-field">
        <label>AI 模型覆蓋（留空則使用預設）</label>
        <div style="display:grid;grid-template-columns:1fr;gap:8px;">
          <input id="gs-model-word" type="text" placeholder="wordAnalysis，例如 gpt-4.1-mini" value="${escapeHtml((settings.models&&settings.models.wordAnalysis)||'')}">
          <input id="gs-model-sentence" type="text" placeholder="sentenceChecking，例如 gpt-4.1-mini" value="${escapeHtml((settings.models&&settings.models.sentenceChecking)||'')}">
          <input id="gs-model-qa" type="text" placeholder="qaChecking（問答校對），例如 tbai:gemini-2.5-flash-nothinking" value="${escapeHtml((settings.models&&(settings.models.qaChecking||settings.models.qaCheck))||'')}">
          <input id="gs-model-article" type="text" placeholder="articleAnalysis，例如 gpt-4.1-mini" value="${escapeHtml((settings.models&&settings.models.articleAnalysis)||'')}">
          <input id="gs-model-clean" type="text" placeholder="articleCleanup（AI 清洗），例如 gpt-4.1-mini" value="${escapeHtml((settings.models&&settings.models.articleCleanup)||'')}">
          <input id="gs-model-example" type="text" placeholder="exampleGeneration，例如 gpt-4.1-nano" value="${escapeHtml((settings.models&&settings.models.exampleGeneration)||'')}">
        </div>
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
  // 初始化預設單選狀態
  try {
    const { settings } = requireOrImportSettings();
    const use = settings?.ttsUse || 'remote';
    dom.modalBody.querySelector('#gs-tts-use-remote').checked = use !== 'local';
    dom.modalBody.querySelector('#gs-tts-use-local').checked = use === 'local';
    dom.modalBody.querySelector('#gs-tts-use-custom').checked = use === 'custom';
    const en = settings?.readEn || 'en-GB';
    dom.modalBody.querySelector('#gs-read-en-gb').checked = (en === 'en-GB');
    dom.modalBody.querySelector('#gs-read-en-us').checked = (en === 'en-US');
    const zh = settings?.readZh || 'zh-CN';
    dom.modalBody.querySelector('#gs-read-zh-cn').checked = (zh === 'zh-CN');
    dom.modalBody.querySelector('#gs-read-zh-hk').checked = (zh === 'zh-HK');
  } catch(_) {}

  // 若使用自定義，顯示輸入框
  (function wireCustomToggle(){
    const wrap = dom.modalBody.querySelector('#gs-tts-custom-wrap');
    const onChange = ()=>{ const c = dom.modalBody.querySelector('#gs-tts-use-custom')?.checked; if (wrap) wrap.style.display = c ? '' : 'none'; };
    ['#gs-tts-use-remote','#gs-tts-use-local','#gs-tts-use-custom'].forEach(id=>{ const el=dom.modalBody.querySelector(id); if(el) el.addEventListener('change', onChange); });
    onChange();
  })();

  // 若自定義輸入框為空，從 ai-config.js 補上預設（若提供）
  (async ()=>{
    try {
      const cfg = await import('../../ai-config.js');
      const custom = '';
      const inCustom = dom.modalBody.querySelector('#gs-tts-url-custom');
      if (inCustom && !inCustom.value) inCustom.value = custom;
    } catch(_) {}
  })();

  $('#gs-save').onclick = async ()=>{
    try {
      const { saveGlobalSettings, saveGlobalSecrets } = await import('../../modules/settings.js');
      const aiUrl = $('#gs-ai-url').value.trim();
      const aiKey = $('#gs-ai-key').value.trim();
      const ttsUse = dom.modalBody.querySelector('#gs-tts-use-custom')?.checked ? 'custom' : (dom.modalBody.querySelector('#gs-tts-use-local')?.checked ? 'local' : 'remote');
      const ttsUrlCustom = (dom.modalBody.querySelector('#gs-tts-url-custom')?.value || '').trim();
      const ttsKey = $('#gs-tts-key').value.trim();
      // 模型覆蓋（空值表示清除）
      const models = {
        wordAnalysis: $('#gs-model-word').value.trim(),
        sentenceChecking: $('#gs-model-sentence').value.trim(),
        qaChecking: $('#gs-model-qa').value.trim(),
        articleAnalysis: $('#gs-model-article').value.trim(),
        articleCleanup: $('#gs-model-clean').value.trim(),
        exampleGeneration: $('#gs-model-example').value.trim()
      };
      // 移除空鍵，避免污染設置
      Object.keys(models).forEach(k => { if (!models[k]) delete models[k]; });
      const asstEnabled = dom.modalBody.querySelector('#gs-assistant-enabled')?.checked ? true : false;
      const asstStream = dom.modalBody.querySelector('#gs-assistant-stream')?.checked !== false;
      // voice selections
      const sv = {
        'en-US': (dom.modalBody.querySelector('#gs-voice-en-us')?.value || '').trim(),
        'en-GB': (dom.modalBody.querySelector('#gs-voice-en-gb')?.value || '').trim(),
        'zh-HK': (dom.modalBody.querySelector('#gs-voice-zh-hk')?.value || '').trim(),
        'zh-CN': (dom.modalBody.querySelector('#gs-voice-zh-cn')?.value || '').trim()
      };
      Object.keys(sv).forEach(k => { if (!sv[k]) delete sv[k]; });
      const readEn = dom.modalBody.querySelector('#gs-read-en-us')?.checked ? 'en-US' : 'en-GB';
      const readZh = dom.modalBody.querySelector('#gs-read-zh-hk')?.checked ? 'zh-HK' : 'zh-CN';
      saveGlobalSettings({
        ai: { apiUrl: aiUrl, models },
        tts: { use: ttsUse, baseUrlCustom: ttsUrlCustom, selectedVoices: sv },
        reading: { englishVariant: readEn, chineseVariant: readZh },
        assistant: { enabled: asstEnabled, stream: asstStream }
      });
      saveGlobalSecrets({ aiApiKey: aiKey, ttsApiKey: ttsKey });
      $('#gs-msg').textContent = '已儲存（僅本機）';
      setTimeout(()=> ui.closeModal(), 500);
    } catch (e) {
      $('#gs-msg').textContent = '儲存失敗：' + (e?.message || '');
    }
  };

  // 初始化聲音清單
  (async function initVoices(){
    const $ = (sel) => dom.modalBody.querySelector(sel);
    const btn = $('#gs-tts-reload');
    const selects = ['#gs-voice-en-us','#gs-voice-en-gb','#gs-voice-zh-hk','#gs-voice-zh-cn'].map(s=>$(s));
    const testBtns = {
      'en-US': $('#gs-test-en-us'),
      'en-GB': $('#gs-test-en-gb'),
      'zh-HK': $('#gs-test-zh-hk'),
      'zh-CN': $('#gs-test-zh-cn')
    };
    const setLoading = (on) => { selects.forEach(sel => { if (!sel) return; sel.innerHTML = `<option value="">${on?'正在載入...':'無可用選項'}</option>`; sel.disabled = on; }); };
    const ensureOptions = (sel, arr, savedVal) => {
        if (!sel) return;
        sel.innerHTML = '';
        if (!arr || !arr.length) { sel.innerHTML = '<option value="">無可用選項</option>'; sel.disabled = false; return; }
        arr.forEach(v => { const o=document.createElement('option'); o.value=v.id; o.textContent=v.__label||v.id; sel.appendChild(o); });
        // 若有保存值且存在於清單，選中；否則預設第一項
        if (savedVal && Array.from(sel.options).some(o => o.value === savedVal)) sel.value = savedVal;
        if (!sel.value && sel.options.length) sel.selectedIndex = 0;
    };
    const fillAll = (groups, saved) => {
        const mk = (arr) => (arr||[]).map(v => ({ ...v, __label: v.__label || v.id }));
        ensureOptions($('#gs-voice-en-us'), mk(groups['en-US']), saved['en-US']);
        ensureOptions($('#gs-voice-en-gb'), mk(groups['en-GB']), saved['en-GB']);
        ensureOptions($('#gs-voice-zh-hk'), mk(groups['zh-HK']), saved['zh-HK']);
        ensureOptions($('#gs-voice-zh-cn'), mk(groups['zh-CN']), saved['zh-CN']);
    };
    const loadAndPopulate = async (refresh=false) => {
      setLoading(true);
      try {
        const { fetchVoicesList, groupVoices, formatVoiceLabel, pickDefaultVoiceId } = await import('../../modules/voices.js');
        // 允許使用者不先儲存也能以當前面板的選項載入清單
        const preferUse = dom.modalBody.querySelector('#gs-tts-use-custom')?.checked ? 'custom' : (dom.modalBody.querySelector('#gs-tts-use-local')?.checked ? 'local' : 'remote');
        const overrideBaseUrls = preferUse === 'custom' ? { custom: (dom.modalBody.querySelector('#gs-tts-url-custom')?.value || '').trim() } : undefined;
        const list = await fetchVoicesList({ refresh, overrideUse: preferUse, overrideBaseUrls });
        list.forEach(v => { v.__label = formatVoiceLabel(v); });
        const groups = groupVoices(list);
        let saved = {};
        try { const raw = localStorage.getItem('pen_global_settings'); if (raw) { const js = JSON.parse(raw); saved = (js?.tts && js.tts.selectedVoices) || {}; } } catch(_) {}
        // fill defaults if empty
        const ensure = (k) => { if (!saved[k] && groups[k] && groups[k].length) saved[k] = pickDefaultVoiceId(groups[k]); };
        ['en-US','en-GB','zh-HK','zh-CN'].forEach(ensure);
        fillAll(groups, saved);
        // 啟用試聽按鈕
        Object.keys(testBtns).forEach(k => { if (testBtns[k]) testBtns[k].disabled = false; });
        const hint = $('#gs-voice-hint'); if (hint) hint.textContent = '已載入，共 ' + list.length + ' 個聲音';
      } catch (e) {
        selects.forEach(sel => { if (!sel) return; sel.innerHTML = '<option value="">載入失敗</option>'; sel.disabled = false; });
        const hint = $('#gs-voice-hint'); if (hint) hint.textContent = '載入失敗：' + (e?.message || '');
      } finally {
        selects.forEach(sel => { if (!sel) return; sel.disabled = false; });
      }
    };
    if (btn) btn.addEventListener('click', () => loadAndPopulate(true));
    loadAndPopulate(false);

    // 綁定試聽事件
    const playSamples = async (group) => {
      const hint = $('#gs-voice-hint');
      try {
        const { stopCurrentAudio, speakText, buildTTSUrl } = await import('../../modules/audio.js');
        stopCurrentAudio();
        const sel = {
          'en-US': $('#gs-voice-en-us'),
          'en-GB': $('#gs-voice-en-gb'),
          'zh-HK': $('#gs-voice-zh-hk'),
          'zh-CN': $('#gs-voice-zh-cn')
        }[group];
        // 優先用當前下拉的值；若沒有，退到本機保存或 ai-config 預設
        let id = (sel && sel.value) ? sel.value : '';
        if (!id) {
          try { const raw = localStorage.getItem('pen_global_settings'); if (raw) { const js = JSON.parse(raw); id = (js?.tts?.selectedVoices||{})[group] || ''; } } catch(_) {}
        }
        if (!id) {
          try { const cfg = await import('../../ai-config.js');
            if (group === 'zh-HK') id = cfg?.TTS_CONFIG?.voices?.cantonese || '';
            else if (group === 'zh-CN') id = cfg?.TTS_CONFIG?.voices?.chinese || '';
            else id = cfg?.TTS_CONFIG?.voices?.english || '';
          } catch(_) {}
        }
        if (!id) { if (hint) hint.textContent = '沒有可用的聲音可試聽'; return; }
        let text;
        if (group === 'en-US') text = 'This is a test voice.';
        else if (group === 'en-GB') text = 'This is a British English test voice.';
        else if (group === 'zh-HK') text = '呢個係測試語音。';
        else text = '這是一段測試語音。';
        const ok = await speakText(text, id, 0);
        if (!ok) {
          const url = buildTTSUrl(text, id, 0);
          try { console.debug('[TTS test]', group, id, url.replace(/(api_key=)[^&]+/, '$1***')); } catch(_) {}
          if (hint) hint.textContent = '播放失敗，已輸出測試 URL 於 Console，請檢查回應格式與 voice 代碼。';
        }
      } catch(e) {
        console.error('試聽失敗', e);
        // 後備：若該 id 不被後端支援，嘗試使用 ai-config 的預設粵/普語音
        try {
          const cfg = await import('../../ai-config.js');
          const { speakText } = await import('../../modules/audio.js');
          let fb = '';
          if (group === 'zh-HK') fb = cfg?.TTS_CONFIG?.voices?.cantonese || '';
          if (group === 'zh-CN') fb = cfg?.TTS_CONFIG?.voices?.chinese || '';
          if (group === 'en-US') fb = cfg?.TTS_CONFIG?.voices?.english || '';
          if (group === 'en-GB') {
            // 若未提供英音預設，回退到 english 也可接受
            fb = cfg?.TTS_CONFIG?.voices?.english || '';
          }
          if (fb) {
            let text = (group === 'zh-HK') ? '呢個係測試語音。' : (group === 'zh-CN' ? '這是一段測試語音。' : 'This is a test voice.');
            await speakText(text, fb, 0);
            if (hint) hint.textContent = '提示：該聲音可能不被後端支援，已用預設後備語音試聽。';
          }
        } catch(_) {}
      }
    };
    if (testBtns['en-US']) testBtns['en-US'].addEventListener('click', () => playSamples('en-US'));
    if (testBtns['en-GB']) testBtns['en-GB'].addEventListener('click', () => playSamples('en-GB'));
    if (testBtns['zh-HK']) testBtns['zh-HK'].addEventListener('click', () => playSamples('zh-HK'));
    if (testBtns['zh-CN']) testBtns['zh-CN'].addEventListener('click', () => playSamples('zh-CN'));
  })();
}

function setGearLoginState(isLoggedIn, email) {
  if (!dom.appGearBtn) return;
  dom.appGearBtn.classList.toggle('is-logged-in', !!isLoggedIn);
  if (email) dom.appGearBtn.title = `設定（${email}）`; else dom.appGearBtn.title = '設定';
}

// --- 密碼重設/變更流程 ---
async function handleAuthCallbackIfAny() {
  try {
    const url = new URL(location.href);
    const hashRaw = (location.hash || '').replace(/^#/, '');
    const hp = new URLSearchParams(hashRaw.includes('=') ? hashRaw : ''); // 若只是 #v 這種導航，不會被當成查詢字串
    const sp = url.searchParams;
    const get = (k) => sp.get(k) || hp.get(k) || '';

    const type = (get('type') || '').toLowerCase();
    const tokenHash = get('token_hash') || '';
    const code = get('code') || '';
    const hasAccessToken = !!get('access_token');

    // 優先處理密碼重設（recovery）
    if (type === 'recovery' || tokenHash || hasAccessToken) {
      try {
        if (tokenHash) {
          // 新版郵件常帶 token_hash，需要 verifyOtp 產生恢復 session
          await auth.verifyOtp({ type: 'recovery', token_hash: tokenHash });
        } else if (code) {
          // 舊版或自訂回跳可能帶 code
          await auth.exchangeCodeForSession(url.href);
        }
        // 若僅有 #access_token，supabase 會自動讀取並建立 session（在 createClient 時）
      } catch (e) {
        console.warn('[auth] recovery verify/exchange failed:', e);
      }

      // 移除敏感 query/hash 參數，避免殘留在歷史
      try { history.replaceState(null, '', location.pathname); } catch(_) {}
      // 打開新密碼輸入對話框
      try { showResetPasswordModal(); } catch(_) {}
      return;
    }

    // 魔術連結登入：若帶 code 或 #access_token，盡量交換/建立 session
    if (code || hasAccessToken) {
      try { await auth.exchangeCodeForSession(url.href); } catch (_) {}
      try { history.replaceState(null, '', location.pathname); } catch(_) {}
    }
  } catch (e) {
    console.warn('[auth] handleAuthCallbackIfAny error:', e);
  }
}

function showResetPasswordModal() {
  try { ui.openModal(); } catch(_) {}
  try { dom.modalTitle.textContent = '重設密碼'; } catch(_) {}
  const html = `
    <div class="auth-modal" style="min-width:300px;">
      <div class="auth-field">
        <label for="npw1">新密碼</label>
        <div style="display:flex;gap:8px;align-items:center;">
          <input id="npw1" type="password" placeholder="至少 6 位" style="flex:1;">
          <button id="npw1-toggle" class="btn-secondary" type="button" style="white-space:nowrap;">顯示</button>
        </div>
      </div>
      <div class="auth-field">
        <label for="npw2">確認新密碼</label>
        <div style="display:flex;gap:8px;align-items:center;">
          <input id="npw2" type="password" placeholder="再輸入一次" style="flex:1;">
          <button id="npw2-toggle" class="btn-secondary" type="button" style="white-space:nowrap;">顯示</button>
        </div>
      </div>
      <div class="auth-actions">
        <button id="npw-submit" class="btn-primary" type="button">更新密碼</button>
      </div>
      <div id="npw-msg" class="auth-msg"></div>
    </div>`;
  dom.modalBody.innerHTML = html;
  const pw1 = dom.modalBody.querySelector('#npw1');
  const pw2 = dom.modalBody.querySelector('#npw2');
  const btn = dom.modalBody.querySelector('#npw-submit');
  const msg = dom.modalBody.querySelector('#npw-msg');
  const t1 = dom.modalBody.querySelector('#npw1-toggle');
  const t2 = dom.modalBody.querySelector('#npw2-toggle');
  if (t1) t1.onclick = () => { const toText = pw1.type==='password'; pw1.type = toText?'text':'password'; t1.textContent = toText?'隱藏':'顯示'; };
  if (t2) t2.onclick = () => { const toText = pw2.type==='password'; pw2.type = toText?'text':'password'; t2.textContent = toText?'隱藏':'顯示'; };
  btn.onclick = async () => {
    const a = (pw1.value || '').trim();
    const b = (pw2.value || '').trim();
    if (!a || a.length < 6) { msg.textContent = '請輸入至少 6 位的新密碼'; return; }
    if (a !== b) { msg.textContent = '兩次輸入不一致'; return; }
    btn.disabled = true; btn.textContent = '更新中...';
    try {
      const { error } = await auth.updateUser({ password: a });
      if (error) throw error;
      msg.textContent = '已更新密碼';
      setTimeout(() => { try { ui.closeModal(); } catch(_) {} }, 600);
    } catch (e) {
      msg.textContent = '錯誤：' + (e?.message || '請稍後再試');
    } finally {
      btn.disabled = false; btn.textContent = '更新密碼';
    }
  };
}

function showChangePasswordModal() {
  try { ui.openModal(); } catch(_) {}
  try { dom.modalTitle.textContent = '變更密碼'; } catch(_) {}
  const html = `
    <div class="auth-modal" style="min-width:300px;">
      <div class="auth-field">
        <label for="cpw1">新密碼</label>
        <div style="display:flex;gap:8px;align-items:center;">
          <input id="cpw1" type="password" placeholder="至少 6 位" style="flex:1;">
          <button id="cpw1-toggle" class="btn-secondary" type="button" style="white-space:nowrap;">顯示</button>
        </div>
      </div>
      <div class="auth-field">
        <label for="cpw2">確認新密碼</label>
        <div style="display:flex;gap:8px;align-items:center;">
          <input id="cpw2" type="password" placeholder="再輸入一次" style="flex:1;">
          <button id="cpw2-toggle" class="btn-secondary" type="button" style="white-space:nowrap;">顯示</button>
        </div>
      </div>
      <div class="auth-actions">
        <button id="cpw-submit" class="btn-primary" type="button">更新密碼</button>
      </div>
      <div id="cpw-msg" class="auth-msg"></div>
    </div>`;
  dom.modalBody.innerHTML = html;
  const pw1 = dom.modalBody.querySelector('#cpw1');
  const pw2 = dom.modalBody.querySelector('#cpw2');
  const btn = dom.modalBody.querySelector('#cpw-submit');
  const msg = dom.modalBody.querySelector('#cpw-msg');
  const t1 = dom.modalBody.querySelector('#cpw1-toggle');
  const t2 = dom.modalBody.querySelector('#cpw2-toggle');
  if (t1) t1.onclick = () => { const toText = pw1.type==='password'; pw1.type = toText?'text':'password'; t1.textContent = toText?'隱藏':'顯示'; };
  if (t2) t2.onclick = () => { const toText = pw2.type==='password'; pw2.type = toText?'text':'password'; t2.textContent = toText?'隱藏':'顯示'; };
  btn.onclick = async () => {
    const a = (pw1.value || '').trim();
    const b = (pw2.value || '').trim();
    if (!a || a.length < 6) { msg.textContent = '請輸入至少 6 位的新密碼'; return; }
    if (a !== b) { msg.textContent = '兩次輸入不一致'; return; }
    btn.disabled = true; btn.textContent = '更新中...';
    try {
      const { error } = await auth.updateUser({ password: a });
      if (error) throw error;
      msg.textContent = '已更新密碼';
      setTimeout(() => { try { ui.closeModal(); } catch(_) {} }, 600);
    } catch (e) {
      msg.textContent = '錯誤：' + (e?.message || '請稍後再試');
    } finally {
      btn.disabled = false; btn.textContent = '更新密碼';
    }
  };
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
    try {
      const raw = localStorage.getItem('pen_global_settings');
      if (raw) {
        const s = JSON.parse(raw);
        settings.aiUrl = s?.ai?.apiUrl || '';
        settings.ttsUrl = s?.tts?.baseUrl || '';
      settings.ttsUrlRemote = s?.tts?.baseUrlRemote || '';
      settings.ttsUrlLocal = s?.tts?.baseUrlLocal || '';
      settings.ttsUrlCustom = s?.tts?.baseUrlCustom || '';
      settings.ttsUse = s?.tts?.use || 'remote';
        settings.readEn = (s?.reading && s.reading.englishVariant) || 'en-GB';
        settings.readZh = (s?.reading && s.reading.chineseVariant) || 'zh-CN';
        settings.selectedVoices = (s?.tts && s.tts.selectedVoices) || {};
        settings.models = (s?.ai && s.ai.models) || {};
        settings.assistantEnabled = (s?.assistant && s.assistant.enabled !== false);
        settings.assistantStream = (s?.assistant && s.assistant.stream !== false);
      }
  } catch(_) {}
  try { const raw = localStorage.getItem('pen_global_secrets'); if (raw) { const s = JSON.parse(raw); secrets.aiKey = s?.aiApiKey || ''; secrets.ttsKey = s?.ttsApiKey || ''; } } catch(_) {}
  return { settings, secrets };
}

// -----------------
// Assistant Sessions Modal
// -----------------
async function showAssistantSessions(){
  try { ui.openModal(); } catch(_) {}
  try { dom.modalTitle.textContent = 'AI 會話'; } catch(_) {}
  try { const mc = dom.appModal.querySelector('.modal-content'); if (mc) mc.classList.add('modal-large'); } catch(_) {}

  // 單次注入樣式（避免全局污染）
  (function injectStyle(){
    const id = 'assistant-sessions-style';
    if (document.getElementById(id)) return;
    const st = document.createElement('style'); st.id = id; st.textContent = `
      /* 左右兩欄的總容器固定高度，確保內部出現滾動條 */
      #as-layout{display:grid;grid-template-columns:280px 1fr;gap:12px;height:72vh;overflow:hidden}
      #as-left-wrap{display:flex;flex-direction:column;gap:8px;height:100%}
      #as-left{border:1px solid #e5e7eb;border-radius:10px;overflow:auto;background:#fff;flex:1}
      #as-right{border:1px solid #e5e7eb;border-radius:10px;background:#fff;display:flex;flex-direction:column;height:100%;overflow:hidden;position:relative}
      #as-right-body{flex:1;padding:10px;overflow:auto;font-size:13px;display:flex;flex-direction:column;gap:2px}
      #as-right-toolbar{position:sticky;bottom:0;background:#fff;border-top:1px solid #eef2f7;padding:8px;display:flex;gap:6px;align-items:center}
      #as-right-toolbar .btn{padding:6px 10px;font-size:12px}
      #as-left-toolbar .btn{padding:6px 8px;font-size:12px}
      #as-question{flex:1;border:1px solid #d1d5db;border-radius:8px;padding:6px 8px;min-width:120px}
      #as-left .as-item{padding:10px 12px;border-bottom:1px dashed #eef2f7;cursor:pointer}
      #as-left .as-item.active{background:#f1f5f9}
      /* 預覽面板的 markdown 基本樣式（若未載入 assistant 風格時的降級樣式） */
      #as-right-body .assistant-msg{white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;padding:10px 12px;border-radius:10px;margin:4px 0;box-sizing:border-box}
      #as-right-body .assistant-user{background:#e6f0ff;color:#0f172a;border:1px solid #cfe0ff;align-self:flex-end;box-shadow:inset -3px 0 0 #60a5fa}
      #as-right-body .assistant-assistant{background:#f6f8fb;color:#0f172a;border:1px solid #e5e7eb;align-self:flex-start;box-shadow:inset 3px 0 0 #cbd5e1}
      #as-right-body .assistant-msg{max-width:86%}
      #as-right-body .assistant-msg pre{background:#0b1220;color:#e5e7eb;border:1px solid #0b1220;border-radius:10px;padding:12px 14px;overflow:auto;position:relative}
      #as-right-body .assistant-msg .assistant-copy{position:absolute;top:8px;right:8px;font-size:12px;padding:4px 8px;border-radius:8px;border:1px solid #334155;background:#0f172a;color:#cbd5e1;opacity:.85;cursor:pointer}
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
  let index = [];
  try { const raw = localStorage.getItem('assistantConvIndex'); index = raw ? JSON.parse(raw) : []; } catch(_) {}
  if (!Array.isArray(index)) index = [];

  const layout = document.createElement('div');
  layout.id = 'as-layout';
  const leftWrap = document.createElement('div'); leftWrap.id = 'as-left-wrap';
  const leftToolbar = document.createElement('div'); leftToolbar.id = 'as-left-toolbar'; leftToolbar.style.cssText='display:flex;gap:6px;flex-wrap:wrap;';
  leftToolbar.innerHTML = `<button id="as-new" class="btn primary" style="padding:6px 8px;font-size:12px;">新建</button>
  <input id="as-import" type="file" accept="application/json" style="display:none"><button id="as-import-btn" class="btn secondary" style="padding:6px 8px;font-size:12px;">匯入</button>
  <span style="flex:1"></span>
  <button id="as-rename" class="btn tertiary" title="修改標題" style="padding:6px 8px;font-size:12px;">重命名</button>
  <button id="as-delete" class="btn danger" title="刪除目前會話" style="padding:6px 8px;font-size:12px;">刪除</button>`;
  const left = document.createElement('div'); left.id = 'as-left';
  leftWrap.appendChild(leftToolbar); leftWrap.appendChild(left);
  const right = document.createElement('div'); right.id = 'as-right';

  left.innerHTML = index.length ? index.map(m => {
    const title = (m.articleKey==='global' ? '全局 · ' : '') + (m.title || '會話');
    const time = new Date(m.updatedAt || Date.now()).toLocaleString();
    return `<div class="as-item" data-id="${m.id}" title="點擊預覽，雙擊直接在助手中開啟">
      <div style="font-weight:600;color:#111827;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(title)}</div>
      <div style="font-size:12px;color:#64748b;">${time}</div>
    </div>`;
  }).join('') : '<div style="padding:12px;color:#64748b;">尚無會話</div>';

  layout.appendChild(leftWrap); layout.appendChild(right);
  dom.modalBody.innerHTML=''; dom.modalBody.appendChild(layout);

  let currentId = '';
  let currentArticleKey = '';
  const rightBody = document.createElement('div'); rightBody.id = 'as-right-body';
  const rightToolbar = document.createElement('div'); rightToolbar.id = 'as-right-toolbar';
  rightToolbar.innerHTML = `<button id="as-open" class="btn primary" style="padding:6px 10px;font-size:12px;">在助手中繼續</button>
  <button id="as-export" class="btn secondary" style="padding:6px 10px;font-size:12px;">匯出</button>
  <input id="as-question" type="text" placeholder="輸入問題…" style="flex:1;border:1px solid #d1d5db;border-radius:8px;padding:6px 8px;">
  <button id="as-send" class="btn primary" style="padding:6px 10px;font-size:12px;">發送</button>`;
  right.appendChild(rightBody); right.appendChild(rightToolbar);

  async function renderConversation(id){
    currentId = id; const meta = index.find(x=>x.id===id) || {}; currentArticleKey = meta.articleKey || 'global';
    rightBody.innerHTML = '<div style="padding:8px;color:#64748b;">載入中...</div>';
    try {
      const rec = await cache.getItem('assistant:conv:'+id);
      const msgs = (rec && rec.messages) ? rec.messages : [];
      const html = msgs.map(m => {
        if (m.role === 'assistant') return `<div class=\"assistant-msg assistant-assistant\">${markdownToHtml(m.content||'')}</div>`;
        return `<div class=\"assistant-msg assistant-user\">${escapeHtml(m.content||'')}</div>`;
      }).join('');
      rightBody.innerHTML = html || '<div style="padding:8px;color:#64748b;">此會話暫無訊息</div>';
      // 為預覽面板中的程式碼塊補上複製按鈕
      try { rightBody.querySelectorAll('pre').forEach(pre => {
        if (pre.querySelector('.assistant-copy')) return;
        const code = pre.querySelector('code');
        const btn = document.createElement('button');
        btn.className = 'assistant-copy'; btn.textContent = '複製';
        btn.addEventListener('click', async () => {
          try { const txt = code ? code.innerText : pre.innerText; await navigator.clipboard.writeText(txt); btn.textContent='已複製'; setTimeout(()=> btn.textContent='複製', 1200); } catch(_) {}
        });
        pre.appendChild(btn);
      }); } catch(_) {}
    } catch(e) { rightBody.innerHTML = '<div style="padding:8px;color:#ef4444;">載入失敗</div>'; }
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
    const ak = prompt('請輸入文章鍵（留空為全局）','') || '';
    const articleKey = ak.trim() ? ak.trim() : 'global';
    const title = prompt('會話名稱','新會話') || '新會話';
    const id = `c_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
    try {
      const raw = localStorage.getItem('assistantConvIndex'); const arr = raw? JSON.parse(raw):[]; arr.unshift({ id, articleKey, title, updatedAt:new Date().toISOString() }); localStorage.setItem('assistantConvIndex', JSON.stringify(arr));
      await cache.setItem('assistant:conv:'+id, { messages: [] });
      index = arr; left.innerHTML += `<div class=\"as-item\" data-id=\"${id}\" style=\"padding:10px 12px;border-bottom:1px dashed #eef2f7;cursor:pointer;\"><div style=\"font-weight:600;color:#111827;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;\">${escapeHtml((articleKey==='global'?'全局 · ':'')+title)}</div><div style=\"font-size:12px;color:#64748b;\">${new Date().toLocaleString()}</div></div>`;
    } catch(_) {}
  });
  // 匯入
  leftToolbar.querySelector('#as-import-btn').addEventListener('click', ()=> leftToolbar.querySelector('#as-import').click());
  leftToolbar.querySelector('#as-import').addEventListener('change', async (ev) => {
    const f = ev.target.files && ev.target.files[0]; if (!f) return;
    try {
      const text = await f.text(); const json = JSON.parse(text||'{}');
      const articleKey = json.articleKey || 'global'; const title = json.title || '匯入會話'; const messages = Array.isArray(json.messages)? json.messages: [];
      const id = `c_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
      const raw = localStorage.getItem('assistantConvIndex'); const arr = raw? JSON.parse(raw):[]; arr.unshift({ id, articleKey, title, updatedAt:new Date().toISOString() }); localStorage.setItem('assistantConvIndex', JSON.stringify(arr));
      await cache.setItem('assistant:conv:'+id, { messages }); index = arr; left.innerHTML += `<div class=\"as-item\" data-id=\"${id}\" style=\"padding:10px 12px;border-bottom:1px dashed #eef2f7;cursor:pointer;\"><div style=\"font-weight:600;color:#111827;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;\">${escapeHtml((articleKey==='global'?'全局 · ':'')+title)}</div><div style=\"font-size:12px;color:#64748b;\">${new Date().toLocaleString()}</div></div>`;
    } catch(e) { alert('匯入失敗：' + (e?.message||'')); }
  });
  // 重命名
  leftToolbar.querySelector('#as-rename').addEventListener('click', () => {
    const active = left.querySelector('.as-item.active');
    const id = active ? active.getAttribute('data-id') : (currentId || '');
    if (!id) { alert('請先選擇一個會話'); return; }
    const meta = index.find(x => x.id === id) || null; if (!meta) return;
    const newTitle = prompt('輸入新的會話名稱：', meta.title || '會話');
    if (!newTitle || !newTitle.trim()) return;
    const title = newTitle.trim();
    index = index.map(x => x.id === id ? { ...x, title, updatedAt: new Date().toISOString() } : x);
    try { localStorage.setItem('assistantConvIndex', JSON.stringify(index)); } catch(_) {}
    const item = left.querySelector(`.as-item[data-id="${id}"]`);
    if (item) {
      const titleDiv = item.querySelector('div');
      if (titleDiv) titleDiv.textContent = (meta.articleKey==='global' ? '全局 · ' : '') + title;
    }
  });
  // 刪除
  leftToolbar.querySelector('#as-delete').addEventListener('click', async () => {
    const active = left.querySelector('.as-item.active');
    const id = active ? active.getAttribute('data-id') : (currentId || '');
    if (!id) { alert('請先選擇一個會話'); return; }
    if (!confirm('確定刪除此會話？此操作無法復原。')) return;
    try {
      index = index.filter(x => x.id !== id);
      localStorage.setItem('assistantConvIndex', JSON.stringify(index));
      try { await cache.setItem('assistant:conv:'+id, { messages: [] }); } catch(_) {}
      const node = left.querySelector(`.as-item[data-id="${id}"]`);
      if (node) node.remove();
      if (!left.querySelector('.as-item')) left.innerHTML = '<div style="padding:12px;color:#64748b;">尚無會話</div>';
      if (currentId === id) { currentId = ''; rightBody.innerHTML = '<div style="padding:8px;color:#64748b;">未選擇會話</div>'; }
    } catch (e) { alert('刪除失敗：' + (e?.message || '')); }
  });
  // 匯出
  rightToolbar.querySelector('#as-export').addEventListener('click', async () => {
    if (!currentId) return;
    const meta = index.find(x=>x.id===currentId) || { articleKey:'global', title:'會話' };
    try { const rec = await cache.getItem('assistant:conv:'+currentId); const messages = (rec&&rec.messages)||[]; const blob = new Blob([JSON.stringify({ articleKey: meta.articleKey, title: meta.title, messages }, null, 2)], { type:'application/json' }); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download = `assistant-conv-${currentId}.json`; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href), 1000);} catch(_){}
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
    try { localStorage.setItem('lastSnapshotAt', String(lastSyncAt)); } catch(_) {}
    if (info && typeof info.version === 'number') {
      try { localStorage.setItem('lastSnapshotVersion', String(info.version)); } catch(_) {}
    }
    if (info && info.restoredFromRemote) {
      updateStatus('已從雲端恢復（自動偵測）');
      try { ui.displayMessage('已從雲端恢復（自動偵測）', 'warning', 5000); } catch(_) {}
    } else {
      updateStatus('已完成同步');
      // 自動同步成功不再彈出提示，避免干擾
    }
    try { await backup.createBackup('自動同步後備份'); } catch(_) {}
  } catch (e) {
    console.warn('[sync] auto sync failed:', e);
    updateStatus('自動同步失敗');
  } finally {
    syncInFlight = false;
  }
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
  try { dom.modalTitle.textContent = '本機備份與還原'; } catch(_) {}
  const items = (function(){ try { return backup.listBackups(); } catch(_) { return []; } })();
  const listHtml = items.length ? items.map(it => {
    const timeStr = new Date(parseInt(it.ts,10)||Date.now()).toLocaleString();
    const sizeKB = Math.round((it.size||0)/102.4)/10; // 1 decimal
    const mkBadge = (text, color) => `<span class="bk-badge" style="display:inline-block;padding:1px 6px;margin-left:6px;border-radius:999px;font-size:11px;background:${color.bg};color:${color.fg};border:1px solid ${color.bd};vertical-align:middle;">${escapeHtml(text)}</span>`;
    let noteHtml = '';
    if (it.note) {
      if (/自動同步/.test(it.note)) noteHtml = mkBadge(it.note, { bg:'#f0f9ff', fg:'#075985', bd:'#7dd3fc' });
      else if (/手動/.test(it.note)) noteHtml = mkBadge(it.note, { bg:'#ecfdf5', fg:'#065f46', bd:'#6ee7b7' });
      else noteHtml = `<span style="margin-left:6px;color:#64748b;">${escapeHtml(it.note)}</span>`;
    }
    return `<div class="backup-item" data-id="${it.id}" style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px dashed #eee;">
      <div class="bi-meta">
        <div class="bi-title">${timeStr}${noteHtml}</div>
        <div class="bi-sub" style="color:#64748b;font-size:12px;">ID: ${it.id} · 約 ${sizeKB} KB</div>
      </div>
      <div class="bi-actions" style="display:flex;gap:6px;">
        <button class="btn-secondary bi-restore" data-id="${it.id}">還原</button>
        <button class="btn-tertiary bi-export" data-id="${it.id}">匯出</button>
        <button class="btn-danger bi-delete" data-id="${it.id}">刪除</button>
      </div>
    </div>`;
  }).join('') : '<div style="color:#64748b;padding:8px 0;">尚無備份</div>';

  const html = `
    <div class="backup-modal" style="min-width:340px;">
      <div class="backup-list">${listHtml}</div>
      <div class="auth-actions" style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
        <button id="bk-close" class="btn-secondary">關閉</button>
        <button id="bk-create" class="btn-primary">建立新備份</button>
        <button id="bk-clear-cache" class="btn-tertiary">清理本機快取</button>
      </div>
      <div id="bk-msg" class="auth-msg"></div>
    </div>`;
  dom.modalBody.innerHTML = html;
  const $ = (sel)=> dom.modalBody.querySelector(sel);
  $('#bk-close').onclick = () => ui.closeModal();
  $('#bk-create').onclick = async () => {
    const msg = $('#bk-msg');
    try { await backup.createBackup('manual'); msg.textContent = '已建立備份'; setTimeout(()=> showBackupRestoreModal(), 300); } catch (e) { msg.textContent = '建立備份失敗：' + (e?.message||''); }
  };
  $('#bk-clear-cache').onclick = async () => {
    const msg = $('#bk-msg');
    try { await clearLocalCaches(); msg.textContent = '已清理本機快取'; } catch (e) { msg.textContent = '清理失敗：' + (e?.message||''); }
  };
  // actions
  dom.modalBody.querySelectorAll('.bi-restore').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id');
      try {
        const payload = backup.loadBackupPayload(id);
        if (!payload) { try { ui.displayMessage('備份不存在或已損壞', 'error'); } catch(_) {} return; }
        await applyMergedSnapshot({ payload });
        try { lastSyncAt = Date.now(); localStorage.setItem('lastSnapshotAt', String(lastSyncAt)); } catch(_) {}
        updateStatus('已從備份還原（僅本機）');
        try { ui.displayMessage('已從備份還原（僅本機）', 'success'); } catch(_) {}
        ui.closeModal();
      } catch (e) {
        try { ui.displayMessage('還原失敗：' + (e?.message||''), 'error'); } catch(_) {}
      }
    });
  });
  dom.modalBody.querySelectorAll('.bi-export').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      const payload = backup.loadBackupPayload(id);
      if (!payload) { try { ui.displayMessage('備份不存在或已損壞', 'error'); } catch(_) {} return; }
      try {
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `bdc-backup-${id}.json`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        try { ui.displayMessage('已匯出備份', 'success'); } catch(_) {}
      } catch (_) { try { ui.displayMessage('匯出失敗', 'error'); } catch(_) {} }
    });
  });
  dom.modalBody.querySelectorAll('.bi-delete').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      try { backup.deleteBackup(id); showBackupRestoreModal(); try { ui.displayMessage('已刪除備份', 'success'); } catch(_) {} } catch (_) { try { ui.displayMessage('刪除失敗', 'error'); } catch(_) {} }
    });
  });
}
