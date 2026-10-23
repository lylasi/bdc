/**
 * 學習模式例句點詞驗收（P2-T5）。
 *
 * 覆蓋：
 *   - A 生成例句後立刻切到 B：A 的晚到結果保存在 A，不覆蓋 B 的畫面
 *   - 切回 A 時看到已保存的例句
 *   - 點例句中的詞展開中文 gloss 與發音；再點收起
 *   - 鍵盤 Enter 展開、Escape 收起
 *   - 沒有 alignment 的例句顯示 exampleNoGloss，且不發任何 AI 請求
 *   - zh-HK 使用香港書面語文案
 *
 * 用法：
 *   PORT=8313 PLAYWRIGHT_MODULE=<path-to-playwright> node tests/learning-examples.cjs
 *
 * 不連真實 AI／TTS；provider 由本機 route mock，TTS 一律中止並落回系統語音。
 */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const mock = require('./helpers/article-mock.cjs');

const PORT = Number(process.env.PORT || 8313);
const BASE = `http://127.0.0.1:${PORT}/`;

const ALPHA_EXAMPLES = [
    {
        english: 'The alpha team meets at noon.',
        chinese: '阿尔法团队中午开会。',
        alignment: [
            { en: 'alpha', zh: '阿尔法' },
            { en: 'noon', zh: '中午' }
        ]
    },
    {
        english: 'Alpha is the first letter.',
        chinese: '阿尔法是第一个字母。',
        alignment: [{ en: 'Alpha', zh: '阿尔法' }]
    }
];

const BETA_EXAMPLES = [
    {
        english: 'The beta test starts today.',
        chinese: '贝塔测试今天开始。',
        alignment: [{ en: 'beta', zh: '贝塔' }]
    }
];

const GAMMA_EXAMPLES = [
    {
        english: 'Gamma rays are invisible to the eye.',
        chinese: '伽马射线肉眼不可见。',
        alignment: []
    }
];

const { check, finish } = mock.createReporter('例句點詞與延遲結果');

(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: mock.CHROME });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await mock.initScript(context, { locale: 'zh-CN' });
    await context.addInitScript(({ gammaExamples }) => {
        const books = [{
            id: 'book-phase2',
            name: 'Phase 2',
            sourceType: 'legacy',
            createdAt: '2026-10-22T00:00:00.000Z',
            shareId: 'wb_phase2_test',
            words: [
                { id: 'a1', word: 'alpha', meaning: '阿尔法', phonetic: '' },
                { id: 'b1', word: 'beta', meaning: '贝塔', phonetic: '' },
                {
                    id: 'c1',
                    word: 'gamma',
                    meaning: '伽马',
                    phonetic: '',
                    examples: gammaExamples
                }
            ]
        }];
        localStorage.setItem('vocabularyBooks', JSON.stringify(books));
        localStorage.setItem('activeBookId', 'book-phase2');
        // 避免任何真實 TTS：指向不可達的本機位址，playback 失敗後使用系統語音。
        const raw = localStorage.getItem('pen_global_settings');
        const parsed = raw ? JSON.parse(raw) : {};
        parsed.tts = { ...(parsed.tts || {}), use: 'local', baseUrlLocal: 'http://127.0.0.1:9/tts' };
        localStorage.setItem('pen_global_settings', JSON.stringify(parsed));
    }, { gammaExamples: GAMMA_EXAMPLES });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error && error.message ? error.message : error)));
    // 所有 /tts? 請求一律中止；不讓測試碰到真實或設定的 TTS 端點。
    await page.route(/\/tts\?/, (route) => route.abort());

    let totalCalls = 0;
    let alphaCalls = 0;
    await mock.installProviderRoutes(page, async ({ route, prompt }) => {
        totalCalls += 1;
        if (/alpha/i.test(prompt)) {
            alphaCalls += 1;
            await new Promise((resolve) => setTimeout(resolve, 900));
            return mock.jsonReply(route, ALPHA_EXAMPLES);
        }
        if (/beta/i.test(prompt)) return mock.jsonReply(route, BETA_EXAMPLES);
        if (/gamma/i.test(prompt)) return mock.jsonReply(route, GAMMA_EXAMPLES);
        return mock.jsonReply(route, []);
    });

    const tInPage = (key, params) => page.evaluate(async ({ key: k, params: p }) => {
        const mod = await import('/modules/i18n.js');
        return mod.t(k, p);
    }, { key, params });

    await page.goto(BASE + '?module=learning', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#word-select option[value="a1"]', { state: 'attached', timeout: 15000 });

    // ── 情境 1：A 生成後立刻切 B，A 晚到不得覆蓋 ─────────────────────
    console.log('\n[情境 1] 延遲結果歸屬');
    await page.selectOption('#word-select', 'a1');
    await page.click('#generate-examples-btn');
    await page.selectOption('#word-select', 'b1');
    await page.waitForTimeout(1600);
    const noExamplesLabel = await tInPage('learning.noExamples');
    const bView = await page.evaluate(() => document.getElementById('examples-container').textContent || '');
    check('A 晚到不覆蓋目前 B 的例句區', bView.includes(noExamplesLabel) && !bView.includes('alpha team'), bView.slice(0, 160));
    const savedA = await page.evaluate(() => {
        const books = JSON.parse(localStorage.getItem('vocabularyBooks') || '[]');
        const word = books.find((book) => book.id === 'book-phase2')?.words?.find((item) => item.id === 'a1');
        return (word?.examples || []).map((example) => example.english).join(' | ');
    });
    check('A 的結果仍保存在原詞', savedA.includes('alpha team') && alphaCalls === 1, `${savedA} / alphaCalls=${alphaCalls}`);
    await page.selectOption('#word-select', 'a1');
    await page.waitForTimeout(250);
    const aView = await page.evaluate(() => document.getElementById('examples-container').textContent || '');
    check('切回 A 可見已保存的例句', aView.includes('alpha team'), aView.slice(0, 160));

    // ── 情境 2：點詞展開中文與發音，再點收起 ─────────────────────────
    console.log('\n[情境 2] 例句點詞');
    const alphaWord = page.locator('.example-item').first().locator('.example-english .interactive-word').filter({ hasText: 'alpha' }).first();
    await alphaWord.click();
    const glossAfterClick = await page.evaluate(() => {
        const gloss = document.querySelector('.example-item .example-word-gloss');
        const word = document.querySelector('.example-item .example-english .interactive-word[aria-expanded="true"]');
        return {
            text: gloss?.textContent?.trim() || '',
            hasPlay: !!gloss?.querySelector('.example-word-gloss-play'),
            expanded: word?.getAttribute('aria-expanded') || ''
        };
    });
    const expectedGloss = await tInPage('learning.exampleGloss', { meaning: '阿尔法' });
    check('點詞顯示句中意思', glossAfterClick.text.includes(expectedGloss), JSON.stringify(glossAfterClick));
    check('gloss 內有發音鈕且 aria-expanded=true', glossAfterClick.hasPlay && glossAfterClick.expanded === 'true', JSON.stringify(glossAfterClick));
    await alphaWord.click();
    const glossCountAfterToggle = await page.locator('.example-item .example-word-gloss').count();
    const expandedAfterToggle = await alphaWord.getAttribute('aria-expanded');
    check('再點同一个詞可收起', glossCountAfterToggle === 0 && expandedAfterToggle === 'false', `${glossCountAfterToggle} / ${expandedAfterToggle}`);

    // 同一例句只展開一個 gloss：先開 alpha，再開 noon。
    await alphaWord.click();
    const noonWord = page.locator('.example-item').first().locator('.example-english .interactive-word').filter({ hasText: 'noon' }).first();
    await noonWord.click();
    const glossesInExample = await page.locator('.example-item').first().locator('.example-word-gloss').count();
    check('同一例句只保留一個 gloss', glossesInExample === 1, String(glossesInExample));

    // 發音 owner
    await alphaWord.click();
    await page.click('.example-item .example-word-gloss-play');
    const owner = await page.evaluate(async () => {
        const audio = await import('/modules/audio.js');
        return audio.getActiveAudioOwner();
    });
    check('例句發音使用 learning-example owner', owner === 'learning-example', String(owner));

    // 鍵盤 Enter / Escape
    await alphaWord.click(); // 收起上一步的 gloss，確保從未展開狀態開始
    await page.evaluate(() => {
        const word = Array.from(document.querySelectorAll('.example-item .example-english .interactive-word'))
            .find((el) => /alpha/i.test(el.textContent || ''));
        word?.focus();
    });
    await page.keyboard.press('Enter');
    const keyboardOpen = await page.locator('.example-item .example-word-gloss').count();
    await page.keyboard.press('Escape');
    const keyboardClosed = await page.locator('.example-item .example-word-gloss').count();
    check('鍵盤 Enter 展開、Escape 收起', keyboardOpen === 1 && keyboardClosed === 0, `${keyboardOpen} / ${keyboardClosed}`);

    // ── 情境 3：沒有 alignment 不發請求，只顯示提示 ──────────────────
    console.log('\n[情境 3] 無 alignment');
    await page.selectOption('#word-select', 'c1');
    await page.waitForTimeout(250);
    const callsBeforeGamma = totalCalls;
    const gammaWord = page.locator('.example-item').first().locator('.example-english .interactive-word').first();
    await gammaWord.click();
    await page.waitForTimeout(300);
    const gammaGloss = await page.evaluate(() => document.querySelector('.example-item .example-word-gloss')?.textContent?.trim() || '');
    const noGlossLabel = await tInPage('learning.exampleNoGloss');
    check('無 alignment 顯示 exampleNoGloss', gammaGloss.includes(noGlossLabel), JSON.stringify(gammaGloss));
    check('無 alignment 不發 AI 請求', totalCalls === callsBeforeGamma, `${totalCalls} / ${callsBeforeGamma}`);

    // ── 情境 4：zh-HK 文案 ────────────────────────────────────────────
    console.log('\n[情境 4] zh-HK');
    await page.evaluate(async () => {
        const i18n = await import('/modules/i18n.js');
        i18n.setLocale('zh-HK');
    });
    await page.waitForTimeout(300);
    await page.selectOption('#word-select', 'a1');
    await page.waitForTimeout(250);
    const alphaWordHk = page.locator('.example-item').first().locator('.example-english .interactive-word').filter({ hasText: 'alpha' }).first();
    await alphaWordHk.click();
    const hkGloss = await page.evaluate(() => document.querySelector('.example-item .example-word-gloss')?.textContent?.trim() || '');
    const expectedHkGloss = await tInPage('learning.exampleGloss', { meaning: '阿尔法' });
    check('zh-HK gloss 使用香港文案且保留原文詞義', hkGloss.includes(expectedHkGloss) && hkGloss.includes('阿尔法'), JSON.stringify({ hkGloss, expectedHkGloss }));

    check('沒有未預期的頁面錯誤', pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 3)));

    await browser.close();
    const failures = finish();
    if (failures) process.exit(1);
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
