// Lightweight per-task model switcher.
//
// The full provider settings remain the source of truth; this picker only
// writes one task's explicit model (or clears it to follow the global default)
// and then closes. It reuses the existing options-modal / radio-card styles so
// it stays visually consistent with the rest of the app.

import { t } from './i18n.js';
import {
    getTaskModelSelection,
    getStoredTaskModel,
    getPersonalDefaultModel,
    saveTaskModelSelection,
    stringifyModelSpec
} from './ai-models.js';
import { getActiveAIScope, profileKeyForScope } from './ai-profile-storage.js';
import { AUTH_EVENT } from './sync-cloudflare.js';
import { displayMessage, escapeHtml, escapeAttr } from './ui.js';

const TASK_LABEL_KEYS = {
    wordAnalysis: 'settings.taskWord',
    articleParagraphTranslation: 'settings.taskArticleParagraph',
    articleSentenceTranslation: 'settings.taskArticleSentence',
    articleAnalysis: 'settings.taskArticle',
    articleCleanup: 'settings.taskCleanup'
};

let activePicker = null;

function taskLabel(task) {
    const key = TASK_LABEL_KEYS[task];
    return key ? t(key) : task;
}

function storedValue(task) {
    try { return stringifyModelSpec(getStoredTaskModel(task)); } catch (_) { return ''; }
}

function availableModels(task) {
    try {
        return (getTaskModelSelection(task).options || []).filter((option) => (
            option && !option.unavailable && String(option.value || '').trim()
        ));
    } catch (_) {
        return [];
    }
}

function currentModelLabel(task, models) {
    let effective = '';
    try { effective = stringifyModelSpec(getTaskModelSelection(task).value); } catch (_) { /* noop */ }
    if (!effective) {
        try { effective = stringifyModelSpec(getPersonalDefaultModel()); } catch (_) { /* noop */ }
    }
    if (!effective) return '';
    const option = models.find((model) => model.value === effective);
    return option ? (option.label || option.value) : effective;
}

function currentScopeKey() {
    try { return profileKeyForScope(getActiveAIScope()); } catch (_) { return ''; }
}

function trapTab(event, overlay) {
    const all = [...overlay.querySelectorAll('button, input, select, textarea, [href], [tabindex]')]
        .filter((element) => !element.disabled && element.tabIndex >= 0 && element.getClientRects().length);
    if (!all.length) return;
    // A radio group is one Tab stop: only its checked (or first) radio belongs
    // at the boundary. Treating every radio as tabbable let Shift+Tab escape
    // the dialog when a non-first radio was checked.
    const radios = all.filter((element) => element.matches('input[type="radio"]'));
    const checkedRadio = radios.find((element) => element.checked) || radios[0];
    const targets = all.filter((element) => (
        !element.matches('input[type="radio"]') || element === checkedRadio
    ));
    if (!targets.length) return;
    const first = targets[0];
    const last = targets.at(-1);
    if (event.shiftKey && (document.activeElement === first || !overlay.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !overlay.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
    }
}

/**
 * Open the compact model picker.
 *
 * @param {Object} config
 * @param {string[]} config.tasks           Task keys this picker can switch between.
 * @param {string}   [config.initialTask]   Task shown first.
 * @param {string}   [config.titleKey]      i18n key for the dialog title.
 * @param {Function} [config.returnFocus]   Resolves the element to focus after close.
 * @returns {HTMLElement|null} the overlay element, or null when no task was given.
 */
export function openQuickModelPicker({ tasks = [], initialTask = '', titleKey = '', returnFocus = null } = {}) {
    const taskList = [...new Set((Array.isArray(tasks) ? tasks : [tasks])
        .map((task) => String(task || '').trim())
        .filter(Boolean))];
    if (!taskList.length) return null;

    // A second click on a picker icon should not stack dialogs (or leak the
    // first dialog's listeners).
    try { activePicker?.close?.(); } catch (_) { /* noop */ }

    let currentTask = taskList.includes(initialTask) ? initialTask : taskList[0];
    let closed = false;
    const previousFocus = document.activeElement;
    const openedScopeKey = currentScopeKey();

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay options-modal-overlay quick-model-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'quick-model-title');
    overlay.dataset.currentTask = currentTask;

    const close = () => {
        if (closed) return;
        closed = true;
        document.removeEventListener('keydown', onKeydown, true);
        window.removeEventListener(AUTH_EVENT, onAuthChange);
        overlay.remove();
        if (activePicker === handle) activePicker = null;
        const requested = typeof returnFocus === 'function' ? returnFocus() : null;
        const target = requested?.isConnected ? requested
            : (previousFocus?.isConnected ? previousFocus : null);
        if (target && !target.closest?.('[inert]')) target.focus({ preventScroll: true });
    };

    function onAuthChange() {
        // A dialog opened for one account must never write into another.
        close();
    }

    function onKeydown(event) {
        // A newer options dialog may have opened above this one; let it own
        // Escape/Tab instead of closing the wrong layer.
        if ([...document.querySelectorAll('.options-modal-overlay')].at(-1) !== overlay) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopImmediatePropagation();
            close();
            return;
        }
        if (event.key === 'Tab') trapTab(event, overlay);
    }

    function render({ focus = 'selection' } = {}) {
        const models = availableModels(currentTask);
        const stored = storedValue(currentTask);
        const storedAvailable = models.some((model) => model.value === stored);
        const storedUnavailable = !!stored && !storedAvailable;
        const selected = storedAvailable || storedUnavailable ? stored : '';
        const hasChoices = models.length > 0 || storedUnavailable;
        const effectiveLabel = currentModelLabel(currentTask, models);
        const title = t(titleKey || 'quickModel.title');
        overlay.dataset.currentTask = currentTask;

        overlay.innerHTML = `
            <div class="modal-content options-modal-content quick-model-modal">
                <div class="modal-header">
                    <h3 id="quick-model-title">${escapeHtml(title)}</h3>
                    <p class="om-desc">${escapeHtml(t('quickModel.description'))}</p>
                    ${taskList.length > 1 ? `<div class="quick-model-task-tabs" role="group" aria-label="${escapeAttr(t('quickModel.taskLabel'))}">
                        ${taskList.map((task) => `<button type="button" class="quick-model-task" data-quick-task="${escapeAttr(task)}" aria-pressed="${task === currentTask}">${escapeHtml(taskLabel(task))}</button>`).join('')}
                    </div>` : ''}
                    ${effectiveLabel ? `<p class="quick-model-current">${escapeHtml(t('quickModel.currentModel', { model: effectiveLabel }))}</p>` : ''}
                </div>
                <div class="modal-body">
                    ${hasChoices ? `<div class="radio-group quick-model-list" role="radiogroup" aria-label="${escapeAttr(t('quickModel.modelLabel'))}">
                        <label class="radio-card">
                            <input type="radio" name="quick-model-choice" value="" data-quick-model-value ${selected === '' ? 'checked' : ''}>
                            <div><div class="om-option-title">${escapeHtml(t('quickModel.followDefault'))}</div></div>
                        </label>
                        ${storedUnavailable ? `<label class="radio-card quick-model-unavailable">
                            <input type="radio" name="quick-model-choice" value="${escapeAttr(stored)}" data-quick-model-value checked disabled>
                            <div>
                                <div class="om-option-title">${escapeHtml(stored)}</div>
                                <div class="quick-model-note">${escapeHtml(t('quickModel.currentUnavailable', { model: stored }))}</div>
                            </div>
                        </label>` : ''}
                        ${models.map((model) => `<label class="radio-card">
                            <input type="radio" name="quick-model-choice" value="${escapeAttr(model.value)}" data-quick-model-value ${selected === model.value ? 'checked' : ''}>
                            <div><div class="om-option-title">${escapeHtml(model.label || model.value)}</div></div>
                        </label>`).join('')}
                    </div>` : `<p class="quick-model-empty" role="status">${escapeHtml(t('quickModel.noModels'))}</p>`}
                    ${hasChoices && !models.length ? `<p class="quick-model-empty" role="status">${escapeHtml(t('quickModel.noModels'))}</p>` : ''}
                </div>
                <div class="modal-footer modal-actions">
                    <button type="button" class="btn-secondary cancel-btn" data-quick-action="cancel">${escapeHtml(t('common.cancel'))}</button>
                    <button type="button" class="btn-primary save-btn" data-quick-action="confirm" ${hasChoices ? '' : 'disabled'}>${escapeHtml(t('common.confirm'))}</button>
                </div>
            </div>`;

        requestAnimationFrame(() => {
            if (closed) return;
            if (focus === 'task') {
                overlay.querySelector(`[data-quick-task="${CSS.escape(currentTask)}"]`)?.focus({ preventScroll: true });
            } else {
                (overlay.querySelector('[data-quick-model-value]:checked:not(:disabled)')
                    || overlay.querySelector('[data-quick-task][aria-pressed="true"]')
                    || overlay.querySelector('[data-quick-action="cancel"]'))?.focus({ preventScroll: true });
            }
        });
    }

    function confirm() {
        // Re-check the scope and the model list at confirmation time: another
        // tab may have switched accounts or the catalog may have changed while
        // this dialog was open.
        if (currentScopeKey() !== openedScopeKey) {
            displayMessage(t('quickModel.accountChanged'), 'error');
            close();
            return;
        }
        const models = availableModels(currentTask);
        const stored = storedValue(currentTask);
        const storedUnavailable = !!stored && !models.some((model) => model.value === stored);
        const choice = overlay.querySelector('[data-quick-model-value]:checked');
        const value = choice ? choice.value : '';
        if (value && !models.some((model) => model.value === value) && value !== stored) {
            displayMessage(t('quickModel.modelGone'), 'error');
            render();
            return;
        }
        if (!models.length && !storedUnavailable && value !== '') return;
        const option = models.find((model) => model.value === value);
        const label = value ? ((option && option.label) || value) : t('quickModel.followDefault');
        try {
            saveTaskModelSelection(currentTask, value);
        } catch (error) {
            displayMessage(`${t('settings.saveFailed')}${error && error.code ? error.code : ''}`, 'error');
            return;
        }
        close();
        displayMessage(t('quickModel.saved', { model: label }), 'success');
    }

    overlay.addEventListener('click', (event) => {
        // Keep document-level "click outside" handlers from closing the word
        // tooltip underneath the dialog; backdrop clicks are handled here.
        event.stopPropagation();
        const taskButton = event.target.closest?.('[data-quick-task]');
        if (taskButton) {
            const next = taskButton.getAttribute('data-quick-task');
            if (next && next !== currentTask && taskList.includes(next)) {
                currentTask = next;
                render({ focus: 'task' });
            }
            return;
        }
        const action = event.target.closest?.('[data-quick-action]')?.getAttribute('data-quick-action');
        if (action === 'confirm') {
            confirm();
            return;
        }
        if (action === 'cancel') {
            close();
            return;
        }
        if (event.target === overlay) close();
    });

    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKeydown, true);
    window.addEventListener(AUTH_EVENT, onAuthChange);
    render();

    const handle = { overlay, close };
    activePicker = handle;
    return overlay;
}
