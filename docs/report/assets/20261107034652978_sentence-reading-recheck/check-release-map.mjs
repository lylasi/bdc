import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
const ROOT = '/tmp/bdc-sentence-reading-release-20261107021459019';
const BASE = 'http://127.0.0.1:8326';
const sha = (b) => createHash('sha256').update(b).digest('hex').slice(0, 12);
const diskHtml = await readFile(path.join(ROOT, 'index.html'));
const html = Buffer.from(await (await fetch(BASE + '/index.html')).text());
console.log('index.html served==disk', sha(html) === sha(diskHtml), sha(html), sha(diskHtml));
const block = html.toString().match(/<!-- release-assets:importmap:start -->([\s\S]*?)<!-- release-assets:importmap:end -->/)[1];
const map = JSON.parse(block.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1].replace(/<!--[\s\S]*?-->/g, '')).imports;
const entries = Object.entries(map);
const versions = [...new Set(entries.map(([, v]) => (v.match(/\?v=([0-9a-f]+)/) || [])[1]))];
console.log('entries', entries.length, 'versions', versions);
const missingQuery = entries.filter(([, v]) => !v.includes('?v='));
console.log('entries without ?v=', missingQuery.length);
let stale = 0, mismatch = 0, notOk = 0;
for (const [spec, url] of entries) {
    const res = await fetch(BASE + url);
    if (!res.ok) { notOk++; console.log('NOT OK', url, res.status); continue; }
    const body = Buffer.from(await res.arrayBuffer());
    const rel = spec.replace(/^\//, '');
    const disk = await readFile(path.join(ROOT, rel));
    if (sha(body) !== sha(disk)) { mismatch++; console.log('MISMATCH', spec); }
    if (disk.toString().includes('e8b241528a9b')) stale++;
}
console.log('fetched', entries.length, 'mismatch', mismatch, 'notOk', notOk, 'filesWithOldHash', stale);
// styles.css + main.js 也在 map 內；再確認 head 的 <link> 與 <script> 版本一致
const link = html.toString().match(/href="styles\.css\?v=([0-9a-f]+)"/)?.[1];
const script = html.toString().match(/src="main\.js\?v=([0-9a-f]+)"/)?.[1];
const cssDisk = await readFile(path.join(ROOT, 'styles.css'));
const cssServed = Buffer.from(await (await fetch(`${BASE}/styles.css?v=${link}`)).arrayBuffer());
console.log('styles.css link', link, 'served==disk', sha(cssServed) === sha(cssDisk), 'main.js src', script, 'singleVersion', link === versions[0] && script === versions[0]);
