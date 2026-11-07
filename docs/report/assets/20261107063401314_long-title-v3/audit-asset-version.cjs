#!/usr/bin/env node
/**
 * V3 長標題最終覆驗 — 版本與載入資源核對（等價於 v2 的 asset-version-check）
 *  - 記錄 index.html 的 ?v= 版本、載入的 JS/CSS 資源版本
 *  - 統計外站請求（本次全部 abort）與 pageerror / console.error
 *  - 確認 @container 支援
 */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8313);
const BASE = `http://127.0.0.1:${PORT}/`;
const ASSET_DIR = __dirname;
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MOCK = `export const AI_LIMITS={default:{maxConcurrency:1,minIntervalMs:400}};
export const TTS_CONFIG={baseUrl:'',baseUrlRemote:'',baseUrlLocal:'',use:'remote',voicesUrl:'',apiKey:'',voices:{}};
export const OCR_CONFIG={DEFAULT_MODEL:''};
export const ARTICLE_IMPORT={FEED_URL:'',PROXY_URL:'',SOURCES:[]};
export const SYNC={};export const SUPABASE={};`;

(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: CHROME });
    const out = { ua: '', indexVersion: '', resources: {}, external: [], pageErrors: [], consoleErrors: [], containerQuery: null };
    for (const locale of ['zh-CN', 'zh-HK']) {
        const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale });
        const requests = [];
        await context.route('**/*', (route) => {
            const url = route.request().url();
            let parsed;
            try { parsed = new URL(url); } catch (_) { requests.push({ url, allowed: false }); return route.abort(); }
            if (parsed.pathname.endsWith('/ai-config.js')) {
                requests.push({ url, allowed: 'mock' });
                return route.fulfill({ status: 200, contentType: 'application/javascript', body: MOCK });
            }
            if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') {
                requests.push({ url, allowed: true });
                return route.continue();
            }
            requests.push({ url, allowed: false });
            return route.abort();
        });
        const page = await context.newPage();
        page.on('pageerror', (e) => out.pageErrors.push(String(e && e.message || e).slice(0, 200)));
        page.on('console', (m) => { if (m.type() === 'error') out.consoleErrors.push(m.text().slice(0, 200)); });
        await page.addInitScript(({ locale }) => {
            localStorage.clear();
            localStorage.setItem('pen_global_settings', JSON.stringify({ language: { interfaceLocale: locale }, assistant: { enabled: false } }));
            localStorage.setItem('vocabImportPromptShown', '1');
        }, { locale });
        await page.goto(BASE, { waitUntil: 'load' });
        await page.waitForTimeout(2500);
        out.ua = out.ua || await page.evaluate(() => navigator.userAgent);
        const info = await page.evaluate(() => ({
            supportsContainer: CSS.supports('container-type', 'inline-size'),
            indexVersion: (document.documentElement.outerHTML.match(/\?v=([A-Za-z0-9]+)/) || [])[1] || ''
        }));
        out.containerQuery = info.supportsContainer;
        out.indexVersion = out.indexVersion || info.indexVersion;
        const versioned = {};
        requests.forEach((r) => {
            if (!/\.(js|css)(\?|$)/.test(r.url) || r.url.includes('/ai-config.js')) return;
            const v = (r.url.match(/[?&]v=([A-Za-z0-9]+)/) || [])[1] || '(none)';
            versioned[v] = (versioned[v] || 0) + 1;
        });
        out.resources[locale] = {
            total: requests.length,
            jsCss: requests.filter((r) => /\.(js|css)(\?|$)/.test(r.url)).length,
            versionCounts: versioned,
            mocked: requests.filter((r) => r.allowed === 'mock').map((r) => new URL(r.url).pathname)
        };
        out.external = out.external.concat(requests.filter((r) => r.allowed === false).map((r) => r.url));
        await context.close();
    }
    await browser.close();
    const jsonPath = path.join(ASSET_DIR, 'asset-version-v3.json');
    fs.writeFileSync(jsonPath, JSON.stringify({ finishedAt: new Date().toISOString(), ...out }, null, 2));
    console.log(JSON.stringify({ indexVersion: out.indexVersion, containerQuery: out.containerQuery, externalRequests: out.external.length, pageErrors: out.pageErrors.length, consoleErrors: out.consoleErrors, resources: out.resources }, null, 2));
    console.log(`json: ${path.relative('/Users/linus/CODE/bdc', jsonPath)}`);
})();
