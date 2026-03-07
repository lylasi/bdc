import { API_URL, API_KEY, AI_MODELS, AI_LIMITS, OCR_CONFIG, ARTICLE_IMPORT, AI_PROFILES as __AI_PROFILES__, AI_PROMPTS } from '../ai-config.js';
import { loadGlobalSettings, loadGlobalSecrets } from './settings.js';
import * as cache from './cache.js';
import * as validate from './validate.js';

// =================================
// AI API 服務
// =================================

// Profiles: 若未定義，回退為僅 default → 指向全域
const AI_PROFILES = __AI_PROFILES__ || { default: { apiUrl: API_URL, apiKey: API_KEY } };

// Simple template filler: replaces ${name} with provided vars
function applyTemplate(tpl, vars = {}) {
  if (!tpl) return '';
  let s = String(tpl);
  for (const k of Object.keys(vars)) {
    try { s = s.split('${' + k + '}').join(String(vars[k])); } catch (_) {}
  }
  return s;
}

function buildArticleImportUrl(base, targetUrl) {
    if (!base) return null;
    try {
        const u = new URL(base);
        u.searchParams.set('url', targetUrl);
        return u.toString();
    } catch (_) {
        const hasParam = /[?&]url=/.test(base);
        if (hasParam) return `${base}${encodeURIComponent(targetUrl)}`;
        const sep = base.includes('?') ? (base.endsWith('?') || base.endsWith('&') ? '' : '&') : '?';
        return `${base}${sep}url=${encodeURIComponent(targetUrl)}`;
    }
}

async function fetchJsonWithTimeout(url, { timeoutMs = 20000, signal, headers } = {}) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new DOMException('Timeout', 'AbortError')), timeoutMs);
    const resp = await fetch(url, {
        signal: signal || ac.signal,
        headers: { 'Accept': 'application/json', ...(headers || {}) }
    });
    clearTimeout(timer);
    if (!resp.ok) {
        let payload = null;
        try { payload = await resp.json(); } catch (_) {}
        const err = new Error(`HTTP ${resp.status}`);
        err.status = resp.status;
        err.payload = payload;
        throw err;
    }
    return resp.json();
}

function normalizeModelSpec(spec) {
    if (spec && typeof spec === 'object') {
        const model = String(spec.model || '');
        const pid = spec.profile || null;
        const prof = (pid && AI_PROFILES[pid]) ? AI_PROFILES[pid] : {};
        return { model, apiUrl: spec.apiUrl || prof.apiUrl || null, apiKey: spec.apiKey || prof.apiKey || null, profile: pid || null };
    }
    const s = String(spec || '');
    const hasPrefix = s.includes(':');
    const pid = hasPrefix ? s.slice(0, s.indexOf(':')) : null;
    const model = hasPrefix ? s.slice(s.indexOf(':') + 1) : s;
    const prof = (pid && AI_PROFILES[pid]) ? AI_PROFILES[pid] : {};
    return { model, apiUrl: prof.apiUrl || null, apiKey: prof.apiKey || null, profile: pid || null };
}

const __aiQueues = new Map();

function getLimitConfig(taskType = 'default') {
    const fallback = AI_LIMITS?.default || { maxConcurrency: 2, minIntervalMs: 150 };
    const own = AI_LIMITS?.[taskType] || {};
    return {
        maxConcurrency: Math.max(1, Number(own.maxConcurrency || fallback.maxConcurrency || 1)),
        minIntervalMs: Math.max(0, Number(own.minIntervalMs || fallback.minIntervalMs || 0))
    };
}

function queueKeyForRequest({ endpoint, profile, model, taskType }) {
    return [endpoint || 'default-endpoint', profile || 'default-profile', model || 'default-model', taskType || 'default'].join('::');
}

async function enqueueAIRequest(queueKey, runner, { maxConcurrency = 1, minIntervalMs = 0 } = {}) {
    let state = __aiQueues.get(queueKey);
    if (!state) {
        state = { active: 0, lastStartedAt: 0, pending: [] };
        __aiQueues.set(queueKey, state);
    }
    return await new Promise((resolve, reject) => {
        const execute = async () => {
            state.active += 1;
            const now = Date.now();
            const waitMs = Math.max(0, minIntervalMs - (now - state.lastStartedAt));
            if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));
            state.lastStartedAt = Date.now();
            try {
                const result = await runner();
                resolve(result);
            } catch (error) {
                reject(error);
            } finally {
                state.active = Math.max(0, state.active - 1);
                const next = state.pending.shift();
                if (next) next();
                else if (state.active === 0) __aiQueues.delete(queueKey);
            }
        };
        if (state.active < maxConcurrency) execute();
        else state.pending.push(execute);
    });
}

function stripCodeFences(text = '') {
    return String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
}

function extractJSONObject(text = '') {
    const s = stripCodeFences(text);
    if (!s) return '';
    const directStart = s.indexOf('{');
    const directEnd = s.lastIndexOf('}');
    if (directStart >= 0 && directEnd > directStart) return s.slice(directStart, directEnd + 1);
    return s;
}

function safeJsonParse(text = '') {
    const raw = extractJSONObject(text);
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch (_) {
        try {
            const fixed = raw.replace(/,\s*([}\]])/g, '$1').replace(/(\{|\[)\s*,/g, '$1');
            return JSON.parse(fixed);
        } catch (_) {
            return null;
        }
    }
}

function firstNonEmptyString(...vals) {
    for (const val of vals) {
        if (typeof val === 'string' && val.trim()) return val.trim();
    }
    return '';
}

function normalizeParagraphResponse(parsed, fallbackText = '') {
    if (parsed && typeof parsed === 'object') {
        return {
            chinese_translation: firstNonEmptyString(parsed.chinese_translation, parsed.translation, parsed.translated_text, parsed.output, parsed.result, typeof parsed.text === 'string' ? parsed.text : ''),
            word_alignment: Array.isArray(parsed.word_alignment) ? parsed.word_alignment : [],
            detailed_analysis: Array.isArray(parsed.detailed_analysis) ? parsed.detailed_analysis : []
        };
    }
    return { chinese_translation: firstNonEmptyString(fallbackText), word_alignment: [], detailed_analysis: [] };
}

function normalizeSentenceResponse(parsed, fallbackText = '', sentence = '') {
    if (parsed && typeof parsed === 'object') {
        return {
            sentence: firstNonEmptyString(parsed.sentence, sentence),
            translation: firstNonEmptyString(parsed.translation, parsed.chinese_translation, parsed.translated_text, parsed.output, parsed.result, typeof parsed.text === 'string' ? parsed.text : ''),
            phrase_alignment: Array.isArray(parsed.phrase_alignment) ? parsed.phrase_alignment : [],
            chunks: Array.isArray(parsed.chunks) ? parsed.chunks : [],
            key_points: Array.isArray(parsed.key_points) ? parsed.key_points : []
        };
    }
    return { sentence, translation: firstNonEmptyString(fallbackText), phrase_alignment: [], chunks: [], key_points: [] };
}

function normalizeWordInSentenceResponse(parsed, fallbackText = '', word = '', sentence = '') {
    if (parsed && typeof parsed === 'object') {
        const analysis = parsed.analysis && typeof parsed.analysis === 'object' ? parsed.analysis : parsed;
        return {
            word: firstNonEmptyString(parsed.word, word),
            sentence: firstNonEmptyString(parsed.sentence, sentence),
            analysis: {
                phonetic: firstNonEmptyString(analysis.phonetic),
                pos: firstNonEmptyString(analysis.pos, analysis.part_of_speech),
                meaning: firstNonEmptyString(analysis.meaning, analysis.translation, analysis.gloss, parsed.meaning, parsed.translation, fallbackText),
                role: firstNonEmptyString(analysis.role, analysis.usage, parsed.role)
            }
        };
    }
    return { word, sentence, analysis: { phonetic: '', pos: '', meaning: firstNonEmptyString(fallbackText), role: '' } };
}

function normalizeSelectionResponse(parsed, fallbackText = '', selection = '', sentence = '') {
    if (parsed && typeof parsed === 'object') {
        const analysis = parsed.analysis && typeof parsed.analysis === 'object' ? parsed.analysis : parsed;
        return {
            selection: firstNonEmptyString(parsed.selection, selection),
            sentence: firstNonEmptyString(parsed.sentence, sentence),
            analysis: {
                phonetic: firstNonEmptyString(analysis.phonetic),
                meaning: firstNonEmptyString(analysis.meaning, analysis.translation, analysis.gloss, parsed.meaning, parsed.translation, fallbackText),
                usage: firstNonEmptyString(analysis.usage, analysis.role, parsed.usage),
                examples: Array.isArray(analysis.examples) ? analysis.examples : []
            }
        };
    }
    return { selection, sentence, analysis: { phonetic: '', meaning: firstNonEmptyString(fallbackText), usage: '', examples: [] } };
}

function buildModelCandidates(primary, fallback) {
    const out = [];
    const seen = new Set();
    for (const item of [primary, fallback]) {
        const key = JSON.stringify(item);
        if (!item || seen.has(key)) continue;
        seen.add(key);
        out.push(item);
    }
    return out;
}

// Small, reusable AI request helper with timeout and retry.
async function requestAI({ model, messages, temperature = 0.5, maxTokens, timeoutMs = 30000, signal, responseFormat, apiUrl, apiKey, taskType = 'default' }) {
    // AbortController per request; chain with external signal if provided
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new DOMException('Timeout', 'AbortError')), timeoutMs);
    const composed = signal ? new AbortController() : null;
    if (signal && composed) {
        const onAbort = () => composed.abort(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        // When composed aborts, also abort ac
        composed.signal.addEventListener('abort', () => ac.abort(composed.signal.reason), { once: true });
    }

    // 解析模型與端點
    const resolved = normalizeModelSpec(model);
    const finalModel = resolved.model;

    const body = {
        model: finalModel,
        messages,
        temperature,
    };
    if (typeof maxTokens === 'number') body.max_tokens = maxTokens;
    if (responseFormat) {
        body.response_format = typeof responseFormat === 'string' ? { type: responseFormat } : responseFormat;
    }

    const fetchOnce = async () => {
        const s = loadGlobalSettings();
        const sec = loadGlobalSecrets();
        const endpoint = (apiUrl && String(apiUrl).trim()) || (resolved.apiUrl && String(resolved.apiUrl).trim())
          || (s?.ai?.apiUrl && String(s.ai.apiUrl).trim()) || API_URL;
        const key = (apiKey && String(apiKey).trim()) || (resolved.apiKey && String(resolved.apiKey).trim())
          || (sec?.aiApiKey && String(sec.aiApiKey).trim()) || API_KEY;
        const { maxConcurrency, minIntervalMs } = getLimitConfig(taskType);
        const queueKey = queueKeyForRequest({ endpoint, profile: resolved.profile, model: finalModel, taskType });
        return await enqueueAIRequest(queueKey, async () => {
            const resp = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${key}`
                },
                body: JSON.stringify(body),
                signal: ac.signal
            });
            if (!resp.ok) {
                let errPayload = null;
                try { errPayload = await resp.json(); } catch (_) { /* ignore */ }
                const err = new Error(`AI request failed ${resp.status}`);
                err.status = resp.status;
                err.payload = errPayload;
                try {
                    const ra = resp.headers.get && resp.headers.get('retry-after');
                    if (ra) err.retryAfter = parseFloat(ra);
                } catch(_) {}
                throw err;
            }
            return resp.json();
        }, { maxConcurrency, minIntervalMs });
    };

    const maxRetries = 2;
    let attempt = 0;
    let lastErr = null;
    while (attempt <= maxRetries) {
        try {
            const json = await fetchOnce();
            clearTimeout(timer);
            return json;
        } catch (err) {
            lastErr = err;
            // Abort or client-side timeout: do not retry
            if (err?.name === 'AbortError') break;
            const status = err?.status || 0;
            // Retry on 429/5xx
            if (status === 429 || (status >= 500 && status < 600)) {
                let backoff;
                if (status === 429 && err && typeof err.retryAfter === 'number' && !Number.isNaN(err.retryAfter)) {
                    backoff = Math.min(err.retryAfter * 1000 + Math.random() * 250, 15000);
                } else {
                    backoff = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 250, 5000);
                }
                await new Promise(r => setTimeout(r, backoff));
                attempt += 1;
                continue;
            }
            break;
        }
    }
    clearTimeout(timer);
    throw lastErr || new Error('AI request failed');
}

/**
 * 通用的 AI API 請求函數；預期回傳 JSON 內容或可解析為 JSON 的字串。
 */
async function fetchAIResponse(model, prompt, temperature = 0.5, { maxTokens, timeoutMs = 30000, signal, responseFormat } = {}) {
    const data = await requestAI({
        model,
        temperature,
        maxTokens,
        messages: [{ role: 'user', content: prompt }],
        timeoutMs,
        signal,
        responseFormat
    });

    let content = (data?.choices?.[0]?.message?.content || '').replace(/^```json\n/, '').replace(/\n```$/, '').trim();
    try {
        return JSON.parse(content);
    } catch (error) {
        console.warn('JSON 解析失敗，將返回原始文本內容。', `錯誤: ${error.message}`);
        return content;
    }
}

/**
 * 獲取單個單詞的詳細分析（音標、詞性、中文意思）。
 * @param {string} word - 要分析的單詞。
 * @returns {Promise<object>} - 包含分析結果的對象。
 */
export async function getWordAnalysis(word) {
    try {
        const prompt = (AI_PROMPTS && AI_PROMPTS.dictionary && AI_PROMPTS.dictionary.wordAnalysis && AI_PROMPTS.dictionary.wordAnalysis.template)
          ? applyTemplate(AI_PROMPTS.dictionary.wordAnalysis.template, { word })
          : `Please provide a detailed analysis for the word "${word}". Return the result in a strict JSON format with the following keys: "phonetic" (IPA), "pos" (part of speech), and "meaning" (the most common Traditional Chinese (Hong Kong) meaning). For example: {"phonetic": "ɪɡˈzæmpəl", "pos": "noun", "meaning": "例子"}. Ensure the meaning is in Traditional Chinese (Hong Kong) vocabulary (e.g., 網上/上載/電郵/巴士/的士/單車/軟件/網絡/連結/相片).`;
        const s = loadGlobalSettings();
        const model = (s?.ai?.models && s.ai.models.wordAnalysis) || AI_MODELS.wordAnalysis;
        return await fetchAIResponse(model, prompt, 0.2);
    } catch (error) {
        console.error(`Error analyzing word "${word}":`, error);
        return { phonetic: 'error', pos: '', meaning: '分析失敗' };
    }
}

/**
 * 為指定單詞生成例句。
 * @param {string} word - 需要例句的單詞。
 * @returns {Promise<Array>} - 包含例句對象的數組。
 */
export async function generateExamplesForWord(word, opts = {}) {
    const w = (word && typeof word === 'object') ? (word.word || '') : String(word || '');
    const prompt = (AI_PROMPTS && AI_PROMPTS.learning && AI_PROMPTS.learning.exampleGeneration && AI_PROMPTS.learning.exampleGeneration.template)
      ? applyTemplate(AI_PROMPTS.learning.exampleGeneration.template, { word: w })
      : `請為單詞 "${w}" 生成3個英文例句。對於每個例句，請提供英文、中文翻譯（使用香港繁體中文用字），以及一個英文單詞到中文詞語的對齊映射數組。請確保對齊盡可能精確。請只返回JSON格式的數組，不要有其他任何文字。格式為: [{"english": "...", "chinese": "...", "alignment": [{"en": "word", "zh": "詞語"}, ...]}, ...]`;
    const s = loadGlobalSettings();
    const model = (s?.ai?.models && s.ai.models.exampleGeneration) || AI_MODELS.exampleGeneration;
    return await fetchAIResponse(model, prompt, 0.7, { maxTokens: 600, timeoutMs: 20000, ...opts });
}

/**
 * 檢查用戶造句的正確性。
 * @param {string} word - 句子中使用的核心單詞。
 * @param {string} userSentence - 用戶創建的句子。
 * @returns {Promise<string>} - AI 的反饋文本。
 */
export async function checkUserSentence(word, userSentence, opts = {}) {
    const prompt = (AI_PROMPTS && AI_PROMPTS.learning && AI_PROMPTS.learning.sentenceChecking && AI_PROMPTS.learning.sentenceChecking.template)
      ? applyTemplate(AI_PROMPTS.learning.sentenceChecking.template, { word, userSentence })
      : `請判斷以下這個使用單詞 "${word}" 的句子在語法和用法上是否正確: "${userSentence}"。如果正確，請只回答 "正確"。如果不正確，請詳細指出錯誤並提供一個修改建議，格式為 "不正確。建議：[你的建議]"。並總結錯誤的知識點。`;
    const s = loadGlobalSettings();
    const model = (s?.ai?.models && s.ai.models.sentenceChecking) || AI_MODELS.sentenceChecking;
    return await fetchAIResponse(model, prompt, 0.5, { maxTokens: 400, timeoutMs: 15000, ...opts });
}

/**
 * 分析文章中的單個段落。
 * @param {string} paragraph - 要分析的段落。
 * @returns {Promise<object>} - 包含段落分析結果的對象。
 */
export async function analyzeParagraph(paragraph, opts = {}) {
    const { timeoutMs = 45000, signal, level: requestedLevel = 'standard', noCache = false } = opts;
    const s = loadGlobalSettings();
    const primaryModel = (s?.ai?.models && (s.ai.models.articleParagraphTranslation || s.ai.models.articleAnalysis))
      || AI_MODELS.articleParagraphTranslation || AI_MODELS.articleAnalysis || AI_MODELS.wordAnalysis;
    const fallbackModel = (s?.ai?.models && s.ai.models.articleParagraphTranslationFallback)
      || AI_MODELS.articleParagraphTranslationFallback || AI_MODELS.articleAnalysis || AI_MODELS.wordAnalysis;
    const candidates = buildModelCandidates(primaryModel, fallbackModel);

    if (!noCache) {
        for (const modelSpec of candidates) {
            const resolved = normalizeModelSpec(modelSpec);
            try {
                const cached = await cache.getParagraphAnalysisCached(paragraph, requestedLevel, resolved.model);
                if (cached) return cached;
            } catch (_) {}
        }
    }

    const instructions = (AI_PROMPTS && AI_PROMPTS.article && AI_PROMPTS.article.paragraph && AI_PROMPTS.article.paragraph.instructions)
      || '請將以下英文段落翻譯成香港繁體中文，只返回 JSON。';
    const prompt = (AI_PROMPTS && AI_PROMPTS.article && AI_PROMPTS.article.paragraph && AI_PROMPTS.article.paragraph.user)
      ? applyTemplate(AI_PROMPTS.article.paragraph.user, { paragraph, instructions })
      : `請將以下英文段落翻譯成香港繁體中文，並只返回 JSON 物件。
允許鍵名：chinese_translation 或 translation。
不要使用 markdown code fence，不要加解釋。
段落: """
${paragraph}
"""
${instructions}`;

    let lastErr = null;
    for (const modelSpec of candidates) {
        const resolved = normalizeModelSpec(modelSpec);
        try {
            const data = await requestAI({
                model: modelSpec,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.2,
                maxTokens: requestedLevel === 'quick' ? 500 : 700,
                timeoutMs,
                signal,
                responseFormat: { type: 'json_object' },
                taskType: 'articleParagraphTranslation'
            });
            const content = data?.choices?.[0]?.message?.content || '';
            const parsed = normalizeParagraphResponse(safeJsonParse(content), stripCodeFences(content));
            if (!validate.validateArticleAnalysis(parsed, requestedLevel)) throw new Error('Schema validation failed');
            try { await cache.setParagraphAnalysisCached(paragraph, requestedLevel, resolved.model, parsed, 14 * 24 * 60 * 60 * 1000); } catch (_) {}
            return parsed;
        } catch (error) {
            lastErr = error;
        }
    }

    try {
        const fallbackModelSpec = candidates[0] || primaryModel;
        const fbPrompt = (AI_PROMPTS && AI_PROMPTS.article && AI_PROMPTS.article.paragraph && AI_PROMPTS.article.paragraph.fallback)
          ? applyTemplate(AI_PROMPTS.article.paragraph.fallback, { paragraph })
          : `請把這段英文翻譯成香港繁體中文，只輸出翻譯內容，不要其他文字：
${paragraph}`;
        const fb = await requestAI({
            model: fallbackModelSpec,
            messages: [{ role: 'user', content: fbPrompt }],
            temperature: 0.2,
            maxTokens: 450,
            timeoutMs,
            signal,
            taskType: 'articleParagraphTranslation'
        });
        const raw = fb?.choices?.[0]?.message?.content || '';
        const parsed = normalizeParagraphResponse(safeJsonParse(raw), stripCodeFences(raw));
        if (!validate.validateArticleAnalysis(parsed, requestedLevel)) throw lastErr || new Error('Paragraph fallback failed');
        return parsed;
    } catch (_) {
        if (lastErr) console.warn('段落翻譯失敗，返回最小兜底。', lastErr);
        return { chinese_translation: '', word_alignment: [], detailed_analysis: [] };
    }
}

/**
 * 懶載：針對單個詞（或短語）在其所在句子中的詳解。
 */
export async function analyzeWordInSentence(word, sentence, opts = {}) {
    const { timeoutMs = 20000, signal } = opts;
    const s = loadGlobalSettings();
    const primaryModel = (s?.ai?.models && (s.ai.models.articleWordTranslation || s.ai.models.articleWordTooltip || s.ai.models.wordAnalysis))
      || AI_MODELS.articleWordTranslation || AI_MODELS.articleWordTooltip || AI_MODELS.wordAnalysis;
    const fallbackModel = (s?.ai?.models && s.ai.models.articleWordTranslationFallback)
      || AI_MODELS.articleWordTranslationFallback || AI_MODELS.wordAnalysis;
    const candidates = buildModelCandidates(primaryModel, fallbackModel);
    for (const modelSpec of candidates) {
        const resolved = normalizeModelSpec(modelSpec);
        try {
            const cached = await cache.getWordAnalysisCached(word, sentence, resolved.model);
            if (cached) return cached;
        } catch (_) {}
    }
    const prompt = (AI_PROMPTS && AI_PROMPTS.article && AI_PROMPTS.article.wordTooltip && AI_PROMPTS.article.wordTooltip.template)
      ? applyTemplate(AI_PROMPTS.article.wordTooltip.template, { word, sentence })
      : `請解釋英文單詞在句中的意思，只返回 JSON。
允許最少字段：{"word":"${word}","meaning":"..."}
詞: "${word}"
句: "${sentence}"`;

    let lastErr = null;
    for (const modelSpec of candidates) {
        const resolved = normalizeModelSpec(modelSpec);
        try {
            const data = await requestAI({
                model: modelSpec,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.2,
                maxTokens: 280,
                timeoutMs,
                signal,
                responseFormat: { type: 'json_object' },
                taskType: 'articleWordTranslation'
            });
            const raw = data?.choices?.[0]?.message?.content || '';
            const parsed = normalizeWordInSentenceResponse(safeJsonParse(raw), stripCodeFences(raw), word, sentence);
            if (!validate.validateWordInSentence(parsed)) throw new Error('Schema validation failed');
            try { await cache.setWordAnalysisCached(word, sentence, resolved.model, parsed, 30 * 24 * 60 * 60 * 1000); } catch (_) {}
            return parsed;
        } catch (error) {
            lastErr = error;
        }
    }

    try {
        const fallbackModelSpec = candidates[0] || primaryModel;
        const fb = await requestAI({
            model: fallbackModelSpec,
            messages: [{ role: 'user', content: `請只回答這個詞在句中的中文意思，不要解釋。
詞: ${word}
句: ${sentence}` }],
            temperature: 0.2,
            maxTokens: 120,
            timeoutMs,
            signal,
            taskType: 'articleWordTranslation'
        });
        const raw = fb?.choices?.[0]?.message?.content || '';
        const parsed = normalizeWordInSentenceResponse(null, stripCodeFences(raw), word, sentence);
        if (!validate.validateWordInSentence(parsed)) throw lastErr || new Error('Word fallback failed');
        return parsed;
    } catch (_) {
        if (lastErr) throw lastErr;
        return normalizeWordInSentenceResponse(null, '', word, sentence);
    }
}

// --- Sentence-level analysis ---
export async function analyzeSentence(sentence, context = '', opts = {}) {
    const { timeoutMs = 20000, signal, noCache = false, conciseKeypoints = true, includeStructure = true } = opts;
    const s = loadGlobalSettings();
    const primaryModel = (s?.ai?.models && (s.ai.models.articleSentenceTranslation || s.ai.models.articleAnalysis))
      || AI_MODELS.articleSentenceTranslation || AI_MODELS.articleAnalysis || AI_MODELS.wordAnalysis;
    const fallbackModel = (s?.ai?.models && s.ai.models.articleSentenceTranslationFallback)
      || AI_MODELS.articleSentenceTranslationFallback || AI_MODELS.articleAnalysis || AI_MODELS.wordAnalysis;
    const candidates = buildModelCandidates(primaryModel, fallbackModel);
    let contextHash = '';
    try { contextHash = await cache.makeKey('ctx', context); } catch (_) {}
    if (!noCache) {
        for (const modelSpec of candidates) {
            const resolved = normalizeModelSpec(modelSpec);
            try {
                const cached = await cache.getSentenceAnalysisCached(sentence, contextHash, resolved.model);
                if (cached) return cached;
            } catch (_) {}
        }
    }
    const keyPointRule = conciseKeypoints ? '請輸出 1-3 條簡短關鍵點；若模型不擅長結構化分析，可返回空陣列。' : '請輸出 2-4 條最重要的關鍵點。';
    const basePrompt = `上下文（僅供理解）: """
${context}
"""
目標句: """
${sentence}
"""`;
    const prompt = includeStructure
      ? ((AI_PROMPTS && AI_PROMPTS.article && AI_PROMPTS.article.sentence && AI_PROMPTS.article.sentence.withStructure)
          ? applyTemplate(AI_PROMPTS.article.sentence.withStructure, { basePrompt, keyPointRule })
          : `請把下列英文句子翻譯成香港繁體中文，並盡量返回 JSON。
允許最少字段：{"translation":"..."}
若能穩定輸出，再補 key_points / phrase_alignment / chunks。
${basePrompt}
${keyPointRule}`)
      : ((AI_PROMPTS && AI_PROMPTS.article && AI_PROMPTS.article.sentence && AI_PROMPTS.article.sentence.concise)
          ? applyTemplate(AI_PROMPTS.article.sentence.concise, { basePrompt, keyPointRule })
          : `請把下列英文句子翻譯成香港繁體中文，只返回 JSON。
允許字段：translation, key_points
${basePrompt}
${keyPointRule}`);

    let lastErr = null;
    for (const modelSpec of candidates) {
        const resolved = normalizeModelSpec(modelSpec);
        try {
            const data = await requestAI({
                model: modelSpec,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.2,
                maxTokens: includeStructure ? 650 : 380,
                timeoutMs,
                signal,
                responseFormat: { type: 'json_object' },
                taskType: 'articleSentenceTranslation'
            });
            const raw = data?.choices?.[0]?.message?.content || '';
            const parsed = normalizeSentenceResponse(safeJsonParse(raw), stripCodeFences(raw), sentence);
            if (!validate.validateSentenceAnalysis(parsed)) throw new Error('Schema validation failed');
            try { await cache.setSentenceAnalysisCached(sentence, contextHash, resolved.model, parsed, 21 * 24 * 60 * 60 * 1000); } catch (_) {}
            return parsed;
        } catch (error) {
            lastErr = error;
        }
    }

    try {
        const fallbackModelSpec = candidates[0] || primaryModel;
        const fbPrompt = (AI_PROMPTS && AI_PROMPTS.article && AI_PROMPTS.article.sentence && AI_PROMPTS.article.sentence.fallback)
          ? applyTemplate(AI_PROMPTS.article.sentence.fallback, { sentence })
          : `請把這句英文翻譯成香港繁體中文；若可以，再附 1-2 條關鍵點。只返回 JSON 或純翻譯內容。
${sentence}`;
        const fb = await requestAI({
            model: fallbackModelSpec,
            messages: [{ role: 'user', content: fbPrompt }],
            temperature: 0.2,
            maxTokens: 260,
            timeoutMs,
            signal,
            taskType: 'articleSentenceTranslation'
        });
        const raw = fb?.choices?.[0]?.message?.content || '';
        const parsed = normalizeSentenceResponse(safeJsonParse(raw), stripCodeFences(raw), sentence);
        if (!validate.validateSentenceAnalysis(parsed)) throw lastErr || new Error('Sentence fallback failed');
        return parsed;
    } catch (_) {
        if (lastErr) throw lastErr;
        return normalizeSentenceResponse(null, '', sentence);
    }
}

// --- Selection/phrase analysis ---
export async function analyzeSelection(selection, sentence, context = '', opts = {}) {
    const { timeoutMs = 15000, signal, noCache = false } = opts;
    const s = loadGlobalSettings();
    const primaryModel = (s?.ai?.models && (s.ai.models.articlePhraseTranslation || s.ai.models.articlePhraseAnalysis || s.ai.models.wordAnalysis))
      || AI_MODELS.articlePhraseTranslation || AI_MODELS.articlePhraseAnalysis || AI_MODELS.wordAnalysis;
    const fallbackModel = (s?.ai?.models && s.ai.models.articlePhraseTranslationFallback)
      || AI_MODELS.articlePhraseTranslationFallback || AI_MODELS.wordAnalysis;
    const candidates = buildModelCandidates(primaryModel, fallbackModel);
    let contextHash = '';
    try { contextHash = await cache.makeKey('ctx', context); } catch (_) {}
    if (!noCache) {
        for (const modelSpec of candidates) {
            const resolved = normalizeModelSpec(modelSpec);
            try {
                const cached = await cache.getSelectionAnalysisCached(selection, sentence, contextHash, resolved.model);
                if (cached) return cached;
            } catch (_) {}
        }
    }
    const prompt = (AI_PROMPTS && AI_PROMPTS.article && AI_PROMPTS.article.phraseAnalysis && AI_PROMPTS.article.phraseAnalysis.template)
      ? applyTemplate(AI_PROMPTS.article.phraseAnalysis.template, { selection, sentence, context })
      : `請解釋下列片語在句中的意思，只返回 JSON。
允許最少字段：{"selection":"${selection}","meaning":"..."}
選中: "${selection}"
句子: "${sentence}"
上下文: "${context}"`;

    let lastErr = null;
    for (const modelSpec of candidates) {
        const resolved = normalizeModelSpec(modelSpec);
        try {
            const data = await requestAI({
                model: modelSpec,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.2,
                maxTokens: 260,
                timeoutMs,
                signal,
                responseFormat: { type: 'json_object' },
                taskType: 'articlePhraseTranslation'
            });
            const raw = data?.choices?.[0]?.message?.content || '';
            const parsed = normalizeSelectionResponse(safeJsonParse(raw), stripCodeFences(raw), selection, sentence);
            if (!validate.validateSelectionAnalysis(parsed)) throw new Error('Schema validation failed');
            try { await cache.setSelectionAnalysisCached(selection, sentence, contextHash, resolved.model, parsed, 30 * 24 * 60 * 60 * 1000); } catch (_) {}
            return parsed;
        } catch (error) {
            lastErr = error;
        }
    }

    try {
        const fallbackModelSpec = candidates[0] || primaryModel;
        const fb = await requestAI({
            model: fallbackModelSpec,
            messages: [{ role: 'user', content: `請只回答這個片語在句中的中文意思，不要解釋。
片語: ${selection}
句子: ${sentence}` }],
            temperature: 0.2,
            maxTokens: 140,
            timeoutMs,
            signal,
            taskType: 'articlePhraseTranslation'
        });
        const raw = fb?.choices?.[0]?.message?.content || '';
        const parsed = normalizeSelectionResponse(null, stripCodeFences(raw), selection, sentence);
        if (!validate.validateSelectionAnalysis(parsed)) throw lastErr || new Error('Phrase fallback failed');
        return parsed;
    } catch (_) {
        if (lastErr) throw lastErr;
        return normalizeSelectionResponse(null, '', selection, sentence);
    }
}

// =================================
// Image OCR (Vision) API
// =================================

/**
 * 將圖片中的文字抽取為純文字。
 * imageDataUrl: Data URL（data:image/...;base64,...），建議經過壓縮/縮放。
 */
export async function ocrExtractTextFromImage(imageDataUrl, opts = {}) {
    const {
        promptHint,
        temperature = 0.0,
        maxTokens,
        timeoutMs,
        signal,
        model: modelOverride
    } = opts;

    const s = loadGlobalSettings();
    const model = modelOverride
      || (s?.ai?.models && (s.ai.models.imageOCR || s.ai.models.ocr))
      || (OCR_CONFIG && (OCR_CONFIG.DEFAULT_MODEL || OCR_CONFIG.MODEL))
      || AI_MODELS.imageOCR || AI_MODELS.articleAnalysis;

    // 端點：PROFILE > API_URL/API_KEY > 其餘回退由 requestAI 處理
    let endpoint = (OCR_CONFIG && OCR_CONFIG.API_URL && String(OCR_CONFIG.API_URL).trim()) || undefined; // fallback to global in requestAI
    let overrideKey = (OCR_CONFIG && OCR_CONFIG.API_KEY && String(OCR_CONFIG.API_KEY).trim()) || undefined;
    if (!endpoint && OCR_CONFIG && OCR_CONFIG.PROFILE && AI_PROFILES[OCR_CONFIG.PROFILE]) {
        endpoint = AI_PROFILES[OCR_CONFIG.PROFILE].apiUrl || endpoint;
        overrideKey = AI_PROFILES[OCR_CONFIG.PROFILE].apiKey || overrideKey;
    }
    const finalMaxTokens = typeof maxTokens === 'number' ? maxTokens : (OCR_CONFIG?.maxTokens || 1500);
    const finalTimeout = typeof timeoutMs === 'number' ? timeoutMs : (OCR_CONFIG?.timeoutMs || 45000);

    const data = await requestAI({
        apiUrl: endpoint,
        apiKey: overrideKey,
        model,
        temperature,
        maxTokens: finalMaxTokens,
        timeoutMs: finalTimeout,
        signal,
        messages: [{
            role: 'user',
            content: [
                (function(){
                    const defaultHint = (AI_PROMPTS && AI_PROMPTS.ocr && AI_PROMPTS.ocr.extract && AI_PROMPTS.ocr.extract.promptHint)
                      || '請將圖片中的文字內容完整擷取為純文字，保留原始換行與標點；不要翻譯或改寫。若為截圖，請忽略 UI 按鈕與雜訊，只輸出正文。';
                    const txt = (promptHint ?? defaultHint);
                    return { type: 'text', text: txt };
                })(),
                { type: 'image_url', image_url: { url: imageDataUrl, detail: 'high' } }
            ]
        }]
    });

    const content = (data?.choices?.[0]?.message?.content || '').trim();
    return content;
}

// =================================
// AI Grading: Vision + Expected List
// =================================

/**
 * 以視覺模型直接對相片中的默寫內容進行批改。
 * @param {string[]} imageDataUrls - data URLs of images
 * @param {Array<{word:string, meaning?:string}>} expectedList - 標準答案清單
 * @param {object} opts
 *  - model: 指定模型（預設取 OCR_CONFIG.DEFAULT_MODEL/ MODEL）
 *  - prompt: 自訂提示詞
 *  - timeoutMs, temperature
 */
export async function aiGradeHandwriting(imageDataUrls = [], expectedList = [], opts = {}) {
    const {
        model: modelOverride,
        prompt: userPrompt,
        temperature = 0.0,
        timeoutMs,
        format = 'json' // 'json' | 'markdown'
    } = opts;

    const s = loadGlobalSettings();
    const model = modelOverride
      || (s?.ai?.models && (s.ai.models.imageOCR || s.ai.models.ocr))
      || (OCR_CONFIG && (OCR_CONFIG.DEFAULT_MODEL || OCR_CONFIG.MODEL))
      || AI_MODELS.imageOCR || AI_MODELS.articleAnalysis;

    let endpoint = (OCR_CONFIG && OCR_CONFIG.API_URL && String(OCR_CONFIG.API_URL).trim()) || undefined;
    let overrideKey = (OCR_CONFIG && OCR_CONFIG.API_KEY && String(OCR_CONFIG.API_KEY).trim()) || undefined;
    if (!endpoint && OCR_CONFIG && OCR_CONFIG.PROFILE && AI_PROFILES[OCR_CONFIG.PROFILE]) {
        endpoint = AI_PROFILES[OCR_CONFIG.PROFILE].apiUrl || endpoint;
        overrideKey = AI_PROFILES[OCR_CONFIG.PROFILE].apiKey || overrideKey;
    }
    const finalTimeout = typeof timeoutMs === 'number' ? timeoutMs : (OCR_CONFIG?.timeoutMs || 60000);

    const defaultPrompt = (AI_PROMPTS && AI_PROMPTS.ocr && AI_PROMPTS.ocr.grading && AI_PROMPTS.ocr.grading.defaultPrompt)
      || `這是一張默寫單詞的相片。請直接在圖片中擷取學生書寫內容並進行批改：
- 請忽略被手寫劃掉（刪去線）的詞字；
- 逐行擷取學生書寫的英文單詞或短語，保留順序與原始大小寫；若某行同時有中文，請一併擷取；
- 以提供的「標準詞表」作為唯一正確答案來源，逐行判斷英文拼寫是否正確；若該行含中文，檢查中文是否書寫正確；
- 僅對錯誤的部分逐點指出（英/中），並給出建議修正；
- 請返回嚴格 JSON 格式，不要任何多餘說明或程式碼框。JSON 需為：
{
  "items": [
    {"line": "原始行文字", "english": "擷取到的英文", "chinese": "擷取到的中文(可空)", "correct": true|false,
     "errors": [ {"type": "english|chinese", "expected": "標準答案或正確語義", "got": "書寫內容", "suggestion": "修正建議"} ]}
  ],
  "summary": {"total": 總行數, "correct": 正確行數, "wrong": 錯誤行數}
}`;

    const content = [];
    content.push({ type: 'text', text: String(userPrompt || defaultPrompt) });
    // 附上標準詞表
    try {
        const compact = expectedList.map(x => ({ word: String(x.word||''), meaning: String(x.meaning||'') }));
        if (format === 'markdown') {
            const md = ['標準詞表（僅供比對，請不要逐行列出於表格中）：'];
            for (const it of compact) md.push(`- ${it.word}${it.meaning ? ' — ' + it.meaning : ''}`);
            content.push({ type: 'text', text: md.join('\n') });
        } else {
            content.push({ type: 'text', text: `標準詞表（JSON）:\n${JSON.stringify(compact)}` });
        }
    } catch (_) { /* ignore */ }
    // 附上多張圖片
    for (const url of (imageDataUrls||[])) {
        content.push({ type: 'image_url', image_url: { url, detail: 'high' } });
    }

    const req = {
        apiUrl: endpoint,
        apiKey: overrideKey,
        model,
        messages: [{ role: 'user', content }],
        temperature,
        timeoutMs: finalTimeout
    };
    if (format === 'json') {
        req.responseFormat = { type: 'json_object' };
    }
    const data = await requestAI(req);
    const raw = (data?.choices?.[0]?.message?.content || '').trim();
    if (format === 'markdown') {
        return raw;
    }
    try {
        return JSON.parse(raw);
    } catch (_) {
        return JSON.parse(raw.replace(/^```json\n/, '').replace(/\n```$/, ''));
    }
}

// =================================
// URL 文章擷取（輕量可攜）
// =================================

/**
 * 從網址提取可閱讀正文（盡量保留段落與標題）。
 * 策略：
 * 1) 優先使用 r.jina.ai 轉換（避免跨域與複雜解析成本，CORS 友好）；
 * 2) 若失敗再嘗試直接抓取（僅在目標網站允許 CORS 時可用），並做極簡抽取；
 * 3) 全程限制超時，避免卡住 UI。
 * 注意：這是前端純靜態策略，品質依賴對方站點與轉換服務；若需要高品質抽取，建議配合後端 Readability 服務。
 */
export async function fetchArticleFromUrl(url, opts = {}) {
    const { timeoutMs = 20000, signal } = opts;
    let u;
    try { u = new URL(url, window.location.href); } catch (_) { throw new Error('URL 無效'); }
    if (!/^https?:$/i.test(u.protocol)) throw new Error('僅支援 http/https');

    // 1) r.jina.ai 轉換（常見站點可直接得到「純文字」正文）
    const jina = `https://r.jina.ai/${u.protocol}//${u.host}${u.pathname}${u.search}`;
    try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(new DOMException('Timeout', 'AbortError')), timeoutMs);
        const resp = await fetch(jina, { signal: signal || ac.signal, headers: { 'Accept': 'text/plain' } });
        clearTimeout(timer);
        if (resp.ok) {
            const text = await resp.text();
            const norm = normalizeImportedText(text);
            if (norm && norm.trim()) return norm;
        }
    } catch (_) { /* fallthrough */ }

    // 2) 直接抓取（若對方允許 CORS）+ 極簡抽取
    try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(new DOMException('Timeout', 'AbortError')), timeoutMs);
        const resp = await fetch(u.toString(), { signal: signal || ac.signal, headers: { 'Accept': 'text/html, text/plain;q=0.9,*/*;q=0.1' } });
        clearTimeout(timer);
        if (resp.ok) {
            const html = await resp.text();
            const text = extractReadableFallback(html);
            const norm = normalizeImportedText(text);
            if (norm && norm.trim()) return norm;
        }
    } catch (_) { /* ignore */ }

    throw new Error('無法擷取此網址內容（可能被目標站點或網路限制）');
}

/**
 * 將 r.jina.ai（或其它來源）的純文字/Markdown 嘗試抽取成「標題 + 正文」。
 * 返回 { title, content, publishedAt? }，content 維持 Markdown 段落與基本格式。
 * 注意：這是啟發式抽取，對不同站點會有誤差。
 */
export function extractArticleTitleAndBody(rawText, url = '') {
    const text = String(rawText || '').replace(/\r/g, '');
    const lines = text.split('\n');

    // 1) 優先從 r.jina.ai 標頭解析（Title / Published Time / Markdown Content）
    let title = '';
    let publishedAt = '';
    let mdStart = -1;
    for (let i = 0; i < Math.min(lines.length, 100); i++) {
        const l = lines[i].trim();
        if (!title) {
            const m = l.match(/^Title:\s*(.+)$/i);
            if (m) { title = m[1].trim(); continue; }
        }
        if (!publishedAt) {
            const p = l.match(/^Published\s+Time:\s*(.+)$/i);
            if (p) { publishedAt = p[1].trim(); continue; }
        }
        if (mdStart < 0 && /^Markdown\s+Content:\s*$/i.test(l)) {
            mdStart = i + 1; break;
        }
    }

    let md = '';
    if (mdStart >= 0) {
        md = lines.slice(mdStart).join('\n');
    } else {
        md = text;
    }

    // 2) 若未得到標題，嘗試從 Markdown 第一個 H1 解析（ATX 或 Setext）
    if (!title) {
        const mdLines = md.split('\n');
        for (let i = 0; i < Math.min(mdLines.length, 80); i++) {
            const a = mdLines[i] || '';
            const b = mdLines[i + 1] || '';
            // ATX: # Heading
            const atx = a.trim().match(/^#{1,2}\s+(.+?)\s*#*$/);
            if (atx) { title = atx[1].trim(); break; }
            // Setext: Heading + =====
            if (a.trim() && /^=+\s*$/.test(b)) { title = a.trim(); break; }
        }
    }

    // 3) 針對正文做噪音過濾與截斷（保留段落/標題/圖片，但移除站點導航/社交/推薦）
    const stopHeadings = [
        'top stories', 'subscribe', 'rt features', 'podcasts', 'where to watch',
        'schedule', 'applications', 'live', 'more', 'sponsored content',
        'rt news app', 'question more'
    ];
    const noiseRegexes = [
        /^\s*\[.*?\]\(.*?\)\s*$/i,                     // 單純連結行 [text](link)
        /^\s*\*\s*\[.*?\]\(.*?\)\s*$/i,               // * [text](link)
        /^\s*\*\s*$/,
        /^\s*Follow RT on/i,
        /^\s*You can share this story/i,
        /^\s*Add to home screen/i,
        /^\s*Show comments/i,
        /^\s*Subscribe to RT newsletter/i,
        /^\s*This website uses cookies/i,
        /^\s*©\s+Autonomous Nonprofit Organization/i
    ];
    const bannedImageHosts = [
        'counter.yadro.ru', // 流量統計
    ];
    const bannedImagePathHints = [
        '/static/img/telegram_banners/', '/static/img/social-banners/', '/telegram_banners/', '/social-banners/'
    ];
    const isBannedImageUrl = (url) => {
        try {
            const u = new URL(url, 'https://example.com');
            if (bannedImageHosts.includes(u.hostname)) return true;
            return bannedImagePathHints.some(h => u.pathname.includes(h));
        } catch (_) { return true; }
    };
    // 將 [![alt](img)](link) 規整化為 ![alt](img)
    const normalizeWrappedImage = (s) => {
        const m = s.match(/^\s*\[\!\[(.*?)\]\((.*?)\)\s*(?:.*?)\]\((.*?)\)\s*$/i);
        if (m) {
            const alt = m[1] || '';
            const img = m[2] || '';
            // 若包含 Read more 之類字樣，視為推薦卡片，丟棄
            if (/read\s+more/i.test(s)) return '';
            if (!img || isBannedImageUrl(img)) return '';
            return `![${alt}](${img})`;
        }
        return s;
    };
    const headingRe = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/; // ATX heading

    const out = [];
    let reachedTail = false;
    md.split('\n').some((ln, idx, arr) => {
        const t = ln.trim();
        // 偵測切斷點（標題行）
        if (t) {
            // ATX heading
            const m = t.match(headingRe);
            if (m) {
                const head = (m[2] || '').toLowerCase();
                if (stopHeadings.some(h => head.includes(h))) { reachedTail = true; return true; }
            }
            // Setext heading: 看下一行是 ---/===
            if (idx + 1 < arr.length && (/^[-=]{3,}\s*$/.test(arr[idx + 1] || ''))) {
                const head = t.toLowerCase();
                if (stopHeadings.some(h => head.includes(h))) { reachedTail = true; return true; }
            }
        }
        if (!t) { out.push(''); return false; }
        // 規整化被外層連結包裹的圖片
        let line = normalizeWrappedImage(t);

        // 噪音行（單純連結、追蹤宣告、訂閱等）
        if (noiseRegexes.some(re => re.test(line))) return false;

        // 圖片處理：保留 Markdown 圖片，禁止追蹤/社交素材
        const img = line.match(/^\s*\!\[(.*?)\]\((.*?)\)\s*$/i);
        if (img) {
            const url = img[2] || '';
            if (isBannedImageUrl(url)) return false; // 丟棄站點宣傳/社交/追蹤圖
            // 保留內容圖片（要求：保留為 Markdown，不做解析/翻譯）
            out.push(line);
            return false;
        }
        // 過濾純語言/導航聚合：多語列表、Home/Breadcrumb
        if (/^(home|world news|news|analysis|opinion|shows|projects)\b/i.test(line)) return false;
        if (/^(العربية|esp|рус|de|fr|rs)\b/i.test(line)) return false;
        // 過濾重複空鏈接列
        if (/^\[\]\(.*?\)\s*$/.test(line)) return false;
        // 過濾時間戳噪音（如 0:00 行）
        if (/^\d{1,2}:\d{2}\s*$/.test(line)) return false;

        out.push(line === t ? ln : line);
        return false;
    });

    const content = out.join('\n')
        // 清理 3+ 空行
        .replace(/\n{3,}/g, '\n\n')
        // 清理文首殘餘站名標語
        .replace(/^\s*Question more\s*\n?/i, '')
        .trim();

    return { title: title || '', content, publishedAt: publishedAt || '', url };
}

/**
 * 直接獲取「標題+正文」結構；若抽取失敗，回傳以原文為正文。
 */
export async function fetchArticleFromUrlStructured(url, opts = {}) {
    const raw = await fetchArticleFromUrl(url, opts);
    try {
        const parsed = extractArticleTitleAndBody(raw, url);
        // 至少要有較像文章的正文（>100 字元或有段落）
        const okLen = (parsed.content || '').replace(/\s+/g, '').length >= 100;
        if (parsed.title || okLen) return parsed;
    } catch (_) { /* ignore */ }
    return { title: '', content: String(raw || ''), publishedAt: '', url };
}

export async function fetchArticleViaWorker(url, opts = {}) {
    const { timeoutMs = 20000, signal, keepImages = true, model, preferMarkdown = true } = opts;
    const endpoint = ARTICLE_IMPORT?.EXTRACT_URL || ARTICLE_IMPORT?.PROXY_URL;
    if (!endpoint) throw new Error('尚未設定文章擷取服務端點');
    const base = buildArticleImportUrl(endpoint, url);
    if (!base) throw new Error('無法建立文章擷取網址');
    const u = new URL(base);
    // 若 Worker 支援 format/includeMarkdown，優先要求 markdown
    if (preferMarkdown) {
        if (!u.searchParams.has('format')) u.searchParams.set('format', 'json');
        if (!u.searchParams.has('includeMarkdown')) u.searchParams.set('includeMarkdown', 'true');
        if (!u.searchParams.has('keepImages')) u.searchParams.set('keepImages', keepImages ? 'true' : 'false');
    }
    const data = await fetchJsonWithTimeout(u.toString(), { timeoutMs, signal });
    const title = data?.title || data?.heading || '';
    const byline = data?.byline || data?.author || '';
    const publishedAt = data?.publishedAt || data?.date || '';
    const sourceUrl = data?.sourceUrl || data?.source || url;
    const markdownFromWorker = preferMarkdown ? (data?.markdown || data?.contentMarkdown) : '';
    let markdown = markdownFromWorker || '';
    if (!markdown) {
        const html = data?.contentHtml || data?.rawHtml || '';
        const text = data?.contentText || '';
        if (html || text) {
            const htmlInput = html || `<article>${text}</article>`;
            markdown = await aiExtractArticleFromHtml(htmlInput, { url: sourceUrl, keepImages, timeoutMs, signal, model });
        } else {
            throw new Error('擷取結果缺少正文內容');
        }
    }
    return { title, byline, publishedAt, markdown, raw: data, sourceUrl };
}

export async function listCuratedArticles(sourceId, opts = {}) {
    const { timeoutMs = 15000, signal } = opts;
    if (!sourceId) throw new Error('缺少來源代碼');
    if (!ARTICLE_IMPORT?.FEED_URL) throw new Error('未設定新聞來源端點');
    const base = ARTICLE_IMPORT.FEED_URL.replace(/\/$/, '');
    const u = new URL(`${base}/${encodeURIComponent(sourceId)}`);
    // 若 Worker 需要明確格式，指定 json
    if (!u.searchParams.has('format')) u.searchParams.set('format', 'json');
    const data = await fetchJsonWithTimeout(u.toString(), { timeoutMs, signal });
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.items)) return data.items;
    if (Array.isArray(data?.articles)) return data.articles;
    return [];
}

export async function listArticleSources(opts = {}) {
    const { timeoutMs = 12000, signal } = opts;
    if (!ARTICLE_IMPORT?.FEED_URL) return [];
    try {
        const base = ARTICLE_IMPORT.FEED_URL.replace(/\/$/, '');
        const u = new URL(base);
        if (!u.searchParams.has('format')) u.searchParams.set('format', 'json');
        const data = await fetchJsonWithTimeout(u.toString(), { timeoutMs, signal });
        if (Array.isArray(data?.sources)) return data.sources;
        if (Array.isArray(data)) return data;
    } catch (_) { /* fallback */ }
    return [];
}

export async function fetchCuratedArticle(sourceId, articleUrl, opts = {}) {
    const { timeoutMs = 22000, signal, keepImages = true, model } = opts;
    if (!articleUrl) throw new Error('缺少文章網址');
    let lastErr = null;
    if (ARTICLE_IMPORT?.FEED_URL && sourceId) {
        try {
            const base = ARTICLE_IMPORT.FEED_URL.replace(/\/$/, '');
            const u = new URL(`${base}/${encodeURIComponent(sourceId)}/article`);
            u.searchParams.set('url', articleUrl);
            u.searchParams.set('format', 'json');
            u.searchParams.set('includeMarkdown', 'true');
            u.searchParams.set('keepImages', keepImages ? 'true' : 'false');
            const data = await fetchJsonWithTimeout(u.toString(), { timeoutMs, signal });
            const title = data?.title || '';
            const byline = data?.byline || data?.author || '';
            const publishedAt = data?.publishedAt || data?.date || '';
            let markdown = data?.markdown || data?.contentMarkdown || '';
            if (!markdown) {
                const html = data?.contentHtml || data?.rawHtml || '';
                if (html) {
                    markdown = await aiExtractArticleFromHtml(html, { url: articleUrl, keepImages, timeoutMs, signal, model });
                } else if (data?.contentText) {
                    markdown = await aiCleanArticleMarkdown(String(data.contentText), { keepImages, timeoutMs, signal, model });
                }
            }
            if (markdown) return { title, byline, publishedAt, markdown, raw: data, sourceId };
        } catch (err) {
            lastErr = err;
        }
    }
    try {
        const res = await fetchArticleViaWorker(articleUrl, { timeoutMs, signal, keepImages, model });
        res.sourceId = sourceId;
        return res;
    } catch (err) {
        if (lastErr) throw lastErr;
        throw err;
    }
}

// =================================
// AI 清洗與格式優化（Markdown 保留）
// =================================

/**
 * 讓 AI 清洗已抽取的 Markdown 文章，保留結構與圖片；移除站點噪音；不翻譯內容。
 * 返回乾淨的 Markdown 純文字。
 */
export async function aiCleanArticleMarkdown(markdownText, opts = {}) {
    const { timeoutMs: toMs, temperature: temp, signal, model: modelOverride, keepImages: keepImgs } = opts;
    // 模型解析：優先 opts → ai-config（ARTICLE_IMPORT）→ 全域（AI_MODELS）
    const model = modelOverride
      || (ARTICLE_IMPORT && (ARTICLE_IMPORT.DEFAULT_MODEL || ARTICLE_IMPORT.MODEL))
      || AI_MODELS.articleAnalysis;

    // 端點解析：PROFILE > API_URL/API_KEY > 其餘回退由 requestAI 處理
    let endpoint = (ARTICLE_IMPORT && ARTICLE_IMPORT.API_URL && String(ARTICLE_IMPORT.API_URL).trim()) || undefined;
    let overrideKey = (ARTICLE_IMPORT && ARTICLE_IMPORT.API_KEY && String(ARTICLE_IMPORT.API_KEY).trim()) || undefined;
    if (!endpoint && ARTICLE_IMPORT && ARTICLE_IMPORT.PROFILE && AI_PROFILES[ARTICLE_IMPORT.PROFILE]) {
        endpoint = AI_PROFILES[ARTICLE_IMPORT.PROFILE].apiUrl || endpoint;
        overrideKey = AI_PROFILES[ARTICLE_IMPORT.PROFILE].apiKey || overrideKey;
    }

    const temperature = (typeof temp === 'number') ? temp : (ARTICLE_IMPORT?.temperature ?? 0.1);
    const maxTokens = ARTICLE_IMPORT?.maxTokens ?? 1400;
    const timeoutMs = (typeof toMs === 'number') ? toMs : (ARTICLE_IMPORT?.timeoutMs ?? 25000);
    const keepImages = (typeof keepImgs === 'boolean') ? keepImgs : (ARTICLE_IMPORT?.keepImagesDefault ?? true);

    const prompt = `你會收到一篇以 Markdown 表示的英文文章（可能含標題、清單、表格、圖片）。請清洗並輸出更適合閱讀的 Markdown：
- 僅保留正文與必要的標題/段落/清單/表格/引用/程式碼（僅當確為程式碼）；移除網站導航、語言切換、社交按鈕、推薦卡片、廣告、版權宣告、留言模組、追蹤用圖片或計數器。
- ${keepImages ? '保留正文相關的圖片為 Markdown 圖片行（例如：![alt](URL)）。不要翻譯或改寫 alt；若 alt 缺失可留空或取鄰近 caption。移除社交/追蹤/橫幅等非內容圖片。' : '移除所有 Markdown 圖片行（例如：![alt](URL)），不要以連結或描述替代圖片。'}
- 不要新增任何強調或裝飾標記：嚴禁輸出由 * 或 _ 形成的粗斜體；除非原文已是 Markdown 且必須保留，否則不要加上 * 或 _。
- 移除純裝飾符號與分隔線（如 -----、_______、****、====、••• 等）以及無意義圖示（▶︎◆•·►等）；清理標題或段落前後多餘符號。
- 連結保留可讀文字與連結，並移除追蹤參數（如 utm_*、fbclid、ref 等）；相對連結不在此流程修正。
- 保持原文語言與內容，不要翻譯、不新增解說；僅做結構整理、去噪聲、合併多餘空行，統一為合理段落。
- 若沒有明確主標題而開頭存在明顯標題，轉為一行 ATX 標題（# Title）。
- 嚴禁輸出任何額外解釋或程式碼區塊圍欄（使用三個反引號的圍欄）；只輸出清洗後的 Markdown 純文字。`;

    const data = await requestAI({
        apiUrl: endpoint,
        apiKey: overrideKey,
        model,
        messages: [
            { role: 'system', content: 'You are a precise Markdown editor that preserves structure and removes noise without translating.' },
            { role: 'user', content: `${prompt}\n\n=== 原文開始 ===\n${markdownText}\n=== 原文結束 ===` }
        ],
        temperature,
        maxTokens,
        timeoutMs,
        signal
    });
    let content = (data?.choices?.[0]?.message?.content || '').trim();
    // 去掉偶發的 ``` 標記
    content = content.replace(/^```(?:markdown)?\n/, '').replace(/\n```\s*$/, '').trim();
    return content;
}

/**
 * 直接將完整 HTML 交給 AI 做正文抽取與清洗，輸出乾淨 Markdown。
 * - 不翻譯、不新增解說；保留結構（標題/清單/表格/引用/程式碼）。
 * - 依 base URL 嘗試將相對連結/圖片轉成絕對 URL。
 * - 可選擇是否保留圖片（轉為 Markdown 圖片行）。
 */
export async function aiExtractArticleFromHtml(html, opts = {}) {
    const { url = '', keepImages = true, timeoutMs: toMs, temperature: temp, signal, model: modelOverride } = opts;

    // 模型與端點覆寫沿用 ARTICLE_IMPORT 設定
    const model = modelOverride
      || (ARTICLE_IMPORT && (ARTICLE_IMPORT.DEFAULT_MODEL || ARTICLE_IMPORT.MODEL))
      || AI_MODELS.articleAnalysis;

    let endpoint = (ARTICLE_IMPORT && ARTICLE_IMPORT.API_URL && String(ARTICLE_IMPORT.API_URL).trim()) || undefined;
    let overrideKey = (ARTICLE_IMPORT && ARTICLE_IMPORT.API_KEY && String(ARTICLE_IMPORT.API_KEY).trim()) || undefined;
    if (!endpoint && ARTICLE_IMPORT && ARTICLE_IMPORT.PROFILE && AI_PROFILES[ARTICLE_IMPORT.PROFILE]) {
        endpoint = AI_PROFILES[ARTICLE_IMPORT.PROFILE].apiUrl || endpoint;
        overrideKey = AI_PROFILES[ARTICLE_IMPORT.PROFILE].apiKey || overrideKey;
    }

    const temperature = (typeof temp === 'number') ? temp : (ARTICLE_IMPORT?.temperature ?? 0.1);
    const maxTokens = ARTICLE_IMPORT?.maxTokens ?? 1800;
    const timeoutMs = (typeof toMs === 'number') ? toMs : (ARTICLE_IMPORT?.timeoutMs ?? 30000);

    // 指令：從 HTML 擷取正文並輸出 Markdown 純文字
    const sys = (AI_PROMPTS && AI_PROMPTS.import && AI_PROMPTS.import.extractor && AI_PROMPTS.import.extractor.system)
      || 'You are a precise content extractor that outputs clean Markdown. Do not translate or add commentary.';
    const rulesArr = (() => {
        const p = AI_PROMPTS && AI_PROMPTS.import && AI_PROMPTS.import.extractor;
        if (p) {
            if (keepImages && Array.isArray(p.rulesKeepImages)) return p.rulesKeepImages;
            if (!keepImages && Array.isArray(p.rulesNoImages)) return p.rulesNoImages;
        }
        return [
            '- 保留正文的結構：# 標題、段落、清單、表格、區塊引用、程式碼區塊（僅當確為程式碼）。',
            keepImages
                ? '- 將與正文相關的圖片保留為 Markdown 圖片行（![]()）。避免社交/廣告/追蹤用圖；為保留的圖片填入 alt（沿用原 alt 或鄰近 caption；不要改寫），URL 轉為絕對路徑。'
                : '- 移除所有圖片，不要以文字替代。',
            '- 徹底移除網站導航、側欄、頁尾、Cookie 提示、語言切換、社交分享、推薦卡、廣告、留言模組、版權宣告。',
            '- 不要新增任何強調或裝飾標記：嚴禁使用 * 或 _ 產生粗斜體；不要輸出純裝飾分隔線（-----、_______、****、====、••• 等）或無意義圖示（▶︎◆•·►等）。',
            '- 僅輸出 Markdown 純文字，不要使用 ``` 程式碼圍欄，也不要額外解釋。',
            '- 解析相對 URL（連結與圖片）為絕對 URL，基於提供的 Base URL。',
            '- 對連結移除追蹤參數（utm_*、fbclid、ref 等），清理多餘空白，但不要改動正文語句與標點。'
        ];
    })();
    const rules = rulesArr.join('\n');

    const content = [
        { role: 'system', content: sys },
        { role: 'user', content: `Base URL: ${url || '(unknown)'}\n規則：\n${rules}\n\n=== HTML 開始 ===\n${String(html || '')}\n=== HTML 結束 ===` }
    ];

    const data = await requestAI({
        apiUrl: endpoint,
        apiKey: overrideKey,
        model,
        messages: content,
        temperature,
        maxTokens,
        timeoutMs,
        signal
    });

    let md = (data?.choices?.[0]?.message?.content || '').trim();
    // 去掉偶發的 ``` 標記
    md = md.replace(/^```(?:markdown)?\n/, '').replace(/\n```\s*$/, '').trim();
    return md;
}

/**
 * 直接抓取 HTML（若 CORS 允許），再交給 AI 產生乾淨 Markdown。
 * - 若 noThirdPartyGateway 為 false，且直抓失敗，會回退到 r.jina.ai + 清洗。
 * - 若為 true，直抓失敗則丟錯，避免觸發第三方服務。
 */
export async function fetchArticleCleanMarkdown(url, opts = {}) {
    const { keepImages = true, noThirdPartyGateway = false, timeoutMs = 30000, signal, model } = opts;
    let u;
    try { u = new URL(url, window.location.href); } catch (_) { throw new Error('URL 無效'); }
    if (!/^https?:$/i.test(u.protocol)) throw new Error('僅支援 http/https');

    // 先嘗試直接抓取 HTML（受制於對方 CORS）
    try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(new DOMException('Timeout', 'AbortError')), timeoutMs);
        const resp = await fetch(u.toString(), { signal: signal || ac.signal, headers: { 'Accept': 'text/html,application/xhtml+xml' } });
        clearTimeout(timer);
        if (resp.ok) {
            const html = await resp.text();
            const md = await aiExtractArticleFromHtml(html, { url: u.toString(), keepImages, timeoutMs, signal, model });
            return md;
        }
    } catch (_) { /* fallthrough */ }

    // 嘗試使用自有代理（若已配置）
    try {
        const proxy = ARTICLE_IMPORT && ARTICLE_IMPORT.PROXY_URL && String(ARTICLE_IMPORT.PROXY_URL).trim();
        if (proxy) {
            const pu = new URL(proxy);
            // 允許 ?url= 形式；若使用路徑佔位，則直接拼接
            if (!pu.searchParams.get('url')) pu.searchParams.set('url', u.toString());
            const ac = new AbortController();
            const timer = setTimeout(() => ac.abort(new DOMException('Timeout', 'AbortError')), timeoutMs);
            const resp = await fetch(pu.toString(), { signal: signal || ac.signal, headers: { 'Accept': 'text/html,application/xhtml+xml' } });
            clearTimeout(timer);
            if (resp.ok) {
                const html = await resp.text();
                const md = await aiExtractArticleFromHtml(html, { url: u.toString(), keepImages, timeoutMs, signal, model });
                return md;
            }
        }
    } catch (_) { /* ignore */ }

    if (noThirdPartyGateway) {
        throw new Error('目標站點禁止直抓或網路受限。請允許第三方轉換，或貼上全文/HTML。');
    }

    // 回退：使用 r.jina.ai 取得可讀文本 → 再清洗
    const raw = await fetchArticleFromUrl(u.toString(), { timeoutMs, signal });
    const md = await aiCleanArticleMarkdown(raw, { timeoutMs, signal, keepImages, model });
    return md;
}

function normalizeImportedText(text) {
    const t = (text || '').replace(/\u00A0/g, ' ');
    // 將 3+ 連續空行縮為 2 空行，避免過多間距
    return t.replace(/\n{3,}/g, '\n\n').trim();
}

function extractReadableFallback(html) {
    // 超輕量抽取：刪除 script/style，保留常見正文區域
    try {
        const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
        doc.querySelectorAll('script,style,noscript,iframe').forEach(n => n.remove());
        const target = doc.querySelector('article, main, [role="main"], #content, .post, .article, .entry, .story') || doc.body;
        const walker = doc.createTreeWalker(target, NodeFilter.SHOW_TEXT, null);
        const lines = [];
        let node;
        while ((node = walker.nextNode())) {
            const s = (node.nodeValue || '').replace(/[\t\r]+/g, ' ').replace(/\s+/g, ' ').trim();
            if (!s) continue;
            // 跳過導航/頁尾等常見噪音
            const p = node.parentElement;
            if (p && /nav|footer|header|menu|aside|breadcrumb/i.test(p.tagName)) continue;
            lines.push(s);
        }
        // 粗略分段：遇到句末標點或原始換行
        const joined = lines.join('\n');
        return joined.replace(/\n{2,}/g, '\n\n');
    } catch (_) {
        return (html || '').replace(/<[^>]+>/g, '\n');
    }
}
