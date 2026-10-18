/**
 * 雙語切換精確比對：
 *  1. 以 zh-CN 載入，套用 zh-HK 後檢查畫面上是否仍有「等於 zh-CN 字典值」的文字
 *  2. 反向再測一次
 *  3. 逐模組檢查
 *  4. 檢查齒輪選單 / 設定彈窗等延遲建立的 UI
 *
 * 用法：node tests/audit-locale.cjs --port 8399
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
    findings.push({ area, severity, title, detail: String(detail === undefined ? '' : detail).slice(0, 2000) });
    console.log(`[${severity}] ${area} :: ${title}\n        ${String(detail).slice(0, 600)}`);
}
function ok(m) { console.log(`  ok   ${m}`); }

const MODULES = ['v', 'd', 'l', 'qa', 'a', 'ocr', 'q'];

async function open(browser) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.route('**/*', (route) => {
        let host = '';
        try { host = new URL(route.request().url()).hostname; } catch (_) { return route.abort(); }
        return (host === '127.0.0.1' || host === 'localhost') ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
        localStorage.clear();
        localStorage.setItem('vocabImportPromptShown', '1');
        localStorage.setItem('vocabularyBooks', JSON.stringify([{
            id: 'b', name: '巡检词书',
            words: [
                { id: 'w1', word: 'apple', meaning: '苹果', phonetic: 'ˈæpl' },
                { id: 'w2', word: 'running', meaning: '跑步', phonetic: 'ˈrʌnɪŋ' },
                { id: 'w3', word: 'notebook', meaning: '笔记本', phonetic: 'ˈnəʊtbʊk' },
                { id: 'w4', word: 'beautiful', meaning: '美丽的', phonetic: 'ˈbjuːtɪfl' }
            ]
        }]));
        localStorage.setItem('activeBookId', 'b');
        localStorage.setItem('pen_global_settings', JSON.stringify({ language: { interfaceLocale: 'zh-CN' }, assistant: { enabled: true } }));
    });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1800);
    return { context, page };
}

// 在頁面內：找出可見元素的文字（或 title/placeholder/aria-label）等於 zh-CN 字典值、但在 zh-HK 下不該出現者
async function collectResidual(page) {
    return page.evaluate(async () => {
        const cn = (await import('/locales/zh-CN.js')).default;
        const hk = (await import('/locales/zh-HK.js')).default;
        // 建立「zh-CN 值 → key」索引，只收錄兩語差異的字串
        const flat = (o, p = '', out = {}) => {
            for (const [k, v] of Object.entries(o)) {
                const key = p ? `${p}.${k}` : k;
                if (v && typeof v === 'object') flat(v, key, out); else out[key] = v;
            }
            return out;
        };
        const CN = flat(cn), HK = flat(hk);
        const diffVal = new Map();
        for (const [k, v] of Object.entries(CN)) {
            if (typeof v !== 'string') continue;
            if (HK[k] === v) continue;
            if (v.length < 2 || v.length > 80) continue;
            if (!/[\u4e00-\u9fff]/.test(v)) continue;
            if (!diffVal.has(v)) diffVal.set(v, k);
        }

        const out = [];
        const seen = new Set();
        document.querySelectorAll('body *').forEach((el) => {
            if (el.children.length) return;
            const cs = getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden' || el.offsetParent === null) return;
            const candidates = [
                ['text', (el.textContent || '').trim()],
                ['title', el.getAttribute('title') || ''],
                ['placeholder', el.getAttribute('placeholder') || ''],
                ['aria-label', el.getAttribute('aria-label') || '']
            ];
            for (const [kind, val] of candidates) {
                if (!val) continue;
                const key = diffVal.get(val);
                if (!key) continue;
                const tag = `${el.tagName}${el.id ? '#' + el.id : ''}${typeof el.className === 'string' && el.className ? '.' + el.className.split(/\s+/)[0] : ''}`;
                const rec = `${tag} [${kind}] "${val}"  ← i18n 鍵 ${key} 的 zh-CN 值`;
                if (seen.has(rec)) continue;
                seen.add(rec);
                out.push(rec);
            }
        });
        return out;
    });
}

async function run(browser, { label, fromLocale, toLocale }) {
    const { context, page } = await open(browser);
    // 先明確切到 fromLocale，確認基準狀態，再切到 toLocale 觀察是否有殘留
    await page.evaluate(async (l) => {
        const m = await import('/modules/i18n.js');
        m.setLocale(l, { persist: false });
    }, fromLocale);
    await page.waitForTimeout(600);
    const before = await collectResidual(page);
    ok(`${label}：${fromLocale} 基準狀態殘留 ${before.length} 處`);

    await page.evaluate(async (l) => {
        const m = await import('/modules/i18n.js');
        m.setLocale(l, { persist: false });
    }, toLocale);
    await page.waitForTimeout(900);

    for (const mod of MODULES) {
        await page.evaluate((m) => {
            const b = document.getElementById({ v: 'vocabulary-btn', d: 'dictation-btn', l: 'learning-btn', qa: 'qa-btn', a: 'article-btn', ocr: 'ocr-btn', q: 'quiz-btn' }[m]);
            if (b) b.click();
        }, mod);
        await page.waitForTimeout(700);
        const residual = await collectResidual(page);
        if (residual.length) {
            record('i18n/residual', 'medium', `${label}：切換到 ${toLocale} 後「${mod}」頁仍有 ${residual.length} 處未更新為 ${toLocale} 的文案`,
                residual.slice(0, 10).join('\n'));
        } else ok(`${label} ${mod} 無殘留`);
    }

    // 齒輪選單與設定彈窗（延遲建立）
    await page.click('#app-gear-btn').catch(() => {});
    await page.waitForTimeout(800);
    let residual = await collectResidual(page);
    if (residual.length) record('i18n/residual', 'medium', `${label}：齒輪選單在 ${toLocale} 下仍有 ${residual.length} 處未更新`, residual.slice(0, 10).join('\n'));
    else ok(`${label} 齒輪選單無殘留`);

    const gearInfo = await page.evaluate(() => {
        const menu = document.querySelector('.gear-menu');
        if (!menu) return null;
        return {
            cls: menu.className,
            visible: getComputedStyle(menu).display !== 'none',
            html: menu.innerHTML.replace(/\s+/g, ' ').slice(0, 600),
            buttons: Array.from(menu.querySelectorAll('button, a')).map(b => b.textContent.trim())
        };
    });
    ok(`${label} 齒輪選單內容：${JSON.stringify(gearInfo).slice(0, 400)}`);
    await page.screenshot({ path: path.join(ASSETS, `locale-${toLocale}-gear.png`) });

    await context.close();
    return gearInfo;
}

async function main() {
    const browser = await chromium.launch({ executablePath: CHROME });
    // 只有 CN→HK 這個方向有意義：判準是「畫面上還有等於 zh-CN 字典值的文字」。
    // 切到 zh-CN 時，畫面本來就該等於 zh-CN 字典值，同一個判準會把所有正確結果都報成殘留。
    await run(browser, { label: 'CN→HK', fromLocale: 'zh-CN', toLocale: 'zh-HK' });
    await browser.close();
    const out = path.join(ASSETS, 'locale.json');
    fs.writeFileSync(out, JSON.stringify({ findings, generatedAt: new Date().toISOString() }, null, 2));
    console.log(`\n=== 共 ${findings.length} 項發現 -> ${out} ===`);
}

main().catch(e => { console.error(e); process.exit(1); });
