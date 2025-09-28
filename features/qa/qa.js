// 問答訓練模組主入口
import * as dom from '../../modules/dom.js';
import * as state from '../../modules/state.js';
import { getStoredQASets, getAllQASets, loadQASet, saveQASet, deleteQASet, importQASet, exportQASet, getQASetStats, cleanupExpiredCache } from './qa-storage.js';
import { initCreator, parseQAPairs, saveNewSet, clearForm, handleTextInputChange, fillFormWithQASet, qaSetToText } from './qa-creator.js';
import { startTraining, getCurrentQuestion, getCurrentAnswer, getTrainingProgress, getSessionState, submitAnswer, nextQuestion, previousQuestion, finishTraining, pauseTraining, resumeTraining, cancelTraining, restoreTrainingProgress, saveTrainingProgress } from './qa-trainer.js';
import { startAIChecking, clearCheckingCache, getCheckingCacheStats, recheckAnswer } from './qa-checker.js';
import { exportTrainingResultToPDF, exportQASetForHandwriting } from './qa-pdf.js';
import { displayMessage, showOptionsModal, openModal, closeModal } from '../../modules/ui.js';

// 問答模組狀態
const qaModuleState = {
  isInitialized: false,
  currentSession: null,
  isVisible: false,
  qaSets: [],
  currentView: 'management' // management, creator, training, report
};

// 初始化問答模組
export async function init() {
  console.log('問答訓練模組初始化...');

  if (qaModuleState.isInitialized) {
    console.log('問答模組已初始化');
    return;
  }

  // 清理過期緩存
  cleanupExpiredCache();

  // 嘗試恢復訓練進度
  const restored = restoreTrainingProgress();
  if (restored) {
    console.log('發現之前的訓練進度，已恢復');
  }

  // 初始化事件監聽器
  initEventListeners();

  // 問答區選字：顯示「加入生詞本」懸浮按鈕（簡化版）
  try { initQASelectionToWordbook(); } catch (_) {}

  // 載入問答集
  await loadQASets();

  qaModuleState.isInitialized = true;
  console.log('問答訓練模組初始化完成');
}

// 顯示問答模組
export function showQAModule() {
  console.log('顯示問答訓練模組');

  if (!qaModuleState.isInitialized) {
    console.error('問答模組尚未初始化');
    return;
  }

  // 確保模組元素存在
  if (dom.qaModule) {
    dom.qaModule.style.display = 'block';
    qaModuleState.isVisible = true;

    // 顯示管理區域，隱藏其他區域
    showManagementView();

    console.log('問答模組已顯示');
  } else {
    console.error('找不到問答模組DOM元素');
  }
}

// 簡化版：在 QA 訓練區域選字後，顯示一個小按鈕可直接加入生詞本
function initQASelectionToWordbook() {
  const area = dom.qaTrainingArea;
  if (!area) return;

  let btn = null;
  function ensureBtn() {
    if (btn) return btn;
    btn = document.createElement('button');
    btn.textContent = '加入生詞本';
    btn.style.cssText = [
      'position:absolute',
      'z-index:9999',
      'padding:4px 8px',
      'font-size:12px',
      'border:1px solid #d1d5db',
      'border-radius:6px',
      'background:#fff',
      'color:#111827',
      'box-shadow:0 2px 6px rgba(0,0,0,0.08)',
      'display:none',
      'min-height:unset'
    ].join(';');
    document.body.appendChild(btn);
    btn.addEventListener('click', async () => {
      const sel = window.getSelection();
      const text = (sel && sel.toString && sel.toString().trim()) || '';
      if (!text) { displayMessage('請先選取要加入的詞/片語', 'warning'); return; }
      const q = dom.qaModule?.querySelector('#qa-current-question')?.textContent || '';
      const prev = btn.textContent;
      btn.disabled = true; btn.textContent = '加入中...'; btn.setAttribute('aria-busy','true');
      try {
        const mod = await import('../../modules/vocab.js');
        const res = await mod.addWordToDefaultBook(text, { source: 'qa', sentence: q, context: q });
        btn.textContent = (res && res.reason === 'duplicate') ? '已存在' : '已加入';
      } catch (err) {
        console.warn('加入生詞本失敗:', err);
        btn.textContent = '失敗';
      } finally {
        setTimeout(()=>{ btn.removeAttribute('aria-busy'); btn.disabled = false; btn.textContent = prev || '加入生詞本'; }, 1000);
        hideBtn();
        try { sel && sel.removeAllRanges && sel.removeAllRanges(); } catch (_) {}
      }
    });
    return btn;
  }

  function hideBtn() { if (btn) btn.style.display = 'none'; }

  area.addEventListener('mouseup', (e) => {
    setTimeout(() => {
      const sel = window.getSelection();
      const text = (sel && sel.toString && sel.toString().trim()) || '';
      if (!text) { hideBtn(); return; }
      // Only react to selections inside QA training area
      if (!sel || sel.rangeCount === 0) { hideBtn(); return; }
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) { hideBtn(); return; }
      const b = ensureBtn();
      b.style.left = `${rect.left + window.scrollX}px`;
      b.style.top = `${rect.bottom + window.scrollY + 6}px`;
      b.style.display = 'inline-block';
    }, 0);
  });

  document.addEventListener('mousedown', (e) => {
    if (!btn) return;
    if (e.target === btn) return;
    // If clicking outside, hide the button
    hideBtn();
  });
}

// 隱藏問答模組
export function hideQAModule() {
  console.log('隱藏問答訓練模組');

  if (dom.qaModule) {
    dom.qaModule.style.display = 'none';
    qaModuleState.isVisible = false;
    console.log('問答模組已隱藏');
  }
}

// 初始化事件監聽器
function initEventListeners() {
  console.log('初始化問答模組事件監聽器');

  // 問答集管理按鈕
  if (dom.qaModule) {
    // 創建問答集按鈕
    const createBtn = dom.qaModule.querySelector('#create-qa-set-btn');
    if (createBtn) {
      createBtn.addEventListener('click', () => {
        showCreatorView();
      });
    }

    const loadTemplateBtn = dom.qaModule.querySelector('#load-qa-template-btn');
    if (loadTemplateBtn) {
      loadTemplateBtn.addEventListener('click', handleLoadTemplate);
    }

    const templateSelect = dom.qaModule.querySelector('#qa-template-select');
    if (templateSelect) {
      templateSelect.addEventListener('change', updateTemplateControlsState);
    }

    // 導入問答集按鈕
    const importBtn = dom.qaModule.querySelector('#import-qa-set-btn');
    if (importBtn) {
      importBtn.addEventListener('click', handleImportQASet);
    }

    // 取消創建按鈕
    const cancelBtn = dom.qaModule.querySelector('#cancel-qa-creator-btn');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', showManagementView);
    }

    // 保存問答集按鈕
    const saveBtn = dom.qaModule.querySelector('#save-qa-set-btn');
    if (saveBtn) {
      saveBtn.addEventListener('click', handleSaveQASet);
    }

    // 訓練相關按鈕
    const submitAnswerBtn = dom.qaModule.querySelector('#submit-answer-btn');
    if (submitAnswerBtn) {
      submitAnswerBtn.addEventListener('click', handleSubmitAnswer);
    }

    const submitAndCheckBtn = dom.qaModule.querySelector('#submit-and-check-btn');
    if (submitAndCheckBtn) {
      submitAndCheckBtn.addEventListener('click', handleSubmitAndCheckCurrent);
    }

    const answerInput = dom.qaModule.querySelector('#qa-answer-input');
    if (answerInput) {
      answerInput.addEventListener('input', handleAnswerDraftChange);
    }

    const prevQABtn = dom.qaModule.querySelector('#prev-qa-btn');
    if (prevQABtn) {
      prevQABtn.addEventListener('click', handlePreviousQuestion);
    }

    const nextQABtn = dom.qaModule.querySelector('#next-qa-btn');
    if (nextQABtn) {
      nextQABtn.addEventListener('click', handleNextQuestion);
    }

    const finishTrainingBtn = dom.qaModule.querySelector('#finish-training-btn');
    if (finishTrainingBtn) {
      finishTrainingBtn.addEventListener('click', handleFinishTraining);
    }

    const backToQAListBtn = dom.qaModule.querySelector('#back-to-qa-list-btn');
    if (backToQAListBtn) {
      backToQAListBtn.addEventListener('click', () => {
        if (getSessionState().isActive) {
          if (cancelTraining()) {
            showManagementView();
          }
        } else {
          showManagementView();
        }
      });
    }

    // AI校對按鈕
    const aiCheckBtn = dom.qaModule.querySelector('#ai-check-btn');
    if (aiCheckBtn) {
      aiCheckBtn.addEventListener('click', handleAIChecking);
    }

    // PDF導出按鈕
    const exportPdfBtn = dom.qaModule.querySelector('#export-pdf-btn');
    if (exportPdfBtn) {
      exportPdfBtn.addEventListener('click', handleExportPDF);
    }

    // 重新訓練按鈕
    const retryTrainingBtn = dom.qaModule.querySelector('#retry-training-btn');
    if (retryTrainingBtn) {
      retryTrainingBtn.addEventListener('click', handleRetryTraining);
    }

    // 返回主選單按鈕
    const backToMenuBtn = dom.qaModule.querySelector('#back-to-qa-menu-btn');
    if (backToMenuBtn) {
      backToMenuBtn.addEventListener('click', handleBackToMenu);
    }
  }
}

// 載入問答集
async function loadQASets() {
  console.log('載入問答集...');

  try {
    // 載入所有問答集（預置 + 用戶創建）
    qaModuleState.qaSets = (await getAllQASets()).map(set => ({
      ...set,
      isPreset: Boolean(set.isPreset)
    }));

    console.log(`載入完成: ${qaModuleState.qaSets.length} 個問答集`);

    // 更新顯示
    updateQASetsDisplay();
    refreshCreatorTemplateSelector();

  } catch (error) {
    console.error('載入問答集時出錯:', error);
    displayMessage('載入問答集失敗', 'error');

    // 降級到只顯示用戶創建的問答集
    qaModuleState.qaSets = getStoredQASets().map(set => ({
      ...set,
      isPreset: Boolean(set.isPreset)
    }));
    updateQASetsDisplay();
    refreshCreatorTemplateSelector();
  }
}

// 更新問答集顯示
function updateQASetsDisplay() {
  const listContainer = dom.qaModule?.querySelector('#qa-sets-list');
  if (!listContainer) return;

  listContainer.innerHTML = '';

  if (qaModuleState.qaSets.length === 0) {
    listContainer.innerHTML = '<p class="no-qa-sets">尚無問答集，點擊"創建問答集"開始創建。</p>';
    return;
  }

  // 按類別分組顯示
  const categories = [...new Set(qaModuleState.qaSets.map(qa => qa.category))];

  for (const category of categories) {
    const categoryQAs = qaModuleState.qaSets.filter(qa => qa.category === category);

    const categoryDiv = document.createElement('div');
    categoryDiv.className = 'qa-category';
    categoryDiv.innerHTML = `
      <h4 class="category-title">${category}</h4>
      <div class="qa-category-list">
        ${categoryQAs.map(qa => createQASetCard(qa)).join('')}
      </div>
    `;

    listContainer.appendChild(categoryDiv);
  }

  // 添加卡片點擊事件
  if (!listContainer.dataset.listenerAttached) {
    listContainer.addEventListener('click', handleQASetCardClick);
    listContainer.dataset.listenerAttached = 'true';
  }
}

// 創建問答集卡片HTML
function createQASetCard(qaSet) {
  return `
    <div class="qa-set-card" data-qa-id="${qaSet.id}">
      <div class="qa-set-header">
        <h5 class="qa-set-name">${qaSet.name}</h5>
        <span class="qa-set-count">${qaSet.questionCount} 題</span>
      </div>
      <div class="qa-set-description">${qaSet.description}</div>
      <div class="qa-set-actions">
        <button class="btn small primary start-training-btn">開始訓練</button>
        ${!qaSet.isPreset ? '<button class="btn small secondary edit-btn">編輯</button>' : ''}
        <button class="btn small secondary export-btn">導出手默</button>
        ${!qaSet.isPreset ? '<button class="btn small danger delete-btn">刪除</button>' : ''}
      </div>
    </div>
  `;
}

// 處理問答集卡片點擊
function handleQASetCardClick(event) {
  const card = event.target.closest('.qa-set-card');
  if (!card) return;

  const qaId = card.dataset.qaId;
  const button = event.target;

  if (button.classList.contains('start-training-btn')) {
    startQATraining(qaId);
  } else if (button.classList.contains('edit-btn')) {
    handleEditQASet(qaId);
  } else if (button.classList.contains('export-btn')) {
    handleQASetExport(qaId);
  } else if (button.classList.contains('delete-btn')) {
    handleDeleteQASet(qaId);
  }
}

// 問答集工具：編輯與範本套用
async function handleEditQASet(qaId) {
  try {
    const summary = qaModuleState.qaSets.find(item => item.id === qaId);
    if (summary?.isPreset) {
      displayMessage('預置問答集無法直接覆寫，請使用「套用範本」建立副本。', 'info');
      return;
    }

    const qaSet = await loadQASet(qaId);
    if (!qaSet) {
      displayMessage('無法載入選定的問答集進行編輯。', 'error');
      return;
    }

    openQASetEditorModal(qaSet);
  } catch (error) {
    console.error('載入問答集進行編輯時出錯:', error);
    displayMessage('載入問答集失敗，無法進行編輯。', 'error');
  }
}

async function handleLoadTemplate() {
  const select = dom.qaModule?.querySelector('#qa-template-select');
  const button = dom.qaModule?.querySelector('#load-qa-template-btn');

  if (!select || !button) return;

  const qaId = select.value;
  if (!qaId) {
    displayMessage('請先選擇要套用的問答集。', 'warning');
    return;
  }

  button.disabled = true;
  try {
    const qaSet = await loadQASet(qaId);
    if (!qaSet) {
      displayMessage('載入問答集失敗。', 'error');
      return;
    }

    fillFormWithQASet(qaSet, { treatAsTemplate: true });
    displayMessage(`已套用「${qaSet.name}」作為範本。`, 'success');
  } catch (error) {
    console.error('套用問答集範本時出錯:', error);
    displayMessage('無法套用範本，請稍後再試。', 'error');
  } finally {
    button.disabled = false;
  }
}

function refreshCreatorTemplateSelector(selectedId = '') {
  const select = dom.qaModule?.querySelector('#qa-template-select');
  if (!select) return;

  const previousValue = selectedId || select.value;
  select.innerHTML = '';

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '選擇既有問答集';
  select.appendChild(placeholder);

  const collator = new Intl.Collator('zh-Hant', { sensitivity: 'base' });
  const sortedSets = [...qaModuleState.qaSets].sort((a, b) => collator.compare(a.name, b.name));

  sortedSets.forEach(set => {
    const option = document.createElement('option');
    option.value = set.id;
    option.textContent = `${set.name}${set.isPreset ? '（預置）' : ''}`;
    select.appendChild(option);
  });

  const values = Array.from(select.options).map(option => option.value);
  select.value = values.includes(previousValue) ? previousValue : '';

  updateTemplateControlsState();
}

function updateTemplateControlsState() {
  const select = dom.qaModule?.querySelector('#qa-template-select');
  const loadTemplateBtn = dom.qaModule?.querySelector('#load-qa-template-btn');

  if (!select || !loadTemplateBtn) return;

  loadTemplateBtn.disabled = !select.value;
}

function openQASetEditorModal(qaSet) {
  openModal();

  if (dom.modalTitle) {
    dom.modalTitle.textContent = `編輯問答集`;
  }

  if (!dom.modalBody) return;

  dom.modalBody.innerHTML = `
    <div class="qa-editor-modal">
      <form id="qa-editor-form" class="qa-editor-form">
        <div class="qa-editor-grid">
          <div class="form-group">
            <label for="qa-edit-name">問答集名稱</label>
            <input id="qa-edit-name" type="text" placeholder="輸入問答集名稱">
          </div>
          <div class="form-group">
            <label for="qa-edit-description">描述</label>
            <input id="qa-edit-description" type="text" placeholder="輸入問答集描述">
          </div>
          <div class="form-group">
            <label for="qa-edit-pairs">問答對 (Q1: 問題 A1: 答案)</label>
            <textarea id="qa-edit-pairs" rows="10" placeholder="Q1: 問題1? A1: 答案1"></textarea>
          </div>
        </div>
        <div id="qa-edit-preview" class="qa-preview"></div>
        <div class="qa-editor-actions">
          <button type="button" class="btn secondary qa-edit-cancel">取消</button>
          <button type="submit" class="btn primary qa-edit-save">保存變更</button>
        </div>
      </form>
    </div>
  `;

  const form = dom.modalBody.querySelector('#qa-editor-form');
  const nameInput = dom.modalBody.querySelector('#qa-edit-name');
  const descInput = dom.modalBody.querySelector('#qa-edit-description');
  const pairsInput = dom.modalBody.querySelector('#qa-edit-pairs');
  const preview = dom.modalBody.querySelector('#qa-edit-preview');
  const cancelBtn = dom.modalBody.querySelector('.qa-edit-cancel');

  if (!form || !nameInput || !descInput || !pairsInput || !preview) {
    console.error('初始化問答集編輯器時缺少必要的元素');
    return;
  }

  nameInput.value = qaSet.name || '';
  descInput.value = qaSet.description || '';
  pairsInput.value = qaSetToText(qaSet);

  const updatePreview = () => {
    handleTextInputChange(pairsInput, preview);
  };

  updatePreview();
  pairsInput.addEventListener('input', updatePreview);

  cancelBtn?.addEventListener('click', (event) => {
    event.preventDefault();
    closeModal();
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();

    try {
      const name = nameInput.value.trim();
      const description = descInput.value.trim();
      const text = pairsInput.value.trim();
      const pairs = parseQAPairs(text);

      const savedQASet = saveNewSet(name, description, pairs, qaSet);

      if (savedQASet) {
        const summary = {
          id: savedQASet.id,
          name: savedQASet.name,
          category: savedQASet.category || '自定義',
          questionCount: savedQASet.questions.length,
          difficulty: savedQASet.difficulty || 'unknown',
          description: savedQASet.description || '',
          isPreset: false
        };

        const index = qaModuleState.qaSets.findIndex(item => item.id === summary.id);
        if (index >= 0) {
          qaModuleState.qaSets[index] = {
            ...qaModuleState.qaSets[index],
            ...summary
          };
        } else {
          qaModuleState.qaSets.push(summary);
        }

        updateQASetsDisplay();
        refreshCreatorTemplateSelector(savedQASet.id);

        displayMessage(`問答集 "${savedQASet.name}" 已更新！`, 'success');
        closeModal();
      }
    } catch (error) {
      console.error('更新問答集時出錯:', error);
      displayMessage('更新失敗: ' + error.message, 'error');
    }
  });
}

// 開始問答訓練
async function startQATraining(qaId) {
  console.log(`開始問答訓練: ${qaId}`);

  try {
    // 檢查是否有進行中的訓練
    const sessionState = getSessionState();
    if (sessionState.isActive) {
      // 若同一問答集或未能識別ID，直接續練；不同問答集再詢問
      if (!sessionState.qaSetId || sessionState.qaSetId === qaId) {
        showTrainingView();
        updateTrainingInterface();
        displayMessage('已為你繼續上一個訓練。', 'info');
        return;
      } else {
        const confirmed = confirm('已有進行中的訓練。確定要開始新的訓練嗎？選「取消」將繼續先前訓練。');
        if (!confirmed) {
          showTrainingView();
          updateTrainingInterface();
          displayMessage('已為你繼續上一個訓練。', 'info');
          return;
        }
      }
    }

    // 顯示訓練設置選項（可選）
    const trainingOptions = await showTrainingOptions();
    if (!trainingOptions) {
      return; // 用戶取消
    }

    // 開始訓練
    const success = await startTraining(qaId, trainingOptions);
    if (success) {
      instantAICheckResults.clear();
      clearInstantFeedbackArea();

      // 切換到訓練視圖
      showTrainingView();

      // 載入第一題
      updateTrainingInterface();

      displayMessage('訓練開始！', 'success');
    }

  } catch (error) {
    console.error('開始訓練時出錯:', error);
    displayMessage('無法開始訓練: ' + error.message, 'error');
  }
}

// 顯示訓練設置選項
function showTrainingOptions() {
  return new Promise((resolve) => {
    showOptionsModal({
      title: '🎯 問答訓練設定',
      description: '請選擇您的訓練偏好，這些設定將影響您的學習體驗',
      options: [
        {
          key: 'mode',
          type: 'radio',
          label: '訓練模式',
          description: '選擇問題的出現順序',
          default: 'sequential',
          choices: [
            {
              value: 'sequential',
              label: '順序模式',
              description: '按照原始順序練習'
            },
            {
              value: 'random',
              label: '隨機模式',
              description: '隨機打亂問題順序'
            }
          ]
        }
      ],
      onConfirm: (result) => {
        resolve({
          mode: result.mode,
          submitMode: 'single'
        });
      },
      onCancel: () => {
        resolve(null);
      }
    });
  });
}

// 處理問答集導出
async function handleQASetExport(qaId) {
  console.log(`處理問答集導出: ${qaId}`);

  showOptionsModal({
    title: '📄 問答集導出選項',
    description: '選擇導出格式和設定，適合不同的使用場景',
    options: [
      {
        key: 'exportType',
        type: 'radio',
        label: '導出類型',
        description: '選擇導出的用途',
        default: 'handwriting',
        choices: [
          {
            value: 'handwriting',
            label: '手寫默寫版',
            description: '適合打印後手寫練習'
          },
          {
            value: 'json',
            label: 'JSON數據',
            description: '原始數據格式，便於分享和備份'
          }
        ]
      },
      {
        key: 'shuffleQuestions',
        type: 'checkbox',
        label: '隨機打亂題目順序',
        description: '避免記憶順序，提高練習效果',
        default: false
      },
      {
        key: 'includeAnswers',
        type: 'checkbox',
        label: '包含標準答案',
        description: '在PDF中顯示答案供對照',
        default: false
      },
      {
        key: 'answerLines',
        type: 'select',
        label: '答題行數',
        description: '每道題目的答題空間',
        default: 1,
        choices: [
          { value: 1, label: '一行（適合短答案）' },
          { value: 2, label: '兩行（適合長答案）' }
        ]
      },
      {
        key: 'questionsPerPage',
        type: 'number',
        label: '每頁題目數量',
        description: '控制每頁顯示的題目數量',
        default: 8,
        min: 4,
        max: 12
      }
    ],
    onConfirm: async (result) => {
      if (result.exportType === 'handwriting') {
        await exportQASetForHandwriting(qaId, {
          shuffleQuestions: result.shuffleQuestions,
          includeAnswers: result.includeAnswers,
          answerLines: parseInt(result.answerLines),
          questionsPerPage: result.questionsPerPage
        });
      } else {
        await exportQASet(qaId);
      }
    },
    onCancel: () => {
      console.log('用戶取消導出');
    }
  });
}

// 顯示訓練視圖
function showTrainingView() {
  setActiveView('training');
  qaModuleState.currentView = 'training';
}

// 更新訓練界面
function updateTrainingInterface() {
  const question = getCurrentQuestion();
  const answer = getCurrentAnswer();
  const progress = getTrainingProgress();

  if (!question || !progress) {
    console.error('無法獲取訓練數據');
    return;
  }

  // 更新問題顯示
  const questionElement = dom.qaModule?.querySelector('#qa-current-question');
  if (questionElement) {
    questionElement.textContent = question.question;
  }

  // 更新答案輸入框
  const answerInput = dom.qaModule?.querySelector('#qa-answer-input');
  if (answerInput) {
    answerInput.value = answer;
  }

  // 更新進度顯示
  const progressText = dom.qaModule?.querySelector('#qa-progress-text');
  if (progressText) {
    progressText.textContent = `第 ${progress.currentNumber} 題 / 共 ${progress.totalQuestions} 題`;
  }

  const progressBar = dom.qaModule?.querySelector('#qa-progress-bar');
  if (progressBar) {
    progressBar.style.width = `${progress.progressPercentage}%`;
  }

  // 更新按鈕狀態
  updateTrainingButtons();

  renderInstantFeedbackForQuestion(question);
}

// 更新訓練按鈕狀態
function updateTrainingButtons() {
  const progress = getTrainingProgress();
  if (!progress) return;

  const prevBtn = dom.qaModule?.querySelector('#prev-qa-btn');
  const nextBtn = dom.qaModule?.querySelector('#next-qa-btn');

  if (prevBtn) {
    prevBtn.disabled = progress.currentIndex === 0;
  }

  if (nextBtn) {
    nextBtn.disabled = progress.currentIndex >= progress.totalQuestions - 1;
  }
}

// 處理提交答案
function handleSubmitAnswer() {
  try {
    const answerInput = dom.qaModule?.querySelector('#qa-answer-input');
    if (!answerInput) {
      throw new Error('找不到答案輸入框');
    }

    const question = getCurrentQuestion();
    if (question) {
      instantAICheckResults.delete(question.qid);
    }
    clearInstantFeedbackArea();

    const answer = answerInput.value.trim();
    if (!answer) {
      displayMessage('請輸入答案', 'warning');
      return;
    }

    // 提交答案
    submitAnswer(answer);

    // 保存進度
    saveTrainingProgress();

    displayMessage('答案已提交', 'success');

    // 自動進入下一題（可選）
    setTimeout(() => {
      if (nextQuestion()) {
        updateTrainingInterface();
      } else {
        // 已是最後一題，提示完成訓練
        displayMessage('已完成所有題目，可以結束訓練了', 'info');
      }
    }, 500);

  } catch (error) {
    console.error('提交答案時出錯:', error);
    displayMessage('提交答案失敗: ' + error.message, 'error');
  }
}


async function handleSubmitAndCheckCurrent(event) {
  if (event) {
    event.preventDefault();
  }

  try {
    const answerInput = dom.qaModule?.querySelector('#qa-answer-input');
    if (!answerInput) {
      throw new Error('找不到答案輸入框');
    }

    const answer = answerInput.value.trim();
    if (!answer) {
      displayMessage('請先輸入答案', 'warning');
      return;
    }

    const question = getCurrentQuestion();
    const progress = getTrainingProgress();

    if (!question || !progress) {
      displayMessage('目前無法取得題目資訊', 'error');
      return;
    }

    submitAnswer(answer);
    saveTrainingProgress();

    const button = dom.qaModule?.querySelector('#submit-and-check-btn');
    if (button) {
      button.dataset.originalLabel = button.textContent;
      button.disabled = true;
      button.textContent = 'AI 校對中...';
    }

    showInstantFeedbackLoading('AI 正在校對本題...');

    const answerPayload = {
      qid: question.qid,
      question: question.question,
      correctAnswer: question.answer,
      userAnswer: answer,
      isSubmitted: true
    };

    const checkResult = await recheckAnswer(answerPayload);

    checkResult.displayIndex = progress.currentIndex;

    instantAICheckResults.set(question.qid, checkResult);
    renderInstantFeedbackResult(checkResult);

    displayMessage(`AI 已校對第 ${progress.currentNumber} 題`, 'success');
  } catch (error) {
    console.error('提交並 AI 校對失敗:', error);
    displayMessage('AI 校對失敗：' + (error.message || '請稍後再試'), 'error');
    showInstantFeedbackError(error.message || 'AI 校對失敗，請稍後再試。');
  } finally {
    const button = dom.qaModule?.querySelector('#submit-and-check-btn');
    if (button) {
      const label = button.dataset.originalLabel || '提交並 AI 校對本題';
      button.textContent = label;
      button.disabled = false;
    }
  }
}

function showInstantFeedbackLoading(message = 'AI 正在校對本題...') {
  const container = dom.qaModule?.querySelector('#qa-instant-feedback');
  const content = dom.qaModule?.querySelector('#qa-instant-feedback-content');
  if (!container || !content) {
    return;
  }

  container.style.display = 'block';
  container.classList.add('is-loading');
  container.classList.remove('has-result', 'has-error');
  content.innerHTML = `
    <div class="instant-feedback-status">
      <div class="spinner"></div>
      <span>${escapeHtml(message)}</span>
    </div>
  `;
}

function renderInstantFeedbackResult(result) {
  const container = dom.qaModule?.querySelector('#qa-instant-feedback');
  const content = dom.qaModule?.querySelector('#qa-instant-feedback-content');
  if (!container || !content) {
    return;
  }

  container.style.display = 'block';
  container.classList.add('has-result');
  container.classList.remove('is-loading', 'has-error');
  content.innerHTML = generateAICheckedResultsHTML([result], null);
}

function renderInstantFeedbackForQuestion(question) {
  if (!question) {
    clearInstantFeedbackArea();
    return;
  }

  const cachedResult = instantAICheckResults.get(question.qid);
  if (cachedResult) {
    renderInstantFeedbackResult(cachedResult);
  } else {
    clearInstantFeedbackArea();
  }
}

function showInstantFeedbackError(message) {
  const container = dom.qaModule?.querySelector('#qa-instant-feedback');
  const content = dom.qaModule?.querySelector('#qa-instant-feedback-content');
  if (!container || !content) {
    return;
  }

  container.style.display = 'block';
  container.classList.add('has-error');
  container.classList.remove('is-loading', 'has-result');
  content.innerHTML = `
    <div class="instant-feedback-status">
      <span>${escapeHtml(message)}</span>
    </div>
  `;
}

function clearInstantFeedbackArea() {
  const container = dom.qaModule?.querySelector('#qa-instant-feedback');
  const content = dom.qaModule?.querySelector('#qa-instant-feedback-content');
  if (!container || !content) {
    return;
  }

  container.style.display = 'none';
  container.classList.remove('is-loading', 'has-result', 'has-error');
  content.innerHTML = '';
}

function handleAnswerDraftChange() {
  const question = getCurrentQuestion();
  if (!question) {
    return;
  }

  instantAICheckResults.delete(question.qid);
  clearInstantFeedbackArea();
}



// 處理上一題
function handlePreviousQuestion() {
  try {
    if (previousQuestion()) {
      updateTrainingInterface();
    }
  } catch (error) {
    console.error('切換到上一題時出錯:', error);
    displayMessage('無法切換到上一題: ' + error.message, 'error');
  }
}

// 處理下一題
function handleNextQuestion() {
  try {
    if (nextQuestion()) {
      updateTrainingInterface();
    }
  } catch (error) {
    console.error('切換到下一題時出錯:', error);
    displayMessage('無法切換到下一題: ' + error.message, 'error');
  }
}

// 處理完成訓練
function handleFinishTraining() {
  try {
    const trainingResult = finishTraining();
    if (trainingResult) {
      // 切換到報告視圖
      showReportView(trainingResult);
      displayMessage('訓練完成！', 'success');
    }
  } catch (error) {
    console.error('完成訓練時出錯:', error);
    displayMessage('完成訓練失敗: ' + error.message, 'error');
  }
}

// 顯示報告視圖
function showReportView(trainingResult) {
  setActiveView('report');
  qaModuleState.currentView = 'report';

  instantAICheckResults.clear();
  clearInstantFeedbackArea();

  // 保存當前訓練結果供AI校對使用
  currentTrainingResult = trainingResult;

  // 更新報告內容
  updateReportInterface(trainingResult);
}

// 更新報告界面
function updateReportInterface(trainingResult) {
  // 計算準確率（暫時基於回答數量，後續會加入AI校對）
  const accuracy = Math.round((trainingResult.answeredQuestions / trainingResult.totalQuestions) * 100);

  // 更新準確率顯示
  const accuracyElement = dom.qaModule?.querySelector('#qa-accuracy');
  if (accuracyElement) {
    accuracyElement.textContent = `${accuracy}%`;
  }

  // 更新得分顯示
  const scoreElement = dom.qaModule?.querySelector('#qa-score');
  if (scoreElement) {
    scoreElement.textContent = `${trainingResult.answeredQuestions}/${trainingResult.totalQuestions}`;
  }

  // 更新詳細結果
  const detailedResults = dom.qaModule?.querySelector('#qa-detailed-results');
  if (detailedResults) {
    detailedResults.innerHTML = generateResultsHTML(trainingResult);
  }
}

// 處理刪除問答集
async function handleDeleteQASet(qaId) {
  const qaSet = qaModuleState.qaSets.find(qa => qa.id === qaId);
  if (!qaSet) return;

  // 檢查是否為預置問答集
  if (qaSet.isPreset) {
    displayMessage('無法刪除預置問答集', 'warning');
    return;
  }

  const confirmed = confirm(`確定要刪除問答集 "${qaSet.name}" 嗎？此操作無法復原。`);
  if (confirmed) {
    const success = await deleteQASet(qaId);
    if (success) {
      // 從本地狀態中移除
      qaModuleState.qaSets = qaModuleState.qaSets.filter(qa => qa.id !== qaId);
      updateQASetsDisplay();
      refreshCreatorTemplateSelector();
      displayMessage('問答集已刪除', 'success');
    }
  }
}

// 處理導入問答集
function handleImportQASet() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = async (event) => {
    const file = event.target.files[0];
    if (file) {
      const success = await importQASet(file);
      if (success) {
        // 重新載入問答集
        await loadQASets();
        displayMessage('問答集導入成功', 'success');
      }
    }
  };
  input.click();
}

// 處理保存問答集
function handleSaveQASet() {
  console.log('保存問答集...');

  try {
    const nameInput = document.getElementById('qa-set-name');
    const descInput = document.getElementById('qa-set-description');
    const pairsInput = document.getElementById('qa-pairs-input');

    if (!nameInput || !descInput || !pairsInput) {
      throw new Error('找不到表單元素');
    }

    const name = nameInput.value.trim();
    const description = descInput.value.trim();
    const text = pairsInput.value.trim();

    const pairs = parseQAPairs(text);
    const savedQASet = saveNewSet(name, description, pairs);

    if (savedQASet) {
      const summary = {
        id: savedQASet.id,
        name: savedQASet.name,
        category: savedQASet.category || '自定義',
        questionCount: savedQASet.questions.length,
        difficulty: savedQASet.difficulty || 'unknown',
        description: savedQASet.description || '',
        isPreset: false
      };

      const exists = qaModuleState.qaSets.some(item => item.id === summary.id);
      if (!exists) {
        qaModuleState.qaSets.push(summary);
      }

      updateQASetsDisplay();
      refreshCreatorTemplateSelector(savedQASet.id);

      displayMessage(`問答集 "${savedQASet.name}" 保存成功！`, 'success');

      setTimeout(() => {
        showManagementView();
      }, 800);
    }
  } catch (error) {
    console.error('保存問答集時出錯:', error);
    displayMessage('保存失敗: ' + error.message, 'error');
  }
}

function showManagementView() {
  setActiveView('management');
  qaModuleState.currentView = 'management';
  clearInstantFeedbackArea();
}

function showCreatorView() {
  qaModuleState.currentView = 'creator';
  setActiveView('creator');

  setTimeout(() => {
    initCreator();
    clearForm();
    refreshCreatorTemplateSelector('');
  }, 100);
}

// 設置活動視圖
function setActiveView(viewName) {
  const views = ['management', 'creator', 'training', 'report'];

  for (const view of views) {
    const element = dom.qaModule?.querySelector(`#qa-${view}-area`);
    if (element) {
      element.style.display = view === viewName ? 'block' : 'none';
    }
  }
}

// 獲取模組狀態
export function getModuleState() {
  return { ...qaModuleState };
}

// 獲取問答集統計
export function getStats() {
  return getQASetStats();
}

// 生成訓練結果HTML
function generateResultsHTML(trainingResult) {
  let html = '<div class="training-results">';

  trainingResult.answers.forEach((answer, index) => {
    const isAnswered = answer.isSubmitted;
    const statusClass = isAnswered ? 'answered' : 'unanswered';

    html += `
      <div class="result-item ${statusClass}">
        <div class="result-header">
          <span class="question-number">Q${index + 1}</span>
          <span class="result-status">${isAnswered ? '已回答' : '未回答'}</span>
        </div>
        <div class="result-question">
          <strong>問題:</strong> ${escapeHtml(answer.question)}
        </div>
        <div class="result-answers">
          <div class="user-answer">
            <strong>您的答案:</strong> ${answer.userAnswer ? escapeHtml(answer.userAnswer) : '<span class="no-answer">未回答</span>'}
          </div>
          <div class="correct-answer">
            <strong>標準答案:</strong> ${escapeHtml(answer.correctAnswer)}
          </div>
        </div>
      </div>
    `;
  });

  html += '</div>';
  return html;
}

// 將錯誤分類扁平為清單，附上精簡標籤，避免『錯誤類型』區塊冗長
function collectIssueList(errorAnalysis) {
  if (!errorAnalysis) return [];
  const items = [];
  const push = (arr, label) => {
    if (Array.isArray(arr) && arr.length) {
      arr.forEach(m => items.push(`【${label}】` + m));
    }
  };
  push(errorAnalysis.punctuation, '標點/格式');
  push(errorAnalysis.grammar, '文法');
  push(errorAnalysis.spelling, '拼寫');
  push(errorAnalysis.vocabulary, '用字');
  push(errorAnalysis.structure, '句構');
  // 去重（忽略大小寫）
  const seen = new Set();
  const unique = [];
  for (const it of items) {
    const k = String(it).toLowerCase();
    if (!seen.has(k)) { unique.push(it); seen.add(k); }
  }
  return unique;
}

// 在使用者答案中以紅色標示常見的標點/格式問題
function highlightPunctuationInUserAnswer(currentHTML, rawUser = '', rawCorrect = '') {
  if (!rawUser) return currentHTML;

  // 先將 currentHTML 中的純文字節點替換；我們只做輕量處理：
  // - Yes/No 後缺逗號：高亮 Yes/No
  // - 連續空格：高亮
  // - 句末缺少標點：於末尾加紅色提示符
  try {
    let html = currentHTML;

    // Yes/No 後缺逗號
    if (/^(\s*)(yes|no)\s+[a-z]/i.test(rawUser) && !/^(\s*)(yes|no),\s/i.test(rawUser)) {
      html = html.replace(/^(\s*)(Yes|No)(\b)/i, (m, p1, p2, p3) => `${p1}<mark class="punc-err">${p2}</mark>${p3}`);
    }

    // 連續空格（顯示為紅底空格）
    html = html.replace(/ {2,}/g, (m) => `<mark class="punc-err-space">${'&nbsp;'.repeat(m.length)}</mark>`);

    // 句末缺少標點（參考正確答案是否有終止符）
    const correctEndPunc = /[.!?]$/.test(rawCorrect);
    const userEndPunc = /[.!?]$/.test(rawUser);
    if (correctEndPunc && !userEndPunc) {
      html = html + '<span class="punc-missing-end" title="句末缺少標點"></span>';
    }

    return html;
  } catch (_) {
    return currentHTML;
  }
}

// 檢出本地可判斷的標點/格式問題，作為補強（即使 AI 略過也能提示）
function detectLocalPunctuationIssues(rawUser = '', rawCorrect = '') {
  const msgs = [];
  if (!rawUser) return msgs;

  // Yes/No 後建議加逗號
  if (/^(\s*)(yes|no)\s+[a-z]/i.test(rawUser) && !/^(\s*)(yes|no),\s/i.test(rawUser)) {
    msgs.push('"Yes/No" 後建議加逗號');
  }

  // 連續空格
  if (/ {2,}/.test(rawUser)) {
    msgs.push('請避免連續空格');
  }

  // 句末缺少標點（若標準答案有終止符）
  if (/[.!?]$/.test(rawCorrect) && !/[.!?]$/.test(rawUser)) {
    msgs.push('句末缺少標點');
  }

  return msgs;
}

// HTML轉義函數
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function createDifferenceAnalysis(userAnswer = '', correctAnswer = '') {
  const userText = userAnswer ?? '';
  const correctText = correctAnswer ?? '';

  const normalizedUser = userText.trim();
  const normalizedCorrect = correctText.trim();

  if (!normalizedCorrect && !normalizedUser) {
    return null;
  }

  if (normalizedUser.toLowerCase() === normalizedCorrect.toLowerCase()) {
    return null;
  }

  const userTokens = tokenizeWithCounts(normalizedUser);
  const correctTokens = tokenizeWithCounts(normalizedCorrect);

  const missingKeys = [];
  const missingDisplay = [];
  correctTokens.counts.forEach((count, token) => {
    const userCount = userTokens.counts.get(token) || 0;
    if (userCount < count) {
      const deficit = count - userCount;
      const display = correctTokens.originals.get(token) || token;
      for (let i = 0; i < deficit; i++) {
        missingKeys.push(token);
        missingDisplay.push(display);
      }
    }
  });

  const extraKeys = [];
  const extraDisplay = [];
  userTokens.counts.forEach((count, token) => {
    const correctCount = correctTokens.counts.get(token) || 0;
    if (count > correctCount) {
      const surplus = count - correctCount;
      const display = userTokens.originals.get(token) || token;
      for (let i = 0; i < surplus; i++) {
        extraKeys.push(token);
        extraDisplay.push(display);
      }
    }
  });

  const userHighlighted = highlightTokensWithCounts(userText, extraKeys, 'diff-extra');
  const correctHighlighted = highlightTokensWithCounts(correctText, missingKeys, 'diff-missing');

  return {
    missingTokens: getUniqueDisplayTokens(missingDisplay),
    extraTokens: getUniqueDisplayTokens(extraDisplay),
    userHighlighted,
    correctHighlighted,
    hasDifferences: missingKeys.length > 0 || extraKeys.length > 0
  };
}

function tokenizeWithCounts(text) {
  const counts = new Map();
  const originals = new Map();

  if (!text) {
    return { counts, originals };
  }

  const tokens = text.match(/\b[\w']+\b/g);
  if (!tokens) {
    return { counts, originals };
  }

  tokens.forEach(token => {
    const lower = token.toLowerCase();
    counts.set(lower, (counts.get(lower) || 0) + 1);
    if (!originals.has(lower)) {
      originals.set(lower, token);
    }
  });

  return { counts, originals };
}

function highlightTokensWithCounts(text, tokens, cssClass) {
  const source = text ?? '';
  if (!source) {
    return '';
  }

  if (!tokens || tokens.length === 0) {
    return escapeHtml(source);
  }

  const counts = new Map();
  tokens.forEach(token => {
    const lower = token.toLowerCase();
    counts.set(lower, (counts.get(lower) || 0) + 1);
  });

  const parts = source.split(/(\b[\w']+\b)/);
  return parts.map(part => {
    const lower = part.toLowerCase();
    if (counts.has(lower) && counts.get(lower) > 0) {
      counts.set(lower, counts.get(lower) - 1);
      return `<mark class="${cssClass}">${escapeHtml(part)}</mark>`;
    }
    return escapeHtml(part);
  }).join('');
}

function getUniqueDisplayTokens(tokens) {
  const seen = new Set();
  const unique = [];
  tokens.forEach(token => {
    const key = token.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(token);
    }
  });
  return unique;
}

// 全局變量存儲當前訓練結果，供AI校對使用
let currentTrainingResult = null;
const instantAICheckResults = new Map();

// 處理AI校對
async function handleAIChecking() {
  console.log('開始AI校對...');

  if (!currentTrainingResult) {
    displayMessage('沒有可校對的訓練結果', 'warning');
    return;
  }

  const aiCheckBtn = dom.qaModule.querySelector('#ai-check-btn');
  const progressDiv = dom.qaModule.querySelector('#ai-checking-progress');
  const statusSpan = dom.qaModule.querySelector('#checking-status');
  const detailsDiv = dom.qaModule.querySelector('#checking-details');

  // 禁用按鈕並顯示進度
  if (aiCheckBtn) {
    aiCheckBtn.disabled = true;
    aiCheckBtn.textContent = 'AI 校對中...';
  }

  if (progressDiv) {
    progressDiv.style.display = 'block';
  }

  try {
    // 更新進度提示
    if (statusSpan) {
      statusSpan.textContent = '正在進行AI智能校對...';
    }
    if (detailsDiv) {
      detailsDiv.textContent = '分析答案準確性和語法正確性';
    }

    // 執行AI校對
    const checkingOptions = {
      concurrent: true,
      timeout: 30000,
      includeAnalysis: true
    };

    const checkingResult = await startAIChecking(currentTrainingResult, checkingOptions);

    if (checkingResult && checkingResult.checkedAnswers) {
      // 更新顯示為校對結果
      updateReportWithAIResults(checkingResult);
      displayMessage('AI校對完成！', 'success');

      // 更新進度提示為完成狀態
      if (statusSpan) {
        statusSpan.textContent = `AI校對完成！處理了 ${checkingResult.checkedAnswers.length} 個答案`;
      }
      if (detailsDiv) {
        detailsDiv.innerHTML = `
          <div>✅ 校對完成</div>
          <div>📊 準確率: ${checkingResult.summary?.accuracy || 0}%</div>
        `;
      }
    } else {
      throw new Error('AI校對返回無效結果');
    }

  } catch (error) {
    console.error('AI校對失敗:', error);
    displayMessage('AI校對失敗: ' + error.message, 'error');

    // 更新錯誤狀態
    if (statusSpan) {
      statusSpan.textContent = 'AI校對失敗';
    }
    if (detailsDiv) {
      detailsDiv.textContent = error.message;
    }
  } finally {
    // 恢復按鈕狀態
    if (aiCheckBtn) {
      aiCheckBtn.disabled = false;
      aiCheckBtn.textContent = 'AI 校對全部題目';
    }

    // 隱藏進度提示（延遲3秒）
    setTimeout(() => {
      if (progressDiv) {
        progressDiv.style.display = 'none';
      }
    }, 3000);
  }
}

// 使用AI校對結果更新報告界面
function updateReportWithAIResults(checkingResult) {
  const { checkedAnswers, summary } = checkingResult;

  // 存儲AI校對結果供PDF導出使用
  currentAICheckingResult = checkingResult;

  // 更新準確率和得分
  if (summary) {
    const accuracyElement = dom.qaModule?.querySelector('#qa-accuracy');
    if (accuracyElement) {
      accuracyElement.textContent = `${summary.accuracy}%`;
    }

    const scoreElement = dom.qaModule?.querySelector('#qa-score');
    if (scoreElement) {
      scoreElement.textContent = `${summary.correctAnswers}/${summary.totalAnswers}`;
    }
  }

  // 更新詳細結果顯示
  const detailedResults = dom.qaModule?.querySelector('#qa-detailed-results');
  if (detailedResults) {
    detailedResults.innerHTML = generateAICheckedResultsHTML(checkedAnswers, summary);
  }
}

// 生成AI校對結果HTML
function generateAICheckedResultsHTML(checkedAnswers, summary) {
  let html = '';

  // 添加AI校對總結
  if (summary) {
    html += `
      <div class="ai-summary">
        <h4>🤖 AI校對總結</h4>
        <div class="summary-stats">
          <div class="stat-item">
            <span class="stat-label">準確率</span>
            <span class="stat-value">${summary.accuracy}%</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">正確答案</span>
            <span class="stat-value">${summary.correctAnswers}/${summary.totalAnswers}</span>
          </div>
        </div>

        ${summary.recommendedActions && summary.recommendedActions.length > 0 ? `
          <div class="recommendations">
            <h5>📝 學習建議</h5>
            <ul>
              ${summary.recommendedActions.map(action => `<li>${action}</li>`).join('')}
            </ul>
          </div>
        ` : ''}
      </div>
    `;
  }

  // 添加詳細答案結果
  html += '<div class="ai-checked-results">';

  checkedAnswers.forEach((answer, index) => {
    const questionNumber = typeof answer.displayIndex === 'number' ?
      answer.displayIndex + 1 : index + 1;

    // 一律計算差異（即使語義判定為正確，也可能有格式/標點問題）
    const difference = createDifferenceAnalysis(answer.userAnswer, answer.correctAnswer);

    let userAnswerContent = answer.userAnswer
      ? (difference ? difference.userHighlighted : escapeHtml(answer.userAnswer))
      : '<span class="no-answer">未作答</span>';
    // 在使用者答案內標示標點/格式問題位置
    userAnswerContent = highlightPunctuationInUserAnswer(userAnswerContent, answer.userAnswer || '', answer.correctAnswer || '');
    const correctAnswerContent = answer.correctAnswer
      ? (difference ? difference.correctHighlighted : escapeHtml(answer.correctAnswer))
      : '<span class="no-answer">尚無標準答案</span>';

    // 決定卡片顏色：完全正確(綠) / 語義正確但有瑕疵(黃) / 錯誤(紅)
    let issues = collectIssueList(answer.errorAnalysis);
    const localPuncIssues = detectLocalPunctuationIssues(answer.userAnswer || '', answer.correctAnswer || '');
    if (localPuncIssues.length) {
      issues = issues.concat(localPuncIssues.map(m => `【標點/格式】${m}`));
    }
    const hasIssues = issues.length > 0;
    const isExact = Boolean(answer.isCorrect) && !hasIssues && (!difference || !difference.hasDifferences);
    const resultClass = isExact ? 'ai-checked-result' : (answer.isCorrect ? 'ai-checked-result partial' : 'ai-checked-result incorrect');

    const differenceSection = difference ? `
          <div class="difference-analysis">
            <h5>差異提示</h5>
            <div class="difference-highlight">
              <div>
                <strong>您的答案：</strong>
                <p class="difference-text">${userAnswerContent}</p>
              </div>
              <div>
                <strong>標準答案：</strong>
                <p class="difference-text">${correctAnswerContent}</p>
              </div>
            </div>
            ${(difference.missingTokens.length || difference.extraTokens.length) ? `
              <div class="difference-tags">
                ${difference.missingTokens.length ? `<span class="difference-tag missing">缺少：${difference.missingTokens.map(token => escapeHtml(token)).join('、')}</span>` : ''}
                ${difference.extraTokens.length ? `<span class="difference-tag extra">多出：${difference.extraTokens.map(token => escapeHtml(token)).join('、')}</span>` : ''}
              </div>
            ` : ''}
          </div>
        ` : '';

    html += `
      <div class="result-item ${resultClass}">
        <div class="result-header">
          <span class="question-number">Q${questionNumber}</span>
          <span class="result-status">${answer.isCorrect ? '正確' : '需改進'}</span>
        </div>

        <div class="result-question">
          <strong>題目:</strong> ${escapeHtml(answer.question)}
        </div>

        <div class="result-answers">
          <div class="user-answer">
            <strong>您的答案:</strong> ${userAnswerContent}
          </div>
          <div class="correct-answer">
            <strong>標準答案:</strong> ${correctAnswerContent}
          </div>
        </div>

        ${answer.teacherFeedback ? `
          <div class="teacher-feedback">
            <h5>教師回饋</h5>
            <p class="feedback-content">${escapeHtml(answer.teacherFeedback)}</p>
          </div>
        ` : answer.feedback ? `
          <div class="ai-feedback">
            <strong>AI 回饋:</strong> ${escapeHtml(answer.feedback)}
          </div>
        ` : ''}

        ${differenceSection}

        ${answer.strengths && answer.strengths.length > 0 ? `
          <div class="student-strengths">
            <h5>亮點表現</h5>
            <ul class="strengths-list">
              ${answer.strengths.map(strength => `<li class="strength-item">${escapeHtml(strength)}</li>`).join('')}
            </ul>
          </div>
        ` : ''}

        ${Array.isArray(answer.aiFeedbackIssues) && answer.aiFeedbackIssues.length > 0 ? `
          <div class="ai-feedback-review">
            <h5>AI 評語自檢</h5>
            <ul class="issues-list">
              ${answer.aiFeedbackIssues.map(issue => `<li class="issue-item">${escapeHtml(issue)}</li>`).join('')}
            </ul>
          </div>
        ` : (answer.aiFeedbackOk === true ? `
          <div class="ai-feedback-review ok">AI 評語檢查：無明顯問題</div>
        ` : '')}

        ${answer.improvementSuggestions && answer.improvementSuggestions.length > 0 ? `
          <div class="improvement-suggestions">
            <h5>改進建議</h5>
            <ul class="suggestions-list">
              ${answer.improvementSuggestions.map(suggestion => `<li class="suggestion-item">${escapeHtml(suggestion)}</li>`).join('')}
            </ul>
          </div>
        ` : answer.aiSuggestions && answer.aiSuggestions.length > 0 ? `
          <div class="ai-suggestions">
            <h5>改進建議</h5>
            <ul>
              ${answer.aiSuggestions.map(suggestion => `<li>${escapeHtml(suggestion)}</li>`).join('')}
            </ul>
          </div>
        ` : ''}

        ${answer.studyFocus && answer.studyFocus.length > 0 ? `
          <div class="study-focus">
            <h5>學習重點</h5>
            <ul class="focus-list">
              ${answer.studyFocus.map(focus => `<li class="focus-item">${escapeHtml(focus)}</li>`).join('')}
            </ul>
          </div>
        ` : ''}

        ${answer.improvedExamples && answer.improvedExamples.length > 0 ? `
          <div class="improved-examples">
            <h5>優化範例</h5>
            <div class="examples-container">
              ${answer.improvedExamples.map((example, itemIndex) => `
                <div class="example-item">
                  <strong>範例 ${itemIndex + 1}:</strong> ${escapeHtml(example)}
                </div>
              `).join('')}
            </div>
            ${answer.explanation ? `
              <div class="example-explanation">
                <strong>解析:</strong> ${escapeHtml(answer.explanation)}
              </div>
            ` : ''}
          </div>
        ` : ''}

        ${issues.length ? `
          <div class="issue-list">
            <h5>需要修正</h5>
            <ul class="issues">
              ${issues.map(it => `<li>${escapeHtml(it)}</li>`).join('')}
            </ul>
          </div>
        ` : ''}
      </div>
    `;
  });

  html += '</div>';
  return html;
}

// ==========================================
// PDF導出和報告相關事件處理函數
// ==========================================

// 全局變量存儲AI校對結果，供PDF導出使用
let currentAICheckingResult = null;

// 處理PDF導出
async function handleExportPDF() {
  console.log('開始導出PDF...');

  if (!currentTrainingResult) {
    displayMessage('沒有可導出的訓練結果', 'warning');
    return;
  }

  const exportBtn = dom.qaModule.querySelector('#export-pdf-btn');
  if (exportBtn) {
    exportBtn.disabled = true;
    exportBtn.textContent = '導出中...';
  }

  try {
    // 嘗試導出PDF，包含AI校對結果（如果有）
    const success = await exportTrainingResultToPDF(currentTrainingResult, currentAICheckingResult);

    if (success) {
      displayMessage('PDF報告導出成功！', 'success');
    }
  } catch (error) {
    console.error('PDF導出失敗:', error);
    displayMessage('PDF導出失敗: ' + error.message, 'error');
  } finally {
    // 恢復按鈕狀態
    if (exportBtn) {
      exportBtn.disabled = false;
      exportBtn.textContent = '導出PDF';
    }
  }
}

// 處理重新訓練
function handleRetryTraining() {
  console.log('重新開始訓練...');

  if (!currentTrainingResult) {
    displayMessage('沒有訓練記錄', 'warning');
    return;
  }

  const confirmed = confirm(`確定要重新開始 "${currentTrainingResult.qaSetName}" 的訓練嗎？`);
  if (confirmed) {
    // 啟動新的訓練
    startQATraining(currentTrainingResult.qaSetId);
  }
}

// 處理返回主選單
function handleBackToMenu() {
  console.log('返回問答主選單...');

  // 清理當前結果
  currentTrainingResult = null;
  currentAICheckingResult = null;
  instantAICheckResults.clear();
  clearInstantFeedbackArea();

  // 返回管理視圖
  showManagementView();
}

// 添加單題校驗功能
export async function checkSingleQuestionWithAI(questionIndex) {
  console.log(`開始AI校驗第 ${questionIndex + 1} 題...`);

  if (!currentTrainingResult || !currentTrainingResult.answers[questionIndex]) {
    displayMessage('找不到指定的題目數據', 'error');
    return;
  }

  const answer = currentTrainingResult.answers[questionIndex];
  if (!answer.isSubmitted) {
    displayMessage('該題目尚未回答，無法進行校驗', 'warning');
    return;
  }

  try {
    // 顯示校驗進度
    const progressContainer = createSingleCheckProgress(questionIndex);

    // 執行單題校驗
    const { checkSingleAnswer } = await import('./qa-checker.js');
    const checkResult = await checkSingleAnswer(answer);

    // 更新顯示結果
    updateSingleQuestionResult(questionIndex, checkResult);

    // 移除進度提示
    if (progressContainer) {
      progressContainer.remove();
    }

    displayMessage(`第 ${questionIndex + 1} 題AI校驗完成！`, 'success');

  } catch (error) {
    console.error('單題校驗失敗:', error);
    displayMessage(`第 ${questionIndex + 1} 題校驗失敗: ${error.message}`, 'error');
  }
}

// 創建單題校驗進度提示
function createSingleCheckProgress(questionIndex) {
  const targetElement = document.querySelector(`[data-question-index="${questionIndex}"]`);
  if (!targetElement) return null;

  const progressDiv = document.createElement('div');
  progressDiv.className = 'single-check-progress';
  progressDiv.innerHTML = `
    <div class="progress-indicator">
      <div class="spinner"></div>
      <span>正在AI校驗第 ${questionIndex + 1} 題...</span>
    </div>
  `;

  targetElement.appendChild(progressDiv);
  return progressDiv;
}

// 更新單題校驗結果
function updateSingleQuestionResult(questionIndex, checkResult) {
  const targetElement = document.querySelector(`[data-question-index="${questionIndex}"]`);
  if (!targetElement) return;

  // 查找或創建結果容器
  let resultContainer = targetElement.querySelector('.single-check-result');
  if (!resultContainer) {
    resultContainer = document.createElement('div');
    resultContainer.className = 'single-check-result';
    targetElement.appendChild(resultContainer);
  }

  // 生成結果HTML
  const resultHtml = generateSingleCheckResultHTML(checkResult);
  resultContainer.innerHTML = resultHtml;
}

// 生成單題校驗結果HTML
function generateSingleCheckResultHTML(result) {
  const difference = !result.isCorrect ? createDifferenceAnalysis(result.userAnswer, result.correctAnswer) : null;

  const userAnswerContent = result.userAnswer
    ? (difference ? difference.userHighlighted : escapeHtml(result.userAnswer))
    : '<span class="no-answer">未作答</span>';
  const correctAnswerContent = result.correctAnswer
    ? (difference ? difference.correctHighlighted : escapeHtml(result.correctAnswer))
    : '<span class="no-answer">尚無標準答案</span>';

  const differenceSection = difference ? `
        <div class="difference-analysis">
          <h5>差異提示</h5>
          <div class="difference-highlight">
            <div>
              <strong>您的答案：</strong>
              <p class="difference-text">${userAnswerContent}</p>
            </div>
            <div>
              <strong>標準答案：</strong>
              <p class="difference-text">${correctAnswerContent}</p>
            </div>
          </div>
          ${(difference.missingTokens.length || difference.extraTokens.length) ? `
            <div class="difference-tags">
              ${difference.missingTokens.length ? `<span class="difference-tag missing">缺少：${difference.missingTokens.map(token => escapeHtml(token)).join('、')}</span>` : ''}
              ${difference.extraTokens.length ? `<span class="difference-tag extra">多出：${difference.extraTokens.map(token => escapeHtml(token)).join('、')}</span>` : ''}
            </div>
          ` : ''}
        </div>
      ` : '';

  return `
    <div class="ai-check-result">
      <div class="result-header">
        <span class="result-status">${result.isCorrect ? '正確' : '需改進'}</span>
      </div>

      <div class="result-answers">
        <div class="user-answer">
          <strong>您的答案:</strong> ${userAnswerContent}
        </div>
        <div class="correct-answer">
          <strong>標準答案:</strong> ${correctAnswerContent}
        </div>
      </div>

      ${differenceSection}

      ${result.teacherFeedback ? `
        <div class="teacher-feedback">
          <h5>教師回饋</h5>
          <p>${escapeHtml(result.teacherFeedback)}</p>
        </div>
      ` : ''}

      ${result.strengths && result.strengths.length > 0 ? `
        <div class="strengths">
          <h5>亮點表現</h5>
          <ul>
            ${result.strengths.map(strength => `<li>${escapeHtml(strength)}</li>`).join('')}
          </ul>
        </div>
      ` : ''}

      ${result.improvementSuggestions && result.improvementSuggestions.length > 0 ? `
        <div class="improvements">
          <h5>改進建議</h5>
          <ul>
            ${result.improvementSuggestions.map(suggestion => `<li>${escapeHtml(suggestion)}</li>`).join('')}
          </ul>
        </div>
      ` : ''}

      ${(() => { const issues = collectIssueList(result.errorAnalysis); return issues.length ? `
        <div class="issue-list">
          <h5>需要修正</h5>
          <ul>
            ${issues.map(it => `<li>${escapeHtml(it)}</li>`).join('')}
          </ul>
        </div>
      ` : '' })()}

      ${Array.isArray(result.aiFeedbackIssues) && result.aiFeedbackIssues.length > 0 ? `
        <div class="ai-feedback-review">
          <h5>AI 評語自檢</h5>
          <ul>
            ${result.aiFeedbackIssues.map(issue => `<li>${escapeHtml(issue)}</li>`).join('')}
          </ul>
        </div>
      ` : (result.aiFeedbackOk === true ? `<div class="ai-feedback-review ok">AI 評語檢查：無明顯問題</div>` : '')}
    </div>
  `;
}
