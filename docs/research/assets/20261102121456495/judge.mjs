import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeCases, runOne } from './benchmark.mjs';

const folder = dirname(fileURLToPath(import.meta.url));
const cases = makeCases();
const mainRows = (await readFile(join(folder, 'main.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
let packets;
let map;
try {
    packets = JSON.parse(await readFile(join(folder, 'blind-packets.json'), 'utf8'));
    map = JSON.parse(await readFile(join(folder, 'blind-map.json'), 'utf8'));
} catch (error) {
    if (error.code !== 'ENOENT') throw error;
    map = [];
    packets = cases.map((testCase) => {
        const answers = mainRows.filter((row) => row.caseId === testCase.id).map((row) => {
            const id = `A${randomUUID().slice(0, 8)}`;
            map.push({ id, model: row.model, mode: row.mode, repeat: row.repeat, caseId: row.caseId, promptHash: row.promptHash, answerHash: createHash('sha256').update(row.answer).digest('hex') });
            return { id, answer: row.answer };
        }).sort((a, b) => a.id.localeCompare(b.id));
        return { caseId: testCase.id, originalMessages: testCase.messages, rubric: testCase.rubric, answers };
    });
    await writeFile(join(folder, 'blind-packets.json'), JSON.stringify(packets, null, 2) + '\n');
    await writeFile(join(folder, 'blind-map.json'), JSON.stringify(map, null, 2) + '\n');
}

if (process.argv.includes('--pack-only')) {
    console.log(`Prepared ${packets.length} blind packets, ${map.length} answers.`);
    process.exit(0);
}

const system = `You are evaluating English-learning answers for correctness and usefulness. You will receive the original task, a five-point rubric, and anonymous candidate answers. Each answer is an independent response to the same task. The labels carry no information about the model, settings or timing.\n\nApply the stated rubric only. Do not reward length or fancy language. Accept equivalent accurate wording, Chinese or English part-of-speech abbreviations, and reasonable alternative translations. Check concrete grammar, numbers and context. Do not invent a requirement absent from the original task. A Markdown heading may be translated if its emphasis markers are preserved. A terse answer that satisfies the task can earn full points. Distinguish minor imprecision (half point deduction) from a substantive wrong answer.\n\nEach rubric item begins with its maximum points, usually 1 and sometimes 2. Award 0, 0.5, 1, 1.5 or 2 as appropriate, never above that item's maximum. Return one review for EVERY answer id, with criteria in rubric order, total equal to their sum, and concise Chinese issues explaining each deduction. If full marks, issues must be an empty array. Do not compare which answer is longer. Do not reveal any internal reasoning. Return only strict JSON with this shape: {"reviews":[{"id":"A...","criteria":[1,1,1,1,1],"total":5,"issues":[]}]}.`;
const existing = await readFile(join(folder, 'judge.jsonl'), 'utf8').catch((error) => { if (error.code === 'ENOENT') return ''; throw error; });
const rows = existing.trim() ? existing.trim().split('\n').map(JSON.parse) : [];
const completed = new Set(rows.filter((row) => row.ok).map((row) => row.caseId));

for (const packet of packets) {
    if (completed.has(`judge-${packet.caseId}`)) continue;
    const messages = [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(packet) }];
    const testCase = { id: `judge-${packet.caseId}`, category: 'judge', messages, maxTokens: 8192, json: true, responseFormat: true, requiredFields: ['reviews'], promptHash: createHash('sha256').update(JSON.stringify(messages)).digest('hex') };
    console.log(JSON.stringify({ event: 'start', caseId: packet.caseId, answers: packet.answers.length }));
    const row = await runOne({ endpoint: 'http://127.0.0.1:3425/v1/chat/completions', model: 'codex/gpt-6-sol', mode: 'high', testCase, timeoutMs: 120000 });
    await appendFile(join(folder, 'judge.jsonl'), JSON.stringify(row) + '\n');
    rows.push(row);
    console.log(JSON.stringify({ event: 'done', caseId: packet.caseId, ok: row.ok, seconds: row.totalMs / 1000, error: row.error }));
    if (!row.ok) throw new Error(`Judge request failed for ${packet.caseId}: ${row.error}`);
}

const evaluations = [];
for (const packet of packets) {
    const row = rows.findLast((item) => item.caseId === `judge-${packet.caseId}` && item.ok);
    if (!row) throw new Error(`Missing judge result for ${packet.caseId}`);
    const parsed = JSON.parse(row.answer.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim());
    const expected = new Set(packet.answers.map((item) => item.id));
    const weights = packet.rubric.map((item) => Number(item.match(/^([\d.]+):/)[1]));
    const seen = new Set();
    for (const review of parsed.reviews || []) {
        if (!expected.has(review.id) || seen.has(review.id)) throw new Error(`Unexpected/duplicate review: ${review.id}`);
        seen.add(review.id);
        if (!Array.isArray(review.criteria) || review.criteria.length !== weights.length || review.criteria.some((score, i) => typeof score !== 'number' || score < 0 || score > weights[i])) throw new Error(`Invalid criteria: ${review.id}`);
        const sum = review.criteria.reduce((a, b) => a + b, 0);
        if (Math.abs(sum - review.total) > 0.001) throw new Error(`Invalid total: ${review.id}`);
        if (!Array.isArray(review.issues)) throw new Error(`Missing issues: ${review.id}`);
        evaluations.push({ ...map.find((item) => item.id === review.id), criteria: review.criteria, score: sum, issues: review.issues, judgeModel: row.model });
    }
    if (seen.size !== expected.size) throw new Error(`Missing reviews for ${packet.caseId}`);
}
await writeFile(join(folder, 'judge-scores.json'), JSON.stringify({ method: 'Different model, mode/time/model labels hidden. Author must manually audit deductions before drawing conclusions. Rubric grading is subjective and not an official benchmark.', evaluations }, null, 2) + '\n');
console.log(JSON.stringify({ event: 'complete', graded: evaluations.length }));
