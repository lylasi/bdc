// 真 MV3 + Worker/SQLite；只有供應商回應是 mock。
//
// 0.6.0 互動：登入／app URL 在首頁 #ext-settings-open 的 dialog；整頁文章擷取移到
// #ext-home-article 開啟的獨立文章 popup，不再放在查詞下拉或 inline 更多裡。
// 0.6.1 互動：收藏列只留 #ext-capture-save 與 #ext-book-settings；詞書下拉、
// 重整、建書按鈕與表單全在 #ext-book-settings 打開的原生 #ext-book-dialog，
// #ext-book-close 關閉；「建立預設生詞本」在 dialog 的 .ext-book-advanced details。
// 文章「在 BDC 打開」會導航同一個文章 popup（不是另開新分頁）。原業務斷言全部保留。
// 0.6.2：手動擷取先停在可編輯正文預覽（#ext-article-analyze 預設勾選）；
// 確認前不得寫入文章或送出逐段翻譯，按確認後才分析保存並保留頁書關聯。
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
// 確認閘門取證：直接監聽送往 mock AI 的請求內容。
const aiPromptRequests = [];
const promptCount = (needle) => aiPromptRequests.filter((item) => item.postData.includes(needle)).length;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
function check(name, condition, detail) {
    checks.push({ name, ok: !!condition, ...(detail ? { detail } : {}) });
    console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`);
    assert.ok(condition, name + (detail ? ': ' + JSON.stringify(detail) : ''));
}
async function waitFor(run, { timeout = 15000, interval = 100 } = {}) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
        try { const value = await run(); if (value) return value; } catch (_) { /* keep polling */ }
        await sleep(interval);
    }
    return false;
}
async function openSettings(scope) {
    const dialog = scope.locator('#ext-settings-dialog');
    if (await dialog.evaluate((node) => node.open).catch(() => false)) return;
    if (await scope.locator('#ext-inline-settings').isVisible().catch(() => false)) await scope.locator('#ext-inline-settings').click();
    else await scope.locator('#ext-settings-open').click();
    await waitFor(() => dialog.evaluate((node) => node.open).catch(() => false), { timeout: 5000 });
}
async function closeSettings(scope) {
    const dialog = scope.locator('#ext-settings-dialog');
    if (!(await dialog.evaluate((node) => node.open).catch(() => false))) return;
    await scope.locator('#ext-settings-close').click();
    await waitFor(async () => !(await dialog.evaluate((node) => node.open).catch(() => false)), { timeout: 5000 });
    await sleep(150);
}
async function openAccount(scope) {
    if (!(await scope.locator('#ext-account-details').evaluate((node) => node.open))) await scope.locator('#ext-account-summary').click();
}
async function openBookDialog(scope) {
    const dialog = scope.locator('#ext-book-dialog');
    const opened = () => dialog.evaluate((node) => node.open).catch(() => false);
    if (await opened()) return;
    // 上一個原生 dialog 的 close 事件會還原 inline 模式；先等交接完成。
    await scope.waitForFunction(() => !document.querySelector('dialog[open]')
        && !document.body.classList.contains('ext-modal-open'), null, { timeout: 5000 }).catch(() => {});
    await scope.locator('#ext-book-settings').click();
    if (!(await waitFor(opened, { timeout: 3000 }))) await scope.locator('#ext-book-settings').click();
    if (!(await waitFor(opened, { timeout: 5000 }))) throw new Error('book dialog did not open');
}
async function closeBookDialog(scope) {
    const dialog = scope.locator('#ext-book-dialog');
    const opened = () => dialog.evaluate((node) => node.open).catch(() => false);
    if (!(await opened())) return;
    await scope.locator('#ext-book-close').click();
    await waitFor(async () => !(await opened())
        && !(await scope.evaluate(() => document.body.classList.contains('ext-modal-open')).catch(() => true)), { timeout: 5000 });
    await sleep(100);
}
async function login(scope, endpoint, token = ALICE) {
    await openSettings(scope);
    await openAccount(scope);
    await scope.locator('#ext-endpoint-input').fill(endpoint);
    await scope.locator('#ext-login-mode').selectOption('token');
    await scope.locator('#ext-token-input').fill(token);
    await scope.locator('#ext-connect-btn').click();
    await scope.waitForFunction(() => !document.querySelector('#ext-connect-btn').disabled
        && document.querySelector('#ext-account-status').textContent.includes('alice'), null, { timeout: 30000 });
}
async function shellButtons(cdp) {
    let root;
    try { ({ root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true })); } catch (_) { return []; }
    const nodes = [];
    const walk = (node) => {
        if (node.nodeName === 'BUTTON') nodes.push(node);
        for (const child of node.children || []) walk(child);
        for (const shadow of node.shadowRoots || []) walk(shadow);
    };
    walk(root);
    const result = [];
    for (const node of nodes) {
        const model = await cdp.send('DOM.getBoxModel', { backendNodeId: node.backendNodeId }).then((value) => value.model).catch(() => null);
        if (!model || model.width < 8 || model.height < 8) continue;
        const attributes = {};
        const raw = node.attributes || [];
        for (let index = 0; index + 1 < raw.length; index += 2) attributes[raw[index]] = raw[index + 1];
        result.push({ attributes, className: String(attributes.class || ''), center: {
            x: (model.border[0] + model.border[2] + model.border[4] + model.border[6]) / 4,
            y: (model.border[1] + model.border[3] + model.border[5] + model.border[7]) / 4
        } });
    }
    return result;
}
async function openCard(article, cdp, extBase) {
    const rect = await article.evaluate(() => {
        const node = document.querySelector('#article').firstChild;
        const start = node.textContent.indexOf('plunge');
        const range = document.createRange(); range.setStart(node, start); range.setEnd(node, start + 6);
        const box = range.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height };
    });
    await article.mouse.move(rect.x + 1, rect.y + rect.height / 2); await article.mouse.down();
    await article.mouse.move(rect.x + rect.width - 1, rect.y + rect.height / 2, { steps: 8 }); await article.mouse.up();
    const button = await waitFor(async () => (await shellButtons(cdp)).find((item) => !/bdc-assistant-ball/.test(item.className)) || false);
    assert.ok(button, 'inline lookup button');
    await article.mouse.click(button.center.x, button.center.y);
    const frame = await waitFor(() => article.frames().find((candidate) => candidate.url().startsWith(extBase + '/lookup.html')) || false, { timeout: 15000 });
    assert.ok(frame, 'inline frame');
    await frame.waitForFunction(() => !!document.querySelector('#ext-result-meaning')?.textContent, null, { timeout: 30000 });
    return frame;
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
        context.on('request', (request) => {
            if (!request.url().includes('/mock-ai/')) return;
            const postData = request.postData();
            if (postData) aiPromptRequests.push({ url: request.url(), postData });
        });
        context.on('response', async (response) => {
            if (response.url() === env.base + '/vocabulary/books' && response.request().method() === 'POST') {
                bookResponses.push({ status: response.status(), body: await response.json().catch(() => null) });
            }
        });
        // BDC 文章在「同一個文章 popup」導航後載入，必須先有測試 session。
        await context.addInitScript(({ appBase, endpoint, token }) => {
            if (!String(location.origin).startsWith(appBase)) return;
            window.__BDC_SYNC_ENDPOINT__ = endpoint;
            localStorage.setItem('sync_token', token); localStorage.setItem('sync_user_id', 'alice');
            localStorage.setItem('sync_label', 'alice'); localStorage.setItem('sync_role', 'user');
            localStorage.setItem('vocabImportPromptShown', '1');
        }, { appBase: env.appBase, endpoint: env.base, token: ALICE });
        const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
        const base = `chrome-extension://${new URL(worker.url()).host}`;
        const popup = await context.newPage();
        await popup.goto(base + '/lookup.html');
        await popup.waitForFunction(() => !!document.querySelector('#ext-account-status').textContent);
        await popup.locator('#ext-settings-open').click();
        await login(popup, env.base);
        check('可信擴充套件帳戶已連接', (await popup.locator('#ext-account-status').textContent()).includes('alice'));
        await openAccount(popup);
        await popup.locator('#ext-app-url').fill(env.appBase);
        await popup.locator('#ext-app-url').dispatchEvent('change');
        await closeSettings(popup);

        const article = await context.newPage();
        await article.goto(env.base + '/test-article?strict=1');
        await article.bringToFront();
        await article.waitForFunction(() => !!document.querySelector('bdc-page-lookup'));
        const cdp = await context.newCDPSession(article);
        const inline = await openCard(article, cdp, base);
        check('選字旁小窗可查詞', (await inline.locator('#ext-result-word').textContent()) === 'plunge');
        // 0.6.1 收藏列只留「加入詞書」與詞書設定按鈕；舊的詞書下拉／重整／查看詞書
        // 與建書表單全部收進 #ext-book-dialog，未開 dialog 前不可見。
        check('收藏列只顯示加入詞書與詞書設定', await inline.locator('#ext-capture-save').isVisible()
            && await inline.locator('#ext-book-settings').isVisible()
            && !(await inline.locator('#ext-capture-book').isVisible())
            && !(await inline.locator('#ext-capture-refresh').isVisible())
            && !(await inline.locator('#ext-open-book').isVisible())
            && (await inline.locator('#ext-quick-capture').count()) === 0);
        await inline.locator('#ext-inline-more').click();
        await inline.waitForFunction(() => document.body.classList.contains('ext-expanded'), null, { timeout: 8000 });
        check('浮窗可用「更多」展開完整面板', await inline.evaluate(() => document.body.classList.contains('ext-expanded')));
        // 詞書操作在原生 dialog：選書／重整／建書與 advanced 預設操作都要先開 dialog。
        await openBookDialog(inline);
        check('詞書設定在原生 dialog 內開啟', await inline.locator('#ext-book-dialog').evaluate((node) => node.open)
            && await inline.locator('#ext-capture-book').isVisible()
            && await inline.locator('#ext-capture-refresh').isVisible()
            && await inline.locator('#ext-open-book').isVisible()
            && await inline.locator('#ext-book-page').isVisible()
            && await inline.locator('#ext-book-new').isVisible());
        await inline.locator('.ext-book-advanced summary').click();
        await inline.locator('#ext-book-default-create').click();
        await inline.waitForFunction(() => document.querySelector('#ext-capture-book').selectedOptions[0]?.textContent === '网页生词', null, { timeout: 20000 });
        const defaultId = await inline.locator('#ext-capture-book').inputValue();
        check('沒有預設時可直接建立並選用預設生詞本', !!defaultId);
        await inline.locator('#ext-book-page').click();
        await inline.waitForFunction(() => document.querySelector('#ext-capture-book').selectedOptions[0]?.textContent === 'Major tech stocks plunge', null, { timeout: 30000 });
        const pageBookId = await inline.locator('#ext-capture-book').inputValue();
        check('可直接建立並選用目前網頁詞書', pageBookId !== defaultId);
        // 選書在 dialog 內生效，關閉 dialog 後才按收藏列保存。
        await closeBookDialog(inline);
        const calls = env.state.aiCalls;
        await inline.locator('#ext-capture-save').click();
        await inline.waitForFunction(() => /已加入/.test(document.querySelector('#ext-capture-save').textContent), null, { timeout: 20000 });
        check('原網頁收藏沿用展示結果，不再呼叫 AI', env.state.aiCalls === calls);
        await article.screenshot({ path: path.join(OUT, 'inline-saved-zh-CN.png'), fullPage: true });

        // 整篇文章擷取移到 #ext-home-article 的獨立文章 popup
        const articleOpened = context.waitForEvent('page');
        await popup.evaluate(() => document.querySelector('#ext-home-article').click());
        const articleWindow = await articleOpened;
        const articleWindowUrl = await waitFor(() => articleWindow.url().includes('view=article') ? articleWindow.url() : false, { timeout: 15000 });
        check('首頁文章入口開啟獨立文章 popup', !!articleWindowUrl
            && new URL(articleWindowUrl).searchParams.get('view') === 'article'
            && await articleWindow.locator('#ext-page-article-section').isVisible());
        check('文章擷取不在 inline 更多內', !(await inline.locator('#ext-article-extract').isVisible()));
        const articlesBeforeExtract = env.db.prepare("SELECT COUNT(*) AS n FROM articles WHERE owner_user_id='alice'").get().n;
        const translationsBeforeExtract = promptCount('Translate the following English paragraph');
        await articleWindow.locator('#ext-article-extract').click();
        await articleWindow.locator('#ext-article-preview').waitFor({ state: 'visible', timeout: 60000 });
        check('AI 擷取有標題、正文及章節，可先預覽', await articleWindow.locator('#ext-article-title').inputValue() === 'Major tech stocks plunge'
            && (await articleWindow.locator('#ext-article-body').inputValue()).includes('## Outlook'));
        check('文章預覽預設勾選逐段分析，按鈕為確認並分析匯入', await articleWindow.locator('#ext-article-analyze').isChecked()
            && (await articleWindow.locator('#ext-article-save').textContent()).trim() === '确认并分析导入');
        await sleep(400);
        const articlesAtPreview = env.db.prepare("SELECT COUNT(*) AS n FROM articles WHERE owner_user_id='alice'").get().n;
        check('擷取預覽尚未寫入文章', articlesAtPreview === articlesBeforeExtract,
            { articlesBeforeExtract, articlesAtPreview });
        check('擷取預覽尚未送出逐段翻譯', promptCount('Translate the following English paragraph') === translationsBeforeExtract,
            { translationsBeforeExtract, translationsAtPreview: promptCount('Translate the following English paragraph') });
        const translationsBeforeSave = promptCount('Translate the following English paragraph');
        await articleWindow.locator('#ext-article-save').click();
        await articleWindow.locator('#ext-article-open').waitFor({ state: 'visible', timeout: 60000 });
        check('按確認後才送出逐段翻譯並保存', promptCount('Translate the following English paragraph') >= translationsBeforeSave + 3,
            { translationsBeforeSave, translationsAfterSave: promptCount('Translate the following English paragraph') });
        const row = env.db.prepare("SELECT data_json FROM reading_entities WHERE owner_user_id='alice' AND entity_type='vocabularyBook' AND entity_id=?").get(pageBookId);
        const book = JSON.parse(row.data_json);
        const saved = env.db.prepare("SELECT * FROM articles WHERE owner_user_id='alice' AND id=?").get(book.articleId);
        check('先建頁書再存文章可自動關聯', !!saved && book.sourceType === 'article');
        const analysis = JSON.parse(saved.analysis_json);
        check('文章詳解保存完整正文和選擇的逐段分析', saved.body.includes('## Outlook') && analysis.paragraph_analysis.length >= 3);
        check('網頁表單私有欄位未送入文章', !saved.body.includes('private-form-value'));
        // 文章 Open 導航同一個文章 popup
        await articleWindow.locator('#ext-article-open').click();
        const appUrl = await waitFor(() => articleWindow.url().startsWith(env.appBase) && articleWindow.url().includes('#a/') ? articleWindow.url() : false, { timeout: 30000 });
        check('在 BDC 打開會於同一個文章 popup 導航 #a/<id>', !!appUrl
            && decodeURIComponent(appUrl.split('#a/')[1]) === book.articleId, { appUrl, articleId: book.articleId });
        const app = articleWindow;
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
            await openSettings(inline);
            await inline.locator('#ext-locale-select').selectOption(locale);
            await closeSettings(inline);
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
                        bookDialogOpen: document.querySelector('#ext-book-dialog')?.open,
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
