'use strict';
/**
 * 文章學習記錄側欄：第二輪獨立只讀複驗（P1/P2/P3 + O1-O4 + 回歸抽樣）。
 * 只使用隔離 context、合成 fixture、攔截 ai-config，阻擋外部網路；不修改產品程式。
 * PORT=8313 PLAYWRIGHT_MODULE=<pw> node bdc-sidebar-recheck-20261028072437416.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE);
const { createReadingPanelFixture } = require('/Users/linus/CODE/bdc/tests/helpers/reading-panel-fixture.cjs');

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ASSETS = process.env.ASSET_DIR || '';
const checks = [];
const fixtures = [];

function ensure(condition, message) {
    if (!condition) throw new Error(message);
}
function record(entry) {
    checks.push(entry);
    const tag = entry.status === 'pass' ? 'ok  ' : entry.status === 'fail' ? 'FAIL' : 'WARN';
    const detail = entry.detail === undefined ? '' : ' :: ' + (typeof entry.detail === 'string' ? entry.detail : JSON.stringify(entry.detail));
    console.log(`${tag} [${entry.id}] ${entry.name}${detail}`);
}
async function step(id, name, work, { optional = false } = {}) {
    try {
        const detail = await work();
        record({ id, name, status: 'pass', detail });
        return detail;
    } catch (error) {
        record({ id, name, status: optional ? 'warn' : 'fail', detail: String((error && error.message) || error) });
        return null;
    }
}
async function shot(page, name) {
    if (!ASSETS) return;
    try { await page.screenshot({ path: path.join(ASSETS, name + '.png') }); } catch (_) {}
}

async function openAt(browser, width, { locale = 'zh-CN', height = 844, label = '' } = {}) {
    const mobile = width <= 600;
    const fixture = await createReadingPanelFixture(browser, { locale, mobile });
    await fixture.page.setViewportSize({ width, height });
    await fixture.page.waitForTimeout(300);
    fixture.label = label || `${width}-${locale}`;
    fixture.requests = [];
    fixture.page.on('request', request => fixture.requests.push(request.url()));
    fixtures.push(fixture);
    return fixture;
}

async function activeInfo(page) {
    return page.evaluate(() => {
        const a = document.activeElement;
        return {
            tag: a?.tagName || null, id: a?.id || '',
            cls: typeof a?.className === 'string' ? a.className : '',
            inPanel: !!a?.closest?.('#article-reading-panel'),
            inModal: !!a?.closest?.('#app-modal'),
            inOverlay: !!a?.closest?.('.options-modal-overlay'),
            panelHidden: document.getElementById('article-reading-panel')?.classList.contains('hidden'),
            modalHidden: document.getElementById('app-modal')?.classList.contains('hidden')
        };
    });
}

async function menuState(page) {
    return page.evaluate(() => {
        const tools = document.querySelector('.reading-tools');
        const menu = document.querySelector('.reading-tools-menu');
        const rect = menu.getBoundingClientRect();
        const cs = getComputedStyle(menu);
        const clippedBy = [];
        for (let el = menu.parentElement; el && el !== document.body; el = el.parentElement) {
            const style = getComputedStyle(el);
            if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
                const box = el.getBoundingClientRect();
                clippedBy.push({
                    el: el.id || (typeof el.className === 'string' ? el.className : el.tagName),
                    overflow: `${style.overflowX}/${style.overflowY}`,
                    containsMenu: box.top <= rect.top + 0.5 && box.bottom >= rect.bottom - 0.5 && box.left <= rect.left + 0.5 && box.right >= rect.right - 0.5
                });
            }
        }
        const hit = (id) => {
            const button = document.getElementById(id);
            const box = button.getBoundingClientRect();
            const at = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
            return {
                rect: { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) },
                visible: box.width > 0 && box.height > 0,
                insideViewport: box.top >= 0 && box.left >= 0 && box.bottom <= innerHeight + 0.5 && box.right <= innerWidth + 0.5,
                hitSelf: !!at && (at === button || button.contains(at)),
                hitTag: at ? (at.id ? '#' + at.id : at.tagName + '.' + (typeof at.className === 'string' ? at.className : '')) : null
            };
        };
        return {
            open: tools.open,
            toolsOverflow: getComputedStyle(tools).overflow,
            menuRect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
            display: cs.display, visibility: cs.visibility,
            clippedBy,
            exportJson: hit('reading-export-json'),
            aiDiff: hit('reading-ai-difficulties'),
            aiNotes: hit('reading-ai-notes'),
            panelModal: document.body.classList.contains('reading-panel-modal'),
            viewport: { w: innerWidth, h: innerHeight }
        };
    });
}

async function modalState(page) {
    return page.evaluate(() => {
        const modal = document.getElementById('app-modal');
        const panel = document.getElementById('article-reading-panel');
        const content = modal.querySelector('.modal-content');
        const rect = content.getBoundingClientRect();
        const points = [[rect.left + rect.width / 2, rect.top + Math.min(rect.height / 3, 120)], [rect.left + rect.width - 24, rect.bottom - 24]];
        const hits = points.map(([x, y]) => {
            const el = document.elementFromPoint(x, y);
            return { x: Math.round(x), y: Math.round(y), tag: el?.id ? '#' + el.id : el?.tagName, insideModal: !!(el && modal.contains(el)), insidePanel: !!(el && panel.contains(el)) };
        });
        const input = modal.querySelector('#reading-article-note-input');
        let inputHit = null;
        if (input) {
            const box = input.getBoundingClientRect();
            const el = document.elementFromPoint(box.left + Math.min(box.width / 2, 40), box.top + Math.min(box.height / 2, 20));
            inputHit = { tag: el?.id ? '#' + el.id : el?.tagName, insideModal: !!(el && modal.contains(el)) };
        }
        const style = getComputedStyle(modal);
        const inertChildren = Array.from(document.body.children).filter(el => el.inert).map(el => el.id || (typeof el.className === 'string' ? el.className : el.tagName));
        return {
            hidden: modal.classList.contains('hidden'),
            parentId: modal.parentElement?.id || modal.parentElement?.tagName,
            parentIsBody: modal.parentElement === document.body,
            zIndex: style.zIndex, position: style.position, ariaModal: modal.getAttribute('aria-modal'),
            contentRect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
            hits, inputHit,
            modalInert: modal.inert,
            panelInert: panel.inert,
            inertChildren,
            panelHidden: panel.classList.contains('hidden'),
            panelZ: getComputedStyle(panel).zIndex
        };
    });
}

function isLoopback(url) {
    try {
        const host = new URL(url).hostname;
        return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
    } catch (_) { return false; }
}
async function externalHosts(fixture) {
    const resources = await fixture.page.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.name));
    const all = [...resources, ...fixture.requests];
    return [...new Set(all.filter(name => !isLoopback(name)))];
}

async function downloadOf(page, action, target, timeout = 20000) {
    const [download] = await Promise.all([page.waitForEvent('download', { timeout }), action()]);
    await download.saveAs(target);
    return { suggested: download.suggestedFilename(), file: target, bytes: fs.statSync(target).size };
}

// ── S1：P1「更多」選單可見可點 + O4 收起 ───────────────────────────
async function scenarioMenu(browser) {
    for (const width of [320, 390, 834, 1024, 1440]) {
        const fixture = await openAt(browser, width);
        const { page } = fixture;
        await step(`P1-${width}`, `${width}px：「更多」選單可見、未被裁切、三項可命中`, async () => {
            await page.locator('.reading-tools > summary').click();
            const state = await menuState(page);
            ensure(state.open === true, 'details 未展開');
            ensure(state.toolsOverflow === 'visible', `README_overflow=${state.toolsOverflow}`);
            ensure(state.menuRect.w > 120 && state.menuRect.h > 100, `選單盒子異常 ${JSON.stringify(state.menuRect)}`);
            const clipped = state.clippedBy.filter(item => !item.containsMenu);
            ensure(clipped.length === 0, '被祖先裁切：' + JSON.stringify(clipped));
            for (const key of ['exportJson', 'aiDiff', 'aiNotes']) {
                ensure(state[key].visible, `${key} 盒子為 0`);
                ensure(state[key].insideViewport, `${key} 超出視窗 ${JSON.stringify(state[key].rect)}`);
                ensure(state[key].hitSelf, `${key} 無法命中（elementFromPoint=${state[key].hitTag}）`);
            }
            await page.waitForTimeout(250);
            await shot(page, `menu-${width}`);
            return {
                viewport: state.viewport, menuRect: state.menuRect, toolsOverflow: state.toolsOverflow,
                clippedBy: state.clippedBy, hit: { exportJson: state.exportJson.hitTag, aiDiff: state.aiDiff.hitTag, aiNotes: state.aiNotes.hitTag }
            };
        });
        await step(`P1-${width}:click`, `${width}px：真實點擊選單項可開啟對話框`, async () => {
            if (!await page.locator('.reading-tools[open]').count()) await page.locator('.reading-tools > summary').click();
            await page.locator('#reading-export-json').click({ timeout: 5000 });
            await page.locator('.options-modal-overlay').waitFor({ timeout: 6000 });
            const title = await page.locator('.options-modal-overlay .modal-header h3').textContent();
            await page.waitForTimeout(450);
            await shot(page, `menu-dialog-${width}`);
            await page.locator('.options-modal-overlay #cancel-btn').click({ timeout: 5000 });
            await page.locator('.options-modal-overlay').waitFor({ state: 'detached', timeout: 5000 });
            const info = await activeInfo(page);
            ensure(!info.panelHidden, '取消後面板被關掉');
            return { dialogTitle: title.trim(), panelStillOpen: !info.panelHidden };
        });
        await step(`O4-${width}:escape`, `${width}px：開啟選單後 Escape 只收起選單、面板保留`, async () => {
            await page.locator('.reading-tools > summary').click();
            ensure(await page.locator('.reading-tools[open]').count() === 1, '選單未開啟');
            await page.keyboard.press('Escape');
            const open = await page.locator('.reading-tools[open]').count();
            const info = await activeInfo(page);
            ensure(open === 0, 'Escape 未收起選單');
            ensure(!info.panelHidden, 'Escape 把面板也關了');
            ensure(info.tag === 'SUMMARY', `焦點未回到 summary（${info.tag}）`);
            return { menuClosed: true, focus: info.tag, panelOpen: !info.panelHidden };
        });
        await step(`O4-${width}:outside`, `${width}px：點選單外地區收起選單、面板保留`, async () => {
            await page.locator('.reading-tools > summary').click();
            ensure(await page.locator('.reading-tools[open]').count() === 1, '選單未開啟');
            await page.locator('#reading-panel-title').click();
            const open = await page.locator('.reading-tools[open]').count();
            const info = await activeInfo(page);
            ensure(open === 0, '點外面未收起選單');
            ensure(!info.panelHidden, '點外面把面板關了');
            return { menuClosed: true, panelOpen: !info.panelHidden };
        });
        await step(`NET-${width}`, `${width}px：無任何外部（非 loopback）網路請求`, async () => {
            const remote = await externalHosts(fixture);
            ensure(remote.length === 0, '出現外部請求：' + JSON.stringify(remote.slice(0, 5)));
            return { externalHosts: remote.length };
        });
    }
}

// ── S2：P3 備份入口下載合法 JSON（含 Markdown 對照）──────────────
async function scenarioBackup(browser) {
    for (const width of [1440, 390, 320]) {
        const { page } = await openAt(browser, width);
        await step(`P3-${width}`, `${width}px：備份入口預勾完整 JSON 且下載合法 JSON`, async () => {
            await page.locator('.reading-tools > summary').click();
            await page.locator('#reading-export-json').click({ timeout: 6000 });
            await page.locator('.options-modal-overlay').waitFor({ timeout: 8000 });
            const dialog = await page.evaluate(() => {
                const overlay = document.querySelector('.options-modal-overlay');
                const checked = key => !!overlay.querySelector(`input[data-option-key="${key}"]`)?.checked;
                const button = overlay.querySelector('#confirm-btn');
                const box = button.getBoundingClientRect();
                const at = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
                return {
                    fullBackup: checked('fullBackup'), fullText: checked('fullText'), chat: checked('chat'),
                    description: overlay.querySelector('.om-desc')?.textContent || '',
                    title: overlay.querySelector('.modal-header h3')?.textContent || '',
                    confirmHit: !!at && (at === button || button.contains(at)),
                    confirmInsideViewport: box.top >= 0 && box.bottom <= innerHeight + 0.5 && box.left >= 0 && box.right <= innerWidth + 0.5,
                    zIndex: getComputedStyle(overlay).zIndex
                };
            });
            await page.waitForTimeout(450);
            await shot(page, `backup-dialog-${width}`);
            ensure(dialog.fullBackup === true, '完整 JSON 備份未預勾');
            ensure(dialog.fullText === false && dialog.chat === false, '全文／對話被預勾');
            ensure(dialog.confirmHit && dialog.confirmInsideViewport, '確認按鈕不可命中或超出視窗');
            const target = path.join(ASSETS, `backup-entry-${width}.json`);
            const file = await downloadOf(page, () => page.locator('.options-modal-overlay #confirm-btn').click(), target);
            const text = fs.readFileSync(file.file, 'utf8');
            let parsed = null;
            let parseError = '';
            try { parsed = JSON.parse(text); } catch (error) { parseError = String(error.message); }
            ensure(!parseError, `下載檔不是合法 JSON（${file.suggested}）：${parseError}`);
            ensure(/\.json$/i.test(file.suggested), `下載檔名不是 .json：${file.suggested}`);
            const keys = Object.keys(parsed || {});
            ensure(keys.length > 0, 'JSON 內容為空');
            return { dialog: { ...dialog, description: dialog.description.slice(0, 120) }, download: { name: file.suggested, bytes: file.bytes, topLevelKeys: keys.slice(0, 12) } };
        });
    }
    // 對照：一般匯出仍下載 Markdown，且備份選項不預勾
    const { page } = await openAt(browser, 1440);
    await step('P3-control-md', '「導出閱讀筆記」仍預設不勾完整備份並下載 Markdown', async () => {
        await page.locator('#reading-export-md').click();
        await page.locator('.options-modal-overlay').waitFor({ timeout: 8000 });
        const dialog = await page.evaluate(() => {
            const overlay = document.querySelector('.options-modal-overlay');
            const checked = key => !!overlay.querySelector(`input[data-option-key="${key}"]`)?.checked;
            return { fullBackup: checked('fullBackup'), fullText: checked('fullText'), description: overlay.querySelector('.om-desc')?.textContent || '' };
        });
        ensure(dialog.fullBackup === false, '一般匯出竟預勾完整備份');
        const target = path.join(ASSETS, 'export-notes-control.md');
        const file = await downloadOf(page, () => page.locator('.options-modal-overlay #confirm-btn').click(), target);
        const head = fs.readFileSync(file.file, 'utf8').slice(0, 160);
        ensure(/\.md$/i.test(file.suggested), `一般匯出不是 Markdown：${file.suggested}`);
        return { dialog, download: { name: file.suggested, bytes: file.bytes, head: head.replace(/\n/g, ' ⏎ ').slice(0, 120) } };
    });
}

// ── S3：P2 子對話框（全篇筆記／AI 範圍）在 320-1440 ────────────────
async function scenarioChildDialogs(browser) {
    for (const width of [320, 390, 834, 1024, 1440]) {
        const handle = await openAt(browser, width);
        const { page, fixture } = handle;
        const modalPanelExpected = width < 1200;
        await step(`P2-${width}:open`, `${width}px：全篇筆記對話框開啟且在面板之上（可命中）`, async () => {
            await page.locator('#reading-article-note').click({ timeout: 6000 });
            await page.locator('#app-modal:not(.hidden) #reading-article-note-input').waitFor({ timeout: 8000 });
            const state = await modalState(page);
            ensure(!state.hidden, '對話框未開啟');
            ensure(state.parentIsBody, `#app-modal 父節點不是 body（${state.parentId}）`);
            ensure(state.zIndex === '5000' && state.position === 'fixed', `模態定位異常 z=${state.zIndex} pos=${state.position}`);
            ensure(state.hits.every(hit => hit.insideModal), '對話框命中點不在模態內：' + JSON.stringify(state.hits));
            ensure(state.inputHit?.insideModal, '筆記輸入框不可命中：' + JSON.stringify(state.inputHit));
            ensure(!state.panelHidden, '開啟對話框時面板被關閉');
            await page.waitForTimeout(450);
            await shot(page, `note-dialog-${width}`);
            return { zIndex: state.zIndex, parent: state.parentId, contentRect: state.contentRect, hits: state.hits, inputHit: state.inputHit, panelZ: state.panelZ, modalPanelExpected };
        });
        await step(`P2-${width}:save`, `${width}px：全篇筆記可輸入並保存，面板保留`, async () => {
            const marker = `複驗筆記 ${new Date().toISOString()} @${width}`;
            await page.locator('#reading-article-note-input').fill(marker);
            await page.locator('#reading-article-note-save').click({ timeout: 6000 });
            await page.waitForFunction(() => document.getElementById('app-modal')?.classList.contains('hidden'), null, { timeout: 8000 });
            const info = await activeInfo(page);
            ensure(!info.panelHidden, '保存後面板被關掉');
            const stored = await page.evaluate(async id => {
                const rd = await import('/modules/reading-store.js');
                return rd.getArticleDocument(id, { withContent: true })?.content || '';
            }, fixture.noteId);
            ensure(stored === marker, `store 內容不符（len=${stored.length}）`);
            return { savedLength: stored.length, panelOpen: !info.panelHidden };
        });
        await step(`P2-${width}:escape`, `${width}px：對話框開啟時 Escape 只關對話框、面板保留並取回焦點`, async () => {
            await page.locator('#reading-article-note').click({ timeout: 6000 });
            await page.locator('#app-modal:not(.hidden) #reading-article-note-input').waitFor({ timeout: 8000 });
            await page.waitForTimeout(120);
            await page.keyboard.press('Escape');
            await page.waitForTimeout(250);
            const info = await activeInfo(page);
            ensure(info.modalHidden, 'Escape 未關閉對話框');
            ensure(!info.panelHidden, 'Escape 把面板一起關了');
            ensure(info.inPanel, `關閉後焦點不在面板內（${info.tag}${info.id ? '#' + info.id : ''}）`);
            ensure(info.id === 'reading-article-note', `關閉後焦點未回到開啟按鈕（${info.tag}${info.id ? '#' + info.id : ''}）`);
            const inertAfter = await page.evaluate(() => ({
                layoutInert: document.querySelector('.app-layout')?.inert === true,
                panelInert: document.getElementById('article-reading-panel')?.inert === true,
                modalInert: document.getElementById('app-modal')?.inert === true
            }));
            if (width < 1200) {
                ensure(inertAfter.layoutInert, '關閉對話框後背景未保持 inert');
                ensure(!inertAfter.panelInert && !inertAfter.modalInert, '面板或模態被錯誤 inert');
            }
            await shot(page, `note-escape-${width}`);
            return { modalClosed: true, panelOpen: true, focus: { tag: info.tag, id: info.id, inPanel: info.inPanel }, inertAfter };
        });
        await step(`P2-${width}:tab`, `${width}px：對話框開啟時 Tab 不跑到背景`, async () => {
            await page.locator('#reading-article-note').click({ timeout: 6000 });
            await page.locator('#app-modal:not(.hidden) #reading-article-note-input').waitFor({ timeout: 8000 });
            await page.waitForTimeout(150);
            const inert = await page.evaluate(() => Array.from(document.body.children)
                .filter(el => el.inert).map(el => el.id || (typeof el.className === 'string' ? el.className : el.tagName)));
            if (width < 1200) ensure(inert.includes('app-layout'), '背景 .app-layout 未設 inert：' + JSON.stringify(inert));
            else ensure(inert.length === 0, `非模態面板（1440）不應設 inert：${JSON.stringify(inert)}`);
            const stray = [];
            for (let i = 0; i < 20; i += 1) {
                await page.keyboard.press('Tab');
                const info = await activeInfo(page);
                if (!info.inModal) stray.push({ i, tag: info.tag, id: info.id, cls: info.cls });
            }
            ensure(stray.length === 0, 'Tab 跑出模態：' + JSON.stringify(stray.slice(0, 4)));
            await page.keyboard.press('Escape');
            await page.waitForTimeout(200);
            return { inertChildren: inert, tabStops: 20, stray: 0 };
        });
        await step(`P2-${width}:panel-tab`, `${width}px：面板內 Tab 不會落到背景控件`, async () => {
            const info0 = await activeInfo(page);
            ensure(!info0.panelHidden, '面板不在開啟狀態');
            const controls = new Set(['BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'A']);
            const background = [];
            const away = [];
            for (let i = 0; i < 30; i += 1) {
                await page.keyboard.press('Tab');
                const info = await activeInfo(page);
                if (info.inPanel || info.inModal || info.inOverlay) continue;
                away.push({ i, tag: info.tag, id: info.id, cls: info.cls });
                if (controls.has(info.tag)) background.push({ i, tag: info.tag, id: info.id, cls: info.cls });
            }
            const modalMode = await page.evaluate(() => document.body.classList.contains('reading-panel-modal'));
            ensure(modalMode === modalPanelExpected, `模態判定不符（期望 ${modalPanelExpected}，實得 ${modalMode}）`);
            if (modalPanelExpected) ensure(background.length === 0, 'Tab 落到背景控件：' + JSON.stringify(background.slice(0, 4)));
            return { tabStops: 30, backgroundControls: background, awayFromPanel: away.slice(0, 4), modalMode };
        });
        await step(`NEW-tabtrap-${width}`, `${width}px：Tab 陷阱完整環繞（焦點不離開面板）`, async () => {
            const modalMode = await page.evaluate(() => document.body.classList.contains('reading-panel-modal'));
            if (!modalMode) return { skipped: '1440 為非模態面板，不套用焦點陷阱' };
            await page.evaluate(() => document.querySelector('.reading-tools > summary').focus());
            const seq = [];
            for (let i = 0; i < 4; i += 1) {
                await page.keyboard.press('Tab');
                const info = await activeInfo(page);
                seq.push({ i, tag: info.tag, id: info.id, cls: info.cls, inPanel: info.inPanel });
            }
            ensure(seq.every(entry => entry.inPanel), '焦點離開面板：' + JSON.stringify(seq));
            return seq;
        }, { optional: true });
        await step(`P2-${width}:ai-scope`, `${width}px：「更多 → 分析本文難點」範圍對話框可操作`, async () => {
            await page.locator('.reading-tools > summary').click();
            await page.locator('#reading-ai-difficulties').click({ timeout: 6000 });
            await page.locator('#app-modal:not(.hidden) #reading-ai-run').waitFor({ timeout: 8000 });
            await page.waitForTimeout(400);
            const state = await page.evaluate(() => {
                const modal = document.getElementById('app-modal');
                const items = modal.querySelectorAll('.reading-ai-item').length;
                const docs = modal.querySelectorAll('.reading-ai-doc').length;
                const content = modal.querySelector('.modal-content').getBoundingClientRect();
                const runBox = modal.querySelector('#reading-ai-run').getBoundingClientRect();
                const runAt = document.elementFromPoint(runBox.left + runBox.width / 2, runBox.top + runBox.height / 2);
                const box = modal.querySelector('#reading-ai-cancel').getBoundingClientRect();
                const at = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
                const row = modal.querySelector('.reading-ai-item');
                const rowBox = row.getBoundingClientRect();
                const rowHit = document.elementFromPoint(rowBox.left + rowBox.width / 2, rowBox.top + rowBox.height / 2);
                return {
                    items, docs,
                    contentInViewport: content.top >= -1 && content.left >= -1 && content.bottom <= innerHeight + 1 && content.right <= innerWidth + 1,
                    contentRect: { x: Math.round(content.x), y: Math.round(content.y), w: Math.round(content.width), h: Math.round(content.height) },
                    runHit: !!runAt && modal.contains(runAt),
                    cancelHit: !!at && (at === modal.querySelector('#reading-ai-cancel') || modal.contains(at)),
                    rowHitInsideModal: !!rowHit && modal.contains(rowHit),
                    title: modal.querySelector('.modal-header h3')?.textContent?.trim(),
                    toolsOpen: document.querySelector('.reading-tools')?.open
                };
            });
            ensure(state.items === 11 && state.docs === 1, `範圍清單數量不符 items=${state.items} docs=${state.docs}`);
            ensure(state.runHit, '「生成」按鈕不可命中');
            ensure(state.contentInViewport, '對話框超出視窗：' + JSON.stringify(state.contentRect));
            ensure(state.cancelHit, '取消按鈕不可命中');
            ensure(state.rowHitInsideModal, '記錄核取列不可命中');
            ensure(state.toolsOpen === false, '開啟對話框後選單未收起');
            await shot(page, `ai-scope-${width}`);
            await page.keyboard.press('Escape');
            await page.waitForTimeout(250);
            const info = await activeInfo(page);
            ensure(info.modalHidden, 'AI 範圍對話框 Escape 未關閉');
            ensure(!info.panelHidden, 'Escape 把面板一起關了');
            const remote = await externalHosts(handle);
            ensure(remote.length === 0, '出現外部請求：' + JSON.stringify(remote.slice(0, 5)));
            return { ...state, escapeClosedOnlyDialog: true, focusBackInPanel: info.inPanel };
        });
        await step(`P2-${width}:panel-escape`, `${width}px：對話框關閉後 Escape 可關面板`, async () => {
            await page.keyboard.press('Escape');
            await page.waitForTimeout(250);
            const info = await activeInfo(page);
            ensure(info.panelHidden, '面板未關閉');
            const released = await page.evaluate(() => document.querySelector('.app-layout')?.inert === false);
            ensure(released, '面板關閉後背景未解除 inert');
            return { panelClosed: true, inertReleased: released };
        });
    }
}

// ── S4：O1 保存失敗→重試 狀態與焦點 ─────────────────────────────
const DRAFT_STRINGS = {
    'zh-CN': { saving: '保存中…', failed: '保存失败，请重试', saved: '已保存', retry: '重试' },
    'zh-HK': { saving: '儲存中…', failed: '儲存失敗，請重試', saved: '已儲存', retry: '重試' }
};
async function prepareFailure(page, itemId, text, strings) {
    const expanded = await page.locator(`[data-item-id="${itemId}"] [data-action="expand"]`).getAttribute('aria-expanded');
    if (expanded !== 'true') await page.locator(`[data-item-id="${itemId}"] [data-action="expand"]`).click();
    await page.locator(`[data-item-id="${itemId}"] textarea.reading-note`).waitFor({ timeout: 8000 });
    await page.evaluate(async () => {
        const actions = await import('/modules/reading-actions.js');
        actions.__setNoteSaveInterceptorForTests(() => ({ ok: false, error: 'injected_save_failure' }));
    });
    await page.locator(`[data-item-id="${itemId}"] textarea.reading-note`).fill(text);
    await page.waitForFunction(([id, failed]) => document.querySelector(`[data-note-status="${id}"]`)?.textContent?.includes(failed), [itemId, strings.failed], { timeout: 10000 });
    await page.evaluate(async () => {
        const actions = await import('/modules/reading-actions.js');
        actions.__setNoteSaveInterceptorForTests(null);
    });
}
async function noteStatus(page, itemId) {
    return page.evaluate(id => {
        const a = document.activeElement;
        return {
            status: document.querySelector(`[data-note-status="${id}"]`)?.textContent?.trim() || '',
            hasRetry: !!document.querySelector(`[data-note-status="${id}"] [data-note-retry]`),
            focusTag: a?.tagName || null,
            focusIsNote: document.activeElement === document.querySelector(`[data-note-id="${id}"]`),
            focusInPanel: !!a?.closest?.('#article-reading-panel')
        };
    }, itemId);
}
async function scenarioDraftRetry(browser, { locale = 'zh-CN', width = 1440 } = {}) {
    const strings = DRAFT_STRINGS[locale];
    const tag = locale === 'zh-HK' ? 'zhHK' : locale;
    // 真實滑鼠點擊重試
    {
        const { page, fixture } = await openAt(browser, width, { locale });
        const itemId = fixture.ids[3];
        const text = `${locale} mouse 重試 ${Date.now()}`;
        await step(`O1-${locale}`, `${width}px/${locale}：保存失敗顯示錯誤→重試成功，狀態不再停在「${strings.saving}」`, async () => {
            await prepareFailure(page, itemId, text, strings);
            const before = await noteStatus(page, itemId);
            ensure(before.hasRetry, '失敗時沒有重試按鈕');
            await shot(page, `draft-retry-failed-${tag}-${width}`);
            await page.locator(`[data-note-status="${itemId}"] [data-note-retry]`).click();
            await page.waitForTimeout(900);
            const after = await noteStatus(page, itemId);
            const stored = await page.evaluate(async id => (await import('/modules/reading-store.js')).getLearningItem(id)?.note || '', itemId);
            await shot(page, `draft-retry-saved-${tag}-${width}`);
            ensure(stored === text, 'store 未寫入重試內容');
            ensure(after.status === strings.saved, `重試後狀態停留在「${after.status}」（期望「${strings.saved}」）`);
            ensure(!after.hasRetry, '成功後仍顯示重試按鈕');
            return { failedStatus: before.status, afterStatus: after.status, storedOk: true, focusAfterMouseClick: after.focusTag };
        });
        await step(`O1-${locale}:focus-after-mouse`, `${width}px/${locale}：滑鼠點重試後焦點位置（觀察項）`, async () => {
            const text2 = `${locale} mouse 重試 2 ${Date.now()}`;
            await prepareFailure(page, itemId, text2, strings);
            await page.locator(`[data-note-status="${itemId}"] [data-note-retry]`).click();
            await page.waitForTimeout(900);
            const after = await noteStatus(page, itemId);
            ensure(after.status === strings.saved, `狀態 ${after.status}`);
            ensure(after.focusIsNote, `焦點不在 textarea（${after.focusTag}）；blur 自動保存已重繪卡片，重試按鈕在 click 前被替換`);
            return after;
        }, { optional: true });
    }
    // 鍵盤／程式觸發（節點未被重繪前先執行 handler）
    {
        const { page, fixture } = await openAt(browser, width, { locale });
        const itemId = fixture.ids[0];
        const text = `${locale} 鍵盤重試 ${Date.now()}`;
        await step(`O1-${locale}:keyboard`, `${width}px/${locale}：不觸發 blur 重繪時，重試成功且焦點回到 textarea`, async () => {
            await prepareFailure(page, itemId, text, strings);
            await page.evaluate(id => document.querySelector(`[data-note-status="${id}"] [data-note-retry]`).click(), itemId);
            await page.waitForTimeout(900);
            const after = await noteStatus(page, itemId);
            const stored = await page.evaluate(async id => (await import('/modules/reading-store.js')).getLearningItem(id)?.note || '', itemId);
            ensure(stored === text, 'store 未寫入');
            ensure(after.status === strings.saved, `狀態 ${after.status}`);
            ensure(after.focusIsNote, `焦點不在 textarea（${after.focusTag}）`);
            return after;
        });
    }
}

// ── S5：O2「最近查閱」排序 ──────────────────────────────────────
async function scenarioSortViewed(browser) {
    const { page } = await openAt(browser, 1440);
    await step('O2', '「最近查閱」把未查閱文件排在最後，且順序依 lastViewedAt 遞減', async () => {
        await page.selectOption('#reading-sort', 'viewed');
        await page.waitForTimeout(300);
        const order = await page.evaluate(async () => {
            const rd = await import('/modules/reading-store.js');
            return [...document.querySelectorAll('#reading-panel-list > article')].map(el => {
                const type = el.classList.contains('reading-doc') ? 'document' : 'item';
                const id = el.dataset.docId || el.dataset.itemId;
                const entity = type === 'document' ? rd.getArticleDocument(id, { withContent: false }) : rd.getLearningItem(id);
                return { type, id, lastViewedAt: entity?.lastViewedAt || '', updatedAt: entity?.updatedAt || '' };
            });
        });
        const itemPositions = order.map((entry, index) => ({ ...entry, index })).filter(entry => entry.type === 'item');
        const docPositions = order.map((entry, index) => ({ ...entry, index })).filter(entry => entry.type === 'document');
        ensure(order.length === 13, `筆數不對 ${order.length}`);
        ensure(itemPositions.length === 11 && docPositions.length === 2, 'items/docs 數量不符');
        ensure(Math.max(...itemPositions.map(e => e.index)) < Math.min(...docPositions.map(e => e.index)), '文件沒有全部排在最後：' + JSON.stringify(order.map(e => e.type)));
        ensure(docPositions.every(entry => !entry.lastViewedAt), '文件意外帶有 lastViewedAt，測不出回歸');
        const times = itemPositions.map(entry => entry.lastViewedAt);
        ensure(times.every((time, index) => index === 0 || times[index - 1] >= time), '詞句未依 lastViewedAt 遞減');
        await shot(page, 'sort-viewed-1440');
        return { firstFive: order.slice(0, 5), lastTwo: order.slice(-2), itemRange: itemPositions.map(e => e.index), docIndexes: docPositions.map(e => e.index) };
    });
}

// ── S6：O3 讀取失敗時篩選計數 ──────────────────────────────────
async function scenarioLoadError(browser) {
    const { page } = await openAt(browser, 1440);
    await step('O3:error', '讀取失敗時篩選徽章顯示「—」而非 0', async () => {
        await page.evaluate(() => {
            const original = IDBIndex.prototype.getAll;
            window.__idbGetAllRestore = () => { IDBIndex.prototype.getAll = original; };
            IDBIndex.prototype.getAll = function patched(...args) {
                if (this && this.name === 'scope_article') throw new Error('injected_idb_read_failure');
                return original.apply(this, args);
            };
        });
        await page.evaluate(async () => {
            const rd = await import('/modules/reading-store.js');
            await rd.reloadReadingScope();
        });
        await page.locator('#reading-load-retry').waitFor({ timeout: 10000 });
        const state = await page.evaluate(() => ({
            counts: [...document.querySelectorAll('[data-filter] .reading-filter-count')].map(el => el.textContent.trim()),
            filters: [...document.querySelectorAll('[data-filter]')].map(el => el.dataset.filter),
            results: document.querySelector('#reading-results')?.textContent?.trim() || '',
            subtitle: document.querySelector('#reading-panel-sub')?.textContent?.trim() || '',
            errorText: document.querySelector('#reading-panel-list .reading-empty')?.textContent?.trim() || '',
            titleBadge: document.querySelector('#article-reading-records-btn .reading-count, #article-reading-records-btn')?.textContent?.trim() || ''
        }));
        ensure(state.errorText.includes('未能读取本机学习记录'), '沒有顯示讀取失敗文案：' + state.errorText.slice(0, 60));
        ensure(state.counts.every(count => count === '—'), '失敗時篩選計數不是「—」：' + JSON.stringify(state.counts));
        await shot(page, 'load-error-1440');
        return state;
    });
    await step('O3:retry', '解除注入後「重試」可恢復計數與清單', async () => {
        await page.evaluate(() => window.__idbGetAllRestore?.());
        await page.locator('#reading-load-retry').click();
        await page.waitForFunction(() => document.querySelectorAll('#reading-panel-list > article').length === 13, null, { timeout: 10000 });
        const state = await page.evaluate(() => ({
            counts: [...document.querySelectorAll('[data-filter] .reading-filter-count')].map(el => el.textContent.trim()),
            cards: document.querySelectorAll('#reading-panel-list > article').length
        }));
        ensure(state.cards === 13, `重試後卡片數 ${state.cards}`);
        ensure(state.counts.every(count => /^\d+$/.test(count)), '重試後計數未恢復：' + JSON.stringify(state.counts));
        await shot(page, 'load-retry-1440');
        return state;
    });
}

// ── S7：Tab 陷阱細節 + 啟動模態回歸 ──────────────────────────
async function scenarioTabTrap(browser) {
    for (const width of [390, 1024]) {
        const { page } = await openAt(browser, width);
        await step(`NEW-tabtrap-${width}`, `${width}px：「更多」收起時，從最後一項 Tab 與從第一項 Shift+Tab 的行為`, async () => {
            const targets = await page.evaluate(() => {
                const panel = document.getElementById('article-reading-panel');
                const list = [...panel.querySelectorAll('button, input, textarea, select, summary, a[href]')]
                    .filter(el => !el.disabled && el.getClientRects().length);
                const describe = el => el?.id || (typeof el?.className === 'string' ? el.className : el?.tagName) || '';
                return {
                    count: list.length,
                    last: describe(list.at(-1)),
                    lastInsideClosedMenu: !!list.at(-1)?.closest?.('.reading-tools-menu'),
                    summaryRects: document.querySelector('.reading-tools > summary')?.getClientRects().length,
                    menuButtonsRects: [...document.querySelectorAll('.reading-tools-menu .btn')].map(el => el.getClientRects().length),
                    menuButtonsVisibility: [...document.querySelectorAll('.reading-tools-menu .btn')].map(el => ({
                        id: el.id,
                        checkVisibility: typeof el.checkVisibility === 'function' ? el.checkVisibility({ checkVisibilityCSS: true, contentVisibilityAuto: true }) : null,
                        offsetParent: !!el.offsetParent,
                        visibility: getComputedStyle(el).visibility
                    })),
                    menuOpen: document.querySelector('.reading-tools').open
                };
            });
            await page.evaluate(() => document.querySelector('.reading-tools > summary').focus());
            await page.keyboard.press('Tab');
            const afterTab = await page.evaluate(() => ({ tag: document.activeElement?.tagName, id: document.activeElement?.id, inPanel: !!document.activeElement?.closest?.('#article-reading-panel') }));
            await page.keyboard.press('Tab');
            const afterTab2 = await page.evaluate(() => ({ tag: document.activeElement?.tagName, id: document.activeElement?.id, cls: typeof document.activeElement?.className === 'string' ? document.activeElement.className : '', inPanel: !!document.activeElement?.closest?.('#article-reading-panel') }));
            await page.evaluate(() => document.querySelector('.reading-panel-close').focus());
            await page.keyboard.press('Shift+Tab');
            const afterShift = await page.evaluate(() => ({ tag: document.activeElement?.tagName, id: document.activeElement?.id, cls: typeof document.activeElement?.className === 'string' ? document.activeElement.className : '', inPanel: !!document.activeElement?.closest?.('#article-reading-panel') }));
            await page.evaluate(() => { document.querySelector('.reading-tools').open = true; document.querySelector('#reading-ai-notes').focus(); });
            await page.keyboard.press('Tab');
            const afterOpenMenu = await page.evaluate(() => ({ id: document.activeElement?.id, cls: typeof document.activeElement?.className === 'string' ? document.activeElement.className : '', inPanel: !!document.activeElement?.closest?.('#article-reading-panel') }));
            await page.evaluate(() => { document.querySelector('.reading-tools').open = false; });
            return { targets, afterTab, afterTab2, afterShift, afterOpenMenu };
        }, { optional: true });
    }
}

async function scenarioGlobalModalMount(browser) {
    const { page } = await openAt(browser, 1440);
    await step('REG-appmodal-mount', '#app-modal 為 body 直屬子節點，關閉後清空內容並歸還焦點', async () => {
        const mount = await page.evaluate(() => {
            const modal = document.getElementById('app-modal');
            const library = document.getElementById('article-library-modal');
            return {
                appModalParent: modal.parentElement?.tagName,
                appModalInLayout: !!modal.closest('.app-layout'),
                libraryInLayout: !!library?.closest('.app-layout'),
                layoutZ: getComputedStyle(document.querySelector('.app-layout')).zIndex
            };
        });
        ensure(mount.appModalParent === 'BODY' && !mount.appModalInLayout, 'app-modal 未脫離 .app-layout');
        await page.locator('#reading-article-note').click();
        await page.locator('#app-modal:not(.hidden) #reading-article-note-input').waitFor({ timeout: 8000 });
        await page.locator('#app-modal .modal-close-btn').click();
        await page.waitForTimeout(250);
        const after = await page.evaluate(() => ({
            hidden: document.getElementById('app-modal').classList.contains('hidden'),
            bodyLen: document.getElementById('modal-body')?.innerHTML.length,
            active: document.activeElement?.id || document.activeElement?.tagName,
            panelOpen: !document.getElementById('article-reading-panel').classList.contains('hidden')
        }));
        ensure(after.hidden && after.bodyLen === 0, '關閉後模態未清理');
        ensure(after.active === 'reading-article-note', `關閉後焦點未回到入口（${after.active}）`);
        ensure(after.panelOpen, '關閉模態後面板被關閉');
        return { ...mount, after };
    });
}

// ── S8：locale 文案（zh-HK）────────────────────────────────────
async function scenarioLocaleHK(browser) {
    const { page } = await openAt(browser, 390, { locale: 'zh-HK' });
    await step('LOCALE-hk:labels', 'zh-HK：面板／篩選／排序／更多選單文案為香港繁體', async () => {
        const labels = await page.evaluate(() => ({
            title: document.querySelector('#reading-panel-title')?.textContent?.trim(),
            filters: [...document.querySelectorAll('[data-filter]')].map(el => el.textContent.replace(/\s*\d+$/, '').trim()),
            sort: [...document.querySelectorAll('#reading-sort option')].map(el => el.textContent.trim()),
            savedOnly: document.querySelector('.reading-saved-filter')?.textContent?.replace(/\s+/g, ' ').trim(),
            noteBtn: document.querySelector('#reading-article-note')?.textContent?.trim(),
            exportBtn: document.querySelector('#reading-export-md')?.textContent?.trim(),
            more: document.querySelector('.reading-tools > summary')?.textContent?.trim(),
            menu: [...document.querySelectorAll('.reading-tools-menu .btn')].map(el => el.textContent.trim())
        }));
        ensure(labels.title === '本文學習記錄', `標題 ${labels.title}`);
        ensure(labels.noteBtn === '全篇筆記', `全篇筆記按鈕 ${labels.noteBtn}`);
        ensure(labels.menu[0] === '備份目前帳戶（JSON）' && labels.menu[1] === '分析本文難點' && labels.menu[2] === '整理閱讀筆記', '選單文案不符：' + JSON.stringify(labels.menu));
        ensure(!labels.filters.some(text => text.includes('词')), '出現簡體殘留：' + JSON.stringify(labels.filters));
        await page.locator('.reading-tools > summary').click();
        await shot(page, 'zh-HK-menu-390');
        await page.keyboard.press('Escape');
        return { noteBtn: labels.noteBtn, more: labels.more, menu: labels.menu };
    });
    await step('LOCALE-hk:dialog', 'zh-HK：匯出範圍與全篇筆記對話框文案及 Escape 行為', async () => {
        await page.locator('.reading-tools > summary').click();
        await page.locator('#reading-export-json').click();
        await page.locator('.options-modal-overlay').waitFor({ timeout: 8000 });
        const exportDialog = await page.evaluate(() => {
            const overlay = document.querySelector('.options-modal-overlay');
            return {
                title: overlay.querySelector('.modal-header h3')?.textContent?.trim(),
                options: [...overlay.querySelectorAll('.option-item')].map(el => el.textContent.replace(/\s+/g, ' ').trim()),
                fullBackup: !!overlay.querySelector('input[data-option-key="fullBackup"]')?.checked
            };
        });
        ensure(exportDialog.title === '匯出範圍', `匯出標題 ${exportDialog.title}`);
        ensure(exportDialog.fullBackup === true, 'zh-HK 備份入口未預勾');
        await shot(page, 'zh-HK-export-dialog-390');
        await page.locator('.options-modal-overlay #cancel-btn').click();
        await page.locator('.options-modal-overlay').waitFor({ state: 'detached', timeout: 5000 });
        await page.locator('#reading-article-note').click();
        await page.locator('#app-modal:not(.hidden) #reading-article-note-input').waitFor({ timeout: 8000 });
        const noteTitle = await page.locator('#app-modal #modal-title').textContent();
        await shot(page, 'zh-HK-note-dialog-390');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(250);
        const info = await activeInfo(page);
        ensure(noteTitle.trim() === '全篇閱讀筆記', `全篇筆記標題 ${noteTitle}`);
        ensure(info.modalHidden && !info.panelHidden, 'Escape 行為不符（modal/panel）');
        return { exportTitle: exportDialog.title, noteTitle: noteTitle.trim(), escapeClosedDialogOnly: true };
    });
}

// ── S9：刪除確認／撤銷抽樣回歸（390）──────────────────────────
async function scenarioDeleteUndo(browser) {
    const { page, fixture } = await openAt(browser, 390);
    await step('REG-delete', '390px：刪除確認與面板內撤銷仍正常', async () => {
        const itemId = fixture.ids[5];
        await page.locator(`[data-item-id="${itemId}"] [data-action="expand"]`).click();
        await page.locator(`[data-item-id="${itemId}"] [data-action="delete"]`).click();
        await page.locator('.options-modal-overlay').waitFor({ timeout: 8000 });
        const confirmTitle = await page.locator('.options-modal-overlay .modal-header h3').textContent();
        await shot(page, 'delete-confirm-390');
        await page.locator('.options-modal-overlay #confirm-btn').click();
        await page.locator('#reading-undo-delete').waitFor({ timeout: 8000 });
        const afterDelete = await page.evaluate(() => ({
            cards: document.querySelectorAll('#reading-panel-list > article').length,
            undoFocus: document.activeElement?.id || document.activeElement?.tagName
        }));
        await page.locator('#reading-undo-delete').click();
        await page.waitForFunction(() => document.querySelectorAll('#reading-panel-list > article').length === 13, null, { timeout: 8000 });
        const afterUndo = await page.evaluate(() => ({
            cards: document.querySelectorAll('#reading-panel-list > article').length,
            undoHidden: document.querySelector('#reading-undo')?.classList.contains('hidden')
        }));
        ensure(afterDelete.cards === 12, `刪除後卡片 ${afterDelete.cards}`);
        ensure(afterUndo.cards === 13 && afterUndo.undoHidden, '撤銷未復原');
        return { confirmTitle: confirmTitle.trim(), afterDelete, afterUndo };
    });
}

async function main() {
    const browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const startedAt = new Date().toISOString();
    try {
        await scenarioMenu(browser);
        await scenarioBackup(browser);
        await scenarioChildDialogs(browser);
        await scenarioDraftRetry(browser, { locale: 'zh-CN', width: 1440 });
        await scenarioDraftRetry(browser, { locale: 'zh-HK', width: 390 });
        await scenarioSortViewed(browser);
        await scenarioLoadError(browser);
        await scenarioTabTrap(browser);
        await scenarioGlobalModalMount(browser);
        await scenarioLocaleHK(browser);
        await scenarioDeleteUndo(browser);
    } catch (error) {
        record({ id: 'fatal', name: '腳本中斷', status: 'fail', detail: String(error && error.stack || error) });
    } finally {
        await browser.close();
    }
    const pageErrors = fixtures.map(fixture => ({ label: fixture.label, errors: fixture.errors }));
    const summary = {
        startedAt,
        finishedAt: new Date().toISOString(),
        total: checks.length,
        pass: checks.filter(c => c.status === 'pass').length,
        fail: checks.filter(c => c.status === 'fail').length,
        warn: checks.filter(c => c.status === 'warn').length,
        pageErrors
    };
    if (ASSETS) {
        fs.writeFileSync(path.join(ASSETS, 'recheck2-observations.json'), JSON.stringify({ summary, checks }, null, 2));
    }
    console.log('\n== summary ==');
    console.log(JSON.stringify(summary, null, 2));
    const errorsTotal = pageErrors.reduce((sum, entry) => sum + entry.errors.length, 0);
    console.log(`pageerror 總數：${errorsTotal}`);
    process.exitCode = checks.some(c => c.status === 'fail') ? 1 : 0;
}

main();
