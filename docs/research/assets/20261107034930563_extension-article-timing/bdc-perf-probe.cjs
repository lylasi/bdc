// Scratch timing probe for the extension article extract -> preview -> confirm -> analyze -> save path.
// Lives outside the repo; no product code or existing tests are modified.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '/Users/linus/.local/share/fnm/node-versions/v24.20.0/installation/lib/node_modules/@playwright/cli/node_modules/playwright');
const { environment, ALICE, BOB } = require('/Users/linus/CODE/bdc/tests/helpers/extension-mv3.cjs');
const ROOT = '/Users/linus/CODE/bdc';
const OUT = '/tmp/bdc-perf-probe';
fs.mkdirSync(OUT, { recursive: true });

const WORKER_MS = Number(process.env.WORKER_MS || 120);
const AI_CLEAN_MS = Number(process.env.AI_CLEAN_MS || 600);
const AI_PARA_MS = Number(process.env.AI_PARA_MS || 600);
const ARTICLE_PARAS = Number(process.env.ARTICLE_PARAS || 6);
const LONG_CHARS = Number(process.env.LONG_CHARS || 1400);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

function articleHtml(paras, chars) {
    const body = paras.map((p, i) => `<p>Marker${i} ${'word '.repeat(Math.ceil(chars / 5))}</p>`).join('\n');
    return `<!doctype html><html><head><meta charset="utf-8"><title>Timing article</title></head><body><nav>NAV NOISE</nav><article><h1>Timing article</h1>${body}</article><footer>FOOT NOISE</footer></body></html>`;
}

(async () => {
    execFileSync(process.execPath, ['scripts/package-extension.mjs'], { cwd: ROOT });
    const env = await environment();
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-perf-'));
    const timeline = [];
    const events = [];
    const t0 = now();
    const mark = (kind, name, extra) => timeline.push({ t: now() - t0, kind, name, ...extra });
    let cleanupMarkdown = '# Timing article\n\n' + Array.from({ length: ARTICLE_PARAS }, (_, i) => `Para ${i}: sentence ${i}.`).join('\n\n');
    const ai = { cleanup: 0, para: 0, other: 0, s5Fail: false, extraCleanCount: 0 };
    let context, articleWindows = [];
    const failMode = process.env.FAIL_PARA == null ? null : Number(process.env.FAIL_PARA);
    try {
        context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
            viewport: { width: 1100, height: 900 },
            args: ['--disable-extensions-except=' + ROOT + '/extension', '--load-extension=' + ROOT + '/extension'] });
        context.on('page', (p) => { p.on('pageerror', (e) => events.push({ error: e.message })); p.on('framenavigated', (f) => { if (f === p.mainFrame() && f.url().includes('windowTicket=') && f.url().includes('view=article')) timeline.push({ t: now() - t0, kind: 'phase', name: 'article window document' }); }); });
        context.on('requestfailed', (r) => { if (r.url().includes('/mock-ai/')) events.push({ t: now() - t0, aborted: r.url(), reason: r.failure()?.errorText }); });
        context.on('request', (r) => {
            const url = r.url();
            if (url.startsWith(env.base) && !url.includes('/mock-ai/')) {
                const u = new URL(url);
                if (r.method() !== 'OPTIONS') timeline.push({ t: now() - t0, kind: 'worker', name: r.method() + ' ' + u.pathname + (u.search ? '?' + u.search.slice(1) : '') });
            }
        });
        // Artificial latency for all non-AI server calls (registered first so the
        // more specific routes below take precedence).
        await context.route(env.base + '/**', async (route) => {
            if (route.request().url().includes('/mock-ai/')) return route.fallback();
            await sleep(WORKER_MS);
            return route.continue();
        });
        await context.route(env.base + '/timing-article*', (route) => {
            const chars = Number(new URL(route.request().url()).searchParams.get('chars') || 120);
            const paras = Number(new URL(route.request().url()).searchParams.get('paras') || 2);
            route.fulfill({ status: 200, contentType: 'text/html', body: articleHtml(Array.from({ length: paras }, (_, i) => i), chars) });
        });
        await context.route(env.base + '/mock-ai/**', async (route) => {
            const req = route.request();
            if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' } });
            let body = {};
            try { body = req.postDataJSON() || {}; } catch (_) {}
            const prompt = (body.messages || []).map((m) => typeof m.content === 'string' ? m.content : '').join('\n');
            const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
            if (prompt.includes('Clean the supplied Markdown article')) {
                ai.cleanup += 1;
                timeline.push({ t: now() - t0, kind: 'ai', name: 'cleanup', start: true });
                await sleep(AI_CLEAN_MS);
                return route.fulfill({ status: 200, headers, body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: cleanupMarkdown } }] }) });
            }
            if (prompt.includes('Translate the following English paragraph')) {
                const m = prompt.match(/Para (\d+):/);
                const idx = m ? Number(m[1]) : -1;
                ai.para += 1;
                timeline.push({ t: now() - t0, kind: 'ai', name: 'para ' + idx, start: true });
                await sleep(AI_PARA_MS);
                const fail = failMode != null && ai.s5Fail && prompt.includes('S5 Para') && idx === failMode;
                if (fail) {
                    return route.fulfill({ status: 200, headers, body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{}' } }] }) });
                }
                return route.fulfill({ status: 200, headers, body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ chinese_translation: '译文 ' + idx }) } }] }) });
            }
            ai.other += 1;
            await sleep(AI_PARA_MS);
            return route.fulfill({ status: 200, headers, body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ word: 'w', analysis: { meaning: 'm', phonetic: '', pos: '' } }) } }] }) });
        });
        const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
        const base = 'chrome-extension://' + new URL(worker.url()).host;
        const popup = await context.newPage(); await popup.goto(base + '/lookup.html');
        await popup.waitForFunction(() => !!document.querySelector('#ext-account-status').textContent);
        const connect = async (page, token) => {
            if (!(await page.locator('#ext-settings-dialog').evaluate((n) => n.open))) await page.locator('#ext-settings-open').click();
            await page.locator('#ext-endpoint-input').fill(env.base);
            await page.locator('#ext-login-mode').selectOption('token');
            await page.locator('#ext-token-input').fill(token);
            await page.locator('#ext-connect-btn').click();
            await page.waitForFunction(() => !document.querySelector('#ext-connect-btn').disabled && /alice|bob/.test(document.querySelector('#ext-account-status').textContent), null, { timeout: 30000 });
            await page.locator('#ext-settings-close').click();
        };
        await connect(popup, ALICE);
        const articles = () => env.db.prepare("SELECT COUNT(*) AS n FROM articles WHERE owner_user_id='alice' AND deleted_at IS NULL").get().n;

        async function openArticleWindow(sourceUrl) {
            const source = await context.newPage(); await source.goto(sourceUrl); await source.bringToFront();
            const opening = context.waitForEvent('page');
            const start = now();
            // Only one extension popup window at a time: the background resolves
            // the active tab from the focused window, so close before reopening.
            const res = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'BDC_OPEN_WINDOW', view: 'article', autoImport: true }));
            if (!res?.ok) throw new Error('open failed ' + JSON.stringify(res));
            const page = await opening;
            articleWindows.push(page);
            await page.locator('#ext-article-preview').waitFor({ state: 'visible', timeout: 120000 });
            await page.waitForFunction(() => !document.querySelector('#ext-article-save').disabled && document.querySelector('#ext-article-cancel').hidden, null, { timeout: 120000 });
            return { page, source, total: now() - start, windowId: res.value.windowId };
        }

        // ---------- S1: warm-up + extraction timing on a small page ----------
        cleanupMarkdown = '# Timing article\n\nPara 0: sentence 0.';
        timeline.push({ t: now() - t0, kind: 'phase', name: 'S1 open' });
        const s1 = await openArticleWindow(env.base + '/timing-article?s1=1&paras=2&chars=120');
        const s1Mark = now();
        const s1State = await s1.page.evaluate(() => ({
            body: document.querySelector('#ext-article-body').value,
            notice: document.querySelector('#ext-workspace-notice').textContent,
            cleanupInput: performance.now()
        }));
        timeline.push({ t: s1Mark - t0, kind: 'phase', name: 'S1 preview visible' });
        await popup.evaluate((id) => chrome.windows.remove(id), s1.windowId);
        // ---------- S2: extraction chunking (long page) ----------
        cleanupMarkdown = '# Timing article\n\nPara 0: sentence 0.';
        const s2 = await openArticleWindow(env.base + '/timing-article?s2=1&paras=4&chars=' + LONG_CHARS);
        timeline.push({ t: now() - t0, kind: 'phase', name: 'S2 preview visible (long/chunked)' });
        await popup.evaluate((id) => chrome.windows.remove(id), s2.windowId);

        // ---------- S3: confirm -> analysis -> save (serial UI path) ----------
        cleanupMarkdown = '# Timing article\n\n' + Array.from({ length: ARTICLE_PARAS }, (_, i) => `Para ${i}: sentence ${i}.`).join('\n\n');
        const s3 = await openArticleWindow(env.base + '/timing-article?s3=1&paras=2&chars=120');
        const beforeSave = { para: ai.para, cleanup: ai.cleanup, articles: articles() };
        const tSave = now();
        await s3.page.locator('#ext-article-save').click();
        await s3.page.locator('#ext-article-open').waitFor({ state: 'visible', timeout: 180000 });
        const saveMs = now() - tSave;
        const saveCounts = { paraRequests: ai.para - beforeSave.para, cleanupRequests: ai.cleanup - beforeSave.cleanup };
        const saveRow = env.db.prepare("SELECT id, analysis_json FROM articles WHERE owner_user_id='alice' AND source_url=?").get(s3.source.url());
        const analysis = saveRow?.analysis_json ? JSON.parse(saveRow.analysis_json) : null;
        timeline.push({ t: now() - t0, kind: 'phase', name: 'S3 saved' });

        // ---------- S4: parallel what-if on real api.js in the article page ----------
        const scratch = s3.page;
        const whatIf = await scratch.evaluate(async () => {
            const api = await import('./modules/api.js');
            const time = async (label, fn) => { const t = performance.now(); const v = await fn(); return { label, ms: Math.round(performance.now() - t), v }; };
            const mk = (p) => `WhatIf-${p}: this is a benchmark paragraph with enough words to look like real prose.`;
            const seq = await time('seq-6', async () => {
                const out = [];
                for (let i = 0; i < 6; i += 1) out.push(await api.analyzeParagraph(mk('SEQ' + i), { level: 'quick' }));
                return out.map((r) => r.chinese_translation || 'FAIL');
            });
            const par = await time('par-6', async () => {
                const out = await Promise.all(Array.from({ length: 6 }, (_, i) => api.analyzeParagraph(mk('PAR' + i), { level: 'quick' })));
                return out.map((r) => r.chinese_translation || 'FAIL');
            });
            const chunks = ['ChunkA unique text. '.repeat(200), 'ChunkB unique text. '.repeat(200), 'ChunkC unique text. '.repeat(200)];
            const cleanSeq = await time('clean-seq-3', async () => {
                const out = [];
                for (const c of chunks) out.push(await api.aiCleanArticleMarkdown(c, { keepImages: false }));
                return out.length;
            });
            const cleanPar = await time('clean-par-3', async () => {
                const out = await Promise.all(chunks.map((c) => api.aiCleanArticleMarkdown(c, { keepImages: false })));
                return out.length;
            });
            return { seq, par, cleanSeq, cleanPar };
        });
        await popup.evaluate((id) => chrome.windows.remove(id), s3.windowId);

        // ---------- S5: failure isolation + retry cost ----------
        let s5 = null;
        if (failMode != null) {
            ai.s5Fail = true;
            cleanupMarkdown = '# Timing article\n\n' + Array.from({ length: ARTICLE_PARAS }, (_, i) => `S5 Para ${i}: sentence ${i}.`).join('\n\n');
            const win = await openArticleWindow(env.base + '/timing-article?s5=1&paras=2&chars=120');
            const before = { para: ai.para, articles: articles() };
            await win.page.locator('#ext-article-save').click();
            await win.page.waitForFunction(() => !document.querySelector('#ext-article-save').disabled && document.querySelector('#ext-workspace-notice').classList.contains('ext-notice-error'), null, { timeout: 120000 });
            const failState = {
                bodyPreserved: (await win.page.locator('#ext-article-body').inputValue()).includes('Para 0'),
                notice: await win.page.locator('#ext-workspace-notice').textContent(),
                paraRequests: ai.para - before.para,
                articles: articles() - before.articles
            };
            ai.s5Fail = false;
            const tRetry = now();
            await win.page.locator('#ext-article-save').click();
            await win.page.locator('#ext-article-open').waitFor({ state: 'visible', timeout: 180000 });
            s5 = { ...failState, retryMs: now() - tRetry, retryParaRequests: ai.para - before.para - failState.paraRequests,
                articlesAfter: articles() - before.articles };
            await popup.evaluate((id) => chrome.windows.remove(id), win.windowId);
        }

        // ---------- S6: abort mid-analysis (unique paragraph text: bypass cache) ----------
        cleanupMarkdown = '# Timing article\n\n' + Array.from({ length: 6 }, (_, i) => `S6 Para ${i}: sentence ${i}.`).join('\n\n');
        const s6 = await openArticleWindow(env.base + '/timing-article?s6=1&paras=2&chars=120');
        const s6before = { para: ai.para, articles: articles() };
        const failedBefore = events.filter((e) => e.aborted).length;
        await s6.page.locator('#ext-article-save').click();
        await s6.page.locator('#ext-article-cancel').waitFor({ state: 'visible', timeout: 10000 });
        await sleep(900);
        await s6.page.locator('#ext-article-cancel').click();
        await s6.page.waitForFunction(() => !document.querySelector('#ext-article-save').disabled, null, { timeout: 30000 });
        await sleep(400);
        const abortState = {
            notices: await s6.page.locator('#ext-workspace-notice').textContent(),
            body: (await s6.page.locator('#ext-article-body').inputValue()).slice(0, 40),
            abortedRequests: events.filter((e) => e.aborted).length - failedBefore,
            paraRequests: ai.para - s6before.para,
            articles: articles() - s6before.articles,
            cancelHidden: await s6.page.locator('#ext-article-cancel').isHidden(),
            saveDisabled: await s6.page.locator('#ext-article-save').isDisabled()
        };
        await popup.evaluate((id) => chrome.windows.remove(id), s6.windowId);

        // ---------- S7: re-extract an already imported page (pre-confirm write?) ----------
        const linkWritesBefore = timeline.filter((e) => e.kind === 'worker' && e.name.includes('/vocabulary/page-link')).length;
        const priorUrl = s3.source.url();
        const reopened = await context.newPage(); await reopened.goto(priorUrl); await reopened.bringToFront();
        const opening2 = context.waitForEvent('page');
        const reRes = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'BDC_OPEN_WINDOW', view: 'article', autoImport: true }));
        const rePage = await opening2;
        await sleep(2500);
        const reState = {
            notice: await rePage.locator('#ext-workspace-notice').textContent().catch(() => ''),
            previewVisible: await rePage.locator('#ext-article-preview').isVisible().catch(() => false),
            openVisible: await rePage.locator('#ext-article-open').isVisible().catch(() => false),
            linkWrites: timeline.filter((e) => e.kind === 'worker' && e.name.includes('/vocabulary/page-link')).length - linkWritesBefore,
            articlesUnchanged: articles()
        };
        if (reRes?.ok) await popup.evaluate((id) => chrome.windows.remove(id), reRes.value.windowId);

        const result = {
            config: { WORKER_MS, AI_CLEAN_MS, AI_PARA_MS, ARTICLE_PARAS, failMode },
            s1: { openToPreviewMs: s1.total, body: s1State.body, notice: s1State.notice },
            s2: { openToPreviewMs: s2.total },
            s3: { saveToOpenMs: saveMs, sections: analysis?.paragraph_analysis?.length || 0, ...saveCounts },
            whatIf, s5, s6: abortState, s7: reState,
            counts: { ...ai }, events,
            timeline,
            dbNote: saveRow?.id || ''
        };
        fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 2));
        console.log(JSON.stringify({ s1: result.s1, s2: result.s2, s3: result.s3, whatIf: {
            seq: whatIf.seq.ms, par: whatIf.par.ms, cleanSeq: whatIf.cleanSeq.ms, cleanPar: whatIf.cleanPar.ms }, s5: result.s5, s6: result.s6, s7: result.s7,
            ai: result.counts }, null, 2));
    } catch (error) {
        fs.writeFileSync(path.join(OUT, 'error.json'), JSON.stringify({ error: String(error && error.stack || error), timeline, events, ai }, null, 2));
        console.error(error);
        process.exitCode = 1;
    } finally {
        await context?.close(); await env.close(); fs.rmSync(profile, { recursive: true, force: true });
    }
})();
