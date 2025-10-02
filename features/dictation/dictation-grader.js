import * as ui from '../../modules/ui.js';
import * as dom from '../../modules/dom.js';
import * as state from '../../modules/state.js';
import * as api from '../../modules/api.js';
import * as storage from '../../modules/storage.js';
import { OCR_CONFIG } from '../../ai-config.js';

// 簡易 AI 批改（OCR→比對）
export function initDictationGrader() {
  if (!dom.dictationAIGradeBtn) return;
  dom.dictationAIGradeBtn.addEventListener('click', openGraderModal);
}

// 提供給外部（右上角菜單）打開歷史的入口
export function openDictationGradingHistory() {
  // 構建與內部 openHistory 相同的視圖
  const list = storage.getGradingHistory();
  const box = document.createElement('div');
  box.className = 'dg-history';
  if (!list.length) { box.innerHTML = '<p>尚無歷史記錄。</p>'; show(box); return; }
  const items = list.map(it => {
    const t = new Date(it.createdAt).toLocaleString();
    return `<div class="dg-h-item" data-id="${it.id}">
      <img src="${it.thumbnail || ''}" alt="thumb">
      <div class="meta">
        <div class="time">${t}</div>
        <div class="sub">模型：${it.model || '-'} · 圖片：${it.imagesCount || 0} · 詞表：${it.wordsCount || 0}</div>
      </div>
      <div class="ops">
        <button data-act="view">查看</button>
        <button data-act="del">刪除</button>
      </div>
    </div>`;
  }).join('');
  box.innerHTML = `<div class="dg-h-toolbar"><button id="dg-h-clear" class="btn-secondary">清空全部</button></div><div class="dg-h-list">${items}</div>`;
  box.addEventListener('click', (e) => {
    const btn = e.target.closest('button'); if (!btn) return;
    const item = e.target.closest('.dg-h-item'); if (!item) return;
    const id = item.getAttribute('data-id');
    const recList = storage.getGradingHistory();
    const rec = recList.find(x => x.id === id);
    if (!rec) return;
    const act = btn.getAttribute('data-act');
    if (btn.id === 'dg-h-clear') {
      if (confirm('確定清空全部歷史？此操作不可撤回')) { storage.clearGradingHistory(); openDictationGradingHistory(); }
    } else if (act === 'view') {
      const container = document.createElement('div');
      container.className = 'dictation-grader-wrap';
      const tools = document.createElement('div');
      tools.className = 'dg-tools';
      tools.innerHTML = '<button id="dg-view-copy" class="btn-secondary">複製 Markdown</button> <button id="dg-view-export" class="btn-secondary">下載 CSV</button>';
      const report = document.createElement('div');
      renderMarkdownReport(report, rec.markdown || '');
      container.appendChild(tools);
      container.appendChild(report);
      dom.modalTitle.textContent = '批改結果';
      dom.modalBody.innerHTML = '';
      dom.modalBody.appendChild(container);
      ui.openModal();
      try { document.querySelector('#app-modal .modal-content')?.classList.add('modal-large'); } catch(_) {}
      // 綁定工具
      container.querySelector('#dg-view-copy')?.addEventListener('click', async () => {
        await copyToClipboard(rec.markdown || '');
      });
      container.querySelector('#dg-view-export')?.addEventListener('click', () => {
        const csv = markdownFirstTableToCsv(rec.markdown || '');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `grading-${rec.id}.csv`;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
      });
    } else if (act === 'del') {
      if (confirm('確定刪除此記錄？')) { storage.deleteGradingRecord(id); openDictationGradingHistory(); }
    }
  });
  show(box);

  function show(content) {
    dom.modalTitle.textContent = '批改歷史';
    dom.modalBody.innerHTML = '';
    dom.modalBody.appendChild(content);
    ui.openModal();
    try { document.querySelector('#app-modal .modal-content')?.classList.add('modal-large'); } catch(_) {}
  }
}

function openGraderModal() {
  const expected = getExpectedWords();
  const body = buildModalContent(expected);
  dom.modalTitle.textContent = 'AI 批改手寫（OCR）';
  dom.modalBody.innerHTML = '';
  dom.modalBody.appendChild(body);
  ui.openModal();
  try { document.querySelector('#app-modal .modal-content')?.classList.add('modal-large'); } catch(_) {}
}

function getExpectedWords() {
  // 優先使用進行中的默寫清單；若無則使用當前選中的單詞本
  let words = Array.isArray(state.dictationWords) && state.dictationWords.length
    ? state.dictationWords
    : [];
  if (!words.length) {
    const selected = document.querySelector('#dictation-book-selector input[name="dictation-book"]:checked');
    if (selected) {
      const book = state.vocabularyBooks.find(b => b.id === selected.value);
      if (book && Array.isArray(book.words)) words = book.words;
    }
  }
  return words.map(w => ({ word: (w.word || '').toString(), meaning: (w.meaning || '').toString() }));
}

function buildModalContent(expected) {
  const wrap = document.createElement('div');
  wrap.className = 'dictation-grader-wrap';
  wrap.innerHTML = `
    <div class="dg-form">
      <div class="dg-row">
        <label>上傳相片：</label>
        <input id="dg-file" type="file" accept="image/*" multiple>
        <div class="dg-inline" style="gap:6px;">
          <button id="dg-take-photo" class="btn-secondary">拍照</button>
          <button id="dg-choose-gallery" class="btn-secondary">從相簿選擇</button>
        </div>
      </div>
      <div class="dg-row">
        <label>選項：</label>
        <label class="dg-inline"><input type="checkbox" id="dg-include-meaning" checked> 對照中文意思（若有）</label>
        <label class="dg-inline"><input type="checkbox" id="dg-strict" > 嚴格大小寫</label>
      </div>
      <!-- 批改方式（已固定使用 AI，保留結構方便日後需要時再開） -->
      <div class="dg-row" style="display:none;">
        <label>批改方式：</label>
        <label class="dg-inline"><input type="radio" name="dg-mode" id="dg-mode-local"> OCR + 本地比對</label>
        <label class="dg-inline"><input type="radio" name="dg-mode" id="dg-mode-ai" checked> 直接交給 AI 批改</label>
      </div>
      <div class="dg-row">
        <label>OCR 模型：</label>
        <select id="dg-model"></select>
      </div>
      <div class="dg-row dg-ai-prompt" style="display:none; align-items:flex-start;">
        <label>AI 提示詞：</label>
        <textarea id="dg-ai-prompt" rows="6" style="flex:1; width:100%;" placeholder="自訂 AI 批改提示詞"></textarea>
      </div>
      <div class="dg-actions">
        <button id="dg-run" class="btn-primary">識別並批改</button>
        <button id="dg-save" class="btn-secondary" disabled>保存結果</button>
        <button id="dg-history" class="btn-secondary">查看歷史</button>
        <div class="spacer"></div>
        <button id="dg-copy" class="btn-secondary" disabled>複製 Markdown</button>
        <button id="dg-export-csv" class="btn-secondary" disabled>下載 CSV</button>
      </div>
      <div class="dg-previews" id="dg-previews"></div>
      <div class="dg-result">
        <div id="dg-status" class="dg-status">請上傳或拍照後點擊「識別並批改」</div>
        <div id="dg-report" class="dg-report"></div>
      </div>
    </div>
  `;

  const file = wrap.querySelector('#dg-file');
  const takeBtn = wrap.querySelector('#dg-take-photo');
  const galleryBtn = wrap.querySelector('#dg-choose-gallery');
  const run = wrap.querySelector('#dg-run');
  const saveBtn = wrap.querySelector('#dg-save');
  const historyBtn = wrap.querySelector('#dg-history');
  const copyBtn = wrap.querySelector('#dg-copy');
  const exportBtn = wrap.querySelector('#dg-export-csv');
  const previews = wrap.querySelector('#dg-previews');
  const status = wrap.querySelector('#dg-status');
  const report = wrap.querySelector('#dg-report');
  const modelSelect = wrap.querySelector('#dg-model');
  const aiPromptEl = wrap.querySelector('#dg-ai-prompt');
  const modeLocal = wrap.querySelector('#dg-mode-local');
  const modeAI = wrap.querySelector('#dg-mode-ai');
  const aiPromptRow = wrap.querySelector('.dg-ai-prompt');

  const images = [];
  let lastMarkdown = '';

  // 初始化模型清單
  try { populateModelOptions(modelSelect); } catch(_) {}
  // 初始化 AI 提示詞；強制顯示 AI 模式（Markdown 版）
  aiPromptEl.value = defaultAIMarkdownPrompt();
  aiPromptRow.style.display = 'flex';
  try { modeAI.checked = true; } catch(_) {}

  // 快捷：拍照/相簿
  takeBtn.addEventListener('click', (e) => {
    e.preventDefault();
    try { file.setAttribute('capture', 'environment'); file.click(); setTimeout(() => file.removeAttribute('capture'), 0); } catch(_) {}
  });
  galleryBtn.addEventListener('click', (e) => {
    e.preventDefault();
    try { file.removeAttribute('capture'); file.click(); } catch(_) {}
  });
  file.addEventListener('change', async () => {
    images.splice(0, images.length);
    previews.innerHTML = '';
    const files = Array.from(file.files || []);
    for (const f of files) {
      if (!f.type || !f.type.startsWith('image/')) continue;
      const url = await readAsDataURL(f);
      const downsized = await downscale(url, 1600, 1600, 0.9);
      images.push(downsized || url);
      const img = document.createElement('img');
      img.src = url; img.alt = f.name; img.style.maxWidth = '100%'; img.style.maxHeight = '120px'; img.style.objectFit = 'contain';
      const cell = document.createElement('div'); cell.appendChild(img); previews.appendChild(cell);
    }
    status.textContent = images.length ? `已選擇 ${images.length} 張圖片` : '尚未選擇圖片';
  });

  // 點擊縮圖查看大圖（簡易 lightbox）
  previews.addEventListener('click', (e) => {
    const img = e.target && e.target.tagName === 'IMG' ? e.target : null;
    if (!img) return;
    const overlay = document.createElement('div');
    overlay.className = 'lightbox-overlay';
    overlay.innerHTML = `<img src="${img.src}" alt="preview">`;
    overlay.addEventListener('click', () => overlay.remove());
    document.body.appendChild(overlay);
  });

  run.addEventListener('click', async () => {
    if (!images.length) { status.textContent = '請先上傳或拍照'; return; }
    status.textContent = '正在識別與批改...'; report.innerHTML = '';
    try {
      const model = modelSelect && modelSelect.value ? modelSelect.value : undefined;
      const prompt = (aiPromptEl.value || defaultAIMarkdownPrompt());
      const md = await api.aiGradeHandwriting(images, expected, { model, prompt, format: 'markdown' });
      lastMarkdown = md || '';
      renderMarkdownReport(report, lastMarkdown);
      status.textContent = '批改完成（AI）';
      saveBtn.disabled = !lastMarkdown;
      copyBtn.disabled = !lastMarkdown;
      exportBtn.disabled = !lastMarkdown;
    } catch (e) {
      status.textContent = '處理失敗：' + (e?.message || e);
    }
  });

  saveBtn.addEventListener('click', () => {
    if (!lastMarkdown) { alert('沒有可保存的結果'); return; }
    const thumb = previews.querySelector('img')?.src || '';
    const rec = storage.saveGradingRecord({
      type: 'dictation-ai-grading',
      model: modelSelect && modelSelect.value ? modelSelect.value : '',
      markdown: lastMarkdown,
      thumbnail: thumb,
      imagesCount: images.length,
      wordsCount: expected.length
    });
    status.textContent = `已保存：${new Date(rec.createdAt).toLocaleString()}`;
  });

  historyBtn.addEventListener('click', openHistory);

  copyBtn.addEventListener('click', async () => {
    if (!lastMarkdown) return;
    const ok = await copyToClipboard(lastMarkdown);
    status.textContent = ok ? '已複製 Markdown 到剪貼簿' : '複製失敗，請手動選取';
  });

  exportBtn.addEventListener('click', () => {
    if (!lastMarkdown) return;
    const csv = markdownFirstTableToCsv(lastMarkdown);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `grading-${Date.now()}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  });

  function openHistory() {
    const list = storage.getGradingHistory();
    const box = document.createElement('div');
    box.className = 'dg-history';
    if (!list.length) { box.innerHTML = '<p>尚無歷史記錄。</p>'; show(box); return; }
    const items = list.map(it => {
      const t = new Date(it.createdAt).toLocaleString();
      return `<div class="dg-h-item" data-id="${it.id}">
        <img src="${it.thumbnail || ''}" alt="thumb">
        <div class="meta">
          <div class="time">${t}</div>
          <div class="sub">模型：${it.model || '-'} · 圖片：${it.imagesCount || 0} · 詞表：${it.wordsCount || 0}</div>
        </div>
        <div class="ops">
          <button data-act="view">查看</button>
          <button data-act="del">刪除</button>
        </div>
      </div>`;
    }).join('');
    box.innerHTML = `<div class="dg-h-toolbar"><button id="dg-h-clear" class="btn-secondary">清空全部</button></div><div class="dg-h-list">${items}</div>`;
    box.addEventListener('click', (e) => {
      const btn = e.target.closest('button'); if (!btn) return;
      const item = e.target.closest('.dg-h-item'); if (!item) return;
      const id = item.getAttribute('data-id');
      const rec = list.find(x => x.id === id);
      if (!rec) return;
      const act = btn.getAttribute('data-act');
      if (btn.id === 'dg-h-clear') {
        if (confirm('確定清空全部歷史？此操作不可撤回')) { storage.clearGradingHistory(); openHistory(); }
      } else if (act === 'view') {
        report.innerHTML = '';
        renderMarkdownReport(report, rec.markdown || '');
        status.textContent = `查看記錄：${new Date(rec.createdAt).toLocaleString()}`;
        ui.openModal(); // 確保可見
      } else if (act === 'del') {
        if (confirm('確定刪除此記錄？')) { storage.deleteGradingRecord(id); openHistory(); }
      }
    });
    show(box);

    function show(content) {
      dom.modalTitle.textContent = '批改歷史';
      dom.modalBody.innerHTML = '';
      dom.modalBody.appendChild(content);
      ui.openModal();
      try { document.querySelector('#app-modal .modal-content')?.classList.add('modal-large'); } catch(_) {}
    }
  }

  // 預先載入預期清單摘要
  const expectedList = document.createElement('div');
  expectedList.className = 'dg-expected';
  expectedList.textContent = `當前對照單詞 ${expected.length} 個`;
  wrap.prepend(expectedList);

  return wrap;
}

function renderReport(container, data) {
  const rows = [];
  const pad = (s) => (s == null ? '' : String(s));
  const esc = (s) => pad(s);
  for (const r of data.rows) {
    rows.push(`<tr class="${r.ok ? 'ok' : 'err'}"><td>${esc(r.expected)}</td><td>${esc(r.recognized)}</td><td>${esc(r.meaning || '')}</td><td>${r.ok ? '正確' : '錯誤 → 建議：' + esc(r.suggest)}</td></tr>`);
  }
  container.innerHTML = `
    <table class="dg-table">
      <thead><tr><th>標準答案</th><th>書寫內容</th><th>中文（參考）</th><th>結果</th></tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table>
  `;
}

function normalizeAIGrading(result) {
  // 期望 result 為 { items: [{line, english, chinese, correct, errors:[{type,expected,got,suggestion}]}], summary:{total,correct,wrong} }
  const items = Array.isArray(result?.items) ? result.items : [];
  const rows = [];
  let correct = 0;
  for (const it of items) {
    const ok = !!it?.correct;
    if (ok) correct += 1;
    const errs = Array.isArray(it?.errors) ? it.errors : [];
    const msg = ok ? '正確' : ('錯誤 → ' + errs.map(e => `建議：${e?.suggestion || e?.expected || ''}`).join('；'));
    rows.push({
      expected: (errs[0]?.expected) || '',
      recognized: it?.line || it?.english || '',
      meaning: it?.chinese || '',
      ok,
      suggest: errs[0]?.suggestion || errs[0]?.expected || ''
    });
  }
  return { rows, correct, total: items.length, errors: rows.filter(r => !r.ok) };
}

function defaultAIMarkdownPrompt() {
  return [
    '這是一張（或多張）學生默寫單詞的相片，和正確答案。識別時請忽略手寫劃掉的詞字。要檢查英文和中文是否有寫錯',
    '請逐行擷取學生書寫的英文單詞或短語（保留順序與原始大小寫），若同一行寫了中文意思也一併擷取。',
    '默寫順序可能是亂序；請無視順序，將每一行與提供的「標準詞表」比對：英文拼寫是否正確；若有書寫中文， 檢查中文是否書寫正確，包括錯別字提醒。',
    '請以 Markdown 回覆：',
    '1) 文首一行輸出：`批改完成（AI）：正確 X/Y（錯誤 Z）`；',
    '2) 其後用 Markdown 表格輸出詳情，表頭為：`書寫內容 | 結果`；',
    '   - 結果欄：若正確，請寫「正確」（可加粗）；若錯誤，請以「**錯誤** → 英文...中文...」醒目標註，指出英文或中文錯因與修正。',
    '3) 不要輸出多餘說明或程式碼框。'
  ].join('\n');
}

function renderMarkdownReport(container, markdown) {
  container.innerHTML = markdownToHtml(markdown);
  // 醒目標註：將結果欄含「錯誤」的列加上 err，含「正確」的列加上 ok
  try {
    const tables = container.querySelectorAll('table.dg-table');
    tables.forEach(t => {
      t.querySelectorAll('tbody tr').forEach(tr => {
        const last = tr.querySelector('td:last-child');
        if (!last) return;
        const txt = last.textContent || '';
        if (/錯誤/.test(txt)) {
          tr.classList.add('err');
          last.innerHTML = last.innerHTML.replace(/錯誤/g, '<strong class="dg-bad">錯誤</strong>');
        } else if (/正確/.test(txt)) {
          tr.classList.add('ok');
          last.innerHTML = last.innerHTML.replace(/正確/g, '<strong class="dg-good">正確</strong>');
        }
      });
    });
  } catch(_) {}
}

// 簡易 Markdown 轉 HTML（支援標題、粗體、斜體、行內程式碼、連結、表格）
function markdownToHtml(md) {
  const esc = (s) => String(s).replace(/[&<>]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[m]));
  const lines = String(md || '').split(/\r?\n/);
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // 表格：第二行為分隔線
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i+1])) {
      const rows = [line];
      i++;
      while (i < lines.length && lines[i].includes('|')) { rows.push(lines[i]); i++; }
      out.push(tableMarkdownToHtml(rows.join('\n')));
      continue;
    }
    const m = line.match(/^(#{1,6})\s+(.*)/);
    if (m) { out.push(`<h${m[1].length}>${inlineMd(m[2])}</h${m[1].length}>`); i++; continue; }
    if (!line.trim()) { out.push(''); i++; continue; }
    out.push(`<p>${inlineMd(line)}</p>`);
    i++;
  }
  return out.join('\n');

  function inlineMd(s) {
    return esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }
  function tableMarkdownToHtml(t) {
    const rows = t.trim().split(/\r?\n/).filter(Boolean);
    if (rows.length < 2) return `<pre>${esc(t)}</pre>`;
    const header = splitRow(rows[0]);
    const body = rows.slice(2).map(splitRow);
    const ths = header.map(h => `<th>${inlineMd(h)}</th>`).join('');
    const trs = body.map(cols => `<tr>${cols.map(c => `<td>${inlineMd(c)}</td>`).join('')}</tr>`).join('');
    return `<table class="dg-table"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`;
  }
  function splitRow(r) { return r.trim().replace(/^\|/,'').replace(/\|$/,'').split('|').map(s => s.trim()); }
}

async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove(); return ok;
  } catch (_) { return false; }
}

function markdownFirstTableToCsv(md) {
  const lines = String(md||'').split(/\r?\n/);
  // find a table block
  let i = 0; let start = -1; let end = -1;
  while (i < lines.length-1) {
    if (lines[i].includes('|') && /^\s*\|?\s*:?-{3,}/.test(lines[i+1]||'')) { start = i; i += 2; break; }
    i++;
  }
  if (start === -1) return '';
  const rows = [lines[start]];
  while (i < lines.length && lines[i].includes('|')) { rows.push(lines[i]); i++; }
  const splitRow = (r)=> r.trim().replace(/^\|/,'').replace(/\|$/,'').split('|').map(s=>s.trim());
  const header = splitRow(rows[0]);
  const body = rows.slice(2).map(splitRow);
  const csvEscape = (s)=> '"' + String(s).replace(/"/g,'""') + '"';
  const csvRows = [header.map(csvEscape).join(',')];
  for (const cols of body) { csvRows.push(cols.map(csvEscape).join(',')); }
  return csvRows.join('\n');
}

function populateModelOptions(selectEl) {
  if (!selectEl) return;
  const saved = loadSavedModel();
  const models = Array.isArray(OCR_CONFIG?.MODELS) && OCR_CONFIG.MODELS.length
    ? OCR_CONFIG.MODELS
    : [OCR_CONFIG?.DEFAULT_MODEL || OCR_CONFIG?.MODEL || 'gpt-4o-mini'];
  selectEl.innerHTML = '';
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m; opt.textContent = m;
    selectEl.appendChild(opt);
  }
  selectEl.value = saved || (OCR_CONFIG?.DEFAULT_MODEL || OCR_CONFIG?.MODEL || models[0]);
  selectEl.addEventListener('change', () => {
    try { localStorage.setItem('ocr.model', selectEl.value); } catch(_) {}
  });
}

function loadSavedModel() {
  try { return localStorage.getItem('ocr.model') || ''; } catch(_) { return ''; }
}

function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = (e) => reject(e);
    fr.readAsDataURL(file);
  });
}

function downscale(dataUrl, maxW = 1600, maxH = 1600, quality = 0.9) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      const ratio = Math.min(maxW / width, maxH / height, 1);
      if (ratio < 1) { width = Math.round(width * ratio); height = Math.round(height * ratio); }
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      try { resolve(canvas.toDataURL('image/jpeg', quality)); } catch(_) { resolve(dataUrl); }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

function gradeDictation(expectedWords, ocrText, opts = {}) {
  const { strict = false, includeMeaning = true } = opts;
  const expected = expectedWords.map(w => ({
    word: (w.word || '').toString().trim(),
    meaning: (w.meaning || '').toString().trim()
  })).filter(w => w.word);
  const expectedMap = Object.create(null);
  for (const e of expected) {
    const key = e.word.toLowerCase();
    if (!expectedMap[key]) expectedMap[key] = e; // 保留第一個
  }

  const lines = String(ocrText || '').split(/\r?\n+/).map(s => s.trim()).filter(Boolean);
  const recog = lines.map(line => ({ raw: line, token: extractWordToken(line) })).filter(x => x.token);

  const rows = [];
  let correct = 0;
  for (const r of recog) {
    const key = strict ? r.token : r.token.toLowerCase();
    const match = strict ? expected.find(e => e.word === r.token) : expectedMap[key];
    if (match) {
      rows.push({ expected: match.word, recognized: r.raw, meaning: includeMeaning ? match.meaning : '', ok: true, suggest: '' });
      correct += 1;
    } else {
      const sug = suggestClosest(r.token, expected.map(x => x.word));
      const m = expected.find(e => e.word.toLowerCase() === sug.toLowerCase());
      rows.push({ expected: m ? m.word : '', recognized: r.raw, meaning: includeMeaning && m ? m.meaning : '', ok: false, suggest: sug });
    }
  }

  return { rows, correct, total: recog.length, errors: rows.filter(r => !r.ok) };
}

function extractWordToken(line) {
  // 取出行中的英文字母序列（忽略標點數字），保留第一個詞
  const m = line.match(/[A-Za-z]+(?:'[A-Za-z]+)?/);
  return m ? m[0] : '';
}

function wordsEqual(a, b, strict) {
  if (strict) return a === b;
  return a.toLowerCase() === b.toLowerCase();
}

function suggestClosest(token, candidates) {
  let best = ''; let bestD = Infinity;
  for (const c of candidates) {
    const d = levenshtein(token.toLowerCase(), c.toLowerCase());
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}
