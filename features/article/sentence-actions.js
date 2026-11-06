import * as dom from '../../modules/dom.js';
import { t } from '../../modules/i18n.js';

const LABELS = {
    once: ['article.readSentence', 'article.stopSentence'],
    continue: ['article.readFromHere', 'article.stopFromHere'],
    loop: ['article.loopSentence', 'article.stopLoopSentence'],
    analyze: ['article.sentenceAnalysis']
};

let handlers;
let menuTarget = null;
let quickTarget = null;
let hideTimer;

function targetFor(trigger) {
    const sentence = trigger?.closest('.sentence-wrap')?.querySelector('.interactive-sentence');
    return sentence ? { trigger, sentence } : null;
}

function position(element, trigger, preferAbove = false) {
    const anchor = trigger.getBoundingClientRect();
    const width = document.documentElement.clientWidth;
    const height = window.innerHeight;
    const box = element.getBoundingClientRect();
    const above = anchor.top - box.height - 8;
    const below = anchor.bottom + 8;
    const top = (preferAbove || below + box.height > height - 8) && above >= 8 ? above : below;
    element.style.left = `${Math.max(8, Math.min(width - box.width - 8, anchor.right - box.width))}px`;
    element.style.top = `${Math.max(8, Math.min(height - box.height - 8, top))}px`;
}

function hideQuick() {
    clearTimeout(hideTimer);
    dom.articleSentenceQuickRead.classList.add('hidden');
    quickTarget = null;
    handlers?.onQuickHide();
}

export function closeSentenceActions({ restoreFocus = false } = {}) {
    const trigger = menuTarget?.trigger;
    if (trigger?.isConnected) trigger.setAttribute('aria-expanded', 'false');
    dom.articleSentenceMenu.classList.add('hidden');
    menuTarget = null;
    hideQuick();
    if (restoreFocus && trigger?.isConnected) trigger.focus({ preventScroll: true });
}

export function refreshSentenceActions() {
    const menu = dom.articleSentenceMenu;
    menu.setAttribute('aria-label', t('article.sentenceActions'));
    const unavailable = menuTarget ? handlers.readUnavailableReason(menuTarget.sentence) : '';
    const hint = menu.querySelector('.article-sentence-menu-hint');
    hint.textContent = unavailable ? t(unavailable) : '';
    hint.classList.toggle('hidden', !unavailable);
    menu.querySelectorAll('[data-sentence-action]').forEach((button) => {
        const action = button.dataset.sentenceAction;
        const active = action !== 'analyze' && !!menuTarget && handlers.isActive(menuTarget.sentence, action);
        button.querySelector('span').textContent = t(LABELS[action][active ? 1 : 0]);
        button.classList.toggle('is-active', active);
        button.disabled = action !== 'analyze' && !active && !!unavailable;
        button.title = button.disabled ? t(unavailable) : '';
    });
    const quick = dom.articleSentenceQuickRead;
    const active = !!quickTarget && handlers.isActive(quickTarget.sentence, 'once');
    quick.title = t(active ? 'article.stopSentence' : 'article.readSentence');
    quick.setAttribute('aria-label', quick.title);
    quick.querySelector('use').setAttribute('href', active ? '#ic-stop' : '#ic-speaker');
    if (menuTarget && !menu.classList.contains('hidden')) position(menu, menuTarget.trigger);
}

export function openSentenceActions(trigger, { keyboard = false } = {}) {
    if (menuTarget?.trigger === trigger) {
        closeSentenceActions({ restoreFocus: keyboard });
        return;
    }
    closeSentenceActions();
    menuTarget = targetFor(trigger);
    if (!menuTarget) return;
    handlers.onOpen();
    refreshSentenceActions();
    trigger.setAttribute('aria-expanded', 'true');
    dom.articleSentenceMenu.classList.remove('hidden');
    position(dom.articleSentenceMenu, trigger);
    if (keyboard) dom.articleSentenceMenu.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
}

/** One shared floating menu; the sentence keeps its original single inline button. */
export function initSentenceActions(callbacks) {
    handlers = callbacks;
    const menu = dom.articleSentenceMenu;
    const quick = dom.articleSentenceQuickRead;
    menu.addEventListener('click', (event) => {
        const button = event.target.closest('[data-sentence-action]');
        const target = menuTarget;
        if (!button || button.disabled || !target) return;
        const action = button.dataset.sentenceAction;
        closeSentenceActions({ restoreFocus: true });
        if (!target.sentence.isConnected) return;
        if (action === 'analyze') handlers.analyze(target.sentence);
        else handlers.read(target.sentence, action);
    });
    menu.addEventListener('keydown', (event) => {
        const buttons = [...menu.querySelectorAll('button:not(:disabled)')];
        const index = buttons.indexOf(document.activeElement);
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            event.preventDefault();
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
                : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
            buttons[next]?.focus({ preventScroll: true });
        } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            closeSentenceActions({ restoreFocus: true });
        } else if (event.key === 'Tab') {
            const trigger = menuTarget?.trigger;
            const controls = [...dom.articleSection.querySelectorAll('button, a[href], input, select, textarea, summary, [tabindex]')]
                .filter((element) => element.tabIndex >= 0 && !element.disabled && element.getClientRects().length
                    && getComputedStyle(element).visibility === 'visible' && !element.closest('[inert]'));
            const next = controls[controls.indexOf(trigger) + (event.shiftKey ? -1 : 1)];
            closeSentenceActions({ restoreFocus: !next });
            if (next) {
                event.preventDefault();
                next.focus({ preventScroll: true });
            }
        }
    });
    quick.addEventListener('click', () => {
        const target = quickTarget;
        hideQuick();
        if (target?.sentence.isConnected) handlers.read(target.sentence, 'once');
    });
    const showQuick = (event) => {
        if (menuTarget || event.pointerType === 'touch' || !window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
        const wrap = event.target.closest('.sentence-wrap');
        const trigger = wrap?.querySelector('.sent-analyze-btn');
        if (!trigger) return;
        const target = targetFor(trigger);
        if (!target || handlers.readUnavailableReason(target.sentence)) return;
        clearTimeout(hideTimer);
        quickTarget = target;
        refreshSentenceActions();
        quick.classList.remove('hidden');
        position(quick, trigger, true);
        // Keep the existing translation hint visible without putting a button over it.
        const hint = handlers.hintBounds();
        if (hint) {
            const box = quick.getBoundingClientRect();
            const width = document.documentElement.clientWidth;
            const left = hint.right + box.width + 14 <= width ? hint.right + 6 : Math.max(8, hint.left - box.width - 6);
            quick.style.left = `${left}px`;
            quick.style.top = `${Math.max(8, Math.min(innerHeight - box.height - 8, hint.top))}px`;
        }
    };
    const scheduleHide = (event) => {
        const to = event.relatedTarget;
        if (to && (quick.contains(to) || quickTarget?.trigger.closest('.sentence-wrap')?.contains(to))) return;
        clearTimeout(hideTimer);
        hideTimer = setTimeout(hideQuick, 200);
    };
    dom.articleAnalysisContainer.addEventListener('mouseover', showQuick);
    dom.articleAnalysisContainer.addEventListener('focusin', showQuick);
    dom.articleAnalysisContainer.addEventListener('pointerout', scheduleHide);
    dom.articleAnalysisContainer.addEventListener('focusout', scheduleHide);
    quick.addEventListener('pointerenter', () => clearTimeout(hideTimer));
    quick.addEventListener('pointerleave', scheduleHide);
    dom.articleAnalysisContainer.addEventListener('keydown', (event) => {
        const trigger = event.target.closest('.sent-analyze-btn');
        if (trigger && event.key === 'ArrowDown') {
            event.preventDefault();
            if (menuTarget?.trigger === trigger) menu.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
            else openSentenceActions(trigger, { keyboard: true });
        }
    });
    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || !menuTarget) return;
        event.preventDefault();
        event.stopPropagation();
        closeSentenceActions({ restoreFocus: true });
    }, { capture: true });
    document.addEventListener('pointerdown', (event) => {
        if (menu.contains(event.target) || quick.contains(event.target) || menuTarget?.trigger.contains(event.target)) return;
        closeSentenceActions();
    });
    let scrollFrame = 0;
    window.addEventListener('scroll', () => {
        if (!menuTarget) { hideQuick(); return; }
        if (scrollFrame) return;
        scrollFrame = requestAnimationFrame(() => {
            scrollFrame = 0;
            if (!menuTarget) return;
            const trigger = menuTarget.trigger;
            const rect = trigger.getBoundingClientRect();
            if (!trigger.isConnected || rect.bottom <= 0 || rect.top >= innerHeight
                || rect.right <= 0 || rect.left >= document.documentElement.clientWidth) closeSentenceActions();
            else position(menu, trigger);
        });
    }, { passive: true, capture: true });
    window.addEventListener('resize', () => closeSentenceActions());
    document.addEventListener('bdc:article-loaded', () => closeSentenceActions());
    window.addEventListener('hashchange', () => closeSentenceActions());
    document.addEventListener('bdc:locale-change', refreshSentenceActions);
    refreshSentenceActions();
}
