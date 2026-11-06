// Real MV3, native webpage selection, Worker/SQLite and injected sync faults.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { environment, ALICE } = require('./helpers/extension-mv3.cjs');
const ROOT = path.resolve(__dirname, '..');
const stamp = new Date(Date.now() + 8 * 3600000).toISOString().replace(/\D/g, '').slice(0, 17);
const OUT = process.env.ARTICLE_COMPACT_OUTPUT || path.join(ROOT, 'docs/report/assets', stamp + '_article-compact');
const checks = [];
function check(name, value, detail) {
    checks.push({ name, ok: !!value, ...(detail ? { detail } : {}) });
    console.log(`${value ? 'PASS' : 'FAIL'} ${name}`);
    assert.ok(value, name + (detail ? ': ' + JSON.stringify(detail) : ''));
}
async function openBooks(frame) {
    if (!await frame.locator('#ext-book-options').evaluate((node) => node.open)) await frame.locator('#ext-book-options > summary').click();
}
async function openFrame(context, base, endpoint, tag) {
    const page = await context.newPage(); await page.goto(endpoint + '/test-article?case=' + tag);
    const rect = await page.evaluate(() => {
        const node = document.querySelector('#article').firstChild;
        const start = node.textContent.indexOf('plunge');
        const range = document.createRange(); range.setStart(node, start); range.setEnd(node, start + 6);
        const r = range.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    await page.mouse.move(rect.x + 1, rect.y + rect.height / 2); await page.mouse.down();
    await page.mouse.move(rect.x + rect.width - 1, rect.y + rect.height / 2, { steps: 8 }); await page.mouse.up();
    await page.mouse.click(rect.x + 24, rect.y + rect.height + 20);
    let frame;
    for (let i = 0; i < 80; i += 1) {
        frame = page.frames().find((candidate) => candidate.url().startsWith(base + '/lookup.html'));
        if (frame) break;
        await page.waitForTimeout(100);
    }
    assert.ok(frame, 'trusted inline frame opens');
    await frame.locator('#ext-result-box').waitFor({ state: 'visible' });
    return { page, frame };
}
async function measure(frame) {
    return frame.evaluate(() => {
        const box = (id) => { const r = document.getElementById(id).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
        return { book: box('ext-capture-book'), add: box('ext-capture-save'), capture: box('ext-capture-section'),
            bodyHeight: document.body.getBoundingClientRect().height, scrollWidth: document.documentElement.scrollWidth, width: innerWidth,
            optionsOpen: document.querySelector('#ext-book-options').open };
    });
}
(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    execFileSync(process.execPath, ['scripts/package-extension.mjs'], { cwd: ROOT });
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-article-compact-'));
    let env, context, fault = 'none', releaseHold, held = false;
    const errors = [];
    try {
        env = await environment();
        const extension = path.join(ROOT, 'extension');
        context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
            viewport: { width: 1280, height: 900 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
        context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
        await context.route('**/vocabulary/books?*', async (route) => {
            if (!new URL(route.request().url()).searchParams.has('sourceUrl') || route.request().method() !== 'GET') return route.continue();
            if (fault === 'network') return route.abort('failed');
            if (fault === 'server') return route.fulfill({ status: 503, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/html' }, body: '<h1>Unavailable</h1>' });
            if (fault === 'auth') return route.fulfill({ status: 401, contentType: 'application/json', body: '{"code":"unauthorized"}' });
            if (fault === 'hold') { held = true; await new Promise((resolve) => { releaseHold = resolve; }); }
            await route.continue().catch(() => {});
        });
        const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
        const base = `chrome-extension://${new URL(worker.url()).host}`;
        const popup = await context.newPage(); await popup.goto(base + '/lookup.html');
        await popup.waitForFunction(() => !!document.querySelector('#ext-account-status').textContent);
        await popup.locator('#ext-endpoint-input').fill(env.base);
        await popup.locator('#ext-login-mode').selectOption('token'); await popup.locator('#ext-token-input').fill(ALICE); await popup.locator('#ext-connect-btn').click();
        await popup.waitForFunction(() => !document.querySelector('#ext-connect-btn').disabled && document.querySelector('#ext-account-status').textContent.includes('alice'));
        for (const locale of ['zh-CN', 'zh-HK']) {
            await popup.locator('#ext-locale-select').selectOption(locale);
            const { page, frame } = await openFrame(context, base, env.base, locale);
            await frame.locator('#ext-capture-book').selectOption('book');
            const initial = await measure(frame);
            check(locale + ' 詞書及加入按鈕同一行，收藏區不超過 50px', Math.abs(initial.book.y - initial.add.y) <= 2 && initial.capture.height <= 50 && !initial.optionsOpen, initial);
            const aiBefore = env.state.aiCalls;
            await frame.locator('#ext-capture-save').click();
            await frame.waitForFunction(() => document.querySelector('#ext-capture-save').textContent === '已加入');
            check(locale + ' 精簡按鈕仍保存展示釋義，成功不重複佔用提示行', env.state.aiCalls === aiBefore && (await measure(frame)).capture.height <= 50);
            await openBooks(frame); await frame.locator('#ext-book-page').click();
            await frame.waitForFunction(() => document.querySelector('#ext-capture-book').value.startsWith('webbook_'));
            const pageBookId = await frame.locator('#ext-capture-book').inputValue();
            check(locale + ' 新建詞書並選取後不殘留快取詞書不存在的提示', await frame.locator('#ext-capture-notice').isHidden());
            await frame.locator('#ext-book-options > summary').click();
            await frame.locator('#ext-inline-more').click();
            await frame.waitForTimeout(250);
            const expanded = await (await frame.frameElement()).boundingBox(), flow = await measure(frame);
            check(locale + ' 完整面板按內容收縮且仍固定於視窗內', expanded.height <= flow.bodyHeight + 4 && expanded.height < 650, { expanded, bodyHeight: flow.bodyHeight });
            if (locale === 'zh-CN') {
                fault = 'hold'; held = false;
                const beforeCancel = env.state.aiCalls;
                await frame.locator('#ext-article-extract').click();
                for (let i = 0; !held && i < 50; i += 1) await page.waitForTimeout(100);
                assert.ok(held, 'preflight request was intercepted');
                await frame.locator('#ext-article-cancel').click();
                await frame.waitForFunction(() => /停止/.test(document.querySelector('#ext-workspace-notice').textContent));
                check('預查仍在連線時可以取消，取消後不會開始 AI', env.state.aiCalls === beforeCancel && await frame.locator('#ext-article-preview').isHidden());
                fault = 'none'; releaseHold();
            }
            const countBefore = env.db.prepare("SELECT COUNT(*) AS n FROM articles WHERE owner_user_id='alice'").get().n;
            fault = locale === 'zh-CN' ? 'network' : 'server';
            const aiBeforeExtract = env.state.aiCalls;
            await frame.locator('#ext-article-extract').click();
            await frame.locator('#ext-article-preview').waitFor({ state: 'visible', timeout: 20000 });
            check(locale + ' 預查斷線或503仍取得標題正文與章節預覽', env.state.aiCalls === aiBeforeExtract + 1 && (await frame.locator('#ext-article-body').inputValue()).includes('## Outlook'));
            check(locale + ' 預查未確認會明確提示，預覽不寫入雲端', /保存|儲存/.test(await frame.locator('#ext-workspace-notice').textContent()) && env.db.prepare("SELECT COUNT(*) AS n FROM articles WHERE owner_user_id='alice'").get().n === countBefore);
            await frame.locator('#ext-article-save').waitFor({ state: 'visible' });
            await page.waitForTimeout(250);
            await page.screenshot({ path: path.join(OUT, 'preview-' + locale + '.png') });
            await frame.locator('#ext-article-save').click();
            await frame.waitForFunction(() => !document.querySelector('#ext-article-save').disabled || document.querySelector('#ext-workspace-pending').hidden === false);
            await frame.locator('#ext-workspace-pending').waitFor({ state: 'visible' });
            // Enqueue makes pending visible before the first send finishes.
            // Retry only after that attempt has settled, as a user would.
            await frame.locator('#ext-article-cancel').waitFor({ state: 'hidden' });
            check(locale + ' 保存仍斷線時保留待傳及不可變預覽，不假成功', await frame.locator('#ext-article-body').isDisabled() && await frame.locator('#ext-article-open').isHidden());
            const aiBeforeRetry = env.state.aiCalls;
            fault = 'none';
            await frame.locator('#ext-workspace-pending').evaluate((node) => { node.open = true; });
            await frame.locator('#ext-workspace-pending-list li button').first().click();
            await frame.locator('#ext-article-open').waitFor({ state: 'visible' });
            const book = JSON.parse(env.db.prepare("SELECT data_json FROM reading_entities WHERE owner_user_id='alice' AND entity_id=?").get(pageBookId).data_json);
            const saved = env.db.prepare("SELECT * FROM articles WHERE owner_user_id='alice' AND id=?").get(book.articleId);
            check(locale + ' 恢復連線後重試保存並關聯頁書，不再呼叫 AI', !!saved && saved.body.includes('## Outlook') && env.state.aiCalls === aiBeforeRetry && env.db.prepare("SELECT COUNT(*) AS n FROM articles WHERE owner_user_id='alice'").get().n === countBefore + 1);
            await frame.locator('#ext-inline-back').click();
            await page.setViewportSize({ width: 320, height: 700 }); await page.waitForTimeout(250);
            const narrow = await measure(frame);
            check(locale + ' 320px 詞書和加入仍同一行，沒有橫向溢出', Math.abs(narrow.book.y - narrow.add.y) <= 2 && narrow.scrollWidth <= narrow.width, narrow);
            await page.screenshot({ path: path.join(OUT, 'compact-' + locale + '.png') });
            await frame.locator('#ext-inline-close').click(); await page.close();
        }
        const { page, frame } = await openFrame(context, base, env.base, 'expired-session');
        await frame.locator('#ext-inline-more').click();
        const before401 = env.state.aiCalls; fault = 'auth';
        await frame.locator('#ext-article-extract').click();
        await frame.waitForFunction(() => document.querySelector('#ext-inline-status').hidden === false);
        check('401 不會當作可忽略的連線錯誤：登出並停止 AI，舊預覽清除', env.state.aiCalls === before401 && await frame.locator('#ext-article-preview').isHidden());
        check('正常及錯誤流程沒有未捕捉的 JS 例外', errors.length === 0, errors);
    } finally {
        if (releaseHold) releaseHold();
        fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ checks, errors }, null, 2));
        await context?.close(); await env?.close(); fs.rmSync(profile, { recursive: true, force: true });
    }
})().catch((error) => { console.error(error); process.exitCode = 1; });
