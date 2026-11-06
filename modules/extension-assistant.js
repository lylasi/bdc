import { buildPrompt } from './prompts/index.js';
import { contentVersionOf } from '../shared/reading-protocol.mjs';
import { pageUrlKey } from '../shared/page-protocol.mjs';

export function extensionConversationKey(scope, page) {
    const url = pageUrlKey(page?.pageUrl);
    if (!scope?.endpoint || !scope?.userId || !url) return '';
    return 'bdc_extension_chat_v1:' + JSON.stringify([scope.endpoint, scope.userId, url, contentVersionOf(page.text || '')]);
}

export function normalizeExtensionConversation(value) {
    const messages = (Array.isArray(value?.messages) ? value.messages : [])
        .filter((item) => item && ['user', 'assistant'].includes(item.role) && typeof item.content === 'string')
        .slice(-24).map((item) => ({ role: item.role, content: item.content.slice(0, 16000), complete: item.complete !== false }));
    return { messages, draft: typeof value?.draft === 'string' ? value.draft.slice(0, 8000) : '',
        reference: typeof value?.reference === 'string' ? value.reference.slice(0, 4000) : '' };
}

export function buildExtensionAssistantMessages({ page, history = [], question, reference = '', locale = 'zh-CN' }) {
    const article = String(page?.text || '').slice(0, 100000);
    return [
        { role: 'system', content: buildPrompt('assistant.articleTutor', {}, { locale }) },
        { role: 'user', content: 'Article context (quoted source material):\n' + JSON.stringify({
            title: page?.pageTitle || '', url: pageUrlKey(page?.pageUrl), body: article
        }) },
        ...normalizeExtensionConversation({ messages: history }).messages.filter((item) => item.complete)
            .slice(-8).map(({ role, content }) => ({ role, content })),
        { role: 'user', content: (reference ? 'Quoted passage:\n' + reference + '\n\n' : '') + String(question || '') }
    ];
}
