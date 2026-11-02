// Protocol-level integration tests: the three implemented adapters driven
// through the shared entry points (`requestAI` / `streamAIResponse`).
//
// Usage: node --test tests/ai-protocol-integration.test.mjs
//
// For each protocol this covers: plain text, images, structured (JSON) output,
// streaming deltas, cancellation and error mapping. Everything is answered by a
// mocked fetch with fake keys — no real provider or Worker is contacted, so this
// is *not* evidence that the live services behave identically.

import test from 'node:test';
import assert from 'node:assert/strict';

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
const win = {
    listeners: new Map(),
    addEventListener(type, callback) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type).add(callback);
    },
    removeEventListener(type, callback) {
        const set = this.listeners.get(type);
        if (set) set.delete(callback);
    },
    dispatchEvent(event) {
        const set = this.listeners.get(event && event.type);
        if (set) for (const callback of [...set]) callback(event);
        return true;
    },
    localStorage: globalThis.localStorage
};
globalThis.window = win;
const doc = {
    hidden: false,
    documentElement: {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
    querySelectorAll() { return []; },
    getElementById() { return null; }
};
globalThis.document = doc;
// Device-scoped profile: no login, no sync endpoint.
globalThis.__BDC_SYNC_ENDPOINT__ = '';

const {
    analyzeWordInSentence,
    getWordAnalysis,
    isLengthFinishReason,
    requestAI,
    resetThinkingFallbackMemory,
    streamAIResponse
} = await import('../modules/api.js');
const profile = await import('../modules/ai-profile-storage.js');

const GUEST_SCOPE = { endpoint: '', userId: '', guest: true, key: 'bdc_ai_profile_v1:device:guest' };

function providerRecord(providerId, format, apiUrl, modelsUrl, authMode) {
    return {
        id: providerId,
        label: providerId,
        enabled: true,
        format,
        baseUrl: apiUrl.replace(/\/(chat\/completions|messages)$/i, '').replace(/%7Bmodel%7D:generateContent$/, ''),
        apiUrl,
        modelsUrl,
        authMode,
        allowedModels: ['m1'],
        discoveredModels: [{ id: 'm1' }]
    };
}

const CHAT = providerRecord(
    'personal-chat',
    'openai-chat',
    'https://chat.mock/v1/chat/completions',
    'https://chat.mock/v1/models',
    'bearer'
);
const ANTHROPIC = providerRecord(
    'personal-anthropic',
    'anthropic-messages',
    'https://anthropic.mock/v1/messages',
    'https://anthropic.mock/v1/models',
    'x-api-key'
);
const GEMINI = providerRecord(
    'personal-gemini',
    'gemini',
    'https://gemini.mock/v1beta/models/%7Bmodel%7D:generateContent',
    'https://gemini.mock/v1beta/models',
    'google'
);

function seedProfile() {
    store.clear();
    // api.js keeps capability memory at module scope; reset it so tests do not
    // leak an unsupported target into the next (or a --test-name-pattern subset)
    // case that reuses the same provider/model.
    resetThinkingFallbackMemory();
    const providers = {};
    const credentials = {};
    for (const provider of [CHAT, ANTHROPIC, GEMINI]) {
        providers[provider.id] = provider;
        credentials[provider.id] = {
            apiKey: 'test-key',
            binding: {
                formatVersion: 1,
                format: provider.format,
                apiUrl: provider.apiUrl,
                modelsUrl: provider.modelsUrl,
                authMode: provider.authMode
            },
            version: 0,
            syncMode: 'local-only',
            bindingVerified: true
        };
    }
    profile.saveAIProfile({
        schemaVersion: 1,
        providers,
        credentials,
        taskModels: { default: 'personal-chat:m1' }
    }, GUEST_SCOPE);
}

function seedWithModels(providerId, models) {
    seedProfile();
    const loaded = profile.loadAIProfile(GUEST_SCOPE);
    loaded.providers[providerId].allowedModels = models;
    profile.saveAIProfile(loaded, GUEST_SCOPE);
}

let respond = null;
let lastRequest = null;

globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    let body = null;
    try { body = init.body ? JSON.parse(init.body) : null; } catch (_) { body = null; }
    lastRequest = { url, body, headers: init.headers || {}, signal: init.signal };
    return respond(lastRequest);
};

function jsonResponse(payload, status = 200) {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}

function sseResponse(chunks) {
    const encoder = new TextEncoder();
    let index = 0;
    return new Response(new ReadableStream({
        pull(controller) {
            if (index >= chunks.length) {
                controller.close();
                return;
            }
            controller.enqueue(encoder.encode(chunks[index]));
            index += 1;
        }
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function abortedStream(firstChunk, signal) {
    const encoder = new TextEncoder();
    let sent = false;
    return new Response(new ReadableStream({
        start(controller) {
            if (!signal) return;
            signal.addEventListener('abort', () => {
                try { controller.error(new DOMException('Aborted', 'AbortError')); } catch (_) {}
            }, { once: true });
        },
        pull(controller) {
            if (!sent) {
                sent = true;
                controller.enqueue(encoder.encode(firstChunk));
                return;
            }
            return new Promise(() => {});
        }
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const PROTOCOLS = [
    {
        name: 'openai-chat',
        providerId: 'personal-chat',
        model: 'personal-chat:m1',
        endpoint: /chat\.mock\/v1\/chat\/completions$/,
        textPayload: { choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }] },
        streamChunks: [
            'data: {"choices":[{"delta":{"content":"he"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"llo"},"finish_reason":"stop"}]}\n\n',
            'data: [DONE]\n\n'
        ],
        assertText: (body) => {
            assert.equal(body.model, 'm1');
            assert.equal(body.messages[0].role, 'user');
        },
        assertImage: (body) => {
            const parts = body.messages[0].content;
            assert.ok(Array.isArray(parts), 'image input was not converted to parts');
            assert.equal(parts[1].type, 'image_url');
            assert.equal(parts[1].image_url.url, 'data:image/png;base64,AAAA');
        },
        assertStructured: (body) => {
            assert.deepEqual(body.response_format, { type: 'json_object' });
        },
        authHeader: ['Authorization', 'Bearer test-key']
    },
    {
        name: 'anthropic-messages',
        providerId: 'personal-anthropic',
        model: 'personal-anthropic:m1',
        endpoint: /anthropic\.mock\/v1\/messages$/,
        textPayload: { content: [{ type: 'text', text: 'hello' }], stop_reason: 'end_turn' },
        streamChunks: [
            'data: {"type":"content_block_delta","delta":{"text":"he"}}\n\n',
            'data: {"type":"content_block_delta","delta":{"text":"llo"}}\n\n',
            'data: {"type":"message_stop"}\n\n'
        ],
        assertText: (body) => {
            assert.equal(body.model, 'm1');
            assert.ok(body.max_tokens > 0);
        },
        assertImage: (body) => {
            const blocks = body.messages[0].content;
            assert.equal(blocks[1].type, 'image');
            assert.equal(blocks[1].source.media_type, 'image/png');
            assert.equal(blocks[1].source.data, 'AAAA');
        },
        assertStructured: (body) => {
            assert.match(body.system || '', /JSON/);
        },
        authHeader: ['x-api-key', 'test-key']
    },
    {
        name: 'gemini',
        providerId: 'personal-gemini',
        model: 'personal-gemini:m1',
        endpoint: /gemini\.mock\/v1beta\/models\/m1:generateContent$/,
        textPayload: {
            candidates: [{ content: { parts: [{ text: 'hello' }] }, finishReason: 'STOP' }],
            usageMetadata: { totalTokenCount: 3 }
        },
        streamChunks: [
            'data: {"candidates":[{"content":{"parts":[{"text":"he"}]}}]}\n\n',
            'data: {"candidates":[{"content":{"parts":[{"text":"llo"}]},"finishReason":"STOP"}]}\n\n'
        ],
        assertText: (body) => {
            assert.ok(!body.model, 'gemini sends the model in the URL, not the body');
        },
        assertImage: (body) => {
            const parts = body.contents[0].parts;
            assert.equal(parts[1].inlineData.mimeType, 'image/png');
            assert.equal(parts[1].inlineData.data, 'AAAA');
        },
        assertStructured: (body) => {
            assert.equal(body.generationConfig.responseMimeType, 'application/json');
        },
        authHeader: ['x-goog-api-key', 'test-key']
    }
];

for (const protocol of PROTOCOLS) {
    test(`${protocol.name}: text request and auth header`, async () => {
        seedProfile();
        respond = () => jsonResponse(protocol.textPayload);
        const result = await requestAI({
            model: protocol.model,
            messages: [{ role: 'user', content: 'hi' }],
            taskType: 'default'
        });
        assert.match(lastRequest.url, protocol.endpoint);
        assert.equal(lastRequest.headers[protocol.authHeader[0]], protocol.authHeader[1]);
        assert.equal(result.text, 'hello');
    });

    test(`${protocol.name}: image input is encoded for the protocol`, async () => {
        seedProfile();
        respond = () => jsonResponse(protocol.textPayload);
        await requestAI({
            model: protocol.model,
            messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: 'describe' },
                    { type: 'image', imageUrl: 'data:image/png;base64,AAAA' }
                ]
            }],
            taskType: 'default'
        });
        protocol.assertImage(lastRequest.body);
    });

    test(`${protocol.name}: structured output is requested`, async () => {
        seedProfile();
        respond = () => jsonResponse(protocol.textPayload);
        await requestAI({
            model: protocol.model,
            messages: [{ role: 'user', content: 'return json' }],
            responseFormat: { type: 'json_object' },
            taskType: 'default'
        });
        protocol.assertStructured(lastRequest.body);
    });

    test(`${protocol.name}: streaming deltas are decoded`, async () => {
        seedProfile();
        respond = () => sseResponse(protocol.streamChunks);
        const deltas = [];
        const result = await streamAIResponse({
            model: protocol.model,
            messages: [{ role: 'user', content: 'hi' }],
            taskType: 'assistant',
            onDelta: (text) => deltas.push(text)
        });
        // Gemini carries the streaming mode in the URL, the other two in the body.
        if (protocol.name === 'gemini') assert.match(lastRequest.url, /:streamGenerateContent\?alt=sse$/);
        else assert.equal(lastRequest.body.stream, true);
        assert.equal(result.text, 'hello');
        assert.deepEqual(deltas, ['he', 'llo']);
    });

    test(`${protocol.name}: cancellation aborts the stream`, async () => {
        seedProfile();
        respond = (request) => abortedStream(protocol.streamChunks[0], request.signal);
        const controller = new AbortController();
        const started = Date.now();
        const pending = streamAIResponse({
            model: protocol.model,
            messages: [{ role: 'user', content: 'hi' }],
            taskType: 'assistant',
            signal: controller.signal,
            onDelta: () => controller.abort()
        });
        await assert.rejects(pending, (error) => error.code === 'request_aborted' || error.name === 'AbortError');
        assert.ok(Date.now() - started < 5000, 'cancellation did not stop the stream');
    });
}

// 推理模型的思考若混進正文，使用者會在答案上方看到一大段模型自語。
test('reasoning output never reaches the answer channel', async () => {
    const cases = [
        {
            provider: CHAT,
            model: 'personal-chat:m1',
            chunks: [
                'data: {"choices":[{"delta":{"reasoning_content":"先想一下"}}]}\n\n',
                'data: {"choices":[{"delta":{"reasoning_content":"，再想一下"}}]}\n\n',
                'data: {"choices":[{"delta":{"content":"答案是 42"},"finish_reason":"stop"}]}\n\n',
                'data: [DONE]\n\n'
            ],
            text: '答案是 42',
            reasoning: '先想一下，再想一下'
        },
        {
            provider: ANTHROPIC,
            model: 'personal-anthropic:m1',
            chunks: [
                'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"先想一下"}}\n\n',
                'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"答案是 42"}}\n\n',
                'data: {"type":"message_stop"}\n\n'
            ],
            text: '答案是 42',
            reasoning: '先想一下'
        },
        {
            provider: GEMINI,
            model: 'personal-gemini:m1',
            chunks: [
                'data: {"candidates":[{"content":{"parts":[{"text":"先想一下","thought":true}]}}]}\n\n',
                'data: {"candidates":[{"content":{"parts":[{"text":"答案是 42"}]},"finishReason":"STOP"}]}\n\n'
            ],
            text: '答案是 42',
            reasoning: '先想一下'
        }
    ];
    for (const item of cases) {
        seedProfile();
        respond = () => sseResponse(item.chunks);
        const answerDeltas = [];
        const reasoningDeltas = [];
        const result = await streamAIResponse({
            model: item.model,
            messages: [{ role: 'user', content: 'hi' }],
            taskType: 'assistant',
            onDelta: (text) => answerDeltas.push(text),
            onReasoning: (text) => reasoningDeltas.push(text)
        });
        assert.equal(result.text, item.text, `${item.provider.id}: answer text`);
        assert.equal(result.reasoning, item.reasoning, `${item.provider.id}: reasoning text`);
        assert.deepEqual(answerDeltas, [item.text], `${item.provider.id}: answer deltas`);
        assert.ok(!answerDeltas.join('').includes('先想一下'), `${item.provider.id}: thinking leaked into the answer`);
        assert.ok(reasoningDeltas.length > 0, `${item.provider.id}: reasoning deltas`);
    }
});

async function expectErrorCode(provider, status, expected) {
    seedProfile();
    respond = () => jsonResponse({ error: { message: 'mock', type: 'mock' } }, status);
    await assert.rejects(
        () => requestAI({
            model: `${provider.id}:m1`,
            messages: [{ role: 'user', content: 'hi' }],
            taskType: 'default'
        }),
        (error) => error.code === expected,
        `status ${status} should map to ${expected}`
    );
}

test('non-retryable error statuses map to stable provider error codes', async () => {
    await expectErrorCode(CHAT, 401, 'provider_auth_failed');
    await expectErrorCode(ANTHROPIC, 400, 'provider_request_failed');
    await expectErrorCode(GEMINI, 403, 'provider_forbidden');
});

test('retryable failures keep their code after the bounded retries', { timeout: 30000 }, async () => {
    // requestAI retries 429/5xx twice with backoff; the final error code must
    // still identify the provider problem instead of a generic failure.
    await expectErrorCode(CHAT, 429, 'provider_rate_limited');
    await expectErrorCode(ANTHROPIC, 503, 'provider_server_error');
});

test('a missing provider key never borrows another provider', async () => {
    seedProfile();
    const loaded = profile.loadAIProfile(GUEST_SCOPE);
    delete loaded.credentials['personal-anthropic'];
    profile.saveAIProfile(loaded, GUEST_SCOPE);
    respond = () => jsonResponse({ content: [{ type: 'text', text: 'should not happen' }] });
    await assert.rejects(
        () => requestAI({
            model: 'personal-anthropic:m1',
            messages: [{ role: 'user', content: 'hi' }],
            taskType: 'default'
        }),
        (error) => error.code === 'ai_key_missing'
    );
});

// A provider that rejects the thinking field must only cost one failed request:
// later calls skip the guaranteed 400/422, and the retry uses the caller's
// original token budget instead of the thinking floor.
test('rejected thinking parameters are remembered and drop the token floor', async () => {
    seedProfile();
    const calls = [];
    const events = [];
    const onFallback = (event) => events.push(event.detail);
    win.addEventListener('bdc:ai-thinking-fallback', onFallback);
    try {
        respond = (request) => {
            calls.push(request);
            if (calls.length === 1) {
                return jsonResponse({ error: { message: 'reasoning_effort is not supported for this model' } }, 400);
            }
            return jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
        };

        const request = {
            model: 'personal-chat:m1',
            messages: [{ role: 'user', content: 'hi' }],
            taskType: 'default',
            thinking: 'high',
            maxTokens: 300
        };
        const first = await requestAI(request);
        assert.equal(first.text, 'ok');
        assert.equal(calls.length, 2);
        assert.equal(calls[0].body.reasoning_effort, 'high');
        assert.equal(calls[0].body.max_tokens, 5000, 'thinking floor should apply to the first attempt');
        assert.equal(Object.prototype.hasOwnProperty.call(calls[1].body, 'reasoning_effort'), false);
        assert.equal(calls[1].body.max_tokens, 300, 'fallback must restore the original maxTokens');
        assert.equal(events.length, 1);
        assert.equal(events[0].provider, 'personal-chat');
        assert.equal(events[0].model, 'm1');
        assert.equal(events[0].level, 'high');

        const second = await requestAI(request);
        assert.equal(second.text, 'ok');
        assert.equal(calls.length, 3, 'the remembered target must not be tried with thinking again');
        assert.equal(Object.prototype.hasOwnProperty.call(calls[2].body, 'reasoning_effort'), false);
        assert.equal(calls[2].body.max_tokens, 300);
        assert.equal(events.length, 1, 'fallback is announced only once per provider/model/format/level');
    } finally {
        win.removeEventListener('bdc:ai-thinking-fallback', onFallback);
    }
});

test('anthropic max_tokens rejection during thinking also falls back once', async () => {
    seedProfile();
    const calls = [];
    respond = (request) => {
        calls.push(request);
        if (calls.length === 1) {
            return jsonResponse({
                type: 'error',
                error: { type: 'invalid_request_error', message: 'max_tokens: 9216 > 4096, which is the maximum allowed for claude-old' }
            }, 400);
        }
        return jsonResponse({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' });
    };
    const result = await requestAI({
        model: 'personal-anthropic:m1',
        messages: [{ role: 'user', content: 'hi' }],
        taskType: 'articleSentenceTranslation',
        thinking: 'high',
        maxTokens: 300
    });
    assert.equal(result.text, 'ok');
    assert.equal(calls.length, 2);
    assert.ok(calls[0].body.thinking, 'first attempt should enable extended thinking');
    assert.ok(calls[0].body.max_tokens > 300);
    assert.equal(Object.prototype.hasOwnProperty.call(calls[1].body, 'thinking'), false);
    assert.equal(calls[1].body.max_tokens, 300);
});

// The streaming path has its own retry, so it needs the same memory and token
// restoration guarantees as requestAI.
test('streaming thinking fallback remembers the target and restores maxTokens', async () => {
    seedProfile();
    const loaded = profile.loadAIProfile(GUEST_SCOPE);
    loaded.providers['personal-chat'].allowedModels = ['m1', 'm2'];
    profile.saveAIProfile(loaded, GUEST_SCOPE);

    const calls = [];
    respond = (request) => {
        calls.push(request);
        if (calls.length === 1) {
            return jsonResponse({ error: { message: 'reasoning_effort is not supported by this gateway' } }, 422);
        }
        return sseResponse([
            'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
            'data: [DONE]\n\n'
        ]);
    };

    const request = {
        model: 'personal-chat:m2',
        messages: [{ role: 'user', content: 'hi' }],
        taskType: 'assistant',
        thinking: 'high',
        maxTokens: 300
    };
    const first = await streamAIResponse(request);
    assert.equal(first.text, 'ok');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].body.reasoning_effort, 'high');
    assert.equal(calls[0].body.max_tokens, 5000);
    assert.equal(Object.prototype.hasOwnProperty.call(calls[1].body, 'reasoning_effort'), false);
    assert.equal(calls[1].body.max_tokens, 300);

    const second = await streamAIResponse(request);
    assert.equal(second.text, 'ok');
    assert.equal(calls.length, 3, 'streaming must skip a remembered unsupported target');
    assert.equal(Object.prototype.hasOwnProperty.call(calls[2].body, 'reasoning_effort'), false);
    assert.equal(calls[2].body.max_tokens, 300);
});

// A provider that only refuses `none` must still receive `high` later: the
// rejection memory is per level, not per model.
test('unsupported thinking memory is scoped to the level that was rejected', async () => {
    seedWithModels('personal-chat', ['m-levels']);
    const calls = [];
    respond = (request) => {
        calls.push(request);
        if (request.body.reasoning_effort === 'none') {
            return jsonResponse({ error: { message: 'reasoning_effort none is not supported' } }, 400);
        }
        return jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
    };

    const result = await requestAI({
        model: 'personal-chat:m-levels',
        messages: [{ role: 'user', content: 'hi' }],
        taskType: 'default',
        thinking: 'none',
        maxTokens: 300
    });
    assert.equal(result.text, 'ok');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].body.reasoning_effort, 'none');
    assert.equal(Object.prototype.hasOwnProperty.call(calls[1].body, 'reasoning_effort'), false);

    const high = await requestAI({
        model: 'personal-chat:m-levels',
        messages: [{ role: 'user', content: 'hi' }],
        taskType: 'default',
        thinking: 'high',
        maxTokens: 300
    });
    assert.equal(high.text, 'ok');
    assert.equal(calls.length, 3, 'high must be attempted even after none was rejected');
    assert.equal(calls[2].body.reasoning_effort, 'high');
});

// The session memory is keyed by endpoint as well: the same provider id may be
// pointed at a different gateway where thinking is supported.
test('unsupported thinking memory is retried after the endpoint changes', async () => {
    seedWithModels('personal-chat', ['m-endpoint']);
    const calls = [];
    respond = (request) => {
        calls.push(request);
        if (Object.prototype.hasOwnProperty.call(request.body, 'reasoning_effort')) {
            return jsonResponse({ error: { message: 'reasoning_effort is not supported' } }, 400);
        }
        return jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
    };

    await requestAI({
        model: 'personal-chat:m-endpoint',
        messages: [{ role: 'user', content: 'hi' }],
        taskType: 'default',
        thinking: 'none',
        maxTokens: 300
    });
    assert.equal(calls.length, 2);

    const loaded = profile.loadAIProfile(GUEST_SCOPE);
    const nextUrl = 'https://chat2.mock/v1/chat/completions';
    const nextModelsUrl = 'https://chat2.mock/v1/models';
    loaded.providers['personal-chat'].apiUrl = nextUrl;
    loaded.providers['personal-chat'].modelsUrl = nextModelsUrl;
    loaded.credentials['personal-chat'].binding.apiUrl = nextUrl;
    loaded.credentials['personal-chat'].binding.modelsUrl = nextModelsUrl;
    profile.saveAIProfile(loaded, GUEST_SCOPE);

    respond = (request) => {
        calls.push(request);
        return jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
    };
    await requestAI({
        model: 'personal-chat:m-endpoint',
        messages: [{ role: 'user', content: 'hi' }],
        taskType: 'default',
        thinking: 'none',
        maxTokens: 300
    });
    assert.equal(calls.length, 3);
    assert.match(calls[2].url, /chat2\.mock/);
    assert.equal(calls[2].body.reasoning_effort, 'none', 'a new endpoint must be probed again');
});

test('auth and catalog changes clear the thinking fallback memory', async () => {
    seedWithModels('personal-chat', ['m-reset']);
    const calls = [];
    const rejectThinking = (request) => {
        calls.push(request);
        if (Object.prototype.hasOwnProperty.call(request.body, 'reasoning_effort')) {
            return jsonResponse({ error: { message: 'reasoning_effort is not supported' } }, 400);
        }
        return jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
    };
    const succeed = (request) => {
        calls.push(request);
        return jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
    };
    const request = {
        model: 'personal-chat:m-reset',
        messages: [{ role: 'user', content: 'hi' }],
        taskType: 'default',
        thinking: 'none',
        maxTokens: 300
    };

    respond = rejectThinking;
    await requestAI(request);
    assert.equal(calls.length, 2);

    // Catalog change -> stale capability memory is dropped.
    win.dispatchEvent(new CustomEvent('bdc:ai-catalog-change', { detail: {} }));
    respond = succeed;
    await requestAI(request);
    assert.equal(calls.length, 3);
    assert.equal(calls[2].body.reasoning_effort, 'none');

    // Mark again, then sign out -> memory is dropped again.
    respond = rejectThinking;
    await requestAI(request);
    assert.equal(calls.length, 5);
    win.dispatchEvent(new CustomEvent('bdc:auth-change', {
        detail: { event: 'SIGNED_OUT', user: null }
    }));
    respond = succeed;
    await requestAI(request);
    assert.equal(calls.length, 6);
    assert.equal(calls[5].body.reasoning_effort, 'none');
});

test('structured 422 detail arrays trigger one thinking-free retry', async () => {
    seedWithModels('personal-chat', ['m-422']);
    const calls = [];
    respond = (request) => {
        calls.push(request);
        if (calls.length === 1) {
            return jsonResponse({
                detail: [{
                    loc: ['body', 'reasoning_effort'],
                    msg: 'Extra inputs are not permitted',
                    type: 'extra_forbidden'
                }]
            }, 422);
        }
        return jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
    };

    const result = await requestAI({
        model: 'personal-chat:m-422',
        messages: [{ role: 'user', content: 'hi' }],
        taskType: 'default',
        thinking: 'high',
        maxTokens: 300
    });
    assert.equal(result.text, 'ok');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].body.reasoning_effort, 'high');
    assert.equal(Object.prototype.hasOwnProperty.call(calls[1].body, 'reasoning_effort'), false);
    assert.equal(calls[1].body.max_tokens, 300);
});

test('Anthropic max_tokens and Gemini MAX_TOKENS stop reasons trigger the truncation retry', async () => {
    assert.equal(isLengthFinishReason('length'), true);
    assert.equal(isLengthFinishReason('max_tokens'), true);
    assert.equal(isLengthFinishReason('MAX_TOKENS'), true);
    assert.equal(isLengthFinishReason('stop'), false);

    // Anthropic: stop_reason='max_tokens'
    seedProfile();
    const anthropicCalls = [];
    respond = (request) => {
        anthropicCalls.push(request);
        if (anthropicCalls.length === 1) {
            return jsonResponse({
                content: [{ type: 'text', text: '' }],
                stop_reason: 'max_tokens'
            });
        }
        return jsonResponse({
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn'
        });
    };
    const anthropicResult = await requestAI({
        model: 'personal-anthropic:m1',
        messages: [{ role: 'user', content: 'hi' }],
        taskType: 'default',
        maxTokens: 300
    });
    assert.equal(anthropicResult.text, 'ok');
    assert.equal(anthropicCalls.length, 2);
    assert.equal(anthropicCalls[1].body.max_tokens, 600);

    // Gemini: finishReason='MAX_TOKENS'
    seedProfile();
    const geminiCalls = [];
    respond = (request) => {
        geminiCalls.push(request);
        if (geminiCalls.length === 1) {
            return jsonResponse({
                candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'MAX_TOKENS' }]
            });
        }
        return jsonResponse({
            candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }]
        });
    };
    const geminiResult = await requestAI({
        model: 'personal-gemini:m1',
        messages: [{ role: 'user', content: 'hi' }],
        taskType: 'default',
        maxTokens: 300
    });
    assert.equal(geminiResult.text, 'ok');
    assert.equal(geminiCalls.length, 2);
    assert.equal(geminiCalls[0].body.generationConfig.maxOutputTokens, 300);
    assert.equal(geminiCalls[1].body.generationConfig.maxOutputTokens, 600);
});

// Without a caller-supplied maxTokens the adapters compute the outbound budget
// themselves (Anthropic thinking lift, Gemini budget + answer reserve). A
// truncation retry must grow from that wire value, not from the missing input.
test('truncation doubles the adapter outbound budget when the caller gave no maxTokens', async () => {
    // Anthropic high: max_tokens is lifted to 8192 + 1024.
    seedProfile();
    const anthropicCalls = [];
    respond = (request) => {
        anthropicCalls.push(request);
        if (anthropicCalls.length === 1) {
            return jsonResponse({ content: [{ type: 'text', text: '' }], stop_reason: 'max_tokens' });
        }
        return jsonResponse({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' });
    };
    const anthropicResult = await requestAI({
        model: 'personal-anthropic:m1',
        messages: [{ role: 'user', content: 'hi' }],
        taskType: 'default',
        thinking: 'high'
    });
    assert.equal(anthropicResult.text, 'ok');
    assert.equal(anthropicCalls.length, 2, 'a high-thinking truncation must be retried');
    assert.equal(anthropicCalls[0].body.max_tokens, 8192 + 1024);
    assert.ok(anthropicCalls[1].body.max_tokens > anthropicCalls[0].body.max_tokens);
    assert.equal(anthropicCalls[1].body.thinking.budget_tokens, 8192);

    // Gemini 2.5 high: maxOutputTokens is budget + 1024.
    seedWithModels('personal-gemini', ['gemini-2.5-flash']);
    const geminiCalls = [];
    respond = (request) => {
        geminiCalls.push(request);
        if (geminiCalls.length === 1) {
            return jsonResponse({
                candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'MAX_TOKENS' }]
            });
        }
        return jsonResponse({
            candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }]
        });
    };
    const geminiResult = await requestAI({
        model: 'personal-gemini:gemini-2.5-flash',
        messages: [{ role: 'user', content: 'hi' }],
        taskType: 'default',
        thinking: 'high'
    });
    assert.equal(geminiResult.text, 'ok');
    assert.equal(geminiCalls.length, 2, 'a Gemini MAX_TOKENS must be retried too');
    assert.equal(geminiCalls[0].body.generationConfig.maxOutputTokens, 16384 + 1024);
    assert.ok(geminiCalls[1].body.generationConfig.maxOutputTokens
        > geminiCalls[0].body.generationConfig.maxOutputTokens);

    // Anthropic medium + caller 300: the first request already carries 5120,
    // so the old 4000 cap used to leave the retry at exactly the same value.
    seedProfile();
    const mediumCalls = [];
    respond = (request) => {
        mediumCalls.push(request);
        if (mediumCalls.length === 1) {
            return jsonResponse({ content: [{ type: 'text', text: '' }], stop_reason: 'max_tokens' });
        }
        return jsonResponse({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' });
    };
    const mediumResult = await requestAI({
        model: 'personal-anthropic:m1',
        messages: [{ role: 'user', content: 'hi' }],
        taskType: 'default',
        thinking: 'medium',
        maxTokens: 300
    });
    assert.equal(mediumResult.text, 'ok');
    assert.equal(mediumCalls.length, 2);
    assert.equal(mediumCalls[0].body.max_tokens, 4096 + 1024);
    assert.ok(mediumCalls[1].body.max_tokens > mediumCalls[0].body.max_tokens);
});

// A failed fallback retry must not swallow the event forever: the next request
// uses the remembered auto level and announces the downgrade once it succeeds.
test('a fallback event is emitted when the remembered auto request succeeds', async () => {
    seedWithModels('personal-chat', ['m-late-event']);
    const events = [];
    const onFallback = (event) => events.push(event.detail);
    win.addEventListener('bdc:ai-thinking-fallback', onFallback);
    const calls = [];
    try {
        respond = (request) => {
            calls.push(request);
            if (calls.length === 1) {
                return jsonResponse({ error: { message: 'reasoning_effort is not supported' } }, 400);
            }
            return jsonResponse({ error: { message: 'mock unauthorized' } }, 401);
        };
        const request = {
            model: 'personal-chat:m-late-event',
            messages: [{ role: 'user', content: 'hi' }],
            taskType: 'default',
            thinking: 'high',
            maxTokens: 300
        };
        await assert.rejects(() => requestAI(request), (error) => error.status === 401);
        assert.equal(events.length, 0, 'a failed retry must not announce a fallback');

        respond = (request) => {
            calls.push(request);
            return jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
        };
        const result = await requestAI(request);
        assert.equal(result.text, 'ok');
        assert.equal(calls.length, 3);
        assert.equal(Object.prototype.hasOwnProperty.call(calls[2].body, 'reasoning_effort'), false);
        assert.equal(events.length, 1, 'the remembered auto success must announce the fallback');
        assert.equal(events[0].level, 'high');
    } finally {
        win.removeEventListener('bdc:ai-thinking-fallback', onFallback);
    }
});

// The cache key records the requested thinking level; the outgoing request must
// use the same value instead of silently asking the provider for auto.
test('analysis requests send the thinking level used in their cache key', async () => {
    seedProfile();
    const loaded = profile.loadAIProfile(GUEST_SCOPE);
    loaded.taskThinking = { wordAnalysis: 'medium', articleWordTranslation: 'high' };
    loaded.taskModels = {
        ...loaded.taskModels,
        articleWordTranslation: 'personal-chat:m1',
        wordAnalysis: 'personal-chat:m1'
    };
    profile.saveAIProfile(loaded, GUEST_SCOPE);

    const calls = [];
    respond = (request) => {
        calls.push(request);
        const content = calls.length === 1
            ? JSON.stringify({
                word: 'alpha',
                sentence: 'beta gamma',
                analysis: { phonetic: '/a/', pos: 'n', meaning: '意思', role: '主語' }
            })
            : JSON.stringify({ phonetic: '/g/', pos: 'n', meaning: '意思' });
        return jsonResponse({ choices: [{ message: { content }, finish_reason: 'stop' }] });
    };

    const word = await analyzeWordInSentence('alpha', 'beta gamma');
    assert.equal(word.analysis.meaning, '意思');
    assert.equal(calls[0].body.reasoning_effort, 'high');

    const dictionary = await getWordAnalysis('gamma');
    assert.equal(dictionary.meaning, '意思');
    assert.equal(calls[1].body.reasoning_effort, 'medium');
});

// A reset (catalog/auth change) bumps the module generation. A delayed error
// from a request that started earlier may still finish, but it must not write
// an unsupported target into the fresh memory or announce a stale fallback.
test('a catalog reset during a rejected request does not poison the new memory', async () => {
    seedWithModels('personal-chat', ['m-reset-inflight']);
    const calls = [];
    const events = [];
    const onFallback = (event) => events.push(event.detail);
    win.addEventListener('bdc:ai-thinking-fallback', onFallback);
    try {
        let releaseFirst;
        const delayedRejection = new Promise((resolve) => { releaseFirst = resolve; });
        respond = (request) => {
            calls.push(request);
            if (calls.length === 1) return delayedRejection;
            return jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
        };
        const request = {
            model: 'personal-chat:m-reset-inflight',
            messages: [{ role: 'user', content: 'hi' }],
            taskType: 'default',
            thinking: 'high',
            maxTokens: 300
        };
        const pending = requestAI(request);
        const started = Date.now();
        while (calls.length === 0) {
            if (Date.now() - started > 2000) throw new Error('request did not start');
            await new Promise((resolve) => setTimeout(resolve, 5));
        }

        // Reset while the provider's 400 is still in flight.
        win.dispatchEvent(new CustomEvent('bdc:ai-catalog-change', { detail: {} }));
        releaseFirst(jsonResponse({ error: { message: 'reasoning_effort is not supported' } }, 400));
        const first = await pending;
        assert.equal(first.text, 'ok');
        assert.equal(calls.length, 2, 'the old request may still complete its own fallback retry');
        assert.equal(Object.prototype.hasOwnProperty.call(calls[1].body, 'reasoning_effort'), false);
        assert.equal(events.length, 0, 'a stale generation must not announce a fallback');

        // The new generation has no memory: high must be attempted again.
        respond = (request) => {
            calls.push(request);
            return jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
        };
        const second = await requestAI(request);
        assert.equal(second.text, 'ok');
        assert.equal(calls.length, 3);
        assert.equal(calls[2].body.reasoning_effort, 'high', 'the reset request must probe thinking again');
    } finally {
        win.removeEventListener('bdc:ai-thinking-fallback', onFallback);
    }
});

// If the endpoint changes while a thinking request is in flight, the fallback
// retry must stay on the endpoint that rejected the parameter and remember the
// capability for that endpoint only.
test('a thinking fallback retry stays on the endpoint that rejected it', async () => {
    seedWithModels('personal-chat', ['m-pinned']);
    const calls = [];
    const events = [];
    const onFallback = (event) => events.push(event.detail);
    win.addEventListener('bdc:ai-thinking-fallback', onFallback);
    const endpointB = 'https://chat-b.mock/v1/chat/completions';
    const modelsB = 'https://chat-b.mock/v1/models';
    try {
        respond = (request) => {
            calls.push(request);
            if (calls.length === 1) {
                // The user edits the profile while endpoint A's request is in
                // flight; the provider then rejects the thinking parameter.
                const loaded = profile.loadAIProfile(GUEST_SCOPE);
                loaded.providers['personal-chat'].apiUrl = endpointB;
                loaded.providers['personal-chat'].modelsUrl = modelsB;
                loaded.credentials['personal-chat'].binding.apiUrl = endpointB;
                loaded.credentials['personal-chat'].binding.modelsUrl = modelsB;
                profile.saveAIProfile(loaded, GUEST_SCOPE);
                return jsonResponse({ error: { message: 'reasoning_effort is not supported' } }, 400);
            }
            if (Object.prototype.hasOwnProperty.call(request.body, 'reasoning_effort')) {
                return jsonResponse({ error: { message: 'reasoning_effort is not supported' } }, 400);
            }
            return jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
        };
        const request = {
            model: 'personal-chat:m-pinned',
            messages: [{ role: 'user', content: 'hi' }],
            taskType: 'default',
            thinking: 'high',
            maxTokens: 300
        };
        const first = await requestAI(request);
        assert.equal(first.text, 'ok');
        assert.equal(calls.length, 2);
        assert.match(calls[0].url, /chat\.mock/);
        assert.equal(calls[1].url, calls[0].url, 'the fallback retry was re-resolved to endpoint B');
        assert.equal(Object.prototype.hasOwnProperty.call(calls[1].body, 'reasoning_effort'), false);
        assert.equal(events.length, 1);

        // A following request now resolves B. B was never marked unsupported,
        // so it must receive the high level and announce its own fallback.
        const second = await requestAI(request);
        assert.equal(second.text, 'ok');
        assert.equal(calls.length, 4);
        assert.match(calls[2].url, /chat-b\.mock/);
        assert.equal(calls[2].body.reasoning_effort, 'high');
        assert.equal(Object.prototype.hasOwnProperty.call(calls[3].body, 'reasoning_effort'), false);
        assert.equal(events.length, 2, 'endpoint B has its own notified state');
    } finally {
        win.removeEventListener('bdc:ai-thinking-fallback', onFallback);
    }
});
