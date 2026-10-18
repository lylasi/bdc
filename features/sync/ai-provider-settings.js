// AI provider settings UI.
//
// The default surface is deliberately small: "service URL + API key → connect
// → pick a model → save". Names and IDs are generated, protocol/endpoint
// overrides and manual models live under advanced settings, and per-task model
// choices stay in a collapsed section.

import {
    loadAIProfile,
    importGuestProviders
} from '../../modules/ai-profile-storage.js';
import {
    savePersonalProvider,
    deletePersonalProvider,
    setProviderKeySyncMode,
    resolveCredentialConflict,
    getProviderKeyStatus,
    getCredentialSyncState,
    subscribeCredentialSync,
    syncCredentials
} from '../../modules/ai-credential-sync.js';
import {
    getCatalogState,
    getManagedProviders,
    subscribeAICatalog,
    refreshAICatalog
} from '../../modules/ai-catalog.js';
import {
    getTaskModelSelection,
    saveTaskModelSelection,
    setPersonalDefaultModel,
    getPersonalDefaultModel,
    getAllowedModelOptions
} from '../../modules/ai-models.js';
import {
    detectProvider,
    testProviderModel,
    buildProviderDefinition,
    describeDetectionError
} from '../../modules/ai-protocols/index.js';
import { getAuthSnapshot, AUTH_EVENT } from '../../modules/sync-cloudflare.js';
import { t, formatDateTime } from '../../modules/i18n.js';
import { renderModelPicker, bindModelPicker } from '../../modules/ai-model-picker.js';
import { captureDetailState, restoreDetailState } from '../../modules/detail-state.js';
import { openAiAdminPanel } from '../ai-admin/ai-admin.js';

export const AI_TASK_FIELDS = [
    { key: 'wordAnalysis', labelKey: 'settings.taskWord' },
    { key: 'sentenceChecking', labelKey: 'settings.taskSentence' },
    { key: 'qaChecking', labelKey: 'settings.taskQa' },
    { key: 'articleAnalysis', labelKey: 'settings.taskArticle' },
    { key: 'articleCleanup', labelKey: 'settings.taskCleanup' },
    { key: 'exampleGeneration', labelKey: 'settings.taskExamples' },
    { key: 'imageOCR', labelKey: 'settings.taskOcr' },
    { key: 'assistant', labelKey: 'settings.taskAssistant' }
];

function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function hostFromUrl(value) {
    try { return new URL(value).hostname; } catch (_) { return ''; }
}

function deriveLabel(url, existingLabels = []) {
    const host = hostFromUrl(url);
    let base = host;
    if (!/^[\d.]+$/.test(host) && !/^localhost$/i.test(host) && !host.includes(':')) {
        base = host.replace(/^www\./i, '').replace(/^api\./i, '').split('.')[0];
    }
    base = (base || host || t('settings.aiUnnamed')).slice(0, 40);
    if (!existingLabels.includes(base)) return base;
    let index = 2;
    while (existingLabels.includes(`${base} ${index}`)) index += 1;
    return `${base} ${index}`;
}

function newProviderId() {
    try {
        if (crypto && crypto.randomUUID) return `personal-${crypto.randomUUID()}`;
    } catch (_) {}
    return `personal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function authModeOptions(selected) {
    const modes = [
        ['bearer', 'settings.aiAuthBearer'],
        ['x-api-key', 'settings.aiAuthXApiKey'],
        ['google', 'settings.aiAuthGoogle'],
        ['none', 'settings.aiAuthNone']
    ];
    return modes.map(([value, key]) => `<option value="${value}" ${selected === value ? 'selected' : ''}>${escapeHtml(t(key))}</option>`).join('');
}

function formatOptions(selected) {
    const rows = [
        ['auto', 'settings.aiProtocolAuto'],
        ['openai-chat', 'settings.aiFormatChat'],
        ['anthropic-messages', 'settings.aiFormatAnthropic'],
        ['gemini', 'settings.aiFormatGemini']
    ];
    return rows.map(([value, key]) => `<option value="${value}" ${selected === value ? 'selected' : ''}>${escapeHtml(t(key))}</option>`).join('');
}

function providerFormatLabel(format) {
    if (format === 'anthropic-messages') return t('settings.aiFormatAnthropic');
    if (format === 'gemini') return t('settings.aiFormatGemini');
    return t('settings.aiFormatChat');
}

function syncModeLabel(mode) {
    if (mode === 'cloud') return t('settings.aiKeySynced');
    if (mode === 'cloud-removal-pending') return t('settings.aiKeyRemovePending');
    if (mode === 'local-only') return t('settings.aiKeyLocalOnly');
    return t('settings.aiProviderThisDevice');
}

function formatTime(value) {
    if (!value) return '';
    try { return formatDateTime(value, { hour12: false }); } catch (_) { return ''; }
}

function readDraftProvider(form, profile) {
    const existing = form.providerId ? profile.providers[form.providerId] : null;
    const connection = form.connection ? form.connection.provider : null;
    const format = connection?.format
        || (form.format && form.format !== 'auto' ? form.format : (existing?.format || 'openai-chat'));
    const baseUrl = String(form.url || existing?.baseUrl || '').trim();
    const keepExistingEndpoints = !!existing && !form.urlChanged && !form.apiUrlEdited && !form.modelsUrlEdited;
    const apiUrlOverride = form.apiUrlEdited ? String(form.apiUrl || '').trim() : (keepExistingEndpoints ? existing.apiUrl : '');
    const modelsUrlOverride = form.modelsUrlEdited ? String(form.modelsUrl || '').trim() : (keepExistingEndpoints ? existing.modelsUrl : '');
    let endpoints;
    const desiredAuth = form.authMode || connection?.authMode || existing?.authMode || (form.apiKey ? '' : 'none');
    const keyForBuild = form.apiKey || (existing && existing.authMode !== 'none' ? '__keep__' : '');
    try {
        endpoints = buildProviderDefinition({
            format,
            baseUrl: connection?.baseUrl || baseUrl,
            apiUrl: apiUrlOverride || connection?.apiUrl || '',
            modelsUrl: modelsUrlOverride || connection?.modelsUrl || '',
            authMode: desiredAuth,
            apiKey: keyForBuild
        });
    } catch (error) {
        throw Object.assign(new Error('endpoint invalid'), { code: error.code || 'url_invalid' });
    }
    return {
        id: form.providerId || '',
        label: String(form.name || '').trim() || deriveLabel(endpoints.baseUrl || baseUrl, Object.values(profile.providers).map((item) => item.label)),
        enabled: existing ? existing.enabled !== false : true,
        format: endpoints.format,
        baseUrl: endpoints.baseUrl,
        apiUrl: endpoints.apiUrl,
        modelsUrl: endpoints.modelsUrl,
        authMode: endpoints.authMode,
        allowedModels: form.allowedModels || [],
        allowCrossOriginModels: form.allowCrossOriginModels === true,
        discoveredModels: form.models || [],
        lastDiscoveryAt: form.connectedAt || existing?.lastDiscoveryAt || '',
        discoveryStatus: form.models && form.models.length ? 'success' : (form.errorCode ? 'error' : (existing?.discoveryStatus || '')),
        origin: existing?.origin || 'personal',
        createdAt: existing?.createdAt || '',
        updatedAt: new Date().toISOString()
    };
}

/**
 * Mount the provider settings section.
 * @param {HTMLElement} host
 * @param {{ onRequestLogin?: Function, onNotice?: Function }} options
 */
export function mountAIProviderSettings(host, options = {}) {
    if (!host) return { destroy() {} };
    let form = null;
    let pendingDelete = '';
    let importOpen = false;
    let notice = '';
    let noticeType = 'info';
    let testConfirm = false;
    let destroyed = false;
    // 「按功能指定模型」是折疊區塊；記住使用者的展開選擇，避免每次選模型後折回去。
    let taskDetailsOpen = false;

    const setNotice = (message, type = 'info') => {
        notice = message;
        noticeType = type;
    };

    const existingKeyFor = (providerId) => {
        if (!providerId) return '';
        const profile = loadAIProfile();
        return profile.credentials[providerId]?.apiKey || '';
    };

    const connectedModels = (formState) => {
        if (!formState) return [];
        const rows = [];
        const seen = new Set();
        for (const model of formState.models || []) {
            const id = String(model.id || model || '').trim();
            if (!id || seen.has(id)) continue;
            seen.add(id);
            rows.push({ id, label: model.label || id });
        }
        for (const id of formState.manualModels || []) {
            const value = String(id || '').trim();
            if (!value || seen.has(value)) continue;
            seen.add(value);
            rows.push({ id: value, label: value });
        }
        return rows;
    };

    function renderManaged(catalog) {
        const loggedIn = catalog.loggedIn;
        const providers = getManagedProviders({ includeDisabled: true });
        let statusText = '';
        let statusClass = 'muted';
        if (!loggedIn) {
            statusText = t('settings.aiLoginRequired');
        } else if (catalog.status === 'verified') {
            const minutes = Math.max(1, Math.ceil((catalog.expiresAt - Date.now()) / 60000));
            statusText = t('settings.aiSessionValid', { minutes });
            statusClass = 'success';
        } else if (catalog.status === 'expired') {
            statusText = t('settings.aiSessionExpired');
            statusClass = 'error';
        } else if (catalog.status === 'weak-passcode') {
            statusText = t('settings.aiSessionWeakPasscode');
            statusClass = 'error';
        } else if (catalog.status === 'offline' || catalog.status === 'error') {
            statusText = t('settings.aiSessionOffline');
            statusClass = 'error';
        } else {
            statusText = t('settings.aiSessionPending');
        }
        const list = providers.length
            ? providers.map((provider) => `
                <div class="gs-ai-managed-row">
                    <div class="gs-ai-managed-main">
                        <span class="gs-ai-provider-name">${escapeHtml(provider.name || provider.id)}</span>
                        <span class="gs-ai-badge">${escapeHtml(providerFormatLabel(provider.format))}</span>
                        <span class="gs-ai-muted">${escapeHtml(t('settings.aiModelsCount', { count: (provider.models || []).length }))}</span>
                        ${provider.authMode === 'none' ? `<span class="gs-ai-badge">${escapeHtml(t('settings.aiNoKeyBadge'))}</span>` : ''}
                        ${provider.enabled === false ? `<span class="gs-ai-badge danger">${escapeHtml(t('settings.aiProviderDisabled'))}</span>` : ''}
                    </div>
                </div>`).join('')
            : `<div class="gs-ai-empty">${escapeHtml(loggedIn ? t('settings.aiManagedEmpty') : t('settings.aiLoginHint'))}</div>`;
        return `
            <section class="gs-ai-block">
                <div class="gs-ai-block-head">
                    <h4>${escapeHtml(t('settings.aiProvidersTitle'))}</h4>
                    <button type="button" class="btn-secondary gs-ai-small" data-ai-refresh>${escapeHtml(t('settings.aiRefresh'))}</button>
                </div>
                <div class="gs-ai-status ${statusClass}">${escapeHtml(statusText)}</div>
                <div class="gs-ai-managed-list">${list}</div>
                ${!loggedIn ? `<div class="gs-ai-actions"><button type="button" class="btn-secondary gs-ai-small" data-ai-login>${escapeHtml(t('settings.aiLoginButton'))}</button></div>` : ''}
                ${catalog.role === 'admin' ? `<div class="gs-ai-actions"><button type="button" class="btn-secondary gs-ai-small" data-ai-admin>${escapeHtml(t('settings.aiAdminEntry'))}</button></div>` : ''}
                <p class="gs-hint">${escapeHtml(t('settings.aiManagedReadonly'))}</p>
            </section>`;
    }

    function renderSyncStatus() {
        const sync = getCredentialSyncState();
        if (!getAuthSnapshot().loggedIn) return '';
        let text = t('sync.aiKeySyncIdle');
        if (sync.status === 'syncing') text = t('sync.aiKeySyncing');
        else if (sync.status === 'synced') text = t('settings.aiKeySynced');
        else if (sync.status === 'offline') text = t('settings.aiKeySyncFailed');
        else if (sync.status === 'unauthorized') text = t('errors.aiLoginRequired');
        else if (sync.status === 'weak-passcode') text = t('errors.aiPasscodeUpgrade');
        else if (sync.status === 'error') text = t('settings.aiKeySyncFailed');
        else if (sync.status === 'conflict') text = t('settings.aiKeyConflict');
        const conflicts = sync.conflicts || [];
        const pending = sync.pending || [];
        const conflictBanners = conflicts.map((providerId) => {
            const profile = loadAIProfile();
            const label = profile.providers[providerId]?.label || providerId;
            return `<div class="gs-ai-conflict">
                <div>${escapeHtml(t('settings.aiKeyConflictProvider', { name: label }))}</div>
                <div class="gs-ai-actions">
                    <button type="button" class="btn-secondary gs-ai-small" data-ai-conflict-cloud="${escapeHtml(providerId)}">${escapeHtml(t('settings.aiUseCloud'))}</button>
                    <button type="button" class="btn-secondary gs-ai-small" data-ai-conflict-local="${escapeHtml(providerId)}">${escapeHtml(t('settings.aiKeepLocal'))}</button>
                    <button type="button" class="btn-secondary gs-ai-small" data-ai-conflict-later="${escapeHtml(providerId)}">${escapeHtml(t('settings.aiLater'))}</button>
                </div>
            </div>`;
        }).join('');
        return `<div class="gs-ai-sync-line">
            <span class="gs-ai-muted">${escapeHtml(text)}${sync.lastSyncAt ? ` · ${escapeHtml(formatTime(new Date(sync.lastSyncAt).toISOString()))}` : ''}${pending.length ? ` · ${escapeHtml(t('settings.aiPendingCount', { count: pending.length }))}` : ''}</span>
            <button type="button" class="btn-secondary gs-ai-small" data-ai-sync-now>${escapeHtml(t('settings.aiSyncNow'))}</button>
        </div>${conflictBanners}`;
    }

    function renderDeleteRow(id, status) {
        if (pendingDelete !== id) return '';
        const hasCloud = status.version > 0;
        return `<div class="gs-ai-delete-confirm">
            <div>${escapeHtml(t('settings.aiDeleteConfirm'))}</div>
            <div class="gs-ai-actions">
                ${hasCloud ? `<button type="button" class="btn-secondary gs-ai-small danger" data-ai-delete-everywhere="${escapeHtml(id)}">${escapeHtml(t('settings.aiDeleteEverywhere'))}</button>
                <button type="button" class="btn-secondary gs-ai-small" data-ai-delete-device="${escapeHtml(id)}">${escapeHtml(t('settings.aiDeleteDeviceOnly'))}</button>` : `
                <button type="button" class="btn-secondary gs-ai-small danger" data-ai-delete-device="${escapeHtml(id)}">${escapeHtml(t('settings.aiDelete'))}</button>`}
                <button type="button" class="btn-secondary gs-ai-small" data-ai-delete-cancel="${escapeHtml(id)}">${escapeHtml(t('settings.cancel'))}</button>
            </div>
        </div>`;
    }

    function deviceProvidersAvailableForImport() {
        if (!getAuthSnapshot().loggedIn) return [];
        const account = loadAIProfile();
        const guest = loadAIProfile({ endpoint: '', userId: '', guest: true, key: 'bdc_ai_profile_v1:device:guest' });
        return Object.values(guest.providers).filter((provider) => !account.providers[provider.id]);
    }

    function renderImportPanel() {
        const candidates = deviceProvidersAvailableForImport();
        if (!importOpen || !candidates.length) return '';
        return `<div class="gs-ai-import">
            <div class="gs-ai-muted">${escapeHtml(t('settings.aiImportDeviceHint'))}</div>
            <div class="gs-ai-import-list">
                ${candidates.map((provider) => `<label class="gs-ai-inline">
                    <input type="checkbox" data-ai-import-id="${escapeHtml(provider.id)}" checked>
                    <span>${escapeHtml(provider.label || provider.id)}</span>
                </label>`).join('')}
            </div>
            <label class="gs-ai-inline"><input type="checkbox" data-ai-import-sync> ${escapeHtml(t('settings.aiImportSyncKeys'))}</label>
            <div class="gs-ai-actions">
                <button type="button" class="btn-primary gs-ai-small" data-ai-import-run>${escapeHtml(t('settings.aiImportSelected'))}</button>
                <button type="button" class="btn-secondary gs-ai-small" data-ai-import-cancel>${escapeHtml(t('settings.cancel'))}</button>
            </div>
        </div>`;
    }

    function renderPersonalList() {
        const profile = loadAIProfile();
        const loggedIn = getAuthSnapshot().loggedIn;
        const ids = Object.keys(profile.providers);
        if (!ids.length) {
            return `<div class="gs-ai-empty">${escapeHtml(t('settings.aiEmptyProviders'))}</div>`;
        }
        return ids.map((id) => {
            const provider = profile.providers[id];
            const status = getProviderKeyStatus(id);
            const models = (provider.allowedModels || []).length ? provider.allowedModels : (provider.discoveredModels || []).map((item) => item.id);
            const selectedDefault = profile.defaultModel && String(profile.defaultModel).startsWith(`${id}:`);
            const syncMode = status.mode === 'none' ? 'local-only' : status.mode;
            // A cloud row without a local key means the download has not
            // happened yet (new device, or the last attempt failed): do not
            // label it as "synced".
            const statusLabel = (syncMode === 'cloud' && !status.hasKey)
                ? t('settings.aiKeyAwaitingDownload')
                : syncModeLabel(syncMode);
            return `<div class="gs-ai-provider-row">
                <div class="gs-ai-provider-row-main">
                    <div class="gs-ai-provider-line">
                        <span class="gs-ai-provider-name">${escapeHtml(provider.label || id)}</span>
                        <span class="gs-ai-badge">${escapeHtml(providerFormatLabel(provider.format))}</span>
                        ${provider.authMode === 'none' ? `<span class="gs-ai-badge">${escapeHtml(t('settings.aiNoKeyBadge'))}</span>` : ''}
                        ${selectedDefault ? `<span class="gs-ai-badge success">${escapeHtml(t('settings.aiDefaultBadge'))}</span>` : ''}
                    </div>
                    <div class="gs-ai-muted">${escapeHtml(provider.baseUrl || provider.apiUrl || '')}</div>
                    <div class="gs-ai-muted">${escapeHtml(models.length ? t('settings.aiModelsCount', { count: models.length }) : t('settings.noModels'))} · ${escapeHtml(statusLabel)}</div>
                    ${status.lastError ? `<div class="gs-ai-error">${escapeHtml(t('settings.aiStatusError', { code: status.lastError }))}</div>` : ''}
                    ${status.bindingVerified === false ? `<div class="gs-ai-warning">${escapeHtml(t('settings.aiKeyEndpointChanged'))}</div>` : ''}
                </div>
                <div class="gs-ai-provider-row-actions">
                    <label class="gs-ai-inline"><input type="checkbox" data-ai-enabled="${escapeHtml(id)}" ${provider.enabled !== false ? 'checked' : ''}> ${escapeHtml(t('settings.enabled'))}</label>
                    <button type="button" class="btn-secondary gs-ai-small" data-ai-edit="${escapeHtml(id)}">${escapeHtml(t('settings.aiEdit'))}</button>
                    <button type="button" class="btn-secondary gs-ai-small" data-ai-delete="${escapeHtml(id)}">${escapeHtml(t('settings.aiDelete'))}</button>
                </div>
                ${loggedIn && provider.authMode !== 'none' ? `<div class="gs-ai-provider-sync">
                    <span class="gs-ai-sync-label">${escapeHtml(t('settings.aiKeySyncLabel'))}</span>
                    <select data-ai-syncmode="${escapeHtml(id)}" class="gs-ai-small-input" aria-label="${escapeHtml(t('settings.aiKeySyncLabel'))}">
                        <option value="cloud" ${syncMode === 'cloud' ? 'selected' : ''}>${escapeHtml(t('settings.aiKeySyncCloud'))}</option>
                        <option value="local-only" ${syncMode === 'local-only' ? 'selected' : ''}>${escapeHtml(t('settings.aiKeyLocalOnly'))}</option>
                        <option value="remove-cloud" ${syncMode === 'cloud-removal-pending' ? 'selected' : ''}>${escapeHtml(t('settings.aiKeyRemoveCloud'))}</option>
                    </select>
                    ${status.conflict ? `<span class="gs-ai-error">${escapeHtml(t('settings.aiKeyConflict'))}</span>` : ''}
                </div>` : ''}
                ${renderDeleteRow(id, status)}
            </div>`;
        }).join('');
    }

    function renderTaskSection() {
        const catalogUsable = getCatalogState().usable;
        const defaultOptions = getAllowedModelOptions().filter((option) => option.source !== 'managed' || catalogUsable);
        const currentDefault = getPersonalDefaultModel();
        const defaults = [
            `<option value="" ${!currentDefault ? 'selected' : ''}>${escapeHtml(t('settings.aiDefaultFollowAdmin'))}</option>`,
            ...(currentDefault && !defaultOptions.some((option) => option.value === currentDefault)
                ? [`<option value="${escapeHtml(currentDefault)}" selected>${escapeHtml(t('settings.aiModelUnavailable', { value: currentDefault }))}</option>`]
                : []),
            ...defaultOptions.map((option) => `<option value="${escapeHtml(option.value)}" ${option.value === currentDefault ? 'selected' : ''}>${escapeHtml(option.label)}</option>`)
        ].join('');
        const rows = AI_TASK_FIELDS.map(({ key, labelKey }) => {
            const selection = getTaskModelSelection(key);
            const value = selection.value || '';
            return `<div class="gs-ai-task-row">
                <div class="gs-ai-task-label">${escapeHtml(t(labelKey))}</div>
                <select data-ai-task="${escapeHtml(key)}" data-focus-key="task:${escapeHtml(key)}" class="gs-ai-task-select" ${selection.disabled ? 'disabled' : ''}>
                    ${selection.options.length ? '' : `<option value="">${escapeHtml(t('settings.noModels'))}</option>`}
                    ${selection.options.map((option) => `<option value="${escapeHtml(option.value)}" ${option.value === value ? 'selected' : ''}>${escapeHtml(option.label || option.value)}</option>`).join('')}
                </select>
                ${selection.unavailableCurrent ? `<div class="gs-ai-error">${escapeHtml(t('settings.aiModelReselect'))}</div>` : ''}
            </div>`;
        }).join('');
        return `<details class="gs-ai-block gs-ai-tasks" data-keep-open="ai-tasks" ${taskDetailsOpen ? 'open' : ''}>
            <summary>${escapeHtml(t('settings.taskMapping'))}</summary>
            <div class="gs-ai-task-row">
                <div class="gs-ai-task-label">${escapeHtml(t('settings.aiDefaultModelLabel'))}</div>
                <select data-ai-default-model data-focus-key="default-model" class="gs-ai-task-select">${defaults}</select>
            </div>
            ${rows}
            <p class="gs-hint">${escapeHtml(t('settings.aiTaskHint'))}</p>
        </details>`;
    }

    function renderForm(profile) {
        if (!form) return '';
        const editing = !!form.providerId;
        const models = connectedModels(form).filter((model) => form.allowedModels.includes(model.id));
        const hasSelection = !!form.selectedModel;
        const showModels = form.connected || form.models.length || (form.manualModels || []).length;
        const existingMode = form.providerId ? getProviderKeyStatus(form.providerId).mode : 'local-only';
        const mode = form.syncMode || (existingMode === 'cloud' ? 'cloud' : 'local-only');
        const loggedIn = getAuthSnapshot().loggedIn;
        const keyPlaceholder = editing ? t('settings.aiKeyKeepHint') : t('settings.aiApiKeyHint');
        const modelOptions = [
            `<option value="">${escapeHtml(t('settings.aiChooseModel'))}</option>`,
            ...models.map((model) => `<option value="${escapeHtml(model.id)}" ${form.selectedModel === model.id ? 'selected' : ''}>${escapeHtml(model.label)}</option>`)
        ].join('');
        const canSetDefault = !getPersonalDefaultModel();
        return `<div class="gs-ai-form" data-ai-form-id="${escapeHtml(form.providerId || 'new')}">
            <h4>${escapeHtml(editing ? t('settings.aiEditProviderTitle') : t('settings.aiNewProviderTitle'))}</h4>
            <label class="gs-ai-field">
                <span>${escapeHtml(t('settings.aiServiceUrl'))}</span>
                <input type="text" data-ai-form-url value="${escapeHtml(form.url || '')}" placeholder="https://example.com/v1" autocomplete="off" spellcheck="false">
            </label>
            <label class="gs-ai-field">
                <span>${escapeHtml(t('settings.aiApiKey'))}</span>
                <span class="gs-ai-key-row">
                    <input type="${form.showKey ? 'text' : 'password'}" data-ai-form-key value="${escapeHtml(form.apiKey || '')}" placeholder="${escapeHtml(keyPlaceholder)}" autocomplete="off" spellcheck="false">
                    <button type="button" class="btn-secondary gs-ai-small" data-ai-toggle-key>${escapeHtml(form.showKey ? t('settings.aiHideKey') : t('settings.aiShowKey'))}</button>
                </span>
            </label>
            <p class="gs-hint">${escapeHtml(t('settings.aiKeyOptionalHint'))}</p>
            ${editing ? `<div class="gs-ai-actions">
                ${form.keyAction === 'clear'
                    ? `<span class="gs-ai-error">${escapeHtml(t('settings.aiKeyWillClear'))}</span><button type="button" class="btn-secondary gs-ai-small" data-ai-keep-key>${escapeHtml(t('settings.cancel'))}</button>`
                    : `<button type="button" class="btn-secondary gs-ai-small" data-ai-clear-key>${escapeHtml(t('settings.aiClearKey'))}</button>`}
            </div>` : ''}

            <details class="gs-ai-advanced" data-ai-advanced data-keep-open="ai-advanced-${escapeHtml(form.providerId || 'new')}" ${form.advancedOpen ? 'open' : ''}>
                <summary>${escapeHtml(t('settings.aiAdvanced'))}</summary>
                <label class="gs-ai-field">
                    <span>${escapeHtml(t('settings.name'))}</span>
                    <input type="text" data-ai-form-name value="${escapeHtml(form.name || '')}" placeholder="${escapeHtml(t('settings.aiProviderNamePlaceholder'))}">
                </label>
                <label class="gs-ai-field">
                    <span>${escapeHtml(t('settings.aiProtocol'))}</span>
                    <select data-ai-form-format>${formatOptions(form.format || 'auto')}</select>
                </label>
                <label class="gs-ai-field">
                    <span>${escapeHtml(t('settings.aiAuthMode'))}</span>
                    <select data-ai-form-auth>${authModeOptions(form.authMode || '')}</select>
                </label>
                <label class="gs-ai-field">
                    <span>${escapeHtml(t('settings.aiApiEndpoint'))}</span>
                    <input type="text" data-ai-form-api value="${escapeHtml(form.apiUrl || '')}" placeholder="${escapeHtml(t('settings.deriveApiUrl'))}">
                </label>
                <label class="gs-ai-field">
                    <span>${escapeHtml(t('settings.aiModelsEndpoint'))}</span>
                    <input type="text" data-ai-form-models value="${escapeHtml(form.modelsUrl || '')}" placeholder="${escapeHtml(t('settings.deriveModelsUrl'))}">
                </label>
                <label class="gs-ai-field">
                    <span>${escapeHtml(t('settings.aiManualModel'))}</span>
                    <span class="gs-ai-key-row">
                        <input type="text" data-ai-form-manual placeholder="${escapeHtml(t('settings.aiManualModelHint'))}">
                        <button type="button" class="btn-secondary gs-ai-small" data-ai-add-manual>${escapeHtml(t('settings.addModel'))}</button>
                    </span>
                </label>
                <label class="gs-ai-inline"><input type="checkbox" data-ai-form-crossorigin ${form.allowCrossOriginModels ? 'checked' : ''}> ${escapeHtml(t('settings.aiAllowCrossOriginModels'))}</label>
                <p class="gs-hint">${escapeHtml(t('settings.aiAllowCrossOriginHint'))}</p>
                <p class="gs-hint">${escapeHtml(t('settings.aiAdvancedHint'))}</p>
            </details>

            <div class="gs-ai-connect-row">
                <button type="button" class="btn-primary" data-ai-connect ${form.connecting ? 'disabled' : ''}>${escapeHtml(form.connecting ? t('settings.aiConnecting') : t('settings.aiConnect'))}</button>
                ${form.connecting ? `<button type="button" class="btn-secondary gs-ai-small" data-ai-connect-cancel>${escapeHtml(t('settings.cancel'))}</button>` : ''}
                ${form.connected ? `<span class="gs-ai-status success">${escapeHtml(t('settings.aiConnectModelsFound'))}</span>` : ''}
                ${form.errorCode ? `<span class="gs-ai-error">${escapeHtml(describeDetectionError(form.errorCode))}</span>` : ''}
            </div>

            ${showModels ? renderModelPicker({ id: 'personal', models: connectedModels(form), selected: form.allowedModels, state: form.modelPicker }) : ''}
            ${showModels ? `<label class="gs-ai-field">
                <span>${escapeHtml(t('settings.aiPickerDefault'))}</span>
                <select data-ai-form-model data-focus-key="form-model">${modelOptions}</select>
            </label>` : ''}
            ${!form.connected && form.errorCode ? `<p class="gs-hint">${escapeHtml(t('settings.aiManualFallback'))}</p>` : ''}

            ${form.connected || form.models.length ? `<div class="gs-ai-actions">
                ${testConfirm
                    ? `<span class="gs-ai-warning">${escapeHtml(t('settings.aiTestCost'))}</span>
                       <button type="button" class="btn-secondary gs-ai-small" data-ai-test-confirm>${escapeHtml(t('settings.aiTestConfirm'))}</button>
                       <button type="button" class="btn-secondary gs-ai-small" data-ai-test-cancel>${escapeHtml(t('settings.cancel'))}</button>`
                    : `<button type="button" class="btn-secondary gs-ai-small" data-ai-test>${escapeHtml(t('settings.aiTestModel'))}</button>`}
                ${form.testResult ? `<span class="gs-ai-status ${form.testResult.ok ? 'success' : 'error'}">${escapeHtml(form.testResult.ok ? t('settings.aiTestOk') : describeDetectionError(form.testResult.errorCode))}</span>` : ''}
            </div>` : ''}

            ${canSetDefault && hasSelection ? `<label class="gs-ai-inline"><input type="checkbox" data-ai-form-default ${form.setDefault ? 'checked' : ''}> ${escapeHtml(t('settings.aiSetDefaultModel'))}</label>` : ''}

            ${loggedIn ? `<label class="gs-ai-field">
                <span>${escapeHtml(t('settings.aiKeySync'))}</span>
                <select data-ai-form-syncmode>
                    <option value="local-only" ${mode === 'local-only' ? 'selected' : ''}>${escapeHtml(t('settings.aiKeyLocalOnly'))}</option>
                    <option value="cloud" ${mode === 'cloud' ? 'selected' : ''}>${escapeHtml(t('settings.aiKeySyncCloud'))}</option>
                </select>
                <span class="gs-hint">${escapeHtml(t('settings.aiKeySyncHint'))}</span>
            </label>` : `<p class="gs-hint">${escapeHtml(t('settings.aiKeyDeviceOnlyHint'))}</p>`}

            ${form.error ? `<div class="gs-ai-error">${escapeHtml(form.error)}</div>` : ''}
            <div class="gs-ai-actions">
                <button type="button" class="btn-secondary" data-ai-form-cancel>${escapeHtml(t('settings.cancel'))}</button>
                <button type="button" class="btn-primary" data-ai-form-save ${form.saving ? 'disabled' : ''}>${escapeHtml(form.saving ? t('settings.aiSaving') : t('settings.aiSave'))}</button>
            </div>
        </div>`;
    }

    function captureViewState() {
        // 只有 DOM 與目前表單是同一份時才回寫，避免把舊表單的展開狀態帶到新表單。
        const renderedFormId = host.querySelector('.gs-ai-form')?.getAttribute('data-ai-form-id') || '';
        if (form && renderedFormId === (form.providerId || 'new')) {
            const advanced = host.querySelector('details[data-keep-open^="ai-advanced-"]');
            if (advanced) form.advancedOpen = advanced.open;
            const list = host.querySelector('.ai-model-picker-list');
            if (list) form.modelPicker.scrollTop = list.scrollTop;
        }
        const tasks = host.querySelector('details[data-keep-open="ai-tasks"]');
        if (tasks) taskDetailsOpen = tasks.open;
    }

    function activeFocusKey() {
        const active = document.activeElement;
        if (!active || active === host || !host.contains(active)) return '';
        return active.getAttribute('data-focus-key') || '';
    }

    function restoreFocus(focusKey) {
        if (!focusKey) return;
        try { host.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true }); } catch (_) {}
    }

    function render() {
        if (destroyed) return;
        captureViewState();
        const focusKey = activeFocusKey();
        const openDetails = captureDetailState(host);
        const catalog = getCatalogState();
        const profile = loadAIProfile();
        const personalBlock = `<section class="gs-ai-block">
            <div class="gs-ai-block-head">
                <h4>${escapeHtml(t('settings.aiMyProviders'))}</h4>
                <button type="button" class="btn-secondary gs-ai-small" data-ai-add>${escapeHtml(t('settings.aiAddProvider'))}</button>
            </div>
            <p class="gs-hint">${escapeHtml(t('settings.aiOwnProviderHint'))}</p>
            ${getAuthSnapshot().loggedIn && deviceProvidersAvailableForImport().length && !importOpen ? `<div class="gs-ai-actions"><button type="button" class="btn-secondary gs-ai-small" data-ai-import-open>${escapeHtml(t('settings.aiImportDevice'))}</button></div>` : ''}
            ${renderImportPanel()}
            ${renderSyncStatus()}
            <div class="gs-ai-personal-list">${renderPersonalList()}</div>
            ${renderForm(profile)}
        </section>`;
        host.innerHTML = `
            ${notice ? `<div class="gs-ai-notice ${noticeType}">${escapeHtml(notice)}</div>` : ''}
            ${renderManaged(catalog)}
            ${personalBlock}
            ${renderTaskSection()}
        `;
        restoreDetailState(host, openDetails);
        wire();
        restoreFocus(focusKey);
    }

    function scheduleRender() {
        if (destroyed) return;
        if (form && host.contains(document.activeElement)) return;
        render();
    }

    function openAddForm() {
        pendingDelete = '';
        testConfirm = false;
        setNotice('', 'info');
        form = {
            providerId: '',
            url: '',
            apiKey: '',
            name: '',
            format: 'auto',
            authMode: '',
            apiUrl: '',
            modelsUrl: '',
            apiUrlEdited: false,
            modelsUrlEdited: false,
            urlChanged: false,
            allowCrossOriginModels: false,
            manualModels: [],
            allowedModels: [],
            modelPicker: {},
            models: [],
            selectedModel: '',
            connected: false,
            connection: null,
            connecting: false,
            showKey: false,
            keyAction: '',
            syncMode: 'local-only',
            setDefault: !getPersonalDefaultModel(),
            advancedOpen: false,
            error: '',
            errorCode: '',
            saving: false
        };
        render();
    }

    function openEditForm(providerId) {
        const profile = loadAIProfile();
        const provider = profile.providers[providerId];
        if (!provider) return;
        pendingDelete = '';
        testConfirm = false;
        setNotice('', 'info');
        const status = getProviderKeyStatus(providerId);
        form = {
            providerId,
            url: provider.baseUrl || provider.apiUrl || '',
            apiKey: '',
            name: provider.label || '',
            format: provider.format || 'auto',
            authMode: provider.authMode || '',
            allowCrossOriginModels: provider.allowCrossOriginModels === true,
            apiUrl: provider.apiUrl || '',
            modelsUrl: provider.modelsUrl || '',
            apiUrlEdited: false,
            modelsUrlEdited: false,
            urlChanged: false,
            manualModels: (provider.allowedModels || []).slice(),
            allowedModels: (provider.allowedModels?.length ? provider.allowedModels : (provider.discoveredModels || []).map((model) => model.id)).slice(),
            allowedModelsSet: true,
            modelPicker: {},
            models: (provider.discoveredModels || []).slice(),
            selectedModel: '',
            connected: false,
            connection: null,
            connecting: false,
            showKey: false,
            keyAction: '',
            syncMode: status.mode === 'cloud' ? 'cloud' : 'local-only',
            setDefault: false,
            advancedOpen: false,
            error: '',
            errorCode: '',
            saving: false
        };
        const defaultId = getPersonalDefaultModel();
        const current = defaultId.startsWith(`${providerId}:`) ? defaultId.slice(providerId.length + 1) : '';
        form.selectedModel = form.allowedModels.includes(current) ? current : (form.allowedModels[0] || '');
        render();
    }

    async function doConnect() {
        if (!form) return;
        const url = String(form.url || '').trim();
        if (!url) { form.errorCode = 'url_required'; render(); return; }
        const requestId = (form.requestSeq || 0) + 1;
        form.requestSeq = requestId;
        form.connecting = true;
        form.errorCode = '';
        form.error = '';
        form.testResult = null;
        form.connection = null;
        form.connected = false;
        const controller = new AbortController();
        form.controller = controller;
        render();
        try {
            const existingKey = form.keyAction === 'clear' ? '' : (form.apiKey || existingKeyFor(form.providerId));
            const result = await detectProvider({
                url,
                apiKey: existingKey,
                format: form.format === 'auto' ? '' : form.format,
                signal: controller.signal
            });
            if (!form || form.requestSeq !== requestId || String(form.url || '').trim() !== url) return;
            if (result.ok) {
                form.connection = result;
                form.models = result.models;
                form.connected = true;
                form.errorCode = '';
                form.connectedAt = new Date().toISOString();
                form.authMode = result.provider.authMode;
                // 取得模型清單不等於使用者已同意開放：與管理員發布流程一致，
                // 一律要求明確勾選（可用「全選目前列表」一鍵完成）。
                if (!form.allowedModelsSet) {
                    form.allowedModels = Array.from(new Set(form.manualModels || []));
                    form.allowedModelsSet = true;
                }
                if (!form.allowedModels.includes(form.selectedModel)) form.selectedModel = '';
            } else {
                form.errorCode = result.errorCode || 'provider_unreachable';
            }
        } catch (error) {
            if (form && error && error.name !== 'AbortError') form.errorCode = error.code || 'provider_unreachable';
        } finally {
            if (form && form.requestSeq === requestId) {
                form.connecting = false;
                form.controller = null;
                render();
            }
        }
    }

    async function doTest() {
        if (!form) return;
        testConfirm = false;
        const model = String(form.selectedModel || '').trim();
        if (!model) { form.testResult = { ok: false, errorCode: 'model_not_selected' }; render(); return; }
        let provider;
        try {
            provider = readDraftProvider(form, loadAIProfile());
        } catch (error) {
            form.testResult = { ok: false, errorCode: error.code || 'url_invalid' };
            render();
            return;
        }
        const key = form.keyAction === 'clear' ? '' : (form.apiKey || existingKeyFor(form.providerId));
        form.testing = true;
        render();
        const result = await testProviderModel({ provider, apiKey: key, model });
        if (!form) return;
        form.testing = false;
        form.testResult = result;
        render();
    }

    async function saveForm() {
        if (!form) return;
        form.error = '';
        form.saving = true;
        render();
        try {
            const profile = loadAIProfile();
            let provider;
            try {
                provider = readDraftProvider(form, profile);
            } catch (error) {
                form.error = describeDetectionError(error.code || 'url_invalid');
                form.saving = false;
                render();
                return;
            }
            const selected = String(form.selectedModel || '').trim();
            provider.allowedModels = [...form.allowedModels];
            // Persist every candidate, including manual entries that were deselected.
            provider.discoveredModels = connectedModels(form);
            if (!provider.allowedModels.length) {
                form.error = t('settings.aiNeedModel');
                form.saving = false;
                render();
                return;
            }
            const providerId = form.providerId || newProviderId();
            const existing = form.providerId ? profile.credentials[form.providerId] : null;
            const keyChanged = !!String(form.apiKey || '').trim();
            const clearKey = form.keyAction === 'clear';
            const authMode = provider.authMode;
            if (authMode !== 'none' && !keyChanged && !existing?.apiKey && !clearKey) {
                form.error = t('settings.aiKeyRequired');
                form.saving = false;
                render();
                return;
            }
            const syncMode = getAuthSnapshot().loggedIn ? (form.syncMode === 'cloud' ? 'cloud' : 'local-only') : 'local-only';
            const endpointReconfirm = !!form.providerId && form.urlChanged && !keyChanged && !clearKey && authMode !== 'none';
            if (endpointReconfirm && syncMode === 'cloud') {
                form.error = t('settings.aiKeyEndpointChanged');
                form.saving = false;
                render();
                return;
            }
            await savePersonalProvider({
                providerId,
                provider,
                apiKey: String(form.apiKey || '').trim(),
                keyChanged,
                clearKey,
                syncMode
            });
            const currentDefault = getPersonalDefaultModel();
            if (currentDefault.startsWith(`${providerId}:`) && !provider.allowedModels.includes(currentDefault.slice(providerId.length + 1))) {
                setPersonalDefaultModel('');
            }
            if (form.setDefault && selected) setPersonalDefaultModel(`${providerId}:${selected}`);
            form = null;
            testConfirm = false;
            setNotice(t(endpointReconfirm ? 'settings.aiKeyEndpointChanged' : 'settings.aiProviderSaved'), endpointReconfirm ? 'error' : 'success');
            render();
        } catch (error) {
            if (form) {
                form.error = `${t('settings.saveFailed')}${error && error.code ? error.code : ''}`;
                form.saving = false;
                render();
            }
        }
    }

    async function applySyncMode(providerId, value) {
        try {
            if (value === 'cloud') {
                setProviderKeySyncMode(providerId, 'cloud');
                setNotice(t('settings.aiKeyPending'), 'info');
            } else if (value === 'remove-cloud') {
                setProviderKeySyncMode(providerId, 'remove-cloud');
                setNotice(t('settings.aiKeyRemovePending'), 'info');
            } else {
                setProviderKeySyncMode(providerId, 'local-only');
                setNotice(t('settings.aiKeyLocalOnly'), 'info');
            }
            await syncCredentials({ reason: 'manual' });
        } catch (error) {
            const message = error && error.code === 'binding_changed_requires_key'
                ? t('settings.aiKeyEndpointChanged')
                : (error && error.code ? `${t('settings.saveFailed')}${error.code}` : t('settings.saveFailed'));
            setNotice(message, 'error');
        }
        render();
    }

    function wire() {
        const $ = (selector) => host.querySelector(selector);
        const all = (selector) => Array.from(host.querySelectorAll(selector));

        $('[data-ai-login]')?.addEventListener('click', () => {
            try { options.onRequestLogin?.(); } catch (_) {}
        });
        $('[data-ai-refresh]')?.addEventListener('click', () => {
            refreshAICatalog({ force: true, reason: 'manual' }).then(() => render()).catch(() => render());
        });
        $('[data-ai-admin]')?.addEventListener('click', () => {
            try { openAiAdminPanel(); } catch (_) {}
        });
        $('[data-ai-sync-now]')?.addEventListener('click', () => {
            syncCredentials({ reason: 'manual' }).then(() => render()).catch(() => render());
        });
        $('[data-ai-add]')?.addEventListener('click', openAddForm);
        $('[data-ai-import-open]')?.addEventListener('click', () => { importOpen = true; render(); });
        $('[data-ai-import-cancel]')?.addEventListener('click', () => { importOpen = false; render(); });
        $('[data-ai-import-run]')?.addEventListener('click', async () => {
            const ids = [...host.querySelectorAll('[data-ai-import-id]:checked')].map((input) => input.getAttribute('data-ai-import-id'));
            const syncKeys = !!host.querySelector('[data-ai-import-sync]')?.checked;
            if (!ids.length) { importOpen = false; render(); return; }
            try {
                const result = importGuestProviders(ids, { syncKeys });
                importOpen = false;
                setNotice(t('settings.aiImportDone', { count: result.imported }), 'success');
                if (syncKeys) await syncCredentials({ reason: 'import' });
            } catch (error) {
                setNotice(error && error.code ? `${t('settings.saveFailed')}${error.code}` : t('settings.saveFailed'), 'error');
            }
            render();
        });

        all('[data-ai-edit]').forEach((button) => button.addEventListener('click', () => openEditForm(button.getAttribute('data-ai-edit'))));
        all('[data-ai-delete]').forEach((button) => button.addEventListener('click', () => {
            pendingDelete = button.getAttribute('data-ai-delete');
            render();
        }));
        all('[data-ai-delete-cancel]').forEach((button) => button.addEventListener('click', () => { pendingDelete = ''; render(); }));
        all('[data-ai-delete-device]').forEach((button) => button.addEventListener('click', () => {
            const id = button.getAttribute('data-ai-delete-device');
            try { deletePersonalProvider(id, { removeCloud: false }); pendingDelete = ''; setNotice(t('settings.aiProviderDeleted'), 'success'); }
            catch (error) { setNotice(t('settings.saveFailed'), 'error'); }
            render();
        }));
        all('[data-ai-delete-everywhere]').forEach((button) => button.addEventListener('click', () => {
            const id = button.getAttribute('data-ai-delete-everywhere');
            try { deletePersonalProvider(id, { removeCloud: true }); pendingDelete = ''; setNotice(t('settings.aiProviderDeleted'), 'success'); }
            catch (error) { setNotice(t('settings.saveFailed'), 'error'); }
            render();
        }));
        all('[data-ai-enabled]').forEach((input) => input.addEventListener('change', () => {
            const id = input.getAttribute('data-ai-enabled');
            const profile = loadAIProfile();
            const provider = profile.providers[id];
            if (!provider) return;
            try {
                savePersonalProvider({
                    providerId: id,
                    provider: { ...provider, enabled: input.checked },
                    apiKey: '',
                    keyChanged: false,
                    clearKey: false,
                    syncMode: getProviderKeyStatus(id).mode === 'cloud' ? 'cloud' : 'local-only'
                });
                setNotice(t('settings.aiProviderSaved'), 'success');
            } catch (error) {
                setNotice(t('settings.saveFailed'), 'error');
            }
            render();
        }));
        all('[data-ai-syncmode]').forEach((select) => select.addEventListener('change', () => {
            const id = select.getAttribute('data-ai-syncmode');
            applySyncMode(id, select.value);
        }));
        all('[data-ai-conflict-cloud]').forEach((button) => button.addEventListener('click', async () => {
            try { await resolveCredentialConflict(button.getAttribute('data-ai-conflict-cloud'), 'cloud'); }
            catch (error) { setNotice(t('settings.aiKeySyncFailed'), 'error'); }
            render();
        }));
        all('[data-ai-conflict-local]').forEach((button) => button.addEventListener('click', async () => {
            try { await resolveCredentialConflict(button.getAttribute('data-ai-conflict-local'), 'local'); }
            catch (error) { setNotice(t('settings.aiKeySyncFailed'), 'error'); }
            render();
        }));
        all('[data-ai-conflict-later]').forEach((button) => button.addEventListener('click', () => render()));

        all('[data-ai-task]').forEach((select) => select.addEventListener('change', () => {
            try { saveTaskModelSelection(select.getAttribute('data-ai-task'), select.value || ''); }
            catch (error) { setNotice(t('settings.saveFailed'), 'error'); }
            render();
        }));
        $('[data-ai-default-model]')?.addEventListener('change', (event) => {
            try { setPersonalDefaultModel(event.target.value || ''); setNotice(t('settings.aiProviderSaved'), 'success'); }
            catch (error) { setNotice(t('settings.saveFailed'), 'error'); }
            render();
        });

        // Form bindings
        if (!form) return;
        $('[data-ai-form-url]')?.addEventListener('input', (event) => {
            form.url = event.target.value;
            form.connected = false;
            form.connection = null;
            form.errorCode = '';
            form.models = [];
            form.allowedModels = (form.manualModels || []).slice();
            form.modelPicker = {};
            form.selectedModel = '';
            form.allowedModelsSet = false;
            form.testResult = null;
            form.urlChanged = true;
            form.requestSeq = (form.requestSeq || 0) + 1;
            try { form.controller?.abort(); } catch (_) {}
            form.connecting = false;
            form.controller = null;
        });
        $('[data-ai-form-key]')?.addEventListener('input', (event) => {
            form.apiKey = event.target.value;
            form.keyAction = form.apiKey ? 'replace' : form.keyAction;
        });
        $('[data-ai-toggle-key]')?.addEventListener('click', () => { form.showKey = !form.showKey; render(); });
        $('[data-ai-clear-key]')?.addEventListener('click', () => { form.keyAction = 'clear'; form.apiKey = ''; render(); });
        $('[data-ai-keep-key]')?.addEventListener('click', () => { form.keyAction = ''; render(); });
        $('[data-ai-form-name]')?.addEventListener('input', (event) => { form.name = event.target.value; });
        $('[data-ai-form-format]')?.addEventListener('change', (event) => {
            form.format = event.target.value;
            form.connected = false;
            form.connection = null;
        });
        $('[data-ai-form-auth]')?.addEventListener('change', (event) => { form.authMode = event.target.value; });
        $('[data-ai-form-api]')?.addEventListener('input', (event) => { form.apiUrl = event.target.value; form.apiUrlEdited = true; });
        $('[data-ai-form-models]')?.addEventListener('input', (event) => { form.modelsUrl = event.target.value; form.modelsUrlEdited = true; });
        $('[data-ai-advanced]')?.addEventListener('toggle', (event) => { form.advancedOpen = event.target.open; });
        // 選了模型就重繪一次，讓下方的「設為我的預設模型」即時出現；
        // render() 會保留折疊區塊與清單捲動位置，不會造成跳動。
        $('[data-ai-form-model]')?.addEventListener('change', (event) => { form.selectedModel = event.target.value; render(); });
        $('[data-ai-form-syncmode]')?.addEventListener('change', (event) => { form.syncMode = event.target.value; });
        $('[data-ai-form-default]')?.addEventListener('change', (event) => { form.setDefault = event.target.checked; });
        $('[data-ai-form-crossorigin]')?.addEventListener('change', (event) => { form.allowCrossOriginModels = event.target.checked; });
        bindModelPicker(host, {
            id: 'personal', models: connectedModels(form), selected: form.allowedModels, state: form.modelPicker,
            onChange: (selected) => {
                form.allowedModels = selected;
                form.allowedModelsSet = true;
                form.error = '';
                if (!selected.includes(form.selectedModel)) form.selectedModel = selected[0] || '';
                form.testResult = null;
                render();
            }
        });
        $('[data-ai-add-manual]')?.addEventListener('click', () => {
            const input = $('[data-ai-form-manual]');
            const value = String(input?.value || '').trim();
            if (!value) return;
            form.manualModels = Array.from(new Set([...(form.manualModels || []), value]));
            form.allowedModels = Array.from(new Set([...form.allowedModels, value]));
            form.modelPicker.query = '';
            form.error = '';
            if (!form.selectedModel) form.selectedModel = value;
            if (input) input.value = '';
            render();
        });
        $('[data-ai-connect]')?.addEventListener('click', doConnect);
        $('[data-ai-connect-cancel]')?.addEventListener('click', () => {
            try { form?.controller?.abort(); } catch (_) {}
        });
        $('[data-ai-test]')?.addEventListener('click', () => { testConfirm = true; render(); });
        $('[data-ai-test-confirm]')?.addEventListener('click', doTest);
        $('[data-ai-test-cancel]')?.addEventListener('click', () => { testConfirm = false; render(); });
        $('[data-ai-form-cancel]')?.addEventListener('click', () => {
            try { form?.controller?.abort(); } catch (_) {}
            form = null;
            testConfirm = false;
            render();
        });
        $('[data-ai-form-save]')?.addEventListener('click', saveForm);
    }

    const unsubscribers = [];
    const onAuthChange = (event) => {
        const detail = event && event.detail ? event.detail : {};
        if (detail.event === 'SIGNED_OUT' || detail.event === 'ACCOUNT_CHANGED' || detail.event === 'SESSION_INVALID') {
            try { form?.controller?.abort(); } catch (_) {}
            if (detail.event !== 'SESSION_INVALID') {
                form = null;
                importOpen = false;
            }
            render();
        }
    };
    try {
        window.addEventListener(AUTH_EVENT, onAuthChange);
        unsubscribers.push(() => window.removeEventListener(AUTH_EVENT, onAuthChange));
        unsubscribers.push(subscribeAICatalog(() => scheduleRender()));
        unsubscribers.push(subscribeCredentialSync(() => scheduleRender()));
    } catch (_) {}
    render();

    return {
        destroy() {
            destroyed = true;
            try { form?.controller?.abort(); } catch (_) {}
            for (const off of unsubscribers) {
                try { off(); } catch (_) {}
            }
            host.innerHTML = '';
        },
        refresh: render
    };
}
