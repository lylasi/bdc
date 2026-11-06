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
import { EXTENSION_AI_PREFERENCES_PREFIX } from './modules/extension-ai-preferences.js';

const pageParameters = new URLSearchParams(location.search);
const isEmbedded = window.parent !== window;
const inlineTicket = pageParameters.get('ticket') || '';
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
    resultPhonetic: document.getElementById('ext-result-phonetic'),
    resultPos: document.getElementById('ext-result-pos'),
    resultMeaning: document.getElementById('ext-result-meaning'),
    resultRole: document.getElementById('ext-result-role'),
    resultExamples: document.getElementById('ext-result-examples'),
    resultMeta: document.getElementById('ext-result-meta'),
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

let activeLookupSequence = 0;
let activeLookupController = null;
let lastResultPayload = null;
let lastAccountNotice = null;
let lastLookupNotice = null;
let lastAccountIdentity = null;
const inlineUI = isEmbedded ? createInlinePanel({
    more: document.getElementById('ext-inline-more'), back: document.getElementById('ext-inline-back'),
    close: document.getElementById('ext-inline-close'), confirm: document.getElementById('ext-inline-confirm'),
    confirmText: document.getElementById('ext-inline-confirm-text'), keep: document.getElementById('ext-inline-keep'),
    discard: document.getElementById('ext-inline-discard'), quick: document.getElementById('ext-quick-capture'),
    retry: document.getElementById('ext-inline-retry'), actionNotice: document.getElementById('ext-inline-action-notice'),
    captureBook: dom.captureBook, lookup: dom.lookupBtn, queryInputs: [dom.wordInput, dom.sentenceInput, dom.contextInput]
}, captureUI, workspaceUI, { ticket: inlineTicket, restoreQuery: () => {
    const page = inlineContext.page;
    dom.wordInput.value = page.text; dom.sentenceInput.value = page.sentence || ''; dom.contextInput.value = page.context || '';
    captureUI.setSource(page); renderReadiness();
} }) : null;
const aiControls = createAIControls({ embedded: isEmbedded, onChange: renderReadiness, onLookup: handleLookup });

function setNotice(el, kind, keyOrText, params = {}, isRawText = false) {
    if (!el) return;
    if (!keyOrText) {
        el.classList.add('hidden');
        el.textContent = '';
        return;
    }
    el.classList.remove('hidden', 'ext-notice-error', 'ext-notice-info');
    el.classList.add(kind === 'error' ? 'ext-notice-error' : 'ext-notice-info');
    el.textContent = isRawText ? String(keyOrText) : t(keyOrText, params);
}

function showAccountNotice(kind, keyOrText, params = {}, isRawText = false) {
    lastAccountNotice = keyOrText ? { kind, keyOrText, params, isRawText } : null;
    setNotice(dom.accountNotice, kind, keyOrText, params, isRawText);
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
    captureUI.clearResult();
    lastResultPayload = null;
    dom.resultEmpty?.classList.remove('hidden');
    if (dom.resultEmpty) dom.resultEmpty.textContent = t('extension.resultEmpty');
    dom.resultBox?.classList.add('hidden');
    if (dom.resultWord) dom.resultWord.textContent = '';
    if (dom.resultPhonetic) dom.resultPhonetic.textContent = '';
    if (dom.resultPos) dom.resultPos.textContent = '';
    if (dom.resultMeaning) dom.resultMeaning.textContent = '';
    if (dom.resultRole) dom.resultRole.textContent = '';
    if (dom.resultExamples) dom.resultExamples.innerHTML = '';
    if (dom.resultMeta) dom.resultMeta.textContent = '';
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
    dom.resultEmpty?.classList.add('hidden');
    dom.resultBox?.classList.remove('hidden');
    if (dom.resultWord) dom.resultWord.textContent = result.text || result.word || '';
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
        dom.resultMeaning.textContent = `${t('extension.resultMeaningLabel')}：${result.meaning}`;
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
        dom.connectBtn.disabled = false;
        dom.connectBtn.textContent = t('extension.connectBtn');
    }
}

async function handleSync() {
    if (!dom.syncBtn) return;
    invalidateLookup();
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

async function handleLookup() {
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
    const noCache = !!(dom.forceRefresh && dom.forceRefresh.checked);
    if (isEmbedded) dom.resultEmpty.textContent = t('extension.inlineLookingUp', { word: text });

    try {
        const result = await runExtensionLookup({
            text,
            sentence,
            context,
            locale: getLocale(),
            signal: controller.signal,
            noCache
        });
        if (seq !== activeLookupSequence) return;
        renderResult(result);
        captureUI.showResult(result, { text, sentence, context }, getLocale());
        renderReadiness();
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
    applyTranslations(document);
    captureUI.translate();
    workspaceUI.render();
    inlineUI?.render();
    chrome.storage.local.set({ bdc_extension_ui_locale: getLocale() }).catch(() => {});
    globalThis.chrome?.action?.setTitle({ title: t('extension.manifestTitle') }).catch(() => {});
    if (dom.localeSelect) dom.localeSelect.value = getLocale();
    renderReadiness();
    if (lastResultPayload) renderResult(lastResultPayload);
    if (lastAccountNotice) {
        setNotice(dom.accountNotice, lastAccountNotice.kind, lastAccountNotice.keyOrText, lastAccountNotice.params, lastAccountNotice.isRawText);
    }
    if (lastLookupNotice) {
        setNotice(dom.lookupNotice, lastLookupNotice.kind, lastLookupNotice.keyOrText, lastLookupNotice.params, lastLookupNotice.isRawText);
    }
}

async function initExtensionPage() {
    initI18n();
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
    document.getElementById('ext-enable-inline').addEventListener('click', async () => {
        const response = await chrome.runtime.sendMessage({ type: 'BDC_ENABLE_INLINE' }).catch(() => null);
        showAccountNotice(response?.ok ? 'info' : 'error', response?.ok ? 'extension.inlineEnabled' : 'extension.inlineUnavailable');
    });
    document.getElementById('ext-inline-settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
    document.getElementById('ext-inline-edit').addEventListener('click', () => { inlineUI?.expand(); document.body.classList.toggle('ext-edit-query'); });
    for (const input of [dom.wordInput, dom.sentenceInput, dom.contextInput]) {
        input?.addEventListener('input', () => {
            captureUI.setSource(null);
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
    await captureUI.sync();
    await workspaceUI.sync();
    if (inlineContext) {
        const page = inlineContext.page;
        dom.wordInput.value = page.text; dom.sentenceInput.value = page.sentence || ''; dom.contextInput.value = page.context || '';
        captureUI.setSource(page);
        if (getExtensionReadiness().loggedIn) {
            dom.resultEmpty.textContent = t('extension.inlineLookingUp', { word: page.text });
            try { await syncExtensionAccountAI(); await handleLookup(); }
            catch (error) { clearDisplayedResult(); showFailure(showLookupNotice, error); }
        } else {
            const status = document.getElementById('ext-inline-status');
            status.hidden = false; status.textContent = t('extension.inlineLoginRequired');
        }
    }
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
