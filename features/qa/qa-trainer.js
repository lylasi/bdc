// 問答訓練邏輯和會話管理
import { loadQASet } from './qa-storage.js';
import { displayMessage } from '../../modules/ui.js';

// 訓練狀態管理
let currentSession = {
  qaSetId: null,
  qaSet: null,
  questions: [],
  currentIndex: 0,
  answers: [],
  mode: 'sequential', // sequential | random
  submitMode: 'single', // single | batch
  isActive: false,
  startTime: null,
  isPaused: false
};

// 開始訓練
export async function startTraining(qaSetId, options = {}) {
  console.log(`開始問答訓練: ${qaSetId}`);

  try {
    // 載入問答集
    const qaSet = await loadQASet(qaSetId);
    if (!qaSet) {
      throw new Error('找不到指定的問答集');
    }

    // 初始化訓練會話
    currentSession = {
      qaSetId: qaSetId,
      qaSet: qaSet,
      questions: [...qaSet.questions],
      currentIndex: 0,
      answers: [],
      mode: options.mode || 'sequential',
      submitMode: options.submitMode || 'single',
      isActive: true,
      startTime: new Date(),
      isPaused: false
    };

    // 如果是隨機模式，打亂問題順序
    if (currentSession.mode === 'random') {
      shuffleQuestions();
    }

    // 初始化答案數組
    currentSession.answers = currentSession.questions.map(() => ({
      userAnswer: '',
      isSubmitted: false,
      timestamp: null
    }));

    console.log(`訓練開始: ${qaSet.name}, 共 ${currentSession.questions.length} 題`);
    return true;

  } catch (error) {
    console.error('開始訓練時出錯:', error);
    displayMessage('訓練啟動失敗: ' + error.message, 'error');
    return false;
  }
}

// 打亂問題順序
export function shuffleQuestions() {
  if (!currentSession.questions) return;

  for (let i = currentSession.questions.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [currentSession.questions[i], currentSession.questions[j]] =
    [currentSession.questions[j], currentSession.questions[i]];
  }

  console.log('問題順序已隨機化');
}

// 提交答案
// 統一行為：保存答案（不區分提交/保存）。
// 若內容非空，將 isSubmitted 派生為 true；否則為 false。
export function submitAnswer(answer, questionIndex = null) {
  if (!currentSession.isActive) {
    throw new Error('沒有活動的訓練會話');
  }

  const index = questionIndex !== null ? questionIndex : currentSession.currentIndex;

  if (index < 0 || index >= currentSession.questions.length) {
    throw new Error('無效的問題索引');
  }

  const text = String(answer ?? '').trim();
  // 更新答案（派生 isSubmitted）
  currentSession.answers[index] = {
    userAnswer: text,
    isSubmitted: text.length > 0,
    timestamp: new Date()
  };

  console.log(`已保存第 ${index + 1} 題答案`);
  return true;
}

// 保存當前題目的「草稿」答案（與 submitAnswer 等價：都只是保存）。
// 用途：在使用者切換上一題/下一題或其它操作時，保留輸入框內容，避免返回後遺失。
export function saveAnswerDraft(answer, questionIndex = null) {
  if (!currentSession.isActive) {
    throw new Error('沒有活動的訓練會話');
  }

  const index = questionIndex !== null ? questionIndex : currentSession.currentIndex;

  if (index < 0 || index >= currentSession.questions.length) {
    throw new Error('無效的問題索引');
  }

  const prev = currentSession.answers[index] || { userAnswer: '', isSubmitted: false, timestamp: null };
  const text = String(answer ?? '').trim();
  // 更新使用者輸入內容；isSubmitted 由內容是否為空派生
  currentSession.answers[index] = {
    ...prev,
    userAnswer: text,
    isSubmitted: text.length > 0,
    timestamp: prev.timestamp || new Date()
  };

  return true;
}

// 下一題
export function nextQuestion() {
  if (!currentSession.isActive) {
    throw new Error('沒有活動的訓練會話');
  }

  if (currentSession.currentIndex < currentSession.questions.length - 1) {
    currentSession.currentIndex++;
    console.log(`移至第 ${currentSession.currentIndex + 1} 題`);
    return true;
  } else {
    console.log('已到達最後一題');
    return false;
  }
}

// 上一題
export function previousQuestion() {
  if (!currentSession.isActive) {
    throw new Error('沒有活動的訓練會話');
  }

  if (currentSession.currentIndex > 0) {
    currentSession.currentIndex--;
    console.log(`移至第 ${currentSession.currentIndex + 1} 題`);
    return true;
  } else {
    console.log('已在第一題');
    return false;
  }
}

// 跳到指定題目
export function goToQuestion(index) {
  if (!currentSession.isActive) {
    throw new Error('沒有活動的訓練會話');
  }

  if (index < 0 || index >= currentSession.questions.length) {
    throw new Error('無效的問題索引');
  }

  currentSession.currentIndex = index;
  console.log(`跳至第 ${index + 1} 題`);
  return true;
}

// 完成訓練
export function finishTraining() {
  if (!currentSession.isActive) {
    throw new Error('沒有活動的訓練會話');
  }

  // 檢查是否所有問題都已回答（以是否有內容判斷）
  const unansweredCount = currentSession.answers.filter(a => !(a.userAnswer && a.userAnswer.trim().length > 0)).length;

  if (unansweredCount > 0) {
    const confirmed = confirm(`還有 ${unansweredCount} 題未回答，確定要完成訓練嗎？`);
    if (!confirmed) {
      return false;
    }
  }

  // 計算訓練時間
  const endTime = new Date();
  const duration = endTime - currentSession.startTime;

  // 準備訓練結果
  const trainingResult = {
    qaSetId: currentSession.qaSetId,
    qaSetName: currentSession.qaSet.name,
    totalQuestions: currentSession.questions.length,
    answeredQuestions: currentSession.answers.filter(a => (a.userAnswer && a.userAnswer.trim().length > 0)).length,
    answers: currentSession.questions.map((question, index) => ({
      qid: question.qid,
      question: question.question,
      correctAnswer: question.answer,
      userAnswer: currentSession.answers[index].userAnswer || '',
      // 兼容欄位：有內容即視為已答
      isSubmitted: !!(currentSession.answers[index].userAnswer && currentSession.answers[index].userAnswer.trim().length > 0)
    })),
    startTime: currentSession.startTime,
    endTime: endTime,
    duration: duration,
    mode: currentSession.mode,
    submitMode: currentSession.submitMode
  };

  // 結束會話
  currentSession.isActive = false;

  console.log('訓練完成:', trainingResult);
  return trainingResult;
}

// 暫停訓練
export function pauseTraining() {
  if (!currentSession.isActive) {
    throw new Error('沒有活動的訓練會話');
  }

  currentSession.isPaused = true;
  console.log('訓練已暫停');
  return true;
}

// 恢復訓練
export function resumeTraining() {
  if (!currentSession.isActive) {
    throw new Error('沒有活動的訓練會話');
  }

  currentSession.isPaused = false;
  console.log('訓練已恢復');
  return true;
}

// 取消訓練
export function cancelTraining() {
  if (!currentSession.isActive) {
    return true;
  }

  const confirmed = confirm('確定要取消當前訓練嗎？所有進度將會遺失。');
  if (confirmed) {
    resetSession();
    console.log('訓練已取消');
    return true;
  }
  return false;
}

// 重置會話
function resetSession() {
  currentSession = {
    qaSetId: null,
    qaSet: null,
    questions: [],
    currentIndex: 0,
    answers: [],
    mode: 'sequential',
    submitMode: 'single',
    isActive: false,
    startTime: null,
    isPaused: false
  };
}

// 獲取當前問題
export function getCurrentQuestion() {
  if (!currentSession.isActive) {
    return null;
  }

  if (currentSession.currentIndex >= 0 && currentSession.currentIndex < currentSession.questions.length) {
    return currentSession.questions[currentSession.currentIndex];
  }

  return null;
}

// 獲取當前答案
export function getCurrentAnswer() {
  if (!currentSession.isActive) {
    return '';
  }

  if (currentSession.currentIndex >= 0 && currentSession.currentIndex < currentSession.answers.length) {
    return currentSession.answers[currentSession.currentIndex].userAnswer || '';
  }

  return '';
}

// 獲取訓練進度
export function getTrainingProgress() {
  if (!currentSession.isActive) {
    return null;
  }

  const answeredCount = currentSession.answers.filter(a => (a.userAnswer && a.userAnswer.trim().length > 0)).length;
  const totalCount = currentSession.questions.length;
  const currentIndex = currentSession.currentIndex;

  return {
    currentIndex: currentIndex,
    currentNumber: currentIndex + 1,
    totalQuestions: totalCount,
    answeredQuestions: answeredCount,
    progressPercentage: Math.round((currentIndex / totalCount) * 100),
    completionPercentage: Math.round((answeredCount / totalCount) * 100)
  };
}

// 獲取會話狀態
export function getSessionState() {
  return {
    isActive: currentSession.isActive,
    isPaused: currentSession.isPaused,
    qaSetId: currentSession.qaSetId,
    qaSetName: currentSession.qaSet?.name || null,
    mode: currentSession.mode,
    submitMode: currentSession.submitMode,
    startTime: currentSession.startTime
  };
}

// 驗證訓練設置
export function validateTrainingOptions(options) {
  const errors = [];

  if (options.mode && !['sequential', 'random'].includes(options.mode)) {
    errors.push('無效的訓練模式');
  }

  if (options.submitMode && !['single', 'batch'].includes(options.submitMode)) {
    errors.push('無效的提交模式');
  }

  return {
    isValid: errors.length === 0,
    errors: errors
  };
}

// 保存訓練進度（用於恢復）
export function saveTrainingProgress() {
  if (!currentSession.isActive) {
    return false;
  }

  try {
    const progressData = {
      session: currentSession,
      savedAt: new Date().toISOString()
    };

    localStorage.setItem('qa-training-progress', JSON.stringify(progressData));
    console.log('訓練進度已保存');
    return true;
  } catch (error) {
    console.error('保存訓練進度時出錯:', error);
    return false;
  }
}

// 恢復訓練進度
export function restoreTrainingProgress() {
  try {
    const stored = localStorage.getItem('qa-training-progress');
    if (!stored) {
      return false;
    }

    const progressData = JSON.parse(stored);
    const savedAt = new Date(progressData.savedAt);
    const now = new Date();

    // 檢查是否過期（24小時）
    if (now - savedAt > 24 * 60 * 60 * 1000) {
      localStorage.removeItem('qa-training-progress');
      console.log('訓練進度已過期，已清除');
      return false;
    }

    // 恢復會話狀態
    currentSession = progressData.session;

    console.log('訓練進度已恢復');
    return true;
  } catch (error) {
    console.error('恢復訓練進度時出錯:', error);
    localStorage.removeItem('qa-training-progress');
    return false;
  }
}

// 清除保存的進度
export function clearSavedProgress() {
  localStorage.removeItem('qa-training-progress');
  console.log('已清除保存的訓練進度');
}
