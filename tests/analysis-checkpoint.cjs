/**
 * 文章逐段 checkpoint 與未完成分析續作驗收（P3-T1）。
 *
 * 覆蓋：
 *   a. 10 段完成 5 段後重新載入：譯文仍在、續作 banner 顯示 5/10。
 *   b. 按續作只重送未完成段（以 mock 請求計數斷言），前 5 段不重做。
 *   c. 分析中取消：狀態 cancelled、已完成段保留、重新載入可續作。
 *   d. checkpoint 後修改原文再載入：不顯示續作。
 *   e. checkpoint 保存失敗：顯示提示且分析繼續；最終保存成功後恢復。
 *   f. settings.reading.analysisCheckpoint=false：只在最後保存、無續作 banner。
 *
 * 用法：
 *   PORT=8313 PLAYWRIGHT_MODULE=<path-to-playwright> node tests/analysis-checkpoint.cjs
 *
 * 不連真實 AI／同步端點；每個情境使用獨立 browser context。
 */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const mock = require('./helpers/article-mock.cjs');

const PORT = Number(process.env.PORT || 8313);
const BASE = `http://127.0.0.1:${PORT}/`;

const { check, finish } = mock.createReporter('文章逐段 checkpoint 與續作');

function buildParagraphs(prefix, count = 10) {
    return Array.from({ length: count }, (_, i) => (
        `${prefix}${i + 1}MARK keeps the reading room quiet for paragraph ${i + 1}.`
    ));
}

function buildBody(prefix, count = 10) {
    return buildParagraphs(prefix, count).join('\n\n');
}

/** 每個情境獨立 context：storage、IndexedDB、mock 計數互不污染。 */
async function setupScenario(browser, prefix) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await mock.initScript(context);
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error && error.message ? error.message : error)));
    const state = {
        prefix,
        paragraphCalls: 0,
        callsBy: new Map(),
        delays: new Map()
    };
    const markerRe = new RegExp(`${prefix}(\\d+)MARK`);
    await mock.installProviderRoutes(page, async ({ route, prompt }) => {
        if (/Target word:\s*"/.test(prompt)) {
            return mock.jsonReply(route, { word: 'word', sentence: '', analysis: { phonetic: '', pos: 'noun', meaning: '測試意思', role: '' } });
        }
        const marker = prompt.match(markerRe);
        if (!marker) return mock.jsonReply(route, mock.translatedParagraphReply(prompt, 'T'));
        const index = Number(marker[1]) - 1;
        state.paragraphCalls += 1;
        state.callsBy.set(index, (state.callsBy.get(index) || 0) + 1);
        const delay = state.delays.get(index) || 0;
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        return mock.jsonReply(route, mock.translatedParagraphReply(prompt, `${prefix}ZH${index + 1}-`));
    });
    await page.goto(BASE + '#a', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    await dismissStartupModal(page);
    return { context, page, state, pageErrors };
}

/** 首次啟動的「開始之前」提示會擋住按鈕；測試只需要關掉它。 */
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
        await page.waitForTimeout(200);
    } catch (_) { /* 沒有 modal 也沒關係 */ }
}

async function startAnalysis(page, body) {
    await page.fill('#article-input', body);
    await page.dispatchEvent('#article-input', 'input');
    await page.click('#analyze-article-btn');
}

async function rowStatuses(page) {
    return page.evaluate(() => Array.from(
        document.querySelectorAll('#article-analysis-container .paragraph-pair .para-status')
    ).map((row) => ({
        status: row.dataset.status || '',
        reason: row.querySelector('.para-reason')?.textContent?.trim() || ''
    })));
}

/** 等 checkpoint 真的落盤（不是只看畫面完成數）。 */
async function waitForRunningCheckpoint(page, marker, minCompleted, timeout = 20000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        const info = await recordInfo(page, marker);
        const run = info?.run;
        if (run && run.status === 'running' && Number(run.completed) >= minCompleted) return true;
        await page.waitForTimeout(300);
    }
    return false;
}

async function waitRowsDone(page, count, timeout = 40000) {
    try {
        await page.waitForFunction((target) => {
            const rows = Array.from(document.querySelectorAll('#article-analysis-container .paragraph-pair .para-status'));
            return rows.length >= target && rows.slice(0, target).every((row) => row.dataset.status === 'done');
        }, count, { timeout });
        return true;
    } catch (_) {
        return false;
    }
}

async function recordInfo(page, marker) {
    return page.evaluate(async (text) => {
        const store = await import('/modules/article-store.js');
        const record = store.getRecords().find((item) => String(item.article || '').includes(text));
        if (!record) return null;
        return {
            id: record.articleId,
            body: record.article,
            run: record.result?.analysis_run || null,
            translations: (record.result?.paragraph_analysis || []).map((item) => (
                item === null || item === undefined ? null : String(item.chinese_translation || '')
            ))
        };
    }, marker);
}

async function openRecordById(page, articleId) {
    await page.click('#article-history-btn');
    await page.waitForTimeout(350);
    await page.click(`.ar-history-item[data-key="${articleId}"] .ar-history-open`);
    await page.waitForTimeout(600);
}

async function bannerState(page) {
    return page.evaluate(() => {
        const banner = document.getElementById('article-analysis-resume');
        const note = document.getElementById('article-checkpoint-note');
        const resume = document.getElementById('resume-analysis-btn');
        const visible = !!banner && !banner.classList.contains('hidden');
        return {
            visible,
            status: document.getElementById('article-analysis-resume-status')?.textContent?.trim() || '',
            hint: banner?.querySelector('[data-i18n="article.checkpointResumeHint"]')?.textContent?.trim() || '',
            resumeVisible: visible && !!resume && resume.getBoundingClientRect().height > 0,
            noteVisible: !!note && !note.classList.contains('hidden'),
            noteText: note?.textContent?.trim() || ''
        };
    });
}

async function tInPage(page, key, params) {
    return page.evaluate(async ({ key: k, params: p }) => {
        const mod = await import('/modules/i18n.js');
        return p ? mod.t(k, p) : mod.t(k);
    }, { key, params: params || null });
}

// ─────────────────────────────────────────────────────────────────────────────
// a + b：checkpoint 後重新載入、續作只跑未完成段
// ─────────────────────────────────────────────────────────────────────────────
async function scenarioCheckpointThenResume(browser) {
    console.log('\n[情境 a/b] 完成 5 段 checkpoint → 重新載入 → 續作');
    const { context, page, state } = await setupScenario(browser, 'CA');
    const body = buildBody('CA', 10);
    // 第 6 段之後全部延遲：併發 2 的下一段不會提前完成，checkpoint 可以穩定停在 5/10。
    for (let index = 5; index < 10; index += 1) state.delays.set(index, 6000);
    await startAnalysis(page, body);

    const doneFive = await waitRowsDone(page, 5);
    check('a 前 5 段完成', doneFive, JSON.stringify(await rowStatuses(page)));

    // debounce 1200ms：等 checkpoint 真的落盤，而不是只等固定秒數。
    const checkpointReady = await waitForRunningCheckpoint(page, 'CA1MARK', 5);
    check('a 等 checkpoint 落盤', checkpointReady, JSON.stringify(await recordInfo(page, 'CA1MARK')));
    const beforeReload = await recordInfo(page, 'CA1MARK');
    check('a checkpoint 寫入 analysis_run(running)', !!beforeReload?.run && beforeReload.run.status === 'running', JSON.stringify(beforeReload?.run));
    check('a checkpoint 已保存 5 段（completed=5）', beforeReload?.run?.completed === 5 && beforeReload?.run?.total === 10, JSON.stringify(beforeReload?.run));
    check('a checkpoint 保留 total 長度陣列且未完成段為 null', Array.isArray(beforeReload?.translations)
        && beforeReload.translations.length === 10
        && beforeReload.translations.slice(0, 5).every((text) => !!text)
        && beforeReload.translations.slice(5).every((text) => text === null), JSON.stringify(beforeReload?.translations));

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1600);
    await dismissStartupModal(page);
    if (!beforeReload?.id) {
        check('a 取得文章 ID', false, 'record missing');
        await context.close();
        return;
    }
    await openRecordById(page, beforeReload.id);

    const afterReload = await recordInfo(page, 'CA1MARK');
    check('a 重新載入後 5 段譯文仍在', !!afterReload
        && afterReload.translations.length === 10
        && afterReload.translations.slice(0, 5).every((text) => !!text)
        && afterReload.translations.slice(5).every((text) => text === null), JSON.stringify(afterReload?.translations));
    const rowsAfterReload = await rowStatuses(page);
    check('a 未完成段顯示 pending，不當成失敗', rowsAfterReload.length === 10
        && rowsAfterReload.slice(0, 5).every((row) => row.status === 'done')
        && rowsAfterReload.slice(5).every((row) => row.status === 'pending'), JSON.stringify(rowsAfterReload));
    const banner = await bannerState(page);
    const partialText = await tInPage(page, 'article.analysisPartial', { done: 5, total: 10 });
    check('a 續作 banner 顯示 5/10', banner.visible && banner.status.includes(partialText), JSON.stringify(banner));
    check('a 續作按鈕存在', banner.resumeVisible, JSON.stringify(banner));

    // 續作本身不需要再等延遲；清掉 mock 延遲，只驗證請求數與不重做。
    state.delays.clear();
    const callsBeforeResume = state.paragraphCalls;
    const callsByBefore = new Map(state.callsBy);
    await page.click('#resume-analysis-btn');
    const doneAll = await waitRowsDone(page, 10);
    check('b 續作完成全部 10 段', doneAll, JSON.stringify(await rowStatuses(page)));
    check('b 畫面 10 段都有譯文', (await recordInfo(page, 'CA1MARK'))?.translations.slice(0, 10).every((text) => !!text) === true, JSON.stringify((await recordInfo(page, 'CA1MARK'))?.translations));
    await page.waitForTimeout(900);

    const resumeCalls = state.paragraphCalls - callsBeforeResume;
    const redone = [0, 1, 2, 3, 4].filter((index) => (state.callsBy.get(index) || 0) !== (callsByBefore.get(index) || 0));
    const resumed = [5, 6, 7, 8, 9].filter((index) => (state.callsBy.get(index) || 0) > (callsByBefore.get(index) || 0));
    check('b 續作只送出 5 個段落請求', resumeCalls === 5, String(resumeCalls));
    check('b 前 5 段不重做', redone.length === 0, JSON.stringify(redone));
    check('b 後 5 段各送一次', resumed.length === 5, JSON.stringify(resumed));

    const finalInfo = await recordInfo(page, 'CA1MARK');
    check('b 續作後 analysis_run=complete', finalInfo?.run?.status === 'complete' && finalInfo?.run?.completed === 10, JSON.stringify(finalInfo?.run));
    const finalBanner = await bannerState(page);
    check('b 完成後不再顯示續作 banner', finalBanner.visible === false, JSON.stringify(finalBanner));

    // 完成後再按清除：不得把已完成的 analysis_run 蓋成 cancelled。
    await page.click('#clear-article-btn');
    await page.waitForTimeout(900);
    const afterClear = await recordInfo(page, 'CA1MARK');
    check('b 完成後清除不把 analysis_run 改成 cancelled', afterClear?.run?.status === 'complete', JSON.stringify(afterClear?.run));

    await context.close();
}

// ─────────────────────────────────────────────────────────────────────────────
// c：分析中取消 → cancelled 保留已完成段 → 可續作
// ─────────────────────────────────────────────────────────────────────────────
async function scenarioCancelKeepsCompleted(browser) {
    console.log('\n[情境 c] 分析到第 3 段取消');
    const { context, page, state } = await setupScenario(browser, 'CB');
    const body = buildBody('CB', 10);
    for (let index = 3; index < 10; index += 1) state.delays.set(index, 9000);
    await startAnalysis(page, body);

    const doneThree = await waitRowsDone(page, 3, 25000);
    check('c 前 3 段完成', doneThree, JSON.stringify(await rowStatuses(page)));
    // 取消入口：清除／重寫會中止目前分析（既有 UI，不新增按鈕）。
    await page.click('#clear-article-btn');
    await page.waitForTimeout(1200);

    const cancelledInfo = await recordInfo(page, 'CB1MARK');
    check('c 取消後 analysis_run=cancelled', cancelledInfo?.run?.status === 'cancelled', JSON.stringify(cancelledInfo?.run));
    check('c 取消後保留 3 段', cancelledInfo?.run?.completed === 3
        && cancelledInfo.translations.slice(0, 3).every((text) => !!text), JSON.stringify(cancelledInfo?.translations));
    check('c 取消後不把未完成段當失敗', cancelledInfo.translations.slice(3).every((text) => text === null), JSON.stringify(cancelledInfo?.translations));

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1600);
    await dismissStartupModal(page);
    await openRecordById(page, cancelledInfo.id);
    const banner = await bannerState(page);
    const partialText = await tInPage(page, 'article.analysisPartial', { done: 3, total: 10 });
    check('c 重新載入可續作（顯示 3/10）', banner.visible && banner.status.includes(partialText) && banner.resumeVisible, JSON.stringify(banner));
    await context.close();
}

// ─────────────────────────────────────────────────────────────────────────────
// d：checkpoint 後修改原文 → 不顯示續作
// ─────────────────────────────────────────────────────────────────────────────
async function scenarioVersionMismatchHidesResume(browser) {
    console.log('\n[情境 d] checkpoint 後原文改版');
    const { context, page, state } = await setupScenario(browser, 'CC');
    const body = buildBody('CC', 10);
    for (let index = 5; index < 10; index += 1) state.delays.set(index, 6000);
    await startAnalysis(page, body);
    const doneFive = await waitRowsDone(page, 5);
    check('d 前 5 段完成', doneFive, JSON.stringify(await rowStatuses(page)));
    const checkpointReady = await waitForRunningCheckpoint(page, 'CC1MARK', 5);
    check('d 等 checkpoint 落盤', checkpointReady, JSON.stringify(await recordInfo(page, 'CC1MARK')));
    const beforeEdit = await recordInfo(page, 'CC1MARK');
    check('d 編輯前存在 running checkpoint', beforeEdit?.run?.status === 'running', JSON.stringify(beforeEdit?.run));

    // 以 article-store 保存修改後的正文（等同重新分析前的版本前進），保留舊分析。
    await page.evaluate(async ({ id, body: oldBody }) => {
        const store = await import('/modules/article-store.js');
        const record = store.getRecord(id);
        await store.saveArticle({
            articleId: id,
            article: `${oldBody}\n\nCC11MARK appended after checkpoint.`,
            result: record?.result || null,
            title: record?.title || '',
            sourceType: record?.sourceType || 'paste',
            sourceUrl: record?.sourceUrl || ''
        });
    }, { id: beforeEdit.id, body });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1600);
    await dismissStartupModal(page);
    await openRecordById(page, beforeEdit.id);
    const banner = await bannerState(page);
    check('d 原文改版後不顯示續作 banner', banner.visible === false, JSON.stringify(banner));
    await context.close();
}

// ─────────────────────────────────────────────────────────────────────────────
// e：checkpoint 保存失敗 → 明示但不中斷；最終保存成功後恢復
// ─────────────────────────────────────────────────────────────────────────────
async function scenarioCheckpointFailure(browser) {
    console.log('\n[情境 e] checkpoint 保存失敗');
    const { context, page, state } = await setupScenario(browser, 'CD');
    const body = buildBody('CD', 6);
    for (let index = 2; index < 6; index += 1) state.delays.set(index, 2600);

    await page.evaluate(() => {
        const proto = IDBObjectStore.prototype;
        const original = proto.put;
        window.__ckptFail = true;
        window.__ckptFailCount = 0;
        proto.put = function putWithCheckpointFailure(...args) {
            const doc = args[0];
            if (this.name === 'docs' && window.__ckptFail && doc?.analysis?.analysis_run?.status === 'running') {
                const paragraphs = doc.analysis.paragraph_analysis;
                const hasDone = Array.isArray(paragraphs) && paragraphs.some((item) => item && item.chinese_translation);
                if (hasDone) {
                    window.__ckptFailCount += 1;
                    try { this.transaction.abort(); } catch (_) { /* noop */ }
                    throw new DOMException('injected checkpoint save failure', 'AbortError');
                }
            }
            return original.apply(this, args);
        };
    });

    await startAnalysis(page, body);
    let noteVisible = false;
    try {
        await page.waitForFunction(() => {
            const note = document.getElementById('article-checkpoint-note');
            return !!note && !note.classList.contains('hidden') && note.textContent.trim().length > 0;
        }, null, { timeout: 20000 });
        noteVisible = true;
    } catch (_) { /* 下方 check 會回報 */ }
    const banner = await bannerState(page);
    const expectedNote = await tInPage(page, 'article.analysisCheckpointFailed');
    const failCount = await page.evaluate(() => Number(window.__ckptFailCount || 0));
    check('e checkpoint 保存失敗顯示提示', noteVisible && banner.noteVisible && banner.noteText.includes(expectedNote), JSON.stringify(banner));
    check('e 失敗原因確實來自 checkpoint 寫入', failCount >= 1, String(failCount));

    // 放行後續保存：分析仍在跑，應能完成；最後保存成功要清掉提示。
    await page.evaluate(() => { window.__ckptFail = false; });
    const doneAll = await waitRowsDone(page, 6);
    check('e checkpoint 失敗不中斷分析', doneAll, JSON.stringify(await rowStatuses(page)));
    await page.waitForTimeout(900);

    const finalBanner = await bannerState(page);
    const finalInfo = await recordInfo(page, 'CD1MARK');
    check('e 最終保存成功後清除 checkpoint 失敗提示', finalBanner.noteVisible === false, JSON.stringify(finalBanner));
    check('e 最終保存 analysis_run=complete', finalInfo?.run?.status === 'complete' && finalInfo?.run?.completed === 6, JSON.stringify(finalInfo?.run));
    await context.close();
}

// ─────────────────────────────────────────────────────────────────────────────
// f：settings.reading.analysisCheckpoint=false → 只在最後保存
// ─────────────────────────────────────────────────────────────────────────────
async function scenarioCheckpointDisabled(browser) {
    console.log('\n[情境 f] 關閉 settings.reading.analysisCheckpoint');
    const { context, page } = await setupScenario(browser, 'CE');
    await page.evaluate(async () => {
        const settings = await import('/modules/settings.js');
        settings.saveGlobalSettings({ reading: { analysisCheckpoint: false } });
        const proto = IDBObjectStore.prototype;
        const original = proto.put;
        window.__ckptWrites = 0;
        proto.put = function countCheckpointWrites(...args) {
            const doc = args[0];
            if (this.name === 'docs' && doc?.analysis?.analysis_run?.status === 'running') {
                const paragraphs = doc.analysis.paragraph_analysis;
                if (Array.isArray(paragraphs) && paragraphs.some((item) => item && item.chinese_translation)) {
                    window.__ckptWrites += 1;
                }
            }
            return original.apply(this, args);
        };
    });

    const body = buildBody('CE', 4);
    await startAnalysis(page, body);
    const doneAll = await waitRowsDone(page, 4);
    check('f 關閉 checkpoint 後分析完成', doneAll, JSON.stringify(await rowStatuses(page)));
    await page.waitForTimeout(800);

    const info = await recordInfo(page, 'CE1MARK');
    const banner = await bannerState(page);
    const checkpointWrites = await page.evaluate(() => Number(window.__ckptWrites || 0));
    check('f 不寫入 analysis_run', !info?.run, JSON.stringify(info?.run));
    check('f 分析中沒有任何 checkpoint 寫入', checkpointWrites === 0, String(checkpointWrites));
    check('f 完成後無續作 banner', banner.visible === false, JSON.stringify(banner));

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    await dismissStartupModal(page);
    await openRecordById(page, info.id);
    const reloadedBanner = await bannerState(page);
    check('f 重新載入仍無續作 banner', reloadedBanner.visible === false, JSON.stringify(reloadedBanner));
    await context.close();
}

(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: mock.CHROME });
    try {
        await scenarioCheckpointThenResume(browser);
        await scenarioCancelKeepsCompleted(browser);
        await scenarioVersionMismatchHidesResume(browser);
        await scenarioCheckpointFailure(browser);
        await scenarioCheckpointDisabled(browser);
    } catch (error) {
        console.error(error && error.stack ? error.stack : error);
        check('腳本未拋出例外', false, String(error && error.message ? error.message : error));
    } finally {
        await browser.close();
    }
    const failures = finish();
    process.exit(failures ? 1 : 0);
})();
