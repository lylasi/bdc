import { t } from './i18n.js';

function escapeHtml(value) {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Candidates and enabled IDs are separate: deselection must never discard a model.
function candidates(models) {
    const unique = new Map();
    for (const model of models || []) {
        const id = String(typeof model === 'string' ? model : model?.id || '').trim();
        if (id && !unique.has(id)) unique.set(id, { id, label: model.label || id });
    }
    return [...unique.values()];
}

function contents({ models, selected, state }) {
    const rows = candidates(models);
    const enabled = new Set(selected);
    const query = String(state.query || '').trim().toLowerCase();
    const visible = rows.filter((model) => (!state.selectedOnly || enabled.has(model.id))
        && `${model.id} ${model.label}`.toLowerCase().includes(query));
    return `<div class="ai-model-picker-header">
        <div class="ai-model-picker-tabs" role="group" aria-label="${escapeHtml(t('settings.aiPickerView'))}">
            <button type="button" data-picker-view="all" aria-pressed="${!state.selectedOnly}">${escapeHtml(t('settings.aiPickerAll'))}</button>
            <button type="button" data-picker-view="selected" aria-pressed="${!!state.selectedOnly}">${escapeHtml(t('settings.aiPickerSelected'))}</button>
        </div>
        <span class="gs-ai-muted" aria-live="polite">${escapeHtml(t('settings.aiPickerCount', { selected: rows.filter((row) => enabled.has(row.id)).length, total: rows.length }))}</span>
    </div>
    <div class="ai-model-picker-toolbar">
        <input type="search" data-picker-search value="${escapeHtml(state.query || '')}" placeholder="${escapeHtml(t('settings.aiPickerSearch', { count: rows.length }))}" aria-label="${escapeHtml(t('settings.aiPickerSearchLabel'))}">
        <button type="button" class="btn-secondary gs-ai-small" data-picker-bulk="all" ${visible.length ? '' : 'disabled'}>${escapeHtml(t('settings.aiPickerSelectVisible'))}</button>
        <button type="button" class="btn-secondary gs-ai-small" data-picker-bulk="none" ${visible.length ? '' : 'disabled'}>${escapeHtml(t('settings.aiPickerClearVisible'))}</button>
    </div>
    <div class="ai-model-picker-list" role="group" aria-label="${escapeHtml(t('settings.aiModelChoice'))}">
        ${visible.map((model) => `<button type="button" class="ai-model-option" data-picker-model="${escapeHtml(model.id)}" aria-pressed="${enabled.has(model.id)}" title="${escapeHtml(model.id)}"><span class="ai-model-option-check" aria-hidden="true">${enabled.has(model.id) ? '✓' : '+'}</span><span>${escapeHtml(model.label)}</span></button>`).join('')}
        ${visible.length ? '' : `<p class="gs-hint" role="status">${escapeHtml(t(state.selectedOnly && !selected.length ? 'settings.aiPickerNoneSelected' : 'settings.aiPickerNoMatch'))}</p>`}
    </div>
    <p class="gs-hint ai-model-picker-hint">${escapeHtml(t('settings.aiPickerHint'))}</p>`;
}

export function renderModelPicker({ id, models, selected, state = {} }) {
    return `<div class="ai-model-picker" data-model-picker="${escapeHtml(id)}">${contents({ models, selected, state })}</div>`;
}

export function bindModelPicker(host, { id, models, selected, state = {}, onChange }) {
    const selector = `[data-model-picker="${CSS.escape(id)}"]`;
    const root = host.querySelector(selector);
    if (!root) return;
    const rows = candidates(models);
    let enabled = new Set(selected);
    const listScroll = () => root.querySelector('.ai-model-picker-list')?.scrollTop || 0;
    const redraw = ({ keepScroll = false } = {}) => {
        const top = keepScroll ? listScroll() : 0;
        root.innerHTML = contents({ models: rows, selected: [...enabled], state });
        const list = root.querySelector('.ai-model-picker-list');
        if (list) list.scrollTop = top;
        if (keepScroll) state.scrollTop = top;
    };
    // 外層面板可能整塊重繪（例如選完模型後 owner 重新 render），
    // 這裡把清單捲動位置放進 state，讓新實例接回同一個位置。
    const initial = root.querySelector('.ai-model-picker-list');
    if (initial && Number(state.scrollTop) > 0) initial.scrollTop = Number(state.scrollTop);
    root.addEventListener('scroll', (event) => {
        if (event.target && event.target.matches?.('.ai-model-picker-list')) state.scrollTop = event.target.scrollTop;
    }, true);
    root.addEventListener('input', (event) => {
        if (!event.target.matches('[data-picker-search]')) return;
        state.query = event.target.value;
        const start = event.target.selectionStart;
        redraw();
        const search = root.querySelector('[data-picker-search]');
        search.focus({ preventScroll: true });
        if (start != null) search.setSelectionRange(start, start);
    });
    root.addEventListener('click', (event) => {
        const button = event.target.closest('button');
        if (!button || !root.contains(button)) return;
        let focusSelector;
        if (button.hasAttribute('data-picker-view')) {
            state.selectedOnly = button.dataset.pickerView === 'selected';
            focusSelector = `[data-picker-view="${button.dataset.pickerView}"]`;
            redraw();
        } else {
            if (button.hasAttribute('data-picker-model')) {
                const model = button.dataset.pickerModel;
                if (enabled.has(model)) enabled.delete(model);
                else enabled.add(model);
                focusSelector = `[data-picker-model="${CSS.escape(model)}"]`;
            } else if (button.hasAttribute('data-picker-bulk')) {
                const visible = [...root.querySelectorAll('[data-picker-model]')].map((item) => item.dataset.pickerModel);
                for (const model of visible) {
                    if (button.dataset.pickerBulk === 'all') enabled.add(model);
                    else enabled.delete(model);
                }
                focusSelector = `[data-picker-bulk="${button.dataset.pickerBulk}"]`;
            } else return;
            const next = rows.filter((row) => enabled.has(row.id)).map((row) => row.id);
            enabled = new Set(next);
            // 只在勾選／取消模型時保留捲動位置；切換檢視或篩選要回到頂部。
            redraw({ keepScroll: true });
            onChange(next);
        }
        // The owner may rebuild its form after a selection. Keep keyboard focus.
        const current = host.querySelector(selector);
        (current?.querySelector(focusSelector) || current?.querySelector('[data-picker-search]'))?.focus({ preventScroll: true });
    });
}
