import { captureAuthSession, isAuthSessionCurrent, AUTH_EVENT } from './modules/sync-cloudflare.js';
import { t } from './modules/i18n.js';

// The frame keeps the data and editing state. The outer shell receives only
// geometry and lifecycle state through authenticated extension messages.
export function createInlinePanel(dom, captureUI, workspaceUI, { ticket, restoreQuery }) {
    let mode = 'compact';
    let capture = {}, workspace = { busy: false, hasDraft: false, message: null };
    let quickBusy = false, queryDirty = false, closing = false, generation = 0;
    let localNotice = null, confirmation = null, lastReport = '', scheduled = false;
    const busy = () => quickBusy || !!capture.busy || !!workspace.busy;
    const dirty = () => queryDirty || workspace.hasDraft;
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
        document.body.classList.toggle('ext-needs-book', !capture.selectedBookId);
        dom.more.hidden = mode !== 'compact'; dom.back.hidden = mode === 'compact';
        dom.more.disabled = quickBusy;
        dom.back.disabled = busy(); dom.back.title = busy() ? t('extension.inlineFinishFirst') : '';
        dom.captureBook.disabled = quickBusy;
        dom.quick.hidden = mode !== 'compact' || !capture.loggedIn || !capture.source?.pageUrl || !!capture.selectedBookId;
        dom.quick.disabled = busy() || !capture.hasResult || !capture.loggedIn;
        dom.quick.textContent = t(quickBusy ? 'extension.inlineCreatingAndCapturing' : 'extension.inlineCreateAndCapture');
        dom.actionNotice.hidden = !localNotice;
        dom.actionNotice.textContent = localNotice ? t(localNotice.key, localNotice.params || {}) : '';
        dom.retry.hidden = mode !== 'compact' || !capture.loggedIn || !!capture.hasResult || dom.lookup.disabled;
        dom.confirm.hidden = !confirmation;
        if (confirmation) {
            dom.confirmText.textContent = t(busy() ? 'extension.inlineBusyClose' : confirmation.kind === 'back' ? 'extension.inlineUnsavedBack' : 'extension.inlineUnsavedClose');
            dom.discard.textContent = t(confirmation.kind === 'back' ? 'extension.inlineDiscardBack' : 'extension.inlineDiscardClose');
        }
        scheduleReport();
    }
    function setMode(value) {
        mode = value; render(); report();
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
        send({ type: 'BDC_INLINE_CLOSED', requestId });
    }
    function requestClose(reason = 'explicit', requestId = '') {
        if (['outside', 'offscreen'].includes(reason) && (mode === 'expanded' || busy() || dirty() || confirmation)) {
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
    async function quickCapture() {
        if (busy() || !capture.hasResult || capture.selectedBookId || !capture.loggedIn) return;
        const session = captureAuthSession(), version = captureUI.getDisplayVersion();
        const run = ++generation;
        quickBusy = true; localNotice = null; render(); report();
        try {
            const receipt = await workspaceUI.createPageBook();
            if (run !== generation || !isAuthSessionCurrent(session)) return;
            if (!receipt) { localNotice = workspace.message || { key: 'extension.workspaceFailed' }; return; }
            if (captureUI.getDisplayVersion() !== version) return;
            await captureUI.saveCurrent(version);
        } catch (_) {
            if (run === generation && isAuthSessionCurrent(session)) localNotice = { key: 'extension.workspaceFailed' };
        } finally {
            if (run === generation) { quickBusy = false; render(); report(); }
        }
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
    dom.quick.addEventListener('click', quickCapture);
    dom.retry.addEventListener('click', () => dom.lookup.click());
    for (const input of dom.queryInputs) input.addEventListener('input', () => { queryDirty = true; render(); });
    dom.lookup.addEventListener('click', () => { queryDirty = false; render(); });
    window.addEventListener('keydown', (event) => {
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
        generation += 1; quickBusy = false; queryDirty = false; localNotice = null; confirmation = null; render(); report();
    });
    captureUI.subscribe((next) => {
        if (next.displayVersion !== capture.displayVersion || (next.selectedBookId && next.selectedBookId !== capture.selectedBookId)) localNotice = null;
        capture = next; render();
    });
    workspaceUI.subscribe((next) => { workspace = next; render(); });
    new ResizeObserver(scheduleReport).observe(document.body);
    new MutationObserver(scheduleReport).observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    render(); report();
    return { render, expand: () => setMode('expanded') };
}
