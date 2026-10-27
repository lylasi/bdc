import * as dom from '../../modules/dom.js';
import * as readingStore from '../../modules/reading-store.js';
import * as readingActions from '../../modules/reading-actions.js';
import { loadGlobalSettings } from '../../modules/settings.js';
import { applyTranslations, t } from '../../modules/i18n.js';

const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#ic-${name}"></use></svg>`;
const expandIcon = '<svg viewBox="0 0 24 24" class="icon" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M10 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5"/></svg>';
const returnIcon = '<svg viewBox="0 0 24 24" class="icon" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M9 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4M20 4l-9 9m0-6v6h6"/></svg>';
const sendIcon = '<svg viewBox="0 0 24 24" class="icon" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6"/></svg>';

/** 詞卡與大視窗共用同一組節點；移動時不重建串流、草稿或訊息。 */
export function createWordChat({ ask, appendMessage, autoGrowInput, isBusy, cancel }) {
    const sessions = new Map();
    let inlineSession = null;
    let poppedSession = null;

    const sessionId = (options) => options?.learningItemId && options?.contentVersion
        ? `c_word_${options.learningItemId}_${options.contentVersion}` : '';
    const isActive = (session) => readingStore.isReadingContextActive(session.readingContext)
        && readingActions.articleVersion(session.articleId) === session.contentVersion;

    function pinTooltip(session) {
        const pinned = session?.expanded && !session.popped && session.view.parentElement === session.host;
        dom.analysisTooltip.classList.toggle('word-ai-open', !!pinned);
        if (pinned) dom.analysisTooltip.dataset.keepOpen = 'word-ai';
        else delete dom.analysisTooltip.dataset.keepOpen;
        const button = dom.analysisTooltip.querySelector('.btn-ask-word-ai');
        if (button) button.setAttribute('aria-expanded', pinned ? 'true' : 'false');
        syncViewport();
    }

    function syncViewport() {
        const viewport = window.visualViewport;
        const height = viewport?.height || window.innerHeight;
        const inset = Math.max(0, window.innerHeight - height - (viewport?.offsetTop || 0));
        for (const element of [dom.analysisTooltip, poppedSession?.view]) {
            if (!element) continue;
            element.style.setProperty('--word-chat-viewport', `${height}px`);
            element.style.setProperty('--word-chat-keyboard-inset', `${inset}px`);
        }
    }

    function updateTexts(session) {
        applyTranslations(session.view);
        session.title.textContent = t('article.askAi');
        session.quote.textContent = session.word;
        session.view.setAttribute('aria-label', t('assistant.wordChatLabel', { word: session.word }));
        session.input.placeholder = t('assistant.wordInputPlaceholder');
        session.input.setAttribute('aria-label', t('assistant.wordInputPlaceholder'));
        session.send.title = t('assistant.send');
        session.send.setAttribute('aria-label', t('assistant.send'));
        session.toggle.innerHTML = session.popped ? returnIcon : expandIcon;
        const toggleLabel = t(session.popped ? 'assistant.returnToWord' : 'assistant.largeWindow');
        session.toggle.title = toggleLabel;
        session.toggle.setAttribute('aria-label', toggleLabel);
        session.close.title = t(session.popped ? 'assistant.close' : 'assistant.collapseWordChat');
        session.close.setAttribute('aria-label', session.close.title);
        for (const [selector, key] of [
            ['.assistant-stop', 'assistant.stop'],
            ['.assistant-retry', 'assistant.retryOriginal'],
            ['.assistant-new-answer', 'assistant.newAnswer'],
            ['.assistant-cancelled', 'assistant.streamCancelled']
        ]) {
            session.view.querySelectorAll(selector).forEach((node) => { node.textContent = t(key); });
        }
    }

    function collapse(session) {
        session.expanded = false;
        session.popped = false;
        session.view.classList.remove('word-chat-popped');
        session.view.remove();
        if (poppedSession === session) poppedSession = null;
        if (inlineSession === session) inlineSession = null;
        pinTooltip(inlineSession);
        session.onResize?.();
        const button = dom.analysisTooltip.querySelector('.btn-ask-word-ai');
        button?.focus({ preventScroll: true });
    }

    function attach(session, { focus = false } = {}) {
        if (inlineSession && inlineSession !== session) inlineSession.view.remove();
        if (poppedSession && poppedSession !== session) {
            poppedSession.popped = false;
            poppedSession.view.classList.remove('word-chat-popped');
            poppedSession.view.remove();
        }
        poppedSession = null;
        session.popped = false;
        session.view.classList.remove('word-chat-popped');
        session.view.removeAttribute('role');
        session.host.appendChild(session.view);
        inlineSession = session;
        updateTexts(session);
        pinTooltip(session);
        autoGrowInput(session.input);
        session.onResize?.();
        if (focus) session.input.focus({ preventScroll: true });
    }

    function toggleWindow(session) {
        if (!isActive(session)) return;
        const scrollTop = session.messages.scrollTop;
        if (session.popped) {
            if (!session.host?.isConnected || !dom.analysisTooltip.contains(session.host)
                || dom.analysisTooltip.style.display !== 'block') {
                session.onReturn?.();
            }
            if (session.host?.isConnected && dom.analysisTooltip.contains(session.host)) {
                attach(session, { focus: true });
            }
        } else {
            if (poppedSession && poppedSession !== session) {
                poppedSession.popped = false;
                poppedSession.view.classList.remove('word-chat-popped');
                poppedSession.view.remove();
            }
            session.popped = true;
            poppedSession = session;
            if (inlineSession === session) inlineSession = null;
            session.view.classList.add('word-chat-popped');
            session.view.setAttribute('role', 'dialog');
            document.body.appendChild(session.view);
            pinTooltip(inlineSession);
            updateTexts(session);
            autoGrowInput(session.input);
            session.onResize?.();
            session.input.focus({ preventScroll: true });
        }
        session.messages.scrollTop = scrollTop;
    }

    function createSession(options, id) {
        const view = document.createElement('section');
        view.className = 'word-chat';
        view.dataset.wordConversation = id;
        view.innerHTML = `
            <div class="word-chat-head">
                ${icon('sparkle')}<strong data-word-chat-title></strong><span class="word-chat-quote"></span>
                <button type="button" class="word-chat-window"></button>
                <button type="button" class="word-chat-close">${icon('close')}</button>
            </div>
            <div class="assistant-messages" data-assistant-messages role="log" aria-live="polite"></div>
            <form class="word-chat-compose">
                <textarea class="assistant-input" data-assistant-input rows="1"></textarea>
                <button type="submit" class="word-chat-send">${sendIcon}</button>
            </form>`;
        const session = {
            ...options, id, view, expanded: true, popped: false,
            readingContext: readingStore.captureReadingContext(),
            messages: view.querySelector('[data-assistant-messages]'),
            input: view.querySelector('[data-assistant-input]'),
            title: view.querySelector('[data-word-chat-title]'),
            quote: view.querySelector('.word-chat-quote'),
            toggle: view.querySelector('.word-chat-window'),
            close: view.querySelector('.word-chat-close'),
            send: view.querySelector('.word-chat-send')
        };
        updateTexts(session);
        view.addEventListener('click', (event) => event.stopPropagation());
        session.toggle.addEventListener('click', () => toggleWindow(session));
        session.close.addEventListener('click', () => collapse(session));
        let composing = false;
        const send = () => {
            const text = session.input.value.trim();
            if (!text || session.send.disabled || !isActive(session) || loadGlobalSettings()?.assistant?.enabled === false) return;
            if (isBusy()) {
                const hint = session.messages.querySelector('.assistant-hint') || appendMessage(session.messages, 'assistant', '');
                hint.classList.add('assistant-hint');
                hint.textContent = t('assistant.busy');
                return;
            }
            session.messages.querySelectorAll('.assistant-hint').forEach((node) => node.remove());
            session.input.value = '';
            autoGrowInput(session.input);
            ask(view, text, {
                isolated: true,
                convId: id,
                articleKey: session.articleId,
                articleId: session.articleId,
                articleContext: { articleKey: session.articleId, articleId: session.articleId, text: session.articleText },
                title: `${session.word} · ${session.sentence}`,
                reference: session.sentence
                    ? t('article.askAiWordReference', { quote: session.word, sentence: session.sentence })
                    : t('article.askAiReference', { quote: session.word }),
                learningItemId: session.learningItemId,
                anchor: session.anchor,
                contentVersion: session.contentVersion,
                readingContext: session.readingContext
            }).catch(() => {
                if (!isActive(session)) return;
                appendMessage(session.messages, 'assistant', t('assistant.error', { message: t('assistant.tryLater') }));
                if (!session.input.value) session.input.value = text;
                autoGrowInput(session.input);
            });
        };
        view.querySelector('form').addEventListener('submit', (event) => { event.preventDefault(); send(); });
        session.input.addEventListener('compositionstart', () => { composing = true; });
        session.input.addEventListener('compositionend', () => { composing = false; });
        session.input.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' || event.shiftKey || composing || event.isComposing || event.keyCode === 229) return;
            event.preventDefault();
            send();
        });
        session.input.addEventListener('input', () => autoGrowInput(session.input));
        session.messages.addEventListener('scroll', () => {
            const box = session.messages;
            if (box.scrollHeight - box.scrollTop - box.clientHeight <= 48) box.querySelector('.assistant-new-answer')?.remove();
        }, { passive: true });
        session.ready = readingStore.getMessages(id, session.readingContext).then((messages) => {
            if (!isActive(session)) return;
            for (const message of messages) appendMessage(session.messages, message.role, message.content, {
                messageId: message.id, conversationId: id, articleId: session.articleId, status: message.status
            });
            session.messages.scrollTop = session.messages.scrollHeight;
        }).catch(() => {
            if (isActive(session)) appendMessage(session.messages, 'assistant', t('assistant.saveFailed'));
        });
        // 不讓歷史讀取與第一輪送出交錯。
        session.send.disabled = true;
        session.ready.finally(() => { session.send.disabled = false; });
        sessions.set(id, session);
        return session;
    }

    function mount(options, open) {
        const id = sessionId(options);
        if (!id || !options.host || loadGlobalSettings()?.assistant?.enabled === false) return false;
        let session = sessions.get(id);
        if (session && !isActive(session)) return false;
        if (!session && !open) return false;
        if (!session) session = createSession(options, id);
        Object.assign(session, { host: options.host, onResize: options.onResize, onReturn: options.onReturn });
        if (open) session.expanded = true;
        if (session.expanded && !session.popped) attach(session, { focus: open });
        else if (open) session.input.focus({ preventScroll: true });
        return true;
    }

    function detach() {
        if (inlineSession) inlineSession.view.remove();
        inlineSession = null;
        pinTooltip(null);
    }

    function clear() {
        for (const session of sessions.values()) {
            cancel(session.view);
            session.view.remove();
        }
        sessions.clear();
        inlineSession = null;
        poppedSession = null;
        pinTooltip(null);
    }

    document.addEventListener('bdc:locale-change', () => {
        for (const session of sessions.values()) updateTexts(session);
    });
    document.addEventListener('bdc:tooltip-hidden', detach);
    document.addEventListener('bdc:article-loaded', () => {
        for (const [id, session] of sessions) {
            if (isActive(session)) continue;
            cancel(session.view);
            session.view.remove();
            sessions.delete(id);
            if (poppedSession === session) poppedSession = null;
            if (inlineSession === session) inlineSession = null;
        }
        pinTooltip(inlineSession);
    });
    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || event.defaultPrevented || !poppedSession) return;
        event.preventDefault();
        collapse(poppedSession);
    }, true);
    window.addEventListener('resize', syncViewport);
    window.visualViewport?.addEventListener('resize', syncViewport);
    window.visualViewport?.addEventListener('scroll', syncViewport);
    // 回答逐漸變長時仍留在視窗內；只量目前的詞卡，不搬動閱讀位置。
    const resizeObserver = new ResizeObserver(() => inlineSession?.onResize?.());
    resizeObserver.observe(dom.analysisTooltip);
    return { open: (options) => mount(options, true), restore: (options) => mount(options, false), detach, clear };
}
