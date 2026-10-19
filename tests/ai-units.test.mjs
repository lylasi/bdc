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
const { decideCredentialAction } = await import('../modules/ai-credential-sync.js');
const { evaluateReplay, isValidProviderId } = await import('../cloudflare-worker/src/ai-credentials.js');
const { normalizeCredential, normalizeStoredProvider } = await import('../modules/ai-profile-storage.js');

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

test('stream event parsing works for every protocol', () => {
    assert.deepEqual(chat.parseStreamEvent({ data: JSON.stringify({ choices: [{ delta: { content: 'a' } }] }) }), {
        text: 'a', finishReason: '', done: false
    });
    assert.equal(chat.parseStreamEvent({ data: '[DONE]' }).done, true);

    assert.deepEqual(anthropic.parseStreamEvent({ data: JSON.stringify({ type: 'content_block_delta', delta: { text: 'b' } }) }), {
        text: 'b', done: false
    });
    assert.equal(anthropic.parseStreamEvent({ data: JSON.stringify({ type: 'message_stop' }) }).done, true);

    const gem = gemini.parseStreamEvent({ data: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'c' }] } }] }) });
    assert.deepEqual(gem, { text: 'c', finishReason: '', done: false });
    const blocked = gemini.parseStreamEvent({ data: JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }) });
    assert.equal(blocked.done, true);
    assert.equal(blocked.refusal, 'SAFETY');
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
