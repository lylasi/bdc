// Actual MV3 + actual Worker/SQLite + website modules. Only AI transport is a mock.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const ROOT = path.resolve(__dirname, '../..');
const ALICE = 'a'.repeat(43);
const BOB = 'b'.repeat(43);
const ADMIN = 'z'.repeat(43);
const AI_KEY = 'test-only-extension-key';
async function listen(server) { await new Promise((r) => server.listen(0, '127.0.0.1', r)); return 'http://127.0.0.1:' + server.address().port; }
async function environment() {
    const worker = (await import(pathToFileURL(path.join(ROOT, 'cloudflare-worker/src/worker.js')))).default;
    const { createD1Adapter, createSqliteDatabase } = await import(pathToFileURL(path.join(ROOT, 'selfhost/d1-adapter.js')));
    const db = new DatabaseSync(':memory:');
    db.exec(fs.readFileSync(path.join(ROOT, 'cloudflare-worker/schema.sql'), 'utf8'));
    for (const [id, token, role] of [['alice', ALICE, 'user'], ['bob', BOB, 'user'], ['admin', ADMIN, 'admin']]) {
        db.prepare('INSERT INTO users(token_hash,user_id,label,role) VALUES(?,?,?,?)').run(createHash('sha256').update(token).digest('hex'), id, id, role);
    }
    for (const [owner, id, name] of [['alice', 'book', '单词本'], ['alice', 'book-2', 'Reading'], ['bob', 'bob-book', 'Bob only']]) {
        db.prepare('INSERT INTO reading_entities VALUES(?,?,?,?,?,?,?,?)').run(owner, 'vocabularyBook', id, 1, null, JSON.stringify({ name }), '2026-11-01', 'seed');
        db.prepare('INSERT INTO reading_state(owner_user_id,next_seq,updated_at) VALUES(?,?,?) ON CONFLICT(owner_user_id) DO UPDATE SET next_seq=next_seq+1').run(owner, 2, '2026-11-01');
        const seq = db.prepare('SELECT next_seq-1 AS seq FROM reading_state WHERE owner_user_id=?').get(owner).seq;
        db.prepare('INSERT INTO reading_changes VALUES(?,?,?,?,?,?,?)').run(owner, seq, 'vocabularyBook', id, 'upsert', 1, '2026-11-01');
    }
    const env = { DB: createD1Adapter(createSqliteDatabase(db)), ALLOWED_ORIGINS: '*',
        AI_CREDENTIAL_KEY_V1: Buffer.alloc(32, 7).toString('base64'), AI_CREDENTIAL_KEY_VERSION: '1', AI_CATALOG_DIGEST_KEY: 'catalog-test-digest-key-32-characters' };
    const state = { aiCalls: 0, captureCalls: [], failCaptures: false, loseNextReply: false };
    let base;
    const server = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url, base);
            let raw = '';
            for await (const chunk of req) raw += chunk;
            if (url.pathname === '/test-article') {
                res.writeHead(200, { 'Content-Type': 'text/html', ...(url.searchParams.has('strict') ? { 'Content-Security-Policy': "default-src 'self'; frame-src 'none'; script-src 'none'" } : {}) });
                return res.end('<!doctype html><title>Major tech stocks plunge</title><nav>Navigation noise</nav><article><h1>Major tech stocks plunge</h1><p id="article">Major tech stocks plunge as investors worry. Markets remain volatile.</p><h2>Outlook</h2><p>People gather information before making decisions.</p></article><form><input value="private-form-value"></form>');
            }
            if (url.pathname.startsWith('/mock-ai/')) {
                const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Content-Type': 'application/json' };
                if (req.method === 'OPTIONS') { res.writeHead(204, headers); return res.end(); }
                state.aiCalls += 1;
                const prompt = JSON.parse(raw).messages.map((m) => typeof m.content === 'string' ? m.content : '').join('\n');
                if (prompt.includes('Clean the supplied Markdown article')) {
                    res.writeHead(200, headers);
                    return res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '# Major tech stocks plunge\n\nMajor tech stocks plunge as investors worry. Markets remain volatile.\n\n## Outlook\n\nPeople gather information before making decisions.' } }] }));
                }
                if (prompt.includes('Translate the following English paragraph')) {
                    res.writeHead(200, headers);
                    return res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ chinese_translation: '市場變化與展望。' }) } }] }));
                }
                const hk = raw.includes('香港繁體中文');
                res.writeHead(200, headers);
                return res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
                    word: 'plunge', analysis: { meaning: hk ? '急跌（語境）' : '暴跌（语境）', phonetic: 'plʌndʒ', pos: 'verb', role: hk ? '描述價格下跌' : '描述价格下跌' }
                }) } }] }));
            }
            if (url.pathname === '/captures' && req.method === 'POST') {
                state.captureCalls.push(JSON.parse(raw));
                if (state.failCaptures) {
                    res.writeHead(503, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
                    return res.end('{"code":"capture_failed"}');
                }
            }
            const response = await worker.fetch(new Request(url, {
                method: req.method, headers: req.headers,
                ...(['GET', 'HEAD'].includes(req.method) ? {} : { body: raw || undefined })
            }), env);
            if (url.pathname === '/captures' && state.loseNextReply) {
                state.loseNextReply = false;
                res.writeHead(503, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
                return res.end('{"code":"capture_failed"}');
            }
            res.writeHead(response.status, Object.fromEntries(response.headers));
            res.end(Buffer.from(await response.arrayBuffer()));
        } catch (error) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }
    });
    base = await listen(server);
    const tasks = Object.fromEntries(['wordAnalysis', 'articleWordTranslation', 'articlePhraseTranslation', 'articleCleanup', 'articleParagraphTranslation', 'articleAnalysis'].map((task) => [task, { providerId: 'managed-capture', model: 'capture-model' }]));
    const publish = await fetch(base + '/admin/ai-catalog/publish', {
        method: 'POST', headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseVersion: 0, mutationId: 'publish-capture-test', config: { schemaVersion: 1, providers: [{
            id: 'managed-capture', name: 'Capture Test', enabled: true, order: 0, format: 'openai-chat',
            apiUrl: base + '/mock-ai/v1/chat/completions', modelsUrl: base + '/mock-ai/v1/models', authMode: 'bearer', models: [{ id: 'capture-model' }]
        }], tasks }, keyOps: { 'managed-capture': { action: 'replace', apiKey: AI_KEY } } })
    });
    assert.equal(publish.status, 200, JSON.stringify(await publish.json()));
    const appServer = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://localhost');
        if (url.pathname === '/__capture-test.html') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            return res.end('<!doctype html><title>Capture module verification</title><body></body>');
        }
        let relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
        if (relative === 'ai-config.js') relative = 'ai-config.example.js';
        const file = path.resolve(ROOT, relative);
        if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end(); }
        fs.readFile(file, (error, bytes) => {
            if (error) { res.writeHead(404); return res.end(); }
            const type = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream';
            res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(bytes);
        });
    });
    const appBase = await listen(appServer);
    return { base, appBase, state, db, async close() { await Promise.all([new Promise((r) => server.close(r)), new Promise((r) => appServer.close(r))]); db.close(); } };
}

module.exports = { environment, ALICE, BOB, ADMIN };
