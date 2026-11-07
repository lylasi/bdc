// BDC trusted extension lookup & account configuration page controller.
// Runs only under the extension's own origin (chrome-extension://).

import {
    EXTENSION_ENDPOINT_STORAGE_KEY,
    getExtensionSyncEndpoint,
    setExtensionSyncEndpoint,
    restoreTrustedSessionState,
    connectExtensionAccount,
    disconnectExtensionAccount,
    syncExtensionAccountAI,
    importScopedLocalProviderKey,
    getExtensionReadiness,
    readExtensionLookupCache,
    runExtensionLookup,
    lookupSelection
} from './modules/extension-ai-runtime.js';
import { AUTH_EVENT } from './modules/sync-cloudflare.js';
import { getAIErrorTranslationKey } from './modules/api.js';
import { getLocale, setLocale, initI18n, applyTranslations, t } from './modules/i18n.js';
import { extractActivePageSelectionInTab } from './selection-extractor.js';
import { createCaptureUI } from './capture-ui.js';
import { createWorkspaceUI } from './workspace-ui.js';
import { createInlinePanel } from './inline-panel.js';
import { createAIControls } from './ai-controls.js';
import { createAssistantUI } from './assistant-ui.js';
import { publicSourceUrl } from './shared/vocabulary-source.mjs';
import { EXTENSION_AI_PREFERENCES_PREFIX } from './modules/extension-ai-preferences.js';
import { speakText, stopCurrentAudio, unlockAudioContext, getActiveAudioOwner } from './modules/audio.js';
import { createIcon } from './icons.js';

const pageParameters = new URLSearchParams(location.search);
const isEmbedded = window.parent !== window;
const inlineTicket = pageParameters.get('ticket') || pageParameters.get('windowTicket') || '';
const isWorkspaceWindow = pageParameters.has('windowTicket');
const requestedView = pageParameters.get('view') || '';
document.body.classList.add(isWorkspaceWindow ? 'ext-workspace-window' : isEmbedded ? 'ext-inline' : 'ext-home');
if (requestedView === 'article') document.body.classList.add('ext-article-view');
let inlineContext = null;
if (isEmbedded || pageParameters.has('embedded')) {
    const result = await chrome.runtime.sendMessage({ type: 'BDC_INLINE_CONTEXT', ticket: inlineTicket }).catch(() => null);
    if (!isEmbedded || !result?.ok) {
        initI18n();
        document.body.textContent = t('extension.inlineUnavailable');
        throw new Error('Invalid inline context');
    }
    inlineContext = result.value;
    document.body.classList.add('ext-inline');
    document.getElementById('ext-inline-toolbar').hidden = false;
}


if (isWorkspaceWindow) {
    const result = await chrome.runtime.sendMessage({ type: 'BDC_WINDOW_CONTEXT', ticket: inlineTicket }).catch(() => null);
    if (!result?.ok) { initI18n(); document.body.textContent = t('extension.inlineUnavailable'); throw new Error('Invalid window context'); }
    inlineContext = result.value;
}

const dom = {
    localeSelect: document.getElementById('ext-locale-select'),
    openTabBtn: document.getElementById('ext-open-tab-btn'),
    endpointInput: document.getElementById('ext-endpoint-input'),
    loginMode: document.getElementById('ext-login-mode'),
    passwordFields: document.getElementById('ext-mode-password-fields'),
    tokenFields: document.getElementById('ext-mode-token-fields'),
    codeFields: document.getElementById('ext-mode-code-fields'),
    usernameInput: document.getElementById('ext-username-input'),
    passwordInput: document.getElementById('ext-password-input'),
    tokenInput: document.getElementById('ext-token-input'),
    codeInput: document.getElementById('ext-code-input'),
    connectBtn: document.getElementById('ext-connect-btn'),
    syncBtn: document.getElementById('ext-sync-btn'),
    logoutBtn: document.getElementById('ext-logout-btn'),
    accountStatus: document.getElementById('ext-account-status'),
    catalogStatus: document.getElementById('ext-catalog-status'),
    taskStatus: document.getElementById('ext-task-status'),
    missingKeyBanner: document.getElementById('ext-missing-key-banner'),
    missingKeyDesc: document.getElementById('ext-missing-key-desc'),
    importProviderSelect: document.getElementById('ext-import-provider-select'),
    importKeyInput: document.getElementById('ext-import-key-input'),
    importKeyBtn: document.getElementById('ext-import-key-btn'),
    accountNotice: document.getElementById('ext-account-notice'),
    extractBtn: document.getElementById('ext-extract-btn'),
    forceRefresh: document.getElementById('ext-force-refresh'),
    wordInput: document.getElementById('ext-word-input'),
    sentenceInput: document.getElementById('ext-sentence-input'),
    contextInput: document.getElementById('ext-context-input'),
    lookupBtn: document.getElementById('ext-lookup-btn'),
    lookupNotice: document.getElementById('ext-lookup-notice'),
    resultEmpty: document.getElementById('ext-result-empty'),
    resultBox: document.getElementById('ext-result-box'),
    resultWord: document.getElementById('ext-result-word'),
    resultSpeak: document.getElementById('ext-result-speak'),
    pronunciationNotice: document.getElementById('ext-pronunciation-notice'),
    resultPhonetic: document.getElementById('ext-result-phonetic'),
    resultPos: document.getElementById('ext-result-pos'),
    resultMeaning: document.getElementById('ext-result-meaning'),
    resultRole: document.getElementById('ext-result-role'),
    resultExamples: document.getElementById('ext-result-examples'),
    resultMeta: document.getElementById('ext-result-meta'),
    resultCache: document.getElementById('ext-result-cache'),
    requery: document.getElementById('ext-inline-retry'),
    captureBook: document.getElementById('ext-capture-book'),
    captureSave: document.getElementById('ext-capture-save'),
    captureRefresh: document.getElementById('ext-capture-refresh'),
    captureSource: document.getElementById('ext-capture-source'),
    captureNotice: document.getElementById('ext-capture-notice'),
    capturePending: document.getElementById('ext-capture-pending'),
    capturePendingSummary: document.getElementById('ext-capture-pending-summary'),
    capturePendingList: document.getElementById('ext-capture-pending-list'),
    captureHint: document.getElementById('ext-capture-hint'),
    inlineLookupNotice: document.getElementById('ext-inline-lookup-notice')
};

const captureUI = createCaptureUI(dom);
const workspaceDom = {
    createPageBook: document.getElementById('ext-book-page'), createBook: document.getElementById('ext-book-new'),
    createDefaultBook: document.getElementById('ext-book-default-create'), defaultBook: document.getElementById('ext-book-set-default'),
    bookForm: document.getElementById('ext-book-form'), bookName: document.getElementById('ext-book-name'),
    bookLinkPage: document.getElementById('ext-book-link-page'), bookMakeDefault: document.getElementById('ext-book-make-default'),
    bookSubmit: document.getElementById('ext-book-submit'), articleExtract: document.getElementById('ext-article-extract'),
    articleCancel: document.getElementById('ext-article-cancel'), articleOpen: document.getElementById('ext-article-open'),
    articlePreview: document.getElementById('ext-article-preview'), articleTitle: document.getElementById('ext-article-title'),
    articleBody: document.getElementById('ext-article-body'), articleAnalyze: document.getElementById('ext-article-analyze'),
    articleSave: document.getElementById('ext-article-save'), workspaceNotice: document.getElementById('ext-workspace-notice'),
    workspacePendingBox: document.getElementById('ext-workspace-pending'), workspacePending: document.getElementById('ext-workspace-pending-list'),
    appUrl: document.getElementById('ext-app-url')
};
const workspaceUI = createWorkspaceUI(workspaceDom, captureUI, { ticket: inlineTicket });
if (requestedView !== 'article') {
    document.getElementById('ext-book-feedback').append(workspaceDom.workspaceNotice, workspaceDom.workspacePendingBox);
}

let activeLookupSequence = 0;
let activeLookupController = null;
let lookupSetupPromise = null;
let lastResultPayload = null;
let pronunciationSequence = 0;
let pronunciationActive = false;
let pronunciationFailed = false;
const PRONUNCIATION_OWNER = 'extension-lookup';
let lastAccountNotice = null;
let lastLookupNotice = null;
let lastAccountIdentity = null;
let assistantUI = null;
let captureState = {};
let workspaceState = {};
let savedDialogMode = null;
let querySnapshot = null;
let querySubmitted = false;
const inlineUI = isEmbedded ? createInlinePanel({
    more: document.getElementById('ext-inline-more'), back: document.getElementById('ext-inline-back'),
    close: document.getElementById('ext-inline-close'), confirm: document.getElementById('ext-inline-confirm'),
    confirmText: document.getElementById('ext-inline-confirm-text'), keep: document.getElementById('ext-inline-keep'),
    discard: document.getElementById('ext-inline-discard'),
    actionNotice: document.getElementById('ext-inline-action-notice'),
    captureBook: dom.captureBook, lookup: dom.lookupBtn, queryInputs: [dom.wordInput, dom.sentenceInput, dom.contextInput]
}, captureUI, workspaceUI, { ticket: inlineTicket, initialMode: requestedView === 'assistant' ? 'assistant' : 'compact',
    getAuxState: () => document.body.classList.contains('ext-assistant-view') ? assistantUI?.getState() || {} : {},
    onClose: () => { assistantUI?.stop(); stopPronunciation(); },
    onMode: (mode) => {
        if (['dialog', 'assistant', 'assistant-dock'].includes(mode)) stopPronunciation();
        if (mode === 'dialog') return;
        const assistant = mode === 'assistant' || mode === 'assistant-dock';
        document.body.classList.toggle('ext-assistant-view', assistant);
        const title = document.querySelector('.ext-toolbar-title');
        if (title) {
            title.dataset.i18n = assistant ? 'extension.assistantTitle' : 'extension.inlineTitle';
            title.textContent = t(title.dataset.i18n);
        }
        const section = document.getElementById('ext-assistant-section');
        if (section) section.hidden = !assistant;
    }, restoreQuery: () => {
    const page = inlineContext.page;
    dom.wordInput.value = page.text; dom.sentenceInput.value = page.sentence || ''; dom.contextInput.value = page.context || '';
    captureUI.setSource(page); renderReadiness();
} }) : null;
const aiControls = createAIControls({ embedded: isEmbedded, onChange: renderReadiness, onLookup: () => {
    document.getElementById('ext-settings-dialog')?.close();
    handleLookup({ noCache: true });
} });

const assistantDom = Object.fromEntries(Object.entries({ section: 'section', context: 'context', reference: 'reference', referenceText: 'reference-text',
    messages: 'messages', notice: 'notice', form: 'form', input: 'input', send: 'send', stop: 'stop', retry: 'retry',
    newConversation: 'new', expand: 'expand' }).map(([key, suffix]) => [key, document.getElementById('ext-assistant-' + suffix)]));
assistantUI = createAssistantUI(assistantDom, { ticket: inlineTicket, onState: () => inlineUI?.render(),
    onExpand: () => {
        const dock = inlineUI?.getMode() !== 'assistant-dock';
        inlineUI?.setMode(dock ? 'assistant-dock' : 'assistant');
        assistantDom.expand.setAttribute('aria-pressed', String(dock));
        const label = t(dock ? 'extension.assistantCollapse' : 'extension.assistantExpand');
        assistantDom.expand.title = label; assistantDom.expand.setAttribute('aria-label', label);
        assistantDom.expand.dataset.i18nTitle = dock ? 'extension.assistantCollapse' : 'extension.assistantExpand';
        assistantDom.expand.dataset.i18nAriaLabel = assistantDom.expand.dataset.i18nTitle;
    } });

async function openAssistant(fromWord = false) {
    if (!isEmbedded && !isWorkspaceWindow) {
        const response = await chrome.runtime.sendMessage({ type: 'BDC_SHOW_ASSISTANT' }).catch(() => null);
        if (!response?.ok) showAccountNotice('error', 'extension.inlineUnavailable');
        return;
    }
    inlineUI?.setMode('assistant');
    document.body.classList.add('ext-assistant-view');
    await assistantUI.open({ reference: fromWord ? [dom.wordInput.value, dom.sentenceInput.value].filter(Boolean).join('\n') : '' });
}
function openDialog(id) {
    const dialog = document.getElementById(id);
    if (!dialog || dialog.open) return;
    if (savedDialogMode === null) savedDialogMode = inlineUI?.getMode() || null;
    inlineUI?.setMode('dialog');
    if (id === 'ext-query-dialog') {
        document.body.classList.add('ext-edit-query');
        querySubmitted = false;
        querySnapshot = { text: dom.wordInput.value, sentence: dom.sentenceInput.value, context: dom.contextInput.value,
            source: captureState.source, result: lastResultPayload };
    }
    document.body.classList.add('ext-modal-open');
    dialog.showModal();
    if (id === 'ext-query-dialog') dom.wordInput.focus();
}
async function openWorkspace() {
    const result = await chrome.runtime.sendMessage({ type: 'BDC_OPEN_WINDOW', view: 'article',
        ...(inlineTicket ? { ticket: inlineTicket } : {}) }).catch(() => null);
    if (!result?.ok) showAccountNotice('error', 'extension.inlineUnavailable');
}
async function openBook(home = false) {
    const result = await chrome.runtime.sendMessage({ type: 'BDC_OPEN_SITE', target: 'book', id: home ? '' : captureState.selectedBookId || '',
        ...(inlineTicket ? { ticket: inlineTicket } : {}) }).catch(() => null);
    if (!result?.ok) showAccountNotice('error', 'extension.pageAppUrlInvalid');
}
captureUI.subscribe((state) => {
    captureState = state;
    document.body.classList.toggle('ext-has-query', !!state.hasResult || !!dom.wordInput.value.trim());
    const bookButton = document.getElementById('ext-open-book');
    if (bookButton) bookButton.disabled = !state.selectedBookId;
    const bookSettings = document.getElementById('ext-book-settings');
    if (bookSettings) {
        bookSettings.disabled = state.busy;
        bookSettings.title = `${t('extension.captureDestination', { book: state.books.find((book) => book.id === state.selectedBookId)?.name || t('extension.webBookName') })} · ${t('extension.bookSettingsOpen')}`;
    }
    const sourceButton = document.getElementById('ext-open-source');
    if (sourceButton) sourceButton.hidden = !publicSourceUrl(state.source?.pageUrl);
});
workspaceUI.subscribe((state) => { workspaceState = state; });


function setNotice(el, kind, keyOrText, params = {}, isRawText = false) {
    if (!el) return;
    if (!keyOrText) {
        el.hidden = true;
        el.classList.add('hidden');
        el.textContent = '';
        return;
    }
    el.hidden = false;
    el.classList.remove('hidden', 'ext-notice-error', 'ext-notice-info');
    el.classList.add(kind === 'error' ? 'ext-notice-error' : 'ext-notice-info');
    el.textContent = isRawText ? String(keyOrText) : t(keyOrText, params);
}

function showAccountNotice(kind, keyOrText, params = {}, isRawText = false) {
    lastAccountNotice = keyOrText ? { kind, keyOrText, params, isRawText } : null;
    setNotice(dom.accountNotice, kind, keyOrText, params, isRawText);
    setNotice(document.getElementById('ext-home-notice'), kind, kind === 'error' ? keyOrText : '', params, isRawText);
}

function showLookupNotice(kind, keyOrText, params = {}, isRawText = false) {
    lastLookupNotice = keyOrText ? { kind, keyOrText, params, isRawText } : null;
    setNotice(dom.lookupNotice, kind, keyOrText, params, isRawText);
    if (isEmbedded) setNotice(dom.inlineLookupNotice, kind, keyOrText, params, isRawText);
}

function syncLoginModeFields() {
    const mode = dom.loginMode ? dom.loginMode.value : 'password';
    dom.passwordFields?.classList.toggle('hidden', mode !== 'password');
    dom.tokenFields?.classList.toggle('hidden', mode !== 'token');
    dom.codeFields?.classList.toggle('hidden', mode !== 'code');
}

function clearDisplayedResult() {
    stopPronunciation();
    captureUI.clearResult();
    lastResultPayload = null;
    dom.resultEmpty?.classList.remove('hidden');
    if (dom.resultEmpty) dom.resultEmpty.textContent = t('extension.resultEmpty');
    dom.resultBox?.classList.add('hidden');
    if (dom.resultWord) dom.resultWord.textContent = '';
    if (dom.resultPhonetic) dom.resultPhonetic.textContent = '';
    if (dom.resultPos) dom.resultPos.textContent = '';
    if (dom.resultMeaning) dom.resultMeaning.textContent = '';
    if (dom.resultCache) dom.resultCache.hidden = true;
    if (dom.resultRole) dom.resultRole.textContent = '';
    if (dom.resultExamples) dom.resultExamples.innerHTML = '';
    if (dom.resultMeta) dom.resultMeta.textContent = '';
    renderPronunciation();
}

function renderPronunciation() {
    const key = pronunciationActive ? 'extension.lookupPronounceStop' : 'extension.lookupPronounce';
    dom.resultSpeak.disabled = !dom.resultWord.textContent.trim();
    dom.resultSpeak.title = t(key);
    dom.resultSpeak.setAttribute('aria-label', t(key));
    dom.resultSpeak.setAttribute('aria-pressed', String(pronunciationActive));
    dom.resultSpeak.dataset.i18nTitle = key;
    dom.resultSpeak.dataset.i18nAriaLabel = key;
    dom.resultSpeak.replaceChildren(createIcon(pronunciationActive ? 'stop' : 'speaker'));
    dom.pronunciationNotice.hidden = !pronunciationFailed;
    dom.pronunciationNotice.textContent = pronunciationFailed ? t('extension.lookupPronounceFailed') : '';
}

function stopPronunciation() {
    pronunciationSequence += 1;
    pronunciationActive = false;
    pronunciationFailed = false;
    if (getActiveAudioOwner() === PRONUNCIATION_OWNER) stopCurrentAudio();
    renderPronunciation();
}

async function togglePronunciation() {
    if (pronunciationActive) { stopPronunciation(); return; }
    const text = dom.resultWord.textContent.trim();
    if (!text) return;
    const sequence = ++pronunciationSequence;
    pronunciationFailed = false;
    pronunciationActive = true;
    renderPronunciation();
    try {
        unlockAudioContext();
        const played = await speakText(text, 'english', 0, null, null, {
            owner: PRONUNCIATION_OWNER,
            onStatus: ({ state }) => {
                if (sequence !== pronunciationSequence) return;
                if (state === 'ended' || state === 'error') pronunciationActive = false;
                pronunciationFailed = state === 'error';
                renderPronunciation();
            }
        });
        if (sequence !== pronunciationSequence || played) return;
    } catch (_) {
        if (sequence !== pronunciationSequence) return;
    }
    pronunciationActive = false;
    pronunciationFailed = true;
    renderPronunciation();
}

function invalidateLookup() {
    activeLookupSequence += 1;
    activeLookupController?.abort();
    activeLookupController = null;
    if (dom.lookupBtn) {
        dom.lookupBtn.disabled = false;
        dom.lookupBtn.textContent = t('extension.lookupBtn');
    }
    clearDisplayedResult();
    showLookupNotice('info', '');
}

function showFailure(show, error) {
    show('error', getAIErrorTranslationKey(error?.code) || 'errors.aiRequestFailed', { status: error?.status || '' });
}

function thinkingLabel(level) {
    const keys = { auto: 'settings.aiThinkingAuto', none: 'settings.aiThinkingNone', low: 'settings.aiThinkingLow', medium: 'settings.aiThinkingMedium', high: 'settings.aiThinkingHigh' };
    return t(keys[level] || keys.auto);
}

function credentialErrorKey(code) {
    return code?.startsWith('download_failed:') ? 'extension.credentialDownloadFailed'
        : (getAIErrorTranslationKey(code) || 'errors.aiRequestFailed');
}

function reportSync(readiness, successKey) {
    if (readiness?.credentialSync?.error) showAccountNotice('error', credentialErrorKey(readiness.credentialSync.error));
    else showAccountNotice('info', successKey);
}

function renderResult(result) {
    if (!result || !result.meaning) {
        clearDisplayedResult();
        return;
    }
    lastResultPayload = result;
    dom.resultCache.hidden = !result.fromCache;
    dom.resultEmpty?.classList.add('hidden');
    dom.resultBox?.classList.remove('hidden');
    if (dom.resultWord) dom.resultWord.textContent = result.text || result.word || '';
    renderPronunciation();
    if (dom.resultPhonetic) {
        const ipa = String(result.phonetic || '').trim().replace(/^\/|\/$/g, '');
        dom.resultPhonetic.textContent = ipa ? `/${ipa}/` : '';
        dom.resultPhonetic.classList.toggle('hidden', !ipa);
    }
    if (dom.resultPos) {
        const pos = String(result.pos || '').trim();
        dom.resultPos.textContent = pos;
        dom.resultPos.classList.toggle('hidden', !pos);
    }
    if (dom.resultMeaning) {
        dom.resultMeaning.textContent = result.meaning;
    }
    if (dom.resultRole) {
        const role = String(result.role || result.usage || '').trim();
        dom.resultRole.textContent = role ? `${t('extension.resultRoleLabel')}：${role}` : '';
        dom.resultRole.classList.toggle('hidden', !role);
    }
    if (dom.resultExamples) {
        dom.resultExamples.innerHTML = '';
        const examples = Array.isArray(result.examples) ? result.examples : [];
        for (const item of examples) {
            if (!item || (!item.en && !item.zh)) continue;
            const li = document.createElement('li');
            li.textContent = [item.en, item.zh].filter(Boolean).join(' — ');
            dom.resultExamples.appendChild(li);
        }
        dom.resultExamples.classList.toggle('hidden', examples.length === 0);
    }
    if (dom.resultMeta) {
        dom.resultMeta.textContent = t('extension.resultMetaLabel', {
            model: result.model || '',
            thinking: thinkingLabel(result.thinking)
        });
    }
}

function renderReadiness() {
    const wordText = dom.wordInput ? dom.wordInput.value : '';
    const readiness = getExtensionReadiness({ text: wordText, sentence: dom.sentenceInput?.value, context: dom.contextInput?.value });
    dom.requery.hidden = !wordText.trim();
    dom.requery.disabled = !readiness.loggedIn || !!activeLookupController;
    dom.requery.setAttribute('aria-busy', String(!!activeLookupController));
    aiControls.render(readiness, { busy: !!activeLookupController, hasQuery: !!wordText.trim() });
    const identity = readiness.loggedIn ? readiness.scope.key : '';
    const accountDetails = document.getElementById('ext-account-details');
    if (identity !== lastAccountIdentity) {
        lastAccountIdentity = identity;
        if (accountDetails) accountDetails.open = !readiness.loggedIn;
    }
    if (isEmbedded) {
        const status = document.getElementById('ext-inline-status');
        status.hidden = readiness.loggedIn;
        if (!readiness.loggedIn) status.textContent = t('extension.inlineLoginRequired');
    }

    if (dom.endpointInput && document.activeElement !== dom.endpointInput && readiness.endpoint) {
        dom.endpointInput.value = readiness.endpoint;
    }

    const homeStatus = document.getElementById('ext-home-status');
    if (homeStatus) homeStatus.textContent = readiness.loggedIn ? t('extension.statusConnected', { user: readiness.label || readiness.userId }) : t('extension.statusDisconnected');
    if (dom.accountStatus) {
        dom.accountStatus.textContent = readiness.loggedIn
            ? t('extension.statusConnected', { user: readiness.label || readiness.userId })
            : t('extension.statusDisconnected');
    }

    if (dom.catalogStatus) {
        dom.catalogStatus.textContent = readiness.catalog.usable
            ? t('extension.statusCatalogReady', { version: readiness.catalog.version })
            : t('extension.statusCatalogUnavailable', { status: t(({ idle: 'extension.catalogIdle', unauthenticated: 'extension.catalogLoginRequired', verified: 'extension.catalogVerified', offline: 'extension.catalogOffline', expired: 'extension.catalogExpired', error: 'extension.catalogError', 'weak-passcode': 'extension.catalogWeakPasscode' })[readiness.catalog.status] || 'extension.catalogIdle') });
    }

    if (dom.taskStatus) {
        const tr = readiness.taskResolution;
        if (tr.status === 'ready' || (tr.source === 'managed' && readiness.catalog.usable && tr.model)) {
            dom.taskStatus.textContent = t('extension.resolvedTaskLabel', {
                provider: tr.providerLabel || tr.provider,
                model: tr.model,
                thinking: thinkingLabel(tr.thinking)
            });
        } else {
            dom.taskStatus.textContent = t('extension.resolvedTaskMissing', {
                reason: t(getAIErrorTranslationKey(tr.errorCode) || 'errors.aiRequestFailed')
            });
        }
    }

    if (dom.logoutBtn) dom.logoutBtn.disabled = !readiness.loggedIn;
    if (dom.syncBtn) dom.syncBtn.disabled = !readiness.loggedIn;

    const missingList = readiness.missingLocalKeyProviders || [];
    if (dom.missingKeyBanner) {
        if (readiness.loggedIn && missingList.length > 0) {
            dom.missingKeyBanner.classList.remove('hidden');
            const names = missingList.map((p) => p.label || p.id).join(', ');
            if (dom.missingKeyDesc) {
                const failure = missingList.find((item) => item.credentialState === 'binding-mismatch')
                    || missingList.find((item) => item.lastError);
                dom.missingKeyDesc.textContent = t(failure ? credentialErrorKey(failure.lastError) : 'extension.missingKeyBannerDesc', { provider: names });
            }
            if (dom.importProviderSelect) {
                const prev = dom.importProviderSelect.value;
                dom.importProviderSelect.innerHTML = '';
                for (const p of missingList) {
                    const opt = document.createElement('option');
                    opt.value = p.id;
                    opt.textContent = `${p.label} (${p.id})`;
                    dom.importProviderSelect.appendChild(opt);
                }
                if (prev && missingList.some((p) => p.id === prev)) {
                    dom.importProviderSelect.value = prev;
                }
            }
        } else {
            dom.missingKeyBanner.classList.add('hidden');
        }
    }
    return readiness;
}

async function handleConnect() {
    if (!dom.connectBtn) return;
    invalidateLookup();
    workspaceUI.setReady(false);
    dom.connectBtn.disabled = true;
    dom.connectBtn.textContent = t('extension.connecting');
    showAccountNotice('info', '');
    try {
        const endpoint = dom.endpointInput ? dom.endpointInput.value.trim() : '';
        const mode = dom.loginMode ? dom.loginMode.value : 'password';
        const username = dom.usernameInput ? dom.usernameInput.value.trim() : '';
        const password = dom.passwordInput ? dom.passwordInput.value : '';
        const token = dom.tokenInput ? dom.tokenInput.value.trim() : '';
        const loginCode = dom.codeInput ? dom.codeInput.value.trim() : '';
        const readiness = await connectExtensionAccount({
            endpoint,
            mode,
            username,
            password,
            token,
            loginCode
        });
        if (dom.passwordInput) dom.passwordInput.value = '';
        if (dom.tokenInput) dom.tokenInput.value = '';
        if (dom.codeInput) dom.codeInput.value = '';
        reportSync(readiness, 'sync.loginSuccess');
        renderReadiness();
    } catch (error) {
        showFailure(showAccountNotice, error);
        renderReadiness();
    } finally {
        workspaceUI.setReady(true);
        dom.connectBtn.disabled = false;
        dom.connectBtn.textContent = t('extension.connectBtn');
    }
}

async function handleSync() {
    if (!dom.syncBtn) return;
    invalidateLookup();
    workspaceUI.setReady(false);
    dom.syncBtn.disabled = true;
    dom.syncBtn.textContent = t('extension.syncing');
    showAccountNotice('info', '');
    try {
        const readiness = await syncExtensionAccountAI();
        reportSync(readiness, 'sync.syncDone');
        renderReadiness();
    } catch (error) {
        showFailure(showAccountNotice, error);
        renderReadiness();
    } finally {
        workspaceUI.setReady(true);
        dom.syncBtn.disabled = false;
        dom.syncBtn.textContent = t('extension.syncBtn');
        renderReadiness();
    }
}

async function handleLogout() {
    invalidateLookup();
    await disconnectExtensionAccount();
    showAccountNotice('info', 'sync.loggedOut');
    showLookupNotice('info', '');
    renderReadiness();
}

function handleImportKey() {
    const providerId = dom.importProviderSelect ? dom.importProviderSelect.value : '';
    const apiKey = dom.importKeyInput ? dom.importKeyInput.value.trim() : '';
    try {
        importScopedLocalProviderKey({ providerId, apiKey });
        if (dom.importKeyInput) dom.importKeyInput.value = '';
        showAccountNotice('info', 'extension.importKeySuccess', { provider: providerId });
        renderReadiness();
    } catch (error) {
        showFailure(showAccountNotice, error);
    }
}

async function handleExtractFromTab() {
    captureUI.setSource(null);
    invalidateLookup();
    const sequence = activeLookupSequence;
    if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.scripting) {
        showLookupNotice('info', 'extension.extractRestrictedHint');
        return;
    }
    try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const activeTab = tabs && tabs.find((tab) => tab && tab.id && !String(tab.url || '').startsWith('chrome-extension://'));
        const targetTab = activeTab || (tabs && tabs[0]);
        if (!targetTab || !targetTab.id || /^(chrome|edge|about|chrome-extension):/i.test(String(targetTab.url || ''))) {
            showLookupNotice('info', 'extension.extractRestrictedHint');
            return;
        }
        const injected = await chrome.scripting.executeScript({
            target: { tabId: targetTab.id },
            func: extractActivePageSelectionInTab
        });
        if (sequence !== activeLookupSequence) return;
        const res = injected && injected[0] ? injected[0].result : null;
        if (!res || res.ok === false || res.restricted) {
            showLookupNotice('info', 'extension.extractRestrictedHint');
            return;
        }
        if (res.empty || !res.text) {
            showLookupNotice('info', 'extension.extractEmptyHint');
            return;
        }
        if (dom.wordInput) dom.wordInput.value = res.text;
        if (dom.sentenceInput) dom.sentenceInput.value = res.sentence || '';
        if (dom.contextInput) dom.contextInput.value = res.context || '';
        captureUI.setSource(res);
        showLookupNotice('info', 'extension.extractSuccess');
        renderReadiness();
    } catch (_) {
        showLookupNotice('info', 'extension.extractRestrictedHint');
    }
}

function prepareLookupAccount() {
    if (!lookupSetupPromise) {
        const pending = syncExtensionAccountAI();
        lookupSetupPromise = pending;
        pending.catch(() => { if (lookupSetupPromise === pending) lookupSetupPromise = null; });
    }
    return lookupSetupPromise;
}

async function handleLookup({ noCache: forceRefresh = false } = {}) {
    aiControls.clearFallback();
    clearDisplayedResult();
    const seq = ++activeLookupSequence;
    if (activeLookupController) {
        try { activeLookupController.abort(); } catch (_) {}
    }
    const controller = new AbortController();
    activeLookupController = controller;

    if (dom.lookupBtn) {
        dom.lookupBtn.disabled = true;
        dom.lookupBtn.textContent = t('extension.lookingUp');
    }
    inlineUI?.render();
    showLookupNotice('info', '');
    renderReadiness();

    const text = dom.wordInput ? dom.wordInput.value.trim() : '';
    const sentence = dom.sentenceInput ? dom.sentenceInput.value.trim() : '';
    const context = dom.contextInput ? dom.contextInput.value.trim() : '';
    const noCache = forceRefresh || !!(dom.forceRefresh && dom.forceRefresh.checked);
    if (isEmbedded) dom.resultEmpty.textContent = t('extension.inlineLookingUp', { word: text });

    try {
        const input = {
            text,
            sentence,
            context,
            locale: getLocale(),
            signal: controller.signal,
            noCache
        };
        let result = noCache ? null : await readExtensionLookupCache(input);
        if (!result) {
            await prepareLookupAccount();
            controller.signal.throwIfAborted();
            if (seq !== activeLookupSequence) return;
            result = await runExtensionLookup(input);
        }
        if (seq !== activeLookupSequence) return;
        renderResult(result);
        captureUI.showResult(result, { text, sentence, context }, getLocale());
        renderReadiness();
        return result;
    } catch (error) {
        if (seq !== activeLookupSequence) return;
        clearDisplayedResult();
        showFailure(showLookupNotice, error);
        renderReadiness();
    } finally {
        if (activeLookupController === controller && dom.lookupBtn) {
            activeLookupController = null;
            dom.lookupBtn.disabled = false;
            dom.lookupBtn.textContent = t('extension.lookupBtn');
        }
        inlineUI?.render();
        renderReadiness();
    }
}

function refreshLocalizedView() {
    if (requestedView === 'article') {
        document.getElementById('ext-title').dataset.i18n = 'extension.pageArticleTitle';
    }
    applyTranslations(document);
    captureUI.translate();
    workspaceUI.render();
    inlineUI?.render();
    assistantUI?.render();
    chrome.storage.local.set({ bdc_extension_ui_locale: getLocale() }).catch(() => {});
    globalThis.chrome?.action?.setTitle({ title: t('extension.manifestTitle') }).catch(() => {});
    if (dom.localeSelect) dom.localeSelect.value = getLocale();
    renderReadiness();
    if (lastResultPayload) renderResult(lastResultPayload);
    if (lastAccountNotice) {
        setNotice(dom.accountNotice, lastAccountNotice.kind, lastAccountNotice.keyOrText, lastAccountNotice.params, lastAccountNotice.isRawText);
        setNotice(document.getElementById('ext-home-notice'), lastAccountNotice.kind,
            lastAccountNotice.kind === 'error' ? lastAccountNotice.keyOrText : '', lastAccountNotice.params, lastAccountNotice.isRawText);
    }
    if (lastLookupNotice) {
        setNotice(dom.lookupNotice, lastLookupNotice.kind, lastLookupNotice.keyOrText, lastLookupNotice.params, lastLookupNotice.isRawText);
    }
}

async function initExtensionPage() {
    initI18n();
    const savedUI = await chrome.storage.local.get(['bdc_extension_ui_locale', 'bdc_extension_assistant_enabled']);
    if (savedUI.bdc_extension_ui_locale) setLocale(savedUI.bdc_extension_ui_locale, { persist: true });
    const assistantToggle = document.getElementById('ext-assistant-enabled');
    if (assistantToggle) {
        assistantToggle.checked = savedUI.bdc_extension_assistant_enabled !== false;
        assistantToggle.addEventListener('change', () => chrome.storage.local.set({ bdc_extension_assistant_enabled: assistantToggle.checked }));
    }
    await restoreTrustedSessionState();
    syncLoginModeFields();
    refreshLocalizedView();

    dom.localeSelect?.addEventListener('change', (e) => {
        invalidateLookup();
        setLocale(e.target.value, { persist: true });
        refreshLocalizedView();
    });
    dom.openTabBtn?.addEventListener('click', () => {
        try {
            if (typeof chrome !== 'undefined' && chrome.tabs?.create) {
                chrome.tabs.create({ url: chrome.runtime.getURL('lookup.html') });
            } else {
                window.open(location.href, '_blank');
            }
        } catch (_) {}
    });
    dom.loginMode?.addEventListener('change', syncLoginModeFields);
    dom.endpointInput?.addEventListener('change', async () => {
        invalidateLookup();
        await setExtensionSyncEndpoint(dom.endpointInput.value.trim());
        renderReadiness();
    });
    dom.connectBtn?.addEventListener('click', handleConnect);
    dom.syncBtn?.addEventListener('click', handleSync);
    dom.logoutBtn?.addEventListener('click', handleLogout);
    dom.importKeyBtn?.addEventListener('click', handleImportKey);
    dom.extractBtn?.addEventListener('click', handleExtractFromTab);
    dom.lookupBtn?.addEventListener('click', handleLookup);
    dom.requery.addEventListener('click', () => handleLookup({ noCache: true }));
    dom.resultSpeak.addEventListener('click', togglePronunciation);
    window.addEventListener('pagehide', stopPronunciation);
    document.addEventListener('visibilitychange', () => { if (document.hidden) stopPronunciation(); });
    document.getElementById('ext-enable-inline').addEventListener('click', async () => {
        const response = await chrome.runtime.sendMessage({ type: 'BDC_ENABLE_INLINE' }).catch(() => null);
        showAccountNotice(response?.ok ? 'info' : 'error', response?.ok ? 'extension.inlineEnabled' : 'extension.inlineUnavailable');
    });
    for (const id of ['ext-inline-settings', 'ext-settings-open']) document.getElementById(id)?.addEventListener('click', () => openDialog('ext-settings-dialog'));
    document.getElementById('ext-inline-edit')?.addEventListener('click', () => openDialog('ext-query-dialog'));
    document.getElementById('ext-book-settings')?.addEventListener('click', () => openDialog('ext-book-dialog'));
    for (const [id, closeId] of [['ext-settings-dialog', 'ext-settings-close'], ['ext-query-dialog', 'ext-query-close'], ['ext-book-dialog', 'ext-book-close']]) {
        const dialog = document.getElementById(id);
        document.getElementById(closeId)?.addEventListener('click', () => dialog.close());
        dialog?.addEventListener('close', () => {
            // Native close events are queued. A quick reopen must retain its
            // own layout rather than applying the previous close afterwards.
            if (dialog.open) return;
            if (id === 'ext-query-dialog' && querySnapshot && !querySubmitted) {
                const previous = querySnapshot;
                dom.wordInput.value = previous.text; dom.sentenceInput.value = previous.sentence; dom.contextInput.value = previous.context;
                captureUI.setSource(previous.source);
                if (previous.result) {
                    renderResult(previous.result);
                    captureUI.showResult(previous.result, previous, getLocale());
                }
                inlineUI?.clearQueryDraft();
                renderReadiness();
            }
            if (id === 'ext-query-dialog') {
                querySnapshot = null;
                document.body.classList.remove('ext-edit-query');
            }
            if (document.querySelector('dialog[open]')) return;
            document.body.classList.remove('ext-modal-open');
            if (savedDialogMode) inlineUI?.setMode(savedDialogMode);
            savedDialogMode = null;
        });
    }
    document.getElementById('ext-inline-ai')?.addEventListener('click', () => openAssistant(true));
    document.getElementById('ext-home-assistant')?.addEventListener('click', () => openAssistant());
    document.getElementById('ext-home-article')?.addEventListener('click', openWorkspace);
    document.getElementById('ext-home-book')?.addEventListener('click', () => openBook(true));
    document.getElementById('ext-open-book')?.addEventListener('click', () => openBook());
    document.getElementById('ext-open-source')?.addEventListener('click', () => {
        const url = publicSourceUrl(captureState.source?.pageUrl);
        if (url) chrome.tabs.create({ url });
    });
    dom.lookupBtn.addEventListener('click', () => { querySubmitted = true; document.getElementById('ext-query-dialog')?.close(); });
    window.addEventListener('beforeunload', (event) => {
        if (isWorkspaceWindow && (workspaceState.busy || workspaceState.hasDraft)) { event.preventDefault(); event.returnValue = ''; }
    });
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.bdc_extension_assistant_enabled && assistantToggle) assistantToggle.checked = changes.bdc_extension_assistant_enabled.newValue !== false;
    });
    for (const input of [dom.wordInput, dom.sentenceInput, dom.contextInput]) {
        input?.addEventListener('input', () => {
            if (captureState.source?.anchor) {
                // Keep the article link after a correction, but do not claim
                // that edited text still has the original exact DOM offsets.
                captureUI.setSource({ ...captureState.source, anchor: null });
            }
            invalidateLookup();
            renderReadiness();
        });
    }
    window.addEventListener('storage', (event) => {
        if (event.key === null || event.key === EXTENSION_ENDPOINT_STORAGE_KEY) {
            invalidateLookup();
            renderReadiness();
        }
        if (event.key?.startsWith(EXTENSION_AI_PREFERENCES_PREFIX) || event.key?.startsWith('bdc_ai_profile_v1:')) renderReadiness();
    });
    window.addEventListener('bdc:extension-endpoint-change', () => {
        invalidateLookup();
        renderReadiness();
    });

    window.addEventListener(AUTH_EVENT, (ev) => {
        const kind = ev?.detail?.event || '';
        if (['SIGNED_IN', 'ACCOUNT_CHANGED', 'SIGNED_OUT', 'SESSION_INVALID'].includes(kind)) lookupSetupPromise = null;
        if (kind === 'ACCOUNT_CHANGED' || kind === 'SIGNED_OUT' || kind === 'SESSION_INVALID') {
            invalidateLookup();
        }
        if (['SIGNED_IN', 'ACCOUNT_CHANGED', 'SIGNED_OUT', 'SESSION_INVALID'].includes(kind)) {
            captureUI.sync().catch(() => {});
        }
        renderReadiness();
    });
    window.addEventListener('bdc:ai-catalog-change', () => renderReadiness());
    window.addEventListener('bdc:ai-settings-applied', () => renderReadiness());
    window.addEventListener('bdc:ai-credential-sync', () => renderReadiness());
    window.addEventListener('bdc:ai-thinking-fallback', (event) => aiControls.notifyThinkingFallback(event.detail));
    let articleWasBusy = false;
    workspaceUI.subscribe((status) => {
        if (status.busy && !articleWasBusy) aiControls.clearFallback();
        articleWasBusy = !!status.busy;
    });
    // Book lists and durable outboxes may use the network. A local lookup hit
    // must be visible before either finishes loading.
    const captureStartup = captureUI.sync();
    const workspaceOnlyStartup = workspaceUI.sync();
    const workspaceStartup = Promise.allSettled([captureStartup, workspaceOnlyStartup]);
    if (!isWorkspaceWindow) workspaceUI.setReady(true);
    if (inlineContext) {
        const page = inlineContext.page;
        dom.wordInput.value = page.text; dom.sentenceInput.value = page.sentence || ''; dom.contextInput.value = page.context || '';
        captureUI.setSource(page);
        if (requestedView === 'assistant') {
            await workspaceStartup;
            if (getExtensionReadiness().loggedIn) await syncExtensionAccountAI();
            await openAssistant();
        } else if (isWorkspaceWindow) {
            // Previous confirmed jobs must settle, but the article preview
            // does not need the capture book list to finish loading.
            await Promise.allSettled([workspaceOnlyStartup]);
            if (getExtensionReadiness().loggedIn) {
                try { await syncExtensionAccountAI({ forceCatalog: false }); }
                catch (error) { workspaceUI.setReady(true, error); return; }
                workspaceUI.setReady(true);
                if (pageParameters.has('import')) await workspaceUI.importPage();
            } else { workspaceUI.setReady(true); openDialog('ext-settings-dialog'); }
        } else if (getExtensionReadiness().loggedIn) {
            dom.resultEmpty.textContent = t('extension.inlineLookingUp', { word: page.text });
            try {
                const result = await handleLookup();
                if (result?.fromCache) prepareLookupAccount().catch((error) => showFailure(showAccountNotice, error));
            }
            catch (error) { clearDisplayedResult(); showFailure(showLookupNotice, error); }
        } else {
            const status = document.getElementById('ext-inline-status');
            status.hidden = false; status.textContent = t('extension.inlineLoginRequired');
        }
    }
    await workspaceStartup;
}

// Expose shared lookup & runtime helpers on globalThis for deterministic extension E2E verification
globalThis.__bdcExtensionRuntime = {
    lookupSelection,
    runExtensionLookup,
    connectExtensionAccount,
    disconnectExtensionAccount,
    syncExtensionAccountAI,
    importScopedLocalProviderKey,
    getExtensionReadiness,
    setExtensionSyncEndpoint,
    getExtensionSyncEndpoint
};

initExtensionPage().catch((err) => {
    console.error('[bdc-extension] init failed:', err);
});
