import { API_URL, API_KEY, AI_MODELS } from '../ai-config.js';
import * as cache from './cache.js';
import * as validate from './validate.js';

// =================================
// AI API 服務
// =================================

// Small, reusable AI request helper with timeout and retry.
async function requestAI({ model, messages, temperature = 0.5, maxTokens, timeoutMs = 30000, signal, responseFormat }) {
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

    const body = {
        model,
        messages,
        temperature,
    };
    if (typeof maxTokens === 'number') body.max_tokens = maxTokens;
    if (responseFormat) {
        body.response_format = typeof responseFormat === 'string' ? { type: responseFormat } : responseFormat;
    }

    const fetchOnce = async () => {
        const resp = await fetch(API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}`
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
        const prompt = `Please provide a detailed analysis for the word "${word}". Return the result in a strict JSON format with the following keys: "phonetic" (IPA), "pos" (part of speech), and "meaning" (the most common Traditional Chinese meaning). For example: {"phonetic": "ɪɡˈzæmpəl", "pos": "noun", "meaning": "例子"}. Ensure the meaning is in Traditional Chinese.`;
        return await fetchAIResponse(AI_MODELS.wordAnalysis, prompt, 0.2);
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
    const prompt = `請為單詞 "${word.word}" 生成3個英文例句。對於每個例句，請提供英文、中文翻譯，以及一個英文單詞到中文詞語的對齊映射數組。請確保對齊盡可能精確。請只返回JSON格式的數組，不要有其他任何文字。格式為: [{"english": "...", "chinese": "...", "alignment": [{"en": "word", "zh": "詞語"}, ...]}, ...]`;
    return await fetchAIResponse(AI_MODELS.exampleGeneration, prompt, 0.7, { maxTokens: 600, timeoutMs: 20000, ...opts });
}

/**
 * 檢查用戶造句的正確性。
 * @param {string} word - 句子中使用的核心單詞。
 * @param {string} userSentence - 用戶創建的句子。
 * @returns {Promise<string>} - AI 的反饋文本。
 */
export async function checkUserSentence(word, userSentence, opts = {}) {
    const prompt = `請判斷以下這個使用單詞 "${word}" 的句子在語法和用法上是否正確: "${userSentence}"。如果正確，請只回答 "正確"。如果不正確，請詳細指出錯誤並提供一個修改建議，格式為 "不正確。建議：[你的建議]"。並總結錯誤的知識點。`;
    return await fetchAIResponse(AI_MODELS.sentenceChecking, prompt, 0.5, { maxTokens: 400, timeoutMs: 15000, ...opts });
}

/**
 * 分析文章中的單個段落。
 * @param {string} paragraph - 要分析的段落。
 * @returns {Promise<object>} - 包含段落分析結果的對象。
 */
export async function analyzeParagraph(paragraph, opts = {}) {
    const { timeoutMs = 45000, signal, level = 'standard', detailTopN = 12, noCache = false } = opts;
    const model = AI_MODELS.articleAnalysis || AI_MODELS.wordAnalysis;

    // local cache lookup
    if (!noCache) {
        try {
            const cached = await cache.getParagraphAnalysisCached(paragraph, level, model);
            if (cached) return cached;
        } catch (e) { /* ignore cache errors */ }
    }

    // Compose instructions by level
    let instructions = '';
    if (level === 'quick') {
        instructions = `只返回 JSON：{"chinese_translation":"..."}
要求：
- 翻譯請使用繁體中文（正體），語氣自然流暢；
- 不要返回 word_alignment 與 detailed_analysis。`;
    } else if (level === 'standard') {
        instructions = `只返回 JSON：{"chinese_translation":"...","detailed_analysis":[...]} 
detailed_analysis 僅針對本段最關鍵的 ${detailTopN} 個詞，格式：
{"word":"單詞","sentence":"所在完整句子","analysis":{"phonetic":"IPA","pos":"詞性","meaning":"中文意思","role":"在句中的語法作用（簡潔）"}}`;
    } else {
        instructions = `只返回 JSON：{"chinese_translation":"...","detailed_analysis":[...]} 
detailed_analysis 應覆蓋段落中的所有詞（或主要詞），按出現順序，同詞多次出現需分條。每條格式：
{"word":"單詞","sentence":"所在完整句子","analysis":{"phonetic":"IPA","pos":"詞性","meaning":"中文意思","role":"在句中的語法作用（具體）"}}`;
    }

    const prompt = `請對以下英文段落進行分析並返回嚴格有效的 JSON（不允許代碼塊或額外解釋）：

段落: """
${paragraph}
"""

${instructions}`;

    const maxTokens = level === 'quick' ? 600 : level === 'standard' ? 1000 : 1500;
    try {
        const data = await requestAI({
            model,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.3,
            maxTokens,
            timeoutMs,
            signal,
            responseFormat: { type: 'json_object' }
        });
        let content = (data?.choices?.[0]?.message?.content || '').replace(/^```json\n/, '').replace(/\n```$/, '').trim();
        try {
            const parsed = JSON.parse(content);
            if (!validate.validateArticleAnalysis(parsed, level)) {
                throw new Error('Schema validation failed');
            }
            try {
                // store in cache (TTL varies by level)
                const ttlMs = level === 'quick' ? 14*24*60*60*1000 : level === 'standard' ? 21*24*60*60*1000 : 30*24*60*60*1000;
                await cache.setParagraphAnalysisCached(paragraph, level, model, parsed, ttlMs);
            } catch(_) {}
            return parsed;
        } catch (e) {
            const fixed = content.replace(/,\s*([}\]])/g, '$1').replace(/(\{|\[)\s*,/g, '$1');
            const parsed = JSON.parse(fixed);
            if (!validate.validateArticleAnalysis(parsed, level)) {
                throw new Error('Schema validation failed after fix');
            }
            try { const ttlMs = level === 'quick' ? 14*24*60*60*1000 : level === 'standard' ? 21*24*60*60*1000 : 30*24*60*60*1000; await cache.setParagraphAnalysisCached(paragraph, level, model, parsed, ttlMs);} catch(_){}
            return parsed;
        }
    } catch (err) {
        console.warn('段落分析失敗，回退到最小輸出。', err);
        // 最小回退：僅翻譯
        const fbPrompt = `只返回 JSON：{"chinese_translation":"..."}
請使用繁體中文（正體）進行翻譯。
段落:"""
${paragraph}
"""`;
        const fb = await requestAI({
            model,
            messages: [{ role: 'user', content: fbPrompt }],
            temperature: 0.2,
            maxTokens: 500,
            timeoutMs,
            signal,
            responseFormat: { type: 'json_object' }
        });
        let content = (fb?.choices?.[0]?.message?.content || '').replace(/^```json\n/, '').replace(/\n```$/, '').trim();
        const base = JSON.parse(content);
        const parsed = { chinese_translation: base.chinese_translation || '', word_alignment: [], detailed_analysis: [] };
        try { const ttlMs = 7*24*60*60*1000; await cache.setParagraphAnalysisCached(paragraph, level, model, parsed, ttlMs);} catch(_){}
        return parsed;
    }
}

/**
 * 懶載：針對單個詞（或短語）在其所在句子中的詳解。
 */
export async function analyzeWordInSentence(word, sentence, opts = {}) {
    const { timeoutMs = 20000, signal } = opts;
    const model = AI_MODELS.wordAnalysis || AI_MODELS.articleAnalysis;
    // local cache lookup
    try {
        const cached = await cache.getWordAnalysisCached(word, sentence, model);
        if (cached) return cached;
    } catch (_) {}
    const prompt = `請針對下列句子中的目標詞進行語音/詞性/語義與句法作用的簡潔分析，返回嚴格 JSON：
詞: "${word}"
句: "${sentence}"
只返回：{"word":"...","sentence":"...","analysis":{"phonetic":"IPA","pos":"詞性","meaning":"中文意思","role":"語法作用（簡潔）"}}`;
    const data = await requestAI({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        maxTokens: 300,
        timeoutMs,
        signal,
        responseFormat: { type: 'json_object' }
    });
    let content = (data?.choices?.[0]?.message?.content || '').replace(/^```json\n/, '').replace(/\n```$/, '').trim();
    try {
        const parsed = JSON.parse(content);
        if (!validate.validateWordInSentence(parsed)) throw new Error('Schema validation failed');
        try { await cache.setWordAnalysisCached(word, sentence, model, parsed, 30*24*60*60*1000);} catch(_){}
        return parsed;
    } catch (e) {
        const fixed = content.replace(/,\s*([}\]])/g, '$1').replace(/(\{|\[)\s*,/g, '$1');
        const parsed = JSON.parse(fixed);
        if (!validate.validateWordInSentence(parsed)) throw e;
        try { await cache.setWordAnalysisCached(word, sentence, model, parsed, 30*24*60*60*1000);} catch(_){}
        return parsed;
    }
}

// --- Sentence-level analysis ---
export async function analyzeSentence(sentence, context = '', opts = {}) {
    const { timeoutMs = 20000, signal, noCache = false, conciseKeypoints = true, includeStructure = true } = opts;
    const model = AI_MODELS.articleAnalysis || AI_MODELS.wordAnalysis;
    let contextHash = '';
    try { contextHash = await cache.makeKey('ctx', context); } catch (_) {}
    if (!noCache) {
        try {
            const cached = await cache.getSentenceAnalysisCached(sentence, contextHash, model);
            if (cached) return cached;
        } catch (_) {}
    }
    const keyPointRule = '請輸出 2-4 條最重要的關鍵點；避免與片語/結構重覆描述，偏向語義/語氣/結構/常見誤用等高階提示。';
    const basePrompt = `上下文（僅供理解，不要逐句分析）: \"\"\"\n${context}\n\"\"\"\n目標句: \"\"\"\n${sentence}\n\"\"\"`;
    const prompt = includeStructure
      ? `對下列英文句子進行分析，返回嚴格 JSON：\n${basePrompt}\n只返回：{\n  \"sentence\":\"...\",\n  \"translation\":\"...\",\n  \"phrase_alignment\":[{\"en\":\"...\",\"zh\":\"...\"}],\n  \"chunks\":[{\"text\":\"...\",\"role\":\"...\",\"note\":\"...\"}],\n  \"key_points\":[\"...\"]\n}\n${keyPointRule}`
      : `僅對下列英文句子進行精簡分析，返回嚴格 JSON：\n${basePrompt}\n只返回：{\n  \"sentence\":\"...\",\n  \"translation\":\"...\",\n  \"key_points\":[\"...\"]\n}\n${keyPointRule}`;
    try {
        const data = await requestAI({
            model,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.2,
            maxTokens: includeStructure ? 650 : 450,
            timeoutMs,
            signal,
            responseFormat: { type: 'json_object' }
        });
        const content = (data?.choices?.[0]?.message?.content || '').trim();
        const parsed = JSON.parse(content);
        if (!validate.validateSentenceAnalysis(parsed)) throw new Error('Schema validation failed');
        try { await cache.setSentenceAnalysisCached(sentence, contextHash, model, parsed, 21*24*60*60*1000); } catch(_){}
        return parsed;
    } catch (e) {
        const fbPrompt = `僅翻譯下列句子並提煉 2-3 條關鍵點（JSON）：\n{\"sentence\":\"${sentence}\",\"translation\":\"...\",\"key_points\":[\"...\"]}`;
        const fb = await requestAI({
            model,
            messages: [{ role: 'user', content: fbPrompt }],
            temperature: 0.2,
            maxTokens: 300,
            timeoutMs,
            signal,
            responseFormat: { type: 'json_object' }
        });
        const content = (fb?.choices?.[0]?.message?.content || '').trim();
        const parsed = JSON.parse(content);
        if (!parsed.translation) parsed.translation = '';
        if (!parsed.key_points) parsed.key_points = [];
        try { await cache.setSentenceAnalysisCached(sentence, contextHash, model, parsed, 7*24*60*60*1000); } catch(_){}
        return parsed;
    }
}

// --- Selection/phrase analysis ---
export async function analyzeSelection(selection, sentence, context = '', opts = {}) {
    const { timeoutMs = 15000, signal, noCache = false } = opts;
    const model = AI_MODELS.wordAnalysis || AI_MODELS.articleAnalysis;
    let contextHash = '';
    try { contextHash = await cache.makeKey('ctx', context); } catch (_) {}
    if (!noCache) {
        const cached = await cache.getSelectionAnalysisCached(selection, sentence, contextHash, model);
        if (cached) return cached;
    }
    const prompt = `針對句子中的選中片語給出簡潔解析（JSON）：\n選中: \"${selection}\"\n句子: \"${sentence}\"\n上下文: \"${context}\"\n返回：{\"selection\":\"...\",\"sentence\":\"...\",\"analysis\":{\"meaning\":\"...\",\"usage\":\"...\",\"examples\":[{\"en\":\"...\",\"zh\":\"...\"}]}}`;
    const data = await requestAI({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        maxTokens: 300,
        timeoutMs,
        signal,
        responseFormat: { type: 'json_object' }
    });
    const content = (data?.choices?.[0]?.message?.content || '').trim();
    const parsed = JSON.parse(content);
    if (!validate.validateSelectionAnalysis(parsed)) throw new Error('Schema validation failed');
    try { await cache.setSelectionAnalysisCached(selection, sentence, contextHash, model, parsed, 30*24*60*60*1000); } catch(_){}
    return parsed;
}
