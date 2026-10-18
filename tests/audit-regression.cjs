/**
 * BDC 重點回歸巡檢（第三階段）
 *  - 文章浮動朗讀列：顯示 / 關閉 / 結束 / 重新叫回 / 雙語更新（對應 20261015222827200 修復報告）
 *  - 文章：空內容送出、清除、來源列
 *  - OCR：錯誤路徑、進度文案
 *  - 聽寫：AI 批改、浮動控制列
 *  - test-floating-statusbar.html 的按鈕是否真的可用
 *
 * 用法：node tests/audit-regression.cjs --port 8399 [--only=reader,article,ocr,dictation,statusbar]
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
    findings.push({ area, severity, title, detail: String(detail === undefined ? '' : detail).slice(0, 800) });
    console.log(`[${severity}] ${area} :: ${title}\n        ${String(detail).slice(0, 400)}`);
}
function ok(m) { console.log(`  ok   ${m}`); }

const BOOKS = [{
    id: 'b', name: '巡檢詞書',
    words: [
        { id: 'w1', word: 'apple', meaning: '苹果', phonetic: 'ˈæpl' },
        { id: 'w2', word: 'notebook', meaning: '笔记本', phonetic: 'ˈnəʊtbʊk' },
        { id: 'w3', word: 'running', meaning: '跑步', phonetic: 'ˈrʌnɪŋ' },
        { id: 'w4', word: 'beautiful', meaning: '美丽的', phonetic: 'ˈbjuːtɪfl' }
    ]
}];

async function open(browser, { viewport = { width: 1280, height: 900 }, storage = {}, stubTts = false } = {}) {
    const context = await browser.newContext({ viewport });
    await context.route('**/*', (route) => {
        let host = '';
        try { host = new URL(route.request().url()).hostname; } catch (_) { return route.abort(); }
        return (host === '127.0.0.1' || host === 'localhost') ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    await page.addInitScript(({ storage, stubTts }) => {
        localStorage.clear();
        localStorage.setItem('vocabImportPromptShown', '1');
        localStorage.setItem('vocabularyBooks', JSON.stringify([{
            id: 'b', name: '巡檢詞書',
            words: [
                { id: 'w1', word: 'apple', meaning: '苹果', phonetic: 'ˈæpl' },
                { id: 'w2', word: 'notebook', meaning: '笔记本', phonetic: 'ˈnəʊtbʊk' },
                { id: 'w3', word: 'running', meaning: '跑步', phonetic: 'ˈrʌnɪŋ' },
                { id: 'w4', word: 'beautiful', meaning: '美丽的', phonetic: 'ˈbjuːtɪfl' }
            ]
        }]));
        localStorage.setItem('activeBookId', 'b');
        localStorage.setItem('pen_global_settings', JSON.stringify({ language: { interfaceLocale: 'zh-CN' }, assistant: { enabled: false } }));
        // 預設不安裝假的 speechSynthesis：它會在 speak() 內同步呼叫 onstart/onend，
        // 讓文章的朗讀流程誤判為「已播完」，浮動朗讀列也就不會出現（假陰性）。
        if (stubTts) {
            let timer;
            const synth = window.speechSynthesis;
            if (synth) {
                window.__spoken = [];
                synth.speak = u => { window.__spoken.push(u.text); u.onstart && u.onstart(); timer = setTimeout(() => u.onend && u.onend(), 300); };
                synth.cancel = () => clearTimeout(timer);
            }
        }
        for (const [k, v] of Object.entries(storage)) localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
    }, { storage, stubTts });
    return { context, page };
}

const readerState = (page) => page.evaluate(() => {
    const el = document.querySelector('.floating-reader');
    if (!el) return { exists: false };
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
        exists: true, display: cs.display, visible: cs.display !== 'none' && r.height > 0,
        cls: el.className, bodyFlag: document.body.classList.contains('has-floating-reader'),
        text: el.textContent.trim().replace(/\s+/g, ' ').slice(0, 120),
        buttons: Array.from(el.querySelectorAll('button')).map(b => (b.textContent || b.getAttribute('aria-label') || '').trim())
    };
});

async function flowReader(browser) {
    console.log('\n### 文章浮動朗讀列回歸');
    const { context, page } = await open(browser, { viewport: { width: 1100, height: 850 } });
    const errs = [];
    page.on('pageerror', e => errs.push(String(e).slice(0, 200)));
    await page.goto(BASE + '#a', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1800);

    const before = await readerState(page);
    ok(`朗讀前朗讀列：${JSON.stringify(before)}`);
    if (before.exists && before.visible) record('article/reader', 'medium', '尚未開始朗讀時浮動朗讀列就已顯示', JSON.stringify(before));

    // 有內容才可朗讀；先塞一段文字
    await page.evaluate(() => {
        const ta = document.getElementById('article-input');
        ta.value = 'The quick brown fox jumps over the lazy dog. It is a fine day today. We go to the park together.';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForTimeout(400);
    await page.click('#read-article-btn');
    await page.waitForTimeout(2500);
    const playing = await readerState(page);
    ok(`朗讀中：${JSON.stringify(playing)}`);
    if (!playing.visible) record('article/reader', 'high', '按「朗讀文章」後浮動朗讀列沒有出現', JSON.stringify(playing));

    // 關閉
    const closed = await page.evaluate(() => {
        const btn = document.querySelector('.floating-reader .fr-close');
        if (!btn) return 'no-close-btn';
        btn.click(); return 'clicked';
    });
    await page.waitForTimeout(700);
    const afterClose = await readerState(page);
    ok(`關閉按鈕 ${closed} → ${JSON.stringify(afterClose)}`);
    if (closed !== 'clicked') record('article/reader', 'high', '找不到朗讀列的關閉按鈕', closed);
    else if (afterClose.visible) record('article/reader', 'high', '點「關閉」後浮動朗讀列仍可見（修復回歸）', JSON.stringify(afterClose));
    else ok('關閉後朗讀列已隱藏（修復有效）');

    // 用播放控制叫回
    const reshown = await page.evaluate(() => {
        const btn = document.querySelector('.floating-reader .fr-next, .floating-reader .fr-play, .floating-reader .fr-prev');
        if (!btn) return 'no-control';
        btn.click(); return btn.className;
    });
    await page.waitForTimeout(1200);
    const afterReshow = await readerState(page);
    ok(`操作 ${reshown} 後：${JSON.stringify(afterReshow)}`);
    if (reshown !== 'no-control' && !afterReshow.visible) record('article/reader', 'medium', '關閉朗讀列後，再操作播放控制無法把它叫回來', JSON.stringify(afterReshow));

    // 雙語更新
    await page.evaluate(async () => { (await import('/modules/i18n.js')).setLocale('zh-HK', { persist: false }); });
    await page.waitForTimeout(800);
    const hk = await readerState(page);
    ok(`切 zh-HK 後朗讀列：${JSON.stringify(hk).slice(0, 300)}`);
    // 只比對「簡繁確實不同」的字串；上一句／下一句兩語相同，不能當成殘留
    const hasSimp = /朗读控制|关闭|停止朗读|暂停|跟随朗读滚动|仅显示英文/.test(hk.text + (hk.buttons || []).join(''));
    if (hasSimp) record('article/reader', 'medium', '切到 zh-HK 後朗讀列仍顯示簡體標籤', JSON.stringify(hk).slice(0, 400));
    else ok('朗讀列標籤已隨語言更新');

    // 停止朗讀
    await page.evaluate(() => {
        const btn = document.querySelector('.floating-reader .fr-stop') || document.getElementById('stop-read-article-btn');
        if (btn) btn.click();
    });
    await page.waitForTimeout(1000);
    const afterStop = await readerState(page);
    ok(`停止後：${JSON.stringify(afterStop)}`);
    if (afterStop.visible) record('article/reader', 'high', '按「結束朗讀」後浮動朗讀列仍可見', JSON.stringify(afterStop));

    // 切到別的模組後是否殘留
    await page.click('#learning-btn');
    await page.waitForTimeout(800);
    const afterNav = await readerState(page);
    if (afterNav.visible) record('article/reader', 'medium', '切到其他模組後浮動朗讀列仍殘留在畫面上', JSON.stringify(afterNav));
    else ok('切換模組後朗讀列不再殘留');

    await page.screenshot({ path: path.join(ASSETS, 'regression-reader.png') });
    if (errs.length) record('article/reader', 'medium', '朗讀列流程出現未捕捉例外', errs.join(' | '));
    await context.close();
}

async function flowArticleExtra(browser) {
    console.log('\n### 文章：空內容與清除');
    const { context, page } = await open(browser);
    const dialogs = [];
    page.on('dialog', async d => { dialogs.push(`${d.type()}: ${d.message()}`); await d.accept(); });
    await page.goto(BASE + '#a', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1800);

    // 空內容送出
    await page.evaluate(() => { const ta = document.getElementById('article-input'); ta.value = ''; ta.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.click('#analyze-article-btn');
    await page.waitForTimeout(1500);
    const toast = await page.evaluate(() => Array.from(document.querySelectorAll('#message-container > *')).map(n => n.textContent.trim()));
    const feedbackText = await page.evaluate(() => document.getElementById('article-analysis-container')?.textContent.trim().slice(0, 120));
    ok(`空內容送出 → toast=${JSON.stringify(toast)} dialogs=${JSON.stringify(dialogs)} 分析區="${feedbackText}"`);
    if (!toast.length && !dialogs.length && !feedbackText) {
        record('article', 'medium', '文章輸入為空時按「分析文章」，畫面完全沒有任何回饋', `toast=${JSON.stringify(toast)} dialogs=${JSON.stringify(dialogs)} 分析區="${feedbackText}"`);
    } else ok('空內容送出有回饋');

    // 純空白內容
    await page.evaluate(() => { const ta = document.getElementById('article-input'); ta.value = '   \n  \n   '; ta.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.click('#analyze-article-btn');
    await page.waitForTimeout(1500);
    const toast2 = await page.evaluate(() => Array.from(document.querySelectorAll('#message-container > *')).map(n => n.textContent.trim()));
    ok(`純空白送出 → toast=${JSON.stringify(toast2)}`);
    if (!toast2.length) record('article', 'low', '純空白內容送出沒有任何回饋', '');

    // 清除
    await page.evaluate(() => { const ta = document.getElementById('article-input'); ta.value = 'some text here'; ta.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.click('#clear-article-btn');
    await page.waitForTimeout(900);
    const cleared = await page.evaluate(() => ({
        input: document.getElementById('article-input').value,
        analysis: document.getElementById('article-analysis-container').innerHTML.length,
        sourceVisible: document.getElementById('article-source-bar') ? getComputedStyle(document.getElementById('article-source-bar')).display : null
    }));
    ok(`清除後：${JSON.stringify(cleared)}`);
    if (cleared.input !== '') record('article', 'medium', '「清除重写」沒有清空輸入框', JSON.stringify(cleared));

    // 文章庫載入後，歷史下拉是否同步
    await page.click('#show-article-library-btn');
    await page.waitForTimeout(1500);
    await page.evaluate(() => { document.querySelector('#article-library-list button, #article-library-list li, #article-library-list > *')?.click(); });
    await page.waitForTimeout(2500);
    const hist = await page.evaluate(() => ({
        selectValue: document.getElementById('article-history-select').value,
        options: Array.from(document.getElementById('article-history-select').options).map(o => o.textContent.slice(0, 40)),
        inputLen: document.getElementById('article-input').value.length,
        sourceLabel: document.getElementById('article-source-label')?.textContent.trim()
    }));
    ok(`從文章庫載入後：${JSON.stringify(hist)}`);
    if (hist.inputLen > 0 && !hist.selectValue) {
        record('article', 'low', '從文章庫載入文章後，「讀取歷史記錄」下拉仍停在預設選項，無法反映目前文章', JSON.stringify(hist));
    }

    await page.screenshot({ path: path.join(ASSETS, 'regression-article.png') });
    await context.close();
}

async function flowOcrExtra(browser) {
    console.log('\n### OCR：錯誤路徑與進度');
    const { context, page } = await open(browser);
    const errs = [];
    page.on('pageerror', e => errs.push(String(e).slice(0, 200)));
    await page.goto(BASE + '#ocr', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1800);

    // 無圖執行
    await page.click('#ocr-run-btn');
    await page.waitForTimeout(1500);
    let toast = await page.evaluate(() => Array.from(document.querySelectorAll('#message-container > *')).map(n => n.textContent.trim()));
    const dialogs = [];
    page.on('dialog', async d => { dialogs.push(d.message()); await d.accept(); });
    ok(`無圖執行 → toast=${JSON.stringify(toast)}`);
    if (!toast.length) record('ocr', 'medium', '沒有選圖就按「開始識別」沒有任何提示（應提示「請先選擇圖片」）', `toast=${JSON.stringify(toast)}`);

    // 選圖後執行（AI 不可達）
    await page.setInputFiles('#ocr-image-input', path.join(ROOT, '5AU1_1.jpg'));
    await page.waitForTimeout(2000);
    await page.click('#ocr-run-btn');
    await page.waitForTimeout(6000);
    const after = await page.evaluate(() => ({
        progressText: document.getElementById('ocr-progress-text')?.textContent.trim(),
        progressRow: document.getElementById('ocr-progress-row') ? getComputedStyle(document.getElementById('ocr-progress-row')).display : null,
        resultText: document.getElementById('ocr-result')?.textContent.trim().slice(0, 200),
        resultPreviewLen: document.getElementById('ocr-result-preview')?.innerHTML.length,
        runBtnText: document.getElementById('ocr-run-btn')?.textContent.trim(),
        runBtnDisabled: document.getElementById('ocr-run-btn')?.disabled,
        toasts: Array.from(document.querySelectorAll('#message-container > *')).map(n => n.textContent.trim())
    }));
    ok(`OCR 執行後：${JSON.stringify(after)}`);
    if (!after.resultText && !after.toasts.length) {
        record('ocr', 'high', 'AI 不可用時，OCR 進度顯示「完成」但結果為空，且沒有任何錯誤提示，使用者無從得知失敗原因',
            JSON.stringify(after));
    }
    if (after.runBtnDisabled) record('ocr', 'medium', 'OCR 失敗後「開始識別」按鈕仍為停用狀態，無法重試', JSON.stringify(after));
    await page.screenshot({ path: path.join(ASSETS, 'regression-ocr.png') });
    if (errs.length) record('ocr', 'medium', 'OCR 流程未捕捉例外', errs.join(' | '));
    await context.close();
}

async function flowDictationExtra(browser) {
    console.log('\n### 聽寫：AI 批改與浮動控制列');
    const { context, page } = await open(browser);
    await page.goto(BASE + '#d', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1800);

    // 切到跟打練習
    await page.evaluate(() => { const r = document.getElementById('dictation-typed-mode'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.waitForTimeout(400);
    await page.click('#start-dictation-btn');
    await page.waitForTimeout(2500);

    await page.fill('#dictation-input', 'wrongspelling');
    await page.click('#check-dictation-btn');
    await page.waitForTimeout(800);
    const result1 = await page.evaluate(() => document.getElementById('dictation-result').textContent.trim());
    ok(`拼錯結果：${result1}`);

    // 「AI 批改手写」是開啟批改彈窗（不是就地產生提示），所以要看彈窗狀態
    await page.click('#dictation-ai-grade-btn');
    await page.waitForTimeout(1500);
    const gradeModal = await page.evaluate(() => {
        const open = !document.getElementById('app-modal').classList.contains('hidden');
        if (!open) return { open: false };
        const body = document.getElementById('modal-body');
        return {
            open: true,
            title: document.getElementById('modal-title').textContent.trim(),
            buttons: Array.from(body.querySelectorAll('button')).map(b => b.textContent.trim()),
            bodyLen: body.textContent.trim().length
        };
    });
    ok(`AI 批改彈窗：${JSON.stringify(gradeModal)}`);
    if (!gradeModal.open) {
        record('dictation', 'high', '點「AI 批改手写」沒有開啟批改彈窗', JSON.stringify(gradeModal));
    } else {
        // 沒有圖片就按「识别并批改」應給出明確提示，而不是靜默無反應
        const runBtn = await page.evaluate(() => {
            const b = Array.from(document.querySelectorAll('#modal-body button')).find(x => /识别并批改|批改/.test(x.textContent));
            if (!b) return null;
            b.click(); return b.textContent.trim();
        });
        await page.waitForTimeout(1200);
        const gradeFeedback = await page.evaluate(() => ({
            texts: Array.from(document.querySelectorAll('#modal-body *')).filter(e => !e.children.length && e.textContent.trim()).map(e => e.textContent.trim()).slice(-3),
            toasts: Array.from(document.querySelectorAll('#message-container .message-toast')).map(n => n.textContent.trim())
        }));
        ok(`按下「${runBtn}」後回饋：${JSON.stringify(gradeFeedback)}`);
        const hasFeedback = gradeFeedback.texts.some(x => /请先|上传|拍照|失败/.test(x)) || gradeFeedback.toasts.length;
        if (!hasFeedback) record('dictation', 'medium', 'AI 批改彈窗在沒有圖片時按「识别并批改」沒有任何提示', JSON.stringify(gradeFeedback));
        await page.keyboard.press('Escape');
        await page.waitForTimeout(400);
    }

    // 浮動控制列
    const floating = await page.evaluate(() => {
        const el = document.getElementById('floating-dictation-controls') || document.querySelector('.floating-dictation-controls');
        if (!el) return { exists: false };
        const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
        return {
            exists: true, display: cs.display, position: cs.position, z: cs.zIndex,
            rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
            bodyFlag: document.body.classList.contains('has-floating-player'),
            buttons: Array.from(el.querySelectorAll('button')).map(b => (b.getAttribute('aria-label') || b.textContent || '').trim())
        };
    });
    ok(`聽寫浮動控制列：${JSON.stringify(floating)}`);
    if (!floating.exists) record('dictation', 'medium', '找不到聽寫浮動控制列 #floating-dictation-controls', '');
    else if (floating.display === 'none') record('dictation', 'medium', '聽寫進行中浮動控制列沒有顯示', JSON.stringify(floating));

    // 設定卡是否應隱藏
    const cards = await page.evaluate(() => ({
        settingsCard: document.getElementById('dictation-settings-card') ? getComputedStyle(document.getElementById('dictation-settings-card')).display : null,
        player: document.getElementById('dictation-player') ? getComputedStyle(document.getElementById('dictation-player')).display : null,
        pageScroll: document.documentElement.scrollHeight,
        viewport: window.innerHeight
    }));
    ok(`聽寫進行中版面：${JSON.stringify(cards)}`);
    if (cards.settingsCard !== 'none' && cards.player !== 'none') {
        record('dictation', 'low', '聽寫進行中「設置卡」與「播放器」同時顯示，頁面較長且需要捲動才看得到播放器', JSON.stringify(cards));
    }

    await page.screenshot({ path: path.join(ASSETS, 'regression-dictation.png'), fullPage: true });
    await context.close();
}

async function flowStatusbarPage(browser) {
    console.log('\n### test-floating-statusbar.html 測試頁');
    const { context, page } = await open(browser);
    const errs = [], cerr = [];
    page.on('pageerror', e => errs.push(String(e).slice(0, 200)));
    page.on('console', m => { if (m.type() === 'error') cerr.push(m.text().slice(0, 200)); });
    await page.goto(BASE + 'test-floating-statusbar.html', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    const btns = await page.evaluate(() => Array.from(document.querySelectorAll('button')).map(b => ({ t: b.textContent.trim().slice(0, 20), id: b.id })));
    ok(`按鈕：${JSON.stringify(btns)}`);
    for (const b of btns) {
        const before = errs.length + cerr.length;
        await page.evaluate((t) => {
            const btn = Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim() === t);
            if (btn) btn.click();
        }, b.t);
        await page.waitForTimeout(700);
        if (errs.length + cerr.length > before) {
            record('testpage', 'medium', `測試頁按鈕「${b.t}」拋出錯誤`, errs.concat(cerr).slice(before).join(' | '));
        }
    }
    const out = await page.evaluate(() => document.getElementById('test-output')?.textContent.trim().slice(0, 300) || document.body.innerText.slice(-400));
    ok(`測試頁輸出尾段：${JSON.stringify(out).slice(0, 400)}`);
    if (errs.length || cerr.length) record('testpage', 'medium', '測試頁出現錯誤', errs.concat(cerr).join(' | '));
    else ok('測試頁按鈕皆未拋錯');
    await page.screenshot({ path: path.join(ASSETS, 'regression-testpage.png'), fullPage: true });
    await context.close();
}

(async () => {
    const onlyArg = (process.argv.find(a => a.startsWith('--only=')) || '').split('=')[1];
    const want = onlyArg ? new Set(onlyArg.split(',')) : null;
    const should = n => !want || want.has(n);
    const browser = await chromium.launch({ executablePath: CHROME });
    try {
        if (should('reader')) await flowReader(browser).catch(e => record('article/reader', 'high', '流程例外', e.stack?.split('\n').slice(0, 3).join(' | ')));
        if (should('article')) await flowArticleExtra(browser).catch(e => record('article', 'high', '流程例外', e.stack?.split('\n').slice(0, 3).join(' | ')));
        if (should('ocr')) await flowOcrExtra(browser).catch(e => record('ocr', 'high', '流程例外', e.stack?.split('\n').slice(0, 3).join(' | ')));
        if (should('dictation')) await flowDictationExtra(browser).catch(e => record('dictation', 'high', '流程例外', e.stack?.split('\n').slice(0, 3).join(' | ')));
        if (should('statusbar')) await flowStatusbarPage(browser).catch(e => record('testpage', 'high', '流程例外', e.stack?.split('\n').slice(0, 3).join(' | ')));
    } finally { await browser.close(); }
    const out = path.join(ASSETS, 'regression.json');
    fs.writeFileSync(out, JSON.stringify({ findings, generatedAt: new Date().toISOString() }, null, 2));
    console.log(`\n=== 共 ${findings.length} 項發現 -> ${out} ===`);
})();
