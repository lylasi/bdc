// Minimal UI wiring for Supabase-based sync (Scheme C)
// Provides: Login (Email OTP), Logout, and "Sync Now" button

import * as dom from '../../modules/dom.js';
import { buildLocalSnapshot, applyMergedSnapshot } from '../../modules/sync-core.js';
import { syncNow, auth } from '../../modules/sync-supabase.js';

export function initSync() {
  try {
    console.log('[sync] initSync()');
    wireAuthUI();
    if (dom.syncNowBtn) {
      dom.syncNowBtn.addEventListener('click', handleSync);
    } else {
      console.warn('[sync] syncNowBtn not found');
    }
  } catch (e) {
    console.error('[sync] init failed:', e);
  }
}

function wireAuthUI() {
  console.log('[sync] wireAuthUI()', { loginBtn: !!dom.loginBtn, logoutBtn: !!dom.logoutBtn, syncNowBtn: !!dom.syncNowBtn });
  if (dom.loginBtn) dom.loginBtn.addEventListener('click', async () => {
    const mode = prompt('選擇登入方式：\n1 = 電郵魔術連結（免密碼）\n2 = 電郵＋密碼登入\n3 = 新用戶註冊（電郵＋密碼）', '2');
    if (!mode) return;

    if (mode === '2') {
      const email = prompt('請輸入電郵：');
      if (!email) return;
      const password = prompt('請輸入密碼（注意：此視窗不會隱藏輸入，建議後續改成自訂彈窗）：');
      if (!password) return;
      const { error } = await auth.signInWithPassword({ email, password });
      if (error) {
        updateStatus('登入失敗：' + error.message);
        alert('登入失敗：' + error.message);
      } else {
        updateStatus('登入成功');
      }
      return;
    }

    if (mode === '3') {
      const email = prompt('請輸入電郵（用於登入/找回密碼）：');
      if (!email) return;
      const password = prompt('設定密碼（至少 6 位）：');
      if (!password) return;
      const { data, error } = await auth.signUp({ email, password });
      if (error) {
        updateStatus('註冊失敗：' + error.message);
        alert('註冊失敗：' + error.message);
      } else {
        if (data?.user && !data?.session) {
          updateStatus('註冊成功，請至電郵完成驗證');
          alert('註冊成功，請至電郵完成驗證');
        } else {
          updateStatus('註冊並登入成功');
        }
      }
      return;
    }

    // 默認：魔術連結
    const email = prompt('請輸入登入電郵（將寄送登入連結）：');
    if (!email) return;
    const { error } = await auth.signInWithOtp({ email });
    if (error) {
      updateStatus('登入失敗：' + error.message);
      alert('登入失敗：' + error.message);
    } else {
      updateStatus('已傳送登入連結，請到電郵確認');
      alert('已傳送登入連結，請到電郵確認');
    }
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
  });

  // 初始化一次（避免等待事件）
  auth.getSession().then(({ data }) => {
    const user = data?.session?.user || null;
    updateAuthButtons(user);
    updateStatus(user ? (user.email || '已登入') : '未登入');
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
  if (dom.syncStatus) dom.syncStatus.textContent = text || '';
}

function updateAuthButtons(user) {
  const loggedIn = !!user;
  if (dom.loginBtn) dom.loginBtn.style.display = loggedIn ? 'none' : 'inline-block';
  if (dom.logoutBtn) dom.logoutBtn.style.display = loggedIn ? 'inline-block' : 'none';
}
