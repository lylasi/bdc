// Real production Worker/D1 and managed AI. Only the source article is synthetic.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fixture = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const OUT = __dirname, checks = [], errors = [], captures = [];
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-popup-production-'));
let context, server, popup, aiCalls = 0;
function check(name, ok, detail) {
    checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
    fs.writeFileSync(path.join(OUT, 'popup-smoke-progress.json'), JSON.stringify({ checks, aiCalls }, null, 2) + '\n');
    console.log((ok ? 'PASS ' : 'FAIL ') + name); assert.ok(ok, name);
}
async function api(route, body) {
    const result = await popup.evaluate(async ({ url, token, body }) => {
        const response = await fetch(url, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
            ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
        return { status: response.status, data: await response.json() };
    }, { url: fixture.endpoint + route, token: fixture.token, body });
    assert.ok([200, 201].includes(result.status), route + ': HTTP ' + result.status); return result.data;
}
(async () => {
    try {
        context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, viewport: { width: 1200, height: 900 },
            args: ['--disable-extensions-except=' + fixture.extensionRoot, '--load-extension=' + fixture.extensionRoot] });
        context.on('page', (p) => p.on('pageerror', (error) => errors.push(error.message)));
        context.on('request', (request) => {
            const url = new URL(request.url());
            if (request.method() === 'POST' && /chat\/completions|\/responses$|generateContent/.test(url.pathname)) aiCalls += 1;
            if (request.method() === 'POST' && url.origin === fixture.endpoint && url.pathname === '/captures') captures.push(request.postDataJSON());
        });
        const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
        const base = 'chrome-extension://' + new URL(worker.url()).host;
        popup = await context.newPage(); await popup.goto(base + '/lookup.html');
        await popup.waitForFunction(() => !!document.querySelector('#ext-account-status').textContent);
        await popup.locator('#ext-endpoint-input').fill(fixture.endpoint);
        await popup.locator('#ext-login-mode').selectOption('token'); await popup.locator('#ext-token-input').fill(fixture.token);
        await popup.locator('#ext-connect-btn').click();
        await popup.waitForFunction(() => !document.querySelector('#ext-connect-btn').disabled && !document.querySelector('#ext-book-default-create').disabled, null, { timeout: 60000 });
        await popup.locator('#ext-token-input').fill('');
        check('真 MV3 連上正式 Worker 的隔離普通帳戶', (await api('/vocabulary/books')).books.length === 0);
        server = http.createServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'self'; frame-src 'none'; script-src 'none'" });
            res.end('<!doctype html><meta charset="utf-8"><title>Major tech stocks plunge</title><article><h1>Major tech stocks plunge</h1><p id="article">Major tech stocks plunge as investors worry. Markets remain volatile.</p><h2>Outlook</h2><p>People gather information before making decisions.</p></article>');
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const sourceUrl = 'http://127.0.0.1:' + server.address().port + '/popup-release';
        const article = await context.newPage(); await article.goto(sourceUrl);
        const rect = await article.evaluate(() => {
            const node = document.querySelector('#article').firstChild, start = node.textContent.indexOf('plunge'), range = document.createRange();
            range.setStart(node, start); range.setEnd(node, start + 6); const b = range.getBoundingClientRect();
            return { x: b.x, y: b.y, width: b.width, height: b.height };
        });
        await article.mouse.move(rect.x + 1, rect.y + rect.height / 2); await article.mouse.down();
        await article.mouse.move(rect.x + rect.width - 1, rect.y + rect.height / 2, { steps: 8 }); await article.mouse.up();
        check('僅選詞不呼叫正式 AI', aiCalls === 0);
        await article.mouse.click(rect.x + 26, rect.y + rect.height + 20);
        let frame;
        for (let i = 0; i < 100; i += 1) { frame = article.frames().find((f) => f.url().startsWith(base + '/lookup.html')); if (frame) break; await article.waitForTimeout(100); }
        assert.ok(frame, 'inline frame attached');
        await frame.waitForFunction(() => !!document.querySelector('#ext-result-meaning').textContent, null, { timeout: 180000 });
        await article.waitForTimeout(150);
        const box = await (await frame.frameElement()).boundingBox();
        check('正式 AI 查詞成功且小窗緊貼選詞', (await frame.locator('#ext-result-word').textContent()) === 'plunge'
            && box.width === 340 && box.x < rect.x + 10 && box.y >= rect.y + rect.height && box.y < rect.y + rect.height + 25 && box.height < 600, { box, selection: rect });
        const emptyHint = await frame.locator('#ext-capture-book option').first().textContent();
        check('空詞書提示引導直接在此新建', /在此新建/.test(emptyHint) && !/BDC/.test(emptyHint), emptyHint);
        await article.screenshot({ path: path.join(OUT, 'production-compact.png'), fullPage: true });
        const beforeCapture = aiCalls;
        await frame.locator('#ext-quick-capture').click();
        await frame.waitForFunction(() => /已加入/.test(document.querySelector('#ext-capture-save').textContent), null, { timeout: 60000 });
        check('無詞書可直接建立本頁詞書並收藏，不重跑 AI', captures.length === 1 && aiCalls === beforeCapture);
        const receipt = await api('/captures', captures[0]);
        const listing = await api('/vocabulary/books?sourceUrl=' + encodeURIComponent(sourceUrl));
        const entry = (await api('/reading/batch', { keys: [{ entityType: 'vocabularyEntry', entityId: receipt.entryId }] })).entities[0];
        check('正式 D1 回執與原意、原句、來源及定位正確', receipt.ok && receipt.bookId === listing.pageBookId
            && entry.meaning === captures[0].meaning && entry.sources[0].sourceUrl === sourceUrl && entry.sources[0].anchor.quote === 'plunge');
        await article.screenshot({ path: path.join(OUT, 'production-captured.png'), fullPage: true });
        const beforeExpand = aiCalls;
        await frame.locator('#ext-inline-more').click(); await frame.waitForFunction(() => document.body.classList.contains('ext-expanded'));
        check('更多保留同一個結果及 iframe，不重跑 AI', aiCalls === beforeExpand && await frame.locator('#ext-result-word').textContent() === 'plunge');
        await frame.locator('#ext-article-extract').click();
        await frame.locator('#ext-article-preview').waitFor({ state: 'visible', timeout: 180000 });
        check('完整面板可用正式 AI 提取文章及章節', (await frame.locator('#ext-article-body').inputValue()).includes('## Outlook'));
        await frame.locator('#ext-inline-close').click(); await frame.locator('#ext-inline-confirm').waitFor({ state: 'visible' });
        await frame.locator('#ext-inline-keep').click();
        check('關閉前保護未保存文章，繼續編輯可保留正文', await frame.locator('#ext-article-preview').isVisible());
        await frame.locator('#ext-article-save').click(); await frame.locator('#ext-article-open').waitFor({ state: 'visible', timeout: 60000 });
        const after = await api('/vocabulary/books?sourceUrl=' + encodeURIComponent(sourceUrl));
        check('正式保存文章後自動關聯本頁詞書', !!after.articleId && after.books.find((book) => book.id === receipt.bookId)?.articleId === after.articleId);
        await context.addInitScript(({ website, endpoint, token, userId }) => {
            if (location.origin !== new URL(website).origin) return;
            window.__BDC_SYNC_ENDPOINT__ = endpoint;
            for (const [key, value] of Object.entries({ sync_token: token, sync_user_id: userId, sync_label: 'BDC popup release probe', sync_role: 'user', vocabImportPromptShown: '1' })) localStorage.setItem(key, value);
        }, fixture);
        await popup.locator('#ext-app-url').fill(fixture.website); await popup.locator('#ext-app-url').dispatchEvent('change');
        await frame.waitForFunction((url) => document.querySelector('#ext-app-url').value === url, fixture.website);
        const opened = context.waitForEvent('page'); await frame.locator('#ext-article-open').click();
        const app = await opened; await app.waitForFunction(() => !!document.querySelector('#article-input')?.value, null, { timeout: 60000 });
        check('已更新的 149 主站可開啟該文章詳解', app.url().includes(after.articleId) && (await app.locator('#article-input').inputValue()).includes('People gather information'));
        await app.screenshot({ path: path.join(OUT, 'production-website.png'), fullPage: true });
        await frame.locator('#ext-inline-back').click(); await frame.waitForFunction(() => document.body.classList.contains('ext-compact'));
        check('保存後可返回小窗並保留查詞結果', await frame.locator('#ext-result-word').textContent() === 'plunge');
        await article.bringToFront(); await article.mouse.click(1150, 850);
        for (let i = 0; i < 100 && !frame.isDetached(); i += 1) await article.waitForTimeout(50);
        check('點文章外面可收起已完成的小窗', frame.isDetached());
        check('正式流程沒有未捕獲頁面錯誤', errors.length === 0, errors);
    } catch (error) { checks.push({ name: 'execution', ok: false, detail: error.stack }); console.error(error.stack); process.exitCode = 1; }
    finally {
        if (context) await context.close(); if (server) await new Promise((resolve) => server.close(resolve));
        fs.rmSync(profile, { recursive: true, force: true });
        fs.writeFileSync(path.join(OUT, 'popup-smoke-results.json'), JSON.stringify({ checks, errors, aiCalls, realMV3: true, realProductionD1: true,
            aiMocked: false, syntheticSource: true, browserProfileRemoved: !fs.existsSync(profile) }, null, 2) + '\n');
        console.log(JSON.stringify({ passed: checks.filter((c) => c.ok).length, failed: checks.filter((c) => !c.ok).length }));
    }
})();
