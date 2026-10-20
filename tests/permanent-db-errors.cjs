/**
 * 永久庫錯誤注入：開庫失敗不得永久快取、get 回傳值需保持可 clone、
 * 同步 put 失敗不得留下 unhandled rejection。
 *
 * 用法：
 *   PORT=8313 PLAYWRIGHT_MODULE=<path-to-playwright> node tests/permanent-db-errors.cjs
 */
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const PORT = Number(process.env.PORT || 8313);
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: CHROME });
    const results = [];
    try {
        const context = await browser.newContext();
        await context.route('**/*', (route) => {
            const url = new URL(route.request().url());
            if (url.pathname.endsWith('/ai-config.js')) {
                return route.fulfill({ contentType: 'application/javascript', body: 'export const SYNC={endpoint: ""}; export const TTS_CONFIG={}, AI_LIMITS={}, OCR_CONFIG={}, ARTICLE_IMPORT={}, SUPABASE={};' });
            }
            if (url.origin !== BASE) return route.abort();
            return route.continue();
        });
        const page = await context.newPage();
        await page.goto(`${BASE}/test-reading-blank.html`);
        const data = await page.evaluate(async () => {
            const db = await import('/modules/permanent-db.js');
            const unhandled = [];
            window.addEventListener('unhandledrejection', (event) => unhandled.push(String(event.reason?.name || event.reason)));
            const originalOpen = IDBFactory.prototype.open;
            let failOnce = true;
            IDBFactory.prototype.open = function open(...args) {
                if (failOnce) {
                    failOnce = false;
                    const fake = {};
                    queueMicrotask(() => { if (typeof fake.onerror === 'function') fake.onerror(); });
                    return fake;
                }
                return originalOpen.apply(this, args);
            };
            const firstOpen = await db.openPermanentDb();
            const secondOpen = await db.openPermanentDb();
            IDBFactory.prototype.open = originalOpen;
            const recovery = { firstNull: firstOpen === null, secondConnected: !!secondOpen };

            const value = { key: 'clone-test', scope: 'clone', id: 'clone-test', payload: { a: 1 } };
            const write = await db.applyPermanentOperations([{ store: db.STORE.DOCS, type: 'put', value }]);
            const read = await db.readStoreOne(db.STORE.DOCS, 'clone-test');
            const writeAgain = await db.applyPermanentOperations([{ store: db.STORE.DOCS, type: 'put', value: read.value }]);

            const badWrite = await db.applyPermanentOperations([{
                store: db.STORE.DOCS,
                type: 'put',
                value: { key: 'bad-clone', scope: 'clone', id: 'bad-clone', fn: () => {} }
            }]);
            await new Promise((resolve) => setTimeout(resolve, 100));
            const afterBad = await db.readStoreOne(db.STORE.DOCS, 'bad-clone');
            return {
                recovery,
                writeOk: write.ok,
                readOk: read.ok && read.value?.payload?.a === 1,
                getValueHasNoHandler: read.value && !Object.prototype.hasOwnProperty.call(read.value, 'onversionchange'),
                writeAgainOk: writeAgain.ok,
                badWriteOk: badWrite.ok,
                badWriteError: badWrite.error,
                badRecordAbsent: !afterBad.value,
                unhandled
            };
        });
        try {
            assert.equal(data.recovery.firstNull, true);
            assert.equal(data.recovery.secondConnected, true, JSON.stringify(data.recovery));
            assert.equal(data.writeOk, true);
            assert.equal(data.readOk, true);
            assert.equal(data.getValueHasNoHandler, true);
            assert.equal(data.writeAgainOk, true);
            results.push({ name: 'failed open is not cached forever; read values remain cloneable', ok: true });
        } catch (error) {
            results.push({ name: 'failed open is not cached forever; read values remain cloneable', ok: false, error: String(error) });
        }
        try {
            assert.equal(data.badWriteOk, false, JSON.stringify(data));
            assert.equal(data.badRecordAbsent, true, JSON.stringify(data));
            assert.deepEqual(data.unhandled, [], JSON.stringify(data.unhandled));
            results.push({ name: 'synchronous DataCloneError aborts without unhandled rejection', ok: true });
        } catch (error) {
            results.push({ name: 'synchronous DataCloneError aborts without unhandled rejection', ok: false, error: String(error) });
        }
    } finally {
        await browser.close();
    }
    console.log(JSON.stringify(results, null, 2));
    process.exitCode = results.every((item) => item.ok) ? 0 : 1;
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
