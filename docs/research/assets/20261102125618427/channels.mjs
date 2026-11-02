import { readFile } from 'node:fs/promises';
import { buildManagedAad, decryptSecret } from '../../../../cloudflare-worker/src/credential-crypto.js';

let hapiPromise;
export async function hapiConnection() {
    hapiPromise ||= (async () => {
        const direct = process.env.BDC_BENCH_HAPI_KEY;
        if (direct) return { endpoint: process.env.BDC_BENCH_HAPI_ENDPOINT || 'https://hapi.141455.xyz/v1/chat/completions', headers: { Authorization: `Bearer ${direct}` }, source: 'environment' };
        const catalogPath = process.env.BDC_BENCH_PRIVATE_CATALOG || '/tmp/bdc-model-expansion-private-20261102125618427/latest-catalog.json';
        const secretPath = process.env.BDC_BENCH_MASTER_SECRETS || '/Users/linus/bdc-release-work/20261018031853623/private/worker-secrets.json';
        const blocks = JSON.parse(await readFile(catalogPath, 'utf8'));
        const row = blocks.flatMap((block) => block.results || [])[0];
        const provider = JSON.parse(row.config_json).providers.find((item) => item.id === 'managed-legacy-hapi');
        if (!provider || new URL(provider.apiUrl).hostname !== 'hapi.141455.xyz') throw new Error('Expected HAPI catalog route missing');
        const envelope = JSON.parse(row.credentials_json)[provider.id];
        const env = JSON.parse(await readFile(secretPath, 'utf8'));
        const aad = buildManagedAad({ providerId: provider.id, binding: envelope.binding, credentialRevision: envelope.credentialRevision, keyVersion: envelope.keyVersion });
        const key = await decryptSecret(envelope, { aad, keyVersion: envelope.keyVersion }, env);
        return { endpoint: provider.apiUrl, headers: { Authorization: `Bearer ${key}` }, source: 'managed-catalog', catalogVersion: row.version };
    })();
    return hapiPromise;
}

export async function connectionFor(channel) {
    if (channel === 'HAPI') return hapiConnection();
    if (channel === 'Magpie') return { endpoint: 'http://127.0.0.1:3425/v1/chat/completions', headers: {}, source: 'loopback' };
    throw new Error('Unknown benchmark channel');
}
