import { API_URL, API_KEY, AI_MODELS, OCR_CONFIG } from '../ai-config.js';
import { loadGlobalSettings, loadGlobalSecrets } from './settings.js';
import * as cache from './cache.js';
import * as validate from './validate.js';

// =================================
// AI API 服務
// =================================

// Small, reusable AI request helper with timeout and retry.
async function requestAI({ model, messages, temperature = 0.5, maxTokens, timeoutMs = 30000, signal, responseFormat, apiUrl, apiKey }) {
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
        const s = loadGlobalSettings();
        const sec = loadGlobalSecrets();
        // allow per-call override by passing apiUrl/apiKey; otherwise fall back to global settings, then static config
        const endpoint = (apiUrl && String(apiUrl).trim()) || (s?.ai?.apiUrl && String(s.ai.apiUrl).trim()) || API_URL;
        const key = (apiKey && String(apiKey).trim()) || (sec?.aiApiKey && String(sec.aiApiKey).trim()) || API_KEY;
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
        const prompt = `Please provide a detailed analysis for the word "${word}". Return the result in a strict JSON format with the following keys: "phonetic" (IPA), "pos" (part of speech), and "meaning" (the most common Traditional Chinese (Hong Kong) meaning). For example: {"phonetic": "ɪɡˈzæmpəl", "pos": "noun", "meaning": "例子"}. Ensure the meaning is in Traditional Chinese (Hong Kong) vocabulary (e.g., 網上/上載/電郵/巴士/的士/單車/軟件/網絡/連結/相片).`;
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
    const prompt = `請為單詞 "${word.word}" 生成3個英文例句。對於每個例句，請提供英文、中文翻譯（使用香港繁體中文用字），以及一個英文單詞到中文詞語的對齊映射數組。請確保對齊盡可能精確。請只返回JSON格式的數組，不要有其他任何文字。格式為: [{"english": "...", "chinese": "...", "alignment": [{"en": "word", "zh": "詞語"}, ...]}, ...]`;
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
    const prompt = `請判斷以下這個使用單詞 "${word}" 的句子在語法和用法上是否正確: "${userSentence}"。如果正確，請只回答 "正確"。如果不正確，請詳細指出錯誤並提供一個修改建議，格式為 "不正確。建議：[你的建議]"。並總結錯誤的知識點。`;
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
    // Force the paragraph analyzer to always use the minimal output mode.
    // We still respect the caller-provided "level" for cache keying to avoid repeated requests,
    // but the effective behavior is always equivalent to 'quick'.
    const { timeoutMs = 45000, signal, level: requestedLevel = 'standard', noCache = false } = opts;
    const EFFECTIVE_LEVEL = 'quick';
    const s = loadGlobalSettings();
    const model = (s?.ai?.models && s.ai.models.articleAnalysis) || AI_MODELS.articleAnalysis || AI_MODELS.wordAnalysis;

    // local cache lookup (keyed by requestedLevel so UI won't keep re-triggering)
    if (!noCache) {
        try {
            const cached = await cache.getParagraphAnalysisCached(paragraph, requestedLevel, model);
            if (cached) return cached;
        } catch (e) { /* ignore cache errors */ }
    }

    // Minimal instruction: translation only, HK Traditional Chinese wording, and preserve Markdown structures
    const instructions = `只返回 JSON：{"chinese_translation":"..."}
要求：
- 翻譯請使用繁體中文符合香港中文習慣，不要廣東話。 英文姓名不用翻譯；
- 用字遵從香港中文（例如：網上、上載、電郵、巴士、的士、單車、軟件、網絡、連結、相片）。
- 若段落包含 Markdown 結構（如表格、清單、標題），請完整保留原始 Markdown 標記與行結構：
  * 表格：保留每行的管線符號與對齊行（如 | --- |），不要將表格展平成普通句子。
  * 清單：保留項目前綴（-、*、1. 等）與每項一行。
  * 圖片：對於 Markdown 圖片標記（例如：![](URL) 或 ![alt](URL)），請保持原樣在輸出中，不要翻譯或改寫其中的 alt 文字，也不要移除；若圖片單獨成段，保留為同一 Markdown 行。
- 不要返回 word_alignment 與 detailed_analysis。`;

    const prompt = `請對以下英文段落進行分析並返回嚴格有效的 JSON（不允許代碼塊或額外解釋）：

段落: """
${paragraph}
"""

${instructions}`;

    const maxTokens = 600; // minimal output
    try {
        const data = await requestAI({
            model,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.2,
            maxTokens,
            timeoutMs,
            signal,
            responseFormat: { type: 'json_object' }
        });
        let content = (data?.choices?.[0]?.message?.content || '').replace(/^```json\n/, '').replace(/\n```$/, '').trim();
        try {
            const parsed = JSON.parse(content);
            if (!validate.validateArticleAnalysis(parsed, EFFECTIVE_LEVEL)) {
                throw new Error('Schema validation failed');
            }
            try {
                // Cache using the requested level key to prevent redundant calls from UI
                const ttlMs = 14*24*60*60*1000; // 14 days for minimal mode
                await cache.setParagraphAnalysisCached(paragraph, requestedLevel, model, parsed, ttlMs);
            } catch(_) {}
            return parsed;
        } catch (e) {
            const fixed = content.replace(/,\s*([}\]])/g, '$1').replace(/(\{|\[)\s*,/g, '$1');
            const parsed = JSON.parse(fixed);
            if (!validate.validateArticleAnalysis(parsed, EFFECTIVE_LEVEL)) {
                throw new Error('Schema validation failed after fix');
            }
            try { const ttlMs = 14*24*60*60*1000; await cache.setParagraphAnalysisCached(paragraph, requestedLevel, model, parsed, ttlMs);} catch(_){}
            return parsed;
        }
    } catch (err) {
        console.warn('段落分析失敗，回退到最小輸出。', err);
        // 最小回退：僅翻譯
        const fbPrompt = `只返回 JSON：{"chinese_translation":"..."}
請使用繁體中文符合香港中文習慣，不要廣東話。
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
        try { const ttlMs = 7*24*60*60*1000; await cache.setParagraphAnalysisCached(paragraph, requestedLevel, model, parsed, ttlMs);} catch(_){}
        return parsed;
    }
}

/**
 * 懶載：針對單個詞（或短語）在其所在句子中的詳解。
 */
export async function analyzeWordInSentence(word, sentence, opts = {}) {
    const { timeoutMs = 20000, signal } = opts;
    const s = loadGlobalSettings();
    const model = (s?.ai?.models && s.ai.models.wordAnalysis) || AI_MODELS.wordAnalysis || AI_MODELS.articleAnalysis;
    // local cache lookup
    try {
        const cached = await cache.getWordAnalysisCached(word, sentence, model);
        if (cached) return cached;
    } catch (_) {}
    const prompt = `請針對下列句子中的目標詞進行語音/詞性/語義與句法作用的簡潔分析，返回嚴格 JSON（中文請使用繁體中文符合香港中文習慣，不要廣東話。）：
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
    const s = loadGlobalSettings();
    const model = (s?.ai?.models && s.ai.models.articleAnalysis) || AI_MODELS.articleAnalysis || AI_MODELS.wordAnalysis;
    let contextHash = '';
    try { contextHash = await cache.makeKey('ctx', context); } catch (_) {}
    if (!noCache) {
        try {
            const cached = await cache.getSentenceAnalysisCached(sentence, contextHash, model);
            if (cached) return cached;
        } catch (_) {}
    }
    const keyPointRule = '請輸出 2-4 條最重要的關鍵點；避免與片語/結構重覆描述，偏向語義/語氣/結構/常見誤用等高階提示。中文請使用香港繁體中文用字。';
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
        const fbPrompt = `僅翻譯下列句子並提煉 2-3 條關鍵點（JSON，中文請使用繁體中文符合香港中文習慣，不要廣東話。）：\n{\"sentence\":\"${sentence}\",\"translation\":\"...\",\"key_points\":[\"...\"]}`;
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
    const s = loadGlobalSettings();
    const model = (s?.ai?.models && s.ai.models.wordAnalysis) || AI_MODELS.wordAnalysis || AI_MODELS.articleAnalysis;
    let contextHash = '';
    try { contextHash = await cache.makeKey('ctx', context); } catch (_) {}
    if (!noCache) {
        const cached = await cache.getSelectionAnalysisCached(selection, sentence, contextHash, model);
        if (cached) return cached;
    }
    const prompt = `針對句子中的選中片語給出簡潔解析（JSON，中文請使用繁體中文符合香港中文習慣，不要廣東話。）。\n請同時提供該片語的國際音標 IPA：若能提供片語整體讀音則給整體讀音；若無可靠整體讀音，可用逐詞 IPA 串接（用空格分隔）。\n選中: \"${selection}\"\n句子: \"${sentence}\"\n上下文: \"${context}\"\n只返回：{\"selection\":\"...\",\"sentence\":\"...\",\"analysis\":{\"phonetic\":\"IPA\",\"meaning\":\"...\",\"usage\":\"...\",\"examples\":[{\"en\":\"...\",\"zh\":\"...\"}]}}`;
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

// =================================
// Image OCR (Vision) API
// =================================

/**
 * 將圖片中的文字抽取為純文字。
 * imageDataUrl: Data URL（data:image/...;base64,...），建議經過壓縮/縮放。
 */
export async function ocrExtractTextFromImage(imageDataUrl, opts = {}) {
    const {
        promptHint = '請將圖片中的文字內容完整擷取為純文字，保留原始換行與標點；不要翻譯或改寫。若為截圖，請忽略 UI 按鈕與雜訊，只輸出正文。',
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

    const endpoint = (OCR_CONFIG && OCR_CONFIG.API_URL && String(OCR_CONFIG.API_URL).trim()) || undefined; // fallback to global in requestAI
    const overrideKey = (OCR_CONFIG && OCR_CONFIG.API_KEY && String(OCR_CONFIG.API_KEY).trim()) || undefined;
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
                { type: 'text', text: promptHint },
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

    const endpoint = (OCR_CONFIG && OCR_CONFIG.API_URL && String(OCR_CONFIG.API_URL).trim()) || undefined;
    const overrideKey = (OCR_CONFIG && OCR_CONFIG.API_KEY && String(OCR_CONFIG.API_KEY).trim()) || undefined;
    const finalTimeout = typeof timeoutMs === 'number' ? timeoutMs : (OCR_CONFIG?.timeoutMs || 60000);

    const defaultPrompt = `這是一張默寫單詞的相片。請直接在圖片中擷取學生書寫內容並進行批改：
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

// =================================
// AI 清洗與格式優化（Markdown 保留）
// =================================

/**
 * 讓 AI 清洗已抽取的 Markdown 文章，保留結構與圖片；移除站點噪音；不翻譯內容。
 * 返回乾淨的 Markdown 純文字。
 */
export async function aiCleanArticleMarkdown(markdownText, opts = {}) {
    const { timeoutMs = 25000, temperature = 0.1, signal, model: modelOverride, keepImages = true } = opts;
    const s = loadGlobalSettings();
    const model = modelOverride
      || (s?.ai?.models && (s.ai.models.articleCleanup || s.ai.models.articleAnalysis))
      || AI_MODELS.articleAnalysis;

    const prompt = `你會收到一篇以 Markdown 表示的英文文章（可能含標題、清單、表格、圖片）。請清洗並輸出更適合閱讀的 Markdown：
- 僅保留正文與必要的標題/段落/清單/表格；移除網站導航、語言切換、社交按鈕、推薦卡片、廣告、版權宣告、留言模組、追蹤用圖片或計數器。
- ${keepImages ? '保留 Markdown 圖片行（例如：![alt](URL)），不要翻譯或改寫 alt，也不要內嵌說明；若圖片非內容相關或為社交/追蹤橫幅，請移除。' : '移除所有 Markdown 圖片行（例如：![alt](URL)），不要以連結或描述替代圖片。'}
- 保持原文語言與內容，不要翻譯、不新增解說；僅做結構整理、去噪聲、合併多餘空行，統一為合理段落。
- 若沒有明確主標題而開頭存在明顯標題，轉為一行 ATX 標題（# Title）。
- 嚴禁輸出任何額外解釋或代碼區塊標記；只輸出清洗後的 Markdown 純文字。`;

    const data = await requestAI({
        model,
        messages: [
            { role: 'system', content: 'You are a precise Markdown editor that preserves structure and removes noise without translating.' },
            { role: 'user', content: `${prompt}\n\n=== 原文開始 ===\n${markdownText}\n=== 原文結束 ===` }
        ],
        temperature,
        maxTokens: 1400,
        timeoutMs,
        signal
    });
    let content = (data?.choices?.[0]?.message?.content || '').trim();
    // 去掉偶發的 ``` 標記
    content = content.replace(/^```(?:markdown)?\n/, '').replace(/\n```\s*$/, '').trim();
    return content;
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
