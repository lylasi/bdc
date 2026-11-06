import { getExtensionWorkspaceClient, setDefaultCaptureBook, findExistingPageArticle } from './modules/extension-workspace.js';
import { captureAuthSession, isAuthSessionCurrent, AUTH_EVENT } from './modules/sync-cloudflare.js';
import { runExtensionArticleTask } from './modules/extension-ai-runtime.js';
import { getAIErrorTranslationKey } from './modules/api.js';
import { t } from './modules/i18n.js';
import { pageUrlKey } from './shared/page-protocol.mjs';

export function createWorkspaceUI(dom, captureUI, { ticket = '' } = {}) {
    const client = getExtensionWorkspaceClient();
    let state = { books: [], source: null, loggedIn: false, selectedBookId: '', defaultBookId: '' };
    let preview = null;
    let currentJob = null;
    let busy = false;
    let controller = null;
    let epoch = 0;
    let message = null;
    let savedArticleId = '';
    const errorKeys = { capture_target_missing: 'extension.captureTargetMissing', capture_request_mismatch: 'extension.captureRequestMismatch',
        capture_server_update_required: 'extension.captureServerUpdateRequired', unauthorized: 'extension.captureLoginRequired', capture_invalid_record: 'extension.captureInvalidPending', capture_storage_failed: 'extension.captureStorageFailed',
        article_too_large: 'extension.pageArticleTooLarge', article_quota_exceeded: 'extension.pageArticleQuota', article_count_exceeded: 'extension.pageArticleQuota',
        page_extraction_truncated: 'extension.pageExtractionTruncated', invalid_article: 'extension.pageArticleEmpty',
        page_analysis_failed: 'extension.pageAnalysisFailed', page_unavailable: 'extension.inlineUnavailable', stale_session: 'extension.captureLoginRequired',
        capture_invalid_input: 'extension.captureInvalidInput' };
    function render() {
        for (const el of [dom.createPageBook, dom.createBook, dom.createDefaultBook, dom.defaultBook, dom.articleExtract]) el.disabled = busy || !state.loggedIn;
        dom.createDefaultBook.hidden = !!state.defaultBookId;
        const pageBook = state.source?.pageUrl ? state.books.find((book) => pageUrlKey(book.sourceUrl) === pageUrlKey(state.source.pageUrl)) : null;
        dom.createPageBook.hidden = !!pageBook && state.selectedBookId === pageBook.id;
        dom.createPageBook.textContent = t(pageBook ? 'extension.bookUsePage' : 'extension.bookCreatePage');
        dom.defaultBook.disabled ||= !state.selectedBookId || state.selectedBookId === state.defaultBookId;
        dom.defaultBook.textContent = t(state.selectedBookId && state.selectedBookId === state.defaultBookId ? 'extension.bookIsDefault' : 'extension.bookSetDefault');
        dom.articleSave.disabled = busy || !preview || !!currentJob;
        dom.articleExtract.disabled ||= !!currentJob;
        dom.articleCancel.hidden = !busy;
        for (const input of [dom.articleTitle, dom.articleBody, dom.articleAnalyze]) input.disabled = busy || !!currentJob;
        dom.workspaceNotice.hidden = !message;
        dom.workspaceNotice.textContent = message ? t(message.key, message.params || {}) : '';
        dom.workspaceNotice.classList.toggle('ext-notice-error', message?.error === true);
        dom.articleOpen.hidden = !savedArticleId;
    }
    function notice(key, params, error = false) { message = { key, params, error }; render(); }
    function showError(error) {
        if (error?.name === 'AbortError') { notice('extension.pageStopped'); return; }
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
        if (!currentJob && !busy && state.source?.pageUrl) {
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
    async function applyReceipt(job, receipt) {
        if (job.type === 'book') {
            await captureUI.selectBook(receipt.bookId);
            notice('extension.bookCreated', { name: state.books.find((book) => book.id === receipt.bookId)?.name || job.payload.name });
            dom.bookForm.hidden = true;
        } else {
            savedArticleId = receipt.articleId;
            notice(receipt.reused ? 'extension.pageArticleReused' : 'extension.pageArticleSaved');
            preview = null; currentJob = null;
            dom.articlePreview.hidden = true;
            await captureUI.refreshBooks();
        }
        render();
    }
    async function create(kind) {
        if (busy || !state.loggedIn) return;
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
        } catch (error) { if (isAuthSessionCurrent(session) && version === epoch) showError(error); }
        finally { if (version === epoch) { busy = false; render(); await showPending(); } }
    }
    async function extract() {
        if (busy || !state.loggedIn) return;
        const session = captureAuthSession(); const version = epoch;
        busy = true; controller = new AbortController(); notice('extension.pageExtracting');
        try {
            const page = await readPage();
            if (!isAuthSessionCurrent(session) || version !== epoch) return;
            const queued = (await client.pending(session)).find((job) => !job.invalid && job.type === 'article' && pageUrlKey(job.payload.sourceUrl) === pageUrlKey(page.pageUrl));
            if (!isAuthSessionCurrent(session) || version !== epoch) return;
            if (queued) { restoreArticleJob(queued); return; }
            const existingId = await findExistingPageArticle(page.pageUrl);
            if (!isAuthSessionCurrent(session) || version !== epoch) return;
            if (existingId) {
                savedArticleId = existingId; preview = null; dom.articlePreview.hidden = true;
                captureUI.setSource({ pageUrl: page.pageUrl, pageTitle: page.pageTitle });
                notice('extension.pageArticleReused'); return;
            }
            const result = await runExtensionArticleTask({ page, signal: controller.signal,
                onProgress: (current, total) => { if (version === epoch) notice('extension.pageExtractProgress', { current, total }); } });
            if (!isAuthSessionCurrent(session) || version !== epoch) return;
            captureUI.setSource({ pageUrl: page.pageUrl, pageTitle: page.pageTitle });
            preview = result; currentJob = null; savedArticleId = '';
            dom.articleTitle.value = result.title; dom.articleBody.value = result.body;
            dom.articlePreview.hidden = false; notice('extension.pagePreviewReady');
        } catch (error) { if (version === epoch && isAuthSessionCurrent(session)) showError(error); }
        finally { if (version === epoch) { busy = false; controller = null; render(); } }
    }
    async function saveArticle() {
        if (busy || !preview) return;
        const session = captureAuthSession(); const version = epoch;
        busy = true; controller = new AbortController(); notice('extension.pageSaving');
        try {
            const title = dom.articleTitle.value.trim(); const body = dom.articleBody.value.trim();
            if (!title || !body || !pageUrlKey(preview.sourceUrl)) throw Object.assign(new Error('invalid_article'), { code: 'invalid_article' });
            const payload = { title, body: '# ' + title + '\n\n' + body, sourceUrl: preview.sourceUrl, sourceType: 'url' };
            if (!currentJob && dom.articleAnalyze.checked) payload.analysis = await runExtensionArticleTask({ article: payload, analyze: true, signal: controller.signal,
                onProgress: (current, total) => { if (version === epoch) notice('extension.pageAnalysisProgress', { current, total }); } });
            if (!isAuthSessionCurrent(session) || version !== epoch) return;
            if (!currentJob) currentJob = await client.enqueue('article', payload, session);
            render();
            const job = currentJob;
            const receipt = await client.send(job, session);
            if (isAuthSessionCurrent(session) && version === epoch) await applyReceipt(job, receipt);
        } catch (error) { if (version === epoch && isAuthSessionCurrent(session)) showError(error); }
        finally { if (version === epoch) { busy = false; controller = null; render(); await showPending(); } }
    }
    captureUI.subscribe((next) => { state = next; render(); });
    dom.createPageBook.addEventListener('click', () => create('page'));
    dom.createDefaultBook.addEventListener('click', () => create('default'));
    dom.createBook.addEventListener('click', () => { dom.bookForm.hidden = !dom.bookForm.hidden; dom.bookName.focus(); });
    dom.bookSubmit.addEventListener('click', () => create('custom'));
    dom.defaultBook.addEventListener('click', async () => {
        const session = captureAuthSession();
        try { await setDefaultCaptureBook(state.selectedBookId); if (isAuthSessionCurrent(session)) { await captureUI.refreshBooks(); notice('extension.bookDefaultSaved'); } }
        catch (error) { if (isAuthSessionCurrent(session)) showError(error); }
    });
    dom.articleExtract.addEventListener('click', extract);
    dom.articleSave.addEventListener('click', saveArticle);
    dom.articleCancel.addEventListener('click', () => controller?.abort());
    dom.articleOpen.addEventListener('click', async () => {
        try {
            const stored = await chrome.storage.local.get('bdc_extension_app_url');
            const url = new URL(dom.appUrl.value.trim() || stored.bdc_extension_app_url || 'https://bdc.a4a4.qzz.io/');
            if (!/^https?:$/.test(url.protocol)) throw new Error('invalid_url');
            url.searchParams.delete('module'); url.searchParams.delete('article'); url.hash = 'a/' + encodeURIComponent(savedArticleId);
            await chrome.tabs.create({ url: url.href });
        } catch (_) { notice('extension.pageAppUrlInvalid', {}, true); }
    });
    dom.appUrl.addEventListener('change', () => chrome.storage.local.set({ bdc_extension_app_url: dom.appUrl.value.trim() }));
    chrome.storage.local.get('bdc_extension_app_url').then((value) => { dom.appUrl.value = value.bdc_extension_app_url || 'https://bdc.a4a4.qzz.io/'; });
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.bdc_extension_app_url) dom.appUrl.value = changes.bdc_extension_app_url.newValue || '';
        if (area === 'local' && currentJob && changes[currentJob.key] && !changes[currentJob.key].newValue) { currentJob = null; render(); }
        if (area === 'local' && Object.keys(changes).some((key) => key.startsWith('bdc_workspace_outbox_v1:'))) showPending().catch(showError);
    });
    for (const input of [dom.articleTitle, dom.articleBody, dom.articleAnalyze]) input.addEventListener('input', () => {
        if (currentJob) notice('extension.pagePendingLocked');
    });
    window.addEventListener(AUTH_EVENT, () => {
        epoch += 1; controller?.abort(); controller = null; busy = false; preview = null; currentJob = null; savedArticleId = '';
        dom.articleTitle.value = ''; dom.articleBody.value = ''; dom.bookName.value = '';
        dom.bookMakeDefault.checked = false; dom.bookLinkPage.checked = true; dom.articleAnalyze.checked = false;
        dom.articlePreview.hidden = true; dom.bookForm.hidden = true; message = null; render();
        syncWorkspace().catch(showError);
    });
    async function syncWorkspace() {
        const session = captureAuthSession();
        if (session.loggedIn) {
            const results = await client.retry(session);
            if (!isAuthSessionCurrent(session)) return;
            for (const result of results) if (result.receipt) await applyReceipt(result.job, result.receipt);
        }
        await showPending(); render();
    }
    return { render, sync: syncWorkspace };
}
