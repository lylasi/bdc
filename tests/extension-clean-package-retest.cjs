// DeepSeek 復測：從「乾淨源碼包」驗證打包與載入可重現。
//
// 第一輪驗證發現 extension/ai-config.js 被 .gitignore 吃掉，導致直接提交的
// extension/ 在別人 clone 後載入失敗。修復方向是把 extension 的共享副本與
// ai-config.js 都當成產物。這支腳本獨立驗證該前提：
//
//   1. 用 git archive 匯出指定提交（預設 HEAD），確認產物目錄真的不在源碼包內
//   2. 打包前直接載入 → 期望載入失敗（證明「先打包」不是可選步驟）
//   3. 執行 scripts/package-extension.mjs → 再載入 → 期望登入、解析模型、完成查詞，
//      且 0.3.0 的詞書工作區端點（GET /vocabulary/books）在打包後的 MV3 內也讀得到
//   4. 再打包一次 → 產物逐位元組不變（決定性），且與來源檔一致（單一來源）
//   5. 在乾淨源碼包內跑 tests/extension-ai-lookup.test.mjs 與
//      tests/extension-ai-cache-scope.test.mjs（證明 node 測試不依賴本機私有 ai-config.js）
//
// 用法：
//   PLAYWRIGHT_MODULE=<playwright 路徑> node tests/extension-clean-package-retest.cjs [--rev=<git rev>]
//
// 全程只用隨機連接埠的隔離 mock 與臨時目錄，不讀私有 ai-config.js、不用真實 Key。
//
// 0.3.0 起擴充套件在登入後立刻呼叫 GET /vocabulary/books（capture-ui 的詞書下拉），
// 這是 clean-package 匯出後唯一會打到 Worker 的新端點；mock 必須用正式 Worker 的
// 回應形狀（books／defaultBookId／pageBookId／articleId）回答，否則打包後的介面會留下 404。

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const ROOT = path.resolve(__dirname, '..');
const revArg = process.argv.find((a) => a.startsWith('--rev='));
const REV = revArg ? revArg.slice('--rev='.length) : 'HEAD';

const results = [];
function check(name, ok, detail = '') {
    results.push({ name, ok: !!ok, detail: String(detail || '') });
    console.log(`${ok ? 'PASS' : 'FAIL'} · ${name}${detail ? '\n        ↳ ' + detail : ''}`);
}

// The harness may receive a broken GIT_CONFIG_COUNT from the caller; strip it.
function gitEnv() {
    const env = { ...process.env };
    for (const key of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_KEY_1', 'GIT_CONFIG_VALUE_1']) {
        delete env[key];
    }
    return env;
}

function git(args, options = {}) {
    return execFileSync('git', args, { cwd: ROOT, env: gitEnv(), encoding: 'utf8', ...options }).trim();
}

function extractRev(targetDir) {
    const tarPath = path.join(os.tmpdir(), `bdc-clean-${process.pid}.tar`);
    execFileSync('git', ['archive', '--format=tar', '-o', tarPath, REV], { cwd: ROOT, env: gitEnv() });
    fs.mkdirSync(targetDir, { recursive: true });
    execFileSync('tar', ['-x', '-C', targetDir, '-f', tarPath]);
    fs.rmSync(tarPath, { force: true });
}

function hashTree(dir) {
    const out = [];
    const walk = (current) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const abs = path.join(current, entry.name);
            if (entry.isDirectory()) walk(abs);
            else out.push(`${path.relative(dir, abs)} ${crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex')}`);
        }
    };
    if (fs.existsSync(dir)) walk(dir);
    return out.join('\n');
}

function readJsonBody(req) {
    return new Promise((resolve) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (_) { resolve({}); } });
    });
}

// The packager publishes its own artifact list; follow that declaration instead of a
// hardcoded count, which goes stale every time a shared module is added (0.2.x spoke
// of "Packaged 44 files", 0.3.0 packages 48 shared files + 3 generated artifacts).
function declaredSharedFiles(rootDir) {
    const source = fs.readFileSync(path.join(rootDir, 'scripts/package-extension.mjs'), 'utf8');
    const block = source.match(/const SHARED_FILES = \[([\s\S]*?)\];/);
    if (!block) return [];
    return [...block[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

// Minimal isolated Worker + AI provider: enough to prove the packaged extension works.
// Route coverage tracks what the extension actually calls; anything else is recorded
// in state.unexpected so an unforeseen 404 fails loudly instead of being ignored.
async function startMock() {
    const state = {
        allowedOrigin: '',
        baseUrl: '',
        users: { alice: { user_id: 'alice', label: 'Alice Reader', role: 'user', username: 'alice', password: 'pwd-alice-771', token: 'A'.repeat(40) } },
        providerCalls: 0,
        books: [{ id: 'clean-package-book', name: 'Clean Package Book', revision: 1 }],
        requests: [],
        unexpected: []
    };
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const origin = req.headers.origin || '';
        const originAllowed = !state.allowedOrigin || !origin || origin === state.allowedOrigin;
        const entry = { method: req.method, path: url.pathname, query: url.search, status: 0 };
        state.requests.push(entry);
        const cors = {
            'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
            'Access-Control-Allow-Headers': 'Authorization, Content-Type',
            'Cache-Control': 'no-store'
        };
        if (origin && originAllowed) cors['Access-Control-Allow-Origin'] = origin;
        if (req.method === 'OPTIONS') { entry.status = originAllowed ? 204 : 403; res.writeHead(entry.status, cors); res.end(); return; }
        const send = (status, data) => {
            entry.status = status;
            res.writeHead(status, { ...cors, 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(data));
        };
        // A 404 the harness did not model is a harness gap, never a product pass.
        const unknownRoute = (detail) => {
            state.unexpected.push(`${req.method} ${url.pathname}${url.search} (${detail})`);
            return send(404, { error: 'not_found' });
        };
        if (url.pathname.startsWith('/provider')) {
            const body = await readJsonBody(req);
            const prompt = (body.messages || []).map((m) => m.content).join('\n');
            state.providerCalls += 1;
            const word = (prompt.match(/Target word:\s*"([^"]*)"/) || prompt.match(/Analyze the English word "([^"]*)"/) || [])[1] || 'word';
            return send(200, {
                choices: [{
                    finish_reason: 'stop',
                    message: { content: JSON.stringify({ word, sentence: '', analysis: { phonetic: 'tʃɑːdʒ', pos: 'v.', meaning: `clean-package:${word}` } }) }
                }]
            });
        }
        const w = url.pathname.match(/^\/worker(\/.*)?$/);
        if (w) {
            if (!originAllowed) return send(403, { error: 'origin_not_allowed' });
            const route = w[1] || '/';
            const body = req.method === 'POST' || req.method === 'PUT' ? await readJsonBody(req) : null;
            const alice = state.users.alice;
            if (route === '/login' && req.method === 'POST') {
                if (body?.username !== alice.username || body?.password !== alice.password) return send(401, { error: 'invalid_credentials' });
                return send(200, { token: alice.token, user_id: alice.user_id, label: alice.label, role: alice.role });
            }
            const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
            if (bearer !== alice.token) return send(401, { error: 'unauthorized' });
            if (route === '/me') return send(200, { user_id: alice.user_id, label: alice.label, role: alice.role });
            // 0.3.0: the extension lists vocabulary books right after sign-in
            // (capture-ui loadBooks → capture-client books()). Same JSON shape as
            // cloudflare-worker/src/captures.js listBooks().
            if (route === '/vocabulary/books' && req.method === 'GET') {
                const books = state.books.map((book) => ({
                    id: book.id, name: book.name, revision: Number(book.revision) || 1, sourceUrl: '', articleId: ''
                }));
                return send(200, {
                    books,
                    defaultBookId: books[0]?.id || '',
                    // No BDC website page is involved in this flow, so no page-bound book/article.
                    pageBookId: '',
                    articleId: ''
                });
            }
            if (route === '/snapshot') {
                return send(200, {
                    version: 1,
                    payload: { aiSettings: { updatedAt: '2026-11-06T00:00:00.000Z', settings: { providers: {}, models: {}, tasks: {}, defaultModel: '', keySyncDefault: 'cloud' } } }
                });
            }
            if (route === '/ai-catalog') {
                return send(200, {
                    version: 3,
                    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
                    providers: [{
                        id: 'managed-default', name: 'Managed Default Provider', order: 1, enabled: true,
                        format: 'openai-chat', formatVersion: 1, authMode: 'bearer',
                        apiUrl: `${state.baseUrl}/provider-managed/v1/chat/completions`,
                        modelsUrl: `${state.baseUrl}/provider-managed/v1/models`,
                        models: [{ id: 'managed-gpt', label: 'Managed GPT', capabilities: { text: 'yes', json: 'yes' } }]
                    }],
                    tasks: {
                        default: { providerId: 'managed-default', model: 'managed-gpt' },
                        wordAnalysis: { providerId: 'managed-default', model: 'managed-gpt' },
                        articleWordTranslation: { providerId: 'managed-default', model: 'managed-gpt' }
                    }
                });
            }
            if (/^\/ai-catalog\/providers\/[^/]+\/credential$/.test(route)) {
                return send(200, {
                    apiKey: 'probe-managed-key-01', credentialRevision: 1, catalogVersion: 3,
                    binding: {
                        formatVersion: 1, format: 'openai-chat',
                        apiUrl: `${state.baseUrl}/provider-managed/v1/chat/completions`,
                        modelsUrl: `${state.baseUrl}/provider-managed/v1/models`,
                        authMode: 'bearer'
                    }
                });
            }
            if (route === '/ai-credentials') return send(200, { items: [] });
            return unknownRoute(`unmodeled worker route ${route}`);
        }
        return unknownRoute('outside /worker');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    state.baseUrl = `http://127.0.0.1:${server.address().port}`;
    state.endpoint = `${state.baseUrl}/worker`;
    return { state, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function withExtension(extDir, run) {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-clean-profile-'));
    let context = null;
    try {
        context = await chromium.launchPersistentContext(userDataDir, {
            channel: 'chromium',
            headless: true,
            args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`]
        });
        return await run(context);
    } finally {
        if (context) await context.close();
        try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
    }
}

async function openLookup(context) {
    let sw = context.serviceWorkers()[0];
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
    if (!sw) return { error: 'no-service-worker' };
    const extensionId = sw.url().split('/')[2];
    const extensionOrigin = `chrome-extension://${extensionId}`;
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (err) => errors.push(String(err.message || err)));
    page.on('console', (msg) => { if (msg.type() === 'error') errors.push('console: ' + msg.text()); });
    await page.goto(`${extensionOrigin}/lookup.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    return { page, extensionOrigin, errors };
}

(async () => {
    const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-clean-src-'));
    const sourceDir = path.join(workRoot, 'source');
    const mock = await startMock();
    let commit = '';
    try {
        commit = git(['rev-parse', REV]);
        extractRev(sourceDir);

        const extDir = path.join(sourceDir, 'extension');
        const absent = ['extension/ai-config.js', 'extension/modules', 'extension/locales', 'extension/shared', 'extension/_locales']
            .filter((rel) => fs.existsSync(path.join(sourceDir, rel)));
        const trackedExtension = git(['ls-tree', '-r', '--name-only', REV, 'extension']).split('\n').filter(Boolean);
        check(
            'P1 從乾淨源碼包匯出後，extension 產物（ai-config.js／modules／locales／shared／_locales）確實不存在',
            absent.length === 0 && !fs.existsSync(path.join(sourceDir, 'ai-config.js')),
            `rev=${REV}(${commit.slice(0, 7)}) 追蹤的 extension 檔=${trackedExtension.length} 仍存在=${JSON.stringify(absent)} 根私有ai-config=${fs.existsSync(path.join(sourceDir, 'ai-config.js'))}`
        );

        // 1) Loading an unpackaged tree must fail loudly, not silently half-work.
        const before = await withExtension(extDir, async (context) => {
            const opened = await openLookup(context);
            if (opened.error) return { error: opened.error, ready: false, errors: [] };
            const ready = await opened.page.evaluate(() => (document.getElementById('ext-locale-select')?.options?.[0]?.textContent || '').length > 0);
            const title = await opened.page.title();
            const account = await opened.page.evaluate(() => document.getElementById('ext-account-status')?.textContent || '');
            return { ready, title, account, errors: opened.errors };
        });
        check(
            'P2 未打包的 extension 目錄載入時確實失敗（證明「先執行打包」是必要步驟，不是可選美化）',
            before.ready === false && (before.errors.length > 0 || !before.account),
            `i18n已套用=${before.ready} 標題="${before.title}" 帳戶列="${before.account}" 錯誤=${JSON.stringify(before.errors.slice(0, 3))}`
        );

        // 2) Package inside the clean tree exactly as documented (relative path from the repo root).
        const packageOut = execFileSync(process.execPath, ['scripts/package-extension.mjs'], { cwd: sourceDir, encoding: 'utf8' });
        const declared = declaredSharedFiles(sourceDir);
        const expectedCount = declared.length ? declared.length + 3 : 0; // + extension/ai-config.js + _locales/{zh_CN,zh_TW}/messages.json
        const reportedCount = (packageOut.match(/Packaged (\d+) files/) || [])[1];
        const missingArtifacts = declared.filter((rel) => !fs.existsSync(path.join(extDir, rel)));
        check(
            'P3 在乾淨源碼包內執行 node scripts/package-extension.mjs 成功，且打包檔數與腳本宣告的產物清單一致、每個宣告檔都真的落地',
            expectedCount > 0 && Number(reportedCount) === expectedCount && missingArtifacts.length === 0,
            `輸出="${packageOut.trim()}" 宣告共享檔=${declared.length}+3（ai-config.js、_locales×2）=${expectedCount} 實際=${reportedCount} 未落地=${JSON.stringify(missingArtifacts)}`
        );

        // 2b) Same script, same tree, but invoked through the symlinked absolute path.
        //     The documented install step must not silently do nothing.
        const symlinkedOut = execFileSync(process.execPath, [path.join(sourceDir, 'scripts/package-extension.mjs')], { cwd: sourceDir, encoding: 'utf8' });
        check(
            'F1（新發現）以含符號連結的絕對路徑（macOS /tmp → /private/tmp）直接執行打包腳本時，仍必須真的寫出產物',
            Number((symlinkedOut.match(/Packaged (\d+) files/) || [])[1]) === expectedCount,
            `相對路徑呼叫輸出="${packageOut.trim()}"／絕對路徑呼叫輸出="${symlinkedOut.trim()}"（空字串代表腳本靜默未執行，退出碼仍為 0）`
        );

        const after = await withExtension(extDir, async (context) => {
            const opened = await openLookup(context);
            if (opened.error) return { error: opened.error };
            const { page, extensionOrigin } = opened;
            const pagesBefore = context.pages().length;
            mock.state.allowedOrigin = extensionOrigin;
            // Only this run's traffic counts for the "no unmodeled request" gate.
            mock.state.requests.length = 0;
            mock.state.unexpected.length = 0;
            await page.fill('#ext-endpoint-input', mock.state.endpoint);
            await page.selectOption('#ext-login-mode', 'password');
            await page.fill('#ext-username-input', 'alice');
            await page.fill('#ext-password-input', 'pwd-alice-771');
            await page.click('#ext-connect-btn');
            const connected = await page.waitForFunction(
                () => (document.getElementById('ext-account-status')?.textContent || '').includes('Alice Reader'),
                null, { timeout: 20000 }
            ).then(() => true).catch(() => false);
            // 0.3.0: sign-in fires captureUI.sync() → GET /vocabulary/books. The packaged
            // build must parse the Worker response and fill the capture book selector.
            const booksLoaded = await page.waitForFunction(
                () => document.querySelectorAll('#ext-capture-book option').length > 1,
                null, { timeout: 15000 }
            ).then(() => true).catch(() => false);
            const capture = await page.evaluate(() => ({
                options: Array.from(document.querySelectorAll('#ext-capture-book option')).map((option) => option.textContent),
                selected: document.getElementById('ext-capture-book')?.value || '',
                notice: document.getElementById('ext-capture-notice')?.textContent || ''
            }));
            const task = await page.evaluate(() => document.getElementById('ext-task-status')?.textContent || '');
            await page.fill('#ext-word-input', 'charge');
            await page.fill('#ext-sentence-input', 'They charge £10 for admission.');
            await page.click('#ext-lookup-btn');
            await page.waitForFunction(
                () => !document.getElementById('ext-result-box')?.classList.contains('hidden')
                    || !document.getElementById('ext-lookup-notice')?.classList.contains('hidden'),
                null, { timeout: 25000 }
            ).catch(() => {});
            await page.waitForTimeout(400);
            const result = await page.evaluate(() => ({
                hidden: document.getElementById('ext-result-box')?.classList.contains('hidden'),
                meaning: document.getElementById('ext-result-meaning')?.textContent || '',
                meta: document.getElementById('ext-result-meta')?.textContent || ''
            }));
            const siteTabs = context.pages().filter((p) => {
                const u = String(p.url());
                return !u.startsWith('chrome-extension://') && u !== 'about:blank';
            });
            return {
                connected, task, result, errors: opened.errors,
                bdcTabs: siteTabs.map((p) => p.url()), pagesBefore,
                booksLoaded, capture,
                requests: mock.state.requests.map((entry) => ({ ...entry })),
                unexpected: mock.state.unexpected.slice()
            };
        });
        const booksRequest = after.requests.find((entry) => entry.method === 'GET' && /\/vocabulary\/books$/.test(entry.path));
        const failedRequests = after.requests.filter((entry) => entry.status >= 400);
        const requestLog = after.requests.map((entry) => `${entry.method} ${entry.path}${entry.query} → ${entry.status}`);
        check(
            'P4 打包後可在真實 MV3 載入、連上帳戶、解析 managed 模型、讀到詞書清單並完成一次語境查詞（無任何 BDC 網站分頁，且沒有未建模的 4xx／5xx）',
            after.connected === true
            && /managed-gpt/.test(after.task)
            && after.result.hidden === false
            && /charge/.test(after.result.meaning)
            && after.bdcTabs.length === 0
            && after.errors.length === 0
            && booksRequest?.status === 200
            && after.booksLoaded === true
            && after.capture.options.includes('Clean Package Book')
            && after.capture.selected === 'clean-package-book'
            && after.unexpected.length === 0
            && failedRequests.length === 0,
            `已連線=${after.connected} 任務列="${after.task}" 查詞結果=${JSON.stringify(after.result)} BDC分頁=${JSON.stringify(after.bdcTabs)}`
            + ` 詞書端點=${booksRequest ? `GET ${booksRequest.path} → ${booksRequest.status}` : '未發出'} 詞書下拉=${JSON.stringify(after.capture)}`
            + ` 未建模路由=${JSON.stringify(after.unexpected)} 失敗請求=${JSON.stringify(failedRequests)} 主控台錯誤=${JSON.stringify(after.errors)}`
            + `\n        ↳ 請求序列=${JSON.stringify(requestLog)}`
        );

        // 3) Determinism + single source of truth.
        const firstHash = hashTree(extDir);
        execFileSync(process.execPath, ['scripts/package-extension.mjs'], { cwd: sourceDir, encoding: 'utf8' });
        const secondHash = hashTree(extDir);
        const drifted = ['modules/api.js', 'modules/extension-ai-runtime.js', 'modules/ai-credential-sync.js', 'locales/zh-CN.js', 'locales/zh-HK.js']
            .filter((rel) => !fs.existsSync(path.join(extDir, rel))
                || !fs.readFileSync(path.join(sourceDir, rel)).equals(fs.readFileSync(path.join(extDir, rel))));
        check(
            'P5 重複打包產物逐位元組相同，且共享副本與來源檔一致（單一來源、原子寫入沒有留下殘檔）',
            firstHash === secondHash && drifted.length === 0,
            `檔案數=${firstHash.split('\n').length} hash相同=${firstHash === secondHash} 漂移=${JSON.stringify(drifted)}`
        );

        // 4) Node tests must work inside the clean tree (no private ai-config.js anywhere).
        const nodeOut = (() => {
            try {
                return execFileSync(process.execPath, ['--test', 'tests/extension-ai-lookup.test.mjs', 'tests/extension-ai-cache-scope.test.mjs'],
                    { cwd: sourceDir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_COUNT: '', GIT_CONFIG_VALUE_0: '' } });
            } catch (error) {
                return `${error.stdout || ''}${error.stderr || ''}\nEXIT=${error.status}`;
            }
        })();
        const passLine = (nodeOut.match(/(?:\u2139|#)\s*pass\s+(\d+)/) || [])[1];
        const failLine = (nodeOut.match(/(?:\u2139|#)\s*fail\s+(\d+)/) || [])[1];
        check(
            'P6 在乾淨源碼包內可跑擴充套件 node 測試（不依賴本機私有 ai-config.js）',
            Number(passLine) > 0 && Number(failLine) === 0 && !/EXIT=[1-9]/.test(nodeOut),
            `pass=${passLine} fail=${failLine}`
        );
    } finally {
        await mock.close();
        try { fs.rmSync(workRoot, { recursive: true, force: true }); } catch (_) {}
    }

    const failed = results.filter((r) => !r.ok);
    console.log(`\n=== clean package retest: ${results.length - failed.length}/${results.length} checks hold ===`);
    if (failed.length) {
        console.log('Reproduced defects:');
        for (const f of failed) console.log(` - ${f.name}`);
        process.exitCode = 1;
    }
})().catch((error) => {
    console.error('harness error:', error);
    process.exitCode = 2;
});
