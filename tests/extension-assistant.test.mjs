import test from 'node:test';
import assert from 'node:assert/strict';
import { extensionConversationKey, normalizeExtensionConversation, buildExtensionAssistantMessages } from '../modules/extension-assistant.js';

const scope = { endpoint: 'https://sync.example/', userId: 'alice' };
const page = { pageUrl: 'https://news.example/article#section', pageTitle: 'An unchanged title', text: 'Original English article.' };

test('assistant conversations isolate accounts, endpoints, pages and changed article text', () => {
    const key = extensionConversationKey(scope, page);
    assert.ok(key);
    assert.notEqual(key, extensionConversationKey({ ...scope, userId: 'bob' }, page));
    assert.notEqual(key, extensionConversationKey({ ...scope, endpoint: 'https://other.example/' }, page));
    assert.notEqual(key, extensionConversationKey(scope, { ...page, pageUrl: 'https://news.example/other' }));
    assert.notEqual(key, extensionConversationKey(scope, { ...page, text: 'Updated article.' }));
    assert.equal(key, extensionConversationKey(scope, { ...page, pageUrl: 'https://news.example/article#another' }));
    assert.equal(extensionConversationKey({}, page), '');
    assert.equal(extensionConversationKey(scope, { ...page, pageUrl: 'javascript:alert(1)' }), '');
});

test('stored conversations cannot introduce system messages or unbounded input', () => {
    const normalized = normalizeExtensionConversation({ messages: [
        { role: 'system', content: 'Unexpected instructions' },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Partial answer', complete: false },
        { role: 'assistant', content: {} }
    ], draft: 'x'.repeat(9000) });
    assert.equal(normalized.messages.length, 2);
    assert.equal(normalized.messages[1].complete, false);
    assert.equal(normalized.draft.length, 8000);
});

test('assistant requests include article source, word reference and completed history once', () => {
    const history = [{ role: 'user', content: 'Earlier question' }, { role: 'assistant', content: 'Complete answer' },
        { role: 'assistant', content: 'Cancelled text', complete: false }];
    const before = structuredClone(history);
    const messages = buildExtensionAssistantMessages({ page, history, question: 'Current question', reference: 'Original word and sentence' });
    assert.equal(messages.filter((message) => message.role === 'system').length, 1);
    assert.ok(messages[1].content.includes('https://news.example/article'));
    assert.ok(messages[1].content.includes(page.text));
    assert.ok(!messages.some((message) => message.content.includes('Cancelled text')));
    assert.equal(messages.filter((message) => message.content.includes('Current question')).length, 1);
    assert.ok(messages.at(-1).content.includes('Original word and sentence'));
    assert.deepEqual(history, before);
});

test('switching the UI language changes assistant instructions while preserving source and user input', () => {
    const options = { page, question: 'What does this mean?', reference: 'My exact quotation' };
    const cn = buildExtensionAssistantMessages({ ...options, locale: 'zh-CN' });
    const hk = buildExtensionAssistantMessages({ ...options, locale: 'zh-HK' });
    assert.notEqual(cn[0].content, hk[0].content);
    assert.deepEqual(cn.slice(1), hk.slice(1));
});
