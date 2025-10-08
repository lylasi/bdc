// AI 助手（文章詳解模組內的懸浮聊天）
// 注意：不修改全局樣式與 index.html；所有 UI 以動態插入，樣式侷限在 .assistant-* 作用域。

import * as dom from '../../modules/dom.js';
import { loadGlobalSettings, loadGlobalSecrets } from '../../modules/settings.js';
import { API_URL, API_KEY, AI_MODELS } from '../../ai-config.js';
import { touch as syncTouch } from '../../modules/sync-signals.js';
import * as cache from '../../modules/cache.js';

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
      <div class="assistant-title">AI 助手 · ${escapeHtml(title || '文章')}</div>
      <div class="assistant-actions">
        <button class="assistant-icon" id="assistant-dock" title="靠右停靠/浮動切換">${svgPin()}</button>
        <button class="assistant-icon" id="assistant-full" title="全高/適中高度">${svgFull()}</button>
        <div class="assistant-sizes" role="group" aria-label="面板尺寸">
          <button class="assistant-size-btn" data-size="s" data-label="S" title="小">S</button>
          <button class="assistant-size-btn" data-size="m" data-label="M" title="中">M</button>
          <button class="assistant-size-btn" data-size="l" data-label="L" title="大">L</button>
          <button class="assistant-size-btn" data-size="xl" data-label="XL" title="特大">XL</button>
        </div>
        <div class="assistant-percents" role="group" aria-label="面板寬度（%）">
          <button class="assistant-percent-btn" data-pct="35">35%</button>
          <button class="assistant-percent-btn" data-pct="40">40%</button>
          <button class="assistant-percent-btn" data-pct="50">50%</button>
          <button class="assistant-percent-btn" data-pct="60">60%</button>
        </div>
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
  // 面板尺寸：按鈕/雙擊標題切換
  const applySize = (sz) => setPanelSize(panel, sz);
  panel.querySelectorAll('.assistant-size-btn').forEach(btn => {
    btn.addEventListener('click', () => applySize(btn.getAttribute('data-size')));
  });
  panel.querySelector('.assistant-head').addEventListener('dblclick', () => cyclePanelSize(panel));
  // 首次套用儲存尺寸
  applySize(getSavedPanelSize());

  // Dock 模式與全高
  $('#assistant-dock').addEventListener('click', () => togglePanelMode(panel));
  $('#assistant-full').addEventListener('click', () => togglePanelFull(panel));
  panel.querySelectorAll('.assistant-percent-btn').forEach(btn => {
    btn.addEventListener('click', () => { setDockWidth(panel, parseInt(btn.getAttribute('data-pct'),10)||40); });
  });
  // 初次套用 dock 狀態
  setPanelMode(panel, getSavedPanelMode());
  setDockWidth(panel, getSavedDockWidth());
  window.addEventListener('resize', () => { if (getSavedPanelMode()==='dock') setDockWidth(panel, getSavedDockWidth()); });
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
  el.textContent = text || '';
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
      placeholder.textContent = buffer;
    }
  } catch (e) {
    if (e?.name !== 'AbortError') {
      placeholder.textContent = (buffer || '') + `\n[錯誤] ${e?.message || '請稍後再試'}`;
    }
  } finally {
    stopBtn.remove();
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
  .assistant-panel{position:fixed;right:16px;bottom:76px;width:min(420px,92vw);max-height:min(75vh,640px);background:#fff;border:1px solid #e5e7eb;border-radius:14px;box-shadow:0 14px 38px rgba(0,0,0,.14);display:flex;flex-direction:column;overflow:hidden;z-index:2400}
  .assistant-hidden{display:none}
  .assistant-head{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid #eef2f7;background:#f8fafc}
  .assistant-title{font-weight:700;color:#111827;font-size:14px}
  .assistant-actions{display:flex;gap:6px;align-items:center}
  .assistant-sizes{display:none;gap:6px;margin-right:6px}
  .assistant-size-btn{min-width:28px;height:22px;padding:0 6px;border:1px solid #d1d5db;border-radius:6px;background:#fff;cursor:pointer;font-size:11px;color:#475569}
  .assistant-size-btn.active{background:#eaf2ff;border-color:#93c5fd;color:#1d4ed8;box-shadow:0 0 0 1px #dbeafe inset}
  .assistant-percents{display:none;gap:6px;margin-right:6px}
  .assistant-percent-btn{min-width:42px;height:24px;padding:0 8px;border:1px solid #d1d5db;border-radius:6px;background:#fff;cursor:pointer;font-size:11px;color:#475569}
  .assistant-percent-btn.active{background:#eef2ff;border-color:#93c5fd;color:#1d4ed8;box-shadow:0 0 0 1px #dbeafe inset}
  .assistant-icon{width:28px;height:28px;border:1px solid #d1d5db;border-radius:8px;background:#fff;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;color:#64748b}
  .assistant-icon:hover{border-color:#93c5fd;color:#1d4ed8;background:#f8fbff}
  .assistant-icon svg{width:16px;height:16px;display:block;fill:currentColor}
  .assistant-messages{padding:12px;overflow:auto;flex:1;background:#fff}
  .assistant-msg{white-space:pre-wrap;word-break:break-word;padding:10px 12px;border-radius:10px;margin:8px 0}
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
    .assistant-sizes{display:inline-flex}
    .assistant-panel.assistant-size-s{width:420px}
    .assistant-panel.assistant-size-m{width:560px}
    .assistant-panel.assistant-size-l{width:720px}
    .assistant-panel.assistant-size-xl{width:900px}
    .assistant-panel{max-height:85vh}
    /* Dock 模式 */
    .assistant-panel.assistant-dock{right:16px;left:auto;top:16px;bottom:16px;border-radius:12px;max-height:calc(100vh - 32px)}
    .assistant-panel.assistant-dock .assistant-percents{display:inline-flex}
    .assistant-panel.assistant-dock .assistant-sizes{display:none}
  }
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
function getSavedPanelMode(){ try { return localStorage.getItem('assistantPanelMode') || 'floating'; } catch(_) { return 'floating'; } }
function savePanelMode(m){ try { localStorage.setItem('assistantPanelMode', m); } catch(_){} }
function getSavedDockWidth(){ try { return parseInt(localStorage.getItem('assistantPanelDockWidth')||'40',10) || 40; } catch(_) { return 40; } }
function saveDockWidth(p){ try { localStorage.setItem('assistantPanelDockWidth', String(p)); } catch(_){} }
function getSavedFull(){ try { return localStorage.getItem('assistantPanelFull')==='1'; } catch(_) { return false; } }
function saveFull(v){ try { localStorage.setItem('assistantPanelFull', v?'1':'0'); } catch(_){} }

function setPanelMode(panel, mode){
  if (mode !== 'dock') mode = 'floating';
  panel.classList.toggle('assistant-dock', mode==='dock');
  panel.classList.toggle('assistant-floating', mode!=='dock');
  savePanelMode(mode);
  // 切換控件顯示
  const sizes = panel.querySelector('.assistant-sizes');
  const pcts = panel.querySelector('.assistant-percents');
  if (sizes && pcts){
    sizes.style.display = (mode==='dock' ? 'none' : 'inline-flex');
    pcts.style.display = (mode==='dock' ? 'inline-flex' : 'none');
  }
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

function escapeHtml(s){return String(s||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}

function svgChat(){return '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M12 3C6.477 3 2 6.94 2 11.8c0 1.946.72 3.746 1.934 5.19L3 21l4.2-1.758c1.362.515 2.87.8 4.5.8 5.523 0 10-3.94 10-8.8S17.523 3 12 3z"/></svg>'}
function svgClose(){return '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/></svg>'}
function svgMin(){return '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M3 9.5a.5.5 0 0 1 .5-.5h9a.5.5 0 0 1 0 1h-9a.5.5 0 0 1-.5-.5z"/></svg>'}
function svgRefresh(){return '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M8 3a5 5 0 1 0 3.905 8.12.5.5 0 1 1 .79.612A6 6 0 1 1 8 2v1z"/><path d="M8 0a.5.5 0 0 1 .5.5v3.793l1.146-1.147a.5.5 0 1 1 .708.708L8.354 5.71a.5.5 0 0 1-.708 0L5.646 3.854a.5.5 0 1 1 .708-.708L7.5 4.293V.5A.5.5 0 0 1 8 0z"/></svg>'}
function svgPin(){return '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M4.146 2.146a.5.5 0 0 1 .708 0L7.5 4.793l1.646-1.647a.5.5 0 0 1 .708.708L8.207 5.5l2.147 2.146a.5.5 0 1 1-.708.708L7.5 6.207 5.354 8.354a.5.5 0 1 1-.708-.708L6.793 5.5 4.146 2.854a.5.5 0 0 1 0-.708z"/></svg>'}
function svgFull(){return '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M1 1h5v1H2v4H1V1zm8 0h6v6h-1V2H9V1zM1 9h1v5h5v1H1V9zm13 0h1v7H9v-1h5V9z"/></svg>'}

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
