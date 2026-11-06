import { t } from './modules/i18n.js';
import {
    getExtensionAITaskSettings,
    setExtensionAITaskSettings,
    resetExtensionAITaskSettings
} from './modules/extension-ai-runtime.js';
import { THINKING_LEVELS } from './modules/ai-thinking.js';

const thinkingKeys = {
    auto: 'settings.aiThinkingAuto', none: 'settings.aiThinkingNone',
    low: 'settings.aiThinkingLow', medium: 'settings.aiThinkingMedium', high: 'settings.aiThinkingHigh'
};

function element(tag, attributes = {}, parent) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    parent?.appendChild(node);
    return node;
}

function options(select, items, value) {
    // Preserve focus and native select interaction during unrelated updates.
    const fingerprint = JSON.stringify(items);
    if (select.dataset.options !== fingerprint) {
        select.replaceChildren(...items.map((item) => {
            const option = element('option', { value: item.value });
            option.textContent = item.label;
            option.disabled = !!item.unavailable;
            return option;
        }));
        select.dataset.options = fingerprint;
    }
    select.value = value;
}

export function createAIControls({ embedded, onChange, onLookup }) {
    const root = element('details', { id: 'ext-ai-controls', class: 'ext-ai-controls' });
    const summary = element('summary', {}, root);
    const label = element('span', { class: 'ext-ai-summary-label' }, summary);
    const summaryValue = element('span', { class: 'ext-ai-summary-value' }, summary);
    const grid = element('div', { class: 'ext-ai-grid' }, root);
    function field(id) {
        const wrapper = element('div', { class: 'ext-field' }, grid);
        const label = element('label', { for: id }, wrapper);
        const select = element('select', { id }, wrapper);
        return { label, select };
    }
    const taskField = field('ext-ai-task');
    const modelField = field('ext-ai-model');
    const thinkingField = field('ext-ai-thinking');
    const hint = element('p', { class: 'ext-status-line ext-ai-hint' }, root);
    const notice = element('p', { id: 'ext-ai-notice', class: 'ext-notice', role: 'status', 'aria-live': 'polite', hidden: '' }, root);
    const actions = element('div', { class: 'ext-row ext-ai-actions' }, root);
    const requery = element('button', { id: 'ext-ai-requery', type: 'button', class: 'ext-btn ext-btn-primary' }, actions);
    const reset = element('button', { id: 'ext-ai-reset', type: 'button', class: 'ext-btn' }, actions);
    // 设定弹窗插槽优先：#ext-ai-settings-slot 内直接展开显示选项；
    // 旧版面（工具列／表头之后）保留为回退，避免并行改动期间版面空白。
    const slot = document.querySelector('#ext-ai-settings-slot');
    const anchor = slot || document.querySelector(embedded ? '#ext-inline-toolbar' : '.ext-header');
    if (slot) {
        anchor.appendChild(root);
        root.open = true;
    } else {
        anchor.insertAdjacentElement('afterend', root);
    }
    const fallback = element('p', { id: 'ext-ai-fallback', class: 'ext-notice ext-notice-info', role: 'status', 'aria-live': 'polite', hidden: '' });
    if (slot) slot.appendChild(fallback);
    else root.insertAdjacentElement('afterend', fallback);

    let selectedTask = 'lookup', lastReadiness = null, lastScope = '', lastState = {}, lastNotice = null, fallbackModel = '';
    const currentTask = () => selectedTask === 'lookup' ? lastReadiness.taskResolution.task : selectedTask;
    function render(readiness = lastReadiness, state = lastState) {
        if (!readiness) return;
        lastReadiness = readiness; lastState = state;
        const scope = readiness.loggedIn ? readiness.scope.key : '';
        if (scope !== lastScope) {
            lastScope = scope; selectedTask = 'lookup'; lastNotice = null; fallbackModel = '';
            if (!slot) root.open = false;
        }
        const settings = getExtensionAITaskSettings(currentTask());
        label.textContent = t('extension.aiOptions');
        const selectedOption = settings.options.find((option) => option.value === settings.model);
        const name = selectedOption?.unavailable ? selectedOption.label : (settings.model.slice(settings.model.indexOf(':') + 1) || t('extension.aiChooseModel'));
        summaryValue.textContent = name + ' · ' + t(thinkingKeys[settings.thinking]);
        summary.title = t(selectedTask === 'lookup' ? 'extension.aiCurrentLookup' : selectedTask === 'assistant' ? 'extension.assistantTitle' : selectedTask === 'articleCleanup' ? 'extension.aiArticleExtraction' : 'settings.taskArticleParagraph') + ' · ' + (selectedOption?.label || name);
        taskField.label.textContent = t('extension.aiTaskLabel');
        modelField.label.textContent = t('extension.aiModelLabel');
        thinkingField.label.textContent = t('settings.aiThinkingLabel');
        options(taskField.select, [
            { value: 'lookup', label: t('extension.aiCurrentLookup') },
            { value: 'articleCleanup', label: t('extension.aiArticleExtraction') },
            { value: 'articleParagraphTranslation', label: t('settings.taskArticleParagraph') },
            { value: 'assistant', label: t('extension.assistantTitle') }
        ], selectedTask);
        options(modelField.select, settings.options, settings.model);
        options(thinkingField.select, THINKING_LEVELS.map((value) => ({ value, label: t(thinkingKeys[value]) })), settings.thinking);
        taskField.select.disabled = !settings.loggedIn;
        modelField.select.disabled = !settings.loggedIn || !settings.allowedValues.length;
        thinkingField.select.disabled = !settings.loggedIn;
        hint.textContent = t('extension.aiPreferencesHint');
        notice.hidden = !lastNotice;
        notice.textContent = lastNotice ? t(lastNotice.key) : '';
        notice.classList.toggle('ext-notice-error', lastNotice?.error === true);
        requery.textContent = t('extension.aiRequery');
        requery.hidden = selectedTask !== 'lookup';
        requery.disabled = !settings.loggedIn || state.busy || !state.hasQuery;
        reset.textContent = t('extension.aiReset');
        reset.disabled = !settings.loggedIn || !settings.hasOverride;
        fallback.hidden = !fallbackModel;
        fallback.textContent = fallbackModel ? t('extension.aiThinkingFallback', { model: fallbackModel }) : '';
    }
    function change(patch) {
        try {
            setExtensionAITaskSettings(currentTask(), patch);
            lastNotice = { key: 'extension.aiSaved' };
        } catch (error) {
            lastNotice = { key: error.code === 'profile_save_failed' ? 'extension.aiSaveFailed' : 'extension.aiChoiceUnavailable', error: true };
        }
        onChange(); render();
    }
    taskField.select.addEventListener('change', () => { selectedTask = taskField.select.value; lastNotice = null; render(); });
    modelField.select.addEventListener('change', () => change({ model: modelField.select.value }));
    thinkingField.select.addEventListener('change', () => change({ thinking: thinkingField.select.value }));
    reset.addEventListener('click', () => {
        try { resetExtensionAITaskSettings(currentTask()); lastNotice = { key: 'extension.aiResetDone' }; }
        catch (_) { lastNotice = { key: 'extension.aiSaveFailed', error: true }; }
        onChange(); render();
    });
    requery.addEventListener('click', () => onLookup());
    return {
        render,
        notifyThinkingFallback(detail) { fallbackModel = String(detail?.model || ''); render(); },
        clearFallback() { fallbackModel = ''; fallback.hidden = true; }
    };
}
