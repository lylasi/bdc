// QA專用存儲方法
import { displayMessage } from '../../modules/ui.js';

// 問答集存儲的localStorage鍵名
const QA_SETS_KEY = 'qa-sets';
const QA_MANIFEST_KEY = 'qa-manifest';

// 預置問答集清單
let presetQASets = [];

// 載入預置問答集清單
async function loadPresetManifest() {
  try {
    const response = await fetch('./qa-sets/manifest.json');
    if (!response.ok) {
      console.warn('預置問答集清單載入失敗');
      return [];
    }
    const manifest = await response.json();
    console.log('預置問答集清單載入成功:', manifest.length, '個問答集');
    return manifest;
  } catch (error) {
    console.warn('載入預置問答集清單時出錯:', error);
    return [];
  }
}

// 載入單個預置問答集
async function loadPresetQASet(manifestItem) {
  try {
    const response = await fetch(`./${manifestItem.path}`);
    if (!response.ok) {
      console.warn('預置問答集載入失敗:', manifestItem.path);
      return null;
    }
    const qaSet = await response.json();

    // 添加預置標記和清單信息
    qaSet.isPreset = true;
    qaSet.category = manifestItem.category || qaSet.category || '未分類';
    qaSet.questionCount = qaSet.questions?.length || 0;
    qaSet.difficulty = qaSet.difficulty || 'unknown';
    qaSet.createdAt = qaSet.createdAt || new Date().toISOString();

    console.log(`預置問答集載入成功: ${qaSet.name}`);
    return qaSet;
  } catch (error) {
    console.error('載入預置問答集時出錯:', manifestItem.path, error);
    return null;
  }
}

// 從localStorage載入用戶創建的問答集清單
export function getStoredQASets() {
  try {
    const stored = localStorage.getItem(QA_SETS_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch (error) {
    console.error('載入用戶問答集清單時出錯:', error);
    return [];
  }
}

// 獲取所有問答集（預置 + 用戶創建）
export async function getAllQASets() {
  try {
    // 載入預置問答集清單
    if (presetQASets.length === 0) {
      const manifest = await loadPresetManifest();
      presetQASets = manifest.map(item => ({
        id: item.id,
        name: item.name,
        category: item.category,
        description: `預置問答集`,
        isPreset: true,
        questionCount: 0, // 將在載入時更新
        difficulty: 'unknown',
        createdAt: new Date().toISOString(),
        path: item.path
      }));
    }

    // 載入用戶創建的問答集
    const userQASets = getStoredQASets();

    // 合併並返回
    const allSets = [...presetQASets, ...userQASets];
    console.log(`載入所有問答集: ${presetQASets.length} 個預置 + ${userQASets.length} 個用戶創建`);

    return allSets;
  } catch (error) {
    console.error('載入所有問答集時出錯:', error);
    return getStoredQASets(); // 降級到只返回用戶創建的問答集
  }
}

// 儲存問答集清單到localStorage
export function saveQASetsManifest(qaSets) {
  try {
    localStorage.setItem(QA_SETS_KEY, JSON.stringify(qaSets));
    console.log('問答集清單已儲存');
    return true;
  } catch (error) {
    console.error('儲存問答集清單時出錯:', error);
    return false;
  }
}

// 載入單一問答集
export async function loadQASet(id) {
  try {
    // 首先嘗試從localStorage載入（用戶創建的問答集）
    const key = `qa-set-${id}`;
    const stored = localStorage.getItem(key);
    if (stored) {
      const qaSet = JSON.parse(stored);
      console.log(`從localStorage載入問答集: ${qaSet.name}`);
      return qaSet;
    }

    // 如果localStorage中沒有，嘗試從預置問答集載入
    const manifest = await loadPresetManifest();
    const manifestItem = manifest.find(item => item.id === id);

    if (manifestItem) {
      const qaSet = await loadPresetQASet(manifestItem);
      if (qaSet) {
        console.log(`從預置文件載入問答集: ${qaSet.name}`);
        return qaSet;
      }
    }

    console.warn(`找不到問答集: ${id}`);
    return null;
  } catch (error) {
    console.error(`載入問答集 ${id} 時出錯:`, error);
    return null;
  }
}

// 儲存問答集
export function saveQASet(qaSet) {
  try {
    // 數據完整性驗證
    if (!validateQASet(qaSet)) {
      throw new Error('問答集數據格式無效');
    }

    const key = `qa-set-${qaSet.id}`;
    localStorage.setItem(key, JSON.stringify(qaSet));

    // 更新清單
    updateQASetsManifest(qaSet);

    console.log(`問答集已儲存: ${qaSet.name}`);
    return true;
  } catch (error) {
    console.error('儲存問答集時出錯:', error);
    displayMessage('儲存問答集失敗: ' + error.message, 'error');
    return false;
  }
}

// 刪除問答集
export async function deleteQASet(id) {
  try {
    // 檢查是否為預置問答集
    const manifest = await loadPresetManifest();
    const isPreset = manifest.some(item => item.id === id);

    if (isPreset) {
      throw new Error('無法刪除預置問答集');
    }

    const key = `qa-set-${id}`;

    // 檢查問答集是否存在
    const qaSet = await loadQASet(id);
    if (!qaSet) {
      throw new Error('問答集不存在');
    }

    if (qaSet.isPreset) {
      throw new Error('無法刪除預置問答集');
    }

    // 從localStorage刪除
    localStorage.removeItem(key);

    // 從清單中移除
    removeFromQASetsManifest(id);

    console.log(`問答集已刪除: ${id}`);
    return true;
  } catch (error) {
    console.error('刪除問答集時出錯:', error);
    displayMessage('刪除問答集失敗: ' + error.message, 'error');
    return false;
  }
}

// 導入問答集（從JSON文件）
export async function importQASet(file) {
  try {
    const text = await file.text();
    const qaSet = JSON.parse(text);

    // 驗證導入的數據
    if (!validateQASet(qaSet)) {
      throw new Error('導入的問答集格式無效');
    }

    // 檢查是否已存在相同ID的問答集
    const existing = await loadQASet(qaSet.id);
    if (existing) {
      const confirmed = confirm(`問答集 "${qaSet.name}" 已存在，是否覆蓋？`);
      if (!confirmed) {
        return false;
      }
    }

    // 儲存問答集
    return saveQASet(qaSet);
  } catch (error) {
    console.error('導入問答集時出錯:', error);
    displayMessage('導入問答集失敗: ' + error.message, 'error');
    return false;
  }
}

// 導出問答集
export async function exportQASet(id, format = 'json') {
  try {
    const qaSet = await loadQASet(id);
    if (!qaSet) {
      throw new Error('問答集不存在');
    }

    let content, filename, mimeType;

    if (format === 'json') {
      content = JSON.stringify(qaSet, null, 2);
      filename = `${qaSet.name}_${qaSet.id}.json`;
      mimeType = 'application/json';
    } else {
      throw new Error('不支援的導出格式');
    }

    // 創建下載連結
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    console.log(`問答集已導出: ${filename}`);
    return true;
  } catch (error) {
    console.error('導出問答集時出錯:', error);
    displayMessage('導出問答集失敗: ' + error.message, 'error');
    return false;
  }
}

// 驗證問答集數據格式
function validateQASet(qaSet) {
  if (!qaSet || typeof qaSet !== 'object') {
    return false;
  }

  // 必需欄位檢查
  const requiredFields = ['id', 'name', 'questions'];
  for (const field of requiredFields) {
    if (!qaSet[field]) {
      console.error(`缺少必需欄位: ${field}`);
      return false;
    }
  }

  // 問題陣列檢查
  if (!Array.isArray(qaSet.questions) || qaSet.questions.length === 0) {
    console.error('問題陣列無效或為空');
    return false;
  }

  // 驗證每個問題
  for (const question of qaSet.questions) {
    if (!question.qid || !question.question || !question.answer) {
      console.error('問題格式無效:', question);
      return false;
    }
  }

  return true;
}

// 更新問答集清單
function updateQASetsManifest(qaSet) {
  const qaSets = getStoredQASets();
  const existingIndex = qaSets.findIndex(item => item.id === qaSet.id);

  const manifestItem = {
    id: qaSet.id,
    name: qaSet.name,
    category: qaSet.category || '未分類',
    questionCount: qaSet.questions.length,
    difficulty: qaSet.difficulty || 'unknown',
    description: qaSet.description || '',
    createdAt: qaSet.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  if (existingIndex >= 0) {
    qaSets[existingIndex] = manifestItem;
  } else {
    qaSets.push(manifestItem);
  }

  saveQASetsManifest(qaSets);
}

// 從清單中移除問答集
function removeFromQASetsManifest(id) {
  const qaSets = getStoredQASets();
  const filteredSets = qaSets.filter(item => item.id !== id);
  saveQASetsManifest(filteredSets);
}

// 獲取問答集統計資訊
export function getQASetStats() {
  const qaSets = getStoredQASets();
  return {
    totalSets: qaSets.length,
    totalQuestions: qaSets.reduce((sum, set) => sum + (set.questionCount || 0), 0),
    categories: [...new Set(qaSets.map(set => set.category))],
    difficulties: [...new Set(qaSets.map(set => set.difficulty))]
  };
}

// 數據恢復和備份
export async function backupQAData() {
  try {
    const qaSets = getStoredQASets();
    const allData = { manifest: qaSets, sets: {} };

    // 載入所有問答集數據
    for (const item of qaSets) {
      const qaSet = await loadQASet(item.id);
      if (qaSet) {
        allData.sets[item.id] = qaSet;
      }
    }

    const backup = JSON.stringify(allData, null, 2);
    const filename = `qa_backup_${new Date().toISOString().split('T')[0]}.json`;

    const blob = new Blob([backup], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    console.log('問答數據備份完成');
    return true;
  } catch (error) {
    console.error('備份問答數據時出錯:', error);
    return false;
  }
}

// 清理過期的緩存數據
export function cleanupExpiredCache() {
  const keys = Object.keys(localStorage);
  let cleanedCount = 0;

  for (const key of keys) {
    if (key.startsWith('qa-cache-')) {
      try {
        const cached = JSON.parse(localStorage.getItem(key));
        if (cached.expiry && Date.now() > cached.expiry) {
          localStorage.removeItem(key);
          cleanedCount++;
        }
      } catch (error) {
        // 無效的緩存數據，直接刪除
        localStorage.removeItem(key);
        cleanedCount++;
      }
    }
  }

  if (cleanedCount > 0) {
    console.log(`清理了 ${cleanedCount} 個過期的緩存項目`);
  }
}