/**
 * 文章長文效能量測（P3-T5：只量測，不優化）。
 *
 * 這個腳本用 route mock 固定回應，量測前端成本：
 *   - 1k／10k／50k 字級樣本，涵蓋 100／200／500 段；
 *   - 每種樣本各跑一次 analyzeArticle（點擊 → 全部段落 render 完成）；
 *   - 量測 DOM 節點數、.interactive-word 數、long task、點詞 p50／p95、
 *     buildReadingChunks 耗時、助手每輪 context 字元數與請求數；
 *   - 同時驗證關閉 probe 時沒有 observer／沒有 __bdcPerf／沒有 bdc: 量測標記。
 *
 * 產出：
 *   docs/report/<timestamp>_文章長文效能量測.md
 *   docs/report/<timestamp>_文章長文效能量測.json
 *
 * 用法：
 *   PORT=8313 PLAYWRIGHT_MODULE=<path-to-playwright> node tests/article-perf-probe.cjs
 *
 * 可選環境變數：
 *   PERF_SCENARIOS=1k-100,10k-200  只跑指定情境（開發時縮短等待）
 *   PERF_WORDS=15                  每個情境點幾個詞
 *   PERF_MOCK_DELAY_MS=0           mock 回應固定延遲
 *   PERF_REPORT=0                  不寫報告（只印摘要）
 *
 * 不連真實 AI／TTS／同步端點：provider 全部 route mock，ai-config.js 由 route
 * 覆寫成無 TTS／無外部同步（但保留本機 ai-config.js 的 AI_LIMITS，量測才不會
 * 因為測試載具改變請求節奏）。
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const mock = require('./helpers/article-mock.cjs');

const PORT = Number(process.env.PORT || 8313);
const BASE = `http://127.0.0.1:${PORT}/`;
const PROVIDER = mock.PROVIDER;
const PROVIDER_ORIGIN = new URL(PROVIDER).origin;
const BASE_ORIGIN = new URL(BASE).origin;
const ROOT = path.resolve(__dirname, '..');
const REPORT_DIR = path.join(ROOT, 'docs', 'report');
const WRITE_REPORT = process.env.PERF_REPORT !== '0';
const WORDS_PER_SCENARIO = Math.max(1, Number(process.env.PERF_WORDS || 15));
const MOCK_DELAY_MS = Math.max(0, Number(process.env.PERF_MOCK_DELAY_MS || 0));
const ONLY = process.env.PERF_SCENARIOS
    ? new Set(process.env.PERF_SCENARIOS.split(',').map((item) => item.trim()).filter(Boolean))
    : null;

const ASSISTANT_QUESTION = 'PERF_ASSISTANT_QUESTION 请用一句话说明这篇文章的主题。';

const { check, finish } = mock.createReporter('文章長文效能量測（P3-T5）');

/**
 * 樣本矩陣：目標字元數與段數。
 * 1k／100 段是「100 段」的下限組合，實際字元數會高於 1k（每段仍需是句子），
 * 報告一律寫實測值，不把目標值當成結果。
 */
const SCENARIOS = [
    { id: '1k-100', targetCharacters: 1000, paragraphs: 100 },
    { id: '10k-200', targetCharacters: 10000, paragraphs: 200 },
    { id: '50k-100', targetCharacters: 50000, paragraphs: 100 },
    { id: '10k-500', targetCharacters: 10000, paragraphs: 500 },
    { id: '50k-500', targetCharacters: 50000, paragraphs: 500 }
].filter((scenario) => !ONLY || ONLY.has(scenario.id));

// ---------------------------------------------------------------------------
// 樣本產生（程式生成，不新增大型 fixture）
// ---------------------------------------------------------------------------

const SENTENCE_POOL = [
    'The reading room opens at eight with a soft bell.',
    'Visitors sign the ledger before choosing a seat near the window.',
    'A quiet archive keeps a record of every borrowed volume.',
    'The café downstairs serves tea to readers on rainy afternoons.',
    'Naïve guests often ask about the oldest map in the collection.',
    'Librarians co-operate with the Zürich team on the B2B index.',
    'Every shelf carries a small label in three languages.',
    'The lamp above the desk hums while the pages turn.'
];

// 段數多而字數少時，只能用短句；保留多種長度才能讓樣本接近目標字數。
const SHORT_POOL = [
    'Café opens.',
    'Tea is warm.',
    'The lamp hums.',
    'Readers wait.',
    'A page turns.',
    'The shelves gleam.'
];
const MEDIUM_POOL = [
    'The reading room opens at eight.',
    'Visitors sign the ledger at the door.',
    'A quiet archive keeps every volume.',
    'The café serves tea on rainy days.',
    'Naïve guests ask about the old map.',
    'Every shelf carries a small label.',
    'The lamp above the desk hums softly.',
    'Librarians sort the new arrivals.'
];
const ALL_SENTENCES = [...SHORT_POOL, ...MEDIUM_POOL, ...SENTENCE_POOL]
    .sort((a, b) => a.length - b.length);

const ACCENT_PARAGRAPH = 'Café owners in Zürich call the naïve plan simple, and the B2B desk handles COVID-19 notices.';
const LINK_CODE_PARAGRAPH = 'Read the [field guide](https://example.com/guide) and run `npm test` before the 3D print.';
const TABLE_PARAGRAPH = [
    '| Item | Note |',
    '| --- | --- |',
    '| café | naïve |',
    '| B2B | COVID-19 |'
].join('\n');
const CODE_PARAGRAPH = [
    '```js',
    "const café = 'naïve';",
    'console.log(café);',
    '```'
].join('\n');

function makeSentences(minCharacters, salt, poolOffset = 0) {
    const parts = [];
    let total = 0;
    let index = poolOffset;
    while (total < minCharacters) {
        let sentence = SENTENCE_POOL[index % SENTENCE_POOL.length];
        index += 1;
        // 每段第一句帶流水號，避免相同段落命中應用的段落快取（會少送請求）。
        if (!parts.length) sentence = `${sentence} (${salt})`;
        parts.push(sentence);
        total += sentence.length + 1;
    }
    return parts.join(' ');
}

/**
 * 產生接近 targetLength 的段落：
 *   - 第一句帶唯一流水號（避免段落快取命中，請求數才不會少於段數）；
 *   - 之後優先挑「放得進剩餘預算」的最長句，避免 500 段時字數爆掉。
 */
function makeFiller(targetLength, salt, poolOffset = 0) {
    const parts = [];
    let total = 0;
    let index = poolOffset;
    while (parts.length < 200) {
        const remaining = targetLength - total;
        if (parts.length && remaining < 12) break;
        let sentence;
        if (!parts.length) {
            const base = remaining <= 30 ? SHORT_POOL[index % SHORT_POOL.length]
                : remaining <= 60 ? MEDIUM_POOL[index % MEDIUM_POOL.length]
                    : SENTENCE_POOL[index % SENTENCE_POOL.length];
            sentence = `${salt}: ${base}`;
        } else {
            const limit = Math.max(12, remaining);
            const fitting = ALL_SENTENCES.filter((item) => item.length <= limit);
            sentence = fitting.length ? fitting[fitting.length - 1] : ALL_SENTENCES[0];
        }
        parts.push(sentence);
        total += sentence.length + 1;
        index += 1;
        if (total >= targetLength) break;
    }
    return parts.join(' ');
}

function buildSample(targetCharacters, paragraphCount) {
    const longLength = Math.max(120, Math.min(6000, Math.round(targetCharacters * 0.15)));
    const special = [
        makeSentences(longLength, 'long-1', 0),
        ACCENT_PARAGRAPH,
        LINK_CODE_PARAGRAPH,
        TABLE_PARAGRAPH,
        CODE_PARAGRAPH
    ];
    const specialCharacters = special.reduce((sum, item) => sum + item.length + 2, 0);
    const remainingParagraphs = Math.max(1, paragraphCount - special.length);
    const remainingCharacters = Math.max(
        remainingParagraphs * 24,
        targetCharacters - specialCharacters
    );
    const average = Math.max(24, Math.floor(remainingCharacters / remainingParagraphs));
    const fillers = [];
    for (let i = 0; i < remainingParagraphs; i += 1) {
        fillers.push(makeFiller(average, `p${i + 1}`, i % SENTENCE_POOL.length));
    }
    const paragraphs = [...special, ...fillers];
    return {
        paragraphs,
        body: paragraphs.join('\n\n'),
        meta: {
            characters: paragraphs.join('\n\n').length,
            paragraphs: paragraphs.length,
            hasLongParagraph: true,
            longestParagraphCharacters: Math.max(...paragraphs.map((item) => item.length)),
            hasTable: paragraphs.some((item) => item.startsWith('|')),
            hasCode: paragraphs.some((item) => item.includes('```') || item.includes('`')),
            hasLink: paragraphs.some((item) => item.includes('](')),
            hasAccent: paragraphs.some((item) => /[éï]/u.test(item))
        }
    };
}

// ---------------------------------------------------------------------------
// 測試載具
// ---------------------------------------------------------------------------

/** 以本機 ai-config.js 的 AI_LIMITS 為基礎，只把 TTS／外部同步換成空值。 */
function readJsonExport(file, name) {
    try {
        const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
        const match = source.match(new RegExp(`export const ${name} = (\\{[\\s\\S]*?\\n\\});`));
        if (!match) return null;
        return JSON.parse(match[1]);
    } catch (_) {
        return null;
    }
}

const AI_LIMITS = readJsonExport('ai-config.js', 'AI_LIMITS')
    || readJsonExport('ai-config.example.js', 'AI_LIMITS')
    || { default: { maxConcurrency: 2, minIntervalMs: 150 } };

const TEST_CONFIG_BODY = `export const AI_LIMITS = ${JSON.stringify(AI_LIMITS)};
export const TTS_CONFIG = {};
export const QA_CHECK = {};
export const OCR_CONFIG = {};
export const ARTICLE_IMPORT = {};
export const SUPABASE = {};
export const SYNC = {};
`;

const TTS_NOOP = `
    window.__spoken = [];
    try {
        Object.defineProperty(window, 'speechSynthesis', {
            configurable: true,
            value: {
                getVoices: () => [],
                cancel: () => {},
                pause: () => {},
                resume: () => {},
                speak: (utterance) => {
                    window.__spoken.push(String(utterance && utterance.text || ''));
                    try { if (utterance && utterance.onstart) utterance.onstart(); } catch (_) {}
                }
            }
        });
    } catch (_) {}
    try {
        window.SpeechSynthesisUtterance = function (text) { this.text = String(text || ''); };
    } catch (_) {}
`;

async function dismissStartupModal(page) {
    try {
        await page.evaluate(() => {
            const modal = document.getElementById('app-modal');
            if (!modal || modal.classList.contains('hidden')) return;
            const later = Array.from(modal.querySelectorAll('button'))
                .find((button) => /稍后|稍後|later/i.test(button.textContent || ''));
            if (later) later.click();
            else modal.querySelector('.modal-close-btn')?.click();
        });
        await page.waitForTimeout(150);
    } catch (_) { /* 沒有 modal 也沒關係 */ }
}

async function makePage(browser, { perf = true, storageFlag = false } = {}) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
    await mock.initScript(context);
    await context.addInitScript(TTS_NOOP);
    await context.addInitScript(({ flag }) => {
        if (!flag) return;
        try { localStorage.setItem('bdc:perf', '1'); } catch (_) {}
    }, { flag: storageFlag });
    // 助手用非串流，route mock 的 JSON 回應即可。
    await context.addInitScript(() => {
        try {
            const raw = localStorage.getItem('pen_global_settings');
            const parsed = raw ? JSON.parse(raw) : {};
            parsed.assistant = { ...(parsed.assistant || {}), stream: false };
            localStorage.setItem('pen_global_settings', JSON.stringify(parsed));
        } catch (_) { /* noop */ }
    });
    await context.route('**/ai-config.js', (route) => route.fulfill({
        contentType: 'application/javascript',
        body: TEST_CONFIG_BODY
    }));
    // 同步端點固定在本機、route 直接回應，避免真的連線。
    await context.route('http://127.0.0.1:19999/**', (route) => route.fulfill({
        status: 503,
        headers: { 'Access-Control-Allow-Origin': '*' },
        contentType: 'application/json',
        body: '{"error":"mock sync offline"}'
    }));

    const page = await context.newPage();
    const stats = {
        paragraphRequests: 0,
        wordRequests: 0,
        assistantRequests: 0,
        otherRequests: 0,
        consoleErrors: [],
        pageErrors: []
    };
    page.on('pageerror', (error) => stats.pageErrors.push(String(error && error.message ? error.message : error)));
    page.on('console', (message) => {
        if (message.type() === 'error') stats.consoleErrors.push(message.text());
    });

    await mock.installProviderRoutes(page, async ({ route, prompt }) => {
        if (MOCK_DELAY_MS) await new Promise((resolve) => setTimeout(resolve, MOCK_DELAY_MS));
        if (prompt.includes('PERF_ASSISTANT_QUESTION')) {
            stats.assistantRequests += 1;
            return mock.jsonReply(route, 'PERF assistant reply.');
        }
        if (/Target word:\s*"/.test(prompt)) {
            stats.wordRequests += 1;
            return mock.jsonReply(route, {
                word: 'word',
                sentence: '',
                analysis: { phonetic: '', pos: 'noun', meaning: '測試意思', role: '' }
            });
        }
        stats.paragraphRequests += 1;
        return mock.jsonReply(route, mock.translatedParagraphReply(prompt, 'PERFZH'));
    });

    // `?perf=1#a` 會讓既有路由把 `perf=1` 當成未知模組；改用 `module=a` 明確指定。
    const url = BASE + (perf ? '?perf=1&module=a' : '') + (perf ? '' : '#a');
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(900);
    await dismissStartupModal(page);
    return { context, page, stats };
}

async function startAnalysis(page, body) {
    await page.fill('#article-input', body);
    await page.dispatchEvent('#article-input', 'input');
    await page.evaluate(() => document.getElementById('analyze-article-btn').click());
}

async function analysisProgress(page) {
    return page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('#article-analysis-container .paragraph-pair .para-status'));
        let settled = 0;
        for (const row of rows) {
            const status = row.dataset.status || '';
            if (status === 'done' || status === 'skipped' || status === 'failed') settled += 1;
        }
        return { rows: rows.length, settled };
    });
}

async function waitForAnalysisRendered(page, paragraphs, timeoutMs) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        const progress = await analysisProgress(page);
        const probeDone = await page.evaluate(() => {
            const status = window.__bdcPerf?.analysisStatus?.() || 'idle';
            return status !== 'running' && status !== 'idle';
        });
        if (progress.rows >= paragraphs && progress.settled >= paragraphs && probeDone) {
            return { ok: true, waitedMs: Date.now() - startedAt, progress };
        }
        await page.waitForTimeout(700);
    }
    return { ok: false, waitedMs: Date.now() - startedAt, progress: await analysisProgress(page) };
}

const tooltipVisible = (page) => page.evaluate(() => {
    const el = document.getElementById('word-analysis-tooltip');
    return !!el && el.style.display === 'block';
});

async function closeTooltip(page) {
    await page.evaluate(() => {
        document.querySelector('#word-analysis-tooltip .tooltip-close')?.click();
    });
    await page.waitForTimeout(60);
}

async function clickWords(page, count) {
    const clicked = [];
    for (let i = 0; i < count; i += 1) {
        const word = await page.evaluate((index) => {
            const words = Array.from(document.querySelectorAll('#article-analysis-container .paragraph-english .interactive-word'))
                .filter((el) => !el.closest('a, code, pre, kbd, samp') && el.getAttribute('data-word'));
            if (!words.length) return null;
            const el = words[index % words.length];
            el.scrollIntoView({ block: 'center' });
            el.click();
            return el.getAttribute('data-word');
        }, i * 3);
        if (!word) break;
        try {
            await page.waitForFunction(() => {
                const el = document.getElementById('word-analysis-tooltip');
                return el && el.style.display === 'block';
            }, null, { timeout: 10000 });
            // 等 probe 的 rAF 取樣落地。
            await page.waitForTimeout(120);
            clicked.push(word);
        } finally {
            if (await tooltipVisible(page)) await closeTooltip(page);
        }
    }
    return clicked;
}

async function measureReadingChunks(page) {
    const ok = await page.evaluate(() => {
        const button = document.getElementById('read-article-btn');
        if (!button) return false;
        button.click();
        return true;
    });
    await page.waitForTimeout(450);
    await page.evaluate(() => document.getElementById('stop-read-article-btn')?.click());
    await page.waitForTimeout(250);
    return ok;
}

async function askAssistantOnce(page) {
    const hidden = await page.evaluate(() => document.getElementById('assistant-panel')?.classList.contains('assistant-hidden'));
    if (hidden) await page.evaluate(() => document.getElementById('assistant-fab')?.click());
    await page.waitForTimeout(250);
    await page.fill('#assistant-input', ASSISTANT_QUESTION);
    await page.evaluate(() => document.getElementById('assistant-send')?.click());
    try {
        await page.waitForFunction(() => {
            const nodes = document.querySelectorAll('#assistant-messages .assistant-assistant');
            const el = nodes[nodes.length - 1];
            if (!el) return false;
            const text = (el.textContent || '').trim();
            return text.length > 0 && !el.querySelector('.assistant-stop');
        }, null, { timeout: 30000 });
        return { ok: true };
    } catch (_) {
        return { ok: false };
    }
}

function scenarioReportRow(scenario, snapshot, stats) {
    const analyze = snapshot.article.analyze || {};
    return {
        id: scenario.id,
        targetCharacters: scenario.targetCharacters,
        paragraphsTargeted: scenario.paragraphs,
        characters: snapshot.article.characters,
        paragraphs: snapshot.article.paragraphs,
        domNodes: snapshot.article.domNodes,
        interactiveWords: snapshot.article.interactiveWords,
        analyze: {
            status: analyze.status || 'unavailable',
            totalMs: analyze.totalMs ?? null,
            longTasks: analyze.longTasks || null
        },
        longtask: snapshot.longtask,
        wordTooltip: {
            count: snapshot.wordTooltip.count,
            p50: snapshot.wordTooltip.p50,
            p95: snapshot.wordTooltip.p95,
            min: snapshot.wordTooltip.min,
            max: snapshot.wordTooltip.max
        },
        readingChunks: snapshot.readingChunks,
        assistant: snapshot.assistant,
        requests: {
            paragraphs: stats.paragraphRequests,
            words: stats.wordRequests,
            assistant: stats.assistantRequests
        }
    };
}

async function runScenario(browser, scenario) {
    const sample = buildSample(scenario.targetCharacters, scenario.paragraphs);
    const { context, page, stats } = await makePage(browser);
    let result = null;
    try {
        await page.waitForFunction(() => !!window.__bdcPerf, null, { timeout: 15000 });
        await startAnalysis(page, sample.body);
        // 500 段在 500ms 請求間隔下需要數分鐘；timeout 依段數放大。
        const timeoutMs = Math.max(120000, scenario.paragraphs * 900 + 60000);
        const finished = await waitForAnalysisRendered(page, scenario.paragraphs, timeoutMs);
        check(`${scenario.id}：分析完成（${scenario.paragraphs} 段）`, finished.ok,
            JSON.stringify({ progress: finished.progress, waitedMs: finished.waitedMs }));

        const clicked = await clickWords(page, WORDS_PER_SCENARIO);
        const readingOk = await measureReadingChunks(page);
        check(`${scenario.id}：buildReadingChunks 有取樣`, readingOk, String(readingOk));
        const assistant = await askAssistantOnce(page);

        const snapshot = await page.evaluate(() => window.__bdcPerf.snapshot());
        const row = scenarioReportRow(scenario, snapshot, stats);
        row.sample = sample.meta;
        row.waitedMs = finished.waitedMs;
        // 只記數量，不記實際點過的詞：報告不得包含文章內容片段。
        row.clickedWordCount = Array.isArray(clicked) ? clicked.length : 0;
        row.assistantAskOk = assistant.ok;
        row.environment = snapshot.environment;
        row.limitations = snapshot.limitations;

        check(`${scenario.id}：文章字元數 > 0`, Number(row.characters) > 0, String(row.characters));
        check(`${scenario.id}：段數與樣本一致`, row.paragraphs === scenario.paragraphs,
            JSON.stringify({ snapshot: row.paragraphs, sample: scenario.paragraphs }));
        check(`${scenario.id}：DOM 節點數 > 0`, Number(row.domNodes) > 0, String(row.domNodes));
        check(`${scenario.id}：.interactive-word 數 > 0`, Number(row.interactiveWords) > 0, String(row.interactiveWords));
        check(`${scenario.id}：analyze 狀態為 rendered`, row.analyze.status === 'rendered', row.analyze.status);
        check(`${scenario.id}：點詞樣本數 >= 3`, row.wordTooltip.count >= 3, String(row.wordTooltip.count));
        check(`${scenario.id}：讀句 chunk 有量到`, row.readingChunks.calls >= 1, JSON.stringify(row.readingChunks.last));
        check(`${scenario.id}：助手 context 長度有記到`,
            row.assistant.turns.length >= 1 && Number(row.assistant.turns[0]?.contextCharacters) > 0,
            JSON.stringify(row.assistant.turns.slice(0, 1)));
        check(`${scenario.id}：助手請求數有記到`,
            assistant.ok && Number(row.assistant.turns[0]?.requestCount) === 1,
            JSON.stringify(row.assistant.turns.slice(0, 1)));
        check(`${scenario.id}：段落請求數等於段數`,
            row.requests.paragraphs === scenario.paragraphs,
            JSON.stringify({ requests: row.requests.paragraphs, paragraphs: scenario.paragraphs }));
        check(`${scenario.id}：無 pageerror`, stats.pageErrors.length === 0, stats.pageErrors.join(' | '));

        result = row;
    } finally {
        await context.close();
    }
    return result;
}

async function runWarmup(browser) {
    // 短暫暖機，降低第一個正式情境的 JIT／快取偏差；結果不寫入報告。
    const { context, page } = await makePage(browser);
    try {
        await page.waitForFunction(() => !!window.__bdcPerf, null, { timeout: 15000 });
        await startAnalysis(page, makeSentences(400, 'warmup').split('. ').join('.\n\n'));
        await page.waitForTimeout(6000);
    } finally {
        await context.close();
    }
}

async function verifyProbeOff(browser) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await mock.initScript(context);
    await context.addInitScript(TTS_NOOP);
    await context.addInitScript(() => {
        window.__perfObserverTypes = [];
        const Original = window.PerformanceObserver;
        if (!Original) return;
        window.PerformanceObserver = class extends Original {
            observe(...args) {
                try { window.__perfObserverTypes.push(args[0] && (args[0].type || args[0].entryTypes)); } catch (_) {}
                return super.observe(...args);
            }
        };
    });
    await context.route('**/ai-config.js', (route) => route.fulfill({
        contentType: 'application/javascript',
        body: TEST_CONFIG_BODY
    }));
    await context.route('http://127.0.0.1:19999/**', (route) => route.fulfill({
        status: 503,
        headers: { 'Access-Control-Allow-Origin': '*' },
        contentType: 'application/json',
        body: '{"error":"mock sync offline"}'
    }));
    const page = await context.newPage();
    const pageErrors = [];
    const consoleErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error && error.message ? error.message : error)));
    page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
    });
    let stats = { paragraphRequests: 0, wordRequests: 0, assistantRequests: 0 };
    await mock.installProviderRoutes(page, async ({ route, prompt }) => {
        if (/Target word:\s*"/.test(prompt)) stats.wordRequests += 1;
        else stats.paragraphRequests += 1;
        return mock.jsonReply(route, mock.translatedParagraphReply(prompt, 'OFFZH'));
    });
    let result = null;
    try {
        await page.goto(BASE + '#a', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(900);
        await dismissStartupModal(page);
        const shell = await page.evaluate(() => ({
            hasProbe: typeof window.__bdcPerf !== 'undefined',
            enabled: window.__bdcPerf?.enabled === true
        }));
        check('關閉 probe：window.__bdcPerf 不存在', shell.hasProbe === false, JSON.stringify(shell));

        // 用 3 段短文走一次分析＋點詞，確認停用時觀測點確實是 no-op。
        await startAnalysis(page, [
            'The reading room opens at eight.',
            'Visitors sign the ledger at the door.',
            'The café serves tea on rainy days.'
        ].join('\n\n'));
        await page.waitForFunction(() => {
            const rows = Array.from(document.querySelectorAll('#article-analysis-container .paragraph-pair .para-status'));
            return rows.length >= 3 && rows.every((row) => (row.dataset.status || '') === 'done');
        }, null, { timeout: 60000 });
        await page.evaluate(() => {
            document.querySelector('#article-analysis-container .paragraph-english .interactive-word')?.click();
        });
        await page.waitForTimeout(600);

        const offline = await page.evaluate(() => ({
            hasProbe: typeof window.__bdcPerf !== 'undefined',
            marks: performance.getEntriesByType('mark').filter((entry) => String(entry.name || '').startsWith('bdc:')).length,
            measures: performance.getEntriesByType('measure').filter((entry) => String(entry.name || '').startsWith('bdc:')).length,
            observerTypes: Array.isArray(window.__perfObserverTypes) ? window.__perfObserverTypes.slice() : []
        }));
        const perfConsole = consoleErrors.filter((text) => /__bdcPerf|bdc:perf|perf-probe/i.test(text));
        check('關閉 probe：分析後仍沒有 window.__bdcPerf', offline.hasProbe === false, JSON.stringify(offline));
        check('關閉 probe：沒有 bdc: performance mark', offline.marks === 0, String(offline.marks));
        check('關閉 probe：沒有 bdc: performance measure', offline.measures === 0, String(offline.measures));
        check('關閉 probe：沒有安裝 longtask PerformanceObserver',
            !offline.observerTypes.some((type) => type === 'longtask'),
            JSON.stringify(offline.observerTypes));
        check('關閉 probe：無 pageerror', pageErrors.length === 0, pageErrors.join(' | '));
        check('關閉 probe：無 probe 相關 console error', perfConsole.length === 0, perfConsole.join(' | '));

        result = {
            hasProbe: offline.hasProbe,
            marks: offline.marks,
            measures: offline.measures,
            observerTypes: offline.observerTypes,
            consoleErrorCount: consoleErrors.length,
            consoleErrors: consoleErrors.slice(0, 10),
            pageErrors,
            paragraphRequests: stats.paragraphRequests
        };
    } finally {
        await context.close();
    }
    return result;
}

async function verifyStorageFlag(browser) {
    const { context, page } = await makePage(browser, { perf: false, storageFlag: true });
    let result = null;
    try {
        await page.waitForTimeout(800);
        result = await page.evaluate(() => ({
            hasProbe: typeof window.__bdcPerf !== 'undefined',
            enabled: window.__bdcPerf?.enabled === true
        }));
        check('localStorage bdc:perf=1：probe 啟用', result.hasProbe && result.enabled === true, JSON.stringify(result));

        // 長 task 探針自檢：主動做一段 >50ms 的同步工作，確認 observer 真的會計數。
        // 否則報告中的 0 次可能被誤讀成「沒有成本」，而不是「沒有觀察到」。
        // 注意：Chromium 不會把 DevTools evaluate 本身的任務算成 long task，
        // 所以要排進 setTimeout callback（一般頁面任務）再驗證。
        const before = await page.evaluate(() => window.__bdcPerf.snapshot().longtask);
        await page.evaluate(() => new Promise((resolve) => {
            setTimeout(() => {
                const start = performance.now();
                while (performance.now() - start < 200) { /* busy */ }
                resolve(true);
            }, 0);
        }));
        await page.waitForTimeout(600);
        const after = await page.evaluate(() => window.__bdcPerf.snapshot().longtask);
        check('longtask 探針自檢：>50ms 同步工作會被記錄',
            !!after.supported && after.count > before.count,
            JSON.stringify({ before, after }));
        result.longtaskSelfTest = {
            beforeCount: before.count,
            afterCount: after.count,
            supported: after.supported,
            detected: after.count > before.count
        };
    } finally {
        await context.close();
    }
    return result;
}

// ---------------------------------------------------------------------------
// 報告
// ---------------------------------------------------------------------------

function timestamp() {
    const now = new Date();
    const pad = (value, width = 2) => String(value).padStart(width, '0');
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
        + `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}${pad(now.getMilliseconds(), 3)}`;
}

function formatValue(value, digits = 1) {
    if (value === null || value === undefined) return 'unavailable';
    if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(digits);
    return String(value);
}

function longTaskCell(longtask) {
    if (!longtask) return 'unavailable';
    if (!longtask.supported) return `unavailable（${longtask.unavailable || 'unsupported'}）`;
    return `count ${longtask.count}／總 ${formatValue(longtask.totalMs)}ms／max ${formatValue(longtask.maxMs)}ms／>200ms ${longtask.countOver200} 次`;
}

function buildMarkdown(payload) {
    const lines = [];
    lines.push('# 文章長文效能量測（P3-T5）');
    lines.push('');
    lines.push(`- 產生時間：${payload.generatedAt}`);
    lines.push(`- 腳本：\`tests/article-perf-probe.cjs\``);
    lines.push(`- 瀏覽器：${payload.environment.browserVersion}（headless）`);
    lines.push(`- 裝置：UA \`${payload.environment.userAgent}\``);
    lines.push(`- 視窗：${payload.environment.viewport.width}×${payload.environment.viewport.height} @${payload.environment.viewport.devicePixelRatio}x；hardwareConcurrency=${formatValue(payload.environment.hardwareConcurrency)}；deviceMemory=${formatValue(payload.environment.deviceMemory)}`);
    lines.push(`- mock 延遲：${payload.environment.mockDelayMs}ms（route 固定回應，非真實供應商）`);
    lines.push(`- 生效 AI_LIMITS：\`${JSON.stringify(payload.environment.aiLimits)}\``);
    lines.push('');
    lines.push('> **這一輪只量測，沒有改產品行為。** 本報告不宣稱任何數字是所有裝置的效能上限，也不代表 D8 門檻已拍板。');
    lines.push('');
    lines.push('## 量測方法與範圍');
    lines.push('');
    lines.push('- 每個情境在全新的 browser context 開啟 `?perf=1`（以既有 module 路由進入文章模組），以 route mock 回應段落翻譯／查詞／助手，不連真實 AI／TTS／同步端點。');
    lines.push('- `analyze` 量的是「按下分析 → 所有段落 render 完成」；包含既有 400ms 段落間隔與併發上限（產品現行行為），不是純渲染時間。');
    lines.push('- 點詞延遲量的是「點擊 → tooltip 外殼可見（含下一個動畫框）」；查詞本身仍是非同步請求，但 tooltip 載入殼會先顯示，因此不是 AI 回應時間。');
    lines.push('- long task 由瀏覽器 Long Tasks API 取得（`PerformanceObserver({type:\'longtask\'})`）；不支援時標示 `unavailable`，不當成 0。');
    lines.push('- DOM 數以 `document.querySelectorAll(\'*\').length` 計算，`.interactive-word` 以 querySelectorAll 計數；皆為該情境最終畫面。');
    lines.push('- 助手 context 以「實際放進 messages 的字元長度」計；每輪請求數在真正送出 provider 請求時累加。');
    lines.push('- 報告只寫字數／段數／耗時／數量，不寫入文章內容、句子或助手訊息。');
    lines.push('');
    lines.push('## 樣本與實測摘要');
    lines.push('');
    lines.push('| 情境 | 目標字元 | 實測字元（UTF-16） | 目標段數 | DOM 段數 | DOM 節點 | interactive-word | analyze 完成 (ms) | 分析期間 long task（總次數／>200ms） | 點詞 p50／p95 (ms) | 點詞樣本 | 讀句 build 耗時 last (ms)／chunks | 助手 context 字元／請求 | mock 請求（段／詞／助手） |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const row of payload.scenarios) {
        const analyzeLt = row.analyze.longTasks
            ? `${row.analyze.longTasks.count} 次（>200ms ${row.analyze.longTasks.countOver200} 次）`
            : 'unavailable';
        const wordTooltip = row.wordTooltip.count
            ? `${formatValue(row.wordTooltip.p50)}／${formatValue(row.wordTooltip.p95)}`
            : 'unavailable';
        const reading = row.readingChunks.last
            ? `${formatValue(row.readingChunks.last.ms)}／${row.readingChunks.last.chunks} chunks（${row.readingChunks.last.characters} 字元）`
            : 'unavailable';
        const turn = row.assistant.turns[0];
        const assistantCell = turn
            ? `${formatValue(turn.contextCharacters)}／${formatValue(turn.requestCount)}${turn.unavailable && turn.unavailable.length ? `（unavailable: ${turn.unavailable.join(',')}）` : ''}`
            : 'unavailable';
        lines.push(`| ${row.id} | ${row.targetCharacters} | ${row.characters} | ${row.paragraphsTargeted} | ${row.paragraphs} | ${row.domNodes} | ${row.interactiveWords} | ${row.analyze.status}／${formatValue(row.analyze.totalMs)} | ${analyzeLt} | ${wordTooltip} | ${row.wordTooltip.count} | ${reading} | ${assistantCell} | ${row.requests.paragraphs}／${row.requests.words}／${row.requests.assistant} |`);
    }
    lines.push('');
    lines.push('### 全域 long task（自頁面載入起，含分析、點詞、朗讀、助手）');
    lines.push('');
    lines.push('| 情境 | long task |');
    lines.push('| --- | --- |');
    for (const row of payload.scenarios) {
        lines.push(`| ${row.id} | ${longTaskCell(row.longtask)} |`);
    }
    lines.push('');
    lines.push('### 樣本組成');
    lines.push('');
    lines.push('| 情境 | 最長單段字元 | 含表格 | 含 code | 含連結 | 含重音詞 | 分析等待 (ms) |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const row of payload.scenarios) {
        const sample = row.sample || {};
        lines.push(`| ${row.id} | ${formatValue(sample.longestParagraphCharacters)} | ${sample.hasTable ? '是' : '否'} | ${sample.hasCode ? '是' : '否'} | ${sample.hasLink ? '是' : '否'} | ${sample.hasAccent ? '是' : '否'} | ${formatValue(row.waitedMs)} |`);
    }
    lines.push('');
    lines.push('## 與 D8 建議門檻對照（僅對照，未拍板）');
    lines.push('');
    lines.push('D8 建議值目前仍是待決策項，**不是已生效的產品門檻**。下表只列出本輪實測與建議值的差距，供決策參考：');
    lines.push('');
    lines.push('| 建議條件 | 本輪對應情境 | 實測 | 是否落在建議值內 |');
    lines.push('| --- | --- | --- | --- |');
    for (const row of payload.scenarios.filter((item) => item.id === '10k-200')) {
        const p50Ok = row.wordTooltip.p50 !== null && row.wordTooltip.p50 <= 200;
        const p95Ok = row.wordTooltip.p95 !== null && row.wordTooltip.p95 <= 500;
        const ltOk = row.analyze.longTasks ? row.analyze.longTasks.countOver200 <= 2 : null;
        lines.push(`| 10k 字／200 段：點詞 p50 ≤ 200ms | 10k-200 | ${formatValue(row.wordTooltip.p50)}ms | ${p50Ok ? '是' : '否'} |`);
        lines.push(`| 10k 字／200 段：點詞 p95 ≤ 500ms | 10k-200 | ${formatValue(row.wordTooltip.p95)}ms | ${p95Ok ? '是' : '否'} |`);
        lines.push(`| 10k 字／200 段：單次互動 long task >200ms ≤ 2 次 | 10k-200 | ${row.analyze.longTasks ? `${row.analyze.longTasks.countOver200} 次` : 'unavailable'} | ${ltOk === null ? 'unavailable' : (ltOk ? '是' : '否')} |`);
    }
    for (const row of payload.scenarios.filter((item) => item.id === '50k-500')) {
        const trigger = (row.wordTooltip.p95 !== null && row.wordTooltip.p95 > 1000)
            || (row.analyze.longTasks && row.analyze.longTasks.countOver200 > 5);
        lines.push(`| 50k 字：p95 > 1s 或 long task > 5 次 → 才立項評估懶渲染 | 50k-500 | p95 ${formatValue(row.wordTooltip.p95)}ms；long task >200ms ${row.analyze.longTasks ? row.analyze.longTasks.countOver200 : 'unavailable'} 次 | ${trigger ? '符合立項條件（仍待 D8 決策）' : '未觸發建議立項條件'} |`);
    }
    lines.push('');
    lines.push('## 關閉 probe 的驗證');
    lines.push('');
    lines.push(`- \`window.__bdcPerf\`：${payload.probeOff.hasProbe ? '存在（不合格）' : '不存在'}`);
    lines.push(`- \`bdc:\` performance mark／measure：${payload.probeOff.marks}／${payload.probeOff.measures}`);
    lines.push(`- 已安裝的 PerformanceObserver 類型：${payload.probeOff.observerTypes.length ? payload.probeOff.observerTypes.join(', ') : '無'}`);
    lines.push(`- 分析／點詞流程仍可完成，未出現 probe 相關 console error；pageerror：${payload.probeOff.pageErrors.length ? payload.probeOff.pageErrors.join(' | ') : '無'}`);
    lines.push(`- \`localStorage['bdc:perf']='1'\`（無 query）：probe ${payload.storageFlag.enabled ? '有啟用' : '未啟用（不合格）'}`);
    if (payload.storageFlag.longtaskSelfTest) {
        const selfTest = payload.storageFlag.longtaskSelfTest;
        lines.push(`- longtask 探針自檢：${selfTest.detected ? '通過' : '未偵測到（count 0 不可解讀為無成本）'}（${selfTest.beforeCount} → ${selfTest.afterCount}；supported=${selfTest.supported}）`);
    }
    lines.push('');
    lines.push('## 限制');
    lines.push('');
    for (const item of payload.limitations) lines.push(`- ${item}`);
    lines.push('');
    lines.push('## 原始資料');
    lines.push('');
    lines.push(`- JSON：\`${payload.jsonPath}\``);
    lines.push('- JSON 內含每個情境的完整 snapshot（樣本、long task、點詞樣本、讀句耗時、助手回合），不含文章內容。');
    lines.push('');
    return lines.join('\n');
}

(async () => {
    if (!SCENARIOS.length) {
        console.error('沒有可執行的情境（PERF_SCENARIOS 全部被過濾）');
        process.exit(2);
    }
    if (process.env.PERF_DRY_SAMPLE === '1') {
        for (const scenario of SCENARIOS) {
            const sample = buildSample(scenario.targetCharacters, scenario.paragraphs);
            console.log(`${scenario.id}: target=${scenario.targetCharacters} actual=${sample.meta.characters} chars, paragraphs=${sample.meta.paragraphs}, longest=${sample.meta.longestParagraphCharacters}`);
        }
        return;
    }
    const browser = await chromium.launch({ headless: true, executablePath: mock.CHROME });
    const browserVersion = browser.version();
    const results = [];
    let probeOff = null;
    let storageFlag = null;
    let failed = false;
    try {
        console.log(`\n情境：${SCENARIOS.map((item) => item.id).join(', ')}；mock 延遲 ${MOCK_DELAY_MS}ms`);
        await runWarmup(browser);
        for (const scenario of SCENARIOS) {
            console.log(`\n--- ${scenario.id}：目標 ${scenario.targetCharacters} 字／${scenario.paragraphs} 段 ---`);
            const row = await runScenario(browser, scenario);
            if (!row) {
                failed = true;
                continue;
            }
            results.push(row);
            console.log(`  characters=${row.characters} paragraphs=${row.paragraphs} domNodes=${row.domNodes} words=${row.interactiveWords}`);
            console.log(`  analyze=${row.analyze.status} ${row.analyze.totalMs}ms longtask(${row.longtask.supported ? row.longtask.count : 'unavailable'})`);
            console.log(`  tooltip p50=${formatValue(row.wordTooltip.p50)} p95=${formatValue(row.wordTooltip.p95)} count=${row.wordTooltip.count}`);
            console.log(`  requests paragraphs=${row.requests.paragraphs} words=${row.requests.words} assistant=${row.requests.assistant}`);
        }

        console.log('\n--- 關閉 probe 驗證 ---');
        probeOff = await verifyProbeOff(browser);
        console.log('\n--- localStorage 啟用驗證 ---');
        storageFlag = await verifyStorageFlag(browser);
    } finally {
        await browser.close();
    }

    const failures = finish();
    if (failed || failures) {
        console.error('\n量測未全部完成，不寫入報告（避免留下不完整或誤導的數字）。');
        process.exit(1);
    }
    if (!WRITE_REPORT) {
        console.log('\nPERF_REPORT=0：略過報告輸出。');
        return;
    }

    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const stamp = timestamp();
    const jsonPath = path.join(REPORT_DIR, `${stamp}_文章長文效能量測.json`);
    const reportPath = path.join(REPORT_DIR, `${stamp}_文章長文效能量測.md`);
    const ua = results[0]?.environment?.userAgent || '';
    const viewport = results[0]?.environment?.viewport || { width: 1280, height: 900, devicePixelRatio: 1 };
    const payload = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        command: `PORT=${PORT} PLAYWRIGHT_MODULE=<playwright> node tests/article-perf-probe.cjs`,
        environment: {
            browserVersion,
            userAgent: ua,
            viewport,
            hardwareConcurrency: results[0]?.environment?.hardwareConcurrency ?? null,
            deviceMemory: results[0]?.environment?.deviceMemory ?? null,
            mockDelayMs: MOCK_DELAY_MS,
            aiLimits: AI_LIMITS
        },
        scenarios: results,
        probeOff,
        storageFlag,
        limitations: results[0]?.limitations || []
    };
    payload.jsonPath = path.relative(ROOT, jsonPath);
    payload.reportPath = path.relative(ROOT, reportPath);
    fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
    fs.writeFileSync(reportPath, buildMarkdown(payload));
    console.log(`\n報告：${path.relative(ROOT, reportPath)}`);
    console.log(`JSON：${path.relative(ROOT, jsonPath)}`);
})();
