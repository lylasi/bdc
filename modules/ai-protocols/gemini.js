// Gemini native adapter (generateContent / streamGenerateContent).
// Reference: https://ai.google.dev/api/generate-content

import {
    buildAuthHeaders,
    firstNonEmptyString,
    makeError,
    normalizeMessages,
    parseDataUrl,
    statusToCode,
    trimTrailingSlash
} from './common.js';
import { GEMINI_THINKING_BUDGETS } from '../ai-thinking.js';

const VERSION_PATH_RE = /\/(v\d+(?:beta|alpha)?\d*)$/i;

function splitGenerationUrl(url) {
    const raw = String(url || '');
    const match = raw.match(/^(.*)\/models\/([^/:?#]+)(?::(?:generateContent|streamGenerateContent))?(?:\?.*)?$/i);
    if (!match) return null;
    return { stem: match[1], model: decodeURIComponent(match[2]) };
}

function deriveGeminiEndpoints({ baseUrl = '', apiUrl = '', modelsUrl = '' } = {}) {
    const explicitModels = firstNonEmptyString(modelsUrl);
    const explicitApi = firstNonEmptyString(apiUrl);
    if (explicitApi) {
        const parsed = splitGenerationUrl(explicitApi);
        const stem = parsed ? parsed.stem : explicitApi.replace(/\/(?:models(?:\/[^/]+)?(?::\w+)?)?$/, '');
        const api = /\{model\}/.test(explicitApi)
            ? explicitApi
            : `${stem}/models/%7Bmodel%7D:generateContent`;
        return {
            baseUrl: trimTrailingSlash(baseUrl) || stem,
            apiUrl: api,
            modelsUrl: explicitModels || `${stem}/models`
        };
    }
    const base = trimTrailingSlash(baseUrl);
    if (!base) return { baseUrl: '', apiUrl: '', modelsUrl: explicitModels };
    const parsed = splitGenerationUrl(base);
    if (parsed) {
        return {
            baseUrl: parsed.stem,
            apiUrl: `${parsed.stem}/models/%7Bmodel%7D:generateContent`,
            modelsUrl: explicitModels || `${parsed.stem}/models`
        };
    }
    let stem = base;
    let pathname = '';
    try { pathname = new URL(base, 'https://placeholder.invalid').pathname; } catch (_) { pathname = base; }
    if (!VERSION_PATH_RE.test(pathname)) stem = `${base}/v1beta`;
    return {
        baseUrl: base,
        apiUrl: `${stem}/models/%7Bmodel%7D:generateContent`,
        modelsUrl: explicitModels || `${stem}/models`
    };
}

function toGeminiContents(messages) {
    const systemParts = [];
    const contents = [];
    for (const message of normalizeMessages(messages)) {
        if (message.role === 'system') {
            systemParts.push(message.parts.map((part) => part.text || '').join('\n'));
            continue;
        }
        const parts = message.parts.map((part) => {
            if (part.type === 'image') {
                const inline = parseDataUrl(part.imageUrl);
                return { inlineData: { mimeType: inline.mimeType, data: inline.data } };
            }
            return { text: part.text || '' };
        });
        contents.push({ role: message.role === 'assistant' ? 'model' : 'user', parts });
    }
    return { system: systemParts.join('\n\n').trim(), contents };
}

function normalizeModelName(model) {
    return String(model || '').trim().replace(/^models\//, '');
}

function geminiThinkingFamily(model) {
    const name = normalizeModelName(model).toLowerCase();
    if (/^gemini-3(?:[.-]|$)/.test(name)) return 'gemini-3';
    if (/^gemini-2\.5(?:[.-]|$)/.test(name)) return 'gemini-2.5';
    return '';
}

function isGemini25Pro(model) {
    return /^gemini-2\.5-pro(?:[.-]|$)/.test(normalizeModelName(model).toLowerCase());
}

/** Numeric thinking budget for Gemini 2.5, or null when the level has none. */
function gemini25ThinkingBudget(model, thinking) {
    if (!Object.prototype.hasOwnProperty.call(GEMINI_THINKING_BUDGETS, thinking)) return null;
    const budget = GEMINI_THINKING_BUDGETS[thinking];
    // Gemini 2.5 Pro does not accept thinkingBudget=0; 128 is the lowest value
    // it allows. `none` therefore means "minimum reasoning", not "off".
    // Flash keeps 0, which really disables thinking.
    if (budget === 0 && isGemini25Pro(model)) return 128;
    return budget;
}

/**
 * Gemini 把思考放在同一個 parts 陣列裡，以 `thought: true` 標記。
 * 拆成 { text, reasoning } 兩個欄位，避免思考片段被當成答案顯示。
 */
function splitThoughtParts(parts) {
    const answer = [];
    const reasoning = [];
    for (const part of Array.isArray(parts) ? parts : []) {
        if (part?.thought === true) reasoning.push(part.text || '');
        else answer.push(part?.text || '');
    }
    return { text: answer.join(''), reasoning: reasoning.join('') };
}

export const geminiNative = {
    id: 'gemini',
    labelKey: 'settings.aiFormatGemini',
    defaultAuthMode: 'google',
    authModes: ['google', 'bearer', 'none'],
    capabilities: { text: 'yes', images: 'yes', json: 'yes', stream: 'yes', models: 'yes' },

    deriveEndpoints(input = {}) {
        return deriveGeminiEndpoints(input);
    },

    buildHeaders({ apiKey, authMode, stream }) {
        const mode = authMode || this.defaultAuthMode;
        return {
            'Content-Type': 'application/json',
            Accept: stream ? 'text/event-stream' : 'application/json',
            ...buildAuthHeaders(this, { apiKey, authMode: mode })
        };
    },

    generationUrl(provider, model, { stream } = {}) {
        const template = String(provider.apiUrl || '').replace(/%7Bmodel%7D/gi, '{model}');
        const name = encodeURIComponent(normalizeModelName(model));
        const base = template.includes('{model}')
            ? template.replace('{model}', name)
            : `${trimTrailingSlash(template)}/models/${name}:generateContent`;
        if (!stream) return base.replace(/:streamGenerateContent/i, ':generateContent');
        return base
            .replace(/:generateContent/i, ':streamGenerateContent')
            .replace(/:streamGenerateContent/i, ':streamGenerateContent')
            + (base.includes('?') ? '&alt=sse' : '?alt=sse');
    },

    buildRequest({ provider, apiKey, model, messages, temperature = 0.5, maxTokens, responseFormat, stream, thinking = 'auto' }) {
        const converted = toGeminiContents(messages);
        const generationConfig = { temperature };
        if (typeof maxTokens === 'number' && maxTokens > 0) generationConfig.maxOutputTokens = maxTokens;
        if (responseFormat) generationConfig.responseMimeType = 'application/json';
        if (thinking && thinking !== 'auto') {
            const family = geminiThinkingFamily(model);
            if (family === 'gemini-2.5') {
                const budget = gemini25ThinkingBudget(model, thinking);
                if (budget !== null) {
                    generationConfig.thinkingConfig = { thinkingBudget: budget };
                    // Gemini 2.5 counts thinking tokens inside maxOutputTokens.
                    // Reserve the budget plus at least 1024 tokens for the
                    // answer, otherwise a 16384-token budget can consume the
                    // whole allowance and return no visible text.
                    const answerReserve = typeof maxTokens === 'number' && maxTokens > 0
                        ? Math.max(maxTokens, 1024)
                        : 1024;
                    generationConfig.maxOutputTokens = budget + answerReserve;
                }
            } else if (family === 'gemini-3') {
                // Gemini 3 only exposes low/high; `none` is sent as the lowest
                // available level rather than claiming reasoning is disabled.
                generationConfig.thinkingConfig = {
                    thinkingLevel: (thinking === 'none' || thinking === 'low') ? 'low' : 'high'
                };
            }
        }
        const body = {
            contents: converted.contents,
            generationConfig
        };
        if (converted.system) body.systemInstruction = { parts: [{ text: converted.system }] };
        return {
            url: this.generationUrl(provider, model, { stream }),
            headers: this.buildHeaders({ apiKey, authMode: provider.authMode, stream }),
            body,
            // Gemini adds the thinking budget on top of the answer allowance,
            // so expose the final generationConfig value as the real budget.
            maxTokens: generationConfig.maxOutputTokens
        };
    },

    parseResponse(json) {
        const candidate = json?.candidates?.[0] || {};
        const { text, reasoning } = splitThoughtParts(candidate?.content?.parts);
        const blockReason = json?.promptFeedback?.blockReason || candidate.finishReason === 'SAFETY' ? (json?.promptFeedback?.blockReason || 'SAFETY') : '';
        return {
            text: text.trim() || reasoning.trim(),
            reasoning: text.trim() ? reasoning.trim() : '',
            finishReason: candidate?.finishReason || '',
            usage: json?.usageMetadata || null,
            model: json?.modelVersion || '',
            refusal: blockReason ? String(blockReason) : ''
        };
    },

    parseStreamEvent({ data }) {
        if (!data) return { done: false };
        if (data.trim() === '[DONE]') return { done: true };
        let json;
        try { json = JSON.parse(data); } catch (_) { return { done: false }; }
        if (json?.error) {
            return { done: true, errorCode: 'provider_request_failed', errorMessage: json.error.message || '' };
        }
        const blocked = json?.promptFeedback?.blockReason;
        if (blocked) return { done: true, refusal: String(blocked) };
        const candidate = json?.candidates?.[0] || {};
        const { text, reasoning } = splitThoughtParts(candidate?.content?.parts);
        return {
            text,
            reasoning,
            finishReason: candidate?.finishReason || '',
            done: false
        };
    },

    parseModels(payload) {
        const items = Array.isArray(payload?.models) ? payload.models : [];
        return items.map((item) => {
            const methods = Array.isArray(item?.supportedGenerationMethods) ? item.supportedGenerationMethods : [];
            return {
                id: String(item?.name || '').replace(/^models\//, '').trim(),
                label: String(item?.displayName || item?.name || '').replace(/^models\//, '').trim(),
                supportsGeneration: methods.length === 0 || methods.includes('generateContent')
            };
        }).filter((item) => item.id && item.supportsGeneration);
    },

    modelsRequest({ provider, apiKey }) {
        return {
            url: provider.modelsUrl,
            headers: {
                Accept: 'application/json',
                ...buildAuthHeaders(this, {
                    apiKey,
                    authMode: provider.authMode === 'bearer' ? 'bearer' : (provider.authMode === 'none' ? 'none' : 'google')
                })
            }
        };
    },

    buildTestRequest({ provider, apiKey, model }) {
        return this.buildRequest({
            provider,
            apiKey,
            model,
            messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
            temperature: 0,
            maxTokens: 16,
            stream: false
        });
    },

    createHttpError(status, payload) {
        const detail = payload?.error?.message || payload?.message || '';
        return makeError(statusToCode(status), typeof detail === 'string' ? detail.slice(0, 300) : '', { status });
    }
};
