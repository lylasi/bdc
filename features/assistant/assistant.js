// AI 助手（文章詳解模組內的懸浮聊天）
// 注意：不修改全局樣式與 index.html；所有 UI 以動態插入，樣式侷限在 .assistant-* 作用域。

import * as dom from '../../modules/dom.js';
import { loadGlobalSettings, loadGlobalSecrets } from '../../modules/settings.js';
import { API_URL, API_KEY, AI_MODELS } from '../../ai-config.js';
import { touch as syncTouch } from '../../modules/sync-signals.js';
import * as cache from '../../modules/cache.js';
import { markdownToHtml } from '../../modules/markdown.js';

const LS_KEY = 'assistantConversations'; // legacy（含所有訊息）
const LS_UPDATED_AT = 'assistantUpdatedAt';
const IDX_KEY = 'assistantConvIndex'; // 新索引：[{id, articleKey, title, updatedAt}]

function getDefaultModel() {
  const s = loadGlobalSettings();
  const models = s?.ai?.models || {};
  return models.assistant || models.articleAnalysis || AI_MODELS?.articleAnalysis || 'gpt-4.1-mini';
}

export function initAiAssistant() {
  // 僅在設定啟用時工作
  const s = loadGlobalSettings();
  if (s?.assistant && s.assistant.enabled === false) return;
  try { migrateLegacyStore(); } catch(_) {}
  injectScopedStyles();
  mountUi();
  setupVisibilityLogic();
}

function mountUi() {
  if (document.getElementById('assistant-fab')) return;
  const fab = document.createElement('button');
  fab.id = 'assistant-fab';
  fab.className = 'assistant-fab';
  fab.type = 'button';
  fab.title = 'AI 助手';
  fab.setAttribute('aria-label', 'AI 助手');
  fab.innerHTML = svgChat();
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
    if (!panel.classList.contains('assistant-hidden')) {
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
    if (!onArticle) panel.classList.add('assistant-hidden');
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
  const model = getDefaultModel();
  const title = extractArticleTitle();
  return `
    <div class="assistant-head">
      <div class="assistant-title">AI 助手 · ${escapeHtml(title || '文章')} <span id="assistant-session-label" class="assistant-session"></span></div>
      <div class="assistant-actions">
        <button class="assistant-icon" id="assistant-small" title="小視窗（右下角）">${svgSmall()}</button>
        <button class="assistant-icon" id="assistant-dock" title="靠右全高">${svgPin()}</button>
        <button class="assistant-icon" id="assistant-modal" title="居中大視窗">${svgMax()}</button>
        <span class="assistant-divider"></span>
        <button class="assistant-icon" id="assistant-new" title="新建會話">${svgPlus()}</button>
        <button class="assistant-icon" id="assistant-history" title="查看會話">${svgList()}</button>
        <button class="assistant-icon" id="assistant-refresh" title="刷新上下文">${svgRefresh()}</button>
        <button class="assistant-icon" id="assistant-min" title="最小化">${svgMin()}</button>
        <button class="assistant-icon" id="assistant-close" title="關閉">${svgClose()}</button>
      </div>
    </div>
    <div id="assistant-messages" class="assistant-messages" aria-live="polite"></div>
    <div class="assistant-foot">
      <div class="assistant-row">
        <input id="assistant-input" type="text" class="assistant-input" placeholder="輸入與本文相關的問題，Enter 送出">
        <button id="assistant-send" class="assistant-send">發送</button>
      </div>
      <div class="assistant-sub">
        <label class="assistant-switch"><input id="assistant-stream" type="checkbox" ${loadGlobalSettings()?.assistant?.stream === false ? '' : 'checked'}> 串流回應</label>
        <span class="assistant-model">模型：<code>${escapeHtml(model)}</code></span>
        <button id="assistant-clear" class="assistant-link">清空此文章對話</button>
      </div>
    </div>`;
}

function wirePanel(panel) {
  const $ = (sel) => panel.querySelector(sel);
  $('#assistant-close').addEventListener('click', () => panel.classList.add('assistant-hidden'));
  $('#assistant-min').addEventListener('click', () => panel.classList.add('assistant-hidden'));
  $('#assistant-refresh').addEventListener('click', () => addHint(panel, '已刷新文章上下文，下次提問將以最新內容為準'));
  // 模式切換（精簡版）：小視窗/靠右全高/居中彈窗
  $('#assistant-small').addEventListener('click', () => setPanelMode(panel,'floating'));
  $('#assistant-dock').addEventListener('click', () => setPanelMode(panel,'dock'));
  $('#assistant-modal').addEventListener('click', () => setPanelMode(panel,'modal'));
  // 初始化模式與尺寸
  setPanelMode(panel, getSavedPanelMode());
  if (getSavedPanelMode()==='dock') setDockWidth(panel, getSavedDockWidth());
  window.addEventListener('resize', () => { if (getSavedPanelMode()==='dock') setDockWidth(panel, getSavedDockWidth()); });

  // 會話：新建 / 歷史
  $('#assistant-new').addEventListener('click', () => newConversation(panel));
  $('#assistant-history').addEventListener('click', () => toggleHistory(panel));
  $('#assistant-clear').addEventListener('click', () => {
    const { articleKey } = buildContext();
    if (!confirm('確定清空本文章的對話？')) return;
    const all = loadConversations();
    saveConversations(all.filter(c => c.articleKey !== articleKey));
    const box = $('#assistant-messages');
    if (box) box.innerHTML = '';
  });
  $('#assistant-stream').addEventListener('change', (ev) => {
    const st = loadGlobalSettings();
    try {
      localStorage.setItem('pen_global_settings', JSON.stringify({
        ...st,
        assistant: { ...(st.assistant || {}), stream: ev.target.checked },
        updatedAt: new Date().toISOString()
      }));
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

// --------- 新：索引 + IndexedDB 儲存（cache.kv） ---------
function readIndex() {
  try { const raw = localStorage.getItem(IDX_KEY); const arr = raw ? JSON.parse(raw) : []; return Array.isArray(arr)? arr: []; } catch(_) { return []; }
}
function writeIndex(arr) {
  try { localStorage.setItem(IDX_KEY, JSON.stringify(arr)); localStorage.setItem(LS_UPDATED_AT, new Date().toISOString()); syncTouch('assistant'); } catch(_) {}
}
async function idbGetConv(convId) {
  try { const rec = await cache.getItem('assistant:conv:'+convId); return rec && rec.messages ? rec.messages : []; } catch(_) { return []; }
}
async function idbSetConv(convId, messages) {
  try { await cache.setItem('assistant:conv:'+convId, { messages }); return true; } catch(_) { return false; }
}
function ensureMeta(articleKey, title) {
  const idx = readIndex();
  let m = idx.find(x => x.articleKey === articleKey);
  if (!m) { m = { id: `c_${Date.now()}_${Math.random().toString(36).slice(2,8)}`, articleKey, title: title||'文章', updatedAt: new Date().toISOString() }; idx.unshift(m); writeIndex(idx); }
  return m;
}

function extractArticleTitle() {
  try {
    const raw = (dom.articleInput && dom.articleInput.value) || '';
    const first = raw.split(/\r?\n/)[0] || '';
    return first.replace(/^#+\s*/, '').trim();
  } catch(_) { return ''; }
}

async function buildContext() {
  const text = (dom.articleInput && dom.articleInput.value) || '';
  const articleKey = await cache.makeKey('assistant-article', text);
  return { articleKey, text };
}

function restoreConversation(panel) {
  const box = panel.querySelector('#assistant-messages');
  if (!box) return;
  box.innerHTML = '';
  (async () => {
    const ctx = await buildContext();
    const idx = readIndex();
    const meta = idx.find(x => x.articleKey === ctx.articleKey);
    if (!meta) return;
    const messages = await idbGetConv(meta.id);
    for (const m of messages) appendMessage(box, m.role, m.content);
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

function appendMessage(container, role, text) {
  const el = document.createElement('div');
  el.className = 'assistant-msg ' + (role === 'user' ? 'assistant-user' : 'assistant-assistant');
  if (role === 'assistant') {
    try { el.innerHTML = markdownToHtml(text || ''); }
    catch(_) { el.textContent = text || ''; }
  } else {
    el.textContent = text || '';
  }
  container.appendChild(el);
  return el;
}

async function ask(panel, userText) {
  const st = loadGlobalSettings();
  const streamPref = st?.assistant?.stream !== false;
  const box = panel.querySelector('#assistant-messages');
  const input = panel.querySelector('#assistant-input');
  const { articleKey, text: articleText } = await buildContext();

  // messages：系統 + 上下文 + 近幾輪 + 本輪
  const system = { role: 'system', content: SYSTEM_PROMPT };
  const context = { role: 'user', content: `以下是目前文章內容，僅作為上下文：\n\n"""\n${articleText}\n"""` };
  // 讀取最近 N 輪歷史（透過索引 + IDB）
  const idx = readIndex();
  const meta = idx.find(x => x.articleKey === articleKey);
  const prev = meta ? await idbGetConv(meta.id) : [];
  const history = prev.slice(-8).map(m => ({ role: m.role, content: m.content }));
  const messages = [system, context, ...history, { role: 'user', content: userText }];

  appendMessage(box, 'user', userText);
  const placeholder = appendMessage(box, 'assistant', '');
  box.scrollTop = box.scrollHeight;

  // 保存 user 訊息（IDB）
  await appendMessageToConv(articleKey, extractArticleTitle(), { role: 'user', content: userText, ts: Date.now() });

  const ac = new AbortController();
  const stopBtn = document.createElement('button');
  stopBtn.className = 'assistant-stop';
  stopBtn.textContent = '停止';
  stopBtn.addEventListener('click', () => ac.abort());
  placeholder.parentElement.appendChild(stopBtn);

  let buffer = '';
  try {
    if (streamPref) {
      await streamCompletions(messages, ac.signal, (delta) => {
        buffer += delta;
        placeholder.textContent = buffer;
        box.scrollTop = box.scrollHeight;
      });
    } else {
      buffer = await onceCompletions(messages, ac.signal);
      // 非串流：直接以 Markdown 渲染
      try { placeholder.innerHTML = markdownToHtml(buffer || ''); }
      catch(_) { placeholder.textContent = buffer; }
    }
  } catch (e) {
    if (e?.name !== 'AbortError') {
      placeholder.textContent = (buffer || '') + `\n[錯誤] ${e?.message || '請稍後再試'}`;
    }
  } finally {
    stopBtn.remove();
    // 串流完成：把純文字轉為 Markdown（避免要第二次載入才渲染）
    if (streamPref) {
      try { placeholder.innerHTML = markdownToHtml(buffer || ''); }
      catch(_) { /* ignore，保留純文字 */ }
    }
    await appendMessageToConv(articleKey, extractArticleTitle(), { role: 'assistant', content: buffer, ts: Date.now() });
  }
}
async function appendMessageToConv(articleKey, title, message) {
  const meta = ensureMeta(articleKey, title);
  const list = await idbGetConv(meta.id);
  list.push(message);
  await idbSetConv(meta.id, list);
  const idx = readIndex().map(x => x.id === meta.id ? { ...x, title, updatedAt: new Date().toISOString() } : x);
  writeIndex(idx);
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
      if (!exist.has(id)) idx.unshift({ id, articleKey: c.articleKey, title: c.title || '文章', updatedAt: c.updatedAt || new Date().toISOString() });
      try { if (Array.isArray(c.messages)) cache.setItem('assistant:conv:'+id, { messages: c.messages }); } catch(_) {}
    }
    writeIndex(idx);
    localStorage.removeItem(LS_KEY);
  } catch(_) {}
}

async function onceCompletions(messages, signal) {
  const s = loadGlobalSettings();
  const sec = loadGlobalSecrets();
  const endpoint = (s?.ai?.apiUrl && String(s.ai.apiUrl).trim()) || API_URL;
  const key = (sec?.aiApiKey && String(sec.aiApiKey).trim()) || API_KEY;
  const model = getDefaultModel();
  const resp = await fetch(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({ model, messages, temperature: 0.2 }), signal
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  return (data?.choices?.[0]?.message?.content || '').trim();
}

async function streamCompletions(messages, signal, onDelta) {
  const s = loadGlobalSettings();
  const sec = loadGlobalSecrets();
  const endpoint = (s?.ai?.apiUrl && String(s.ai.apiUrl).trim()) || API_URL;
  const key = (sec?.aiApiKey && String(sec.aiApiKey).trim()) || API_KEY;
  const model = getDefaultModel();
  const resp = await fetch(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({ model, messages, temperature: 0.2, stream: true }), signal
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let acc = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    acc += dec.decode(value, { stream: true });
    let idx;
    while ((idx = acc.indexOf('\n\n')) !== -1) {
      const chunk = acc.slice(0, idx).trim();
      acc = acc.slice(idx + 2);
      if (!chunk) continue;
      const lines = chunk.split('\n');
      for (const line of lines) {
        const m = line.match(/^data:\s*(.*)$/);
        if (!m) continue;
        const payload = m[1];
        if (payload === '[DONE]') return;
        try {
          const json = JSON.parse(payload);
          const delta = json?.choices?.[0]?.delta?.content || '';
          if (delta) onDelta(delta);
        } catch(_) {}
      }
    }
  }
}

function injectScopedStyles() {
  const exist = document.getElementById('assistant-style');
  const style = exist || document.createElement('style');
  style.id = 'assistant-style';
  style.textContent = `
  .assistant-fab{position:fixed;right:16px;bottom:16px;width:48px;height:48px;border-radius:50%;background:#3b82f6;color:#fff;border:none;box-shadow:0 8px 24px rgba(59,130,246,.35);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;z-index:2400}
  .assistant-fab:hover{transform:translateY(-1px)}
  .assistant-panel{position:fixed;right:16px;bottom:76px;width:min(420px,92vw);max-height:min(75vh,640px);background:#fff;border:1px solid #e5e7eb;border-radius:14px;box-shadow:0 14px 38px rgba(0,0,0,.14);display:flex;flex-direction:column;overflow:hidden;z-index:4000;pointer-events:auto}
  .assistant-hidden{display:none}
  .assistant-head{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid #eef2f7;background:#f8fafc}
  .assistant-title{font-weight:700;color:#111827;font-size:14px}
  .assistant-actions{display:flex;gap:6px;align-items:center}
  .assistant-divider{width:1px;height:18px;background:#e5e7eb;margin:0 4px}
  .assistant-session{font-size:12px;color:#64748b;margin-left:4px}
  .assistant-icon{width:28px;height:28px;border:1px solid #d1d5db;border-radius:8px;background:#fff;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;color:#64748b}
  .assistant-icon:hover{border-color:#93c5fd;color:#1d4ed8;background:#f8fbff}
  .assistant-icon svg{width:16px;height:16px;display:block;fill:currentColor}
  .assistant-messages{padding:12px 16px;overflow:auto;flex:1;background:#fff}
  .assistant-msg{white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;padding:10px 14px;border-radius:10px;margin:8px 0;box-sizing:border-box}
  .assistant-msg p{margin:6px 0}
  .assistant-msg ol,.assistant-msg ul{margin:4px 0 8px 0;padding-left:1.25em}
  .assistant-msg li{margin:2px 0}
  .assistant-msg img{max-width:100%;height:auto;display:block;border-radius:6px}
  .assistant-msg table{width:100%;border-collapse:collapse;table-layout:auto;margin:6px 0}
  .assistant-msg th,.assistant-msg td{border:1px solid #e5e7eb;padding:6px 8px;vertical-align:top}
  .assistant-msg code{background:#f3f4f6;border:1px solid #e5e7eb;border-radius:4px;padding:0 3px;font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace}
  .assistant-msg pre{background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:10px;overflow:auto}
  .assistant-user{background:#eef2ff;color:#1e293b;align-self:flex-end}
  .assistant-assistant{background:#f1f5f9;color:#111827;align-self:flex-start;position:relative}
  .assistant-hint{background:#fef3c7;color:#78350f}
  .assistant-foot{border-top:1px solid #eef2f7;padding:10px 12px;display:flex;flex-direction:column;gap:8px;background:#fff}
  .assistant-row{display:flex;gap:8px}
  .assistant-input{flex:1;padding:10px 12px;border:1px solid #e5e7eb;border-radius:10px;font-size:14px}
  .assistant-send{padding:10px 14px;background:#3b82f6;color:#fff;border:none;border-radius:10px;cursor:pointer}
  .assistant-sub{display:flex;align-items:center;gap:12px;justify-content:space-between;color:#6b7280;font-size:12px}
  .assistant-switch{display:flex;align-items:center;gap:6px}
  .assistant-link{background:none;border:none;color:#2563eb;cursor:pointer}
  .assistant-stop{position:absolute;right:8px;bottom:8px;font-size:12px;padding:4px 8px;border-radius:8px;border:1px solid #e5e7eb;background:#fff;color:#334155;cursor:pointer}

  /* 桌面：提供多種寬度尺寸 */
  @media (min-width: 1024px){
    .assistant-panel{max-height:85vh}
    /* 桌面：加大工具圖示按鈕與圖標尺寸，避免過小難以辨識 */
    .assistant-icon{width:36px;height:36px}
    .assistant-icon svg{width:18px;height:18px}
  }
  /* Dock 模式 */
  .assistant-panel.assistant-dock{right:16px;left:auto;top:16px;bottom:16px;border-radius:12px;max-height:calc(100vh - 32px)}
  /* Modal 模式 */
  .assistant-backdrop{position:fixed;inset:0;background:rgba(15,23,42,.35);z-index:3999;backdrop-filter:saturate(120%) blur(2px);}
  .assistant-panel.assistant-modal{left:50%;right:auto;top:5vh;bottom:auto;transform:translateX(-50%);width:min(960px,94vw);height:min(90vh,880px);border-radius:14px}
  `;
  if (!exist) document.head.appendChild(style);
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
  // 背景遮罩
  toggleBackdrop(mode==='modal');
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
  const id = `c_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
  const meta = ensureMetaWithId(ctx.articleKey, extractArticleTitle(), id);
  await idbSetConv(meta.id, []);
  setCurrentConvId(ctx.articleKey, meta.id);
  const box = panel.querySelector('#assistant-messages'); if (box) box.innerHTML='';
}

function ensureMetaWithId(articleKey, title, id){
  const idx = readIndex();
  const exist = idx.find(x => x.id === id);
  if (exist) return exist;
  const m = { id, articleKey, title: title||'新會話', updatedAt: new Date().toISOString() };
  idx.unshift(m); writeIndex(idx); return m;
}

async function toggleHistory(panel){
  const ctx = await buildContext();
  const idx = readIndex().filter(x => x.articleKey===ctx.articleKey);
  let pop = document.getElementById('assistant-history-panel');
  if (pop) { pop.remove(); return; }
  pop = document.createElement('div');
  pop.id='assistant-history-panel';
  pop.style.cssText='position:absolute; right:12px; top:44px; z-index:2401; background:#fff;border:1px solid #e5e7eb;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.14); min-width:300px; max-height:60vh; overflow:auto;';
  pop.innerHTML = idx.length ? idx.map(m=>`<div class="ah-item" data-id="${m.id}" style="display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px dashed #eef2f7;cursor:pointer;">
    <div class="ah-meta" style="flex:1;min-width:0;">
      <div class="ah-title" style="font-weight:600;color:#111827;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(m.title||'會話')}</div>
      <div class="ah-time" style="font-size:12px;color:#64748b;">${new Date(m.updatedAt||Date.now()).toLocaleString()}</div>
    </div>
    <button class="assistant-icon" data-act="open" title="切換">${svgOpen()}</button>
    <button class="assistant-icon" data-act="rename" title="重命名">${svgEdit()}</button>
    <button class="assistant-icon" data-act="delete" title="刪除">${svgTrash()}</button>
  </div>`).join('') : '<div style="padding:12px;color:#64748b;">尚無會話</div>';
  panel.appendChild(pop);
  pop.addEventListener('click', async (ev) => {
    const item = ev.target.closest('.ah-item');
    if (!item) return;
    const id = item.getAttribute('data-id');
    const actBtn = ev.target.closest('button[data-act]');
    const act = actBtn ? actBtn.getAttribute('data-act') : 'open';
    if (act === 'rename') {
      ev.stopPropagation();
      const titleEl = item.querySelector('.ah-title');
      const newTitle = prompt('輸入新的會話名稱：', titleEl?.textContent || '');
      if (newTitle && newTitle.trim()) {
        const list = readIndex().map(x => x.id===id? { ...x, title:newTitle.trim(), updatedAt:new Date().toISOString() }: x);
        writeIndex(list); titleEl.textContent = newTitle.trim(); updateSessionLabel();
      }
      return;
    }
    if (act === 'delete') {
      ev.stopPropagation();
      if (!confirm('確定刪除此會話？')) return;
      const list = readIndex().filter(x => x.id!==id); writeIndex(list);
      try { await cache.setItem('assistant:conv:'+id, { messages: [] }); } catch(_) {}
      item.remove();
      if (getCurrentConvId(ctx.articleKey)===id){ setCurrentConvId(ctx.articleKey, ''); const box=panel.querySelector('#assistant-messages'); if (box) box.innerHTML=''; updateSessionLabel(); }
      return;
    }
    // open 切換
    setCurrentConvId(ctx.articleKey, id);
    const box = panel.querySelector('#assistant-messages');
    if (box) { box.innerHTML=''; const msgs = await idbGetConv(id); msgs.forEach(m=>appendMessage(box,m.role,m.content)); box.scrollTop=box.scrollHeight; }
    updateSessionLabel(); pop.remove();
  });
}

function updateSessionLabel(){
  try {
    const el = document.getElementById('assistant-session-label');
    if (!el) return;
    const ak = getCurrentArticleKeySync();
    const id = getCurrentConvId(ak);
    if (!id){ el.textContent=''; return; }
    const m = readIndex().find(x => x.id===id);
    el.textContent = m ? `· ${m.title||'會話'}` : '';
  } catch(_){}
}

// 以文章文字作為同步鍵（避免 async 雜湊在 UI 中不好用）；
// 足以區分不同文章，且對話切換時可做 per-article 記憶。
function getCurrentArticleKeySync(){
  try { const raw = (dom.articleInput && dom.articleInput.value) || ''; return String(raw).slice(0, 64) || 'global'; } catch(_) { return 'global'; }
}

function escapeHtml(s){return String(s||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}

function svgChat(){return '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M12 3C6.477 3 2 6.94 2 11.8c0 1.946.72 3.746 1.934 5.19L3 21l4.2-1.758c1.362.515 2.87.8 4.5.8 5.523 0 10-3.94 10-8.8S17.523 3 12 3z"/></svg>'}
function svgClose(){return '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/></svg>'}
function svgMin(){return '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M3 9.5a.5.5 0 0 1 .5-.5h9a.5.5 0 0 1 0 1h-9a.5.5 0 0 1-.5-.5z"/></svg>'}
function svgRefresh(){return '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M8 3a5 5 0 1 0 3.905 8.12.5.5 0 1 1 .79.612A6 6 0 1 1 8 2v1z"/><path d="M8 0a.5.5 0 0 1 .5.5v3.793l1.146-1.147a.5.5 0 1 1 .708.708L8.354 5.71a.5.5 0 0 1-.708 0L5.646 3.854a.5.5 0 1 1 .708-.708L7.5 4.293V.5A.5.5 0 0 1 8 0z"/></svg>'}
function svgPin(){return '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M4.146 2.146a.5.5 0 0 1 .708 0L7.5 4.793l1.646-1.647a.5.5 0 0 1 .708.708L8.207 5.5l2.147 2.146a.5.5 0 1 1-.708.708L7.5 6.207 5.354 8.354a.5.5 0 1 1-.708-.708L6.793 5.5 4.146 2.854a.5.5 0 0 1 0-.708z"/></svg>'}
function svgFull(){return '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M1 1h5v1H2v4H1V1zm8 0h6v6h-1V2H9V1zM1 9h1v5h5v1H1V9zm13 0h1v7H9v-1h5V9z"/></svg>'}
function svgSmall(){return '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><rect x="9" y="9" width="6" height="6" rx="2"/><rect x="1" y="1" width="10" height="10" rx="2" fill="none" stroke="currentColor"/></svg>'}
function svgMax(){return '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M1 4a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H4a3 3 0 0 1-3-3z"/></svg>'}
function svgPlus(){return '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M8 1a.5.5 0 0 1 .5.5v6h6a.5.5 0 0 1 0 1h-6v6a.5.5 0 0 1-1 0v-6h-6a.5.5 0 0 1 0-1h6v-6A.5.5 0 0 1 8 1z"/></svg>'}
function svgList(){return '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M2 2.5a.5.5 0 0 0 0 1h12a.5.5 0 0 0 0-1H2zm0 5a.5.5 0 0 0 0 1h12a.5.5 0 0 0 0-1H2zm0 5a.5.5 0 0 0 0 1h12a.5.5 0 0 0 0-1H2z"/></svg>'}
function svgOpen(){return '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M4 4h6v1H5v6H4V4zm3 3h5v5H7V7z"/></svg>'}
function svgEdit(){return '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M12.146.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1 0 .708l-9.5 9.5L4 14l.646-2.354 9.5-9.5z"/></svg>'}
function svgTrash(){return '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M6.5 1h3a.5.5 0 0 1 .5.5V3h3a.5.5 0 0 1 0 1H3a.5.5 0 0 1 0-1h3V1.5a.5.5 0 0 1 .5-.5z"/><path d="M5.5 5a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-1 0v-7a.5.5 0 0 1 .5-.5zm5 0a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-1 0v-7a.5.5 0 0 1 .5-.5z"/><path d="M4.118 4.5 4 14a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2l-.118-9.5H4.118z"/></svg>'}

const SYSTEM_PROMPT = `你是「PEN子背單詞」前端網頁中的英語學習助教。請始終以繁體中文（香港用字）回答，用字例：網上、上載、電郵、的士、巴士、軟件、網絡、連結、相片。不要使用粵語口語。

[任務範圍]
- 專注協助使用者理解「目前文章」內容（前端已夾帶全文作為上下文），並支援互動問答。
- 常見需求：翻譯句子/段落（保持 Markdown 結構）、抽取關鍵點、解釋詞彙與文法、提供例句、檢查句子是否自然/正確、產生練習題與摘要。
- 禁止臆測未提供的外部內容；若資料不足，請說明需要哪部分文章或上下文。

[輸出風格]
- 優先給出可直接使用的答案；必要時附 2–5 條重點。
- 若翻譯含 Markdown：必須保留原 Markdown 語法與行結構，只翻譯文字；圖片/連結語法原樣保留。

[功能指南]
- 詞彙：給 IPA（若可）、詞性、常見義項、例句（短、自然）。
- 文法/句構：指出結構與功能角色，常見錯誤與記憶提示。
- 例句：日常、簡潔、符合主題；1–3 句。
- 檢查：結論 + 改寫建議 + 簡短理由。
- 練習題：填空/判斷/改寫，附標準答案與提示。

[錯誤處理]
- 若文章不足或未提供，請提示使用者先在文章詳解頁輸入內容，或指定段落。`;
