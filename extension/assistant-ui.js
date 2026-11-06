import { getExtensionAITaskSettings, runExtensionAssistant } from './modules/extension-ai-runtime.js';
import { captureAuthSession, isAuthSessionCurrent, AUTH_EVENT } from './modules/sync-cloudflare.js';
import { getActiveAIScope } from './modules/ai-profile-storage.js';
import { extensionConversationKey, normalizeExtensionConversation, buildExtensionAssistantMessages } from './modules/extension-assistant.js';
import { markdownToHtml } from './modules/markdown.js';
import { getAIErrorTranslationKey } from './modules/api.js';
import { t, getLocale } from './modules/i18n.js';

export function createAssistantUI(dom, { ticket = '', onState = () => {}, onExpand = () => {} } = {}) {
    let page = null, key = '', epoch = 0, controller = null, snapshot = null;
    let messages = [], reference = '', notice = '', busy = false, draftTimer = 0;
    let rendered = [];
    const changed = () => onState({ busy, hasDraft: !!dom.input.value.trim() });
    function save() {
        if (!key || !captureAuthSession().loggedIn) return;
        try {
            localStorage.setItem(key, JSON.stringify({ messages: messages.slice(-24), draft: dom.input.value, reference, updatedAt: Date.now() }));
            const keys = Object.keys(localStorage).filter((item) => item.startsWith('bdc_extension_chat_v1:'));
            if (keys.length > 40) keys.sort((a, b) => {
                try { return JSON.parse(localStorage.getItem(a)).updatedAt - JSON.parse(localStorage.getItem(b)).updatedAt; }
                catch (_) { return 0; }
            }).slice(0, keys.length - 40).forEach((item) => localStorage.removeItem(item));
        } catch (_) { notice = 'extension.assistantSaveFailed'; }
    }
    function render() {
        const scroll = dom.messages.scrollTop;
        const follow = dom.messages.scrollHeight - scroll - dom.messages.clientHeight < 60;
        if (!messages.length) {
            let empty = dom.messages.querySelector('.ext-assistant-empty');
            if (!empty) {
                empty = document.createElement('p'); empty.className = 'ext-hint ext-assistant-empty';
                dom.messages.replaceChildren(empty);
            }
            empty.textContent = t('extension.assistantEmpty'); rendered = [];
        } else {
            // Preserve earlier bubbles and selection while a new answer streams.
            rendered = messages.map((message, index) => {
                const previous = rendered[index];
                const item = previous?.message === message ? previous : { message, node: document.createElement('div'), content: null };
                item.node.className = 'ext-assistant-msg ext-assistant-msg-' + message.role;
                item.node.dataset.role = message.role;
                const content = message.content || (busy && message.role === 'assistant' ? t('extension.assistantThinking') : '');
                if (item.content !== content) {
                    if (message.role === 'assistant') item.node.innerHTML = markdownToHtml(content);
                    else item.node.textContent = content;
                    item.content = content;
                }
                return item;
            });
            const nodes = rendered.map((item) => item.node);
            if (dom.messages.children.length !== nodes.length || nodes.some((node, index) => dom.messages.children[index] !== node)) {
                dom.messages.replaceChildren(...nodes);
            }
        }
        if (follow) dom.messages.scrollTop = dom.messages.scrollHeight;
        else dom.messages.scrollTop = scroll;
        dom.context.textContent = page?.pageTitle || t('extension.assistantContextLoading');
        dom.context.title = page?.pageUrl || '';
        dom.reference.hidden = !reference; dom.referenceText.textContent = reference;
        dom.notice.hidden = !notice; dom.notice.textContent = notice ? t(notice) : '';
        dom.send.disabled = busy || !dom.input.value.trim();
        dom.stop.hidden = !busy; dom.retry.hidden = busy || !snapshot;
        dom.newConversation.disabled = busy;
        dom.input.disabled = busy;
        changed();
    }
    async function refreshPage() {
        const session = captureAuthSession(), version = epoch;
        const response = await chrome.runtime.sendMessage({ type: 'BDC_READ_PAGE', ...(ticket ? { ticket } : {}) });
        if (version !== epoch || !isAuthSessionCurrent(session)) throw Object.assign(new Error('stale_session'), { code: 'stale_session' });
        if (!response?.ok || !response.value?.text || response.value.tooLarge) {
            throw Object.assign(new Error('page_unavailable'), { code: response?.value?.tooLarge ? 'article_too_large' : 'page_unavailable' });
        }
        const next = response.value;
        const nextKey = extensionConversationKey(getActiveAIScope(), next);
        if (nextKey !== key) {
            const pendingDraft = dom.input.value;
            const previousUrl = page?.pageUrl;
            save(); page = next; key = nextKey; snapshot = null;
            let restored = {};
            try { restored = JSON.parse(localStorage.getItem(key) || '{}'); } catch (_) {}
            const value = normalizeExtensionConversation(restored);
            messages = value.messages; reference = value.reference;
            dom.input.value = pendingDraft || value.draft;
            if (previousUrl && previousUrl !== next.pageUrl) reference = '';
        } else page = next;
        render();
    }
    async function open(options = {}) {
        dom.section.hidden = false;
        notice = '';
        try {
            await refreshPage();
            if (options.reference) { reference = options.reference; save(); }
        } catch (error) { notice = error.code === 'article_too_large' ? 'extension.pageArticleTooLarge' : 'extension.assistantPageUnavailable'; }
        render(); dom.input.focus({ preventScroll: true });
    }
    async function send(retry = false) {
        if (busy || (!retry && !dom.input.value.trim())) return;
        const session = captureAuthSession();
        if (!session.loggedIn) { notice = 'extension.inlineLoginRequired'; render(); return; }
        const version = epoch;
        const question = dom.input.value.trim().slice(0, 8000);
        busy = true; notice = ''; render();
        try {
            if (!retry) {
                snapshot = null;
                await refreshPage();
                const settings = getExtensionAITaskSettings('assistant');
                snapshot = { messages: buildExtensionAssistantMessages({ page, history: messages, question, reference, locale: getLocale() }),
                    model: settings.model, thinking: settings.thinking, question };
                messages.push({ role: 'user', content: question, complete: true });
                dom.input.value = '';
            } else if (!snapshot) return;
            if (version !== epoch || !isAuthSessionCurrent(session)) return;
            // A retry replaces the interrupted answer and reuses the frozen request.
            if (retry && messages.at(-1)?.role === 'assistant' && !messages.at(-1).complete) messages.pop();
            const answer = { role: 'assistant', content: '', complete: false };
            messages.push(answer); controller = new AbortController(); render();
            const result = await runExtensionAssistant({ ...snapshot, signal: controller.signal, onDelta: (text) => {
                if (version !== epoch || !isAuthSessionCurrent(session)) return;
                answer.content += text; render();
            } });
            if (version !== epoch || !isAuthSessionCurrent(session)) return;
            answer.content = result.text || answer.content;
            if (!answer.content.trim()) throw Object.assign(new Error('empty_answer'), { code: 'empty_answer' });
            answer.complete = true; snapshot = null; reference = '';
        } catch (error) {
            if (version !== epoch || !isAuthSessionCurrent(session)) return;
            notice = error.name === 'AbortError' ? 'extension.assistantStopped'
                : error.code === 'article_too_large' ? 'extension.pageArticleTooLarge'
                    : error.code === 'page_unavailable' ? 'extension.assistantPageUnavailable'
                        : getAIErrorTranslationKey(error.code) || 'errors.aiRequestFailed';
        } finally {
            if (version === epoch) { busy = false; controller = null; save(); render(); }
        }
    }
    dom.form.addEventListener('submit', (event) => { event.preventDefault(); send(); });
    dom.input.addEventListener('input', () => {
        clearTimeout(draftTimer); draftTimer = setTimeout(save, 200); render();
    });
    dom.input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); send(); }
    });
    dom.stop.addEventListener('click', () => controller?.abort());
    dom.retry.addEventListener('click', () => send(true));
    dom.expand.addEventListener('click', onExpand);
    dom.newConversation.addEventListener('click', () => {
        if (busy) return;
        messages = []; reference = ''; snapshot = null; notice = ''; dom.input.value = ''; save(); render(); dom.input.focus();
    });
    window.addEventListener('beforeunload', save);
    window.addEventListener(AUTH_EVENT, () => {
        epoch += 1; controller?.abort(); controller = null; busy = false; page = null; key = '';
        messages = []; reference = ''; snapshot = null; notice = ''; dom.input.value = ''; render();
    });
    return { open, render, stop() { controller?.abort(); save(); }, getState: () => ({ busy, hasDraft: !!dom.input.value.trim() }) };
}
