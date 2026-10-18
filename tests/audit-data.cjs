/**
 * BDC 資料完整性與注入面巡檢
 *  1. 問答集解析：落單的奇數行是否被無聲丟棄
 *  2. 使用者可控字串在各模組渲染時是否轉義
 *  3. 各模組匯出的純函式邊界行為
 *
 * 用法：node tests/audit-data.cjs --port 8399
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
    findings.push({ area, severity, title, detail: String(detail === undefined ? '' : detail).slice(0, 600) });
    console.log(`[${severity}] ${area} :: ${title}\n        ${String(detail).slice(0, 400)}`);
}
function ok(m) { console.log(`  ok   ${m}`); }

const XSS = `<img src=x onerror="window.__xss=(window.__xss||0)+1">`;

async function open(browser, { books, qaSets, storage = {} } = {}) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.route('**/*', (route) => {
        let host = '';
        try { host = new URL(route.request().url()).hostname; } catch (_) { return route.abort(); }
        return (host === '127.0.0.1' || host === 'localhost') ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    await page.addInitScript(({ books, qaSets, storage }) => {
        window.__xss = 0;
        localStorage.clear();
        localStorage.setItem('vocabImportPromptShown', '1');
        localStorage.setItem('pen_global_settings', JSON.stringify({ language: { interfaceLocale: 'zh-CN' }, assistant: { enabled: false } }));
        if (books) { localStorage.setItem('vocabularyBooks', JSON.stringify(books)); localStorage.setItem('activeBookId', books[0].id); }
        if (qaSets) {
            localStorage.setItem('qa-sets', JSON.stringify(qaSets.map(s => ({ id: s.id, name: s.name, description: s.description, count: s.pairs ? s.pairs.length : 0, preset: false }))));
            for (const s of qaSets) localStorage.setItem(`qa-set-${s.id}`, JSON.stringify(s));
        }
        for (const [k, v] of Object.entries(storage)) localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
    }, { books: books || null, qaSets: qaSets || null, storage });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1600);
    return { context, page };
}

async function main() {
    const browser = await chromium.launch({ executablePath: CHROME });

    // ---------------------------------------------------- 1. parseQAPairs 落單行
    {
        const { context, page } = await open(browser, {});
        const res = await page.evaluate(async () => {
            const m = await import('/features/qa/qa-creator.js');
            const cases = {
                '正常兩組': 'Q1?\nA1.\nQ2?\nA2.',
                '落單一行（奇數行）': 'Q1?\nA1.\nQ2?',
                '落單一行在最前': 'Q1?\nQ2?\nA2.',
                '只有一行': 'Q1?',
                '空字串': '',
                '只有問沒有答（標籤式）': 'Q1: What?\nQ2: Where?\nA1: This\nA2: There'
            };
            const out = {};
            for (const [k, v] of Object.entries(cases)) {
                const detail = m.analyzeQAPairs ? m.analyzeQAPairs(v) : { pairs: m.parseQAPairs(v), warnings: [] };
                const pairs = detail.pairs;
                out[k] = { pairCount: pairs.length, pairs, warnings: detail.warnings || [], valid: m.validateFormat(pairs).isValid, errors: m.validateFormat(pairs).errors };
            }
            return out;
        });
        const odd = res['落單一行（奇數行）'];
        const warnings = odd.warnings || [];
        if (odd.pairCount === 1 && !warnings.length) {
            record('qa/data', 'medium', '問答集解析會「無聲丟棄」落單的最後一行，且未回報警告',
                `輸入 "Q1?\\nA1.\\nQ2?" → 解析出 ${odd.pairCount} 組、warnings=${JSON.stringify(warnings)}。`);
        } else if (odd.pairCount === 1 && warnings.length) {
            ok(`落單行仍不採用（預期行為），但已回報警告：${JSON.stringify(warnings)}`);
        } else ok(`落單行處理：${JSON.stringify(odd)}`);
        record('qa/data', 'info', 'parseQAPairs 其他案例結果', JSON.stringify(res, null, 1).slice(0, 1200));
        await context.close();
    }

    // ---------------------------------------------------- 2. 單詞本名稱注入（清單 / 標題 / 確認框）
    {
        const books = [{ id: 'x', name: `書${XSS}`, words: [{ id: 'a', word: `word${XSS}`, meaning: `意${XSS}`, phonetic: 'x' }] }];
        const { context, page } = await open(browser, { books });
        await page.waitForTimeout(600);
        const res = await page.evaluate(() => ({
            xss: window.__xss,
            imgs: document.querySelectorAll('body img').length,
            anyOnError: document.querySelectorAll('body [onerror]').length,
            bookListHTML: document.getElementById('vocab-book-list').innerHTML.slice(0, 300)
        }));
        if (res.xss > 0) record('security/xss', 'high', '單詞本清單渲染未轉義（詞書名 / 單詞名可執行 HTML）', JSON.stringify(res).slice(0, 400));
        else ok(`單詞本清單渲染已轉義（img=${res.imgs}, onerror=${res.anyOnError}）`);
        await context.close();
    }

    // ---------------------------------------------------- 3. 問答集名稱注入
    {
        const qaSets = [{ id: 'xset', name: `集${XSS}`, description: `述${XSS}`, pairs: [{ qid: 1, question: `問${XSS}`, answer: 'a' }], preset: false }];
        const { context, page } = await open(browser, { qaSets });
        await page.goto(BASE + '#qa', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2500);
        const res = await page.evaluate(() => ({
            xss: window.__xss,
            imgs: document.querySelectorAll('body img').length,
            listHTML: document.getElementById('qa-sets-list').innerHTML.slice(0, 400)
        }));
        if (res.xss > 0) record('security/xss', 'high', '問答集清單渲染未轉義（名稱 / 描述可執行 HTML）', JSON.stringify(res).slice(0, 400));
        else ok(`問答集清單渲染已轉義（img=${res.imgs}）`);
        await context.close();
    }

    // ---------------------------------------------------- 4. 文章標題注入
    {
        const articles = [{ id: 'art1', title: `標題${XSS}`, content: 'hello world', createdAt: new Date().toISOString(), paragraphs: [] }];
        const { context, page } = await open(browser, { storage: { analyzedArticles: articles, activeArticleId: 'art1' } });
        await page.goto(BASE + '#a', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2500);
        const res = await page.evaluate(() => ({ xss: window.__xss, imgs: document.querySelectorAll('body img').length }));
        if (res.xss > 0) record('security/xss', 'high', '文章標題渲染未轉義', JSON.stringify(res));
        else ok('文章標題渲染已轉義');
        await context.close();
    }

    // ---------------------------------------------------- 5. 空/異常資料的模組函式
    {
        const { context, page } = await open(browser, {});
        const res = await page.evaluate(async () => {
            const out = {};
            try {
                const qa = await import('/features/qa/qa-creator.js');
                out.parseQAPairs_null = qa.parseQAPairs(null);
                out.parseQAPairs_number = qa.parseQAPairs(12345);
                out.validateFormat_empty = qa.validateFormat([]);
                out.preview_empty = qa.generatePreviewHTML(null).slice(0, 60);
            } catch (e) { out.qaError = String(e); }
            try {
                const v = await import('/modules/validate.js');
                out.validateExports = Object.keys(v);
            } catch (e) { out.validateError = String(e); }
            try {
                const mk = await import('/modules/markdown.js');
                out.mdExports = Object.keys(mk);
            } catch (e) { out.mdError = String(e); }
            return out;
        });
        if (res.qaError) record('robustness', 'medium', 'qa-creator 純函式遇到非字串輸入會拋錯', res.qaError);
        else ok(`qa-creator 邊界輸入正常：${JSON.stringify(res).slice(0, 300)}`);
        await context.close();
    }

    // ---------------------------------------------------- 6. 匯入檔案格式錯誤處理
    {
        const { context, page } = await open(browser, {});
        await page.goto(BASE, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1500);
        const res = await page.evaluate(async () => {
            const out = {};
            try {
                const st = await import('/modules/storage.js');
                out.storageExports = Object.keys(st).filter(k => /import|parse|normal/i.test(k));
            } catch (e) { out.err = String(e); }
            return out;
        });
        ok(`storage 匯入相關匯出：${JSON.stringify(res)}`);
        await context.close();
    }

    // ---------------------------------------------------- 7. localStorage 配額 / 超大資料
    {
        const big = [];
        for (let i = 0; i < 3; i++) {
            big.push({
                id: `big-${i}`, name: `大書 ${i}`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
                words: Array.from({ length: 4000 }, (_, j) => ({ id: `w${i}-${j}`, word: `word${j}`, meaning: `释义${j}`, phonetic: 'x' }))
            });
        }
        const { context, page } = await open(browser, { books: big });
        const t0 = Date.now();
        await page.waitForTimeout(3000);
        const res = await page.evaluate(() => ({
            rendered: document.querySelectorAll('#word-list > *').length,
            listText: document.getElementById('word-list').textContent.slice(0, 60),
            scrollH: document.getElementById('word-list').scrollHeight,
            domNodes: document.querySelectorAll('*').length,
            sentinelText: document.querySelector('#word-list .word-item-sentinel')?.textContent?.trim() || null,
            selectedBook: document.getElementById('current-book-name').textContent.trim()
        }));
        ok(`1.2 萬詞首屏（${Date.now() - t0}ms）：${JSON.stringify(res)}`);
        if (res.domNodes > 20000) {
            record('performance', 'medium', '大量單詞時一次渲染全部 DOM 節點，沒有增量渲染', `節點數 ${res.domNodes}，清單高度 ${res.scrollH}px`);
        }
        if (res.rendered >= 4000) {
            record('performance', 'medium', '4000 詞的詞書首屏就渲染了全部節點，增量渲染沒有生效', `渲染 ${res.rendered} 筆`);
        }
        if (!res.sentinelText) {
            record('performance', 'low', '增量渲染沒有顯示「已載入 n / 共 m」提示', JSON.stringify(res));
        }
        // 捲到底應該繼續載入
        const scrollToEnd = () => page.evaluate(() => {
            let el = document.getElementById('word-list');
            while (el) {
                if (el.scrollHeight > el.clientHeight) el.scrollTop = el.scrollHeight;
                el = el.parentElement;
            }
            window.scrollTo(0, document.body.scrollHeight);
        });
        await scrollToEnd();
        await page.waitForTimeout(700);
        await scrollToEnd();
        await page.waitForTimeout(700);
        const afterScroll = await page.evaluate(() => document.querySelectorAll('#word-list .word-item').length);
        ok(`捲到底後載入：${res.rendered} → ${afterScroll} 筆`);
        if (afterScroll <= res.rendered) {
            record('performance', 'medium', '大型詞書捲到底沒有繼續載入（增量渲染失效）', `before=${res.rendered} after=${afterScroll}`);
        }
        await context.close();
    }

    // ---------------------------------------------------- 8. 篩選效能與正確性（特殊字元）
    {
        const books = [{ id: 'b', name: '本', words: [
            { id: '1', word: 'a+b', meaning: '加號', phonetic: 'x' },
            { id: '2', word: 'a.b', meaning: '點', phonetic: 'x' },
            { id: '3', word: 'C++', meaning: '語言', phonetic: 'x' },
            { id: '4', word: 'apple', meaning: '苹果', phonetic: 'x' }
        ] }];
        const { context, page } = await open(browser, { books });
        await page.waitForTimeout(800);
        for (const term of ['a+b', 'a.b', 'C++', '(']) {
            await page.fill('#word-filter', term);
            await page.waitForTimeout(250);
            const list = await page.evaluate(() => document.getElementById('word-list').textContent.replace(/\s+/g, ' ').trim().slice(0, 80));
            ok(`篩選「${term}」→ ${list || '(空)'}`);
            if (/error|undefined|NaN/.test(list)) record('vocabulary', 'medium', `篩選特殊字元「${term}」結果異常`, list);
        }
        const errs = await page.evaluate(() => window.__errs || []);
        await context.close();
    }

    await browser.close();
    const out = path.join(ASSETS, 'data.json');
    fs.writeFileSync(out, JSON.stringify({ findings, generatedAt: new Date().toISOString() }, null, 2));
    console.log(`\n=== 共 ${findings.length} 項發現 -> ${out} ===`);
}

main().catch(e => { console.error(e); process.exit(1); });
