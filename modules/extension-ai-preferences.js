// Non-secret, extension-only choices. Never write them into the cloud profile:
// opening another lookup frame pulls that profile again, and must not erase the
// user's extension choices or publish them as changes to the main site's AI.
import { getActiveAIScope } from './ai-profile-storage.js';
import { getAuthSnapshot } from './sync-cloudflare.js';
import { isThinkingLevel } from './ai-thinking.js';

export const EXTENSION_AI_PREFERENCES_PREFIX = 'bdc_extension_ai_preferences_v1:';
export const EXTENSION_AI_TASKS = ['wordAnalysis', 'articleWordTranslation', 'articlePhraseTranslation', 'articleCleanup', 'articleParagraphTranslation', 'assistant'];

function preferenceKey() {
    const scope = getActiveAIScope();
    if (!getAuthSnapshot().loggedIn || scope.guest) return '';
    return EXTENSION_AI_PREFERENCES_PREFIX + JSON.stringify([scope.endpoint, scope.userId]);
}

function normalizePreferences(value) {
    const tasks = {};
    for (const task of EXTENSION_AI_TASKS) {
        const input = value?.[task];
        if (!input || typeof input !== 'object' || Array.isArray(input)) continue;
        const choice = {};
        if (typeof input.model === 'string' && input.model.trim() && input.model.length <= 1024) choice.model = input.model.trim();
        if (isThinkingLevel(input.thinking)) choice.thinking = input.thinking.trim().toLowerCase();
        if (Object.keys(choice).length) tasks[task] = choice;
    }
    return tasks;
}

export function getExtensionAIPreferences() {
    const key = preferenceKey();
    if (!key) return {};
    let tasks = {};
    // Read the preview format for compatibility. New writes are per field so
    // independent browser pages never replace another task/field's choices.
    try { tasks = normalizePreferences(JSON.parse(localStorage.getItem(key) || '{}')); }
    catch (_) {}
    for (const task of EXTENSION_AI_TASKS) {
        for (const field of ['model', 'thinking']) {
            try {
                const raw = localStorage.getItem(`${key}:${task}:${field}`);
                if (raw === null) continue;
                const choice = normalizePreferences(JSON.parse(raw))[task] || {};
                if (!tasks[task]) tasks[task] = {};
                // An empty record is a reset marker, including for preview data.
                if (Object.hasOwn(choice, field)) tasks[task][field] = choice[field];
                else delete tasks[task][field];
            } catch (_) {}
        }
    }
    return normalizePreferences(tasks);
}

export function getExtensionAIChoice(task) {
    return getExtensionAIPreferences()[task] || {};
}

// Callers validate the model against the shared task allowlist before saving.
// Each field has its own key: localStorage read/modify/write across separate
// renderer processes is not atomic. A failure must never show a success notice.
export function saveExtensionAIChoice(task, patch) {
    const key = preferenceKey();
    if (!key || !EXTENSION_AI_TASKS.includes(task)) {
        throw Object.assign(new Error('stale_session'), { code: 'stale_session' });
    }
    const choice = normalizePreferences({ [task]: patch })[task] || {};
    const fields = patch === null ? ['model', 'thinking'] : Object.keys(patch).filter((field) => field === 'model' || field === 'thinking');
    try {
        for (const field of fields) {
            const fieldKey = `${key}:${task}:${field}`;
            const serialized = JSON.stringify({ [task]: Object.hasOwn(choice, field) ? { [field]: choice[field] } : {} });
            localStorage.setItem(fieldKey, serialized);
            if (localStorage.getItem(fieldKey) !== serialized) throw new Error('not persisted');
        }
    } catch (cause) {
        throw Object.assign(new Error('profile_save_failed'), { code: 'profile_save_failed', cause });
    }
    return getExtensionAIChoice(task);
}
