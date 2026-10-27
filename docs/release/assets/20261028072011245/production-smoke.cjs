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

async function fixture(browser, locale = 'zh-CN', endpoint = ENDPOINT, width = 1440) {
    const context = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 960 }, hasTouch: width < 500, isMobile: width < 500 });
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
    page.on('response', captureResource);
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


const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../../..');
const ref = process.env.RELEASE_REF || 'afa9696aad5a0a31d54aae26e16e135d38eadf98';
const sourceCache = new Map();
function source(name) {
    if (!sourceCache.has(name)) sourceCache.set(name, execFileSync('git', ['show', `${ref}:${name}`], { cwd: root }));
    return sourceCache.get(name);
}
const digest = (body) => crypto.createHash('sha256').update(body).digest('hex');
const imports = JSON.parse(source('index.html').toString().match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]).imports;
const release = new URL(Object.values(imports)[0], BASE).searchParams.get('v');
const resources = [];
const checks = [];
function check(name, condition, detail) {
    checks.push({ name, pass: !!condition, detail });
    assert(condition, `${name}: ${JSON.stringify(detail)}`);
    console.log('PASS ' + name);
}
function captureResource(response) {
    const url = new URL(response.url());
    if (url.origin !== BASE || !(url.pathname === '/' || url.pathname === '/styles.css' || imports[url.pathname])) return;
    resources.push((async () => {
        const expected = source(url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
        const item = { path: url.pathname, query: url.search, status: response.status(),
            sha256: digest(await response.body()), expected: digest(expected) };
        item.pass = item.status === 200 && item.sha256 === item.expected
            && (item.path === '/' || item.query === '?v=' + release);
        return item;
    })().catch((error) => ({ path: url.pathname, pass: false, error: error.message })));
}
(async () => {
    const browser = await chromium.launch({ executablePath: CHROME, headless: true });
    try {
        for (const [locale, width] of [['zh-CN', 1280], ['zh-HK', 390], ['zh-CN', 320]]) {
            const label = `${locale}-${width}`;
            const f = await fixture(browser, locale, ENDPOINT, width);
            const p = f.page;
            await seed(p, [A, B]);
            await hash(p, '#a/' + encodeURIComponent(A.id));
            await expectArticle(p, A.id, A.body);
            check(`${label} ID URL restores saved text and analysis`, (await snapshot(p, A.id)).rendered.includes('已保存的譯文'));
            await hash(p, '#a');
            const button = p.locator('#article-continue-btn');
            await button.waitFor({ state: 'visible' });
            check(`${label} localized continuation`, await button.innerText() === `${locale === 'zh-HK' ? '繼續閱讀' : '继续阅读'}〈Article A〉`);
            await p.waitForTimeout(300);
            await p.screenshot({ path: path.join(__dirname, `${label}-continue.png`), animations: 'disabled' });
            if (width < 500) await button.tap(); else await button.click();
            await expectArticle(p, A.id, A.body);
            await p.waitForURL('**/#a/local%3Abookmark-a');
            check(`${label} continuation updates URL`, new URL(p.url()).hash === '#a/local%3Abookmark-a');
            const draft = 'We look forward to meeting you next Saturday.\nThis is a local draft.';
            await edit(p, draft);
            await f.load(null, true);
            await expectArticle(p, A.id, draft);
            check(`${label} immediate refresh recovers draft with original ID`, (await snapshot(p, A.id)).body === A.body);
            check(`${label} draft and old-analysis notices`, await p.locator('#article-draft-notice').isVisible()
                && await p.locator('#article-version-notice').isVisible());
            await p.waitForTimeout(300);
            await p.screenshot({ path: path.join(__dirname, `${label}-draft.png`), animations: 'disabled' });
            await hash(p, '#a/private-unavailable');
            await p.locator('#article-route-login').waitFor({ state: 'visible' });
            check(`${label} localized login recovery`, (await p.locator('#article-route-message').innerText()).includes(locale === 'zh-HK' ? '請登入' : '请登录'));
            await p.waitForTimeout(300);
            await p.screenshot({ path: path.join(__dirname, `${label}-login.png`), animations: 'disabled' });
            check(`${label} no horizontal overflow`, await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
            check(`${label} no page errors`, f.errors.length === 0, f.errors);
            await Promise.all(resources);
            await f.context.close();
        }
        const loaded = await Promise.all(resources);
        check('browser resources match committed release and query', loaded.length > 180 && loaded.every((item) => item.pass),
            { count: loaded.length, bad: loaded.filter((item) => !item.pass) });
        fs.writeFileSync(path.join(__dirname, 'browser-checks.json'), JSON.stringify({ base: BASE, ref, release, checks, resources: loaded }, null, 2) + '\n');
        console.log(`PASS ${checks.length} production UI checks; ${loaded.length} verified responses`);
    } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
