#!/usr/bin/env node
// 只讀驗證：從「真正載入的 MV3 擴充套件」來源檢查正式 Worker 的公開接口。
//
// 安全邊界（本腳本刻意如此設計）：
//   - 不登入、不帶任何 token／fixture、不讀取任何憑證檔案。
//   - 只發出 GET 與 OPTIONS；不送出任何寫入型請求。
//   - 只使用拋棄式臨時 profile，結束後立即刪除；不接觸使用者真實 Chrome profile。
//   - 不輸出敏感值（Authorization／secret bindings／完整設定）。
//
// 用法：
//   PLAYWRIGHT_MODULE=<playwright> node verify-readonly-public-api.cjs [輸出目錄]
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const ENDPOINT = process.env.BDC_ENDPOINT || 'https://bdc-sync-api.penzibdc.workers.dev';
const EXT_ROOT = process.env.BDC_EXTENSION_ROOT || '/Users/linus/CODE/bdc-extension-ai-proof-20261105/extension';
const OUT_DIR = process.argv[2] || __dirname;
const ENDPOINT_ORIGIN = new URL(ENDPOINT).origin;

const checks = [];
const workerRequests = [];
const workerResponses = [];
const pageErrors = [];
let originObservation = null;

function check(name, ok, detail) {
    checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ' :: ' + JSON.stringify(detail)}`);
}

function recordRequest(request) {
    let url;
    try { url = new URL(request.url()); } catch (_) { return; }
    if (url.origin !== ENDPOINT_ORIGIN) return;
    const headers = request.headers() || {};
    const origin = headers.origin || '';
    workerRequests.push({
        path: url.pathname,
        method: request.method(),
        hasOriginHeader: !!origin,
        originIsExtension: /^chrome-extension:\/\//.test(origin),
        hasAuthorization: !!headers.authorization,
        hasCookie: !!headers.cookie
    });
}

function recordResponse(response) {
    let url;
    try { url = new URL(response.url()); } catch (_) { return; }
    if (url.origin !== ENDPOINT_ORIGIN) return;
    const headers = response.headers() || {};
    workerResponses.push({
        path: url.pathname,
        method: response.request().method(),
        status: response.status(),
        allowOrigin: headers['access-control-allow-origin'] || null,
        allowMethods: headers['access-control-allow-methods'] || null,
        allowHeaders: headers['access-control-allow-headers'] || null,
        cacheControl: headers['cache-control'] || null
    });
}

let profile = null;
let context = null;

(async () => {
    try {
        if (!fs.existsSync(path.join(EXT_ROOT, 'manifest.json'))) throw new Error('extension manifest missing at ' + EXT_ROOT);
        profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-ext-readonly-'));
        context = await chromium.launchPersistentContext(profile, {
            channel: 'chromium',
            headless: true,
            viewport: { width: 420, height: 1000 },
            args: [`--disable-extensions-except=${EXT_ROOT}`, `--load-extension=${EXT_ROOT}`]
        });
        context.on('request', recordRequest);
        context.on('response', recordResponse);

        const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30000 });
        const extensionId = new URL(worker.url()).host;
        check('extension_service_worker_present', !!extensionId, { extensionId });

        const page = await context.newPage();
        page.on('pageerror', (error) => pageErrors.push(String(error.message).slice(0, 300)));
        await page.goto(`chrome-extension://${extensionId}/lookup.html`);
        await page.waitForFunction(() => !!globalThis.__bdcExtensionRuntime, null, { timeout: 20000 });

        const identity = await page.evaluate(() => ({
            pageUrl: location.href,
            origin: location.origin,
            manifestVersion: chrome.runtime.getManifest().manifest_version,
            name: chrome.runtime.getManifest().name
        }));
        check('extension_page_origin_is_extension', /^chrome-extension:\/\//.test(identity.origin), identity.origin);
        check('extension_manifest_is_mv3', identity.manifestVersion === 3, { manifestVersion: identity.manifestVersion });

        const probe = await page.evaluate(async (endpoint) => {
            const readErrorCode = async (response) => {
                try {
                    const body = await response.json();
                    return typeof body.error === 'string' ? body.error : (typeof body.code === 'string' ? body.code : null);
                } catch (_) { return null; }
            };
            const out = {};
            const capabilities = await fetch(`${endpoint}/auth-capabilities`, { cache: 'no-store', signal: AbortSignal.timeout(20000) });
            out.capabilitiesStatus = capabilities.status;
            const capabilityBody = await capabilities.json().catch(() => null);
            out.capabilityKeys = capabilityBody ? Object.keys(capabilityBody).sort() : [];
            out.capabilityFlags = capabilityBody ? {
                pairingLogin: capabilityBody.pairingLogin,
                loginLinks: capabilityBody.loginLinks,
                passwordLogin: capabilityBody.passwordLogin
            } : null;
            out.capabilitiesNoStore = /no-store/.test(capabilities.headers.get('cache-control') || '');

            const anonymousCatalog = await fetch(`${endpoint}/ai-catalog`, { cache: 'no-store', signal: AbortSignal.timeout(20000) });
            out.anonymousCatalogStatus = anonymousCatalog.status;
            out.anonymousCatalogErrorCode = await readErrorCode(anonymousCatalog);

            const preflight = await fetch(`${endpoint}/snapshot`, {
                method: 'OPTIONS',
                headers: {
                    'Access-Control-Request-Method': 'GET',
                    'Access-Control-Request-Headers': 'Authorization, Content-Type'
                },
                signal: AbortSignal.timeout(20000)
            });
            out.preflightStatus = preflight.status;
            out.preflightAllowOrigin = preflight.headers.get('access-control-allow-origin');
            out.preflightAllowMethods = preflight.headers.get('access-control-allow-methods');
            out.preflightAllowHeaders = preflight.headers.get('access-control-allow-headers');

            const anonymousSnapshot = await fetch(`${endpoint}/snapshot`, { cache: 'no-store', signal: AbortSignal.timeout(20000) });
            out.anonymousSnapshotStatus = anonymousSnapshot.status;
            out.anonymousSnapshotErrorCode = await readErrorCode(anonymousSnapshot);
            return out;
        }, ENDPOINT);

        check('auth_capabilities_200_from_extension_origin', probe.capabilitiesStatus === 200 && probe.capabilityFlags
            && probe.capabilityFlags.pairingLogin === true && probe.capabilityFlags.loginLinks === true, {
            status: probe.capabilitiesStatus,
            keys: probe.capabilityKeys,
            flags: probe.capabilityFlags
        });
        check('anonymous_ai_catalog_401', probe.anonymousCatalogStatus === 401, {
            status: probe.anonymousCatalogStatus,
            error: probe.anonymousCatalogErrorCode
        });
        check('snapshot_options_204', probe.preflightStatus === 204, {
            status: probe.preflightStatus,
            allowOrigin: probe.preflightAllowOrigin,
            allowMethods: probe.preflightAllowMethods,
            allowHeaders: probe.preflightAllowHeaders
        });
        check('anonymous_snapshot_get_401', probe.anonymousSnapshotStatus === 401, {
            status: probe.anonymousSnapshotStatus,
            error: probe.anonymousSnapshotErrorCode
        });
        check('extension_page_responses_no_store', probe.capabilitiesNoStore === true, { noStore: probe.capabilitiesNoStore });

        // 補充檢查：以 Node 端明確帶上擴充套件 Origin 的 preflight（瀏覽器端擴充套件具 host_permissions，
        // 不會自行產生 CORS preflight，故以獨立客戶端驗證伺服器對 chrome-extension:// 來源的 preflight 回應）。
        const nodePreflight = await context.request.fetch(`${ENDPOINT}/snapshot`, {
            method: 'OPTIONS',
            headers: {
                Origin: `chrome-extension://${extensionId}`,
                'Access-Control-Request-Method': 'GET',
                'Access-Control-Request-Headers': 'Authorization, Content-Type'
            },
            timeout: 20000
        });
        const nodePreflightHeaders = nodePreflight.headers();
        check('explicit_extension_origin_preflight_204', nodePreflight.status() === 204, {
            status: nodePreflight.status(),
            allowOrigin: nodePreflightHeaders['access-control-allow-origin'] || null
        });

        // 僅記錄、不作為判定：擴充套件具 host_permissions 時 Chrome 可能省略 Origin 標頭，
        // 因此「線上有無 Origin」屬觀察事實，不能用來判定 CORS 是否經瀏覽器強制執行。
        originObservation = {
            extensionOrigin: `chrome-extension://${extensionId}`,
            requestsCarryingExtensionOrigin: workerRequests.filter((r) => r.originIsExtension).length,
            requestsWithoutOriginHeader: workerRequests.filter((r) => !r.hasOriginHeader).length,
            note: 'ALLOW_ORIGIN=* 前提下伺服器一律回 Access-Control-Allow-Origin: *，故此項不作為來源限制的證據。'
        };

        const methods = [...new Set(workerRequests.map((r) => r.method))].sort();
        check('all_worker_requests_read_only', methods.every((m) => m === 'GET' || m === 'OPTIONS'), { methods });
        check('no_authorization_header_sent', workerRequests.every((r) => !r.hasAuthorization), {
            authorizedRequestCount: workerRequests.filter((r) => r.hasAuthorization).length
        });
        check('no_page_exceptions', pageErrors.length === 0, pageErrors);

        await page.screenshot({ path: path.join(OUT_DIR, 'extension-origin-readonly.png'), fullPage: false });
    } catch (error) {
        checks.push({ name: 'execution', ok: false, detail: String(error && error.message || error).slice(0, 1200) });
        process.exitCode = 1;
    } finally {
        if (context) await context.close().catch(() => {});
        if (profile) fs.rmSync(profile, { recursive: true, force: true });
        const failed = checks.filter((c) => !c.ok);
        const result = {
            timestamp: new Date().toISOString(),
            endpoint: ENDPOINT,
            extensionRoot: EXT_ROOT,
            privilegedProfileUsed: false,
            profileRemoved: profile !== null && !fs.existsSync(profile),
            readOnly: true,
            passed: checks.length - failed.length,
            failed: failed.length,
            checks,
            workerRequests,
            workerResponses,
            pageErrors,
            originObservation
        };
        fs.writeFileSync(path.join(OUT_DIR, 'readonly-public-api-results.json'), JSON.stringify(result, null, 2) + '\n');
        console.log(JSON.stringify({ passed: result.passed, failed: result.failed, workerRequestCount: workerRequests.length, profileRemoved: result.profileRemoved }));
        if (failed.length) process.exitCode = 1;
    }
})();
