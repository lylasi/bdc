import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { hapiConnection } from './channels.mjs';
import { runOne } from './bench-lib.mjs';

const folder = dirname(fileURLToPath(import.meta.url));
const out = join(folder, 'health-final.jsonl');
const saved = await readFile(out, 'utf8').catch((error) => { if (error.code === 'ENOENT') return ''; throw error; });
const results = saved.trim() ? saved.trim().split('\n').map(JSON.parse) : [];
const connection = await hapiConnection();
const messages = [{ role: 'user', content: 'Reply with exactly the word OK. No explanation.' }];
const task = { id: 'health-ok-final', category: 'health', messages, maxTokens: 64, json: false, responseFormat: false, promptHash: createHash('sha256').update(JSON.stringify(messages)).digest('hex') };
for (const model of ['grok-4.20-fast', 'grok-4.3-fast', 'grok-chat-fast']) {
    if (results.some((r) => r.model === model)) continue;
    const result = { ...await runOne({ ...connection, channel: 'HAPI', model, mode: 'default', testCase: task, transport: 'nonstream', timeoutMs: 15000 }), phase: 'health-final' };
    result.matchesExpectedOK = /^OK[.!。！]?$/i.test(result.answer.trim());
    result.functionalHealthy = result.ok && result.matchesExpectedOK;
    await appendFile(out, JSON.stringify(result) + '\n');
    results.push(result);
    console.log(JSON.stringify({ model, transportOK: result.ok, functionalHealthy: result.functionalHealthy, error: result.error, answerChars: result.answer.length }));
}
await writeFile(join(folder, 'health-final-summary.json'), JSON.stringify({ checkedAt: new Date().toISOString(), note: 'Final post-cooldown check. Separate from model quality/latency rankings; previous failures are retained.', checks: results.map((r) => ({ model: r.model, ok: r.ok, matchesExpectedOK: r.matchesExpectedOK, functionalHealthy: r.functionalHealthy, answerChars: r.answer.length, error: r.error })) }, null, 2) + '\n');
