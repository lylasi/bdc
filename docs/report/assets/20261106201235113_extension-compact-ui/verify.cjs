// 擴充套件介面美化：真 MV3 截圖與版面量測（本輪 UI 交付自檢，不改 tests/）。
// 用法：PLAYWRIGHT_MODULE=<playwright> node "docs/report/assets/20261106201235113_extension-compact-ui/verify.cjs"
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const ROOT = path.resolve(__dirname, '../../../..');
const { environment, ALICE } = require(path.join(ROOT, 'tests/helpers/extension-mv3.cjs'));
const OUT = __dirname;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const results = { checks: [], notes: [], screenshots: [], console: [] };
const check = (name, ok, detail) => {
    results.checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' :: ' + JSON.stringify(detail)}`);
};
const note = (name, value) => {
    results.notes.push({ name, value });
    console.log(`NOTE ${name}: ${JSON.stringify(value)}`);
};

async function waitUntil(predicate, { timeout = 8000, interval = 100 } = {}) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
        const value = await predicate();
        if (value) return value;
        await sleep(interval);
    }
    return null;
}
const livePanels = (page, base) => page.frames().filter((frame) => frame.url().startsWith(base + '/lookup.html') && !frame.isDetached());
async function waitForPanel(page, base, timeout = 25000) {
    return waitUntil(() => { const list = livePanels(page, base); return list.length ? list[list.length - 1] : null; }, { timeout });
}

async function shellButtons(cdp) {
    let root;
    try { ({ root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true })); } catch (_) { return []; }
    const nodes = [];
    const walk = (node) => {
        if (node.nodeName === 'BUTTON') nodes.push(node);
        for (const child of node.children || []) walk(child);
        for (const shadow of node.shadowRoots || []) walk(shadow);
        if (node.contentDocument) walk(node.contentDocument);
    };
    walk(root);
    const visible = [];
    for (const node of nodes) {
        const model = await cdp.send('DOM.getBoxModel', { backendNodeId: node.backendNodeId }).then((r) => r.model).catch(() => null);
        if (!model || model.width < 20 || model.height < 16) continue;
        visible.push({
            center: { x: (model.border[0] + model.border[2] + model.border[4] + model.border[6]) / 4, y: (model.border[1] + model.border[3] + model.border[5] + model.border[7]) / 4 },
            box: { x: model.border[0], y: model.border[1], width: model.width, height: model.height }
        });
    }
    return visible;
}
async function selectionRect(page, word) {
    return page.evaluate((needle) => {
        const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
            const text = node.textContent || '';
            const index = text.indexOf(needle);
            if (index === -1) continue;
            const range = document.createRange();
            range.setStart(node, index); range.setEnd(node, index + needle.length);
            const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
            if (rects.length) { const union = range.getBoundingClientRect(); return { x: union.x, y: union.y, width: union.width, height: union.height }; }
        }
        return null;
    }, word);
}
async function selectAndLookup(page, cdp, word) {
    const rect = await selectionRect(page, word);
    if (!rect) return null;
    await page.mouse.move(rect.x + 1, rect.y + rect.height / 2);
    await page.mouse.down();
    await page.mouse.move(rect.x + Math.max(1, rect.width - 1), rect.y + rect.height / 2, { steps: 10 });
    await page.mouse.up();
    await sleep(200);
    const buttons = await shellButtons(cdp);
    if (!buttons.length) return { rect, clicked: false };
    const anchorX = rect.x + Math.min(rect.width / 2, 40);
    const anchorY = rect.y + rect.height + 18;
    const chosen = buttons.map((b) => ({ ...b, d: Math.hypot(b.center.x - anchorX, b.center.y - anchorY) })).sort((a, b) => a.d - b.d)[0];
    await page.mouse.click(chosen.center.x, chosen.center.y);
    return { rect, clicked: true, button: chosen.box };
}
async function frameState(frame) {
    return frame.evaluate(() => {
        const el = (id) => document.getElementById(id);
        const visible = (id) => {
            const node = el(id);
            if (!node || node.hidden) return false;
            const style = getComputedStyle(node);
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
            return node.getClientRects().length > 0;
        };
        const text = (id) => (el(id)?.textContent || '').trim();
        const select = el('ext-capture-book');
        return {
            classes: [...document.body.classList],
            compact: document.body.classList.contains('ext-compact'),
            expanded: document.body.classList.contains('ext-expanded'),
            needsBook: document.body.classList.contains('ext-needs-book'),
            word: text('ext-result-word'),
            phonetic: text('ext-result-phonetic'),
            pos: text('ext-result-pos'),
            meaning: text('ext-result-meaning'),
            accountStatus: text('ext-account-status'),
            accountSection: visible('ext-account-section'),
            accountSummaryVisible: visible('ext-account-summary'),
            more: visible('ext-inline-more'), back: visible('ext-inline-back'),
            edit: visible('ext-inline-edit'), settings: visible('ext-inline-settings'), close: visible('ext-inline-close'),
            quickCapture: visible('ext-quick-capture'), captureSave: visible('ext-capture-save'),
            captureBookVisible: visible('ext-capture-book'),
            captureBookPlaceholder: (select?.options?.[0]?.textContent || '').trim(),
            captureNotice: text('ext-capture-notice'),
            captureNoticeVisible: visible('ext-capture-notice'),
            articleExtract: visible('ext-article-extract'), bookPage: visible('ext-book-page'),
            capturePendingVisible: visible('ext-capture-pending'),
            inlineStatusVisible: visible('ext-inline-status'),
            lookupVisible: visible('ext-lookup-section'),
            resultDetailsVisible: visible('ext-result-details'),
            innerWidth: window.innerWidth, innerHeight: window.innerHeight,
            scrollWidth: document.documentElement.scrollWidth,
            contentHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
            bodyText: (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 600)
        };
    }).catch((error) => ({ error: String(error?.message || error) }));
}
async function waitForResult(frame, timeout = 45000) {
    return !!(await waitUntil(async () => {
        if (!frame || frame.isDetached()) return false;
        const state = await frameState(frame);
        return !!(state && state.word && state.meaning);
    }, { timeout }));
}

(async () => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-ui-shot-'));
    let env;
    let context;
    try {
        env = await environment();
        const extension = path.join(ROOT, 'extension');
        context = await chromium.launchPersistentContext(profile, {
            channel: 'chromium', headless: true, viewport: { width: 1280, height: 900 },
            args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
        });
        context.on('page', (target) => {
            target.on('pageerror', (error) => results.console.push({ page: String(target.url()).slice(0, 80), error: error.message }));
        });
        const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
        const base = `chrome-extension://${new URL(worker.url()).host}`;

        /* ---------------- 帳戶／設定頁 ---------------- */
        const popup = await context.newPage();
        await popup.setViewportSize({ width: 420, height: 900 });
        await popup.goto(base + '/lookup.html');
        await popup.waitForFunction(() => !!document.querySelector('#ext-account-status').textContent);
        const shot = async (target, name) => {
            const file = path.join(OUT, name + '.png');
            await target.screenshot({ path: file }).catch(() => {});
            results.screenshots.push(name + '.png');
            return name + '.png';
        };
        const pageMetrics = () => popup.evaluate(() => ({
            scrollWidth: document.documentElement.scrollWidth,
            innerWidth: window.innerWidth,
            bodyWidth: document.body.getBoundingClientRect().width,
            detailsOpen: document.getElementById('ext-account-details')?.open,
            accountStatusVisible: (() => {
                const node = document.getElementById('ext-account-status');
                return !!node && node.getClientRects().length > 0;
            })(),
            tokenFieldsDisplay: getComputedStyle(document.getElementById('ext-mode-token-fields')).display,
            tokenInputVisible: document.getElementById('ext-token-input').getClientRects().length > 0,
            height: document.documentElement.scrollHeight
        }));

        await waitUntil(() => popup.evaluate(() => !!document.querySelector('#ext-account-status').textContent.trim()), { timeout: 8000 });
        await shot(popup, 'account-zh-CN-420-logged-out');
        const loggedOut = await pageMetrics();
        check('帳戶頁未登入：無橫向溢出（420px）', loggedOut.scrollWidth <= loggedOut.innerWidth + 1, loggedOut);
        check('帳戶頁未登入：帳戶摘要與狀態列可見', loggedOut.detailsOpen === true && loggedOut.accountStatusVisible === true, loggedOut);
        check('帳戶頁未登入：非當前登入方式的欄位確實隱藏（.hidden 可靠）',
            loggedOut.tokenFieldsDisplay === 'none' && loggedOut.tokenInputVisible === false,
            { display: loggedOut.tokenFieldsDisplay, visible: loggedOut.tokenInputVisible });

        await popup.setViewportSize({ width: 320, height: 900 });
        await sleep(200);
        await shot(popup, 'account-zh-CN-320-logged-out');
        const narrow = await pageMetrics();
        check('帳戶頁未登入：320px 無橫向溢出', narrow.scrollWidth <= narrow.innerWidth + 1, narrow);
        await popup.setViewportSize({ width: 420, height: 900 });

        await popup.locator('#ext-endpoint-input').fill(env.base);
        await popup.locator('#ext-login-mode').selectOption('token');
        await popup.locator('#ext-token-input').fill(ALICE);
        await popup.locator('#ext-connect-btn').click();
        await popup.waitForFunction(() => !document.querySelector('#ext-connect-btn').disabled
            && /已连接账户/.test(document.querySelector('#ext-account-status').textContent), null, { timeout: 30000 });
        await sleep(400);
        await shot(popup, 'account-zh-CN-420-logged-in');
        const loggedIn = await pageMetrics();
        check('帳戶頁已登入：狀態列顯示帳戶且不溢出', loggedIn.accountStatusVisible === true && loggedIn.scrollWidth <= loggedIn.innerWidth + 1, loggedIn);
        // 模擬 lookup.js 之後的「登入後收合」：只切 open，不動任何邏輯
        const collapsed = await popup.evaluate(() => {
            const details = document.getElementById('ext-account-details');
            details.open = false;
            const status = document.getElementById('ext-account-status');
            const rect = status.getBoundingClientRect();
            return { open: details.open, statusVisible: status.getClientRects().length > 0, statusWidth: Math.round(rect.width), height: document.documentElement.scrollHeight };
        });
        await sleep(200);
        await shot(popup, 'account-zh-CN-420-collapsed');
        check('帳戶收合後：#ext-account-status 仍在收合外可見', collapsed.open === false && collapsed.statusVisible === true, collapsed);
        note('收合後設定頁高度', collapsed.height);
        await popup.evaluate(() => { document.getElementById('ext-account-details').open = true; });

        // zh-HK
        await popup.locator('#ext-locale-select').selectOption('zh-HK');
        await sleep(400);
        await popup.evaluate(() => { document.getElementById('ext-account-details').open = false; });
        await shot(popup, 'account-zh-HK-420-collapsed');
        check('zh-HK 設定頁：切換語言後無溢出', (await pageMetrics()).scrollWidth <= 421, await pageMetrics());
        await popup.evaluate(() => { document.getElementById('ext-account-details').open = true; });

        /* ---------------- 小窗／完整面板 ---------------- */
        const article = await context.newPage();
        const cdp = await context.newCDPSession(article);
        const openPanel = async (viewport, word) => {
            await article.setViewportSize(viewport);
            await article.goto(env.base + '/test-article?ui=' + encodeURIComponent(word) + '&w=' + viewport.width);
            await article.waitForFunction(() => !!document.querySelector('#article'));
            await article.bringToFront();
            await sleep(150);
            const opened = await selectAndLookup(article, cdp, word);
            if (!opened?.clicked) return null;
            const frame = await waitForPanel(article, base);
            if (frame) await waitForResult(frame);
            return frame;
        };
        const setLocale = async (locale) => {
            await popup.bringToFront();
            await popup.locator('#ext-locale-select').selectOption(locale);
            await sleep(350);
            await article.bringToFront();
        };
        const panelShot = async (frame, name) => {
            const element = await frame.frameElement();
            await element.screenshot({ path: path.join(OUT, name + '.png') });
            results.screenshots.push(name + '.png');
        };
        const panelBox = async (frame) => (await frame.frameElement()).boundingBox();
        const waitForFit = async (frame, timeout = 5000) => waitUntil(async () => {
            const state = await frameState(frame);
            return state && state.contentHeight <= state.innerHeight + 2 ? state : null;
        }, { timeout });
        const closePanel = async () => {
            await article.keyboard.press('Escape').catch(() => {});
            await waitUntil(() => livePanels(article, base).length === 0, { timeout: 5000 });
        };

        for (const locale of ['zh-CN', 'zh-HK']) {
            await setLocale(locale);
            for (const [label, viewport] of [['340', { width: 720, height: 800 }], ['320', { width: 336, height: 760 }]]) {
                const frame = await openPanel(viewport, 'plunge');
                if (!frame) { check(`${locale} 小窗 ${label}px：可開啟`, false); continue; }
                const settled = await waitForFit(frame);
                const state = settled || await frameState(frame);
                const box = await panelBox(frame);
                await panelShot(frame, `compact-${locale}-${label}`);
                await shot(article, `compact-${locale}-${label}-page`);
                check(`小窗 ${locale} ${label}px：無橫向溢出`, state.scrollWidth <= state.innerWidth + 1,
                    { scrollWidth: state.scrollWidth, innerWidth: state.innerWidth });
                check(`小窗 ${locale} ${label}px：實際寬度約 ${Math.round(box.width)}`,
                    Math.abs(box.width - Math.round(box.width)) < 1 && box.width >= 300 && box.width <= 342,
                    { box: { width: Math.round(box.width), height: Math.round(box.height) } });
                check(`小窗 ${locale} ${label}px：內容完整塞進卡片（無內部捲動）`,
                    !!settled, { contentHeight: state.contentHeight, innerHeight: state.innerHeight });
                check(`小窗 ${locale} ${label}px：工具列入口（更多／編輯選詞／帳戶設定／關閉）都在，返回不顯示`,
                    state.more && state.edit && state.settings && state.close && state.back !== true && !!state.word
                    && (state.quickCapture || state.captureSave),
                    { more: state.more, back: state.back, edit: state.edit, settings: state.settings, close: state.close,
                        quick: state.quickCapture, save: state.captureSave });
                note(`小窗 ${locale} ${label}px 尺寸`, { box: { width: Math.round(box.width), height: Math.round(box.height) }, content: state.contentHeight, viewport: viewport });
                await closePanel();
            }
        }

        // 收藏成功／失敗狀態（zh-CN 340）
        await setLocale('zh-CN');
        let frame = await openPanel({ width: 720, height: 800 }, 'plunge');
        if (frame) {
            const before = await frameState(frame);
            const quick = before.quickCapture ? '#ext-quick-capture' : '#ext-capture-save';
            env.state.failCaptures = true;
            await frame.locator(quick).click({ timeout: 8000 }).catch(() => {});
            const failed = await waitUntil(async () => {
                const state = await frameState(frame);
                return state.captureNotice && state.captureNoticeVisible ? state : null;
            }, { timeout: 20000 });
            await panelShot(frame, 'compact-zh-CN-340-capture-error');
            check('小窗收藏失敗：錯誤提示在卡片內可見（不藏在收合內）', !!failed, failed?.captureNotice);
            // 先看失敗後的待傳清單（展開面板），再回到小窗重試成功
            await frame.locator('#ext-inline-more').click({ timeout: 5000 }).catch(() => {});
            await waitUntil(async () => (await frameState(frame)).expanded, { timeout: 8000 });
            await frame.evaluate(() => {
                for (const id of ['ext-capture-pending', 'ext-workspace-pending']) {
                    const node = document.getElementById(id);
                    if (node && 'open' in node) node.open = true;
                }
            });
            await sleep(300);
            const pendingState = await frameState(frame);
            await panelShot(frame, 'expanded-zh-CN-420-pending');
            check('完整面板：收藏失敗後待傳清單可見且不溢出',
                pendingState.capturePendingVisible === true && pendingState.scrollWidth <= pendingState.innerWidth + 1,
                { pending: pendingState.capturePendingVisible, scrollWidth: pendingState.scrollWidth, innerWidth: pendingState.innerWidth });
            await frame.locator('#ext-inline-back').click({ timeout: 5000 }).catch(() => {});
            await waitUntil(async () => (await frameState(frame)).compact, { timeout: 8000 });
            env.state.failCaptures = false;
            const retryState = await frameState(frame);
            const retrySelector = retryState.quickCapture ? '#ext-quick-capture' : (retryState.captureSave ? '#ext-capture-save' : '');
            if (retrySelector) await frame.locator(retrySelector).click({ timeout: 8000 }).catch(() => {});
            const saved = await waitUntil(async () => {
                const state = await frameState(frame);
                return /已加入/.test(state.captureNotice || '') ? state : null;
            }, { timeout: 25000 });
            await panelShot(frame, 'compact-zh-CN-340-capture-saved');
            check('小窗收藏成功：成功提示可見', !!saved, { notice: saved?.captureNotice, selector: retrySelector });
            await closePanel();
        }

        // 未保存草稿的確認對話框
        await setLocale('zh-CN');
        frame = await openPanel({ width: 1280, height: 900 }, 'volatile');
        if (frame) {
            await frame.locator('#ext-inline-edit').click({ timeout: 5000 }).catch(() => {});
            await sleep(300);
            await frame.locator('#ext-word-input').fill('volatile markets', { timeout: 5000 }).catch(() => {});
            await sleep(200);
            await frame.locator('#ext-inline-close').click({ timeout: 5000 }).catch(() => {});
            const confirmState = await waitUntil(async () => {
                const visible = await frame.evaluate(() => {
                    const node = document.getElementById('ext-inline-confirm');
                    return !!node && !node.hidden && node.getClientRects().length > 0;
                });
                return visible ? frameState(frame) : null;
            }, { timeout: 8000 });
            await panelShot(frame, 'expanded-zh-CN-confirm');
            check('草稿確認對話框：出現在卡片內且不溢出',
                !!confirmState && confirmState.scrollWidth <= confirmState.innerWidth + 1,
                { confirm: !!confirmState, scrollWidth: confirmState?.scrollWidth, innerWidth: confirmState?.innerWidth });
            await frame.locator('#ext-inline-keep').click({ timeout: 5000 }).catch(() => {});
            await sleep(300);
            // 保留後面板仍在：再按關閉 → 放棄並關閉，確認對話框不影響後續
            await frame.locator('#ext-inline-close').click({ timeout: 5000 }).catch(() => {});
            await waitUntil(() => frame.evaluate(() => !document.getElementById('ext-inline-confirm').hidden).catch(() => false), { timeout: 8000 });
            await frame.locator('#ext-inline-discard').click({ timeout: 5000 }).catch(() => {});
            await waitUntil(() => livePanels(article, base).length === 0, { timeout: 8000 });
        }

        // 完整面板（420）
        for (const locale of ['zh-CN', 'zh-HK']) {
            await setLocale(locale);
            frame = await openPanel({ width: 1280, height: 900 }, 'volatile');
            if (!frame) { check(`${locale} 完整面板：可開啟`, false); continue; }
            await frame.locator('#ext-inline-more').click({ timeout: 5000 }).catch(() => {});
            await waitUntil(async () => (await frameState(frame)).expanded, { timeout: 8000 });
            const state = await frameState(frame);
            const box = await panelBox(frame);
            await panelShot(frame, `expanded-${locale}-420`);
            await shot(article, `expanded-${locale}-420-page`);
            check(`完整面板 ${locale}：寬 420、無橫向溢出、高度夾限`,
                Math.abs(box.width - 420) <= 1 && state.scrollWidth <= state.innerWidth + 1 && box.height <= 900,
                { box: { width: Math.round(box.width), height: Math.round(box.height) }, scrollWidth: state.scrollWidth, innerWidth: state.innerWidth });
            check(`完整面板 ${locale}：進階操作（建書／文章）仍可見`,
                state.bookPage && state.articleExtract, { bookPage: state.bookPage, articleExtract: state.articleExtract });
            note(`完整面板 ${locale} 尺寸`, { box: { width: Math.round(box.width), height: Math.round(box.height) } });
            await closePanel();
        }

        // 完整面板（320）
        await setLocale('zh-CN');
        frame = await openPanel({ width: 344, height: 700 }, 'volatile');
        if (frame) {
            await frame.locator('#ext-inline-more').click({ timeout: 5000 }).catch(() => {});
            await waitUntil(async () => (await frameState(frame)).expanded, { timeout: 8000 });
            const state = await frameState(frame);
            const box = await panelBox(frame);
            await panelShot(frame, 'expanded-zh-CN-320');
            check('完整面板 320px：無橫向溢出且完整留在視窗',
                state.scrollWidth <= state.innerWidth + 1 && box.width <= 322,
                { box: { width: Math.round(box.width), height: Math.round(box.height) }, scrollWidth: state.scrollWidth, innerWidth: state.innerWidth });
            await closePanel();
        }

        /* ---------------- AI 控制區（ai-controls.js 實作，本輪只驗 CSS） ---------------- */
        const aiState = (frame) => frame.evaluate(() => {
            const root = document.getElementById('ext-ai-controls');
            if (!root) return null;
            const summary = root.querySelector('summary');
            const grid = root.querySelector('.ext-ai-grid');
            const columns = grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 0;
            return {
                open: root.open,
                summaryVisible: !!summary && summary.getClientRects().length > 0,
                label: root.querySelector('.ext-ai-summary-label')?.textContent || '',
                value: root.querySelector('.ext-ai-summary-value')?.textContent || '',
                summaryHeight: summary ? Math.round(summary.getBoundingClientRect().height) : 0,
                columns,
                selects: [...root.querySelectorAll('select')].map((select) => select.id),
                notice: document.getElementById('ext-ai-notice')?.textContent || '',
                scrollWidth: document.documentElement.scrollWidth,
                innerWidth: window.innerWidth
            };
        });
        await setLocale('zh-CN');
        for (const [label, viewport, expectedColumns] of [['340', { width: 720, height: 800 }, 2], ['320', { width: 336, height: 760 }, 2]]) {
            const frame = await openPanel(viewport, 'plunge');
            if (!frame) { check(`AI 控制區 小窗 ${label}px：可開啟`, false); continue; }
            await waitForFit(frame);
            const closed = await aiState(frame);
            await panelShot(frame, `ai-controls-compact-${label}-closed`);
            check(`AI 控制區 小窗 ${label}px：預設收合成一行、無橫向溢出`,
                !!closed && closed.summaryVisible && closed.open === false && closed.scrollWidth <= closed.innerWidth + 1,
                closed);
            await frame.evaluate(() => { document.getElementById('ext-ai-controls').open = true; });
            await sleep(300);
            const opened = await aiState(frame);
            const box = await panelBox(frame);
            await panelShot(frame, `ai-controls-compact-${label}-open`);
            check(`AI 控制區 小窗 ${label}px：展開後單欄/雙欄排列且無橫向溢出`,
                !!opened && opened.selects.length === 3 && opened.columns === expectedColumns && opened.scrollWidth <= opened.innerWidth + 1,
                { ...opened, box: { width: Math.round(box.width), height: Math.round(box.height) } });
            await closePanel();
        }
        frame = await openPanel({ width: 1280, height: 900 }, 'volatile');
        if (frame) {
            await frame.locator('#ext-inline-more').click({ timeout: 5000 }).catch(() => {});
            await waitUntil(async () => (await frameState(frame)).expanded, { timeout: 8000 });
            await frame.evaluate(() => { document.getElementById('ext-ai-controls').open = true; });
            await sleep(300);
            const expanded = await aiState(frame);
            await panelShot(frame, 'ai-controls-expanded-420');
            check('AI 控制區 完整面板 420px：三欄排列且無橫向溢出',
                !!expanded && expanded.columns === 3 && expanded.scrollWidth <= expanded.innerWidth + 1, expanded);
            await closePanel();
        }
        await popup.bringToFront();
        const accountAi = await aiState(popup);
        await popup.evaluate(() => { document.getElementById('ext-ai-controls').open = true; });
        await sleep(250);
        const accountAiOpen = await aiState(popup);
        await shot(popup, 'ai-controls-account-420');
        check('AI 控制區 設定頁 420px：三欄且無橫向溢出',
            !!accountAiOpen && accountAiOpen.columns === 3 && accountAiOpen.scrollWidth <= accountAiOpen.innerWidth + 1,
            accountAiOpen);
        note('AI 控制區摘要', accountAi && { label: accountAi.label, value: accountAi.value });

        check('全程沒有未捕獲的頁面錯誤', results.console.length === 0, results.console.slice(0, 3));
    } catch (error) {
        check('執行過程未拋錯', false, String((error && error.stack) || error).slice(0, 2000));
        console.error((error && error.stack) || error);
    } finally {
        const failed = results.checks.filter((item) => !item.ok).length;
        fs.writeFileSync(path.join(OUT, 'verify-results.json'), JSON.stringify({ ...results, summary: { total: results.checks.length, failed } }, null, 2));
        if (context) await context.close().catch(() => {});
        if (env) await env.close().catch(() => {});
        fs.rmSync(profile, { recursive: true, force: true });
        if (failed) process.exitCode = 1;
        console.log(JSON.stringify({ total: results.checks.length, failed, output: OUT }));
    }
})();
