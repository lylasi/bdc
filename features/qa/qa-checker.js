// AI智能校對模組
import { displayMessage } from '../../modules/ui.js';

// AI配置检查
let aiConfig = null;

// 延遲加載AI配置
async function loadAIConfig() {
  if (aiConfig === null) {
    try {
      const config = await import('../../ai-config.js');
      aiConfig = config.default || config;
    } catch (error) {
      console.warn('AI配置文件不可用，將使用備用模式');
      aiConfig = false; // 標記為不可用
    }
  }
  return aiConfig;
}

// 校對結果快取
const checkResultsCache = new Map();

// 开始AI校对
export async function startAIChecking(trainingResult, options = {}) {
  console.log('開始AI智能校對...');

  // 延遲加載AI配置
  await loadAIConfig();

  if (!aiConfig || !aiConfig.API_URL || !aiConfig.API_KEY) {
    displayMessage('AI服務不可用，將使用基本校對模式', 'warning');
    return performBasicChecking(trainingResult);
  }

  const __concurrent = (options.concurrent ?? (aiConfig?.QA_CHECK?.concurrent ?? true));
  const __timeout = (options.timeout ?? (aiConfig?.QA_CHECK?.timeoutMs ?? 30000));
  const __includeAnalysis = (options.includeAnalysis ?? (aiConfig?.QA_CHECK?.includeAnalysis ?? true));

  const answers = trainingResult.answers.filter(a => a.isSubmitted);

  if (answers.length === 0) {
    displayMessage('沒有已提交的答案需要校對', 'info');
    return { checkedAnswers: [], summary: null };
  }

  try {
    let checkedAnswers;

    if (__concurrent && answers.length > 1) {
      // 並發處理多個答案
      checkedAnswers = await processConcurrentChecking(answers, __timeout);
    } else {
      // 順序處理
      checkedAnswers = await processSequentialChecking(answers, __timeout);
    }

    // 生成校對總結
    const summary = (__includeAnalysis) ? generateCheckingSummary(checkedAnswers) : null;

    console.log(`AI校對完成，處理了 ${checkedAnswers.length} 個答案`);

    return {
      checkedAnswers: checkedAnswers,
      summary: summary,
      timestamp: new Date().toISOString()
    };

  } catch (error) {
    console.error('AI校對過程中出錯:', error);
    displayMessage('AI校對失敗，改用基本校對模式', 'error');
    return performBasicChecking(trainingResult);
  }
}

// 並發處理校對
async function processConcurrentChecking(answers, __timeout) {
  const promises = answers.map(answer =>
    Promise.race([
      checkSingleAnswer(answer),
      createTimeoutPromise(__timeout, answer)
    ])
  );

  const results = await Promise.allSettled(promises);

  return results.map((result, index) => {
    if (result.status === 'fulfilled') {
      return result.value;
    } else {
      console.error(`校對第 ${index + 1} 題失敗:`, result.reason);
      return createFailbackResult(answers[index]);
    }
  });
}

// 順序處理校對
async function processSequentialChecking(answers, __timeout) {
  const checkedAnswers = [];

  for (const answer of answers) {
    try {
      const result = await Promise.race([
        checkSingleAnswer(answer),
        createTimeoutPromise(__timeout, answer)
      ]);
      checkedAnswers.push(result);
    } catch (error) {
      console.error(`校對答案失敗:`, error);
      checkedAnswers.push(createFailbackResult(answer));
    }
  }

  return checkedAnswers;
}

// 校對單個答案
async function checkSingleAnswer(answer) {
  const { qid, question, correctAnswer, userAnswer } = answer;

  // 檢查快取
  const cacheKey = `${qid}_${userAnswer}`;
  if (checkResultsCache.has(cacheKey)) {
    console.log(`使用快取結果: Q${qid}`);
    return checkResultsCache.get(cacheKey);
  }

  // 基本檢查
  const isExactMatch = userAnswer.trim().toLowerCase() === correctAnswer.trim().toLowerCase();
  if (isExactMatch) {
    const result = {
      ...answer,
      isCorrect: true,
      score: 100,
      aiSuggestions: [],
      feedback: '答案完全正確！',
      checkMethod: 'exact_match'
    };
    checkResultsCache.set(cacheKey, result);
    return result;
  }

  // AI語義分析
  try {
    const aiResult = await performAIAnalysis(question, correctAnswer, userAnswer);
    const result = {
      ...answer,
      ...aiResult,
      checkMethod: 'ai_analysis'
    };

    // 合併本地標點差異（AI 可能未返回，但仍需提示）
    try {
      const __pun = analyzePunctuationDifferences(userAnswer, correctAnswer);
      if (__pun && __pun.length) {
        result.errorAnalysis = result.errorAnalysis || {};
        const existed = new Set((result.errorAnalysis.punctuation || []).map(x => String(x).toLowerCase()));
        const merged = result.errorAnalysis.punctuation ? result.errorAnalysis.punctuation.slice() : [];
        for (const msg of __pun) {
          const lower = String(msg).toLowerCase();
          if (!existed.has(lower)) { merged.push(msg); existed.add(lower); }
        }
        result.errorAnalysis.punctuation = merged;    // 也同步加入到改進建議中，確保前端可見\n      if (__pun && __pun.length) {\n        result.improvementSuggestions = Array.isArray(result.improvementSuggestions) ? result.improvementSuggestions : [];\n        for (const m of __pun) {\n          const msg = (typeof m === 'string' ? m : String(m));\n          if (!result.improvementSuggestions.includes(msg)) {\n            result.improvementSuggestions.push(msg);\n          }\n        }\n      }
      }
    } catch (_) { /* ignore */ }

    checkResultsCache.set(cacheKey, result);
    return result;

  } catch (error) {
    console.error(`AI分析失敗 Q${qid}:`, error);
    return createFailbackResult(answer);
  }
}

// AI語義分析
async function performAIAnalysis(question, correctAnswer, userAnswer) {
  if (!aiConfig) { await loadAIConfig(); }
  // 讀取 QA 專用組態
  const qaCfg = aiConfig?.QA_CHECK || {};
  const __apiUrl = qaCfg.API_URL || aiConfig.API_URL;
  const __apiKey = qaCfg.API_KEY || aiConfig.API_KEY;
  const __model = qaCfg.MODEL || (aiConfig.AI_MODELS?.answerChecking || 'gpt-4.1-mini');
  const __temperature = (qaCfg.temperature ?? 0.2);
  const __maxTokens = (qaCfg.maxTokens ?? 1500);

  const prompt = `你是一位以繁體中文回覆的英語老師。請以「標準答案」為唯一依據進行判定，並用最精簡輸出。當學生答案語義正確但與標準答案描述不一致時，仍判為正確，但必須在 teacherFeedback 指出「與答案集不一致，但表達正確」，並簡述差異點（最多 20 字）。

請回傳 JSON（不要加任何說明或程式碼圍欄），欄位如下：
{
  "overallScore": 0-100,                    // 綜合分
  "accuracy": 0-100,                        // 與標準答案語義貼近度
  "grammar": 0-100,
  "vocabulary": 0-100,
  "spelling": 0-100,
  "structure": 0-100,
  "isCorrect": true/false,                   // 是否語義正確
  "teacherFeedback": "<=60字，重點、簡短", // 若與標準答案不一致但語義正確，需明確說明
  "improvementSuggestions": ["最多2條，每條<=40字"],
  "errors": {                                // 僅在錯誤或需改進時列出具體點
    "grammar": ["具體錯點，例：時態錯誤、主謂不一致"],
    "spelling": ["具體錯字"],
    "vocabulary": ["詞義或選詞問題"],
    "structure": ["語序/連接詞/邏輯問題" ]
  }
}

資料：
題目: ${question}
標準答案: ${correctAnswer}
學生答案: ${userAnswer}

評分規則：
- 以「標準答案」為準確性判定基準。
- 當學生答案語義正確但表述不同：isCorrect=true，並在 teacherFeedback 指出不一致處；不必給大量建議。
- 當答案錯誤：在 errors.* 中列出具體可定位的錯點（短語級或詞級），並用 improvementSuggestions 指出最小修改方向；避免長篇說理。
- 回覆必須是單一 JSON 且可被 JSON.parse 解析。`;

  const response = await fetch(__apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${__apiKey}`
    },
    body: JSON.stringify({
      model: __model,
      messages: [
        {
          role: 'system',
          content: '你是一位具有20年教學經驗的資深英語教師，擅長學生答案評估和教學指導。你的評價風格溫和而專業，既要指出問題，也要給予鼓勵，幫助學生建立學習信心。你特別關注學生的語言技能發展，能夠提供具體的改進建議和學習方向。'
        },
        { role: 'user', content: prompt }
      ],
      temperature: __temperature,
      max_tokens: __maxTokens
    })
  });

  if (!response.ok) {
    throw new Error(`AI API請求失敗: ${response.status}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error('AI回應格式錯誤');
  }

  // 解析JSON回應
  const aiResult = JSON.parse(content);

  return {
    isCorrect: aiResult.isCorrect,
    score: Math.round(aiResult.overallScore || aiResult.score || 0),
    accuracy: Math.round(aiResult.accuracy || 0),
    grammar: Math.round(aiResult.grammar || 0),
    vocabulary: Math.round(aiResult.vocabulary || 0),
    spelling: Math.round(aiResult.spelling || 0),
    structure: Math.round(aiResult.structure || 0),
    strengths: aiResult.strengths || [],
    teacherFeedback: aiResult.teacherFeedback || aiResult.feedback || '',
    improvementSuggestions: aiResult.improvementSuggestions || aiResult.suggestions || [],
    studyFocus: aiResult.studyFocus || [],
    improvedExamples: aiResult.improvedExamples || [],
    explanation: aiResult.explanation || '',
    errorAnalysis: {
      grammar: aiResult.errors?.grammar || [],
      spelling: aiResult.errors?.spelling || [],
      vocabulary: aiResult.errors?.vocabulary || [],
      structure: aiResult.errors?.structure || []
    },
    // 保持向後兼容
    feedback: aiResult.teacherFeedback || aiResult.feedback || '',
    aiSuggestions: aiResult.improvementSuggestions || aiResult.suggestions || []
  };
}

// 創建超時Promise
function createTimeoutPromise(__timeout, answer) {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error(`校對超時: Q${answer.qid}`));
    }, timeout);
  });
}

// 創建備用結果
function createFailbackResult(answer) {
  const { userAnswer, correctAnswer } = answer;
  const isExactMatch = userAnswer.trim().toLowerCase() === correctAnswer.trim().toLowerCase();

  return {
    ...answer,
    isCorrect: isExactMatch,
    score: isExactMatch ? 100 : calculateBasicScore(userAnswer, correctAnswer),
    feedback: isExactMatch ? '答案正確' : '答案與標準答案不完全匹配',
    aiSuggestions: [],
    errorAnalysis: {},
    checkMethod: 'basic_check'
  };
}

// 基本校對模式
function performBasicChecking(trainingResult) {
  const answers = trainingResult.answers.filter(a => a.isSubmitted);

  const checkedAnswers = answers.map(answer => {
    const { userAnswer, correctAnswer } = answer;
    const isExactMatch = userAnswer.trim().toLowerCase() === correctAnswer.trim().toLowerCase();

    return {
      ...answer,
      isCorrect: isExactMatch,
      score: isExactMatch ? 100 : calculateBasicScore(userAnswer, correctAnswer),
      feedback: isExactMatch ? '答案正確' : '請檢查答案的準確性',
      aiSuggestions: [],
      errorAnalysis: {},
      checkMethod: 'basic_only'
    };
  });

  const summary = generateCheckingSummary(checkedAnswers);

  return {
    checkedAnswers: checkedAnswers,
    summary: summary,
    timestamp: new Date().toISOString()
  };
}

// 計算基本分數
function calculateBasicScore(userAnswer, correctAnswer) {
  if (!userAnswer || !correctAnswer) return 0;

  const user = userAnswer.trim().toLowerCase();
  const correct = correctAnswer.trim().toLowerCase();

  if (user === correct) return 100;

  // 使用編輯距離計算相似度
  const distance = calculateEditDistance(user, correct);
  const maxLength = Math.max(user.length, correct.length);
  const similarity = (maxLength - distance) / maxLength;

  return Math.max(0, Math.round(similarity * 100));
}

// 計算編輯距離
function calculateEditDistance(str1, str2) {
  const matrix = [];

  for (let i = 0; i <= str2.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= str1.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= str2.length; i++) {
    for (let j = 1; j <= str1.length; j++) {
      if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  return matrix[str2.length][str1.length];
}

// 生成校對總結
function generateCheckingSummary(checkedAnswers) {
  const totalAnswers = checkedAnswers.length;
  const correctAnswers = checkedAnswers.filter(a => a.isCorrect).length;
  const averageScore = checkedAnswers.reduce((sum, a) => sum + a.score, 0) / totalAnswers;

  // 錯誤類型統計
  const errorTypes = {
    spelling: 0,
    grammar: 0,
    vocabulary: 0,
    semantic: 0
  };

  checkedAnswers.forEach(answer => {
    if (!answer.isCorrect && answer.errorAnalysis) {
      const errors = answer.errorAnalysis;
      if (errors.spelling?.length > 0) errorTypes.spelling++;
      if (errors.grammar?.length > 0) errorTypes.grammar++;
      if (errors.vocabulary?.length > 0) errorTypes.vocabulary++;
      if (answer.semanticSimilarity < 70) errorTypes.semantic++;
    }
  });

  // 分數分佈
  const scoreDistribution = {
    excellent: checkedAnswers.filter(a => a.score >= 90).length,
    good: checkedAnswers.filter(a => a.score >= 70 && a.score < 90).length,
    fair: checkedAnswers.filter(a => a.score >= 50 && a.score < 70).length,
    poor: checkedAnswers.filter(a => a.score < 50).length
  };

  return {
    totalAnswers,
    correctAnswers,
    accuracy: Math.round((correctAnswers / totalAnswers) * 100),
    averageScore: Math.round(averageScore),
    errorTypes,
    scoreDistribution,
    recommendedActions: generateRecommendations(checkedAnswers)
  };
}

// 生成學習建議
function generateRecommendations(checkedAnswers) {
  const recommendations = [];
  const incorrectAnswers = checkedAnswers.filter(a => !a.isCorrect);

  if (incorrectAnswers.length === 0) {
    recommendations.push('太棒了！所有答案都正確，繼續保持！');
    return recommendations;
  }

  // 分析錯誤模式
  const spellingErrors = incorrectAnswers.filter(a =>
    a.errorAnalysis?.spelling?.length > 0 || a.spellingAccuracy < 70
  ).length;

  const grammarErrors = incorrectAnswers.filter(a =>
    a.errorAnalysis?.grammar?.length > 0 || a.grammarCorrectness < 70
  ).length;

  if (spellingErrors > incorrectAnswers.length * 0.5) {
    recommendations.push('建議多練習單詞拼寫，可以使用拼寫檢查工具');
  }

  if (grammarErrors > incorrectAnswers.length * 0.5) {
    recommendations.push('建議複習相關語法規則，多做語法練習');
  }

  if (checkedAnswers.filter(a => a.score < 50).length > 0) {
    recommendations.push('有些答案需要重點關注，建議重新學習相關內容');
  }

  return recommendations;
}

// 清除校對快取
export function clearCheckingCache() {
  checkResultsCache.clear();
  console.log('校對快取已清除');
}

// 獲取快取統計
export function getCheckingCacheStats() {
  return {
    size: checkResultsCache.size,
    keys: Array.from(checkResultsCache.keys()).slice(0, 10) // 只顯示前10個
  };
}

// 批次校對答案
export async function batchCheckAnswers(answers, options = {}) {
  console.log(`開始批次校對 ${answers.length} 個答案...`);

  const trainingResult = {
    answers: answers.map(a => ({ ...a, isSubmitted: true }))
  };

  return await startAIChecking(trainingResult, options);
}

// 重新校對特定答案
export async function recheckAnswer(answer, forceAI = false) {
  await loadAIConfig();
  const cacheKey = `${answer.qid}_${answer.userAnswer}`;

  if (forceAI) {
    checkResultsCache.delete(cacheKey);
  }

  return await checkSingleAnswer(answer);
}

// 導出校對單個答案的函數供外部使用
export { checkSingleAnswer };

// 基礎標點差異分析（缺少/多出/錯用）
function analyzePunctuationDifferences(userAnswer = '', correctAnswer = '') {
  const PUNC = [",", ".", "?", "!", ";", ":", '"', "'", "-", "—", "(", ")"];
  const count = (s) => {
    const m = new Map();
    for (const ch of (s || '')) {
      if (PUNC.includes(ch)) m.set(ch, (m.get(ch) || 0) + 1);
    }
    return m;
  };
  const u = count(userAnswer);
  const c = count(correctAnswer);
  const msgs = [];
  for (const ch of PUNC) {
    const du = u.get(ch) || 0;
    const dc = c.get(ch) || 0;
    if (du < dc) msgs.push("缺少標點 '" + ch + "'");
    if (du > dc) msgs.push("多餘標點 '" + ch + "'");
  }
  return msgs;
}