'use strict';
/**
 * N1/N2 定向最終複驗（只讀）。
 * N1：面板 Tab 陷阱在「更多」選單收起／展開時的回繞。
 * N2：筆記保存失敗→重試，真實滑鼠按住（>=100ms）再放開後的焦點與資料。
 * 只使用隔離 context + 合成 fixture，攔截 ai-config 與外部網路；不改產品碼、不呼叫真實 AI。
 * PORT=8313 PLAYWRIGHT_MODULE=<pw> node n1n2-final.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE);
const { createReadingPanelFixture, BASE } = require('/Users/linus/CODE/bdc/tests/helpers/reading-panel-fixture.cjs');

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ASSET_DIR = process.env.ASSET_DIR || __dirname;
const LOCALES = ['zh-CN', 'zh-HK'];
const STRINGS = {
    'zh-CN': { saving: '保存中…', failed: '保存失败，请重试', saved: '已保存', retry: '重试' },
    'zh-HK': { saving: '儲存中…', failed: '儲存失敗，請重試', saved: '已儲存', retry: '重試' }
};

const observations = {
    startedAt: new Date().toISOString(),
    baseUrl: BASE,
    scope: 'N1（Tab 回繞）+ N2（滑鼠重試焦點）；不含其他 84 項',
    n1: [],
    n2: [],
    keyboard: [],
    pageErrors: [],
    scenarioErrors: []
};
let assertions = 0;
const failures = [];

function assert(condition, message, detail) {
    assertions += 1;
    if (!condition) {
        const error = new Error(message + (detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`));
        error.__assertion = true;
        throw error;
    }
}
function record(bucket, id, name, work, extra = {}) {
    return (async () => {
        const started = Date.now();
        try {
            const detail = await work();
            bucket.push({ id, name, status: 'pass', ms: Date.now() - started, ...extra, detail });
            console.log(`ok   [${id}] ${name}`);
            return detail;
        } catch (error) {
            const message = String((error && error.message) || error);
            const status = error && error.__assertion ? 'fail' : 'error';
            bucket.push({ id, name, status, ms: Date.now() - started, ...extra, detail: message });
            failures.push({ id, name, status, detail: message });
            console.log(`${status === 'fail' ? 'FAIL' : 'ERR '} [${id}] ${name} :: ${message}`);
            return null;
        }
    })();
}
async function shot(page, name) {
    const file = path.join(ASSET_DIR, name + '.png');
    try {
        await page.screenshot({ path: file });
        return path.basename(file);
    } catch (_) {
        return null;
    }
}
function active(page) {
    return page.evaluate(() => {
        const a = document.activeElement;
        return {
            tag: a?.tagName || null,
            id: a?.id || '',
            cls: typeof a?.className === 'string' ? a.className.trim() : '',
            noteId: a?.getAttribute?.('data-note-id') || '',
            isRetry: !!a?.hasAttribute?.('data-note-retry'),
            inPanel: !!a?.closest?.('#article-reading-panel'),
            connected: !!a?.isConnected
        };
    });
}
async function openAt(browser, width, locale) {
    const fixture = await createReadingPanelFixture(browser, { locale, mobile: width <= 600 });
    await fixture.page.setViewportSize({ width, height: 844 });
    await fixture.page.waitForTimeout(350);
    fixture.label = `${locale}-${width}`;
    return fixture;
}

// ── N1：Tab 回繞 ─────────────────────────────────────────────
async function scenarioN1(browser, locale, width) {
    const { context, page, errors } = await openAt(browser, width, locale);
    const id = `N1-${locale}-${width}`;
    try {
        const detail = await record(observations.n1, id, `${width}px/${locale}：「更多」收起時 summary Tab→close、close Shift+Tab→summary；展開時最後 AI 工具與 close 正反回繞`, async () => {
            const modal = await page.evaluate(() => ({
                modalClass: document.body.classList.contains('reading-panel-modal'),
                mediaModal: window.matchMedia('(max-width: 1199px)').matches,
                ariaModal: document.getElementById('article-reading-panel')?.getAttribute('aria-modal')
            }));
            assert(modal.modalClass && modal.mediaModal && modal.ariaModal === 'true', '面板未進入模態，Tab 陷阱不適用', modal);

            const targets = await page.evaluate(() => {
                const panel = document.getElementById('article-reading-panel');
                const list = [...panel.querySelectorAll('button, input, textarea, select, summary, a[href]')]
                    .filter(el => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length
                        && !el.closest('details:not([open]) > :not(summary)')
                        && el.checkVisibility?.({ checkVisibilityCSS: true, contentVisibilityAuto: true }) !== false);
                const describe = el => (el?.tagName || '').toLowerCase()
                    + (el?.id ? `#${el.id}` : '')
                    + (typeof el?.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).join('.')}` : '');
                return {
                    count: list.length,
                    first: describe(list[0]),
                    last: describe(list.at(-1)),
                    lastTag: list.at(-1)?.tagName || '',
                    lastText: (list.at(-1)?.textContent || '').trim().slice(0, 24),
                    hiddenMenuButtonsIncluded: list.some(el => el.closest('.reading-tools-menu')),
                    toolsOpen: document.querySelector('.reading-tools')?.open
                };
            });
            assert(targets.first === 'button.reading-panel-close', '第一個 Tab 目標不是關閉按鈕', targets);
            assert(targets.lastTag === 'SUMMARY', '收起時最後一個 Tab 目標不是「更多」summary', targets);
            assert(!targets.hiddenMenuButtonsIncluded, '收起的「更多」選單按鈕仍被算進 Tab 目標', targets);

            // 收起：summary Tab → close
            await page.locator('.reading-tools').evaluate(el => { el.open = false; });
            await page.locator('.reading-tools > summary').focus();
            await page.keyboard.press('Tab');
            const closedTab = await active(page);
            assert(closedTab.cls.split(/\s+/).includes('reading-panel-close'), '收起時 summary Tab 未回繞到 close', closedTab);

            // 收起：close Shift+Tab → summary（最後一個可見控件）
            await page.keyboard.press('Shift+Tab');
            const closedShift = await page.evaluate(() => {
                const a = document.activeElement;
                return {
                    tag: a?.tagName || null,
                    isToolsSummary: a === document.querySelector('.reading-tools > summary'),
                    inPanel: !!a?.closest?.('#article-reading-panel'),
                    isBody: a === document.body
                };
            });
            assert(closedShift.isToolsSummary, '收起時 close Shift+Tab 未回繞到「更多」summary', closedShift);

            // 收起：清單中途的 Tab 不被攔截（防止新過濾條件誤判 last 造成中途卡住）
            await page.locator('#reading-saved-only').focus();
            await page.keyboard.press('Tab');
            const midForward = await active(page);
            assert(midForward.id === 'reading-sort', '清單中途 Tab 未前進到下一控件', midForward);
            await page.locator('#reading-export-md').focus();
            await page.keyboard.press('Shift+Tab');
            const midBackward = await active(page);
            assert(midBackward.id === 'reading-article-note', '清單中途 Shift+Tab 未退回上一控件', midBackward);

            // 展開：最後一個 AI 工具 Tab → close
            await page.locator('.reading-tools > summary').click();
            await page.locator('#reading-ai-notes').focus();
            const lastInfo = await page.evaluate(() => {
                const panel = document.getElementById('article-reading-panel');
                const list = [...panel.querySelectorAll('button, input, textarea, select, summary, a[href]')]
                    .filter(el => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length
                        && !el.closest('details:not([open]) > :not(summary)')
                        && el.checkVisibility?.({ checkVisibilityCSS: true, contentVisibilityAuto: true }) !== false);
                return { count: list.length, lastId: list.at(-1)?.id || '', toolsOpen: document.querySelector('.reading-tools')?.open };
            });
            assert(lastInfo.toolsOpen, '「更多」選單未展開', lastInfo);
            assert(lastInfo.lastId === 'reading-ai-notes', '展開時最後一個 Tab 目標不是最後一個 AI 工具', lastInfo);
            await page.keyboard.press('Tab');
            const openTab = await active(page);
            assert(openTab.cls.split(/\s+/).includes('reading-panel-close'), '展開時最後一個 AI 工具 Tab 未回繞到 close', openTab);

            // 展開：close Shift+Tab → 最後一個 AI 工具
            await page.keyboard.press('Shift+Tab');
            const openShift = await active(page);
            assert(openShift.id === 'reading-ai-notes', '展開時 close Shift+Tab 未回繞到最後一個 AI 工具', openShift);

            const bodyStops = [closedTab, closedShift, openTab, openShift].filter(info => info.tag === 'BODY' || info.isBody).length;
            assert(bodyStops === 0, '回繞過程焦點仍落到 body', { closedTab, closedShift, openTab, openShift });

            const extraTab = await page.evaluate(() => { document.querySelector('.reading-tools').open = false; return true; });
            assert(extraTab, '狀態重設失敗');
            const image = [390, 1024].includes(width) && ((locale === 'zh-CN' && width === 390) || (locale === 'zh-HK' && width === 1024))
                ? await shot(page, `n1-${locale}-${width}-wrap`) : null;
            return {
                modal, targets, lastWhenOpen: lastInfo,
                closedTabTo: closedTab, closedShiftTo: closedShift,
                midForwardTo: midForward, midBackwardTo: midBackward,
                openTabTo: openTab, openShiftTo: openShift,
                bodyStops, screenshot: image
            };
        });
        observations.pageErrors.push({ id, errors: errors.slice() });
        assert(errors.length === 0, 'N1 期間出現 pageerror', errors);
        await context.close();
        return detail;
    } catch (error) {
        observations.pageErrors.push({ id, errors: errors.slice() });
        await context.close();
        throw error;
    }
}

// ── N2：保存失敗 → 真實滑鼠按住重試 ─────────────────────────
async function prepareFailure(page, itemId, text, strings) {
    const expand = page.locator(`[data-item-id="${itemId}"] [data-action="expand"]`);
    if (await expand.getAttribute('aria-expanded') !== 'true') await expand.click();
    await page.locator(`[data-note-id="${itemId}"]`).waitFor({ timeout: 8000 });
    await page.evaluate(async () => {
        const actions = await import('/modules/reading-actions.js');
        window.__noteSaveCalls = [];
        window.__noteSaveFails = true;
        actions.__setNoteSaveInterceptorForTests(({ itemId: id, note }) => {
            window.__noteSaveCalls.push({ itemId: id, note });
            return window.__noteSaveFails ? { ok: false, error: 'synthetic_failure' } : null;
        });
    });
    await page.locator(`[data-note-id="${itemId}"]`).fill(text);
    await page.waitForFunction(([id, failed]) => document.querySelector(`[data-note-status="${id}"]`)?.textContent?.includes(failed), [itemId, strings.failed], { timeout: 10000 });
    await page.evaluate(() => { window.__noteSaveFails = false; });
}
async function noteState(page, itemId) {
    return page.evaluate(id => {
        const a = document.activeElement;
        const area = document.querySelector(`[data-note-id="${id}"]`);
        return {
            status: document.querySelector(`[data-note-status="${id}"]`)?.textContent?.trim() || '',
            hasRetry: !!document.querySelector(`[data-note-status="${id}"] [data-note-retry]`),
            retryConnected: !!document.querySelector(`[data-note-status="${id}"] [data-note-retry]`)?.isConnected,
            focusTag: a?.tagName || null,
            focusNoteId: a?.getAttribute?.('data-note-id') || '',
            focusIsRetry: !!a?.hasAttribute?.('data-note-retry'),
            focusInPanel: !!a?.closest?.('#article-reading-panel'),
            noteValue: area?.value ?? null,
            notePresent: !!area,
            sameNode: !!area?.__finalProbe,
            saveCalls: (window.__noteSaveCalls || []).length
        };
    }, itemId);
}
async function scenarioN2(browser, locale, width) {
    const strings = STRINGS[locale];
    const { context, page, fixture, errors } = await openAt(browser, width, locale);
    const itemId = fixture.ids[3];
    const id = `N2-${locale}-${width}`;
    try {
        const detail = await record(observations.n2, id, `${width}px/${locale}：合成保存失敗→解除失敗→真實滑鼠按住重試 ≥100ms→放開後同一 textarea 取得焦點、狀態「${strings.saved}」、store 一致`, async () => {
            const text = `Final retry ${locale} ${width} ${Date.now()}`;
            await prepareFailure(page, itemId, text, strings);
            const before = await noteState(page, itemId);
            assert(before.hasRetry, '失敗時沒有重試按鈕', before);
            assert(before.focusNoteId === itemId, '失敗時 textarea 未持有焦點', before);
            assert(before.status.includes(strings.failed), '狀態未顯示保存失敗', before);
            await page.evaluate(id => { document.querySelector(`[data-note-id="${id}"]`).__finalProbe = true; }, itemId);
            await page.evaluate(() => { window.__noteSaveCalls = []; });

            const retry = page.locator(`[data-note-status="${itemId}"] [data-note-retry]`);
            await retry.scrollIntoViewIfNeeded();
            const box = await retry.boundingBox();
            assert(box && box.width > 0 && box.height > 0, '重試按鈕沒有可點擊面積', box);
            const cx = box.x + box.width / 2;
            const cy = box.y + box.height / 2;
            const hit = await page.evaluate(([x, y]) => {
                const el = document.elementFromPoint(x, y);
                return { tag: el?.tagName || null, isRetry: !!el?.hasAttribute?.('data-note-retry'), id: el?.id || '' };
            }, [cx, cy]);
            assert(hit.isRetry, '滑鼠位置命中的不是重試按鈕', hit);

            await page.mouse.move(cx, cy);
            await page.mouse.down();
            await page.waitForTimeout(140);
            const held = await noteState(page, itemId);
            const heldImage = (locale === 'zh-CN' && width === 1440) || (locale === 'zh-HK' && width === 390)
                ? await shot(page, `n2-${locale}-${width}-held`) : null;
            assert(held.focusIsRetry && held.retryConnected, '按住期間重試按鈕已被替換／未取得焦點（blur 先保存重繪）', held);
            assert(held.noteValue === text, '按住期間 textarea 內容已變', held);

            await page.mouse.up();
            const saved = await page.waitForFunction(async ({ id: noteId, expected, savedText }) => {
                const rd = await import('/modules/reading-store.js');
                const area = document.querySelector(`[data-note-id="${noteId}"]`);
                const status = document.querySelector(`[data-note-status="${noteId}"]`)?.textContent?.trim() || '';
                return rd.getLearningItem(noteId)?.note === expected
                    && status === savedText
                    && document.activeElement === area
                    && area.value === expected;
            }, { id: itemId, expected: text, savedText: strings.saved }, { timeout: 10000 }).then(() => true).catch(() => false);
            const after = await noteState(page, itemId);
            const stored = await page.evaluate(async noteId => (await import('/modules/reading-store.js')).getLearningItem(noteId)?.note || '', itemId);
            const savedImage = (locale === 'zh-CN' && width === 1440) || (locale === 'zh-HK' && width === 390)
                ? await shot(page, `n2-${locale}-${width}-saved`) : null;

            assert(saved, 'mouseup 後未同時滿足：store 寫入、狀態已保存、textarea 取得焦點', { after, storedOk: stored === text });
            assert(after.focusNoteId === itemId, 'mouseup 後焦點不在同一 textarea', after);
            assert(after.sameNode, 'mouseup 後 textarea 節點已被替換（非同一個 DOM 節點）', after);
            assert(after.noteValue === text, 'mouseup 後 textarea 內容不符', after);
            assert(stored === text, 'store 值與輸入不一致', { stored, text });
            assert(after.status === strings.saved, '狀態不是已保存', after);
            assert(!after.hasRetry, '成功後仍顯示重試按鈕', after);
            assert(after.saveCalls >= 1, 'mouseup 後沒有任何保存呼叫', after);

            await page.evaluate(async () => {
                const actions = await import('/modules/reading-actions.js');
                actions.__setNoteSaveInterceptorForTests(null);
            });
            return {
                before, held, after, storedOk: stored === text,
                saveCallsAfterRelease: after.saveCalls,
                heldScreenshot: heldImage, savedScreenshot: savedImage
            };
        });
        observations.pageErrors.push({ id, errors: errors.slice() });
        assert(errors.length === 0, 'N2 期間出現 pageerror', errors);
        await context.close();
        return detail;
    } catch (error) {
        observations.pageErrors.push({ id, errors: errors.slice() });
        await context.close();
        throw error;
    }
}

// ── N2 鍵盤回歸：Tab 到重試 → Enter 保存並還焦點 ──────────────
async function scenarioKeyboard(browser, locale = 'zh-CN', width = 1440) {
    const strings = STRINGS[locale];
    const { context, page, fixture, errors } = await openAt(browser, width, locale);
    const itemId = fixture.ids[1];
    const id = `N2-${locale}-${width}-keyboard`;
    try {
        const detail = await record(observations.keyboard, id, `${width}px/${locale}：鍵盤由 textarea Tab 到重試再 Enter，保存成功且焦點回到同一 textarea（無退化）`, async () => {
            const text = `Keyboard retry ${locale} ${width} ${Date.now()}`;
            await prepareFailure(page, itemId, text, strings);
            const before = await noteState(page, itemId);
            assert(before.focusNoteId === itemId, '失敗時 textarea 未持有焦點', before);
            await page.evaluate(id => { document.querySelector(`[data-note-id="${id}"]`).__finalProbe = true; }, itemId);
            await page.evaluate(() => { window.__noteSaveCalls = []; });
            const sequence = [];
            let reached = false;
            for (let i = 0; i < 6; i += 1) {
                await page.keyboard.press('Tab');
                const info = await active(page);
                sequence.push({ step: i, tag: info.tag, id: info.id, isRetry: info.isRetry, noteId: info.noteId });
                if (info.isRetry) { reached = true; break; }
            }
            assert(reached, 'Tab 無法到達重試按鈕', sequence);
            const callsBeforeEnter = await page.evaluate(() => (window.__noteSaveCalls || []).length);
            await page.keyboard.press('Enter');
            const ok = await page.waitForFunction(async ({ noteId, expected, savedText }) => {
                const rd = await import('/modules/reading-store.js');
                const area = document.querySelector(`[data-note-id="${noteId}"]`);
                return rd.getLearningItem(noteId)?.note === expected
                    && document.querySelector(`[data-note-status="${noteId}"]`)?.textContent?.trim() === savedText
                    && document.activeElement === area;
            }, { noteId: itemId, expected: text, savedText: strings.saved }, { timeout: 10000 }).then(() => true).catch(() => false);
            const after = await noteState(page, itemId);
            assert(ok, 'Enter 觸發重試後未保存或未還焦點', after);
            assert(after.focusNoteId === itemId, 'Enter 後焦點不在 textarea', after);
            assert(after.sameNode, 'Enter 後 textarea 節點已被替換', after);
            assert(after.status === strings.saved, '狀態不是已保存', after);
            await page.evaluate(async () => {
                const actions = await import('/modules/reading-actions.js');
                actions.__setNoteSaveInterceptorForTests(null);
            });
            return { tabSequence: sequence, callsBeforeEnter, after };
        });
        observations.pageErrors.push({ id, errors: errors.slice() });
        assert(errors.length === 0, '鍵盤案例期間出現 pageerror', errors);
        await context.close();
        return detail;
    } catch (error) {
        observations.pageErrors.push({ id, errors: errors.slice() });
        await context.close();
        throw error;
    }
}

(async () => {
    // 前置：確認伺服器提供的就是本次要驗的產品碼（避免驗到別的 checkout／快取）。
    const served = {};
    for (const asset of ['/features/article/reading-panel.js', '/locales/zh-CN.js', '/locales/zh-HK.js', '/index.html']) {
        const response = await fetch(new URL(asset, BASE));
        const servedHash = crypto.createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');
        const localHash = crypto.createHash('sha256').update(fs.readFileSync(path.join('/Users/linus/CODE/bdc', asset))).digest('hex');
        served[asset] = { status: response.status, servedHash, localHash, match: servedHash === localHash };
    }
    observations.servedAssets = served;
    const mismatch = Object.entries(served).filter(([, info]) => !info.match || info.status !== 200);
    if (mismatch.length) {
        console.error('伺服器提供的資產與工作區不一致，中止：' + JSON.stringify(mismatch));
        process.exitCode = 2;
        fs.writeFileSync(path.join(ASSET_DIR, 'n1n2-final-observations.json'), JSON.stringify(observations, null, 2));
        return;
    }
    const browser = await chromium.launch({ executablePath: CHROME, headless: true });
    observations.chromeVersion = browser.version();
    const run = async (label, work) => {
        try {
            await work();
        } catch (error) {
            const message = String((error && error.message) || error);
            observations.scenarioErrors.push({ label, message });
            failures.push({ id: label, name: '情境初始化失敗', status: 'error', detail: message });
            console.error(`ERR  [${label}] ${message}`);
        }
    };
    try {
        for (const locale of LOCALES) {
            for (const width of [390, 1024]) {
                await run(`N1-${locale}-${width}`, () => scenarioN1(browser, locale, width));
            }
        }
        for (const locale of LOCALES) {
            for (const width of [1440, 390]) {
                await run(`N2-${locale}-${width}`, () => scenarioN2(browser, locale, width));
            }
        }
        await run('N2-zh-CN-1440-keyboard', () => scenarioKeyboard(browser));
    } finally {
        await browser.close();
    }
    observations.finishedAt = new Date().toISOString();
    observations.assertions = assertions;
    observations.failures = failures;
    observations.pageErrorEntries = observations.pageErrors.filter(entry => entry.errors.length);
    const all = [...observations.n1, ...observations.n2, ...observations.keyboard];
    observations.summary = {
        cases: all.length,
        passed: all.filter(entry => entry.status === 'pass').length,
        failed: all.filter(entry => entry.status !== 'pass').length,
        n1: observations.n1.map(entry => entry.status),
        n2: observations.n2.map(entry => entry.status),
        keyboard: observations.keyboard.map(entry => entry.status)
    };
    const out = path.join(ASSET_DIR, 'n1n2-final-observations.json');
    fs.writeFileSync(out, JSON.stringify(observations, null, 2));
    console.log('\n' + JSON.stringify(observations.summary));
    console.log('assertions=' + assertions + ' failures=' + failures.length);
    console.log('json=' + out);
    process.exitCode = failures.length ? 1 : 0;
})();
