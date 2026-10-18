/**
 * BDC 安全性與強健性巡檢
 *  - 站內彈窗 / 提示的 HTML 注入（模組用 innerHTML 拼接使用者可控字串）
 *  - 詞書 / 問答集名稱等持久化資料的 XSS
 *  - 連結與 URL 參數處理
 *
 * 用法：node tests/audit-security.cjs --port 8399
 */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8399);
const BASE = `http://127.0.0.1:${PORT}/`;
const ROOT = path.resolve(__dirname, '..');
const ASSETS = path.join(ROOT, 'docs', 'report', 'root-audit');
fs.mkdirSync(ASSETS, { recursive: true });
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const findings = [];
function record(area, severity, title, detail) {
    findings.push({ area, severity, title, detail: String(detail === undefined ? '' : detail).slice(0, 500) });
    console.log(`[${severity}] ${area} :: ${title}\n        ${String(detail).slice(0, 400)}`);
}
function ok(m) { console.log(`  ok   ${m}`); }

const XSS = '<img src=x onerror="window.__xss=(window.__xss||0)+1">';

async function newPage(browser, { books, storage = {}, viewport = { width: 1440, height: 900 } } = {}) {
    const context = await browser.newContext({ viewport, acceptDownloads: true });
    await context.route('**/*', (route) => {
        let host = '';
        try { host = new URL(route.request().url()).hostname; } catch (_) { return route.abort(); }
        return (host === '127.0.0.1' || host === 'localhost') ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    await page.addInitScript(({ books, storage }) => {
        window.__xss = 0;
        localStorage.clear();
        if (books) { localStorage.setItem('vocabularyBooks', JSON.stringify(books)); localStorage.setItem('activeBookId', books[0] ? books[0].id : ''); }
        localStorage.setItem('vocabImportPromptShown', '1');
        localStorage.setItem('pen_global_settings', JSON.stringify({ language: { interfaceLocale: 'zh-CN' }, assistant: { enabled: false } }));
        for (const [k, v] of Object.entries(storage)) localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
    }, { books: books || null, storage });
    return { context, page };
}

const htmlSrc = (el) => el && el.innerHTML;

async function main() {
    const browser = await chromium.launch({ executablePath: CHROME });

    // ---------------------------------------------------------- 1. 確認彈窗注入
    {
        const books = [{
            id: 'xss-book', name: `我的書 ${XSS}`, words: [
                { id: 'a', word: 'apple', meaning: '苹果', phonetic: 'ˈæpl' },
                { id: 'b', word: 'book', meaning: '书', phonetic: 'bʊk' }
            ]
        }];
        const { context, page } = await newPage(browser, { books });
        await page.goto(BASE, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1600);

        // 觸發 confirmAction：刪除單詞本
        await page.click('#delete-vocab-book-btn');
        await page.waitForTimeout(700);
        const injected = await page.evaluate(() => ({
            xss: window.__xss,
            overlay: !!document.querySelector('.options-modal-overlay'),
            innerHTML: document.querySelector('.options-modal-overlay') ? document.querySelector('.options-modal-overlay').innerHTML.slice(0, 400) : null,
            hasImg: !!document.querySelector('.options-modal-overlay img')
        }));
        if (injected.xss > 0 || injected.hasImg) {
            record('security/xss', 'high', '詞書名稱未轉義即插入 confirmAction 彈窗（可執行任意 HTML/JS）',
                `window.__xss=${injected.xss}，彈窗內出現 <img>：${injected.hasImg}\n來源：modules/ui.js showOptionsModal 以 innerHTML 拼接 title/description，呼叫端帶入使用者可控的詞書名稱（vocabulary.js defaultConfirmOverwrite / importDetectedUrl）`);
        } else {
            ok('confirmAction 未觸發注入（名稱未被放入 innerHTML）');
        }
        await page.screenshot({ path: path.join(ASSETS, 'security-xss-bookname.png') });
        await context.close();
    }

    // ---------------------------------------------------------- 2. 匯入流程的注入
    {
        const { context, page } = await newPage(browser, { books: [] });
        await page.goto(BASE, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1600);
        // 直接用模組 API 觸發（模擬匯入檔名/URL 帶入特殊字元）
        const res = await page.evaluate(async (payload) => {
            const ui = await import('/modules/ui.js');
            ui.confirmAction({ title: 't', message: payload, danger: true });
            await new Promise(r => setTimeout(r, 300));
            const ov = document.querySelector('.options-modal-overlay');
            return { xss: window.__xss, hasImg: !!ov?.querySelector('img'), snippet: ov ? ov.innerHTML.slice(0, 300) : null };
        }, `書名：${XSS}`);
        if (res.xss > 0 || res.hasImg) {
            record('security/xss', 'high', 'ui.confirmAction 的 message 參數未轉義（任何呼叫端帶入使用者字串都會執行）', JSON.stringify(res).slice(0, 400));
        } else ok('confirmAction message 已安全');
        await context.close();
    }

    // ---------------------------------------------------------- 3. 其他 innerHTML 拼接點
    {
        const { context, page } = await newPage(browser, { books: [{ id: 'b', name: '本', words: [{ id: 'a', word: 'apple', meaning: '苹果', phonetic: 'x' }] }] });
        await page.goto(BASE, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1500);
        const res = await page.evaluate(async (payload) => {
            const results = {};
            // 選項彈窗（OCR/設定會用到）的 option label/description
            const ui = await import('/modules/ui.js');
            ui.showOptionsModal({
                title: payload,
                description: payload,
                options: [{
                    key: 'k', type: 'radio', label: payload, description: payload,
                    choices: [{ value: 'v', label: payload, description: payload }]
                }],
                onConfirm: () => {}, onCancel: () => {}
            });
            await new Promise(r => setTimeout(r, 300));
            const ov = document.querySelector('.options-modal-overlay');
            results.xss = window.__xss;
            results.imgs = ov ? ov.querySelectorAll('img').length : -1;
            return results;
        }, XSS);
        if (res.xss > 0 || res.imgs > 0) {
            record('security/xss', 'high', 'ui.showOptionsModal 的選項 label/description 未轉義（createRadioOption 等以 innerHTML 拼接）', JSON.stringify(res));
        } else ok('showOptionsModal 選項已安全');
        await context.close();
    }

    // ---------------------------------------------------------- 4. URL 參數注入
    {
        const { context, page } = await newPage(browser, { books: [] });
        const c = { errors: [] };
        page.on('pageerror', e => c.errors.push(String(e)));
        await page.goto(`${BASE}?wordlistUrl=javascript:alert(1)&wordlist=${encodeURIComponent(XSS)}`, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2500);
        const res = await page.evaluate(() => ({ xss: window.__xss, bodyImgs: document.querySelectorAll('body img').length }));
        if (res.xss > 0) record('security/xss', 'high', 'wordlistUrl / wordlist 參數造成注入', JSON.stringify(res));
        else ok(`URL 參數未造成注入（img=${res.bodyImgs}）`);
        if (c.errors.length) record('robustness', 'medium', 'URL 參數造成未捕捉例外', c.errors.join(' | '));
        await context.close();
    }

    // ---------------------------------------------------------- 5. javascript: URL 是否會被設進 href
    {
        const { context, page } = await newPage(browser, { books: [] });
        await page.goto(`${BASE}?wordlistUrl=javascript:alert(document.domain)`, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2500);
        const hrefs = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]')).map(a => a.getAttribute('href')).filter(h => /^javascript:/i.test(h)));
        if (hrefs.length) record('security', 'high', 'javascript: 形式的 URL 被設進 <a href>', hrefs.join(', '));
        else ok('沒有 javascript: href');
        await context.close();
    }

    // ---------------------------------------------------------- 6. 超長輸入
    {
        const { context, page } = await newPage(browser, { books: [{ id: 'b', name: '本', words: [{ id: 'a', word: 'apple', meaning: '苹果', phonetic: 'x' }] }] });
        await page.goto(BASE, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1500);
        const res = await page.evaluate(async () => {
            const ui = await import('/modules/ui.js');
            const long = 'A'.repeat(200000);
            ui.displayMessage(long, 'info', 500);
            await new Promise(r => setTimeout(r, 400));
            const el = document.querySelector('#message-container > *');
            return { rendered: el ? el.textContent.length : 0, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
        });
        ok(`超長提示訊息渲染 ${res.rendered} 字，水平溢出 ${res.overflow}px`);
        if (res.overflow > 2) record('robustness', 'low', '超長提示訊息造成水平溢出', JSON.stringify(res));
        await context.close();
    }

    // ---------------------------------------------------------- 7. 外部連結 rel / target
    {
        const { context, page } = await newPage(browser, {});
        await page.goto(BASE, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1500);
        const links = await page.evaluate(() => Array.from(document.querySelectorAll('a[target="_blank"]')).map(a => ({ href: a.href, rel: a.getAttribute('rel') })));
        const unsafe = links.filter(l => !l.rel || !/noopener|noreferrer/.test(l.rel));
        if (unsafe.length) record('security', 'low', 'target="_blank" 連結缺少 rel=noopener', JSON.stringify(unsafe).slice(0, 300));
        else ok(`target=_blank 連結共 ${links.length} 個，rel 皆正確`);
        await context.close();
    }

    // ---------------------------------------------------------- 8. ai-config 外洩檢查
    // ai-config.js 是前端模組會直接 import 的檔案，serve.py 必須提供它才能啟動；
    // 因此這裡的結論是「部署時必須自行排除」，而不是「伺服器設定錯誤」。
    {
        const r = await fetch(BASE + 'ai-config.js');
        if (r.status === 200) {
            const body = await r.text();
            const keyHits = [...body.matchAll(/sk-[A-Za-z0-9_-]{20,}/g)].length;
            record('security/secrets', keyHits > 0 ? 'high' : 'info',
                `ai-config.js 會由靜態伺服器提供，內含 ${keyHits} 組硬編碼 API Key`,
                '前端模組必須載入此檔，無法在伺服器層封鎖。部署到公開主機時必須排除 /ai-config.js（且金鑰應改由後端代理），否則等同公開所有金鑰。');
        } else ok('ai-config.js 未被伺服器提供（若前端的 import 仍指向它，應用會起不來）');
    }

    // ---------------------------------------------------------- 9. 目錄/檔案暴露
    {
        const probes = ['/docs/', '/.git/config', '/wordlists/', '/scripts/serve.py', '/.DS_Store',
                        '/tests/', '/.venv/', '/docs/report/root-audit/e2e-phase1.json', '/.git/HEAD'];
        const exposed = [];
        for (const p of probes) {
            const r = await fetch(BASE + p.replace(/^\//, '')).catch(() => null);
            if (r && r.status === 200) exposed.push(`${p} -> 200 (${(await r.text()).length} bytes)`);
        }
        if (exposed.length) record('security', 'medium', '靜態伺服器暴露了不該公開的檔案／目錄', exposed.join(' | '));
        else ok('探測的敏感路徑（.git / tests / scripts / .venv / docs 產物）皆已封鎖');
    }

    await browser.close();
    const out = path.join(ASSETS, 'security.json');
    fs.writeFileSync(out, JSON.stringify({ findings, generatedAt: new Date().toISOString() }, null, 2));
    console.log(`\n=== 共 ${findings.length} 項發現 -> ${out} ===`);
}

main().catch(e => { console.error(e); process.exit(1); });
