/**
 * 文章分析可靠性驗收（P0-T1 載具；Phase 1 之後必須全綠）。
 *
 * 覆蓋：
 *   - 歷史記錄的失敗段／批次重試按鈕與逐段入口
 *   - 空 JSON／空譯文不得閃成功，也不得被算成成功
 *   - 批次重試真的送出請求、結果落盤，重新載入後仍在
 *   - 401／429／500／網路中斷的失敗原因與可重試入口
 *   - 分析取消後按鈕還原，取消不算失敗
 *   - 中文原文／純圖片段顯示 skipped 且不計入失敗
 *   - 重試中切換文章／刪除文章不覆寫、不復活
 *   - 保存失敗（容量上限）不閃成功，仍可重試
 *   - 查詞去重，空 meaning 不算成功且可重試
 *
 * 用法：
 *   PORT=8313 PLAYWRIGHT_MODULE=<path-to-playwright> node tests/article-reliability.cjs
 *
 * 不連真實 AI／同步端點；每次使用獨立 browser context。
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const mock = require('./helpers/article-mock.cjs');

const PORT = Number(process.env.PORT || 8313);
const BASE = `http://127.0.0.1:${PORT}/`;
const FIXTURES = path.join(__dirname, 'fixtures', 'article');
const TEN_PARAGRAPHS = fs.readFileSync(path.join(FIXTURES, 'ten-paragraphs.md'), 'utf8');

const THREE_PARAGRAPHS = [
    'The library opens early on weekdays.',
    'Readers leave their coats beside the door.',
    'A short walk from the station leads to the reading room.'
].join('\n\n');

// 新回歸情境專用文章：不與其他情境共用正文（避免 API 快取撞在一起）。
const RACE_PARAGRAPHS = [
    'RACE first paragraph opens the archive quietly.',
    'RACE second paragraph keeps the reading list.',
    'RACE third paragraph closes the heavy door.'
].join('\n\n');

// F3／F5 專用文章：F3 驗最後保存失敗，F5 驗歷史失敗段的錯誤碼 metadata。
const F3_BODY = 'F3 first paragraph is ready.\n\nF3 second paragraph is also ready.';
const F3_EDITED = 'F3 first paragraph is ready.\n\nF3 second paragraph was edited before analysis.';
const F5_BODY = 'F5 first paragraph needs a key.\n\nF5 second paragraph is fine.';

const { check, finish } = mock.createReporter('文章分析可靠性');

/** 目前 mock 行為；由各情境改寫。 */
const ai = {
    kind: 'ok',            // ok | emptyJson | status | abort
    status: 500,
    delayMs: 0,
    calls: 0,
    // 指定含此標記的段落一律回空結果（含 fallback 請求），避免靠呼叫次序猜段落
    emptyFor: '',
    // 單詞查詢（article.wordTooltip）的行為：ok | empty
    wordMode: 'ok',
    wordCalls: 0,
    // 指定段落的分次回應：marker -> { calls, steps: [{ delayMs, marker, empty, abort }] }
    plans: new Map()
};
const PARAGRAPH_MARKERS = {
    p0: 'RACE first paragraph',
    p1: 'RACE second paragraph',
    p2: 'RACE third paragraph'
};

(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: mock.CHROME });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await mock.initScript(context);
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error && error.message ? error.message : error)));

    await mock.installProviderRoutes(page, async ({ route, prompt }) => {
        ai.calls += 1;
        if (ai.delayMs) await new Promise((resolve) => setTimeout(resolve, ai.delayMs));
        if (ai.kind === 'abort') return route.abort('connectionaborted');
        if (ai.kind === 'status') return mock.httpError(route, ai.status);
        if (ai.kind === 'emptyJson') return mock.jsonReply(route, '{}');
        if (/Target word:\s*"/.test(prompt)) {
            ai.wordCalls += 1;
            const word = (prompt.match(/Target word:\s*"([^"]+)"/) || [])[1] || 'word';
            const meaning = ai.wordMode === 'empty' ? '' : '測試意思';
            return mock.jsonReply(route, {
                word,
                sentence: '',
                analysis: { phonetic: 'test', pos: 'noun', meaning, role: '主語' }
            });
        }
        // 指定段落的分次（可延遲）回應：用來重現同段落亂序完成。
        for (const [marker, plan] of ai.plans) {
            if (!prompt.includes(marker)) continue;
            plan.calls = (plan.calls || 0) + 1;
            const step = plan.steps[Math.min(plan.calls, plan.steps.length) - 1] || {};
            if (step.delayMs) await new Promise((resolve) => setTimeout(resolve, step.delayMs));
            if (step.abort) return route.abort('connectionaborted');
            if (step.empty) return mock.jsonReply(route, mock.emptyParagraphReply(prompt));
            return mock.jsonReply(route, mock.translatedParagraphReply(prompt, step.marker || '譯句'));
        }
        if (ai.emptyFor && prompt.includes(ai.emptyFor)) {
            return mock.jsonReply(route, mock.emptyParagraphReply(prompt));
        }
        return mock.jsonReply(route, mock.translatedParagraphReply(prompt));
    });

    await page.goto(BASE + '#a', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);

    await mock.seedDocs(page, [
        {
            id: 'art_fail',
            title: 'Failed paragraphs',
            body: THREE_PARAGRAPHS,
            analysis: {
                chinese_translation: '',
                word_alignment: [],
                detailed_analysis: [],
                paragraph_analysis: [
                    { chinese_translation: '', word_alignment: [], detailed_analysis: [] },
                    { chinese_translation: '', word_alignment: [], detailed_analysis: [] },
                    { chinese_translation: '', word_alignment: [], detailed_analysis: [] }
                ],
                sentence_analysis: [],
                phrase_analysis: []
            },
            sourceType: 'paste',
            revision: 0,
            createdAt: '2026-10-01T00:00:00.000Z',
            updatedAt: '2026-10-01T00:00:00.000Z',
            lastOpenedAt: '2026-10-18T08:00:00.000Z'
        },
        {
            id: 'art_beta',
            title: 'Beta article',
            body: 'BETA second article keeps its own text.\n\nIt must not receive the first article result.',
            analysis: null,
            sourceType: 'paste',
            revision: 0,
            createdAt: '2026-10-04T00:00:00.000Z',
            updatedAt: '2026-10-04T00:00:00.000Z',
            lastOpenedAt: '2026-10-18T05:00:00.000Z'
        },
        {
            id: 'art_too_large',
            title: 'Too large to save',
            body: 'The first paragraph fails.\n\nThe second paragraph is fine.',
            analysis: {
                chinese_translation: '第二段。',
                word_alignment: [],
                detailed_analysis: [],
                paragraph_analysis: [
                    { chinese_translation: '', word_alignment: [], detailed_analysis: [] },
                    { chinese_translation: '第二段。', word_alignment: [], detailed_analysis: [] }
                ],
                // 讓分析結果本身超過 ARTICLE_LIMITS.maxArticleBytes：
                // saveAnalysis 會回 article_too_large，畫面不得閃成功。
                sentence_analysis: [{ sentence: 'The second paragraph is fine.', translation: 'x'.repeat(900000) }],
                phrase_analysis: []
            },
            sourceType: 'paste',
            revision: 0,
            createdAt: '2026-10-03T00:00:00.000Z',
            updatedAt: '2026-10-03T00:00:00.000Z',
            lastOpenedAt: '2026-10-18T06:00:00.000Z'
        },
        {
            id: 'art_ten',
            title: 'Ten paragraphs',
            body: TEN_PARAGRAPHS,
            analysis: null,
            sourceType: 'paste',
            revision: 0,
            createdAt: '2026-10-02T00:00:00.000Z',
            updatedAt: '2026-10-02T00:00:00.000Z',
            lastOpenedAt: '2026-10-18T07:00:00.000Z'
        },
        {
            id: 'art_race',
            title: 'Race paragraphs',
            body: RACE_PARAGRAPHS,
            analysis: {
                chinese_translation: '',
                word_alignment: [],
                detailed_analysis: [],
                paragraph_analysis: [
                    { chinese_translation: '', word_alignment: [], detailed_analysis: [] },
                    { chinese_translation: '', word_alignment: [], detailed_analysis: [] },
                    { chinese_translation: '', word_alignment: [], detailed_analysis: [] }
                ],
                sentence_analysis: [],
                phrase_analysis: []
            },
            sourceType: 'paste',
            revision: 0,
            createdAt: '2026-10-05T00:00:00.000Z',
            updatedAt: '2026-10-05T00:00:00.000Z',
            lastOpenedAt: '2026-10-18T04:00:00.000Z'
        },
        {
            id: 'art_f2_b',
            title: 'F2 second article',
            body: 'F2-B first paragraph keeps its own translation.\n\nF2-B second paragraph must not change.',
            analysis: {
                chinese_translation: 'F2-B 第一段譯文。\n\nF2-B 第二段譯文。',
                word_alignment: [],
                detailed_analysis: [],
                paragraph_analysis: [
                    { chinese_translation: 'F2-B 第一段譯文。', word_alignment: [], detailed_analysis: [] },
                    { chinese_translation: 'F2-B 第二段譯文。', word_alignment: [], detailed_analysis: [] }
                ],
                sentence_analysis: [],
                phrase_analysis: []
            },
            sourceType: 'paste',
            revision: 0,
            createdAt: '2026-10-05T12:00:00.000Z',
            updatedAt: '2026-10-05T12:00:00.000Z',
            lastOpenedAt: '2026-10-18T01:00:00.000Z'
        },
        {
            id: 'art_f3',
            title: 'F3 final save failure',
            body: F3_BODY,
            analysis: {
                chinese_translation: '',
                word_alignment: [],
                detailed_analysis: [],
                paragraph_analysis: [
                    { chinese_translation: '', word_alignment: [], detailed_analysis: [] },
                    { chinese_translation: '', word_alignment: [], detailed_analysis: [] }
                ],
                sentence_analysis: [],
                phrase_analysis: []
            },
            sourceType: 'paste',
            revision: 0,
            createdAt: '2026-10-06T00:00:00.000Z',
            updatedAt: '2026-10-06T00:00:00.000Z',
            lastOpenedAt: '2026-10-18T03:00:00.000Z'
        },
        {
            id: 'art_f5',
            title: 'F5 historical auth failure',
            body: F5_BODY,
            analysis: {
                chinese_translation: '',
                word_alignment: [],
                detailed_analysis: [],
                paragraph_analysis: [
                    { failed: true, errorCode: 'provider_auth_failed', chinese_translation: '', word_alignment: [], detailed_analysis: [] },
                    { chinese_translation: '第二段已完成。', word_alignment: [], detailed_analysis: [] }
                ],
                sentence_analysis: [],
                phrase_analysis: []
            },
            sourceType: 'paste',
            revision: 0,
            createdAt: '2026-10-07T00:00:00.000Z',
            updatedAt: '2026-10-07T00:00:00.000Z',
            lastOpenedAt: '2026-10-18T02:00:00.000Z'
        }
    ]);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);

    const tInPage = (key, params) => page.evaluate(async ({ key, params }) => {
        const mod = await import('/modules/i18n.js');
        return mod.t(key, params);
    }, { key, params });
    const setLocale = (locale) => page.evaluate(async (loc) => {
        const mod = await import('/modules/i18n.js');
        mod.setLocale(loc);
    }, locale);

    const watchFlash = () => page.evaluate(() => {
        window.__flashSeen = 0;
        window.__flashMo?.disconnect?.();
        const root = document.getElementById('article-analysis-container');
        const mo = new MutationObserver(() => {
            if (!document.querySelector('#article-analysis-container .is-flash')) return;
            window.__flashSeen += 1;
        });
        mo.observe(root, { attributes: true, subtree: true, attributeFilter: ['class'] });
        window.__flashMo = mo;
    });
    const flashSeen = () => page.evaluate(() => window.__flashSeen || 0);

    // 429／5xx 會走 api.js 的內部重試（指數退避），單段可能要 15–40 秒才落定。
    const waitParagraphSettled = async (index, timeout = 60000) => {
        await page.waitForFunction((idx) => {
            const el = document.querySelector(`.paragraph-pair[data-paragraph-index="${idx}"] .para-status`);
            return !!el && el.dataset.status !== 'pending';
        }, index, { timeout });
        await page.waitForTimeout(150);
    };
    const waitBatchSettled = async (timeout = 25000) => {
        await page.waitForFunction(() => {
            const btn = document.getElementById('retry-failed-paragraphs-btn');
            if (!btn) return true;
            return btn.getAttribute('aria-busy') !== 'true';
        }, null, { timeout });
        await page.waitForTimeout(250);
    };
    const statusOf = (index) => page.evaluate((idx) => {
        const row = document.querySelector(`.paragraph-pair[data-paragraph-index="${idx}"] .para-status`);
        if (!row) return null;
        return {
            status: row.dataset.status || '',
            text: row.querySelector('.status-text')?.textContent?.trim() || '',
            reason: row.querySelector('.para-reason')?.textContent?.trim() || '',
            retryVisible: (() => {
                const btn = row.querySelector('.retry-paragraph-btn');
                return !!btn && btn.style.display !== 'none' && !btn.classList.contains('hidden');
            })()
        };
    }, index);
    const batchState = () => page.evaluate(() => {
        const btn = document.getElementById('retry-failed-paragraphs-btn');
        const badge = document.getElementById('retry-failed-count');
        return {
            exists: !!btn,
            hidden: !btn || btn.classList.contains('hidden'),
            ariaBusy: btn ? btn.getAttribute('aria-busy') : null,
            ariaLabel: btn ? (btn.getAttribute('aria-label') || '') : '',
            count: badge ? Number(badge.textContent.trim()) : -1
        };
    });
    /** 把指定段落退回「沒有譯文」的失敗狀態，並重新載入記錄頁。 */
    const resetParagraphs = async (indexes, articleId = 'art_fail') => {
        await page.evaluate(async ({ articleId, indexes }) => {
            const mod = await import('/modules/article-store.js');
            const loaded = await mod.ensureArticleLoaded(articleId);
            const record = loaded || mod.getRecord(articleId);
            const next = (record.result.paragraph_analysis || []).map((item) => ({ ...item }));
            indexes.forEach((i) => {
                next[i] = { chinese_translation: '', word_alignment: [], detailed_analysis: [] };
            });
            await mod.saveAnalysis(articleId, { ...record.result, paragraph_analysis: next });
        }, { articleId, indexes });
        // 清掉 modules/api.js 的持久段落快取，讓 mock 的回應成為唯一來源
        await page.evaluate(async () => {
            await new Promise((resolve) => {
                const req = indexedDB.deleteDatabase('bdc-cache');
                req.onsuccess = req.onerror = req.onblocked = () => resolve();
            });
        });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1500);
        await mock.openRecord(page, articleId);
    };

    /** 只改記憶體與磁碟的段落結果，不重載頁面（保留其他文章已載入的全文）。 */
    const resetParagraphsInPlace = async (indexes, articleId = 'art_fail') => {
        await page.evaluate(async ({ articleId, indexes }) => {
            const mod = await import('/modules/article-store.js');
            const loaded = await mod.ensureArticleLoaded(articleId);
            const record = loaded || mod.getRecord(articleId);
            const next = (record.result.paragraph_analysis || []).map((item) => ({ ...item }));
            indexes.forEach((i) => {
                next[i] = { chinese_translation: '', word_alignment: [], detailed_analysis: [] };
            });
            await mod.saveAnalysis(articleId, { ...record.result, paragraph_analysis: next });
        }, { articleId, indexes });
        await page.evaluate(async () => {
            await new Promise((resolve) => {
                const req = indexedDB.deleteDatabase('bdc-cache');
                req.onsuccess = req.onerror = req.onblocked = () => resolve();
            });
        });
        await mock.openRecord(page, articleId);
    };

    /** 佔住 docs 的 readwrite 交易，讓後續保存排隊；releaseDocsWrites 之後才提交。 */
    const holdDocsWrites = () => page.evaluate(() => new Promise((resolve, reject) => {
        const req = indexedDB.open('bdc-articles');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
            const db = req.result;
            const tx = db.transaction('docs', 'readwrite');
            const store = tx.objectStore('docs');
            let stopped = false;
            const loop = () => {
                if (stopped) return;
                const get = store.get('__bdc_hold__');
                get.onsuccess = () => loop();
                get.onerror = () => {};
            };
            tx.oncomplete = () => { try { db.close(); } catch (_) {} };
            tx.onabort = () => { try { db.close(); } catch (_) {} };
            window.__releaseDocsHold = () => { stopped = true; };
            loop();
            resolve(true);
        };
    }));
    const releaseDocsWrites = async () => {
        await page.evaluate(() => { window.__releaseDocsHold?.(); });
        await page.waitForTimeout(250);
    };
    const viewFingerprint = () => page.evaluate(() => {
        const batch = document.getElementById('retry-failed-paragraphs-btn');
        return {
            body: document.getElementById('article-input')?.value || '',
            pairs: Array.from(document.querySelectorAll('#article-analysis-container .paragraph-pair')).map((pair) => ({
                index: pair.getAttribute('data-paragraph-index'),
                english: pair.querySelector('.paragraph-english')?.textContent?.trim() || '',
                chinese: pair.querySelector('.paragraph-chinese')?.textContent?.trim() || '',
                status: pair.querySelector('.para-status')?.dataset.status || '',
                reason: pair.querySelector('.para-reason')?.textContent?.trim() || ''
            })),
            batch: {
                hidden: !batch || batch.classList.contains('hidden'),
                count: Number(document.getElementById('retry-failed-count')?.textContent?.trim() || -1),
                disabled: !!batch?.disabled,
                ariaBusy: batch?.getAttribute('aria-busy') || ''
            },
            summary: document.querySelector('#article-analysis-container .analysis-batch-summary')?.textContent?.trim() || '',
            historyState: document.getElementById('article-history-status')?.dataset.state || ''
        };
    });

    // ── 情境 1：歷史記錄的失敗段落與批次入口 ──────────────────────────
    console.log('\n[情境 1] 歷史記錄的失敗段落');
    await mock.openRecord(page, 'art_fail');
    const historyStatuses = await page.evaluate(() => Array.from(
        document.querySelectorAll('#article-analysis-container .paragraph-pair .para-status')
    ).map((row) => ({
        status: row.dataset.status || '',
        reason: row.querySelector('.para-reason')?.textContent?.trim() || '',
        retry: !!row.querySelector('.retry-paragraph-btn')
    })));
    check('歷史記錄每個段落都有狀態列', historyStatuses.length === 3, JSON.stringify(historyStatuses));
    check('空譯文段落顯示為失敗', historyStatuses.every((row) => row.status === 'failed'), JSON.stringify(historyStatuses));
    check('失敗段落顯示可翻譯的原因', historyStatuses.every((row) => !!row.reason), JSON.stringify(historyStatuses));
    check('失敗段落有逐段重試入口', historyStatuses.every((row) => row.retry), JSON.stringify(historyStatuses));
    let batch = await batchState();
    check('批次重試按鈕可見', batch.exists && !batch.hidden, JSON.stringify(batch));
    check('批次按鈕顯示 3 段', batch.count === 3, JSON.stringify(batch));
    check('批次按鈕 aria-label 含段數', /3/.test(batch.ariaLabel), batch.ariaLabel);

    // ── 情境 2：批次重試真的送出請求並落盤 ─────────────────────────────
    console.log('\n[情境 2] 批次重試成功並保存');
    ai.kind = 'ok';
    ai.calls = 0;
    await watchFlash();
    await page.click('#retry-failed-paragraphs-btn');
    await waitBatchSettled();
    const afterBatch = await page.evaluate(() => Array.from(
        document.querySelectorAll('#article-analysis-container .paragraph-pair .para-status')
    ).map((row) => row.dataset.status));
    check('批次重試後三段都完成', afterBatch.length === 3 && afterBatch.every((s) => s === 'done'), JSON.stringify(afterBatch));
    check('批次重試實際送出段落請求', ai.calls >= 3, String(ai.calls));
    batch = await batchState();
    check('全部成功後批次按鈕隱藏', batch.hidden, JSON.stringify(batch));

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    await mock.openRecord(page, 'art_fail');
    const reloaded = await page.evaluate(async () => {
        const mod = await import('/modules/article-store.js');
        const record = mod.getRecord('art_fail');
        return {
            translations: (record?.result?.paragraph_analysis || []).map((item) => String(item?.chinese_translation || '')),
            statuses: Array.from(document.querySelectorAll('#article-analysis-container .paragraph-pair .para-status')).map((row) => row.dataset.status),
            batchHidden: document.getElementById('retry-failed-paragraphs-btn')?.classList.contains('hidden')
        };
    });
    check('重新載入後譯文仍在', reloaded.translations.every((text) => !!text.trim()), JSON.stringify(reloaded.translations));
    check('重新載入後段落狀態仍為完成', reloaded.statuses.length === 3 && reloaded.statuses.every((s) => s === 'done'), JSON.stringify(reloaded.statuses));
    check('重新載入後批次按鈕保持隱藏', reloaded.batchHidden === true, String(reloaded.batchHidden));

    // ── 情境 3：空譯文不得閃成功 ──────────────────────────────────────
    console.log('\n[情境 3] 單段重試回空譯文');
    await resetParagraphs([1]);
    ai.kind = 'ok';
    ai.emptyFor = 'Readers leave their coats';
    ai.calls = 0;
    await watchFlash();
    await page.click('.paragraph-pair[data-paragraph-index="1"] .retry-paragraph-btn');
    await waitParagraphSettled(1);
    const emptyRetry = await statusOf(1);
    check('空譯文重試後仍標示失敗', emptyRetry.status === 'failed', JSON.stringify(emptyRetry));
    check('空譯文重試顯示原因', !!emptyRetry.reason, JSON.stringify(emptyRetry));
    check('空譯文重試不閃成功', (await flashSeen()) === 0, String(await flashSeen()));
    batch = await batchState();
    check('空譯文重試後批次按鈕仍為 1 段', !batch.hidden && batch.count === 1, JSON.stringify(batch));

    // ── 情境 4：單段成功後重新載入仍在 ────────────────────────────────
    console.log('\n[情境 4] 單段重試成功並保存');
    ai.kind = 'ok';
    ai.emptyFor = '';
    ai.calls = 0;
    await page.click('.paragraph-pair[data-paragraph-index="1"] .retry-paragraph-btn');
    await waitParagraphSettled(1);
    const singleDone = await statusOf(1);
    check('單段成功後狀態為完成', singleDone.status === 'done', JSON.stringify(singleDone));
    check('單段重試送出請求', ai.calls >= 1, String(ai.calls));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    await mock.openRecord(page, 'art_fail');
    const singleReloaded = await page.evaluate(async () => {
        const mod = await import('/modules/article-store.js');
        const record = mod.getRecord('art_fail');
        return {
            text: String(record?.result?.paragraph_analysis?.[1]?.chinese_translation || ''),
            status: document.querySelector('.paragraph-pair[data-paragraph-index="1"] .para-status')?.dataset.status || ''
        };
    });
    check('單段結果重新載入後仍在', !!singleReloaded.text.trim(), JSON.stringify(singleReloaded));
    check('單段結果重新載入後仍為完成', singleReloaded.status === 'done', JSON.stringify(singleReloaded));

    // ── 情境 5：錯誤碼顯示可理解的原因 ────────────────────────────────
    console.log('\n[情境 5] 供應商錯誤的失敗原因');
    const cases = [
        { kind: 'status', status: 401, expected: await tInPage('errors.aiProviderAuthFailed'), label: '401' },
        { kind: 'status', status: 429, expected: await tInPage('errors.aiProviderRateLimited'), label: '429' },
        { kind: 'status', status: 500, expected: await tInPage('errors.aiProviderServerError'), label: '500' },
        { kind: 'abort', expected: await tInPage('errors.aiNetworkBlocked'), label: '網路中斷' }
    ];
    for (const item of cases) {
        ai.kind = item.kind;
        ai.status = item.status || 500;
        ai.calls = 0;
        await watchFlash();
        await page.click('.paragraph-pair[data-paragraph-index="2"] .retry-paragraph-btn');
        await waitParagraphSettled(2);
        const row = await statusOf(2);
        check(`${item.label} 顯示失敗`, row.status === 'failed', JSON.stringify(row));
        check(`${item.label} 顯示可翻譯原因`, !!row.reason && row.reason.includes(item.expected), `${JSON.stringify(row)} expected=${item.expected}`);
        check(`${item.label} 不閃成功`, (await flashSeen()) === 0, String(await flashSeen()));
        check(`${item.label} 仍可重試`, row.retryVisible, JSON.stringify(row));
    }

    // ── 情境 6：批次部分成功 ─────────────────────────────────────────
    console.log('\n[情境 6] 批次重試部分成功');
    await resetParagraphs([0, 1, 2]);
    ai.kind = 'ok';
    ai.calls = 0;
    ai.emptyFor = 'Readers leave their coats'; // 只讓第 2 段回空
    await page.click('#retry-failed-paragraphs-btn');
    await waitBatchSettled();
    const partial = await page.evaluate(() => ({
        statuses: Array.from(document.querySelectorAll('#article-analysis-container .paragraph-pair .para-status')).map((row) => row.dataset.status),
        summary: document.querySelector('#article-analysis-container .analysis-batch-summary')?.textContent?.trim() || ''
    }));
    const summaryExpected = await tInPage('article.retrySummary', { done: 2, failed: 1 });
    batch = await batchState();
    check('部分成功：畫面保留 1 段失敗', partial.statuses.filter((s) => s === 'failed').length === 1, JSON.stringify(partial.statuses));
    check('部分成功：批次按鈕顯示 1 段', !batch.hidden && batch.count === 1, JSON.stringify(batch));
    check('部分成功：顯示重試摘要', partial.summary.includes(summaryExpected), `${partial.summary} / ${summaryExpected}`);
    ai.emptyFor = '';
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    await mock.openRecord(page, 'art_fail');
    const partialReloaded = await page.evaluate(() => ({
        statuses: Array.from(document.querySelectorAll('#article-analysis-container .paragraph-pair .para-status')).map((row) => row.dataset.status),
        count: Number(document.getElementById('retry-failed-count')?.textContent?.trim() || -1)
    }));
    check('部分成功：重新載入後仍顯示 1 段失敗', partialReloaded.statuses.filter((s) => s === 'failed').length === 1, JSON.stringify(partialReloaded));
    check('部分成功：重新載入後按鈕仍為 1', partialReloaded.count === 1, JSON.stringify(partialReloaded));

    // ── 情境 10：重試中切換文章 ─────────────────────────────────────
    console.log('\n[情境 7] 重試中切換文章');
    await resetParagraphs([0]);
    ai.kind = 'ok';
    ai.emptyFor = '';
    ai.delayMs = 1200;
    ai.calls = 0;
    await page.click('.paragraph-pair[data-paragraph-index="0"] .retry-paragraph-btn');
    await page.waitForTimeout(250);
    await mock.openRecord(page, 'art_beta');
    await page.waitForTimeout(1800);
    const switched = await page.evaluate(async () => {
        const mod = await import('/modules/article-store.js');
        return {
            input: document.getElementById('article-input').value,
            pairs: Array.from(document.querySelectorAll('.paragraph-pair .paragraph-chinese')).map((el) => el.textContent.trim()),
            firstParagraph: String(mod.getRecord('art_fail')?.result?.paragraph_analysis?.[0]?.chinese_translation || ''),
            beta: mod.getRecord('art_beta')
        };
    });
    check('切換後畫面仍是 B 的正文', switched.input.includes('BETA second article'), JSON.stringify(switched.input.slice(0, 40)));
    check('切換後沒有出現 A 的重試結果', !switched.pairs.some((text) => text.includes('譯句')), JSON.stringify(switched.pairs));
    check('切換後 A 的記錄沒有被寫入', switched.firstParagraph === '', JSON.stringify(switched.firstParagraph));
    check('切換後 B 的記錄沒有被建立分析', !switched.beta || !switched.beta.result, JSON.stringify(switched.beta && switched.beta.result));
    ai.delayMs = 0;

    // ── 情境 11：重試中刪除文章 ─────────────────────────────────────
    console.log('\n[情境 8] 重試中刪除文章');
    await resetParagraphs([0]);
    ai.delayMs = 1200;
    ai.calls = 0;
    await page.click('.paragraph-pair[data-paragraph-index="0"] .retry-paragraph-btn');
    await page.waitForTimeout(250);
    await page.click('#article-history-btn');
    await page.waitForTimeout(300);
    const deletedWhileRetrying = await page.evaluate(async () => {
        const row = document.querySelector('.ar-history-item[data-key="art_fail"]');
        if (!row) return false;
        row.querySelector('.ar-history-more').click();
        await new Promise((resolve) => setTimeout(resolve, 150));
        const btn = row.querySelector('.ar-history-menu button[data-act="delete"]');
        if (!btn) return false;
        btn.click();
        return true;
    });
    check('可刪除正在重試的文章', deletedWhileRetrying === true, String(deletedWhileRetrying));
    await page.waitForTimeout(200);
    const deleteConfirm = await page.evaluate(() => !!document.querySelector('.options-modal-overlay #confirm-btn'));
    if (deleteConfirm) await page.click('.options-modal-overlay #confirm-btn');
    await page.waitForTimeout(1800);
    const afterRetryDelete = await page.evaluate(async () => {
        const mod = await import('/modules/article-store.js');
        const record = mod.getRecord('art_fail');
        return {
            deletedAt: record?.deletedAt || '',
            paragraph: String(record?.result?.paragraph_analysis?.[0]?.chinese_translation || ''),
            rows: Array.from(document.querySelectorAll('.ar-history-item')).map((row) => row.getAttribute('data-key'))
        };
    });
    check('已刪除的文章仍是刪除狀態', !!afterRetryDelete.deletedAt, JSON.stringify(afterRetryDelete.deletedAt));
    check('重試結果沒有寫進已刪除的文章', afterRetryDelete.paragraph === '', JSON.stringify(afterRetryDelete.paragraph));
    check('清單沒有重新出現已刪除文章', !afterRetryDelete.rows.includes('art_fail'), JSON.stringify(afterRetryDelete.rows));
    await page.evaluate(() => document.getElementById('app-modal')?.classList.add('hidden'));
    ai.delayMs = 0;

    // ── 情境 7：空 JSON 的全篇分析 ───────────────────────────────────
    console.log('\n[情境 9] 空 JSON 的全篇分析');
    ai.kind = 'emptyJson';
    ai.calls = 0;
    await mock.openRecord(page, 'art_ten');
    await watchFlash();
    await page.click('#analyze-article-btn');
    await page.waitForFunction(() => {
        const btn = document.getElementById('analyze-article-btn');
        return btn && !btn.disabled && !document.querySelector('#article-analysis-container .inline-progress');
    }, null, { timeout: 60000 });
    await page.waitForTimeout(400);
    const emptyRun = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('#article-analysis-container .paragraph-pair .para-status'));
        return {
            total: rows.length,
            statuses: rows.map((row) => row.dataset.status),
            failed: rows.filter((row) => row.dataset.status === 'failed').length,
            skipped: rows.filter((row) => row.dataset.status === 'skipped').length,
            skippedRetry: rows.filter((row) => row.dataset.status === 'skipped').some((row) => {
                const btn = row.querySelector('.retry-paragraph-btn');
                return !!btn && btn.style.display !== 'none' && !btn.classList.contains('hidden');
            }),
            failedWithoutReason: rows.filter((row) => row.dataset.status === 'failed' && !row.querySelector('.para-reason')?.textContent?.trim()).length,
            count: Number(document.getElementById('retry-failed-count')?.textContent?.trim() || -1)
        };
    });
    check('空 JSON：每段都有狀態', emptyRun.total > 0 && emptyRun.statuses.every(Boolean), JSON.stringify(emptyRun));
    check('空 JSON：沒有段落被標成成功', !emptyRun.statuses.includes('done'), JSON.stringify(emptyRun.statuses));
    check('空 JSON：每個失敗段都有原因', emptyRun.failedWithoutReason === 0, JSON.stringify(emptyRun));
    check('空 JSON：失敗段數與按鈕一致', emptyRun.failed === emptyRun.count, JSON.stringify(emptyRun));
    check('空 JSON：不閃成功', (await flashSeen()) === 0, String(await flashSeen()));
    check('中文原文與純圖片段為 skipped', emptyRun.skipped >= 2, JSON.stringify(emptyRun));
    check('skipped 段落沒有重試入口', emptyRun.skippedRetry === false, JSON.stringify(emptyRun));

    // ── 情境 12：查詞去重與空詳解 ───────────────────────────────────
    console.log('\n[情境 10] 查詞去重與空詳解');
    ai.kind = 'ok';
    ai.emptyFor = '';
    ai.wordMode = 'ok';
    const wordCallsBefore = ai.wordCalls;
    await page.evaluate(() => {
        const wordEl = document.querySelector('#article-analysis-container .paragraph-english .interactive-word');
        if (!wordEl) return;
        for (let i = 0; i < 5; i += 1) wordEl.click();
    });
    await page.waitForTimeout(900);
    check('連點同一個詞只發一次請求', ai.wordCalls - wordCallsBefore === 1, String(ai.wordCalls - wordCallsBefore));
    const tooltipShown = await page.evaluate(() => ({
        visible: document.getElementById('word-analysis-tooltip')?.style.display !== 'none',
        text: document.getElementById('word-analysis-tooltip')?.textContent?.trim() || ''
    }));
    check('查詞結果顯示在 tooltip', tooltipShown.visible && tooltipShown.text.includes('測試意思'), JSON.stringify(tooltipShown).slice(0, 200));

    ai.wordMode = 'empty';
    const emptyCallsBefore = ai.wordCalls;
    await page.evaluate(() => {
        const words = Array.from(document.querySelectorAll('#article-analysis-container .paragraph-english .interactive-word'));
        const target = words.find((el) => el.textContent.trim().length > 3);
        target?.click();
    });
    await page.waitForFunction(() => !!document.querySelector('#word-analysis-tooltip .btn-retry-word'), null, { timeout: 15000 });
    const emptyWord = await page.evaluate(async () => {
        const i18n = await import('/modules/i18n.js');
        return {
            text: document.getElementById('word-analysis-tooltip')?.textContent?.trim() || '',
            expected: i18n.t('article.wordAnalysisFailed')
        };
    });
    check('空 meaning 顯示失敗與重試', emptyWord.text.includes(emptyWord.expected), JSON.stringify(emptyWord));
    check('空 meaning 只發一次請求', ai.wordCalls - emptyCallsBefore === 1, String(ai.wordCalls - emptyCallsBefore));
    const retryCallsBefore = ai.wordCalls;
    await page.click('#word-analysis-tooltip .btn-retry-word');
    await page.waitForTimeout(600);
    check('空 meaning 後可重新請求', ai.wordCalls - retryCallsBefore >= 1, String(ai.wordCalls - retryCallsBefore));

    // ── 情境 9：保存失敗不得閃成功 ───────────────────────────────────
    console.log('\n[情境 11] 保存失敗（容量上限）');
    ai.kind = 'ok';
    ai.emptyFor = '';
    ai.calls = 0;
    await mock.openRecord(page, 'art_too_large');
    await watchFlash();
    await page.click('.paragraph-pair[data-paragraph-index="0"] .retry-paragraph-btn');
    await waitParagraphSettled(0);
    const saveFailed = await statusOf(0);
    const saveFailedLabel = await tInPage('article.analysisSaveFailedInline');
    const saveFailedToasts = await page.evaluate(() => Array.from(document.querySelectorAll('.message-toast__text')).map((el) => el.textContent.trim()));
    check('保存失敗後不閃成功', (await flashSeen()) === 0, String(await flashSeen()));
    check('保存失敗後保持失敗狀態', saveFailed.status === 'failed', JSON.stringify(saveFailed));
    check('保存失敗顯示未保存原因', !!saveFailed.reason && saveFailed.reason.includes(saveFailedLabel), `${JSON.stringify(saveFailed)} / ${saveFailedLabel}`);
    check('保存失敗後仍可重試', saveFailed.retryVisible, JSON.stringify(saveFailed));
    check('保存失敗顯示提示訊息', saveFailedToasts.some((text) => text.includes(saveFailedLabel)), JSON.stringify(saveFailedToasts));
    const saveFailedBatch = await batchState();
    check('保存失敗後批次按鈕仍為 1 段', !saveFailedBatch.hidden && saveFailedBatch.count === 1, JSON.stringify(saveFailedBatch));

    // ── 情境 8：取消分析 ─────────────────────────────────────────────
    console.log('\n[情境 12] 取消分析');
    ai.kind = 'ok';
    ai.delayMs = 1200;
    ai.calls = 0;
    await page.click('#analyze-article-btn');
    await page.waitForTimeout(700);
    await page.click('#clear-article-btn');
    await page.waitForTimeout(300);
    const cancelled = await page.evaluate(async () => {
        const mod = await import('/modules/i18n.js');
        return {
            disabled: document.getElementById('analyze-article-btn').disabled,
            label: document.getElementById('analyze-article-btn').textContent.trim(),
            expected: mod.t('article.analyze'),
            failedRows: document.querySelectorAll('#article-analysis-container .para-status[data-status="failed"]').length,
            input: document.getElementById('article-input').value
        };
    });
    check('取消後分析按鈕可用', cancelled.disabled === false, JSON.stringify(cancelled));
    check('取消後按鈕文字還原', cancelled.label === cancelled.expected, JSON.stringify(cancelled));
    check('取消不算失敗', cancelled.failedRows === 0, JSON.stringify(cancelled));
    check('取消後輸入框已清空', cancelled.input === '', JSON.stringify(cancelled));
    ai.delayMs = 0;

    // ── 情境 13：同段落亂序回應（P1-2） ──────────────────────────────
    console.log('\n[情境 13a] 兩段同時重試：仍在請求中的段落不得提前解鎖');
    await resetParagraphs([0, 1, 2], 'art_race');
    ai.kind = 'ok';
    ai.emptyFor = '';
    ai.delayMs = 0;
    ai.plans.clear();
    ai.plans.set(PARAGRAPH_MARKERS.p0, { calls: 0, steps: [{ delayMs: 900, marker: 'SLOW-A' }] });
    ai.plans.set(PARAGRAPH_MARKERS.p1, { calls: 0, steps: [{ delayMs: 1800, marker: 'SLOW-B' }] });
    await page.click('.paragraph-pair[data-paragraph-index="0"] .retry-paragraph-btn');
    await page.click('.paragraph-pair[data-paragraph-index="1"] .retry-paragraph-btn');
    await waitParagraphSettled(0);
    const stillRunning = await page.evaluate(() => {
        const btn = document.querySelector('.paragraph-pair[data-paragraph-index="1"] .retry-paragraph-btn');
        const row = document.querySelector('.paragraph-pair[data-paragraph-index="1"] .para-status');
        return {
            disabled: !!btn?.disabled,
            ariaBusy: btn?.getAttribute('aria-busy') || '',
            status: row?.dataset.status || ''
        };
    });
    check('第一段完成後，仍在請求中的段落保持停用', stillRunning.disabled === true, JSON.stringify(stillRunning));
    check('仍在請求中的段落保留 aria-busy', stillRunning.ariaBusy === 'true', JSON.stringify(stillRunning));
    await waitParagraphSettled(1);

    console.log('\n[情境 13b] 同段落亂序完成：晚到的舊回應不得覆寫');
    await resetParagraphs([0, 1, 2], 'art_race');
    ai.plans.clear();
    ai.plans.set(PARAGRAPH_MARKERS.p0, { calls: 0, steps: [{ delayMs: 150, marker: 'P0' }] });
    ai.plans.set(PARAGRAPH_MARKERS.p1, {
        calls: 0,
        steps: [{ delayMs: 1600, marker: 'OLD' }, { delayMs: 60, marker: 'NEW' }]
    });
    ai.plans.set(PARAGRAPH_MARKERS.p2, { calls: 0, steps: [{ delayMs: 150, marker: 'P2' }] });
    await page.click('#retry-failed-paragraphs-btn');
    await waitParagraphSettled(0);
    // 等批次真的送出第 2 段請求（避免在批次尚未 claim 該段時就插入單段重試）。
    const planStarted = async () => (ai.plans.get(PARAGRAPH_MARKERS.p1)?.calls || 0) > 0;
    for (let waited = 0; waited < 6000 && !(await planStarted()); waited += 50) {
        await page.waitForTimeout(50);
    }
    check('批次已送出第 2 段請求', await planStarted(), String(ai.plans.get(PARAGRAPH_MARKERS.p1)?.calls || 0));
    // 模擬「按鈕被提前解鎖」的窗口：同一段再送一次，新版先完成、舊版後完成。
    await page.evaluate(() => {
        const btn = document.querySelector('.paragraph-pair[data-paragraph-index="1"] .retry-paragraph-btn');
        btn.disabled = false;
        btn.click();
    });
    const newFirst = await page.waitForFunction(() => {
        const row = document.querySelector('.paragraph-pair[data-paragraph-index="1"] .para-status');
        const zh = document.querySelector('.paragraph-pair[data-paragraph-index="1"] .paragraph-chinese')?.textContent || '';
        return row?.dataset.status === 'done' && zh.includes('NEW');
    }, null, { timeout: 20000 }).then(() => true).catch(() => false);
    check('第二次重試先以新結果完成', newFirst === true, String(newFirst));
    await waitBatchSettled(30000);
    await page.waitForTimeout(400);
    const outOfOrder = await page.evaluate(async () => {
        const mod = await import('/modules/article-store.js');
        const row = document.querySelector('.paragraph-pair[data-paragraph-index="1"] .para-status');
        return {
            status: row?.dataset.status || '',
            chinese: document.querySelector('.paragraph-pair[data-paragraph-index="1"] .paragraph-chinese')?.textContent || '',
            stored: String(mod.getRecord('art_race')?.result?.paragraph_analysis?.[1]?.chinese_translation || '')
        };
    });
    check('晚到的舊回應不得改寫畫面', outOfOrder.chinese.includes('NEW') && !outOfOrder.chinese.includes('OLD'), JSON.stringify(outOfOrder));
    check('晚到的舊回應不得改寫記錄', outOfOrder.stored.includes('NEW') && !outOfOrder.stored.includes('OLD'), JSON.stringify(outOfOrder));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    await mock.openRecord(page, 'art_race');
    const outOfOrderReloaded = await page.evaluate(async () => {
        const mod = await import('/modules/article-store.js');
        const row = document.querySelector('.paragraph-pair[data-paragraph-index="1"] .para-status');
        return {
            status: row?.dataset.status || '',
            chinese: document.querySelector('.paragraph-pair[data-paragraph-index="1"] .paragraph-chinese')?.textContent || '',
            stored: String(mod.getRecord('art_race')?.result?.paragraph_analysis?.[1]?.chinese_translation || '')
        };
    });
    check('重載後仍是新結果', outOfOrderReloaded.chinese.includes('NEW') && outOfOrderReloaded.stored.includes('NEW'), JSON.stringify(outOfOrderReloaded));
    ai.plans.clear();

    // ── 情境 14：真正的 IndexedDB 交易失敗（P1-1） ───────────────────
    console.log('\n[情境 14] 真正的 IndexedDB 交易失敗');
    await resetParagraphs([0, 1, 2], 'art_race');
    ai.kind = 'ok';
    ai.emptyFor = '';
    ai.delayMs = 0;
    ai.calls = 0;
    // 注入真正的交易失敗：docs store 的 put 直接 abort 交易（不是容量預檢）。
    await page.evaluate(() => {
        const proto = IDBObjectStore.prototype;
        window.__bdcOrigPut = proto.put;
        proto.put = function (...args) {
            if (this.name === 'docs') {
                try { this.transaction.abort(); } catch (_) { /* noop */ }
                throw new DOMException('injected docs transaction failure', 'AbortError');
            }
            return window.__bdcOrigPut.apply(this, args);
        };
    });
    await page.click('#retry-failed-paragraphs-btn');
    await waitBatchSettled(30000);
    const txFailed = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('#article-analysis-container .paragraph-pair .para-status'));
        return {
            statuses: rows.map((row) => row.dataset.status),
            reasons: rows.map((row) => row.querySelector('.para-reason')?.textContent?.trim() || ''),
            summary: document.querySelector('#article-analysis-container .analysis-batch-summary')?.textContent?.trim() || '',
            count: Number(document.getElementById('retry-failed-count')?.textContent?.trim() || -1),
            hidden: document.getElementById('retry-failed-paragraphs-btn')?.classList.contains('hidden'),
            disabled: document.getElementById('retry-failed-paragraphs-btn')?.disabled,
            retryButtons: Array.from(document.querySelectorAll('#article-analysis-container .retry-paragraph-btn')).map((btn) => ({
                disabled: btn.disabled,
                visible: btn.style.display !== 'none'
            }))
        };
    });
    const txSummaryExpected = await tInPage('article.retrySummary', { done: 0, failed: 3 });
    const txSaveFailedLabel = await tInPage('article.analysisSaveFailedInline');
    check('交易失敗：三段都標成未保存失敗', txFailed.statuses.filter((s) => s === 'failed').length === 3, JSON.stringify(txFailed.statuses));
    check('交易失敗：失敗原因顯示未能保存', txFailed.reasons.filter((text) => text.includes(txSaveFailedLabel)).length === 3, JSON.stringify(txFailed.reasons));
    check('交易失敗：摘要顯示仍失敗 3 段', txFailed.summary.includes(txSummaryExpected), `${txFailed.summary} / ${txSummaryExpected}`);
    check('交易失敗：批次按鈕仍可見且為 3 段', txFailed.hidden === false && txFailed.count === 3, JSON.stringify({ hidden: txFailed.hidden, count: txFailed.count }));
    check('交易失敗：批次按鈕仍可再按', txFailed.disabled === false, String(txFailed.disabled));
    check('交易失敗：失敗段仍可逐段重試', txFailed.retryButtons.length === 3 && txFailed.retryButtons.every((btn) => btn.visible && !btn.disabled), JSON.stringify(txFailed.retryButtons));

    // 失敗段仍可重試：交易失敗後再按一次批次，入口必須真的再跑一輪，不能只是好看。
    await page.evaluate(() => {
        window.__bdcBatchBusySeen = false;
        const btn = document.getElementById('retry-failed-paragraphs-btn');
        const mo = new MutationObserver(() => {
            if (btn.getAttribute('aria-busy') === 'true') window.__bdcBatchBusySeen = true;
        });
        mo.observe(btn, { attributes: true, attributeFilter: ['aria-busy'] });
        window.__bdcBatchBusyObserver = mo;
    });
    await page.click('#retry-failed-paragraphs-btn');
    await waitBatchSettled(30000);
    const txRetryAgain = await page.evaluate(() => {
        window.__bdcBatchBusyObserver?.disconnect();
        return {
            busySeen: window.__bdcBatchBusySeen === true,
            count: Number(document.getElementById('retry-failed-count')?.textContent?.trim() || -1),
            summary: document.querySelector('#article-analysis-container .analysis-batch-summary')?.textContent?.trim() || '',
            disabled: document.getElementById('retry-failed-paragraphs-btn')?.disabled
        };
    });
    check('交易失敗：批次重試入口真的會再跑一輪', txRetryAgain.busySeen === true, JSON.stringify(txRetryAgain));
    check('交易失敗：再跑一次仍保留 3 段失敗', txRetryAgain.count === 3 && txRetryAgain.summary.includes(txSummaryExpected), JSON.stringify(txRetryAgain));
    check('交易失敗：再跑一次後仍可重試', txRetryAgain.disabled === false, JSON.stringify(txRetryAgain));

    // 重載後磁碟仍是舊狀態，失敗數與入口必須一致。
    await page.evaluate(() => { IDBObjectStore.prototype.put = window.__bdcOrigPut; });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    await mock.openRecord(page, 'art_race');
    const txReloaded = await page.evaluate(() => ({
        failed: document.querySelectorAll('#article-analysis-container .para-status[data-status="failed"]').length,
        count: Number(document.getElementById('retry-failed-count')?.textContent?.trim() || -1),
        hidden: document.getElementById('retry-failed-paragraphs-btn')?.classList.contains('hidden')
    }));
    check('交易失敗：重載後仍是 3 段失敗', txReloaded.failed === 3, JSON.stringify(txReloaded));
    check('交易失敗：重載後失敗數仍為 3', txReloaded.count === 3 && txReloaded.hidden === false, JSON.stringify(txReloaded));

    ai.calls = 0;
    await page.click('.paragraph-pair[data-paragraph-index="0"] .retry-paragraph-btn');
    await waitParagraphSettled(0);
    const txRecovered = await page.evaluate(() => ({
        statuses: Array.from(document.querySelectorAll('#article-analysis-container .paragraph-pair .para-status')).map((row) => row.dataset.status),
        count: Number(document.getElementById('retry-failed-count')?.textContent?.trim() || -1)
    }));
    check('交易失敗：恢復寫入後該段可成功保存', txRecovered.statuses[0] === 'done', JSON.stringify(txRecovered));
    check('交易失敗：恢復後失敗數降為 2', txRecovered.count === 2, JSON.stringify(txRecovered));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    await mock.openRecord(page, 'art_race');
    const txRecoveredReloaded = await page.evaluate(() => ({
        statuses: Array.from(document.querySelectorAll('#article-analysis-container .paragraph-pair .para-status')).map((row) => row.dataset.status),
        count: Number(document.getElementById('retry-failed-count')?.textContent?.trim() || -1)
    }));
    check('交易失敗：重載後成功段仍在', txRecoveredReloaded.statuses[0] === 'done', JSON.stringify(txRecoveredReloaded));
    check('交易失敗：重載後失敗數仍為 2', txRecoveredReloaded.count === 2, JSON.stringify(txRecoveredReloaded));

    // ── 情境 15：介面語言切換後動態文案（P2-5） ─────────────────────
    console.log('\n[情境 15] zh-CN ↔ zh-HK 動態失敗狀態與摘要');
    // 批次重試不帶 force：先清掉前一個情境留下的 API 快取，讓 mock 空結果成為唯一來源。
    await page.evaluate(async () => {
        await new Promise((resolve) => {
            const req = indexedDB.deleteDatabase('bdc-cache');
            req.onsuccess = req.onerror = req.onblocked = () => resolve();
        });
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    await mock.openRecord(page, 'art_race');
    ai.kind = 'ok';
    ai.emptyFor = 'the'; // 只讓剩下的失敗段回空
    ai.calls = 0;
    await page.click('#retry-failed-paragraphs-btn');
    await waitBatchSettled(30000);
    const dynamicTexts = () => page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('#article-analysis-container .paragraph-pair'));
        return {
            statuses: rows.map((pair) => pair.querySelector('.para-status')?.dataset.status || ''),
            statusTexts: rows.map((pair) => pair.querySelector('.status-text')?.textContent?.trim() || ''),
            reasons: rows.map((pair) => pair.querySelector('.para-reason')?.textContent?.trim() || ''),
            retryButtons: rows.map((pair) => {
                const btn = pair.querySelector('.retry-paragraph-btn');
                return {
                    status: pair.querySelector('.para-status')?.dataset.status || '',
                    label: btn && btn.style.display !== 'none' ? btn.textContent.trim() : ''
                };
            }),
            summary: document.querySelector('#article-analysis-container .analysis-batch-summary')?.textContent?.trim() || ''
        };
    });
    const expectedDynamic = () => page.evaluate(async () => {
        const i18n = await import('/modules/i18n.js');
        return {
            failed: i18n.t('article.failedStatus'),
            retry: i18n.t('article.retryParagraph'),
            refresh: i18n.t('article.refresh'),
            summary: i18n.t('article.retrySummary', { done: 0, failed: 2 }),
            reason: i18n.t('article.paragraphFailureReason', { message: i18n.t('article.emptyTranslation') })
        };
    });
    const cnTexts = await dynamicTexts();
    const cnExpected = await expectedDynamic();
    check('zh-CN：摘要為簡體', cnTexts.summary === cnExpected.summary, `${cnTexts.summary} / ${cnExpected.summary}`);
    check('zh-CN：失敗狀態與原因為簡體', cnTexts.statusTexts.filter((_, i) => cnTexts.statuses[i] === 'failed').every((text) => text === cnExpected.failed)
        && cnTexts.reasons.filter((_, i) => cnTexts.statuses[i] === 'failed').every((text) => text === cnExpected.reason), JSON.stringify(cnTexts));
    check('zh-CN：重試按鈕文字正確', cnTexts.retryButtons.every((btn) => btn.label === (btn.status === 'done' ? cnExpected.refresh : cnExpected.retry)), JSON.stringify(cnTexts.retryButtons));

    await setLocale('zh-HK');
    const hkTexts = await dynamicTexts();
    const hkExpected = await expectedDynamic();
    check('zh-HK：摘要改為香港繁體', hkTexts.summary === hkExpected.summary, `${hkTexts.summary} / ${hkExpected.summary}`);
    check('zh-HK：摘要確實不是簡體', hkExpected.summary !== cnExpected.summary && hkTexts.summary !== cnTexts.summary, `${hkTexts.summary} / ${cnTexts.summary}`);
    check('zh-HK：失敗狀態為香港繁體', hkTexts.statusTexts.filter((_, i) => hkTexts.statuses[i] === 'failed').every((text) => text === hkExpected.failed), JSON.stringify(hkTexts.statusTexts));
    check('zh-HK：失敗原因為香港繁體', hkTexts.reasons.filter((_, i) => hkTexts.statuses[i] === 'failed').every((text) => text === hkExpected.reason), JSON.stringify(hkTexts.reasons));
    check('zh-HK：重試按鈕文字為香港繁體', hkTexts.retryButtons.every((btn) => btn.label === (btn.status === 'done' ? hkExpected.refresh : hkExpected.retry)), JSON.stringify(hkTexts.retryButtons));

    await setLocale('zh-CN');
    const backTexts = await dynamicTexts();
    const backExpected = await expectedDynamic();
    check('切回 zh-CN：摘要恢復簡體', backTexts.summary === backExpected.summary, `${backTexts.summary} / ${backExpected.summary}`);
    check('切回 zh-CN：失敗原因恢復簡體', backTexts.reasons.filter((_, i) => backTexts.statuses[i] === 'failed').every((text) => text === backExpected.reason), JSON.stringify(backTexts.reasons));
    check('切回 zh-CN：重試按鈕恢復簡體', backTexts.retryButtons.every((btn) => btn.label === (btn.status === 'done' ? backExpected.refresh : backExpected.retry)), JSON.stringify(backTexts.retryButtons));
    ai.emptyFor = '';

    // ── 情境 16：不同段落並發重試，保存不得互相覆蓋（F1） ─────────────
    console.log('\n[情境 16] 不同段落並發重試的保存不丟失');
    await resetParagraphs([0, 1, 2], 'art_race');
    ai.kind = 'ok';
    ai.emptyFor = '';
    ai.delayMs = 0;
    ai.calls = 0;
    ai.plans.clear();
    ai.plans.set(PARAGRAPH_MARKERS.p0, { calls: 0, steps: [{ marker: 'PARA-ZERO' }] });
    ai.plans.set(PARAGRAPH_MARKERS.p1, { calls: 0, steps: [{ marker: 'PARA-ONE' }] });
    // 用真實 readwrite 交易佔住 docs：兩個保存都會排隊，修復前都用同一份舊快照。
    await holdDocsWrites();
    await page.click('.paragraph-pair[data-paragraph-index="0"] .retry-paragraph-btn');
    await page.click('.paragraph-pair[data-paragraph-index="1"] .retry-paragraph-btn');
    await page.waitForTimeout(900);
    const queuedDuringHold = await page.evaluate(() => [0, 1].map((idx) => (
        document.querySelector(`.paragraph-pair[data-paragraph-index="${idx}"] .para-status`)?.dataset.status || ''
    )));
    check('並發保存：交易釋放前兩段仍等待保存', queuedDuringHold.every((status) => status === 'pending'), JSON.stringify(queuedDuringHold));
    await releaseDocsWrites();
    await waitParagraphSettled(0);
    await waitParagraphSettled(1);
    const concurrentSave = await page.evaluate(async () => {
        const mod = await import('/modules/article-store.js');
        const record = mod.getRecord('art_race');
        return {
            dom: [0, 1].map((idx) => ({
                status: document.querySelector(`.paragraph-pair[data-paragraph-index="${idx}"] .para-status`)?.dataset.status || '',
                chinese: document.querySelector(`.paragraph-pair[data-paragraph-index="${idx}"] .paragraph-chinese`)?.textContent || ''
            })),
            stored: [0, 1].map((idx) => String(record?.result?.paragraph_analysis?.[idx]?.chinese_translation || ''))
        };
    });
    check('並發保存：第 1 段畫面保留自己的結果', concurrentSave.dom[0].status === 'done' && concurrentSave.dom[0].chinese.includes('PARA-ZERO'), JSON.stringify(concurrentSave.dom[0]));
    check('並發保存：第 2 段畫面保留自己的結果', concurrentSave.dom[1].status === 'done' && concurrentSave.dom[1].chinese.includes('PARA-ONE'), JSON.stringify(concurrentSave.dom[1]));
    check('並發保存：記錄同時保留兩段結果', concurrentSave.stored[0].includes('PARA-ZERO') && concurrentSave.stored[1].includes('PARA-ONE'), JSON.stringify(concurrentSave.stored));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    await mock.openRecord(page, 'art_race');
    const concurrentReloaded = await page.evaluate(async () => {
        const mod = await import('/modules/article-store.js');
        const record = mod.getRecord('art_race');
        return {
            stored: [0, 1].map((idx) => String(record?.result?.paragraph_analysis?.[idx]?.chinese_translation || '')),
            statuses: [0, 1].map((idx) => document.querySelector(`.paragraph-pair[data-paragraph-index="${idx}"] .para-status`)?.dataset.status || '')
        };
    });
    check('並發保存：重載後兩段成功仍在', concurrentReloaded.stored[0].includes('PARA-ZERO') && concurrentReloaded.stored[1].includes('PARA-ONE'), JSON.stringify(concurrentReloaded.stored));
    check('並發保存：重載後兩段狀態仍為完成', concurrentReloaded.statuses.every((status) => status === 'done'), JSON.stringify(concurrentReloaded.statuses));
    ai.plans.clear();

    // ── 情境 17：批次保存 await 時切換文章（F2） ─────────────────────
    console.log('\n[情境 17] 批次保存等待交易時切換文章');
    // B 先載入全文並記下畫面，稍後在 A 的保存被交易阻塞時切換到 B。
    await mock.openRecord(page, 'art_f2_b');
    const bBefore = await viewFingerprint();
    await mock.openRecord(page, 'art_race');
    await resetParagraphsInPlace([0, 1, 2], 'art_race');
    ai.kind = 'ok';
    ai.emptyFor = '';
    ai.delayMs = 0;
    ai.calls = 0;
    ai.plans.clear();
    ai.plans.set(PARAGRAPH_MARKERS.p0, { calls: 0, steps: [{ marker: 'F2-P0' }] });
    ai.plans.set(PARAGRAPH_MARKERS.p1, { calls: 0, steps: [{ marker: 'F2-P1' }] });
    ai.plans.set(PARAGRAPH_MARKERS.p2, { calls: 0, steps: [{ marker: 'F2-P2' }] });
    await holdDocsWrites();
    // 觀察 A 的最後一次保存交易何時建立（此時它排在 hold 後面）。
    await page.evaluate(() => {
        window.__watchRaceSaveTx = true;
        window.__raceSaveTxSeen = 0;
        window.__origDbTransaction = IDBDatabase.prototype.transaction;
        IDBDatabase.prototype.transaction = function (names, mode, ...rest) {
            const list = Array.isArray(names) ? names : [names];
            if (window.__watchRaceSaveTx && mode === 'readwrite' && list.includes('docs')) {
                window.__raceSaveTxSeen += 1;
            }
            return window.__origDbTransaction.call(this, names, mode, ...rest);
        };
    });
    await page.click('#retry-failed-paragraphs-btn');
    await page.waitForFunction(() => (window.__raceSaveTxSeen || 0) > 0, null, { timeout: 20000 });
    // A 的保存交易已建立但被 hold 擋住；切到 B 後才讓它執行並 abort。
    await page.evaluate(() => {
        window.__abortRaceDocPut = true;
        window.__racePutAttempts = 0;
        window.__origPutF2 = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (...args) {
            const doc = args[0];
            if (this.name === 'docs' && window.__abortRaceDocPut && doc && doc.id === 'art_race') {
                window.__racePutAttempts += 1;
                try { this.transaction.abort(); } catch (_) { /* noop */ }
                throw new DOMException('abort A batch save', 'AbortError');
            }
            return window.__origPutF2.apply(this, args);
        };
    });
    await mock.openRecord(page, 'art_f2_b');
    await page.waitForTimeout(300);
    await releaseDocsWrites();
    await page.waitForTimeout(1500);
    const bAfter = await viewFingerprint();
    const racePutAttempts = await page.evaluate(() => window.__racePutAttempts || 0);
    check('切頁保存：A 的保存確實進入交易', racePutAttempts >= 1, String(racePutAttempts));
    check('切頁保存：B 的原文不變', bAfter.body === bBefore.body, JSON.stringify({ before: bBefore.body.slice(0, 30), after: bAfter.body.slice(0, 30) }));
    check('切頁保存：B 的段落譯文與狀態不變', JSON.stringify(bAfter.pairs) === JSON.stringify(bBefore.pairs), JSON.stringify({ before: bBefore.pairs, after: bAfter.pairs }));
    check('切頁保存：B 的批次按鈕與摘要不變', JSON.stringify(bAfter.batch) === JSON.stringify(bBefore.batch) && bAfter.summary === bBefore.summary, JSON.stringify({ before: bBefore.batch, after: bAfter.batch, summary: bAfter.summary }));
    check('切頁保存：A 的失敗摘要不得寫到 B', !bAfter.summary.includes('F2-') && !bAfter.summary.includes('已重试'), bAfter.summary);
    await page.evaluate(() => {
        IDBObjectStore.prototype.put = window.__origPutF2;
        IDBDatabase.prototype.transaction = window.__origDbTransaction;
        window.__abortRaceDocPut = false;
        window.__watchRaceSaveTx = false;
    });
    ai.plans.clear();

    await mock.openRecord(page, 'art_f3');

    // ── 情境 18：整篇分析最後保存失敗（F3） ──────────────────────────
    console.log('\n[情境 18] 整篇分析最後保存失敗');
    ai.kind = 'ok';
    ai.emptyFor = '';
    ai.delayMs = 0;
    ai.calls = 0;
    ai.plans.clear();
    await page.fill('#article-input', F3_EDITED);
    // 只 abort「完整譯文」的最後一次保存；先前的正文保存要成功。
    await page.evaluate(() => {
        window.__abortFinalSave = true;
        window.__finalSaveAborts = 0;
        window.__origPutF3 = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (...args) {
            const doc = args[0];
            const complete = doc && doc.id === 'art_f3'
                && Array.isArray(doc.analysis?.paragraph_analysis)
                && doc.analysis.paragraph_analysis.length > 0
                && doc.analysis.paragraph_analysis.every((item) => String(item?.chinese_translation || '').trim());
            if (this.name === 'docs' && window.__abortFinalSave && complete) {
                // 只 abort 這一次「完整譯文」保存；後續單段刷新與重試保存必須能落盤。
                window.__abortFinalSave = false;
                window.__finalSaveAborts += 1;
                try { this.transaction.abort(); } catch (_) { /* noop */ }
                throw new DOMException('abort final analysis save', 'AbortError');
            }
            return window.__origPutF3.apply(this, args);
        };
    });
    await page.click('#analyze-article-btn');
    await page.waitForFunction(() => {
        const btn = document.getElementById('analyze-article-btn');
        return !!btn && !btn.disabled && !document.querySelector('#article-analysis-container .inline-progress');
    }, null, { timeout: 60000 });
    await page.waitForFunction(() => !!document.querySelector('#article-analysis-container .analysis-save-failure'), null, { timeout: 20000 });
    const f3Failed = await page.evaluate(async () => {
        const i18n = await import('/modules/i18n.js');
        const status = document.getElementById('article-history-status');
        return {
            aborts: window.__finalSaveAborts || 0,
            historyState: status?.dataset.state || '',
            historyText: status?.textContent?.trim() || '',
            saveFailedText: i18n.t('article.historyStatusSaveFailed'),
            bannerTitle: document.querySelector('.analysis-save-failure__title')?.textContent?.trim() || '',
            bannerHint: document.querySelector('.analysis-save-failure__hint')?.textContent?.trim() || '',
            retryLabel: document.querySelector('.analysis-save-retry')?.textContent?.trim() || '',
            expectedRetry: i18n.t('article.retrySaveAnalysis'),
            statuses: Array.from(document.querySelectorAll('#article-analysis-container .paragraph-pair .para-status')).map((row) => row.dataset.status),
            translations: Array.from(document.querySelectorAll('#article-analysis-container .paragraph-pair .paragraph-chinese')).map((el) => el.textContent.trim())
        };
    });
    check('最後保存失敗：確實 abort 最後一次保存', f3Failed.aborts >= 1, String(f3Failed.aborts));
    check('最後保存失敗：歷史狀態明示未保存', f3Failed.historyState === 'failed' && f3Failed.historyText.includes(f3Failed.saveFailedText), JSON.stringify({ state: f3Failed.historyState, text: f3Failed.historyText }));
    check('最後保存失敗：不顯示已存入承諾', !f3Failed.historyText.includes('已存入阅读记录'), f3Failed.historyText);
    check('最後保存失敗：畫面保留完整分析與譯文', f3Failed.statuses.length === 2 && f3Failed.statuses.every((status) => status === 'done') && f3Failed.translations.every((text) => !!text), JSON.stringify({ statuses: f3Failed.statuses, translations: f3Failed.translations }));
    check('最後保存失敗：顯示未保存提示與重試保存入口', !!f3Failed.bannerTitle && !!f3Failed.bannerHint && f3Failed.retryLabel === f3Failed.expectedRetry, JSON.stringify(f3Failed));
    // 一般歷史指示器再跑一次也不得覆蓋失敗狀態。
    await page.evaluate(() => document.getElementById('article-input').dispatchEvent(new Event('input', { bubbles: true })));
    await page.waitForTimeout(300);
    const f3AfterIndicator = await page.evaluate(() => ({
        state: document.getElementById('article-history-status')?.dataset.state || '',
        text: document.getElementById('article-history-status')?.textContent?.trim() || '',
        banner: !!document.querySelector('.analysis-save-failure')
    }));
    check('最後保存失敗：歷史指示器不覆蓋失敗狀態', f3AfterIndicator.state === 'failed' && f3AfterIndicator.banner === true, JSON.stringify(f3AfterIndicator));
    // F6：完整分析保存失敗後，先刷新單段再按「重試保存」；快照若不更新，
    // 重試保存會把刷新後的新譯文蓋回舊值。
    ai.plans.clear();
    ai.plans.set('F3 second paragraph was edited', { calls: 0, steps: [{ marker: 'F3-REFRESHED' }] });
    await page.click('.paragraph-pair[data-paragraph-index="1"] .retry-paragraph-btn');
    await waitParagraphSettled(1);
    await page.waitForFunction(() => {
        const el = document.querySelector('.paragraph-pair[data-paragraph-index="1"] .paragraph-chinese');
        return !!el && el.textContent.includes('F3-REFRESHED');
    }, null, { timeout: 20000 });
    const f3Refreshed = await page.evaluate(() => ({
        status: document.querySelector('.paragraph-pair[data-paragraph-index="1"] .para-status')?.dataset.status || '',
        translation: document.querySelector('.paragraph-pair[data-paragraph-index="1"] .paragraph-chinese')?.textContent?.trim() || '',
        banner: !!document.querySelector('.analysis-save-failure')
    }));
    check('刷新段落：新譯文已顯示並保存', f3Refreshed.status === 'done' && f3Refreshed.translation.includes('F3-REFRESHED'), JSON.stringify(f3Refreshed));
    check('刷新段落：完整分析未保存提示仍在', f3Refreshed.banner === true, String(f3Refreshed.banner));
    ai.plans.clear();
    // 恢復寫入後只重試保存，不重新呼叫 AI；結果要落盤。
    const aiCallsBeforeRetrySave = ai.calls;
    await page.evaluate(() => {
        IDBObjectStore.prototype.put = window.__origPutF3;
        window.__abortFinalSave = false;
    });
    await page.click('.analysis-save-retry');
    await page.waitForFunction(() => !document.querySelector('#article-analysis-container .analysis-save-failure'), null, { timeout: 20000 });
    const f3Recovered = await page.evaluate(async () => {
        const i18n = await import('/modules/i18n.js');
        const status = document.getElementById('article-history-status');
        return {
            state: status?.dataset.state || '',
            text: status?.textContent?.trim() || '',
            savedPrefix: i18n.t('article.historyStatusSaved', { time: '__TIME__' }).split('__TIME__')[0],
            banner: !!document.querySelector('.analysis-save-failure'),
            translations: Array.from(document.querySelectorAll('#article-analysis-container .paragraph-pair .paragraph-chinese')).map((el) => el.textContent.trim())
        };
    });
    check('重試保存：成功後顯示已保存', f3Recovered.state !== 'failed' && f3Recovered.text.includes(f3Recovered.savedPrefix), JSON.stringify(f3Recovered));
    check('重試保存：成功後移除未保存提示', f3Recovered.banner === false, String(f3Recovered.banner));
    check('重試保存：刷新後的新譯文不被舊快照覆蓋', f3Recovered.translations[1]?.includes('F3-REFRESHED'), JSON.stringify(f3Recovered.translations));
    check('重試保存：其他段落仍是完整分析結果', f3Recovered.translations.length === 2 && !!f3Recovered.translations[0] && !f3Recovered.translations[0].includes('F3-REFRESHED'), JSON.stringify(f3Recovered.translations));
    check('重試保存：不重新呼叫 AI', ai.calls === aiCallsBeforeRetrySave, `${ai.calls} / ${aiCallsBeforeRetrySave}`);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    await mock.openRecord(page, 'art_f3');
    const f3Reloaded = await page.evaluate(() => ({
        banner: !!document.querySelector('.analysis-save-failure'),
        statuses: Array.from(document.querySelectorAll('#article-analysis-container .paragraph-pair .para-status')).map((row) => row.dataset.status),
        translations: Array.from(document.querySelectorAll('#article-analysis-container .paragraph-pair .paragraph-chinese')).map((el) => el.textContent.trim())
    }));
    check('重試保存：重載後結果仍在', !f3Reloaded.banner && f3Reloaded.statuses.every((status) => status === 'done') && f3Reloaded.translations.every((text) => !!text), JSON.stringify(f3Reloaded));
    check('重試保存：重載後刷新段仍是新譯文', f3Reloaded.translations.length === 2 && f3Reloaded.translations[1]?.includes('F3-REFRESHED'), JSON.stringify(f3Reloaded.translations));
    check('重試保存：重載後其他段仍是完整分析結果', !!f3Reloaded.translations[0] && !f3Reloaded.translations[0].includes('F3-REFRESHED'), JSON.stringify(f3Reloaded.translations));

    // ── 情境 19：整篇成功保存要清掉舊未保存標記（F4） ─────────────────
    console.log('\n[情境 19] 整篇成功保存清除舊未保存標記');
    await resetParagraphs([1], 'art_f3');
    ai.kind = 'ok';
    ai.emptyFor = '';
    ai.delayMs = 0;
    ai.calls = 0;
    ai.plans.clear();
    await page.evaluate(() => {
        window.__abortSingleSaveOnce = true;
        window.__origPutF4 = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (...args) {
            const doc = args[0];
            if (this.name === 'docs' && window.__abortSingleSaveOnce && doc && doc.id === 'art_f3') {
                window.__abortSingleSaveOnce = false;
                try { this.transaction.abort(); } catch (_) { /* noop */ }
                throw new DOMException('abort single paragraph save', 'AbortError');
            }
            return window.__origPutF4.apply(this, args);
        };
    });
    await page.click('.paragraph-pair[data-paragraph-index="1"] .retry-paragraph-btn');
    await waitParagraphSettled(1);
    const f4Unsaved = await page.evaluate(() => ({
        status: document.querySelector('.paragraph-pair[data-paragraph-index="1"] .para-status')?.dataset.status || '',
        count: Number(document.getElementById('retry-failed-count')?.textContent?.trim() || -1)
    }));
    check('未保存標記：單段保存失敗後仍為失敗', f4Unsaved.status === 'failed', JSON.stringify(f4Unsaved));
    check('未保存標記：失敗數保留 1', f4Unsaved.count === 1, JSON.stringify(f4Unsaved));
    await page.evaluate(() => { IDBObjectStore.prototype.put = window.__origPutF4; });
    await page.click('#analyze-article-btn');
    await page.waitForFunction(() => {
        const btn = document.getElementById('analyze-article-btn');
        return !!btn && !btn.disabled && !document.querySelector('#article-analysis-container .inline-progress');
    }, null, { timeout: 60000 });
    await page.waitForTimeout(400);
    const f4AfterFull = await page.evaluate(() => ({
        statuses: Array.from(document.querySelectorAll('#article-analysis-container .paragraph-pair .para-status')).map((row) => row.dataset.status),
        count: Number(document.getElementById('retry-failed-count')?.textContent?.trim() || -1),
        batchHidden: document.getElementById('retry-failed-paragraphs-btn')?.classList.contains('hidden')
    }));
    check('整篇保存成功：段落全部完成', f4AfterFull.statuses.every((status) => status === 'done'), JSON.stringify(f4AfterFull.statuses));
    check('整篇保存成功：失敗數歸零且批次隱藏', f4AfterFull.count === 0 && f4AfterFull.batchHidden === true, JSON.stringify(f4AfterFull));
    await mock.openRecord(page, 'art_f3');
    const f4Reopened = await page.evaluate(() => ({
        statuses: Array.from(document.querySelectorAll('#article-analysis-container .paragraph-pair .para-status')).map((row) => row.dataset.status),
        count: Number(document.getElementById('retry-failed-count')?.textContent?.trim() || -1)
    }));
    check('同頁重開：不應復活舊未保存標記', f4Reopened.statuses.every((status) => status === 'done') && f4Reopened.count === 0, JSON.stringify(f4Reopened));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    await mock.openRecord(page, 'art_f3');
    const f4Reloaded = await page.evaluate(() => ({
        statuses: Array.from(document.querySelectorAll('#article-analysis-container .paragraph-pair .para-status')).map((row) => row.dataset.status),
        count: Number(document.getElementById('retry-failed-count')?.textContent?.trim() || -1)
    }));
    check('整頁重載：仍保持成功', f4Reloaded.statuses.every((status) => status === 'done') && f4Reloaded.count === 0, JSON.stringify(f4Reloaded));

    // ── 情境 20：歷史失敗段的 locale 雙向刷新（F5） ───────────────────
    console.log('\n[情境 20] 歷史失敗段切換語言');
    await mock.openRecord(page, 'art_f5');
    const f5Texts = () => page.evaluate(() => {
        const pair = document.querySelector('#article-analysis-container .paragraph-pair[data-paragraph-index="0"]');
        return {
            status: pair?.querySelector('.para-status')?.dataset.status || '',
            errorCode: pair?.querySelector('.para-status')?.dataset.errorCode || '',
            statusText: pair?.querySelector('.status-text')?.textContent?.trim() || '',
            reason: pair?.querySelector('.para-reason')?.textContent?.trim() || '',
            failedInline: pair?.querySelector('.analysis-failed-inline')?.textContent?.trim() || '',
            retry: pair?.querySelector('.retry-paragraph-btn')?.textContent?.trim() || ''
        };
    });
    const f5Expected = () => page.evaluate(async () => {
        const i18n = await import('/modules/i18n.js');
        return {
            statusText: i18n.t('article.failedStatus'),
            reason: i18n.t('article.paragraphFailureReason', { message: i18n.t('errors.aiProviderAuthFailed') }),
            failedInline: i18n.t('article.analysisFailedInline'),
            retry: i18n.t('article.retryParagraph')
        };
    });
    const f5Cn = await f5Texts();
    const f5CnExpected = await f5Expected();
    check('歷史失敗：保留具體錯誤碼', f5Cn.errorCode === 'provider_auth_failed', JSON.stringify(f5Cn));
    check('歷史失敗：zh-CN 顯示具體認證原因', f5Cn.reason === f5CnExpected.reason, JSON.stringify(f5Cn));
    check('歷史失敗：zh-CN 失敗譯文標記可刷新', f5Cn.failedInline === f5CnExpected.failedInline, JSON.stringify(f5Cn));
    await setLocale('zh-HK');
    const f5Hk = await f5Texts();
    const f5HkExpected = await f5Expected();
    check('歷史失敗：zh-HK 狀態為香港繁體', f5Hk.statusText === f5HkExpected.statusText, `${f5Hk.statusText} / ${f5HkExpected.statusText}`);
    check('歷史失敗：zh-HK 保留具體認證原因', f5Hk.reason === f5HkExpected.reason, `${f5Hk.reason} / ${f5HkExpected.reason}`);
    check('歷史失敗：zh-HK 失敗譯文同步刷新', f5Hk.failedInline === f5HkExpected.failedInline, `${f5Hk.failedInline} / ${f5HkExpected.failedInline}`);
    check('歷史失敗：zh-HK 重試按鈕同步刷新', f5Hk.retry === f5HkExpected.retry, `${f5Hk.retry} / ${f5HkExpected.retry}`);
    check('歷史失敗：zh-HK 不殘留簡體文案', !f5Hk.reason.includes('认证') && !f5Hk.failedInline.includes('分析失败'), JSON.stringify(f5Hk));
    await setLocale('zh-CN');
    const f5Back = await f5Texts();
    const f5BackExpected = await f5Expected();
    check('歷史失敗：切回 zh-CN 恢復簡體原因', f5Back.reason === f5BackExpected.reason, `${f5Back.reason} / ${f5BackExpected.reason}`);
    check('歷史失敗：切回 zh-CN 失敗譯文恢復', f5Back.failedInline === f5BackExpected.failedInline, `${f5Back.failedInline} / ${f5BackExpected.failedInline}`);

    check('沒有未預期的頁面錯誤', pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 3)));

    await browser.close();
    const failures = finish();
    if (failures) process.exit(1);
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
