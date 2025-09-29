// Minimal UI wiring for Supabase-based sync (Scheme C)
// Provides: Login (Email OTP), Logout, and "Sync Now" button

import * as dom from '../../modules/dom.js';
import { buildLocalSnapshot, applyMergedSnapshot } from '../../modules/sync-core.js';
import { syncNow, auth } from '../../modules/sync-supabase.js';

export function initSync() {
  wireAuthUI();
  if (dom.syncNowBtn) dom.syncNowBtn.addEventListener('click', handleSync);
}

function wireAuthUI() {
  if (dom.loginBtn) dom.loginBtn.onclick = async () => {
    const email = prompt('請輸入登入電郵：');
    if (!email) return;
    const { error } = await auth.signInWithOtp({ email });
    if (error) {
      updateStatus('登入失敗：' + error.message);
      alert('登入失敗：' + error.message);
    } else {
      updateStatus('已傳送登入連結，請到電郵確認');
      alert('已傳送登入連結，請到電郵確認');
    }
  };

  if (dom.logoutBtn) dom.logoutBtn.onclick = async () => {
    try { await auth.signOut(); } catch (_) {}
    updateAuthButtons(null);
    updateStatus('已登出');
  };

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

