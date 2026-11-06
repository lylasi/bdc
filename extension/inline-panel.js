import { AUTH_EVENT } from './modules/sync-cloudflare.js';
import { t } from './modules/i18n.js';

// The frame keeps the data and editing state. The outer shell receives only
// geometry and lifecycle state through authenticated extension messages.
export function createInlinePanel(dom, captureUI, workspaceUI, { ticket, restoreQuery, initialMode = 'compact', getAuxState = () => ({}), onMode = () => {}, onClose = () => {} }) {
    let mode = initialMode;
    let capture = {}, workspace = { busy: false, hasDraft: false, message: null };
    let queryDirty = false, closing = false;
    let localNotice = null, confirmation = null, lastReport = '', scheduled = false;
    const busy = () => !!capture.busy || !!workspace.busy || !!getAuxState().busy;
    const dirty = () => queryDirty || workspace.hasDraft || !!getAuxState().hasDraft;
    const send = (message) => chrome.runtime.sendMessage({ ...message, ticket }).catch(() => null);

    function report() {
        scheduled = false;
        if (closing) return;
        const height = Math.ceil(document.body.getBoundingClientRect().height);
        const value = { type: 'BDC_INLINE_STATE', mode, height, protected: busy() || dirty() || !!confirmation };
        const fingerprint = JSON.stringify(value);
        if (fingerprint === lastReport) return;
        lastReport = fingerprint;
        send(value);
    }
    function scheduleReport() {
        if (scheduled) return;
        scheduled = true; requestAnimationFrame(report);
    }
    function render() {
        document.body.classList.toggle('ext-compact', mode === 'compact');
        document.body.classList.toggle('ext-expanded', mode === 'expanded');
        dom.more.hidden = mode !== 'compact';
        dom.back.hidden = mode === 'compact' || (['assistant', 'assistant-dock'].includes(mode) && !capture.hasResult);
        dom.more.disabled = busy();
        dom.back.disabled = busy(); dom.back.title = busy() ? t('extension.inlineFinishFirst') : '';
        dom.captureBook.disabled = busy();
        dom.actionNotice.hidden = !localNotice;
        dom.actionNotice.textContent = localNotice ? t(localNotice.key, localNotice.params || {}) : '';
        dom.confirm.hidden = !confirmation;
        if (confirmation) {
            dom.confirmText.textContent = t(busy() ? 'extension.inlineBusyClose' : confirmation.kind === 'back' ? 'extension.inlineUnsavedBack' : 'extension.inlineUnsavedClose');
            dom.discard.textContent = t(confirmation.kind === 'back' ? 'extension.inlineDiscardBack' : 'extension.inlineDiscardClose');
        }
        scheduleReport();
    }
    function setMode(value) {
        mode = value; onMode(mode); render(); report();
    }
    function cancelConfirmation() {
        const previous = confirmation; confirmation = null;
        if (previous?.requestId) send({ type: 'BDC_INLINE_CANCEL_CLOSE', requestId: previous.requestId });
        render();
    }
    function confirm(kind, requestId = '') {
        cancelConfirmation();
        confirmation = { kind, requestId };
        render(); report(); dom.keep.focus();
    }
    function close(requestId = '') {
        closing = true;
        onClose();
        send({ type: 'BDC_INLINE_CLOSED', requestId });
    }
    function requestClose(reason = 'explicit', requestId = '') {
        if (['outside', 'offscreen'].includes(reason) && (mode !== 'compact' || busy() || dirty() || confirmation)) {
            send({ type: 'BDC_INLINE_CANCEL_CLOSE', requestId }); return;
        }
        if (confirmation) {
            const previousId = confirmation.requestId;
            cancelConfirmation();
            if (requestId && requestId !== previousId) send({ type: 'BDC_INLINE_CANCEL_CLOSE', requestId });
            return;
        }
        if (busy() || dirty()) confirm('close', requestId);
        else close(requestId);
    }
    dom.more.addEventListener('click', () => setMode('expanded'));
    dom.back.addEventListener('click', () => {
        if (busy()) return;
        if (dirty()) confirm('back');
        else { document.body.classList.remove('ext-edit-query'); setMode('compact'); }
    });
    dom.close.addEventListener('click', () => requestClose());
    dom.keep.addEventListener('click', cancelConfirmation);
    dom.discard.addEventListener('click', () => {
        const action = confirmation;
        if (!action) return;
        confirmation = null;
        if (action.kind === 'back') {
            if (!workspaceUI.discardDraft()) { render(); return; }
            if (queryDirty) restoreQuery();
            queryDirty = false; document.body.classList.remove('ext-edit-query'); setMode('compact');
        } else close(action.requestId);
    });
    for (const input of dom.queryInputs) input.addEventListener('input', () => { queryDirty = true; render(); });
    dom.lookup.addEventListener('click', () => { queryDirty = false; render(); });
    window.addEventListener('keydown', (event) => {
        if (document.querySelector('dialog[open]')) return;
        if (confirmation && event.key === 'Tab') {
            event.preventDefault();
            (document.activeElement === dom.keep ? dom.discard : dom.keep).focus();
            return;
        }
        if (event.isTrusted && event.key === 'Escape') { event.preventDefault(); requestClose(); }
    });
    window.addEventListener('beforeunload', (event) => {
        if (!closing && dirty()) { event.preventDefault(); event.returnValue = ''; }
    });
    chrome.runtime.onMessage.addListener((message, sender, reply) => {
        if (sender.id !== chrome.runtime.id || message?.type !== 'BDC_INLINE_CHECK_CLOSE' || message.ticket !== ticket) return;
        requestClose(message.reason, message.requestId); reply({ ok: true });
    });
    window.addEventListener(AUTH_EVENT, () => {
        queryDirty = false; localNotice = null; confirmation = null; render(); report();
    });
    captureUI.subscribe((next) => {
        if (next.displayVersion !== capture.displayVersion || (next.selectedBookId && next.selectedBookId !== capture.selectedBookId)) localNotice = null;
        capture = next; render();
    });
    workspaceUI.subscribe((next) => { workspace = next; render(); });
    new ResizeObserver(scheduleReport).observe(document.body);
    new MutationObserver(scheduleReport).observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    render(); report();
    return { render, expand: () => setMode('expanded'), setMode, getMode: () => mode,
        clearQueryDraft() { queryDirty = false; render(); } };
}
