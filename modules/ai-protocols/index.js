// Protocol registry, URL detection and model discovery.
//
// Only implemented adapters participate in detection. Detection never sends a
// key to another origin, never follows redirects with a key, and never issues a
// paid generation request behind the user's back.

import { chatCompletions } from './chat-completions.js';
import { anthropicMessages } from './anthropic.js';
import { geminiNative } from './gemini.js';
import {
    classifyNetworkError,
    makeError,
    parseDataUrl,
    statusToCode
} from './common.js';
import { t } from '../i18n.js';

export const PROTOCOL_ADAPTERS = [chatCompletions, anthropicMessages, geminiNative];
export const SUPPORTED_FORMATS = PROTOCOL_ADAPTERS.map((adapter) => adapter.id);
export const DETECTION_LIMITS = { maxCandidates: 3, perProbeMs: 5000, totalMs: 15000 };

const KNOWN_CHAT_HOSTS = new Set([
    'api.openai.com',
    'api.deepseek.com',
    'api.groq.com',
    'api.mistral.ai',
    'api.together.xyz',
    'api.x.ai',
    'openrouter.ai',
    'dashscope.aliyuncs.com',
    'api.moonshot.cn',
    'api.siliconflow.cn',
    'api.minimax.chat'
]);

export function getAdapter(format) {
    const id = String(format || '').trim();
    return PROTOCOL_ADAPTERS.find((adapter) => adapter.id === id) || null;
}

export function requireAdapter(format) {
    const adapter = getAdapter(format);
    if (!adapter) throw makeError('unsupported_format', `unsupported provider format: ${format}`);
    return adapter;
}

export function adapterCapabilities(format) {
    const adapter = getAdapter(format);
    return adapter ? { ...adapter.capabilities } : {};
}

export function isAuthModeAllowed(format, authMode) {
    const adapter = getAdapter(format);
    if (!adapter) return false;
    return adapter.authModes.includes(authMode);
}

export function defaultAuthMode(format) {
    const adapter = getAdapter(format);
    return adapter ? adapter.defaultAuthMode : 'bearer';
}

/** Derive the concrete request/model URLs for a provider definition. */
export function deriveProviderEndpoints({ format, baseUrl, apiUrl, modelsUrl } = {}) {
    const adapter = getAdapter(format);
    if (!adapter) throw makeError('unsupported_format', 'unsupported provider format');
    return adapter.deriveEndpoints({
        baseUrl: String(baseUrl || ''),
        apiUrl: String(apiUrl || ''),
        modelsUrl: String(modelsUrl || '')
    });
}

export function buildProviderDefinition({ format, baseUrl, apiUrl, modelsUrl, authMode, apiKey } = {}) {
    const endpoints = deriveProviderEndpoints({ format, baseUrl, apiUrl, modelsUrl });
    const mode = authMode || (apiKey ? defaultAuthMode(format) : 'none');
    if (!isAuthModeAllowed(format, mode)) throw makeError('unsupported_auth_mode', 'unsupported auth mode');
    return {
        format,
        baseUrl: endpoints.baseUrl,
        apiUrl: endpoints.apiUrl,
        modelsUrl: endpoints.modelsUrl,
        authMode: mode
    };
}

function candidateFor(format, url) {
    const adapter = requireAdapter(format);
    const endpoints = adapter.deriveEndpoints({ baseUrl: url });
    return { format, ...endpoints, authMode: adapter.defaultAuthMode };
}

function looksLikeGenerationEndpoint(pathname) {
    return /:generateContent|:streamGenerateContent/i.test(pathname);
}

/**
 * Build at most three ordered candidates for a user-supplied service URL.
 * Uses exact hostname rules and endpoint-shape rules (never substring checks).
 */
export function buildDetectionCandidates(input, { format } = {}) {
    const raw = String(input || '').trim();
    if (!raw) throw makeError('url_required', 'service URL required');
    let url;
    try { url = new URL(raw); } catch (_) { throw makeError('url_invalid', 'invalid URL'); }
    if (!/^https?:$/.test(url.protocol)) throw makeError('url_scheme_not_allowed', 'only http/https');
    if (url.username || url.password) throw makeError('url_has_credentials', 'URL must not contain credentials');
    url.hash = '';
    for (const key of Array.from(url.searchParams.keys())) {
        if (/key|token|secret|auth|pass|sig/i.test(key)) {
            throw makeError('url_has_credentials', 'URL must not contain credential query parameters');
        }
    }
    const normalized = url.toString();
    const pathname = url.pathname || '/';
    const host = url.hostname.toLowerCase();

    if (format) {
        const adapter = requireAdapter(format);
        const endpoints = adapter.deriveEndpoints({ baseUrl: normalized });
        return [{ format: adapter.id, ...endpoints, authMode: adapter.defaultAuthMode }];
    }

    const ordered = [];
    const push = (id) => {
        if (!ordered.includes(id) && getAdapter(id)) ordered.push(id);
    };

    if (/\/chat\/completions\/?$/i.test(pathname)) push('openai-chat');
    else if (/\/messages\/?$/i.test(pathname)) push('anthropic-messages');
    else if (looksLikeGenerationEndpoint(pathname) || (/\/models\/[^/]+$/i.test(pathname) && host === 'generativelanguage.googleapis.com')) push('gemini');

    if (host === 'api.anthropic.com') push('anthropic-messages');
    if (host === 'generativelanguage.googleapis.com') push('gemini');
    if (KNOWN_CHAT_HOSTS.has(host)) push('openai-chat');
    const isKnownHost = host === 'api.anthropic.com'
        || host === 'generativelanguage.googleapis.com'
        || KNOWN_CHAT_HOSTS.has(host);
    if (!isKnownHost && ordered.length === 0) {
        // Unknown hosts without an endpoint-shape cue: prefer the already-working
        // compatible format, then the other implemented adapters. The order only
        // affects model discovery; the user can override the protocol in advanced
        // settings. An explicit endpoint (e.g. /chat/completions) is never mixed
        // with other protocols.
        push('openai-chat');
        if (url.pathname && /\/v\d+[a-z0-9-]*\//i.test(url.pathname)) {
            push('anthropic-messages');
            push('gemini');
        } else {
            push('gemini');
            push('anthropic-messages');
        }
    }

    const candidates = ordered.slice(0, DETECTION_LIMITS.maxCandidates)
        .map((id) => candidateFor(id, normalized))
        .filter((candidate) => {
            try {
                return new URL(candidate.modelsUrl).origin === url.origin;
            } catch (_) {
                return false;
            }
        });
    if (!candidates.length) throw makeError('url_invalid', 'no same-origin candidates');
    return candidates;
}

async function readJsonSafe(response) {
    try { return await response.json(); } catch (_) { return null; }
}

async function requestWithTimeout(url, options, { signal, timeoutMs } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => {
        try { controller.abort(new DOMException('Timeout', 'TimeoutError')); } catch (_) { controller.abort(); }
    }, timeoutMs);
    const onAbort = () => controller.abort(signal && signal.reason);
    if (signal) {
        if (signal.aborted) controller.abort(signal.reason);
        else signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal,
            redirect: 'error',
            cache: 'no-store'
        });
        return response;
    } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
    }
}

export async function fetchProviderModels({ provider, apiKey, signal, timeoutMs = DETECTION_LIMITS.perProbeMs, allowCrossOrigin = false }) {
    const adapter = requireAdapter(provider.format);
    const request = adapter.modelsRequest({ provider, apiKey });
    let requestUrl;
    let apiOrigin;
    try {
        requestUrl = new URL(request.url);
        apiOrigin = new URL(provider.apiUrl.replace(/%7Bmodel%7D/gi, 'x').replace('{model}', 'x')).origin;
    } catch (_) {
        return { ok: false, errorCode: 'url_invalid', models: [] };
    }
    if (!requestUrl.protocol.startsWith('http')) return { ok: false, errorCode: 'url_scheme_not_allowed', models: [] };
    if (!allowCrossOrigin && requestUrl.origin !== apiOrigin) {
        return { ok: false, errorCode: 'cross_origin_models_url', models: [] };
    }
    let response;
    try {
        response = await requestWithTimeout(request.url, {
            method: 'GET',
            headers: request.headers
        }, { signal, timeoutMs });
    } catch (error) {
        const classified = classifyNetworkError(error);
        return { ok: false, errorCode: classified.code, models: [] };
    }
    if (!response.ok) {
        const payload = await readJsonSafe(response);
        return {
            ok: false,
            errorCode: statusToCode(response.status),
            status: response.status,
            retryAfter: Number(response.headers.get('retry-after') || 0) || 0,
            models: []
        };
    }
    const payload = await readJsonSafe(response);
    if (!payload) return { ok: false, errorCode: 'models_bad_format', status: response.status, models: [] };
    const models = adapter.parseModels(payload);
    if (!models.length) return { ok: false, errorCode: 'models_empty', status: response.status, models: [] };
    return {
        ok: true,
        models: models.map((item) => ({ id: item.id, label: item.label || item.id })),
        status: response.status
    };
}

/**
 * Probe the model-list endpoint of up to three candidates. A successful list
 * only proves model discovery works, not generation/vision/JSON/streaming.
 */
export async function detectProvider({ url, apiKey = '', format = '', signal } = {}) {
    const key = String(apiKey || '').trim();
    const candidates = buildDetectionCandidates(url, { format });
    const attempts = [];
    const deadline = Date.now() + DETECTION_LIMITS.totalMs;
    let sawAuthError = false;
    let lastError = '';

    for (const candidate of candidates) {
        if (signal && signal.aborted) return { ok: false, errorCode: 'request_aborted', attempts, candidates };
        const remaining = deadline - Date.now();
        if (remaining <= 250) break;
        const authMode = key ? candidate.authMode : 'none';
        const provider = { ...candidate, authMode, apiUrl: candidate.apiUrl, modelsUrl: candidate.modelsUrl };
        const result = await fetchProviderModels({
            provider,
            apiKey: key,
            signal,
            timeoutMs: Math.min(DETECTION_LIMITS.perProbeMs, remaining)
        });
        attempts.push({ format: candidate.format, status: result.status || 0, errorCode: result.errorCode || '' });
        if (result.ok) {
            return {
                ok: true,
                format: provider.format,
                provider: {
                    format: provider.format,
                    baseUrl: provider.baseUrl,
                    apiUrl: provider.apiUrl,
                    modelsUrl: provider.modelsUrl,
                    authMode: provider.authMode
                },
                models: result.models,
                attempts,
                ambiguous: candidates.length > 1,
                errorCode: ''
            };
        }
        lastError = result.errorCode;
        if (result.errorCode === 'network_or_cors' || result.errorCode === 'request_timeout') break;
        if (result.errorCode === 'provider_rate_limited' || result.errorCode === 'provider_server_error') break;
        if (result.errorCode === 'provider_auth_failed' || result.errorCode === 'provider_forbidden') {
            sawAuthError = true;
            continue;
        }
        // 404/405 and empty lists: try the next protocol candidate.
    }

    const errorCode = sawAuthError && !lastError.startsWith('provider_server') ? 'provider_auth_failed' : (lastError || 'provider_unreachable');
    return { ok: false, errorCode, attempts, candidates };
}

/** One explicit generation request used by the "test model" button. */
export async function testProviderModel({ provider, apiKey, model, signal, timeoutMs = 20000 }) {
    const adapter = requireAdapter(provider.format);
    const request = adapter.buildTestRequest({ provider, apiKey, model });
    let response;
    try {
        response = await requestWithTimeout(request.url, {
            method: 'POST',
            headers: request.headers,
            body: JSON.stringify(request.body)
        }, { signal, timeoutMs });
    } catch (error) {
        return { ok: false, errorCode: classifyNetworkError(error).code, text: '' };
    }
    if (!response.ok) {
        const payload = await readJsonSafe(response);
        return {
            ok: false,
            errorCode: statusToCode(response.status),
            status: response.status,
            text: '',
            detail: payload?.error?.message || payload?.message || ''
        };
    }
    const payload = await readJsonSafe(response);
    const parsed = payload ? adapter.parseResponse(payload) : { text: '' };
    return {
        ok: true,
        text: parsed.text || '',
        finishReason: parsed.finishReason || '',
        refusal: parsed.refusal || ''
    };
}

export function describeDetectionError(code) {
    const map = {
        url_required: t('settings.aiUrlRequired'),
        url_invalid: t('settings.aiUrlInvalid'),
        url_scheme_not_allowed: t('settings.aiUrlScheme'),
        url_has_credentials: t('settings.aiUrlHasCredentials'),
        provider_auth_failed: t('settings.aiConnectAuthFailed'),
        provider_forbidden: t('settings.aiConnectForbidden'),
        provider_rate_limited: t('settings.aiConnectRateLimited'),
        provider_server_error: t('settings.aiConnectServerError'),
        network_or_cors: t('settings.aiConnectNetwork'),
        request_timeout: t('settings.aiConnectTimeout'),
        request_aborted: t('settings.aiConnectCancelled'),
        models_empty: t('settings.aiConnectNoModels'),
        model_not_selected: t('settings.aiModelNotSelected'),
        cross_origin_models_url: t('settings.aiModelsCrossOrigin'),
        unsupported_format: t('settings.aiFormatUnsupported'),
        unsupported_auth_mode: t('settings.aiAuthUnsupported')
    };
    return map[code] || t('settings.aiConnectFailed');
}

export { parseDataUrl };
