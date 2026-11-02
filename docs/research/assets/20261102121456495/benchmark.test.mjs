import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { runOne, makeBody } from './benchmark.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const testCase = { id: 'fixture', category: 'word', messages: [{ role: 'user', content: 'Translate bank.' }], maxTokens: 4096, json: true };

async function serve(handler, callback) {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
        await callback(`http://127.0.0.1:${server.address().port}`);
    } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
}

const frame = (value) => `data: ${JSON.stringify(value)}\n\n`;

test('reasoning and role events do not count as the first answer; usage is retained without thought text', async () => {
    await serve(async (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(frame({ choices: [{ delta: { role: 'assistant' } }] }));
        await sleep(20);
        res.write(frame({ choices: [{ delta: { reasoning_content: 'private fixture reasoning' } }] }));
        await sleep(50);
        res.write(frame({ choices: [{ delta: { content: '{"meaning":"银行"}' } }] }));
        res.write(frame({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { completion_tokens: 32, completion_tokens_details: { reasoning_tokens: 16 } } }));
        res.end('data: [DONE]\n\n');
    }, async (endpoint) => {
        const result = await runOne({ endpoint, model: 'fixture', mode: 'high', testCase });
        assert.equal(result.ok, true);
        assert.equal(result.answer, '{"meaning":"银行"}');
        assert.equal(result.reasoningChars, 'private fixture reasoning'.length);
        assert.ok(result.firstAnswerMs >= result.firstReasoningMs + 25);
        assert.equal(result.jsonValid, true);
        assert.equal(result.usage.completion_tokens_details.reasoning_tokens, 16);
        assert.ok(!JSON.stringify(result).includes('private fixture reasoning'));
    });
});

test('a severed stream retains the partial answer and is excluded from success', async () => {
    await serve((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(frame({ choices: [{ delta: { content: '{"meaning":' } }] }));
    }, async (endpoint) => {
        const result = await runOne({ endpoint, model: 'fixture', mode: 'none', testCase });
        assert.equal(result.ok, false);
        assert.equal(result.error, 'incomplete_stream');
        assert.equal(result.answer, '{"meaning":');
        assert.equal(result.jsonValid, false);
    });
});

test('an SSE error after HTTP 200 remains a failure even with a partial answer', async () => {
    await serve((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(frame({ choices: [{ delta: { content: 'partial' } }] }));
        res.write('event: error\n' + frame({ error: { message: 'fixture upstream failure' } }));
        res.end('data: [DONE]\n\n');
    }, async (endpoint) => {
        const result = await runOne({ endpoint, model: 'fixture', mode: 'high', testCase });
        assert.equal(result.ok, false);
        assert.match(result.error, /fixture upstream failure/);
        assert.equal(result.answer, 'partial');
    });
});

test('a length stop is reported as truncation; a done marker alone cannot make it successful', async () => {
    await serve((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(frame({ choices: [{ delta: { content: '{}' }, finish_reason: 'length' }] }));
        res.end('data: [DONE]\n\n');
    }, async (endpoint) => {
        const result = await runOne({ endpoint, model: 'fixture', mode: 'high', testCase });
        assert.equal(result.ok, false);
        assert.equal(result.truncated, true);
        assert.equal(result.error, 'truncated');
    });
});

test('the omitted baseline and the A/B pair differ only by reasoning_effort', () => {
    const baseline = makeBody({ model: 'fixture', mode: 'default', testCase });
    const off = makeBody({ model: 'fixture', mode: 'none', testCase });
    const on = makeBody({ model: 'fixture', mode: 'high', testCase });
    assert.equal(Object.hasOwn(baseline, 'reasoning_effort'), false);
    assert.equal(off.reasoning_effort, 'none');
    assert.equal(on.reasoning_effort, 'high');
    delete off.reasoning_effort;
    delete on.reasoning_effort;
    assert.deepEqual(off, baseline);
    assert.deepEqual(on, baseline);
});
