// Client-side AI unit tests.
//
// Usage: node --test tests/ai-units.test.mjs
//
// Covers URL/protocol detection, all three adapter wire formats, streaming
// event parsing, snapshot sanitisation and credential-sync decisions.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Minimal browser globals required by the settings/state import chain.
const store = new Map();
globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
    removeItem: (key) => { store.delete(key); },
    key: (index) => [...store.keys()][index] || null,
    get length() { return store.size; }
};
globalThis.Audio = class {
    play() { return Promise.resolve(); }
    pause() {}
    addEventListener() {}
    removeEventListener() {}
};
globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
    localStorage: globalThis.localStorage
};
globalThis.document = {
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
    hidden: false,
    documentElement: {},
    querySelectorAll() { return []; },
    getElementById() { return null; }
};

const protocols = await import('../modules/ai-protocols/index.js');
const chat = (await import('../modules/ai-protocols/chat-completions.js')).chatCompletions;
const anthropic = (await import('../modules/ai-protocols/anthropic.js')).anthropicMessages;
const gemini = (await import('../modules/ai-protocols/gemini.js')).geminiNative;
const { sanitizeAISettings } = await import('../modules/ai-settings-sanitize.js');
const {
    THINKING_LEVELS,
    THINKING_BUDGETS,
    THINKING_TOKEN_FLOORS,
    GEMINI_THINKING_BUDGETS,
    normalizeThinkingLevel,
    normalizeTaskThinkingMap,
    appThinkingDefault,
    resolveThinkingLookupKeys
} = await import('../modules/ai-thinking.js');
const { sanitizeSnapshotAISettings, sanitizeSnapshotThinkingMappings } = await import('../cloudflare-worker/src/snapshot-sanitize.js');
const { decideCredentialAction } = await import('../modules/ai-credential-sync.js');
const { evaluateReplay, isValidProviderId } = await import('../cloudflare-worker/src/ai-credentials.js');
const {
    normalizeCredential,
    normalizeStoredProvider,
    normalizeProfile,
    saveAIProfile,
    loadAIProfile,
    getAIViewFromProfile,
    applyRemoteAISettings,
    deleteAIProfile
} = await import('../modules/ai-profile-storage.js');
const { resolveThinkingLevel } = await import('../modules/ai-models.js');
const { resolveAssistantRequestPlan } = await import('../features/assistant/request-plan.js');

test('detection candidates keep path prefixes and avoid credential URLs', () => {
    const root = protocols.buildDetectionCandidates('https://api.example.com');
    assert.equal(root[0].format, 'openai-chat');
    assert.equal(root[0].apiUrl, 'https://api.example.com/v1/chat/completions');
    assert.equal(root[0].modelsUrl, 'https://api.example.com/v1/models');

    const versioned = protocols.buildDetectionCandidates('https://gateway.example/team-a/v1');
    assert.equal(versioned[0].apiUrl, 'https://gateway.example/team-a/v1/chat/completions');
    assert.equal(versioned[0].modelsUrl, 'https://gateway.example/team-a/v1/models');

    const full = protocols.buildDetectionCandidates('https://api.example.com/v1/chat/completions');
    assert.equal(full.length, 1);
    assert.equal(full[0].apiUrl, 'https://api.example.com/v1/chat/completions');
    assert.equal(full[0].modelsUrl, 'https://api.example.com/v1/models');

    const anthropicHost = protocols.buildDetectionCandidates('https://api.anthropic.com');
    assert.equal(anthropicHost[0].format, 'anthropic-messages');
    assert.equal(anthropicHost[0].apiUrl, 'https://api.anthropic.com/v1/messages');
    assert.equal(anthropicHost[0].modelsUrl, 'https://api.anthropic.com/v1/models');

    const geminiHost = protocols.buildDetectionCandidates('https://generativelanguage.googleapis.com');
    assert.equal(geminiHost[0].format, 'gemini');
    assert.match(geminiHost[0].apiUrl, /%7Bmodel%7D:generateContent$/);

    assert.throws(() => protocols.buildDetectionCandidates('https://user:pass@example.com/v1'), /credential|URL/i);
    assert.throws(() => protocols.buildDetectionCandidates('https://example.com/v1?key=sk-123'), /credential|URL/i);
    assert.throws(() => protocols.buildDetectionCandidates('ftp://example.com'), /http/i);

    // HTTPS must never be downgraded to HTTP.
    const secure = protocols.buildDetectionCandidates('https://example.com/v1');
    assert.ok(secure.every((candidate) => candidate.apiUrl.startsWith('https://')));
});

test('chat completions adapter builds a faithful OpenAI request', () => {
    const provider = {
        format: 'openai-chat',
        apiUrl: 'https://api.example.com/v1/chat/completions',
        modelsUrl: 'https://api.example.com/v1/models',
        authMode: 'bearer'
    };
    const request = chat.buildRequest({
        provider,
        apiKey: 'sk-test',
        model: 'm1',
        temperature: 0.1,
        maxTokens: 100,
        responseFormat: { type: 'json_object' },
        messages: [
            { role: 'system', content: 'sys' },
            { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image', imageUrl: 'data:image/png;base64,AAA' }] }
        ],
        stream: false
    });
    assert.equal(request.url, provider.apiUrl);
    assert.equal(request.headers.Authorization, 'Bearer sk-test');
    assert.equal(request.body.model, 'm1');
    assert.equal(request.body.max_tokens, 100);
    assert.equal(request.maxTokens, 100);
    assert.deepEqual(request.body.response_format, { type: 'json_object' });
    assert.equal(request.body.messages[0].role, 'system');
    assert.equal(request.body.messages[1].content[1].type, 'image_url');
    assert.equal(request.body.messages[1].content[1].image_url.url, 'data:image/png;base64,AAA');
});

test('anthropic adapter uses Messages wire format and headers', () => {
    const provider = {
        format: 'anthropic-messages',
        apiUrl: 'https://api.anthropic.com/v1/messages',
        modelsUrl: 'https://api.anthropic.com/v1/models',
        authMode: 'x-api-key'
    };
    const request = anthropic.buildRequest({
        provider,
        apiKey: 'sk-ant',
        model: 'claude-test',
        maxTokens: 256,
        responseFormat: { type: 'json_object' },
        messages: [
            { role: 'system', content: 'be brief' },
            { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image', imageUrl: 'data:image/jpeg;base64,BBB' }] }
        ]
    });
    assert.equal(request.headers['x-api-key'], 'sk-ant');
    assert.equal(request.headers['anthropic-version'], '2023-06-01');
    assert.equal(request.headers['anthropic-dangerous-direct-browser-access'], 'true');
    assert.equal(request.body.max_tokens, 256);
    assert.equal(request.maxTokens, 256);
    assert.equal(request.body.system, 'be brief\n\nReturn only one valid JSON object. Do not wrap it in Markdown fences.');
    assert.equal(request.body.messages[0].role, 'user');
    assert.equal(request.body.messages[0].content[1].type, 'image');
    assert.equal(request.body.messages[0].content[1].source.media_type, 'image/jpeg');

    const parsed = anthropic.parseResponse({
        content: [{ type: 'text', text: 'hello' }],
        stop_reason: 'end_turn'
    });
    assert.equal(parsed.text, 'hello');
    assert.equal(parsed.finishReason, 'end_turn');
});

test('gemini adapter substitutes the model and encodes images', () => {
    const provider = {
        format: 'gemini',
        apiUrl: 'https://generativelanguage.googleapis.com/v1beta/models/%7Bmodel%7D:generateContent',
        modelsUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
        authMode: 'google'
    };
    const request = gemini.buildRequest({
        provider,
        apiKey: 'google-key',
        model: 'models/gemini-test',
        maxTokens: 64,
        responseFormat: { type: 'json_object' },
        messages: [
            { role: 'system', content: 'be brief' },
            { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image', imageUrl: 'data:image/png;base64,CCC' }] }
        ],
        stream: true
    });
    assert.equal(request.headers['x-goog-api-key'], 'google-key');
    assert.match(request.url, /gemini-test:streamGenerateContent\?alt=sse$/);
    assert.equal(request.body.systemInstruction.parts[0].text, 'be brief');
    assert.equal(request.body.generationConfig.responseMimeType, 'application/json');
    assert.equal(request.body.generationConfig.maxOutputTokens, 64);
    assert.equal(request.maxTokens, 64);
    assert.equal(request.body.contents[0].parts[1].inlineData.mimeType, 'image/png');
    assert.equal(request.body.contents[0].parts[1].inlineData.data, 'CCC');

    const parsed = gemini.parseResponse({
        candidates: [{ content: { parts: [{ text: 'hello' }] }, finishReason: 'STOP' }],
        usageMetadata: { totalTokenCount: 3 }
    });
    assert.equal(parsed.text, 'hello');
    assert.equal(parsed.finishReason, 'STOP');
    assert.equal(parsed.usage.totalTokenCount, 3);
});

test('thinking policy normalises values and keeps the documented app defaults', () => {
    assert.deepEqual(THINKING_LEVELS, ['auto', 'none', 'low', 'medium', 'high']);
    assert.equal(THINKING_BUDGETS.low, 1024);
    assert.equal(THINKING_BUDGETS.medium, 4096);
    assert.equal(THINKING_BUDGETS.high, 8192);
    assert.equal(THINKING_TOKEN_FLOORS.high, 5000);
    assert.equal(GEMINI_THINKING_BUDGETS.high, 16384);

    assert.equal(normalizeThinkingLevel('HIGH'), 'high');
    assert.equal(normalizeThinkingLevel('auto'), 'auto');
    assert.equal(normalizeThinkingLevel('bogus'), 'auto');
    assert.equal(normalizeThinkingLevel('bogus', 'low'), 'low');
    assert.equal(normalizeThinkingLevel(undefined), 'auto');

    assert.equal(appThinkingDefault('wordAnalysis'), 'none');
    assert.equal(appThinkingDefault('articleWordTranslation'), 'none');
    assert.equal(appThinkingDefault('articlePhraseTranslation'), 'none');
    assert.equal(appThinkingDefault('articleParagraphTranslation'), 'none');
    assert.equal(appThinkingDefault('articleSentenceTranslation'), 'low');
    assert.equal(appThinkingDefault('assistant'), 'medium');
    assert.equal(appThinkingDefault('qaChecking'), 'auto');
    assert.ok(resolveThinkingLookupKeys('articleWordTranslation').includes('wordAnalysis'));
    assert.deepEqual(normalizeTaskThinkingMap({
        assistant: 'HIGH',
        wordAnalysis: 'none',
        'bad task': 'low',
        broken: 'urgent'
    }), { assistant: 'high', wordAnalysis: 'none' });
});

test('chat completions maps every non-auto thinking level to reasoning_effort', () => {
    const provider = {
        format: 'openai-chat',
        apiUrl: 'https://api.example.com/v1/chat/completions',
        authMode: 'bearer'
    };
    const build = (thinking) => chat.buildRequest({
        provider,
        apiKey: 'sk-test',
        model: 'm1',
        messages: [{ role: 'user', content: 'hi' }],
        thinking
    });
    for (const level of ['none', 'low', 'medium', 'high']) {
        assert.equal(build(level).body.reasoning_effort, level);
    }
    const auto = build('auto').body;
    assert.equal(Object.prototype.hasOwnProperty.call(auto, 'reasoning_effort'), false);
    const omitted = chat.buildRequest({
        provider,
        apiKey: 'sk-test',
        model: 'm1',
        messages: [{ role: 'user', content: 'hi' }]
    }).body;
    assert.equal(Object.prototype.hasOwnProperty.call(omitted, 'reasoning_effort'), false);
});

test('anthropic enables extended thinking with temperature 1 and a larger max_tokens', () => {
    const provider = {
        format: 'anthropic-messages',
        apiUrl: 'https://api.anthropic.com/v1/messages',
        authMode: 'x-api-key'
    };
    const build = (thinking, maxTokens = 256) => anthropic.buildRequest({
        provider,
        apiKey: 'sk-ant',
        model: 'claude-test',
        maxTokens,
        temperature: 0.2,
        messages: [{ role: 'user', content: 'hi' }],
        thinking
    }).body;

    const low = build('low');
    assert.deepEqual(low.thinking, { type: 'enabled', budget_tokens: 1024 });
    assert.equal(low.temperature, 1);
    assert.ok(low.max_tokens > low.thinking.budget_tokens);
    assert.ok(low.max_tokens >= low.thinking.budget_tokens + 1024);

    const high = build('high', 12000);
    assert.deepEqual(high.thinking, { type: 'enabled', budget_tokens: 8192 });
    assert.equal(high.max_tokens, 12000);
    assert.equal(high.temperature, 1);

    for (const thinking of ['auto', 'none']) {
        const body = build(thinking);
        assert.equal(Object.prototype.hasOwnProperty.call(body, 'thinking'), false);
        assert.equal(body.temperature, 0.2);
    }
});

test('gemini maps 2.5 to thinkingBudget and 3 to thinkingLevel', () => {
    const provider = {
        format: 'gemini',
        apiUrl: 'https://generativelanguage.googleapis.com/v1beta/models/%7Bmodel%7D:generateContent',
        authMode: 'google'
    };
    const build = (model, thinking) => gemini.buildRequest({
        provider,
        apiKey: 'google-key',
        model,
        messages: [{ role: 'user', content: 'hi' }],
        thinking
    }).body.generationConfig;

    assert.equal(build('gemini-2.5-flash', 'none').thinkingConfig.thinkingBudget, 0);
    assert.equal(build('gemini-2.5-flash', 'low').thinkingConfig.thinkingBudget, 1024);
    assert.equal(build('gemini-2.5-pro', 'medium').thinkingConfig.thinkingBudget, 4096);
    assert.equal(build('gemini-2.5-pro', 'high').thinkingConfig.thinkingBudget, 16384);
    assert.equal('thinkingConfig' in build('gemini-2.5-flash', 'auto'), false);

    assert.equal(build('gemini-3-pro-preview', 'none').thinkingConfig.thinkingLevel, 'low');
    assert.equal(build('gemini-3-flash', 'low').thinkingConfig.thinkingLevel, 'low');
    assert.equal(build('gemini-3-pro-preview', 'medium').thinkingConfig.thinkingLevel, 'high');
    assert.equal(build('gemini-3-pro-preview', 'high').thinkingConfig.thinkingLevel, 'high');
    assert.equal('thinkingConfig' in build('gemini-3-pro-preview', 'auto'), false);
    // Non-thinking Gemini families are left alone.
    assert.equal('thinkingConfig' in build('gemini-1.5-pro', 'high'), false);
});

test('gemini 2.5 reserves the thinking budget on top of the answer allowance', () => {
    const provider = {
        format: 'gemini',
        apiUrl: 'https://generativelanguage.googleapis.com/v1beta/models/%7Bmodel%7D:generateContent',
        authMode: 'google'
    };
    const build = (model, thinking, maxTokens) => gemini.buildRequest({
        provider,
        apiKey: 'google-key',
        model,
        messages: [{ role: 'user', content: 'hi' }],
        thinking,
        maxTokens
    }).body.generationConfig;

    // A 16384 thinking budget with a 5000 answer budget must not consume the
    // whole output allowance or the visible answer is empty.
    const high = build('gemini-2.5-flash', 'high', 5000);
    assert.equal(high.thinkingConfig.thinkingBudget, 16384);
    assert.ok(high.maxOutputTokens > high.thinkingConfig.thinkingBudget);
    assert.equal(high.maxOutputTokens, 16384 + 5000);

    // No caller maxTokens: keep a 1024-token answer reserve.
    assert.equal(build('gemini-2.5-flash', 'high').maxOutputTokens, 16384 + 1024);
    // Small caller budgets are lifted to the 1024 answer reserve.
    assert.equal(build('gemini-2.5-flash', 'low', 300).maxOutputTokens, 1024 + 1024);

    // Gemini 2.5 Pro rejects thinkingBudget=0; 128 is its minimum level.
    assert.equal(build('gemini-2.5-pro', 'none').thinkingConfig.thinkingBudget, 128);
    assert.equal(build('gemini-2.5-pro-preview-06-05', 'none').thinkingConfig.thinkingBudget, 128);
    assert.equal(build('gemini-2.5-pro', 'none').maxOutputTokens, 128 + 1024);
    // Flash keeps a real zero budget.
    assert.equal(build('gemini-2.5-flash', 'none').thinkingConfig.thinkingBudget, 0);

    // Auto leaves the caller's output budget untouched.
    const auto = build('gemini-2.5-flash', 'auto', 700);
    assert.equal('thinkingConfig' in auto, false);
    assert.equal(auto.maxOutputTokens, 700);
});

test('adapters expose the actual outbound max tokens after thinking adjustments', () => {
    const chatProvider = {
        format: 'openai-chat',
        apiUrl: 'https://api.example.com/v1/chat/completions',
        authMode: 'bearer'
    };
    const chatRequest = chat.buildRequest({
        provider: chatProvider,
        apiKey: 'sk-test',
        model: 'm1',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 300,
        thinking: 'high'
    });
    assert.equal(chatRequest.maxTokens, 300);
    assert.equal(chatRequest.maxTokens, chatRequest.body.max_tokens);

    const anthropicProvider = {
        format: 'anthropic-messages',
        apiUrl: 'https://api.anthropic.com/v1/messages',
        authMode: 'x-api-key'
    };
    const anthropicRequest = anthropic.buildRequest({
        provider: anthropicProvider,
        apiKey: 'sk-ant',
        model: 'claude-test',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 300,
        thinking: 'medium'
    });
    assert.equal(anthropicRequest.body.max_tokens, 4096 + 1024);
    assert.equal(anthropicRequest.maxTokens, anthropicRequest.body.max_tokens);

    const geminiProvider = {
        format: 'gemini',
        apiUrl: 'https://generativelanguage.googleapis.com/v1beta/models/%7Bmodel%7D:generateContent',
        authMode: 'google'
    };
    const geminiRequest = gemini.buildRequest({
        provider: geminiProvider,
        apiKey: 'google-key',
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'hi' }],
        thinking: 'high'
    });
    assert.equal(geminiRequest.body.generationConfig.maxOutputTokens, 16384 + 1024);
    assert.equal(geminiRequest.maxTokens, geminiRequest.body.generationConfig.maxOutputTokens);
});

test('assistant request plan freezes the effective thinking level and model for retries', () => {
    let resolved = 0;
    const first = resolveAssistantRequestPlan({
        snapshot: null,
        selectedThinking: 'auto',
        currentModelSpec: 'provider-a:model-1',
        resolveTaskThinking: () => { resolved += 1; return 'high'; }
    });
    assert.deepEqual(first, { thinking: 'high', model: 'provider-a:model-1' });
    assert.equal(resolved, 1, 'the task setting is resolved once on the first send');

    // The panel/select and task settings changed before the retry: the retry
    // must reuse the snapshot instead of resolving again.
    const retry = resolveAssistantRequestPlan({
        snapshot: { thinking: 'high', model: 'provider-a:model-1' },
        selectedThinking: 'none',
        currentModelSpec: 'provider-b:model-2',
        resolveTaskThinking: () => { throw new Error('must not re-resolve the task setting'); }
    });
    assert.deepEqual(retry, { thinking: 'high', model: 'provider-a:model-1' });

    // An explicit panel choice skips the task-setting lookup entirely.
    const explicit = resolveAssistantRequestPlan({
        snapshot: null,
        selectedThinking: 'low',
        currentModelSpec: 'provider-a:model-1',
        resolveTaskThinking: () => { throw new Error('must not resolve an explicit level'); }
    });
    assert.deepEqual(explicit, { thinking: 'low', model: 'provider-a:model-1' });
});

test('stream event parsing works for every protocol', () => {
    assert.deepEqual(chat.parseStreamEvent({ data: JSON.stringify({ choices: [{ delta: { content: 'a' } }] }) }), {
        text: 'a', reasoning: '', finishReason: '', done: false
    });
    assert.equal(chat.parseStreamEvent({ data: '[DONE]' }).done, true);

    assert.deepEqual(anthropic.parseStreamEvent({ data: JSON.stringify({ type: 'content_block_delta', delta: { text: 'b' } }) }), {
        text: 'b', reasoning: '', done: false
    });
    assert.equal(anthropic.parseStreamEvent({ data: JSON.stringify({ type: 'message_stop' }) }).done, true);

    const gem = gemini.parseStreamEvent({ data: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'c' }] } }] }) });
    assert.deepEqual(gem, { text: 'c', reasoning: '', finishReason: '', done: false });
    const blocked = gemini.parseStreamEvent({ data: JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }) });
    assert.equal(blocked.done, true);
    assert.equal(blocked.refusal, 'SAFETY');
});

// 推理模型的思考片段必須走 reasoning，否則會直接出現在使用者看到的答案裡。
test('stream event parsing keeps reasoning separate from the answer', () => {
    const chatThought = chat.parseStreamEvent({
        data: JSON.stringify({ choices: [{ delta: { reasoning_content: '先想一下' } }] })
    });
    assert.equal(chatThought.text, '');
    assert.equal(chatThought.reasoning, '先想一下');
    // 片段開頭的空白是正文的一部分，不能被 trim 掉。
    assert.equal(chat.parseStreamEvent({ data: JSON.stringify({ choices: [{ delta: { content: ' shop' } }] }) }).text, ' shop');
    assert.equal(
        chat.parseStreamEvent({ data: JSON.stringify({ choices: [{ delta: { reasoning: 'alt field' } }] }) }).reasoning,
        'alt field'
    );

    const anthropicThought = anthropic.parseStreamEvent({
        data: JSON.stringify({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '想一想' } })
    });
    assert.equal(anthropicThought.text, '');
    assert.equal(anthropicThought.reasoning, '想一想');
    const anthropicAnswer = anthropic.parseResponse({
        content: [
            { type: 'thinking', thinking: '想一想' },
            { type: 'text', text: '答案' }
        ],
        stop_reason: 'end_turn'
    });
    assert.equal(anthropicAnswer.text, '答案');
    assert.equal(anthropicAnswer.reasoning, '想一想');

    const geminiThought = gemini.parseStreamEvent({
        data: JSON.stringify({ candidates: [{ content: { parts: [{ text: '想一想', thought: true }, { text: '答案' }] } }] })
    });
    assert.equal(geminiThought.text, '答案');
    assert.equal(geminiThought.reasoning, '想一想');

    const chatAnswer = chat.parseResponse({
        choices: [{ message: { content: '答案', reasoning_content: '想一想' }, finish_reason: 'stop' }]
    });
    assert.equal(chatAnswer.text, '答案');
    assert.equal(chatAnswer.reasoning, '想一想');
    // content 為空時仍以 reasoning_content 當正文，避免整個回覆變成空白。
    const chatFallback = chat.parseResponse({
        choices: [{ message: { content: '', reasoning_content: '只有思考' } }]
    });
    assert.equal(chatFallback.text, '只有思考');
    assert.equal(chatFallback.reasoning, '');
});

test('snapshot sanitizer removes keys, managed definitions and URL overrides', () => {
    const sanitized = sanitizeAISettings({
        apiUrl: 'https://legacy.example/v1',
        providers: {
            'personal-ok': {
                label: 'Mine',
                apiUrl: 'https://mine.example/v1/chat/completions',
                modelsUrl: 'https://mine.example/v1/models',
                apiKey: 'sk-should-not-survive',
                allowedModels: ['personal-ok:m1', 'm2'],
                discoveryError: 'https://mine.example/v1/models?key=sk-leak',
                format: 'openai-chat'
            },
            'managed-evil': { label: 'fake managed', apiUrl: 'https://evil.example/v1', apiKey: 'shared' },
            default: { apiUrl: 'https://legacy.example/v1', apiKey: 'static' }
        },
        models: {
            assistant: 'personal-ok:m1',
            imageOCR: { provider: 'managed-real', model: 'm2', apiUrl: 'https://evil.example', apiKey: 'x' },
            bad: 'https://evil.example'
        },
        defaultModel: 'personal-ok:m1',
        keySyncDefault: 'local-only'
    });
    assert.deepEqual(Object.keys(sanitized.providers), ['personal-ok']);
    assert.equal(sanitized.keySyncDefault, 'local-only');
    assert.equal(sanitized.providers['personal-ok'].apiKey, undefined);
    assert.equal(sanitized.providers['personal-ok'].discoveryError, undefined);
    assert.deepEqual(sanitized.providers['personal-ok'].allowedModels, ['m1', 'm2']);
    assert.equal(sanitized.models.assistant, 'personal-ok:m1');
    assert.equal(sanitized.models.imageOCR, 'managed-real:m2');
    assert.equal(sanitized.apiUrl, '');
    assert.equal(JSON.stringify(sanitized).includes('sk-'), false);
    // Older snapshots have no policy field; the sanitizer must not invent one,
    // otherwise applying them would reset a newer client's account policy.
    assert.equal('keySyncDefault' in sanitizeAISettings({}), false);
    assert.equal('keySyncDefault' in sanitizeAISettings({ keySyncDefault: 'bogus' }), false);
});

test('credential sync decision table matches the specification', () => {
    assert.equal(decideCredentialAction({ version: 0, syncMode: 'local-only' }, { version: 2 }), 'noop');
    assert.equal(decideCredentialAction({ version: 3, syncMode: 'cloud' }, { version: 4 }), 'download');
    assert.equal(decideCredentialAction({ version: 3, syncMode: 'cloud' }, { version: 4, deleted: true }), 'apply-remote-delete');
    assert.equal(decideCredentialAction({ version: 3, syncMode: 'cloud' }, { version: 2 }), 'rollback');
    assert.equal(decideCredentialAction({ version: 3, syncMode: 'cloud' }, { version: 3 }), 'noop');
    assert.equal(decideCredentialAction({ version: 3, syncMode: 'cloud' }, null), 'noop');
    assert.equal(decideCredentialAction({
        version: 3, syncMode: 'cloud', pending: { expectedVersion: 3, mutationId: 'm1' }
    }, { version: 3, lastMutationId: 'm1' }), 'confirm-pending');
    assert.equal(decideCredentialAction({
        version: 3, syncMode: 'cloud', pending: { expectedVersion: 3, mutationId: 'm1' }
    }, { version: 3, lastMutationId: 'm0' }), 'upload-pending');
    assert.equal(decideCredentialAction({
        version: 3, syncMode: 'cloud', pending: { expectedVersion: 3, mutationId: 'm1' }
    }, { version: 3, lastMutationId: 'remote' }), 'upload-pending');
    assert.equal(decideCredentialAction({
        version: 3, syncMode: 'cloud', pending: { expectedVersion: 3, mutationId: 'm1' }
    }, { version: 4, lastMutationId: 'remote' }), 'conflict');
    assert.equal(decideCredentialAction({
        version: 0, syncMode: 'cloud', pending: { expectedVersion: 0, mutationId: 'm1' }
    }, null), 'upload-pending');
});

test('worker idempotency and provider-id validation', () => {
    assert.deepEqual(evaluateReplay(null, { mutationId: 'm1', expectedVersion: 0 }), { replay: false, conflict: false });
    assert.deepEqual(evaluateReplay(
        { version: 2, last_mutation_id: 'm1', binding: { a: 1 }, apiKey: 'k', deleted: false },
        { mutationId: 'm1', expectedVersion: 1, binding: { a: 1 }, apiKey: 'k' }
    ), { replay: true, conflict: false });
    assert.deepEqual(evaluateReplay(
        { version: 2, last_mutation_id: 'm1', binding: { a: 1 }, apiKey: 'k', deleted: false },
        { mutationId: 'm1', expectedVersion: 1, binding: { a: 1 }, apiKey: 'other' }
    ), { replay: false, conflict: true });
    assert.deepEqual(evaluateReplay(
        { version: 2, last_mutation_id: 'm1' },
        { mutationId: 'm2', expectedVersion: 1 }
    ), { replay: false, conflict: true });

    assert.equal(isValidProviderId('personal-abc'), true);
    assert.equal(isValidProviderId('legacy-id'), true);
    assert.equal(isValidProviderId('default'), false);
    assert.equal(isValidProviderId('managed-abc'), false);
    assert.equal(isValidProviderId('bad id'), false);
});

test('profile normalisation drops unsafe URLs and unknown credential modes', () => {
    const provider = normalizeStoredProvider('personal-ok', {
        label: 'Mine',
        apiUrl: 'https://user:pass@example.com/v1/chat/completions',
        baseUrl: 'https://example.com/v1',
        authMode: 'none',
        allowedModels: ['personal-ok:m1', 'm2']
    });
    assert.equal(provider.apiUrl, '');
    assert.deepEqual(provider.allowedModels, ['m1', 'm2']);
    const credential = normalizeCredential({
        apiKey: 'k',
        binding: { apiUrl: 'https://example.com/v1/chat/completions?key=secret', format: 'openai-chat', authMode: 'bearer' },
        syncMode: 'weird',
        pending: { type: 'put', mutationId: 'short' }
    });
    assert.equal(credential.syncMode, 'local-only');
    assert.equal(credential.binding, null);
    assert.equal(credential.pending, null);
});

test('profile and snapshot sanitisation keep only valid thinking mappings', () => {
    const scope = { endpoint: 'https://sync.example', userId: 'thinking-normalise', guest: false };
    const profile = normalizeProfile({
        taskThinking: {
            wordAnalysis: 'none',
            assistant: 'HIGH',
            articleSentenceTranslation: 'low',
            'bad task': 'high',
            broken: 'urgent'
        }
    }, scope);
    assert.deepEqual(profile.taskThinking, {
        wordAnalysis: 'none',
        assistant: 'high',
        articleSentenceTranslation: 'low'
    });
    assert.deepEqual(normalizeProfile({}, scope).taskThinking, {});

    const sanitized = sanitizeAISettings({
        thinking: {
            assistant: 'medium',
            wordAnalysis: 'auto',
            'bad task': 'high',
            broken: 'ultra'
        }
    });
    assert.deepEqual(sanitized.thinking, { assistant: 'medium', wordAnalysis: 'auto' });
    // Older snapshots have no field; the sanitiser must not invent one.
    assert.equal('thinking' in sanitizeAISettings({}), false);

    const snapshot = sanitizeSnapshotAISettings({
        thinking: { assistant: 'high', articleParagraphTranslation: 'low', broken: 'max' }
    });
    assert.deepEqual(snapshot.thinking, { assistant: 'high', articleParagraphTranslation: 'low' });
    assert.equal('thinking' in sanitizeSnapshotAISettings({}), false);
    assert.deepEqual(sanitizeSnapshotThinkingMappings({
        assistant: 'HIGH',
        'bad task': 'low',
        broken: 'max'
    }), { assistant: 'high' });
});

test('empty thinking maps are never emitted by views or sanitizers', () => {
    const scope = { endpoint: 'https://sync.example', userId: 'thinking-empty', guest: false };
    try {
        saveAIProfile({}, scope);
        assert.equal('thinking' in getAIViewFromProfile(scope), false);

        // Empty and fully invalid maps carry no information: omit the field so
        // pushing them cannot wipe another device's choices.
        assert.equal('thinking' in sanitizeAISettings({ thinking: {} }), false);
        assert.equal('thinking' in sanitizeAISettings({ thinking: { broken: 'ultra' } }), false);
        assert.equal('thinking' in sanitizeSnapshotAISettings({ thinking: {} }), false);
        assert.equal('thinking' in sanitizeSnapshotAISettings({ thinking: { 'bad task': 'low' } }), false);

        saveAIProfile({ taskThinking: { assistant: 'high', wordAnalysis: 'none' } }, scope);
        assert.deepEqual(getAIViewFromProfile(scope).thinking, { assistant: 'high', wordAnalysis: 'none' });
    } finally {
        deleteAIProfile(scope);
    }
});

test('older AI snapshots do not clear newer task thinking choices', () => {
    const scope = { endpoint: 'https://thinking-sync.example', userId: 'thinking-snapshot', guest: false };
    const stamp = '2026-11-02T00:00:00.000Z';
    try {
        saveAIProfile({ taskThinking: { assistant: 'high', wordAnalysis: 'none' } }, scope);
        applyRemoteAISettings({ providers: {}, models: {} }, stamp, scope);
        assert.deepEqual(loadAIProfile(scope).taskThinking, { assistant: 'high', wordAnalysis: 'none' });

        applyRemoteAISettings({
            providers: {},
            models: {},
            thinking: { assistant: 'low' }
        }, stamp, scope);
        assert.deepEqual(loadAIProfile(scope).taskThinking, { assistant: 'low' });

        // An explicit empty map is a deliberate clear from a newer client.
        applyRemoteAISettings({ providers: {}, models: {}, thinking: {} }, stamp, scope);
        assert.deepEqual(loadAIProfile(scope).taskThinking, {});
    } finally {
        deleteAIProfile(scope);
    }
});

test('thinking priority is override > personal setting > app default', () => {
    const previousEndpoint = globalThis.__BDC_SYNC_ENDPOINT__;
    const previousUser = localStorage.getItem('sync_user_id');
    try {
        globalThis.__BDC_SYNC_ENDPOINT__ = 'https://thinking-priority.example';
        localStorage.setItem('sync_user_id', 'thinking-priority-user');
        saveAIProfile({
            taskThinking: { assistant: 'high', wordAnalysis: 'auto' }
        });
        assert.equal(resolveThinkingLevel('assistant').level, 'high');
        assert.equal(resolveThinkingLevel('assistant').source, 'profile');
        assert.equal(resolveThinkingLevel('assistant', { override: 'low' }).level, 'low');
        assert.equal(resolveThinkingLevel('assistant', { override: 'low' }).source, 'override');
        // Article word tasks inherit the personal wordAnalysis value.
        assert.equal(resolveThinkingLevel('articleWordTranslation').level, 'auto');
        assert.equal(resolveThinkingLevel('articleWordTranslation').key, 'wordAnalysis');
        // Untouched tasks still use the app default.
        assert.equal(resolveThinkingLevel('qaChecking').level, 'auto');
        assert.equal(resolveThinkingLevel('qaChecking').source, 'app');
    } finally {
        try { deleteAIProfile(); } catch (_) {}
        if (previousEndpoint === undefined) delete globalThis.__BDC_SYNC_ENDPOINT__;
        else globalThis.__BDC_SYNC_ENDPOINT__ = previousEndpoint;
        if (previousUser === null) localStorage.removeItem('sync_user_id');
        else localStorage.setItem('sync_user_id', previousUser);
    }
});

// ---------------------------------------------------------------------------
// R3 — the static config checker must fail closed
//
// An input the tool did not inspect is never "clean": piping a fetch into
// `--dir /dev/stdin` reported ok=true without reading a single byte.
// ---------------------------------------------------------------------------
const CHECKER = fileURLToPath(new URL('../scripts/check-ai-static-config.mjs', import.meta.url));

function runChecker(args, input) {
    return spawnSync(process.execPath, [CHECKER, ...args], { input, encoding: 'utf8' });
}

function parseReport(result) {
    try { return JSON.parse(result.stdout); } catch (_) { return null; }
}

function tempDir(files = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-static-check-'));
    for (const [name, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, name), content);
    }
    return dir;
}

test('static checker reads stdin instead of reporting an uninspected pass', () => {
    const result = runChecker(['--dir', '/dev/stdin', '--json'], 'export const API_KEY = "test-placeholder-only";\n');
    assert.equal(result.status, 1, 'piped content was not inspected');
    const report = parseReport(result);
    assert.ok(report, 'the JSON report must still be printed');
    assert.equal(report.ok, false);
    assert.equal(report.scanned, 1);
    assert.deepEqual(report.findings.map((item) => item.kind), ['legacy-ai-export:API_KEY']);
    assert.ok(!result.stdout.includes('test-placeholder-only'), 'the checker must not echo the value');
});

test('static checker accepts clean stdin and reports what it scanned', () => {
    const result = runChecker(['--stdin', '--json'], "export const TTS = { voice: '' };\nexport const SYNC = { endpoint: '' };\n");
    assert.equal(result.status, 0);
    const report = parseReport(result);
    assert.equal(report.ok, true);
    assert.equal(report.scanned, 1);
    assert.equal(report.findings.length, 0);
});

test('static checker permits protocol hostname hints but rejects concrete provider URLs', () => {
    const hints = "const hosts = new Set(['api.openai.com']);\nif (host === 'api.anthropic.com') detect();\n";
    const clean = runChecker(['--stdin', '--name', 'protocols.js', '--json'], hints);
    assert.equal(clean.status, 0);
    for (const endpoint of ['https://api.openai.com/v1', 'https://api.anthropic.com/v1/messages', '//generativelanguage.googleapis.com/v1beta']) {
        const result = runChecker(['--stdin', '--name', 'settings.js', '--json'], `const endpoint = '${endpoint}';\n`);
        assert.equal(result.status, 1);
        assert.ok(parseReport(result).findings.some((item) => item.kind === 'hardcoded-provider-endpoint'));
    }
});

test('static checker preserves key checks after URL strings and ignores line comments', () => {
    const result = runChecker(['--stdin', '--name', 'settings.js', '--json'],
        'const p = { url: "https://example.com/v1", apiKey: "test-placeholder-only" }; // configuration\n');
    assert.equal(result.status, 1);
    assert.ok(parseReport(result).findings.some((item) => item.kind === 'inline-api-key-literal'));
    assert.ok(!result.stdout.includes('test-placeholder-only'));
    const comment = runChecker(['--stdin', '--name', 'settings.js', '--json'],
        '// Example: https://api.openai.com/v1 apiKey: "test-placeholder-only"\n');
    assert.equal(comment.status, 0);
});

test('static checker refuses empty stdin instead of reporting clean', () => {
    const result = runChecker(['--dir', '-', '--json'], '');
    assert.equal(result.status, 2);
    const report = parseReport(result);
    assert.equal(report.ok, false);
    assert.equal(report.error, 'stdin_empty');
    assert.equal(report.scanned, 0);
});

test('static checker refuses a target that is not a directory', () => {
    const result = runChecker(['--dir', CHECKER, '--json']);
    assert.equal(result.status, 2);
    assert.equal(parseReport(result).error, 'target_not_directory');
});

test('static checker refuses a missing target and an empty directory', () => {
    const missing = runChecker(['--dir', path.join(os.tmpdir(), 'bdc-static-check-does-not-exist'), '--json']);
    assert.equal(missing.status, 2);
    assert.equal(parseReport(missing).error, 'target_missing');

    const empty = tempDir({ 'notes.txt': 'nothing to scan here\n' });
    try {
        const result = runChecker(['--dir', empty, '--json']);
        assert.equal(result.status, 2, 'scanning nothing must not pass');
        const report = parseReport(result);
        assert.equal(report.ok, false);
        assert.equal(report.error, 'no_files_scanned');
    } finally {
        fs.rmSync(empty, { recursive: true, force: true });
    }
});

test('static checker scans a real directory in both directions', () => {
    const clean = tempDir({
        'ai-config.js': "export const TTS = { voice: '' };\nexport const SYNC = { endpoint: '' };\n",
        'index.html': '<html><script type="module" src="main.js"></script></html>\n'
    });
    const dirty = tempDir({
        'ai-config.js': 'export const API_KEY = "test-placeholder-only";\n',
        'index.html': '<html></html>\n'
    });
    try {
        const cleanResult = runChecker(['--dir', clean, '--json']);
        assert.equal(cleanResult.status, 0, parseReport(cleanResult)?.error || 'clean directory reported a finding');
        assert.equal(parseReport(cleanResult).scanned, 2);

        const dirtyResult = runChecker(['--dir', dirty, '--json']);
        assert.equal(dirtyResult.status, 1);
        assert.equal(parseReport(dirtyResult).ok, false);
        assert.ok(!dirtyResult.stdout.includes('test-placeholder-only'));
    } finally {
        fs.rmSync(clean, { recursive: true, force: true });
        fs.rmSync(dirty, { recursive: true, force: true });
    }
});

test('a pending delete keeps its keep-local intent through normalisation', () => {
    const credential = normalizeCredential({
        apiKey: 'k',
        binding: { formatVersion: 1, format: 'openai-chat', apiUrl: 'https://example.com/v1/chat/completions', modelsUrl: '', authMode: 'bearer' },
        syncMode: 'cloud-removal-pending',
        version: 3,
        pending: { type: 'delete', mutationId: 'mut_12345678', expectedVersion: 3, keepLocalKey: true }
    });
    assert.equal(credential.syncMode, 'cloud-removal-pending');
    assert.equal(credential.pending.type, 'delete');
    assert.equal(credential.pending.keepLocalKey, true, 'the keep-local intent was dropped on load');

    const providerDelete = normalizeCredential({
        apiKey: '',
        syncMode: 'cloud-removal-pending',
        version: 3,
        pending: { type: 'delete', mutationId: 'mut_87654321', expectedVersion: 3 }
    });
    assert.equal(providerDelete.pending.keepLocalKey, false, 'a provider delete must not keep the key');
});

test('<details> open state survives a settings re-render', async () => {
    const { captureDetailState, restoreDetailState } = await import('../modules/detail-state.js');

    const advanced = { dataset: { keepOpen: 'ai-advanced-personal-1' }, open: true };
    const tasks = { dataset: { keepOpen: 'ai-tasks' }, open: false };
    const state = captureDetailState({ querySelectorAll: () => [advanced, tasks] });

    assert.equal(state.get('ai-advanced-personal-1'), true, 'an open section lost its state');
    assert.equal(state.get('ai-tasks'), false, 'a closed section must stay recorded as closed');

    // Simulate the rebuilt DOM.  Selecting a model re-renders the whole panel,
    // which used to fold the section the user was working in.
    const rebuiltAdvanced = { dataset: { keepOpen: 'ai-advanced-personal-1' }, open: false };
    const rebuiltTasks = { dataset: { keepOpen: 'ai-tasks' }, open: true };
    restoreDetailState({ querySelectorAll: () => [rebuiltAdvanced, rebuiltTasks] }, state);
    assert.equal(rebuiltAdvanced.open, true, 'the open section collapsed after re-render');
    assert.equal(rebuiltTasks.open, false, 'a section that was closed got forced open');

    // Panels that did not exist before keep their markup default.
    const fresh = { dataset: { keepOpen: 'ai-advanced-personal-2' }, open: false };
    restoreDetailState({ querySelectorAll: () => [fresh] }, state);
    assert.equal(fresh.open, false);

    // An empty capture (first mount) must not touch anything.
    restoreDetailState({ querySelectorAll: () => [fresh] }, captureDetailState(null));
    assert.equal(fresh.open, false);
});

test('saving one settings field keeps the rest of pen_global_settings', async () => {
    const { saveGlobalSettings } = await import('../modules/settings.js');
    // The global settings panel now saves field by field; a shallow
    // { ...stored, ...patch } write used to drop sibling keys inside tts,
    // reading and assistant.
    for (let i = localStorage.length - 1; i >= 0; i -= 1) localStorage.removeItem(localStorage.key(i));

    saveGlobalSettings({ tts: { use: 'local', baseUrlCustom: 'http://tts.lan:9000' } });
    saveGlobalSettings({ tts: { selectedVoices: { 'en-US': 'voice-a' } } });
    saveGlobalSettings({ reading: { englishVariant: 'en-US' } });
    saveGlobalSettings({ reading: { chineseVariant: 'zh-HK' } });
    saveGlobalSettings({ assistant: { enabled: false } });
    saveGlobalSettings({ assistant: { stream: false } });
    saveGlobalSettings({ theme: 'indigo' });
    saveGlobalSettings({ theme: 'teal' });

    const stored = JSON.parse(localStorage.getItem('pen_global_settings'));
    assert.equal(stored.tts.use, 'local', 'tts.use was dropped');
    assert.equal(stored.tts.baseUrlCustom, 'http://tts.lan:9000', 'tts.baseUrlCustom was dropped');
    assert.equal(stored.tts.selectedVoices['en-US'], 'voice-a', 'tts.selectedVoices was dropped');
    assert.equal(stored.reading.englishVariant, 'en-US', 'reading.englishVariant was dropped');
    assert.equal(stored.reading.chineseVariant, 'zh-HK', 'reading.chineseVariant was dropped');
    assert.equal(stored.assistant.enabled, false, 'assistant.enabled was dropped');
    assert.equal(stored.assistant.stream, false, 'assistant.stream was dropped');
    assert.equal(stored.theme, 'teal');
    assert.ok(!('ai' in stored), 'AI settings must not be duplicated into the legacy blob');
});
