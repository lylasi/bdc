// 問答集創建和格式解析
import { saveQASet } from './qa-storage.js';
import { displayMessage } from '../../modules/ui.js';

// Q1:A1格式解析
export function parseQAPairs(text) {
  if (!text || typeof text !== 'string') {
    return [];
  }

  // 清理文本，移除多餘的空白行
  const cleanText = text.trim().replace(/\n\s*\n/g, '\n');

  // 正則表達式匹配 Q數字: 問題內容 A數字: 答案內容
  const regex = /Q(\d+):\s*(.*?)\s*A\1:\s*(.*?)(?=Q\d+:|$)/gs;
  const pairs = [];
  let match;

  while ((match = regex.exec(cleanText)) !== null) {
    const qid = parseInt(match[1]);
    const question = match[2].trim();
    const answer = match[3].trim();

    if (question && answer) {
      pairs.push({
        qid: qid,
        question: question,
        answer: answer
      });
    }
  }

  // 按qid排序
  pairs.sort((a, b) => a.qid - b.qid);

  return pairs;
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
    return '<p class="preview-empty">請輸入Q1:A1格式的問答對</p>';
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

  // 顯示問答對預覽
  html += '<div class="qa-pairs-preview">';
  pairs.forEach((pair, index) => {
    html += `
      <div class="qa-pair-preview ${validation.isValid ? 'valid' : 'invalid'}">
        <div class="qa-question">
          <strong>Q${pair.qid}:</strong> ${escapeHtml(pair.question)}
        </div>
        <div class="qa-answer">
          <strong>A${pair.qid}:</strong> ${escapeHtml(pair.answer)}
        </div>
      </div>
    `;
  });
  html += '</div>';

  return html;
}

// 處理文本輸入變化
export function handleTextInputChange(textArea, previewContainer) {
  const text = textArea.value;
  const pairs = parseQAPairs(text);
  const previewHTML = generatePreviewHTML(pairs);

  if (previewContainer) {
    previewContainer.innerHTML = previewHTML;
  }

  return { pairs, isValid: validateFormat(pairs).isValid };
}

// 保存新問答集
export function saveNewSet(name, description, pairs) {
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

    // 生成唯一ID
    const id = generateQASetId(name);

    // 創建問答集對象
    const qaSet = {
      id: id,
      name: name.trim(),
      description: description.trim() || '',
      category: '自定義',
      difficulty: 'unknown',
      creator: '用戶創建',
      createdAt: new Date().toISOString(),
      questions: pairs.map(pair => ({
        qid: pair.qid,
        question: pair.question.trim(),
        answer: pair.answer.trim()
      }))
    };

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

// 生成示例文本
export function generateExampleText() {
  return `Q1: 什麼是JavaScript？
A1: JavaScript是一種高級的、動態的程式設計語言，主要用於網頁開發。

Q2: HTML代表什麼？
A2: HTML代表超文本標記語言（HyperText Markup Language），用於創建網頁結構。

Q3: CSS的主要用途是什麼？
A3: CSS（層疊樣式表）主要用於控制網頁的外觀和佈局，包括顏色、字體、間距等視覺樣式。

Q4: 什麼是響應式設計？
A4: 響應式設計是一種網頁設計方法，使網站能夠在不同設備和螢幕尺寸上都能良好顯示和運作。`;
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
  if (preview) preview.innerHTML = '<p class="preview-empty">請輸入Q1:A1格式的問答對</p>';
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
    // 實時預覽
    pairsInput.addEventListener('input', () => {
      handleTextInputChange(pairsInput, preview);
    });

    // 初始化預覽
    handleTextInputChange(pairsInput, preview);
  }

  // 添加示例按鈕（如果需要）
  addExampleButton();
}

// 添加示例按鈕
function addExampleButton() {
  const pairsInput = document.getElementById('qa-pairs-input');
  if (!pairsInput) return;

  // 檢查是否已經有示例按鈕
  if (document.getElementById('load-example-btn')) return;

  // 創建示例按鈕
  const button = document.createElement('button');
  button.id = 'load-example-btn';
  button.type = 'button';
  button.className = 'btn small secondary';
  button.textContent = '載入示例';
  button.onclick = loadExample;

  // 插入到文本框後面
  const parent = pairsInput.parentElement;
  if (parent) {
    const label = parent.querySelector('label[for="qa-pairs-input"]');
    if (label) {
      button.style.marginLeft = '10px';
      label.appendChild(button);
    }
  }
}