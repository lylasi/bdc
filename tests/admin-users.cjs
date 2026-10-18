/**
 * 管理員用戶管理面板：以 mock 同步端點巡檢列表、建立、編輯、重設與雙語文案。
 *
 * 執行（先開 python3 scripts/serve.py --port 8313）：
 *   PORT=8313 PLAYWRIGHT_MODULE=<path-to-playwright> node tests/admin-users.cjs
 *
 * 這個腳本用 globalThis.__BDC_SYNC_ENDPOINT__ 將同步請求導向同源 mock，
 * 不需要連線正式 Worker，也不會寫入任何雲端資料。
 */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const PORT = process.env.PORT || 8313;
const BASE = `http://127.0.0.1:${PORT}/`;
const ENDPOINT = `${BASE}mock-sync`;
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
    page.on('pageerror', (error) => pageErrors.push(String(error)));

    const users = [
        { userId: 'admin', label: 'Admin', role: 'admin', email: 'admin@example.com', createdAt: '2026-10-18T00:00:00.000Z', username: '', hasPassword: false },
        { userId: 'alice', label: 'Alice', role: 'user', email: '', createdAt: null, username: '', hasPassword: false }
    ];
    let sequence = 0;
    let lastPairingTtl = null;
    let pairingCodes = [];

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
            headers: { 'Access-Control-Allow-Origin': BASE.slice(0, -1), 'Cache-Control': 'no-store' },
            body: JSON.stringify(body)
        });

        if (path === '/me' && method === 'GET') {
            const authorization = request.headers()['authorization'] || '';
            if (authorization === `Bearer ${'z'.repeat(43)}`) {
                return json({ user_id: 'alice', label: 'Alice', role: 'user' });
            }
            if (authorization === `Bearer ${'y'.repeat(43)}`) {
                return json({ user_id: 'carol', label: 'Carol 2', role: 'user', username: 'carol', hasPassword: true });
            }
            return json({ user_id: 'admin', label: 'Admin', role: 'admin' });
        }
        if (path === '/login' && method === 'POST') {
            const body = JSON.parse(request.postData() || '{}');
            if (String(body.username || '').toLowerCase() === 'carol' && body.password === 'carol-password') {
                return json({
                    token: 'y'.repeat(43),
                    user_id: 'carol',
                    label: 'Carol 2',
                    role: 'user',
                    username: 'carol',
                    hasPassword: true,
                    expires_at: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString()
                });
            }
            return json({ error: 'invalid_credentials', code: 'invalid_credentials' }, 401);
        }
        if (path === '/change-password' && method === 'POST') {
            return json({ ok: true, authVersion: 2 });
        }
        if (path === '/version' && method === 'GET') return json({ version: 0 });
        if (path === '/snapshot' && method === 'GET') return json(null);
        if (path === '/snapshot' && method === 'POST') return json({ conflict: false, version: 1 });
        if (path === '/ai-catalog' && method === 'GET') return json({ version: 0, config: { schemaVersion: 1, providers: [], tasks: {} }, credentials: {} });
        if (path === '/ai-credentials' && method === 'GET') return json({ items: [] });
        if (path === '/auth-capabilities' && method === 'GET') {
            return json({ pairingLogin: true, loginLinks: true, passwordLogin: true, passwordMinLength: 10, adminPasswordMinLength: 12 });
        }
        if (path === '/admin/users' && method === 'GET') {
            return json({ users: users.map((user) => ({ ...user })), currentUserId: 'admin' });
        }
        if (path === '/admin/users' && method === 'POST') {
            const body = JSON.parse(request.postData() || '{}');
            if (users.some((user) => user.userId === body.userId)) {
                return json({ error: 'user_exists', code: 'user_exists' }, 409);
            }
            const created = {
                userId: body.userId,
                label: body.label || '',
                role: 'user',
                email: String(body.email || '').toLowerCase(),
                createdAt: new Date().toISOString(),
                username: String(body.username || '').toLowerCase(),
                hasPassword: Boolean(body.password)
            };
            users.push(created);
            sequence += 1;
            return json({
                user: created,
                passcode: `p${String(sequence).repeat(42)}`,
                recoveryCode: `r${String(sequence).repeat(31)}`
            }, 201);
        }
        const pairingMatch = path.match(/^\/admin\/users\/([^/]+)\/pairing-code$/);
        if (pairingMatch && method === 'POST') {
            const found = users.find((user) => user.userId === decodeURIComponent(pairingMatch[1]));
            if (!found) return json({ error: 'user_not_found', code: 'user_not_found' }, 404);
            if (found.role === 'admin') return json({ error: 'admin_account_protected', code: 'admin_account_protected' }, 403);
            const body = JSON.parse(request.postData() || '{}');
            lastPairingTtl = body.ttlSeconds === undefined ? 604800 : Number(body.ttlSeconds);
            const code = 'ABCDEFGHJKLMNPQR';
            pairingCodes.push({ userId: found.userId, code });
            return json({
                userId: found.userId,
                code,
                ttlSeconds: lastPairingTtl,
                expiresAt: new Date(Date.now() + lastPairingTtl * 1000).toISOString()
            });
        }
        const pairingsMatch = path.match(/^\/admin\/users\/([^/]+)\/pairing-codes$/);
        if (pairingsMatch && method === 'DELETE') {
            const userId = decodeURIComponent(pairingsMatch[1]);
            const before = pairingCodes.length;
            pairingCodes = pairingCodes.filter((item) => item.userId !== userId);
            return json({ userId, revoked: before - pairingCodes.length });
        }
        if (path === '/pair' && method === 'POST') {
            const body = JSON.parse(request.postData() || '{}');
            if (body.code === 'BADBADBADBADBADB') {
                return json({ error: 'pairing_invalid', code: 'pairing_invalid' }, 403);
            }
            return json({
                token: 'z'.repeat(43),
                user_id: 'alice',
                label: 'Alice',
                role: 'user',
                expires_at: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString()
            });
        }
        const resetMatch = path.match(/^\/admin\/users\/([^/]+)\/reset-passcode$/);
        if (resetMatch && method === 'POST') {
            const found = users.find((user) => user.userId === decodeURIComponent(resetMatch[1]));
            if (!found) return json({ error: 'user_not_found', code: 'user_not_found' }, 404);
            if (found.role === 'admin') return json({ error: 'admin_account_protected', code: 'admin_account_protected' }, 403);
            sequence += 1;
            return json({
                user: { ...found },
                passcode: `q${String(sequence).repeat(42)}`,
                recoveryCode: `s${String(sequence).repeat(31)}`
            });
        }
        const updateMatch = path.match(/^\/admin\/users\/([^/]+)$/);
        if (updateMatch && method === 'PUT') {
            const found = users.find((user) => user.userId === decodeURIComponent(updateMatch[1]));
            if (!found) return json({ error: 'user_not_found', code: 'user_not_found' }, 404);
            const body = JSON.parse(request.postData() || '{}');
            if (body.label !== undefined) found.label = String(body.label);
            if (body.email !== undefined) found.email = String(body.email).toLowerCase();
            if (body.username !== undefined) found.username = String(body.username).toLowerCase();
            if (body.newPassword) found.hasPassword = true;
            return json({ user: { ...found } });
        }
        return json({});
    });

    try {
        await page.goto(BASE, { waitUntil: 'load' });
        await page.evaluate(() => {
            localStorage.clear();
            localStorage.setItem('sync_token', 'a'.repeat(43));
            localStorage.setItem('sync_user_id', 'admin');
            localStorage.setItem('sync_label', 'Admin');
            localStorage.setItem('sync_role', 'admin');
        });
        await page.reload({ waitUntil: 'load' });
        await page.waitForTimeout(800);

        await page.evaluate(() => {
            const dismiss = Array.from(document.querySelectorAll('button')).find((button) => /稍后|稍後/.test(button.textContent || ''));
            if (dismiss) dismiss.click();
        });
        await page.click('#app-gear-btn');
        await page.waitForTimeout(200);
        await page.click('#gm-settings');
        await page.waitForTimeout(500);
        await page.click('[data-gs-tab="tools"]');
        check('管理員在工具頁看到用戶管理入口', await page.isVisible('#gs-admin-users'));

        await page.click('#gs-admin-users');
        await page.waitForTimeout(500);
        check('開啟用戶管理面板', await page.isVisible('[data-admin-users-body]'));
        check('列表顯示兩位用戶', (await page.locator('.admin-users-row').count()) === 2);
        check('管理員列沒有重設按鈕', (await page.locator('[data-user-reset="admin"]').count()) === 0);
        check('管理員列顯示保護提示', /部署者/.test(await page.locator('.admin-users-row').filter({ hasText: 'admin@example.com' }).innerText()));

        await page.click('[data-admin-users-create]');
        await page.fill('[data-form-user-id]', 'carol');
        await page.fill('[data-form-label]', 'Carol');
        await page.fill('[data-form-email]', 'carol@example.com');
        await page.fill('[data-form-username]', 'carol');
        await page.fill('[data-form-password]', 'carol-password');
        await page.click('[data-form-submit]');
        await page.waitForTimeout(500);
        check('建立後顯示一次性憑證', await page.isVisible('.admin-users-credentials'));
        check('憑證卡片包含通行碼', /p1{20,}/.test(await page.locator('.admin-users-credentials').innerText()));
        check('憑證卡片包含用戶名', /@carol|用户名|用戶名/.test(await page.locator('.admin-users-credentials').innerText()));
        check('建立後列表出現 carol', (await page.locator('.admin-users-row').count()) === 3);
        check('列表顯示用戶名與已設密碼', /@carol/.test(await page.locator('.admin-users-row').filter({ hasText: 'carol@example.com' }).innerText()) && /已设密码|已設密碼/.test(await page.locator('.admin-users-row').filter({ hasText: 'carol@example.com' }).innerText()));

        await page.click('[data-credentials-done]');
        await page.waitForTimeout(200);
        check('按我已保存後憑證卡片消失', (await page.locator('.admin-users-credentials').count()) === 0);

        await page.click('[data-user-edit="carol"]');
        await page.fill('[data-form-label]', 'Carol 2');
        await page.fill('[data-form-email]', 'carol2@example.com');
        await page.click('[data-form-submit]');
        await page.waitForTimeout(500);
        check('編輯後列表顯示新備註', /Carol 2/.test(await page.locator('.admin-users-rows').innerText()));

        check('管理員列沒有登入碼按鈕', (await page.locator('[data-user-pair="admin"]').count()) === 0);
        check('工具列提供登入碼有效期選項', await page.isVisible('[data-pair-ttl]'));
        await page.click('[data-user-pair="carol"]');
        await page.waitForTimeout(400);
        check('產生登入碼後顯示登入卡片', await page.isVisible('.admin-users-pairing'));
        check('登入卡片包含一次性登入碼', /ABCD-EFGH-JKLM-NPQR/.test(await page.locator('.admin-users-pairing').innerText()));
        check('登入卡片顯示登入連結', /#login=ABCDEFGHJKLMNPQR/.test(await page.locator('.admin-users-pairing').innerText()));
        check('登入卡片顯示二維碼', (await page.locator('.admin-users-pairing [data-pairing-qr] svg').count()) === 1);
        check('登入卡片顯示有效期', /有效期至/.test(await page.locator('.admin-users-pairing').innerText()));
        check('預設登入碼有效期為 7 天', lastPairingTtl === 604800, lastPairingTtl);
        await page.click('[data-pairing-done]');
        await page.waitForTimeout(200);
        check('按完成後登入卡片消失', (await page.locator('.admin-users-pairing').count()) === 0);

        await page.selectOption('[data-pair-ttl]', '600');
        await page.click('[data-user-pair="carol"]');
        await page.waitForTimeout(400);
        check('重新產生使用所選有效期', lastPairingTtl === 600, lastPairingTtl);
        await page.click('[data-pairing-revoke="carol"]');
        await page.waitForTimeout(200);
        check('撤銷前顯示確認對話框', await page.isVisible('#confirm-btn'));
        await page.click('#confirm-btn');
        await page.waitForTimeout(400);
        check('撤銷後登入卡片消失', (await page.locator('.admin-users-pairing').count()) === 0);
        check('撤銷後顯示已撤銷數量', /已撤销[\s\S]*2/.test(await page.locator('[data-admin-users-body]').innerText()));

        await page.click('[data-user-reset="carol"]');
        await page.waitForTimeout(200);
        check('重設前顯示面板內確認', await page.isVisible('[data-reset-confirm]'));
        await page.click('[data-reset-confirm]');
        await page.waitForTimeout(500);
        check('重設後顯示一次性憑證', await page.isVisible('.admin-users-credentials'));
        check('重設憑證與建立憑證不同', /q2{20,}/.test(await page.locator('.admin-users-credentials').innerText()));

        await page.click('[data-admin-users-close]');
        await page.click('[data-gs-tab="general"]');
        await page.selectOption('#gs-interface-locale', 'zh-HK');
        await page.waitForTimeout(700);
        await page.click('[data-gs-tab="tools"]');
        check('切換 zh-HK 後入口文案正確', (await page.innerText('#gs-admin-users')) === '管理用戶');
        await page.click('#gs-admin-users');
        await page.waitForTimeout(400);
        check('zh-HK 面板標題正確', /管理用戶/.test(await page.innerText('.admin-users-panel .ai-admin-head h3')));
        check('zh-HK 重設按鈕文案正確', (await page.innerText('[data-user-reset="carol"]')) === '重設通行碼');
        check('zh-HK 登入碼按鈕文案正確', (await page.innerText('[data-user-pair="carol"]')) === '產生登入碼');

        // 用戶名密碼登入：管理員已為 carol 設定憑證。
        await page.evaluate(() => localStorage.clear());
        await page.reload({ waitUntil: 'load' });
        await page.waitForTimeout(700);
        await page.click('#login-btn');
        await page.waitForTimeout(400);
        check('登入彈窗預設顯示用戶名密碼分頁', (await page.isVisible('#auth-username')) && (await page.isVisible('#auth-password')));
        await page.fill('#auth-username', 'carol');
        await page.fill('#auth-password', 'carol-password');
        await page.click('#auth-password-submit');
        await page.waitForTimeout(700);
        const passwordStored = await page.evaluate(() => ({
            token: localStorage.getItem('sync_token'),
            userId: localStorage.getItem('sync_user_id'),
            role: localStorage.getItem('sync_role')
        }));
        check('用戶名密碼登入後儲存 session token', passwordStored.token === 'y'.repeat(43), passwordStored);
        check('用戶名密碼登入後儲存用戶身分', passwordStored.userId === 'carol' && passwordStored.role === 'user', passwordStored);

        // 修改密碼：已登入且支援密碼時，設定選單應提供入口。
        await page.click('#app-gear-btn');
        await page.waitForTimeout(200);
        check('選單顯示修改密碼入口', await page.isVisible('#gm-change-password'));
        await page.click('#gm-change-password');
        await page.waitForTimeout(300);
        check('修改密碼表單要求目前密碼', await page.isVisible('#cp-current'));
        await page.fill('#cp-current', 'carol-password');
        await page.fill('#cp-new', 'carol-password-2');
        await page.fill('#cp-new2', 'carol-password-2');
        await page.click('#cp-submit');
        await page.waitForTimeout(400);
        check('修改密碼成功提示', /密码已更新|密碼已更新/.test(await page.innerText('#cp-msg')));

        // 新裝置配對登入：清除登入狀態後從登入彈窗走一次配對流程。
        await page.evaluate(() => localStorage.clear());
        await page.reload({ waitUntil: 'load' });
        await page.waitForTimeout(700);
        await page.click('#login-btn');
        await page.waitForTimeout(300);
        check('登入彈窗提供登入碼分頁', await page.isVisible('#auth-tab-passcode'));
        await page.click('#auth-tab-passcode');
        await page.waitForTimeout(200);
        check('登入彈窗提供登入碼入口', await page.isVisible('#auth-pair'));
        check('登入彈窗提示本機會記住登入', /记住登录状态|記住登入狀態/.test(await page.innerText('#auth-msg')));
        await page.click('#auth-pair');
        await page.waitForTimeout(300);
        check('登入碼表單只需登入碼', !(await page.isVisible('#pair-uid')) && (await page.isVisible('#pair-code')));
        await page.fill('#pair-code', 'abcdefgh-jklm-npqr');
        await page.click('#pair-submit');
        await page.waitForTimeout(600);
        const stored = await page.evaluate(() => ({
            token: localStorage.getItem('sync_token'),
            userId: localStorage.getItem('sync_user_id'),
            role: localStorage.getItem('sync_role')
        }));
        check('登入碼登入後儲存 session token', stored.token === 'z'.repeat(43), stored);
        check('登入碼登入後儲存用戶身分', stored.userId === 'alice' && stored.role === 'user', stored);

        // 直接開啟登入連結：應在初始化時捕獲、清除 fragment 並自動登入。
        await page.evaluate(() => localStorage.clear());
        await page.goto(`${BASE}?login-link=1#login=ABCDEFGHJKLMNPQR`, { waitUntil: 'load' });
        await page.waitForTimeout(1200);
        const linkStored = await page.evaluate(() => ({
            token: localStorage.getItem('sync_token'),
            userId: localStorage.getItem('sync_user_id'),
            hash: location.hash
        }));
        check('登入連結自動登入', linkStored.token === 'z'.repeat(43) && linkStored.userId === 'alice', linkStored);
        check('登入連結 fragment 已移除', !/login=/i.test(linkStored.hash), linkStored.hash);

        // 已登入時開啟另一個登入連結，先確認才切換；取消後保留原登入。
        await page.goto(`${BASE}?switch-account=1#login=ABCDEFGHJKLMNPQR`, { waitUntil: 'load' });
        await page.waitForTimeout(600);
        check('已登入時開啟登入連結先顯示切換確認', await page.isVisible('#confirm-btn'));
        await page.click('#cancel-btn');
        await page.waitForTimeout(300);
        const cancelled = await page.evaluate(() => ({
            token: localStorage.getItem('sync_token'),
            userId: localStorage.getItem('sync_user_id')
        }));
        check('取消切換後保留原登入', cancelled.token === 'z'.repeat(43) && cancelled.userId === 'alice', cancelled);
        check('取消切換後顯示手動登入碼表單', await page.isVisible('#pair-code'));

        // 無效或已使用的連結：回到手動表單顯示錯誤，且不留下 session。
        await page.evaluate(() => localStorage.clear());
        await page.goto(`${BASE}?invalid-link=1#login=BADBADBADBADBADB`, { waitUntil: 'load' });
        await page.waitForTimeout(900);
        const invalidStored = await page.evaluate(() => ({
            token: localStorage.getItem('sync_token'),
            hash: location.hash
        }));
        check('無效登入連結不會建立 session', !invalidStored.token, invalidStored);
        check('無效登入連結顯示手動登入碼表單', await page.isVisible('#pair-code'));
        check('無效登入連結顯示錯誤訊息', /无效|無效/.test(await page.innerText('#pair-msg')));
        check('無效登入連結 fragment 已移除', !/login=/i.test(invalidStored.hash), invalidStored.hash);

        check('沒有頁面例外', pageErrors.length === 0, pageErrors);
    } finally {
        if (pageErrors.length) console.log('PAGE ERRORS ::', JSON.stringify(pageErrors));
        await browser.close();
        const failed = results.filter((item) => !item.ok);
        console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
        if (failed.length) process.exitCode = 1;
    }
})();
