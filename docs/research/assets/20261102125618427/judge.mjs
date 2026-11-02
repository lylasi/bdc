import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { runOne } from './bench-lib.mjs';

const folder = dirname(fileURLToPath(import.meta.url));
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
const stage = args.get('stage') || 'all';
const state = JSON.parse(await readFile(join(folder, 'main.jsonl.status.json'), 'utf8'));
const manifest = JSON.parse(await readFile(join(folder, 'main.jsonl.manifest.json'), 'utf8'));
const rows = (await readFile(join(folder, 'main.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
if (rows.length !== state.requests) throw new Error('Main data/status mismatch');
let packets;
let map;
try {
    packets = JSON.parse(await readFile(join(folder, 'blind-packets.json'), 'utf8'));
    map = JSON.parse(await readFile(join(folder, 'blind-map.json'), 'utf8'));
} catch (error) {
    if (error.code !== 'ENOENT') throw error;
    packets = [];
    map = [];
    for (const task of manifest.cases) {
        const answers = rows.filter((r) => r.caseId === task.id).map((row) => {
            const id = `B${randomUUID().slice(0, 10)}`;
            map.push({ id, targetId: row.targetId, channel: row.channel, model: row.model, mode: row.mode, repeat: row.repeat, caseId: row.caseId, promptHash: row.promptHash, bodyHash: row.bodyHash, answerHash: createHash('sha256').update(row.answer).digest('hex'), ok: row.ok, error: row.error });
            return { id, answer: row.answer };
        }).sort((a, b) => a.id.localeCompare(b.id));
        for (let start = 0; start < answers.length; start += 8) {
            const packetId = `${task.id}-${Math.floor(start / 8) + 1}`;
            packets.push({ packetId, caseId: task.id, originalMessages: task.messages, rubric: task.rubric, answers: answers.slice(start, start + 8) });
        }
    }
    await writeFile(join(folder, 'blind-packets.json'), JSON.stringify(packets, null, 2) + '\n');
    await writeFile(join(folder, 'blind-map.json'), JSON.stringify(map, null, 2) + '\n');
    const sample = manifest.cases.map((task) => {
        const answers = packets.filter((p) => p.caseId === task.id).flatMap((p) => p.answers).sort((a, b) => createHash('sha256').update(`audit:${a.id}`).digest('hex').localeCompare(createHash('sha256').update(`audit:${b.id}`).digest('hex'))).slice(0, 4);
        return { packetId: `audit-${task.id}`, caseId: task.id, originalMessages: task.messages, rubric: task.rubric, answers };
    });
    await writeFile(join(folder, 'secondary-packets.json'), JSON.stringify(sample, null, 2) + '\n');
}

const instruction = `You are grading English-learning outputs. The original messages, a five-point rubric, and anonymous candidate answers follow. All labels are random; do not infer models or settings. Grade each response independently against its own original task.\n\nEach rubric item starts with its maximum points (1 or 2). Give partial credit only in 0.5-point increments. Do not reward length, Markdown decoration, or verbatim wording. Accept equivalent accurate terminology and translations. Important numerical boundaries are literal: more than four excludes four, under 18 excludes 18, fewer than five excludes five; 四人以上 includes four. Preserve distinctions between percentages and percentage points.\n\nFor syntax, identifying did placed before the main-clause subject is equivalent to explaining the inversion; do not require the exact text 'the committee agreed'. In the last inversion rubric item, tense/passive explanation and pronoun reference can each receive half credit. 'Object complement' is wrong when there is no object that it complements. For ambiguous attachment, both readings and unresolved context matter. For has been/gone, a normal teaching explanation suffices; the task does not require distinguishing transit from arrival. A translated heading is allowed if its Markdown emphasis is preserved.\n\nA missing minor detail is a half-point deduction, not grounds to mark the entire answer wrong. Empty answers score zero. If an answer is truncated or malformed, assess only what is actually present; never imagine missing text. Do not penalize a phrase-alignment row simply because a word can also appear elsewhere unless its alignment actually duplicates a specific meaning (for example now). Check the long policy text for omitted conditions, numbers and negation. Check the multi-turn task for both groups' original denominator, mathematical changes, non-causal conclusion and requested response format.\n\nReturn strict JSON only: {"reviews":[{"id":"B...","criteria":[1,1,1,1,1],"total":5,"issues":[]}]}. Include EVERY supplied id exactly once, with criteria in rubric order and total equal to their sum. For every deduction, give a concise Chinese issue quoting the specific wrong/missing detail. Full marks use an empty issues array. Do not reveal reasoning or speculate about the model.`;

function validate(answer, packet) {
    const parsed = JSON.parse(answer.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim());
    const expected = new Set(packet.answers.map((a) => a.id));
    const seen = new Set();
    const weights = packet.rubric.map((item) => Number(item.match(/^([\d.]+):/)[1]));
    if (!Array.isArray(parsed.reviews)) throw new Error('reviews is not an array');
    for (const review of parsed.reviews) {
        if (!expected.has(review.id) || seen.has(review.id)) throw new Error('Unexpected or duplicated review ID');
        seen.add(review.id);
        if (!Array.isArray(review.criteria) || review.criteria.length !== weights.length || review.criteria.some((n, i) => typeof n !== 'number' || n < 0 || n > weights[i] || Math.abs(n * 2 - Math.round(n * 2)) > 0.001)) throw new Error(`Invalid criterion score ${review.id}`);
        if (Math.abs(review.criteria.reduce((a, b) => a + b, 0) - review.total) > 0.001 || !Array.isArray(review.issues)) throw new Error(`Invalid total/issues ${review.id}`);
    }
    if (seen.size !== expected.size) throw new Error('Missing reviews');
    return parsed.reviews;
}

if (stage === 'pack') {
    console.log(JSON.stringify({ packets: packets.length, answers: map.length }));
    process.exit(0);
}

if (stage === 'all') {
    // The timing study and parity probes are already finished. Independent
    // judges can now run concurrently against frozen, anonymous packets.
    const exits = await Promise.all(['primary', 'secondary'].map((kind) => new Promise((resolve) => {
        const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--stage', kind], { stdio: 'inherit' });
        child.once('exit', (code) => resolve(code ?? 1));
        child.once('error', () => resolve(1));
    })));
    process.exit(exits.some((code) => code !== 0) ? 1 : 0);
}

for (const kind of ['primary', 'secondary']) {
    if (stage !== 'all' && stage !== kind) continue;
    const selected = kind === 'primary' ? packets : JSON.parse(await readFile(join(folder, 'secondary-packets.json'), 'utf8'));
    const path = join(folder, `${kind}-judge.jsonl`);
    const existing = await readFile(path, 'utf8').catch((error) => { if (error.code === 'ENOENT') return ''; throw error; });
    const results = existing.trim() ? existing.trim().split('\n').map(JSON.parse) : [];
    const model = kind === 'primary' ? 'codex/gpt-6-astra' : 'antigravity/claude-opus-5-5';
    for (const packet of selected) {
        if (results.some((r) => r.packetId === packet.packetId && r.ok && !r.validationError)) continue;
        const messages = [{ role: 'system', content: instruction }, { role: 'user', content: JSON.stringify(packet) }];
        const task = { id: `judge-${kind}-${packet.packetId}`, category: 'judge', messages, maxTokens: 8192, json: true, responseFormat: true, requiredFields: ['reviews'], arrayFields: ['reviews'], promptHash: createHash('sha256').update(JSON.stringify(messages)).digest('hex') };
        let good = false;
        for (let attempt = 1; attempt <= 2 && !good; attempt += 1) {
            console.log(JSON.stringify({ event: 'start', kind, model, packetId: packet.packetId, attempt, answers: packet.answers.length }));
            const result = { ...await runOne({ endpoint: 'http://127.0.0.1:3425/v1/chat/completions', channel: 'Magpie', model, mode: 'high', testCase: task, timeoutMs: 150000 }), packetId: packet.packetId, kind, attempt };
            if (result.ok) {
                try { validate(result.answer, packet); } catch (error) { result.validationError = error.message; }
            }
            await appendFile(path, JSON.stringify(result) + '\n');
            results.push(result);
            good = result.ok && !result.validationError;
            console.log(JSON.stringify({ event: 'done', kind, packetId: packet.packetId, attempt, ok: good, seconds: result.totalMs / 1000, error: result.error || result.validationError || null }));
        }
        if (!good) throw new Error(`${kind} judge failed for ${packet.packetId}; raw failures saved`);
    }
    const evaluations = [];
    for (const packet of selected) {
        const result = results.findLast((r) => r.packetId === packet.packetId && r.ok && !r.validationError);
        for (const review of validate(result.answer, packet)) evaluations.push({ ...map.find((item) => item.id === review.id), criteria: review.criteria, score: review.total, issues: review.issues, judgeModel: result.model });
    }
    await writeFile(join(folder, `${kind}-scores.json`), JSON.stringify({ kind, judgeModel: model, note: 'Anonymous model rubric grading. Secondary is a fixed 4-answer-per-case audit sample, not a replacement for all primary scores. Author audit required.', evaluations }, null, 2) + '\n');
    console.log(JSON.stringify({ event: 'complete', kind, evaluated: evaluations.length }));
}
