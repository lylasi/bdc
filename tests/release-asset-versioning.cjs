/**
 * 靜態 ES Module 發佈版本（import map）回歸測試。
 *
 * 目的：正式站 CDN 可能仍回應無 query 的舊 article-store／reading-panel。
 * index.html 的 import map 必須讓整張模組圖（含 .mjs 協議與 locales）都走
 * 同一個 release query，因此頁面實際執行的是新版本，而不是只換掉 main.js。
 *
 * 覆蓋：
 *   1. index.html 的 release map 由腳本產生且是最新，main.js／styles.css 同樣版本化
 *   2. article-store／reading-panel 的無 query 請求被模擬成舊版內容；頁面不得請求它們
 *   3. 同一模組有／無 query 只會得到同一個 module instance
 *   4. 同 scope 刷新仍保留已開啟文章正文，冷文章維持摘要
 *   5. 第二個重複詞可精確標記、寫筆記；reading scope 重載後標記仍在
 *   6. 取消標記保留筆記，且整個流程沒有 stale 模組請求或 page error
 *
 * 舊版內容以 git 取得（預設 56b5172，修正 01365d2／4e1c7c0 之前的版本）：
 *   BDC_STALE_REF=<commit> PORT=8313 PLAYWRIGHT_MODULE=<path-to-playwright> \
 *     node tests/release-asset-versioning.cjs
 *
 * 不使用正式帳號或真實資料；測試只在隔離瀏覽器 context 內建立合成文章。
 */
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8313);
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const STALE_REF = process.env.BDC_STALE_REF || '56b5172';
const ARTICLE_ID = 'release-map-opened';
const COLD_ID = 'release-map-cold';
const SENTENCE = 'We look forward to meeting you.';
const BODY = `${SENTENCE}\n\n${SENTENCE}`;
const COLD_BODY = 'This cold article must stay lazy.';
const RESULT = {
    chinese_translation: '我們期待與你見面。\n\n我們期待與你見面。',
    word_alignment: [],
    detailed_analysis: [{ word: 'look', sentence: SENTENCE, analysis: { phonetic: 'lʊk', pos: 'v.', meaning: '看；期待', role: '動詞' } }],
    paragraph_analysis: [0, 1].map(() => ({
        chinese_translation: '我們期待與你見面。',
        sentences: [{ en: SENTENCE, zh: '我們期待與你見面。' }]
    })),
    sentence_analysis: [],
    phrase_analysis: []
};

const checks = [];
function check(name, pass, detail) {
    checks.push({ name, pass: !!pass, detail });
    console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`, detail === undefined ? '' : JSON.stringify(detail));
}

function readReleaseMap() {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const match = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
    assert(match, 'index.html 缺少 inline import map');
    const map = JSON.parse(match[1]);
    const moduleScript = html.match(/<script\s+type="module"\s+src="main\.js(?:\?v=([^"]+))?"/);
    const style = html.match(/<link\s+rel="stylesheet"\s+href="styles\.css(?:\?v=([^"]+))?"/);
    return { html, map, moduleScript, style };
}

function releaseOf(map) {
    const values = Object.values(map.imports || {});
    assert(values.length > 0, 'import map 沒有任何模組');
    const releases = new Set(values.map((value) => {
        const parsed = new URL(value, BASE);
        return parsed.searchParams.get('v');
    }));
    assert.equal(releases.size, 1, `import map 版本不一致：${[...releases].join(', ')}`);
    const [release] = releases;
    assert(release, 'import map 缺少 ?v= release');
    return release;
}

function staleSource(relativePath) {
    try {
        return execFileSync('git', ['show', `${STALE_REF}:${relativePath}`], {
            cwd: ROOT,
            encoding: 'utf8',
            maxBuffer: 16 * 1024 * 1024
        });
    } catch (error) {
        throw new Error(
            `無法取得 ${STALE_REF}:${relativePath}；請在完整 Git 工作副本執行，或設定 BDC_STALE_REF。\n${error.message}`
        );
    }
}

async function closeModal(page) {
    const modal = page.locator('#app-modal');
    if (!(await modal.isVisible().catch(() => false))) return;
    await modal.locator('.modal-close-btn').first().click().catch(() => {});
    await page.waitForTimeout(100);
}

async function openArticle(page, articleId) {
    if (!(await page.locator('#article-btn').isVisible().catch(() => false))) {
        await page.click('#nav-more-btn').catch(() => {});
        await page.waitForTimeout(150);
    }
    await page.click('#article-btn');
    await page.waitForTimeout(150);
    await page.evaluate(async (id) => {
        const state = await import('/modules/state.js');
        state.setCurrentArticleId(id);
        state.setCurrentWordbookId(id);
        const article = await import('/features/article/article.js');
        await article.showCurrentArticleIfAvailable();
    }, articleId);
    await page.waitForFunction(
        () => document.querySelectorAll('.interactive-word[data-word="look"]').length === 2,
        null,
        { timeout: 5000 }
    );
    await page.waitForTimeout(200);
}

async function marks(page) {
    return page.locator('.interactive-word[data-word="look"]').evaluateAll((elements) =>
        elements.map((element) => element.classList.contains('reading-mark-active'))
    );
}

// P2-T2：「寫筆記」收進 details.tooltip-more（預設收起），直接操作前必須先展開。
async function openTooltipMore(page) {
    await page.waitForSelector('#word-analysis-tooltip details.tooltip-more', { timeout: 5000 });
    await page.evaluate(() => {
        const details = document.querySelector('#word-analysis-tooltip details.tooltip-more');
        if (details && !details.open) details.open = true;
    });
    await page.waitForSelector('#word-analysis-tooltip details.tooltip-more[open] .btn-note-item', { state: 'visible', timeout: 5000 });
}

(async () => {
    const { html, map, moduleScript, style } = readReleaseMap();
    const release = releaseOf(map);
    const expectedArticleStore = `/modules/article-store.js?v=${release}`;
    const expectedReadingPanel = `/features/article/reading-panel.js?v=${release}`;

    try {
        const generated = execFileSync(process.execPath, ['scripts/update-release-map.mjs', '--check'], {
            cwd: ROOT,
            encoding: 'utf8'
        });
        check('release map is generated and current', generated.includes(release), generated.trim());
    } catch (error) {
        check('release map is generated and current', false, String(error.stderr || error.message).trim());
    }

    check('article-store is mapped to release query', map.imports['/modules/article-store.js'] === expectedArticleStore, map.imports['/modules/article-store.js']);
    check('reading-panel is mapped to release query', map.imports['/features/article/reading-panel.js'] === expectedReadingPanel, map.imports['/features/article/reading-panel.js']);
    check('shared protocols and locales are mapped', !!map.imports['/shared/article-protocol.mjs']
        && !!map.imports['/shared/reading-protocol.mjs']
        && !!map.imports['/locales/zh-CN.js']
        && !!map.imports['/locales/zh-HK.js']);
    check('ai-config stays unversioned', map.imports['/modules/ai-config.js'] === undefined && map.imports['/ai-config.js'] === undefined);
    check('main.js and styles.css entries are versioned', moduleScript?.[1] === release && style?.[1] === release, {
        main: moduleScript?.[1],
        styles: style?.[1]
    });
    check('import map appears before the module entry', html.indexOf('<script type="importmap">') < html.indexOf('<script type="module" src="main.js'));

    const staleSources = new Map([
        ['modules/article-store.js', staleSource('modules/article-store.js')],
        ['features/article/reading-panel.js', staleSource('features/article/reading-panel.js')]
    ]);

    const browser = await chromium.launch({ headless: true, executablePath: CHROME });
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    const staleRequests = [];
    const staleServed = [];
    const unversionedModuleRequests = [];
    const pageErrors = [];
    try {
        const mappedPaths = new Set(Object.keys(map.imports).map((key) => key.replace(/^\//, '')));
        const stalePaths = new Set(staleSources.keys());
        await context.route('**/*', (route) => {
            const url = new URL(route.request().url());
            if (url.pathname.endsWith('/ai-config.js')) {
                return route.fulfill({
                    contentType: 'application/javascript',
                    body: 'export const SYNC={endpoint:""}; export const TTS_CONFIG={}, AI_LIMITS={}, OCR_CONFIG={}, ARTICLE_IMPORT={}, SUPABASE={};'
                });
            }
            if (url.origin !== BASE) return route.abort();

            const relativePath = url.pathname.replace(/^\/+/, '');
            if (mappedPaths.has(relativePath) || stalePaths.has(relativePath)) {
                // map 缺少變更模組時，也要讓無 query 的舊 CDN 回應真正被模擬出來，
                // 否則測試只會驗證「map 存在」，無法重現正式站拿到舊模組的情境。
                const mappedValue = map.imports[`/${relativePath}`];
                const expected = mappedValue ? new URL(mappedValue, BASE).searchParams.get('v') : null;
                if (!expected || url.searchParams.get('v') !== expected) {
                    unversionedModuleRequests.push(url.pathname + url.search);
                    const stale = staleSources.get(relativePath);
                    if (stale) {
                        staleRequests.push(`${relativePath} -> stale CDN copy`);
                        staleServed.push(relativePath);
                        return route.fulfill({ status: 200, contentType: 'application/javascript', body: stale });
                    }
                    return route.fulfill({
                        status: 200,
                        contentType: 'application/javascript',
                        body: 'throw new Error("unversioned module response");'
                    });
                }
            }
            return route.continue();
        });
        await context.addInitScript(() => {
            try {
                localStorage.setItem('pen_global_settings', JSON.stringify({ language: { interfaceLocale: 'zh-CN' } }));
            } catch (_) {}
        });

        const page = await context.newPage();
        page.on('pageerror', (error) => pageErrors.push(String(error)));
        await page.goto(BASE, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1200);
        await closeModal(page);

        const seeded = await page.evaluate(async ({ articleId, coldId, body, coldBody, result }) => {
            const art = await import('/modules/article-store.js');
            const rd = await import('/modules/reading-store.js');
            await art.initArticleStore();
            await rd.initReadingStore();
            const opened = await art.saveArticle({
                articleId,
                article: body,
                title: 'Release map opened article',
                sourceType: 'paste',
                result
            });
            const cold = await art.saveArticle({
                articleId: coldId,
                article: coldBody,
                title: 'Release map cold article',
                sourceType: 'paste'
            });
            return { opened, cold };
        }, { articleId: ARTICLE_ID, coldId: COLD_ID, body: BODY, coldBody: COLD_BODY, result: RESULT });
        assert(seeded.opened.ok && seeded.cold.ok, JSON.stringify(seeded));

        // 冷啟動後再開文章，讓 residentArticleIds 由實際開啟流程建立。
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1200);
        await closeModal(page);
        await openArticle(page, ARTICLE_ID);

        const refreshed = await page.evaluate(async ({ articleId, coldId }) => {
            const art = await import('/modules/article-store.js');
            const rd = await import('/modules/reading-store.js');
            await art.refreshScope();
            await rd.reloadReadingScope();
            const opened = art.getRecord(articleId);
            const cold = art.getRecord(coldId);
            return {
                opened: opened && { body: opened.article, summaryOnly: opened.summaryOnly, hasAnalysis: !!opened.result },
                cold: cold && { body: cold.article, summaryOnly: cold.summaryOnly }
            };
        }, { articleId: ARTICLE_ID, coldId: COLD_ID });
        check('same-scope refresh retains opened body', refreshed.opened?.body === BODY && refreshed.opened?.summaryOnly === false && refreshed.opened?.hasAnalysis === true, refreshed);
        check('same-scope refresh keeps cold article lazy', refreshed.cold?.body === '' && refreshed.cold?.summaryOnly === true, refreshed.cold);

        await page.waitForTimeout(500);
        const sameInstances = await page.evaluate(async (version) => {
            const articleNoQuery = await import('/modules/article-store.js');
            const articleVersioned = await import(`/modules/article-store.js?v=${version}`);
            const panelNoQuery = await import('/features/article/reading-panel.js');
            const panelVersioned = await import(`/features/article/reading-panel.js?v=${version}`);
            const protocolNoQuery = await import('/shared/reading-protocol.mjs');
            const protocolVersioned = await import(`/shared/reading-protocol.mjs?v=${version}`);
            const localeNoQuery = await import('/locales/zh-CN.js');
            const localeVersioned = await import(`/locales/zh-CN.js?v=${version}`);
            return {
                article: articleNoQuery === articleVersioned,
                panel: panelNoQuery === panelVersioned,
                protocol: protocolNoQuery === protocolVersioned,
                locale: localeNoQuery === localeVersioned
            };
        }, release);
        check('mapped and explicit-query imports share one instance', Object.values(sameInstances).every(Boolean), sameInstances);

        const expectedVersion = await page.evaluate(async (id) => {
            const actions = await import('/modules/reading-actions.js');
            return actions.articleVersion(id);
        }, ARTICLE_ID);
        const secondLookStart = BODY.lastIndexOf('look');

        await page.locator('.interactive-word[data-word="look"]').nth(1).click();
        await page.waitForTimeout(200);
        const tooltip = await page.evaluate(() => {
            const button = document.querySelector('#word-analysis-tooltip .btn-toggle-mark');
            return button ? {
                version: button.getAttribute('data-content-version'),
                anchorStart: Number(button.getAttribute('data-anchor-start')),
                anchorEnd: Number(button.getAttribute('data-anchor-end'))
            } : null;
        });
        check('second occurrence carries current version and exact anchor', tooltip?.version === expectedVersion
            && tooltip?.anchorStart === secondLookStart
            && tooltip?.anchorEnd === secondLookStart + 'look'.length, tooltip);

        await page.locator('#word-analysis-tooltip .btn-toggle-mark').click();
        await page.waitForFunction(() => {
            const button = document.querySelector('#word-analysis-tooltip .btn-toggle-mark');
            return button?.getAttribute('aria-pressed') === 'true';
        }, null, { timeout: 5000 });
        check('manual mark underlines only the second occurrence', JSON.stringify(await marks(page)) === JSON.stringify([false, true]), await marks(page));

        await openTooltipMore(page);
        await page.locator('#word-analysis-tooltip .btn-note-item').click();
        await page.waitForSelector('#article-reading-panel:not(.hidden) textarea.reading-note', { timeout: 5000 });
        await page.waitForFunction(() => document.activeElement?.matches('textarea.reading-note'), null, { timeout: 5000 });
        const noteId = await page.evaluate(() => document.activeElement?.getAttribute('data-note-id') || '');
        assert(noteId, 'missing focused note field');
        const noteText = 'release map note: look forward to + V-ing';
        const noteBox = page.locator(`textarea[data-note-id="${noteId}"]`);
        await noteBox.fill(noteText);
        await noteBox.blur();
        await page.waitForFunction(async ({ id, text }) => {
            const rd = await import('/modules/reading-store.js');
            return rd.getLearningItem(id)?.note === text && rd.getLearningItem(id)?.marked === true;
        }, { id: noteId, text: noteText }, { timeout: 5000 });
        check('note saves for the marked occurrence', true, { itemId: noteId });

        await page.evaluate(async () => {
            const art = await import('/modules/article-store.js');
            const rd = await import('/modules/reading-store.js');
            await art.refreshScope();
            await rd.reloadReadingScope();
        });
        await page.waitForFunction(() => {
            const words = Array.from(document.querySelectorAll('.interactive-word[data-word="look"]'));
            return words.length === 2
                && !words[0].classList.contains('reading-mark-active')
                && words[1].classList.contains('reading-mark-active');
        }, null, { timeout: 5000 });
        const afterReadingRefresh = await page.evaluate(async ({ articleId }) => {
            const art = await import('/modules/article-store.js');
            const rd = await import('/modules/reading-store.js');
            const record = art.getRecord(articleId);
            const items = rd.listLearningItems(articleId).filter((row) => row.anchor?.quote === 'look' && !row.deletedAt);
            const item = items.find((row) => row.marked === true);
            return {
                body: record?.article,
                summaryOnly: record?.summaryOnly,
                active: Array.from(document.querySelectorAll('.interactive-word[data-word="look"]'))
                    .map((element) => element.classList.contains('reading-mark-active')),
                item: item && { marked: item.marked, note: item.note },
                items: items.map((row) => ({ id: row.id, marked: row.marked, note: row.note, anchor: row.anchor, version: row.contentVersion }))
            };
        }, { articleId: ARTICLE_ID });
        check('article body, mark and note survive reading scope reload', afterReadingRefresh.body === BODY
            && afterReadingRefresh.summaryOnly === false
            && JSON.stringify(afterReadingRefresh.active) === JSON.stringify([false, true])
            && afterReadingRefresh.item?.marked === true
            && afterReadingRefresh.item?.note === noteText, afterReadingRefresh);

        await page.evaluate(() => {
            const element = document.getElementById('article-reading-panel');
            if (element && !element.classList.contains('hidden')) element.querySelector('.reading-panel-close')?.click();
        });
        await page.waitForTimeout(200);
        await page.locator('.interactive-word[data-word="look"]').nth(1).click();
        await page.waitForTimeout(200);
        const beforeUnmark = await page.evaluate(() => {
            const button = document.querySelector('#word-analysis-tooltip .btn-toggle-mark');
            return button && {
                pressed: button.getAttribute('aria-pressed'),
                version: button.getAttribute('data-content-version'),
                anchorStart: Number(button.getAttribute('data-anchor-start'))
            };
        });
        assert.equal(beforeUnmark?.pressed, 'true', JSON.stringify(beforeUnmark));
        assert.equal(beforeUnmark?.version, expectedVersion, JSON.stringify(beforeUnmark));
        assert.equal(beforeUnmark?.anchorStart, secondLookStart, JSON.stringify(beforeUnmark));
        await page.locator('#word-analysis-tooltip .btn-toggle-mark').click();
        await page.waitForFunction(() => {
            const button = document.querySelector('#word-analysis-tooltip .btn-toggle-mark');
            return button?.getAttribute('aria-pressed') === 'false';
        }, null, { timeout: 5000 });
        const unmarked = await page.evaluate(async (id) => {
            const rd = await import('/modules/reading-store.js');
            const item = rd.getLearningItem(id);
            return {
                item: item && { marked: item.marked, note: item.note },
                active: Array.from(document.querySelectorAll('.interactive-word[data-word="look"]'))
                    .map((element) => element.classList.contains('reading-mark-active'))
            };
        }, noteId);
        check('unmark keeps the note and clears both underlines', unmarked.item?.marked === false
            && unmarked.item?.note === noteText
            && JSON.stringify(unmarked.active) === JSON.stringify([false, false]), unmarked);

        check('no unversioned local module requests', unversionedModuleRequests.length === 0, unversionedModuleRequests);
        check('no stale article-store/reading-panel response used', staleServed.length === 0, staleRequests);
        check('no page errors', pageErrors.length === 0, pageErrors);
    } finally {
        await context.close();
        await browser.close();
    }

    const failed = checks.filter((item) => !item.pass);
    console.log(JSON.stringify({ release, checks, failed: failed.length }, null, 2));
    process.exitCode = failed.length ? 1 : 0;
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
