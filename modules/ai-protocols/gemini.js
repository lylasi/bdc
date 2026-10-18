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

    buildRequest({ provider, apiKey, model, messages, temperature = 0.5, maxTokens, responseFormat, stream }) {
        const converted = toGeminiContents(messages);
        const generationConfig = { temperature };
        if (typeof maxTokens === 'number' && maxTokens > 0) generationConfig.maxOutputTokens = maxTokens;
        if (responseFormat) generationConfig.responseMimeType = 'application/json';
        const body = {
            contents: converted.contents,
            generationConfig
        };
        if (converted.system) body.systemInstruction = { parts: [{ text: converted.system }] };
        return {
            url: this.generationUrl(provider, model, { stream }),
            headers: this.buildHeaders({ apiKey, authMode: provider.authMode, stream }),
            body
        };
    },

    parseResponse(json) {
        const candidate = json?.candidates?.[0] || {};
        const parts = candidate?.content?.parts;
        const text = Array.isArray(parts) ? parts.map((part) => part.text || '').join('').trim() : '';
        const blockReason = json?.promptFeedback?.blockReason || candidate?.finishReason === 'SAFETY' ? (json?.promptFeedback?.blockReason || 'SAFETY') : '';
        return {
            text,
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
        const parts = candidate?.content?.parts;
        const text = Array.isArray(parts) ? parts.map((part) => part.text || '').join('') : '';
        return {
            text,
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
