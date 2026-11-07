import { getExtensionWorkspaceClient, setDefaultCaptureBook, findExistingPageArticle } from './modules/extension-workspace.js';
import { captureAuthSession, isAuthSessionCurrent, AUTH_EVENT } from './modules/sync-cloudflare.js';
import { runExtensionArticleTask } from './modules/extension-ai-runtime.js';
import { getAIErrorTranslationKey } from './modules/api.js';
import { t } from './modules/i18n.js';
import { pageUrlKey } from './shared/page-protocol.mjs';
import { captureScopeKey } from './shared/capture-client.mjs';

export function createWorkspaceUI(dom, captureUI, { ticket = '' } = {}) {
    const client = getExtensionWorkspaceClient();
    let state = { books: [], source: null, loggedIn: false, selectedBookId: '', defaultBookId: '' };
    let preview = null;
    let currentJob = null;
    let busy = false;
    let articleStage = '';
    let controller = null;
    let epoch = 0;
    let message = null;
    let savedArticleId = '';
    let pendingLinkSource = '';
    let ready = false;
    const listeners = new Set();
    const hasDraft = () => (!!preview && !currentJob) || (!dom.bookForm.hidden && !!(dom.bookName.value.trim() || dom.bookMakeDefault.checked || !dom.bookLinkPage.checked));
    const errorKeys = { capture_target_missing: 'extension.captureTargetMissing', capture_request_mismatch: 'extension.captureRequestMismatch',
        capture_server_update_required: 'extension.captureServerUpdateRequired', unauthorized: 'extension.captureLoginRequired', capture_invalid_record: 'extension.captureInvalidPending', capture_storage_failed: 'extension.captureStorageFailed',
        article_too_large: 'extension.pageArticleTooLarge', article_quota_exceeded: 'extension.pageArticleQuota', article_count_exceeded: 'extension.pageArticleQuota',
        page_extraction_truncated: 'extension.pageExtractionTruncated', invalid_article: 'extension.pageArticleEmpty',
        page_analysis_failed: 'extension.pageAnalysisFailed', article_context_changed: 'extension.pageAnalysisSettingsChanged',
        page_unavailable: 'extension.inlineUnavailable', stale_session: 'extension.captureLoginRequired',
        page_pending_conflict: 'extension.pagePendingConflict',
        capture_invalid_input: 'extension.captureInvalidInput', capture_outbox_full: 'extension.captureOutboxFull' };
    function render() {
        for (const el of [dom.createPageBook, dom.createBook, dom.createDefaultBook, dom.defaultBook, dom.articleExtract]) el.disabled = busy || !ready || !state.loggedIn;
        dom.createDefaultBook.hidden = !!state.defaultBookId;
        const pageBook = state.source?.pageUrl ? state.books.find((book) => pageUrlKey(book.sourceUrl) === pageUrlKey(state.source.pageUrl)) : null;
        dom.createPageBook.hidden = !!pageBook && state.selectedBookId === pageBook.id;
        dom.createPageBook.textContent = t(pageBook ? 'extension.bookUsePage' : 'extension.bookCreatePage');
        dom.defaultBook.disabled ||= !state.selectedBookId || state.selectedBookId === state.defaultBookId;
        dom.defaultBook.textContent = t(state.selectedBookId && state.selectedBookId === state.defaultBookId ? 'extension.bookIsDefault' : 'extension.bookSetDefault');
        dom.articleSave.disabled = busy || !ready || !preview;
        dom.articleSave.textContent = t(currentJob ? 'extension.pageArticleRetry' : dom.articleAnalyze.checked ? 'extension.pageArticleSave' : 'extension.pageArticleSaveOnly');
        dom.bookSubmit.disabled = busy || !ready || !state.loggedIn;
        dom.articleExtract.disabled ||= !!currentJob;
        dom.articleCancel.hidden = !busy || articleStage === 'saving';
        for (const input of [dom.articleTitle, dom.articleBody, dom.articleAnalyze]) input.disabled = busy || !!currentJob;
        dom.workspaceNotice.hidden = !message;
        dom.workspaceNotice.textContent = message ? t(message.key, message.params || {}) : '';
        dom.workspaceNotice.classList.toggle('ext-notice-error', message?.error === true);
        dom.articleOpen.hidden = !savedArticleId;
        for (const listener of listeners) listener({ busy, hasDraft: hasDraft(), message });
    }
    function notice(key, params, error = false) { message = { key, params, error }; render(); }
    function showError(error) {
        if (error?.name === 'AbortError') { notice('extension.pageStopped'); return; }
        if (error?.failedIndexes?.length) { notice('extension.pageAnalysisPartialFailed', { count: error.failedIndexes.length }, true); return; }
        if (error?.causeCode && getAIErrorTranslationKey(error.causeCode)) { notice(getAIErrorTranslationKey(error.causeCode), {}, true); return; }
        notice(errorKeys[error?.code] || getAIErrorTranslationKey(error?.code) || 'extension.workspaceFailed', {}, true);
    }
    async function readPage() {
        const response = await chrome.runtime.sendMessage({ type: 'BDC_READ_PAGE', ...(ticket ? { ticket } : {}) });
        if (!response?.ok) throw Object.assign(new Error('page_unavailable'), { code: 'page_unavailable' });
        return response.value;
    }
    function restoreArticleJob(job) {
        currentJob = job;
        preview = { ...job.payload };
        dom.articleTitle.value = job.payload.title || '';
        dom.articleBody.value = String(job.payload.body || '').replace(/^# [^\n]*\n\s*\n/, '');
        dom.articleAnalyze.checked = !!job.payload.analysis;
        dom.articlePreview.hidden = false;
        dom.workspacePendingBox.open = true;
        captureUI.setSource({ pageUrl: job.payload.sourceUrl, pageTitle: job.payload.title });
        notice('extension.pagePendingLocked');
    }
    async function showPending() {
        const session = captureAuthSession();
        const pending = await client.pending(session);
        if (!isAuthSessionCurrent(session)) return;
        if (!currentJob && !busy && !preview && state.source?.pageUrl) {
            const queued = pending.find((job) => !job.invalid && job.type === 'article' && pageUrlKey(job.payload.sourceUrl) === pageUrlKey(state.source.pageUrl));
            if (queued) restoreArticleJob(queued);
        }
        dom.workspacePending.replaceChildren();
        for (const job of pending) {
            const item = document.createElement('li');
            const label = document.createElement('span');
            label.textContent = job.invalid ? t('extension.captureInvalidPending') : t(job.type === 'book' ? 'extension.pendingBook' : 'extension.pendingArticle', { name: job.payload?.name || job.payload?.title || '' });
            item.appendChild(label);
            for (const [key, action] of [['extension.captureRetry', async () => {
                const receipt = await client.send(job, session);
                if (!isAuthSessionCurrent(session)) return;
                await applyReceipt(job, receipt);
            }], ['extension.captureCancel', () => client.cancel(job, session)]]) {
                if (job.invalid && key === 'extension.captureRetry') continue;
                const button = document.createElement('button'); button.type = 'button'; button.className = 'ext-btn'; button.textContent = t(key);
                button.addEventListener('click', async () => {
                    button.disabled = true;
                    try { await action(); if (currentJob?.key === job.key) currentJob = null; }
                    catch (error) { showError(error); }
                    finally { await showPending(); render(); }
                });
                item.appendChild(button);
            }
            dom.workspacePending.appendChild(item);
        }
        dom.workspacePendingBox.hidden = pending.length === 0;
    }
    async function applyReceipt(job, receipt, select = true) {
        if (job.type === 'book') {
            if (select) await captureUI.selectBook(receipt.bookId);
            else await captureUI.refreshBooks();
            notice('extension.bookCreated', { name: state.books.find((book) => book.id === receipt.bookId)?.name || job.payload.name });
            dom.bookForm.hidden = true;
        } else {
            savedArticleId = receipt.articleId;
            pendingLinkSource = '';
            notice(receipt.reused ? 'extension.pageArticleReused' : 'extension.pageArticleSaved');
            preview = null; currentJob = null;
            dom.articlePreview.hidden = true;
            captureUI.refreshBooks().catch(() => {});
        }
        render();
    }
    async function create(kind) {
        if (busy || !ready || !state.loggedIn) return;
        const session = captureAuthSession();
        const version = epoch;
        busy = true; render();
        try {
            let source = state.source;
            if ((kind === 'page' || (kind === 'custom' && dom.bookLinkPage.checked)) && !source?.pageUrl) {
                const page = await readPage();
                source = { pageUrl: page.pageUrl, pageTitle: page.pageTitle }; captureUI.setSource(source);
            }
            const name = kind === 'default' ? t('extension.defaultBookName') : kind === 'page' ? source.pageTitle || t('extension.pageBookName') : dom.bookName.value.trim();
            if (!name) { notice('extension.bookNameRequired', {}, true); return; }
            const payload = { name, kind: kind === 'page' ? 'page' : 'custom',
                sourceUrl: kind === 'page' || (kind === 'custom' && dom.bookLinkPage.checked) ? source?.pageUrl || '' : '',
                makeDefault: kind === 'default' || (kind === 'custom' && dom.bookMakeDefault.checked) };
            const job = await client.enqueue('book', payload, session);
            const receipt = await client.send(job, session);
            if (!isAuthSessionCurrent(session) || version !== epoch) return;
            await applyReceipt(job, receipt);
            return receipt;
        } catch (error) { if (isAuthSessionCurrent(session) && version === epoch) showError(error); }
        finally { if (version === epoch) { busy = false; render(); await showPending(); } }
    }
    async function ensureCaptureBook(session, isCurrent) {
        const ensure = async () => {
            if (!isCurrent()) return;
            if (busy || !ready || !state.loggedIn) throw Object.assign(new Error('stale_session'), { code: 'stale_session' });
            // Refresh inside the lock: another lookup window may have just
            // created the shared collection, or a page book may now exist.
            const loaded = await captureUI.refreshBooks({ strict: true });
            if (!isCurrent()) return;
            if (!loaded) throw Object.assign(new Error('capture_revision_conflict'), { code: 'capture_revision_conflict' });
            if (state.targetMissing) throw Object.assign(new Error('capture_target_missing'), { code: 'capture_target_missing' });
            if (state.selectedBookId) return;
            const version = epoch;
            busy = true; render();
            try {
                // Reuse a durable create after a lost reply instead of creating
                // another collection on each click.
                const pending = await client.pending(session);
                if (!isCurrent()) return;
                const job = pending.find((item) => !item.invalid && item.type === 'book' && !item.payload.sourceUrl
                    && ['网页', '網頁', '网页生词', '網頁生詞'].includes(item.payload.name?.trim()))
                    || await client.enqueue('book', { name: t('extension.webBookName'), kind: 'custom', sourceUrl: '', makeDefault: false }, session);
                if (!isCurrent()) return;
                const receipt = await client.send(job, session);
                if (!isCurrent()) return;
                await applyReceipt(job, receipt);
            } finally {
                if (version === epoch) { busy = false; render(); await showPending(); }
            }
        };
        // Extension documents share an origin, so concurrent first saves use
        // the same collection without needing a new server endpoint.
        if (globalThis.navigator?.locks) return navigator.locks.request('bdc-web-book:' + captureScopeKey(session), ensure);
        return ensure();
    }
    async function extract() {
        if (busy || !ready || !state.loggedIn) return;
        if (preview && !currentJob && (dom.articleTitle.value.trim() !== String(preview.title || '').trim()
            || dom.articleBody.value.trim() !== String(preview.body || '').trim()) && !window.confirm(t('extension.pageReplacePreviewConfirm'))) return;
        const session = captureAuthSession(); const version = epoch;
        busy = true; articleStage = 'extracting'; controller = new AbortController(); notice('extension.pageExtracting');
        const signal = controller.signal;
        try {
            const page = await readPage();
            if (!isAuthSessionCurrent(session) || version !== epoch) return;
            signal.throwIfAborted();
            const queued = (await client.pending(session)).find((job) => !job.invalid && job.type === 'article' && pageUrlKey(job.payload.sourceUrl) === pageUrlKey(page.pageUrl));
            if (!isAuthSessionCurrent(session) || version !== epoch) return;
            signal.throwIfAborted();
            if (queued) { restoreArticleJob(queued); return; }
            let existingId = '', deferredLookup = false;
            try { existingId = await findExistingPageArticle(page.pageUrl, { signal }); }
            catch (error) {
                signal.throwIfAborted();
                // This is an optional preflight. The save protocol checks the
                // page again before writing; a temporary sync outage must not
                // prevent a local AI preview. Authentication errors stay fatal.
                if (['unauthorized', 'stale_session', 'sync_endpoint_missing', 'client_aborted'].includes(error.code) || [401, 403].includes(error.status)) throw error;
                deferredLookup = true;
            }
            if (!isAuthSessionCurrent(session) || version !== epoch) return;
            signal.throwIfAborted();
            if (existingId) {
                savedArticleId = existingId; preview = null; dom.articlePreview.hidden = true;
                pendingLinkSource = page.pageUrl;
                captureUI.setSource({ pageUrl: page.pageUrl, pageTitle: page.pageTitle });
                notice('extension.pageArticleReused'); return;
            }
            const result = await runExtensionArticleTask({ page, signal,
                onProgress: (current, total) => { if (version === epoch) notice('extension.pageExtractProgress', { current, total }); } });
            if (!isAuthSessionCurrent(session) || version !== epoch) return;
            captureUI.setSource({ pageUrl: page.pageUrl, pageTitle: page.pageTitle });
            preview = result; currentJob = null; savedArticleId = '';
            pendingLinkSource = '';
            dom.articleTitle.value = result.title; dom.articleBody.value = result.body;
            dom.articleAnalyze.checked = true;
            dom.articlePreview.hidden = false;
            notice(result.cleanupIncomplete ? 'extension.pageExtractionPartial' : deferredLookup ? 'extension.pagePreviewSyncDeferred' : 'extension.pagePreviewReady', { count: result.cleanupIncomplete });
        } catch (error) { if (version === epoch && isAuthSessionCurrent(session)) showError(error); }
        finally { if (version === epoch) { busy = false; articleStage = ''; controller = null; render(); } }
    }
    async function saveArticle() {
        if (busy || !ready || !state.loggedIn || !preview) return;
        const session = captureAuthSession(); const version = epoch;
        busy = true; articleStage = !currentJob && dom.articleAnalyze.checked ? 'analyzing' : 'saving';
        controller = new AbortController(); notice(articleStage === 'analyzing' ? 'extension.pageAnalyzing' : 'extension.pageSaving');
        try {
            const title = dom.articleTitle.value.trim(); const body = dom.articleBody.value.trim();
            if (!title || !body || !pageUrlKey(preview.sourceUrl)) throw Object.assign(new Error('invalid_article'), { code: 'invalid_article' });
            const other = (await client.pending(session)).find((job) => !job.invalid && job.type === 'article'
                && job.key !== currentJob?.key && pageUrlKey(job.payload.sourceUrl) === pageUrlKey(preview.sourceUrl));
            if (other) throw Object.assign(new Error('page_pending_conflict'), { code: 'page_pending_conflict' });
            if (!isAuthSessionCurrent(session) || version !== epoch) return;
            const payload = { title, body: '# ' + title + '\n\n' + body, sourceUrl: preview.sourceUrl, sourceType: 'url' };
            if (!currentJob && dom.articleAnalyze.checked) payload.analysis = await runExtensionArticleTask({ article: payload, analyze: true, signal: controller.signal,
                onProgress: (current, total) => { if (version === epoch) notice('extension.pageAnalysisProgress', { current, total }); } });
            if (!isAuthSessionCurrent(session) || version !== epoch) return;
            controller.signal.throwIfAborted();
            articleStage = 'saving'; notice('extension.pageSaving');
            if (!currentJob) currentJob = await client.enqueue('article', payload, session);
            render();
            const job = currentJob;
            const receipt = await client.send(job, session);
            if (isAuthSessionCurrent(session) && version === epoch) await applyReceipt(job, receipt);
        } catch (error) { if (version === epoch && isAuthSessionCurrent(session)) showError(error); }
        finally { if (version === epoch) { busy = false; articleStage = ''; controller = null; render(); await showPending(); } }
    }
    captureUI.subscribe((next) => { state = next; render(); });
    dom.createPageBook.addEventListener('click', () => create('page'));
    dom.createDefaultBook.addEventListener('click', () => create('default'));
    dom.createBook.addEventListener('click', () => {
        dom.bookForm.hidden = !dom.bookForm.hidden;
        const options = dom.bookForm.closest('details');
        if (!dom.bookForm.hidden && options) options.open = true;
        if (!dom.bookForm.hidden) dom.bookName.focus();
    });
    dom.bookSubmit.addEventListener('click', () => create('custom'));
    dom.defaultBook.addEventListener('click', async () => {
        const session = captureAuthSession();
        try { await setDefaultCaptureBook(state.selectedBookId); if (isAuthSessionCurrent(session)) { await captureUI.refreshBooks(); notice('extension.bookDefaultSaved'); } }
        catch (error) { if (isAuthSessionCurrent(session)) showError(error); }
    });
    dom.articleExtract.addEventListener('click', extract);
    dom.articleSave.addEventListener('click', saveArticle);
    dom.articleCancel.addEventListener('click', () => controller?.abort());
    async function openArticle() {
        if (!savedArticleId) return;
        try {
            if (pendingLinkSource) {
                const id = await findExistingPageArticle(pendingLinkSource, { link: true });
                if (!id) throw Object.assign(new Error('capture_target_missing'), { code: 'capture_target_missing' });
                savedArticleId = id;
                pendingLinkSource = '';
            }
            const response = await chrome.runtime.sendMessage({ type: 'BDC_OPEN_SITE', target: 'article', id: savedArticleId,
                replace: true, ...(ticket ? { ticket } : {}) });
            if (!response?.ok) throw new Error('invalid_url');
        } catch (error) {
            if (error?.code) showError(error);
            else notice('extension.pageAppUrlInvalid', {}, true);
        }
    }
    dom.articleOpen.addEventListener('click', openArticle);
    dom.appUrl.addEventListener('change', () => chrome.storage.local.set({ bdc_extension_app_url: dom.appUrl.value.trim() }));
    chrome.storage.local.get('bdc_extension_app_url').then((value) => { dom.appUrl.value = value.bdc_extension_app_url || 'https://bdc.a4a4.qzz.io/'; });
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.bdc_extension_app_url) dom.appUrl.value = changes.bdc_extension_app_url.newValue || '';
        if (area === 'local' && currentJob && changes[currentJob.key] && !changes[currentJob.key].newValue) { currentJob = null; render(); }
        if (area === 'local' && Object.keys(changes).some((key) => key.startsWith('bdc_workspace_outbox_v1:'))) showPending().catch(showError);
    });
    for (const input of [dom.articleTitle, dom.articleBody, dom.articleAnalyze]) input.addEventListener('input', () => {
        if (currentJob) notice('extension.pagePendingLocked');
        render();
    });
    for (const input of [dom.bookName, dom.bookMakeDefault, dom.bookLinkPage]) input.addEventListener('input', render);
    window.addEventListener(AUTH_EVENT, () => {
        epoch += 1; controller?.abort(); controller = null; busy = false; articleStage = ''; preview = null; currentJob = null; savedArticleId = ''; pendingLinkSource = '';
        dom.articleTitle.value = ''; dom.articleBody.value = ''; dom.bookName.value = '';
        dom.bookMakeDefault.checked = false; dom.bookLinkPage.checked = true; dom.articleAnalyze.checked = true;
        dom.articlePreview.hidden = true; dom.bookForm.hidden = true; message = null; render();
        syncWorkspace().catch(showError);
    });
    async function syncWorkspace() {
        const session = captureAuthSession();
        if (session.loggedIn) {
            const results = await client.retry(session);
            if (!isAuthSessionCurrent(session)) return;
            for (const result of results) if (result.receipt) await applyReceipt(result.job, result.receipt, false);
        }
        await showPending(); render();
    }
    return { render, sync: syncWorkspace,
        setReady(value, error = null) {
            ready = value;
            captureUI.setTargetResolver(value ? ensureCaptureBook : null);
            if (error) showError(error);
            render();
        },
        async importPage() {
            // The context-menu shortcut prepares an editable preview only.
            // Analysis and writes require the separate confirmation button.
            await extract();
        },
        createPageBook: () => create('page'),
        subscribe(callback) { listeners.add(callback); render(); return () => listeners.delete(callback); },
        discardDraft() {
            if (busy) return false;
            if (!currentJob) { preview = null; dom.articlePreview.hidden = true; }
            dom.bookForm.hidden = true; dom.bookName.value = ''; dom.bookMakeDefault.checked = false; dom.bookLinkPage.checked = true;
            message = null; render(); return true;
        }
    };
}
