// AI thinking-level policy shared by the request layer, protocol adapters and
// settings UI.
//
// This module intentionally has no imports: ai-profile-storage.js and
// ai-models.js both depend on it, so importing either one here would create a
// module cycle.

export const THINKING_LEVELS = ['auto', 'none', 'low', 'medium', 'high'];

// Anthropic extended-thinking budgets. `none` is expressed by omitting the
// `thinking` field entirely, so it has no budget here.
export const THINKING_BUDGETS = {
    low: 1024,
    medium: 4096,
    high: 8192
};

// Gemini 2.5 uses a numeric thinking budget instead of the Anthropic budgets.
export const GEMINI_THINKING_BUDGETS = {
    none: 0,
    low: 1024,
    medium: 4096,
    high: 16384
};

// Minimum output budget for one-shot requests when the caller already supplied
// maxTokens. Reasoning tokens share that budget, so a small JSON request can be
// cut off before the answer starts.
export const THINKING_TOKEN_FLOORS = {
    none: 0,
    low: 1200,
    medium: 2500,
    high: 5000
};

const TASK_ALIASES = {
    qaCheck: 'qaChecking',
    answerChecking: 'qaChecking',
    ocr: 'imageOCR'
};

// Tasks in the article word/phrase group follow the wordAnalysis setting.
const WORD_ANALYSIS_GROUP = new Set([
    'articleWordTranslation',
    'articleWordTooltip',
    'articlePhraseTranslation',
    'articlePhraseAnalysis'
]);

const APP_TASK_DEFAULTS = {
    wordAnalysis: 'none',
    articleParagraphTranslation: 'none',
    articleSentenceTranslation: 'low',
    assistant: 'medium'
};

const TASK_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isThinkingLevel(value) {
    return THINKING_LEVELS.includes(String(value || '').trim().toLowerCase());
}

export function normalizeThinkingLevel(value, fallback = 'auto') {
    const raw = String(value == null ? '' : value).trim().toLowerCase();
    if (THINKING_LEVELS.includes(raw)) return raw;
    const fallbackRaw = String(fallback == null ? '' : fallback).trim().toLowerCase();
    return THINKING_LEVELS.includes(fallbackRaw) ? fallbackRaw : 'auto';
}

export function normalizeThinkingTaskName(taskName = 'default') {
    const raw = String(taskName || 'default').trim() || 'default';
    return TASK_ALIASES[raw] || raw;
}

/**
 * Lookup order for a task's personal setting. Article word/phrase tasks can
 * inherit the wordAnalysis choice; every result starts with the task itself so
 * a more specific value always wins.
 */
export function resolveThinkingLookupKeys(taskName = 'default') {
    const canonical = normalizeThinkingTaskName(taskName);
    const keys = [canonical];
    if (WORD_ANALYSIS_GROUP.has(canonical)) keys.push('wordAnalysis');
    return keys;
}

export function appThinkingDefault(taskName = 'default') {
    for (const key of resolveThinkingLookupKeys(taskName)) {
        if (Object.prototype.hasOwnProperty.call(APP_TASK_DEFAULTS, key)) {
            return APP_TASK_DEFAULTS[key];
        }
    }
    return 'auto';
}

/** Normalise a stored/synced task -> level map, dropping unknown tasks/levels. */
export function normalizeTaskThinkingMap(input) {
    const out = {};
    if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
    for (const [task, value] of Object.entries(input)) {
        if (!TASK_NAME_RE.test(task)) continue;
        if (!isThinkingLevel(value)) continue;
        out[task] = normalizeThinkingLevel(value);
    }
    return out;
}
