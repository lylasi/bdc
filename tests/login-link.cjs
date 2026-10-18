/**
 * 登入連結：早鳥捕獲、自動登入、本機資料合併同意與同步暫停。
 *
 * 執行（先開 python3 scripts/serve.py --port 8313）：
 *   PORT=8313 PLAYWRIGHT_MODULE=<path-to-playwright> node tests/login-link.cjs
 *
 * 使用同源 mock 同步端點；不連線正式 Worker，也不寫入雲端資料。
 */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const PORT = process.env.PORT || 8313;
const BASE = `http://127.0.0.1:${PORT}/`;
const ENDPOINT = `${BASE}mock-sync`;
const TOKEN = 'u'.repeat(43);
const LINK_CODE = 'ABCDEFGHJKLMNPQR';
const results = [];

function check(name, ok, detail) {
    results.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ' :: ' + JSON.stringify(detail)}`);
}

(async () => {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const pageErrors = [];
    let snapshotPosts = 0;

    page.on('pageerror', (error) => pageErrors.push(String(error)));

    await context.addInitScript((endpoint) => {
        globalThis.__BDC_SYNC_ENDPOINT__ = endpoint;
    }, ENDPOINT);

    await context.route(`${ENDPOINT}/**`, async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const path = url.pathname.replace('/mock-sync', '');
        const method = request.method();
        const json = (body, status = 200) => route.fulfill({
            status,
            contentType: 'application/json',
            headers: {
                'Access-Control-Allow-Origin': BASE.slice(0, -1),
                'Cache-Control': 'no-store'
            },
            body: JSON.stringify(body)
        });

        if (path === '/auth-capabilities' && method === 'GET') {
            return json({ pairingLogin: true, loginLinks: true, passwordLogin: false });
        }
        if (path === '/pair' && method === 'POST') {
            return json({
                token: TOKEN,
                user_id: 'alice',
                label: 'Alice',
                role: 'user',
                expires_at: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString()
            });
        }
        if (path === '/me' && method === 'GET') {
            return json({ user_id: 'alice', label: 'Alice', role: 'user' });
        }
        if (path === '/version' && method === 'GET') return json({ version: 0 });
        if (path === '/snapshot' && method === 'GET') return json(null);
        if (path === '/snapshot' && method === 'POST') {
            snapshotPosts += 1;
            return json({ conflict: false, version: 1 });
        }
        if (path === '/ai-catalog' && method === 'GET') {
            return json({ version: 0, config: { schemaVersion: 1, providers: [], tasks: {} }, credentials: {} });
        }
        if (path === '/ai-credentials' && method === 'GET') return json({ items: [] });
        return json({});
    });

    const pause = (ms) => page.waitForTimeout(ms);
    const waitForSnapshotPosts = async (min, timeout = 6000) => {
        const started = Date.now();
        while (Date.now() - started < timeout) {
            if (snapshotPosts >= min) return true;
            await pause(100);
        }
        return false;
    };
    const dismissWelcome = async () => {
        await page.evaluate(() => {
            const dismiss = Array.from(document.querySelectorAll('button')).find((button) => /稍后|稍後/.test(button.textContent || ''));
            if (dismiss) dismiss.click();
        });
    };
    const readSession = () => page.evaluate(() => ({
        token: localStorage.getItem('sync_token'),
        userId: localStorage.getItem('sync_user_id'),
        pendingMerge: localStorage.getItem('sync_pending_merge_user'),
        hash: location.hash
    }));

    try {
        // 1. 沒有本機資料：直接自動登入並允許自動同步。
        await page.goto(BASE, { waitUntil: 'load' });
        await page.evaluate(() => localStorage.clear());
        snapshotPosts = 0;
        await page.goto(`${BASE}?case=fresh#login=${LINK_CODE}`, { waitUntil: 'load' });
        await pause(1400);
        let state = await readSession();
        check('全新裝置以登入連結自動登入', state.token === TOKEN && state.userId === 'alice', state);
        check('登入連結 fragment 已移除', !/login=/i.test(state.hash), state.hash);
        check('沒有本機資料時不顯示合併詢問', !(await page.isVisible('#confirm-btn')));
        const freshSynced = await waitForSnapshotPosts(1);
        check('沒有本機資料時自動同步', freshSynced, snapshotPosts);

        // 2. 有本機資料：登入後詢問合併；選「僅登入」後暫停同步。
        await page.goto(BASE, { waitUntil: 'load' });
        await page.evaluate(() => {
            localStorage.clear();
            localStorage.setItem('vocabularyBooks', JSON.stringify([{
                id: 'b1',
                name: '本機詞書',
                sourceType: 'manual',
                createdAt: '2026-10-18T00:00:00.000Z',
                shareId: 'wb_test',
                words: []
            }]));
        });
        snapshotPosts = 0;
        await page.goto(`${BASE}?case=local-data#login=${LINK_CODE}`, { waitUntil: 'load' });
        await pause(900);
        check('本機有資料時顯示合併詢問', await page.isVisible('#confirm-btn'));
        await page.click('#cancel-btn');
        await pause(600);
        state = await readSession();
        check('選擇僅登入後記住待合併帳號', state.pendingMerge === 'alice' && state.token === TOKEN, state);
        check('選擇僅登入後不自動上傳', snapshotPosts === 0, snapshotPosts);

        // 3. 重新載入後仍維持暫停，並顯示提示。
        await page.goto(`${BASE}?case=reload`, { waitUntil: 'load' });
        await pause(1200);
        await dismissWelcome();
        state = await readSession();
        check('重新載入後仍保留待合併狀態', state.pendingMerge === 'alice', state);
        check('重新載入後仍不上傳', snapshotPosts === 0, snapshotPosts);
        const toastText = await page.locator('.message-toast').allInnerTexts().catch(() => []);
        check('重新載入後提示自動同步已暫停', toastText.some((text) => /自动同步已暂停|自動同步已暫停/.test(text)), toastText);

        // 4. 按「立即同步」才詢問並執行合併。
        await page.click('#app-gear-btn');
        await pause(200);
        await page.click('#gm-sync');
        await pause(400);
        check('手動同步前再次確認合併', await page.isVisible('#confirm-btn'));
        await page.click('#confirm-btn');
        const mergedSynced = await waitForSnapshotPosts(1);
        state = await readSession();
        check('確認合併後清除待合併狀態', !state.pendingMerge, state);
        check('確認合併後執行同步', mergedSynced, snapshotPosts);

        check('沒有頁面例外', pageErrors.length === 0, pageErrors);
    } finally {
        if (pageErrors.length) console.log('PAGE ERRORS ::', JSON.stringify(pageErrors));
        await browser.close();
        const failed = results.filter((item) => !item.ok);
        console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
        if (failed.length) process.exitCode = 1;
    }
})();
