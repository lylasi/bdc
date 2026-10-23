// AI 助手（文章詳解模組內的懸浮聊天）
// 注意：不修改全局樣式與 index.html；所有 UI 以動態插入，樣式侷限在 .assistant-* 作用域。

import * as dom from '../../modules/dom.js';
import * as state from '../../modules/state.js';
import * as articleStore from '../../modules/article-store.js';
import * as readingStore from '../../modules/reading-store.js';
import * as readingActions from '../../modules/reading-actions.js';
import { loadGlobalSettings, saveGlobalSettings } from '../../modules/settings.js';
import {
  getTaskModelSelection,
  saveTaskModelSelection,
  stringifyModelSpec
} from '../../modules/ai-models.js';
import { requestAI, resolveAITaskSpec, streamAIResponse } from '../../modules/api.js';
import { touch as syncTouch } from '../../modules/sync-signals.js';
import * as cache from '../../modules/cache.js';
import { markdownToHtml } from '../../modules/markdown.js';
import { confirmAction } from '../../modules/ui.js';
import { getLocale, t, formatDateTime } from '../../modules/i18n.js';
import { buildPrompt } from '../../modules/prompts/index.js';
import { contentVersionOf } from '../../shared/reading-protocol.mjs';
// P3-T5：長文效能量測（?perf=1）；關閉時所有呼叫都是 no-op。
import * as perfProbe from '../article/perf-probe.js';

const LS_KEY = 'assistantConversations'; // legacy（含所有訊息）
const LS_UPDATED_AT = 'assistantUpdatedAt';
const IDX_KEY = 'assistantConvIndex'; // 新索引：[{id, articleKey, title, updatedAt}]

// 「問 AI」只把引用放進輸入框，等使用者自行輸入問題；真正送出時才把
// 學習條目／錨點來源補進訊息，換會話或直接 send 時清除。
let pendingReference = null;

function getAssistantModelOverride() {
  const s = loadGlobalSettings();
  return s?.ai?.tasks?.assistant || s?.ai?.models?.assistant || '';
}

function getAssistantModelSelection(currentValue) {
  return getTaskModelSelection('assistant', {
    currentValue: currentValue ?? getAssistantModelOverride()
  });
}

function getAssistantModelSpec(modelOverride) {
  return getAssistantModelSelection(modelOverride).value || resolveAITaskSpec('assistant') || '';
}

export function initAiAssistant() {
  // 僅在設定啟用時工作
  const s = loadGlobalSettings();
  if (s?.assistant && s.assistant.enabled === false) return;
  mountUi();
  setupVisibilityLogic();
  exposeGlobalAPI();
  // 文章版本／文章切換時更新 context chip（不重建面板）。
  const refreshChip = () => updateContextChip(document.getElementById('assistant-panel'));
  document.addEventListener('bdc:article-loaded', refreshChip);
  // article-store 的變更事件發在 window 上（不會冒泡到 document）。
  window.addEventListener('bdc:articles-change', refreshChip);
  let chipTimer = 0;
  if (dom.articleInput) {
    dom.articleInput.addEventListener('input', () => {
      clearTimeout(chipTimer);
      chipTimer = setTimeout(refreshChip, 300);
    });
  }
  // ── locale 切換（P3-T3）─────────────────────────────────────────────
  // 面板 DOM 會重建，草稿／游標／模式／會話只存在記憶體，必須先 capture 再 restore。
  // 連續快速切換以遞增 token 防止舊的非同步 restore 覆蓋新語言。
  document.addEventListener('bdc:locale-change', () => {
    const token = ++localeToken;
    const snapshot = captureAssistantUiState();
    const draftSource = document.getElementById('assistant-panel')?.querySelector('#assistant-input') || null;
    // 串流中：先中止，讓 P1-T5 的 cancelled 標記與半段保存照原流程跑完。
    const wasStreaming = !!activeAsk;
    if (wasStreaming) {
      try { activeAsk.controller?.abort('locale-change'); } catch (_) { /* noop */ }
    }
    // 先拆掉舊的觀察器與 window listener，避免每次切語言都累積。
    teardownVisibilityLogic();
    document.getElementById('assistant-history-panel')?.remove();
    document.getElementById('assistant-panel')?.remove();
    document.getElementById('assistant-fab')?.remove();
    mountUi();
    setupVisibilityLogic();
    restoreAssistantUiState(snapshot, {
      token,
      waitForAsk: wasStreaming,
      // 舊面板已卸載，但 P1-T5 的 restoreDraft 仍可能把原問題寫回那個 textarea。
      refreshDraftFrom: wasStreaming ? draftSource : null
    }).catch(() => {});
  });
}

// wirePanel／setupVisibilityLogic 掛在 window 上的 listener 都要能一併移除。
const windowListeners = [];
let visibilityTeardown = null;
// 每次 locale 切換遞增；非同步 restore 完成後要驗證自己仍是最新的一次。
let localeToken = 0;
const ASSISTANT_LOCALE_IDLE_TIMEOUT = 6000;

function addManagedWindowListener(type, handler, options) {
  try {
    window.addEventListener(type, handler, options);
    windowListeners.push({ type, handler, options });
  } catch (_) { /* noop */ }
}

/**
 * 切語言前先記住面板的可見狀態、模式、草稿、游標與捲動位置。
 * 會話 id 從最後一則訊息的 data-* 取，不必再跑一次非同步的 buildContext。
 */
function captureAssistantUiState() {
  const panel = document.getElementById('assistant-panel');
  const input = panel?.querySelector('#assistant-input');
  const box = panel?.querySelector('#assistant-messages');
  const last = box ? box.lastElementChild : null;
  const convId = String(last?.dataset?.conversationId || '');
  const articleId = String(last?.dataset?.articleId || '');
  let mode = 'floating';
  if (panel?.classList.contains('assistant-dock')) mode = 'dock';
  else if (panel?.classList.contains('assistant-modal')) mode = 'modal';
  else if (!panel) { try { mode = getSavedPanelMode(); } catch (_) { mode = 'floating'; } }
  let articleKey = articleId;
  if (convId) {
    try {
      const meta = readIndex().find((item) => item.id === convId);
      if (meta) articleKey = meta.articleKey || articleKey;
    } catch (_) { /* noop */ }
  }
  return {
    wasOpen: !!panel && !panel.classList.contains('assistant-hidden'),
    mode,
    inputValue: input ? String(input.value || '') : '',
    selectionStart: input && Number.isInteger(input.selectionStart) ? input.selectionStart : null,
    selectionEnd: input && Number.isInteger(input.selectionEnd) ? input.selectionEnd : null,
    inputFocused: !!input && document.activeElement === input,
    scrollTop: box ? Number(box.scrollTop) || 0 : 0,
    convId,
    articleKey
  };
}

function waitForAssistantIdle(timeout = ASSISTANT_LOCALE_IDLE_TIMEOUT) {
  const token = activeAsk;
  if (!token || !token.settled || typeof token.settled.then !== 'function') return Promise.resolve();
  return Promise.race([
    token.settled,
    new Promise((resolve) => setTimeout(resolve, timeout))
  ]);
}

/**
 * 掛載新 DOM 之後還原面板狀態。
 * 只還原使用者自己的草稿與位置，不代為送出、不重讀 AI；scroll 失敗時退回頂部。
 */
async function restoreAssistantUiState(snapshot, { token = localeToken, waitForAsk = false, refreshDraftFrom = null } = {}) {
  const saved = { ...(snapshot || {}) };
  if (token !== localeToken) return false;
  // 串流被中止後要等它把半段以 cancelled 存完，重開會話才看得到。
  if (waitForAsk && activeAsk) {
    await waitForAssistantIdle();
    if (token !== localeToken) return false;
  }
  // 中止流程可能把「原本的問題」寫回舊 textarea（P1-T5 的 restoreDraft）；
  // 舊節點已卸載但仍是同一份草稿，以它為準才不會把可重試的問題弄丢。
  if (refreshDraftFrom && typeof refreshDraftFrom.value === 'string') {
    if (String(refreshDraftFrom.value || '') !== String(saved.inputValue || '')) {
      saved.inputValue = String(refreshDraftFrom.value || '');
      saved.selectionStart = null;
      saved.selectionEnd = null;
      saved.inputFocused = true;
    }
  }
  const panel = document.getElementById('assistant-panel');
  if (!panel) return false;
  if (saved.mode) {
    setPanelMode(panel, saved.mode);
    if (saved.mode === 'dock') setDockWidth(panel, getSavedDockWidth());
  }
  if (saved.convId) {
    const meta = readIndex().find((item) => item.id === saved.convId);
    if (meta) setCurrentConvId(meta.articleKey, meta.id);
  }
  if (saved.wasOpen) {
    panel.classList.remove('assistant-hidden');
    updateBackdrop();
    updateHeaderTitle();
    updateContextChip(panel);
    if (!activeAsk) {
      try { await restoreConversation(panel, saved.articleKey || undefined); } catch (_) { /* noop */ }
      updateSessionLabel();
    }
  } else {
    panel.classList.add('assistant-hidden');
    updateBackdrop();
  }
  if (token !== localeToken) return false;
  const draft = String(saved.inputValue || '');
  const input = panel.querySelector('#assistant-input');
  if (input) {
    input.value = draft;
    autoGrowInput(input);
  }
  const box = panel.querySelector('#assistant-messages');
  if (box) {
    try { box.scrollTop = Number(saved.scrollTop) || 0; } catch (_) { /* 退回頂部 */ }
  }
  if (input && saved.wasOpen && saved.inputFocused) {
    try { input.focus({ preventScroll: true }); } catch (_) { /* noop */ }
    // 聚焦可能把游標推到結尾；焦點與選取都還原後才算完成。
    if (Number.isInteger(saved.selectionStart)) {
      const end = Number.isInteger(saved.selectionEnd) ? saved.selectionEnd : saved.selectionStart;
      try { input.setSelectionRange(saved.selectionStart, end); } catch (_) { /* noop */ }
    }
  }
  // 只有草稿非空才提示，且同一次切換只提示一次，不重複洗版。
  if (saved.wasOpen && draft.trim() && token === localeToken) {
    addHint(panel, t('assistant.localeKeptDraft'));
  }
  return true;
}

function mountUi() {
  if (document.getElementById('assistant-fab')) return;
  const fab = document.createElement('button');
  fab.id = 'assistant-fab';
  fab.className = 'assistant-fab';
  fab.type = 'button';
  fab.title = t('assistant.title');
  fab.setAttribute('aria-label', t('assistant.title'));
  fab.innerHTML = '<span class="assistant-fab-text" aria-hidden="true">AI</span>';
  document.body.appendChild(fab);

  const panel = document.createElement('div');
  panel.id = 'assistant-panel';
  panel.className = 'assistant-panel assistant-hidden';
  panel.innerHTML = renderPanelHtml();
  document.body.appendChild(panel);

  // 綁定事件
  fab.addEventListener('click', () => {
    const s = loadGlobalSettings();
    if (s?.assistant && s.assistant.enabled === false) return;
    panel.classList.toggle('assistant-hidden');
    updateBackdrop();
    if (!panel.classList.contains('assistant-hidden')) {
      // 重新套用當前文章的顯示模式，避免初始化時以舊文章鍵讀到 dock 寬度殘留
      const mode = getSavedPanelMode();
      setPanelMode(panel, mode);
      if (mode === 'dock') setDockWidth(panel, getSavedDockWidth());
      updateHeaderTitle();
      updateSessionLabel();
      updateContextChip(panel);
      restoreConversation(panel).catch(() => {});
      const input = panel.querySelector('#assistant-input');
      if (input) input.focus();
    }
  });

  wirePanel(panel);
  // 行動端／locale 切換會重建面板；chip 文字必須馬上依目前文章與語言重算。
  updateContextChip(panel);
}

function setupVisibilityLogic() {
  const fab = document.getElementById('assistant-fab');
  const panel = document.getElementById('assistant-panel');
  if (!fab || !panel) return;
  const update = () => {
    const enabled = (loadGlobalSettings()?.assistant?.enabled !== false);
    const onArticle = !!(dom.articleSection && dom.articleSection.classList.contains('active'));
    fab.style.display = enabled && onArticle ? 'inline-flex' : 'none';
    if (!onArticle) { panel.classList.add('assistant-hidden'); updateBackdrop(); }
  };
  update();
  const updateTimer = setTimeout(update, 300);
  window.addEventListener('hashchange', update);
  let mo = null;
  try {
    mo = new MutationObserver(update);
    if (dom.articleSection) mo.observe(dom.articleSection, { attributes: true, attributeFilter: ['class'] });
  } catch(_) { mo = null; }
  const navButtons = Array.isArray(dom.navBtns) ? dom.navBtns.slice() : [];
  try { navButtons.forEach(btn => btn.addEventListener('click', update)); } catch(_) {}
  // 切語言會重建面板：舊的觀察器與 listener 必須能一次拆乾淨，避免累積。
  visibilityTeardown = () => {
    clearTimeout(updateTimer);
    try { window.removeEventListener('hashchange', update); } catch (_) { /* noop */ }
    try { mo?.disconnect(); } catch (_) { /* noop */ }
    navButtons.forEach((btn) => { try { btn.removeEventListener('click', update); } catch (_) { /* noop */ } });
  };
}

function teardownVisibilityLogic() {
  if (typeof visibilityTeardown === 'function') {
    try { visibilityTeardown(); } catch (_) { /* noop */ }
  }
  visibilityTeardown = null;
  // wirePanel 掛在 window 上的 resize 監聽（輸入框自動長高、dock 寬度）也要一起移除。
  while (windowListeners.length) {
    const entry = windowListeners.pop();
    try { window.removeEventListener(entry.type, entry.handler, entry.options); } catch (_) { /* noop */ }
  }
}

function renderPanelHtml() {
  const selection = getAssistantModelSelection();
  const toSelect = stringifyModelSpec(selection.value);
  const placeholder = selection.disabled ? t('assistant.configureModel') : '';
  const selectHtml = selection.disabled
    ? ''
    : `<label class="assistant-switch">${t('assistant.model')}
    <select id="assistant-model-select" class="assistant-model-select" title="">
      ${selection.options.map(option => `<option value="${escapeHtml(option.value)}" ${option.value === toSelect ? 'selected' : ''}>${escapeHtml(option.label || option.value)}</option>`).join('')}
    </select>
  </label>`;
  const title = extractArticleTitle();
  const headerTitle = isGlobalArticle() ? t('assistant.global') : (title || t('assistant.article'));
  return `
    <div class="assistant-head">
      <div class="assistant-title"><div class="assistant-article">${t('assistant.title')} · <span id="assistant-article-title">${escapeHtml(headerTitle)}</span></div><div id="assistant-session-label" class="assistant-session"></div></div>
      <div class="assistant-actions">
        <button class="assistant-icon" id="assistant-small" title="${t('assistant.smallWindow')}">${svgSmall()}</button>
        <button class="assistant-icon" id="assistant-dock" title="${t('assistant.dockRight')}">${svgPin()}</button>
        <button class="assistant-icon" id="assistant-modal" title="${t('assistant.largeWindow')}">${svgMax()}</button>
        <span class="assistant-divider"></span>
        <button class="assistant-icon" id="assistant-new" title="${t('assistant.newSession')}">${svgPlus()}</button>
        <button class="assistant-icon" id="assistant-history" title="${t('assistant.viewSessions')}">${svgList()}</button>
        <button class="assistant-icon" id="assistant-close" title="${t('assistant.close')}">${svgClose()}</button>
      </div>
    </div>
    <div id="assistant-context-chip" class="assistant-context-chip" aria-live="polite"></div>
    <div id="assistant-messages" class="assistant-messages" aria-live="polite"></div>
    <div class="assistant-foot">
      <div class="assistant-row">
        <textarea id="assistant-input" class="assistant-input" rows="1" placeholder="${t('assistant.inputPlaceholder')}" aria-label="${t('assistant.inputPlaceholder')}" aria-describedby="assistant-input-hint"></textarea>
        <button id="assistant-send" class="assistant-send">${t('assistant.send')}</button>
      </div>
      <div id="assistant-input-hint" class="assistant-input-hint">${t('assistant.inputHint')}</div>
       <div class="assistant-sub">
        <label class="assistant-switch"><input id="assistant-stream" type="checkbox" ${loadGlobalSettings()?.assistant?.stream === false ? '' : 'checked'}> ${t('assistant.streaming')}</label>
        ${selectHtml}
        <span class="assistant-font">${t('assistant.fontSize')}
          <button class="assistant-font-btn" data-size="s" title="11px">${t('assistant.small')}</button>
          <button class="assistant-font-btn" data-size="l" title="13px">${t('assistant.large')}</button>
        </span>
      </div>
      ${selection.disabled ? `<div class="assistant-model-hint">${escapeHtml(placeholder)}</div>` : ''}
  </div>`;
}

function wirePanel(panel) {
  const $ = (sel) => panel.querySelector(sel);
  // 關閉按鈕：隱藏面板（移除重複的最小化按鈕，以免與關閉重覆）
  $('#assistant-close').addEventListener('click', () => { panel.classList.add('assistant-hidden'); updateBackdrop(); });
  // 模式切換（精簡版）：小視窗/靠右全高/居中彈窗
  $('#assistant-small').addEventListener('click', () => setPanelMode(panel,'floating'));
  $('#assistant-dock').addEventListener('click', () => setPanelMode(panel,'dock'));
  $('#assistant-modal').addEventListener('click', () => setPanelMode(panel,'modal'));
  // 初始化模式與尺寸
  setPanelMode(panel, getSavedPanelMode());
  if (getSavedPanelMode()==='dock') setDockWidth(panel, getSavedDockWidth());
  addManagedWindowListener('resize', () => { if (getSavedPanelMode()==='dock') setDockWidth(panel, getSavedDockWidth()); });

  // 字級
  setFontSize(panel, getSavedFontSize());
  panel.querySelectorAll('.assistant-font-btn').forEach(btn => {
    btn.addEventListener('click', () => setFontSize(panel, btn.getAttribute('data-size')));
  });

  // 模型選擇（保存至本機設定）
  const modelSel = panel.querySelector('#assistant-model-select');
  if (modelSel) {
    modelSel.addEventListener('change', () => {
      try {
        saveTaskModelSelection('assistant', modelSel.value || '');
      } catch(_) {}
    });
  }

  // 會話：新建 / 歷史
  $('#assistant-new').addEventListener('click', () => newConversation(panel));
  $('#assistant-history').addEventListener('click', () => toggleHistory(panel));
  $('#assistant-stream').addEventListener('change', (ev) => {
    try {
      saveGlobalSettings({ assistant: { stream: ev.target.checked } });
    } catch(_) {}
  });
  const input = $('#assistant-input');
  const send = $('#assistant-send');
  const messagesBox = $('#assistant-messages');
  let isComposing = false;
  const doSend = () => {
    const q = (input.value || '').trim();
    if (!q) return;
    // 單一會話序列：回答中不送出第二題，保留使用者輸入並提示。
    if (activeAsk) {
      addHint(panel, t('assistant.busy'));
      input.focus();
      return;
    }
    input.value = '';
    autoGrowInput(input);
    const pending = pendingReference;
    pendingReference = null;
    ask(panel, q, pending
      ? { ...pending.context, articleKey: pending.articleKey || undefined, convId: pending.convId || undefined }
      : {});
  };
  send.addEventListener('click', doSend);
  input.addEventListener('compositionstart', () => { isComposing = true; });
  input.addEventListener('compositionend', () => { isComposing = false; });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    // 中文／日文輸入法選字時的 Enter 不是送出；229 是部分瀏覽器的 composition 鍵碼。
    if (isComposing || e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    doSend();
  });
  input.addEventListener('input', () => {
    autoGrowInput(input);
    // 使用者把預填的引用刪掉後，不再把這則訊息連到原本的學習條目。
    if (pendingReference && pendingReference.text && !input.value.includes(pendingReference.text)) {
      pendingReference = null;
    }
  });
  autoGrowInput(input);
  addManagedWindowListener('resize', () => autoGrowInput(input));
  // 使用者手動捲到底部時收起「有新回答」提示；不要把正在看舊訊息的人拉回。
  messagesBox?.addEventListener('scroll', () => {
    if (isNearBottom(messagesBox, 48)) hideNewAnswerHint(panel);
  }, { passive: true });
}

function updateHeaderTitle(){
  try {
    const titleText = extractArticleTitle();
    const el = document.getElementById('assistant-article-title');
    if (!el) return;
    el.textContent = isGlobalArticle() ? t('assistant.global') : (titleText || t('assistant.article'));
  } catch(_){}
}

function shortContentVersion(version) {
  const raw = String(version || '');
  const match = raw.match(/^cv1_([0-9a-f]+)/i);
  return match ? match[1].slice(0, 8) : raw.slice(0, 8);
}

/**
 * 助手 context chip（P1-T6）：顯示目前會用哪篇、哪個版本，以及是否尚未分析。
 * 只讀目前輸入與文章記錄，不觸發任何請求。
 */
function updateContextChip(panel) {
  try {
    const target = panel || document.getElementById('assistant-panel');
    const chip = target?.querySelector('#assistant-context-chip');
    if (!chip) return;
    const raw = String((dom.articleInput && dom.articleInput.value) || '');
    if (!raw.trim()) {
      chip.textContent = t('assistant.globalSession');
      chip.dataset.state = 'global';
      return;
    }
    const version = contentVersionOf(raw);
    const title = extractArticleTitle() || t('assistant.article');
    let analyzedVersion = '';
    try {
      const activeId = state.currentArticleId || '';
      const record = activeId ? articleStore.getRecord(activeId) : null;
      // 只有「真的有分析結果」才算已分析；analysis:null 的記錄不得標成 analyzed（P2-4）。
      if (record && record.result && String(record.article || '').trim() === raw.trim()) {
        analyzedVersion = contentVersionOf(record.article || '');
      }
    } catch (_) { /* noop */ }
    const unanalyzed = !analyzedVersion || analyzedVersion !== version;
    const base = t('assistant.contextScope', { title, version: shortContentVersion(version) });
    chip.textContent = unanalyzed ? `${base} · ${t('assistant.contextUnanalyzed')}` : base;
    chip.dataset.state = unanalyzed ? 'unanalyzed' : 'analyzed';
  } catch (_) { /* noop */ }
}

// --------- 新：索引 + IndexedDB 儲存（cache.kv） ---------
function generateConversationId() {
  return `c_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
}

function conversationMeta(conv) {
  if (!conv) return null;
  return {
    id: conv.id,
    articleId: conv.articleId || '',
    articleKey: conv.articleId || conv.legacyArticleKey || 'global',
    title: conv.title || t('assistant.article'),
    updatedAt: conv.updatedAt || ''
  };
}

function readIndex() {
  return readingStore.listConversations().map(conversationMeta).filter(Boolean);
}

// 保留舊呼叫點的相容函式；權威索引已在 readingStore。
function writeIndex() {
  try { syncTouch('assistant'); } catch (_) {}
}

async function idbGetConv(convId) {
  try { return await readingStore.getMessages(convId); } catch (_) { return []; }
}

async function idbSetConv(convId, messages) {
  try {
    const result = await readingStore.setConversationMessages(convId, messages);
    return !!result.ok;
  } catch (_) {
    return false;
  }
}

export function listAssistantConversationMetas() {
  return readIndex();
}

export async function getAssistantConversationMessages(convId) {
  return await idbGetConv(convId);
}

export async function createAssistantConversation({ articleKey = 'global', articleId = '', title = t('assistant.newSession'), id, messages = [] } = {}) {
  const convId = id || generateConversationId();
  const result = await readingStore.ensureConversation({
    id: convId,
    articleId: articleId || (/^(art_|url:|local:)/.test(String(articleKey)) ? articleKey : ''),
    articleKey: articleId ? '' : (articleKey === 'global' ? '' : articleKey),
    title
  });
  if (!result.ok) return null;
  if (Array.isArray(messages) && messages.length) await readingStore.setConversationMessages(convId, messages);
  return conversationMeta(result.conversation);
}

export async function renameAssistantConversation(convId, title) {
  const nextTitle = String(title || '').trim();
  if (!convId || !nextTitle) return null;
  const result = await readingStore.renameConversation(convId, nextTitle);
  if (!result.ok) return null;
  return conversationMeta(result.entity);
}

export async function deleteAssistantConversation(convId) {
  // 回答中禁止刪除會話：刪掉目前會話會連同停止入口一起消失（F6）。
  if (activeAsk) return false;
  if (!convId) return false;
  const target = readingStore.getConversation(convId);
  if (!target) return false;
  const result = await readingStore.deleteConversation(convId);
  if (!result.ok) return false;
  try {
    const currentMap = getCurrentMap();
    const nextMap = {};
    Object.keys(currentMap).forEach(key => {
      if (currentMap[key] !== convId) nextMap[key] = currentMap[key];
    });
    setCurrentMap(nextMap);
  } catch (_) {}
  updateSessionLabel();
  return true;
}

async function ensureMeta(articleKey, title, articleId = '') {
  const idx = readIndex();
  const existing = idx.find(x => x.articleKey === articleKey);
  if (existing) return readingStore.getConversation(existing.id);
  const result = await readingStore.ensureConversation({
    articleId: articleId || (/^(art_|url:|local:)/.test(String(articleKey)) ? articleKey : ''),
    articleKey: articleId ? '' : (articleKey === 'global' ? '' : articleKey),
    title: title || (articleKey === 'global' ? t('assistant.globalSession') : t('assistant.article'))
  });
  return result.ok ? result.conversation : null;
}

async function ensureConversationForContext(ctx, title) {
  const currentId = getCurrentConvId(ctx.articleKey);
  if (currentId) {
    const existing = readingStore.getConversation(currentId);
    if (existing) return existing;
  }
  const existingMeta = readIndex().find(x => x.articleKey === ctx.articleKey);
  if (existingMeta) {
    setCurrentConvId(ctx.articleKey, existingMeta.id);
    return readingStore.getConversation(existingMeta.id);
  }
  const created = await ensureMeta(ctx.articleKey, title || extractArticleTitle() || t('assistant.article'), ctx.articleId);
  if (created) setCurrentConvId(ctx.articleKey, created.id);
  return created;
}

function extractArticleTitle() {
  try {
    const raw = (dom.articleInput && dom.articleInput.value) || '';
    const first = raw.split(/\r?\n/)[0] || '';
    return first.replace(/^#+\s*/, '').trim();
  } catch(_) { return ''; }
}

function isGlobalArticle(){
  try { const raw = (dom.articleInput && dom.articleInput.value) || ''; return !String(raw).trim(); } catch(_) { return true; }
}

async function currentArticleIdentity(text) {
  try {
    const activeId = state.currentArticleId || '';
    let active = activeId ? articleStore.getRecord(activeId) : null;
    if (active?.summaryOnly) active = await articleStore.ensureArticleLoaded(activeId);
    if (active && String(active.article || '') === String(text || '')) return active.articleId;
    // 清單只有摘要，其他文章不為了比對而全部載入；只有目前這篇需要全文。
  } catch (_) {}
  return '';
}

async function buildContext() {
  const raw = (dom.articleInput && dom.articleInput.value) || '';
  const text = String(raw);
  if (!text.trim()) {
    return { articleKey: 'global', articleId: '', text: '' };
  }
  const articleId = await currentArticleIdentity(text);
  if (articleId) return { articleKey: articleId, articleId, text };
  const articleKey = await cache.makeKey('assistant-article', text);
  return { articleKey, articleId: '', text };
}

async function restoreConversation(panel, overrideArticleKey) {
  // 回答中保留目前訊息與停止入口：任何「還原會話」都不得清掉進行中的請求 UI（F6）。
  if (activeAsk) return;
  // 優先使用「目前選中的會話」；若沒有，才回退到該文章的第一個會話
  const box = panel.querySelector('#assistant-messages');
  if (!box) return;
  box.innerHTML = '';
  // 舊訊息節點已移除：連同它們的請求快照一起清掉，避免 Map 長期累積。
  lastRequestByEl.clear();
  const ctx0 = await buildContext();
  const ctx = overrideArticleKey ? { ...ctx0, articleKey: overrideArticleKey } : ctx0;
  const idx = readIndex();
  const curId = getCurrentConvId(ctx.articleKey);
  let meta = curId ? idx.find(x => x.id === curId) : null;
  if (!meta) meta = idx.find(x => x.articleKey === ctx.articleKey);
  if (!meta) return;
  const messages = await idbGetConv(meta.id);
  for (const m of messages) appendMessage(box, m.role, m.content, { messageId: m.id, conversationId: meta.id, articleId: meta.articleId, status: m.status || 'complete' });
  hideNewAnswerHint(panel);
  box.scrollTop = box.scrollHeight;
}

function addHint(panel, text) {
  const box = panel.querySelector('#assistant-messages');
  const el = document.createElement('div');
  el.className = 'assistant-msg assistant-hint';
  el.textContent = text;
  box.appendChild(el);
}

const ASSISTANT_INPUT_MAX_HEIGHT = 140;

/** textarea 自動長高（1–5 行；超過上限改為內捲）。 */
function autoGrowInput(input) {
  if (!input) return;
  input.style.height = 'auto';
  const nextHeight = Math.min(input.scrollHeight || 0, ASSISTANT_INPUT_MAX_HEIGHT);
  input.style.height = `${nextHeight}px`;
  input.style.overflowY = (input.scrollHeight || 0) > ASSISTANT_INPUT_MAX_HEIGHT ? 'auto' : 'hidden';
}

/** 距離底部 48px 內視為「正在看最新內容」。 */
function isNearBottom(box, threshold = 48) {
  if (!box) return true;
  return (box.scrollHeight - box.scrollTop - box.clientHeight) <= threshold;
}

function hideNewAnswerHint(panel) {
  try { panel?.querySelector('#assistant-messages .assistant-new-answer')?.remove(); } catch (_) { /* noop */ }
}

function showNewAnswerHint(panel) {
  const box = panel?.querySelector('#assistant-messages');
  if (!box || box.querySelector('.assistant-new-answer')) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'assistant-new-answer';
  button.textContent = t('assistant.newAnswer');
  button.addEventListener('click', () => {
    box.scrollTop = box.scrollHeight;
    hideNewAnswerHint(panel);
  });
  box.appendChild(button);
}

/** 失敗／取消後把本次問題放回空白的輸入框；使用者已打字則不覆蓋。 */
function restoreDraft(panel, text) {
  const input = panel?.querySelector('#assistant-input');
  if (!input) return;
  if (String(input.value || '').trim()) return;
  const draft = String(text || '');
  if (!draft) return;
  input.value = draft;
  autoGrowInput(input);
}

function appendMessage(container, role, text, meta = {}) {
  const el = document.createElement('div');
  el.className = 'assistant-msg ' + (role === 'user' ? 'assistant-user' : 'assistant-assistant');
  if (meta.messageId) {
    el.dataset.messageId = meta.messageId;
    el.dataset.conversationId = meta.conversationId || '';
    el.dataset.articleId = meta.articleId || '';
  }
  if (role === 'assistant') {
    try { el.innerHTML = markdownToHtml(text || ''); try { enhanceMarkdown(el); } catch(_){} }
    catch(_) { el.textContent = text || ''; }
    // 重開會話時也要看得出哪些回答被停止過，不能冒充完整答案。
    if (meta.status === 'cancelled') {
      el.dataset.messageStatus = 'cancelled';
      appendCancelledNote(el);
    } else if (meta.messageId && meta.status !== 'failed') {
      attachKeepDocumentButton(el, meta);
    }
  } else {
    el.textContent = text || '';
  }
  container.appendChild(el);
  return el;
}

/**
 * 助手請求的狀態機（P1-T5）。
 *
 * - 單一會話序列：`activeAsk` 存在時不排隊、不送出第二題，只提示忙碌。
 * - 重試綁定原請求快照（正文、文章 ID、會話、歷史），切換文章後重試也不會換正文。
 * - 停止以 `status: 'cancelled'` 保存半段；錯誤提示在 finally 之後仍然可見。
 */
let activeAsk = null;
// placeholder -> 該輪請求快照；重試按鈕從這裡取回原始請求。
const lastRequestByEl = new Map();

function isAbortError(error, controller) {
    return !!controller?.signal?.aborted || error?.name === 'AbortError';
}

function appendNote(el, className, text) {
    if (!el) return null;
    el.querySelector(`.${className}`)?.remove();
    const note = document.createElement('div');
    note.className = className;
    note.textContent = text;
    el.appendChild(note);
    return note;
}

function appendCancelledNote(el) {
    return appendNote(el, 'assistant-cancelled', t('assistant.streamCancelled'));
}

function articleContentVersion(text) {
    try { return contentVersionOf(text); } catch (_) { return ''; }
}

async function saveAssistantMessage({ conversationId, content, status, articleId, learningItemId, anchor, contentVersion }) {
    try {
        return await readingStore.appendMessage({
            conversationId,
            role: 'assistant',
            content,
            status,
            articleId,
            learningItemId,
            anchor,
            contentVersion
        });
    } catch (_) {
        return { ok: false };
    }
}

async function ask(panel, userText, opts = {}) {
    // 忙碌權必須在第一個 await 之前同步取得（P1-3）：建立會話、讀歷史都是 await，
    // 若等到串流開始才設 activeAsk，初始化期間的第二次送出會變成並行第二題。
    if (activeAsk) {
        addHint(panel, t('assistant.busy'));
        try { panel.querySelector('#assistant-input')?.focus(); } catch (_) {}
        return false;
    }
    const token = { controller: null, conversationId: '', placeholder: null, requestSnapshot: null };
    // locale 切換要等這輪把 cancelled 半段存完再重畫會話；settle 只代表「這輪結束」。
    token.settled = new Promise((resolve) => { token.settle = resolve; });
    activeAsk = token;
    try {
        return await askOwned(token, panel, userText, opts);
    } finally {
        // 只有持有者能解除；舊請求不得清掉新請求的忙碌狀態。
        if (activeAsk === token) activeAsk = null;
        try { token.settle(); } catch (_) { /* noop */ }
    }
}

async function askOwned(activeAskToken, panel, userText, opts = {}) {
    const st = loadGlobalSettings();
    const streamPref = st?.assistant?.stream !== false;
    const box = panel.querySelector('#assistant-messages');
    // 送出前先記住使用者是否正在看底部；不在底部就不搶走他的閱讀位置。
    const shouldFollow = isNearBottom(box, 48);
    const isRetry = opts && opts.mode === 'retry';
    const snapshot = opts.requestSnapshot || null;
    // 重試一律用快照：不重讀輸入框、不重算目前文章。
    const ctx = snapshot
        ? { articleKey: snapshot.articleKey, articleId: snapshot.articleId, text: snapshot.articleText }
        : await buildContext();
    const articleKey = snapshot ? snapshot.articleKey : (opts.articleKey || ctx.articleKey);
    const requestedArticleId = snapshot
        ? snapshot.articleId
        : (ctx.articleId || opts.articleId || '');
    const articleText = snapshot ? snapshot.articleText : ctx.text;
    const title = snapshot ? snapshot.title : extractArticleTitle();
    const learningItemId = snapshot ? snapshot.learningItemId : (opts.learningItemId || '');
    const messageAnchor = snapshot ? snapshot.anchor : (opts.anchor || null);
    const messageContentVersion = snapshot
        ? snapshot.contentVersion
        : (opts.contentVersion || (articleText && articleText.trim() ? articleContentVersion(articleText) : ''));

    // 會話 ID 在本輪開始時固定；重試一定沿用原會話，不因目前文章改變而跳槽。
    const pinnedId = snapshot ? snapshot.convId : opts.convId;
    const pinned = pinnedId ? readingStore.getConversation(pinnedId) : null;
    const conversation = pinned || await ensureConversationForContext({ ...ctx, articleKey, articleId: requestedArticleId }, title);
    const articleId = requestedArticleId || conversation?.articleId || '';
    if (!conversation) {
        appendMessage(box, 'assistant', t('assistant.error', { message: t('assistant.tryLater') }));
        restoreDraft(panel, userText);
        return false;
    }
    const conversationId = conversation.id;
    setCurrentConvId(articleKey, conversationId);

    const system = {
        role: 'system',
        content: buildPrompt('assistant.articleTutor', {}, { locale: getLocale() })
    };
    const context = articleText && articleText.trim() ? { role: 'user', content: `${t('assistant.contextPrefix')}\n\n"""\n${articleText}\n"""` } : null;
    // 歷史在送出前固定（重試不重讀會話、也不把同一題再放一次）。
    const history = snapshot
        ? snapshot.historyMessages
        : (await readingStore.getMessages(conversationId)).slice(-8).map((m) => ({ role: m.role, content: m.content }));
    const messages = [system, ...(context ? [context] : []), ...history, { role: 'user', content: userText }];
    // P3-T5：只記長度（context／messages 字元數），不記內容；probe 關閉時 no-op。
    perfProbe.recordAssistantTurn({
        contextChars: context ? String(context.content || '').length : 0,
        messageChars: messages.reduce((sum, message) => sum + String(message?.content || '').length, 0),
        messageCount: messages.length
    });

    if (!isRetry) appendMessage(box, 'user', userText);
    const placeholder = (isRetry && opts.reuseEl) ? opts.reuseEl : appendMessage(box, 'assistant', '');
    if (isRetry) { try { placeholder.innerHTML = ''; } catch (_) {} }
    if (shouldFollow) {
        box.scrollTop = box.scrollHeight;
        hideNewAnswerHint(panel);
    }

    if (!isRetry) {
        await readingStore.appendMessage({
            conversationId,
            role: 'user',
            content: userText,
            articleId,
            learningItemId,
            anchor: messageAnchor,
            contentVersion: messageContentVersion
        });
    }

    const requestSnapshot = snapshot || {
        userText,
        articleId,
        articleKey,
        articleText,
        contentVersion: messageContentVersion,
        title,
        historyMessages: history,
        learningItemId,
        anchor: messageAnchor,
        convId: conversationId
    };
    lastRequestByEl.set(placeholder, requestSnapshot);

    const ac = new AbortController();
    Object.assign(activeAskToken, { controller: ac, conversationId, placeholder, requestSnapshot });
    const stopBtn = document.createElement('button');
    stopBtn.className = 'assistant-stop';
    stopBtn.textContent = t('assistant.stop');
    stopBtn.addEventListener('click', () => ac.abort());
    placeholder.parentElement.appendChild(stopBtn);

    let buffer = '';
    let hadError = false;
    let cancelled = false;
    let errorMessage = '';
    try {
        try { placeholder.querySelector('.assistant-retry')?.remove(); } catch (_) {}
        try { placeholder.querySelector('.assistant-error')?.remove(); } catch (_) {}
        try { placeholder.querySelector('.assistant-cancelled')?.remove(); } catch (_) {}
        if (streamPref) {
            await streamCompletions(messages, ac.signal, (delta) => {
                buffer += delta;
                const follow = isNearBottom(box, 48);
                placeholder.textContent = buffer;
                if (follow) {
                    box.scrollTop = box.scrollHeight;
                    hideNewAnswerHint(panel);
                } else {
                    showNewAnswerHint(panel);
                }
            });
        } else {
            buffer = await onceCompletions(messages, ac.signal);
            const follow = isNearBottom(box, 48);
            try { placeholder.innerHTML = markdownToHtml(buffer || ''); try { enhanceMarkdown(placeholder); } catch (_) {} }
            catch (_) { placeholder.textContent = buffer; }
            if (follow) box.scrollTop = box.scrollHeight;
        }
    } catch (error) {
        if (isAbortError(error, ac)) {
            cancelled = true;
        } else {
            hadError = true;
            errorMessage = error?.message || t('assistant.tryLater');
        }
    } finally {
        stopBtn.remove();
        // 重新套用 markdown 會改變高度；先記錄使用者當時是否在看底部，避免把他拉回。
        const followBeforeRender = isNearBottom(box, 48);
        if (streamPref) {
            try { placeholder.innerHTML = markdownToHtml(buffer || ''); try { enhanceMarkdown(placeholder); } catch (_) {} }
            catch (_) { /* 保留純文字 */ }
        }
        if (cancelled) {
            // 停止：保留半段、明示不完整、以 cancelled 保存；絕不標成 complete。
            appendCancelledNote(placeholder);
            if (buffer.trim()) {
                const saved = await saveAssistantMessage({
                    conversationId,
                    content: buffer,
                    status: 'cancelled',
                    articleId,
                    learningItemId,
                    anchor: messageAnchor,
                    contentVersion: messageContentVersion
                });
                if (saved?.ok && saved.message) {
                    placeholder.dataset.messageId = saved.message.id;
                    placeholder.dataset.conversationId = conversationId;
                    placeholder.dataset.articleId = articleId || conversation.articleId || '';
                    placeholder.dataset.messageStatus = 'cancelled';
                } else if (saved && saved.ok === false) {
                    appendNote(placeholder, 'assistant-save-error', t('assistant.saveFailed'));
                }
            }
        } else if (!hadError) {
            // 每條完整回答逐條永久保存；保存失敗仍保留畫面內容並提示。
            const saved = await saveAssistantMessage({
                conversationId,
                content: buffer,
                status: 'complete',
                articleId,
                learningItemId,
                anchor: messageAnchor,
                contentVersion: messageContentVersion
            });
            if (saved?.ok && saved.message) {
                placeholder.dataset.messageId = saved.message.id;
                placeholder.dataset.conversationId = conversationId;
                placeholder.dataset.articleId = articleId || conversation.articleId || '';
                placeholder.dataset.messageStatus = 'complete';
                attachKeepDocumentButton(placeholder, {
                    messageId: saved.message.id,
                    conversationId,
                    articleId: articleId || conversation.articleId || '',
                    learningItemId: saved.message.learningItemId || learningItemId
                });
            } else {
                appendNote(placeholder, 'assistant-save-error', t('assistant.saveFailed'));
            }
        } else {
            // 錯誤提示在 buffer 重畫「之後」才掛上去，才不會被 markdown 重繪蓋掉。
            appendNote(placeholder, 'assistant-error', t('assistant.error', { message: errorMessage }));
            const retry = document.createElement('button');
            retry.className = 'assistant-retry';
            retry.textContent = t('assistant.retryOriginal');
            retry.addEventListener('click', async () => {
                retry.disabled = true;
                const snap = lastRequestByEl.get(placeholder) || requestSnapshot;
                const started = await ask(panel, snap.userText, {
                    mode: 'retry',
                    reuseEl: placeholder,
                    requestSnapshot: snap,
                    convId: snap.convId,
                    articleId: snap.articleId
                });
                // 另一個回答正在進行：維持原問題與按鈕可用，不排隊。
                if (!started) retry.disabled = false;
            });
            placeholder.appendChild(document.createElement('br'));
            placeholder.appendChild(retry);
        }
        if ((cancelled || hadError)) restoreDraft(panel, userText);
        if (followBeforeRender) {
            box.scrollTop = box.scrollHeight;
            hideNewAnswerHint(panel);
        } else if (String(buffer || '').trim()) {
            showNewAnswerHint(panel);
        }
        // 忙碌狀態由 ask() 的 finally 依 token 解除，這裡不直接清全域鎖。
        updateContextChip(panel);
        updateHeaderTitle();
    }
    return true;
}

function attachKeepDocumentButton(el, { messageId, conversationId, articleId, learningItemId = '' }) {
  if (!el || !messageId || el.querySelector('.assistant-keep-doc')) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'assistant-keep-doc';
  button.textContent = t('assistant.keepAsDocument');
  button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = t('assistant.savingDocument');
    try {
      const messages = await readingStore.getMessages(conversationId);
      const message = messages.find((item) => item.id === messageId);
      const content = message?.content || el.innerText || '';
      const targetArticleId = articleId || readingStore.getConversation(conversationId)?.articleId || '';
      const result = await readingActions.saveAiAnswerAsDocument({
        articleId: targetArticleId,
        conversationId,
        messageId,
        content,
        learningItemId: message?.learningItemId || learningItemId
      });
      if (!result.ok) throw new Error(result.error);
      button.textContent = t('assistant.documentSaved');
      button.classList.add('is-saved');
      document.dispatchEvent(new CustomEvent('bdc:reading-change', { detail: { articleId: targetArticleId } }));
    } catch (_) {
      button.disabled = false;
      button.textContent = t('assistant.documentSaveFailed');
    }
  });
  el.appendChild(button);
}

async function appendMessageToConv(articleKey, title, message) {
  const ctx = await buildContext();
  const conversation = await ensureConversationForContext({ ...ctx, articleKey }, title);
  if (!conversation) return null;
  const result = await readingStore.appendMessage({
    conversationId: conversation.id,
    role: message?.role,
    content: message?.content,
    articleId: ctx.articleId
  });
  return result.ok ? result.message : null;
}

// 美化 markdown：為程式碼區塊加上「複製」按鈕，改善可讀性與操作手感。
function enhanceMarkdown(root){
  try {
    const pres = root.querySelectorAll('pre');
    pres.forEach(pre => {
      if (pre.querySelector('.assistant-copy')) return;
      const code = pre.querySelector('code');
      const btn = document.createElement('button');
      btn.className = 'assistant-copy';
      btn.textContent = t('assistant.copy');
      btn.addEventListener('click', async () => {
        try {
          const txt = code ? code.innerText : pre.innerText;
          await navigator.clipboard.writeText(txt);
          btn.textContent = t('assistant.copied');
          setTimeout(()=> btn.textContent = t('assistant.copy'), 1200);
        } catch(_) {}
      });
      pre.appendChild(btn);
    });
  } catch(_) {}
}

// 向後相容：若發現舊格式（assistantConversations），搬遷到新索引 + IDB
function migrateLegacyStore() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    const convs = Array.isArray(obj.conversations) ? obj.conversations : [];
    const idx = readIndex();
    const exist = new Set(idx.map(x => x.id));
    for (const c of convs) {
      const id = c.id || `c_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
      if (!exist.has(id)) idx.unshift({ id, articleKey: c.articleKey, title: c.title || t('assistant.article'), updatedAt: c.updatedAt || new Date().toISOString() });
      try { if (Array.isArray(c.messages)) cache.setItem('assistant:conv:'+id, { messages: c.messages }); } catch(_) {}
    }
    writeIndex(idx);
    localStorage.removeItem(LS_KEY);
  } catch(_) {}
}

async function onceCompletions(messages, signal, modelOverride) {
  const model = getAssistantModelSpec(modelOverride);
  if (!model) throw new Error(t('settings.aiModelNotSelected'));
  perfProbe.markAssistantRequest();
  const data = await requestAI({
    model,
    messages,
    temperature: 0.2,
    signal,
    taskType: 'assistant'
  });
  return String(data?.text || data?.choices?.[0]?.message?.content || '').trim();
}

async function streamCompletions(messages, signal, onDelta, modelOverride) {
  const model = getAssistantModelSpec(modelOverride);
  if (!model) throw new Error(t('settings.aiModelNotSelected'));
  perfProbe.markAssistantRequest();
  // The shared adapter layer handles SSE framing, finish reasons and errors for
  // every supported protocol (Chat Completions / Anthropic / Gemini).
  await streamAIResponse({
    model,
    messages,
    temperature: 0.2,
    signal,
    taskType: 'assistant',
    onDelta
  });
}

// ---------- 尺寸控制（桌面端） ----------
function getSavedPanelSize() { try { return localStorage.getItem('assistantPanelSize') || 'm'; } catch(_) { return 'm'; } }
function savePanelSize(sz) { try { localStorage.setItem('assistantPanelSize', sz); } catch(_) {} }
function setPanelSize(panel, sz) {
  const sizes = ['s','m','l','xl'];
  if (!sizes.includes(sz)) sz = 'm';
  panel.classList.remove('assistant-size-s','assistant-size-m','assistant-size-l','assistant-size-xl');
  panel.classList.add('assistant-size-'+sz);
  savePanelSize(sz);
  // 高亮按鈕
  panel.querySelectorAll('.assistant-size-btn').forEach(b => b.classList.toggle('active', b.getAttribute('data-size') === sz));
}
function cyclePanelSize(panel) {
  const order = ['s','m','l','xl'];
  const cur = getSavedPanelSize();
  const next = order[(order.indexOf(cur)+1)%order.length];
  setPanelSize(panel, next);
}

// 字級：s / m / l
function getSavedFontSize(){
  try {
    const v = localStorage.getItem('assistantFontSize') || 'l';
    return (v==='s'||v==='l') ? v : 'l'; // 兼容舊值（m -> l）
  } catch(_) { return 'l'; }
}
function saveFontSize(sz){ try { localStorage.setItem('assistantFontSize', sz); } catch(_){} }
function setFontSize(panel, sz){
  const opts = ['s','l'];
  if (!opts.includes(sz)) sz = 'l';
  panel.classList.remove('assistant-font-s','assistant-font-m','assistant-font-l');
  panel.classList.add('assistant-font-' + sz);
  saveFontSize(sz);
  // 高亮按鈕
  panel.querySelectorAll('.assistant-font-btn').forEach(b => b.classList.toggle('active', b.getAttribute('data-size') === sz));
}

// 模式: floating | dock；寬度百分比與全高
function getSavedPanelMode(){
  const ak = getCurrentArticleKeySync();
  try { const map = JSON.parse(localStorage.getItem('assistantModeMap')||'{}'); return map[ak] || 'floating'; } catch(_) { return 'floating'; }
}
function savePanelMode(m){
  const ak = getCurrentArticleKeySync();
  try { const map = JSON.parse(localStorage.getItem('assistantModeMap')||'{}'); map[ak]=m; localStorage.setItem('assistantModeMap', JSON.stringify(map)); } catch(_){}
}
function getSavedDockWidth(){ const ak=getCurrentArticleKeySync(); try { const map=JSON.parse(localStorage.getItem('assistantDockWidthMap')||'{}'); return parseInt(map[ak]||'40',10)||40; } catch(_) { return 40; } }
function saveDockWidth(p){ const ak=getCurrentArticleKeySync(); try { const map=JSON.parse(localStorage.getItem('assistantDockWidthMap')||'{}'); map[ak]=String(p); localStorage.setItem('assistantDockWidthMap', JSON.stringify(map)); } catch(_){} }
function getSavedFull(){ try { return localStorage.getItem('assistantPanelFull')==='1'; } catch(_) { return false; } }
function saveFull(v){ try { localStorage.setItem('assistantPanelFull', v?'1':'0'); } catch(_){} }

function setPanelMode(panel, mode){
  if (!['floating','dock','modal'].includes(mode)) mode = 'floating';
  panel.classList.toggle('assistant-dock', mode==='dock');
  panel.classList.toggle('assistant-floating', mode!=='dock');
  panel.classList.toggle('assistant-modal', mode==='modal');
  savePanelMode(mode);
  // 切換控件顯示
  // 背景遮罩（僅在面板可見的 modal 模式）
  updateBackdrop();
  // 浮動模式時清除 dock 尺寸，避免殘留造成 1px 線
  if (mode !== 'dock') panel.style.width = '';
}
function togglePanelMode(panel){ const cur = getSavedPanelMode(); const next = (cur==='dock'?'floating':'dock'); setPanelMode(panel,next); if (next==='dock') setDockWidth(panel,getSavedDockWidth()); }

function setDockWidth(panel, pct){
  pct = Math.min(70, Math.max(30, pct||40));
  saveDockWidth(pct);
  // 以分析容器寬度為基準，找不到則用 viewport
  const baseEl = document.querySelector('.analysis-container') || document.querySelector('#article-analysis-container') || document.body;
  let baseWidth = window.innerWidth;
  try { const r = baseEl.getBoundingClientRect && baseEl.getBoundingClientRect(); if (r && r.width) baseWidth = r.width; } catch(_) {}
  // 保障：最小面板寬度 360px，避免只剩下 1px 邊框
  const width = Math.max(360, Math.round(baseWidth * pct / 100));
  if (getSavedPanelMode()==='dock') {
    panel.style.width = width + 'px';
    // 高亮百分比按鈕
    panel.querySelectorAll('.assistant-percent-btn').forEach(b => b.classList.toggle('active', parseInt(b.getAttribute('data-pct'),10)===pct));
  }
}

function togglePanelFull(panel){ const v = !getSavedFull(); panel.classList.toggle('assistant-full', v); saveFull(v); }

// 遮罩只在「面板可見 + modal 模式」時存在，避免隱藏後仍壓暗整個畫面
function updateBackdrop(){
  const panel = document.getElementById('assistant-panel');
  const visible = !!panel && !panel.classList.contains('assistant-hidden');
  const modal = !!panel && panel.classList.contains('assistant-modal');
  toggleBackdrop(visible && modal);
}

function toggleBackdrop(show){
  let bd = document.getElementById('assistant-backdrop');
  if (show){
    if (!bd){ bd = document.createElement('div'); bd.id = 'assistant-backdrop'; bd.className='assistant-backdrop'; bd.addEventListener('click', ()=> setPanelMode(document.getElementById('assistant-panel'),'floating')); document.body.appendChild(bd);} 
  } else { if (bd) bd.remove(); }
}

// 會話：索引輔助（每文章可有多會話）
function getCurrentMap(){ try { return JSON.parse(localStorage.getItem('assistantCurrentMap')||'{}'); } catch(_) { return {}; } }
function setCurrentMap(m){ try { localStorage.setItem('assistantCurrentMap', JSON.stringify(m)); } catch(_){} }
function getCurrentConvId(articleKey){ const m=getCurrentMap(); return m[articleKey]||''; }
function setCurrentConvId(articleKey,id){ const m=getCurrentMap(); m[articleKey]=id; setCurrentMap(m); updateSessionLabel(); }

async function newConversation(panel){
  // 回答中禁止建立／切換會話：保留目前會話、訊息與停止按鈕（F6）。
  if (activeAsk) { addHint(panel, t('assistant.sessionBusy')); return; }
  const ctx = await buildContext();
  const meta = await createAssistantConversation({
    articleKey: ctx.articleKey,
    articleId: ctx.articleId,
    title: extractArticleTitle(),
    messages: []
  });
  if (!meta) return;
  pendingReference = null;
  setCurrentConvId(ctx.articleKey, meta.id);
  const box = panel.querySelector('#assistant-messages');
  if (box) box.innerHTML='';
  hideNewAnswerHint(panel);
  lastRequestByEl.clear();
}

function ensureMetaWithId(articleKey, title, id){
  const idx = readIndex();
  const exist = idx.find(x => x.id === id);
  if (exist) return exist;
  const defaultTitle = articleKey === 'global' ? t('assistant.globalSession') : t('assistant.newSession');
  const m = { id, articleKey, title: title||defaultTitle, updatedAt: new Date().toISOString() };
  idx.unshift(m); writeIndex(idx); return m;
}

async function toggleHistory(panel){
  const ctx = await buildContext();
  const idx = readIndex().filter(x => x.articleKey===ctx.articleKey);
  let pop = document.getElementById('assistant-history-panel');
  if (pop) { pop.remove(); return; }
  pop = document.createElement('div');
  pop.id='assistant-history-panel';
  // 帶標題與關閉鈕的頭部
  pop.innerHTML = `<div class="ah-head"><div class="ah-titlebar">${t('assistant.history')}</div><button class="ah-close" title="${t('assistant.close')}" aria-label="${t('assistant.close')}">×</button></div>` + (idx.length ? idx.map(m=>`<div class="ah-item" data-id="${m.id}">
    <div class="ah-meta">
      <div class="ah-title">${escapeHtml(m.title || t('assistant.session'))}</div>
      <div class="ah-time">${formatDateTime(m.updatedAt || Date.now())}</div>
    </div>
    <button class="assistant-icon" data-act="open" title="${t('assistant.switch')}">${svgOpen()}</button>
    <button class="assistant-icon" data-act="rename" title="${t('assistant.rename')}">${svgEdit()}</button>
    <button class="assistant-icon" data-act="delete" title="${t('assistant.delete')}">${svgTrash()}</button>
  </div>`).join('') : `<div class="assistant-history-empty">${t('assistant.noSessions')}</div>`);
  panel.appendChild(pop);
  // 外部點擊與 Esc 關閉（選項 1+3）
  const histBtn = panel.querySelector('#assistant-history');
  const closeHistory = () => {
    try { document.removeEventListener('keydown', onKeydown, true); } catch(_){}
    try { document.removeEventListener('mousedown', onDocDown, true); } catch(_){}
    try { pop.remove(); } catch(_){}
  };
  const onKeydown = (e) => { if (e.key === 'Escape') closeHistory(); };
  const onDocDown = (e) => {
    const t = e.target;
    if (!pop.contains(t) && !(histBtn && histBtn.contains(t))) closeHistory();
  };
  document.addEventListener('keydown', onKeydown, true);
  document.addEventListener('mousedown', onDocDown, true);

  pop.addEventListener('click', async (ev) => {
    if (ev.target.closest('.ah-close')) { ev.stopPropagation(); closeHistory(); return; }
    const item = ev.target.closest('.ah-item');
    if (!item) return;
    const id = item.getAttribute('data-id');
    const actBtn = ev.target.closest('button[data-act]');
    const act = actBtn ? actBtn.getAttribute('data-act') : 'open';
    // 回答中禁止切換或刪除會話；保留目前會話與停止入口，只提示忙碌。
    if (activeAsk && (act === 'open' || act === 'delete')) {
      ev.stopPropagation();
      addHint(panel, t('assistant.sessionBusy'));
      return;
    }
    if (act === 'rename') {
      ev.stopPropagation();
      const titleEl = item.querySelector('.ah-title');
      const newTitle = prompt(t('assistant.renamePrompt'), titleEl?.textContent || '');
      if (newTitle && newTitle.trim()) {
        const updated = await renameAssistantConversation(id, newTitle.trim());
        if (updated) {
          titleEl.textContent = updated.title;
          updateSessionLabel();
        }
      }
      return;
    }
    if (act === 'delete') {
      ev.stopPropagation();
      const confirmed = await confirmAction({
        title: t('assistant.delete'),
        message: t('assistant.confirmDelete'),
        confirmLabel: t('assistant.delete'),
        cancelLabel: t('common.cancel'),
        danger: true
      });
      if (!confirmed) return;
      const deleted = await deleteAssistantConversation(id);
      if (!deleted) return;
      item.remove();
      if (getCurrentConvId(ctx.articleKey) === id) {
        setCurrentConvId(ctx.articleKey, '');
        const box = panel.querySelector('#assistant-messages');
        if (box) box.innerHTML = '';
        updateSessionLabel();
      }
      return;
    }
    // open 切換
    pendingReference = null;
    setCurrentConvId(ctx.articleKey, id);
    const box = panel.querySelector('#assistant-messages');
    if (box) { box.innerHTML=''; const msgs = await idbGetConv(id); const meta = idx.find(x => x.id === id) || null; msgs.forEach(m=>appendMessage(box,m.role,m.content,{ messageId: m.id, conversationId: id, articleId: meta?.articleId || '', status: m.status || 'complete' })); hideNewAnswerHint(panel); box.scrollTop=box.scrollHeight; }
    updateSessionLabel(); closeHistory();
  });
}

function updateSessionLabel(){
  // 使用與實際儲存一致的 articleKey（buildContext）避免標籤與實際會話不同步
  (async () => {
    try {
      const el = document.getElementById('assistant-session-label');
      if (!el) return;
      const ctx = await buildContext();
      const id = getCurrentConvId(ctx.articleKey);
      if (!id){ el.textContent=''; return; }
      const m = readIndex().find(x => x.id===id);
      const sessionTitle = (m && m.title) ? String(m.title).trim() : '';
      // 若與文章標題相同或是通用名稱，則不顯示，避免重覆
      const articleTitle = extractArticleTitle();
      const norm = (s) => String(s||'').trim().toLowerCase();
      const isGeneric = /^(會話|新會話|文章|article|conversation)$/i.test(sessionTitle);
      if (!sessionTitle || norm(sessionTitle)===norm(articleTitle) || isGeneric) {
        el.textContent = '';
      } else {
        el.textContent = `· ${sessionTitle}`;
      }
    } catch(_){}
  })();
}

// 以文章文字作為同步鍵（避免 async 雜湊在 UI 中不好用）；
// 足以區分不同文章，且對話切換時可做 per-article 記憶。
function getCurrentArticleKeySync(){
  try { const raw = (dom.articleInput && dom.articleInput.value) || ''; return String(raw).slice(0, 64) || 'global'; } catch(_) { return 'global'; }
}

// 對外 API（供齒輪→AI 會話視窗調用）
function exposeGlobalAPI(){
  try {
    if (window.__assistant && window.__assistant.__ready) return;
    const api = {
      __ready: true,
      open: (mode) => {
        const panel = document.getElementById('assistant-panel');
        if (!panel) return; panel.classList.remove('assistant-hidden'); if (mode) setPanelMode(panel, mode);
      },
      switch: async (articleKey, convId) => {
        if (activeAsk) return false;
        const panel = document.getElementById('assistant-panel'); if (!panel) return;
        // 僅切換上下文/會話，不主動開啟面板（避免「預設彈窗」）
        pendingReference = null;
        if (articleKey && convId) { setCurrentConvId(articleKey, convId); }
        // 若面板已打開，才更新畫面；否則僅更新狀態，待下次開啟再載入
        if (!panel.classList.contains('assistant-hidden')) {
          updateHeaderTitle();
          updateContextChip(panel);
          restoreConversation(panel, articleKey).catch(() => {});
          updateSessionLabel();
        }
      },
      // 文章學習記錄／短語面板的「問 AI」：只把引用預填進輸入框並聚焦，
      // 不代使用者送出；返回 false 代表助手不可用（面板尚未掛載）。
      compose: ({ text, articleKey, convId, context = {} } = {}) => {
        const panel = document.getElementById('assistant-panel');
        if (!panel) return false;
        const wasHidden = panel.classList.contains('assistant-hidden');
        const mode = getSavedPanelMode();
        panel.classList.remove('assistant-hidden');
        setPanelMode(panel, mode);
        if (mode === 'dock') setDockWidth(panel, getSavedDockWidth());
        updateBackdrop();
        updateHeaderTitle();
        updateContextChip(panel);
        if (wasHidden) {
          restoreConversation(panel, articleKey || undefined).catch(() => {});
          updateSessionLabel();
        }
        pendingReference = {
          articleKey: articleKey || '',
          convId: convId || '',
          text: String(text || '').trim(),
          context: {
            learningItemId: context.learningItemId || '',
            anchor: context.anchor || null,
            contentVersion: context.contentVersion || '',
            articleId: context.articleId || ''
          }
        };
        const input = panel.querySelector('#assistant-input');
        if (input) {
          const reference = String(text || '').trim();
          const current = String(input.value || '');
          // 已在輸入框的同一引用不重複堆疊；其他情況接在使用者已輸入的內容後面。
          if (reference && !current.includes(reference)) {
            input.value = current.trim() ? `${current.trimEnd()} ${reference}` : reference;
          }
          input.focus({ preventScroll: true });
          autoGrowInput(input);
          try { const end = input.value.length; input.setSelectionRange(end, end); } catch (_) {}
        }
        return true;
      },
      send: async (text, articleKey, convId, context = {}) => {
        const panel = document.getElementById('assistant-panel'); if (!panel) return;
        pendingReference = null;
        if (articleKey && convId) { setCurrentConvId(articleKey, convId); }
        panel.classList.remove('assistant-hidden');
        if (text && text.trim()) {
          await ask(panel, text.trim(), {
            articleKey,
            convId,
            learningItemId: context.learningItemId || '',
            anchor: context.anchor || null,
            contentVersion: context.contentVersion || '',
            articleId: context.articleId || ''
          });
        }
      },
      create: async (articleKey, title) => {
        if (activeAsk) return '';
        const meta = await createAssistantConversation({
          articleKey: articleKey || 'global',
          title: title || t('assistant.newSession'),
          messages: []
        });
        return meta.id;
      },
      list: () => listAssistantConversationMetas(),
      getMessages: async (convId) => await getAssistantConversationMessages(convId),
      rename: (convId, title) => renameAssistantConversation(convId, title),
      remove: async (convId) => await deleteAssistantConversation(convId)
    };
    window.__assistant = api;
  } catch(_) {}
}

function escapeHtml(s){return String(s||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}

function svgClose(){return '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/></svg>'}
function svgRefresh(){return '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M8 3a5 5 0 1 0 3.905 8.12.5.5 0 1 1 .79.612A6 6 0 1 1 8 2v1z"/><path d="M8 0a.5.5 0 0 1 .5.5v3.793l1.146-1.147a.5.5 0 1 1 .708.708L8.354 5.71a.5.5 0 0 1-.708 0L5.646 3.854a.5.5 0 1 1 .708-.708L7.5 4.293V.5A.5.5 0 0 1 8 0z"/></svg>'}
// 「靠右全高 / 側欄模式」：以外框 + 右側實心欄位呈現，較直觀
function svgPin(){
  return '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">'
       + '<rect x="1" y="2" width="14" height="12" rx="2" fill="none" stroke="currentColor"/>'
       + '<rect x="10" y="2" width="5" height="12" rx="2"/>'
       + '</svg>';
}
function svgFull(){return '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M1 1h5v1H2v4H1V1zm8 0h6v6h-1V2H9V1zM1 9h1v5h5v1H1V9zm13 0h1v7H9v-1h5V9z"/></svg>'}
function svgSmall(){return '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><rect x="9" y="9" width="6" height="6" rx="2"/><rect x="1" y="1" width="10" height="10" rx="2" fill="none" stroke="currentColor"/></svg>'}
function svgMax(){return '<svg viewBox="0 0 16 16" width="14" height="14"><rect x="1.6" y="1.6" width="12.8" height="12.8" rx="3" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>'}
function svgPlus(){return '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M8 1a.5.5 0 0 1 .5.5v6h6a.5.5 0 0 1 0 1h-6v6a.5.5 0 0 1-1 0v-6h-6a.5.5 0 0 1 0-1h6v-6A.5.5 0 0 1 8 1z"/></svg>'}
function svgList(){return '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M2 2.5a.5.5 0 0 0 0 1h12a.5.5 0 0 0 0-1H2zm0 5a.5.5 0 0 0 0 1h12a.5.5 0 0 0 0-1H2zm0 5a.5.5 0 0 0 0 1h12a.5.5 0 0 0 0-1H2z"/></svg>'}
function svgOpen(){return '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M4 4h6v1H5v6H4V4zm3 3h5v5H7V7z"/></svg>'}
function svgEdit(){return '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M12.146.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1 0 .708l-9.5 9.5L4 14l.646-2.354 9.5-9.5z"/></svg>'}
function svgTrash(){return '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M6.5 1h3a.5.5 0 0 1 .5.5V3h3a.5.5 0 0 1 0 1H3a.5.5 0 0 1 0-1h3V1.5a.5.5 0 0 1 .5-.5z"/><path d="M5.5 5a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-1 0v-7a.5.5 0 0 1 .5-.5zm5 0a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-1 0v-7a.5.5 0 0 1 .5-.5z"/><path d="M4.118 4.5 4 14a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2l-.118-9.5H4.118z"/></svg>'}
