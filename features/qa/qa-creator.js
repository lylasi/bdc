// 問答集創建和格式解析
import { saveQASet } from './qa-storage.js';
import { displayMessage } from '../../modules/ui.js';

// Q1:A1格式解析
export function parseQAPairs(text) {
  if (!text || typeof text !== 'string') return [];

  // 標準化換行
  const normalized = text.replace(/\r\n?/g, '\n');

  // 先嘗試舊格式：Q1: ... A1: ...
  const legacy = parseLegacyFormat(normalized);
  if (legacy.length > 0) return legacy;

  // 新格式：每兩行為一組（第一行=問題，第二行=答案），可夾雜空行
  const lines = normalized
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0);

  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const q = stripLeadingLabel(lines[i]);
    const a = stripLeadingLabel(lines[i + 1]);
    if (q && a) pairs.push({ qid: pairs.length + 1, question: q, answer: a });
  }
  return pairs;
}

function parseLegacyFormat(text) {
  const cleanText = text.trim().replace(/\n\s*\n/g, '\n');
  const regex = /Q(\d+):\s*(.*?)\s*A\1:\s*(.*?)(?=Q\d+:|$)/gis;
  const pairs = [];
  let m;
  while ((m = regex.exec(cleanText)) !== null) {
    const qid = parseInt(m[1], 10);
    const question = stripLeadingLabel(m[2].trim());
    const answer = stripLeadingLabel(m[3].trim());
    if (question && answer) pairs.push({ qid, question, answer });
  }
  return pairs.sort((a, b) => a.qid - b.qid).map((p, i) => ({ ...p, qid: i + 1 }));
}

function stripLeadingLabel(s) {
  // 去除可能的前綴：Q:, Q1:, A:, A1:
  return s.replace(/^([QA])(\d+)?\s*:\s*/i, '').trim();
}

// 驗證解析結果
export function validateFormat(pairs) {
  const errors = [];

  if (!Array.isArray(pairs) || pairs.length === 0) {
    errors.push('沒有找到有效的問答對');
    return { isValid: false, errors };
  }

  // 檢查qid是否連續
  const qids = pairs.map(p => p.qid).sort((a, b) => a - b);
  const expectedQids = Array.from({ length: qids.length }, (_, i) => i + 1);

  if (!qids.every((qid, index) => qid === expectedQids[index])) {
    errors.push('問題編號應該從1開始連續編號');
  }

  // 檢查重複的qid
  const uniqueQids = new Set(qids);
  if (uniqueQids.size !== qids.length) {
    errors.push('發現重複的問題編號');
  }

  // 檢查空內容
  pairs.forEach(pair => {
    if (!pair.question || pair.question.trim() === '') {
      errors.push(`Q${pair.qid} 的問題內容不能為空`);
    }
    if (!pair.answer || pair.answer.trim() === '') {
      errors.push(`A${pair.qid} 的答案內容不能為空`);
    }
  });

  return {
    isValid: errors.length === 0,
    errors: errors,
    warnings: []
  };
}

// 生成預覽HTML
export function generatePreviewHTML(pairs) {
  if (!pairs || pairs.length === 0) {
    return '<p class="preview-empty">請輸入：每兩行為一組（第一行為問題，第二行為答案）</p>';
  }

  const validation = validateFormat(pairs);
  let html = '';

  // 顯示驗證結果
  if (!validation.isValid) {
    html += '<div class="validation-errors">';
    html += '<h5>格式錯誤：</h5>';
    html += '<ul>';
    validation.errors.forEach(error => {
      html += `<li class="error">${error}</li>`;
    });
    html += '</ul>';
    html += '</div>';
  } else {
    html += '<div class="validation-success">';
    html += `<p class="success">✅ 成功解析 ${pairs.length} 個問答對</p>`;
    html += '</div>';
  }

  // 取消浮動提示，保持畫面緊湊（提示文案移除）

  // 顯示問答對預覽（可直接編輯、複製、刪除）
  html += '<div class="qa-pairs-preview">';
  pairs.forEach((pair) => {
    html += `
      <div class="qa-pair-preview ${validation.isValid ? 'valid' : 'invalid'}" data-qid="${pair.qid}">
        <div class="qa-pair-header">
          <div class="qa-header-left">
            <span class="qa-qid-badge">${pair.qid}</span>
            <span class="qa-drag-handle" draggable="true" title="拖拽排序" aria-label="拖拽排序">⠿</span>
          </div>
          <div class="qa-pair-toolbar">
            <button type="button" class="qa-chip-btn qa-copy-pair" data-qid="${pair.qid}">複製</button>
            <button type="button" class="qa-chip-btn qa-move-up" data-qid="${pair.qid}">上移</button>
            <button type="button" class="qa-chip-btn qa-move-down" data-qid="${pair.qid}">下移</button>
            <button type="button" class="qa-chip-btn danger qa-delete-pair" data-qid="${pair.qid}">刪除</button>
          </div>
        </div>
        <div class="qa-question">
          <span class="qa-label">Q:</span>
          <div class="qa-editable" contenteditable="true" tabindex="0" data-role="question" aria-label="編輯問題 Q${pair.qid}">${escapeHtml(pair.question)}</div>
        </div>
        <div class="qa-answer">
          <span class="qa-label">A:</span>
          <div class="qa-editable" contenteditable="true" tabindex="0" data-role="answer" aria-label="編輯答案 A${pair.qid}">${escapeHtml(pair.answer)}</div>
        </div>
      </div>
    `;
  });
  html += '</div>';
  html += '<button type="button" class="qa-add-pair-btn" id="qa-add-pair-btn" title="新增問答">+</button>';

  return html;
}

// 處理文本輸入變化
export function handleTextInputChange(textArea, previewContainer) {
  const text = textArea.value;
  const pairs = parseQAPairs(text);
  const previewHTML = generatePreviewHTML(pairs);

  if (previewContainer) {
    previewContainer.innerHTML = previewHTML;
    ensurePreviewInteractions(textArea, previewContainer);
  }

  return { pairs, isValid: validateFormat(pairs).isValid };
}

// 保存新問答集
export function saveNewSet(name, description, pairs, existingQASet = null) {
  try {
    // 驗證輸入
    if (!name || name.trim() === '') {
      throw new Error('問答集名稱不能為空');
    }

    if (!pairs || pairs.length === 0) {
      throw new Error('至少需要一個問答對');
    }

    const validation = validateFormat(pairs);
    if (!validation.isValid) {
      throw new Error('問答對格式錯誤：' + validation.errors.join(', '));
    }

    const now = new Date().toISOString();
    let qaSet;

    if (existingQASet) {
      qaSet = {
        ...existingQASet,
        id: existingQASet.id,
        name: name.trim(),
        description: description.trim() || '',
        category: existingQASet.category || '自定義',
        difficulty: existingQASet.difficulty || 'unknown',
        creator: existingQASet.creator || '用戶創建',
        createdAt: existingQASet.createdAt || now,
        updatedAt: now,
        questions: pairs.map(pair => ({
          qid: pair.qid,
          question: pair.question.trim(),
          answer: pair.answer.trim()
        }))
      };
    } else {
      // 生成唯一ID
      const id = generateQASetId(name);

      qaSet = {
        id: id,
        name: name.trim(),
        description: description.trim() || '',
        category: '自定義',
        difficulty: 'unknown',
        creator: '用戶創建',
        createdAt: now,
        updatedAt: now,
        questions: pairs.map(pair => ({
          qid: pair.qid,
          question: pair.question.trim(),
          answer: pair.answer.trim()
        }))
      };
    }

    // 保存問答集
    if (saveQASet(qaSet)) {
      console.log('問答集保存成功:', qaSet.name);
      return qaSet;
    } else {
      throw new Error('保存問答集失敗');
    }

  } catch (error) {
    console.error('保存問答集時出錯:', error);
    displayMessage('保存失敗: ' + error.message, 'error');
    return null;
  }
}

// 生成問答集ID
function generateQASetId(name) {
  // 基於名稱和時間戳生成唯一ID
  const timestamp = Date.now();
  const nameSlug = name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');

  return `qa_custom_${nameSlug}_${timestamp}`;
}

// HTML轉義函數
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// 為範本載入生成易辨識名稱
function generateTemplateName(baseName = '') {
  if (!baseName) return '';

  const suffix = ' (複本)';
  return baseName.endsWith(suffix) ? baseName : `${baseName}${suffix}`;
}

// 生成示例文本
export function generateExampleText() {
  // 簡化格式：每兩行為一組（Q 在前、A 在後），中間可留空行
  return `What's your name?
My name is Alex.

How old are you?
I am twelve years old.

Where are you from?
I am from Taiwan.

What is your favorite color?
My favorite color is blue.

How do you go to school?
I go to school by bus.

What time do you get up?
I get up at seven o'clock.

What do you like to do after school?
I like to play basketball with my friends.

What do you want to be in the future?
I want to be a teacher.`;
}

// 清空表單
export function clearForm() {
  const nameInput = document.getElementById('qa-set-name');
  const descInput = document.getElementById('qa-set-description');
  const pairsInput = document.getElementById('qa-pairs-input');
  const preview = document.getElementById('qa-preview');

  if (nameInput) nameInput.value = '';
  if (descInput) descInput.value = '';
  if (pairsInput) pairsInput.value = '';
  if (preview) preview.innerHTML = '<p class="preview-empty">請輸入：每兩行一組（第一行為問題，第二行為答案）</p>';
}

// 載入示例
export function loadExample() {
  const pairsInput = document.getElementById('qa-pairs-input');
  const preview = document.getElementById('qa-preview');

  if (pairsInput) {
    pairsInput.value = generateExampleText();

    // 觸發預覽更新
    if (preview) {
      handleTextInputChange(pairsInput, preview);
    }
  }
}

// 初始化創建器界面
export function initCreator() {
  console.log('初始化問答集創建器...');

  const pairsInput = document.getElementById('qa-pairs-input');
  const preview = document.getElementById('qa-preview');

  if (pairsInput && preview) {
    if (!pairsInput.dataset.previewListenerAttached) {
      // 實時預覽（僅綁定一次）
      pairsInput.addEventListener('input', () => {
        handleTextInputChange(pairsInput, preview);
      });
      pairsInput.dataset.previewListenerAttached = 'true';
    }

    // 初始化預覽
    handleTextInputChange(pairsInput, preview);
    ensurePreviewInteractions(pairsInput, preview);
  }

  // 添加示例按鈕（如果需要）
  addExampleButton();
}

// 根據問答集填入表單
export function fillFormWithQASet(qaSet, options = {}) {
  const { treatAsTemplate = false } = options;

  if (!qaSet) return;

  const nameInput = document.getElementById('qa-set-name');
  const descInput = document.getElementById('qa-set-description');
  const pairsInput = document.getElementById('qa-pairs-input');
  const preview = document.getElementById('qa-preview');

  if (!nameInput || !descInput || !pairsInput || !preview) {
    return;
  }

  const text = qaSetToText(qaSet);

  nameInput.value = treatAsTemplate ? generateTemplateName(qaSet.name) : (qaSet.name || '');
  descInput.value = qaSet.description || '';
  pairsInput.value = text;

  handleTextInputChange(pairsInput, preview);
}

export function qaSetToText(qaSet) {
  if (!qaSet) return '';

  const questions = Array.isArray(qaSet.questions) ? [...qaSet.questions] : [];
  questions.sort((a, b) => (a.qid || 0) - (b.qid || 0));

  return questions
    .map(q => `${q.question}\n${q.answer}`)
    .join('\n\n');
}

// 添加示例按鈕
function addExampleButton() {
  const button = document.getElementById('load-example-btn');
  if (!button) {
    const pairsInput = document.getElementById('qa-pairs-input');
    const container = document.querySelector('.qa-pairs-actions');
    if (!pairsInput || !container) return;

    const dynamicButton = document.createElement('button');
    dynamicButton.id = 'load-example-btn';
    dynamicButton.type = 'button';
    dynamicButton.className = 'btn small secondary';
    dynamicButton.textContent = '載入示例';
    dynamicButton.onclick = loadExample;

    const copyAllBtn = document.createElement('button');
    copyAllBtn.id = 'qa-copy-all-btn';
    copyAllBtn.type = 'button';
    copyAllBtn.className = 'btn small secondary';
    copyAllBtn.textContent = '複製全部';
    copyAllBtn.onclick = () => copyAllPairsToClipboard(pairsInput.value);

    const clearAllBtn = document.createElement('button');
    clearAllBtn.id = 'qa-clear-all-btn';
    clearAllBtn.type = 'button';
    clearAllBtn.className = 'btn small secondary';
    clearAllBtn.textContent = '清空全部';
    clearAllBtn.onclick = () => {
      if (confirm('確定要清空所有問答對嗎？')) {
        pairsInput.value = '';
        handleTextInputChange(pairsInput, document.getElementById('qa-preview'));
      }
    };

    container.appendChild(dynamicButton);
    container.appendChild(copyAllBtn);
    container.appendChild(clearAllBtn);
    return;
  }

  button.classList.remove('hidden');
  button.onclick = loadExample;
}

// 在預覽區提供互動：單題編輯/複製/刪除
function ensurePreviewInteractions(textArea, previewContainer) {
  if (!previewContainer || !textArea) return;
  if (previewContainer.dataset.interactiveBound === '1') return;
  previewContainer.dataset.interactiveBound = '1';

  // 提交編輯：在失焦或 Cmd/Ctrl+Enter 時同步到輸入框
  const commitEdited = (editableEl) => {
    const pairEl = editableEl.closest('.qa-pair-preview');
    if (!pairEl) return;
    const qid = parseInt(pairEl.dataset.qid, 10);
    const role = editableEl.dataset.role === 'answer' ? 'answer' : 'question';

    const pairs = parseQAPairs(textArea.value);
    const index = pairs.findIndex(p => p.qid === qid);
    if (index >= 0) {
      // 去掉前綴 Q/An，僅保留內容
      const raw = editableEl.textContent || '';
      const content = stripLeadingLabel(raw);
      pairs[index][role] = content;
      const normalized = normalizeQids(pairs);
      textArea.value = pairsToText(normalized);
      // 重新渲染預覽
      handleTextInputChange(textArea, previewContainer);
    }
  };

  previewContainer.addEventListener('blur', (e) => {
    const editable = e.target?.closest('[contenteditable="true"][data-role]');
    if (editable) {
      commitEdited(editable);
    }
  }, true);

  previewContainer.addEventListener('keydown', (e) => {
    const editable = e.target?.closest('[contenteditable="true"][data-role]');
    if (!editable) return;
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      editable.blur();
    }
  });

  previewContainer.addEventListener('click', async (e) => {
    const delBtn = e.target.closest('.qa-delete-pair');
    const copyBtn = e.target.closest('.qa-copy-pair');
    const addBtn = e.target.closest('#qa-add-pair-btn');
    const upBtn = e.target.closest('.qa-move-up');
    const downBtn = e.target.closest('.qa-move-down');

    if (delBtn) {
      const qid = parseInt(delBtn.dataset.qid || delBtn.closest('.qa-pair-preview')?.dataset.qid, 10);
      if (!qid) return;
      if (!confirm(`刪除第 ${qid} 題？`)) return;
      const pairs = parseQAPairs(textArea.value);
      const filtered = normalizeQids(pairs.filter(p => p.qid !== qid));
      textArea.value = pairsToText(filtered);
      handleTextInputChange(textArea, previewContainer);
      displayMessage('已刪除該問答對', 'success');
      return;
    }

    if (copyBtn) {
      const qid = parseInt(copyBtn.dataset.qid || copyBtn.closest('.qa-pair-preview')?.dataset.qid, 10);
      const pairs = parseQAPairs(textArea.value);
      const p = pairs.find(x => x.qid === qid);
      if (p) {
        const text = `${p.question}\n${p.answer}`;
        await writeToClipboard(text);
        displayMessage('已複製該題到剪貼簿', 'info');
      }
      return;
    }

    if (addBtn) {
      const pairs = parseQAPairs(textArea.value);
      const nextId = pairs.length + 1;
      const appended = `${textArea.value.trim()}${textArea.value.trim() ? '\n\n' : ''}（請輸入問題）\n（請輸入答案）`;
      textArea.value = appended;
      handleTextInputChange(textArea, previewContainer);
      // 聚焦到新題目
      setTimeout(() => {
        const target = previewContainer.querySelector(`.qa-pair-preview[data-qid="${nextId}"] [data-role="question"]`);
        if (target && target.focus) { target.scrollIntoView({ block: 'center' }); target.focus(); }
      }, 0);
      return;
    }

    // 觸控裝置排序備援：上移/下移
    if (upBtn || downBtn) {
      const pairs = parseQAPairs(textArea.value);
      const qid = parseInt((upBtn || downBtn).dataset.qid || (upBtn || downBtn).closest('.qa-pair-preview')?.dataset.qid, 10);
      const idx = pairs.findIndex(p => p.qid === qid);
      if (idx < 0) return;
      const delta = upBtn ? -1 : 1;
      const newIdx = idx + delta;
      if (newIdx < 0 || newIdx >= pairs.length) return;
      const [moved] = pairs.splice(idx, 1);
      pairs.splice(newIdx, 0, moved);
      const normalized = normalizeQids(pairs);
      textArea.value = pairsToText(normalized);
      handleTextInputChange(textArea, previewContainer);
      setTimeout(() => {
        const selector = `.qa-pair-preview[data-qid="${normalized[newIdx].qid}"]`;
        previewContainer.querySelector(selector)?.scrollIntoView({ block: 'center' });
      }, 0);
      return;
    }
  });

  // 拖拽排序
  let dragSrc = null;
  previewContainer.addEventListener('dragstart', (e) => {
    if (!e.target.closest('.qa-drag-handle')) return;
    const item = e.target.closest('.qa-pair-preview');
    if (!item) return;
    dragSrc = item;
    item.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', item.dataset.qid || ''); } catch(_) {}
  });
  previewContainer.addEventListener('dragend', (e) => {
    const item = e.target.closest('.qa-pair-preview');
    if (item) item.classList.remove('dragging');
    previewContainer.querySelectorAll('.drop-before,.drop-after').forEach(el=>el.classList.remove('drop-before','drop-after'));
    dragSrc = null;
  });
  previewContainer.addEventListener('dragover', (e) => {
    if (!dragSrc) return;
    e.preventDefault();
    const over = e.target.closest('.qa-pair-preview');
    if (!over || over === dragSrc) return;
    const rect = over.getBoundingClientRect();
    const before = (e.clientY - rect.top) < rect.height / 2;
    previewContainer.querySelectorAll('.drop-before,.drop-after').forEach(el=>el.classList.remove('drop-before','drop-after'));
    over.classList.add(before ? 'drop-before' : 'drop-after');
  });
  previewContainer.addEventListener('drop', (e) => {
    if (!dragSrc) return;
    e.preventDefault();
    const over = e.target.closest('.qa-pair-preview');
    if (!over || over === dragSrc) return;

    const pairs = parseQAPairs(textArea.value);
    const fromId = parseInt(dragSrc.dataset.qid, 10);
    const toId = parseInt(over.dataset.qid, 10);
    const fromIndex = pairs.findIndex(p => p.qid === fromId);
    const toIndex = pairs.findIndex(p => p.qid === toId);
    if (fromIndex < 0 || toIndex < 0) return;

    const [moved] = pairs.splice(fromIndex, 1);
    const rect = over.getBoundingClientRect();
    const before = (e.clientY - rect.top) < rect.height / 2;
    pairs.splice(before ? toIndex : toIndex + 1, 0, moved);

    const normalized = normalizeQids(pairs);
    textArea.value = pairsToText(normalized);
    handleTextInputChange(textArea, previewContainer);
  });
}

function pairsToText(pairs) {
  return pairs.map(p => `${p.question}\n${p.answer}`).join('\n\n');
}

function normalizeQids(pairs) {
  return pairs.map((p, i) => ({ ...p, qid: i + 1 }));
}

async function writeToClipboard(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) {}
  // Fallback
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try { document.execCommand('copy'); } catch(_) {}
  document.body.removeChild(ta);
  return true;
}

function copyAllPairsToClipboard(text) {
  if (!text) return;
  writeToClipboard(text);
  displayMessage('已複製全部問答對', 'info');
}
