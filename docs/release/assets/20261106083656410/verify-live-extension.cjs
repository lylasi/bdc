// Production smoke test. Uses only the disposable account supplied by the runner.
// Never logs tokens, keys, request headers, or credential response bodies.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const fixture = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const output = process.argv[3];
const checks = [];
const network = [];
const providerRequests = [];
const pageErrors = [];
let context;
let profile;

function check(name, ok, detail) {
    checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
    if (!ok) throw new Error(name);
}

async function uiState(page) {
    return page.evaluate(() => {
        const r = globalThis.__bdcExtensionRuntime.getExtensionReadiness({
            text: document.querySelector('#ext-word-input').value,
            sentence: document.querySelector('#ext-sentence-input').value
        });
        return {
            loggedIn: r.loggedIn,
            userId: r.userId,
            role: r.role,
            catalog: r.catalog,
            credentialSync: r.credentialSync,
            task: r.taskResolution,
            accountText: document.querySelector('#ext-account-status').textContent,
            accountNotice: document.querySelector('#ext-account-notice').textContent,
            taskText: document.querySelector('#ext-task-status').textContent,
            lookupNotice: document.querySelector('#ext-lookup-notice').textContent,
            meaning: document.querySelector('#ext-result-meaning').textContent,
            metadata: document.querySelector('#ext-result-meta').textContent
        };
    });
}

async function lookup(page) {
    await page.locator('#ext-lookup-btn').click();
    await page.waitForFunction(() => !document.querySelector('#ext-lookup-btn').disabled, null, { timeout: 90000 });
    return uiState(page);
}

(async () => {
    try {
        profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-ext-production-smoke-'));
        context = await chromium.launchPersistentContext(profile, {
            channel: 'chromium',
            headless: true,
            viewport: { width: 400, height: 1000 },
            args: [`--disable-extensions-except=${fixture.extensionRoot}`, `--load-extension=${fixture.extensionRoot}`]
        });
        context.on('request', (request) => {
            const u = new URL(request.url());
            if (/^https?:$/.test(u.protocol) && u.origin !== fixture.endpoint && request.method() === 'POST') {
                providerRequests.push({ origin: u.origin, method: request.method() });
            }
        });
        context.on('response', (response) => {
            const u = new URL(response.url());
            if (u.origin === fixture.endpoint) {
                network.push({ path: u.pathname, method: response.request().method(), status: response.status(), noStore: /no-store/.test(response.headers()['cache-control'] || '') });
            } else if (/^https?:$/.test(u.protocol) && response.request().method() === 'POST') {
                network.push({ providerOrigin: u.origin, method: 'POST', status: response.status() });
            }
        });
        const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
        const id = new URL(worker.url()).host;
        checks.push({ name: 'actual_extension_id', ok: true, detail: id });
        const page = await context.newPage();
        page.on('pageerror', (error) => pageErrors.push(String(error.message).replaceAll(fixture.token, '[redacted]')));
        await page.goto(`chrome-extension://${id}/lookup.html`);
        await page.waitForFunction(() => !!globalThis.__bdcExtensionRuntime);
        await page.locator('#ext-locale-select').selectOption('zh-CN');
        check('no_BDC_website_tab', context.pages().every((p) => !/^https?:/.test(p.url())));

        const publicChecks = await page.evaluate(async (endpoint) => {
            const capabilities = await fetch(`${endpoint}/auth-capabilities`);
            const methods = await capabilities.json();
            const unauthenticated = await fetch(`${endpoint}/ai-catalog`);
            const preflight = await fetch(`${endpoint}/snapshot`, {
                method: 'OPTIONS',
                headers: { 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'Authorization, Content-Type' }
            });
            return { capabilitiesStatus: capabilities.status, methods, unauthorizedStatus: unauthenticated.status, preflightStatus: preflight.status, allowOrigin: preflight.headers.get('access-control-allow-origin') };
        }, fixture.endpoint);
        check('production_auth_capabilities', publicChecks.capabilitiesStatus === 200 && publicChecks.methods.passwordLogin, publicChecks);
        check('production_authentication_required', publicChecks.unauthorizedStatus === 401);
        check('actual_extension_origin_preflight', publicChecks.preflightStatus === 204, { allowOrigin: publicChecks.allowOrigin });

        await page.locator('#ext-endpoint-input').fill(fixture.endpoint);
        await page.locator('#ext-login-mode').selectOption('token');
        await page.locator('#ext-token-input').fill(fixture.token);
        await page.locator('#ext-connect-btn').click();
        await page.waitForFunction(() => !document.querySelector('#ext-connect-btn').disabled, null, { timeout: 60000 });
        const connected = await uiState(page);
        check('production_disposable_account_login', connected.loggedIn && connected.userId === fixture.userId && connected.role === 'user', connected);
        check('production_managed_catalog_loaded', connected.catalog.usable && connected.catalog.providerCount > 0, connected.catalog);
        check('cloud_credentials_metadata_loaded', connected.credentialSync.status !== 'error', connected.credentialSync);
        check('submitted_token_cleared_from_input', await page.locator('#ext-token-input').inputValue() === '');

        await page.locator('#ext-word-input').fill('charge');
        await page.locator('#ext-sentence-input').fill('They charge £10 for admission.');
        const beforeLookup = await uiState(page);
        check('contextual_task_uses_managed_provider', beforeLookup.task.source === 'managed' && !!beforeLookup.task.model, beforeLookup.task);
        const cn = await lookup(page);
        check('real_AI_contextual_lookup_zh_CN', /[\u3400-\u9fff]/.test(cn.meaning) && /收|费|費|价|價/.test(cn.meaning), cn);
        check('provider_direct_request_observed', providerRequests.length >= 1, { requestCount: providerRequests.length, requests: providerRequests });
        check('managed_credential_downloaded_without_cache', network.some((r) => /^\/ai-catalog\/providers\/[^/]+\/credential$/.test(r.path || '') && r.status === 200 && r.noStore));
        await page.screenshot({ path: path.join(output, 'extension-production-zh-CN.png'), fullPage: true });

        const requestsBeforeCache = providerRequests.length;
        const cached = await lookup(page);
        check('real_lookup_cache_reused', cached.meaning === cn.meaning && providerRequests.length === requestsBeforeCache, { requestCount: providerRequests.length });

        await page.locator('#ext-locale-select').selectOption('zh-HK');
        const hk = await uiState(page);
        check('zh_HK_connected_and_model_status', /已連接帳戶/.test(hk.accountText) && /目前查詞模型/.test(hk.taskText), { accountText: hk.accountText, taskText: hk.taskText });
        await page.locator('#ext-word-input').fill('');
        const invalid = await lookup(page);
        check('zh_HK_empty_selection_error', /請|選取|輸入/.test(invalid.lookupNotice) && providerRequests.length === requestsBeforeCache, { notice: invalid.lookupNotice });
        check('no_horizontal_overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.screenshot({ path: path.join(output, 'extension-production-zh-HK.png'), fullPage: true });
        await page.locator('#ext-logout-btn').click();
        await page.waitForFunction(() => !globalThis.__bdcExtensionRuntime.getExtensionReadiness().loggedIn);
        check('logout_clears_account', !(await uiState(page)).loggedIn);
        check('worker_calls_remained_read_only', network.filter((r) => r.path).every((r) => ['GET', 'OPTIONS'].includes(r.method)));
        check('no_page_exceptions', pageErrors.length === 0, pageErrors);
    } catch (error) {
        checks.push({ name: 'execution', ok: false, detail: String(error.message).replaceAll(fixture.token, '[redacted]').slice(0, 1600) });
        process.exitCode = 1;
    } finally {
        if (context) await context.close();
        if (profile) fs.rmSync(profile, { recursive: true, force: true });
        const result = { timestamp: new Date().toISOString(), endpoint: fixture.endpoint, checks, network, providerRequests, pageErrors, mockUsed: false };
        fs.writeFileSync(path.join(output, 'live-extension-results.json'), JSON.stringify(result, null, 2) + '\n');
        console.log(JSON.stringify({ passed: checks.filter((x) => x.ok).length, failed: checks.filter((x) => !x.ok).length, providerRequests: providerRequests.length }));
    }
})();
