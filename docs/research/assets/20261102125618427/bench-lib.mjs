import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { createSseParser } from '../../../../modules/ai-protocols/common.js';
import { makeBody } from '../20261102121456495/benchmark.mjs';

export { makeBody };

export function isTransportFailure(row) {
    return !row.ok && !['empty_answer', 'invalid_json_or_schema', 'truncated'].includes(row.error);
}

export function visibleContent(raw) {
    let text = '';
    let reasoningChars = 0;
    let cursor = 0;
    const open = /<(think|thinking)>/ig;
    while (true) {
        open.lastIndex = cursor;
        const found = open.exec(raw);
        if (!found) { text += raw.slice(cursor); break; }
        text += raw.slice(cursor, found.index);
        const start = open.lastIndex;
        const closing = new RegExp(`</${found[1]}>`, 'ig');
        closing.lastIndex = start;
        const end = closing.exec(raw);
        if (!end) { reasoningChars += raw.length - start; cursor = raw.length; break; }
        reasoningChars += end.index - start;
        cursor = closing.lastIndex;
    }
    for (let size = Math.min(10, text.length); size > 0; size -= 1) {
        const suffix = text.slice(-size).toLowerCase();
        if (['<think>', '<thinking>'].some((tag) => tag.startsWith(suffix)) && suffix.startsWith('<')) {
            text = text.slice(0, -size);
            break;
        }
    }
    return { text, reasoningChars };
}

function textOf(value) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map((part) => typeof part === 'string' ? part : part?.text || '').join('');
    return '';
}

function jsonInfo(answer, task) {
    if (!task.json) return { jsonValid: null, strictJsonValid: null, schemaValid: null };
    let parsed;
    let strictJsonValid = true;
    try { parsed = JSON.parse(answer); } catch (_) {
        strictJsonValid = false;
        try { parsed = JSON.parse(answer.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()); } catch (_) {
            return { jsonValid: false, strictJsonValid: false, schemaValid: false };
        }
    }
    const arrays = new Set(task.arrayFields || ['phrase_alignment', 'chunks', 'key_points', 'reviews']);
    const schemaValid = !!parsed && typeof parsed === 'object' && !Array.isArray(parsed) && (task.requiredFields || []).every((path) => {
        const value = path.split('.').reduce((obj, key) => obj?.[key], parsed);
        return arrays.has(path) ? Array.isArray(value) : typeof value === 'string' && value.trim().length > 0;
    });
    return { jsonValid: true, strictJsonValid, schemaValid };
}

function redact(value, headers) {
    let text = String(value || '');
    for (const raw of Object.values(headers || {})) {
        if (typeof raw !== 'string') continue;
        const values = [raw, raw.replace(/^Bearer\s+/i, '')].filter((item) => item.length >= 8);
        for (const secret of values) text = text.replaceAll(secret, '[redacted]');
    }
    return text.slice(0, 900);
}

export async function runOne({ endpoint, channel, model, mode, testCase, timeoutMs = 90000, headers = {}, bodyPatch = {}, transport = 'stream' }) {
    const start = performance.now();
    const elapsed = () => Math.round((performance.now() - start) * 10) / 10;
    const body = { ...makeBody({ model, mode, testCase }), ...bodyPatch };
    if (transport === 'nonstream') {
        delete body.stream;
        delete body.stream_options;
    }
    const result = { startedAt: new Date().toISOString(), channel, model, mode, transport, caseId: testCase.id, category: testCase.category, promptHash: testCase.promptHash, bodyHash: createHash('sha256').update(JSON.stringify(body)).digest('hex'), requestedMaxTokens: testCase.maxTokens, requestParameters: { reasoning_effort: body.reasoning_effort ?? null, temperature: body.temperature, stream: body.stream ?? 'omitted', response_format: body.response_format || null }, responseType: null, headerMs: null, firstOutputMs: null, firstReasoningMs: null, firstAnswerMs: null, totalMs: null, reasoningChars: 0, reasoningTokens: null, answer: '', finishReason: '', done: false, usage: null, httpStatus: null, error: null, serverModels: [] };
    let rawContent = '';
    let separateThoughtChars = 0;
    let reader;
    const ingest = (event) => {
        if (!event.data) return;
        if (event.data.trim() === '[DONE]') { result.done = true; return; }
        let json;
        try { json = JSON.parse(event.data); } catch (_) { result.error ||= 'invalid_sse_json'; return; }
        if (event.event === 'error' || json.error) result.error = redact(json.error?.message || json.message || json.error || 'sse_error', headers);
        if (json.model && !result.serverModels.includes(json.model)) result.serverModels.push(json.model);
        if (json.usage) result.usage = json.usage;
        const choice = json.choices?.[0];
        const delta = choice?.delta || choice?.message || {};
        const thought = textOf(delta.reasoning_content) || textOf(delta.reasoning);
        separateThoughtChars += thought.length;
        rawContent += textOf(delta.content);
        const visible = visibleContent(rawContent);
        result.reasoningChars = separateThoughtChars + visible.reasoningChars;
        result.answer = visible.text;
        if (result.reasoningChars > 0) {
            result.firstReasoningMs ??= elapsed();
            result.firstOutputMs ??= elapsed();
        }
        if (result.answer.trim()) {
            result.firstAnswerMs ??= elapsed();
            result.firstOutputMs ??= elapsed();
        }
        if (choice?.finish_reason) result.finishReason = choice.finish_reason;
    };
    try {
        const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: transport === 'nonstream' ? 'application/json' : 'text/event-stream', 'User-Agent': 'BDC-Reasoning-Benchmark/2.0', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
        result.headerMs = elapsed();
        result.httpStatus = response.status;
        result.responseType = response.headers.get('content-type') || '';
        if (!response.ok) result.error = `HTTP ${response.status}: ${redact(await response.text(), headers)}`;
        else if (!(response.headers.get('content-type') || '').includes('text/event-stream')) ingest({ data: JSON.stringify(await response.json()) });
        else {
            reader = response.body.getReader();
            const decoder = new TextDecoder();
            const parser = createSseParser();
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                for (const event of parser.push(decoder.decode(value, { stream: true }))) ingest(event);
                if (result.done || result.error) break;
            }
            for (const event of parser.push(decoder.decode())) ingest(event);
            for (const event of parser.flush()) ingest(event);
        }
    } catch (error) {
        result.error = ['TimeoutError', 'AbortError'].includes(error?.name) ? 'timeout' : redact(error?.message || error, headers);
    } finally {
        result.totalMs = elapsed();
        try { await reader?.cancel(); } catch (_) {}
    }
    const reported = result.usage?.completion_tokens_details?.reasoning_tokens
        ?? result.usage?.output_tokens_details?.reasoning_tokens
        ?? result.usage?.completion_thinking_tokens
        ?? result.usage?.thoughtsTokenCount;
    result.reasoningTokens = typeof reported === 'number' && Number.isFinite(reported) && reported >= 0 ? reported : null;
    result.truncated = ['length', 'max_tokens', 'MAX_TOKENS'].includes(result.finishReason);
    if (result.truncated) result.error ||= 'truncated';
    if (!result.error && !result.done && !result.finishReason) result.error = 'incomplete_stream';
    if (!result.error && !result.answer.trim()) result.error = 'empty_answer';
    Object.assign(result, jsonInfo(result.answer, testCase));
    if (!result.error && testCase.json && !result.schemaValid) result.error = 'invalid_json_or_schema';
    result.ok = !result.error;
    return result;
}
