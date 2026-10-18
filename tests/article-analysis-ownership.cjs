/**
 * 文章分析生命週期驗收：慢速回應不得寫進別的文章、不得復活已刪除的文章。
 *
 * 用法：
 *   PORT=8313 PLAYWRIGHT_MODULE=<path-to-playwright> node tests/article-analysis-ownership.cjs
 *
 * 做法：在瀏覽器內建立一個指向 mock provider 的 AI profile，並用 Playwright
 * 攔截該 provider，故意延遲回應；分析期間切換／刪除文章，觀察結果歸屬。
 */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const PORT = Number(process.env.PORT || 8313);
const BASE = `http://127.0.0.1:${PORT}/`;
const ENDPOINT = process.env.TEST_SYNC_ENDPOINT || 'http://127.0.0.1:9/test-endpoint';
const PROVIDER = 'https://provider.mock/v1';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const failures = [];
function check(name, condition, detail) {
    if (condition) {
        console.log(`  ok   ${name}`);
        return true;
    }
    failures.push({ name, detail: detail === undefined ? '' : String(detail).slice(0, 400) });
    console.log(`  FAIL ${name}${detail !== undefined ? ' -- ' + String(detail).slice(0, 300) : ''}`);
    return false;
}

const PROFILE = {
    schemaVersion: 1,
    providers: {
        mock: {
            label: 'Mock',
            enabled: true,
            format: 'openai-chat',
            baseUrl: PROVIDER,
            apiUrl: `${PROVIDER}/chat/completions`,
            modelsUrl: `${PROVIDER}/models`,
            authMode: 'bearer',
            allowedModels: ['mock-model'],
            discoveredModels: [{ id: 'mock-model' }]
        }
    },
    credentials: {
        mock: {
            apiKey: 'mock-key',
            binding: {
                formatVersion: 1,
                format: 'openai-chat',
                apiUrl: `${PROVIDER}/chat/completions`,
                modelsUrl: `${PROVIDER}/models`,
                authMode: 'bearer'
            },
            version: 0,
            syncMode: 'local-only'
        }
    },
    taskModels: {
        articleParagraphTranslation: 'mock:mock-model',
        wordAnalysis: 'mock:mock-model',
        sentenceAnalysis: 'mock:mock-model',
        selectionAnalysis: 'mock:mock-model',
        default: 'mock:mock-model'
    },
    defaultModel: 'mock:mock-model'
};

async function seedDocs(page, docs) {
    return page.evaluate(async ({ endpoint, docs }) => {
        const scope = `${endpoint}::guest`;
        const db = await new Promise((resolve, reject) => {
            const req = indexedDB.open('bdc-articles', 1);
            req.onupgradeneeded = () => {
                const d = req.result;
                if (!d.objectStoreNames.contains('docs')) d.createObjectStore('docs', { keyPath: 'key' });
                if (!d.objectStoreNames.contains('outbox')) d.createObjectStore('outbox', { keyPath: 'key' });
                if (!d.objectStoreNames.contains('state')) d.createObjectStore('state', { keyPath: 'scope' });
                if (!d.objectStoreNames.contains('drafts')) d.createObjectStore('drafts', { keyPath: 'scope' });
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        await new Promise((resolve) => {
            const tx = db.transaction('docs', 'readwrite');
            const store = tx.objectStore('docs');
            docs.forEach((doc) => store.put({
                ...doc, scope, key: `${scope}\u0000${doc.id}`, dirty: false, pending: false, sizeBytes: doc.body.length
            }));
            tx.oncomplete = resolve;
        });
        // 清掉先前的快取，確保真的打到 mock provider
        await new Promise((resolve) => {
            const req = indexedDB.deleteDatabase('bdc-cache');
            req.onsuccess = req.onerror = req.onblocked = () => resolve();
        });
        db.close();
        return docs.length;
    }, { endpoint: ENDPOINT, docs });
}

function mockReply(promptText) {
    // 按句模式：數出提示詞裡的編號句數，回等量譯句
    const count = (promptText.match(/^\s*\d+\.\s+/gm) || []).length;
    const n = Math.max(1, count);
    return {
        sentences: Array.from({ length: n }, (_, i) => `譯句${i + 1}`),
        translation: '譯句1',
        chunks: [],
        key_points: [],
        phrase_alignment: []
    };
}

(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: CHROME });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(({ endpoint, profile }) => {
        window.__BDC_SYNC_ENDPOINT__ = endpoint;
        try {
            localStorage.setItem('bdc_ai_profile_v1:device:guest', JSON.stringify(profile));
            const raw = localStorage.getItem('pen_global_settings');
            const parsed = raw ? JSON.parse(raw) : {};
            parsed.language = { ...(parsed.language || {}), interfaceLocale: 'zh-CN' };
            localStorage.setItem('pen_global_settings', JSON.stringify(parsed));
        } catch (_) {}
    }, { endpoint: ENDPOINT, profile: PROFILE });

    const page = await context.newPage();
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 240)); });
    page.on('pageerror', (e) => errors.push('PAGEERROR ' + String(e && e.stack ? e.stack.split('\n')[0] : e)));
    let aiCalls = 0;

    await page.route(PROVIDER + '/**', async (route) => {
        const request = route.request();
        if (request.method() === 'OPTIONS') {
            return route.fulfill({
                status: 204,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Headers': '*',
                    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                    'Access-Control-Max-Age': '600'
                }
            });
        }
        if (request.url().includes('/models')) {
            return route.fulfill({
                status: 200,
                headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
                body: JSON.stringify({ data: [{ id: 'mock-model' }] })
            });
        }
        aiCalls += 1;
        let prompt = '';
        try { prompt = String(JSON.parse(request.postData() || '{}').messages?.[0]?.content || ''); } catch (_) {}
        await new Promise((resolve) => setTimeout(resolve, 1400));
        return route.fulfill({
            status: 200,
            headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
            body: JSON.stringify({
                choices: [{ message: { content: JSON.stringify(mockReply(prompt)) } }],
                usage: { total_tokens: 10 }
            })
        });
    });

    await page.goto(BASE + '#a', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    await seedDocs(page, [
        {
            id: 'art_one',
            title: 'First Article',
            body: 'First article sentence.',
            analysis: null,
            sourceType: 'paste',
            revision: 0,
            createdAt: '2026-10-01T00:00:00.000Z',
            updatedAt: '2026-10-01T00:00:00.000Z',
            lastOpenedAt: '2026-10-18T08:00:00.000Z'
        },
        {
            id: 'art_two',
            title: 'Second Article',
            body: 'Second article sentence.',
            analysis: null,
            sourceType: 'paste',
            revision: 0,
            createdAt: '2026-10-02T00:00:00.000Z',
            updatedAt: '2026-10-02T00:00:00.000Z',
            lastOpenedAt: '2026-10-18T07:00:00.000Z'
        }
    ]);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1800);

    // --- 情境 1：A 分析中切到 B，A 的回應不得寫進 B ---
    console.log('\n[情境 1] 分析中切換文章');
    await page.click('#article-history-btn');
    await page.waitForTimeout(300);
    await page.click('.ar-history-item[data-key="art_one"] .ar-history-open');
    await page.waitForTimeout(400);
    await page.click('#analyze-article-btn');
    await page.waitForTimeout(900); // 第一段請求已在路上（延遲 1400ms）
    const inflight = aiCalls;
    check('分析已送出 AI 請求', inflight > 0, String(inflight));

    // 切到 B
    await page.click('#article-history-btn');
    await page.waitForTimeout(250);
    await page.click('.ar-history-item[data-key="art_two"] .ar-history-open');
    await page.waitForTimeout(300);
    const bBefore = await page.evaluate(() => ({
        input: document.getElementById('article-input').value,
        english: Array.from(document.querySelectorAll('#article-analysis-container .paragraph-english')).map((n) => n.textContent.trim())
    }));
    await page.waitForTimeout(2600); // A 的回應到達
    const bAfter = await page.evaluate(() => ({
        input: document.getElementById('article-input').value,
        english: Array.from(document.querySelectorAll('#article-analysis-container .paragraph-english')).map((n) => n.textContent.trim())
    }));
    check('B 的輸入框未被 A 覆蓋', bAfter.input === bBefore.input, JSON.stringify({ bBefore, bAfter }));
    check('B 的畫面沒有出現 A 的段落', !bAfter.english.some((line) => /First article sentence/.test(line)), JSON.stringify(bAfter.english));
    const buttonState = await page.evaluate(() => ({
        disabled: document.getElementById('analyze-article-btn').disabled,
        label: document.getElementById('analyze-article-btn').textContent.trim()
    }));
    check('切換後分析按鈕已還原（不會卡在停用）', buttonState.disabled === false && !/分析中/.test(buttonState.label), JSON.stringify(buttonState));

    // 切回 A：A 維持原本內容（舊請求被取消，不得把結果寫進別篇或復活）
    await page.click('#article-history-btn');
    await page.waitForTimeout(250);
    await page.click('.ar-history-item[data-key="art_one"] .ar-history-open');
    await page.waitForTimeout(600);
    const aView = await page.evaluate(() => ({
        input: document.getElementById('article-input').value,
        paragraphs: document.querySelectorAll('#article-analysis-container .paragraph-pair').length,
        chinese: Array.from(document.querySelectorAll('#article-analysis-container .paragraph-chinese')).map((n) => n.textContent.trim()).join(' '),
        status: document.getElementById('article-history-status')?.textContent?.trim()
    }));
    check('切回 A：內容仍是 A 自己的原文', aView.input === 'First article sentence.', aView.input);
    check('切回 A：沒有把 B 的結果寫進來', !/Second article/.test(aView.chinese), aView.chinese.slice(0, 60));

    // 重新分析 A（此時沒有切換）：結果必須正常存回 A
    await page.click('#analyze-article-btn');
    await page.waitForTimeout(4200);
    const aDone = await page.evaluate(() => ({
        paragraphs: document.querySelectorAll('#article-analysis-container .paragraph-pair').length,
        chinese: Array.from(document.querySelectorAll('#article-analysis-container .paragraph-chinese')).map((n) => n.textContent.trim()).join(' '),
        status: document.getElementById('article-history-status')?.textContent?.trim()
    }));
    check('重新分析後 A 的結果正常顯示', aDone.paragraphs >= 1 && /譯句/.test(aDone.chinese), JSON.stringify(aDone));
    check('A 的狀態列顯示已存入', /已存入/.test(aDone.status || ''), aDone.status);

    // --- 情境 1b：句子詳解在切換後才回來，只能寫回原文章 ---
    console.log('\n[情境 1b] 句子詳解延遲回來');
    await page.evaluate(() => {
        document.querySelector('#article-analysis-container .sent-analyze-btn')?.click();
    });
    await page.waitForTimeout(250); // 請求在路上（延遲 1400ms）
    // 使用者關掉句卡彈窗（請求不會被取消），再切換文章
    await page.evaluate(() => document.querySelector('#app-modal .modal-close-btn')?.click());
    await page.waitForTimeout(150);
    await page.click('#article-history-btn');
    await page.waitForTimeout(250);
    await page.click('.ar-history-item[data-key="art_two"] .ar-history-open');
    await page.waitForTimeout(2400);
    const afterSentence = await page.evaluate(async () => {
        const mod = await import('/modules/article-store.js');
        return {
            input: document.getElementById('article-input').value,
            cards: document.querySelectorAll('.sentence-card').length,
            modalOpen: !document.getElementById('app-modal').classList.contains('hidden'),
            oneSentences: (mod.getRecord('art_one')?.result?.sentence_analysis || []).length,
            twoSentences: (mod.getRecord('art_two')?.result?.sentence_analysis || []).length
        };
    });
    check('切換後句子詳解不寫進 B', afterSentence.twoSentences === 0 && afterSentence.input === 'Second article sentence.', JSON.stringify(afterSentence));
    check('句子詳解寫回原文章 A', afterSentence.oneSentences >= 1, JSON.stringify(afterSentence));
    check('切換後不會殘留句卡彈窗', afterSentence.cards === 0 && afterSentence.modalOpen === false, JSON.stringify(afterSentence));

    // --- 情境 2：分析中刪除文章，回應不得復活它 ---
    console.log('\n[情境 2] 分析中刪除文章');
    await page.evaluate(() => {
        // 用新的內文讓快取不會命中
        const el = document.getElementById('article-input');
        el.value = 'Third article sentence for deletion.';
        el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.click('#analyze-article-btn');
    await page.waitForTimeout(900);
    const beforeDelete = await page.evaluate(() => document.querySelectorAll('.ar-history-item').length);
    await page.click('#article-history-btn');
    await page.waitForTimeout(250);
    // 剛分析的那篇會是最新的記錄（沒有標題 → 用內文開頭）
    const deleted = await page.evaluate(async () => {
        const rows = Array.from(document.querySelectorAll('.ar-history-item'));
        const target = rows.find((row) => /Third article sentence/.test(row.textContent));
        if (!target) return false;
        const key = target.getAttribute('data-key');
        target.querySelector('.ar-history-more').click();
        await new Promise((r) => setTimeout(r, 120));
        const btn = target.querySelector('.ar-history-menu button[data-act="delete"]');
        if (!btn) return false;
        btn.click();
        return key;
    });
    check('可刪除剛開始分析的文章', !!deleted, String(deleted));
    await page.waitForTimeout(300);
    // 目前文章有未儲存內容時會跳出確認框
    const confirmVisible = await page.evaluate(() => !!document.querySelector('.options-modal-overlay #confirm-btn'));
    if (confirmVisible) await page.click('.options-modal-overlay #confirm-btn');
    await page.waitForTimeout(2600); // 回應到達
    const afterDelete = await page.evaluate(() => ({
        keys: Array.from(document.querySelectorAll('.ar-history-item')).map((row) => row.getAttribute('data-key')),
        hasDeletedRow: !!document.querySelector(`.ar-history-item[data-key="${window.__deletedKey || ''}"]`),
        analysis: document.getElementById('article-analysis-container').textContent.trim().slice(0, 60)
    }));
    check('刪除的文章沒有被回應復活', !afterDelete.keys.includes(deleted), JSON.stringify({ deleted, before: beforeDelete, keys: afterDelete.keys }));
    check('已刪除文章不會重新出現在清單', !afterDelete.hasDeletedRow);
    check('畫面沒有被已刪除文章的結果覆寫', !/Third article sentence/.test(afterDelete.analysis), afterDelete.analysis);

    check('無 console 錯誤', errors.length === 0, JSON.stringify(errors.slice(0, 6)));

    await browser.close();
    console.log(`\n=== 結果：${failures.length ? failures.length + ' 項失敗' : '全部通過'} ===`);
    if (failures.length) {
        for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
        process.exit(1);
    }
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
