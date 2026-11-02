/**
 * 文章短語「先查詞、再加入詞書」：選取工具條入口、單詞詳解同款彈窗、釋義回填與雙語文案。
 *
 * 用法：
 *   PORT=8313 PLAYWRIGHT_MODULE=<path-to-playwright> node tests/reading-phrase-lookup.cjs
 *   BASE_URL=http://10.10.10.149:8001 PLAYWRIGHT_MODULE=<path-to-playwright> node tests/reading-phrase-lookup.cjs
 *
 * 全部使用獨立 context 的合成文章；不讀取使用者既有資料或正式帳號。
 * 這裡刻意不連 AI：
 *   1. 已存解釋的 short-circuit 路徑（命中條目時不請求模型）；
 *   2. 沒有可用模型時的錯誤路徑（必須在彈窗內說明原因、提供重試）。
 */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const PORT = Number(process.env.PORT || 8313);
const BASE = process.env.BASE_URL
    ? `${String(process.env.BASE_URL).replace(/\/+$/, '')}/`
    : `http://127.0.0.1:${PORT}/`;
const ENDPOINT = process.env.TEST_SYNC_ENDPOINT || 'http://127.0.0.1:19999/test-endpoint';

const BODY = 'We look forward to meeting you.';
const SENTENCE = 'We look forward to meeting you.';
const PHRASE = 'look forward to';
// 'look forward to' 在 'We look forward to meeting you.' 的位置：3..18
const PHRASE_START = 3;
const PHRASE_END = 18;

const LABELS = {
    'zh-CN': { lookup: '查词', notConfigured: '尚未配置可用的 AI 供应商与模型' },
    'zh-HK': { lookup: '查詞', notConfigured: '尚未配置可用的 AI 供應商與模型' }
};

const failures = [];
function check(name, condition, detail) {
    if (condition) { console.log(`  ok   ${name}`); return true; }
    failures.push({ name, detail: detail === undefined ? '' : String(detail).slice(0, 600) });
    console.log(`  FAIL ${name}${detail !== undefined ? ' -- ' + String(detail).slice(0, 400) : ''}`);
    return false;
}

async function newPage(browser, locale) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    await context.addInitScript(({ endpoint, locale }) => {
        window.__BDC_SYNC_ENDPOINT__ = endpoint;
        try {
            const raw = localStorage.getItem('pen_global_settings');
            const parsed = raw ? JSON.parse(raw) : {};
            parsed.language = { ...(parsed.language || {}), interfaceLocale: locale };
            localStorage.setItem('pen_global_settings', JSON.stringify(parsed));
        } catch (_) {}
    }, { endpoint: ENDPOINT, locale });
    await context.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith('/ai-config.js')) {
            return route.fulfill({
                contentType: 'application/javascript',
                body: 'export const SYNC={endpoint:""}; export const TTS_CONFIG={}, AI_LIMITS={}, OCR_CONFIG={}, ARTICLE_IMPORT={}, SUPABASE={};'
            });
        }
        return url.origin === BASE.slice(0, -1) ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push('PAGEERROR ' + String(e && e.message)));
    page.on('console', (m) => {
        if (m.type() !== 'error') return;
        const text = m.text();
        if (/ERR_CONNECTION_REFUSED|ERR_UNSAFE_PORT|ERR_FAILED|Failed to load resource|501|404|Not Implemented|sync_endpoint_missing|尚未选择模型|尚未選擇模型/i.test(text)) return;
        errors.push(text.slice(0, 200));
    });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    await page.evaluate(() => {
        const modal = document.getElementById('app-modal');
        if (modal && !modal.classList.contains('hidden')) modal.querySelector('.modal-close-btn')?.click();
    });
    await page.waitForTimeout(150);
    return { context, page, errors };
}

/** 合成文章 + 一句已存解釋的短語；其餘短語沒有解釋，用來驗證 AI／設定缺失路徑。 */
async function seed(page) {
    return page.evaluate(async ({ body, sentence, phrase, start, end }) => {
        const art = await import('/modules/article-store.js');
        const rd = await import('/modules/reading-store.js');
        const { contentVersionOf } = await import('/shared/reading-protocol.mjs');
        await art.initArticleStore();
        await rd.initReadingStore();
        const saved = await art.saveArticle({
            articleId: 'art_phrase_lookup',
            article: body,
            title: 'Phrase Lookup',
            sourceType: 'paste',
            result: {
                chinese_translation: '我們期待與你見面。',
                word_alignment: [],
                detailed_analysis: [{ word: 'look', sentence, analysis: { phonetic: 'lʊk', pos: 'v.', meaning: '看；期待', role: '動詞' } }],
                paragraph_analysis: [{ chinese_translation: '我們期待與你見面。', sentences: [{ en: sentence, zh: '我們期待與你見面。' }] }],
                sentence_analysis: [],
                phrase_analysis: []
            }
        });
        if (!saved.ok) throw new Error('save article ' + saved.error);
        const version = contentVersionOf(body);
        await rd.upsertLearningItem({
            articleId: 'art_phrase_lookup',
            contentVersion: version,
            kind: 'phrase',
            anchor: { start, end, quote: phrase, prefix: 'We ', suffix: ' meeting' },
            sentence,
            explanation: {
                language: 'zh-CN',
                result: {
                    selection: phrase,
                    analysis: {
                        meaning: '期待；盼望',
                        usage: 'to 為介系詞，後接名詞或動名詞',
                        examples: [{ en: 'I look forward to the trip.', zh: '我很期待這次旅行。' }]
                    }
                },
                generatedAt: new Date().toISOString(),
                provenance: { source: 'synthetic' }
            },
            marked: false
        }, { markViewed: false });
        return version;
    }, { body: BODY, sentence: SENTENCE, phrase: PHRASE, start: PHRASE_START, end: PHRASE_END });
}

async function openArticle(page) {
    if (!(await page.locator('#article-btn').isVisible())) {
        await page.click('#nav-more-btn').catch(() => {});
        await page.waitForTimeout(150);
    }
    await page.click('#article-btn');
    await page.waitForTimeout(250);
    await page.evaluate(async () => {
        const st = await import('/modules/state.js');
        st.setCurrentArticleId('art_phrase_lookup');
        const art = await import('/features/article/article.js');
        await art.showCurrentArticleIfAvailable();
    });
    await page.waitForTimeout(900);
}

/** 在正文句子上選取一段字元（跨文字節點），觸發表尾的選取工具條。 */
async function selectSentenceRange(page, start, end) {
    await page.evaluate(async ({ start, end }) => {
        const sentenceEl = document.querySelector('.interactive-sentence[data-sentence]');
        const pointAt = (offset) => {
            const walker = document.createTreeWalker(sentenceEl, NodeFilter.SHOW_TEXT);
            let acc = 0;
            let node = walker.nextNode();
            while (node) {
                const len = node.textContent.length;
                if (offset <= acc + len) return { node, offset: offset - acc };
                acc += len;
                node = walker.nextNode();
            }
            return null;
        };
        const from = pointAt(start);
        const to = pointAt(end);
        if (!from || !to) throw new Error('sentence range not found');
        const range = document.createRange();
        range.setStart(from.node, from.offset);
        range.setEnd(to.node, to.offset);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
        await new Promise((r) => setTimeout(r, 260));
    }, { start, end });
}

async function runLocale(browser, locale) {
    const labels = LABELS[locale];
    console.log(`\n[${locale}]`);
    const { context, page, errors } = await newPage(browser, locale);
    await seed(page);
    await openArticle(page);

    // 短語面板不再負責查詞：回到「加入詞書／標記／寫筆記／問 AI／重新選」。
    await page.evaluate(async () => {
        const m = await import('/features/article/phrase-picker.js');
        m.openPhrasePicker({ articleId: 'art_phrase_lookup', sentence: 'We look forward to meeting you.', context: '', initialQuote: 'look forward to', sentenceStart: 0 });
    });
    await page.waitForTimeout(350);
    check(`[${locale}] 短語面板已無查詞按鈕`, await page.locator('#phrase-picker-lookup').count() === 0);
    await page.locator('.phrase-picker-close').click();
    await page.waitForTimeout(250);

    // 選取短語：工具條出現查詞
    await selectSentenceRange(page, PHRASE_START, PHRASE_END);
    const phraseBar = await page.evaluate(() => {
        const bar = document.querySelector('.article-selection-bar.is-visible');
        const button = bar && bar.querySelector('[data-act="lookup"]');
        return { visible: !!bar, lookup: !!(button && !button.classList.contains('hidden')), text: button && button.textContent.trim() };
    });
    check(`[${locale}] 選取短語時工具條顯示查詞`, phraseBar.visible && phraseBar.lookup && phraseBar.text === labels.lookup, JSON.stringify(phraseBar));

    // 點查詞：開的是單詞查詞那個彈窗，不是短語面板
    await page.locator('.article-selection-bar [data-act="lookup"]').click();
    await page.waitForTimeout(600);
    check(`[${locale}] 查詞開的是單詞詳解彈窗`,
        await page.locator('#word-analysis-tooltip').isVisible() && await page.locator('#phrase-picker:not(.hidden)').count() === 0);
    const tooltipText = (await page.locator('#word-analysis-tooltip').innerText()).replace(/\n/g, ' / ');
    check(`[${locale}] 彈窗顯示釋義、用法與例句`,
        tooltipText.includes(PHRASE) && tooltipText.includes('期待') && tooltipText.includes('動名詞') && tooltipText.includes('I look forward to the trip.'),
        tooltipText);
    check(`[${locale}] 彈窗有加入詞書與標記動作`,
        await page.locator('#word-analysis-tooltip .btn-add-to-book').count() === 1
        && await page.locator('#word-analysis-tooltip .btn-toggle-mark').count() === 1);

    // 先看釋義再加入詞書：詞書條目要帶上同一份釋義
    await page.locator('#word-analysis-tooltip .btn-add-to-book').click();
    await page.waitForTimeout(900);
    const saved = await page.evaluate(async (phrase) => {
        const rd = await import('/modules/reading-store.js');
        const entries = rd.listVocabularyEntries();
        return {
            entry: entries.find((e) => String(e.word || '').toLowerCase() === phrase) || null,
            links: rd.listVocabularyLinks().length
        };
    }, PHRASE);
    check(`[${locale}] 查詞後可加入詞書`, !!saved.entry && saved.links >= 1, JSON.stringify({ entry: saved.entry && saved.entry.word, links: saved.links }));
    check(`[${locale}] 詞書條目帶入 AI 釋義`, !!saved.entry && String(saved.entry.meaning).includes('期待'), saved.entry && saved.entry.meaning);

    // 標記：沿用同一個委派處理器；加入詞書可能已把它標成已標記，這裡驗證「切換」。
    const readMarked = () => page.evaluate(async (phrase) => {
        const rd = await import('/modules/reading-store.js');
        const item = rd.findPhraseItem('art_phrase_lookup', phrase, 'We look forward to meeting you.');
        return item ? item.marked === true : null;
    }, PHRASE);
    const markedBefore = await readMarked();
    await page.locator('#word-analysis-tooltip .btn-toggle-mark').click();
    await page.waitForTimeout(600);
    const markedAfter = await readMarked();
    check(`[${locale}] 彈窗內可切換標記`, markedBefore !== null && markedAfter === !markedBefore, `${markedBefore} → ${markedAfter}`);

    // 關閉：彈窗收起
    await page.locator('#word-analysis-tooltip .tooltip-close').click();
    await page.waitForTimeout(300);
    check(`[${locale}] 關閉鈕收起彈窗`, await page.locator('#word-analysis-tooltip').isHidden());

    // 沒有已存解釋的範圍：走 AI；此環境沒有模型，必須在彈窗內說明原因並可重試
    await selectSentenceRange(page, 0, 2);
    await page.locator('.article-selection-bar [data-act="lookup"]').click().catch(() => {});
    await page.waitForTimeout(200);
    // 單詞選取不顯示查詞：改由整段短語重試
    await selectSentenceRange(page, 0, 8);
    const shortBar = await page.evaluate(() => {
        const bar = document.querySelector('.article-selection-bar.is-visible');
        const button = bar && bar.querySelector('[data-act="lookup"]');
        return { visible: !!bar, lookup: !!(button && !button.classList.contains('hidden')) };
    });
    check(`[${locale}] 另一段短語同樣有查詞`, shortBar.visible && shortBar.lookup, JSON.stringify(shortBar));
    await page.locator('.article-selection-bar [data-act="lookup"]').click();
    await page.waitForTimeout(1200);
    const failText = (await page.locator('#word-analysis-tooltip').innerText()).replace(/\n/g, ' / ');
    check(`[${locale}] 缺模型時在彈窗內說明原因`, failText.includes(labels.notConfigured), failText);
    check(`[${locale}] 查詞失敗時提供重試`, await page.locator('#word-analysis-tooltip .btn-retry-phrase').count() === 1);
    await page.locator('#word-analysis-tooltip .tooltip-close').click();
    await page.waitForTimeout(250);

    // 單詞選取：工具條不顯示查詞（單詞仍是點詞查詞）
    await selectSentenceRange(page, 0, 2);
    const wordBar = await page.evaluate(() => {
        const bar = document.querySelector('.article-selection-bar.is-visible');
        const button = bar && bar.querySelector('[data-act="lookup"]');
        return { visible: !!bar, hidden: !!(button && button.classList.contains('hidden')) };
    });
    check(`[${locale}] 選取單詞時工具條不顯示查詞`, wordBar.visible && wordBar.hidden, JSON.stringify(wordBar));

    check(`[${locale}] 沒有未預期的主控台錯誤`, errors.length === 0, errors.join(' | '));
    await context.close();
}

(async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        await runLocale(browser, 'zh-CN');
        await runLocale(browser, 'zh-HK');
    } finally {
        await browser.close();
    }
    console.log('');
    if (failures.length) {
        console.log(`失敗 ${failures.length} 項`);
        for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
        process.exitCode = 1;
        return;
    }
    console.log('全部短語查詞測試通過');
})().catch((error) => {
    console.error('FATAL', error);
    process.exitCode = 1;
});
