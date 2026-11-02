// Read-only thinking-mode guide shared by full settings and quick model pickers.
import { THINKING_LEVELS } from './ai-thinking.js';
import { t } from './i18n.js';

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
}

const LABEL_KEYS = {
    auto: 'settings.aiThinkingAuto',
    none: 'settings.aiThinkingNone',
    low: 'settings.aiThinkingLow',
    medium: 'settings.aiThinkingMedium',
    high: 'settings.aiThinkingHigh'
};

export function renderThinkingHelp({ includeAppDefault = false } = {}) {
    const guidance = {
        auto: ['settings.aiThinkingHelpAutoDescription', 'settings.aiThinkingHelpAutoUse', 0],
        none: ['settings.aiThinkingHelpNoneDescription', 'settings.aiThinkingHelpNoneUse', 0],
        low: ['settings.aiThinkingHelpLowDescription', 'settings.aiThinkingHelpLowUse', 1],
        medium: ['settings.aiThinkingHelpMediumDescription', 'settings.aiThinkingHelpMediumUse', 2],
        high: ['settings.aiThinkingHelpHighDescription', 'settings.aiThinkingHelpHighUse', 3]
    };
    const rows = THINKING_LEVELS.map((level) => {
        const [descriptionKey, useKey, strength] = guidance[level];
        const meter = level === 'auto' ? '?' : level === 'none' ? '−'
            : [1, 2, 3].map((step) => `<span${step <= strength ? ' class="is-active"' : ''}></span>`).join('');
        return `<div class="gs-ai-thinking-guide-row" data-thinking-help-level="${level}">
            <dt><span class="gs-ai-thinking-meter gs-ai-thinking-meter--${level}" aria-hidden="true">${meter}</span><span>${escapeHtml(t(LABEL_KEYS[level]))}</span></dt>
            <dd>${escapeHtml(t(descriptionKey))}</dd>
            <dd class="gs-ai-thinking-guide-use">${escapeHtml(t(useKey))}</dd>
        </div>`;
    }).join('');
    return `<details class="gs-ai-thinking-help" data-keep-open="ai-thinking-help">
        <summary title="${escapeHtml(t('settings.aiThinkingHelpToggleHint'))}">
            <svg class="gs-ai-thinking-help-icon" aria-hidden="true"><use href="#ic-info"/></svg>
            <span>${escapeHtml(t('settings.aiThinkingHelpLabel'))}</span>
        </summary>
        <figure class="gs-ai-thinking-guide">
            <figcaption>${escapeHtml(t('settings.aiThinkingHelpTitle'))}</figcaption>
            <p>${escapeHtml(t('settings.aiThinkingHelpIntro'))}</p>
            <dl class="gs-ai-thinking-guide-rows">${rows}</dl>
            <div class="gs-ai-thinking-guide-notes">
                ${includeAppDefault ? `<p>${escapeHtml(t('settings.aiThinkingHelpAppDefault'))}</p>` : ''}
                <p>${escapeHtml(t('settings.aiThinkingHelpCaveat'))}</p>
                <p>${escapeHtml(t('settings.aiThinkingHelpDisplayHint'))}</p>
            </div>
        </figure>
    </details>`;
}
