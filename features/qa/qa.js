// 問答訓練模組主入口
import * as dom from '../../modules/dom.js';
import * as state from '../../modules/state.js';
import { getStoredQASets, getAllQASets, loadQASet, saveQASet, deleteQASet, importQASet, exportQASet, getQASetStats, cleanupExpiredCache } from './qa-storage.js';
import { initCreator, parseQAPairs, saveNewSet, clearForm, handleTextInputChange } from './qa-creator.js';
import { startTraining, getCurrentQuestion, getCurrentAnswer, getTrainingProgress, getSessionState, submitAnswer, nextQuestion, previousQuestion, finishTraining, pauseTraining, resumeTraining, cancelTraining, restoreTrainingProgress, saveTrainingProgress } from './qa-trainer.js';
import { startAIChecking, clearCheckingCache, getCheckingCacheStats, recheckAnswer } from './qa-checker.js';
import { exportTrainingResultToPDF, exportQASetForHandwriting } from './qa-pdf.js';
import { displayMessage, showOptionsModal } from '../../modules/ui.js';

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
      createBtn.addEventListener('click', showCreatorView);
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
    qaModuleState.qaSets = await getAllQASets();

    console.log(`載入完成: ${qaModuleState.qaSets.length} 個問答集`);

    // 更新顯示
    updateQASetsDisplay();

  } catch (error) {
    console.error('載入問答集時出錯:', error);
    displayMessage('載入問答集失敗', 'error');

    // 降級到只顯示用戶創建的問答集
    qaModuleState.qaSets = getStoredQASets();
    updateQASetsDisplay();
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
  listContainer.addEventListener('click', handleQASetCardClick);
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
        <button class="btn small secondary export-btn">導出</button>
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
  } else if (button.classList.contains('export-btn')) {
    handleQASetExport(qaId);
  } else if (button.classList.contains('delete-btn')) {
    handleDeleteQASet(qaId);
  }
}

// 開始問答訓練
async function startQATraining(qaId) {
  console.log(`開始問答訓練: ${qaId}`);

  try {
    // 檢查是否有進行中的訓練
    const sessionState = getSessionState();
    if (sessionState.isActive) {
      const confirmed = confirm('已有進行中的訓練，是否要開始新的訓練？');
      if (!confirmed) {
        return;
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
    // 獲取表單數據
    const nameInput = document.getElementById('qa-set-name');
    const descInput = document.getElementById('qa-set-description');
    const pairsInput = document.getElementById('qa-pairs-input');

    if (!nameInput || !descInput || !pairsInput) {
      throw new Error('找不到表單元素');
    }

    const name = nameInput.value.trim();
    const description = descInput.value.trim();
    const text = pairsInput.value.trim();

    // 解析問答對
    const pairs = parseQAPairs(text);

    // 保存問答集
    const savedQASet = saveNewSet(name, description, pairs);

    if (savedQASet) {
      // 更新本地狀態
      qaModuleState.qaSets.push({
        id: savedQASet.id,
        name: savedQASet.name,
        category: savedQASet.category,
        questionCount: savedQASet.questions.length,
        difficulty: savedQASet.difficulty,
        description: savedQASet.description,
        isPreset: false
      });

      // 更新顯示
      updateQASetsDisplay();

      // 顯示成功消息
      displayMessage(`問答集 "${savedQASet.name}" 保存成功！`, 'success');

      // 返回管理視圖
      setTimeout(() => {
        showManagementView();
      }, 1000);
    }

  } catch (error) {
    console.error('保存問答集時出錯:', error);
    displayMessage('保存失敗: ' + error.message, 'error');
  }
}

// 顯示管理視圖
function showManagementView() {
  setActiveView('management');
  qaModuleState.currentView = 'management';
  clearInstantFeedbackArea();
}

// 顯示創建視圖
function showCreatorView() {
  setActiveView('creator');
  qaModuleState.currentView = 'creator';

  // 初始化創建器（如果尚未初始化）
  setTimeout(() => {
    initCreator();
    clearForm(); // 清空表單
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
          <div>🎯 平均分數: ${checkingResult.summary?.averageScore || 0}分</div>
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
            <span class="stat-label">平均分數</span>
            <span class="stat-value">${summary.averageScore}</span>
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
    const resultClass = answer.isCorrect ? 'ai-checked-result' :
                       answer.score >= 70 ? 'ai-checked-result partial' :
                       'ai-checked-result incorrect';
    const questionNumber = typeof answer.displayIndex === 'number' ?
      answer.displayIndex + 1 : index + 1;

    const difference = !answer.isCorrect ? createDifferenceAnalysis(answer.userAnswer, answer.correctAnswer) : null;

    const userAnswerContent = answer.userAnswer
      ? (difference ? difference.userHighlighted : escapeHtml(answer.userAnswer))
      : '<span class="no-answer">未作答</span>';
    const correctAnswerContent = answer.correctAnswer
      ? (difference ? difference.correctHighlighted : escapeHtml(answer.correctAnswer))
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

    html += `
      <div class="result-item ${resultClass}">
        <div class="result-header">
          <span class="question-number">Q${questionNumber}</span>
          <span class="ai-score">${typeof answer.score === 'number' ? answer.score : 0}分</span>
          <span class="result-status">${answer.isCorrect ? '完全正確' : answer.score >= 70 ? '部分符合' : '需加強'}</span>
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

        ${answer.errorAnalysis && (answer.errorAnalysis.spelling?.length > 0 || answer.errorAnalysis.grammar?.length > 0 || answer.errorAnalysis.vocabulary?.length > 0 || answer.errorAnalysis.structure?.length > 0 || answer.errorAnalysis.punctuation?.length > 0) ? `
          <div class="error-analysis">
            <h5>錯誤類型</h5>
            ${answer.errorAnalysis.spelling?.length > 0 ? `
              <div class="error-category">
                <strong>拼寫錯誤:</strong>
                <ul class="error-list">
                  ${answer.errorAnalysis.spelling.map(error => `<li class="spelling-error">${escapeHtml(error)}</li>`).join('')}
                </ul>
              </div>
            ` : ''}
            ${answer.errorAnalysis.grammar?.length > 0 ? `
              <div class="error-category">
                <strong>文法錯誤:</strong>
                <ul class="error-list">
                  ${answer.errorAnalysis.grammar.map(error => `<li class="grammar-error">${escapeHtml(error)}</li>`).join('')}
                </ul>
              </div>
            ` : ''}
            ${answer.errorAnalysis.vocabulary?.length > 0 ? `
              <div class="error-category">
                <strong>字彙使用:</strong>
                <ul class="error-list">
                  ${answer.errorAnalysis.vocabulary.map(error => `<li class="vocabulary-error">${escapeHtml(error)}</li>`).join('')}
                </ul>
              </div>
            ` : ''}
            ${answer.errorAnalysis.structure?.length > 0 ? `
              <div class="error-category">
                <strong>句構表達:</strong>
                <ul class="error-list">
                  ${answer.errorAnalysis.structure.map(error => `<li class="structure-error">${escapeHtml(error)}</li>`).join('')}
                </ul>
              </div>
            ` : ''}
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
        <span class="ai-score">${typeof result.score === 'number' ? result.score : 0}分</span>
        <span class="result-status">${result.isCorrect ? '完全正確' : result.score >= 70 ? '部分符合' : '需加強'}</span>
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

      ${result.errorAnalysis && (result.errorAnalysis.spelling?.length > 0 || result.errorAnalysis.grammar?.length > 0 || result.errorAnalysis.vocabulary?.length > 0 || result.errorAnalysis.structure?.length > 0 || result.errorAnalysis.punctuation?.length > 0) ? `
        <div class="error-analysis">
          <h5>錯誤類型</h5>
          ${result.errorAnalysis.spelling?.length > 0 ? `
            <div class="error-category">
              <strong>拼寫錯誤:</strong>
              <ul class="error-list">
                ${result.errorAnalysis.spelling.map(error => `<li>${escapeHtml(error)}</li>`).join('')}
              </ul>
            </div>
          ` : ''}
          ${result.errorAnalysis.grammar?.length > 0 ? `
            <div class="error-category">
              <strong>文法錯誤:</strong>
              <ul class="error-list">
                ${result.errorAnalysis.grammar.map(error => `<li>${escapeHtml(error)}</li>`).join('')}
              </ul>
            </div>
          ` : ''}
          ${result.errorAnalysis.vocabulary?.length > 0 ? `
            <div class="error-category">
              <strong>字彙使用:</strong>
              <ul class="error-list">
                ${result.errorAnalysis.vocabulary.map(error => `<li>${escapeHtml(error)}</li>`).join('')}
              </ul>
            </div>
          ` : ''}
          ${result.errorAnalysis.structure?.length > 0 ? `
            <div class="error-category">
              <strong>句構表達:</strong>
              <ul class="error-list">
                ${result.errorAnalysis.structure.map(error => `<li>${escapeHtml(error)}</li>`).join('')}
              </ul>
            </div>
          ` : ''}
        </div>
      ` : ''}
    </div>
  `;
}
