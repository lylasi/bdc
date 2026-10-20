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

const LS_KEY = 'assistantConversations'; // legacy（含所有訊息）
const LS_UPDATED_AT = 'assistantUpdatedAt';
const IDX_KEY = 'assistantConvIndex'; // 新索引：[{id, articleKey, title, updatedAt}]

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
  document.addEventListener('bdc:locale-change', () => {
    document.getElementById('assistant-history-panel')?.remove();
    document.getElementById('assistant-panel')?.remove();
    document.getElementById('assistant-fab')?.remove();
    mountUi();
    setupVisibilityLogic();
  });
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
      restoreConversation(panel);
      const input = panel.querySelector('#assistant-input');
      if (input) input.focus();
    }
  });

  wirePanel(panel);
}

function setupVisibilityLogic() {
  const fab = document.getElementById('assistant-fab');
  const panel = document.getElementById('assistant-panel');
  const update = () => {
    const enabled = (loadGlobalSettings()?.assistant?.enabled !== false);
    const onArticle = !!(dom.articleSection && dom.articleSection.classList.contains('active'));
    fab.style.display = enabled && onArticle ? 'inline-flex' : 'none';
    if (!onArticle) { panel.classList.add('assistant-hidden'); updateBackdrop(); }
  };
  update();
  setTimeout(update, 300);
  window.addEventListener('hashchange', update);
  try {
    const mo = new MutationObserver(update);
    if (dom.articleSection) mo.observe(dom.articleSection, { attributes: true, attributeFilter: ['class'] });
  } catch(_) {}
  try { (dom.navBtns||[]).forEach(btn => btn.addEventListener('click', update)); } catch(_) {}
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
        <button class="assistant-icon" id="assistant-refresh" title="${t('assistant.refreshContext')}">${svgRefresh()}</button>
        <button class="assistant-icon" id="assistant-close" title="${t('assistant.close')}">${svgClose()}</button>
      </div>
    </div>
    <div id="assistant-messages" class="assistant-messages" aria-live="polite"></div>
    <div class="assistant-foot">
      <div class="assistant-row">
        <input id="assistant-input" type="text" class="assistant-input" placeholder="${t('assistant.inputPlaceholder')}">
        <button id="assistant-send" class="assistant-send">${t('assistant.send')}</button>
      </div>
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
  $('#assistant-refresh').addEventListener('click', () => addHint(panel, t('assistant.contextRefreshed')));
  // 模式切換（精簡版）：小視窗/靠右全高/居中彈窗
  $('#assistant-small').addEventListener('click', () => setPanelMode(panel,'floating'));
  $('#assistant-dock').addEventListener('click', () => setPanelMode(panel,'dock'));
  $('#assistant-modal').addEventListener('click', () => setPanelMode(panel,'modal'));
  // 初始化模式與尺寸
  setPanelMode(panel, getSavedPanelMode());
  if (getSavedPanelMode()==='dock') setDockWidth(panel, getSavedDockWidth());
  window.addEventListener('resize', () => { if (getSavedPanelMode()==='dock') setDockWidth(panel, getSavedDockWidth()); });

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
  const doSend = () => {
    const q = (input.value || '').trim();
    if (!q) return;
    input.value = '';
    ask(panel, q);
  };
  send.addEventListener('click', doSend);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSend(); });
}

function updateHeaderTitle(){
  try {
    const titleText = extractArticleTitle();
    const el = document.getElementById('assistant-article-title');
    if (!el) return;
    el.textContent = isGlobalArticle() ? t('assistant.global') : (titleText || t('assistant.article'));
  } catch(_){}
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
  // 優先使用「目前選中的會話」；若沒有，才回退到該文章的第一個會話
  const box = panel.querySelector('#assistant-messages');
  if (!box) return;
  box.innerHTML = '';
  (async () => {
    const ctx0 = await buildContext();
    const ctx = overrideArticleKey ? { ...ctx0, articleKey: overrideArticleKey } : ctx0;
    const idx = readIndex();
    const curId = getCurrentConvId(ctx.articleKey);
    let meta = curId ? idx.find(x => x.id === curId) : null;
    if (!meta) meta = idx.find(x => x.articleKey === ctx.articleKey);
    if (!meta) return;
    const messages = await idbGetConv(meta.id);
    for (const m of messages) appendMessage(box, m.role, m.content, { messageId: m.id, conversationId: meta.id, articleId: meta.articleId });
    box.scrollTop = box.scrollHeight;
  })();
}

function addHint(panel, text) {
  const box = panel.querySelector('#assistant-messages');
  const el = document.createElement('div');
  el.className = 'assistant-msg assistant-hint';
  el.textContent = text;
  box.appendChild(el);
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
    if (meta.messageId) attachKeepDocumentButton(el, meta);
  } else {
    el.textContent = text || '';
  }
  container.appendChild(el);
  return el;
}

async function ask(panel, userText, opts = {}) {
  const st = loadGlobalSettings();
  const streamPref = st?.assistant?.stream !== false;
  const box = panel.querySelector('#assistant-messages');
  const isRetry = opts && opts.mode === 'retry';
  const ctx0 = await buildContext();
  const articleKey = opts.articleKey || ctx0.articleKey;
  const requestedArticleId = ctx0.articleId || (opts.articleId || '');
  const articleText = ctx0.text;
  const title = extractArticleTitle();
  const learningItemId = opts.learningItemId || '';
  const messageAnchor = opts.anchor || null;
  const messageContentVersion = opts.contentVersion || '';

  // 會話 ID 在本輪開始時固定；重試一定沿用原會話，不因目前文章改變而跳槽。
  const pinned = opts.convId ? readingStore.getConversation(opts.convId) : null;
  const conversation = pinned || await ensureConversationForContext({ ...ctx0, articleKey, articleId: requestedArticleId }, title);
  const articleId = requestedArticleId || conversation?.articleId || '';
  if (!conversation) {
    appendMessage(box, 'assistant', t('assistant.error', { message: t('assistant.tryLater') }));
    return;
  }
  const conversationId = conversation.id;
  setCurrentConvId(articleKey, conversationId);

  const system = {
    role: 'system',
    content: buildPrompt('assistant.articleTutor', {}, { locale: getLocale() })
  };
  const context = articleText && articleText.trim() ? { role: 'user', content: `${t('assistant.contextPrefix')}\n\n"""\n${articleText}\n"""` } : null;
  const prev = await readingStore.getMessages(conversationId);
  const history = prev.slice(-8).map(m => ({ role: m.role, content: m.content }));
  const messages = [system, ...(context ? [context] : []), ...history, { role: 'user', content: userText }];

  if (!isRetry) appendMessage(box, 'user', userText);
  let placeholder = (isRetry && opts.reuseEl) ? opts.reuseEl : appendMessage(box, 'assistant', '');
  try { if (isRetry) { placeholder.innerHTML = ''; } } catch(_) {}
  box.scrollTop = box.scrollHeight;

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

  const ac = new AbortController();
  const stopBtn = document.createElement('button');
  stopBtn.className = 'assistant-stop';
  stopBtn.textContent = t('assistant.stop');
  stopBtn.addEventListener('click', () => ac.abort());
  placeholder.parentElement.appendChild(stopBtn);

  let buffer = '';
  let hadError = false;
  try {
    try { const old = placeholder.querySelector('.assistant-retry'); if (old) old.remove(); } catch(_){}
    if (streamPref) {
      await streamCompletions(messages, ac.signal, (delta) => {
        buffer += delta;
        placeholder.textContent = buffer;
        box.scrollTop = box.scrollHeight;
      });
    } else {
      buffer = await onceCompletions(messages, ac.signal);
      try { placeholder.innerHTML = markdownToHtml(buffer || ''); try { enhanceMarkdown(placeholder); } catch(_){} }
      catch(_) { placeholder.textContent = buffer; }
    }
  } catch (e) {
    if (e?.name !== 'AbortError') {
      hadError = true;
      placeholder.textContent = (buffer || '') + `\n${t('assistant.error', { message: e?.message || t('assistant.tryLater') })}`;
    }
  } finally {
    stopBtn.remove();
    if (streamPref) {
      try { placeholder.innerHTML = markdownToHtml(buffer || ''); try { enhanceMarkdown(placeholder); } catch(_){} }
      catch(_) { /* ignore，保留純文字 */ }
    }
    if (!hadError) {
      // 每條回答逐條永久保存；保存失敗仍保留畫面內容並提示。
      const saved = await readingStore.appendMessage({
        conversationId,
        role: 'assistant',
        content: buffer,
        status: 'complete',
        articleId,
        learningItemId,
        anchor: messageAnchor,
        contentVersion: messageContentVersion
      });
      if (saved.ok) {
        placeholder.dataset.messageId = saved.message.id;
        placeholder.dataset.conversationId = conversationId;
        placeholder.dataset.articleId = articleId || conversation.articleId || '';
        attachKeepDocumentButton(placeholder, {
          messageId: saved.message.id,
          conversationId,
          articleId: articleId || conversation.articleId || '',
          learningItemId: saved.message.learningItemId || learningItemId
        });
      } else {
        const warning = document.createElement('div');
        warning.className = 'assistant-save-error';
        warning.textContent = t('assistant.saveFailed');
        placeholder.appendChild(warning);
      }
    }
    if (hadError) {
      try {
        const retry = document.createElement('button');
        retry.className = 'assistant-retry';
        retry.textContent = t('assistant.retry');
        retry.addEventListener('click', async () => {
          retry.disabled = true;
          await ask(panel, userText, { ...opts, mode: 'retry', reuseEl: placeholder, articleId, convId: conversationId });
        });
        placeholder.appendChild(document.createElement('br'));
        placeholder.appendChild(retry);
      } catch(_) {}
    }
  }
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
  const ctx = await buildContext();
  const meta = await createAssistantConversation({
    articleKey: ctx.articleKey,
    articleId: ctx.articleId,
    title: extractArticleTitle(),
    messages: []
  });
  if (!meta) return;
  setCurrentConvId(ctx.articleKey, meta.id);
  const box = panel.querySelector('#assistant-messages'); if (box) box.innerHTML='';
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
    setCurrentConvId(ctx.articleKey, id);
    const box = panel.querySelector('#assistant-messages');
    if (box) { box.innerHTML=''; const msgs = await idbGetConv(id); const meta = idx.find(x => x.id === id) || null; msgs.forEach(m=>appendMessage(box,m.role,m.content,{ messageId: m.id, conversationId: id, articleId: meta?.articleId || '' })); box.scrollTop=box.scrollHeight; }
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
        const panel = document.getElementById('assistant-panel'); if (!panel) return;
        // 僅切換上下文/會話，不主動開啟面板（避免「預設彈窗」）
        if (articleKey && convId) { setCurrentConvId(articleKey, convId); }
        // 若面板已打開，才更新畫面；否則僅更新狀態，待下次開啟再載入
        if (!panel.classList.contains('assistant-hidden')) {
          updateHeaderTitle();
          restoreConversation(panel, articleKey);
          updateSessionLabel();
        }
      },
      send: async (text, articleKey, convId, context = {}) => {
        const panel = document.getElementById('assistant-panel'); if (!panel) return;
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
