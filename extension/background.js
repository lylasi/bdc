import { extractActivePageSelectionInTab } from './selection-extractor.js';
import { extractReadablePageInTab } from './page-extractor.js';
import zhCN from './locales/zh-CN.js';
import zhHK from './locales/zh-HK.js';

chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});
const tickets = new Map();
const extensionOrigin = chrome.runtime.getURL('').replace(/\/$/, '');

function trustedFrame(sender) {
    return sender.id === chrome.runtime.id && String(sender.url || '').startsWith(extensionOrigin + '/lookup.html');
}
async function dispatch(message, sender) {
    if (sender.id !== chrome.runtime.id || !message || typeof message.type !== 'string') throw new Error('invalid_sender');
    if (message.type === 'BDC_INLINE_LABELS') {
        const stored = await chrome.storage.local.get('bdc_extension_ui_locale');
        const dictionary = stored.bdc_extension_ui_locale === 'zh-HK' ? zhHK : zhCN;
        const t = (key) => key.split('.').reduce((value, part) => value?.[part], dictionary) || 'BDC';
        return { 'extension.inlineLookup': t('extension.inlineLookup'), 'extension.inlineClose': t('extension.inlineClose'), 'extension.inlineTitle': t('extension.inlineTitle') };
    }
    if (message.type === 'BDC_OPEN_INLINE') {
        if (!sender.tab?.id || !/^https?:/.test(sender.url || '') || sender.frameId !== 0) throw new Error('invalid_sender');
        const result = await chrome.scripting.executeScript({ target: { tabId: sender.tab.id }, func: extractActivePageSelectionInTab });
        const page = result[0]?.result;
        if (!page?.text || page.text.length > 400) throw new Error('empty_selection');
        for (const [key, value] of tickets) if (value.tabId === sender.tab.id || value.expires < Date.now()) tickets.delete(key);
        const ticket = crypto.randomUUID();
        tickets.set(ticket, { tabId: sender.tab.id, page, expires: Date.now() + 60 * 60 * 1000, claimed: '' });
        return { ticket };
    }
    if (message.type === 'BDC_INLINE_CONTEXT') {
        const record = tickets.get(message.ticket);
        if (!trustedFrame(sender) || !record || record.expires < Date.now() || sender.tab?.id !== record.tabId || record.claimed) throw new Error('invalid_context');
        record.claimed = sender.documentId;
        return { tabId: record.tabId, page: record.page };
    }
    if (message.type === 'BDC_READ_PAGE') {
        if (!trustedFrame(sender)) throw new Error('invalid_sender');
        let tabId;
        if (message.ticket) {
            const record = tickets.get(message.ticket);
            if (!record || record.claimed !== sender.documentId || record.expires < Date.now() || sender.tab?.id !== record.tabId) throw new Error('invalid_context');
            tabId = record.tabId;
        } else {
            if (sender.tab && sender.frameId !== 0) throw new Error('invalid_context');
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            tabId = tabs.find((tab) => /^https?:/.test(tab.url || ''))?.id;
        }
        if (!tabId) throw new Error('invalid_context');
        const result = await chrome.scripting.executeScript({ target: { tabId }, func: extractReadablePageInTab });
        return result[0]?.result;
    }
    if (message.type === 'BDC_ENABLE_INLINE') {
        if (!trustedFrame(sender) || sender.frameId !== 0) throw new Error('invalid_sender');
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const tab = tabs.find((candidate) => /^https?:/.test(candidate.url || ''));
        if (!tab) throw new Error('invalid_context');
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['page-lookup.js'] });
        return { ok: true };
    }
    throw new Error('invalid_message');
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
    dispatch(message, sender).then((value) => reply({ ok: true, value }), (error) => reply({ ok: false, code: error.message }));
    return true;
});
chrome.tabs.onRemoved.addListener((tabId) => { for (const [key, value] of tickets) if (value.tabId === tabId) tickets.delete(key); });
chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (!change.url) return;
    for (const [key, value] of tickets) if (value.tabId === tabId && change.url !== value.page.pageUrl) tickets.delete(key);
});
