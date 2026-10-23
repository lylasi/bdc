/**
 * 文章詳解 P3-T4：語言感知分詞與語義節點保護（瀏覽器驗收）。
 *
 * 覆蓋：
 *   - café／naïve／COVID-19／B2B 可作為單一詞查詢：data-word、請求 word 都正確
 *   - 連字號詞（co-operate）不被拆成兩個 token
 *   - 點連結文字：開連結，不開查詞 tooltip
 *   - 點 code 內文字：不開 tooltip
 *   - 既有錨點／標記定位不回歸：句子原文、word offset、加入詞書後的標記都對得上
 *
 * 用法：
 *   PORT=8313 PLAYWRIGHT_MODULE=<path-to-playwright> node tests/article-tokenize-ui.cjs
 *
 * 全程使用 route mock，不連真實 AI／同步端點或 TTS。
 */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const mock = require('./helpers/article-mock.cjs');

const PORT = Number(process.env.PORT || 8313);
const BASE = `http://127.0.0.1:${PORT}/`;

const { check, finish } = mock.createReporter('文章語言感知分詞（P3-T4）');

const SENTENCE_1 = 'Café owners in Zürich call the naïve plan simple.';
const SENTENCE_2 = 'They co-operate on COVID-19 notices for the B2B desk.';
const SENTENCE_3 = 'Read the `sample code` and [the guide](https://example.com/guide) before 3D printing.';
const BODY = [SENTENCE_1, SENTENCE_2, SENTENCE_3].join('\n\n');

const ANALYSIS = {
    chinese_translation: '苏黎世的咖啡馆老板说这个天真的计划很简单。他们在 B2B 服务台协作处理 COVID-19 通知。打印 3D 之前先读示例代码和指南。',
    word_alignment: [],
    detailed_analysis: [],
    paragraph_analysis: [
        { chinese_translation: '苏黎世的咖啡馆老板说这个天真的计划很简单。', word_alignment: [], detailed_analysis: [] },
        { chinese_translation: '他们在 B2B 服务台协作处理 COVID-19 通知。', word_alignment: [], detailed_analysis: [] },
        { chinese_translation: '打印 3D 之前先读示例代码和指南。', word_alignment: [], detailed_analysis: [] }
    ],
    sentence_analysis: [],
    phrase_analysis: []
};

function recordDoc() {
    return {
        id: 'art_tokenize_ui',
        title: 'Tokenize article',
        body: BODY,
        analysis: ANALYSIS,
        sourceType: 'paste',
        revision: 0,
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
        lastOpenedAt: '2026-10-22T08:00:00.000Z'
    };
}

async function dismissStartupModal(page) {
    await page.evaluate(() => {
        const modal = document.getElementById('app-modal');
        if (modal && !modal.classList.contains('hidden')) modal.querySelector('.modal-close-btn')?.click();
    });
    await page.waitForTimeout(150);
}

async function openArticle(page, id = 'art_tokenize_ui') {
    await mock.seedDocs(page, [recordDoc()]);
    for (let attempt = 0; attempt < 6; attempt += 1) {
        const count = await page.evaluate(async (articleId) => {
            const store = await import('/modules/article-store.js');
            const list = await store.reloadScope();
            return list.filter((item) => item.articleId === articleId).length;
        }, id);
        if (count > 0) break;
        await page.waitForTimeout(300);
    }
    await page.evaluate(() => document.getElementById('article-history-btn').click());
    await page.waitForSelector(`.ar-history-item[data-key="${id}"] .ar-history-open`, { timeout: 15000 });
    await page.evaluate((articleId) => {
        document.querySelector(`.ar-history-item[data-key="${articleId}"] .ar-history-open`)?.click();
    }, id);
    await page.waitForSelector('.paragraph-pair[data-paragraph-index="0"]', { timeout: 15000 });
    await page.waitForTimeout(400);
}

const waitTooltip = (page) => page.waitForFunction(() => {
    const el = document.getElementById('word-analysis-tooltip');
    return el && el.style.display === 'block';
}, null, { timeout: 15000 });

const tooltipVisible = (page) => page.evaluate(() => {
    const el = document.getElementById('word-analysis-tooltip');
    return !!el && el.style.display === 'block';
});

async function closeTooltip(page) {
    const visible = await tooltipVisible(page);
    if (!visible) return;
    await page.evaluate(() => document.querySelector('#word-analysis-tooltip .tooltip-close')?.click());
    await page.waitForFunction(() => {
        const el = document.getElementById('word-analysis-tooltip');
        return !el || el.style.display === 'none';
    }, null, { timeout: 5000 });
}

async function clickWord(page, word) {
    await page.evaluate((value) => {
        const el = Array.from(document.querySelectorAll('#article-analysis-container .paragraph-english .interactive-word'))
            .find((node) => node.getAttribute('data-word') === value);
        if (!el) throw new Error('word not found: ' + value);
        el.click();
    }, word);
}

const wordsInParagraph = (page, index) => page.evaluate((paraIndex) => (
    Array.from(document.querySelectorAll(`.paragraph-pair[data-paragraph-index="${paraIndex}"] .paragraph-english .interactive-word`))
        .map((node) => node.getAttribute('data-word'))
), index);

const tooltipWordInfo = (page) => page.evaluate(() => {
    const tooltip = document.getElementById('word-analysis-tooltip');
    const mark = tooltip?.querySelector('.btn-toggle-mark');
    const play = tooltip?.querySelector('.btn-play-word');
    return {
        display: tooltip ? tooltip.style.display : 'missing',
        title: tooltip ? (tooltip.querySelector('.tooltip-title')?.textContent || '').replace(/\s+/g, ' ').trim() : '',
        quote: mark ? mark.getAttribute('data-quote') : null,
        word: mark ? mark.getAttribute('data-word') : null,
        playWord: play ? play.getAttribute('data-word') : null,
        anchorStart: mark ? Number(mark.getAttribute('data-anchor-start')) : null,
        anchorEnd: mark ? Number(mark.getAttribute('data-anchor-end')) : null
    };
});

function wordOffsetInSentence(page, word, paragraphIndex = 0) {
    return page.evaluate(({ value, paraIndex }) => {
        const sentence = document.querySelector(`.paragraph-pair[data-paragraph-index="${paraIndex}"] .paragraph-english .interactive-sentence`);
        const token = Array.from(sentence.querySelectorAll('.interactive-word'))
            .find((node) => node.getAttribute('data-word') === value);
        if (!sentence || !token) return null;
        const range = document.createRange();
        range.selectNodeContents(sentence);
        range.setEnd(token.firstChild, 0);
        return { offset: range.toString().length, sentenceText: sentence.textContent };
    }, { value: word, paraIndex: paragraphIndex });
}

async function assertFullWord(page, word, expectedRequest) {
    const requestsBefore = await page.evaluate(() => window.__tokenizeWordRequests.length);
    await clickWord(page, word);
    await waitTooltip(page);
    await page.waitForFunction(() => {
        const el = document.getElementById('word-analysis-tooltip');
        return el && !!el.querySelector('.btn-toggle-mark');
    }, null, { timeout: 15000 });
    const info = await tooltipWordInfo(page);
    const requests = await page.evaluate(() => window.__tokenizeWordRequests.slice());
    check(`${word}：tooltip 的 data-word 保留原文`, info.quote === word && info.word === word, JSON.stringify({ quote: info.quote, word: info.word }));
    check(`${word}：播放按鈕沿用同一個詞`, info.playWord === word, String(info.playWord));
    check(`${word}：查詞請求的 word 參數正確`, requests.length === requestsBefore + 1 && requests[requests.length - 1] === expectedRequest,
        JSON.stringify({ requests, expectedRequest }));
    check(`${word}：tooltip 標題顯示原詞`, info.title.includes(word), info.title);
    await closeTooltip(page);
    return info;
}

(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: mock.CHROME });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await mock.initScript(context);
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error && error.message ? error.message : error)));

    // 外部連結只在本機 route 回應，不真的連網。
    await context.route('https://example.com/**', (route) => route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><title>guide</title><h1>guide</h1>'
    }));

    await page.addInitScript(() => {
        window.__tokenizeWordRequests = [];
    });

    await mock.installProviderRoutes(page, async ({ route, prompt }) => {
        const match = prompt.match(/Target word:\s*"([^"]+)"/);
        if (match) {
            await page.evaluate((word) => { window.__tokenizeWordRequests.push(word); }, match[1]);
            return mock.jsonReply(route, {
                word: match[1],
                sentence: '',
                analysis: { phonetic: '', pos: 'noun', meaning: '測試意思', role: '' }
            });
        }
        return mock.jsonReply(route, mock.translatedParagraphReply(prompt));
    });

    await page.goto(BASE + '#a', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    await dismissStartupModal(page);
    await openArticle(page);

    console.log('\n[分詞結果]');
    const p1 = await wordsInParagraph(page, 0);
    const p2 = await wordsInParagraph(page, 1);
    check('café 是單一詞 token', p1.includes('Café'), JSON.stringify(p1));
    check('naïve 是單一詞 token', p1.includes('naïve'), JSON.stringify(p1));
    check('COVID-19 是單一詞 token', p2.includes('COVID-19'), JSON.stringify(p2));
    check('B2B 是單一詞 token', p2.includes('B2B'), JSON.stringify(p2));
    check('co-operate 不被拆開', p2.includes('co-operate'), JSON.stringify(p2));
    check('帶重音詞沒有被拆成 ASCII 片段', !p1.includes('caf') && !p1.includes('Z') && !p1.includes('rich') && !p1.includes('na') && !p1.includes('ve'), JSON.stringify(p1));
    check('COVID-19 沒有留下單獨的 19', !p2.includes('19'), JSON.stringify(p2));

    const p3 = await wordsInParagraph(page, 2);
    check('連結內的文字不生成查詞 token', await page.locator('.paragraph-pair[data-paragraph-index="2"] .paragraph-english a .interactive-word').count() === 0, JSON.stringify(p3));
    check('code 內的文字不生成查詞 token', await page.locator('.paragraph-pair[data-paragraph-index="2"] .paragraph-english code .interactive-word').count() === 0, JSON.stringify(p3));
    check('3D 仍可查詞', p3.includes('3D'), JSON.stringify(p3));

    console.log('\n[原文與錨點不受分詞影響]');
    const textState = await page.evaluate(() => {
        const pairs = Array.from(document.querySelectorAll('.paragraph-pair'));
        return pairs.map((pair) => ({
            english: pair.getAttribute('data-english'),
            sentences: Array.from(pair.querySelectorAll('.paragraph-english .interactive-sentence')).map((node) => ({
                data: node.getAttribute('data-sentence'),
                text: node.textContent
            }))
        }));
    });
    check('data-english 保留原文', textState[0].english === SENTENCE_1 && textState[1].english === SENTENCE_2 && textState[2].english === SENTENCE_3,
        JSON.stringify(textState.map((item) => item.english)));
    check('第一段句子文字與原文一致', textState[0].sentences[0]?.text === SENTENCE_1, JSON.stringify(textState[0].sentences));
    check('第三段句子 data-sentence 保留 Markdown 原文', textState[2].sentences[0]?.data === SENTENCE_3, JSON.stringify(textState[2].sentences));
    const cafeOffset = await wordOffsetInSentence(page, 'Café', 0);
    const naiveOffset = await wordOffsetInSentence(page, 'naïve', 0);
    check('Café 在句中的 offset 正確', cafeOffset && cafeOffset.offset === 0, JSON.stringify(cafeOffset));
    check('naïve 在句中的 offset 正確', naiveOffset && naiveOffset.offset === SENTENCE_1.indexOf('naïve'), JSON.stringify(naiveOffset));
    check('句末解析鍵仍綁在最後一個詞', await page.locator('.paragraph-pair[data-paragraph-index="0"] .sentence-tail .interactive-word[data-word="simple"]').count() === 1);

    console.log('\n[單一詞查詢]');
    const cafeInfo = await assertFullWord(page, 'Café', 'Café');
    check('Café 的錨點對回原文', cafeInfo.anchorStart === 0 && cafeInfo.anchorEnd === 4 && BODY.slice(cafeInfo.anchorStart, cafeInfo.anchorEnd) === 'Café',
        JSON.stringify(cafeInfo));
    await assertFullWord(page, 'naïve', 'naïve');
    await assertFullWord(page, 'COVID-19', 'COVID-19');
    await assertFullWord(page, 'B2B', 'B2B');

    console.log('\n[語義節點：連結與 code]');
    const requestsBeforeSemantic = await page.evaluate(() => window.__tokenizeWordRequests.length);
    await page.evaluate(() => document.querySelector('.paragraph-pair[data-paragraph-index="2"] .paragraph-english code').click());
    await page.waitForTimeout(400);
    check('點 code 內文字不開查詞 tooltip', !(await tooltipVisible(page)));
    check('點 code 內文字不發查詞請求', await page.evaluate(() => window.__tokenizeWordRequests.length) === requestsBeforeSemantic);
    check('點 code 內文字不開句卡', await page.locator('.sentence-card').count() === 0);

    const popupPromise = page.waitForEvent('popup', { timeout: 8000 }).catch(() => null);
    await page.evaluate(() => document.querySelector('.paragraph-pair[data-paragraph-index="2"] .paragraph-english a').click());
    const popup = await popupPromise;
    if (popup) {
        await popup.waitForLoadState('domcontentloaded').catch(() => {});
        await popup.waitForTimeout(200);
    }
    check('點連結文字會開連結', !!popup && /example\.com/.test(popup.url()), popup ? popup.url() : 'no popup');
    if (popup) await popup.close();
    await page.waitForTimeout(400);
    check('點連結文字不開查詞 tooltip', !(await tooltipVisible(page)));
    check('點連結文字不發查詞請求', await page.evaluate(() => window.__tokenizeWordRequests.length) === requestsBeforeSemantic);
    check('點連結文字不開句卡', await page.locator('.sentence-card').count() === 0);

    console.log('\n[標記與重載：錨點不回歸]');
    await clickWord(page, 'Café');
    await waitTooltip(page);
    await page.waitForSelector('#word-analysis-tooltip .btn-add-to-book', { timeout: 15000 });
    await page.waitForTimeout(200);
    const marked = await page.evaluate(async () => {
        const button = document.querySelector('#word-analysis-tooltip .btn-add-to-book');
        const articleId = button.getAttribute('data-article-id');
        button.click();
        const rd = await import('/modules/reading-store.js');
        for (let i = 0; i < 40; i += 1) {
            const items = rd.listLearningItems(articleId) || [];
            const hit = items.find((item) => String(item.anchor?.quote || '').toLowerCase() === 'café');
            if (hit && hit.marked === true) {
                return { quote: hit.anchor.quote, anchor: hit.anchor || null, marked: hit.marked };
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return null;
    });
    check('加入詞書後以 café 建立帶錨點的標記', !!marked && marked.anchor && marked.anchor.start === 0 && BODY.slice(marked.anchor.start, marked.anchor.end) === 'Café',
        JSON.stringify(marked));
    await closeTooltip(page);
    await page.waitForTimeout(300);
    check('正文出現標記線', await page.locator('.paragraph-english .interactive-word.reading-mark-active').count() >= 1,
        String(await page.locator('.reading-mark-active').count()));

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1300);
    await dismissStartupModal(page);
    await openArticle(page);
    const afterReload = await page.evaluate(() => {
        const marked = Array.from(document.querySelectorAll('.paragraph-english .interactive-word.reading-mark-active'))
            .map((node) => node.getAttribute('data-word'));
        return marked;
    });
    check('重載後標記仍落在 Café 這個 token', afterReload.includes('Café'), JSON.stringify(afterReload));
    const reloadedOffset = await wordOffsetInSentence(page, 'Café', 0);
    check('重載後 Café 的 offset 仍是 0', reloadedOffset && reloadedOffset.offset === 0, JSON.stringify(reloadedOffset));

    check('沒有頁面錯誤', pageErrors.length === 0, pageErrors.join(' | '));

    const failures = finish();
    await context.close();
    await browser.close();
    process.exit(failures ? 1 : 0);
})().catch(async (error) => {
    console.error('\n[例外]', error && error.stack ? error.stack : error);
    process.exit(1);
});
