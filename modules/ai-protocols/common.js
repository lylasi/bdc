// Shared helpers for AI protocol adapters.
//
// Canonical message shape used by every adapter:
//   { role: 'system'|'user'|'assistant',
//     content: string | [{ type: 'text', text } | { type: 'image', imageUrl }] }
//
// Adapters convert this to their wire format and normalise responses back to
// { text, finishReason, usage }.

export function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function firstNonEmptyString(...values) {
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
}

export function normalizeContentParts(content) {
    if (typeof content === 'string') {
        return content ? [{ type: 'text', text: content }] : [];
    }
    if (!Array.isArray(content)) return [];
    const parts = [];
    for (const item of content) {
        if (typeof item === 'string') {
            if (item) parts.push({ type: 'text', text: item });
            continue;
        }
        if (!isPlainObject(item)) continue;
        if (item.type === 'text' && typeof item.text === 'string') {
            parts.push({ type: 'text', text: item.text });
        } else if (item.type === 'image') {
            const imageUrl = firstNonEmptyString(item.imageUrl, item.url);
            if (imageUrl) parts.push({ type: 'image', imageUrl });
        } else if (item.type === 'image_url') {
            const imageUrl = firstNonEmptyString(item.image_url?.url, item.imageUrl);
            if (imageUrl) parts.push({ type: 'image', imageUrl });
        }
    }
    return parts;
}

export function normalizeMessages(messages) {
    if (!Array.isArray(messages)) return [];
    return messages.map((message) => {
        const role = message?.role === 'assistant' ? 'assistant' : (message?.role === 'system' ? 'system' : 'user');
        return { role, parts: normalizeContentParts(message?.content) };
    }).filter((message) => message.parts.length > 0);
}

/** data:image/png;base64,xxxx -> { mimeType, data } (throws on non-inline URLs). */
export function parseDataUrl(url) {
    const raw = String(url || '');
    const match = raw.match(/^data:([^;,]+);base64,(.+)$/i);
    if (!match) {
        const err = new Error('image must be an inline base64 data URL');
        err.code = 'image_not_inline';
        throw err;
    }
    return { mimeType: match[1], data: match[2] };
}

export function joinTextParts(value) {
    if (typeof value === 'string') return value;
    if (!Array.isArray(value)) return '';
    return value.map((item) => {
        if (typeof item === 'string') return item;
        if (isPlainObject(item) && typeof item.text === 'string') return item.text;
        return '';
    }).join('');
}

export function trimTrailingSlash(value) {
    return String(value || '').trim().replace(/\/+$/, '');
}

export function hasVersionSuffix(pathname) {
    return /\/v\d+[a-z0-9-]*$/i.test(String(pathname || ''));
}

/** OpenAI-compatible chat endpoints derived from a base URL. */
export function deriveChatEndpoints({ baseUrl = '', apiUrl = '', modelsUrl = '' } = {}) {
    const explicitApi = firstNonEmptyString(apiUrl);
    const explicitModels = firstNonEmptyString(modelsUrl);
    const base = trimTrailingSlash(baseUrl);
    if (explicitApi) {
        const api = explicitApi.replace(/\/+$/, '');
        const stripped = api.replace(/\/chat\/completions$/i, '');
        return {
            baseUrl: base || stripped,
            apiUrl: api,
            modelsUrl: explicitModels || (stripped ? `${stripped}/models` : '')
        };
    }
    if (!base) return { baseUrl: '', apiUrl: '', modelsUrl: explicitModels };
    if (/\/chat\/completions$/i.test(base)) {
        const stem = base.replace(/\/chat\/completions$/i, '');
        return { baseUrl: stem, apiUrl: base, modelsUrl: explicitModels || `${stem}/models` };
    }
    let stem = base;
    if (!hasVersionSuffix(new URL(base, 'https://placeholder.invalid').pathname)) stem = `${base}/v1`;
    return {
        baseUrl: base,
        apiUrl: `${stem}/chat/completions`,
        modelsUrl: explicitModels || `${stem}/models`
    };
}

/** Allowed auth header modes per adapter; the key itself is never logged. */
export function buildAuthHeaders(adapter, { apiKey = '', authMode = '' } = {}) {
    const mode = authMode || adapter.defaultAuthMode;
    if (mode === 'none') return {};
    const key = String(apiKey || '').trim();
    if (!key) {
        const err = new Error('missing api key');
        err.code = 'api_key_missing';
        throw err;
    }
    if (mode === 'bearer') return { Authorization: `Bearer ${key}` };
    if (mode === 'x-api-key') return { 'x-api-key': key };
    if (mode === 'google') return { 'x-goog-api-key': key };
    const err = new Error('unsupported auth mode');
    err.code = 'unsupported_auth_mode';
    throw err;
}

/** Incremental SSE parser: push decoded text, receive complete events. */
export function createSseParser() {
    let buffer = '';
    return {
        push(text) {
            buffer += String(text || '');
            const events = [];
            let index;
            while ((index = buffer.search(/\r?\n\r?\n/)) !== -1) {
                const chunk = buffer.slice(0, index);
                buffer = buffer.slice(index + (buffer[index] === '\r' ? 4 : 2));
                if (!chunk.trim()) continue;
                let event = '';
                const dataLines = [];
                for (const line of chunk.split(/\r?\n/)) {
                    const match = line.match(/^([a-zA-Z]+):\s?(.*)$/);
                    if (!match) continue;
                    if (match[1] === 'event') event = match[2].trim();
                    else if (match[1] === 'data') dataLines.push(match[2]);
                }
                if (dataLines.length) events.push({ event, data: dataLines.join('\n') });
            }
            return events;
        },
        flush() {
            const rest = buffer.trim();
            buffer = '';
            if (!rest) return [];
            const dataLines = [];
            for (const line of rest.split(/\r?\n/)) {
                const match = line.match(/^data:\s?(.*)$/);
                if (match) dataLines.push(match[1]);
            }
            return dataLines.length ? [{ event: '', data: dataLines.join('\n') }] : [];
        }
    };
}

export function classifyNetworkError(error) {
    if (!error) return { code: 'network_error', retryable: true };
    if (error.name === 'AbortError') {
        return { code: error.code === 'timeout' || error.name === 'TimeoutError' ? 'request_timeout' : 'request_aborted', retryable: false };
    }
    if (error.name === 'TimeoutError') return { code: 'request_timeout', retryable: false };
    if (error instanceof TypeError) return { code: 'network_or_cors', retryable: false };
    return { code: error.code || 'network_error', retryable: false };
}

export function statusToCode(status) {
    if (status === 400 || status === 422) return 'provider_bad_request';
    if (status === 401) return 'provider_auth_failed';
    if (status === 403) return 'provider_forbidden';
    if (status === 404) return 'provider_not_found';
    if (status === 405) return 'provider_method_not_allowed';
    if (status === 408) return 'provider_timeout';
    if (status === 413) return 'provider_payload_too_large';
    if (status === 429) return 'provider_rate_limited';
    if (status >= 500) return 'provider_server_error';
    return 'provider_request_failed';
}

export function makeError(code, message, extra = {}) {
    const err = new Error(message || code);
    err.code = code;
    Object.assign(err, extra);
    return err;
}
