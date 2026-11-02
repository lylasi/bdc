import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { hapiConnection } from './channels.mjs';
import { runOne } from './bench-lib.mjs';

const folder = dirname(fileURLToPath(import.meta.url));
const connection = await hapiConnection();
const metadata = { at: new Date().toISOString(), note: 'Post-measurement health diagnostics, not included in latency or quality rankings. May run alongside quality judges after timing is complete.' };
for (const path of ['/v1/models', '/api/usage/token']) {
    try {
        const response = await fetch(new URL(path, connection.endpoint), { headers: { ...connection.headers, Accept: 'application/json', 'User-Agent': 'BDC-Reasoning-Benchmark/2.0' }, signal: AbortSignal.timeout(10000) });
        const entry = { path, status: response.status };
        if (response.ok) {
            const json = await response.json();
            if (path === '/v1/models') entry.modelIds = (json.data || []).map((item) => item.id);
            else {
                const data = json.data && typeof json.data === 'object' ? json.data : json;
                entry.fieldNames = Object.keys(data);
                entry.positiveRemainingFields = Object.fromEntries(['total_available', 'remaining_quota', 'remain_quota', 'quota'].filter((name) => typeof data[name] === 'number').map((name) => [name, data[name] > 0]));
                entry.applicationSuccess = json.success ?? json.status ?? null;
            }
        }
        metadata[path] = entry;
    } catch (error) { metadata[path] = { errorType: error.name }; }
}
const messages = [{ role: 'user', content: 'Reply with exactly the word OK. No explanation.' }];
const task = { id: 'health-ok', category: 'health', messages, maxTokens: 64, json: false, responseFormat: false, promptHash: createHash('sha256').update(JSON.stringify(messages)).digest('hex') };
const existing = await readFile(join(folder, 'health.jsonl'), 'utf8').catch((error) => { if (error.code === 'ENOENT') return ''; throw error; });
const rows = existing.trim() ? existing.trim().split('\n').map(JSON.parse) : [];
for (const model of ['grok-4.20-fast', 'grok-4.3-fast', 'grok-chat-fast']) {
    if (rows.some((row) => row.model === model)) continue;
    const row = { ...await runOne({ ...connection, channel: 'HAPI', model, mode: 'default', testCase: task, transport: 'nonstream', timeoutMs: 15000 }), phase: 'health' };
    await appendFile(join(folder, 'health.jsonl'), JSON.stringify(row) + '\n');
    rows.push(row);
    console.log(JSON.stringify({ model, ok: row.ok, answer: row.answer, error: row.error, seconds: row.totalMs / 1000 }));
}
metadata.generationChecks = rows.map((row) => ({ model: row.model, ok: row.ok, answer: row.answer, error: row.error }));
await writeFile(join(folder, 'health-summary.json'), JSON.stringify(metadata, null, 2) + '\n');
console.log(JSON.stringify(metadata));
