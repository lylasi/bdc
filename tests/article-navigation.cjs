/**
 * 私人文章直達、刷新恢復與逐篇本機草稿的瀏覽器回歸。
 * 所有遠端服務均使用 mock，不連接真實帳戶、AI 或同步服務。
 * PORT=8313 PLAYWRIGHT_MODULE=<path-to-playwright> node tests/article-navigation.cjs
 * BASE_URL=https://<host> 可檢查正式靜態資源，帳戶與同步仍全部使用 mock。
 */
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const BASE = (process.env.BASE_URL || `http://127.0.0.1:${Number(process.env.PORT || 8313)}`).replace(/\/$/, '');
const ENDPOINT = `${BASE}/navigation-mock`;
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const A = { id: 'local:bookmark-a', title: 'Article A', body: 'We look forward to meeting you.' };
const B = { id: 'url:bookmark-b', title: 'Article B', body: 'Please read the next chapter.' };

function analysis(body) {
    return {
        chinese_translation: '已保存的譯文',
        paragraph_analysis: [{ chinese_translation: '已保存的譯文', sentences: [{ en: body, zh: '已保存的譯文' }] }],
        detailed_analysis: []
    };
}

function remote(id, body, title = id) {
    return { id, body, title, analysis: analysis(body), revision: 1, sourceType: 'paste', sourceUrl: '',
        createdAt: '2026-10-28T00:00:00.000Z', updatedAt: '2026-10-28T00:00:00.000Z' };
}

async function fixture(browser, locale = 'zh-CN', endpoint = ENDPOINT) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    const calls = [];
    const docs = new Map();
    const held = new Map();
    await context.addInitScript(({ endpoint, locale }) => {
        window.__BDC_SYNC_ENDPOINT__ = endpoint;
        const settings = JSON.parse(localStorage.getItem('pen_global_settings') || '{}');
        settings.language = { ...settings.language, interfaceLocale: locale };
        localStorage.setItem('pen_global_settings', JSON.stringify(settings));
    }, { endpoint, locale });
    await context.route('**/*', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.pathname.endsWith('/ai-config.js')) {
            return route.fulfill({ contentType: 'application/javascript',
                body: 'export const SYNC={endpoint:""},TTS_CONFIG={},AI_LIMITS={},OCR_CONFIG={},ARTICLE_IMPORT={},SUPABASE={};' });
        }
        if (url.href.startsWith(ENDPOINT + '/')) {
            const path = url.pathname.slice(new URL(ENDPOINT).pathname.length);
            const token = request.headers().authorization?.replace(/^Bearer /, '') || '';
            const user = token === 'token-a' ? 'user-a' : token === 'token-b' ? 'user-b' : '';
            const reply = (status, data) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
            if (path === '/me') return reply(user ? 200 : 401, { user_id: user, label: user });
            if (request.method() === 'GET' && path.startsWith('/articles/') && !path.includes('/changes')) {
                const id = decodeURIComponent(path.slice('/articles/'.length));
                calls.push({ user, id });
                const key = `${user}:${id}`;
                if (held.has(key)) await held.get(key).promise;
                const doc = docs.get(key);
                if (doc === 'network') return reply(503, { error: 'mock_unavailable' });
                if (doc === 'unauthorized') return reply(401, { error: 'mock_expired' });
                return doc ? reply(200, { article: doc, deleted: !!doc.deletedAt }) : reply(404, { error: 'not_found' });
            }
            // 阻止背景同步上傳測試資料，單篇導覽必須可以獨立成功。
            return reply(503, { error: 'background_sync_disabled' });
        }
        if (url.origin !== BASE) return route.abort();
        return route.continue();
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    async function load(hash = '#a', reload = false) {
        const initialized = page.waitForEvent('console', { predicate: (message) => message.text().startsWith('应用程序已'), timeout: 20000 });
        if (reload) await page.reload({ waitUntil: 'domcontentloaded' });
        else await page.goto(BASE + '/' + hash, { waitUntil: 'domcontentloaded' });
        await initialized;
        await page.evaluate(async () => { (await import('/modules/ui.js')).closeModal(); });
    }
    async function hold(user, id) {
        let release;
        const promise = new Promise((resolve) => { release = resolve; });
        held.set(`${user}:${id}`, { promise });
        return () => { held.delete(`${user}:${id}`); release(); };
    }
    await load();
    return { context, page, load, docs, calls, errors, hold };
}

async function seed(page, items) {
    const results = await page.evaluate(async (items) => {
        const store = await import('/modules/article-store.js');
        return Promise.all(items.map((item) => store.saveArticle({
            articleId: item.id, article: item.body, title: item.title, sourceType: 'paste', result: item.result
        })));
    }, items.map((item) => ({ ...item, result: analysis(item.body) })));
    assert(results.every((result) => result.ok), JSON.stringify(results));
}

async function snapshot(page, id) {
    return page.evaluate(async (id) => {
        const state = await import('/modules/state.js');
        const store = await import('/modules/article-store.js');
        const record = id ? await store.ensureArticleLoaded(id) : null;
        return {
            id: state.currentArticleId, value: document.getElementById('article-input').value,
            body: record?.article, result: record?.result,
            rendered: document.getElementById('article-analysis-container').textContent,
            status: document.getElementById('article-route-message').textContent,
            draft: await store.readDraft({ recordId: id || '' }),
            notice: !document.getElementById('article-draft-notice').classList.contains('hidden')
        };
    }, id);
}

async function hash(page, value) {
    await page.evaluate((value) => { location.hash = value; }, value);
}

// waitForFunction 會把 Promise 物件視作 truthy；非同步條件必須等 evaluate 的結果再輪詢。
async function waitForAsync(page, predicate, arg) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
        if (await page.evaluate(predicate, arg)) return;
        await page.waitForTimeout(50);
    }
    throw new Error(`Timed out waiting for async condition: ${predicate.toString()}`);
}

async function expectArticle(page, id, value) {
    await waitForAsync(page, async ({ id, value }) => {
        const state = await import('/modules/state.js');
        return state.currentArticleId === id && document.getElementById('article-input').value === value
            && document.getElementById('article-analysis-container').getAttribute('aria-busy') !== 'true';
    }, { id, value });
}

async function edit(page, text) {
    if (!(await page.locator('#article-input').isVisible())) await page.click('#article-input-toggle');
    await page.fill('#article-input', text);
}

async function signIn(page, token) {
    await page.evaluate(async (token) => {
        const { auth } = await import('/modules/sync-cloudflare.js');
        await auth.signInWithToken(token);
    }, token);
    await waitForAsync(page, async () => {
        const store = await import('/modules/article-store.js');
        const { getAuthSnapshot } = await import('/modules/sync-cloudflare.js');
        const auth = getAuthSnapshot();
        return store.getArticleScope() === `${auth.endpoint}::${auth.userId}`;
    });
}

(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: CHROME });
    let count = 0;
    const pass = (name) => { count += 1; console.log(`ok ${count} - ${name}`); };
    try {
        const f = await fixture(browser);
        const { page } = f;
        await seed(page, [A, B]);
        await page.click('#article-history-btn');
        await page.click(`.ar-history-item[data-key="${A.id}"] .ar-history-open`);
        await expectArticle(page, A.id, A.body);
        assert.equal(new URL(page.url()).hash, '#a/local%3Abookmark-a');
        await f.load(null, true);
        await expectArticle(page, A.id, A.body);
        assert((await snapshot(page, A.id)).rendered.includes('已保存的譯文'));
        assert.equal(f.calls.length, 0, 'local bookmark must not require remote service');
        pass('history opening writes encoded legacy ID; refresh restores saved text and analysis');

        const draftA = 'Edited A, still waiting for a new analysis.';
        await edit(page, draftA);
        await f.load(null, true); // 不等待 600ms debounce，驗證同步 session staging。
        await expectArticle(page, A.id, draftA);
        const recovered = await snapshot(page, A.id);
        assert.equal(recovered.body, A.body);
        assert.equal(recovered.notice, true);
        assert(recovered.rendered.includes(A.body));
        assert(await page.locator('#article-version-notice').isVisible());
        pass('immediate refresh recovers edited text under original identity and preserves saved analysis');

        await hash(page, '#a/' + encodeURIComponent(B.id));
        await expectArticle(page, B.id, B.body);
        const draftB = 'Edited B has its own local draft.';
        await edit(page, draftB);
        await page.goBack();
        await expectArticle(page, A.id, draftA);
        await page.goForward();
        await expectArticle(page, B.id, draftB);
        await hash(page, '#a');
        await page.waitForFunction(() => document.getElementById('article-input').value === '');
        assert.equal(await page.locator('#article-continue-btn').textContent(), '继续阅读〈Article B〉');
        await page.click('#article-continue-btn');
        await expectArticle(page, B.id, draftB);
        pass('A/B drafts stay separate through back/forward; ordinary entry offers explicit last-read continuation');

        await edit(page, '');
        await f.load(null, true);
        await expectArticle(page, B.id, '');
        assert.equal((await snapshot(page, B.id)).body, B.body);
        await edit(page, B.body);
        await waitForAsync(page, async (id) => !(await (await import('/modules/article-store.js')).readDraft({ recordId: id })), B.id);
        await f.load(null, true);
        await expectArticle(page, B.id, B.body);
        pass('intentionally blank article draft survives; reverting to saved text clears the draft');

        await hash(page, '#a');
        await page.waitForFunction(() => document.getElementById('article-input').value === '');
        await edit(page, 'An unnamed new draft.');
        await f.load(null, true);
        assert.equal((await snapshot(page)).value, 'An unnamed new draft.');
        assert.equal((await snapshot(page)).id, null);
        await edit(page, '');
        await f.load(null, true);
        assert.equal((await snapshot(page)).value, '');
        pass('unnamed drafts refresh safely, including deletion to an empty editor');

        await page.evaluate(async ({ id }) => {
            await (await import('/modules/article-store.js')).saveDraft({
                recordId: id, text: 'Manually restored A draft.', title: 'Article A'
            });
        }, A);
        await page.click('#article-history-btn');
        await page.click('[data-act="restore-draft"]');
        await expectArticle(page, A.id, 'Manually restored A draft.');
        await page.waitForURL((url) => url.hash === '#a/' + encodeURIComponent(A.id));
        assert.equal(new URL(page.url()).hash, '#a/' + encodeURIComponent(A.id));
        assert.equal((await snapshot(page, A.id)).body, A.body);
        pass('manual draft recovery retains the original article ID and saved analysis');

        await page.evaluate(() => {
            const originalPut = IDBObjectStore.prototype.put;
            IDBObjectStore.prototype.put = function (...args) {
                if (this.name === 'drafts') throw new DOMException('mock full disk', 'QuotaExceededError');
                return originalPut.apply(this, args);
            };
        });
        await edit(page, 'Staged A survives failed durable storage.');
        await page.waitForFunction(() => document.getElementById('article-history-status').dataset.state === 'failed');
        assert((await page.locator('#article-history-status').textContent()).includes('草稿未能保存'));
        await f.load(null, true);
        await expectArticle(page, A.id, 'Staged A survives failed durable storage.');
        assert.equal((await snapshot(page, A.id)).body, A.body);
        pass('failed durable draft writes report failure and retain a per-tab refresh backup');

        await hash(page, '#a/%E0%A4%A');
        await page.waitForFunction(() => document.getElementById('article-route-message').textContent.includes('无效'));
        assert(await page.locator('#article-route-retry').isHidden());
        await hash(page, '#a/only-in-private-account');
        await page.waitForFunction(() => document.getElementById('article-route-message').textContent.includes('请登录'));
        assert(await page.locator('#article-route-login').isVisible());
        assert.equal((await snapshot(page)).value, '');
        pass('malformed IDs and private links while logged out show explicit recoverable states');

        await hash(page, '#a/' + encodeURIComponent(A.id));
        await expectArticle(page, A.id, 'Staged A survives failed durable storage.');
        await page.click('#quiz-btn');
        await page.evaluate(async () => { (await import('/modules/state.js')).setQuizInProgress(true); });
        await page.goBack();
        await page.waitForSelector('.options-modal-overlay #cancel-btn');
        await page.click('.options-modal-overlay #cancel-btn');
        await page.waitForFunction(() => document.getElementById('quiz-section').classList.contains('active')
            && location.hash === '#q');
        assert.equal(await page.evaluate(async () => (await import('/modules/state.js')).quizInProgress), true);
        await hash(page, '#a/' + encodeURIComponent(A.id));
        await page.waitForSelector('.options-modal-overlay #confirm-btn');
        await page.click('.options-modal-overlay #confirm-btn');
        await expectArticle(page, A.id, 'Staged A survives failed durable storage.');
        assert.equal(await page.evaluate(async () => (await import('/modules/state.js')).quizInProgress), false);
        pass('back navigation and direct article hashes respect quiz leave confirmation');
        assert.deepEqual(f.errors, []);
        await f.context.close();

        const r = await fixture(browser, 'zh-HK');
        const rp = r.page;
        r.docs.set('user-a:remote-only', remote('remote-only', 'Remote private body.', 'Remote title'));
        await signIn(rp, 'token-a');
        await hash(rp, '#a/remote-only');
        await expectArticle(rp, 'remote-only', 'Remote private body.');
        assert.equal(r.calls.filter((call) => call.id === 'remote-only').length, 1);
        await r.load(null, true);
        await expectArticle(rp, 'remote-only', 'Remote private body.');
        assert.equal(r.calls.filter((call) => call.id === 'remote-only').length, 1);
        await rp.evaluate(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, value: false }); });
        await hash(rp, '#a/unknown-offline');
        await rp.waitForFunction(() => document.getElementById('article-route-message').textContent.includes('離線'));
        await hash(rp, '#a/remote-only');
        await expectArticle(rp, 'remote-only', 'Remote private body.');
        await rp.evaluate(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, value: true }); });
        pass('remote-only bookmark uses one private GET, then reloads and works offline from local storage');

        await hash(rp, '#a/not-found');
        await rp.waitForFunction(() => document.getElementById('article-route-message').textContent.includes('找不到'));
        r.docs.set('user-a:server-down', 'network');
        await hash(rp, '#a/server-down');
        await rp.waitForFunction(() => document.getElementById('article-route-message').textContent.includes('暫時無法'));
        r.docs.set('user-a:server-down', remote('server-down', 'Retry succeeded.'));
        await rp.click('#article-route-retry');
        await expectArticle(rp, 'server-down', 'Retry succeeded.');
        pass('Hong Kong missing/offline/network messages and retry retain the requested identity');

        await rp.click('#article-btn');
        await expectArticle(rp, 'server-down', 'Retry succeeded.');
        r.docs.set('user-a:deleted-locally', remote('deleted-locally', 'Deleted body.'));
        await rp.evaluate(async (doc) => {
            const store = await import('/modules/article-store.js');
            await store.applyRemoteDoc(doc);
            const result = await store.deleteArticle(doc.id);
            if (!result.ok) throw new Error(JSON.stringify(result));
        }, r.docs.get('user-a:deleted-locally'));
        await hash(rp, '#a/deleted-locally');
        await rp.waitForFunction(() => document.getElementById('article-route-message').textContent.includes('找不到'));
        assert.equal(r.calls.filter((call) => call.id === 'deleted-locally').length, 0);
        pass('private bookmarks cannot redownload an article pending local deletion');

        r.docs.set('user-a:expired-session', 'unauthorized');
        await hash(rp, '#a/expired-session');
        await rp.waitForFunction(() => document.getElementById('article-route-message').textContent.includes('請登入'));
        assert.equal(new URL(rp.url()).hash, '#a/expired-session');
        await rp.click('#article-btn');
        await rp.waitForFunction(() => document.getElementById('article-route-message').textContent.includes('請登入'));
        assert.equal(new URL(rp.url()).hash, '#a/expired-session');
        r.docs.set('user-a:expired-session', remote('expired-session', 'After logging in again.'));
        await signIn(rp, 'token-a');
        await expectArticle(rp, 'expired-session', 'After logging in again.');
        pass('401 and repeated article entry preserve the URL and recover after same-account login');

        r.docs.set('user-a:slow-first', remote('slow-first', 'Late response must not replace current article.'));
        const releaseFirst = await r.hold('user-a', 'slow-first');
        const firstRequest = rp.waitForRequest((request) => request.url() === ENDPOINT + '/articles/slow-first');
        await hash(rp, '#a/slow-first');
        await firstRequest;
        await hash(rp, '#a/remote-only');
        await expectArticle(rp, 'remote-only', 'Remote private body.');
        releaseFirst();
        await rp.waitForTimeout(150);
        await expectArticle(rp, 'remote-only', 'Remote private body.');
        assert.equal(new URL(rp.url()).hash, '#a/remote-only');
        pass('a late remote response cannot replace the article selected after it');

        r.docs.set('user-a:leave-loading', remote('leave-loading', 'Must not reopen a departed article page.'));
        const releaseLeave = await r.hold('user-a', 'leave-loading');
        const leavingRequest = rp.waitForRequest((request) => request.url() === ENDPOINT + '/articles/leave-loading');
        await hash(rp, '#a/leave-loading');
        await leavingRequest;
        await rp.click('#vocabulary-btn');
        await rp.waitForFunction(() => document.getElementById('vocabulary-section').classList.contains('active'));
        releaseLeave();
        await rp.waitForTimeout(150);
        assert.equal(new URL(rp.url()).hash, '#v');
        assert.equal((await snapshot(rp)).value, '');
        assert(await rp.locator('#article-section').isHidden());
        await hash(rp, '#a/remote-only');
        await expectArticle(rp, 'remote-only', 'Remote private body.');
        pass('leaving while a private article loads prevents its late response from reopening the page');

        r.docs.set('user-a:cold-initial-load', remote('cold-initial-load', 'Do not reopen after initial navigation was cancelled.'));
        const releaseInitial = await r.hold('user-a', 'cold-initial-load');
        await rp.evaluate(() => { history.replaceState(null, '', '#a/cold-initial-load'); });
        const initialRequest = rp.waitForRequest((request) => request.url() === ENDPOINT + '/articles/cold-initial-load');
        const initialReload = r.load(null, true);
        await initialRequest;
        await rp.click('#vocabulary-btn');
        await rp.waitForFunction(() => document.getElementById('vocabulary-section').classList.contains('active'));
        releaseInitial();
        await initialReload;
        assert.equal(new URL(rp.url()).hash, '#v');
        assert.equal((await snapshot(rp)).value, '');
        assert(await rp.locator('#article-section').isHidden());
        pass('cold initial private fetch receives navigation changes before application initialization finishes');

        r.docs.set('user-a:shared-id', remote('shared-id', 'Account A private body.', 'Account A'));
        r.docs.set('user-b:shared-id', remote('shared-id', 'Account B private body.', 'Account B'));
        await hash(rp, '#a/shared-id');
        await expectArticle(rp, 'shared-id', 'Account A private body.');
        await edit(rp, 'Account A local draft.');
        await waitForAsync(rp, async () => (await (await import('/modules/article-store.js')).readDraft({ recordId: 'shared-id' }))?.text === 'Account A local draft.');
        await signIn(rp, 'token-b');
        await expectArticle(rp, 'shared-id', 'Account B private body.');
        assert.equal(await rp.locator('#article-draft-notice').isVisible(), false);
        await edit(rp, 'Account B local draft.');
        await waitForAsync(rp, async () => (await (await import('/modules/article-store.js')).readDraft({ recordId: 'shared-id' }))?.text === 'Account B local draft.');
        await signIn(rp, 'token-a');
        await expectArticle(rp, 'shared-id', 'Account A local draft.');
        assert((await rp.locator('#article-draft-notice').textContent()).includes('已還原'));
        assert.equal((await snapshot(rp, 'shared-id')).body, 'Account A private body.');
        await hash(rp, '#a');
        await rp.waitForFunction(() => document.getElementById('article-continue-btn').textContent === '繼續閱讀〈Account A〉');
        pass('real A/B/A auth changes isolate same-ID bodies, drafts and last-read pointers');

        const slowId = 'account-race';
        r.docs.set(`user-a:${slowId}`, remote(slowId, 'Old A response.'));
        r.docs.set(`user-b:${slowId}`, remote(slowId, 'Current B response.'));
        const releaseAccount = await r.hold('user-a', slowId);
        const accountRequest = rp.waitForRequest((request) => request.url() === ENDPOINT + '/articles/' + slowId);
        await hash(rp, '#a/' + slowId);
        await accountRequest;
        await signIn(rp, 'token-b');
        await expectArticle(rp, slowId, 'Current B response.');
        releaseAccount();
        await rp.waitForTimeout(150);
        await expectArticle(rp, slowId, 'Current B response.');
        await rp.evaluate(async () => { await (await import('/modules/sync-cloudflare.js')).auth.signOut(); });
        await rp.waitForFunction(() => document.getElementById('article-route-message').textContent.includes('請登入'));
        assert.equal((await snapshot(rp)).value, '');
        assert(!(await snapshot(rp)).rendered.includes('Current B response.'));
        pass('auth change discards old in-flight response and sign-out immediately clears private content');

        assert.deepEqual(r.errors, []);
        await r.context.close();

        const u = await fixture(browser, 'zh-CN', '');
        await hash(u.page, '#a/unconfigured-service');
        await u.page.waitForFunction(() => document.getElementById('article-route-message').textContent.includes('尚未设置同步服务'));
        assert.equal(u.calls.length, 0);
        assert.deepEqual(u.errors, []);
        await u.context.close();
        pass('unconfigured sync service gives a configuration hint without making a private request');
        console.log(`PASS ${count} article navigation scenarios`);
    } finally {
        await browser.close();
    }
})().catch((error) => { console.error(error); process.exitCode = 1; });
