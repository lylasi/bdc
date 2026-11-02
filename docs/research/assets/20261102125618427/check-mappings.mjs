import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOne } from './bench-lib.mjs';

const folder = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(await readFile(join(folder, 'main.jsonl.manifest.json'), 'utf8'));
const task = manifest.cases.find((item) => item.id === 'word-bank');
const old = await readFile(join(folder, 'effective-route-checks.json'), 'utf8').catch((error) => { if (error.code === 'ENOENT') return ''; throw error; });
const previous = old ? JSON.parse(old) : [];
const checks = await Promise.all(manifest.targets.filter((target) => target.channel === 'Magpie').map(async (target) => {
    if (previous.some((r) => r.targetId === target.id)) return previous.find((r) => r.targetId === target.id);
    const session = `bdc-benchmark-map-${randomUUID()}`;
    const row = { ...await runOne({ endpoint: 'http://127.0.0.1:3425/v1/chat/completions', channel: 'Magpie', model: target.model, mode: 'none', testCase: task, headers: { 'X-Magpie-Session': session }, timeoutMs: 30000 }), targetId: target.id, phase: 'mapping-probe' };
    await appendFile(join(folder, `mapping-${target.id}.jsonl`), JSON.stringify(row) + '\n');
    const response = await fetch(`http://127.0.0.1:3425/v1/magpie/route?session=${encodeURIComponent(session)}`, { signal: AbortSignal.timeout(8000) });
    const result = { targetId: target.id, model: target.model, requested: 'none', responseOK: row.ok, observedReasoningTokens: row.reasoningTokens, observedReasoningChars: row.reasoningChars, routeStatus: response.status, source: 'Installed gateway own-session route metadata; generated after timing study and excluded from speed rankings.' };
    if (response.ok) {
        const payload = await response.json();
        const route = payload.route || {};
        result.route = Object.fromEntries(['asked','model','effort','done','status','served'].filter((k) => ['string','number','boolean'].includes(typeof route[k])).map((k) => [k,route[k]]));
        result.tries = (route.tries || []).map((item) => Object.fromEntries(['model','effort','status'].filter((k) => ['string','number','boolean'].includes(typeof item[k])).map((k) => [k,item[k]])));
    }
    return result;
}));
await writeFile(join(folder, 'effective-route-checks.json'), JSON.stringify(checks, null, 2) + '\n');
for (const item of checks) console.log(JSON.stringify(item));
