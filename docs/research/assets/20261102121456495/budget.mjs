import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeCases, runOne } from './benchmark.mjs';

const folder = dirname(fileURLToPath(import.meta.url));
const selected = makeCases().filter((item) => ['word-sanction', 'syntax-inversion'].includes(item.id));
const budgets = { 'word-sanction': 520, 'syntax-inversion': 1100 };
const records = [];
await writeFile(join(folder, 'budget.jsonl.manifest.json'), JSON.stringify({ note: 'BDC production-like caps from analyzeWordInSentence/analyzeSentence. Same messages as the main comparison. One doubled-budget retry only on a length stop, as requestAI currently does. This is a separate completeness check, excluded from the main speed table.', cases: selected, budgets, repeats: 2, modes: ['none', 'high'] }, null, 2) + '\n');
for (let repeat = 1; repeat <= 2; repeat += 1) {
    for (const original of selected) {
        const order = repeat === 1 ? ['none', 'high'] : ['high', 'none'];
        for (const mode of order) {
            const key = `${original.id}|${mode}|${repeat}`;
            let budget = budgets[original.id];
            let totalMs = 0;
            for (let attempt = 1; attempt <= 2; attempt += 1) {
                const testCase = { ...original, maxTokens: budget };
                console.log(JSON.stringify({ event: 'start', key, attempt, budget }));
                const row = { ...await runOne({ endpoint: 'http://127.0.0.1:3425/v1/chat/completions', model: 'workbuddy/deepseek-v4.1-flash', mode, testCase }), label: 'budget', repeat, attempt, pairKey: key };
                totalMs += row.totalMs;
                row.cumulativeMs = totalMs;
                await appendFile(join(folder, 'budget.jsonl'), JSON.stringify(row) + '\n');
                records.push(row);
                console.log(JSON.stringify({ event: 'done', key, attempt, budget, ok: row.ok, error: row.error, finishReason: row.finishReason, totalSeconds: row.totalMs / 1000, completionTokens: row.usage?.completion_tokens }));
                if (row.finishReason !== 'length' || attempt === 2) break;
                budget = Math.min(budget * 2, 4000);
            }
        }
    }
}
await writeFile(join(folder, 'budget-summary.json'), JSON.stringify(records.filter((row, i) => i === records.length - 1 || records[i + 1].pairKey !== row.pairKey).map((row) => ({ caseId: row.caseId, mode: row.mode, repeat: row.repeat, attempts: row.attempt, finalOk: row.ok, finalError: row.error, finalBudget: row.requestedMaxTokens, cumulativeMs: row.cumulativeMs })), null, 2) + '\n');
console.log(JSON.stringify({ event: 'complete', requests: records.length }));
