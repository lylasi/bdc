// Browser regression test for the six issues of the independent review.
//
// Usage:
//   PLAYWRIGHT_MODULE=<path to playwright> node tests/ai-review-regressions.mjs
//
// Safety: no workspace HTTP server is started. Local files are served through a
// Playwright route whitelist, `ai-config.js` is always replaced by the
// secret-free `ai-config.example.js`, and every non-whitelisted request is
// aborted. Worker and provider calls are answered by an in-page mock; only fake
// keys (`test-...`) are used.
//
// Covered here (DOM level; the F1/F2/F3/F4/F6 module logic is covered by
// tests/ai-sync-regressions.test.mjs and tests/ai-provider-e2e.html):
//   F1/F3/F4  cold-device download, stale 401, account switch (module level)
//   F5        model discovery never widens the published whitelist
//   Admin UI  URL+Key form, protocol auto-detection, manual override, LAN
//             without a key, explicit model selection, per-provider failures,
//             zh-CN / zh-HK
//   Personal  two-field form, model selection, both locales
//
// This is a functional check only: the page does not load styles.css, so it is
// not a visual acceptance.

import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const results = [];
function check(name, ok, detail = '') {
    results.push({ name, ok, detail });
    const line = `${ok ? 'PASS' : 'FAIL'} · ${name}${detail ? ' · ' + detail : ''}`;
    console.log(line);
}
function assert(condition, message) {
    if (!condition) throw new Error(message || 'assertion failed');
}
async function run(name, fn) {
    try {
        const detail = await fn();
        check(name, true, typeof detail === 'string' ? detail : '');
    } catch (error) {
        check(name, false, `${error && error.message ? error.message : error}`);
    }
}

async function publishAndWait(page) {
    const before = await page.evaluate(() => globalThis.__publishCount || 0);
    await page.locator('[data-admin-publish]').click();
    await page.waitForFunction((count) => (globalThis.__publishCount || 0) > count, before);
    await page.locator('[data-admin-publish]').waitFor();
    return page.evaluate(() => globalThis.__published);
}

// 模型選擇器（modules/ai-model-picker.js）以 aria-pressed 的 chip 呈現，
// 不再使用 <input type=checkbox> 形式的模型列；以下三個小工具集中處理查詢。
async function modelChips(page, pickerId) {
    return page.evaluate((id) => {
        const root = document.querySelector(`[data-model-picker="${id}"]`);
        if (!root) return [];
        return [...root.querySelectorAll('.ai-model-option')].map((button) => ({
            id: button.dataset.pickerModel,
            pressed: button.getAttribute('aria-pressed') === 'true'
        }));
    }, pickerId);
}
async function pickedModels(page, pickerId) {
    return (await modelChips(page, pickerId)).filter((chip) => chip.pressed).map((chip) => chip.id);
}
async function clickModel(page, pickerId, modelId) {
    await page.evaluate(({ id, model }) => {
        const button = document.querySelector(`[data-model-picker="${id}"] [data-picker-model="${CSS.escape(model)}"]`);
        if (!button) throw new Error(`model ${model} not found in picker ${id}`);
        button.click();
    }, { id: pickerId, model: modelId });
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });

async function newPage(path = '/review') {
    const context = await browser.newContext();
    await context.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== 'http://bdc-review.test') return route.abort();
        const p = url.pathname;
        if (p === '/review') {
            return route.fulfill({ contentType: 'text/html', body: '<html><body><div id="host"></div></body></html>' });
        }
        if (p === '/ai-config.js') {
            return route.fulfill({ contentType: 'text/javascript', body: await readFile(`${root}/ai-config.example.js`, 'utf8') });
        }
        if (!/^\/(modules|locales|features|shared)\/[a-zA-Z0-9_./-]+\.(?:js|mjs)$/.test(p) && p !== '/tests/ai-provider-e2e.html') {
            return route.abort();
        }
        if (p.includes('..')) return route.abort();
        try {
            return route.fulfill({
                contentType: p.endsWith('.html') ? 'text/html' : 'text/javascript',
                body: await readFile(root + p, 'utf8')
            });
        } catch (_) {
            return route.abort();
        }
    });
    const page = await context.newPage();
    await page.goto(`http://bdc-review.test${path}`);
    return page;
}

try {
    // -----------------------------------------------------------------------
    // 0. The pre-existing E2E suite must stay green (12/12).
    // -----------------------------------------------------------------------
    {
        const page = await newPage('/tests/ai-provider-e2e.html');
        const out = await page.evaluate(() => runAITests());
        const failed = out.results.filter((item) => !item.ok);
        check('existing ai-provider-e2e page', out.passed === out.total && failed.length === 0,
            `${out.passed}/${out.total}${failed.length ? ' · ' + failed.map((item) => item.name).join(', ') : ''}`);
        await page.context().close();
    }

    // -----------------------------------------------------------------------
    // 1. Module level: F1 cold device, F3 stale 401, F4 account switch.
    // -----------------------------------------------------------------------
    {
        const page = await newPage();
        const report = await page.evaluate(async () => {
            globalThis.__BDC_SYNC_ENDPOINT__ = 'https://worker.mock';
            const realFetch = fetch;
            const calls = [];
            const json = (data, status = 200) => new Response(JSON.stringify(data), {
                status,
                headers: { 'Content-Type': 'application/json' }
            });
            const binding = {
                formatVersion: 1,
                format: 'openai-chat',
                apiUrl: 'https://provider.mock/v1/chat/completions',
                modelsUrl: 'https://provider.mock/v1/models',
                authMode: 'bearer'
            };
            const provider = { id: 'managed-test', name: 'Test', enabled: true, ...binding, models: [{ id: 'm1' }] };
            const remote = new Map();
            const remoteKeys = new Map();
            let holdCatalog = false;
            let releaseCatalog = null;
            let catalogOfflineForB = false;
            globalThis.fetch = async (input, init = {}) => {
                const url = new URL(typeof input === 'string' ? input : input.url);
                if (url.hostname === 'provider.mock') return json({ data: [{ id: 'm1' }] });
                if (url.hostname !== 'worker.mock') return realFetch(input, init);
                const token = String((init.headers && init.headers.Authorization) || '').replace(/^Bearer\s+/i, '');
                calls.push({ path: url.pathname, method: init.method || 'GET', token });
                if (url.pathname === '/me') {
                    if (!token) return json({ code: 'unauthorized' }, 401);
                    return json({ user_id: token === 'B' ? 'B' : 'A', role: 'user' });
                }
                if (url.pathname === '/ai-catalog') {
                    if (catalogOfflineForB && token === 'B') throw new TypeError('mock offline');
                    return json({
                        version: 1,
                        providers: [provider],
                        tasks: { assistant: { providerId: 'managed-test', model: 'm1' } },
                        expiresAt: new Date(Date.now() + 3600000).toISOString()
                    });
                }
                if (url.pathname.startsWith('/ai-catalog/providers/')) {
                    if (holdCatalog) {
                        holdCatalog = false;
                        return new Promise((resolve) => { releaseCatalog = resolve; });
                    }
                    return json({ apiKey: 'mock-shared', catalogVersion: 1, credentialRevision: 1, binding });
                }
                if (url.pathname === '/ai-credentials') {
                    return json({
                        items: [...remote.entries()].map(([providerId, row]) => ({
                            providerId,
                            version: row.version,
                            deleted: row.deleted,
                            binding: row.binding,
                            lastMutationId: row.lastMutationId
                        }))
                    });
                }
                if (url.pathname.startsWith('/ai-credentials/')) {
                    const providerId = decodeURIComponent(url.pathname.split('/').pop());
                    const key = remoteKeys.get(providerId);
                    if (!key) return json({ code: 'not_found' }, 404);
                    return json({ providerId, version: key.version, deleted: false, binding, apiKey: key.apiKey });
                }
                return json({ code: 'not_found' }, 404);
            };
            const { auth, getAuthSnapshot } = await import('/modules/sync-cloudflare.js');
            const catalog = await import('/modules/ai-catalog.js');
            const profile = await import('/modules/ai-profile-storage.js');
            const sync = await import('/modules/ai-credential-sync.js');
            const out = {};

            // F4: account A verifies and holds a shared key, then B logs in
            // directly (no sign-out) while B's catalog is unreachable.
            await auth.signInWithToken('A');
            await catalog.refreshAICatalog({ force: true });
            await catalog.getManagedCredential('managed-test');
            catalogOfflineForB = true;
            const beforeSwitch = catalog.getCatalogState();
            await auth.signInWithToken('B');
            await new Promise((resolve) => setTimeout(resolve, 60));
            const switched = catalog.getCatalogState();
            let reused = 'none';
            try { await catalog.getManagedCredential('managed-test'); reused = 'key-returned'; }
            catch (error) { reused = error.code; }
            out.switched = {
                before: beforeSwitch.status,
                status: switched.status,
                usable: catalog.isManagedUsable(),
                expiresAt: switched.expiresAt,
                keyRetained: !!catalog.peekManagedCredential('managed-test'),
                reused
            };
            catalogOfflineForB = false;
            await catalog.refreshAICatalog({ force: true });
            out.switchedAfterVerify = catalog.getCatalogState().status;

            // F3: a managed key download for A answers 401 after B logged in.
            holdCatalog = true;
            const pending = catalog.getManagedCredential('managed-test', { force: true }).catch((error) => error.code);
            while (!releaseCatalog) await new Promise((resolve) => setTimeout(resolve, 0));
            await auth.signOut();
            await auth.signInWithToken('B');
            await catalog.refreshAICatalog({ force: true });
            releaseCatalog(json({ code: 'unauthorized' }, 401));
            const staleCode = await pending;
            const snapshot = getAuthSnapshot();
            out.stale401 = { loggedIn: snapshot.loggedIn, userId: snapshot.userId, code: staleCode };

            // F1: blank profile, snapshot arrives with a provider definition,
            // the cloud still has its version-1 key.
            remote.clear();
            remoteKeys.clear();
            await auth.signInWithToken('A');
            remote.set('personal-test', { version: 1, deleted: false, binding, lastMutationId: 'remote1' });
            remoteKeys.set('personal-test', { apiKey: 'mock-personal', version: 1 });
            profile.applyRemoteAISettings({
                providers: {
                    'personal-test': {
                        label: 'Remote', enabled: true, format: 'openai-chat',
                        baseUrl: 'https://provider.mock/v1',
                        apiUrl: binding.apiUrl,
                        modelsUrl: binding.modelsUrl,
                        authMode: 'bearer',
                        allowedModels: ['m1'],
                        discoveredModels: [{ id: 'm1' }]
                    }
                },
                models: { assistant: 'personal-test:m1' }
            }, new Date().toISOString());
            const beforeCount = calls.length;
            await sync.syncCredentials({ reason: 'cold-device' });
            const loaded = profile.loadAIProfile();
            out.coldDevice = {
                status: sync.getCredentialSyncState().status,
                credentialCount: Object.keys(loaded.credentials).length,
                apiKey: loaded.credentials['personal-test'] ? loaded.credentials['personal-test'].apiKey : '',
                downloaded: calls.slice(beforeCount).some((call) => call.path === '/ai-credentials/personal-test'),
                taskModel: loaded.taskModels.assistant
            };

            // F2: a provider saved while an upload is in flight survives.
            let releasePut = null;
            const originalFetch = globalThis.fetch;
            globalThis.fetch = async (input, init = {}) => {
                const url = new URL(typeof input === 'string' ? input : input.url);
                if (url.pathname === '/ai-credentials/personal-upload' && String(init.method || 'GET') === 'PUT') {
                    return new Promise((resolve) => { releasePut = resolve; });
                }
                return originalFetch(input, init);
            };
            await sync.savePersonalProvider({
                providerId: 'personal-upload',
                provider: {
                    label: 'Upload', enabled: true, format: 'openai-chat',
                    baseUrl: 'https://provider.mock/v1', apiUrl: binding.apiUrl, modelsUrl: binding.modelsUrl,
                    authMode: 'bearer', allowedModels: ['m1'], discoveredModels: [{ id: 'm1' }]
                },
                apiKey: 'mock-upload',
                keyChanged: true,
                syncMode: 'cloud'
            });
            sync.stopCredentialSync();
            const running = sync.syncCredentials({ reason: 'race' });
            while (!releasePut) await new Promise((resolve) => setTimeout(resolve, 0));
            await sync.savePersonalProvider({
                providerId: 'personal-new',
                provider: {
                    label: 'Added during sync', enabled: true, format: 'openai-chat',
                    baseUrl: 'https://provider.mock/v1', apiUrl: binding.apiUrl, modelsUrl: binding.modelsUrl,
                    authMode: 'bearer', allowedModels: ['m1'], discoveredModels: [{ id: 'm1' }]
                },
                apiKey: 'mock-new',
                keyChanged: true,
                syncMode: 'local-only'
            });
            sync.stopCredentialSync();
            const beforeSave = !!profile.loadAIProfile().providers['personal-new'];
            releasePut(json({ providerId: 'personal-upload', version: 1, deleted: false, lastMutationId: 'x' }));
            await running;
            sync.stopCredentialSync();
            out.concurrentSave = {
                before: beforeSave,
                after: !!profile.loadAIProfile().providers['personal-new'],
                uploadVersion: profile.loadAIProfile().credentials['personal-upload'].version
            };
            globalThis.fetch = originalFetch;
            catalog.destroyAICatalog();
            sync.stopCredentialSync();
            return out;
        });

        await run('F1 new device downloads the cloud key and reports it', async () => {
            assert(report.coldDevice.credentialCount === 1, `credentialCount=${report.coldDevice.credentialCount}`);
            assert(report.coldDevice.apiKey === 'mock-personal', `key=${report.coldDevice.apiKey ? 'present' : 'missing'}`);
            assert(report.coldDevice.downloaded, 'no /ai-credentials/personal-test request');
            assert(report.coldDevice.status === 'synced', `status=${report.coldDevice.status}`);
            return JSON.stringify(report.coldDevice);
        });
        await run('F2 a provider saved during a sync survives', async () => {
            assert(report.concurrentSave.before, 'precondition: provider existed before the response');
            assert(report.concurrentSave.after, 'the provider was reverted by the finished sync');
            assert(report.concurrentSave.uploadVersion === 1, `version=${report.concurrentSave.uploadVersion}`);
            return JSON.stringify(report.concurrentSave);
        });
        await run('F3 a stale managed 401 does not sign out the new account', async () => {
            assert(report.stale401.loggedIn === true, 'the new account was signed out');
            assert(report.stale401.userId === 'B', `user=${report.stale401.userId}`);
            assert(report.stale401.code === 'stale_session', `code=${report.stale401.code}`);
            return JSON.stringify(report.stale401);
        });
        await run('F4 switching account locks shared keys until re-verified', async () => {
            const s = report.switched;
            assert(s.before === 'verified', `precondition status=${s.before}`);
            assert(s.status !== 'verified', `status after switch=${s.status}`);
            assert(!s.usable, 'managed providers still usable after the switch');
            assert(!s.keyRetained, 'the previous shared key was retained');
            assert(s.expiresAt === 0, `expiresAt=${s.expiresAt}`);
            assert(s.reused === 'managed_login_required' || s.reused === 'stale_session', `reused=${s.reused}`);
            assert(report.switchedAfterVerify === 'verified', `after verify=${report.switchedAfterVerify}`);
            return JSON.stringify(s);
        });
        await page.context().close();
    }

    // -----------------------------------------------------------------------
    // 2. Admin UI: URL+Key form, protocol detection, whitelist, locales.
    // -----------------------------------------------------------------------
    for (const locale of ['zh-CN', 'zh-HK']) {
        const page = await newPage();
        await page.setViewportSize({ width: 390, height: 844 });
        await page.evaluate(async (localeName) => {
            globalThis.__BDC_SYNC_ENDPOINT__ = 'https://worker.mock';
            const json = (data, status = 200) => new Response(JSON.stringify(data), {
                status,
                headers: { 'Content-Type': 'application/json' }
            });
            const binding = {
                formatVersion: 1,
                format: 'openai-chat',
                apiUrl: 'https://provider.mock/v1/chat/completions',
                modelsUrl: 'https://provider.mock/v1/models',
                authMode: 'bearer'
            };
            globalThis.__adminSeed = {
                version: 1,
                config: {
                    schemaVersion: 1,
                    providers: [
                        {
                            id: 'managed-test', name: 'Test', enabled: true, order: 0, ...binding,
                            models: [
                                { id: 'allowed-model', label: 'allowed-model', capabilities: { images: 'yes' } }
                            ]
                        },
                        {
                            id: 'managed-broken', name: 'Broken', enabled: true, order: 1,
                            format: 'openai-chat',
                            apiUrl: 'https://broken.mock/v1/chat/completions',
                            modelsUrl: 'https://broken.mock/v1/models',
                            authMode: 'bearer',
                            models: [{ id: 'kept-model', label: 'kept-model', capabilities: {} }]
                        }
                    ],
                    tasks: {}
                },
                credentials: {
                    'managed-test': { hasKey: true, credentialRevision: 1, binding },
                    'managed-broken': { hasKey: true, credentialRevision: 1, binding }
                },
                publishedBy: 'admin',
                publishedAt: new Date().toISOString()
            };
            globalThis.__published = null;
            globalThis.__publishCount = 0;
            globalThis.fetch = async (input, init = {}) => {
                const url = new URL(typeof input === 'string' ? input : input.url);
                const token = String((init.headers && init.headers.Authorization) || '').replace(/^Bearer\s+/i, '');
                if (url.hostname === 'api.anthropic.com') {
                    return json({ data: [{ id: 'claude-a', display_name: 'Claude A' }, { id: 'claude-b', display_name: 'Claude B' }] });
                }
                if (url.hostname === 'provider.mock') {
                    return json({ data: [{ id: 'allowed-model' }, { id: 'expensive-new-model' }] });
                }
                if (url.hostname === 'lan.mock') {
                    return json({ data: [{ id: 'lan-model' }] });
                }
                if (url.hostname === 'broken.mock') {
                    return json({ error: 'boom' }, 500);
                }
                if (url.hostname !== 'worker.mock') throw new TypeError(`blocked ${url.hostname}`);
                if (url.pathname === '/me') return json({ user_id: 'admin', role: 'admin' });
                if (url.pathname === '/admin/ai-catalog') return json(globalThis.__adminSeed);
                if (url.pathname === '/admin/ai-catalog/publish') {
                    globalThis.__published = JSON.parse(init.body);
                    globalThis.__publishCount += 1;
                    return json({ version: 2, publishedAt: new Date().toISOString() });
                }
                if (url.pathname === '/admin/ai-catalog/history') return json({ items: [] });
                if (url.pathname === '/ai-catalog') return json({ version: 1, providers: [], tasks: {} });
                return json({ code: 'not_found' }, 404);
            };
            const { setLocale } = await import('/modules/i18n.js');
            setLocale(localeName);
            const { auth } = await import('/modules/sync-cloudflare.js');
            await auth.signInWithToken('admin-token');
            const admin = await import('/features/ai-admin/ai-admin.js');
            admin.initAiAdmin();
            admin.openAiAdminPanel();
        }, locale);
        await page.locator('[data-admin-publish]').waitFor();

        await run(`[${locale}] admin add form starts with the two main fields`, async () => {
            await page.locator('[data-admin-add]').click();
            await page.locator('[data-admin-form-url]').waitFor();
            const visible = await page.locator('.ai-admin-newform input:visible').count();
            assert(visible === 2, `visible form inputs=${visible}`);
            return `${visible} inputs`;
        });

        await run(`[${locale}] admin add form auto-detects the protocol and requires explicit model selection`, async () => {
            await page.locator('[data-admin-form-url]').fill('https://api.anthropic.com');
            await page.locator('[data-admin-form-key]').fill('test-anthropic-key');
            await page.locator('[data-admin-form-connect]').click();
            await page.locator('[data-model-picker="admin-add"] .ai-model-option').first().waitFor();
            const approved = await pickedModels(page, 'admin-add');
            assert(approved.length === 0, `${approved.length} models were pre-approved: ${approved.join(',')}`);
            const disabled = await page.locator('[data-admin-form-add]').isDisabled();
            assert(disabled, 'the add button should stay disabled without a selection');
            const detected = await page.evaluate(async () => {
                const { t } = await import('/modules/i18n.js');
                const badge = document.querySelector('.ai-admin-newform .gs-ai-badge');
                return { expected: t('settings.aiFormatAnthropic'), actual: badge ? badge.textContent : '' };
            });
            assert(detected.actual.includes(detected.expected), `detected badge="${detected.actual}"`);
            return detected.actual;
        });

        await run(`[${locale}] admin add form publishes only the ticked models`, async () => {
            await clickModel(page, 'admin-add', 'claude-a');
            const enabled = await page.locator('[data-admin-form-add]').isEnabled();
            assert(enabled, 'the add button stayed disabled after ticking a model');
            await page.locator('[data-admin-form-add]').click();
            await page.locator('[data-admin-form-url]').waitFor({ state: 'detached' });
            const summary = await page.evaluate(() => {
                const cards = [...document.querySelectorAll('.ai-admin-card')];
                const card = cards[cards.length - 1];
                const picker = card.querySelector('[data-model-picker]');
                const chips = picker ? [...picker.querySelectorAll('.ai-model-option')] : [];
                return {
                    approved: chips.filter((chip) => chip.getAttribute('aria-pressed') === 'true').map((chip) => chip.dataset.pickerModel),
                    candidates: chips.filter((chip) => chip.getAttribute('aria-pressed') !== 'true').map((chip) => chip.dataset.pickerModel),
                    badge: card.querySelector('.gs-ai-badge') ? card.querySelector('.gs-ai-badge').textContent : '',
                    key: card.querySelector('[data-admin-key]') ? card.querySelector('[data-admin-key]').value : ''
                };
            });
            assert(summary.approved.length === 1 && summary.approved[0] === 'claude-a', `approved=${summary.approved.join(',')}`);
            assert(summary.candidates.includes('claude-b'), `the unticked candidate disappeared: ${summary.candidates.join(',')}`);
            assert(summary.key === 'test-anthropic-key', 'the key was not carried into the draft');
            return JSON.stringify({ approved: summary.approved, badge: summary.badge });
        });

        await run(`[${locale}] picking a model keeps the open sections open`, async () => {
            // 回歸：整個面板會重繪，若沒保存 <details> 狀態，選模型時
            // 「進階設定」會自己折疊（原本回報的「窗口自動折疊」）。
            const card = page.locator('[data-admin-card]').last();
            await card.locator('details summary').click();
            assert(await card.locator('details').evaluate((el) => el.open), 'the advanced section did not open');
            const pickerId = await card.locator('[data-model-picker]').getAttribute('data-model-picker');
            await clickModel(page, pickerId, 'claude-b');
            const stillOpen = await page.evaluate((id) => {
                const root = document.querySelector(`[data-model-picker="${id}"]`);
                return !!(root && root.closest('.ai-admin-card')?.querySelector('details')?.open);
            }, pickerId);
            assert(stillOpen, 'picking a model collapsed the advanced section');
            await card.locator('details summary').click();
            return pickerId;
        });

        await run(`[${locale}] admin LAN provider without a key can be added`, async () => {
            await page.locator('[data-admin-add]').click();
            await page.locator('[data-admin-form-url]').waitFor();
            await page.locator('[data-admin-form-url]').fill('http://lan.mock:8080/v1');
            await page.locator('[data-admin-form-connect]').click();
            await page.locator('[data-model-picker="admin-add"] .ai-model-option').first().waitFor();
            await clickModel(page, 'admin-add', 'lan-model');
            await page.locator('[data-admin-form-add]').click();
            await page.locator('[data-admin-form-url]').waitFor({ state: 'detached' });
            const noKey = await page.evaluate(() => {
                const cards = [...document.querySelectorAll('.ai-admin-card')];
                const card = cards[cards.length - 1];
                const select = card.querySelector('[data-admin-keyaction]');
                const picker = card.querySelector('[data-model-picker]');
                return {
                    options: [...select.options].map((option) => option.value),
                    text: select.options[select.selectedIndex].textContent,
                    approved: picker
                        ? [...picker.querySelectorAll('.ai-model-option[aria-pressed="true"]')].map((chip) => chip.dataset.pickerModel)
                        : []
                };
            });
            assert(noKey.options.length === 1 && noKey.options[0] === 'preserve', `key action=${noKey.options.join(',')}`);
            assert(noKey.approved.length === 1 && noKey.approved[0] === 'lan-model', `approved=${noKey.approved.join(',')}`);
            return `${noKey.text} · ${noKey.approved.join(',')}`;
        });

        await run(`[${locale}] admin can override the protocol in advanced settings`, async () => {
            await page.locator('[data-admin-add]').click();
            await page.locator('[data-admin-form-url]').waitFor();
            await page.locator('[data-admin-form-url]').fill('https://provider.mock/v1');
            await page.locator('[data-admin-form-key]').fill('test-override-key');
            await page.locator('[data-admin-form-advanced] summary').click();
            await page.locator('[data-admin-form-format]').selectOption('anthropic-messages');
            await page.locator('[data-admin-form-connect]').click();
            await page.locator('[data-model-picker="admin-add"] .ai-model-option').first().waitFor();
            const expected = await page.evaluate(async () => {
                const { t } = await import('/modules/i18n.js');
                return t('settings.aiFormatAnthropic');
            });
            const badge = await page.locator('.ai-admin-newform .gs-ai-badge').innerText();
            assert(badge.includes(expected), `protocol badge="${badge}" expected "${expected}"`);
            await page.locator('[data-admin-form-cancel]').click();
            await page.locator('[data-admin-form-url]').waitFor({ state: 'detached' });
            return badge;
        });

        await run(`[${locale}] F5 discovery never widens the approved model list`, async () => {
            const before = await pickedModels(page, 'admin-managed-test');
            assert(before.length === 1 && before[0] === 'allowed-model', `approved before=${before.join(',')}`);
            await page.locator('[data-admin-card="managed-test"] [data-admin-keyaction]').selectOption('replace');
            await page.locator('[data-admin-card="managed-test"] [data-admin-key]').fill('test-manager-key');
            await page.locator('[data-admin-card="managed-test"] [data-admin-discover]').click();
            await page.waitForFunction(() => {
                const card = document.querySelector('[data-admin-card="managed-test"]');
                return card && card.querySelector('[data-picker-model="expensive-new-model"]');
            });
            const after = {
                approved: await pickedModels(page, 'admin-managed-test'),
                chips: await modelChips(page, 'admin-managed-test')
            };
            assert(after.approved.length === 1 && after.approved[0] === 'allowed-model', `approved after=${after.approved.join(',')}`);
            assert(after.chips.some((chip) => chip.id === 'expensive-new-model' && !chip.pressed), 'the new model was auto-approved');
            return JSON.stringify(after);
        });

        await run(`[${locale}] F5 publish sends only the approved set and keeps capabilities`, async () => {
            const published = await publishAndWait(page);
            const payload = published.config.providers
                .filter((provider) => provider.id === 'managed-test')
                .map((provider) => ({ models: provider.models }));
            const models = payload[0] ? payload[0].models : [];
            assert(models.length === 1, `published models=${models.map((model) => model.id).join(',')}`);
            assert(models[0].id === 'allowed-model', `published=${models[0].id}`);
            assert(models[0].capabilities && models[0].capabilities.images === 'yes',
                `capabilities=${JSON.stringify(models[0].capabilities)}`);
            return JSON.stringify(models);
        });

        await run(`[${locale}] F5 an explicitly ticked candidate is published`, async () => {
            // The card re-renders on change, so click through the DOM instead of
            // a locator that Playwright would keep re-checking after the swap.
            await clickModel(page, 'admin-managed-test', 'expensive-new-model');
            const published = await publishAndWait(page);
            const ids = published.config.providers
                .find((item) => item.id === 'managed-test').models.map((model) => model.id);
            assert(ids.includes('allowed-model') && ids.includes('expensive-new-model'), `published=${ids.join(',')}`);
            return ids.join(',');
        });

        await run(`[${locale}] a failing provider does not block the others`, async () => {
            await page.locator('[data-admin-card="managed-broken"] [data-admin-keyaction]').selectOption('replace');
            await page.locator('[data-admin-card="managed-broken"] [data-admin-key]').fill('test-broken-key');
            await page.locator('[data-admin-card="managed-broken"] [data-admin-discover]').click();
            await page.waitForFunction(() => {
                const card = document.querySelector('[data-admin-card="managed-broken"]');
                const status = card && card.querySelector('.gs-ai-status.error');
                return !!status;
            });
            const state = await page.evaluate(() => {
                const broken = document.querySelector('[data-admin-card="managed-broken"]');
                const healthy = document.querySelector('[data-admin-card="managed-test"]');
                const picked = (card) => card && card.querySelector('[data-model-picker]')
                    ? [...card.querySelectorAll('[data-model-picker] .ai-model-option[aria-pressed="true"]')].map((chip) => chip.dataset.pickerModel)
                    : [];
                return {
                    brokenError: broken.querySelector('.gs-ai-status.error').textContent,
                    brokenApproved: picked(broken),
                    healthyApproved: picked(healthy),
                    publishEnabled: !document.querySelector('[data-admin-publish]').disabled
                };
            });
            assert(state.brokenApproved.length === 1 && state.brokenApproved[0] === 'kept-model', `broken approved=${state.brokenApproved.join(',')}`);
            assert(state.healthyApproved.length === 2, `healthy approved=${state.healthyApproved.join(',')}`);
            assert(state.publishEnabled, 'publishing was blocked by the failing provider');
            return state.brokenError;
        });

        await run(`[${locale}] admin UI strings are localised`, async () => {
            await page.locator('[data-admin-add]').click();
            await page.locator('[data-admin-form-add]').waitFor();
            const texts = await page.evaluate(async () => {
                const { t, getLocale } = await import('/modules/i18n.js');
                return {
                    locale: getLocale(),
                    newProvider: t('settings.aiAdminNewProvider'),
                    addToDraft: t('settings.aiAdminAddToDraft'),
                    approved: t('settings.aiAdminApprovedModels'),
                    candidatesHint: t('settings.aiAdminCandidatesHint'),
                    body: document.querySelector('.ai-admin-body').innerText
                };
            });
            assert(texts.locale === locale, `locale=${texts.locale}`);
            for (const [key, value] of Object.entries({
                newProvider: texts.newProvider,
                addToDraft: texts.addToDraft,
                approved: texts.approved
            })) {
                assert(texts.body.includes(value), `${key} ("${value}") missing from the rendered panel`);
            }
            return `${locale} ok`;
        });

        await page.evaluate(async () => {
            const admin = await import('/features/ai-admin/ai-admin.js');
            admin.destroyAiAdminPanel();
        });
        await page.context().close();
    }

    // -----------------------------------------------------------------------
    // 3. Personal provider UI keeps working in both locales.
    // -----------------------------------------------------------------------
    for (const locale of ['zh-CN', 'zh-HK']) {
        const page = await newPage();
        await page.setViewportSize({ width: 390, height: 844 });
        await page.evaluate(async (localeName) => {
            globalThis.__BDC_SYNC_ENDPOINT__ = '';
            const original = fetch;
            window.fetch = async (input, init = {}) => {
                if (String(input).startsWith('https://provider.mock')) {
                    return new Response(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] }), {
                        headers: { 'Content-Type': 'application/json' }
                    });
                }
                return original(input, init);
            };
            const { setLocale } = await import('/modules/i18n.js');
            setLocale(localeName);
            const { mountAIProviderSettings } = await import('/features/sync/ai-provider-settings.js');
            mountAIProviderSettings(document.getElementById('host'));
        }, locale);
        await run(`[${locale}] personal provider form keeps the two-field flow`, async () => {
            await page.locator('[data-ai-add]').click();
            const inputs = await page.locator('input:visible').count();
            assert(inputs === 2, `visible inputs=${inputs}`);
            await page.locator('[data-ai-form-url]').fill('https://provider.mock/v1');
            await page.locator('[data-ai-form-key]').fill('test-personal-key');
            await page.locator('[data-ai-connect]').click();
            await page.locator('[data-model-picker="personal"] .ai-model-option').first().waitFor();

            // 取得模型清單只代表「可用」，使用者仍需自己勾選；避免一次開放整份清單。
            const chips = await modelChips(page, 'personal');
            assert(chips.length === 2, `candidate chips=${chips.map((chip) => chip.id).join(',')}`);
            const approved = await pickedModels(page, 'personal');
            assert(approved.length === 0, `models were pre-approved: ${approved.join(',')}`);
            const selected = await page.locator('[data-ai-form-model]').inputValue();
            assert(selected === '', `a model was preselected (${selected})`);

            // 沒有勾選任何模型時儲存必須被阻止，而不是默默存一份空清單。
            await page.locator('[data-ai-form-save]').click();
            const error = await page.locator('.gs-ai-error').first().innerText();
            assert(error.trim().length > 0, 'saving without a model did not report an error');

            await clickModel(page, 'personal', 'model-b');
            const picked = await pickedModels(page, 'personal');
            assert(picked.length === 1 && picked[0] === 'model-b', `picked=${picked.join(',')}`);
            await page.locator('[data-ai-form-save]').click();
            const saved = await page.evaluate(async () => {
                const profile = (await import('/modules/ai-profile-storage.js')).loadAIProfile();
                const [provider] = Object.values(profile.providers);
                return {
                    providers: Object.keys(profile.providers).length,
                    model: profile.defaultModel,
                    allowed: provider ? provider.allowedModels : [],
                    discovered: provider ? (provider.discoveredModels || []).map((item) => item.id) : []
                };
            });
            assert(saved.providers === 1, `providers=${saved.providers}`);
            assert(saved.model.endsWith(':model-b'), `default=${saved.model}`);
            assert(saved.allowed.length === 1 && saved.allowed[0] === 'model-b', `allowed=${saved.allowed.join(',')}`);
            assert(saved.discovered.length === 2, `the deselected candidate was dropped: ${saved.discovered.join(',')}`);

            // 回歸：「按功能指定模型」選了模型後不應自己折疊（整個面板會重繪）。
            await page.locator('details[data-keep-open="ai-tasks"] summary').click();
            assert(await page.locator('details[data-keep-open="ai-tasks"]').evaluate((el) => el.open), 'the task section did not open');
            await page.locator('[data-ai-default-model]').selectOption({ index: 1 });
            const tasksOpen = await page.locator('details[data-keep-open="ai-tasks"]').evaluate((el) => el.open);
            assert(tasksOpen, 'the task section collapsed after picking a model');
            return JSON.stringify({ error, saved });
        });
        await page.context().close();
    }
} finally {
    await browser.close();
}

const failed = results.filter((item) => !item.ok);
console.log('');
console.log(`summary: ${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
    console.log(`failed: ${failed.map((item) => item.name).join(' | ')}`);
    process.exitCode = 1;
}
