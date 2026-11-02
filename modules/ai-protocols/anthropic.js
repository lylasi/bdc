// Anthropic Messages adapter.
// Reference: https://docs.anthropic.com/en/api/messages

import {
    buildAuthHeaders,
    firstNonEmptyString,
    hasVersionSuffix,
    makeError,
    normalizeMessages,
    parseDataUrl,
    statusToCode,
    trimTrailingSlash
} from './common.js';
import { THINKING_BUDGETS } from '../ai-thinking.js';

export const ANTHROPIC_VERSION = '2023-06-01';

function deriveAnthropicEndpoints({ baseUrl = '', apiUrl = '', modelsUrl = '' } = {}) {
    const explicitApi = firstNonEmptyString(apiUrl);
    const explicitModels = firstNonEmptyString(modelsUrl);
    const base = trimTrailingSlash(baseUrl);
    if (explicitApi) {
        const api = explicitApi.replace(/\/+$/, '');
        const stem = api.replace(/\/messages$/i, '');
        return { baseUrl: base || stem, apiUrl: api, modelsUrl: explicitModels || (stem ? `${stem}/models` : '') };
    }
    if (!base) return { baseUrl: '', apiUrl: '', modelsUrl: explicitModels };
    let stem = base;
    try {
        if (!hasVersionSuffix(new URL(base, 'https://placeholder.invalid').pathname)) stem = `${base}/v1`;
    } catch (_) {
        stem = `${base}/v1`;
    }
    return {
        baseUrl: base,
        apiUrl: `${stem}/messages`,
        modelsUrl: explicitModels || `${stem}/models`
    };
}

function toAnthropicBlocks(parts) {
    return parts.map((part) => {
        if (part.type === 'image') {
            const inline = parseDataUrl(part.imageUrl);
            return {
                type: 'image',
                source: { type: 'base64', media_type: inline.mimeType, data: inline.data }
            };
        }
        return { type: 'text', text: part.text || '' };
    });
}

function toAnthropicMessages(messages) {
    const systemParts = [];
    const out = [];
    for (const message of normalizeMessages(messages)) {
        if (message.role === 'system') {
            systemParts.push(message.parts.map((part) => part.text || '').join('\n'));
            continue;
        }
        out.push({ role: message.role, content: toAnthropicBlocks(message.parts) });
    }
    return { system: systemParts.join('\n\n').trim(), messages: out };
}

export const anthropicMessages = {
    id: 'anthropic-messages',
    labelKey: 'settings.aiFormatAnthropic',
    defaultAuthMode: 'x-api-key',
    authModes: ['x-api-key', 'bearer', 'none'],
    capabilities: { text: 'yes', images: 'yes', json: 'prompt', stream: 'yes', models: 'yes' },

    deriveEndpoints(input = {}) {
        return deriveAnthropicEndpoints(input);
    },

    buildHeaders({ apiKey, authMode, stream }) {
        const mode = authMode || this.defaultAuthMode;
        const auth = mode === 'bearer'
            ? buildAuthHeaders(this, { apiKey, authMode: 'bearer' })
            : buildAuthHeaders(this, { apiKey, authMode: mode });
        return {
            'Content-Type': 'application/json',
            Accept: stream ? 'text/event-stream' : 'application/json',
            'anthropic-version': ANTHROPIC_VERSION,
            'anthropic-dangerous-direct-browser-access': 'true',
            ...auth
        };
    },

    buildRequest({ provider, apiKey, model, messages, temperature = 0.5, maxTokens, responseFormat, stream, thinking = 'auto' }) {
        const converted = toAnthropicMessages(messages);
        let system = converted.system;
        if (responseFormat) {
            const instruction = 'Return only one valid JSON object. Do not wrap it in Markdown fences.';
            system = system ? `${system}\n\n${instruction}` : instruction;
        }
        const requestedMaxTokens = typeof maxTokens === 'number' && maxTokens > 0 ? maxTokens : 1024;
        const body = {
            model,
            max_tokens: requestedMaxTokens,
            temperature,
            messages: converted.messages
        };
        // Extended thinking requires temperature 1 and enough room for both the
        // thinking budget and the actual answer.
        if (Object.prototype.hasOwnProperty.call(THINKING_BUDGETS, thinking)) {
            const budget = THINKING_BUDGETS[thinking];
            body.thinking = { type: 'enabled', budget_tokens: budget };
            body.temperature = 1;
            body.max_tokens = Math.max(requestedMaxTokens, budget + 1024);
        }
        if (system) body.system = system;
        if (stream) body.stream = true;
        return {
            url: provider.apiUrl,
            headers: this.buildHeaders({ apiKey, authMode: provider.authMode, stream }),
            body,
            // The actual outbound budget after the thinking lift. Callers use
            // this for truncation retries instead of guessing from maxTokens.
            maxTokens: body.max_tokens
        };
    },

    parseResponse(json) {
        if (json?.type === 'error') {
            throw makeError('provider_request_failed', json?.error?.message || 'provider error', { status: 400 });
        }
        const blocks = Array.isArray(json?.content) ? json.content : [];
        const text = blocks.filter((block) => block.type === 'text').map((block) => block.text || '').join('').trim();
        const reasoning = blocks.filter((block) => block.type === 'thinking').map((block) => block.thinking || '').join('').trim();
        return {
            text,
            reasoning,
            finishReason: json?.stop_reason || '',
            usage: json?.usage || null,
            model: json?.model || '',
            refusal: json?.stop_reason === 'refusal' ? text : ''
        };
    },

    parseStreamEvent({ data }) {
        if (!data) return { done: false };
        let json;
        try { json = JSON.parse(data); } catch (_) { return { done: false }; }
        if (json.type === 'content_block_delta') {
            const delta = json.delta || {};
            // 擴展思考的片段走 reasoning，一般文字才算正文。
            if (delta.type === 'thinking_delta') return { text: '', reasoning: delta.thinking || '', done: false };
            return { text: delta.text || '', reasoning: '', done: false };
        }
        if (json.type === 'message_delta') {
            return { finishReason: json.delta?.stop_reason || '', done: false };
        }
        if (json.type === 'message_stop') return { done: true };
        if (json.type === 'error') {
            return { done: true, errorCode: 'provider_request_failed', errorMessage: json?.error?.message || '' };
        }
        return { done: false };
    },

    parseModels(payload) {
        const items = Array.isArray(payload?.data) ? payload.data : [];
        return items.map((item) => ({
            id: String(item?.id || '').trim(),
            label: String(item?.display_name || item?.id || '').trim()
        })).filter((item) => item.id);
    },

    modelsRequest({ provider, apiKey }) {
        return {
            url: provider.modelsUrl,
            headers: {
                Accept: 'application/json',
                'anthropic-version': ANTHROPIC_VERSION,
                'anthropic-dangerous-direct-browser-access': 'true',
                ...buildAuthHeaders(this, {
                    apiKey,
                    authMode: provider.authMode === 'bearer' ? 'bearer' : provider.authMode
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
