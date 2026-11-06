import { extractActivePageSelectionInTab } from './selection-extractor.js';
import { extractReadablePageInTab } from './page-extractor.js';
import { publicSourceUrl } from './shared/vocabulary-source.mjs';
import zhCN from './locales/zh-CN.js';
import zhHK from './locales/zh-HK.js';

chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});
const tickets = new Map();
const extensionOrigin = chrome.runtime.getURL('').replace(/\/$/, '');
const modes = ['compact', 'expanded', 'assistant', 'assistant-dock', 'dialog'];
const contextMenuId = 'bdc-import-article';
const shellKeys = ['inlineLookup', 'inlineClose', 'inlineTitle', 'inlineOpenFailed', 'assistantTitle', 'assistantOpen', 'contextImportArticle'];

function trustedFrame(sender) {
    return sender.id === chrome.runtime.id && String(sender.url || '').startsWith(extensionOrigin + '/lookup.html');
}
function contextFrame(message, sender, { read = false } = {}) {
    const record = tickets.get(message.ticket);
    const expectedTab = record?.kind === 'window' ? record.targetTabId : record?.tabId;
    if (!trustedFrame(sender) || !record || record.claimed !== sender.documentId || sender.tab?.id !== expectedTab
        || (read && record.expires < Date.now())) throw new Error('invalid_context');
    return record;
}
async function notifyShell(record, message) {
    if (record.kind !== 'window') return chrome.tabs.sendMessage(record.tabId, message, { frameId: 0 });
}
async function labels() {
    const stored = await chrome.storage.local.get(['bdc_extension_ui_locale', 'bdc_extension_assistant_enabled']);
    const dictionary = stored.bdc_extension_ui_locale === 'zh-HK' ? zhHK : zhCN;
    return { ...Object.fromEntries(shellKeys.map((key) => ['extension.' + key, dictionary.extension[key] || 'BDC'])),
        assistantEnabled: stored.bdc_extension_assistant_enabled !== false };
}
function issue(tab, page, kind = 'inline') {
    for (const [key, value] of tickets) {
        if (value.expires < Date.now() || (kind === 'inline' && value.kind === 'inline' && value.tabId === tab.id)) tickets.delete(key);
    }
    const ticket = crypto.randomUUID();
    tickets.set(ticket, { kind, tabId: tab.id, page, expires: Date.now() + 60 * 60 * 1000, claimed: '' });
    return ticket;
}
async function sourceTab(message, sender) {
    if (message.ticket) {
        const record = contextFrame(message, sender, { read: true });
        if (record.sourceUnavailable) throw new Error('invalid_context');
        return chrome.tabs.get(record.tabId);
    }
    if (!trustedFrame(sender) || (sender.tab && sender.frameId !== 0)) throw new Error('invalid_sender');
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs.find((candidate) => /^https?:/.test(candidate.url || ''));
    if (!tab) throw new Error('invalid_context');
    return tab;
}
async function openWorkspace(tab, { view = 'article', autoImport = false } = {}) {
    if (!tab?.id || !/^https?:/.test(tab.url || '')) throw new Error('invalid_context');
    const ticket = issue(tab, { pageUrl: tab.url, pageTitle: tab.title || '', text: '' }, 'window');
    // Bind the destination tab before any extension document can claim the ticket.
    let popup;
    try {
        popup = await chrome.windows.create({ url: 'about:blank', type: 'popup', width: 920, height: 760 });
        const targetTabId = popup.tabs?.[0]?.id;
        if (!targetTabId) throw new Error('invalid_context');
        tickets.get(ticket).targetTabId = targetTabId;
        const url = new URL(chrome.runtime.getURL('lookup.html'));
        url.searchParams.set('windowTicket', ticket);
        url.searchParams.set('view', view === 'assistant' ? 'assistant' : 'article');
        if (autoImport) url.searchParams.set('import', '1');
        await chrome.tabs.update(targetTabId, { url: url.href });
        return { windowId: popup.id };
    } catch (error) {
        tickets.delete(ticket);
        if (popup?.id) chrome.windows.remove(popup.id).catch(() => {});
        throw error;
    }
}
async function dispatch(message, sender) {
    if (sender.id !== chrome.runtime.id || !message || typeof message.type !== 'string') throw new Error('invalid_sender');
    if (message.type === 'BDC_INLINE_LABELS') return labels();
    if (['BDC_INLINE_STATE', 'BDC_INLINE_CLOSED', 'BDC_INLINE_CANCEL_CLOSE'].includes(message.type)) {
        const record = contextFrame(message, sender);
        if (message.type === 'BDC_INLINE_STATE') {
            record.ready = true;
            await notifyShell(record, { type: 'BDC_INLINE_STATE', ticket: message.ticket,
                mode: modes.includes(message.mode) ? message.mode : 'compact',
                height: Number.isFinite(message.height) ? Math.max(80, Math.min(20000, message.height)) : 180,
                protected: message.protected === true });
        } else {
            await notifyShell(record, { type: message.type === 'BDC_INLINE_CLOSED' ? 'BDC_INLINE_REMOVE' : 'BDC_INLINE_KEEP',
                ticket: message.ticket, requestId: String(message.requestId || '') });
            if (message.type === 'BDC_INLINE_CLOSED') tickets.delete(message.ticket);
        }
        return { ok: true };
    }
    if (message.type === 'BDC_INLINE_REQUEST_CLOSE') {
        const record = tickets.get(message.ticket);
        if (sender.frameId !== 0 || !/^https?:/.test(sender.url || '') || !record || record.kind !== 'inline' || sender.tab?.id !== record.tabId
            || !/^[A-Za-z0-9-]{1,100}$/.test(message.requestId || '')) throw new Error('invalid_context');
        const reason = ['outside', 'offscreen', 'replace', 'explicit'].includes(message.reason) ? message.reason : 'outside';
        if (!record.ready) {
            await notifyShell(record, { type: 'BDC_INLINE_REMOVE', ticket: message.ticket, requestId: message.requestId });
            tickets.delete(message.ticket);
        } else await chrome.runtime.sendMessage({ type: 'BDC_INLINE_CHECK_CLOSE', ticket: message.ticket,
            requestId: message.requestId, reason });
        return { ok: true };
    }
    if (message.type === 'BDC_OPEN_INLINE' || message.type === 'BDC_OPEN_ASSISTANT') {
        if (!sender.tab?.id || !/^https?:/.test(sender.url || '') || sender.frameId !== 0) throw new Error('invalid_sender');
        let page;
        if (message.type === 'BDC_OPEN_INLINE') {
            const result = await chrome.scripting.executeScript({ target: { tabId: sender.tab.id }, func: extractActivePageSelectionInTab });
            page = result[0]?.result;
            if (!page?.text || page.text.length > 400) throw new Error('empty_selection');
        } else {
            page = { pageUrl: sender.url, pageTitle: sender.tab.title || '', text: '' };
        }
        return { ticket: issue(sender.tab, page), view: message.type === 'BDC_OPEN_ASSISTANT' ? 'assistant' : 'lookup' };
    }
    if (message.type === 'BDC_INLINE_CONTEXT' || message.type === 'BDC_WINDOW_CONTEXT') {
        const record = tickets.get(message.ticket);
        const isWindow = message.type === 'BDC_WINDOW_CONTEXT';
        if (!trustedFrame(sender) || !record || (record.kind === 'window') !== isWindow || record.expires < Date.now()
            || sender.tab?.id !== (isWindow ? record.targetTabId : record.tabId) || record.claimed
            || (isWindow && sender.frameId !== 0)) throw new Error('invalid_context');
        record.claimed = sender.documentId;
        return { tabId: record.tabId, page: record.page };
    }
    if (message.type === 'BDC_READ_PAGE') {
        const tab = await sourceTab(message, sender);
        if (!/^https?:/.test(tab.url || '')) throw new Error('invalid_context');
        const result = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractReadablePageInTab });
        return result[0]?.result;
    }
    if (message.type === 'BDC_OPEN_WINDOW') return openWorkspace(await sourceTab(message, sender), message);
    if (message.type === 'BDC_SHOW_ASSISTANT') {
        const tab = await sourceTab(message, sender);
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['page-lookup.js'] });
        await chrome.tabs.sendMessage(tab.id, { type: 'BDC_SHOW_ASSISTANT' }, { frameId: 0 });
        return { ok: true };
    }
    if (message.type === 'BDC_OPEN_SITE') {
        if (!trustedFrame(sender)) throw new Error('invalid_sender');
        if (message.ticket) contextFrame(message, sender);
        else if (sender.frameId !== 0) throw new Error('invalid_sender');
        const stored = await chrome.storage.local.get('bdc_extension_app_url');
        const href = publicSourceUrl(stored.bdc_extension_app_url || 'https://bdc.a4a4.qzz.io/');
        if (!href) throw new Error('invalid_url');
        const url = new URL(href);
        url.searchParams.delete('module'); url.searchParams.delete('article');
        const id = String(message.id || '').slice(0, 300);
        url.hash = (message.target === 'article' ? 'a/' : 'v/') + encodeURIComponent(id);
        if (message.replace && message.ticket && tickets.get(message.ticket)?.kind === 'window') {
            await chrome.tabs.update(sender.tab.id, { url: url.href });
        } else if (message.target === 'article') {
            await chrome.windows.create({ url: url.href, type: 'popup', width: 1120, height: 820 });
        } else await chrome.tabs.create({ url: url.href });
        return { ok: true };
    }
    if (message.type === 'BDC_ENABLE_INLINE') {
        const tab = await sourceTab(message, sender);
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['page-lookup.js'] });
        return { ok: true };
    }
    throw new Error('invalid_message');
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
    dispatch(message, sender).then((value) => reply({ ok: true, value }), (error) => reply({ ok: false, code: error.message }));
    return true;
});
chrome.tabs.onRemoved.addListener((tabId) => {
    for (const [key, value] of tickets) {
        if (value.targetTabId === tabId) tickets.delete(key);
        else if (value.tabId === tabId) {
            if (value.kind === 'window') value.sourceUnavailable = true;
            else tickets.delete(key);
        }
    }
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (!change.url) return;
    for (const [key, value] of tickets) if (value.tabId === tabId && change.url !== value.page.pageUrl) {
        if (value.kind === 'window') value.sourceUnavailable = true;
        else {
            notifyShell(value, { type: 'BDC_INLINE_REMOVE', ticket: key }).catch(() => {});
            tickets.delete(key);
        }
    }
});
async function updateMenu() {
    if (!chrome.contextMenus) return;
    await chrome.contextMenus.removeAll();
    const text = await labels();
    chrome.contextMenus.create({ id: contextMenuId, title: text['extension.contextImportArticle'],
        contexts: ['page', 'selection'], documentUrlPatterns: ['http://*/*', 'https://*/*'] });
}
chrome.runtime.onInstalled.addListener(() => updateMenu().catch(() => {}));
chrome.runtime.onStartup.addListener(() => updateMenu().catch(() => {}));
chrome.contextMenus?.onClicked.addListener((info, tab) => {
    if (info.menuItemId === contextMenuId) openWorkspace(tab, { autoImport: true }).catch(() => {});
});
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || (!changes.bdc_extension_assistant_enabled && !changes.bdc_extension_ui_locale)) return;
    if (changes.bdc_extension_ui_locale) updateMenu().catch(() => {});
    labels().then(async (value) => {
        const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
        await Promise.allSettled(tabs.map((tab) => chrome.tabs.sendMessage(tab.id, { type: 'BDC_SHELL_PREFERENCES', value }, { frameId: 0 })));
    }).catch(() => {});
});
