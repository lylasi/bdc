// Admin user management (v1).
//
// Lists users, creates role=user accounts with a one-time passcode/recovery
// code, edits label/email, and resets non-admin credentials. Role changes,
// admin credential resets and account deletion stay deployer-only.
//
// Plaintext credentials live only in this panel's memory until the admin
// dismisses them; closing the panel drops them.

import {
    apiRequest,
    auth,
    getAuthSnapshot,
    captureAuthSession,
    isAuthSessionCurrent,
    AUTH_EVENT
} from '../../modules/sync-cloudflare.js';
import { t, formatDateTime } from '../../modules/i18n.js';
import { displayMessage, escapeHtml, confirmAction } from '../../modules/ui.js';
import { renderQrSvg } from '../../modules/qr.js';
import { SYNC } from '../../ai-config.js';

const USER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_LABEL_LENGTH = 120;
const LIST_LIMIT = 1000;
const PASSWORD_MIN_LENGTH = 10;
const ADMIN_PASSWORD_MIN_LENGTH = 12;
const DEFAULT_PAIR_TTL_SECONDS = 604800;
const PAIR_TTL_OPTIONS = [
    { seconds: 600, labelKey: 'settings.adminUsersPairTtl10m' },
    { seconds: 86400, labelKey: 'settings.adminUsersPairTtl24h' },
    { seconds: 604800, labelKey: 'settings.adminUsersPairTtl7d' },
    { seconds: 2592000, labelKey: 'settings.adminUsersPairTtl30d' }
];

let panel = null;
let escHandler = null;
let initialized = false;
let view = emptyView();

function emptyView() {
    return {
        users: [],
        currentUserId: '',
        loading: false,
        busy: false,
        error: '',
        notice: '',
        mode: 'list', // list | create | edit
        editingId: '',
        form: { userId: '', label: '', email: '', username: '', password: '' },
        formError: '',
        resetConfirm: '',
        credentials: null,
        pairing: null,
        pairTtl: DEFAULT_PAIR_TTL_SECONDS,
        limited: false
    };
}

export function initAdminUsers() {
    if (initialized) return;
    initialized = true;
    try {
        window.addEventListener(AUTH_EVENT, (event) => {
            const detail = event && event.detail ? event.detail : {};
            if (detail.event === 'SIGNED_OUT' || detail.event === 'ACCOUNT_CHANGED' || detail.event === 'SESSION_INVALID') {
                close();
            }
        });
    } catch (_) {}
}

export function openAdminUsersPanel() {
    const snapshot = getAuthSnapshot();
    if (!snapshot.loggedIn) {
        try { window.dispatchEvent(new CustomEvent('bdc:request-login')); } catch (_) {}
        return;
    }
    if (snapshot.role !== 'admin') {
        displayMessage(t('errors.aiAdminRequired'), 'error');
        return;
    }
    if (panel) return;

    view = emptyView();
    panel = document.createElement('div');
    panel.className = 'ai-admin-overlay';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', t('settings.adminUsersTitle'));
    panel.innerHTML = `<div class="ai-admin-panel admin-users-panel">
        <div class="ai-admin-head">
            <h3>${escapeHtml(t('settings.adminUsersTitle'))}</h3>
            <button type="button" class="btn-secondary" data-admin-users-close>${escapeHtml(t('settings.cancel'))}</button>
        </div>
        <div class="ai-admin-body" data-admin-users-body>${escapeHtml(t('settings.loading'))}</div>
    </div>`;
    document.body.appendChild(panel);
    panel.querySelector('[data-admin-users-close]').addEventListener('click', close);
    panel.addEventListener('click', (event) => { if (event.target === panel) close(); });
    escHandler = (event) => { if (event.key === 'Escape') close(); };
    document.addEventListener('keydown', escHandler);
    loadUsers();
}

function close() {
    view = emptyView();
    if (escHandler) {
        document.removeEventListener('keydown', escHandler);
        escHandler = null;
    }
    if (!panel) return;
    try { panel.remove(); } catch (_) {}
    panel = null;
}

function body() {
    return panel ? panel.querySelector('[data-admin-users-body]') : null;
}

function formatTime(value) {
    if (!value) return '';
    try { return formatDateTime(value, { hour12: false }); } catch (_) { return ''; }
}

function render() {
    const el = body();
    if (!el) return;
    el.innerHTML = renderHtml();
    bind();
    mountPairingQr();
}

function renderHtml() {
    return [
        view.error ? `<div class="ai-admin-empty error" role="alert">${escapeHtml(view.error)}</div>` : '',
        view.notice ? `<div class="ai-admin-empty" role="status">${escapeHtml(view.notice)}</div>` : '',
        view.credentials ? renderCredentials() : '',
        view.pairing ? renderPairing() : '',
        view.mode === 'create' ? renderCreateForm() : '',
        view.mode === 'edit' ? renderEditForm() : '',
        view.resetConfirm ? renderResetConfirm() : '',
        renderList()
    ].join('');
}

function renderList() {
    if (view.loading) return `<div class="ai-admin-empty">${escapeHtml(t('settings.loading'))}</div>`;
    const rows = view.users.length
        ? view.users.map(renderUser).join('')
        : `<div class="ai-admin-empty">${escapeHtml(t('settings.adminUsersEmpty'))}</div>`;
    return `<section class="admin-users-list">
        <div class="admin-users-toolbar">
            <span class="gs-hint">${escapeHtml(t('settings.adminUsersCount', { count: view.users.length }))}</span>
            ${view.limited ? `<span class="gs-hint">${escapeHtml(t('settings.adminUsersLimited', { count: LIST_LIMIT }))}</span>` : ''}
            <label class="admin-users-ttl">
                <span>${escapeHtml(t('settings.adminUsersPairTtl'))}</span>
                <select data-pair-ttl ${view.busy ? 'disabled' : ''}>
                    ${PAIR_TTL_OPTIONS.map((option) => `<option value="${option.seconds}"${option.seconds === view.pairTtl ? ' selected' : ''}>${escapeHtml(t(option.labelKey))}</option>`).join('')}
                </select>
            </label>
            <span class="admin-users-toolbar-actions">
                <button type="button" class="btn-secondary gs-ai-small" data-admin-users-refresh ${view.busy ? 'disabled' : ''}>${escapeHtml(t('settings.adminUsersRefresh'))}</button>
                <button type="button" class="btn-primary gs-ai-small" data-admin-users-create ${view.busy ? 'disabled' : ''}>${escapeHtml(t('settings.adminUsersCreate'))}</button>
            </span>
        </div>
        <div class="admin-users-rows">${rows}</div>
    </section>`;
}

function renderUser(user) {
    const id = escapeHtml(user.userId);
    const isSelf = user.userId === view.currentUserId;
    const isAdmin = user.role === 'admin';
    const created = formatTime(user.createdAt);
    return `<div class="admin-users-row">
        <div class="admin-users-main">
            <span class="admin-users-id">${id}</span>
            ${isSelf ? `<span class="gs-ai-badge">${escapeHtml(t('settings.adminUsersYou'))}</span>` : ''}
            <span class="gs-ai-badge">${escapeHtml(t(isAdmin ? 'settings.adminUsersRoleAdmin' : 'settings.adminUsersRoleUser'))}</span>
            ${user.username ? `<span class="admin-users-username">@${escapeHtml(user.username)}</span>` : ''}
            <span class="gs-ai-badge">${escapeHtml(t(user.hasPassword ? 'settings.adminUsersHasPassword' : 'settings.adminUsersNoPassword'))}</span>
            <span class="admin-users-label">${escapeHtml(user.label || t('settings.adminUsersNoLabel'))}</span>
            ${user.email ? `<span class="admin-users-email">${escapeHtml(user.email)}</span>` : ''}
            ${created ? `<span class="admin-users-time">${escapeHtml(t('settings.adminUsersCreatedAt', { time: created }))}</span>` : ''}
        </div>
        <div class="admin-users-actions">
            <button type="button" class="btn-secondary gs-ai-small" data-user-edit="${id}" ${view.busy ? 'disabled' : ''}>${escapeHtml(t('settings.adminUsersEdit'))}</button>
            ${isAdmin
                ? `<span class="gs-hint">${escapeHtml(t('settings.adminUsersAdminProtected'))}</span>`
                : `<button type="button" class="btn-secondary gs-ai-small" data-user-pair="${id}" ${view.busy ? 'disabled' : ''}>${escapeHtml(t('settings.adminUsersPair'))}</button>
                   <button type="button" class="btn-secondary gs-ai-small" data-user-reset="${id}" ${view.busy ? 'disabled' : ''}>${escapeHtml(t('settings.adminUsersReset'))}</button>`}
        </div>
    </div>`;
}

function renderCreateForm() {
    return `<section class="ai-admin-newform admin-users-form">
        <h4>${escapeHtml(t('settings.adminUsersCreateTitle'))}</h4>
        <div class="ai-admin-grid">
            <label>${escapeHtml(t('settings.adminUsersUserId'))}
                <input type="text" data-form-user-id maxlength="64" value="${escapeHtml(view.form.userId)}" autocomplete="off" spellcheck="false">
            </label>
            <label>${escapeHtml(t('settings.adminUsersLabel'))}
                <input type="text" data-form-label maxlength="${MAX_LABEL_LENGTH}" value="${escapeHtml(view.form.label)}" autocomplete="off">
            </label>
            <label class="ai-admin-wide">${escapeHtml(t('settings.adminUsersEmail'))}
                <input type="email" data-form-email maxlength="254" value="${escapeHtml(view.form.email)}" autocomplete="off" spellcheck="false">
            </label>
            <label>${escapeHtml(t('settings.adminUsersUsername'))}
                <input type="text" data-form-username maxlength="32" value="${escapeHtml(view.form.username)}" autocomplete="off" autocapitalize="none" spellcheck="false">
            </label>
            <label>${escapeHtml(t('settings.adminUsersPassword'))}
                <input type="password" data-form-password maxlength="200" value="${escapeHtml(view.form.password)}" autocomplete="new-password">
            </label>
        </div>
        <p class="gs-hint">${escapeHtml(t('settings.adminUsersUserIdHint'))}</p>
        <p class="gs-hint">${escapeHtml(t('settings.adminUsersEmailHint'))}</p>
        <p class="gs-hint">${escapeHtml(t('settings.adminUsersUsernameHint'))}</p>
        <p class="gs-hint">${escapeHtml(t('settings.adminUsersPasswordHint', { count: PASSWORD_MIN_LENGTH }))}</p>
        ${view.formError ? `<p class="gs-ai-error" role="alert">${escapeHtml(view.formError)}</p>` : ''}
        <div class="ai-admin-actions">
            <button type="button" class="btn-primary" data-form-submit ${view.busy ? 'disabled' : ''}>${escapeHtml(view.busy ? t('settings.adminUsersBusy') : t('settings.adminUsersCreateSubmit'))}</button>
            <button type="button" class="btn-secondary" data-form-cancel ${view.busy ? 'disabled' : ''}>${escapeHtml(t('settings.cancel'))}</button>
        </div>
    </section>`;
}

function renderEditForm() {
    const user = view.users.find((item) => item.userId === view.editingId);
    if (!user) return '';
    return `<section class="ai-admin-newform admin-users-form">
        <h4>${escapeHtml(t('settings.adminUsersEditTitle', { user: user.userId }))}</h4>
        <div class="ai-admin-grid">
            <label>${escapeHtml(t('settings.adminUsersUserId'))}
                <input type="text" value="${escapeHtml(user.userId)}" readonly disabled>
            </label>
            <label>${escapeHtml(t('settings.adminUsersLabel'))}
                <input type="text" data-form-label maxlength="${MAX_LABEL_LENGTH}" value="${escapeHtml(view.form.label)}" autocomplete="off">
            </label>
            <label class="ai-admin-wide">${escapeHtml(t('settings.adminUsersEmail'))}
                <input type="email" data-form-email maxlength="254" value="${escapeHtml(view.form.email)}" autocomplete="off" spellcheck="false">
            </label>
            <label>${escapeHtml(t('settings.adminUsersUsername'))}
                <input type="text" data-form-username maxlength="32" value="${escapeHtml(view.form.username)}" autocomplete="off" autocapitalize="none" spellcheck="false">
            </label>
            <label>${escapeHtml(t('settings.adminUsersNewPassword'))}
                <input type="password" data-form-password maxlength="200" value="${escapeHtml(view.form.password)}" autocomplete="new-password" placeholder="${escapeHtml(t('settings.adminUsersNewPasswordHint'))}">
            </label>
        </div>
        <p class="gs-hint">${escapeHtml(t('settings.adminUsersUserIdHint'))}</p>
        <p class="gs-hint">${escapeHtml(t('settings.adminUsersUsernameHint'))}</p>
        <p class="gs-hint">${escapeHtml(t('settings.adminUsersNewPasswordHint'))}</p>
        ${view.formError ? `<p class="gs-ai-error" role="alert">${escapeHtml(view.formError)}</p>` : ''}
        <div class="ai-admin-actions">
            <button type="button" class="btn-primary" data-form-submit ${view.busy ? 'disabled' : ''}>${escapeHtml(view.busy ? t('settings.adminUsersBusy') : t('settings.adminUsersSave'))}</button>
            <button type="button" class="btn-secondary" data-form-cancel ${view.busy ? 'disabled' : ''}>${escapeHtml(t('settings.cancel'))}</button>
        </div>
    </section>`;
}

function renderCredentials() {
    const credentials = view.credentials;
    return `<section class="admin-users-credentials" role="alert">
        <h4>${escapeHtml(t('settings.adminUsersCredentialsTitle', { user: credentials.userId }))}</h4>
        <p class="admin-users-warning">${escapeHtml(t('settings.adminUsersCredentialsWarning'))}</p>
        ${credentials.username ? `<div class="admin-users-credential-row">
            <span>${escapeHtml(t('settings.adminUsersUsername'))}</span>
            <code>@${escapeHtml(credentials.username)}</code>
        </div>` : ''}
        <div class="admin-users-credential-row">
            <span>${escapeHtml(t('settings.adminUsersPasscode'))}</span>
            <code>${escapeHtml(credentials.passcode)}</code>
            <button type="button" class="btn-secondary gs-ai-small" data-copy-passcode>${escapeHtml(t('settings.adminUsersCopy'))}</button>
        </div>
        <div class="admin-users-credential-row">
            <span>${escapeHtml(t('settings.adminUsersRecoveryCode'))}</span>
            <code>${escapeHtml(credentials.recoveryCode)}</code>
            <button type="button" class="btn-secondary gs-ai-small" data-copy-recovery>${escapeHtml(t('settings.adminUsersCopy'))}</button>
        </div>
        <div class="ai-admin-actions">
            <button type="button" class="btn-primary" data-credentials-done>${escapeHtml(t('settings.adminUsersCredentialsDone'))}</button>
        </div>
    </section>`;
}

function formatPairingCode(code) {
    const normalized = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const groups = normalized.match(/.{1,4}/g);
    return groups ? groups.join('-') : '';
}

function publicBaseUrl() {
    return String((SYNC && SYNC.publicBaseUrl) || '').trim();
}

function buildLoginUrl(code) {
    const rawCode = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    let base = null;
    try {
        base = new URL(window.location.href);
    } catch (_) {}
    const configured = publicBaseUrl();
    if (configured) {
        try { base = new URL(configured, base ? base.href : undefined); } catch (_) {}
    }
    if (!base) return `#login=${encodeURIComponent(rawCode)}`;
    base.hash = '';
    // A routing query (`?word=...`) belongs to the current view, not a login
    // link, so drop it when falling back to the current address.
    if (!configured) base.search = '';
    return `${base.href.replace(/#.*$/, '')}#login=${encodeURIComponent(rawCode)}`;
}

function renderPairing() {
    const pairing = view.pairing;
    const expires = formatTime(pairing.expiresAt);
    const formattedCode = formatPairingCode(pairing.code);
    const linkHint = publicBaseUrl() ? '' : `<p class="gs-hint">${escapeHtml(t('settings.adminUsersPairLinkHint'))}</p>`;
    return `<section class="admin-users-credentials admin-users-pairing" role="status">
        <h4>${escapeHtml(t('settings.adminUsersPairTitle', { user: pairing.userId }))}</h4>
        <p class="admin-users-warning">${escapeHtml(t('settings.adminUsersPairWarning'))}</p>
        <div class="admin-users-pair-grid">
            <div class="admin-users-pair-info">
                <div class="admin-users-credential-row">
                    <span>${escapeHtml(t('settings.adminUsersPairCode'))}</span>
                    <code>${escapeHtml(formattedCode)}</code>
                    <button type="button" class="btn-secondary gs-ai-small" data-copy-pairing>${escapeHtml(t('settings.adminUsersCopy'))}</button>
                </div>
                <div class="admin-users-credential-row">
                    <span>${escapeHtml(t('settings.adminUsersPairLink'))}</span>
                    <code>${escapeHtml(pairing.loginUrl)}</code>
                    <button type="button" class="btn-secondary gs-ai-small" data-copy-pairing-link>${escapeHtml(t('settings.adminUsersCopyLink'))}</button>
                </div>
                ${expires ? `<p class="gs-hint">${escapeHtml(t('settings.adminUsersPairExpires', { time: expires }))}</p>` : ''}
                ${linkHint}
                <p class="gs-hint">${escapeHtml(t('settings.adminUsersPairMultiWarning'))}</p>
            </div>
            <div class="admin-users-pair-qr" data-pairing-qr role="img" aria-label="${escapeHtml(t('settings.adminUsersPairQrAlt'))}"></div>
        </div>
        <div class="ai-admin-actions">
            <button type="button" class="btn-secondary" data-pairing-regenerate="${escapeHtml(pairing.userId)}" ${view.busy ? 'disabled' : ''}>${escapeHtml(t('settings.adminUsersPairRegenerate'))}</button>
            <button type="button" class="btn-secondary btn-danger" data-pairing-revoke="${escapeHtml(pairing.userId)}" ${view.busy ? 'disabled' : ''}>${escapeHtml(t('settings.adminUsersPairRevoke'))}</button>
            <button type="button" class="btn-primary" data-pairing-done>${escapeHtml(t('settings.adminUsersCredentialsDone'))}</button>
        </div>
    </section>`;
}

function mountPairingQr() {
    const el = body()?.querySelector('[data-pairing-qr]');
    if (!el || !view.pairing || !view.pairing.loginUrl) return;
    try {
        renderQrSvg(el, view.pairing.loginUrl, {
            cellSize: 4,
            margin: 12,
            title: t('settings.adminUsersPairQrAlt'),
            alt: t('settings.adminUsersPairLink')
        });
    } catch (_) {
        el.innerHTML = '';
    }
}

function renderResetConfirm() {
    return `<section class="admin-users-confirm" role="alertdialog" aria-label="${escapeHtml(t('settings.adminUsersReset'))}">
        <p>${escapeHtml(t('settings.adminUsersResetConfirm', { user: view.resetConfirm }))}</p>
        <div class="ai-admin-actions">
            <button type="button" class="btn-primary btn-danger" data-reset-confirm ${view.busy ? 'disabled' : ''}>${escapeHtml(t('settings.adminUsersResetConfirmAction'))}</button>
            <button type="button" class="btn-secondary" data-reset-cancel ${view.busy ? 'disabled' : ''}>${escapeHtml(t('settings.cancel'))}</button>
        </div>
    </section>`;
}

function bind() {
    const el = body();
    if (!el) return;

    el.querySelector('[data-admin-users-refresh]')?.addEventListener('click', () => loadUsers());
    el.querySelector('[data-admin-users-create]')?.addEventListener('click', () => {
        view.mode = 'create';
        view.editingId = '';
        view.form = { userId: '', label: '', email: '', username: '', password: '' };
        view.formError = '';
        view.notice = '';
        view.resetConfirm = '';
        view.credentials = null;
        view.pairing = null;
        render();
        focusFirst('[data-form-user-id]');
    });
    el.querySelector('[data-form-cancel]')?.addEventListener('click', () => {
        view.mode = 'list';
        view.editingId = '';
        view.form = { userId: '', label: '', email: '', username: '', password: '' };
        view.formError = '';
        render();
    });
    el.querySelector('[data-form-user-id]')?.addEventListener('input', (event) => {
        view.form.userId = event.target.value;
    });
    el.querySelector('[data-form-label]')?.addEventListener('input', (event) => {
        view.form.label = event.target.value;
    });
    el.querySelector('[data-form-email]')?.addEventListener('input', (event) => {
        view.form.email = event.target.value;
    });
    el.querySelector('[data-form-username]')?.addEventListener('input', (event) => {
        view.form.username = event.target.value;
    });
    el.querySelector('[data-form-password]')?.addEventListener('input', (event) => {
        view.form.password = event.target.value;
    });
    el.querySelector('[data-form-submit]')?.addEventListener('click', () => {
        if (view.mode === 'edit') submitEdit();
        else submitCreate();
    });
    el.querySelectorAll('[data-user-edit]').forEach((button) => {
        button.addEventListener('click', () => startEdit(button.dataset.userEdit));
    });
    el.querySelectorAll('[data-user-reset]').forEach((button) => {
        button.addEventListener('click', () => {
            view.resetConfirm = button.dataset.userReset;
            view.formError = '';
            view.notice = '';
            view.pairing = null;
            render();
        });
    });
    el.querySelectorAll('[data-user-pair]').forEach((button) => {
        button.addEventListener('click', () => generatePairingCode(button.dataset.userPair));
    });
    el.querySelector('[data-pair-ttl]')?.addEventListener('change', (event) => {
        const value = Number(event.target.value);
        view.pairTtl = PAIR_TTL_OPTIONS.some((option) => option.seconds === value)
            ? value
            : DEFAULT_PAIR_TTL_SECONDS;
    });
    el.querySelector('[data-pairing-done]')?.addEventListener('click', () => {
        view.pairing = null;
        render();
    });
    el.querySelector('[data-pairing-regenerate]')?.addEventListener('click', (event) => {
        generatePairingCode(event.currentTarget.dataset.pairingRegenerate);
    });
    el.querySelector('[data-pairing-revoke]')?.addEventListener('click', (event) => {
        revokePairingCodes(event.currentTarget.dataset.pairingRevoke);
    });
    el.querySelector('[data-copy-pairing]')?.addEventListener('click', (event) => {
        copyCredential(event.currentTarget, formatPairingCode(view.pairing && view.pairing.code));
    });
    el.querySelector('[data-copy-pairing-link]')?.addEventListener('click', (event) => {
        copyCredential(event.currentTarget, view.pairing && view.pairing.loginUrl);
    });
    el.querySelector('[data-reset-confirm]')?.addEventListener('click', resetPasscode);
    el.querySelector('[data-reset-cancel]')?.addEventListener('click', () => {
        view.resetConfirm = '';
        render();
    });
    el.querySelector('[data-credentials-done]')?.addEventListener('click', () => {
        view.credentials = null;
        render();
    });
    el.querySelector('[data-copy-passcode]')?.addEventListener('click', (event) => {
        copyCredential(event.currentTarget, view.credentials && view.credentials.passcode);
    });
    el.querySelector('[data-copy-recovery]')?.addEventListener('click', (event) => {
        copyCredential(event.currentTarget, view.credentials && view.credentials.recoveryCode);
    });
}

function focusFirst(selector) {
    const input = body()?.querySelector(selector);
    if (!input) return;
    try { input.focus(); } catch (_) {}
}

function startEdit(userId) {
    const user = view.users.find((item) => item.userId === userId);
    if (!user) return;
    view.mode = 'edit';
    view.editingId = String(userId || '');
    view.form = {
        userId: user.userId,
        label: user.label || '',
        email: user.email || '',
        username: user.username || '',
        password: ''
    };
    view.formError = '';
    view.notice = '';
    view.resetConfirm = '';
    view.pairing = null;
    render();
    focusFirst('[data-form-label]');
}

async function loadUsers() {
    if (!panel) return;
    view.loading = true;
    view.error = '';
    render();

    const captured = captureAuthSession();
    try {
        const res = await apiRequest('/admin/users', { method: 'GET' }, { timeoutMs: 15000 });
        if (!isAuthSessionCurrent(captured)) return;
        if (res.status === 401) {
            await auth.invalidateSession();
            view.error = t('errors.aiLoginRequired');
        } else if (res.status === 403) {
            view.error = t('errors.aiAdminRequired');
        } else if (!res.ok) {
            view.error = t('errors.adminUsersLoadFailed');
        } else {
            const data = await res.json().catch(() => null);
            if (!data || !Array.isArray(data.users)) {
                view.error = t('errors.adminUsersLoadFailed');
            } else {
                view.users = data.users;
                view.currentUserId = String(data.currentUserId || '');
                view.limited = data.users.length >= LIST_LIMIT;
            }
        }
    } catch (_) {
        if (!isAuthSessionCurrent(captured)) return;
        view.error = t('errors.cannotReachSync');
    }
    view.loading = false;
    render();
}

async function submitCreate() {
    if (view.busy) return;
    const el = body();
    if (!el) return;
    const userId = String(el.querySelector('[data-form-user-id]')?.value || '').trim();
    const label = String(el.querySelector('[data-form-label]')?.value || '').trim();
    const email = String(el.querySelector('[data-form-email]')?.value || '').trim();
    const username = String(el.querySelector('[data-form-username]')?.value || '').trim().toLowerCase();
    const password = String(el.querySelector('[data-form-password]')?.value || '');
    view.form = { userId, label, email, username, password };

    if (!USER_ID_RE.test(userId)) {
        view.formError = t('settings.adminUsersInvalidUserId');
        render();
        return;
    }
    if (label.length > MAX_LABEL_LENGTH) {
        view.formError = t('settings.adminUsersInvalidLabel');
        render();
        return;
    }
    if (email && !EMAIL_RE.test(email)) {
        view.formError = t('settings.adminUsersInvalidEmail');
        render();
        return;
    }
    if (username && !USERNAME_RE.test(username)) {
        view.formError = t('settings.adminUsersInvalidUsername');
        render();
        return;
    }
    if (username && !password) {
        view.formError = t('settings.adminUsersPasswordRequired');
        render();
        return;
    }
    if (!username && password) {
        view.formError = t('settings.adminUsersUsernameRequired');
        render();
        return;
    }
    if (username && password.length < PASSWORD_MIN_LENGTH) {
        view.formError = t('settings.adminUsersPasswordTooShort', { count: PASSWORD_MIN_LENGTH });
        render();
        return;
    }

    view.busy = true;
    view.formError = '';
    render();
    const captured = captureAuthSession();
    try {
        const res = await apiRequest('/admin/users', {
            method: 'POST',
            body: JSON.stringify({ userId, label, email, username, password })
        }, { timeoutMs: 15000 });
        if (!isAuthSessionCurrent(captured)) return;
        view.busy = false;
        if (!res.ok) {
            view.formError = await describeError(res, 'errors.adminUsersCreateFailed');
            render();
            return;
        }
        const data = await res.json().catch(() => null);
        if (!data || !data.passcode || !data.recoveryCode) {
            view.formError = t('errors.adminUsersCreateFailed');
            render();
            return;
        }
        const createdId = String((data.user && data.user.userId) || userId);
        view.credentials = {
            userId: createdId,
            passcode: data.passcode,
            recoveryCode: data.recoveryCode,
            username: String((data.user && data.user.username) || username || '')
        };
        view.mode = 'list';
        view.form = { userId: '', label: '', email: '', username: '', password: '' };
        view.notice = t('settings.adminUsersCreated', { user: createdId });
        await loadUsers();
    } catch (_) {
        if (!isAuthSessionCurrent(captured)) return;
        view.busy = false;
        view.formError = t('errors.cannotReachSync');
        render();
    }
}

async function submitEdit() {
    if (view.busy) return;
    const userId = view.editingId;
    const user = view.users.find((item) => item.userId === userId);
    if (!user) {
        view.mode = 'list';
        render();
        return;
    }
    const el = body();
    if (!el) return;
    const label = String(el.querySelector('[data-form-label]')?.value || '').trim();
    const email = String(el.querySelector('[data-form-email]')?.value || '').trim();
    const username = String(el.querySelector('[data-form-username]')?.value || '').trim().toLowerCase();
    const newPassword = String(el.querySelector('[data-form-password]')?.value || '');
    view.form = { userId, label, email, username, password: newPassword };

    if (label.length > MAX_LABEL_LENGTH) {
        view.formError = t('settings.adminUsersInvalidLabel');
        render();
        return;
    }
    if (email && !EMAIL_RE.test(email)) {
        view.formError = t('settings.adminUsersInvalidEmail');
        render();
        return;
    }
    if (username && !USERNAME_RE.test(username)) {
        view.formError = t('settings.adminUsersInvalidUsername');
        render();
        return;
    }
    if (!username && (user.hasPassword || newPassword)) {
        view.formError = t('settings.adminUsersUsernameRequired');
        render();
        return;
    }
    const minPassword = user.role === 'admin' ? ADMIN_PASSWORD_MIN_LENGTH : PASSWORD_MIN_LENGTH;
    if (newPassword && newPassword.length < minPassword) {
        view.formError = t('settings.adminUsersPasswordTooShort', { count: minPassword });
        render();
        return;
    }

    view.busy = true;
    view.formError = '';
    render();
    const captured = captureAuthSession();
    try {
        const res = await apiRequest(`/admin/users/${encodeURIComponent(userId)}`, {
            method: 'PUT',
            body: JSON.stringify({ label, email, username, newPassword })
        }, { timeoutMs: 15000 });
        if (!isAuthSessionCurrent(captured)) return;
        view.busy = false;
        if (!res.ok) {
            view.formError = await describeError(res, 'errors.adminUsersUpdateFailed');
            render();
            return;
        }
        view.mode = 'list';
        view.editingId = '';
        view.form = { userId: '', label: '', email: '', username: '', password: '' };
        view.notice = t('settings.adminUsersUpdated', { user: userId });
        await loadUsers();
    } catch (_) {
        if (!isAuthSessionCurrent(captured)) return;
        view.busy = false;
        view.formError = t('errors.cannotReachSync');
        render();
    }
}

async function resetPasscode() {
    if (view.busy) return;
    const userId = view.resetConfirm;
    if (!userId) return;

    view.busy = true;
    view.resetConfirm = '';
    view.error = '';
    view.pairing = null;
    render();
    const captured = captureAuthSession();
    try {
        const res = await apiRequest(`/admin/users/${encodeURIComponent(userId)}/reset-passcode`, {
            method: 'POST'
        }, { timeoutMs: 15000 });
        if (!isAuthSessionCurrent(captured)) return;
        view.busy = false;
        if (!res.ok) {
            view.error = await describeError(res, 'errors.adminUsersResetFailed');
            render();
            return;
        }
        const data = await res.json().catch(() => null);
        if (!data || !data.passcode || !data.recoveryCode) {
            view.error = t('errors.adminUsersResetFailed');
            render();
            return;
        }
        const resetId = String((data.user && data.user.userId) || userId);
        view.credentials = { userId: resetId, passcode: data.passcode, recoveryCode: data.recoveryCode };
        view.notice = t('settings.adminUsersResetDone', { user: resetId });
        await loadUsers();
    } catch (_) {
        if (!isAuthSessionCurrent(captured)) return;
        view.busy = false;
        view.error = t('errors.cannotReachSync');
        render();
    }
}

async function generatePairingCode(userId) {
    if (view.busy) return;
    view.busy = true;
    view.error = '';
    view.notice = '';
    view.resetConfirm = '';
    view.credentials = null;
    view.pairing = null;
    render();
    const captured = captureAuthSession();
    try {
        const res = await apiRequest(`/admin/users/${encodeURIComponent(userId)}/pairing-code`, {
            method: 'POST',
            body: JSON.stringify({ ttlSeconds: view.pairTtl })
        }, { timeoutMs: 15000 });
        if (!isAuthSessionCurrent(captured)) return;
        view.busy = false;
        if (!res.ok) {
            view.error = await describeError(res, 'errors.adminUsersPairFailed');
            render();
            return;
        }
        const data = await res.json().catch(() => null);
        if (!data || !data.code) {
            view.error = t('errors.adminUsersPairFailed');
            render();
            return;
        }
        const code = String(data.code || '');
        view.pairing = {
            userId: String(data.userId || userId),
            code,
            loginUrl: buildLoginUrl(code),
            expiresAt: data.expiresAt || ''
        };
        render();
    } catch (_) {
        if (!isAuthSessionCurrent(captured)) return;
        view.busy = false;
        view.error = t('errors.cannotReachSync');
        render();
    }
}

async function revokePairingCodes(userId) {
    if (view.busy || !userId) return;
    const ok = await confirmAction({
        title: t('settings.adminUsersPairRevoke'),
        message: t('settings.adminUsersPairRevokeConfirm', { user: userId }),
        confirmLabel: t('settings.adminUsersPairRevoke'),
        cancelLabel: t('settings.cancel'),
        danger: true
    });
    if (!ok) return;

    view.busy = true;
    view.error = '';
    view.notice = '';
    render();
    const captured = captureAuthSession();
    try {
        const res = await apiRequest(`/admin/users/${encodeURIComponent(userId)}/pairing-codes`, {
            method: 'DELETE'
        }, { timeoutMs: 15000 });
        if (!isAuthSessionCurrent(captured)) return;
        view.busy = false;
        if (!res.ok) {
            view.error = await describeError(res, 'errors.adminUsersPairRevokeFailed');
            render();
            return;
        }
        const data = await res.json().catch(() => ({}));
        view.pairing = null;
        view.notice = t('settings.adminUsersPairRevoked', {
            user: userId,
            count: Number(data && data.revoked) || 0
        });
        render();
    } catch (_) {
        if (!isAuthSessionCurrent(captured)) return;
        view.busy = false;
        view.error = t('errors.cannotReachSync');
        render();
    }
}

async function describeError(res, fallbackKey) {
    if (res.status === 401) {
        try { await auth.invalidateSession(); } catch (_) {}
        return t('errors.aiLoginRequired');
    }
    let code = '';
    try {
        const data = await res.clone().json();
        code = String((data && data.code) || '');
    } catch (_) {}
    const keys = {
        user_exists: 'errors.adminUsersUserExists',
        email_exists: 'errors.adminUsersEmailExists',
        user_not_found: 'errors.adminUsersNotFound',
        invalid_user_id: 'errors.adminUsersInvalidUserId',
        invalid_label: 'errors.adminUsersInvalidLabel',
        invalid_email: 'errors.adminUsersInvalidEmail',
        invalid_ttl: 'errors.adminUsersPairInvalidTtl',
        admin_account_protected: 'errors.adminUsersAdminProtected',
        username_exists: 'errors.adminUsersUsernameExists',
        invalid_username: 'errors.adminUsersInvalidUsername',
        weak_password: 'errors.adminUsersWeakPassword',
        invalid_password: 'errors.adminUsersWeakPassword',
        password_required: 'errors.adminUsersPasswordRequired',
        username_required: 'errors.adminUsersUsernameRequired',
        password_not_configured: 'errors.passwordNotConfigured'
    };
    if (keys[code]) return t(keys[code]);
    if (res.status === 403) return t('errors.aiAdminRequired');
    if (res.status === 429) return t('errors.adminUsersRateLimited');
    return t(fallbackKey);
}

async function copyCredential(button, text) {
    if (!button || !text) return;
    const ok = await copyText(text);
    if (!ok) {
        displayMessage(t('settings.adminUsersCopyFailed'), 'error');
        return;
    }
    const original = button.textContent;
    button.textContent = t('settings.adminUsersCopied');
    setTimeout(() => {
        if (button.isConnected) button.textContent = original;
    }, 1500);
}

async function copyText(text) {
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch (_) {}
    try {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand('copy');
        area.remove();
        return ok;
    } catch (_) {
        return false;
    }
}
