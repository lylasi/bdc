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

// 小工具：簡易模板替換 ${name}
function applyTemplate(tpl, vars = {}) {
  if (!tpl) return '';
  let s = String(tpl);
  for (const k of Object.keys(vars)) {
    try { s = s.split('${' + k + '}').join(String(vars[k])); } catch (_) {}
  }
  return s;
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

  // 先走本地快速前置檢查，攔截明顯錯誤/空白/敷衍回覆，避免模型誤判
  try {
    const pre = ruleBasedPrecheck(question, correctAnswer, userAnswer);
    if (pre && pre.intercept) {
      const preResult = { ...answer, ...pre.payload, checkMethod: 'precheck' };
      checkResultsCache.set(cacheKey, preResult);
      return preResult;
    }
  } catch (_) {}

  // 本地不做過多限制與評分，統一交由 AI 判定

  // AI語義分析
  try {
    const aiResult = await performAIAnalysis(question, correctAnswer, userAnswer);
    const result = {
      ...answer,
      ...aiResult,
      checkMethod: 'ai_analysis'
    };

    // 本地不再主動合併格式/標點檢查，完全交給 AI 回傳

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
  // 端點：PROFILE > API_URL/API_KEY > 全域
  let __apiUrl = qaCfg.API_URL || '';
  let __apiKey = qaCfg.API_KEY || '';
  if (!__apiUrl && qaCfg.PROFILE && aiConfig.AI_PROFILES && aiConfig.AI_PROFILES[qaCfg.PROFILE]) {
    __apiUrl = aiConfig.AI_PROFILES[qaCfg.PROFILE].apiUrl || '';
    __apiKey = aiConfig.AI_PROFILES[qaCfg.PROFILE].apiKey || __apiKey;
  }
  if (!__apiUrl) __apiUrl = aiConfig.API_URL;
  if (!__apiKey) __apiKey = aiConfig.API_KEY;
  // 模型：支援 'profile:model' 或 {profile, model}
  let __model = qaCfg.MODEL || (aiConfig.AI_MODELS?.answerChecking || 'gpt-4.1-mini');
  // 若模型帶有前綴或物件，解析出最終模型與可能的 profile 端點
  try {
    if (__model && typeof __model === 'object') {
      const pid = __model.profile || '';
      if (!__apiUrl && pid && aiConfig.AI_PROFILES && aiConfig.AI_PROFILES[pid]) {
        __apiUrl = aiConfig.AI_PROFILES[pid].apiUrl || __apiUrl;
        __apiKey = aiConfig.AI_PROFILES[pid].apiKey || __apiKey;
      }
      __model = String(__model.model || '');
    } else if (typeof __model === 'string' && __model.includes(':')) {
      const pid = __model.slice(0, __model.indexOf(':'));
      const m = __model.slice(__model.indexOf(':') + 1);
      if (!__apiUrl && pid && aiConfig.AI_PROFILES && aiConfig.AI_PROFILES[pid]) {
        __apiUrl = aiConfig.AI_PROFILES[pid].apiUrl || __apiUrl;
        __apiKey = aiConfig.AI_PROFILES[pid].apiKey || __apiKey;
      }
      __model = m;
    }
  } catch(_) {}
  const __temperature = (qaCfg.temperature ?? 0.2);
  const __maxTokens = (qaCfg.maxTokens ?? 1500);

  // 詳盡提示（本地後備）：要求回傳錯誤點、改進與學習重點
  const qaPrompts = aiConfig?.AI_PROMPTS?.qa?.checker || {};
  const sysMsg = qaPrompts.system || '你是英文問答的判題器。務必使用繁體中文回覆，且只輸出嚴格 JSON。';
  const prompt = qaPrompts.template
    ? applyTemplate(qaPrompts.template, { question, correctAnswer, userAnswer })
    : `題目: ${question}
參考答案: ${correctAnswer}
學生答案: ${userAnswer}

請只輸出嚴格 JSON：
{
  "isCorrect": true/false,
  "teacherFeedback": "精確給出所有錯誤的地方，包括所有出現的錯誤。如果回答在英文中是正確，也要對比上下文指出不同的地方。",
  "improvementSuggestions": ["參考上下文，給出改進建議。"],
  "studyFocus": ["結合錯誤，給學生提出需要加強的知識點（例：時態、主謂一致、代詞指代）"],
  "errors": {
    "grammar": ["文法錯誤（若無可留空）"],
    "spelling": ["拼寫錯誤（若無可留空）"],
    "vocabulary": ["用字/搭配不當（若無可留空）"],
    "structure": ["語序/句構問題（若無可留空）"],
    "punctuation": ["大小寫/標點問題（若無可留空）"]
  }
}`;

  const response = await fetch(__apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${__apiKey}`
    },
    body: JSON.stringify({
      model: __model,
      messages: [
        { role: 'system', content: sysMsg },
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

  // 兼容模型偶爾把布林輸出為字串的情況
  const toBool = (v) => {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') return v.trim().toLowerCase() === 'true';
    if (typeof v === 'number') return v > 0;
    return false;
  };
  const isCorrect = toBool(aiResult.isCorrect);

  return {
    isCorrect,
    score: (typeof aiResult.overallScore === 'number' ? Math.round(aiResult.overallScore) : (typeof aiResult.score === 'number' ? Math.round(aiResult.score) : (isCorrect ? 100 : 0))),
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
      structure: aiResult.errors?.structure || [],
      punctuation: aiResult.errors?.punctuation || []
    },
    // 保持向後兼容
    feedback: aiResult.teacherFeedback || aiResult.feedback || '',
    aiSuggestions: aiResult.improvementSuggestions || aiResult.suggestions || [],
    // 若簡化提示詞未返回自檢欄位，則保持為 undefined，避免 UI 顯示「無明顯問題」
    aiFeedbackIssues: aiResult.aiFeedbackIssues || aiResult.feedbackIssues || undefined,
    aiFeedbackOk: (typeof aiResult.aiFeedbackOk === 'boolean' ? aiResult.aiFeedbackOk : undefined)
  };
}

// 創建超時Promise
function createTimeoutPromise(__timeout, answer) {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error(`校對超時: Q${answer.qid}`));
    }, __timeout);
  });
}

// 創建備用結果
function createFailbackResult(answer) {
  const { userAnswer, correctAnswer } = answer;

  return {
    ...answer,
    isCorrect: false,
    score: 0,
    feedback: 'AI 校對暫不可用，請稍後再試',
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
    // 新增：列出所有錯題（題號與原因）供頁面整體報告顯示
    incorrectDetails: checkedAnswers
      .map((a, idx) => ({
        isCorrect: !!a.isCorrect,
        displayIndex: typeof a.displayIndex === 'number' ? a.displayIndex : idx,
        qid: a.qid,
        reason: a.teacherFeedback || a.feedback || '與參考答案不一致',
        userAnswer: a.userAnswer || '',
        correctAnswer: a.correctAnswer || ''
      }))
      .filter(it => !it.isCorrect),
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

// 英文停用詞（簡化版）
const EN_STOPWORDS = new Set(['the','a','an','to','of','in','on','at','for','with','and','or','but','so','because','as','by','from','that','this','these','those','is','am','are','was','were','be','been','being','do','does','did','have','has','had','will','would','shall','should','can','could','may','might','must','it','its','they','them','their','there','here','then','than','also','too','very','just','not','however','though','although','if','else','when','where','who','whom','which','what','why','how','into','over','under','about','out','up','down','again','once']);

function tokenizeWords(s = '') {
  const tokens = (s || '').toLowerCase().match(/\b[\w']+\b/g) || [];
  return tokens;
}

function extractKeywordList(correctAnswer = '') {
  const tokens = tokenizeWords(correctAnswer);
  const keywords = [];
  const seen = new Set();
  for (const t of tokens) {
    const clean = t.replace(/^'+|'+$/g, ''); // trim quotes
    if (clean.length < 3) continue; // 忽略過短詞
    if (EN_STOPWORDS.has(clean)) continue;
    if (!seen.has(clean)) { keywords.push(clean); seen.add(clean); }
    if (keywords.length >= 12) break; // 控制長度
  }
  // 保底：若沒有抽出任何關鍵詞，就退回全部去重 token（最多6個）
  if (keywords.length === 0) {
    const uniq = Array.from(new Set(tokens));
    return uniq.slice(0, 6);
  }
  return keywords;
}

function analyzeFormatIssues(userAnswer = '') {
  if (!userAnswer) return [];
  const s = userAnswer.trim();
  const msgs = [];
  // 句首大寫
  const firstAlpha = s.match(/[A-Za-z]/);
  if (firstAlpha && firstAlpha[0] === firstAlpha[0].toLowerCase()) {
    msgs.push('句首應使用大寫字母');
  }
  // 句末標點
  if (!/[.!?]$/.test(s)) {
    msgs.push('句末缺少標點');
  }
  // Yes/No 之後的逗號
  if (/^(yes|no)\s+[a-z]/i.test(s) && !/^(yes|no),\s/i.test(s)) {
    msgs.push('"Yes/No" 後建議加逗號');
  }
  // I 應大寫
  if (/\bi\b/.test(s)) {
    msgs.push('代詞 I 應大寫');
  }
  // 多餘空格
  if (/\s{2,}/.test(s)) {
    msgs.push('請避免連續空格');
  }
  // 標點前空格
  if (/\s[,:;!?\.]/.test(s)) {
    msgs.push('標點前不應有空格');
  }
  return msgs;
}

function computeKeywordRecall(userAnswer = '', keywords = []) {
  if (!userAnswer || !keywords || keywords.length === 0) return 0;
  const uTokens = new Set(tokenizeWords(userAnswer));
  let hits = 0;
  for (const k of keywords) if (uTokens.has(k)) hits += 1;
  return hits / keywords.length;
}

function ruleBasedPrecheck(question = '', correctAnswer = '', userAnswer = '') {
  const ua = (userAnswer || '').trim();
  if (!ua) {
    return {
      intercept: true,
      payload: {
        isCorrect: false,
        score: 0,
        teacherFeedback: '未作答或內容為空',
        improvementSuggestions: ['請直接作答問題', '可參考標準答案要點進行回答'],
        errorAnalysis: { punctuation: [], grammar: [], vocabulary: [], structure: ['未直接回應題目'] }
      }
    };
  }

  // 攔截明顯的元回覆/敷衍回覆
  const metaPattern = /^(yes|no|yeah|yep|ok|okay|agree|i think|maybe|you are right|that'?s right|correct|right\.?|sure|fine)\b/i;
  const onlyAcknowledgement = metaPattern.test(ua);

  const keywords = extractKeywordList(correctAnswer);
  const recall = computeKeywordRecall(ua, keywords);
  const fmt = analyzeFormatIssues(ua);
  const punc = analyzePunctuationDifferences(ua, correctAnswer);
  const missing = keywords.filter(k => !new Set(tokenizeWords(ua)).has(k)).slice(0, 5);

  if (onlyAcknowledgement || recall < 0.3) {
    const suggestions = [];
    if (missing.length) suggestions.push('補充關鍵資訊：' + missing.join(', '));
    suggestions.push('請直接回答題目重點');
    if (fmt.length) suggestions.push(...fmt);
    if (punc.length) suggestions.push(...punc);

    return {
      intercept: true,
      payload: {
        isCorrect: false,
        score: Math.round(recall * 40),
        teacherFeedback: onlyAcknowledgement ? '答案偏向附和/評述，未回應題目要點' : '未覆蓋標準答案的關鍵資訊',
        improvementSuggestions: suggestions.slice(0, 5),
        errorAnalysis: {
          punctuation: [].concat(fmt, punc),
          grammar: [],
          vocabulary: [],
          structure: ['未直接回應題目或關鍵資訊不足']
        }
      }
    };
  }

  // 不攔截，讓 AI 深入分析
  return { intercept: false };
}
