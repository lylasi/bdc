import { getExtensionCaptureClient } from './modules/extension-capture.js';
import { captureAuthSession, isAuthSessionCurrent } from './modules/sync-cloudflare.js';
import { t } from './modules/i18n.js';
import { captureScopeKey } from './shared/capture-client.mjs';
import { publicSourceUrl } from './shared/vocabulary-source.mjs';
import { pageUrlKey } from './shared/page-protocol.mjs';

const errorKeys = {
    capture_target_missing: 'extension.captureTargetMissing',
    capture_sources_full: 'extension.captureSourcesFull',
    capture_entry_too_large: 'extension.captureEntryTooLarge',
    capture_request_mismatch: 'extension.captureRequestMismatch',
    capture_revision_conflict: 'extension.captureRetryLater',
    capture_server_update_required: 'extension.captureServerUpdateRequired',
    capture_storage_failed: 'extension.captureStorageFailed',
    capture_outbox_full: 'extension.captureOutboxFull',
    capture_invalid_record: 'extension.captureInvalidPending',
    rate_limited: 'extension.captureRateLimited',
    capture_invalid_input: 'extension.captureInvalidInput',
    capture_invalid_url: 'extension.captureInvalidInput',
    unauthorized: 'extension.captureLoginRequired',
    stale_session: 'extension.captureLoginRequired'
};

export function createCaptureUI(dom) {
    const client = getExtensionCaptureClient();
    const storage = globalThis.chrome?.storage?.local;
    let books = [];
    let defaultBookId = '';
    let source = null;
    let displayed = null;
    let displayVersion = 0;
    let busy = false;
    let activeSave = null;
    let loadVersion = 0;
    let manualBookId = '';
    let targetMissing = false;
    let resolveTarget = null;
    let sourceKey = '';
    let lastAttempt = null;
    let savedKey = '';
    let notice = null;
    let pending = [];
    const listeners = new Set();
    const pendingErrors = new Map();

    const currentKey = () => `${displayVersion}:${dom.captureBook.value}`;
    // Recognise earlier web collections in either locale without renaming them.
    const webBook = () => books.find((book) => !book.sourceUrl && ['网页', '網頁', '网页生词', '網頁生詞'].includes(book.name.trim()));
    const automaticBook = () => (source?.pageUrl && books.find((book) => pageUrlKey(book.sourceUrl) === pageUrlKey(source.pageUrl))) || webBook();
    function setNotice(key, kind = 'info', params = {}) {
        notice = key ? { key, kind, params } : null;
        render();
    }
    function showError(error, queued = false) {
        setNotice(errorKeys[error?.code] || (queued ? 'extension.capturePending' : 'extension.captureFailed'), 'error');
    }
    function render() {
        const session = captureAuthSession();
        const saved = !!displayed && savedKey === currentKey();
        dom.captureSave.disabled = busy || saved || !session.loggedIn || !displayed || (!dom.captureBook.value && (!resolveTarget || targetMissing));
        dom.captureSave.textContent = t(busy ? 'extension.captureAddingShort' : saved ? 'extension.captureAddedShort' : 'extension.captureAddShort');
        dom.captureSave.setAttribute('aria-label', t(busy ? 'extension.captureSaving' : saved ? 'extension.captureSaved' : 'extension.captureSave'));
        dom.captureSave.title = t('extension.captureDestination', { book: books.find((book) => book.id === dom.captureBook.value)?.name || t('extension.webBookName') });
        dom.captureBook.disabled = busy;
        dom.captureRefresh.disabled = !session.loggedIn;
        dom.captureNotice.hidden = !notice;
        dom.captureNotice.textContent = notice ? t(notice.key, notice.params) : '';
        dom.captureNotice.classList.toggle('ext-notice-error', notice?.kind === 'error');
        dom.captureNotice.classList.toggle('ext-notice-success', saved && ['extension.captureSavedTo', 'extension.captureSaved'].includes(notice?.key));
        dom.capturePending.hidden = pending.length === 0;
        dom.capturePendingSummary.textContent = t('extension.capturePendingCount', { count: pending.length });
        dom.capturePendingList.replaceChildren();
        for (const operation of pending) {
            const item = document.createElement('li');
            const label = document.createElement('span');
            const book = books.find((candidate) => candidate.id === operation.payload.bookId);
            label.textContent = `${operation.payload.word || t('extension.captureInvalidPending')} · ${book?.name || operation.payload.bookId || ''}`;
            item.appendChild(label);
            const status = document.createElement('p');
            status.textContent = t(errorKeys[operation.invalid ? 'capture_invalid_record' : pendingErrors.get(operation.key)] || 'extension.capturePendingItem');
            item.appendChild(status);
            const actions = document.createElement('div');
            actions.className = 'ext-row';
            for (const [key, action] of [
                ['extension.captureRetry', () => retryOne(operation)],
                ['extension.captureCancel', async () => { await client.cancel(operation); await updatePending(); }]
            ]) {
                if (operation.invalid && key === 'extension.captureRetry') continue;
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'ext-btn';
                button.textContent = t(key);
                button.addEventListener('click', () => {
                    button.disabled = true;
                    Promise.resolve(action()).catch(showError);
                });
                actions.appendChild(button);
            }
            item.appendChild(actions);
            dom.capturePendingList.appendChild(item);
        }
        const href = publicSourceUrl(source?.pageUrl);
        dom.captureSource.replaceChildren();
        if (href) {
            const link = document.createElement('a');
            link.href = href;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = source.pageTitle || t('extension.captureOpenSource');
            dom.captureSource.appendChild(link);
        } else dom.captureSource.textContent = t('extension.captureManualSource');
        if (dom.captureHint) dom.captureHint.textContent = t(displayed ? (dom.captureBook.value ? 'extension.captureReadyHint'
            : resolveTarget && !targetMissing ? 'extension.bookAutoWeb' : 'extension.captureChooseToSave') : 'extension.captureHint');
        const current = { books, defaultBookId, source, selectedBookId: dom.captureBook.value, loggedIn: session.loggedIn,
            hasResult: !!displayed, busy, displayVersion, targetMissing };
        for (const listener of listeners) listener(current);
    }
    async function updatePending(session = captureAuthSession()) {
        const list = await client.pending(session);
        if (!isAuthSessionCurrent(session)) return;
        pending = list;
        render();
    }
    async function restoreChoice(session = captureAuthSession(), useDefault = false) {
        if (!isAuthSessionCurrent(session)) return;
        if (useDefault) { manualBookId = ''; targetMissing = false; }
        const previous = manualBookId || dom.captureBook.value;
        if (!useDefault && previous && !books.some((book) => book.id === previous)) targetMissing = true;
        const selected = targetMissing ? '' : manualBookId || automaticBook()?.id || '';
        dom.captureBook.replaceChildren();
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = t(targetMissing ? 'extension.captureChooseBook' : automaticBook() ? 'extension.bookAutomatic' : 'extension.bookAutoWeb');
        dom.captureBook.appendChild(placeholder);
        for (const book of books) {
            const option = document.createElement('option');
            option.value = book.id;
            option.textContent = book.name;
            dom.captureBook.appendChild(option);
        }
        dom.captureBook.value = books.some((book) => book.id === selected) ? selected : '';
        if (targetMissing) setNotice('extension.captureTargetMissing', 'error');
        render();
    }
    async function loadBooks(session, { strict = false } = {}) {
        const version = ++loadVersion;
        const cacheKey = `bdc_capture_books_v1:${captureScopeKey(session)}`;
        const cached = (await storage?.get(cacheKey))?.[cacheKey];
        if (version !== loadVersion || !isAuthSessionCurrent(session)) return;
        if (!books.length && !manualBookId && Array.isArray(cached?.books)) {
            books = cached.books;
            defaultBookId = cached.selectionPolicy === 'explicit-v1' ? (cached.defaultBookId || '') : '';
            await restoreChoice(session);
        }
        try {
            const result = await client.books(session);
            if (version !== loadVersion || !isAuthSessionCurrent(session)) return;
            books = result.books;
            defaultBookId = result.defaultBookId;
            await storage?.set({ [cacheKey]: { ...result, selectionPolicy: 'explicit-v1' } }).catch(() => {});
            if (version !== loadVersion || !isAuthSessionCurrent(session)) return;
            await restoreChoice(session);
            if (notice?.key === 'extension.captureNoBooks' || notice?.key === 'extension.captureBooksOffline') setNotice(null);
            return true;
        } catch (error) {
            if (!isAuthSessionCurrent(session) || version !== loadVersion) return;
            if (books.length && (!error.status || error.status >= 500)) setNotice('extension.captureBooksOffline');
            else showError(error);
            if (strict) throw error;
            return false;
        }
    }
    async function retryOne(operation) {
        const session = captureAuthSession();
        try {
            await client.send(operation, session);
            pendingErrors.delete(operation.key);
            if (lastAttempt?.operation.key === operation.key && lastAttempt.displayKey === currentKey()) savedKey = currentKey();
            if (isAuthSessionCurrent(session)) setNotice('extension.captureSaved');
        } catch (error) {
            pendingErrors.set(operation.key, error.code);
            if (isAuthSessionCurrent(session)) showError(error, true);
        } finally { if (isAuthSessionCurrent(session)) await updatePending(session); }
    }
    async function retryAll(session = captureAuthSession()) {
        if (!session.loggedIn) return;
        const results = await client.retry(session);
        if (!isAuthSessionCurrent(session)) return;
        for (const result of results) {
            if (result.error) pendingErrors.set(result.operation.key, result.error);
            else {
                pendingErrors.delete(result.operation.key);
                if (lastAttempt?.operation.key === result.operation.key && lastAttempt.displayKey === currentKey()) savedKey = currentKey();
            }
        }
        await updatePending(session);
        if (results.some((result) => result.error)) showError({ code: results.find((result) => result.error).error }, true);
    }
    async function save(expectedVersion = displayVersion) {
        if (busy || !displayed || targetMissing || (!dom.captureBook.value && !resolveTarget) || expectedVersion !== displayVersion) return;
        const session = captureAuthSession();
        if (!session.loggedIn) return;
        const snapshot = displayed;
        const attempt = Symbol('save');
        let operation = null;
        activeSave = attempt;
        busy = true;
        setNotice(null);
        try {
            const isCurrent = () => isAuthSessionCurrent(session) && activeSave === attempt && expectedVersion === displayVersion && displayed === snapshot;
            if (!dom.captureBook.value) await resolveTarget(session, isCurrent);
            if (!isCurrent()) return;
            if (!dom.captureBook.value || targetMissing) throw Object.assign(new Error('capture_target_missing'), { code: 'capture_target_missing' });
            const key = currentKey();
            const bookName = books.find((book) => book.id === dom.captureBook.value)?.name || dom.captureBook.value;
            operation = lastAttempt?.displayKey === key ? lastAttempt.operation : null;
            if (!operation) {
                operation = await client.enqueue({
                    bookId: dom.captureBook.value,
                    word: snapshot.result.text || snapshot.result.word,
                    meaning: snapshot.result.meaning,
                    phonetic: snapshot.result.phonetic || '', pos: snapshot.result.pos || '',
                    source: {
                        sourceUrl: publicSourceUrl(snapshot.source?.pageUrl) ? snapshot.source.pageUrl : '',
                        pageTitle: snapshot.source?.pageTitle || '', sentence: snapshot.query.sentence || '',
                        context: snapshot.query.context || '', locale: snapshot.locale,
                        anchor: snapshot.source?.anchor || { start: -1, end: -1, quote: snapshot.result.text || snapshot.result.word }
                    }
                }, session);
                if (isAuthSessionCurrent(session) && key === currentKey()) lastAttempt = { displayKey: key, operation };
            }
            await client.send(operation, session);
            if (isAuthSessionCurrent(session) && activeSave === attempt) {
                if (key === currentKey()) savedKey = key;
                setNotice('extension.captureSavedTo', 'info', { book: bookName });
            }
        } catch (error) {
            if (isAuthSessionCurrent(session) && activeSave === attempt) {
                if (operation) pendingErrors.set(operation.key, error.code);
                showError(error, !!operation);
            }
        } finally {
            if (activeSave === attempt) { activeSave = null; busy = false; }
            if (isAuthSessionCurrent(session)) await updatePending(session);
            render();
        }
    }
    async function sync() {
        const session = captureAuthSession();
        loadVersion += 1;
        books = [];
        defaultBookId = '';
        manualBookId = '';
        targetMissing = false;
        pending = [];
        pendingErrors.clear();
        clearResult();
        source = null;
        sourceKey = '';
        dom.captureBook.replaceChildren();
        render();
        if (!session.loggedIn) return;
        await Promise.allSettled([loadBooks(session), retryAll(session)]);
        if (isAuthSessionCurrent(session)) {
            try { await updatePending(session); }
            catch (error) { showError(error); }
        }
    }
    function clearResult() {
        displayed = null;
        displayVersion += 1;
        busy = false;
        activeSave = null;
        lastAttempt = null;
        savedKey = '';
        notice = null;
        render();
    }
    function setSource(page) {
        const next = publicSourceUrl(page?.pageUrl) ? {
            pageUrl: page.pageUrl, pageTitle: String(page.pageTitle || '').slice(0, 300),
            ...(page.anchor ? { anchor: structuredClone(page.anchor) } : {})
        } : null;
        const nextKey = next?.pageUrl || '';
        source = next;
        if (nextKey !== sourceKey) {
            sourceKey = nextKey;
            restoreChoice(captureAuthSession(), true).catch(showError);
        }
        render();
    }
    dom.captureSave.addEventListener('click', () => save().catch(showError));
    dom.captureRefresh.addEventListener('click', () => {
        setNotice(null);
        const session = captureAuthSession();
        Promise.allSettled([loadBooks(session), retryAll(session)]).then(() => updatePending()).catch(showError);
    });
    dom.captureBook.addEventListener('change', () => {
        manualBookId = dom.captureBook.value;
        targetMissing = false;
        savedKey = '';
        lastAttempt = null;
        setNotice(null);
        restoreChoice().catch(showError);
    });
    window.addEventListener('online', () => retryAll().catch(showError));
    globalThis.chrome?.storage?.onChanged?.addListener((changes, area) => {
        if (area === 'local' && Object.keys(changes).some((key) => key.startsWith('bdc_capture_outbox_v1:'))) updatePending().catch(showError);
    });
    return {
        sync, setSource, clearResult,
        subscribe(callback) { listeners.add(callback); render(); return () => listeners.delete(callback); },
        getDisplayVersion() { return displayVersion; },
        setTargetResolver(callback) { resolveTarget = callback; render(); },
        saveCurrent(expectedVersion) { return save(expectedVersion); },
        refreshBooks(options) { return loadBooks(captureAuthSession(), options); },
        async selectBook(id) {
            const session = captureAuthSession();
            if (!isAuthSessionCurrent(session)) return;
            manualBookId = id;
            targetMissing = false;
            savedKey = '';
            lastAttempt = null;
            await loadBooks(session);
            await restoreChoice(session);
        },
        showResult(result, query, locale) {
            displayVersion += 1;
            displayed = { result: structuredClone(result), query: { ...query }, source: source && { ...source }, locale };
            busy = false;
            lastAttempt = null;
            savedKey = '';
            render();
        },
        translate() { render(); restoreChoice().catch(showError); }
    };
}
