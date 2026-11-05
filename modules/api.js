import { AI_LIMITS, OCR_CONFIG, ARTICLE_IMPORT } from '../ai-config.js';
import { loadGlobalSettings, loadGlobalSecrets } from './settings.js';
import { getLocale, t } from './i18n.js';
import { normalizeLocale } from './i18n-config.js';
import { getActiveAIScope } from './ai-profile-storage.js';
import { buildMessages, buildPrompt, getPromptVersion } from './prompts/index.js';
import {
    getAIProviderRegistry,
    getProviderConnection,
    getPreferredTaskSpec,
    hasModelSpec,
    normalizeModelSpec,
    normalizeTaskName,
    resolveAIRequestConfig,
    resolveAIRequestConfigAsync,
    resolveAITaskSpec,
    resolveThinkingLevel,
    firstNonEmptyString
} from './ai-models.js';
import { requireAdapter } from './ai-protocols/index.js';
import { createSseParser } from './ai-protocols/common.js';
import { THINKING_TOKEN_FLOORS } from './ai-thinking.js';
import { getCatalogState, isManagedUsable } from './ai-catalog.js';
import { AUTH_EVENT } from './sync-cloudflare.js';
import * as cache from './cache.js';
import * as validate from './validate.js';
import { IPA_NOTATION_RULE, phonemeSymbols } from './phonetics-data.js';

export {
    getAIProviderRegistry,
    getPreferredTaskSpec,
    hasModelSpec,
    normalizeModelSpec,
    normalizeTaskName,
    resolveAIRequestConfig,
    resolveAIRequestConfigAsync,
    resolveAITaskSpec
};

// =================================
// AI API 服務
// =================================

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
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
    const timer = setTimeout(() => ac.abort(new DOMException('Timeout', 'TimeoutError')), timeoutMs);
    let resp;
    try {
        resp = await fetch(url, {
            signal: signal || ac.signal,
            headers: { 'Accept': 'application/json', ...(headers || {}) }
        });
    } catch (e) {
        // 逾時原本只會丟出 AbortError，訊息是 "Timeout" 或完全空白，使用者看不出發生什麼事
        if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
            const err = new Error(`Timeout（${Math.round(timeoutMs / 1000)}s）`);
            err.code = 'timeout';
            throw err;
        }
        throw e;
    } finally {
        clearTimeout(timer);
    }
    if (!resp.ok) {
        let payload = null;
        try { payload = await resp.json(); } catch (_) {}
        // 服務端通常會在 error/message/details 說明原因（例如「Host x is not allowed」）；
        // 只顯示 HTTP 403 會讓使用者完全查不出問題出在哪裡
        const detail = payload && (payload.error || payload.message || payload.detail || payload.details);
        const err = new Error(typeof detail === 'string' && detail.trim() ? `HTTP ${resp.status}：${detail.trim()}` : `HTTP ${resp.status}`);
        err.status = resp.status;
        err.payload = payload;
        throw err;
    }
    return resp.json();
}

/**
 * 回報非致命問題（例如模型輸出被截斷）。
 * 只傳機器可讀的代碼，實際文案由呼叫端用 t() 決定，避免在這裡硬編中文。
 */
function notifyNotice(opts, code) {
    if (!code) return;
    try { console.warn('[article-import]', code); } catch (_) {}
    try { if (typeof opts?.onNotice === 'function') opts.onNotice(code); } catch (_) {}
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

// 純文字後備路徑用：把回應當「純文字答案」，若內容其實是（截斷的）JSON 殘骸則視為無效返回 ''。
function plainAnswerOrEmpty(raw) {
    const t = stripCodeFences(raw).trim();
    if (!t) return '';
    // 後備請求預期得到純文字翻譯/釋義；若以 { 或 [ 開頭，多半是模型仍在輸出（被截斷的）JSON，不可當答案。
    if (t.startsWith('{') || t.startsWith('[')) return '';
    return t;
}

// 統一從回應抽取主要文字內容。
// 某些模型（GLM/Qwen/DeepSeek 等）在 content 為空時會把答案放到 reasoning_content/output_text；
// content 為陣列時（部分多模態端點）合併其文字片段。
function pickMessageContent(data) {
    const msg = data?.choices?.[0]?.message || {};
    const toText = (c) => {
        if (!c) return '';
        if (typeof c === 'string') return c;
        if (Array.isArray(c)) {
            try { return c.map(x => (typeof x === 'string' ? x : (x?.text || ''))).join('\n'); } catch (_) { return ''; }
        }
        return '';
    };
    const primary = toText(msg.content).trim();
    if (primary) return primary;
    return toText(msg.reasoning_content).trim()
        || toText(data?.choices?.[0]?.delta?.content).trim()
        || toText(data?.output_text).trim()
        || '';
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

// 按句翻譯模式：把模型回應規整為「與輸入句數等長的中文譯句陣列」；不符合則返回 null
function normalizeSentenceTranslations(parsed, count) {
    if (!parsed) return null;
    let arr = null;
    if (Array.isArray(parsed)) arr = parsed;
    else if (Array.isArray(parsed.sentences)) arr = parsed.sentences;
    else if (Array.isArray(parsed.translations)) arr = parsed.translations;
    if (!arr) return null;
    const zh = arr.map(item => {
        if (typeof item === 'string') return item.trim();
        if (item && typeof item === 'object') return firstNonEmptyString(item.zh, item.translation, item.chinese, typeof item.text === 'string' ? item.text : '').trim();
        return '';
    });
    if (zh.length !== count || zh.some(s => !s)) return null;
    return zh;
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

// Different providers may expose same-named models with different behaviour, so
// article caches must key on provider + model, not the model name alone.
function cacheModelKey(resolved) {
    return `${resolved?.provider || 'default'}:${resolved?.model || ''}`;
}


/**
 * Legacy config objects (OCR_CONFIG / QA_CHECK / ARTICLE_IMPORT) may still name
 * an explicit provider, but they can no longer carry endpoint or key overrides.
 * All connection data comes from the account profile / managed catalog.
 */
export function resolveConfigConnection(config = {}) {
    const cfg = isPlainObject(config) ? config : {};
    const explicitProvider = firstNonEmptyString(cfg.PROVIDER, cfg.provider, cfg.profile);
    return {
        apiUrl: undefined,
        apiKey: undefined,
        provider: explicitProvider || undefined,
        profile: explicitProvider || undefined
    };
}

const activeControllers = new Set();

function registerController(controller, source = '') {
    const entry = { controller, source, aborted: false };
    activeControllers.add(entry);
    return () => activeControllers.delete(entry);
}

function abortAIRequests({ managedOnly = false } = {}) {
    for (const entry of Array.from(activeControllers)) {
        if (managedOnly && entry.source !== 'managed') continue;
        try { entry.controller.abort(); } catch (_) {}
        entry.aborted = true;
        activeControllers.delete(entry);
    }
}

if (typeof window !== 'undefined') {
    window.addEventListener(AUTH_EVENT, (event) => {
        const detail = event && event.detail ? event.detail : {};
        if (detail.event === 'SIGNED_OUT' || detail.event === 'ACCOUNT_CHANGED') {
            abortAIRequests();
            resetThinkingFallbackMemory();
        }
        if (detail.event === 'SESSION_INVALID') {
            abortAIRequests({ managedOnly: true });
            resetThinkingFallbackMemory();
        }
    });
    window.addEventListener('bdc:ai-catalog-change', () => {
        resetThinkingFallbackMemory();
        try {
            if (!isManagedUsable()) abortAIRequests({ managedOnly: true });
        } catch (_) {}
    });
}

export function getAIErrorTranslationKey(code) {
    const map = {
        invalid_response: 'errors.aiInvalidResponse',
        empty_response: 'errors.aiInvalidResponse',
        stale_session: 'extension.staleLookupDiscarded',
        lookup_text_required: 'errors.lookupTextRequired',
        sync_endpoint_missing: 'errors.syncEndpointMissing',
        snapshot_read_failed: 'errors.cloudReadFailed',
        username_required: 'errors.usernameRequired',
        password_required: 'errors.passwordRequired',
        invalid_credentials: 'errors.invalidCredentials',
        account_disabled: 'errors.accountDisabled',
        rate_limited: 'errors.loginRateLimited',
        pairing_required: 'errors.pairingRequired',
        pairing_format: 'errors.pairingFormat',
        pairing_invalid: 'errors.pairingInvalid',
        sync_unreachable: 'errors.cannotReachSync',
        sync_timeout: 'errors.aiTimeout',
        unauthorized: 'errors.loginExpired',
        ai_key_missing: 'errors.aiKeyMissing',
        ai_key_binding_mismatch: 'errors.aiKeyBindingMismatch',
        binding_mismatch: 'errors.aiKeyBindingMismatch',
        cloud_key_missing: 'errors.aiKeyMissing',
        managed_login_required: 'errors.aiLoginRequired',
        managed_session_expired: 'errors.aiSessionExpired',
        managed_credential_missing: 'errors.aiCredentialMissing',
        managed_provider_unavailable: 'errors.aiProviderUnavailable',
        provider_missing: 'errors.aiProviderUnavailable',
        provider_disabled: 'errors.aiProviderUnavailable',
        provider_endpoint_missing: 'errors.aiProviderEndpointMissing',
        model_not_selected: 'errors.aiModelNotSelected',
        model_not_allowed: 'errors.aiModelNotAllowed',
        model_not_capable: 'errors.aiModelNotCapable',
        model_provider_missing: 'errors.aiModelProviderMissing',
        model_refusal: 'errors.aiRefusal',
        task_override_rejected: 'errors.aiOverrideRejected',
        unsupported_format: 'errors.aiUnsupportedFormat',
        unsupported_auth_mode: 'errors.aiUnsupportedAuthMode',
        network_or_cors: 'errors.aiNetworkBlocked',
        request_timeout: 'errors.aiTimeout',
        provider_auth_failed: 'errors.aiProviderAuthFailed',
        provider_forbidden: 'errors.aiProviderForbidden',
        provider_rate_limited: 'errors.aiProviderRateLimited',
        provider_server_error: 'errors.aiProviderServerError',
        image_not_inline: 'errors.aiImageInlineOnly',
        catalog_version_conflict: 'errors.aiCatalogChanged',
        passcode_upgrade_required: 'errors.aiPasscodeUpgrade'
    };
    return map[code] || '';
}

function localizeAIError(error) {
    if (!error) return error;
    // fetch 失敗（離線、CORS、DNS）不會帶 code：補上分類，讓重試與失敗原因可判讀。
    if (!error.code && (error instanceof TypeError || /failed to fetch|networkerror/i.test(String(error.message || '')))) {
        error.code = 'network_or_cors';
    }
    const key = getAIErrorTranslationKey(error.code);
    if (key) {
        const translated = t(key);
        if (translated && translated !== key) error.message = translated;
    }
    return error;
}

async function readErrorPayload(response) {
    try { return await response.json(); } catch (_) { return null; }
}

function providerHttpError(status, payload) {
    const detail = payload?.error?.message
        || (typeof payload?.error === 'string' ? payload.error : '')
        || payload?.message
        || '';
    const err = new Error(detail ? `HTTP ${status}: ${String(detail).slice(0, 200)}` : `HTTP ${status}`);
    err.status = status;
    err.payload = payload;
    err.code = status === 401 ? 'provider_auth_failed'
        : status === 403 ? 'provider_forbidden'
            : status === 429 ? 'provider_rate_limited'
                : status >= 500 ? 'provider_server_error'
                    : 'provider_request_failed';
    return err;
}

function isThinkingParameterError(error) {
    const status = Number(error?.status) || 0;
    if (status !== 400 && status !== 422) return false;
    const payload = error?.payload || {};
    // OpenAI-compatible gateways may return `detail`, `errors` or `error` as an
    // object/array. Joining those directly yields "[object Object]" and hides
    // the parameter name, so serialise nested values before matching.
    const stringifyPart = (value) => {
        if (value == null) return '';
        if (typeof value === 'string') return value;
        if (typeof value === 'number' || typeof value === 'boolean') return String(value);
        try { return JSON.stringify(value); } catch (_) { return ''; }
    };
    const text = [
        error?.message,
        payload?.error?.message,
        payload?.error?.type,
        payload?.error?.code,
        payload?.error,
        payload?.message,
        payload?.detail,
        payload?.errors
    ].map(stringifyPart).filter(Boolean).join(' ');
    // Anthropic may also reject the lifted max_tokens that comes with
    // extended thinking on older models ("max_tokens ... exceeds"). Both
    // token fields are included so that error also triggers the one retry.
    return /reasoning|thinking|effort|budget_tokens|max_tokens|max_completion_tokens|thought/i.test(text);
}

/** OpenAI uses `length`, Anthropic `max_tokens` and Gemini `MAX_TOKENS`.
 * Normalising them keeps the one-shot truncation retry working for all three. */
export function isLengthFinishReason(reason) {
    const value = String(reason || '').trim().toLowerCase();
    return value === 'length' || value === 'max_tokens';
}

function applyThinkingTokenFloor(maxTokens, level) {
    if (typeof maxTokens !== 'number' || maxTokens <= 0) return maxTokens;
    const floor = Number(THINKING_TOKEN_FLOORS[level]) || 0;
    return floor > maxTokens ? floor : maxTokens;
}

// Session memory of targets that rejected a thinking parameter. Support is a
// property of the endpoint and of the level actually sent, so the key includes
// provider + wire format + endpoint URL + model + level. Without the level a
// refusal of `none` would also silence `high` on the same model.
const thinkingUnsupportedTargets = new Set();
// Separate from the rejection memory: an event is only announced after a retry
// (or a remembered fallback) actually succeeded.
const thinkingFallbackNotified = new Set();
// Incremented whenever the capability memory is invalidated. A request captures
// the value when it starts; a response from an older generation may still finish
// (and retry once for itself), but it must not write into the new memory.
let thinkingFallbackGeneration = 0;

function thinkingTargetKey({ provider, model, format, apiUrl, level } = {}) {
    return [
        provider || 'default',
        format || '',
        apiUrl || '',
        model || '',
        level || ''
    ].join('|');
}

function isThinkingUnsupportedFor(resolved, level) {
    if (!level || level === 'auto') return false;
    return thinkingUnsupportedTargets.has(thinkingTargetKey({ ...resolved, level }));
}

/** Returns true only the first time this target + level is marked. */
function markThinkingUnsupported(resolved, level) {
    const key = thinkingTargetKey({ ...resolved, level });
    if (thinkingUnsupportedTargets.has(key)) return false;
    thinkingUnsupportedTargets.add(key);
    return true;
}

/** Returns true only when this target + level has not been announced yet. */
function markThinkingFallbackNotified(resolved, level) {
    const key = thinkingTargetKey({ ...resolved, level });
    if (thinkingFallbackNotified.has(key)) return false;
    thinkingFallbackNotified.add(key);
    return true;
}

/** The account/catalog changed: keys and endpoints may now point at a
 * different backend, so every remembered capability result is stale. Also
 * exported so tests can isolate module-level memory between cases. */
export function resetThinkingFallbackMemory() {
    thinkingFallbackGeneration += 1;
    thinkingUnsupportedTargets.clear();
    thinkingFallbackNotified.clear();
}

// Some levels (notably Anthropic `none`) are expressed by omitting the field.
// Only mark a target unsupported when this attempt actually sent a thinking
// parameter, otherwise an unrelated 400 would disable thinking forever.
function requestCarriesThinkingParameter(request) {
    const body = request?.body;
    if (!body || typeof body !== 'object') return false;
    if (Object.prototype.hasOwnProperty.call(body, 'reasoning_effort')) return true;
    if (Object.prototype.hasOwnProperty.call(body, 'thinking')) return true;
    const generationConfig = body.generationConfig;
    return !!generationConfig && typeof generationConfig === 'object'
        && Object.prototype.hasOwnProperty.call(generationConfig, 'thinkingConfig');
}

/** Observability hook: the provider rejected the thinking parameter and the
 * request succeeded after retrying without it. UI may listen to the event to
 * explain the fallback; callers do not need to handle it to keep working. */
function notifyThinkingFallback({ task, level, provider, model }) {
    const detail = {
        task: normalizeTaskName(task),
        level,
        provider: provider || '',
        model: model || ''
    };
    try { console.warn('[ai-thinking] thinking parameter rejected; retried without it', detail); } catch (_) {}
    try {
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function'
            && typeof CustomEvent === 'function') {
            window.dispatchEvent(new CustomEvent('bdc:ai-thinking-fallback', { detail }));
        }
    } catch (_) {}
}

/**
 * Unified AI request entry point. Resolves the account profile / managed
 * catalog, asks the protocol adapter to build the request, and normalises the
 * response to the shape expected by existing callers.
 */
export async function requestAI({ model, messages, temperature = 0.5, maxTokens, timeoutMs = 30000, signal, responseFormat, apiUrl, apiKey, taskType = 'default', provider, profile, thinking }) {
    const memoryGeneration = thinkingFallbackGeneration;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new DOMException('Timeout', 'AbortError')), timeoutMs);
    const onAbort = () => ac.abort(signal && signal.reason);
    if (signal) {
        if (signal.aborted) ac.abort(signal.reason);
        else signal.addEventListener('abort', onAbort, { once: true });
    }

    // reasoning models count their thinking against max_tokens; retry once with
    // a doubled budget when the provider reports a length stop.
    const thinkingResolution = resolveThinkingLevel(taskType, { override: thinking });
    const requestedThinkingLevel = thinkingResolution.level;
    const baseMaxTokens = (typeof maxTokens === 'number') ? maxTokens : undefined;
    let effectiveThinking = requestedThinkingLevel;
    let effectiveMaxTokens = applyThinkingTokenFloor(baseMaxTokens, effectiveThinking);
    let thinkingFallbackTried = false;
    let thinkingFallbackNoticeLevel = '';
    let resolvedForFallback = null;
    // A thinking fallback retry must keep the target resolved for the rejected
    // attempt. Re-resolving could send the retry (and record the fallback) on a
    // different endpoint if the user edited the profile meanwhile.
    let pinnedResolved = null;
    let lastRequestMaxTokens = 0;
    let requestCarriedThinking = false;
    let unregister = () => {};

    const fetchOnce = async () => {
        let resolved = pinnedResolved;
        if (!resolved) {
            try {
                resolved = await resolveAIRequestConfigAsync({
                    task: taskType,
                    model,
                    apiUrl,
                    apiKey,
                    provider,
                    profile
                });
            } catch (error) {
                throw localizeAIError(error);
            }
            resolvedForFallback = resolved;
        }
        unregister();
        unregister = registerController(ac, resolved.source);
        // This target already rejected the thinking field once in this session.
        // Go straight to auto instead of sending another doomed request, but
        // remember the level so a success can still announce the downgrade.
        if (effectiveThinking !== 'auto' && isThinkingUnsupportedFor(resolvedForFallback, effectiveThinking)) {
            thinkingFallbackNoticeLevel = effectiveThinking;
            effectiveThinking = 'auto';
            effectiveMaxTokens = applyThinkingTokenFloor(baseMaxTokens, effectiveThinking);
        }
        const adapter = requireAdapter(resolved.format);
        const request = adapter.buildRequest({
            provider: resolved,
            apiKey: resolved.apiKey,
            model: resolved.model,
            messages,
            temperature,
            maxTokens: effectiveMaxTokens,
            responseFormat,
            stream: false,
            thinking: effectiveThinking
        });
        // Adapters may raise the budget on their own (Anthropic's thinking lift,
        // Gemini's budget + answer reserve). Remember what actually goes on the
        // wire so a truncation retry grows from that value instead of the
        // caller's smaller number.
        lastRequestMaxTokens = Number(request.maxTokens) || 0;
        const { maxConcurrency, minIntervalMs } = getLimitConfig(resolved.task);
        requestCarriedThinking = requestCarriesThinkingParameter(request);
        const queueKey = queueKeyForRequest({
            endpoint: resolved.apiUrl,
            profile: resolved.provider,
            model: resolved.model,
            taskType: resolved.task
        });
        return await enqueueAIRequest(queueKey, async () => {
            let resp;
            try {
                resp = await fetch(request.url, {
                    method: 'POST',
                    headers: request.headers,
                    body: JSON.stringify(request.body),
                    signal: ac.signal,
                    redirect: 'error',
                    cache: 'no-store'
                });
            } catch (error) {
                throw localizeAIError(error);
            }
            if (!resp.ok) {
                const payload = await readErrorPayload(resp);
                const err = providerHttpError(resp.status, payload);
                try {
                    const ra = resp.headers.get && resp.headers.get('retry-after');
                    if (ra) err.retryAfter = parseFloat(ra);
                } catch (_) {}
                throw localizeAIError(err);
            }
            const json = await resp.json();
            const parsed = adapter.parseResponse(json);
            if (parsed.refusal && !parsed.text) {
                const err = new Error('model refusal');
                err.code = 'model_refusal';
                err.finishReason = parsed.finishReason;
                throw localizeAIError(err);
            }
            return {
                ...parsed,
                text: parsed.text || '',
                choices: [{
                    message: { role: 'assistant', content: parsed.text || '' },
                    finish_reason: parsed.finishReason || ''
                }],
                usage: parsed.usage || null,
                providerId: resolved.provider,
                model: resolved.model,
                source: resolved.source,
                raw: json
            };
        }, { maxConcurrency, minIntervalMs });
    };

    const maxRetries = 2;
    let attempt = 0;
    let lastErr = null;
    let truncationRetried = false;
    try {
        while (attempt <= maxRetries) {
            try {
                const json = await fetchOnce();
                if (isLengthFinishReason(json.finishReason) && !truncationRetried) {
                    truncationRetried = true;
                    const actualMaxTokens = lastRequestMaxTokens;
                    if (effectiveThinking !== 'auto' && actualMaxTokens > 0) {
                        // Grow past the adapter-computed outbound budget. The old
                        // 4000 cap could not lift it at all once the thinking
                        // floor had already pushed the request above that value.
                        effectiveMaxTokens = Math.max(
                            actualMaxTokens * 2,
                            actualMaxTokens + 1024,
                            typeof effectiveMaxTokens === 'number' ? effectiveMaxTokens : 0
                        );
                        continue;
                    }
                    if (typeof effectiveMaxTokens === 'number') {
                        // auto mode keeps the previous capped doubling.
                        const thinkingFloor = Number(THINKING_TOKEN_FLOORS[effectiveThinking]) || 0;
                        const cap = Math.max(4000, thinkingFloor * 2, effectiveMaxTokens);
                        effectiveMaxTokens = Math.min(effectiveMaxTokens * 2, cap);
                        continue;
                    }
                }
                if (thinkingFallbackNoticeLevel) {
                    const level = thinkingFallbackNoticeLevel;
                    thinkingFallbackNoticeLevel = '';
                    if (memoryGeneration === thinkingFallbackGeneration
                        && markThinkingFallbackNotified(resolvedForFallback, level)) {
                        notifyThinkingFallback({
                            task: taskType,
                            level,
                            provider: resolvedForFallback.provider,
                            model: resolvedForFallback.model
                        });
                    }
                }
                return json;
            } catch (err) {
                lastErr = err;
                if (err?.name === 'AbortError') break;
                if (!thinkingFallbackTried && effectiveThinking !== 'auto' && requestCarriedThinking && isThinkingParameterError(err)) {
                    thinkingFallbackTried = true;
                    // A request that started before a catalog/auth reset must not
                    // repopulate the fresh capability memory.
                    if (memoryGeneration === thinkingFallbackGeneration) {
                        // Remember only the level that was actually rejected. The
                        // notice waits for a successful retry so a failed fallback
                        // does not announce an event that never helped.
                        markThinkingUnsupported(resolvedForFallback, effectiveThinking);
                        thinkingFallbackNoticeLevel = effectiveThinking;
                    }
                    pinnedResolved = resolvedForFallback;
                    effectiveThinking = 'auto';
                    // Drop the thinking token floor too: the retry must use the
                    // caller's original budget, not the enlarged thinking one.
                    effectiveMaxTokens = applyThinkingTokenFloor(baseMaxTokens, effectiveThinking);
                    continue;
                }
                const status = err?.status || 0;
                if (status === 429 || (status >= 500 && status < 600)) {
                    let backoff;
                    if (status === 429 && typeof err.retryAfter === 'number' && !Number.isNaN(err.retryAfter)) {
                        backoff = Math.min(err.retryAfter * 1000 + Math.random() * 250, 15000);
                    } else {
                        backoff = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 250, 5000);
                    }
                    await new Promise((r) => setTimeout(r, backoff));
                    attempt += 1;
                    continue;
                }
                break;
            }
        }
        throw lastErr || new Error('AI request failed');
    } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        unregister();
    }
}

/**
 * Streaming entry point shared by the assistant. Uses the same adapter layer as
 * requestAI so a provider that works for one-shot calls also streams correctly.
 *
 * `onDelta` receives answer text only; reasoning-model thinking arrives on
 * `onReasoning` so callers can separate or hide it instead of showing it as part
 * of the answer. The resolved `{ text, reasoning }` keeps the two apart too.
 */
export async function streamAIResponse({
    model,
    messages,
    temperature = 0.2,
    maxTokens,
    signal,
    taskType = 'assistant',
    timeoutMs = 120000,
    onDelta,
    onReasoning,
    thinking
}) {
    const memoryGeneration = thinkingFallbackGeneration;
    let resolved;
    try {
        resolved = await resolveAIRequestConfigAsync({ task: taskType, model });
    } catch (error) {
        throw localizeAIError(error);
    }
    const thinkingResolution = resolveThinkingLevel(taskType, { override: thinking });
    const requestedThinkingLevel = thinkingResolution.level;
    const baseMaxTokens = maxTokens;
    let effectiveThinking = requestedThinkingLevel;
    let thinkingFallbackNoticeLevel = '';
    if (effectiveThinking !== 'auto' && isThinkingUnsupportedFor(resolved, effectiveThinking)) {
        thinkingFallbackNoticeLevel = effectiveThinking;
        effectiveThinking = 'auto';
    }
    let effectiveMaxTokens = applyThinkingTokenFloor(baseMaxTokens, effectiveThinking);
    const adapter = requireAdapter(resolved.format);
    const buildRequest = () => adapter.buildRequest({
        provider: resolved,
        apiKey: resolved.apiKey,
        model: resolved.model,
        messages,
        temperature,
        maxTokens: effectiveMaxTokens,
        stream: true,
        thinking: effectiveThinking
    });
    let request = buildRequest();
    let requestCarriedThinking = requestCarriesThinkingParameter(request);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new DOMException('Timeout', 'AbortError')), timeoutMs);
    const onAbort = () => ac.abort(signal && signal.reason);
    if (signal) {
        if (signal.aborted) ac.abort(signal.reason);
        else signal.addEventListener('abort', onAbort, { once: true });
    }
    // Streaming resolves the target exactly once, so its in-request fallback
    // retry already stays on the endpoint that rejected the thinking field.
    const unregister = registerController(ac, resolved.source);
    try {
        const send = () => fetch(request.url, {
            method: 'POST',
            headers: request.headers,
            body: JSON.stringify(request.body),
            signal: ac.signal,
            redirect: 'error',
            cache: 'no-store'
        });
        let resp = await send();
        if (!resp.ok) {
            let err = providerHttpError(resp.status, await readErrorPayload(resp));
            // A provider that rejects reasoning parameters must not break the
            // whole feature: retry exactly once with the field omitted.
            if (effectiveThinking !== 'auto' && requestCarriedThinking && isThinkingParameterError(err)) {
                // Remember the rejected level; the notice is only emitted after
                // the retry succeeds, so a failed fallback stays silent. A stale
                // generation (catalog/auth reset) must not write into the new
                // memory even though this request may finish.
                if (memoryGeneration === thinkingFallbackGeneration) {
                    markThinkingUnsupported(resolved, effectiveThinking);
                    thinkingFallbackNoticeLevel = effectiveThinking;
                }
                effectiveThinking = 'auto';
                // Restore the caller's original budget instead of carrying the
                // thinking token floor into the retry.
                effectiveMaxTokens = applyThinkingTokenFloor(baseMaxTokens, effectiveThinking);
                request = buildRequest();
                resp = await send();
                if (!resp.ok) {
                    err = providerHttpError(resp.status, await readErrorPayload(resp));
                    throw localizeAIError(err);
                }
            } else {
                throw localizeAIError(err);
            }
        }
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        const parser = createSseParser();
        let text = '';
        let reasoning = '';
        let finishReason = '';
        const handle = (events) => {
            for (const event of events) {
                const parsed = adapter.parseStreamEvent(event);
                if (parsed.errorCode) {
                    const err = new Error(parsed.errorMessage || 'provider stream error');
                    err.code = parsed.errorCode;
                    throw localizeAIError(err);
                }
                if (parsed.reasoning) {
                    reasoning += parsed.reasoning;
                    try { if (typeof onReasoning === 'function') onReasoning(parsed.reasoning); } catch (_) {}
                }
                if (parsed.text) {
                    text += parsed.text;
                    try { if (typeof onDelta === 'function') onDelta(parsed.text); } catch (_) {}
                }
                if (parsed.finishReason) finishReason = parsed.finishReason;
                if (parsed.done) return true;
            }
            return false;
        };
        let finished = false;
        while (!finished) {
            const { value, done } = await reader.read();
            if (done) break;
            const events = parser.push(decoder.decode(value, { stream: true }));
            finished = handle(events);
        }
        if (!finished) handle(parser.flush());
        if (thinkingFallbackNoticeLevel) {
            const level = thinkingFallbackNoticeLevel;
            thinkingFallbackNoticeLevel = '';
            if (memoryGeneration === thinkingFallbackGeneration
                && markThinkingFallbackNotified(resolved, level)) {
                notifyThinkingFallback({
                    task: taskType,
                    level,
                    provider: resolved.provider,
                    model: resolved.model
                });
            }
        }
        return { text, reasoning, finishReason, providerId: resolved.provider, model: resolved.model, source: resolved.source };
    } catch (error) {
        if (error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
            const err = new Error('aborted');
            err.name = 'AbortError';
            err.code = 'request_aborted';
            throw err;
        }
        throw localizeAIError(error);
    } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        unregister();
    }
}

export function cancelAllAIRequests() {
    abortAIRequests();
}

/**
 * 通用的 AI API 請求函數；預期回傳 JSON 內容或可解析為 JSON 的字串。
 */
export async function fetchAIResponse(model, prompt, temperature = 0.5, { maxTokens, timeoutMs = 30000, signal, responseFormat, taskType = 'default', apiUrl, apiKey, provider, profile, thinking } = {}) {
    const data = await requestAI({
        model,
        temperature,
        maxTokens,
        messages: [{ role: 'user', content: prompt }],
        timeoutMs,
        signal,
        responseFormat,
        taskType,
        apiUrl,
        apiKey,
        provider,
        profile,
        thinking
    });

    let content = pickMessageContent(data).replace(/^```json\n/, '').replace(/\n```$/, '').trim();
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
        const locale = getLocale();
        const promptVersion = getPromptVersion('dictionary.wordAnalysis');
        const thinking = resolveThinkingLevel('wordAnalysis').level;
        const settings = loadGlobalSettings();
        const modelSpec = getPreferredTaskSpec(['wordAnalysis'], { settings });
        const modelKey = cacheModelKey(normalizeModelSpec(modelSpec));
        const cached = await cache.getCached('dictionaryWordAnalysis', {
            word,
            locale,
            promptVersion,
            modelKey,
            thinking,
            schema: 'v1'
        });
        if (cached) return cached;
        const prompt = buildPrompt('dictionary.wordAnalysis', { word, notation: IPA_NOTATION_RULE }, { locale });
        const result = await fetchAIResponse('', prompt, 0.2, { taskType: 'wordAnalysis', thinking });
        // The key records the *requested* level. A channel may silently fall
        // back to auto, but the validated English result is still worth caching.
        await cache.setCached('dictionaryWordAnalysis', {
            word,
            locale,
            promptVersion,
            modelKey,
            thinking,
            schema: 'v1'
        }, result, 30 * 24 * 60 * 60 * 1000);
        return result;
    } catch (error) {
        console.error(`Error analyzing word "${word}":`, error);
        return { phonetic: 'error', pos: '', meaning: t('ai.analysisFailed') };
    }
}

/**
 * 為指定單詞生成例句。
 * @param {string} word - 需要例句的單詞。
 * @returns {Promise<Array>} - 包含例句對象的數組。
 */
export async function generateExamplesForWord(word, opts = {}) {
    const w = (word && typeof word === 'object') ? (word.word || '') : String(word || '');
    const prompt = buildPrompt('learning.exampleGeneration', { word: w }, { locale: getLocale() });
    return await fetchAIResponse('', prompt, 0.7, { maxTokens: 900, timeoutMs: 20000, taskType: 'exampleGeneration', ...opts });
}

/**
 * 檢查用戶造句的正確性。
 * @param {string} word - 句子中使用的核心單詞。
 * @param {string} userSentence - 用戶創建的句子。
 * @returns {Promise<string>} - AI 的反饋文本。
 */
export async function checkUserSentence(word, userSentence, opts = {}) {
    const locale = getLocale();
    const correctToken = locale === 'zh-HK' ? '正確' : '正确'; // i18n-allow: 依介面語言給模型的指示詞
    const incorrectPrefix = locale === 'zh-HK' ? '不正確。建議：' : '不正确。建议：';
    const prompt = buildPrompt('learning.sentenceChecking', {
        word,
        userSentence,
        correctToken,
        incorrectPrefix
    }, { locale });
    return await fetchAIResponse('', prompt, 0.5, { maxTokens: 600, timeoutMs: 15000, taskType: 'sentenceChecking', ...opts });
}

/**
 * 分析文章中的單個段落。
 * @param {string} paragraph - 要分析的段落。
 * @returns {Promise<object>} - 包含段落分析結果的對象。
 */
export async function analyzeParagraph(paragraph, opts = {}) {
    const { timeoutMs = 45000, signal, level: requestedLevel = 'standard', noCache = false } = opts;
    // 按句翻譯模式：呼叫端預先用與渲染一致的分句器切好句子傳入，
    // 模型只需返回等長的中文譯句陣列，對齊由構造保證
    const sentenceList = Array.isArray(opts.sentences)
      ? opts.sentences.map(s => String(s || '').trim()).filter(Boolean)
      : null;
    const sentenceMode = !!(sentenceList && sentenceList.length);
    const cacheLevel = sentenceMode ? `${requestedLevel}-sent` : requestedLevel;
    const locale = getLocale();
    const promptVersion = getPromptVersion('article.paragraphTranslation');
    const thinking = resolveThinkingLevel('articleParagraphTranslation').level;
    // The key records the requested level; a provider that rejects the thinking
    // parameter may have answered after api.js downgraded it to auto.
    const cacheOptions = { locale, promptVersion, thinking };
    const s = loadGlobalSettings();
    const primaryModel = getPreferredTaskSpec(['articleParagraphTranslation', 'articleAnalysis', 'wordAnalysis'], { settings: s });
    const fallbackModel = getPreferredTaskSpec(['articleParagraphTranslationFallback', 'articleAnalysis', 'wordAnalysis'], { settings: s });
    const candidates = buildModelCandidates(primaryModel, fallbackModel);

    if (!noCache) {
        for (const modelSpec of candidates) {
            const resolved = normalizeModelSpec(modelSpec);
            try {
                const cached = await cache.getParagraphAnalysisCached(paragraph, cacheLevel, cacheModelKey(resolved), cacheOptions);
                if (cached) return cached;
            } catch (_) {}
        }
    }

    const prompt = sentenceMode
      ? (() => {
            const count = sentenceList.length;
            const numbered = sentenceList.map((sent, i) => `${i + 1}. ${sent}`).join('\n');
            return buildPrompt('article.paragraphTranslation', { numbered, count }, { locale, variant: 'sentences' });
        })()
      : buildPrompt('article.paragraphTranslation', { paragraph }, { locale, variant: 'standard' });
    const maxTokens = sentenceMode
      ? Math.max(800, Math.min(2400, 300 + sentenceList.length * 180))
      : (requestedLevel === 'quick' ? 800 : 1000);

    let lastErr = null;
    for (const modelSpec of candidates) {
        const resolved = normalizeModelSpec(modelSpec);
        try {
            const data = await requestAI({
                model: modelSpec,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.2,
                maxTokens,
                timeoutMs,
                signal,
                responseFormat: { type: 'json_object' },
                taskType: 'articleParagraphTranslation',
                thinking
            });
            const content = pickMessageContent(data);
            const rawParsed = safeJsonParse(content);
            // 解析失敗（多為截斷殘骸）直接換下一個模型，不可把原始文字當譯文塞進結果與快取
            if (!rawParsed || typeof rawParsed !== 'object') throw new Error('JSON parse failed (possibly truncated)');
            let parsed;
            if (sentenceMode) {
                const zhArr = normalizeSentenceTranslations(rawParsed, sentenceList.length);
                if (!zhArr) throw new Error('Sentence-mode schema validation failed');
                parsed = {
                    chinese_translation: zhArr.join(''),
                    sentences: sentenceList.map((en, i) => ({ en, zh: zhArr[i] })),
                    word_alignment: [],
                    detailed_analysis: []
                };
            } else {
                parsed = normalizeParagraphResponse(rawParsed, '');
            }
            if (!validate.validateArticleAnalysis(parsed, requestedLevel)) throw new Error('Schema validation failed');
            try { await cache.setParagraphAnalysisCached(paragraph, cacheLevel, cacheModelKey(resolved), parsed, 14 * 24 * 60 * 60 * 1000, cacheOptions); } catch (_) {}
            return parsed;
        } catch (error) {
            lastErr = error;
        }
    }

    try {
        const fallbackModelSpec = candidates[0] || primaryModel;
        const fbPrompt = buildPrompt('article.paragraphTranslation', { paragraph }, { locale, variant: 'fallback' });
        const fb = await requestAI({
            model: fallbackModelSpec,
            messages: [{ role: 'user', content: fbPrompt }],
            temperature: 0.2,
            maxTokens: 700,
            timeoutMs,
            signal,
            taskType: 'articleParagraphTranslation',
            thinking
        });
        const raw = pickMessageContent(fb);
        const parsed = normalizeParagraphResponse(safeJsonParse(raw), plainAnswerOrEmpty(raw));
        if (!validate.validateArticleAnalysis(parsed, requestedLevel)) throw lastErr || new Error('Paragraph fallback failed');
        // 合法 schema 但沒有譯文：仍算失敗，呼叫端不得閃成功或寫入成功快取。
        if (!String(parsed.chinese_translation || '').trim()) {
            return { ...parsed, failed: true, errorCode: 'empty_translation' };
        }
        return parsed;
    } catch (_) {
        if (lastErr) console.warn('段落翻譯失敗，返回最小兜底。', lastErr);
        // additive：讓呼叫端能分辨「空結果」與「真的失敗」，不再把空譯文當成功。
        return {
            chinese_translation: '',
            word_alignment: [],
            detailed_analysis: [],
            failed: true,
            errorCode: signal && signal.aborted
                ? 'request_aborted'
                : (lastErr?.code || (lastErr ? 'provider_error' : 'empty_response'))
        };
    }
}

/**
 * 懶載：針對單個詞（或短語）在其所在句子中的詳解。
 */
function invalidLookupResponse() {
    return Object.assign(new Error(t('errors.aiInvalidResponse')), { code: 'invalid_response' });
}

function analysisModel(modelSpec, task, opts) {
    return opts.strict ? resolveAIRequestConfig({ task, model: modelSpec }) : normalizeModelSpec(modelSpec);
}

function analysisCacheModelKey(resolved, opts) {
    if (!opts.strict) return cacheModelKey(resolved);
    return JSON.stringify({
        provider: resolved.provider, model: resolved.model, apiUrl: resolved.apiUrl,
        format: resolved.format, authMode: resolved.authMode,
        catalogVersion: resolved.source === 'managed' ? getCatalogState().version : 0,
        validation: 1
    });
}

function withAnalysisModel(parsed, resolved, opts) {
    if (!opts.strict) return parsed;
    return { ...parsed, lookupModel: { provider: resolved.provider, model: resolved.model, apiUrl: resolved.apiUrl } };
}

export async function analyzeWordInSentence(word, sentence, opts = {}) {
    const { timeoutMs = 20000, signal, noCache = false } = opts;
    const context = typeof opts.context === 'string' ? opts.context.trim() : '';
    const s = loadGlobalSettings();
    const primaryModel = getPreferredTaskSpec(['articleWordTranslation', 'articleWordTooltip', 'wordAnalysis'], { settings: s });
    const fallbackModel = getPreferredTaskSpec(['articleWordTranslationFallback', 'wordAnalysis'], { settings: s });
    const candidates = buildModelCandidates(primaryModel, fallbackModel);
    const locale = opts.locale ? normalizeLocale(opts.locale) : getLocale();
    const promptVersion = getPromptVersion('article.wordTooltip');
    const thinking = resolveThinkingLevel('articleWordTranslation').level;
    // Stored under the requested level even if the channel downgraded to auto.
    const cacheOptions = { locale, promptVersion, thinking, ...(opts.strict ? { structuredLookup: 1 } : {}) };
    if (context) {
        try { cacheOptions.contextHash = await cache.makeKey('ctx', context); } catch (_) { cacheOptions.contextHash = context; }
    }
    if (opts.cacheScope && typeof opts.cacheScope === 'object') {
        cacheOptions.endpoint = String(opts.cacheScope.endpoint || '');
        cacheOptions.userId = String(opts.cacheScope.userId || '');
    }
    if (!noCache) {
        for (const modelSpec of candidates) {
            try {
                const resolved = analysisModel(modelSpec, 'articleWordTranslation', opts);
                const cached = await cache.getWordAnalysisCached(word, sentence, analysisCacheModelKey(resolved, opts), cacheOptions);
                if (cached) return cached;
            } catch (_) {}
        }
    }
    const prompt = context
        ? buildPrompt('article.wordTooltip', { word, sentence, context }, { locale, variant: 'contextual' })
        : buildPrompt('article.wordTooltip', { word, sentence }, { locale, variant: 'standard' });

    let lastErr = null;
    for (const modelSpec of candidates) {
        try {
            const resolved = analysisModel(modelSpec, 'articleWordTranslation', opts);
            const data = await requestAI({
                model: modelSpec,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.2,
                maxTokens: 520,
                timeoutMs,
                signal,
                responseFormat: { type: 'json_object' },
                taskType: 'articleWordTranslation',
                thinking
            });
            const raw = pickMessageContent(data);
            const rawParsed = safeJsonParse(raw);
            // 解析失敗（多為截斷殘骸）直接換下一個模型，避免把原始 JSON 字串塞進「意思」並寫入快取
            if (!rawParsed || typeof rawParsed !== 'object') throw invalidLookupResponse();
            const parsed = withAnalysisModel(normalizeWordInSentenceResponse(rawParsed, '', word, sentence), resolved, opts);
            if (!validate.validateWordInSentence(parsed)) throw invalidLookupResponse();
            if (!String(parsed?.analysis?.meaning || '').trim()) {
                if (opts.strict) throw invalidLookupResponse();
                // 空 meaning 不是成功：不寫入快取，交給呼叫端顯示重試。
                return { ...parsed, failed: true, errorCode: 'empty_response' };
            }
            try { await cache.setWordAnalysisCached(word, sentence, analysisCacheModelKey(resolved, opts), parsed, 30 * 24 * 60 * 60 * 1000, cacheOptions); } catch (_) {}
            return parsed;
        } catch (error) {
            if (signal?.aborted) throw signal.reason || error;
            lastErr = error;
        }
    }

    if (opts.strict) throw localizeAIError(lastErr || invalidLookupResponse());

    try {
        const fallbackModelSpec = candidates[0] || primaryModel;
        const fb = await requestAI({
            model: fallbackModelSpec,
            messages: [{ role: 'user', content: buildPrompt('article.wordTooltip', { word, sentence }, { locale, variant: 'fallback' }) }],
            temperature: 0.2,
            maxTokens: 200,
            timeoutMs,
            signal,
            taskType: 'articleWordTranslation',
            thinking
        });
        const raw = pickMessageContent(fb);
        const parsed = normalizeWordInSentenceResponse(null, plainAnswerOrEmpty(raw), word, sentence);
        if (!validate.validateWordInSentence(parsed) || !parsed.analysis.meaning) throw lastErr || new Error('Word fallback failed');
        const resolved = normalizeModelSpec(fallbackModelSpec);
        try { await cache.setWordAnalysisCached(word, sentence, analysisCacheModelKey(resolved, opts), parsed, 30 * 24 * 60 * 60 * 1000, cacheOptions); } catch (_) {}
        return parsed;
    } catch (_) {
        if (lastErr) throw lastErr;
        return {
            ...normalizeWordInSentenceResponse(null, '', word, sentence),
            failed: true,
            errorCode: 'empty_response'
        };
    }
}

// --- Sentence-level analysis ---
export async function analyzeSentence(sentence, context = '', opts = {}) {
    const { timeoutMs = 20000, signal, noCache = false, conciseKeypoints = true, includeStructure = true } = opts;
    const s = loadGlobalSettings();
    const primaryModel = getPreferredTaskSpec(['articleSentenceTranslation', 'articleAnalysis', 'wordAnalysis'], { settings: s });
    const fallbackModel = getPreferredTaskSpec(['articleSentenceTranslationFallback', 'articleAnalysis', 'wordAnalysis'], { settings: s });
    const candidates = buildModelCandidates(primaryModel, fallbackModel);
    const locale = getLocale();
    const promptVersion = getPromptVersion('article.sentenceAnalysis');
    const thinking = resolveThinkingLevel('articleSentenceTranslation').level;
    // Stored under the requested level even if the channel downgraded to auto.
    const cacheOptions = { locale, promptVersion, thinking };
    let contextHash = '';
    try { contextHash = await cache.makeKey('ctx', context); } catch (_) {}
    if (!noCache) {
        for (const modelSpec of candidates) {
            const resolved = normalizeModelSpec(modelSpec);
            try {
                const cached = await cache.getSentenceAnalysisCached(sentence, contextHash, cacheModelKey(resolved), cacheOptions);
                if (cached) return cached;
            } catch (_) {}
        }
    }
    const keyPointRule = conciseKeypoints
      ? 'Return 1-3 brief key points. If structured analysis is unreliable, return an empty array.'
      : 'Return 2-4 of the most important key points.';
    const prompt = includeStructure
      ? buildPrompt('article.sentenceAnalysis', { sentence, context, keyPointRule }, { locale, variant: 'structured' })
      : buildPrompt('article.sentenceAnalysis', { sentence, context, keyPointRule }, { locale, variant: 'concise' });

    let lastErr = null;
    for (const modelSpec of candidates) {
        const resolved = normalizeModelSpec(modelSpec);
        try {
            const data = await requestAI({
                model: modelSpec,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.2,
                maxTokens: includeStructure ? 1100 : 700,
                timeoutMs,
                signal,
                responseFormat: { type: 'json_object' },
                taskType: 'articleSentenceTranslation',
                thinking
            });
            const raw = pickMessageContent(data);
            const rawParsed = safeJsonParse(raw);
            // 解析失敗（多為截斷殘骸）直接換下一個模型，避免把原始 JSON 字串當成譯文顯示與快取
            if (!rawParsed || typeof rawParsed !== 'object') throw new Error('JSON parse failed (possibly truncated)');
            const parsed = normalizeSentenceResponse(rawParsed, '', sentence);
            if (!validate.validateSentenceAnalysis(parsed) || !parsed.translation) throw new Error('Schema validation failed');
            try { await cache.setSentenceAnalysisCached(sentence, contextHash, cacheModelKey(resolved), parsed, 21 * 24 * 60 * 60 * 1000, cacheOptions); } catch (_) {}
            return parsed;
        } catch (error) {
            lastErr = error;
        }
    }

    try {
        const fallbackModelSpec = candidates[0] || primaryModel;
        const fbPrompt = buildPrompt('article.sentenceAnalysis', { sentence }, { locale, variant: 'fallback' });
        const fb = await requestAI({
            model: fallbackModelSpec,
            messages: [{ role: 'user', content: fbPrompt }],
            temperature: 0.2,
            maxTokens: 400,
            timeoutMs,
            signal,
            taskType: 'articleSentenceTranslation',
            thinking
        });
        const raw = pickMessageContent(fb);
        const parsed = normalizeSentenceResponse(safeJsonParse(raw), plainAnswerOrEmpty(raw), sentence);
        if (!validate.validateSentenceAnalysis(parsed) || !parsed.translation) throw lastErr || new Error('Sentence fallback failed');
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
    const primaryModel = getPreferredTaskSpec(['articlePhraseTranslation', 'articlePhraseAnalysis', 'wordAnalysis'], { settings: s });
    const fallbackModel = getPreferredTaskSpec(['articlePhraseTranslationFallback', 'wordAnalysis'], { settings: s });
    const candidates = buildModelCandidates(primaryModel, fallbackModel);
    const locale = opts.locale ? normalizeLocale(opts.locale) : getLocale();
    const promptVersion = getPromptVersion('article.phraseAnalysis');
    const thinking = resolveThinkingLevel('articlePhraseTranslation').level;
    // Stored under the requested level even if the channel downgraded to auto.
    const cacheOptions = { locale, promptVersion, thinking, ...(opts.strict ? { structuredLookup: 1 } : {}) };
    if (opts.cacheScope && typeof opts.cacheScope === 'object') {
        cacheOptions.endpoint = String(opts.cacheScope.endpoint || '');
        cacheOptions.userId = String(opts.cacheScope.userId || '');
    }
    let contextHash = '';
    try { contextHash = await cache.makeKey('ctx', context); } catch (_) {}
    if (!noCache) {
        for (const modelSpec of candidates) {
            try {
                const resolved = analysisModel(modelSpec, 'articlePhraseTranslation', opts);
                const cached = await cache.getSelectionAnalysisCached(selection, sentence, contextHash, analysisCacheModelKey(resolved, opts), cacheOptions);
                if (cached) return cached;
            } catch (_) {}
        }
    }
    const prompt = buildPrompt('article.phraseAnalysis', { selection, sentence, context }, { locale, variant: 'standard' });

    let lastErr = null;
    for (const modelSpec of candidates) {
        try {
            const resolved = analysisModel(modelSpec, 'articlePhraseTranslation', opts);
            const data = await requestAI({
                model: modelSpec,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.2,
                maxTokens: 520,
                timeoutMs,
                signal,
                responseFormat: { type: 'json_object' },
                taskType: 'articlePhraseTranslation',
                thinking
            });
            const raw = pickMessageContent(data);
            const rawParsed = safeJsonParse(raw);
            // 解析失敗（多為截斷殘骸）直接換下一個模型，避免把原始 JSON 字串當成釋義顯示與快取
            if (!rawParsed || typeof rawParsed !== 'object') throw invalidLookupResponse();
            const parsed = withAnalysisModel(normalizeSelectionResponse(rawParsed, '', selection, sentence), resolved, opts);
            if (!validate.validateSelectionAnalysis(parsed) || !String(parsed.analysis.meaning || '').trim()) throw invalidLookupResponse();
            try { await cache.setSelectionAnalysisCached(selection, sentence, contextHash, analysisCacheModelKey(resolved, opts), parsed, 30 * 24 * 60 * 60 * 1000, cacheOptions); } catch (_) {}
            return parsed;
        } catch (error) {
            if (signal?.aborted) throw signal.reason || error;
            lastErr = error;
        }
    }

    if (opts.strict) throw localizeAIError(lastErr || invalidLookupResponse());

    try {
        const fallbackModelSpec = candidates[0] || primaryModel;
        const fb = await requestAI({
            model: fallbackModelSpec,
            messages: [{ role: 'user', content: buildPrompt('article.phraseAnalysis', { selection, sentence }, { locale, variant: 'fallback' }) }],
            temperature: 0.2,
            maxTokens: 220,
            timeoutMs,
            signal,
            taskType: 'articlePhraseTranslation',
            thinking
        });
        const raw = pickMessageContent(fb);
        const parsed = normalizeSelectionResponse(null, plainAnswerOrEmpty(raw), selection, sentence);
        if (!validate.validateSelectionAnalysis(parsed) || !parsed.analysis.meaning) throw lastErr || new Error('Phrase fallback failed');
        const resolved = normalizeModelSpec(fallbackModelSpec);
        try { await cache.setSelectionAnalysisCached(selection, sentence, contextHash, analysisCacheModelKey(resolved, opts), parsed, 30 * 24 * 60 * 60 * 1000, cacheOptions); } catch (_) {}
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
    const sec = loadGlobalSecrets();
    const model = hasModelSpec(modelOverride)
      ? modelOverride
      : getPreferredTaskSpec(['imageOCR', 'articleAnalysis'], { settings: s });
    const modelHasProvider = (typeof model === 'string' && model.includes(':'))
        || (isPlainObject(model) && !!firstNonEmptyString(model.provider, model.profile));
    const connection = modelHasProvider
        ? {}
        : resolveConfigConnection(OCR_CONFIG, { settings: s, secrets: sec });
    const finalMaxTokens = typeof maxTokens === 'number' ? maxTokens : (OCR_CONFIG?.maxTokens || 1500);
    const finalTimeout = typeof timeoutMs === 'number' ? timeoutMs : (OCR_CONFIG?.timeoutMs || 45000);

    const data = await requestAI({
        apiUrl: connection.apiUrl,
        apiKey: connection.apiKey,
        provider: connection.provider,
        profile: connection.profile,
        model,
        temperature,
        maxTokens: finalMaxTokens,
        timeoutMs: finalTimeout,
        signal,
        taskType: 'imageOCR',
        messages: [{
            role: 'user',
            content: [
                (function(){
                    const txt = buildPrompt('ocr.extractText', {
                        userInstructions: promptHint || '(none)'
                    }, { locale: getLocale() });
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
    const sec = loadGlobalSecrets();
    const model = hasModelSpec(modelOverride)
      ? modelOverride
      : getPreferredTaskSpec(['imageOCR', 'articleAnalysis'], { settings: s });
    const modelHasProvider = (typeof model === 'string' && model.includes(':'))
        || (isPlainObject(model) && !!firstNonEmptyString(model.provider, model.profile));
    const connection = modelHasProvider
        ? {}
        : resolveConfigConnection(OCR_CONFIG, { settings: s, secrets: sec });
    const finalTimeout = typeof timeoutMs === 'number' ? timeoutMs : (OCR_CONFIG?.timeoutMs || 60000);

    const promptId = format === 'markdown'
      ? 'dictation.handwritingGradingMarkdown'
      : 'ocr.handwritingGradingJson';
    const defaultPrompt = buildPrompt(promptId, { userInstructions: '(none)' }, { locale: getLocale() });

    const content = [];
    content.push({ type: 'text', text: String(userPrompt || defaultPrompt) });
    // 附上標準詞表
    try {
        const compact = expectedList.map(x => ({ word: String(x.word||''), meaning: String(x.meaning||'') }));
        if (format === 'markdown') {
            const md = ['標準詞表（僅供比對，請不要逐行列出於表格中）：']; // i18n-allow: 送給模型的提示詞，非介面文案
            for (const it of compact) md.push(`- ${it.word}${it.meaning ? ' — ' + it.meaning : ''}`);
            content.push({ type: 'text', text: md.join('\n') });
        } else {
            // i18n-allow: 送給模型的提示詞，非介面文案
            content.push({ type: 'text', text: `標準詞表（JSON）:\n${JSON.stringify(compact)}` });
        }
    } catch (_) { /* ignore */ }
    // 附上多張圖片
    for (const url of (imageDataUrls||[])) {
        content.push({ type: 'image_url', image_url: { url, detail: 'high' } });
    }

    const req = {
        apiUrl: connection.apiUrl,
        apiKey: connection.apiKey,
        provider: connection.provider,
        profile: connection.profile,
        model,
        messages: [{ role: 'user', content }],
        temperature,
        timeoutMs: finalTimeout,
        taskType: 'imageOCR'
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
    try { u = new URL(url, window.location.href); } catch (_) { throw new Error(t('errors.urlInvalid')); }
    if (!/^https?:$/i.test(u.protocol)) throw new Error(t('errors.urlSchemeOnly'));

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

    throw new Error(t('errors.urlFetchFailed'));
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
    // 有設定抽取端點就先走它：同源 /extract 直接回乾淨 Markdown，
    // 不會受目標站 CORS 或 r.jina.ai 可用性影響
    if (ARTICLE_IMPORT?.EXTRACT_URL) {
        try {
            const viaExtract = await fetchArticleViaWorker(url, { ...opts });
            if (viaExtract?.markdown) {
                return {
                    title: viaExtract.title || '',
                    content: viaExtract.markdown,
                    publishedAt: viaExtract.publishedAt || '',
                    url
                };
            }
        } catch (_) { /* 落回原本的 r.jina.ai／直抓流程 */ }
    }
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
    if (!endpoint) throw new Error(t('errors.extractEndpointMissing'));
    const base = buildArticleImportUrl(endpoint, url);
    if (!base) throw new Error(t('errors.extractUrlFailed'));
    // 端點可以是相對路徑（例如預覽伺服器的同源 /extract?url=），用目前頁面當基底解析
    const u = new URL(base, window.location.href);
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
            markdown = await aiExtractArticleFromHtml(htmlInput, { url: sourceUrl, keepImages, timeoutMs, signal, model, onNotice: opts.onNotice });
        } else {
            throw new Error(t('errors.extractNoContent'));
        }
    }
    return { title, byline, publishedAt, markdown, raw: data, sourceUrl };
}

export async function listCuratedArticles(sourceId, opts = {}) {
    const { timeoutMs = 15000, signal } = opts;
    if (!sourceId) throw new Error(t('errors.missingSourceId'));
    if (!ARTICLE_IMPORT?.FEED_URL) throw new Error(t('errors.feedEndpointMissing'));
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
    if (!articleUrl) throw new Error(t('errors.missingArticleUrl'));
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
                    markdown = await aiExtractArticleFromHtml(html, { url: articleUrl, keepImages, timeoutMs, signal, model, onNotice: opts.onNotice });
                } else if (data?.contentText) {
                    markdown = await aiCleanArticleMarkdown(String(data.contentText), { keepImages, timeoutMs, signal, model, onNotice: opts.onNotice });
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
        // 兩個端點都失敗時要把兩個原因都講出來；只丟第一個（第三方來源的 403）
        // 會讓使用者以為問題出在那邊，看不到自訂抽取端點真正的失敗原因
        if (lastErr) {
            const combined = new Error(t('errors.extractFallbackFailed', { first: lastErr.message, second: err?.message || err }));
            combined.status = err?.status || lastErr.status;
            throw combined;
        }
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
/**
 * 把長 Markdown 依空行切成數塊，供分段清洗使用。
 * 不會切在程式碼區塊中間（用 ``` 的奇偶數判斷）。
 */
export function splitMarkdownForCleanup(markdown, limit = 3500) {
    const blocks = String(markdown || '').split(/\n{2,}/);
    const chunks = [];
    let buf = [];
    let len = 0;
    let inFence = false;
    const flush = () => {
        if (!buf.length) return;
        chunks.push(buf.join('\n\n'));
        buf = [];
        len = 0;
    };
    for (const block of blocks) {
        if (len && !inFence && len + block.length + 2 > limit) flush();
        buf.push(block);
        len += block.length + 2;
        const fences = (block.match(/^\s*```/gm) || []).length;
        if (fences % 2 === 1) inFence = !inFence;
    }
    flush();
    return chunks.length ? chunks : [String(markdown || '')];
}

/** 清洗單一塊；回傳 { content, truncated } */
async function cleanMarkdownChunk(chunk, ctx) {
    const messages = buildMessages('import.markdownCleanup', {
        imageRule: ctx.imageRule,
        markdownText: chunk
    });
    // 推理模型的思考 token 和正文共用同一個上限，所以額度要按輸入長度給足
    const maxTokens = Math.min(8000, Math.max(ctx.baseMaxTokens, chunk.length + 800));
    const data = await requestAI({
        apiUrl: ctx.connection.apiUrl,
        apiKey: ctx.connection.apiKey,
        provider: ctx.connection.provider,
        profile: ctx.connection.profile,
        model: ctx.model,
        messages,
        temperature: ctx.temperature,
        maxTokens,
        timeoutMs: ctx.timeoutMs,
        signal: ctx.signal,
        taskType: 'articleCleanup'
    });
    let content = (data?.choices?.[0]?.message?.content || '').trim();
    // 去掉偶發的 ``` 標記
    content = content.replace(/^```(?:markdown)?\n/, '').replace(/\n```\s*$/, '').trim();
    return { content, truncated: data?.choices?.[0]?.finish_reason === 'length' };
}

export async function aiCleanArticleMarkdown(markdownText, opts = {}) {
    const { timeoutMs: toMs, temperature: temp, signal, model: modelOverride, keepImages: keepImgs } = opts;
    const s = loadGlobalSettings();
    const sec = loadGlobalSecrets();
    const model = hasModelSpec(modelOverride)
      ? modelOverride
      : getPreferredTaskSpec(['articleCleanup', 'articleAnalysis', 'wordAnalysis'], { settings: s });
    const modelHasProvider = (typeof model === 'string' && model.includes(':'))
        || (isPlainObject(model) && !!firstNonEmptyString(model.provider, model.profile));
    const connection = modelHasProvider
        ? {}
        : resolveConfigConnection(ARTICLE_IMPORT, { settings: s, secrets: sec });

    const temperature = (typeof temp === 'number') ? temp : (ARTICLE_IMPORT?.temperature ?? 0.1);
    const baseMaxTokens = ARTICLE_IMPORT?.maxTokens ?? 1400;
    const timeoutMs = (typeof toMs === 'number') ? toMs : (ARTICLE_IMPORT?.timeoutMs ?? 25000);
    const keepImages = (typeof keepImgs === 'boolean') ? keepImgs : (ARTICLE_IMPORT?.keepImagesDefault ?? true);

    const imageRule = keepImages
      ? 'Keep content-related images as Markdown image lines. Preserve their syntax and alt text; remove social, tracking and banner images.'
      : 'Remove all Markdown image lines without replacing them with links or descriptions.';

    const ctx = { connection, model, temperature, baseMaxTokens, timeoutMs, signal, imageRule };
    const source = String(markdownText || '');
    const chunks = splitMarkdownForCleanup(source);

    // 短文章：維持單次呼叫
    if (chunks.length <= 1) {
        const { content, truncated } = await cleanMarkdownChunk(source, ctx);
        if (truncated) notifyNotice(opts, 'cleanup-truncated');
        return content;
    }

    // 長文章：逐塊清洗再拼回。先前是一次性送出，撞到輸出上限就會安靜地砍掉尾段。
    const cleaned = [];
    let truncatedAny = false;
    for (let i = 0; i < chunks.length; i += 1) {
        try { if (typeof opts.onProgress === 'function') opts.onProgress(i + 1, chunks.length); } catch (_) {}
        try {
            const { content, truncated } = await cleanMarkdownChunk(chunks[i], ctx);
            if (truncated) truncatedAny = true;
            cleaned.push(content || chunks[i]);
        } catch (err) {
            if (i === 0) throw err;          // 第一塊就失敗：讓呼叫端決定怎麼提示
            cleaned.push(chunks[i]);         // 後續失敗：保留原文，至少不丢內容
        }
    }
    if (truncatedAny) notifyNotice(opts, 'cleanup-truncated');
    return cleaned.join('\n\n');
}

/**
 * 直接將完整 HTML 交給 AI 做正文抽取與清洗，輸出乾淨 Markdown。
 * - 不翻譯、不新增解說；保留結構（標題/清單/表格/引用/程式碼）。
 * - 依 base URL 嘗試將相對連結/圖片轉成絕對 URL。
 * - 可選擇是否保留圖片（轉為 Markdown 圖片行）。
 */
export async function aiExtractArticleFromHtml(html, opts = {}) {
    const { url = '', keepImages = true, timeoutMs: toMs, temperature: temp, signal, model: modelOverride } = opts;

    const s = loadGlobalSettings();
    const sec = loadGlobalSecrets();
    const model = hasModelSpec(modelOverride)
      ? modelOverride
      : getPreferredTaskSpec(['articleCleanup', 'articleAnalysis', 'wordAnalysis'], { settings: s });
    const connection = resolveConfigConnection(ARTICLE_IMPORT, { settings: s, secrets: sec });

    const temperature = (typeof temp === 'number') ? temp : (ARTICLE_IMPORT?.temperature ?? 0.1);
    const maxTokens = ARTICLE_IMPORT?.maxTokens ?? 1800;
    const timeoutMs = (typeof toMs === 'number') ? toMs : (ARTICLE_IMPORT?.timeoutMs ?? 30000);

    const imageRule = keepImages
      ? 'Keep content-related images as Markdown image lines, preserve or infer useful alt text, and convert their URLs to absolute URLs.'
      : 'Remove all images without replacing them with text.';
    const content = buildMessages('import.htmlExtraction', {
        url: url || '(unknown)',
        imageRule,
        html: String(html || '')
    });

    const data = await requestAI({
        apiUrl: connection.apiUrl,
        apiKey: connection.apiKey,
        provider: connection.provider,
        profile: connection.profile,
        model,
        messages: content,
        temperature,
        maxTokens,
        timeoutMs,
        signal,
        taskType: 'articleCleanup'
    });

    let md = (data?.choices?.[0]?.message?.content || '').trim();
    // 去掉偶發的 ``` 標記
    md = md.replace(/^```(?:markdown)?\n/, '').replace(/\n```\s*$/, '').trim();
    // 長文的 HTML 抽取同樣是一槍到底，撞到上限就會少掉尾段
    if (data?.choices?.[0]?.finish_reason === 'length') notifyNotice(opts, 'extract-truncated');
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
    try { u = new URL(url, window.location.href); } catch (_) { throw new Error(t('errors.urlInvalid')); }
    if (!/^https?:$/i.test(u.protocol)) throw new Error(t('errors.urlSchemeOnly'));

    // 先嘗試直接抓取 HTML（受制於對方 CORS）
    try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(new DOMException('Timeout', 'AbortError')), timeoutMs);
        const resp = await fetch(u.toString(), { signal: signal || ac.signal, headers: { 'Accept': 'text/html,application/xhtml+xml' } });
        clearTimeout(timer);
        if (resp.ok) {
            const html = await resp.text();
            const md = await aiExtractArticleFromHtml(html, { url: u.toString(), keepImages, timeoutMs, signal, model, onNotice: opts.onNotice });
            return md;
        }
    } catch (_) { /* fallthrough */ }

    // 先試自有的抽取端點（例如預覽伺服器的同源 /extract）：它直接回乾淨 Markdown，
    // 不必再把整份 HTML 丟給模型重寫一次（那條路既慢又容易撞到輸出上限）
    if (ARTICLE_IMPORT?.EXTRACT_URL) {
        try {
            const viaExtract = await fetchArticleViaWorker(u.toString(), { timeoutMs, signal, keepImages, model });
            if (viaExtract?.markdown) return viaExtract.markdown;
        } catch (_) { /* 繼續嘗試其他路線 */ }
    }

    // 嘗試使用自有代理（若已配置）
    try {
        const proxy = ARTICLE_IMPORT && ARTICLE_IMPORT.PROXY_URL && String(ARTICLE_IMPORT.PROXY_URL).trim();
        if (proxy) {
            // 允許相對路徑（例如預覽伺服器的同源 /fetch?url=）
            const pu = new URL(proxy, window.location.href);
            // 允許 ?url= 形式；若使用路徑佔位，則直接拼接
            if (!pu.searchParams.get('url')) pu.searchParams.set('url', u.toString());
            const ac = new AbortController();
            const timer = setTimeout(() => ac.abort(new DOMException('Timeout', 'AbortError')), timeoutMs);
            const resp = await fetch(pu.toString(), { signal: signal || ac.signal, headers: { 'Accept': 'text/html,application/xhtml+xml' } });
            clearTimeout(timer);
            if (resp.ok) {
                const html = await resp.text();
                const md = await aiExtractArticleFromHtml(html, { url: u.toString(), keepImages, timeoutMs, signal, model, onNotice: opts.onNotice });
                return md;
            }
        }
    } catch (_) { /* ignore */ }

    if (noThirdPartyGateway) {
        throw new Error(t('errors.directFetchBlocked'));
    }

    // 回退：使用 r.jina.ai 取得可讀文本 → 再清洗
    const raw = await fetchArticleFromUrl(u.toString(), { timeoutMs, signal });
    const md = await aiCleanArticleMarkdown(raw, { timeoutMs, signal, keepImages, model, onNotice: opts.onNotice });
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

/** Accent-specific AI reference readings, using the existing wordAnalysis task/provider. */
export async function getWordPronunciations(word, accent, { signal, refresh = false } = {}) {
    const { validWord, validatePronunciations, normalizePronunciationText } = await import('./phonetics-data.js');
    word = normalizePronunciationText(word);
    if (!validWord(word) || !['uk', 'us'].includes(accent)) throw new Error(t('phonetics.invalid'));
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const locale = getLocale();
    const promptVersion = getPromptVersion('dictionary.pronunciation');
    const modelSpec = getPreferredTaskSpec(['wordAnalysis'], { settings: loadGlobalSettings() });
    const thinking = resolveThinkingLevel('wordAnalysis').level;
    const modelKey = cacheModelKey(normalizeModelSpec(modelSpec));
    const key = { word, accent, locale, promptVersion, modelKey, thinking };
    if (!refresh) {
        const hit = await cache.getCached('dictionaryPronunciation', key);
        const readings = validatePronunciations(hit, word, accent);
        if (readings.length) return readings;
    }
    const prompt = buildPrompt('dictionary.pronunciation', {
        wordJSON: JSON.stringify(word),
        accent,
        symbols: phonemeSymbols(accent).join(' '),
        notation: IPA_NOTATION_RULE
    }, { locale });
    const data = await fetchAIResponse('', prompt, 0.2, { taskType: 'wordAnalysis', signal, timeoutMs: 20000, thinking });
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const readings = validatePronunciations(data, word, accent);
    if (!readings.length) {
        const error = new Error(t('phonetics.lookupUnavailable'));
        error.code = 'pronunciation_invalid_response';
        throw error;
    }
    await cache.setCached('dictionaryPronunciation', key, data, 24 * 60 * 60 * 1000);
    return readings;
}


/** Shared lookup boundary; configuration and transport remain in the existing AI layer. */
export async function lookupSelection({ text = '', sentence = '', context = '', locale, signal, noCache = false, timeoutMs = 20000 } = {}) {
    const cleanText = String(text || '').trim();
    if (!cleanText) throw Object.assign(new Error(t('errors.lookupTextRequired')), { code: 'lookup_text_required' });
    const cleanContext = String(context || '').trim();
    const cleanSentence = String(sentence || '').trim() || cleanContext;
    const effectiveLocale = normalizeLocale(locale || getLocale());
    const scope = getActiveAIScope();
    const cacheScope = { endpoint: scope.endpoint || '', userId: scope.userId || '' };
    const isPhrase = /\s/.test(cleanText);
    const task = isPhrase ? 'articlePhraseTranslation' : (cleanSentence ? 'articleWordTranslation' : 'wordAnalysis');
    const chain = isPhrase ? ['articlePhraseTranslation', 'articlePhraseAnalysis', 'wordAnalysis']
        : (cleanSentence ? ['articleWordTranslation', 'articleWordTooltip', 'wordAnalysis'] : ['wordAnalysis']);
    const modelSpec = getPreferredTaskSpec(chain, { settings: loadGlobalSettings() });
    let connection;
    try { connection = await resolveAIRequestConfigAsync({ task, model: modelSpec }); }
    catch (error) { throw localizeAIError(error); }
    const thinking = resolveThinkingLevel(task).level;
    const promptId = isPhrase ? 'article.phraseAnalysis' : (cleanSentence ? 'article.wordTooltip' : 'dictionary.wordAnalysis');
    const promptVersion = getPromptVersion(promptId);
    const opts = { timeoutMs, signal, noCache, locale: effectiveLocale, context: cleanContext, cacheScope, strict: true };
    let raw;
    if (isPhrase) {
        raw = await analyzeSelection(cleanText, cleanSentence || cleanText, cleanContext, opts);
    } else if (cleanSentence) {
        raw = await analyzeWordInSentence(cleanText, cleanSentence, opts);
    } else {
        const cachePayload = {
            word: cleanText, locale: effectiveLocale, promptVersion, thinking, ...cacheScope,
            modelKey: analysisCacheModelKey(connection, opts), schema: 'structured-v1'
        };
        if (!noCache) raw = await cache.getCached('dictionaryWordAnalysis', cachePayload);
        if (!raw) {
            const data = await requestAI({
                model: modelSpec, taskType: task, thinking, signal, timeoutMs,
                messages: [{ role: 'user', content: buildPrompt(promptId, { word: cleanText, notation: IPA_NOTATION_RULE }, { locale: effectiveLocale }) }],
                temperature: 0.2, maxTokens: 320, responseFormat: { type: 'json_object' }
            });
            const parsed = safeJsonParse(pickMessageContent(data));
            if (!isPlainObject(parsed) || typeof parsed.meaning !== 'string' || !parsed.meaning.trim()) throw invalidLookupResponse();
            raw = withAnalysisModel(normalizeWordInSentenceResponse(parsed, '', cleanText, ''), connection, opts);
            await cache.setCached('dictionaryWordAnalysis', cachePayload, raw, 30 * 24 * 60 * 60 * 1000);
        }
    }
    const analysis = raw?.analysis || {};
    const meaning = String(analysis.meaning || '').trim();
    if (!meaning || raw.failed) throw invalidLookupResponse();
    const actual = raw.lookupModel || connection;
    const phonetic = String(analysis.phonetic || '').trim();
    const pos = String(analysis.pos || '').trim();
    const role = String(analysis.role || analysis.usage || '').trim();
    const examples = Array.isArray(analysis.examples) ? analysis.examples : [];
    return {
        kind: isPhrase ? 'phrase' : 'word', task, text: cleanText, word: cleanText, selection: cleanText,
        sentence: cleanSentence, context: cleanContext, locale: effectiveLocale, scope: cacheScope,
        provider: actual.provider, model: actual.model, thinking, promptVersion,
        phonetic, pos, meaning, role, usage: role, examples,
        analysis: { phonetic, pos, meaning, role, usage: role, examples }
    };
}
