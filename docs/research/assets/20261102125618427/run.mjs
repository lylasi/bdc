import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeCases, representativeCases } from './cases.mjs';
import { connectionFor } from './channels.mjs';
import { runOne, isTransportFailure } from './bench-lib.mjs';

export const targets = [
    { id: 'hapi-grok420', channel: 'HAPI', model: 'grok-4.20-fast', label: 'HAPI Grok 4.20 Fast' },
    { id: 'hapi-grok43', channel: 'HAPI', model: 'grok-4.3-fast', label: 'HAPI Grok 4.3 Fast' },
    { id: 'magpie-deepseek', channel: 'Magpie', model: 'workbuddy/deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash' },
    { id: 'magpie-gpt', channel: 'Magpie', model: 'codex/gpt-6-sol', label: 'GPT 6 Sol' },
    { id: 'magpie-gemini', channel: 'Magpie', model: 'antigravity/gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
    { id: 'magpie-claude', channel: 'Magpie', model: 'antigravity/claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
    { id: 'magpie-glm', channel: 'Magpie', model: 'workbuddy/glm-5.3-flash', label: 'GLM 5.3 Flash' },
    { id: 'magpie-minimax', channel: 'Magpie', model: 'workbuddy/minimax-m3.1-flash', label: 'MiniMax M3.1 Flash' },
    { id: 'hapi-grokchat', channel: 'HAPI', model: 'grok-chat-fast', label: 'HAPI Grok Chat Fast', screenOnly: true }
];

const folder = dirname(fileURLToPath(import.meta.url));
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
const phase = args.get('phase') || 'main';
const out = args.get('out') || join(folder, `${phase}.jsonl`);
const wanted = args.get('targets')?.split(',');
const allCases = makeCases();
let chosen = targets.filter((target) => !target.screenOnly);
let selectedCases = allCases;
let modes = ['none', 'high'];
let repeats = 2;
if (phase === 'screen-hapi') {
    chosen = targets.filter((target) => target.channel === 'HAPI');
    selectedCases = allCases.filter((item) => ['word-bank', 'syntax-ambiguous'].includes(item.id));
    modes = ['default', 'none', 'low', 'high'];
    repeats = 1;
} else if (phase === 'screen-hard') {
    chosen = targets.filter((target) => target.channel === 'Magpie' && target.id !== 'magpie-deepseek');
    selectedCases = allCases.filter((item) => ['syntax-ambiguous', 'assistant-multiturn'].includes(item.id));
    repeats = 1;
}
if (wanted) chosen = chosen.filter((target) => wanted.includes(target.id));
if (args.get('cases')) selectedCases = allCases.filter((item) => args.get('cases').split(',').includes(item.id));
if (args.get('modes')) modes = args.get('modes').split(',');
if (args.get('repeats')) repeats = Number(args.get('repeats'));
if (!chosen.length || !selectedCases.length) throw new Error('Empty benchmark selection');
const previous = await readFile(out, 'utf8').catch((error) => { if (error.code === 'ENOENT') return ''; throw error; });
const records = previous.trim() ? previous.trim().split('\n').map(JSON.parse) : [];
const key = (r) => [r.targetId, r.caseId, r.mode, r.repeat, r.promptHash].join('|');
const completed = new Set(records.map(key));
const manifestPath = `${out}.manifest.json`;
const manifest = { phase, targets: chosen, modes, repeats, repeatTwoCases: phase === 'main' ? representativeCases : 'all', timeoutMs: Number(args.get('timeoutMs') || 90000), notes: 'Requested modes; none is not assumed to disable reasoning. Sequential, rotated target order and counterbalanced modes. Main: all 12 cases once, then four representative cases again. Credentials and thought text excluded.', cases: selectedCases, createdAt: new Date().toISOString() };
try { await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' }); }
catch (error) { if (error.code !== 'EEXIST') throw error; }
const failures = new Map();
const quarantined = new Set();
for (let repeat = 1; repeat <= repeats; repeat += 1) {
    const cases = phase === 'main' && repeat > 1 ? selectedCases.filter((item) => representativeCases.includes(item.id)) : selectedCases;
    for (let caseIndex = 0; caseIndex < cases.length; caseIndex += 1) {
        const testCase = cases[caseIndex];
        const rotated = [...chosen.slice(caseIndex % chosen.length), ...chosen.slice(0, caseIndex % chosen.length)];
        if (repeat % 2 === 0) rotated.reverse();
        for (let targetIndex = 0; targetIndex < rotated.length; targetIndex += 1) {
            const target = rotated[targetIndex];
            if (quarantined.has(target.id)) continue;
            const connection = await connectionFor(target.channel);
            const order = (caseIndex + targetIndex + repeat) % 2 ? modes : [...modes].reverse();
            for (const mode of order) {
                if (quarantined.has(target.id)) break;
                if (completed.has(key({ targetId: target.id, caseId: testCase.id, mode, repeat, promptHash: testCase.promptHash }))) continue;
                console.log(JSON.stringify({ event: 'start', phase, targetId: target.id, caseId: testCase.id, mode, repeat, at: new Date().toISOString() }));
                const row = { ...await runOne({ ...connection, channel: target.channel, model: target.model, mode, testCase, timeoutMs: manifest.timeoutMs }), targetId: target.id, phase, repeat, connectionSource: connection.source, catalogVersion: connection.catalogVersion || null };
                await appendFile(out, JSON.stringify(row) + '\n');
                records.push(row);
                completed.add(key(row));
                console.log(JSON.stringify({ event: 'done', targetId: target.id, caseId: row.caseId, mode, repeat, ok: row.ok, seconds: row.totalMs / 1000, firstAnswerSeconds: row.firstAnswerMs === null ? null : row.firstAnswerMs / 1000, reasoningTokens: row.reasoningTokens, reasoningChars: row.reasoningChars, finishReason: row.finishReason, error: row.error }));
                failures.set(target.id, isTransportFailure(row) ? (failures.get(target.id) || 0) + 1 : 0);
                if (failures.get(target.id) >= 3) {
                    quarantined.add(target.id);
                    console.log(JSON.stringify({ event: 'quarantined', targetId: target.id, reason: 'three consecutive transport failures; continuing independent targets' }));
                }
            }
        }
    }
}
await writeFile(`${out}.status.json`, JSON.stringify({ phase, requests: records.length, successful: records.filter((r) => r.ok).length, quarantined: [...quarantined], completedAt: new Date().toISOString() }, null, 2) + '\n');
console.log(JSON.stringify({ event: 'complete', phase, requests: records.length, successful: records.filter((r) => r.ok).length, quarantined: [...quarantined] }));
