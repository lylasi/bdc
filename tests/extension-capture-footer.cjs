// Real MV3 frames + Worker/SQLite. Only AI replies are mocked.
// Covers the one-row footer, automatic targets, concurrent first saves,
// explicit book dialogs, provenance, locales, and a lost create receipt.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { environment, ALICE, BOB } = require('./helpers/extension-mv3.cjs');
const ROOT = path.resolve(__dirname, '..');
const stamp = new Date(Date.now() + 8 * 3600000).toISOString().replace(/\D/g, '').slice(0, 17);
const OUT = process.env.FOOTER_OUTPUT || path.join(ROOT, 'docs/report/assets', stamp + '_extension-footer');
const checks = [];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function check(name, condition, detail) {
    checks.push({ name, ok: !!condition, detail });
    console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`);
    assert.ok(condition, detail ? `${name}: ${JSON.stringify(detail)}` : name);
}
async function waitFor(run) {
    for (let n = 0; n < 200; n++) { const value = await run(); if (value) return value; await pause(50); }
    throw new Error('Timed out waiting for state');
}
async function settings(popup) {
    if (!(await popup.locator('#ext-settings-dialog').evaluate((node) => node.open))) await popup.locator('#ext-settings-open').click();
}
async function login(popup, endpoint, token, user) {
    await settings(popup);
    if (!(await popup.locator('#ext-account-details').evaluate((node) => node.open))) await popup.locator('#ext-account-summary').click();
    await popup.locator('#ext-endpoint-input').fill(endpoint);
    await popup.locator('#ext-login-mode').selectOption('token');
    await popup.locator('#ext-token-input').fill(token);
    await popup.locator('#ext-connect-btn').click();
    await popup.waitForFunction((name) => !document.querySelector('#ext-connect-btn').disabled && document.querySelector('#ext-account-status').textContent.includes(name), user);
    await popup.locator('#ext-settings-close').click();
}
async function card(page, context, base) {
    await page.bringToFront();
    await page.waitForSelector('bdc-page-lookup');
    await page.evaluate(() => getSelection().removeAllRanges());
    const rect = await page.evaluate(() => {
        const node = document.querySelector('#article').firstChild;
        const start = node.textContent.indexOf('plunge');
        const range = document.createRange(); range.setStart(node, start); range.setEnd(node, start + 6);
        const box = range.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height };
    });
    await page.mouse.move(rect.x + 1, rect.y + rect.height / 2); await page.mouse.down();
    await page.mouse.move(rect.x + rect.width - 1, rect.y + rect.height / 2, { steps: 8 }); await page.mouse.up();
    const cdp = await context.newCDPSession(page);
    const box = await waitFor(async () => {
        const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
        const nodes = [];
        function visit(node) {
            if (node.nodeName === 'BUTTON' && !node.attributes?.includes('bdc-assistant-ball')) nodes.push(node);
            for (const child of [...node.children || [], ...node.shadowRoots || []]) visit(child);
        }
        visit(root);
        for (const node of nodes) {
            const result = await cdp.send('DOM.getBoxModel', { backendNodeId: node.backendNodeId }).catch(() => null);
            if (result?.model.width > 8 && result.model.height > 8) return result.model.border;
        }
        return null;
    });
    await page.mouse.click((box[0] + box[4]) / 2, (box[1] + box[5]) / 2);
    const frame = await waitFor(() => page.frames().find((item) => item.url().startsWith(base + '/lookup.html')));
    await frame.waitForFunction(() => !!document.querySelector('#ext-result-meaning').textContent);
    await cdp.detach();
    return frame;
}
async function openBooks(frame) { await frame.locator('#ext-book-settings').click(); await frame.locator('#ext-capture-book').waitFor({ state: 'visible' }); }
async function closeBooks(frame) {
    await frame.locator('#ext-book-close').click();
    await frame.waitForFunction(() => !document.querySelector('#ext-book-dialog').open && document.body.classList.contains('ext-compact'));
    await frame.waitForFunction(() => innerHeight <= Math.ceil(document.body.getBoundingClientRect().height) + 4);
}
async function save(frame) {
    await frame.locator('#ext-capture-save').click();
    await frame.waitForFunction(() => /已加入/.test(document.querySelector('#ext-capture-save').textContent));
}
async function row(frame, label) {
    const layout = await frame.evaluate(() => {
        const rect = (id) => { const r = document.getElementById(id).getBoundingClientRect(); return { x: r.x, y: r.y, h: r.height, w: r.width }; };
        return { save: rect('ext-capture-save'), settings: rect('ext-book-settings'), section: rect('ext-capture-section'),
            overflow: document.documentElement.scrollWidth > innerWidth };
    });
    check(label, Math.abs(layout.save.y - layout.settings.y) < 1 && layout.section.h <= 44 && !layout.overflow
        && !(await frame.locator('#ext-capture-book').isVisible()), layout);
}
(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    execFileSync(process.execPath, ['scripts/package-extension.mjs'], { cwd: ROOT });
    const env = await environment();
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-footer-'));
    const errors = [];
    let context;
    const books = (owner = 'alice') => env.db.prepare("SELECT entity_id,data_json FROM reading_entities WHERE owner_user_id=? AND entity_type='vocabularyBook' AND deleted_at IS NULL").all(owner).map((row) => ({ id: row.entity_id, ...JSON.parse(row.data_json) }));
    const entries = (owner = 'alice') => env.db.prepare("SELECT data_json FROM reading_entities WHERE owner_user_id=? AND entity_type='vocabularyEntry' AND deleted_at IS NULL").all(owner).map((row) => JSON.parse(row.data_json));
    try {
        await fetch(env.base + '/vocabulary/default', { method: 'PUT', headers: { Authorization: 'Bearer ' + ALICE, 'Content-Type': 'application/json' }, body: JSON.stringify({ bookId: 'book-2' }) });
        context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
            viewport: { width: 1200, height: 900 }, args: ['--disable-extensions-except=' + ROOT + '/extension', '--load-extension=' + ROOT + '/extension'] });
        context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
        const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
        const base = 'chrome-extension://' + new URL(worker.url()).host;
        const popup = await context.newPage(); await popup.goto(base + '/lookup.html');
        await popup.waitForFunction(() => !!document.querySelector('#ext-account-status').textContent);
        await login(popup, env.base, ALICE, 'alice');
        const page = await context.newPage(); await page.goto(env.base + '/test-article?footer=1');
        let frame = await card(page, context, base);
        const page2 = await context.newPage(); await page2.goto(env.base + '/test-article?footer=2');
        const frame2 = await card(page2, context, base);
        check('查詞不自動建立詞書，也不使用任意帳戶預設', books().length === 2 && (await frame.locator('#ext-capture-book').inputValue()) === '');
        check('首次加入直接可按，懸停說明網頁目標', await frame.locator('#ext-capture-save').isEnabled() && (await frame.locator('#ext-capture-save').getAttribute('title')).includes('网页'));
        await row(frame, '底部只有一行加入按鈕與詞書圖示');
        await page.screenshot({ path: path.join(OUT, 'footer-ready-zh-CN.png') });
        const calls = env.state.aiCalls;
        await Promise.all([save(frame), save(frame2)]);
        const web = books().filter((book) => book.name === '网页');
        check('兩個窗口首次同時收藏只建立一本網頁詞書', web.length === 1 && !web[0].sourceUrl, books());
        check('兩個窗口收藏均保留各自文章來源', entries().length === 1 && entries()[0].bookId === web[0].id && entries()[0].sources.length === 2, entries());
        check('建立後備不修改帳戶預設，也不重跑 AI', env.db.prepare("SELECT default_book_id FROM vocabulary_capture_settings WHERE owner_user_id='alice'").get().default_book_id === 'book-2' && env.state.aiCalls === calls);
        await row(frame, '成功狀態保持單行，不額外佔用提示列');
        await page.screenshot({ path: path.join(OUT, 'footer-zh-CN.png') });
        await openBooks(frame);
        check('詞書圖示開彈窗，選書及新建控制可用', await frame.locator('#ext-book-dialog').evaluate((node) => node.open) && await frame.locator('#ext-book-page').isVisible() && await frame.locator('#ext-book-new').isVisible());
        await frame.locator('#ext-book-page').click();
        await frame.waitForFunction(() => document.querySelector('#ext-capture-book').selectedOptions[0]?.textContent === 'Major tech stocks plunge');
        const pageBookId = await frame.locator('#ext-capture-book').inputValue();
        check('彈窗建立本頁詞書並選用', books().find((book) => book.id === pageBookId)?.sourceUrl === page.url());
        check('彈窗提供直接查看詞書入口', await frame.locator('#ext-open-book').isVisible() && await frame.locator('#ext-open-book').isEnabled());
        await page.screenshot({ path: path.join(OUT, 'book-dialog-zh-CN.png') });
        await closeBooks(frame); await save(frame);
        check('頁書保存原句、原文與定位', entries().find((entry) => entry.bookId === pageBookId)?.sources[0]?.sourceUrl === page.url()
            && entries().find((entry) => entry.bookId === pageBookId)?.sources[0]?.sentence.includes('stocks plunge')
            && entries().find((entry) => entry.bookId === pageBookId)?.sources[0]?.anchor.start >= 0);
        await openBooks(frame); await frame.locator('#ext-capture-book').selectOption('book-2'); await closeBooks(frame); await save(frame);
        check('可從彈窗改選其他詞書收藏', entries().some((entry) => entry.bookId === 'book-2'));
        await frame.locator('#ext-inline-close').click();
        await waitFor(() => !page.frames().some((item) => item.url().startsWith(base + '/lookup.html')));
        frame = await card(page, context, base);
        check('重開本頁優先頁書，不沿用其他手動目標', (await frame.locator('#ext-capture-book').inputValue()) === pageBookId);
        await frame2.locator('#ext-inline-close').click();
        await waitFor(() => !page2.frames().some((item) => item.url().startsWith(base + '/lookup.html')));
        const other = await card(page2, context, base);
        check('沒有頁書的文章自動用網頁詞書', (await other.locator('#ext-capture-book').inputValue()) === web[0].id);
        await openBooks(other); await other.locator('#ext-book-new').click();
        await other.locator('#ext-book-name').fill('My article collection'); await other.locator('#ext-book-submit').click();
        await other.waitForFunction(() => document.querySelector('#ext-capture-book').selectedOptions[0]?.textContent === 'My article collection');
        const customId = await other.locator('#ext-capture-book').inputValue();
        check('自訂詞書在彈窗建立，預設綁定本頁', books().find((book) => book.id === customId)?.sourceUrl === page2.url());
        await closeBooks(other);
        for (const locale of ['zh-HK', 'zh-CN']) {
            await frame.locator('#ext-inline-settings').click();
            await frame.locator('#ext-locale-select').selectOption(locale); await frame.locator('#ext-settings-close').click();
            await frame.waitForFunction((value) => document.documentElement.lang === value, locale);
            await frame.waitForFunction(() => document.body.classList.contains('ext-compact'));
            await page.setViewportSize({ width: 360, height: 720 });
            await row(frame, locale + ' 窄窗口保持單行且不溢出');
            await page.screenshot({ path: path.join(OUT, 'footer-' + locale + '-narrow.png') });
            await openBooks(frame);
            check(locale + ' 詞書彈窗文案與窄窗口正常', (await frame.locator('#ext-book-dialog-title').textContent()) === (locale === 'zh-HK' ? '詞書' : '词书')
                && (await frame.locator('#ext-capture-book').inputValue()) === pageBookId
                && await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.querySelector('#ext-book-dialog .ext-dialog-body').scrollWidth <= document.querySelector('#ext-book-dialog .ext-dialog-body').clientWidth));
            await page.screenshot({ path: path.join(OUT, 'book-dialog-' + locale + '-narrow.png') });
            await closeBooks(frame);
        }
        check('切換簡繁體未重複建立網頁詞書', books().filter((book) => ['网页', '網頁', '网页生词', '網頁生詞'].includes(book.name)).length === 1);
        // A lost create receipt must not mark a capture as saved or duplicate
        // the fallback when the user retries after the server already created it.
        await login(popup, env.base, BOB, 'bob');
        let lose = true;
        await context.route('**/vocabulary/books', async (route) => {
            if (route.request().method() !== 'POST' || !lose) return route.continue();
            lose = false; const response = await route.fetch(); assert.equal(response.status(), 200);
            return route.fulfill({ status: 503, contentType: 'application/json', body: '{"code":"capture_failed"}', headers: { 'Access-Control-Allow-Origin': '*' } });
        });
        const bobPage = await context.newPage(); await bobPage.goto(env.base + '/test-article?footer=bob');
        const bob = await card(bobPage, context, base);
        await bob.locator('#ext-capture-save').click();
        await bob.waitForFunction(() => !document.querySelector('#ext-capture-save').disabled && !!document.querySelector('#ext-capture-notice').textContent);
        check('建書回應遺失不誤報詞條已收藏', books('bob').filter((book) => book.name === '网页').length === 1 && entries('bob').length === 0
            && !(await bob.locator('#ext-capture-save').textContent()).includes('已加入'));
        await save(bob);
        check('重試沿用雲端已建立的網頁詞書，詞條只存一次', books('bob').filter((book) => book.name === '网页').length === 1 && entries('bob').length === 1);
        await openBooks(bob);
        const retry = bob.locator('#ext-workspace-pending-list button').first();
        if (await retry.isVisible()) { await retry.click(); await bob.waitForFunction(() => !document.querySelector('#ext-workspace-pending-list').children.length); }
        check('建書待傳可確認回執清除，不新增另一本', books('bob').filter((book) => book.name === '网页').length === 1);
        check('正常操作沒有未捕獲錯誤', errors.length === 0, errors);
    } finally {
        fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ checks, errors }, null, 2));
        await context?.close(); await env.close(); fs.rmSync(profile, { recursive: true, force: true });
    }
    console.log(`${checks.length}/${checks.length} checks passed; ${OUT}`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
