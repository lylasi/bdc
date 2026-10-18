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

const { requestAI, streamAIResponse } = await import('../modules/api.js');
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
