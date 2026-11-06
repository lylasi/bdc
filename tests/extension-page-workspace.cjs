const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { environment, ALICE } = require('./helpers/extension-mv3.cjs');
const ROOT = path.resolve(__dirname, '..');
const stamp = new Date(Date.now() + 8 * 3600000).toISOString().replace(/\D/g, '').slice(0, 17);
const OUT = process.env.PAGE_WORKSPACE_OUTPUT || path.join(ROOT, 'docs/report/assets', stamp + '_page-workspace');
const checks = [];
function check(name, condition, detail) {
    checks.push({ name, ok: !!condition, ...(detail ? { detail } : {}) });
    console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`);
    assert.ok(condition, name + (detail ? ': ' + JSON.stringify(detail) : ''));
}
(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    execFileSync(process.execPath, ['scripts/package-extension.mjs'], { cwd: ROOT });
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-inline-mv3-'));
    let env, context;
    const errors = [], consoles = [], bookResponses = [];
    try {
        env = await environment();
        const extension = path.join(ROOT, 'extension');
        context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
            viewport: { width: 1200, height: 900 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
        context.on('page', (p) => { p.on('pageerror', (e) => errors.push(e.message)); p.on('console', (e) => { if (e.type() === 'error') consoles.push(e.text()); }); });
        context.on('response', async (response) => {
            if (response.url() === env.base + '/vocabulary/books' && response.request().method() === 'POST') {
                bookResponses.push({ status: response.status(), body: await response.json().catch(() => null) });
            }
        });
        const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
        const base = `chrome-extension://${new URL(worker.url()).host}`;
        const popup = await context.newPage();
        await popup.goto(base + '/lookup.html');
        await popup.waitForFunction(() => !!document.querySelector('#ext-account-status').textContent);
        await popup.locator('#ext-endpoint-input').fill(env.base);
        await popup.locator('#ext-login-mode').selectOption('token');
        await popup.locator('#ext-token-input').fill(ALICE);
        await popup.locator('#ext-connect-btn').click();
        await popup.waitForFunction(() => !document.querySelector('#ext-connect-btn').disabled && document.querySelector('#ext-account-status').textContent.includes('alice'));
        check('可信擴充套件帳戶已連接', (await popup.locator('#ext-account-status').textContent()).includes('alice'));
        await popup.locator('#ext-book-default-create').click();
        await popup.waitForFunction(() => document.querySelector('#ext-capture-book').selectedOptions[0]?.textContent === '网页生词');
        const defaultId = await popup.locator('#ext-capture-book').inputValue();
        check('沒有預設時可直接建立並選用預設生詞本', !!defaultId);

        const article = await context.newPage();
        await article.goto(env.base + '/test-article?strict=1');
        const rect = await article.evaluate(() => {
            const node = document.querySelector('#article').firstChild;
            const start = node.textContent.indexOf('plunge');
            const range = document.createRange(); range.setStart(node, start); range.setEnd(node, start + 6);
            const r = range.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };
        });
        await article.mouse.move(rect.x + 1, rect.y + rect.height / 2); await article.mouse.down();
        await article.mouse.move(rect.x + rect.width - 1, rect.y + rect.height / 2, { steps: 8 }); await article.mouse.up();
        await article.mouse.click(rect.x + 26, rect.y + rect.height + 20);
        await article.waitForFunction(() => !!document.querySelector('bdc-page-lookup'));
        let inline;
        for (let attempt = 0; attempt < 50; attempt += 1) {
            inline = article.frames().find((f) => f.url().startsWith(base + '/lookup.html'));
            if (inline) break;
            await new Promise((r) => setTimeout(r, 100));
        }
        assert.ok(inline, 'inline frame attached');
        await inline.waitForFunction(() => !!document.querySelector('#ext-result-meaning').textContent, null, { timeout: 30000 });
        check('嚴格 CSP 的原網頁可直接浮窗查詞', (await inline.locator('#ext-result-word').textContent()) === 'plunge');
        check('浮窗沿用帳戶與明確預設詞書', await inline.locator('#ext-capture-book').inputValue() === defaultId);
        check('普通網頁無法讀取可信 iframe 的內容', await article.evaluate(() => {
            const node = document.querySelector('bdc-page-lookup'); return node.shadowRoot === null;
        }));
        await inline.locator('#ext-book-page').click();
        await inline.waitForFunction(() => document.querySelector('#ext-capture-book').selectedOptions[0]?.textContent === 'Major tech stocks plunge');
        const pageBookId = await inline.locator('#ext-capture-book').inputValue();
        check('可直接建立並選用目前網頁詞書', pageBookId !== defaultId);
        const calls = env.state.aiCalls;
        await inline.locator('#ext-capture-save').click();
        await inline.waitForFunction(() => /已加入/.test(document.querySelector('#ext-capture-save').textContent));
        check('原網頁收藏沿用展示結果，不再呼叫 AI', env.state.aiCalls === calls);
        await article.screenshot({ path: path.join(OUT, 'inline-saved-zh-CN.png'), fullPage: true });
        await inline.locator('#ext-article-extract').click();
        await inline.locator('#ext-article-preview').waitFor({ state: 'visible' });
        check('AI 擷取有標題、正文及章節，可先預覽', await inline.locator('#ext-article-title').inputValue() === 'Major tech stocks plunge'
            && (await inline.locator('#ext-article-body').inputValue()).includes('## Outlook'));
        await inline.locator('#ext-article-analyze').check();
        await inline.locator('#ext-article-save').click();
        await inline.locator('#ext-article-open').waitFor({ state: 'visible', timeout: 60000 });
        const row = env.db.prepare("SELECT data_json FROM reading_entities WHERE owner_user_id='alice' AND entity_type='vocabularyBook' AND entity_id=?").get(pageBookId);
        const book = JSON.parse(row.data_json);
        const saved = env.db.prepare("SELECT * FROM articles WHERE owner_user_id='alice' AND id=?").get(book.articleId);
        check('先建頁書再存文章可自動關聯', !!saved && book.sourceType === 'article');
        const analysis = JSON.parse(saved.analysis_json);
        check('文章詳解保存完整正文和選擇的逐段分析', saved.body.includes('## Outlook') && analysis.paragraph_analysis.length >= 3);
        check('網頁表單私有欄位未送入文章', !saved.body.includes('private-form-value'));
        await context.addInitScript(({ appBase, endpoint, token }) => {
            if (location.origin !== appBase) return;
            window.__BDC_SYNC_ENDPOINT__ = endpoint;
            localStorage.setItem('sync_token', token); localStorage.setItem('sync_user_id', 'alice');
            localStorage.setItem('sync_label', 'alice'); localStorage.setItem('sync_role', 'user');
            localStorage.setItem('vocabImportPromptShown', '1');
        }, { appBase: env.appBase, endpoint: env.base, token: ALICE });
        await popup.locator('#ext-app-url').fill(env.appBase);
        await popup.locator('#ext-app-url').dispatchEvent('change');
        await inline.waitForFunction((value) => document.querySelector('#ext-app-url').value === value, env.appBase);
        const opened = context.waitForEvent('page');
        await inline.locator('#ext-article-open').click();
        const app = await opened;
        await app.waitForURL('**/#a/**');
        await app.waitForFunction(() => !!document.querySelector('#article-input')?.value, null, { timeout: 30000 });
        check('可直接開啟 BDC 的同一篇文章詳解', app.url().includes(encodeURIComponent(book.articleId))
            && (await app.locator('#article-input').inputValue()).includes('People gather information'));
        const reused = await app.evaluate(async ({ id, title, sourceUrl }) => {
            await (await import('/modules/reading-sync.js')).syncReading();
            const storage = await import('/modules/storage.js');
            const state = await import('/modules/state.js');
            const before = state.vocabularyBooks.length;
            const result = storage.getOrCreateArticleWordbook({ id, title, sourceType: 'url', sourceUrl }, { createWordbook: true });
            return { id: result.wordbook.id, before, after: state.vocabularyBooks.length };
        }, { id: book.articleId, title: saved.title, sourceUrl: saved.source_url });
        check('文章詳解沿用已關聯的頁書，不另建空白詞書', reused.id === pageBookId && reused.before === reused.after);
        await app.screenshot({ path: path.join(OUT, 'website-imported-article.png'), fullPage: true });
        for (const locale of ['zh-HK', 'zh-CN']) {
            await inline.locator('#ext-locale-select').selectOption(locale, { force: true });
            check(locale + ' 浮窗沒有橫向溢出', await inline.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
            await article.screenshot({ path: path.join(OUT, 'inline-' + locale + '.png'), fullPage: true });
        }
        check('正常流程沒有未捕獲錯誤', errors.length === 0, errors);
    } catch (error) {
        process.exitCode = 1;
        checks.push({ name: 'execution', ok: false, detail: error.stack }); console.error(error.stack);
        if (context) {
            const debug = [];
            for (const p of context.pages()) {
                if (env && p.url().startsWith(env.appBase)) debug.push({ appUrl: p.url(), app: await p.evaluate(() => ({
                    text: document.body.innerText.slice(0, 5500), user: localStorage.getItem('sync_user_id'),
                    routeStatus: document.querySelector('#article-route-status')?.textContent,
                    input: document.querySelector('#article-input')?.value
                })).catch((e) => ({ error: e.message })) });
                for (const frame of p.frames().filter((f) => f.url().startsWith('chrome-extension://'))) {
                    debug.push({ url: frame.url(), state: await frame.evaluate(() => ({
                        notice: document.querySelector('#ext-workspace-notice')?.textContent,
                        captureNotice: document.querySelector('#ext-capture-notice')?.textContent,
                        account: document.querySelector('#ext-account-status')?.textContent,
                        choices: [...(document.querySelector('#ext-capture-book')?.options || [])].map((o) => ({ text: o.textContent, value: o.value })),
                        pending: document.querySelector('#ext-workspace-pending-list')?.textContent
                    })).catch((e) => ({ error: e.message })) });
                }
            }
            if (env) debug.push({ db: env.db.prepare("SELECT entity_id,data_json FROM reading_entities WHERE entity_type='vocabularyBook'").all(), preferences: env.db.prepare('SELECT * FROM vocabulary_capture_settings').all() });
            fs.writeFileSync(path.join(OUT, 'debug.json'), JSON.stringify({ debug, bookResponses }, null, 2));
        }
    } finally {
        if (context) await context.close(); if (env) await env.close(); fs.rmSync(profile, { recursive: true, force: true });
        fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ checks, errors, consoles, aiMocked: true, realMV3: true, realWorkerSQLite: true }, null, 2));
        console.log(JSON.stringify({ passed: checks.filter((c) => c.ok).length, failed: checks.filter((c) => !c.ok).length, output: OUT }));
    }
})();
