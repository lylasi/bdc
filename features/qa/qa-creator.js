// 問答集創建和格式解析
import { saveQASet } from './qa-storage.js';
import { displayMessage, confirmAction } from '../../modules/ui.js';
import { t } from '../../modules/i18n.js';

// Q1:A1格式解析（只回傳配對；需要知道有沒有內容被丟棄時請用 analyzeQAPairs）
export function parseQAPairs(text) {
  return analyzeQAPairs(text).pairs;
}

/**
 * 解析問答對，並回報「有內容但沒有被採用」的部分。
 *
 * 兩種格式都可能丟掉內容，兩種都要回報：
 *  1. 編號格式（Q1:/A1:）—— 只有 Q 沒有 A（或 A 是空的）的題目先前直接被跳過。
 *  2. 每兩行一組的格式 —— 最後只剩一行時不會進入 pairs。
 * 先前這裡是靜默跳過，使用者按「保存」只看到「保存成功」，輸入的內容卻已經消失。
 * 改為把被丟棄的內容一併回報，由介面顯示警告。
 *
 * @returns {{ pairs: Array, warnings: Array<{key: string, params?: Object}> }}
 */
export function analyzeQAPairs(text) {
  if (!text || typeof text !== 'string') return { pairs: [], warnings: [] };

  // 標準化換行
  const normalized = text.replace(/\r\n?/g, '\n');

  // 先嘗試舊格式：Q1: ... A1: ...
  const legacy = parseLegacyFormat(normalized);
  if (legacy.pairs.length > 0) return legacy;

  // 新格式：每兩行為一組（第一行=問題，第二行=答案），可夾雜空行
  const lines = normalized
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0);

  const pairs = [];
  const warnings = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const q = stripLeadingLabel(lines[i]);
    const a = stripLeadingLabel(lines[i + 1]);
    if (q && a) pairs.push({ qid: pairs.length + 1, question: q, answer: a });
  }

  if (lines.length % 2 === 1) {
    const orphan = stripLeadingLabel(lines[lines.length - 1]);
    const isAnswerLike = /^(a|ans|answer)\s*\d*\s*:/i.test(lines[lines.length - 1]);
    warnings.push({
      key: isAnswerLike ? 'qa.orphanAnswerWarning' : 'qa.orphanQuestionWarning',
      params: { line: clipForWarning(orphan) }
    });
  }

  // 兩行格式也沒解析出東西時，保留編號格式找到的問題（例如整份只有 Q 沒有 A）
  if (pairs.length === 0 && legacy.warnings.length) {
    return { pairs, warnings: legacy.warnings };
  }

  return { pairs, warnings };
}

/** 警告訊息只帶一小段原文，避免整篇內容塞進提示 */
function clipForWarning(text, max = 60) {
  const value = String(text || '').trim().replace(/\s+/g, ' ');
  return value.length > max ? value.slice(0, max) + '…' : value;
}

/**
 * 編號格式解析。
 *
 * 這裡不再「解析出一組就當作整份都合法」：正式的 Q/A 配對之外，
 * 尾端沒有被任何配對消耗的內容（例如最後一題只有 Q 沒有 A）也要回報，
 * 否則使用者貼上的內容會靜默消失。
 *
 * @returns {{ pairs: Array, warnings: Array<{key: string, params?: Object}> }}
 */
function parseLegacyFormat(text) {
  const cleanText = text.trim().replace(/\n\s*\n/g, '\n');
  const regex = /Q(\d+):\s*(.*?)\s*A\1:\s*(.*?)(?=Q\d+:|$)/gis;
  const pairs = [];
  const warnings = [];
  let m;
  let consumedUntil = 0;
  while ((m = regex.exec(cleanText)) !== null) {
    consumedUntil = regex.lastIndex;
    const qid = parseInt(m[1], 10);
    const rawQuestion = m[2].trim();
    const rawAnswer = m[3].trim();
    const question = stripLeadingLabel(rawQuestion);
    const answer = stripLeadingLabel(rawAnswer);
    if (question && answer) {
      pairs.push({ qid, question, answer });
    } else if (question) {
      // 有 Q 但沒有 A（或 A 只有空白）：先前直接丟掉，這裡要讓使用者知道
      warnings.push({ key: 'qa.numberedMissingAnswerWarning', params: { line: clipForWarning(question) } });
    } else {
      warnings.push({ key: 'qa.numberedEmptyQuestionWarning', params: { line: clipForWarning(rawAnswer) } });
    }
  }

  // 尾端殘留：最後一題只寫了 Q1: 而沒有任何 A1:
  const leftover = cleanText.slice(consumedUntil).trim();
  if (leftover) {
    const isAnswerLike = /^(a|ans|answer)\s*\d*\s*:/i.test(leftover);
    warnings.push({
      key: isAnswerLike ? 'qa.orphanAnswerWarning' : 'qa.orphanQuestionWarning',
      params: { line: clipForWarning(stripLeadingLabel(leftover)) }
    });
  }

  return {
    pairs: pairs.sort((a, b) => a.qid - b.qid).map((p, i) => ({ ...p, qid: i + 1 })),
    warnings
  };
}

function stripLeadingLabel(s) {
  // 去除可能的前綴：Q:, Q1:, A:, A1:
  return s.replace(/^([QA])(\d+)?\s*:\s*/i, '').trim();
}

// 驗證解析結果
export function validateFormat(pairs) {
  const errors = [];

  if (!Array.isArray(pairs) || pairs.length === 0) {
    errors.push(t('qa.noValidPairs'));
    return { isValid: false, errors };
  }

  // 檢查qid是否連續
  const qids = pairs.map(p => p.qid).sort((a, b) => a - b);
  const expectedQids = Array.from({ length: qids.length }, (_, i) => i + 1);

  if (!qids.every((qid, index) => qid === expectedQids[index])) {
    errors.push(t('qa.qidShouldStartAtOne'));
  }

  // 檢查重複的qid
  const uniqueQids = new Set(qids);
  if (uniqueQids.size !== qids.length) {
    errors.push(t('qa.duplicateQid'));
  }

  // 檢查空內容
  pairs.forEach(pair => {
    if (!pair.question || pair.question.trim() === '') {
      errors.push(t('qa.qidQuestionEmpty', { qid: pair.qid }));
    }
    if (!pair.answer || pair.answer.trim() === '') {
      errors.push(t('qa.qidAnswerEmpty', { qid: pair.qid }));
    }
  });

  return {
    isValid: errors.length === 0,
    errors: errors,
    warnings: []
  };
}

// 生成預覽HTML
export function generatePreviewHTML(pairs, warnings = []) {
  const warningHtml = (Array.isArray(warnings) && warnings.length)
    ? `<div class="validation-warnings"><ul>${
        warnings.map(w => `<li class="warning">${escapeHtml(t(w.key, w.params || {}))}</li>`).join('')
      }</ul></div>`
    : '';

  if (!pairs || pairs.length === 0) {
    return `${warningHtml}<p class="preview-empty">${t('qa.previewEmpty')}</p>`;
  }

  const validation = validateFormat(pairs);
  let html = '';

  // 顯示驗證結果
  if (!validation.isValid) {
    html += '<div class="validation-errors">';
    html += `<h5>${t('qa.formatErrors')}</h5>`;
    html += '<ul>';
    validation.errors.forEach(error => {
      html += `<li class="error">${error}</li>`;
    });
    html += '</ul>';
    html += '</div>';
  } else {
    html += '<div class="validation-success">';
    html += `<p class="success">${t('qa.parsedPairs', { count: pairs.length })}</p>`;
    html += '</div>';
  }

  // 有內容沒被採用的警告（例如落單的最後一行）
  html += warningHtml;

  // 取消浮動提示，保持畫面緊湊（提示文案移除）

  // 顯示問答對預覽（可直接編輯、複製、刪除）
  html += '<div class="qa-pairs-preview">';
  pairs.forEach((pair) => {
    html += `
      <div class="qa-pair-preview ${validation.isValid ? 'valid' : 'invalid'}" data-qid="${pair.qid}">
        <div class="qa-pair-header">
          <div class="qa-header-left">
            <span class="qa-qid-badge">${pair.qid}</span>
            <span class="qa-drag-handle" draggable="true" title="${t('qa.dragToSort')}" aria-label="${t('qa.dragToSort')}">⠿</span>
          </div>
          <div class="qa-pair-toolbar">
            <button type="button" class="qa-chip-btn qa-copy-pair" data-qid="${pair.qid}">${t('qa.copy')}</button>
            <button type="button" class="qa-chip-btn qa-move-up" data-qid="${pair.qid}">${t('qa.moveUp')}</button>
            <button type="button" class="qa-chip-btn qa-move-down" data-qid="${pair.qid}">${t('qa.moveDown')}</button>
            <button type="button" class="qa-chip-btn danger qa-delete-pair" data-qid="${pair.qid}">${t('qa.delete')}</button>
          </div>
        </div>
        <div class="qa-question">
          <span class="qa-label">Q</span>
          <div class="qa-editable" contenteditable="true" tabindex="0" data-role="question" aria-label="${t('qa.editQuestionAria', { qid: pair.qid })}">${escapeHtml(pair.question)}</div>
        </div>
        <div class="qa-answer">
          <span class="qa-label">A</span>
          <div class="qa-editable" contenteditable="true" tabindex="0" data-role="answer" aria-label="${t('qa.editAnswerAria', { qid: pair.qid })}">${escapeHtml(pair.answer)}</div>
        </div>
      </div>
    `;
  });
  html += '</div>';
  html += `<button type="button" class="qa-add-pair-btn" id="qa-add-pair-btn" title="${t('qa.addPair')}">+</button>`;

  return html;
}

// 處理文本輸入變化
export function handleTextInputChange(textArea, previewContainer) {
  const text = textArea.value;
  const { pairs, warnings } = analyzeQAPairs(text);
  const previewHTML = generatePreviewHTML(pairs, warnings);

  if (previewContainer) {
    previewContainer.innerHTML = previewHTML;
    ensurePreviewInteractions(textArea, previewContainer);
  }

  return { pairs, warnings, isValid: validateFormat(pairs).isValid };
}

// 保存新問答集
export function saveNewSet(name, description, pairs, existingQASet = null) {
  try {
    // 驗證輸入
    if (!name || name.trim() === '') {
      throw new Error(t('qa.setNameRequired'));
    }

    if (!pairs || pairs.length === 0) {
      throw new Error(t('qa.needAtLeastOnePair'));
    }

    const validation = validateFormat(pairs);
    if (!validation.isValid) {
      throw new Error(t('qa.pairFormatError', { errors: validation.errors.join(', ') }));
    }

    const now = new Date().toISOString();
    let qaSet;

    if (existingQASet) {
      qaSet = {
        ...existingQASet,
        id: existingQASet.id,
        name: name.trim(),
        description: description.trim() || '',
        category: existingQASet.category || t('qa.customCategory'),
        difficulty: existingQASet.difficulty || 'unknown',
        creator: existingQASet.creator || t('qa.createdByUser'),
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
        category: t('qa.customCategory'),
        difficulty: 'unknown',
        creator: t('qa.createdByUser'),
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
      throw new Error(t('qa.createSetFailed'));
    }

  } catch (error) {
    console.error('保存問答集時出錯:', error);
    displayMessage(t('qa.saveFailed', { message: error.message }), 'error');
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

  const suffix = ` ${t('qa.copySuffix')}`;
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
  if (preview) preview.innerHTML = `<p class="preview-empty">${t('qa.previewEmpty')}</p>`;
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
    dynamicButton.textContent = t('qa.loadExample');
    dynamicButton.onclick = loadExample;

    const copyAllBtn = document.createElement('button');
    copyAllBtn.id = 'qa-copy-all-btn';
    copyAllBtn.type = 'button';
    copyAllBtn.className = 'btn small secondary';
    copyAllBtn.textContent = t('qa.copyAll');
    copyAllBtn.onclick = () => copyAllPairsToClipboard(pairsInput.value);

    const clearAllBtn = document.createElement('button');
    clearAllBtn.id = 'qa-clear-all-btn';
    clearAllBtn.type = 'button';
    clearAllBtn.className = 'btn small secondary';
    clearAllBtn.textContent = t('qa.clearAll');
    clearAllBtn.onclick = async () => {
      const confirmed = await confirmAction({
        title: t('qa.clearAll'),
        message: t('qa.confirmClearPairs'),
        confirmLabel: t('qa.clearAll'),
        cancelLabel: t('common.cancel'),
        danger: true
      });
      if (confirmed) {
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
      const confirmed = await confirmAction({
        title: t('qa.delete'),
        message: t('qa.confirmDeleteQuestion', { number: qid }),
        confirmLabel: t('qa.delete'),
        cancelLabel: t('common.cancel'),
        danger: true
      });
      if (!confirmed) return;
      const pairs = parseQAPairs(textArea.value);
      const filtered = normalizeQids(pairs.filter(p => p.qid !== qid));
      textArea.value = pairsToText(filtered);
      handleTextInputChange(textArea, previewContainer);
      displayMessage(t('qa.pairDeleted'), 'success');
      return;
    }

    if (copyBtn) {
      const qid = parseInt(copyBtn.dataset.qid || copyBtn.closest('.qa-pair-preview')?.dataset.qid, 10);
      const pairs = parseQAPairs(textArea.value);
      const p = pairs.find(x => x.qid === qid);
      if (p) {
        const text = `${p.question}\n${p.answer}`;
        await writeToClipboard(text);
        displayMessage(t('qa.pairCopied'), 'info');
      }
      return;
    }

    if (addBtn) {
      const pairs = parseQAPairs(textArea.value);
      const nextId = pairs.length + 1;
      const appended = `${textArea.value.trim()}${textArea.value.trim() ? '\n\n' : ''}${t('qa.newQuestion')}\n${t('qa.newAnswer')}`;
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
  displayMessage(t('qa.allPairsCopied'), 'info');
}
