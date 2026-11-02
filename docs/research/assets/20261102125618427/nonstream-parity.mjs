import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectionFor } from './channels.mjs';
import { runOne } from './bench-lib.mjs';

const folder = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(await readFile(join(folder, 'main.jsonl.manifest.json'), 'utf8'));
const tasks = manifest.cases.filter((task) => ['word-bank', 'translation-library'].includes(task.id));
const targets = manifest.targets.filter((target) => ['hapi-grok420', 'hapi-grok43', 'magpie-deepseek', 'magpie-gpt'].includes(target.id));
const out = join(folder, 'nonstream-parity.jsonl');
const existing = await readFile(out, 'utf8').catch((error) => { if (error.code === 'ENOENT') return ''; throw error; });
const records = existing.trim() ? existing.trim().split('\n').map(JSON.parse) : [];
const key = (r) => [r.targetId, r.caseId, r.mode].join('|');
const completed = new Set(records.map(key));
await writeFile(`${out}.manifest.json`, JSON.stringify({ transport: 'nonstream', note: 'Match the app one-shot adapter: omit stream and stream_options, Accept application/json. Same messages and max_tokens as the main study. Separate from streaming timing tables.', targets, cases: tasks, hapiModes: ['default', 'none', 'high'], controlModes: ['none', 'high'] }, null, 2) + '\n');
for (const target of targets) {
    const connection = await connectionFor(target.channel);
    for (const task of tasks) {
        for (const mode of target.channel === 'HAPI' ? ['default', 'none', 'high'] : ['none', 'high']) {
            if (completed.has(key({ targetId: target.id, caseId: task.id, mode }))) continue;
            console.log(JSON.stringify({ event: 'start', targetId: target.id, caseId: task.id, mode, transport: 'nonstream' }));
            const row = { ...await runOne({ ...connection, channel: target.channel, model: target.model, mode, testCase: task, transport: 'nonstream' }), targetId: target.id, phase: 'nonstream-parity', repeat: 1 };
            await appendFile(out, JSON.stringify(row) + '\n');
            records.push(row);
            console.log(JSON.stringify({ event: 'done', targetId: target.id, caseId: task.id, mode, ok: row.ok, seconds: row.totalMs / 1000, responseType: row.responseType, reasoningTokens: row.reasoningTokens, reasoningChars: row.reasoningChars, error: row.error }));
        }
    }
}
await writeFile(`${out}.status.json`, JSON.stringify({ requests: records.length, successful: records.filter((r) => r.ok).length, completedAt: new Date().toISOString() }, null, 2) + '\n');
console.log(JSON.stringify({ event: 'complete', requests: records.length, successful: records.filter((r) => r.ok).length }));
