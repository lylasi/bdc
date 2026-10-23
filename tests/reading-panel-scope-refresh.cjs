/**
 * 閱讀面板在同 scope 重載後恢復目前文章標記／面板的回歸測試。
 *
 * 覆蓋：
 *   1. 主動標記 → refreshScope + reloadReadingScope → 原錨點仍劃線，面板同步恢復
 *   2. 重載只按需讀目前文章；冷文章不得被 reading-store 讀入
 *   3. 正常 mark 事件不得觸發 scope_article 全量／遞迴載入
 *   4. 筆記輸入中重載：焦點、未保存草稿與面板內容不被 renderPanel 覆蓋，之後仍可保存
 *   5. 補讀期間切換文章：舊文章結果不得畫到新文章
 *   6. 補讀期間切換帳戶 scope：舊 scope 的標記／條目不得回畫到新 scope
 *
 * 用法：
 *   PORT=8313 PLAYWRIGHT_MODULE=<path-to-playwright> node tests/reading-panel-scope-refresh.cjs
 */
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const PORT = Number(process.env.PORT || 8313);
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
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
const IDS = {
    mark: 'reading-panel-refresh-mark',
    cold: 'reading-panel-refresh-cold',
    note: 'reading-panel-refresh-note',
    switchA: 'reading-panel-refresh-switch-a',
    switchB: 'reading-panel-refresh-switch-b',
    scope: 'reading-panel-refresh-scope'
};

const checks = [];
function check(name, pass, detail) {
    checks.push({ name, pass: !!pass, detail });
    console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`, detail === undefined ? '' : JSON.stringify(detail));
}

async function closeModal(page) {
    const modal = page.locator('#app-modal');
    if (!(await modal.isVisible().catch(() => false))) return;
    await modal.locator('.modal-close-btn').first().click().catch(() => {});
    await page.waitForTimeout(100);
}

async function navigateToArticle(page) {
    if (!(await page.locator('#article-btn').isVisible().catch(() => false))) {
        await page.click('#nav-more-btn').catch(() => {});
        await page.waitForTimeout(150);
    }
    await page.click('#article-btn');
    await page.waitForTimeout(200);
}

async function seedArticles(page, articles) {
    const seeded = await page.evaluate(async ({ articles, result }) => {
        const art = await import('/modules/article-store.js');
        const rd = await import('/modules/reading-store.js');
        await art.initArticleStore();
        await rd.initReadingStore();
        const results = [];
        for (const entry of articles) {
            results.push(await art.saveArticle({
                articleId: entry.id,
                article: entry.body || resultBody(),
                title: entry.title || entry.id,
                sourceType: 'paste',
                result: entry.withResult === false ? undefined : (entry.result || result)
            }));
        }
        return results;
        function resultBody() {
            const sentence = 'We look forward to meeting you.';
            return `${sentence}\n\n${sentence}`;
        }
    }, { articles, result: RESULT });
    assert(seeded.every((item) => item && item.ok), JSON.stringify(seeded));
}

async function openArticle(page, articleId) {
    await page.evaluate(async (id) => {
        const state = await import('/modules/state.js');
        const article = await import('/features/article/article.js');
        state.setCurrentArticleId(id);
        await article.showCurrentArticleIfAvailable();
    }, articleId);
    await page.waitForFunction(async (id) => {
        const panel = await import('/features/article/reading-panel.js');
        return panel.getCurrentArticleId() === id;
    }, articleId, { timeout: 5000 });
    await page.waitForFunction(() => document.querySelectorAll('.interactive-word[data-word="look"]').length === 2, null, { timeout: 5000 });
    await page.waitForTimeout(100);
}

async function closeReadingPanel(page) {
    await page.evaluate(() => {
        const element = document.getElementById('article-reading-panel');
        if (element && !element.classList.contains('hidden')) element.querySelector('.reading-panel-close')?.click();
    });
    await page.waitForFunction(() => {
        const element = document.getElementById('article-reading-panel');
        return !element || element.classList.contains('hidden');
    }, null, { timeout: 5000 });
}

async function openReadingPanel(page) {
    await page.evaluate(() => document.getElementById('article-reading-records-btn')?.click());
    await page.waitForSelector('#article-reading-panel:not(.hidden)', { timeout: 5000 });
}

async function lookMarks(page) {
    return page.locator('.interactive-word[data-word="look"]').evaluateAll((elements) => elements.map((element) => element.classList.contains('reading-mark-active')));
}

async function markSecondLook(page) {
    await page.locator('.interactive-word[data-word="look"]').nth(1).click();
    const markButton = page.locator('#word-analysis-tooltip .btn-toggle-mark');
    await markButton.waitFor({ state: 'visible', timeout: 5000 });
    if ((await markButton.getAttribute('aria-pressed')) !== 'true') {
        await markButton.click();
        await page.waitForFunction(() => {
            const button = document.querySelector('#word-analysis-tooltip .btn-toggle-mark');
            return button?.getAttribute('aria-pressed') === 'true';
        }, null, { timeout: 5000 });
    }
    await page.waitForFunction(() => {
        const words = Array.from(document.querySelectorAll('.interactive-word[data-word="look"]'));
        return words.length === 2
            && !words[0].classList.contains('reading-mark-active')
            && words[1].classList.contains('reading-mark-active');
    }, null, { timeout: 5000 });
}

// P2-T2 把筆記等次要操作收進 details.tooltip-more（預設收起），
// 測試要直接操作 .btn-note-item 前必須先展開，否則元素不可見。
async function openTooltipMore(page) {
    await page.waitForSelector('#word-analysis-tooltip details.tooltip-more', { timeout: 5000 });
    await page.evaluate(() => {
        const details = document.querySelector('#word-analysis-tooltip details.tooltip-more');
        if (details && !details.open) details.open = true;
    });
    await page.waitForSelector('#word-analysis-tooltip details.tooltip-more[open] .btn-note-item', { state: 'visible', timeout: 5000 });
}

async function refreshReadingStores(page) {
    await page.evaluate(async () => {
        const art = await import('/modules/article-store.js');
        const rd = await import('/modules/reading-store.js');
        await art.refreshScope();
        await rd.reloadReadingScope();
    });
}

async function installScopeArticleReadProbe(page) {
    await page.evaluate(() => {
        if (!window.__readProbeOriginalGetAll) {
            window.__readProbeOriginalGetAll = IDBIndex.prototype.getAll;
            window.__scopeArticleReads = [];
            IDBIndex.prototype.getAll = function getAll(...args) {
                if (this.name === 'scope_article') window.__scopeArticleReads.push(args[0]);
                return window.__readProbeOriginalGetAll.apply(this, args);
            };
        }
    });
}

async function resetScopeArticleReads(page) {
    await page.evaluate(() => { window.__scopeArticleReads = []; });
}

async function scopeArticleReads(page) {
    return page.evaluate(() => (window.__scopeArticleReads || []).slice());
}

async function restoreInstrumentation(page) {
    await page.evaluate(() => {
        if (window.__readProbeOriginalGetAll) {
            IDBIndex.prototype.getAll = window.__readProbeOriginalGetAll;
            delete window.__readProbeOriginalGetAll;
        }
        if (window.__holdState?.releaseResolve) window.__holdState.releaseResolve();
        if (window.__holdState?.originalGetAll) IDBIndex.prototype.getAll = window.__holdState.originalGetAll;
    }).catch(() => {});
}

/**
 * 暫停下一次 reading-store 的 scope_article 讀取，讓呼叫端能在補讀完成前
 * 切換文章或帳戶；不是靠 sleep，而是明確等待 IndexedDB request 已發出。
 */
async function beginHeldScopeReload(page) {
    await page.evaluate(async () => {
        const rd = await import('/modules/reading-store.js');
        const originalGetAll = IDBIndex.prototype.getAll;
        let arrivedResolve;
        let releaseResolve;
        const arrived = new Promise((resolve) => { arrivedResolve = resolve; });
        const release = new Promise((resolve) => { releaseResolve = resolve; });
        window.__holdState = { originalGetAll, arrived, release, arrivedResolve, releaseResolve };
        let heldOnce = false;
        IDBIndex.prototype.getAll = function getAll(...args) {
            const request = originalGetAll.apply(this, args);
            if (!heldOnce && this.name === 'scope_article') {
                heldOnce = true;
                const proxy = {
                    get result() { return request.result; },
                    get error() { return request.error; },
                    get readyState() { return request.readyState; },
                    set onsuccess(handler) {
                        request.onsuccess = (event) => {
                            arrivedResolve();
                            release.then(() => handler.call(proxy, event));
                        };
                    },
                    set onerror(handler) {
                        request.onerror = (event) => {
                            arrivedResolve();
                            release.then(() => handler.call(proxy, event));
                        };
                    }
                };
                return proxy;
            }
            return request;
        };
        window.__pendingScopeReload = rd.reloadReadingScope();
    });
    await page.evaluate(() => window.__holdState.arrived);
}

async function finishHeldScopeReload(page) {
    await page.evaluate(async () => {
        if (!window.__holdState) return;
        window.__holdState.releaseResolve();
        try { await window.__pendingScopeReload; } catch (_) {}
        IDBIndex.prototype.getAll = window.__holdState.originalGetAll;
        window.__pendingScopeReload = null;
    });
}

async function runScenario(browser, name, options, body) {
    const context = await browser.newContext({
        viewport: { width: options.width, height: options.height },
        isMobile: options.width < 500,
        hasTouch: options.width < 500
    });
    const pageErrors = [];
    try {
        await context.route('**/*', (route) => {
            const url = new URL(route.request().url());
            if (url.pathname.endsWith('/ai-config.js')) {
                return route.fulfill({
                    contentType: 'application/javascript',
                    body: 'export const SYNC={endpoint:""}; export const TTS_CONFIG={}, AI_LIMITS={}, OCR_CONFIG={}, ARTICLE_IMPORT={}, SUPABASE={};'
                });
            }
            if (url.origin !== BASE) return route.abort();
            return route.continue();
        });
        await context.addInitScript((locale) => {
            try {
                const raw = localStorage.getItem('pen_global_settings');
                const parsed = raw ? JSON.parse(raw) : {};
                parsed.language = { ...(parsed.language || {}), interfaceLocale: locale };
                localStorage.setItem('pen_global_settings', JSON.stringify(parsed));
            } catch (_) {}
        }, options.locale);
        const page = await context.newPage();
        page.on('pageerror', (error) => pageErrors.push(String(error && error.stack ? error.stack.split('\n')[0] : error)));
        await page.goto(BASE, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1000);
        await closeModal(page);
        await navigateToArticle(page);
        await body(page);
        check(`${name} no page errors`, pageErrors.length === 0, pageErrors);
    } catch (error) {
        check(`${name} scenario completed`, false, String(error && error.stack ? error.stack.split('\n')[0] : error));
    } finally {
        try { await restoreInstrumentation(page); } catch (_) {}
        await context.close().catch(() => {});
    }
}

async function scenarioManualMarkRefresh(page) {
    const name = 'mark -> refresh -> underline and panel survive';
    await seedArticles(page, [
        { id: IDS.mark, title: 'Mark refresh' },
        { id: IDS.cold, title: 'Cold lazy', body: COLD_BODY, withResult: false }
    ]);
    await openArticle(page, IDS.mark);
    await markSecondLook(page);
    const item = await page.evaluate(async (articleId) => {
        const rd = await import('/modules/reading-store.js');
        const marked = rd.listLearningItems(articleId).filter((row) => row.marked === true && !row.deletedAt);
        return marked[0] ? { id: marked[0].id, anchor: marked[0].anchor, version: marked[0].contentVersion } : null;
    }, IDS.mark);
    check(`${name}: marked item exists`, !!item, item);

    await openReadingPanel(page);
    await page.waitForSelector(`#article-reading-panel .reading-item[data-item-id="${item.id}"]`, { timeout: 5000 });
    check(`${name}: panel lists marked item`, true);

    await installScopeArticleReadProbe(page);
    const card = page.locator(`.reading-item[data-item-id="${item.id}"]`);
    await card.locator('[data-mark-toggle]').click();
    await page.waitForFunction(async (id) => {
        const rd = await import('/modules/reading-store.js');
        return rd.getLearningItem(id)?.marked === false;
    }, item.id, { timeout: 5000 });
    await page.locator(`.reading-item[data-item-id="${item.id}"] [data-mark-toggle]`).click();
    await page.waitForFunction(async (id) => {
        const rd = await import('/modules/reading-store.js');
        return rd.getLearningItem(id)?.marked === true;
    }, item.id, { timeout: 5000 });
    const normalReads = await scopeArticleReads(page);
    check(`${name}: normal mark events do not reload the article`, normalReads.length === 0, normalReads);

    await resetScopeArticleReads(page);
    await refreshReadingStores(page);
    await page.waitForFunction(() => {
        const words = Array.from(document.querySelectorAll('.interactive-word[data-word="look"]'));
        return words.length === 2
            && !words[0].classList.contains('reading-mark-active')
            && words[1].classList.contains('reading-mark-active');
    }, null, { timeout: 5000 });
    await page.waitForSelector(`#article-reading-panel:not(.hidden) .reading-item[data-item-id="${item.id}"]`, { timeout: 5000 });

    const after = await page.evaluate(async ({ articleId, itemId }) => {
        const rd = await import('/modules/reading-store.js');
        const row = rd.getLearningItem(itemId);
        const items = rd.listLearningItems(articleId).filter((entry) => !entry.deletedAt);
        return {
            row: row ? { marked: row.marked, anchor: row.anchor, version: row.contentVersion, note: row.note } : null,
            count: items.length,
            markedCount: items.filter((entry) => entry.marked === true).length
        };
    }, { articleId: IDS.mark, itemId: item.id });
    const marks = await lookMarks(page);
    const reads = await scopeArticleReads(page);
    check(`${name}: exact second occurrence stays underlined`, marks[0] === false && marks[1] === true, marks);
    check(`${name}: item keeps version and anchor`, after.row
        && after.row.marked === true
        && after.row.version === item.version
        && after.row.anchor?.start === item.anchor?.start
        && after.row.anchor?.end === item.anchor?.end, after);
    check(`${name}: panel item survives refresh`, after.count >= 1 && after.markedCount === 1, after);
    const readArticleIds = reads.map((entry) => entry[1]);
    check(`${name}: refresh reads current article only`, readArticleIds.includes(IDS.mark) && !readArticleIds.includes(IDS.cold), reads);
}

async function scenarioNoteDraftRefresh(page) {
    const name = 'editing note -> refresh -> focus/draft survive';
    await seedArticles(page, [{ id: IDS.note, title: 'Note refresh' }]);
    await openArticle(page, IDS.note);
    await page.locator('.interactive-word[data-word="look"]').nth(1).click();
    await openTooltipMore(page);
    await page.locator('#word-analysis-tooltip .btn-note-item').click();
    await page.waitForSelector('#article-reading-panel:not(.hidden) textarea.reading-note', { timeout: 5000 });
    await page.waitForFunction(() => document.activeElement?.matches('textarea.reading-note'), null, { timeout: 5000 });
    const noteId = await page.evaluate(() => document.activeElement?.getAttribute('data-note-id') || '');
    assert(noteId, 'missing focused note field');
    const noteText = '刷新期間仍保留的筆記草稿';
    const noteBox = page.locator(`textarea[data-note-id="${noteId}"]`);
    await noteBox.fill(noteText);

    await refreshReadingStores(page);
    await page.waitForFunction(async ({ articleId, itemId }) => {
        const rd = await import('/modules/reading-store.js');
        return rd.listLearningItems(articleId).some((item) => item.id === itemId);
    }, { articleId: IDS.note, itemId: noteId }, { timeout: 5000 });
    await page.waitForTimeout(200);

    const during = await page.evaluate((itemId) => ({
        activeId: document.activeElement?.getAttribute('data-note-id') || '',
        activeTag: document.activeElement?.tagName || '',
        value: document.activeElement?.value || '',
        panelVisible: !document.getElementById('article-reading-panel')?.classList.contains('hidden'),
        valueInList: document.querySelector(`textarea[data-note-id="${CSS.escape(itemId)}"]`)?.value || ''
    }), noteId);
    check(`${name}: focus stays in the same note field`, during.activeTag === 'TEXTAREA' && during.activeId === noteId, during);
    check(`${name}: unsaved draft is not overwritten`, during.value === noteText && during.valueInList === noteText, during);
    check(`${name}: panel remains open while editing`, during.panelVisible, during);

    await noteBox.blur();
    await page.waitForFunction(async ({ itemId, text }) => {
        const rd = await import('/modules/reading-store.js');
        return rd.getLearningItem(itemId)?.note === text;
    }, { itemId: noteId, text: noteText }, { timeout: 5000 });
    const saved = await page.evaluate(async (itemId) => {
        const rd = await import('/modules/reading-store.js');
        return rd.getLearningItem(itemId)?.note || '';
    }, noteId);
    check(`${name}: draft still saves after refresh`, saved === noteText, saved);
}

async function scenarioArticleSwitchDuringRefresh(page) {
    const name = 'article switch during refresh -> old marks do not paint';
    await seedArticles(page, [
        { id: IDS.switchA, title: 'Switch A' },
        { id: IDS.switchB, title: 'Switch B', result: { ...RESULT, detailed_analysis: [] } }
    ]);
    await openArticle(page, IDS.switchA);
    await markSecondLook(page);
    await beginHeldScopeReload(page);
    await openArticle(page, IDS.switchB);
    const beforeRelease = await lookMarks(page);
    check(`${name}: new article starts unmarked`, beforeRelease[0] === false && beforeRelease[1] === false, beforeRelease);

    await finishHeldScopeReload(page);
    await page.waitForFunction(async (articleId) => {
        const rd = await import('/modules/reading-store.js');
        return rd.listLearningItems(articleId).length > 0;
    }, IDS.switchA, { timeout: 5000 });
    await page.waitForTimeout(250);
    const after = await page.evaluate(async ({ articleA, articleB }) => {
        const rd = await import('/modules/reading-store.js');
        const panel = await import('/features/article/reading-panel.js');
        return {
            currentArticleId: panel.getCurrentArticleId(),
            aCount: rd.listLearningItems(articleA).length,
            bCount: rd.listLearningItems(articleB).length
        };
    }, { articleA: IDS.switchA, articleB: IDS.switchB });
    const marks = await lookMarks(page);
    check(`${name}: current article is still B`, after.currentArticleId === IDS.switchB, after);
    check(`${name}: old article result never paints on B`, marks[0] === false && marks[1] === false, marks);
    check(`${name}: B has no inherited reading items`, after.bCount === 0, after);
}

async function scenarioScopeSwitchDuringRefresh(page) {
    const name = 'scope switch during refresh -> no old result repaints';
    await seedArticles(page, [{ id: IDS.scope, title: 'Scope switch' }]);
    await openArticle(page, IDS.scope);
    await markSecondLook(page);
    await beginHeldScopeReload(page);

    const switched = await page.evaluate(async ({ articleId, body, result }) => {
        const art = await import('/modules/article-store.js');
        const rd = await import('/modules/reading-store.js');
        const state = await import('/modules/state.js');
        const article = await import('/features/article/article.js');
        const nextScope = `${art.getArticleScope()}::panel-scope-b`;
        await art.reloadScope(nextScope);
        await rd.reloadReadingScope(nextScope);
        document.dispatchEvent(new CustomEvent('bdc:articles-scope-changed'));
        const saved = await art.saveArticle({
            articleId,
            article: body,
            title: 'Scope switch B',
            sourceType: 'paste',
            result
        });
        state.setCurrentArticleId(articleId);
        await article.showCurrentArticleIfAvailable();
        return { saved, scope: rd.getReadingScope(), nextScope };
    }, { articleId: IDS.scope, body: BODY, result: { ...RESULT, detailed_analysis: [] } });
    check(`${name}: scope changed`, switched.saved?.ok === true && switched.scope === switched.nextScope, switched);
    await page.waitForFunction(async (articleId) => {
        const panel = await import('/features/article/reading-panel.js');
        return panel.getCurrentArticleId() === articleId;
    }, IDS.scope, { timeout: 5000 });
    await page.waitForFunction(() => document.querySelectorAll('.interactive-word[data-word="look"]').length === 2, null, { timeout: 5000 });

    await finishHeldScopeReload(page);
    await page.waitForTimeout(300);
    const after = await page.evaluate(async (articleId) => {
        const rd = await import('/modules/reading-store.js');
        return {
            scope: rd.getReadingScope(),
            items: rd.listLearningItems(articleId).length,
            marks: Array.from(document.querySelectorAll('.interactive-word[data-word="look"]'))
                .map((element) => element.classList.contains('reading-mark-active'))
        };
    }, IDS.scope);
    check(`${name}: old scope items are not loaded into new scope`, after.items === 0, after);
    check(`${name}: old marks never repaint on the new-scope article`, after.marks[0] === false && after.marks[1] === false, after);
}

(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: CHROME });
    try {
        const configs = [
            { label: 'desktop', locale: 'zh-CN', width: 1440, height: 960 },
            { label: 'mobile', locale: 'zh-HK', width: 390, height: 844 }
        ];
        const scenarios = [
            ['manual-mark-refresh', scenarioManualMarkRefresh],
            ['note-draft-refresh', scenarioNoteDraftRefresh],
            ['article-switch-refresh', scenarioArticleSwitchDuringRefresh],
            ['scope-switch-refresh', scenarioScopeSwitchDuringRefresh]
        ];
        for (const config of configs) {
            for (const [scenarioName, scenario] of scenarios) {
                await runScenario(browser, `${config.label} ${scenarioName}`, config, scenario);
            }
        }
    } finally {
        await browser.close();
    }
    const failed = checks.filter((item) => !item.pass);
    console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
    if (failed.length) {
        console.log(JSON.stringify(failed, null, 2));
        process.exitCode = 1;
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
