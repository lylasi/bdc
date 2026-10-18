// Admin editor for the managed default provider catalog.
//
// Drafts stay in this page's memory until "publish" succeeds. Publishing sends
// the whole draft plus explicit per-provider key operations to the Worker, which
// validates, encrypts and atomically creates a new release. Historical versions
// restore settings into the draft; their keys are never downloadable.
//
// Adding a provider uses the same two-field flow as "my providers": service URL
// + API key → connect (protocol auto-detection) → choose the models to open →
// add to draft. Discovery only fills a *candidate* list; the approved model
// list (what users may pick) only ever grows when the admin ticks a box.

import {
    apiRequest,
    auth,
    getAuthSnapshot,
    captureAuthSession,
    isAuthSessionCurrent,
    AUTH_EVENT
} from '../../modules/sync-cloudflare.js';
import { loadAIProfile } from '../../modules/ai-profile-storage.js';
import { t, formatDateTime } from '../../modules/i18n.js';
import {
    buildProviderDefinition,
    describeDetectionError,
    detectProvider,
    fetchProviderModels,
    getAdapter,
    testProviderModel
} from '../../modules/ai-protocols/index.js';
import { renderModelPicker, bindModelPicker } from '../../modules/ai-model-picker.js';
import { captureDetailState, restoreDetailState } from '../../modules/detail-state.js';
import { refreshAICatalog } from '../../modules/ai-catalog.js';

let panel = null;

function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function newManagedId() {
    try {
        if (crypto && crypto.randomUUID) return `managed-${crypto.randomUUID()}`;
    } catch (_) {}
    return `managed-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function newMutationId() {
    try {
        if (crypto && crypto.randomUUID) return crypto.randomUUID();
    } catch (_) {}
    return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

function formatTime(value) {
    if (!value) return '';
    try { return formatDateTime(value, { hour12: false }); } catch (_) { return ''; }
}

function hostLabel(url) {
    try {
        const host = new URL(String(url || '')).hostname;
        if (!host) return '';
        return host.replace(/^www\./i, '').replace(/^api\./i, '').split('.')[0] || host;
    } catch (_) {
        return '';
    }
}

function emptyDraft() {
    return {
        version: 0,
        config: { schemaVersion: 1, providers: [], tasks: {} },
        credentials: {},
        publishedBy: '',
        publishedAt: null,
        keyOps: {},
        testKeys: {},
        error: '',
        notice: '',
        busy: false,
        history: [],
        historyOpen: false,
        testResult: {},
        addForm: null
    };
}

function modelEntry(model) {
    if (typeof model === 'string') return { id: model, label: model, capabilities: {} };
    return {
        id: String((model && model.id) || ''),
        label: String((model && (model.label || model.id)) || ''),
        capabilities: (model && model.capabilities) || {}
    };
}

function normalizeDraftProvider(raw) {
    const format = raw.format || 'openai-chat';
    let baseUrl = raw.baseUrl || '';
    if (!baseUrl) {
        try {
            baseUrl = getAdapter(format).deriveEndpoints({
                apiUrl: String(raw.apiUrl || ''),
                modelsUrl: String(raw.modelsUrl || '')
            }).baseUrl || '';
        } catch (_) { baseUrl = ''; }
    }
    const models = Array.isArray(raw.models)
        ? raw.models.map(modelEntry).filter((model) => model.id)
        : [];
    const modelMeta = {};
    for (const model of models) modelMeta[model.id] = model.capabilities || {};
    return {
        id: String(raw.id || ''),
        name: String(raw.name || raw.id || ''),
        enabled: raw.enabled !== false,
        order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : 0,
        format,
        formatVersion: 1,
        baseUrl,
        apiUrl: String(raw.apiUrl || ''),
        modelsUrl: String(raw.modelsUrl || ''),
        authMode: raw.authMode || 'bearer',
        models,
        // Discovery results only. They are never published on their own.
        candidates: Array.isArray(raw.candidates) ? raw.candidates.map(modelEntry).filter((model) => model.id) : [],
        // Capabilities already known for a model id, kept when a model is
        // temporarily removed from (and re-added to) the approved list.
        modelMeta
    };
}

function providerToConfig(provider) {
    return {
        id: provider.id,
        name: provider.name || provider.id,
        enabled: provider.enabled !== false,
        order: Number(provider.order) || 0,
        format: provider.format,
        formatVersion: 1,
        apiUrl: provider.apiUrl,
        modelsUrl: provider.modelsUrl,
        authMode: provider.authMode,
        models: (provider.models || []).map((model) => ({
            id: model.id,
            label: model.label || model.id,
            capabilities: model.capabilities || {}
        }))
    };
}

function sanitizeDraftProvider(provider) {
    const endpoints = buildProviderDefinition({
        format: provider.format,
        baseUrl: provider.baseUrl || provider.apiUrl,
        apiUrl: provider.apiUrl || '',
        modelsUrl: provider.modelsUrl || '',
        authMode: provider.authMode,
        apiKey: provider.authMode === 'none' ? '' : '__draft__'
    });
    return {
        ...provider,
        baseUrl: endpoints.baseUrl,
        apiUrl: endpoints.apiUrl,
        modelsUrl: endpoints.modelsUrl,
        authMode: endpoints.authMode
    };
}

function ensureKeyOps(draft) {
    const next = {};
    for (const provider of draft.config.providers) {
        const existing = draft.keyOps[provider.id];
        const meta = draft.credentials[provider.id];
        if (existing) {
            next[provider.id] = existing;
        } else if (provider.authMode === 'none') {
            next[provider.id] = { action: 'preserve' };
        } else if (meta && meta.hasKey) {
            next[provider.id] = { action: 'preserve' };
        } else {
            next[provider.id] = { action: 'replace', apiKey: '' };
        }
    }
    draft.keyOps = next;
}

function taskOptions(draft, selectedProvider, selectedModel) {
    const provider = draft.config.providers.find((item) => item.id === selectedProvider);
    const models = provider ? provider.models : [];
    const providerOptions = draft.config.providers.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === selectedProvider ? 'selected' : ''}>${escapeHtml(item.name || item.id)}</option>`).join('');
    const modelOptions = models.map((model) => `<option value="${escapeHtml(model.id)}" ${model.id === selectedModel ? 'selected' : ''}>${escapeHtml(model.label || model.id)}</option>`).join('');
    return { providerOptions, modelOptions };
}

const TASKS = ['wordAnalysis', 'sentenceChecking', 'qaChecking', 'articleAnalysis', 'articleCleanup', 'exampleGeneration', 'imageOCR', 'assistant'];
const TASK_LABELS = {
    wordAnalysis: 'settings.taskWord',
    sentenceChecking: 'settings.taskSentence',
    qaChecking: 'settings.taskQa',
    articleAnalysis: 'settings.taskArticle',
    articleCleanup: 'settings.taskCleanup',
    exampleGeneration: 'settings.taskExamples',
    imageOCR: 'settings.taskOcr',
    assistant: 'settings.taskAssistant'
};

const FORMATS = [
    ['openai-chat', 'settings.aiFormatChat'],
    ['anthropic-messages', 'settings.aiFormatAnthropic'],
    ['gemini', 'settings.aiFormatGemini']
];

const AUTH_MODES = [
    ['bearer', 'settings.aiAuthBearer'],
    ['x-api-key', 'settings.aiAuthXApiKey'],
    ['google', 'settings.aiAuthGoogle'],
    ['none', 'settings.aiAuthNone']
];

let adminInitialized = false;

export function initAiAdmin() {
    if (adminInitialized) return;
    adminInitialized = true;
    try {
        window.addEventListener(AUTH_EVENT, (event) => {
            const detail = event && event.detail ? event.detail : {};
            if (detail.event === 'SIGNED_OUT' || detail.event === 'ACCOUNT_CHANGED' || detail.event === 'SESSION_INVALID') {
                close();
            }
        });
    } catch (_) {}
}

export function openAiAdminPanel() {
    const snapshot = getAuthSnapshot();
    if (!snapshot.loggedIn) {
        try { window.dispatchEvent(new CustomEvent('bdc:request-login')); } catch (_) {}
        return;
    }
    if (panel) return;
    panel = document.createElement('div');
    panel.className = 'ai-admin-overlay';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.innerHTML = `<div class="ai-admin-panel">
        <div class="ai-admin-head">
            <h3>${escapeHtml(t('settings.aiAdminTitle'))}</h3>
            <button type="button" class="btn-secondary" data-admin-close>${escapeHtml(t('settings.cancel'))}</button>
        </div>
        <div class="ai-admin-body" data-admin-body>${escapeHtml(t('settings.loading'))}</div>
    </div>`;
    document.body.appendChild(panel);
    panel.querySelector('[data-admin-close]').addEventListener('click', close);
    panel.addEventListener('click', (event) => { if (event.target === panel) close(); });
    loadDraft();
}

function close() {
    // Drop the in-memory draft (including any newly typed replacement keys).
    cancelAddFormConnection();
    draft = emptyDraft();
    lastPublishMutation = '';
    lastPublishDigest = '';
    if (!panel) return;
    try { panel.remove(); } catch (_) {}
    panel = null;
}

let draft = emptyDraft();
let lastPublishMutation = '';
let lastPublishDigest = '';

function body() {
    return panel ? panel.querySelector('[data-admin-body]') : null;
}

async function loadDraft() {
    draft = emptyDraft();
    draft.busy = true;
    render();
    const captured = captureAuthSession();
    try {
        const res = await apiRequest('/admin/ai-catalog', { method: 'GET' }, { timeoutMs: 15000 });
        // An answer that belongs to a previous account must change nothing.
        if (!isAuthSessionCurrent(captured)) return;
        if (res.status === 401) { await auth.invalidateSession(); draft.error = t('errors.aiLoginRequired'); }
        else if (res.status === 403) { draft.error = t('errors.aiAdminRequired'); }
        else if (!res.ok) { draft.error = t('errors.aiAdminLoadFailed'); }
        else {
            const data = await res.json().catch(() => null);
            if (!data) draft.error = t('errors.aiAdminLoadFailed');
            else {
                draft.version = Number(data.version) || 0;
                draft.config = {
                    schemaVersion: 1,
                    providers: (data.config?.providers || []).map(normalizeDraftProvider),
                    tasks: data.config?.tasks || {}
                };
                draft.credentials = data.credentials || {};
                draft.publishedBy = data.publishedBy || '';
                draft.publishedAt = data.publishedAt || null;
                ensureKeyOps(draft);
            }
        }
    } catch (error) {
        if (!isAuthSessionCurrent(captured)) return;
        draft.error = error && error.code ? describeDetectionError(error.code) : t('errors.cannotReachSync');
    }
    draft.busy = false;
    render();
}

function draftProvider(providerId) {
    return draft.config.providers.find((provider) => provider.id === providerId);
}

function candidateFor(provider, modelId) {
    return (provider.candidates || []).find((model) => model.id === modelId) || null;
}

function addApprovedModel(provider, modelId) {
    const id = String(modelId || '').trim();
    if (!id) return false;
    if ((provider.models || []).some((model) => model.id === id)) return false;
    const candidate = candidateFor(provider, id);
    const known = (provider.modelMeta && provider.modelMeta[id]) || {};
    const capabilities = candidate && Object.keys(candidate.capabilities || {}).length
        ? candidate.capabilities
        : known;
    provider.models = [...(provider.models || []), {
        id,
        label: (candidate && candidate.label) || id,
        capabilities: capabilities || {}
    }];
    if (provider.modelMeta) provider.modelMeta[id] = capabilities || {};
    return true;
}

function removeApprovedModel(provider, modelId) {
    const id = String(modelId || '');
    const existing = (provider.models || []).find((model) => model.id === id);
    if (existing) mergeCandidates(provider, [existing]);
    if (existing && provider.modelMeta) provider.modelMeta[id] = existing.capabilities || {};
    provider.models = (provider.models || []).filter((model) => model.id !== id);
}

function mergeCandidates(provider, models) {
    const next = (provider.candidates || []).slice();
    for (const item of models || []) {
        const entry = modelEntry(item);
        if (!entry.id) continue;
        const index = next.findIndex((model) => model.id === entry.id);
        if (index >= 0) next[index] = { ...next[index], ...entry, capabilities: entry.capabilities || next[index].capabilities };
        else next.push(entry);
        if (provider.modelMeta && !provider.modelMeta[entry.id] && Object.keys(entry.capabilities || {}).length) {
            provider.modelMeta[entry.id] = entry.capabilities;
        }
    }
    provider.candidates = next;
}

/** Key typed on this page for a provider whose stored key cannot be shown. */
function testKeyFor(providerId) {
    return String(draft.testKeys[providerId] || '');
}

function keyForDiscovery(providerId) {
    const op = draft.keyOps[providerId] || { action: 'preserve' };
    if (op.action === 'replace') return String(op.apiKey || '').trim() || testKeyFor(providerId);
    if (op.action === 'clear') return '';
    return testKeyFor(providerId);
}

function importLegacyDraft(payload) {
    const rows = Array.isArray(payload && payload.providers) ? payload.providers : [];
    if (!rows.length) throw new Error('no providers');
    const idMap = new Map();
    const added = [];
    for (const row of rows) {
        const sourceId = String(row.sourceId || row.id || 'default');
        const id = newManagedId();
        idMap.set(sourceId, id);
        const format = ['openai-chat', 'anthropic-messages', 'gemini'].includes(row.format) ? row.format : 'openai-chat';
        const authMode = row.apiKey ? (format === 'anthropic-messages' ? 'x-api-key' : (format === 'gemini' ? 'google' : 'bearer')) : 'none';
        let endpoints;
        try {
            endpoints = buildProviderDefinition({
                format,
                baseUrl: row.baseUrl || row.apiUrl || '',
                apiUrl: row.apiUrl || '',
                modelsUrl: row.modelsUrl || '',
                authMode,
                apiKey: row.apiKey ? '__import__' : ''
            });
        } catch (_) {
            endpoints = { baseUrl: row.baseUrl || '', apiUrl: row.apiUrl || '', modelsUrl: row.modelsUrl || '', authMode };
        }
        const models = Array.from(new Set((row.allowedModels || []).map((value) => String(value || '').trim()).filter(Boolean)));
        const provider = {
            id,
            name: String(row.label || sourceId).slice(0, 120),
            enabled: false,
            order: draft.config.providers.length,
            format,
            formatVersion: 1,
            baseUrl: endpoints.baseUrl,
            apiUrl: endpoints.apiUrl,
            modelsUrl: endpoints.modelsUrl,
            authMode,
            models: models.map((model) => ({ id: model, label: model, capabilities: {} })),
            candidates: [],
            modelMeta: {}
        };
        draft.config.providers.push(provider);
        draft.credentials[id] = { hasKey: false, credentialRevision: 0, binding: null };
        draft.keyOps[id] = { action: 'replace', apiKey: String(row.apiKey || '') };
        added.push(provider);
    }
    const firstProvider = added[0];
    const tasks = payload && payload.tasks && typeof payload.tasks === 'object' ? payload.tasks : {};
    for (const [task, spec] of Object.entries(tasks)) {
        let sourceProvider = '';
        let model = '';
        if (typeof spec === 'string') {
            const index = spec.indexOf(':');
            if (index === -1) model = spec.trim();
            else {
                sourceProvider = spec.slice(0, index).trim();
                model = spec.slice(index + 1).trim();
            }
        } else if (spec && typeof spec === 'object') {
            sourceProvider = String(spec.provider || spec.providerId || spec.profile || '').trim();
            model = String(spec.model || '').trim();
        }
        if (!model) continue;
        const targetId = idMap.get(sourceProvider)
            || ((sourceProvider === 'default' || !sourceProvider) ? (idMap.get('default') || firstProvider.id) : '');
        if (!targetId) continue;
        const provider = draft.config.providers.find((item) => item.id === targetId);
        if (!provider) continue;
        if (!provider.models.some((item) => item.id === model)) {
            provider.models.push({ id: model, label: model, capabilities: {} });
        }
        draft.config.tasks[task] = { providerId: provider.id, model };
    }
    ensureKeyOps(draft);
    return added.length;
}

function renderModelSection(provider) {
    const approved = provider.models || [];
    provider.modelPicker ||= {};
    return `<div class="ai-admin-models">
        <div class="ai-admin-models-head">
            <span>${escapeHtml(t('settings.aiAdminApprovedModels'))}</span>
            <span class="gs-ai-muted">${escapeHtml(t('settings.aiModelsCount', { count: approved.length }))}</span>
        </div>
        ${renderModelPicker({ id: `admin-${provider.id}`, models: [...approved, ...(provider.candidates || [])], selected: approved.map((model) => model.id), state: provider.modelPicker })}
        <div class="ai-admin-model-add">
            <input type="text" data-admin-model-manual="${escapeHtml(provider.id)}" placeholder="${escapeHtml(t('settings.aiAdminModelManual'))}" autocomplete="off" spellcheck="false">
            <button type="button" class="btn-secondary gs-ai-small" data-admin-add-model="${escapeHtml(provider.id)}">${escapeHtml(t('settings.aiAdminAddModel'))}</button>
        </div>
    </div>`;
}

function renderProviderCard(provider) {
    const meta = draft.credentials[provider.id] || {};
    const op = draft.keyOps[provider.id] || { action: provider.authMode === 'none' ? 'preserve' : 'replace', apiKey: '' };
    const taskRefs = TASKS.filter((task) => draft.config.tasks?.[task]?.providerId === provider.id);
    const formatOptions = FORMATS
        .map(([value, key]) => `<option value="${value}" ${provider.format === value ? 'selected' : ''}>${escapeHtml(t(key))}</option>`).join('');
    const authOptions = AUTH_MODES
        .map(([value, key]) => `<option value="${value}" ${provider.authMode === value ? 'selected' : ''}>${escapeHtml(t(key))}</option>`).join('');
    return `<div class="ai-admin-card" data-admin-card="${escapeHtml(provider.id)}">
        <div class="ai-admin-card-head">
            <span class="ai-admin-id">${escapeHtml(provider.id)}</span>
            <span class="ai-admin-provider-name">${escapeHtml(provider.name || provider.id)}</span>
            <span class="gs-ai-badge">${escapeHtml(formatLabel(provider.format))}</span>
            <label class="ai-admin-inline"><input type="checkbox" data-admin-enabled="${escapeHtml(provider.id)}" ${provider.enabled ? 'checked' : ''}> ${escapeHtml(t('settings.enabled'))}</label>
            <button type="button" class="btn-secondary gs-ai-small" data-admin-remove="${escapeHtml(provider.id)}">${escapeHtml(t('settings.remove'))}</button>
        </div>
        <div class="ai-admin-grid">
            <label>${escapeHtml(t('settings.name'))}
                <input type="text" data-admin-name="${escapeHtml(provider.id)}" value="${escapeHtml(provider.name)}">
            </label>
            <label>${escapeHtml(t('settings.aiServiceUrl'))}
                <input type="text" data-admin-base="${escapeHtml(provider.id)}" value="${escapeHtml(provider.baseUrl || '')}" placeholder="https://example.com/v1">
            </label>
        </div>
        ${renderModelSection(provider)}
        <details class="gs-ai-advanced" data-keep-open="admin-advanced-${escapeHtml(provider.id)}">
            <summary>${escapeHtml(t('settings.aiAdvanced'))}</summary>
            <div class="ai-admin-grid">
                <label>${escapeHtml(t('settings.aiProtocol'))}
                    <select data-admin-format="${escapeHtml(provider.id)}">${formatOptions}</select>
                </label>
                <label>${escapeHtml(t('settings.aiAuthMode'))}
                    <select data-admin-auth="${escapeHtml(provider.id)}">${authOptions}</select>
                </label>
                <label>${escapeHtml(t('settings.aiApiEndpoint'))}
                    <input type="text" data-admin-api="${escapeHtml(provider.id)}" value="${escapeHtml(provider.apiUrl || '')}">
                </label>
                <label>${escapeHtml(t('settings.aiModelsEndpoint'))}
                    <input type="text" data-admin-models-url="${escapeHtml(provider.id)}" value="${escapeHtml(provider.modelsUrl || '')}">
                </label>
                <label>${escapeHtml(t('settings.order'))}
                    <input type="number" data-admin-order="${escapeHtml(provider.id)}" value="${Number(provider.order) || 0}">
                </label>
                ${provider.authMode !== 'none' ? `<label>${escapeHtml(t('settings.aiAdminKeyForTest'))}
                    <input type="password" data-admin-testkey="${escapeHtml(provider.id)}" value="${escapeHtml(testKeyFor(provider.id))}" autocomplete="off" placeholder="sk-...">
                </label>` : ''}
            </div>
        </details>
        <div class="ai-admin-key">
            <label>${escapeHtml(t('settings.aiKeyAction'))}
                <select data-admin-keyaction="${escapeHtml(provider.id)}">
                    ${provider.authMode === 'none' ? `<option value="preserve" selected>${escapeHtml(t('settings.aiKeyNoneNeeded'))}</option>`
                        : `<option value="preserve" ${op.action === 'preserve' ? 'selected' : ''}>${escapeHtml(meta.hasKey ? t('settings.aiKeyPreserve') : t('settings.aiKeyNoExisting'))}</option>
                           <option value="replace" ${op.action === 'replace' ? 'selected' : ''}>${escapeHtml(t('settings.aiKeyReplace'))}</option>
                           <option value="clear" ${op.action === 'clear' ? 'selected' : ''}>${escapeHtml(t('settings.aiKeyClear'))}</option>`}
                </select>
            </label>
            ${provider.authMode !== 'none' && op.action === 'replace' ? `<label>${escapeHtml(t('settings.aiApiKey'))}
                <input type="password" data-admin-key="${escapeHtml(provider.id)}" value="${escapeHtml(op.apiKey || '')}" autocomplete="off" placeholder="sk-...">
            </label>` : ''}
            <div class="ai-admin-actions">
                <button type="button" class="btn-secondary gs-ai-small" data-admin-discover="${escapeHtml(provider.id)}">${escapeHtml(t('settings.aiDiscoverModels'))}</button>
                <button type="button" class="btn-secondary gs-ai-small" data-admin-test="${escapeHtml(provider.id)}">${escapeHtml(t('settings.aiTestModel'))}</button>
                ${draft.testResult[provider.id] ? `<span class="gs-ai-status ${draft.testResult[provider.id].ok ? 'success' : 'error'}">${escapeHtml(draft.testResult[provider.id].message)}</span>` : ''}
            </div>
            <p class="gs-hint">${escapeHtml(t('settings.aiTestCost'))}</p>
            ${meta.hasKey ? `<p class="gs-hint">${escapeHtml(t('settings.aiKeyPreserveHint'))}</p>` : ''}
            ${taskRefs.length ? `<p class="gs-hint">${escapeHtml(t('settings.aiTasksAffected', { tasks: taskRefs.map((task) => t(TASK_LABELS[task])).join('、') }))}</p>` : ''}
        </div>
    </div>`;
}

function emptyAddForm() {
    return {
        url: '',
        apiKey: '',
        name: '',
        format: 'auto',
        authMode: '',
        apiUrl: '',
        modelsUrl: '',
        order: null,
        showKey: false,
        advancedOpen: false,
        importedFrom: '',
        connection: null,
        candidates: [],
        approved: {},
        manual: [],
        connecting: false,
        controller: null,
        errorCode: '',
        error: ''
    };
}

function addFormCandidateLabel(modelId) {
    const candidate = (draft.addForm?.candidates || []).find((model) => model.id === modelId);
    return (candidate && (candidate.label || candidate.id)) || modelId;
}

function personalProvidersForPrefill() {
    try {
        const profile = loadAIProfile();
        return Object.values(profile.providers || {}).map((provider) => ({
            id: provider.id,
            label: provider.label || provider.id,
            baseUrl: provider.baseUrl || provider.apiUrl || '',
            format: provider.format || 'openai-chat',
            models: (provider.allowedModels && provider.allowedModels.length)
                ? provider.allowedModels.slice()
                : (provider.discoveredModels || []).map((model) => model.id)
        }));
    } catch (_) {
        return [];
    }
}

function renderAddForm() {
    const form = draft.addForm;
    if (!form) return '';
    const prefill = personalProvidersForPrefill();
    const formatRow = [['auto', 'settings.aiProtocolAuto'], ...FORMATS];
    const candidateIds = Array.from(new Set([
        ...(form.candidates || []).map((model) => model.id),
        ...(form.manual || [])
    ])).filter(Boolean);
    const approvedCount = Object.values(form.approved || {}).filter(Boolean).length;
    form.modelPicker ||= {};
    const modelList = renderModelPicker({ id: 'admin-add', models: candidateIds.map((id) => ({ id, label: addFormCandidateLabel(id) })), selected: candidateIds.filter((id) => form.approved[id]), state: form.modelPicker });
    return `<div class="ai-admin-newform gs-ai-form">
        <h4>${escapeHtml(t('settings.aiAdminNewProvider'))}</h4>
        <label class="gs-ai-field">
            <span>${escapeHtml(t('settings.aiServiceUrl'))}</span>
            <input type="text" data-admin-form-url value="${escapeHtml(form.url)}" placeholder="https://example.com/v1" autocomplete="off" spellcheck="false">
        </label>
        <label class="gs-ai-field">
            <span>${escapeHtml(t('settings.aiApiKey'))}</span>
            <span class="gs-ai-key-row">
                <input type="${form.showKey ? 'text' : 'password'}" data-admin-form-key value="${escapeHtml(form.apiKey)}" autocomplete="off" spellcheck="false" placeholder="sk-...">
                <button type="button" class="btn-secondary gs-ai-small" data-admin-form-toggle-key>${escapeHtml(form.showKey ? t('settings.aiHideKey') : t('settings.aiShowKey'))}</button>
            </span>
        </label>
        <p class="gs-hint">${escapeHtml(t('settings.aiKeyOptionalHint'))} · ${escapeHtml(t('settings.aiAdminKeyHint'))}</p>
        ${prefill.length ? `<label class="gs-ai-field">
            <span>${escapeHtml(t('settings.aiAdminUsePersonal'))}</span>
            <select data-admin-form-import>
                <option value="">${escapeHtml(t('settings.aiAdminUsePersonalNone'))}</option>
                ${prefill.map((provider) => `<option value="${escapeHtml(provider.id)}" ${form.importedFrom === provider.id ? 'selected' : ''}>${escapeHtml(provider.label)}</option>`).join('')}
            </select>
            <span class="gs-hint">${escapeHtml(t('settings.aiAdminUsePersonalHint'))}</span>
        </label>` : ''}
        <details class="gs-ai-advanced" data-admin-form-advanced data-keep-open="admin-add-advanced" ${form.advancedOpen ? 'open' : ''}>
            <summary>${escapeHtml(t('settings.aiAdvanced'))}</summary>
            <label class="gs-ai-field">
                <span>${escapeHtml(t('settings.name'))}</span>
                <input type="text" data-admin-form-name value="${escapeHtml(form.name)}" placeholder="${escapeHtml(t('settings.aiProviderNamePlaceholder'))}">
            </label>
            <label class="gs-ai-field">
                <span>${escapeHtml(t('settings.aiProtocol'))}</span>
                <select data-admin-form-format>
                    ${formatRow.map(([value, key]) => `<option value="${value}" ${form.format === value ? 'selected' : ''}>${escapeHtml(t(key))}</option>`).join('')}
                </select>
            </label>
            <label class="gs-ai-field">
                <span>${escapeHtml(t('settings.aiAuthMode'))}</span>
                <select data-admin-form-auth>
                    <option value="" ${form.authMode ? '' : 'selected'}>${escapeHtml(t('settings.aiAuthAuto'))}</option>
                    ${AUTH_MODES.map(([value, key]) => `<option value="${value}" ${form.authMode === value ? 'selected' : ''}>${escapeHtml(t(key))}</option>`).join('')}
                </select>
            </label>
            <label class="gs-ai-field">
                <span>${escapeHtml(t('settings.aiApiEndpoint'))}</span>
                <input type="text" data-admin-form-api value="${escapeHtml(form.apiUrl)}" placeholder="${escapeHtml(t('settings.deriveApiUrl'))}">
            </label>
            <label class="gs-ai-field">
                <span>${escapeHtml(t('settings.aiModelsEndpoint'))}</span>
                <input type="text" data-admin-form-models value="${escapeHtml(form.modelsUrl)}" placeholder="${escapeHtml(t('settings.deriveModelsUrl'))}">
            </label>
            <p class="gs-hint">${escapeHtml(t('settings.aiAdminAdvancedHint'))}</p>
        </details>
        <div class="gs-ai-connect-row">
            <button type="button" class="btn-primary" data-admin-form-connect ${form.connecting ? 'disabled' : ''}>${escapeHtml(form.connecting ? t('settings.aiConnecting') : t('settings.aiConnect'))}</button>
            ${form.connecting ? `<button type="button" class="btn-secondary gs-ai-small" data-admin-form-connect-cancel>${escapeHtml(t('settings.cancel'))}</button>` : ''}
            <button type="button" class="btn-secondary gs-ai-small" data-admin-form-cancel>${escapeHtml(t('settings.cancel'))}</button>
            ${form.connection ? `<span class="gs-ai-status success">${escapeHtml(t('settings.aiConnectModelsFound'))}</span>
                <span class="gs-ai-badge">${escapeHtml(t('settings.aiAdminProtocolDetected', { format: formatLabel(form.connection.format) }))}</span>` : ''}
            ${form.errorCode ? `<span class="gs-ai-error">${escapeHtml(describeDetectionError(form.errorCode))}</span>` : ''}
            ${form.error ? `<span class="gs-ai-error">${escapeHtml(form.error)}</span>` : ''}
        </div>
        ${form.errorCode ? `<p class="gs-hint">${escapeHtml(t('settings.aiAdminManualFallback'))}</p>` : ''}
        ${(form.errorCode || candidateIds.length) ? `<div class="ai-admin-models">
            <div class="ai-admin-models-head">
                <span>${escapeHtml(t('settings.aiAdminApprovedModels'))}</span>
                <span class="gs-ai-muted">${escapeHtml(t('settings.aiModelsCount', { count: approvedCount }))}</span>
            </div>
            ${modelList || `<p class="gs-hint">${escapeHtml(t('settings.aiAdminNoApprovedModel'))}</p>`}
            <div class="ai-admin-model-add">
                <input type="text" data-admin-form-manual placeholder="${escapeHtml(t('settings.aiManualModelHint'))}" autocomplete="off" spellcheck="false">
                <button type="button" class="btn-secondary gs-ai-small" data-admin-form-add-manual>${escapeHtml(t('settings.aiAdminAddModel'))}</button>
            </div>
            <p class="gs-hint">${escapeHtml(t('settings.aiAdminCandidatesHint'))}</p>
        </div>` : ''}
        <div class="ai-admin-actions">
            <button type="button" class="btn-primary" data-admin-form-add ${approvedCount ? '' : 'disabled'}>${escapeHtml(t('settings.aiAdminAddToDraft'))}</button>
        </div>
    </div>`;
}

function formatLabel(format) {
    if (format === 'anthropic-messages') return t('settings.aiFormatAnthropic');
    if (format === 'gemini') return t('settings.aiFormatGemini');
    return t('settings.aiFormatChat');
}

function render() {
    const host = body();
    if (!host) return;
    if (draft.busy) {
        host.innerHTML = `<div class="ai-admin-empty">${escapeHtml(t('settings.loading'))}</div>`;
        return;
    }
    if (draft.error && !draft.config.providers.length) {
        host.innerHTML = `<div class="ai-admin-empty error">${escapeHtml(draft.error)}</div>
            <div class="ai-admin-actions"><button type="button" class="btn-secondary" data-admin-retry>${escapeHtml(t('settings.aiRetry'))}</button></div>`;
        wire(host);
        return;
    }
    // 選模型等操作會整塊重繪；先記住折疊區塊的展開狀態，重建後還原。
    const openDetails = captureDetailState(host);
    const providersHtml = draft.config.providers.map(renderProviderCard).join('');

    const taskRows = TASKS.map((task) => {
        const spec = draft.config.tasks?.[task] || null;
        const { providerOptions, modelOptions } = taskOptions(draft, spec?.providerId || '', spec?.model || '');
        return `<div class="ai-admin-task-row">
            <span>${escapeHtml(t(TASK_LABELS[task]))}</span>
            <select data-admin-task-provider="${task}">
                <option value="">${escapeHtml(t('settings.aiDefaultNone'))}</option>
                ${providerOptions}
            </select>
            <select data-admin-task-model="${task}" ${modelOptions ? '' : 'disabled'}>
                ${modelOptions || `<option value="">${escapeHtml(t('settings.noModels'))}</option>`}
            </select>
        </div>`;
    }).join('');

    const historyHtml = draft.historyOpen
        ? `<div class="ai-admin-history">${draft.history.length ? draft.history.map((item) => `
                <div class="ai-admin-history-row">
                    <span>v${item.version} · ${escapeHtml(item.publishedBy || '')} · ${escapeHtml(formatTime(item.publishedAt))}</span>
                    <button type="button" class="btn-secondary gs-ai-small" data-admin-restore="${item.version}">${escapeHtml(t('settings.aiAdminRestore'))}</button>
                </div>`).join('') : `<div class="ai-admin-empty">${escapeHtml(t('settings.aiAdminNoHistory'))}</div>`}</div>`
        : '';

    host.innerHTML = `
        ${draft.error ? `<div class="gs-ai-error">${escapeHtml(draft.error)}</div>` : ''}
        ${draft.notice ? `<div class="gs-ai-notice success">${escapeHtml(draft.notice)}</div>` : ''}
        <div class="ai-admin-meta">
            <span>${escapeHtml(t('settings.aiAdminVersion', { version: draft.version }))}</span>
            ${draft.publishedBy ? `<span>${escapeHtml(t('settings.aiAdminPublishedBy', { user: draft.publishedBy, time: formatTime(draft.publishedAt) }))}</span>` : ''}
            <span class="gs-hint">${escapeHtml(t('settings.aiAdminDraftHint'))}</span>
        </div>
        ${renderAddForm()}
        <div class="ai-admin-cards">${providersHtml || `<div class="ai-admin-empty">${escapeHtml(t('settings.aiManagedEmpty'))}</div>`}</div>
        <div class="ai-admin-actions">
            <button type="button" class="btn-secondary" data-admin-add>${escapeHtml(t('settings.aiAdminNewProvider'))}</button>
            <button type="button" class="btn-secondary" data-admin-import>${escapeHtml(t('settings.aiAdminImport'))}</button>
            <input type="file" accept="application/json,.json" hidden data-admin-import-file>
            <button type="button" class="btn-secondary" data-admin-history>${escapeHtml(t('settings.aiAdminHistory'))}</button>
        </div>
        ${historyHtml}
        <div class="ai-admin-tasks">
            <h4>${escapeHtml(t('settings.taskMapping'))}</h4>
            ${taskRows}
        </div>
        <div class="ai-admin-publish">
            <button type="button" class="btn-primary" data-admin-publish ${draft.busy ? 'disabled' : ''}>${escapeHtml(t('settings.aiAdminPublish'))}</button>
            <span class="gs-hint">${escapeHtml(t('settings.aiAdminPublishHint'))}</span>
        </div>
        <div class="ai-admin-warning">${escapeHtml(t('settings.aiAdminKeyWarning'))}</div>
    `;
    restoreDetailState(host, openDetails);
    wire(host);
}

function collectKeyOps() {
    const ops = {};
    for (const provider of draft.config.providers) {
        const op = draft.keyOps[provider.id] || { action: 'preserve' };
        if (provider.authMode === 'none') {
            ops[provider.id] = { action: 'preserve' };
        } else if (op.action === 'replace') {
            const input = panel?.querySelector(`[data-admin-key="${CSS.escape(provider.id)}"]`);
            const apiKey = String(input ? input.value : op.apiKey || '').trim();
            ops[provider.id] = { action: 'replace', apiKey };
        } else if (op.action === 'clear') {
            ops[provider.id] = { action: 'clear' };
        } else {
            ops[provider.id] = { action: 'preserve' };
        }
    }
    return ops;
}

function validateBeforePublish(keyOps) {
    for (const provider of draft.config.providers) {
        if (provider.authMode !== 'none') {
            const op = keyOps[provider.id];
            const meta = draft.credentials[provider.id];
            if (op.action === 'replace' && !op.apiKey) return t('settings.aiKeyRequired');
            if (op.action === 'preserve' && !meta?.hasKey) return t('settings.aiKeyRequired');
            if (op.action === 'clear' && provider.enabled) return t('settings.aiAdminCannotClearEnabled');
        }
        if (!provider.apiUrl) return t('settings.aiUrlRequired');
        if (!provider.models.length) return t('settings.aiNeedModel');
    }
    for (const task of TASKS) {
        const spec = draft.config.tasks?.[task];
        if (!spec) continue;
        const provider = draft.config.providers.find((item) => item.id === spec.providerId);
        if (!provider || !provider.models.some((model) => model.id === spec.model)) {
            return t('settings.aiAdminDanglingTask', { task: t(TASK_LABELS[task]) });
        }
    }
    return '';
}

async function publish() {
    const captured = captureAuthSession();
    draft.error = '';
    draft.notice = '';
    draft.busy = true;
    render();
    try {
        const keyOps = collectKeyOps();
        const invalid = validateBeforePublish(keyOps);
        if (invalid) {
            draft.error = invalid;
            draft.busy = false;
            render();
            return;
        }
        draft.config.providers = draft.config.providers.map((provider) => {
            try { return { ...sanitizeDraftProvider(provider), models: provider.models }; }
            catch (_) { return provider; }
        });
        // Only the approved model list is published; discovery candidates and
        // per-model capability hints stay in this page's draft.
        const payload = {
            baseVersion: draft.version,
            mutationId: lastPublishMutation && lastPublishDigest === JSON.stringify({ config: draft.config, keyOps })
                ? lastPublishMutation
                : newMutationId(),
            config: {
                schemaVersion: 1,
                providers: draft.config.providers.map(providerToConfig),
                tasks: draft.config.tasks
            },
            keyOps
        };
        lastPublishMutation = payload.mutationId;
        lastPublishDigest = JSON.stringify({ config: draft.config, keyOps });
        const res = await apiRequest('/admin/ai-catalog/publish', {
            method: 'POST',
            body: JSON.stringify(payload)
        }, { timeoutMs: 30000 });
        if (!isAuthSessionCurrent(captured)) return;
        if (res.status === 401) {
            draft.error = t('errors.aiLoginRequired');
        } else if (res.status === 403) {
            draft.error = t('errors.aiAdminRequired');
        } else if (res.status === 409) {
            const data = await res.json().catch(() => ({}));
            draft.error = data.code === 'mutation_conflict' ? t('settings.aiAdminMutationConflict') : t('settings.aiAdminConflict');
            lastPublishMutation = '';
            lastPublishDigest = '';
        } else if (!res.ok) {
            draft.error = t('settings.aiAdminPublishFailed');
        } else {
            const data = await res.json().catch(() => ({}));
            draft.version = Number(data.version) || draft.version;
            draft.publishedAt = data.publishedAt || new Date().toISOString();
            draft.publishedBy = getAuthSnapshot().userId;
            draft.notice = t('settings.aiAdminPublished', { version: draft.version });
            lastPublishMutation = '';
            lastPublishDigest = '';
            // Refresh local credentials metadata so "has key" reflects the new release.
            await loadMetadataOnly();
            refreshAICatalog({ force: true, reason: 'admin-publish' }).catch(() => {});
        }
    } catch (error) {
        draft.error = t('settings.aiAdminPublishFailed');
        // Keep the mutationId so an identical retry is idempotent.
    }
    draft.busy = false;
    render();
}

async function loadMetadataOnly() {
    const captured = captureAuthSession();
    try {
        const res = await apiRequest('/admin/ai-catalog', { method: 'GET' }, { timeoutMs: 15000 });
        if (!isAuthSessionCurrent(captured)) return;
        if (!res.ok) return;
        const data = await res.json().catch(() => null);
        if (!data) return;
        draft.version = Number(data.version) || draft.version;
        draft.credentials = data.credentials || {};
        draft.publishedBy = data.publishedBy || draft.publishedBy;
        draft.publishedAt = data.publishedAt || draft.publishedAt;
        ensureKeyOps(draft);
    } catch (_) {}
}

async function loadHistory() {
    draft.historyOpen = true;
    render();
    const captured = captureAuthSession();
    try {
        const res = await apiRequest('/admin/ai-catalog/history', { method: 'GET' }, { timeoutMs: 15000 });
        if (!isAuthSessionCurrent(captured)) return;
        if (!res.ok) throw new Error('history');
        const data = await res.json().catch(() => ({}));
        draft.history = Array.isArray(data.items) ? data.items : [];
    } catch (_) {
        draft.history = [];
    }
    render();
}

function restoreHistory(version) {
    const item = draft.history.find((entry) => Number(entry.version) === Number(version));
    if (!item) return;
    draft.config = {
        schemaVersion: 1,
        providers: (item.config?.providers || []).map(normalizeDraftProvider),
        tasks: item.config?.tasks || {}
    };
    draft.keyOps = {};
    draft.testKeys = {};
    ensureKeyOps(draft);
    draft.notice = t('settings.aiAdminRestored', { version });
    draft.error = '';
    render();
}

async function discoverModels(providerId) {
    const provider = draftProvider(providerId);
    if (!provider) return;
    const apiKey = keyForDiscovery(providerId);
    if (provider.authMode !== 'none' && !apiKey) {
        draft.testResult[providerId] = { ok: false, message: t('settings.aiAdminNeedKeyToTest') };
        render();
        return;
    }
    let normalized;
    try { normalized = sanitizeDraftProvider(provider); }
    catch (_) {
        draft.testResult[providerId] = { ok: false, message: t('settings.aiUrlInvalid') };
        render();
        return;
    }
    // One failing provider only reports its own error; the rest of the draft
    // stays editable and publishable.
    const result = await fetchProviderModels({ provider: normalized, apiKey, timeoutMs: 15000, allowCrossOrigin: true });
    if (!draftProvider(providerId)) return;
    if (result.ok) {
        mergeCandidates(provider, result.models);
        draft.testResult[providerId] = { ok: true, message: t('settings.aiAdminDiscovered') };
    } else {
        draft.testResult[providerId] = { ok: false, message: describeDetectionError(result.errorCode) };
    }
    render();
}

async function testModel(providerId) {
    const provider = draftProvider(providerId);
    if (!provider) return;
    const apiKey = keyForDiscovery(providerId);
    if (provider.authMode !== 'none' && !apiKey) {
        draft.testResult[providerId] = { ok: false, message: t('settings.aiAdminNeedKeyToTest') };
        render();
        return;
    }
    const model = (provider.models[0] && provider.models[0].id)
        || (provider.candidates[0] && provider.candidates[0].id)
        || '';
    if (!model) {
        draft.testResult[providerId] = { ok: false, message: t('settings.aiNeedModel') };
        render();
        return;
    }
    let normalized;
    try { normalized = sanitizeDraftProvider(provider); }
    catch (_) {
        draft.testResult[providerId] = { ok: false, message: t('settings.aiUrlInvalid') };
        render();
        return;
    }
    const result = await testProviderModel({ provider: normalized, apiKey, model });
    if (!draftProvider(providerId)) return;
    draft.testResult[providerId] = {
        ok: result.ok,
        message: result.ok ? t('settings.aiTestOk') : describeDetectionError(result.errorCode)
    };
    render();
}

function cancelAddFormConnection() {
    try { draft.addForm?.controller?.abort(); } catch (_) {}
    if (draft.addForm) {
        draft.addForm.connecting = false;
        draft.addForm.controller = null;
    }
}

function openAddForm() {
    draft.addForm = emptyAddForm();
    draft.error = '';
    draft.notice = '';
    render();
}

function closeAddForm() {
    cancelAddFormConnection();
    draft.addForm = null;
    render();
}

async function connectAddForm() {
    const form = draft.addForm;
    if (!form) return;
    const url = String(form.url || '').trim();
    if (!url) {
        form.errorCode = 'url_required';
        render();
        return;
    }
    cancelAddFormConnection();
    const requestSeq = (form.requestSeq || 0) + 1;
    form.requestSeq = requestSeq;
    form.connecting = true;
    form.errorCode = '';
    form.error = '';
    form.connection = null;
    const controller = new AbortController();
    form.controller = controller;
    render();
    try {
        const result = await detectProvider({
            url,
            apiKey: String(form.apiKey || '').trim(),
            format: form.format === 'auto' ? '' : form.format,
            signal: controller.signal
        });
        const currentForm = draft.addForm;
        if (!currentForm || currentForm.requestSeq !== requestSeq || String(currentForm.url || '').trim() !== url) return;
        if (result.ok) {
            currentForm.connection = result;
            currentForm.candidates = result.models.map((model) => ({ id: model.id, label: model.label || model.id, capabilities: {} }));
            // Nothing is pre-approved: the admin must explicitly tick the models
            // that may be used by everyone.
            currentForm.approved = {};
            currentForm.authMode = result.provider.authMode;
            currentForm.errorCode = '';
        } else {
            currentForm.errorCode = result.errorCode || 'provider_unreachable';
        }
    } catch (error) {
        if (draft.addForm && error && error.name !== 'AbortError') {
            draft.addForm.errorCode = error.code || 'provider_unreachable';
        }
    } finally {
        const currentForm = draft.addForm;
        if (currentForm && currentForm.requestSeq === requestSeq) {
            currentForm.connecting = false;
            currentForm.controller = null;
            render();
        }
    }
}

function prefillFromPersonal(providerId) {
    const form = draft.addForm;
    if (!form) return;
    form.importedFrom = providerId;
    if (!providerId) { render(); return; }
    const provider = personalProvidersForPrefill().find((item) => item.id === providerId);
    if (!provider) { render(); return; }
    form.url = provider.baseUrl || '';
    form.format = provider.format || 'auto';
    form.name = provider.label || '';
    // Never copy the personal key: publishing it as a shared key must be a
    // deliberate act, so the admin pastes it again.
    form.apiKey = '';
    form.candidates = provider.models.map((model) => ({ id: model, label: model, capabilities: {} }));
    form.approved = {};
    form.connection = null;
    form.errorCode = '';
    render();
}

function submitAddForm() {
    const form = draft.addForm;
    if (!form) return;
    const approved = Object.keys(form.approved || {}).filter((id) => form.approved[id]);
    if (!approved.length) {
        form.error = t('settings.aiAdminSelectModel');
        render();
        return;
    }
    const format = (form.format && form.format !== 'auto')
        ? form.format
        : (form.connection?.format || 'openai-chat');
    let endpoints;
    try {
        endpoints = buildProviderDefinition({
            format,
            baseUrl: form.connection?.baseUrl || form.url,
            apiUrl: form.apiUrl || form.connection?.apiUrl || '',
            modelsUrl: form.modelsUrl || form.connection?.modelsUrl || '',
            authMode: form.authMode,
            apiKey: String(form.apiKey || '').trim()
        });
    } catch (_) {
        form.error = t('settings.aiUrlInvalid');
        render();
        return;
    }
    const id = newManagedId();
    const candidates = (form.candidates || []).slice();
    const labelOf = (modelId) => {
        const candidate = candidates.find((model) => model.id === modelId);
        return (candidate && (candidate.label || candidate.id)) || modelId;
    };
    const provider = {
        id,
        name: String(form.name || '').trim() || hostLabel(form.url) || id,
        enabled: true,
        order: draft.config.providers.length,
        format: endpoints.format,
        formatVersion: 1,
        baseUrl: endpoints.baseUrl,
        apiUrl: endpoints.apiUrl,
        modelsUrl: endpoints.modelsUrl,
        authMode: endpoints.authMode,
        models: approved.map((modelId) => ({ id: modelId, label: labelOf(modelId), capabilities: {} })),
        candidates: candidates.filter((model) => !approved.includes(model.id)),
        modelMeta: {}
    };
    draft.config.providers.push(provider);
    draft.credentials[id] = { hasKey: false, credentialRevision: 0, binding: null };
    draft.keyOps[id] = endpoints.authMode === 'none'
        ? { action: 'preserve' }
        : { action: 'replace', apiKey: String(form.apiKey || '').trim() };
    draft.addForm = null;
    draft.notice = t('settings.aiAdminProviderAdded');
    draft.error = '';
    render();
}

function wire(host) {
    const all = (selector) => Array.from(host.querySelectorAll(selector));
    host.querySelector('[data-admin-close]')?.addEventListener('click', close);
    host.querySelector('[data-admin-retry]')?.addEventListener('click', loadDraft);
    host.querySelector('[data-admin-add]')?.addEventListener('click', openAddForm);
    host.querySelector('[data-admin-history]')?.addEventListener('click', loadHistory);
    host.querySelector('[data-admin-import]')?.addEventListener('click', () => host.querySelector('[data-admin-import-file]')?.click());
    host.querySelector('[data-admin-import-file]')?.addEventListener('change', async (event) => {
        const file = event.target.files && event.target.files[0];
        if (!file) return;
        try {
            const payload = JSON.parse(await file.text());
            const count = importLegacyDraft(payload);
            draft.notice = t('settings.aiAdminImported', { count });
            draft.error = '';
        } catch (_) {
            draft.error = t('settings.aiAdminImportFailed');
        }
        render();
    });
    host.querySelector('[data-admin-publish]')?.addEventListener('click', publish);

    all('[data-admin-remove]').forEach((button) => button.addEventListener('click', () => {
        const id = button.getAttribute('data-admin-remove');
        draft.config.providers = draft.config.providers.filter((provider) => provider.id !== id);
        for (const task of TASKS) {
            if (draft.config.tasks?.[task]?.providerId === id) delete draft.config.tasks[task];
        }
        delete draft.keyOps[id];
        delete draft.credentials[id];
        delete draft.testKeys[id];
        render();
    }));
    all('[data-admin-restore]').forEach((button) => button.addEventListener('click', () => restoreHistory(button.getAttribute('data-admin-restore'))));

    all('[data-admin-name]').forEach((input) => input.addEventListener('input', () => {
        const provider = draftProvider(input.getAttribute('data-admin-name'));
        if (provider) provider.name = input.value;
    }));
    all('[data-admin-enabled]').forEach((input) => input.addEventListener('change', () => {
        const provider = draftProvider(input.getAttribute('data-admin-enabled'));
        if (provider) provider.enabled = input.checked;
        render();
    }));
    all('[data-admin-format]').forEach((select) => select.addEventListener('change', () => {
        const provider = draftProvider(select.getAttribute('data-admin-format'));
        if (provider) {
            provider.format = select.value;
            provider.apiUrl = '';
            provider.modelsUrl = '';
            provider.apiUrlEdited = false;
            provider.modelsUrlEdited = false;
            render();
        }
    }));
    all('[data-admin-base]').forEach((input) => input.addEventListener('input', () => {
        const provider = draftProvider(input.getAttribute('data-admin-base'));
        if (!provider) return;
        provider.baseUrl = input.value;
        // A changed service URL invalidates auto-derived endpoints. Explicitly
        // edited overrides are kept until the admin changes them.
        if (!provider.apiUrlEdited) provider.apiUrl = '';
        if (!provider.modelsUrlEdited) provider.modelsUrl = '';
    }));
    all('[data-admin-api]').forEach((input) => input.addEventListener('input', () => {
        const provider = draftProvider(input.getAttribute('data-admin-api'));
        if (provider) {
            provider.apiUrl = input.value;
            provider.apiUrlEdited = true;
        }
    }));
    all('[data-admin-models-url]').forEach((input) => input.addEventListener('input', () => {
        const provider = draftProvider(input.getAttribute('data-admin-models-url'));
        if (provider) {
            provider.modelsUrl = input.value;
            provider.modelsUrlEdited = true;
        }
    }));
    for (const provider of draft.config.providers) {
        bindModelPicker(host, {
            id: `admin-${provider.id}`, models: [...provider.models, ...(provider.candidates || [])],
            selected: provider.models.map((model) => model.id), state: provider.modelPicker,
            onChange: (selected) => {
                for (const model of [...provider.models]) {
                    if (!selected.includes(model.id)) removeApprovedModel(provider, model.id);
                }
                for (const id of selected) addApprovedModel(provider, id);
                render();
            }
        });
    }
    all('[data-admin-add-model]').forEach((button) => button.addEventListener('click', () => {
        const provider = draftProvider(button.getAttribute('data-admin-add-model'));
        if (!provider) return;
        const input = host.querySelector(`[data-admin-model-manual="${CSS.escape(provider.id)}"]`);
        const value = String(input?.value || '').trim();
        if (!value) return;
        addApprovedModel(provider, value);
        render();
    }));
    all('[data-admin-order]').forEach((input) => input.addEventListener('change', () => {
        const provider = draftProvider(input.getAttribute('data-admin-order'));
        if (provider) provider.order = Number(input.value) || 0;
    }));
    all('[data-admin-auth]').forEach((select) => select.addEventListener('change', () => {
        const provider = draftProvider(select.getAttribute('data-admin-auth'));
        if (provider) {
            provider.authMode = select.value;
            if (provider.authMode === 'none') draft.keyOps[provider.id] = { action: 'preserve' };
            render();
        }
    }));
    all('[data-admin-keyaction]').forEach((select) => select.addEventListener('change', () => {
        const id = select.getAttribute('data-admin-keyaction');
        const input = host.querySelector(`[data-admin-key="${CSS.escape(id)}"]`);
        const existing = draft.keyOps[id]?.apiKey || '';
        draft.keyOps[id] = { action: select.value, apiKey: select.value === 'replace' ? (input?.value || existing) : '' };
        render();
    }));
    all('[data-admin-key]').forEach((input) => input.addEventListener('input', () => {
        const id = input.getAttribute('data-admin-key');
        draft.keyOps[id] = { action: 'replace', apiKey: input.value };
    }));
    all('[data-admin-testkey]').forEach((input) => input.addEventListener('input', () => {
        draft.testKeys[input.getAttribute('data-admin-testkey')] = input.value;
    }));
    all('[data-admin-discover]').forEach((button) => button.addEventListener('click', () => discoverModels(button.getAttribute('data-admin-discover'))));
    all('[data-admin-test]').forEach((button) => button.addEventListener('click', () => testModel(button.getAttribute('data-admin-test'))));
    all('[data-admin-task-provider]').forEach((select) => select.addEventListener('change', () => {
        const task = select.getAttribute('data-admin-task-provider');
        if (!select.value) {
            delete draft.config.tasks[task];
            render();
            return;
        }
        const provider = draftProvider(select.value);
        const model = provider?.models[0]?.id || '';
        draft.config.tasks[task] = { providerId: select.value, model };
        render();
    }));
    all('[data-admin-task-model]').forEach((select) => select.addEventListener('change', () => {
        const task = select.getAttribute('data-admin-task-model');
        const provider = draft.config.tasks?.[task]?.providerId;
        if (provider && select.value) draft.config.tasks[task] = { providerId: provider, model: select.value };
    }));

    // --- add form ---
    if (!draft.addForm) return;
    const form = draft.addForm;
    host.querySelector('[data-admin-form-url]')?.addEventListener('input', (event) => {
        form.url = event.target.value;
        form.connection = null;
        form.errorCode = '';
        form.requestSeq = (form.requestSeq || 0) + 1;
        cancelAddFormConnection();
    });
    host.querySelector('[data-admin-form-key]')?.addEventListener('input', (event) => { form.apiKey = event.target.value; });
    host.querySelector('[data-admin-form-toggle-key]')?.addEventListener('click', () => { form.showKey = !form.showKey; render(); });
    host.querySelector('[data-admin-form-name]')?.addEventListener('input', (event) => { form.name = event.target.value; });
    host.querySelector('[data-admin-form-format]')?.addEventListener('change', (event) => {
        form.format = event.target.value;
        form.connection = null;
        form.errorCode = '';
    });
    host.querySelector('[data-admin-form-auth]')?.addEventListener('change', (event) => { form.authMode = event.target.value; });
    host.querySelector('[data-admin-form-api]')?.addEventListener('input', (event) => { form.apiUrl = event.target.value; });
    host.querySelector('[data-admin-form-models]')?.addEventListener('input', (event) => { form.modelsUrl = event.target.value; });
    host.querySelector('[data-admin-form-advanced]')?.addEventListener('toggle', (event) => { form.advancedOpen = event.target.open; });
    host.querySelector('[data-admin-form-import]')?.addEventListener('change', (event) => prefillFromPersonal(event.target.value));
    host.querySelector('[data-admin-form-connect]')?.addEventListener('click', connectAddForm);
    host.querySelector('[data-admin-form-connect-cancel]')?.addEventListener('click', () => {
        cancelAddFormConnection();
        form.connecting = false;
        render();
    });
    host.querySelector('[data-admin-form-cancel]')?.addEventListener('click', closeAddForm);
    bindModelPicker(host, {
        id: 'admin-add', models: [...(form.candidates || []), ...(form.manual || [])],
        selected: Object.keys(form.approved).filter((id) => form.approved[id]), state: form.modelPicker,
        onChange: (selected) => {
            form.approved = Object.fromEntries(selected.map((id) => [id, true]));
            render();
        }
    });
    host.querySelector('[data-admin-form-add-manual]')?.addEventListener('click', () => {
        const input = host.querySelector('[data-admin-form-manual]');
        const value = String(input?.value || '').trim();
        if (!value) return;
        if (!form.candidates.some((model) => model.id === value)) {
            form.candidates = [...form.candidates, { id: value, label: value, capabilities: {} }];
        }
        form.approved[value] = true;
        if (input) input.value = '';
        render();
    });
    host.querySelector('[data-admin-form-add]')?.addEventListener('click', submitAddForm);
}

export function destroyAiAdminPanel() {
    close();
}
