// OpenAI-compatible Chat Completions adapter.

import {
    buildAuthHeaders,
    deriveChatEndpoints,
    joinTextParts,
    normalizeMessages,
    parseDataUrl,
    statusToCode,
    makeError
} from './common.js';

function toChatContent(parts) {
    const hasImage = parts.some((part) => part.type === 'image');
    if (!hasImage) return parts.map((part) => part.text || '').join('\n');
    return parts.map((part) => (part.type === 'image'
        ? { type: 'image_url', image_url: { url: part.imageUrl, detail: 'high' } }
        : { type: 'text', text: part.text || '' }));
}

function toChatMessages(messages) {
    return normalizeMessages(messages).map((message) => ({
        role: message.role,
        content: toChatContent(message.parts)
    }));
}

export const chatCompletions = {
    id: 'openai-chat',
    labelKey: 'settings.aiFormatChat',
    defaultAuthMode: 'bearer',
    authModes: ['bearer', 'x-api-key', 'none'],
    capabilities: { text: 'yes', images: 'yes', json: 'yes', stream: 'yes', models: 'yes' },

    deriveEndpoints(input = {}) {
        return deriveChatEndpoints(input);
    },

    buildHeaders({ apiKey, authMode, stream }) {
        return {
            'Content-Type': 'application/json',
            Accept: stream ? 'text/event-stream' : 'application/json',
            ...buildAuthHeaders(this, { apiKey, authMode })
        };
    },

    buildRequest({ provider, apiKey, model, messages, temperature = 0.5, maxTokens, responseFormat, stream }) {
        const body = {
            model,
            messages: toChatMessages(messages),
            temperature
        };
        if (typeof maxTokens === 'number' && maxTokens > 0) body.max_tokens = maxTokens;
        if (responseFormat) {
            body.response_format = typeof responseFormat === 'string' ? { type: responseFormat } : responseFormat;
        }
        if (stream) body.stream = true;
        return {
            url: provider.apiUrl,
            headers: this.buildHeaders({ apiKey, authMode: provider.authMode, stream }),
            body
        };
    },

    parseResponse(json) {
        const choice = json?.choices?.[0] || {};
        const message = choice.message || {};
        const text = joinTextParts(message.content).trim()
            || joinTextParts(message.reasoning_content).trim()
            || joinTextParts(choice.delta?.content).trim()
            || joinTextParts(json?.output_text).trim();
        return {
            text,
            finishReason: choice.finish_reason || '',
            usage: json?.usage || null,
            model: json?.model || '',
            refusal: message.refusal || ''
        };
    },

    parseStreamEvent({ data }) {
        if (!data) return { done: false };
        if (data.trim() === '[DONE]') return { done: true };
        let json;
        try { json = JSON.parse(data); } catch (_) { return { done: false }; }
        const choice = json?.choices?.[0] || {};
        const delta = joinTextParts(choice.delta?.content)
            || joinTextParts(choice.delta?.reasoning_content);
        return {
            text: delta || '',
            finishReason: choice.finish_reason || '',
            done: false
        };
    },

    parseModels(payload) {
        const items = Array.isArray(payload?.data) ? payload.data
            : (Array.isArray(payload?.models) ? payload.models : []);
        return items.map((item) => ({
            id: String(typeof item === 'string' ? item : (item?.id || item?.model || item?.name || '')).replace(/^models\//, '').trim(),
            label: String(typeof item === 'string' ? item : (item?.display_name || item?.displayName || item?.id || item?.name || '')).trim()
        })).filter((item) => item.id);
    },

    modelsRequest({ provider, apiKey }) {
        return {
            url: provider.modelsUrl,
            headers: {
                Accept: 'application/json',
                ...buildAuthHeaders(this, { apiKey, authMode: provider.authMode })
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
        const detail = payload?.error?.message || payload?.error || payload?.message || '';
        return makeError(statusToCode(status), typeof detail === 'string' ? detail.slice(0, 300) : '', { status });
    }
};

export { parseDataUrl };
