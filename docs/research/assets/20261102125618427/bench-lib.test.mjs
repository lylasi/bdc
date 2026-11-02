import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { runOne, visibleContent, isTransportFailure } from './bench-lib.mjs';

const task = { id: 'fixture', category: 'word', messages: [{ role: 'user', content: 'Translate bank.' }], maxTokens: 8192, json: true, requiredFields: ['meaning'] };
const frame = (value) => `data: ${JSON.stringify(value)}\n\n`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function serve(handler, callback) {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try { await callback(`http://127.0.0.1:${server.address().port}`); }
    finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}

test('auth reaches only the request headers and never the saved result or echoed errors', async () => {
    const secret = 'fixture-private-key-123456';
    await serve((req, res) => {
        assert.equal(req.headers.authorization, `Bearer ${secret}`);
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `bad key: ${secret}` } }));
    }, async (endpoint) => {
        const result = await runOne({ endpoint, channel: 'HAPI', model: 'fixture', mode: 'none', headers: { Authorization: `Bearer ${secret}` }, testCase: task });
        assert.equal(result.ok, false);
        assert.equal(result.httpStatus, 401);
        assert.ok(!JSON.stringify(result).includes(secret));
        assert.match(result.error, /redacted/);
    });
});

test('role and split inline thought tags cannot become answer text or first-answer time', async () => {
    await serve(async (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(frame({ choices: [{ delta: { role: 'assistant', content: '<thi' } }] }));
        await sleep(20);
        res.write(frame({ choices: [{ delta: { content: 'nk>fixture private thought' } }] }));
        await sleep(50);
        res.write(frame({ choices: [{ delta: { content: '</think>{"meaning":"银行"}' } }] }));
        res.write(frame({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { completion_tokens: 30, completion_tokens_details: { reasoning_tokens: 10 } } }));
        res.end('data: [DONE]\n\n');
    }, async (endpoint) => {
        const result = await runOne({ endpoint, channel: 'fixture', model: 'fixture', mode: 'high', testCase: task });
        assert.equal(result.ok, true);
        assert.equal(result.answer, '{"meaning":"银行"}');
        assert.ok(result.firstAnswerMs >= result.firstReasoningMs + 25);
        assert.equal(result.reasoningTokens, 10);
        assert.ok(!JSON.stringify(result).includes('fixture private thought'));
    });
});

test('missing token evidence is null, rather than an invented zero', async () => {
    await serve((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(frame({ choices: [{ delta: { content: '{"meaning":"银行"}' }, finish_reason: 'stop' }] }));
        res.end('data: [DONE]\n\n');
    }, async (endpoint) => {
        const result = await runOne({ endpoint, channel: 'fixture', model: 'fixture', mode: 'none', testCase: task });
        assert.equal(result.ok, true);
        assert.equal(result.reasoningTokens, null);
    });
});

test('HTTP 200 SSE errors and truncated streams stay excluded from success', async () => {
    await serve((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(frame({ choices: [{ delta: { content: '{"meaning":' } }] }));
        res.write(frame({ error: { message: 'fixture upstream exhausted' } }));
        res.end('data: [DONE]\n\n');
    }, async (endpoint) => {
        const result = await runOne({ endpoint, channel: 'fixture', model: 'fixture', mode: 'high', testCase: task });
        assert.equal(result.ok, false);
        assert.match(result.error, /upstream exhausted/);
    });
    await serve((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(frame({ choices: [{ delta: { content: '{}' }, finish_reason: 'length' }] }));
        res.end('data: [DONE]\n\n');
    }, async (endpoint) => {
        const result = await runOne({ endpoint, channel: 'fixture', model: 'fixture', mode: 'high', testCase: task });
        assert.equal(result.ok, false);
        assert.equal(result.truncated, true);
    });
});

test('inline thought splitting handles complete, unclosed and partial tags without leaking them', () => {
    assert.deepEqual(visibleContent('<think>private</think>answer'), { text: 'answer', reasoningChars: 7 });
    assert.deepEqual(visibleContent('<thinking>private'), { text: '', reasoningChars: 7 });
    assert.deepEqual(visibleContent('<thi'), { text: '', reasoningChars: 0 });
    assert.equal(visibleContent('answer').text, 'answer');
});

test('nonstream matches the app: omit stream fields, request JSON and parse its usage', async () => {
    let observed;
    await serve(async (req, res) => {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        observed = { body: JSON.parse(raw), accept: req.headers.accept };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: '{"meaning":"银行"}' }, finish_reason: 'stop' }], usage: { completion_tokens_details: { reasoning_tokens: 0 } } }));
    }, async (endpoint) => {
        const result = await runOne({ endpoint, channel: 'fixture', model: 'fixture', mode: 'none', testCase: task, transport: 'nonstream' });
        assert.equal(result.ok, true);
        assert.equal(observed.accept, 'application/json');
        assert.equal(Object.hasOwn(observed.body, 'stream'), false);
        assert.equal(Object.hasOwn(observed.body, 'stream_options'), false);
        assert.equal(result.reasoningTokens, 0);
        assert.equal(result.transport, 'nonstream');
        assert.match(result.responseType, /application\/json/);
    });
});

test('content failures remain measurements; only transport failures trigger route quarantine', () => {
    assert.equal(isTransportFailure({ ok: false, httpStatus: 200, error: 'empty_answer' }), false);
    assert.equal(isTransportFailure({ ok: false, httpStatus: 200, error: 'invalid_json_or_schema' }), false);
    assert.equal(isTransportFailure({ ok: false, httpStatus: 200, error: 'truncated' }), false);
    assert.equal(isTransportFailure({ ok: false, httpStatus: 200, error: 'timeout' }), true);
    assert.equal(isTransportFailure({ ok: false, httpStatus: 401, error: 'HTTP 401' }), true);
    assert.equal(isTransportFailure({ ok: true, httpStatus: 200, error: null }), false);
});
